'use strict';

const db = require('../../models');
const jobRequestsService = require('./jobRequests.service');
const jobScheduler = require('./jobScheduler.service');

const Tratamiento = db.Tratamiento;
const Clinica = db.Clinica;
const AutomationFlowTemplateV2 = db.AutomationFlowTemplateV2;
const FlowExecutionV2 = db.FlowExecutionV2;
const FlowExecutionLogV2 = db.FlowExecutionLogV2;
const JobRequest = db.JobRequest;
const { getIO } = require('./socket.service');
const { Op } = db.Sequelize;
const DEFAULT_TIMEZONE = 'Europe/Madrid';

const APPOINTMENT_TRIGGER_TYPES = new Set([
  'appointment_created',
  'appointment_reminder_window',
  'appointment_after',
  'appointment_confirmed',
  'appointment_no_show',
  'appointment_rescheduled',
  'appointment_cancelled',
  'appointment_completed',
]);
const APPOINTMENT_CREATED_SCOPE_VALUES = new Set([
  'all',
  'with_treatment',
  'without_treatment',
]);
const APPOINTMENT_CREATED_WITHOUT_TREATMENT_TYPES = new Set([
  'any',
  'primera_sin_trat',
  'urgencia',
  'revision',
]);
const APPOINTMENT_CREATED_DAY_PROXIMITY_FILTER_VALUES = new Set([
  'all',
  'exclude_day_before',
  'exclude_same_day',
  'exclude_same_day_and_day_before',
]);
const SCHEDULED_APPOINTMENT_TRIGGER_TYPES = new Set([
  'appointment_reminder_window',
  'appointment_after',
]);
const APPOINTMENT_BEFORE_MOMENT_VALUES = new Set([
  'same_day',
  'day_before',
  'week_before',
]);
const APPOINTMENT_BEFORE_TIME_MODE_VALUES = new Set([
  'custom',
  'one_hour_before',
]);
const APPOINTMENT_AFTER_MOMENT_VALUES = new Set([
  'same_day',
  'day_after',
  'week_after',
]);
const APPOINTMENT_AFTER_TIME_MODE_VALUES = new Set([
  'custom',
  'one_hour_after',
]);
const ACTIVE_APPOINTMENT_STATUSES = new Set([
  'pendiente',
  'info_enviada',
  'info_confirmada',
  'recordatorio_enviado',
  'recordatorio_confirmado',
  'reprogramada',
]);

function toIntOrNull(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanString(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function normalizeAppointmentCreatedDayProximityFilter(value, legacyMinHours) {
  const normalized = cleanString(value).toLowerCase();
  if (APPOINTMENT_CREATED_DAY_PROXIMITY_FILTER_VALUES.has(normalized)) {
    return normalized;
  }
  const parsedLegacyHours = Number(legacyMinHours);
  if (Number.isFinite(parsedLegacyHours) && parsedLegacyHours >= 24) {
    return 'exclude_same_day_and_day_before';
  }
  if (Number.isFinite(parsedLegacyHours) && parsedLegacyHours > 0) {
    return 'exclude_same_day';
  }
  return 'all';
}

function parseClinicConfig(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (err) {
      return null;
    }
  }
  return null;
}

function isValidTimeZone(value) {
  if (!value || typeof value !== 'string') return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch (err) {
    return false;
  }
}

function resolveClinicTimezone(clinica) {
  const cfg = parseClinicConfig(clinica && clinica.configuracion);
  const candidates = [
    cfg && (cfg.timezone || cfg.timeZone || cfg.tz),
    clinica && (clinica.timezone || clinica.time_zone || clinica.tz),
  ];

  for (const candidate of candidates) {
    if (isValidTimeZone(candidate)) return candidate;
  }
  return DEFAULT_TIMEZONE;
}

function formatPartsInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const bag = {};
  parts.forEach((p) => {
    if (p.type !== 'literal') bag[p.type] = p.value;
  });

  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour),
    minute: Number(bag.minute),
    second: Number(bag.second),
  };
}

function offsetMinutesForTimeZone(date, timeZone) {
  const p = formatPartsInTimeZone(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

function normalizeHms(value, fallback = '00:00:00') {
  const raw = String(value || fallback).trim();
  const match = raw.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!match) return null;
  return `${match[1]}:${match[2]}:${match[3] || '00'}`;
}

function localDateTimeToUtc(fechaLocal, timeValue, timeZone) {
  if (!fechaLocal || typeof fechaLocal !== 'string') return null;
  const d = fechaLocal.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!d) return null;

  const hms = normalizeHms(timeValue);
  if (!hms) return null;
  const t = hms.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!t) return null;

  const year = Number(d[1]);
  const month = Number(d[2]);
  const day = Number(d[3]);
  const hour = Number(t[1]);
  const minute = Number(t[2]);
  const second = Number(t[3]);

  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let ts = naiveUtc;
  for (let i = 0; i < 2; i += 1) {
    const offsetMin = offsetMinutesForTimeZone(new Date(ts), timeZone);
    ts = naiveUtc - offsetMin * 60000;
  }
  return new Date(ts);
}

function formatDateLocal(date, timeZone) {
  const p = formatPartsInTimeZone(date, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

function addDaysToLocalDate(fechaLocal, deltaDays) {
  const match = String(fechaLocal || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const utc = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  utc.setUTCDate(utc.getUTCDate() + Number(deltaDays || 0));
  const pad = (n) => String(n).padStart(2, '0');
  return `${utc.getUTCFullYear()}-${pad(utc.getUTCMonth() + 1)}-${pad(utc.getUTCDate())}`;
}

function normalizeScheduledDate(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return null;
  const normalized = new Date(date.getTime());
  normalized.setMilliseconds(0);
  return normalized;
}

function normalizeEventName(eventName) {
  const normalized = cleanString(eventName).toLowerCase();
  return APPOINTMENT_TRIGGER_TYPES.has(normalized) ? normalized : null;
}

function mapEstadoToEvent(estado) {
  const normalized = cleanString(estado).toLowerCase();
  if (normalized === 'info_enviada') return 'appointment_created';
  if (normalized === 'info_confirmada') return 'appointment_confirmed';
  if (normalized === 'recordatorio_confirmado') return 'appointment_confirmed';
  if (normalized === 'reprogramada') return 'appointment_rescheduled';
  if (normalized === 'no_asistio') return 'appointment_no_show';
  if (normalized === 'cancelada') return 'appointment_cancelled';
  if (normalized === 'completada') return 'appointment_completed';
  return null;
}

function buildIdempotencyKey({ triggerType, citaId, templateVersionId, windowIdentifier }) {
  const parts = [
    cleanString(triggerType) || 'appointment_created',
    cleanString(citaId) || '0',
    cleanString(templateVersionId) || '0',
  ];
  const windowId = cleanString(windowIdentifier);
  if (windowId) parts.push(windowId);
  return parts.join(':');
}

function pickPreferredExecution(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  const active = rows.find((row) => ['running', 'waiting', 'paused'].includes(cleanString(row.status)));
  return active || rows[0];
}

async function resolveTemplateForCitaEvent(cita, eventName) {
  const boundTemplate = await resolveTemplateBoundToTratamiento(cita, eventName);
  if (boundTemplate) {
    return boundTemplate;
  }

  return resolveClinicFallbackTemplate(cita, eventName);
}

async function resolveTemplateBoundToTratamiento(cita, eventName) {
  const tratamientoId = toIntOrNull(cita?.tratamiento_id);
  if (!tratamientoId) return null;

  const tratamiento = await Tratamiento.findByPk(tratamientoId, {
    attributes: [
      'id_tratamiento',
      'appointment_automation_template_key',
    ],
  });
  if (!tratamiento) return null;

  const templateKey = cleanString(tratamiento.appointment_automation_template_key);
  if (!templateKey) return null;

  const where = {
    template_key: templateKey,
    published_at: { [db.Sequelize.Op.ne]: null },
    is_active: true,
    trigger_type: eventName,
  };

  const template = await AutomationFlowTemplateV2.findOne({
    where,
    order: [['version', 'DESC']],
  });
  if (!template) return null;

  if (eventName === 'appointment_created') {
    const triggerConfig = getTemplateTriggerConfig(template);
    const clinic = cita?.clinica_id
      ? await Clinica.findByPk(cita.clinica_id, { attributes: ['id_clinica', 'configuracion'], raw: true })
      : null;
    const timeZone = resolveClinicTimezone(clinic);
    if (triggerConfig?.appointment_scope === 'without_treatment') {
      return null;
    }
    if (!isAppointmentCreatedTemplateEligibleForCita(triggerConfig, cita, timeZone)) {
      return null;
    }
  }

  return template;
}

function isAppointmentCreatedTemplateEligibleForCita(triggerConfig, cita, timeZone = DEFAULT_TIMEZONE) {
  const dayProximityFilter = normalizeAppointmentCreatedDayProximityFilter(
    triggerConfig?.day_proximity_filter,
    triggerConfig?.min_hours_before_start,
  );
  if (dayProximityFilter === 'all') return true;

  const start = cita?.inicio ? new Date(cita.inicio) : null;
  if (!start || !Number.isFinite(start.getTime())) {
    return false;
  }

  const appointmentDateLocal = formatDateLocal(start, timeZone);
  const todayLocal = formatDateLocal(new Date(), timeZone);
  if (!appointmentDateLocal || !todayLocal) {
    return false;
  }

  const isSameDay = appointmentDateLocal === todayLocal;
  const isDayBefore = appointmentDateLocal === addDaysToLocalDate(todayLocal, 1);

  if (dayProximityFilter === 'exclude_same_day') {
    return !isSameDay;
  }
  if (dayProximityFilter === 'exclude_day_before') {
    return !isDayBefore;
  }
  if (dayProximityFilter === 'exclude_same_day_and_day_before') {
    return !isSameDay && !isDayBefore;
  }
  return true;
}

function normalizeAppointmentCreatedTriggerConfig(rawConfig) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const appointmentScope = cleanString(config.appointment_scope || 'all').toLowerCase() || 'all';
  const safeScope = APPOINTMENT_CREATED_SCOPE_VALUES.has(appointmentScope) ? appointmentScope : 'all';
  let appointmentTypeWithoutTreatment =
    cleanString(config.appointment_type_without_treatment || 'any').toLowerCase() || 'any';
  if (!APPOINTMENT_CREATED_WITHOUT_TREATMENT_TYPES.has(appointmentTypeWithoutTreatment)) {
    appointmentTypeWithoutTreatment = 'any';
  }
  if (safeScope !== 'without_treatment') {
    appointmentTypeWithoutTreatment = 'any';
  }
  const dayProximityFilter = normalizeAppointmentCreatedDayProximityFilter(
    config.day_proximity_filter,
    config.min_hours_before_start,
  );
  return {
    appointment_scope: safeScope,
    appointment_type_without_treatment: appointmentTypeWithoutTreatment,
    day_proximity_filter: dayProximityFilter,
  };
}

function normalizeAppointmentBeforeTriggerConfig(rawConfig) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const scheduleMoment = cleanString(config.schedule_moment || 'day_before').toLowerCase() || 'day_before';
  const safeMoment = APPOINTMENT_BEFORE_MOMENT_VALUES.has(scheduleMoment) ? scheduleMoment : 'day_before';
  const scheduleTimeMode = cleanString(config.schedule_time_mode || 'custom').toLowerCase() || 'custom';
  const safeTimeMode = APPOINTMENT_BEFORE_TIME_MODE_VALUES.has(scheduleTimeMode) ? scheduleTimeMode : 'custom';
  const customTime = safeTimeMode === 'custom' && /^\d{2}:\d{2}$/.test(cleanString(config.custom_time))
    ? cleanString(config.custom_time)
    : (safeTimeMode === 'custom' ? '09:00' : null);
  return {
    schedule_moment: safeMoment,
    schedule_time_mode: safeTimeMode,
    custom_time: customTime,
  };
}

function normalizeAppointmentAfterTriggerConfig(rawConfig) {
  const config = rawConfig && typeof rawConfig === 'object' ? rawConfig : {};
  const scheduleMoment = cleanString(config.schedule_moment || 'day_after').toLowerCase() || 'day_after';
  const safeMoment = APPOINTMENT_AFTER_MOMENT_VALUES.has(scheduleMoment) ? scheduleMoment : 'day_after';
  const scheduleTimeMode = cleanString(config.schedule_time_mode || 'custom').toLowerCase() || 'custom';
  const safeTimeMode = APPOINTMENT_AFTER_TIME_MODE_VALUES.has(scheduleTimeMode) ? scheduleTimeMode : 'custom';
  const customTime = safeTimeMode === 'custom' && /^\d{2}:\d{2}$/.test(cleanString(config.custom_time))
    ? cleanString(config.custom_time)
    : (safeTimeMode === 'custom' ? '09:00' : null);
  return {
    schedule_moment: safeMoment,
    schedule_time_mode: safeTimeMode,
    custom_time: customTime,
  };
}

function getTemplateTriggerConfig(template) {
  const rawConfig =
    (template && typeof template.trigger_config === 'object' && template.trigger_config)
      ? template.trigger_config
      : null;
  const nodes = Array.isArray(template?.nodes) ? template.nodes : [];
  const entryNodeId = cleanString(template?.entry_node_id);
  const entryNode = nodes.find((node) => cleanString(node?.id) === entryNodeId);

  if (cleanString(template?.trigger_type) !== 'appointment_created') {
    const triggerType = cleanString(template?.trigger_type);
    if (triggerType === 'appointment_reminder_window') {
      return normalizeAppointmentBeforeTriggerConfig(rawConfig || entryNode?.config);
    }
    if (triggerType === 'appointment_after') {
      return normalizeAppointmentAfterTriggerConfig(rawConfig || entryNode?.config);
    }
    return null;
  }

  if (rawConfig) {
    return normalizeAppointmentCreatedTriggerConfig(rawConfig);
  }
  return normalizeAppointmentCreatedTriggerConfig(entryNode?.config);
}

async function resolveClinicFallbackTemplate(cita, eventName) {
  const clinicId = toIntOrNull(cita?.clinica_id);
  if (!clinicId) return null;

  const clinic = await Clinica.findByPk(clinicId, {
    attributes: ['id_clinica', 'grupoClinicaId'],
    raw: true,
  });
  const groupId = toIntOrNull(clinic?.grupoClinicaId);
  const timeZone = resolveClinicTimezone(clinic);

  const candidates = await AutomationFlowTemplateV2.findAll({
    where: {
      trigger_type: eventName,
      is_active: true,
      published_at: { [db.Sequelize.Op.ne]: null },
      [db.Sequelize.Op.or]: [
        { clinic_id: clinicId },
        ...(groupId ? [{ group_id: groupId }] : []),
        { is_system: true },
      ],
    },
    order: [
      ['published_at', 'DESC'],
      ['version', 'DESC'],
      ['id', 'DESC'],
    ],
  });

  if (!Array.isArray(candidates) || !candidates.length) {
    return null;
  }

  const citaHasTreatment = !!toIntOrNull(cita?.tratamiento_id);
  const citaTipo = cleanString(cita?.tipo_cita).toLowerCase() || 'continuacion';

  const scored = candidates
    .filter((template) => {
      if (cleanString(template?.trigger_type) !== 'appointment_created') {
        return true;
      }

      const triggerConfig = getTemplateTriggerConfig(template);
      if (!isAppointmentCreatedTemplateEligibleForCita(triggerConfig, cita, timeZone)) {
        return false;
      }
      const scope = triggerConfig?.appointment_scope || 'all';

      if (citaHasTreatment) {
        return scope === 'all' || scope === 'with_treatment';
      }

      if (scope === 'with_treatment') {
        return false;
      }
      if (scope === 'all') {
        return true;
      }
      const appointmentType = triggerConfig?.appointment_type_without_treatment || 'any';
      return appointmentType === 'any' || appointmentType === citaTipo;
    })
    .map((template) => {
      let score = 0;
      const templateClinicId = toIntOrNull(template?.clinic_id);
      const templateGroupId = toIntOrNull(template?.group_id);

      if (templateClinicId && templateClinicId === clinicId) score += 100;
      else if (templateGroupId && groupId && templateGroupId === groupId) score += 50;
      else if (template?.is_system) score += 10;

      if (cleanString(template?.trigger_type) === 'appointment_created') {
        const triggerConfig = getTemplateTriggerConfig(template);
        const scope = triggerConfig?.appointment_scope || 'all';
        const appointmentType = triggerConfig?.appointment_type_without_treatment || 'any';
        const dayProximityFilter = normalizeAppointmentCreatedDayProximityFilter(
          triggerConfig?.day_proximity_filter,
          triggerConfig?.min_hours_before_start,
        );

        if (citaHasTreatment) {
          if (scope === 'with_treatment') score += 20;
          else if (scope === 'all') score += 5;
        } else {
          if (scope === 'without_treatment' && appointmentType === citaTipo) score += 30;
          else if (scope === 'without_treatment' && appointmentType === 'any') score += 20;
          else if (scope === 'all') score += 5;
        }

        if (dayProximityFilter === 'exclude_same_day_and_day_before') {
          score += 1.2;
        } else if (dayProximityFilter !== 'all') {
          score += 1.1;
        }
      }

      return { template, score };
    })
    .sort((a, b) => b.score - a.score);

  return scored[0]?.template || null;
}

async function fetchClinicScopedTemplates(cita, eventName) {
  const clinicId = toIntOrNull(cita?.clinica_id);
  if (!clinicId) {
    return { clinicId: null, groupId: null, candidates: [] };
  }

  const clinic = await Clinica.findByPk(clinicId, {
    attributes: ['id_clinica', 'grupoClinicaId', 'configuracion'],
    raw: true,
  });
  const groupId = toIntOrNull(clinic?.grupoClinicaId);
  const candidates = await AutomationFlowTemplateV2.findAll({
    where: {
      trigger_type: eventName,
      is_active: true,
      published_at: { [Op.ne]: null },
      [Op.or]: [
        { clinic_id: clinicId },
        ...(groupId ? [{ group_id: groupId }] : []),
        { is_system: true },
      ],
    },
    order: [
      ['published_at', 'DESC'],
      ['version', 'DESC'],
      ['id', 'DESC'],
    ],
  });

  return { clinicId, groupId, clinic, candidates };
}

function getScopeScoreForTemplate(template, clinicId, groupId) {
  const templateClinicId = toIntOrNull(template?.clinic_id);
  const templateGroupId = toIntOrNull(template?.group_id);

  if (templateClinicId && templateClinicId === clinicId) return 100;
  if (templateGroupId && groupId && templateGroupId === groupId) return 50;
  if (template?.is_system) return 10;
  return 0;
}

function buildScheduledSlotKey(triggerType, triggerConfig) {
  return [
    cleanString(triggerType).toLowerCase(),
    cleanString(triggerConfig?.schedule_moment || '').toLowerCase(),
    cleanString(triggerConfig?.schedule_time_mode || '').toLowerCase(),
    cleanString(triggerConfig?.custom_time || '').toLowerCase(),
  ].join('|');
}

function computeScheduledRunAt({ cita, triggerType, triggerConfig, timeZone }) {
  const start = cita?.inicio ? new Date(cita.inicio) : null;
  const end = cita?.fin ? new Date(cita.fin) : start;
  if (!start || !Number.isFinite(start.getTime()) || !end || !Number.isFinite(end.getTime())) {
    return null;
  }
  const nowTs = Date.now();

  if (triggerType === 'appointment_reminder_window') {
    // No se programan disparos retroactivos "antes de la cita" si la cita ya ha comenzado.
    if (start.getTime() <= nowTs) {
      return null;
    }
    if (triggerConfig?.schedule_time_mode === 'one_hour_before') {
      return normalizeScheduledDate(new Date(start.getTime() - (60 * 60 * 1000)));
    }
    const baseDateLocal = formatDateLocal(start, timeZone);
    const targetDateLocal = triggerConfig?.schedule_moment === 'week_before'
      ? addDaysToLocalDate(baseDateLocal, -7)
      : triggerConfig?.schedule_moment === 'day_before'
        ? addDaysToLocalDate(baseDateLocal, -1)
        : baseDateLocal;
    if (!targetDateLocal) return null;
    const runAt = localDateTimeToUtc(targetDateLocal, `${triggerConfig?.custom_time || '09:00'}:00`, timeZone);
    if (!runAt || runAt.getTime() >= start.getTime()) return null;
    return normalizeScheduledDate(runAt);
  }

  if (triggerType === 'appointment_after') {
    if (triggerConfig?.schedule_time_mode === 'one_hour_after') {
      return normalizeScheduledDate(new Date(end.getTime() + (60 * 60 * 1000)));
    }
    const baseDateLocal = formatDateLocal(end, timeZone);
    const targetDateLocal = triggerConfig?.schedule_moment === 'week_after'
      ? addDaysToLocalDate(baseDateLocal, 7)
      : triggerConfig?.schedule_moment === 'day_after'
        ? addDaysToLocalDate(baseDateLocal, 1)
        : baseDateLocal;
    if (!targetDateLocal) return null;
    const runAt = localDateTimeToUtc(targetDateLocal, `${triggerConfig?.custom_time || '09:00'}:00`, timeZone);
    if (!runAt || runAt.getTime() <= end.getTime()) return null;
    return normalizeScheduledDate(runAt);
  }

  return null;
}

function buildScheduledWindowIdentifier({ triggerType, triggerConfig, scheduledFor }) {
  return [
    'schedule',
    cleanString(triggerType).toLowerCase(),
    cleanString(triggerConfig?.schedule_moment || '').toLowerCase(),
    cleanString(triggerConfig?.schedule_time_mode || '').toLowerCase(),
    cleanString(triggerConfig?.custom_time || '').toLowerCase() || 'auto',
    scheduledFor instanceof Date && Number.isFinite(scheduledFor.getTime()) ? scheduledFor.toISOString() : '',
  ].join(':');
}

async function resolveScheduledTemplatesForCita(cita, eventName) {
  if (!SCHEDULED_APPOINTMENT_TRIGGER_TYPES.has(cleanString(eventName))) {
    return [];
  }

  const { clinicId, groupId, candidates } = await fetchClinicScopedTemplates(cita, eventName);
  const byTemplateKey = new Map();
  for (const row of candidates || []) {
    const key = cleanString(row?.template_key);
    if (!key || byTemplateKey.has(key)) continue;
    byTemplateKey.set(key, row);
  }

  const boundTemplate = await resolveTemplateBoundToTratamiento(cita, eventName);
  if (boundTemplate) {
    byTemplateKey.set(cleanString(boundTemplate.template_key), boundTemplate);
  }

  const bestBySlot = new Map();
  Array.from(byTemplateKey.values()).forEach((template) => {
    const triggerConfig = getTemplateTriggerConfig(template);
    if (!triggerConfig) return;
    const slotKey = buildScheduledSlotKey(eventName, triggerConfig);
    const candidate = {
      template,
      slotKey,
      score: template.id === boundTemplate?.id
        ? 1000
        : getScopeScoreForTemplate(template, clinicId, groupId),
    };
    const current = bestBySlot.get(slotKey);
    if (!current || candidate.score > current.score || (candidate.score === current.score && Number(template.version || 0) > Number(current.template.version || 0))) {
      bestBySlot.set(slotKey, candidate);
    }
  });

  return Array.from(bestBySlot.values()).map((item) => item.template);
}

async function listExistingScheduledJobs(citaId) {
  const numericCitaId = toIntOrNull(citaId);
  if (!numericCitaId) return [];

  return JobRequest.findAll({
    where: {
      origin: 'appointment_automation_schedule',
      status: { [Op.in]: ['pending', 'waiting'] },
      [Op.and]: [
        db.Sequelize.literal(`CAST(JSON_UNQUOTE(JSON_EXTRACT(payload, '$.appointment_id')) AS UNSIGNED) = ${numericCitaId}`),
      ],
    },
    order: [['id', 'DESC']],
  });
}

async function resolveClinicScope(cita) {
  const clinicId = toIntOrNull(cita?.clinica_id);
  if (!clinicId) {
    return { clinic_id: null, group_id: null };
  }

  const clinic = await Clinica.findByPk(clinicId, {
    attributes: ['id_clinica', 'grupoClinicaId'],
  });

  return {
    clinic_id: clinicId,
    group_id: toIntOrNull(clinic?.grupoClinicaId),
  };
}

function buildExecutionContext({ cita, eventName, userName = null, userEmail = null }) {
  const leadIntakeId = toIntOrNull(cita?.lead_intake_id);
  const appointmentOrigin = leadIntakeId ? 'lead' : 'manual';

  return {
    trigger: {
      type: eventName,
      data: {
        cita_id: toIntOrNull(cita?.id_cita),
        appointment_id: toIntOrNull(cita?.id_cita),
        clinica_id: toIntOrNull(cita?.clinica_id),
        clinic_id: toIntOrNull(cita?.clinica_id),
        paciente_id: toIntOrNull(cita?.paciente_id),
        tratamiento_id: toIntOrNull(cita?.tratamiento_id),
        tipo_cita: cleanString(cita?.tipo_cita).toLowerCase() || null,
        lead_intake_id: leadIntakeId,
        lead_id: leadIntakeId,
        appointment_origin: appointmentOrigin,
        origin: appointmentOrigin,
        estado: cleanString(cita?.estado).toLowerCase() || null,
        usuario_nombre: cleanString(userName),
        usuario_email: cleanString(userEmail),
        inicio: cita?.inicio || null,
        fin: cita?.fin || null,
      },
    },
    appointment: {
      id_cita: toIntOrNull(cita?.id_cita),
      clinica_id: toIntOrNull(cita?.clinica_id),
      paciente_id: toIntOrNull(cita?.paciente_id),
      tratamiento_id: toIntOrNull(cita?.tratamiento_id),
      tipo_cita: cleanString(cita?.tipo_cita).toLowerCase() || null,
      lead_intake_id: leadIntakeId,
      origin: appointmentOrigin,
      estado: cleanString(cita?.estado).toLowerCase() || null,
      usuario_nombre: cleanString(userName),
      usuario_email: cleanString(userEmail),
      inicio: cita?.inicio || null,
      fin: cita?.fin || null,
    },
    ...(leadIntakeId ? {
      lead: {
        id: leadIntakeId,
        lead_intake_id: leadIntakeId,
      },
    } : {}),
    outputs: {},
  };
}

async function enqueueExecutionForTemplate(cita, template, options = {}) {
  const citaId = toIntOrNull(cita?.id_cita);
  if (!citaId || !template) {
    return { success: false, skipped: true, reason: 'invalid_cita' };
  }

  const eventName = normalizeEventName(options.event_name) || cleanString(template?.trigger_type) || mapEstadoToEvent(cita?.estado) || 'appointment_created';
  if (!APPOINTMENT_TRIGGER_TYPES.has(cleanString(template.trigger_type))) {
    return { success: false, skipped: true, reason: 'no_template_for_event' };
  }

  const idempotencyKey = cleanString(options.idempotency_key) || buildIdempotencyKey({
    triggerType: eventName,
    citaId,
    templateVersionId: template.id,
    windowIdentifier: options.window_identifier,
  });

  const existing = await FlowExecutionV2.findOne({ where: { idempotency_key: idempotencyKey } });
  if (existing) {
    return { success: true, deduplicated: true, execution: existing, template };
  }

  const scope = await resolveClinicScope(cita);
  const requestedBy = toIntOrNull(options.user_id) || toIntOrNull(template.created_by) || 1;
  const context = buildExecutionContext({
    cita,
    eventName,
    userName: options.user_name || null,
    userEmail: options.user_email || null,
  });

  const createdExecution = await FlowExecutionV2.create({
    idempotency_key: idempotencyKey,
    template_version_id: template.id,
    engine_version: template.engine_version || 'v2',
    status: 'running',
    context,
    current_node_id: template.entry_node_id,
    trigger_type: eventName,
    trigger_entity_type: 'appointment',
    trigger_entity_id: citaId,
    clinic_id: scope.clinic_id,
    group_id: scope.group_id,
    created_by: requestedBy,
  });
  const io = getIO();
  if (io) {
    const clinicId = toIntOrNull(createdExecution.clinic_id);
    const payload = {
      execution_id: createdExecution.id,
      template_version_id: createdExecution.template_version_id,
      status: createdExecution.status,
      current_node_id: createdExecution.current_node_id,
      clinic_id: clinicId,
      group_id: createdExecution.group_id || null,
      trigger_type: createdExecution.trigger_type,
      trigger_entity_type: createdExecution.trigger_entity_type,
      trigger_entity_id: createdExecution.trigger_entity_id,
      created_at: createdExecution.created_at,
    };
    if (clinicId) io.to(`clinic:${clinicId}`).emit('flow_execution:created', payload);
    else io.emit('flow_execution:created', payload);
  }

  const queueJob = await jobRequestsService.enqueueJobRequest({
    type: 'automations_v2_execute',
    priority: 'critical',
    origin: 'appointment_automation_v2',
    payload: { execution_id: createdExecution.id },
    requestedBy,
    requestedByName: cleanString(options.user_name) || null,
    requestedByRole: cleanString(options.user_role) || 'system',
  });
  jobScheduler.triggerImmediate(queueJob.id).catch(() => {});

  return {
    success: true,
    deduplicated: false,
    execution: createdExecution,
    template,
    queue_job_id: queueJob.id,
  };
}

async function enqueueExecutionForCita(cita, options = {}) {
  const citaId = toIntOrNull(cita?.id_cita);
  if (!citaId) {
    return { success: false, skipped: true, reason: 'invalid_cita' };
  }

  const eventName = normalizeEventName(options.event_name) || mapEstadoToEvent(cita?.estado) || 'appointment_created';
  const template = await resolveTemplateForCitaEvent(cita, eventName);
  if (!template || !APPOINTMENT_TRIGGER_TYPES.has(cleanString(template.trigger_type))) {
    return { success: false, skipped: true, reason: 'no_template_for_event' };
  }

  return enqueueExecutionForTemplate(cita, template, {
    ...options,
    event_name: eventName,
  });
}

async function syncScheduledTriggersForCita(cita, options = {}) {
  const citaId = toIntOrNull(cita?.id_cita);
  if (!citaId) return { success: false, skipped: true, reason: 'invalid_cita' };

  const normalizedStatus = cleanString(cita?.estado).toLowerCase();
  const existingJobs = await listExistingScheduledJobs(citaId);

  if (normalizedStatus && !ACTIVE_APPOINTMENT_STATUSES.has(normalizedStatus)) {
    await Promise.all(existingJobs.map((job) => jobRequestsService.markCancelled(job.id, {
      errorMessage: `appointment_status_${normalizedStatus}_cancelled_schedule`,
    })));
    return {
      success: true,
      cancelled_jobs: existingJobs.map((job) => job.id),
      scheduled_jobs: [],
      skipped: true,
      reason: 'inactive_appointment_status',
    };
  }

  const clinic = cita?.clinica_id
    ? await Clinica.findByPk(cita.clinica_id, {
        attributes: ['id_clinica', 'configuracion'],
        raw: true,
      })
    : null;
  const timeZone = resolveClinicTimezone(clinic);

  const desiredJobs = [];
  for (const triggerType of Array.from(SCHEDULED_APPOINTMENT_TRIGGER_TYPES)) {
    const templates = await resolveScheduledTemplatesForCita(cita, triggerType);
    templates.forEach((template) => {
      const triggerConfig = getTemplateTriggerConfig(template);
      const scheduledFor = computeScheduledRunAt({
        cita,
        triggerType,
        triggerConfig,
        timeZone,
      });
      if (!scheduledFor || !Number.isFinite(scheduledFor.getTime())) return;
      const windowIdentifier = buildScheduledWindowIdentifier({
        triggerType,
        triggerConfig,
        scheduledFor,
      });
      desiredJobs.push({
        triggerType,
        templateKey: cleanString(template.template_key),
        scheduledFor,
        windowIdentifier,
      });
    });
  }

  const desiredKeySet = new Set(
    desiredJobs.map((item) => `${item.triggerType}:${item.templateKey}:${item.windowIdentifier}`)
  );

  for (const job of existingJobs) {
    const payload = job?.payload && typeof job.payload === 'object' ? job.payload : {};
    const existingKey = [
      cleanString(payload.trigger_type),
      cleanString(payload.template_key),
      cleanString(payload.window_identifier),
    ].join(':');
    if (!desiredKeySet.has(existingKey)) {
      await jobRequestsService.markCancelled(job.id, {
        errorMessage: 'superseded_by_appointment_resync',
      });
    }
  }

  const activeExistingJobs = await listExistingScheduledJobs(citaId);
  const existingKeySet = new Set(activeExistingJobs.map((job) => {
    const payload = job?.payload && typeof job.payload === 'object' ? job.payload : {};
    return [
      cleanString(payload.trigger_type),
      cleanString(payload.template_key),
      cleanString(payload.window_identifier),
    ].join(':');
  }));

  const scheduledJobIds = [];
  for (const item of desiredJobs) {
    const dedupeKey = `${item.triggerType}:${item.templateKey}:${item.windowIdentifier}`;
    if (existingKeySet.has(dedupeKey)) continue;

    const runNow = item.scheduledFor.getTime() <= Date.now();
    const job = await jobRequestsService.enqueueJobRequest({
      type: 'appointment_automation_schedule_fire',
      priority: 'high',
      status: 'waiting',
      origin: 'appointment_automation_schedule',
      payload: {
        appointment_id: citaId,
        trigger_type: item.triggerType,
        template_key: item.templateKey,
        window_identifier: item.windowIdentifier,
        scheduled_for: item.scheduledFor.toISOString(),
      },
      requestedBy: toIntOrNull(options.user_id) || null,
      requestedByName: cleanString(options.user_name) || null,
      requestedByRole: cleanString(options.user_role) || 'system',
      nextRunAt: runNow ? new Date() : item.scheduledFor,
    });
    scheduledJobIds.push(job.id);
    if (runNow) {
      jobScheduler.triggerImmediate(job.id).catch(() => {});
    }
  }

  return {
    success: true,
    scheduled_jobs: scheduledJobIds,
    desired_count: desiredJobs.length,
  };
}

async function getExecutionsByAppointmentId(citaId, limit = 25) {
  const numericCitaId = toIntOrNull(citaId);
  if (!numericCitaId) return [];

  const rows = await FlowExecutionV2.findAll({
    where: {
      trigger_entity_type: 'appointment',
      trigger_entity_id: numericCitaId,
    },
    include: [
      {
        model: AutomationFlowTemplateV2,
        as: 'templateVersion',
        attributes: ['id', 'template_key', 'version', 'name', 'trigger_type', 'nodes'],
        required: false,
      },
    ],
    order: [['updated_at', 'DESC']],
    limit: Math.max(1, Math.min(100, Number(limit) || 25)),
  });

  return rows;
}

async function getLatestExecutionByAppointmentId(citaId) {
  const rows = await getExecutionsByAppointmentId(citaId, 50);
  return pickPreferredExecution(rows);
}

async function getExecutionLogs(executionId, limit = 100) {
  const numericExecutionId = toIntOrNull(executionId);
  if (!numericExecutionId) return [];

  return FlowExecutionLogV2.findAll({
    where: { flow_execution_id: numericExecutionId },
    order: [['id', 'ASC']],
    limit: Math.max(1, Math.min(500, Number(limit) || 100)),
  });
}

async function fireScheduledTrigger(payload = {}) {
  const citaId = toIntOrNull(payload.appointment_id);
  const triggerType = normalizeEventName(payload.trigger_type);
  const templateKey = cleanString(payload.template_key);
  const expectedWindowIdentifier = cleanString(payload.window_identifier);
  if (!citaId || !triggerType || !templateKey) {
    return { success: false, skipped: true, reason: 'invalid_payload' };
  }

  const citaModel = await db.CitaPaciente.findByPk(citaId);
  if (!citaModel) {
    return { success: false, skipped: true, reason: 'appointment_not_found' };
  }
  const cita = citaModel.toJSON ? citaModel.toJSON() : citaModel;
  const normalizedStatus = cleanString(cita?.estado).toLowerCase();
  if (['cancelada', 'no_asistio'].includes(normalizedStatus)) {
    return { success: true, skipped: true, reason: `appointment_${normalizedStatus}` };
  }

  const clinic = cita?.clinica_id
    ? await Clinica.findByPk(cita.clinica_id, {
        attributes: ['id_clinica', 'configuracion'],
        raw: true,
      })
    : null;
  const timeZone = resolveClinicTimezone(clinic);

  const template = await AutomationFlowTemplateV2.findOne({
    where: {
      template_key: templateKey,
      trigger_type: triggerType,
      is_active: true,
      published_at: { [Op.ne]: null },
    },
    order: [['version', 'DESC']],
  });
  if (!template) {
    return { success: true, skipped: true, reason: 'template_not_active' };
  }

  const triggerConfig = getTemplateTriggerConfig(template);
  const scheduledFor = computeScheduledRunAt({
    cita,
    triggerType,
    triggerConfig,
    timeZone,
  });
  if (!scheduledFor || !Number.isFinite(scheduledFor.getTime())) {
    return { success: true, skipped: true, reason: 'invalid_schedule' };
  }

  const effectiveWindowIdentifier = buildScheduledWindowIdentifier({
    triggerType,
    triggerConfig,
    scheduledFor,
  });
  if (expectedWindowIdentifier && effectiveWindowIdentifier !== expectedWindowIdentifier) {
    return {
      success: true,
      skipped: true,
      reason: 'stale_schedule_window',
      expected_window_identifier: effectiveWindowIdentifier,
    };
  }

  if (scheduledFor.getTime() > Date.now()) {
    return {
      success: true,
      waiting: true,
      scheduled_for: scheduledFor.toISOString(),
    };
  }

  return enqueueExecutionForTemplate(cita, template, {
    event_name: triggerType,
    window_identifier: effectiveWindowIdentifier,
    user_id: payload.user_id || null,
    user_name: payload.user_name || 'scheduler',
    user_role: payload.user_role || 'system',
  });
}

module.exports = {
  APPOINTMENT_TRIGGER_TYPES,
  SCHEDULED_APPOINTMENT_TRIGGER_TYPES,
  enqueueExecutionForCita,
  enqueueExecutionForTemplate,
  syncScheduledTriggersForCita,
  fireScheduledTrigger,
  getExecutionsByAppointmentId,
  getLatestExecutionByAppointmentId,
  getExecutionLogs,
};
