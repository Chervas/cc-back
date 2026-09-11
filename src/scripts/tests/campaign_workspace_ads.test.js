'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadWorkspaceAds } = require('../../services/campaignWorkspace.service');

test('Meta ads without insights keep inventory and synchronization freshness, not last provider edit', async () => {
  const syncedAt = new Date('2026-09-10T02:00:00Z');
  const models = {
    SocialAdsEntity: { findAll: async options => {
      if (options.where.level === 'adset') return [{ entity_id: '2', parent_id: '1', ad_account_id: 'act_123' }];
      assert.ok(options.attributes.includes('updated_at'));
      return [{ entity_id: '3', parent_id: '2', name: 'New ad', ad_account_id: 'act_123', effective_status: 'DISAPPROVED',
        updated_time: new Date('2026-08-01'), updated_at: syncedAt }];
    } },
    SocialAdsInsightsDaily: { findAll: async () => [] },
  };
  const ads = await loadWorkspaceAds({ models, googleWhere: [], metaCampaigns: [{ account_id: '123', campaign_id: '1' }], dateWhere: {} });
  assert.equal(ads.length, 1); assert.equal(ads[0].inventory, true);
  assert.equal(ads[0].campaign_id, '1'); assert.equal(ads[0].updatedAt, syncedAt);
  assert.equal(ads[0].status, 'DISAPPROVED'); assert.equal(ads[0].spend, undefined);
});

test('Google ad loading retains group identity and queries only authorized campaign/date pairs', async () => {
  const googleWhere = [{ customerId: '123', campaignId: '456' }]; const dateWhere = {};
  const ads = await loadWorkspaceAds({ googleWhere, dateWhere, metaCampaigns: [], models: {
    GoogleAdsAdInventory: { findAll: async () => [] },
    GoogleAdsAdSyncDay: { findAll: async () => [] },
    GoogleAdsAdInsightsDaily: { findAll: async options => {
      assert.equal(options.where.date, dateWhere);
      assert.equal(options.where[require('sequelize').Op.or], googleWhere);
      assert.ok(options.attributes.includes('adGroupId')); assert.ok(options.attributes.includes('adGroupName'));
      assert.ok(!options.attributes.includes('headlines'));
      return [{ customerId: '123', campaignId: '456', adId: '700', adGroupId: '800', adGroupName: 'Primera visita', costMicros: 5000000 }];
    } },
  } });
  assert.equal(ads[0].groupId, '800'); assert.equal(ads[0].groupName, 'Primera visita'); assert.equal(ads[0].spend, 5);
});

test('Meta inventory refresh does not change metric freshness', async () => {
  const models = {
    SocialAdsEntity: { findAll: async options => options.where.level === 'adset'
      ? [{ entity_id: '2', parent_id: '1', ad_account_id: 'act_123' }]
      : [{ entity_id: '3', parent_id: '2', ad_account_id: 'act_123', effective_status: 'ACTIVE', updated_at: '2026-09-10' }] },
    SocialAdsInsightsDaily: { findAll: async () => [{ entity_id: '3', ad_account_id: 'act_123', date: '2026-09-09', spend: '5', updated_at: '2026-09-01' }] },
  };
  const ads = await loadWorkspaceAds({ models, googleWhere: [], metaCampaigns: [{ account_id: '123', campaign_id: '1' }], dateWhere: {} });
  assert.equal(ads[1].groupId, '2'); assert.equal(ads[1].updatedAt, '2026-09-10'); assert.equal(ads[1].metricsUpdatedAt, '2026-09-01');
});
