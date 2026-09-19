'use strict';
const C = require('./google-action-management-contract');
const ads = require('./google-ads-contract');
const { fail } = require('./errors');

function createGoogleActionManagement({ store, http, withDeveloperSecret, now = Date.now }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS google_action_plans (
    id TEXT PRIMARY KEY, principal TEXT NOT NULL, tenant TEXT NOT NULL, connection TEXT NOT NULL, asset TEXT NOT NULL,
    scope_digest TEXT NOT NULL, input_json TEXT NOT NULL, plan_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('prepared','attempted','applied')), result_json TEXT,
    created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS google_action_locks (
    customer TEXT NOT NULL, event TEXT NOT NULL, plan_id TEXT NOT NULL, request_id TEXT NOT NULL,
    PRIMARY KEY(customer,event), FOREIGN KEY(plan_id) REFERENCES google_action_plans(id));`);
  const load = (request, principal, binding) => {
    const row = store.db.prepare('SELECT * FROM google_action_plans WHERE id=? AND principal=? AND tenant=? AND connection=? AND asset=?')
      .get(request.payload.planId, principal.id, request.tenantRef, request.connectionRef, request.assetRef);
    if (!row) fail('scope_denied');
    const input = JSON.parse(row.input_json), plan = JSON.parse(row.plan_json);
    if (row.scope_digest !== C.scopeDigest(binding, request.assetRef, input, principal)) fail('scope_denied');
    return { row, input, plan };
  };
  const status = row => ({ planId: row.id, state: row.state, expiresAt: row.expires_at,
    changes: JSON.parse(row.plan_json).changes, results: row.result_json ? JSON.parse(row.result_json) : null });
  const valid = row => { if (row.expires_at <= now()) fail('action_plan_expired'); };
  async function inventory(context, account, developerToken) {
    const rows = [], tokens = new Set(); let pageToken;
    do {
      context.assertActive();
      const raw = await http({ hostname: 'googleads.googleapis.com', path: `/${ads.API_VERSION}/customers/${account.customerId}/googleAds:search`,
        token: context.secret, developerToken, loginCustomerId: account.loginCustomerId, signal: context.signal,
        json: { query: ads.query('conversion_actions', { pageToken: null }), ...(pageToken ? { pageToken } : {}) } });
      context.assertActive();
      const page = ads.projectPage('conversion_actions', raw, {}, account);
      rows.push(...page.results); pageToken = page.nextPageToken;
      if (rows.length > 5000 || pageToken && (!page.results.length || tokens.has(pageToken) || tokens.size >= 5000)) fail('provider_failed');
      if (pageToken) tokens.add(pageToken);
    } while (pageToken);
    if (new Set(rows.map(ads.rowKey)).size !== rows.length) fail('provider_failed');
    return rows;
  }
  const operations = Object.fromEntries(Object.entries(C.OPERATIONS).map(([family, operation]) => [operation, {
    provider: C.PROVIDER, requiredScopes: C.SCOPES, effect: family === 'apply' ? 'write' : 'read',
    persistResult: family !== 'status', validate: payload => C.validate(operation, payload),
    authorize({ request, principal, binding }) {
      if (family === 'prepare') C.resource(binding, request.assetRef, request.payload);
      else load(request, principal, binding);
    },
    async execute(context) {
      const { binding, payload, assetRef, principalId, tenantRef, requestId, assertActive } = context;
      const principal = context.policy.principals.find(row => row.id === principalId);
      const request = { payload, assetRef, tenantRef, connectionRef: binding.connectionRef };
      if (family === 'status') { assertActive(); return status(load(request, principal, binding).row); }
      return withDeveloperSecret(binding, async developerToken => {
        assertActive();
        if (family === 'prepare') {
          const target = C.resource(binding, assetRef, payload);
          const plan = C.plan(payload, await inventory(context, target, developerToken), target);
          const at = now();
          // Persist only selected canonical metadata and fixed operations. The
          // commit is coupled to the generic command receipt and completion audit.
          return { planId: requestId, state: 'prepared', expiresAt: at + C.TTL_MS, changes: plan.changes,
            internal: { input: payload, plan, at, scope: C.scopeDigest(binding, assetRef, payload, principal) } };
        }
        let { row, input, plan } = load(request, principal, binding);
        if (row.state === 'applied') return status(row);
        if (row.state === 'attempted') fail('outcome_unknown'); valid(row);
        const target = C.resource(binding, assetRef, input);
        const drift = async () => {
          assertActive(); valid(row);
          const fresh = C.plan(input, await inventory(context, target, developerToken), target);
          if (C.hash(fresh) !== C.hash(plan)) fail('action_plan_conflict');
        };
        const mutate = async validateOnly => {
          assertActive(); valid(row);
          const raw = await http({ hostname: 'googleads.googleapis.com', path: `/${ads.API_VERSION}/customers/${target.customerId}/conversionActions:mutate`,
            token: context.secret, developerToken, loginCustomerId: target.loginCustomerId, signal: context.signal,
            json: { operations: plan.operations, partialFailure: false, validateOnly, responseContentType: 'RESOURCE_NAME_ONLY' } });
          assertActive(); return C.result(raw, plan, target, validateOnly);
        };
        if (family === 'validate') {
          await drift(); if (plan.operations.length) await mutate(true); await drift();
          return { ...status(row), validated: true };
        }
        let attempted = false;
        store.transaction(() => {
          assertActive(); row = load(request, principal, binding).row; valid(row);
          if (row.state !== 'prepared') fail('outcome_unknown');
          // Expired preparations can no longer reach the mutation boundary.
          // An attempted plan is never unlocked by time, restart or a new UUID.
          store.db.prepare("DELETE FROM google_action_locks WHERE plan_id IN (SELECT id FROM google_action_plans WHERE state='prepared' AND expires_at<=?)").run(now());
          // Even unchanged selections must respect an unknown earlier attempt;
          // a fresh no-op plan is not reconciliation of that durable receipt.
          for (const item of plan.changes) {
            const held = store.db.prepare('SELECT plan_id FROM google_action_locks WHERE customer=? AND event=?').get(target.customerId, item.event);
            if (held) fail('action_plan_busy');
            store.db.prepare('INSERT INTO google_action_locks VALUES (?,?,?,?)').run(target.customerId, item.event, row.id, requestId);
          }
        });
        try {
          await drift(); if (plan.operations.length) { await mutate(true); await drift(); }
          store.transaction(() => {
            assertActive(); const current = load(request, principal, binding).row; valid(current);
            if (current.state !== 'prepared') fail('outcome_unknown');
            for (const item of plan.changes) {
              const held = store.db.prepare('SELECT plan_id,request_id FROM google_action_locks WHERE customer=? AND event=?').get(target.customerId, item.event);
              if (held?.plan_id !== row.id || held.request_id !== requestId) fail('action_plan_busy');
            }
            store.db.prepare("UPDATE google_action_plans SET state='attempted' WHERE id=? AND state='prepared'").run(row.id);
            attempted = true;
          });
          const results = plan.operations.length ? await mutate(false) : [];
          return { ...status(row), state: 'applied', results };
        } finally {
          if (!attempted) store.transaction(() => {
            // Another command for the same plan might already have crossed the
            // boundary; never remove its durable locks from this failed reader.
            const current = store.db.prepare('SELECT state FROM google_action_plans WHERE id=?').get(row.id);
            if (current?.state === 'prepared') store.db.prepare('DELETE FROM google_action_locks WHERE plan_id=? AND request_id=?').run(row.id, requestId);
          });
        }
      }, { signal: context.signal });
    },
    project(result) {
      if (!result || Buffer.byteLength(JSON.stringify(result)) > 32768) fail('provider_failed');
      // Private preparation metadata is consumed by commit without returning it
      // or persisting it as part of the public generic command result.
      const { internal, ...value } = result;
      if (internal) prepared.set(value, internal);
      return value;
    },
    commit({ request, principal, result }) {
      if (family === 'prepare') {
        const internal = prepared.get(result.data); if (!internal) fail('provider_failed');
        store.db.prepare("INSERT INTO google_action_plans VALUES (?,?,?,?,?,?,?,?,'prepared',NULL,?,?)")
          .run(request.requestId, principal.id, request.tenantRef, request.connectionRef, request.assetRef,
            internal.scope, JSON.stringify(internal.input), JSON.stringify(internal.plan), internal.at, result.data.expiresAt);
      } else if (family === 'apply') {
        const changed = store.db.prepare("UPDATE google_action_plans SET state='applied',result_json=? WHERE id=? AND state='attempted'")
          .run(JSON.stringify(result.data.results), request.payload.planId);
        if (!changed.changes && store.db.prepare('SELECT state FROM google_action_plans WHERE id=?').get(request.payload.planId)?.state !== 'applied') fail('outcome_unknown');
        store.db.prepare('DELETE FROM google_action_locks WHERE plan_id=?').run(request.payload.planId);
      }
    },
    completionAudit() { return ['integration.completed', 'success', family === 'apply' ? 'canonical_actions_applied' : 'canonical_actions_checked']; },
  }]));
  const prepared = new WeakMap();
  return { operations, appliedPlan(request, principal, binding) {
    const value = load(request, principal, binding);
    if (value.row.state === 'attempted') fail('outcome_unknown');
    if (value.row.state !== 'applied' || !value.row.result_json) fail('action_plan_conflict');
    return { ...value, results: JSON.parse(value.row.result_json) };
  } };
}
module.exports = { createGoogleActionManagement };
