const jobRequestsService = require('./jobRequests.service');
const jobExecutor = require('./jobExecutor.service');

const CRITICAL_INTERVAL_MS = Number(process.env.JOB_SCHEDULER_CRITICAL_INTERVAL_MS || 5000);
const STANDARD_INTERVAL_MS = Number(process.env.JOB_SCHEDULER_INTERVAL_MS || 30000);

const workerState = {
  running: false,
  startedAt: null,
  lastCriticalRun: null,
  lastStandardRun: null,
  lastError: null,
  activeJobs: 0
};

let criticalTimer = null;
let standardTimer = null;
let externalDispatcher = null;
let drainingCritical = false;
let drainingStandard = false;

async function settleJobResult(job, result) {
  try {
    if (!result) {
      await jobRequestsService.markCompleted(job.id, { resultSummary: null });
      return;
    }

    if (result.status === 'waiting') {
      await jobRequestsService.markWaiting(job.id, {
        nextRunAt: result.nextRunAt,
        errorMessage: result?.error?.message || null,
        resultSummary: result.result || null
      });
      return;
    }

    if (result.status === 'failed') {
      await jobRequestsService.markFailed(job.id, {
        errorMessage: result?.error?.message || 'Error desconocido',
        resultSummary: result.result || null
      });
      return;
    }

    await jobRequestsService.markCompleted(job.id, {
      syncLogId: result?.syncLogId || null,
      resultSummary: result.result || null
    });
  } catch (error) {
    workerState.lastError = error.message;
    console.error(`❌ Error actualizando estado del job ${job.id}:`, error);
  }
}

async function processJob(job) {
  workerState.activeJobs += 1;
  try {
    const result = await jobExecutor.runJob(job);
    await settleJobResult(job, result);
  } catch (error) {
    workerState.lastError = error.message;
    console.error(`❌ Error ejecutando job ${job.id} (${job.type}):`, error);
    await jobRequestsService.markFailed(job.id, {
      errorMessage: error.message
    });
  } finally {
    workerState.activeJobs = Math.max(workerState.activeJobs - 1, 0);
  }
}

async function drainQueue(priorityList, marker) {
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
  }

  let processed = 0;
  try {
    let job;
    do {
      job = await jobRequestsService.claimNextJob(priorityList);
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
    }
  }
  return processed;
}

async function handleCriticalTick() {
  if (externalDispatcher) {
    return externalDispatcher('critical');
  }
  await drainQueue(['critical'], 'critical');
}

async function handleStandardTick() {
  if (externalDispatcher) {
    return externalDispatcher('standard');
  }
  await drainQueue(['high', 'normal', 'low'], 'standard');
}

function start() {
  if (workerState.running) {
    return;
  }
  workerState.running = true;
  workerState.startedAt = new Date();
  jobRequestsService.resetRunningJobs().catch((error) => {
    console.error('⚠️ No se pudieron resetear los jobs en ejecución al arrancar el scheduler:', error.message);
  });
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
  // Primer disparo inmediato
  handleCriticalTick().catch((error) => console.error('❌ Error en ejecución crítica inicial:', error));
  handleStandardTick().catch((error) => console.error('❌ Error en ejecución estándar inicial:', error));
}

function stop() {
  if (criticalTimer) {
    clearInterval(criticalTimer);
    criticalTimer = null;
  }
  if (standardTimer) {
    clearInterval(standardTimer);
    standardTimer = null;
  }
  workerState.running = false;
}

async function triggerImmediate(jobId) {
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

function getStatus() {
  return {
    running: workerState.running,
    startedAt: workerState.startedAt,
    lastCriticalRun: workerState.lastCriticalRun,
    lastStandardRun: workerState.lastStandardRun,
    lastError: workerState.lastError,
    activeJobs: workerState.activeJobs,
    criticalIntervalMs: CRITICAL_INTERVAL_MS,
    standardIntervalMs: STANDARD_INTERVAL_MS
  };
}

module.exports = {
  start,
  stop,
  triggerImmediate,
  setExternalDispatcher,
  getStatus,
  _drainQueue: drainQueue // expuesto para pruebas
};
