'use strict';
const C = require('./google-destination-contract');
const A = require('./google-action-management-contract');
const D = require('./google-data-manager-contract');
const { fail } = require('./errors');

function createGoogleDestinations({ store, actionManagement, now = Date.now }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS google_destination_authorizations (
    id TEXT PRIMARY KEY, plan_id TEXT NOT NULL UNIQUE, principal TEXT NOT NULL, tenant TEXT NOT NULL,
    connection TEXT NOT NULL, asset TEXT NOT NULL, scope_digest TEXT NOT NULL, input_json TEXT NOT NULL,
    destinations_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','revoked')),
    created_at INTEGER NOT NULL, revoked_at INTEGER);
    CREATE TABLE IF NOT EXISTS google_destination_targets (
    authorization_id TEXT NOT NULL REFERENCES google_destination_authorizations(id), principal TEXT NOT NULL,
    tenant TEXT NOT NULL, connection TEXT NOT NULL, asset TEXT NOT NULL, action_id TEXT NOT NULL,
    event_name TEXT NOT NULL, event_source TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('active','revoked')),
    PRIMARY KEY(authorization_id,event_name,event_source));
    CREATE UNIQUE INDEX IF NOT EXISTS google_destination_active_target
    ON google_destination_targets(principal,tenant,connection,asset,action_id,event_name,event_source) WHERE state='active';`);
  const original = (request, principal, binding, input) => {
    const applied = actionManagement.appliedPlan({ ...request, payload: { planId: input.planId } }, principal, binding);
    C.resource(binding, request.assetRef, input.targets);
    const destinations = input.targets.map(target => {
      const change = applied.plan.changes.find(row => row.event === target.event);
      const result = applied.results.find(row => row.event === target.event);
      const actionId = change?.change === 'unchanged' ? change.actionId : result?.actionId;
      if (!change || !/^[1-9][0-9]{0,19}$/.test(actionId || '')) fail('scope_denied');
      return { event: target.event, conversionActionId: actionId, sources: [...target.sources] };
    });
    if (new Set(destinations.map(row => row.conversionActionId)).size !== destinations.length) fail('scope_denied');
    return { destinations, scope: C.scopeDigest(binding, request.assetRef, input.targets, principal, applied.row.scope_digest) };
  };
  const load = (request, principal, binding, id = request.payload.authorizationId) => {
    const row = store.db.prepare('SELECT * FROM google_destination_authorizations WHERE id=? AND principal=? AND tenant=? AND connection=? AND asset=?')
      .get(id, principal.id, request.tenantRef, request.connectionRef, request.assetRef);
    if (!row) fail('scope_denied');
    const checked = original(request, principal, binding, JSON.parse(row.input_json));
    if (row.scope_digest !== checked.scope || A.hash(JSON.parse(row.destinations_json)) !== A.hash(checked.destinations)) fail('scope_denied');
    return row;
  };
  const dto = row => ({ authorizationId: row.id, planId: row.plan_id, state: row.state,
    destinations: JSON.parse(row.destinations_json) });
  // A caller that persisted its original decision can withdraw it before an
  // in-flight authorize has committed. This tombstone never grants a target.
  function revocation(request, principal, binding) {
    const existing = store.db.prepare('SELECT id FROM google_destination_authorizations WHERE id=?').get(request.payload.authorizationId);
    if (existing) {
      const row = load(request, principal, binding);
      if (request.payload.input && A.hash(request.payload.input) !== A.hash(JSON.parse(row.input_json))) fail('idempotency_conflict');
      return { row, exists: true };
    }
    const input = request.payload.input;
    if (!input) fail('scope_denied');
    const checked = original(request, principal, binding, input);
    if (store.db.prepare('SELECT 1 FROM google_destination_authorizations WHERE plan_id=?').get(input.planId)) fail('idempotency_conflict');
    return { exists: false, row: { id: request.payload.authorizationId, plan_id: input.planId, state: 'revoked',
      scope_digest: checked.scope, input_json: JSON.stringify(input), destinations_json: JSON.stringify(checked.destinations) } };
  }
  function authorize(request, principal, binding) {
    const checked = original(request, principal, binding, request.payload);
    const existing = store.db.prepare('SELECT id,state FROM google_destination_authorizations WHERE plan_id=?').get(request.payload.planId);
    if (existing) {
      if (existing.id !== request.requestId || existing.state !== 'active') fail('idempotency_conflict');
      load(request, principal, binding, existing.id);
    }
    for (const target of checked.destinations) for (const source of target.sources) {
      const fixed = binding.googleDataManager.destinations.some(row => row.assetRef === request.assetRef
        && row.conversionActionId === target.conversionActionId && row.events.includes(target.event) && row.sources.includes(source));
      const held = store.db.prepare("SELECT authorization_id FROM google_destination_targets WHERE principal=? AND tenant=? AND connection=? AND asset=? AND action_id=? AND event_name=? AND event_source=? AND state='active'")
        .get(principal.id, request.tenantRef, request.connectionRef, request.assetRef, target.conversionActionId, target.event, source);
      if (fixed || held && held.authorization_id !== request.requestId) fail('idempotency_conflict');
    }
    return checked;
  }
  const operations = Object.fromEntries(Object.entries(C.OPERATIONS).map(([family, operation]) => [operation, {
    provider: A.PROVIDER, requiredScopes: A.SCOPES, effect: family === 'status' ? 'read' : 'write',
    persistResult: family !== 'status', validate: payload => C.validate(operation, payload),
    authorize({ request, principal, binding }) {
      if (family === 'authorize') authorize(request, principal, binding);
      else if (family === 'revoke') revocation(request, principal, binding);
      else load(request, principal, binding);
    },
    async execute(context) {
      context.assertActive();
      const principal = context.policy.principals.find(row => row.id === context.principalId);
      const request = { payload: context.payload, requestId: context.requestId, assetRef: context.assetRef,
        tenantRef: context.tenantRef, connectionRef: context.binding.connectionRef };
      if (family === 'authorize') {
        const checked = authorize(request, principal, context.binding);
        return { authorizationId: request.requestId, planId: request.payload.planId, state: 'active', destinations: checked.destinations };
      }
      const result = dto(family === 'revoke' ? revocation(request, principal, context.binding).row : load(request, principal, context.binding));
      return family === 'revoke' ? { ...result, state: 'revoked' } : result;
    },
    project: value => structuredClone(value),
    commit({ request, principal, policy, result }) {
      const binding = policy.connections.find(row => row.connectionRef === request.connectionRef);
      if (family === 'authorize') {
        const checked = authorize(request, principal, binding);
        if (A.hash(result.data.destinations) !== A.hash(checked.destinations)) fail('scope_denied');
        store.db.prepare("INSERT INTO google_destination_authorizations VALUES (?,?,?,?,?,?,?,?,?,'active',?,NULL)")
          .run(request.requestId, request.payload.planId, principal.id, request.tenantRef, request.connectionRef, request.assetRef,
            checked.scope, JSON.stringify(request.payload), JSON.stringify(checked.destinations), now());
        for (const target of checked.destinations) for (const source of target.sources) {
          store.db.prepare("INSERT INTO google_destination_targets VALUES (?,?,?,?,?,?,?,?,'active')")
            .run(request.requestId, principal.id, request.tenantRef, request.connectionRef, request.assetRef, target.conversionActionId, target.event, source);
        }
      } else {
        const { row, exists } = family === 'revoke' ? revocation(request, principal, binding) : { row: load(request, principal, binding) };
        if (family === 'revoke') {
          if (!exists) store.db.prepare("INSERT INTO google_destination_authorizations VALUES (?,?,?,?,?,?,?,?,?,'revoked',?,?)")
            .run(row.id, row.plan_id, principal.id, request.tenantRef, request.connectionRef, request.assetRef,
              row.scope_digest, row.input_json, row.destinations_json, now(), now());
          store.db.prepare("UPDATE google_destination_authorizations SET state='revoked',revoked_at=COALESCE(revoked_at,?) WHERE id=?").run(now(), row.id);
          store.db.prepare("UPDATE google_destination_targets SET state='revoked' WHERE authorization_id=?").run(row.id);
        } else if (result.data.state !== row.state) fail('scope_denied');
      }
    },
    completionAudit: () => ['integration.completed', 'success', 'conversion_destinations_' + (family === 'authorize' ? 'authorized' : family === 'revoke' ? 'revoked' : 'observed')],
  }]));
  function resolve(binding, assetRef, payload, principal, tenantRef) {
    const fixed = binding.googleDataManager?.destinations.some(row => row.assetRef === assetRef
      && row.conversionActionId === payload.conversionActionId && row.events.includes(payload.eventName) && row.sources.includes(payload.eventSource));
    if (fixed) return D.resource(binding, assetRef, payload);
    const target = store.db.prepare("SELECT authorization_id FROM google_destination_targets WHERE principal=? AND tenant=? AND connection=? AND asset=? AND action_id=? AND event_name=? AND event_source=? AND state='active'")
      .get(principal.id, tenantRef, binding.connectionRef, assetRef, payload.conversionActionId, payload.eventName, payload.eventSource);
    if (!target) fail('scope_denied');
    const row = load({ assetRef, tenantRef, connectionRef: binding.connectionRef, payload: {} }, principal, binding, target.authorization_id);
    if (row.state !== 'active') fail('scope_denied');
    const selected = JSON.parse(row.destinations_json).find(item => item.event === payload.eventName
      && item.conversionActionId === payload.conversionActionId && item.sources.includes(payload.eventSource));
    if (!selected) fail('scope_denied');
    return { ...require('./google-ads-contract').resource(binding, assetRef), quotaProjectId: binding.googleDataManager.quotaProjectId,
      authorizationId: row.id, authorizationDigest: row.scope_digest,
      destination: { assetRef, conversionActionId: selected.conversionActionId, events: [selected.event], sources: selected.sources, enhancedPolicy: null } };
  }
  return { operations, resolve };
}
module.exports = { createGoogleDestinations };
