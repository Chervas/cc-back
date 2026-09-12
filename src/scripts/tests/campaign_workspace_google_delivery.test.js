'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadGoogleWorkspaceAds } = require('../../services/googleAdWorkspaceRead.service');
const { aggregateReport, reportPeriod } = require('../../services/campaignWorkspaceReport.service');
const { buildWorkspaceHealth } = require('../../services/campaignWorkspaceHealth.service');
const { normalizeAd, persistAdSnapshot, buildAdQuery } = require('../../services/googleAdCache.service');
const { externalCampaignIdentityKey } = require('../../services/externalCampaignAssignmentTargets.service');
const { googleAdHasUnrestrictedDelivery } = require('../../services/googleAdDelivery.service');

const now = new Date('2026-09-11T12:00:00.123Z');
const account = { id: 1, customerId: '1234567890', isActive: true, googleConnectionId: 2, assignmentScope: 'clinic', clinicaId: 901 };
const campaign = { id: 'google_ads:1234567890:456', provider: 'google_ads', account_id: account.customerId, campaign_id: '456',
  name: 'Primera visita', clinicId: 901, assigned: true, status: 'ENABLED', paused: false, destination: 'native', currency: 'EUR' };
campaign.id = externalCampaignIdentityKey(campaign);
const providerRow = () => ({ customer: { id: account.customerId }, campaign: { id: '456', status: 'ENABLED' },
  adGroup: { id: '800', status: 'ENABLED' }, adGroupAd: { status: 'ENABLED', primaryStatus: 'ELIGIBLE', primaryStatusReasons: [],
    policySummary: { approvalStatus: 'APPROVED', reviewStatus: 'REVIEWED' }, ad: { id: '700', name: 'Primera visita' } } });

test('automatic pause eligibility accepts only explicit unrestricted delivery through active parents', () => {
  const input = () => ({ campaignStatus: 'ENABLED', adGroupStatus: 'ENABLED', groupAd: providerRow().adGroupAd });
  assert.equal(googleAdHasUnrestrictedDelivery(input()), true);
  for (const patch of [{ campaignStatus: 'PAUSED' }, { adGroupStatus: 'REMOVED' }, { campaignStatus: undefined },
    { adGroupStatus: undefined }, { groupAd: undefined }, { groupAd: null }]) {
    assert.equal(googleAdHasUnrestrictedDelivery({ ...input(), ...patch }), false);
  }
  for (const status of ['PAUSED', 'REMOVED', 'UNKNOWN', undefined]) {
    const row = input(); row.groupAd.status = status; assert.equal(googleAdHasUnrestrictedDelivery(row), false);
  }
  const snake = { status: 'ENABLED', primary_status: 'ELIGIBLE', policy_summary: { approval_status: 'APPROVED' } };
  assert.equal(googleAdHasUnrestrictedDelivery({ ...input(), groupAd: snake }), true);
  for (const reviewStatus of ['UNDER_APPEAL', 'REVIEW_IN_PROGRESS', 'REVIEWED']) {
    const row = input(); row.groupAd.policySummary.reviewStatus = reviewStatus;
    assert.equal(googleAdHasUnrestrictedDelivery(row), true);
  }
});

async function snapshot(row = providerRow()) {
  let inventory;
  const models = { sequelize: { transaction: async fn => fn({ LOCK: { UPDATE: 'UPDATE' } }) },
    ClinicGoogleAdsAccount: { findByPk: async () => account }, ExternalCampaignAssignment: { findAll: async () => [] },
    GoogleConnectionAssignment: { findAll: async () => [{ googleConnectionId: 2, status: 'active' }] },
    Clinica: { findAll: async () => [{ id_clinica: 901, grupoClinicaId: null }] },
    GoogleAdsAdSyncDay: { findAll: async () => [], bulkCreate: async () => {} },
    GoogleAdsAdInsightsDaily: { destroy: async () => {}, bulkCreate: async () => {} },
    GoogleAdsAdInventory: { findOne: async () => null, update: async () => {}, bulkCreate: async (rows, options) => {
      inventory = rows;
      assert.ok(options.updateOnDuplicate.includes('deliveryObservation'));
    } } };
  await persistAdSnapshot({ models, account, inventoryRows: [row], metricRows: [], start: '2026-09-10', end: '2026-09-10', observedAt: now });
  return inventory[0];
}

async function report(inventory) {
  const ads = await loadGoogleWorkspaceAds({ models: {
    GoogleAdsAdInventory: { findAll: async () => inventory }, GoogleAdsAdInsightsDaily: { findAll: async () => [] },
    GoogleAdsAdSyncDay: { findAll: async () => [] },
  }, googleWhere: [{ customerId: account.customerId, campaignId: '456' }], dateWhere: {} });
  const result = buildWorkspaceHealth(aggregateReport({ campaigns: [campaign], ads, now, period: reportPeriod(30, now) }), new Map(), now);
  return { ...result, block: result.healthBlocks.find(block => block.id === 'delivery') };
}

test('Google inventory requests approval and primary status without adding them to metric queries', () => {
  for (const field of ['primary_status', 'primary_status_reasons', 'policy_summary.approval_status', 'policy_summary.review_status']) {
    assert.ok(buildAdQuery({ inventory: true }).includes(`ad_group_ad.${field}`));
    assert.ok(!buildAdQuery({ start: '2026-09-10', end: '2026-09-10' }).includes(`ad_group_ad.${field}`));
  }
});

test('Google preserves configured ENABLED separately from a rejected policy in the persisted snapshot and report', async () => {
  const row = providerRow(); row.adGroupAd.primaryStatus = 'NOT_ELIGIBLE';
  row.adGroupAd.policySummary.approvalStatus = 'DISAPPROVED';
  row.adGroupAd.primaryStatusReasons = ['AD_GROUP_AD_DISAPPROVED'];
  const cached = await snapshot(row);
  assert.equal(cached.adStatus, 'ENABLED');
  assert.equal(cached.deliveryObservation.approvalStatus, 'DISAPPROVED');
  assert.equal(cached.deliveryObservation.observedAt, now.toISOString());
  const result = await report([cached]);
  assert.equal(result.rows[0].ads[0].status, 'DISAPPROVED');
  assert.equal(result.rows[0].ads[0].active, false);
  assert.equal(result.rows[0].ads[0].rejected, true);
  assert.equal(result.block.tone, 'critical');
});

test('snake-case provider fields are normalized without retaining arbitrary policy content', async () => {
  const row = providerRow();
  row.ad_group_ad = { status: 'ENABLED', ad: row.adGroupAd.ad, primary_status: 'NOT_ELIGIBLE',
    primary_status_reasons: ['AD_GROUP_AD_DISAPPROVED', 'AD_GROUP_AD_DISAPPROVED', { secret: 'not-an-enum' }],
    policy_summary: { approval_status: 'DISAPPROVED', review_status: 'UNDER_APPEAL', token: 'must-not-be-copied' } };
  delete row.adGroupAd;
  const cached = await snapshot(row);
  assert.deepEqual(cached.deliveryObservation.primaryStatusReasons, ['AD_GROUP_AD_DISAPPROVED']);
  assert.equal(cached.deliveryObservation.reviewStatus, 'UNDER_APPEAL');
  assert.doesNotMatch(JSON.stringify(cached), /must-not-be-copied|not-an-enum/);
  assert.equal((await report([cached])).block.tone, 'critical');
});

test('Google eligible, pending, disallowed and limited delivery are different states', async () => {
  for (const [primaryStatus, approvalStatus, expectedStatus, tone, active] of [
    ['ELIGIBLE', 'APPROVED', 'ENABLED', 'good', true],
    ['PENDING', 'APPROVED', 'PENDING', 'warning', false],
    ['NOT_ELIGIBLE', 'APPROVED', 'NOT_ELIGIBLE', 'warning', false],
    ['LIMITED', 'APPROVED_LIMITED', 'LIMITED', 'warning', true],
    ['ELIGIBLE', 'AREA_OF_INTEREST_ONLY', 'LIMITED', 'warning', true],
  ]) {
    const row = providerRow(); row.adGroupAd.primaryStatus = primaryStatus; row.adGroupAd.policySummary.approvalStatus = approvalStatus;
    const result = await report([await snapshot(row)]);
    assert.equal(result.rows[0].ads[0].status, expectedStatus, primaryStatus);
    assert.equal(result.rows[0].ads[0].active, active, primaryStatus);
    assert.equal(result.block.tone, tone, primaryStatus);
    if (primaryStatus === 'LIMITED') assert.doesNotMatch(result.block.summary, /no est.n activos/);
  }
});

test('under-review status alone never overrides Google eligibility or invents a rejection', async () => {
  for (const reviewStatus of ['REVIEW_IN_PROGRESS', 'UNDER_APPEAL', 'ELIGIBLE_MAY_SERVE']) {
    const row = providerRow(); row.adGroupAd.policySummary.reviewStatus = reviewStatus;
    assert.equal((await report([await snapshot(row)])).rows[0].ads[0].status, 'ENABLED');
  }
});

test('legacy, malformed, mismatched and unknown Google delivery observations never produce a green check', async () => {
  const valid = await snapshot();
  for (const observation of [null, {}, [], 'bad', { ...valid.deliveryObservation, schemaVersion: 2 },
    { ...valid.deliveryObservation, observedAt: '2026-09-10T12:00:00.123Z' },
    { ...valid.deliveryObservation, primaryStatus: 'NEW_FUTURE_STATE' },
    { ...valid.deliveryObservation, approvalStatus: null }]) {
    const result = await report([{ ...valid, deliveryObservation: observation }]);
    assert.equal(result.block.tone, 'neutral'); assert.equal(result.block.status, 'Sin comprobar');
    assert.equal(result.rows[0].ads[0].active, false);
  }
});

test('paused parents remain inactive, unknown parents do not become enabled, and disappeared ads are unverified', async () => {
  const valid = await snapshot();
  for (const [patch, status] of [[{ adGroupStatus: 'PAUSED' }, 'PAUSED'], [{ campaignStatus: 'REMOVED' }, 'REMOVED'],
    [{ adGroupStatus: 'UNKNOWN' }, 'UNKNOWN'], [{ present: false }, 'UNKNOWN'], [{ present: 0 }, 'UNKNOWN'], [{ present: '1' }, 'UNKNOWN']]) {
    const result = await report([{ ...valid, ...patch }]);
    assert.equal(result.rows[0].ads[0].status, status); assert.equal(result.rows[0].ads[0].active, false);
  }
});

test('raw MySQL boolean values retain eligible Google inventory', async () => {
  const valid = await snapshot();
  const result = await report([{ ...valid, present: 1 }]);
  assert.equal(result.rows[0].ads[0].status, 'ENABLED'); assert.equal(result.block.tone, 'good');
});

test('a rejected and a limited Google ad keep both issues visible in the same block', async () => {
  const rejected = providerRow(); rejected.adGroupAd.policySummary.approvalStatus = 'DISAPPROVED';
  rejected.adGroupAd.primaryStatus = 'NOT_ELIGIBLE';
  const limited = providerRow(); limited.adGroupAd.primaryStatus = 'LIMITED'; limited.adGroupAd.ad.id = '701';
  const result = await report([await snapshot(rejected), await snapshot(limited)]);
  assert.equal(result.healthBlocks.length, 6); assert.equal(result.block.findings.length, 2);
  assert.equal(result.affectedCount, 1); assert.equal(result.block.tone, 'critical');
});

test('missing optional delivery column supports old schema without hiding unrelated database errors', async () => {
  const calls = []; const legacy = { ...normalizeAd(providerRow(), account), present: true, observedAt: now };
  const args = { models: {
    GoogleAdsAdInventory: { findAll: async options => {
      calls.push(options.attributes);
      if (options.attributes.includes('deliveryObservation')) throw { original: { code: 'ER_BAD_FIELD_ERROR', sqlMessage: "Unknown column 'deliveryObservation' in 'field list'" } };
      return [legacy];
    } },
    GoogleAdsAdInsightsDaily: { findAll: async () => [] }, GoogleAdsAdSyncDay: { findAll: async () => [] },
  }, googleWhere: [{ customerId: account.customerId, campaignId: '456' }], dateWhere: {} };
  const ads = await loadGoogleWorkspaceAds(args);
  assert.equal(calls.length, 2); assert.equal(ads[0].status, 'UNKNOWN');
  for (const error of [{ original: { code: 'ER_BAD_FIELD_ERROR', sqlMessage: "Unknown column 'adName' in 'field list'" } },
    { original: { code: 'ER_NO_SUCH_TABLE' } }, new Error('connection lost')]) {
    args.models.GoogleAdsAdInventory.findAll = async () => { throw error; };
    await assert.rejects(loadGoogleWorkspaceAds(args), actual => actual === error);
  }
});
