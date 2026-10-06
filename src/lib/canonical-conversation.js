'use strict';

const db = require('../../models');
const whatsappService = require('../services/whatsapp.service');
const { getPhoneIdentityCandidates, normalizePhoneE164 } = require('./phone');

const { Op } = db.Sequelize;
const { Conversation, Message, ConversationRead, WhatsAppWebOrigin } = db;

function normalizeContactCandidates(raw) {
  return getPhoneIdentityCandidates(raw, {
    defaultCountryCode: String(
      process.env.META_WHATSAPP_DEFAULT_COUNTRY_CODE || '+34'
    ).replace(/\D/g, '') || '34',
  });
}

function compareDatesDesc(left, right) {
  const leftTs = left ? new Date(left).getTime() : 0;
  const rightTs = right ? new Date(right).getTime() : 0;
  return rightTs - leftTs;
}

function scoreConversation(conversation, { patientId = null, leadId = null } = {}) {
  let score = 0;
  if (patientId && Number(conversation.patient_id) === Number(patientId)) score += 100;
  else if (conversation.patient_id) score += 20;
  if (leadId && Number(conversation.lead_id) === Number(leadId)) score += 60;
  else if (conversation.lead_id) score += 10;
  if (conversation.last_inbound_at) score += 8;
  if (conversation.last_message_at) score += 4;
  if (conversation.assignee_id) score += 2;
  return score;
}

async function mergeDuplicateConversations(canonical, duplicates, { transaction = null } = {}) {
  if (!canonical || !duplicates?.length) {
    return canonical;
  }

  const duplicateIds = duplicates
    .map((item) => Number(item.id))
    .filter((id) => Number.isInteger(id) && id > 0 && id !== Number(canonical.id));

  if (!duplicateIds.length) {
    return canonical;
  }

  if (!transaction) {
    return db.sequelize.transaction(owned =>
      mergeDuplicateConversations(canonical, duplicates, { transaction: owned }));
  }

  const locked = await Conversation.findAll({
    where: { id: { [Op.in]: [Number(canonical.id), ...duplicateIds] } },
    order: [['id', 'ASC']], transaction, lock: transaction.LOCK.UPDATE,
  });
  const target = locked.find(row => Number(row.id) === Number(canonical.id));
  if (!target || locked.length !== duplicateIds.length + 1
    || locked.some(row => row.channel !== 'whatsapp'
      || Number(row.clinic_id) !== Number(target.clinic_id)
      || !normalizePhoneE164(row.contact_id)
      || normalizePhoneE164(row.contact_id) !== normalizePhoneE164(target.contact_id))
    || new Set(locked.map(row => Number(row.patient_id)).filter(Boolean)).size > 1) {
    throw Object.assign(new Error('No se pueden fusionar conversaciones con identidades diferentes.'),
      { code: 'whatsapp_contact_identity_conflict', status: 409 });
  }
  // Use the locked rows, not instances cached before a rollback or new message.
  canonical = target;
  duplicates = locked.filter(row => Number(row.id) !== Number(target.id));

  // Import bindings must follow the surviving chat in the same transaction.
  const [tables] = await db.sequelize.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='WhatsappInboxContactKeys'",
    { transaction });
  if (tables.length) {
    await db.sequelize.query(
      'UPDATE WhatsappInboxContactKeys SET conversation_id=:canonicalId WHERE conversation_id IN (:duplicateIds)',
      { replacements: { canonicalId: Number(canonical.id), duplicateIds }, transaction });
  }
  const [routingTables] = await db.sequelize.query(
    "SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='WhatsappInboxRoutingReviews'",
    { transaction });
  if (routingTables.length) {
    const [reviews] = await db.sequelize.query('SELECT id,candidates,selected_conversation_id FROM WhatsappInboxRoutingReviews WHERE '
      + duplicateIds.map(id => `JSON_CONTAINS(candidates,JSON_OBJECT('conversationId',${Number(id)}))`).join(' OR ') + ' FOR UPDATE', { transaction });
    for (const review of reviews) {
      const candidates = typeof review.candidates === 'string' ? JSON.parse(review.candidates) : review.candidates;
      const mapped = [...new Map(candidates.map(candidate => {
        const value = duplicateIds.includes(candidate.conversationId) ? { ...candidate, conversationId: Number(canonical.id) } : candidate;
        return [value.conversationId, value];
      })).values()].sort((a,b) => a.clinicId-b.clinicId || a.conversationId-b.conversationId);
      await db.sequelize.query('UPDATE WhatsappInboxRoutingReviews SET candidates=:candidates,selected_conversation_id=:selected,revision=revision+1 WHERE id=:id',
        { replacements: { candidates: JSON.stringify(mapped), selected: duplicateIds.includes(review.selected_conversation_id)
          ? Number(canonical.id) : review.selected_conversation_id, id: review.id }, transaction });
    }
  }

  await Message.update(
    { conversation_id: canonical.id },
    { where: { conversation_id: { [Op.in]: duplicateIds } }, transaction }
  );

  const duplicateReads = await ConversationRead.findAll({
    where: { conversation_id: { [Op.in]: duplicateIds } },
    raw: true,
    transaction,
  });

  const canonicalReads = await ConversationRead.findAll({
    where: { conversation_id: canonical.id },
    raw: true,
    transaction,
  });

  const readByUser = new Map();
  for (const row of [...canonicalReads, ...duplicateReads]) {
    const userId = Number(row.user_id);
    if (!Number.isInteger(userId) || userId <= 0) continue;
    const current = readByUser.get(userId);
    const currentTs = current?.last_read_at ? new Date(current.last_read_at).getTime() : 0;
    const rowTs = row.last_read_at ? new Date(row.last_read_at).getTime() : 0;
    if (!current || rowTs > currentTs) {
      readByUser.set(userId, row);
    }
  }

  if (duplicateReads.length) {
    await ConversationRead.destroy({
      where: { conversation_id: { [Op.in]: duplicateIds } },
      transaction,
    });
  }

  for (const [userId, row] of readByUser.entries()) {
    const existing = canonicalReads.find((item) => Number(item.user_id) === userId);
    if (existing) {
      await ConversationRead.update(
        { last_read_at: row.last_read_at || existing.last_read_at || new Date() },
        { where: { conversation_id: canonical.id, user_id: userId }, transaction }
      );
    } else {
      await ConversationRead.create({
        conversation_id: canonical.id,
        user_id: userId,
        last_read_at: row.last_read_at || new Date(),
      }, { transaction });
    }
  }

  if (WhatsAppWebOrigin) {
    await WhatsAppWebOrigin.update(
      { used_conversation_id: canonical.id },
      { where: { used_conversation_id: { [Op.in]: duplicateIds } }, transaction }
    );
  }

  const mergedUnread = [canonical, ...duplicates].reduce((sum, item) => {
    const value = Number(item.unread_count || 0);
    return sum + (Number.isFinite(value) ? value : 0);
  }, 0);

  const latestMessageAt = [canonical, ...duplicates]
    .map((item) => item.last_message_at)
    .filter(Boolean)
    .sort((a, b) => compareDatesDesc(a, b))[0] || canonical.last_message_at || null;

  const latestInboundAt = [canonical, ...duplicates]
    .map((item) => item.last_inbound_at)
    .filter(Boolean)
    .sort((a, b) => compareDatesDesc(a, b))[0] || canonical.last_inbound_at || null;

  const patch = {};
  if (!canonical.patient_id) {
    const matchedPatient = duplicates.find((item) => item.patient_id);
    if (matchedPatient?.patient_id) patch.patient_id = matchedPatient.patient_id;
  }
  if (!canonical.lead_id) {
    const matchedLead = duplicates.find((item) => item.lead_id);
    if (matchedLead?.lead_id) patch.lead_id = matchedLead.lead_id;
  }
  if (!canonical.assignee_id) {
    const matchedAssignee = duplicates.find((item) => item.assignee_id);
    if (matchedAssignee?.assignee_id) patch.assignee_id = matchedAssignee.assignee_id;
  }
  if (mergedUnread !== Number(canonical.unread_count || 0)) {
    patch.unread_count = mergedUnread;
  }
  if (latestMessageAt && String(latestMessageAt) !== String(canonical.last_message_at || '')) {
    patch.last_message_at = latestMessageAt;
  }
  if (latestInboundAt && String(latestInboundAt) !== String(canonical.last_inbound_at || '')) {
    patch.last_inbound_at = latestInboundAt;
  }

  if (Object.keys(patch).length) {
    await canonical.update(patch, { transaction });
  }

  await Conversation.destroy({
    where: { id: { [Op.in]: duplicateIds } },
    transaction,
  });

  if (Object.keys(patch).length) {
    Object.assign(canonical, patch);
  }

  return canonical;
}

async function findCanonicalWhatsappConversation({
  clinicId,
  contactId,
  patientId = null,
  leadId = null,
  createIfMissing = false,
  requireExactContact = false,
  lastMessageAt = null,
  transaction = null,
} = {}) {
  const normalizedClinicId = Number(clinicId);
  if (!Number.isInteger(normalizedClinicId) || normalizedClinicId <= 0) {
    return null;
  }

  const contactCandidates = normalizeContactCandidates(contactId);
  const where = {
    clinic_id: normalizedClinicId,
    channel: 'whatsapp',
  };

  const contactOr = [];
  if (contactCandidates.length) {
    contactOr.push({ contact_id: { [Op.in]: contactCandidates } });
  }
  if (patientId) {
    contactOr.push({ patient_id: patientId });
  }
  if (leadId) {
    contactOr.push({ lead_id: leadId });
  }

  if (contactOr.length) {
    where[Op.or] = contactOr;
  } else {
    return null;
  }

  const conversations = await Conversation.findAll({
    where,
    order: [
      ['last_message_at', 'DESC'],
      ['updatedAt', 'DESC'],
      ['id', 'DESC'],
    ],
    transaction,
  });

  if (!conversations.length) {
    if (!createIfMissing || !contactCandidates.length) {
      return null;
    }
    return Conversation.create({
      clinic_id: normalizedClinicId,
      channel: 'whatsapp',
      contact_id: contactCandidates[0],
      patient_id: patientId || null,
      lead_id: leadId || null,
      unread_count: 0,
      last_message_at: lastMessageAt || new Date(),
    }, { transaction });
  }

  const requestedPhone = normalizePhoneE164(contactId);
  const exact = conversations.filter(c => normalizePhoneE164(c.contact_id) === requestedPhone);
  // Looking up a patient's existing chat must not change its destination or
  // merge a second number into it. Different numbers remain separate records.
  if (requireExactContact && !exact.length) {
    throw Object.assign(new Error('El teléfono de destino no coincide con la conversación. Revisa la ficha antes de enviar.'),
      { code: 'whatsapp_contact_identity_conflict', status: 409 });
  }
  const candidates = exact.length ? exact : conversations;
  const owners = new Set(candidates.map(c => Number(c.patient_id)).filter(Boolean));
  if (owners.size > 1 || candidates.some(c => patientId && c.patient_id && Number(c.patient_id) !== Number(patientId))) {
    throw Object.assign(new Error('Este WhatsApp está vinculado a otro paciente. Revisa las fichas antes de continuar.'),
      { code: 'whatsapp_contact_identity_conflict', status: 409 });
  }
  const sorted = [...candidates].sort((left, right) => {
    const scoreDiff = scoreConversation(right, { patientId, leadId }) - scoreConversation(left, { patientId, leadId });
    if (scoreDiff !== 0) return scoreDiff;
    const messageDiff = compareDatesDesc(left.last_message_at, right.last_message_at);
    if (messageDiff !== 0) return messageDiff;
    return Number(left.id) - Number(right.id);
  });

  let canonical = sorted[0];
  const duplicates = exact.length ? sorted.slice(1) : [];

  const patch = {};
  if (exact.length && contactCandidates[0] && canonical.contact_id !== contactCandidates[0]) {
    patch.contact_id = contactCandidates[0];
  }
  // Attach an unowned conversation, but never replace another patient's owner.
  if (patientId && Number(canonical.patient_id || 0) !== Number(patientId)) {
    patch.patient_id = patientId;
  }
  if (leadId && Number(canonical.lead_id || 0) !== Number(leadId)) {
    patch.lead_id = leadId;
  }
  if (lastMessageAt && (!canonical.last_message_at || new Date(lastMessageAt).getTime() > new Date(canonical.last_message_at).getTime())) {
    patch.last_message_at = lastMessageAt;
  }
  if (Object.keys(patch).length) {
    await canonical.update(patch, { transaction });
    Object.assign(canonical, patch);
  }

  if (duplicates.length) {
    canonical = await mergeDuplicateConversations(canonical, duplicates, { transaction });
  }

  return canonical;
}

module.exports = {
  normalizeContactCandidates,
  findCanonicalWhatsappConversation,
  mergeDuplicateConversations,
};
