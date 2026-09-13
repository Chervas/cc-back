'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto');
const service = require('../../services/googleAdsRevocation.service');
const { tupleHash, validate } = require('../../services/googleAdsRevocation.contract');
const { scopeFixture } = require('./fixtures/google_ads_broker_scope.fixture');
function rowFor(f = scopeFixture()) {
  const row = { ...f.binding, scope_key: 'group:5', clinic_ids: '[59,71]', mapping_ids: '[11]',
    request_id: randomUUID(), actor_user_id: 501, requested_at: new Date('2026-09-13T12:00:00Z'), state: 'pending' };
  row.tuple_hash = tupleHash(row); return validate(row);
}
function fixture(execute) {
  const state = { queue: [rowFor()], calls: [], confirms: [], retries: [], clock: new Date('2026-09-13T12:00:00Z') };
  const repository = { claim: async () => { await state.beforeClaim?.(); return state.queue.shift(); },
    confirm: async row => { state.confirms.push(row); return !state.stale; }, retry: async (row, code) => state.retries.push({ row, code }),
    health: async () => ({ pending: state.queue.length }) };
  const client = { execute: async (command, budget) => { state.calls.push({ command, budget }); return execute ? execute(command) : { requestId: command.requestId, data: { revoked: true } }; } };
  return { state, worker: service.createRevocationWorker({ repository, client, enabled: () => !state.disabled, now: () => state.clock }) };
}
test('Ads control sends only the durable asset tuple and requires its exact acknowledgement', async () => {
  const f = fixture(); const original = f.state.queue[0]; assert.equal((await f.worker.run()).confirmed, 1);
  assert.deepEqual(f.state.calls, [{ command: { requestId: original.request_id, operation: 'google.ads.asset.revoke.v1',
    tenantRef: 'clinic:59', connectionRef: original.connection_ref, assetRef: original.asset_ref, payload: {} }, budget: { timeoutMs: 10000 } }]);
  for (const execute of [async () => { throw Error('FICTITIOUS_PRIVATE_ERROR'); }, async () => null,
    async command => ({ requestId: 'different', data: { revoked: true } }),
    async command => ({ requestId: command.requestId, data: { revoked: false } }),
    async command => ({ requestId: command.requestId, data: { revoked: true, token: 'FICTITIOUS_PRIVATE_ERROR' } })]) {
    const failed = fixture(execute); const request = failed.state.queue[0].request_id;
    assert.equal((await failed.worker.run()).failed, 1); assert.equal(failed.state.confirms.length, 0);
    assert.equal(failed.state.retries[0].row.request_id, request); assert(!JSON.stringify(failed.state.retries).includes('FICTITIOUS_PRIVATE_ERROR'));
  }
});
test('malformed history and tampered ownership never reach the broker', async () => {
  for (const mutation of [{ tuple_hash: 'a'.repeat(64) }, { tenant_clinic_id: 0 }, { google_user_id: 'unknown' },
    { customer_id: '123' }, { login_customer_id: 'evil.invalid' }, { scope_key: 'group:0' }, { clinic_ids: '[59,71,71]' },
    { clinic_ids: '[71]' }, { mapping_ids: '[]' }, { mapping_ids: '[0]' }, { state: 'active' }, { actor_user_id: 0 }]) {
    const f = fixture(); Object.assign(f.state.queue[0], mutation);
    assert.equal((await f.worker.run()).failed, 1); assert.equal(f.state.calls.length, 0);
  }
});
test('disabled control touches no database or keys, while busy, deadline and lease checks bound delivery', async () => {
  const before = process.env.GOOGLE_ADS_REVOCATION_WORKER_ENABLED;
  try { process.env.GOOGLE_ADS_REVOCATION_WORKER_ENABLED = 'false'; assert.equal((await service.run()).skipped, true);
    assert.equal(require.cache[require.resolve('../../../models')], undefined);
  } finally { if (before === undefined) delete process.env.GOOGLE_ADS_REVOCATION_WORKER_ENABLED; else process.env.GOOGLE_ADS_REVOCATION_WORKER_ENABLED = before; }
  const disabled = fixture(); disabled.state.disabled = true; assert.equal((await disabled.worker.run()).skipped, true);
  const many = fixture(); many.state.queue = Array.from({ length: 25 }, () => rowFor());
  assert.equal((await many.worker.run()).confirmed, 20); assert.equal(many.state.queue.length, 5);
  const late = fixture(); late.state.beforeClaim = () => { late.state.clock = new Date(late.state.clock.getTime() + 31000); };
  assert.equal((await late.worker.run()).failed, 1); assert.equal(late.state.calls.length, 0);
  const stale = fixture(); stale.state.stale = true; assert.equal((await stale.worker.run()).failed, 1);
  let release; let entered; const start = new Promise(resolve => { entered = resolve; });
  const busy = fixture(command => new Promise(resolve => { entered(); release = () => resolve({ requestId: command.requestId, data: { revoked: true } }); }));
  const running = busy.worker.run(); await start; assert.equal((await busy.worker.run()).skipped, true); release(); await running;
});
test('independent history closes reads after registry deletion and discards a response after a concurrent disconnect', async () => {
  const f = scopeFixture(); const context = await f.service.prepare(f.mapping); const row = rowFor(f);
  f.state.revocations = [row]; await assert.rejects(f.service.assertContext(context), { code: 'asset_revoked' });
  f.state.bindings = []; f.mapping.broker_read_connection_ref = f.mapping.broker_read_asset_ref = null;
  f.state.enabled = false; await assert.rejects(f.create().prepare(f.mapping), { code: 'asset_revoked' });
  const race = scopeFixture(); const { createGoogleAdsBroker } = require('../../services/googleAdsBroker.service'); let calls = 0;
  const reader = createGoogleAdsBroker({ ...race.options, client: { execute: async command => {
    calls++; race.state.revocations = [rowFor(race)]; return { requestId: command.requestId, data: { results: [], nextPageToken: null } };
  } } });
  const captured = await reader.prepare(race.mapping);
  await assert.rejects(reader.read(race.mapping, captured, 'campaigns', {}), { code: 'asset_revoked' }); assert.equal(calls, 1);
});
test('status hides a group tuple unless the caller is authorized for every captured clinic', async () => {
  const models = { GoogleAdsBrokerRevocation: { findAll: async () => [{ state: 'pending', clinic_ids: '[59,71]' }] } };
  assert.deepEqual(await service.status([59], models), { status: 'none', pending_assets: 0, confirmed_assets: 0 });
  assert.deepEqual(await service.status([59,71], models), { status: 'pending', pending_assets: 1, confirmed_assets: 0 });
});

test('verified v11 Ads events project through the existing restricted audit view without resource names or internal queue data', async () => {
  const { randomUUID } = require('node:crypto');
  const { pack, keyFor } = require('../../../services/platform-audit/src/event');
  const { fromRevocation } = require('../../../services/platform-audit/src/google-ads-disconnect-event');
  const { createView } = require('../../services/platformAudit.view');
  for (const kind of ['google_ads']) {
    const row = rowFor(); const packed = pack(fromRevocation(row, 'completed', new Date(row.requested_at)));
    const receipt = { key: keyFor(packed), digest: packed.digest, versionId: 'fictitious-v11' }; let reads = 0; const audit = [];
    const view = createView({ model: { sequelize: { constructor: { QueryTypes: { SELECT: 'SELECT' } },
      query: async () => [{ ...packed, event_id: packed.event.eventId, occurred_at: row.requested_at, receipt }] } },
      audit: { health: async () => ({ pending: 0, oldestAgeSeconds: 0 }), append: async e => audit.push(e) },
      reader: { read: async () => { reads++; return { results: [{ status: 'verified', body: packed.body, receipt }] }; } }, codec: {},
      now: () => new Date('2026-09-13T12:01:00Z') });
    const input = { actorId: 1, sessionRef: randomUUID(), query: { from: '2026-09-13', to: '2026-09-13' } };
    const result = await view.read(input); assert.equal(reads, 1); assert.equal(audit.length, 2);
    assert.deepEqual(result.events[0].integrationDisconnect, { correlationId: row.request_id,
      provider: kind, connectionRef: row.connection_ref, assetRef: row.asset_ref });
    assert.equal(result.events[0].verification, 's3_version_verified'); assert(!JSON.stringify(result).includes(row.google_user_id));
    await assert.rejects(view.read({ ...input, actorId: 701 }), { code: 'technical_admin_required' }); assert.equal(reads, 1);
  }
});
