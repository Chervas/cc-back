'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const { emitNotificationUpdated } = require('./notificationsRealtime.service');

function normalizeConversationIds(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0)
  ));
}

async function getPendingReplyStatesByConversationIds(conversationIds, options = {}) {
  const ids = normalizeConversationIds(conversationIds);
  const states = new Map(ids.map((id) => [id, {
    count: 0,
    unreadCount: 0,
    requiresAutomationAttention: false,
    automationAttentionCount: 0,
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
        CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.quickChatConversationId')) AS UNSIGNED) AS conversation_id,
        COUNT(*) AS attention_count
      FROM Notifications
      WHERE event = 'automation.system_notification'
        AND is_read = 0
        ${hasUser ? 'AND user_id = :userId' : ''}
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.quickChatConversationId')) AS UNSIGNED)
          IN (:conversationIds)
      GROUP BY CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.quickChatConversationId')) AS UNSIGNED)
    `, queryOptions);

    attentionRows.forEach((row) => {
      const state = states.get(Number(row.conversation_id));
      if (state) {
        state.requiresAutomationAttention = true;
        state.automationAttentionCount = Math.max(1, Number(row.attention_count || 0));
      }
    });
  }

  return states;
}

async function resolveAutomationAttentionForConversation(conversationId, userId, options = {}) {
  const numericConversationId = Number(conversationId);
  const numericUserId = Number(userId);
  if (
    !Number.isInteger(numericConversationId)
    || numericConversationId <= 0
    || !Number.isInteger(numericUserId)
    || numericUserId <= 0
    || !db.Notification
  ) {
    return { success: false, updated: 0, reason: 'invalid_scope' };
  }

  const where = {
    event: 'automation.system_notification',
    userId: numericUserId,
    isRead: false,
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
        manual_resolved_by_user_id: numericUserId,
      },
    }, queryOptions);
    emitNotificationUpdated(notification);
  }

  return { success: true, updated: notifications.length };
}

module.exports = {
  getPendingReplyStatesByConversationIds,
  normalizeConversationIds,
  resolveAutomationAttentionForConversation,
};
