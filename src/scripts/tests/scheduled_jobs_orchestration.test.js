'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const db = require('../../../models');
const {
  SCHEDULED_JOB_DEFINITIONS,
  BACKGROUND_INTEGRATION_JOB_TYPES,
} = require('../../config/scheduledJobCatalog');
const jobRequestsService = require('../../services/jobRequests.service');
const jobExecutor = require('../../services/jobExecutor.service');
const jobScheduler = require('../../services/jobScheduler.service');
const { metaSyncJobs, MetaSyncJobs } = require('../../jobs/sync.jobs');
const { queues } = require('../../services/queue.service');
const realAcquireBackgroundIntegrationLease = jobRequestsService.acquireBackgroundIntegrationLease;
const testBackgroundLease = async () => ({
  acquired: true,
  lockName: 'test-background-lease',
  release: async () => {},
});
jobRequestsService.acquireBackgroundIntegrationLease = testBackgroundLease;

function testCatalogCoversEveryCronAndExecutor() {
  const definitions = Object.entries(SCHEDULED_JOB_DEFINITIONS);
  const configuredNames = Object.keys(metaSyncJobs.config.schedules).sort();
  const catalogNames = definitions.map(([name]) => name).sort();
  const types = definitions.map(([, definition]) => definition.type);

  assert.equal(definitions.length, 24);
  assert.deepEqual(catalogNames, configuredNames);
  assert.equal(new Set(types).size, types.length, 'scheduled job types must be unique');

  for (const [jobName, definition] of definitions) {
    assert.equal(typeof metaSyncJobs[definition.executorMethod], 'function', `${jobName} executor missing`);
    assert.equal(typeof jobExecutor.JOB_HANDLERS[definition.type], 'function', `${definition.type} handler missing`);
  }

  const syncJobsSource = fs.readFileSync(path.resolve(__dirname, '../../jobs/sync.jobs.js'), 'utf8');
  const initializeStart = syncJobsSource.indexOf('async initialize()');
  const registerStart = syncJobsSource.indexOf('\n  registerJob(', initializeStart);
  const initializeBody = syncJobsSource.slice(initializeStart, registerStart);
  assert.match(initializeBody, /Object\.keys\(SCHEDULED_JOB_DEFINITIONS\)/);
  assert.match(initializeBody, /this\.enqueueScheduledJob\(jobName\)/);
  assert.doesNotMatch(initializeBody, /this\.execute[A-Z]/, 'cron registration must not execute business directly');

  const controllerSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/metasync.jobs.controller.js'),
    'utf8'
  );
  assert.match(controllerSource, /enqueueUniqueJobRequest/);
  assert.match(controllerSource, /SCHEDULED_JOB_DEFINITIONS/);

  const targetedWebStart = controllerSource.indexOf('exports.runTargetedWebBackfill');
  const targetedAnalyticsStart = controllerSource.indexOf('exports.runTargetedAnalyticsBackfill');
  const targetedWebBody = controllerSource.slice(targetedWebStart, targetedAnalyticsStart);
  const targetedAnalyticsBody = controllerSource.slice(targetedAnalyticsStart);
  assert.match(targetedWebBody, /type: 'web_backfill_for_sites'/);
  assert.doesNotMatch(targetedWebBody, /type: 'web_backfill'/);
  assert.match(targetedAnalyticsBody, /type: 'analytics_backfill_properties'/);
  assert.doesNotMatch(targetedAnalyticsBody, /type: 'analytics_backfill'/);
  assert.equal(typeof jobExecutor.JOB_HANDLERS.web_backfill_for_sites, 'function');
  assert.equal(typeof jobExecutor.JOB_HANDLERS.analytics_backfill_properties, 'function');

  const oauthSource = fs.readFileSync(path.resolve(__dirname, '../../routes/oauth.routes.js'), 'utf8');
  const analyticsMappingStart = oauthSource.indexOf("router.post('/google/analytics/map-properties'");
  const localLocationsStart = oauthSource.indexOf("router.get('/google/local/locations'", analyticsMappingStart);
  const analyticsMappingBody = oauthSource.slice(analyticsMappingStart, localLocationsStart);
  assert.match(analyticsMappingBody, /type: 'analytics_backfill_properties'/);
  assert.doesNotMatch(analyticsMappingBody, /type: 'analytics_backfill'/);

  const backfillScript = fs.readFileSync(
    path.resolve(__dirname, '../backfill_ads.js'),
    'utf8'
  );
  assert.match(backfillScript, /enqueueUniqueJobRequest/);
  assert.doesNotMatch(backfillScript, /jobScheduler\.(start|triggerImmediate|stop)/);
  assert.doesNotMatch(backfillScript, /metaSyncJobs\.initialize/);

  for (const relativePath of [
    '../../controllers/clinica.controller.js',
    '../../controllers/gruposclinicas.controller.js',
    '../../controllers/metasync.jobs.controller.js',
    '../../routes/oauth.routes.js',
  ]) {
    const source = fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');
    assert.doesNotMatch(
      source,
      /enqueueJobRequest\(\{[\s\S]{0,160}?type:\s*'(?:meta_ads_recent|google_ads_recent|web_backfill_for_sites|analytics_backfill_properties|business_profile_backfill_locations)'/,
      `${relativePath} must use scope-aware unique enqueue for background integrations`
    );
  }
}

async function testTargetedHandlersKeepTheirExactMappings() {
  const original = {
    executeAdsBackfill: metaSyncJobs.executeAdsBackfill,
    executeWebBackfillForSites: metaSyncJobs.executeWebBackfillForSites,
    executeAnalyticsBackfillForProperties: metaSyncJobs.executeAnalyticsBackfillForProperties,
    executeBusinessProfileBackfillForLocations: metaSyncJobs.executeBusinessProfileBackfillForLocations,
  };
  const received = {};
  metaSyncJobs.executeAdsBackfill = async (payload) => {
    received.ads = payload;
    return { status: 'completed' };
  };
  metaSyncJobs.executeWebBackfillForSites = async (mappings) => {
    received.web = mappings;
    return { status: 'completed' };
  };
  metaSyncJobs.executeAnalyticsBackfillForProperties = async (mappings) => {
    received.analytics = mappings;
    return { status: 'completed' };
  };
  metaSyncJobs.executeBusinessProfileBackfillForLocations = async (mappings) => {
    received.business = mappings;
    return { status: 'completed' };
  };

  const webMappings = [{ clinicId: 55, siteUrl: 'https://example.test/' }];
  const analyticsMappings = [{ clinicId: 55, propertyId: 123 }];
  const businessMappings = [{ clinicId: 55, locationId: 'locations/123' }];
  try {
    await jobExecutor.JOB_HANDLERS.meta_ads_backfill_for_sites({
      mappings: [{ clinicId: 55 }, { clinicaId: 56 }],
      windowDays: 30,
    });
    await jobExecutor.JOB_HANDLERS.web_backfill_for_sites({ mappings: webMappings });
    await jobExecutor.JOB_HANDLERS.analytics_backfill_properties({ mappings: analyticsMappings });
    await jobExecutor.JOB_HANDLERS.business_profile_backfill_locations({ mappings: businessMappings });

    assert.deepEqual(received.ads.clinicIds, [55, 56]);
    assert.equal(received.ads.windowDays, 30);
    assert.deepEqual(received.web, webMappings);
    assert.deepEqual(received.analytics, analyticsMappings);
    assert.deepEqual(received.business, businessMappings);
    await assert.rejects(
      () => jobExecutor.JOB_HANDLERS.meta_ads_backfill_for_sites({}),
      /requires mappings or clinicIds/
    );
  } finally {
    Object.assign(metaSyncJobs, original);
  }
}

function testQueuedStatusAndSchedulerIndexContract() {
  assert.ok(jobRequestsService.CLAIMABLE_JOB_STATUSES.includes('queued'));
  const scope = jobRequestsService._buildWaitingScope(new Date());
  assert.ok(scope[Op.or].some((entry) => entry.status === 'queued'));
  assert.equal(jobRequestsService._deriveDedupeScope({ trigger: 'cron' }), 'global');
  assert.notEqual(
    jobRequestsService._deriveDedupeScope({ clinicId: 55 }),
    jobRequestsService._deriveDedupeScope({ clinicId: 56 })
  );
  assert.notEqual(
    jobRequestsService._deriveDedupeScope({ clinicId: 55 }),
    jobRequestsService._deriveDedupeScope({ groupId: 55 })
  );
  assert.equal(
    jobRequestsService._deriveDedupeScope({ clinicIds: [56, 55] }),
    jobRequestsService._deriveDedupeScope({ clinicIds: ['55', '56'] }),
    'the same target set must deduplicate regardless of input order'
  );

  const schedulerIndex = db.JobRequest.options.indexes.find(
    (index) => index.name === 'idx_job_requests_type_status_created_at'
  );
  assert.deepEqual(schedulerIndex.fields, ['type', 'status', 'created_at']);

  const migration = require('../../../migrations/20260713130000-add-job-request-scheduler-index');
  let indexes = [];
  const calls = [];
  const queryInterface = {
    showIndex: async () => indexes,
    addIndex: async (table, fields, options) => {
      calls.push({ method: 'add', table, fields, options });
      indexes = [{ name: options.name }];
    },
    removeIndex: async (table, name) => {
      calls.push({ method: 'remove', table, name });
      indexes = [];
    },
  };
  return migration.up(queryInterface)
    .then(() => migration.up(queryInterface))
    .then(() => migration.down(queryInterface))
    .then(() => {
      assert.equal(calls.filter((call) => call.method === 'add').length, 1);
      assert.deepEqual(calls[0].fields, ['type', 'status', 'created_at']);
      assert.equal(calls.filter((call) => call.method === 'remove').length, 1);
    });
}

async function testCronMonitorReportsEnqueueNotBusinessCompletion() {
  const jobs = new MetaSyncJobs();
  const jobData = {
    handler: async () => ({
      status: 'enqueued',
      queued: true,
      already_queued: false,
      job_request_id: 901,
    }),
    status: 'registered',
    lastExecution: null,
    lastEnqueuedAt: null,
    lastEnqueueAttempt: null,
    lastJobRequestId: null,
  };
  jobs.jobs.set('metricsSync', jobData);

  const result = await jobs.executeWithRetry('metricsSync', jobData.handler);
  assert.equal(result.status, 'enqueued');
  assert.equal(jobData.status, 'enqueued');
  assert.equal(jobData.lastExecution, null);
  assert.ok(jobData.lastEnqueuedAt instanceof Date);
  assert.equal(jobData.lastJobRequestId, 901);

  jobData.handler = async () => ({
    status: 'already_queued',
    queued: false,
    already_queued: true,
    job_request_id: 901,
  });
  await jobs.runJob('metricsSync');
  assert.equal(jobData.status, 'already_queued');
  assert.equal(jobData.lastExecution, null);
}

async function testBackgroundLaneIsSeparateAndSequential() {
  const originalClaim = jobRequestsService.claimNextJob;
  const originalRun = jobExecutor.runJob;
  const originalCompleted = jobRequestsService.markCompleted;
  const calls = [];
  try {
    jobRequestsService.claimNextJob = async (priorities, types) => {
      calls.push({ priorities, types });
      return null;
    };
    await jobScheduler._handleCriticalTick();
    await jobScheduler._handleStandardTick();
    await jobScheduler._handleBackgroundTick();

    assert.equal(calls.length, 3);
    const backgroundSet = new Set(BACKGROUND_INTEGRATION_JOB_TYPES);
    assert.ok(calls[0].types.every((type) => !backgroundSet.has(type)));
    assert.ok(calls[1].types.every((type) => !backgroundSet.has(type)));
    assert.deepEqual(new Set(calls[2].types), backgroundSet);
    assert.equal(
      calls[0].types.some((type) => type === 'lead_callback_reminder_notify'),
      true,
      'CRM jobs must remain in the non-background lane'
    );

    const queuedJobs = [
      { id: 1001, type: 'google_ads_recent', status: 'running', attempts: 1, max_attempts: 3, payload: {} },
      { id: 1002, type: 'web_backfill_for_sites', status: 'running', attempts: 1, max_attempts: 3, payload: {} },
    ];
    let active = 0;
    let maxActive = 0;
    let claims = 0;
    jobRequestsService.claimNextJob = async (_priorities, types) => {
      assert.ok(types.every((type) => backgroundSet.has(type)));
      claims += 1;
      return queuedJobs.shift() || null;
    };
    jobExecutor.runJob = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setImmediate(resolve));
      active -= 1;
      return { status: 'completed', result: { ok: true } };
    };
    jobRequestsService.markCompleted = async () => {};

    await Promise.all([
      jobScheduler._handleBackgroundTick(),
      jobScheduler._handleBackgroundTick(),
    ]);
    assert.equal(maxActive, 1, 'recent/backfill integrations must never overlap');
    assert.equal(claims, 3, 'one coalesced drain claims both jobs and then the empty queue');
  } finally {
    jobRequestsService.claimNextJob = originalClaim;
    jobExecutor.runJob = originalRun;
    jobRequestsService.markCompleted = originalCompleted;
  }
}

async function testBackgroundLaneUsesDurableMysqlLease() {
  const queryLog = [];
  let releasedConnections = 0;
  let destroyedConnections = 0;
  const connection = {
    threadId: 321,
    promise: () => ({
      query: async (sql, values) => {
        queryLog.push({ sql, values });
        if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
        if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
        throw new Error(`unexpected query: ${sql}`);
      },
    }),
  };
  const connectionManager = {
    getConnection: async () => connection,
    releaseConnection: async () => { releasedConnections += 1; },
    destroyConnection: async () => { destroyedConnections += 1; },
  };
  const sequelizeInstance = {
    config: { database: 'clinicaclick_test' },
    getDialect: () => 'mysql',
    connectionManager,
  };

  const lease = await realAcquireBackgroundIntegrationLease({
    sequelizeInstance,
    connectionManager,
    runtimeNamespace: 'staging',
  });
  assert.equal(lease.acquired, true);
  assert.equal(lease.connectionId, 321);
  assert.ok(lease.lockName.length <= 64);
  assert.match(queryLog[0].sql, /GET_LOCK\(\?, 0\)/);
  await lease.release();
  await lease.release();
  assert.match(queryLog[1].sql, /RELEASE_LOCK\(\?\)/);
  assert.equal(releasedConnections, 1);
  assert.equal(destroyedConnections, 0);

  const originalAcquire = jobRequestsService.acquireBackgroundIntegrationLease;
  const originalClaim = jobRequestsService.claimNextJob;
  let claimed = false;
  jobRequestsService.acquireBackgroundIntegrationLease = async () => ({
    acquired: false,
    reason: 'contended',
    lockName: lease.lockName,
    release: async () => {},
  });
  jobRequestsService.claimNextJob = async () => {
    claimed = true;
    return null;
  };
  try {
    const processed = await jobScheduler._handleBackgroundTick();
    assert.equal(processed, 0);
    assert.equal(claimed, false, 'a worker without the lease must not claim integration jobs');
    assert.equal(jobScheduler._getWorkerState().lastBackgroundLease.reason, 'contended');
  } finally {
    jobRequestsService.acquireBackgroundIntegrationLease = originalAcquire;
    jobRequestsService.claimNextJob = originalClaim;
  }
}

async function testImmediateBackgroundTriggerJoinsBackgroundDrain() {
  const original = {
    findJobById: jobRequestsService.findJobById,
    claimNextJob: jobRequestsService.claimNextJob,
    claimJobById: jobRequestsService.claimJobById,
    markCompleted: jobRequestsService.markCompleted,
    runJob: jobExecutor.runJob,
  };
  const target = {
    id: 1101,
    type: 'analytics_backfill_properties',
    status: 'pending',
    attempts: 0,
    max_attempts: 3,
    payload: { mappings: [{ clinicId: 55, propertyId: 7 }] },
  };
  let handedOut = false;
  let directClaims = 0;
  try {
    jobRequestsService.findJobById = async () => target;
    jobRequestsService.claimJobById = async () => {
      directClaims += 1;
      return null;
    };
    jobRequestsService.claimNextJob = async (_priorities, types) => {
      assert.ok(types.includes(target.type));
      if (handedOut) return null;
      handedOut = true;
      target.status = 'running';
      target.attempts = 1;
      return target;
    };
    jobExecutor.runJob = async () => ({ status: 'completed', result: { ok: true } });
    jobRequestsService.markCompleted = async () => {
      target.status = 'completed';
    };

    const triggered = await jobScheduler.triggerImmediate(target.id);
    assert.equal(triggered, true);
    assert.equal(target.status, 'completed');
    assert.equal(directClaims, 0, 'background trigger must not bypass the serialized lane');
  } finally {
    Object.assign(jobRequestsService, {
      findJobById: original.findJobById,
      claimNextJob: original.claimNextJob,
      claimJobById: original.claimJobById,
      markCompleted: original.markCompleted,
    });
    jobExecutor.runJob = original.runJob;
  }
}

function buildSerializedFakePersistence() {
  let activeJob = null;
  let createdCount = 0;
  let tail = Promise.resolve();
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };

  const JobRequestModel = {
    async findOne() {
      return activeJob;
    },
    async create(values) {
      createdCount += 1;
      activeJob = { id: createdCount, created_at: new Date(), ...values };
      return activeJob;
    },
  };
  const sequelizeInstance = {
    literal(value) {
      return { literal: value };
    },
    transaction(_options, callback) {
      const current = tail.then(() => callback(transaction));
      tail = current.catch(() => undefined);
      return current;
    },
  };

  return {
    JobRequestModel,
    sequelizeInstance,
    getCreatedCount: () => createdCount,
  };
}

async function testUniqueEnqueueSerializesMissingRowRace() {
  const persistence = buildSerializedFakePersistence();
  const args = {
    type: 'google_data_manager_diagnostics',
    payload: { trigger: 'test' },
    origin: 'test:scheduled',
    maxAttempts: 3,
  };

  const [first, second] = await Promise.all([
    jobRequestsService.enqueueUniqueJobRequest(args, persistence),
    jobRequestsService.enqueueUniqueJobRequest(args, persistence),
  ]);

  assert.equal(persistence.getCreatedCount(), 1);
  assert.deepEqual([first.created, second.created].sort(), [false, true]);
  assert.equal(first.job.id, second.job.id);
  assert.equal(
    first.job.payload.__runtime_namespace,
    jobRequestsService.getCurrentRuntimeNamespace()
  );
  assert.equal(first.job.payload.__dedupe_scope, 'global');
}

async function testUniqueEnqueueRereadsAfterDeadlock() {
  const existing = {
    id: 44,
    type: 'google_data_manager_diagnostics',
    status: 'pending',
    payload: { __runtime_namespace: jobRequestsService.getCurrentRuntimeNamespace() },
  };
  let transactionCalls = 0;
  const sequelizeInstance = {
    literal: (value) => ({ literal: value }),
    async transaction(_options, callback) {
      transactionCalls += 1;
      if (transactionCalls === 1) {
        const error = new Error('Deadlock found when trying to get lock');
        error.code = 'ER_LOCK_DEADLOCK';
        error.errno = 1213;
        throw error;
      }
      return callback({ LOCK: { UPDATE: 'UPDATE' } });
    },
  };
  const JobRequestModel = {
    findOne: async () => existing,
    create: async () => {
      throw new Error('must not create after winning transaction committed');
    },
  };

  const result = await jobRequestsService.enqueueUniqueJobRequest({
    type: 'google_data_manager_diagnostics',
  }, {
    sequelizeInstance,
    JobRequestModel,
    transactionRetries: 2,
  });

  assert.equal(transactionCalls, 2);
  assert.equal(result.created, false);
  assert.equal(result.job.id, existing.id);
}

async function testRetrySettlementAndSyncLogLink() {
  const original = {
    markWaiting: jobRequestsService.markWaiting,
    markFailed: jobRequestsService.markFailed,
    markCompleted: jobRequestsService.markCompleted,
  };
  const calls = [];
  jobRequestsService.markWaiting = async (id, options) => calls.push({ method: 'waiting', id, options });
  jobRequestsService.markFailed = async (id, options) => calls.push({ method: 'failed', id, options });
  jobRequestsService.markCompleted = async (id, options) => calls.push({ method: 'completed', id, options });

  try {
    const now = new Date('2026-07-13T10:00:00.000Z');
    await jobScheduler._settleJobResult(
      { id: 10, attempts: 1, max_attempts: 3 },
      {
        status: 'failed',
        error: new Error('temporary'),
        syncLogId: 91,
        result: { checked: 4 },
      },
      { now }
    );
    assert.equal(calls[0].method, 'waiting');
    assert.equal(calls[0].options.errorMessage, 'temporary');
    assert.equal(calls[0].options.syncLogId, 91);
    assert.deepEqual(calls[0].options.resultSummary, { checked: 4 });
    assert.equal(
      calls[0].options.nextRunAt.toISOString(),
      jobScheduler._buildRetryAt({ attempts: 1 }, now).toISOString()
    );

    await jobScheduler._settleJobResult(
      { id: 11, attempts: 3, max_attempts: 3 },
      {
        status: 'failed',
        error: new Error('terminal'),
        syncLogId: 92,
        result: { checked: 4 },
      },
      { now }
    );
    assert.equal(calls[1].method, 'failed');
    assert.equal(calls[1].options.syncLogId, 92);

    await jobScheduler._settleJobResult(
      { id: 12, attempts: 1, max_attempts: 3 },
      {
        status: 'failed',
        retryable: false,
        error: new Error('functional incident'),
        result: { retryable: false, issue_count: 2 },
      },
      { now }
    );
    assert.equal(calls[2].method, 'failed');
    assert.equal(calls[2].options.errorMessage, 'functional incident');
    assert.equal(jobScheduler._hasRetryAttemptRemaining({ attempts: 2, max_attempts: 3 }), true);
    assert.equal(jobScheduler._hasRetryAttemptRemaining({ attempts: 3, max_attempts: 3 }), false);
  } finally {
    Object.assign(jobRequestsService, original);
  }
}

async function testRestartReschedulesOnlyNonExhaustedJobs() {
  const originalUpdate = db.JobRequest.update;
  const updates = [];
  db.JobRequest.update = async (values, options) => {
    updates.push({ values, options });
    return [values.status === 'waiting' ? 2 : 1];
  };

  try {
    const report = await jobRequestsService.resetRunningJobs();
    assert.deepEqual(report, { rescheduled: 2, exhausted: 1 });
    assert.equal(updates.length, 2);
    assert.equal(updates[0].values.status, 'failed');
    assert.equal(updates[1].values.status, 'waiting');
    assert.ok(updates[1].values.next_run_at instanceof Date);
  } finally {
    db.JobRequest.update = originalUpdate;
  }
}

async function testDiagnosticsHandlerCarriesJobIdentityAndReportedFailure() {
  const original = metaSyncJobs.executeGoogleDataManagerDiagnostics;
  let received = null;
  metaSyncJobs.executeGoogleDataManagerDiagnostics = async (payload) => {
    received = payload;
    return { status: 'failed', syncLogId: 123, report: { errors: 1 } };
  };

  try {
    const result = await jobExecutor.runJob({
      id: 77,
      type: 'google_data_manager_diagnostics',
      payload: { trigger: 'test' },
    });
    assert.equal(received.jobRequestId, 77);
    assert.equal(received.trigger, 'test');
    assert.equal(result.status, 'failed');
    assert.equal(result.syncLogId, 123);
    assert.match(result.error.message, /devolvió estado failed/);
  } finally {
    metaSyncJobs.executeGoogleDataManagerDiagnostics = original;
  }
}

async function testAuditFindingDoesNotRetryButTechnicalFailureDoes() {
  const original = metaSyncJobs.executeGoogleConversionGoalPolicyAudit;
  try {
    metaSyncJobs.executeGoogleConversionGoalPolicyAudit = async () => ({
      status: 'failed',
      critical_count: 2,
    });
    const finding = await jobExecutor.runJob({
      id: 88,
      type: 'google_conversion_goal_policy_audit',
      payload: {},
    });
    assert.equal(finding.status, 'failed');
    assert.equal(finding.retryable, false);

    metaSyncJobs.executeGoogleConversionGoalPolicyAudit = async () => {
      throw new Error('provider unavailable');
    };
    const technical = await jobExecutor.runJob({
      id: 89,
      type: 'google_conversion_goal_policy_audit',
      payload: {},
    });
    assert.equal(technical.status, 'failed');
    assert.notEqual(technical.retryable, false);
  } finally {
    metaSyncJobs.executeGoogleConversionGoalPolicyAudit = original;
  }
}

function testScheduledJobsDoNotUseUncancellableTimeout() {
  for (const jobType of BACKGROUND_INTEGRATION_JOB_TYPES) {
    assert.equal(
      jobExecutor._shouldUseExecutionTimeout(jobType),
      false,
      `${jobType} must wait for its real handler instead of Promise.race`
    );
  }
  assert.equal(jobExecutor._shouldUseExecutionTimeout('automations_v2_execute'), true);
  const timeout = jobExecutor._buildTimeoutFailureResult();
  assert.equal(timeout.status, 'failed');
  assert.equal(timeout.retryable, false);
  assert.match(timeout.error.message, /no se reintentará automáticamente/);
}

function testBatchFailuresAreNotReportedAsSuccessful() {
  const totalFailure = jobExecutor._normalizeScheduledExecutionResult({
    status: 'completed',
    accounts: 2,
    processed: 0,
    errors: [{ id: 1 }, { id: 2 }],
  });
  assert.equal(totalFailure.status, 'failed');
  assert.equal(totalFailure.retryable, true);
  assert.equal(totalFailure.total_failure, true);
  assert.deepEqual(totalFailure.outcome, { eligible: 2, processed: 0, errors: 2 });

  const partial = jobExecutor._normalizeScheduledExecutionResult({
    status: 'completed',
    report: {
      properties: 2,
      processedProperties: 1,
      errors: [{ propertyId: 2 }],
    },
  });
  assert.equal(partial.status, 'completed_with_errors');
  assert.equal(partial.partial, true);

  const empty = { status: 'completed', accounts: 0, processed: 0, errors: [] };
  assert.equal(jobExecutor._normalizeScheduledExecutionResult(empty), empty);
  const functional = { status: 'failed', retryable: false, errors: [{ id: 1 }] };
  assert.equal(jobExecutor._normalizeScheduledExecutionResult(functional), functional);
}

async function testMetricsSyncPropagatesTotalAssetFailure() {
  const jobs = new MetaSyncJobs();
  const originalFindAll = db.ClinicMetaAsset.findAll;
  const originalCreate = db.SyncLog.create;
  const originalConsoleError = console.error;
  const originalConsoleLog = console.log;
  const updates = [];
  db.ClinicMetaAsset.findAll = async () => [
    { id: 1, metaAssetName: 'A', assetType: 'facebook_page' },
    { id: 2, metaAssetName: 'B', assetType: 'instagram_business' },
  ];
  db.SyncLog.create = async () => ({
    update: async (patch) => updates.push(patch),
  });
  jobs.syncAssetMetrics = async () => {
    throw new Error('provider timeout');
  };
  console.error = () => {};
  console.log = () => {};
  try {
    const result = await jobs.executeMetricsSync();
    assert.equal(result.status, 'failed');
    assert.equal(result.retryable, true);
    assert.equal(result.assets, 2);
    assert.equal(result.processed, 0);
    assert.equal(result.errors.length, 2);
    assert.equal(updates.at(-1).status, 'failed');
  } finally {
    db.ClinicMetaAsset.findAll = originalFindAll;
    db.SyncLog.create = originalCreate;
    console.error = originalConsoleError;
    console.log = originalConsoleLog;
  }
}

async function testGoogleAdsWaitingUsesValidSyncLogStatus() {
  const jobs = new MetaSyncJobs();
  const originalExecuteGoogleAdsSync = metaSyncJobs.executeGoogleAdsSync;
  const updates = [];
  const retryAt = new Date('2026-07-13T18:00:00.000Z');
  try {
    const result = await jobs._deferGoogleAdsExecution({
      syncLog: { id: 991, update: async (patch) => updates.push(patch) },
      report: { accounts: 2, processed: 1, rows: 10, errors: [] },
      retryAt,
      reason: 'quota_or_usage_pause',
      code: 'GOOGLE_ADS_QUOTA_REACHED',
    });

    assert.equal(updates.length, 1);
    assert.equal(updates[0].status, 'completed');
    assert.notEqual(updates[0].status, 'waiting');
    assert.equal(updates[0].status_report.waiting, true);
    assert.equal(updates[0].status_report.deferred, true);
    assert.equal(updates[0].status_report.next_allowed_at, retryAt.toISOString());
    assert.equal(result.status, 'waiting');
    assert.equal(result.nextAllowedAt.toISOString(), retryAt.toISOString());

    metaSyncJobs.executeGoogleAdsSync = async () => result;
    const normalized = await jobExecutor.runJob({
      id: 992,
      type: 'google_ads_recent',
      payload: {},
    });
    assert.equal(normalized.status, 'waiting');
    assert.equal(normalized.nextRunAt.toISOString(), retryAt.toISOString());

    const syncJobsSource = fs.readFileSync(path.resolve(__dirname, '../../jobs/sync.jobs.js'), 'utf8');
    assert.doesNotMatch(syncJobsSource, /syncLog\.update\(\{\s*status:\s*'waiting'/);
  } finally {
    metaSyncJobs.executeGoogleAdsSync = originalExecuteGoogleAdsSync;
  }
}

function testIntegrationHttpCallsHaveFiniteTimeouts() {
  const syncJobsSource = fs.readFileSync(
    path.resolve(__dirname, '../../jobs/sync.jobs.js'),
    'utf8'
  );
  assert.match(syncJobsSource, /axios\.create\(\{ timeout: SYNC_PROVIDER_HTTP_TIMEOUT_MS \}\)/);
  assert.doesNotMatch(syncJobsSource, /axios\.defaults\.timeout/);
  assert.doesNotMatch(syncJobsSource, /axios\.(get|post|put|patch|delete|head)\(/);

  const metaSyncControllerSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/metasync.controller.js'),
    'utf8'
  );
  assert.match(metaSyncControllerSource, /axios\.create\(\{ timeout: META_PROVIDER_HTTP_TIMEOUT_MS \}\)/);
  assert.doesNotMatch(metaSyncControllerSource, /axios\.(get|post|put|patch|delete|head)\(/);
  const googleAdsClientSource = fs.readFileSync(
    path.resolve(__dirname, '../../lib/googleAdsClient.js'),
    'utf8'
  );
  assert.match(googleAdsClientSource, /GOOGLE_ADS_HTTP_TIMEOUT_MS/);
  assert.doesNotMatch(googleAdsClientSource, /timeoutMs = 0/);
}

async function testStartupRecoveryFinishesBeforeAnyDrain() {
  jobScheduler.stop();
  const originalReset = jobRequestsService.resetRunningJobs;
  const originalClaim = jobRequestsService.claimNextJob;
  const events = [];
  let releaseReset;
  const resetGate = new Promise((resolve) => {
    releaseReset = resolve;
  });

  jobRequestsService.resetRunningJobs = async () => {
    events.push('reset:start');
    await resetGate;
    events.push('reset:done');
    return { rescheduled: 1, exhausted: 0 };
  };
  jobRequestsService.claimNextJob = async () => {
    events.push('claim');
    return null;
  };

  try {
    const starting = jobScheduler.start();
    await Promise.resolve();
    await Promise.resolve();
    assert.deepEqual(events, ['reset:start']);
    assert.equal(jobScheduler._getWorkerState().ready, false);

    releaseReset();
    const report = await starting;
    assert.equal(report.status, 'started');
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(events.includes('claim'));
    assert.ok(events.indexOf('reset:done') < events.indexOf('claim'));
    assert.equal(jobScheduler._getWorkerState().ready, true);
  } finally {
    jobScheduler.stop();
    jobRequestsService.resetRunningJobs = originalReset;
    jobRequestsService.claimNextJob = originalClaim;
  }
}

async function testStartupRecoveryRetriesUntilSuccess() {
  jobScheduler.stop();
  const originalReset = jobRequestsService.resetRunningJobs;
  const originalClaim = jobRequestsService.claimNextJob;
  const originalConsoleError = console.error;
  let resetAttempts = 0;
  let resetCompleted = false;
  let claims = 0;

  jobRequestsService.resetRunningJobs = async () => {
    resetAttempts += 1;
    if (resetAttempts === 1) {
      throw new Error('database warming up');
    }
    resetCompleted = true;
    return { rescheduled: 1, exhausted: 0 };
  };
  jobRequestsService.claimNextJob = async () => {
    assert.equal(resetCompleted, true, 'no drain may run before a successful reset');
    claims += 1;
    return null;
  };
  console.error = () => {};

  try {
    assert.equal(jobScheduler._buildStartupRetryDelay(1, {
      retryBaseDelayMs: 2,
      retryMaxDelayMs: 5,
    }), 2);
    assert.equal(jobScheduler._buildStartupRetryDelay(4, {
      retryBaseDelayMs: 2,
      retryMaxDelayMs: 5,
    }), 5);

    const report = await jobScheduler.start({
      retryBaseDelayMs: 1,
      retryMaxDelayMs: 1,
    });
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(report.status, 'started');
    assert.equal(report.startupAttempts, 2);
    assert.equal(report.startupRetries, 1);
    assert.equal(resetAttempts, 2);
    assert.ok(claims > 0);
    const state = jobScheduler._getWorkerState();
    assert.equal(state.ready, true);
    assert.equal(state.lastStartupError, null);
    assert.equal(state.nextStartupRetryAt, null);
  } finally {
    jobScheduler.stop();
    jobRequestsService.resetRunningJobs = originalReset;
    jobRequestsService.claimNextJob = originalClaim;
    console.error = originalConsoleError;
  }
}

async function testStopCancelsStartupRecoveryRetry() {
  jobScheduler.stop();
  const originalReset = jobRequestsService.resetRunningJobs;
  const originalClaim = jobRequestsService.claimNextJob;
  const originalConsoleError = console.error;
  let resetAttempts = 0;
  let claims = 0;

  jobRequestsService.resetRunningJobs = async () => {
    resetAttempts += 1;
    throw new Error('database unavailable');
  };
  jobRequestsService.claimNextJob = async () => {
    claims += 1;
    return null;
  };
  console.error = () => {};

  try {
    const starting = jobScheduler.start({
      retryBaseDelayMs: 5000,
      retryMaxDelayMs: 5000,
    });
    while (!jobScheduler._getWorkerState().nextStartupRetryAt) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    jobScheduler.stop();
    const report = await starting;
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(report.status, 'stopped_during_startup');
    assert.equal(resetAttempts, 1, 'stop must cancel the pending retry');
    assert.equal(claims, 0, 'a failed startup must never install drains');
    const state = jobScheduler._getWorkerState();
    assert.equal(state.running, false);
    assert.equal(state.ready, false);
    assert.equal(state.nextStartupRetryAt, null);
  } finally {
    jobScheduler.stop();
    jobRequestsService.resetRunningJobs = originalReset;
    jobRequestsService.claimNextJob = originalClaim;
    console.error = originalConsoleError;
  }
}

async function testSettlementPersistenceFailurePropagatesAndIsVisible() {
  const originalRunJob = jobExecutor.runJob;
  const originalMarkCompleted = jobRequestsService.markCompleted;
  const originalRecover = jobRequestsService.recoverRunningJobAfterSettlementFailure;
  const originalConsoleError = console.error;
  let recoveryOptions = null;
  jobExecutor.runJob = async () => ({ status: 'completed', result: { ok: true } });
  jobRequestsService.markCompleted = async () => {
    throw new Error('database unavailable while settling');
  };
  jobRequestsService.recoverRunningJobAfterSettlementFailure = async (_id, options) => {
    recoveryOptions = options;
    return { resolved: true, updated: 1, job: { status: 'completed' } };
  };
  console.error = () => {};

  try {
    await assert.rejects(
      () => jobScheduler._settleJobResult({ id: 90 }, { status: 'completed' }),
      /database unavailable while settling/
    );
    await assert.rejects(
      () => jobScheduler._processJob({ id: 91, type: 'system_health_check' }),
      /database unavailable while settling/
    );
    const state = jobScheduler._getWorkerState();
    assert.match(state.lastError, /No se pudo persistir el estado del job 91/);
    assert.equal(state.lastSettlementFailure.jobId, 91);
    assert.equal(state.lastSettlementFailure.recoveryStatus, 'completed');
    assert.equal(recoveryOptions.status, 'completed');
    assert.equal(recoveryOptions.nextRunAt, null);
    assert.equal(state.activeJobs, 0);
  } finally {
    jobExecutor.runJob = originalRunJob;
    jobRequestsService.markCompleted = originalMarkCompleted;
    jobRequestsService.recoverRunningJobAfterSettlementFailure = originalRecover;
    console.error = originalConsoleError;
  }
}

async function testSettlementRecoveryUsesCompareAndSet() {
  const originalUpdate = db.JobRequest.update;
  const originalFind = db.JobRequest.findByPk;
  let updateOptions = null;
  db.JobRequest.update = async (_patch, options) => {
    updateOptions = options;
    return [1];
  };
  db.JobRequest.findByPk = async () => ({ id: 1201, status: 'waiting' });
  try {
    const result = await jobRequestsService.recoverRunningJobAfterSettlementFailure(1201, {
      status: 'waiting',
      nextRunAt: new Date(),
      errorMessage: 'settlement failed',
    });
    assert.equal(result.resolved, true);
    assert.equal(updateOptions.where.id, 1201);
    assert.equal(updateOptions.where.status, 'running');
  } finally {
    db.JobRequest.update = originalUpdate;
    db.JobRequest.findByPk = originalFind;
  }
}

async function testNormalSettlementUsesCompareAndSetAndResolvesConflicts() {
  const originalUpdate = db.JobRequest.update;
  const originalFind = db.JobRequest.findByPk;
  const updates = [];
  const persistedStatuses = new Map([
    [1301, 'waiting'],
    [1302, 'cancelled'],
    [1303, 'failed'],
  ]);

  db.JobRequest.update = async (patch, options) => {
    updates.push({ patch, options });
    return [0];
  };
  db.JobRequest.findByPk = async (id) => ({ id, status: persistedStatuses.get(id) });

  try {
    const waiting = await jobRequestsService.markWaiting(1301, {
      nextRunAt: new Date('2026-07-13T20:00:00.000Z'),
      errorMessage: 'retry later',
    });
    const completed = await jobRequestsService.markCompleted(1302, {
      resultSummary: { ok: true },
    });
    const failed = await jobRequestsService.markFailed(1303, {
      errorMessage: 'terminal',
    });

    assert.equal(updates.length, 3);
    for (const update of updates) {
      assert.equal(update.options.where.status, 'running');
      assert.ok(update.options.where.id);
    }
    assert.deepEqual(
      updates.map((entry) => entry.patch.status),
      ['waiting', 'completed', 'failed']
    );
    for (const result of [waiting, completed, failed]) {
      assert.equal(result.updated, 0);
      assert.equal(result.resolved, true);
      assert.equal(result.conflict, true);
    }
    assert.equal(waiting.job.status, 'waiting');
    assert.equal(completed.job.status, 'cancelled');
    assert.equal(failed.job.status, 'failed');
  } finally {
    db.JobRequest.update = originalUpdate;
    db.JobRequest.findByPk = originalFind;
  }
}

async function run() {
  testCatalogCoversEveryCronAndExecutor();
  await testTargetedHandlersKeepTheirExactMappings();
  await testQueuedStatusAndSchedulerIndexContract();
  await testCronMonitorReportsEnqueueNotBusinessCompletion();
  await testBackgroundLaneIsSeparateAndSequential();
  await testBackgroundLaneUsesDurableMysqlLease();
  await testImmediateBackgroundTriggerJoinsBackgroundDrain();
  await testUniqueEnqueueSerializesMissingRowRace();
  await testUniqueEnqueueRereadsAfterDeadlock();
  await testRetrySettlementAndSyncLogLink();
  await testRestartReschedulesOnlyNonExhaustedJobs();
  await testDiagnosticsHandlerCarriesJobIdentityAndReportedFailure();
  await testAuditFindingDoesNotRetryButTechnicalFailureDoes();
  testScheduledJobsDoNotUseUncancellableTimeout();
  testBatchFailuresAreNotReportedAsSuccessful();
  await testMetricsSyncPropagatesTotalAssetFailure();
  await testGoogleAdsWaitingUsesValidSyncLogStatus();
  testIntegrationHttpCallsHaveFiniteTimeouts();
  await testStartupRecoveryFinishesBeforeAnyDrain();
  await testStartupRecoveryRetriesUntilSuccess();
  await testStopCancelsStartupRecoveryRetry();
  await testSettlementPersistenceFailurePropagatesAndIsVisible();
  await testSettlementRecoveryUsesCompareAndSet();
  await testNormalSettlementUsesCompareAndSetAndResolvesConflicts();
  console.log('scheduled_jobs_orchestration.test.js: OK');
}

async function closeTestResources() {
  jobRequestsService.acquireBackgroundIntegrationLease = realAcquireBackgroundIntegrationLease;
  const queueList = Object.values(queues || {});
  // BullMQ crea conexiones perezosas. Cerrarlas mientras aún están en
  // handshake deja un error tardío de ioredis; primero esperamos readiness.
  await Promise.all(queueList.map((queue) => queue.waitUntilReady()));
  await Promise.all(queueList.map((queue) => queue.close()));
  await new Promise((resolve) => setImmediate(resolve));
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeTestResources);
