const { metaSyncJobs } = require('../jobs/sync.jobs');

const DEFAULT_TIMEOUT_MS = Number(process.env.JOB_EXECUTOR_MAX_RUNTIME_MS || 30 * 60 * 1000);
const DEFAULT_WAITING_BACKOFF_MS = Number(process.env.JOB_SCHEDULER_WAITING_BACKOFF_MS || 15 * 60 * 1000);

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
  analytics_backfill_properties: async (payload = {}) => metaSyncJobs.executeAnalyticsBackfillForProperties(payload.mappings || [])
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
