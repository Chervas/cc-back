'use strict';
const { Op } = require('sequelize');
const db = require('../../models');
const { queues } = require('../services/queue.service');
const { getIO } = require('../services/socket.service');
const whatsappService = require('../services/whatsapp.service');
const { findCanonicalWhatsappConversation } = require('../lib/canonical-conversation');
const { canUserAccessFeature } = require('../lib/access-policy');
const { canUserSelectWhatsappTemplate } = require('../lib/whatsapp-template-ownership');
const { isReviewWorkflowWhatsappTemplate } = require('../lib/whatsapp-template-workflow');
const {
  getPendingReplyStatesByConversationIds,
} = require('../services/conversationPendingReply.service');
const {
  resolveWhatsappServiceWindow,
} = require('../services/whatsappServiceWindow.service');
const {
  startPatientWhatsappConversation,
} = require('../services/patientContact.service');

const {
  Conversation,
  Message,
  UsuarioClinica,
  Paciente,
  LeadIntake,
  LeadContactAttempt,
  ConversationRead,
  Clinica,
  FormSubmissionEvent,
  MarketingPatientListItem,
  WhatsappTemplate,
  WhatsappTemplateCatalog,
} = db;

const ROLE_AGGREGATE = ['propietario', 'admin'];
const LEAD_CONTACT_PROTECTED_STATUSES = new Set(['cualificado', 'citado', 'acudio_cita', 'convertido', 'descartado']);
const ADMIN_USER_IDS = (process.env.ADMIN_USER_IDS || '1,44')
  .split(',')
  .map((v) => parseInt(v.trim(), 10))
  .filter((n) => !Number.isNaN(n));

const STREAMABLE_MEDIA_KINDS = new Set(['audio', 'image', 'video', 'document', 'sticker']);
const INLINE_MEDIA_KINDS = new Set(['audio', 'image', 'video', 'sticker']);

function messageChronologicalOrder(direction = 'ASC') {
  const normalizedDirection = String(direction).toUpperCase() === 'DESC' ? 'DESC' : 'ASC';
  return [
    [db.Sequelize.fn('COALESCE', db.Sequelize.col('sent_at'), db.Sequelize.col('createdAt')), normalizedDirection],
    ['id', normalizedDirection],
  ];
}

function normalizeMediaMimeType(value, fallback = 'application/octet-stream') {
  return String(value || fallback).split(';')[0].trim().toLowerCase() || fallback;
}

function getDefaultMimeTypeForKind(kind) {
  switch (kind) {
    case 'audio':
      return 'audio/ogg';
    case 'image':
      return 'image/jpeg';
    case 'video':
      return 'video/mp4';
    default:
      return 'application/octet-stream';
  }
}

function extensionForMediaMimeType(mimeType, kind) {
  const normalized = normalizeMediaMimeType(mimeType, getDefaultMimeTypeForKind(kind));
  if (normalized.includes('jpeg') || normalized.includes('jpg')) return 'jpg';
  if (normalized.includes('png')) return 'png';
  if (normalized.includes('webp')) return 'webp';
  if (normalized.includes('gif')) return 'gif';
  if (normalized.includes('mpeg') || normalized.includes('mp3')) return 'mp3';
  if (normalized.includes('mp4')) return kind === 'audio' ? 'm4a' : 'mp4';
  if (normalized.includes('wav')) return 'wav';
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('ogg') || normalized.includes('opus')) return 'ogg';
  if (normalized.includes('pdf')) return 'pdf';
  return kind || 'media';
}

function unavailableMediaError(kind) {
  const normalized = String(kind || '').toLowerCase();
  return normalized ? `${normalized}_unavailable` : 'media_unavailable';
}

function downloadFailedMediaError(kind) {
  const normalized = String(kind || '').toLowerCase();
  return normalized ? `${normalized}_download_failed` : 'media_download_failed';
}

function cleanText(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function cleanScalar(value) {
  if (value === undefined || value === null) return '';
  if (['string', 'number', 'boolean'].includes(typeof value)) {
    return String(value).trim();
  }
  if (typeof value === 'object') {
    for (const key of ['value', 'raw_value', 'answer', 'text', 'phone', 'telefono', 'mobile', 'whatsapp']) {
      const nested = cleanScalar(value?.[key]);
      if (nested) return nested;
    }
  }
  return '';
}

function looksLikePhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 9 && digits.length <= 15;
}

const LEAD_PHONE_KEYS = ['phone', 'telefono', 'teléfono', 'tel', 'mobile', 'movil', 'móvil', 'whatsapp'];

function extractPhoneFromObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }

  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = String(rawKey || '').toLocaleLowerCase('es-ES');
    if (!LEAD_PHONE_KEYS.some((candidate) => key.includes(candidate))) {
      continue;
    }
    const candidate = cleanScalar(rawValue);
    const normalized = whatsappService.normalizePhoneNumber(candidate);
    if (normalized || looksLikePhone(candidate)) {
      return normalized || candidate;
    }
  }

  return '';
}

async function resolveLeadWhatsappPhone(lead, { transaction = null } = {}) {
  const currentPhone = cleanScalar(lead?.telefono);
  const normalizedCurrentPhone = whatsappService.normalizePhoneNumber(currentPhone);
  if (normalizedCurrentPhone || looksLikePhone(currentPhone)) {
    return normalizedCurrentPhone || currentPhone;
  }

  if (!FormSubmissionEvent || !lead?.id) {
    return '';
  }

  const latestSubmission = await FormSubmissionEvent.findOne({
    where: { lead_intake_id: lead.id },
    attributes: ['fields_json', 'payload_json', 'submitted_at'],
    order: [
      ['submitted_at', 'DESC'],
      ['id', 'DESC'],
    ],
    raw: true,
    transaction,
  });

  const payloadLeadData = latestSubmission?.payload_json?.lead_data;
  const fallbackPhone = extractPhoneFromObject(payloadLeadData)
    || extractPhoneFromObject(latestSubmission?.fields_json)
    || extractPhoneFromObject(latestSubmission?.payload_json);

  if (fallbackPhone && typeof lead.update === 'function') {
    try {
      await lead.update({ telefono: fallbackPhone }, { transaction });
    } catch (err) {
      console.warn('No se pudo persistir teléfono de fallback del lead', {
        leadId: lead.id,
        error: err?.message || err,
      });
    }
  }

  return fallbackPhone;
}

async function registerLeadWhatsappContactAttempt({ leadId, userId, isTemplate, body }) {
  const safeLeadId = Number(leadId);
  if (!Number.isInteger(safeLeadId) || safeLeadId <= 0) {
    return null;
  }

  const lead = await LeadIntake.findByPk(safeLeadId);
  if (!lead) {
    return null;
  }

  const now = new Date();
  const historial = Array.isArray(lead.historial_contactos)
    ? [...lead.historial_contactos]
    : [];
  const motivo = isTemplate ? 'whatsapp_template_sent' : 'whatsapp_message_sent';
  const notas = isTemplate ? 'Plantilla WhatsApp enviada' : 'WhatsApp enviado';

  historial.push({
    fecha: now.toISOString(),
    motivo,
    notas,
    canal: 'whatsapp',
    usuario_id: userId || null,
  });

  await lead.update({
    historial_contactos: historial,
    num_contactos: (Number(lead.num_contactos || 0) || 0) + 1,
    ultimo_contacto: now,
    status_lead: LEAD_CONTACT_PROTECTED_STATUSES.has(String(lead.status_lead || '').trim().toLowerCase())
      ? lead.status_lead
      : 'contactado',
  });

  if (LeadContactAttempt) {
    await LeadContactAttempt.create({
      lead_intake_id: lead.id,
      usuario_id: userId || null,
      canal: 'whatsapp',
      motivo,
      notas: cleanText(body).slice(0, 500) || notas,
    });
  }

  return lead;
}

function isTechnicalWhatsappFailureNotice(message) {
  if (!message || typeof message !== 'object') {
    return false;
  }
  const metadata = message.metadata && typeof message.metadata === 'object'
    ? message.metadata
    : {};
  const failureSource = cleanText(metadata.failure_source).toLowerCase();
  if (failureSource === 'automation_send_whatsapp_preflight') {
    return true;
  }
  const normalizedContent = cleanText(message.content)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
  return normalizedContent.startsWith('no se pudo enviar el whatsapp automatico')
    || normalizedContent.startsWith('no se pudo enviar este whatsapp automatico');
}

function isQuickChatHiddenMessage(message) {
  if (!message || typeof message !== 'object') {
    return false;
  }
  const metadata = message.metadata && typeof message.metadata === 'object'
    ? message.metadata
    : {};
  return metadata.qa_cleanup === true || metadata.hide_from_quickchat === true;
}

function filterQuickChatVisibleMessages(messages) {
  return Array.isArray(messages)
    ? messages.filter((message) => !isQuickChatHiddenMessage(message))
    : [];
}

function parseJsonValue(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return fallback;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function getTemplateBodyFromTemplate(template) {
  const components = Array.isArray(template?.components)
    ? template.components
    : [];
  const bodyComponent = components.find((component) => String(component?.type || '').toUpperCase() === 'BODY');
  return cleanText(bodyComponent?.text)
    || cleanText(template?.catalog?.body_text)
    || cleanText(template?.catalog?.body)
    || cleanText(template?.body_text)
    || cleanText(template?.body);
}

function resolveTemplateParam(templateParams, position) {
  if (!templateParams) return '';
  if (Array.isArray(templateParams)) {
    return cleanText(templateParams[Number(position) - 1]);
  }
  if (typeof templateParams === 'object') {
    return cleanText(templateParams[position])
      || cleanText(templateParams[Number(position)])
      || cleanText(templateParams[`{{${position}}}`]);
  }
  return '';
}

function renderTemplatePreview(body, templateParams) {
  return cleanText(body).replace(/\{\{\s*(\d+)\s*\}\}/g, (match, position) => (
    resolveTemplateParam(templateParams, String(position)) || match
  ));
}

async function hydrateTemplateMessagePreviews(messages, { clinicId = null } = {}) {
  if (!Array.isArray(messages) || !messages.length || !WhatsappTemplate) {
    return Array.isArray(messages) ? messages : [];
  }

  const templateRefs = [];
  for (const message of messages) {
    const type = cleanText(message?.message_type).toLowerCase();
    if (type !== 'template' || cleanText(message?.content)) {
      continue;
    }
    const metadata = parseJsonValue(message?.metadata, {});
    const existingPreview = cleanText(metadata.preview_text)
      || cleanText(metadata.previewText)
      || cleanText(metadata.message_preview)
      || cleanText(metadata.template_preview);
    if (existingPreview) {
      message.content = existingPreview;
      message.metadata = { ...metadata, preview_text: existingPreview };
      continue;
    }
    const templateName = cleanText(metadata.template_name || metadata.templateName);
    if (!templateName) {
      continue;
    }
    templateRefs.push({
      message,
      metadata,
      templateName,
      templateLanguage: cleanText(metadata.template_language || metadata.templateLanguage).toLowerCase(),
    });
  }

  if (!templateRefs.length) {
    return messages;
  }

  const names = [...new Set(templateRefs.map((item) => item.templateName))];
  const scopeWhere = [];
  const numericClinicId = Number(clinicId);
  if (Number.isInteger(numericClinicId) && numericClinicId > 0) {
    scopeWhere.push({ clinic_id: numericClinicId });
  }
  scopeWhere.push({ clinic_id: null });

  const templates = await WhatsappTemplate.findAll({
    where: {
      name: { [Op.in]: names },
      is_active: true,
      [Op.or]: scopeWhere,
    },
    attributes: ['id', 'name', 'language', 'clinic_id', 'components', 'catalog_template_id'],
    include: WhatsappTemplateCatalog
      ? [{ model: WhatsappTemplateCatalog, as: 'catalog', attributes: ['id', 'body_text', 'components'], required: false }]
      : [],
  });

  const byNameLanguage = new Map();
  const byName = new Map();
  for (const templateRow of templates) {
    const template = templateRow?.toJSON ? templateRow.toJSON() : templateRow;
    const plain = {
      ...template,
      components: parseJsonValue(template.components, []),
      catalog: parseJsonValue(template.catalog, {}),
    };
    const name = cleanText(plain.name);
    const language = cleanText(plain.language).toLowerCase();
    if (!name) continue;
    if (!byName.has(name)) byName.set(name, plain);
    if (language) byNameLanguage.set(`${name}:${language}`, plain);
  }

  for (const ref of templateRefs) {
    const template = (ref.templateLanguage && byNameLanguage.get(`${ref.templateName}:${ref.templateLanguage}`))
      || byName.get(ref.templateName);
    const body = getTemplateBodyFromTemplate(template);
    const preview = renderTemplatePreview(body, ref.metadata.templateParams || ref.metadata.template_params);
    if (!preview) {
      continue;
    }
    ref.message.content = preview;
    ref.message.metadata = {
      ...ref.metadata,
      preview_text: preview,
      template_body: body,
    };
  }

  return messages;
}

async function getUserClinics(userId) {
  const isAdmin = ADMIN_USER_IDS.includes(Number(userId));
  if (isAdmin) {
    const clinics = await Clinica.findAll({ attributes: ['id_clinica'], raw: true });
    return {
      clinicIds: clinics.map((c) => c.id_clinica),
      isAggregateAllowed: true,
    };
  }
  const memberships = await UsuarioClinica.findAll({
    where: { id_usuario: userId },
    attributes: ['id_clinica', 'rol_clinica'],
    raw: true,
  });
  const clinicIds = memberships.map((m) => m.id_clinica);
  const roles = memberships.map((m) => m.rol_clinica);
  const isAggregateAllowed = roles.some((r) => ROLE_AGGREGATE.includes(r));
  return { clinicIds, isAggregateAllowed };
}

const QUICKCHAT_POLICY_FEATURES = {
  read_patients: 'quickchat.read_patients',
  read_team: 'quickchat.read_team',
  read_leads: 'quickchat.read_leads',
};

const QUICKCHAT_CATEGORY_FEATURES = {
  patients: QUICKCHAT_POLICY_FEATURES.read_patients,
  team: QUICKCHAT_POLICY_FEATURES.read_team,
  leads: QUICKCHAT_POLICY_FEATURES.read_leads,
};

async function canReadQuickChatFeatureForAnyClinic(userId, featureKey, clinicIds) {
  for (const clinicId of clinicIds) {
    // Keep this sequential: it avoids a burst of policy queries for owners with many clinics.
    // The endpoint is called often by QuickChat while changing clinic context.
    // eslint-disable-next-line no-await-in-loop
    const allowed = await canUserAccessFeature({
      actorId: userId,
      featureKey,
      clinicId,
    });
    if (allowed) return true;
  }
  return false;
}

async function getQuickChatPolicyPermissions(userId, clinicIds, selectedClinicId = null) {
  const scopedClinicIds = selectedClinicId
    ? clinicIds.filter((id) => Number(id) === Number(selectedClinicId))
    : clinicIds;

  if (!scopedClinicIds.length) {
    return { read_patients: false, read_team: false, read_leads: false };
  }

  const [readPatients, readTeam, readLeads] = await Promise.all([
    canReadQuickChatFeatureForAnyClinic(userId, QUICKCHAT_POLICY_FEATURES.read_patients, scopedClinicIds),
    canReadQuickChatFeatureForAnyClinic(userId, QUICKCHAT_POLICY_FEATURES.read_team, scopedClinicIds),
    canReadQuickChatFeatureForAnyClinic(userId, QUICKCHAT_POLICY_FEATURES.read_leads, scopedClinicIds),
  ]);

  return {
    read_patients: readPatients,
    read_team: readTeam,
    read_leads: readLeads,
  };
}

function normalizeClinicIdList(values) {
  return Array.from(new Set(
    (Array.isArray(values) ? values : [values])
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value))
  ));
}

function clinicIdCondition(clinicIds) {
  const ids = normalizeClinicIdList(clinicIds);
  if (ids.length === 1) return ids[0];
  return { [Op.in]: ids };
}

function resolveConversationClinicScope({ clinicIds, isAggregateAllowed, requestedClinicId }) {
  if (requestedClinicId && requestedClinicId !== 'all') {
    const parsed = parseClinicIdsParam(requestedClinicId);
    if (!parsed || !ensureAccess({ clinicIds, isAggregateAllowed }, requestedClinicId)) {
      return { error: 'access_denied', clinicIds: [] };
    }
    return { clinicIds: normalizeClinicIdList(parsed) };
  }

  return { clinicIds: normalizeClinicIdList(clinicIds) };
}

function getQuickChatConversationCategory(conversation) {
  if (!conversation) return null;
  const plain = typeof conversation.toJSON === 'function' ? conversation.toJSON() : conversation;
  const channel = String(plain.channel || '').toLowerCase();
  const contactId = String(plain.contact_id || '').toLowerCase();
  if (channel === 'internal' || contactId === 'team') {
    return 'team';
  }
  if (plain.patient_id || plain.paciente) {
    return 'patients';
  }
  return 'leads';
}

function getQuickChatFeatureForCategory(category) {
  return QUICKCHAT_CATEGORY_FEATURES[category] || null;
}

async function getAllowedQuickChatClinicIdsByCategory(userId, clinicIds) {
  const result = { patients: [], team: [], leads: [] };
  const scopedClinicIds = normalizeClinicIdList(clinicIds);

  for (const clinicId of scopedClinicIds) {
    // Keep this per-clinic so clinic-level overrides remain authoritative in aggregate views.
    // eslint-disable-next-line no-await-in-loop
    const [readPatients, readTeam, readLeads] = await Promise.all([
      canUserAccessFeature({
        actorId: userId,
        featureKey: QUICKCHAT_POLICY_FEATURES.read_patients,
        clinicId,
      }),
      canUserAccessFeature({
        actorId: userId,
        featureKey: QUICKCHAT_POLICY_FEATURES.read_team,
        clinicId,
      }),
      canUserAccessFeature({
        actorId: userId,
        featureKey: QUICKCHAT_POLICY_FEATURES.read_leads,
        clinicId,
      }),
    ]);

    if (readPatients) result.patients.push(clinicId);
    if (readTeam) result.team.push(clinicId);
    if (readLeads) result.leads.push(clinicId);
  }

  return result;
}

function buildQuickChatCategoryWhere(allowedClinicIdsByCategory = {}) {
  const orClauses = [];
  const patientClinicIds = normalizeClinicIdList(allowedClinicIdsByCategory.patients || []);
  const teamClinicIds = normalizeClinicIdList(allowedClinicIdsByCategory.team || []);
  const leadClinicIds = normalizeClinicIdList(allowedClinicIdsByCategory.leads || []);

  if (patientClinicIds.length) {
    orClauses.push({
      [Op.and]: [
        { clinic_id: clinicIdCondition(patientClinicIds) },
        { channel: { [Op.ne]: 'internal' } },
        { patient_id: { [Op.not]: null } },
      ],
    });
  }

  if (teamClinicIds.length) {
    orClauses.push({
      [Op.and]: [
        { clinic_id: clinicIdCondition(teamClinicIds) },
        { channel: 'internal' },
      ],
    });
  }

  if (leadClinicIds.length) {
    orClauses.push({
      [Op.and]: [
        { clinic_id: clinicIdCondition(leadClinicIds) },
        { channel: { [Op.ne]: 'internal' } },
        { patient_id: null },
      ],
    });
  }

  if (!orClauses.length) return null;
  return { [Op.or]: orClauses };
}

function buildQuickChatCategorySql(allowedClinicIdsByCategory = {}, replacements = {}) {
  const clauses = [];
  const patientClinicIds = normalizeClinicIdList(allowedClinicIdsByCategory.patients || []);
  const teamClinicIds = normalizeClinicIdList(allowedClinicIdsByCategory.team || []);
  const leadClinicIds = normalizeClinicIdList(allowedClinicIdsByCategory.leads || []);

  if (patientClinicIds.length) {
    replacements.quickchatReadPatientsClinicIds = patientClinicIds;
    clauses.push("(c.clinic_id IN (:quickchatReadPatientsClinicIds) AND c.channel <> 'internal' AND c.patient_id IS NOT NULL)");
  }
  if (teamClinicIds.length) {
    replacements.quickchatReadTeamClinicIds = teamClinicIds;
    clauses.push("(c.clinic_id IN (:quickchatReadTeamClinicIds) AND c.channel = 'internal')");
  }
  if (leadClinicIds.length) {
    replacements.quickchatReadLeadsClinicIds = leadClinicIds;
    clauses.push("(c.clinic_id IN (:quickchatReadLeadsClinicIds) AND c.channel <> 'internal' AND c.patient_id IS NULL)");
  }

  return clauses.length ? `(${clauses.join(' OR ')})` : null;
}

async function canReadQuickChatConversation(userId, conversation) {
  const category = getQuickChatConversationCategory(conversation);
  const featureKey = getQuickChatFeatureForCategory(category);
  const clinicId = Number(conversation?.clinic_id);
  if (!featureKey || !Number.isFinite(clinicId)) {
    return false;
  }
  return canUserAccessFeature({ actorId: userId, featureKey, clinicId });
}

async function ensureQuickChatConversationReadAccess(userId, conversation) {
  const allowed = await canReadQuickChatConversation(userId, conversation);
  if (allowed) return true;

  const category = getQuickChatConversationCategory(conversation);
  const error = new Error('quickchat_category_forbidden');
  error.status = 403;
  error.details = {
    category,
    feature_key: getQuickChatFeatureForCategory(category),
    clinic_id: Number(conversation?.clinic_id) || null,
  };
  throw error;
}

function sendQuickChatCategoryForbidden(res, error = null) {
  return res.status(403).json({
    error: 'Acceso denegado a la categoría de QuickChat',
    details: error?.details || undefined,
  });
}

function parseClinicIdsParam(requestedClinicId) {
  if (requestedClinicId === null || requestedClinicId === undefined) return null;
  if (requestedClinicId === 'all') return 'all';
  const rawParts = String(requestedClinicId)
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  if (!rawParts.length) return null;
  const ids = rawParts.map((p) => Number(p)).filter((n) => Number.isFinite(n));
  if (ids.length !== rawParts.length) return null;
  return ids;
}

function ensureAccess({ clinicIds, isAggregateAllowed }, requestedClinicId) {
  if (!requestedClinicId) return false;
  const parsed = parseClinicIdsParam(requestedClinicId);
  if (parsed === 'all') return isAggregateAllowed;
  if (!parsed) return false;
  return parsed.every((id) => clinicIds.includes(id));
}

async function enrichConversationUnreadForUser(userId, conversationLike) {
  if (!conversationLike) {
    return conversationLike;
  }

  const plain =
    typeof conversationLike.toJSON === 'function'
      ? conversationLike.toJSON()
      : { ...conversationLike };

  const conversationId = Number(plain.id);
  if (!Number.isFinite(conversationId) || !userId) {
    return plain;
  }

  const pendingStates = await getPendingReplyStatesByConversationIds([conversationId], { userId });
  const pendingState = pendingStates.get(conversationId);
  plain.unread_count = pendingState?.unreadCount ?? 0;
  plain.pending_automation_attention = pendingState?.requiresAutomationAttention === true;
  plain.pending_automation_count = pendingState?.requiresAutomationAttention === true
    ? (pendingState?.unreadCount ?? 0)
    : 0;
  if (plain.channel === 'whatsapp') {
    plain.last_inbound_at_any_sender = plain.last_inbound_at || null;
    try {
      const clinicConfig = await whatsappService.getClinicConfig(plain.clinic_id);
      const serviceWindow = await resolveWhatsappServiceWindow({
        conversation: plain,
        activePhoneNumberId: clinicConfig?.phoneNumberId || null,
      });
      plain.whatsapp_service_window_open = serviceWindow.open;
      plain.whatsapp_service_window_last_inbound_at = serviceWindow.lastInboundAt;
      plain.whatsapp_service_window_phone_number_id = serviceWindow.phoneNumberId;
    } catch (error) {
      console.warn('No se pudo resolver la ventana de WhatsApp para QuickChat', {
        conversationId,
        clinicId: plain.clinic_id,
        error: error?.message || error,
      });
      plain.whatsapp_service_window_open = false;
      plain.whatsapp_service_window_last_inbound_at = null;
      plain.whatsapp_service_window_phone_number_id = null;
    }
  }
  const [hydrated] = await hydrateMarketingContactFallbacks([plain]);
  return hydrated || plain;
}

function normalizePhoneDigits(value) {
  return String(value || '').replace(/\D+/g, '').replace(/^00/, '');
}

function buildPhoneSearchCandidates(value) {
  const digits = normalizePhoneDigits(value);
  if (!digits) return [];

  const localDigits = digits.length > 9 && digits.startsWith('34')
    ? digits.slice(-9)
    : (digits.length > 9 ? digits.slice(-9) : digits);
  const candidates = new Set([
    digits,
    `+${digits}`,
    `00${digits}`,
  ]);

  if (localDigits) {
    candidates.add(localDigits);
    candidates.add(`+${localDigits}`);
    candidates.add(`00${localDigits}`);
  }

  if (localDigits.length === 9 && /^[6789]/.test(localDigits)) {
    candidates.add(`34${localDigits}`);
    candidates.add(`+34${localDigits}`);
    candidates.add(`0034${localDigits}`);
  }

  return Array.from(candidates).filter(Boolean);
}

function buildPhoneDigitCandidates(value) {
  return Array.from(new Set(
    buildPhoneSearchCandidates(value)
      .map((candidate) => normalizePhoneDigits(candidate))
      .filter(Boolean)
  ));
}

function isPhoneOnlySearch(value, digits) {
  if (!digits || digits.length < 7) return false;
  return !String(value || '').replace(/[+\d\s().-]/g, '').trim();
}

function sqlPhoneDigitsExpression(expression) {
  return `REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(COALESCE(${expression}, ''), '+', ''), ' ', ''), '-', ''), '(', ''), ')', ''), '.', '')`;
}

function escapeLikePattern(value) {
  return String(value || '').replace(/[\\%_]/g, (match) => `\\${match}`);
}

function normalizeSearchQuery(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function buildPhoneOnlyConversationSearchClause(searchQuery) {
  const phoneCandidates = buildPhoneSearchCandidates(searchQuery);
  const digitCandidates = buildPhoneDigitCandidates(searchQuery);
  const localDigits = normalizePhoneDigits(searchQuery).slice(-9);
  const phoneValuesSql = phoneCandidates.map((value) => db.sequelize.escape(value)).join(', ');
  const digitValuesSql = digitCandidates.map((value) => db.sequelize.escape(value)).join(', ');
  const localDigitsSql = localDigits ? db.sequelize.escape(localDigits) : null;
  const conversationPhoneDigits = sqlPhoneDigitsExpression('`Conversation`.`contact_id`');
  const patientPhoneDigits = sqlPhoneDigitsExpression('`paciente`.`telefono_movil`');
  const leadPhoneDigits = sqlPhoneDigitsExpression('`lead`.`telefono`');
  const externalConversationSql = '(`Conversation`.`patient_id` IS NULL AND `Conversation`.`lead_id` IS NULL)';

  const digitMatchSql = (expression) => {
    const clauses = [];
    if (digitValuesSql) {
      clauses.push(`${expression} IN (${digitValuesSql})`);
    }
    if (localDigitsSql && localDigits.length === 9) {
      clauses.push(`RIGHT(${expression}, 9) = ${localDigitsSql}`);
    }
    return clauses.length ? `(${clauses.join(' OR ')})` : '0 = 1';
  };

  const clauses = [
    ...(phoneCandidates.length ? [
      { contact_id: { [Op.in]: phoneCandidates } },
      { '$paciente.telefono_movil$': { [Op.in]: phoneCandidates } },
      { '$lead.telefono$': { [Op.in]: phoneCandidates } },
    ] : []),
    db.Sequelize.literal(digitMatchSql(conversationPhoneDigits)),
    db.Sequelize.literal(digitMatchSql(patientPhoneDigits)),
    db.Sequelize.literal(digitMatchSql(leadPhoneDigits)),
  ];

  if (phoneValuesSql) {
    clauses.push(db.Sequelize.literal(`
      (
        ${externalConversationSql}
        AND (
          \`Conversation\`.\`id\` IN (
            SELECT DISTINCT mpli.conversation_id
            FROM MarketingPatientListItems mpli
            WHERE mpli.conversation_id IS NOT NULL
              AND mpli.phone IN (${phoneValuesSql})
          )
          OR \`Conversation\`.\`contact_id\` IN (
            SELECT DISTINCT mpli.phone
            FROM MarketingPatientListItems mpli
            WHERE mpli.phone IS NOT NULL
              AND mpli.phone <> ''
              AND mpli.phone IN (${phoneValuesSql})
          )
        )
      )
    `));
  }

  return { [Op.or]: clauses };
}

function buildNameTokenPrefixClause(modelAlias, firstNameField, lastNameField, tokens) {
  if (!tokens.length) return null;
  return {
    [Op.and]: tokens.map((token) => ({
      [Op.or]: [
        { [`$${modelAlias}.${firstNameField}$`]: { [Op.like]: `${escapeLikePattern(token)}%` } },
        { [`$${modelAlias}.${lastNameField}$`]: { [Op.like]: `${escapeLikePattern(token)}%` } },
      ],
    })),
  };
}

function buildSingleFieldTokenContainsClause(modelAlias, fieldName, tokens) {
  if (!tokens.length) return null;
  return {
    [Op.and]: tokens.map((token) => ({
      [`$${modelAlias}.${fieldName}$`]: { [Op.like]: `%${escapeLikePattern(token)}%` },
    })),
  };
}

async function resolveExternalMarketingConversationMatches(searchQuery, clinicIds) {
  const normalized = normalizeSearchQuery(searchQuery);
  const scopedClinicIds = Array.from(new Set(
    (clinicIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0)
  ));
  if (!normalized || !scopedClinicIds.length) {
    return { conversationIds: [], phones: [] };
  }

  const prefix = `${escapeLikePattern(normalized)}%`;
  const rows = await MarketingPatientListItem.findAll({
    where: {
      clinica_id: scopedClinicIds.length === 1 ? scopedClinicIds[0] : { [Op.in]: scopedClinicIds },
      [Op.or]: [
        { name: { [Op.like]: prefix } },
        { email: { [Op.like]: prefix } },
      ],
    },
    attributes: ['conversation_id', 'phone'],
    limit: 100,
    raw: true,
  });

  const conversationIds = new Set();
  const phones = new Set();
  rows.forEach((row) => {
    const conversationId = Number(row.conversation_id);
    if (Number.isInteger(conversationId) && conversationId > 0) {
      conversationIds.add(conversationId);
    }
    buildPhoneSearchCandidates(row.phone).forEach((phone) => phones.add(phone));
  });
  return {
    conversationIds: Array.from(conversationIds),
    phones: Array.from(phones),
  };
}

async function buildConversationSearchClause(searchQuery, { clinicIds = [] } = {}) {
  const normalized = normalizeSearchQuery(searchQuery);
  if (!normalized) {
    return null;
  }

  const normalizedDigits = normalizePhoneDigits(normalized);
  if (isPhoneOnlySearch(normalized, normalizedDigits)) {
    return buildPhoneOnlyConversationSearchClause(normalized);
  }

  const tokens = normalized
    .split(' ')
    .map((token) => token.trim().toLowerCase())
    .filter((token) => token.length >= 2 || /^\d+$/.test(token))
    .slice(0, 6);
  const fullPrefix = `${escapeLikePattern(normalized.toLowerCase())}%`;
  const externalMatches = await resolveExternalMarketingConversationMatches(normalized, clinicIds);
  const clauses = [
    { contact_id: { [Op.like]: fullPrefix } },
    { '$paciente.nombre$': { [Op.like]: fullPrefix } },
    { '$paciente.apellidos$': { [Op.like]: fullPrefix } },
    { '$paciente.email$': { [Op.like]: fullPrefix } },
    { '$lead.nombre$': { [Op.like]: fullPrefix } },
    { '$lead.email$': { [Op.like]: fullPrefix } },
  ];

  const patientTokens = buildNameTokenPrefixClause('paciente', 'nombre', 'apellidos', tokens);
  if (patientTokens) clauses.push(patientTokens);
  const leadTokens = buildSingleFieldTokenContainsClause('lead', 'nombre', tokens);
  if (leadTokens) clauses.push(leadTokens);
  if (externalMatches.conversationIds.length) {
    clauses.push({ id: { [Op.in]: externalMatches.conversationIds } });
  }
  if (externalMatches.phones.length) {
    clauses.push({ contact_id: { [Op.in]: externalMatches.phones } });
  }

  return { [Op.or]: clauses };
}

function buildMarketingContactPhoneCandidates(value) {
  return buildPhoneSearchCandidates(value);
}

function parseCustomFields(value) {
  if (!value) return {};
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeTextSearchValue(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function marketingItemSearchScore(item, searchQuery) {
  const normalized = normalizeTextSearchValue(searchQuery);
  if (!normalized || !item) return 0;

  const fields = parseCustomFields(item.custom_fields);
  const haystack = normalizeTextSearchValue([
    item.name,
    item.phone,
    item.email,
    fields.nombre_completo,
    fields.nombre,
    fields.apellido,
    fields.apellidos,
  ].filter(Boolean).join(' '));
  const tokens = normalized.split(' ').filter((token) => token.length >= 2);
  if (!tokens.length) return haystack.includes(normalized) ? 100 : 0;
  return tokens.every((token) => haystack.includes(token)) ? 100 : 0;
}

function marketingContactMatchScore(item, conversation) {
  if (!item || !conversation) return 0;
  const conversationIdMatches = item.conversation_id && Number(item.conversation_id) === Number(conversation.id);
  const contactDigits = normalizePhoneDigits(conversation.contact_id);
  const itemDigits = normalizePhoneDigits(item.phone);
  const phoneMatches = !!contactDigits && !!itemDigits && (
    contactDigits === itemDigits
    || contactDigits.endsWith(itemDigits)
    || itemDigits.endsWith(contactDigits)
  );

  if (conversationIdMatches && phoneMatches) return 40;
  if (phoneMatches) return 30;
  if (conversationIdMatches && !itemDigits) return 20;
  if (conversationIdMatches) return 10;
  return 0;
}

async function hydrateMarketingContactFallbacks(conversations = [], options = {}) {
  if (!MarketingPatientListItem || !Array.isArray(conversations) || !conversations.length) {
    return conversations;
  }

  const plainRows = conversations.map((conversation) =>
    typeof conversation?.toJSON === 'function' ? conversation.toJSON() : { ...conversation }
  );
  const candidates = plainRows.filter((conversation) =>
    conversation
    && !conversation.paciente
    && !conversation.lead
    && !conversation.patient_id
    && !conversation.lead_id
    && conversation.channel === 'whatsapp'
    && conversation.contact_id
  );
  if (!candidates.length) return plainRows;

  const conversationIds = candidates
    .map((conversation) => Number(conversation.id))
    .filter((id) => Number.isInteger(id) && id > 0);
  const phoneCandidates = Array.from(new Set(
    candidates.flatMap((conversation) => buildMarketingContactPhoneCandidates(conversation.contact_id))
  ));

  const clauses = [];
  if (conversationIds.length) clauses.push({ conversation_id: { [Op.in]: conversationIds } });
  if (phoneCandidates.length) clauses.push({ phone: { [Op.in]: phoneCandidates } });
  if (!clauses.length) return plainRows;

  const items = await MarketingPatientListItem.findAll({
    where: { [Op.or]: clauses },
    attributes: ['id', 'list_id', 'conversation_id', 'name', 'phone', 'email', 'custom_fields', 'updated_at', 'created_at'],
    order: [['updated_at', 'DESC'], ['id', 'DESC']],
    raw: true,
  });
  if (!items.length) return plainRows;

  for (const conversation of plainRows) {
    if (
      conversation.paciente
      || conversation.lead
      || conversation.patient_id
      || conversation.lead_id
      || conversation.channel !== 'whatsapp'
      || !conversation.contact_id
    ) {
      continue;
    }
    let item = null;
    let bestScore = 0;
    for (const row of items) {
      const score = marketingContactMatchScore(row, conversation)
        + marketingItemSearchScore(row, options.searchQuery);
      if (score > bestScore) {
        item = row;
        bestScore = score;
      }
    }
    if (!item?.name) continue;
    const fields = parseCustomFields(item.custom_fields);
    const contactName = fields.nombre_completo || item.name;
    conversation.contact = {
      ...(conversation.contact || {}),
      name: contactName,
      phone: item.phone || conversation.contact_id,
      email: item.email || null,
      source: 'marketing_patient_list',
      list_id: item.list_id || null,
    };
  }

  return plainRows;
}

exports.listConversations = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const { clinic_id, filter, channel } = req.query;
    const searchQuery = String(req.query.q || req.query.search || '').trim();
    const patientId = req.query.patient_id ? Number(req.query.patient_id) : null;
    const leadId = req.query.lead_id ? Number(req.query.lead_id) : null;
    const limit = Math.min(100, Math.max(20, Number.parseInt(req.query.limit || '50', 10) || 50));
    const offset = Math.max(0, Number.parseInt(req.query.offset || '0', 10) || 0);

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!clinicIds.length) {
      return res.status(403).json({ error: 'Sin clínicas asignadas' });
    }

    const where = {};
    const scope = resolveConversationClinicScope({ clinicIds, isAggregateAllowed, requestedClinicId: clinic_id });
    if (scope.error || !scope.clinicIds.length) {
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }
    where.clinic_id = clinicIdCondition(scope.clinicIds);

    const allowedClinicIdsByCategory = await getAllowedQuickChatClinicIdsByCategory(userId, scope.clinicIds);
    const categoryWhere = buildQuickChatCategoryWhere(allowedClinicIdsByCategory);
    if (!categoryWhere) {
      res.set('X-Has-More', 'false');
      res.set('X-Next-Offset', String(offset));
      res.set('X-Total-Unread', '0');
      return res.json([]);
    }
    where[Op.and] = [categoryWhere];

    let patient = null;
    let lead = null;
    let canonicalConversationId = null;
    if (patientId) {
      patient = await Paciente.findByPk(patientId, {
        attributes: ['id_paciente', 'clinica_id', 'telefono_movil'],
        raw: true,
      });
      if (!patient) {
        return res.status(404).json({ error: 'Paciente no encontrado' });
      }
      const parsed = clinic_id && clinic_id !== 'all' ? parseClinicIdsParam(clinic_id) : null;
      const clinicToResolve =
        Array.isArray(parsed) && parsed.length
          ? parsed[0]
          : (clinicIds.includes(patient.clinica_id) ? patient.clinica_id : clinicIds[0]);
      const canonical = await findCanonicalWhatsappConversation({
        clinicId: clinicToResolve,
        contactId: patient.telefono_movil,
        patientId,
        createIfMissing: false,
      });
      canonicalConversationId = canonical?.id || null;
      if (clinic_id && clinic_id !== 'all') {
        if (!parsed || !ensureAccess({ clinicIds, isAggregateAllowed }, clinic_id)) {
          return res.status(403).json({ error: 'Acceso denegado a la clínica' });
        }
        where.clinic_id = parsed.length === 1 ? parsed[0] : { [Op.in]: parsed };
      } else if (!isAggregateAllowed) {
        where.clinic_id = { [Op.in]: clinicIds };
      }
    } else if (leadId) {
      lead = await LeadIntake.findByPk(leadId, {
        attributes: ['id', 'clinica_id', 'telefono'],
        raw: true,
      });
      if (!lead) {
        return res.status(404).json({ error: 'Lead no encontrado' });
      }
      const parsed = clinic_id && clinic_id !== 'all' ? parseClinicIdsParam(clinic_id) : null;
      const clinicToResolve =
        Array.isArray(parsed) && parsed.length
          ? parsed[0]
          : (clinicIds.includes(lead.clinica_id) ? lead.clinica_id : clinicIds[0]);
      const canonical = await findCanonicalWhatsappConversation({
        clinicId: clinicToResolve,
        contactId: lead.telefono,
        leadId,
        createIfMissing: false,
      });
      canonicalConversationId = canonical?.id || null;
      if (clinic_id && clinic_id !== 'all') {
        if (!parsed || !ensureAccess({ clinicIds, isAggregateAllowed }, clinic_id)) {
          return res.status(403).json({ error: 'Acceso denegado a la clínica' });
        }
        where.clinic_id = parsed.length === 1 ? parsed[0] : { [Op.in]: parsed };
      } else if (!isAggregateAllowed) {
        where.clinic_id = { [Op.in]: clinicIds };
      }
    } else if (clinic_id && clinic_id !== 'all') {
      const parsed = parseClinicIdsParam(clinic_id);
      if (!parsed || !ensureAccess({ clinicIds, isAggregateAllowed }, clinic_id)) {
        return res.status(403).json({ error: 'Acceso denegado a la clínica' });
      }
      where.clinic_id = parsed.length === 1 ? parsed[0] : { [Op.in]: parsed };
    } else if (!isAggregateAllowed) {
      where.clinic_id = { [Op.in]: clinicIds };
    }

    if (channel) {
      where.channel = channel;
    }

    if (filter === 'leads') {
      // La pestaña "Otros" agrupa leads y conversaciones externas de campañas.
      // Si ya existe paciente, debe vivir solo en la pestaña de pacientes.
      where.patient_id = null;
      where[Op.or] = [
        { lead_id: { [Op.not]: null } },
        {
          id: {
            [Op.in]: db.sequelize.literal(
              '(SELECT DISTINCT conversation_id FROM MarketingPatientListItems WHERE conversation_id IS NOT NULL)'
            ),
          },
        },
      ];
    } else if (filter === 'pacientes') {
      where.patient_id = { [Op.not]: null };
    } else if (filter === 'equipo') {
      where.channel = 'internal';
    }

    if (canonicalConversationId) {
      where.id = canonicalConversationId;
    } else if (patientId) {
      where.patient_id = patientId;
    } else if (leadId) {
      where.lead_id = leadId;
    }

    if (searchQuery) {
      const searchClause = await buildConversationSearchClause(searchQuery, {
        clinicIds: scope.clinicIds,
      });
      where[Op.and] = [
        ...(where[Op.and] || []),
        searchClause,
      ];
    }

    const conversationsPlusOne = await Conversation.findAll({
      where,
      order: [['last_message_at', 'DESC'], ['createdAt', 'DESC'], ['id', 'DESC']],
      limit: limit + 1,
      offset,
      include: [
        { model: Paciente, as: 'paciente', attributes: ['id_paciente', 'public_id', 'nombre', 'apellidos', 'foto', 'telefono_movil', 'email'] },
        { model: LeadIntake, as: 'lead', attributes: ['id', 'nombre', 'telefono', 'email', 'status_lead', 'call_initiated'] },
        {
          model: Message,
          as: 'messages',
          separate: true,
          limit: 6,
          order: messageChronologicalOrder('DESC'),
          attributes: ['id', 'direction', 'content', 'message_type', 'status', 'sent_at', 'createdAt', 'metadata'],
        },
      ],
    });
    const hasMore = conversationsPlusOne.length > limit;
    const conversations = hasMore ? conversationsPlusOne.slice(0, limit) : conversationsPlusOne;

    const conversationIds = conversations.map((c) => c.id);
    const pendingStates = await getPendingReplyStatesByConversationIds(conversationIds, { userId });

    const rawPayload = await Promise.all(conversations.map(async (c) => {
      const data = c.toJSON();
      const recentMessages = await hydrateTemplateMessagePreviews(
        filterQuickChatVisibleMessages(data.messages),
        { clinicId: data.clinic_id }
      );
      data.lastMessage = recentMessages.find((message) => !isTechnicalWhatsappFailureNotice(message))
        || recentMessages[0]
        || null;
      delete data.messages;
      const pendingState = pendingStates.get(Number(data.id));
      data.unread_count = pendingState?.unreadCount ?? 0;
      data.pending_automation_attention = pendingState?.requiresAutomationAttention === true;
      data.pending_automation_count = pendingState?.requiresAutomationAttention === true
        ? (pendingState?.unreadCount ?? 0)
        : 0;
      return data;
    }));
    const payload = await hydrateMarketingContactFallbacks(rawPayload, { searchQuery });
    const totalUnread = payload.reduce((total, item) => {
      const unread = Number(item?.unread_count || 0);
      const automationPending = item?.pending_automation_attention
        ? Number(item?.pending_automation_count || 0)
        : 0;
      return total + Math.max(unread, automationPending);
    }, 0);

    res.set('X-Has-More', hasMore ? 'true' : 'false');
    res.set('X-Next-Offset', String(offset + payload.length));
    res.set('X-Total-Unread', String(totalUnread || 0));
    return res.json(payload);
  } catch (err) {
    console.error('Error listConversations', err);
    return res.status(500).json({ error: 'Error obteniendo conversaciones' });
  }
};

exports.getPermissions = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const requestedClinic = req.query?.clinic_id;
    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);

    if (!clinicIds.length) {
      return res.status(403).json({
        selected_clinic_id: null,
        read_patients: false,
        read_team: false,
        read_leads: false,
        can_use_all_clinics: false,
        effective_role: 'unknown',
      });
    }

    let selectedClinicId = null;
    const parsed = parseClinicIdsParam(requestedClinic);
    if (Array.isArray(parsed) && parsed.length === 1) {
      selectedClinicId = parsed[0];
    }

    const memberships = await UsuarioClinica.findAll({
      where: { id_usuario: userId },
      attributes: ['id_clinica', 'rol_clinica'],
      raw: true,
    });
    const selectedMembership =
      memberships.find((m) => Number(m.id_clinica) === Number(selectedClinicId)) ||
      memberships[0] ||
      null;
    const effectiveRole = String(selectedMembership?.rol_clinica || 'unknown').toLowerCase();
    const policyPerms = await getQuickChatPolicyPermissions(userId, clinicIds, selectedClinicId);

    return res.json({
      selected_clinic_id: selectedClinicId,
      read_patients: policyPerms.read_patients,
      read_team: policyPerms.read_team,
      read_leads: policyPerms.read_leads,
      can_use_all_clinics: !!isAggregateAllowed,
      effective_role: effectiveRole,
    });
  } catch (err) {
    console.error('Error getPermissions', err);
    return res.status(500).json({ error: 'Error obteniendo permisos de conversaciones' });
  }
};

exports.getConversationPermissions = exports.getPermissions;

exports.getMessages = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const conversationId = req.params.id;
    let conversation = await Conversation.findByPk(conversationId, {
      include: [
        { model: Paciente, as: 'paciente', attributes: ['id_paciente', 'public_id', 'nombre', 'apellidos', 'foto', 'telefono_movil', 'email'] },
        { model: LeadIntake, as: 'lead', attributes: ['id', 'nombre', 'telefono', 'email', 'status_lead', 'call_initiated'] },
      ],
    });
    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    if (conversation.channel === 'whatsapp' && conversation.contact_id) {
      const canonical = await findCanonicalWhatsappConversation({
        clinicId: conversation.clinic_id,
        contactId: conversation.contact_id,
        patientId: conversation.patient_id || null,
        leadId: conversation.lead_id || null,
        createIfMissing: false,
      });
      if (canonical?.id && Number(canonical.id) !== Number(conversation.id)) {
        conversation = await Conversation.findByPk(canonical.id, {
          include: [
            { model: Paciente, as: 'paciente', attributes: ['id_paciente', 'public_id', 'nombre', 'apellidos', 'foto', 'telefono_movil', 'email'] },
            { model: LeadIntake, as: 'lead', attributes: ['id', 'nombre', 'telefono', 'email', 'status_lead', 'call_initiated'] },
          ],
        });
      }
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!ensureAccess({ clinicIds, isAggregateAllowed }, conversation.clinic_id)) {
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }
    try {
      await ensureQuickChatConversationReadAccess(userId, conversation);
    } catch (accessError) {
      return sendQuickChatCategoryForbidden(res, accessError);
    }

    const messages = await Message.findAll({
      where: { conversation_id: conversation.id },
      order: messageChronologicalOrder('ASC'),
      raw: true,
    });

    const conversationPayload = await enrichConversationUnreadForUser(userId, conversation);
    const visibleMessages = await hydrateTemplateMessagePreviews(
      filterQuickChatVisibleMessages(messages),
      { clinicId: conversation.clinic_id }
    );
    return res.json({ conversation: conversationPayload, messages: visibleMessages });
  } catch (err) {
    console.error('Error getMessages', err);
    return res.status(500).json({ error: 'Error obteniendo mensajes' });
  }
};

exports.streamMessageMedia = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const messageId = Number(req.params.messageId || req.params.message_id);
    if (!Number.isFinite(messageId) || messageId <= 0) {
      return res.status(400).json({ error: 'message_id_invalid' });
    }

    const message = await Message.findByPk(messageId, { raw: true });
    if (!message) {
      return res.status(404).json({ error: 'message_not_found' });
    }

    const conversation = await Conversation.findByPk(message.conversation_id, { raw: true });
    if (!conversation) {
      return res.status(404).json({ error: 'conversation_not_found' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!ensureAccess({ clinicIds, isAggregateAllowed }, conversation.clinic_id)) {
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }
    try {
      await ensureQuickChatConversationReadAccess(userId, conversation);
    } catch (accessError) {
      return sendQuickChatCategoryForbidden(res, accessError);
    }

    const metadata = message.metadata || {};
    const media = metadata.media || {};
    const kind = String(media.kind || '').toLowerCase();
    const mediaId = String(media.id || '').trim();
    if (!STREAMABLE_MEDIA_KINDS.has(kind) || !mediaId) {
      return res.status(410).json({ error: unavailableMediaError(kind) });
    }

    const clinicConfig = await whatsappService.getClinicConfig(conversation.clinic_id);
    if (!clinicConfig?.accessToken) {
      return res.status(410).json({ error: unavailableMediaError(kind) });
    }

    try {
      const { buffer, contentType, mediaInfo } = await whatsappService.downloadMediaBuffer({
        mediaId,
        accessToken: clinicConfig.accessToken,
      });
      const mimeType = normalizeMediaMimeType(
        contentType || mediaInfo?.mime_type || media.mime_type,
        getDefaultMimeTypeForKind(kind)
      );
      const extension = extensionForMediaMimeType(mimeType, kind);
      const disposition = INLINE_MEDIA_KINDS.has(kind) ? 'inline' : 'attachment';
      res.set({
        'Content-Type': mimeType,
        'Content-Length': buffer.length,
        'Cache-Control': 'no-store',
        'Content-Disposition': `${disposition}; filename="whatsapp-${kind}-${messageId}.${extension}"`,
      });
      return res.send(buffer);
    } catch (downloadError) {
      const status = downloadError?.response?.status;
      if ([400, 401, 403, 404, 410].includes(Number(status))) {
        return res.status(410).json({ error: unavailableMediaError(kind) });
      }
      console.error('Error streamMessageMedia', downloadError?.message || downloadError);
      return res.status(502).json({ error: downloadFailedMediaError(kind) });
    }
  } catch (err) {
    console.error('Error streamMessageMedia', err);
    return res.status(500).json({ error: 'Error obteniendo media' });
  }
};

exports.getConversationByPatient = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const patientId = req.params.patientId || req.params.patient_id;
    const patient = await Paciente.findByPk(patientId, {
      attributes: ['id_paciente', 'clinica_id', 'telefono_movil'],
      raw: true,
    });
    const conversation = patient
      ? await findCanonicalWhatsappConversation({
          clinicId: patient.clinica_id,
          contactId: patient.telefono_movil,
          patientId: Number(patientId),
          createIfMissing: false,
        })
      : null;

    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!ensureAccess({ clinicIds, isAggregateAllowed }, conversation.clinic_id)) {
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }
    try {
      await ensureQuickChatConversationReadAccess(userId, conversation);
    } catch (accessError) {
      return sendQuickChatCategoryForbidden(res, accessError);
    }

    const messages = await Message.findAll({
      where: { conversation_id: conversation.id },
      order: messageChronologicalOrder('ASC'),
      raw: true,
    });

    const conversationPayload = await enrichConversationUnreadForUser(userId, conversation);
    const visibleMessages = await hydrateTemplateMessagePreviews(
      filterQuickChatVisibleMessages(messages),
      { clinicId: conversation.clinic_id }
    );
    return res.json({ conversation: conversationPayload, messages: visibleMessages });
  } catch (err) {
    console.error('Error getConversationByPatient', err);
    return res.status(500).json({ error: 'Error obteniendo conversación' });
  }
};

exports.getConversationByLead = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const leadId = req.params.leadId || req.params.lead_id;
    const shouldCreate = ['1', 'true', 'yes'].includes(String(req.query.create_if_missing || req.query.create || '').toLowerCase());
    const requestedClinicId = Number(req.query.clinic_id || req.query.clinicId || 0);
    const lead = await LeadIntake.findByPk(leadId, {
      attributes: ['id', 'clinica_id', 'telefono'],
    });
    if (!lead) {
      return res.status(404).json({ error: 'Lead no encontrado' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    const leadClinicId = Number(lead.clinica_id || 0);
    const clinicToResolve = Number.isInteger(requestedClinicId) && requestedClinicId > 0
      ? requestedClinicId
      : leadClinicId;
    if (!Number.isInteger(clinicToResolve) || clinicToResolve <= 0) {
      return res.status(400).json({ error: 'clinic_id_required' });
    }
    if (leadClinicId && Number(clinicToResolve) !== leadClinicId) {
      return res.status(400).json({ error: 'lead_clinic_mismatch' });
    }
    if (!ensureAccess({ clinicIds, isAggregateAllowed }, clinicToResolve)) {
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }

    const contactPhone = await resolveLeadWhatsappPhone(lead);
    const conversation = await findCanonicalWhatsappConversation({
      clinicId: clinicToResolve,
      contactId: contactPhone,
      leadId: Number(leadId),
      createIfMissing: shouldCreate,
    });

    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    if (!ensureAccess({ clinicIds, isAggregateAllowed }, conversation.clinic_id)) {
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }
    try {
      await ensureQuickChatConversationReadAccess(userId, conversation);
    } catch (accessError) {
      return sendQuickChatCategoryForbidden(res, accessError);
    }

    const messages = await Message.findAll({
      where: { conversation_id: conversation.id },
      order: messageChronologicalOrder('ASC'),
      raw: true,
    });

    const conversationPayload = await enrichConversationUnreadForUser(userId, conversation);
    const visibleMessages = await hydrateTemplateMessagePreviews(
      filterQuickChatVisibleMessages(messages),
      { clinicId: conversation.clinic_id }
    );
    return res.json({ conversation: conversationPayload, messages: visibleMessages });
  } catch (err) {
    console.error('Error getConversationByLead', err);
    return res.status(500).json({ error: 'Error obteniendo conversación' });
  }
};

exports.startPatientContact = async (req, res) => {
  let transaction = null;
  try {
    const userId = Number(req.userData?.userId);
    const clinicId = Number(req.body?.clinic_id || req.body?.clinicId || 0);
    const patientId = Number(req.body?.patient_id || req.body?.patientId || 0) || null;
    if (!Number.isInteger(clinicId) || clinicId <= 0) {
      return res.status(400).json({ error: 'clinic_id_required' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!ensureAccess({ clinicIds, isAggregateAllowed }, clinicId)) {
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }
    const [canReadPatients, canEditPatients] = await Promise.all([
      canUserAccessFeature({ actorId: userId, featureKey: 'quickchat.read_patients', clinicId }),
      canUserAccessFeature({ actorId: userId, featureKey: 'patients.edit', clinicId }),
    ]);
    if (!canReadPatients || !canEditPatients) {
      return res.status(403).json({ error: 'patient_contact_forbidden' });
    }

    const clinic = await Clinica.findByPk(clinicId, {
      attributes: ['id_clinica', 'grupoClinicaId'],
      raw: true,
    });
    if (!clinic) {
      return res.status(404).json({ error: 'clinic_not_found' });
    }
    const duplicateScopeClinics = clinic.grupoClinicaId
      ? await Clinica.findAll({
          where: { grupoClinicaId: clinic.grupoClinicaId },
          attributes: ['id_clinica'],
          raw: true,
        })
      : [clinic];

    transaction = await db.sequelize.transaction();
    const result = await startPatientWhatsappConversation({
      patientId,
      phone: req.body?.phone || req.body?.telefono,
      firstName: req.body?.first_name || req.body?.nombre,
      lastName: req.body?.last_name || req.body?.apellidos,
      clinicId,
      duplicateScopeClinicIds: duplicateScopeClinics.map((item) => Number(item.id_clinica)),
      actorUserId: userId,
      authorizationConfirmed: req.body?.authorization_confirmed === true,
      source: 'quick_chat',
      transaction,
    });

    const conversation = await Conversation.findByPk(result.conversation.id, {
      include: [{
        model: Paciente,
        as: 'paciente',
        attributes: ['id_paciente', 'public_id', 'nombre', 'apellidos', 'foto', 'telefono_movil', 'email'],
      }],
      transaction,
    });
    await ensureQuickChatConversationReadAccess(userId, conversation);
    await transaction.commit();
    transaction = null;

    let payload = typeof conversation?.toJSON === 'function'
      ? conversation.toJSON()
      : conversation;
    try {
      payload = await enrichConversationUnreadForUser(userId, conversation);
    } catch (enrichmentError) {
      console.warn('No se pudo enriquecer la conversación recién iniciada', {
        conversationId: conversation?.id,
        error: enrichmentError?.message || enrichmentError,
      });
    }
    return res.status(result.conversationCreated ? 201 : 200).json({
      conversation: payload,
      messages: [],
      patient: result.patient,
      patient_created: result.patientCreated,
      conversation_created: result.conversationCreated,
      authorization_recorded: result.authorizationRecorded,
    });
  } catch (err) {
    if (transaction && !transaction.finished) {
      await transaction.rollback();
    }
    const status = Number(err?.status) || 500;
    const knownErrors = new Set([
      'patient_not_found',
      'patient_not_linked_to_clinic',
      'patient_exists_in_group',
      'patient_name_required',
      'patient_phone_required',
      'valid_phone_required',
      'whatsapp_contact_authorization_required',
    ]);
    if (knownErrors.has(err?.message)) {
      return res.status(status).json({
        error: err.message,
        message: err.message === 'patient_exists_in_group'
          ? 'Ya existe un paciente con este teléfono en otra clínica del grupo. Usa Crear paciente para revisarlo y asociarlo sin duplicar la ficha.'
          : undefined,
      });
    }
    console.error('Error startPatientContact', err);
    return res.status(500).json({ error: 'patient_contact_start_failed' });
  }
};

exports.markAsRead = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const conversationId = req.params.id;
    const conversation = await Conversation.findByPk(conversationId);
    if (!conversation) {
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!ensureAccess({ clinicIds, isAggregateAllowed }, conversation.clinic_id)) {
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }
    try {
      await ensureQuickChatConversationReadAccess(userId, conversation);
    } catch (accessError) {
      return sendQuickChatCategoryForbidden(res, accessError);
    }

    await ConversationRead.upsert({
      conversation_id: conversation.id,
      user_id: userId,
      last_read_at: new Date(),
    });

    const io = getIO();
    if (io) {
      io.to(`user:${userId}`).emit('conversation:read', {
        id: conversation.id,
        unread_count: 0,
      });
    }

    // La lectura oculta también el indicador amarillo para este usuario, pero
    // conserva la notificación de automatización como trazabilidad operativa.
    // Una respuesta saliente limpia el pendiente para todos.
    return res.json({ success: true });
  } catch (err) {
    console.error('Error markAsRead', err);
    return res.status(500).json({ error: 'Error marcando conversación como leída' });
  }
};

exports.postMessage = async (req, res) => {
  const transaction = await db.sequelize.transaction();
  try {
    const userId = req.userData?.userId;
    const conversationId = req.params.id;
    const {
      message,
      message_type = 'text',
      useTemplate = false,
      templateId,
      templateName,
      templateLanguage,
      templateParams,
      templateComponents,
      previewUrl = false,
      metadata = {},
    } = req.body;
    let outboundJobPayload = null;

    let conversation = await Conversation.findByPk(conversationId, { transaction });
    if (!conversation) {
      await transaction.rollback();
      return res.status(404).json({ error: 'Conversación no encontrada' });
    }

    if (conversation.channel === 'whatsapp' && conversation.contact_id) {
      const canonical = await findCanonicalWhatsappConversation({
        clinicId: conversation.clinic_id,
        contactId: conversation.contact_id,
        patientId: conversation.patient_id || null,
        leadId: conversation.lead_id || null,
        createIfMissing: false,
        transaction,
      });
      if (canonical?.id) {
        conversation = canonical;
      }
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!ensureAccess({ clinicIds, isAggregateAllowed }, conversation.clinic_id)) {
      await transaction.rollback();
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }
    try {
      await ensureQuickChatConversationReadAccess(userId, conversation);
    } catch (accessError) {
      await transaction.rollback();
      return sendQuickChatCategoryForbidden(res, accessError);
    }

    const isTemplate = useTemplate || message_type === 'template';

    const io = getIO();
    let clinicConfig = null;
    let limitStatus = null;
    let to = null;
    let resolvedTemplate = null;
    let canonicalTemplateName = null;
    let canonicalTemplateLanguage = null;
    if (conversation.channel === 'whatsapp') {
      let preferredPhone = null;
      if (conversation.patient_id) {
        const patient = await Paciente.findByPk(conversation.patient_id, {
          attributes: ['telefono_movil'],
          transaction,
        });
        preferredPhone = patient?.telefono_movil || null;
      }
      if (!preferredPhone && conversation.lead_id) {
        const lead = await LeadIntake.findByPk(conversation.lead_id, {
          attributes: ['telefono'],
          transaction,
        });
        preferredPhone = lead?.telefono || null;
      }
      to = whatsappService.normalizePhoneNumber(preferredPhone)
        || whatsappService.normalizePhoneNumber(conversation.contact_id)
        || null;
      if (!to) {
        await transaction.rollback();
        return res.status(400).json({ error: 'contacto_sin_numero' });
      }
      if (conversation.contact_id !== to) {
        conversation.contact_id = to;
        await conversation.save({ transaction });
      }
      clinicConfig = await whatsappService.getClinicConfig(conversation.clinic_id);
      if (!clinicConfig?.accessToken || !clinicConfig?.phoneNumberId) {
        await transaction.rollback();
        return res.status(500).json({ error: 'whatsapp_config_missing' });
      }
      if (!isTemplate) {
        const serviceWindow = await resolveWhatsappServiceWindow({
          conversation,
          activePhoneNumberId: clinicConfig.phoneNumberId,
          transaction,
        });
        if (!serviceWindow.open) {
          await transaction.rollback();
          return res.status(400).json({
            error: 'session_closed',
            reason: 'sender_service_window_closed',
            phone_number_id: serviceWindow.phoneNumberId,
            last_inbound_at: serviceWindow.lastInboundAt,
          });
        }
      }
      if (isTemplate) {
        const safeTemplateId = Number(templateId || 0);
        const safeTemplateName = String(templateName || '').trim();
        const safeTemplateLanguage = String(templateLanguage || '').trim();
        if (!safeTemplateName && !(Number.isInteger(safeTemplateId) && safeTemplateId > 0)) {
          await transaction.rollback();
          return res.status(400).json({ error: 'whatsapp_template_reference_required' });
        }

        const effectiveWabaId = String(clinicConfig.wabaId || '').trim();
        const templateScopes = [
          { waba_id: null, clinic_id: conversation.clinic_id },
          ...(effectiveWabaId ? [{ waba_id: effectiveWabaId }] : []),
        ];
        const hasTemplateId = Number.isInteger(safeTemplateId) && safeTemplateId > 0;
        const templateWhere = {
          is_active: true,
          status: 'APPROVED',
          [Op.or]: templateScopes,
          ...(hasTemplateId ? { id: safeTemplateId } : { name: safeTemplateName }),
          ...(!hasTemplateId && safeTemplateLanguage ? { language: safeTemplateLanguage } : {}),
        };
        resolvedTemplate = await WhatsappTemplate.findOne({ where: templateWhere, transaction });
        if (!resolvedTemplate) {
          await transaction.rollback();
          return res.status(404).json({ error: 'whatsapp_template_not_available' });
        }
        const templateJson = resolvedTemplate.get
          ? resolvedTemplate.get({ plain: true })
          : resolvedTemplate;
        if (!canUserSelectWhatsappTemplate(templateJson, userId)) {
          await transaction.rollback();
          return res.status(403).json({
            error: 'whatsapp_template_owner_forbidden',
            message: 'Esta plantilla pertenece a otro usuario.',
          });
        }
        if (isReviewWorkflowWhatsappTemplate(templateJson)) {
          await transaction.rollback();
          return res.status(409).json({
            error: 'whatsapp_template_requires_workflow',
            message: 'Esta plantilla inicia un flujo de reseñas y debe enviarse desde Campañas.',
          });
        }
        canonicalTemplateName = String(templateJson.name || '').trim();
        canonicalTemplateLanguage = String(templateJson.language || '').trim() || 'es';
      }
      limitStatus = await whatsappService.checkOutboundLimit({
        clinicConfig,
        conversation,
      });
    }

    const baseMetadata = {
      ...(metadata || {}),
      ...(templateParams ? { templateParams } : {}),
      ...(templateComponents ? { templateComponents } : {}),
      ...(resolvedTemplate?.id ? { template_id: Number(resolvedTemplate.id) } : {}),
      ...(canonicalTemplateName ? { template_name: canonicalTemplateName } : {}),
      ...(canonicalTemplateLanguage ? { template_language: canonicalTemplateLanguage } : {}),
      ...(clinicConfig?.phoneNumberId
        ? { phoneNumberId: clinicConfig.phoneNumberId }
        : {}),
      ...(clinicConfig?.wabaId ? { wabaId: clinicConfig.wabaId } : {}),
      ...(limitStatus?.limitedMode
        ? {
            limitedMode: true,
            limitSnapshot: {
              count: limitStatus.count,
              limit: limitStatus.limit,
            },
          }
        : {}),
    };

    // Si el numero esta en modo limitado y se alcanzo el cupo, cortamos el envio
    if (limitStatus?.limitReached) {
      const limitMeta = {
        ...baseMetadata,
        limitReason: 'limit_reached',
        limitExceededAt: new Date().toISOString(),
      };
      const limitedMsg = await Message.create(
        {
          conversation_id: conversation.id,
          sender_id: userId || null,
          direction: 'outbound',
          content: message,
          message_type: message_type === 'template' ? 'template' : 'text',
          status: 'failed',
          sent_at: new Date(),
          metadata: limitMeta,
        },
        { transaction }
      );

      conversation.last_message_at = new Date();
      await conversation.save({ transaction });
      await transaction.commit();

      if (io) {
        const room = `clinic:${conversation.clinic_id}`;
        const payload = {
          id: limitedMsg.id,
          conversation_id: conversation.id,
          content: limitedMsg.content,
          direction: limitedMsg.direction,
          message_type: limitedMsg.message_type,
          status: limitedMsg.status,
          sent_at: limitedMsg.sent_at,
        };
        io.to(room).emit('message:created', payload);
        io.to(room).emit('message:updated', {
          id: limitedMsg.id,
          conversation_id: conversation.id,
          status: 'failed',
          error: 'limit_reached',
          limit: {
            count: limitStatus.count,
            limit: limitStatus.limit,
          },
        });
      }

      return res.status(429).json({
        error: 'limit_reached',
        limit: limitStatus,
        message: limitedMsg,
      });
    }

    // Crear registro de mensaje en estado pending/sent
    const msg = await Message.create(
      {
        conversation_id: conversation.id,
        sender_id: userId || null,
        direction: 'outbound',
        content: message,
        message_type: message_type === 'template' ? 'template' : 'text',
        status: conversation.channel === 'whatsapp' ? 'pending' : 'sent',
        sent_at: new Date(),
        metadata: baseMetadata,
      },
      { transaction }
    );

    // Emit creación de mensaje outbound (aplica también a interno/instagram)
    if (io) {
      const rooms = new Set();
      if (conversation.clinic_id) rooms.add(`clinic:${conversation.clinic_id}`);
      if (conversation.assignee_id) rooms.add(`user:${conversation.assignee_id}`);
      const payload = {
        id: msg.id,
        conversation_id: String(conversation.id),
        content: msg.content,
        direction: msg.direction,
        message_type: msg.message_type,
        status: msg.status,
        sent_at: msg.sent_at,
      };
      if (rooms.size === 0) {
        io.emit('message:created', payload);
        if (process.env.CHAT_DEBUG === 'true') {
          console.log('[CHAT] Emit outbound message:created broadcast', { payload });
        }
      } else {
        rooms.forEach((r) => io.to(r).emit('message:created', payload));
        if (process.env.CHAT_DEBUG === 'true') {
          console.log('[CHAT] Emit outbound message:created rooms', { rooms: Array.from(rooms), payload });
        }
      }
    }

    if (conversation.channel === 'whatsapp') {
      // Encolar solo despues del commit para evitar carreras con la transaccion
      outboundJobPayload = {
        messageId: msg.id,
        conversationId: conversation.id,
        to,
        body: message,
        previewUrl,
        useTemplate: isTemplate,
        templateName: canonicalTemplateName || templateName,
        templateLanguage: canonicalTemplateLanguage || templateLanguage,
        templateParams,
        templateComponents,
        clinicConfig,
      };
    }

    conversation.last_message_at = new Date();
    await conversation.save({ transaction });

    // No emitir conversation:updated aquí para evitar sobrescribir unread_count del usuario.

    await transaction.commit();

    let outboundWhatsappQueued = false;
    if (outboundJobPayload) {
      try {
        await queues.outboundWhatsApp.add('send', outboundJobPayload);
        outboundWhatsappQueued = true;
      } catch (enqueueErr) {
        console.error('Error encolando outbound WhatsApp', enqueueErr);
        const errorMetadata = {
          ...(msg.metadata || {}),
          enqueue_error: enqueueErr?.message || 'enqueue_failed',
        };
        await Message.update(
          { status: 'failed', metadata: errorMetadata },
          { where: { id: msg.id } }
        );
        const io = getIO();
        if (io) {
          const room = `clinic:${conversation.clinic_id}`;
          io.to(room).emit('message:updated', {
            id: msg.id,
            conversation_id: conversation.id,
            status: 'failed',
          });
        }
        msg.status = 'failed';
        msg.metadata = errorMetadata;
      }
    }

    if (outboundWhatsappQueued && conversation.lead_id) {
      try {
        await registerLeadWhatsappContactAttempt({
          leadId: conversation.lead_id,
          userId,
          isTemplate,
          body: message,
        });
      } catch (leadContactErr) {
        console.warn('No se pudo registrar intento WhatsApp del lead', {
          leadId: conversation.lead_id,
          conversationId: conversation.id,
          error: leadContactErr?.message || leadContactErr,
        });
      }
    }

    return res.json({ message: msg });
  } catch (err) {
    await transaction.rollback();
    console.error('Error postMessage', err);
    return res.status(500).json({ error: 'Error enviando mensaje' });
  }
};

exports.sendScheduledMessageNow = async (req, res) => {
  try {
    const userId = req.userData?.userId;
    const messageId = Number(req.params.messageId || req.params.message_id);
    if (!Number.isFinite(messageId) || messageId <= 0) {
      return res.status(400).json({ error: 'message_id_required' });
    }

    const msg = await Message.findByPk(messageId);
    if (!msg) {
      return res.status(404).json({ error: 'message_not_found' });
    }
    const conversation = await Conversation.findByPk(msg.conversation_id);
    if (!conversation) {
      return res.status(404).json({ error: 'conversation_not_found' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!ensureAccess({ clinicIds, isAggregateAllowed }, conversation.clinic_id)) {
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }
    try {
      await ensureQuickChatConversationReadAccess(userId, conversation);
    } catch (accessError) {
      return sendQuickChatCategoryForbidden(res, accessError);
    }
    if (conversation.channel !== 'whatsapp' || msg.direction !== 'outbound') {
      return res.status(400).json({ error: 'not_whatsapp_outbound_message' });
    }

    const metadata = msg.metadata || {};
    const wasQueuedByQuietHours = metadata.queued_by_quiet_hours === true || metadata.queued_by_quiet_hours === 'true';
    if (!wasQueuedByQuietHours) {
      return res.status(400).json({ error: 'message_not_scheduled_by_quiet_hours' });
    }

    const status = String(msg.status || '').toLowerCase();
    if (['sent', 'delivered', 'read'].includes(status)) {
      return res.json({ success: true, already_sent: true, message: msg });
    }

    const clinicConfig = await whatsappService.getClinicConfig(conversation.clinic_id);
    if (!clinicConfig?.accessToken || !clinicConfig?.phoneNumberId) {
      return res.status(500).json({ error: 'whatsapp_config_missing' });
    }

    const to = whatsappService.normalizePhoneNumber(metadata.recipient)
      || whatsappService.normalizePhoneNumber(conversation.contact_id)
      || null;
    if (!to) {
      return res.status(400).json({ error: 'contacto_sin_numero' });
    }

    const useTemplate = String(msg.message_type || '').toLowerCase() === 'template';
    const nextMetadata = {
      ...metadata,
      forced_send_at: new Date().toISOString(),
      forced_send_by: userId || null,
      scheduled_for_original: metadata.scheduled_for || null,
      scheduled_for: null,
      quiet_hours_forced_send: true,
    };
    msg.metadata = nextMetadata;
    await msg.save();

    await queues.outboundWhatsApp.add('send', {
      messageId: msg.id,
      conversationId: conversation.id,
      to,
      body: msg.content,
      useTemplate,
      templateName: metadata.template_name || metadata.templateName || null,
      templateLanguage: metadata.template_language || metadata.templateLanguage || 'es_ES',
      templateParams: metadata.template_params || metadata.templateParams || null,
      templateComponents: metadata.template_components || metadata.templateComponents || null,
      clinicConfig,
    });

    const io = getIO();
    if (io) {
      const payload = {
        id: msg.id,
        conversation_id: conversation.id,
        status: msg.status,
        metadata: nextMetadata,
      };
      const room = conversation.clinic_id ? `clinic:${conversation.clinic_id}` : null;
      if (room) io.to(room).emit('message:updated', payload);
      else io.emit('message:updated', payload);
    }

    return res.json({ success: true, message: msg });
  } catch (err) {
    console.error('Error sendScheduledMessageNow', err);
    return res.status(500).json({ error: 'send_now_failed', message: err.message });
  }
};

exports.createInternalMessage = async (req, res) => {
  const transaction = await db.sequelize.transaction();
  try {
    const userId = req.userData?.userId;
    const { clinic_id, message } = req.body;
    if (!clinic_id) {
      await transaction.rollback();
      return res.status(400).json({ error: 'clinic_id requerido' });
    }

    const { clinicIds, isAggregateAllowed } = await getUserClinics(userId);
    if (!ensureAccess({ clinicIds, isAggregateAllowed }, clinic_id)) {
      await transaction.rollback();
      return res.status(403).json({ error: 'Acceso denegado a la clínica' });
    }
    try {
      await ensureQuickChatConversationReadAccess(userId, {
        clinic_id,
        channel: 'internal',
        contact_id: 'team',
      });
    } catch (accessError) {
      await transaction.rollback();
      return sendQuickChatCategoryForbidden(res, accessError);
    }

    const conversation =
      (await Conversation.findOne({
        where: { clinic_id, channel: 'internal', contact_id: 'team' },
        transaction,
      })) ||
      (await Conversation.create(
        {
          clinic_id,
          channel: 'internal',
          contact_id: 'team',
          last_message_at: new Date(),
        },
        { transaction }
      ));

    const msg = await Message.create(
      {
        conversation_id: conversation.id,
        sender_id: userId || null,
        direction: 'outbound',
        content: message,
        message_type: 'text',
        status: 'sent',
        sent_at: new Date(),
      },
      { transaction }
    );

    conversation.last_message_at = new Date();
    await conversation.save({ transaction });

    await transaction.commit();
    const io = getIO();
    if (io) {
      const room = `clinic:${conversation.clinic_id}`;
      io.to(room).emit('message:created', {
        id: msg.id,
        conversation_id: conversation.id,
        content: msg.content,
        direction: msg.direction,
        message_type: msg.message_type,
        status: msg.status,
        sent_at: msg.sent_at,
      });
    }
    return res.json({ conversation, message: msg });
  } catch (err) {
    await transaction.rollback();
    console.error('Error createInternalMessage', err);
    return res.status(500).json({ error: 'Error en chat interno' });
  }
};

exports.__testing = {
  buildQuickChatCategorySql,
  buildQuickChatCategoryWhere,
  buildConversationSearchClause,
  getQuickChatConversationCategory,
  normalizeSearchQuery,
  normalizeTextSearchValue,
};
