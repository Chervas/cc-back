'use strict';

const db = require('../../models');

const {
  completeAutomationStateAfterHumanReplyForConversation,
  resolveAutomationAttentionForConversation,
} = require('./conversationPendingReply.service');
const {
  markBufferedResponseExecutionsForHumanReply,
} = require('./automationHumanIntervention.service');

function positiveInt(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function reconcileOutboundHumanReply({
  clinicId,
  conversationId,
  messageId,
  markBuffered = markBufferedResponseExecutionsForHumanReply,
  resolveAttention = resolveAutomationAttentionForConversation,
  completeState = completeAutomationStateAfterHumanReplyForConversation,
} = {}) {
  const normalizedClinicId = positiveInt(clinicId);
  const normalizedConversationId = positiveInt(conversationId);
  const normalizedMessageId = positiveInt(messageId);
  if (!normalizedClinicId || !normalizedConversationId || !normalizedMessageId) {
    return { reconciled: false, reason: 'invalid_scope' };
  }

  const buffered = await markBuffered({
    clinicId: normalizedClinicId,
    conversationId: normalizedConversationId,
    humanMessageId: normalizedMessageId,
    reason: 'mobile_reply_sent_during_response_buffer',
  });
  const notifications = await resolveAttention(normalizedConversationId, null, {
    allUsers: true,
    reason: 'mobile_reply_sent',
  });
  const state = await completeState(normalizedConversationId);

  return {
    reconciled: true,
    buffered_executions_marked: Number(buffered?.marked || 0),
    notifications_updated: Number(notifications?.updated || 0),
    automation_state_completed: state?.completed === true,
    automation_state_reason: state?.reason || null,
  };
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

async function reconcileDeliveryStatus({
  clinicId,
  messageId,
  status,
  findMessage = (...args) => db.Message.findByPk(...args),
  reconcilePayment = (...args) => require('./whatsappPaymentStatus.service').reconcileProviderStatus(...args),
  clearConnection = (...args) => require('./whatsappConnectionStatus.service').clearDisconnectedAfterSuccess(...args),
  recordHealthFailure = (...args) => require('./whatsappAccountHealth.service').recordProviderFailure(...args),
  materializeLeadStatus = (...args) => require('./leadAutoReplyContactStatus.service').materializeLeadAutoReplyProviderStatus(...args),
  materializePatientDirection = (...args) => require('./patientDirection.service').handleHandoffMessageStatus(...args),
  materializeBulkStatus = (...args) => require('./marketingBulkSends.service').materializeMessageStatusFromWebhook(...args),
  materializeDeliveryGovernance = (...args) => require('./whatsappDeliveryGovernance.service').materializeFinalMessageStatus(...args),
} = {}) {
  const normalizedClinicId = positiveInt(clinicId);
  const normalizedMessageId = positiveInt(messageId);
  const normalizedStatus = String(status || '').trim().toLowerCase();
  if (!normalizedClinicId || !normalizedMessageId || !['sent', 'delivered', 'read', 'failed'].includes(normalizedStatus)) {
    return { reconciled: false, reason: 'invalid_scope' };
  }
  const message = await findMessage(normalizedMessageId);
  if (!message) return { reconciled: false, reason: 'message_not_found' };
  const metadata = asObject(message.metadata);
  const providerStatus = {
    ...asObject(metadata.wa_status),
    status: normalizedStatus,
    errors: Array.isArray(metadata.wa_error)
      ? metadata.wa_error
      : (Array.isArray(metadata.wa_status?.errors) ? metadata.wa_status.errors : []),
  };

  const paymentResult = await reconcilePayment({
    status: providerStatus,
    message,
    clinicId: normalizedClinicId,
    source: 'secure_inbox_status',
  });

  if (['sent', 'delivered', 'read'].includes(normalizedStatus)) {
    await clearConnection({
      clinicId: normalizedClinicId,
      phoneId: metadata.phoneNumberId || metadata.phoneId || metadata.phone_number_id || null,
      wabaId: metadata.wabaId || metadata.waba_id || null,
      messageId: normalizedMessageId,
      source: `secure_inbox_status_${normalizedStatus}`,
    });
  } else if (paymentResult?.handled !== true) {
    await recordHealthFailure({
      clinicConfig: {
        originId: metadata.sender_origin_id || metadata.whatsapp_sender_asset_id || null,
        phoneNumberId: metadata.phoneNumberId || metadata.phoneId || metadata.phone_number_id || null,
        wabaId: metadata.wabaId || metadata.waba_id || null,
        clinicaId: normalizedClinicId,
      },
      error: providerStatus,
      source: 'secure_inbox_status',
      messageId: normalizedMessageId,
    });
  }

  await materializeLeadStatus({
    message,
    providerStatus: normalizedStatus,
    providerTimestamp: providerStatus.timestamp || null,
  });
  await materializePatientDirection(message);

  await materializeBulkStatus({
    message,
    status: providerStatus,
    mappedStatus: normalizedStatus,
  });
  await materializeDeliveryGovernance({
    message,
    status: providerStatus,
    mappedStatus: normalizedStatus,
    clinicId: normalizedClinicId,
  });

  return { reconciled: true, status: normalizedStatus };
}

module.exports = {
  reconcileDeliveryStatus,
  reconcileOutboundHumanReply,
};
