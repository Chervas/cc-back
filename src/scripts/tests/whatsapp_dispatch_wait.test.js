'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const Module = require('node:module');
const { createJobClaim } = require('../../services/jobClaim.service');
const W = require('../../lib/whatsapp-dispatch-wait');
const service = require('../../services/whatsappDispatchWait.service');
function fixture(t, { receipt = 'absent', expired = false, disabled = false, blocked = false, brokerDown = false, testSend = false, outsideHours = false, receiptLimited = false } = {}) {
  const original = Module._load; const now = Date.now(); const sent = [], queued = new Map();
  const intent = { messageId: '91', clinicId: 2, assetId: 3, expectedBinding: { phoneId: '123', wabaId: '456' },
    message: { messaging_product: 'whatsapp', to: '34000000123', type: 'text', text: { body: 'FICTITIOUS_ONLY' } } };
  const send = { authorizationId: 'synthetic', phoneId: '123', message: intent.message };
  const message = { id: 91, conversation_id: 92, status: 'pending', metadata: { ...(testSend ? { source: 'marketing_bulk_sends', kind: 'mass_campaign_test', list_id: 10, item_id: 11 } : {}) },
    async update(patch) { Object.assign(this, patch); return this; }, async reload() { return this; } };
  const job = { id: 9, type: service.TYPE, status: 'running', attempts: 1, last_attempt_at: new Date(now), payload: { __runtime_namespace: 'staging' } };
  const result = { messages: [{ id: 'wamid.FICTITIOUS', message_status: 'accepted' }] };
  const models = { sequelize: { transaction: async fn => fn({ LOCK: { UPDATE: 'UPDATE' } }) },
    Message: { findByPk: async () => message, findOne: async () => ({ createdAt: new Date() }) },
    JobRequest: { findByPk: async () => job }, MarketingPatientList: { findByPk: async () => ({ status: 'sending' }) },
    MarketingPatientListItem: { update: async () => { throw Error('TEST_MUST_NOT_UPDATE_PATIENT_ITEM'); } } };
  const claim = createJobClaim(job, { isActive: () => true, models, namespace: () => 'staging' });
  const stop = { isStop: e => e.code === 'automation_deactivated',
    assertMessageCanDispatch: async () => { if (disabled) throw Object.assign(Error('stop'), { code: 'automation_deactivated' }); },
    cancelMessage: async () => { message.status = 'cancelled'; } };
  const dependencies = new Map([
    [require.resolve('../../../models'), models],
    [require.resolve('../../services/jobRequests.service'), { enqueueUniqueJobRequest: async value => { queued.set(value.dedupeScope, value); } }],
    [require.resolve('../../lib/automation-runtime-stop'), stop],
    [require.resolve('../../lib/whatsappAuthorizedBrokerClient'), {
      sendReceipt: async () => { if (receiptLimited) throw Object.assign(Error('limited'), { code: 'rate_limited' });
        return { state: receipt, result: receipt === 'accepted' ? result : null }; },
      send: async value => { sent.push(structuredClone(value)); if (brokerDown) throw Object.assign(Error('capacity'), { code: 'whatsapp_capacity_concurrency', dispatchDeferred: true, dispatchIntent: intent, dispatchPayload: send }); return result; },
    }],
    [require.resolve('../../services/whatsappAccountHealth.service'), { assertCanSend: async () => { if (blocked) throw Object.assign(Error('scope_blocked'), { code: 'scope_blocked' }); } }],
    [require.resolve('../../services/whatsapp.service'), { assertRecipientCanReceive: async () => {} }],
    [require.resolve('../../services/marketingOptOut.service'), { assertAutomationCommunicationAllowed: async () => {} }],
    [require.resolve('../../services/marketingBulkSends.service'), { deferredDispatchAllowedAt: async () => outsideHours ? new Date(Date.now() + 3600000) : null }],
    [require.resolve('../../services/socket.service'), { getIO: () => null }],
    [require.resolve('../../services/appointmentWhatsappDeliveryAlert.service'), { reconcileAppointmentWhatsappDelivery: async () => {} }],
  ]);
  Module._load = function(request, parent, isMain) {
    const resolved = Module._resolveFilename(request, parent); return dependencies.has(resolved) ? dependencies.get(resolved) : original.apply(this, arguments);
  };
  t.after(() => { Module._load = original; });
  return { message, sent, queued, intent, run: () => service.run({ message_id: 91, clinicId: 2 }, job, claim),
    async defer(unknown = false) {
      await service.defer({ code: unknown ? 'whatsapp_delivery_unknown' : 'rate_limited', dispatchDeferred: true,
        delivery_unknown: unknown, dispatchIntent: intent, dispatchPayload: send });
      if (expired) message.metadata.dispatch_wait.expires_at = new Date(now - 1).toISOString();
    } };
}
test('stable native outbox resumes a rejected send once, without a second Message or IA execution', async t => {
  const f = fixture(t); await f.defer(); await f.defer(); assert.equal(f.queued.size, 1);
  assert.equal(W.flowWait(f.message).waiting_meta.resume_mode, 'retry_current_node');
  const completed = await f.run(); await f.run();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].messageId, '91');
  assert.equal(completed.result.provider_accepted, true); assert.equal(completed.result.delivered, false);
  assert.equal(f.message.status, 'pending'); assert.equal(f.message.metadata.dispatch_wait.state, 'accepted');
});
test('lost acceptance is recovered only by the scoped receipt and never by another POST', async t => {
  const f = fixture(t, { receipt: 'accepted' }); await f.defer(true); await f.run();
  assert.equal(f.sent.length, 0); assert.equal(f.message.metadata.wamid, 'wamid.FICTITIOUS');
});
test('unknown ledger outcome stays pending with a visible reconciliation, not a blind send', async t => {
  const f = fixture(t, { receipt: 'unknown' }); await f.defer(true);
  for (let i = 0; i < 200; i++) assert.equal((await f.run()).status, 'waiting');
  assert.equal(f.sent.length, 0); assert.equal(f.message.metadata.delivery_unknown, true);
});
test('confirmed absent receipt allows the same original Message identity to dispatch once', async t => {
  const f = fixture(t); await f.defer(true); await f.run(); await f.run();
  assert.equal(f.sent.length, 1); assert.equal(f.message.metadata.delivery_unknown, false);
});
test('a global outage/capacity pause remains a durable wait rather than failing the flow', async t => {
  const f = fixture(t, { brokerDown: true }); await f.defer();
  for (let i = 0; i < 200; i++) assert.equal((await f.run()).status, 'waiting');
  assert.equal(f.queued.size, 1); assert.equal(f.message.status, 'pending'); assert(!f.message.metadata.wamid);
});
test('deactivated automations, expired transport waits and blocked scopes never contact Meta', async t => {
  for (const options of [{ disabled: true }, { expired: true }, { blocked: true }]) {
    await t.test(JSON.stringify(options), async sub => {
      const f = fixture(sub, options); await f.defer(); await f.run(); assert.equal(f.sent.length, 0);
    });
  }
});
test('expired unknown delivery retains its hold for manual review', async t => {
  const f = fixture(t, { expired: true }); await f.defer(true); await f.run();
  assert.equal(f.sent.length, 0); assert.equal(f.message.status, 'pending'); assert.equal(f.message.metadata.dispatch_wait.state, 'review');
  assert.equal(f.message.metadata.delivery_unknown, true);
});
test('test sends can recover delivery but never update a sample patient campaign item', async t => {
  const f = fixture(t, { testSend: true }); await f.defer(); assert.equal((await f.run()).status, 'completed');
});
test('a delayed commercial send keeps its configured business hours', async t => {
  const f = fixture(t, { testSend: true, outsideHours: true }); await f.defer();
  const result = await f.run(); assert.equal(result.status, 'waiting'); assert.equal(f.sent.length, 0);
  assert(result.nextAllowedAt.getTime() > Date.now() + 3500000);
});
test('a temporarily rate-limited receipt retains reconciliation without sending or failing', async t => {
  const f = fixture(t, { receiptLimited: true }); await f.defer(true);
  assert.equal((await f.run()).status, 'waiting'); assert.equal(f.sent.length, 0);
  assert.equal(f.message.metadata.dispatch_wait.state, 'reconciling'); assert.equal(f.message.status, 'pending');
});
test('patient replies use clinical priority; batches use commercial and controls are separate', () => {
  assert.equal(W.lane({ metadata: { source: 'marketing_bulk_sends', inbound_message_id: 2 } }), 'clinical');
  assert.equal(W.lane({ metadata: { source: 'marketing_bulk_sends', item_id: 2 } }), 'commercial');
  assert.equal(W.decision({ code: 'broker_unavailable' }), null);
  assert.equal(W.decision({ code: 'broker_unavailable', beforeDispatch: true }), 'waiting');
  assert.equal(W.decision({ code: 'scope_denied' }), null);
});
