'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const sequelize = require('sequelize');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');
const { prepareValidatedReportSnapshot } = require('../../lib/validated-report-snapshot');
const reads = require('../../lib/searchConsoleReadSource');
const { harness } = require('./helpers/marketingOfflineHarness');

function fixture() {
  const f = { allowed: true, session: true, assigned: true, revision: '1', reads: 0,
    payload: { success: true, seoQueries: Array.from({ length: 250 }, (_, n) => ({ query: `query ${n}`, clicks: n })),
      cache: { status: 'fresh', generated_at: '2026-11-02T00:00:00Z', fresh_until: '2099-01-01T00:00:00Z', refresh_in_progress: false } } };
  const cacheApi = loadDiscoverySource('services/marketingReportOverviewCache.service.js', {
    crypto, sequelize, '../../models': {}, './jobRequests.service': {},
  }, { env: { SC_ANALYTICS_READ_ENABLED: 'true' } });
  const identity = cacheApi.buildOverviewCacheIdentity;
  f.withMetadata = cacheApi.withOverviewCacheMetadata;
  const controller = loadDiscoverySource('controllers/marketingReports.controller.js', {
    'node:crypto': crypto, sequelize, '../../models': { Sequelize: sequelize },
    '../lib/searchConsoleReadSource': reads,
    '../lib/validated-report-snapshot': { prepareValidatedReportSnapshot },
    '../lib/clinicScope': { resolveClinicScope: async id => ({ isValid: true, scope: 'clinic', clinicIds: [Number(id)] }) },
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async () => f.allowed },
    '../lib/role-helpers': { isGlobalAdmin: () => false },
    '../services/effectiveMarketingAssets.service': { resolveEffectiveMarketingAssetInventory: async ({ clinicIdRaw }) => ({
      scope: { clinic_ids: [clinicIdRaw] }, google: { available_assets: { search_console: f.assigned
        ? [{ mapping_id: 1, clinic_id: clinicIdRaw, connection_id: 81, site_url: 'https://example.invalid/' }] : [] } },
    }) },
    '../services/searchConsoleBroker.service': { prepare: async () => { if (f.revoked) throw Error('revoked'); } },
    '../services/searchConsoleAnalytics.service': { readRevisions: async () => [{ revision: f.revision }] },
    '../services/accessSession.service': { bearer: value => value, verify: async () => f.session ? { userId: 501, jti: 'offline-session', sessionVersion: 1 } : null },
    '../services/marketingReportOverviewCache.service': { buildOverviewCacheIdentity: identity, overviewCache: {
      readOrGenerate: async ({ forceRefresh }) => { f.reads++; f.forced = forceRefresh; await f.afterRead?.(); return f.payload; },
    } },
  }, { env: { SC_ANALYTICS_READ_ENABLED: 'true' } });
  f.request = async (query = {}) => {
    const res = { statusCode: 200, headers: {}, set(k, v) { this.headers[k] = v; },
      status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await controller.getOverview({ query: { clinicId: '71', startDate: '2026-10-04', endDate: '2026-11-02', snapshotProtocol: '1', ...query },
      userData: { userId: 501 }, headers: { authorization: 'OFFLINE_ONLY' } }, res);
    return res;
  };
  return f;
}

test('navigation validates on every hit and returns only a content/identity acknowledgement', async () => {
  const f = fixture(); const first = await f.request();
  const second = await f.request({ knownSnapshot: first.body.snapshotId });
  assert.equal(f.reads, 2);
  assert.equal(second.statusCode, 200);
  assert.equal(second.headers['Cache-Control'], 'no-store');
  assert.equal(second.body.notModified, true);
  assert.equal(second.body.seoQueries, undefined);
  assert(JSON.stringify(second.body).length < JSON.stringify(first.body).length / 10);
  assert.equal(f.payload.snapshotId, undefined, 'wire metadata must not enter the persistent payload');
});

test('scope, period, revision, content and freshness cannot reuse an unrelated payload', async () => {
  for (const mutation of [
    f => { f.revision = '2'; }, f => { f.payload.seoQueries[0].clicks = 999; },
    f => { f.payload.cache.generated_at = '2026-11-02T01:00:00Z'; },
    f => { f.payload.cache.status = 'stale'; }, f => { f.payload.cache.refresh_in_progress = true; },
    f => { f.payload.cache.fresh_until = '2000-01-01'; },
  ]) {
    const f = fixture(), first = await f.request(); mutation(f);
    const next = await f.request({ knownSnapshot: first.body.snapshotId });
    assert.equal(next.body.notModified, undefined); assert(next.body.seoQueries);
  }
  for (const changed of [{ clinicId: '72' }, { startDate: '2026-10-05' }]) {
    const f = fixture(), first = await f.request();
    const next = await f.request({ ...changed, knownSnapshot: first.body.snapshotId });
    assert.notEqual(next.body.snapshotId, first.body.snapshotId); assert(next.body.seoQueries);
  }
});

test('permission, session, broker, mapping and revision races reject conditional reuse', async () => {
  for (const [key, value, status] of [['allowed', false, 403], ['session', false, 401], ['revoked', true, 403], ['assigned', false, 409], ['revision', '2', 409]]) {
    const f = fixture(), first = await f.request(); f.afterRead = () => { f[key] = value; };
    const next = await f.request({ knownSnapshot: first.body.snapshotId });
    assert.equal(next.statusCode, status, key); assert.equal(next.body.notModified, undefined);
    assert.equal(next.body.snapshotId, undefined); assert.equal(next.body.seoQueries, undefined);
  }
});

test('manual refresh and legacy clients always receive the full response', async () => {
  const f = fixture(), first = await f.request();
  const refresh = await f.request({ knownSnapshot: first.body.snapshotId, forceRefresh: 'true' });
  assert.equal(f.forced, true); assert(refresh.body.seoQueries); assert.equal(refresh.body.snapshotId, undefined);
  const legacy = await f.request({ snapshotProtocol: undefined, knownSnapshot: first.body.snapshotId });
  assert(legacy.body.seoQueries); assert.equal(legacy.body.snapshotId, undefined);
});

test('real cache metadata remains stable across reads; live expiry updates travel outside the content hash', async t => {
  const f = fixture(), now = new Date();
  const row = { payload: { ...f.payload, lastUpdated: now.toISOString() }, generated_at: now,
    data_cutoff_at: now, fresh_until: new Date(now.getTime() + 60000), expires_at: new Date(now.getTime() + 180000),
    report_version: 'marketing-overview-v1-patient-context-v1-sc-property-v2', refresh_state: 'idle' };
  delete row.payload.cache;
  f.payload = f.withMetadata(row.payload, row, { now });
  const first = await f.request();
  f.payload = f.withMetadata(row.payload, row, { now: new Date(now.getTime() + 1000) });
  const hit = await f.request({ knownSnapshot: first.body.snapshotId });
  assert.equal(hit.body.notModified, true); assert.equal(hit.body.snapshotId, first.body.snapshotId);
  row.fresh_until = new Date(now.getTime() + 120000);
  f.payload = f.withMetadata(row.payload, row, { now: new Date(now.getTime() + 2000) });
  const renewed = await f.request({ knownSnapshot: first.body.snapshotId });
  assert.equal(renewed.body.notModified, true); assert.equal(renewed.body.cache.fresh_until, row.fresh_until.toISOString());
  assert.equal(renewed.body.cache.generated_at, first.body.cache.generated_at);
  t.diagnostic(`Fixture bytes: full=${Buffer.byteLength(JSON.stringify(first.body))}, validated-match=${Buffer.byteLength(JSON.stringify(renewed.body))}; not a latency measurement`);
  // A live lease/stale boundary must deliver a normal response, never an acknowledgement.
  f.payload = f.withMetadata(row.payload, row, { now: new Date(now.getTime() + 125000) });
  assert.equal((await f.request({ knownSnapshot: first.body.snapshotId })).body.notModified, undefined);
  row.generated_at = new Date(now.getTime() + 3000);
  f.payload = f.withMetadata(row.payload, row, { now });
  assert.notEqual((await f.request({ knownSnapshot: first.body.snapshotId })).body.snapshotId, first.body.snapshotId);
});

test('full, hit, denied, restored and revision-change sequence always consults current authority', async () => {
  const f = fixture(), first = await f.request(); const query = { knownSnapshot: first.body.snapshotId };
  assert.equal((await f.request(query)).body.notModified, true);
  f.session = false;
  const denied = await f.request(query); assert.equal(denied.statusCode, 401); assert.equal(denied.body.notModified, undefined);
  f.session = true; f.allowed = false; assert.equal((await f.request(query)).statusCode, 403);
  f.allowed = true; const restored = await f.request(); assert(restored.body.seoQueries);
  assert.equal((await f.request({ knownSnapshot: restored.body.snapshotId })).body.notModified, true);
  f.revision = '2'; const revised = await f.request(query); assert(revised.body.seoQueries);
  assert.notEqual(revised.body.snapshotId, first.body.snapshotId);
});

test('real competitor hydration with photo resources never contacts providers during navigation', async () => {
  let providerCalls = 0, snapshotReads = 0;
  const deny = () => { providerCalls++; throw Error('forbidden provider'); };
  const service = harness({ models: {
    MarketingCompetitorSnapshot: { findOne: async () => { snapshotReads++; return null; } },
    MarketingCompetitorAdSnapshot: { findOne: async () => { snapshotReads++; return null; } },
  }, mocks: { axios: { get: deny, post: deny } } }).load('services/marketingCompetition.service.js');
  let clinic = { id_clinica: 71, nombre_clinica: 'Fixture clinic', configuracion: { disciplinas: ['dental'] },
    business_place_id: 'place-own', business_location_mapping_id: 3, business_latitude: 41.4, business_longitude: 2.17 };
  const dependencies = { resolvePrimaryClinic: async () => clinic,
    loadCompetitorRows: async () => [1, 2].map(id => ({ id, name: `Competitor ${id}`, source: 'google_places', is_active: true,
      raw_place_payload: { photos: [{ name: `places/${id}/photos/photo` }] } })),
    loadOwnProfileReviewSummary: async () => ({ rating: 4.5, review_count: 10 }), providerStatusForScope: async () => ({}) };
  const read = area => service.__testing.listCompetitionWithDependencies({ scope: 'clinic', clinicIds: [71] }, { medicalArea: area }, dependencies);
  const first = await read(null), second = await read('dental');
  assert.equal(snapshotReads, 6, 'default and resolved area reuse the same canonical backend cache');
  assert.equal(first.own_profile.name, second.own_profile.name);
  assert(first.competitors.every(c => c.photo_url === null && c.photo_name));
  assert.equal(providerCalls, 0, 'a caught photo transport failure is still a forbidden call');
  clinic = { ...clinic, business_place_id: 'place-reassigned' };
  await read('dental'); assert.equal(snapshotReads, 12, 'a different local identity must miss the list cache');
  assert.equal(providerCalls, 0);
});
