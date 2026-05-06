'use strict';

const { Op, QueryTypes, Sequelize } = require('sequelize');
const db = require('../../models');
const { normalizePhoneDigits, getPhoneLookupCandidates } = require('../lib/phone');
const whatsappService = require('./whatsapp.service');
const { buildWhatsappTemplateVariableContract } = require('../lib/whatsapp-template-contract');
const { findCanonicalWhatsappConversation } = require('../lib/canonical-conversation');
const marketingOptOutService = require('./marketingOptOut.service');
const jobRequestsService = require('./jobRequests.service');

const {
  Clinica,
  ClinicMetaAsset,
  MarketingPatientContactEvent,
  MarketingPatientList,
  MarketingPatientListItem,
  Message,
  Paciente,
  PacienteConsentimiento,
  PatientCustomField,
  WhatsappTemplate,
} = db;

const OBJECTIVE_ID = 'mass_sends';
const REQUIRED_SEND_GATES = ['frozen_audience', 'opt_out', 'capping', 'approved_template', 'audit', 'cancelable_queue'];
const CHANNELS = new Set(['whatsapp', 'email', 'managed_calls']);
const STANDARD_FIELDS = new Set(['name', 'first_name', 'last_name', 'phone', 'email']);
const COMMERCIAL_TEMPLATE_USAGES = new Set(['marketing', 'comercial', 'promocion', 'promocional', 'reactivacion_pacientes']);
const DISPATCH_JOB_TYPE = 'marketing_bulk_send_dispatch';
const DISPATCH_BATCH_SIZE = Math.max(1, Number.parseInt(process.env.MARKETING_BULK_SEND_BATCH_SIZE || '100', 10) || 100);
const DISPATCH_BATCH_DELAY_MS = Math.max(60 * 1000, Number.parseInt(process.env.MARKETING_BULK_SEND_BATCH_DELAY_MS || String(2 * 60 * 1000), 10) || 2 * 60 * 1000);
const DISPATCH_MIN_READ_RATE = Number(process.env.MARKETING_BULK_SEND_MIN_READ_RATE || '0.30') || 0.30;
const DISPATCH_MAX_OPT_OUT_RATE = Number(process.env.MARKETING_BULK_SEND_MAX_OPT_OUT_RATE || '0.05') || 0.05;
const DISPATCH_TIMEZONE = process.env.MARKETING_BULK_SEND_TIMEZONE || 'Europe/Madrid';
const DISPATCH_BUSINESS_START_HOUR = 7;
const DISPATCH_BUSINESS_END_HOUR = 22;

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

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeTemplateUsage(value) {
  const usage = normalizeKey(value);
  return usage || 'promocion';
}

function isCommercialTemplateUsage(value) {
  return COMMERCIAL_TEMPLATE_USAGES.has(normalizeTemplateUsage(value));
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
  if (['first_last', 'last_comma_first', 'full', 'auto'].includes(format)) return format;
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
  const ready = items.filter((item) => item.status === 'ready').length;
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
    ready,
    selected: ready,
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
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
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

function getNextBusinessAllowedAt(reference = new Date()) {
  const parts = getMadridParts(reference);
  if (parts.hour >= DISPATCH_BUSINESS_START_HOUR && parts.hour < DISPATCH_BUSINESS_END_HOUR) {
    return reference;
  }
  if (parts.hour < DISPATCH_BUSINESS_START_HOUR) {
    return zonedDateToUtc({ ...parts, hour: DISPATCH_BUSINESS_START_HOUR, minute: 0, second: 0 });
  }
  const tomorrow = new Date(zonedDateToUtc({ ...parts, hour: 12, minute: 0, second: 0 }).getTime() + 24 * 60 * 60 * 1000);
  const nextParts = getMadridParts(tomorrow);
  return zonedDateToUtc({ ...nextParts, hour: DISPATCH_BUSINESS_START_HOUR, minute: 0, second: 0 });
}

function isWithinBusinessHours(date = new Date()) {
  const parts = getMadridParts(date);
  return parts.hour >= DISPATCH_BUSINESS_START_HOUR && parts.hour < DISPATCH_BUSINESS_END_HOUR;
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

function getDispatchConfig(list) {
  const criteria = list?.criteria || {};
  const dispatch = criteria.dispatch && typeof criteria.dispatch === 'object' ? criteria.dispatch : {};
  return {
    batch_size: Number(dispatch.batch_size || DISPATCH_BATCH_SIZE) || DISPATCH_BATCH_SIZE,
    delay_ms: Number(dispatch.delay_ms || DISPATCH_BATCH_DELAY_MS) || DISPATCH_BATCH_DELAY_MS,
    min_read_rate: Number(dispatch.min_read_rate || DISPATCH_MIN_READ_RATE) || DISPATCH_MIN_READ_RATE,
    max_opt_out_rate: Number(dispatch.max_opt_out_rate || DISPATCH_MAX_OPT_OUT_RATE) || DISPATCH_MAX_OPT_OUT_RATE,
    timezone: dispatch.timezone || DISPATCH_TIMEZONE,
    business_hours: dispatch.business_hours || {
      start: DISPATCH_BUSINESS_START_HOUR,
      end: DISPATCH_BUSINESS_END_HOUR,
      timezone: DISPATCH_TIMEZONE,
    },
    ...dispatch,
  };
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
  const customFieldsSchema = buildCustomFieldSchema(rows, columnMapping, body.custom_fields_schema || []);
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
      },
      missing_variables: [],
      notes: null,
    });
  }

  return { items, columnMapping, customFieldsSchema, nameFormat };
}

async function buildItemsFromCurrentPatients(scope, body) {
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

function serializeItem(item) {
  const plain = item?.get ? item.get({ plain: true }) : item;
  return {
    id: plain.id,
    patient_id: plain.paciente_id,
    clinic_id: plain.clinica_id,
    name: plain.name,
    phone: plain.phone,
    email: plain.email,
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
    dispatch: getDispatchConfig(plain),
    custom_fields_schema: plain.custom_fields_schema || [],
    prepared_at: plain.prepared_at,
    last_sent_at: plain.last_sent_at,
    created_at: plain.created_at,
    updated_at: plain.updated_at,
    items_preview: itemsPreview.map(serializeItem),
  };
}

async function listCampaigns(scope) {
  const lists = await MarketingPatientList.findAll({
    where: {
      objective_id: OBJECTIVE_ID,
      status: { [Op.ne]: 'archived' },
      ...scopeToWhere(scope),
    },
    order: [['updated_at', 'DESC']],
    limit: 100,
  });
  const ids = lists.map((list) => list.id);
  const [uniqueContactsRow] = ids.length
    ? await db.sequelize.query(
      `
      SELECT COUNT(DISTINCT COALESCE(
        CASE WHEN paciente_id IS NOT NULL THEN CONCAT('p:', paciente_id) END,
        CASE WHEN NULLIF(TRIM(phone), '') IS NOT NULL THEN CONCAT('ph:', TRIM(phone)) END,
        CASE WHEN NULLIF(TRIM(email), '') IS NOT NULL THEN CONCAT('em:', LOWER(TRIM(email))) END,
        CASE WHEN NULLIF(TRIM(name), '') IS NOT NULL THEN CONCAT('nm:', LOWER(TRIM(name))) END
      )) AS unique_contacts
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
  return { success: true, items, aggregate, daily_series: [] };
}

async function createCampaign(scope, body = {}, userId = null) {
  const rows = Array.isArray(body.import_rows) ? body.import_rows.filter((row) => row && typeof row === 'object') : [];
  const channels = normalizeChannels(body.channels || body.destinations || body.channel);
  const scopePayload = serializeScope(scope);
  const listSource = normalizeText(body.list_source || body.source || 'import');
  const source = listSource === 'current_patients' ? 'existing_patients_condition' : (listSource === 'manual' ? 'manual_list' : 'imported_file');
  const templateUsage = normalizeTemplateUsage(body.template_usage || body.template_uso || body.uso || 'promocion');
  const templateCommercial = body.template_commercial === true || isCommercialTemplateUsage(templateUsage);
  const listName = normalizeText(body.name) || 'Lista de envíos masivos';
  const campaignName = normalizeText(body.campaign_name || body.campaignName) || listName;

  return db.sequelize.transaction(async (transaction) => {
    let itemPayloads = [];
    let columnMapping = body.column_mapping || {};
    let customFieldsSchema = Array.isArray(body.custom_fields_schema) ? body.custom_fields_schema : [];

    if (source === 'existing_patients_condition') {
      itemPayloads = await buildItemsFromCurrentPatients(scope, body);
    } else {
      const importResult = buildItemsFromRows(rows, body, channels);
      itemPayloads = importResult.items;
      columnMapping = importResult.columnMapping;
      customFieldsSchema = importResult.customFieldsSchema;
      itemPayloads = await attachExistingPatientContext(itemPayloads, scope, transaction);
    }

    itemPayloads = await applyMarketingOptOutExclusions(itemPayloads, scope, transaction);
    const counters = computeCounters(itemPayloads);
    const list = await MarketingPatientList.create({
      name: listName,
      objective_id: OBJECTIVE_ID,
      source,
      status: 'draft',
      ...scopePayload,
      treatment: null,
      condition_summary: source === 'existing_patients_condition'
        ? 'Pacientes actuales que cumplen la condición seleccionada.'
        : 'Lista externa importada para campaña puntual.',
      exclusion_summary: counters.excluded ? `${counters.excluded} contactos no tienen los campos necesarios o están duplicados.` : 'Sin exclusiones detectadas.',
      criteria: {
        campaign_name: campaignName,
        list_name: listName,
        channels,
        template_usage: templateUsage,
        template_commercial: templateCommercial,
        opt_out_text: templateCommercial ? normalizeText(body.opt_out_text) : null,
        consent_acknowledged: !!body.consent_acknowledged,
        list_source: source,
        import_file_name: body.import_file_name || null,
        column_mapping: columnMapping,
        name_format: normalizeNameFormat(body.name_format || body.nameFormat || (source === 'imported_file' ? 'auto' : null)),
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
    return { success: true, campaign: serializeCampaign(created, { itemsPreview: preview }), list: serializeCampaign(created, { itemsPreview: preview }) };
  });
}

async function getCampaign(scope, campaignId) {
  const list = await MarketingPatientList.findByPk(campaignId);
  ensureScopeAccess(list, scope);
  const items = await MarketingPatientListItem.findAll({
    where: { list_id: list.id },
    order: [['id', 'ASC']],
    limit: 1000,
  });
  return { success: true, campaign: serializeCampaign(list, { itemsPreview: items.slice(0, 5) }), list: serializeCampaign(list, { itemsPreview: items.slice(0, 5) }), items: items.map(serializeItem) };
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
  if (body.auto_send_when_template_approved !== undefined || body.auto_send_when_approved !== undefined) {
    nextCriteria.auto_send_when_template_approved = body.auto_send_when_template_approved === true || body.auto_send_when_approved === true;
  }

  const updatePayload = { criteria: nextCriteria };
  if (listName) updatePayload.name = listName;
  if (channels) {
    updatePayload.action_mode = channels.join(',');
    updatePayload.channel = channels[0] || list.channel || 'whatsapp';
  }

  let appendedCount = 0;
  let appendedReady = 0;
  let appendedExcluded = 0;

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

      appendedCount = itemPayloads.length;
      appendedReady = itemPayloads.filter((item) => item.status === 'ready').length;
      appendedExcluded = itemPayloads.filter((item) => String(item.status || '').startsWith('excluded')).length;

      if (itemPayloads.length) {
        await MarketingPatientListItem.bulkCreate(
          itemPayloads.map((item) => ({ ...item, list_id: list.id })),
          { transaction }
        );
      }

      nextCriteria.column_mapping = importResult.columnMapping;
      nextCriteria.name_format = importResult.nameFormat;
      updatePayload.custom_fields_schema = mergeCustomFieldSchemas(list.custom_fields_schema || [], importResult.customFieldsSchema || []);
      updatePayload.condition_summary = 'Lista externa importada para campaña puntual, con contactos añadidos posteriormente.';
      updatePayload.exclusion_summary = appendedExcluded
        ? `${appendedExcluded} contacto(s) añadidos quedaron descartados por duplicado, opt-out o campos obligatorios.`
        : (list.exclusion_summary || 'Sin exclusiones detectadas.');
    }

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
  const items = await MarketingPatientListItem.findAll({
    where: { list_id: list.id },
    order: [['id', 'ASC']],
    limit: 5,
  });
  return {
    success: true,
    campaign: serializeCampaign(reloaded, { itemsPreview: items }),
    list: serializeCampaign(reloaded, { itemsPreview: items }),
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
  const body = Array.isArray(components)
    ? components.find((component) => String(component?.type || '').toUpperCase() === 'BODY')
    : null;
  return body?.text || '';
}

function buildTemplateSnapshot(template) {
  if (!template) return null;
  const plain = template.get ? template.get({ plain: true }) : template;
  return {
    id: plain.id,
    name: plain.name,
    display_name: plain.catalog?.display_name || plain.display_name || plain.name,
    status: plain.status,
    language: plain.language || 'es',
    body: extractBodyText(plain.components),
    variables: buildWhatsappTemplateVariableContract(plain),
    captured_at: new Date().toISOString(),
  };
}

function resolveVariableValue(variableName, item, list, clinic) {
  const key = normalizeKey(variableName);
  const custom = item.custom_fields || {};
  const values = {
    nombre: item.name,
    nombre_paciente: item.name,
    apellido: custom.apellido || custom.apellidos || custom.apellido_paciente || '',
    apellidos: custom.apellidos || custom.apellido || custom.apellido_paciente || '',
    apellido_paciente: custom.apellido_paciente || custom.apellido || custom.apellidos || '',
    nombre_completo: custom.nombre_completo || item.name,
    telefono: item.phone,
    email: item.email,
    clinica: clinic?.nombre_clinica || clinic?.nombre || 'tu clínica',
    nombre_clinica: clinic?.nombre_clinica || clinic?.nombre || 'tu clínica',
    telefono_clinica: clinic?.telefono || clinic?.telefono_clinica || '',
    direccion_clinica: clinic?.direccion || '',
    url_web_clinica: clinic?.url_web || '',
    url_ficha_local_clinica: clinic?.url_ficha_local || '',
    tratamiento: item.treatment || '',
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
  const paymentStatus = asset?.additionalData?.payment?.status || null;
  return {
    clinic_id: clinicId,
    phone_number_id: clinicConfig?.phoneNumberId || asset?.phoneNumberId || null,
    waba_id: clinicConfig?.wabaId || asset?.wabaId || null,
    quality_rating: asset?.quality_rating || null,
    messaging_limit: asset?.messaging_limit || null,
    messaging_limit_count: parseMessagingLimit(asset?.messaging_limit),
    can_send_api: asset?.can_send_api ?? asset?.additionalData?.coexistence?.can_send_api ?? null,
    payment_status: paymentStatus,
    payment_missing: paymentStatus === 'missing_payment_method',
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
  return {
    ...config,
    status: config.status || list?.status || 'draft',
    job_id: config.job_id || null,
    sent,
    delivered: Number(currentCounters.delivered || 0),
    read,
    replied: Number(currentCounters.replied || 0),
    failed: Number(currentCounters.failed || 0),
    opt_out: optOut,
    ready,
    total_to_send: totalToSend,
    progress_percent: totalToSend > 0 ? Math.min(100, Math.round((sent / totalToSend) * 100)) : 0,
    read_rate: readRate,
    opt_out_rate: optOutRate,
    paused_reason: config.paused_reason || null,
    cancel_requested: config.cancel_requested === true,
    next_allowed_at: config.next_allowed_at || null,
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

function buildTemplateParams({ template, item, list, clinic }) {
  const contract = getTemplateVariableContract(template);
  if (!contract.length) return [];
  return contract.map((variable) => resolveVariableValue(variable.name, item, list, clinic) || variable.example || ' ');
}

function renderTemplatePreview({ template, item, list, clinic }) {
  const plain = template?.get ? template.get({ plain: true }) : template;
  const body = extractBodyText(plain?.components);
  if (!body) return `Plantilla WhatsApp: ${plain?.name || 'sin nombre'}`;

  const contract = getTemplateVariableContract(template);
  const byIndex = new Map(
    contract.map((variable) => [
      Number(variable.index),
      resolveVariableValue(variable.name, item, list, clinic) || variable.example || '',
    ])
  );

  return body.replace(/{{\s*(\d+)\s*}}/g, (_match, rawIndex) => {
    const value = byIndex.get(Number(rawIndex));
    return value || '...';
  });
}

async function prepareCampaign(scope, campaignId, body = {}, userId = null) {
  const list = await MarketingPatientList.findByPk(campaignId);
  ensureScopeAccess(list, scope);
  const channels = Array.isArray(list.criteria?.channels)
    ? list.criteria.channels
    : normalizeChannels(list.action_mode || list.channel);
  const needsWhatsappTemplate = channels.includes('whatsapp');
  const template = body.whatsapp_template_id || body.template_id
    ? await resolveWhatsappTemplate(body.whatsapp_template_id || body.template_id, scope)
    : null;
  const snapshot = buildTemplateSnapshot(template);
  const templateUsage = normalizeTemplateUsage(body.template_usage || list.criteria?.template_usage || 'promocion');
  const templateCommercial = body.template_commercial === true
    || (body.template_commercial !== false && (list.criteria?.template_commercial === true || isCommercialTemplateUsage(templateUsage)));
  const autoSendWhenApproved = body.auto_send_when_template_approved === true || body.auto_send_when_approved === true;
  const approved = needsWhatsappTemplate
    ? !!template && String(template.status || '').toUpperCase() === 'APPROVED'
    : true;
  const items = await MarketingPatientListItem.findAll({ where: { list_id: list.id } });
  const clinicId = getClinicIdForList(list, scope);
  const clinic = clinicId && Clinica ? await Clinica.findByPk(clinicId, { raw: true }) : null;
  if (needsWhatsappTemplate && template) {
    const missingVariables = buildMissingVariablesSummary({ template, items, list, clinic });
    if (missingVariables.length) {
      const err = new Error(formatMissingVariablesMessage(missingVariables));
      err.status = 409;
      err.details = { missing_variables: missingVariables };
      throw err;
    }
  }
  const counters = computeCounters(items.map((item) => item.get({ plain: true })));
  const nextGates = {
    ...(list.safety_gates || {}),
    frozen_audience: counters.ready > 0,
    opt_out: !!(body.consent_acknowledged ?? list.criteria?.consent_acknowledged),
    approved_template: approved,
    audit: true,
    capping: true,
    cancelable_queue: true,
  };

  await list.update({
    status: 'prepared',
    // `template_id` points to legacy MessageTemplates. WABA templates live in
    // WhatsappTemplates, so keep the approved WABA reference in criteria/snapshot.
    template_id: null,
    template_snapshot: snapshot,
    counters,
    safety_gates: nextGates,
    prepared_at: new Date(),
    criteria: {
      ...(list.criteria || {}),
      campaign_name: normalizeText(body.campaign_name || list.criteria?.campaign_name || list.name),
      list_name: normalizeText(body.list_name || list.criteria?.list_name || list.name),
      whatsapp_template_id: template?.id || null,
      template_usage: templateUsage,
      template_commercial: templateCommercial,
      opt_out_text: templateCommercial ? normalizeText(body.opt_out_text || list.criteria?.opt_out_text) : null,
      schedule_mode: body.schedule_mode || 'now',
      scheduled_at: body.scheduled_at || null,
      dispatch: {
        ...getDispatchConfig(list),
        status: !approved && autoSendWhenApproved ? 'waiting_template_approval' : 'prepared',
        batch_size: DISPATCH_BATCH_SIZE,
        delay_ms: DISPATCH_BATCH_DELAY_MS,
        min_read_rate: DISPATCH_MIN_READ_RATE,
        max_opt_out_rate: DISPATCH_MAX_OPT_OUT_RATE,
        business_hours: {
          start: DISPATCH_BUSINESS_START_HOUR,
          end: DISPATCH_BUSINESS_END_HOUR,
          timezone: DISPATCH_TIMEZONE,
        },
        prepared_at: new Date().toISOString(),
        auto_send_when_template_approved: autoSendWhenApproved,
      },
      auto_send_when_template_approved: autoSendWhenApproved,
    },
  });

  await MarketingPatientContactEvent.create({
    list_id: list.id,
    event_type: 'mass_campaign_prepared',
    channel: list.channel,
    payload: {
      user_id: userId || null,
      template_id: template?.id || null,
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
  const template = await resolveWhatsappTemplate(
    body.whatsapp_template_id
      || body.template_id
      || list.criteria?.whatsapp_template_id
      || list.template_snapshot?.id
      || list.template_id,
    scope
  );
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
  const clinicId = Number(getClinicIdForList(list, scope) || body.clinic_id || 0);
  if (!clinicId) {
    const err = new Error('La campaña necesita una clínica concreta para enviar WhatsApp.');
    err.status = 400;
    throw err;
  }
  const clinic = Clinica ? await Clinica.findByPk(clinicId, { raw: true }) : null;
  const clinicConfig = await whatsappService.getClinicConfig(clinicId);
  if (!clinicConfig?.phoneNumberId || !clinicConfig?.accessToken) {
    const err = new Error('whatsapp_config_missing_for_scope');
    err.status = 409;
    throw err;
  }
  const plainItem = item.get({ plain: true });
  const missingVariables = buildMissingVariablesSummary({ template, items: [plainItem], list, clinic });
  if (missingVariables.length) {
    const err = new Error(formatMissingVariablesMessage(missingVariables));
    err.status = 409;
    err.details = { missing_variables: missingVariables };
    throw err;
  }
  const params = buildTemplateParams({ template, item: plainItem, list, clinic });
  const previewText = renderTemplatePreview({ template, item: plainItem, list, clinic });
  const templateUsage = normalizeTemplateUsage(body.template_usage || list.criteria?.template_usage || 'promocion');
  const templateCommercial = body.template_commercial === true
    || (body.template_commercial !== false && (list.criteria?.template_commercial === true || isCommercialTemplateUsage(templateUsage)));
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
      recipient: targetPhone,
      phoneNumberId: clinicConfig.phoneNumberId || null,
      wabaId: clinicConfig.wabaId || null,
    },
    sent_at: new Date(),
  });

  let response;
  try {
    response = await whatsappService.sendMessage({
      to: targetPhone,
      useTemplate: true,
      templateName: template.name,
      templateLanguage: template.language || 'es',
      templateParams: params,
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
  const page = Math.max(1, Number.parseInt(query.page || '1', 10) || 1);
  const pageSize = Math.min(100, Math.max(10, Number.parseInt(query.page_size || query.pageSize || '25', 10) || 25));
  const offset = (page - 1) * pageSize;
  const search = normalizeText(query.search || '');
  const status = normalizeText(query.status || '');
  const where = { list_id: list.id };
  if (status && status !== 'all') {
    if (status === 'excluded') {
      where.status = { [Op.like]: 'excluded%' };
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
  const counters = list.counters || await refreshListCounters(list.id);
  return {
    success: true,
    page,
    page_size: pageSize,
    total: count,
    items: rows.map(serializeItem),
    summary: counters,
  };
}

async function getDispatchStatus(scope, campaignId) {
  const list = await MarketingPatientList.findByPk(campaignId);
  ensureScopeAccess(list, scope);
  const counters = await refreshListCounters(list.id);
  const reloaded = await MarketingPatientList.findByPk(list.id);
  const accountQuality = await getWhatsappAccountQualityForList(reloaded, scope);
  return {
    success: true,
    campaign: serializeCampaign(reloaded),
    dispatch: getDispatchProgress(reloaded, counters, accountQuality),
  };
}

async function enqueueDispatchJob({ list, scope, nextRunAt = null, userId = null }) {
  const job = await jobRequestsService.enqueueJobRequest({
    type: DISPATCH_JOB_TYPE,
    payload: {
      list_id: list.id,
      scope,
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

async function startCampaignDispatch(scope, campaignId, body = {}, userId = null) {
  const list = await MarketingPatientList.findByPk(campaignId);
  ensureScopeAccess(list, scope);
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
  const blockedGates = getBlockedGates(list.safety_gates || {});
  if (blockedGates.length) {
    const err = new Error('La campaña tiene garantías pendientes antes del envío.');
    err.status = 409;
    err.details = { blocked_gates: blockedGates };
    throw err;
  }
  const template = await resolveWhatsappTemplate(list.criteria?.whatsapp_template_id || list.template_snapshot?.id, scope);
  if (!template || String(template.status || '').toUpperCase() !== 'APPROVED') {
    const err = new Error('La plantilla no está aprobada. Meta suele aprobarla en unos 15 minutos.');
    err.status = 409;
    throw err;
  }

  const counters = await refreshListCounters(list.id);
  const remaining = await MarketingPatientListItem.count({
    where: {
      list_id: list.id,
      status: 'ready',
      selected: true,
      [Op.or]: [{ dispatch_status: null }, { dispatch_status: 'pending' }],
    },
  });
  if (remaining <= 0) {
    const err = new Error('No quedan contactos pendientes de envío en esta lista.');
    err.status = 409;
    throw err;
  }

  const accountQuality = await getWhatsappAccountQualityForList(list, scope);
  const dispatch = getDispatchConfig(list);
  const scheduledAt = parseDate(body.scheduled_at || list.criteria?.scheduled_at);
  const reference = scheduledAt && scheduledAt.getTime() > Date.now() ? scheduledAt : new Date();
  const businessAllowedAt = getNextBusinessAllowedAt(reference);
  const nextRunAt = businessAllowedAt.getTime() > Date.now() + 1000 ? businessAllowedAt : null;
  const job = await enqueueDispatchJob({ list, scope, nextRunAt, userId });
  triggerDispatchJobIfReady(job, nextRunAt);
  const nextDispatch = {
    ...dispatch,
    status: nextRunAt ? 'scheduled' : 'queued',
    job_id: job.id,
    batch_size: DISPATCH_BATCH_SIZE,
    delay_ms: DISPATCH_BATCH_DELAY_MS,
    min_read_rate: DISPATCH_MIN_READ_RATE,
    max_opt_out_rate: DISPATCH_MAX_OPT_OUT_RATE,
    cancel_requested: false,
    paused_reason: null,
    started_at: dispatch.started_at || new Date().toISOString(),
    next_allowed_at: nextRunAt ? nextRunAt.toISOString() : null,
    account_quality: accountQuality,
  };
  await list.update({
    status: nextRunAt ? 'scheduled' : 'sending',
    criteria: mergeCriteria(list, { dispatch: nextDispatch }),
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
    },
    occurred_at: new Date(),
  });
  const reloaded = await MarketingPatientList.findByPk(list.id);
  return {
    success: true,
    campaign: serializeCampaign(reloaded),
    dispatch: getDispatchProgress(reloaded, counters, accountQuality),
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

async function resumeCampaignDispatch(scope, campaignId, body = {}, userId = null) {
  const list = await MarketingPatientList.findByPk(campaignId);
  ensureScopeAccess(list, scope);
  const dispatch = getDispatchConfig(list);
  if (!['paused', 'cancelled', 'scheduled', 'sending', 'prepared'].includes(String(list.status || '').toLowerCase())) {
    const err = new Error('Esta campaña no se puede retomar desde su estado actual.');
    err.status = 409;
    throw err;
  }
  const remaining = await MarketingPatientListItem.count({
    where: {
      list_id: list.id,
      status: 'ready',
      selected: true,
      [Op.or]: [{ dispatch_status: null }, { dispatch_status: 'pending' }],
    },
  });
  if (remaining <= 0) {
    const err = new Error('No quedan contactos pendientes de envío.');
    err.status = 409;
    throw err;
  }
  const nextAllowed = getNextBusinessAllowedAt(new Date());
  const nextRunAt = nextAllowed.getTime() > Date.now() + 1000 ? nextAllowed : null;
  const job = await enqueueDispatchJob({ list, scope, nextRunAt, userId });
  triggerDispatchJobIfReady(job, nextRunAt);
  const nextDispatch = {
    ...dispatch,
    status: nextRunAt ? 'scheduled' : 'queued',
    job_id: job.id,
    cancel_requested: false,
    paused_reason: null,
    resumed_at: new Date().toISOString(),
    next_allowed_at: nextRunAt ? nextRunAt.toISOString() : null,
  };
  await list.update({
    status: nextRunAt ? 'scheduled' : 'sending',
    criteria: mergeCriteria(list, { dispatch: nextDispatch }),
  });
  await MarketingPatientContactEvent.create({
    list_id: list.id,
    event_type: 'mass_campaign_dispatch_resumed',
    channel: 'whatsapp',
    payload: { user_id: userId || null, job_id: job.id, remaining },
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

async function enqueueAutoDispatchForApprovedTemplate(templateRow, logger = console) {
  const template = templateRow?.get ? templateRow.get({ plain: true }) : templateRow;
  const templateId = Number(template?.id || 0);
  if (!templateId || String(template?.status || '').toUpperCase() !== 'APPROVED') {
    return { queued: 0 };
  }

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
      criteria: mergeCriteria(list, {
        dispatch: {
          ...dispatch,
          status: 'prepared',
          auto_send_when_template_approved: true,
          template_approved_at: new Date().toISOString(),
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

  return { queued };
}

function extractProviderError(error) {
  const raw = error?.response?.data?.error || error?.response?.data || error;
  return {
    code: normalizeText(raw?.code || raw?.error_subcode || raw?.type || ''),
    message: normalizeText(raw?.message || raw?.error_data?.details || error?.message || 'whatsapp_send_failed'),
    raw,
  };
}

async function sendDispatchItem({ list, item, template, clinic, clinicConfig, batchIndex }) {
  const plainItem = item.get ? item.get({ plain: true }) : item;
  const params = buildTemplateParams({ template, item: plainItem, list, clinic });
  const previewText = renderTemplatePreview({ template, item: plainItem, list, clinic });
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
      kind: 'mass_campaign_send',
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
      recipient: item.phone,
      phoneNumberId: clinicConfig.phoneNumberId || null,
      phoneId: clinicConfig.phoneNumberId || null,
      wabaId: clinicConfig.wabaId || null,
      batch_index: batchIndex,
    },
    sent_at: new Date(),
  });

  try {
    const response = await whatsappService.sendMessage({
      to: item.phone,
      useTemplate: true,
      templateName: template.name,
      templateLanguage: template.language || 'es',
      templateParams: params,
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
      event_type: 'mass_campaign_message_sent',
      channel: 'whatsapp',
      payload: {
        provider_message_id: providerMessageId,
        app_message_id: appMessage.id,
        conversation_id: conversation.id,
        batch_index: batchIndex,
      },
      occurred_at: new Date(),
    });
    return { sent: true };
  } catch (error) {
    const providerError = extractProviderError(error);
    await appMessage.update({
      status: 'failed',
      metadata: {
        ...(appMessage.metadata || {}),
        error: providerError.raw || providerError.message,
      },
    });
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
      event_type: 'mass_campaign_message_failed',
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
  const dispatch = getDispatchConfig(list);
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
  if (!isWithinBusinessHours(new Date())) {
    const nextAllowed = getNextBusinessAllowedAt(new Date());
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

  const countersBefore = await refreshListCounters(list.id);
  const sentBefore = Number(countersBefore.sent || 0);
  const readRate = sentBefore > 0 ? Number(countersBefore.read || 0) / sentBefore : 1;
  const optOutRate = sentBefore > 0 ? Number(countersBefore.opt_out || countersBefore.exclusion_reasons?.opt_out || 0) / sentBefore : 0;
  if (sentBefore >= DISPATCH_BATCH_SIZE && optOutRate > DISPATCH_MAX_OPT_OUT_RATE) {
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
  if (sentBefore >= DISPATCH_BATCH_SIZE && readRate < DISPATCH_MIN_READ_RATE) {
    await list.update({
      status: 'paused',
      criteria: mergeCriteria(list, {
        dispatch: {
          ...dispatch,
          status: 'paused_quality',
          paused_reason: 'read_rate_low',
          paused_at: new Date().toISOString(),
          quality_snapshot: { sent: sentBefore, read_rate: readRate, opt_out_rate: optOutRate },
        },
      }),
    });
    return { status: 'completed', result: { paused: true, reason: 'read_rate_low', list_id: list.id } };
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

  const template = await resolveWhatsappTemplate(list.criteria?.whatsapp_template_id || list.template_snapshot?.id, scope);
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
  const clinic = clinicId && Clinica ? await Clinica.findByPk(clinicId, { raw: true }) : null;
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
    ? Math.max(0, Math.min(DISPATCH_BATCH_SIZE, accountQuality.messaging_limit_count - sentBefore))
    : DISPATCH_BATCH_SIZE;
  const batch = batchLimit > 0
    ? await MarketingPatientListItem.findAll({
      where: {
        list_id: list.id,
        status: 'ready',
        selected: true,
        [Op.or]: [{ dispatch_status: null }, { dispatch_status: 'pending' }],
      },
      order: [['id', 'ASC']],
      limit: batchLimit,
    })
    : [];

  if (!batch.length) {
    const finalCounters = await refreshListCounters(list.id);
    await list.update({
      status: 'completed',
      last_sent_at: new Date(),
      criteria: mergeCriteria(list, {
        dispatch: {
          ...dispatch,
          status: 'completed',
          completed_at: new Date().toISOString(),
          next_allowed_at: null,
        },
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

  const batchIndex = Number(dispatch.last_batch_index || 0) + 1;
  let sent = 0;
  let failed = 0;
  for (const item of freshBatch) {
    const currentList = await MarketingPatientList.findByPk(list.id);
    if (getDispatchConfig(currentList).cancel_requested === true) {
      break;
    }
    const missingVariables = buildMissingVariablesSummary({ template, items: [item], list, clinic });
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
    const result = await sendDispatchItem({ list, item, template, clinic, clinicConfig, batchIndex });
    if (result.sent) sent += 1;
    else failed += 1;
  }

  const countersAfter = await refreshListCounters(list.id);
  await MarketingPatientContactEvent.create({
    list_id: list.id,
    event_type: 'mass_campaign_batch_processed',
    channel: 'whatsapp',
    payload: {
      batch_index: batchIndex,
      attempted: freshBatch.length,
      sent,
      failed,
      counters: countersAfter,
    },
    occurred_at: new Date(),
  });

  const remaining = await MarketingPatientListItem.count({
    where: {
      list_id: list.id,
      status: 'ready',
      selected: true,
      [Op.or]: [{ dispatch_status: null }, { dispatch_status: 'pending' }],
    },
  });
  if (remaining <= 0) {
    await list.update({
      status: 'completed',
      last_sent_at: new Date(),
      criteria: mergeCriteria(list, {
        dispatch: {
          ...getDispatchConfig(list),
          status: 'completed',
          last_batch_index: batchIndex,
          completed_at: new Date().toISOString(),
          next_allowed_at: null,
        },
      }),
    });
    return { status: 'completed', result: { completed: true, list_id: list.id, counters: countersAfter } };
  }

  const nextAllowed = new Date(Date.now() + DISPATCH_BATCH_DELAY_MS);
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
  const triggerMessage = await Message.findOne({
    where: {
      conversation_id: conversation.id,
      direction: 'outbound',
      createdAt: { [Op.lte]: inboundMessage.createdAt || new Date() },
    },
    order: [['createdAt', 'DESC']],
    limit: 1,
  });
  const metadata = triggerMessage?.metadata || {};
  if (metadata.source !== 'marketing_bulk_sends') return { applied: false, reason: 'not_bulk_send' };
  const listId = Number(metadata.list_id || 0);
  const itemId = Number(metadata.item_id || 0);
  if (!listId || !itemId) return { applied: false, reason: 'missing_ids' };
  const item = await MarketingPatientListItem.findOne({ where: { id: itemId, list_id: listId } });
  if (!item) return { applied: false, reason: 'item_not_found' };
  const repliedAt = inboundMessage.sent_at || inboundMessage.createdAt || new Date();
  await item.update({
    dispatch_status: 'replied',
    replied_at: item.replied_at || repliedAt,
    conversation_id: conversation.id,
  });
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
  await refreshListCounters(listId);
  return { applied: true, list_id: listId, item_id: itemId };
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
  listRecipients,
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
  removeCampaign,
};
