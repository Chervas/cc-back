'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const { normalizePhoneDigits } = require('../lib/phone');
const whatsappService = require('./whatsapp.service');
const { buildWhatsappTemplateVariableContract } = require('../lib/whatsapp-template-contract');
const { findCanonicalWhatsappConversation } = require('../lib/canonical-conversation');
const marketingOptOutService = require('./marketingOptOut.service');

const {
  Clinica,
  MarketingPatientContactEvent,
  MarketingPatientList,
  MarketingPatientListItem,
  Message,
  Paciente,
  WhatsappTemplate,
} = db;

const OBJECTIVE_ID = 'mass_sends';
const REQUIRED_SEND_GATES = ['frozen_audience', 'opt_out', 'capping', 'approved_template', 'audit', 'cancelable_queue'];
const CHANNELS = new Set(['whatsapp', 'email', 'managed_calls']);
const STANDARD_FIELDS = new Set(['name', 'first_name', 'last_name', 'phone', 'email']);
const COMMERCIAL_TEMPLATE_USAGES = new Set(['marketing', 'comercial', 'promocion', 'promocional', 'reactivacion_pacientes']);

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
  return {
    total,
    ready,
    selected: ready,
    excluded,
    lead: 0,
    sent: 0,
    delivered: 0,
    read: 0,
    replied: 0,
    appointments: 0,
    treatments: 0,
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
    acc.replied += Number(counters.replied || 0);
    return acc;
  }, { total_lists: 0, total_patients: 0, ready: 0, excluded: 0, sent: 0, delivered: 0, replied: 0, appointments: 0, treatments: 0, estimated_revenue: 0 });
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
    apellido: '',
    apellido_paciente: '',
    telefono: item.phone,
    email: item.email,
    clinica: clinic?.nombre_clinica || clinic?.nombre || 'tu clínica',
    nombre_clinica: clinic?.nombre_clinica || clinic?.nombre || 'tu clínica',
    telefono_clinica: clinic?.telefono || clinic?.telefono_clinica || '',
    tratamiento: item.treatment || '',
  };
  return normalizeText(custom[key] || values[key] || '');
}

function buildTemplateParams({ template, item, list, clinic }) {
  const plain = template?.get ? template.get({ plain: true }) : template;
  const contract = buildWhatsappTemplateVariableContract(plain);
  if (!contract.length) return [];
  return contract.map((variable) => resolveVariableValue(variable.name, item, list, clinic) || variable.example || ' ');
}

function renderTemplatePreview({ template, item, list, clinic }) {
  const plain = template?.get ? template.get({ plain: true }) : template;
  const body = extractBodyText(plain?.components);
  if (!body) return `Plantilla WhatsApp: ${plain?.name || 'sin nombre'}`;

  const contract = buildWhatsappTemplateVariableContract(plain);
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
  const approved = needsWhatsappTemplate
    ? !!template && String(template.status || '').toUpperCase() === 'APPROVED'
    : true;
  const items = await MarketingPatientListItem.findAll({ where: { list_id: list.id } });
  const counters = computeCounters(items.map((item) => item.get({ plain: true })));
  const nextGates = {
    ...(list.safety_gates || {}),
    frozen_audience: counters.ready > 0,
    opt_out: !!(body.consent_acknowledged ?? list.criteria?.consent_acknowledged),
    approved_template: approved,
    audit: true,
    capping: false,
    cancelable_queue: false,
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
      whatsapp_template_id: template?.id || null,
      template_usage: templateUsage,
      template_commercial: templateCommercial,
      opt_out_text: templateCommercial ? normalizeText(body.opt_out_text || list.criteria?.opt_out_text) : null,
      schedule_mode: body.schedule_mode || 'now',
      scheduled_at: body.scheduled_at || null,
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
  return {
    success: true,
    campaign: serializeCampaign(reloaded, { itemsPreview: items.slice(0, 5) }),
    dispatch_blocked: true,
    blocked_gates: getBlockedGates(nextGates),
    message: needsWhatsappTemplate && !template
      ? 'Selecciona una plantilla WhatsApp aprobada antes de preparar esta campaña.'
      : approved
      ? 'Campaña preparada. El envío masivo queda pendiente de cola cancelable y capping.'
      : 'La plantilla todavía no está aprobada. Meta puede tardar hasta 30 minutos en aprobarla.',
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
  const clinicId = Number(list.clinica_id || (Array.isArray(list.clinic_ids) ? list.clinic_ids[0] : 0) || body.clinic_id || 0);
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

async function removeCampaign(scope, campaignId, userId = null) {
  const list = await MarketingPatientList.findByPk(campaignId);
  ensureScopeAccess(list, scope);
  const previousStatus = list.status;
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
  prepareCampaign,
  sendTest,
  removeCampaign,
};
