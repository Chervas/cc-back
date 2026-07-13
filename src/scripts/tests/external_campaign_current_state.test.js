'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../../models');
const {
  __test: {
    buildCurrentExternalCampaignInventoryIndex,
    mergeCurrentGoogleCampaignInventory,
    overlayExternalTargetsWithInventory,
  },
} = require('../../controllers/campaignOnboarding.controller');

function testStrategySnapshotGetsCurrentInventoryStateWithoutMutation() {
  const snapshotTargets = [{
    kind: 'treatment',
    treatment_id: 7,
    treatment_name: 'Implantes',
    campaigns: [
      {
        provider: 'google_ads',
        account_id: '185-121-5478',
        external_campaign_id: '21323256887',
        name: 'Nombre histórico',
        status: 'PAUSED',
        metrics: { spend: 9, conversions: 1 },
      },
      {
        provider: 'google_ads',
        account_id: '5992356722',
        external_campaign_id: '21175523256',
        name: 'Sin inventario',
        status: 'PAUSED',
      },
    ],
  }];
  const original = JSON.stringify(snapshotTargets);
  const inventoryIndex = buildCurrentExternalCampaignInventoryIndex([
    {
      provider: 'google_ads',
      customer_id: '1851215478',
      campaign_id: '21323256887',
      campaign_name: 'PROPDENTAL Pmax local SANT MARTI',
      status: 'ENABLED',
      last_seen_at: '2026-07-13T00:00:00.000Z',
    },
  ]);

  const hydrated = overlayExternalTargetsWithInventory(snapshotTargets, inventoryIndex);
  assert.equal(hydrated[0].campaigns[0].status, 'ENABLED');
  assert.equal(hydrated[0].campaigns[0].name, 'PROPDENTAL Pmax local SANT MARTI');
  assert.equal(hydrated[0].campaigns[0].metrics.spend, 9, 'Current state must not discard live metrics');
  assert.equal(hydrated[0].campaigns[1].status, 'PAUSED', 'Missing inventory must retain the snapshot fallback');
  assert.equal(JSON.stringify(snapshotTargets), original, 'Read hydration must never rewrite the stored snapshot');
}

function testInventoryOverridesMaxStatusAndFallbackRows() {
  const aggregatedByHistoricalMax = [
    {
      provider: 'google_ads',
      account_id: '1851215478',
      external_campaign_id: '21323256887',
      name: 'Pmax nombre histórico',
      status: 'PAUSED',
      metrics: { impressions: 50, clicks: 4, spend: 20, conversions: 2 },
      last_seen_at: '2026-07-10',
      assignment_origin: 'group',
    },
    {
      provider: 'google_ads',
      account_id: '1851215478',
      external_campaign_id: '21316904358',
      name: 'Search histórica',
      status: 'ENABLED',
      metrics: { impressions: 40, clicks: 3, spend: 10, conversions: 1 },
      assignment_origin: 'group',
    },
    {
      provider: 'google_ads',
      account_id: '5992356722',
      external_campaign_id: '21175523256',
      name: 'Solo insights',
      status: 'PAUSED',
      metrics: { impressions: 0, clicks: 0, spend: 0, conversions: 0 },
      assignment_origin: 'group',
    },
  ];
  const inventoryRows = [
    {
      provider: 'google_ads', customer_id: '1851215478', campaign_id: '21323256887',
      campaign_name: 'PROPDENTAL Pmax local SANT MARTI', status: 'ENABLED',
      last_seen_at: '2026-07-13T00:01:00.000Z',
    },
    {
      provider: 'google_ads', customer_id: '1851215478', campaign_id: '21316904358',
      campaign_name: 'PROPDENTAL Búsqueda dental SANT MARTI', status: 'PAUSED',
      last_seen_at: '2026-07-13T00:01:00.000Z',
    },
    {
      provider: 'google_ads', customer_id: '1851215478', campaign_id: '999999',
      campaign_name: 'Solo inventario', status: 'ENABLED',
      last_seen_at: '2026-07-13T00:01:00.000Z',
    },
  ];
  const inputBefore = JSON.stringify(aggregatedByHistoricalMax);
  const common = {
    campaigns: aggregatedByHistoricalMax,
    inventoryRows,
    scope: { assignment_scope: 'group', group_id: 5 },
    reviewedByCampaign: new Map(),
    googleAccountMap: new Map(),
  };

  const all = mergeCurrentGoogleCampaignInventory({ ...common, activeOnly: false });
  const pmax = all.find((item) => item.external_campaign_id === '21323256887');
  assert.equal(pmax.status, 'ENABLED', 'Inventory must override a stale MAX(campaignStatus) result');
  assert.equal(pmax.name, 'PROPDENTAL Pmax local SANT MARTI');
  assert.equal(pmax.metrics.spend, 20, 'Inventory overlay must retain aggregated metrics');
  assert.equal(all.filter((item) => item.external_campaign_id === '21323256887').length, 1, 'Fallback merge must not duplicate a campaign');
  assert.ok(all.some((item) => item.external_campaign_id === '999999'), 'Inventory-only campaigns must remain available');

  const clinicScoped = mergeCurrentGoogleCampaignInventory({
    ...common,
    scope: { assignment_scope: 'clinic', clinic_id: 58 },
    activeOnly: false,
  });
  assert.equal(
    clinicScoped.find((item) => item.external_campaign_id === '21323256887').status,
    'ENABLED',
    'An already scoped insight row must still receive its current inventory state without a reviewed assignment'
  );
  assert.equal(
    clinicScoped.some((item) => item.external_campaign_id === '999999'),
    false,
    'An inventory-only row must not leak into a clinic without a reviewed assignment'
  );

  const active = mergeCurrentGoogleCampaignInventory({ ...common, activeOnly: true });
  assert.deepEqual(
    active.map((item) => item.external_campaign_id).sort(),
    ['21323256887', '999999'],
    'active_only must be applied after current inventory status overrides historical status'
  );
  assert.equal(JSON.stringify(aggregatedByHistoricalMax), inputBefore, 'Discovery merge must not mutate insight rows');
}

function testEndpointsUseCurrentInventoryOverlay() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/campaignOnboarding.controller.js'),
    'utf8'
  );
  const listStart = source.indexOf('exports.listMarketingStrategies');
  const detailStart = source.indexOf('exports.getMarketingStrategyDetail');
  const metricsStart = source.indexOf('exports.getMarketingStrategyMetrics');
  assert.match(source.slice(listStart, detailStart), /loadCurrentExternalCampaignInventoryIndex/);
  assert.match(source.slice(detailStart, metricsStart), /overlayExternalTargetsWithInventory/);
  const discoveryStart = source.indexOf('exports.listExternalCampaigns');
  const discoveryEnd = source.indexOf('exports.listGoogleAdsConversionActions', discoveryStart);
  assert.match(source.slice(discoveryStart, discoveryEnd), /mergeCurrentGoogleCampaignInventory/);
}

async function run() {
  testStrategySnapshotGetsCurrentInventoryStateWithoutMutation();
  testInventoryOverridesMaxStatusAndFallbackRows();
  testEndpointsUseCurrentInventoryOverlay();
  console.log('external_campaign_current_state.test.js OK');
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
