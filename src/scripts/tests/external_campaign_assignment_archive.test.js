'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Op } = require('sequelize');
process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';
const db = require('../../../models');
const adminController = require('../../controllers/adminManagedCampaigns.controller');
const syncJobs = require('../../jobs/sync.jobs');

async function testArchiveAuditAndIdempotency() {
  const updates = [];
  const row = {
    status: 'active',
    archive_reason: null,
    archived_by_user_id: null,
    archived_at: null,
    async update(values) {
      updates.push(values);
      Object.assign(this, values);
    },
  };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const sequelize = { transaction: async (callback) => callback(transaction) };
  const assignmentModel = {
    async findOne(options) {
      assert.deepEqual(options.where, {
        provider: 'google_ads',
        customer_id: '1851215478',
        campaign_id: '21800484692',
      });
      assert.equal(options.lock, 'UPDATE');
      assert.equal(options.transaction, transaction);
      return row;
    },
  };
  const archivedAt = new Date('2026-07-11T02:00:00.000Z');
  const first = await adminController.__test.archiveMatchingAssignment({
    provider: 'google_ads',
    customerId: '1851215478',
    campaignId: '21800484692',
    reason: 'La campaña corresponde a otra sede',
    userId: 1,
    assignmentModel,
    sequelize,
    now: () => archivedAt,
  });
  assert.equal(first.notFound, false);
  assert.equal(first.idempotent, false);
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    status: 'archived',
    archive_reason: 'La campaña corresponde a otra sede',
    archived_by_user_id: 1,
    archived_at: archivedAt,
  });

  const second = await adminController.__test.archiveMatchingAssignment({
    provider: 'google_ads',
    customerId: '1851215478',
    campaignId: '21800484692',
    reason: 'Reintento que no debe sobrescribir la auditoría original',
    userId: 2,
    assignmentModel,
    sequelize,
  });
  assert.equal(second.idempotent, true);
  assert.equal(updates.length, 1, 'An idempotent archive must preserve the first audit evidence');

  const missing = await adminController.__test.archiveMatchingAssignment({
    provider: 'meta_ads',
    customerId: '999',
    campaignId: 'missing',
    reason: 'No existe',
    userId: 1,
    assignmentModel: { findOne: async () => null },
    sequelize,
  });
  assert.equal(missing.notFound, true);
}

async function testArchivedAssignmentWinsOverFuzzyAndDefault() {
  const originalFindAll = db.ExternalCampaignAssignment.findAll;
  const originalUpsert = db.GoogleAdsInsightsDaily.upsert;
  const persisted = [];
  let matcherCalls = 0;
  try {
    db.ExternalCampaignAssignment.findAll = async (options) => {
      assert.deepEqual(options.where.status[Op.in], ['active', 'archived']);
      assert.ok(options.attributes.includes('status'));
      return [{
        campaign_id: '21800484692',
        clinica_id: 58,
        match_kind: 'manual',
        match_confidence: '1.0000',
        status: 'archived',
      }];
    };
    db.GoogleAdsInsightsDaily.upsert = async (payload) => {
      persisted.push(payload);
      return payload;
    };

    const count = await syncJobs.metaSyncJobs._persistGoogleAdsResults({
      account: { id: 7, customerId: '1851215478', grupoClinicaId: 5 },
      assignment: {
        mode: 'group-auto',
        matcher: {
          matchFromText() {
            matcherCalls += 1;
            return { match: { clinic: { id: 58 }, token: { raw: 'Badalona' } } };
          },
        },
      },
      groupId: 5,
      defaultClinicId: 58,
      results: [{
        campaign: { id: '21800484692', name: 'Propdental Badalona', status: 'ENABLED' },
        adGroup: { id: '9001', name: 'Badalona implantes' },
        metrics: { impressions: 20, clicks: 3, costMicros: 1500000 },
        segments: { date: '2026-07-10', device: 'MOBILE' },
      }],
      report: { notes: [] },
    });

    assert.equal(count, 1);
    assert.equal(matcherCalls, 0, 'A tombstone must short-circuit campaign and ad-group fuzzy matching');
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].clinicaId, null, 'A tombstoned campaign must not inherit a clinic default');
    assert.equal(persisted[0].clinicMatchSource, 'reviewed_campaign_archived');
    assert.equal(persisted[0].campaignId, '21800484692');
    assert.equal(persisted[0].clicks, 3, 'Metrics still persist; only clinic attribution is blocked');

    persisted.length = 0;
    await syncJobs.metaSyncJobs._persistGoogleAdsResults({
      account: { id: 7, customerId: '1851215478', grupoClinicaId: 5 },
      assignment: { mode: 'manual' },
      groupId: 5,
      defaultClinicId: 58,
      results: [{
        campaign: { id: '21800484692', name: 'Propdental Badalona', status: 'ENABLED' },
        adGroup: { id: '9001', name: 'Badalona implantes' },
        metrics: { impressions: 20, clicks: 3, costMicros: 1500000 },
        segments: { date: '2026-07-10', device: 'MOBILE' },
      }],
      report: { notes: [] },
    });
    assert.equal(persisted.length, 1);
    assert.equal(persisted[0].clinicaId, null,
      'A tombstone must also beat the manual account default fallback');
    assert.equal(persisted[0].clinicMatchSource, 'reviewed_campaign_archived');
  } finally {
    db.ExternalCampaignAssignment.findAll = originalFindAll;
    db.GoogleAdsInsightsDaily.upsert = originalUpsert;
  }
}

async function testActiveReviewedAssignmentWinsOverFuzzyAndDefault() {
  const originalFindAll = db.ExternalCampaignAssignment.findAll;
  const originalUpsert = db.GoogleAdsInsightsDaily.upsert;
  const originalIssueUpdate = db.AdAttributionIssue.update;
  const persisted = [];
  const resolvedIssues = [];
  let matcherCalls = 0;
  try {
    db.ExternalCampaignAssignment.findAll = async () => [{
      campaign_id: '90000000001',
      clinica_id: 59,
      match_kind: 'manual',
      match_confidence: '1.0000',
      status: 'active',
    }];
    db.GoogleAdsInsightsDaily.upsert = async (payload) => {
      persisted.push(payload);
      return payload;
    };
    db.AdAttributionIssue.update = async (payload, options) => {
      resolvedIssues.push({ payload, options });
      return [1];
    };

    const baseInput = {
      account: { id: 7, customerId: '1000000001', grupoClinicaId: 5 },
      groupId: 5,
      defaultClinicId: 58,
      results: [{
        campaign: { id: '90000000001', name: 'Sede revisada', status: 'ENABLED' },
        adGroup: { id: '9001', name: 'Otra sede por fuzzy' },
        metrics: { impressions: 20, clicks: 3, costMicros: 1500000 },
        segments: { date: '2026-07-10', device: 'MOBILE' },
      }],
      report: { notes: [] },
    };

    await syncJobs.metaSyncJobs._persistGoogleAdsResults({
      ...baseInput,
      assignment: {
        mode: 'group-auto',
        matcher: {
          matchFromText() {
            matcherCalls += 1;
            return { match: { clinic: { id: 58 }, token: { raw: 'Otra sede' } } };
          },
        },
      },
    });
    assert.equal(matcherCalls, 0, 'A reviewed campaign mapping must short-circuit fuzzy matching');
    assert.equal(persisted[0].clinicaId, 59);
    assert.equal(persisted[0].clinicMatchSource, 'reviewed_campaign');
    assert.equal(persisted[0].clinicMatchValue, 'manual');
    assert.equal(resolvedIssues.length, 1, 'Human review must resolve the campaign attribution issue');
    assert.equal(resolvedIssues[0].payload.status, 'resolved');
    assert.equal(resolvedIssues[0].payload.clinica_id, 59);
    assert.equal(resolvedIssues[0].options.where.entity_id, '90000000001');

    persisted.length = 0;
    await syncJobs.metaSyncJobs._persistGoogleAdsResults({
      ...baseInput,
      assignment: { mode: 'manual' },
    });
    assert.equal(persisted[0].clinicaId, 59,
      'A reviewed campaign mapping must also beat the manual account default');
    assert.equal(persisted[0].clinicMatchSource, 'reviewed_campaign');
  } finally {
    db.ExternalCampaignAssignment.findAll = originalFindAll;
    db.GoogleAdsInsightsDaily.upsert = originalUpsert;
    db.AdAttributionIssue.update = originalIssueUpdate;
  }
}

function testReactivationAndRouteContract() {
  assert.deepEqual(adminController.__test.assignmentReactivationAuditReset(), {
    archive_reason: null,
    archived_by_user_id: null,
    archived_at: null,
  });

  const controllerSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/adminManagedCampaigns.controller.js'),
    'utf8'
  );
  const confirmStart = controllerSource.indexOf('exports.confirmMatching');
  const archiveStart = controllerSource.indexOf('exports.archiveMatching');
  const archiveEnd = controllerSource.indexOf('exports.listBankTransactions', archiveStart);
  assert.ok(confirmStart >= 0 && archiveStart > confirmStart);
  assert.match(controllerSource.slice(confirmStart, archiveStart), /\.\.\.assignmentReactivationAuditReset\(\)/,
    'Manual confirmation must explicitly clear tombstone audit fields');
  assert.doesNotMatch(controllerSource.slice(archiveStart, archiveEnd), /GoogleAdsInsightsDaily|destroy\(|ExternalCampaignInventory/,
    'Archiving must not mutate Ads inventory or delete historical metrics');
  assert.match(controllerSource.slice(archiveStart, archiveEnd), /provider !== 'google_ads'/,
    'The endpoint must not promise a durable tombstone for Meta until its sync consumes assignments');

  const routeSource = fs.readFileSync(
    path.resolve(__dirname, '../../routes/adminManagedCampaigns.routes.js'),
    'utf8'
  );
  const archiveRoute = routeSource.indexOf("router.post('/matching/archive'");
  const dynamicRoute = routeSource.indexOf("router.get('/:id'");
  assert.ok(archiveRoute >= 0 && archiveRoute < dynamicRoute,
    'The matching archive route must be registered before dynamic /:id routes');
}

async function run() {
  await testArchiveAuditAndIdempotency();
  await testArchivedAssignmentWinsOverFuzzyAndDefault();
  await testActiveReviewedAssignmentWinsOverFuzzyAndDefault();
  testReactivationAndRouteContract();
  console.log('external_campaign_assignment_archive.test.js OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
    process.exit(process.exitCode || 0);
  });
