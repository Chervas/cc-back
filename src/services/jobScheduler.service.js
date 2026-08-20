const db = require('../../models');
const jobRequestsService = require('./jobRequests.service');
const jobExecutor = require('./jobExecutor.service');
const aiRuntimeMonitoring = require('./aiRuntimeMonitoring.service');
const { BACKGROUND_INTEGRATION_JOB_TYPES } = require('../config/scheduledJobCatalog');

const CRITICAL_INTERVAL_MS = Number(process.env.JOB_SCHEDULER_CRITICAL_INTERVAL_MS || 5000);
const STANDARD_INTERVAL_MS = Number(process.env.JOB_SCHEDULER_INTERVAL_MS || 30000);
const BACKGROUND_INTERVAL_MS = Number(process.env.JOB_SCHEDULER_BACKGROUND_INTERVAL_MS || 5000);
const STARTUP_RETRY_BASE_DELAY_MS = Number(process.env.JOB_SCHEDULER_STARTUP_RETRY_BASE_DELAY_MS || 1000);
const STARTUP_RETRY_MAX_DELAY_MS = Number(process.env.JOB_SCHEDULER_STARTUP_RETRY_MAX_DELAY_MS || 30000);
const RETRY_BASE_DELAY_MS = Number(process.env.JOB_SCHEDULER_RETRY_BASE_DELAY_MS || 60 * 1000);
const RETRY_MAX_DELAY_MS = Number(process.env.JOB_SCHEDULER_RETRY_MAX_DELAY_MS || 30 * 60 * 1000);
const CURRENT_RUNTIME_NAMESPACE = jobRequestsService.getCurrentRuntimeNamespace();
const RUNTIME_NAMESPACE_ALIASES = typeof jobRequestsService.getRuntimeNamespaceAliases === 'function'
  ? jobRequestsService.getRuntimeNamespaceAliases()
  : [];
const CLAIM_UNSCOPED_JOBS = jobRequestsService.shouldClaimUnscopedJobs();
const cleanString = (value) => {
  const normalized = String(value || '').trim();
  return normalized || null;
};

function buildRuntimeInfo() {
  const explicitLabel = cleanString(process.env.SYSTEM_RUNTIME_LABEL)
    || cleanString(process.env.RUNTIME_ENV_LABEL)
    || cleanString(process.env.RUNTIME_LABEL);
  const explicitKey = cleanString(process.env.SYSTEM_RUNTIME_KEY)
    || cleanString(process.env.RUNTIME_ENV)
    || cleanString(process.env.APP_ENV);
  const cwd = cleanString(process.cwd()) || '';
  const port = cleanString(process.env.PORT);

  let environmentKey = explicitKey || 'unknown';
  let environmentLabel = explicitLabel || 'Entorno desconocido';

  if (!explicitLabel) {
    if (cwd.includes('/wt/back-integracion') || port === '3004') {
      environmentKey = 'local_dev';
      environmentLabel = 'Desarrollo local';
    } else if (cwd.includes('/wt/back-staging') || port === '3001') {
      environmentKey = 'staging';
      environmentLabel = 'Staging';
    } else if (cwd.includes('/backendclinicaclick')) {
      environmentKey = 'production_like';
      environmentLabel = 'Backend principal';
    }
  }

  const processLabel = port ? `backend ${port}` : 'backend sin puerto';

  return {
    environmentKey,
    environmentLabel,
    processLabel,
    summaryLabel: `${environmentLabel} · ${processLabel}`,
    description: 'Este worker solo procesa jobs creados por este mismo entorno.',
    port,
    cwd,
    namespace: CURRENT_RUNTIME_NAMESPACE,
  };
}

const CURRENT_RUNTIME_INFO = buildRuntimeInfo();

const workerState = {
  running: false,
  ready: false,
  startedAt: null,
  lastCriticalRun: null,
  lastStandardRun: null,
  lastBackgroundRun: null,
  lastError: null,
  settlementFailures: 0,
  lastSettlementFailure: null,
  backgroundLeaseContentions: 0,
  lastBackgroundLease: null,
  startupAttempts: 0,
  startupRetries: 0,
  nextStartupRetryAt: null,
  lastStartupError: null,
  activeJobs: 0,
  runtimeNamespace: CURRENT_RUNTIME_NAMESPACE
};

let criticalTimer = null;
let standardTimer = null;
let backgroundTimer = null;
let externalDispatcher = null;
let drainingCritical = false;
let drainingStandard = false;
let drainingBackground = false;
let backgroundDrainPromise = null;
let startupPromise = null;
let startupRetryTimer = null;
let startupRetryResolve = null;
let lifecycleGeneration = 0;
const SCHEDULER_ALLOWED_TYPES = Object.keys(jobExecutor.JOB_HANDLERS || {});
const BACKGROUND_INTEGRATION_TYPES = new Set(BACKGROUND_INTEGRATION_JOB_TYPES);
const BACKGROUND_ALLOWED_TYPES = SCHEDULER_ALLOWED_TYPES.filter(
  (type) => BACKGROUND_INTEGRATION_TYPES.has(type)
);
const STANDARD_ALLOWED_TYPES = SCHEDULER_ALLOWED_TYPES.filter(
  (type) => !BACKGROUND_INTEGRATION_TYPES.has(type)
);
const ALL_PRIORITIES = ['critical', 'high', 'normal', 'low'];

function buildStartupRetryDelay(attempt, options = {}) {
  const configuredBase = Number(options.retryBaseDelayMs ?? STARTUP_RETRY_BASE_DELAY_MS);
  const configuredMax = Number(options.retryMaxDelayMs ?? STARTUP_RETRY_MAX_DELAY_MS);
  const base = Number.isFinite(configuredBase) && configuredBase > 0 ? configuredBase : 1000;
  const max = Number.isFinite(configuredMax) && configuredMax > 0 ? configuredMax : 30000;
  return Math.min(base * (2 ** Math.max(0, attempt - 1)), max);
}

function waitForStartupRetry(delayMs) {
  return new Promise((resolve) => {
    startupRetryResolve = resolve;
    startupRetryTimer = setTimeout(() => {
      startupRetryTimer = null;
      startupRetryResolve = null;
      resolve(true);
    }, delayMs);
  });
}

function cancelStartupRetry() {
  if (startupRetryTimer) {
    clearTimeout(startupRetryTimer);
    startupRetryTimer = null;
  }
  if (startupRetryResolve) {
    const resolve = startupRetryResolve;
    startupRetryResolve = null;
    resolve(false);
  }
}

async function getLatestAutomationIncident() {
  const failedExecution = await db.FlowExecutionV2.findOne({
    where: { status: 'failed' },
    order: [['updated_at', 'DESC']],
    raw: true
  });

  if (!failedExecution) {
    return null;
  }

  const failedLog = await db.FlowExecutionLogV2.findOne({
    where: {
      flow_execution_id: failedExecution.id,
      status: 'error'
    },
    order: [['created_at', 'DESC']],
    raw: true
  });

  return {
    executionId: failedExecution.id,
    clinicId: failedExecution.clinic_id || null,
    triggerType: failedExecution.trigger_type || null,
    triggerEntityType: failedExecution.trigger_entity_type || null,
    triggerEntityId: failedExecution.trigger_entity_id || null,
    templateVersionId: failedExecution.template_version_id || null,
    status: failedExecution.status || null,
    updatedAt: failedExecution.updated_at || failedExecution.created_at || null,
    error: failedLog?.error_message || failedExecution.last_error || null,
    nodeId: failedLog?.node_id || null,
    nodeType: failedLog?.node_type || null
  };
}

function aiCheck(ok, label, detail, extra = {}) {
  return {
    ok: !!ok,
    label,
    detail,
    ...extra,
  };
}

async function loadAiOperationalChecks({ force = false } = {}) {
  const overview = await aiRuntimeMonitoring.getOverview({ force });
  const find = (key) => overview.models.find((item) => item.key === key);
  const fast = find('bedrock_fast');
  const fallback = find('bedrock_fallback');
  const audio = find('groq_audio');
  return {
    bedrockRuntime: aiCheck(
      fast?.configured && fast?.health?.ok,
      'Bedrock para texto clínico',
      fast?.configured
        ? `${fast.model}: ${fast.health?.detail || 'sin diagnóstico'}`
        : 'Bedrock está desactivado en este runtime.',
      { model: fast?.model || null, checkedAt: fast?.health?.checked_at || overview.checked_at },
    ),
    bedrockFallbackModel: aiCheck(
      fallback?.configured && fallback?.health?.ok,
      'Fallback de texto clínico',
      fallback?.configured
        ? `${fallback.model}: ${fallback.health?.detail || 'sin diagnóstico'}`
        : 'Fallback Bedrock no activo en este runtime.',
      { model: fallback?.model || null, checkedAt: fallback?.health?.checked_at || overview.checked_at },
    ),
    groqAudioModel: aiCheck(
      audio?.configured && audio?.health?.ok,
      'Transcripción de audio',
      `${audio?.model || 'sin modelo'}: ${audio?.health?.detail || 'sin diagnóstico'}`,
      { model: audio?.model || null, checkedAt: audio?.health?.checked_at || overview.checked_at },
    ),
  };
}

function hasRetryAttemptRemaining(job) {
  const attempts = Number(job?.attempts || 0);
  const maxAttempts = Number(job?.max_attempts || job?.maxAttempts || 1);
  return Number.isFinite(attempts)
    && Number.isFinite(maxAttempts)
    && maxAttempts > 0
    && attempts < maxAttempts;
}

function buildRetryAt(job, now = new Date()) {
  const attempts = Math.max(1, Number(job?.attempts || 1));
  const baseDelay = Number.isFinite(RETRY_BASE_DELAY_MS) && RETRY_BASE_DELAY_MS > 0
    ? RETRY_BASE_DELAY_MS
    : 60 * 1000;
  const maxDelay = Number.isFinite(RETRY_MAX_DELAY_MS) && RETRY_MAX_DELAY_MS > 0
    ? RETRY_MAX_DELAY_MS
    : 30 * 60 * 1000;
  const delay = Math.min(baseDelay * (2 ** Math.max(0, attempts - 1)), maxDelay);
  return new Date(new Date(now).getTime() + delay);
}

async function settleJobResult(job, result, options = {}) {
  if (!result) {
    await jobRequestsService.markCompleted(job.id, { resultSummary: null });
    return;
  }

  if (result.status === 'waiting') {
    await jobRequestsService.markWaiting(job.id, {
      nextRunAt: result.nextRunAt,
      errorMessage: result?.error?.message || null,
      resultSummary: result.result || null,
      syncLogId: result?.syncLogId || null,
    });
    return;
  }

  if (result.status === 'failed') {
    const errorMessage = result?.error?.message || 'Error desconocido';
    const retryable = result.retryable !== false && result?.result?.retryable !== false;
    if (retryable && hasRetryAttemptRemaining(job)) {
      await jobRequestsService.markWaiting(job.id, {
        nextRunAt: buildRetryAt(job, options.now || new Date()),
        errorMessage,
        resultSummary: result.result || null,
        syncLogId: result?.syncLogId || null,
      });
      return;
    }
    await jobRequestsService.markFailed(job.id, {
      errorMessage,
      resultSummary: result.result || null,
      syncLogId: result?.syncLogId || null,
    });
    return;
  }

  await jobRequestsService.markCompleted(job.id, {
    syncLogId: result?.syncLogId || null,
    resultSummary: result.result || null
  });
}

function buildSettlementRecovery(job, result, now = new Date()) {
  if (result?.status === 'waiting') {
    return {
      status: 'waiting',
      nextRunAt: result.nextRunAt,
      errorMessage: result?.error?.message || null,
    };
  }

  if (result?.status === 'failed') {
    const retryable = result.retryable !== false && result?.result?.retryable !== false;
    if (retryable && hasRetryAttemptRemaining(job)) {
      return {
        status: 'waiting',
        nextRunAt: buildRetryAt(job, now),
        errorMessage: result?.error?.message || 'Error desconocido',
      };
    }
    return {
      status: 'failed',
      nextRunAt: null,
      errorMessage: result?.error?.message || 'Error desconocido',
    };
  }

  // El handler ya terminó correctamente. Reintentar su ejecución sería menos
  // seguro que repetir mediante CAS únicamente la escritura de completed.
  return { status: 'completed', nextRunAt: null, errorMessage: null };
}

async function processJob(job) {
  workerState.activeJobs += 1;
  try {
    let result;
    try {
      result = await jobExecutor.runJob(job);
    } catch (error) {
      workerState.lastError = error.message;
      console.error(`❌ Error ejecutando job ${job.id} (${job.type}):`, error);
      result = {
        status: 'failed',
        error,
        result: null,
        syncLogId: null,
      };
    }

    try {
      await settleJobResult(job, result);
    } catch (error) {
      workerState.lastError = `No se pudo persistir el estado del job ${job.id}: ${error.message}`;
      workerState.settlementFailures += 1;
      console.error(`❌ Error persistiendo estado del job ${job.id} (${job.type}):`, error);

      let recovery = null;
      let recoveryError = null;
      try {
        const recoveryState = buildSettlementRecovery(job, result);
        recovery = await jobRequestsService.recoverRunningJobAfterSettlementFailure(job.id, {
          status: recoveryState.status,
          nextRunAt: recoveryState.nextRunAt,
          errorMessage: recoveryState.errorMessage
            ? `${recoveryState.errorMessage}. Falló la primera persistencia: ${error.message}`
            : null,
          resultSummary: result?.result || null,
          syncLogId: result?.syncLogId || null,
        });
        if (!recovery?.resolved) {
          recoveryError = new Error('El JobRequest sigue en running tras la recuperación inmediata');
        }
      } catch (fallbackError) {
        recoveryError = fallbackError;
        console.error(`❌ Tampoco se pudo recuperar el job ${job.id} con compare-and-set:`, fallbackError);
      }

      workerState.lastSettlementFailure = {
        jobId: job.id,
        jobType: job.type,
        occurredAt: new Date(),
        message: error.message,
        recoveryStatus: recovery?.job?.status || null,
        recoveryError: recoveryError?.message || null,
      };
      if (recoveryError) {
        error.recoveryError = recoveryError;
      }
      throw error;
    }
  } finally {
    workerState.activeJobs = Math.max(workerState.activeJobs - 1, 0);
  }
}

async function drainQueue(priorityList, marker, allowedTypes = SCHEDULER_ALLOWED_TYPES) {
  if (marker === 'critical') {
    if (drainingCritical) {
      return 0;
    }
    drainingCritical = true;
  } else if (marker === 'standard') {
    if (drainingStandard) {
      return 0;
    }
    drainingStandard = true;
  } else if (marker === 'background') {
    if (drainingBackground) {
      return 0;
    }
    drainingBackground = true;
  }

  let processed = 0;
  try {
    let job;
    do {
      job = await jobRequestsService.claimNextJob(priorityList, allowedTypes);
      if (job) {
        processed += 1;
        await processJob(job);
      }
    } while (job);
  } finally {
    if (marker === 'critical') {
      workerState.lastCriticalRun = new Date();
      drainingCritical = false;
    } else if (marker === 'standard') {
      workerState.lastStandardRun = new Date();
      drainingStandard = false;
    } else if (marker === 'background') {
      workerState.lastBackgroundRun = new Date();
      drainingBackground = false;
    }
  }
  return processed;
}

async function handleCriticalTick() {
  if (externalDispatcher) {
    return externalDispatcher('critical');
  }
  await drainQueue(['critical'], 'critical', STANDARD_ALLOWED_TYPES);
}

async function handleStandardTick() {
  if (externalDispatcher) {
    return externalDispatcher('standard');
  }
  await drainQueue(['high', 'normal', 'low'], 'standard', STANDARD_ALLOWED_TYPES);
}

async function handleBackgroundTick() {
  if (externalDispatcher) {
    return externalDispatcher('background');
  }
  if (backgroundDrainPromise) {
    return backgroundDrainPromise;
  }

  backgroundDrainPromise = (async () => {
    const lease = await jobRequestsService.acquireBackgroundIntegrationLease();
    workerState.lastBackgroundLease = {
      acquired: lease.acquired,
      reason: lease.reason || null,
      lockName: lease.lockName || null,
      checkedAt: new Date(),
    };
    if (!lease.acquired) {
      workerState.backgroundLeaseContentions += 1;
      return 0;
    }

    try {
      return await drainQueue(
        ALL_PRIORITIES,
        'background',
        BACKGROUND_ALLOWED_TYPES
      );
    } finally {
      await lease.release();
    }
  })().finally(() => {
    backgroundDrainPromise = null;
  });
  return backgroundDrainPromise;
}

function start(options = {}) {
  if (workerState.running) {
    return startupPromise || Promise.resolve({ status: 'already_running' });
  }
  const generation = ++lifecycleGeneration;
  workerState.running = true;
  workerState.ready = false;
  workerState.startedAt = new Date();
  workerState.startupAttempts = 0;
  workerState.startupRetries = 0;
  workerState.nextStartupRetryAt = null;
  workerState.lastStartupError = null;
  const aliasLabel = RUNTIME_NAMESPACE_ALIASES.length ? `, aliases: ${RUNTIME_NAMESPACE_ALIASES.join(',')}` : '';
  console.log(`🧭 Job scheduler namespace: ${CURRENT_RUNTIME_NAMESPACE}${aliasLabel} (claim unscoped: ${CLAIM_UNSCOPED_JOBS})`);
  startupPromise = (async () => {
    while (workerState.running && generation === lifecycleGeneration) {
      workerState.startupAttempts += 1;
      try {
        const resetReport = await jobRequestsService.resetRunningJobs();
        if (!workerState.running || generation !== lifecycleGeneration) {
          return { status: 'stopped_during_startup', reset: resetReport };
        }

        // Una recuperación completa demuestra que cualquier job que hubiese
        // quedado running vuelve a tener un estado durable y reclamable.
        workerState.lastSettlementFailure = null;
        workerState.lastStartupError = null;
        workerState.lastError = null;
        workerState.nextStartupRetryAt = null;
        workerState.ready = true;
        criticalTimer = setInterval(() => {
          handleCriticalTick().catch((error) => {
            workerState.lastError = error.message;
            console.error('❌ Error en ciclo crítico del scheduler:', error);
          });
        }, CRITICAL_INTERVAL_MS);
        standardTimer = setInterval(() => {
          handleStandardTick().catch((error) => {
            workerState.lastError = error.message;
            console.error('❌ Error en ciclo estándar del scheduler:', error);
          });
        }, STANDARD_INTERVAL_MS);
        backgroundTimer = setInterval(() => {
          handleBackgroundTick().catch((error) => {
            workerState.lastError = error.message;
            console.error('❌ Error en ciclo de integraciones del scheduler:', error);
          });
        }, BACKGROUND_INTERVAL_MS);

        // Primer drenaje, siempre después de completar la recuperación.
        handleCriticalTick().catch((error) => {
          workerState.lastError = error.message;
          console.error('❌ Error en ejecución crítica inicial:', error);
        });
        handleStandardTick().catch((error) => {
          workerState.lastError = error.message;
          console.error('❌ Error en ejecución estándar inicial:', error);
        });
        handleBackgroundTick().catch((error) => {
          workerState.lastError = error.message;
          console.error('❌ Error en ejecución inicial de integraciones:', error);
        });
        return {
          status: 'started',
          reset: resetReport,
          startupAttempts: workerState.startupAttempts,
          startupRetries: workerState.startupRetries,
        };
      } catch (error) {
        workerState.ready = false;
        workerState.startupRetries += 1;
        workerState.lastStartupError = error.message;
        workerState.lastError = `No se pudo recuperar la cola al arrancar: ${error.message}`;
        const retryDelay = buildStartupRetryDelay(workerState.startupRetries, options);
        workerState.nextStartupRetryAt = new Date(Date.now() + retryDelay);
        console.error(
          `❌ No se pudo recuperar la cola al arrancar; reintento ${workerState.startupRetries} en ${retryDelay} ms:`,
          error
        );
        const shouldContinue = await waitForStartupRetry(retryDelay);
        if (!shouldContinue || !workerState.running || generation !== lifecycleGeneration) {
          return { status: 'stopped_during_startup', error: error.message };
        }
      }
    }

    return { status: 'stopped_during_startup' };
  })();

  return startupPromise;
}

function stop() {
  lifecycleGeneration += 1;
  cancelStartupRetry();
  if (criticalTimer) {
    clearInterval(criticalTimer);
    criticalTimer = null;
  }
  if (standardTimer) {
    clearInterval(standardTimer);
    standardTimer = null;
  }
  if (backgroundTimer) {
    clearInterval(backgroundTimer);
    backgroundTimer = null;
  }
  workerState.running = false;
  workerState.ready = false;
  workerState.nextStartupRetryAt = null;
  startupPromise = null;
}

async function triggerImmediate(jobId) {
  if (workerState.running && startupPromise) {
    await startupPromise;
  }
  const requestedJob = await jobRequestsService.findJobById(jobId);
  if (!requestedJob) {
    return false;
  }

  if (BACKGROUND_INTEGRATION_TYPES.has(requestedJob.type)) {
    if (externalDispatcher) {
      return externalDispatcher('background', jobId);
    }

    // Los sync recientes y backfills comparten estado mutable de proveedor.
    // Un disparo manual se une al mismo drenaje secuencial, nunca reclama el
    // job por su cuenta ni crea paralelismo entre tipos.
    await handleBackgroundTick();

    // Cierra la carrera en la que el drenaje previo leyó una cola vacía justo
    // antes de que se insertase este JobRequest.
    let refreshed = await jobRequestsService.findJobById(jobId);
    const waitingUntil = refreshed?.next_run_at ? new Date(refreshed.next_run_at).getTime() : null;
    const claimableNow = refreshed
      && (
        ['pending', 'queued'].includes(refreshed.status)
        || (
          refreshed.status === 'waiting'
          && (!waitingUntil || waitingUntil <= Date.now())
        )
      );
    if (claimableNow) {
      await handleBackgroundTick();
      refreshed = await jobRequestsService.findJobById(jobId);
    }
    return Boolean(refreshed && !['pending', 'queued'].includes(refreshed.status));
  }

  if (externalDispatcher) {
    return externalDispatcher('immediate', jobId);
  }
  const job = await jobRequestsService.claimJobById(jobId);
  if (!job) {
    return false;
  }
  await processJob(job);
  return true;
}

function setExternalDispatcher(handler) {
  externalDispatcher = handler;
}

async function getStatus(options = {}) {
  const latestAutomationIncident = await getLatestAutomationIncident().catch(() => null);
  const aiOperationalChecks = await loadAiOperationalChecks({
    force: Boolean(options.forceAiHealth || options.forceGroqHealth),
  }).catch((err) => ({
    bedrockRuntime: aiCheck(false, 'Bedrock para texto clínico', `No se pudo comprobar Bedrock (${cleanString(err?.code || err?.name || err?.message) || 'error desconocido'}).`),
    bedrockFallbackModel: aiCheck(false, 'Fallback de texto clínico', 'No se pudo comprobar el modelo fallback.'),
    groqAudioModel: aiCheck(false, 'Transcripción de audio', 'No se pudo comprobar el modelo de audio.'),
  }));
  return {
    running: workerState.running,
    ready: workerState.ready,
    startedAt: workerState.startedAt,
    lastCriticalRun: workerState.lastCriticalRun,
    lastStandardRun: workerState.lastStandardRun,
    lastBackgroundRun: workerState.lastBackgroundRun,
    lastError: workerState.lastError,
    settlementFailures: workerState.settlementFailures,
    lastSettlementFailure: workerState.lastSettlementFailure,
    backgroundLeaseContentions: workerState.backgroundLeaseContentions,
    lastBackgroundLease: workerState.lastBackgroundLease,
    startupAttempts: workerState.startupAttempts,
    startupRetries: workerState.startupRetries,
    nextStartupRetryAt: workerState.nextStartupRetryAt,
    lastStartupError: workerState.lastStartupError,
    activeJobs: workerState.activeJobs,
    criticalIntervalMs: CRITICAL_INTERVAL_MS,
    standardIntervalMs: STANDARD_INTERVAL_MS,
    backgroundIntervalMs: BACKGROUND_INTERVAL_MS,
    startupRetryBaseDelayMs: STARTUP_RETRY_BASE_DELAY_MS,
    startupRetryMaxDelayMs: STARTUP_RETRY_MAX_DELAY_MS,
    runtimeNamespace: CURRENT_RUNTIME_NAMESPACE,
    runtimeInfo: CURRENT_RUNTIME_INFO,
    latestAutomationIncident,
    systemChecks: {
      ...aiOperationalChecks,
      runtimeNamespace: {
        ok: !!CURRENT_RUNTIME_NAMESPACE,
        label: 'Aislamiento de cola',
        detail: !!CURRENT_RUNTIME_NAMESPACE
          ? `${CURRENT_RUNTIME_INFO.summaryLabel}. Clave interna: ${CURRENT_RUNTIME_NAMESPACE}`
          : 'Este proceso no tiene una clave de aislamiento; podría mezclar jobs con otros entornos.',
      },
      runtimeEnvironment: {
        ok: !!CURRENT_RUNTIME_INFO.summaryLabel,
        label: 'Entorno actual',
        detail: CURRENT_RUNTIME_INFO.summaryLabel,
      },
      settlementPersistence: {
        ok: !workerState.lastSettlementFailure,
        label: 'Persistencia de jobs',
        detail: workerState.lastSettlementFailure
          ? `Último fallo: job ${workerState.lastSettlementFailure.jobId} (${workerState.lastSettlementFailure.jobType}): ${workerState.lastSettlementFailure.message}. Recuperación: ${workerState.lastSettlementFailure.recoveryStatus || workerState.lastSettlementFailure.recoveryError || 'pendiente de reinicio'}`
          : workerState.settlementFailures
            ? `Recuperada tras ${workerState.settlementFailures} fallo(s) de persistencia en este proceso.`
            : 'Sin fallos de persistencia detectados en este proceso.',
      },
      startupRecovery: {
        ok: workerState.ready,
        label: 'Recuperación de cola al arrancar',
        detail: workerState.ready
          ? `Completada en ${workerState.startupAttempts} intento(s).`
          : workerState.running && workerState.nextStartupRetryAt
            ? `Reintentando tras ${workerState.startupRetries} fallo(s). Próximo intento: ${workerState.nextStartupRetryAt.toISOString()}`
            : workerState.running
              ? 'Recuperación en curso; los timers y drains todavía no están activos.'
              : 'Worker detenido.',
      },
      backgroundIntegrationLease: {
        ok: workerState.lastBackgroundLease?.reason !== 'unsupported_dialect',
        label: 'Lease adicional del carril de integraciones',
        detail: workerState.lastBackgroundLease
          ? workerState.lastBackgroundLease.acquired
            ? `Lease adquirida: ${workerState.lastBackgroundLease.lockName}. Sigue siendo obligatorio un único worker JobRequest por namespace.`
            : `Lease no adquirida: ${workerState.lastBackgroundLease.reason || 'ocupada por otro worker'}. Sigue siendo obligatorio un único worker JobRequest por namespace.`
          : 'Aún no se ha ejecutado el carril. Es obligatorio un único worker JobRequest por namespace.',
      },
    },
  };
}

module.exports = {
  start,
  stop,
  triggerImmediate,
  setExternalDispatcher,
  getStatus,
  _drainQueue: drainQueue, // expuesto para pruebas
  _handleCriticalTick: handleCriticalTick,
  _handleStandardTick: handleStandardTick,
  _handleBackgroundTick: handleBackgroundTick,
  _settleJobResult: settleJobResult,
  _processJob: processJob,
  _getWorkerState: () => ({ ...workerState }),
  _hasRetryAttemptRemaining: hasRetryAttemptRemaining,
  _buildRetryAt: buildRetryAt,
  _buildSettlementRecovery: buildSettlementRecovery,
  _buildStartupRetryDelay: buildStartupRetryDelay,
  _backgroundIntegrationTypes: () => new Set(BACKGROUND_INTEGRATION_TYPES),
  _backgroundAllowedTypes: () => [...BACKGROUND_ALLOWED_TYPES],
  _standardAllowedTypes: () => [...STANDARD_ALLOWED_TYPES],
};
