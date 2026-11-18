'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { adSharingCatalogDefinitions, FAMILIES } = require('../../lib/ad-sharing-templates');
const { originalMediaFields, instagramPostMedia, facebookOriginalMedia } = require('../../lib/social-post-original-media');
const { sharingInput, creativeFromPost, creativeFromCache, creativeFromSnapshot, loadAdSharing } = require('../../services/adSharing.service');
const { socialAdCreativeSnapshot } = require('../../lib/social-ad-creative-snapshot');
const { resolveAdSharingMessage } = require('../../services/adSharingMessage.service');
const { readCachedCreative, loadWorkspaceAdCreative } = require('../../services/campaignAdCreative.service');
const { createAdSharingHandler } = require('../../controllers/adSharing.controller');

const now = new Date('2026-11-18T12:00:00Z');
const image = 'https://scontent.fbcdn.net/original.jpg';
const video = 'https://video.cdninstagram.com/original.mp4';
const ref = { provider: 'meta_ads', account_id: '123', campaign_id: '456', group_id: '800', ad_id: '700' };
const bodyBuilder = params => [{ type: 'body', parameters: Object.keys(params).map(key => ({ type: 'text', text: params[key] })) }];

function fixture() {
  const calls = [];
  const campaign = { provider: 'meta_ads', account_id: '123', campaign_id: '456', assigned: true, clinicId: 66, status: 'ACTIVE', name: 'Current campaign' };
  const group = { ad_account_id: 'act_123', entity_id: '800', parent_id: '456', effective_status: 'ACTIVE' };
  const ad = { ad_account_id: '123', entity_id: '700', parent_id: '800', effective_status: 'ACTIVE', name: 'Current ad' };
  const inventory = { campaigns: [campaign], groups: [], selectedClinics: [{ id_clinica: 66 }], authorizedGroups: [], meta: [] };
  const promotions = [{ ad_account_id: '123', campaign_id: '456', adset_id: '800', ad_id: '700',
    post: { id: 1, clinica_id: 66, post_type: 'photo', media_url: image, content: 'Real advertising text' } }];
  const models = {
    CampaignWorkspaceSetting: { findAll: async () => [] },
    SocialAdsEntity: { findAll: async options => { calls.push(options); return options.where.level === 'adset' ? [group] : [{ ...group, level: 'adset' }, { ...ad, level: 'ad' }]; },
      findAndCountAll: async options => { calls.push(options); return { count: 1, rows: [ad] }; } },
    PostPromotions: { findAll: async options => { calls.push(options); return promotions; } }, SocialPosts: {},
  };
  const args = { models, scope: { clinicIds: [66] }, input: { purpose: 'patient_promotion' }, now,
    loadInventory: async () => inventory, authorizeCreative: async () => ({ fingerprint: 'same', entity: ad, group }),
    loadCreative: async options => { assert.equal(options.cacheOnly, true); return { preview: null }; } };
  return { args, models, inventory, campaign, group, ad, promotions, calls };
}

test('catalog has four real draft payloads, two audiences and explicit IMAGE/VIDEO headers without fake approvals or sample handles', () => {
  const rows = adSharingCatalogDefinitions();
  assert.equal(rows.length, 4); assert.equal(new Set(rows.map(row => row.family_key)).size, 4);
  for (const row of rows) {
    assert.equal(row.category, 'MARKETING'); assert.equal(row.is_active, false);
    assert.deepEqual(row.variables.map(v => v.name), ['nombre_paciente', 'nombre_clinica', 'texto_anuncio']);
    assert.ok(['IMAGE', 'VIDEO'].includes(row.components[0].format)); assert.equal(row.components[0].example, undefined);
    assert.equal(row.status, undefined);
  }
});

test('single clinical scope and exact lead/promotion request reject groups, injected reference/URL and malformed pagination', () => {
  assert.equal(sharingInput({ purpose: 'patient_promotion' }, { clinicIds: [66] }).clinicId, 66);
  for (const input of [{ purpose: 'patient_promotion', lead_id: '9' }, { purpose: 'lead_ad' },
    { purpose: 'patient_promotion', ad_id: '700' }, { purpose: 'patient_promotion', page: '0x1' },
    { purpose: 'patient_promotion', page: [1] },
    { purpose: 'patient_promotion', mediaUrl: image }, { purpose: 'carousel' }]) assert.throws(() => sharingInput(input, { clinicIds: [66] }));
  assert.throws(() => sharingInput({ purpose: 'patient_promotion' }, { clinicIds: [66, 72] }));
  assert.throws(() => sharingInput({ purpose: 'patient_promotion' }, { clinicIds: [0] }));
});

test('original image and vertical video remain exact, thumbnails/permalinks/carousels never become a video', () => {
  assert.equal(creativeFromPost({ post_type: 'photo', media_url: image }, now).imageUrl, image);
  const original = creativeFromPost({ post_type: 'video', original_media_url: video, media_url: image }, now);
  assert.equal(original.available, true); assert.equal(original.videoUrl, video); assert.equal(original.thumbnailUrl, image);
  assert.equal(original.preserveOriginal, true); assert.deepEqual(original.mediaParameter, { type: 'video', video: { link: video } });
  for (const url of [image, 'https://www.instagram.com/reel/1/', 'https://127.0.0.1/video.mp4']) {
    assert.equal(creativeFromPost({ post_type: 'video', media_url: url }, now).available, false);
  }
  assert.equal(creativeFromPost({ post_type: 'carousel_album', media_url: image }, now).reason, 'carousel_not_supported');
  assert.equal(creativeFromPost({ post_type: 'photo', media_url: image + '?expires=1' }, now).available, false);
});

test('cached video thumbnails, dynamic alternatives and missing media expose unavailability, never substitute an ad', () => {
  assert.equal(creativeFromCache({ video: true, images: [image] }, now).available, false);
  assert.equal(creativeFromCache({ images: [image, image + '?v=2'] }, now).reason, 'creative_variants_require_selection');
  assert.equal(creativeFromCache(null, now).available, false);
  assert.equal(creativeFromCache({ images: [image], bodies: ['Real text'] }, now).available, true);
});

function synchronizedCreative(format = 'IMAGE') {
  return socialAdCreativeSnapshot({ accountId: '123', now: new Date('2026-11-01T00:00:00Z'),
    ad: { id: '700', campaign_id: '456', adset_id: '800', creative: { sharing: { version: 1, body: 'Persistent canonical copy',
      title: 'Canonical title', kind: format, image_url: format === 'IMAGE' ? image : null, thumbnail_url: image,
      video_id: format === 'VIDEO' ? '900' : null, original_media_url: format === 'VIDEO' ? video : null,
      source_issue: null, has_variants: false } } } });
}

test('normal AdsSync SQL snapshots remain usable after RedisTTL and preserve original IMAGE/VIDEO without a provider lookup', async () => {
  for (const format of ['IMAGE', 'VIDEO']) {
    const f = fixture(); f.ad.creative_payload = synchronizedCreative(format); f.promotions.length = 0;
    f.args.loadCreative = () => assert.fail('stable synchronized media must not depend on Redis/provider');
    const selected = (await loadAdSharing(f.args)).items[0];
    assert.equal(selected.creative.source, 'ad_sync'); assert.equal(selected.creative.kind, format);
    assert.equal(selected.creative.shareText, 'Persistent canonical copy'); assert.equal(selected.selection.allowed, true);
    assert.equal(format === 'VIDEO' ? selected.creative.videoUrl : selected.creative.imageUrl, format === 'VIDEO' ? video : image);
  }
});

test('SQL identity mismatch, expired original, source failures and variants never fall back to an organic/cache substitute', async () => {
  for (const change of [p => { p.reference.account_id = '999'; }, p => { p.creative.image_url += '?expires=1'; },
    p => { p.creative.source_issue = 'video_source_unavailable'; }, p => { p.creative.has_variants = true; }]) {
    const f = fixture(); f.ad.creative_payload = synchronizedCreative(); change(f.ad.creative_payload);
    f.args.loadCreative = () => assert.fail('known unavailable snapshot cannot be substituted');
    assert.equal((await loadAdSharing(f.args)).items[0].selection.allowed, false);
  }
  assert.equal(creativeFromSnapshot({ version: 99 }, ref, now).reason, 'creative_snapshot_invalid');
});

test('a synchronized creative changing during selector read invalidates the frozen source', async () => {
  const f = fixture(); f.ad.creative_payload = synchronizedCreative(); let calls = 0;
  f.models.SocialAdsEntity.findAll = async options => options.where.level === 'adset' ? [f.group]
    : [{ ...f.group, level: 'adset' }, { ...f.ad, level: 'ad', creative_payload: {
      ...f.ad.creative_payload, creative: { ...f.ad.creative_payload.creative, body: 'Changed conditions' } } }];
  await assert.rejects(loadAdSharing(f.args), { code: 'ad_sharing_inventory_changed' });
});

test('normal sync keeps thumbnail consumers unchanged and separately preserves originals without inventing them', () => {
  assert.deepEqual(instagramPostMedia({ media_type: 'VIDEO', thumbnail_url: image, media_url: video }), { media_url: image, original_media_url: video });
  assert.deepEqual(instagramPostMedia({ media_type: 'VIDEO', thumbnail_url: image }), { media_url: image });
  assert.deepEqual(facebookOriginalMedia({ type: 'video', full_picture: image }, {}), {});
  assert.deepEqual(facebookOriginalMedia({ type: 'video' }, { media_type: 'video', media: { source: video } }), { original_media_url: video });
  assert.deepEqual(originalMediaFields('https://example.test/file.mp4'), {});
});

test('active promotion list preserves account/campaign/adset filters, exact post scope and one item per selection', async () => {
  const f = fixture(); const result = await loadAdSharing(f.args);
  assert.equal(result.items.length, 1); assert.equal(result.items[0].creative.imageUrl, image);
  assert.equal(result.items[0].creative.shareText, 'Real advertising text');
  assert.equal(result.items[0].selection.maxItems, 1); assert.equal(result.requiresApprovedTemplate, true);
  const groupQuery = f.calls.find(q => q.where?.level === 'adset');
  assert.equal(groupQuery.where[Op.or][0].parent_id, '456');
  assert.ok(groupQuery.where[Op.and][0][Op.or].some(branch => branch.effective_status === 'ACTIVE'));
  const postQuery = f.calls.find(q => q.include);
  assert.equal(postQuery.include[0].where.clinica_id, 66);
  assert.deepEqual(result.items[0].reference, ref);
});

test('unassigned/wrong-clinic/inactive campaigns never reach posts, credentials or cache', async () => {
  for (const change of [f => { f.campaign.assigned = false; }, f => { f.campaign.clinicId = 72; }, f => { f.campaign.status = 'PAUSED'; }]) {
    const f = fixture(); change(f);
    f.args.authorizeCreative = () => assert.fail('unauthorized creative');
    assert.equal((await loadAdSharing(f.args)).items.length, 0);
  }
});

test('another clinic post cannot supply material; missing data uses cache-only and never a provider loader', async () => {
  const f = fixture(); f.promotions[0].post.clinica_id = 72;
  f.args.loadCreative = async args => { assert.equal(args.cacheOnly, true); return { preview: null }; };
  const result = await loadAdSharing(f.args); assert.equal(result.items[0].creative.available, false);
});

test('different advertising copy on the same original media remains an unresolved creative variant', async () => {
  const f = fixture();
  f.promotions.push({ ...f.promotions[0], post: { ...f.promotions[0].post, id: 2, content: 'Different conditions' } });
  f.args.loadCreative = () => assert.fail('a known variant cannot be replaced by cache');
  const result = await loadAdSharing(f.args);
  assert.equal(result.items[0].selection.allowed, false);
  assert.equal(result.items[0].creative.reason, 'creative_variants_require_selection');
});

test('revoked initial authorization reads neither post material nor the creative cache', async () => {
  const f = fixture();
  f.args.authorizeCreative = async () => { throw Object.assign(Error('revoked'), { code: 'revoked' }); };
  f.models.PostPromotions.findAll = () => assert.fail('post material is unauthorized');
  f.args.loadCreative = () => assert.fail('cache material is unauthorized');
  await assert.rejects(loadAdSharing(f.args), { code: 'revoked' });
});

test('campaign reassignment, grants/fingerprint changes and paused ads during read invalidate selection', async () => {
  const f = fixture(); let reads = 0;
  f.args.authorizeCreative = async () => ({ fingerprint: ++reads === 1 ? 'before' : 'after' });
  await assert.rejects(loadAdSharing(f.args), { code: 'ad_sharing_inventory_changed' });
  const moved = fixture(); let loads = 0;
  moved.args.loadInventory = async () => { if (++loads > 1) moved.campaign.clinicId = 72; return moved.inventory; };
  await assert.rejects(loadAdSharing(moved.args), { code: 'ad_sharing_inventory_changed' });
});

test('lead selection comes from audited attribution, not caller ad IDs, and can show its exact paused ad', async () => {
  const f = fixture(); f.args.input = { purpose: 'lead_ad', lead_id: '9' };
  f.campaign.status = 'PAUSED'; f.ad.effective_status = 'PAUSED'; f.group.effective_status = 'PAUSED';
  f.models.LeadIntake = { findOne: async options => { assert.equal(options.where.clinica_id, 66); return { id: 9, clinica_id: 66, source: 'meta_ads' }; } };
  f.args.attachIdentities = async ({ leads }) => { leads[0].advertising_identity = { version: 1, verified_by: 'meta_graph', provider: 'meta_ads',
    clinic_id: 66, account_id: '123', campaign_id: '456', ad_id: '700', page_id: '99', form_id: '88' }; };
  const result = await loadAdSharing(f.args); assert.equal(result.selected.reference.ad_id, '700');
  assert.equal(f.calls.find(q => q.where?.level === 'ad').where[Op.and][0].entity_id, '700');
});

test('read-only cache ignores expired/corrupt entries and never populates or refreshes', async () => {
  let writes = 0;
  const store = { get: async () => null, set: () => { writes++; } };
  assert.equal(await readCachedCreative('key', { store, now }), null);
  store.get = async () => JSON.stringify({ version: 1, expires: +now - 1, value: { preview: {} } });
  assert.equal(await readCachedCreative('key', { store, now }), null);
  store.get = async () => JSON.stringify({ version: 1, expires: +now + 1000, value: { preview: { images: [image] } } });
  assert.deepEqual(await readCachedCreative('key', { store, now }), { preview: { images: [image] } });
  assert.equal(writes, 0);
});

test('a twenty-ad page makes two inventory censuses and two fresh grant reads, not one census per ad', async () => {
  const f = fixture(); const counters = { inventory: 0, mappings: 0, grants: 0, connections: 0 };
  const ads = Array.from({ length: 20 }, (_, i) => ({ ...f.ad, entity_id: String(700 + i) }));
  f.models.SocialAdsEntity.findAndCountAll = async () => ({ count: 20, rows: ads });
  f.models.SocialAdsEntity.findAll = async options => options.where.level === 'adset' ? [f.group]
    : [{ ...f.group, level: 'adset' }, ...ads.map(ad => ({ ...ad, level: 'ad' }))];
  f.models.PostPromotions.findAll = async () => ads.map(ad => ({ ...f.promotions[0], ad_id: ad.entity_id }));
  f.models.ClinicMetaAsset = { findAll: async () => { counters.mappings++; return [{ id: 1, assignmentScope: 'clinic', clinicaId: 66, metaConnectionId: 10 }]; } };
  f.models.MetaMarketingBrokerBinding = { findAll: async () => [] };
  f.models.MetaMarketingBrokerRevocation = { findAll: async () => [] };
  f.models.MetaMarketingEnrollmentClaim = { findAll: async () => [] };
  f.models.MetaConnectionAssignment = { findAll: async () => { counters.grants++; return [{ id: 1, status: 'active', scopeKey: 'clinic:66', metaConnectionId: 10 }]; } };
  f.models.MetaConnection = { findAll: async () => [{ id: 10, credentials_external: 0, broker_app_id: null }],
    findByPk: async () => { counters.connections++; return { id: 10, accessToken: 'synthetic', expiresAt: '2030-01-01' }; } };
  delete f.args.authorizeCreative;
  f.args.loadInventory = async () => { counters.inventory++; return f.inventory; };
  const result = await loadAdSharing(f.args);
  assert.equal(result.items.length, 20);
  assert.deepEqual(counters, { inventory: 2, mappings: 4, grants: 2, connections: 2 });
});

test('cache-only creative misses never call Graph or the populating cache loader', async () => {
  const f = fixture();
  f.models.SocialAdsEntity.findOne = async options => options.where.level === 'ad' ? f.ad : f.group;
  f.models.ClinicMetaAsset = { findAll: async () => [{ id: 1, assignmentScope: 'clinic', clinicaId: 66, metaConnectionId: 10 }] };
  f.models.MetaConnectionAssignment = { findAll: async () => [{ id: 1, status: 'active', scopeKey: 'clinic:66', metaConnectionId: 10 }] };
  f.models.MetaConnection = { findByPk: async () => ({ id: 10, accessToken: 'synthetic', expiresAt: '2030-01-01' }) };
  const result = await loadWorkspaceAdCreative({ ...f.args, input: ref, cacheOnly: true,
    readCache: async () => null, read: () => assert.fail('Graph forbidden'), cache: () => assert.fail('cache population forbidden') });
  assert.equal(result.error, 'workspace_creative_not_cached'); assert.equal(result.preview, null);
});

function messageFixture(format = 'IMAGE', purpose = 'patient_promotion') {
  const family = FAMILIES[purpose][format];
  const args = { models: { WhatsappTemplateCatalog: { findByPk: async () => ({ family_key: family, category: 'MARKETING', is_active: true }) } },
    conversation: { channel: 'whatsapp', clinic_id: 66, patient_id: 5, lead_id: 9 }, userId: 1,
    template: { name: family, catalog_template_id: 1, is_active: true, status: 'APPROVED', category: 'MARKETING',
      components: [{ type: 'HEADER', format }, { type: 'BODY', text: 'Hola {{1}}, {{2}}: {{3}}.' }] },
    input: { purpose, ad_id: '700' }, templateParams: { '1': 'Alex', '2': 'Clinic', '3': 'Untrusted client text' },
    hasAccess: async () => true, buildBody: bodyBuilder,
    load: async () => ({ items: [{ reference: ref, selection: { allowed: true }, templateFamily: family,
      creative: { available: true, kind: format, source: 'social_posts', fingerprint: 'a'.repeat(64), shareText: 'Canonical source text',
        mediaParameter: format === 'IMAGE' ? { type: 'image', image: { link: image } } : { type: 'video', video: { link: video } } } }] }) };
  return args;
}

test('native message resolves canonical image/video, replaces client advertising copy and renders the same saved body', async () => {
  for (const format of ['IMAGE', 'VIDEO']) {
    const f = messageFixture(format); const result = await resolveAdSharingMessage(f);
    assert.equal(result.templateParams['3'], 'Canonical source text');
    assert.equal(result.templateComponents[0].parameters[0].type, format.toLowerCase());
    assert.equal(result.message, 'Hola Alex, Clinic: Canonical source text.');
    assert.equal(result.templateComponents[1].parameters[2].text, 'Canonical source text');
  }
});

test('native message rejects family/purpose, header, missing asset, stale preview, recipient and injected URL mismatches', async () => {
  for (const change of [f => { f.input.purpose = 'lead_ad'; }, f => { f.template.components[0].format = 'VIDEO'; },
    f => { f.input.creative_sha256 = 'b'.repeat(64); }, f => { f.input.mediaUrl = image; },
    f => { f.conversation.patient_id = null; }, f => { f.template.status = 'PENDING'; },
    f => { f.load = async () => ({ items: [] }); }, f => { f.hasAccess = async () => false; }]) {
    const f = messageFixture(); change(f); await assert.rejects(resolveAdSharingMessage(f));
  }
  const lead = messageFixture('IMAGE', 'lead_ad'); lead.input.lead_id = 10;
  await assert.rejects(resolveAdSharingMessage(lead), { code: 'ad_sharing_lead_mismatch' });
});

test('ordinary templates remain unchanged; advertising families require source selection even if caller omits payload', async () => {
  assert.equal(await resolveAdSharingMessage({ template: { name: 'ordinary' } }), null);
  const f = messageFixture(); f.input = undefined;
  await assert.rejects(resolveAdSharingMessage(f), { code: 'ad_sharing_selection_required' });
  f.template.name = 'customized_runtime_name';
  await assert.rejects(resolveAdSharingMessage(f), { code: 'ad_sharing_selection_required' });
  f.models.WhatsappTemplateCatalog.findByPk = async () => ({ family_key: 'ordinary_catalog_family' });
  assert.equal(await resolveAdSharingMessage(f), null);
});

test('HTTP rechecks scope after the read and rejects aggregate or injected provider references', async () => {
  let checks = 0;
  const handler = createAdSharingHandler({ models: {}, resolveScope: async () => ({ isValid: true, clinicIds: [66] }),
    hasAccess: async () => ++checks === 1, load: async () => ({ success: true }) });
  const res = { status(code) { this.code = code; return this; }, json(value) { this.body = value; return this; }, set() {} };
  await handler({ userData: { userId: 1 }, query: { scope: '66', purpose: 'patient_promotion' } }, res);
  assert.equal(res.code, 403);
  await handler({ userData: { userId: 1 }, query: { scope: 'group:29', purpose: 'patient_promotion' } }, res);
  assert.equal(res.code, 400);
});

test('migration adds only one nullable source column and never deletes recovered originals', async () => {
  const migration = require('../../../migrations/20261118113000-add-social-post-original-media-url'); let added = 0;
  const q = { describeTable: async () => (added ? { original_media_url: {} } : {}),
    addColumn: async (table, name, spec) => { assert.equal(table, 'SocialPosts'); assert.equal(name, 'original_media_url'); assert.equal(spec.allowNull, true); added++; } };
  await migration.up(q, { TEXT: 'TEXT' }); await migration.up(q, { TEXT: 'TEXT' }); assert.equal(added, 1);
  await assert.rejects(migration.down(), /preserved_rollback_code_only/);
});
