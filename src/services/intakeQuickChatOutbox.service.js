'use strict';

const db = require('../../models');
const jobRequestsService = require('./jobRequests.service');
const {
  isQuickChatSummaryRequest,
  materializeIntakeQuickChatSummary,
  validateQuickChatContact,
} = require('./intakeQuickChatSummary.service');

const INTAKE_QUICKCHAT_SUMMARY_JOB_TYPE = 'intake_quickchat_summary_materialize';
const INTAKE_QUICKCHAT_SUMMARY_MAX_ATTEMPTS = 5;
const SAFE_QUICKCHAT_4XX_MESSAGES = Object.freeze({
  quickchat_summary_clinic_mismatch: 'El lead pertenece a otra clínica',
  quickchat_summary_lead_missing: 'El lead del resumen ya no está disponible',
  quickchat_summary_clinic_required: 'Se necesita una clínica para crear el resumen QuickChat',
  quickchat_summary_phone_required: 'Se necesita un teléfono válido para crear el resumen QuickChat',
  quickchat_summary_conversation_unavailable: 'No se pudo crear la conversación QuickChat',
  quickchat_summary_resolved_clinic_invalid: 'La sede resuelta del resumen QuickChat no es válida',
});

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function plainObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function isCompletedChatbotLeadRequest(body = {}) {
  return String(body?.source_detail || body?.sourceDetail || '').trim().toLowerCase() === 'chatbot'
    && body?.chat_state
    && typeof body.chat_state === 'object'
    && !Array.isArray(body.chat_state);
}

function isQuickChatOutboxRequest(body = {}) {
  return isCompletedChatbotLeadRequest(body) || isQuickChatSummaryRequest(body);
}

function createValidationError(code, message) {
  const error = new Error(message);
  error.status = 422;
  error.code = code;
  return error;
}

function safeQuickChat4xxResult(error, { leadId, auditId } = {}) {
  const status = Number(error?.status);
  const errorCode = String(error?.code || 'invalid_quickchat_summary');
  return {
    skipped: true,
    reason: errorCode,
    http_status: Number.isInteger(status) && status >= 400 && status < 500 ? status : null,
    error_code: errorCode,
    ...(SAFE_QUICKCHAT_4XX_MESSAGES[errorCode]
      ? { error_message: SAFE_QUICKCHAT_4XX_MESSAGES[errorCode] }
      : {}),
    lead_id: Number(leadId),
    audit_id: Number(auditId),
  };
}

/**
 * Outbox transaccional del resumen interno de un chat terminado.
 *
 * El payload durable contiene solo las dos claves locales necesarias para
 * reconstruir el input desde LeadAttributionAudits. El teléfono, email, texto
 * del chat, click IDs y consentimiento permanecen fuera de JobRequests.
 */
async function persistLeadAuditAndQuickChatOutbox({
  createLead,
  rawPayload = {},
  attributionSteps = {},
} = {}, overrides = {}) {
  if (typeof createLead !== 'function') {
    throw new Error('createLead is required for the QuickChat intake outbox');
  }

  const sequelize = overrides.sequelize || db.sequelize;
  const LeadAttributionAudit = overrides.LeadAttributionAudit || db.LeadAttributionAudit;
  const enqueueJobRequest = overrides.enqueueJobRequest || jobRequestsService.enqueueJobRequest;
  const suppliedTransaction = overrides.transaction || null;

  const persist = async (transaction) => {
    const lead = await createLead(transaction);
    const leadId = positiveInteger(lead?.id);
    if (!leadId) {
      throw new Error('The QuickChat intake outbox requires a persisted lead');
    }

    const contact = validateQuickChatContact({ body: rawPayload, lead });
    if (!contact.phone_valid) {
      throw createValidationError(
        'quickchat_phone_invalid',
        'Introduce un teléfono válido de entre 9 y 15 dígitos'
      );
    }
    if (!contact.email_valid) {
      throw createValidationError(
        'quickchat_email_invalid',
        'Introduce un email válido o deja el campo vacío'
      );
    }

    const audit = await LeadAttributionAudit.create({
      lead_intake_id: leadId,
      raw_payload: rawPayload || {},
      attribution_steps: attributionSteps || {},
    }, { transaction });
    const auditId = positiveInteger(audit?.id);
    if (!auditId) {
      throw new Error('The QuickChat intake outbox requires a persisted attribution audit');
    }

    const job = await enqueueJobRequest({
      type: INTAKE_QUICKCHAT_SUMMARY_JOB_TYPE,
      priority: 'high',
      status: 'pending',
      origin: 'intake_chatbot_outbox',
      maxAttempts: INTAKE_QUICKCHAT_SUMMARY_MAX_ATTEMPTS,
      payload: {
        lead_id: leadId,
        audit_id: auditId,
      },
    }, { transaction });

    return { lead, audit, job };
  };

  if (suppliedTransaction) return persist(suppliedTransaction);
  return sequelize.transaction(persist);
}

/**
 * Variante para un intake deduplicado. Bloquea y relee el lead canónico dentro
 * de la misma transacción que conserva el audit del payload actual y encola el
 * outbox. Así cada cierre de chat tiene una prueba durable aunque no cree otro
 * LeadIntake.
 */
async function persistExistingLeadAuditAndQuickChatOutbox({
  leadId,
  rawPayload = {},
  attributionSteps = {},
  leadUpdates = {},
} = {}, overrides = {}) {
  const normalizedLeadId = positiveInteger(leadId);
  if (!normalizedLeadId) {
    throw new Error('leadId is required for a deduplicated QuickChat intake outbox');
  }

  const sequelize = overrides.sequelize || db.sequelize;
  const LeadIntake = overrides.LeadIntake || db.LeadIntake;
  const suppliedTransaction = overrides.transaction || null;

  const persist = async (transaction) => persistLeadAuditAndQuickChatOutbox({
    createLead: async () => {
      const findOptions = { transaction };
      if (transaction?.LOCK?.UPDATE) findOptions.lock = transaction.LOCK.UPDATE;
      const lead = await LeadIntake.findByPk(normalizedLeadId, findOptions);
      if (!lead) {
        const error = new Error('The deduplicated QuickChat lead no longer exists');
        error.status = 409;
        error.code = 'quickchat_deduplicated_lead_not_found';
        throw error;
      }

      const patch = leadUpdates && typeof leadUpdates === 'object' && !Array.isArray(leadUpdates)
        ? leadUpdates
        : {};
      if (Object.keys(patch).length) {
        await lead.update(patch, { transaction });
      }
      return lead;
    },
    rawPayload,
    attributionSteps,
  }, {
    ...overrides,
    transaction,
  });

  if (suppliedTransaction) return persist(suppliedTransaction);
  return sequelize.transaction(persist);
}

function extractPageUrl(body = {}) {
  const attribution = plainObject(body.attribution);
  return attribution.page_url || body.page_url || body.pageUrl || null;
}

function extractLandingUrl(body = {}) {
  const attribution = plainObject(body.attribution);
  return attribution.landing_url || body.landing_url || body.landingUrl || null;
}

function safeMaterializationResult(result, auditId) {
  return {
    quickchat_summary_saved: true,
    created: result.created === true,
    updated: result.updated === true,
    consolidated: result.consolidated === true,
    audit_id: Number(auditId),
    lead_id: Number(result.lead_id),
    clinic_id: Number(result.clinic_id),
    conversation_id: Number(result.conversation_id),
    message_id: Number(result.message_id),
  };
}

function safeStaleMaterializationResult(result, auditId) {
  return {
    // El resumen durable sí existe, pero corresponde a un audit posterior. El
    // job antiguo completa como skip y no debe provocar un 500/reintento.
    quickchat_summary_saved: true,
    created: false,
    updated: false,
    consolidated: false,
    skipped: true,
    stale: true,
    reason: 'stale_audit',
    audit_id: Number(auditId),
    persisted_audit_id: Number(result.persisted_audit_id),
    lead_id: Number(result.lead_id),
    clinic_id: Number(result.clinic_id),
    conversation_id: Number(result.conversation_id),
    message_id: Number(result.message_id),
  };
}

function emitQuickChatSummarySocketEvent(result, overrides = {}) {
  if (!result?.message || (!result.created && !result.updated)) return;
  const getIO = overrides.getIO || require('./socket.service').getIO;
  const io = getIO();
  if (!io || !result.clinic_id) return;

  io.to(`clinic:${result.clinic_id}`).emit(
    result.created ? 'message:created' : 'message:updated',
    {
      ...result.message,
      conversation_id: String(result.conversation_id),
    }
  );
}

/**
 * Handler estándar de JobRequest. Relee el audit exacto y delega toda la
 * idempotencia de conversación/mensaje en materializeIntakeQuickChatSummary.
 */
async function runIntakeQuickChatSummaryMaterializeJob(payload = {}, overrides = {}) {
  const leadId = positiveInteger(payload.lead_id);
  const auditId = positiveInteger(payload.audit_id);
  if (!leadId || !auditId) {
    const error = new Error('intake_quickchat_summary_materialize requires payload.lead_id and payload.audit_id');
    return {
      status: 'failed',
      retryable: false,
      error,
      result: { skipped: true, reason: 'invalid_outbox_payload' },
    };
  }

  const LeadAttributionAudit = overrides.LeadAttributionAudit || db.LeadAttributionAudit;
  const materialize = overrides.materializeIntakeQuickChatSummary || materializeIntakeQuickChatSummary;
  const emitSummary = overrides.emitQuickChatSummarySocketEvent || emitQuickChatSummarySocketEvent;

  const audit = await LeadAttributionAudit.findOne({
    where: {
      id: auditId,
      lead_intake_id: leadId,
    },
    raw: true,
  });

  if (!audit) {
    const auditById = await LeadAttributionAudit.findByPk(auditId, { raw: true });
    if (auditById && Number(auditById.lead_intake_id) !== leadId) {
      const error = new Error('QuickChat outbox audit does not belong to its lead');
      return {
        status: 'failed',
        retryable: false,
        error,
        result: { skipped: true, reason: 'audit_lead_mismatch', lead_id: leadId, audit_id: auditId },
      };
    }
    return {
      status: 'completed',
      result: { skipped: true, reason: 'audit_not_found', lead_id: leadId, audit_id: auditId },
    };
  }

  const body = plainObject(audit.raw_payload);
  if (!isQuickChatOutboxRequest(body)) {
    const error = new Error('QuickChat outbox audit is not a supported chatbot summary request');
    return {
      status: 'failed',
      retryable: false,
      error,
      result: { skipped: true, reason: 'invalid_audit_payload', lead_id: leadId, audit_id: auditId },
    };
  }

  const attributionSteps = plainObject(audit.attribution_steps);
  const hasResolvedClinic = Object.prototype.hasOwnProperty.call(attributionSteps, 'resolved_clinic_id')
    && attributionSteps.resolved_clinic_id !== null
    && String(attributionSteps.resolved_clinic_id).trim() !== '';
  const resolvedClinicId = positiveInteger(attributionSteps.resolved_clinic_id);
  if (hasResolvedClinic && !resolvedClinicId) {
    const error = new Error('QuickChat outbox audit has an invalid resolved clinic');
    error.status = 422;
    error.code = 'quickchat_summary_resolved_clinic_invalid';
    return {
      status: 'failed',
      retryable: false,
      error,
      result: safeQuickChat4xxResult(error, { leadId, auditId }),
    };
  }

  try {
    const result = await materialize({
      leadId,
      // Audits nuevos fijan la sede decidida por intake. En audits legacy sin
      // marcador se omite y el materializador usa únicamente la sede del lead.
      clinicId: resolvedClinicId,
      auditId,
      body: {
        ...body,
        source_detail: 'chatbot_quickchat',
      },
      pageUrl: extractPageUrl(body),
      landingUrl: extractLandingUrl(body),
    });

    if (result.stale === true) {
      return {
        status: 'completed',
        result: safeStaleMaterializationResult(result, auditId),
      };
    }

    try {
      await emitSummary(result, overrides);
    } catch (emitError) {
      // El socket es una optimización de interfaz. La escritura durable ya se
      // completó y no debe repetirse solo porque falle una notificación realtime.
      console.warn('⚠️ No se pudo emitir el resumen QuickChat del outbox:', emitError.message || emitError);
    }

    return {
      status: 'completed',
      result: safeMaterializationResult(result, auditId),
    };
  } catch (error) {
    const status = Number(error?.status);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
      return {
        status: 'failed',
        retryable: false,
        error,
        result: safeQuickChat4xxResult(error, { leadId, auditId }),
      };
    }
    throw error;
  }
}

/**
 * Optimización post-commit: intenta consumir inmediatamente el mismo
 * JobRequest. Si falla, el estado waiting/failed queda en el orquestador; no
 * existe una segunda ejecución lateral ni se pierde el outbox.
 */
async function triggerIntakeQuickChatSummaryFastPath(jobId, overrides = {}) {
  const normalizedJobId = positiveInteger(jobId);
  if (!normalizedJobId) return null;

  const scheduler = overrides.jobScheduler || require('./jobScheduler.service');
  const requests = overrides.jobRequestsService || jobRequestsService;
  try {
    await scheduler.triggerImmediate(normalizedJobId);
  } catch (_triggerError) {
    // La ejecución puede haber llegado a commit/settlement antes de fallar la
    // llamada. La única fuente de verdad es la relectura durable inferior.
  }

  let job;
  try {
    job = await requests.findJobById(normalizedJobId);
  } catch (_readError) {
    return {
      quickchat_summary_saved: false,
      quickchat_summary_queued: false,
      quickchat_summary_outcome_unknown: true,
      quickchat_summary_state: 'unknown_durable',
      job_status: null,
    };
  }
  if (!job) {
    return {
      quickchat_summary_saved: false,
      quickchat_summary_queued: false,
      quickchat_summary_outcome_unknown: false,
      quickchat_summary_state: 'terminal',
      job_status: null,
    };
  }

  if (job.status === 'completed') {
    const summary = plainObject(job.result_summary);
    // JobExecutor puede dejar el resultado del handler bajo `result`, mientras
    // que callers directos/fixtures pueden persistir el objeto seguro sin ese
    // wrapper. Ambos formatos son durables y se leen de forma compatible.
    const result = Object.prototype.hasOwnProperty.call(summary, 'quickchat_summary_saved')
      || Object.prototype.hasOwnProperty.call(summary, 'error_code')
      || Object.prototype.hasOwnProperty.call(summary, 'reason')
      ? summary
      : plainObject(summary.result);
    if (result.quickchat_summary_saved === true) {
      return {
        ...result,
        quickchat_summary_queued: false,
        quickchat_summary_outcome_unknown: false,
        quickchat_summary_state: 'saved',
        job_status: 'completed',
      };
    }
  }

  const summary = plainObject(job.result_summary);
  const terminalResult = Object.prototype.hasOwnProperty.call(summary, 'http_status')
    || Object.prototype.hasOwnProperty.call(summary, 'error_code')
    || Object.prototype.hasOwnProperty.call(summary, 'reason')
    ? summary
    : plainObject(summary.result);
  const httpStatus = Number(terminalResult.http_status);
  const errorCode = String(terminalResult.error_code || '');

  return {
    quickchat_summary_saved: false,
    quickchat_summary_queued: ['pending', 'queued', 'running', 'waiting'].includes(job.status),
    quickchat_summary_outcome_unknown: false,
    quickchat_summary_state: ['pending', 'queued', 'running', 'waiting'].includes(job.status)
      ? 'queued'
      : 'terminal',
    ...(Number.isInteger(httpStatus) && httpStatus >= 400 && httpStatus < 500
      ? { http_status: httpStatus }
      : {}),
    ...(errorCode ? { error_code: errorCode } : {}),
    ...(errorCode && SAFE_QUICKCHAT_4XX_MESSAGES[errorCode]
      ? { error_message: SAFE_QUICKCHAT_4XX_MESSAGES[errorCode] }
      : {}),
    job_status: job.status || null,
  };
}

module.exports = {
  INTAKE_QUICKCHAT_SUMMARY_JOB_TYPE,
  INTAKE_QUICKCHAT_SUMMARY_MAX_ATTEMPTS,
  isCompletedChatbotLeadRequest,
  isQuickChatOutboxRequest,
  persistLeadAuditAndQuickChatOutbox,
  persistExistingLeadAuditAndQuickChatOutbox,
  runIntakeQuickChatSummaryMaterializeJob,
  triggerIntakeQuickChatSummaryFastPath,
  emitQuickChatSummarySocketEvent,
  __testing: {
    plainObject,
    safeMaterializationResult,
    safeStaleMaterializationResult,
    safeQuickChat4xxResult,
  },
};
