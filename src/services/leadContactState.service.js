'use strict';

const db = require('../../models');
const { getPhoneLookupCandidates } = require('../lib/phone');

const { Op } = db.Sequelize;
const TERMINAL_LEAD_STATUSES = new Set(['citado', 'acudio_cita', 'convertido', 'descartado']);
const SUPPRESSING_CALL_OUTCOMES = new Set(['citado', 'informacion']);
const NON_EFFECTIVE_CALL_REASONS = new Set(['no_contesta', 'no_contactado', 'sin_respuesta']);

function cleanString(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function isEffectiveContactAttempt(attempt) {
  const channel = cleanString(attempt?.canal).toLowerCase();
  const reason = cleanString(attempt?.motivo).toLowerCase();
  if (channel === 'llamada') return !NON_EFFECTIVE_CALL_REASONS.has(reason);
  return ['whatsapp', 'email', 'dm', 'otro'].includes(channel);
}

async function evaluatePendingLeadContact({ leadId, triggeredAt, models = db }) {
  const lead = await models.LeadIntake.findByPk(leadId, {
    attributes: [
      'id', 'clinica_id', 'telefono', 'status_lead', 'call_outcome', 'call_outcome_at',
      'archived_at', 'created_at',
    ],
    raw: true,
  });
  if (!lead || lead.archived_at) return { decision: false, reason: 'lead_not_available' };
  const status = cleanString(lead.status_lead).toLowerCase();
  if (TERMINAL_LEAD_STATUSES.has(status)) return { decision: false, reason: `lead_status_${status}` };
  const callOutcome = cleanString(lead.call_outcome).toLowerCase();
  if (SUPPRESSING_CALL_OUTCOMES.has(callOutcome)) return { decision: false, reason: `call_outcome_${callOutcome}` };

  const sinceRaw = lead.created_at || triggeredAt;
  const since = sinceRaw ? new Date(sinceRaw) : new Date(0);
  const attempts = await models.LeadContactAttempt.findAll({
    where: {
      lead_intake_id: leadId,
      created_at: { [Op.gte]: Number.isFinite(since.getTime()) ? since : new Date(0) },
    },
    order: [['created_at', 'ASC']],
    raw: true,
  });
  const effectiveAttempt = attempts.find(isEffectiveContactAttempt);
  if (effectiveAttempt) {
    return { decision: false, reason: 'manual_contact_registered', contact_attempt_id: effectiveAttempt.id };
  }

  if (models.Conversation && models.Message) {
    const phoneCandidates = getPhoneLookupCandidates(lead.telefono);
    const conversations = await models.Conversation.findAll({
      where: {
        ...(lead.clinica_id ? { clinic_id: lead.clinica_id } : {}),
        [Op.or]: [
          { lead_id: leadId },
          ...(phoneCandidates.length ? [{ contact_id: { [Op.in]: phoneCandidates } }] : []),
        ],
      },
      attributes: ['id'],
      raw: true,
    });
    const conversationIds = conversations.map((item) => item.id).filter(Boolean);
    if (conversationIds.length) {
      const outbound = await models.Message.findOne({
        where: {
          conversation_id: { [Op.in]: conversationIds },
          direction: 'outbound',
          status: { [Op.ne]: 'failed' },
        },
        order: [['createdAt', 'ASC']],
        raw: true,
      });
      if (outbound) {
        return { decision: false, reason: 'outbound_message_registered', message_id: outbound.id };
      }
    }
  }
  return {
    decision: true,
    reason: callOutcome === 'no_contactado' ? 'call_not_contacted' : 'contact_pending',
  };
}

module.exports = {
  evaluatePendingLeadContact,
  isEffectiveContactAttempt,
};
