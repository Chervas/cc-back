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
  const ordinaryActivity = 'COALESCE(Conversation.last_message_at, Conversation.createdAt)';
  const directActivity = `WHEN EXISTS (SELECT 1 ${direct} ${bulk}) THEN (${lastActivity(direct)})`;
  // Most WhatsApp conversations have no aliases. Only canonical chats with
  // another physical history need the union across both sets of messages.
  const mergedActivity = linkedHistory ? `
    WHEN (Conversation.id, Conversation.clinic_id) IN (
      SELECT canonical_id, clinic_id FROM WhatsappConversationLinks WHERE canonical_id <> conversation_id
    ) THEN CASE WHEN EXISTS (SELECT 1 ${direct} ${bulk}) OR EXISTS (SELECT 1 ${linked} ${bulk})
      THEN (SELECT MAX(activity_at) FROM LATERAL (${lastActivity(direct)} UNION ALL ${lastActivity(linked)}) qa)
      ELSE ${ordinaryActivity} END` : '';
  return `CASE WHEN Conversation.channel <> 'whatsapp' THEN ${ordinaryActivity}
    ${mergedActivity}
    ${directActivity} ELSE ${ordinaryActivity} END`;
}

// A partial read can only narrow the already authorized list.
function parseChangedConversationIds(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > 850) return null;
  const parts = value.split(',');
  if (parts.length > 50 || !parts.every(id => /^[1-9][0-9]*$/.test(id) && Number.isSafeInteger(Number(id)))) return null;
  return [...new Set(parts.map(Number))];
}

function isBulkOutbound(message) {
  return message?.direction === 'outbound' && (message.metadata?.source === 'marketing_bulk_sends'
    || message.metadata?.communication_purpose === 'review_request');
}

module.exports = { bulkOutboundSql, quickChatActivitySql, isBulkOutbound, parseChangedConversationIds };
