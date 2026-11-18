'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { createAdSharingAuthority } = require('../../services/adSharingAuthority.service');
const { createMetaMarketingBrokerScope, createMetaMarketingScopeRepository } = require('../../services/metaMarketingBrokerScope.service');
const { loadAdSharing } = require('../../services/adSharing.service');
const { socialAdCreativeSnapshot } = require('../../lib/social-ad-creative-snapshot');

const reference = { provider: 'meta_ads', account_id: '123', campaign_id: '456', group_id: '800', ad_id: '700' };
const now = new Date('2026-11-18T12:00:00Z');
const image = 'https://scontent.fbcdn.net/original.jpg';

function fixture({ legacy = false, snapshot = true } = {}) {
  const state = { legacyReads: 0, prepares: 0, assertions: 0, metadataReads: 0, revocations: [], claims: [], blocked: false, epoch: 0 };
  const mapping = { id: 1, metaConnectionId: 10, assetType: 'ad_account', metaAssetId: 'act_123', assignmentScope: 'group',
    clinicaId: null, grupoClinicaId: 29, isActive: true, credentials_absent: 1 };
  const binding = { mapping_id: 1, enrollment_id: null, asset_ref: 'meta-ad_account:123', meta_connection_id: 10, meta_user_id: '201',
    app_id: '101', connection_ref: 'meta:fixture', scope_key: 'group:29', tenant_clinic_id: 66, parent_page_id: null, state: 'active' };
  const bindings = legacy ? [] : [binding];
  const connection = { id: 10, userId: null, metaUserId: '201', credentials_external: legacy ? 0 : 1,
    broker_app_id: legacy ? null : '101', credentials_absent: legacy ? 0 : 1, accessToken: legacy ? 'FICTITIOUS_LEGACY' : null,
    expiresAt: '2030-01-01' };
  const clinics = [{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }];
  const grants = [{ id: 2, assignmentScope: 'group', grupoClinicaId: 29, clinicaId: null, scopeKey: 'group:29', status: 'active', metaConnectionId: 10 }];
  const campaign = { provider: 'meta_ads', account_id: '123', campaign_id: '456', assigned: true, clinicId: 66, status: 'ACTIVE' };
  const ad = { ad_account_id: '123', entity_id: '700', parent_id: '800', name: 'Fictitious ad', effective_status: 'ACTIVE' };
  const group = { ad_account_id: 'act_123', entity_id: '800', parent_id: '456', effective_status: 'ACTIVE' };
  if (snapshot) ad.creative_payload = socialAdCreativeSnapshot({ accountId: '123', now, ad: { id: '700', campaign_id: '456', adset_id: '800',
    creative: { sharing: { version: 1, kind: 'IMAGE', image_url: image, original_media_url: null, thumbnail_url: image,
      body: 'Canonical advertising text', title: '', video_id: null, source_issue: null, has_variants: false } } } });
  const inventory = { campaigns: [campaign], groups: [29], selectedClinics: clinics, authorizedGroups: [29], meta: [] };
  const models = {
    ClinicMetaAsset: { findAll: async () => { state.metadataReads++; return [{ ...mapping }]; }, findByPk: async id => Number(id) === mapping.id ? { ...mapping } : null },
    MetaMarketingBrokerBinding: { findAll: async ({ where }) => bindings.filter(row => where.mapping_id ? row.mapping_id === Number(where.mapping_id)
      : typeof where.asset_ref === 'string' ? row.asset_ref === where.asset_ref : true).map(row => ({ ...row })) },
    MetaMarketingBrokerRevocation: { findAll: async () => state.revocations.map(row => ({ ...row })) },
    MetaMarketingEnrollmentClaim: { findAll: async () => state.claims.map(row => ({ ...row })) },
    MetaConnection: { findAll: async options => {
      assert.ok(!options.attributes?.includes('accessToken'), 'broker and classifier must not select the token');
      return [{ ...connection, accessToken: undefined }];
    }, findByPk: async () => { state.legacyReads++; assert.ok(legacy, 'broker must not use the legacy authorizer'); return { ...connection }; } },
    Clinica: { findAll: async () => clinics.map(row => ({ ...row })), findByPk: async id => clinics.find(row => row.id_clinica === Number(id)) },
    GroupAssetClinicAssignment: { findAll: async () => [] },
    MetaScopeBlock: { findOne: async () => state.blocked ? { scope_key: 'group:29' } : null },
    MetaConnectionAssignment: { findAll: async () => grants.map(row => ({ ...row })) },
    CampaignWorkspaceSetting: { findAll: async () => [] },
    SocialAdsEntity: {
      findOne: async ({ where }) => where.level === 'ad' && where.entity_id === ad.entity_id && where.parent_id === ad.parent_id ? ad
        : where.level === 'adset' && where.entity_id === group.entity_id && where.parent_id === group.parent_id ? group : null,
      findAll: async ({ where }) => where.level === 'adset' ? [group] : [{ ...group, level: 'adset' }, { ...ad, level: 'ad' }],
      findAndCountAll: async () => ({ count: 1, rows: [ad] }),
    },
    PostPromotions: { findAll: async () => [] }, SocialPosts: {},
  };
  const buildScope = () => {
    const real = createMetaMarketingBrokerScope({ ...createMetaMarketingScopeRepository(() => models), enabled: () => true });
    return { prepare: async id => { state.prepares++; return real.prepare(id); },
      assertContext: async context => { state.assertions++; return real.assertContext(context); } };
  };
  const authorize = createAdSharingAuthority({ models, createScope: buildScope });
  const args = { models, scope: { clinicIds: [66] }, reference, inventory, campaign, now };
  return { state, mapping, binding, bindings, connection, clinics, grants, campaign, ad, group, inventory, models, authorize, args, buildScope };
}

test('the real SQL broker scope authorizes a group binding with a NULL legacy token and zero transport', async () => {
  const f = fixture();
  assert.equal(f.connection.accessToken, null);
  const before = await f.authorize(f.args);
  const after = await f.authorize({ ...f.args, models: { ...f.models } });
  assert.equal(before.authority, 'broker'); assert.equal(before.fingerprint, after.fingerprint);
  assert.equal(f.state.legacyReads, 0); assert.equal(f.state.prepares, 1); assert.equal(f.state.assertions, 2);
});

test('broker snapshots and missing originals both bypass the token-bound legacy cache', async () => {
  for (const snapshot of [true, false]) {
    const f = fixture({ snapshot });
    const result = await loadAdSharing({ models: f.models, scope: f.args.scope, input: { purpose: 'patient_promotion' }, now,
      loadInventory: async () => f.inventory, authorizeCreative: f.authorize,
      loadCreative: () => assert.fail('no legacy cache or provider on broker accounts') });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].selection.allowed, snapshot);
    assert.equal(result.items[0].creative.reason, snapshot ? null : 'creative_not_synchronized');
    assert.equal(f.state.legacyReads, 0);
  }
});

test('the production selector default accepts token NULL, rejects a later revoke and never enters the legacy fallback', async () => {
  const original = process.env.META_MARKETING_BROKER_ENABLED;
  process.env.META_MARKETING_BROKER_ENABLED = 'true';
  try {
    for (const scenario of ['snapshot', 'missing', 'revoked']) {
      const f = fixture({ snapshot: scenario !== 'missing' });
      if (scenario === 'revoked') f.models.PostPromotions.findAll = async () => { f.binding.state = 'blocked'; return []; };
      const pending = loadAdSharing({ models: f.models, scope: f.args.scope, input: { purpose: 'patient_promotion' }, now,
        loadInventory: async () => f.inventory,
        loadCreative: () => assert.fail('production broker picker must not enter legacy cache or Graph') });
      if (scenario === 'revoked') await assert.rejects(pending, { code: 'asset_revoked' });
      else assert.equal((await pending).items[0].selection.allowed, scenario === 'snapshot');
      assert.equal(f.state.legacyReads, 0);
    }
  } finally {
    if (original === undefined) delete process.env.META_MARKETING_BROKER_ENABLED;
    else process.env.META_MARKETING_BROKER_ENABLED = original;
  }
});

test('blocked/staged bindings, revocations, claims and incomplete external metadata never downgrade to legacy', async () => {
  const cases = [
    f => { f.binding.state = 'blocked'; }, f => { f.binding.state = 'staged'; },
    f => { f.state.revocations.push({ tuple_hash: 'a'.repeat(64) }); },
    f => { f.bindings.length = 0; },
    f => { f.bindings.length = 0; f.connection.credentials_external = 0; f.connection.broker_app_id = null; f.state.claims.push({ asset_ref: 'meta-ad_account:123' }); },
    f => { f.bindings.length = 0; f.connection.credentials_external = 2; f.connection.broker_app_id = null; },
    f => { f.state.blocked = true; }, f => { f.grants[0].status = 'revoked'; },
  ];
  for (const change of cases) {
    const f = fixture(); change(f);
    await assert.rejects(f.authorize(f.args));
    assert.equal(f.state.legacyReads, 0);
  }
});

test('the after phase rejects revocation, grants, mapping and clinic changes even when the rows settle', async () => {
  for (const change of [f => { f.binding.state = 'blocked'; }, f => { f.state.revocations.push({ tuple_hash: 'b'.repeat(64) }); },
    f => { f.grants[0].updated_at = 'changed'; }, f => { f.mapping.metaConnectionId = 99; },
    f => { f.clinics.push({ id_clinica: 99, grupoClinicaId: 29 }); }]) {
    const f = fixture(); await f.authorize(f.args); change(f);
    await assert.rejects(f.authorize({ ...f.args, models: { ...f.models } }));
    assert.equal(f.state.legacyReads, 0);
  }
});

test('removing all migration metadata after the first phase cannot reopen a legacy credential', async () => {
  const f = fixture(); await f.authorize(f.args);
  f.bindings.length = 0; f.connection.credentials_external = 0; f.connection.broker_app_id = null;
  f.connection.accessToken = 'FICTITIOUS_RESTORED_SECRET';
  await assert.rejects(f.authorize({ ...f.args, models: { ...f.models } }));
  assert.equal(f.state.legacyReads, 0);
});

test('broker account, campaign clinic and exact ad/adset identities remain mandatory', async () => {
  for (const change of [f => { f.binding.asset_ref = 'meta-ad_account:999'; },
    f => { f.campaign.clinicId = 99; }, f => { f.reference = { ...reference, group_id: '999' }; },
    f => { f.mapping.grupoClinicaId = 99; }, f => { f.binding.tenant_clinic_id = 99; }]) {
    const f = fixture(); change(f);
    await assert.rejects(f.authorize({ ...f.args, reference: f.reference || reference }));
  }
});

test('credential epoch/version and enrollment-generation drift invalidate the original capability', async () => {
  const f = fixture(), enrollmentId = '00000001-1111-4111-8111-111111111111';
  f.binding.enrollment_id = enrollmentId;
  const state = { epoch: 0, version: 'first', digest: 'a'.repeat(64) };
  const authorize = createAdSharingAuthority({ models: f.models, createScope: () => createMetaMarketingBrokerScope({
    ...createMetaMarketingScopeRepository(() => f.models), enabled: () => true,
    inspectEnrollment: async () => ({ enrollmentId, flowId: enrollmentId, mappingIds: [1], clinicIds: [66, 72], digest: state.digest,
      credential: { epoch: state.epoch, versionId: state.version } }),
    loadConnection: async () => f.connection,
  }) });
  await authorize(f.args); state.epoch = 1; state.version = 'second';
  await assert.rejects(authorize({ ...f.args, models: { ...f.models } }), { code: 'meta_broker_scope_changed' });
});

test('a current business authority uses the broker grant instead of requiring a legacy connection assignment', async () => {
  const f = fixture(), enrollmentId = '00000001-1111-4111-8111-111111111111';
  f.binding.enrollment_id = enrollmentId; f.grants.length = 0;
  const authority = { enrollmentId, flowId: enrollmentId, canonicalConnectionId: 10, appId: '101', subjectId: '201',
    scopeKey: 'group:29', clinicIds: [66, 72], mappingIds: [1] };
  const authorize = createAdSharingAuthority({ models: f.models, createScope: () => createMetaMarketingBrokerScope({
    ...createMetaMarketingScopeRepository(() => f.models), enabled: () => true,
    inspectEnrollment: async () => ({ enrollmentId, flowId: enrollmentId, mappingIds: [1], clinicIds: [66, 72],
      business: authority, digest: 'a'.repeat(64), credential: { epoch: 2, versionId: enrollmentId } }),
  }) });
  assert.equal((await authorize(f.args)).authority, 'broker');
  assert.equal(f.state.legacyReads, 0);
});

test('twenty ads share one prepare and two fresh phase assertions rather than twenty scope censuses', async () => {
  const f = fixture();
  const first = f.args.models, second = { ...f.models };
  await Promise.all(Array.from({ length: 20 }, () => f.authorize({ ...f.args, models: first })));
  const firstReads = f.state.metadataReads;
  await Promise.all(Array.from({ length: 20 }, () => f.authorize({ ...f.args, models: second })));
  assert.equal(f.state.prepares, 1); assert.equal(f.state.assertions, 2);
  assert.ok(firstReads <= 3); assert.ok(f.state.metadataReads <= 5);
});

test('a truly unmigrated legacy account retains its existing token authority and cache-only path', async () => {
  const f = fixture({ legacy: true, snapshot: false }); let caches = 0;
  const result = await loadAdSharing({ models: f.models, scope: f.args.scope, input: { purpose: 'patient_promotion' }, now,
    loadInventory: async () => f.inventory, authorizeCreative: f.authorize, loadCreative: async args => {
      caches++; assert.equal(args.cacheOnly, true); return { preview: { images: [image], bodies: ['Real cached copy'] } };
    } });
  assert.equal(result.items[0].selection.allowed, true); assert.equal(result.items[0].creative.source, 'creative_cache');
  assert.equal(caches, 1); assert.equal(f.state.prepares, 0); assert.ok(f.state.legacyReads >= 2);
});
