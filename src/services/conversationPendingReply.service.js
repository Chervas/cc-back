'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const { getIO } = require('./socket.service');
const { emitNotificationUpdated } = require('./notificationsRealtime.service');

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
      WHERE notification.event = 'automation.system_notification'
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

  const processingRows = await db.sequelize.query(`
    SELECT
      CAST(JSON_UNQUOTE(JSON_EXTRACT(execution.context, '$.conversation.id')) AS UNSIGNED) AS conversation_id,
      MAX(CASE
        WHEN execution.status = 'running'
          THEN CAST(JSON_UNQUOTE(JSON_EXTRACT(execution.context, '$.last_response_context.response_message_id')) AS UNSIGNED)
        ELSE CAST(JSON_UNQUOTE(JSON_EXTRACT(execution.waiting_meta, '$.last_inbound_message_id')) AS UNSIGNED)
      END) AS response_message_id
    FROM FlowExecutionsV2 execution
    WHERE execution.updated_at >= DATE_SUB(UTC_TIMESTAMP(), INTERVAL 15 MINUTE)
      AND (
        (
          execution.status = 'running'
          AND CAST(JSON_UNQUOTE(JSON_EXTRACT(execution.context, '$.last_response_context.response_message_id')) AS UNSIGNED) IS NOT NULL
        )
        OR (
          execution.status = 'waiting'
          AND JSON_UNQUOTE(JSON_EXTRACT(execution.waiting_meta, '$.resume_mode')) = 'response'
          AND CAST(JSON_UNQUOTE(JSON_EXTRACT(execution.waiting_meta, '$.last_inbound_message_id')) AS UNSIGNED) IS NOT NULL
        )
      )
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(execution.context, '$.conversation.id')) AS UNSIGNED)
        IN (:conversationIds)
    GROUP BY CAST(JSON_UNQUOTE(JSON_EXTRACT(execution.context, '$.conversation.id')) AS UNSIGNED)
  `, queryOptions);

  processingRows.forEach((row) => {
    const state = states.get(Number(row.conversation_id));
    if (state) {
      state.isAutomationResponseProcessing = true;
      state.automationResponseProcessingMessageId = Number(row.response_message_id || 0) || null;
    }
  });

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
    event: 'automation.system_notification',
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

module.exports = {
  emitAutomationResponseProcessing,
  findHumanReplyAfterMessage,
  getPendingReplyStatesByConversationIds,
  normalizeConversationIds,
  resolveAutomationAttentionForConversation,
};
