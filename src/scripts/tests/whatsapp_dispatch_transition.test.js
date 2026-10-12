'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const Module = require('node:module');
const W = require('../../lib/whatsapp-dispatch-wait');
const service = require('../../services/whatsappDispatchWait.service');
function fixture(t) {
  const original = Module._load;
  const inbound = { id: 12, direction: 'inbound', sent_at: new Date(), metadata: { automatic_actions_allowed: true,
    inbox_receipt: 'synthetic', fresh_inbound_dispatched_at: new Date().toISOString(), historical: false,
    phone_number_id: '123', waba_id: '456' } };
  const conversation = { id: 3, clinic_id: 2, channel: 'whatsapp' };
  const outbound = { id: 11, status: 'pending', metadata: { execution_id: 7, wamid: 'wamid.SYNTHETIC', dispatch_wait: {
    state: 'accepted', post_attempt_at: new Date(Date.now() - 1000).toISOString(), expires_at: new Date(Date.now() + 86400000).toISOString(),
    intent: { expectedBinding: { phoneId: '123', wabaId: '456' } } } } };
  const execution = { id: 7, clinic_id: 2, status: 'waiting', current_node_id: 'N2',
    waiting_meta: { kind: 'whatsapp_dispatch', message_id: 11 }, templateVersion: { is_active: true,
      nodes: [{ id: 'N2', type: 'action/send_whatsapp' }, { id: 'N5', type: 'delay/wait_response' }] } };
  const db = { Sequelize: { Op: { lt: Symbol('lt'), and: Symbol('and') } },
    sequelize: { where: () => ({}), literal: () => ({}) }, Message: { findOne: async () => outbound },
    FlowExecutionV2: { findByPk: async () => execution } };
  Module._load = function(request, parent) { return Module._resolveFilename(request, parent) === require.resolve('../../../models') ? db : original.apply(this, arguments); };
  t.after(() => { Module._load = original; });
  return { inbound, conversation, outbound, execution, run: () => service.inboundTransition(inbound, conversation) };
}
test('an accepted receipt can wake only its own current native transport wait', () => {
  const e = { id: 7, waiting_meta: { kind: 'whatsapp_dispatch', message_id: 11 } };
  const m = { id: 11, status: 'pending', metadata: { execution_id: 7, wamid: 'wamid.SYNTHETIC' } };
  assert.equal(W.acceptedTransport(e, m), true);
  assert.equal(W.acceptedTransport({ ...e, id: 8 }, m), false);
  assert.equal(W.acceptedTransport(e, { ...m, id: 12 }), false);
  assert.equal(W.acceptedTransport(e, { ...m, metadata: { execution_id: 7 } }), false);
});
test('a fresh early reply remains in its native inbound job until the response wait is ready', async t => {
  const f = fixture(t); const result = await f.run(); assert.equal(result.executionId, 7);
  assert.equal(result.reason, 'native_transport_transition'); assert(result.nextAllowedAt > new Date());
  f.execution.status = 'running'; f.execution.current_node_id = 'N5'; f.execution.waiting_meta = null;
  assert.equal((await f.run()).executionId, 7);
  f.execution.status = 'waiting'; assert.equal(await f.run(), null); // Native resume now owns this reply.
});
test('a lost acceptance holds its fresh reply for reconciliation, not another AI or generic automation', async t => {
  const f = fixture(t); delete f.outbound.metadata.wamid; f.outbound.metadata.dispatch_wait.state = 'reconciling';
  assert.equal((await f.run()).reason, 'native_transport_transition');
  f.outbound.metadata.dispatch_wait.expires_at = new Date(Date.now() - 1).toISOString();
  assert.equal((await f.run()).review, true);
});
test('history, recovery-only data, prior replies, another number/clinic and disabled recipes cannot enter this handoff', async t => {
  for (const change of [{ historical: true }, { recovery_without_automation: true },
    { automatic_actions_allowed: false }, { media_recovered_without_automation: true }, { phone_number_id: '789' }]) {
    await t.test(JSON.stringify(change), async sub => { const f = fixture(sub); Object.assign(f.inbound.metadata, change); assert.equal(await f.run(), null); });
  }
  const f = fixture(t); f.inbound.sent_at = new Date(Date.now() - 60000); assert.equal(await f.run(), null);
  f.inbound.sent_at = new Date(); f.execution.clinic_id = 9; assert.equal(await f.run(), null);
  f.execution.clinic_id = 2; f.execution.templateVersion.is_active = false; assert.equal(await f.run(), null);
});
test('a provably rejected send does not capture an unsolicited reply as its own response', async t => {
  const f = fixture(t); delete f.outbound.metadata.wamid; f.outbound.metadata.dispatch_wait.state = 'waiting'; assert.equal(await f.run(), null);
});
test('transport polling remains inside its 24h TTL without exhausting 4096 native attempts', () => {
  const now = 600001; const interval = W.retryAt(17, now, 'broker_unavailable').getTime() - now;
  assert.equal(interval, 30000); assert(86400000 / interval < 4096);
});
