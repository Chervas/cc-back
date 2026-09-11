'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { creativeReference, publicUrl, normalizeCreative, cachedCreative, loadWorkspaceAdCreative } = require('../../services/campaignAdCreative.service');
const { createWorkspaceHandler } = require('../../controllers/campaignWorkspace.controller');

const ref = { provider: 'meta_ads', account_id: '123', campaign_id: '456', ad_id: '700', group_id: '800' };
const now = new Date('2026-09-11T00:00:00Z');
function fixture(provider = 'meta_ads') {
  const reference = { ...ref, provider }; const calls = [];
  const inventory = { campaigns: [{ provider, account_id: '123', campaign_id: '456', assigned: true, clinicId: 1 }],
    selectedClinics: [{ id_clinica: 1, grupoClinicaId: 5 }], groups: [5], authorizedGroups: [5], google: [], meta: [] };
  const mappings = [{ id: 1, assignmentScope: 'clinic', clinicaId: 1, metaConnectionId: 10 }];
  const grants = [{ id: 1, status: 'active', scopeKey: 'clinic:1', metaConnectionId: 10 }];
  const connection = { id: 10, accessToken: 'private-token', expiresAt: '2030-01-01' };
  const models = {
    CampaignWorkspaceSetting: { findAll: async () => [] },
    GoogleAdsAdInventory: { findOne: async () => null },
    GoogleAdsAdInsightsDaily: { findOne: async options => { calls.push(options); return { headlines: ['Titular real'], descriptions: ['Descripcion real'], finalUrl: 'https://clinica.example.com/', updated_at: now }; } },
    SocialAdsEntity: { findOne: async options => { calls.push(options); return { id: 1, updated_time: now }; } },
    ClinicMetaAsset: { findAll: async options => { calls.push(options); return mappings; } },
    MetaConnectionAssignment: { findAll: async () => grants }, MetaConnection: { findByPk: async () => connection },
  };
  const response = { id: '700', account_id: '123', campaign_id: '456', adset_id: '800', creative: {
    title: 'Titular de Meta', body: 'Texto real', image_url: 'https://scontent.fbcdn.net/photo.jpg', link_url: 'https://clinica.example.com/' } };
  const args = { models, scope: { clinicIds: [1], groupId: null }, input: reference, now, loadInventory: async () => inventory,
    cache: async (_key, load) => load(), read: async (endpoint, options) => { calls.push({ endpoint, options }); return { data: response }; } };
  return { args, models, calls, inventory, mappings, grants, connection, response };
}

test('creative reference is exact and never accepts composite IDs or provider paths', () => {
  assert.deepEqual(creativeReference(ref), ref);
  for (const patch of [{ ad_id: '../700' }, { ad_id: 700 }, { group_id: '' }, { provider: 'meta' }, { access_token: 'secret' }]) {
    assert.throws(() => creativeReference({ ...ref, ...patch }), { code: 'invalid_ad_creative' });
  }
});
test('only public HTTPS links and official CDN image URLs leave the normalizer', () => {
  for (const value of ['javascript:alert(1)', 'data:image/png;base64,x', 'https://user:pass@example.com', 'https://127.0.0.1',
    'https://[::1]', 'https://[::ffff:127.0.0.1]', 'https://[2001:db8::192.0.2.1]',
    'https://example.local', 'https://example.com:8443', 'https://example.com/?access_token=secret']) assert.equal(publicUrl(value), null);
  assert.equal(publicUrl('https://scontent.fbcdn.net/image.jpg?oh=signed', true), 'https://scontent.fbcdn.net/image.jpg?oh=signed');
  assert.equal(publicUrl('https://fbcdn.net.attacker.com/image.jpg', true), null);
  assert.equal(publicUrl('https://arbitrary.example.com/image.jpg', true), null);
});
test('Google retains real text variants and destination, without assembling a fictional impression', () => {
  const result = normalizeCreative('google_ads', { headlines: JSON.stringify(['Primero', { text: 'Segundo' }, 'Primero']),
    descriptions: [{ text: 'Descripcion' }], finalUrl: 'https://clinica.example.com/cita' }, now);
  assert.deepEqual(result.headlines, ['Primero', 'Segundo']); assert.deepEqual(result.descriptions, ['Descripcion']);
  assert.equal(result.images.length, 0); assert.equal(result.available, true); assert.equal(result.source, 'google_ads_cache');
});
test('Meta preserves image, video thumbnail, carousel resources and exact post link', () => {
  const result = normalizeCreative('meta_ads', { body: 'Mensaje', effective_object_story_id: '12_34', object_story_spec: { video_data: {
    title: 'Video', image_url: 'https://video.fbcdn.net/thumbnail.jpg', child_attachments: [{ name: 'Otra pieza', picture: 'https://scontent.cdninstagram.com/photo.jpg', link: 'https://clinica.example.com' }] } },
    asset_feed_spec: { titles: [{ text: 'Variante' }], bodies: [{ text: 'Otro texto' }] } }, now);
  assert.equal(result.video, true); assert.equal(result.images.length, 2); assert.equal(result.postUrl, 'https://www.facebook.com/12/posts/34');
  assert.deepEqual(result.headlines, ['Video', 'Otra pieza', 'Variante']); assert.deepEqual(result.bodies, ['Mensaje', 'Otro texto']);
  assert.equal(normalizeCreative('meta_ads', {}, now).available, false);
});
test('Google creative query is account/campaign/group/ad scoped and never calls an external provider', async () => {
  const f = fixture('google_ads'); f.args.read = () => assert.fail('unexpected API request');
  const result = await loadWorkspaceAdCreative(f.args);
  assert.equal(result.preview.headlines[0], 'Titular real'); assert.equal(result.reference.ad_id, '700');
  const query = f.calls[0]; assert.ok(query.where.customerId[Op.in].includes('123'));
  assert.equal(query.where.campaignId, '456'); assert.equal(query.where.adGroupId, '800'); assert.equal(query.where.adId, '700');
  assert.ok(!query.attributes.includes('raw_payload'));
});
test('Meta fetches one exact ad and checks both cached and API identity before exposing its creative', async () => {
  const f = fixture(); const result = await loadWorkspaceAdCreative(f.args);
  const call = f.calls.find(item => item.endpoint); assert.equal(call.endpoint, '700');
  assert.equal(call.options.maxRetries, 0); assert.equal(call.options.accessToken, 'private-token');
  assert.equal(f.calls[0].where.parent_id, '800'); assert.equal(f.calls[1].where.parent_id, '456');
  assert.equal(result.preview.bodies[0], 'Texto real'); assert.ok(!JSON.stringify(result).includes('private-token'));
  for (const field of ['id', 'account_id', 'campaign_id', 'adset_id']) {
    const wrong = fixture(); wrong.response[field] = '999';
    const value = await loadWorkspaceAdCreative(wrong.args); assert.equal(value.preview, null); assert.equal(value.error, 'workspace_ad_identity_mismatch');
  }
});
test('out-of-scope, missing ad and revoked grants never use cached/provider creative', async () => {
  for (const change of [f => f.inventory.campaigns.splice(0), f => { f.models.SocialAdsEntity.findOne = async () => null; }, f => f.grants.splice(0)]) {
    const f = fixture(); change(f); f.args.cache = () => assert.fail('unauthorized cache access');
    await assert.rejects(loadWorkspaceAdCreative(f.args));
  }
  const f = fixture(); f.grants[0].metaConnectionId = 11;
  await assert.rejects(loadWorkspaceAdCreative(f.args), { code: 'workspace_meta_permissions_required' });
});
test('unassigned campaign preview is allowed for the full authorized account group without assigning it', async () => {
  const f = fixture(); f.inventory.campaigns[0].assigned = false; f.inventory.campaigns[0].clinicId = null;
  f.mappings[0] = { id: 1, assignmentScope: 'group', grupoClinicaId: 5, metaConnectionId: 10 };
  f.grants[0].scopeKey = 'group:5';
  const result = await loadWorkspaceAdCreative(f.args); assert.equal(result.preview.available, true);
  const where = f.calls.find(call => call.where?.assetType).where;
  assert.deepEqual(where[Op.or], [{ assignmentScope: 'clinic', clinicaId: { [Op.in]: [1] } }, { assignmentScope: 'group', grupoClinicaId: { [Op.in]: [5] } }]);
});
test('scope and connection are checked again even after a successful cache/provider response', async () => {
  const f = fixture(); f.args.cache = async (_key, load) => { const value = await load(); f.connection.accessToken = 'rotated-token'; return value; };
  await assert.rejects(loadWorkspaceAdCreative(f.args), { code: 'workspace_creative_scope_changed' });
  const removed = fixture(); removed.args.cache = async (_key, load) => { const value = await load(); removed.inventory.campaigns.splice(0); return value; };
  await assert.rejects(loadWorkspaceAdCreative(removed.args), { code: 'workspace_campaign_not_in_scope' });
});
test('permission failures and temporary upstream failures are sanitized without affecting the report', async () => {
  const f = fixture(); f.args.read = async () => { throw { response: { data: { error: { code: 190, message: 'secret token' } } } }; };
  assert.equal((await loadWorkspaceAdCreative(f.args)).error, 'workspace_meta_permissions_required');
  f.args.cache = async () => { throw new Error('redis unavailable'); };
  const result = await loadWorkspaceAdCreative(f.args); assert.equal(result.error, 'workspace_creative_unavailable'); assert.equal(result.preview, null);
});
test('server cache survives callers, deduplicates concurrent reads and expires positive/negative results', async () => {
  const data = new Map(); const writes = []; let reads = 0;
  const store = { get: async key => data.get(key), set: async (key, value, unit, ttl) => { data.set(key, value); writes.push([unit, ttl]); } };
  const value = { preview: { available: true }, error: null };
  const load = async () => { reads++; return value; };
  const key = 'qa-creative-cache-positive';
  const a = cachedCreative(key, load, { store, now }); const b = cachedCreative(key, load, { store, now });
  assert.deepEqual(await a, value); assert.deepEqual(await b, value); assert.equal(reads, 1);
  await cachedCreative(key, load, { store, now: new Date(+now + 1000) }); assert.equal(reads, 1);
  await cachedCreative(key, load, { store, now: new Date(+now + 86401000) }); assert.equal(reads, 2);
  assert.deepEqual(writes[0], ['EX', 86400]);
  await cachedCreative('qa-creative-cache-error', async () => ({ error: 'unavailable', preview: null }), { store, now });
  assert.deepEqual(writes.at(-1), ['EX', 60]);
});
test('Meta quota pause has a sanitized retry time and cache avoids rechecking until it expires', async () => {
  const f = fixture(); const until = new Date(+now + 120000);
  f.args.read = async () => { throw Object.assign(new Error('private provider details'), { code: 'META_RATE_LIMIT_PAUSED', pauseUntil: until }); };
  const result = await loadWorkspaceAdCreative(f.args);
  assert.equal(result.error, 'workspace_creative_rate_limited'); assert.equal(result.retryAt, until.toISOString());
  assert.equal(result.preview, null); assert.ok(!JSON.stringify(result).includes('private'));
  const values = new Map(); let ttl; let reads = 0;
  const store = { get: async key => values.get(key), set: async (key, value, unit, seconds) => { values.set(key, value); ttl = seconds; } };
  const load = async () => { reads++; return result; };
  await cachedCreative('qa-creative-paused', load, { store, now }); assert.equal(ttl, 120);
  await cachedCreative('qa-creative-paused', load, { store, now: new Date(+now + 90000) }); assert.equal(reads, 1);
  await cachedCreative('qa-creative-paused', load, { store, now: new Date(+now + 120001) }); assert.equal(reads, 2);
  assert.equal(ttl, 60);
});
test('different ads share Redis startup instead of failing while another request connects', async () => {
  let resolve; let connects = 0;
  const store = { status: 'wait', connect() {
    connects++; this.status = 'connecting'; return new Promise(done => { resolve = () => { this.status = 'ready'; done(); }; });
  }, get: async () => { assert.equal(store.status, 'ready'); return null; }, set: async () => {} };
  const load = async () => ({ preview: { available: true }, error: null });
  const first = cachedCreative('qa-start-first', load, { store, now });
  const second = cachedCreative('qa-start-second', load, { store, now });
  assert.equal(connects, 1); resolve();
  assert.equal((await first).preview.available, true); assert.equal((await second).preview.available, true);
});
test('creative HTTP handler intersects aggregate scopes and rechecks access after asynchronous reads', async () => {
  let calls = 0; let observed;
  const handler = createWorkspaceHandler({ adCreative: true, models: {}, resolveScope: async () => ({ isAll: true, isValid: true, clinicIds: [1, 2] }),
    accessibleClinics: async () => [1], hasAccess: async () => ++calls === 1,
    load: async args => { observed = args; return { success: true }; } });
  const res = { status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, set() {} };
  await handler({ userData: { userId: 7 }, query: { scope: 'all', ...ref } }, res);
  assert.deepEqual(observed.scope.clinicIds, [1]); assert.deepEqual(observed.input, ref); assert.equal(res.code, 403);
});
