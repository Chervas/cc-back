'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

// Este test de integración usa BD real, pero nunca puede reclamar/resetear la
// cola del backend que esté levantado en el mismo checkout.
process.env.JOB_RUNTIME_NAMESPACE = `test:job-executor:${process.pid}:${Date.now()}`;
process.env.JOB_RUNTIME_CLAIM_UNSCOPED = 'false';
process.env.JOB_RUNTIME_NAMESPACE_ALIASES = '';

const db = require('../../../models');
const jobRequestsService = require('../../services/jobRequests.service');
const jobScheduler = require('../../services/jobScheduler.service');
const { metaSyncJobs } = require('../../jobs/sync.jobs');
const { queues } = require('../../services/queue.service');
const createdJobIds = [];

async function run() {
  await db.sequelize.authenticate();

  // Arrancar scheduler (idempotente)
  await jobScheduler.start();

  // ---- Caso completado ----
  metaSyncJobs.executeAdsSync = async () => ({ status: 'completed' });
  const completedJob = await jobRequestsService.enqueueJobRequest({
    type: 'meta_ads_recent',
    payload: {},
    priority: 'normal',
    origin: 'test:completed'
  });
  createdJobIds.push(completedJob.id);
  await jobScheduler.triggerImmediate(completedJob.id);
  const completed = await jobRequestsService.findJobById(completedJob.id);
  console.log('[Completed] id=%s status=%s', completed?.id, completed?.status);

  // ---- Caso waiting ----
  metaSyncJobs.executeGoogleAdsSync = async () => ({
    status: 'waiting',
    nextAllowedAt: new Date(Date.now() + 60000).toISOString()
  });
  const waitingJob = await jobRequestsService.enqueueJobRequest({
    type: 'google_ads_recent',
    payload: {},
    priority: 'normal',
    origin: 'test:waiting'
  });
  createdJobIds.push(waitingJob.id);
  await jobScheduler.triggerImmediate(waitingJob.id);
  const waiting = await jobRequestsService.findJobById(waitingJob.id);
  console.log('[Waiting] id=%s status=%s next_run_at=%s', waiting?.id, waiting?.status, waiting?.next_run_at);

  // ---- Caso failed ----
  metaSyncJobs.executeWebSync = async () => {
    throw new Error('forced failure');
  };
  const failedJob = await jobRequestsService.enqueueJobRequest({
    type: 'web_recent',
    payload: {},
    priority: 'normal',
    origin: 'test:failed',
    maxAttempts: 1
  });
  createdJobIds.push(failedJob.id);
  await jobScheduler.triggerImmediate(failedJob.id);
  const failed = await jobRequestsService.findJobById(failedJob.id);
  console.log('[Failed] id=%s status=%s error=%s', failed?.id, failed?.status, failed?.error_message);

  jobScheduler.stop();

}

async function closeTestResources() {
  jobScheduler.stop();
  const queueList = Object.values(queues || {});
  await Promise.all(queueList.map((queue) => queue.waitUntilReady()));
  await Promise.all(queueList.map((queue) => queue.close()));
  if (createdJobIds.length) {
    const { Op } = db.Sequelize;
    await db.JobRequest.destroy({ where: { id: { [Op.in]: createdJobIds } } });
  }
  await db.sequelize.close();
  await new Promise((resolve) => setImmediate(resolve));
}

run()
  .catch((error) => {
    console.error('❌ Test job_executor falló:', error);
    process.exitCode = 1;
  })
  .finally(closeTestResources);
