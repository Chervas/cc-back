'use strict';

function fail() {
  throw Object.assign(Error('whatsapp_sender_snapshot_scope_mismatch'), {
    code: 'whatsapp_sender_snapshot_scope_mismatch', retryable: false,
  });
}

// A queued payload is an old routing snapshot, never authority to reuse a
// credential. Resolve authorized senders again against the owning conversation.
async function resolveOutboundSender(input, dependencies) {
  const { message, conversationId, clinicId, clinicConfig, resolveClinicConfigAtSend } = input;
  const { getConversation, bindingsForClinic, resolveScheduled } = dependencies;
  if (!message || String(message.conversation_id) !== String(conversationId)) fail();
  const conversation = await getConversation(message.conversation_id);
  const owner = Number(conversation?.clinic_id);
  if (!Number.isSafeInteger(owner) || owner <= 0 || clinicId != null && Number(clinicId) !== owner) fail();
  for (const scope of [clinicConfig?.clinicId, clinicConfig?.clinicaId, clinicConfig?.authorizedBroker?.clinicId]) {
    if (scope != null && Number(scope) !== owner) fail();
  }
  const authorized = bindingsForClinic(owner);
  if (resolveClinicConfigAtSend !== true && !clinicConfig?.authorizedBroker && !authorized.length) return clinicConfig;
  const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
  // DB metadata takes precedence; the queued source pins are a fallback for
  // older jobs. A reassigned phone/WABA is rejected by resolveScheduled.
  return resolveScheduled({ clinicId: owner, metadata: {
    ...metadata,
    phoneNumberId: metadata.phoneNumberId || metadata.phoneId || clinicConfig?.phoneNumberId || null,
    wabaId: metadata.wabaId || clinicConfig?.wabaId || null,
    sender_origin_id: metadata.sender_origin_id || metadata.whatsapp_sender_asset_id || clinicConfig?.originId || null,
  } });
}

module.exports = { resolveOutboundSender };
