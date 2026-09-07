'use strict';

const db = require('../../models');

const DELIVERED_PROVIDER_STATUSES = new Set(['sent', 'delivered', 'read']);

function cleanString(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function toPositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseMetadata(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function isLeadAutoReplyMessage(message) {
  const metadata = parseMetadata(message?.metadata);
  return cleanString(metadata.template_usage).toLowerCase() === 'lead_auto_reply'
    && cleanString(message?.direction).toLowerCase() === 'outbound';
}

async function resolveLeadId(message, models, transaction) {
  const metadata = parseMetadata(message?.metadata);
  const direct = toPositiveInt(metadata.lead_intake_id || metadata.lead_id);
  if (direct) return direct;

  const executionId = toPositiveInt(metadata.execution_id);
  if (!executionId || !models.FlowExecutionV2) return null;
  const execution = await models.FlowExecutionV2.findByPk(executionId, {
    attributes: ['trigger_entity_type', 'trigger_entity_id', 'context'],
    transaction,
  });
  if (!execution) return null;
  const plain = execution.get ? execution.get({ plain: true }) : execution;
  const context = parseMetadata(plain.context);
  return toPositiveInt(
    context?.lead?.lead_intake_id
    || context?.lead?.id
    || context?.trigger?.data?.lead_intake_id
    || context?.trigger?.data?.lead_id
    || (cleanString(plain.trigger_entity_type).toLowerCase() === 'lead_nuevo'
      ? plain.trigger_entity_id
      : null)
  );
}

function contactTimestamp(message, providerTimestamp) {
  const unixSeconds = Number(providerTimestamp);
  if (Number.isFinite(unixSeconds) && unixSeconds > 0) {
    return new Date(unixSeconds * 1000);
  }
  const messageDate = new Date(message?.sent_at || message?.updatedAt || message?.updated_at || '');
  return Number.isFinite(messageDate.getTime()) ? messageDate : new Date();
}

async function registerDeliveredLeadContact({ message, providerTimestamp, models }) {
  const messageId = toPositiveInt(message?.id);
  if (!messageId || !models.LeadContactAttempt || !models.LeadIntake) return null;

  return models.sequelize.transaction(async (transaction) => {
    const leadId = await resolveLeadId(message, models, transaction);
    if (!leadId) return null;
    const lead = await models.LeadIntake.findByPk(leadId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!lead) return null;

    const motivo = `lead_auto_reply:${messageId}`;
    const existing = await models.LeadContactAttempt.findOne({
      where: { lead_intake_id: leadId, canal: 'whatsapp', motivo },
      transaction,
    });
    if (existing) return existing;

    const at = contactTimestamp(message, providerTimestamp);
    const history = Array.isArray(lead.historial_contactos) ? [...lead.historial_contactos] : [];
    history.push({
      fecha: at.toISOString(),
      motivo: 'lead_auto_reply',
      notas: 'Respuesta automática de WhatsApp entregada',
      canal: 'whatsapp',
      usuario_id: null,
      message_id: messageId,
    });
    const currentStatus = cleanString(lead.status_lead).toLowerCase();
    await lead.update({
      historial_contactos: history,
      num_contactos: Math.max(Number(lead.num_contactos || 0) + 1, history.length),
      ultimo_contacto: at,
      status_lead: currentStatus === 'nuevo' ? 'contactado' : lead.status_lead,
    }, { transaction });

    return models.LeadContactAttempt.create({
      lead_intake_id: leadId,
      usuario_id: null,
      canal: 'whatsapp',
      motivo,
      notas: cleanString(message?.content).slice(0, 500) || 'Respuesta automática de WhatsApp entregada',
    }, { transaction });
  });
}

function historyTimestamp(entry) {
  const date = new Date(entry?.fecha || entry?.created_at || '');
  return Number.isFinite(date.getTime()) ? date : null;
}

async function removeFailedLeadContact({ message, models }) {
  const messageId = toPositiveInt(message?.id);
  if (!messageId || !models.LeadContactAttempt || !models.LeadIntake) return null;

  return models.sequelize.transaction(async (transaction) => {
    const leadId = await resolveLeadId(message, models, transaction);
    if (!leadId) return null;
    const lead = await models.LeadIntake.findByPk(leadId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!lead) return null;

    const motivo = `lead_auto_reply:${messageId}`;
    const history = Array.isArray(lead.historial_contactos) ? lead.historial_contactos : [];
    const filteredHistory = history.filter((entry) => !(
      cleanString(entry?.motivo).toLowerCase() === 'lead_auto_reply'
      && toPositiveInt(entry?.message_id) === messageId
    ));
    const removedAttempts = await models.LeadContactAttempt.destroy({
      where: { lead_intake_id: leadId, canal: 'whatsapp', motivo },
      transaction,
    });
    const removedHistory = history.length - filteredHistory.length;
    if (!removedAttempts && !removedHistory) {
      return { lead_id: leadId, changed: false };
    }

    const latestAttempt = await models.LeadContactAttempt.findOne({
      where: { lead_intake_id: leadId },
      order: [['created_at', 'DESC']],
      transaction,
    });
    const latestHistoryDate = filteredHistory
      .map(historyTimestamp)
      .filter(Boolean)
      .sort((left, right) => right.getTime() - left.getTime())[0] || null;
    const latestAttemptDate = latestAttempt
      ? new Date(latestAttempt.created_at || latestAttempt.createdAt || '')
      : null;
    const latestContact = [latestHistoryDate, latestAttemptDate]
      .filter((date) => date && Number.isFinite(date.getTime()))
      .sort((left, right) => right.getTime() - left.getTime())[0] || null;
    const contactCount = Math.max(
      filteredHistory.length,
      Math.max(0, Number(lead.num_contactos || 0) - 1)
    );
    const currentStatus = cleanString(lead.status_lead).toLowerCase();
    await lead.update({
      historial_contactos: filteredHistory,
      num_contactos: contactCount,
      ultimo_contacto: latestContact,
      status_lead: currentStatus === 'contactado' && contactCount === 0
        ? 'nuevo'
        : lead.status_lead,
    }, { transaction });

    return {
      lead_id: leadId,
      changed: true,
      removed_attempts: Number(removedAttempts || 0),
      removed_history: removedHistory,
    };
  });
}

async function materializeLeadAutoReplyProviderStatus({
  message,
  providerStatus,
  providerTimestamp = null,
  models = db,
} = {}) {
  if (!isLeadAutoReplyMessage(message)) return { handled: false, reason: 'not_lead_auto_reply' };
  const status = cleanString(providerStatus).toLowerCase();
  if (DELIVERED_PROVIDER_STATUSES.has(status)) {
    const attempt = await registerDeliveredLeadContact({ message, providerTimestamp, models });
    return { handled: true, action: 'registered', attempt };
  }
  if (status === 'failed') {
    const result = await removeFailedLeadContact({ message, models });
    return { handled: true, action: 'removed', result };
  }
  return { handled: false, reason: 'non_final_provider_status' };
}

module.exports = {
  DELIVERED_PROVIDER_STATUSES,
  isLeadAutoReplyMessage,
  materializeLeadAutoReplyProviderStatus,
  __testing: {
    contactTimestamp,
    historyTimestamp,
    resolveLeadId,
  },
};
