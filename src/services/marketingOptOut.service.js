'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const { normalizePhoneDigits, normalizePhoneE164, getPhoneLookupCandidates } = require('../lib/phone');

const {
  MarketingContactOptOut,
  MarketingPatientContactEvent,
  MarketingPatientList,
  MarketingPatientListItem,
  Message,
  PacienteConsentimiento,
} = db;

const OPT_OUT_WINDOW_DAYS = Number.parseInt(process.env.MARKETING_OPT_OUT_WINDOW_DAYS || '45', 10);
const MARKETING_MESSAGE_SOURCES = new Set(['marketing_bulk_sends', 'marketing_reactivation']);
const MARKETING_MESSAGE_KINDS = new Set(['mass_campaign_test', 'mass_campaign_send', 'marketing_bulk_send', 'marketing_reactivation']);
const MARKETING_OBJECTIVES = new Set(['mass_sends', 'reactivate_patients']);
const COMMERCIAL_TEMPLATE_USAGES = new Set(['marketing', 'comercial', 'promocion', 'promocional', 'reactivacion_pacientes']);
const COMMERCIAL_TEMPLATE_CATEGORIES = new Set(['marketing']);

function cleanString(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function normalizeText(value) {
  return cleanString(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function includesOptOutKeyword(text) {
  const normalized = normalizeText(text);
  if (!normalized) return false;
  return /\bbaja\b/.test(normalized);
}

function normalizePhone(raw) {
  return {
    phone: normalizePhoneE164(raw),
    phoneDigits: normalizePhoneDigits(raw),
    candidates: getPhoneLookupCandidates(raw),
  };
}

function isMarketingOutboundMessage(message) {
  const metadata = message?.metadata || {};
  const source = cleanString(metadata.source || metadata.campaign_source);
  const kind = cleanString(metadata.kind);
  const flowSource = cleanString(metadata.flow_source || metadata.action_source || metadata.node_source);
  const objectiveId = cleanString(metadata.objective_id || metadata.trigger_objective_id);
  const templateUsage = normalizeText(metadata.template_usage || metadata.template_uso || metadata.uso);
  const templateCategory = normalizeText(metadata.template_category || metadata.category);
  const templateCommercial = metadata.template_commercial === true
    || COMMERCIAL_TEMPLATE_USAGES.has(templateUsage)
    || COMMERCIAL_TEMPLATE_CATEGORIES.has(templateCategory);

  const hasMarketingContext = MARKETING_MESSAGE_SOURCES.has(source)
    || MARKETING_MESSAGE_SOURCES.has(flowSource)
    || MARKETING_MESSAGE_KINDS.has(kind)
    || MARKETING_OBJECTIVES.has(objectiveId)
    || (source === 'automations_v2' && flowSource === 'marketing_reactivation')
    || (source === 'automations_v2' && metadata.flow_domain === 'marketing');

  return templateCommercial || (hasMarketingContext && metadata.template_commercial === true);
}

async function findRecentMarketingOutboundMessage({ conversationId, inboundCreatedAt }) {
  if (!conversationId || !Message) return null;
  const cutoff = new Date(Date.now() - Math.max(1, OPT_OUT_WINDOW_DAYS) * 24 * 60 * 60 * 1000);
  const rows = await Message.findAll({
    where: {
      conversation_id: conversationId,
      direction: 'outbound',
      createdAt: {
        [Op.gte]: cutoff,
        ...(inboundCreatedAt ? { [Op.lte]: inboundCreatedAt } : {}),
      },
    },
    order: [['createdAt', 'DESC']],
    limit: 20,
  });
  return rows.find(isMarketingOutboundMessage) || null;
}

function computeCounters(items) {
  const total = items.length;
  const ready = items.filter((item) => item.status === 'ready').length;
  const excluded = items.filter((item) => String(item.status || '').startsWith('excluded')).length;
  return {
    total,
    ready,
    selected: ready,
    excluded,
    lead: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    replied: 0,
    appointments: 0,
    treatments: 0,
  };
}

async function refreshListCounters(listIds, transaction = null) {
  const uniqueIds = Array.from(new Set((listIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  for (const listId of uniqueIds) {
    const items = await MarketingPatientListItem.findAll({
      where: { list_id: listId },
      transaction,
    });
    await MarketingPatientList.update(
      { counters: computeCounters(items.map((item) => item.get({ plain: true }))) },
      { where: { id: listId }, transaction }
    );
  }
}

async function createRejectedCommunicationConsent({ patientId, inboundMessage, triggerMessage, transaction = null }) {
  if (!PacienteConsentimiento || !patientId) return;
  const existing = await PacienteConsentimiento.findOne({
    where: {
      paciente_id: patientId,
      tipo: 'comunicaciones',
      estado: 'rechazado',
    },
    transaction,
  });
  if (existing) return;
  await PacienteConsentimiento.create({
    paciente_id: patientId,
    nombre: 'Baja comunicaciones comerciales',
    descripcion: [
      'Solicitud automática de baja por respuesta WhatsApp.',
      inboundMessage?.content ? `Mensaje: "${inboundMessage.content}"` : null,
      triggerMessage?.id ? `Mensaje origen: ${triggerMessage.id}` : null,
    ].filter(Boolean).join(' '),
    tipo: 'comunicaciones',
    estado: 'rechazado',
    fecha_envio: triggerMessage?.sent_at || triggerMessage?.createdAt || null,
    fecha_firma: inboundMessage?.sent_at || inboundMessage?.createdAt || new Date(),
    obligatorio: false,
  }, { transaction });
}

async function upsertOptOutRecord({
  clinicId,
  patientId = null,
  phone,
  phoneDigits,
  inboundMessage,
  triggerMessage,
  transaction = null,
}) {
  const triggerMetadata = triggerMessage?.metadata || {};
  const [record] = await MarketingContactOptOut.findOrCreate({
    where: {
      clinica_id: clinicId,
      phone_digits: phoneDigits,
      channel: 'whatsapp',
      scope: 'marketing',
      status: 'active',
    },
    defaults: {
      paciente_id: patientId || null,
      phone,
      reason_text: cleanString(inboundMessage?.content) || null,
      source: 'whatsapp_inbound',
      trigger_message_id: triggerMessage?.id || null,
      inbound_message_id: inboundMessage?.id || null,
      trigger_list_id: Number(triggerMetadata.list_id || 0) || null,
      trigger_item_id: Number(triggerMetadata.item_id || 0) || null,
      trigger_objective_id: cleanString(triggerMetadata.objective_id) || cleanString(triggerMetadata.campaign_source) || null,
      opted_out_at: inboundMessage?.sent_at || inboundMessage?.createdAt || new Date(),
    },
    transaction,
  });

  const patch = {
    paciente_id: record.paciente_id || patientId || null,
    phone: record.phone || phone,
    reason_text: cleanString(inboundMessage?.content) || record.reason_text,
    trigger_message_id: triggerMessage?.id || record.trigger_message_id,
    inbound_message_id: inboundMessage?.id || record.inbound_message_id,
    trigger_list_id: Number(triggerMetadata.list_id || 0) || record.trigger_list_id || null,
    trigger_item_id: Number(triggerMetadata.item_id || 0) || record.trigger_item_id || null,
    trigger_objective_id: cleanString(triggerMetadata.objective_id) || cleanString(triggerMetadata.campaign_source) || record.trigger_objective_id || null,
    opted_out_at: inboundMessage?.sent_at || inboundMessage?.createdAt || record.opted_out_at || new Date(),
  };
  await record.update(patch, { transaction });
  return record;
}

async function excludeMatchingListItems({
  clinicId,
  patientId = null,
  phoneCandidates = [],
  inboundMessage,
  triggerMessage,
  transaction = null,
}) {
  if (!MarketingPatientList || !MarketingPatientListItem) return [];
  const activeLists = await MarketingPatientList.findAll({
    where: {
      status: { [Op.ne]: 'archived' },
      [Op.or]: [
        { clinica_id: clinicId },
        { clinic_ids: { [Op.ne]: null } },
      ],
    },
    attributes: ['id', 'clinic_ids', 'clinica_id', 'channel'],
    transaction,
  });
  const listIds = activeLists
    .filter((list) => {
      if (Number(list.clinica_id) === Number(clinicId)) return true;
      const clinicIds = Array.isArray(list.clinic_ids) ? list.clinic_ids.map(Number) : [];
      return clinicIds.includes(Number(clinicId));
    })
    .map((list) => list.id);
  if (!listIds.length) return [];

  const orClauses = [];
  if (patientId) orClauses.push({ paciente_id: patientId });
  if (phoneCandidates.length) orClauses.push({ phone: { [Op.in]: phoneCandidates } });
  if (!orClauses.length) return [];

  const rows = await MarketingPatientListItem.findAll({
    where: {
      list_id: { [Op.in]: listIds },
      [Op.or]: orClauses,
    },
    transaction,
  });
  if (!rows.length) return [];

  const updatedListIds = new Set();
  for (const row of rows) {
    if (String(row.status || '').startsWith('excluded') && row.exclusion_reason === 'opt_out') {
      continue;
    }
    const previousStatus = row.status;
    await row.update({
      status: 'excluded_opt_out',
      exclusion_reason: 'opt_out',
      selected: false,
      reason: 'Baja solicitada por WhatsApp tras un envío comercial',
      notes: [
        cleanString(row.notes),
        inboundMessage?.id ? `Opt-out inbound #${inboundMessage.id}` : null,
      ].filter(Boolean).join('\n') || null,
    }, { transaction });
    updatedListIds.add(row.list_id);
    await MarketingPatientContactEvent.create({
      list_id: row.list_id,
      item_id: row.id,
      paciente_id: row.paciente_id || null,
      event_type: 'marketing_opt_out',
      channel: 'whatsapp',
      payload: {
        previous_status: previousStatus,
        inbound_message_id: inboundMessage?.id || null,
        trigger_message_id: triggerMessage?.id || null,
        reason_text: cleanString(inboundMessage?.content) || null,
      },
      occurred_at: new Date(),
    }, { transaction });
  }

  await refreshListCounters(Array.from(updatedListIds), transaction);
  return rows;
}

async function applyInboundOptOutIfNeeded({ clinicId, conversation, inboundMessage, rawText, patientId = null }) {
  if (!MarketingContactOptOut || !clinicId || !conversation || !inboundMessage) {
    return { applied: false, reason: 'missing_context' };
  }
  const text = cleanString(rawText || inboundMessage.content);
  if (!includesOptOutKeyword(text)) {
    return { applied: false, reason: 'keyword_not_found' };
  }

  const triggerMessage = await findRecentMarketingOutboundMessage({
    conversationId: conversation.id,
    inboundCreatedAt: inboundMessage.createdAt || new Date(),
  });
  if (!triggerMessage) {
    return { applied: false, reason: 'no_recent_marketing_message' };
  }

  const normalized = normalizePhone(conversation.contact_id || inboundMessage.metadata?.from || '');
  if (!normalized.phoneDigits) {
    return { applied: false, reason: 'phone_not_found' };
  }
  const effectivePatientId = patientId || conversation.patient_id || null;

  return db.sequelize.transaction(async (transaction) => {
    const record = await upsertOptOutRecord({
      clinicId,
      patientId: effectivePatientId,
      phone: normalized.phone,
      phoneDigits: normalized.phoneDigits,
      inboundMessage,
      triggerMessage,
      transaction,
    });
    await createRejectedCommunicationConsent({
      patientId: effectivePatientId,
      inboundMessage,
      triggerMessage,
      transaction,
    });
    const updatedItems = await excludeMatchingListItems({
      clinicId,
      patientId: effectivePatientId,
      phoneCandidates: normalized.candidates,
      inboundMessage,
      triggerMessage,
      transaction,
    });
    return {
      applied: true,
      record_id: record.id,
      updated_items: updatedItems.length,
      trigger_message_id: triggerMessage.id,
    };
  });
}

async function getActiveOptOutSetsForScope(scope, transaction = null) {
  if (!MarketingContactOptOut) {
    return { patientIds: new Set(), phoneDigits: new Set() };
  }
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (!clinicIds.length) {
    return { patientIds: new Set(), phoneDigits: new Set() };
  }
  const rows = await MarketingContactOptOut.findAll({
    where: {
      clinica_id: { [Op.in]: clinicIds },
      channel: 'whatsapp',
      scope: 'marketing',
      status: 'active',
    },
    attributes: ['paciente_id', 'phone_digits'],
    raw: true,
    transaction,
  });
  return {
    patientIds: new Set(rows.map((row) => Number(row.paciente_id || 0)).filter((id) => Number.isInteger(id) && id > 0)),
    phoneDigits: new Set(rows.map((row) => cleanString(row.phone_digits)).filter(Boolean)),
  };
}

function isContactOptedOut({ patientId = null, phone = null, optOutSets }) {
  if (!optOutSets) return false;
  const normalizedDigits = normalizePhoneDigits(phone);
  return (!!patientId && optOutSets.patientIds?.has(Number(patientId)))
    || (!!normalizedDigits && optOutSets.phoneDigits?.has(normalizedDigits));
}

module.exports = {
  applyInboundOptOutIfNeeded,
  getActiveOptOutSetsForScope,
  includesOptOutKeyword,
  isContactOptedOut,
};
