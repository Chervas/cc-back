'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const sequelize = require('sequelize');
const { prepareValidatedReportSnapshot, digest } = require('../../lib/validated-report-snapshot');
const sourceReads = require('../../lib/searchConsoleReadSource');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');
const { createSearchConsoleAnalytics } = require('../../services/searchConsoleAnalytics.service');
const C = require('../../lib/searchConsoleAnalyticsContract');

const site = 'https://example.invalid/';

test('Google global-rating observations never count as profile traffic or make provisional performance available', async () => {
  const definitions = { views: { preferred: ['BUSINESS_IMPRESSIONS_TOTAL'], fallback: [] } };
  const rating = { business_location_id: 71, date: '2026-11-02', metric_type: 'GOOGLE_REVIEW_RATING', value: 4900000 };
  let reads = 0;
  const controller = loadDiscoverySource('controllers/marketingReports.controller.js', {
    sequelize,
    '../../models': {
      Sequelize: sequelize,
      ClinicBusinessLocation: { findOne: async () => ({ id: 71 }), count: async () => 1 },
      BusinessProfileReview: { findOne: async () => ({}), count: async () => 0 },
      BusinessProfileDailyMetric: { findAll: async ({ where }) => {
        reads++;
        assert.ok(where.metric_type[sequelize.Op.in].includes('BUSINESS_IMPRESSIONS_TOTAL'));
        return where.metric_type[sequelize.Op.in].includes(rating.metric_type) ? [rating] : [];
      } },
    },
    '../services/businessProfileLocal.service': { METRIC_DEFINITIONS: definitions,
      collapseMetricRows: rows => rows, metricValueByDate: () => [] },
  });
  const result = await controller.__testing.aggregateBusinessProfile({ scope: 'clinic', clinicIds: [71] },
    { startLabel: '2026-11-01', endLabel: '2026-11-02', start: new Date('2026-11-01'), endExclusive: new Date('2026-11-03') });
  assert.equal(reads, 1);
  assert.equal(result.metrics.performanceStatus, 'empty');
  assert.equal(result.metrics.latestPerformanceDate, null);
  assert.equal(result.metrics.views, 0);
});


test('GBP replacement never relabels old clinic metrics as observations from the new effective location', async () => {
  const old = { business_location_id: 51, clinica_id: 71, date: '2026-11-02', metric_type: 'BUSINESS_IMPRESSIONS_TOTAL', value: 12345 };
  const definitions = { profile_views: { preferred: ['BUSINESS_IMPRESSIONS_TOTAL'], fallback: [] } };
  let reads=0;
  const controller = loadDiscoverySource('controllers/marketingReports.controller.js', {
    sequelize, '../../models': { Sequelize: sequelize,
      ClinicBusinessLocation: { findOne: async ({where}) => {assert.equal(where.id,52);return {id:52};}, count: async () => 1 },
      BusinessProfileReview: { findOne: async ({where}) => {assert.equal(where.business_location_id,52);return {};}, count: async () => 0 },
      BusinessProfileDailyMetric: { findAll: async ({where}) => {reads++;assert.equal(where.business_location_id,52);assert.equal(where[sequelize.Op.or],undefined);return Number(where.business_location_id)===old.business_location_id?[old]:[];} },
    }, '../services/businessProfileLocal.service': { METRIC_DEFINITIONS: definitions, collapseMetricRows: rows => rows, metricValueByDate: rows => rows.map(row=>({value:row.value})) },
  });
  const scope={scope:'clinic',clinicIds:[71]};
  const interval={startLabel:'2026-11-01',endLabel:'2026-11-02',start:new Date('2026-11-01'),endExclusive:new Date('2026-11-03')};
  const state={google:{available_assets:{business_profile:[{mapping_id:52}]}}};
  const result=await controller.__testing.aggregateBusinessProfile(scope,interval,state);
  assert.equal(result.connected,true);assert.equal(result.metrics.views,0);assert.equal(result.metrics.performanceStatus,'empty');assert.equal(result.metrics.latestPerformanceDate,null);assert.equal(reads,1);
  const empty=await controller.__testing.aggregateBusinessProfile(scope,interval,{google:{available_assets:{business_profile:[]}}});
  assert.equal(empty.connected,false);assert.equal(empty.metrics.performanceStatus,'empty');assert.equal(reads,1);
});

const range = { startLabel: '2026-10-01', endLabel: '2026-10-30', previous: { startLabel: '2026-09-01', endLabel: '2026-09-30' } };
const cacheModule = () => loadDiscoverySource('services/marketingReportOverviewCache.service.js', {
  crypto: require('node:crypto'), sequelize, '../../models': {}, './jobRequests.service': {},
}, { env: { SC_ANALYTICS_READ_ENABLED: 'true' } });

test('restart/navigation reuses committed snapshot; source revision, clinic, period and binding changes cannot reuse it', async () => {
  const rows = new Map(); let generations = 0, revision = '1', clinicId = 71, connectionId = 81;
  const api = cacheModule();
  const prepare = () => prepareValidatedReportSnapshot({
    capture: async () => ({ revision, connectionId, site }),
    buildIdentity: contextKey => api.buildOverviewCacheIdentity({ scope: { scope: 'clinic', clinicIds: [clinicId] }, range, contextKey }),
    generate: async () => ({ generation: ++generations }),
    cache: { readOrGenerate: async ({ identity, generate, forceRefresh }) => {
      if (!rows.has(identity.cache_key) || forceRefresh) rows.set(identity.cache_key, await generate());
      return rows.get(identity.cache_key);
    } },
  });
  assert.equal((await (await prepare()).read()).generation, 1);
  assert.equal((await (await prepare()).read()).generation, 1);
  revision = '2'; assert.equal((await (await prepare()).read()).generation, 2);
  connectionId = 82; assert.equal((await (await prepare()).read()).generation, 3);
  clinicId = 72; assert.equal((await (await prepare()).read()).generation, 4);
  assert.equal((await (await prepare()).read({ forceRefresh: true })).generation, 5);
});

test('mapping/coverage revision race blocks persistence and cache-hit disclosure', async () => {
  for (const hit of [false, true]) {
    let revision = '1', persisted = false;
    const p = await prepareValidatedReportSnapshot({ capture: async () => ({ revision }), buildIdentity: key => ({ cache_key: key }),
      generate: async () => { revision = '2'; return { clicks: 10 }; },
      cache: { readOrGenerate: async ({ generate }) => {
        if (hit) { revision = '2'; return { clicks: 10 }; }
        const data = await generate(); persisted = true; return data;
      } },
    });
    await assert.rejects(p.read(), { code: 'sc_analytics_configuration_changed' });
    assert.equal(persisted, false);
  }
});

test('canonical revision identity is stable across row order and changes on sync timestamps', () => {
  assert.equal(digest({ a: [2, 1], b: null }), digest({ b: null, a: [1, 2] }));
  assert.notEqual(digest({ updated: new Date('2026-10-01') }), digest({ updated: new Date('2026-10-02') }));
});

function routeFixture() {
  const f = { allowed: true, session: true, assigned: true, revision: '1', reads: 0 };
  const inventory = async () => ({ scope: { clinic_ids: [71] }, google: { available_assets: { search_console: f.assigned
    ? [{ mapping_id: 1, clinic_id: 71, connection_id: 81, site_url: site }] : [] } } });
  const identity = cacheModule().buildOverviewCacheIdentity;
  const controller = loadDiscoverySource('controllers/marketingReports.controller.js', {
    sequelize, '../../models': { Sequelize: sequelize }, '../lib/searchConsoleReadSource': sourceReads,
    '../lib/validated-report-snapshot': { prepareValidatedReportSnapshot },
    '../lib/clinicScope': { resolveClinicScope: async () => ({ isValid: true, scope: 'clinic', clinicIds: [71] }) },
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async () => f.allowed },
    '../lib/role-helpers': { isGlobalAdmin: () => false },
    '../services/effectiveMarketingAssets.service': { resolveEffectiveMarketingAssetInventory: inventory },
    '../services/searchConsoleBroker.service': { prepare: async () => { if (f.revoked) throw Error('revoked'); } },
    '../services/searchConsoleAnalytics.service': { readRevisions: async () => [{ siteUrl: site, revision: f.revision }] },
    '../services/accessSession.service': { bearer: value => value, verify: async () => f.session ? { userId: 501, jti: 'offline-session', sessionVersion: 1 } : null },
    '../services/marketingReportOverviewCache.service': { buildOverviewCacheIdentity: identity,
      overviewCache: { readOrGenerate: async () => { f.reads++; await f.afterRead?.(); return { success: true, marker: 'cached' }; } } },
  }, { env: { SC_ANALYTICS_READ_ENABLED: 'true' } });
  f.request = async () => {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
    await controller.getOverview({ query: { clinicId: '71', startDate: range.startLabel, endDate: range.endLabel },
      userData: { userId: 501 }, headers: { authorization: 'OFFLINE_ONLY' } }, res);
    return res;
  };
  return f;
}

test('real overview handler serves cache only with live session, permissions, bindings and broker authority', async () => {
  const good = routeFixture(); const response = await good.request();
  assert.equal(response.statusCode, 200); assert.equal(response.body.marker, 'cached'); assert.equal(good.reads, 1);
  for (const [key, value, status] of [['allowed', false, 403], ['session', false, 401], ['revoked', true, 403]]) {
    const f = routeFixture(); f[key] = value; const r = await f.request();
    assert.equal(r.statusCode, status, key); assert.equal(f.reads, 0); assert.equal(r.body.marker, undefined);
  }
  for (const [key, value, status] of [['allowed', false, 403], ['session', false, 401], ['revoked', true, 403], ['assigned', false, 409], ['revision', '2', 409]]) {
    const f = routeFixture(); f.afterRead = () => { f[key] = value; }; const r = await f.request();
    assert.equal(r.statusCode, status, key); assert.equal(r.body.marker, undefined);
  }
});

test('metadata revisions are read-only, scoped, deduplicated and distinguish missing properties', async () => {
  const rows = [{ id: 1, site_url: site, site_hash: C.property(site).siteHash.toUpperCase(), revision: '17' }]; let calls = 0;
  const repo = createSearchConsoleAnalytics({ env: { SC_ANALYTICS_READ_ENABLED: 'true' }, sequelize: { transaction: () => assert.fail('Revision reads cannot start a write transaction'), query: async (sql, options) => {
    calls++; assert.match(sql, /^SELECT .* FROM ScAnalyticsProperties WHERE site_hash IN/);
    assert.equal(options.logging, false); assert.equal(Object.keys(options.replacements).length, 2);
    return [rows, {}];
  } } });
  assert.deepEqual(await repo.readRevisions({ siteUrls: [] }), []); assert.equal(calls, 0);
  const result = await repo.readRevisions({ siteUrls: [site, site, 'https://missing.invalid/'] });
  assert.equal(result.length, 2); assert.equal(result[0].revision, '17'); assert.equal(result[1].revision, null);
  rows[0].site_url = 'https://wrong.invalid/';
  await assert.rejects(repo.readRevisions({ siteUrls: [site, 'https://missing.invalid/'] }), { code: 'sc_analytics_hash_collision' });
  await assert.rejects(repo.readRevisions({ siteUrls: Array(201).fill(site) }), { code: 'sc_analytics_invalid_scope' });
});

test('persisted normalized clinic/group scope is restored for workers without widening it to all', () => {
  const api = cacheModule();
  for (const scope of [{ scope: 'clinic', clinicIds: [71] }, { scope: 'group', clinicIds: [71, 72], groupId: 9 }]) {
    const id = api.buildOverviewCacheIdentity({ scope, range, contextKey: 'fictitious-context' });
    const restored = api.__testing.scopeFromCacheIdentity(id);
    assert.equal(restored.scope, scope.scope); assert.deepEqual(Array.from(restored.clinicIds), scope.clinicIds);
    assert.equal(restored.isAll, false);
    assert.equal(api.buildOverviewCacheIdentity({ scope: restored, range, contextKey: 'fictitious-context' }).cache_key, id.cache_key);
  }
});
