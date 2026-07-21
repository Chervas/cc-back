'use strict';

const crypto = require('crypto');
const db = require('../../models');
const jobRequestsService = require('./jobRequests.service');
const jobScheduler = require('./jobScheduler.service');
const { resolveLeadAutoReplyWait } = require('./clinicOpeningHours.service');
const { evaluatePendingLeadContact, isEffectiveContactAttempt } = require('./leadContactState.service');
const { canUserSelectWhatsappTemplate } = require('../lib/whatsapp-template-ownership');

const { Op } = db.Sequelize;
const FEATURE_KEY = 'lead_auto_reply';
const CATALOG_NAME = 'auto_bienvenida_lead';
const BASE_TEMPLATE_KEY = 'lead_auto_reply_system';
const FLOW_NAME = 'Contestar a los leads automáticamente';
const BACKFILL_JOB_TYPE = 'lead_auto_reply_backfill';
const TERMINAL_LEAD_STATUSES = ['citado', 'acudio_cita', 'convertido', 'descartado'];
const SOURCE_VALUES = new Set(['write', 'call']);
const TIMING_VALUES = new Set(['immediate', 'next_day']);
const SCHEDULE_VALUES = new Set(['clinic_hours', 'all_days']);
const LEAD_TEMPLATE_VARIABLES = new Set([
  'nombre', 'nombre_paciente', 'patient_name', 'first_name',
  'telefono', 'telefono_paciente', 'email', 'email_paciente',
  'nombre_clinica', 'clinic_name', 'telefono_clinica', 'direccion_clinica',
]);
const LEAD_TEMPLATE_USAGES = new Set(['lead_auto_reply', 'lead_primera_visita']);

function toIntOrNull(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function cleanString(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function cloneJson(value) {
  return value === undefined || value === null ? value : JSON.parse(JSON.stringify(value));
}

function clinicTemplateKey(clinicId) {
  return `${BASE_TEMPLATE_KEY}__clinic_${clinicId}`;
}

function normalizeSources(value) {
  const source = Array.isArray(value) ? value : [value];
  return Array.from(new Set(source.map(cleanString).filter((item) => SOURCE_VALUES.has(item))));
}

function normalizeConfig(raw = {}) {
  return {
    managed_feature: FEATURE_KEY,
    configured: raw.configured === true,
    sources: normalizeSources(raw.sources || raw.contact_sources),
    timing: TIMING_VALUES.has(cleanString(raw.timing)) ? cleanString(raw.timing) : 'immediate',
    schedule_scope: SCHEDULE_VALUES.has(cleanString(raw.schedule_scope)) ? cleanString(raw.schedule_scope) : 'clinic_hours',
    whatsapp_template_id: toIntOrNull(raw.whatsapp_template_id || raw.template_id),
    whatsapp_template_name: cleanString(raw.whatsapp_template_name || raw.template_name) || null,
    whatsapp_template_language: cleanString(raw.whatsapp_template_language || raw.language_code) || null,
    updated_at: raw.updated_at || null,
    updated_by: toIntOrNull(raw.updated_by),
  };
}

function leadTemplateBindings() {
  return {
    nombre: '{{lead.nombre}}',
    nombre_paciente: '{{lead.nombre}}',
    patient_name: '{{lead.nombre}}',
    first_name: '{{lead.nombre}}',
    telefono: '{{lead.telefono}}',
    telefono_paciente: '{{lead.telefono}}',
    email: '{{lead.email}}',
    email_paciente: '{{lead.email}}',
    nombre_clinica: '{{clinica.nombre}}',
    clinic_name: '{{clinica.nombre}}',
    telefono_clinica: '{{clinica.telefono}}',
    direccion_clinica: '{{clinica.direccion}}',
  };
}

function getTemplateVariables(template) {
  let variables = template?.variables;
  if (typeof variables === 'string') {
    try {
      variables = JSON.parse(variables);
    } catch (_error) {
      variables = [];
    }
  }
  if (Array.isArray(variables)) return variables;
  if (variables && typeof variables === 'object') {
    return Object.entries(variables).map(([name, value]) => (
      value && typeof value === 'object' ? { name, ...value } : { name }
    ));
  }
  return [];
}

function getUnsupportedLeadTemplateVariables(template) {
  return getTemplateVariables(template)
    .map((variable) => ({
      name: cleanString(variable?.name || variable?.key).toLowerCase(),
      label: cleanString(variable?.name || variable?.key) || `posición ${variable?.position || '?'}`,
    }))
    .filter((variable) => !variable.name || !LEAD_TEMPLATE_VARIABLES.has(variable.name))
    .map((variable) => variable.label);
}

function isLeadAutoReplyTemplate(template) {
  const hasLeadUsage = getTemplateVariables(template).some((variable) => (
    LEAD_TEMPLATE_USAGES.has(cleanString(variable?.template_usage).toLowerCase())
  ));
  if (hasLeadUsage) return true;
  const names = [template?.name, template?.catalog?.name, template?.catalog?.family_key]
    .map((value) => cleanString(value).toLowerCase())
    .filter(Boolean);
  return names.some((name) => name.includes('lead_primera_visita') || name.includes('lead_auto_reply'));
}

function buildManagedNodes(config) {
  const callDelay = config.timing === 'immediate'
    ? { duration: 1, unit: 'hours' }
    : { duration: 0, unit: 'minutes' };
  const scheduleConfig = {
    mode: 'clinic_schedule',
    timing: config.timing,
    schedule_scope: config.schedule_scope,
    datetime_expression: '{{trigger.data.event_at}}',
  };
  return [
    {
      id: 'N1', type: 'trigger/lead_nuevo', config: cloneJson(config),
      outputs: { on_success: 'N2' }, position: { x: 120, y: 120 },
    },
    {
      id: 'N2', type: 'condition/field_check',
      config: {
        mode: 'simple',
        left_ref: { source: 'trigger_data', path: 'event_kind', value_type: 'string', label: 'Canal de entrada' },
        operator: 'equals', right_value: 'write',
      },
      outputs: { on_true: 'N3', on_false: 'N4' }, position: { x: 120, y: 280 },
    },
    {
      id: 'N3', type: 'delay/wait_until', config: scheduleConfig,
      outputs: { on_complete: 'N6' }, position: { x: 0, y: 440 },
    },
    {
      id: 'N4', type: 'delay/fixed', config: callDelay,
      outputs: { on_complete: 'N5' }, position: { x: 280, y: 440 },
    },
    {
      id: 'N5', type: 'delay/wait_until', config: scheduleConfig,
      outputs: { on_complete: 'N6' }, position: { x: 280, y: 600 },
    },
    {
      id: 'N6', type: 'condition/field_check',
      config: {
        mode: 'lead_contact_state',
        left_ref: { source: 'context', path: 'lead.id', value_type: 'number', label: 'Lead actual' },
        operator: 'exists',
      },
      outputs: { on_true: 'N7', on_false: 'N8' }, position: { x: 120, y: 760 },
    },
    {
      id: 'N7', type: 'action/send_whatsapp',
      config: {
        message_mode: 'template',
        template_id: config.whatsapp_template_id,
        template_name: config.whatsapp_template_name,
        language_code: config.whatsapp_template_language || 'es',
        recipient_mode: 'context_lead',
        sender_mode: 'clinic_default',
        quiet_hours_enabled: false,
        variables_named: leadTemplateBindings(),
        template_usage: FEATURE_KEY,
      },
      outputs: { on_success: 'N8', on_fail: 'N8' }, position: { x: 120, y: 920 },
    },
    {
      id: 'N8', type: 'control/join', config: { mode: 'any' },
      outputs: { on_joined: null }, position: { x: 120, y: 1080 },
    },
  ];
}

async function findLatestClinicFlow(clinicId, options = {}) {
  return db.AutomationFlowTemplateV2.findOne({
    where: {
      template_key: clinicTemplateKey(clinicId),
      published_at: { [Op.ne]: null },
      ...(options.activeOnly ? { is_active: true } : {}),
    },
    order: [['version', 'DESC']],
  });
}

async function loadSelectedTemplate(config, clinicId) {
  if (!config.whatsapp_template_id) return null;
  return db.WhatsappTemplate.findOne({
    where: { id: config.whatsapp_template_id, clinic_id: clinicId, is_active: true },
    attributes: [
      'id', 'clinic_id', 'name', 'display_name', 'status', 'components', 'variables',
      'language', 'catalog_template_id', 'created_by_user_id', 'origin', 'is_active',
    ],
  });
}

async function buildReadiness(config, clinicId) {
  const reasons = [];
  if (!config.configured || !config.sources.length) reasons.push('configuration_incomplete');
  const template = await loadSelectedTemplate(config, clinicId);
  if (!template) reasons.push('whatsapp_template_not_found');
  else {
    if (cleanString(template.status).toUpperCase() !== 'APPROVED') reasons.push('whatsapp_template_not_approved');
    if (!isLeadAutoReplyTemplate(template)) reasons.push('whatsapp_template_not_for_lead_auto_reply');
    if (getUnsupportedLeadTemplateVariables(template).length) reasons.push('whatsapp_template_variables_unsupported');
  }

  let hasClinicHours = true;
  if (config.schedule_scope === 'clinic_hours') {
    const schedule = await resolveLeadAutoReplyWait({ clinicId, scheduleScope: 'clinic_hours', timing: 'immediate' });
    hasClinicHours = schedule.reason !== 'clinic_hours_not_configured';
    if (!hasClinicHours) reasons.push('clinic_hours_not_configured');
  }
  return {
    ready: reasons.length === 0,
    reasons,
    template: template ? (template.toJSON ? template.toJSON() : template) : null,
    has_clinic_hours: hasClinicHours,
  };
}

async function getStatus(clinicId) {
  const [flow, clinic] = await Promise.all([
    findLatestClinicFlow(clinicId),
    db.Clinica.findByPk(clinicId, { attributes: ['nombre_clinica'], raw: true }),
  ]);
  const config = normalizeConfig(flow?.trigger_config || {});
  const readiness = await buildReadiness(config, clinicId);
  return {
    feature: FEATURE_KEY,
    clinic_id: clinicId,
    clinic_name: cleanString(clinic?.nombre_clinica) || `Clínica ${clinicId}`,
    configured: config.configured,
    active: flow?.is_active === true,
    config,
    readiness,
    flow: flow ? {
      id: flow.id,
      public_id: flow.public_id,
      template_key: flow.template_key,
      version: flow.version,
      name: flow.name,
    } : null,
  };
}

async function saveConfig({ clinicId, actorUserId, input }) {
  const previous = await findLatestClinicFlow(clinicId);
  const config = normalizeConfig({
    ...(previous?.trigger_config || {}),
    ...input,
    configured: true,
    updated_at: new Date().toISOString(),
    updated_by: actorUserId,
  });
  if (!config.sources.length || !config.whatsapp_template_id) {
    const error = new Error('Selecciona el origen de los leads y una plantilla de WhatsApp.');
    error.status = 400;
    error.code = 'lead_auto_reply_configuration_incomplete';
    throw error;
  }
  const selectedTemplate = await loadSelectedTemplate(config, clinicId);
  if (!selectedTemplate) {
    const error = new Error('La plantilla de WhatsApp no pertenece a esta clínica o ya no está disponible.');
    error.status = 409;
    error.code = 'whatsapp_template_not_found';
    throw error;
  }
  const selectedTemplateJson = selectedTemplate.toJSON ? selectedTemplate.toJSON() : selectedTemplate;
  if (!canUserSelectWhatsappTemplate(selectedTemplateJson, actorUserId)) {
    const error = new Error('No tienes permiso para usar esta plantilla de WhatsApp.');
    error.status = 403;
    error.code = 'whatsapp_template_forbidden';
    throw error;
  }
  const unsupportedVariables = getUnsupportedLeadTemplateVariables(selectedTemplateJson);
  if (unsupportedVariables.length) {
    const error = new Error('Esta plantilla necesita datos que no están disponibles en un lead nuevo.');
    error.status = 409;
    error.code = 'whatsapp_template_variables_unsupported';
    error.details = unsupportedVariables;
    throw error;
  }
  if (!isLeadAutoReplyTemplate(selectedTemplateJson)) {
    const error = new Error('Selecciona una plantilla preparada para responder a leads nuevos.');
    error.status = 409;
    error.code = 'whatsapp_template_not_for_lead_auto_reply';
    throw error;
  }
  config.whatsapp_template_name = selectedTemplate.name;
  config.whatsapp_template_language = cleanString(selectedTemplate.language) || 'es';
  const readiness = await buildReadiness(config, clinicId);
  const requestedActive = input.active === true || (input.active === undefined && previous?.is_active === true);
  if (requestedActive && !readiness.ready) {
    const error = new Error(readiness.reasons.includes('clinic_hours_not_configured')
      ? 'No hay un horario de clínica configurado.'
      : 'La automatización todavía no está lista para activarse.');
    error.status = 409;
    error.code = readiness.reasons[0] || 'lead_auto_reply_not_ready';
    error.details = readiness.reasons;
    throw error;
  }

  const templateKey = clinicTemplateKey(clinicId);
  const clinic = await db.Clinica.findByPk(clinicId, { attributes: ['id_clinica', 'grupoClinicaId'], raw: true });
  if (!clinic) {
    const error = new Error('Clínica no encontrada.');
    error.status = 404;
    error.code = 'clinic_not_found';
    throw error;
  }

  await db.sequelize.transaction(async (transaction) => {
    if (previous) {
      await db.AutomationFlowTemplateV2.update(
        { is_active: false },
        { where: { template_key: templateKey, published_at: { [Op.ne]: null } }, transaction }
      );
    }
    await db.AutomationFlowTemplateV2.create({
      public_id: previous?.public_id || `flw_lead_auto_reply_clinic_${clinicId}`,
      template_key: templateKey,
      version: Number(previous?.version || 0) + 1,
      engine_version: 'v2',
      name: FLOW_NAME,
      description: 'Responde por WhatsApp a nuevos leads según el canal, el plazo y el horario configurados.',
      trigger_type: 'lead_nuevo',
      trigger_config: config,
      is_active: requestedActive,
      is_system: false,
      clinic_id: clinicId,
      group_id: toIntOrNull(clinic.grupoClinicaId),
      entry_node_id: 'N1',
      nodes: buildManagedNodes(config),
      published_at: new Date(),
      published_by: actorUserId,
      created_by: actorUserId || 1,
    }, { transaction });
  });
  return getStatus(clinicId);
}

async function setActive({ clinicId, active }) {
  const flow = await findLatestClinicFlow(clinicId);
  if (!flow) {
    const error = new Error('Configura la automatización antes de activarla.');
    error.status = 409;
    error.code = 'lead_auto_reply_configuration_required';
    throw error;
  }
  if (active) {
    const readiness = await buildReadiness(normalizeConfig(flow.trigger_config || {}), clinicId);
    if (!readiness.ready) {
      const error = new Error(readiness.reasons.includes('clinic_hours_not_configured')
        ? 'No hay un horario de clínica configurado.'
        : 'La automatización todavía no está lista para activarse.');
      error.status = 409;
      error.code = readiness.reasons[0] || 'lead_auto_reply_not_ready';
      error.details = readiness.reasons;
      throw error;
    }
  }
  await flow.update({ is_active: active === true });
  return getStatus(clinicId);
}

async function validateFlowActivation(flow) {
  const rawConfig = flow?.trigger_config || {};
  if (rawConfig.managed_feature !== FEATURE_KEY) return { managed: false, ready: true, reasons: [] };
  const config = normalizeConfig(rawConfig);
  const clinicId = toIntOrNull(flow?.clinic_id);
  if (!clinicId) return { managed: true, ready: false, reasons: ['clinic_not_found'] };
  return { managed: true, ...(await buildReadiness(config, clinicId)) };
}

function buildExecutionContext(lead, eventKind, eventAt, triggerData = {}) {
  return {
    trigger: {
      type: 'lead_nuevo',
      data: {
        lead_id: lead.id,
        lead_intake_id: lead.id,
        clinic_id: lead.clinica_id,
        clinica_id: lead.clinica_id,
        event_kind: eventKind,
        event_at: eventAt.toISOString(),
        ...triggerData,
      },
    },
    lead: {
      id: lead.id,
      lead_intake_id: lead.id,
      clinica_id: lead.clinica_id,
      nombre: lead.nombre || null,
      telefono: lead.telefono || null,
      email: lead.email || null,
      status_lead: lead.status_lead || null,
    },
    outputs: {},
  };
}

async function enqueueForLead({
  lead,
  eventKind,
  eventAt = new Date(),
  idempotencyScope = 'event',
  bypassSourceFilter = false,
  triggerData = {},
}) {
  const clinicId = toIntOrNull(lead?.clinica_id);
  const normalizedKind = cleanString(eventKind);
  if (!clinicId || !SOURCE_VALUES.has(normalizedKind)) return { skipped: true, reason: 'invalid_event_scope' };
  const flow = await findLatestClinicFlow(clinicId, { activeOnly: true });
  if (!flow) return { skipped: true, reason: 'no_active_flow' };
  const config = normalizeConfig(flow.trigger_config || {});
  if (!config.configured || (!bypassSourceFilter && !config.sources.includes(normalizedKind))) {
    return { skipped: true, reason: 'event_source_disabled' };
  }

  const eventDate = eventAt instanceof Date ? eventAt : new Date(eventAt);
  const digest = crypto.createHash('sha256')
    .update(`${flow.id}:${lead.id}:lead_auto_reply:${cleanString(idempotencyScope) || 'event'}`)
    .digest('hex');
  const idempotencyKey = `lead_auto_reply:${digest}`;
  let execution = await db.FlowExecutionV2.findOne({ where: { idempotency_key: idempotencyKey } });
  let created = false;
  if (!execution) {
    try {
      execution = await db.FlowExecutionV2.create({
        idempotency_key: idempotencyKey,
        template_version_id: flow.id,
        engine_version: 'v2',
        status: 'running',
        context: buildExecutionContext(lead, normalizedKind, eventDate, triggerData),
        current_node_id: flow.entry_node_id,
        trigger_type: 'lead_nuevo',
        trigger_entity_type: 'lead_nuevo',
        trigger_entity_id: lead.id,
        clinic_id: clinicId,
        group_id: toIntOrNull(lead.grupo_clinica_id || flow.group_id),
        created_by: toIntOrNull(flow.created_by) || 1,
      });
      created = true;
    } catch (error) {
      if (error?.name !== 'SequelizeUniqueConstraintError') throw error;
      execution = await db.FlowExecutionV2.findOne({ where: { idempotency_key: idempotencyKey } });
    }
  }
  if (!execution || !['running', 'waiting'].includes(cleanString(execution.status).toLowerCase())) {
    return { skipped: true, reason: 'execution_terminal', execution_id: execution?.id || null };
  }
  const { job } = await jobRequestsService.enqueueUniqueJobRequest({
    type: 'automations_v2_execute',
    priority: 'critical',
    origin: 'lead_auto_reply',
    payload: { execution_id: execution.id },
    dedupeScope: `flow_execution:${execution.id}`,
    requestedBy: toIntOrNull(flow.created_by) || 1,
    requestedByRole: 'system',
  });
  jobScheduler.triggerImmediate(job.id).catch(() => {});
  return { skipped: false, created, execution_id: execution.id, job_request_id: job.id };
}

function resolveLeadEventKind(lead) {
  return lead?.call_initiated === true || cleanString(lead?.source).toLowerCase() === 'call_click'
    ? 'call'
    : 'write';
}

async function listPendingLeadIds(clinicId, config) {
  const ids = [];
  let cursor = 0;
  while (true) {
    const rows = await db.LeadIntake.findAll({
      where: {
        clinica_id: clinicId,
        id: { [Op.gt]: cursor },
        archived_at: null,
        telefono: { [Op.ne]: null },
        status_lead: { [Op.notIn]: TERMINAL_LEAD_STATUSES },
      },
      attributes: [
        'id', 'clinica_id', 'grupo_clinica_id', 'source', 'telefono', 'call_initiated',
        'created_at',
      ],
      order: [['id', 'ASC']],
      limit: 100,
      raw: true,
    });
    if (!rows.length) break;
    for (const lead of rows) {
      cursor = Math.max(cursor, Number(lead.id) || cursor);
      if (!cleanString(lead.telefono)) continue;
      const eventKind = resolveLeadEventKind(lead);
      if (!config.sources.includes(eventKind)) continue;
      const contactState = await evaluatePendingLeadContact({
        leadId: lead.id,
        triggeredAt: lead.created_at || new Date(),
      });
      if (contactState.decision) ids.push(lead.id);
    }
    if (rows.length < 100) break;
  }
  return ids;
}

async function getPendingPreview(clinicId) {
  const flow = await findLatestClinicFlow(clinicId);
  const config = normalizeConfig(flow?.trigger_config || {});
  if (!flow || !config.configured || !config.sources.length) {
    return { clinic_id: clinicId, count: 0, configured: false };
  }
  const leadIds = await listPendingLeadIds(clinicId, config);
  return { clinic_id: clinicId, count: leadIds.length, configured: true };
}

async function startPendingBatch({ clinicId, actorUserId }) {
  const flow = await findLatestClinicFlow(clinicId, { activeOnly: true });
  if (!flow) {
    const error = new Error('Activa la automatización antes de enviar a los leads pendientes.');
    error.status = 409;
    error.code = 'lead_auto_reply_not_active';
    throw error;
  }
  const config = normalizeConfig(flow.trigger_config || {});
  const leadIds = await listPendingLeadIds(clinicId, config);
  if (!leadIds.length) {
    return { job_id: null, total: 0, status: 'completed' };
  }
  const initialSummary = {
    clinic_id: clinicId,
    total: leadIds.length,
    processed: 0,
    queued: 0,
    skipped: 0,
    execution_ids: [],
  };
  const { job } = await jobRequestsService.enqueueUniqueJobRequest({
    type: BACKFILL_JOB_TYPE,
    priority: 'high',
    origin: FEATURE_KEY,
    payload: {
      clinic_id: clinicId,
      flow_id: flow.id,
      lead_ids: leadIds,
    },
    resultSummary: initialSummary,
    dedupeScope: `${BACKFILL_JOB_TYPE}:clinic:${clinicId}`,
    requestedBy: actorUserId,
    requestedByRole: 'user',
  });
  jobScheduler.triggerImmediate(job.id).catch(() => {});
  return { job_id: job.id, total: leadIds.length, status: cleanString(job.status) || 'pending' };
}

async function runPendingBatchJob(payload = {}, jobRequest = null) {
  const clinicId = toIntOrNull(payload.clinic_id);
  const leadIds = Array.from(new Set((Array.isArray(payload.lead_ids) ? payload.lead_ids : [])
    .map(toIntOrNull)
    .filter(Boolean)));
  if (!clinicId || !leadIds.length) {
    return { clinic_id: clinicId, total: 0, processed: 0, queued: 0, skipped: 0, execution_ids: [] };
  }
  const summary = {
    clinic_id: clinicId,
    total: leadIds.length,
    processed: 0,
    queued: 0,
    skipped: 0,
    execution_ids: [],
  };
  for (const leadId of leadIds) {
    const lead = await db.LeadIntake.findOne({ where: { id: leadId, clinica_id: clinicId } });
    if (!lead) {
      summary.skipped += 1;
      summary.processed += 1;
      continue;
    }
    const contactState = await evaluatePendingLeadContact({
      leadId,
      triggeredAt: lead.created_at || lead.createdAt || new Date(),
    });
    if (!contactState.decision) {
      summary.skipped += 1;
      summary.processed += 1;
    } else {
      const result = await enqueueForLead({
        lead,
        eventKind: resolveLeadEventKind(lead),
        eventAt: new Date(),
        idempotencyScope: 'backfill',
        triggerData: {
          backfill: true,
          backfill_job_id: jobRequest?.id || null,
        },
      });
      if (result.execution_id) {
        summary.execution_ids.push(result.execution_id);
        summary.queued += 1;
      } else {
        summary.skipped += 1;
      }
      summary.processed += 1;
    }
    if (jobRequest?.update && (summary.processed % 5 === 0 || summary.processed === summary.total)) {
      await jobRequest.update({ result_summary: summary });
    }
  }
  return summary;
}

function unwrapBatchSummary(value) {
  if (value?.result && typeof value.result === 'object') return value.result;
  return value && typeof value === 'object' ? value : {};
}

async function getPendingBatchProgress({ clinicId, jobId }) {
  const job = await db.JobRequest.findByPk(jobId, { raw: true });
  if (!job || cleanString(job.type) !== BACKFILL_JOB_TYPE || toIntOrNull(job.payload?.clinic_id) !== clinicId) {
    const error = new Error('Envío de leads pendientes no encontrado.');
    error.status = 404;
    error.code = 'lead_auto_reply_batch_not_found';
    throw error;
  }
  const summary = unwrapBatchSummary(job.result_summary);
  const executionIds = Array.from(new Set((Array.isArray(summary.execution_ids) ? summary.execution_ids : [])
    .map(toIntOrNull)
    .filter(Boolean)));
  const executions = executionIds.length
    ? await db.FlowExecutionV2.findAll({
        where: { id: { [Op.in]: executionIds }, clinic_id: clinicId },
        attributes: ['id', 'status', 'context', 'last_error'],
        raw: true,
      })
    : [];
  let sent = 0;
  let failed = 0;
  let pending = 0;
  for (const execution of executions) {
    const status = cleanString(execution.status).toLowerCase();
    const sendOutput = execution.context?.outputs?.N7 || {};
    if (sendOutput.message_id && ['sent', 'queued'].includes(cleanString(sendOutput.status).toLowerCase())) sent += 1;
    else if (cleanString(sendOutput.status).toLowerCase() === 'error' || ['failed', 'dead_letter'].includes(status)) failed += 1;
    else if (['completed', 'cancelled'].includes(status)) summary.skipped = Number(summary.skipped || 0) + 1;
    else pending += 1;
  }
  const total = Number(summary.total || 0);
  const skipped = Number(summary.skipped || 0);
  const jobTerminal = ['completed', 'failed', 'cancelled'].includes(cleanString(job.status).toLowerCase());
  const complete = jobTerminal && pending === 0 && sent + failed + skipped >= total;
  return {
    job_id: job.id,
    job_status: job.status,
    total,
    processed: Math.min(total, sent + failed + skipped),
    sent,
    failed,
    skipped,
    pending: Math.max(pending, total - sent - failed - skipped),
    complete,
    error: job.status === 'failed' ? cleanString(job.error_message) || 'No se pudo completar el envío.' : null,
  };
}

module.exports = {
  BACKFILL_JOB_TYPE,
  BASE_TEMPLATE_KEY,
  CATALOG_NAME,
  FEATURE_KEY,
  FLOW_NAME,
  buildManagedNodes,
  clinicTemplateKey,
  enqueueForLead,
  evaluatePendingLeadContact,
  getStatus,
  getPendingBatchProgress,
  getPendingPreview,
  getUnsupportedLeadTemplateVariables,
  isEffectiveContactAttempt,
  isLeadAutoReplyTemplate,
  normalizeConfig,
  runPendingBatchJob,
  saveConfig,
  startPendingBatch,
  setActive,
  validateFlowActivation,
};
