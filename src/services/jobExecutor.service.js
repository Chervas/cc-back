const { metaSyncJobs } = require('../jobs/sync.jobs');
const db = require('../../models');
const flowEngineV2Service = require('./flowEngineV2.service');
const { buildNotificationContent } = require('./notifications.service');

const DEFAULT_TIMEOUT_MS = Number(process.env.JOB_EXECUTOR_MAX_RUNTIME_MS || 30 * 60 * 1000);
const DEFAULT_WAITING_BACKOFF_MS = Number(process.env.JOB_SCHEDULER_WAITING_BACKOFF_MS || 15 * 60 * 1000);
const DEFAULT_FLOW_WAITING_BACKOFF_MS = Number(process.env.FLOW_V2_WAITING_BACKOFF_MS || 60 * 1000);

const FlowExecutionV2 = db.FlowExecutionV2;
const LeadIntake = db.LeadIntake;
const Notification = db.Notification;
const Clinica = db.Clinica;

async function runAutomationFlowV2Job(payload = {}) {
  const executionId = Number(payload.execution_id || 0);
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
  if (payload.resume_mode === 'response' || payload.resume_mode === 'timeout' || payload.resume_mode === 'form_submission') {
    options.resumeMode = payload.resume_mode;
  } else if (execution.status === 'waiting') {
    options.resumeMode = 'timeout';
  }

  if (payload.response_text !== undefined) {
    options.responseText = payload.response_text;
  }

  if (payload.form_submission !== undefined) {
    options.formSubmission = payload.form_submission;
  } else if (options.resumeMode === 'form_submission') {
    const pendingForm = execution?.waiting_meta?.pending_form_submission;
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

  await Notification.create({
    userId,
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

const JOB_HANDLERS = {
  meta_ads_recent: async (payload = {}) => metaSyncJobs.executeAdsSync(payload),
  meta_ads_midday: async (payload = {}) => metaSyncJobs.executeAdsSync({ ...payload, windowLabel: 'midday' }),
  meta_ads_backfill: async (payload = {}) => metaSyncJobs.executeAdsBackfill(payload),
  meta_ads_backfill_for_sites: async (payload = {}) => metaSyncJobs.executeAdsBackfillForSites?.(payload) ?? metaSyncJobs.executeAdsBackfill(payload),
  google_ads_recent: async (payload = {}) => metaSyncJobs.executeGoogleAdsSync(payload),
  google_ads_backfill: async (payload = {}) => metaSyncJobs.executeGoogleAdsBackfill(payload),
  web_recent: async (payload = {}) => metaSyncJobs.executeWebSync(payload),
  web_backfill: async (payload = {}) => metaSyncJobs.executeWebBackfill(payload),
  analytics_recent: async (payload = {}) => metaSyncJobs.executeAnalyticsSync(payload),
  analytics_backfill: async (payload = {}) => metaSyncJobs.executeAnalyticsBackfill(payload),
  analytics_backfill_properties: async (payload = {}) => metaSyncJobs.executeAnalyticsBackfillForProperties(payload.mappings || []),
  automations_v2_execute: async (payload = {}) => runAutomationFlowV2Job(payload),
  lead_callback_reminder_notify: async (payload = {}, jobRequest) => runLeadCallbackReminderJob(payload, jobRequest),
};

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
  const handler = JOB_HANDLERS[jobRequest.type];
  if (!handler) {
    throw new Error(`No handler registered for job type '${jobRequest.type}'`);
  }

  try {
    const payload = jobRequest.payload || {};
    const result = await asPromiseWithTimeout(
      handler(payload, jobRequest),
      DEFAULT_TIMEOUT_MS
    );

    if (result && result.status === 'waiting') {
      const nextRunAt = resolveNextRun({
        pauseUntil: result.nextAllowedAt || result.pauseUntil,
        backoffMs: result.backoffMs
      });
      return {
        status: 'waiting',
        nextRunAt,
        syncLogId: result.syncLogId || null,
        result
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
      return {
        status: 'waiting',
        nextRunAt: resolveNextRun({ backoffMs: DEFAULT_WAITING_BACKOFF_MS }),
        syncLogId: null,
        error: new Error('Se excedió el tiempo máximo de ejecución')
      };
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
  JOB_HANDLERS
};
