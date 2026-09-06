'use strict';

const db = require('../../models');
const conversationAutomationState = require('./conversationAutomationState.service');

const FlowExecutionV2 = db.FlowExecutionV2;

function toIntOrNull(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function executionConversationId(execution) {
  const context = execution?.context && typeof execution.context === 'object'
    ? execution.context
    : {};
  return toIntOrNull(
    execution?.waiting_meta?.inbound_conversation_id
    || context?.conversation?.id
    || context?.trigger?.data?.conversation_id
  );
}

async function markBufferedResponseExecutionsForHumanReply({
  clinicId,
  conversationId,
  humanMessageId = null,
  executionId = null,
  reason = 'human_reply_during_response_buffer',
} = {}) {
  const normalizedClinicId = toIntOrNull(clinicId);
  const normalizedConversationId = toIntOrNull(conversationId);
  const normalizedHumanMessageId = toIntOrNull(humanMessageId);
  const normalizedExecutionId = toIntOrNull(executionId);
  if (!normalizedClinicId || !normalizedConversationId) {
    return { marked: 0, execution_ids: [] };
  }

  const candidates = await FlowExecutionV2.findAll({
    where: {
      clinic_id: normalizedClinicId,
      status: 'waiting',
      ...(normalizedExecutionId ? { id: normalizedExecutionId } : {}),
    },
    order: [['id', 'ASC']],
    limit: 100,
  });

  const markedExecutionIds = [];
  for (const execution of candidates) {
    const waitingMeta = execution?.waiting_meta && typeof execution.waiting_meta === 'object'
      ? execution.waiting_meta
      : {};
    const pendingInboundIds = Array.isArray(waitingMeta.pending_response_message_ids)
      ? waitingMeta.pending_response_message_ids.map(toIntOrNull).filter(Boolean)
      : [];
    const lastInboundMessageId = toIntOrNull(waitingMeta.last_inbound_message_id);
    const isBufferedResponse = waitingMeta.type === 'delay/wait_response'
      && (pendingInboundIds.length > 0 || Boolean(lastInboundMessageId));

    if (!isBufferedResponse || executionConversationId(execution) !== normalizedConversationId) continue;
    if (normalizedHumanMessageId && lastInboundMessageId && normalizedHumanMessageId <= lastInboundMessageId) continue;

    const [marked] = await FlowExecutionV2.update({
      waiting_meta: {
        ...waitingMeta,
        human_takeover: true,
        human_message_id: normalizedHumanMessageId,
        human_takeover_reason: reason,
        human_takeover_at: new Date().toISOString(),
      },
      updated_at: new Date(),
    }, {
      where: { id: execution.id, status: 'waiting' },
    });
    if (!marked) continue;

    markedExecutionIds.push(Number(execution.id));
    await conversationAutomationState.completeState({
      clinicId: normalizedClinicId,
      conversationId: normalizedConversationId,
      sourceMessageId: lastInboundMessageId || pendingInboundIds[pendingInboundIds.length - 1],
    }, {
      expectedExecutionId: execution.id,
    });
  }

  return {
    marked: markedExecutionIds.length,
    execution_ids: markedExecutionIds,
  };
}

module.exports = {
  markBufferedResponseExecutionsForHumanReply,
};
