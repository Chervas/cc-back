'use strict';

// Resolve attention for an already-owned reply after a patient's phone changed.
// This does not change the identity of either chat, the AI evidence or a send.
async function ownedResponseConversation(db, execution, context, originalConversationId) {
  const sourceId = Number(context?.last_response_context?.response_message_id);
  const clinicId = Number(execution?.clinic_id);
  const executionId = Number(execution?.id);
  if (![sourceId, clinicId, executionId].every(n => Number.isInteger(n) && n > 0)) return null;
  const message = await db.Message.findByPk(sourceId, {
    attributes: ['id', 'conversation_id', 'direction'], raw: true,
  });
  if (!message || message.direction !== 'inbound'
    || Number(message.conversation_id) === Number(originalConversationId)) return null;
  const conversation = await db.Conversation.findByPk(message.conversation_id, {
    attributes: ['id', 'clinic_id', 'patient_id', 'lead_id'], raw: true,
  });
  const patientId = Number(context?.appointment?.paciente_id || context?.patient?.id || context?.conversation?.patient_id);
  if (!conversation || Number(conversation.clinic_id) !== clinicId || !patientId
    || Number(conversation.patient_id) !== patientId) return null;
  const state = await db.ConversationAutomationState.findOne({ where: {
    conversation_id: conversation.id, clinic_id: clinicId,
    execution_id: executionId, source_message_id: sourceId,
  } });
  if (!state || Number(state.execution_id) !== executionId || Number(state.clinic_id) !== clinicId
    || Number(state.conversation_id) !== Number(conversation.id) || Number(state.source_message_id) !== sourceId) return null;
  return { conversationId: Number(conversation.id), state };
}

module.exports = { ownedResponseConversation };
