'use strict';
require('./fixtures/security_offline_runtime.cjs');
const { test } = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const { Module } = require('node:module');
const { deriveMetaCampaignSpendFacts: derive } = require('../../services/campaignWorkspaceMetaSpend.service');
const { aggregateReport, reportPeriod } = require('../../services/campaignWorkspaceReport.service');
const { externalCampaignIdentityKey: key } = require('../../services/externalCampaignAssignmentTargets.service');
const now = new Date('2026-11-23T01:00:00Z'), period = reportPeriod(7, now);
const identity = { provider: 'meta_ads', account_id: '10001', customer_id: '10001', campaign_id: '20001' };
const campaign = (changes = {}) => { const c = { ...identity, ...changes }; return { ...c, id: key(c), assigned: true,
  clinicId: 66, name: 'FICTITIOUS', status: 'ACTIVE', paused: false, currency: 'EUR' }; };
const ad = (changes = {}) => ({ ...identity, account_id: 'act_10001', id: '30001', groupId: '40001', date: '2026-11-22',
  segment: ['facebook', 'feed'], spend: 7.5, status: 'ACTIVE', title: 'FICTITIOUS_AD', updatedAt: now,
  metricsUpdatedAt: '2026-11-22T12:00:00Z', ...changes });
const aggregate = (ads, facts = [], campaigns = [campaign()]) => aggregateReport({ campaigns,
  facts: [...facts, ...derive({ campaigns, facts, ads })], ads, period, now });

test('stored ad-only Meta metrics become observed campaign spend while preserving ad detail', () => {
  const result = aggregate([ad()]); const row = result.rows[0];
  assert.equal(row.current.spend, 7.5); assert.equal(result.current.spend, 7.5); assert.equal(row.coverage.spend, true);
  assert.equal(row.ads[0].current.spend, 7.5); assert.equal(row.ads[0].advertisingId, '30001');
  assert.equal(row.coverage.latestMetricDate, '2026-11-22'); assert.equal(row.coverage.updatedAt, '2026-11-22T12:00:00Z');
});
test('native campaign facts win for their entire day without doubling ad fallback', () => {
  const facts = [{ ...identity, date: '2026-11-22', segment: ['facebook', 'feed'], spend: 9, updatedAt: now }];
  const ads = [ad(), ad({ date: '2026-11-21', spend: 3 })];
  const fallback = derive({ campaigns: [campaign()], facts, ads }); assert.equal(fallback.length, 1); assert.equal(fallback[0].date, '2026-11-21');
  assert.equal(aggregate(ads, facts).rows[0].current.spend, 12);
});
test('deduplicates snapshots but retains distinct ads, placements, accounts and dates', () => {
  const first = ad(); const ads = [first, { ...first }, ad({ id: '30002', spend: 4 }), ad({ segment: ['instagram', 'story'], spend: 2 }),
    ad({ account_id: '10002', customer_id: '10002', spend: 8 }), ad({ date: '2026-11-21', spend: 1 })];
  const campaigns = [campaign(), campaign({ account_id: '10002', customer_id: '10002' })];
  const result = aggregate(ads, [], campaigns); assert.equal(result.rows[0].current.spend, 14.5); assert.equal(result.rows[1].current.spend, 8);
});
test('no inventory, orphan identity, foreign account/campaign or malformed metric fabricates spend', () => {
  const invalid = [ad({ inventory: true }), ad({ groupId: null }), ad({ id: null }), ad({ account_id: 'act_999', customer_id: '999' }),
    ad({ campaign_id: '999' }), ad({ customer_id: '999' }), ad({ date: '2026-02-30' }), ad({ spend: null }),
    ad({ spend: NaN }), ad({ spend: -1 }), ad({ segment: null }), ad({ provider: 'google_ads' })];
  assert.deepEqual(derive({ campaigns: [campaign()], ads: invalid }), []);
  const result = aggregate([], []); assert.equal(result.rows[0].current.spend, null); assert.equal(result.rows[0].coverage.spend, false);
});
test('explicit zero is observed but dates outside the report are not counted', () => {
  const result = aggregate([ad({ spend: 0 }), ad({ date: '2026-11-08', spend: 99 }), ad({ date: '2026-11-23', spend: 100 })]);
  assert.equal(result.rows[0].current.spend, 0); assert.equal(result.rows[0].previous.spend, null); assert.equal(result.rows[0].coverage.spend, true);
});
test('metric freshness never borrows refreshed inventory timestamps', () => {
  const result = aggregate([ad({ metricsUpdatedAt: '2026-11-01T01:00:00Z', updatedAt: now })]);
  assert.equal(result.rows[0].coverage.updatedAt, '2026-11-01T01:00:00Z');
  assert.equal(aggregate([ad({ metricsUpdatedAt: null })]).rows[0].coverage.updatedAt, null);
  assert.equal(aggregate([ad({ metricsUpdatedAt: '2026-11-24T01:00:00Z' })]).rows[0].coverage.updatedAt, null);
});
test('rollup does not certify independent campaign/ad reconciliation or comparison', () => {
  const ads = [];
  for (let day = 16; day <= 22; day++) for (let index = 1; index <= 2; index++) ads.push(ad({ id: '3000' + index, date: '2026-11-' + day, spend: index * 10 }));
  const result = aggregate(ads); const row = result.rows[0]; assert.equal(row.current.spend, 210);
  assert.equal(row.adSpendCoverage.current.completeDays, 7); assert.equal(row.adSpendCoverage.current.totalsMatch, true);
  assert.equal(row.adSpendCoverage.current.status, 'incomplete'); assert.equal(row.adSpendCoverage.current.independentCampaignSpend, false);
  assert.equal(row.adAttribution.comparison.status, 'incomplete_metrics'); assert.equal(row.ads[0].currentCpl, null);
  const native = ads.filter(x => x.id === '30001').map(x => ({ ...identity, date: x.date, segment: [], spend: 30, updatedAt: now }));
  assert.equal(aggregate(ads, native).rows[0].adSpendCoverage.current.status, 'matched');
});
test('Google facts/detail and caller inputs are preserved', () => {
  const google = campaign({ provider: 'google_ads', account_id: '1234567890', customer_id: '1234567890' });
  const facts = [{ ...google, date: '2026-11-22', segment: ['1', 'SEARCH', 'MOBILE'], spend: 8, providerConversions: 2, updatedAt: now }];
  const ads = [ad()]; const before = JSON.stringify({ facts, ads });
  const result = aggregate(ads, facts, [google]); assert.equal(result.rows[0].current.spend, 8); assert.equal(result.rows[0].current.providerConversions, 2);
  assert.equal(result.rows[0].adSpendCoverage.current.independentCampaignSpend, undefined); assert.equal(JSON.stringify({ facts, ads }), before);
});

function closedWorkspace() {
  const filename = require.resolve('../../services/campaignWorkspace.service'); const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = module.paths;
  const stubs = {
    './campaignWorkspaceReception.service': { loadFormReceiptEvidence: async () => new Map(), combineReceptionEvidence: () => ({}) },
    './campaignEconomicAttribution.service': { loadBudgetCampaignAttribution: async () => ({ supportedProviders: [], allocations: [], adAllocations: [], coverage: {} }) },
    './leadAdvertisingIdentity.service': { attachLeadAdvertisingIdentities: async () => {} },
    './campaignWorkspaceNativeReception.service': { loadNativeFormEvidence: async () => new Map() },
    './campaignWorkspaceGoogleReception.service': { loadGoogleNativeEvidence: async () => new Map() },
    './campaignWorkspaceSignalEvidence.service': { loadMetaSignalEvidence: async () => new Map() },
    './campaignWorkspaceGoogleSignalEvidence.service': { loadGoogleSignalEvidence: async () => new Map() },
    './campaignWorkspaceOptimizationHistory.service': { loadOptimizationIncidentEvidence: async () => new Map() },
    './campaignMeasurementReadiness.service': { assessConsentMeasurementReadiness: () => ({ ready: false, domains: [] }), resolveWebMeasurementMarketingState: () => ({ marketingState: {}, record: null }) },
    './campaignWorkspaceHealth.service': { buildWorkspaceHealth: report => ({ ...report, findings: [], healthBlocks: [] }) },
  };
  const original = loaded.require.bind(loaded); loaded.require = name => Object.hasOwn(stubs, name) ? stubs[name] : original(name);
  loaded._compile(fs.readFileSync(filename, 'utf8'), filename); return loaded.exports;
}
test('actual workspace joins scoped ad hierarchy and feeds campaign projection; no provider or data writes', async () => {
  const readCalls = []; const empty = { findAll: async () => [] };
  const models = {
    Clinica: { findAll: async () => [{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }] },
    ClinicGoogleAdsAccount: empty, ClinicMetaAsset: { findAll: async () => [{ id: 1, metaAssetId: '10001', assignmentScope: 'group', grupoClinicaId: 29, isActive: true, additionalData: { currency: 'EUR' } }] },
    ExternalCampaignInventory: empty, ExternalCampaignAssignment: { findAll: async () => [{ provider: 'meta_ads', customer_id: '10001', campaign_id: '20001', clinica_id: 66, status: 'active' }] },
    CampaignWorkspaceSetting: empty, LeadIntake: empty, CitaPaciente: empty, IntakeConfig: empty,
    SocialAdsEntity: { findAll: async options => {
      readCalls.push(options.where.level);
      if (options.where.level === 'campaign') return [{ ad_account_id: 'act_10001', entity_id: '20001', status: 'ACTIVE', updated_at: now }];
      if (options.where.level === 'adset') {
        const predicate = options.where[require('sequelize').Op.or];
        assert.deepEqual(predicate, [{ ad_account_id: { [require('sequelize').Op.in]: ['10001', 'act_10001'] }, parent_id: '20001' }]);
        return [{ ad_account_id: 'act_10001', entity_id: '40001', parent_id: '20001' }];
      }
      assert.deepEqual(options.where[require('sequelize').Op.or], [{ ad_account_id: 'act_10001', parent_id: '40001' }]);
      return [{ ad_account_id: 'act_10001', entity_id: '30001', parent_id: '40001', status: 'ACTIVE', updated_at: now }];
    } },
    SocialAdsInsightsDaily: { findAll: async options => {
      if (options.where.level === 'campaign') return [];
      assert.deepEqual(options.where[require('sequelize').Op.or], [{ entity_id: '30001', ad_account_id: 'act_10001' }]);
      assert.deepEqual(options.where.date[require('sequelize').Op.between], ['2026-11-09', '2026-11-22']);
      return [{ ad_account_id: 'act_10001', entity_id: '30001', date: '2026-11-22', publisher_platform: 'facebook', platform_position: 'feed', spend: '7.50', updated_at: '2026-11-22T12:00:00Z' }];
    } },
  };
  const result = await closedWorkspace().loadCampaignWorkspace({ models, scope: { clinicIds: [66, 72], groupId: 29 }, days: 7, now });
  assert.equal(result.report.rows.length, 1); assert.equal(result.report.rows[0].campaign.clinicId, 66);
  assert.equal(result.report.rows[0].current.spend, 7.5); assert.equal(result.report.rows[0].ads[0].current.spend, 7.5);
  assert.deepEqual(readCalls, ['campaign', 'adset', 'ad']); assert.equal(result.report.rows[0].coverage.updatedAt, '2026-11-22T12:00:00Z');
});
