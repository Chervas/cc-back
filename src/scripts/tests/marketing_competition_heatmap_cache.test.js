'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Op } = require('sequelize');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const {
  DAY_MS,
  HEATMAP_FRESH_TTL_MS,
  HEATMAP_EXPIRES_TTL_MS,
  buildHeatmapCacheIdentity,
  heatmapCacheStatus,
  createHeatmapCacheCoordinator,
} = require('../../services/marketingCompetitionHeatmapCache.service');
const { __testing } = require('../../services/marketingCompetition.service');

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function sameDate(left, right) {
  if (!left && !right) return true;
  return new Date(left).getTime() === new Date(right).getTime();
}

function createFakeCacheModel(seed = []) {
  const rows = new Map(seed.map((row) => [row.cache_key, clone(row)]));

  function matches(row, where) {
    if (!row || row.cache_key !== where.cache_key) return false;
    if (Object.prototype.hasOwnProperty.call(where, 'generated_at') && !sameDate(row.generated_at, where.generated_at)) {
      return false;
    }
    if (Object.prototype.hasOwnProperty.call(where, 'refresh_lock_token') && row.refresh_lock_token !== where.refresh_lock_token) {
      return false;
    }
    const leaseClauses = where[Op.or];
    if (Array.isArray(leaseClauses)) {
      const available = leaseClauses.some((clause) => {
        if (Object.prototype.hasOwnProperty.call(clause, 'refresh_locked_until') && clause.refresh_locked_until === null) {
          return row.refresh_locked_until === null || row.refresh_locked_until === undefined;
        }
        const deadline = clause.refresh_locked_until?.[Op.lte];
        return deadline && row.refresh_locked_until && new Date(row.refresh_locked_until) <= new Date(deadline);
      });
      if (!available) return false;
    }
    return true;
  }

  return {
    rows,
    async findOne({ where }) {
      return clone(rows.get(where.cache_key) || null);
    },
    async findOrCreate({ where, defaults }) {
      if (rows.has(where.cache_key)) return [clone(rows.get(where.cache_key)), false];
      rows.set(where.cache_key, clone(defaults));
      return [clone(defaults), true];
    },
    async update(values, { where }) {
      const current = rows.get(where.cache_key);
      if (!matches(current, where)) return [0];
      rows.set(where.cache_key, { ...current, ...clone(values) });
      return [1];
    },
  };
}

function identity(overrides = {}) {
  return buildHeatmapCacheIdentity({
    scope: { scope: 'clinic', clinicIds: [66], isAll: false },
    clinicId: 66,
    placeKey: 'google-place:ChIJ-test',
    googlePlaceId: 'ChIJ-test',
    term: 'clínica dental',
    zoomKm: 3,
    gridSize: 5,
    algorithmVersion: 'local-relevance-bias-v1',
    ...overrides,
  });
}

function cachedRow(cacheIdentity, generatedAt, overrides = {}) {
  return {
    ...cacheIdentity,
    payload: { success: true, marker: 'stored', points: [] },
    provider_requests: 27,
    generated_at: generatedAt,
    fresh_until: new Date(generatedAt.getTime() + HEATMAP_FRESH_TTL_MS),
    expires_at: new Date(generatedAt.getTime() + HEATMAP_EXPIRES_TTL_MS),
    refresh_state: 'idle',
    refresh_lock_token: null,
    refresh_locked_until: null,
    ...overrides,
  };
}

function testIdentityIncludesEveryRankingDimension() {
  const base = identity();
  assert.equal(base.cache_key.length, 64);
  assert.notEqual(base.cache_key, identity({ clinicId: 67 }).cache_key);
  assert.notEqual(base.cache_key, identity({ placeKey: 'google-place:other' }).cache_key);
  assert.notEqual(base.cache_key, identity({ term: 'ortodoncia' }).cache_key);
  assert.notEqual(base.cache_key, identity({ zoomKm: 5 }).cache_key);
  assert.notEqual(base.cache_key, identity({ gridSize: 3 }).cache_key);
  assert.notEqual(base.cache_key, identity({ algorithmVersion: 'v2' }).cache_key);
  assert.notEqual(base.cache_key, identity({ scope: { scope: 'clinic', clinicIds: [67] } }).cache_key);
}

function testRestrictedProviderPayloadCannotMasqueradeAsManual() {
  assert.equal(__testing.payloadIncludesGooglePlacesContent({ source: 'google_places' }), true);
  assert.equal(__testing.payloadIncludesGooglePlacesContent({ source: 'manual', google_place_id: 'ChIJ-hidden' }), true);
  assert.equal(__testing.payloadIncludesGooglePlacesContent({ source: 'manual', raw_place_payload: { id: 'ChIJ-hidden' } }), true);
  assert.equal(__testing.payloadIncludesGooglePlacesContent({ source: 'manual', google_place_id: '', raw_place_payload: null }), false);
  assert.equal(__testing.payloadIncludesGooglePlacesContent({ source: 'manual', name: 'Competidor introducido por el usuario' }), false);
}

function testMissingManualCoordinatesRemainUnknown() {
  assert.equal(__testing.toNumber(undefined), null);
  assert.equal(__testing.toNumber(null), null);
  assert.equal(__testing.toNumber(''), null);
  assert.equal(__testing.toNumber('not-a-coordinate'), null);
  assert.equal(__testing.toNumber(0), 0);
  assert.equal(__testing.toNumber('41.3874'), 41.3874);
}

function testFreshStaleAndExpiredBoundaries() {
  const started = new Date('2026-07-01T10:00:00.000Z');
  const row = cachedRow(identity(), started);
  assert.equal(heatmapCacheStatus(row, new Date(started.getTime() + (7 * DAY_MS) - 1)), 'fresh');
  assert.equal(heatmapCacheStatus(row, new Date(started.getTime() + (7 * DAY_MS))), 'stale');
  assert.equal(heatmapCacheStatus(row, new Date(started.getTime() + (14 * DAY_MS) - 1)), 'stale');
  assert.equal(heatmapCacheStatus(row, new Date(started.getTime() + (14 * DAY_MS))), 'expired');
}

async function testStaleResponseIsImmediateAndRefreshIsDeduplicated() {
  const currentTime = new Date('2026-07-15T10:00:00.000Z');
  const cacheIdentity = identity();
  const stale = cachedRow(cacheIdentity, new Date(currentTime.getTime() - (8 * DAY_MS)));
  const model = createFakeCacheModel([stale]);
  const scheduled = [];
  let generated = 0;
  const coordinator = createHeatmapCacheCoordinator({
    model,
    now: () => new Date(currentTime),
    randomToken: () => 'lease-token',
    scheduleRefresh: async (job) => scheduled.push(job),
    logger: { warn() {} },
  });
  const generate = async () => {
    generated += 1;
    return {
      cacheable: true,
      providerRequests: 27,
      googlePlaceId: 'ChIJ-test',
      payload: { success: true, marker: 'refreshed', points: [] },
    };
  };

  const first = await coordinator.resolve({ identity: cacheIdentity });
  const second = await coordinator.resolve({ identity: cacheIdentity });

  assert.equal(first.marker, 'stored');
  assert.equal(first.cache.status, 'stale');
  assert.equal(first.cache.refresh_in_progress, true);
  assert.equal(first.cache.refresh_available, false);
  assert.equal(second.cache.status, 'stale');
  assert.equal(scheduled.length, 1);
  assert.equal(generated, 0, 'stale must be returned before provider work begins');

  await coordinator.generateAndPersist(cacheIdentity, scheduled[0].token, generate);
  assert.equal(generated, 1);
  const refreshed = await coordinator.resolve({ identity: cacheIdentity });
  assert.equal(refreshed.marker, 'refreshed');
  assert.equal(refreshed.cache.status, 'fresh');
  assert.equal(refreshed.cache.provider_requests, 27);
  assert.equal(scheduled.length, 1);
}

async function testExpiredSnapshotRefreshesOnceBeforeReturningFreshData() {
  const currentTime = new Date('2026-07-15T10:00:00.000Z');
  const cacheIdentity = identity();
  const expired = cachedRow(cacheIdentity, new Date(currentTime.getTime() - (15 * DAY_MS)));
  const model = createFakeCacheModel([expired]);
  let generated = 0;
  const scheduled = [];
  const coordinator = createHeatmapCacheCoordinator({
    model,
    now: () => new Date(currentTime),
    randomToken: () => 'expired-lease',
    scheduleRefresh: async (job) => scheduled.push(job),
  });

  const pending = await coordinator.resolve({ identity: cacheIdentity });
  assert.equal(generated, 0);
  assert.equal(pending.success, false);
  assert.equal(pending.pending, true);
  assert.equal(pending.cache.status, 'expired');
  assert.equal(pending.cache.refresh_in_progress, true);
  assert.equal(scheduled.length, 1);

  const result = await coordinator.generateAndPersist(
    cacheIdentity,
    scheduled[0].token,
    async () => {
      generated += 1;
      return {
        cacheable: true,
        providerRequests: 26,
        payload: { success: true, marker: 'expired-refreshed', points: [] },
      };
    }
  );
  assert.equal(generated, 1);
  assert.equal(result.marker, 'expired-refreshed');
  assert.equal(result.cache.status, 'fresh');
}

async function testProviderFailureUsesShortCacheTtl() {
  const currentTime = new Date('2026-07-15T10:00:00.000Z');
  const cacheIdentity = identity({ term: 'urgencias dentales' });
  const model = createFakeCacheModel();
  const coordinator = createHeatmapCacheCoordinator({
    model,
    now: () => new Date(currentTime),
    randomToken: () => 'failure-lease',
    scheduleRefresh: async (job) => scheduled.push(job),
  });
  const scheduled = [];
  const pending = await coordinator.resolve({ identity: cacheIdentity });
  assert.equal(pending.pending, true);
  assert.equal(scheduled.length, 1);
  const result = await coordinator.generateAndPersist(
    cacheIdentity,
    scheduled[0].token,
    async () => ({
      cacheable: true,
      freshTtlMs: 15 * 60 * 1000,
      expiresTtlMs: 60 * 60 * 1000,
      providerRequests: 25,
      payload: { success: false, provider_unavailable: true, points: [] },
    })
  );
  assert.equal(result.provider_unavailable, true);
  assert.equal(new Date(result.cache.fresh_until).getTime() - currentTime.getTime(), 15 * 60 * 1000);
  assert.equal(new Date(result.cache.expires_at).getTime() - currentTime.getTime(), 60 * 60 * 1000);
}

async function testDurableRetryReclaimsLeaseAfterProviderError() {
  const currentTime = new Date('2026-07-15T10:00:00.000Z');
  const cacheIdentity = identity({ term: 'implantes dentales' });
  const stale = cachedRow(cacheIdentity, new Date(currentTime.getTime() - (8 * DAY_MS)));
  const model = createFakeCacheModel([stale]);
  const tokens = ['queued-token', 'retry-token'];
  const scheduled = [];
  const coordinator = createHeatmapCacheCoordinator({
    model,
    now: () => new Date(currentTime),
    randomToken: () => tokens.shift(),
    scheduleRefresh: async (job) => scheduled.push(job),
    logger: { warn() {} },
  });
  await coordinator.resolve({ identity: cacheIdentity });
  assert.equal(scheduled[0].token, 'queued-token');

  const firstClaim = await coordinator.claimForRefresh(cacheIdentity, scheduled[0].token);
  assert.equal(firstClaim.reused, true);
  await assert.rejects(
    () => coordinator.generateAndPersist(cacheIdentity, firstClaim.token, async () => {
      throw new Error('temporary provider outage');
    }),
    /temporary provider outage/
  );

  const retryClaim = await coordinator.claimForRefresh(cacheIdentity, scheduled[0].token);
  assert.equal(retryClaim.acquired, true);
  assert.equal(retryClaim.reused, false);
  assert.equal(retryClaim.token, 'retry-token');
  const result = await coordinator.generateAndPersist(cacheIdentity, retryClaim.token, async () => ({
    cacheable: true,
    providerRequests: 26,
    payload: { success: true, marker: 'retry-succeeded', points: [] },
  }));
  assert.equal(result.marker, 'retry-succeeded');
  assert.equal(result.cache.status, 'fresh');
}

async function testSocialDiscoveryFetchPinsEveryRedirectTarget() {
  const resolved = [];
  const requests = [];
  let destroyed = 0;
  const resolveTarget = async (url) => {
    resolved.push(url);
    return {
      url,
      httpAgent: { destroy() { destroyed += 1; } },
      httpsAgent: { destroy() { destroyed += 1; } },
    };
  };
  const httpClient = {
    async get(url, config) {
      requests.push({ url, config });
      if (requests.length === 1) {
        return { status: 302, headers: { location: 'https://www.example.org/contacto' }, data: '' };
      }
      return {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        data: '<a href="https://instagram.com/example">Instagram</a>',
      };
    },
  };

  const response = await __testing.fetchPublicHtmlPage('https://example.org/', {
    httpClient,
    resolveSafeHttpTarget: resolveTarget,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(resolved, ['https://example.org/', 'https://www.example.org/contacto']);
  assert.equal(requests.length, 2);
  assert.ok(requests.every((item) => item.config.maxRedirects === 0 && item.config.proxy === false));
  assert.equal(destroyed, 4);
  await assert.rejects(
    () => __testing.fetchPublicHtmlPage('http://127.0.0.1/internal', { httpClient, resolveSafeHttpTarget: resolveTarget }),
    /target_invalid/
  );
}

async function testOneRelevantTextSearchPerGridPointWithoutFallback() {
  const calls = [];
  const tracker = { places_text_search_points: 0 };
  const points = await __testing.collectLocalHeatmapPoints({
    center: { latitude: 41.4, longitude: 2.17 },
    radiusKm: 3,
    query: 'clínica dental',
    ownPlaceId: 'own-place',
    ownName: 'Clínica propia',
    tracker,
    measuredAt: () => '2026-07-15T10:00:00.000Z',
    search: async (request) => {
      calls.push(request);
      return [];
    },
  });

  assert.equal(__testing.rankingHeatmapOffsets(3).length, 25);
  assert.equal(points.length, 25);
  assert.equal(calls.length, 25);
  assert.equal(tracker.places_text_search_points, 25);
  assert.ok(points.every((point) => point.my_position === null && point.score === 5));

  const body = __testing.buildLocalHeatmapSearchBody(calls[0]);
  assert.equal(body.rankPreference, 'RELEVANCE');
  assert.equal(body.locationBias.circle.radius, 1500);
  assert.equal(Object.hasOwn(body, 'locationRestriction'), false);
  assert.equal(__testing.LOCAL_HEATMAP_PLACE_FIELD_MASK, 'places.id,places.displayName');
  assert.doesNotMatch(__testing.collectLocalHeatmapPoints.toString(), /fallbackPlaces|second search/i);
}

async function testProviderOutageDoesNotClaimSuccess() {
  const points = Array.from({ length: 25 }, (_item, index) => ({
    latitude: 41.4,
    longitude: 2.17,
    x_km: 0,
    y_km: 0,
    my_position: null,
    score: index < 19 ? 5 : 0,
    top_results: [],
    ...(index < 19 ? {} : { error: { code: 'PROVIDER_UNAVAILABLE' } }),
  }));
  const generated = await __testing.generateLocalRankingHeatmapSnapshot({
    clinic: {
      id_clinica: 66,
      nombre_clinica: 'Clínica test',
      business_place_id: 'own-place',
      business_latitude: 41.4,
      business_longitude: 2.17,
    },
    terms: ['clínica dental'],
    selectedTerm: 'clínica dental',
    heatmapQuery: 'clínica dental Barcelona',
    radiusKm: 3,
    dependencies: {
      collectLocalHeatmapPoints: async () => points,
    },
  });
  assert.equal(generated.cacheable, true);
  assert.equal(generated.payload.success, false);
  assert.equal(generated.payload.provider_unavailable, true);
  assert.equal(generated.payload.valid_points, 19);
  assert.equal(generated.payload.required_valid_points, 20);
  assert.equal(generated.freshTtlMs, 15 * 60 * 1000);
}

async function testSuccessfulSnapshotPersistsOnlyRankingData() {
  const points = Array.from({ length: 25 }, (_item, index) => ({
    latitude: 41.4,
    longitude: 2.17,
    x_km: 0,
    y_km: 0,
    my_position: index + 1,
    score: 100 - index,
    top_results: ['Clínica propia'],
    measured_at: '2026-07-15T10:00:00.000Z',
  }));
  const generated = await __testing.generateLocalRankingHeatmapSnapshot({
    clinic: {
      id_clinica: 66,
      nombre_clinica: 'Clínica propia',
      business_place_id: 'own-place',
      business_latitude: 41.4,
      business_longitude: 2.17,
    },
    terms: ['clínica dental'],
    selectedTerm: 'clínica dental',
    heatmapQuery: 'clínica dental Barcelona',
    radiusKm: 3,
    dependencies: { collectLocalHeatmapPoints: async () => points },
  });
  assert.equal(generated.payload.success, true);
  assert.equal(generated.payload.map_provider, null);
  assert.equal(generated.payload.map_attribution, 'Google Maps');
  assert.equal(Object.hasOwn(generated.payload, 'map_image_data_url'), false);
  assert.equal(Object.hasOwn(generated.payload, 'map_error'), false);
}

async function testPersistedBusinessCoordinatesAvoidAnchorApiCall() {
  const tracker = {};
  const profile = await __testing.resolveOwnClinicHeatmapProfile({
    nombre_clinica: 'Clínica test',
    business_location_name: 'Ficha local test',
    business_place_id: 'own-place',
    business_maps_url: 'https://maps.google.com/?cid=123',
    business_latitude: 41.4,
    business_longitude: 2.17,
  }, tracker);
  assert.equal(profile.google_place_id, 'own-place');
  assert.equal(profile.latitude, 41.4);
  assert.equal(profile.longitude, 2.17);
  assert.deepEqual(tracker, {});
}

function testCompliancePurgeRemovesProviderIdentifiers() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../../migrations/20260715152000-purge-google-places-competition-content.js'),
    'utf8'
  );
  assert.match(source, /google_place_id\s*=\s*NULL/, 'the compliance purge must remove stored Places identifiers');
  assert.doesNotMatch(source, /RIGHT\(google_place_id/, 'an anonymized name must not retain a Places identifier fragment');
}

async function run() {
  testIdentityIncludesEveryRankingDimension();
  testRestrictedProviderPayloadCannotMasqueradeAsManual();
  testMissingManualCoordinatesRemainUnknown();
  testFreshStaleAndExpiredBoundaries();
  await testStaleResponseIsImmediateAndRefreshIsDeduplicated();
  await testExpiredSnapshotRefreshesOnceBeforeReturningFreshData();
  await testProviderFailureUsesShortCacheTtl();
  await testDurableRetryReclaimsLeaseAfterProviderError();
  await testSocialDiscoveryFetchPinsEveryRedirectTarget();
  await testOneRelevantTextSearchPerGridPointWithoutFallback();
  await testProviderOutageDoesNotClaimSuccess();
  await testSuccessfulSnapshotPersistsOnlyRankingData();
  await testPersistedBusinessCoordinatesAvoidAnchorApiCall();
  testCompliancePurgeRemovesProviderIdentifiers();
  console.log('marketing_competition_heatmap_cache.test.js OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
