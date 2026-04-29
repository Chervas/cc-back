'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const { normalizePhoneDigits } = require('../lib/phone');

const {
  AdminCampaignPlaybook,
  AutomationFlowCatalog,
  AutomationFlowTemplateV2,
  CitaPaciente,
  MarketingPatientContactEvent,
  MarketingPatientList,
  MarketingPatientListItem,
  MessageTemplate,
  PacienteConsentimiento,
  Paciente,
  Tratamiento,
} = db;

const CANCELLED_STATES = new Set(['cancelada', 'no_asistio']);
const REQUIRED_SEND_GATES = ['frozen_audience', 'opt_out', 'capping', 'approved_template', 'audit', 'cancelable_queue'];
const REACTIVATION_ACTION_TO_MODE = {
  whatsapp_auto: 'whatsapp_template',
  send_to_leads: 'lead_call_list',
  managed_calls: 'managed_calls',
};
const STANDARD_IMPORT_FIELDS = new Set(['name', 'first_name', 'last_name', 'phone', 'email', 'treatment', 'last_visit_at', 'clinic']);

function toDateMonthsAgo(months) {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date;
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toTitleCaseName(value) {
  const particles = new Set(['de', 'del', 'la', 'las', 'los', 'y', 'e', 'da', 'das', 'do', 'dos']);
  return normalizeText(value)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((part, index) => {
      if (index > 0 && particles.has(part)) return part;
      return part.charAt(0).toUpperCase() + part.slice(1);
    })
    .join(' ');
}

function splitFullName(value) {
  const normalized = toTitleCaseName(value);
  if (!normalized) {
    return { nombre: 'Paciente', apellidos: '' };
  }
  const parts = normalized.split(/\s+/);
  if (parts.length === 1) {
    return { nombre: parts[0], apellidos: '' };
  }
  return {
    nombre: parts.slice(0, 2).join(' '),
    apellidos: parts.slice(2).join(' '),
  };
}

function titleCaseIfNeeded(value) {
  const text = normalizeText(value);
  if (!text) return text;
  return /^[^a-záéíóúñü]+$/.test(text) ? toTitleCaseName(text) : text;
}

function mapDialogUnitToBackend(unit) {
  if (unit === 'dias') return 'days';
  if (unit === 'anos') return 'years';
  return 'months';
}

function toThresholdCutoff(value, unit, fallbackMonths) {
  const amount = Math.max(Number(value || 0), 1);
  const date = new Date();
  if (unit === 'days') {
    date.setDate(date.getDate() - amount);
    return {
      cutoff: date,
      label: `${amount} días`,
      monthsForPriority: Math.max(1, Math.round(amount / 30)),
      criteria: { value: amount, unit: 'days' },
    };
  }
  const months = amount || fallbackMonths;
  date.setMonth(date.getMonth() - months);
  return {
    cutoff: date,
    label: `${months} meses`,
    monthsForPriority: months,
    criteria: { value: months, unit: 'months' },
  };
}

function getThresholdMonths(treatmentName) {
  const normalized = normalizeText(treatmentName).toLowerCase();
  if (normalized.includes('ortodon')) return 6;
  if (normalized.includes('higiene') || normalized.includes('periodon')) return 9;
  if (normalized.includes('capilar')) return 12;
  if (normalized.includes('implante')) return 6;
  return 6;
}

function getPriority({ eligible, thresholdMonths }) {
  if (eligible >= 8 || thresholdMonths <= 6) return 'alta';
  if (eligible >= 3) return 'media';
  return 'baja';
}

function getRecommendedMode(treatmentName) {
  const normalized = normalizeText(treatmentName).toLowerCase();
  if (normalized.includes('implante') || normalized.includes('presupuesto')) return 'managed_calls';
  if (normalized.includes('higiene') || normalized.includes('periodon')) return 'lead_call_list';
  return 'whatsapp_template';
}

function mapPresetActionToMode(action) {
  return REACTIVATION_ACTION_TO_MODE[action] || 'whatsapp_template';
}

function getRevenueLabel(treatmentName) {
  const normalized = normalizeText(treatmentName).toLowerCase();
  if (normalized.includes('implante')) return 'Tratamiento de alto valor';
  if (normalized.includes('ortodon')) return 'Alta probabilidad de revisión';
  if (normalized.includes('capilar')) return 'Seguimiento preventivo';
  return 'Seguimiento recurrente';
}

function slugSuggestionId(treatmentName, thresholdMonths) {
  const slug = normalizeKey(treatmentName);
  return `auto_${slug || 'sin_tratamiento'}_${thresholdMonths}m`;
}

function parsePlaybookIdFromSuggestionId(suggestionId) {
  const match = String(suggestionId || '').match(/^playbook_(.+)$/);
  return match ? match[1] : null;
}

function getPlaybookPreset(playbook) {
  return playbook?.automation_strategy?.reactivation_preset || null;
}

function playbookTreatmentName(playbook) {
  return normalizeText(playbook?.treatment?.nombre)
    || normalizeText(playbook?.display_name)
    || 'Pacientes';
}

function buildAutomationSnapshot(playbook, template = null, catalog = null) {
  const strategy = playbook?.automation_strategy || {};
  if (strategy.mode !== 'force_template' || !strategy.template_key) {
    return null;
  }
  return {
    id: catalog?.id || template?.id || strategy.template_key,
    name: catalog?.display_name || catalog?.name || template?.name || `Automatización ${strategy.template_key}`,
    active: true,
    mode: 'force_template',
    template_key: strategy.template_key,
    template_version: strategy.template_version || template?.version || catalog?.template_version || null,
    playbook_id: playbook.id,
  };
}

async function resolvePlaybookAutomation(playbook) {
  const strategy = playbook?.automation_strategy || {};
  if (strategy.mode !== 'force_template' || !strategy.template_key) {
    return null;
  }
  const [template, catalog] = await Promise.all([
    AutomationFlowTemplateV2
      ? AutomationFlowTemplateV2.findOne({
        where: {
          template_key: strategy.template_key,
          ...(strategy.template_version ? { version: strategy.template_version } : {}),
        },
        attributes: ['id', 'template_key', 'version', 'name'],
        order: [['version', 'DESC'], ['id', 'DESC']],
        raw: true,
      })
      : null,
    AutomationFlowCatalog
      ? AutomationFlowCatalog.findOne({
        where: { template_key: strategy.template_key },
        attributes: ['id', 'name', 'display_name', 'template_key', 'template_version'],
        raw: true,
      })
      : null,
  ]);
  return buildAutomationSnapshot(playbook, template, catalog);
}

async function getActiveReactivationPlaybooks(limit = 20) {
  if (!AdminCampaignPlaybook) return [];
  return AdminCampaignPlaybook.findAll({
    where: {
      objective_id: 'reactivate_patients',
      status: 'active',
    },
    include: [
      { model: Tratamiento, as: 'treatment', attributes: ['id_tratamiento', 'nombre', 'disciplina', 'categoria'], required: false },
    ],
    order: [['updated_at', 'DESC']],
    limit,
  });
}

function scopeToWhere(scope) {
  const clauses = [];
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (scope?.scope === 'group' && Number.isInteger(scope.groupId)) {
    clauses.push({ grupo_clinica_id: scope.groupId });
  }
  if (clinicIds.length === 1) {
    clauses.push({ clinica_id: clinicIds[0] });
  } else if (clinicIds.length > 1) {
    clauses.push({ clinica_id: { [Op.in]: clinicIds } });
  }
  if (!clauses.length) {
    return { id: { [Op.eq]: -1 } };
  }
  return clauses.length === 1 ? clauses[0] : { [Op.or]: clauses };
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
  if (scope?.scope === 'group' && list.grupo_clinica_id && Number(list.grupo_clinica_id) === Number(scope.groupId)) {
    return true;
  }
  if (list.clinica_id && clinicIds.has(Number(list.clinica_id))) {
    return true;
  }
  const listClinicIds = Array.isArray(list.clinic_ids) ? list.clinic_ids : [];
  return listClinicIds.some((id) => clinicIds.has(Number(id)));
}

function ensureScopeAccess(list, scope) {
  if (!list || !listInScope(list, scope)) {
    const err = new Error('Lista de reactivación no encontrada en el scope actual');
    err.status = 404;
    throw err;
  }
}

async function collectSuggestionGroups(scope, options = {}) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (!clinicIds.length) {
    return [];
  }

  const now = new Date();
  const maxRows = Math.min(Math.max(Number(options.limit_rows || 2500), 100), 5000);
  const preset = options.preset || null;
  const treatmentScope = preset?.treatment_scope || options.treatmentScope || 'selected_treatment';
  const treatmentId = Number(options.treatmentId || 0);
  const forcedTreatmentFilter = treatmentId > 0 && treatmentScope !== 'any_treatment';
  const baseWhere = {
    clinica_id: clinicIds.length === 1 ? clinicIds[0] : { [Op.in]: clinicIds },
    inicio: { [Op.lt]: now },
    estado: { [Op.notIn]: Array.from(CANCELLED_STATES) },
  };
  if (forcedTreatmentFilter) {
    baseWhere.tratamiento_id = treatmentId;
  }

  const pastAppointments = await CitaPaciente.findAll({
    where: baseWhere,
    attributes: ['id_cita', 'clinica_id', 'paciente_id', 'tratamiento_id', 'estado', 'inicio'],
    include: [
      { model: Paciente, as: 'paciente', attributes: ['id_paciente', 'nombre', 'apellidos', 'telefono_movil', 'email', 'fecha_baja'] },
      { model: Tratamiento, as: 'tratamiento', attributes: ['id_tratamiento', 'nombre', 'disciplina', 'categoria'] },
    ],
    order: [['inicio', 'DESC']],
    limit: maxRows,
  });

  const patientIds = Array.from(new Set(
    pastAppointments
      .map((row) => Number(row.paciente_id || row.paciente?.id_paciente || 0))
      .filter((id) => Number.isInteger(id) && id > 0)
  ));

  const futureRows = patientIds.length
    ? await CitaPaciente.findAll({
      where: {
        paciente_id: { [Op.in]: patientIds },
        inicio: { [Op.gte]: now },
        estado: { [Op.notIn]: Array.from(CANCELLED_STATES) },
      },
      attributes: ['paciente_id'],
      raw: true,
    })
    : [];
  const futurePatientIds = new Set(futureRows.map((row) => Number(row.paciente_id)).filter(Boolean));
  const rejectedContactRows = patientIds.length && PacienteConsentimiento
    ? await PacienteConsentimiento.findAll({
      where: {
        paciente_id: { [Op.in]: patientIds },
        tipo: 'comunicaciones',
        estado: 'rechazado',
      },
      attributes: ['paciente_id'],
      raw: true,
    })
    : [];
  const noContactPatientIds = new Set(rejectedContactRows.map((row) => Number(row.paciente_id)).filter(Boolean));

  const latestByPatientTreatment = new Map();
  for (const appointment of pastAppointments) {
    const appointmentTreatmentName = normalizeText(appointment.tratamiento?.nombre) || 'Sin tratamiento asignado';
    const patientId = Number(appointment.paciente_id || appointment.paciente?.id_paciente || 0);
    if (!patientId) continue;
    const key = treatmentScope === 'any_treatment'
      ? `${patientId}:any`
      : `${patientId}:${appointmentTreatmentName.toLowerCase()}`;
    if (latestByPatientTreatment.has(key)) continue;
    latestByPatientTreatment.set(key, { appointment, appointmentTreatmentName, patientId });
  }

  const groups = new Map();
  for (const item of latestByPatientTreatment.values()) {
    const { appointment, appointmentTreatmentName, patientId } = item;
    const displayTreatmentName = options.groupTreatmentName
      || (treatmentScope === 'any_treatment' ? 'Cualquier tratamiento' : appointmentTreatmentName);
    const fallbackMonths = getThresholdMonths(displayTreatmentName);
    const threshold = toThresholdCutoff(
      preset?.inactivity_threshold?.value || options.thresholdValue || fallbackMonths,
      preset?.inactivity_threshold?.unit || options.thresholdUnit || 'months',
      fallbackMonths
    );
    const lastDate = new Date(appointment.inicio);
    if (!(lastDate < threshold.cutoff)) continue;

    const phone = normalizePhoneDigits(appointment.paciente?.telefono_movil || '');
    const hasFutureAppointment = futurePatientIds.has(patientId);
    const noContact = !!appointment.paciente?.fecha_baja || noContactPatientIds.has(patientId);
    const validPhone = phone && phone.length >= 8;
    let status = 'ready';
    let exclusionReason = null;
    let reason = 'Sin cita futura y teléfono válido';

    if (preset?.exclusions?.future_appointments !== false && hasFutureAppointment) {
      status = 'excluded_future_appointment';
      exclusionReason = 'cita_futura';
      reason = 'Tiene cita futura';
    } else if (preset?.exclusions?.no_contact !== false && noContact) {
      status = 'excluded_no_contact';
      exclusionReason = 'no_contactar';
      reason = 'No contactar o paciente dado de baja';
    } else if (!validPhone) {
      status = 'excluded_invalid_phone';
      exclusionReason = 'telefono_invalido';
      reason = 'Teléfono no válido';
    }

    const groupKey = options.playbookId ? `playbook:${options.playbookId}` : displayTreatmentName;
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        treatmentName: displayTreatmentName,
        thresholdMonths: threshold.monthsForPriority,
        threshold,
        playbookId: options.playbookId || null,
        playbookName: options.playbookName || null,
        recommendedMode: options.recommendedMode || null,
        estimatedRevenueLabel: options.estimatedRevenueLabel || null,
        automation: options.automation || null,
        sourcePlaybook: options.sourcePlaybook || null,
        candidates: [],
      });
    }

    groups.get(groupKey).candidates.push({
      patient_id: patientId,
      clinic_id: Number(appointment.clinica_id || 0) || null,
      name: [appointment.paciente?.nombre, appointment.paciente?.apellidos].filter(Boolean).join(' ').trim() || 'Paciente sin nombre',
      phone: phone ? `+${phone}` : '',
      email: appointment.paciente?.email || null,
      treatment: appointmentTreatmentName,
      last_visit_at: lastDate.toISOString(),
      status,
      exclusion_reason: exclusionReason,
      reason,
    });
  }

  const groupsList = Array.from(groups.values());
  for (const group of groupsList) {
    if (group.sourcePlaybook?.automation_strategy?.reactivation_preset?.exclusions?.duplicates === false) {
      continue;
    }
    const firstByPhone = new Map();
    for (const candidate of group.candidates) {
      const phoneKey = normalizePhoneDigits(candidate.phone || '');
      if (!phoneKey || candidate.status !== 'ready') continue;
      if (!firstByPhone.has(phoneKey)) {
        firstByPhone.set(phoneKey, candidate.name);
        continue;
      }
      candidate.status = 'excluded_duplicate';
      candidate.exclusion_reason = 'duplicado';
      candidate.reason = `Duplicado: mismo teléfono que ${firstByPhone.get(phoneKey)}`;
    }
  }

  return groupsList;
}

function buildSuggestionFromGroup(group) {
  const eligible = group.candidates.filter((candidate) => candidate.status === 'ready').length;
  const excluded = group.candidates.length - eligible;
  const id = group.playbookId ? `playbook_${group.playbookId}` : slugSuggestionId(group.treatmentName, group.thresholdMonths);
  const thresholdLabel = group.threshold?.label || `${group.thresholdMonths} meses`;
  const recommendedMode = group.recommendedMode || getRecommendedMode(group.treatmentName);
  return {
    id,
    title: group.playbookName || `${group.treatmentName} sin visita reciente`,
    subtitle: `Pacientes de ${group.treatmentName} sin cita futura detectada.`,
    treatment: group.treatmentName,
    condition: `Última cita hace más de ${thresholdLabel}, sin cita programada y con teléfono válido.`,
    candidates: group.candidates.length,
    eligible,
    excluded,
    exclusionSummary: excluded ? `${excluded} excluidos por cita futura, no contactar, duplicado o teléfono no válido.` : 'Sin exclusiones detectadas.',
    recommendedMode,
    priority: getPriority({ eligible, thresholdMonths: group.thresholdMonths }),
    estimatedRevenueLabel: group.estimatedRevenueLabel || getRevenueLabel(group.treatmentName),
    source: 'catalog',
    thresholdMonths: group.thresholdMonths,
    threshold: group.threshold?.criteria || { value: group.thresholdMonths, unit: 'months' },
    playbook_id: group.playbookId || null,
    automation: group.automation || null,
    candidates_preview: group.candidates.slice(0, 5),
    candidates_full: group.candidates,
  };
}

async function getSuggestions(scope, options = {}) {
  const playbooks = await getActiveReactivationPlaybooks(Math.min(Math.max(Number(options.limit || 8), 1), 20));
  const playbookGroups = [];

  for (const playbook of playbooks) {
    const preset = getPlaybookPreset(playbook);
    if (!preset || preset.list_source !== 'clinical_inactive') {
      continue;
    }
    const automation = await resolvePlaybookAutomation(playbook);
    const groups = await collectSuggestionGroups(scope, {
      ...options,
      preset,
      treatmentId: preset.treatment_scope === 'selected_treatment' ? Number(playbook.treatment_id || 0) : null,
      treatmentScope: preset.treatment_scope,
      groupTreatmentName: preset.treatment_scope === 'any_treatment' ? 'Cualquier tratamiento' : playbookTreatmentName(playbook),
      playbookId: playbook.id,
      playbookName: playbook.display_name,
      recommendedMode: mapPresetActionToMode(preset.default_action),
      estimatedRevenueLabel: playbook.recommended_budget_min || playbook.recommended_budget_max
        ? `Presupuesto recomendado ${playbook.recommended_budget_min || 0}-${playbook.recommended_budget_max || 0} €/mes`
        : null,
      automation,
      sourcePlaybook: playbook,
    });
    playbookGroups.push(...groups);
  }

  const groups = playbookGroups.length
    ? playbookGroups
    : await collectSuggestionGroups(scope, options);

  const suggestions = groups
    .map(buildSuggestionFromGroup)
    .filter((item) => item.candidates > 0)
    .sort((a, b) => (b.eligible - a.eligible) || (b.candidates - a.candidates))
    .slice(0, Math.min(Math.max(Number(options.limit || 8), 1), 20))
    .map(({ candidates_full, thresholdMonths, ...item }) => item);

  return {
    success: true,
    suggestions,
    generated_at: new Date().toISOString(),
  };
}

async function findSuggestion(scope, suggestionId) {
  const playbookId = parsePlaybookIdFromSuggestionId(suggestionId);
  if (playbookId && AdminCampaignPlaybook) {
    const playbook = await AdminCampaignPlaybook.findOne({
      where: {
        id: playbookId,
        objective_id: 'reactivate_patients',
        status: 'active',
      },
      include: [
        { model: Tratamiento, as: 'treatment', attributes: ['id_tratamiento', 'nombre', 'disciplina', 'categoria'], required: false },
      ],
    });
    if (!playbook) return null;
    const preset = getPlaybookPreset(playbook);
    if (!preset) return null;
    const automation = await resolvePlaybookAutomation(playbook);
    const groups = await collectSuggestionGroups(scope, {
      preset,
      treatmentId: preset.treatment_scope === 'selected_treatment' ? Number(playbook.treatment_id || 0) : null,
      treatmentScope: preset.treatment_scope,
      groupTreatmentName: preset.treatment_scope === 'any_treatment' ? 'Cualquier tratamiento' : playbookTreatmentName(playbook),
      playbookId: playbook.id,
      playbookName: playbook.display_name,
      recommendedMode: mapPresetActionToMode(preset.default_action),
      automation,
      sourcePlaybook: playbook,
    });
    return groups
      .map(buildSuggestionFromGroup)
      .find((suggestion) => suggestion.id === suggestionId) || null;
  }

  const groups = await collectSuggestionGroups(scope);
  return groups
    .map(buildSuggestionFromGroup)
    .find((suggestion) => suggestion.id === suggestionId) || null;
}

function computeCounters(items) {
  const total = items.length;
  const ready = items.filter((item) => item.status === 'ready').length;
  const excluded = items.filter((item) => String(item.status || '').startsWith('excluded')).length;
  const lead = items.filter((item) => item.status === 'lead' || item.status === 'new_contact').length;
  return {
    total,
    ready,
    selected: ready + lead,
    excluded,
    lead,
    sent: 0,
    delivered: 0,
    read: 0,
    replied: 0,
    appointments: 0,
    treatments: 0,
  };
}

const IMPORT_ALIASES = {
  name: ['nombre', 'nombre_completo', 'nombre_y_apellidos', 'nombre_apellidos', 'name', 'paciente', 'nombre_paciente', 'full_name'],
  first_name: ['nombre', 'first_name', 'firstname'],
  last_name: ['apellidos', 'apellido', 'last_name', 'lastname'],
  phone: ['telefono', 'teléfono', 'tela_fono', 'movil', 'móvil', 'ma_vil', 'telefono_movil', 'phone', 'mobile', 'whatsapp'],
  email: ['email', 'correo', 'correo_electronico', 'mail'],
  treatment: ['tratamiento', 'treatment', 'servicio', 'procedimiento'],
  last_visit_at: ['fecha_ultima_cita', 'ultima_cita', 'última_cita', 'fecha_ultimo_tratamiento', 'last_visit', 'last_visit_at'],
  clinic: ['clinica', 'clínica', 'clinic'],
};

function findImportHeader(headers, aliases) {
  const normalizedHeaders = new Map(headers.map((header) => [normalizeKey(header), header]));
  for (const alias of aliases) {
    const match = normalizedHeaders.get(normalizeKey(alias));
    if (match) return match;
  }
  return null;
}

function inferColumnMapping(rows, explicit = {}) {
  const headers = Array.from(new Set(
    rows.flatMap((row) => Object.keys(row || {})).map((header) => normalizeText(header)).filter(Boolean)
  ));
  const mapping = {};
  for (const [field, aliases] of Object.entries(IMPORT_ALIASES)) {
    mapping[field] = explicit[field] || findImportHeader(headers, aliases) || null;
  }
  return mapping;
}

function readImportValue(row, mapping, field) {
  const header = mapping?.[field];
  if (header && Object.prototype.hasOwnProperty.call(row, header)) {
    return normalizeText(row[header]);
  }
  const aliases = IMPORT_ALIASES[field] || [];
  for (const alias of aliases) {
    const normalized = normalizeKey(alias);
    const match = Object.keys(row || {}).find((key) => normalizeKey(key) === normalized);
    if (match) return normalizeText(row[match]);
  }
  return '';
}

function parseImportDate(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value === 'number') {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    excelEpoch.setUTCDate(excelEpoch.getUTCDate() + value);
    return Number.isFinite(excelEpoch.getTime()) ? excelEpoch : null;
  }
  const text = normalizeText(value);
  const date = new Date(text);
  if (Number.isFinite(date.getTime())) return date;
  const match = text.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})$/);
  if (!match) return null;
  const year = Number(match[3].length === 2 ? `20${match[3]}` : match[3]);
  const parsed = new Date(year, Number(match[2]) - 1, Number(match[1]));
  return Number.isFinite(parsed.getTime()) ? parsed : null;
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
  const explicitFields = Array.isArray(customFieldsSchema)
    ? customFieldsSchema.map(normalizeCustomFieldSchemaEntry).filter(Boolean)
    : [];
  if (explicitFields.length) {
    const custom = {};
    for (const field of explicitFields) {
      const cleanValue = normalizeText(row?.[field.source_column]);
      if (!cleanValue) continue;
      custom[field.key] = cleanValue;
    }
    return custom;
  }

  const mappedHeaders = new Set(Object.values(mapping || {}).filter(Boolean));
  const custom = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (mappedHeaders.has(key)) continue;
    if (STANDARD_IMPORT_FIELDS.has(normalizeKey(key))) continue;
    const cleanKey = normalizeKey(key);
    const cleanValue = normalizeText(value);
    if (!cleanKey || !cleanValue) continue;
    custom[cleanKey] = cleanValue;
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
      if (!fields.has(key)) {
        fields.set(key, {
          key,
          label: key.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '),
          type: /^-?\d+([.,]\d+)?$/.test(String(value)) ? 'number' : 'text',
          source: 'import',
        });
      }
    }
  }
  return Array.from(fields.values());
}

async function buildImportedItemPayloads(scope, body, transaction) {
  const rows = Array.isArray(body.import_rows) ? body.import_rows.filter((row) => row && typeof row === 'object') : [];
  if (!rows.length) return { itemPayloads: [], columnMapping: {}, customFieldsSchema: [] };

  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  const defaultClinicId = Number(body.clinic_id || clinicIds[0] || 0);
  if (!defaultClinicId) {
    const err = new Error('No hay una clínica concreta para crear pacientes desde la importación.');
    err.status = 400;
    throw err;
  }

  const columnMapping = inferColumnMapping(rows, body.column_mapping || {});
  const customFieldsSchema = buildCustomFieldSchema(rows, columnMapping, body.custom_fields_schema || []);
  const existingPatients = await Paciente.findAll({
    where: {
      clinica_id: clinicIds.length ? { [Op.in]: clinicIds } : defaultClinicId,
      telefono_movil: { [Op.ne]: null },
    },
    attributes: ['id_paciente', 'clinica_id', 'nombre', 'apellidos', 'telefono_movil', 'email'],
    transaction,
  });
  const patientByPhone = new Map();
  for (const patient of existingPatients) {
    const phoneKey = normalizePhoneDigits(patient.telefono_movil || '');
    if (phoneKey && !patientByPhone.has(phoneKey)) patientByPhone.set(phoneKey, patient);
  }

  const futureRows = existingPatients.length
    ? await CitaPaciente.findAll({
      where: {
        paciente_id: { [Op.in]: existingPatients.map((patient) => patient.id_paciente) },
        inicio: { [Op.gte]: new Date() },
        estado: { [Op.notIn]: Array.from(CANCELLED_STATES) },
      },
      attributes: ['paciente_id'],
      raw: true,
      transaction,
    })
    : [];
  const futurePatientIds = new Set(futureRows.map((row) => Number(row.paciente_id)).filter(Boolean));
  const seenPhones = new Map();
  const itemPayloads = [];

  for (const row of rows) {
    const rawFullName = readImportValue(row, columnMapping, 'name') || [
      readImportValue(row, columnMapping, 'first_name'),
      readImportValue(row, columnMapping, 'last_name'),
    ].filter(Boolean).join(' ');
    const normalizedFullName = toTitleCaseName(rawFullName || 'Paciente importado');
    const splitName = splitFullName(normalizedFullName);
    const phoneDigits = normalizePhoneDigits(readImportValue(row, columnMapping, 'phone'));
    const formattedPhone = phoneDigits ? `+${phoneDigits}` : null;
    const email = readImportValue(row, columnMapping, 'email') || null;
    const treatment = titleCaseIfNeeded(readImportValue(row, columnMapping, 'treatment') || body.treatment || 'Sin tratamiento asignado');
    const lastVisit = parseImportDate(readImportValue(row, columnMapping, 'last_visit_at'));
    const customFields = buildCustomFields(row, columnMapping, customFieldsSchema);
    let patient = phoneDigits ? patientByPhone.get(phoneDigits) : null;
    let createdNewPatient = false;
    const validPhone = !!phoneDigits && phoneDigits.length >= 8;

    if (!patient && validPhone) {
      patient = await Paciente.create({
        nombre: splitName.nombre,
        apellidos: splitName.apellidos,
        telefono_movil: formattedPhone,
        email,
        clinica_id: defaultClinicId,
      }, { transaction });
      patientByPhone.set(phoneDigits, patient);
      createdNewPatient = true;
    }

    let status = 'ready';
    let reason = createdNewPatient ? 'Paciente creado desde importación' : (patient ? 'Paciente relacionado con ficha existente' : 'Contacto importado sin ficha de paciente');
    let exclusionReason = null;
    let selected = true;
    if (!validPhone) {
      status = 'excluded_invalid_phone';
      reason = 'Teléfono no válido';
      exclusionReason = 'telefono_invalido';
      selected = false;
    } else if (seenPhones.has(phoneDigits)) {
      status = 'excluded_duplicate';
      reason = `Duplicado: mismo teléfono que ${seenPhones.get(phoneDigits)}`;
      exclusionReason = 'duplicado';
      selected = false;
    } else if (patient && futurePatientIds.has(Number(patient.id_paciente))) {
      status = 'excluded_future_appointment';
      reason = 'Tiene cita futura';
      exclusionReason = 'cita_futura';
      selected = false;
    }
    if (validPhone && !seenPhones.has(phoneDigits)) {
      seenPhones.set(phoneDigits, normalizedFullName);
    }

    itemPayloads.push({
      paciente_id: patient?.id_paciente || null,
      clinica_id: Number(patient?.clinica_id || defaultClinicId),
      name: normalizedFullName,
      phone: formattedPhone,
      email,
      treatment,
      last_visit_at: lastVisit,
      status,
      reason,
      exclusion_reason: exclusionReason,
      selected,
      custom_fields: customFields,
      missing_variables: [],
      raw_import_json: row,
    });
  }

  return { itemPayloads, columnMapping, customFieldsSchema };
}

async function buildCustomItemPayloads(scope, body = {}) {
  const conditions = Array.isArray(body.rules) ? body.rules : [];
  const noVisitRule = conditions.find((rule) => rule?.kind === 'no_visit') || conditions[0] || {};
  const treatmentId = Number(body.treatment_id || body.treatmentId || 0) || null;
  const groups = await collectSuggestionGroups(scope, {
    treatmentId,
    treatmentScope: treatmentId ? 'selected_treatment' : 'any_treatment',
    groupTreatmentName: body.treatment || (treatmentId ? null : 'Cualquier tratamiento'),
    thresholdValue: Math.max(Number(noVisitRule.amount || 6), 1),
    thresholdUnit: mapDialogUnitToBackend(noVisitRule.unit || 'meses'),
  });

  return groups.flatMap((group) => group.candidates.map(mapSuggestionCandidateToItem));
}

function mapSuggestionCandidateToItem(candidate) {
  return {
    paciente_id: candidate.patient_id || null,
    clinica_id: candidate.clinic_id || null,
    name: candidate.name || 'Paciente sin nombre',
    phone: candidate.phone || null,
    email: candidate.email || null,
    treatment: candidate.treatment || null,
    last_visit_at: candidate.last_visit_at ? new Date(candidate.last_visit_at) : null,
    status: candidate.status === 'ready' ? 'ready' : candidate.status,
    reason: candidate.reason || null,
    exclusion_reason: candidate.exclusion_reason || null,
    selected: candidate.status === 'ready',
    custom_fields: {},
    missing_variables: [],
  };
}

function actionModeToChannel(actionMode) {
  if (actionMode === 'whatsapp_template') return 'whatsapp';
  if (actionMode === 'lead_call_list') return 'calls';
  if (actionMode === 'managed_calls') return 'calls';
  return null;
}

async function snapshotTemplate(templateId) {
  const safeTemplateId = Number(templateId || 0);
  if (!safeTemplateId) {
    return { template: null, snapshot: null };
  }
  const template = MessageTemplate
    ? await MessageTemplate.findByPk(safeTemplateId)
    : null;
  if (!template) {
    const err = new Error('Plantilla no encontrada');
    err.status = 404;
    throw err;
  }
  return {
    template,
    snapshot: {
      id: template.id,
      nombre: template.nombre,
      estado: template.estado,
      uso: template.uso,
      contenido: template.contenido,
      clinica_id: template.clinica_id,
      captured_at: new Date().toISOString(),
    },
  };
}

function buildSafetyGates({ actionMode, template, list }) {
  const approvedTemplate = actionMode !== 'whatsapp_template' || template?.estado === 'aprobada';
  return {
    frozen_audience: Number(list?.counters?.total || 0) > 0,
    opt_out: false,
    capping: false,
    approved_template: approvedTemplate,
    audit: true,
    cancelable_queue: false,
  };
}

function getBlockedGates(safetyGates) {
  return REQUIRED_SEND_GATES.filter((key) => safetyGates?.[key] !== true);
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
    treatment: plain.treatment,
    last_visit_at: plain.last_visit_at,
    status: plain.status,
    reason: plain.reason,
    exclusion_reason: plain.exclusion_reason,
    selected: plain.selected,
    custom_fields: plain.custom_fields || {},
    missing_variables: plain.missing_variables || [],
    appointment_at: plain.appointment_at,
    treatment_completed: !!plain.treatment_completed,
    notes: plain.notes || null,
  };
}

function serializeList(list, { itemsPreview = [] } = {}) {
  const plain = list?.get ? list.get({ plain: true }) : list;
  const counters = plain.counters || {};
  const metrics = plain.metrics || {};
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
    treatment: plain.treatment,
    condition_summary: plain.condition_summary,
    exclusion_summary: plain.exclusion_summary,
    criteria: plain.criteria || {},
    action_mode: plain.action_mode,
    channel: plain.channel,
    template_id: plain.template_id,
    template_snapshot: plain.template_snapshot || null,
    counters,
    metrics,
    automation: plain.automation || null,
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

function buildEmptyDailySeries() {
  const today = new Date();
  return Array.from({ length: 14 }).map((_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() - (13 - index));
    return {
      date: date.toISOString().slice(0, 10),
      sent: 0,
      replied: 0,
      appointments: 0,
    };
  });
}

async function getLists(scope) {
  const where = {
    objective_id: 'reactivate_patients',
    status: { [Op.ne]: 'archived' },
    ...scopeToWhere(scope),
  };
  const lists = await MarketingPatientList.findAll({
    where,
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
    if (!previewByList.has(row.list_id)) {
      previewByList.set(row.list_id, []);
    }
    const bucket = previewByList.get(row.list_id);
    if (bucket.length < 5) {
      bucket.push(row);
    }
  }

  const items = lists.map((list) => serializeList(list, { itemsPreview: previewByList.get(list.id) || [] }));
  const aggregate = items.reduce((acc, list) => {
    const counters = list.counters || {};
    const metrics = list.metrics || {};
    acc.total_lists += 1;
    acc.total_patients += Number(counters.total || 0);
    acc.ready += Number(counters.ready || 0);
    acc.excluded += Number(counters.excluded || 0);
    acc.sent += Number(counters.sent || 0);
    acc.delivered += Number(counters.delivered || 0);
    acc.replied += Number(counters.replied || 0);
    acc.appointments += Number(counters.appointments || 0);
    acc.treatments += Number(counters.treatments || 0);
    acc.estimated_revenue += Number(metrics.estimated_revenue || 0);
    return acc;
  }, {
    total_lists: 0,
    total_patients: 0,
    ready: 0,
    excluded: 0,
    sent: 0,
    delivered: 0,
    replied: 0,
    appointments: 0,
    treatments: 0,
    estimated_revenue: 0,
  });

  return {
    success: true,
    items,
    aggregate,
    daily_series: buildEmptyDailySeries(),
  };
}

async function createList(scope, body = {}, userId = null) {
  const source = body.source || 'clinical_inactive';
  const suggestionId = body.suggestion_id || body.suggestionId || null;
  const suggestion = suggestionId ? await findSuggestion(scope, suggestionId) : null;

  if (suggestionId && !suggestion) {
    const err = new Error('No se pudo recalcular la lista sugerida. Revisa el scope o vuelve a actualizar sugerencias.');
    err.status = 404;
    throw err;
  }

  const scopePayload = serializeScope(scope);

  return db.sequelize.transaction(async (transaction) => {
    const importResult = source === 'import'
      ? await buildImportedItemPayloads(scope, body, transaction)
      : null;
    const customPayloads = !importResult && !suggestion && source === 'custom'
      ? await buildCustomItemPayloads(scope, body)
      : null;
    const itemPayloads = importResult
      ? importResult.itemPayloads
      : (customPayloads || (suggestion ? suggestion.candidates_full.map(mapSuggestionCandidateToItem) : []));
    const counters = computeCounters(itemPayloads);
    const actionMode = body.action_mode || suggestion?.recommendedMode || 'whatsapp_template';
    const list = await MarketingPatientList.create({
      name: body.name || suggestion?.title || 'Lista de reactivación',
      objective_id: 'reactivate_patients',
      source: source === 'custom' ? 'manual_list' : (source === 'import' ? 'imported_file' : source),
      status: 'draft',
      ...scopePayload,
      treatment: body.treatment || suggestion?.treatment || itemPayloads[0]?.treatment || null,
      condition_summary: body.condition_summary || suggestion?.condition || null,
      exclusion_summary: body.exclusion_summary || suggestion?.exclusionSummary || null,
      criteria: {
        suggestion_id: suggestion?.id || null,
        playbook_id: suggestion?.playbook_id || body.playbook_id || null,
        threshold: suggestion?.threshold || null,
        threshold_months: suggestion?.thresholdMonths || body.threshold_months || null,
        source,
        treatment_id: body.treatment_id || body.treatmentId || null,
        import_file_name: body.import_file_name || null,
        column_mapping: importResult?.columnMapping || body.column_mapping || null,
        rules: body.rules || [],
      },
      action_mode: actionMode,
      channel: actionModeToChannel(actionMode),
      counters,
      metrics: {
        estimated_revenue: 0,
        total_cost: 0,
      },
      automation: body.automation || suggestion?.automation || null,
      safety_gates: {
        frozen_audience: counters.total > 0,
        opt_out: false,
        capping: false,
        approved_template: false,
        audit: true,
        cancelable_queue: false,
      },
      custom_fields_schema: importResult?.customFieldsSchema || body.custom_fields_schema || [],
      created_by: userId || null,
    }, { transaction });

    if (itemPayloads.length) {
      await MarketingPatientListItem.bulkCreate(
        itemPayloads.map((item) => ({ ...item, list_id: list.id })),
        { transaction }
      );
    }

    await MarketingPatientContactEvent.create({
      list_id: list.id,
      event_type: 'list_created',
      channel: list.channel,
      payload: {
        source,
        suggestion_id: suggestion?.id || null,
        counters,
      },
      occurred_at: new Date(),
    }, { transaction });

    const created = await MarketingPatientList.findByPk(list.id, { transaction });
    const preview = itemPayloads.slice(0, 5).map((item, index) => ({ ...item, id: index + 1, list_id: list.id }));
    return {
      success: true,
      list: serializeList(created, { itemsPreview: preview }),
    };
  });
}

async function getList(scope, listId) {
  const list = await MarketingPatientList.findByPk(listId);
  ensureScopeAccess(list, scope);
  const items = await MarketingPatientListItem.findAll({
    where: { list_id: list.id },
    order: [['id', 'ASC']],
    limit: 500,
  });
  return {
    success: true,
    list: serializeList(list, { itemsPreview: items.slice(0, 5) }),
    items: items.map(serializeItem),
  };
}

async function getItems(scope, listId) {
  const list = await MarketingPatientList.findByPk(listId);
  ensureScopeAccess(list, scope);
  const items = await MarketingPatientListItem.findAll({
    where: { list_id: list.id },
    order: [['id', 'ASC']],
    limit: 1000,
  });
  return {
    success: true,
    items: items.map(serializeItem),
  };
}

async function prepareList(scope, listId, body = {}, userId = null) {
  const list = await MarketingPatientList.findByPk(listId);
  ensureScopeAccess(list, scope);
  const actionMode = body.action_mode || list.action_mode || 'whatsapp_template';
  const { template, snapshot } = await snapshotTemplate(body.template_id || list.template_id || null);
  const items = await MarketingPatientListItem.findAll({ where: { list_id: list.id } });
  const counters = computeCounters(items.map((item) => item.get({ plain: true })));
  const safetyGates = buildSafetyGates({ actionMode, template, list: { counters } });

  await list.update({
    status: 'prepared',
    action_mode: actionMode,
    channel: actionModeToChannel(actionMode),
    template_id: template?.id || null,
    template_snapshot: snapshot,
    counters,
    safety_gates: safetyGates,
    prepared_at: new Date(),
  });

  await MarketingPatientContactEvent.create({
    list_id: list.id,
    event_type: 'list_prepared',
    channel: actionModeToChannel(actionMode),
    payload: {
      action_mode: actionMode,
      template_id: template?.id || null,
      user_id: userId || null,
      safety_gates: safetyGates,
      blocked_gates: getBlockedGates(safetyGates),
    },
    occurred_at: new Date(),
  });

  const reloaded = await MarketingPatientList.findByPk(list.id);
  return {
    success: true,
    list: serializeList(reloaded, { itemsPreview: items.slice(0, 5) }),
    dispatch_blocked: true,
    blocked_gates: getBlockedGates(safetyGates),
    message: 'Lista preparada. El envío masivo sigue bloqueado hasta completar opt-out, capping, plantilla aprobada y cola cancelable.',
  };
}

async function scheduleList(scope, listId) {
  const list = await MarketingPatientList.findByPk(listId);
  ensureScopeAccess(list, scope);
  const blockedGates = getBlockedGates(list.safety_gates || {});
  const err = new Error('El envío masivo todavía no está disponible para listas de reactivación.');
  err.status = 409;
  err.payload = {
    success: false,
    dispatch_blocked: true,
    blocked_gates: blockedGates.length ? blockedGates : REQUIRED_SEND_GATES,
    message: 'No se envía nada hasta tener audiencia congelada, opt-out, capping, plantilla aprobada, auditoría y cola cancelable.',
  };
  throw err;
}

async function removeList(scope, listId, userId = null) {
  const list = await MarketingPatientList.findByPk(listId);
  ensureScopeAccess(list, scope);

  if (list.status === 'draft') {
    await MarketingPatientContactEvent.create({
      list_id: list.id,
      event_type: 'list_deleted',
      channel: list.channel,
      payload: {
        status: list.status,
        user_id: userId || null,
      },
      occurred_at: new Date(),
    });
    await list.destroy();
    return {
      success: true,
      action: 'deleted',
      id: Number(listId),
    };
  }

  const previousStatus = list.status;
  await list.update({
    status: 'archived',
    safety_gates: {
      ...(list.safety_gates || {}),
      archived: true,
    },
  });
  await MarketingPatientContactEvent.create({
    list_id: list.id,
    event_type: 'list_archived',
    channel: list.channel,
    payload: {
      previous_status: previousStatus,
      user_id: userId || null,
    },
    occurred_at: new Date(),
  });

  const reloaded = await MarketingPatientList.findByPk(list.id);
  return {
    success: true,
    action: 'archived',
    list: serializeList(reloaded),
  };
}

async function rebuildList(scope, listId) {
  const list = await MarketingPatientList.findByPk(listId);
  ensureScopeAccess(list, scope);
  const suggestionId = list.criteria?.suggestion_id;
  if (!suggestionId) {
    const err = new Error('Esta lista no tiene una sugerencia automática recalculable.');
    err.status = 400;
    throw err;
  }
  const suggestion = await findSuggestion(scope, suggestionId);
  if (!suggestion) {
    const err = new Error('No se encontró la sugerencia original en el scope actual.');
    err.status = 404;
    throw err;
  }
  const itemPayloads = suggestion.candidates_full.map(mapSuggestionCandidateToItem);
  const counters = computeCounters(itemPayloads);

  await db.sequelize.transaction(async (transaction) => {
    await MarketingPatientListItem.destroy({ where: { list_id: list.id }, transaction });
    if (itemPayloads.length) {
      await MarketingPatientListItem.bulkCreate(itemPayloads.map((item) => ({ ...item, list_id: list.id })), { transaction });
    }
    await list.update({
      condition_summary: suggestion.condition,
      exclusion_summary: suggestion.exclusionSummary,
      counters,
      status: list.status === 'prepared' ? 'draft' : list.status,
      safety_gates: {
        ...(list.safety_gates || {}),
        frozen_audience: counters.total > 0,
      },
    }, { transaction });
    await MarketingPatientContactEvent.create({
      list_id: list.id,
      event_type: 'list_rebuilt',
      channel: list.channel,
      payload: { counters },
      occurred_at: new Date(),
    }, { transaction });
  });

  const reloaded = await MarketingPatientList.findByPk(list.id);
  return {
    success: true,
    list: serializeList(reloaded, { itemsPreview: itemPayloads.slice(0, 5).map((item, index) => ({ ...item, id: index + 1, list_id: list.id })) }),
  };
}

async function getEvents(scope, listId) {
  const list = await MarketingPatientList.findByPk(listId);
  ensureScopeAccess(list, scope);
  const events = await MarketingPatientContactEvent.findAll({
    where: { list_id: list.id },
    order: [['created_at', 'DESC']],
    limit: 200,
  });
  return {
    success: true,
    events: events.map((event) => event.get({ plain: true })),
  };
}

module.exports = {
  getSuggestions,
  getLists,
  createList,
  getList,
  getItems,
  prepareList,
  scheduleList,
  removeList,
  rebuildList,
  getEvents,
};
