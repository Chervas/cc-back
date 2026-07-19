'use strict';

process.env.RUNTIME_ROLE = 'gateway';

const assert = require('node:assert/strict');
const db = require('../../../models');
const { metaSyncJobs } = require('../../jobs/sync.jobs');
const marketingCompetitionService = require('../../services/marketingCompetition.service');
const marketingAiVisibilityService = require('../../services/marketingAiVisibility.service');
const webContentMediaService = require('../../services/webContentMedia.service');
const webContentGenerationService = require('../../services/webContentGeneration.service');
const { queues } = require('../../services/queue.service');

async function main() {
  const originals = {
    syncLogCreate: db.SyncLog.create,
    cleanupSyncLogs: metaSyncJobs.cleanupSyncLogs,
    cleanupTokenValidations: metaSyncJobs.cleanupTokenValidations,
    cleanupOldSocialStats: metaSyncJobs.cleanupOldSocialStats,
    cleanupHeatmaps: marketingCompetitionService.cleanupLocalHeatmapCache,
    cleanupAi: marketingAiVisibilityService.cleanupExpiredRuns,
    cleanupWebGenerations: webContentGenerationService.cleanupExpiredGenerations,
    cleanupWebMedia: webContentMediaService.cleanupExpiredQuarantinedMedia,
  };
  const updates = [];
  try {
    db.SyncLog.create = async () => ({
      update: async (values) => { updates.push(values); },
    });
    metaSyncJobs.cleanupSyncLogs = async () => 1;
    metaSyncJobs.cleanupTokenValidations = async () => 2;
    metaSyncJobs.cleanupOldSocialStats = async () => 3;
    marketingCompetitionService.cleanupLocalHeatmapCache = async () => 4;
    marketingAiVisibilityService.cleanupExpiredRuns = async () => 5;
    webContentGenerationService.cleanupExpiredGenerations = async () => 6;
    webContentMediaService.cleanupExpiredQuarantinedMedia = async () => ({
      inspected: 2,
      archived: 2,
      failed: [],
    });

    const result = await metaSyncJobs.executeDataCleanup();
    assert.equal(result.status, 'completed');
    assert.equal(result.deleted, 23);
    assert.equal(result.breakdown.webContentGenerations, 6);
    assert.equal(result.breakdown.webEditorMedia, 2);
    assert.equal(result.breakdown.webEditorMediaFailed, 0);
    assert.equal(updates.at(-1).status, 'completed');

    webContentMediaService.cleanupExpiredQuarantinedMedia = async () => ({
      inspected: 1,
      archived: 0,
      failed: [{ id: 91, code: 's3_unavailable' }],
    });
    await assert.rejects(
      () => metaSyncJobs.executeDataCleanup(),
      /web_editor_media_cleanup_failed:1/
    );
    assert.equal(updates.at(-1).status, 'failed');
  } finally {
    db.SyncLog.create = originals.syncLogCreate;
    metaSyncJobs.cleanupSyncLogs = originals.cleanupSyncLogs;
    metaSyncJobs.cleanupTokenValidations = originals.cleanupTokenValidations;
    metaSyncJobs.cleanupOldSocialStats = originals.cleanupOldSocialStats;
    marketingCompetitionService.cleanupLocalHeatmapCache = originals.cleanupHeatmaps;
    marketingAiVisibilityService.cleanupExpiredRuns = originals.cleanupAi;
    webContentGenerationService.cleanupExpiredGenerations = originals.cleanupWebGenerations;
    webContentMediaService.cleanupExpiredQuarantinedMedia = originals.cleanupWebMedia;
  }
  console.log('web content/media cleanup orchestration: ok');
}

async function closeTestResources() {
  await Promise.all(Object.values(queues || {}).map((queue) => queue.close()));
  await db.sequelize.close();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(closeTestResources);
