'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const sequelize = require('sequelize');
const { authorizedSiteUrls, propertySource } = require('../../lib/searchConsoleReadSource');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');
const sourceHelpers = require('../../lib/searchConsoleReadSource');

const site = 'https://example.invalid/';
const state = { google: { available_assets: { search_console: [71, 72, 73, 74]
  .map(clinic_id => ({ mapping_id: clinic_id, clinic_id, connection_id: 81, site_url: site })) } } };
const range = { startLabel: '2026-10-01', endLabel: '2026-10-18', previous: { startLabel: '2026-09-13', endLabel: '2026-09-30' } };

test('clinic/group effective assignments deduplicate webs without loading or granting other clinics', async () => {
  const deny = async () => assert.fail('Non-global reads cannot list global mappings');
  for (const scope of [{ scope: 'clinic', clinicIds: [71] }, { scope: 'group', clinicIds: [71, 72, 73, 74] }]) {
    assert.deepEqual(await authorizedSiteUrls(scope, state, deny), [site]);
    assert.deepEqual(await authorizedSiteUrls(scope, null, deny), []);
  }
  let activeOnly = 0;
  assert.deepEqual(await authorizedSiteUrls({ isAll: true }, null, async () => {
    activeOnly++; return [site, site].map(siteUrl => ({ siteUrl }));
  }), [site]);
  assert.equal(activeOnly, 1);
});

test('empty effective scope is an empty SQL source, never an unrestricted property read', async () => {
  const source = await propertySource({ storage: { rawSource: () => assert.fail('empty scope must not read all properties') },
    siteUrls: [], range, replacements: {}, prefix: 'empty' });
  assert.match(source.sqlFrom, /WHERE FALSE/); assert.equal(source.resolution, 'empty_authorized_scope');
});

function reportFixture(enabled, zeroPositions = false) {
  const calls = [], sql = []; const auth = { active: true, validations: 0 };
  const models = { Sequelize: sequelize, WebScDaily: { findAll: () => assert.fail('Property reads must not sum legacy copies') },
    WebScQueryDaily: {}, ClinicWebAsset: { findAll: async options => {
      assert.equal(options.where.isActive, true); return [site, site].map(siteUrl => ({ siteUrl }));
    } }, sequelize: { query: async query => {
      sql.push(query); await auth.afterSQL?.();
      if (query.includes('FAKE_TOTALS')) return [{ clicks: zeroPositions ? 0 : 10, impressions: zeroPositions ? 0 : 100,
        position: zeroPositions ? (query.includes('SUM(position_sum)/SUM(position_count)') ? 20 / 4 : 16 / 3) : 2, lastDate: '2026-10-18' }];
      if (query.includes('FAKE_RANKS')) return [{ date: '2026-10-18', top3: 1, top10: 1 }];
      if (query.includes(' AS value')) return [{ value: query.includes('page_url') ? 'https://example.invalid/page' : 'fictitious query', clicks: 3, impressions: 10, position: 2 }];
      if (query.includes(' AS query,')) return [{ query: 'fictitious query', page: 'https://example.invalid/page', clicks: 3, impressions: 10, position: 2 }];
      if (query.includes(' AS page,')) return [{ page: 'https://example.invalid/page', clicks: 3, impressions: 10, position: 2 }];
      return [{ date: '2026-10-18', query: 'fictitious query', clicks: 3, impressions: 10, position: 2 }];
    } } };
  const storage = { rawSource: async request => {
    calls.push(request); assert.deepEqual(Array.from(request.siteUrls), [site]);
    return { sqlFrom: request.totals ? 'FAKE_TOTALS' : request.ranking ? 'FAKE_RANKS' : 'FAKE_DETAIL',
      scopeSql: '', resolution: 'daily_or_complete_month', validate: async () => {
        auth.validations++;
        if (auth.monthPublished) throw Object.assign(Error('sc_analytics_monthly_partial_range'), { code: 'sc_analytics_monthly_partial_range' });
      } };
  } };
  const controller = loadDiscoverySource('controllers/marketingReports.controller.js', {
    sequelize, '../../models': models, '../lib/searchConsoleReadSource': sourceHelpers,
    '../services/searchConsoleAnalytics.service': storage,
    '../services/searchConsoleBroker.service': { prepare: async () => { if (!auth.active) throw Error('REVOKED'); return null; } },
    '../services/marketingReportOverviewCache.service': { overviewCache: null },
  }, { env: { SC_ANALYTICS_READ_ENABLED: enabled ? 'true' : 'false' } });
  return { api: controller.__testing, calls, sql, storage, auth };
}

test('actual report SQL switches detail, ranking and authoritative totals together; four mappings count one web', async () => {
  const f = reportFixture(true);
  const result = await f.api.aggregateSeo({ scope: 'group', clinicIds: [71, 72, 73, 74] }, range, state);
  assert.equal(result.summary.clicks, 10); // authoritative total, not the three visible query clicks
  assert.equal(result.dailyAggregates.top3, 1); assert.equal(result.dailyAggregates.top10, 1);
  assert(f.calls.some(call => call.totals)); assert(f.calls.some(call => call.ranking));
  assert(f.sql.every(query => !query.includes('FROM WebSc')));
  assert.equal(result.queries[0].clicks, 3); assert.equal(result.dataResolution, 'daily_or_complete_month');
});

test('legacy report source remains selected with the default gate, and new-source failures cannot fall back or double count', async () => {
  const legacy = reportFixture(false);
  const source = await legacy.api.searchConsoleReportSource({ scope: 'clinic', clinicIds: [71] }, state, range, {}, 'legacy');
  assert.equal(source.sqlFrom, 'WebScQueryDaily'); assert.equal(legacy.calls.length, 0);
  const enabled = reportFixture(true); enabled.storage.rawSource = async () => { throw Error('sc_analytics_monthly_partial_range'); };
  await assert.rejects(enabled.api.aggregateSeo({ scope: 'group', clinicIds: [71, 72] }, range, state), /monthly_partial_range/);
  assert.equal(enabled.sql.length, 0);
});

function routeFixture() {
  const f = { allowed: true, assigned: true, session: true, calls: [], sql: [], handlers: new Map(), guardChecks: 0 };
  const router = { use() {}, get(path, handler) { f.handlers.set(path, handler); }, post() {} };
  const inventory = async () => ({ google: { available_assets: { search_console: f.assigned
    ? state.google.available_assets.search_console.map(row => ({ ...row, connection_id: 81 })) : [] } } });
  const storage = { rawSource: async request => {
    f.calls.push(request); assert.deepEqual(Array.from(request.siteUrls), [site]);
    return { sqlFrom: request.totals ? 'FAKE_TOTALS' : request.ranking ? 'FAKE_RANKS' : 'FAKE_DETAIL',
      scopeSql: '', resolution: 'daily_or_complete_month', validate: async () => {
        f.guardChecks++; if (f.guardFailure) throw Object.assign(Error(f.guardFailure), { code: f.guardFailure });
      } };
  } };
  f.storage = storage;
  const models = { Sequelize: sequelize, sequelize: { query: async query => {
    f.sql.push(query); await f.afterRead?.();
    if (query.includes('FAKE_TOTALS')) return [{ date: '2026-10-18', clicks: 10, impressions: 100 }];
    if (query.includes('FAKE_RANKS')) return [{ date: '2026-10-18', queries_top3: 1, queries_top10: 1 }];
    return query.includes('query IN') ? [{ query: 'fictitious query', page_url: site + 'page', clicks: 3, impressions: 10, position: 2 }]
      : [{ query: 'fictitious query', clicks: 3, impressions: 10, position: 2 }];
  } } };
  loadDiscoverySource('routes/web.routes.js', {
    express: { Router: () => router }, '../../models': models, './auth.middleware': () => {}, sequelize,
    '../lib/searchConsoleReadSource': sourceHelpers, '../services/searchConsoleAnalytics.service': storage,
    '../services/googleLegacyCredentials.service': { safe: () => 'google_credentials_unavailable' },
    '../services/searchConsoleBroker.service': { prepare: async () => null },
    '../services/accessSession.service': { bearer: token => token, verify: async () => f.session
      ? { userId: 501, sessionVersion: 1, jti: 'fictitious-session-reference' } : null },
    '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async () => f.allowed },
    '../services/effectiveMarketingAssets.service': { resolveEffectiveMarketingAssetInventory: inventory },
  }, { env: { SC_ANALYTICS_READ_ENABLED: 'true' } });
  f.request = async (path = '/clinica/:clinicaId/sc/queries') => {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await f.handlers.get(path)({ params: { clinicaId: '72' }, query: { startDate: range.startLabel, endDate: range.endLabel },
      headers: { authorization: 'FICTITIOUS_OFFLINE_SESSION' }, webClinicId: 72, webClinicUserId: 501, method: 'GET' }, response);
    return response;
  };
  return f;
}

test('actual cached-query route deduplicates assigned sites, preserves the public DTO and revalidates before disclosure', async () => {
  const f = routeFixture(), result = await f.request();
  assert.equal(result.statusCode, 200); assert.equal(result.body.items[0].clicks, 3);
  assert.equal(result.body.items[0].pages[0].url, site + 'page');
  assert.equal(f.calls.length, 1); assert.equal(f.sql.length, 2);
  assert(f.sql.every(query => query.includes('FAKE_DETAIL') && !query.includes('clinica_id =')));
  const revoked = routeFixture(); revoked.afterRead = () => { revoked.allowed = false; };
  const denied = await revoked.request(); assert.equal(denied.statusCode, 403); assert.equal(denied.body.items, undefined);
  const lost = routeFixture(); lost.afterRead = () => { lost.assigned = false; };
  assert.equal((await lost.request()).statusCode, 403);
});

test('cached SEO summary reads authoritative totals and rankings for one property despite four mappings', async () => {
  const f = routeFixture();
  const result = await f.request('/clinica/:clinicaId/seo/summary');
  assert.equal(result.statusCode, 200); assert.equal(result.body.kpis.clicks, 10);
  assert.equal(result.body.kpis.top3, 1); assert.equal(result.body.kpis.top10, 1);
  assert.equal(f.calls.length, 4);
});

test('cached-query route rejects a missing modern session before reading property rows', async () => {
  const f = routeFixture(); f.session = false;
  const result = await f.request(); assert.equal(result.statusCode, 401); assert.equal(f.sql.length, 0);
});

test('overview cache identities separate legacy and property storage and revert to the exact legacy identity', () => {
  const load = enabled => loadDiscoverySource('services/marketingReportOverviewCache.service.js', {
    crypto: require('node:crypto'), sequelize, '../../models': {}, '../services/jobRequests.service': {},
  }, { env: { SC_ANALYTICS_READ_ENABLED: enabled ? 'true' : 'false' } });
  const input = { scope: { scope: 'clinic', clinicIds: [71] }, range };
  const before = load(false).buildOverviewCacheIdentity(input);
  const during = load(true).buildOverviewCacheIdentity(input);
  const after = load(false).buildOverviewCacheIdentity(input);
  assert.notEqual(before.cache_key, during.cache_key); assert.equal(before.cache_key, after.cache_key);
});


test('queued refreshes from the other storage source are skipped and release only their own lease', async () => {
  for (const enabled of [true, false]) {
    const released = [];
    const service = loadDiscoverySource('services/marketingReportOverviewCache.service.js', {
      crypto: require('node:crypto'), sequelize,
      '../../models': { MarketingReportOverviewCache: { update: async (_values, options) => { released.push(options.where); return [1]; } } },
      '../services/jobRequests.service': {},
    }, { env: { SC_ANALYTICS_READ_ENABLED: enabled ? 'true' : 'false' } });
    const stale = { cache_key: 'fictitious-key', report_version: enabled ? 'marketing-overview-v1' : 'marketing-overview-v1-sc-property-v1' };
    const result = await service.refreshOverviewSnapshots({ cacheKey: stale.cache_key, identity: stale,
      refreshToken: 'fictitious-owner', prune: false,
      buildRange: () => assert.fail('Source mismatch must not begin refresh'),
      buildOverviewPayload: () => assert.fail('Source mismatch must not generate the payload') });
    assert.equal(result.reason, 'cache_source_version_changed');
    assert.equal(released.length, 1); assert.equal(released[0].refresh_lock_token, 'fictitious-owner');
  }
});


test('zero-impression positions across two monthly aggregates and one daily row use sums and observation counts', async () => {
  // Monthly rows: 8/2 and 9/1; daily row:3/1. Their unweighted
  // average is5.333, but the four underlying observations average20/4=5.
  const f = reportFixture(true, true);
  const result = await f.api.aggregateSeo({ scope: 'group', clinicIds: [71, 72] }, range, state);
  assert.equal(result.summary.avgPosition, 5);
  assert(f.sql.filter(sql => sql.includes(' AS position')).every(sql => sql.includes('SUM(position_sum)/SUM(position_count)')));
});

test('report property reads fail closed on broker revocation and monthly publication after SQL', async () => {
  const revoked = reportFixture(true); revoked.auth.active = false;
  await assert.rejects(revoked.api.aggregateSeo({ scope: 'clinic', clinicIds: [71] }, range, state), error => error.status === 403);
  assert.equal(revoked.sql.length, 0);
  const published = reportFixture(true); published.auth.afterSQL = () => { published.auth.monthPublished = true; };
  await assert.rejects(published.api.aggregateSeo({ scope: 'clinic', clinicIds: [71] }, range, state), { code: 'sc_analytics_monthly_partial_range' });
  assert(published.auth.validations > 0);
});

test('current-scope reader rechecks canonical web assignments, broker revocation, permission and source gate before disclosure', async () => {
  const { readWithCurrentScope } = sourceHelpers;
  const stable = await readWithCurrentScope({ allowed: async () => true, capture: async () => [site, site], generate: async () => ({ clicks: 3 }) });
  assert.equal(stable.clicks, 3);
  let current = [site];
  await assert.rejects(readWithCurrentScope({ allowed: async () => true, capture: async () => current,
    generate: async () => { current = ['https://other.invalid/']; return {}; } }), error => error.status === 403);
  let active = true;
  const f = reportFixture(true);
  await assert.rejects(readWithCurrentScope({ allowed: async () => true,
    capture: () => f.api.currentSearchConsoleSiteUrls({ scope: 'clinic', clinicIds: [71] }, state),
    generate: async () => { f.auth.active = false; return {}; } }), error => error.status === 403);
  await assert.rejects(readWithCurrentScope({ allowed: async () => active, capture: async () => [site],
    generate: async () => { active = false; return {}; } }), error => error.status === 403);
  let enabled = true;
  await assert.rejects(readWithCurrentScope({ allowed: async () => true, capture: async () => [site], readEnabled: () => enabled,
    generate: async () => { enabled = false; return {}; } }), { code: 'sc_analytics_configuration_changed' });
});

test('cached routes retain structured coverage/granularity errors and check monthly guard plus session after SQL', async () => {
  for (const [code, expected] of [['sc_analytics_incomplete_coverage', 409], ['sc_analytics_monthly_partial_range', 422]]) {
    const f = routeFixture(); f.storage.rawSource = async () => { throw Object.assign(Error(code), { code }); };
    const result = await f.request(); assert.equal(result.statusCode, expected); assert.equal(result.body.code, code);
  }
  const raced = routeFixture(); raced.afterRead = () => { raced.guardFailure = 'sc_analytics_monthly_partial_range'; };
  const rejected = await raced.request(); assert.equal(rejected.statusCode, 422); assert.equal(rejected.body.items, undefined);
  assert.equal(raced.guardChecks, 1);
  const session = routeFixture(); session.afterRead = () => { session.session = false; };
  assert.equal((await session.request()).statusCode, 401);
});

test('source changes during generation prevent cache persistence even after a refresh already acquired its lease', async () => {
  let current = true; const updates = [];
  const service = loadDiscoverySource('services/marketingReportOverviewCache.service.js', {
    crypto: require('node:crypto'), sequelize, '../../models': {}, '../services/jobRequests.service': {},
  });
  const cache = service.createOverviewCacheCoordinator({ model: { update: async values => { updates.push(values); return [1]; } },
    validateIdentity: async () => { if (!current) throw Object.assign(Error('sc_analytics_configuration_changed'), { code: 'sc_analytics_configuration_changed' }); } });
  await assert.rejects(cache.generateAndPersist({ cache_key: 'fictitious-key' }, 'fictitious-lease', async () => {
    current = false; return { clicks: 3 };
  }), { code: 'sc_analytics_configuration_changed' });
  assert(updates.every(update => update.payload === undefined));
});


test('revocation during final storage validation is checked before overview or web disclosure', async () => {
  let active = true;
  await assert.rejects(sourceHelpers.readWithCurrentScope({ allowed: async () => active,
    capture: async () => [site], generate: async () => ({ clicks: 3 }),
    validate: async () => { active = false; } }), error => error.status === 403);
  const f = routeFixture(), original = f.storage.rawSource;
  f.storage.rawSource = async request => ({ ...await original(request), validate: async () => { f.session = false; } });
  const result = await f.request(); assert.equal(result.statusCode, 401); assert.equal(result.body.items, undefined);
});
