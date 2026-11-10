'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const E = require('../../services/whatsappConfigurationTestEvidence.service');
const now = new Date('2030-01-02T10:00:00Z');
function fixture() {
  const asset = { id: 411, isActive: true, assignmentScope: 'clinic', clinicaId: 56,
    whatsappAuthorizationId: '11111111-1111-4111-8111-111111111111', phoneNumberId: '123456', wabaId: 'TESTONLY-WABA', additionalData: {} };
  const binding = { assetId: 411, clinicId:56, authorizationId: asset.whatsappAuthorizationId, phoneId: '123456', wabaId: asset.wabaId, sendEnabled: true };
  const activation = { authorization_id: asset.whatsappAuthorizationId, asset_id: 411, scope_type: 'clinic', scope_id: 56,
    clinic_ids: [56], phone_id: asset.phoneNumberId, waba_id: asset.wabaId, state: 'active',
    created_at: '2030-01-02T08:00:00Z', message_not_before: '2030-01-01T00:00:00Z' };
  const message = { id: 187221, status: 'delivered', direction: 'outbound', message_type: 'template',
    createdAt: '2030-01-02T09:00:00Z', updatedAt: '2030-01-02T09:00:02Z',
    metadata: { kind: 'mass_campaign_test', source: 'marketing_bulk_sends', sender_origin_id: 411,
      phoneNumberId: '123456', wabaId: asset.wabaId, wamid: 'wamid.TESTONLY', template_id: 99,
      template_name: 'TESTONLY-approved', template_language: 'es', recipient: 'TESTONLY-NOT-EXPOSED', payment_recovery_probe: false },
    conversation: { clinic_id: 56, channel: 'whatsapp' } };
  const template = { id: 99, name: 'TESTONLY-approved', waba_id: asset.wabaId, status: 'APPROVED', language: 'es', is_active: true };
  const calls = [];
  const db = { Conversation: {}, WhatsappPhoneActivation: { findAll: async options => { calls.push(['activation', options]); return [activation]; } },
    Message: { findAll: async options => { calls.push(['message', options]); return [message]; } },
    WhatsappTemplate: { findAll: async options => { calls.push(['template', options]); return [template]; } } };
  const service = E.createService({ db, now: () => now });
  return { asset, binding, activation, message, template, calls, db, service,
    read: () => service.read(asset, binding) };
}
test('an ordinary delivered manual test proves current sending configuration without rewriting history or payment', async () => {
  const f = fixture(), before = JSON.stringify(f.asset), result = await f.read();
  assert.equal(result.verified, true); assert.equal(result.app_message_id, 187221);
  assert.equal(result.authorization_id, f.asset.whatsappAuthorizationId); assert.equal(result.message_status, 'delivered');
  assert.equal(JSON.stringify(f.asset), before); assert.equal(f.asset.additionalData.payment, undefined);
  assert(!JSON.stringify(result).includes('TESTONLY-NOT-EXPOSED')); assert(!JSON.stringify(result).includes('template_name'));
  assert.equal(f.calls.length, 3);
});
for (const [name, change] of [
  ['new authorization', f => { f.asset.whatsappAuthorizationId = '22222222-2222-4222-8222-222222222222'; }],
  ['disabled binding', f => { f.binding.sendEnabled = false; }],
  ['different binding identity', f => { f.binding.phoneId = '999999'; }],
  ['foreign binding clinic', f => { f.binding.clinicId = 57; }],
  ['legacy binding without activation', f => { delete f.asset.whatsappAuthorizationId; }],
  ['superseded activation', f => { f.activation.state = 'superseded'; }],
  ['different activation asset', f => { f.activation.asset_id = 999; }],
  ['changed scope', f => { f.activation.scope_id = 57; }],
  ['proof before renewal despite retained original message cutoff', f => { f.message.createdAt = '2030-01-02T07:59:59Z'; }],
  ['proof before message cutoff', f => { f.activation.message_not_before = '2030-01-02T09:30:00Z'; }],
  ['future message', f => { f.message.createdAt = '2030-01-02T10:01:00Z'; }],
  ['future observation', f => { f.message.updatedAt = '2030-01-02T10:01:00Z'; }],
  ['invalid observation', f => { f.message.updatedAt = 'not-a-date'; }],
  ['observation preceding the message', f => { f.message.updatedAt = '2030-01-02T08:59:00Z'; }],
  ['acceptance only', f => { f.message.status = 'pending'; }],
  ['sent only', f => { f.message.status = 'sent'; }],
  ['failed message', f => { f.message.status = 'failed'; }],
  ['another sender', f => { f.message.metadata.sender_origin_id = 412; }],
  ['another WABA', f => { f.message.metadata.wabaId = 'OTHER'; }],
  ['another phone', f => { f.message.metadata.phoneNumberId = '999999'; }],
  ['no native provider identity', f => { delete f.message.metadata.wamid; }],
  ['an automation instead of a manual test', f => { f.message.metadata.kind = 'flow_send_whatsapp'; }],
  ['wrong source', f => { f.message.metadata.source = 'untrusted'; }],
  ['foreign conversation clinic', f => { f.message.conversation.clinic_id = 57; }],
  ['wrong conversation channel', f => { f.message.conversation.channel = 'instagram'; }],
  ['different template WABA', f => { f.template.waba_id = 'OTHER'; }],
  ['pending template', f => { f.template.status = 'PENDING'; }],
  ['different template name', f => { f.template.name = 'OTHER'; }],
  ['different language', f => { f.message.metadata.template_language = 'en'; }],
  ['later payment rejection', f => { f.asset.additionalData.payment = { status: 'missing_payment_method', last_error_code: 131042 }; }],
  ['manual stop', f => { f.asset.additionalData.whatsappManualDisconnect = { state: 'disconnected' }; }],
  ['archived sender', f => { f.asset.additionalData.whatsappArchive = { archivedAt: now.toISOString() }; }],
  ['disabled routing', f => { f.asset.additionalData.routing_disabled = true; }],
]) test(`${name} cannot certify the current configuration`, async () => {
  const f = fixture(); change(f); assert.equal((await f.read()).verified, false);
});
test('read status also proves delivery, and grouped sender evidence is limited to activation clinics', async () => {
  const f = fixture(); f.message.status = 'read'; f.asset.assignmentScope = 'group'; f.asset.grupoClinicaId = 8;
  f.activation.scope_type = 'group'; f.activation.scope_id = 8; f.activation.clinic_ids = [56, 57];
  f.message.conversation.clinic_id = 57; assert.equal((await f.read()).verified, true);
  f.message.conversation.clinic_id = 58; assert.equal((await f.read()).verified, false);
});
test('aggregate reads use three bounded batches rather than one message scan per sender', async () => {
  const f = fixture(); await f.service.forAssets(Array.from({ length: 50 }, () => ({ ...f.asset })), { bindings: new Map([[411, f.binding]]) });
  assert.equal(f.calls.length, 3);
  const query = f.calls.find(x => x[0] === 'message')[1]; assert.equal(query.limit, 1600);
  assert.deepEqual(query.attributes, ['id', 'direction', 'message_type', 'status', 'metadata', 'createdAt', 'updatedAt']);
});
