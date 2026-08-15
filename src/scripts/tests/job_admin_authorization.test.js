'use strict';

const assert = require('assert/strict');
const db = require('../../../models');
const metaJobsController = require('../../controllers/metasync.jobs.controller');
const jobRequestsController = require('../../controllers/jobrequests.controller');
const jobRequestsService = require('../../services/jobRequests.service');
const jobScheduler = require('../../services/jobScheduler.service');
const { queues } = require('../../services/queue.service');

function responseHarness() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function assertForbidden(handler, request) {
  const response = responseHarness();
  await handler({ body: {}, params: {}, userData: { userId: 999 }, ...request }, response);
  assert.equal(response.statusCode, 403);
  assert.deepEqual(response.body, { error: 'admin_only' });
}

async function testNormalUserCannotManageOrRunJobs() {
  for (const handler of [
    metaJobsController.initializeJobs,
    metaJobsController.startJobs,
    metaJobsController.stopJobs,
    metaJobsController.restartJobs,
  ]) {
    await assertForbidden(handler);
  }
  await assertForbidden(metaJobsController.runJob, {
    params: { jobName: 'opsSummary' },
  });

  await assertForbidden(jobRequestsController.create, {
    body: { type: 'system_pm2_log_retention', payload: { directory: '/home/ubuntu' } },
  });
  await assertForbidden(jobRequestsController.list, { query: {} });
  await assertForbidden(jobRequestsController.summary);
  await assertForbidden(jobRequestsController.workerStatus);
  await assertForbidden(jobRequestsController.cancel, { params: { id: '1' } });
  await assertForbidden(jobRequestsController.retry, { params: { id: '1' } });
  await assertForbidden(jobRequestsController.trigger, { params: { id: '1' } });
}

async function testPm2HttpPayloadIsRestrictedToDryRun() {
  const originalUniqueEnqueue = jobRequestsService.enqueueUniqueJobRequest;
  const originalEnqueue = jobRequestsService.enqueueJobRequest;
  let manualArgs = null;
  let rawArgs = null;

  try {
    jobRequestsService.enqueueUniqueJobRequest = async (args) => {
      manualArgs = args;
      return {
        created: true,
        job: {
          id: 101,
          type: args.type,
          status: 'pending',
          priority: args.priority,
          payload: args.payload,
          created_at: new Date(),
        },
      };
    };
    const manualResponse = responseHarness();
    await metaJobsController.runJob({
      params: { jobName: 'pm2LogRetention' },
      body: {
        payload: {
          directory: '/home/ubuntu',
          retentionDays: 1,
          dryRun: true,
        },
      },
      userData: { userId: 1 },
    }, manualResponse);
    assert.equal(manualResponse.statusCode, 200);
    assert.deepEqual(manualArgs.payload, { dryRun: true });

    jobRequestsService.enqueueJobRequest = async (args) => {
      rawArgs = args;
      return {
        id: 102,
        type: args.type,
        priority: args.priority || 'low',
        status: 'pending',
        origin: args.origin,
        payload: args.payload,
        attempts: 0,
        max_attempts: args.maxAttempts || 3,
        created_at: new Date(),
        updated_at: new Date(),
      };
    };
    const rawResponse = responseHarness();
    await jobRequestsController.create({
      body: {
        type: 'system_pm2_log_retention',
        payload: {
          directory: '/home/ubuntu',
          retentionDays: 1,
          dryRun: false,
        },
        priority: 'low',
      },
      userData: { userId: 44 },
    }, rawResponse);
    assert.equal(rawResponse.statusCode, 201);
    assert.deepEqual(rawArgs.payload, { dryRun: false });
  } finally {
    jobRequestsService.enqueueUniqueJobRequest = originalUniqueEnqueue;
    jobRequestsService.enqueueJobRequest = originalEnqueue;
  }
}

async function testGlobalAdminCanReadGenericJobMonitor() {
  const originalList = jobRequestsService.listJobRequests;
  const originalFindAll = db.JobRequest.findAll;
  const originalCount = db.JobRequest.count;
  const originalFindOne = db.JobRequest.findOne;
  const originalGetStatus = jobScheduler.getStatus;
  const calls = [];

  try {
    jobRequestsService.listJobRequests = async (args) => {
      calls.push(['list', args]);
      return {
        rows: [{
          id: 321,
          type: 'health_check',
          priority: 'normal',
          status: 'pending',
          origin: 'manual',
          payload: { safe: true },
          requested_by: 1,
          requested_by_name: 'Admin',
          requested_by_role: 'admin',
          attempts: 0,
          max_attempts: 3,
          created_at: new Date('2026-07-17T10:00:00Z'),
          updated_at: new Date('2026-07-17T10:00:00Z'),
        }],
        count: 1,
      };
    };
    let summaryCall = 0;
    db.JobRequest.findAll = async () => {
      summaryCall += 1;
      const key = summaryCall === 1 ? 'pending' : 'normal';
      return [{
        get(field) {
          if (field === 'total') return '1';
          return key;
        },
      }];
    };
    db.JobRequest.count = async () => 1;
    db.JobRequest.findOne = async () => ({
      id: 654,
      type: 'ops_ads_accounts_discovery',
      priority: 'low',
      status: 'failed',
      origin: 'system',
      payload: {},
      requested_by: null,
      requested_by_name: null,
      requested_by_role: null,
      attempts: 1,
      max_attempts: 3,
      last_attempt_at: new Date('2026-08-15T14:17:00Z'),
      next_run_at: null,
      completed_at: new Date('2026-08-15T14:17:00Z'),
      sync_log_id: null,
      error_message: 'test failure',
      result_summary: null,
      created_at: new Date('2026-08-15T14:17:00Z'),
      updated_at: new Date('2026-08-15T14:17:00Z'),
    });
    jobScheduler.getStatus = async () => ({ running: true });

    const listResponse = responseHarness();
    await jobRequestsController.list({
      query: { view: 'queue', limit: '10' },
      userData: { userId: 1 },
    }, listResponse);
    assert.equal(listResponse.statusCode, 200);
    assert.equal(listResponse.body.data[0].id, 321);
    assert.equal(calls[0][0], 'list');
    assert.deepEqual(calls[0][1].statuses, ['pending', 'running', 'waiting']);

    const failedListResponse = responseHarness();
    await jobRequestsController.list({
      query: { view: 'queue', status: 'failed', limit: '10' },
      userData: { userId: 1 },
    }, failedListResponse);
    assert.equal(failedListResponse.statusCode, 200);
    assert.deepEqual(calls[1][1].statuses, ['failed']);

    const summaryResponse = responseHarness();
    await jobRequestsController.summary({ userData: { userId: 44 } }, summaryResponse);
    assert.equal(summaryResponse.statusCode, 200);
    assert.deepEqual(summaryResponse.body, {
      status: [{ status: 'pending', total: 1 }],
      priority: [{ priority: 'normal', total: 1 }],
      recentFailures24h: {
        total: 1,
        latest: {
          id: 654,
          type: 'ops_ads_accounts_discovery',
          priority: 'low',
          status: 'failed',
          origin: 'system',
          payload: {},
          requestedBy: null,
          requestedByName: null,
          requestedByRole: null,
          attempts: 1,
          maxAttempts: 3,
          lastAttemptAt: new Date('2026-08-15T14:17:00Z'),
          nextRunAt: null,
          completedAt: new Date('2026-08-15T14:17:00Z'),
          syncLogId: null,
          errorMessage: 'test failure',
          resultSummary: null,
          createdAt: new Date('2026-08-15T14:17:00Z'),
          updatedAt: new Date('2026-08-15T14:17:00Z'),
        }
      },
    });

    const workerResponse = responseHarness();
    await jobRequestsController.workerStatus({ userData: { userId: 1 } }, workerResponse);
    assert.equal(workerResponse.statusCode, 200);
    assert.deepEqual(workerResponse.body, { running: true });
  } finally {
    jobRequestsService.listJobRequests = originalList;
    db.JobRequest.findAll = originalFindAll;
    db.JobRequest.count = originalCount;
    db.JobRequest.findOne = originalFindOne;
    jobScheduler.getStatus = originalGetStatus;
  }
}

async function testManualRunMergesCatalogPayloadDefaults() {
  const originalUniqueEnqueue = jobRequestsService.enqueueUniqueJobRequest;
  const calls = [];

  try {
    jobRequestsService.enqueueUniqueJobRequest = async (args) => {
      calls.push(args);
      return {
        created: true,
        job: {
          id: 200 + calls.length,
          type: args.type,
          status: 'pending',
          priority: args.priority,
          payload: args.payload,
          created_at: new Date(),
        },
      };
    };

    for (const request of [
      { params: { jobName: 'opsGoogleBusinessProfileRequested' }, body: {} },
      { params: { jobName: 'adsSyncMidday' }, body: {} },
      {
        params: { jobName: 'opsGoogleBusinessProfileRequested' },
        body: { payload: { onlyRequested: false, source: 'explicit-override' } },
      },
      {
        params: { jobName: 'adsSyncMidday' },
        body: { payload: { windowLabel: 'manual-window' } },
      },
    ]) {
      const response = responseHarness();
      await metaJobsController.runJob({
        ...request,
        userData: { userId: 1 },
      }, response);
      assert.equal(response.statusCode, 200);
    }

    assert.deepEqual(calls[0].payload, { onlyRequested: true });
    assert.deepEqual(calls[1].payload, { windowLabel: 'midday' });
    assert.deepEqual(calls[2].payload, {
      onlyRequested: false,
      source: 'explicit-override',
    });
    assert.deepEqual(calls[3].payload, { windowLabel: 'manual-window' });
  } finally {
    jobRequestsService.enqueueUniqueJobRequest = originalUniqueEnqueue;
  }
}

async function run() {
  await testNormalUserCannotManageOrRunJobs();
  await testGlobalAdminCanReadGenericJobMonitor();
  await testPm2HttpPayloadIsRestrictedToDryRun();
  await testManualRunMergesCatalogPayloadDefaults();
  console.log('job_admin_authorization.test.js: OK');
}

async function closeTestResources() {
  const queueList = Object.values(queues || {});
  await Promise.all(queueList.map((queue) => queue.waitUntilReady()));
  await Promise.all(queueList.map((queue) => queue.close()));
  await new Promise((resolve) => setImmediate(resolve));
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(closeTestResources);
