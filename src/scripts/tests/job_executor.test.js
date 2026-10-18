'use strict';

const { ownedMysqlTestEntry } = require('./fixtures/owned_mysql_test_entry.fixture');
ownedMysqlTestEntry(process.env);
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Sequelize = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');

// No dotenv, canonical model bootstrap, Redis, providers or host DB selection.
process.env.JOB_RUNTIME_NAMESPACE = 'qa_job_executor';
process.env.JOB_RUNTIME_CLAIM_UNSCOPED = 'false';
process.env.JOB_RUNTIME_NAMESPACE_ALIASES = '';

function loadService(relative, dependencies) {
  const filename = require.resolve(relative);
  const module = { exports: {} };
  const fail = name => { throw Error(`UNEXPECTED_DEPENDENCY_IN_OWNED_JOB_EXECUTOR_TEST: ${name}`); };
  const env = { RUNTIME_ROLE: 'api', JOB_RUNTIME_NAMESPACE: process.env.JOB_RUNTIME_NAMESPACE,
    JOB_RUNTIME_CLAIM_UNSCOPED: 'false', JOB_RUNTIME_NAMESPACE_ALIASES: '' };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, Date, Error, Buffer, console, setTimeout, clearTimeout,
    setInterval: () => fail('scheduler timer'), clearInterval,
    process: { env, cwd: () => '/owned-job-executor-test' },
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : fail(name),
  }, { filename, timeout: 2000 });
  return module.exports;
}

withIsolatedCampaignMysql(async ({ sql, models, report }) => {
  models.Sequelize = Sequelize;
  models.JobRequest = require('../../../models/jobrequest')(sql, Sequelize.DataTypes);
  await models.JobRequest.sync();
  const requests = require('../../services/jobRequests.service');
  const fail = () => { throw Error('UNRELATED_HANDLER_FORBIDDEN_IN_OWNED_JOB_EXECUTOR_TEST'); };
  const blocked = new Proxy({}, { get: () => fail });
  const metaSyncJobs = {};
  const executorDependencies = {
    '../jobs/sync.jobs': { metaSyncJobs }, '../../models': models,
    '../config/scheduledJobCatalog': require('../../config/scheduledJobCatalog'),
    '../lib/jobExecutionTimeoutPolicy': require('../../lib/jobExecutionTimeoutPolicy'),
    './jobClaim.service': require('../../services/jobClaim.service'),
  };
  for (const name of [
    './flowEngineV2.service', '../lib/automation-conversation-context', './conversationPendingReply.service',
    './automationHumanIntervention.service', './whatsappCoexistence.service', './whatsappTemplates.service',
    './marketingBulkSends.service', './googleReviewMatch.service', './intakeQuickChatOutbox.service',
    './marketingAiVisibility.service', './webContentGeneration.service', './emailDelivery.service',
    './systemNotifications.service', './notifications.service', './notificationsRealtime.service',
  ]) executorDependencies[name] = blocked;
  const executor = loadService('../../services/jobExecutor.service', executorDependencies);
  const scheduler = loadService('../../services/jobScheduler.service', {
    '../../models': models, './jobRequests.service': requests, './jobExecutor.service': executor,
    './aiRuntimeMonitoring.service': blocked,
    '../config/scheduledJobCatalog': require('../../config/scheduledJobCatalog'),
    '../lib/gatewayJobOwnership': require('../../lib/gatewayJobOwnership'),
  });
  try {
    for (const scenario of [
      { type: 'meta_ads_recent', method: 'executeAdsSync', expected: 'completed', run: async () => ({ status: 'completed' }) },
      { type: 'google_ads_recent', method: 'executeGoogleAdsSync', expected: 'waiting', run: async () => ({
        status: 'waiting', nextAllowedAt: new Date(Date.now() + 60000).toISOString(),
      }) },
      { type: 'web_recent', method: 'executeWebSync', expected: 'failed', run: async () => { throw Error('forced failure'); } },
    ]) {
      metaSyncJobs[scenario.method] = scenario.run;
      const job = await requests.enqueueJobRequest({ type: scenario.type, payload: {}, priority: 'normal',
        origin: `test:${scenario.expected}`, maxAttempts: 1 });
      await scheduler.triggerImmediate(job.id);
      const result = await requests.findJobById(job.id);
      assert.equal(result?.status, scenario.expected);
      assert.equal(result.attempts, 1);
      assert.equal(result.payload.__runtime_namespace, 'qa_job_executor');
      if (scenario.expected === 'waiting') assert(new Date(result.next_run_at).getTime() > Date.now());
      if (scenario.expected === 'failed') assert.match(result.error_message, /forced failure/);
      report.checks.push(`real scheduler/executor persist ${scenario.expected} in owned MySQL`);
    }
    assert.equal(await models.JobRequest.count(), 3);
  } finally {
    scheduler.stop();
  }
}).catch(error => {
  console.error('job_executor owned MySQL integration failed:', error);
  process.exitCode = 1;
});
