'use strict';

const positiveId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const uniqueIds = values => [...new Set((Array.isArray(values) ? values : [values]).filter(positiveId).map(Number))];

/** Read-only, personal unread evidence for appointment cards. A reply is not a
 * read receipt: pending-response/automation attention remain separate signals.
 * The caller supplies the already-authorized appointment clinics; conversation
 * IDs alone must not permit reading a different clinic or a non-WhatsApp chat.
 */
async function appointmentConversationUnreadCounts({ db, conversationIds, userId, clinicIds }) {
  const ids = uniqueIds(conversationIds);
  const clinics = uniqueIds(clinicIds);
  const counts = new Map(ids.map(id => [id, 0]));
  if (!ids.length || !clinics.length || !positiveId(userId)) return counts;

  const rows = await db.sequelize.query(`
    SELECT base.id AS conversation_id, COUNT(inbound.id) AS unread_count
    FROM Conversations base
    LEFT JOIN ConversationReads conversation_read
      ON conversation_read.conversation_id = base.id
     AND conversation_read.user_id = :userId
    LEFT JOIN Messages inbound
      ON inbound.conversation_id = base.id
     AND inbound.direction = 'inbound'
     AND inbound.message_type <> 'event'
     AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(inbound.metadata, '$.qa_cleanup')), 'false') <> 'true'
     AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(inbound.metadata, '$.hide_from_quickchat')), 'false') <> 'true'
     AND (conversation_read.last_read_at IS NULL OR inbound.createdAt > conversation_read.last_read_at)
    WHERE base.id IN (:conversationIds)
      AND base.clinic_id IN (:clinicIds)
      AND base.channel = 'whatsapp'
    GROUP BY base.id
  `, {
    replacements: { conversationIds: ids, clinicIds: clinics, userId: Number(userId) },
    type: db.Sequelize.QueryTypes.SELECT,
  });
  for (const row of rows) {
    const id = Number(row.conversation_id), count = Number(row.unread_count);
    if (counts.has(id) && Number.isSafeInteger(count) && count >= 0) counts.set(id, count);
  }
  return counts;
}

module.exports = { appointmentConversationUnreadCounts };
