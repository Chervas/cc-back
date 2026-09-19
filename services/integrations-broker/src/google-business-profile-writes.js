'use strict';
const C = require('./google-business-profile-write-contract');
const { fail } = require('./errors');

function createBusinessProfileWrites({ store, http, now = Date.now }) {
  store.db.exec(`CREATE TABLE IF NOT EXISTS google_business_profile_mutations (
    id TEXT PRIMARY KEY, principal TEXT NOT NULL, tenant TEXT NOT NULL, connection TEXT NOT NULL, asset TEXT NOT NULL,
    kind TEXT NOT NULL, input_digest TEXT NOT NULL, scope_digest TEXT NOT NULL, request_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('attempted','applied')), result_json TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS google_business_profile_mutation_locks (
    resource TEXT PRIMARY KEY, operation_id TEXT NOT NULL,
    FOREIGN KEY(operation_id) REFERENCES google_business_profile_mutations(id));
    CREATE INDEX IF NOT EXISTS google_business_profile_mutation_owner
    ON google_business_profile_mutation_locks(operation_id);`);
  function load(request, principal, binding, kind) {
    const row = store.db.prepare('SELECT * FROM google_business_profile_mutations WHERE id=?').get(request.payload.operationId);
    if (!row) return null;
    if (row.principal !== principal.id || row.tenant !== request.tenantRef || row.connection !== request.connectionRef || row.asset !== request.assetRef) fail('scope_denied');
    // Status is authorized against the capability originally used as well as its
    // own grant. It cannot expose a receipt after that capability/key is removed.
    const target = C.resource(binding, request.assetRef, request.tenantRef, 'status', request.payload);
    if (row.scope_digest !== C.scopeDigest(binding, target, principal)) fail('scope_denied');
    if (kind !== 'status' && (row.kind !== kind || row.input_digest !== C.hash({ kind, payload: request.payload }))) fail('idempotency_conflict');
    return row;
  }
  const receipt = row => row.state === 'applied' ? JSON.parse(row.result_json)
    : { operationId: row.id, kind: row.kind, state: 'unknown', result: null };
  const operations = Object.fromEntries(Object.entries(C.OPERATIONS).map(([kind, operation]) => [operation, {
    provider: C.PROVIDER, requiredScopes: C.SCOPES, effect: kind === 'status' ? 'read' : 'write',
    ...(kind === 'status' ? { control: 'google_business_profile_status', secretless: true, persistResult: false } : {}),
    validate: payload => C.validate(kind, payload),
    authorize({ request, binding, principal }) {
      C.resource(binding, request.assetRef, request.tenantRef, kind, request.payload);
      load(request, principal, binding, kind);
    },
    async execute(context) {
      const { binding, assetRef, tenantRef, principalId, payload, assertActive } = context;
      const principal = context.policy.principals.find(row => row.id === principalId);
      const request = { payload, tenantRef, assetRef, connectionRef: binding.connectionRef };
      const existing = load(request, principal, binding, kind);
      assertActive();
      if (kind === 'status') {
        if (existing && !context.policy.grants.some(grant => grant.principalId === principalId
          && grant.tenantRef === tenantRef && grant.connectionRef === binding.connectionRef && grant.assetRef === assetRef
          && grant.operations.includes(C.OPERATIONS[existing.kind]))) fail('scope_denied');
        return existing ? receipt(existing) : { operationId: payload.operationId, kind: null, state: 'not_found', result: null };
      }
      if (existing) { if (existing.state !== 'applied') fail('outcome_unknown'); return receipt(existing); }
      const target = C.resource(binding, assetRef, tenantRef, kind, payload);
      if (kind === 'hours') {
        const current = await http({ hostname: 'mybusinessbusinessinformation.googleapis.com',
          path: `/v1/${target.location}?readMask=name%2CregularHours`, token: context.secret, signal: context.signal });
        assertActive();
        if (current?.name !== target.location) fail('scope_denied');
        if (!Array.isArray(current.regularHours?.periods) || !current.regularHours.periods.length) fail('business_profile_regular_hours_required');
      }
      // Commit the no-repeat boundary before the provider can see a mutation.
      // Unknown attempts keep locks across process exits, new UUIDs and changes
      // of principal, tenant or Google account managing the same location.
      store.transaction(() => {
        assertActive();
        if (load(request, principal, binding, kind)) fail('outcome_unknown');
        const locks = C.lockKeys(target, kind, payload);
        for (const resource of locks) if (store.db.prepare('SELECT 1 FROM google_business_profile_mutation_locks WHERE resource=?').get(resource)) fail('business_profile_mutation_busy');
        store.db.prepare("INSERT INTO google_business_profile_mutations VALUES (?,?,?,?,?,?,?,?,?,'attempted',NULL,?)")
          .run(payload.operationId, principalId, tenantRef, binding.connectionRef, assetRef, kind,
            C.hash({ kind, payload }), C.scopeDigest(binding, target, principal), context.requestId, now());
        for (const resource of locks) store.db.prepare('INSERT INTO google_business_profile_mutation_locks VALUES (?,?)').run(resource, payload.operationId);
      });
      let hostname = 'mybusiness.googleapis.com', path, json;
      if (kind === 'replyUpdate' || kind === 'replyDelete') {
        path = `/v4/${target.parent}/reviews/${payload.reviewId}/reply`;
        if (kind === 'replyUpdate') json = { comment: payload.comment };
      } else if (kind === 'photo') {
        path = `/v4/${target.parent}/media`;
        json = { mediaFormat: 'PHOTO', sourceUrl: payload.sourceUrl, locationAssociation: { category: payload.category },
          ...(payload.description !== null ? { description: payload.description } : {}) };
      } else {
        hostname = 'mybusinessbusinessinformation.googleapis.com'; path = `/v1/${target.location}?updateMask=specialHours`;
        json = { name: target.location, specialHours: { specialHourPeriods: C.expandPeriods(payload.periods) } };
      }
      assertActive();
      const raw = await http({ hostname, path, json, businessProfileMutation: kind, token: context.secret, signal: context.signal });
      assertActive();
      return { operationId: payload.operationId, kind, state: 'applied', result: C.project(kind, raw, target, payload), completedAt: now() };
    },
    project(value) {
      if (!value || Buffer.byteLength(JSON.stringify(value)) > 200000) fail('provider_failed');
      return structuredClone(value);
    },
    commit({ request, principal, result }) {
      if (kind === 'status') return;
      const row = store.db.prepare('SELECT * FROM google_business_profile_mutations WHERE id=?').get(request.payload.operationId);
      if (!row || row.principal !== principal.id || row.kind !== kind
        || row.input_digest !== C.hash({ kind, payload: request.payload })) fail('outcome_unknown');
      if (row.state === 'applied') return;
      store.db.prepare("UPDATE google_business_profile_mutations SET state='applied', result_json=? WHERE id=? AND state='attempted'")
        .run(JSON.stringify(result.data), row.id);
      store.db.prepare('DELETE FROM google_business_profile_mutation_locks WHERE operation_id=?').run(row.id);
    },
    completionAudit: () => ['integration.completed', 'success', kind === 'status' ? 'business_profile_receipt_checked' : 'business_profile_mutation_applied'],
  }]));
  return { operations };
}
module.exports = { createBusinessProfileWrites };
