'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const { harness, forbidden } = require('./helpers/marketingOfflineHarness');
const { resolveMedicalArea, withMedicalArea, medicalAreaFromRequest, medicalContextKey } = require('../../lib/marketingMedicalArea');
const { createHeatmapCacheCoordinator, DAY_MS } = require('../../services/marketingCompetitionHeatmapCache.service');

const codes = ['estetica', 'nutricion', 'cirugia_digestiva', 'psicologia', 'capilar', 'cirugia_estetica'];
const scope = { scope: 'clinic', clinicIds: [72], isAll: false };
function clinic(overrides = {}) {
  return {
    id_clinica: 72, nombre_clinica: 'BS Medical fixture', ciudad: 'Alicante', pais: 'España',
    configuracion: { disciplinas: [...codes] },
    business_location_mapping_id: 42, business_location_id: 'locations/fixture',
    business_location_name: 'BS Medical fixture', business_primary_category: 'Clínica capilar',
    business_place_id: 'ChIJ-fixture72', business_latitude: 38.34, business_longitude: -0.48,
    ...overrides,
  };
}
function services(options) {
  const h = harness(options);
  return { ...h, competition: h.load('services/marketingCompetition.service.js'), ai: h.load('services/marketingAiVisibility.service.js') };
}
function aiFixtures(ai, initial = clinic()) {
  let current = initial;
  let nextId = 0;
  const rows = [], jobs = [];
  const matches = (row, where) => Reflect.ownKeys(where).every(key => {
    if (key === Op.or) return where[key].some(clause => matches(row, clause));
    const actual = row[key], expected = where[key];
    if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
      return Reflect.ownKeys(expected).every(operator => {
        const value = expected[operator];
        if (operator === Op.in) return value.includes(actual);
        if (operator === Op.ne) return value === null ? actual != null : actual !== value;
        if (operator === Op.gt) return actual > value;
        if (operator === Op.gte) return actual >= value;
        throw new Error(`Unknown fixture operator ${String(operator)}`);
      });
    }
    return actual === expected;
  });
  const RunModel = {
    async findAll({ where }) { return rows.filter(row => matches(row, where)); },
    async findOne({ where }) { return rows.find(row => matches(row, where)) || null; },
    async findByPk(id) { return rows.find(row => row.id === id) || null; },
    async count({ where, distinct, col }) {
      const matching = rows.filter(row => matches(row, where));
      return distinct ? new Set(matching.map(row => row[col])).size : matching.length;
    },
    async create(values) {
      const row = { id: ++nextId, created_at: new Date(), ...values,
        async update(patch) { Object.assign(row, patch); return row; },
        async destroy() { rows.splice(rows.indexOf(row), 1); },
      };
      rows.push(row); return row;
    },
  };
  const dependencies = {
    RunModel,
    resolveClinicContext: (id, options) => ai.__testing.resolveClinicContext(id, options, {
      resolvePrimaryClinic: async () => current,
    }),
    jobRequestsService: { async enqueueUniqueJobRequest(input) {
      const existing = jobs.find(job => job.dedupeScope === input.dedupeScope);
      if (existing) return { job: existing, created: false };
      const job = { id: jobs.length + 1, ...input }; jobs.push(job); return { job, created: true };
    } },
    jobScheduler: { async triggerImmediate() {} },
  };
  return { rows, jobs, dependencies, setClinic(value) { current = value; } };
}

test('BS72 preserves every area and its configuration order; explicit selection overrides default', () => {
  const source = clinic();
  const before = structuredClone(source);
  const selection = resolveMedicalArea(source);
  assert.deepEqual(selection.medical_areas.map(area => area.code), codes);
  assert.equal(selection.selected_medical_area.code, 'estetica');
  assert.equal(selection.selected_medical_area.label, 'Medicina estética');
  assert.equal(selection.medical_areas[2].label, 'Cirugía general y digestiva');
  assert.equal(selection.selection_required, false);
  assert.equal(resolveMedicalArea(source, 'cirugia_estetica').selected_medical_area.label, 'Cirugía estética');
  for (const code of codes) assert.equal(resolveMedicalArea(source, code).selected_medical_area.code, code);
  const reordered = clinic({ configuracion: { disciplinas: ['nutricion', 'estetica', 'capilar'] } });
  assert.equal(resolveMedicalArea(reordered).selected_medical_area.code, 'nutricion');
  assert.deepEqual(source, before);
});

test('request parsing and assignment checks reject malformed, conflicting and unassigned areas', () => {
  for (const value of ['', [], {}, 72, 'ESTETICA', 'estetica,capilar']) {
    assert.throws(() => medicalAreaFromRequest({ query: { medical_area: value } }), { code: 'MEDICAL_AREA_INVALID' });
  }
  assert.throws(() => medicalAreaFromRequest({ query: { medical_area: 'capilar' }, body: { medical_area: 'estetica' } }), { code: 'MEDICAL_AREA_CONFLICT' });
  assert.throws(() => resolveMedicalArea(clinic(), 'dental'), { status: 403, code: 'MEDICAL_AREA_NOT_ASSIGNED' });
});

test('legacy GBP fallback remains usable without inventing assigned areas; stale and ambiguous identities fail closed', () => {
  const source = clinic({ configuracion: {}, business_primary_category: 'Dentista' });
  const result = resolveMedicalArea(source);
  assert.deepEqual(result.medical_areas, []);
  assert.equal(result.selected_medical_area, null);
  assert.equal(result.medical_search_category, 'clínica dental');
  assert.throws(() => resolveMedicalArea(source, 'dental'), { code: 'MEDICAL_AREA_NOT_ASSIGNED' });
  assert.equal(resolveMedicalArea({ ...source, business_primary_category: 'Clínica' }).medical_search_category, null);
  assert.equal(resolveMedicalArea({ ...source, business_primary_category: 'Clínica capilar y medicina estética' }).medical_search_category, null);
  const fromUrl = { url_ficha_local: 'https://example.test/current', configuracion: { marketing_competition_local_profile: {
    status: 'resolved', source_url: 'https://example.test/old', primary_category: 'Dentista',
  } } };
  assert.equal(resolveMedicalArea(fromUrl).medical_search_category, null);
  fromUrl.configuracion.marketing_competition_local_profile.source_url = fromUrl.url_ficha_local;
  assert.equal(resolveMedicalArea(fromUrl).medical_search_category, 'clínica dental');
});

test('effective identity never selects first available or latest synced mapping; passive reads do not resolve URLs', async () => {
  const { competition } = services();
  let reads = 0;
  const dependencies = {
    Clinica: { async findByPk() { return clinic({ business_primary_category: undefined, business_place_id: undefined }); } },
    ClinicBusinessLocation: { async findOne({ where }) {
      reads++; assert.deepEqual(where, { id: 91, is_active: true });
      return { id: 91, location_id: 'locations/right', location_name: 'Correct fixture', raw_payload: {} };
    } },
    resolveEffectiveMarketingAssetInventory: async () => ({ google: {
      available_assets: { business_profile: [{ mapping_id: 90 }, { mapping_id: 91 }] },
    } }),
  };
  const withoutEffective = await competition.resolvePrimaryClinic(scope, dependencies);
  assert.equal(reads, 0);
  assert.equal(withoutEffective.business_location_mapping_id, null);
  dependencies.resolveEffectiveMarketingAssetInventory = async () => ({ google: { effective_assets: { business_profile: { mapping_id: 91 } } } });
  const effective = await competition.resolvePrimaryClinic(scope, dependencies);
  assert.equal(reads, 1);
  assert.equal(effective.business_location_name, 'Correct fixture');
});

test('IA GET creates only visible query, retains four options, reuses seven days and separates areas and clinics', async () => {
  const { ai } = services();
  const f = aiFixtures(ai);
  const first = await ai.getOverview(72, { autoStart: true }, f.dependencies);
  assert.equal(first.selected_query_key, 'best_local');
  assert.equal(first.typical_queries.length, 4);
  assert.equal(first.automatic.queued, 1);
  assert.equal(f.jobs.length, 1);
  assert.equal(first.clinic.category, 'clínica de medicina estética');
  assert.equal(first.runs.length, 1);
  assert.equal(f.jobs[0].payload.medicalArea, 'estetica');
  await f.rows[0].update({ status: 'completed', created_at: new Date(Date.now() - 6 * DAY_MS) });
  const repeat = await ai.getOverview(72, { autoStart: true }, f.dependencies);
  assert.equal(repeat.automatic.reused, 1);
  assert.equal(f.jobs.length, 1);
  const surgery = await ai.getOverview(72, { autoStart: true, medicalArea: 'cirugia_estetica' }, f.dependencies);
  assert.equal(surgery.clinic.category, 'clínica de cirugía estética');
  assert.equal(f.jobs.length, 2);
  assert.equal(surgery.runs.length, 1);
  assert.notEqual(f.rows[0].query_hash, f.rows[1].query_hash);
  await ai.getOverview(72, { autoStart: true, medicalArea: 'cirugia_estetica', queryKey: 'trusted_reviews' }, f.dependencies);
  assert.equal(f.jobs.length, 3);
  assert.equal(f.rows[2].query.includes('buenas reseñas'), true);
  f.setClinic(clinic({ id_clinica: 73 }));
  await ai.getOverview(73, { autoStart: true, medicalArea: 'cirugia_estetica', queryKey: 'trusted_reviews' }, f.dependencies);
  assert.equal(f.jobs.length, 4);
  assert.equal(f.rows[3].clinica_id, 73);
  assert.notEqual(f.rows[2].query_hash, f.rows[3].query_hash);
});

test('all four queries can be selected lazily per area, without consuming the other area quota', async () => {
  const { ai } = services(); const f = aiFixtures(ai);
  for (const medicalArea of ['estetica', 'cirugia_estetica']) {
    for (const queryKey of ['best_local', 'category_options', 'recommended_local', 'trusted_reviews']) {
      const result = await ai.getOverview(72, { autoStart: true, medicalArea, queryKey }, f.dependencies);
      assert.equal(result.automatic.queued, 1);
      assert.equal(result.automatic.errors.length, 0);
    }
  }
  assert.equal(f.jobs.length, 8);
  const repeat = await ai.getOverview(72, { autoStart: true, medicalArea: 'estetica', queryKey: 'category_options' }, f.dependencies);
  assert.equal(repeat.automatic.reused, 1);
  assert.equal(f.jobs.length, 8);
});

test('IA invalid/unassigned selections never read runs or enqueue; polling is read-only and area scoped', async () => {
  const { ai } = services(); const f = aiFixtures(ai);
  await assert.rejects(ai.getOverview(72, { autoStart: true, medicalArea: 'dental' }, f.dependencies), { status: 403 });
  await assert.rejects(ai.getOverview(72, { autoStart: true, queryKey: 'free_text' }, f.dependencies), { code: 'AI_VISIBILITY_QUERY_KEY_INVALID' });
  assert.equal(f.rows.length, 0);
  await ai.getOverview(72, { autoStart: true, medicalArea: 'capilar' }, f.dependencies);
  const polled = await ai.getRun(1, 72, { ...f.dependencies, medicalArea: 'capilar' });
  assert.equal(polled.selected_medical_area.code, 'capilar');
  await assert.rejects(ai.getRun(1, 72, { ...f.dependencies, medicalArea: 'estetica' }), { status: 404 });
  assert.equal(f.jobs.length, 1);
  await ai.getOverview(72, {}, f.dependencies);
  assert.equal(f.jobs.length, 1);
});

test('worker revalidates assigned area and identity before either provider; valid run retains its area', async () => {
  const { ai } = services(); const f = aiFixtures(ai);
  let providerCalls = 0;
  const provider = async ({ clinic: context }) => {
    providerCalls++; assert.equal(context.selected_medical_area.code, 'cirugia_estetica');
    return { status: 'completed', provider: 'fixture', text: 'Fixture only' };
  };
  await ai.getOverview(72, { autoStart: true, medicalArea: 'cirugia_estetica' }, f.dependencies);
  await ai.executeRun(f.jobs[0].payload, { ...f.dependencies, runOpenAiSearch: provider, runGeminiSearch: provider });
  assert.equal(providerCalls, 2);
  assert.equal(f.rows[0].provider_results._context.selected_medical_area.code, 'cirugia_estetica');
  await ai.getOverview(72, { autoStart: true, medicalArea: 'capilar' }, f.dependencies);
  f.setClinic(clinic({ configuracion: { disciplinas: codes.filter(code => code !== 'capilar') } }));
  await assert.rejects(ai.executeRun(f.jobs[1].payload, { ...f.dependencies, runOpenAiSearch: provider, runGeminiSearch: provider }), { code: 'MEDICAL_AREA_NOT_ASSIGNED' });
  assert.equal(providerCalls, 2);
  f.setClinic(clinic());
  await ai.getOverview(72, { autoStart: true, queryKey: 'trusted_reviews' }, f.dependencies);
  f.setClinic(clinic({ business_place_id: 'ChIJ-other' }));
  await assert.rejects(ai.executeRun(f.jobs[2].payload, { ...f.dependencies, runOpenAiSearch: provider, runGeminiSearch: provider }), { code: 'AI_VISIBILITY_CONTEXT_CHANGED' });
  assert.equal(providerCalls, 2);
});

test('Estado competition and saved included query share the selected area; metadata invalidates old generic cache', async () => {
  const { competition } = services(); let source = clinic();
  const deps = { resolvePrimaryClinic: async () => source, loadCompetitorRows: async () => [],
    hydrateCompetitors: async () => [], providerStatusForScope: async () => ({}), loadOwnProfileReviewSummary: async () => ({}) };
  const medicine = await competition.__testing.listCompetitionWithDependencies(scope, {}, deps);
  assert.equal(medicine.own_profile.category, 'clínica de medicina estética');
  assert.equal(medicine.own_profile.business_category, 'Clínica capilar');
  assert.deepEqual(medicine.ranking_terms, ['medicina estética en Alicante']);
  const surgery = await competition.__testing.listCompetitionWithDependencies(scope, { medicalArea: 'cirugia_estetica' }, deps);
  assert.equal(surgery.selected_medical_area.code, 'cirugia_estetica');
  assert.deepEqual(surgery.ranking_terms, ['cirugía estética en Alicante']);
  assert.equal(competition.__testing.defaultLocalHeatmapTermForClinic(withMedicalArea(source, 'cirugia_estetica')), 'cirugía estética cerca de mí');
  source = clinic({ configuracion: { disciplinas: ['nutricion', ...codes.filter(code => code !== 'nutricion')] } });
  const changedDefault = await competition.__testing.listCompetitionWithDependencies(scope, {}, deps);
  assert.equal(changedDefault.selected_medical_area.code, 'nutricion');
  source = clinic({ configuracion: { disciplinas: ['estetica'] } });
  await assert.rejects(competition.__testing.listCompetitionWithDependencies(scope, { medicalArea: 'cirugia_estetica' }, deps), { status: 403 });
});

test('cached heatmap miss/expired expose refresh capability without writes; active lease/fresh stay unavailable', async () => {
  const { competition } = services({ models: { MarketingCompetitionHeatmapSnapshot: { findOne: async () => null } } });
  const now = new Date(); let stored = null; let reads = 0;
  const model = { async findOne() { reads++; return stored; }, update: forbidden('cache update'), findOrCreate: forbidden('cache create') };
  const cache = createHeatmapCacheCoordinator({ model, scheduleRefresh: forbidden('enqueue'), now: () => now });
  const identities = [];
  const deps = { resolvePrimaryClinic: async () => clinic(), persistentHeatmapCache: { async peek(identity) { identities.push(identity); return cache.peek(identity); } } };
  const options = { cachedOnly: true, medicalArea: 'estetica', term: 'consulta local', zoomKm: 1 };
  const miss = await competition.getLocalRankingHeatmap(scope, options, deps);
  assert.equal(miss.cache.status, 'miss'); assert.equal(miss.cache.refresh_available, true);
  stored = { payload: { success: true, points: Array.from({ length: 25 }, (_, i) => ({ my_position: i + 1 })) },
    generated_at: new Date(now - 20 * DAY_MS), fresh_until: new Date(now - 13 * DAY_MS), expires_at: new Date(now - 6 * DAY_MS),
    refresh_state: 'idle' };
  const expired = await competition.getLocalRankingHeatmap(scope, options, deps);
  assert.equal(expired.points.length, 25); assert.equal(expired.cache.status, 'expired'); assert.equal(expired.cache.refresh_available, true);
  stored.refresh_state = 'refreshing'; stored.refresh_locked_until = new Date(+now + 60000);
  const leased = await competition.getLocalRankingHeatmap(scope, options, deps);
  assert.equal(leased.cache.refresh_in_progress, true); assert.equal(leased.cache.refresh_available, false);
  stored.refresh_locked_until = new Date(+now - 1);
  const expiredLease = await competition.getLocalRankingHeatmap(scope, options, deps);
  assert.equal(expiredLease.cache.refresh_available, true);
  stored.fresh_until = new Date(+now + DAY_MS); stored.expires_at = new Date(+now + 8 * DAY_MS);
  const fresh = await competition.getLocalRankingHeatmap(scope, options, deps);
  assert.equal(fresh.cache.refresh_available, false);
  await competition.getLocalRankingHeatmap(scope, { ...options, medicalArea: 'cirugia_estetica' }, deps);
  assert.notEqual(identities[0].cache_key, identities.at(-1).cache_key, 'same text must not share cache across areas');
  await competition.getLocalRankingHeatmap(scope, options, { ...deps, resolvePrimaryClinic: async () => clinic({ business_place_id: 'ChIJ-changed' }) });
  assert.notEqual(identities[0].cache_key, identities.at(-1).cache_key);
  assert.equal(reads, 7);
});

test('cached heatmap gates/setup and assignment are checked before even peeking', async () => {
  const deps = { resolvePrimaryClinic: async () => clinic(), persistentHeatmapCache: { peek: forbidden('blocked peek') } };
  const blocked = services({ env: { COMPETITION_LOCAL_RANKING_STORAGE_ALLOWED: 'false' } }).competition;
  const response = await blocked.getLocalRankingHeatmap(scope, { cachedOnly: true }, deps);
  assert.equal(response.setup_code, 'LOCAL_RANKING_PROVIDER_REQUIRED'); assert.equal(response.cache.refresh_available, false);
  const { competition } = services();
  const missing = await competition.getLocalRankingHeatmap(scope, { cachedOnly: true }, {
    ...deps, resolvePrimaryClinic: async () => clinic({ business_place_id: null, business_location_id: null, business_location_name: null }),
  });
  assert.equal(missing.setup_required, true); assert.equal(missing.cache.refresh_available, false);
  await assert.rejects(competition.getLocalRankingHeatmap(scope, { cachedOnly: true, medicalArea: 'dental' }, deps), { code: 'MEDICAL_AREA_NOT_ASSIGNED' });
});

test('reordering or adding assignments does not bypass selected-area weekly cache', () => {
  const original = medicalContextKey(withMedicalArea(clinic(), 'estetica'));
  const reordered = medicalContextKey(withMedicalArea(clinic({ configuracion: { disciplinas: [...codes].reverse() } }), 'estetica'));
  assert.equal(original, reordered);
});

test('old heatmap identity remains stored and cannot be returned as current area measurement', async () => {
  const { competition } = services();
  const historical = { cache_key: 'historical-without-medical-area', payload: { success: true, points: [{ my_position: 9 }] } };
  const stored = new Map([[historical.cache_key, historical]]);
  const cache = createHeatmapCacheCoordinator({
    model: { async findOne({ where }) { return stored.get(where.cache_key) || null; },
      update: forbidden('historical update'), findOrCreate: forbidden('historical create') },
    scheduleRefresh: forbidden('historical refresh'),
  });
  const result = await competition.getLocalRankingHeatmap(scope, { cachedOnly: true, medicalArea: 'estetica' }, {
    resolvePrimaryClinic: async () => clinic(), persistentHeatmapCache: cache,
  });
  assert.equal(result.cache.status, 'miss');
  assert.equal(result.cache.refresh_available, true);
  assert.deepEqual(result.points, []);
  assert.equal(stored.size, 1);
  assert.strictEqual(stored.get(historical.cache_key), historical);
});

test('queued heatmap rejects removed area or changed identity before lease claim or provider calls', async () => {
  const { competition } = services(); let releases = 0;
  const cache = { async release() { releases++; }, claimForRefresh: forbidden('invalid context claim'), find: forbidden('invalid context cache read') };
  const payload = { scope, cacheKey: 'old-identity', refreshToken: 'fixture-lease', selectedTerm: 'cirugía estética', medicalArea: 'cirugia_estetica' };
  const removed = await competition.executeLocalRankingHeatmapRefresh(payload, {
    resolvePrimaryClinic: async () => clinic({ configuracion: { disciplinas: ['estetica'] } }), persistentHeatmapCache: cache,
  });
  assert.equal(removed.retryable, false);
  assert.equal(removed.error_message, 'MEDICAL_AREA_NOT_ASSIGNED');
  const changed = await competition.executeLocalRankingHeatmapRefresh(payload, {
    resolvePrimaryClinic: async () => clinic({ business_place_id: 'ChIJ-new-identity' }), persistentHeatmapCache: cache,
  });
  assert.equal(changed.retryable, false);
  assert.equal(releases, 2);
});

test('HTTP controllers propagate medical_area/query_key after ACL and keep polling passive', async () => {
  const calls = [];
  const scopeStub = { resolveClinicScope: async () => ({ ...scope, isValid: true }) };
  const accessStub = { hasMarketingClinicScopeAccess: async () => true };
  const aiStub = {
    async getOverview(id, options) { calls.push(['overview', id, options]); return { success: true }; },
    async getRun(id, clinicId, options) { calls.push(['poll', clinicId, options]); return { id }; },
    async enqueueTypicalRun(options) { calls.push(['post', options.clinicId, options]); return { reused: false }; },
  };
  const localStub = {
    async getLocalRankingHeatmap(scope, options) { calls.push(['heatmap', scope.clinicIds[0], options]); return { success: true }; },
  };
  const h = harness({ mocks: {
    '../lib/clinicScope': scopeStub, '../lib/marketingScopeAccess': accessStub,
    '../lib/role-helpers': { isGlobalAdmin: () => false },
    '../services/marketingAiVisibility.service': aiStub,
    '../services/marketingCompetition.service': localStub,
    '../services/jobRequests.service': {}, '../services/jobScheduler.service': {},
  } });
  const aiController = h.load('controllers/marketingAiVisibility.controller.js');
  const localController = h.load('controllers/marketingCompetition.controller.js');
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  const req = { query: { clinicId: '72', medical_area: 'cirugia_estetica', query_key: 'trusted_reviews', cached_only: 'true' }, body: {}, params: { runId: '8' }, userData: { userId: 9 } };
  await aiController.getOverview(req, res);
  await aiController.getRun(req, res);
  await aiController.createRun({ ...req, body: { medical_area: 'cirugia_estetica', query_key: 'recommended_local' } }, res);
  await localController.getLocalHeatmap(req, res);
  assert.deepEqual(calls.map(call => call[2].medicalArea), Array(4).fill('cirugia_estetica'));
  assert.equal(calls[0][2].queryKey, 'trusted_reviews');
  assert.equal(calls[0][2].autoStart, true);
  assert.equal(calls[1][2].autoStart, undefined);
  assert.equal(calls[2][2].queryKey, 'recommended_local');
  assert.equal(calls[3][2].cachedOnly, true);
  accessStub.hasMarketingClinicScopeAccess = async () => false;
  // Controller captures the imported access function, so test a new isolated instance.
  const denied = harness({ mocks: {
    '../lib/clinicScope': scopeStub, '../lib/marketingScopeAccess': accessStub,
    '../lib/role-helpers': { isGlobalAdmin: () => false }, '../services/marketingAiVisibility.service': aiStub,
  } }).load('controllers/marketingAiVisibility.controller.js');
  await denied.getOverview(req, res);
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 4);
});
