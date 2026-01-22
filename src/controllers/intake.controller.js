const crypto = require('crypto');
const axios = require('axios');
const asyncHandler = require('express-async-handler');
const db = require('../../models');
const { Op } = db.Sequelize;

const LeadIntake = db.LeadIntake;
const LeadAttributionAudit = db.LeadAttributionAudit;
const Clinica = db.Clinica;
const GrupoClinica = db.GrupoClinica;
const Campana = db.Campana;
const AdCache = db.AdCache;

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

  const clinicaIdParsed = parseInteger(clinica_id);
  const grupoClinicaIdParsed = parseInteger(grupo_clinica_id);
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

  const leadNombre = coalesce(leadData.nombre, nombre);
  const leadEmail = coalesce(leadData.email, email);
  const leadTelefono = coalesce(leadData.telefono, telefono);
  const leadNotas = coalesce(leadData.notas, notas);
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

  const leadPayload = {
    event_id: eventId,
    clinica_id: clinicaIdParsed,
    grupo_clinica_id: grupoClinicaIdParsed,
    campana_id: campanaIdParsed,
    channel: normalizedChannel,
    source: normalizedSource,
    source_detail: source_detail || null,
    clinic_match_source: clinic_match_source || null,
    clinic_match_value: clinic_match_value || null,
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

  res.status(201).json({ id: lead.id });
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

  const allowedOrderFields = new Set(['created_at', 'channel', 'source', 'status_lead', 'campana_id']);
  const orderField = allowedOrderFields.has(sortBy) ? sortBy : 'created_at';
  const orderDirection = (sortOrder || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const leads = await LeadIntake.findAndCountAll({
    where,
    include: [
      { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica'] },
      { model: GrupoClinica, as: 'grupoClinica', attributes: ['id_grupo', 'nombre_grupo'] }
    ].filter(Boolean),
    order: [[orderField, orderDirection]],
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
  const citados = await LeadIntake.count({ where: { ...where, status_lead: 'citado' } });
  const convertidos = await LeadIntake.count({ where: { ...where, status_lead: 'convertido' } });
  const descartados = await LeadIntake.count({ where: { ...where, status_lead: 'descartado' } });

  const tasa_conversion = total > 0 ? (convertidos / total) * 100 : 0;

  res.status(200).json({
    total,
    nuevos,
    contactados,
    citados,
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
