const crypto = require('crypto');
const axios = require('axios');
const asyncHandler = require('express-async-handler');
const db = require('../../models');
const { Op, literal } = db.Sequelize;

const LeadIntake = db.LeadIntake;
const LeadAttributionAudit = db.LeadAttributionAudit;
const Clinica = db.Clinica;
const GrupoClinica = db.GrupoClinica;
const Campana = db.Campana;
const AdCache = db.AdCache;
const ClinicMetaAsset = db.ClinicMetaAsset;
const ClinicGoogleAdsAccount = db.ClinicGoogleAdsAccount;
const IntakeConfig = db.IntakeConfig;
const { sendMetaEvent, buildUserData: buildMetaUserData } = require('../services/metaCapi.service');
const { uploadClickConversion } = require('../services/googleAdsConversion.service');

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
const coalesce = (...values) => values.find(v => v !== undefined && v !== null);

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

const stableStringify = (obj) => {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map(k => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
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
  if (!validateSignature(req)) {
    return res.status(401).json({ message: 'Firma HMAC inválida o ausente' });
  }

  const eventId = (req.headers[EVENT_ID_HEADER] || req.body?.event_id || req.body?.eventId || null) || null;

  const {
    clinica_id,
    grupo_clinica_id,
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
  } = req.body || {};

  let clinicaIdParsed = parseInteger(clinica_id);
  let grupoClinicaIdParsed = parseInteger(grupo_clinica_id);
  const campanaIdParsed = parseInteger(campana_id);
  const attribution = req.body?.attribution || {};
  const leadData = req.body?.lead_data || {};

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

  const leadNombre = sanitizeText(coalesce(leadData.nombre, nombre));
  const leadEmail = coalesce(leadData.email, email);
  const leadTelefono = coalesce(leadData.telefono, telefono);
  const leadNotas = sanitizeText(coalesce(leadData.notas, notas));
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
  try {
    lead = await dedupeAndCreateLead(leadPayload, req.body || {}, {
      clinic_match_source: clinic_match_source || null,
      clinic_match_value: clinic_match_value || null
    });
  } catch (err) {
    if (err.status === 409) {
      return res.status(409).json({ message: err.message, id: err.existingId, reason: err.message });
    }
    throw err;
  }

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
      eventName: 'Lead',
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

  res.status(201).json({ id: lead.id });
});

// ===========================
// Configuración del snippet
// ===========================

const defaultConfigPayload = (clinicId, groupId) => ({
  clinic_id: clinicId || null,
  group_id: groupId || null,
  assignment_scope: groupId ? 'group' : 'clinic',
  domains: [],
  features: { chat_enabled: true, tel_modal_enabled: true, viewcontent_enabled: true, form_intercept_enabled: true },
  flow: null,
  texts: null,
  locations: [],
  has_hmac: false,
  config: {}
});

exports.getIntakeConfig = asyncHandler(async (req, res) => {
  const clinicIdRaw = req.query.clinic_id;
  const groupIdRaw = req.query.group_id;
  const domain = (req.query.domain || '').toLowerCase();
  const clinicIdParsed = parseInteger(clinicIdRaw);
  const groupIdParsed = parseInteger(groupIdRaw);

  let record = null;
  // Prioridad: clínica explícita > dominio (clínica) > grupo explícito > dominio (grupo)
  if (clinicIdParsed !== null) {
    record = await IntakeConfig.findOne({ where: { clinic_id: clinicIdParsed }, raw: true });
  }
  if (!record && domain) {
    record = await IntakeConfig.findOne({
      where: db.Sequelize.literal(`JSON_CONTAINS(COALESCE(domains,'[]'), '\"${domain}\"') AND assignment_scope='clinic'`)
    });
    if (record && record.get) record = record.get({ plain: true });
  }
  if (!record && groupIdParsed !== null) {
    record = await IntakeConfig.findOne({ where: { group_id: groupIdParsed, assignment_scope: 'group' }, raw: true });
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
    payload.features = cfg.features || payload.features;
    payload.flow = cfg.flow || null;
    payload.texts = cfg.texts || null;
    payload.locations = cfg.locations || [];
    payload.config = cfg;
    payload.has_hmac = !!record.hmac_key;
    if (domain && payload.domains.length > 0 && !payload.domains.includes(domain)) {
      return res.status(403).json({ message: 'Domain not allowed' });
    }
  }

  return res.json(payload);
});

exports.upsertIntakeConfig = asyncHandler(async (req, res) => {
  const clinicId = parseInteger(req.params.clinicId);
  const groupId = parseInteger(req.body?.group_id);
  if (!clinicId && !groupId) return res.status(400).json({ message: 'clinicId o group_id requerido' });

  const scope = groupId ? 'group' : 'clinic';
  const { domains = [], config = {}, hmac_key } = req.body || {};
  await IntakeConfig.upsert({
    clinic_id: clinicId || null,
    group_id: groupId || null,
    assignment_scope: scope,
    domains,
    config,
    hmac_key: hmac_key || null
  });

  res.json({ success: true });
});

// ===========================
// Eventos genéricos (ViewContent, Contact, Schedule, Purchase)
// ===========================

const validateHmac = (body, secret, provided) => {
  if (!secret) return true;
  if (!provided) return false;
  const expected = crypto.createHmac('sha256', secret).update(stableStringify(body)).digest('hex');
  return expected === provided;
};

exports.receiveIntakeEvent = asyncHandler(async (req, res) => {
  const {
    event_name,
    clinic_id,
    domain,
    event_time,
    event_id,
    action_source,
    event_source_url,
    custom_data = {},
    user_data = {},
    fbp,
    fbc
  } = req.body || {};

  const clinicIdParsed = parseInteger(clinic_id);

  let cfg = null;
  if (clinicIdParsed !== null) {
    cfg = await IntakeConfig.findOne({ where: { clinic_id: clinicIdParsed }, raw: true });
  } else if (domain) {
    cfg = await IntakeConfig.findOne({
      where: db.Sequelize.literal(`JSON_CONTAINS(COALESCE(domains,'[]'), '\"${domain.toLowerCase()}\"')`)
    });
    if (cfg) cfg = cfg.get({ plain: true });
  }

  if (cfg && cfg.domains && cfg.domains.length > 0 && domain && !cfg.domains.includes(domain.toLowerCase())) {
    return res.status(403).json({ message: 'Domain not allowed' });
  }

  if (cfg && cfg.hmac_key) {
    const provided = req.headers['x-cc-signature'] || req.headers['x-cc-signature-sha256'];
    if (!validateHmac(req.body || {}, cfg.hmac_key, provided)) {
      return res.status(401).json({ message: 'Invalid signature' });
    }
  }

  const userData = buildMetaUserData({
    email: user_data.email,
    phone: user_data.phone,
    ip: user_data.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress,
    ua: user_data.ua || req.headers['user-agent'],
    fbp: fbp || user_data.fbp,
    fbc: fbc || user_data.fbc,
    externalId: user_data.external_id
  });

  await sendMetaEvent({
    eventName: event_name || 'ViewContent',
    eventTime: event_time || Math.floor(Date.now() / 1000),
    eventId: event_id || undefined,
    actionSource: action_source || 'website',
    eventSourceUrl: event_source_url || undefined,
    clinicId: cfg?.clinic_id || clinicIdParsed || null,
    source: custom_data.source,
    sourceDetail: custom_data.source_detail,
    utmCampaign: custom_data.utm_campaign,
    value: custom_data.value,
    currency: custom_data.currency || 'EUR',
    userData
  });

  // Google Ads server-side (si hay gclid/gbraid/wbraid y conversionAction configurado)
  try {
    const sendTo = custom_data.send_to || null;
    const conversionAction = custom_data.conversion_action || null;
    if ((custom_data.gclid || custom_data.gbraid || custom_data.wbraid) && (sendTo || conversionAction)) {
      const actionResource = conversionAction || `customers/${process.env.GOOGLE_ADS_CUSTOMER_ID.replace(/-/g, '')}/conversionActions/${(sendTo || '').split('/')[1] || ''}`;
      await uploadClickConversion({
        conversionAction: actionResource,
        gclid: custom_data.gclid,
        gbraid: custom_data.gbraid,
        wbraid: custom_data.wbraid,
        value: custom_data.value || 0,
        currency: custom_data.currency || 'EUR',
        conversionDateTime: custom_data.conversion_time || new Date().toISOString(),
        externalId: user_data.external_id || event_id,
        userAgent: user_data.ua || req.headers['user-agent'],
        ipAddress: user_data.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress
      });
    }
  } catch (adsErr) {
    console.warn('⚠️ Google Ads upload error:', adsErr.response?.data || adsErr.message || adsErr);
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
  const clinicIdParsed = clinicIdRaw === 'all' ? null : parseInteger(clinicIdRaw);
  const groupIdParsed = groupIdRaw === 'all' ? null : parseInteger(groupIdRaw);
  const campanaIdParsed = parseInteger(campanaId || req.query.campana_id);

  if (clinicIdParsed !== null) where.clinica_id = clinicIdParsed;
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
  const clinicIdParsed = clinicIdRaw === 'all' ? null : parseInteger(clinicIdRaw);
  const groupIdParsed = groupIdRaw === 'all' ? null : parseInteger(groupIdRaw);
  const campanaIdParsed = parseInteger(campanaId || req.query.campana_id);

  if (clinicIdParsed !== null) where.clinica_id = clinicIdParsed;
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
