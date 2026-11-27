'use strict';

const { marketingOrigins, resolveLeadMarketingOrigin } = require('../lib/lead-attribution-view');

const attributionFields = [
  'source', 'channel', 'external_source', 'utm_source', 'utm_medium', 'gclid',
  'gbraid', 'wbraid', 'google_ads_customer_id', 'google_ads_campaign_id', 'fbclid', 'ttclid',
];

function validOrigins(origins) {
  return Array.isArray(origins) && origins.length > 0 && origins.length <= marketingOrigins.length &&
    new Set(origins).size === origins.length && origins.every(value => marketingOrigins.includes(value));
}

// A paid comment can start an exchange with someone who already has a lead
// from another source. Only a delivered private reply in this session carries
// that context forward. A more recent comment establishes a new context.
async function followsPaidComment(db, rule, thread, entry, transaction, templateId) {
  if (entry.channel !== 'instagram' || entry.type !== 'dm' || !rule.origins.includes('meta_ads') ||
      !Number.isSafeInteger(entry.messageId) || !Number.isSafeInteger(templateId)) return false;
  const session = await db.LeadAssistantSession.findOne({
    where: { conversation_id: thread.id, clinic_id: thread.clinic_id, template_id: templateId, publication_version: rule.version },
    attributes: ['state', 'origin_message_id'], raw: true, transaction,
  });
  if (!session || session.state === 'operator') return false;
  if (session.state !== 'active') {
    // A committed handoff may still need to deliver the acknowledgement for
    // this exact inbound turn. New messages in a closed session stay with staff.
    const current = await db.Message.findOne({
      where: { id: entry.messageId, conversation_id: thread.id, direction: 'inbound',
        'metadata.assistantHandoffReply.state': session.state, 'metadata.leadAssistantTurn.templateId': templateId,
        'metadata.leadAssistantTurn.publicationVersion': rule.version },
      attributes: ['id'], raw: true, transaction,
    });
    if (!current) return false;
  }
  const { Op } = db.Sequelize;
  const comment = await db.Message.findOne({
    where: { conversation_id: thread.id, direction: 'inbound',
      id: { [Op.gte]: session.origin_message_id, [Op.lt]: entry.messageId },
      'metadata.social.type': 'comment', 'metadata.social.source': 'new' },
    attributes: ['id', 'metadata'], order: [['id', 'DESC']], raw: true, transaction,
  });
  const data = comment?.metadata;
  if (!data?.social?.ad || !data.privateAttempt || data.social.accountId !== entry.accountId ||
      data.social.senderId !== entry.senderId || data.leadAssistantTurn?.templateId !== templateId ||
      data.leadAssistantTurn.publicationVersion !== rule.version) return false;
  const delivered = await db.Message.findOne({
    where: { conversation_id: thread.id, direction: 'outbound',
      id: { [Op.gt]: comment.id, [Op.lt]: entry.messageId }, status: { [Op.in]: ['sent','delivered','read'] },
      'metadata.socialAttempt': data.privateAttempt, 'metadata.source': 'automations_v2',
      'metadata.execution_id': data.leadAssistantTurn.executionId, 'metadata.commentId': data.social.commentId },
    attributes: ['id','metadata'], raw: true, transaction,
  });
  if (!delivered) return false;
  if (!entry.replyTo || entry.replyTo === delivered.metadata.providerId) return true;
  // An explicit quotation of an older or human message has its own context.
  const quoted = await db.Message.findOne({
    where: { conversation_id: thread.id, direction: 'outbound',
      id: { [Op.gt]: delivered.id, [Op.lt]: entry.messageId }, status: { [Op.in]: ['sent','delivered','read'] },
      'metadata.providerId': entry.replyTo, 'metadata.source': 'automations_v2' },
    attributes: ['metadata'], raw: true, transaction,
  });
  if (!quoted?.metadata.execution_id) return false;
  return !!(await db.Message.count({ where: { conversation_id: thread.id, direction: 'inbound',
    id: { [Op.gt]: comment.id, [Op.lt]: entry.messageId }, 'metadata.leadAssistantTurn.templateId': templateId,
    'metadata.leadAssistantTurn.publicationVersion': rule.version,
    'metadata.leadAssistantTurn.executionId': quoted.metadata.execution_id }, transaction }));
}

async function acceptsOrigin(db, rule, thread, entry, transaction, templateId) {
  if (rule.origins === undefined) return true;
  if (!validOrigins(rule.origins)) return false;
  if (entry.ad) return rule.origins.includes('meta_ads');
  const localThread = await db.Conversation.findOne({
    where: { id: thread.id, clinic_id: thread.clinic_id }, attributes: ['lead_id'], raw: true, transaction,
  });
  if (!localThread) return false;
  if (!localThread.lead_id) return rule.origins.includes(entry.channel === 'whatsapp' ? 'whatsapp' : 'social_inbox');
  const lead = await db.LeadIntake.findOne({
    where: { id: localThread.lead_id, clinica_id: thread.clinic_id, archived_at: null },
    attributes: attributionFields, raw: true, transaction,
  });
  if (!lead) return false;
  if (rule.origins.includes(resolveLeadMarketingOrigin(lead))) return true;
  return followsPaidComment(db, rule, thread, entry, transaction, templateId);
}

module.exports = { validOrigins, acceptsOrigin };
