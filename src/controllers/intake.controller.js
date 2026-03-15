const crypto = require('crypto');
const axios = require('axios');
const asyncHandler = require('express-async-handler');
const db = require('../../models');
const { Op, literal } = db.Sequelize;

const LeadIntake = db.LeadIntake;
const LeadAttributionAudit = db.LeadAttributionAudit;
const FormSubmissionEvent = db.FormSubmissionEvent;
const Conversation = db.Conversation;
const Message = db.Message;
const Usuario = db.Usuario;
const Clinica = db.Clinica;
const GrupoClinica = db.GrupoClinica;
const Campana = db.Campana;
const AdCache = db.AdCache;
const ClinicMetaAsset = db.ClinicMetaAsset;
const ClinicGoogleAdsAccount = db.ClinicGoogleAdsAccount;
const IntakeConfig = db.IntakeConfig;
const { enqueueInboundFormSubmissionResume } = require('../services/automationsV2Resume.service');
const { sendMetaEvent, buildUserData: buildMetaUserData } = require('../services/metaCapi.service');
const { uploadClickConversion } = require('../services/googleAdsConversion.service');
const { getIO } = require('../services/socket.service');

const CHANNELS = new Set(['paid', 'organic', 'unknown']);
const SOURCES = new Set(['meta_ads', 'google_ads', 'web', 'whatsapp', 'call_click', 'tiktok_ads', 'seo', 'direct', 'local_services']);
const STATUSES = new Set(['nuevo', 'contactado', 'esperando_info', 'info_recibida', 'citado', 'acudio_cita', 'convertido', 'descartado']);
const DEDUPE_WINDOW_HOURS = parseInt(process.env.INTAKE_DEDUPE_WINDOW_HOURS || '24', 10);

const SIGNATURE_HEADER = 'x-cc-signature';
const SIGNATURE_HEADER_SHA = 'x-cc-signature-sha256';
const EVENT_ID_HEADER = 'x-cc-event-id';
const parseInteger = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};
const cleanString = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
};
const buildActorLabel = (usuario) => {
  if (!usuario) return 'Sistema';
  return usuario.email_usuario
    || [usuario.nombre, usuario.apellidos].filter(Boolean).join(' ').trim()
    || `Usuario ${usuario.id_usuario}`;
};
// Acepta IDs separados por coma (ej: "36,37,38") y también "all" (=> null, sin filtro).
const parseIntegerList = (value) => {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (raw.toLowerCase() === 'all') return null;
  const parts = raw.split(',').map(p => p.trim()).filter(Boolean);
  const ids = [];
  for (const part of parts) {
    const n = parseInteger(part);
    if (n !== null) ids.push(n);
  }
  const unique = Array.from(new Set(ids));
  return unique.length ? unique : null;
};
const coalesce = (...values) => values.find(v => v !== undefined && v !== null);

const toPlain = (row) => (row && typeof row.get === 'function' ? row.get({ plain: true }) : row);

const hashValue = (value) => {
  if (!value) return null;
  return crypto.createHash('sha256').update(value).digest('hex');
};

const normalizeEmail = (email) => (email || '').trim().toLowerCase() || null;
const normalizePhone = (phone) => {
  if (!phone) return null;
  const digits = String(phone).replace(/\D/g, '');
  return digits || null;
};

const resolveClinicIdsForSocket = async ({ clinicId, groupId }) => {
  const parsedClinicId = parseInteger(clinicId);
  if (parsedClinicId !== null) {
    return [parsedClinicId];
  }

  const parsedGroupId = parseInteger(groupId);
  if (parsedGroupId === null) {
    return [];
  }

  const clinics = await Clinica.findAll({
    where: { grupoClinicaId: parsedGroupId },
    attributes: ['id_clinica'],
    raw: true,
  });

  return clinics
    .map((row) => parseInteger(row.id_clinica))
    .filter((id) => id !== null);
};

const emitLeadSocketEvent = async (eventName, payload, { clinicId, groupId } = {}) => {
  const io = getIO();
  if (!io) return;

  const clinicIds = await resolveClinicIdsForSocket({ clinicId, groupId });
  if (!clinicIds.length) return;

  const uniqueClinicIds = Array.from(new Set(clinicIds));
  uniqueClinicIds.forEach((id) => {
    io.to(`clinic:${id}`).emit(eventName, payload);
  });
};

const buildLeadCreatedSocketPayload = (lead) => {
  const plain = toPlain(lead);
  return {
    type: 'created',
    lead_id: plain.id,
    clinic_id: plain.clinica_id || null,
    group_id: plain.grupo_clinica_id || null,
    campaign_id: plain.campana_id || null,
    source: plain.source || null,
    source_detail: plain.source_detail || null,
    channel: plain.channel || null,
    status_lead: plain.status_lead || 'nuevo',
    nombre: plain.nombre || null,
    email: plain.email || null,
    telefono: plain.telefono || null,
    page_url: plain.page_url || null,
    created_at: plain.created_at instanceof Date ? plain.created_at.toISOString() : String(plain.created_at || ''),
    emitted_at: new Date().toISOString(),
  };
};

const buildLeadCallInitiatedSocketPayload = ({ lead, clinicId, groupId, clickedTel, pageUrl, source, sourceDetail, linkedBy = 'lead_id' }) => {
  const plain = toPlain(lead);
  const callInitiatedAt = plain.call_initiated_at instanceof Date
    ? plain.call_initiated_at.toISOString()
    : String(plain.call_initiated_at || new Date().toISOString());

  return {
    type: 'call_initiated',
    lead_id: plain.id,
    clinic_id: parseInteger(clinicId) || plain.clinica_id || null,
    group_id: parseInteger(groupId) || plain.grupo_clinica_id || null,
    emitted_at: new Date().toISOString(),
    call_initiated: true,
    call_initiated_at: callInitiatedAt,
    clicked_tel: clickedTel || null,
    page_url: pageUrl || plain.page_url || null,
    source: source || plain.source || 'web',
    source_detail: sourceDetail || 'tel_modal_call',
    linked_by: linkedBy,
  };
};

const buildLeadCallOutcomeSocketPayload = ({ lead, clinicId, groupId }) => {
  const plain = toPlain(lead);
  return {
    type: 'call_outcome',
    lead_id: plain.id,
    clinic_id: parseInteger(clinicId) || plain.clinica_id || null,
    group_id: parseInteger(groupId) || plain.grupo_clinica_id || null,
    emitted_at: new Date().toISOString(),
    call_initiated: !!plain.call_initiated,
    call_initiated_at: plain.call_initiated_at instanceof Date ? plain.call_initiated_at.toISOString() : String(plain.call_initiated_at || ''),
    call_outcome: plain.call_outcome || null,
    call_outcome_at: plain.call_outcome_at instanceof Date ? plain.call_outcome_at.toISOString() : String(plain.call_outcome_at || ''),
    call_outcome_notes: plain.call_outcome_notes || null,
    call_outcome_appointment_id: plain.call_outcome_appointment_id || null,
  };
};

const resolveClinicByPhoneWithinGroup = async (groupId, phone) => {
  const parsedGroupId = parseInteger(groupId);
  const normalizedPhone = normalizePhone(phone);
  if (parsedGroupId === null || !normalizedPhone) {
    return null;
  }

  const clinics = await Clinica.findAll({
    where: { grupoClinicaId: parsedGroupId },
    attributes: ['id_clinica', 'grupoClinicaId', 'telefono'],
    raw: true,
  });

  return clinics.find((clinic) => normalizePhone(clinic.telefono) === normalizedPhone) || null;
};

const CALL_OUTCOMES = new Set(['citado', 'informacion', 'no_contactado']);

const pickMatchingIntakeConfig = ({ req, providedSignature, clinicCfg, groupCfg, domainCfg }) => {
  const candidates = [clinicCfg, groupCfg, domainCfg].filter(Boolean);
  if (!candidates.length) return null;

  if (providedSignature) {
    const matched = candidates.find((cfg) => cfg.hmac_key && validateHmac(req, cfg.hmac_key, providedSignature));
    if (matched) {
      return matched;
    }
  }

  return clinicCfg || groupCfg || domainCfg || null;
};
// Número de WhatsApp "público" para wa.me (dígitos, con prefijo de país si existe).
// En ClinicMetaAssets solemos tenerlo en additionalData.displayPhoneNumber o en metaAssetName.
const extractWhatsAppNumber = (asset) => {
  if (!asset) return null;
  const additional = asset.additionalData && typeof asset.additionalData === 'object' ? asset.additionalData : {};
  const raw =
    additional.displayPhoneNumber ||
    additional.display_phone_number ||
    asset.metaAssetName ||
    null;
  return normalizePhone(raw);
};
const normalizeDomain = (domain) => {
  if (!domain || typeof domain !== 'string') return null;
  const d = domain.trim().toLowerCase();
  if (!d) return null;
  // Evitar valores con punto final (p. ej. "example.com.")
  return d.endsWith('.') ? d.slice(0, -1) : d;
};
const stripWww = (host) => (host && host.startsWith('www.') ? host.slice(4) : host);
const isDomainAllowed = (allowlist, domain) => {
  // Sin allowlist configurada => permitido
  if (!Array.isArray(allowlist) || allowlist.length === 0) return true;
  const host = normalizeDomain(domain);
  if (!host) return false;

  for (const rawEntry of allowlist) {
    const entry = normalizeDomain(String(rawEntry || ''));
    if (!entry) continue;
    if (entry === '*') return true;

    // Soporte básico de wildcard "*.example.com" (equivale a cualquier subdominio, incluyendo "www")
    if (entry.startsWith('*.')) {
      const root = entry.slice(2);
      if (!root) continue;
      if (host === root || host.endsWith('.' + root)) return true;
      continue;
    }

    // Por defecto: "example.com" permite:
    // - example.com
    // - www.example.com
    // - cualquier subdominio (*.example.com)
    const root = stripWww(entry);
    if (host === entry || host === root || host === 'www.' + root) return true;
    if (host.endsWith('.' + root)) return true;
  }

  return false;
};
const parseDate = (value) => {
  const d = value ? new Date(value) : null;
  return d && !isNaN(d.getTime()) ? d : null;
};

// Normaliza textos para evitar caracteres “exóticos” (p. ej. tipografías bold de unicode)
const sanitizeText = (value) => {
  if (!value || typeof value !== 'string') return value;
  return value
    .normalize('NFKD')              // descompone caracteres estilizados
    .replace(/[^\p{L}\p{N}\s.,@'+-]/gu, '') // deja letras, números y signos básicos
    .trim();
};

const sanitizeLeadNoteText = (value) => {
  if (!value || typeof value !== 'string') return value;
  return value
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s.,@'+\-:/?&=#()%_]/gu, '')
    .trim();
};

const LEAD_SOURCE_LABELS = {
  web: 'web',
  google_ads: 'Google Ads',
  meta_ads: 'Meta Ads',
  tiktok_ads: 'TikTok Ads',
  whatsapp: 'WhatsApp',
  call_click: 'llamada',
  seo: 'SEO',
  direct: 'directo',
  local_services: 'Local Services',
};

const LEAD_SOURCE_DETAIL_LABELS = {
  tel_modal: 'web por teléfono',
  tel_modal_call: 'llamada desde la web',
  web_form: 'formulario web',
  chat: 'chat web',
  whatsapp_inbound: 'WhatsApp',
};

const buildLeadCreatedDescription = (lead) => {
  const detailKey = cleanString(lead?.source_detail);
  const sourceKey = cleanString(lead?.source);
  const detailLabel = detailKey ? LEAD_SOURCE_DETAIL_LABELS[detailKey] : null;
  if (detailLabel) {
    return `Origen: ${detailLabel}`;
  }
  const sourceLabel = sourceKey ? LEAD_SOURCE_LABELS[sourceKey] || sourceKey : null;
  if (sourceLabel) {
    return `Origen: ${sourceLabel}`;
  }
  return 'Nuevo lead';
};

const sanitizeFormSubmissionValue = (value, depth = 0) => {
  if (depth > 3) return null;
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const normalized = value.normalize('NFKC').trim();
    return normalized.length > 2000 ? normalized.slice(0, 2000) : normalized;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => sanitizeFormSubmissionValue(item, depth + 1))
      .filter((item) => item !== null);
  }
  if (typeof value === 'object') {
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      const normalized = sanitizeFormSubmissionValue(item, depth + 1);
      if (normalized !== null) out[key] = normalized;
    }
    return out;
  }
  return null;
};

const normalizeFormSubmission = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const fields = input.fields && typeof input.fields === 'object' && !Array.isArray(input.fields)
    ? sanitizeFormSubmissionValue(input.fields)
    : {};
  return {
    page_url: cleanString(input.page_url || input.pageUrl),
    form_id: cleanString(input.form_id || input.formId),
    form_name: cleanString(input.form_name || input.formName),
    form_selector: cleanString(input.form_selector || input.formSelector),
    submitted_at: parseDate(input.submitted_at || input.submittedAt) || new Date(),
    fields: fields && typeof fields === 'object' && !Array.isArray(fields) ? fields : {},
    payload: sanitizeFormSubmissionValue(input.payload || null),
  };
};

const extractLeadDataFromFormFields = (fields) => {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    return {};
  }

  const entries = Object.entries(fields)
    .map(([key, value]) => [String(key || '').trim(), cleanString(value)] )
    .filter(([key, value]) => key && value);

  const findValue = (matcher) => {
    const hit = entries.find(([key]) => matcher(key.toLowerCase()));
    return hit?.[1] || null;
  };

  const findByValue = (matcher) => {
    const hit = entries.find(([, value]) => matcher(String(value || '').trim()));
    return hit?.[1] || null;
  };

  const email =
    findValue((key) => key.includes('email') || key.includes('correo')) ||
    findByValue((value) => /.+@.+\..+/.test(value));

  const phone =
    findValue((key) => key.includes('phone') || key.includes('telefono') || key.includes('teléfono') || key.includes('mobile') || key.includes('movil') || key.includes('móvil') || key.includes('whatsapp')) ||
    (() => {
      const messageLike = findValue((key) => key.includes('message') || key.includes('mensaje'));
      if (messageLike && normalizePhone(messageLike)) return messageLike;
      return null;
    })() ||
    findByValue((value) => !!normalizePhone(value));

  const nombre =
    findValue((key) => key.includes('full_name') || key.includes('nombre_completo')) ||
    findValue((key) => (key.includes('name') || key.includes('nombre')) && !key.includes('company') && !key.includes('empresa'));

  return {
    nombre,
    email,
    telefono: phone,
  };
};

const stableStringify = (obj) => {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
};

const cleanGoogleCustomerId = (value) => {
  if (value === undefined || value === null) return null;
  const clean = String(value).replace(/\D/g, '');
  return clean || null;
};

const GOOGLE_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;
const toGoogleAdsDateTime = (value) => {
  if (typeof value === 'string' && GOOGLE_DATETIME_REGEX.test(value.trim())) {
    return value.trim();
  }
  const parsed = parseDate(value) || new Date();
  const d = parsed;
  const pad = (n) => String(n).padStart(2, '0');
  const year = d.getFullYear();
  const month = pad(d.getMonth() + 1);
  const day = pad(d.getDate());
  const hours = pad(d.getHours());
  const minutes = pad(d.getMinutes());
  const seconds = pad(d.getSeconds());
  const offsetMinutes = -d.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  const tzH = pad(Math.floor(abs / 60));
  const tzM = pad(abs % 60);
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}${sign}${tzH}:${tzM}`;
};

const normalizeGoogleConsent = (consent) => {
  if (consent === undefined || consent === null) return null;
  const fromValue = (v) => {
    if (v === undefined || v === null) return null;
    if (typeof v === 'boolean') return v ? 'GRANTED' : 'DENIED';
    const s = String(v).trim().toLowerCase();
    if (!s) return null;
    if (['granted', 'grant', 'accepted', 'accept', 'yes', 'true', '1', 'optin', 'opt_in'].includes(s)) return 'GRANTED';
    if (['denied', 'deny', 'rejected', 'reject', 'no', 'false', '0', 'optout', 'opt_out'].includes(s)) return 'DENIED';
    return null;
  };
  if (typeof consent !== 'object' || Array.isArray(consent)) {
    return fromValue(consent);
  }
  return fromValue(
    consent.ad_user_data ??
    consent.adUserData ??
    consent.marketing ??
    consent.analytics ??
    consent.value
  );
};

const parseSendToActionId = (sendTo) => {
  if (!sendTo) return null;
  const parts = String(sendTo).trim().split('/');
  if (parts.length < 2) return null;
  const maybeId = String(parts[1] || '').trim();
  if (/^\d+$/.test(maybeId)) return maybeId;
  return null;
};

const buildConversionActionResource = ({ customerId, conversionAction, conversionActionId, sendTo }) => {
  const cleanCustomer = cleanGoogleCustomerId(customerId);
  const rawAction = conversionAction ? String(conversionAction).trim() : '';
  if (rawAction.startsWith('customers/')) return rawAction;
  if (/^\d+$/.test(rawAction) && cleanCustomer) {
    return `customers/${cleanCustomer}/conversionActions/${rawAction}`;
  }

  const actionId =
    (conversionActionId && /^\d+$/.test(String(conversionActionId).trim()) ? String(conversionActionId).trim() : null) ||
    parseSendToActionId(sendTo);
  if (actionId && cleanCustomer) {
    return `customers/${cleanCustomer}/conversionActions/${actionId}`;
  }
  return null;
};

const normalizeGoogleAdsConfig = (rawConfig) => {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) return {};
  return {
    ...rawConfig,
    customer_id: cleanGoogleCustomerId(rawConfig.customer_id) || rawConfig.customer_id || null,
    conversion_action: rawConfig.conversion_action || null,
    conversion_action_id: rawConfig.conversion_action_id || null,
    send_to: rawConfig.send_to || null,
    currency: rawConfig.currency || null
  };
};

const getGoogleAdsEventConfig = (googleAdsCfg, eventName) => {
  const eventKey = String(eventName || '').trim().toLowerCase();
  const mapped =
    eventKey === 'contact' ? 'contact'
      : eventKey === 'schedule' ? 'schedule'
        : eventKey === 'purchase' ? 'purchase'
          : 'lead';

  const nested = googleAdsCfg?.events && typeof googleAdsCfg.events === 'object'
    ? (googleAdsCfg.events[mapped] || {})
    : {};

  return {
    enabled: nested.enabled !== undefined ? !!nested.enabled : (googleAdsCfg.enabled !== false),
    customer_id: cleanGoogleCustomerId(
      nested.customer_id ??
      googleAdsCfg[`${mapped}_customer_id`] ??
      googleAdsCfg.customer_id ??
      process.env.GOOGLE_ADS_CUSTOMER_ID
    ),
    conversion_action:
      nested.conversion_action ??
      googleAdsCfg[`${mapped}_conversion_action`] ??
      googleAdsCfg.conversion_action ??
      null,
    conversion_action_id:
      nested.conversion_action_id ??
      googleAdsCfg[`${mapped}_conversion_action_id`] ??
      googleAdsCfg.conversion_action_id ??
      null,
    send_to:
      nested.send_to ??
      googleAdsCfg[`${mapped}_send_to`] ??
      googleAdsCfg.send_to ??
      null,
    value: coalesce(
      nested.value,
      googleAdsCfg[`${mapped}_value`],
      googleAdsCfg.value,
      mapped === 'purchase' ? null : 0
    ),
    currency: coalesce(
      nested.currency,
      googleAdsCfg[`${mapped}_currency`],
      googleAdsCfg.currency,
      'EUR'
    ),
    consent: normalizeGoogleConsent(
      nested.consent ??
      googleAdsCfg[`${mapped}_consent`] ??
      googleAdsCfg.consent
    )
  };
};

const maybeUploadGoogleConversion = async ({
  cfgRecord,
  eventName,
  customData,
  userData,
  consent,
  eventId
}) => {
  const cfgObj = cfgRecord && typeof cfgRecord.config === 'object' ? cfgRecord.config : {};
  const googleCfg = normalizeGoogleAdsConfig(cfgObj.google_ads || {});
  const eventCfg = getGoogleAdsEventConfig(googleCfg, eventName);

  if (!eventCfg.enabled) {
    return { sent: false, reason: 'google_ads_disabled' };
  }

  const gclid = customData.gclid || null;
  const gbraid = customData.gbraid || null;
  const wbraid = customData.wbraid || null;
  if (!gclid && !gbraid && !wbraid) {
    return { sent: false, reason: 'no_click_id' };
  }

  const customerId = cleanGoogleCustomerId(
    customData.customer_id ||
    customData.google_customer_id ||
    eventCfg.customer_id
  );
  if (!customerId) {
    return { sent: false, reason: 'missing_customer_id' };
  }

  const conversionAction = buildConversionActionResource({
    customerId,
    conversionAction: customData.conversion_action || eventCfg.conversion_action,
    conversionActionId: customData.conversion_action_id || eventCfg.conversion_action_id,
    sendTo: customData.send_to || eventCfg.send_to
  });
  if (!conversionAction) {
    return { sent: false, reason: 'missing_conversion_action' };
  }

  const valueRaw = coalesce(customData.value, eventCfg.value, 0);
  const value = Number.isFinite(Number(valueRaw)) ? Number(valueRaw) : 0;
  const currency = String(coalesce(customData.currency, eventCfg.currency, 'EUR') || 'EUR').toUpperCase();
  const conversionDateTime = toGoogleAdsDateTime(customData.conversion_time || customData.conversionDateTime || new Date());

  const consentStatus =
    normalizeGoogleConsent(customData.consent) ||
    normalizeGoogleConsent(consent) ||
    eventCfg.consent ||
    null;

  const result = await uploadClickConversion({
    customerId,
    conversionAction,
    gclid,
    gbraid,
    wbraid,
    value,
    currency,
    conversionDateTime,
    externalId: eventId || null,
    email: userData?.email || null,
    phone: userData?.phone || userData?.telefono || null,
    consentStatus
  });
  return { sent: true, result };
};

const validateSignature = (req) => {
  const secret = process.env.INTAKE_WEB_SECRET;
  if (!secret) return true; // Sin secreto configurado, no validamos la firma

  const provided = req.headers[SIGNATURE_HEADER] || req.headers[SIGNATURE_HEADER_SHA];
  if (!provided) {
    return false;
  }

  const payload = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(provided);
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
};

const META_VERIFY_TOKEN = process.env.META_WEBHOOK_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN;
const META_APP_SECRET = process.env.META_APP_SECRET;
const META_GRAPH_TOKEN = process.env.META_GRAPH_TOKEN || process.env.META_PAGE_ACCESS_TOKEN;
const META_GRAPH_VERSION = process.env.META_GRAPH_VERSION || 'v24.0';

const validateMetaSignature = (req) => {
  // Permitir pruebas sin firma cuando no viene header
  if (!req.headers['x-hub-signature-256'] && !req.headers['x-hub-signature']) {
    return true;
  }
  if (!META_APP_SECRET) return true;
  const signature = req.headers['x-hub-signature-256'];
  if (!signature || typeof signature !== 'string') return false;
  const payloadBuffer = req.rawBody ? (Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody)) : Buffer.from(JSON.stringify(req.body || {}));
  const expected = 'sha256=' + crypto.createHmac('sha256', META_APP_SECRET).update(payloadBuffer).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signature);
  if (expectedBuf.length !== providedBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
};

async function dedupeAndCreateLead(leadPayload, rawPayload = {}, attributionSteps = {}) {
  const normalizedEmail = normalizeEmail(leadPayload.email);
  const normalizedPhone = normalizePhone(leadPayload.telefono);
  const dedupeCutoff = new Date(Date.now() - (DEDUPE_WINDOW_HOURS * 60 * 60 * 1000));

  const payload = {
    ...leadPayload,
    email: normalizedEmail,
    email_hash: normalizedEmail ? hashValue(normalizedEmail) : null,
    telefono: normalizedPhone || leadPayload.telefono || null,
    phone_hash: normalizedPhone ? hashValue(normalizedPhone) : null
  };

  if (payload.external_source && payload.external_id) {
    const existingExternal = await LeadIntake.findOne({ where: { external_source: payload.external_source, external_id: payload.external_id } });
    if (existingExternal) {
      const err = new Error('Lead duplicado (external_id)');
      err.status = 409;
      err.existingId = existingExternal.id;
      throw err;
    }
  }

  if (payload.event_id) {
    const existing = await LeadIntake.findOne({ where: { event_id: payload.event_id } });
    if (existing) {
      const err = new Error('Lead duplicado (event_id)');
      err.status = 409;
      err.existingId = existing.id;
      throw err;
    }
  }

  if (normalizedPhone || normalizedEmail) {
    const dedupeWhere = {
      created_at: { [Op.gte]: dedupeCutoff },
      [Op.or]: []
    };
    if (normalizedPhone) dedupeWhere[Op.or].push({ phone_hash: payload.phone_hash });
    if (normalizedEmail) dedupeWhere[Op.or].push({ email_hash: payload.email_hash });
    if (dedupeWhere[Op.or].length > 0) {
      const existingRecent = await LeadIntake.findOne({ where: dedupeWhere });
      if (existingRecent) {
        const err = new Error('Lead duplicado (contacto reciente)');
        err.status = 409;
        err.existingId = existingRecent.id;
        throw err;
      }
    }
  }

  const lead = await LeadIntake.create(payload);

  try {
    await LeadAttributionAudit.create({
      lead_intake_id: lead.id,
      raw_payload: rawPayload || {},
      attribution_steps: attributionSteps || {}
    });
  } catch (auditErr) {
    console.warn('⚠️ No se pudo registrar la auditoría de LeadIntake:', auditErr.message || auditErr);
  }

  return lead;
}

exports.ingestLead = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const eventId = (req.headers[EVENT_ID_HEADER] || body?.event_id || body?.eventId || null) || null;

  const {
    clinica_id,
    clinic_id,
    grupo_clinica_id,
    group_id,
    campana_id,
    channel,
    source,
    source_detail,
    clinic_match_source,
    clinic_match_value,
    utm_source,
    utm_medium,
    utm_campaign,
    utm_content,
    utm_term,
    gclid,
    fbclid,
    ttclid,
    referrer,
    page_url,
    landing_url,
    user_agent,
    ip,
    nombre,
    email,
    telefono,
    notas,
    status_lead,
    consentimiento_canal,
    consent_basis,
    consent_captured_at,
    consent_source,
    consent_version,
    external_source,
    external_id
  } = body;

  // Compat: intake.js usa clinic_id; el backend histórico usa clinica_id
  let clinicaIdParsed = parseInteger(coalesce(clinica_id, clinic_id, body.clinicaId, body.clinicId));
  let grupoClinicaIdParsed = parseInteger(coalesce(grupo_clinica_id, group_id, body.grupoClinicaId, body.groupId));
  const campanaIdParsed = parseInteger(campana_id);
  const attribution = body?.attribution || {};
  const leadData = body?.lead_data || {};
  const formSubmission = normalizeFormSubmission(body?.form_submission || body?.formSubmission);
  const formLeadData = extractLeadDataFromFormFields(formSubmission?.fields || {});

  // Validación por dominio + HMAC por clínica/grupo cuando hay IntakeConfig guardada.
  // Fallback legacy: INTAKE_WEB_SECRET solo se usa si NO existe configuración.
  const pageUrlForDomain = coalesce(
    attribution.page_url,
    body.page_url,
    body.pageUrl,
    attribution.landing_url,
    body.landing_url,
    body.landingUrl
  );
  const derivedDomain = getHostnameFromUrl(pageUrlForDomain || '');
  const domain = normalizeDomain(body.domain || derivedDomain) || '';

  let clinicCfg = null;
  let groupCfg = null;
  let domainCfg = null;
  if (clinicaIdParsed !== null) {
    clinicCfg = await IntakeConfig.findOne({ where: { clinic_id: clinicaIdParsed }, raw: true });
  }
  if (grupoClinicaIdParsed !== null) {
    groupCfg = await IntakeConfig.findOne({ where: { group_id: grupoClinicaIdParsed, assignment_scope: 'group' }, raw: true });
  }
  if (!clinicCfg && !groupCfg && domain) {
    domainCfg = await IntakeConfig.findOne({
      where: db.Sequelize.literal(`JSON_CONTAINS(COALESCE(domains,'[]'), '\"${domain.toLowerCase()}\"')`)
    });
    if (domainCfg) domainCfg = domainCfg.get ? domainCfg.get({ plain: true }) : domainCfg;
  }

  const providedSignature = req.headers[SIGNATURE_HEADER] || req.headers[SIGNATURE_HEADER_SHA];
  const cfg = pickMatchingIntakeConfig({
    req,
    providedSignature,
    clinicCfg,
    groupCfg,
    domainCfg
  });

  if (cfg && Array.isArray(cfg.domains) && cfg.domains.length > 0) {
    if (!domain || !isDomainAllowed(cfg.domains, domain)) {
      return res.status(403).json({ message: 'Domain not allowed' });
    }
  }

  if (cfg && cfg.hmac_key) {
    if (!providedSignature || !validateHmac(req, cfg.hmac_key, providedSignature)) {
      return res.status(401).json({ message: 'Firma HMAC inválida o ausente' });
    }
  } else if (!cfg && process.env.INTAKE_WEB_SECRET) {
    if (!providedSignature || !validateHmac(req, process.env.INTAKE_WEB_SECRET, providedSignature)) {
      return res.status(401).json({ message: 'Firma HMAC inválida o ausente' });
    }
  }

  const utmSource = coalesce(attribution.utm_source, utm_source);
  const utmMedium = coalesce(attribution.utm_medium, utm_medium);
  const utmCampaign = coalesce(attribution.utm_campaign, utm_campaign);
  const utmContent = coalesce(attribution.utm_content, utm_content);
  const utmTerm = coalesce(attribution.utm_term, utm_term);
  const gclidValue = coalesce(attribution.gclid, gclid);
  const fbclidValue = coalesce(attribution.fbclid, fbclid);
  const ttclidValue = coalesce(attribution.ttclid, ttclid);
  const referrerValue = coalesce(attribution.referrer, referrer);
  const pageUrlValue = coalesce(attribution.page_url, page_url);
  const landingUrlValue = coalesce(attribution.landing_url, landing_url);

  const leadNombre = sanitizeText(coalesce(leadData.nombre, formLeadData.nombre, nombre));
  const leadEmail = coalesce(leadData.email, formLeadData.email, email);
  const leadTelefono = coalesce(leadData.telefono, formLeadData.telefono, telefono);
  const leadNotas = sanitizeLeadNoteText(coalesce(leadData.notas, notas));
  const consentValue = coalesce(req.body?.consent, consentimiento_canal);

  if (clinicaIdParsed !== null) {
    const clinic = await Clinica.findOne({ where: { id_clinica: clinicaIdParsed } });
    if (!clinic) {
      return res.status(400).json({ message: 'La clínica indicada no existe' });
    }
  }

  if (grupoClinicaIdParsed !== null) {
    const group = await GrupoClinica.findOne({ where: { id_grupo: grupoClinicaIdParsed } });
    if (!group) {
      return res.status(400).json({ message: 'El grupo indicado no existe' });
    }
  }

  if (campanaIdParsed !== null && Campana) {
    const camp = await Campana.findByPk(campanaIdParsed);
    if (!camp) {
      return res.status(400).json({ message: 'La campaña indicada no existe' });
    }
  }

  const normalizedChannel = CHANNELS.has(channel) ? channel : 'unknown';
  const normalizedSource = SOURCES.has(source) ? source : null;
  const normalizedStatus = STATUSES.has(status_lead) ? status_lead : 'nuevo';

  const normalizedEmail = normalizeEmail(leadEmail);
  const normalizedPhone = normalizePhone(leadTelefono);
  const payloadHash = hashValue(stableStringify(req.body || {}));
  const externalSource = external_source || source || null;
  const externalId = external_id || req.body?.meta_lead_id || req.body?.google_lead_id || req.body?.form_id || eventId || null;

  // Resolución automática de clínica por activo publicitario (Meta / Google Ads)
  let clinicMatchSource = clinic_match_source || null;
  let clinicMatchValue = clinic_match_value || null;

  if (!clinicaIdParsed && normalizedSource === 'meta_ads') {
    const pageId = coalesce(req.body?.page_id, req.body?.pageId, req.body?.page?.id, req.body?.payload?.page_id);
    const adAccountId = coalesce(req.body?.ad_account_id, req.body?.adAccountId, req.body?.payload?.ad_account_id);

    let assetFound = null;

    if (pageId) {
      assetFound = await ClinicMetaAsset.findOne({
        where: { metaAssetId: String(pageId), assetType: 'facebook_page', isActive: true }
      });
      if (assetFound) {
        clinicaIdParsed = assetFound.clinicaId || clinicaIdParsed;
        grupoClinicaIdParsed = assetFound.grupoClinicaId || grupoClinicaIdParsed;
        clinicMatchSource = clinicMatchSource || 'meta_page';
        clinicMatchValue = clinicMatchValue || String(pageId);
      }
    }

    if (!clinicaIdParsed && adAccountId) {
      const asset = await ClinicMetaAsset.findOne({
        where: { metaAssetId: String(adAccountId), assetType: 'ad_account', isActive: true }
      });
      if (asset) {
        assetFound = asset;
        clinicaIdParsed = asset.clinicaId || clinicaIdParsed;
        grupoClinicaIdParsed = asset.grupoClinicaId || grupoClinicaIdParsed;
        clinicMatchSource = clinicMatchSource || 'meta_ad_account';
        clinicMatchValue = clinicMatchValue || String(adAccountId);
      }
    }

    // Si no hay activo configurado para la página/cuenta, no ingerimos para evitar saturar
    if (!clinicaIdParsed && (pageId || adAccountId)) {
      return res.status(202).json({
        message: 'Lead descartado: activo Meta no conectado en Settings',
        page_id: pageId ? String(pageId) : null,
        ad_account_id: adAccountId ? String(adAccountId) : null
      });
    }
  }

  if (!clinicaIdParsed && normalizedSource === 'google_ads') {
    const customerId = coalesce(req.body?.customer_id, req.body?.customerId, req.body?.google_customer_id, req.body?.payload?.customer_id);
    if (customerId && db.ClinicGoogleAdsAccount) {
      const account = await db.ClinicGoogleAdsAccount.findOne({
        where: { customerId: String(customerId), isActive: true }
      });
      if (account) {
        clinicaIdParsed = account.clinicaId || clinicaIdParsed;
        grupoClinicaIdParsed = account.grupoClinicaId || grupoClinicaIdParsed;
        clinicMatchSource = clinicMatchSource || 'google_ads_customer';
        clinicMatchValue = clinicMatchValue || String(customerId);
      }
    }
  }

  const leadPayload = {
    event_id: eventId,
    clinica_id: clinicaIdParsed,
    grupo_clinica_id: grupoClinicaIdParsed,
    campana_id: campanaIdParsed,
    channel: normalizedChannel,
    source: normalizedSource,
    source_detail: source_detail || null,
    clinic_match_source: clinicMatchSource,
    clinic_match_value: clinicMatchValue,
    utm_source: utmSource || null,
    utm_medium: utmMedium || null,
    utm_campaign: utmCampaign || null,
    utm_content: utmContent || null,
    utm_term: utmTerm || null,
    gclid: gclidValue || null,
    fbclid: fbclidValue || null,
    ttclid: ttclidValue || null,
    referrer: referrerValue || null,
    page_url: pageUrlValue || null,
    landing_url: landingUrlValue || null,
    user_agent: coalesce(user_agent, req.headers['user-agent']) || null,
    ip: coalesce(ip, req.headers['x-forwarded-for'], req.socket?.remoteAddress) || null,
    nombre: leadNombre || null,
    email: leadEmail || null,
    telefono: leadTelefono || null,
    notas: leadNotas || null,
    status_lead: normalizedStatus,
    consentimiento_canal: consentValue || null,
    consent_basis: consent_basis || null,
    consent_captured_at: parseDate(consent_captured_at),
    consent_source: consent_source || pageUrlValue || landingUrlValue || null,
    consent_version: consent_version || null,
    external_source: externalSource,
    external_id: externalId,
    intake_payload_hash: payloadHash
  };

  let lead;
  let dedupeConflict = null;
  let shouldEmitLeadCreated = false;
  try {
    lead = await dedupeAndCreateLead(leadPayload, req.body || {}, {
      clinic_match_source: clinic_match_source || null,
      clinic_match_value: clinic_match_value || null
    });
    shouldEmitLeadCreated = true;
  } catch (err) {
    if (err.status === 409) {
      dedupeConflict = err;
      lead = err.existingId ? await LeadIntake.findByPk(err.existingId) : null;
      if (lead) {
        const leadUpdates = {};
        if (!lead.clinica_id && clinicaIdParsed !== null) {
          leadUpdates.clinica_id = clinicaIdParsed;
        }
        if (!lead.grupo_clinica_id && grupoClinicaIdParsed !== null) {
          leadUpdates.grupo_clinica_id = grupoClinicaIdParsed;
        }
        if (!lead.clinic_match_source && clinicMatchSource) {
          leadUpdates.clinic_match_source = clinicMatchSource;
        }
        if (!lead.clinic_match_value && clinicMatchValue) {
          leadUpdates.clinic_match_value = clinicMatchValue;
        }
        if (Object.keys(leadUpdates).length) {
          await lead.update(leadUpdates);
          shouldEmitLeadCreated = true;
        }
      }
    } else {
      throw err;
    }
  }

  let formSubmissionEvent = null;
  if (formSubmission && FormSubmissionEvent) {
    try {
      formSubmissionEvent = await FormSubmissionEvent.create({
        clinic_id: lead?.clinica_id || clinicaIdParsed,
        group_id: lead?.grupo_clinica_id || grupoClinicaIdParsed,
        lead_intake_id: lead?.id || null,
        page_url: formSubmission.page_url || pageUrlValue || landingUrlValue || null,
        form_id: formSubmission.form_id || null,
        form_name: formSubmission.form_name || null,
        form_selector: formSubmission.form_selector || null,
        match_domain: normalizeDomain(getHostnameFromUrl(formSubmission.page_url || pageUrlValue || '')),
        source_detail: source_detail || 'web_form',
        email_normalized: normalizedEmail,
        phone_normalized: normalizedPhone,
        fields_json: formSubmission.fields || {},
        payload_json: formSubmission.payload || req.body || {},
        submitted_at: formSubmission.submitted_at || new Date(),
      });

      await enqueueInboundFormSubmissionResume({
        clinicId: lead?.clinica_id || clinicaIdParsed,
        leadId: lead?.id || null,
        email: normalizedEmail,
        phone: normalizedPhone,
        pageUrl: formSubmission.page_url || pageUrlValue || null,
        formId: formSubmission.form_id || null,
        formName: formSubmission.form_name || null,
        formSelector: formSubmission.form_selector || null,
        fields: formSubmission.fields || {},
        submittedAt: formSubmission.submitted_at instanceof Date
          ? formSubmission.submitted_at.toISOString()
          : String(formSubmission.submitted_at || ''),
        formSubmissionEventId: formSubmissionEvent.id,
        sourceDetail: source_detail || 'web_form',
        payload: formSubmission.payload || req.body || {},
      });
    } catch (formErr) {
      console.warn('⚠️ No se pudo registrar/reanudar envío de formulario:', formErr.message || formErr);
    }
  }

  if (lead && shouldEmitLeadCreated) {
    try {
      await emitLeadSocketEvent('lead:created', buildLeadCreatedSocketPayload(lead), {
        clinicId: lead.clinica_id || clinicaIdParsed,
        groupId: lead.grupo_clinica_id || grupoClinicaIdParsed
      });
    } catch (emitErr) {
      console.warn('⚠️ No se pudo emitir lead:created:', emitErr.message || emitErr);
    }
  }

  if (dedupeConflict) {
    return res.status(409).json({ message: dedupeConflict.message, id: dedupeConflict.existingId, reason: dedupeConflict.message });
  }

  // Permite al snippet solicitar un evento concreto (p. ej. Contact para tel_modal).
  // Si viene vacío o es inválido, mantenemos Lead por defecto (compatibilidad).
  const requestedEventNameRaw = coalesce(body.event_name, body.eventName);
  const requestedEventName = requestedEventNameRaw ? String(requestedEventNameRaw).trim().toLowerCase() : '';
  const normalizedEventNameForCapi =
    requestedEventName === 'contact' ? 'Contact' :
      requestedEventName === 'schedule' ? 'Schedule' :
        requestedEventName === 'purchase' ? 'Purchase' :
          'Lead';

  // Emitir a Meta CAPI si hay datos mínimos
  try {
    const userData = buildMetaUserData({
      email: leadEmail,
      phone: leadTelefono,
      ip: coalesce(ip, req.headers['x-forwarded-for'], req.socket?.remoteAddress),
      ua: coalesce(user_agent, req.headers['user-agent']),
      externalId: lead.id
    });
    await sendMetaEvent({
      eventName: normalizedEventNameForCapi,
      eventTime: Math.floor(Date.now() / 1000),
      eventId: lead.event_id || `lead-${lead.id}`,
      actionSource: 'website',
      eventSourceUrl: pageUrlValue || landingUrlValue || null,
      clinicId: clinicaIdParsed,
      source: normalizedSource,
      sourceDetail: source_detail || null,
      utmCampaign: utmCampaign || null,
      userData
    });
  } catch (e) {
    console.warn('⚠️ No se pudo enviar evento Meta CAPI:', e.message || e);
  }

  // Google Ads Enhanced Conversions (server-side) al capturar lead/contact.
  // Solo aplica cuando existe click id (gclid/gbraid/wbraid) y conversión configurada.
  try {
    const googleCustomData = {
      gclid: gclidValue || null,
      gbraid: coalesce(attribution.gbraid, body.gbraid, body.gBraid) || null,
      wbraid: coalesce(attribution.wbraid, body.wbraid, body.wBraid) || null,
      value: coalesce(body.value, body.conversion_value),
      currency: coalesce(body.currency, body.conversion_currency),
      conversion_time: coalesce(body.conversion_time, body.conversionDateTime, new Date()),
      customer_id: coalesce(body.customer_id, body.customerId, body.google_customer_id),
      conversion_action: coalesce(body.conversion_action, body.conversionAction),
      conversion_action_id: coalesce(body.conversion_action_id, body.conversionActionId),
      send_to: coalesce(body.send_to, body.sendTo),
      consent: coalesce(body.consent, body.consentimiento_canal)
    };
    await maybeUploadGoogleConversion({
      cfgRecord: cfg,
      eventName: normalizedEventNameForCapi,
      customData: googleCustomData,
      userData: {
        email: leadEmail,
        phone: leadTelefono
      },
      consent: coalesce(body.consent, body.consentimiento_canal),
      eventId: lead.event_id || `lead-${lead.id}`
    });
  } catch (adsErr) {
    console.warn('⚠️ Google Ads upload error (ingestLead):', adsErr.response?.data || adsErr.message || adsErr);
  }

  res.status(201).json({ id: lead.id });
});

// ===========================
// Configuración del snippet
// ===========================

const DEFAULT_CHAT_FLOW = {
  version: '1.0',
  steps: [
    { type: 'message', text: 'Hola. Te ayudamos a pedir cita.' },
    { type: 'input', text: 'Como te llamas?', input_type: 'text', placeholder: 'Tu nombre', field: 'nombre' },
    { type: 'input', text: 'Gracias {{nombre}}. Cual es tu telefono?', input_type: 'tel', placeholder: 'Tu telefono', field: 'telefono' },
    { type: 'input', text: 'Y tu email? (opcional)', input_type: 'email', placeholder: 'Tu email', field: 'email' },
    { type: 'cta', text: 'Confirma que quieres que te contactemos:', button_text: 'Ok, contactadme' }
  ]
};

const DEFAULT_TEXTS = {
  chat_title: 'WhatsApp',
  chat_welcome: 'Hola. Quieres pedirnos una cita de valoracion sin coste?',
  // Tel modal (bloqueante): capturamos datos antes de abrir tel:
  // Nota: el snippet soporta variables {nombre_clinica} y {telefono}.
  tel_modal_title: 'Conectando con la recepción de {nombre_clinica}',
  tel_modal_subtitle: 'Déjanos tu teléfono por si se pierde la conexión',
  consent_text: 'Acepto la politica de privacidad',
  privacy_url: '/politica-privacidad'
};

const DEFAULT_APPEARANCE = {
  position: 'bottom-right',
  icon_type: 'whatsapp',
  icon_color: '#FFFFFF',
  icon_bg_color: '#25D366',
  bubble_text: 'Necesitas ayuda?',
  bubble_enabled: true,
  bubble_delay: 3000,
  bubble_bg_color: '#FFFFFF',
  bubble_text_color: '#1F2937',
  animation: 'bounce',
  header_bg_color: '#075E54',
  header_text_color: '#FFFFFF',
  chat_width: 380,
  chat_height: 520,
  auto_open_delay: 0,
  typing_delay: 1500,
  mobile_fullscreen: true,
  frequency: 'every_visit',
  frequency_hours: 24,
  show_branding: true,
  // Tel modal header color (used for gradient + button styling in snippet)
  tel_modal_header_color: '#3B82F6'
};

const DEFAULT_GOOGLE_ADS = {
  enabled: false,
  customer_id: null,
  conversion_action: null,
  conversion_action_id: null,
  send_to: null,
  currency: 'EUR'
};

const defaultConfigPayload = (clinicId, groupId) => ({
  clinic_id: clinicId || null,
  group_id: groupId || null,
  assignment_scope: groupId ? 'group' : 'clinic',
  domains: [],
  features: { chat_enabled: true, tel_modal_enabled: true, viewcontent_enabled: true, form_intercept_enabled: true },
  flow: DEFAULT_CHAT_FLOW,
  flows: null,
  appearance: DEFAULT_APPEARANCE,
  google_ads: DEFAULT_GOOGLE_ADS,
  texts: DEFAULT_TEXTS,
  locations: [],
  has_hmac: false,
  config: {}
});

exports.getIntakeConfig = asyncHandler(async (req, res) => {
  // La config es “source of truth” para el snippet; evitar 304/ETag y cachés agresivas.
  res.set('Cache-Control', 'no-store');

  const clinicIdRaw = req.query.clinic_id;
  const groupIdRaw = req.query.group_id;
  const domain = normalizeDomain(String(req.query.domain || '')) || '';
  const clinicIdParsed = parseInteger(clinicIdRaw);
  const groupIdParsed = parseInteger(groupIdRaw);

  let record = null;
  // Prioridad:
  // - Si el snippet pasa clinic_id explícito => config de clínica.
  // - Si el snippet pasa group_id explícito => config de grupo.
  // - Si no hay IDs => resolver por dominio (primero clínica, luego grupo).
  //
  // Motivo: el HMAC se configura por scope (clínica vs grupo). Si el snippet se instala con
  // data-group-id, NO debemos devolver config de clínica solo por el dominio, o el snippet firmará
  // con la key de grupo pero el backend esperará la key de clínica (401).
  if (clinicIdParsed !== null) {
    record = await IntakeConfig.findOne({ where: { clinic_id: clinicIdParsed }, raw: true });
  }
  if (!record && groupIdParsed !== null) {
    record = await IntakeConfig.findOne({ where: { group_id: groupIdParsed, assignment_scope: 'group' }, raw: true });
  }
  if (!record && domain) {
    record = await IntakeConfig.findOne({
      where: db.Sequelize.literal(`JSON_CONTAINS(COALESCE(domains,'[]'), '\"${domain}\"') AND assignment_scope='clinic'`)
    });
    if (record && record.get) record = record.get({ plain: true });
  }
  if (!record && domain) {
    record = await IntakeConfig.findOne({
      where: db.Sequelize.literal(`JSON_CONTAINS(COALESCE(domains,'[]'), '\"${domain}\"') AND assignment_scope='group'`)
    });
    if (record && record.get) record = record.get({ plain: true });
  }

  const payload = defaultConfigPayload(record?.clinic_id || clinicIdParsed, record?.group_id || groupIdParsed);
  if (record) {
    const cfg = record.config || {};
    payload.clinic_id = record.clinic_id || null;
    payload.group_id = record.group_id || null;
    payload.assignment_scope = record.assignment_scope || payload.assignment_scope;
    payload.domains = record.domains || [];
    payload.features = { ...payload.features, ...(cfg.features || {}) };
    payload.flow = cfg.flow || payload.flow;
    payload.flows = cfg.flows || payload.flows;
    payload.appearance = { ...payload.appearance, ...(cfg.appearance || {}) };
    payload.google_ads = { ...payload.google_ads, ...normalizeGoogleAdsConfig(cfg.google_ads || {}) };
    payload.texts = { ...payload.texts, ...(cfg.texts || {}) };
    payload.locations = cfg.locations || [];
    payload.config = cfg;
    payload.has_hmac = !!record.hmac_key;
    if (domain && payload.domains.length > 0 && !isDomainAllowed(payload.domains, domain)) {
      return res.status(403).json({ message: 'Domain not allowed' });
    }
  }

  // Locations disponibles para el editor (sedes = clínicas del mismo grupo).
  // - Si la config es por grupo => todas las clínicas del grupo.
  // - Si la config es por clínica y pertenece a un grupo => todas las clínicas del grupo.
  // - Si no pertenece a un grupo => solo la propia clínica.
  payload.available_locations = [];
  try {
    let resolvedGroupId = payload.group_id || null;
    let clinicRow = null;

    if (!resolvedGroupId && payload.clinic_id) {
      clinicRow = await Clinica.findOne({
        where: { id_clinica: payload.clinic_id },
        attributes: ['id_clinica', 'nombre_clinica', 'telefono', 'grupoClinicaId'],
        raw: true
      });
      resolvedGroupId = clinicRow?.grupoClinicaId || null;
    }

    if (resolvedGroupId) {
      // WhatsApp por grupo (fallback si una clínica no tiene número específico).
      let groupWhatsApp = null;
      try {
        const groupPhone = await ClinicMetaAsset.findOne({
          where: {
            grupoClinicaId: resolvedGroupId,
            assignmentScope: 'group',
            isActive: true,
            assetType: 'whatsapp_phone_number'
          },
          attributes: ['metaAssetName', 'additionalData', 'updatedAt'],
          order: [['updatedAt', 'DESC']],
          raw: true
        });
        groupWhatsApp = extractWhatsAppNumber(groupPhone);
      } catch (e) {
        // No bloquear el snippet/editor por un fallo en soporte extra.
        groupWhatsApp = null;
      }

      const clinics = await Clinica.findAll({
        where: { grupoClinicaId: resolvedGroupId },
        attributes: ['id_clinica', 'nombre_clinica', 'telefono', 'url_avatar'],
        order: [['nombre_clinica', 'ASC']],
        raw: true
      });

      // WhatsApp por clínica (si existe), con fallback al número del grupo.
      const clinicIds = clinics.map((c) => c.id_clinica).filter(Boolean);
      const whatsappByClinicId = new Map();
      if (clinicIds.length) {
        const clinicPhones = await ClinicMetaAsset.findAll({
          where: {
            assetType: 'whatsapp_phone_number',
            isActive: true,
            clinicaId: { [Op.in]: clinicIds }
          },
          attributes: ['clinicaId', 'metaAssetName', 'additionalData', 'updatedAt'],
          order: [['updatedAt', 'DESC']],
          raw: true
        });
        for (const asset of clinicPhones) {
          const cid = asset?.clinicaId;
          if (!cid) continue;
          if (whatsappByClinicId.has(cid)) continue; // ya tenemos el más reciente por el order
          const wa = extractWhatsAppNumber(asset);
          if (wa) whatsappByClinicId.set(cid, wa);
        }
      }

      payload.available_locations = clinics.map((c) => {
        const phone = c.telefono || null;
        const whatsapp = whatsappByClinicId.get(c.id_clinica) || groupWhatsApp || null;
        return {
          id: c.id_clinica,
          label: c.nombre_clinica,
          phone,
          whatsapp,
          url_avatar: c.url_avatar || null
        };
      });
    } else if (payload.clinic_id) {
      if (!clinicRow) {
        clinicRow = await Clinica.findOne({
          where: { id_clinica: payload.clinic_id },
          attributes: ['id_clinica', 'nombre_clinica', 'telefono', 'url_avatar'],
          raw: true
        });
      }
      if (clinicRow) {
        let whatsapp = null;
        try {
          const clinicPhone = await ClinicMetaAsset.findOne({
            where: {
              clinicaId: clinicRow.id_clinica,
              isActive: true,
              assetType: 'whatsapp_phone_number'
            },
            attributes: ['metaAssetName', 'additionalData', 'updatedAt'],
            order: [['updatedAt', 'DESC']],
            raw: true
          });
          whatsapp = extractWhatsAppNumber(clinicPhone);
        } catch (e) {
          whatsapp = null;
        }
        payload.available_locations = [{
          id: clinicRow.id_clinica,
          label: clinicRow.nombre_clinica,
          phone: clinicRow.telefono || null,
          whatsapp,
          url_avatar: clinicRow.url_avatar || null
        }];
      }
    }
  } catch (e) {
    // No bloquear el snippet por un fallo de soporte UI.
    payload.available_locations = [];
  }

  return res.json(payload);
});

exports.upsertIntakeConfig = asyncHandler(async (req, res) => {
  const clinicId = parseInteger(req.params.clinicId);
  const groupId = parseInteger(req.body?.group_id);
  if (!clinicId && !groupId) return res.status(400).json({ message: 'clinicId o group_id requerido' });

  const scope = groupId ? 'group' : 'clinic';
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const domains = Array.isArray(body.domains) ? body.domains : [];
  const hasHmacKeyField = Object.prototype.hasOwnProperty.call(body, 'hmac_key');
  const requestedHmacKey = body.hmac_key;

  // Compatibilidad:
  // - UI suele enviar features/flow/texts/locations en root.
  // - Backwards: si viene body.config, lo respetamos.
  let config = {};
  if (body.config && typeof body.config === 'object' && !Array.isArray(body.config)) {
    config = {
      ...body.config,
      ...(body.config.google_ads ? { google_ads: normalizeGoogleAdsConfig(body.config.google_ads) } : {})
    };
  } else {
    const features = body.features && typeof body.features === 'object' ? body.features : undefined;
    const flow = body.flow && typeof body.flow === 'object' ? body.flow : undefined;
    const flows = Array.isArray(body.flows) ? body.flows : undefined;
    const appearance = body.appearance && typeof body.appearance === 'object' && !Array.isArray(body.appearance) ? body.appearance : undefined;
    const googleAds = body.google_ads && typeof body.google_ads === 'object' && !Array.isArray(body.google_ads)
      ? normalizeGoogleAdsConfig(body.google_ads)
      : undefined;
    const texts = body.texts && typeof body.texts === 'object' ? body.texts : undefined;
    const locations = Array.isArray(body.locations) ? body.locations : undefined;
    config = {
      ...(features ? { features } : {}),
      ...(flow ? { flow } : {}),
      ...(flows ? { flows } : {}),
      ...(appearance ? { appearance } : {}),
      ...(googleAds ? { google_ads: googleAds } : {}),
      ...(texts ? { texts } : {}),
      ...(locations ? { locations } : {})
    };
  }

  // Importante: si el frontend no envía hmac_key, NO debemos borrar la clave existente.
  // El endpoint público /api/intake/config no devuelve la clave por seguridad; el admin UI podría no tenerla en memoria.
  let nextHmacKey = null;
  if (hasHmacKeyField) {
    // Permite rotación explícita (string) o borrado explícito (null / '').
    nextHmacKey = requestedHmacKey ? String(requestedHmacKey) : null;
  } else {
    // Preservar clave actual si existe
    const existing = await IntakeConfig.findOne({
      where: scope === 'group'
        ? { group_id: groupId, assignment_scope: 'group' }
        : { clinic_id: clinicId },
      raw: true
    });
    nextHmacKey = existing?.hmac_key || null;

    // Auto-generación: si se está configurando una allowlist de dominios y aún no hay clave, crearla.
    if (!nextHmacKey && Array.isArray(domains) && domains.length > 0) {
      nextHmacKey = crypto.randomBytes(32).toString('hex');
    }
  }

  await IntakeConfig.upsert({
    clinic_id: clinicId || null,
    group_id: groupId || null,
    assignment_scope: scope,
    domains,
    config,
    hmac_key: nextHmacKey
  });

  res.json({ success: true });
});

// ======================================
// Config secreta (solo UI autenticada)
// ======================================

exports.getIntakeConfigSecretClinic = asyncHandler(async (req, res) => {
  const clinicId = parseInteger(req.params.clinicId);
  if (clinicId === null) return res.status(400).json({ message: 'clinicId requerido' });

  const record = await IntakeConfig.findOne({ where: { clinic_id: clinicId }, raw: true });
  return res.json({
    clinic_id: clinicId,
    has_hmac: !!record?.hmac_key,
    hmac_key: record?.hmac_key || null
  });
});

exports.getIntakeConfigSecretGroup = asyncHandler(async (req, res) => {
  const groupId = parseInteger(req.params.groupId);
  if (groupId === null) return res.status(400).json({ message: 'groupId requerido' });

  const record = await IntakeConfig.findOne({ where: { group_id: groupId, assignment_scope: 'group' }, raw: true });
  return res.json({
    group_id: groupId,
    has_hmac: !!record?.hmac_key,
    hmac_key: record?.hmac_key || null
  });
});

// ======================================
// Verificación de instalación del snippet
// (UI autenticada)
// ======================================

exports.verifySnippetInstalled = asyncHandler(async (req, res) => {
  const domainRaw = String(req.query.domain || '').trim();
  const clinicId = parseInteger(req.query.clinic_id);
  const groupId = parseInteger(req.query.group_id);
  const pageUrlRaw = String(req.query.url || req.query.page_url || '').trim();

  if (!domainRaw) {
    return res.status(400).json({ installed: false, details: 'Falta el parámetro domain' });
  }
  const domain = normalizeDomain(domainRaw);
  if (!domain) {
    return res.status(400).json({ installed: false, details: 'Dominio inválido' });
  }
  if (domain === 'localhost' || domain.endsWith('.local') || domain === '127.0.0.1') {
    return res.status(400).json({ installed: false, details: 'Dominio no permitido para verificación' });
  }

  // Requerimos un scope explícito para evitar verificar config de terceros por "solo dominio".
  if (clinicId === null && groupId === null) {
    return res.status(400).json({ installed: false, details: 'clinic_id o group_id requerido' });
  }

  let record = null;
  if (clinicId !== null) {
    record = await IntakeConfig.findOne({ where: { clinic_id: clinicId }, raw: true });
  }
  if (!record && groupId !== null) {
    record = await IntakeConfig.findOne({ where: { group_id: groupId, assignment_scope: 'group' }, raw: true });
  }
  if (!record) {
    return res.status(404).json({ installed: false, details: 'No hay configuración de intake para este scope' });
  }

  const allowlist = Array.isArray(record.domains) ? record.domains : [];
  if (allowlist.length === 0) {
    return res.status(400).json({ installed: false, details: 'Añade al menos un dominio en la configuración antes de verificar' });
  }
  if (!isDomainAllowed(allowlist, domain)) {
    return res.status(403).json({ installed: false, details: 'Dominio no permitido para esta configuración' });
  }

  const scope = groupId !== null ? 'group' : 'clinic';
  const expectedId = scope === 'group' ? (record.group_id || groupId) : (record.clinic_id || clinicId);
  const expectedAttr = scope === 'group' ? 'data-group-id' : 'data-clinic-id';

  // Construir URLs candidatas a verificar.
  // Si el usuario pasa una URL completa, la respetamos (pero debe coincidir el host allowlisted).
  const candidates = [];
  if (pageUrlRaw) {
    try {
      const u = new URL(pageUrlRaw);
      const host = normalizeDomain(u.hostname);
      if (!host || !isDomainAllowed(allowlist, host)) {
        return res.status(400).json({ installed: false, details: 'La URL no coincide con el dominio allowlisteado' });
      }
      candidates.push(u.toString());
    } catch {
      return res.status(400).json({ installed: false, details: 'URL inválida' });
    }
  } else {
    const base = stripWww(domain);
    candidates.push(`https://${base}/`);
    if (!base.startsWith('www.')) {
      candidates.push(`https://www.${base}/`);
    }
    candidates.push(`http://${base}/`);
    if (!base.startsWith('www.')) {
      candidates.push(`http://www.${base}/`);
    }
  }
  const uniqueCandidates = Array.from(new Set(candidates));

  let html = null;
  let finalUrl = null;
  let lastError = null;

  for (const url of uniqueCandidates) {
    try {
      const resp = await axios.get(url, {
        timeout: 8000,
        maxRedirects: 5,
        maxContentLength: 2 * 1024 * 1024,
        maxBodyLength: 2 * 1024 * 1024,
        headers: {
          'User-Agent': 'ClinicaClick Snippet Verifier/1.0',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
        },
        validateStatus: (s) => s >= 200 && s < 400
      });
      if (typeof resp.data === 'string' && resp.data.length > 0) {
        html = resp.data;
        // axios no expone siempre la URL final; guardamos la candidate.
        finalUrl = url;
        break;
      }
    } catch (e) {
      lastError = e;
    }
  }

  if (!html) {
    const code = lastError?.response?.status || null;
    return res.status(502).json({
      installed: false,
      details: `No se pudo acceder a ${domain} para verificar${code ? ` (HTTP ${code})` : ''}`
    });
  }

  const scriptTags = html.match(/<script\b[^>]*>/gi) || [];
  const intakeTags = scriptTags.filter((t) => /intake\.js/i.test(t));
  if (intakeTags.length === 0) {
    return res.json({ installed: false, details: `No se encontró intake.js en ${finalUrl || domain}` });
  }

  const idRe = new RegExp(`${expectedAttr}\\s*=\\s*['"]?${expectedId}['"]?`, 'i');
  const tagForScope = intakeTags.find((t) => idRe.test(t));
  if (!tagForScope) {
    // Pista útil: ¿hay intake.js pero con otro scope/id?
    const clinicIdMatch = intakeTags.map((t) => t.match(/data-clinic-id\s*=\s*['"]?(\d+)['"]?/i)).find(Boolean);
    const groupIdMatch = intakeTags.map((t) => t.match(/data-group-id\s*=\s*['"]?(\d+)['"]?/i)).find(Boolean);
    const hint = clinicIdMatch?.[1]
      ? `Se detectó data-clinic-id="${clinicIdMatch[1]}".`
      : (groupIdMatch?.[1] ? `Se detectó data-group-id="${groupIdMatch[1]}".` : null);
    return res.json({
      installed: false,
      details: `Se encontró intake.js pero no el atributo ${expectedAttr}="${expectedId}" (scope incorrecto o ID distinto).${hint ? ` ${hint}` : ''}`
    });
  }

  // Si existe HMAC en backend, exigir data-hmac-key y que coincida.
  if (record.hmac_key) {
    const m = tagForScope.match(/data-hmac-key\s*=\s*['"]([^'"]+)['"]/i);
    const installedKey = m?.[1] ? String(m[1]).trim() : null;
    if (!installedKey) {
      return res.json({ installed: false, details: 'Se encontró intake.js pero falta data-hmac-key en el script tag.' });
    }
    if (installedKey !== record.hmac_key) {
      return res.json({ installed: false, details: 'Se encontró intake.js pero la clave HMAC no coincide con la del CRM (quizá rotaste la clave y no actualizaste la web).' });
    }
  }

  return res.json({ installed: true });
});

// ===========================
// Eventos genéricos (ViewContent, Contact, Schedule, Purchase)
// ===========================

const normalizeSignature = (provided) => {
  if (!provided) return null;
  if (typeof provided !== 'string') return null;
  const trimmed = provided.trim();
  if (!trimmed) return null;
  // Accept "sha256=<hex>" just in case some clients send it like Meta.
  return trimmed.toLowerCase().startsWith('sha256=') ? trimmed.slice(7).trim() : trimmed.toLowerCase();
};

const getHostnameFromUrl = (value) => {
  if (!value || typeof value !== 'string') return null;
  try {
    return new URL(value).hostname.toLowerCase();
  } catch {
    return null;
  }
};

// Validación HMAC sobre el payload "raw" (mejor: evita discrepancias por orden de keys).
const validateHmac = (req, secret, provided) => {
  if (!secret) return true;
  const signature = normalizeSignature(provided);
  if (!signature) return false;

  const rawPayload = req.rawBody
    ? (Buffer.isBuffer(req.rawBody) ? req.rawBody : Buffer.from(req.rawBody))
    : Buffer.from(stableStringify(req.body || {}));

  const expected = crypto.createHmac('sha256', secret).update(rawPayload).digest('hex');
  const expectedBuf = Buffer.from(expected);
  const providedBuf = Buffer.from(signature);
  if (expectedBuf.length !== providedBuf.length) {
    return false;
  }
  return crypto.timingSafeEqual(expectedBuf, providedBuf);
};

exports.receiveIntakeEvent = asyncHandler(async (req, res) => {
  const body = req.body || {};

  const eventName = body.event_name || body.eventName || 'ViewContent';
  const clinicIdParsed = parseInteger(coalesce(body.clinic_id, body.clinica_id, body.clinicId));
  const groupIdParsed = parseInteger(coalesce(body.group_id, body.grupo_clinica_id, body.groupId));

  const eventSourceUrl = coalesce(
    body.event_source_url,
    body.eventSourceUrl,
    body.page_url,
    body.pageUrl,
    body.event_data?.page_url,
    body.event_data?.pageUrl
  );

  const domainFromBody = body.domain || null;
  const derivedDomain = getHostnameFromUrl(eventSourceUrl || '');
  const domain = normalizeDomain(domainFromBody || derivedDomain) || '';

  const customDataFromBody =
    body.custom_data && typeof body.custom_data === 'object' && !Array.isArray(body.custom_data) ? body.custom_data : {};
  const eventDataFromBody =
    body.event_data && typeof body.event_data === 'object' && !Array.isArray(body.event_data) ? body.event_data : {};

  // Aceptar el payload del snippet "v2" (campos planos + event_data) y el payload "canónico" (custom_data/user_data).
  const custom_data = {
    ...customDataFromBody,
    ...eventDataFromBody
  };

  // Compat: campos planos (utm/gclid/etc.)
  if (body.source && custom_data.source == null) custom_data.source = body.source;
  if (body.source_detail && custom_data.source_detail == null) custom_data.source_detail = body.source_detail;
  if (body.utm_campaign && custom_data.utm_campaign == null) custom_data.utm_campaign = body.utm_campaign;
  if (body.gclid && custom_data.gclid == null) custom_data.gclid = body.gclid;
  if (body.gbraid && custom_data.gbraid == null) custom_data.gbraid = body.gbraid;
  if (body.wbraid && custom_data.wbraid == null) custom_data.wbraid = body.wbraid;
  if (body.fbclid && custom_data.fbclid == null) custom_data.fbclid = body.fbclid;
  if (body.value != null && custom_data.value == null) custom_data.value = body.value;
  if (body.currency && custom_data.currency == null) custom_data.currency = body.currency;

  const userDataFromBody =
    body.user_data && typeof body.user_data === 'object' && !Array.isArray(body.user_data) ? body.user_data : {};

  // Compat: algunos clientes pueden mandar lead_data (nombre/email/telefono) también en eventos.
  const leadDataFromBody =
    body.lead_data && typeof body.lead_data === 'object' && !Array.isArray(body.lead_data) ? body.lead_data : {};

  const user_data = {
    ...userDataFromBody,
    ...leadDataFromBody
  };

  const fbp = body.fbp || user_data.fbp;
  const fbc = body.fbc || user_data.fbc;

  let clinicCfg = null;
  let groupCfg = null;
  let domainCfg = null;
  if (clinicIdParsed !== null) {
    clinicCfg = await IntakeConfig.findOne({ where: { clinic_id: clinicIdParsed }, raw: true });
  }
  if (groupIdParsed !== null) {
    groupCfg = await IntakeConfig.findOne({ where: { group_id: groupIdParsed, assignment_scope: 'group' }, raw: true });
  }
  if (!clinicCfg && !groupCfg && domain) {
    domainCfg = await IntakeConfig.findOne({
      where: db.Sequelize.literal(`JSON_CONTAINS(COALESCE(domains,'[]'), '\"${domain.toLowerCase()}\"')`)
    });
    if (domainCfg) domainCfg = domainCfg.get ? domainCfg.get({ plain: true }) : domainCfg;
  }

  const provided = req.headers['x-cc-signature'] || req.headers['x-cc-signature-sha256'];
  const cfg = pickMatchingIntakeConfig({
    req,
    providedSignature: provided,
    clinicCfg,
    groupCfg,
    domainCfg
  });

  if (cfg && Array.isArray(cfg.domains) && cfg.domains.length > 0) {
    // Si hay allowlist configurada, el dominio es obligatorio.
    if (!domain || !isDomainAllowed(cfg.domains, domain)) {
      return res.status(403).json({ message: 'Domain not allowed' });
    }
  }

  if (cfg && cfg.hmac_key) {
    // ViewContent puede enviarse via sendBeacon (sin headers), así que toleramos firma ausente solo en ese evento.
    if (!provided && String(eventName).toLowerCase() !== 'viewcontent') {
      return res.status(401).json({ message: 'Invalid signature' });
    }
    if (provided && !validateHmac(req, cfg.hmac_key, provided)) {
      return res.status(401).json({ message: 'Invalid signature' });
    }
  }

  const userData = buildMetaUserData({
    email: user_data.email,
    phone: user_data.phone || user_data.telefono,
    ip: user_data.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
    ua: user_data.ua || req.headers['user-agent'],
    fbp: fbp || user_data.fbp,
    fbc: fbc || user_data.fbc,
    externalId: user_data.external_id
  });

  await sendMetaEvent({
    eventName: eventName || 'ViewContent',
    eventTime: body.event_time || Math.floor(Date.now() / 1000),
    eventId: body.event_id || undefined,
    actionSource: body.action_source || 'website',
    eventSourceUrl: eventSourceUrl || undefined,
    clinicId: cfg?.clinic_id || clinicIdParsed || null,
    source: custom_data.source,
    sourceDetail: custom_data.source_detail,
    utmCampaign: custom_data.utm_campaign,
    value: custom_data.value,
    currency: custom_data.currency || 'EUR',
    userData
  });

  // Google Ads Enhanced Conversions (server-side)
  // Prioridad de configuración:
  // 1) custom_data del propio evento
  // 2) config.google_ads (clínica/grupo)
  // 3) variables de entorno
  try {
    await maybeUploadGoogleConversion({
      cfgRecord: cfg,
      eventName: eventName || 'ViewContent',
      customData: {
        ...custom_data,
        conversion_time: coalesce(custom_data.conversion_time, custom_data.conversionDateTime, body.event_time)
      },
      userData: user_data,
      consent: body.consent || null,
      eventId: body.event_id || user_data.external_id || null
    });
  } catch (adsErr) {
    console.warn('⚠️ Google Ads upload error (events):', adsErr.response?.data || adsErr.message || adsErr);
  }

  const normalizedEventName = String(eventName || '').trim().toLowerCase();
  if (normalizedEventName === 'callinitiated') {
    const leadId = parseInteger(coalesce(body.lead_id, body.leadId, eventDataFromBody.lead_id, eventDataFromBody.leadId));
    const clickedTel = cleanString(coalesce(body.clicked_tel, body.clickedTel, eventDataFromBody.clicked_tel, eventDataFromBody.clickedTel));
    const pageUrl = cleanString(coalesce(body.page_url, body.pageUrl, eventDataFromBody.page_url, eventDataFromBody.pageUrl, eventSourceUrl));
    let lead = leadId !== null ? await LeadIntake.findByPk(leadId) : null;

    let resolvedClinicId = clinicIdParsed;
    let resolvedGroupId = groupIdParsed;

    if (!resolvedClinicId && lead?.clinica_id) {
      resolvedClinicId = parseInteger(lead.clinica_id);
    }
    if (!resolvedGroupId && lead?.grupo_clinica_id) {
      resolvedGroupId = parseInteger(lead.grupo_clinica_id);
    }

    if (!resolvedClinicId && resolvedGroupId !== null && clickedTel) {
      const matchedClinic = await resolveClinicByPhoneWithinGroup(resolvedGroupId, clickedTel);
      if (matchedClinic) {
        resolvedClinicId = parseInteger(matchedClinic.id_clinica);
        resolvedGroupId = parseInteger(matchedClinic.grupoClinicaId) || resolvedGroupId;
      }
    }

    if (lead) {
      const updatePayload = {
        call_initiated: true,
        call_initiated_at: new Date(),
        call_outcome: null,
        call_outcome_at: null,
        call_outcome_notes: null,
        call_outcome_appointment_id: null,
      };
      if (!lead.clinica_id && resolvedClinicId !== null) {
        updatePayload.clinica_id = resolvedClinicId;
      }
      if (!lead.grupo_clinica_id && resolvedGroupId !== null) {
        updatePayload.grupo_clinica_id = resolvedGroupId;
      }
      await lead.update(updatePayload);

      try {
        await LeadAttributionAudit.create({
          lead_intake_id: lead.id,
          raw_payload: body || {},
          attribution_steps: { action: 'call_initiated', clinic_id: resolvedClinicId, group_id: resolvedGroupId }
        });
      } catch (auditErr) {
        console.warn('⚠️ No se pudo registrar auditoría de llamada iniciada:', auditErr.message || auditErr);
      }

      try {
        await emitLeadSocketEvent(
          'lead:call_initiated',
          buildLeadCallInitiatedSocketPayload({
            lead,
            clinicId: resolvedClinicId,
            groupId: resolvedGroupId,
            clickedTel,
            pageUrl,
            source: body.source || 'web',
            sourceDetail: eventDataFromBody.source_detail || body.source_detail || 'tel_modal_call',
            linkedBy: leadId !== null ? 'lead_id' : 'phone'
          }),
          { clinicId: resolvedClinicId, groupId: resolvedGroupId }
        );
      } catch (emitErr) {
        console.warn('⚠️ No se pudo emitir lead:call_initiated:', emitErr.message || emitErr);
      }
    }
  }

  res.json({ success: true });
});

exports.verifyMetaWebhook = asyncHandler(async (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && token === META_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

const mapMetaField = (fieldData = [], name) => {
  const item = fieldData.find((f) => f.name === name);
  if (!item || !Array.isArray(item.values)) return null;
  return item.values[0] ?? null;
};

exports.receiveMetaWebhook = asyncHandler(async (req, res) => {
  if (!validateMetaSignature(req)) {
    return res.status(401).json({ message: 'Firma Meta inválida' });
  }

  const { object, entry } = req.body || {};
  if (object !== 'page' || !Array.isArray(entry)) {
    return res.status(200).json({ success: true });
  }

  for (const pageEntry of entry) {
    if (!Array.isArray(pageEntry.changes)) continue;
    for (const change of pageEntry.changes) {
      if (change.field !== 'leadgen' || !change.value) continue;
      const changeValue = change.value;
      const leadId = changeValue.leadgen_id || changeValue.lead_id;
      const formId = changeValue.form_id || null;
      const adId = changeValue.ad_id || null;
      const pageId = changeValue.page_id || pageEntry.id || null;
      if (!leadId) continue;

      let leadData = {};
      try {
        if (!META_GRAPH_TOKEN) throw new Error('META_GRAPH_TOKEN no configurado');
        const fields = 'field_data,ad_id,form_id,created_time';
        const { data } = await axios.get(`https://graph.facebook.com/${META_GRAPH_VERSION}/${leadId}`, {
          params: { access_token: META_GRAPH_TOKEN, fields }
        });
        const fd = data?.field_data || [];
        leadData = {
          nombre: mapMetaField(fd, 'full_name') || mapMetaField(fd, 'first_name'),
          email: mapMetaField(fd, 'email'),
          telefono: mapMetaField(fd, 'phone_number'),
          ref: data
        };
      } catch (fetchErr) {
        console.warn('⚠️ No se pudo obtener datos del lead de Meta:', fetchErr.message || fetchErr);
      }

      // Buscar campaña por ad_id si es posible
      let campanaId = null;
      try {
        if (adId && AdCache) {
          const adCache = await AdCache.findOne({ where: { ad_id: adId } });
          if (adCache) {
            const camp = await Campana.findOne({ where: { campaign_id: adCache.campaign_id } });
            if (camp) campanaId = camp.id;
          }
        }
      } catch (mapErr) {
        console.warn('⚠️ No se pudo mapear campana desde ad_id:', mapErr.message || mapErr);
      }

      const leadPayload = {
        event_id: leadId,
        campana_id: campanaId,
        channel: 'paid',
        source: 'meta_ads',
        source_detail: `leadgen_form:${formId || 'unknown'}`,
        utm_campaign: changeValue.campaign_name || null,
        utm_source: 'meta',
        utm_medium: 'leadgen',
        nombre: leadData.nombre || null,
        email: leadData.email || null,
        telefono: leadData.telefono || null,
        status_lead: 'nuevo',
        external_source: 'meta_leadgen',
        external_id: leadId,
        intake_payload_hash: hashValue(stableStringify(changeValue)),
        clinic_match_source: 'meta_page_id',
        clinic_match_value: pageId || null
      };

      // Intentar asignar clínica por page_id si hay mapeo activo
      try {
        if (pageId && ClinicMetaAsset) {
          const mappedPage = await ClinicMetaAsset.findOne({
            where: { metaAssetId: String(pageId), assetType: 'facebook_page', isActive: true }
          });
          if (mappedPage) {
            leadPayload.clinica_id = mappedPage.clinicaId || null;
            leadPayload.grupo_clinica_id = mappedPage.grupoClinicaId || null;
          }
        }
      } catch (mapClinicErr) {
        console.warn('⚠️ No se pudo mapear clínica desde page_id:', mapClinicErr.message || mapClinicErr);
      }

      try {
        await dedupeAndCreateLead(leadPayload, { change: changeValue, meta_lead_data: leadData }, { meta_page_id: pageId });
      } catch (err) {
        if (err.status === 409) {
          console.info(`Lead Meta duplicado (${err.message}) -> ${err.existingId}`);
          continue;
        }
        console.error('Error creando LeadIntake desde Meta webhook:', err.message || err);
      }
    }
  }

  return res.status(200).json({ success: true });
});

exports.listLeads = asyncHandler(async (req, res) => {
  const {
    clinicId,
    groupId,
    campanaId,
    channel,
    source,
    status,
    search,
    startDate,
    endDate,
    limit = 50,
    offset = 0,
    page,
    pageSize,
    sortBy,
    sortOrder
  } = req.query;

  const where = {};
  const clinicIdRaw = clinicId || req.query.clinica_id;
  const groupIdRaw = groupId || req.query.grupo_clinica_id;
  const clinicIdsParsed = parseIntegerList(clinicIdRaw);
  const groupIdParsed = groupIdRaw === 'all' ? null : parseInteger(groupIdRaw);
  const campanaIdParsed = parseInteger(campanaId || req.query.campana_id);

  if (clinicIdsParsed !== null) {
    where.clinica_id = clinicIdsParsed.length === 1 ? clinicIdsParsed[0] : { [Op.in]: clinicIdsParsed };
  }
  if (groupIdParsed !== null) where.grupo_clinica_id = groupIdParsed;
  if (campanaIdParsed !== null) where.campana_id = campanaIdParsed;
  if (channel && CHANNELS.has(channel)) where.channel = channel;
  if (source && SOURCES.has(source)) where.source = source;
  if (status && STATUSES.has(status)) where.status_lead = status;

  if (startDate || endDate) {
    where.created_at = {};
    if (startDate) where.created_at[Op.gte] = new Date(startDate);
    if (endDate) where.created_at[Op.lte] = new Date(endDate);
  }

  if (search) {
    const term = `%${search}%`;
    where[Op.or] = [
      { nombre: { [Op.like]: term } },
      { email: { [Op.like]: term } },
      { telefono: { [Op.like]: term } }
    ];
  }

  const pageSizeParsed = Math.max(parseInteger(pageSize) || Math.min(Math.max(Number(limit) || 50, 1), 200), 1);
  const pageParsed = Math.max(parseInteger(page) || 0, 0);
  const parsedOffset = pageParsed > 0 ? (pageParsed - 1) * pageSizeParsed : Math.max(Number(offset) || 0, 0);
  const parsedLimit = pageSizeParsed;

  const leads = await LeadIntake.findAndCountAll({
    where,
    include: [
      { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica'] },
      { model: GrupoClinica, as: 'grupoClinica', attributes: ['id_grupo', 'nombre_grupo'] }
    ].filter(Boolean),
    // Ordenar priorizando los que requieren reagendar (info_recibida + agenda_ocupada)
    order: [
      [
        literal(`CASE 
            WHEN status_lead = 'info_recibida' AND agenda_ocupada = true THEN 0 
            ELSE 1 
        END`),
        'ASC'
      ],
      ['created_at', 'DESC']
    ],
    limit: parsedLimit,
    offset: parsedOffset
  });

  const pageNumber = pageParsed > 0 ? pageParsed : Math.floor(parsedOffset / parsedLimit) + 1;
  const totalPages = parsedLimit > 0 ? Math.ceil(leads.count / parsedLimit) : 0;

  res.status(200).json({
    total: leads.count,
    limit: parsedLimit,
    offset: parsedOffset,
    page: pageNumber,
    pageSize: parsedLimit,
    totalPages,
    items: leads.rows
  });
});

exports.getLeadById = asyncHandler(async (req, res) => {
  const leadId = parseInteger(req.params.id);
  if (!leadId) {
    return res.status(400).json({ message: 'Lead inválido' });
  }

  const lead = await LeadIntake.findByPk(leadId, {
    include: [
      { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica'] },
      { model: GrupoClinica, as: 'grupoClinica', attributes: ['id_grupo', 'nombre_grupo'] },
      { model: Campana, as: 'campana', attributes: ['id', 'nombre', 'campaign_id'], required: false },
      {
        model: FormSubmissionEvent,
        as: 'formSubmissionEvents',
        separate: true,
        order: [['submitted_at', 'DESC']],
        limit: 10,
      },
    ],
  });

  if (!lead) {
    return res.status(404).json({ message: 'Lead no encontrado' });
  }

  const out = lead.toJSON();
  const latestFormSubmission = Array.isArray(out.formSubmissionEvents) && out.formSubmissionEvents.length
    ? out.formSubmissionEvents[0]
    : null;
  const fallbackLeadData = latestFormSubmission?.payload_json?.lead_data && typeof latestFormSubmission.payload_json.lead_data === 'object'
    ? latestFormSubmission.payload_json.lead_data
    : {};

  if (!out.nombre && fallbackLeadData.nombre) out.nombre = fallbackLeadData.nombre;
  if (!out.email && fallbackLeadData.email) out.email = normalizeEmail(fallbackLeadData.email) || fallbackLeadData.email;
  if (!out.telefono && fallbackLeadData.telefono) out.telefono = normalizePhone(fallbackLeadData.telefono) || fallbackLeadData.telefono;

  if (Conversation) {
    const conversation = await Conversation.findOne({
      where: { lead_id: leadId },
      order: [['last_message_at', 'DESC']],
      raw: true,
    });
    out.conversation_id = conversation?.id || null;
  }

  res.status(200).json(out);
});

exports.getLeadActivity = asyncHandler(async (req, res) => {
  const leadId = parseInteger(req.params.id);
  if (!leadId) {
    return res.status(400).json({ message: 'Lead inválido' });
  }

  const lead = await LeadIntake.findByPk(leadId, {
    include: [
      {
        model: FormSubmissionEvent,
        as: 'formSubmissionEvents',
        separate: true,
        order: [['submitted_at', 'DESC']],
        limit: 20,
      },
    ],
  });

  if (!lead) {
    return res.status(404).json({ message: 'Lead no encontrado' });
  }

  const conversations = await Conversation.findAll({
    where: { lead_id: leadId },
    attributes: ['id', 'channel'],
    raw: true,
  });
  const conversationIds = conversations.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);

  const messages = conversationIds.length
    ? await Message.findAll({
        where: { conversation_id: { [Op.in]: conversationIds } },
        attributes: [
          'id',
          'conversation_id',
          'sender_id',
          'direction',
          'content',
          'message_type',
          'status',
          'metadata',
          'sent_at',
          'createdAt',
        ],
        order: [['createdAt', 'DESC']],
        raw: true,
        limit: 100,
      })
    : [];

  const actorIds = Array.from(new Set(
    messages
      .map((message) => Number(message.sender_id))
      .filter((id) => Number.isFinite(id) && id > 0)
  ));

  const usuarios = actorIds.length
    ? await Usuario.findAll({
        where: { id_usuario: { [Op.in]: actorIds } },
        attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario'],
        raw: true,
      })
    : [];
  const usuariosById = new Map(usuarios.map((usuario) => [Number(usuario.id_usuario), usuario]));

  const items = [];

  for (const event of lead.formSubmissionEvents || []) {
    const detailParts = [];
    if (event.form_name) detailParts.push(event.form_name);
    if (event.page_url) detailParts.push(event.page_url);
    items.push({
      id: `lead-form-${event.id}`,
      leadId: String(leadId),
      fecha: event.submitted_at || event.created_at || lead.created_at,
      tipo: 'lead_form_submitted',
      titulo: 'Formulario enviado',
      descripcion: detailParts.join(' · ') || 'Envío de formulario web',
      icono: 'heroicons_outline:document-text',
      color: 'info',
      detalles: {
        form_id: event.form_id || null,
        form_name: event.form_name || null,
        page_url: event.page_url || null,
      },
    });
  }

  for (const contacto of Array.isArray(lead.historial_contactos) ? lead.historial_contactos : []) {
    items.push({
      id: `lead-contact-${leadId}-${contacto.fecha}`,
      leadId: String(leadId),
      fecha: contacto.fecha || lead.updated_at || lead.created_at,
      tipo: 'lead_contact_attempt',
      titulo: 'Contacto registrado',
      descripcion: contacto.notas || contacto.motivo || 'Intento de contacto',
      icono: 'heroicons_outline:phone',
      color: 'warning',
      usuarioId: contacto.usuario_id ? String(contacto.usuario_id) : null,
      detalles: {
        motivo: contacto.motivo || null,
      },
    });
  }

  items.push({
    id: `lead-created-${leadId}`,
    leadId: String(leadId),
    fecha: lead.created_at,
    tipo: 'lead_created',
    titulo: 'Lead creado',
    descripcion: buildLeadCreatedDescription(lead),
    icono: 'heroicons_outline:user-plus',
    color: 'success',
  });

  for (const message of messages) {
    const actor = usuariosById.get(Number(message.sender_id));
    const createdAt = message.sent_at || message.createdAt || lead.updated_at || lead.created_at;
    const text = cleanString(message.content) || '—';
    const isFailed = String(message.status || '').toLowerCase() === 'failed';
    const metadata = message.metadata && typeof message.metadata === 'object' ? message.metadata : {};
    const waError = Array.isArray(metadata.wa_error) && metadata.wa_error.length
      ? cleanString(metadata.wa_error[0]?.message) || cleanString(metadata.wa_error[0]?.title)
      : null;

    if (message.direction === 'outbound') {
      const isTemplate = message.message_type === 'template';
      items.push({
        id: `lead-message-${message.id}`,
        leadId: String(leadId),
        fecha: createdAt,
        tipo: isTemplate ? 'lead_whatsapp_template_sent' : 'lead_whatsapp_message_sent',
        titulo: isTemplate ? 'Plantilla de WhatsApp enviada' : 'Mensaje de WhatsApp enviado',
        descripcion: isFailed && waError ? `${text} · ${waError}` : text,
        icono: isTemplate ? 'heroicons_outline:document-text' : 'heroicons_outline:chat-bubble-left-right',
        color: isFailed ? 'warning' : 'info',
        usuarioId: actor ? String(actor.id_usuario) : null,
        usuarioNombre: buildActorLabel(actor),
        detalles: {
          status: message.status || null,
          message_type: message.message_type || null,
          conversation_id: message.conversation_id || null,
        },
      });
      continue;
    }

    items.push({
      id: `lead-message-${message.id}`,
      leadId: String(leadId),
      fecha: createdAt,
      tipo: 'lead_whatsapp_reply',
      titulo: 'Respuesta recibida por WhatsApp',
      descripcion: text,
      icono: 'heroicons_outline:chat-bubble-left-right',
      color: 'info',
      usuarioId: null,
      usuarioNombre: cleanString(lead.nombre) || 'Lead',
      detalles: {
        status: message.status || null,
        message_type: message.message_type || null,
        conversation_id: message.conversation_id || null,
      },
    });
  }

  return res.status(200).json(
    items.sort((a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime())
  );
});

exports.getLeadStats = asyncHandler(async (req, res) => {
  const {
    clinicId,
    groupId,
    campanaId,
    channel,
    source,
    search,
    startDate,
    endDate
  } = req.query;

  const where = {};
  const clinicIdRaw = clinicId || req.query.clinica_id;
  const groupIdRaw = groupId || req.query.grupo_clinica_id;
  const clinicIdsParsed = parseIntegerList(clinicIdRaw);
  const groupIdParsed = groupIdRaw === 'all' ? null : parseInteger(groupIdRaw);
  const campanaIdParsed = parseInteger(campanaId || req.query.campana_id);

  if (clinicIdsParsed !== null) {
    where.clinica_id = clinicIdsParsed.length === 1 ? clinicIdsParsed[0] : { [Op.in]: clinicIdsParsed };
  }
  if (groupIdParsed !== null) where.grupo_clinica_id = groupIdParsed;
  if (campanaIdParsed !== null) where.campana_id = campanaIdParsed;
  if (channel && CHANNELS.has(channel)) where.channel = channel;
  if (source && SOURCES.has(source)) where.source = source;

  if (startDate || endDate) {
    where.created_at = {};
    if (startDate) where.created_at[Op.gte] = new Date(startDate);
    if (endDate) where.created_at[Op.lte] = new Date(endDate);
  }

  if (search) {
    const term = `%${search}%`;
    where[Op.or] = [
      { nombre: { [Op.like]: term } },
      { email: { [Op.like]: term } },
      { telefono: { [Op.like]: term } }
    ];
  }

  // Obtener conteos por estado
  const total = await LeadIntake.count({ where });
  const nuevos = await LeadIntake.count({ where: { ...where, status_lead: 'nuevo' } });
  const contactados = await LeadIntake.count({ where: { ...where, status_lead: 'contactado' } });
  const esperando_info = await LeadIntake.count({ where: { ...where, status_lead: 'esperando_info' } });
  const info_recibida = await LeadIntake.count({ where: { ...where, status_lead: 'info_recibida' } });
  const citados = await LeadIntake.count({ where: { ...where, status_lead: 'citado' } });
  const acudio_cita = await LeadIntake.count({ where: { ...where, status_lead: 'acudio_cita' } });
  const convertidos = await LeadIntake.count({ where: { ...where, status_lead: 'convertido' } });
  const descartados = await LeadIntake.count({ where: { ...where, status_lead: 'descartado' } });

  const tasa_conversion = total > 0 ? (convertidos / total) * 100 : 0;

  res.status(200).json({
    total,
    nuevos,
    contactados,
    esperando_info,
    info_recibida,
    citados,
    acudio_cita,
    convertidos,
    descartados,
    tasa_conversion
  });
});

exports.updateLeadStatus = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { status_lead, notas_internas, asignado_a, motivo_descarte } = req.body || {};

  const lead = await LeadIntake.findByPk(id);
  if (!lead) {
    return res.status(404).json({ message: 'Lead no encontrado' });
  }

  if (status_lead && !STATUSES.has(status_lead)) {
    return res.status(400).json({ message: 'status_lead inválido' });
  }

  if (status_lead === 'descartado' && !motivo_descarte) {
    return res.status(400).json({ message: 'motivo_descarte es obligatorio al descartar' });
  }

  const updatePayload = {};
  if (status_lead) updatePayload.status_lead = status_lead;
  if (notas_internas !== undefined) updatePayload.notas_internas = notas_internas;
  if (asignado_a !== undefined) updatePayload.asignado_a = asignado_a;
  if (motivo_descarte !== undefined) updatePayload.motivo_descarte = motivo_descarte;

  await lead.update(updatePayload);

  try {
    await LeadAttributionAudit.create({
      lead_intake_id: lead.id,
      raw_payload: { status_lead, notas_internas, asignado_a, motivo_descarte },
      attribution_steps: { action: 'status_update', userId: req.userData?.userId || null }
    });
  } catch (auditErr) {
    console.warn('⚠️ No se pudo registrar auditoría de cambio de estado:', auditErr.message || auditErr);
  }

  res.status(200).json(lead);
});

exports.registrarContacto = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { motivo, notas } = req.body || {};

  const lead = await LeadIntake.findByPk(id);
  if (!lead) {
    return res.status(404).json({ message: 'Lead no encontrado' });
  }

  // Obtener historial actual o inicializar
  const historial = lead.historial_contactos || [];
  
  // Añadir nuevo registro de contacto
  const nuevoContacto = {
    fecha: new Date().toISOString(),
    motivo: motivo || 'no_contesta',
    notas: notas || null,
    usuario_id: req.userData?.userId || null
  };
  
  historial.push(nuevoContacto);

  // Actualizar el lead
  await lead.update({
    historial_contactos: historial,
    num_contactos: (lead.num_contactos || 0) + 1,
    ultimo_contacto: new Date(),
    status_lead: 'contactado'
  });

  // Registrar auditoría
  try {
    await LeadAttributionAudit.create({
      lead_intake_id: lead.id,
      raw_payload: { action: 'registrar_contacto', motivo, notas },
      attribution_steps: { action: 'registrar_contacto', userId: req.userData?.userId || null }
    });
  } catch (auditErr) {
    console.warn('⚠️ No se pudo registrar auditoría de contacto:', auditErr.message || auditErr);
  }

  res.status(200).json(lead);
});

exports.saveCallOutcome = asyncHandler(async (req, res) => {
  const leadId = parseInteger(req.params.id);
  const outcome = cleanString(req.body?.outcome);
  const appointmentId = parseInteger(req.body?.appointment_id);
  const notes = cleanString(req.body?.notes);

  if (leadId === null) {
    return res.status(400).json({ message: 'Lead inválido' });
  }

  if (!CALL_OUTCOMES.has(outcome)) {
    return res.status(400).json({ message: 'call_outcome inválido' });
  }

  const lead = await LeadIntake.findByPk(leadId);
  if (!lead) {
    return res.status(404).json({ message: 'Lead no encontrado' });
  }

  const updatePayload = {
    call_initiated: true,
    call_outcome: outcome,
    call_outcome_at: new Date(),
    call_outcome_notes: notes || null,
    call_outcome_appointment_id: appointmentId || null,
  };

  if (!lead.call_initiated_at) {
    updatePayload.call_initiated_at = new Date();
  }
  if (outcome === 'citado') {
    updatePayload.status_lead = 'citado';
  } else if (outcome === 'informacion' && lead.status_lead === 'nuevo') {
    updatePayload.status_lead = 'contactado';
  }

  await lead.update(updatePayload);

  try {
    await LeadAttributionAudit.create({
      lead_intake_id: lead.id,
      raw_payload: { outcome, appointment_id: appointmentId, notes },
      attribution_steps: { action: 'call_outcome', userId: req.userData?.userId || null }
    });
  } catch (auditErr) {
    console.warn('⚠️ No se pudo registrar auditoría de call_outcome:', auditErr.message || auditErr);
  }

  try {
    await emitLeadSocketEvent(
      'lead:call_outcome',
      buildLeadCallOutcomeSocketPayload({
        lead,
        clinicId: lead.clinica_id,
        groupId: lead.grupo_clinica_id
      }),
      { clinicId: lead.clinica_id, groupId: lead.grupo_clinica_id }
    );
  } catch (emitErr) {
    console.warn('⚠️ No se pudo emitir lead:call_outcome:', emitErr.message || emitErr);
  }

  return res.status(200).json({ lead });
});

exports.deleteLead = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const lead = await LeadIntake.findByPk(id);
  if (!lead) {
    return res.status(404).json({ message: 'Lead no encontrado' });
  }

  // Registrar auditoría antes de eliminar
  try {
    await LeadAttributionAudit.create({
      lead_intake_id: lead.id,
      raw_payload: { action: 'delete', lead_data: lead.toJSON() },
      attribution_steps: { action: 'delete', userId: req.userData?.userId || null }
    });
  } catch (auditErr) {
    console.warn('⚠️ No se pudo registrar auditoría de eliminación:', auditErr.message || auditErr);
  }

  await lead.destroy();

  res.status(200).json({ message: 'Lead eliminado correctamente', id: parseInt(id) });
});
