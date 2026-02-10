const crypto = require('crypto');
const axios = require('axios');
const dns = require('dns').promises;
const net = require('net');
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
const Conversation = db.Conversation;
const Message = db.Message;
const { sendMetaEvent, buildUserData: buildMetaUserData } = require('../services/metaCapi.service');
const { uploadClickConversion } = require('../services/googleAdsConversion.service');
const whatsappService = require('../services/whatsapp.service');
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

// ======================================
// QuickChat summary (chatbot)
// ======================================

function isQuickchatSummaryRequest(body = {}) {
  const sourceRaw = coalesce(body.source, body.Source, body.source_type);
  const sourceDetailRaw = coalesce(body.source_detail, body.sourceDetail, body.sourceDetailRaw);
  return (
    String(sourceRaw || '').toLowerCase() === 'chatbot_quickchat' ||
    String(sourceDetailRaw || '').toLowerCase() === 'chatbot_quickchat'
  );
}

function formatExtraPairs(pairs) {
  if (!Array.isArray(pairs) || pairs.length === 0) return '';
  const safe = pairs
    .filter((p) => p && p.key && p.value !== undefined && p.value !== null)
    .slice(0, 20)
    .map((p) => {
      let value = p.value;
      if (typeof value === 'object') {
        try {
          value = JSON.stringify(value);
        } catch {
          value = '[object]';
        }
      }
      value = String(value);
      if (value.length > 140) value = value.slice(0, 140) + '...';
      return `- ${p.key}: ${value}`;
    });
  return safe.length ? `\n\nDatos recogidos:\n${safe.join('\n')}` : '';
}

function buildQuickchatSummaryMessage({ nombre, telefono, email, pageUrl, extraPairs }) {
  const lines = [];
  lines.push('Nuevo paciente potencial desde el chatbot de la web.');
  if (pageUrl) lines.push(`Pagina: ${pageUrl}`);
  lines.push(`Nombre: ${nombre || '-'}`);
  lines.push(`Telf: ${telefono || '-'}`);
  lines.push(`Email: ${email || '-'}`);
  lines.push('Puedes contestarle por aqui directamente (WhatsApp), aunque recomiendo intentar llamarle primero.');
  return lines.join('\n') + formatExtraPairs(extraPairs);
}

async function sendQuickchatSummaryToQuickChat({
  clinicId,
  leadIntakeId,
  nombre,
  telefono,
  email,
  pageUrl,
  extraPairs
}) {
  if (!clinicId) {
    return { sent: false, reason: 'clinic_id requerido para QuickChat' };
  }

  const phoneE164 = whatsappService.normalizePhoneNumber(telefono);
  const channel = phoneE164 ? 'whatsapp' : 'internal';
  const contactId = phoneE164 || 'web-leads';

  const [conversation] = await Conversation.findOrCreate({
    where: { clinic_id: clinicId, channel, contact_id: contactId },
    defaults: {
      clinic_id: clinicId,
      channel,
      contact_id: contactId,
      last_message_at: new Date(),
      unread_count: 0,
      // Nota: no seteamos last_inbound_at. Para WhatsApp, esto fuerza el flujo de plantilla si no hay inbound real.
      last_inbound_at: null,
    }
  });

  const content = buildQuickchatSummaryMessage({
    nombre,
    telefono: phoneE164 || telefono || null,
    email,
    pageUrl,
    extraPairs
  });

  const msg = await Message.create({
    conversation_id: conversation.id,
    sender_id: null,
    direction: 'inbound',
    content,
    message_type: 'event',
    status: 'sent',
    sent_at: new Date(),
    metadata: {
      source: 'snippet_chatbot',
      kind: 'quickchat_summary',
      lead_intake_id: leadIntakeId || null,
    }
  });

  conversation.last_message_at = new Date();
  await conversation.save();

  // Socket event (si está activo). Si la conversación es nueva, QuickChat la verá por polling.
  const io = getIO();
  if (io) {
    const room = `clinic:${clinicId}`;
    io.to(room).emit('message:created', {
      id: msg.id,
      conversation_id: String(conversation.id),
      content: msg.content,
      direction: msg.direction,
      message_type: msg.message_type,
      status: msg.status,
      sent_at: msg.sent_at,
    });
  }

  return { sent: true, channel, conversation_id: conversation.id, message_id: msg.id };
}

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
  const wantsQuickchatSummary = isQuickchatSummaryRequest(body);

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

  let cfg = null;
  if (clinicaIdParsed !== null) {
    cfg = await IntakeConfig.findOne({ where: { clinic_id: clinicaIdParsed }, raw: true });
  } else if (grupoClinicaIdParsed !== null) {
    cfg = await IntakeConfig.findOne({ where: { group_id: grupoClinicaIdParsed, assignment_scope: 'group' }, raw: true });
  } else if (domain) {
    cfg = await IntakeConfig.findOne({
      where: db.Sequelize.literal(`JSON_CONTAINS(COALESCE(domains,'[]'), '\"${domain.toLowerCase()}\"')`)
    });
    if (cfg) cfg = cfg.get ? cfg.get({ plain: true }) : cfg;
  }

  if (cfg && Array.isArray(cfg.domains) && cfg.domains.length > 0) {
    if (!domain || !isDomainAllowed(cfg.domains, domain)) {
      return res.status(403).json({ message: 'Domain not allowed' });
    }
  }

  const providedSignature = req.headers[SIGNATURE_HEADER] || req.headers[SIGNATURE_HEADER_SHA];
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
    email: leadEmail || null,
    telefono: leadTelefono || null,
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
      if (wantsQuickchatSummary && err.existingId) {
        let existing = null;
        try {
          existing = await LeadIntake.findByPk(err.existingId, { raw: true });
        } catch {
          existing = null;
        }

        const clinicIdForChat = coalesce(clinicaIdParsed, existing?.clinica_id);
        const nombreForChat = coalesce(leadNombre, existing?.nombre);
        const telefonoForChat = coalesce(leadTelefono, existing?.telefono);
        const emailForChat = coalesce(leadEmail, existing?.email);

        const chatStateData =
          (body.chat_state && typeof body.chat_state === 'object' ? body.chat_state.data : null) ||
          (body.chatState && typeof body.chatState === 'object' ? body.chatState.data : null) ||
          null;
        const extraPairs = [];
        const addPairs = (obj) => {
          if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
          Object.entries(obj).forEach(([k, v]) => {
            if (['nombre', 'email', 'telefono', 'notas', 'notes', 'message', 'phone', 'tel', 'name'].includes(String(k))) return;
            extraPairs.push({ key: String(k), value: v });
          });
        };
        addPairs(chatStateData);
        addPairs(leadData);

        let summaryResult = { sent: false };
        try {
          summaryResult = await sendQuickchatSummaryToQuickChat({
            clinicId: clinicIdForChat,
            leadIntakeId: err.existingId,
            nombre: nombreForChat,
            telefono: telefonoForChat,
            email: emailForChat,
            pageUrl: pageUrlValue || landingUrlValue || null,
            extraPairs
          });
        } catch (e) {
          console.warn('⚠️ No se pudo enviar resumen a QuickChat:', e.message || e);
        }

        return res.status(200).json({
          id: err.existingId,
          deduped: true,
          quickchat_summary_sent: !!summaryResult?.sent
        });
      }

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

  let quickchatSummarySent = false;
  if (wantsQuickchatSummary) {
    const chatStateData =
      (body.chat_state && typeof body.chat_state === 'object' ? body.chat_state.data : null) ||
      (body.chatState && typeof body.chatState === 'object' ? body.chatState.data : null) ||
      null;
    const extraPairs = [];
    const addPairs = (obj) => {
      if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
      Object.entries(obj).forEach(([k, v]) => {
        if (['nombre', 'email', 'telefono', 'notas', 'notes', 'message', 'phone', 'tel', 'name'].includes(String(k))) return;
        extraPairs.push({ key: String(k), value: v });
      });
    };
    addPairs(chatStateData);
    addPairs(leadData);

    try {
      const summaryResult = await sendQuickchatSummaryToQuickChat({
        clinicId: clinicaIdParsed,
        leadIntakeId: lead.id,
        nombre: leadNombre,
        telefono: leadTelefono,
        email: leadEmail,
        pageUrl: pageUrlValue || landingUrlValue || null,
        extraPairs
      });
      quickchatSummarySent = !!summaryResult?.sent;
    } catch (e) {
      console.warn('⚠️ No se pudo enviar resumen a QuickChat:', e.message || e);
    }
  }

  res.status(201).json({ id: lead.id, quickchat_summary_sent: quickchatSummarySent });
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
  tel_modal_title: 'Antes de llamar...',
  tel_modal_subtitle: 'Dejanos tus datos por si se corta la comunicacion.',
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
  show_branding: true
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
  texts: DEFAULT_TEXTS,
  locations: [],
  has_hmac: false,
  config: {}
});

exports.getIntakeConfig = asyncHandler(async (req, res) => {
  // Evitar respuestas cacheadas (la config puede cambiar desde el panel y el snippet debe reflejarlo al instante).
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  const clinicIdRaw = req.query.clinic_id;
  const groupIdRaw = req.query.group_id;
  const domain = normalizeDomain(String(req.query.domain || '')) || '';
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
    payload.features = { ...payload.features, ...(cfg.features || {}) };
    payload.flow = cfg.flow || payload.flow;
    payload.flows = cfg.flows || payload.flows;
    payload.appearance = { ...payload.appearance, ...(cfg.appearance || {}) };
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
        attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'],
        raw: true
      });
      resolvedGroupId = clinicRow?.grupoClinicaId || null;
    }

    if (resolvedGroupId) {
      const clinics = await Clinica.findAll({
        where: { grupoClinicaId: resolvedGroupId },
        attributes: ['id_clinica', 'nombre_clinica'],
        order: [['nombre_clinica', 'ASC']],
        raw: true
      });
      payload.available_locations = clinics.map((c) => ({
        id: c.id_clinica,
        label: c.nombre_clinica
      }));
    } else if (payload.clinic_id) {
      if (!clinicRow) {
        clinicRow = await Clinica.findOne({
          where: { id_clinica: payload.clinic_id },
          attributes: ['id_clinica', 'nombre_clinica'],
          raw: true
        });
      }
      if (clinicRow) {
        payload.available_locations = [{ id: clinicRow.id_clinica, label: clinicRow.nombre_clinica }];
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
    config = body.config;
  } else {
    const features = body.features && typeof body.features === 'object' ? body.features : undefined;
    const flow = body.flow && typeof body.flow === 'object' ? body.flow : undefined;
    const flows = Array.isArray(body.flows) ? body.flows : undefined;
    const appearance = body.appearance && typeof body.appearance === 'object' && !Array.isArray(body.appearance) ? body.appearance : undefined;
    const texts = body.texts && typeof body.texts === 'object' ? body.texts : undefined;
    const locations = Array.isArray(body.locations) ? body.locations : undefined;
    config = {
      ...(features ? { features } : {}),
      ...(flow ? { flow } : {}),
      ...(flows ? { flows } : {}),
      ...(appearance ? { appearance } : {}),
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
// Verificador de instalación del snippet (solo UI autenticada)
// ======================================

const isPrivateIpv4 = (ip) => {
  const parts = String(ip).split('.').map((p) => parseInt(p, 10));
  if (parts.length !== 4 || parts.some((n) => !Number.isFinite(n) || n < 0 || n > 255)) return true;
  const [a, b] = parts;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  return false;
};

const isPrivateIpv6 = (ip) => {
  const v = String(ip).trim().toLowerCase();
  if (!v) return true;
  if (v === '::1' || v === '0:0:0:0:0:0:0:1') return true; // loopback
  if (v === '::' || v === '0:0:0:0:0:0:0:0') return true; // unspecified
  if (v.startsWith('fe80:')) return true; // link-local
  if (v.startsWith('fc') || v.startsWith('fd')) return true; // unique local (fc00::/7)
  return false;
};

const isPrivateIp = (ip) => {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateIpv4(ip);
  if (kind === 6) return isPrivateIpv6(ip);
  return true;
};

const ensureSafePublicDomain = async (domain) => {
  const host = normalizeDomain(domain);
  if (!host) throw new Error('Domain requerido');

  // No permitir IPs directas ni localhost (evita SSRF a red interna).
  if (net.isIP(host)) throw new Error('Domain inválido (IP no permitida)');
  if (host === 'localhost' || host.endsWith('.local')) throw new Error('Domain inválido (host local no permitido)');

  const addrs = await dns.lookup(host, { all: true, verbatim: true });
  if (!Array.isArray(addrs) || addrs.length === 0) throw new Error('No se pudo resolver el dominio');
  for (const a of addrs) {
    if (a?.address && isPrivateIp(a.address)) {
      throw new Error('El dominio resuelve a una IP privada (no permitido)');
    }
  }
};

const isHostWithinRoot = (host, root) => {
  const h = stripWww(normalizeDomain(host));
  const r = stripWww(normalizeDomain(root));
  if (!h || !r) return false;
  return h === r || h.endsWith('.' + r);
};

const fetchHtmlWithRedirects = async (startUrl, rootDomain) => {
  let currentUrl = startUrl;
  for (let i = 0; i < 5; i += 1) {
    const resp = await axios.get(currentUrl, {
      timeout: 8000,
      maxRedirects: 0,
      responseType: 'text',
      headers: {
        'User-Agent': 'ClinicaClickSnippetVerifier/1.0',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      maxContentLength: 1024 * 1024,
      maxBodyLength: 1024 * 1024,
      validateStatus: (status) => status >= 200 && status < 400,
    });

    if (resp.status >= 300 && resp.status < 400 && resp.headers?.location) {
      const next = new URL(resp.headers.location, currentUrl);
      if (!['http:', 'https:'].includes(next.protocol)) {
        throw new Error('Redirect no permitido');
      }
      if (!isHostWithinRoot(next.hostname, rootDomain)) {
        throw new Error('Redirect a dominio no permitido');
      }
      currentUrl = next.toString();
      continue;
    }

    if (resp.status >= 200 && resp.status < 300) {
      return { final_url: currentUrl, html: String(resp.data || '') };
    }

    throw new Error(`Status inesperado: ${resp.status}`);
  }
  throw new Error('Demasiados redirects');
};

const findIntakeScripts = (html) => {
  const scripts = [];
  if (!html || typeof html !== 'string') return scripts;

  const scriptTagRegex = /<script\b[^>]*\bsrc\s*=\s*(['"])([^'"]+)\1[^>]*>/gim;
  let match;
  while ((match = scriptTagRegex.exec(html)) !== null) {
    const tag = match[0];
    const src = match[2] || '';
    if (!src.toLowerCase().includes('intake.js')) continue;

    const clinicMatch = tag.match(/\bdata-clinic-id\s*=\s*(['"])([^'"]+)\1/i);
    const groupMatch = tag.match(/\bdata-group-id\s*=\s*(['"])([^'"]+)\1/i);

    scripts.push({
      tag,
      src,
      data_clinic_id: clinicMatch ? clinicMatch[2] : null,
      data_group_id: groupMatch ? groupMatch[2] : null
    });
  }
  return scripts;
};

exports.verifySnippet = asyncHandler(async (req, res) => {
  const domain = normalizeDomain(String(req.query.domain || '')) || '';
  const clinicId = parseInteger(coalesce(req.query.clinic_id, req.query.clinicId));
  const groupId = parseInteger(coalesce(req.query.group_id, req.query.groupId));

  if (!domain) {
    return res.status(400).json({ installed: false, details: 'domain es obligatorio' });
  }
  if (clinicId === null && groupId === null) {
    return res.status(400).json({ installed: false, details: 'clinic_id o group_id es obligatorio' });
  }
  if (clinicId !== null && groupId !== null) {
    return res.status(400).json({ installed: false, details: 'No se permite enviar clinic_id y group_id a la vez' });
  }

  const record = await IntakeConfig.findOne({
    where: groupId !== null
      ? { group_id: groupId, assignment_scope: 'group' }
      : { clinic_id: clinicId },
    raw: true
  });

  if (!record) {
    return res.status(404).json({ installed: false, details: 'No existe configuración de intake para este scope (guarda primero)' });
  }
  if (!Array.isArray(record.domains) || record.domains.length === 0) {
    return res.status(400).json({ installed: false, details: 'domains está vacío. Añade el dominio y guarda antes de verificar' });
  }
  if (!isDomainAllowed(record.domains, domain)) {
    return res.status(403).json({ installed: false, details: 'Domain not allowed' });
  }

  try {
    await ensureSafePublicDomain(domain);
  } catch (e) {
    return res.status(400).json({ installed: false, details: e.message || 'Domain inválido' });
  }

  const rootDomain = stripWww(domain);
  const candidates = [`https://${domain}/`, `http://${domain}/`];
  let lastError = null;

  for (const url of candidates) {
    try {
      const { final_url, html } = await fetchHtmlWithRedirects(url, rootDomain);
      const scripts = findIntakeScripts(html);

      const expectedClinicId = clinicId !== null ? clinicId : null;
      const expectedGroupId = groupId !== null ? groupId : null;
      const matched = scripts.find((s) => {
        if (expectedGroupId !== null) return parseInteger(s.data_group_id) === expectedGroupId;
        return parseInteger(s.data_clinic_id) === expectedClinicId;
      });

      if (matched) {
        return res.json({
          installed: true,
          checked_url: final_url,
          match: {
            snippet_src: matched.src,
            data_clinic_id: matched.data_clinic_id,
            data_group_id: matched.data_group_id
          },
          details: 'Snippet encontrado'
        });
      }

      if (scripts.length > 0) {
        return res.json({
          installed: false,
          checked_url: final_url,
          details: 'Se encontró intake.js pero no coincide el data-clinic-id / data-group-id',
          found: scripts.map((s) => ({
            snippet_src: s.src,
            data_clinic_id: s.data_clinic_id,
            data_group_id: s.data_group_id
          }))
        });
      }

      return res.json({
        installed: false,
        checked_url: final_url,
        details: 'No se encontró ningún <script> con intake.js en el HTML'
      });
    } catch (e) {
      lastError = e;
    }
  }

  return res.status(502).json({
    installed: false,
    details: 'No se pudo acceder al dominio para verificar',
    error: lastError?.message || 'fetch error'
  });
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

  let cfg = null;
  if (clinicIdParsed !== null) {
    cfg = await IntakeConfig.findOne({ where: { clinic_id: clinicIdParsed }, raw: true });
  } else if (groupIdParsed !== null) {
    cfg = await IntakeConfig.findOne({ where: { group_id: groupIdParsed, assignment_scope: 'group' }, raw: true });
  } else if (domain) {
    cfg = await IntakeConfig.findOne({
      where: db.Sequelize.literal(`JSON_CONTAINS(COALESCE(domains,'[]'), '\"${domain.toLowerCase()}\"')`)
    });
    if (cfg) cfg = cfg.get({ plain: true });
  }

  if (cfg && Array.isArray(cfg.domains) && cfg.domains.length > 0) {
    // Si hay allowlist configurada, el dominio es obligatorio.
    if (!domain || !isDomainAllowed(cfg.domains, domain)) {
      return res.status(403).json({ message: 'Domain not allowed' });
    }
  }

  if (cfg && cfg.hmac_key) {
    const provided = req.headers['x-cc-signature'] || req.headers['x-cc-signature-sha256'];
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
        externalId: user_data.external_id || body.event_id,
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
