'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const { normalizePhoneDigits } = require('../lib/phone');

const {
  CitaPaciente,
  MarketingPatientContactEvent,
  MarketingPatientList,
  MarketingPatientListItem,
  MessageTemplate,
  Paciente,
  Tratamiento,
} = db;

const CANCELLED_STATES = new Set(['cancelada', 'no_asistio']);
const REQUIRED_SEND_GATES = ['frozen_audience', 'opt_out', 'capping', 'approved_template', 'audit', 'cancelable_queue'];

function toDateMonthsAgo(months) {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date;
}

function normalizeText(value) {
  return String(value || '').trim();
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

function getRevenueLabel(treatmentName) {
  const normalized = normalizeText(treatmentName).toLowerCase();
  if (normalized.includes('implante')) return 'Tratamiento de alto valor';
  if (normalized.includes('ortodon')) return 'Alta probabilidad de revisión';
  if (normalized.includes('capilar')) return 'Seguimiento preventivo';
  return 'Seguimiento recurrente';
}

function slugSuggestionId(treatmentName, thresholdMonths) {
  const slug = normalizeText(treatmentName)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
  return `auto_${slug || 'sin_tratamiento'}_${thresholdMonths}m`;
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

  const pastAppointments = await CitaPaciente.findAll({
    where: {
      clinica_id: clinicIds.length === 1 ? clinicIds[0] : { [Op.in]: clinicIds },
      inicio: { [Op.lt]: now },
      estado: { [Op.notIn]: Array.from(CANCELLED_STATES) },
    },
    attributes: ['id_cita', 'clinica_id', 'paciente_id', 'tratamiento_id', 'estado', 'inicio'],
    include: [
      { model: Paciente, as: 'paciente', attributes: ['id_paciente', 'nombre', 'apellidos', 'telefono_movil', 'email'] },
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

  const latestByPatientTreatment = new Map();
  for (const appointment of pastAppointments) {
    const treatmentName = normalizeText(appointment.tratamiento?.nombre) || 'Sin tratamiento asignado';
    const patientId = Number(appointment.paciente_id || appointment.paciente?.id_paciente || 0);
    if (!patientId) continue;
    const key = `${patientId}:${treatmentName.toLowerCase()}`;
    if (latestByPatientTreatment.has(key)) continue;
    latestByPatientTreatment.set(key, { appointment, treatmentName, patientId });
  }

  const groups = new Map();
  for (const item of latestByPatientTreatment.values()) {
    const { appointment, treatmentName, patientId } = item;
    const thresholdMonths = getThresholdMonths(treatmentName);
    const cutoff = toDateMonthsAgo(thresholdMonths);
    const lastDate = new Date(appointment.inicio);
    if (!(lastDate < cutoff)) continue;

    const phone = normalizePhoneDigits(appointment.paciente?.telefono_movil || '');
    const hasFutureAppointment = futurePatientIds.has(patientId);
    const validPhone = phone && phone.length >= 8;
    const status = hasFutureAppointment
      ? 'excluded_future_appointment'
      : (!validPhone ? 'excluded_invalid_phone' : 'ready');

    if (!groups.has(treatmentName)) {
      groups.set(treatmentName, {
        treatmentName,
        thresholdMonths,
        candidates: [],
      });
    }

    groups.get(treatmentName).candidates.push({
      patient_id: patientId,
      clinic_id: Number(appointment.clinica_id || 0) || null,
      name: [appointment.paciente?.nombre, appointment.paciente?.apellidos].filter(Boolean).join(' ').trim() || 'Paciente sin nombre',
      phone: phone ? `+${phone}` : '',
      email: appointment.paciente?.email || null,
      treatment: treatmentName,
      last_visit_at: lastDate.toISOString(),
      status,
      exclusion_reason: status === 'excluded_future_appointment'
        ? 'cita_futura'
        : (status === 'excluded_invalid_phone' ? 'telefono_invalido' : null),
      reason: status === 'ready'
        ? 'Sin cita futura y teléfono válido'
        : (status === 'excluded_future_appointment' ? 'Tiene cita futura' : 'Teléfono no válido'),
    });
  }

  return Array.from(groups.values());
}

function buildSuggestionFromGroup(group) {
  const eligible = group.candidates.filter((candidate) => candidate.status === 'ready').length;
  const excluded = group.candidates.length - eligible;
  const id = slugSuggestionId(group.treatmentName, group.thresholdMonths);
  return {
    id,
    title: `${group.treatmentName} sin visita reciente`,
    subtitle: `Pacientes de ${group.treatmentName} sin cita futura detectada.`,
    treatment: group.treatmentName,
    condition: `Última cita hace más de ${group.thresholdMonths} meses, sin cita programada y con teléfono válido.`,
    candidates: group.candidates.length,
    eligible,
    excluded,
    exclusionSummary: excluded ? `${excluded} excluidos por cita futura o teléfono no válido.` : 'Sin exclusiones detectadas.',
    recommendedMode: getRecommendedMode(group.treatmentName),
    priority: getPriority({ eligible, thresholdMonths: group.thresholdMonths }),
    estimatedRevenueLabel: getRevenueLabel(group.treatmentName),
    source: 'catalog',
    thresholdMonths: group.thresholdMonths,
    candidates_preview: group.candidates.slice(0, 5),
    candidates_full: group.candidates,
  };
}

async function getSuggestions(scope, options = {}) {
  const groups = await collectSuggestionGroups(scope, options);
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
  const groups = await collectSuggestionGroups(scope);
  return groups
    .map(buildSuggestionFromGroup)
    .find((suggestion) => suggestion.id === suggestionId) || null;
}

function computeCounters(items) {
  const total = items.length;
  const ready = items.filter((item) => item.status === 'ready').length;
  const excluded = items.filter((item) => String(item.status || '').startsWith('excluded')).length;
  const lead = items.filter((item) => item.status === 'lead').length;
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

  const itemPayloads = suggestion
    ? suggestion.candidates_full.map(mapSuggestionCandidateToItem)
    : [];
  const counters = computeCounters(itemPayloads);
  const scopePayload = serializeScope(scope);

  return db.sequelize.transaction(async (transaction) => {
    const list = await MarketingPatientList.create({
      name: body.name || suggestion?.title || 'Lista de reactivación',
      objective_id: 'reactivate_patients',
      source: source === 'custom' ? 'manual_list' : source,
      status: 'draft',
      ...scopePayload,
      treatment: body.treatment || suggestion?.treatment || null,
      condition_summary: body.condition_summary || suggestion?.condition || null,
      exclusion_summary: body.exclusion_summary || suggestion?.exclusionSummary || null,
      criteria: {
        suggestion_id: suggestion?.id || null,
        threshold_months: suggestion?.thresholdMonths || body.threshold_months || null,
        source,
        rules: body.rules || [],
      },
      action_mode: body.action_mode || suggestion?.recommendedMode || 'whatsapp_template',
      channel: actionModeToChannel(body.action_mode || suggestion?.recommendedMode || 'whatsapp_template'),
      counters,
      metrics: {
        estimated_revenue: 0,
        total_cost: 0,
      },
      automation: body.automation || null,
      safety_gates: {
        frozen_audience: counters.total > 0,
        opt_out: false,
        capping: false,
        approved_template: false,
        audit: true,
        cancelable_queue: false,
      },
      custom_fields_schema: body.custom_fields_schema || [],
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
  rebuildList,
  getEvents,
};
