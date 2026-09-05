'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const { getIO } = require('./socket.service');
const { emitNotificationUpdated } = require('./notificationsRealtime.service');
const conversationAutomationState = require('./conversationAutomationState.service');
const { serializeState: serializeAutomationState } = conversationAutomationState;

function normalizeConversationIds(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  ));
}

async function findHumanReplyAfterMessage(conversationId, responseMessageId, options = {}) {
  const numericConversationId = Number(conversationId);
  const numericResponseMessageId = Number(responseMessageId);
  if (
    !Number.isInteger(numericConversationId)
    || numericConversationId <= 0
    || !Number.isInteger(numericResponseMessageId)
    || numericResponseMessageId <= 0
  ) {
    return null;
  }

  const rows = await db.sequelize.query(`
    SELECT id
    FROM Messages
    WHERE conversation_id = :conversationId
      AND id > :responseMessageId
      AND direction = 'outbound'
      AND message_type <> 'event'
      AND status <> 'failed'
      AND (
        sender_id IS NOT NULL
        OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.source_event')), '') = 'smb_message_echoes'
        OR COALESCE(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.coexistence.source_event')), '') = 'smb_message_echoes'
      )
    ORDER BY id ASC
    LIMIT 1
  `, {
    replacements: {
      conversationId: numericConversationId,
      responseMessageId: numericResponseMessageId,
    },
    type: db.Sequelize.QueryTypes.SELECT,
    ...(options.transaction ? { transaction: options.transaction } : {}),
  });

  const messageId = Number(rows?.[0]?.id || 0);
  return Number.isInteger(messageId) && messageId > 0 ? { id: messageId } : null;
}

async function getPendingReplyStatesByConversationIds(conversationIds, options = {}) {
  const ids = normalizeConversationIds(conversationIds);
  const states = new Map(ids.map((id) => [id, {
    count: 0,
    unreadCount: 0,
    requiresAutomationAttention: false,
    automationAttentionCount: 0,
    automationAttentionMessageId: null,
    isAutomationResponseProcessing: false,
    automationResponseProcessingMessageId: null,
    automationProcessingStage: null,
    automationProcessingStatus: null,
    automationProcessingStartedAt: null,
    automationProcessingDeadlineAt: null,
    automationActionAppointmentId: null,
    automationActionAppointmentStatus: null,
    automationIntent: null,
    automationPossibleUrgency: false,
    automationNeedsResponse: false,
    automationManualActionRequired: false,
  }]));

  if (!ids.length) {
    return states;
  }

  const userId = Number(options.userId);
  const hasUser = Number.isInteger(userId) && userId > 0;
  const queryOptions = {
    replacements: {
      conversationIds: ids,
      ...(hasUser ? { userId } : {}),
    },
    type: db.Sequelize.QueryTypes.SELECT,
    ...(options.transaction ? { transaction: options.transaction } : {}),
  };

  const pendingRows = await db.sequelize.query(`
    SELECT
      base.conversation_id,
      COUNT(inbound.id) AS pending_count,
      ${hasUser
        ? `SUM(CASE
            WHEN inbound.id IS NOT NULL
             AND (conversation_read.last_read_at IS NULL OR inbound.createdAt > conversation_read.last_read_at)
            THEN 1 ELSE 0 END)`
        : 'COUNT(inbound.id)'} AS unread_count
    FROM (
      SELECT id AS conversation_id
      FROM Conversations
      WHERE id IN (:conversationIds)
    ) base
    LEFT JOIN (
      SELECT conversation_id, MAX(id) AS last_outbound_id
      FROM Messages
      WHERE conversation_id IN (:conversationIds)
        AND direction = 'outbound'
        AND message_type <> 'event'
        AND status <> 'failed'
      GROUP BY conversation_id
    ) last_outbound
      ON last_outbound.conversation_id = base.conversation_id
    ${hasUser ? `LEFT JOIN ConversationReads conversation_read
      ON conversation_read.conversation_id = base.conversation_id
     AND conversation_read.user_id = :userId` : ''}
    LEFT JOIN Messages inbound
      ON inbound.conversation_id = base.conversation_id
     AND inbound.direction = 'inbound'
     AND inbound.message_type <> 'event'
     AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(inbound.metadata, '$.qa_cleanup')), 'false') <> 'true'
     AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(inbound.metadata, '$.hide_from_quickchat')), 'false') <> 'true'
     AND inbound.id > COALESCE(last_outbound.last_outbound_id, 0)
    GROUP BY base.conversation_id
  `, queryOptions);

  pendingRows.forEach((row) => {
    const id = Number(row.conversation_id);
    const state = states.get(id);
    if (state) {
      state.count = Number(row.pending_count || 0);
      state.unreadCount = Number(row.unread_count || 0);
    }
  });

  if (db.Notification) {
    const attentionRows = await db.sequelize.query(`
      SELECT
        CAST(JSON_UNQUOTE(JSON_EXTRACT(notification.data, '$.quickChatConversationId')) AS UNSIGNED) AS conversation_id,
        COUNT(*) AS attention_count,
        MAX(COALESCE(
          CAST(JSON_UNQUOTE(JSON_EXTRACT(notification.data, '$.quickChatResponseMessageId')) AS UNSIGNED),
          CAST(JSON_UNQUOTE(JSON_EXTRACT(execution.context, '$.last_response_context.response_message_id')) AS UNSIGNED)
        ))
          AS response_message_id
      FROM Notifications notification
      LEFT JOIN FlowExecutionsV2 execution
        ON execution.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(notification.data, '$.execution_id')) AS UNSIGNED)
      WHERE notification.event IN ('automation.system_notification', 'automation.persistent_alert')
        AND notification.is_read = 0
        ${hasUser ? 'AND notification.user_id = :userId' : ''}
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(notification.data, '$.quickChatConversationId')) AS UNSIGNED)
          IN (:conversationIds)
      GROUP BY CAST(JSON_UNQUOTE(JSON_EXTRACT(notification.data, '$.quickChatConversationId')) AS UNSIGNED)
    `, queryOptions);

    attentionRows.forEach((row) => {
      const state = states.get(Number(row.conversation_id));
      if (state) {
        state.requiresAutomationAttention = true;
        state.automationAttentionCount = Math.max(1, Number(row.attention_count || 0));
        state.automationAttentionMessageId = Number(row.response_message_id || 0) || null;
      }
    });
  }

  if (db.ConversationAutomationState) {
    const persistedRows = await db.ConversationAutomationState.findAll({
      where: { conversation_id: { [Op.in]: ids } },
      raw: true,
      ...(options.transaction ? { transaction: options.transaction } : {}),
    });
    persistedRows.forEach((row) => {
      const state = states.get(Number(row.conversation_id));
      if (!state) return;
      const serialized = serializeAutomationState(row);
      state.isAutomationResponseProcessing = serialized.processing;
      state.automationResponseProcessingMessageId = serialized.source_message_id;
      state.automationProcessingStage = serialized.stage;
      state.automationProcessingStatus = serialized.status;
      state.automationProcessingStartedAt = serialized.first_message_at;
      state.automationProcessingDeadlineAt = serialized.deadline_at;
      state.automationActionAppointmentId = serialized.appointment_id;
      state.automationActionAppointmentStatus = serialized.appointment_status;
      state.automationIntent = serialized.intent;
      state.automationPossibleUrgency = serialized.possible_urgency;
      state.automationNeedsResponse = serialized.needs_response;
      state.automationManualActionRequired = serialized.manual_action_required;
    });

    const appointmentIds = Array.from(new Set(
      persistedRows
        .map((row) => Number(row.appointment_id))
        .filter((id) => Number.isInteger(id) && id > 0)
    ));
    if (appointmentIds.length && db.CitaPaciente) {
      const appointments = await db.CitaPaciente.findAll({
        where: { id_cita: { [Op.in]: appointmentIds } },
        attributes: ['id_cita', 'estado'],
        raw: true,
        ...(options.transaction ? { transaction: options.transaction } : {}),
      });
      const statuses = new Map(appointments.map((appointment) => [
        Number(appointment.id_cita),
        String(appointment.estado || '').trim() || null,
      ]));
      persistedRows.forEach((row) => {
        const state = states.get(Number(row.conversation_id));
        const currentStatus = statuses.get(Number(row.appointment_id));
        if (state && currentStatus) {
          state.automationActionAppointmentStatus = currentStatus;
        }
      });
    }
  }

  return states;
}

function emitAutomationResponseProcessing({ clinicId, conversationId, responseMessageId, processing }) {
  const numericClinicId = Number(clinicId);
  const numericConversationId = Number(conversationId);
  const numericResponseMessageId = Number(responseMessageId);
  if (
    !Number.isInteger(numericClinicId)
    || numericClinicId <= 0
    || !Number.isInteger(numericConversationId)
    || numericConversationId <= 0
  ) {
    return false;
  }

  const io = getIO();
  if (!io) return false;

  io.to(`clinic:${numericClinicId}`).emit('conversation:updated', {
    id: String(numericConversationId),
    automation_response_processing: processing === true,
    automation_response_processing_message_id: processing === true
      && Number.isInteger(numericResponseMessageId)
      && numericResponseMessageId > 0
      ? numericResponseMessageId
      : null,
  });
  return true;
}

async function resolveAutomationAttentionForConversation(conversationId, userId, options = {}) {
  const numericConversationId = Number(conversationId);
  const numericUserId = Number(userId);
  const allUsers = options.allUsers === true;
  if (
    !Number.isInteger(numericConversationId)
    || numericConversationId <= 0
    || (!allUsers && (!Number.isInteger(numericUserId) || numericUserId <= 0))
    || !db.Notification
  ) {
    return { success: false, updated: 0, reason: 'invalid_scope' };
  }

  const where = {
    event: { [Op.in]: ['automation.system_notification', 'automation.persistent_alert'] },
    isRead: false,
    ...(!allUsers ? { userId: numericUserId } : {}),
    [Op.and]: [
      db.sequelize.where(
        db.sequelize.literal("CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.quickChatConversationId')) AS UNSIGNED)"),
        numericConversationId
      ),
    ],
  };
  const queryOptions = options.transaction ? { transaction: options.transaction } : {};
  const notifications = await db.Notification.findAll({ where, ...queryOptions });
  if (!notifications.length) {
    return { success: true, updated: 0 };
  }

  const now = new Date();
  const reason = String(options.reason || 'operator_action_completed');
  for (const notification of notifications) {
    const currentData = notification.get('data');
    const data = currentData && typeof currentData === 'object' ? { ...currentData } : {};
    await notification.update({
      isRead: true,
      readAt: now,
      data: {
        ...data,
        manual_resolution_reason: reason,
        manual_resolved_at: now.toISOString(),
        manual_resolved_by_user_id: Number.isInteger(numericUserId) && numericUserId > 0
          ? numericUserId
          : null,
      },
    }, queryOptions);
    emitNotificationUpdated(notification);
  }

  return { success: true, updated: notifications.length };
}

async function completeAnsweredAutomationStateForConversation(conversationId, options = {}) {
  const numericConversationId = Number(conversationId);
  if (!Number.isInteger(numericConversationId) || numericConversationId <= 0 || !db.ConversationAutomationState) {
    return { completed: false, reason: 'invalid_scope' };
  }
  const state = await db.ConversationAutomationState.findOne({
    where: { conversation_id: numericConversationId },
    ...(options.transaction ? { transaction: options.transaction } : {}),
  });
  if (!state) return { completed: false, reason: 'state_not_found' };

  const serialized = serializeAutomationState(state);
  const intent = String(serialized.intent || '').trim().toLowerCase();
  const appointmentStatus = String(serialized.appointment_status || '').trim().toLowerCase();
  const resolvedAppointmentStates = new Set([
    'recordatorio_confirmado',
    'confirmada',
    'confirmado',
    'info_confirmada',
    'cancelada',
  ]);
  const canComplete = serialized.status === 'review'
    && serialized.manual_action_required === true
    && serialized.needs_response === true
    && serialized.possible_urgency !== true
    && ['confirmar_cita', 'cancelar_cita', 'pregunta'].includes(intent)
    && resolvedAppointmentStates.has(appointmentStatus);
  if (!canComplete) return { completed: false, reason: 'operator_action_still_required' };

  const ownership = serialized.execution_id
    ? { expectedExecutionId: serialized.execution_id }
    : (serialized.job_request_id ? { expectedJobRequestId: serialized.job_request_id } : {});
  const completed = await conversationAutomationState.completeState({
    clinicId: state.clinic_id,
    conversationId: numericConversationId,
  }, {
    ...(options.transaction ? { transaction: options.transaction } : {}),
    ...(options.emit === false ? { emit: false } : {}),
    ...ownership,
  });
  return { completed: !!completed, reason: completed ? null : 'state_changed' };
}

async function completeManualAutomationStateForConversation(conversationId, options = {}) {
  const numericConversationId = Number(conversationId);
  if (!Number.isInteger(numericConversationId) || numericConversationId <= 0 || !db.ConversationAutomationState) {
    return { completed: false, reason: 'invalid_scope' };
  }
  const state = await db.ConversationAutomationState.findOne({
    where: { conversation_id: numericConversationId },
    ...(options.transaction ? { transaction: options.transaction } : {}),
  });
  if (!state) return { completed: false, reason: 'state_not_found' };
  const serialized = serializeAutomationState(state);
  if (!serialized.manual_action_required || !['review', 'failed'].includes(serialized.status)) {
    return { completed: false, reason: 'manual_action_not_pending' };
  }

  const ownership = serialized.execution_id
    ? { expectedExecutionId: serialized.execution_id }
    : (serialized.job_request_id ? { expectedJobRequestId: serialized.job_request_id } : {});
  const completed = await conversationAutomationState.completeState({
    clinicId: state.clinic_id,
    conversationId: numericConversationId,
  }, {
    ...(options.transaction ? { transaction: options.transaction } : {}),
    ...(options.emit === false ? { emit: false } : {}),
    ...ownership,
  });
  return { completed: !!completed, reason: completed ? null : 'state_changed' };
}

module.exports = {
  completeAnsweredAutomationStateForConversation,
  completeManualAutomationStateForConversation,
  emitAutomationResponseProcessing,
  findHumanReplyAfterMessage,
  getPendingReplyStatesByConversationIds,
  normalizeConversationIds,
  resolveAutomationAttentionForConversation,
};
