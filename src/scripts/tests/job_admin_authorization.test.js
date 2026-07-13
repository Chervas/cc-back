'use strict';

const assert = require('assert/strict');
const metaJobsController = require('../../controllers/metasync.jobs.controller');
const jobRequestsController = require('../../controllers/jobrequests.controller');
const jobRequestsService = require('../../services/jobRequests.service');
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
