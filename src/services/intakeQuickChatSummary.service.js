'use strict';

const crypto = require('crypto');
const db = require('../../models');
const { findCanonicalWhatsappConversation } = require('../lib/canonical-conversation');
const { normalizePhoneDigits } = require('../lib/phone');
const { Op } = db.Sequelize;

const QUICKCHAT_SOURCE_DETAIL = 'chatbot_quickchat';
const QUICKCHAT_SUMMARY_KIND = 'quickchat_summary';
const QUICKCHAT_SUMMARY_SOURCE = 'snippet_chatbot';
const MAX_EXTRA_PAIRS = 20;

const LOCATION_ID_KEYS = new Set([
  'location',
  'location_id',
  'sede',
  'sede_id',
  'clinic_id',
  'clinica_id',
]);

const LOCATION_LABEL_KEYS = new Set([
  'location_label',
  'sede_label',
  'clinic_label',
  'clinica_label',
]);

const EXTRA_FIELD_LABELS = {
  location: 'Clínica',
  location_id: 'Clínica',
  sede: 'Clínica',
  sede_id: 'Clínica',
  clinic_id: 'Clínica',
  clinica_id: 'Clínica',
  location_label: 'Clínica',
  sede_label: 'Clínica',
  clinic_label: 'Clínica',
  clinica_label: 'Clínica',
  vive_catalunya: 'Vive en Barcelona o Catalunya',
};

const YES_NO_FIELD_KEYS = new Set([
  'vive_catalunya',
]);

const CONTACT_KEYS = new Set([
  'nombre',
  'name',
  'full_name',
  'nombre_completo',
  'email',
  'correo',
  'telefono',
  'phone',
  'tel',
  'mobile',
  'movil',
  'notas',
  'notes',
  'message',
  'mensaje',
  'action',
]);

const SENSITIVE_KEY_PARTS = [
  'authorization',
  'password',
  'passwd',
  'secret',
  'token',
  'cookie',
  'api_key',
  'apikey',
  'hmac',
  'signature',
];

function cleanText(value, maxLength = 500) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'object' || typeof value === 'function' || typeof value === 'symbol') return null;
  const normalized = String(value)
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) return null;
  return normalized.slice(0, maxLength);
}

function normalizeKey(value) {
  return String(value || '')
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isSensitiveKey(value) {
  const rawKey = String(value || '').trim().toLowerCase();
  if (rawKey === '__proto__' || rawKey === 'prototype' || rawKey === 'constructor') return true;
  const key = normalizeKey(value);
  if (!key || key === 'prototype' || key === 'constructor') return true;
  return SENSITIVE_KEY_PARTS.some((part) => key.includes(part));
}

function sanitizeStructuredValue(value, depth = 0) {
  if (value === undefined || value === null || depth > 2) return null;
  if (typeof value === 'string') return cleanText(value, 240);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .slice(0, 10)
      .map((item) => sanitizeStructuredValue(item, depth + 1))
      .filter((item) => item !== null);
  }
  if (typeof value !== 'object') return null;

  const out = {};
  for (const [key, item] of Object.entries(value).slice(0, 20)) {
    if (isSensitiveKey(key)) continue;
    const safeKey = cleanText(key, 80);
    const safeValue = sanitizeStructuredValue(item, depth + 1);
    if (safeKey && safeValue !== null) out[safeKey] = safeValue;
  }
  return out;
}

function stringifyExtraValue(value) {
  const sanitized = sanitizeStructuredValue(value);
  if (sanitized === null) return null;
  if (typeof sanitized === 'string') return sanitized;
  try {
    return JSON.stringify(sanitized).slice(0, 500);
  } catch (_error) {
    return null;
  }
}

function humanizeExtraFieldLabel(rawKey) {
  const normalizedKey = normalizeKey(rawKey);
  if (EXTRA_FIELD_LABELS[normalizedKey]) return EXTRA_FIELD_LABELS[normalizedKey];
  const cleaned = cleanText(rawKey, 80);
  if (!cleaned) return null;
  const spaced = cleaned.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
  return spaced ? `${spaced.charAt(0).toUpperCase()}${spaced.slice(1)}` : null;
}

function humanizeExtraValue(normalizedKey, rawValue) {
  if (YES_NO_FIELD_KEYS.has(normalizedKey)) {
    const normalizedValue = normalizeKey(rawValue);
    if (['si', 'yes', 'true', '1'].includes(normalizedValue)) return 'Sí';
    if (['no', 'false', '0'].includes(normalizedValue)) return 'No';
  }
  return stringifyExtraValue(rawValue);
}

function getChatState(body = {}) {
  const state = body?.chat_state && typeof body.chat_state === 'object' && !Array.isArray(body.chat_state)
    ? body.chat_state
    : (body?.chatState && typeof body.chatState === 'object' && !Array.isArray(body.chatState)
      ? body.chatState
      : null);
  const data = state?.data && typeof state.data === 'object' && !Array.isArray(state.data)
    ? state.data
    : {};
  return {
    data,
    step: cleanText(state?.step, 100),
  };
}

function firstText(values, maxLength) {
  for (const value of values) {
    const cleaned = cleanText(value, maxLength);
    if (cleaned) return cleaned;
  }
  return null;
}

function sanitizeUrl(value) {
  const cleaned = cleanText(value, 2048);
  if (!cleaned) return null;
  try {
    const parsed = new URL(cleaned);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.toString().slice(0, 2048) : null;
  } catch (_error) {
    return null;
  }
}

function sanitizeEmail(value) {
  const cleaned = cleanText(value, 254);
  if (!cleaned) return null;
  const normalized = cleaned.toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized) ? normalized : null;
}

function sanitizePhone(value) {
  const digits = normalizePhoneDigits(value);
  return digits ? `+${digits}` : null;
}

function isQuickChatSummaryRequest(body = {}) {
  const sourceDetail = firstText([
    body.source_detail,
    body.sourceDetail,
  ], 64);
  return String(sourceDetail || '').toLowerCase() === QUICKCHAT_SOURCE_DETAIL;
}

function validateQuickChatContact({ body = {}, lead = null } = {}) {
  const chatState = getChatState(body);
  const chatData = chatState.data;
  const leadData = body?.lead_data && typeof body.lead_data === 'object' && !Array.isArray(body.lead_data)
    ? body.lead_data
    : {};
  const rawPhone = firstText([
    chatData.telefono,
    chatData.phone,
    chatData.tel,
    chatData.mobile,
    chatData.movil,
    leadData.telefono,
    leadData.phone,
    leadData.tel,
    body.telefono,
    body.phone,
    body.tel,
    lead?.telefono,
  ], 80);
  const rawEmail = firstText([
    chatData.email,
    chatData.correo,
    leadData.email,
    body.email,
    lead?.email,
  ], 254);
  const telefono = sanitizePhone(rawPhone);
  const email = sanitizeEmail(rawEmail);

  return {
    telefono,
    email,
    phone_valid: Boolean(telefono),
    email_present: Boolean(rawEmail),
    email_valid: !rawEmail || Boolean(email),
  };
}

function buildSanitizedSummary({ body = {}, lead = null, pageUrl = null, landingUrl = null } = {}) {
  const chatState = getChatState(body);
  const chatData = chatState.data;
  const leadData = body?.lead_data && typeof body.lead_data === 'object' && !Array.isArray(body.lead_data)
    ? body.lead_data
    : {};

  const nombre = firstText([
    chatData.nombre,
    chatData.name,
    chatData.full_name,
    chatData.nombre_completo,
    leadData.nombre,
    leadData.name,
    lead?.nombre,
  ], 160);
  const telefono = sanitizePhone(firstText([
    chatData.telefono,
    chatData.phone,
    chatData.tel,
    chatData.mobile,
    chatData.movil,
    leadData.telefono,
    leadData.phone,
    leadData.tel,
    lead?.telefono,
  ], 80));
  const email = sanitizeEmail(firstText([
    chatData.email,
    chatData.correo,
    leadData.email,
    lead?.email,
  ], 254));

  const rawLocation = chatData.location
    ?? chatData.sede
    ?? chatData.clinic_id
    ?? chatData.clinica_id
    ?? null;
  const locationLabel = firstText([
    chatData.location_label,
    chatData.locationLabel,
    chatData.sede_label,
    chatData.sedeLabel,
    chatData.clinic_label,
    chatData.clinicLabel,
    chatData.clinica_label,
    chatData.clinicaLabel,
    rawLocation && typeof rawLocation === 'object' && !Array.isArray(rawLocation)
      ? (rawLocation.public_label || rawLocation.label || rawLocation.name)
      : null,
  ], 160);
  const extraPairs = [];
  let locationPairAdded = false;
  for (const [rawKey, rawValue] of Object.entries(chatData)) {
    const normalizedKey = normalizeKey(rawKey);
    if (CONTACT_KEYS.has(normalizedKey) || isSensitiveKey(rawKey)) continue;
    if (LOCATION_ID_KEYS.has(normalizedKey) && locationLabel) continue;
    if (LOCATION_LABEL_KEYS.has(normalizedKey) && locationPairAdded) continue;

    const isLocationLabel = LOCATION_LABEL_KEYS.has(normalizedKey);
    const key = humanizeExtraFieldLabel(rawKey);
    const value = isLocationLabel
      ? locationLabel
      : humanizeExtraValue(normalizedKey, rawValue);
    if (!key || !value) continue;
    extraPairs.push({ key, value });
    if (LOCATION_ID_KEYS.has(normalizedKey) || isLocationLabel) locationPairAdded = true;
    if (extraPairs.length >= MAX_EXTRA_PAIRS) break;
  }

  return {
    page_url: sanitizeUrl(pageUrl || body.page_url || body.pageUrl),
    landing_url: sanitizeUrl(landingUrl || body.landing_url || body.landingUrl),
    nombre,
    telefono,
    email,
    extra_pairs: extraPairs,
    chat_state_step: chatState.step,
  };
}

function buildQuickChatSummaryContent(summary = {}) {
  const lines = ['Nuevo paciente potencial desde el chatbot de la web.'];
  if (summary.landing_url && summary.page_url && summary.landing_url !== summary.page_url) {
    lines.push(`Página origen: ${summary.landing_url}`);
    lines.push(`Página envío: ${summary.page_url}`);
  } else if (summary.page_url || summary.landing_url) {
    lines.push(`Página: ${summary.page_url || summary.landing_url}`);
  }
  lines.push(`Nombre: ${summary.nombre || '-'}`);
  lines.push(`Teléfono: ${summary.telefono || '-'}`);
  lines.push(`Email: ${summary.email || '-'}`);

  if (Array.isArray(summary.extra_pairs) && summary.extra_pairs.length) {
    lines.push('', 'Datos recogidos:');
    summary.extra_pairs.slice(0, MAX_EXTRA_PAIRS).forEach(({ key, value }) => {
      lines.push(`- ${key}: ${value}`);
    });
  }

  lines.push('', 'Puedes responderle desde QuickChat; este resumen no se ha enviado al paciente.');
  return lines.join('\n').slice(0, 8000);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

function hashSummary(summary) {
  return crypto.createHash('sha256').update(stableStringify(summary)).digest('hex');
}

function parseMetadata(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function isSummaryMessageForLead(message, leadId) {
  const metadata = parseMetadata(message?.metadata);
  return String(metadata.kind || '').toLowerCase() === QUICKCHAT_SUMMARY_KIND
    && Number(metadata.lead_intake_id || metadata.lead_id || 0) === Number(leadId);
}

function getSummaryAuditId(message, leadId) {
  if (!isSummaryMessageForLead(message, leadId)) return null;
  return positiveInteger(parseMetadata(message?.metadata).intake_audit_id);
}

async function findLatestPersistedSummaryAudit({
  Conversation,
  Message,
  clinicId,
  leadId,
  transaction,
  lock,
}) {
  const conversations = await Conversation.findAll({
    where: {
      clinic_id: clinicId,
      channel: 'whatsapp',
      lead_id: leadId,
    },
    attributes: ['id'],
    transaction,
    ...(lock ? { lock } : {}),
  });
  const conversationIds = conversations
    .map((conversation) => positiveInteger(conversation?.id))
    .filter(Boolean);
  if (!conversationIds.length) return null;

  const messages = await Message.findAll({
    where: {
      conversation_id: { [Op.in]: conversationIds },
      message_type: 'event',
    },
    order: [['id', 'ASC']],
    transaction,
    ...(lock ? { lock } : {}),
  });
  let latest = null;
  for (const message of messages) {
    const auditId = getSummaryAuditId(message, leadId);
    if (!auditId || (latest && latest.audit_id >= auditId)) continue;
    latest = {
      audit_id: auditId,
      conversation_id: positiveInteger(message.conversation_id),
      message_id: positiveInteger(message.id),
    };
  }
  return latest;
}

function createServiceError(status, code, message) {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function materializeIntakeQuickChatSummary({
  leadId,
  clinicId = null,
  auditId = null,
  body = {},
  pageUrl = null,
  landingUrl = null,
} = {}, overrides = {}) {
  const sequelize = overrides.sequelize || db.sequelize;
  const LeadIntake = overrides.LeadIntake || db.LeadIntake;
  const Conversation = overrides.Conversation || db.Conversation;
  const Message = overrides.Message || db.Message;
  const canonicalResolver = overrides.findCanonicalWhatsappConversation || findCanonicalWhatsappConversation;
  const suppliedTransaction = overrides.transaction || null;
  const normalizedLeadId = positiveInteger(leadId);
  const normalizedAuditId = positiveInteger(auditId);

  if (!normalizedLeadId) {
    throw createServiceError(409, 'quickchat_summary_lead_missing', 'No se pudo resolver el lead del resumen QuickChat');
  }

  const materialize = async (transaction) => {
    const lock = transaction?.LOCK?.UPDATE;
    const lead = await LeadIntake.findByPk(normalizedLeadId, {
      transaction,
      ...(lock ? { lock } : {}),
    });
    if (!lead) {
      throw createServiceError(409, 'quickchat_summary_lead_missing', 'El lead del resumen QuickChat ya no existe');
    }

    const requestedClinicId = positiveInteger(clinicId);
    const leadClinicId = positiveInteger(lead.clinica_id);
    if (requestedClinicId && leadClinicId && requestedClinicId !== leadClinicId) {
      throw createServiceError(
        409,
        'quickchat_summary_clinic_mismatch',
        'El lead duplicado pertenece a otra clínica'
      );
    }
    const effectiveClinicId = leadClinicId || requestedClinicId;
    if (!effectiveClinicId) {
      throw createServiceError(422, 'quickchat_summary_clinic_required', 'Se necesita una clínica para crear el resumen QuickChat');
    }

    // El lead queda bloqueado durante toda la transacción, por lo que dos jobs
    // del mismo lead se serializan. Antes de resolver/crear/mezclar una
    // conversación, se consulta el marcador durable de todos sus resúmenes.
    // Un audit antiguo sale aquí sin tocar mensaje ni last_message_at.
    if (normalizedAuditId) {
      const latestPersisted = await findLatestPersistedSummaryAudit({
        Conversation,
        Message,
        clinicId: effectiveClinicId,
        leadId: normalizedLeadId,
        transaction,
        lock,
      });
      if (latestPersisted?.audit_id > normalizedAuditId) {
        return {
          created: false,
          updated: false,
          consolidated: false,
          stale: true,
          stale_reason: 'newer_audit_already_materialized',
          persisted_audit_id: latestPersisted.audit_id,
          clinic_id: effectiveClinicId,
          lead_id: normalizedLeadId,
          conversation_id: latestPersisted.conversation_id,
          message_id: latestPersisted.message_id,
          message: null,
        };
      }
    }

    const summary = buildSanitizedSummary({ body, lead, pageUrl, landingUrl });
    if (!summary.telefono) {
      throw createServiceError(422, 'quickchat_summary_phone_required', 'Se necesita un teléfono válido para crear el resumen QuickChat');
    }

    const conversation = await canonicalResolver({
      clinicId: effectiveClinicId,
      contactId: summary.telefono,
      leadId: normalizedLeadId,
      createIfMissing: true,
      transaction,
    });
    if (!conversation) {
      throw createServiceError(422, 'quickchat_summary_conversation_unavailable', 'No se pudo crear la conversación QuickChat');
    }

    const eventMessages = await Message.findAll({
      where: {
        conversation_id: conversation.id,
        message_type: 'event',
      },
      order: [['id', 'ASC']],
      transaction,
      ...(lock ? { lock } : {}),
    });
    const matchingMessages = eventMessages.filter((message) => isSummaryMessageForLead(message, normalizedLeadId));
    const summaryHash = hashSummary(summary);
    const content = buildQuickChatSummaryContent(summary);
    const now = new Date();
    let message = matchingMessages[0] || null;
    let created = false;
    let updated = false;

    const metadata = {
      ...(message ? parseMetadata(message.metadata) : {}),
      source: QUICKCHAT_SUMMARY_SOURCE,
      source_detail: QUICKCHAT_SOURCE_DETAIL,
      kind: QUICKCHAT_SUMMARY_KIND,
      action: QUICKCHAT_SUMMARY_KIND,
      hidden_from_patient: true,
      lead_intake_id: normalizedLeadId,
      ...(normalizedAuditId ? { intake_audit_id: normalizedAuditId } : {}),
      summary_hash: summaryHash,
      summary: {
        page_url: summary.page_url,
        landing_url: summary.landing_url,
        nombre: summary.nombre,
        telefono: summary.telefono,
        email: summary.email,
        extra_pairs: summary.extra_pairs,
      },
      chat_state_step: summary.chat_state_step,
    };

    if (!message) {
      message = await Message.create({
        conversation_id: conversation.id,
        sender_id: null,
        direction: 'inbound',
        content,
        message_type: 'event',
        status: 'sent',
        sent_at: now,
        metadata,
      }, { transaction });
      created = true;
    } else {
      const existingMetadata = parseMetadata(message.metadata);
      const needsUpdate = existingMetadata.summary_hash !== summaryHash
        || message.content !== content
        || message.direction !== 'inbound'
        || message.message_type !== 'event'
        || message.status !== 'sent'
        || existingMetadata.hidden_from_patient !== true
        || String(existingMetadata.source_detail || '').toLowerCase() !== QUICKCHAT_SOURCE_DETAIL
        // Aunque el resumen sea byte a byte idéntico, el watermark debe
        // avanzar al audit aceptado más reciente. La guarda previa garantiza
        // que aquí nunca retroceda a un audit inferior.
        || (normalizedAuditId && getSummaryAuditId(message, normalizedLeadId) !== normalizedAuditId);
      if (needsUpdate) {
        await message.update({
          direction: 'inbound',
          content,
          message_type: 'event',
          status: 'sent',
          metadata,
        }, { transaction });
        updated = true;
      }
    }

    const duplicateMessages = matchingMessages.slice(1);
    for (const duplicate of duplicateMessages) {
      await duplicate.destroy({ transaction });
    }
    if (duplicateMessages.length) updated = true;

    if (created || updated) {
      await conversation.update({ last_message_at: now }, { transaction });
    }

    return {
      created,
      updated,
      consolidated: duplicateMessages.length > 0,
      clinic_id: effectiveClinicId,
      lead_id: normalizedLeadId,
      conversation_id: Number(conversation.id),
      message_id: Number(message.id),
      message: {
        id: Number(message.id),
        conversation_id: Number(conversation.id),
        content,
        direction: 'inbound',
        message_type: 'event',
        status: 'sent',
        sent_at: message.sent_at || now,
        metadata,
      },
    };
  };

  // Los callers normales conservan una transacción propia. Las reparaciones
  // controladas pueden aportar una transacción ya abierta para incluir en el
  // mismo commit sus guardas, la materialización y sus postcondiciones.
  if (suppliedTransaction) {
    return materialize(suppliedTransaction);
  }
  return sequelize.transaction(materialize);
}

module.exports = {
  QUICKCHAT_SOURCE_DETAIL,
  QUICKCHAT_SUMMARY_KIND,
  isQuickChatSummaryRequest,
  buildSanitizedSummary,
  buildQuickChatSummaryContent,
  validateQuickChatContact,
  materializeIntakeQuickChatSummary,
  __testing: {
    cleanText,
    isSensitiveKey,
    sanitizeStructuredValue,
    hashSummary,
    isSummaryMessageForLead,
    getSummaryAuditId,
    findLatestPersistedSummaryAudit,
  },
};
