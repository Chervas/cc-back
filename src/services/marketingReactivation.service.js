'use strict';

const { Op } = require('sequelize');
const crypto = require('crypto');
const db = require('../../models');
const { normalizePhoneDigits } = require('../lib/phone');
const marketingOptOutService = require('./marketingOptOut.service');

const {
  AdminCampaignPlaybook,
  AutomationFlowCatalog,
  AutomationFlowTemplateV2,
  CitaPaciente,
  Clinica,
  MarketingPatientContactEvent,
  MarketingPatientList,
  MarketingPatientListItem,
  MessageTemplate,
  PacienteConsentimiento,
  Paciente,
  PacienteClinica,
  PatientCustomField,
  Tratamiento,
} = db;

const CANCELLED_STATES = new Set(['cancelada', 'no_asistio']);
const generatePacientePublicId = () => `pac_${crypto.randomBytes(10).toString('hex')}`;

async function generateUniquePacientePublicId(transaction) {
  for (let i = 0; i < 8; i++) {
    const publicId = generatePacientePublicId();
    const existing = await Paciente.findOne({
      where: { public_id: publicId },
      attributes: ['id_paciente'],
      transaction,
    });
    if (!existing) return publicId;
  }
  throw new Error('paciente_public_id_generation_failed');
}

const REQUIRED_SEND_GATES = ['frozen_audience', 'opt_out', 'capping', 'approved_template', 'audit', 'cancelable_queue'];
const REACTIVATION_ACTION_TO_MODE = {
  whatsapp_auto: 'whatsapp_template',
  send_to_leads: 'lead_call_list',
  managed_calls: 'managed_calls',
};
const STANDARD_IMPORT_FIELDS = new Set(['name', 'first_name', 'last_name', 'phone', 'phone_landline', 'email', 'treatment', 'last_visit_at', 'clinic']);
const COMMERCIAL_TEMPLATE_USAGES = new Set(['marketing', 'comercial', 'promocion', 'promocional', 'reactivacion_pacientes']);

function toDateMonthsAgo(months) {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date;
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
  return repairMojibake(String(value || '')).trim();
}

function normalizeKey(value) {
  return normalizeText(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function isCommercialTemplateUsage(value) {
  return COMMERCIAL_TEMPLATE_USAGES.has(normalizeKey(value));
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
  if (normalized.includes(',')) {
    const [lastNameRaw, ...firstNameRaw] = normalized.split(',');
    const firstName = toTitleCaseName(firstNameRaw.join(',').trim() || lastNameRaw);
    const lastName = toTitleCaseName(firstNameRaw.length ? lastNameRaw : '');
    return {
      nombre: firstName || 'Paciente',
      apellidos: lastName,
    };
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

function normalizeTreatmentMappings(rawMappings = {}) {
  const entries = Array.isArray(rawMappings)
    ? rawMappings.map((item) => [item?.source || item?.sourceValue || item?.source_value, item])
    : Object.entries(rawMappings || {});
  const mappings = new Map();
  for (const [source, raw] of entries) {
    const sourceName = normalizeText(source);
    if (!sourceName || !raw || typeof raw !== 'object') continue;
    const key = normalizeKey(sourceName);
    mappings.set(key, {
      source: sourceName,
      treatment_id: Number(raw.treatment_id || raw.treatmentId || 0) || null,
      treatment_name: titleCaseIfNeeded(raw.treatment_name || raw.treatmentName || sourceName),
      create_if_missing: raw.create_if_missing !== false && raw.createIfMissing !== false,
    });
  }
  return mappings;
}

function uniqueNonEmpty(values) {
  return Array.from(new Set(
    (values || [])
      .map((value) => normalizeText(value))
      .filter(Boolean)
  ));
}

function shortenSemanticNamePart(value, maxLength) {
  const text = normalizeText(value).replace(/\s+/g, ' ');
  if (!text || text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function composeReactivationListName(treatment, condition) {
  return [
    'Reactivación',
    shortenSemanticNamePart(treatment || 'varios tratamientos', 42),
    shortenSemanticNamePart(condition || 'condiciones configuradas', 58),
  ].join(' · ');
}

function looksLikeGeneratedImportName(value) {
  const normalized = normalizeKey(value);
  return normalized.startsWith('importacion_')
    || normalized.includes('_importacion_')
    || normalized.startsWith('automatizacion_importacion_')
    || normalized.startsWith('automatizacion_reactivacion_importacion_');
}

function resolveSemanticTreatmentLabel({ body = {}, suggestion = null, itemPayloads = [] } = {}) {
  const direct = normalizeText(body.treatment || suggestion?.treatment);
  if (direct && normalizeKey(direct) !== 'varios') return direct;

  const mappings = normalizeTreatmentMappings(body.treatment_mappings || body.treatment_mapping || {});
  const mappedNames = uniqueNonEmpty(Array.from(mappings.values()).map((mapping) => mapping.treatment_name));
  if (mappedNames.length === 1) return mappedNames[0];
  if (mappedNames.length > 1) {
    return mappedNames.length > 2
      ? `${mappedNames.slice(0, 2).join(', ')} y ${mappedNames.length - 2} más`
      : mappedNames.join(' y ');
  }

  const itemNames = uniqueNonEmpty(itemPayloads.map((item) => item.treatment));
  if (itemNames.length === 1) return itemNames[0];
  if (itemNames.length > 1) {
    return itemNames.length > 2
      ? `${itemNames.slice(0, 2).join(', ')} y ${itemNames.length - 2} más`
      : itemNames.join(' y ');
  }

  return 'varios tratamientos';
}

function resolveSemanticConditionLabel({ source, body = {}, suggestion = null } = {}) {
  const direct = normalizeText(body.condition_summary || suggestion?.condition);
  if (direct && normalizeKey(direct) !== 'pacientes_importados_desde_archivo') return direct;
  const months = Number(suggestion?.thresholdMonths || body.threshold_months || body.threshold || 0);
  if (Number.isFinite(months) && months > 0) {
    return `sin visita desde hace más de ${months} meses`;
  }
  if (source === 'import') {
    return 'fecha de tratamiento importada';
  }
  return 'condiciones configuradas';
}

function buildSemanticReactivationListName({ source, body, suggestion, itemPayloads } = {}) {
  return composeReactivationListName(
    resolveSemanticTreatmentLabel({ body, suggestion, itemPayloads }),
    resolveSemanticConditionLabel({ source, body, suggestion })
  );
}

function shouldUseSemanticReactivationName(name) {
  const clean = normalizeText(name);
  return !clean || looksLikeGeneratedImportName(clean);
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
  const marketingOptOutSets = await marketingOptOutService.getActiveOptOutSetsForScope(scope);

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
    const hasMarketingOptOut = marketingOptOutService.isContactOptedOut({
      patientId,
      phone: appointment.paciente?.telefono_movil || '',
      optOutSets: marketingOptOutSets,
    });
    const noContact = !!appointment.paciente?.fecha_baja || noContactPatientIds.has(patientId);
    const validPhone = phone && phone.length >= 8;
    let status = 'ready';
    let exclusionReason = null;
    let reason = 'Sin cita futura y teléfono válido';

    if (preset?.exclusions?.future_appointments !== false && hasFutureAppointment) {
      status = 'excluded_future_appointment';
      exclusionReason = 'cita_futura';
      reason = 'Tiene cita futura';
    } else if (hasMarketingOptOut) {
      status = 'excluded_opt_out';
      exclusionReason = 'opt_out';
      reason = 'Baja comercial solicitada por WhatsApp';
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
        treatmentId: options.treatmentId || Number(appointment.tratamiento_id || appointment.tratamiento?.id_tratamiento || 0) || null,
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
      treatment_id: Number(appointment.tratamiento_id || appointment.tratamiento?.id_tratamiento || 0) || null,
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
  const hasCandidates = group.candidates.length > 0;
  return {
    id,
    title: group.playbookName || `${group.treatmentName} sin visita reciente`,
    subtitle: hasCandidates
      ? `Pacientes de ${group.treatmentName} sin cita futura detectada.`
      : 'Preset activo del catálogo. Todavía no hay pacientes detectados en este scope.',
    treatment: group.treatmentName,
    treatment_id: group.treatmentId || null,
    condition: `Última cita hace más de ${thresholdLabel}, sin cita programada y con teléfono válido.`,
    candidates: group.candidates.length,
    eligible,
    excluded,
    exclusionSummary: excluded
      ? `${excluded} excluidos por cita futura, no contactar, duplicado o teléfono no válido.`
      : (hasCandidates ? 'Sin exclusiones detectadas.' : 'Sin pacientes que cumplan estas condiciones en el scope seleccionado.'),
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

function buildEmptyPlaybookGroup(playbook, preset, options = {}) {
  const treatmentName = preset?.treatment_scope === 'any_treatment'
    ? 'Cualquier tratamiento'
    : playbookTreatmentName(playbook);
  const fallbackMonths = getThresholdMonths(treatmentName);
  const threshold = toThresholdCutoff(
    preset?.inactivity_threshold?.value || fallbackMonths,
    preset?.inactivity_threshold?.unit || 'months',
    fallbackMonths
  );

  return {
    treatmentName,
    treatmentId: playbook.treatment_id || null,
    thresholdMonths: threshold.monthsForPriority,
    threshold,
    playbookId: playbook.id,
    playbookName: playbook.display_name,
    recommendedMode: mapPresetActionToMode(preset?.default_action),
    estimatedRevenueLabel: null,
    automation: options.automation || null,
    sourcePlaybook: playbook,
    candidates: [],
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
      estimatedRevenueLabel: null,
      automation,
      sourcePlaybook: playbook,
    });
    playbookGroups.push(...(groups.length ? groups : [buildEmptyPlaybookGroup(playbook, preset, { automation })]));
  }

  const groups = playbookGroups.length
    ? playbookGroups
    : await collectSuggestionGroups(scope, options);

  const suggestions = groups
    .map(buildSuggestionFromGroup)
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
    const effectiveGroups = groups.length ? groups : [buildEmptyPlaybookGroup(playbook, preset, { automation })];
    return effectiveGroups
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

async function applyMarketingOptOutExclusions(itemPayloads, scope, transaction = null) {
  if (!Array.isArray(itemPayloads) || !itemPayloads.length) return itemPayloads;
  const optOutSets = await marketingOptOutService.getActiveOptOutSetsForScope(scope, transaction);
  return itemPayloads.map((item) => {
    if (String(item.status || '').startsWith('excluded')) return item;
    if (!marketingOptOutService.isContactOptedOut({
      patientId: item.paciente_id || item.patient_id || null,
      phone: item.phone || null,
      optOutSets,
    })) {
      return item;
    }
    return {
      ...item,
      status: 'excluded_opt_out',
      reason: 'Baja comercial solicitada por WhatsApp en un envío anterior',
      exclusion_reason: 'opt_out',
      selected: false,
    };
  });
}

const IMPORT_ALIASES = {
  name: ['nombre', 'nombre_completo', 'nombre_y_apellidos', 'nombre_apellidos', 'name', 'paciente', 'nombre_paciente', 'full_name'],
  first_name: ['nombre', 'first_name', 'firstname'],
  last_name: ['apellidos', 'apellido', 'last_name', 'lastname'],
  phone: ['telefono', 'teléfono', 'tela_fono', 'movil', 'móvil', 'ma_vil', 'telefono_movil', 'phone', 'mobile', 'whatsapp'],
  phone_landline: ['telefono_fijo', 'teléfono_fijo', 'telefono_secundario', 'teléfono_secundario', 'fijo', 'phone_landline', 'landline', 'fixed_phone', 'telefono_casa'],
  email: ['email', 'correo', 'correo_electronico', 'mail'],
  treatment: ['tratamiento', 'treatment', 'servicio', 'procedimiento'],
  last_visit_at: ['fecha_ultima_cita', 'ultima_cita', 'última_cita', 'fecha_ultimo_tratamiento', 'last_visit', 'last_visit_at'],
  clinic: ['clinica', 'clínica', 'sede', 'centro', 'clinic', 'location'],
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

async function loadImportClinicLookup(scope, transaction) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.filter(Number.isInteger) : [];
  if (!clinicIds.length || !Clinica) {
    return { byId: new Map(), byName: new Map(), clinicIds };
  }
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
  return { byId, byName, clinicIds };
}

function resolveImportedClinicId(importedClinic, lookup) {
  const normalized = normalizeText(importedClinic);
  if (!normalized) return null;
  const numericId = Number(normalized);
  if (Number.isInteger(numericId) && lookup.byId.has(numericId)) {
    return numericId;
  }
  return lookup.byName.get(normalizeKey(normalized)) || null;
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

async function loadImportTreatments(scope, defaultClinicId, transaction) {
  const groupId = Number(scope?.groupId || 0);
  const orClauses = [
    { origen: 'sistema' },
    { clinica_id: defaultClinicId },
  ];
  if (Number.isInteger(groupId) && groupId > 0) {
    orClauses.push({ grupo_clinica_id: groupId });
  }
  return Tratamiento.findAll({
    where: {
      activo: true,
      [Op.or]: orClauses,
    },
    attributes: ['id_tratamiento', 'nombre', 'disciplina', 'categoria', 'origen', 'clinica_id', 'grupo_clinica_id', 'duracion_min'],
    transaction,
  });
}

function indexTreatments(treatments) {
  const byId = new Map();
  const byKey = new Map();
  for (const treatment of treatments || []) {
    const plain = treatment?.get ? treatment.get({ plain: true }) : treatment;
    const id = Number(plain.id_tratamiento || 0);
    if (id) byId.set(id, plain);
    const key = normalizeKey(plain.nombre);
    if (key && !byKey.has(key)) byKey.set(key, plain);
  }
  return { byId, byKey };
}

async function resolveImportedTreatment(rawTreatment, context) {
  const sourceName = titleCaseIfNeeded(rawTreatment || 'Sin tratamiento asignado');
  const sourceKey = normalizeKey(sourceName);
  const mapping = context.treatmentMappings.get(sourceKey);
  const mappedId = Number(mapping?.treatment_id || 0);
  if (mappedId && context.treatmentsById.has(mappedId)) {
    const treatment = context.treatmentsById.get(mappedId);
    return { id: mappedId, name: treatment.nombre || sourceName };
  }

  const mappedName = titleCaseIfNeeded(mapping?.treatment_name || sourceName);
  const mappedKey = normalizeKey(mappedName);
  const existing = context.treatmentsByKey.get(mappedKey) || context.treatmentsByKey.get(sourceKey);
  if (existing?.id_tratamiento) {
    return { id: Number(existing.id_tratamiento), name: existing.nombre || mappedName };
  }

  if (!mapping || mapping.create_if_missing) {
    const created = await Tratamiento.create({
      nombre: mappedName,
      codigo: normalizeKey(mappedName).slice(0, 50) || null,
      descripcion: 'Creado vacío desde importación de pacientes para reactivación.',
      disciplina: 'general',
      especialidad: null,
      categoria: 'General',
      duracion_min: 30,
      precio_base: 0,
      color: null,
      origen: 'clinica',
      clinica_id: context.defaultClinicId,
      grupo_clinica_id: null,
      activo: true,
      sesiones_defecto: 1,
      requiere_pieza: false,
      requiere_zona: false,
      asignacion_instalacion_tipo: 'cualquiera',
    }, { transaction: context.transaction });
    const plain = created.get({ plain: true });
    context.treatmentsById.set(Number(plain.id_tratamiento), plain);
    context.treatmentsByKey.set(normalizeKey(plain.nombre), plain);
    return { id: Number(plain.id_tratamiento), name: plain.nombre };
  }

  return { id: null, name: mappedName };
}

async function ensurePacienteClinicaLink(patient, clinicId, transaction) {
  if (!PacienteClinica || !patient?.id_paciente || !clinicId) return;
  await PacienteClinica.findOrCreate({
    where: { paciente_id: patient.id_paciente, clinica_id: clinicId },
    defaults: { es_principal: Number(patient.clinica_id || 0) === Number(clinicId) },
    transaction,
  });
}

async function ensureImportedHistoricalAppointment({ patient, clinicId, treatmentId, treatmentName, lastVisit, transaction }) {
  if (!patient?.id_paciente || !clinicId || !treatmentId || !lastVisit) return null;
  const start = new Date(lastVisit);
  if (!Number.isFinite(start.getTime())) return null;
  const end = new Date(start.getTime() + 30 * 60 * 1000);
  const existing = await CitaPaciente.findOne({
    where: {
      paciente_id: patient.id_paciente,
      clinica_id: clinicId,
      tratamiento_id: treatmentId,
      inicio: start,
    },
    attributes: ['id_cita'],
    transaction,
  });
  if (existing) return existing;
  return CitaPaciente.create({
    clinica_id: clinicId,
    paciente_id: patient.id_paciente,
    tratamiento_id: treatmentId,
    titulo: `Histórico: ${treatmentName}`,
    motivo: 'Importación de pacientes para reactivación',
    nota: 'Cita histórica creada automáticamente desde una importación de pacientes para que las condiciones de reactivación puedan evaluarse sobre datos reales.',
    tipo_cita: 'continuacion',
    estado: 'completada',
    inicio: start,
    fin: end,
    es_provisional: false,
  }, { transaction });
}

function inferCustomFieldValueType(value) {
  const text = normalizeText(value);
  if (/^-?\d+([.,]\d+)?$/.test(text)) return 'number';
  if (parseImportDate(text)) return 'date';
  return 'text';
}

async function persistPatientCustomFields({ patient, clinicId, customFields, schema, transaction }) {
  if (!PatientCustomField || !patient?.id_paciente || !clinicId || !customFields || typeof customFields !== 'object') {
    return;
  }
  const schemaByKey = new Map((schema || []).map((field) => [field.key, field]));
  for (const [key, value] of Object.entries(customFields)) {
    const fieldKey = normalizeKey(key);
    const cleanValue = normalizeText(value);
    if (!fieldKey || !cleanValue) continue;
    const schemaField = schemaByKey.get(fieldKey) || {};
    const [row] = await PatientCustomField.findOrCreate({
      where: {
        paciente_id: patient.id_paciente,
        clinica_id: clinicId,
        field_key: fieldKey,
      },
      defaults: {
        label: normalizeText(schemaField.label) || fieldKey.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' '),
        value: cleanValue,
        value_type: normalizeText(schemaField.type) || inferCustomFieldValueType(cleanValue),
        source: 'import',
        source_column: normalizeText(schemaField.source_column || schemaField.sourceColumn) || null,
        last_imported_at: new Date(),
      },
      transaction,
    });
    if (row) {
      await row.update({
        label: normalizeText(schemaField.label) || row.label,
        value: cleanValue,
        value_type: normalizeText(schemaField.type) || inferCustomFieldValueType(cleanValue),
        source: 'import',
        source_column: normalizeText(schemaField.source_column || schemaField.sourceColumn) || row.source_column,
        last_imported_at: new Date(),
      }, { transaction });
    }
  }
}

async function enrichItemsWithPatientCustomFields(itemPayloads, transaction) {
  if (!PatientCustomField || !Array.isArray(itemPayloads) || !itemPayloads.length) return itemPayloads;
  const patientIds = Array.from(new Set(itemPayloads.map((item) => Number(item.paciente_id || 0)).filter(Boolean)));
  if (!patientIds.length) return itemPayloads;
  const rows = await PatientCustomField.findAll({
    where: { paciente_id: { [Op.in]: patientIds } },
    attributes: ['paciente_id', 'field_key', 'value'],
    raw: true,
    transaction,
  });
  const byPatient = new Map();
  for (const row of rows) {
    const patientId = Number(row.paciente_id || 0);
    const key = normalizeKey(row.field_key);
    const value = normalizeText(row.value);
    if (!patientId || !key || !value) continue;
    if (!byPatient.has(patientId)) byPatient.set(patientId, {});
    byPatient.get(patientId)[key] = value;
  }
  return itemPayloads.map((item) => {
    const patientFields = byPatient.get(Number(item.paciente_id || 0)) || {};
    return {
      ...item,
      custom_fields: {
        ...patientFields,
        ...(item.custom_fields || {}),
      },
    };
  });
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
  const treatmentMappings = normalizeTreatmentMappings(body.treatment_mappings || body.treatment_mapping || {});
  const clinicLookup = await loadImportClinicLookup(scope, transaction);
  const importTreatments = await loadImportTreatments(scope, defaultClinicId, transaction);
  const treatmentIndex = indexTreatments(importTreatments);
  const treatmentContext = {
    treatmentMappings,
    treatmentsById: treatmentIndex.byId,
    treatmentsByKey: treatmentIndex.byKey,
    defaultClinicId,
    transaction,
  };
  const existingPatients = await Paciente.findAll({
    where: {
      clinica_id: clinicIds.length ? { [Op.in]: clinicIds } : defaultClinicId,
      telefono_movil: { [Op.ne]: null },
    },
    attributes: ['id_paciente', 'clinica_id', 'nombre', 'apellidos', 'telefono_movil', 'telefono_secundario', 'email'],
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
    const landlineDigits = normalizePhoneDigits(readImportValue(row, columnMapping, 'phone_landline'));
    const formattedLandline = landlineDigits ? `+${landlineDigits}` : null;
    const email = readImportValue(row, columnMapping, 'email') || null;
    const importedClinic = readImportValue(row, columnMapping, 'clinic') || null;
    const importedClinicId = resolveImportedClinicId(importedClinic, clinicLookup);
    const rawTreatment = readImportValue(row, columnMapping, 'treatment') || body.treatment || 'Sin tratamiento asignado';
    const resolvedTreatment = await resolveImportedTreatment(rawTreatment, treatmentContext);
    const treatment = resolvedTreatment.name;
    const treatmentId = resolvedTreatment.id;
    const lastVisit = parseImportDate(readImportValue(row, columnMapping, 'last_visit_at'));
    const customFields = buildCustomFields(row, columnMapping, customFieldsSchema);
    let patient = phoneDigits ? patientByPhone.get(phoneDigits) : null;
    let createdNewPatient = false;
    const validPhone = !!phoneDigits && phoneDigits.length >= 8;
    const patientClinicId = Number(patient?.clinica_id || 0) || null;
    const rowClinicId = patientClinicId
      || importedClinicId
      || (clinicIds.length === 1 ? defaultClinicId : null);
    const clinicAssignmentError = !patientClinicId && clinicIds.length > 1 && !rowClinicId
      ? (importedClinic
        ? `Sede importada no reconocida dentro del grupo: ${importedClinic}.`
        : 'No se ha podido asociar este contacto a una clínica del grupo. Añade una columna sede/clinica o revisa el teléfono/email.')
      : null;

    if (!patient && validPhone && rowClinicId && !clinicAssignmentError) {
      patient = await Paciente.create({
        public_id: await generateUniquePacientePublicId(transaction),
        nombre: splitName.nombre,
        apellidos: splitName.apellidos,
        telefono_movil: formattedPhone,
        telefono_secundario: formattedLandline,
        email,
        clinica_id: rowClinicId,
      }, { transaction });
      patientByPhone.set(phoneDigits, patient);
      createdNewPatient = true;
    }

    if (patient) {
      if (formattedLandline && !patient.telefono_secundario) {
        await patient.update({ telefono_secundario: formattedLandline }, { transaction });
      }
      await ensurePacienteClinicaLink(patient, Number(patient.clinica_id || defaultClinicId), transaction);
      await ensureImportedHistoricalAppointment({
        patient,
        clinicId: Number(patient.clinica_id || defaultClinicId),
        treatmentId,
        treatmentName: treatment,
        lastVisit,
        transaction,
      });
      await persistPatientCustomFields({
        patient,
        clinicId: Number(patient.clinica_id || defaultClinicId),
        customFields,
        schema: customFieldsSchema,
        transaction,
      });
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
    } else if (clinicAssignmentError) {
      status = 'excluded_clinic_unassigned';
      reason = clinicAssignmentError;
      exclusionReason = 'clinica_no_identificada';
      selected = false;
    }
    if (validPhone && !seenPhones.has(phoneDigits)) {
      seenPhones.set(phoneDigits, normalizedFullName);
    }

    itemPayloads.push({
      paciente_id: patient?.id_paciente || null,
      clinica_id: Number(patient?.clinica_id || rowClinicId || defaultClinicId),
      name: normalizedFullName,
      phone: formattedPhone,
      email,
      treatment,
      treatment_id: treatmentId,
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
    treatment_id: candidate.treatmentId || candidate.treatment_id || null,
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

function sanitizeTemplateKey(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120);
}

function buildReactivationAutomationNodes(list, automation, actionMode, template) {
  const criteria = list.criteria || {};
  const actionNodeType = actionMode === 'whatsapp_template'
    ? 'action/send_whatsapp'
    : (actionMode === 'lead_call_list' ? 'action/update_lead_info' : 'action/create_task');
  const wabaTemplateId = Number(
    automation?.whatsapp_template_id
    || automation?.waba_template_id
    || template?.whatsapp_template_id
    || 0
  ) || null;
  const actionConfig = actionMode === 'whatsapp_template'
    ? (wabaTemplateId
      ? {
        message_mode: 'template',
        template_id: wabaTemplateId,
        template_name: automation?.template_name || template?.nombre || null,
        template_usage: template?.uso || automation?.template_usage || 'reactivacion_pacientes',
        template_commercial: isCommercialTemplateUsage(template?.uso || automation?.template_usage || 'reactivacion_pacientes'),
        recipient_mode: 'context_patient',
        sender_mode: 'clinic_default',
        quiet_hours_enabled: true,
        source: 'marketing_reactivation',
      }
      : {
        message_mode: 'manual',
        manual_message_text: template?.contenido || automation?.template_text || 'Mensaje de reactivación pendiente de plantilla WhatsApp aprobada.',
        legacy_message_template_id: template?.id || automation?.template_id || null,
        template_name: template?.nombre || automation?.template_name || null,
        template_usage: template?.uso || automation?.template_usage || 'reactivacion_pacientes',
        template_commercial: isCommercialTemplateUsage(template?.uso || automation?.template_usage || 'reactivacion_pacientes'),
        recipient_mode: 'context_patient',
        sender_mode: 'clinic_default',
        quiet_hours_enabled: true,
        source: 'marketing_reactivation',
        requires_approved_template_before_dispatch: true,
      })
    : (actionMode === 'lead_call_list'
      ? {
        mode: 'set_required',
        info_requerida: ['Llamar al paciente por reactivación'],
        auto_transition: true,
        status_when_waiting: 'esperando_info',
        status_when_complete: 'info_recibida',
        source: 'marketing_reactivation',
        destination: 'leads',
      }
      : {
        title: 'Llamada gestionada por ClinicaClick',
        description: `Gestionar llamada de reactivación para "${list.name}".`,
        assignee_type: 'role',
        assignee_id: 'admin',
        due_date_offset: '1 day',
        source: 'marketing_reactivation',
        destination: 'managed_calls',
      });

  return [
    {
      id: 'N1',
      type: 'trigger/patient_reactivation',
      position: { x: 120, y: 160 },
      config: {
        readonly: true,
        list_id: list.id,
        treatment: list.treatment,
        treatment_id: automation?.treatment_id || criteria.treatment_id || null,
        condition_summary: list.condition_summary,
        criteria,
      },
      outputs: { on_success: 'N2' },
    },
    {
      id: 'N2',
      type: actionNodeType,
      position: { x: 420, y: 160 },
      config: actionConfig,
      outputs: { on_success: null, on_fail: null },
    },
  ];
}

function validateReactivationAutomationContract(payload) {
  const errors = [];
  const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
  const entryNodeId = String(payload?.entry_node_id || '').trim();
  const nodeMap = new Map();
  const allowedNodeTypes = new Set([
    'trigger/patient_reactivation',
    'action/send_whatsapp',
    'action/update_lead_info',
    'action/create_task',
  ]);

  if (payload?.trigger_type !== 'patient_reactivation') {
    errors.push('trigger_type debe ser patient_reactivation');
  }
  if (!entryNodeId) {
    errors.push('entry_node_id es obligatorio');
  }
  if (!nodes.length) {
    errors.push('nodes debe tener al menos un nodo');
  }

  for (const node of nodes) {
    const id = String(node?.id || '').trim();
    const type = String(node?.type || '').trim();
    if (!id || !/^N[0-9]+$/.test(id)) {
      errors.push(`Nodo con id inválido: ${id || '(vacío)'}`);
      continue;
    }
    if (nodeMap.has(id)) {
      errors.push(`Nodo duplicado: ${id}`);
      continue;
    }
    if (!allowedNodeTypes.has(type)) {
      errors.push(`Tipo de nodo no permitido en reactivación: ${type || '(vacío)'}`);
    }
    nodeMap.set(id, node);
  }

  const entryNode = nodeMap.get(entryNodeId);
  if (!entryNode || entryNode.type !== 'trigger/patient_reactivation') {
    errors.push('El nodo de entrada debe ser trigger/patient_reactivation');
  }

  for (const node of nodeMap.values()) {
    const outputs = node?.outputs && typeof node.outputs === 'object' && !Array.isArray(node.outputs)
      ? node.outputs
      : {};
    for (const target of Object.values(outputs)) {
      if (target === null || target === undefined || target === '') continue;
      if (!nodeMap.has(String(target).trim())) {
        errors.push(`El nodo ${node.id} apunta a un destino inexistente: ${target}`);
      }
    }

    const config = node?.config && typeof node.config === 'object' && !Array.isArray(node.config)
      ? node.config
      : {};
    if (node.type === 'action/send_whatsapp') {
      const messageMode = normalizeKey(config.message_mode || 'template');
      if (!['template', 'manual'].includes(messageMode)) {
        errors.push('send_whatsapp requiere message_mode template o manual');
      }
      if (messageMode === 'template' && !config.template_id) {
        errors.push('send_whatsapp con template requiere template_id');
      }
      if (messageMode === 'manual' && !normalizeText(config.manual_message_text)) {
        errors.push('send_whatsapp manual requiere manual_message_text');
      }
      const recipientMode = normalizeKey(config.recipient_mode || 'context_patient');
      if (!['context_patient', 'context_lead', 'manual_number'].includes(recipientMode)) {
        errors.push('send_whatsapp requiere recipient_mode válido');
      }
      const senderMode = normalizeKey(config.sender_mode || 'clinic_default');
      if (!['clinic_default', 'specific_origin'].includes(senderMode)) {
        errors.push('send_whatsapp requiere sender_mode válido');
      }
      if (senderMode === 'specific_origin' && !config.sender_origin_id) {
        errors.push('send_whatsapp con specific_origin requiere sender_origin_id');
      }
    }
    if (node.type === 'action/update_lead_info') {
      const mode = normalizeKey(config.mode || 'set_required');
      const info = Array.isArray(config.info_requerida)
        ? config.info_requerida.filter((item) => normalizeText(item))
        : [];
      if (!['set_required', 'set_received', 'append_received', 'clear_required', 'clear_received', 'clear_all'].includes(mode)) {
        errors.push('update_lead_info requiere mode válido');
      }
      if (mode === 'set_required' && !info.length) {
        errors.push('update_lead_info set_required requiere info_requerida');
      }
    }
    if (node.type === 'action/create_task') {
      const assigneeType = normalizeKey(config.assignee_type);
      if (!['user', 'role'].includes(assigneeType)) {
        errors.push('create_task requiere assignee_type user o role');
      }
      if (!normalizeText(config.assignee_id)) {
        errors.push('create_task requiere assignee_id');
      }
      if (!normalizeText(config.title)) {
        errors.push('create_task requiere title');
      }
    }
  }

  if (errors.length) {
    const err = new Error('La automatización de reactivación no cumple el contrato V2');
    err.status = 400;
    err.details = errors;
    throw err;
  }
}

async function upsertReactivationAutomationTemplate({ list, automation, actionMode, template, userId }) {
  if (!AutomationFlowTemplateV2 || !automation?.active) {
    return automation || null;
  }

  const templateKey = sanitizeTemplateKey(
    automation.template_key || `reactivacion_lista_${list.id}`
  );
  const nodes = buildReactivationAutomationNodes(list, automation, actionMode, template);
  const payload = {
    engine_version: 'v2',
    name: automation.name || `Automatización · ${list.name}`,
    description: `Automatización de solo lectura creada desde la reactivación "${list.name}".`,
    trigger_type: 'patient_reactivation',
    trigger_config: {
      list_id: list.id,
      treatment: list.treatment,
      treatment_id: automation.treatment_id || list.criteria?.treatment_id || null,
      readonly: true,
    },
    is_active: true,
    is_system: false,
    clinic_id: list.clinica_id || null,
    group_id: list.grupo_clinica_id || null,
    entry_node_id: 'N1',
    nodes,
    published_at: new Date(),
    published_by: userId || null,
  };
  validateReactivationAutomationContract({
    trigger_type: payload.trigger_type,
    entry_node_id: payload.entry_node_id,
    nodes: payload.nodes,
  });

  const existing = await AutomationFlowTemplateV2.findOne({
    where: { template_key: templateKey },
    order: [['version', 'DESC']],
  });

  const row = existing
    ? await existing.update(payload)
    : await AutomationFlowTemplateV2.create({
      public_id: `flw_${crypto.randomBytes(8).toString('hex')}`,
      template_key: templateKey,
      version: 1,
      created_by: userId || 1,
      ...payload,
    });

  return {
    ...automation,
    active: true,
    readonly: true,
    id: row.id,
    template_key: row.template_key,
    template_version: row.version,
    trigger_type: 'patient_reactivation',
  };
}

async function deactivateReactivationAutomationTemplate(automation) {
  if (!AutomationFlowTemplateV2 || !automation?.template_key) {
    return;
  }
  await AutomationFlowTemplateV2.update(
    { is_active: false },
    { where: { template_key: automation.template_key, trigger_type: 'patient_reactivation' } }
  );
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
    treatment_id: plain.treatment_id || null,
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
    let itemPayloads = importResult
      ? importResult.itemPayloads
      : (customPayloads || (suggestion ? suggestion.candidates_full.map(mapSuggestionCandidateToItem) : []));
    itemPayloads = await enrichItemsWithPatientCustomFields(itemPayloads, transaction);
    itemPayloads = await applyMarketingOptOutExclusions(itemPayloads, scope, transaction);
    const counters = computeCounters(itemPayloads);
    const actionMode = body.action_mode || suggestion?.recommendedMode || 'whatsapp_template';
    const semanticName = buildSemanticReactivationListName({ source, body, suggestion, itemPayloads });
    const listName = shouldUseSemanticReactivationName(body.name)
      ? semanticName
      : normalizeText(body.name);
    const conditionSummary = normalizeText(body.condition_summary || suggestion?.condition)
      || (source === 'import' ? 'Pacientes importados con tratamiento y fecha de tratamiento informada.' : null);
    const list = await MarketingPatientList.create({
      name: listName || suggestion?.title || 'Lista de reactivación',
      objective_id: 'reactivate_patients',
      source: source === 'custom' ? 'manual_list' : (source === 'import' ? 'imported_file' : source),
      status: 'draft',
      ...scopePayload,
      treatment: body.treatment || suggestion?.treatment || itemPayloads[0]?.treatment || null,
      condition_summary: conditionSummary,
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
        treatment_mappings: body.treatment_mappings || body.treatment_mapping || null,
        rules: body.rules || [],
        exclusions: body.exclusions || [],
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

async function updateList(scope, listId, body = {}, userId = null) {
  const list = await MarketingPatientList.findByPk(listId);
  ensureScopeAccess(list, scope);

  if (list.source !== 'manual_list') {
    const err = new Error('Solo se pueden editar condiciones creadas por la clínica');
    err.status = 400;
    throw err;
  }
  if (['completed', 'cancelled'].includes(String(list.status || '').toLowerCase())) {
    const err = new Error('No se puede editar una reactivación ya cerrada');
    err.status = 409;
    throw err;
  }

  const sentCount = await MarketingPatientListItem.count({
    where: {
      list_id: list.id,
      dispatch_status: { [Op.in]: ['sent', 'delivered', 'read', 'replied'] },
    },
  });
  if (sentCount > 0) {
    const err = new Error('No se pueden editar condiciones de una lista con envíos registrados');
    err.status = 409;
    throw err;
  }

  let previewPayloads = [];
  await db.sequelize.transaction(async (transaction) => {
    let itemPayloads = await buildCustomItemPayloads(scope, body);
    itemPayloads = await enrichItemsWithPatientCustomFields(itemPayloads, transaction);
    itemPayloads = await applyMarketingOptOutExclusions(itemPayloads, scope, transaction);
    const counters = computeCounters(itemPayloads);
    previewPayloads = itemPayloads.slice(0, 5).map((item, index) => ({ ...item, id: index + 1, list_id: list.id }));
    const conditionSummary = normalizeText(body.condition_summary) || list.condition_summary;
    const exclusionSummary = normalizeText(body.exclusion_summary) || list.exclusion_summary;
    const treatmentName = normalizeText(body.treatment || body.treatmentName || list.treatment);
    const treatmentId = body.treatment_id || body.treatmentId || list.criteria?.treatment_id || null;
    const listName = normalizeText(body.name) || list.name;

    await MarketingPatientListItem.destroy({ where: { list_id: list.id }, transaction });
    if (itemPayloads.length) {
      await MarketingPatientListItem.bulkCreate(
        itemPayloads.map((item) => ({ ...item, list_id: list.id })),
        { transaction }
      );
    }

    await list.update({
      name: listName,
      treatment: treatmentName || null,
      condition_summary: conditionSummary,
      exclusion_summary: exclusionSummary,
      criteria: {
        ...(list.criteria || {}),
        source: 'custom',
        treatment_id: treatmentId,
        rules: Array.isArray(body.rules) ? body.rules : [],
        exclusions: Array.isArray(body.exclusions) ? body.exclusions : [],
      },
      counters,
      safety_gates: {
        ...(list.safety_gates || {}),
        frozen_audience: counters.total > 0,
      },
    }, { transaction });

    await MarketingPatientContactEvent.create({
      list_id: list.id,
      event_type: 'list_conditions_updated',
      channel: list.channel,
      payload: {
        user_id: userId || null,
        name: listName,
        condition_summary: conditionSummary,
        exclusion_summary: exclusionSummary,
        counters,
      },
      occurred_at: new Date(),
    }, { transaction });
  });

  const reloaded = await MarketingPatientList.findByPk(list.id);
  if (reloaded?.automation?.active) {
    const { template } = await snapshotTemplate(reloaded.template_id || null);
    const automationSnapshot = await upsertReactivationAutomationTemplate({
      list: reloaded.get({ plain: true }),
      automation: reloaded.automation,
      actionMode: reloaded.action_mode || 'whatsapp_template',
      template,
      userId,
    });
    await reloaded.update({ automation: automationSnapshot });
  }

  const finalList = await MarketingPatientList.findByPk(list.id);
  return {
    success: true,
    list: serializeList(finalList, { itemsPreview: previewPayloads }),
  };
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

async function updateItem(scope, listId, itemId, body = {}, userId = null) {
  const list = await MarketingPatientList.findByPk(listId);
  ensureScopeAccess(list, scope);

  const item = await MarketingPatientListItem.findOne({
    where: {
      id: itemId,
      list_id: list.id,
    },
  });
  if (!item) {
    const err = new Error('Paciente de la lista no encontrado');
    err.status = 404;
    throw err;
  }

  const action = String(body.action || body.status || '').toLowerCase();
  const excluding = action === 'exclude' || action === 'excluded' || action === 'excluded_manual';
  const restoring = action === 'restore' || action === 'ready' || action === 'include';
  if (!excluding && !restoring) {
    const err = new Error('Acción no válida. Usa exclude o restore.');
    err.status = 400;
    throw err;
  }

  const nextStatus = excluding ? 'excluded_manual' : 'ready';
  const nextReason = excluding
    ? (body.reason || 'Excluido manualmente por la clínica')
    : (body.reason || 'Incluido manualmente por la clínica');

  await db.sequelize.transaction(async (transaction) => {
    await item.update({
      status: nextStatus,
      selected: !excluding,
      exclusion_reason: excluding ? 'manual' : null,
      reason: nextReason,
      notes: body.notes || item.notes || null,
    }, { transaction });

    const allItems = await MarketingPatientListItem.findAll({
      where: { list_id: list.id },
      transaction,
    });
    const counters = computeCounters(allItems.map((row) => row.get({ plain: true })));
    await list.update({
      counters,
      safety_gates: {
        ...(list.safety_gates || {}),
        frozen_audience: counters.total > 0,
      },
    }, { transaction });

    await MarketingPatientContactEvent.create({
      list_id: list.id,
      item_id: item.id,
      event_type: excluding ? 'item_excluded_manual' : 'item_restored_manual',
      channel: list.channel,
      payload: {
        action: excluding ? 'exclude' : 'restore',
        reason: nextReason,
        user_id: userId || null,
      },
      occurred_at: new Date(),
    }, { transaction });
  });

  const updated = await MarketingPatientListItem.findByPk(item.id);
  const reloaded = await MarketingPatientList.findByPk(list.id);
  const previewItems = await MarketingPatientListItem.findAll({
    where: { list_id: list.id },
    order: [['id', 'ASC']],
    limit: 5,
  });
  return {
    success: true,
    item: serializeItem(updated),
    list: serializeList(reloaded, { itemsPreview: previewItems }),
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
  const automationPayload = Object.prototype.hasOwnProperty.call(body, 'automation')
    ? (body.automation && typeof body.automation === 'object' ? body.automation : null)
    : list.automation;
  const automationSnapshot = automationPayload
    ? await upsertReactivationAutomationTemplate({ list, automation: automationPayload, actionMode, template, userId })
    : null;
  if (!automationPayload) {
    await deactivateReactivationAutomationTemplate(list.automation);
  }

  await list.update({
    status: 'prepared',
    action_mode: actionMode,
    channel: actionModeToChannel(actionMode),
    template_id: template?.id || null,
    template_snapshot: snapshot,
    counters,
    automation: automationSnapshot,
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
      automation_requested: !!automationSnapshot,
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

  let previewPayloads = [];
  await db.sequelize.transaction(async (transaction) => {
    let itemPayloads = await enrichItemsWithPatientCustomFields(
      suggestion.candidates_full.map(mapSuggestionCandidateToItem),
      transaction
    );
    itemPayloads = await applyMarketingOptOutExclusions(itemPayloads, scope, transaction);
    previewPayloads = itemPayloads.slice(0, 5).map((item, index) => ({ ...item, id: index + 1, list_id: list.id }));
    const counters = computeCounters(itemPayloads);
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
    list: serializeList(reloaded, { itemsPreview: previewPayloads }),
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
  updateList,
  getList,
  getItems,
  updateItem,
  prepareList,
  scheduleList,
  removeList,
  rebuildList,
  getEvents,
};
