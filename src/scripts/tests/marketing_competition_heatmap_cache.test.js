'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const axios = require('axios');
const { Op } = require('sequelize');

process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';
process.env.COMPETITION_GOOGLE_PLACES_COMPETITOR_USE_ALLOWED = 'true';
process.env.COMPETITION_GOOGLE_PLACES_COMPETITOR_STORAGE_ALLOWED = 'true';
process.env.COMPETITION_LOCAL_RANKING_STORAGE_ALLOWED = 'true';
process.env.GOOGLE_PLACES_API_KEY = process.env.GOOGLE_PLACES_API_KEY || 'test-key';

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
    algorithmVersion: 'local-relevance-bias-v2',
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

function testBlockedHeatmapCannotOfferRefresh() {
  const result = __testing.withBlockedLocalHeatmapMetadata({
    success: false,
    setup_required: true,
    setup_code: 'LOCAL_RANKING_PROVIDER_REQUIRED',
    message: 'Proveedor no disponible',
    points: [],
  });

  assert.equal(result.success, false);
  assert.equal(result.setup_required, true);
  assert.equal(result.cache.status, 'miss');
  assert.equal(result.cache.refresh_available, false);
  assert.equal(result.cache.refresh_in_progress, false);
}

async function testPassiveCompetitionListNeverCallsPlacesWhenGatesAreEnabled() {
  assert.equal(__testing.competitionPlacesFeatureEnabled(), true, 'the regression must exercise enabled Places gates');
  const originalGet = axios.get;
  const originalPost = axios.post;
  let providerCalls = 0;
  axios.get = async () => {
    providerCalls += 1;
    throw new Error('passive list must not call a provider');
  };
  axios.post = async () => {
    providerCalls += 1;
    throw new Error('passive list must not call a provider');
  };

  try {
    const result = await __testing.listCompetitionWithDependencies(
      { scope: 'clinic', clinicIds: [910066], isAll: false },
      {},
      {
        resolvePrimaryClinic: async () => ({
          id_clinica: 910066,
          nombre_clinica: 'Clínica persistida',
          direccion: 'Carrer de la Salut, 1',
          ciudad: 'Barcelona',
          servicios: 'odontología',
          configuracion: { disciplinas: ['odontologia'] },
          url_ficha_local: 'https://maps.google.com/?cid=123',
          business_location_name: 'Ficha local persistida',
          business_location_mapping_id: 123,
          business_place_id: 'ChIJ-persisted',
          business_maps_url: 'https://maps.google.com/?cid=123',
          business_primary_category: 'Dentist',
          business_address_lines: ['Carrer de la Salut, 1'],
          business_latitude: 41.4,
          business_longitude: 2.17,
          business_photo_url: 'https://example.org/profile.webp',
        }),
        loadOwnProfileReviewSummary: async () => ({ rating: 4.86, review_count: 174 }),
        loadCompetitorRows: async () => [],
        hydrateCompetitors: async (rows) => rows,
        providerStatusForScope: async () => ({}),
      }
    );

    assert.equal(providerCalls, 0);
    assert.equal(result.setup.automatic_discovery_available, true);
    assert.equal(result.own_profile.name, 'Ficha local persistida');
    assert.equal(result.own_profile.google_place_id, 'ChIJ-persisted');
    assert.equal(result.own_profile.google_maps_url, 'https://maps.google.com/?cid=123');
    assert.equal(result.own_profile.category, 'Dentist');
    assert.equal(result.own_profile.address, 'Carrer de la Salut, 1');
    assert.equal(result.own_profile.rating, 4.86);
    assert.equal(result.own_profile.reviews_count, 174);
    assert.equal(result.own_profile.photo_url, 'https://example.org/profile.webp');
    assert.deepEqual(result.local_ranking, []);
    assert.ok(result.ranking_terms.length > 0);
  } finally {
    axios.get = originalGet;
    axios.post = originalPost;
  }
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
  assert.equal(body.pageSize, 20);
  assert.equal(Object.hasOwn(body, 'maxResultCount'), false);
  assert.equal(body.locationBias.circle.radius, 1500);
  assert.equal(Object.hasOwn(body, 'locationRestriction'), false);
  assert.equal(__testing.LOCAL_HEATMAP_PLACE_FIELD_MASK, 'places.id');
  assert.doesNotMatch(__testing.collectLocalHeatmapPoints.toString(), /fallbackPlaces|second search/i);
  assert.doesNotMatch(__testing.collectLocalHeatmapPoints.toString(), /businessNamesMatch|ownName/,
    'ID-only tiles must never fall back to matching the clinic name');
}

async function testMissingOwnPlaceIdStopsBeforeGridQueries() {
  let gridCalls = 0;
  await assert.rejects(
    () => __testing.collectLocalHeatmapPoints({
      center: { latitude: 41.4, longitude: 2.17 },
      radiusKm: 3,
      query: 'clínica dental',
      ownPlaceId: null,
      tracker: {},
      search: async () => {
        gridCalls += 1;
        return [];
      },
    }),
    (error) => error?.code === 'LOCAL_PROFILE_PLACE_ID_REQUIRED',
  );
  assert.equal(gridCalls, 0, 'the 25 grid searches must not start without the canonical Place ID');

  let collectorCalled = false;
  const generated = await __testing.generateLocalRankingHeatmapSnapshot({
    clinic: {
      id_clinica: 66,
      nombre_clinica: 'Clínica sin ficha resuelta',
      business_place_id: null,
      business_latitude: 41.4,
      business_longitude: 2.17,
    },
    terms: ['clínica dental'],
    selectedTerm: 'clínica dental',
    heatmapQuery: 'clínica dental',
    radiusKm: 3,
    dependencies: {
      resolveOwnClinicHeatmapProfile: async () => ({ latitude: 41.4, longitude: 2.17 }),
      resolveHeatmapCompetitorIdentities: async () => [],
      collectLocalHeatmapPoints: async () => {
        collectorCalled = true;
        return [];
      },
    },
  });
  assert.equal(collectorCalled, false);
  assert.equal(generated.payload.success, false);
  assert.equal(generated.payload.setup_required, true);
  assert.equal(generated.payload.setup_code, 'LOCAL_PROFILE_PLACE_ID_REQUIRED');
  assert.equal(generated.payload.points.length, 0);
}

async function testMissingStoredPlaceIdUsesOneAnchorResolutionBeforeGrid() {
  const originalPost = axios.post;
  const calls = [];
  axios.post = async (url, body, config) => {
    calls.push({ url, body, config });
    return {
      data: {
        places: [{
          id: 'resolved-own-place',
          displayName: { text: 'Clínica Anchor Única 910066' },
          formattedAddress: 'Carrer Test 910066, Barcelona',
          location: { latitude: 41.4, longitude: 2.17 },
        }],
      },
    };
  };
  try {
    const tracker = {};
    const profile = await __testing.resolveOwnClinicHeatmapProfile({
      id_clinica: 910066,
      nombre_clinica: 'Clínica Anchor Única 910066',
      direccion: 'Carrer Test 910066',
      ciudad: 'Barcelona',
      business_place_id: null,
      business_latitude: 41.4,
      business_longitude: 2.17,
    }, tracker);
    assert.equal(calls.length, 1, 'only one anchor lookup may run before the grid');
    assert.equal(profile.google_place_id, 'resolved-own-place');
    assert.equal(calls[0].config.headers['X-Goog-FieldMask'], __testing.LOCAL_HEATMAP_ANCHOR_SEARCH_FIELD_MASK);
    assert.deepEqual(tracker, { places_anchor_search: 1 });
  } finally {
    axios.post = originalPost;
  }
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
      resolveHeatmapCompetitorIdentities: async () => [],
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
    dependencies: {
      resolveHeatmapCompetitorIdentities: async () => [],
      collectLocalHeatmapPoints: async () => points,
    },
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

async function testMissingBusinessCoordinatesUseCheapPlaceDetailsAnchor() {
  const originalGet = axios.get;
  const calls = [];
  axios.get = async (url, config) => {
    calls.push({ url, config });
    return {
      data: {
        id: 'own-place',
        location: { latitude: 41.4424052, longitude: 2.2239243 },
      },
    };
  };
  try {
    const tracker = {};
    const clinic = {
      nombre_clinica: 'Propdental Badalona',
      business_location_name: 'PROPDENTAL | Clínica Dental en Badalona',
      business_place_id: 'own-place',
      business_maps_url: 'https://maps.google.com/?cid=123',
      business_latitude: null,
      business_longitude: null,
    };
    const profile = await __testing.resolveOwnClinicHeatmapProfile(clinic, tracker);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /\/places\/own-place$/);
    assert.equal(calls[0].config.headers['X-Goog-FieldMask'], 'id,location');
    assert.equal(profile.name, 'PROPDENTAL | Clínica Dental en Badalona');
    assert.equal(profile.latitude, 41.4424052);
    assert.equal(profile.longitude, 2.2239243);
    assert.deepEqual(tracker, { places_anchor_details: 1 });
    const cachedTracker = {};
    const cachedProfile = await __testing.resolveOwnClinicHeatmapProfile(clinic, cachedTracker);
    assert.equal(calls.length, 1, 'the same place anchor must be reused from runtime cache');
    assert.deepEqual(cachedTracker, {});
    assert.deepEqual(cachedProfile, profile);
  } finally {
    axios.get = originalGet;
  }
}

async function testIdOnlyHeatmapResultFindsOwnPlace() {
  let call = 0;
  const points = await __testing.collectLocalHeatmapPoints({
    center: { latitude: 41.4424052, longitude: 2.2239243 },
    radiusKm: 1,
    query: 'clínica dental',
    ownPlaceId: 'own-place',
    ownName: 'Propdental Badalona',
    knownCompetitors: [
      { id: 91, name: 'Clínica rival conocida', google_place_id: 'other-place', monitored: true },
      { id: null, name: 'Clínica rival sugerida', google_place_id: 'suggested-place', monitored: false },
    ],
    tracker: {},
    search: async () => {
      call += 1;
      return call === 1 ? [{ id: 'other-place' }, { id: 'suggested-place' }, { id: 'own-place' }] : [];
    },
  });
  assert.equal(points[0].my_position, 3);
  assert.equal(points[0].score, 100);
  assert.deepEqual(points[0].ranked_competitors, [{
    competitor_id: 91,
    name: 'Clínica rival conocida',
    position: 1,
    monitored: true,
  }, {
    competitor_id: null,
    name: 'Clínica rival sugerida',
    position: 2,
    monitored: false,
  }]);
  assert.equal(Object.hasOwn(points[0], 'ranked_place_ids'), false, 'unknown provider identities must not leak into the payload');
}

async function testExactIdentityFallbackNamesThePlacesAheadOfOwnClinic() {
  let call = 0;
  const tracker = {};
  const points = await __testing.collectLocalHeatmapPoints({
    center: { latitude: 41.3661, longitude: 2.1162 },
    radiusKm: 1,
    query: 'clínica dental',
    ownPlaceId: 'hospitalet-own-place',
    knownCompetitors: [],
    tracker,
    search: async () => {
      call += 1;
      return call === 1
        ? [{ id: 'first-place' }, { id: 'second-place' }, { id: 'hospitalet-own-place' }]
        : [{ id: 'hospitalet-own-place' }];
    },
  });
  assert.equal(points[0].my_position, 3);
  assert.deepEqual(points[0].ranked_competitors, []);

  const detailCalls = [];
  const hydrated = await __testing.hydrateLocalHeatmapPointIdentities({
    points,
    ownPlaceId: 'hospitalet-own-place',
    knownCompetitors: [],
    tracker,
    resolveIdentity: async (placeId, requestTracker) => {
      detailCalls.push(placeId);
      requestTracker.places_identity_details = (requestTracker.places_identity_details || 0) + 1;
      return {
        id: null,
        name: placeId === 'first-place' ? 'Primera clínica' : 'Segunda clínica',
        google_place_id: placeId,
        monitored: false,
      };
    },
  });
  assert.deepEqual(detailCalls.sort(), ['first-place', 'second-place']);
  assert.deepEqual(hydrated[0].ranked_competitors, [{
    competitor_id: null,
    name: 'Primera clínica',
    position: 1,
    monitored: false,
  }, {
    competitor_id: null,
    name: 'Segunda clínica',
    position: 2,
    monitored: false,
  }]);
  assert.doesNotMatch(JSON.stringify(hydrated), /first-place|second-place|hospitalet-own-place/,
    'Place IDs used for exact hydration must never leak into the persisted heatmap payload');
}

function testStrictGeoPointRejectsMissingAndZeroAnchor() {
  assert.equal(__testing.strictGeoPoint(null, null), null);
  assert.equal(__testing.strictGeoPoint('', ''), null);
  assert.equal(__testing.strictGeoPoint(0, 0), null);
  assert.deepEqual(__testing.strictGeoPoint('41.4424052', '2.2239243'), {
    latitude: 41.4424052,
    longitude: 2.2239243,
  });
  assert.match(__testing.LOCAL_HEATMAP_ALGORITHM_VERSION, /v5$/);
}

async function testHeatmapUsesOneCachedIdentitySearchForNames() {
  const originalPost = axios.post;
  const calls = [];
  axios.post = async (url, body, config) => {
    calls.push({ url, body, config });
    return {
      data: {
        places: [{ id: 'rival-place', displayName: { text: 'Clínica rival' } }],
      },
    };
  };
  const tracker = {};
  try {
    const identities = await __testing.resolveHeatmapCompetitorIdentities({
      query: 'clínica dental en Hospitalet prueba identidad',
      center: { latitude: 41.3661, longitude: 2.1162 },
      tracker,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].config.headers['X-Goog-FieldMask'], 'places.id,places.displayName');
    assert.ok(calls[0].body.locationRestriction?.rectangle);
    assert.deepEqual(identities, [{
      id: null,
      name: 'Clínica rival',
      google_place_id: 'rival-place',
      monitored: false,
    }]);
    assert.deepEqual(tracker, { places_identity_search: 1 });
  } finally {
    axios.post = originalPost;
  }
}

function testCancelledCompliancePurgeCannotRemoveProviderContent() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../../migrations/20260715152000-purge-google-places-competition-content.js'),
    'utf8'
  );
  assert.match(source, /CANCELLED MIGRATION/, 'the obsolete destructive migration must remain explicitly cancelled');
  assert.match(source, /async up\(\) \{\}/, 'a normal migration run must safely record the cancelled migration');
  assert.doesNotMatch(source, /DELETE\s+snapshots|bulkDelete|google_place_id\s*=\s*NULL/, 'the cancelled migration must contain no destructive operation');
}

async function run() {
  testIdentityIncludesEveryRankingDimension();
  testRestrictedProviderPayloadCannotMasqueradeAsManual();
  testMissingManualCoordinatesRemainUnknown();
  testBlockedHeatmapCannotOfferRefresh();
  await testPassiveCompetitionListNeverCallsPlacesWhenGatesAreEnabled();
  testFreshStaleAndExpiredBoundaries();
  await testStaleResponseIsImmediateAndRefreshIsDeduplicated();
  await testExpiredSnapshotRefreshesOnceBeforeReturningFreshData();
  await testProviderFailureUsesShortCacheTtl();
  await testDurableRetryReclaimsLeaseAfterProviderError();
  await testSocialDiscoveryFetchPinsEveryRedirectTarget();
  await testOneRelevantTextSearchPerGridPointWithoutFallback();
  await testMissingOwnPlaceIdStopsBeforeGridQueries();
  await testMissingStoredPlaceIdUsesOneAnchorResolutionBeforeGrid();
  await testProviderOutageDoesNotClaimSuccess();
  await testSuccessfulSnapshotPersistsOnlyRankingData();
  await testPersistedBusinessCoordinatesAvoidAnchorApiCall();
  await testMissingBusinessCoordinatesUseCheapPlaceDetailsAnchor();
  await testIdOnlyHeatmapResultFindsOwnPlace();
  await testExactIdentityFallbackNamesThePlacesAheadOfOwnClinic();
  await testHeatmapUsesOneCachedIdentitySearchForNames();
  testStrictGeoPointRejectsMissingAndZeroAnchor();
  testCancelledCompliancePurgeCannotRemoveProviderContent();
  console.log('marketing_competition_heatmap_cache.test.js OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
