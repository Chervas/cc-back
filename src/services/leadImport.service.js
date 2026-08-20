'use strict';

const crypto = require('crypto');
const db = require('../../models');
const { normalizePhoneDigits, extractPhoneCandidates } = require('../lib/phone');

const { Op } = db.Sequelize;

const LeadIntake = db.LeadIntake;
const LeadAttributionAudit = db.LeadAttributionAudit;
const Clinica = db.Clinica;
const GrupoClinica = db.GrupoClinica;
const Campana = db.Campana;

const CHANNELS = new Set(['paid', 'organic', 'unknown']);
const SOURCES = new Set(['meta_ads', 'google_ads', 'web', 'whatsapp', 'call_click', 'tiktok_ads', 'seo', 'direct', 'local_services']);
const STATUSES = new Set(['nuevo', 'contactado', 'esperando_info', 'info_recibida', 'cualificado', 'citado', 'acudio_cita', 'convertido', 'descartado']);
const DEDUPE_WINDOW_HOURS = parseInt(process.env.INTAKE_DEDUPE_WINDOW_HOURS || '24', 10);
const IMPORT_MAX_ROWS = 5000;

const countMojibakeMarkers = (value) => {
  if (!value || typeof value !== 'string') return 0;
  const matches = value.match(/Ã.|Â.|â[\u0080-\u00BF]|�/g);
  return matches ? matches.length : 0;
};

const repairLikelyMojibake = (value) => {
  if (!value || typeof value !== 'string') return value;
  if (!/[ÃÂâ�]/.test(value)) return value;

  try {
    const repaired = Buffer.from(value, 'latin1').toString('utf8');
    if (!repaired) return value;
    return countMojibakeMarkers(repaired) < countMojibakeMarkers(value)
      ? repaired.normalize('NFC')
      : value;
  } catch (_error) {
    return value;
  }
};

const cleanString = (value) => {
  if (value === undefined || value === null) return null;
  const normalized = repairLikelyMojibake(String(value)).trim();
  return normalized || null;
};

const parseInteger = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const hashValue = (value) => {
  if (!value) return null;
  return crypto.createHash('sha256').update(value).digest('hex');
};

const normalizeEmail = (email) => (email || '').trim().toLowerCase() || null;

const normalizePhone = (phone) => {
  const candidates = extractPhoneCandidates(phone);
  if (!candidates.length) return null;

  const scored = candidates
    .map((candidate, index) => {
      const digits = candidate.digits;
      let score = 0;
      if (candidate.assumedLocal) score += 120;
      if (candidate.explicitInternational) score += 80;
      if (digits.startsWith('34') && digits.length === 11) score += 100;
      if (digits.length >= 9 && digits.length <= 15) score += 20;
      score -= index;
      return { digits, score };
    })
    .sort((left, right) => right.score - left.score);

  return scored[0]?.digits || normalizePhoneDigits(phone);
};

const stableStringify = (obj) => {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(stableStringify).join(',')}]`;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`).join(',')}}`;
};

const sanitizeText = (value) => {
  if (!value || typeof value !== 'string') return value;
  return value
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s.,@'+-]/gu, '')
    .trim();
};

const sanitizeLeadNoteText = (value) => {
  if (!value || typeof value !== 'string') return value;
  return value
    .normalize('NFC')
    .replace(/[^\p{L}\p{N}\s.,@'+\-:/?&=#()%_]/gu, '')
    .trim();
};

const normalizeKey = (value) => String(value || '')
  .normalize('NFC')
  .normalize('NFKD')
  .replace(/[\u0300-\u036f]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, '_')
  .replace(/^_+|_+$/g, '');

const normalizeLookupToken = (value) => normalizeKey(value).replace(/_/g, ' ').trim();

const IMPORT_NAME_PARTICLES = new Set(['de', 'del', 'la', 'las', 'los', 'da', 'das', 'do', 'dos', 'y', 'i']);
const IMPORT_COMMON_FIRST_NAMES = new Set([
  'aaron', 'abel', 'abril', 'adria', 'africa', 'agustin', 'aicha', 'aidan', 'ainoha', 'aitor',
  'albert', 'alberto', 'aleixandra', 'alejandra', 'alejandro', 'alex', 'alexander', 'alicia',
  'ana', 'andrea', 'anna', 'antonio', 'arturo', 'belen', 'betty', 'carla', 'carles', 'carlos',
  'carmen', 'cecilia', 'chus', 'cristina', 'dario', 'david', 'demetrio', 'denny', 'edouard',
  'eduardo', 'enrique', 'eva', 'francisco', 'hugo', 'ignasi', 'inmaculada', 'inma',
  'javier', 'jesus', 'joan', 'joel', 'jordi', 'jorge', 'jose', 'juan', 'laura', 'lorena',
  'lucia', 'luis', 'margarita', 'maria', 'marta', 'miguel', 'miquel', 'montse', 'nicolas',
  'pedro', 'rita', 'rocio', 'sara', 'sergio', 'silvia', 'vero', 'veronica', 'zoila',
]);

const toTitleCaseName = (value) => {
  const text = sanitizeText(cleanString(value));
  if (!text) return '';

  return text
    .toLocaleLowerCase('es-ES')
    .split(/\s+/)
    .filter(Boolean)
    .map((part, index) => {
      const normalized = normalizeKey(part);
      if (index > 0 && IMPORT_NAME_PARTICLES.has(normalized)) return part;
      return part.charAt(0).toLocaleUpperCase('es-ES') + part.slice(1);
    })
    .join(' ');
};

const normalizeImportNameFormat = (value) => {
  const format = normalizeKey(value);
  if (['first_last', 'last_comma_first', 'last_last_first', 'full', 'auto'].includes(format)) return format;
  return 'auto';
};

const isLikelyImportFirstNameToken = (value) => IMPORT_COMMON_FIRST_NAMES.has(normalizeKey(value));

const isImportNameParticle = (value) => IMPORT_NAME_PARTICLES.has(normalizeKey(value));

const looksLikeImportSurnameFirstOrder = (parts) => parts.length >= 2
  && isLikelyImportFirstNameToken(parts[parts.length - 1])
  && !isLikelyImportFirstNameToken(parts[0]);

const splitAutoImportNameParts = (parts) => {
  if (!parts.length) return { nombre: 'Lead', apellidos: '' };
  if (parts.length === 1) return { nombre: parts[0], apellidos: '' };

  if (looksLikeImportSurnameFirstOrder(parts)) {
    let firstNameStart = parts.length - 1;
    while (
      firstNameStart > 1
      && (
        isLikelyImportFirstNameToken(parts[firstNameStart - 1])
        || isImportNameParticle(parts[firstNameStart - 1])
      )
    ) {
      firstNameStart -= 1;
    }
    return {
      nombre: parts.slice(firstNameStart).join(' '),
      apellidos: parts.slice(0, firstNameStart).join(' '),
    };
  }

  let firstNameEnd = 1;
  if (parts.length >= 2 && isLikelyImportFirstNameToken(parts[1])) {
    firstNameEnd = 2;
  }
  while (firstNameEnd < parts.length - 1 && isImportNameParticle(parts[firstNameEnd])) {
    firstNameEnd += 1;
    if (firstNameEnd < parts.length && isLikelyImportFirstNameToken(parts[firstNameEnd])) {
      firstNameEnd += 1;
    }
  }

  return {
    nombre: parts.slice(0, firstNameEnd).join(' '),
    apellidos: parts.slice(firstNameEnd).join(' '),
  };
};

const splitImportedLeadName = (value, format = 'auto') => {
  const nameFormat = normalizeImportNameFormat(format);
  const normalized = toTitleCaseName(value);
  if (!normalized) return { nombre: 'Lead', apellidos: '' };

  if ((nameFormat === 'auto' || nameFormat === 'last_comma_first') && normalized.includes(',')) {
    const [lastNameRaw, ...firstNameRaw] = normalized.split(',');
    const firstName = toTitleCaseName(firstNameRaw.join(',').trim() || lastNameRaw);
    const lastName = toTitleCaseName(firstNameRaw.length ? lastNameRaw : '');
    return {
      nombre: firstName || 'Lead',
      apellidos: lastName,
    };
  }

  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length === 1 || nameFormat === 'full') {
    return { nombre: normalized, apellidos: '' };
  }
  if (nameFormat === 'auto') {
    return splitAutoImportNameParts(parts);
  }
  if (nameFormat === 'last_last_first' && parts.length >= 2) {
    return {
      nombre: parts.length >= 3 ? parts.slice(2).join(' ') : parts[1],
      apellidos: parts.length >= 3 ? parts.slice(0, 2).join(' ') : parts[0],
    };
  }

  return {
    nombre: parts.slice(0, 2).join(' '),
    apellidos: parts.slice(2).join(' '),
  };
};

const inferLeadImportNameFormat = (rows = [], mapping = {}) => {
  const nameColumn = Object.entries(mapping || {})
    .find(([, destination]) => destination === 'nombre')?.[0];
  if (!nameColumn) return 'auto';

  const samples = rows
    .slice(0, 200)
    .map((row) => cleanString(row?.[nameColumn]))
    .filter(Boolean);
  if (!samples.length) return 'auto';

  const commaRatio = samples.filter((value) => value.includes(',')).length / samples.length;
  if (commaRatio >= 0.2) return 'last_comma_first';

  const singleTokenRatio = samples.filter((value) => value.split(/\s+/).filter(Boolean).length <= 1).length / samples.length;
  if (singleTokenRatio >= 0.65) return 'full';

  const multiTokenSamples = samples
    .map((value) => toTitleCaseName(value).split(/\s+/).filter(Boolean))
    .filter((parts) => parts.length >= 2);
  if (!multiTokenSamples.length) return 'auto';

  const surnameFirstCount = multiTokenSamples.filter((parts) => looksLikeImportSurnameFirstOrder(parts)).length;
  if (surnameFirstCount / multiTokenSamples.length >= 0.55) return 'last_last_first';

  return 'auto';
};

const inferChannelFromSource = (source) => {
  if (source === 'meta_ads' || source === 'google_ads' || source === 'tiktok_ads' || source === 'local_services') return 'paid';
  if (source === 'seo') return 'organic';
  return 'unknown';
};

const composeImportedFullName = (nombre, apellidos, nameFormat = 'auto') => {
  const cleanNombre = toTitleCaseName(nombre);
  const cleanApellidos = toTitleCaseName(apellidos);
  if (cleanNombre && cleanApellidos) {
    return [cleanNombre, cleanApellidos].join(' ').trim();
  }
  if (cleanNombre) {
    const split = splitImportedLeadName(cleanNombre, nameFormat);
    return [split.nombre, split.apellidos].filter(Boolean).join(' ').trim() || cleanNombre;
  }
  return cleanApellidos || null;
};

const buildUtcDate = ({ year, month, day, hours = 0, minutes = 0, seconds = 0 }) => {
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const parsed = new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
  if (Number.isNaN(parsed.getTime())) return null;
  if (
    parsed.getUTCFullYear() !== year
    || (parsed.getUTCMonth() + 1) !== month
    || parsed.getUTCDate() !== day
  ) {
    return null;
  }
  return parsed;
};

const parseExcelSerialDate = (value) => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;

  const excelEpoch = Date.UTC(1899, 11, 30);
  const milliseconds = Math.round(numeric * 24 * 60 * 60 * 1000);
  const parsed = new Date(excelEpoch + milliseconds);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const inferDateOrder = (values = []) => {
  let dmyScore = 0;
  let mdyScore = 0;

  values.forEach((value) => {
    const raw = cleanString(value);
    if (!raw) return;

    const match = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?$/);
    if (!match) return;

    const first = Number(match[1]);
    const second = Number(match[2]);
    if (first > 12 && second <= 12) dmyScore += 1;
    if (second > 12 && first <= 12) mdyScore += 1;
  });

  return mdyScore > dmyScore ? 'MDY' : 'DMY';
};

const parseFlexibleDate = (value, options = {}) => {
  const preferredOrder = options.preferredOrder === 'MDY' ? 'MDY' : 'DMY';
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;

  if (typeof value === 'number') {
    const excelDate = parseExcelSerialDate(value);
    if (excelDate) return excelDate;
  }

  const raw = cleanString(value);
  if (!raw) return null;

  if (/^\d{4}-\d{1,2}-\d{1,2}(?:[T\s]\d{1,2}:\d{1,2}(?::\d{1,2})?)?/.test(raw)) {
    const directIso = new Date(raw);
    return Number.isNaN(directIso.getTime()) ? null : directIso;
  }

  if (/^\d{5,6}(?:\.\d+)?$/.test(raw)) {
    const excelDate = parseExcelSerialDate(raw);
    if (excelDate) return excelDate;
  }

  const match = raw.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})(?:\s+(\d{1,2})(?::(\d{1,2}))?(?::(\d{1,2}))?)?$/);
  if (match) {
    const first = Number(match[1]);
    const second = Number(match[2]);
    let year = Number(match[3]);
    const hours = Number(match[4] || 0);
    const minutes = Number(match[5] || 0);
    const seconds = Number(match[6] || 0);

    if (year < 100) year += 2000;

    let day;
    let month;
    if (first > 12 && second <= 12) {
      day = first;
      month = second;
    } else if (second > 12 && first <= 12) {
      month = first;
      day = second;
    } else if (preferredOrder === 'MDY') {
      month = first;
      day = second;
    } else {
      day = first;
      month = second;
    }

    return buildUtcDate({ year, month, day, hours, minutes, seconds });
  }

  const direct = new Date(raw);
  return Number.isNaN(direct.getTime()) ? null : direct;
};

const parseFlexibleTime = (value) => {
  const raw = cleanString(value);
  if (!raw) return null;

  const match = raw.match(/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const seconds = Number(match[3] || 0);

  if (hours > 23 || minutes > 59 || seconds > 59) return null;

  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
};

const formatDateEs = (value) => {
  const date = value instanceof Date ? value : parseFlexibleDate(value);
  if (!date) return null;
  return date.toLocaleDateString('es-ES', { timeZone: 'UTC' });
};

const normalizeImportedStatus = (value, fallback = 'nuevo') => {
  const raw = cleanString(value);
  if (!raw) return fallback;

  const normalized = normalizeKey(raw);
  if (STATUSES.has(normalized)) return normalized;
  if (normalized === 'si' || normalized === 'cita' || normalized === 'con_cita') return 'citado';
  if (normalized === 'sin_respuesta') return 'nuevo';
  if (normalized === 'otros' || normalized === 'volver_a_llamar') return 'contactado';
  if (normalized === 'no_interesado' || normalized === 'duplicado' || normalized === 'duplicada') return 'descartado';

  return fallback;
};

const inferImportedSource = (value, fallbackSource, explicitDetail, fallbackDetail) => {
  const raw = cleanString(value);
  if (!raw) {
    const source = SOURCES.has(fallbackSource) ? fallbackSource : 'web';
    return {
      source,
      source_detail: cleanString(explicitDetail) || cleanString(fallbackDetail) || null,
      channel: inferChannelFromSource(source),
    };
  }

  const lower = raw.toLowerCase();
  let source = SOURCES.has(fallbackSource) ? fallbackSource : 'web';

  if (lower.includes('whatsapp')) {
    source = 'whatsapp';
  } else if (lower.includes('llamada') || lower.includes('call')) {
    source = 'call_click';
  } else if (lower.includes('gclid') || lower.includes('gad_source') || lower.includes('google')) {
    source = 'google_ads';
  } else if (
    lower.includes('fbclid')
    || lower.includes('utm_source=ig')
    || lower.includes('instagram')
    || lower.includes('facebook')
    || lower.includes('meta')
  ) {
    source = 'meta_ads';
  } else if (lower.includes('ttclid') || lower.includes('tiktok')) {
    source = 'tiktok_ads';
  } else if (lower.includes('seo')) {
    source = 'seo';
  } else if (lower.includes('email') || lower.startsWith('http') || lower.includes('www.')) {
    source = 'web';
  }

  return {
    source,
    source_detail: cleanString(explicitDetail) || raw,
    channel: inferChannelFromSource(source),
  };
};

const appendNoteLine = (lines, label, value) => {
  const clean = sanitizeLeadNoteText(cleanString(value));
  if (!clean) return;
  lines.push(`${label}: ${clean}`);
};

const buildAppointmentPayload = (fields) => {
  const appointmentDate = parseFlexibleDate(fields.appointment_date);
  const appointmentTime = parseFlexibleTime(fields.appointment_time);
  const clinicName = cleanString(fields.appointment_clinic);
  const responsible = cleanString(fields.appointment_responsible);
  const address = cleanString(fields.appointment_address);

  if (!appointmentDate && !appointmentTime && !clinicName && !responsible && !address) {
    return null;
  }

  return {
    imported: true,
    fecha: appointmentDate ? formatDateEs(appointmentDate) : cleanString(fields.appointment_date),
    hora: appointmentTime || cleanString(fields.appointment_time),
    clinica: clinicName,
    responsable: responsible,
    direccion: address,
  };
};

const loadCampaignIndex = async (config) => {
  if (!Campana || !config?.clinic_id) {
    return { all: [], byCampaignId: new Map(), byName: new Map() };
  }

  const rows = await Campana.findAll({
    where: { clinica_id: config.clinic_id },
    attributes: ['id', 'nombre', 'campaign_id'],
    raw: true,
  });

  const byCampaignId = new Map();
  const byName = new Map();

  rows.forEach((row) => {
    const rawCampaignId = cleanString(row?.campaign_id);
    const normalizedCampaignId = normalizeLookupToken(rawCampaignId);
    const normalizedName = normalizeLookupToken(row?.nombre);

    if (rawCampaignId && !byCampaignId.has(rawCampaignId)) byCampaignId.set(rawCampaignId, row);
    if (normalizedCampaignId && !byCampaignId.has(normalizedCampaignId)) byCampaignId.set(normalizedCampaignId, row);
    if (normalizedName && !byName.has(normalizedName)) byName.set(normalizedName, row);
  });

  return { all: rows, byCampaignId, byName };
};

const resolveImportedCampaign = (reference, campaignIndex) => {
  const rawReference = cleanString(reference);
  if (!rawReference || !campaignIndex) {
    return { campaign: null, matched: false };
  }

  const exactCampaign = campaignIndex.byCampaignId.get(rawReference)
    || campaignIndex.byCampaignId.get(normalizeLookupToken(rawReference))
    || campaignIndex.byName.get(normalizeLookupToken(rawReference))
    || null;

  if (exactCampaign) {
    return { campaign: exactCampaign, matched: true };
  }

  const normalizedRef = normalizeLookupToken(rawReference);
  if (!normalizedRef) {
    return { campaign: null, matched: false };
  }

  const fuzzyMatches = (campaignIndex.all || []).filter((row) => {
    const normalizedName = normalizeLookupToken(row?.nombre);
    return normalizedName && (normalizedName.includes(normalizedRef) || normalizedRef.includes(normalizedName));
  });

  if (fuzzyMatches.length === 1) {
    return { campaign: fuzzyMatches[0], matched: true };
  }

  return { campaign: null, matched: false };
};

const normalizeRowPayload = (row, mapping, config, campaignIndex, options = {}) => {
  const noteColumnCount = Object.entries(mapping || {})
    .filter(([, destination]) => destination === 'notas')
    .length;
  const mapped = {
    nombre: null,
    apellidos: null,
    email: null,
    telefono: null,
    notas: [],
    created_at: null,
  };

  for (const [column, destination] of Object.entries(mapping || {})) {
    if (!destination || destination === 'ignore') continue;
    const value = row?.[column];
    if (destination === 'notas') {
      const cleanValue = sanitizeLeadNoteText(cleanString(value));
      if (cleanValue) mapped.notas.push(noteColumnCount > 1 ? `${column}: ${cleanValue}` : cleanValue);
      continue;
    }
    if (mapped[destination] === null || mapped[destination] === undefined || mapped[destination] === '') {
      mapped[destination] = value;
    }
  }

  const sourceMeta = {
    source: config.source,
    source_detail: cleanString(config.source_detail),
    channel: inferChannelFromSource(config.source),
  };
  const createdAt = parseFlexibleDate(mapped.created_at, { preferredOrder: options.createdAtOrder });
  const selectedCampaign = config.campana_id
    ? {
      id: config.campana_id,
      nombre: config.campana_nombre || null,
    }
    : null;
  const externalCampaign = config.external_campaign?.campaign_id
    ? {
      id: null,
      nombre: config.external_campaign.name || config.external_campaign.campaign_id,
      external_campaign_id: config.external_campaign.campaign_id,
    }
    : null;
  const resolvedCampaign = selectedCampaign || externalCampaign || null;
  const effectiveSourceDetail = selectedCampaign?.nombre
    || externalCampaign?.external_campaign_id
    || sourceMeta.source_detail
    || null;

  const noteLines = [];
  if (sourceMeta.source_detail === 'reactivacion_pacientes') {
    noteLines.push('Origen: reactivación de pacientes.');
  }
  const baseNotes = Array.isArray(mapped.notas) ? mapped.notas.filter(Boolean) : [];
  const mergedNotes = [...baseNotes, ...noteLines].filter(Boolean).join('\n');
  const normalizedStatus = 'nuevo';
  const normalizedName = composeImportedFullName(mapped.nombre, mapped.apellidos, options.nameFormat);
  const normalizedEmail = normalizeEmail(mapped.email);
  const normalizedPhone = normalizePhone(mapped.telefono);

  return {
    raw: row,
    mapped,
    leadPayload: {
      clinica_id: config.clinic_id,
      grupo_clinica_id: config.group_id,
      campana_id: resolvedCampaign?.id || null,
      channel: CHANNELS.has(sourceMeta.channel) ? sourceMeta.channel : inferChannelFromSource(sourceMeta.source),
      source: sourceMeta.source,
      source_detail: effectiveSourceDetail,
      clinic_match_source: 'manual_import',
      clinic_match_value: String(config.clinic_id),
      nombre: normalizedName || null,
      email: normalizedEmail || null,
      telefono: normalizedPhone || null,
      notas: mergedNotes || null,
      status_lead: normalizedStatus,
      cita_propuesta: null,
      external_source: 'csv_import',
      external_id: null,
      intake_payload_hash: hashValue(stableStringify({ row, config, mapping })),
    },
    created_at: createdAt,
    display: {
      nombre: normalizedName || 'Sin nombre',
      email: normalizedEmail || '—',
      telefono: normalizedPhone || '—',
      status_lead: normalizedStatus,
      source: sourceMeta.source,
      source_detail: effectiveSourceDetail || '—',
      campaign_name: resolvedCampaign?.nombre || null,
      campaign_reference: externalCampaign?.external_campaign_id || null,
      created_at: createdAt ? createdAt.toISOString() : null,
      cita: null,
    },
    dedupeKeys: {
      name: normalizedName ? normalizeKey(normalizedName) : null,
      email_hash: normalizedEmail ? hashValue(normalizedEmail) : null,
      phone_hash: normalizedPhone ? hashValue(normalizedPhone) : null,
      external_key: null,
    },
  };
};

const buildScopeWhere = (config) => {
  if (config.clinic_id) return { clinica_id: config.clinic_id };
  if (config.group_id) return { grupo_clinica_id: config.group_id };
  return {};
};

const loadExistingIndexes = async (scopeConfig, normalizedRows) => {
  const scopeWhere = buildScopeWhere(scopeConfig);
  const nameSet = new Set();
  const emailHashSet = new Set();
  const phoneHashSet = new Set();
  const externalIdSet = new Set();

  for (const item of normalizedRows) {
    if (item?.dedupeKeys?.name) nameSet.add(item.dedupeKeys.name);
    if (item?.dedupeKeys?.email_hash) emailHashSet.add(item.dedupeKeys.email_hash);
    if (item?.dedupeKeys?.phone_hash) phoneHashSet.add(item.dedupeKeys.phone_hash);
    if (item?.leadPayload?.external_id) externalIdSet.add(item.leadPayload.external_id);
  }

  const scopeOr = [];
  if (emailHashSet.size) scopeOr.push({ email_hash: { [Op.in]: Array.from(emailHashSet) } });
  if (phoneHashSet.size) scopeOr.push({ phone_hash: { [Op.in]: Array.from(phoneHashSet) } });
  if (nameSet.size) {
    scopeOr.push(
      db.Sequelize.where(
        db.Sequelize.fn('LOWER', db.Sequelize.col('nombre')),
        { [Op.in]: Array.from(nameSet).map((value) => value.replace(/_/g, ' ')) }
      )
    );
  }
  if (externalIdSet.size) {
    scopeOr.push({ external_source: 'csv_import', external_id: { [Op.in]: Array.from(externalIdSet) } });
  }

  const existingScoped = scopeOr.length
    ? await LeadIntake.findAll({
      where: { ...scopeWhere, [Op.or]: scopeOr },
      attributes: ['id', 'nombre', 'email_hash', 'phone_hash', 'external_source', 'external_id', 'created_at'],
      raw: true,
    })
    : [];

  const recentCutoff = new Date(Date.now() - (DEDUPE_WINDOW_HOURS * 60 * 60 * 1000));
  const recentOr = [];
  if (emailHashSet.size) recentOr.push({ email_hash: { [Op.in]: Array.from(emailHashSet) } });
  if (phoneHashSet.size) recentOr.push({ phone_hash: { [Op.in]: Array.from(phoneHashSet) } });

  const existingRecent = recentOr.length
    ? await LeadIntake.findAll({
      where: {
        created_at: { [Op.gte]: recentCutoff },
        [Op.or]: recentOr,
      },
      attributes: ['id', 'nombre', 'email_hash', 'phone_hash', 'created_at'],
      raw: true,
    })
    : [];

  const byScopeName = new Map();
  const byScopeEmailHash = new Map();
  const byScopePhoneHash = new Map();
  const byExternal = new Map();

  for (const row of existingScoped) {
    const normalizedName = cleanString(row.nombre) ? normalizeKey(row.nombre) : null;
    if (normalizedName && !byScopeName.has(normalizedName)) byScopeName.set(normalizedName, row);
    if (row.email_hash && !byScopeEmailHash.has(row.email_hash)) byScopeEmailHash.set(row.email_hash, row);
    if (row.phone_hash && !byScopePhoneHash.has(row.phone_hash)) byScopePhoneHash.set(row.phone_hash, row);
    if (row.external_source && row.external_id) byExternal.set(`${row.external_source}:${row.external_id}`, row);
  }

  const byRecentEmailHash = new Map();
  const byRecentPhoneHash = new Map();

  for (const row of existingRecent) {
    if (row.email_hash && !byRecentEmailHash.has(row.email_hash)) byRecentEmailHash.set(row.email_hash, row);
    if (row.phone_hash && !byRecentPhoneHash.has(row.phone_hash)) byRecentPhoneHash.set(row.phone_hash, row);
  }

  return {
    byScopeName,
    byScopeEmailHash,
    byScopePhoneHash,
    byExternal,
    byRecentEmailHash,
    byRecentPhoneHash,
  };
};

const ruleMatches = (row, rule) => {
  const column = cleanString(rule?.column);
  const operator = cleanString(rule?.operator);
  if (!column || !operator) return false;

  const rawValue = cleanString(row?.[column]);
  const compareValue = cleanString(rule?.value);

  switch (operator) {
    case 'contains':
      return !!rawValue && !!compareValue && rawValue.toLowerCase().includes(compareValue.toLowerCase());
    case 'is_empty':
      return !rawValue;
    case 'equals':
      return String(rawValue || '').toLowerCase() === String(compareValue || '').toLowerCase();
    case 'greater_than': {
      const left = Number(rawValue);
      const right = Number(compareValue);
      return Number.isFinite(left) && Number.isFinite(right) && left > right;
    }
    case 'less_than': {
      const left = Number(rawValue);
      const right = Number(compareValue);
      return Number.isFinite(left) && Number.isFinite(right) && left < right;
    }
    default:
      return false;
  }
};

const dedupeAndCreateImportedLead = async (leadPayload, rawPayload = {}, attributionSteps = {}, options = {}) => {
  const normalizedEmail = normalizeEmail(leadPayload.email);
  const normalizedPhone = normalizePhone(leadPayload.telefono);
  const dedupeCutoff = new Date(Date.now() - (DEDUPE_WINDOW_HOURS * 60 * 60 * 1000));

  const importedCreatedAt = options.created_at || null;

  const payload = {
    ...leadPayload,
    email: normalizedEmail,
    email_hash: normalizedEmail ? hashValue(normalizedEmail) : null,
    telefono: normalizedPhone || leadPayload.telefono || null,
    phone_hash: normalizedPhone ? hashValue(normalizedPhone) : null,
    ...(importedCreatedAt ? {
      created_at: importedCreatedAt,
      updated_at: importedCreatedAt,
    } : {}),
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

  if (normalizedPhone || normalizedEmail) {
    const dedupeWhere = {
      created_at: { [Op.gte]: dedupeCutoff },
      [Op.or]: [],
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

  const lead = await LeadIntake.create(payload, {
    silent: !!importedCreatedAt,
    hooks: !importedCreatedAt,
  });

  try {
    await LeadAttributionAudit.create({
      lead_intake_id: lead.id,
      raw_payload: rawPayload || {},
      attribution_steps: attributionSteps || {},
    });
  } catch (auditErr) {
    console.warn('⚠️ No se pudo registrar la auditoría de LeadIntake importado:', auditErr.message || auditErr);
  }

  return lead;
};

const validateImportConfig = async (input = {}) => {
  const clinicId = parseInteger(input.clinic_id);
  if (!clinicId) {
    const err = new Error('Debes seleccionar una clínica de destino');
    err.status = 400;
    throw err;
  }

  const clinic = await Clinica.findOne({ where: { id_clinica: clinicId }, raw: true });
  if (!clinic) {
    const err = new Error('La clínica seleccionada no existe');
    err.status = 400;
    throw err;
  }

  const groupId = parseInteger(input.group_id ?? clinic.grupoClinicaId ?? clinic.grupo_clinica_id) || null;
  let group = null;

  if (groupId) {
    group = await GrupoClinica.findOne({ where: { id_grupo: groupId }, raw: true });
  }

  const source = SOURCES.has(input.source) ? input.source : 'web';
  const selectedCampaignId = parseInteger(input.campana_id);
  let selectedCampaign = null;

  if (selectedCampaignId && Campana) {
    selectedCampaign = await Campana.findOne({
      where: {
        id: selectedCampaignId,
        clinica_id: clinicId,
      },
      attributes: ['id', 'nombre'],
      raw: true,
    });

    if (!selectedCampaign) {
      const err = new Error('La campaña seleccionada no existe en la clínica elegida.');
      err.status = 400;
      throw err;
    }
  }

  if ((source === 'google_ads' || source === 'meta_ads') && !selectedCampaign) {
    const externalCampaignId = cleanString(input.external_campaign_id);
    const externalCampaignProvider = cleanString(input.external_campaign_provider) || source;
    if (
      externalCampaignId
      && (externalCampaignProvider === 'google_ads' || externalCampaignProvider === 'meta_ads')
      && externalCampaignProvider === source
    ) {
      return {
        clinic_id: clinicId,
        clinic_name: clinic.nombre_clinica || `Clínica ${clinicId}`,
        group_id: groupId,
        group_name: group?.nombre_grupo_clinicas || null,
        source,
        source_detail: externalCampaignId,
        campana_id: null,
        campana_nombre: null,
        external_campaign: {
          provider: externalCampaignProvider,
          account_id: cleanString(input.external_account_id),
          campaign_id: externalCampaignId,
          name: cleanString(input.external_campaign_name) || externalCampaignId,
        },
      };
    }

    const err = new Error('Debes elegir una campaña concreta para importaciones de Google Ads o Meta Ads.');
    err.status = 400;
    throw err;
  }

  return {
    clinic_id: clinicId,
    clinic_name: clinic.nombre_clinica || `Clínica ${clinicId}`,
    group_id: groupId,
    group_name: group?.nombre_grupo_clinicas || null,
    source,
    source_detail: cleanString(input.source_detail),
    campana_id: selectedCampaign?.id || null,
    campana_nombre: selectedCampaign?.nombre || null,
    external_campaign: null,
  };
};

const analyzeImportRows = async (input = {}) => {
  const config = await validateImportConfig(input.config || input);
  const mapping = input.mapping || {};
  const rows = Array.isArray(input.rows) ? input.rows.slice(0, IMPORT_MAX_ROWS) : [];
  const exclusions = {
    skip_existing_contacts: input.exclusions?.skip_existing_contacts !== false,
    rules: Array.isArray(input.exclusions?.rules) ? input.exclusions.rules : [],
  };

  const createdAtColumns = Object.entries(mapping || {})
    .filter(([, destination]) => destination === 'created_at')
    .map(([column]) => column);
  const createdAtValues = createdAtColumns.flatMap((column) => rows.map((row) => row?.[column]));
  const createdAtOrder = inferDateOrder(createdAtValues);
  const requestedNameFormat = normalizeImportNameFormat(input.name_format);
  const nameFormat = requestedNameFormat === 'auto'
    ? inferLeadImportNameFormat(rows, mapping)
    : requestedNameFormat;

  const normalizedRows = rows.map((row) => normalizeRowPayload(row, mapping, config, null, { createdAtOrder, nameFormat }));
  const existingIndexes = await loadExistingIndexes(config, normalizedRows);

  const seenKeys = new Set();
  const previewRows = [];
  let skipped = 0;
  let importable = 0;

  normalizedRows.forEach((item, index) => {
    const reasons = [];
    let state = 'ready';

    if (!item.leadPayload.nombre && !item.leadPayload.email && !item.leadPayload.telefono) {
      reasons.push('La fila no tiene nombre, email ni teléfono.');
      state = 'invalid';
    }

    for (const rule of exclusions.rules) {
      if (ruleMatches(item.raw, rule)) {
        reasons.push(`Excluido por regla sobre la columna "${rule.column}".`);
        state = 'excluded';
        break;
      }
    }

    if (exclusions.skip_existing_contacts) {
      const seenKey = item.dedupeKeys.external_key || item.dedupeKeys.phone_hash || item.dedupeKeys.email_hash || item.dedupeKeys.name;
      if (seenKey && seenKeys.has(seenKey)) {
        reasons.push('Duplicado dentro del archivo importado.');
        state = 'excluded';
      }
      if (seenKey) seenKeys.add(seenKey);

      const scopedName = item.dedupeKeys.name ? existingIndexes.byScopeName.get(item.dedupeKeys.name) : null;
      const scopedEmail = item.dedupeKeys.email_hash ? existingIndexes.byScopeEmailHash.get(item.dedupeKeys.email_hash) : null;
      const scopedPhone = item.dedupeKeys.phone_hash ? existingIndexes.byScopePhoneHash.get(item.dedupeKeys.phone_hash) : null;
      const scopedMatch = scopedPhone || scopedEmail || scopedName;
      if (scopedMatch) {
        reasons.push(`Ya existe un lead similar en la clínica (ID ${scopedMatch.id}).`);
        state = 'excluded';
      }
    }

    const externalMatch = item.dedupeKeys.external_key ? existingIndexes.byExternal.get(item.dedupeKeys.external_key) : null;
    if (externalMatch) {
      reasons.push(`Ya existe un lead con el mismo identificador externo (ID ${externalMatch.id}).`);
      state = 'excluded';
    }

    const recentMatch = item.dedupeKeys.phone_hash
      ? existingIndexes.byRecentPhoneHash.get(item.dedupeKeys.phone_hash)
      : item.dedupeKeys.email_hash
        ? existingIndexes.byRecentEmailHash.get(item.dedupeKeys.email_hash)
        : null;
    if (recentMatch) {
      reasons.push(`Ya existe un lead reciente con el mismo contacto (ID ${recentMatch.id}).`);
      state = 'excluded';
    }

    if (state === 'ready') importable += 1;
    else skipped += 1;

    previewRows.push({
      row_index: index,
      state,
      importable: state === 'ready',
      reasons,
      display: item.display,
      raw: item.raw,
    });
  });

  return {
    config,
    rows: previewRows,
    normalizedRows,
    summary: {
      total_rows: rows.length,
      parsed_rows: normalizedRows.length,
      importable_rows: importable,
      skipped_rows: skipped,
    },
  };
};

async function previewLeadImport(input = {}) {
  const result = await analyzeImportRows(input);
  return {
    summary: result.summary,
    config: result.config,
    rows: result.rows,
  };
}

async function executeLeadImport(input = {}) {
  const result = await analyzeImportRows(input);
  const importedRows = [];
  const skippedRows = [];

  for (let index = 0; index < result.normalizedRows.length; index += 1) {
    const normalized = result.normalizedRows[index];
    const preview = result.rows[index];
    if (!preview?.importable) {
      skippedRows.push({
        row_index: index,
        reasons: preview?.reasons || ['Fila excluida en la validación.'],
      });
      continue;
    }

    try {
      const lead = await dedupeAndCreateImportedLead(
        normalized.leadPayload,
        {
          import: {
            raw_row: normalized.raw,
            mapping: input.mapping || {},
            config: result.config,
          },
        },
        {
          import_mode: 'manual_csv',
          clinic_match_source: 'manual_import',
          clinic_match_value: String(result.config.clinic_id),
        },
        { created_at: normalized.created_at }
      );

      importedRows.push({
        row_index: index,
        lead_id: lead.id,
        nombre: lead.nombre || null,
      });
    } catch (error) {
      skippedRows.push({
        row_index: index,
        reasons: [error?.message || 'No se pudo importar la fila.'],
        existing_id: error?.existingId || null,
      });
    }
  }

  return {
    summary: {
      total_rows: result.summary.total_rows,
      parsed_rows: result.summary.parsed_rows,
      imported_rows: importedRows.length,
      skipped_rows: skippedRows.length,
    },
    config: result.config,
    imported_rows: importedRows,
    skipped_rows: skippedRows,
  };
}

module.exports = {
  previewLeadImport,
  executeLeadImport,
};
