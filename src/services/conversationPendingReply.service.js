'use strict';

const db = require('../../models');

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
    requiresAutomationAttention: false,
  }]));

  if (!ids.length) {
    return states;
  }

  const queryOptions = {
    replacements: { conversationIds: ids },
    type: db.Sequelize.QueryTypes.SELECT,
    ...(options.transaction ? { transaction: options.transaction } : {}),
  };

  const pendingRows = await db.sequelize.query(`
    SELECT
      base.conversation_id,
      COUNT(inbound.id) AS pending_count
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
    }
  });

  if (db.Notification) {
    const attentionRows = await db.sequelize.query(`
      SELECT DISTINCT
        CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.quickChatConversationId')) AS UNSIGNED) AS conversation_id
      FROM Notifications
      WHERE event = 'automation.system_notification'
        AND is_read = 0
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.quickChatConversationId')) AS UNSIGNED)
          IN (:conversationIds)
    `, queryOptions);

    attentionRows.forEach((row) => {
      const state = states.get(Number(row.conversation_id));
      if (state) {
        state.requiresAutomationAttention = true;
      }
    });
  }

  return states;
}

module.exports = {
  getPendingReplyStatesByConversationIds,
  normalizeConversationIds,
};
