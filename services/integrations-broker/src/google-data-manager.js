'use strict';
const C = require('./google-data-manager-contract');
const { fail } = require('./errors');
function createDataManagerOperations({ store, http, now = Date.now }) {
  // Only operational receipt metadata. No conversion body, identifiers or tokens.
  store.db.exec(`CREATE TABLE IF NOT EXISTS google_data_manager_receipts (
    id TEXT PRIMARY KEY, principal TEXT NOT NULL, tenant TEXT NOT NULL, connection TEXT NOT NULL,
    asset TEXT NOT NULL, action_id TEXT NOT NULL, event_name TEXT NOT NULL, event_source TEXT NOT NULL,
    scope_digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('attempted','accepted')),
    provider_id TEXT, created_at INTEGER NOT NULL, accepted_at INTEGER);
    CREATE INDEX IF NOT EXISTS google_data_manager_receipt_scope
      ON google_data_manager_receipts(principal,tenant,connection,asset);
    CREATE UNIQUE INDEX IF NOT EXISTS google_data_manager_provider_receipt
      ON google_data_manager_receipts(provider_id) WHERE provider_id IS NOT NULL;`);
  function receipt(request, principal, binding) {
    const row = store.db.prepare('SELECT * FROM google_data_manager_receipts WHERE id=? AND principal=? AND tenant=? AND connection=? AND asset=?')
      .get(request.payload.submissionId, principal.id, request.tenantRef, request.connectionRef, request.assetRef);
    if (!row) fail('scope_denied');
    const selection = { conversionActionId: row.action_id, eventName: row.event_name, eventSource: row.event_source };
    const target = C.resource(binding, request.assetRef, selection);
    if (C.scopeDigest(binding, request.assetRef, selection) !== row.scope_digest) fail('scope_denied');
    if (row.state !== 'accepted' || !C.providerId(row.provider_id)) fail('outcome_unknown');
    return { row, target };
  }
  const operations = Object.fromEntries(Object.values(C.OPERATIONS).map(operation => [operation, {
    provider: C.PROVIDER, requiredScopes: C.SCOPES, effect: operation === C.OPERATIONS.ingest ? 'write' : 'read',
    persistResult: operation !== C.OPERATIONS.status,
    validate: payload => C.validate(operation, payload),
    authorize({ request, binding, principal }) {
      if (operation === C.OPERATIONS.status) { receipt(request, principal, binding); return; }
      const target = C.resource(binding, request.assetRef, request.payload);
      if (operation === C.OPERATIONS.ingest) C.assertEnhanced(target, request.payload.event, now());
    },
    async execute(context) {
      const { payload, binding, assetRef, requestId, principalId, tenantRef, secret, signal, assertActive } = context;
      assertActive();
      if (operation === C.OPERATIONS.status) {
        const request = { payload, assetRef, tenantRef, connectionRef: binding.connectionRef };
        const { row, target } = receipt(request, { id: principalId }, binding);
        const raw = await http({ hostname: 'datamanager.googleapis.com',
          path: '/v1/requestStatus:retrieve?requestId=' + encodeURIComponent(row.provider_id),
          token: secret, quotaProjectId: target.quotaProjectId, signal });
        assertActive(); receipt(request, { id: principalId }, binding);
        return C.statusResult(raw, target);
      }
      const target = C.resource(binding, assetRef, payload);
      const json = C.body(operation, payload, target, requestId, now());
      if (operation === C.OPERATIONS.ingest) {
        store.transaction(() => {
          assertActive();
          // A second principal cannot submit the same receipt ID concurrently.
          if (store.db.prepare('SELECT 1 FROM google_data_manager_receipts WHERE id=?').get(requestId)) fail('idempotency_conflict');
          store.db.prepare("INSERT INTO google_data_manager_receipts VALUES (?,?,?,?,?,?,?,?,?,'attempted',NULL,?,NULL)")
            .run(requestId, principalId, tenantRef, binding.connectionRef, assetRef, payload.conversionActionId,
              payload.eventName, payload.eventSource, C.scopeDigest(binding, assetRef, payload), now());
        });
      }
      assertActive();
      const raw = await http({ hostname: 'datamanager.googleapis.com', path: '/v1/events:ingest',
        token: secret, quotaProjectId: target.quotaProjectId, json, signal });
      assertActive();
      return C.ingestResult(raw, requestId, operation === C.OPERATIONS.validate);
    },
    project(result) {
      if (Buffer.byteLength(JSON.stringify(result)) > 32768) fail('provider_failed');
      return structuredClone(result);
    },
    commit({ request, principal, result }) {
      if (operation !== C.OPERATIONS.ingest) return;
      const updated = store.db.prepare("UPDATE google_data_manager_receipts SET state='accepted',provider_id=?,accepted_at=? WHERE id=? AND principal=? AND tenant=? AND connection=? AND asset=? AND state='attempted'")
        .run(result.data.requestId, now(), request.requestId, principal.id, request.tenantRef, request.connectionRef, request.assetRef);
      if (updated.changes !== 1) fail('idempotency_conflict');
    },
    completionAudit() { return operation === C.OPERATIONS.ingest ? ['integration.completed', 'accepted', 'provider_accepted']
      : ['integration.completed', 'success', operation === C.OPERATIONS.validate ? 'validation_completed' : 'status_observed']; },
  }]));
  return { operations };
}
module.exports = { createDataManagerOperations };
