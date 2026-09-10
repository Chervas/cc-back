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
