'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { DataTypes } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createMetaMarketingAdsReader } = require('../../services/metaMarketingAdsReader.service');
const A = require('../../../services/integrations-broker/src/meta-marketing-ads-contract');
const { socialAdCreativeSnapshot, validSharing } = require('../../lib/social-ad-creative-snapshot');

// Synthetic provider response. The test never calls Graph or loads host models.
function providerRow() {
  return { id: '700', account_id: '123', name: 'Synthetic variant ad', campaign_id: '456', adset_id: '800',
    status: 'ACTIVE', effective_status: 'ACTIVE', creative: { id: '900', asset_feed_spec: {
      bodies: [{ text: 'Exact synthetic copy shared by the two observed images.' }],
      titles: [{ text: 'Synthetic title' }],
      images: [{ url: 'https://scontent.fbcdn.net/synthetic-first.jpg' },
        { url: 'https://scontent.fbcdn.net/synthetic-second.jpg' }],
    } } };
}

test('owned MySQL: typed v2 read stores factored alternatives in the existing ad row and preserves v1', async () => {
  await withIsolatedCampaignMysql(async ({ sql, report }) => {
    const Ads = require('../../../models/socialadsentity')(sql, DataTypes);
    await Ads.sync();
    const initial = await Ads.create({ ad_account_id: '123', level: 'ad', entity_id: '700', parent_id: '800',
      name: 'Synthetic variant ad', status: 'ACTIVE', effective_status: 'ACTIVE',
      delivery_reason_text: 'Existing delivery evidence', peak_frequency: '2.250' });
    const original = (await Ads.findByPk(initial.id)).get({ plain: true });

    let calls = 0, assertions = 0;
    const state = { kind: 'ad_account', connectionRef: 'meta:synthetic',
      assetRef: 'meta-ad_account:123', tenantRef: 'clinic:66' };
    const reader = createMetaMarketingAdsReader({ enabled: () => true,
      scope: { prepare: async () => ({}), assertContext: async () => { assertions++; return state; } },
      client: { execute: async command => {
        calls++;
        assert.equal(command.operation, A.OPERATIONS.ads);
        assert.deepEqual(command.payload, { creativeVersion: 2, pageToken: null });
        return { requestId: command.requestId, data: {
          results: A.projectPage('ads', { data: [providerRow()] }, command.payload), nextPageToken: null,
          usage: { usagePct: 0, nextAllowedAt: 0, pauseUntil: 0 },
        } };
      } },
    });
    const source = await reader.sourceForAsset(1);
    let payload;
    for await (const page of source.pages('ads', { creativeVersion: 2 })) {
      await source.assert();
      assert.equal(page.length, 1);
      payload = socialAdCreativeSnapshot({ accountId: '123', ad: page[0], creativeVersion: 2 });
      await Ads.upsert({ ad_account_id: '123', level: 'ad', entity_id: page[0].id, parent_id: page[0].adset_id,
        name: page[0].name, status: page[0].status, effective_status: page[0].effective_status,
        creative_payload: payload });
    }
    assert.equal(calls, 1);
    assert.ok(assertions >= 5, 'source authorization is checked before read and persistence');
    assert.equal(payload.version, 2);
    assert.equal(payload.creative.version, 2);
    assert.equal(validSharing(payload.creative), true);
    assert.equal(payload.creative.alternatives.length, 2);
    assert.equal(payload.creative.copies.length, 1, 'shared copy is stored once, without generating combinations');
    assert.ok(payload.creative.alternatives.every(option => option.copy_id === payload.creative.copies[0].copy_id));
    assert.equal(new Set(payload.creative.alternatives.map(option => option.variant_id)).size, 2);
    const stored = (await Ads.findByPk(initial.id)).get({ plain: true });
    assert.equal(await Ads.count(), 1);
    assert.deepEqual(stored.creative_payload, payload);
    for (const key of Object.keys(original).filter(key => !['creative_payload', 'updated_at'].includes(key))) {
      assert.deepEqual(stored[key], original[key], `preserved ${key}`);
    }

    // A legacy row remains valid; it cannot masquerade as the requested v2 projection.
    const v1 = A.projectPage('ads', { data: [providerRow()] }, { creativeVersion: 1, pageToken: null })[0];
    assert.equal(socialAdCreativeSnapshot({ accountId: '123', ad: v1 }).version, 1);
    assert.throws(() => socialAdCreativeSnapshot({ accountId: '123', ad: v1, creativeVersion: 2 }));
    const missing = socialAdCreativeSnapshot({ accountId: '123', ad: { id: '701', campaign_id: '456', adset_id: '800' }, creativeVersion: 2 });
    assert.equal(missing.version, 2);
    assert.deepEqual(missing.creative.alternatives, []);
    assert.deepEqual(missing.creative.copies, []);
    assert.ok(missing.creative.source_issue);
    report.checks.push('Typed Ads read requests and validates exact v2',
      'Existing JSON column round-trips factored alternatives without changing other ad data or creating duplicates',
      'Legacy v1 remains readable and cannot satisfy a v2 receipt',
      'Missing creative is explicit v2 unavailability, not a synthetic selectable option');
  });
});
