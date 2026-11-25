'use strict';

function bulkOutboundSql(alias) {
  const field = key => `COALESCE(JSON_UNQUOTE(JSON_EXTRACT(${alias}.metadata, '$.${key}')), '')`;
  return `(${alias}.direction = 'outbound' AND (${field('source')} = 'marketing_bulk_sends'
    OR ${field('communication_purpose')} = 'review_request'))`;
}

function quickChatActivitySql({ linkedHistory = false } = {}) {
  const direct = 'FROM Messages qm WHERE qm.conversation_id = Conversation.id';
  const linked = `FROM WhatsappConversationLinks qcl JOIN Messages qm ON qm.conversation_id = qcl.conversation_id
    WHERE qcl.canonical_id = Conversation.id AND qcl.clinic_id = Conversation.clinic_id
      AND qcl.conversation_id <> Conversation.id`;
  const bulk = `AND ${bulkOutboundSql('qm')}`;
  const lastActivity = from => `SELECT MAX(COALESCE(qm.sent_at, qm.createdAt)) activity_at ${from}
    AND NOT ${bulkOutboundSql('qm')} AND qm.message_type <> 'event'
    AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(qm.metadata, '$.qa_cleanup')), '') <> 'true'
    AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(qm.metadata, '$.hide_from_quickchat')), '') <> 'true'`;
  const activeAt = linkedHistory
    ? `SELECT MAX(activity_at) FROM LATERAL (${lastActivity(direct)} UNION ALL ${lastActivity(linked)}) qa`
    : lastActivity(direct);
  const ordinaryActivity = 'COALESCE(Conversation.last_message_at, Conversation.createdAt)';
  return `CASE WHEN Conversation.channel <> 'whatsapp' THEN ${ordinaryActivity}
    WHEN NOT EXISTS (SELECT 1 ${direct} ${bulk})
      ${linkedHistory ? `AND NOT EXISTS (SELECT 1 ${linked} ${bulk})` : ''} THEN ${ordinaryActivity}
    ELSE (${activeAt}) END`;
}

function isBulkOutbound(message) {
  return message?.direction === 'outbound' && (message.metadata?.source === 'marketing_bulk_sends'
    || message.metadata?.communication_purpose === 'review_request');
}

module.exports = { bulkOutboundSql, quickChatActivitySql, isBulkOutbound };
