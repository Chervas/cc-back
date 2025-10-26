'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const db = require('../../../models');
const jobRequestsService = require('../../services/jobRequests.service');
const jobScheduler = require('../../services/jobScheduler.service');
const { metaSyncJobs } = require('../../jobs/sync.jobs');

async function run() {
  await db.sequelize.authenticate();

  // Arrancar scheduler (idempotente)
  jobScheduler.start();

  // ---- Caso completado ----
  metaSyncJobs.executeAdsSync = async () => ({ status: 'completed' });
  const completedJob = await jobRequestsService.enqueueJobRequest({
    type: 'meta_ads_recent',
    payload: {},
    priority: 'normal',
    origin: 'test:completed'
  });
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
    origin: 'test:failed'
  });
  await jobScheduler.triggerImmediate(failedJob.id);
  const failed = await jobRequestsService.findJobById(failedJob.id);
  console.log('[Failed] id=%s status=%s error=%s', failed?.id, failed?.status, failed?.error_message);

  jobScheduler.stop();

  // Limpieza de registros de prueba
  const { JobRequest, Sequelize } = db;
  const { Op } = Sequelize;
  await JobRequest.destroy({ where: { origin: { [Op.like]: 'test:%' } } });

  await db.sequelize.close();
}

run().catch((error) => {
  console.error('❌ Test job_executor falló:', error);
  jobScheduler.stop();
  db.sequelize.close();
  process.exitCode = 1;
});
