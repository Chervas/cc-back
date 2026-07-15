'use strict';

const assert = require('assert/strict');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const db = require('../../../models');
const controller = require('../../controllers/marketingCompetition.controller');
const { queues } = require('../../services/queue.service');

async function testSingleCompetitorUsesDurableScopedRefresh() {
  const calls = {
    enqueue: [],
    update: [],
    trigger: [],
  };
  const dependencies = {
    jobRequestsService: {
      enqueueUniqueJobRequest: async (options) => {
        calls.enqueue.push(options);
        return { created: true, job: { id: 801, payload: options.payload } };
      },
    },
    competitionService: {
      updateCompetitor: async (...args) => {
        calls.update.push(args);
        return { id: args[1], ...args[2] };
      },
    },
    jobScheduler: {
      triggerImmediate: async (jobId) => {
        calls.trigger.push(jobId);
        return true;
      },
    },
  };

  const result = await controller.__testing.enqueueCompetitionRefresh({
    scope: { scope: 'clinic', clinicIds: [58], groupId: null },
    competitorIds: ['52', 52, null, -1],
    origin: 'marketing_reports:competition_create',
    requestedBy: 7,
    requestedByRole: 'admin',
    requestedByName: 'Tester',
    markCompetitorQueued: true,
  }, dependencies);

  assert.equal(result.created, true);
  assert.equal(result.job.id, 801);
  assert.deepEqual(result.payload, { clinicId: 58, competitorIds: [52] });
  assert.equal(calls.enqueue.length, 1);
  assert.deepEqual(calls.enqueue[0], {
    type: 'competition_refresh',
    payload: { clinicId: 58, competitorIds: [52] },
    priority: 'low',
    origin: 'marketing_reports:competition_create',
    requestedBy: 7,
    requestedByRole: 'admin',
    requestedByName: 'Tester',
    maxAttempts: 4,
    dedupeScope: 'competition:competitor:52',
  });
  assert.deepEqual(calls.update, [[
    { scope: 'clinic', clinicIds: [58], groupId: null },
    52,
    { last_sync_status: 'queued', last_sync_error: null },
  ]]);
  assert.deepEqual(calls.trigger, [801]);
}

async function testExistingJobIsReusedWithoutRegressingCompetitorState() {
  let updateCalls = 0;
  const triggerCalls = [];
  const result = await controller.__testing.enqueueCompetitionRefresh({
    scope: { scope: 'clinic', clinicIds: [58] },
    competitorIds: [52],
    origin: 'marketing_reports:competition_create',
    markCompetitorQueued: true,
  }, {
    jobRequestsService: {
      enqueueUniqueJobRequest: async () => ({ created: false, job: { id: 799 } }),
    },
    competitionService: {
      updateCompetitor: async () => {
        updateCalls += 1;
      },
    },
    jobScheduler: {
      triggerImmediate: async (jobId) => {
        triggerCalls.push(jobId);
      },
    },
  });

  assert.equal(result.created, false);
  assert.equal(updateCalls, 0, 'a running refresh must not be overwritten back to queued');
  assert.deepEqual(triggerCalls, [799]);
}

async function testBatchPayloadKeepsEveryCompetitor() {
  const payload = controller.__testing.buildCompetitionRefreshPayload({
    scope: 'multi',
    clinicIds: [58, '57', 58],
  }, [55, '53', 55, 54]);

  assert.deepEqual(payload, {
    clinicIds: [57, 58],
    competitorIds: [53, 54, 55],
  });
}

async function run() {
  await testSingleCompetitorUsesDurableScopedRefresh();
  await testExistingJobIsReusedWithoutRegressingCompetitorState();
  await testBatchPayloadKeepsEveryCompetitor();
  console.log('marketing_competitor_hydration_queue.test.js OK');
}

async function closeTestResources() {
  const queueList = Object.values(queues || {});
  await Promise.all(queueList.map((queue) => queue.waitUntilReady()));
  await Promise.all(queueList.map((queue) => queue.close()));
  await db.sequelize.close();
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeTestResources);
