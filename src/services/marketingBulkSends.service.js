'use strict';

const crypto = require('crypto');
const { Op, QueryTypes, Sequelize } = require('sequelize');
const db = require('../../models');
const { normalizePhoneDigits, getPhoneLookupCandidates } = require('../lib/phone');
const whatsappService = require('./whatsapp.service');
const whatsappPaymentStatusService = require('./whatsappPaymentStatus.service');
const whatsappConnectionStatusService = require('./whatsappConnectionStatus.service');
const { buildWhatsappTemplateVariableContract } = require('../lib/whatsapp-template-contract');
const { findCanonicalWhatsappConversation } = require('../lib/canonical-conversation');
const marketingOptOutService = require('./marketingOptOut.service');
const jobRequestsService = require('./jobRequests.service');
const { isGlobalAdmin } = require('../lib/role-helpers');
const { getIO } = require('./socket.service');
const {
  mergeClinicLinksIntoContext,
  resolveClinicGoogleLocalLinks,
} = require('./googleLocalLinks.service');
const publicMediaPersonalizationService = require('./publicMediaPersonalization.service');

const {
  Clinica,
  ClinicaHorario,
  ClinicMetaAsset,
  Conversation,
  MarketingPatientContactEvent,
  MarketingPatientList,
  MarketingPatientListItem,
  MarketingBulkSendSetting,
  MarketingTrackedLink,
  MarketingTrackedLinkClick,
  AutomationFlowTemplateV2,
  Message,
  Paciente,
  PacienteConsentimiento,
  PatientCustomField,
  CitaPaciente,
  WhatsappTemplate,
  JobRequest,
} = db;

const OBJECTIVE_ID = 'mass_sends';
const REQUIRED_SEND_GATES = ['frozen_audience', 'opt_out', 'capping', 'approved_template', 'audit', 'cancelable_queue'];
const CHANNELS = new Set(['whatsapp', 'email', 'managed_calls']);
const STANDARD_FIELDS = new Set(['name', 'first_name', 'last_name', 'phone', 'email']);
const COMMERCIAL_TEMPLATE_USAGES = new Set(['marketing', 'comercial', 'promocion', 'promocional', 'reactivacion_pacientes']);
const REVIEW_TEMPLATE_USAGES = new Set(['solicitud_resena', 'resena', 'review_request', 'reviews']);
const REVIEW_AUTOMATION_TRIGGER = 'appointment_completed';
const REVIEW_AUTOMATION_ACTION = 'action/request_review';
const REVIEW_FOLLOWUP_AUTOMATION_ACTION = 'action/review_followup';
const REVIEW_NO_RESPONSE_AUTOMATION_ACTION = 'action/review_no_response';
const REVIEW_RATING_EVENT_TYPES = ['review_rating_received', 'review_request_rating'];
const REVIEW_TEMPLATE_NAME = 'clinicaclick_solicitar_resena';
const REVIEW_PHOTO_TEMPLATE_NAME = 'clinicaclick_solicitar_resena_foto';
const REVIEW_REMINDER_TEMPLATE_NAME = 'clinicaclick_recordatorio_resena_sin_respuesta';
const REVIEW_REMINDER_JOB_TYPE = 'marketing_review_request_reminder';
const REVIEW_NO_RESPONSE_JOB_TYPE = 'marketing_review_request_no_response';
const IMPORTED_HISTORICAL_APPOINTMENT_REASON = 'Importación de pacientes para reactivación';
const DISPATCH_JOB_TYPE = 'marketing_bulk_send_dispatch';
const DISPATCH_BATCH_SIZE = Math.max(1, Number.parseInt(process.env.MARKETING_BULK_SEND_BATCH_SIZE || '100', 10) || 100);
const DISPATCH_BATCH_DELAY_MS = Math.max(2 * 60 * 1000, Number.parseInt(process.env.MARKETING_BULK_SEND_BATCH_DELAY_MS || String(2 * 60 * 1000), 10) || 2 * 60 * 1000);
const DISPATCH_MIN_READ_RATE = Number(process.env.MARKETING_BULK_SEND_MIN_READ_RATE || '0.30') || 0.30;
const DISPATCH_MAX_OPT_OUT_RATE = Number(process.env.MARKETING_BULK_SEND_MAX_OPT_OUT_RATE || '0.03') || 0.03;
const DISPATCH_READ_RATE_GRACE_MS = Math.max(60 * 60 * 1000, Number.parseInt(process.env.MARKETING_BULK_SEND_READ_RATE_GRACE_MS || String(24 * 60 * 60 * 1000), 10) || 24 * 60 * 60 * 1000);
const TEST_SEND_COOLDOWN_MS = Math.max(1000, Number.parseInt(process.env.MARKETING_BULK_SEND_TEST_COOLDOWN_MS || '60000', 10) || 60000);
const STATS_RECONCILE_WINDOW_MS = Math.max(
  24 * 60 * 60 * 1000,
  Number.parseInt(process.env.MARKETING_BULK_SEND_STATS_RECONCILE_WINDOW_MS || String(30 * 24 * 60 * 60 * 1000), 10)
    || 30 * 24 * 60 * 60 * 1000
);
const DISPATCH_TIMEZONE = process.env.MARKETING_BULK_SEND_TIMEZONE || 'Europe/Madrid';
const DISPATCH_BUSINESS_START_HOUR = Math.max(8, Number.parseInt(process.env.MARKETING_BULK_SEND_START_HOUR || '9', 10) || 9);
const DISPATCH_BUSINESS_END_HOUR = 22;
const LINK_TRACKING_DEFAULT_DOMAIN = process.env.MARKETING_LINK_TRACKING_DEFAULT_DOMAIN || 'envios.clinicaclick.com';
const WHATSAPP_SESSION_WINDOW_MS = 23 * 60 * 60 * 1000 + 50 * 60 * 1000;
const REVIEW_REMINDER_DELAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_NO_RESPONSE_DELAY_MS = 24 * 60 * 60 * 1000;
const testSendCooldowns = new Map();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

function buildQuickChatMessagePayload(message) {
  return {
    id: String(message.id),
    conversation_id: String(message.conversation_id),
    content: message.content || '',
    direction: message.direction,
    message_type: message.message_type,
    status: message.status,
    sent_at: message.sent_at || message.createdAt || new Date(),
    sender_id: message.sender_id || null,
    metadata: message.metadata || undefined,
  };
}

function emitQuickChatMessageCreated(conversation, message) {
  const io = getIO();
  if (!io || !conversation?.id || !message?.id) return;
  const rooms = [];
  if (conversation.clinic_id) rooms.push(`clinic:${conversation.clinic_id}`);
  const payload = buildQuickChatMessagePayload(message);
  if (rooms.length) {
    rooms.forEach((room) => io.to(room).emit('message:created', payload));
  } else {
    io.emit('message:created', payload);
  }
}

function emitQuickChatMessageUpdated(conversation, message) {
  const io = getIO();
  if (!io || !message?.id || !message?.conversation_id) return;
  const payload = {
    id: String(message.id),
    conversation_id: String(message.conversation_id),
    status: message.status,
    content: message.content || '',
    message_type: message.message_type,
    sent_at: message.sent_at || message.updatedAt || new Date(),
    metadata: message.metadata || undefined,
  };
  const rooms = [];
  if (conversation?.clinic_id) rooms.push(`clinic:${conversation.clinic_id}`);
  if (rooms.length) {
    rooms.forEach((room) => io.to(room).emit('message:updated', payload));
  } else {
    io.emit('message:updated', payload);
  }
}

function repairMojibake(value) {
  const text = String(value || '');
  if (!/[ÃÂ]/.test(text)) return text;
  try {
    const repaired = Buffer.from(text, 'latin1').toString('utf8');
    return repaired && repaired !== text ? repaired : text;
  } catch (_) {
    return text;
  }
}

function normalizeText(value) {
  return repairMojibake(String(value ?? '')).trim();
}

function asPlainObject(value) {
  if (!value) return {};
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) || {};
    } catch {
      return {};
    }
  }
  return typeof value === 'object' ? value : {};
}

function isWithinWhatsappSessionWindow(value, now = new Date()) {
  const date = value instanceof Date ? value : new Date(value || 0);
  const current = now instanceof Date ? now : new Date(now || Date.now());
  if (Number.isNaN(date.getTime()) || Number.isNaN(current.getTime())) return false;
  const ageMs = current.getTime() - date.getTime();
  return ageMs >= 0 && ageMs <= WHATSAPP_SESSION_WINDOW_MS;
}

function normalizeTrackingSubdomain(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function normalizeTrackingDomain(value, mode = 'default') {
  const raw = normalizeText(value).toLowerCase();
  if (mode === 'custom') {
    const subdomain = normalizeTrackingSubdomain(raw.replace(/\.clinicaclick\.com$/i, ''));
    return subdomain ? `${subdomain}.clinicaclick.com` : LINK_TRACKING_DEFAULT_DOMAIN;
  }
  if (/^[a-z0-9-]+\.clinicaclick\.com$/i.test(raw)) {
    return raw;
  }
  return LINK_TRACKING_DEFAULT_DOMAIN;
}

function getActorUserId(actor) {
  if (actor && typeof actor === 'object') {
    return actor.userId || actor.id_usuario || actor.id || null;
  }
  return actor || null;
}

function isActorGlobalAdmin(actor) {
  return isGlobalAdmin(getActorUserId(actor));
}

function isBlockingQualityPause(dispatch = {}) {
  if (String(dispatch.status || '').toLowerCase() !== 'paused_quality') return false;
  return String(dispatch.paused_reason || '').toLowerCase() !== 'read_rate_low';
}

function buildContactUniqExpression(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return `COALESCE(
    CASE WHEN ${prefix}paciente_id IS NOT NULL THEN CONCAT('p:', ${prefix}paciente_id) END,
    CASE WHEN NULLIF(TRIM(${prefix}phone), '') IS NOT NULL THEN CONCAT('ph:', TRIM(${prefix}phone)) END,
    CASE WHEN NULLIF(TRIM(${prefix}email), '') IS NOT NULL THEN CONCAT('em:', LOWER(TRIM(${prefix}email))) END,
    CASE WHEN NULLIF(TRIM(${prefix}name), '') IS NOT NULL THEN CONCAT('nm:', LOWER(TRIM(${prefix}name))) END
  )`;
}

function assertTestSendCooldown({ clinicId, targetPhone }) {
  const key = `${Number(clinicId || 0) || 'scope'}:${String(targetPhone || '').trim()}`;
  const now = Date.now();
  for (const [entryKey, until] of testSendCooldowns.entries()) {
    if (until <= now) testSendCooldowns.delete(entryKey);
  }
  const blockedUntil = testSendCooldowns.get(key) || 0;
  if (blockedUntil > now) {
    const retryAfterSeconds = Math.max(1, Math.ceil((blockedUntil - now) / 1000));
    const err = new Error(`Espera ${retryAfterSeconds}s antes de enviar otra prueba a este número.`);
    err.status = 429;
    err.details = {
      retry_after_seconds: retryAfterSeconds,
      cooldown_ms: TEST_SEND_COOLDOWN_MS,
    };
    throw err;
  }
  testSendCooldowns.set(key, now + TEST_SEND_COOLDOWN_MS);
}

function normalizeLinkTrackingConfig(raw = {}) {
  const source = raw && typeof raw === 'object' ? raw : {};
  const enabled = source.enabled === true || source.link_tracking_enabled === true;
  const mode = source.domain_mode === 'custom' || source.mode === 'custom' ? 'custom' : 'default';
  const customSubdomain = normalizeTrackingSubdomain(source.custom_subdomain || source.customSubdomain || '');
  const domain = normalizeTrackingDomain(
    mode === 'custom'
      ? customSubdomain
      : (source.domain || source.tracking_domain || LINK_TRACKING_DEFAULT_DOMAIN),
    mode
  );
  return {
    enabled,
    domain_mode: mode,
    domain,
    custom_subdomain: mode === 'custom' ? customSubdomain : null,
  };
}

function buildLinkTrackingCriteria(body = {}, previousCriteria = {}) {
  const previous = normalizeLinkTrackingConfig(previousCriteria.link_tracking || previousCriteria);
  if (
    body.link_tracking === undefined &&
    body.link_tracking_enabled === undefined &&
    body.tracking_domain_mode === undefined &&
    body.tracking_custom_subdomain === undefined &&
    body.tracking_domain === undefined
  ) {
    return previous;
  }

  const raw = body.link_tracking && typeof body.link_tracking === 'object'
    ? body.link_tracking
    : {};
  return normalizeLinkTrackingConfig({
    ...previous,
    ...raw,
    ...(body.link_tracking_enabled !== undefined ? { enabled: body.link_tracking_enabled === true } : {}),
    ...(body.tracking_domain_mode !== undefined ? { domain_mode: body.tracking_domain_mode } : {}),
    ...(body.tracking_custom_subdomain !== undefined ? { custom_subdomain: body.tracking_custom_subdomain } : {}),
    ...(body.tracking_domain !== undefined ? { domain: body.tracking_domain } : {}),
  });
}

function getListLinkTrackingConfig(list) {
  return normalizeLinkTrackingConfig((list?.criteria || {}).link_tracking || {});
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return ['http:', 'https:'].includes(parsed.protocol);
  } catch (_) {
    return false;
  }
}

function buildTrackingUrl(link) {
  const domain = normalizeTrackingDomain(link?.tracking_domain || LINK_TRACKING_DEFAULT_DOMAIN);
  return `https://${domain}/r/${encodeURIComponent(link.token)}`;
}

function generateTrackingToken() {
  return String(crypto.randomInt(1000000000, 10000000000));
}

async function createTrackedLinkForVariable({ list, item, variableKey, originalUrl, domain }) {
  if (!MarketingTrackedLink || !list?.id || !isHttpUrl(originalUrl)) {
    return null;
  }
  const listPlain = list?.get ? list.get({ plain: true }) : list;
  const itemPlain = item?.get ? item.get({ plain: true }) : item;
  const where = {
    list_id: listPlain.id,
    item_id: itemPlain?.id || null,
    variable_key: normalizeKey(variableKey) || null,
    original_url: String(originalUrl).trim(),
  };
  const existing = await MarketingTrackedLink.findOne({ where });
  if (existing) {
    if (existing.status !== 'active' || existing.tracking_domain !== domain) {
      await existing.update({ status: 'active', tracking_domain: domain });
    }
    return existing;
  }

  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      return await MarketingTrackedLink.create({
        ...where,
        token: generateTrackingToken(),
        clinica_id: itemPlain?.clinica_id || listPlain.clinica_id || null,
        grupo_clinica_id: listPlain.grupo_clinica_id || null,
        tracking_domain: domain,
        status: 'active',
        metadata: {
          source: 'marketing_bulk_sends',
          objective_id: OBJECTIVE_ID,
        },
      });
    } catch (error) {
      if (attempt >= 3) throw error;
    }
  }
  return null;
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseTemplateComponents(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

function templateHasButtonComponents(template) {
  const plain = template?.get ? template.get({ plain: true }) : (template || {});
  return parseTemplateComponents(plain.components)
    .some((component) => String(component?.type || '').toUpperCase() === 'BUTTONS');
}

function templateHasImageHeader(template) {
  const plain = template?.get ? template.get({ plain: true }) : (template || {});
  return parseTemplateComponents(plain.components)
    .some((component) => (
      String(component?.type || '').toUpperCase() === 'HEADER'
      && String(component?.format || '').toUpperCase() === 'IMAGE'
    ));
}

function isStarTextReviewBody(value) {
  const text = normalizeText(value);
  const normalized = normalizeKey(text);
  return normalized.includes('numero')
    && normalized.includes('valoracion')
    && reviewTemplateBodyHasSender(value)
    && /1\s*[⭐★]/.test(text)
    && /2\s*[⭐★]{2}/.test(text)
    && /3\s*[⭐★]{3}/.test(text)
    && /4\s*[⭐★]{4}/.test(text)
    && /5\s*[⭐★]{5}/.test(text);
}

function reviewTemplateBodyHasSender(value) {
  const raw = String(value || '');
  const normalized = normalizeKey(raw);
  return /soy\s+\{\{\s*3\s*\}\}/i.test(raw)
    || normalized.includes('firma_resenas')
    || normalized.includes('remitente_resena')
    || normalized.includes('nombre_remitente_resenas')
    || normalized.includes('review_sender_name');
}

function normalizeTemplateUsage(value) {
  const usage = normalizeKey(value);
  return usage || 'promocion';
}

function isCommercialTemplateUsage(value) {
  return COMMERCIAL_TEMPLATE_USAGES.has(normalizeTemplateUsage(value));
}

function isReviewTemplateUsage(value) {
  return REVIEW_TEMPLATE_USAGES.has(normalizeTemplateUsage(value));
}

function getTemplateCategory(template) {
  const plain = template?.get ? template.get({ plain: true }) : (template || {});
  return normalizeText(plain.category || plain.catalog?.category).toUpperCase();
}

function resolveTemplateUsageFromMetaCategory(template, fallbackUsage = 'promocion') {
  const fallback = normalizeTemplateUsage(fallbackUsage);
  if (isReviewTemplateUsage(fallback)) {
    return fallback;
  }
  const category = getTemplateCategory(template);
  if (category === 'MARKETING') return 'promocion';
  if (category && category !== 'MARKETING') {
    return fallback && fallback !== 'promocion' ? fallback : 'notificacion';
  }
  return fallback;
}

function resolveTemplateCommercialFromMetaCategory(template, fallbackCommercial = false) {
  const category = getTemplateCategory(template);
  if (category === 'MARKETING') return true;
  if (category) return false;
  return fallbackCommercial === true;
}

function toTitleCaseName(value) {
  const particles = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'das', 'do', 'dos']);
  return normalizeText(value)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((part, index) => (index > 0 && particles.has(part) ? part : part.charAt(0).toUpperCase() + part.slice(1)))
    .join(' ');
}

function normalizeNameFormat(value) {
  const format = normalizeKey(value);
  if (['first_last', 'last_comma_first', 'last_last_first', 'full', 'auto'].includes(format)) return format;
  return 'auto';
}

function splitNameParts(text, format) {
  const clean = normalizeText(text);
  if (!clean) return { firstName: 'Contacto', lastName: '', fullName: 'Contacto' };
  if ((format === 'auto' || format === 'last_comma_first') && clean.includes(',')) {
    const [lastNameRaw, ...firstNameRaw] = clean.split(',');
    const firstName = toTitleCaseName(firstNameRaw.join(',').trim() || lastNameRaw);
    const lastName = toTitleCaseName(firstNameRaw.length ? lastNameRaw : '');
    return {
      firstName: firstName || 'Contacto',
      lastName,
      fullName: [firstName, lastName].filter(Boolean).join(' ') || firstName || 'Contacto',
    };
  }
  const fullName = toTitleCaseName(clean);
  const parts = fullName.split(/\s+/).filter(Boolean);
  if (!parts.length) return { firstName: 'Contacto', lastName: '', fullName: 'Contacto' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '', fullName: parts[0] };
  if (format === 'last_last_first' && parts.length >= 3) {
    const firstName = parts.slice(2).join(' ');
    const lastName = parts.slice(0, 2).join(' ');
    return {
      firstName: firstName || parts[parts.length - 1],
      lastName,
      fullName: [firstName, lastName].filter(Boolean).join(' ') || fullName,
    };
  }
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
    fullName,
  };
}

function splitFullName(value, format = 'auto') {
  const normalizedFormat = normalizeNameFormat(format);
  const parts = splitNameParts(value, normalizedFormat);
  const useFullName = normalizedFormat === 'full';
  return {
    name: useFullName ? parts.fullName : parts.firstName,
    firstName: parts.firstName,
    lastName: parts.lastName,
    fullName: parts.fullName,
  };
}

function scopeToWhere(scope) {
  const clauses = [];
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (scope?.scope === 'group' && Number.isInteger(scope.groupId)) clauses.push({ grupo_clinica_id: scope.groupId });
  if (clinicIds.length === 1) clauses.push({ clinica_id: clinicIds[0] });
  if (clinicIds.length > 1) clauses.push({ clinica_id: { [Op.in]: clinicIds } });
  return clauses.length === 1 ? clauses[0] : (clauses.length ? { [Op.or]: clauses } : { id: { [Op.eq]: -1 } });
}

function serializeScope(scope) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  const isGroup = scope?.scope === 'group' && Number.isInteger(scope.groupId);
  return {
    scope_type: isGroup ? 'group' : (clinicIds.length > 1 ? 'multi' : 'clinic'),
    clinica_id: !isGroup && clinicIds.length === 1 ? clinicIds[0] : null,
    grupo_clinica_id: isGroup ? scope.groupId : null,
    clinic_ids: clinicIds,
  };
}

function listInScope(list, scope) {
  const clinicIds = new Set((scope?.clinicIds || []).filter(Number.isInteger));
  if (scope?.scope === 'group' && list.grupo_clinica_id && Number(list.grupo_clinica_id) === Number(scope.groupId)) return true;
  if (list.clinica_id && clinicIds.has(Number(list.clinica_id))) return true;
  const listClinicIds = Array.isArray(list.clinic_ids) ? list.clinic_ids : [];
  return listClinicIds.some((id) => clinicIds.has(Number(id)));
}

function ensureScopeAccess(list, scope) {
  if (!list || list.objective_id !== OBJECTIVE_ID || !listInScope(list, scope)) {
    const err = new Error('Campaña de envíos masivos no encontrada en el scope actual');
    err.status = 404;
    throw err;
  }
}

function normalizeChannels(rawChannels) {
  const raw = Array.isArray(rawChannels) ? rawChannels : [rawChannels || 'whatsapp'];
  const channels = raw.map((value) => String(value || '').trim()).filter((value) => CHANNELS.has(value));
  return Array.from(new Set(channels.length ? channels : ['whatsapp']));
}

function computeCounters(items) {
  const total = items.length;
  const readyTotal = items.filter((item) => item.status === 'ready').length;
  const selectedReady = items.filter((item) => item.status === 'ready' && item.selected !== false).length;
  const excluded = items.filter((item) => String(item.status || '').startsWith('excluded')).length;
  const sent = items.filter((item) => item.sent_at || ['sent', 'delivered', 'read', 'replied'].includes(String(item.dispatch_status || '').toLowerCase())).length;
  const delivered = items.filter((item) => item.delivered_at || item.read_at || ['delivered', 'read', 'replied'].includes(String(item.dispatch_status || '').toLowerCase())).length;
  const read = items.filter((item) => item.read_at || ['read', 'replied'].includes(String(item.dispatch_status || '').toLowerCase())).length;
  const replied = items.filter((item) => item.replied_at || String(item.dispatch_status || '').toLowerCase() === 'replied').length;
  const failed = items.filter((item) => item.failed_at || String(item.dispatch_status || '').toLowerCase() === 'failed').length;
  const optOut = items.filter((item) => item.opt_out_at || item.exclusion_reason === 'opt_out').length;
  const exclusionReasons = {};
  for (const item of items) {
    if (!String(item.status || '').startsWith('excluded')) continue;
    const key = normalizeKey(item.exclusion_reason || item.status || 'otro') || 'otro';
    exclusionReasons[key] = (exclusionReasons[key] || 0) + 1;
  }
  return {
    total,
    ready: selectedReady,
    ready_total: readyTotal,
    selected: selectedReady,
    excluded,
    exclusion_reasons: exclusionReasons,
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

function statusRank(status) {
  const normalized = normalizeWebhookStatus(status) || normalizeKey(status);
  return { pending: 0, sent: 1, delivered: 2, read: 3, replied: 4, failed: 5 }[normalized] ?? 0;
}

function shouldMaterializeStatus(item, mappedStatus) {
  if (!item || !mappedStatus) return false;
  if (mappedStatus === 'failed') return !item.failed_at && String(item.dispatch_status || '').toLowerCase() !== 'failed';
  if (mappedStatus === 'sent') return !item.sent_at && statusRank(item.dispatch_status) < statusRank('sent');
  if (mappedStatus === 'delivered') return !item.delivered_at && statusRank(item.dispatch_status) < statusRank('delivered');
  if (mappedStatus === 'read') return !item.read_at && statusRank(item.dispatch_status) < statusRank('read');
  return false;
}

async function reconcileListMessageState(list, scope = {}) {
  const listId = Number(list?.id || list || 0);
  if (!listId || !Message || !MarketingPatientListItem) return { reconciled: false, reason: 'missing_context' };
  const dispatch = getDispatchConfig(list);
  const dispatchStatus = String(dispatch?.status || list?.status || '').toLowerCase();
  const liveStatuses = new Set(['queued', 'sending', 'scheduled', 'waiting_template_approval', 'paused', 'paused_quality', 'paused_limit', 'paused_template']);
  const referenceDate = parseDate(list?.last_sent_at) || parseDate(list?.prepared_at) || parseDate(list?.updated_at) || parseDate(list?.created_at);
  const isWithinReconcileWindow = !referenceDate || (Date.now() - referenceDate.getTime()) <= STATS_RECONCILE_WINDOW_MS;
  if (!liveStatuses.has(dispatchStatus) && !isWithinReconcileWindow) {
    const counters = list?.counters || await refreshListCounters(listId);
    return {
      reconciled: false,
      reason: 'outside_stats_reconcile_window',
      window_ms: STATS_RECONCILE_WINDOW_MS,
      counters,
    };
  }

  const items = await MarketingPatientListItem.findAll({ where: { list_id: listId } });
  if (!items.length) {
    await refreshListCounters(listId);
    return { reconciled: true, items: 0, messages: 0, inbound: 0 };
  }

  const appMessageIds = items
    .map((item) => Number(item.app_message_id || 0))
    .filter((id) => Number.isInteger(id) && id > 0);
  const uniqueAppMessageIds = Array.from(new Set(appMessageIds));
  const messages = uniqueAppMessageIds.length
    ? await Message.findAll({ where: { id: { [Op.in]: uniqueAppMessageIds } } })
    : [];
  const itemByMessageId = new Map(items.filter((item) => item.app_message_id).map((item) => [Number(item.app_message_id), item]));
  let statusUpdates = 0;

  for (const message of messages) {
    const item = itemByMessageId.get(Number(message.id));
    if (!item) continue;
    const latest = getLatestWhatsappStatusFromMessage(message);
    const mappedStatus = normalizeWebhookStatus(latest?.status || message.status);
    if (!mappedStatus || !shouldMaterializeStatus(item, mappedStatus)) continue;
    const result = await materializeMessageStatusFromWebhook({ message, status: latest || {}, mappedStatus });
    if (result?.applied) statusUpdates += 1;
  }

  const conversations = items
    .filter((item) => item.sent_at && item.conversation_id)
    .map((item) => Number(item.conversation_id))
    .filter((id) => Number.isInteger(id) && id > 0);
  const uniqueConversationIds = Array.from(new Set(conversations));
  let inboundUpdates = 0;

  if (uniqueConversationIds.length && Conversation) {
    const sentDates = items.map((item) => parseDate(item.sent_at)).filter(Boolean);
    const minSentAt = sentDates.length ? new Date(Math.min(...sentDates.map((date) => date.getTime()))) : null;
    const [conversationRows, inboundMessages] = await Promise.all([
      Conversation.findAll({ where: { id: { [Op.in]: uniqueConversationIds } } }),
      Message.findAll({
        where: {
          conversation_id: { [Op.in]: uniqueConversationIds },
          direction: 'inbound',
          ...(minSentAt ? { createdAt: { [Op.gte]: minSentAt } } : {}),
        },
        order: [['createdAt', 'ASC']],
      }),
    ]);
    const conversationById = new Map(conversationRows.map((conversation) => [Number(conversation.id), conversation]));
    for (const inboundMessage of inboundMessages) {
      const conversation = conversationById.get(Number(inboundMessage.conversation_id));
      if (!conversation) continue;
      try {
        await marketingOptOutService.applyInboundOptOutIfNeeded({
          clinicId: conversation.clinic_id || scope?.clinicIds?.[0] || null,
          conversation,
          inboundMessage,
          rawText: inboundMessage.content,
          patientId: conversation.patient_id || null,
        });
      } catch (error) {
        console.warn('[marketing-bulk-sends] No se pudo reconciliar baja inbound', {
          listId,
          inboundMessageId: inboundMessage.id,
          error: error?.message || error,
        });
      }
      const result = await materializeInboundReply({ conversation, inboundMessage });
      if (result?.applied) inboundUpdates += 1;
    }
  }

  const counters = await refreshListCounters(listId);
  return {
    reconciled: true,
    items: items.length,
    messages: messages.length,
    status_updates: statusUpdates,
    inbound_updates: inboundUpdates,
    counters,
  };
}

async function buildListReport(listId) {
  const id = Number(listId || 0);
  if (!id) return null;

  const [hourRows, clickRows, clickCountryRows, clickItemRows] = await Promise.all([
    db.sequelize.query(
    `
    SELECT HOUR(read_at) AS hour, COUNT(*) AS total
    FROM MarketingPatientListItems
    WHERE list_id = :listId AND read_at IS NOT NULL
    GROUP BY HOUR(read_at)
    ORDER BY hour ASC
    `,
      { replacements: { listId: id }, type: QueryTypes.SELECT }
    ),
    MarketingTrackedLinkClick && MarketingTrackedLink
      ? db.sequelize.query(
        `
        SELECT
          l.id,
          l.variable_key,
          l.original_url,
          COUNT(c.id) AS clicks,
          COUNT(DISTINCT CONCAT(COALESCE(c.item_id, 0), ':', COALESCE(c.ip_hash, ''), ':', COALESCE(c.user_agent_hash, ''))) AS unique_clicks
        FROM MarketingTrackedLinks l
        LEFT JOIN MarketingTrackedLinkClicks c ON c.tracked_link_id = l.id
        WHERE l.list_id = :listId
        GROUP BY l.id, l.variable_key, l.original_url
        ORDER BY clicks DESC, l.id ASC
        LIMIT 20
        `,
        { replacements: { listId: id }, type: QueryTypes.SELECT }
      )
      : Promise.resolve([]),
    MarketingTrackedLinkClick
      ? db.sequelize.query(
        `
        SELECT
          COALESCE(NULLIF(country_code, ''), 'unknown') AS country_code,
          COALESCE(NULLIF(country_name, ''), 'Sin dato') AS country_name,
          COUNT(*) AS clicks
        FROM MarketingTrackedLinkClicks
        WHERE list_id = :listId
        GROUP BY COALESCE(NULLIF(country_code, ''), 'unknown'), COALESCE(NULLIF(country_name, ''), 'Sin dato')
        ORDER BY clicks DESC
        LIMIT 20
        `,
        { replacements: { listId: id }, type: QueryTypes.SELECT }
      )
      : Promise.resolve([]),
    MarketingTrackedLinkClick
      ? db.sequelize.query(
        `
        SELECT item_id, COUNT(*) AS clicks
        FROM MarketingTrackedLinkClicks
        WHERE list_id = :listId AND item_id IS NOT NULL
        GROUP BY item_id
        `,
        { replacements: { listId: id }, type: QueryTypes.SELECT }
      )
      : Promise.resolve([]),
  ]);
  const [statusRows] = await db.sequelize.query(
    `
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN sent_at IS NOT NULL OR dispatch_status IN ('sent','delivered','read','replied') THEN 1 ELSE 0 END) AS sent,
      SUM(CASE WHEN delivered_at IS NOT NULL OR read_at IS NOT NULL OR dispatch_status IN ('delivered','read','replied') THEN 1 ELSE 0 END) AS delivered,
      SUM(CASE WHEN read_at IS NOT NULL OR dispatch_status IN ('read','replied') THEN 1 ELSE 0 END) AS read_count,
      SUM(CASE WHEN replied_at IS NOT NULL OR dispatch_status = 'replied' THEN 1 ELSE 0 END) AS replied,
      SUM(CASE WHEN opt_out_at IS NOT NULL OR exclusion_reason = 'opt_out' THEN 1 ELSE 0 END) AS opt_out,
      SUM(CASE
        WHEN (sent_at IS NOT NULL OR dispatch_status IN ('sent','delivered','read','replied'))
          AND (opt_out_at IS NOT NULL OR exclusion_reason = 'opt_out')
        THEN 1 ELSE 0
      END) AS sent_opt_out
    FROM MarketingPatientListItems
    WHERE list_id = :listId
    `,
    { replacements: { listId: id } }
  );
  const totals = statusRows?.[0] || {};
  const sent = Number(totals.sent || 0);
  const optOut = Number(totals.opt_out || 0);
  const sentOptOut = Number(totals.sent_opt_out || 0);
  const quality = getMarketingQualitySnapshot({ sent, optOut: sentOptOut, spamReports: 0 });
  return {
    opt_out_share: [
      { label: 'Bajas', value: sentOptOut },
      { label: 'Sin baja', value: Math.max(0, sent - sentOptOut) },
    ],
    read_hours: Array.from({ length: 24 }, (_value, hour) => {
      const row = (hourRows || []).find((entry) => Number(entry.hour) === hour);
      return { hour, label: `${String(hour).padStart(2, '0')}:00`, value: Number(row?.total || 0) };
    }),
    totals: {
      total: Number(totals.total || 0),
      sent,
      delivered: Number(totals.delivered || 0),
      read: Number(totals.read_count || 0),
      replied: Number(totals.replied || 0),
      opt_out: optOut,
      sent_opt_out: sentOptOut,
      link_clicks: clickRows.reduce((sum, row) => sum + Number(row.clicks || 0), 0),
      unique_link_clicks: clickRows.reduce((sum, row) => sum + Number(row.unique_clicks || 0), 0),
    },
    link_clicks: clickRows.map((row) => ({
      id: row.id,
      variable_key: row.variable_key,
      original_url: row.original_url,
      clicks: Number(row.clicks || 0),
      unique_clicks: Number(row.unique_clicks || 0),
    })),
    click_countries: clickCountryRows.map((row) => ({
      country_code: row.country_code,
      country_name: row.country_name,
      clicks: Number(row.clicks || 0),
    })),
    item_clicks: clickItemRows.map((row) => ({
      item_id: Number(row.item_id || 0),
      clicks: Number(row.clicks || 0),
    })).filter((row) => row.item_id > 0),
    quality,
    spam_reports_supported: false,
  };
}

function parseDate(value) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : null;
}

function parseWhatsappTimestamp(value, fallback = new Date()) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const ms = numeric > 100000000000 ? numeric : numeric * 1000;
    const date = new Date(ms);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return parseDate(value) || fallback;
}

function normalizeWebhookStatus(value) {
  const status = normalizeKey(value);
  if (status === 'sent') return 'sent';
  if (status === 'delivered') return 'delivered';
  if (status === 'read') return 'read';
  if (status === 'failed') return 'failed';
  return null;
}

function getLatestWhatsappStatusFromMessage(message) {
  const metadata = message?.metadata || {};
  const history = Array.isArray(metadata.wa_status_history) ? metadata.wa_status_history : [];
  const candidates = [
    metadata.wa_status,
    ...history,
    { status: message?.status, timestamp: message?.sent_at || message?.createdAt },
  ].filter(Boolean);
  const order = { sent: 1, delivered: 2, read: 3, failed: 4 };
  return candidates.reduce((best, candidate) => {
    const mapped = normalizeWebhookStatus(candidate?.status);
    if (!mapped) return best;
    if (!best) return candidate;
    const bestMapped = normalizeWebhookStatus(best.status);
    const currentRank = order[mapped] || 0;
    const bestRank = order[bestMapped] || 0;
    if (currentRank > bestRank) return candidate;
    if (currentRank < bestRank) return best;
    const currentTime = parseWhatsappTimestamp(candidate.timestamp, new Date(0)).getTime();
    const bestTime = parseWhatsappTimestamp(best.timestamp, new Date(0)).getTime();
    return currentTime > bestTime ? candidate : best;
  }, null);
}

function getMadridParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: DISPATCH_TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const localDay = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day))).getUTCDay();
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    weekday: localDay === 0 ? 7 : localDay,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

function getTimezoneOffsetMs(date = new Date(), timeZone = DISPATCH_TIMEZONE) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second)
  );
  return asUtc - date.getTime();
}

function zonedDateToUtc({ year, month, day, hour, minute = 0, second = 0 }, timeZone = DISPATCH_TIMEZONE) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  const offsetMs = getTimezoneOffsetMs(utcGuess, timeZone);
  return new Date(utcGuess.getTime() - offsetMs);
}

function parseBusinessTimeToMinutes(value, fallbackMinutes) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const hour = Math.floor(value);
    return hour >= 0 && hour <= 23 ? hour * 60 : fallbackMinutes;
  }
  const match = String(value || '').trim().match(/^(\d{1,2})(?::(\d{2}))?/);
  if (!match) return fallbackMinutes;
  const hour = Number(match[1]);
  const minute = Number(match[2] || 0);
  if (!Number.isFinite(hour) || !Number.isFinite(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) {
    return fallbackMinutes;
  }
  return hour * 60 + minute;
}

function formatBusinessTime(minutes) {
  const safe = Math.max(0, Math.min(23 * 60 + 59, Math.round(Number(minutes || 0))));
  const hour = Math.floor(safe / 60);
  const minute = safe % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeBusinessHours(input = {}) {
  const raw = input && typeof input === 'object' ? input : {};
  const defaultStart = DISPATCH_BUSINESS_START_HOUR * 60;
  const defaultEnd = DISPATCH_BUSINESS_END_HOUR * 60;
  let startMinutes = parseBusinessTimeToMinutes(raw.start_time ?? raw.start, defaultStart);
  let endMinutes = parseBusinessTimeToMinutes(raw.end_time ?? raw.end, defaultEnd);
  if (endMinutes <= startMinutes) {
    startMinutes = defaultStart;
    endMinutes = defaultEnd;
  }
  return {
    ...raw,
    start: Math.floor(startMinutes / 60),
    end: Math.ceil(endMinutes / 60),
    start_time: formatBusinessTime(startMinutes),
    end_time: formatBusinessTime(endMinutes),
    timezone: raw.timezone || DISPATCH_TIMEZONE,
    allowed_weekdays: normalizeAllowedWeekdays(raw.allowed_weekdays || raw.weekdays || raw.days),
  };
}

function normalizeAllowedWeekdays(value) {
  const raw = Array.isArray(value) ? value : [];
  const days = raw
    .map((day) => Number(day))
    .filter((day) => Number.isInteger(day) && day >= 1 && day <= 7);
  return [...new Set(days)].sort((a, b) => a - b);
}

function isAllowedBusinessWeekday(parts, allowedWeekdays = []) {
  return !allowedWeekdays.length || allowedWeekdays.includes(Number(parts.weekday || 0));
}

function addLocalDays(parts, days) {
  const localNoon = zonedDateToUtc({ ...parts, hour: 12, minute: 0, second: 0 });
  return getMadridParts(new Date(localNoon.getTime() + days * 24 * 60 * 60 * 1000));
}

function getNextBusinessAllowedAt(reference = new Date(), businessHours = null) {
  const window = normalizeBusinessHours(businessHours || {});
  const parts = getMadridParts(reference);
  const currentMinutes = parts.hour * 60 + parts.minute;
  const startMinutes = parseBusinessTimeToMinutes(window.start_time ?? window.start, DISPATCH_BUSINESS_START_HOUR * 60);
  const endMinutes = parseBusinessTimeToMinutes(window.end_time ?? window.end, DISPATCH_BUSINESS_END_HOUR * 60);
  if (isAllowedBusinessWeekday(parts, window.allowed_weekdays) && currentMinutes >= startMinutes && currentMinutes < endMinutes) {
    return reference;
  }
  if (isAllowedBusinessWeekday(parts, window.allowed_weekdays) && currentMinutes < startMinutes) {
    return zonedDateToUtc({ ...parts, hour: Math.floor(startMinutes / 60), minute: startMinutes % 60, second: 0 });
  }
  for (let offset = 1; offset <= 7; offset += 1) {
    const nextParts = addLocalDays(parts, offset);
    if (isAllowedBusinessWeekday(nextParts, window.allowed_weekdays)) {
      return zonedDateToUtc({ ...nextParts, hour: Math.floor(startMinutes / 60), minute: startMinutes % 60, second: 0 });
    }
  }
  const fallbackParts = addLocalDays(parts, 1);
  return zonedDateToUtc({ ...fallbackParts, hour: Math.floor(startMinutes / 60), minute: startMinutes % 60, second: 0 });
}

function isWithinBusinessHours(date = new Date(), businessHours = null) {
  const window = normalizeBusinessHours(businessHours || {});
  const parts = getMadridParts(date);
  const currentMinutes = parts.hour * 60 + parts.minute;
  const startMinutes = parseBusinessTimeToMinutes(window.start_time ?? window.start, DISPATCH_BUSINESS_START_HOUR * 60);
  const endMinutes = parseBusinessTimeToMinutes(window.end_time ?? window.end, DISPATCH_BUSINESS_END_HOUR * 60);
  return isAllowedBusinessWeekday(parts, window.allowed_weekdays) && currentMinutes >= startMinutes && currentMinutes < endMinutes;
}

function parseMessagingLimit(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return null;
  if (raw.includes('UNLIMITED')) return null;
  const compact = raw.replace(/,/g, '');
  const match = compact.match(/(\d+(?:\.\d+)?)(K|M)?/);
  if (!match) return null;
  const amount = Number(match[1]);
  const multiplier = match[2] === 'M' ? 1000000 : (match[2] === 'K' ? 1000 : 1);
  return Number.isFinite(amount) ? Math.round(amount * multiplier) : null;
}

function getMinimumDispatchDelayMs(dispatch = {}) {
  const context = normalizeKey(dispatch.context || dispatch.dispatch_context || dispatch.dispatch_mode || '');
  return ['review_request', 'reviews', 'solicitud_resena', 'resenas'].includes(context)
    ? 60 * 1000
    : 2 * 60 * 1000;
}

function getDispatchConfig(list) {
  const criteria = list?.criteria || {};
  const rawDispatch = criteria.dispatch && typeof criteria.dispatch === 'object'
    ? criteria.dispatch
    : (criteria.dispatch_config && typeof criteria.dispatch_config === 'object' ? criteria.dispatch_config : {});
  const isReviewRequest = criteria.review_request === true
    || String(criteria.review_request || '').toLowerCase() === 'true'
    || isReviewTemplateUsage(criteria.template_usage);
  const dispatchContext = normalizeDispatchContext(rawDispatch.context || rawDispatch.dispatch_context || (isReviewRequest ? 'review_request' : null));
  const dispatch = dispatchContext ? { ...rawDispatch, context: dispatchContext } : rawDispatch;
  const businessHours = normalizeBusinessHours(dispatch.business_hours || {});
  const minDelayMs = getMinimumDispatchDelayMs(dispatch);
  const batchSize = Math.max(1, Math.min(1000, Number.parseInt(dispatch.batch_size || DISPATCH_BATCH_SIZE, 10) || DISPATCH_BATCH_SIZE));
  const requestedDelayMs = Number.parseInt(dispatch.delay_ms || DISPATCH_BATCH_DELAY_MS, 10) || DISPATCH_BATCH_DELAY_MS;
  const isDefaultReviewPacedDispatch = isReviewRequest
    && dispatchContext === 'review_request'
    && normalizeKey(dispatch.mode || '') === 'all_at_once'
    && batchSize === 1
    && requestedDelayMs === DISPATCH_BATCH_DELAY_MS;
  return {
    ...dispatch,
    batch_size: batchSize,
    delay_ms: Math.max(minDelayMs, isDefaultReviewPacedDispatch ? 60 * 1000 : requestedDelayMs),
    min_read_rate: Number(dispatch.min_read_rate || DISPATCH_MIN_READ_RATE) || DISPATCH_MIN_READ_RATE,
    read_rate_grace_ms: Number(dispatch.read_rate_grace_ms || DISPATCH_READ_RATE_GRACE_MS) || DISPATCH_READ_RATE_GRACE_MS,
    max_opt_out_rate: Number(dispatch.max_opt_out_rate || DISPATCH_MAX_OPT_OUT_RATE) || DISPATCH_MAX_OPT_OUT_RATE,
    timezone: dispatch.timezone || DISPATCH_TIMEZONE,
    business_hours: businessHours,
  };
}

function normalizeDispatchContext(value) {
  const key = normalizeKey(value || '');
  if (key === 'welcome' || key === 'bienvenida') return 'welcome';
  return key || null;
}

function buildDispatchFilterFromBody(body = {}, fallbackContext = null) {
  const importBatchId = normalizeText(body.import_batch_id || body.importBatchId || '');
  if (!importBatchId) return null;
  return {
    type: 'import_batch',
    import_batch_id: importBatchId,
    context: normalizeDispatchContext(body.dispatch_context || body.dispatch_mode || fallbackContext) || null,
  };
}

function getDispatchItemFilter(dispatch = {}) {
  const filter = dispatch?.filter && typeof dispatch.filter === 'object' ? dispatch.filter : null;
  if (!filter || !normalizeText(filter.import_batch_id)) return null;
  return {
    type: filter.type || 'import_batch',
    import_batch_id: normalizeText(filter.import_batch_id),
    context: normalizeDispatchContext(filter.context || dispatch.context) || null,
  };
}

function itemMatchesDispatchFilter(item = {}, filter = null) {
  if (!filter) return true;
  const plain = item?.get ? item.get({ plain: true }) : item;
  if (filter.type === 'import_batch') {
    return normalizeText(plain.custom_fields?.lote_importacion) === normalizeText(filter.import_batch_id);
  }
  return true;
}

async function getDispatchScopedItems(listId, filter = null, transaction = null) {
  const items = await MarketingPatientListItem.findAll({
    where: { list_id: listId },
    transaction,
  });
  return items
    .map((item) => (item?.get ? item.get({ plain: true }) : item))
    .filter((item) => itemMatchesDispatchFilter(item, filter));
}

async function getDispatchScopedCounters(list, filter = null, transaction = null) {
  if (!filter) {
    return refreshListCounters(list.id, transaction);
  }
  const items = await getDispatchScopedItems(list.id, filter, transaction);
  return computeCounters(items);
}

async function getReviewDispatchFollowUpCounters(list, filter = null) {
  const listId = Number(list?.id || list || 0);
  if (!listId || !JobRequest) {
    return { pending_replies: 0, pending_reminders: 0 };
  }

  const filterClause = filter?.type === 'import_batch' && normalizeText(filter.import_batch_id)
    ? "AND JSON_UNQUOTE(JSON_EXTRACT(i.custom_fields, '$.lote_importacion')) = :importBatchId"
    : '';
  const replacements = {
    listId,
    noResponseType: REVIEW_NO_RESPONSE_JOB_TYPE,
    importBatchId: filterClause ? normalizeText(filter.import_batch_id) : null,
  };
  const [rows] = await db.sequelize.query(
    `
    SELECT
      COUNT(DISTINCT CASE
        WHEN i.sent_at IS NOT NULL
          AND i.replied_at IS NULL
          AND COALESCE(i.dispatch_status, '') <> 'replied'
        THEN i.id
        ELSE NULL
      END) AS pending_replies,
      COUNT(DISTINCT CASE
        WHEN j.id IS NOT NULL
          AND i.replied_at IS NULL
          AND COALESCE(i.dispatch_status, '') <> 'replied'
        THEN i.id
        ELSE NULL
      END) AS pending_reminders
    FROM MarketingPatientListItems i
    LEFT JOIN JobRequests j
      ON j.type = :noResponseType
      AND j.status IN ('waiting', 'queued', 'pending', 'scheduled')
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(j.payload, '$.list_id')) AS UNSIGNED) = i.list_id
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(j.payload, '$.item_id')) AS UNSIGNED) = i.id
    WHERE i.list_id = :listId
      AND i.sent_at IS NOT NULL
      ${filterClause}
    `,
    { replacements, type: QueryTypes.SELECT }
  );

  return {
    pending_replies: Number(rows?.pending_replies || 0),
    pending_reminders: Number(rows?.pending_reminders || 0),
  };
}

function buildDispatchCompletedPatch(dispatch = {}, followUp = null, completedAt = new Date()) {
  const completedAtIso = completedAt.toISOString();
  return {
    ...dispatch,
    status: 'completed',
    completed_at: completedAtIso,
    completed_banner_expires_at: new Date(completedAt.getTime() + 72 * 60 * 60 * 1000).toISOString(),
    review_pending_replies: followUp ? Number(followUp.pending_replies || 0) : dispatch.review_pending_replies,
    review_pending_reminders: followUp ? Number(followUp.pending_reminders || 0) : dispatch.review_pending_reminders,
    next_allowed_at: null,
  };
}

function getDispatchCompletionExpiryIso(completedAt) {
  const parsed = new Date(completedAt || '');
  if (!Number.isFinite(parsed.getTime())) return null;
  return new Date(parsed.getTime() + 72 * 60 * 60 * 1000).toISOString();
}

async function countDispatchRemainingItems(listId, filter = null) {
  const where = {
    list_id: listId,
    status: 'ready',
    selected: true,
    [Op.or]: [{ dispatch_status: null }, { dispatch_status: 'pending' }],
  };
  if (!filter) {
    return MarketingPatientListItem.count({ where });
  }
  const items = await MarketingPatientListItem.findAll({ where, order: [['id', 'ASC']] });
  return items.filter((item) => itemMatchesDispatchFilter(item, filter)).length;
}

async function findDispatchCandidateBatch(listId, filter = null, limit = DISPATCH_BATCH_SIZE) {
  const where = {
    list_id: listId,
    status: 'ready',
    selected: true,
    [Op.or]: [{ dispatch_status: null }, { dispatch_status: 'pending' }],
  };
  const items = await MarketingPatientListItem.findAll({
    where,
    order: [['id', 'ASC']],
    ...(!filter ? { limit } : {}),
  });
  return (filter ? items.filter((item) => itemMatchesDispatchFilter(item, filter)) : items).slice(0, limit);
}

function normalizeBulkSendSettingsPayload(raw = {}) {
  const batchSize = Math.max(1, Math.min(1000, Number.parseInt(raw.batch_size || raw.batchSize || DISPATCH_BATCH_SIZE, 10) || DISPATCH_BATCH_SIZE));
  const delayMs = Math.max(2 * 60 * 1000, Number.parseInt(raw.delay_ms || raw.delayMs || DISPATCH_BATCH_DELAY_MS, 10) || DISPATCH_BATCH_DELAY_MS);
  const minReadRate = Math.min(1, Math.max(0, Number(raw.min_read_rate ?? raw.minReadRate ?? DISPATCH_MIN_READ_RATE) || DISPATCH_MIN_READ_RATE));
  const readRateGraceMs = Math.max(60 * 60 * 1000, Number.parseInt(raw.read_rate_grace_ms || raw.readRateGraceMs || DISPATCH_READ_RATE_GRACE_MS, 10) || DISPATCH_READ_RATE_GRACE_MS);
  const maxOptOutRate = Math.min(1, Math.max(0, Number(raw.max_opt_out_rate ?? raw.maxOptOutRate ?? DISPATCH_MAX_OPT_OUT_RATE) || DISPATCH_MAX_OPT_OUT_RATE));
  return {
    batch_size: batchSize,
    delay_ms: delayMs,
    min_read_rate: minReadRate,
    read_rate_grace_ms: readRateGraceMs,
    max_opt_out_rate: maxOptOutRate,
    business_hours: {
      start: DISPATCH_BUSINESS_START_HOUR,
      end: DISPATCH_BUSINESS_END_HOUR,
      timezone: DISPATCH_TIMEZONE,
      locked: true,
    },
  };
}

async function getAdminBulkSendSettings() {
  const defaults = normalizeBulkSendSettingsPayload({});
  if (!MarketingBulkSendSetting) {
    return { settings: defaults, blocked_users: [] };
  }
  const row = await MarketingBulkSendSetting.findOne({ where: { scope_key: 'global' } });
  return {
    settings: normalizeBulkSendSettingsPayload(row?.settings || defaults),
    blocked_users: Array.isArray(row?.blocked_users) ? row.blocked_users : [],
    updated_at: row?.updated_at || null,
  };
}

async function upsertAdminBulkSendSettings(body = {}, userId = null) {
  const settings = normalizeBulkSendSettingsPayload(body);
  const blockedUsers = Array.isArray(body.blocked_users)
    ? body.blocked_users.map((item) => ({
      phone: normalizePhoneDigits(item?.phone || ''),
      email: normalizeText(item?.email || '').toLowerCase(),
      reason: normalizeText(item?.reason || 'Bloqueo manual por calidad'),
      blocked_at: item?.blocked_at || new Date().toISOString(),
    })).filter((item) => item.phone || item.email)
    : undefined;

  if (!MarketingBulkSendSetting) {
    return { settings, blocked_users: blockedUsers || [] };
  }

  const [row] = await MarketingBulkSendSetting.findOrCreate({
    where: { scope_key: 'global' },
    defaults: {
      scope_key: 'global',
      settings,
      blocked_users: blockedUsers || [],
      updated_by: userId || null,
    },
  });
  await row.update({
    settings,
    ...(blockedUsers !== undefined ? { blocked_users: blockedUsers } : {}),
    updated_by: userId || null,
  });
  return getAdminBulkSendSettings();
}

function mergeDispatchConfigs(...configs) {
  return configs.reduce((acc, config) => {
    if (!config || typeof config !== 'object') return acc;
    const nextBusinessHours = config.business_hours && typeof config.business_hours === 'object'
      ? {
          ...(acc.business_hours || {}),
          ...config.business_hours,
        }
      : acc.business_hours;
    return {
      ...acc,
      ...config,
      ...(nextBusinessHours ? { business_hours: nextBusinessHours } : {}),
    };
  }, {});
}

async function getDispatchConfigForList(list, override = null) {
  const admin = await getAdminBulkSendSettings().catch(() => null);
  const listCriteria = list?.criteria || {};
  const listDispatchConfig = listCriteria.dispatch_config && typeof listCriteria.dispatch_config === 'object'
    ? listCriteria.dispatch_config
    : {};
  const listDispatch = listCriteria.dispatch && typeof listCriteria.dispatch === 'object'
    ? listCriteria.dispatch
    : {};
  const criteria = {
    ...listCriteria,
    dispatch_config: mergeDispatchConfigs(admin?.settings || {}, listDispatchConfig, listDispatch, override || {}),
  };
  return getDispatchConfig({ ...list, criteria });
}

function mergeCriteria(list, patch) {
  return {
    ...(list.criteria || {}),
    ...patch,
  };
}

async function applyMarketingOptOutExclusions(itemPayloads, scope, transaction = null) {
  if (!Array.isArray(itemPayloads) || !itemPayloads.length) return itemPayloads;
  const optOutSets = await marketingOptOutService.getActiveOptOutSetsForScope(scope, transaction);
  return itemPayloads.map((item) => {
    if (String(item.status || '').startsWith('excluded')) return item;
    if (!marketingOptOutService.isContactOptedOut({
      patientId: item.paciente_id || null,
      phone: item.phone || null,
      optOutSets,
    })) {
      return item;
    }
    return {
      ...item,
      status: 'excluded_opt_out',
      reason: 'Baja comercial solicitada por WhatsApp en una campaña anterior',
      exclusion_reason: 'opt_out',
      selected: false,
    };
  });
}

async function revalidateDispatchExclusions(list, items, scope, transaction = null) {
  if (!Array.isArray(items) || !items.length) return [];
  const optOutSets = await marketingOptOutService.getActiveOptOutSetsForScope(scope, transaction);
  const patientIds = items.map((item) => Number(item.paciente_id || 0)).filter((id) => Number.isInteger(id) && id > 0);
  const rejectedContactRows = patientIds.length && PacienteConsentimiento
    ? await PacienteConsentimiento.findAll({
      where: {
        paciente_id: { [Op.in]: patientIds },
        tipo: 'comunicaciones',
        estado: 'rechazado',
      },
      attributes: ['paciente_id'],
      raw: true,
      transaction,
    })
    : [];
  const rejectedContactPatientIds = new Set(rejectedContactRows.map((row) => Number(row.paciente_id)).filter(Boolean));
  const excluded = [];

  for (const item of items) {
    if (String(item.status || '') !== 'ready' || item.selected === false) {
      excluded.push(item);
      continue;
    }
    const hasMarketingOptOut = marketingOptOutService.isContactOptedOut({
      patientId: item.paciente_id || null,
      phone: item.phone || null,
      optOutSets,
    });
    const noContact = item.paciente_id && rejectedContactPatientIds.has(Number(item.paciente_id));
    if (!hasMarketingOptOut && !noContact) continue;
    await item.update({
      status: 'excluded_opt_out',
      exclusion_reason: hasMarketingOptOut ? 'opt_out' : 'no_contactar',
      selected: false,
      reason: hasMarketingOptOut
        ? 'Baja comercial solicitada antes del envío'
        : 'Paciente con comunicaciones rechazadas antes del envío',
      dispatch_status: null,
      opt_out_at: hasMarketingOptOut ? new Date() : item.opt_out_at,
    }, { transaction });
    excluded.push(item);
    await MarketingPatientContactEvent.create({
      list_id: list.id,
      item_id: item.id,
      paciente_id: item.paciente_id || null,
      event_type: 'mass_campaign_contact_excluded_before_send',
      channel: 'whatsapp',
      payload: {
        reason: hasMarketingOptOut ? 'opt_out' : 'no_contactar',
      },
      occurred_at: new Date(),
    }, { transaction });
  }

  if (excluded.length) {
    await refreshListCounters(list.id, transaction);
  }
  return excluded;
}

const IMPORT_ALIASES = {
  name: ['nombre', 'nombre_completo', 'nombre_y_apellidos', 'nombre_apellidos', 'name', 'paciente', 'contacto', 'full_name'],
  first_name: ['nombre', 'first_name', 'firstname'],
  last_name: ['apellido', 'apellidos', 'last_name', 'lastname'],
  phone: ['telefono', 'teléfono', 'movil', 'móvil', 'telefono_movil', 'phone', 'mobile', 'whatsapp'],
  email: ['email', 'correo', 'correo_electronico', 'mail'],
  clinic: ['clinica', 'clínica', 'sede', 'centro', 'clinic', 'location'],
};

function findHeader(headers, aliases) {
  const byKey = new Map(headers.map((header) => [normalizeKey(header), header]));
  for (const alias of aliases) {
    const match = byKey.get(normalizeKey(alias));
    if (match) return match;
  }
  return null;
}

function inferColumnMapping(rows, explicit = {}) {
  const headers = Array.from(new Set(rows.flatMap((row) => Object.keys(row || {})).map(normalizeText).filter(Boolean)));
  const mapping = {};
  for (const [field, aliases] of Object.entries(IMPORT_ALIASES)) {
    mapping[field] = explicit[field] || findHeader(headers, aliases) || null;
  }
  return mapping;
}

function readImportValue(row, mapping, field) {
  const header = mapping?.[field];
  if (header && Object.prototype.hasOwnProperty.call(row, header)) return normalizeText(row[header]);
  const aliases = IMPORT_ALIASES[field] || [];
  for (const alias of aliases) {
    const match = Object.keys(row || {}).find((key) => normalizeKey(key) === normalizeKey(alias));
    if (match) return normalizeText(row[match]);
  }
  return '';
}

function normalizeCustomFieldSchemaEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const key = normalizeKey(entry.key || entry.name || entry.variable);
  const sourceColumn = normalizeText(entry.source_column || entry.sourceColumn || entry.column || entry.source);
  if (!key || !sourceColumn) return null;
  return {
    key,
    label: normalizeText(entry.label) || key.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '),
    type: normalizeText(entry.type) || 'text',
    source: 'import',
    source_column: sourceColumn,
  };
}

function buildCustomFields(row, mapping, customFieldsSchema = []) {
  const explicit = Array.isArray(customFieldsSchema)
    ? customFieldsSchema.map(normalizeCustomFieldSchemaEntry).filter(Boolean)
    : [];
  if (explicit.length) {
    const custom = {};
    for (const field of explicit) {
      const value = normalizeText(row?.[field.source_column]);
      if (value) custom[field.key] = value;
    }
    return custom;
  }

  const mappedHeaders = new Set(Object.values(mapping || {}).filter(Boolean));
  const custom = {};
  for (const [header, value] of Object.entries(row || {})) {
    if (mappedHeaders.has(header)) continue;
    const key = normalizeKey(header);
    const cleanValue = normalizeText(value);
    if (!key || !cleanValue || STANDARD_FIELDS.has(key)) continue;
    custom[key] = cleanValue;
  }
  return custom;
}

function buildCustomFieldSchema(rows, mapping, explicitSchema = []) {
  if (Array.isArray(explicitSchema) && explicitSchema.length) {
    return explicitSchema.map(normalizeCustomFieldSchemaEntry).filter(Boolean);
  }
  const fields = new Map();
  for (const row of rows) {
    const custom = buildCustomFields(row, mapping);
    for (const [key, value] of Object.entries(custom)) {
      if (fields.has(key)) continue;
      fields.set(key, {
        key,
        label: key.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '),
        type: /^-?\d+([.,]\d+)?$/.test(String(value)) ? 'number' : 'text',
        source: 'import',
      });
    }
  }
  return Array.from(fields.values());
}

function buildPatientVariableFields(patient, patientCustomFields = []) {
  const firstName = toTitleCaseName(patient?.nombre || '');
  const lastName = toTitleCaseName(patient?.apellidos || '');
  const fields = {
    nombre: firstName,
    nombre_paciente: firstName,
    apellido: lastName,
    apellidos: lastName,
    apellido_paciente: lastName,
    nombre_completo: [firstName, lastName].filter(Boolean).join(' '),
    telefono: patient?.telefono_movil || patient?.telefono_secundario || '',
    email: patient?.email || '',
  };

  for (const customField of patientCustomFields || []) {
    const key = normalizeKey(customField.field_key);
    const value = normalizeText(customField.value);
    if (!key || !value) continue;
    fields[key] = value;
  }

  return fields;
}

function patientMatchesItem(patient, item) {
  const itemPhoneCandidates = new Set(getPhoneLookupCandidates(item.phone || ''));
  const patientPhoneCandidates = [
    ...getPhoneLookupCandidates(patient.telefono_movil || ''),
    ...getPhoneLookupCandidates(patient.telefono_secundario || ''),
  ];
  if (patientPhoneCandidates.some((candidate) => itemPhoneCandidates.has(candidate))) {
    return true;
  }

  const itemEmail = normalizeText(item.email).toLowerCase();
  const patientEmail = normalizeText(patient.email).toLowerCase();
  return !!itemEmail && !!patientEmail && itemEmail === patientEmail;
}

async function attachExistingPatientContext(itemPayloads, scope, transaction = null) {
  if (!Array.isArray(itemPayloads) || !itemPayloads.length || !Paciente) return itemPayloads;
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (!clinicIds.length) return itemPayloads;

  const phoneCandidates = new Set();
  const emails = new Set();
  for (const item of itemPayloads) {
    for (const candidate of getPhoneLookupCandidates(item.phone || '')) {
      phoneCandidates.add(candidate);
    }
    const email = normalizeText(item.email).toLowerCase();
    if (email) emails.add(email);
  }

  const contactClauses = [];
  const phoneList = Array.from(phoneCandidates).slice(0, 5000);
  const emailList = Array.from(emails).slice(0, 5000);
  if (phoneList.length) {
    contactClauses.push({ telefono_movil: { [Op.in]: phoneList } });
    contactClauses.push({ telefono_secundario: { [Op.in]: phoneList } });
  }
  if (emailList.length) {
    contactClauses.push({ email: { [Op.in]: emailList } });
  }
  if (!contactClauses.length) return itemPayloads;

  const patients = await Paciente.findAll({
    where: {
      clinica_id: { [Op.in]: clinicIds },
      fecha_baja: null,
      [Op.or]: contactClauses,
    },
    attributes: ['id_paciente', 'clinica_id', 'nombre', 'apellidos', 'telefono_movil', 'telefono_secundario', 'email'],
    order: [['id_paciente', 'DESC']],
    raw: true,
    transaction,
  });
  if (!patients.length) return itemPayloads;

  const patientIds = patients
    .map((patient) => Number(patient.id_paciente))
    .filter((id) => Number.isInteger(id) && id > 0);
  const customRows = PatientCustomField && patientIds.length
    ? await PatientCustomField.findAll({
      where: {
        paciente_id: { [Op.in]: patientIds },
        clinica_id: { [Op.in]: clinicIds },
      },
      attributes: ['paciente_id', 'field_key', 'value'],
      raw: true,
      transaction,
    })
    : [];
  const customByPatient = new Map();
  for (const row of customRows) {
    const id = Number(row.paciente_id);
    if (!customByPatient.has(id)) customByPatient.set(id, []);
    customByPatient.get(id).push(row);
  }

  return itemPayloads.map((item) => {
    const matched = patients.find((patient) => patientMatchesItem(patient, item));
    if (!matched) return item;
    const patientFields = buildPatientVariableFields(matched, customByPatient.get(Number(matched.id_paciente)) || []);
    return {
      ...item,
      paciente_id: Number(matched.id_paciente) || item.paciente_id || null,
      clinica_id: item.clinica_id || matched.clinica_id || null,
      phone: item.phone || matched.telefono_movil || matched.telefono_secundario || null,
      email: item.email || matched.email || null,
      custom_fields: {
        ...patientFields,
        ...(item.custom_fields || {}),
      },
      notes: [
        normalizeText(item.notes),
        'Contacto cruzado con paciente existente por teléfono/email.',
      ].filter(Boolean).join('\n') || null,
    };
  });
}

async function attachImportedClinicContext(itemPayloads, scope, transaction = null) {
  if (!Array.isArray(itemPayloads) || !itemPayloads.length || !Clinica) return itemPayloads;
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (!clinicIds.length) return itemPayloads;

  const clinics = await Clinica.findAll({
    where: { id_clinica: { [Op.in]: clinicIds } },
    attributes: ['id_clinica', 'nombre_clinica'],
    raw: true,
    transaction,
  });
  const byId = new Map();
  const byName = new Map();
  for (const clinic of clinics) {
    const id = Number(clinic.id_clinica);
    if (!id) continue;
    byId.set(id, id);
    const normalizedName = normalizeKey(clinic.nombre_clinica || '');
    if (normalizedName) byName.set(normalizedName, id);
  }

  return itemPayloads.map((item) => {
    if (item.clinica_id) return item;
    const importedClinic = normalizeText(
      item.custom_fields?.clinica_importada
      || item.custom_fields?.sede_importada
      || item.custom_fields?.clinic
      || item.custom_fields?.clinica
      || item.custom_fields?.sede
    );
    if (!importedClinic) return item;

    const numericId = Number(importedClinic);
    const clinicId = (Number.isInteger(numericId) && byId.has(numericId))
      ? numericId
      : (byName.get(normalizeKey(importedClinic)) || null);

    if (!clinicId) {
      return {
        ...item,
        notes: [
          normalizeText(item.notes),
          `Sede importada no reconocida dentro del grupo: ${importedClinic}.`,
        ].filter(Boolean).join('\n') || null,
      };
    }

    return {
      ...item,
      clinica_id: clinicId,
      notes: [
        normalizeText(item.notes),
        `Sede importada asignada: ${importedClinic}.`,
      ].filter(Boolean).join('\n') || null,
    };
  });
}

function missingRequiredFields({ channels, name, phoneDigits, email }) {
  const missing = [];
  if (!name) missing.push('nombre');
  if ((channels.includes('whatsapp') || channels.includes('managed_calls')) && (!phoneDigits || phoneDigits.length < 8)) {
    missing.push('teléfono');
  }
  if (channels.includes('email') && !email) missing.push('email');
  return Array.from(new Set(missing));
}

function buildItemsFromRows(rows, body, channels) {
  const columnMapping = inferColumnMapping(rows, body.column_mapping || {});
  const importMetadata = buildImportMetadata(body);
  const customFieldsSchema = withImportTrackingSchema(buildCustomFieldSchema(rows, columnMapping, body.custom_fields_schema || []));
  const nameFormat = normalizeNameFormat(body.name_format || body.nameFormat || 'auto');
  const seen = new Set();
  const items = [];

  for (const row of rows) {
    const fullName = readImportValue(row, columnMapping, 'name')
      || [readImportValue(row, columnMapping, 'first_name'), readImportValue(row, columnMapping, 'last_name')].filter(Boolean).join(' ');
    const nameInfo = splitFullName(fullName || 'Contacto importado', nameFormat);
    const phoneDigits = normalizePhoneDigits(readImportValue(row, columnMapping, 'phone'));
    const phone = phoneDigits ? `+${phoneDigits}` : null;
    const email = readImportValue(row, columnMapping, 'email') || null;
    const importedClinic = readImportValue(row, columnMapping, 'clinic') || null;
    const customFields = buildCustomFields(row, columnMapping, customFieldsSchema);
    const missing = missingRequiredFields({ channels, name: nameInfo.name, phoneDigits, email });
    const dedupeKey = phoneDigits || normalizeKey(email) || normalizeKey(nameInfo.name);
    let status = missing.length ? 'excluded_missing_required' : 'ready';
    let reason = missing.length ? `Faltan campos: ${missing.join(', ')}` : 'Contacto importado listo';
    let exclusionReason = missing.length ? 'missing_required' : null;
    if (!missing.length && dedupeKey && seen.has(dedupeKey)) {
      status = 'excluded_duplicate';
      reason = 'Duplicado dentro de la lista';
      exclusionReason = 'duplicado';
    }
    if (dedupeKey && status === 'ready') seen.add(dedupeKey);

    items.push({
      paciente_id: null,
      clinica_id: body.clinic_id || body.clinica_id || null,
      name: nameInfo.name,
      phone,
      email,
      treatment: null,
      treatment_id: null,
      last_visit_at: null,
      status,
      reason,
      exclusion_reason: exclusionReason,
      selected: status === 'ready',
      custom_fields: {
        nombre: nameInfo.firstName,
        apellido: nameInfo.lastName,
        apellidos: nameInfo.lastName,
        nombre_completo: nameInfo.fullName,
        ...customFields,
        ...(importedClinic ? { clinica_importada: importedClinic, sede_importada: importedClinic } : {}),
        fecha_importacion: importMetadata.importedAtDate,
        fecha_importacion_texto: importMetadata.importedAtLabel,
        lote_importacion: importMetadata.importBatchId,
      },
      missing_variables: [],
      notes: null,
    });
  }

  return { items, columnMapping, customFieldsSchema, nameFormat, importMetadata };
}

async function buildItemsFromCurrentPatients(scope, body) {
  if (isReviewRequestBody(body)) {
    return buildItemsForReviewRequest(scope, body);
  }

  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  const rows = await Paciente.findAll({
    where: {
      ...(clinicIds.length ? { clinica_id: { [Op.in]: clinicIds } } : {}),
      fecha_baja: null,
    },
    attributes: ['id_paciente', 'clinica_id', 'nombre', 'apellidos', 'telefono_movil', 'email'],
    limit: Math.min(Math.max(Number(body.limit || 500), 1), 2000),
  });
  return rows.map((patient) => ({
    paciente_id: patient.id_paciente,
    clinica_id: patient.clinica_id || null,
    name: [patient.nombre, patient.apellidos].filter(Boolean).join(' ').trim() || 'Paciente',
    phone: patient.telefono_movil || null,
    email: patient.email || null,
    treatment: null,
    treatment_id: null,
    last_visit_at: null,
    status: 'ready',
    reason: 'Paciente actual incluido por condición',
    exclusion_reason: null,
    selected: true,
    custom_fields: {},
    missing_variables: [],
  }));
}

function isReviewRequestBody(body = {}) {
  const usage = normalizeTemplateUsage(body.template_usage || body.template_uso || body.uso || '');
  return body.review_request === true || usage === 'solicitud_resena';
}

function normalizeReviewRequestSource(value) {
  const normalized = normalizeText(value || '').toLowerCase();
  if (
    [
      'first_completed_or_completed_treatment',
      'automatic_after_care',
      'automatic_review_request',
      'primera_cita_o_tratamiento',
    ].includes(normalized)
  ) {
    return 'first_completed_or_completed_treatment';
  }
  if (['completed_treatment', 'completed_treatments', 'tratamiento_realizado', 'treatment_completed'].includes(normalized)) {
    return 'completed_treatment';
  }
  if (['manual_selection', 'manual', 'seleccion_manual'].includes(normalized)) {
    return 'manual_selection';
  }
  return 'completed_treatment';
}

function normalizeReviewThreshold(value) {
  const parsed = Number(value || 0);
  return [4, 5].includes(parsed) ? parsed : 5;
}

function parseReviewTreatmentIds(source = {}) {
  const raw = source.review_treatment_ids
    ?? source.reviewTreatmentIds
    ?? source.review_treatment_id
    ?? source.reviewTreatmentId
    ?? null;
  const values = Array.isArray(raw)
    ? raw
    : String(raw || '').split(',');
  return [...new Set(values
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))];
}

function parseReviewClinicIds(source = {}) {
  const raw = source.review_group_clinic_ids
    ?? source.reviewGroupClinicIds
    ?? source.review_clinic_ids
    ?? source.reviewClinicIds
    ?? null;
  const values = Array.isArray(raw)
    ? raw
    : String(raw || '').split(',');
  return [...new Set(values
    .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0))];
}

function parseReviewExcludedPatientIds(source = {}) {
  const raw = source.excluded_review_patient_ids
    ?? source.excludedReviewPatientIds
    ?? source.review_excluded_patient_ids
    ?? source.reviewExcludedPatientIds
    ?? null;
  const values = Array.isArray(raw)
    ? raw
    : String(raw || '').split(',');
  return [...new Set(values
    .map((value) => Number(value))
    .filter((value) => Number.isInteger(value) && value > 0))];
}

function parseReviewExclusionRules(source = {}) {
  let raw = source.review_exclusion_rules ?? source.reviewExclusionRules ?? {};
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch (_) {
      raw = {};
    }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    raw = {};
  }
  return {
    no_phone: raw.no_phone === true || String(raw.no_phone || '').toLowerCase() === 'true',
    no_treatment: raw.no_treatment === true || String(raw.no_treatment || '').toLowerCase() === 'true',
    no_visit_date: raw.no_visit_date === true || String(raw.no_visit_date || '').toLowerCase() === 'true',
  };
}

function applyReviewClinicFilter(scope, source = {}) {
  const requestedClinicIds = parseReviewClinicIds(source);
  if (!requestedClinicIds.length || scope?.scope !== 'group') {
    return scope;
  }

  const allowedIds = new Set((scope?.clinicIds || []).filter(Number.isInteger));
  const selectedIds = requestedClinicIds.filter((clinicId) => allowedIds.has(clinicId));
  return {
    ...scope,
    clinicIds: selectedIds,
  };
}

function buildReviewRatingSummaryText(row = {}) {
  const rating = Number(row.rating || 0) || null;
  const privateReason = normalizeText(row.reason || '');
  const googleComment = normalizeText(row.google_review_comment || '');
  const googleMatched = row.google_review_matched === true || row.google_review_matched === 1;

  if (rating === 5) {
    if (googleComment) {
      return googleComment;
    }
    if (googleMatched) {
      return 'Valoración positiva sin comentario interno por ser 5/5. No han comentado en Google.';
    }
    return 'Valoración positiva sin comentario interno por ser 5/5. No han comentado en Google o no hemos podido relacionar su usuario con el de la reseña.';
  }

  return privateReason || 'Sin comentario interno.';
}

function buildReviewResponseHeatmaps(rows = []) {
  const weekdays = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  const hours = Array.from({ length: 24 }, (_item, index) => index);
  const empty = () => weekdays.map((day) => ({
    name: day,
    data: hours.map((hour) => ({ x: `${String(hour).padStart(2, '0')}:00`, y: 0 }))
  }));
  const heatmaps = {
    winter: { label: 'Invierno', total: 0, series: empty() },
    summer: { label: 'Verano', total: 0, series: empty() },
  };

  for (const row of rows || []) {
    const season = String(row.season || '');
    if (!heatmaps[season]) continue;
    const weekday = Number(row.weekday);
    const hour = Number(row.hour);
    const total = Number(row.total || 0);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    heatmaps[season].series[weekday].data[hour].y = total;
    heatmaps[season].total += total;
  }

  return heatmaps;
}

function buildGoogleRatingSummary(row = {}) {
  const totalReviews = Number(row.total_reviews || 0);
  const ratingSum = Number(row.rating_sum || 0);
  const averageRating = totalReviews > 0
    ? Number((ratingSum / totalReviews).toFixed(2))
    : 0;
  const fiveStarReviews = Number(row.five_star_reviews || 0);
  const targetAverage = 4.95; // Umbral para que una media con un decimal pueda mostrarse como 5,0.
  let neededFiveStarReviews = totalReviews > 0 ? 1 : 1;

  if (totalReviews > 0 && averageRating >= targetAverage) {
    neededFiveStarReviews = 0;
  } else if (totalReviews > 0) {
    neededFiveStarReviews = Math.max(1, Math.ceil(((targetAverage * totalReviews) - ratingSum) / (5 - targetAverage)));
  }

  return {
    total_reviews: totalReviews,
    five_star_reviews: fiveStarReviews,
    average_rating: averageRating,
    rating_sum: ratingSum,
    target_average: targetAverage,
    needed_five_star_reviews_for_5: neededFiveStarReviews,
    rating_targets: buildGoogleRatingTargets(totalReviews, ratingSum, averageRating),
  };
}

function calculateFiveStarReviewsNeeded(totalReviews, ratingSum, targetAverage) {
  if (!totalReviews || targetAverage <= 0 || targetAverage >= 5) return 0;
  if ((ratingSum / totalReviews) >= targetAverage) return 0;
  return Math.max(1, Math.ceil(((targetAverage * totalReviews) - ratingSum) / (5 - targetAverage)));
}

function buildGoogleRatingTargets(totalReviews, ratingSum, averageRating) {
  if (!totalReviews) return [];

  const targets = [];
  const currentRounded = Math.round(averageRating * 10) / 10;
  const firstVisibleTarget = Math.min(4.9, Math.max(0.1, (Math.floor(currentRounded * 10) + 1) / 10));
  const candidateVisibleTargets = [
    firstVisibleTarget,
    Math.min(4.9, firstVisibleTarget + 0.1),
    5,
  ];

  for (const visibleTarget of candidateVisibleTargets) {
    const roundedVisibleTarget = Number(visibleTarget.toFixed(1));
    if (targets.some((target) => target.visible_average === roundedVisibleTarget)) {
      continue;
    }
    const threshold = roundedVisibleTarget >= 5
      ? 4.95
      : Math.max(0, roundedVisibleTarget - 0.05);
    targets.push({
      visible_average: roundedVisibleTarget,
      target_average: Number(threshold.toFixed(2)),
      needed_five_star_reviews: calculateFiveStarReviewsNeeded(totalReviews, ratingSum, threshold),
    });
  }

  return targets;
}

function isReviewRequestList(list) {
  const criteria = list?.criteria || {};
  return criteria.review_request === true || isReviewTemplateUsage(criteria.template_usage);
}

function normalizeCampaignListContext(value) {
  const key = normalizeKey(value || '');
  if (['review', 'reviews', 'review_request', 'resena', 'resenas', 'solicitud_resena'].includes(key)) {
    return 'reviews';
  }
  if (['mass', 'mass_sends', 'bulk_sends', 'envios_masivos', 'envios'].includes(key)) {
    return 'mass_sends';
  }
  return 'all';
}

function buildReviewCampaignSqlCondition() {
  const jsonValue = (path) => `COALESCE(JSON_UNQUOTE(JSON_EXTRACT(criteria, '${path}')), '')`;
  return `(
    ${jsonValue('$.review_request')} IN ('true', '1')
    OR ${jsonValue('$.template_usage')} IN ('solicitud_resena', 'resena', 'review_request', 'reviews')
    OR ${jsonValue('$.dispatch.context')} IN ('review_request', 'reviews', 'solicitud_resena', 'resenas')
    OR ${jsonValue('$.dispatch.dispatch_context')} IN ('review_request', 'reviews', 'solicitud_resena', 'resenas')
    OR ${jsonValue('$.dispatch_config.context')} IN ('review_request', 'reviews', 'solicitud_resena', 'resenas')
    OR ${jsonValue('$.dispatch_config.dispatch_context')} IN ('review_request', 'reviews', 'solicitud_resena', 'resenas')
  )`;
}

function contextToCampaignWhere(context) {
  const normalized = normalizeCampaignListContext(context);
  if (normalized === 'all') return {};
  const reviewCondition = buildReviewCampaignSqlCondition();
  return normalized === 'reviews'
    ? { [Op.and]: [Sequelize.literal(reviewCondition)] }
    : { [Op.and]: [Sequelize.literal(`NOT ${reviewCondition}`)] };
}

function extractReviewRatingFromInboundMessage(message) {
  const metadata = asPlainObject(message?.metadata);
  const candidates = [
    message?.content,
    metadata?.button?.text,
    metadata?.text?.body,
    metadata?.button_reply?.title,
    metadata?.interactive?.button_reply?.title,
    metadata?.interactive?.list_reply?.title,
    metadata?.raw?.button?.text,
    metadata?.raw?.text?.body,
    metadata?.raw?.interactive?.button_reply?.title,
    metadata?.raw?.interactive?.list_reply?.title,
    metadata?.payload?.button?.text,
    metadata?.payload?.text?.body,
    metadata?.payload?.interactive?.button_reply?.title,
  ]
    .map((value) => normalizeText(value))
    .filter(Boolean);

  for (const candidate of candidates) {
    const starCount = (candidate.match(/[⭐★]/g) || []).length;
    if (starCount >= 1 && starCount <= 5 && !/[0-9]/.test(candidate)) {
      return starCount;
    }

    const explicitMatch = candidate.match(/(?:^|[^\d])([1-5])\s*(?:\/\s*5|de\s*5|estrellas?|stars?|⭐|★)(?:$|[^\d])/i);
    if (explicitMatch) {
      const rating = Number(explicitMatch[1]);
      if (rating >= 1 && rating <= 5) return rating;
    }

    if (candidate.length <= 40) {
      const compactMatch = candidate.match(/(?:^|[^\d])([1-5])(?:$|[^\d])/i);
      if (compactMatch) {
        const rating = Number(compactMatch[1]);
        if (rating >= 1 && rating <= 5) return rating;
      }
    }
  }

  return null;
}

async function findExistingReviewRatingEvent(listId, itemId, options = {}) {
  const events = await MarketingPatientContactEvent.findAll({
    where: {
      list_id: listId,
      item_id: itemId,
      event_type: { [Op.in]: REVIEW_RATING_EVENT_TYPES },
    },
    order: [['occurred_at', 'DESC']],
    limit: options.sameTriggerOnly ? 25 : 1,
  });

  if (options.sameTriggerOnly) {
    const triggerMessageId = Number(options.triggerMessageId || 0);
    return events.find((event) => Number(event.payload?.trigger_message_id || 0) === triggerMessageId) || null;
  }

  return events[0] || null;
}

function classifyReviewRatingChange(previousRating, nextRating) {
  const previous = Number(previousRating || 0);
  const next = Number(nextRating || 0);
  if (!previous || !next || previous === next) return { action: 'ignore', reason: 'same_or_invalid_rating' };
  if (previous < 5) return { action: 'ignore', reason: 'previous_low_rating_locked' };
  if (previous >= 5 && next < 5) return { action: 'downgrade_to_private_feedback', reason: 'positive_then_low_rating' };
  return { action: 'ignore', reason: 'rating_change_not_actionable' };
}

async function createIgnoredReviewRatingEvent({ list, item, inboundMessage, triggerMessage, previousRating, rating, reason, occurredAt }) {
  await MarketingPatientContactEvent.create({
    list_id: list.id,
    item_id: item.id,
    paciente_id: item.paciente_id || null,
    event_type: 'review_rating_ignored',
    channel: 'whatsapp',
    payload: {
      previous_rating: previousRating || null,
      rating,
      reason,
      inbound_message_id: inboundMessage?.id || null,
      trigger_message_id: triggerMessage?.id || null,
      content_preview: normalizeText(inboundMessage?.content).slice(0, 300),
    },
    occurred_at: occurredAt || new Date(),
  });
}

function isReviewRatingTriggerMessage(triggerMessage) {
  const metadata = asPlainObject(triggerMessage?.metadata);
  const kind = normalizeKey(metadata.kind);
  if (kind === 'review_google_link_followup' || kind === 'review_private_feedback_request') return false;
  if (kind === 'review_request_reminder') return true;
  if ((kind === 'mass_campaign_test' || kind === 'mass_campaign_send') && isReviewTemplateUsage(metadata.template_usage)) {
    return true;
  }
  return normalizeKey(metadata.dispatch_context) === 'review_request' && isReviewTemplateUsage(metadata.template_usage);
}

async function materializeReviewPrivateFeedback({ list, item, inboundMessage, triggerMessage, occurredAt }) {
  const triggerMetadata = asPlainObject(triggerMessage?.metadata);
  if (!isReviewRequestList(list) || triggerMetadata.kind !== 'review_private_feedback_request') {
    return { applied: false };
  }
  const content = normalizeText(inboundMessage.content);
  if (!content) return { applied: false };
  const rating = Number(triggerMetadata.review_rating || 0) || null;
  const inboundMessageId = Number(inboundMessage.id || 0);

  const recentFeedback = await MarketingPatientContactEvent.findAll({
    where: {
      list_id: list.id,
      item_id: item.id,
      event_type: 'review_private_feedback_received',
    },
    order: [['occurred_at', 'DESC']],
    limit: 25,
  });
  const alreadyStored = recentFeedback.find((event) => Number(event.payload?.inbound_message_id || 0) === inboundMessageId);
  if (alreadyStored) return { applied: false, reason: 'already_feedback_received' };
  if (inboundMessageId) {
    const recentRatings = await MarketingPatientContactEvent.findAll({
      where: {
        list_id: list.id,
        item_id: item.id,
        event_type: { [Op.in]: REVIEW_RATING_EVENT_TYPES },
      },
      order: [['occurred_at', 'DESC']],
      limit: 25,
    });
    const sameInboundRating = recentRatings.find((event) => Number(event.payload?.inbound_message_id || 0) === inboundMessageId);
    if (sameInboundRating) {
      return { applied: false, reason: 'inbound_already_registered_as_rating' };
    }
  }

  await MarketingPatientContactEvent.create({
    list_id: list.id,
    item_id: item.id,
    paciente_id: item.paciente_id || null,
    event_type: 'review_private_feedback_received',
    channel: 'whatsapp',
    payload: {
      inbound_message_id: inboundMessage.id,
      trigger_message_id: triggerMessage?.id || null,
      rating,
      content,
    },
    occurred_at: occurredAt,
  });
  return { applied: true };
}

function buildReviewPrivateFeedbackAckText(item) {
  const firstName = normalizeText(item?.name).split(/\s+/).filter(Boolean)[0] || '';
  return firstName
    ? `Gracias por contárnoslo, ${firstName}. Lo revisaremos con el equipo para mejorar.`
    : 'Gracias por contárnoslo. Lo revisaremos con el equipo para mejorar.';
}

async function sendReviewPrivateFeedbackAcknowledgement({ list, item, conversation, inboundMessage, triggerMessage, occurredAt }) {
  const triggerMetadata = asPlainObject(triggerMessage?.metadata);
  if (!isReviewRequestList(list) || triggerMetadata.kind !== 'review_private_feedback_request') {
    return { sent: false, reason: 'not_private_feedback_reply' };
  }

  const recentAck = await MarketingPatientContactEvent.findAll({
    where: {
      list_id: list.id,
      item_id: item.id,
      event_type: 'review_private_feedback_ack_sent',
    },
    order: [['occurred_at', 'DESC']],
    limit: 25,
  });
  const alreadySent = recentAck.find((event) => Number(event.payload?.inbound_message_id || 0) === Number(inboundMessage.id || 0));
  if (alreadySent) return { sent: false, reason: 'already_sent' };

  const recipient = whatsappService.normalizePhoneNumber(triggerMetadata.recipient || item.phone || '');
  if (!recipient) return { sent: false, reason: 'missing_recipient' };

  const clinicId = Number(item.clinica_id || list.clinica_id || conversation?.clinic_id || 0) || null;
  const body = buildReviewPrivateFeedbackAckText(item);
  if (!isWithinWhatsappSessionWindow(occurredAt)) {
    await MarketingPatientContactEvent.create({
      list_id: list.id,
      item_id: item.id,
      paciente_id: item.paciente_id || null,
      event_type: 'review_private_feedback_ack_skipped',
      channel: 'whatsapp',
      payload: {
        status: 'skipped',
        reason: 'whatsapp_session_window_expired',
        inbound_message_id: inboundMessage.id,
        trigger_message_id: triggerMessage?.id || null,
        recipient,
      },
      occurred_at: new Date(),
    });
    return { sent: false, status: 'skipped', reason: 'whatsapp_session_window_expired' };
  }
  let appMessage = null;
  let providerMessageId = null;
  let status = 'sent';
  let errorPayload = null;
  let clinicConfig = null;

  try {
    clinicConfig = await whatsappService.getClinicConfig(clinicId);
    if (!clinicConfig?.phoneNumberId || !clinicConfig?.accessToken) {
      throw new Error('whatsapp_config_missing_for_review_private_feedback_ack');
    }

    appMessage = await Message.create({
      conversation_id: conversation.id,
      sender_id: null,
      direction: 'outbound',
      content: body,
      message_type: 'text',
      status: 'pending',
      metadata: {
        kind: 'review_private_feedback_ack',
        source: 'marketing_bulk_sends',
        dispatch_context: 'review_request',
        list_id: list.id,
        item_id: item.id,
        objective_id: OBJECTIVE_ID,
        inbound_message_id: inboundMessage.id,
        trigger_message_id: triggerMessage?.id || null,
        recipient,
      },
      sent_at: new Date(),
    });
    emitQuickChatMessageCreated(conversation, appMessage);

    const response = await whatsappService.sendMessage({
      to: recipient,
      body,
      previewUrl: false,
      useTemplate: false,
      clinicConfig: { ...clinicConfig, clinicId },
    });
    providerMessageId = response?.messages?.[0]?.id || null;
    await appMessage.update({
      status: 'sent',
      metadata: {
        ...(appMessage.metadata || {}),
        wa_response: response || null,
        wamid: providerMessageId,
      },
      sent_at: new Date(),
    });
    emitQuickChatMessageUpdated(conversation, appMessage);
    await whatsappConnectionStatusService.clearDisconnectedAfterSuccess({
      clinicId,
      phoneId: clinicConfig.phoneNumberId || null,
      wabaId: clinicConfig.wabaId || null,
      messageId: appMessage.id,
      source: 'review_private_feedback_ack',
    }).catch(() => null);
  } catch (error) {
    status = 'failed';
    errorPayload = extractProviderError(error);
    if (appMessage) {
      await appMessage.update({
        status: 'failed',
        metadata: {
          ...(appMessage.metadata || {}),
          error: errorPayload.raw || errorPayload.message,
        },
      }).catch(() => null);
      emitQuickChatMessageUpdated(conversation, appMessage);
    }
    await whatsappConnectionStatusService.markDisconnectedAfterProviderError({
      error: errorPayload?.raw || errorPayload,
      clinicId,
      phoneId: clinicConfig?.phoneNumberId || null,
      wabaId: clinicConfig?.wabaId || null,
      messageId: appMessage?.id || null,
      recipient,
      source: 'review_private_feedback_ack',
    }).catch(() => null);
  }

  await MarketingPatientContactEvent.create({
    list_id: list.id,
    item_id: item.id,
    paciente_id: item.paciente_id || null,
    event_type: 'review_private_feedback_ack_sent',
    channel: 'whatsapp',
    payload: {
      status,
      inbound_message_id: inboundMessage.id,
      trigger_message_id: triggerMessage?.id || null,
      app_message_id: appMessage?.id || null,
      provider_message_id: providerMessageId,
      recipient,
      error: errorPayload || null,
    },
    occurred_at: occurredAt,
  });

  return { sent: status === 'sent', status };
}

function buildReviewTeamMentionFollowUpLine(teamMembersText) {
  const clean = normalizeText(teamMembersText || '').replace(/\s+/g, ' ');
  const isPlural = clean.includes('|')
    ? clean.split('|').map((item) => normalizeText(item)).filter(Boolean).length > 1
    : /\s+o\s+/i.test(clean);
  return clean
    ? `*Si mencionas a alguien del equipo en la reseña,* como a ${clean}, ${isPlural ? 'les' : 'le'} haremos llegar el detalle que has tenido acordándote de ${isPlural ? 'ellos' : 'él'} ¡Gracias!`
    : '*Si mencionas a alguien del equipo en la reseña* le haremos llegar el detalle ¡Gracias!';
}

async function sendReviewRatingFollowUp({ list, item, conversation, rating, clinicId, triggerMessage, occurredAt }) {
  if (!isReviewRequestList(list) || !rating) return { sent: false, reason: 'not_review_rating' };

  const triggerMetadata = asPlainObject(triggerMessage?.metadata);
  const isTestSend = triggerMetadata.kind === 'mass_campaign_test';
  const followUpRecipient = whatsappService.normalizePhoneNumber(
    isTestSend
      ? (triggerMetadata.recipient || item.phone || '')
      : (item.phone || triggerMetadata.recipient || '')
  );
  if (!followUpRecipient) return { sent: false, reason: 'missing_recipient' };

  const threshold = 5;
  const isPositive = rating >= threshold;
  const followUpKind = isPositive ? 'review_google_link_followup' : 'review_private_feedback_request';

  const existingFollowUp = await MarketingPatientContactEvent.findOne({
    where: {
      list_id: list.id,
      item_id: item.id,
      event_type: 'review_rating_followup_sent',
    },
    order: [['occurred_at', 'DESC']],
  });
  if (existingFollowUp) {
    const payload = existingFollowUp.payload || {};
    const existingKind = String(payload.kind || '').toLowerCase();
    let existingTriggerMessageId = Number(payload.trigger_message_id || 0);
    let existingRecipient = whatsappService.normalizePhoneNumber(payload.recipient || payload.to || payload.target_phone || '');

    if ((!existingRecipient || !existingTriggerMessageId) && payload.app_message_id) {
      const existingMessage = await Message.findByPk(payload.app_message_id).catch(() => null);
      const existingMetadata = asPlainObject(existingMessage?.metadata);
      existingTriggerMessageId = existingTriggerMessageId || Number(existingMetadata.trigger_message_id || 0);
      existingRecipient = whatsappService.normalizePhoneNumber(
        existingMetadata.recipient
          || existingMetadata.wa_response?.contacts?.[0]?.input
          || existingMetadata.wa_response?.contacts?.[0]?.wa_id
          || ''
      );
    }

    const currentTriggerMessageId = Number(triggerMessage?.id || 0);
    const sameRequestCycle = currentTriggerMessageId > 0 && existingTriggerMessageId === currentTriggerMessageId;
    const legacySameRecipientWithoutCycle = !currentTriggerMessageId && existingRecipient === followUpRecipient && !existingTriggerMessageId;
    if (existingKind === followUpKind && (sameRequestCycle || legacySameRecipientWithoutCycle)) {
      return { sent: false, reason: 'already_sent' };
    }
  }

  const clinic = await loadClinicForTemplateVariables(clinicId);
  const criteria = asPlainObject(list.criteria);
  const googleReviewUrl = normalizeText(clinic?.url_dejar_resena || criteria?.link_tracking?.google_review_url || '');
  const rewardEnabled = criteria.review_gift_enabled === true || String(criteria.review_gift_enabled || '').toLowerCase() === 'true';
  const rewardDescription = normalizeText(criteria.review_gift_description || '');
  const reviewTeamMembersText = normalizeText(
    criteria.review_team_members_text
    || triggerMetadata.review_team_members_text
    || ''
  );
  const body = isPositive
    ? (googleReviewUrl
      ? (rewardEnabled
        ? `😊 Queremos obsequiarte con "${rewardDescription || 'un detalle'}" si la compartes en Google. Pincha aquí y se publicará, esto nos ayudará muchísimo porque todo el mundo podrá verla 👉 ${googleReviewUrl}. Tras hacerlo, escríbenos para que te indiquemos cómo tramitar tu regalo.\n\n${buildReviewTeamMentionFollowUpLine(reviewTeamMembersText)}`
        : `😊 Pincha aquí y se publicará en Google, esto nos ayudará muchísimo porque todo el mundo podrá verla. *¡Y por favor! 🙏🙏 déjanos unas breves palabras en la reseña que puedan ayudar a pacientes como tú* 👉 ${googleReviewUrl}\n\n${buildReviewTeamMentionFollowUpLine(reviewTeamMembersText)}`)
      : 'Gracias por tu valoración. Hemos registrado tu opinión.')
    : 'Gracias por responder. ¿Nos ayudarías contándonos el motivo de esta valoración? Puedes escribirlo aquí mismo y lo revisaremos con el equipo.';
  if (!isWithinWhatsappSessionWindow(occurredAt)) {
    await MarketingPatientContactEvent.create({
      list_id: list.id,
      item_id: item.id,
      paciente_id: item.paciente_id || null,
      event_type: 'review_rating_followup_skipped',
      channel: 'whatsapp',
      payload: {
        status: 'skipped',
        reason: 'whatsapp_session_window_expired',
        kind: followUpKind,
        rating,
        threshold,
        trigger_message_id: triggerMessage?.id || null,
        recipient: followUpRecipient,
        test_send: isTestSend,
        google_review_url_available: isPositive && !!googleReviewUrl,
      },
      occurred_at: new Date(),
    });
    return { sent: false, status: 'skipped', kind: followUpKind, reason: 'whatsapp_session_window_expired' };
  }
  let appMessage = null;
  let providerMessageId = null;
  let status = 'sent';
  let errorPayload = null;

  try {
    const clinicConfig = await whatsappService.getClinicConfig(clinicId);
    if (!clinicConfig?.phoneNumberId || !clinicConfig?.accessToken) {
      throw new Error('whatsapp_config_missing_for_review_followup');
    }

    appMessage = await Message.create({
      conversation_id: conversation.id,
      sender_id: null,
      direction: 'outbound',
      content: body,
      message_type: 'text',
      status: 'pending',
      metadata: {
        kind: followUpKind,
        source: 'marketing_bulk_sends',
        dispatch_context: 'review_request',
        list_id: list.id,
        item_id: item.id,
        objective_id: OBJECTIVE_ID,
        review_rating: rating,
        review_threshold: threshold,
        review_gift_enabled: rewardEnabled,
        review_gift_description: rewardEnabled ? rewardDescription : null,
        review_team_members_text: reviewTeamMembersText || null,
        google_review_link_mode: isPositive && googleReviewUrl ? 'text_url' : null,
        trigger_message_id: triggerMessage?.id || null,
        recipient: followUpRecipient,
        test_send: isTestSend,
      },
      sent_at: new Date(),
    });
    emitQuickChatMessageCreated(conversation, appMessage);

    const response = await whatsappService.sendMessage({
      to: followUpRecipient,
      body,
      previewUrl: isPositive,
      useTemplate: false,
      clinicConfig: { ...clinicConfig, clinicId },
    });
    providerMessageId = response?.messages?.[0]?.id || null;
    await appMessage.update({
      status: 'sent',
      metadata: {
        ...(appMessage.metadata || {}),
        wa_response: response || null,
        wamid: providerMessageId,
      },
      sent_at: new Date(),
    });
    emitQuickChatMessageUpdated(conversation, appMessage);
  } catch (error) {
    status = 'failed';
    errorPayload = extractProviderError(error);
    if (appMessage) {
      await appMessage.update({
        status: 'failed',
        metadata: {
          ...(appMessage.metadata || {}),
          error: errorPayload.raw || errorPayload.message,
        },
      }).catch(() => null);
      emitQuickChatMessageUpdated(conversation, appMessage);
    }
  }

  await MarketingPatientContactEvent.create({
    list_id: list.id,
    item_id: item.id,
    paciente_id: item.paciente_id || null,
    event_type: 'review_rating_followup_sent',
    channel: 'whatsapp',
    payload: {
      status,
      kind: followUpKind,
      rating,
      threshold,
      trigger_message_id: triggerMessage?.id || null,
      recipient: followUpRecipient,
      test_send: isTestSend,
      google_review_url_sent: isPositive && !!googleReviewUrl,
      app_message_id: appMessage?.id || null,
      provider_message_id: providerMessageId,
      error: errorPayload || null,
    },
    occurred_at: occurredAt,
  });

  return { sent: status === 'sent', status, kind: followUpKind };
}

function formatReviewDate(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function buildPatientDisplayName(patient) {
  return [patient?.nombre, patient?.apellidos].filter(Boolean).join(' ').trim() || 'Paciente';
}

function resolveReviewTreatmentLabel(appointment, source = 'manual_selection') {
  const rawCandidates = [
    appointment?.tratamiento?.nombre,
    appointment?.tratamiento_nombre,
    appointment?.treatment_name,
    appointment?.titulo,
    appointment?.motivo,
  ];
  for (const candidate of rawCandidates) {
    let value = normalizeText(candidate);
    if (!value) continue;
    value = value.replace(/^Hist[oó]rico:\s*/i, '').trim();
    if (!value || /^(visita|cita|atenci[oó]n recibida|importaci[oó]n de pacientes)/i.test(value)) {
      continue;
    }
    return value;
  }
  return source === 'completed_treatment' ? 'tratamiento realizado' : 'atención recibida';
}

async function getReviewRequestedPatientIds(scope) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (!clinicIds.length) return new Set();
  const rows = await db.sequelize.query(
    `
    SELECT DISTINCT i.paciente_id AS paciente_id
    FROM MarketingPatientListItems i
    INNER JOIN MarketingPatientLists l ON l.id = i.list_id
    WHERE i.paciente_id IS NOT NULL
      AND i.clinica_id IN (:clinicIds)
      AND l.objective_id = :objectiveId
      AND l.status <> 'archived'
      AND (
        JSON_UNQUOTE(JSON_EXTRACT(l.criteria, '$.review_request')) IN ('true', '1')
        OR JSON_UNQUOTE(JSON_EXTRACT(l.criteria, '$.template_usage')) = 'solicitud_resena'
      )
      AND (
        i.sent_at IS NOT NULL
        OR i.dispatch_status IN ('queued','sending','sent','delivered','read','replied')
        OR (
          i.selected = TRUE
          AND i.status = 'ready'
          AND l.status IN ('ready','sending','sent','completed','scheduled')
        )
      )
    `,
    { replacements: { clinicIds, objectiveId: OBJECTIVE_ID }, type: QueryTypes.SELECT }
  );
  return new Set(rows.map((row) => Number(row.paciente_id)).filter(Number.isFinite));
}

function mapReviewPatientItem({ patient, appointment = null, source = 'manual_selection' }) {
  const name = buildPatientDisplayName(patient);
  const appointmentDate = appointment?.inicio || appointment?.appointment_at || null;
  const formattedAppointmentDate = formatReviewDate(appointmentDate);
  const visitReference = formattedAppointmentDate
    ? `el pasado ${formattedAppointmentDate}`
    : 'en tu última atención';
  const treatment = resolveReviewTreatmentLabel(appointment, source);
  const clinicName = normalizeText(appointment?.clinica?.nombre_clinica || '');

  return {
    paciente_id: patient.id_paciente,
    clinica_id: appointment?.clinica_id || patient.clinica_id || null,
    name,
    phone: patient.telefono_movil || null,
    email: patient.email || null,
    treatment,
    treatment_id: appointment?.tratamiento_id || null,
    last_visit_at: appointmentDate,
    appointment_at: appointmentDate,
    treatment_completed: source === 'completed_treatment',
    status: 'ready',
    reason: source === 'manual_selection'
      ? 'Paciente disponible para solicitud manual de valoración.'
      : 'Paciente elegible: no tiene solicitud de valoración previa.',
    exclusion_reason: null,
    selected: true,
    custom_fields: {
      nombre: patient.nombre || name,
      apellido: patient.apellidos || '',
      apellidos: patient.apellidos || '',
      nombre_completo: name,
      tratamiento: treatment,
      fecha: formattedAppointmentDate,
      fecha_cita: formattedAppointmentDate,
      referencia_visita: visitReference,
      clinica: clinicName,
      nombre_clinica: clinicName,
    },
    missing_variables: [],
  };
}

function isImportedHistoricalAppointment(appointment) {
  const reason = normalizeText(appointment?.motivo || appointment?.reason || '');
  const title = normalizeText(appointment?.titulo || appointment?.title || '');
  return reason === IMPORTED_HISTORICAL_APPOINTMENT_REASON
    || reason.startsWith('Importación de pacientes')
    || title.startsWith('Histórico:');
}

function getReviewRuleExclusionReason(item, rules = {}) {
  if (rules.no_phone && !normalizeText(item?.phone)) {
    return 'Sin teléfono móvil';
  }
  const treatment = normalizeText(item?.treatment || '').toLowerCase();
  if (
    rules.no_treatment
    && (!treatment || treatment === 'sin tratamiento asignado' || treatment === 'atención recibida' || treatment === 'atencion recibida')
  ) {
    return 'Sin tratamiento asociado';
  }
  if (rules.no_visit_date && !item?.last_visit_at && !item?.appointment_at) {
    return 'Sin fecha de atención';
  }
  return null;
}

function applyReviewRequestExclusions(items = [], source = {}) {
  const excludedPatientIds = new Set(parseReviewExcludedPatientIds(source));
  const rules = parseReviewExclusionRules(source);
  if (!excludedPatientIds.size && !rules.no_phone && !rules.no_treatment && !rules.no_visit_date) {
    return items;
  }
  return (items || []).map((item) => {
    if (String(item?.status || '').startsWith('excluded')) {
      return item;
    }
    const patientId = Number(item?.paciente_id || item?.patient_id || 0);
    const manualExcluded = patientId && excludedPatientIds.has(patientId);
    const ruleReason = getReviewRuleExclusionReason(item, rules);
    if (!manualExcluded && !ruleReason) {
      return item;
    }
    return {
      ...item,
      status: 'excluded_manual',
      reason: manualExcluded ? 'Excluido manualmente de esta solicitud de reseña.' : ruleReason,
      exclusion_reason: 'manual',
      selected: false,
    };
  });
}

async function buildReviewRequestCandidateForAppointment(scope, body = {}) {
  const appointmentId = Number(body.review_appointment_id || body.appointment_id || body.cita_id || 0);
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (!appointmentId || !clinicIds.length || !CitaPaciente) {
    return { item: null, reason: 'appointment_not_found' };
  }

  const source = normalizeReviewRequestSource(body.review_source || body.reviewRequestSource);
  const appointment = await CitaPaciente.findOne({
    where: {
      id_cita: appointmentId,
      clinica_id: { [Op.in]: clinicIds },
    },
    include: [
      { model: Paciente, as: 'paciente', required: true, attributes: ['id_paciente', 'clinica_id', 'nombre', 'apellidos', 'telefono_movil', 'email'] },
      { model: Clinica, as: 'clinica', required: false, attributes: ['id_clinica', 'nombre_clinica'] },
      db.Tratamiento ? { model: db.Tratamiento, as: 'tratamiento', required: false, attributes: ['id_tratamiento', 'nombre'] } : null,
    ].filter(Boolean),
  });
  if (!appointment) return { item: null, reason: 'appointment_not_found' };

  const plain = appointment.get ? appointment.get({ plain: true }) : appointment;
  if (plain.estado !== 'completada') {
    return { item: null, reason: 'appointment_not_completed' };
  }
  if (isImportedHistoricalAppointment(plain)) {
    return { item: null, reason: 'imported_historical_appointment' };
  }

  const patient = plain.paciente;
  const patientId = Number(patient?.id_paciente || plain.paciente_id || 0);
  if (!patientId) return { item: null, reason: 'patient_not_found' };

  const alreadyRequested = await getReviewRequestedPatientIds(scope);
  if (alreadyRequested.has(patientId)) {
    return { item: null, reason: 'patient_already_requested' };
  }

  let isFirstCompletedAppointment = true;
  if (source === 'first_completed_appointment' || source === 'first_completed_or_completed_treatment') {
    const firstCompleted = await CitaPaciente.findOne({
      where: {
        clinica_id: plain.clinica_id,
        paciente_id: patientId,
        estado: 'completada',
      },
      attributes: ['id_cita', 'inicio'],
      order: [['inicio', 'ASC'], ['id_cita', 'ASC']],
      raw: true,
    });
    isFirstCompletedAppointment = Number(firstCompleted?.id_cita || 0) === appointmentId;
    if (source === 'first_completed_appointment' && !isFirstCompletedAppointment) {
      return { item: null, reason: 'not_first_completed_appointment' };
    }
  }

  const isCompletedTreatment = !!plain.tratamiento_id || plain.tipo_cita === 'primera_con_trat';
  if (source === 'completed_treatment' && !isCompletedTreatment) {
    return { item: null, reason: 'appointment_without_completed_treatment' };
  }
  if (source === 'first_completed_or_completed_treatment' && !isFirstCompletedAppointment && !isCompletedTreatment) {
    return { item: null, reason: 'not_first_completed_or_completed_treatment' };
  }

  return {
    item: mapReviewPatientItem({ patient, appointment: plain, source }),
    reason: null,
  };
}

async function buildItemsForReviewRequest(scope, body = {}) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (!clinicIds.length) return [];

  if (body.review_appointment_id || body.appointment_id || body.cita_id) {
    const candidate = await buildReviewRequestCandidateForAppointment(scope, body);
    return candidate.item
      ? applyReviewRequestExclusions([candidate.item], body).filter((item) => !String(item.status || '').startsWith('excluded'))
      : [];
  }

  const source = normalizeReviewRequestSource(body.review_source || body.reviewRequestSource);
  const limit = Math.min(Math.max(Number(body.limit || 500), 1), 2000);
  const alreadyRequested = await getReviewRequestedPatientIds(scope);

  if (source === 'manual_selection' || !CitaPaciente) {
    const requestedIds = Array.from(alreadyRequested).filter(Number.isInteger);
    const requestedClause = requestedIds.length ? 'AND p.id_paciente NOT IN (:requestedIds)' : '';
    const patients = await db.sequelize.query(
      `
      SELECT DISTINCT
        p.id_paciente,
        p.clinica_id,
        p.nombre,
        p.apellidos,
        p.telefono_movil,
        p.email,
        COALESCE(pc.clinica_id, p.clinica_id) AS review_clinica_id,
        c.nombre_clinica AS review_clinica_nombre
      FROM Pacientes p
      LEFT JOIN PacienteClinicas pc
        ON pc.paciente_id = p.id_paciente
       AND pc.clinica_id IN (:clinicIds)
      LEFT JOIN Clinicas c
        ON c.id_clinica = COALESCE(pc.clinica_id, p.clinica_id)
      WHERE p.fecha_baja IS NULL
        AND (p.clinica_id IN (:clinicIds) OR pc.clinica_id IS NOT NULL)
        ${requestedClause}
      ORDER BY p.id_paciente DESC
      LIMIT :limit
      `,
      {
        replacements: {
          clinicIds,
          requestedIds,
          limit,
        },
        type: QueryTypes.SELECT,
      }
    );
    const patientIds = patients
      .map((patient) => Number(patient.id_paciente))
      .filter((id) => Number.isInteger(id) && id > 0);
    const customRows = PatientCustomField && patientIds.length
      ? await PatientCustomField.findAll({
        where: {
          paciente_id: { [Op.in]: patientIds },
          clinica_id: { [Op.in]: clinicIds },
        },
        attributes: ['paciente_id', 'field_key', 'value'],
        raw: true,
      })
      : [];
    const customByPatient = new Map();
    for (const row of customRows) {
      const id = Number(row.paciente_id);
      if (!customByPatient.has(id)) customByPatient.set(id, []);
      customByPatient.get(id).push(row);
    }
    const latestAppointmentRows = CitaPaciente && patientIds.length
      ? await db.sequelize.query(
        `
        SELECT
          c.id_cita,
          c.paciente_id,
          c.clinica_id,
          c.tratamiento_id,
          c.inicio,
          c.titulo,
          c.motivo,
          cl.nombre_clinica AS clinica_nombre,
          t.nombre AS tratamiento_nombre
        FROM CitasPacientes c
        LEFT JOIN Clinicas cl ON cl.id_clinica = c.clinica_id
        LEFT JOIN Tratamientos t ON t.id_tratamiento = c.tratamiento_id
        WHERE c.paciente_id IN (:patientIds)
          AND c.clinica_id IN (:clinicIds)
          AND c.estado = 'completada'
        ORDER BY c.paciente_id ASC, c.inicio DESC, c.id_cita DESC
        `,
        {
          replacements: {
            clinicIds,
            patientIds,
          },
          type: QueryTypes.SELECT,
        }
      )
      : [];
    const latestAppointmentByPatient = new Map();
    for (const row of latestAppointmentRows) {
      const patientId = Number(row.paciente_id);
      if (!patientId || latestAppointmentByPatient.has(patientId)) continue;
      latestAppointmentByPatient.set(patientId, row);
    }

    return applyReviewRequestExclusions(patients.map((patient) => {
      const latestAppointment = latestAppointmentByPatient.get(Number(patient.id_paciente));
      const item = mapReviewPatientItem({
        patient,
        appointment: latestAppointment
          ? {
            clinica_id: Number(latestAppointment.clinica_id || patient.review_clinica_id || patient.clinica_id || 0) || null,
            tratamiento_id: Number(latestAppointment.tratamiento_id || 0) || null,
            inicio: latestAppointment.inicio || null,
            titulo: latestAppointment.titulo || '',
            motivo: latestAppointment.motivo || '',
            clinica: { nombre_clinica: latestAppointment.clinica_nombre || patient.review_clinica_nombre || '' },
            tratamiento: latestAppointment.tratamiento_nombre
              ? { nombre: latestAppointment.tratamiento_nombre }
              : null,
          }
          : {
            clinica_id: Number(patient.review_clinica_id || patient.clinica_id || 0) || null,
            clinica: { nombre_clinica: patient.review_clinica_nombre || '' },
          },
        source,
      });
      const patientFields = buildPatientVariableFields(patient, customByPatient.get(Number(patient.id_paciente)) || []);
      return {
        ...item,
        custom_fields: {
          ...patientFields,
          ...(item.custom_fields || {}),
        },
      };
    }), body);
  }

  const appointmentWhere = {
    clinica_id: { [Op.in]: clinicIds },
  };
  const treatmentIds = parseReviewTreatmentIds(body);
  const treatmentMoment = normalizeText(body.review_treatment_moment || body.reviewTreatmentMoment || 'completed').toLowerCase();
  if (treatmentMoment === 'started_or_completed' || treatmentMoment === 'started') {
    appointmentWhere.estado = { [Op.ne]: 'cancelada' };
  } else {
    appointmentWhere.estado = 'completada';
  }
  if (source === 'completed_treatment') {
    appointmentWhere[Op.or] = [
      { tratamiento_id: { [Op.ne]: null } },
      { tipo_cita: 'primera_con_trat' },
    ];
  }
  if (treatmentIds.length) {
    appointmentWhere.tratamiento_id = { [Op.in]: treatmentIds };
    delete appointmentWhere[Op.or];
  }

  const appointments = await CitaPaciente.findAll({
    where: appointmentWhere,
    include: [
      { model: Paciente, as: 'paciente', required: true, attributes: ['id_paciente', 'clinica_id', 'nombre', 'apellidos', 'telefono_movil', 'email'] },
      { model: Clinica, as: 'clinica', required: false, attributes: ['id_clinica', 'nombre_clinica'] },
      db.Tratamiento ? { model: db.Tratamiento, as: 'tratamiento', required: false, attributes: ['id_tratamiento', 'nombre'] } : null,
    ].filter(Boolean),
    order: [['inicio', 'ASC']],
    limit: Math.min(limit * 5, 10000),
  });

  const selected = new Map();
  for (const appointment of appointments) {
    const plain = appointment?.get ? appointment.get({ plain: true }) : appointment;
    const patient = plain?.paciente;
    const patientId = Number(patient?.id_paciente || plain?.paciente_id);
    if (!patientId || alreadyRequested.has(patientId) || selected.has(patientId)) continue;
    selected.set(patientId, mapReviewPatientItem({ patient, appointment: plain, source }));
    if (selected.size >= limit) break;
  }

  return applyReviewRequestExclusions(Array.from(selected.values()), body);
}

async function buildReviewTreatmentOptions(scope) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (!clinicIds.length || !CitaPaciente || !db.Tratamiento) return [];

  const alreadyRequested = await getReviewRequestedPatientIds(scope);
  const requestedIds = Array.from(alreadyRequested).filter(Number.isInteger);
  const requestedClause = requestedIds.length
    ? 'AND c.paciente_id NOT IN (:requestedIds)'
    : '';

  const rows = await db.sequelize.query(
    `
    SELECT
      c.tratamiento_id AS treatment_id,
      COALESCE(t.nombre, c.titulo, c.motivo, 'Tratamiento') AS treatment_name,
      COUNT(DISTINCT c.paciente_id) AS eligible_count
    FROM CitasPacientes c
    INNER JOIN Pacientes p ON p.id_paciente = c.paciente_id
    LEFT JOIN Tratamientos t ON t.id_tratamiento = c.tratamiento_id
    WHERE c.clinica_id IN (:clinicIds)
      AND c.estado = 'completada'
      AND c.tratamiento_id IS NOT NULL
      AND p.fecha_baja IS NULL
      ${requestedClause}
    GROUP BY c.tratamiento_id, COALESCE(t.nombre, c.titulo, c.motivo, 'Tratamiento')
    HAVING eligible_count > 0
    ORDER BY eligible_count DESC, treatment_name ASC
    LIMIT 200
    `,
    {
      replacements: {
        clinicIds,
        requestedIds,
      },
      type: QueryTypes.SELECT,
    }
  );

  return rows.map((row) => ({
    id: Number(row.treatment_id),
    name: normalizeText(row.treatment_name) || 'Tratamiento',
    eligible_count: Number(row.eligible_count || 0),
  })).filter((row) => row.id && row.eligible_count > 0);
}

function buildReviewAutomationScopeWhere(scope = {}, { includeInactive = false } = {}) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  const clauses = [];
  if (clinicIds.length === 1) {
    clauses.push({ clinic_id: clinicIds[0], group_id: null });
  } else if (clinicIds.length > 1) {
    clauses.push({ clinic_id: { [Op.in]: clinicIds }, group_id: null });
  }
  if (!clauses.length) clauses.push({ id: { [Op.eq]: -1 } });
  return {
    trigger_type: REVIEW_AUTOMATION_TRIGGER,
    published_at: { [Op.ne]: null },
    ...(includeInactive ? {} : { is_active: true }),
    [Op.or]: clauses,
  };
}

function templateHasReviewRequestAction(template) {
  const nodes = Array.isArray(template?.nodes) ? template.nodes : [];
  return nodes.some((node) => normalizeText(node?.type) === REVIEW_AUTOMATION_ACTION);
}

function serializeReviewAutomationTemplate(template) {
  if (!template) return null;
  const plain = template.get ? template.get({ plain: true }) : template;
  const actionNode = (Array.isArray(plain.nodes) ? plain.nodes : [])
    .find((node) => normalizeText(node?.type) === REVIEW_AUTOMATION_ACTION);
  const config = actionNode?.config && typeof actionNode.config === 'object' ? actionNode.config : {};
  return {
    id: plain.id,
    public_id: plain.public_id || null,
    template_key: plain.template_key,
    version: plain.version,
    name: plain.name,
    is_active: plain.is_active === true,
    review_source: normalizeReviewRequestSource(config.review_source),
    review_threshold: normalizeReviewThreshold(config.review_threshold),
    whatsapp_template_id: Number(config.whatsapp_template_id || 0) || null,
    template_name: normalizeText(config.template_name) || REVIEW_TEMPLATE_NAME,
    review_gift_enabled: config.review_gift_enabled === true || String(config.review_gift_enabled || '').toLowerCase() === 'true',
    review_gift_description: normalizeText(config.review_gift_description || '') || null,
    review_display_clinic_name: normalizeText(config.review_display_clinic_name || '') || null,
    review_sender_name: normalizeText(config.review_sender_name || '') || null,
    review_team_photo_url: normalizeText(config.review_team_photo_url || '') || null,
    review_team_photo_overlay_color: publicMediaPersonalizationService.normalizeHexColor(
      config.review_team_photo_overlay_color || publicMediaPersonalizationService.DEFAULT_OVERLAY_COLOR
    ),
    review_team_members_text: normalizeText(config.review_team_members_text || '') || null,
  };
}

function serializeReviewRequestTemplateFromList(list) {
  if (!list) return null;
  const plain = list.get ? list.get({ plain: true }) : list;
  const criteria = asPlainObject(plain.criteria);
  if (!isReviewTemplateUsage(criteria.template_usage) && criteria.review_request !== true && String(criteria.review_request || '').toLowerCase() !== 'true') {
    return null;
  }
  return {
    id: plain.id,
    public_id: null,
    template_key: `review_request_list_${plain.id}`,
    version: 1,
    name: normalizeText(plain.name || plain.list_name || '') || 'Solicitud de reseñas',
    is_active: ['queued', 'sending', 'sent', 'prepared'].includes(normalizeKey(plain.status)),
    review_source: normalizeReviewRequestSource(criteria.review_source),
    review_threshold: normalizeReviewThreshold(criteria.review_threshold),
    whatsapp_template_id: Number(criteria.whatsapp_template_id || plain.template_id || plain.template_snapshot?.id || 0) || null,
    template_name: normalizeText(criteria.template_name || plain.template_snapshot?.name || '') || REVIEW_TEMPLATE_NAME,
    review_gift_enabled: criteria.review_gift_enabled === true || String(criteria.review_gift_enabled || '').toLowerCase() === 'true',
    review_gift_description: normalizeText(criteria.review_gift_description || '') || null,
    review_display_clinic_name: normalizeText(criteria.review_display_clinic_name || '') || null,
    review_sender_name: normalizeText(criteria.review_sender_name || '') || null,
    review_team_photo_url: normalizeText(criteria.review_team_photo_url || '') || null,
    review_team_photo_overlay_color: publicMediaPersonalizationService.normalizeHexColor(
      criteria.review_team_photo_overlay_color || publicMediaPersonalizationService.DEFAULT_OVERLAY_COLOR
    ),
    review_team_members_text: normalizeText(criteria.review_team_members_text || '') || null,
  };
}

async function getLastReviewRequestTemplateForScope(scope) {
  const rows = await MarketingPatientList.findAll({
    where: {
      objective_id: OBJECTIVE_ID,
      status: { [Op.ne]: 'archived' },
    },
    order: [
      ['updated_at', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: 75,
  });
  for (const row of rows) {
    if (!listInScope(row, scope)) continue;
    const serialized = serializeReviewRequestTemplateFromList(row);
    const hasMessageConfig = !!(
      serialized?.review_sender_name
      || serialized?.review_team_photo_url
      || serialized?.review_team_members_text
      || serialized?.review_gift_enabled
      || serialized?.review_gift_description
    );
    if (hasMessageConfig) return serialized;
  }
  return null;
}

async function getReviewAutomationTemplate(scope, { includeInactive = false } = {}) {
  if (!AutomationFlowTemplateV2) return null;
  const rows = await AutomationFlowTemplateV2.findAll({
    where: buildReviewAutomationScopeWhere(scope, { includeInactive }),
    order: [
      ['clinic_id', 'DESC'],
      ['group_id', 'DESC'],
      ['version', 'DESC'],
      ['id', 'DESC'],
    ],
    limit: 20,
  });
  return rows.find(templateHasReviewRequestAction) || null;
}

function isReviewWhatsappTemplateCandidate(template) {
  const plain = template?.get ? template.get({ plain: true }) : (template || {});
  const text = normalizeKey([
    plain.name,
    plain.display_name,
    plain.category,
    plain.catalog?.name,
    plain.catalog?.display_name,
    plain.catalog?.body_text,
    JSON.stringify(plain.variables || ''),
    JSON.stringify(plain.components || ''),
  ].filter(Boolean).join(' '));
  return REVIEW_TEMPLATE_USAGES.has(normalizeTemplateUsage(plain.variables?.template_usage))
    || text.includes('solicitud_resena')
    || text.includes('resena')
    || text.includes('review')
    || text.includes('valoracion')
    || text.includes('opinion');
}

function isReviewReminderWhatsappTemplateCandidate(template) {
  const plain = template?.get ? template.get({ plain: true }) : (template || {});
  const text = normalizeKey([
    plain.name,
    plain.display_name,
    plain.catalog?.name,
    plain.catalog?.display_name,
    plain.catalog?.body_text,
    JSON.stringify(plain.variables || ''),
    JSON.stringify(plain.components || ''),
  ].filter(Boolean).join(' '));
  return text.includes('recordatorio_resena_sin_respuesta')
    || text.includes('recordatorio_de_valoracion_sin_respuesta')
    || (text.includes('recordatorio') && text.includes('resena'))
    || (text.includes('recordatorio') && text.includes('valoracion'));
}

function isPrimaryReviewRequestWhatsappTemplateCandidate(template) {
  if (!isReviewWhatsappTemplateCandidate(template)) return false;
  if (isReviewReminderWhatsappTemplateCandidate(template)) return false;
  if (templateHasButtonComponents(template)) return false;
  const plain = template?.get ? template.get({ plain: true }) : (template || {});
  const currentCatalogBody = normalizeText(plain.catalog?.body_text);
  if (currentCatalogBody) {
    const templateBody = normalizeText(extractBodyText(plain.components));
    if (templateBody !== currentCatalogBody && !isStarTextReviewBody(templateBody)) return false;
  }
  const text = normalizeKey([
    plain.name,
    plain.display_name,
    plain.catalog?.name,
    plain.catalog?.display_name,
    JSON.stringify(plain.variables || ''),
  ].filter(Boolean).join(' '));
  return text.includes(REVIEW_TEMPLATE_NAME)
    || text.includes(REVIEW_PHOTO_TEMPLATE_NAME)
    || text.includes('solicitar_resena')
    || text.includes('solicitud_resena')
    || text.includes('solicitud_de_valoracion')
    || REVIEW_TEMPLATE_USAGES.has(normalizeTemplateUsage(plain.variables?.template_usage));
}

function reviewTemplateMatchesCurrentCatalogBody(template) {
  const plain = template?.get ? template.get({ plain: true }) : (template || {});
  const currentCatalogBody = normalizeText(plain.catalog?.body_text);
  if (!currentCatalogBody) return false;
  const templateBody = normalizeText(extractBodyText(plain.components));
  return templateBody === currentCatalogBody && reviewTemplateBodyHasSender(templateBody);
}

function templateMatchesCurrentCatalogBody(template) {
  const plain = template?.get ? template.get({ plain: true }) : (template || {});
  const currentCatalogBody = normalizeText(plain.catalog?.body_text);
  if (!currentCatalogBody) return false;
  const templateBody = normalizeText(extractBodyText(plain.components));
  return templateBody === currentCatalogBody;
}

function scoreReviewTemplateFreshness(template) {
  return reviewTemplateMatchesCurrentCatalogBody(template) ? 1 : 0;
}

async function findApprovedReviewReminderWhatsappTemplate(scope) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (!WhatsappTemplate || !clinicIds.length) return null;
  const targetWabaId = await getPrimaryWabaIdForScope(scope);
  const candidates = await WhatsappTemplate.findAll({
    where: {
      is_active: true,
      status: 'APPROVED',
      [Op.and]: [
        {
          [Op.or]: [
            { clinic_id: { [Op.in]: clinicIds } },
            { clinic_id: null },
          ],
        },
        {
          [Op.or]: [
            { name: { [Op.like]: `${REVIEW_REMINDER_TEMPLATE_NAME}%` } },
            { name: { [Op.like]: '%recordatorio_resena%' } },
            { name: { [Op.like]: '%recordatorio_de_valoracion%' } },
            ...(targetWabaId ? [{ waba_id: targetWabaId }] : []),
          ],
        },
      ],
    },
    include: [{ model: db.WhatsappTemplateCatalog, as: 'catalog', attributes: ['id', 'name', 'display_name', 'body_text', 'variables'], required: false }],
    order: [['updatedAt', 'DESC'], ['id', 'DESC']],
  });
  return candidates
    .filter(isReviewReminderWhatsappTemplateCandidate)
    .filter(templateMatchesCurrentCatalogBody)
    .filter((template) => scoreWhatsappTemplateForScope(template, clinicIds, targetWabaId) > 0)
    .sort((a, b) => {
      const aScore = scoreWhatsappTemplateForScope(a, clinicIds, targetWabaId);
      const bScore = scoreWhatsappTemplateForScope(b, clinicIds, targetWabaId);
      if (aScore !== bScore) return bScore - aScore;
      return Number(b.id || 0) - Number(a.id || 0);
    })[0] || null;
}

async function findApprovedReviewWhatsappTemplate(scope, explicitTemplateId = null, options = {}) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (!WhatsappTemplate || !clinicIds.length) return null;
  const targetWabaId = await getPrimaryWabaIdForScope(scope);
  const preferPhoto = options.preferPhoto === true;

  if (preferPhoto) {
    const photoCandidates = await WhatsappTemplate.findAll({
      where: {
        is_active: true,
        status: 'APPROVED',
        name: { [Op.like]: `${REVIEW_PHOTO_TEMPLATE_NAME}%` },
        [Op.or]: [
          { clinic_id: { [Op.in]: clinicIds } },
          { clinic_id: null },
        ],
      },
      include: [{ model: db.WhatsappTemplateCatalog, as: 'catalog', attributes: ['id', 'name', 'display_name', 'body_text', 'variables'], required: false }],
      order: [['updatedAt', 'DESC'], ['id', 'DESC']],
    });
    const photoTemplate = photoCandidates
      .filter(isPrimaryReviewRequestWhatsappTemplateCandidate)
      .filter(templateHasImageHeader)
      .filter(reviewTemplateMatchesCurrentCatalogBody)
      .filter((template) => scoreWhatsappTemplateForScope(template, clinicIds, targetWabaId) > 0)
      .sort((a, b) => {
        const aScore = scoreWhatsappTemplateForScope(a, clinicIds, targetWabaId);
        const bScore = scoreWhatsappTemplateForScope(b, clinicIds, targetWabaId);
        if (aScore !== bScore) return bScore - aScore;
        return Number(b.id || 0) - Number(a.id || 0);
      })[0] || null;
    if (photoTemplate) return photoTemplate;
  }

  if (explicitTemplateId) {
    const explicit = await resolveWhatsappTemplate(explicitTemplateId, scope);
    if (explicit && explicit.is_active !== false && String(explicit.status || '').toUpperCase() === 'APPROVED' && isPrimaryReviewRequestWhatsappTemplateCandidate(explicit)) {
      const plainExplicit = explicit.get ? explicit.get({ plain: true }) : explicit;
      const explicitMatchesWaba = !targetWabaId || !getTemplateWabaId(explicit) || getTemplateWabaId(explicit) === targetWabaId;
      if (explicitMatchesWaba && reviewTemplateMatchesCurrentCatalogBody(explicit)) {
        return explicit;
      }
      if (plainExplicit.catalog_template_id) {
        const exactReplacement = await WhatsappTemplate.findOne({
          where: {
            is_active: true,
            status: 'APPROVED',
            catalog_template_id: plainExplicit.catalog_template_id,
            ...(targetWabaId ? { waba_id: targetWabaId } : {}),
          },
          include: [{ model: db.WhatsappTemplateCatalog, as: 'catalog', attributes: ['id', 'name', 'display_name', 'body_text', 'variables'], required: false }],
          order: [['updatedAt', 'DESC'], ['id', 'DESC']],
        });
        if (
          exactReplacement
          && isPrimaryReviewRequestWhatsappTemplateCandidate(exactReplacement)
          && reviewTemplateMatchesCurrentCatalogBody(exactReplacement)
        ) {
          return exactReplacement;
        }
      }
      if (!explicitMatchesWaba) {
        const replacement = await WhatsappTemplate.findOne({
          where: {
            is_active: true,
            status: 'APPROVED',
            catalog_template_id: plainExplicit.catalog_template_id || null,
            waba_id: targetWabaId,
          },
          include: [{ model: db.WhatsappTemplateCatalog, as: 'catalog', attributes: ['id', 'name', 'display_name', 'body_text', 'variables'], required: false }],
          order: [['updatedAt', 'DESC'], ['id', 'DESC']],
        });
        if (
          replacement
          && isPrimaryReviewRequestWhatsappTemplateCandidate(replacement)
          && reviewTemplateMatchesCurrentCatalogBody(replacement)
        ) {
          return replacement;
        }
      }
    }
    return null;
  }

  const candidates = await WhatsappTemplate.findAll({
    where: {
      is_active: true,
      status: 'APPROVED',
      [Op.and]: [
        {
          [Op.or]: [
            { clinic_id: { [Op.in]: clinicIds } },
            { clinic_id: null },
          ],
        },
        {
          [Op.or]: [
            { name: { [Op.like]: `%${REVIEW_TEMPLATE_NAME}%` } },
            { name: { [Op.like]: `%${REVIEW_PHOTO_TEMPLATE_NAME}%` } },
            { name: { [Op.like]: '%solicitar_resena%' } },
            { name: { [Op.like]: '%solicitud_resena%' } },
            { name: { [Op.like]: '%solicitud_de_valoracion%' } },
            { display_name: { [Op.like]: '%reseña%' } },
            { display_name: { [Op.like]: '%resena%' } },
            ...(targetWabaId ? [{ waba_id: targetWabaId }] : []),
          ],
        },
      ],
    },
    include: [{ model: db.WhatsappTemplateCatalog, as: 'catalog', attributes: ['id', 'name', 'display_name', 'body_text', 'variables'], required: false }],
    order: [['updatedAt', 'DESC'], ['id', 'DESC']],
  });
  return candidates
    .filter(isPrimaryReviewRequestWhatsappTemplateCandidate)
    .filter(reviewTemplateMatchesCurrentCatalogBody)
    .filter((template) => scoreWhatsappTemplateForScope(template, clinicIds, targetWabaId) > 0)
    .sort((a, b) => {
      const aScore = scoreWhatsappTemplateForScope(a, clinicIds, targetWabaId);
      const bScore = scoreWhatsappTemplateForScope(b, clinicIds, targetWabaId);
      if (aScore !== bScore) return bScore - aScore;
      const aFresh = scoreReviewTemplateFreshness(a);
      const bFresh = scoreReviewTemplateFreshness(b);
      if (aFresh !== bFresh) return bFresh - aFresh;
      return Number(b.id || 0) - Number(a.id || 0);
    })[0] || null;
}

async function waitForReviewRequestDispatchAnchor(campaignId, timeoutMs = 6000) {
  const safeCampaignId = Number(campaignId || 0);
  if (!safeCampaignId) return null;

  const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
  do {
    const item = await MarketingPatientListItem.findOne({
      where: {
        list_id: safeCampaignId,
        app_message_id: { [Op.ne]: null },
        conversation_id: { [Op.ne]: null },
      },
      order: [['sent_at', 'DESC'], ['updated_at', 'DESC'], ['id', 'ASC']],
    });
    if (item) {
      const plain = item.get ? item.get({ plain: true }) : item;
      return {
        item_id: plain.id,
        patient_id: plain.paciente_id || null,
        message_id: plain.app_message_id || null,
        app_message_id: plain.app_message_id || null,
        conversation_id: plain.conversation_id || null,
        provider_message_id: plain.provider_message_id || null,
        sent_at: plain.sent_at || null,
        dispatch_status: plain.dispatch_status || null,
      };
    }

    if (Date.now() >= deadline) break;
    await sleep(250);
  } while (true);

  return null;
}

async function hasGoogleReviewUrlForScope(scope) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (!clinicIds.length) return false;
  const checks = await Promise.all(clinicIds.map(async (clinicId) => {
    const clinic = await loadClinicForTemplateVariables(clinicId);
    return !!normalizeText(clinic?.url_dejar_resena);
  }));
  return checks.every(Boolean);
}

async function hasWhatsappConfigForClinic(clinicId) {
  const safeClinicId = Number(clinicId || 0);
  if (!safeClinicId) return false;
  try {
    const config = await whatsappService.getClinicConfig(safeClinicId);
    return !!(config?.phoneNumberId && config?.accessToken);
  } catch (_) {
    return false;
  }
}

async function hasWhatsappConfigForScope(scope) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (!clinicIds.length) return false;
  const checks = await Promise.all(clinicIds.map((clinicId) => hasWhatsappConfigForClinic(clinicId)));
  return checks.every(Boolean);
}

async function buildReviewClinicStatuses(scope, options = {}) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (!clinicIds.length || !Clinica) return [];

  const reviewSource = normalizeReviewRequestSource(options.review_source || options.reviewSource);
  const treatmentIds = parseReviewTreatmentIds(options);
  const clinics = await Clinica.findAll({
    where: { id_clinica: { [Op.in]: clinicIds } },
    attributes: ['id_clinica', 'nombre_clinica'],
    order: [['nombre_clinica', 'ASC']],
    raw: true,
  });

  return Promise.all(clinics.map(async (clinic) => {
    const clinicId = Number(clinic.id_clinica);
    const clinicScope = {
      ...scope,
      scope: 'clinic',
      clinicIds: [clinicId],
      groupId: null,
      isAll: false,
      isValid: true,
    };
    const [candidateItems, approvedTemplate, approvedReminderTemplate, approvedPhotoTemplate, googleReviewUrlAvailable, whatsappAvailable, clinicAutomationTemplate] = await Promise.all([
      buildItemsForReviewRequest(clinicScope, {
        review_request: true,
        review_source: reviewSource,
        review_treatment_ids: treatmentIds,
        review_treatment_moment: options.review_treatment_moment || options.reviewTreatmentMoment || null,
        limit: 5000,
      }),
      findApprovedReviewWhatsappTemplate(clinicScope),
      findApprovedReviewReminderWhatsappTemplate(clinicScope),
      findApprovedReviewWhatsappTemplate(clinicScope, null, { preferPhoto: true }),
      hasGoogleReviewUrlForScope(clinicScope),
      hasWhatsappConfigForScope(clinicScope),
      getReviewAutomationTemplate(clinicScope, { includeInactive: true }),
    ]);
    const templatesReady = !!approvedTemplate && !!approvedReminderTemplate;
    const ready = !!googleReviewUrlAvailable && !!whatsappAvailable && templatesReady;
    const serializedAutomation = serializeReviewAutomationTemplate(clinicAutomationTemplate);
    const automationExcludedByOverride = !!clinicAutomationTemplate && clinicAutomationTemplate.is_active !== true;
    const missing = [
      !googleReviewUrlAvailable ? 'google_review_url' : null,
      !whatsappAvailable ? 'whatsapp_connection' : null,
      !approvedTemplate ? 'approved_whatsapp_template' : null,
      approvedTemplate && !approvedReminderTemplate ? 'approved_review_reminder_template' : null,
    ].filter(Boolean);
    const googleLabel = googleReviewUrlAvailable ? 'Ficha lista' : 'Falta Perfil Google';
    const whatsappLabel = whatsappAvailable ? 'WhatsApp conectado' : 'Falta WhatsApp';
    const templateLabel = templatesReady
      ? 'Plantillas aprobadas'
      : (approvedTemplate ? 'Recordatorio pendiente' : 'Plantilla del sistema pendiente');
    const statusLabel = ready ? 'Lista para enviar' : 'No enviará todavía';
    const statusHint = ready
      ? 'Esta sede tiene Perfil Google, WhatsApp y plantillas aprobadas. Puede recibir solicitudes de valoración.'
      : [
          !googleReviewUrlAvailable ? 'Conecta su Perfil Google para generar el enlace correcto de reseña.' : null,
          !whatsappAvailable ? 'Conecta WhatsApp para poder enviar la solicitud.' : null,
          !approvedTemplate ? 'ClinicaClick debe tener una plantilla de reseñas aprobada por WhatsApp para esta sede.' : null,
          approvedTemplate && !approvedReminderTemplate ? 'ClinicaClick debe tener aprobada también la plantilla de recordatorio de reseñas.' : null,
        ].filter(Boolean).join(' ');
    const automationLabel = clinicAutomationTemplate?.is_active === true
      ? (ready ? 'Activa' : 'Configurada, sin enviar')
      : (ready ? 'Lista para activar' : 'Pendiente');
    const automationHint = clinicAutomationTemplate?.is_active === true
      ? (ready
        ? 'La sede pedirá valoraciones automáticamente cuando se cumplan las reglas.'
        : 'La automatización está guardada, pero no enviará reseñas hasta resolver los requisitos pendientes.')
      : (ready
        ? 'Puede activarse desde el interruptor general del grupo.'
        : 'No se ejecutará hasta resolver los requisitos pendientes.');

    return {
      clinic_id: clinicId,
      clinic_name: normalizeText(clinic.nombre_clinica) || `Clínica ${clinicId}`,
      possible_patients: candidateItems.length,
      google_review_url_available: !!googleReviewUrlAvailable,
      google_status_label: googleLabel,
      whatsapp_available: !!whatsappAvailable,
      whatsapp_status_label: whatsappLabel,
      approved_template_available: templatesReady,
      approved_template_id: approvedTemplate?.id || null,
      approved_reminder_template_available: !!approvedReminderTemplate,
      approved_reminder_template_id: approvedReminderTemplate?.id || null,
      approved_photo_template_available: !!approvedPhotoTemplate && templateHasImageHeader(approvedPhotoTemplate),
      approved_photo_template_id: templateHasImageHeader(approvedPhotoTemplate) ? (approvedPhotoTemplate?.id || null) : null,
      template_status_label: templateLabel,
      clinic_automation_enabled: clinicAutomationTemplate?.is_active === true,
      clinic_automation_has_override: !!clinicAutomationTemplate,
      clinic_automation_excluded_by_override: automationExcludedByOverride,
      clinic_automation_template: serializedAutomation,
      status_label: statusLabel,
      status_hint: statusHint,
      automation_label: automationLabel,
      automation_hint: automationHint,
      ready,
      missing,
    };
  }));
}

function buildReviewReadinessExclusion(item, readinessByClinic = new Map()) {
  if (!item || String(item.status || '').startsWith('excluded')) return null;

  const clinicId = Number(item.clinica_id || item.clinic_id || 0) || null;
  if (!clinicId) {
    return {
      status: 'excluded_review_clinic_unassigned',
      exclusion_reason: 'clinica_no_identificada',
      selected: false,
      reason: 'No se ha podido asociar este contacto a una clínica del grupo. Revisa teléfono/email o asigna sede antes de enviar.',
    };
  }

  const clinicStatus = readinessByClinic.get(clinicId);
  if (!clinicStatus) {
    return {
      status: 'excluded_review_clinic_unavailable',
      exclusion_reason: 'clinica_fuera_de_grupo',
      selected: false,
      reason: 'La clínica asociada no está disponible en el grupo seleccionado.',
    };
  }

  if (clinicStatus.ready) return null;

  const missing = Array.isArray(clinicStatus.missing) ? clinicStatus.missing : [];
  const missingLabels = missing.map((key) => {
    if (key === 'google_review_url') return 'ficha Google de reseñas';
    if (key === 'whatsapp_connection') return 'WhatsApp conectado';
    if (key === 'approved_whatsapp_template') return 'plantilla WhatsApp aprobada';
    if (key === 'approved_review_reminder_template') return 'plantilla de recordatorio aprobada';
    return key;
  });
  return {
    status: 'excluded_review_clinic_not_ready',
    exclusion_reason: 'clinica_no_preparada_resenas',
    selected: false,
    reason: `La clínica ${clinicStatus.clinic_name || clinicStatus.clinicName || clinicId} todavía no puede pedir reseñas${missingLabels.length ? `: falta ${missingLabels.join(' y ')}` : '.'}.`,
  };
}

function applyReviewClinicReadinessExclusions(itemPayloads = [], clinicStatuses = []) {
  const readinessByClinic = new Map(
    (clinicStatuses || [])
      .map((status) => [Number(status.clinic_id || status.clinicId || 0), status])
      .filter(([clinicId]) => clinicId)
  );
  if (!readinessByClinic.size) return itemPayloads;

  return itemPayloads.map((item) => {
    const exclusionPatch = buildReviewReadinessExclusion(item, readinessByClinic);
    return exclusionPatch ? { ...item, ...exclusionPatch } : item;
  });
}

async function getReviewRequestSummary(scope, options = {}) {
  const reviewSource = normalizeReviewRequestSource(options.review_source || options.reviewSource);
  const treatmentIds = parseReviewTreatmentIds(options);
  const effectiveScope = applyReviewClinicFilter(scope, options);
  const previewLimit = clampInteger(options.preview_limit || options.previewLimit, 8, 1, 1000);
  const [candidates, treatmentOptions] = await Promise.all([
    buildItemsForReviewRequest(effectiveScope, {
      review_request: true,
      review_source: reviewSource,
      review_treatment_ids: treatmentIds,
      review_treatment_moment: options.review_treatment_moment || options.reviewTreatmentMoment || null,
      limit: 5000,
    }),
    buildReviewTreatmentOptions(effectiveScope),
  ]);
  const clinicIds = Array.isArray(effectiveScope?.clinicIds) ? effectiveScope.clinicIds.filter(Number.isInteger) : [];
  if (!clinicIds.length) {
    return {
      success: true,
      summary: {
        possible_patients: 0,
        candidates_preview: [],
        requests_sent: 0,
        ratings_1_to_4: 0,
        ratings_5: 0,
        treatment_options: [],
        automation_enabled: false,
        automation_template: null,
        last_request_template: null,
        approved_template_available: false,
        approved_reminder_template_available: false,
        google_review_url_available: false,
        whatsapp_available: false,
      },
    };
  }

  const [sentRow] = await db.sequelize.query(
    `
    SELECT COUNT(DISTINCT i.id) AS total
    FROM MarketingPatientListItems i
    INNER JOIN MarketingPatientLists l ON l.id = i.list_id
    WHERE i.clinica_id IN (:clinicIds)
      AND l.objective_id = :objectiveId
      AND (
        JSON_UNQUOTE(JSON_EXTRACT(l.criteria, '$.review_request')) IN ('true', '1')
        OR JSON_UNQUOTE(JSON_EXTRACT(l.criteria, '$.template_usage')) = 'solicitud_resena'
      )
      AND (
        i.sent_at IS NOT NULL
        OR i.dispatch_status IN ('queued','sending','sent','delivered','read','replied')
      )
      AND NOT EXISTS (
        SELECT 1
        FROM MarketingPatientContactEvents te
        WHERE te.list_id = i.list_id
          AND te.item_id = i.id
          AND te.event_type IN ('mass_campaign_test_sent', 'mass_campaign_test_failed')
      )
    `,
    { replacements: { clinicIds, objectiveId: OBJECTIVE_ID }, type: QueryTypes.SELECT }
  );

  const reviewRatingsCte = `
    WITH review_ratings AS (
      SELECT
        e.id,
        e.list_id,
        e.item_id,
        e.paciente_id AS event_paciente_id,
        e.payload,
        e.occurred_at,
        i.paciente_id AS item_paciente_id,
        i.name AS item_name,
        i.phone AS item_phone,
        i.email AS item_email,
        i.conversation_id AS conversation_id,
        i.sent_at AS sent_at,
        COALESCE(i.clinica_id, l.clinica_id) AS clinic_id,
        cl.nombre_clinica AS clinic_name,
        p.nombre AS paciente_nombre,
        p.apellidos AS paciente_apellidos,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(
            CASE WHEN COALESCE(e.paciente_id, i.paciente_id) IS NOT NULL THEN CONCAT('p:', COALESCE(e.paciente_id, i.paciente_id)) END,
            CASE WHEN NULLIF(TRIM(i.phone), '') IS NOT NULL THEN CONCAT('ph:', TRIM(REPLACE(REPLACE(REPLACE(REPLACE(i.phone, '+', ''), ' ', ''), '-', ''), '.', ''))) END,
            CASE WHEN NULLIF(TRIM(i.email), '') IS NOT NULL THEN CONCAT('em:', LOWER(TRIM(i.email))) END,
            CASE WHEN NULLIF(TRIM(i.name), '') IS NOT NULL THEN CONCAT('nm:', LOWER(TRIM(i.name))) END,
            CONCAT('event:', e.id)
          )
          ORDER BY e.occurred_at DESC, e.id DESC
        ) AS contact_rank
      FROM MarketingPatientContactEvents e
      INNER JOIN MarketingPatientLists l ON l.id = e.list_id
      INNER JOIN MarketingPatientListItems i ON i.id = e.item_id
      LEFT JOIN Pacientes p ON p.id_paciente = COALESCE(e.paciente_id, i.paciente_id)
      LEFT JOIN Clinicas cl ON cl.id_clinica = COALESCE(i.clinica_id, l.clinica_id)
      WHERE l.objective_id = :objectiveId
        AND COALESCE(i.clinica_id, l.clinica_id) IN (:clinicIds)
        AND (
          JSON_UNQUOTE(JSON_EXTRACT(l.criteria, '$.review_request')) IN ('true', '1')
          OR JSON_UNQUOTE(JSON_EXTRACT(l.criteria, '$.template_usage')) = 'solicitud_resena'
        )
        AND (
          i.sent_at IS NOT NULL
          OR i.dispatch_status IN ('queued','sending','sent','delivered','read','replied')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM MarketingPatientContactEvents te
          WHERE te.list_id = i.list_id
            AND te.item_id = i.id
            AND te.event_type IN ('mass_campaign_test_sent', 'mass_campaign_test_failed')
        )
        AND e.event_type IN ('review_rating_received', 'review_request_rating')
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.rating')) AS UNSIGNED) BETWEEN 1 AND 5
    )
  `;

  const [ratingsRow] = await db.sequelize.query(
    `
    ${reviewRatingsCte}
    SELECT
      SUM(CASE WHEN CAST(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.rating')) AS UNSIGNED) BETWEEN 1 AND 4 THEN 1 ELSE 0 END) AS ratings_1_to_4,
      SUM(CASE WHEN CAST(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.rating')) AS UNSIGNED) = 5 THEN 1 ELSE 0 END) AS ratings_5
    FROM review_ratings
    WHERE contact_rank = 1
    `,
    { replacements: { clinicIds, objectiveId: OBJECTIVE_ID }, type: QueryTypes.SELECT }
  );

  const [googleReviewsMatchedRow] = await db.sequelize.query(
    `
    SELECT COUNT(DISTINCT r.id) AS total
    FROM BusinessProfileReviews r
    INNER JOIN MarketingPatientContactEvents e ON e.id = r.matched_contact_event_id
    INNER JOIN MarketingPatientLists l ON l.id = e.list_id
    INNER JOIN MarketingPatientListItems i ON i.id = e.item_id
    WHERE r.clinica_id IN (:clinicIds)
      AND l.objective_id = :objectiveId
      AND (
        JSON_UNQUOTE(JSON_EXTRACT(l.criteria, '$.review_request')) IN ('true', '1')
        OR JSON_UNQUOTE(JSON_EXTRACT(l.criteria, '$.template_usage')) = 'solicitud_resena'
      )
      AND e.event_type = 'google_review_matched'
      AND NOT EXISTS (
        SELECT 1
        FROM MarketingPatientContactEvents te
        WHERE te.list_id = i.list_id
          AND te.item_id = i.id
          AND te.event_type IN ('mass_campaign_test_sent', 'mass_campaign_test_failed')
      )
    `,
    { replacements: { clinicIds, objectiveId: OBJECTIVE_ID }, type: QueryTypes.SELECT }
  );

  const [googleReviewsAttributedRow] = await db.sequelize.query(
    `
    SELECT COUNT(DISTINCT r.id) AS total
    FROM BusinessProfileReviews r
    WHERE r.clinica_id IN (:clinicIds)
      AND CAST(r.star_rating AS UNSIGNED) BETWEEN 1 AND 5
      AND EXISTS (
        SELECT 1
        FROM MarketingPatientContactEvents e
        INNER JOIN MarketingPatientLists l ON l.id = e.list_id
        INNER JOIN MarketingPatientListItems i ON i.id = e.item_id
        WHERE COALESCE(i.clinica_id, l.clinica_id) = r.clinica_id
          AND l.objective_id = :objectiveId
          AND (
            JSON_UNQUOTE(JSON_EXTRACT(l.criteria, '$.review_request')) IN ('true', '1')
            OR JSON_UNQUOTE(JSON_EXTRACT(l.criteria, '$.template_usage')) = 'solicitud_resena'
          )
          AND e.event_type = 'review_rating_followup_sent'
          AND JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.kind')) = 'review_google_link_followup'
          AND e.occurred_at <= COALESCE(r.create_time, r.update_time, r.created_at)
          AND e.occurred_at >= DATE_SUB(COALESCE(r.create_time, r.update_time, r.created_at), INTERVAL 72 HOUR)
          AND NOT EXISTS (
            SELECT 1
            FROM MarketingPatientContactEvents te
            WHERE te.list_id = e.list_id
              AND te.item_id = e.item_id
              AND te.event_type IN ('mass_campaign_test_sent', 'mass_campaign_test_failed')
          )
      )
    `,
    { replacements: { clinicIds, objectiveId: OBJECTIVE_ID }, type: QueryTypes.SELECT }
  );

  const recentPrivateRatings = await db.sequelize.query(
    `
    ${reviewRatingsCte}
    SELECT
      COALESCE(rr.item_name, CONCAT_WS(' ', rr.paciente_nombre, rr.paciente_apellidos), 'Paciente') AS patient_name,
      COALESCE(rr.event_paciente_id, rr.item_paciente_id) AS patient_id,
      rr.conversation_id AS conversation_id,
      rr.clinic_id AS clinic_id,
      rr.clinic_name AS clinic_name,
      CAST(JSON_UNQUOTE(JSON_EXTRACT(rr.payload, '$.rating')) AS UNSIGNED) AS rating,
      (
        SELECT JSON_UNQUOTE(JSON_EXTRACT(f.payload, '$.content'))
        FROM MarketingPatientContactEvents f
        WHERE f.list_id = rr.list_id
          AND f.item_id = rr.item_id
          AND f.event_type = 'review_private_feedback_received'
          AND JSON_UNQUOTE(JSON_EXTRACT(f.payload, '$.content')) IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM MarketingPatientContactEvents re
            WHERE re.list_id = f.list_id
              AND re.item_id = f.item_id
              AND re.event_type IN ('review_rating_received', 'review_request_rating')
              AND JSON_UNQUOTE(JSON_EXTRACT(re.payload, '$.inbound_message_id')) = JSON_UNQUOTE(JSON_EXTRACT(f.payload, '$.inbound_message_id'))
          )
        ORDER BY f.occurred_at DESC
        LIMIT 1
      ) AS reason,
      (
        SELECT r.comment
        FROM MarketingPatientContactEvents gm
        INNER JOIN BusinessProfileReviews r ON r.matched_contact_event_id = gm.id
        WHERE gm.list_id = rr.list_id
          AND gm.item_id = rr.item_id
          AND gm.event_type = 'google_review_matched'
        ORDER BY r.create_time DESC
        LIMIT 1
      ) AS google_review_comment,
      (
        SELECT r.reviewer_name
        FROM MarketingPatientContactEvents gm
        INNER JOIN BusinessProfileReviews r ON r.matched_contact_event_id = gm.id
        WHERE gm.list_id = rr.list_id
          AND gm.item_id = rr.item_id
          AND gm.event_type = 'google_review_matched'
        ORDER BY r.create_time DESC
        LIMIT 1
      ) AS google_reviewer_name,
      EXISTS (
        SELECT 1
        FROM MarketingPatientContactEvents gm
        WHERE gm.list_id = rr.list_id
          AND gm.item_id = rr.item_id
          AND gm.event_type = 'google_review_matched'
      ) AS google_review_matched,
      rr.occurred_at
    FROM review_ratings rr
    WHERE rr.contact_rank = 1
    ORDER BY rr.occurred_at DESC
    LIMIT 50
    `,
    { replacements: { clinicIds, objectiveId: OBJECTIVE_ID }, type: QueryTypes.SELECT }
  );

  const reviewResponseHeatmapRows = await db.sequelize.query(
    `
    ${reviewRatingsCte}
    SELECT
      CASE
        WHEN MONTH(COALESCE(sent_at, occurred_at)) IN (12, 1, 2) THEN 'winter'
        WHEN MONTH(COALESCE(sent_at, occurred_at)) IN (6, 7, 8) THEN 'summer'
        ELSE 'other'
      END AS season,
      WEEKDAY(occurred_at) AS weekday,
      HOUR(occurred_at) AS hour,
      COUNT(*) AS total
    FROM review_ratings
    WHERE contact_rank = 1
    GROUP BY season, WEEKDAY(occurred_at), HOUR(occurred_at)
    ORDER BY season, weekday, hour
    `,
    { replacements: { clinicIds, objectiveId: OBJECTIVE_ID }, type: QueryTypes.SELECT }
  );

  const [googleRatingRow] = await db.sequelize.query(
    `
    SELECT
      COUNT(*) AS total_reviews,
      SUM(CAST(star_rating AS UNSIGNED)) AS rating_sum,
      AVG(CAST(star_rating AS UNSIGNED)) AS average_rating,
      SUM(CASE WHEN CAST(star_rating AS UNSIGNED) = 5 THEN 1 ELSE 0 END) AS five_star_reviews
    FROM BusinessProfileReviews
    WHERE clinica_id IN (:clinicIds)
      AND CAST(star_rating AS UNSIGNED) BETWEEN 1 AND 5
    `,
    { replacements: { clinicIds }, type: QueryTypes.SELECT }
  );

  const [automationTemplate, lastRequestTemplate, approvedReviewTemplate, approvedReminderTemplate, approvedPhotoReviewTemplate, googleReviewUrlAvailable, clinicStatuses] = await Promise.all([
    getReviewAutomationTemplate(scope, { includeInactive: true }),
    getLastReviewRequestTemplateForScope(effectiveScope),
    findApprovedReviewWhatsappTemplate(effectiveScope),
    findApprovedReviewReminderWhatsappTemplate(effectiveScope),
    findApprovedReviewWhatsappTemplate(effectiveScope, null, { preferPhoto: true }),
    hasGoogleReviewUrlForScope(effectiveScope),
    scope?.scope === 'group' ? buildReviewClinicStatuses(scope, options) : Promise.resolve([]),
  ]);
  const groupReadyClinics = clinicStatuses.filter((clinic) => clinic.ready);
  const whatsappAvailable = scope?.scope === 'group'
    ? groupReadyClinics.length > 0
    : await hasWhatsappConfigForScope(effectiveScope);
  const manuallyFilteredCandidates = candidates.filter((item) => !String(item.status || '').startsWith('excluded'));
  const summaryCandidates = scope?.scope === 'group'
    ? applyReviewClinicReadinessExclusions(manuallyFilteredCandidates, clinicStatuses).filter((item) => !String(item.status || '').startsWith('excluded'))
    : manuallyFilteredCandidates;
  const groupApprovedTemplate = groupReadyClinics.find((clinic) => clinic.approved_template_id)
    || clinicStatuses.find((clinic) => clinic.approved_template_id)
    || null;
  const effectiveApprovedTemplateId = approvedReviewTemplate?.id || groupApprovedTemplate?.approved_template_id || null;
  const groupApprovedReminderTemplate = groupReadyClinics.find((clinic) => clinic.approved_reminder_template_id)
    || clinicStatuses.find((clinic) => clinic.approved_reminder_template_id)
    || null;
  const effectiveApprovedReminderTemplateId = approvedReminderTemplate?.id || groupApprovedReminderTemplate?.approved_reminder_template_id || null;
  const groupApprovedPhotoTemplate = groupReadyClinics.find((clinic) => clinic.approved_photo_template_id)
    || clinicStatuses.find((clinic) => clinic.approved_photo_template_id)
    || null;
  const approvedPhotoTemplateHasImage = !!approvedPhotoReviewTemplate && templateHasImageHeader(approvedPhotoReviewTemplate);
  const effectiveApprovedPhotoTemplateId = approvedPhotoTemplateHasImage
    ? (approvedPhotoReviewTemplate?.id || null)
    : (groupApprovedPhotoTemplate?.approved_photo_template_id || null);
  const groupAutomationTemplates = clinicStatuses
    .filter((clinic) => clinic.clinic_automation_enabled && clinic.clinic_automation_template)
    .map((clinic) => clinic.clinic_automation_template);
  const effectiveAutomationTemplate = scope?.scope === 'group'
    ? (groupAutomationTemplates[0] || null)
    : serializeReviewAutomationTemplate(automationTemplate);
  const automationEnabled = scope?.scope === 'group'
    ? groupReadyClinics.length > 0 && groupReadyClinics.every((clinic) => clinic.clinic_automation_enabled === true)
    : automationTemplate?.is_active === true;
  const googleRatingSummary = buildGoogleRatingSummary(googleRatingRow || {});

  return {
    success: true,
    summary: {
      possible_patients: summaryCandidates.length,
      candidates_preview: summaryCandidates.slice(0, previewLimit).map(serializeItem),
      candidates_preview_total: summaryCandidates.length,
      candidates_preview_limit: previewLimit,
      treatment_options: treatmentOptions,
      requests_sent: Number(sentRow?.total || 0),
      ratings_1_to_4: Number(ratingsRow?.ratings_1_to_4 || 0),
      ratings_5: Number(ratingsRow?.ratings_5 || 0),
      google_reviews_matched: Number(googleReviewsMatchedRow?.total || 0),
      google_reviews_attributed: Number(googleReviewsAttributedRow?.total || 0),
      low_rating_reasons: (recentPrivateRatings || [])
        .map((row) => ({
          patient_name: normalizeText(row.patient_name) || 'Paciente',
          patient_id: Number(row.patient_id || 0) || null,
          conversation_id: Number(row.conversation_id || 0) || null,
          clinic_id: Number(row.clinic_id || 0) || null,
          clinic_name: normalizeText(row.clinic_name) || null,
          rating: Number(row.rating || 0) || null,
          reason: buildReviewRatingSummaryText(row).slice(0, 700),
          google_review_comment: normalizeText(row.google_review_comment || '') || null,
          google_reviewer_name: normalizeText(row.google_reviewer_name || '') || null,
          google_review_matched: row.google_review_matched === true || row.google_review_matched === 1,
          occurred_at: row.occurred_at || null,
        }))
        .filter((row) => row.rating),
      review_response_heatmaps: buildReviewResponseHeatmaps(reviewResponseHeatmapRows || []),
      google_rating_summary: googleRatingSummary,
      automation_enabled: automationEnabled,
      automation_template: effectiveAutomationTemplate,
      last_request_template: lastRequestTemplate,
      approved_template_available: !!effectiveApprovedTemplateId && !!effectiveApprovedReminderTemplateId,
      approved_template_id: effectiveApprovedTemplateId,
      approved_reminder_template_available: !!effectiveApprovedReminderTemplateId,
      approved_reminder_template_id: effectiveApprovedReminderTemplateId,
      approved_photo_template_available: !!effectiveApprovedPhotoTemplateId,
      approved_photo_template_id: effectiveApprovedPhotoTemplateId,
      google_review_url_available: googleReviewUrlAvailable,
      whatsapp_available: whatsappAvailable,
      clinic_statuses: clinicStatuses,
      group_total_clinics: clinicStatuses.length || null,
      group_ready_clinics: groupReadyClinics.length,
      group_blocked_clinics: clinicStatuses.length ? clinicStatuses.length - groupReadyClinics.length : null,
    },
  };
}

function buildReviewAutomationTemplateIdentity(scope) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (clinicIds.length === 1) {
    return {
      template_key: `review_request_after_completed__clinic_${clinicIds[0]}`,
      public_id: `flw_review_req_clinic_${clinicIds[0]}`,
      clinic_id: clinicIds[0],
      group_id: null,
    };
  }
  const err = new Error('Activa la automatización de reseñas para una clínica o un grupo concreto.');
  err.status = 400;
  throw err;
}

async function buildReviewAutomationDisplayName(scope) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (clinicIds.length === 1) {
    const clinic = await Clinica.findByPk(clinicIds[0], {
      attributes: ['id_clinica', 'nombre_clinica'],
      raw: true,
    });
    const clinicName = normalizeText(clinic?.nombre_clinica || '');
    return `Reseñas automáticas · Clínica: ${clinicName || `Clínica ${clinicIds[0]}`}`;
  }
  return 'Reseñas automáticas · Clínica';
}

function buildClinicReviewScopeFromGroup(scope, clinicId) {
  return {
    ...scope,
    scope: 'clinic',
    clinicIds: [clinicId],
    groupId: null,
    isAll: false,
    isValid: true,
  };
}

function buildReviewAutomationNodes({
  reviewSource,
  reviewThreshold,
  whatsappTemplateId = null,
  reviewGiftEnabled = false,
  reviewGiftDescription = '',
  reviewDisplayClinicName = '',
  reviewSenderName = '',
  reviewTeamPhotoUrl = '',
  reviewTeamPhotoOverlayColor = publicMediaPersonalizationService.DEFAULT_OVERLAY_COLOR,
  reviewTeamMembersText = '',
}) {
  const threshold = normalizeReviewThreshold(reviewThreshold);
  const giftEnabled = reviewGiftEnabled === true || String(reviewGiftEnabled || '').toLowerCase() === 'true';
  return [
    {
      id: 'N1',
      type: 'trigger/appointment_completed',
      config: {
        event_name: REVIEW_AUTOMATION_TRIGGER,
      },
      outputs: { on_success: 'N2' },
      position: { x: 120, y: 120 },
    },
    {
      id: 'N2',
      type: 'delay/fixed',
      config: {
        duration: 24,
        unit: 'hours',
      },
      outputs: { on_complete: 'N3' },
      position: { x: 120, y: 280 },
    },
    {
      id: 'N3',
      type: REVIEW_AUTOMATION_ACTION,
      config: {
        review_source: normalizeReviewRequestSource(reviewSource),
        review_threshold: threshold,
        whatsapp_template_id: Number(whatsappTemplateId || 0) || null,
        template_name: REVIEW_TEMPLATE_NAME,
        review_gift_enabled: giftEnabled,
        review_gift_description: giftEnabled ? normalizeText(reviewGiftDescription || '') : null,
        review_display_clinic_name: normalizeText(reviewDisplayClinicName || '') || null,
        review_sender_name: normalizeText(reviewSenderName || '') || null,
        review_team_photo_url: normalizeText(reviewTeamPhotoUrl || '') || null,
        review_team_photo_overlay_color: publicMediaPersonalizationService.normalizeHexColor(reviewTeamPhotoOverlayColor),
        review_team_members_text: normalizeText(reviewTeamMembersText || '') || null,
        require_message_anchor_for_wait: true,
        wait_for_message_ms: 6000,
      },
      outputs: { on_success: 'N4', on_fail: null },
      position: { x: 120, y: 440 },
    },
    {
      id: 'N4',
      type: 'delay/wait_response',
      config: {
        timeout_duration: 24,
        timeout_unit: 'hours',
        listens_to_node_id: 'N3',
        response_buffer_enabled: true,
      },
      outputs: { on_response: 'N5', on_timeout: 'N9' },
      position: { x: 120, y: 600 },
    },
    {
      id: 'N5',
      type: 'condition/field_check',
      config: {
        mode: 'simple',
        left_ref: {
          source: 'context',
          path: 'last_response_context.response_rating',
          value_type: 'number',
          label: 'Valoración del paciente',
        },
        operator: 'greater_than_or_equals',
        right_value: threshold,
      },
      outputs: { on_true: 'N6', on_false: 'N7' },
      position: { x: 430, y: 600 },
    },
    {
      id: 'N6',
      type: REVIEW_FOLLOWUP_AUTOMATION_ACTION,
      config: {
        followup_kind: 'google_review',
        review_threshold: threshold,
      },
      outputs: { on_success: null },
      position: { x: 720, y: 500 },
    },
    {
      id: 'N7',
      type: REVIEW_FOLLOWUP_AUTOMATION_ACTION,
      config: {
        followup_kind: 'private_feedback',
        review_threshold: threshold,
      },
      outputs: { on_success: null },
      position: { x: 720, y: 700 },
    },
    {
      id: 'N9',
      type: 'action/request_review_reminder',
      config: {
        list_id: '{{outputs.N3.list_id}}',
        item_id: '{{outputs.N3.item_id}}',
        previous_message_id: '{{outputs.N3.message_id}}',
        template_name: REVIEW_REMINDER_TEMPLATE_NAME,
        reminder_policy: 'after_24h',
      },
      outputs: { on_success: 'N10', on_fail: 'N12' },
      position: { x: 120, y: 760 },
    },
    {
      id: 'N10',
      type: 'delay/wait_response',
      config: {
        timeout_duration: 24,
        timeout_unit: 'hours',
        listens_to_node_id: 'N9',
        response_buffer_enabled: true,
      },
      outputs: { on_response: 'N5', on_timeout: 'N12' },
      position: { x: 120, y: 920 },
    },
    {
      id: 'N12',
      type: REVIEW_NO_RESPONSE_AUTOMATION_ACTION,
      config: {
        list_id: '{{outputs.N3.list_id}}',
        item_id: '{{outputs.N3.item_id}}',
        reason: 'sin_respuesta_tras_recordatorio',
      },
      outputs: { on_success: null },
      position: { x: 120, y: 1080 },
    },
  ];
}

async function upsertReviewRequestAutomationForClinic(scope, body = {}, userId = null) {
  if (!AutomationFlowTemplateV2) {
    const err = new Error('El motor de automatizaciones V2 no está disponible.');
    err.status = 503;
    throw err;
  }

  const enabled = body.enabled === true || body.active === true || body.is_active === true;
  const identity = buildReviewAutomationTemplateIdentity(scope);
  const reviewSource = normalizeReviewRequestSource(body.review_source || body.reviewSource || 'completed_treatment');
  const reviewThreshold = 5;
  const whatsappTemplateId = Number(body.whatsapp_template_id || body.template_id || 0) || null;
  const reviewGiftEnabled = body.review_gift_enabled === true
    || body.reviewGiftEnabled === true
    || String(body.review_gift_enabled ?? body.reviewGiftEnabled ?? '').toLowerCase() === 'true';
  const reviewGiftDescription = normalizeText(body.review_gift_description || body.reviewGiftDescription || '');
  const reviewDisplayClinicName = normalizeText(body.review_display_clinic_name || body.reviewDisplayClinicName || '');
  const reviewSenderName = normalizeText(body.review_sender_name || body.reviewSenderName || '');
  const reviewTeamPhotoUrl = normalizeText(body.review_team_photo_url || body.reviewTeamPhotoUrl || '');
  const reviewTeamPhotoOverlayColor = publicMediaPersonalizationService.normalizeHexColor(
    body.review_team_photo_overlay_color || body.reviewTeamPhotoOverlayColor
  );
  const reviewTeamMembersText = normalizeText(body.review_team_members_text || body.reviewTeamMembersText || '');

  let approvedTemplate = null;
  if (whatsappTemplateId) {
    approvedTemplate = await findApprovedReviewWhatsappTemplate(scope, whatsappTemplateId);
    if (!approvedTemplate) {
      const err = new Error('Selecciona una plantilla de reseñas aprobada por Meta.');
      err.status = 409;
      err.details = { reason: 'review_template_not_approved' };
      throw err;
    }
  }

  const existing = await AutomationFlowTemplateV2.findOne({
    where: { template_key: identity.template_key },
    order: [['version', 'DESC'], ['id', 'DESC']],
  });
  if (!enabled && !existing) {
    const [approvedReviewTemplate, approvedReminderTemplate, googleReviewUrlAvailable, whatsappAvailable] = await Promise.all([
      findApprovedReviewWhatsappTemplate(scope, whatsappTemplateId || null),
      findApprovedReviewReminderWhatsappTemplate(scope),
      hasGoogleReviewUrlForScope(scope),
      hasWhatsappConfigForScope(scope),
    ]);
    const templatesReady = !!approvedReviewTemplate && !!approvedReminderTemplate;
    return {
      success: true,
      automation_enabled: false,
      automation_template: null,
      approved_template_available: templatesReady,
      approved_template_id: approvedReviewTemplate?.id || null,
      approved_reminder_template_available: !!approvedReminderTemplate,
      approved_reminder_template_id: approvedReminderTemplate?.id || null,
      google_review_url_available: googleReviewUrlAvailable,
      whatsapp_available: whatsappAvailable,
      warnings: [
        !approvedReviewTemplate ? 'template_not_approved' : null,
        approvedReviewTemplate && !approvedReminderTemplate ? 'reminder_template_not_approved' : null,
        !googleReviewUrlAvailable ? 'google_review_url_missing' : null,
        !whatsappAvailable ? 'whatsapp_missing' : null,
      ].filter(Boolean),
    };
  }

  const [readyApprovedTemplate, readyApprovedReminderTemplate, readyGoogleReviewUrlAvailable, readyWhatsappAvailable] = await Promise.all([
    findApprovedReviewWhatsappTemplate(scope, whatsappTemplateId || null),
    findApprovedReviewReminderWhatsappTemplate(scope),
    hasGoogleReviewUrlForScope(scope),
    hasWhatsappConfigForScope(scope),
  ]);
  if (enabled && !reviewSenderName) {
    const err = new Error('Indica el remitente que firma la solicitud de reseña antes de activar la automatización.');
    err.status = 409;
    err.details = { reason: 'review_automation_requirements_missing', warnings: ['sender_name_missing'] };
    throw err;
  }
  if (enabled && (!readyApprovedTemplate || !readyApprovedReminderTemplate || !readyGoogleReviewUrlAvailable || !readyWhatsappAvailable)) {
    const warnings = [
      !readyApprovedTemplate ? 'template_not_approved' : null,
      readyApprovedTemplate && !readyApprovedReminderTemplate ? 'reminder_template_not_approved' : null,
      !readyGoogleReviewUrlAvailable ? 'google_review_url_missing' : null,
      !readyWhatsappAvailable ? 'whatsapp_missing' : null,
    ].filter(Boolean);
    const err = new Error('No se puede activar la automatización hasta conectar Perfil Google, WhatsApp y tener aprobadas las plantillas de reseñas y recordatorio.');
    err.status = 409;
    err.details = { reason: 'review_automation_requirements_missing', warnings };
    throw err;
  }
  const now = new Date();
  const nodes = buildReviewAutomationNodes({
    reviewSource,
    reviewThreshold,
    whatsappTemplateId: whatsappTemplateId || approvedTemplate?.id || readyApprovedTemplate?.id || null,
    reviewGiftEnabled,
    reviewGiftDescription,
    reviewDisplayClinicName,
    reviewSenderName,
    reviewTeamPhotoUrl,
    reviewTeamPhotoOverlayColor,
    reviewTeamMembersText,
  });
  const displayName = await buildReviewAutomationDisplayName(scope);
  const payload = {
    ...identity,
    version: Math.max(Number(existing?.version || 0), 2),
    engine_version: 'v2',
    name: displayName,
    description: 'Espera 24h tras finalizar un tratamiento, pide al paciente una valoración con escala 5 a 1 y deriva a Google solo si responde 5/5. Si no responde, manda un recordatorio 24h después y cierra si sigue sin respuesta otras 24h.',
    trigger_type: REVIEW_AUTOMATION_TRIGGER,
    trigger_config: { event_name: REVIEW_AUTOMATION_TRIGGER },
    is_active: enabled,
    is_system: false,
    entry_node_id: 'N1',
    nodes,
    published_at: now,
    published_by: userId || 1,
    created_by: existing?.created_by || userId || 1,
  };

  const row = existing
    ? await existing.update(payload)
    : await AutomationFlowTemplateV2.create(payload);
  const [approvedReviewTemplate, approvedReminderTemplate, googleReviewUrlAvailable, whatsappAvailable] = await Promise.all([
    findApprovedReviewWhatsappTemplate(scope, whatsappTemplateId || null),
    findApprovedReviewReminderWhatsappTemplate(scope),
    hasGoogleReviewUrlForScope(scope),
    hasWhatsappConfigForScope(scope),
  ]);
  const templatesReady = !!approvedReviewTemplate && !!approvedReminderTemplate;
  return {
    success: true,
    automation_enabled: row.is_active === true,
    automation_template: serializeReviewAutomationTemplate(row),
    approved_template_available: templatesReady,
    approved_template_id: approvedReviewTemplate?.id || null,
    approved_reminder_template_available: !!approvedReminderTemplate,
    approved_reminder_template_id: approvedReminderTemplate?.id || null,
    google_review_url_available: googleReviewUrlAvailable,
    whatsapp_available: whatsappAvailable,
    warnings: [
      !approvedReviewTemplate ? 'template_not_approved' : null,
      approvedReviewTemplate && !approvedReminderTemplate ? 'reminder_template_not_approved' : null,
      !googleReviewUrlAvailable ? 'google_review_url_missing' : null,
      !whatsappAvailable ? 'whatsapp_missing' : null,
    ].filter(Boolean),
  };
}

async function setReviewRequestAutomation(scope, body = {}, userId = null) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (scope?.scope !== 'group' || clinicIds.length <= 1) {
    return upsertReviewRequestAutomationForClinic(scope, body, userId);
  }

  const results = [];
  for (const clinicId of clinicIds) {
    const clinicScope = buildClinicReviewScopeFromGroup(scope, clinicId);
    try {
      const result = await upsertReviewRequestAutomationForClinic(clinicScope, body, userId);
      results.push({ clinic_id: clinicId, ...result });
    } catch (error) {
      results.push({
        clinic_id: clinicId,
        success: false,
        automation_enabled: false,
        error: error?.message || 'No se pudo actualizar la automatización de esta clínica.',
        reason: error?.details?.reason || null,
      });
    }
  }

  const successful = results.filter((result) => result.success !== false);
  const active = successful.filter((result) => result.automation_enabled === true);
  const firstTemplate = active.find((result) => result.automation_template)?.automation_template
    || successful.find((result) => result.automation_template)?.automation_template
    || null;
  const approvedTemplateAvailable = successful.some((result) => result.approved_template_available === true);
  const approvedReminderTemplateAvailable = successful.some((result) => result.approved_reminder_template_available === true);
  const googleReviewUrlAvailable = successful.some((result) => result.google_review_url_available === true);
  const whatsappAvailable = successful.some((result) => result.whatsapp_available === true);
  return {
    success: true,
    automation_enabled: active.length > 0 && active.length === successful.length && successful.length > 0,
    automation_template: firstTemplate,
    approved_template_available: approvedTemplateAvailable,
    approved_template_id: successful.find((result) => result.approved_template_id)?.approved_template_id || null,
    approved_reminder_template_available: approvedReminderTemplateAvailable,
    approved_reminder_template_id: successful.find((result) => result.approved_reminder_template_id)?.approved_reminder_template_id || null,
    google_review_url_available: googleReviewUrlAvailable,
    whatsapp_available: whatsappAvailable,
    group_result: {
      requested_clinics: clinicIds.length,
      updated_clinics: successful.length,
      active_clinics: active.length,
      failed_clinics: results.filter((result) => result.success === false).length,
      results,
    },
    warnings: [
      !approvedTemplateAvailable ? 'template_not_approved' : null,
      !approvedReminderTemplateAvailable ? 'reminder_template_not_approved' : null,
      !googleReviewUrlAvailable ? 'google_review_url_missing' : null,
      !whatsappAvailable ? 'whatsapp_missing' : null,
      results.some((result) => result.success === false) ? 'some_clinics_failed' : null,
    ].filter(Boolean),
  };
}

async function createAndStartReviewRequestForAppointment(options = {}) {
  const appointmentId = Number(options.appointmentId || options.appointment_id || options.cita_id || 0);
  const clinicId = Number(options.clinicId || options.clinic_id || 0);
  if (!appointmentId || !clinicId) {
    return { success: true, sent: false, skipped: true, reason: 'appointment_or_clinic_missing' };
  }

  const scope = {
    scope: 'clinic',
    clinicIds: [clinicId],
    groupId: null,
    isAll: false,
    isValid: true,
  };
  const reviewSource = normalizeReviewRequestSource(options.reviewSource || options.review_source || 'completed_treatment');
  const reviewThreshold = 5;
  const reviewGiftEnabled = options.reviewGiftEnabled === true
    || options.review_gift_enabled === true
    || String(options.reviewGiftEnabled ?? options.review_gift_enabled ?? '').toLowerCase() === 'true';
  const reviewGiftDescription = normalizeText(options.reviewGiftDescription || options.review_gift_description || '');
  const reviewDisplayClinicName = normalizeText(options.reviewDisplayClinicName || options.review_display_clinic_name || '');
  const reviewSenderName = normalizeText(options.reviewSenderName || options.review_sender_name || '');
  const reviewTeamPhotoUrl = normalizeText(options.reviewTeamPhotoUrl || options.review_team_photo_url || '');
  const reviewTeamPhotoOverlayColor = publicMediaPersonalizationService.normalizeHexColor(
    options.reviewTeamPhotoOverlayColor || options.review_team_photo_overlay_color
  );
  const reviewTeamMembersText = normalizeText(options.reviewTeamMembersText || options.review_team_members_text || '');
  const candidate = await buildReviewRequestCandidateForAppointment(scope, {
    review_appointment_id: appointmentId,
    review_source: reviewSource,
  });
  if (!candidate.item) {
    return { success: true, sent: false, skipped: true, reason: candidate.reason || 'no_review_candidate' };
  }

  const clinic = await loadClinicForTemplateVariables(clinicId);
  const googleReviewUrl = normalizeText(clinic?.url_dejar_resena);
  if (!googleReviewUrl) {
    return { success: true, sent: false, skipped: true, reason: 'google_review_url_missing' };
  }

  const whatsappAvailable = await hasWhatsappConfigForScope(scope);
  if (!whatsappAvailable) {
    return { success: true, sent: false, skipped: true, reason: 'whatsapp_connection_missing' };
  }

  const template = await findApprovedReviewWhatsappTemplate(
    scope,
    options.whatsappTemplateId || options.whatsapp_template_id || null,
    { preferPhoto: isHttpsUrl(reviewTeamPhotoUrl) }
  );
  if (!template) {
    return { success: true, sent: false, skipped: true, reason: 'approved_review_template_missing' };
  }

  const reminderTemplate = await findApprovedReviewReminderWhatsappTemplate(scope);
  if (!reminderTemplate) {
    return { success: true, sent: false, skipped: true, reason: 'approved_review_reminder_template_missing' };
  }

  try {
    const body = {
      name: `Solicitud de reseña · cita #${appointmentId}`,
      campaign_name: `Solicitud de reseña · cita #${appointmentId}`,
      list_source: 'current_patients',
      channels: ['whatsapp'],
      template_usage: 'solicitud_resena',
      template_commercial: false,
      consent_acknowledged: true,
      review_request: true,
      review_source: reviewSource,
      review_threshold: reviewThreshold,
      review_appointment_id: appointmentId,
      review_gift_enabled: reviewGiftEnabled,
      review_gift_description: reviewGiftEnabled ? reviewGiftDescription : null,
      review_display_clinic_name: reviewDisplayClinicName || resolveReviewDisplayClinicName({ criteria: {} }, clinic),
      review_sender_name: reviewSenderName || resolveReviewSenderName({ criteria: {} }),
      review_team_photo_url: reviewTeamPhotoUrl || null,
      review_team_photo_overlay_color: reviewTeamPhotoOverlayColor,
      review_team_members_text: reviewTeamMembersText || null,
      whatsapp_template_id: template.id,
      link_tracking: {
        enabled: true,
        google_review_url: googleReviewUrl,
      },
    };
    const created = await createCampaign(scope, body, options.userId || null);
    const campaignId = created?.campaign?.id || created?.list?.id;
    if (!campaignId) {
      return { success: true, sent: false, skipped: true, reason: 'campaign_not_created' };
    }
    await prepareCampaign(scope, campaignId, body, options.userId || null);
    const dispatched = await startCampaignDispatch(scope, campaignId, body, options.userId || null);
    const anchor = await waitForReviewRequestDispatchAnchor(
      campaignId,
      options.waitForMessageMs ?? options.wait_for_message_ms ?? 6000
    );
    return {
      success: true,
      sent: true,
      skipped: false,
      campaign_id: campaignId,
      list_id: campaignId,
      item_id: anchor?.item_id || null,
      patient_id: anchor?.patient_id || null,
      message_id: anchor?.message_id || null,
      app_message_id: anchor?.app_message_id || null,
      conversation_id: anchor?.conversation_id || null,
      provider_message_id: anchor?.provider_message_id || null,
      dispatch_status: anchor?.dispatch_status || null,
      sent_at: anchor?.sent_at || null,
      template_id: template.id,
      dispatch: dispatched?.dispatch || null,
    };
  } catch (error) {
    console.warn('[marketing-bulk-sends] No se pudo lanzar solicitud automática de reseña', {
      appointmentId,
      clinicId,
      error: error?.message || error,
    });
    return {
      success: true,
      sent: false,
      skipped: true,
      reason: 'dispatch_failed',
      error: error?.message || String(error),
    };
  }
}

async function sendReviewRequestReminder(options = {}) {
  const listId = Number(options.listId || options.list_id || 0);
  const itemId = Number(options.itemId || options.item_id || 0);
  if (!listId || !itemId) {
    return { success: true, sent: false, skipped: true, reason: 'list_or_item_missing' };
  }

  const [list, item] = await Promise.all([
    MarketingPatientList.findByPk(listId),
    MarketingPatientListItem.findOne({ where: { id: itemId, list_id: listId } }),
  ]);
  if (!list || !item) {
    return { success: true, sent: false, skipped: true, reason: 'review_request_not_found' };
  }
  if (item.replied_at || String(item.dispatch_status || '').toLowerCase() === 'replied') {
    return { success: true, sent: false, skipped: true, reason: 'already_replied', list_id: listId, item_id: itemId };
  }
  if (!item.phone) {
    return { success: true, sent: false, skipped: true, reason: 'phone_missing', list_id: listId, item_id: itemId };
  }

  const clinicId = Number(item.clinica_id || getClinicIdForList(list) || 0);
  if (!clinicId) {
    return { success: true, sent: false, skipped: true, reason: 'clinic_missing', list_id: listId, item_id: itemId };
  }
  const scope = {
    scope: 'clinic',
    clinicIds: [clinicId],
    groupId: null,
    isAll: false,
    isValid: true,
  };
  const [clinic, clinicConfig, template] = await Promise.all([
    loadClinicForTemplateVariables(clinicId),
    whatsappService.getClinicConfig(clinicId).catch(() => null),
    findApprovedReviewReminderWhatsappTemplate(scope),
  ]);
  if (!clinicConfig?.phoneNumberId || !clinicConfig?.accessToken) {
    return { success: true, sent: false, skipped: true, reason: 'whatsapp_connection_missing', list_id: listId, item_id: itemId };
  }
  clinicConfig.clinicId = clinicId;
  if (!template) {
    return { success: true, sent: false, skipped: true, reason: 'approved_review_reminder_template_missing', list_id: listId, item_id: itemId };
  }

  const missingVariables = buildMissingVariablesSummary({ template, items: [item.get ? item.get({ plain: true }) : item], list, clinic });
  if (missingVariables.length) {
    return {
      success: true,
      sent: false,
      skipped: true,
      reason: 'missing_variables',
      missing_variables: missingVariables,
      list_id: listId,
      item_id: itemId,
    };
  }

  const batchIndex = Number(item.send_batch_index || 0) + 1;
  const result = await sendDispatchItem({
    list,
    item,
    template,
    clinic,
    clinicConfig,
    batchIndex,
    messageKind: 'review_request_reminder',
    dispatchContextOverride: 'review_reminder',
    eventType: 'review_request_reminder_sent',
    connectionSource: 'review_request_reminder',
  });
  if (!result.sent) {
    return {
      success: true,
      sent: false,
      skipped: true,
      reason: 'reminder_send_failed',
      error: result.error?.message || result.error || null,
      list_id: listId,
      item_id: itemId,
    };
  }
  return {
    success: true,
    sent: true,
    skipped: false,
    list_id: listId,
    item_id: itemId,
    patient_id: item.paciente_id || null,
    message_id: result.message_id || result.app_message_id || null,
    app_message_id: result.app_message_id || result.message_id || null,
    conversation_id: result.conversation_id || null,
    provider_message_id: result.provider_message_id || null,
    dispatch_status: 'sent',
    sent_at: result.sent_at || new Date(),
    template_id: result.template_id || template.id,
    template_name: result.template_name || template.name,
  };
}

function buildJsonPayloadNumberWhere(key, value) {
  return db.sequelize.where(
    db.sequelize.literal(`CAST(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.${key}')) AS UNSIGNED)`),
    Number(value)
  );
}

async function findReviewFollowupJob(type, listId, itemId) {
  if (!JobRequest) return null;
  return JobRequest.findOne({
    where: {
      type,
      [Op.and]: [
        buildJsonPayloadNumberWhere('list_id', listId),
        buildJsonPayloadNumberWhere('item_id', itemId),
      ],
    },
    order: [['created_at', 'DESC']],
  });
}

async function hasReviewEvent(listId, itemId, eventTypes) {
  const event = await MarketingPatientContactEvent.findOne({
    where: {
      list_id: listId,
      item_id: itemId,
      event_type: { [Op.in]: Array.isArray(eventTypes) ? eventTypes : [eventTypes] },
    },
    order: [['occurred_at', 'DESC']],
  });
  return !!event;
}

async function enqueueReviewNoResponseJob({ list, item, nextRunAt = null, triggerMessageId = null }) {
  const listId = Number(list?.id || 0);
  const itemId = Number(item?.id || 0);
  if (!listId || !itemId) return null;
  const existing = await findReviewFollowupJob(REVIEW_NO_RESPONSE_JOB_TYPE, listId, itemId);
  if (existing && !['failed', 'cancelled'].includes(String(existing.status || '').toLowerCase())) {
    return existing;
  }
  return jobRequestsService.enqueueJobRequest({
    type: REVIEW_NO_RESPONSE_JOB_TYPE,
    payload: {
      list_id: listId,
      item_id: itemId,
      trigger_message_id: triggerMessageId || null,
    },
    priority: 'normal',
    status: 'waiting',
    origin: 'marketing_review_request',
    maxAttempts: 1,
    nextRunAt: nextRunAt || new Date(Date.now() + REVIEW_NO_RESPONSE_DELAY_MS),
  });
}

async function enqueueReviewReminderJob({ list, item, sentAt = null, triggerMessageId = null }) {
  const listId = Number(list?.id || 0);
  const itemId = Number(item?.id || 0);
  if (!listId || !itemId || !isReviewRequestList(list)) return null;
  const existing = await findReviewFollowupJob(REVIEW_REMINDER_JOB_TYPE, listId, itemId);
  if (existing && !['failed', 'cancelled'].includes(String(existing.status || '').toLowerCase())) {
    return existing;
  }
  const base = sentAt ? new Date(sentAt) : new Date();
  const nextRunAt = new Date((Number.isNaN(base.getTime()) ? Date.now() : base.getTime()) + REVIEW_REMINDER_DELAY_MS);
  return jobRequestsService.enqueueJobRequest({
    type: REVIEW_REMINDER_JOB_TYPE,
    payload: {
      list_id: listId,
      item_id: itemId,
      trigger_message_id: triggerMessageId || null,
    },
    priority: 'normal',
    status: 'waiting',
    origin: 'marketing_review_request',
    maxAttempts: 1,
    nextRunAt,
  });
}

async function runReviewRequestReminderJob(payload = {}) {
  const listId = Number(payload.list_id || payload.listId || 0);
  const itemId = Number(payload.item_id || payload.itemId || 0);
  if (!listId || !itemId) {
    return { status: 'completed', result: { skipped: true, reason: 'missing_list_or_item' } };
  }

  const [list, item] = await Promise.all([
    MarketingPatientList.findByPk(listId),
    MarketingPatientListItem.findOne({ where: { id: itemId, list_id: listId } }),
  ]);
  if (!list || !item || String(list.status || '').toLowerCase() === 'archived') {
    return { status: 'completed', result: { skipped: true, reason: 'list_or_item_not_available', list_id: listId, item_id: itemId } };
  }
  if (!isReviewRequestList(list)) {
    return { status: 'completed', result: { skipped: true, reason: 'not_review_request', list_id: listId, item_id: itemId } };
  }
  if (item.replied_at || String(item.dispatch_status || '').toLowerCase() === 'replied') {
    return { status: 'completed', result: { skipped: true, reason: 'already_replied', list_id: listId, item_id: itemId } };
  }
  const reminderAlreadySent = await hasReviewEvent(listId, itemId, ['review_request_reminder_sent']);
  if (reminderAlreadySent) {
    return { status: 'completed', result: { skipped: true, reason: 'reminder_already_sent', list_id: listId, item_id: itemId } };
  }

  const result = await sendReviewRequestReminder({ listId, itemId });
  if (result?.sent) {
    await enqueueReviewNoResponseJob({
      list,
      item,
      triggerMessageId: result.message_id || result.app_message_id || null,
      nextRunAt: new Date(Date.now() + REVIEW_NO_RESPONSE_DELAY_MS),
    });
  }
  return { status: 'completed', result };
}

async function runReviewNoResponseJob(payload = {}) {
  const listId = Number(payload.list_id || payload.listId || 0);
  const itemId = Number(payload.item_id || payload.itemId || 0);
  if (!listId || !itemId) {
    return { status: 'completed', result: { skipped: true, reason: 'missing_list_or_item' } };
  }
  const [list, item] = await Promise.all([
    MarketingPatientList.findByPk(listId),
    MarketingPatientListItem.findOne({ where: { id: itemId, list_id: listId } }),
  ]);
  if (!list || !item || String(list.status || '').toLowerCase() === 'archived') {
    return { status: 'completed', result: { skipped: true, reason: 'list_or_item_not_available', list_id: listId, item_id: itemId } };
  }
  if (item.replied_at || String(item.dispatch_status || '').toLowerCase() === 'replied') {
    return { status: 'completed', result: { skipped: true, reason: 'already_replied', list_id: listId, item_id: itemId } };
  }
  const closedAlready = await hasReviewEvent(listId, itemId, ['review_request_no_response_closed']);
  if (closedAlready) {
    return { status: 'completed', result: { skipped: true, reason: 'already_closed', list_id: listId, item_id: itemId } };
  }
  await MarketingPatientContactEvent.create({
    list_id: listId,
    item_id: itemId,
    paciente_id: item.paciente_id || null,
    event_type: 'review_request_no_response_closed',
    channel: 'whatsapp',
    payload: {
      reason: 'sin_respuesta_tras_recordatorio',
      trigger_message_id: payload.trigger_message_id || null,
    },
    occurred_at: new Date(),
  });
  return { status: 'completed', result: { closed: true, list_id: listId, item_id: itemId } };
}

function serializeItem(item) {
  const plain = item?.get ? item.get({ plain: true }) : item;
  return {
    id: plain.id,
    patient_id: plain.paciente_id,
    clinic_id: plain.clinica_id,
    name: plain.name,
    phone: plain.phone,
    email: plain.email,
    treatment: plain.treatment || plain.custom_fields?.tratamiento || null,
    treatment_id: plain.treatment_id || null,
    last_visit_at: plain.last_visit_at || null,
    appointment_at: plain.appointment_at || null,
    treatment_completed: plain.treatment_completed === true,
    status: plain.status,
    reason: plain.reason,
    exclusion_reason: plain.exclusion_reason,
    selected: plain.selected,
    custom_fields: plain.custom_fields || {},
    missing_variables: plain.missing_variables || [],
    dispatch_status: plain.dispatch_status || null,
    provider_message_id: plain.provider_message_id || null,
    app_message_id: plain.app_message_id || null,
    conversation_id: plain.conversation_id || null,
    send_batch_index: plain.send_batch_index || null,
    sent_at: plain.sent_at || null,
    delivered_at: plain.delivered_at || null,
    read_at: plain.read_at || null,
    replied_at: plain.replied_at || null,
    failed_at: plain.failed_at || null,
    opt_out_at: plain.opt_out_at || null,
    last_error_code: plain.last_error_code || null,
    last_error_message: plain.last_error_message || null,
    notes: plain.notes || null,
  };
}

function getBlockedGates(gates) {
  return REQUIRED_SEND_GATES.filter((key) => gates?.[key] !== true);
}

function serializeCampaign(list, { itemsPreview = [] } = {}) {
  const plain = list?.get ? list.get({ plain: true }) : list;
  return {
    id: plain.id,
    name: plain.name,
    objective_id: plain.objective_id,
    source: plain.source,
    status: plain.status,
    scope_type: plain.scope_type,
    clinic_id: plain.clinica_id,
    group_id: plain.grupo_clinica_id,
    clinic_ids: plain.clinic_ids || [],
    condition_summary: plain.condition_summary,
    criteria: plain.criteria || {},
    action_mode: plain.action_mode,
    channel: plain.channel,
    template_id: plain.template_id,
    template_snapshot: plain.template_snapshot || null,
    counters: plain.counters || {},
    metrics: plain.metrics || {},
    safety_gates: plain.safety_gates || {},
    blocked_gates: getBlockedGates(plain.safety_gates || {}),
    dispatch: getDispatchProgress(plain, plain.counters || null),
    custom_fields_schema: plain.custom_fields_schema || [],
    prepared_at: plain.prepared_at,
    last_sent_at: plain.last_sent_at,
    created_at: plain.created_at,
    updated_at: plain.updated_at,
    items_preview: itemsPreview.map(serializeItem),
  };
}

function getListWhatsappTemplateId(list) {
  const plain = list?.get ? list.get({ plain: true }) : (list || {});
  return Number(plain.criteria?.whatsapp_template_id || plain.template_snapshot?.id || 0) || null;
}

async function hydrateListTemplateSnapshots(lists) {
  const rows = (Array.isArray(lists) ? lists : [lists]).filter(Boolean);
  if (!rows.length || !WhatsappTemplate) return;

  const templateIds = Array.from(new Set(rows.map(getListWhatsappTemplateId).filter(Boolean)));
  if (!templateIds.length) return;

  const templates = await WhatsappTemplate.findAll({
    where: { id: { [Op.in]: templateIds }, is_active: true },
    include: [{ model: db.WhatsappTemplateCatalog, as: 'catalog', attributes: ['id', 'name', 'display_name', 'category', 'body_text', 'variables'], required: false }],
  });
  const templatesById = new Map(templates.map((template) => [Number(template.id), template]));

  for (const list of rows) {
    const template = templatesById.get(getListWhatsappTemplateId(list));
    if (!template) continue;

    const snapshot = buildTemplateSnapshot(template);
    const currentCriteria = list.get ? list.get('criteria') || {} : list.criteria || {};
    const templateUsage = resolveTemplateUsageFromMetaCategory(template, currentCriteria.template_usage || 'promocion');
    const templateCommercial = resolveTemplateCommercialFromMetaCategory(
      template,
      currentCriteria.template_commercial === true || isCommercialTemplateUsage(templateUsage)
    );
    const criteria = {
      ...currentCriteria,
      whatsapp_template_id: Number(template.id),
      template_usage: templateUsage,
      template_commercial: templateCommercial,
      template_category: getTemplateCategory(template) || null,
    };

    if (list.set) {
      list.set('template_snapshot', snapshot);
      list.set('criteria', criteria);
    } else {
      list.template_snapshot = snapshot;
      list.criteria = criteria;
    }
  }
}

async function listCampaigns(scope, options = {}) {
  const lists = await MarketingPatientList.findAll({
    where: {
      objective_id: OBJECTIVE_ID,
      status: { [Op.ne]: 'archived' },
      ...scopeToWhere(scope),
      ...contextToCampaignWhere(options.context),
    },
    order: [['updated_at', 'DESC']],
    limit: 100,
  });
  const ids = lists.map((list) => list.id);
  const [uniqueContactsRow] = ids.length
    ? await db.sequelize.query(
      `
      SELECT
        COUNT(DISTINCT ${buildContactUniqExpression()}) AS unique_contacts,
        COUNT(DISTINCT CASE WHEN status = 'ready' THEN ${buildContactUniqExpression()} END) AS unique_ready_contacts,
        COUNT(DISTINCT CASE
          WHEN sent_at IS NOT NULL OR dispatch_status IN ('sent','delivered','read','replied')
          THEN ${buildContactUniqExpression()}
        END) AS unique_sent_contacts
      FROM MarketingPatientListItems
      WHERE list_id IN (:ids)
      `,
      { replacements: { ids }, type: QueryTypes.SELECT }
    )
    : [{ unique_contacts: 0 }];
  const previewRows = ids.length
    ? await MarketingPatientListItem.findAll({
      where: { list_id: { [Op.in]: ids } },
      order: [['id', 'ASC']],
      limit: ids.length * 5,
    })
    : [];
  const previewByList = new Map();
  for (const row of previewRows) {
    if (!previewByList.has(row.list_id)) previewByList.set(row.list_id, []);
    const bucket = previewByList.get(row.list_id);
    if (bucket.length < 5) bucket.push(row);
  }
  await hydrateListTemplateSnapshots(lists);
  const items = lists.map((list) => serializeCampaign(list, { itemsPreview: previewByList.get(list.id) || [] }));
  const aggregate = items.reduce((acc, item) => {
    const counters = item.counters || {};
    acc.total_lists += 1;
    acc.total_patients += Number(counters.total || 0);
    acc.ready += Number(counters.ready || 0);
    acc.excluded += Number(counters.excluded || 0);
    acc.sent += Number(counters.sent || 0);
    acc.delivered += Number(counters.delivered || 0);
    acc.read += Number(counters.read || 0);
    acc.replied += Number(counters.replied || 0);
    return acc;
  }, { total_lists: 0, total_patients: 0, unique_contacts: 0, ready: 0, excluded: 0, sent: 0, delivered: 0, read: 0, replied: 0, appointments: 0, treatments: 0, estimated_revenue: 0 });
  aggregate.unique_contacts = Number(uniqueContactsRow?.unique_contacts || 0);
  aggregate.unique_ready_contacts = Number(uniqueContactsRow?.unique_ready_contacts || 0);
  aggregate.unique_sent_contacts = Number(uniqueContactsRow?.unique_sent_contacts || 0);
  return { success: true, items, aggregate, daily_series: [] };
}

async function createCampaign(scope, body = {}, userId = null) {
  const rows = Array.isArray(body.import_rows) ? body.import_rows.filter((row) => row && typeof row === 'object') : [];
  const channels = normalizeChannels(body.channels || body.destinations || body.channel);
  const listSource = normalizeText(body.list_source || body.source || 'import');
  const source = listSource === 'current_patients' ? 'existing_patients_condition' : (listSource === 'manual' ? 'manual_list' : 'imported_file');
  const templateUsage = normalizeTemplateUsage(body.template_usage || body.template_uso || body.uso || 'promocion');
  const templateCommercial = body.template_commercial === true || isCommercialTemplateUsage(templateUsage);
  const listName = normalizeText(body.name) || 'Lista de envíos masivos';
  const campaignName = normalizeText(body.campaign_name || body.campaignName) || listName;
  const linkTracking = buildLinkTrackingCriteria(body, {});
  const isReviewRequest = isReviewRequestBody(body);
  const reviewSource = normalizeReviewRequestSource(body.review_source || body.reviewRequestSource);
  const reviewTreatmentIds = parseReviewTreatmentIds(body);
  const reviewThreshold = 5;
  const effectiveScope = isReviewRequest ? applyReviewClinicFilter(scope, body) : scope;

  return db.sequelize.transaction(async (transaction) => {
    let itemPayloads = [];
    let columnMapping = body.column_mapping || {};
    let customFieldsSchema = Array.isArray(body.custom_fields_schema) ? body.custom_fields_schema : [];
    let importSummary = null;
    let importMetadata = null;

    if (source === 'existing_patients_condition') {
      itemPayloads = await buildItemsFromCurrentPatients(effectiveScope, body);
    } else {
      const importResult = buildItemsFromRows(rows, body, channels);
      itemPayloads = importResult.items;
      columnMapping = importResult.columnMapping;
      customFieldsSchema = importResult.customFieldsSchema;
      itemPayloads = await attachExistingPatientContext(itemPayloads, effectiveScope, transaction);
      itemPayloads = await attachImportedClinicContext(itemPayloads, effectiveScope, transaction);
      importMetadata = importResult.importMetadata;
      importSummary = buildImportSummary(itemPayloads, importMetadata);
    }

    itemPayloads = await applyMarketingOptOutExclusions(itemPayloads, effectiveScope, transaction);
    if (isReviewRequest && effectiveScope?.scope === 'group') {
      const clinicStatuses = await buildReviewClinicStatuses(effectiveScope, {
        review_source: reviewSource,
        review_treatment_ids: reviewTreatmentIds,
        review_treatment_moment: body.review_treatment_moment || body.reviewTreatmentMoment || null,
      });
      itemPayloads = applyReviewClinicReadinessExclusions(itemPayloads, clinicStatuses);
    }
    if (importMetadata) {
      importSummary = buildImportSummary(itemPayloads, importMetadata);
    }
    const counters = computeCounters(itemPayloads);
    const list = await MarketingPatientList.create({
      name: listName,
      objective_id: OBJECTIVE_ID,
      source,
      status: 'draft',
      ...serializeScope(effectiveScope),
      treatment: null,
      condition_summary: source === 'existing_patients_condition'
        ? (isReviewRequest
          ? 'Pacientes elegibles para solicitar valoración, excluyendo quienes ya recibieron una solicitud.'
          : 'Pacientes actuales que cumplen la condición seleccionada.')
        : 'Lista externa importada para campaña puntual.',
      exclusion_summary: counters.excluded ? `${counters.excluded} contactos no tienen los campos necesarios o están duplicados.` : 'Sin exclusiones detectadas.',
      criteria: {
        campaign_name: campaignName,
        list_name: listName,
        channels,
        template_usage: templateUsage,
        template_commercial: templateCommercial,
        whatsapp_template_id: Number(body.whatsapp_template_id || body.template_id || 0) || null,
        opt_out_text: templateCommercial ? normalizeText(body.opt_out_text) : null,
        consent_acknowledged: !!body.consent_acknowledged,
        list_source: source,
        review_request: isReviewRequest,
        review_source: isReviewRequest ? reviewSource : null,
        review_group_clinic_ids: isReviewRequest ? parseReviewClinicIds(body) : [],
        review_treatment_id: isReviewRequest ? (reviewTreatmentIds[0] || null) : null,
        review_treatment_ids: isReviewRequest ? reviewTreatmentIds : [],
        review_treatment_moment: isReviewRequest ? normalizeText(body.review_treatment_moment || body.reviewTreatmentMoment || '') || null : null,
        excluded_review_patient_ids: isReviewRequest ? parseReviewExcludedPatientIds(body) : [],
        review_exclusion_rules: isReviewRequest ? parseReviewExclusionRules(body) : null,
        review_delay: isReviewRequest ? normalizeText(body.review_delay || body.reviewDelay || '24h') : null,
        review_threshold: isReviewRequest ? reviewThreshold : null,
        review_gift_enabled: isReviewRequest ? (body.review_gift_enabled === true || String(body.review_gift_enabled || '').toLowerCase() === 'true') : false,
        review_gift_description: isReviewRequest ? normalizeText(body.review_gift_description || body.reviewGiftDescription || '') || null : null,
        review_display_clinic_name: isReviewRequest ? normalizeText(body.review_display_clinic_name || body.reviewDisplayClinicName || '') || null : null,
        review_sender_name: isReviewRequest ? normalizeText(body.review_sender_name || body.reviewSenderName || '') || null : null,
        review_team_photo_url: isReviewRequest ? normalizeText(body.review_team_photo_url || body.reviewTeamPhotoUrl || '') || null : null,
        review_team_photo_overlay_color: isReviewRequest
          ? publicMediaPersonalizationService.normalizeHexColor(body.review_team_photo_overlay_color || body.reviewTeamPhotoOverlayColor)
          : null,
        review_team_members_text: isReviewRequest ? normalizeText(body.review_team_members_text || body.reviewTeamMembersText || '') || null : null,
        review_automation_enabled: false,
        import_file_name: body.import_file_name || null,
        column_mapping: columnMapping,
        name_format: normalizeNameFormat(body.name_format || body.nameFormat || (source === 'imported_file' ? 'auto' : null)),
        import_history: importSummary ? [importSummary] : [],
        welcome_message: body.welcome_message && typeof body.welcome_message === 'object' ? body.welcome_message : null,
        link_tracking: linkTracking,
        required_policy: {
          whatsapp: ['name', 'phone'],
          email: ['name', 'email'],
          managed_calls: ['name', 'phone'],
        },
      },
      action_mode: channels.join(','),
      channel: channels[0] || 'whatsapp',
      counters,
      metrics: { total_cost: 0, estimated_revenue: 0 },
      safety_gates: {
        frozen_audience: counters.ready > 0,
        opt_out: !!body.consent_acknowledged,
        capping: false,
        approved_template: false,
        audit: true,
        cancelable_queue: false,
      },
      custom_fields_schema: customFieldsSchema,
      created_by: userId || null,
    }, { transaction });

    if (itemPayloads.length) {
      await MarketingPatientListItem.bulkCreate(itemPayloads.map((item) => ({ ...item, list_id: list.id })), { transaction });
    }

    await MarketingPatientContactEvent.create({
      list_id: list.id,
      event_type: 'mass_campaign_created',
      channel: list.channel,
      payload: { channels, counters, source },
      occurred_at: new Date(),
    }, { transaction });

    const created = await MarketingPatientList.findByPk(list.id, { transaction });
    const preview = itemPayloads.slice(0, 5).map((item, index) => ({ ...item, id: index + 1 }));
    const responseImportSummary = importSummary
      ? {
        ...importSummary,
        imported_items: itemPayloads
          .filter((item) => item.status === 'ready')
          .map(serializeImportResultItem),
        discarded_items: itemPayloads
          .filter((item) => String(item.status || '').startsWith('excluded'))
          .map(serializeImportResultItem),
      }
      : null;
    return {
      success: true,
      campaign: serializeCampaign(created, { itemsPreview: preview }),
      list: serializeCampaign(created, { itemsPreview: preview }),
      import_result: responseImportSummary,
    };
  });
}

async function getCampaign(scope, campaignId) {
  const list = await MarketingPatientList.findByPk(campaignId);
  ensureScopeAccess(list, scope);
  await reconcileListMessageState(list, scope);
  const reloaded = await MarketingPatientList.findByPk(list.id);
  await hydrateListTemplateSnapshots(reloaded);
  const items = await MarketingPatientListItem.findAll({
    where: { list_id: list.id },
    order: [['id', 'ASC']],
    limit: 1000,
  });
  const report = await buildListReport(list.id);
  return {
    success: true,
    campaign: serializeCampaign(reloaded, { itemsPreview: items.slice(0, 5) }),
    list: serializeCampaign(reloaded, { itemsPreview: items.slice(0, 5) }),
    items: items.map(serializeItem),
    report,
  };
}

function getListItemDedupeKey(item) {
  const phoneDigits = normalizePhoneDigits(item?.phone || '');
  if (phoneDigits) return `phone:${phoneDigits}`;
  const email = normalizeText(item?.email).toLowerCase();
  if (email) return `email:${email}`;
  const patientId = Number(item?.paciente_id || item?.patient_id || 0);
  if (Number.isInteger(patientId) && patientId > 0) return `patient:${patientId}`;
  const name = normalizeKey(item?.name || '');
  return name ? `name:${name}` : null;
}

function mergeCustomFieldSchemas(existingSchema = [], incomingSchema = []) {
  const fields = new Map();
  for (const field of [...(Array.isArray(existingSchema) ? existingSchema : []), ...(Array.isArray(incomingSchema) ? incomingSchema : [])]) {
    if (!field || typeof field !== 'object') continue;
    const key = normalizeKey(field.key || field.name || field.variable);
    if (!key) continue;
    fields.set(key, {
      key,
      label: normalizeText(field.label) || key.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '),
      type: normalizeText(field.type) || 'text',
      source: normalizeText(field.source) || 'import',
      ...(field.source_column || field.sourceColumn ? { source_column: normalizeText(field.source_column || field.sourceColumn) } : {}),
    });
  }
  return Array.from(fields.values());
}

function buildImportMetadata(body = {}) {
  const importedAt = new Date();
  const importBatchId = normalizeText(body.import_batch_id || body.importBatchId)
    || crypto.randomBytes(8).toString('hex');
  return {
    importBatchId,
    importedAt,
    importedAtIso: importedAt.toISOString(),
    importedAtDate: importedAt.toISOString().slice(0, 10),
    importedAtLabel: importedAt.toLocaleString('es-ES', {
      timeZone: 'Europe/Madrid',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }),
  };
}

function withImportTrackingSchema(schema = []) {
  return mergeCustomFieldSchemas(schema, [
    {
      key: 'fecha_importacion',
      label: 'Fecha importación',
      type: 'date',
      source: 'system',
      source_column: 'Fecha importación',
    },
    {
      key: 'lote_importacion',
      label: 'Lote importación',
      type: 'text',
      source: 'system',
      source_column: 'Lote importación',
    },
  ]);
}

function buildImportSummary(itemPayloads = [], metadata = {}) {
  const reasons = {};
  for (const item of itemPayloads) {
    if (!String(item.status || '').startsWith('excluded')) continue;
    const key = normalizeKey(item.exclusion_reason || item.status || 'otro') || 'otro';
    reasons[key] = (reasons[key] || 0) + 1;
  }
  return {
    import_batch_id: metadata.importBatchId || null,
    imported_at: metadata.importedAtIso || null,
    total: itemPayloads.length,
    imported: itemPayloads.filter((item) => item.status === 'ready').length,
    discarded: itemPayloads.filter((item) => String(item.status || '').startsWith('excluded')).length,
    reasons,
  };
}

function serializeImportResultItem(item) {
  return {
    name: item?.name || null,
    phone: item?.phone || null,
    email: item?.email || null,
    status: item?.status || null,
    reason: item?.reason || null,
    exclusion_reason: item?.exclusion_reason || null,
    custom_fields: item?.custom_fields || {},
  };
}

function normalizeListSegment(segment = {}) {
  if (!segment || typeof segment !== 'object') return null;
  const field = normalizeKey(segment.field || segment.key || '');
  const value = normalizeText(segment.value);
  if (!field) return null;
  const allowedOperators = new Set(['equals', 'contains', 'not_empty']);
  const operator = allowedOperators.has(normalizeKey(segment.operator || 'equals'))
    ? normalizeKey(segment.operator || 'equals')
    : 'equals';
  if (operator !== 'not_empty' && !value) return null;
  return {
    id: normalizeText(segment.id) || crypto.randomBytes(6).toString('hex'),
    name: normalizeText(segment.name) || `Segmento ${field}`,
    field,
    operator,
    value,
    created_at: new Date().toISOString(),
  };
}

function getListSegments(criteria = {}) {
  return Array.isArray(criteria?.segments) ? criteria.segments : [];
}

function findListSegment(criteria = {}, segmentId = '') {
  const id = normalizeText(segmentId);
  if (!id) return null;
  return getListSegments(criteria).find((segment) => String(segment?.id || '') === id) || null;
}

function getSegmentItemValue(item = {}, field = '') {
  const key = normalizeKey(field);
  if (key === 'name' || key === 'nombre') return normalizeText(item.name);
  if (key === 'phone' || key === 'telefono') return normalizeText(item.phone);
  if (key === 'email') return normalizeText(item.email);
  if (key === 'status' || key === 'estado') return normalizeText(item.status);
  const custom = item.custom_fields || {};
  if (custom[key] !== undefined && custom[key] !== null) return normalizeText(custom[key]);
  const matched = Object.entries(custom).find(([rawKey]) => normalizeKey(rawKey) === key);
  return matched ? normalizeText(matched[1]) : '';
}

function itemMatchesSegment(item = {}, segment = {}) {
  const field = normalizeKey(segment.field || segment.key || '');
  const operator = normalizeKey(segment.operator || 'equals');
  const expected = normalizeText(segment.value).toLowerCase();
  const value = getSegmentItemValue(item, field).toLowerCase();
  if (!field) return false;
  if (operator === 'not_empty') return !!value;
  if (operator === 'contains') return !!expected && value.includes(expected);
  return !!expected && value === expected;
}

function annotateSegmentCounts(criteria = {}, items = []) {
  const plainItems = items.map((item) => (item?.get ? item.get({ plain: true }) : item));
  const segmentCounts = {};
  const segments = getListSegments(criteria).map((segment) => {
    const id = normalizeText(segment?.id);
    const count = plainItems.filter((item) => itemMatchesSegment(item, segment)).length;
    if (id) segmentCounts[id] = count;
    return { ...segment, count };
  });
  return {
    ...criteria,
    segments,
    segment_counts: segmentCounts,
  };
}

async function applyActiveSegmentSelection(list, items = [], activeSegmentId = null, transaction = null) {
  const activeId = normalizeText(activeSegmentId);
  const plainItems = items.map((item) => (item?.get ? item.get({ plain: true }) : item));
  if (!activeId) {
    const readyIds = plainItems
      .filter((item) => item.status === 'ready' && item.selected === false)
      .map((item) => item.id)
      .filter(Boolean);
    if (readyIds.length) {
      await MarketingPatientListItem.update(
        { selected: true },
        { where: { id: { [Op.in]: readyIds }, list_id: list.id }, transaction }
      );
    }
    return plainItems.map((item) => item.status === 'ready' ? { ...item, selected: true } : item);
  }
  const segment = findListSegment(list.criteria || {}, activeId);
  if (!segment) {
    return plainItems;
  }
  const selectedIds = new Set(
    plainItems
      .filter((item) => item.status === 'ready' && itemMatchesSegment(item, segment))
      .map((item) => item.id)
      .filter(Boolean)
  );
  await MarketingPatientListItem.update(
    { selected: false },
    { where: { list_id: list.id, status: 'ready' }, transaction }
  );
  if (selectedIds.size) {
    await MarketingPatientListItem.update(
      { selected: true },
      { where: { id: { [Op.in]: Array.from(selectedIds) }, list_id: list.id }, transaction }
    );
  }
  return plainItems.map((item) => item.status === 'ready'
    ? { ...item, selected: selectedIds.has(item.id) }
    : item);
}

async function updateCampaign(scope, campaignId, body = {}, userId = null) {
  const list = await MarketingPatientList.findByPk(campaignId);
  ensureScopeAccess(list, scope);
  if (String(list.status || '') === 'archived') {
    const err = new Error('No se puede editar una lista archivada');
    err.status = 409;
    throw err;
  }

  const listName = normalizeText(body.name || body.list_name);
  const campaignName = normalizeText(body.campaign_name || body.campaignName);
  const requestedStatus = normalizeText(body.status || body.state);
  const incomingChannels = body.channels || body.destinations || null;
  const channels = incomingChannels ? normalizeChannels(incomingChannels) : null;
  const appendRows = Array.isArray(body.append_rows)
    ? body.append_rows.filter((row) => row && typeof row === 'object')
    : [];

  const nextCriteria = {
    ...(list.criteria || {}),
  };
  if (listName) nextCriteria.list_name = listName;
  if (campaignName) nextCriteria.campaign_name = campaignName;
  if (channels) nextCriteria.channels = channels;
  if (body.whatsapp_template_id !== undefined || body.template_id !== undefined) {
    nextCriteria.whatsapp_template_id = Number(body.whatsapp_template_id || body.template_id || 0) || null;
  }
  if (body.template_usage !== undefined) nextCriteria.template_usage = normalizeTemplateUsage(body.template_usage);
  if (body.template_commercial !== undefined) nextCriteria.template_commercial = body.template_commercial === true;
  if (body.opt_out_text !== undefined) nextCriteria.opt_out_text = normalizeText(body.opt_out_text) || null;
  if (body.consent_acknowledged !== undefined) nextCriteria.consent_acknowledged = body.consent_acknowledged === true;
  if (body.schedule_mode !== undefined) nextCriteria.schedule_mode = normalizeText(body.schedule_mode) || 'now';
  if (body.scheduled_at !== undefined) nextCriteria.scheduled_at = body.scheduled_at || null;
  if (
    body.link_tracking !== undefined ||
    body.link_tracking_enabled !== undefined ||
    body.tracking_domain_mode !== undefined ||
    body.tracking_custom_subdomain !== undefined ||
    body.tracking_domain !== undefined
  ) {
    nextCriteria.link_tracking = buildLinkTrackingCriteria(body, nextCriteria);
  }
  const incomingSegment = normalizeListSegment(body.segment);
  if (incomingSegment) {
    const previousSegments = Array.isArray(nextCriteria.segments) ? nextCriteria.segments : [];
    nextCriteria.segments = [
      incomingSegment,
      ...previousSegments.filter((segment) => String(segment?.id || '') !== incomingSegment.id),
    ];
  }
  if (body.active_segment_id !== undefined || body.segment_id !== undefined) {
    nextCriteria.active_segment_id = normalizeText(body.active_segment_id || body.segment_id) || null;
  }
  if (body.auto_send_when_template_approved !== undefined || body.auto_send_when_approved !== undefined) {
    nextCriteria.auto_send_when_template_approved = body.auto_send_when_template_approved === true || body.auto_send_when_approved === true;
  }
  if (body.welcome_message !== undefined) {
    nextCriteria.welcome_message = body.welcome_message && typeof body.welcome_message === 'object'
      ? body.welcome_message
      : null;
  }

  const updatePayload = { criteria: nextCriteria };
  if (requestedStatus === 'archived') {
    updatePayload.status = 'archived';
  }
  if (body.whatsapp_template_id !== undefined || body.template_id !== undefined) {
    if (nextCriteria.whatsapp_template_id) {
      const template = await resolveWhatsappTemplate(nextCriteria.whatsapp_template_id, scope);
      updatePayload.template_id = null;
      updatePayload.template_snapshot = buildTemplateSnapshot(template);
    } else {
      updatePayload.template_snapshot = null;
    }
  }
  if (listName) updatePayload.name = listName;
  if (channels) {
    updatePayload.action_mode = channels.join(',');
    updatePayload.channel = channels[0] || list.channel || 'whatsapp';
  }

  let appendedCount = 0;
  let appendedReady = 0;
  let appendedExcluded = 0;
  let appendImportSummary = null;

  await db.sequelize.transaction(async (transaction) => {
    if (appendRows.length) {
      const effectiveChannels = channels || normalizeChannels(nextCriteria.channels || list.action_mode || list.channel || 'whatsapp');
      const importBody = {
        ...nextCriteria,
        ...body,
        clinic_id: list.clinica_id || body.clinic_id || body.clinica_id || null,
        column_mapping: body.column_mapping || nextCriteria.column_mapping || {},
        custom_fields_schema: body.custom_fields_schema || list.custom_fields_schema || nextCriteria.custom_fields_schema || [],
        name_format: body.name_format || nextCriteria.name_format || 'auto',
      };
      const importResult = buildItemsFromRows(appendRows, importBody, effectiveChannels);
      let itemPayloads = importResult.items;
      itemPayloads = await attachExistingPatientContext(itemPayloads, scope, transaction);
      itemPayloads = await applyMarketingOptOutExclusions(itemPayloads, scope, transaction);

      const existingRows = await MarketingPatientListItem.findAll({
        where: { list_id: list.id },
        attributes: ['paciente_id', 'name', 'phone', 'email'],
        raw: true,
        transaction,
      });
      const existingKeys = new Set(existingRows.map(getListItemDedupeKey).filter(Boolean));
      itemPayloads = itemPayloads.map((item) => {
        if (String(item.status || '').startsWith('excluded')) return item;
        const key = getListItemDedupeKey(item);
        if (key && existingKeys.has(key)) {
          return {
            ...item,
            status: 'excluded_duplicate',
            reason: 'Duplicado con un contacto ya existente en la lista',
            exclusion_reason: 'duplicado',
            selected: false,
          };
        }
        if (key) existingKeys.add(key);
        return item;
      });

      const readyItemPayloads = itemPayloads.filter((item) => item.status === 'ready');
      const rejectedItemPayloads = itemPayloads.filter((item) => String(item.status || '').startsWith('excluded'));
      appendedCount = itemPayloads.length;
      appendedReady = readyItemPayloads.length;
      appendedExcluded = rejectedItemPayloads.length;
      appendImportSummary = {
        ...buildImportSummary(itemPayloads, importResult.importMetadata),
        imported_items: readyItemPayloads.map(serializeImportResultItem),
        discarded_items: rejectedItemPayloads.map(serializeImportResultItem),
      };

      if (readyItemPayloads.length) {
        await MarketingPatientListItem.bulkCreate(
          readyItemPayloads.map((item) => ({ ...item, list_id: list.id })),
          { transaction }
        );
      }

      if (readyItemPayloads.length) {
        nextCriteria.column_mapping = importResult.columnMapping;
        nextCriteria.name_format = importResult.nameFormat;
        updatePayload.custom_fields_schema = mergeCustomFieldSchemas(list.custom_fields_schema || [], importResult.customFieldsSchema || []);
        updatePayload.condition_summary = 'Lista externa importada para campaña puntual, con contactos añadidos posteriormente.';
      }
      updatePayload.exclusion_summary = list.exclusion_summary || 'Sin exclusiones detectadas.';
    }

    const segmentItems = await MarketingPatientListItem.findAll({ where: { list_id: list.id }, transaction });
    updatePayload.criteria = annotateSegmentCounts(updatePayload.criteria || nextCriteria, segmentItems);
    await list.update(updatePayload, { transaction });
    const counters = await refreshListCounters(list.id, transaction);
    await MarketingPatientContactEvent.create({
      list_id: list.id,
      event_type: appendRows.length ? 'mass_campaign_contacts_appended' : 'mass_campaign_updated',
      channel: updatePayload.channel || list.channel,
      payload: {
        user_id: userId || null,
        changed: Object.keys(updatePayload),
        appended_count: appendedCount,
        appended_ready: appendedReady,
        appended_excluded: appendedExcluded,
        counters,
      },
      occurred_at: new Date(),
    }, { transaction });
  });

  const reloaded = await MarketingPatientList.findByPk(list.id);
  await hydrateListTemplateSnapshots(reloaded);
  const items = await MarketingPatientListItem.findAll({
    where: { list_id: list.id },
    order: [['id', 'ASC']],
    limit: 5,
  });
  return {
    success: true,
    campaign: serializeCampaign(reloaded, { itemsPreview: items }),
    list: serializeCampaign(reloaded, { itemsPreview: items }),
    import_result: appendImportSummary,
  };
}

async function resolveWhatsappTemplate(templateId, scope) {
  const safeId = Number(templateId || 0);
  if (!safeId || !WhatsappTemplate) return null;
  const template = await WhatsappTemplate.findByPk(safeId, {
    include: [{ model: db.WhatsappTemplateCatalog, as: 'catalog', attributes: ['id', 'name', 'display_name', 'body_text', 'variables'], required: false }],
  });
  if (!template) {
    const err = new Error('Plantilla WhatsApp no encontrada');
    err.status = 404;
    throw err;
  }
  const clinicIds = new Set((scope?.clinicIds || []).map(Number));
  if (template.clinic_id && clinicIds.size && !clinicIds.has(Number(template.clinic_id))) {
    const err = new Error('La plantilla no pertenece a la clínica seleccionada');
    err.status = 403;
    throw err;
  }
  return template;
}

function extractBodyText(components) {
  const body = parseTemplateComponents(components)
    .find((component) => String(component?.type || '').toUpperCase() === 'BODY');
  return body?.text || '';
}

function buildTemplateSnapshot(template) {
  if (!template) return null;
  const plain = template.get ? template.get({ plain: true }) : template;
  return {
    id: plain.id,
    name: plain.name,
    display_name: plain.catalog?.display_name || plain.display_name || plain.name,
    category: plain.category || plain.catalog?.category || null,
    status: plain.status,
    rejection_reason: plain.rejection_reason || null,
    language: plain.language || 'es',
    body: extractBodyText(plain.components),
    variables: buildWhatsappTemplateVariableContract(plain),
    captured_at: new Date().toISOString(),
  };
}

function getTemplateWabaId(template) {
  const plain = template?.get ? template.get({ plain: true }) : (template || {});
  return normalizeText(plain.waba_id || plain.wabaId || '');
}

async function getPrimaryWabaIdForScope(scope) {
  const clinicIds = Array.isArray(scope?.clinicIds)
    ? scope.clinicIds.filter(Number.isInteger)
    : [];
  if (!clinicIds.length) return '';
  const clinicConfig = await whatsappService.getClinicConfig(clinicIds[0]).catch(() => null);
  return normalizeText(clinicConfig?.wabaId || '');
}

function scoreWhatsappTemplateForScope(template, clinicIds, targetWabaId = '') {
  const plain = template?.get ? template.get({ plain: true }) : (template || {});
  const clinicId = Number(plain.clinic_id || 0);
  const wabaId = getTemplateWabaId(plain);
  if (clinicId && clinicIds.includes(clinicId)) return 3;
  if (targetWabaId && wabaId && wabaId === targetWabaId) return 2;
  if (!targetWabaId) return 1;
  return 0;
}

async function resolveWhatsappTemplateForClinic(template, clinicId, clinicConfig = null) {
  const safeClinicId = Number(clinicId || 0);
  const plain = template?.get ? template.get({ plain: true }) : (template || {});
  if (!template || !safeClinicId) return template || null;

  const templateClinicId = Number(plain.clinic_id || 0);
  const templateWabaId = getTemplateWabaId(plain);
  const targetWabaId = normalizeText(clinicConfig?.wabaId || '');
  const catalogTemplateId = Number(plain.catalog_template_id || plain.catalog?.id || 0) || null;

  const sameClinic = !templateClinicId || templateClinicId === safeClinicId;
  const sameWaba = !targetWabaId || !templateWabaId || templateWabaId === targetWabaId;
  if (sameClinic && sameWaba) return template;

  if (!catalogTemplateId || !WhatsappTemplate) return null;

  const replacement = await WhatsappTemplate.findOne({
    where: {
      is_active: true,
      status: 'APPROVED',
      catalog_template_id: catalogTemplateId,
      [Op.or]: [
        { clinic_id: safeClinicId },
        ...(targetWabaId ? [{ waba_id: targetWabaId }] : []),
        { clinic_id: null },
      ],
    },
    include: [{ model: db.WhatsappTemplateCatalog, as: 'catalog', attributes: ['id', 'name', 'display_name', 'body_text', 'variables'], required: false }],
    order: [
      ['clinic_id', 'DESC'],
      ['updatedAt', 'DESC'],
      ['id', 'DESC'],
    ],
  });

  return replacement || null;
}

function resolveReviewDisplayClinicName(list, clinic) {
  const criteria = asPlainObject(list?.criteria);
  const explicit = normalizeText(criteria.review_display_clinic_name || criteria.reviewDisplayClinicName || '');
  if (explicit) return explicit;
  const shouldPreferGoogleName = isReviewRequestList(list)
    || criteria.review_request === true
    || String(criteria.review_request || '').toLowerCase() === 'true'
    || isReviewTemplateUsage(criteria.template_usage);
  return normalizeText(
    (shouldPreferGoogleName
      ? (clinic?.perfil_google_location_name || clinic?.location_name || clinic?.google_location_name)
      : '')
    || clinic?.nombre_clinica
    || clinic?.nombre
    || 'tu clínica'
  );
}

function resolveReviewSenderName(list) {
  const criteria = asPlainObject(list?.criteria);
  return normalizeText(
    criteria.review_sender_name
    || criteria.reviewSenderName
    || criteria.firma_resenas
    || ''
  ) || 'Recepción';
}

function firstTokenFromName(value) {
  const clean = toTitleCaseName(value).replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const commaParts = clean.split(',').map((part) => part.trim()).filter(Boolean);
  if (commaParts.length > 1) {
    return commaParts[1].split(' ')[0] || commaParts[0].split(' ')[0] || '';
  }
  return clean.split(' ')[0] || '';
}

function resolvePatientFirstNameForTemplate(item = {}) {
  const custom = asPlainObject(item.custom_fields);
  return firstTokenFromName(
    custom.nombre
    || custom.nombre_paciente
    || custom.first_name
    || custom.firstname
    || item.first_name
    || item.firstname
    || item.name
    || ''
  ) || 'Paciente';
}

function resolveVariableValue(variableName, item, list, clinic) {
  const key = normalizeKey(variableName);
  const custom = item.custom_fields || {};
  const displayClinicName = resolveReviewDisplayClinicName(list, clinic);
  const reviewSenderName = resolveReviewSenderName(list);
  const patientFirstName = resolvePatientFirstNameForTemplate(item || {});
  const patientFullName = normalizeText(custom.nombre_completo || item.name || patientFirstName);
  const values = {
    nombre: patientFirstName,
    nombre_paciente: patientFirstName,
    nombrepaciente: patientFirstName,
    apellido: custom.apellido || custom.apellidos || custom.apellido_paciente || '',
    apellidos: custom.apellidos || custom.apellido || custom.apellido_paciente || '',
    apellido_paciente: custom.apellido_paciente || custom.apellido || custom.apellidos || '',
    nombre_completo: patientFullName,
    telefono: item.phone,
    email: item.email,
    clinica: displayClinicName,
    nombre_clinica: displayClinicName,
    nombreclinica: displayClinicName,
    nombre_clinica_visible: displayClinicName,
    firma_resenas: reviewSenderName,
    nombre_remitente_resenas: reviewSenderName,
    remitente_resena: reviewSenderName,
    review_sender_name: reviewSenderName,
    telefono_clinica: clinic?.telefono || clinic?.telefono_clinica || '',
    direccion_clinica: clinic?.direccion || '',
    url_web_clinica: clinic?.url_web || '',
    url_ficha_local_clinica: clinic?.url_ficha_local || '',
    clinic_local_profile_url: clinic?.url_ficha_local || '',
    url_perfil_google_clinica: clinic?.url_perfil_google || clinic?.url_ficha_local || '',
    google_profile_url: clinic?.url_perfil_google || clinic?.url_ficha_local || '',
    clinic_google_profile_url: clinic?.url_perfil_google || clinic?.url_ficha_local || '',
    url_como_llegar_clinica: clinic?.url_como_llegar || clinic?.url_perfil_google || clinic?.url_ficha_local || '',
    url_como_llegar: clinic?.url_como_llegar || clinic?.url_perfil_google || clinic?.url_ficha_local || '',
    url_dejar_resena_clinica: clinic?.url_dejar_resena || '',
    url_dejar_resena: clinic?.url_dejar_resena || '',
    enlace_resena: clinic?.url_dejar_resena || '',
    tratamiento: item.treatment || '',
    fecha: custom.fecha || custom.fecha_cita || '',
    fecha_cita: custom.fecha_cita || custom.fecha || '',
    referencia_visita: custom.referencia_visita || (custom.fecha_cita || custom.fecha ? `el pasado ${custom.fecha_cita || custom.fecha}` : 'en tu última atención'),
    referencia_cita: custom.referencia_visita || (custom.fecha_cita || custom.fecha ? `el pasado ${custom.fecha_cita || custom.fecha}` : 'en tu última atención'),
  };
  return normalizeText(custom[key] || values[key] || '');
}

function getTemplateVariableContract(template) {
  const plain = template?.get ? template.get({ plain: true }) : template;
  return buildWhatsappTemplateVariableContract(plain)
    .map((variable) => ({
      ...variable,
      name: normalizeKey(variable.name || `var_${variable.index || variable.position || ''}`),
    }))
    .filter((variable) => variable.name);
}

function getClinicIdForList(list, fallbackScope = {}) {
  const fromList = Number(list?.clinica_id || 0);
  if (Number.isInteger(fromList) && fromList > 0) return fromList;
  const listClinicIds = Array.isArray(list?.clinic_ids) ? list.clinic_ids : [];
  const fromListArray = Number(listClinicIds[0] || 0);
  if (Number.isInteger(fromListArray) && fromListArray > 0) return fromListArray;
  const scopeClinicIds = Array.isArray(fallbackScope?.clinicIds) ? fallbackScope.clinicIds : [];
  const fromScope = Number(scopeClinicIds[0] || 0);
  return Number.isInteger(fromScope) && fromScope > 0 ? fromScope : null;
}

function getSingleClinicIdForDispatchCalendar(list, fallbackScope = {}) {
  const fromList = Number(list?.clinica_id || 0);
  if (Number.isInteger(fromList) && fromList > 0) return fromList;
  const listClinicIds = Array.isArray(list?.clinic_ids)
    ? list.clinic_ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  if (listClinicIds.length === 1) return listClinicIds[0];
  const scopeClinicIds = Array.isArray(fallbackScope?.clinicIds)
    ? fallbackScope.clinicIds.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
    : [];
  return scopeClinicIds.length === 1 ? scopeClinicIds[0] : null;
}

async function hydrateDispatchBusinessHoursForList(list, scope = {}, businessHours = null) {
  const normalized = normalizeBusinessHours(businessHours || {});
  if (normalized.allowed_weekdays?.length || !ClinicaHorario) return normalized;
  const clinicId = getSingleClinicIdForDispatchCalendar(list, scope);
  if (!clinicId) return normalized;
  const rows = await ClinicaHorario.findAll({
    attributes: ['dia_semana'],
    where: {
      clinica_id: clinicId,
      activo: true,
    },
    raw: true,
  }).catch(() => []);
  const allowedWeekdays = normalizeAllowedWeekdays(rows.map((row) => row.dia_semana));
  return allowedWeekdays.length ? { ...normalized, allowed_weekdays: allowedWeekdays } : normalized;
}

async function loadClinicForTemplateVariables(clinicId) {
  const safeClinicId = Number(clinicId || 0);
  if (!safeClinicId || !Clinica) return null;
  const clinic = await Clinica.findByPk(safeClinicId, { raw: true });
  if (!clinic) return null;
  const links = await resolveClinicGoogleLocalLinks(clinic);
  return mergeClinicLinksIntoContext(clinic, links);
}

async function getWhatsappAccountQualityForList(list, scope = {}) {
  const clinicId = getClinicIdForList(list, scope);
  if (!clinicId || !ClinicMetaAsset) {
    return {
      clinic_id: clinicId,
      quality_rating: null,
      messaging_limit: null,
      messaging_limit_count: null,
      can_send_api: null,
    };
  }

  let clinicConfig = null;
  try {
    clinicConfig = await whatsappService.getClinicConfig(clinicId);
  } catch (_) {
    clinicConfig = null;
  }

  const where = {
    assetType: 'whatsapp_phone_number',
    isActive: true,
    [Op.or]: [
      { clinicaId: clinicId },
      ...(clinicConfig?.phoneNumberId ? [{ phoneNumberId: clinicConfig.phoneNumberId }] : []),
      ...(clinicConfig?.wabaId ? [{ wabaId: clinicConfig.wabaId }] : []),
    ],
  };
  const asset = await ClinicMetaAsset.findOne({ where, order: [['updatedAt', 'DESC']] });
  const payment = whatsappPaymentStatusService.derivePaymentSnapshot(asset?.additionalData || {});
  return {
    clinic_id: clinicId,
    phone_number_id: clinicConfig?.phoneNumberId || asset?.phoneNumberId || null,
    waba_id: clinicConfig?.wabaId || asset?.wabaId || null,
    quality_rating: asset?.quality_rating || null,
    messaging_limit: asset?.messaging_limit || null,
    messaging_limit_count: parseMessagingLimit(asset?.messaging_limit),
    can_send_api: asset?.can_send_api ?? asset?.additionalData?.coexistence?.can_send_api ?? null,
    payment_status: payment.status,
    payment_missing: payment.missing,
    payment_last_success_at: payment.last_success_at,
  };
}

async function refreshListCounters(listId, transaction = null) {
  const items = await MarketingPatientListItem.findAll({
    where: { list_id: listId },
    transaction,
  });
  const counters = computeCounters(items.map((item) => item.get({ plain: true })));
  await MarketingPatientList.update(
    { counters },
    { where: { id: listId }, transaction }
  );
  return counters;
}

function getMarketingQualitySnapshot({ sent = 0, optOut = 0, spamReports = 0 } = {}) {
  const safeSent = Number(sent || 0);
  const optOutRate = safeSent > 0 ? Number(optOut || 0) / safeSent : 0;
  const spamRate = safeSent > 0 ? Number(spamReports || 0) / safeSent : 0;
  let label = 'sin_datos';
  let severity = 'muted';
  if (safeSent > 0) {
    if (spamRate > 0.01) {
      label = 'spam';
      severity = 'danger';
    } else if (optOutRate > 0.03) {
      label = 'mala';
      severity = 'danger';
    } else if (optOutRate > 0.01) {
      label = 'normal';
      severity = 'warning';
    } else {
      label = 'buena';
      severity = 'success';
    }
  }
  return {
    label,
    severity,
    opt_out_rate: optOutRate,
    spam_rate: spamRate,
    spam_reports: Number(spamReports || 0),
    spam_reports_supported: false,
  };
}

function getDispatchProgress(list, counters = null, accountQuality = null) {
  const config = getDispatchConfig(list);
  const currentCounters = counters || list?.counters || {};
  const sent = Number(currentCounters.sent || 0);
  const ready = Number(currentCounters.ready || currentCounters.selected || 0);
  const totalToSend = Math.max(sent, ready);
  const read = Number(currentCounters.read || 0);
  const optOut = Number(currentCounters.opt_out || currentCounters.exclusion_reasons?.opt_out || 0);
  const readRate = sent > 0 ? read / sent : null;
  const optOutRate = sent > 0 ? optOut / sent : null;
  const quality = getMarketingQualitySnapshot({ sent, optOut, spamReports: Number(config.spam_reports || 0) });
  const status = config.status || list?.status || 'draft';
  const replied = Number(currentCounters.replied || 0);
  const pendingRepliesFallback = Math.max(0, sent - replied);
  const completedAt = normalizeText(config.completed_at || '');
  const completedBannerExpiresAt = normalizeText(config.completed_banner_expires_at || '')
    || (String(status).toLowerCase() === 'completed' ? getDispatchCompletionExpiryIso(completedAt) : null);
  const reviewPendingReplies = Number.isFinite(Number(config.review_pending_replies))
    ? Number(config.review_pending_replies)
    : pendingRepliesFallback;
  const reviewPendingReminders = Number.isFinite(Number(config.review_pending_reminders))
    ? Number(config.review_pending_reminders)
    : reviewPendingReplies;
  return {
    ...config,
    status,
    job_id: config.job_id || null,
    sent,
    delivered: Number(currentCounters.delivered || 0),
    read,
    replied,
    failed: Number(currentCounters.failed || 0),
    opt_out: optOut,
    ready,
    total_to_send: totalToSend,
    progress_percent: totalToSend > 0 ? Math.min(100, Math.round((sent / totalToSend) * 100)) : 0,
    read_rate: readRate,
    opt_out_rate: optOutRate,
    spam_rate: quality.spam_rate,
    quality_label: quality.label,
    quality_severity: quality.severity,
    spam_reports_supported: false,
    paused_reason: config.paused_reason || null,
    cancel_requested: config.cancel_requested === true,
    next_allowed_at: config.next_allowed_at || null,
    completed_at: completedAt || null,
    completed_banner_expires_at: completedBannerExpiresAt,
    review_pending_replies: reviewPendingReplies,
    review_pending_reminders: reviewPendingReminders,
    account: accountQuality || null,
    limits_warning: accountQuality?.messaging_limit_count && ready > accountQuality.messaging_limit_count
      ? `WhatsApp, por la calidad de tu cuenta de momento solo te deja enviar ${accountQuality.messaging_limit_count} mensajes en 24h. Este límite puede aumentar si mantienes buena puntuación.`
      : null,
  };
}

function buildMissingVariablesSummary({ template, items, list, clinic }) {
  const contract = getTemplateVariableContract(template);
  if (!contract.length) return [];
  const readyItems = (items || [])
    .map((item) => (item?.get ? item.get({ plain: true }) : item))
    .filter((item) => item.status === 'ready' && item.selected !== false);
  if (!readyItems.length) return [];

  return contract
    .map((variable) => {
      const missingItems = readyItems.filter((item) => !resolveVariableValue(variable.name, item, list, clinic));
      return {
        variable: variable.name,
        token: `{{${variable.name}}}`,
        missing_count: missingItems.length,
        total_ready: readyItems.length,
        sample_item_ids: missingItems.slice(0, 5).map((item) => item.id).filter(Boolean),
      };
    })
    .filter((item) => item.missing_count > 0);
}

function formatMissingVariablesMessage(summary) {
  const first = summary?.[0];
  if (!first) return 'La plantilla usa variables que no existen para todos los contactos.';
  const suffix = summary.length > 1
    ? ` Hay ${summary.length - 1} variable(s) más con datos incompletos.`
    : '';
  return `${first.missing_count} contactos no tienen la variable ${first.token}. No puedes enviar esta plantilla. Edita tu lista o elimina la variable de la plantilla y espera hasta que se apruebe.${suffix}`;
}

async function resolveTemplateParamValue({ variable, item, list, clinic }) {
  const rawValue = resolveVariableValue(variable.name, item, list, clinic) || variable.example || ' ';
  const tracking = getListLinkTrackingConfig(list);
  if (!tracking.enabled || !isHttpUrl(rawValue)) {
    return rawValue;
  }
  const link = await createTrackedLinkForVariable({
    list,
    item,
    variableKey: variable.name,
    originalUrl: rawValue,
    domain: tracking.domain,
  });
  return link ? buildTrackingUrl(link) : rawValue;
}

async function buildTemplateParams({ template, item, list, clinic }) {
  const contract = getTemplateVariableContract(template);
  if (!contract.length) return [];
  const params = [];
  for (const variable of contract) {
    params.push(await resolveTemplateParamValue({ variable, item, list, clinic }));
  }
  return params;
}

function isHttpsUrl(value) {
  try {
    const parsed = new URL(String(value || '').trim());
    return parsed.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function resolveReviewTeamPhotoUrl(list, overrideValue = null) {
  const criteria = asPlainObject(list?.criteria);
  return normalizeText(
    overrideValue
    || criteria.review_team_photo_url
    || criteria.reviewTeamPhotoUrl
    || ''
  );
}

function resolveReviewTeamPhotoOverlayColor(list, overrideValue = null) {
  const criteria = asPlainObject(list?.criteria);
  return publicMediaPersonalizationService.normalizeHexColor(
    overrideValue
    || criteria.review_team_photo_overlay_color
    || criteria.reviewTeamPhotoOverlayColor
    || publicMediaPersonalizationService.DEFAULT_OVERLAY_COLOR
  );
}

function resolveReviewTeamPhotoPatientName(item, list, clinic) {
  const raw = resolveVariableValue('nombre_paciente', item || {}, list, clinic)
    || resolveVariableValue('nombre', item || {}, list, clinic)
    || item?.name
    || '';
  const cleaned = toTitleCaseName(raw).replace(/\s+/g, ' ').trim();
  return publicMediaPersonalizationService.normalizePatientDisplayName(
    cleaned.split(' ').filter(Boolean).slice(0, 1).join(' ') || 'Paciente'
  );
}

async function resolveReviewHeaderPhotoUrl({
  list = null,
  item = null,
  clinic = null,
  clinicId = null,
  groupId = null,
  reviewTeamPhotoUrl = null,
  reviewTeamPhotoOverlayColor = null,
  ownerType = 'review_request',
  ownerId = null,
  userId = null,
} = {}) {
  const photoUrl = resolveReviewTeamPhotoUrl(list, reviewTeamPhotoUrl);
  if (!isHttpsUrl(photoUrl)) {
    const error = new Error('review_team_photo_https_url_required');
    error.status = 409;
    throw error;
  }

  try {
    const personalized = await publicMediaPersonalizationService.buildPersonalizedReviewTeamPhoto({
      sourceUrl: photoUrl,
      patientName: resolveReviewTeamPhotoPatientName(item, list, clinic),
      overlayColor: resolveReviewTeamPhotoOverlayColor(list, reviewTeamPhotoOverlayColor),
      clinicId,
      groupId,
      ownerType,
      ownerId,
      userId,
    });
    return personalized.url || photoUrl;
  } catch (error) {
    if (
      ['review_team_photo_must_be_public_media', 'review_team_photo_url_invalid', 'review_team_photo_too_large', 'review_team_photo_output_too_large'].includes(error?.message)
      || Number(error?.status || 0) === 413
    ) {
      throw error;
    }
    console.warn('[marketing-bulk-sends] No se pudo personalizar foto de reseñas; se bloqueará el envío para evitar foto sin nombre', {
      list_id: list?.id || null,
      item_id: item?.id || null,
      error: error?.message || error,
    });
    const wrapped = new Error('review_team_photo_personalization_failed');
    wrapped.status = Number(error?.status || 0) || 502;
    wrapped.cause = error;
    throw wrapped;
  }
}

async function buildTemplateComponentsForSend({
  template,
  params = [],
  list = null,
  item = null,
  clinic = null,
  clinicId = null,
  groupId = null,
  reviewTeamPhotoUrl = null,
  reviewTeamPhotoOverlayColor = null,
  ownerType = 'review_request',
  ownerId = null,
  userId = null,
}) {
  const components = [];
  const bodyParams = Array.isArray(params) ? params : [];
  if (templateHasImageHeader(template)) {
    const photoUrl = await resolveReviewHeaderPhotoUrl({
      list,
      item,
      clinic,
      clinicId,
      groupId,
      reviewTeamPhotoUrl,
      reviewTeamPhotoOverlayColor,
      ownerType,
      ownerId,
      userId,
    });
    components.push({
      type: 'header',
      parameters: [
        {
          type: 'image',
          image: { link: photoUrl },
        },
      ],
    });
  }
  if (bodyParams.length) {
    components.push({
      type: 'body',
      parameters: bodyParams.map((value) => ({ type: 'text', text: String(value ?? '') })),
    });
  }
  return components.length ? components : null;
}

async function renderTemplatePreview({ template, item, list, clinic }) {
  const plain = template?.get ? template.get({ plain: true }) : template;
  const body = extractBodyText(plain?.components);
  if (!body) return `Plantilla WhatsApp: ${plain?.name || 'sin nombre'}`;

  const contract = getTemplateVariableContract(template);
  const byIndex = new Map();
  for (const variable of contract) {
    byIndex.set(Number(variable.index), await resolveTemplateParamValue({ variable, item, list, clinic }));
  }

  return body.replace(/{{\s*(\d+)\s*}}/g, (_match, rawIndex) => {
    const value = byIndex.get(Number(rawIndex));
    return value || '...';
  });
}

async function prepareCampaign(scope, campaignId, body = {}, userId = null) {
  const list = await MarketingPatientList.findByPk(campaignId);
  ensureScopeAccess(list, scope);
  const dispatchContext = normalizeDispatchContext(body.dispatch_context || body.dispatch_mode);
  const isWelcomeDispatch = dispatchContext === 'welcome' || body.welcome === true;
  const dispatchFilter = buildDispatchFilterFromBody(body, isWelcomeDispatch ? 'welcome' : null);
  const welcomeMessage = list.criteria?.welcome_message && typeof list.criteria.welcome_message === 'object'
    ? list.criteria.welcome_message
    : {};
  const channels = Array.isArray(list.criteria?.channels)
    ? list.criteria.channels
    : normalizeChannels(list.action_mode || list.channel);
  const needsWhatsappTemplate = channels.includes('whatsapp');
  const selectedTemplateId = isWelcomeDispatch
    ? (body.whatsapp_template_id || body.template_id || welcomeMessage.template_id)
    : (body.whatsapp_template_id
      || body.template_id
      || list.criteria?.whatsapp_template_id
      || list.template_snapshot?.id
      || list.template_id);
  const requestedTemplateUsage = normalizeTemplateUsage(body.template_usage || list.criteria?.template_usage || 'promocion');
  const reviewTeamPhotoUrlForSelection = normalizeText(body.review_team_photo_url || body.reviewTeamPhotoUrl || list.criteria?.review_team_photo_url || '') || null;
  let template = null;
  if (isReviewTemplateUsage(requestedTemplateUsage)) {
    template = await findApprovedReviewWhatsappTemplate(scope, selectedTemplateId || null, {
      preferPhoto: isHttpsUrl(reviewTeamPhotoUrlForSelection),
    });
  } else {
    template = selectedTemplateId
      ? await resolveWhatsappTemplate(selectedTemplateId, scope)
      : null;
  }
  const snapshot = buildTemplateSnapshot(template);
  const requestedTemplateCommercial = body.template_commercial === true
    || (body.template_commercial !== false && (list.criteria?.template_commercial === true || isCommercialTemplateUsage(requestedTemplateUsage)));
  const templateUsage = resolveTemplateUsageFromMetaCategory(template, requestedTemplateUsage);
  const templateCommercial = resolveTemplateCommercialFromMetaCategory(template, requestedTemplateCommercial);
  const isReviewRequest = isReviewRequestList(list) || isReviewRequestBody(body) || isReviewTemplateUsage(templateUsage);
  const reviewSource = normalizeReviewRequestSource(body.review_source || body.reviewRequestSource || list.criteria?.review_source);
  const reviewTreatmentIds = parseReviewTreatmentIds({
    review_treatment_ids: body.review_treatment_ids || body.reviewTreatmentIds || list.criteria?.review_treatment_ids,
    review_treatment_id: body.review_treatment_id || body.reviewTreatmentId || list.criteria?.review_treatment_id,
  });
  const effectiveScope = isReviewRequest
    ? applyReviewClinicFilter(scope, {
        review_group_clinic_ids: body.review_group_clinic_ids || body.reviewGroupClinicIds || list.criteria?.review_group_clinic_ids,
      })
    : scope;
  const reviewThreshold = 5;
  const autoSendWhenApproved = body.auto_send_when_template_approved === true || body.auto_send_when_approved === true;
  const approved = needsWhatsappTemplate
    ? !!template && String(template.status || '').toUpperCase() === 'APPROVED'
    : true;
  let items = await MarketingPatientListItem.findAll({ where: { list_id: list.id } });
  const listCounters = computeCounters(items.map((item) => (item?.get ? item.get({ plain: true }) : item)));
  const dispatchItems = dispatchFilter
    ? items.filter((item) => itemMatchesDispatchFilter(item, dispatchFilter))
    : items;
  const activeSegmentId = body.active_segment_id !== undefined || body.segment_id !== undefined
    ? normalizeText(body.active_segment_id || body.segment_id) || null
    : (isWelcomeDispatch ? null : (normalizeText(list.criteria?.active_segment_id) || null));
  let selectedItems = await applyActiveSegmentSelection(list, dispatchItems, activeSegmentId);
  if (isReviewRequest && effectiveScope?.scope === 'group') {
    const clinicStatuses = await buildReviewClinicStatuses(effectiveScope, {
      review_source: reviewSource,
      review_treatment_ids: reviewTreatmentIds,
      review_treatment_moment: body.review_treatment_moment || body.reviewTreatmentMoment || list.criteria?.review_treatment_moment || null,
    });
    const readinessByClinic = new Map(
      clinicStatuses
        .map((status) => [Number(status.clinic_id || status.clinicId || 0), status])
        .filter(([clinicId]) => clinicId)
    );
    const readyItems = [];
    for (const item of selectedItems) {
      const plain = item?.get ? item.get({ plain: true }) : item;
      const exclusionPatch = buildReviewReadinessExclusion(plain, readinessByClinic);
      if (exclusionPatch && item?.update) {
        await item.update(exclusionPatch);
      } else if (!exclusionPatch) {
        readyItems.push(item);
      }
    }
    selectedItems = readyItems;
  }
  const nextCriteriaBase = annotateSegmentCounts({
    ...(list.criteria || {}),
    active_segment_id: activeSegmentId,
  }, selectedItems);
  const clinicId = getClinicIdForList(list, scope);
  const clinic = await loadClinicForTemplateVariables(clinicId);
  if (needsWhatsappTemplate && template) {
    const missingVariables = buildMissingVariablesSummary({ template, items: selectedItems, list, clinic });
    if (missingVariables.length) {
      const err = new Error(formatMissingVariablesMessage(missingVariables));
      err.status = 409;
      err.details = { missing_variables: missingVariables };
      throw err;
    }
  }
  const counters = computeCounters(selectedItems);
  const nextGates = {
    ...(list.safety_gates || {}),
    frozen_audience: counters.ready > 0,
    opt_out: !!(body.consent_acknowledged ?? list.criteria?.consent_acknowledged),
    approved_template: approved,
    audit: true,
    capping: true,
    cancelable_queue: true,
  };
  const dispatchConfig = await getDispatchConfigForList(list, body.dispatch_config || body.dispatchConfig || null);
  const effectiveDispatchContext = isWelcomeDispatch
    ? 'welcome'
    : (isReviewRequest ? 'review_request' : normalizeDispatchContext(body.dispatch_context || body.dispatch_mode || dispatchConfig.context));
  const dispatchLabel = isWelcomeDispatch
    ? 'Bienvenida WhatsApp'
    : (isReviewRequest ? (dispatchConfig.label || 'Solicitud de reseñas') : (dispatchConfig.label || null));

  const dispatchSnapshot = buildTemplateSnapshot(template);
  const listPatch = {
    status: 'prepared',
    // `template_id` points to legacy MessageTemplates. WABA templates live in
    // WhatsappTemplates, so keep the approved WABA reference in criteria/snapshot.
    template_id: null,
    counters: isWelcomeDispatch ? listCounters : counters,
    safety_gates: nextGates,
    prepared_at: new Date(),
    criteria: {
      ...nextCriteriaBase,
      campaign_name: normalizeText(body.campaign_name || list.criteria?.campaign_name || list.name),
      list_name: normalizeText(body.list_name || list.criteria?.list_name || list.name),
      whatsapp_template_id: isWelcomeDispatch ? (list.criteria?.whatsapp_template_id || null) : (template?.id || null),
      template_usage: templateUsage,
      template_commercial: templateCommercial,
      opt_out_text: templateCommercial ? normalizeText(body.opt_out_text || list.criteria?.opt_out_text) : null,
      consent_acknowledged: !!(body.consent_acknowledged ?? list.criteria?.consent_acknowledged),
      review_request: isReviewRequest,
      review_source: isReviewRequest ? reviewSource : null,
      review_treatment_id: isReviewRequest ? (reviewTreatmentIds[0] || null) : null,
      review_treatment_ids: isReviewRequest ? reviewTreatmentIds : [],
      review_treatment_moment: isReviewRequest ? normalizeText(body.review_treatment_moment || body.reviewTreatmentMoment || list.criteria?.review_treatment_moment || '') || null : null,
      excluded_review_patient_ids: isReviewRequest
        ? parseReviewExcludedPatientIds({
          excluded_review_patient_ids: body.excluded_review_patient_ids
            || body.excludedReviewPatientIds
            || list.criteria?.excluded_review_patient_ids,
        })
        : [],
      review_exclusion_rules: isReviewRequest
        ? parseReviewExclusionRules(body.review_exclusion_rules !== undefined || body.reviewExclusionRules !== undefined
          ? body
          : { review_exclusion_rules: list.criteria?.review_exclusion_rules })
        : null,
      review_delay: isReviewRequest ? normalizeText(body.review_delay || body.reviewDelay || list.criteria?.review_delay || '24h') : null,
      review_threshold: isReviewRequest ? reviewThreshold : null,
      review_gift_enabled: isReviewRequest
        ? (body.review_gift_enabled === true
          || String(body.review_gift_enabled ?? list.criteria?.review_gift_enabled ?? '').toLowerCase() === 'true')
        : false,
      review_gift_description: isReviewRequest
        ? normalizeText(body.review_gift_description || body.reviewGiftDescription || list.criteria?.review_gift_description || '') || null
        : null,
      review_display_clinic_name: isReviewRequest
        ? normalizeText(body.review_display_clinic_name || body.reviewDisplayClinicName || list.criteria?.review_display_clinic_name || '') || null
        : null,
      review_sender_name: isReviewRequest
        ? normalizeText(body.review_sender_name || body.reviewSenderName || list.criteria?.review_sender_name || '') || null
        : null,
      review_team_photo_url: isReviewRequest
        ? normalizeText(body.review_team_photo_url || body.reviewTeamPhotoUrl || list.criteria?.review_team_photo_url || '') || null
        : null,
      review_team_photo_overlay_color: isReviewRequest
        ? publicMediaPersonalizationService.normalizeHexColor(
          body.review_team_photo_overlay_color
          || body.reviewTeamPhotoOverlayColor
          || list.criteria?.review_team_photo_overlay_color
        )
        : null,
      review_team_members_text: isReviewRequest
        ? normalizeText(body.review_team_members_text || body.reviewTeamMembersText || list.criteria?.review_team_members_text || '') || null
        : null,
      review_automation_enabled: false,
      link_tracking: buildLinkTrackingCriteria(body, list.criteria || {}),
      schedule_mode: body.schedule_mode || 'now',
      scheduled_at: body.scheduled_at || null,
      dispatch_config: dispatchConfig,
      dispatch: {
        ...dispatchConfig,
        status: !approved && autoSendWhenApproved ? 'waiting_template_approval' : 'prepared',
        context: effectiveDispatchContext,
        label: dispatchLabel,
        filter: dispatchFilter,
        whatsapp_template_id: template?.id || null,
        template_snapshot: dispatchSnapshot,
        job_id: null,
        started_at: null,
        completed_at: null,
        last_batch_index: 0,
        last_batch_started_at: null,
        last_batch_completed_at: null,
        next_allowed_at: null,
        cancel_requested: false,
        batch_size: dispatchConfig.batch_size,
        delay_ms: dispatchConfig.delay_ms,
        min_read_rate: dispatchConfig.min_read_rate,
        read_rate_grace_ms: dispatchConfig.read_rate_grace_ms,
        max_opt_out_rate: dispatchConfig.max_opt_out_rate,
        business_hours: dispatchConfig.business_hours,
        prepared_at: new Date().toISOString(),
        auto_send_when_template_approved: autoSendWhenApproved,
      },
      auto_send_when_template_approved: autoSendWhenApproved,
    },
  };
  if (!isWelcomeDispatch) {
    listPatch.template_snapshot = snapshot;
  }
  await list.update(listPatch);

  await MarketingPatientContactEvent.create({
    list_id: list.id,
    event_type: 'mass_campaign_prepared',
    channel: list.channel,
    payload: {
      user_id: userId || null,
      template_id: template?.id || null,
      context: isWelcomeDispatch ? 'welcome' : 'campaign',
      dispatch_context: effectiveDispatchContext || (isWelcomeDispatch ? 'welcome' : 'campaign'),
      filter: dispatchFilter,
      safety_gates: nextGates,
      blocked_gates: getBlockedGates(nextGates),
    },
    occurred_at: new Date(),
  });

  const reloaded = await MarketingPatientList.findByPk(list.id);
  const accountQuality = await getWhatsappAccountQualityForList(reloaded, scope);
  return {
    success: true,
    campaign: serializeCampaign(reloaded, { itemsPreview: items.slice(0, 5) }),
    dispatch_blocked: getBlockedGates(nextGates).length > 0,
    blocked_gates: getBlockedGates(nextGates),
    dispatch: getDispatchProgress(reloaded, counters, accountQuality),
    message: needsWhatsappTemplate && !template
      ? 'Selecciona una plantilla WhatsApp aprobada antes de preparar esta campaña.'
      : approved
      ? 'Campaña preparada. Puedes enviarla ahora o programarla respetando capping y horario permitido.'
      : 'La plantilla todavía no está aprobada. Meta suele aprobarla en unos 15 minutos.',
  };
}

async function sendTest(scope, campaignId, body = {}) {
  const list = await MarketingPatientList.findByPk(campaignId);
  ensureScopeAccess(list, scope);
  let listCriteria = asPlainObject(list?.criteria);
  const templateUsage = normalizeTemplateUsage(body.template_usage || listCriteria.template_usage || 'promocion');
  if (isReviewTemplateUsage(templateUsage)) {
    const nextCriteria = { ...listCriteria };
    if (body.review_display_clinic_name !== undefined || body.reviewDisplayClinicName !== undefined) {
      nextCriteria.review_display_clinic_name = normalizeText(body.review_display_clinic_name || body.reviewDisplayClinicName || '') || null;
    }
    if (body.review_sender_name !== undefined || body.reviewSenderName !== undefined) {
      nextCriteria.review_sender_name = normalizeText(body.review_sender_name || body.reviewSenderName || '') || null;
    }
    if (body.review_team_photo_url !== undefined || body.reviewTeamPhotoUrl !== undefined) {
      nextCriteria.review_team_photo_url = normalizeText(body.review_team_photo_url || body.reviewTeamPhotoUrl || '') || null;
    }
    if (body.review_team_photo_overlay_color !== undefined || body.reviewTeamPhotoOverlayColor !== undefined) {
      nextCriteria.review_team_photo_overlay_color = publicMediaPersonalizationService.normalizeHexColor(
        body.review_team_photo_overlay_color || body.reviewTeamPhotoOverlayColor
      );
    }
    if (body.review_team_members_text !== undefined || body.reviewTeamMembersText !== undefined) {
      nextCriteria.review_team_members_text = normalizeText(body.review_team_members_text || body.reviewTeamMembersText || '') || null;
    }
    if (JSON.stringify(nextCriteria) !== JSON.stringify(listCriteria)) {
      await list.update({ criteria: nextCriteria });
      listCriteria = nextCriteria;
    }
  }
  const selectedTemplateId =
    body.whatsapp_template_id
    || body.template_id
    || listCriteria.whatsapp_template_id
    || list.template_snapshot?.id
    || list.template_id;
  const reviewTeamPhotoUrlForSelection = normalizeText(body.review_team_photo_url || body.reviewTeamPhotoUrl || listCriteria.review_team_photo_url || '') || null;
  const reviewTeamPhotoOverlayColorForSelection = publicMediaPersonalizationService.normalizeHexColor(
    body.review_team_photo_overlay_color
    || body.reviewTeamPhotoOverlayColor
    || listCriteria.review_team_photo_overlay_color
  );
  let template = isReviewTemplateUsage(templateUsage)
    ? await findApprovedReviewWhatsappTemplate(scope, selectedTemplateId || null, {
      preferPhoto: isHttpsUrl(reviewTeamPhotoUrlForSelection),
    })
    : await resolveWhatsappTemplate(selectedTemplateId, scope);
  if (!template) {
    const err = new Error('Selecciona una plantilla WhatsApp aprobada para enviar una prueba real.');
    err.status = 400;
    throw err;
  }
  if (String(template.status || '').toUpperCase() !== 'APPROVED') {
    const err = new Error('La plantilla no está aprobada. No se puede enviar prueba real hasta que Meta la apruebe.');
    err.status = 409;
    throw err;
  }
  if (isReviewTemplateUsage(templateUsage) && isHttpsUrl(reviewTeamPhotoUrlForSelection) && !templateHasImageHeader(template)) {
    const err = new Error('La foto está configurada, pero la plantilla de reseñas con imagen todavía no está aprobada por Meta. Cuando se apruebe, la prueba se enviará con foto.');
    err.status = 409;
    throw err;
  }
  const item = body.item_id
    ? await MarketingPatientListItem.findOne({ where: { id: body.item_id, list_id: list.id } })
    : await MarketingPatientListItem.findOne({ where: { list_id: list.id, status: 'ready' }, order: [['id', 'ASC']] });
  if (!item) {
    const err = new Error('La campaña no tiene contactos listos para generar variables de prueba.');
    err.status = 400;
    throw err;
  }
  const targetPhone = whatsappService.normalizePhoneNumber(body.to || body.phone || '');
  if (!targetPhone) {
    const err = new Error('Número de prueba no válido.');
    err.status = 400;
    throw err;
  }
  const plainItem = item.get({ plain: true });
  const clinicId = Number(body.clinic_id || body.clinica_id || plainItem.clinica_id || getClinicIdForList(list, scope) || 0);
  if (!clinicId) {
    const err = new Error('La campaña necesita una clínica concreta para enviar WhatsApp.');
    err.status = 400;
    throw err;
  }
  const clinic = await loadClinicForTemplateVariables(clinicId);
  const clinicConfig = await whatsappService.getClinicConfig(clinicId);
  if (!clinicConfig?.phoneNumberId || !clinicConfig?.accessToken) {
    const err = new Error('whatsapp_config_missing_for_scope');
    err.status = 409;
    throw err;
  }
  clinicConfig.clinicId = clinicId;
  template = await resolveWhatsappTemplateForClinic(template, clinicId, clinicConfig);
  if (!template) {
    const err = new Error('No hay plantilla WhatsApp aprobada compatible con la clínica del contacto de prueba.');
    err.status = 409;
    throw err;
  }
  const missingVariables = buildMissingVariablesSummary({ template, items: [plainItem], list, clinic });
  if (missingVariables.length) {
    const err = new Error(formatMissingVariablesMessage(missingVariables));
    err.status = 409;
    err.details = { missing_variables: missingVariables };
    throw err;
  }
  assertTestSendCooldown({ clinicId, targetPhone });
  const params = await buildTemplateParams({ template, item: plainItem, list, clinic });
  const templateComponents = await buildTemplateComponentsForSend({
    template,
    params,
    list,
    item: plainItem,
    clinic,
    clinicId,
    reviewTeamPhotoUrl: reviewTeamPhotoUrlForSelection,
    reviewTeamPhotoOverlayColor: reviewTeamPhotoOverlayColorForSelection,
    ownerType: 'review_request_test',
    ownerId: item.id,
  });
  const previewText = await renderTemplatePreview({ template, item: plainItem, list, clinic });
  const templateCommercial = body.template_commercial === true
    || (body.template_commercial !== false && (listCriteria.template_commercial === true || isCommercialTemplateUsage(templateUsage)));
  const conversation = await findCanonicalWhatsappConversation({
    clinicId,
    contactId: targetPhone,
    createIfMissing: true,
    lastMessageAt: new Date(),
  });
  if (!conversation || !Message) {
    const err = new Error('No se pudo crear la conversación de seguimiento para la prueba WhatsApp.');
    err.status = 500;
    throw err;
  }

  const appMessage = await Message.create({
    conversation_id: conversation.id,
    sender_id: null,
    direction: 'outbound',
    content: previewText,
    message_type: 'template',
    status: 'pending',
    metadata: {
      kind: 'mass_campaign_test',
      source: 'marketing_bulk_sends',
      list_id: list.id,
      item_id: item.id,
      objective_id: OBJECTIVE_ID,
      template_usage: templateUsage,
      template_commercial: templateCommercial,
      template_category: template.category || template.catalog?.category || null,
      template_id: template.id,
      template_name: template.name,
      template_language: template.language || 'es',
      template_params: params,
      template_components: templateComponents,
      review_display_clinic_name: listCriteria.review_display_clinic_name || null,
      review_sender_name: listCriteria.review_sender_name || null,
      review_team_photo_url: listCriteria.review_team_photo_url || null,
      review_team_photo_overlay_color: listCriteria.review_team_photo_overlay_color || null,
      review_team_members_text: listCriteria.review_team_members_text || null,
      recipient: targetPhone,
      phoneNumberId: clinicConfig.phoneNumberId || null,
      wabaId: clinicConfig.wabaId || null,
    },
    sent_at: new Date(),
  });
  emitQuickChatMessageCreated(conversation, appMessage);

  let response;
  try {
    response = await whatsappService.sendMessage({
      to: targetPhone,
      useTemplate: true,
      templateName: template.name,
      templateLanguage: template.language || 'es',
      templateParams: params,
      templateComponents,
      clinicConfig,
    });
  } catch (sendErr) {
    const providerError = sendErr?.response?.data || sendErr?.message || 'whatsapp_send_failed';
    await appMessage.update({
      status: 'failed',
      metadata: {
        ...(appMessage.metadata || {}),
        error: providerError,
      },
    });
    emitQuickChatMessageUpdated(conversation, appMessage);
    await MarketingPatientContactEvent.create({
      list_id: list.id,
      item_id: item.id,
      event_type: 'mass_campaign_test_failed',
      channel: 'whatsapp',
      payload: {
        to: targetPhone,
        template_id: template.id,
        template_name: template.name,
        app_message_id: appMessage.id,
        conversation_id: conversation.id,
        error: providerError,
      },
      occurred_at: new Date(),
    });
    await whatsappConnectionStatusService.markDisconnectedAfterProviderError({
      error: providerError,
      clinicId,
      phoneId: clinicConfig.phoneNumberId || null,
      wabaId: clinicConfig.wabaId || null,
      messageId: appMessage.id,
      recipient: targetPhone,
      source: 'mass_campaign_test',
    }).catch(() => null);
    throw sendErr;
  }

  const providerMessageId = response?.messages?.[0]?.id || null;
  await appMessage.update({
    status: 'sent',
    metadata: {
      ...(appMessage.metadata || {}),
      wa_response: response || null,
      wamid: providerMessageId,
      phoneId: clinicConfig.phoneNumberId || null,
    },
    sent_at: new Date(),
  });
  emitQuickChatMessageUpdated(conversation, appMessage);
  await whatsappConnectionStatusService.clearDisconnectedAfterSuccess({
    clinicId,
    phoneId: clinicConfig.phoneNumberId || null,
    wabaId: clinicConfig.wabaId || null,
    messageId: appMessage.id,
    source: 'mass_campaign_test',
  }).catch(() => null);
  await conversation.update({ last_message_at: new Date() });
  await MarketingPatientContactEvent.create({
    list_id: list.id,
    item_id: item.id,
    event_type: 'mass_campaign_test_sent',
    channel: 'whatsapp',
    payload: {
      to: targetPhone,
      template_id: template.id,
      template_name: template.name,
      message_id: providerMessageId,
      provider_message_id: providerMessageId,
      app_message_id: appMessage.id,
      conversation_id: conversation.id,
    },
    occurred_at: new Date(),
  });
  return {
    success: true,
    to: targetPhone,
    message_id: providerMessageId,
    provider_message_id: providerMessageId,
    app_message_id: appMessage.id,
    conversation_id: conversation.id,
  };
}

async function listRecipients(scope, campaignId, query = {}) {
  const list = await MarketingPatientList.findByPk(campaignId);
  ensureScopeAccess(list, scope);
  await reconcileListMessageState(list, scope);
  const reloaded = await MarketingPatientList.findByPk(list.id);
  const page = Math.max(1, Number.parseInt(query.page || '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(10, Number.parseInt(query.page_size || query.pageSize || '25', 10) || 25));
  const offset = (page - 1) * pageSize;
  const search = normalizeText(query.search || '');
  const status = normalizeText(query.status || '');
  const where = { list_id: list.id };
  if (status && status !== 'all') {
    if (status === 'excluded') {
      where.status = { [Op.like]: 'excluded%' };
    } else if (status === 'ready') {
      where.status = 'ready';
      where.selected = true;
      where[Op.or] = [{ dispatch_status: null }, { dispatch_status: 'pending' }];
    } else if (status === 'sent') {
      where.dispatch_status = { [Op.in]: ['sent', 'delivered', 'read', 'replied'] };
    } else {
      where.dispatch_status = status;
    }
  }
  if (search) {
    where[Op.or] = [
      { name: { [Op.like]: `%${search}%` } },
      { phone: { [Op.like]: `%${search}%` } },
      { email: { [Op.like]: `%${search}%` } },
      Sequelize.where(Sequelize.cast(Sequelize.col('custom_fields'), 'CHAR'), { [Op.like]: `%${search}%` }),
    ];
  }

  const { count, rows } = await MarketingPatientListItem.findAndCountAll({
    where,
    order: [['id', 'ASC']],
    limit: pageSize,
    offset,
  });
  const counters = reloaded?.counters || await refreshListCounters(list.id);
  const report = await buildListReport(list.id);
  const clickCountsByItem = new Map((report?.item_clicks || []).map((row) => [Number(row.item_id), Number(row.clicks || 0)]));
  return {
    success: true,
    page,
    page_size: pageSize,
    total: count,
    items: rows.map((row) => ({
      ...serializeItem(row),
      link_clicks: clickCountsByItem.get(Number(row.id)) || 0,
    })),
    summary: counters,
    report,
  };
}

async function updateRecipient(scope, campaignId, itemId, body = {}, userId = null) {
  const list = await MarketingPatientList.findByPk(campaignId);
  ensureScopeAccess(list, scope);
  const item = await MarketingPatientListItem.findOne({
    where: {
      id: itemId,
      list_id: list.id,
    },
  });
  if (!item) {
    const err = new Error('Contacto de la lista no encontrado');
    err.status = 404;
    throw err;
  }

  const action = normalizeKey(body.action || 'restore');
  if (action !== 'restore') {
    const err = new Error('Acción no soportada para este contacto');
    err.status = 400;
    throw err;
  }
  if (item.opt_out_at || item.exclusion_reason === 'opt_out' || item.status === 'excluded_opt_out') {
    const err = new Error('No se puede sacar de cuarentena un contacto que ha solicitado baja comercial.');
    err.status = 409;
    err.details = { reason: 'opt_out' };
    throw err;
  }
  if (!String(item.status || '').startsWith('excluded')) {
    return {
      success: true,
      action: 'unchanged',
      item: serializeItem(item),
      campaign: serializeCampaign(list),
      list: serializeCampaign(list),
    };
  }

  const previousStatus = item.status;
  const previousExclusionReason = item.exclusion_reason || null;
  await db.sequelize.transaction(async (transaction) => {
    await item.update({
      status: 'ready',
      reason: normalizeText(body.reason) || 'Contacto sacado de cuarentena manualmente.',
      exclusion_reason: null,
      selected: true,
      notes: [
        normalizeText(item.notes),
        `Sacado de cuarentena manualmente${userId ? ` por usuario ${userId}` : ''}.`,
      ].filter(Boolean).join('\n') || null,
    }, { transaction });
    const counters = await refreshListCounters(list.id, transaction);
    await MarketingPatientContactEvent.create({
      list_id: list.id,
      item_id: item.id,
      paciente_id: item.paciente_id || null,
      event_type: 'mass_campaign_recipient_restored',
      channel: list.channel,
      payload: {
        user_id: userId || null,
        previous_status: previousStatus,
        previous_exclusion_reason: previousExclusionReason,
        counters,
      },
      occurred_at: new Date(),
    }, { transaction });
  });

  const reloaded = await MarketingPatientList.findByPk(list.id);
  const updated = await MarketingPatientListItem.findByPk(item.id);
  return {
    success: true,
    action: 'restored',
    item: serializeItem(updated),
    campaign: serializeCampaign(reloaded, { itemsPreview: [updated] }),
    list: serializeCampaign(reloaded, { itemsPreview: [updated] }),
  };
}

async function getDispatchStatus(scope, campaignId) {
  const list = await MarketingPatientList.findByPk(campaignId);
  ensureScopeAccess(list, scope);
  await reconcileListMessageState(list, scope);
  const dispatch = getDispatchConfig(list);
  const filter = getDispatchItemFilter(dispatch);
  const counters = await getDispatchScopedCounters(list, filter);
  const reloaded = await MarketingPatientList.findByPk(list.id);
  const accountQuality = await getWhatsappAccountQualityForList(reloaded, scope);
  const context = normalizeDispatchContext(dispatch.context);
  const followUpCounters = context === 'review_request' && String(dispatch.status || '').toLowerCase() === 'completed'
    ? await getReviewDispatchFollowUpCounters(reloaded, filter)
    : null;
  const progress = getDispatchProgress(reloaded, counters, accountQuality);
  return {
    success: true,
    campaign: serializeCampaign(reloaded),
    dispatch: followUpCounters
      ? {
        ...progress,
        review_pending_replies: Number(followUpCounters.pending_replies || 0),
        review_pending_reminders: Number(followUpCounters.pending_reminders || 0),
      }
      : progress,
  };
}

async function reconcileBulkSendTemplateCategory(templateRow, logger = console) {
  const template = templateRow?.get ? templateRow.get({ plain: true }) : templateRow;
  const templateId = Number(template?.id || 0);
  if (!templateId) return { updated: 0 };

  const rows = await db.sequelize.query(
    `
    SELECT id
    FROM MarketingPatientLists
    WHERE objective_id = :objectiveId
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(criteria, '$.whatsapp_template_id')) AS UNSIGNED) = :templateId
    LIMIT 200
    `,
    {
      replacements: { objectiveId: OBJECTIVE_ID, templateId },
      type: QueryTypes.SELECT,
    }
  );

  const templateCategory = getTemplateCategory(template) || null;
  const templateSyncedAt = new Date().toISOString();
  let updated = 0;

  for (const row of rows) {
    const list = await MarketingPatientList.findByPk(row.id);
    if (!list) continue;
    const currentCriteria = list.criteria || {};
    const templateUsage = resolveTemplateUsageFromMetaCategory(template, currentCriteria.template_usage || 'promocion');
    const templateCommercial = resolveTemplateCommercialFromMetaCategory(
      template,
      currentCriteria.template_commercial === true || isCommercialTemplateUsage(templateUsage)
    );
    const nextDispatch = currentCriteria.dispatch && typeof currentCriteria.dispatch === 'object'
      ? {
          ...currentCriteria.dispatch,
          template_category: templateCategory,
          template_category_source: 'meta_sync',
          template_category_synced_at: templateSyncedAt,
        }
      : currentCriteria.dispatch;
    const nextCriteria = {
      ...currentCriteria,
      template_usage: templateUsage,
      template_commercial: templateCommercial,
      opt_out_text: templateCommercial ? normalizeText(currentCriteria.opt_out_text) : null,
      template_category: templateCategory,
      template_category_source: 'meta_sync',
      template_category_synced_at: templateSyncedAt,
      ...(nextDispatch ? { dispatch: nextDispatch } : {}),
    };

    try {
      await list.update({
        template_snapshot: buildTemplateSnapshot(template),
        criteria: nextCriteria,
      });
      updated += 1;
    } catch (error) {
      logger.warn?.('[marketing-bulk-sends] No se pudo reconciliar categoria de plantilla en campaña', {
        list_id: list.id,
        template_id: templateId,
        error: error?.message || error,
      });
    }
  }

  return { updated };
}

async function enqueueDispatchJob({ list, scope, nextRunAt = null, userId = null, context = null, filter = null }) {
  const job = await jobRequestsService.enqueueJobRequest({
    type: DISPATCH_JOB_TYPE,
    payload: {
      list_id: list.id,
      scope,
      context,
      filter,
    },
    priority: 'normal',
    status: nextRunAt ? 'waiting' : 'pending',
    origin: 'marketing_bulk_sends',
    requestedBy: userId || null,
    maxAttempts: 1,
    nextRunAt,
  });
  return job;
}

async function triggerDispatchJobIfReady(job, nextRunAt = null) {
  if (!job?.id || nextRunAt) return;
  try {
    const jobScheduler = require('./jobScheduler.service');
    if (typeof jobScheduler.triggerImmediate === 'function') {
      await jobScheduler.triggerImmediate(job.id);
    }
  } catch (error) {
    console.warn('[marketing-bulk-sends] No se pudo disparar el job inmediatamente:', error?.message || error);
  }
}

async function startCampaignDispatch(scope, campaignId, body = {}, actor = null) {
  const userId = getActorUserId(actor);
  const list = await MarketingPatientList.findByPk(campaignId);
  ensureScopeAccess(list, scope);
  const rawDispatchOverride = body.dispatch_config || body.dispatchConfig || null;
  const requestedContext = normalizeDispatchContext(
    body.dispatch_context
    || body.dispatch_mode
    || rawDispatchOverride?.context
    || rawDispatchOverride?.dispatch_context
    || list.criteria?.dispatch_config?.context
    || list.criteria?.dispatch?.context
    || (isReviewRequestList(list) ? 'review_request' : null)
  );
  const dispatchOverride = requestedContext
    ? mergeDispatchConfigs(rawDispatchOverride || {}, { context: requestedContext })
    : rawDispatchOverride;
  const dispatch = await getDispatchConfigForList(list, dispatchOverride);
  const context = requestedContext || normalizeDispatchContext(dispatch.context);
  const filter = buildDispatchFilterFromBody(body, context) || getDispatchItemFilter(dispatch);
  const channels = Array.isArray(list.criteria?.channels)
    ? list.criteria.channels
    : normalizeChannels(list.action_mode || list.channel);
  if (!channels.includes('whatsapp')) {
    const err = new Error('El envío real solo está conectado para WhatsApp en este MVP.');
    err.status = 409;
    throw err;
  }
  if (!['prepared', 'paused', 'cancelled', 'sending'].includes(String(list.status || '').toLowerCase())) {
    const err = new Error('Prepara la campaña antes de enviarla.');
    err.status = 409;
    throw err;
  }
  if (isBlockingQualityPause(dispatch) && !isActorGlobalAdmin(actor)) {
    const err = new Error('No se puede reanudar una campaña pausada por baja calidad. Contacta con soporte.');
    err.status = 403;
    throw err;
  }
  const blockedGates = getBlockedGates(list.safety_gates || {});
  if (blockedGates.length) {
    const err = new Error('La campaña tiene garantías pendientes antes del envío.');
    err.status = 409;
    err.details = { blocked_gates: blockedGates };
    throw err;
  }
  const welcomeMessage = list.criteria?.welcome_message && typeof list.criteria.welcome_message === 'object'
    ? list.criteria.welcome_message
    : {};
  const selectedTemplateId = body.whatsapp_template_id
    || body.template_id
    || dispatch.whatsapp_template_id
    || dispatch.template_snapshot?.id
    || (context === 'welcome' ? welcomeMessage.template_id : null)
    || list.criteria?.whatsapp_template_id
    || list.template_snapshot?.id;
  const template = await resolveWhatsappTemplate(selectedTemplateId, scope);
  if (!template || String(template.status || '').toUpperCase() !== 'APPROVED') {
    const err = new Error('La plantilla no está aprobada. Meta suele aprobarla en unos 15 minutos.');
    err.status = 409;
    throw err;
  }

  const counters = await getDispatchScopedCounters(list, filter);
  const remaining = await countDispatchRemainingItems(list.id, filter);
  if (remaining <= 0) {
    const err = new Error('No quedan contactos pendientes de envío en esta lista.');
    err.status = 409;
    throw err;
  }

  const accountQuality = await getWhatsappAccountQualityForList(list, scope);
  const scheduledAt = parseDate(body.scheduled_at || list.criteria?.scheduled_at);
  const reference = scheduledAt && scheduledAt.getTime() > Date.now() ? scheduledAt : new Date();
  const dispatchBusinessHours = await hydrateDispatchBusinessHoursForList(list, scope, dispatch.business_hours);
  const businessAllowedAt = getNextBusinessAllowedAt(reference, dispatchBusinessHours);
  const nextRunAt = businessAllowedAt.getTime() > Date.now() + 1000 ? businessAllowedAt : null;
  const baseDispatch = {
    ...dispatch,
    business_hours: dispatchBusinessHours,
    status: nextRunAt ? 'scheduled' : 'queued',
    context,
    label: context === 'welcome' ? 'Bienvenida WhatsApp' : dispatch.label || null,
    filter,
    whatsapp_template_id: template?.id || null,
    template_snapshot: buildTemplateSnapshot(template),
    job_id: null,
    batch_size: dispatch.batch_size,
    delay_ms: dispatch.delay_ms,
    min_read_rate: dispatch.min_read_rate,
    read_rate_grace_ms: dispatch.read_rate_grace_ms,
    max_opt_out_rate: dispatch.max_opt_out_rate,
    cancel_requested: false,
    paused_reason: null,
    started_at: new Date().toISOString(),
    next_allowed_at: nextRunAt ? nextRunAt.toISOString() : null,
    account_quality: accountQuality,
  };
  await list.update({
    status: nextRunAt ? 'scheduled' : 'sending',
    criteria: mergeCriteria(list, { dispatch_config: { ...dispatch, business_hours: dispatchBusinessHours }, dispatch: baseDispatch }),
  });
  const primedList = await MarketingPatientList.findByPk(list.id);
  const job = await enqueueDispatchJob({ list: primedList || list, scope, nextRunAt, userId, context, filter });
  const nextDispatch = {
    ...baseDispatch,
    job_id: job.id,
  };
  await (primedList || list).update({
    criteria: mergeCriteria(primedList || list, { dispatch_config: { ...dispatch, business_hours: dispatchBusinessHours }, dispatch: nextDispatch }),
  });
  await MarketingPatientContactEvent.create({
    list_id: list.id,
    event_type: 'mass_campaign_dispatch_queued',
    channel: 'whatsapp',
    payload: {
      job_id: job.id,
      remaining,
      scheduled_at: nextRunAt ? nextRunAt.toISOString() : null,
      account_quality: accountQuality,
      context,
      filter,
    },
    occurred_at: new Date(),
  });
  await triggerDispatchJobIfReady(job, nextRunAt);
  const reloaded = await MarketingPatientList.findByPk(list.id);
  const scopedCounters = await getDispatchScopedCounters(reloaded, filter);
  return {
    success: true,
    campaign: serializeCampaign(reloaded),
    dispatch: getDispatchProgress(reloaded, scopedCounters, accountQuality),
  };
}

async function cancelCampaignDispatch(scope, campaignId, body = {}, userId = null) {
  const list = await MarketingPatientList.findByPk(campaignId);
  ensureScopeAccess(list, scope);
  const dispatch = getDispatchConfig(list);
  const nextDispatch = {
    ...dispatch,
    status: 'cancel_requested',
    cancel_requested: true,
    cancelled_at: new Date().toISOString(),
    cancelled_by: userId || null,
    cancel_reason: normalizeText(body.reason) || 'Cancelado por el usuario',
  };
  await list.update({
    status: 'paused',
    criteria: mergeCriteria(list, { dispatch: nextDispatch }),
  });
  await MarketingPatientContactEvent.create({
    list_id: list.id,
    event_type: 'mass_campaign_dispatch_cancel_requested',
    channel: 'whatsapp',
    payload: { user_id: userId || null, reason: nextDispatch.cancel_reason },
    occurred_at: new Date(),
  });
  const counters = await refreshListCounters(list.id);
  const reloaded = await MarketingPatientList.findByPk(list.id);
  return {
    success: true,
    campaign: serializeCampaign(reloaded),
    dispatch: getDispatchProgress(reloaded, counters, await getWhatsappAccountQualityForList(reloaded, scope)),
  };
}

async function resumeCampaignDispatch(scope, campaignId, body = {}, actor = null) {
  const userId = getActorUserId(actor);
  const list = await MarketingPatientList.findByPk(campaignId);
  ensureScopeAccess(list, scope);
  const dispatch = getDispatchConfig(list);
  const context = normalizeDispatchContext(dispatch.context);
  const filter = getDispatchItemFilter(dispatch);
  if (isBlockingQualityPause(dispatch) && !isActorGlobalAdmin(actor)) {
    const err = new Error('No se puede reanudar una campaña pausada por baja calidad. Contacta con soporte.');
    err.status = 403;
    throw err;
  }
  if (!['paused', 'cancelled', 'scheduled', 'sending', 'prepared'].includes(String(list.status || '').toLowerCase())) {
    const err = new Error('Esta campaña no se puede retomar desde su estado actual.');
    err.status = 409;
    throw err;
  }
  const remaining = await countDispatchRemainingItems(list.id, filter);
  if (remaining <= 0) {
    const err = new Error('No quedan contactos pendientes de envío.');
    err.status = 409;
    throw err;
  }
  const dispatchBusinessHours = await hydrateDispatchBusinessHoursForList(list, scope, dispatch.business_hours);
  const nextAllowed = getNextBusinessAllowedAt(new Date(), dispatchBusinessHours);
  const nextRunAt = nextAllowed.getTime() > Date.now() + 1000 ? nextAllowed : null;
  const baseDispatch = {
    ...dispatch,
    business_hours: dispatchBusinessHours,
    status: nextRunAt ? 'scheduled' : 'queued',
    job_id: null,
    cancel_requested: false,
    paused_reason: null,
    resumed_at: new Date().toISOString(),
    next_allowed_at: nextRunAt ? nextRunAt.toISOString() : null,
  };
  await list.update({
    status: nextRunAt ? 'scheduled' : 'sending',
    criteria: mergeCriteria(list, { dispatch: baseDispatch }),
  });
  const primedList = await MarketingPatientList.findByPk(list.id);
  const job = await enqueueDispatchJob({ list: primedList || list, scope, nextRunAt, userId, context, filter });
  const nextDispatch = {
    ...baseDispatch,
    job_id: job.id,
  };
  await (primedList || list).update({
    criteria: mergeCriteria(primedList || list, { dispatch: nextDispatch }),
  });
  await MarketingPatientContactEvent.create({
    list_id: list.id,
    event_type: 'mass_campaign_dispatch_resumed',
    channel: 'whatsapp',
    payload: { user_id: userId || null, job_id: job.id, remaining },
    occurred_at: new Date(),
  });
  await triggerDispatchJobIfReady(job, nextRunAt);
  const counters = await refreshListCounters(list.id);
  const reloaded = await MarketingPatientList.findByPk(list.id);
  return {
    success: true,
    campaign: serializeCampaign(reloaded),
    dispatch: getDispatchProgress(reloaded, counters, await getWhatsappAccountQualityForList(reloaded, scope)),
  };
}

async function enqueueAutoDispatchForApprovedTemplate(templateRow, logger = console) {
  const template = templateRow?.get ? templateRow.get({ plain: true }) : templateRow;
  const templateId = Number(template?.id || 0);
  if (!templateId || String(template?.status || '').toUpperCase() !== 'APPROVED') {
    return { queued: 0 };
  }

  const reconciliation = await reconcileBulkSendTemplateCategory(template, logger);

  const rows = await db.sequelize.query(
    `
    SELECT id
    FROM MarketingPatientLists
    WHERE objective_id = :objectiveId
      AND status = 'prepared'
      AND JSON_UNQUOTE(JSON_EXTRACT(criteria, '$.auto_send_when_template_approved')) IN ('true', '1')
      AND CAST(JSON_UNQUOTE(JSON_EXTRACT(criteria, '$.whatsapp_template_id')) AS UNSIGNED) = :templateId
    LIMIT 25
    `,
    {
      replacements: { objectiveId: OBJECTIVE_ID, templateId },
      type: QueryTypes.SELECT,
    }
  );

  let queued = 0;
  for (const row of rows) {
    const list = await MarketingPatientList.findByPk(row.id);
    if (!list) continue;
    const templateUsage = resolveTemplateUsageFromMetaCategory(template, list.criteria?.template_usage || 'promocion');
    const templateCommercial = resolveTemplateCommercialFromMetaCategory(
      template,
      list.criteria?.template_commercial === true || isCommercialTemplateUsage(templateUsage)
    );
    const templateCategory = getTemplateCategory(template) || null;
    const templateSyncedAt = new Date().toISOString();
    const clinicIds = Array.isArray(list.clinic_ids)
      ? list.clinic_ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0)
      : [];
    const clinicId = Number(list.clinica_id || 0);
    if (clinicId && !clinicIds.includes(clinicId)) clinicIds.push(clinicId);
    const scope = Number(list.grupo_clinica_id || 0)
      ? { scope: 'group', groupId: Number(list.grupo_clinica_id), clinicIds }
      : { scope: 'clinic', clinicIds };

    const dispatch = getDispatchConfig(list);
    await list.update({
      safety_gates: {
        ...(list.safety_gates || {}),
        approved_template: true,
      },
      template_snapshot: buildTemplateSnapshot(template),
      criteria: mergeCriteria(list, {
        template_usage: templateUsage,
        template_commercial: templateCommercial,
        opt_out_text: templateCommercial ? normalizeText(list.criteria?.opt_out_text) : null,
        template_category: templateCategory,
        template_category_source: 'meta_sync',
        template_category_synced_at: templateSyncedAt,
        dispatch: {
          ...dispatch,
          status: 'prepared',
          auto_send_when_template_approved: true,
          template_approved_at: new Date().toISOString(),
          template_category: templateCategory,
          template_category_source: 'meta_sync',
          template_category_synced_at: templateSyncedAt,
        },
      }),
    });

    try {
      await startCampaignDispatch(scope, list.id, { scheduled_at: list.criteria?.scheduled_at || null }, null);
      queued += 1;
    } catch (error) {
      logger.warn?.('[marketing-bulk-sends] No se pudo autoencolar campaña tras aprobar plantilla', {
        list_id: list.id,
        template_id: templateId,
        error: error?.message || error,
      });
    }
  }

  return { queued, reconciled: reconciliation.updated || 0 };
}

function extractProviderError(error) {
  const raw = error?.response?.data?.error || error?.response?.data || error;
  return {
    code: normalizeText(raw?.code || raw?.error_subcode || raw?.type || ''),
    message: normalizeText(raw?.message || raw?.error_data?.details || error?.message || 'whatsapp_send_failed'),
    raw,
  };
}

async function sendDispatchItem({
  list,
  item,
  template,
  clinic,
  clinicConfig,
  batchIndex,
  messageKind = null,
  dispatchContextOverride = null,
  eventType = 'mass_campaign_message_sent',
  connectionSource = 'mass_campaign_dispatch',
}) {
  const plainItem = item.get ? item.get({ plain: true }) : item;
  const dispatch = getDispatchConfig(list);
  const dispatchContext = normalizeDispatchContext(dispatchContextOverride || dispatch.context);
  const params = await buildTemplateParams({ template, item: plainItem, list, clinic });
  const templateComponents = await buildTemplateComponentsForSend({
    template,
    params,
    list,
    item: plainItem,
    clinic,
    clinicId: clinicConfig.clinicId || getClinicIdForList(list),
    groupId: list.group_id || null,
    ownerType: 'review_request',
    ownerId: item.id,
  });
  const previewText = await renderTemplatePreview({ template, item: plainItem, list, clinic });
  const conversation = await findCanonicalWhatsappConversation({
    clinicId: clinicConfig.clinicId || getClinicIdForList(list),
    contactId: item.phone,
    patientId: item.paciente_id || null,
    createIfMissing: true,
    lastMessageAt: new Date(),
  });
  const templateUsage = normalizeTemplateUsage(list.criteria?.template_usage || 'promocion');
  const templateCommercial = list.criteria?.template_commercial === true || isCommercialTemplateUsage(templateUsage);
  const appMessage = await Message.create({
    conversation_id: conversation.id,
    sender_id: null,
    direction: 'outbound',
    content: previewText,
    message_type: 'template',
    status: 'pending',
    metadata: {
      kind: dispatchContext === 'welcome' ? 'mass_campaign_welcome_send' : 'mass_campaign_send',
      ...(messageKind ? { kind: messageKind } : {}),
      source: 'marketing_bulk_sends',
      dispatch_context: dispatchContext || 'campaign',
      list_id: list.id,
      item_id: item.id,
      objective_id: OBJECTIVE_ID,
      template_usage: templateUsage,
      template_commercial: templateCommercial,
      template_category: template.category || template.catalog?.category || null,
      template_id: template.id,
      template_name: template.name,
      template_language: template.language || 'es',
      template_params: params,
      template_components: templateComponents,
      recipient: item.phone,
      phoneNumberId: clinicConfig.phoneNumberId || null,
      phoneId: clinicConfig.phoneNumberId || null,
      wabaId: clinicConfig.wabaId || null,
      batch_index: batchIndex,
    },
    sent_at: new Date(),
  });
  emitQuickChatMessageCreated(conversation, appMessage);

  try {
    const response = await whatsappService.sendMessage({
      to: item.phone,
      useTemplate: true,
      templateName: template.name,
      templateLanguage: template.language || 'es',
      templateParams: params,
      templateComponents,
      clinicConfig,
    });
    const providerMessageId = response?.messages?.[0]?.id || null;
    await appMessage.update({
      status: 'sent',
      metadata: {
        ...(appMessage.metadata || {}),
        wa_response: response || null,
        wamid: providerMessageId,
      },
      sent_at: new Date(),
    });
    emitQuickChatMessageUpdated(conversation, appMessage);
    await item.update({
      dispatch_status: 'sent',
      provider_message_id: providerMessageId,
      app_message_id: appMessage.id,
      conversation_id: conversation.id,
      send_batch_index: batchIndex,
      sent_at: new Date(),
      failed_at: null,
      last_error_code: null,
      last_error_message: null,
    });
    await conversation.update({ last_message_at: new Date() });
    await MarketingPatientContactEvent.create({
      list_id: list.id,
      item_id: item.id,
      paciente_id: item.paciente_id || null,
      event_type: eventType,
      channel: 'whatsapp',
      payload: {
        provider_message_id: providerMessageId,
        app_message_id: appMessage.id,
        conversation_id: conversation.id,
        batch_index: batchIndex,
      },
      occurred_at: new Date(),
    });
    await whatsappConnectionStatusService.clearDisconnectedAfterSuccess({
      clinicId: clinicConfig.clinicId || getClinicIdForList(list),
      phoneId: clinicConfig.phoneNumberId || null,
      wabaId: clinicConfig.wabaId || null,
      messageId: appMessage.id,
      source: connectionSource,
    }).catch(() => null);
    if (
      eventType === 'mass_campaign_message_sent'
      && isReviewRequestList(list)
      && isReviewRatingTriggerMessage(appMessage)
      && dispatchContext !== 'review_reminder'
    ) {
      await enqueueReviewReminderJob({
        list,
        item,
        sentAt: appMessage.sent_at || new Date(),
        triggerMessageId: appMessage.id,
      }).catch((error) => {
        console.warn('[marketing-bulk-sends] No se pudo programar recordatorio de reseña', {
          list_id: list.id,
          item_id: item.id,
          error: error?.message || error,
        });
      });
    }
    return {
      sent: true,
      app_message_id: appMessage.id,
      message_id: appMessage.id,
      provider_message_id: providerMessageId,
      conversation_id: conversation.id,
      sent_at: appMessage.sent_at || new Date(),
      template_id: template.id,
      template_name: template.name,
    };
  } catch (error) {
    const providerError = extractProviderError(error);
    await appMessage.update({
      status: 'failed',
      metadata: {
        ...(appMessage.metadata || {}),
        error: providerError.raw || providerError.message,
      },
    });
    emitQuickChatMessageUpdated(conversation, appMessage);
    await item.update({
      dispatch_status: 'failed',
      app_message_id: appMessage.id,
      conversation_id: conversation.id,
      send_batch_index: batchIndex,
      failed_at: new Date(),
      last_error_code: providerError.code || null,
      last_error_message: providerError.message,
    });
    await MarketingPatientContactEvent.create({
      list_id: list.id,
      item_id: item.id,
      paciente_id: item.paciente_id || null,
      event_type: eventType === 'mass_campaign_message_sent' ? 'mass_campaign_message_failed' : `${eventType}_failed`,
      channel: 'whatsapp',
      payload: {
        app_message_id: appMessage.id,
        conversation_id: conversation.id,
        batch_index: batchIndex,
        error_code: providerError.code || null,
        error_message: providerError.message,
      },
      occurred_at: new Date(),
    });
    await whatsappConnectionStatusService.markDisconnectedAfterProviderError({
      error: providerError.raw || providerError,
      clinicId: clinicConfig.clinicId || getClinicIdForList(list),
      phoneId: clinicConfig.phoneNumberId || null,
      wabaId: clinicConfig.wabaId || null,
      messageId: appMessage.id,
      recipient: item.phone,
      source: connectionSource,
    }).catch(() => null);
    return { sent: false, error: providerError };
  }
}

async function runDispatchJob(payload = {}, jobRequest = null) {
  const listId = Number(payload.list_id || payload.listId || 0);
  if (!Number.isInteger(listId) || listId <= 0) {
    throw new Error('marketing_bulk_send_dispatch requires payload.list_id');
  }
  const scope = payload.scope || {};
  const list = await MarketingPatientList.findByPk(listId);
  if (!list || list.objective_id !== OBJECTIVE_ID || String(list.status || '').toLowerCase() === 'archived') {
    return { status: 'completed', result: { skipped: true, reason: 'list_not_found_or_archived', list_id: listId } };
  }
  const rawDispatch = getDispatchConfig(list);
  const dispatchBusinessHours = await hydrateDispatchBusinessHoursForList(list, scope, rawDispatch.business_hours);
  const dispatch = {
    ...rawDispatch,
    business_hours: dispatchBusinessHours,
  };
  const payloadFilter = payload.filter && typeof payload.filter === 'object' && normalizeText(payload.filter.import_batch_id)
    ? payload.filter
    : null;
  const filter = payloadFilter || getDispatchItemFilter(dispatch);
  const context = normalizeDispatchContext(payload.context || dispatch.context);
  if (dispatch.cancel_requested === true) {
    await list.update({
      status: 'paused',
      criteria: mergeCriteria(list, {
        dispatch: {
          ...dispatch,
          status: 'cancelled',
          paused_reason: 'cancelled_by_user',
          stopped_at: new Date().toISOString(),
        },
      }),
    });
    return { status: 'completed', result: { cancelled: true, list_id: list.id } };
  }
  if (!isWithinBusinessHours(new Date(), dispatch.business_hours)) {
    const nextAllowed = getNextBusinessAllowedAt(new Date(), dispatch.business_hours);
    await list.update({
      status: 'scheduled',
      criteria: mergeCriteria(list, {
        dispatch: {
          ...dispatch,
          status: 'scheduled',
          next_allowed_at: nextAllowed.toISOString(),
          paused_reason: 'outside_business_hours',
        },
      }),
    });
    return {
      status: 'waiting',
      nextRunAt: nextAllowed,
      nextAllowedAt: nextAllowed,
      result: { waiting: true, reason: 'outside_business_hours', list_id: list.id },
    };
  }

  const countersBefore = await getDispatchScopedCounters(list, filter);
  const sentBefore = Number(countersBefore.sent || 0);
  const readRate = sentBefore > 0 ? Number(countersBefore.read || 0) / sentBefore : 1;
  const optOutRate = sentBefore > 0 ? Number(countersBefore.opt_out || countersBefore.exclusion_reasons?.opt_out || 0) / sentBefore : 0;
  const batchSize = Number(dispatch.batch_size || DISPATCH_BATCH_SIZE) || DISPATCH_BATCH_SIZE;
  const batchDelayMs = Number(dispatch.delay_ms || DISPATCH_BATCH_DELAY_MS) || DISPATCH_BATCH_DELAY_MS;
  const maxOptOutRate = Number(dispatch.max_opt_out_rate || DISPATCH_MAX_OPT_OUT_RATE) || DISPATCH_MAX_OPT_OUT_RATE;
  if (sentBefore >= batchSize && optOutRate > maxOptOutRate) {
    await list.update({
      status: 'paused',
      criteria: mergeCriteria(list, {
        dispatch: {
          ...dispatch,
          status: 'paused_quality',
          paused_reason: 'opt_out_rate_high',
          paused_at: new Date().toISOString(),
          quality_snapshot: { sent: sentBefore, read_rate: readRate, opt_out_rate: optOutRate },
        },
      }),
    });
    return { status: 'completed', result: { paused: true, reason: 'opt_out_rate_high', list_id: list.id } };
  }

  const accountQuality = await getWhatsappAccountQualityForList(list, scope);
  if (accountQuality.messaging_limit_count && sentBefore >= accountQuality.messaging_limit_count) {
    await list.update({
      status: 'paused',
      criteria: mergeCriteria(list, {
        dispatch: {
          ...dispatch,
          status: 'paused_limit',
          paused_reason: 'messaging_limit_reached',
          paused_at: new Date().toISOString(),
          account_quality: accountQuality,
        },
      }),
    });
    return { status: 'completed', result: { paused: true, reason: 'messaging_limit_reached', list_id: list.id } };
  }

  const welcomeMessage = list.criteria?.welcome_message && typeof list.criteria.welcome_message === 'object'
    ? list.criteria.welcome_message
    : {};
  const template = await resolveWhatsappTemplate(
    dispatch.whatsapp_template_id
      || dispatch.template_snapshot?.id
      || (context === 'welcome' ? welcomeMessage.template_id : null)
      || list.criteria?.whatsapp_template_id
      || list.template_snapshot?.id,
    scope
  );
  if (!template || String(template.status || '').toUpperCase() !== 'APPROVED') {
    await list.update({
      status: 'paused',
      criteria: mergeCriteria(list, {
        dispatch: {
          ...dispatch,
          status: 'paused_template',
          paused_reason: 'template_not_approved',
          paused_at: new Date().toISOString(),
        },
      }),
    });
    return { status: 'completed', result: { paused: true, reason: 'template_not_approved', list_id: list.id } };
  }
  const clinicId = getClinicIdForList(list, scope);
  const clinic = await loadClinicForTemplateVariables(clinicId);
  const clinicConfig = clinicId ? await whatsappService.getClinicConfig(clinicId) : null;
  if (!clinicConfig?.phoneNumberId || !clinicConfig?.accessToken) {
    await list.update({
      status: 'paused',
      criteria: mergeCriteria(list, {
        dispatch: {
          ...dispatch,
          status: 'paused_config',
          paused_reason: 'whatsapp_config_missing',
          paused_at: new Date().toISOString(),
        },
      }),
    });
    return { status: 'completed', result: { paused: true, reason: 'whatsapp_config_missing', list_id: list.id } };
  }
  clinicConfig.clinicId = clinicId;

  const batchLimit = accountQuality.messaging_limit_count
    ? Math.max(0, Math.min(batchSize, accountQuality.messaging_limit_count - sentBefore))
    : batchSize;
  const batch = batchLimit > 0
    ? await findDispatchCandidateBatch(list.id, filter, batchLimit)
    : [];

  if (!batch.length) {
    await refreshListCounters(list.id);
    const finalCounters = await getDispatchScopedCounters(list, filter);
    const completedAt = new Date();
    const followUpCounters = context === 'review_request'
      ? await getReviewDispatchFollowUpCounters(list, filter)
      : null;
    await list.update({
      status: 'completed',
      last_sent_at: completedAt,
      criteria: mergeCriteria(list, {
        dispatch: buildDispatchCompletedPatch(dispatch, followUpCounters, completedAt),
      }),
    });
    return { status: 'completed', result: { completed: true, list_id: list.id, counters: finalCounters } };
  }

  await list.update({
    status: 'sending',
    criteria: mergeCriteria(list, {
      dispatch: {
        ...dispatch,
        status: 'sending',
        job_id: jobRequest?.id || dispatch.job_id || null,
        last_batch_started_at: new Date().toISOString(),
        next_allowed_at: null,
        account_quality: accountQuality,
      },
    }),
  });

  await revalidateDispatchExclusions(list, batch, scope);
  const freshBatch = await MarketingPatientListItem.findAll({
    where: {
      id: { [Op.in]: batch.map((item) => item.id) },
      status: 'ready',
      selected: true,
      [Op.or]: [{ dispatch_status: null }, { dispatch_status: 'pending' }],
    },
    order: [['id', 'ASC']],
  });
  const filteredFreshBatch = freshBatch.filter((item) => itemMatchesDispatchFilter(item, filter));

  const batchIndex = Number(dispatch.last_batch_index || 0) + 1;
  let sent = 0;
  let failed = 0;
  for (const item of filteredFreshBatch) {
    const currentList = await MarketingPatientList.findByPk(list.id);
    if (getDispatchConfig(currentList).cancel_requested === true) {
      break;
    }
    const plainItem = item.get ? item.get({ plain: true }) : item;
    const itemClinicId = Number(plainItem.clinica_id || clinicId || 0) || null;
    let itemClinic = clinic;
    let itemClinicConfig = clinicConfig;
    let itemTemplate = template;
    if (itemClinicId && itemClinicId !== Number(clinicId || 0)) {
      itemClinic = await loadClinicForTemplateVariables(itemClinicId);
      itemClinicConfig = await whatsappService.getClinicConfig(itemClinicId).catch(() => null);
      if (itemClinicConfig) itemClinicConfig.clinicId = itemClinicId;
      itemTemplate = await resolveWhatsappTemplateForClinic(template, itemClinicId, itemClinicConfig);
    }
    if (!itemClinicConfig?.phoneNumberId || !itemClinicConfig?.accessToken) {
      failed += 1;
      await item.update({
        dispatch_status: 'failed',
        failed_at: new Date(),
        last_error_code: 'whatsapp_config_missing',
        last_error_message: 'La clínica del contacto no tiene WhatsApp conectado.',
      });
      continue;
    }
    if (!itemTemplate || String(itemTemplate.status || '').toUpperCase() !== 'APPROVED') {
      failed += 1;
      await item.update({
        dispatch_status: 'failed',
        failed_at: new Date(),
        last_error_code: 'template_not_approved_for_clinic',
        last_error_message: 'No hay plantilla WhatsApp aprobada compatible con la clínica del contacto.',
      });
      continue;
    }
    const missingVariables = buildMissingVariablesSummary({ template: itemTemplate, items: [plainItem], list, clinic: itemClinic });
    if (missingVariables.length) {
      await item.update({
        status: 'excluded_missing_variables',
        exclusion_reason: 'variables_faltantes',
        selected: false,
        reason: formatMissingVariablesMessage(missingVariables),
        missing_variables: missingVariables,
      });
      continue;
    }
    const result = await sendDispatchItem({
      list,
      item,
      template: itemTemplate,
      clinic: itemClinic,
      clinicConfig: itemClinicConfig,
      batchIndex,
    });
    if (result.sent) sent += 1;
    else failed += 1;
  }

  await refreshListCounters(list.id);
  const countersAfter = await getDispatchScopedCounters(list, filter);
  await MarketingPatientContactEvent.create({
    list_id: list.id,
    event_type: 'mass_campaign_batch_processed',
    channel: 'whatsapp',
    payload: {
      batch_index: batchIndex,
      attempted: filteredFreshBatch.length,
      sent,
      failed,
      counters: countersAfter,
      context,
      filter,
    },
    occurred_at: new Date(),
  });

  const remaining = await countDispatchRemainingItems(list.id, filter);
  if (remaining <= 0) {
    const completedAt = new Date();
    const followUpCounters = context === 'review_request'
      ? await getReviewDispatchFollowUpCounters(list, filter)
      : null;
    await list.update({
      status: 'completed',
      last_sent_at: completedAt,
      criteria: mergeCriteria(list, {
        dispatch: buildDispatchCompletedPatch({
          ...getDispatchConfig(list),
          last_batch_index: batchIndex,
        }, followUpCounters, completedAt),
      }),
    });
    return { status: 'completed', result: { completed: true, list_id: list.id, counters: countersAfter } };
  }

  const nextAllowed = getNextBusinessAllowedAt(new Date(Date.now() + batchDelayMs), dispatch.business_hours);
  await list.update({
    status: 'sending',
    criteria: mergeCriteria(list, {
      dispatch: {
        ...getDispatchConfig(list),
        status: 'waiting_next_batch',
        last_batch_index: batchIndex,
        last_batch_completed_at: new Date().toISOString(),
        next_allowed_at: nextAllowed.toISOString(),
      },
    }),
  });
  return {
    status: 'waiting',
    nextRunAt: nextAllowed,
    nextAllowedAt: nextAllowed,
    result: {
      waiting: true,
      reason: 'batch_delay',
      list_id: list.id,
      batch_index: batchIndex,
      remaining,
      counters: countersAfter,
    },
  };
}

async function materializeMessageStatusFromWebhook({ message, status, mappedStatus }) {
  const metadata = message?.metadata || {};
  if (metadata.source !== 'marketing_bulk_sends') return { applied: false, reason: 'not_bulk_send' };
  const listId = Number(metadata.list_id || 0);
  const itemId = Number(metadata.item_id || 0);
  if (!listId || !itemId) return { applied: false, reason: 'missing_ids' };
  const item = await MarketingPatientListItem.findOne({ where: { id: itemId, list_id: listId } });
  if (!item) return { applied: false, reason: 'item_not_found' };
  const eventAt = parseWhatsappTimestamp(status?.timestamp, new Date());
  const patch = {
    provider_message_id: metadata.wamid || status?.id || item.provider_message_id || null,
    app_message_id: message.id || item.app_message_id || null,
  };
  if (mappedStatus === 'sent') {
    patch.dispatch_status = item.dispatch_status || 'sent';
    patch.sent_at = item.sent_at || eventAt;
  } else if (mappedStatus === 'delivered') {
    patch.dispatch_status = 'delivered';
    patch.sent_at = item.sent_at || eventAt;
    patch.delivered_at = item.delivered_at || eventAt;
  } else if (mappedStatus === 'read') {
    patch.dispatch_status = 'read';
    patch.sent_at = item.sent_at || eventAt;
    patch.delivered_at = item.delivered_at || eventAt;
    patch.read_at = item.read_at || eventAt;
  } else if (mappedStatus === 'failed') {
    const error = Array.isArray(status?.errors) ? status.errors[0] : null;
    patch.dispatch_status = 'failed';
    patch.failed_at = item.failed_at || eventAt;
    patch.last_error_code = normalizeText(error?.code || error?.error_subcode || '') || item.last_error_code || null;
    patch.last_error_message = normalizeText(error?.message || error?.error_data?.details || '') || item.last_error_message || null;
  }
  await item.update(patch);
  await MarketingPatientContactEvent.create({
    list_id: listId,
    item_id: itemId,
    paciente_id: item.paciente_id || null,
    event_type: `mass_campaign_message_${mappedStatus}`,
    channel: 'whatsapp',
    payload: {
      provider_message_id: patch.provider_message_id || null,
      app_message_id: patch.app_message_id || null,
      raw_status: status || null,
    },
    occurred_at: eventAt,
  });
  await refreshListCounters(listId);
  return { applied: true, list_id: listId, item_id: itemId, status: mappedStatus };
}

async function materializeInboundReply({ conversation, inboundMessage }) {
  if (!conversation?.id || !inboundMessage) return { applied: false, reason: 'missing_context' };
  let triggerMessage = await Message.findOne({
    where: {
      conversation_id: conversation.id,
      direction: 'outbound',
      createdAt: { [Op.lte]: inboundMessage.createdAt || new Date() },
    },
    order: [['createdAt', 'DESC']],
    limit: 1,
  });
  let metadata = asPlainObject(triggerMessage?.metadata);
  const inboundRatingCandidate = extractReviewRatingFromInboundMessage(inboundMessage);
  if (
    inboundRatingCandidate &&
    metadata.source === 'marketing_bulk_sends' &&
    normalizeKey(metadata.kind) !== 'review_private_feedback_request' &&
    !isReviewRatingTriggerMessage(triggerMessage)
  ) {
    const previousOutboundMessages = await Message.findAll({
      where: {
        conversation_id: conversation.id,
        direction: 'outbound',
        createdAt: { [Op.lte]: inboundMessage.createdAt || new Date() },
      },
      order: [['createdAt', 'DESC']],
      limit: 25,
    });
    const currentListId = Number(metadata.list_id || 0);
    const currentItemId = Number(metadata.item_id || 0);
    const ratingTrigger = previousOutboundMessages.find((message) => {
      const candidateMeta = asPlainObject(message?.metadata);
      if (candidateMeta.source !== 'marketing_bulk_sends') return false;
      if (!isReviewRatingTriggerMessage(message)) return false;
      if (currentListId && Number(candidateMeta.list_id || 0) !== currentListId) return false;
      if (currentItemId && Number(candidateMeta.item_id || 0) !== currentItemId) return false;
      return true;
    });
    if (ratingTrigger) {
      triggerMessage = ratingTrigger;
      metadata = asPlainObject(triggerMessage?.metadata);
    }
  }
  if (metadata.source !== 'marketing_bulk_sends') return { applied: false, reason: 'not_bulk_send' };
  const listId = Number(metadata.list_id || 0);
  const itemId = Number(metadata.item_id || 0);
  if (!listId || !itemId) return { applied: false, reason: 'missing_ids' };
  const list = await MarketingPatientList.findByPk(listId);
  if (!list) return { applied: false, reason: 'list_not_found' };
  const item = await MarketingPatientListItem.findOne({ where: { id: itemId, list_id: listId } });
  if (!item) return { applied: false, reason: 'item_not_found' };
  const repliedAt = inboundMessage.sent_at || inboundMessage.createdAt || new Date();
  const isTestTrigger = normalizeKey(metadata.kind) === 'mass_campaign_test';
  let existingReply = null;
  if (isTestTrigger) {
    const replyEvents = await MarketingPatientContactEvent.findAll({
      where: {
        list_id: listId,
        item_id: itemId,
        event_type: 'mass_campaign_message_replied',
      },
      order: [['occurred_at', 'DESC']],
      limit: 25,
    });
    existingReply = replyEvents.find((event) => Number(event.payload?.trigger_message_id || 0) === Number(triggerMessage.id || 0)) || null;
  } else {
    existingReply = await MarketingPatientContactEvent.findOne({
      where: {
        list_id: listId,
        item_id: itemId,
        event_type: 'mass_campaign_message_replied',
      },
      order: [['occurred_at', 'DESC']],
    });
  }
  const privateFeedback = await materializeReviewPrivateFeedback({
    list,
    item,
    inboundMessage,
    triggerMessage,
    occurredAt: repliedAt,
  });
  if (privateFeedback.applied || privateFeedback.reason === 'already_feedback_received') {
    const acknowledgement = await sendReviewPrivateFeedbackAcknowledgement({
      list,
      item,
      conversation,
      inboundMessage,
      triggerMessage,
      occurredAt: repliedAt,
    });
    await refreshListCounters(listId);
    return {
      applied: true,
      list_id: listId,
      item_id: itemId,
      review_private_feedback: true,
      acknowledgement,
    };
  }
  const reviewRating = isReviewRequestList(list) && isReviewRatingTriggerMessage(triggerMessage)
    ? extractReviewRatingFromInboundMessage(inboundMessage)
    : null;
  const existingRating = reviewRating
    ? await findExistingReviewRatingEvent(listId, itemId, {
      sameTriggerOnly: isTestTrigger,
      triggerMessageId: triggerMessage.id,
    })
    : null;
  const alreadyReplied = existingReply || (!isTestTrigger && item.replied_at && String(item.dispatch_status || '').toLowerCase() === 'replied');
  if (alreadyReplied) {
    if (!item.replied_at || String(item.dispatch_status || '').toLowerCase() !== 'replied') {
      await item.update({
        dispatch_status: 'replied',
        replied_at: item.replied_at || repliedAt,
        conversation_id: conversation.id,
      });
    }
    if (reviewRating && existingRating) {
      const previousPayload = existingRating.payload || {};
      const previousRating = Number(previousPayload.rating || 0);
      if (previousRating && previousRating !== reviewRating) {
        const ratingChange = classifyReviewRatingChange(previousRating, reviewRating);
        if (ratingChange.action === 'ignore') {
          await createIgnoredReviewRatingEvent({
            list,
            item,
            inboundMessage,
            triggerMessage,
            previousRating,
            rating: reviewRating,
            reason: ratingChange.reason,
            occurredAt: repliedAt,
          });
          await refreshListCounters(listId);
          return {
            applied: true,
            list_id: listId,
            item_id: itemId,
            review_rating: reviewRating,
            previous_rating: previousRating,
            rating_ignored: true,
            reason: ratingChange.reason,
          };
        }
        await existingRating.update({
          payload: {
            ...previousPayload,
            rating: reviewRating,
            previous_rating: previousPayload.previous_rating || previousRating,
            updated_by_inbound_message_id: inboundMessage.id,
            updated_trigger_message_id: triggerMessage.id,
            updated_content_preview: normalizeText(inboundMessage.content).slice(0, 300),
            updated_at: repliedAt,
          },
        });
        await MarketingPatientContactEvent.create({
          list_id: listId,
          item_id: itemId,
          paciente_id: item.paciente_id || null,
          event_type: 'review_rating_updated',
          channel: 'whatsapp',
          payload: {
            previous_rating: previousRating,
            rating: reviewRating,
            inbound_message_id: inboundMessage.id,
            trigger_message_id: triggerMessage.id,
            content_preview: normalizeText(inboundMessage.content).slice(0, 300),
          },
          occurred_at: repliedAt,
        });
        await sendReviewRatingFollowUp({
          list,
          item,
          conversation,
          rating: reviewRating,
          clinicId: item.clinica_id || list.clinica_id || conversation.clinic_id || null,
          triggerMessage,
          occurredAt: repliedAt,
        });
        await refreshListCounters(listId);
        return {
          applied: true,
          list_id: listId,
          item_id: itemId,
          review_rating: reviewRating,
          previous_rating: previousRating,
          rating_updated: true,
        };
      }
    }
    if (reviewRating && !existingRating) {
      await MarketingPatientContactEvent.create({
        list_id: listId,
        item_id: itemId,
        paciente_id: item.paciente_id || null,
        event_type: 'review_rating_received',
        channel: 'whatsapp',
        payload: {
          rating: reviewRating,
          inbound_message_id: inboundMessage.id,
          trigger_message_id: triggerMessage.id,
          content_preview: normalizeText(inboundMessage.content).slice(0, 300),
        },
        occurred_at: repliedAt,
      });
      await sendReviewRatingFollowUp({
        list,
        item,
        conversation,
        rating: reviewRating,
        clinicId: item.clinica_id || list.clinica_id || conversation.clinic_id || null,
        triggerMessage,
        occurredAt: repliedAt,
      });
      await refreshListCounters(listId);
      return { applied: true, list_id: listId, item_id: itemId, review_rating: reviewRating };
    }
    return { applied: false, reason: 'already_replied', list_id: listId, item_id: itemId };
  }
  await item.update({
    dispatch_status: 'replied',
    replied_at: item.replied_at || repliedAt,
    conversation_id: conversation.id,
  });
  if (!existingReply) {
    await MarketingPatientContactEvent.create({
      list_id: listId,
      item_id: itemId,
      paciente_id: item.paciente_id || null,
      event_type: 'mass_campaign_message_replied',
      channel: 'whatsapp',
      payload: {
        inbound_message_id: inboundMessage.id,
        trigger_message_id: triggerMessage.id,
        content_preview: normalizeText(inboundMessage.content).slice(0, 300),
      },
      occurred_at: repliedAt,
    });
  }
  if (reviewRating && !existingRating) {
    await MarketingPatientContactEvent.create({
      list_id: listId,
      item_id: itemId,
      paciente_id: item.paciente_id || null,
      event_type: 'review_rating_received',
      channel: 'whatsapp',
      payload: {
        rating: reviewRating,
        inbound_message_id: inboundMessage.id,
        trigger_message_id: triggerMessage.id,
        content_preview: normalizeText(inboundMessage.content).slice(0, 300),
      },
      occurred_at: repliedAt,
    });
    await sendReviewRatingFollowUp({
      list,
      item,
      conversation,
      rating: reviewRating,
      clinicId: item.clinica_id || list.clinica_id || conversation.clinic_id || null,
      triggerMessage,
      occurredAt: repliedAt,
    });
  }
  await refreshListCounters(listId);
  return { applied: true, list_id: listId, item_id: itemId, ...(reviewRating ? { review_rating: reviewRating } : {}) };
}

async function removeCampaign(scope, campaignId, userId = null) {
  const list = await MarketingPatientList.findByPk(campaignId);
  ensureScopeAccess(list, scope);
  const previousStatus = list.status;
  if (previousStatus === 'draft') {
    await db.sequelize.transaction(async (transaction) => {
      await MarketingPatientContactEvent.destroy({ where: { list_id: list.id }, transaction });
      await MarketingPatientListItem.destroy({ where: { list_id: list.id }, transaction });
      await list.destroy({ transaction });
    });
    return { success: true, action: 'deleted', id: list.id };
  }

  await list.update({ status: 'archived' });
  await MarketingPatientContactEvent.create({
    list_id: list.id,
    event_type: 'mass_campaign_archived',
    channel: list.channel,
    payload: { previous_status: previousStatus, user_id: userId || null },
    occurred_at: new Date(),
  });
  return { success: true, action: 'archived', campaign: serializeCampaign(list) };
}

module.exports = {
  listCampaigns,
  createCampaign,
  getCampaign,
  updateCampaign,
  getReviewRequestSummary,
  setReviewRequestAutomation,
  createAndStartReviewRequestForAppointment,
  sendReviewRequestReminder,
  runReviewRequestReminderJob,
  runReviewNoResponseJob,
  listRecipients,
  updateRecipient,
  prepareCampaign,
  sendTest,
  getDispatchStatus,
  startCampaignDispatch,
  cancelCampaignDispatch,
  resumeCampaignDispatch,
  enqueueAutoDispatchForApprovedTemplate,
  runDispatchJob,
  materializeMessageStatusFromWebhook,
  materializeInboundReply,
  getAdminBulkSendSettings,
  upsertAdminBulkSendSettings,
  removeCampaign,
};
