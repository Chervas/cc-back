'use strict';
const C = require('./google-data-manager-contract');
const { fail } = require('./errors');
function createDataManagerOperations({ store, http, destinations, now = Date.now }) {
  const resource = (binding, assetRef, payload, principal, tenantRef) => destinations
    ? destinations.resolve(binding, assetRef, payload, principal, tenantRef) : C.resource(binding, assetRef, payload);
  // Only operational receipt metadata. No conversion body, identifiers or tokens.
  store.db.exec(`CREATE TABLE IF NOT EXISTS google_data_manager_receipts (
    id TEXT PRIMARY KEY, principal TEXT NOT NULL, tenant TEXT NOT NULL, connection TEXT NOT NULL,
    asset TEXT NOT NULL, action_id TEXT NOT NULL, event_name TEXT NOT NULL, event_source TEXT NOT NULL,
    scope_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('attempted','accepted')),
    provider_id TEXT, created_at INTEGER NOT NULL, accepted_at INTEGER);
    CREATE INDEX IF NOT EXISTS google_data_manager_receipt_scope
      ON google_data_manager_receipts(principal,tenant,connection,asset);
    CREATE UNIQUE INDEX IF NOT EXISTS google_data_manager_provider_receipt
      ON google_data_manager_receipts(provider_id) WHERE provider_id IS NOT NULL;
    CREATE TABLE IF NOT EXISTS google_data_manager_receipt_authorizations (
      submission_id TEXT PRIMARY KEY REFERENCES google_data_manager_receipts(id),
      authorization_id TEXT NOT NULL, authorization_digest TEXT NOT NULL);`);
  const isReceiptRead = operation => [C.OPERATIONS.status, C.OPERATIONS.reconcile].includes(operation);
  function receipt(request, principal, binding, historical = false) {
    const row = store.db.prepare('SELECT * FROM google_data_manager_receipts WHERE id=? AND principal=? AND tenant=? AND connection=? AND asset=?')
      .get(request.payload.submissionId, principal.id, request.tenantRef, request.connectionRef, request.assetRef);
    if (!row) fail('scope_denied');
    const selection = { conversionActionId: row.action_id, eventName: row.event_name, eventSource: row.event_source };
    let target;
    if (historical) {
      // No adoption from a current target or a provider ID supplied by a caller.
      const authority = store.db.prepare('SELECT authorization_id,authorization_digest FROM google_data_manager_receipt_authorizations WHERE submission_id=?').get(row.id);
      if (!authority || typeof destinations?.resolveReceipt !== 'function') fail('outcome_unknown');
      target = destinations.resolveReceipt(binding, request.assetRef, selection, principal, request.tenantRef, authority);
    } else target = resource(binding, request.assetRef, selection, principal, request.tenantRef);
    if (C.scopeDigest(binding, request.assetRef, selection, target) !== row.scope_digest) fail('scope_denied');
    if (row.state !== 'accepted' || !C.providerId(row.provider_id)) fail('outcome_unknown');
    return { row, target };
  }
  const operations = Object.fromEntries(Object.values(C.OPERATIONS).map(operation => [operation, {
    provider: C.PROVIDER, requiredScopes: C.SCOPES, effect: operation === C.OPERATIONS.ingest ? 'write' : 'read',
    persistResult: !isReceiptRead(operation),
    validate: payload => C.validate(operation, payload),
    authorize({ request, binding, principal }) {
      if (isReceiptRead(operation)) { receipt(request, principal, binding, operation === C.OPERATIONS.reconcile); return; }
      const target = resource(binding, request.assetRef, request.payload, principal, request.tenantRef);
      if (operation === C.OPERATIONS.ingest) C.assertEnhanced(target, request.payload.event, now());
    },
    async execute(context) {
      const { payload, binding, assetRef, requestId, principalId, tenantRef, secret, signal, assertActive } = context;
      const principal = context.policy.principals.find(row => row.id === principalId);
      assertActive();
      if (isReceiptRead(operation)) {
        const request = { payload, assetRef, tenantRef, connectionRef: binding.connectionRef };
        const historical = operation === C.OPERATIONS.reconcile;
        const { row, target } = receipt(request, principal, binding, historical);
        const raw = await http({ hostname: 'datamanager.googleapis.com',
          path: '/v1/requestStatus:retrieve?requestId=' + encodeURIComponent(row.provider_id),
          token: secret, quotaProjectId: target.quotaProjectId, signal });
        assertActive(); receipt(request, principal, binding, historical);
        return { submissionId: row.id, requestId: row.provider_id, ...C.statusResult(raw, target) };
      }
      const target = resource(binding, assetRef, payload, principal, tenantRef);
      const digest = C.scopeDigest(binding, assetRef, payload, target);
      const verify = () => {
        assertActive();
        const current = resource(binding, assetRef, payload, principal, tenantRef);
        if (C.scopeDigest(binding, assetRef, payload, current) !== digest) fail('scope_denied');
        if (operation === C.OPERATIONS.ingest) C.assertEnhanced(current, payload.event, now());
      };
      const json = C.body(operation, payload, target, requestId, now());
      if (operation === C.OPERATIONS.ingest) {
        store.transaction(() => {
          verify();
          // A second principal cannot submit the same receipt ID concurrently.
          if (store.db.prepare('SELECT 1 FROM google_data_manager_receipts WHERE id=?').get(requestId)) fail('idempotency_conflict');
          store.db.prepare("INSERT INTO google_data_manager_receipts VALUES (?,?,?,?,?,?,?,?,?,'attempted',NULL,?,NULL)")
            .run(requestId, principalId, tenantRef, binding.connectionRef, assetRef, payload.conversionActionId,
              payload.eventName, payload.eventSource, digest, now());
          if (target.authorizationId) store.db.prepare('INSERT INTO google_data_manager_receipt_authorizations VALUES (?,?,?)')
            .run(requestId, target.authorizationId, target.authorizationDigest);
        });
      }
      verify();
      const raw = await http({ hostname: 'datamanager.googleapis.com', path: '/v1/events:ingest',
        token: secret, quotaProjectId: target.quotaProjectId, json, signal });
      verify();
      return C.ingestResult(raw, requestId, operation === C.OPERATIONS.validate);
    },
    project(result) {
      if (Buffer.byteLength(JSON.stringify(result)) > 32768) fail('provider_failed');
      return structuredClone(result);
    },
    commit({ request, principal, policy, result }) {
      if (isReceiptRead(operation)) {
        const binding = policy.connections.find(row => row.connectionRef === request.connectionRef);
        const { row } = receipt(request, principal, binding, operation === C.OPERATIONS.reconcile);
        if (row.id !== result.data.submissionId || row.provider_id !== result.data.requestId) fail('scope_denied');
        return;
      }
      if (operation !== C.OPERATIONS.ingest) return;
      const binding = policy.connections.find(row => row.connectionRef === request.connectionRef);
      const target = resource(binding, request.assetRef, request.payload, principal, request.tenantRef);
      const pending = store.db.prepare('SELECT scope_digest FROM google_data_manager_receipts WHERE id=?').get(request.requestId);
      if (pending?.scope_digest !== C.scopeDigest(binding, request.assetRef, request.payload, target)) fail('scope_denied');
      if (target.authorizationId) {
        const authority = store.db.prepare('SELECT authorization_id,authorization_digest FROM google_data_manager_receipt_authorizations WHERE submission_id=?').get(request.requestId);
        if (authority?.authorization_id !== target.authorizationId || authority.authorization_digest !== target.authorizationDigest) fail('scope_denied');
      }
      C.assertEnhanced(target, request.payload.event, now());
      const updated = store.db.prepare("UPDATE google_data_manager_receipts SET state='accepted',provider_id=?,accepted_at=? WHERE id=? AND principal=? AND tenant=? AND connection=? AND asset=? AND state='attempted'")
        .run(result.data.requestId, now(), request.requestId, principal.id, request.tenantRef, request.connectionRef, request.assetRef);
      if (updated.changes !== 1) fail('idempotency_conflict');
    },
    completionAudit() { return operation === C.OPERATIONS.ingest ? ['integration.completed', 'accepted', 'provider_accepted']
      : ['integration.completed', 'success', operation === C.OPERATIONS.validate ? 'validation_completed'
        : operation === C.OPERATIONS.reconcile ? 'receipt_reconciled' : 'status_observed']; },
  }]));
  return { operations };
}
module.exports = { createDataManagerOperations };
