'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'); const assert = require('node:assert/strict');
const service = require('../../services/googlePropertyRevocation.service');
const { tupleHash } = require('../../services/googlePropertyRevocation.contract');
const { revocationFor } = require('./fixtures/google_property_revocation.fixture');
const { propertyFixture } = require('./fixtures/google_property_discovery.fixture');
function fixture(options = {}) {
  const queue = ['search_console', 'analytics'].map(kind => revocationFor(kind, propertyFixture(kind).mapping));
  const state = { queue, calls: [], confirms: [], retries: [], clock: new Date('2026-09-13T12:00:00.000Z'), ...options };
  const repository = { claim: async () => { await state.beforeClaim?.(); return state.queue.shift(); },
    confirm: async claim => { state.confirms.push(claim); return true; }, retry: async (claim, code) => state.retries.push({ claim, code }),
    health: async () => ({ pending: state.queue.length }), ...options.repository };
  const clients = Object.fromEntries(['search_console', 'analytics'].map(kind => [kind, { execute: async (command, limits) => {
    state.calls.push({ kind, command, limits }); return options.execute ? options.execute(command) : { requestId: command.requestId, data: { revoked: true } };
  } }]));
  return { state, worker: service.createRevocationWorker({ repository, clients, enabled: () => !state.disabled, now: () => state.clock }) };
}
test('property worker routes persisted tuples to their own control client and preserves request IDs', async () => {
  const f = fixture(); const original = [...f.state.queue]; assert.equal((await f.worker.run()).confirmed, 2);
  for (let i = 0; i < original.length; i++) {
    const row = original[i]; assert.deepEqual(f.state.calls[i], { kind: row.kind, command: { requestId: row.request_id,
      operation: 'google.' + row.kind + '.asset.revoke.v1', tenantRef: 'clinic:71', connectionRef: row.connection_ref, assetRef: row.asset_ref, payload: {} }, limits: { timeoutMs: 10000 } });
  }
});
test('failed, malformed or mismatched ACKs remain pending and return only safe errors', async () => {
  for (const execute of [async () => { throw Error('FICTITIOUS_SECRET'); }, async () => null,
    async command => ({ requestId: 'other', data: { revoked: true } }),
    async command => ({ requestId: command.requestId, data: { revoked: true, token: 'FICTITIOUS_SECRET' } }),
    async command => ({ requestId: command.requestId, data: { revoked: false } })]) {
    const f = fixture({ execute }); const original = f.state.queue.map(r => r.request_id);
    assert.equal((await f.worker.run()).failed, 2); assert.equal(f.state.confirms.length, 0);
    assert.deepEqual(f.state.retries.map(r => r.claim.request_id), original); assert(!JSON.stringify(f.state.retries).includes('FICTITIOUS_SECRET'));
  }
});
test('invalid durable identity never reaches a broker client', async () => {
  for (const changes of [{ kind: 'meta' }, { tuple_hash: 'a'.repeat(64) }, { clinica_id: 0 }, { google_user_id: 'unknown' },
    { resource: 'https://evil.invalid/token' }, { asset_ref: 'ga4:0' }, { connection_ref: 'https://evil.invalid' }, { state: 'active' }, { actor_user_id: 0 }]) {
    const f = fixture(); f.state.queue = [{ ...f.state.queue[0], ...changes }];
    assert.equal((await f.worker.run()).failed, 1); assert.equal(f.state.calls.length, 0);
  }
});
test('disabled property worker opens no keys, models or sockets and prevents overlapping runs', async () => {
  const before = process.env.GOOGLE_PROPERTY_REVOCATION_WORKER_ENABLED;
  try {
    process.env.GOOGLE_PROPERTY_REVOCATION_WORKER_ENABLED = 'false'; assert.equal((await service.run()).skipped, true);
    assert.equal(require.cache[require.resolve('../../../models')], undefined);
  } finally { if (before === undefined) delete process.env.GOOGLE_PROPERTY_REVOCATION_WORKER_ENABLED; else process.env.GOOGLE_PROPERTY_REVOCATION_WORKER_ENABLED = before; }
  const disabled = fixture({ disabled: true }); assert.equal((await disabled.worker.run()).skipped, true); assert.equal(disabled.state.queue.length, 2);
  let release; let entered; const started = new Promise(resolve => { entered = resolve; });
  const f = fixture({ execute: command => new Promise(resolve => { entered(); release = () => resolve({ requestId: command.requestId, data: { revoked: true } }); }) });
  f.state.queue.length = 1; const run = f.worker.run(); await started;
  assert.equal((await f.worker.run()).skipped, true); release(); assert.equal((await run).confirmed, 1);
});
test('property cycle respects 20 commands, cooperative deadline and stale lease rejection', async () => {
  const f = fixture(); f.state.queue = Array.from({ length: 25 }, () => ({ ...f.state.queue[0] }));
  assert.equal((await f.worker.run()).confirmed, 20); assert.equal(f.state.queue.length, 5);
  const timed = fixture(); timed.state.beforeClaim = () => { timed.state.clock = new Date(timed.state.clock.getTime() + 31000); };
  assert.equal((await timed.worker.run()).failed, 1); assert.equal(timed.state.calls.length, 0); assert.equal(timed.state.queue.length, 1);
  const lost = fixture({ repository: { confirm: async () => false } }); assert.equal((await lost.worker.run()).failed, 2); assert.equal(lost.state.retries.length, 2);
});
for (const kind of ['search_console', 'analytics']) {
  test(kind + ' local tombstones block reads with gates off, survive missing bindings and preserve another clinic', async () => {
    const f = propertyFixture(kind); const tombstone = revocationFor(kind, f.mapping); const context = await f.reader.prepare(f.mapping);
    f.state.revocations = [tombstone];
    await assert.rejects(f.reader.read(f.mapping, context, 'discovery', {}, { beforeExecute: async () => ({ timeoutMs: 1000 }) }), { code: 'asset_revoked' });
    f.state.enabled = false; await assert.rejects(f.reader.prepare(f.mapping), { code: 'asset_revoked' }); f.state.enabled = true;
    f.state.revocations = [{ ...tombstone, clinica_id: 72 }]; f.state.revocations[0].tuple_hash = tupleHash(f.state.revocations[0]);
    await f.reader.prepare(f.mapping);
    f.state.records = []; f.state.mappings[0].broker_read_connection_ref = f.state.mappings[0].broker_read_asset_ref = null;
    await assert.rejects(f.reader.prepare(f.state.mappings[0]), { code: 'broker_binding_invalid' }); assert.equal(f.state.calls.length, 0);
  });
  test(kind + ' a tombstone committed during the provider await discards the response', async () => {
    const f = propertyFixture(kind); const context = await f.reader.prepare(f.mapping);
    f.state.afterCall = () => { f.state.revocations = [revocationFor(kind, f.mapping)]; };
    await assert.rejects(f.reader.read(f.mapping, context, 'discovery', {}, { beforeExecute: async () => ({ timeoutMs: 1000 }) }), { code: 'asset_revoked' });
    assert.equal(f.state.calls.length, 1); await assert.rejects(f.reader.prepare(f.mapping), { code: 'asset_revoked' });
  });
}
test('capture rejects overflowing inventories, inconsistent identities and unhealthy audit before any mutation', async () => {
  const property = propertyFixture('analytics'); const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  for (const failure of ['bindings', 'revocations', 'shared', 'groups', 'members', 'identity', 'missing-binding', 'audit-count', 'audit-age']) {
    let writes = 0; const noWrite = async () => { writes++; assert.fail('Capture must reject before any mutation'); };
    const empty = { findAll: async () => [], update: noWrite };
    const models = { SearchConsoleBrokerBinding: empty,
      AnalyticsBrokerBinding: { findAll: async () => failure === 'bindings' ? Array(201).fill(property.record) : failure === 'missing-binding' ? [] : [property.record], update: noWrite },
      GooglePropertyBrokerRevocation: { findAll: async () => failure === 'revocations' ? Array(201).fill({}) : [], create: noWrite },
      ClinicAnalyticsProperty: { findAll: async () => [{ ...property.mapping, ...(failure === 'identity' ? { clinicaId: 72 } : {}) }] },
      GroupAssetClinicAssignment: { findAll: async () => failure === 'shared' ? Array(1001).fill({ clinicaId: 71 }) : [] },
      GrupoClinica: { findAll: async () => failure === 'groups' ? Array(1001).fill({ id_grupo: 9 }) : failure === 'members' ? [{ id_grupo: 9 }] : [] },
      Clinica: { findAll: async () => Array(1001).fill({ id_clinica: 71 }) },
      PlatformAuditEvent: { sequelize: {}, create: noWrite, count: async () => failure === 'audit-count' ? 10000 : 0,
        min: async () => failure === 'audit-age' ? new Date('2026-09-13T10:00:00Z') : null } };
    await assert.rejects(service.enqueue({ models, transaction, connectionId: 81, clinicIds: [71], actorId: 501,
      mappings: { analytics: [property.mapping] }, enabled: 'true', now: new Date('2026-09-13T12:00:00Z') }), { code: 'google_property_revocation_unavailable' }, failure);
    assert.equal(writes, 0, failure);
  }
});
test('verified v9 events project through the existing restricted audit view without resource names or internal queue data', async () => {
  const { randomUUID } = require('node:crypto');
  const { pack, keyFor } = require('../../../services/platform-audit/src/event');
  const { fromRevocation } = require('../../../services/platform-audit/src/google-property-disconnect-event');
  const { createView } = require('../../services/platformAudit.view');
  for (const kind of ['search_console', 'analytics']) {
    const row = revocationFor(kind, propertyFixture(kind).mapping); const packed = pack(fromRevocation(row, 'completed', new Date(row.requested_at)));
    const receipt = { key: keyFor(packed), digest: packed.digest, versionId: 'fictitious-v9' }; let reads = 0; const audit = [];
    const view = createView({ model: { sequelize: { constructor: { QueryTypes: { SELECT: 'SELECT' } },
      query: async () => [{ ...packed, event_id: packed.event.eventId, occurred_at: row.requested_at, receipt }] } },
      audit: { health: async () => ({ pending: 0, oldestAgeSeconds: 0 }), append: async e => audit.push(e) },
      reader: { read: async () => { reads++; return { results: [{ status: 'verified', body: packed.body, receipt }] }; } }, codec: {},
      now: () => new Date('2026-09-13T12:01:00Z') });
    const input = { actorId: 1, sessionRef: randomUUID(), query: { from: '2026-09-13', to: '2026-09-13' } };
    const result = await view.read(input); assert.equal(reads, 1); assert.equal(audit.length, 2);
    assert.deepEqual(result.events[0].integrationDisconnect, { correlationId: row.request_id,
      provider: kind === 'analytics' ? 'google_analytics' : 'google_search_console', connectionRef: row.connection_ref, assetRef: row.asset_ref });
    assert.equal(result.events[0].verification, 's3_version_verified'); assert(!JSON.stringify(result).includes(row.resource));
    await assert.rejects(view.read({ ...input, actorId: 701 }), { code: 'technical_admin_required' }); assert.equal(reads, 1);
  }
});
