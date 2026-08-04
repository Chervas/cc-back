'use strict';

const crypto = require('crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const jobRequestsService = require('./jobRequests.service');
const jobScheduler = require('./jobScheduler.service');
const businessProfileLocal = require('./businessProfileLocal.service');

const AutomationFlowTemplateV2 = db.AutomationFlowTemplateV2;
const FlowExecutionV2 = db.FlowExecutionV2;

const MANAGED_FEATURE = 'google_special_hours';
const TEMPLATE_KEY_PREFIX = 'google_special_hours_';
const TRIGGER_TYPE = 'scheduled_once';

function cleanString(value) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  return normalized || null;
}

function toPositiveInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseJsonObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function formatPartsInTimeZone(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
}

function timeZoneOffsetMs(date, timeZone) {
  const parts = formatPartsInTimeZone(date, timeZone);
  const representedAsUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return representedAsUtc - date.getTime();
}

function localDateTimeToUtc(dateValue, timeValue, timeZone) {
  const dateMatch = String(dateValue || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const timeMatch = String(timeValue || '00:00').match(/^(\d{2}):(\d{2})$/);
  if (!dateMatch || !timeMatch) return null;
  const components = {
    year: Number(dateMatch[1]),
    month: Number(dateMatch[2]),
    day: Number(dateMatch[3]),
    hour: Number(timeMatch[1]),
    minute: Number(timeMatch[2]),
  };
  if (components.hour > 23 || components.minute > 59) return null;

  const wallClockUtc = Date.UTC(
    components.year,
    components.month - 1,
    components.day,
    components.hour,
    components.minute,
    0,
  );
  let candidate = new Date(wallClockUtc);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    candidate = new Date(wallClockUtc - timeZoneOffsetMs(candidate, timeZone));
  }
  return Number.isFinite(candidate.getTime()) ? candidate : null;
}

function localIsoDate(date, timeZone) {
  const parts = formatPartsInTimeZone(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function isFutureLocalDate(dateValue, timeZone, now = new Date()) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(dateValue || ''))
    && String(dateValue) > localIsoDate(now, timeZone);
}

function scheduleLabel(period) {
  const label = cleanString(period?.label);
  if (label) return label;
  return period?.kind === 'open' ? 'Apertura especial' : 'Cierre especial';
}

function buildTemplateNodes({ scheduleAt, period, timeZone }) {
  return [
    {
      id: 'trigger_schedule',
      type: 'trigger/scheduled_once',
      name: 'Fecha programada',
      config: {
        managed_feature: MANAGED_FEATURE,
        configured: true,
        schedule_at: scheduleAt.toISOString(),
        time_zone: timeZone,
        auto_deactivate_after_execution: true,
      },
      outputs: { on_success: 'wait_until' },
    },
    {
      id: 'wait_until',
      type: 'delay/wait_until',
      name: 'Esperar hasta la fecha',
      config: { datetime_expression: scheduleAt.toISOString() },
      outputs: { on_complete: 'apply_hours' },
    },
    {
      id: 'apply_hours',
      type: 'action/update_google_special_hours',
      name: period.kind === 'open' ? 'Abrir en Google' : 'Cerrar en Google',
      config: {
        period,
        time_zone: timeZone,
        auto_deactivate_after_execution: true,
      },
      outputs: { on_success: 'flow_end' },
    },
    {
      id: 'flow_end',
      type: 'control/end',
      name: 'Fin',
      config: {},
      outputs: {},
    },
  ];
}

function buildExecutionContext({ clinicId, scheduleAt, period, timeZone, activation }) {
  return {
    trigger: {
      type: TRIGGER_TYPE,
      data: {
        clinic_id: clinicId,
        schedule_at: scheduleAt.toISOString(),
        period,
        time_zone: timeZone,
        activation,
      },
    },
    clinic: { id_clinica: clinicId },
    outputs: {},
    communication_language: 'es',
  };
}

async function createExecutionAndJob({ template, actor, activation, transaction }) {
  const config = parseJsonObject(template.trigger_config);
  const scheduleAt = new Date(config.schedule_at || '');
  if (!Number.isFinite(scheduleAt.getTime())) {
    const error = new Error('business_profile_special_hours_schedule_invalid');
    error.status = 400;
    throw error;
  }

  const context = buildExecutionContext({
    clinicId: Number(template.clinic_id),
    scheduleAt,
    period: config.period,
    timeZone: config.time_zone,
    activation,
  });
  const execution = await FlowExecutionV2.create({
    idempotency_key: `${template.public_id}:activation:${activation}`,
    template_version_id: template.id,
    engine_version: 'v2',
    status: 'running',
    context,
    current_node_id: template.entry_node_id,
    trigger_type: TRIGGER_TYPE,
    trigger_entity_type: 'clinic',
    trigger_entity_id: Number(template.clinic_id),
    clinic_id: Number(template.clinic_id),
    group_id: template.group_id || null,
    created_by: actor.userId,
  }, { transaction });

  const job = await jobRequestsService.enqueueJobRequest({
    type: 'automations_v2_execute',
    priority: 'normal',
    origin: 'google_special_hours',
    payload: { execution_id: execution.id },
    requestedBy: actor.userId,
    requestedByName: actor.name,
    requestedByRole: actor.role,
    maxAttempts: 5,
  }, { transaction });

  await execution.update({
    context: {
      ...context,
      __managed_job_request_id: Number(job.id),
    },
  }, { transaction });
  return { execution, job };
}

function mapSchedule(template, execution = null) {
  const config = parseJsonObject(template.trigger_config);
  const status = execution?.status
    || (template.is_active === false ? 'paused' : 'pending');
  return {
    id: template.public_id,
    template_id: template.id,
    template_key: template.template_key,
    version: template.version,
    name: template.name,
    description: template.description || null,
    active: template.is_active !== false,
    status,
    schedule_at: config.schedule_at || null,
    time_zone: config.time_zone || 'Europe/Madrid',
    period: config.period || null,
    auto_deactivate_after_execution: config.auto_deactivate_after_execution === true,
    completed_at: status === 'completed' ? (execution?.updated_at || execution?.updatedAt || null) : null,
    last_error: execution?.last_error || null,
    execution_id: execution?.id || null,
    nodes: Array.isArray(template.nodes) ? template.nodes : [],
    can_toggle: status !== 'completed',
    created_at: template.created_at || template.createdAt || null,
  };
}

async function listSchedules(clinicIdRaw) {
  const clinicId = toPositiveInt(clinicIdRaw);
  if (!clinicId) {
    const error = new Error('local_clinic_invalid');
    error.status = 400;
    throw error;
  }
  const templates = await AutomationFlowTemplateV2.findAll({
    where: {
      clinic_id: clinicId,
      template_key: { [Op.like]: `${TEMPLATE_KEY_PREFIX}%` },
      published_at: { [Op.ne]: null },
    },
    order: [['created_at', 'DESC'], ['version', 'DESC']],
  });
  const managed = templates.filter((row) => parseJsonObject(row.trigger_config).managed_feature === MANAGED_FEATURE);
  if (!managed.length) return [];
  const executions = await FlowExecutionV2.findAll({
    where: { template_version_id: { [Op.in]: managed.map((row) => row.id) } },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
  });
  const latestByTemplate = new Map();
  for (const execution of executions) {
    if (!latestByTemplate.has(Number(execution.template_version_id))) {
      latestByTemplate.set(Number(execution.template_version_id), execution);
    }
  }
  return managed
    .map((template) => mapSchedule(template, latestByTemplate.get(Number(template.id)) || null))
    .sort((left, right) => {
      const leftTime = new Date(left.schedule_at || 0).getTime();
      const rightTime = new Date(right.schedule_at || 0).getTime();
      const leftTerminal = ['completed', 'cancelled'].includes(left.status) ? 1 : 0;
      const rightTerminal = ['completed', 'cancelled'].includes(right.status) ? 1 : 0;
      return leftTerminal - rightTerminal || leftTime - rightTime;
    });
}

async function createSchedule({ clinicId: clinicIdRaw, payload = {}, actor = {} }) {
  const clinicId = toPositiveInt(clinicIdRaw);
  const userId = toPositiveInt(actor.userId);
  if (!clinicId || !userId) {
    const error = new Error(!clinicId ? 'local_clinic_invalid' : 'automation_actor_required');
    error.status = 400;
    throw error;
  }

  const resolved = await businessProfileLocal.resolveEffectiveLocations(clinicId);
  if (!resolved?.locations?.length) {
    const error = new Error('business_profile_location_not_configured');
    error.status = 409;
    throw error;
  }
  const normalizedPlan = businessProfileLocal.normalizeSpecialHoursPlan({
    timeZone: payload.timeZone || payload.time_zone || resolved.timeZone,
    periods: [payload.period || payload],
  }, resolved.timeZone);
  const period = normalizedPlan.periods[0];
  const scheduleAt = localDateTimeToUtc(period.startDate, '00:00', normalizedPlan.timeZone);
  if (!scheduleAt || !isFutureLocalDate(period.startDate, normalizedPlan.timeZone)) {
    const error = new Error('business_profile_special_hours_schedule_invalid');
    error.status = 400;
    throw error;
  }

  const suffix = crypto.randomUUID().replace(/-/g, '').slice(0, 16);
  const publicId = `flw_gbp_hours_${clinicId}_${suffix}`.slice(0, 64);
  const templateKey = `${TEMPLATE_KEY_PREFIX}${clinicId}_${suffix}`.slice(0, 120);
  const triggerConfig = {
    managed_feature: MANAGED_FEATURE,
    configured: true,
    schedule_at: scheduleAt.toISOString(),
    time_zone: normalizedPlan.timeZone,
    period,
    auto_deactivate_after_execution: true,
  };
  const effectiveActor = {
    userId,
    name: cleanString(actor.name),
    role: cleanString(actor.role) || 'clinic',
  };

  let created;
  await db.sequelize.transaction(async (transaction) => {
    const template = await AutomationFlowTemplateV2.create({
      public_id: publicId,
      template_key: templateKey,
      version: 1,
      engine_version: 'v2',
      name: `${period.kind === 'open' ? 'Abrir' : 'Cerrar'} en Google · ${scheduleLabel(period)}`.slice(0, 255),
      description: `${period.startDate}${period.endDate !== period.startDate ? ` a ${period.endDate}` : ''}`,
      trigger_type: TRIGGER_TYPE,
      trigger_config: triggerConfig,
      is_active: true,
      is_system: false,
      clinic_id: clinicId,
      group_id: null,
      entry_node_id: 'trigger_schedule',
      nodes: buildTemplateNodes({ scheduleAt, period, timeZone: normalizedPlan.timeZone }),
      published_at: new Date(),
      published_by: userId,
      created_by: userId,
    }, { transaction });
    const queued = await createExecutionAndJob({ template, actor: effectiveActor, activation: 1, transaction });
    created = { template, ...queued };
  });
  jobScheduler.triggerImmediate(created.job.id).catch(() => {});
  return mapSchedule(created.template, created.execution);
}

async function setScheduleActive({ clinicId: clinicIdRaw, publicId, active, actor = {} }) {
  const clinicId = toPositiveInt(clinicIdRaw);
  const userId = toPositiveInt(actor.userId);
  if (!clinicId || !userId || !cleanString(publicId)) {
    const error = new Error('business_profile_special_hours_automation_invalid');
    error.status = 400;
    throw error;
  }
  const template = await AutomationFlowTemplateV2.findOne({
    where: { public_id: cleanString(publicId), clinic_id: clinicId, published_at: { [Op.ne]: null } },
  });
  if (!template || parseJsonObject(template.trigger_config).managed_feature !== MANAGED_FEATURE) {
    const error = new Error('business_profile_special_hours_automation_not_found');
    error.status = 404;
    throw error;
  }
  const latestExecution = await FlowExecutionV2.findOne({
    where: { template_version_id: template.id },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
  });
  if (active && latestExecution?.status === 'completed') {
    const error = new Error('business_profile_special_hours_automation_completed');
    error.status = 409;
    throw error;
  }

  let queuedJob = null;
  let execution = latestExecution;
  let jobToCancel = null;
  await db.sequelize.transaction(async (transaction) => {
    await template.update({ is_active: active === true }, { transaction });
    if (active === true) {
      if (!execution || ['cancelled', 'failed', 'dead_letter'].includes(execution.status)) {
        const activation = await FlowExecutionV2.count({ where: { template_version_id: template.id }, transaction }) + 1;
        const queued = await createExecutionAndJob({
          template,
          actor: {
            userId,
            name: cleanString(actor.name),
            role: cleanString(actor.role) || 'clinic',
          },
          activation,
          transaction,
        });
        execution = queued.execution;
        queuedJob = queued.job;
      }
      return;
    }

    if (execution && ['running', 'waiting', 'paused'].includes(execution.status)) {
      const context = parseJsonObject(execution.context);
      jobToCancel = toPositiveInt(context.__managed_job_request_id);
      await execution.update({ status: 'cancelled' }, { transaction });
    }
  });

  if (jobToCancel) {
    const job = await jobRequestsService.findJobById(jobToCancel);
    if (job && ['pending', 'queued', 'waiting'].includes(job.status)) {
      await jobRequestsService.markCancelled(job.id, { errorMessage: 'Automatización pausada desde Perfil Google' });
    }
  }
  if (queuedJob) jobScheduler.triggerImmediate(queuedJob.id).catch(() => {});
  return mapSchedule(template, execution);
}

module.exports = {
  MANAGED_FEATURE,
  TEMPLATE_KEY_PREFIX,
  TRIGGER_TYPE,
  listSchedules,
  createSchedule,
  setScheduleActive,
  __testing: {
    localDateTimeToUtc,
    isFutureLocalDate,
    buildTemplateNodes,
    mapSchedule,
  },
};
