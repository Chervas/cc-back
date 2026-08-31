'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const { ADMIN_USER_IDS } = require('../lib/role-helpers');
const { normalizePhoneE164 } = require('../lib/phone');
const emailDelivery = require('./emailDelivery.service');
const jobRequestsService = require('./jobRequests.service');
const whatsappService = require('./whatsapp.service');
const whatsappAccountHealthService = require('./whatsappAccountHealth.service');
const { emitNotificationCreated } = require('./notificationsRealtime.service');
const metaClient = require('../lib/metaClient');

const SETTINGS_SCOPE = 'global';
const DEFAULT_TEMPLATE_NAME = 'clinicaclick_admin_alerta_sistema';
const DEFAULT_TEMPLATE_LANGUAGE = 'es';
const SYSTEM_ADMIN_ALERT_USAGE = 'system_admin_alert';
const META_API_BASE_URL = process.env.META_API_BASE_URL || 'https://graph.facebook.com/v23.0';
const APPROVED_TEMPLATE_STATUSES = new Set(['APPROVED', 'ACTIVE']);
const TEMPLATE_REMOTE_SYNC_TTL_MS = 6 * 60 * 60 * 1000;
const TEMPLATE_REMOTE_PENDING_SYNC_TTL_MS = 5 * 60 * 1000;
const BUSINESS_MESSAGING_RESTRICTION_TYPES = new Set([
  'RESTRICTED_BIZ_INITIATED_MESSAGING',
]);
const WHATSAPP_PROVIDER_STATUSES = new Set(['sent', 'delivered', 'read', 'failed']);

const SYSTEM_NOTIFICATION_EVENTS = Object.freeze([
  {
    key: 'system.notification_test',
    category: 'system',
    severity: 'info',
    label: 'Prueba de notificación',
    description: 'Valida panel, email y WhatsApp sin depender de una alerta real.',
    defaults: { panel: true, email: false, whatsapp: true },
  },
  {
    key: 'users.new_registration',
    category: 'users',
    severity: 'info',
    label: 'Nuevo registro de usuario',
    description: 'Alta pública o alta admin de una cuenta de usuario.',
    defaults: { panel: true, email: true, whatsapp: true },
  },
  {
    key: 'email_provider_disabled',
    category: 'email',
    severity: 'critical',
    label: 'Email: proveedor desactivado',
    description: 'EMAIL_ENABLED no permite entregar correo transaccional.',
    defaults: { panel: true, email: false, whatsapp: true },
  },
  {
    key: 'email_from_missing',
    category: 'email',
    severity: 'critical',
    label: 'Email: remitente ausente',
    description: 'Falta el remitente transaccional verificado.',
    defaults: { panel: true, email: false, whatsapp: true },
  },
  {
    key: 'email_encryption_missing',
    category: 'email',
    severity: 'critical',
    label: 'Email: cifrado ausente',
    description: 'Falta el secreto de cifrado server-side para datos de email.',
    defaults: { panel: true, email: false, whatsapp: true },
  },
  {
    key: 'email_ses_credentials_missing',
    category: 'email',
    severity: 'critical',
    label: 'Email: credenciales SES incompletas',
    description: 'SES está seleccionado pero faltan credenciales dedicadas.',
    defaults: { panel: true, email: false, whatsapp: true },
  },
  {
    key: 'email_webhook_token_missing',
    category: 'email',
    severity: 'warning',
    label: 'Email: token webhook ausente',
    description: 'Falta EMAIL_EVENT_WEBHOOK_TOKEN en el runtime.',
    defaults: { panel: true, email: false, whatsapp: false },
  },
  {
    key: 'email_failures_24h',
    category: 'email',
    severity: 'warning',
    label: 'Email: fallos recientes',
    description: 'Hay envíos fallidos o rechazados en las últimas 24 horas.',
    defaults: { panel: true, email: false, whatsapp: false },
  },
  {
    key: 'email_queue_stuck',
    category: 'email',
    severity: 'warning',
    label: 'Email: cola atascada',
    description: 'Hay mensajes queued/sending durante más de 15 minutos.',
    defaults: { panel: true, email: true, whatsapp: true },
  },
  {
    key: 'email_sent_without_events',
    category: 'email',
    severity: 'warning',
    label: 'Email: sin eventos SES',
    description: 'SES aceptó mensajes recientes, pero no llegaron eventos de proveedor.',
    defaults: { panel: true, email: true, whatsapp: true },
  },
  {
    key: 'email_complaints_7d',
    category: 'email',
    severity: 'critical',
    label: 'Email: quejas SES',
    description: 'SES ha registrado quejas en los últimos 7 días.',
    defaults: { panel: true, email: false, whatsapp: true },
  },
  {
    key: 'email_bounces_7d',
    category: 'email',
    severity: 'warning',
    label: 'Email: rebotes SES',
    description: 'SES ha registrado rebotes en los últimos 7 días.',
    defaults: { panel: true, email: true, whatsapp: false },
  },
  {
    key: 'email_active_suppressions',
    category: 'email',
    severity: 'warning',
    label: 'Email: supresiones activas',
    description: 'Hay destinatarios suprimidos por rebote, queja o baja.',
    defaults: { panel: true, email: true, whatsapp: false },
  },
  {
    key: 'whatsapp.account_health_blocked',
    category: 'whatsapp',
    severity: 'critical',
    label: 'WhatsApp: cuenta bloqueada o desconectada',
    description: 'Meta impide enviar y el cortacircuitos ha detenido nuevos intentos.',
    defaults: { panel: true, email: true, whatsapp: true },
  },
  {
    key: 'whatsapp.account_health_recovered',
    category: 'whatsapp',
    severity: 'info',
    label: 'WhatsApp: cuenta restablecida',
    description: 'La recuperación del número se ha confirmado sin realizar un envío de prueba.',
    defaults: { panel: true, email: true, whatsapp: false },
  },
  {
    key: 'whatsapp.webhook_subscription_missing',
    category: 'whatsapp',
    severity: 'critical',
    label: 'WhatsApp: webhook sin cobertura',
    description: 'Meta ya no confirma la app o alguno de los campos de webhook obligatorios.',
    defaults: { panel: true, email: true, whatsapp: true },
  },
  {
    key: 'whatsapp.webhook_subscription_recovered',
    category: 'whatsapp',
    severity: 'info',
    label: 'WhatsApp: webhook restablecido',
    description: 'Meta vuelve a confirmar la app y los campos de webhook obligatorios.',
    defaults: { panel: true, email: true, whatsapp: false },
  },
  {
    key: 'whatsapp.business_verification_rejected',
    category: 'whatsapp',
    severity: 'warning',
    label: 'WhatsApp: verificación empresarial rechazada',
    description: 'Meta ha comunicado que el negocio no ha superado la verificación empresarial.',
    defaults: { panel: true, email: true, whatsapp: false },
  },
]);

function cleanString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function hashValue(value) {
  const normalized = cleanString(value);
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized.toLowerCase()).digest('hex');
}

function maskEmail(value) {
  const normalized = cleanString(value);
  if (!normalized || !normalized.includes('@')) return null;
  const [local, domain] = normalized.split('@');
  const visible = local.length <= 2 ? `${local.slice(0, 1)}*` : `${local.slice(0, 2)}***`;
  return `${visible}@${domain}`;
}

function maskPhone(value) {
  const normalized = normalizePhoneE164(value) || cleanString(value);
  if (!normalized) return null;
  const digits = normalized.replace(/\D/g, '');
  if (digits.length <= 4) return '****';
  return `***${digits.slice(-4)}`;
}

function recipientDomain(value) {
  const normalized = cleanString(value);
  const at = normalized ? normalized.lastIndexOf('@') : -1;
  return at >= 0 ? normalized.slice(at + 1).toLowerCase() : null;
}

function normalizeSeverity(value, fallback = 'info') {
  const normalized = String(value || '').trim().toLowerCase();
  return ['critical', 'warning', 'info'].includes(normalized) ? normalized : fallback;
}

function safeText(value, max = 500) {
  const normalized = cleanString(value);
  if (!normalized) return null;
  return normalized
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/(?:\+?\d[\s().-]?){9,}/g, '[phone]')
    .replace(/\s+/g, ' ')
    .slice(0, max);
}

function parseProviderDate(value, fallback = new Date()) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    const parsed = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? parsed : fallback;
}

function senderComplianceState(incident, now = new Date()) {
  const plain = incident?.toJSON ? incident.toJSON() : incident;
  if (!plain || plain.resolved_at || plain.resolvedAt) {
    return {
      blocked: false,
      operationalStatus: 'ready',
      blockReason: null,
      restrictionExpiresAt: null,
      complianceIncidentId: null,
      complianceReviewStatus: null,
    };
  }

  const restrictions = Array.isArray(plain.restriction_info)
    ? plain.restriction_info
    : [];
  const businessRestrictions = restrictions.filter((restriction) => (
    BUSINESS_MESSAGING_RESTRICTION_TYPES.has(String(restriction?.restriction_type || '').trim().toUpperCase())
  ));
  const activeBusinessRestrictions = businessRestrictions.filter((restriction) => {
    if (restriction?.active === false) return false;
    if (!restriction?.expiration) return true;
    const expiration = new Date(restriction.expiration);
    return Number.isNaN(expiration.getTime()) || expiration.getTime() > now.getTime();
  });
  const operationalStatus = String(plain.operational_status || '').trim().toLowerCase();
  const statusBlocksWithoutDetails = ['banned', 'disabled', 'locked', 'restricted'].includes(operationalStatus)
    && restrictions.length === 0;
  const blocked = activeBusinessRestrictions.length > 0 || statusBlocksWithoutDetails;
  const expirations = activeBusinessRestrictions
    .map((restriction) => new Date(restriction.expiration))
    .filter((date) => !Number.isNaN(date.getTime()));
  const restrictionExpiresAt = expirations.length
    ? new Date(Math.max(...expirations.map((date) => date.getTime()))).toISOString()
    : null;

  return {
    blocked,
    operationalStatus: blocked ? (operationalStatus || 'restricted') : 'ready',
    blockReason: blocked ? 'business_initiated_messaging_restricted' : null,
    restrictionExpiresAt,
    complianceIncidentId: plain.id || null,
    complianceReviewStatus: plain.status || null,
  };
}

async function getSenderComplianceState(assetId, now = new Date()) {
  const parsed = Number(assetId || 0);
  if (!Number.isInteger(parsed) || parsed <= 0 || !db.WhatsappAccountComplianceIncident) {
    return senderComplianceState(null, now);
  }
  const incident = await db.WhatsappAccountComplianceIncident.findOne({
    where: { asset_id: parsed, resolved_at: null },
    order: [['occurred_at', 'DESC'], ['id', 'DESC']],
  });
  return senderComplianceState(incident, now);
}

function truncateForProvider(value, max = 180) {
  const normalized = safeText(value, max) || '';
  return normalized.length > max ? `${normalized.slice(0, max - 1)}…` : normalized;
}

function nowMadridLabel(date = new Date()) {
  return new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function eventDefinition(key) {
  return SYSTEM_NOTIFICATION_EVENTS.find((item) => item.key === key) || null;
}

function defaultEventRules() {
  return SYSTEM_NOTIFICATION_EVENTS.reduce((rules, item) => {
    rules[item.key] = {
      enabled: true,
      panel: Boolean(item.defaults?.panel),
      email: Boolean(item.defaults?.email),
      whatsapp: Boolean(item.defaults?.whatsapp),
      severity: item.severity,
    };
    return rules;
  }, {});
}

function normalizeEventRules(value = {}) {
  const incoming = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const defaults = defaultEventRules();
  return SYSTEM_NOTIFICATION_EVENTS.reduce((rules, item) => {
    const current = incoming[item.key] && typeof incoming[item.key] === 'object'
      ? incoming[item.key]
      : {};
    rules[item.key] = {
      enabled: parseBoolean(current.enabled, defaults[item.key].enabled),
      panel: parseBoolean(current.panel, defaults[item.key].panel),
      email: parseBoolean(current.email, defaults[item.key].email),
      whatsapp: parseBoolean(current.whatsapp, defaults[item.key].whatsapp),
      severity: normalizeSeverity(current.severity, item.severity),
    };
    return rules;
  }, {});
}

function publicSender(asset, compliance = senderComplianceState(null)) {
  if (!asset) return null;
  const plain = asset.toJSON ? asset.toJSON() : asset;
  const health = whatsappAccountHealthService.summarizeAssetHealth(plain);
  const clinic = plain.clinica?.nombre_clinica || plain.clinicName || null;
  const group = plain.grupoClinica?.nombre_grupo || plain.groupName || null;
  return {
    id: Number(plain.id),
    label: plain.waVerifiedName || plain.metaAssetName || `WhatsApp ${plain.id}`,
    scope: plain.assignmentScope || null,
    clinicId: plain.clinicaId || null,
    clinicName: clinic,
    groupId: plain.grupoClinicaId || null,
    groupName: group,
    hasCredentials: Boolean(Number(plain.hasCredentials ?? plain.has_credentials) || plain.waAccessToken),
    hasPhoneNumberId: Boolean(plain.phoneNumberId),
    hasWaba: Boolean(plain.wabaId),
    quality: plain.quality_rating || null,
    messagingLimit: plain.messaging_limit || null,
    blocked: Boolean(compliance.blocked || health.can_send === false),
    operationalStatus: health.can_send === false ? health.state : compliance.operationalStatus,
    blockReason: health.can_send === false ? health.reason_code : compliance.blockReason,
    restrictionExpiresAt: compliance.restrictionExpiresAt,
    complianceIncidentId: compliance.complianceIncidentId,
    complianceReviewStatus: compliance.complianceReviewStatus,
  };
}

function publicSettings(setting) {
  const rules = normalizeEventRules(setting?.event_rules || {});
  return {
    enabled: Boolean(setting?.enabled),
    panelEnabled: Boolean(setting?.panel_enabled),
    emailEnabled: Boolean(setting?.email_enabled),
    whatsappEnabled: Boolean(setting?.whatsapp_enabled),
    adminEmail: setting?.admin_email || '',
    adminEmailLabel: maskEmail(setting?.admin_email),
    adminPhone: setting?.admin_phone || '',
    adminPhoneLabel: maskPhone(setting?.admin_phone),
    whatsappSenderAssetId: setting?.whatsapp_sender_asset_id || null,
    whatsappTemplateName: setting?.whatsapp_template_name || DEFAULT_TEMPLATE_NAME,
    whatsappTemplateLanguage: setting?.whatsapp_template_language || DEFAULT_TEMPLATE_LANGUAGE,
    throttleMinutes: Number(setting?.throttle_minutes || 60),
    eventRules: rules,
    lastCheckedAt: setting?.last_checked_at || null,
    lastTestedAt: setting?.last_tested_at || null,
  };
}

function serializeDelivery(row) {
  const plain = row?.toJSON ? row.toJSON() : (row || {});
  return {
    id: plain.id,
    eventKey: plain.event_key,
    severity: plain.severity,
    channel: plain.channel,
    status: plain.status,
    title: plain.title,
    message: plain.message,
    action: plain.action,
    recipientLabel: plain.recipient_label,
    recipientDomain: plain.recipient_domain,
    whatsappSenderAssetId: plain.whatsapp_sender_asset_id,
    whatsappTemplateName: plain.whatsapp_template_name,
    emailMessageId: plain.email_message_id,
    jobRequestId: plain.job_request_id,
    provider: plain.provider,
    providerMessageId: plain.provider_message_id,
    errorCode: plain.error_code,
    errorMessage: plain.error_message,
    metadata: plain.metadata || null,
    queuedAt: plain.queued_at,
    sentAt: plain.sent_at,
    failedAt: plain.failed_at,
    completedAt: plain.completed_at,
    createdAt: plain.created_at,
    updatedAt: plain.updated_at,
  };
}

async function ensureSettings() {
  const defaults = {
    scope: SETTINGS_SCOPE,
    enabled: parseBoolean(process.env.SYSTEM_NOTIFICATIONS_ENABLED, true),
    panel_enabled: parseBoolean(process.env.SYSTEM_NOTIFICATIONS_PANEL_ENABLED, true),
    email_enabled: parseBoolean(process.env.SYSTEM_NOTIFICATIONS_EMAIL_ENABLED, false),
    whatsapp_enabled: parseBoolean(process.env.SYSTEM_NOTIFICATIONS_WHATSAPP_ENABLED, false),
    admin_email: cleanString(process.env.SYSTEM_NOTIFICATIONS_ADMIN_EMAIL),
    admin_phone: cleanString(process.env.SYSTEM_NOTIFICATIONS_ADMIN_WHATSAPP),
    whatsapp_sender_asset_id: Number(process.env.SYSTEM_NOTIFICATIONS_WHATSAPP_SENDER_ASSET_ID || 0) || null,
    whatsapp_template_name: cleanString(process.env.SYSTEM_NOTIFICATIONS_WHATSAPP_TEMPLATE_NAME) || DEFAULT_TEMPLATE_NAME,
    whatsapp_template_language: cleanString(process.env.SYSTEM_NOTIFICATIONS_WHATSAPP_TEMPLATE_LANGUAGE) || DEFAULT_TEMPLATE_LANGUAGE,
    throttle_minutes: Math.max(5, Number(process.env.SYSTEM_NOTIFICATIONS_THROTTLE_MINUTES || 60) || 60),
    event_rules: defaultEventRules(),
  };
  const [setting] = await db.SystemNotificationSetting.findOrCreate({
    where: { scope: SETTINGS_SCOPE },
    defaults,
  });
  if (!setting.event_rules) {
    await setting.update({ event_rules: defaultEventRules() });
  }
  return setting;
}

async function listWhatsappSenders() {
  const rows = await db.ClinicMetaAsset.findAll({
    where: {
      assetType: 'whatsapp_phone_number',
      isActive: true,
    },
    include: [
      { model: db.Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica'], required: false },
      { model: db.GrupoClinica, as: 'grupoClinica', attributes: ['id_grupo', 'nombre_grupo'], required: false },
    ],
    attributes: [
      'id',
      'clinicaId',
      'grupoClinicaId',
      'assignmentScope',
      'metaAssetName',
      'waVerifiedName',
      'wabaId',
      'phoneNumberId',
      'quality_rating',
      'messaging_limit',
      'additionalData',
      [
        db.sequelize.literal(
          "CASE WHEN waAccessToken IS NOT NULL AND TRIM(waAccessToken) <> '' THEN 1 ELSE 0 END"
        ),
        'hasCredentials',
      ],
    ],
    order: [['updatedAt', 'DESC']],
  });
  const assetIds = rows.map((row) => Number(row.id)).filter((id) => Number.isInteger(id) && id > 0);
  const incidents = assetIds.length && db.WhatsappAccountComplianceIncident
    ? await db.WhatsappAccountComplianceIncident.findAll({
      where: {
        asset_id: { [Op.in]: assetIds },
        resolved_at: null,
      },
      order: [['occurred_at', 'DESC'], ['id', 'DESC']],
    })
    : [];
  const latestIncidentByAsset = new Map();
  for (const incident of incidents) {
    const assetId = Number(incident.asset_id);
    if (!latestIncidentByAsset.has(assetId)) latestIncidentByAsset.set(assetId, incident);
  }
  return rows.map((row) => publicSender(
    row,
    senderComplianceState(latestIncidentByAsset.get(Number(row.id)) || null)
  ));
}

async function resolveSenderAsset(assetId) {
  const parsed = Number(assetId || 0);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  return db.ClinicMetaAsset.findOne({
    where: {
      id: parsed,
      assetType: 'whatsapp_phone_number',
      isActive: true,
    },
  });
}

async function fetchRemoteTemplate({ wabaId, accessToken, name, language }) {
  if (!wabaId || !accessToken || !name) return null;
  const response = await metaClient.metaGet(`${encodeURIComponent(wabaId)}/message_templates`, {
    params: {
      limit: 100,
      fields: 'id,name,language,status,category,components',
    },
    accessToken,
    timeout: 15000,
    source: 'system_notifications',
    operation: 'whatsapp_template_status',
  });
  const items = Array.isArray(response.data?.data) ? response.data.data : [];
  return items.find((item) => (
    String(item?.name || '').trim() === name
    && String(item?.language || '').trim().toLowerCase() === String(language || DEFAULT_TEMPLATE_LANGUAGE).trim().toLowerCase()
  )) || null;
}

function shouldRefreshRemoteTemplate(template, { force = false } = {}) {
  if (force) return true;
  const status = String(template?.status || '').trim().toUpperCase();
  const ttl = APPROVED_TEMPLATE_STATUSES.has(status)
    ? TEMPLATE_REMOTE_SYNC_TTL_MS
    : TEMPLATE_REMOTE_PENDING_SYNC_TTL_MS;
  const lastSyncedAt = template?.last_synced_at || template?.lastSyncedAt;
  const last = lastSyncedAt ? new Date(lastSyncedAt).getTime() : 0;
  return !last || Number.isNaN(last) || Date.now() - last >= ttl;
}

function systemWhatsappTemplatePayload({ name, language = DEFAULT_TEMPLATE_LANGUAGE }) {
  return {
    name,
    language,
    category: 'UTILITY',
    components: [{
      type: 'BODY',
      text: [
        'Alerta operativa de Clinicaclick: {{1}}',
        'Revisa Monitorizacion del sistema.',
      ].join('\n'),
      example: {
        body_text: [[
          'Email: cola atascada. Severidad: Critica. Hay mensajes sin entregar desde hace mas de 15 minutos. Hora: 30/08/2026, 10:30. Accion: revisar el panel.',
        ]],
      },
    }],
  };
}

function systemWhatsappVariables() {
  return [
    {
      position: 1,
      name: 'resumen_operativo',
      example: 'Email: cola atascada. Severidad: Critica. Hay mensajes sin entregar desde hace mas de 15 minutos.',
      template_usage: SYSTEM_ADMIN_ALERT_USAGE,
    },
  ];
}

async function ensureSystemWhatsappTemplate({ submitToMeta = false } = {}) {
  const setting = await ensureSettings();
  const sender = await resolveSenderAsset(setting.whatsapp_sender_asset_id);
  if (!sender) {
    return { ok: false, reason: 'whatsapp_sender_missing', template: null };
  }
  if (!sender.wabaId || !sender.waAccessToken) {
    return { ok: false, reason: 'whatsapp_sender_credentials_missing', template: null };
  }

  const name = setting.whatsapp_template_name || DEFAULT_TEMPLATE_NAME;
  const language = setting.whatsapp_template_language || DEFAULT_TEMPLATE_LANGUAGE;
  let template = await db.WhatsappTemplate.findOne({
    where: {
      waba_id: sender.wabaId,
      name,
      language,
      is_active: true,
    },
    order: [['updatedAt', 'DESC']],
  });

  if (template && shouldRefreshRemoteTemplate(template, { force: submitToMeta })) {
    try {
      const remote = await fetchRemoteTemplate({
        wabaId: sender.wabaId,
        accessToken: sender.waAccessToken,
        name,
        language,
      });
      if (remote) {
        await template.update({
          category: remote.category || template.category || 'UTILITY',
          status: remote.status || template.status || 'PENDING',
          components: remote.components || template.components,
          meta_template_id: remote.id || template.meta_template_id || null,
          last_synced_at: new Date(),
        });
      }
    } catch (_error) {
      // El panel puede seguir mostrando el último estado local aunque Meta no responda.
    }
  }

  if (template) {
    return { ok: true, reason: null, template };
  }

  let remote = null;
  try {
    remote = await fetchRemoteTemplate({
      wabaId: sender.wabaId,
      accessToken: sender.waAccessToken,
      name,
      language,
    });
  } catch (_error) {
    if (!submitToMeta) {
      return { ok: false, reason: 'whatsapp_template_lookup_failed', template: null };
    }
  }

  if (!remote && submitToMeta) {
    const payload = systemWhatsappTemplatePayload({ name, language });
    const response = await axios.post(`${META_API_BASE_URL}/${sender.wabaId}/message_templates`, payload, {
      params: { access_token: sender.waAccessToken },
      timeout: 15000,
    });
    remote = {
      id: response.data?.id || null,
      name,
      language,
      status: response.data?.status || 'PENDING',
      category: 'UTILITY',
      components: payload.components,
    };
  }

  if (!remote) {
    return { ok: false, reason: 'whatsapp_template_missing', template: null };
  }

  template = await db.WhatsappTemplate.create({
    waba_id: sender.wabaId,
    clinic_id: sender.clinicaId || null,
    name,
    display_name: 'Alerta operativa Clinicaclick',
    language,
    category: remote.category || 'UTILITY',
    status: remote.status || 'PENDING',
    components: remote.components || systemWhatsappTemplatePayload({ name, language }).components,
    variables: systemWhatsappVariables(),
    meta_template_id: remote.id || null,
    created_by_user_id: ADMIN_USER_IDS[0] || null,
    origin: 'custom',
    is_active: true,
    last_synced_at: new Date(),
  });

  return { ok: true, reason: null, template };
}

function publicTemplateStatus(result) {
  const template = result?.template?.toJSON ? result.template.toJSON() : result?.template;
  if (!template) {
    return {
      configured: false,
      ready: false,
      reason: result?.reason || 'whatsapp_template_missing',
      name: DEFAULT_TEMPLATE_NAME,
      language: DEFAULT_TEMPLATE_LANGUAGE,
      status: null,
      id: null,
      category: null,
      usage: SYSTEM_ADMIN_ALERT_USAGE,
      lastSyncedAt: null,
      providerStatusUpdatedAt: null,
    };
  }
  const status = String(template.status || '').trim().toUpperCase();
  return {
    configured: true,
    ready: APPROVED_TEMPLATE_STATUSES.has(status),
    reason: result?.reason || null,
    id: template.id,
    name: template.name,
    language: template.language,
    status,
    category: template.category || null,
    usage: SYSTEM_ADMIN_ALERT_USAGE,
    metaTemplateId: template.meta_template_id || null,
    lastSyncedAt: template.last_synced_at || null,
    providerStatusUpdatedAt: template.provider_status_updated_at || null,
  };
}

async function getOverview() {
  const setting = await ensureSettings();
  const [senders, recentDeliveries, templateResult] = await Promise.all([
    listWhatsappSenders(),
    db.SystemNotificationDelivery.findAll({
      limit: 50,
      order: [['created_at', 'DESC']],
    }),
    ensureSystemWhatsappTemplate({ submitToMeta: false }).catch((error) => ({
      ok: false,
      reason: error?.code || error?.message || 'whatsapp_template_status_failed',
      template: null,
    })),
  ]);

  return {
    success: true,
    checkedAt: new Date().toISOString(),
    settings: publicSettings(setting),
    events: SYSTEM_NOTIFICATION_EVENTS,
    whatsappSenders: senders,
    whatsappTemplate: publicTemplateStatus(templateResult),
    recentDeliveries: recentDeliveries.map(serializeDelivery),
  };
}

async function updateSettings(payload = {}) {
  const setting = await ensureSettings();
  const currentRules = normalizeEventRules(setting.event_rules || {});
  const nextRules = normalizeEventRules(payload.eventRules || payload.event_rules || currentRules);
  const adminPhone = cleanString(payload.adminPhone ?? payload.admin_phone ?? setting.admin_phone);
  const normalizedAdminPhone = adminPhone ? (normalizePhoneE164(adminPhone) || adminPhone) : null;
  const hasCamelSender = Object.prototype.hasOwnProperty.call(payload, 'whatsappSenderAssetId');
  const hasSnakeSender = Object.prototype.hasOwnProperty.call(payload, 'whatsapp_sender_asset_id');
  const rawSenderAssetId = hasCamelSender
    ? payload.whatsappSenderAssetId
    : (hasSnakeSender ? payload.whatsapp_sender_asset_id : setting.whatsapp_sender_asset_id);
  const senderAssetId = rawSenderAssetId === null || rawSenderAssetId === '' || Number(rawSenderAssetId) === 0
    ? null
    : Number(rawSenderAssetId);
  if (senderAssetId !== null && (!Number.isInteger(senderAssetId) || senderAssetId <= 0)) {
    const error = new Error('whatsapp_sender_invalid');
    error.code = 'whatsapp_sender_invalid';
    error.status = 400;
    throw error;
  }
  if (senderAssetId) {
    const sender = await resolveSenderAsset(senderAssetId);
    if (!sender) {
      const error = new Error('whatsapp_sender_not_found');
      error.code = 'whatsapp_sender_not_found';
      error.status = 400;
      throw error;
    }
  }

  await setting.update({
    enabled: parseBoolean(payload.enabled, setting.enabled),
    panel_enabled: parseBoolean(payload.panelEnabled ?? payload.panel_enabled, setting.panel_enabled),
    email_enabled: parseBoolean(payload.emailEnabled ?? payload.email_enabled, setting.email_enabled),
    whatsapp_enabled: parseBoolean(payload.whatsappEnabled ?? payload.whatsapp_enabled, setting.whatsapp_enabled),
    admin_email: cleanString(payload.adminEmail ?? payload.admin_email ?? setting.admin_email),
    admin_phone: normalizedAdminPhone,
    whatsapp_sender_asset_id: senderAssetId,
    whatsapp_template_name: cleanString(payload.whatsappTemplateName ?? payload.whatsapp_template_name ?? setting.whatsapp_template_name) || DEFAULT_TEMPLATE_NAME,
    whatsapp_template_language: cleanString(payload.whatsappTemplateLanguage ?? payload.whatsapp_template_language ?? setting.whatsapp_template_language) || DEFAULT_TEMPLATE_LANGUAGE,
    throttle_minutes: Math.max(5, Number(payload.throttleMinutes ?? payload.throttle_minutes ?? setting.throttle_minutes ?? 60) || 60),
    event_rules: nextRules,
  });
  return getOverview();
}

function enabledChannelsForEvent(setting, eventKey, channelsOverride = null) {
  const rules = normalizeEventRules(setting.event_rules || {});
  const rule = rules[eventKey] || null;
  if (!setting.enabled || !rule?.enabled) return [];
  const candidates = channelsOverride && typeof channelsOverride === 'object' && !Array.isArray(channelsOverride)
    ? channelsOverride
    : {
      panel: Boolean(setting.panel_enabled && rule.panel),
      email: Boolean(setting.email_enabled && rule.email),
      whatsapp: Boolean(setting.whatsapp_enabled && rule.whatsapp),
    };
  return ['panel', 'email', 'whatsapp'].filter((channel) => Boolean(candidates[channel]));
}

async function recentlyQueued(
  eventKey,
  channel,
  throttleMinutes,
  statuses = ['queued', 'sending', 'sent', 'delivered', 'read']
) {
  if (!throttleMinutes) return false;
  const since = new Date(Date.now() - throttleMinutes * 60 * 1000);
  const count = await db.SystemNotificationDelivery.count({
    where: {
      event_key: eventKey,
      channel,
      status: { [Op.in]: statuses },
      created_at: { [Op.gte]: since },
    },
  });
  return count > 0;
}

async function createSkippedDelivery({ setting, eventKey, severity, channel, content, reason, metadata }) {
  const recipient = channel === 'email' ? setting.admin_email : (channel === 'whatsapp' ? setting.admin_phone : 'panel');
  return db.SystemNotificationDelivery.create({
    event_key: eventKey,
    severity,
    channel,
    status: 'skipped',
    title: content.title,
    message: content.message,
    action: content.action,
    recipient_hash: hashValue(recipient),
    recipient_label: channel === 'email' ? maskEmail(recipient) : (channel === 'whatsapp' ? maskPhone(recipient) : 'Panel admin'),
    recipient_domain: channel === 'email' ? recipientDomain(recipient) : null,
    whatsapp_sender_asset_id: channel === 'whatsapp' ? setting.whatsapp_sender_asset_id : null,
    whatsapp_template_name: channel === 'whatsapp' ? setting.whatsapp_template_name : null,
    provider: channel === 'panel' ? 'internal' : null,
    error_code: reason,
    error_message: reason,
    metadata,
    completed_at: new Date(),
  });
}

async function createQueuedDelivery({ setting, eventKey, severity, channel, content, metadata }) {
  return db.sequelize.transaction(async (transaction) => {
    const recipient = channel === 'email' ? setting.admin_email : (channel === 'whatsapp' ? setting.admin_phone : 'panel');
    const delivery = await db.SystemNotificationDelivery.create({
      event_key: eventKey,
      severity,
      channel,
      status: 'queued',
      title: content.title,
      message: content.message,
      action: content.action,
      recipient_hash: hashValue(recipient),
      recipient_label: channel === 'email' ? maskEmail(recipient) : (channel === 'whatsapp' ? maskPhone(recipient) : 'Panel admin'),
      recipient_domain: channel === 'email' ? recipientDomain(recipient) : null,
      whatsapp_sender_asset_id: channel === 'whatsapp' ? setting.whatsapp_sender_asset_id : null,
      whatsapp_template_name: channel === 'whatsapp' ? setting.whatsapp_template_name : null,
      metadata,
    }, { transaction });
    const job = await jobRequestsService.enqueueJobRequest({
      type: 'system_notification_dispatch',
      payload: { system_notification_delivery_id: delivery.id },
      priority: severity === 'critical' ? 'critical' : 'normal',
      origin: 'system_notifications',
      maxAttempts: channel === 'panel' ? 1 : 3,
    }, { transaction });
    await delivery.update({ job_request_id: job.id }, { transaction });
    return { delivery, job };
  });
}

function buildNotificationContent(eventKey, payload = {}) {
  const definition = eventDefinition(eventKey);
  const severity = normalizeSeverity(payload.severity, definition?.severity || 'info');
  if (eventKey === 'users.new_registration') {
    const userId = Number(payload.userId || payload.user_id || 0) || null;
    const domain = recipientDomain(payload.email || payload.email_usuario) || 'sin dominio';
    const origin = cleanString(payload.origin) || 'registro';
    return {
      severity,
      title: 'Nuevo registro de usuario',
      message: `Se ha creado una cuenta de usuario en Clinicaclick. Usuario #${userId || '-'} · dominio ${domain} · origen ${origin}.`,
      action: 'Revisar el usuario en administración si requiere asignación o validación.',
    };
  }
  if (eventKey === 'system.notification_test') {
    return {
      severity,
      title: safeText(payload.title, 120) || 'Prueba de notificación de sistema',
      message: safeText(payload.message, 320) || 'Esta prueba valida los canales configurados en Monitorización del sistema.',
      action: safeText(payload.action, 180) || 'No requiere acción.',
    };
  }
  return {
    severity,
    title: safeText(payload.title, 140) || definition?.label || 'Alerta de sistema',
    message: safeText(payload.message || payload.detail, 500) || definition?.description || 'Se ha detectado una condición que requiere revisión.',
    action: safeText(payload.action, 220) || 'Revisar Monitorización del sistema.',
  };
}

async function queueNotification({
  eventKey,
  payload = {},
  force = false,
  channelsOverride = null,
  metadata = {},
} = {}) {
  const definition = eventDefinition(eventKey);
  if (!definition) {
    const error = new Error('system_notification_event_unknown');
    error.code = 'system_notification_event_unknown';
    throw error;
  }
  const setting = await ensureSettings();
  const content = buildNotificationContent(eventKey, payload);
  const channels = enabledChannelsForEvent(setting, eventKey, channelsOverride);
  const created = [];
  const skipped = [];
  const enrichedMetadata = {
    ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
    source: metadata?.source || 'system_monitoring',
    dry_run: metadata?.dry_run === true,
  };

  for (const channel of channels) {
    const missingRecipient = (channel === 'email' && !cleanString(setting.admin_email))
      || (channel === 'whatsapp' && !cleanString(setting.admin_phone));
    const missingSender = channel === 'whatsapp' && !Number(setting.whatsapp_sender_asset_id || 0);
    if (missingRecipient || missingSender) {
      const reason = missingRecipient
        ? `missing_${channel}_recipient`
        : 'missing_whatsapp_sender';
      const delivery = await createSkippedDelivery({
        setting,
        eventKey,
        severity: content.severity,
        channel,
        content,
        reason,
        metadata: enrichedMetadata,
      });
      skipped.push({ reason, delivery });
      continue;
    }
    if (channel === 'whatsapp' && enrichedMetadata.dry_run !== true) {
      const compliance = await getSenderComplianceState(setting.whatsapp_sender_asset_id);
      if (compliance.blocked) {
        const restrictionStatuses = ['queued', 'sending', 'sent', 'delivered', 'read', 'failed', 'skipped'];
        if (!force && await recentlyQueued(
          eventKey,
          channel,
          Number(setting.throttle_minutes || 60),
          restrictionStatuses
        )) {
          skipped.push({ channel, reason: 'throttled_sender_restriction' });
          continue;
        }
        const reason = 'whatsapp_sender_account_restricted';
        const delivery = await createSkippedDelivery({
          setting,
          eventKey,
          severity: content.severity,
          channel,
          content,
          reason,
          metadata: {
            ...enrichedMetadata,
            whatsapp_sender_blocked: true,
            compliance_incident_id: compliance.complianceIncidentId,
            restriction_expires_at: compliance.restrictionExpiresAt,
          },
        });
        skipped.push({ reason, delivery });
        continue;
      }
    }
    if (!force && await recentlyQueued(eventKey, channel, Number(setting.throttle_minutes || 60))) {
      skipped.push({ channel, reason: 'throttled' });
      continue;
    }
    created.push(await createQueuedDelivery({
      setting,
      eventKey,
      severity: content.severity,
      channel,
      content,
      metadata: enrichedMetadata,
    }));
  }

  return {
    eventKey,
    channels,
    created: created.map((item) => ({ deliveryId: item.delivery.id, jobRequestId: item.job.id, channel: item.delivery.channel })),
    skipped: skipped.map((item) => ({ channel: item.delivery?.channel || item.channel, reason: item.reason, deliveryId: item.delivery?.id || null })),
  };
}

async function createPanelNotification(delivery) {
  const users = ADMIN_USER_IDS.length
    ? await db.Usuario.findAll({ where: { id_usuario: { [Op.in]: ADMIN_USER_IDS } } })
    : [];
  const notifications = [];
  for (const user of users) {
    const notification = await db.Notification.create({
      userId: user.id_usuario,
      role: 'admin',
      subrole: '',
      category: 'system',
      event: delivery.event_key,
      title: delivery.title,
      message: delivery.message,
      icon: 'heroicons_outline:bell-alert',
      level: delivery.severity === 'critical' ? 'error' : delivery.severity,
      data: {
        link: '/ajustes?panel=jobs-monitoring&tab=notifications',
        useRouter: true,
        systemNotificationDeliveryId: delivery.id,
        source: delivery.metadata?.source || 'system_monitoring',
      },
    });
    emitNotificationCreated(notification);
    notifications.push(notification.id);
  }
  return notifications;
}

async function sendEmailDelivery(delivery) {
  const setting = await ensureSettings();
  const result = await emailDelivery.queueEmail({
    stream: 'transactional',
    templateKey: 'ops.system_alert',
    templateVersion: 'v1',
    subjectKey: 'ops.system_alert',
    recipientEmail: setting.admin_email,
    recipientKind: 'admin_alert',
    relatedType: 'system_notification',
    relatedId: String(delivery.id),
    dedupeKey: `system-notification:${delivery.event_key}:email:${delivery.id}`,
    priority: delivery.severity === 'critical' ? 'high' : 'normal',
    origin: 'system_notifications',
    templateContext: {
      severity: delivery.severity,
      title: delivery.title,
      message: delivery.message,
      action: delivery.action,
      occurred_at: nowMadridLabel(),
    },
    metadata: {
      contains_clinical_data: false,
      system_notification_delivery_id: delivery.id,
      event_key: delivery.event_key,
    },
  });
  return result.emailMessage;
}

async function sendWhatsappDelivery(delivery) {
  if (delivery.metadata?.dry_run === true) {
    return { dryRun: true, messageId: `dry_run_${delivery.id}` };
  }
  const setting = await ensureSettings();
  const sender = await resolveSenderAsset(setting.whatsapp_sender_asset_id);
  if (!sender) {
    const error = new Error('whatsapp_sender_missing');
    error.code = 'whatsapp_sender_missing';
    throw error;
  }
  const compliance = await getSenderComplianceState(sender.id);
  if (compliance.blocked) {
    const expires = compliance.restrictionExpiresAt
      ? ` hasta ${compliance.restrictionExpiresAt}`
      : '';
    const error = new Error(`Meta restringe los mensajes iniciados por este remitente${expires}`);
    error.code = 'whatsapp_sender_account_restricted';
    error.retryable = false;
    error.deliveryStatus = 'failed';
    throw error;
  }
  const templateResult = await ensureSystemWhatsappTemplate({ submitToMeta: false });
  const templateStatus = publicTemplateStatus(templateResult);
  if (!templateStatus.ready) {
    const error = new Error(templateStatus.reason || 'whatsapp_template_not_approved');
    error.code = templateStatus.reason || 'whatsapp_template_not_approved';
    error.retryable = false;
    throw error;
  }
  const to = normalizePhoneE164(setting.admin_phone);
  if (!to) {
    const error = new Error('admin_whatsapp_invalid');
    error.code = 'admin_whatsapp_invalid';
    error.retryable = false;
    throw error;
  }
  const summary = [
    truncateForProvider(delivery.title, 100),
    `Severidad: ${delivery.severity === 'critical' ? 'Critica' : (delivery.severity === 'warning' ? 'Aviso' : 'Info')}`,
    truncateForProvider(delivery.message, 320),
    `Hora: ${nowMadridLabel()}`,
    `Accion: ${truncateForProvider(delivery.action || 'Revisar Monitorizacion del sistema.', 140)}`,
  ].filter(Boolean).join('. ');
  const response = await whatsappService.sendMessage({
    to,
    useTemplate: true,
    templateName: setting.whatsapp_template_name,
    templateLanguage: setting.whatsapp_template_language || DEFAULT_TEMPLATE_LANGUAGE,
    templateParams: [truncateForProvider(summary, 900)],
    clinicConfig: {
      originId: sender.id,
      phoneNumberId: sender.phoneNumberId,
      accessToken: sender.waAccessToken,
      wabaId: sender.wabaId,
      assignmentScope: sender.assignmentScope,
      clinicaId: sender.clinicaId || null,
      grupoClinicaId: sender.grupoClinicaId || null,
      additionalData: sender.additionalData || {},
    },
    healthContext: {
      source: 'system_notification_dispatch',
      jobId: `system-notification:${delivery.id}`,
    },
  });
  return response;
}

function sanitizeWhatsappProviderErrors(errors) {
  return (Array.isArray(errors) ? errors : []).slice(0, 3).map((error) => ({
    code: cleanString(error?.code || error?.error_subcode),
    title: safeText(error?.title, 160),
    message: safeText(error?.message, 240),
    details: safeText(error?.error_data?.details || error?.details, 320),
  }));
}

async function recordSystemWhatsappProviderEvent({ delivery, providerStatus, occurredAt, providerErrors }) {
  if (!db.WhatsappDeliveryEvent) return null;
  const asset = delivery.whatsapp_sender_asset_id
    ? await db.ClinicMetaAsset.findByPk(delivery.whatsapp_sender_asset_id, {
      attributes: ['wabaId', 'phoneNumberId'],
    })
    : null;
  const dedupeKey = crypto.createHash('sha256').update([
    'system-notification',
    delivery.id,
    delivery.provider_message_id,
    providerStatus,
    occurredAt.toISOString(),
  ].join(':')).digest('hex');
  const firstError = providerErrors[0] || null;
  const [event] = await db.WhatsappDeliveryEvent.findOrCreate({
    where: { dedupe_key: dedupeKey },
    defaults: {
      dedupe_key: dedupeKey,
      event_type: `message_${providerStatus}`,
      source: 'message_status_webhook',
      severity: providerStatus === 'failed' ? 'error' : 'info',
      waba_id: asset?.wabaId || null,
      phone_number_id: asset?.phoneNumberId || null,
      template_name: delivery.whatsapp_template_name || null,
      status: providerStatus,
      reason_code: firstError?.code || null,
      payload: {
        provider_message_id: delivery.provider_message_id,
        errors: providerErrors,
        system_notification_delivery_id: delivery.id,
      },
      occurred_at: occurredAt,
    },
  });
  return event;
}

async function materializeWhatsappProviderStatus({
  providerMessageId,
  providerStatus,
  providerTimestamp = null,
  errors = [],
} = {}) {
  const messageId = cleanString(providerMessageId);
  const status = String(cleanString(providerStatus) || '').toLowerCase();
  if (!messageId || !WHATSAPP_PROVIDER_STATUSES.has(status)) {
    return { matched: false, reason: 'invalid_provider_status' };
  }
  const delivery = await db.SystemNotificationDelivery.findOne({
    where: {
      channel: 'whatsapp',
      provider: 'whatsapp_cloud_api',
      provider_message_id: messageId,
    },
    order: [['id', 'DESC']],
  });
  if (!delivery) return { matched: false, reason: 'delivery_not_found' };

  const occurredAt = parseProviderDate(providerTimestamp);
  const providerErrors = sanitizeWhatsappProviderErrors(errors);
  const currentStatus = String(cleanString(delivery.status) || '').toLowerCase();
  const successfulTerminal = new Set(['delivered', 'read']);
  const terminal = currentStatus === 'failed' || successfulTerminal.has(currentStatus);
  const shouldApply = !terminal || currentStatus === status;
  if (shouldApply) {
    const firstError = providerErrors[0] || null;
    const nextMetadata = {
      ...(delivery.metadata && typeof delivery.metadata === 'object' && !Array.isArray(delivery.metadata)
        ? delivery.metadata
        : {}),
      whatsapp_provider_status: status,
      whatsapp_provider_status_at: occurredAt.toISOString(),
      whatsapp_provider_error_codes: providerErrors.map((error) => error.code).filter(Boolean),
    };
    const patch = {
      status,
      metadata: nextMetadata,
    };
    if (status === 'failed') {
      patch.error_code = firstError?.code ? `whatsapp_provider_${firstError.code}` : 'whatsapp_provider_failed';
      patch.error_message = safeText(
        [firstError?.title, firstError?.details || firstError?.message].filter(Boolean).join(' · ')
          || 'Meta notificó un fallo de entrega',
        500
      );
      patch.failed_at = occurredAt;
      patch.completed_at = occurredAt;
    } else {
      patch.error_code = null;
      patch.error_message = null;
      patch.failed_at = null;
      if (!delivery.sent_at) patch.sent_at = occurredAt;
      if (successfulTerminal.has(status)) patch.completed_at = occurredAt;
    }
    await delivery.update(patch);
  }

  await recordSystemWhatsappProviderEvent({
    delivery,
    providerStatus: status,
    occurredAt,
    providerErrors,
  });
  return {
    matched: true,
    applied: shouldApply,
    deliveryId: delivery.id,
    status: shouldApply ? status : currentStatus,
  };
}

async function runDispatchJob(payload = {}) {
  const deliveryId = Number(payload.system_notification_delivery_id || payload.delivery_id || 0);
  if (!Number.isInteger(deliveryId) || deliveryId <= 0) {
    throw new Error('system_notification_dispatch requires payload.system_notification_delivery_id');
  }
  const delivery = await db.SystemNotificationDelivery.findByPk(deliveryId);
  if (!delivery) {
    return { status: 'completed', result: { skipped: true, reason: 'delivery_not_found', delivery_id: deliveryId } };
  }
  if (['sent', 'skipped'].includes(delivery.status)) {
    return {
      status: 'completed',
      result: { delivery_id: delivery.id, already_terminal: true, delivery_status: delivery.status },
    };
  }

  if (delivery.channel === 'email' && delivery.email_message_id) {
    const emailMessage = await db.EmailMessage.findByPk(delivery.email_message_id);
    if (emailMessage) {
      return {
        status: 'completed',
        result: {
          delivery_id: delivery.id,
          channel: 'email',
          email_message_id: emailMessage.id,
          already_enqueued: true,
          email_status: emailMessage.status,
        },
      };
    }
  }

  await delivery.update({ status: 'sending', error_code: null, error_message: null });
  try {
    if (delivery.channel === 'panel') {
      const notificationIds = await createPanelNotification(delivery);
      await delivery.update({
        status: 'sent',
        provider: 'internal',
        provider_message_id: notificationIds.join(','),
        sent_at: new Date(),
        completed_at: new Date(),
      });
      return { status: 'completed', result: { delivery_id: delivery.id, channel: 'panel', notification_ids: notificationIds } };
    }

    if (delivery.channel === 'email') {
      const emailMessage = await sendEmailDelivery(delivery);
      await delivery.update({
        status: 'queued',
        provider: 'email_outbox',
        provider_message_id: null,
        email_message_id: emailMessage.id,
        sent_at: null,
        completed_at: null,
      });
      return { status: 'completed', result: { delivery_id: delivery.id, channel: 'email', email_message_id: emailMessage.id } };
    }

    if (delivery.channel === 'whatsapp') {
      const response = await sendWhatsappDelivery(delivery);
      const messageId = response?.messages?.[0]?.id || response?.messageId || null;
      await delivery.update({
        status: 'sent',
        provider: response?.dryRun ? 'whatsapp_dry_run' : 'whatsapp_cloud_api',
        provider_message_id: messageId,
        sent_at: new Date(),
        completed_at: new Date(),
      });
      return { status: 'completed', result: { delivery_id: delivery.id, channel: 'whatsapp', provider_message_id: messageId } };
    }

    const error = new Error('system_notification_channel_unknown');
    error.code = 'system_notification_channel_unknown';
    throw error;
  } catch (error) {
    const retryable = error?.retryable !== false;
    const deliveryStatus = retryable || error?.deliveryStatus === 'failed' ? 'failed' : 'skipped';
    await delivery.update({
      status: deliveryStatus,
      error_code: error?.code || 'system_notification_dispatch_failed',
      error_message: safeText(error?.message || error, 500),
      failed_at: new Date(),
      completed_at: retryable ? null : new Date(),
    });
    return {
      status: retryable ? 'failed' : 'completed',
      retryable,
      error: retryable ? error : null,
      result: {
        delivery_id: delivery.id,
        channel: delivery.channel,
        error_code: error?.code || 'system_notification_dispatch_failed',
      },
    };
  }
}

async function runActiveChecks({ force = false } = {}) {
  const emailMonitoring = require('./emailMonitoring.service');
  const setting = await ensureSettings();
  const overview = await emailMonitoring.getOverview();
  const alerts = Array.isArray(overview?.alerts) ? overview.alerts : [];
  const queued = [];
  for (const alert of alerts) {
    const eventKey = cleanString(alert.key);
    if (!eventKey || !eventDefinition(eventKey)) continue;
    queued.push(await queueNotification({
      eventKey,
      payload: {
        severity: alert.severity,
        title: alert.title,
        detail: alert.detail,
        action: alert.action,
      },
      force,
      metadata: { source: 'email_monitoring' },
    }));
  }
  await setting.update({ last_checked_at: new Date() });
  return {
    status: 'completed',
    checkedAt: new Date().toISOString(),
    alertCount: alerts.length,
    queued,
  };
}

async function notifyUserRegistration({ user, origin = 'auth.sign_up', force = false } = {}) {
  if (!user) return null;
  const plain = user.toJSON ? user.toJSON() : user;
  return queueNotification({
    eventKey: 'users.new_registration',
    payload: {
      userId: plain.id_usuario,
      email: plain.email_usuario,
      origin,
      severity: 'info',
    },
    force,
    metadata: { source: origin },
  });
}

module.exports = {
  SYSTEM_ADMIN_ALERT_USAGE,
  SYSTEM_NOTIFICATION_EVENTS,
  buildNotificationContent,
  defaultEventRules,
  ensureSettings,
  ensureSystemWhatsappTemplate,
  getOverview,
  listWhatsappSenders,
  materializeWhatsappProviderStatus,
  notifyUserRegistration,
  queueNotification,
  runActiveChecks,
  runDispatchJob,
  serializeDelivery,
  updateSettings,
  _test: {
    enabledChannelsForEvent,
    fetchRemoteTemplate,
    maskEmail,
    maskPhone,
    normalizeEventRules,
    publicTemplateStatus,
    safeText,
    senderComplianceState,
    shouldRefreshRemoteTemplate,
    systemWhatsappTemplatePayload,
  },
};
