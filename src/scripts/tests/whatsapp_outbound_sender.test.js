'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveOutboundSender } = require('../../lib/whatsapp-outbound-sender');

function fixture() {
  const calls = [];
  const input = { message: { id: 9, conversation_id: 8, metadata: { phoneNumberId: '123', wabaId: '456' } },
    conversationId: 8, clinicId: 19, clinicConfig: { clinicaId: 19, phoneNumberId: '123', accessToken: 'FICTITIOUS_REVOKED' } };
  const dependencies = { getConversation: async () => ({ id: 8, clinic_id: 19 }),
    bindingsForClinic: () => [{ clinicId: 19, assetId: 21, phoneId: '123' }],
    resolveScheduled: async value => { calls.push(value); return { phoneNumberId: '123', authorizedBroker: { sendEnabled: false } }; } };
  return { input, dependencies, calls };
}
test('Old queued credentials are replaced by fresh authorized routing with unchanged message pins', async () => {
  const a = fixture(); const result = await resolveOutboundSender(a.input, a.dependencies);
  assert.equal(result.accessToken, undefined); assert.equal(result.authorizedBroker.sendEnabled, false);
  assert.deepEqual(a.calls, [{ clinicId: 19, metadata: { phoneNumberId: '123', wabaId: '456', sender_origin_id: null } }]);
  assert.equal(a.input.clinicConfig.accessToken, 'FICTITIOUS_REVOKED');
});
test('Conversation, clinic and binding mismatches fail before sender lookup', async () => {
  for (const change of [a => a.input.conversationId = 7, a => a.input.clinicId = 20,
    a => a.input.clinicConfig.clinicaId = 20, a => a.input.clinicConfig.authorizedBroker = { clinicId: 20 },
    a => a.dependencies.getConversation = async () => null]) {
    const a = fixture(); change(a); await assert.rejects(resolveOutboundSender(a.input, a.dependencies), { code: 'whatsapp_sender_snapshot_scope_mismatch' });
    assert.equal(a.calls.length, 0);
  }
});
test('Persisted sender and patient-direction metadata cannot be overridden by stale queue pins', async () => {
  const a = fixture(); a.input.message.metadata = { sender_origin_id: 21, patient_direction_assignment_id: 31, phoneId: '123', wabaId: '456' };
  Object.assign(a.input.clinicConfig, { originId: 99, phoneNumberId: '999', wabaId: '999' });
  await resolveOutboundSender(a.input, a.dependencies);
  assert.equal(a.calls[0].metadata.sender_origin_id, 21); assert.equal(a.calls[0].metadata.patient_direction_assignment_id, 31);
  assert.equal(a.calls[0].metadata.phoneNumberId, '123'); assert.equal(a.calls[0].metadata.wabaId, '456');
});
test('Removed authorization cannot fall back to an old queued credential', async () => {
  const a = fixture(); a.input.clinicConfig.authorizedBroker = { clinicId: 19 }; a.dependencies.bindingsForClinic = () => [];
  a.dependencies.resolveScheduled = async () => { throw Error('whatsapp_config_missing'); };
  await assert.rejects(resolveOutboundSender(a.input, a.dependencies), /whatsapp_config_missing/);
});
test('Non-migrated legacy routing and explicit scheduled resolution preserve behavior', async () => {
  const a = fixture(); a.dependencies.bindingsForClinic = () => [];
  assert.equal(await resolveOutboundSender(a.input, a.dependencies), a.input.clinicConfig); assert.equal(a.calls.length, 0);
  a.input.resolveClinicConfigAtSend = true; await resolveOutboundSender(a.input, a.dependencies); assert.equal(a.calls.length, 1);
});
