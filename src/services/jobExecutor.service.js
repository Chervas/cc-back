const { metaSyncJobs } = require('../jobs/sync.jobs');
const fs = require('fs');
const db = require('../../models');
const flowEngineV2Service = require('./flowEngineV2.service');
const whatsappCoexistenceService = require('./whatsappCoexistence.service');
const whatsappTemplatesService = require('./whatsappTemplates.service');
const marketingBulkSendsService = require('./marketingBulkSends.service');
const googleReviewMatchService = require('./googleReviewMatch.service');
const intakeQuickChatOutboxService = require('./intakeQuickChatOutbox.service');
const { buildNotificationContent } = require('./notifications.service');
const { emitNotificationCreated } = require('./notificationsRealtime.service');
const {
  SCHEDULED_JOB_DEFINITIONS,
  BACKGROUND_INTEGRATION_JOB_TYPES,
} = require('../config/scheduledJobCatalog');

const DEFAULT_TIMEOUT_MS = Number(process.env.JOB_EXECUTOR_MAX_RUNTIME_MS || 30 * 60 * 1000);
const DEFAULT_WAITING_BACKOFF_MS = Number(process.env.JOB_SCHEDULER_WAITING_BACKOFF_MS || 15 * 60 * 1000);
const DEFAULT_FLOW_WAITING_BACKOFF_MS = Number(process.env.FLOW_V2_WAITING_BACKOFF_MS || 60 * 1000);
const BACKGROUND_INTEGRATION_TYPES = new Set(BACKGROUND_INTEGRATION_JOB_TYPES);

const FlowExecutionV2 = db.FlowExecutionV2;
const LeadIntake = db.LeadIntake;
const Notification = db.Notification;
const Clinica = db.Clinica;

async function runAutomationFlowV2Job(payload = {}) {
  const executionId = Number(payload.execution_id || payload.executionId || 0);
  try {
    fs.appendFileSync('/tmp/cc-job-debug.log', `${JSON.stringify({
      ts: new Date().toISOString(),
      source: 'back-integracion',
      stage: 'runAutomationFlowV2Job:start',
      pid: process.pid,
      cwd: process.cwd(),
      port: process.env.PORT || null,
      runtimeNamespace: process.env.JOB_RUNTIME_NAMESPACE || process.env.RUNTIME_NAMESPACE || null,
      hasGroqKey: !!String(process.env.GROQ_API_KEY || '').trim(),
      executionId,
      payload,
    })}\n`);
  } catch (_) {
    // no-op debug fallback
  }
  if (!Number.isInteger(executionId) || executionId <= 0) {
    throw new Error('automations_v2_execute requires payload.execution_id');
  }

  const execution = await FlowExecutionV2.findByPk(executionId);
  if (!execution) {
    return {
      status: 'completed',
      result: {
        execution_id: executionId,
        skipped: true,
        reason: 'execution_not_found',
      },
    };
  }

  if (['completed', 'failed', 'dead_letter', 'cancelled'].includes(execution.status)) {
    return {
      status: 'completed',
      result: {
        execution_id: execution.id,
        already_terminal: true,
        execution_status: execution.status,
      },
    };
  }

  const options = {};
  const waitingMeta = execution?.waiting_meta && typeof execution.waiting_meta === 'object'
    ? execution.waiting_meta
    : {};
  const waitingResumeMode = typeof waitingMeta.resume_mode === 'string'
    ? waitingMeta.resume_mode.trim().toLowerCase()
    : '';

  if (payload.resume_mode === 'response' || payload.resume_mode === 'timeout' || payload.resume_mode === 'form_submission') {
    options.resumeMode = payload.resume_mode;
  } else if (execution.status === 'waiting') {
    if (
      waitingResumeMode === 'response'
      || waitingResumeMode === 'timeout'
      || waitingResumeMode === 'form_submission'
      || waitingResumeMode === 'retry_current_node'
    ) {
      options.resumeMode = waitingResumeMode;
    } else {
      options.resumeMode = 'timeout';
    }
  }

  if (payload.response_text !== undefined) {
    options.responseText = payload.response_text;
  } else if (options.resumeMode === 'response' && waitingMeta.pending_response_text !== undefined) {
    options.responseText = waitingMeta.pending_response_text;
  }

  if (payload.inbound_message_id !== undefined) {
    options.inboundMessageId = payload.inbound_message_id;
  }
  if (payload.response_media_kind !== undefined) {
    options.responseMediaKind = payload.response_media_kind;
  }
  if (payload.response_media_id !== undefined) {
    options.responseMediaId = payload.response_media_id;
  }
  if (payload.response_media_mime_type !== undefined) {
    options.responseMediaMimeType = payload.response_media_mime_type;
  }

  if (payload.form_submission !== undefined) {
    options.formSubmission = payload.form_submission;
  } else if (options.resumeMode === 'form_submission') {
    const pendingForm = waitingMeta.pending_form_submission;
    if (pendingForm && typeof pendingForm === 'object') {
      options.formSubmission = pendingForm;
    }
  }

  const updated = await flowEngineV2Service.runExecution(execution.id, options);

  if (updated.status === 'waiting') {
    return {
      status: 'waiting',
      nextAllowedAt: updated.wait_until || new Date(Date.now() + DEFAULT_FLOW_WAITING_BACKOFF_MS),
      result: {
        execution_id: updated.id,
        execution_status: updated.status,
        current_node_id: updated.current_node_id,
        wait_until: updated.wait_until,
      },
    };
  }

  if (updated.status === 'failed' || updated.status === 'dead_letter') {
    return {
      status: 'failed',
      nextRunAt: null,
      error: new Error(updated.last_error || `flow_execution_${updated.status}`),
      result: {
        execution_id: updated.id,
        execution_status: updated.status,
        last_error: updated.last_error || null,
      },
    };
  }

  return {
    status: 'completed',
    result: {
      execution_id: updated.id,
      execution_status: updated.status,
      current_node_id: updated.current_node_id,
    },
  };
}

async function runWhatsappTemplateCreateJob(payload = {}) {
  const wabaId = String(payload.wabaId || payload.waba_id || '').trim();
  if (!wabaId) {
    throw new Error('whatsapp_template_create requires payload.wabaId');
  }

  if (String(payload.mode || '').trim() === 'resubmit_stale_pending') {
    const result = await whatsappTemplatesService.runStalePendingTemplateResubmission(payload);
    return {
      status: 'completed',
      result: {
        wabaId,
        mode: 'resubmit_stale_pending',
        ...result,
      },
    };
  }

  const clinicId = payload.clinicId ?? payload.clinic_id ?? null;
  const groupId = payload.groupId ?? payload.group_id ?? null;
  const assignmentScope = payload.assignmentScope || payload.assignment_scope || 'unassigned';

  await whatsappTemplatesService.createTemplatesFromCatalog({
    wabaId,
    clinicId,
    groupId,
    assignmentScope,
  });

  return {
    status: 'completed',
    result: {
      wabaId,
      clinicId,
      groupId,
      assignmentScope,
    },
  };
}

async function runLeadCallbackReminderJob(payload = {}, jobRequest = null) {
  const leadId = Number(payload.lead_id || 0);
  if (!Number.isInteger(leadId) || leadId <= 0) {
    throw new Error('lead_callback_reminder_notify requires payload.lead_id');
  }

  const lead = await LeadIntake.findByPk(leadId, {
    attributes: [
      'id',
      'clinica_id',
      'nombre',
      'callback_reminder_at',
      'callback_reminder_reason',
      'callback_reminder_notes',
      'callback_reminder_created_by',
      'callback_reminder_job_id',
      'callback_reminder_notified_at',
    ],
    raw: true,
  });

  if (!lead) {
    return {
      status: 'completed',
      result: { skipped: true, reason: 'lead_not_found', lead_id: leadId },
    };
  }

  const expectedJobId = Number(lead.callback_reminder_job_id || 0);
  if (jobRequest?.id && expectedJobId && expectedJobId !== Number(jobRequest.id)) {
    return {
      status: 'completed',
      result: { skipped: true, reason: 'stale_job', lead_id: leadId },
    };
  }

  if (!lead.callback_reminder_at) {
    return {
      status: 'completed',
      result: { skipped: true, reason: 'reminder_cleared', lead_id: leadId },
    };
  }

  const reminderAt = new Date(lead.callback_reminder_at);
  if (!Number.isFinite(reminderAt.getTime())) {
    return {
      status: 'completed',
      result: { skipped: true, reason: 'invalid_reminder_at', lead_id: leadId },
    };
  }

  if (reminderAt.getTime() > Date.now()) {
    return {
      status: 'waiting',
      nextAllowedAt: reminderAt,
      result: { waiting: true, lead_id: leadId },
    };
  }

  const userId = Number(lead.callback_reminder_created_by || payload.user_id || 0);
  if (!Number.isInteger(userId) || userId <= 0) {
    return {
      status: 'completed',
      result: { skipped: true, reason: 'missing_target_user', lead_id: leadId },
    };
  }

  const clinic = lead.clinica_id
    ? await Clinica.findByPk(lead.clinica_id, { attributes: ['id_clinica', 'nombre_clinica'], raw: true })
    : null;
  const reminderAtLabel = new Intl.DateTimeFormat('es-ES', {
    timeZone: 'Europe/Madrid',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(reminderAt);
  const content = buildNotificationContent('crm.call_back_reminder', {
    leadName: lead.nombre || 'Lead',
    clinicName: clinic?.nombre_clinica || null,
    reason: lead.callback_reminder_reason || null,
    reminderAtLabel,
  });

  const notification = await Notification.create({
    userId,
    role: '',
    subrole: '',
    category: 'crm',
    event: 'crm.call_back_reminder',
    title: content.title,
    message: content.message,
    icon: content.icon,
    level: content.level,
    clinicaId: lead.clinica_id || null,
    data: {
      link: '/marketing/leads',
      useRouter: true,
      leadId: lead.id,
      clinicId: lead.clinica_id || null,
      reminderAt: reminderAt.toISOString(),
      reason: lead.callback_reminder_reason || null,
      notes: lead.callback_reminder_notes || null,
    },
  });
  emitNotificationCreated(notification);

  await LeadIntake.update({
    callback_reminder_job_id: null,
    callback_reminder_notified_at: new Date(),
  }, {
    where: { id: lead.id },
  });

  return {
    status: 'completed',
    result: {
      lead_id: lead.id,
      notified_user_id: userId,
    },
  };
}

async function runAppointmentAutomationScheduleJob(payload = {}) {
  const appointmentId = Number(payload.appointment_id || 0);
  if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
    throw new Error('appointment_automation_schedule_fire requires payload.appointment_id');
  }

  // Carga diferida para evitar circularidad con appointmentAutomationV2Runtime -> jobScheduler -> jobExecutor.
  const appointmentAutomationV2Runtime = require('./appointmentAutomationV2Runtime.service');
  const result = await appointmentAutomationV2Runtime.fireScheduledTrigger(payload);

  if (result?.waiting && result?.scheduled_for) {
    return {
      status: 'waiting',
      nextAllowedAt: new Date(result.scheduled_for),
      result,
    };
  }

  return {
    status: 'completed',
    result,
  };
}

function buildScheduledJobHandlers() {
  return Object.values(SCHEDULED_JOB_DEFINITIONS).reduce((handlers, definition) => {
    handlers[definition.type] = async (payload = {}, jobRequest = null) => {
      const executor = metaSyncJobs[definition.executorMethod];
      if (typeof executor !== 'function') {
        throw new Error(
          `Scheduled job '${definition.type}' references missing executor '${definition.executorMethod}'`
        );
      }
      const executorPayload = {
        ...(definition.payloadDefaults || {}),
        ...(payload || {}),
      };
      if (definition.attachJobRequestId && jobRequest?.id) {
        executorPayload.jobRequestId = jobRequest.id;
      }
      const result = await executor.call(metaSyncJobs, executorPayload);
      if (
        result?.status === 'failed'
        && result.retryable === undefined
        && definition.reportedFailureRetryable === false
      ) {
        return { ...result, retryable: false };
      }
      return result;
    };
    return handlers;
  }, {});
}

const JOB_HANDLERS = {
  ...buildScheduledJobHandlers(),
  meta_ads_backfill_for_sites: async (payload = {}) => {
    const mappings = Array.isArray(payload.mappings) ? payload.mappings : [];
    const clinicIds = Array.from(new Set([
      ...(Array.isArray(payload.clinicIds) ? payload.clinicIds : []),
      ...mappings.map((item) => item?.clinicId ?? item?.clinicaId),
    ].map(Number).filter(Number.isFinite)));
    if (!clinicIds.length) {
      throw new Error('meta_ads_backfill_for_sites requires mappings or clinicIds');
    }
    return metaSyncJobs.executeAdsBackfill({ ...payload, clinicIds });
  },
  web_backfill_for_sites: async (payload = {}) => metaSyncJobs.executeWebBackfillForSites(payload.siteMappings || payload.mappings || []),
  analytics_backfill_properties: async (payload = {}) => metaSyncJobs.executeAnalyticsBackfillForProperties(payload.mappings || []),
  business_profile_backfill_locations: async (payload = {}) => metaSyncJobs.executeBusinessProfileBackfillForLocations(payload.mappings || []),
  business_profile_review_match: async (payload = {}) => googleReviewMatchService.runBusinessProfileReviewMatchJob(payload),
  whatsapp_coexistence_sync_contacts: async (payload = {}) => whatsappCoexistenceService.runContactsSyncJob(payload),
  whatsapp_coexistence_sync_history: async (payload = {}) => whatsappCoexistenceService.runHistorySyncJob(payload),
  whatsapp_template_create: async (payload = {}) => runWhatsappTemplateCreateJob(payload),
  whatsapp_template_sync_delayed: async (payload = {}) => whatsappTemplatesService.runDelayedSyncTemplatesJob(payload),
  marketing_bulk_send_dispatch: async (payload = {}, jobRequest) => marketingBulkSendsService.runDispatchJob(payload, jobRequest),
  marketing_review_request_reminder: async (payload = {}, jobRequest) => marketingBulkSendsService.runReviewRequestReminderJob(payload, jobRequest),
  marketing_review_request_no_response: async (payload = {}, jobRequest) => marketingBulkSendsService.runReviewNoResponseJob(payload, jobRequest),
  automations_v2_execute: async (payload = {}) => runAutomationFlowV2Job(payload),
  automation_whatsapp_quiet_send: async (payload = {}) => flowEngineV2Service.runScheduledWhatsappSendJob(payload),
  appointment_automation_schedule_fire: async (payload = {}) => runAppointmentAutomationScheduleJob(payload),
  lead_callback_reminder_notify: async (payload = {}, jobRequest) => runLeadCallbackReminderJob(payload, jobRequest),
  intake_quickchat_summary_materialize: async (payload = {}) => (
    intakeQuickChatOutboxService.runIntakeQuickChatSummaryMaterializeJob(payload)
  ),
};

function normalizeJobType(value) {
  return String(value || '').trim().toLowerCase();
}

const asPromiseWithTimeout = (promise, timeoutMs) => {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('JOB_EXECUTOR_TIMEOUT')), timeoutMs);
  });

  return Promise.race([
    promise.finally(() => clearTimeout(timeoutId)),
    timeoutPromise
  ]);
};

const shouldUseExecutionTimeout = (jobType) => !BACKGROUND_INTEGRATION_TYPES.has(normalizeJobType(jobType));

const buildTimeoutFailureResult = () => ({
  status: 'failed',
  nextRunAt: null,
  syncLogId: null,
  retryable: false,
  error: new Error(
    'Se excedió el tiempo máximo; no se reintentará automáticamente porque la ejecución original no puede cancelarse'
  ),
});

const asNonNegativeCount = (value) => {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : null;
};

const readFirstCount = (containers, keys) => {
  for (const container of containers) {
    if (!container || typeof container !== 'object') continue;
    for (const key of keys) {
      const count = asNonNegativeCount(container[key]);
      if (count !== null) return count;
    }
  }
  return null;
};

function normalizeScheduledExecutionResult(result) {
  if (!result || result.status !== 'completed') {
    return result;
  }

  const containers = [result, result.report, result.status_report].filter(Boolean);
  const errorCount = Math.max(0, ...containers.map((container) => {
    const value = container?.errors;
    return Array.isArray(value) ? value.length : (asNonNegativeCount(value) || 0);
  }));

  if (!errorCount) {
    return result;
  }

  const processed = readFirstCount(containers, [
    'processedAccounts',
    'processedProperties',
    'processedLocations',
    'processedAssets',
    'processedSites',
    'processed',
    'recordsProcessed',
    'records_processed',
    'succeeded',
    'successes',
  ]) || 0;
  const explicitEligible = readFirstCount(containers, [
    'accounts',
    'properties',
    'locations',
    'assets',
    'sites',
    'campaigns',
    'eligible',
    'checked',
    'scanned',
    'total',
  ]);
  const eligible = Math.max(explicitEligible || 0, processed + errorCount);

  if (eligible > 0 && processed === 0) {
    return {
      ...result,
      status: 'failed',
      retryable: true,
      total_failure: true,
      outcome: { eligible, processed, errors: errorCount },
    };
  }

  return {
    ...result,
    status: 'completed_with_errors',
    partial: true,
    outcome: { eligible, processed, errors: errorCount },
  };
}

function resolveNextRun({ pauseUntil, backoffMs }) {
  if (pauseUntil) {
    const resume = new Date(pauseUntil);
    if (!Number.isNaN(resume.getTime())) {
      return resume;
    }
  }
  const ms = Number(backoffMs);
  const safeMs = Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_WAITING_BACKOFF_MS;
  return new Date(Date.now() + safeMs);
}

async function runJob(jobRequest) {
  const jobType = normalizeJobType(jobRequest?.type);
  let handler = JOB_HANDLERS[jobType];
  if (!handler && jobType === 'automations_v2_execute') {
    // Salvaguarda frente a estados parciales de carga del módulo en arranque.
    handler = async (payload = {}) => runAutomationFlowV2Job(payload);
  }
  if (!handler) {
    throw new Error(`No handler registered for job type '${jobType || jobRequest?.type || 'unknown'}'`);
  }

  try {
    const payload = jobRequest.payload || {};
    const execution = Promise.resolve().then(() => handler(payload, jobRequest));
    // Promise.race no cancela el handler original. Los cron del catálogo deben
    // finalizar por sí mismos para que nunca se reprograme un segundo barrido
    // mientras el primero aún puede seguir mutando proveedores o la BD.
    const rawResult = shouldUseExecutionTimeout(jobType)
      ? await asPromiseWithTimeout(execution, DEFAULT_TIMEOUT_MS)
      : await execution;
    const result = BACKGROUND_INTEGRATION_TYPES.has(jobType)
      ? normalizeScheduledExecutionResult(rawResult)
      : rawResult;

    if (result && result.status === 'waiting') {
      const nextRunAt = resolveNextRun({
        pauseUntil: result.nextAllowedAt || result.pauseUntil,
        backoffMs: result.backoffMs
      });
      return {
        status: 'waiting',
        nextRunAt,
        syncLogId: result.syncLogId || null,
        error: result.error instanceof Error ? result.error : null,
        result
      };
    }

    if (result && result.status === 'failed') {
      const handlerError = result.error instanceof Error
        ? result.error
        : new Error(result.error_message || `${jobType} devolvió estado failed`);
      return {
        status: 'failed',
        nextRunAt: null,
        syncLogId: result.syncLogId || null,
        error: handlerError,
        retryable: result.retryable !== false,
        result,
      };
    }

    return {
      status: 'completed',
      nextRunAt: null,
      syncLogId: result?.syncLogId || null,
      result
    };
  } catch (error) {
    if (error && error.message === 'JOB_EXECUTOR_TIMEOUT') {
      return buildTimeoutFailureResult();
    }

    return {
      status: 'failed',
      nextRunAt: null,
      syncLogId: null,
      error
    };
  }
}

module.exports = {
  runJob,
  JOB_HANDLERS,
  _shouldUseExecutionTimeout: shouldUseExecutionTimeout,
  _buildTimeoutFailureResult: buildTimeoutFailureResult,
  _normalizeScheduledExecutionResult: normalizeScheduledExecutionResult,
};
