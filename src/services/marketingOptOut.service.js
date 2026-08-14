'use strict';

const { Op, Sequelize } = require('sequelize');
const db = require('../../models');
const { normalizePhoneDigits, normalizePhoneE164, getPhoneLookupCandidates } = require('../lib/phone');
const { getIO } = require('./socket.service');
const { emitNotificationCreated } = require('./notificationsRealtime.service');
const reviewResponseClassification = require('./reviewResponseClassification.service');

const {
  Clinica,
  MarketingContactOptOut,
  MarketingPatientContactEvent,
  MarketingPatientList,
  MarketingPatientListItem,
  Message,
  Notification,
  PacienteConsentimiento,
  PatientOperationalEvent,
  UsuarioClinica,
} = db;

const OPT_OUT_WINDOW_DAYS = Number.parseInt(process.env.MARKETING_OPT_OUT_WINDOW_DAYS || '45', 10);
const MARKETING_MESSAGE_SOURCES = new Set(['marketing_bulk_sends', 'marketing_reactivation']);
const MARKETING_MESSAGE_KINDS = new Set(['mass_campaign_test', 'mass_campaign_send', 'marketing_bulk_send', 'marketing_reactivation']);
const MARKETING_OBJECTIVES = new Set(['mass_sends', 'reactivate_patients']);
const COMMERCIAL_TEMPLATE_USAGES = new Set(['marketing', 'comercial', 'promocion', 'promocional', 'reactivacion_pacientes']);
const COMMERCIAL_TEMPLATE_CATEGORIES = new Set(['marketing']);
const REVIEW_TEMPLATE_USAGES = new Set(['solicitud_resena', 'resena', 'review_request', 'reviews']);

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
  return reviewResponseClassification.classifyDeterministically(text).intent === 'marketing_opt_out';
}

function normalizePhone(raw) {
  return {
    phone: normalizePhoneE164(raw),
    phoneDigits: normalizePhoneDigits(raw),
    candidates: getPhoneLookupCandidates(raw),
  };
}

function emitQuickChatInternalNotice(conversation, message) {
  const io = getIO();
  if (!io || !conversation?.id || !message?.id) return;
  const payload = {
    id: String(message.id),
    conversation_id: String(message.conversation_id || conversation.id),
    content: message.content || '',
    direction: message.direction || 'outbound',
    message_type: message.message_type || 'event',
    status: message.status || 'sent',
    sent_at: message.sent_at || message.createdAt || new Date(),
    sender_id: message.sender_id || null,
    metadata: message.metadata || undefined,
  };
  if (conversation.clinic_id) {
    io.to(`clinic:${conversation.clinic_id}`).emit('message:created', payload);
  } else {
    io.emit('message:created', payload);
  }
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

  const isReviewRequest = source === 'marketing_bulk_sends'
    && (cleanString(metadata.dispatch_context) === 'review_request'
      || REVIEW_TEMPLATE_USAGES.has(templateUsage));

  return isReviewRequest || templateCommercial || (hasMarketingContext && metadata.template_commercial === true);
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
  const sent = items.filter((item) => item.sent_at || ['sent', 'delivered', 'read', 'replied'].includes(String(item.dispatch_status || '').toLowerCase())).length;
  const delivered = items.filter((item) => item.delivered_at || item.read_at || ['delivered', 'read', 'replied'].includes(String(item.dispatch_status || '').toLowerCase())).length;
  const read = items.filter((item) => item.read_at || ['read', 'replied'].includes(String(item.dispatch_status || '').toLowerCase())).length;
  const replied = items.filter((item) => item.replied_at || String(item.dispatch_status || '').toLowerCase() === 'replied').length;
  const failed = items.filter((item) => item.failed_at || String(item.dispatch_status || '').toLowerCase() === 'failed').length;
  const optOut = items.filter((item) => item.opt_out_at || item.exclusion_reason === 'opt_out').length;
  return {
    total,
    ready,
    selected: ready,
    excluded,
    lead: 0,
    sent,
    delivered,
    read,
    replied,
    failed,
    opt_out: optOut,
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

async function getClinicIdsForMarketingOptOut(clinicId, transaction = null) {
  const normalizedClinicId = Number(clinicId || 0);
  if (!Number.isInteger(normalizedClinicId) || normalizedClinicId <= 0 || !Clinica) {
    return normalizedClinicId > 0 ? [normalizedClinicId] : [];
  }

  const clinic = await Clinica.findByPk(normalizedClinicId, {
    attributes: ['id_clinica', 'grupoClinicaId'],
    raw: true,
    transaction,
  });
  const groupId = Number(clinic?.grupoClinicaId || 0);
  if (!Number.isInteger(groupId) || groupId <= 0) {
    return [normalizedClinicId];
  }

  const siblings = await Clinica.findAll({
    where: { grupoClinicaId: groupId },
    attributes: ['id_clinica'],
    raw: true,
    transaction,
  });
  const ids = siblings.map((row) => Number(row.id_clinica)).filter((id) => Number.isInteger(id) && id > 0);
  return Array.from(new Set(ids.length ? ids : [normalizedClinicId]));
}

function listBelongsToAnyClinic(list, clinicIds) {
  const targetIds = new Set((clinicIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0));
  if (!targetIds.size) return false;
  if (list.clinica_id && targetIds.has(Number(list.clinica_id))) return true;
  const listClinicIds = Array.isArray(list.clinic_ids) ? list.clinic_ids.map(Number) : [];
  return listClinicIds.some((id) => targetIds.has(Number(id)));
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

async function createQuickChatOptOutNotice({
  conversation,
  inboundMessage,
  triggerMessage,
  updatedItems = [],
  clinicIds = [],
  transaction = null,
}) {
  if (!Message || !conversation?.id || !inboundMessage?.id) return null;
  const metadataLike = Sequelize.cast(Sequelize.col('metadata'), 'CHAR');
  const existing = await Message.findOne({
    where: {
      conversation_id: conversation.id,
      message_type: 'event',
      [Op.or]: [
        Sequelize.where(metadataLike, { [Op.like]: `%"inbound_message_id":${Number(inboundMessage.id)}%` }),
        Sequelize.where(metadataLike, { [Op.like]: `%"inbound_message_id": ${Number(inboundMessage.id)}%` }),
      ],
    },
    transaction,
  });
  if (existing) return { message: existing, created: false };

  const message = await Message.create({
    conversation_id: conversation.id,
    sender_id: null,
    direction: 'outbound',
    content: 'Se ha dado de baja a este usuario de esta lista y futuros envíos promocionales.',
    message_type: 'event',
    status: 'sent',
    sent_at: inboundMessage.sent_at || inboundMessage.createdAt || new Date(),
    metadata: {
      kind: 'automation_flow_event',
      reason: 'marketing_opt_out',
      source: 'marketing_opt_out',
      hidden_from_patient: true,
      inbound_message_id: inboundMessage.id,
      trigger_message_id: triggerMessage?.id || null,
      clinic_ids: clinicIds,
      updated_items: updatedItems.length,
    },
  }, { transaction });
  return { message, created: true };
}

async function upsertOptOutRecord({
  clinicId,
  clinicIds = null,
  patientId = null,
  phone,
  phoneDigits,
  inboundMessage,
  triggerMessage,
  scope = 'marketing',
  source = 'whatsapp_inbound',
  transaction = null,
}) {
  const triggerMetadata = triggerMessage?.metadata || {};
  const targetClinicIds = Array.from(new Set((clinicIds || [clinicId]).map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  const records = [];
  for (const targetClinicId of targetClinicIds) {
    const [record] = await MarketingContactOptOut.findOrCreate({
      where: {
        clinica_id: targetClinicId,
        phone_digits: phoneDigits,
        channel: 'whatsapp',
        scope,
        status: 'active',
      },
      defaults: {
        paciente_id: patientId || null,
        phone,
        reason_text: cleanString(inboundMessage?.content) || null,
        source,
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
    records.push(record);
  }
  return records[0] || null;
}

async function excludeMatchingListItems({
  clinicId,
  clinicIds = null,
  patientId = null,
  phoneCandidates = [],
  inboundMessage,
  triggerMessage,
  exclusionReason = 'opt_out',
  reason = 'Baja solicitada por WhatsApp tras un envío comercial',
  transaction = null,
}) {
  if (!MarketingPatientList || !MarketingPatientListItem) return [];
  const targetClinicIds = Array.from(new Set((clinicIds || [clinicId]).map(Number).filter((id) => Number.isInteger(id) && id > 0)));
  const activeLists = await MarketingPatientList.findAll({
    where: {
      status: { [Op.ne]: 'archived' },
      [Op.or]: [
        targetClinicIds.length === 1 ? { clinica_id: targetClinicIds[0] } : { clinica_id: { [Op.in]: targetClinicIds } },
        { clinic_ids: { [Op.ne]: null } },
      ],
    },
    attributes: ['id', 'clinic_ids', 'clinica_id', 'channel'],
    transaction,
  });
  const listIds = activeLists
    .filter((list) => listBelongsToAnyClinic(list, targetClinicIds))
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
  const updatedRows = [];
  for (const row of rows) {
    const alreadySent = !!row.sent_at || ['sent', 'delivered', 'read', 'replied'].includes(String(row.dispatch_status || '').toLowerCase());
    if (!alreadySent && String(row.status || '').startsWith('excluded') && row.exclusion_reason === exclusionReason) {
      continue;
    }
    const inboundNote = inboundMessage?.id ? `Opt-out inbound #${inboundMessage.id}` : null;
    const notes = cleanString(row.notes);
    if (inboundNote && notes.includes(inboundNote) && row.opt_out_at) {
      continue;
    }
    const previousStatus = row.status;
    const optedOutAt = inboundMessage?.sent_at || inboundMessage?.createdAt || new Date();
    const patch = alreadySent
      ? {
        dispatch_status: 'replied',
        replied_at: row.replied_at || optedOutAt,
        opt_out_at: row.opt_out_at || optedOutAt,
        conversation_id: triggerMessage?.conversation_id || row.conversation_id || null,
        notes: [
          notes,
          inboundNote,
        ].filter(Boolean).join('\n') || null,
      }
      : {
        status: `excluded_${exclusionReason}`,
        exclusion_reason: exclusionReason,
        selected: false,
        opt_out_at: row.opt_out_at || optedOutAt,
        reason,
        notes: [
          notes,
          inboundNote,
        ].filter(Boolean).join('\n') || null,
    };
    await row.update(patch, { transaction });
    updatedRows.push(row);
    updatedListIds.add(row.list_id);
    await MarketingPatientContactEvent.create({
      list_id: row.list_id,
      item_id: row.id,
      paciente_id: row.paciente_id || null,
      event_type: exclusionReason === 'opt_out' ? 'marketing_opt_out' : `marketing_${exclusionReason}`,
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
  return updatedRows;
}

async function createPatientRestrictionEvent({
  clinicId,
  patientId,
  intent,
  inboundMessage,
  triggerMessage,
  transaction = null,
}) {
  if (!PatientOperationalEvent || !patientId || !clinicId) return null;
  const inboundMessageId = Number(inboundMessage?.id || 0);
  if (inboundMessageId > 0) {
    const existing = await PatientOperationalEvent.findOne({
      where: {
        patient_id: Number(patientId),
        clinic_id: Number(clinicId),
        event_type: intent === 'wrong_recipient'
          ? 'patient.whatsapp_number_invalid'
          : 'patient.marketing_opt_out',
        [Op.and]: [db.sequelize.where(
          db.sequelize.literal("CAST(JSON_UNQUOTE(JSON_EXTRACT(metadata, '$.inbound_message_id')) AS UNSIGNED)"),
          inboundMessageId
        )],
      },
      transaction,
    });
    if (existing) return existing;
  }
  return PatientOperationalEvent.create({
    patient_id: Number(patientId),
    clinic_id: Number(clinicId),
    actor_user_id: null,
    event_type: intent === 'wrong_recipient'
      ? 'patient.whatsapp_number_invalid'
      : 'patient.marketing_opt_out',
    source: 'quick_chat',
    channel: 'whatsapp',
    metadata: {
      classification: intent,
      inbound_message_id: inboundMessage?.id || null,
      trigger_message_id: triggerMessage?.id || null,
      reason_text: cleanString(inboundMessage?.content) || null,
    },
    occurred_at: inboundMessage?.sent_at || inboundMessage?.createdAt || new Date(),
  }, { transaction });
}

async function createManualReviewNotifications({ clinicId, conversation, inboundMessage, classification }) {
  if (!Notification || !UsuarioClinica || !clinicId || !conversation?.id) return 0;
  const memberships = await UsuarioClinica.findAll({
    where: {
      id_clinica: Number(clinicId),
      estado_invitacion: 'aceptada',
      rol_clinica: { [Op.in]: ['propietario', 'personaldeclinica'] },
    },
    attributes: ['id_usuario', 'rol_clinica', 'subrol_clinica'],
    raw: true,
  });
  let created = 0;
  for (const membership of memberships) {
    const existing = await Notification.findOne({
      where: {
        userId: membership.id_usuario,
        event: 'automation.system_notification',
        [Op.and]: [db.sequelize.where(
          db.sequelize.literal("CAST(JSON_UNQUOTE(JSON_EXTRACT(data, '$.inboundMessageId')) AS UNSIGNED)"),
          Number(inboundMessage?.id || 0)
        )],
      },
    });
    if (existing) continue;
    const notification = await Notification.create({
      userId: membership.id_usuario,
      role: membership.rol_clinica || '',
      subrole: membership.subrol_clinica || '',
      category: 'general',
      event: 'automation.system_notification',
      title: 'Respuesta pendiente de revisar',
      message: 'El paciente ha respondido, pero no hemos podido determinar su intención automáticamente. Se requiere una acción manual.',
      icon: 'heroicons_outline:bell-alert',
      level: 'warning',
      data: {
        source: 'review_response_classification',
        quickChatConversationId: Number(conversation.id),
        inboundMessageId: Number(inboundMessage?.id || 0) || null,
        classification: classification || null,
        clinicId: Number(clinicId),
      },
      clinicaId: Number(clinicId),
    });
    emitNotificationCreated(notification);
    created += 1;
  }
  return created;
}

async function applyInboundContactClassification({
  clinicId,
  conversation,
  inboundMessage,
  patientId = null,
  classification,
}) {
  const intent = cleanString(classification?.intent);
  if (!['marketing_opt_out', 'wrong_recipient', 'review_refusal', 'ambiguous'].includes(intent)) {
    return { applied: false, reason: 'classification_not_actionable' };
  }
  const triggerMessage = await findRecentMarketingOutboundMessage({
    conversationId: conversation?.id,
    inboundCreatedAt: inboundMessage?.createdAt || new Date(),
  });
  if (!triggerMessage) return { applied: false, reason: 'no_recent_marketing_message' };

  if (intent === 'ambiguous') {
    const notifications = await createManualReviewNotifications({
      clinicId,
      conversation,
      inboundMessage,
      classification,
    });
    return { applied: notifications > 0, intent, notifications };
  }

  const triggerMetadata = triggerMessage?.metadata || {};
  const listId = Number(triggerMetadata.list_id || 0) || null;
  const itemId = Number(triggerMetadata.item_id || 0) || null;
  if (intent === 'review_refusal') {
    if (listId && itemId) {
      const item = await MarketingPatientListItem.findOne({ where: { id: itemId, list_id: listId } });
      if (item) {
        await item.update({
          dispatch_status: 'replied',
          replied_at: item.replied_at || inboundMessage.sent_at || inboundMessage.createdAt || new Date(),
          exclusion_reason: 'review_refusal',
          reason: 'El paciente no desea responder a esta solicitud de reseña',
        });
        const existingRefusal = await MarketingPatientContactEvent.findOne({
          where: {
            list_id: listId,
            item_id: itemId,
            event_type: 'review_request_refused',
            [Op.and]: [db.sequelize.where(
              db.sequelize.literal("CAST(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.inbound_message_id')) AS UNSIGNED)"),
              Number(inboundMessage.id || 0)
            )],
          },
        });
        if (!existingRefusal) {
          await MarketingPatientContactEvent.create({
            list_id: listId,
            item_id: itemId,
            paciente_id: item.paciente_id || patientId || null,
            event_type: 'review_request_refused',
            channel: 'whatsapp',
            payload: { inbound_message_id: inboundMessage.id, reason_text: inboundMessage.content || null },
            occurred_at: inboundMessage.sent_at || inboundMessage.createdAt || new Date(),
          });
        }
        await refreshListCounters([listId]);
      }
    }
    return { applied: true, intent, list_id: listId, item_id: itemId };
  }

  const normalized = normalizePhone(conversation?.contact_id || inboundMessage?.metadata?.from || '');
  if (!normalized.phoneDigits) return { applied: false, reason: 'phone_not_found' };
  const effectivePatientId = patientId || conversation?.patient_id || null;
  const targetClinicIds = await getClinicIdsForMarketingOptOut(clinicId);
  const scope = intent === 'wrong_recipient' ? 'whatsapp_number' : 'marketing';
  const exclusionReason = intent === 'wrong_recipient' ? 'wrong_recipient' : 'opt_out';
  const result = await db.sequelize.transaction(async (transaction) => {
    const record = await upsertOptOutRecord({
      clinicId,
      clinicIds: targetClinicIds,
      patientId: effectivePatientId,
      phone: normalized.phone,
      phoneDigits: normalized.phoneDigits,
      inboundMessage,
      triggerMessage,
      scope,
      source: 'review_response_classification',
      transaction,
    });
    if (intent === 'marketing_opt_out') {
      await createRejectedCommunicationConsent({
        patientId: effectivePatientId,
        inboundMessage,
        triggerMessage,
        transaction,
      });
    }
    const updatedItems = await excludeMatchingListItems({
      clinicId,
      clinicIds: targetClinicIds,
      patientId: intent === 'wrong_recipient' ? null : effectivePatientId,
      phoneCandidates: normalized.candidates,
      inboundMessage,
      triggerMessage,
      exclusionReason,
      reason: intent === 'wrong_recipient'
        ? 'Número erróneo o asignado a otra persona'
        : 'Baja solicitada por WhatsApp tras un envío comercial',
      transaction,
    });
    for (const targetClinicId of targetClinicIds) {
      await createPatientRestrictionEvent({
        clinicId: targetClinicId,
        patientId: effectivePatientId,
        intent,
        inboundMessage,
        triggerMessage,
        transaction,
      });
    }
    const noticeResult = await createQuickChatOptOutNotice({
      conversation,
      inboundMessage,
      triggerMessage,
      updatedItems,
      clinicIds: targetClinicIds,
      transaction,
    });
    const noticeMessage = noticeResult?.message || null;
    if (noticeMessage && intent === 'wrong_recipient') {
      await noticeMessage.update({
        content: 'Este número se ha marcado como erróneo o perteneciente a otra persona. No se enviarán más mensajes hasta corregirlo.',
        metadata: {
          ...(noticeMessage.metadata || {}),
          reason: 'wrong_recipient',
          scope,
          hidden_from_patient: true,
        },
      }, { transaction });
    }
    return { record, updatedItems, noticeMessage, noticeCreated: noticeResult?.created === true };
  });
  if (result.noticeMessage && result.noticeCreated) emitQuickChatInternalNotice(conversation, result.noticeMessage);
  return {
    applied: true,
    intent,
    record_id: result.record.id,
    clinic_ids: targetClinicIds,
    updated_items: result.updatedItems.length,
    trigger_message_id: triggerMessage.id,
  };
}

async function applyInboundOptOutIfNeeded({ clinicId, conversation, inboundMessage, rawText, patientId = null }) {
  if (!MarketingContactOptOut || !clinicId || !conversation || !inboundMessage) {
    return { applied: false, reason: 'missing_context' };
  }
  const text = cleanString(rawText || inboundMessage.content);
  const classification = reviewResponseClassification.classifyDeterministically(text);
  if (!['marketing_opt_out', 'wrong_recipient'].includes(classification.intent)) {
    return { applied: false, reason: 'keyword_not_found' };
  }

  return applyInboundContactClassification({
    clinicId,
    conversation,
    inboundMessage,
    patientId,
    classification,
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

function emptyContactRestrictions() {
  return {
    active: false,
    marketing_opt_out: false,
    whatsapp_number_invalid: false,
    items: [],
  };
}

function serializeContactRestrictions(rows = []) {
  const items = rows.map((row) => ({
    id: Number(row.id),
    scope: cleanString(row.scope),
    reason_text: cleanString(row.reason_text) || null,
    source: cleanString(row.source) || null,
    restricted_at: row.opted_out_at || row.createdAt || null,
  }));
  return {
    active: items.length > 0,
    marketing_opt_out: items.some((item) => item.scope === 'marketing'),
    whatsapp_number_invalid: items.some((item) => item.scope === 'whatsapp_number'),
    items,
  };
}

async function getActiveContactRestrictionsForConversations(conversations = [], transaction = null) {
  const targets = (conversations || [])
    .map((conversation) => {
      const plain = typeof conversation?.get === 'function'
        ? conversation.get({ plain: true })
        : conversation;
      return {
        id: Number(plain?.id || 0),
        clinicId: Number(plain?.clinic_id || 0),
        patientId: Number(plain?.patient_id || plain?.paciente?.id_paciente || 0),
        phoneDigits: normalizePhoneDigits(
          plain?.contact_id
          || plain?.paciente?.telefono_movil
          || plain?.paciente?.telefono
          || plain?.lead?.telefono
          || ''
        ),
      };
    })
    .filter((target) => target.id > 0 && target.clinicId > 0);

  const result = new Map(targets.map((target) => [target.id, emptyContactRestrictions()]));
  if (!MarketingContactOptOut || !targets.length) return result;

  const clinicIds = Array.from(new Set(targets.map((target) => target.clinicId)));
  const patientIds = Array.from(new Set(targets.map((target) => target.patientId).filter((id) => id > 0)));
  const phoneDigits = Array.from(new Set(targets.map((target) => target.phoneDigits).filter(Boolean)));
  const identityWhere = [];
  if (patientIds.length) identityWhere.push({ paciente_id: { [Op.in]: patientIds } });
  if (phoneDigits.length) identityWhere.push({ phone_digits: { [Op.in]: phoneDigits } });
  if (!identityWhere.length) return result;

  const rows = await MarketingContactOptOut.findAll({
    where: {
      clinica_id: { [Op.in]: clinicIds },
      channel: 'whatsapp',
      scope: { [Op.in]: ['marketing', 'whatsapp_number'] },
      status: 'active',
      [Op.or]: identityWhere,
    },
    attributes: [
      'id',
      'clinica_id',
      'paciente_id',
      'phone_digits',
      'scope',
      'reason_text',
      'source',
      'opted_out_at',
    ],
    order: [['opted_out_at', 'DESC'], ['id', 'DESC']],
    raw: true,
    transaction,
  });

  for (const target of targets) {
    const matches = rows.filter((row) => Number(row.clinica_id) === target.clinicId
      && ((target.patientId > 0 && Number(row.paciente_id) === target.patientId)
        || (!!target.phoneDigits && cleanString(row.phone_digits) === target.phoneDigits)));
    result.set(target.id, serializeContactRestrictions(matches));
  }
  return result;
}

async function getActiveContactRestrictionsForPatient({ clinicIds = [], patientId, phone }, transaction = null) {
  const normalizedClinicIds = Array.from(new Set((clinicIds || []).map(Number).filter((id) => id > 0)));
  if (!MarketingContactOptOut || !normalizedClinicIds.length) return emptyContactRestrictions();
  const normalizedPatientId = Number(patientId || 0);
  const phoneDigits = normalizePhoneDigits(phone);
  const identityWhere = [];
  if (normalizedPatientId > 0) identityWhere.push({ paciente_id: normalizedPatientId });
  if (phoneDigits) identityWhere.push({ phone_digits: phoneDigits });
  if (!identityWhere.length) return emptyContactRestrictions();

  const rows = await MarketingContactOptOut.findAll({
    where: {
      clinica_id: { [Op.in]: normalizedClinicIds },
      channel: 'whatsapp',
      scope: { [Op.in]: ['marketing', 'whatsapp_number'] },
      status: 'active',
      [Op.or]: identityWhere,
    },
    attributes: ['id', 'scope', 'reason_text', 'source', 'opted_out_at'],
    order: [['opted_out_at', 'DESC'], ['id', 'DESC']],
    raw: true,
    transaction,
  });
  return serializeContactRestrictions(rows);
}

async function resolveWhatsappNumberRestrictionAfterChange({ patientId, previousPhone, nextPhone, actorUserId = null } = {}) {
  const normalizedPatientId = Number(patientId || 0);
  const previousDigits = normalizePhoneDigits(previousPhone);
  const nextDigits = normalizePhoneDigits(nextPhone);
  if (!MarketingContactOptOut || normalizedPatientId <= 0 || !nextDigits || previousDigits === nextDigits) {
    return { resolved: 0 };
  }
  const restrictions = await MarketingContactOptOut.findAll({
    where: {
      paciente_id: normalizedPatientId,
      channel: 'whatsapp',
      scope: 'whatsapp_number',
      status: 'active',
      phone_digits: { [Op.ne]: nextDigits },
    },
  });
  if (!restrictions.length) return { resolved: 0 };

  const occurredAt = new Date();
  await db.sequelize.transaction(async (transaction) => {
    for (const restriction of restrictions) {
      await restriction.update({ status: 'resolved' }, { transaction });
      if (PatientOperationalEvent) {
        await PatientOperationalEvent.create({
          patient_id: normalizedPatientId,
          clinic_id: Number(restriction.clinica_id),
          actor_user_id: Number(actorUserId || 0) || null,
          event_type: 'patient.whatsapp_number_corrected',
          source: 'patient_record',
          channel: 'whatsapp',
          metadata: {
            restriction_id: restriction.id,
            previous_phone_digits: restriction.phone_digits || previousDigits || null,
            next_phone_digits: nextDigits,
          },
          occurred_at: occurredAt,
        }, { transaction });
      }
    }
  });
  return { resolved: restrictions.length };
}

module.exports = {
  applyInboundContactClassification,
  applyInboundOptOutIfNeeded,
  getActiveContactRestrictionsForConversations,
  getActiveContactRestrictionsForPatient,
  getActiveOptOutSetsForScope,
  includesOptOutKeyword,
  isContactOptedOut,
  resolveWhatsappNumberRestrictionAfterChange,
};
