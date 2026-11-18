'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Sequelize = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { FAMILIES } = require('../../lib/ad-sharing-templates');
const copyId = copy => require('node:crypto').createHash('sha256').update(JSON.stringify([copy.body, copy.title])).digest('hex');

test('owned MySQL v2 JSON: exact option/copy selection, changed snapshots and two-phase source validation', async () => {
  await withIsolatedCampaignMysql(async ({ sql, report }) => {
    const { loadAdSharing } = require('../../services/adSharing.service');
    const { resolveAdSharingMessage } = require('../../services/adSharingMessage.service');
    const Ads = require('../../../models/socialadsentity')(sql, Sequelize.DataTypes);
    await Ads.sync();
    const payload = { version: 2, observedAt: new Date().toISOString(), creativeId: '99',
      reference: { provider: 'meta_ads', account_id: '123', campaign_id: '456', group_id: '800', ad_id: '700' },
      creative: { version: 2, body: '', title: '', kind: null, image_url: null, thumbnail_url: null, video_id: null,
        original_media_url: null, source_issue: 'creative_variants_require_selection', has_variants: true,
        copies: [{ copy_id: 'c'.repeat(64), body: 'Exact image copy', title: 'Image' },
          { copy_id: 'd'.repeat(64), body: 'Exact video copy', title: 'Video' }],
        alternatives: [{ variant_id: 'a'.repeat(64), copy_id: 'c'.repeat(64), kind: 'IMAGE',
          image_url: 'https://scontent.fbcdn.net/exact.jpg', image_hash: null, thumbnail_url: null, video_id: null, original_media_url: null,
          source_issue: null, provenance: { source: 'asset_feed_spec', path: 'images[0]' } },
        { variant_id: 'b'.repeat(64), copy_id: 'd'.repeat(64), kind: 'VIDEO', image_url: null, image_hash: null,
          thumbnail_url: 'https://scontent.fbcdn.net/thumb.jpg', video_id: '900',
          original_media_url: 'https://video.cdninstagram.com/exact.mp4', source_issue: null,
          provenance: { source: 'asset_feed_spec', path: 'videos[0]' } }] } };
    payload.creative.copies.forEach((copy, index) => {
      copy.copy_id = copyId(copy); payload.creative.alternatives[index].copy_id = copy.copy_id;
    });
    await Ads.bulkCreate([{ ad_account_id: '123', level: 'adset', entity_id: '800', parent_id: '456', status: 'ACTIVE' },
      { ad_account_id: '123', level: 'ad', entity_id: '700', parent_id: '800', status: 'ACTIVE', creative_payload: payload }]);
    const models = { SocialAdsEntity: Ads, SocialPosts: {}, PostPromotions: { findAll: async () => [] },
      CampaignWorkspaceSetting: { findAll: async () => [] } };
    const inventory = { campaigns: [{ provider: 'meta_ads', account_id: '123', campaign_id: '456', assigned: true,
      clinicId: 66, status: 'ACTIVE', name: 'Synthetic campaign' }], groups: [], selectedClinics: [{ id_clinica: 66 }], authorizedGroups: [], meta: [] };
    const args = { models, scope: { clinicIds: [66] }, input: { purpose: 'patient_promotion' },
      loadInventory: async () => inventory, authorizeCreative: async () => ({ fingerprint: 'same' }),
      loadCreative: () => assert.fail('No external creative lookup') };
    const preview = (await loadAdSharing(args)).items[0];
    assert.equal(preview.selection.allowed, false);
    assert.equal(preview.creative.alternatives.length, 2);
    const family = FAMILIES.patient_promotion.IMAGE;
    const command = { models: { ...models, WhatsappTemplateCatalog: { findByPk: async () => ({ family_key: family,
      category: 'MARKETING', is_active: true }) } }, conversation: { channel: 'whatsapp', clinic_id: 66, patient_id: 1 }, userId: 1,
      template: { name: family, catalog_template_id: 1, is_active: true, status: 'APPROVED', category: 'MARKETING',
        components: [{ type: 'HEADER', format: 'IMAGE' }, { type: 'BODY', text: '{{1}}, {{2}}: {{3}}' }] },
      input: { purpose: 'patient_promotion', ad_id: '700', variant_id: preview.creative.alternatives[0].variant_id,
        creative_sha256: preview.creative.alternatives[0].fingerprint },
      templateParams: { '1': 'Ficticio', '2': 'Synthetic clinic', '3': 'Client must not override' }, hasAccess: async () => true,
      buildBody: p => [{ type: 'body', parameters: Object.values(p).map(text => ({ type: 'text', text })) }],
      load: options => loadAdSharing({ ...args, selectedAdId: options.selectedAdId, selectedVariantId: options.selectedVariantId }) };
    const result = await resolveAdSharingMessage(command);
    assert.equal(result.templateParams['3'], 'Exact image copy');
    assert.equal(result.templateComponents[0].parameters[0].image.link, 'https://scontent.fbcdn.net/exact.jpg');
    assert.equal(result.metadata.variant_id, 'a'.repeat(64));
    payload.creative.copies[1].body = 'Changed another complete option';
    payload.creative.copies[1].copy_id = copyId(payload.creative.copies[1]);
    payload.creative.alternatives[1].copy_id = payload.creative.copies[1].copy_id;
    await Ads.update({ creative_payload: payload }, { where: { level: 'ad', entity_id: '700' } });
    await assert.rejects(resolveAdSharingMessage(command), { code: 'ad_sharing_creative_changed' });
    let phases = 0;
    await assert.rejects(loadAdSharing({ ...args, authorizeCreative: async () => {
      if (++phases === 1) await Ads.update({ creative_payload: null }, { where: { level: 'ad', entity_id: '700' } });
      return { fingerprint: 'same' };
    } }), { code: 'ad_sharing_inventory_changed' });
    assert.equal(await Ads.count(), 2);
    report.checks.push('Native MySQL JSON preserves factored copies, exact option provenance and IDs',
      'Explicit single option resolves server-owned image and copy', 'Any changed snapshot invalidates stale fingerprint',
      'Source replacement between authorization phases fails closed', 'No business DB, provider, WhatsApp or queue used');
  });
});
