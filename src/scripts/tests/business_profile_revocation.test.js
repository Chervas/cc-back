'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto');
const service = require('../../services/businessProfileRevocation.service');
const row = () => ({ request_id: randomUUID(), external_location_id: '456', connection_ref: 'connection:qa', asset_ref: 'gbp:123:456',
  clinica_id: 71, google_connection_id: 81, actor_user_id: 501, requested_at: new Date('2026-09-13T12:00:00.000Z') });
function fixture(options = {}) {
  const state = { queue: [row()], calls: [], retries: [], confirms: [], clock: new Date('2026-09-13T12:00:00.000Z'), ...options };
  const repository = { claim: async () => state.queue.shift(), confirm: async claim => { state.confirms.push(claim); return true; },
    retry: async (claim, code) => state.retries.push({ claim, code }), health: async () => ({ pending: state.queue.length }), ...options.repository };
  const client = { execute: async (command, limits) => { state.calls.push({ command, limits });
    return options.execute ? options.execute(command) : { requestId: command.requestId, data: { revoked: true } }; } };
  return { state, worker: service.createRevocationWorker({ repository, client, enabled: () => !state.disabled, now: () => state.clock }) };
}
test('worker sends only the persisted scope and request id with a bounded empty control payload', async () => {
  const f = fixture(); const id = f.state.queue[0].request_id; const result = await f.worker.run();
  assert.equal(result.confirmed, 1); assert.deepEqual(f.state.calls[0], { command: { requestId: id,
    operation: 'google.business_profile.asset.revoke.v1', tenantRef: 'clinic:71', connectionRef: 'connection:qa', assetRef: 'gbp:123:456', payload: {} }, limits: { timeoutMs: 10000 } });
});
test('lost response retries the same id; malformed acknowledgements and private failures never confirm', async () => {
  for (const execute of [async () => { throw Error('FICTITIOUS_SECRET'); }, async () => ({ requestId: 'other', data: { revoked: true } }),
    async command => ({ requestId: command.requestId, data: { revoked: true, secret: 'FICTITIOUS_SECRET' } })]) {
    const claim = row(); const f = fixture({ queue: [claim], execute }); const result = await f.worker.run();
    assert.equal(result.failed, 1); assert.equal(f.state.confirms.length, 0); assert.equal(f.state.retries[0].claim.request_id, claim.request_id);
    assert(!JSON.stringify(f.state.retries).includes('FICTITIOUS_SECRET'));
  }
});
test('disabled worker loads no repository, keys or real model index; busy runs cannot overlap', async () => {
  const f = fixture({ disabled: true }); assert.equal((await f.worker.run()).skipped, true); assert.equal(f.state.queue.length, 1);
  process.env.GOOGLE_BUSINESS_PROFILE_REVOCATION_WORKER_ENABLED = 'false'; assert.equal((await service.run()).skipped, true);
  assert.equal(require.cache[require.resolve('../../../models')], undefined);
  let release; f.state.disabled = false; const held = fixture({ execute: command => new Promise(resolve => { release = () => resolve({ requestId: command.requestId, data: { revoked: true } }); }) });
  const first = held.worker.run(); await new Promise(resolve => setImmediate(resolve));
  assert.equal((await held.worker.run()).skipped, true); release(); assert.equal((await first).confirmed, 1);
});
test('each cycle stops after 20 assets or elapsed deadline and does not confirm a lost lease', async () => {
  const f = fixture({ queue: Array.from({ length: 25 }, row) }); assert.equal((await f.worker.run()).confirmed, 20); assert.equal(f.state.queue.length, 5);
  const timed = fixture({ queue: [row(), row()], execute: async command => { timed.state.clock = new Date(timed.state.clock.getTime() + 31000); return { requestId: command.requestId, data: { revoked: true } }; } });
  assert.equal((await timed.worker.run()).confirmed, 1); assert.equal(timed.state.queue.length, 1);
  const lost = fixture({ repository: { confirm: async () => false } }); assert.equal((await lost.worker.run()).failed, 1); assert.equal(lost.state.retries.length, 1);
});
