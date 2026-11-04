'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const sequelize = require('sequelize');
const { createSearchConsoleAnalytics } = require('../../services/searchConsoleAnalytics.service');
const reads = require('../../lib/searchConsoleReadSource');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');
const site = 'sc-domain:aggregate.example';
const range = { startLabel: '2026-10-01', endLabel: '2026-10-02',
  previous: { startLabel: '2026-09-29', endLabel: '2026-09-30' } };

function sourceFixture() {
  const calls = [];
  const sql = { transaction() { assert.fail('Read must not start a transaction'); }, query: async (query, options) => {
    calls.push({ query, replacements: options.replacements });
    return [query.includes(' AS covered') ? [{ covered: 2 }] : []];
  } };
  const repo = createSearchConsoleAnalytics({ sequelize: sql, env: { SC_ANALYTICS_READ_ENABLED: 'true' } });
  const input = { siteUrls: [site], startDate: range.startLabel, endDate: range.endLabel, replacements: {}, prefix: 'unit' };
  return { repo, calls, input };
}

test('aggregate is explicit, detail-only and Boolean; invalid modes cannot issue SQL', async () => {
  const f = sourceFixture();
  for (const patch of [{ aggregate: 'true' }, { aggregate: 1 }, { aggregate: null },
    { aggregate: true, totals: true }, { aggregate: true, ranking: true }]) {
    await assert.rejects(f.repo.rawSource({ ...f.input, ...patch }), { code: 'sc_analytics_invalid_scope' });
  }
  assert.equal(f.calls.length, 0);
});

test('default raw source stays identical and aggregate retains scope, archive and validation boundaries', async () => {
  const f = sourceFixture();
  const original = await f.repo.rawSource({ ...f.input, replacements: {} });
  const explicitDefault = await f.repo.rawSource({ ...f.input, aggregate: false, replacements: {} });
  assert.equal(original.sqlFrom, explicitDefault.sqlFrom);
  assert(!original.sqlFrom.includes('GROUP BY d.property_id,d.query_id,d.page_id'));
  const params = {}, aggregate = await f.repo.rawSource({ ...f.input, aggregate: true, replacements: params });
  assert.equal((aggregate.sqlFrom.match(/GROUP BY d.property_id,d.query_id,d.page_id/g) || []).length, 2);
  assert.equal((aggregate.sqlFrom.match(/p.site_hash IN \(UNHEX\(:unit0\)\)/g) || []).length, 2);
  assert(aggregate.sqlFrom.indexOf('SUM(d.clicks)') < aggregate.sqlFrom.indexOf('JOIN ScAnalyticsQueries'));
  assert(aggregate.sqlFrom.includes('JOIN ScAnalyticsPages u ON u.id=g.page_id'));
  assert(aggregate.sqlFrom.includes("a.month=DATE_FORMAT(d.date,'%Y-%m-01')"));
  assert(aggregate.sqlFrom.includes('a.month=d.month'));
  assert(!/HAVING|LIMIT|COLLATE|LOWER\(/.test(aggregate.sqlFrom));
  assert.equal(aggregate.resolution, original.resolution);
  assert.equal(aggregate.authoritativeTotals, false);
  assert.equal(await aggregate.validate(), true);
  assert.deepEqual(params, { unitStart: range.startLabel, unitEnd: range.endLabel, unit0: require('../../lib/searchConsoleAnalyticsContract').property(site).siteHash });
  const collision = { unit0: 'occupied' };
  await assert.rejects(f.repo.rawSource({ ...f.input, aggregate: true, replacements: collision }), { code: 'sc_analytics_replacement_collision' });
  assert.deepEqual(collision, { unit0: 'occupied' });
});

test('property adapter forwards opt-in while empty authorized scope stays empty', async () => {
  const calls = [];
  const storage = { rawSource: async input => { calls.push(input); return { sqlFrom: 'owned' }; } };
  const input = { storage, siteUrls: [site], range, replacements: {}, prefix: 'adapter' };
  await reads.propertySource(input); await reads.propertySource({ ...input, aggregate: true });
  assert.equal(calls[0].aggregate, false); assert.equal(calls[1].aggregate, true);
  assert.equal(calls[1].prefix, 'adapterSrc');
  assert.match((await reads.propertySource({ ...input, siteUrls: [], aggregate: true })).sqlFrom, /WHERE FALSE/);
  assert.equal(calls.length, 2);
});

test('actual report opts in only query/page/pair period aggregates; trends, totals, rankings and legacy keep raw sources', async () => {
  const calls = [], checked = [];
  const state = { google: { available_assets: { search_console: [71, 72, 73, 74].map(clinic_id => ({
    mapping_id: clinic_id, clinic_id, connection_id: 81, site_url: site,
  })) } } };
  const models = { Sequelize: sequelize, WebScQueryDaily: {}, sequelize: { query: async (query) => {
    if (query.includes('FAKE_TOTALS')) return [{ clicks: 10, impressions: 100, position: 2, lastDate: range.endLabel }];
    if (query.includes('FAKE_RANKS')) return [{ date: range.endLabel, top3: 1, top10: 1 }];
    if (query.includes(' AS value')) return [{ value: query.includes('page_url') ? 'https://aggregate.example/page' : 'fixture query', clicks: 3, impressions: 10, position: 2 }];
    if (query.includes(' AS query,')) return [{ query: 'fixture query', page: 'https://aggregate.example/page', clicks: 3, impressions: 10, position: 2 }];
    return [{ date: range.endLabel, query: 'fixture query', clicks: 3, impressions: 10, position: 2 }];
  } } };
  const storage = { availability: async () => ({ properties: [{ siteUrl: site, totalsFrom: '2000-01-01', totalsThrough: '2099-01-01', monthlyPeriods: [] }] }),
    rawSource: async request => {
      calls.push(request); assert.deepEqual(Array.from(request.siteUrls), [site]);
      return { sqlFrom: request.totals ? 'FAKE_TOTALS' : request.ranking ? 'FAKE_RANKS' : 'FAKE_DETAIL', scopeSql: '',
        resolution: 'daily_or_complete_month', validate: async () => { checked.push(request.prefix); } };
    } };
  const controller = loadDiscoverySource('controllers/marketingReports.controller.js', {
    sequelize, '../../models': models, '../lib/searchConsoleReadSource': reads,
    '../services/searchConsoleAnalytics.service': storage, '../services/searchConsoleBroker.service': { prepare: async () => null },
    '../services/marketingReportOverviewCache.service': { overviewCache: null },
  }, { env: { SC_ANALYTICS_READ_ENABLED: 'true' } });
  const result = await controller.__testing.aggregateSeo({ scope: 'group', clinicIds: [71, 72, 73, 74] }, range, state);
  assert.equal(result.coverage.detail.status, 'ready');
  assert.deepEqual(calls.filter(row => row.aggregate).map(row => row.prefix).sort(), [
    'seoCurrentPageSrc', 'seoCurrentQuerySrc', 'seoPreviousPageSrc', 'seoPreviousQuerySrc', 'seoQueryPageSrc',
  ]);
  assert(calls.filter(row => row.aggregate).every(row => !row.totals && !row.ranking));
  assert(calls.some(row => row.prefix === 'seoQueryTrendSrc' && row.aggregate === false));
  for (const request of calls.filter(row => row.aggregate)) assert(checked.filter(value => value === request.prefix).length >= 2);
});

test('shared FIFO permits only two dimension SQL calls, queues the third and releases its slot after an error', async () => {
  const started = []; let active = 0, maximum = 0;
  const oneRange = { startLabel: '2026-10-01', endLabel: '2026-10-02' };
  const state = { google: { available_assets: { search_console: [{ mapping_id: 71, clinic_id: 71, connection_id: 81, site_url: site }] } } };
  const models = { Sequelize: sequelize, WebScQueryDaily: {}, sequelize: { query: async query => {
    if (query.includes('FAKE_TOTALS')) return [{ clicks: 10, impressions: 100, position: 2, lastDate: oneRange.endLabel }];
    if (query.includes('FAKE_RANKS')) return [];
    if (query.includes(' AS value') || query.includes(' AS query,')) {
      active++; maximum = Math.max(maximum, active);
      let resolve, reject;
      const pending = new Promise((yes, no) => { resolve = yes; reject = no; });
      started.push({ kind: query.includes(' AS query,') ? 'pair' : query.includes('page_url') ? 'page' : 'query', resolve, reject });
      try { return await pending; } finally { active--; }
    }
    assert.fail('No other detail SQL should run after the deliberate failure');
  } } };
  const storage = { availability: async () => ({ properties: [{ siteUrl: site, totalsFrom: '2026-10-01', totalsThrough: '2026-10-02', monthlyPeriods: [] }] }),
    rawSource: async request => ({ sqlFrom: request.totals ? 'FAKE_TOTALS' : request.ranking ? 'FAKE_RANKS' : 'FAKE_DETAIL',
      scopeSql: '', resolution: 'daily_or_complete_month', validate: async () => true }) };
  const controller = loadDiscoverySource('controllers/marketingReports.controller.js', {
    sequelize, '../../models': models, '../lib/searchConsoleReadSource': reads,
    '../services/searchConsoleAnalytics.service': storage, '../services/searchConsoleBroker.service': { prepare: async () => null },
    '../services/marketingReportOverviewCache.service': { overviewCache: null },
  }, { env: { SC_ANALYTICS_READ_ENABLED: 'true' } });
  const running = controller.__testing.aggregateSeo({ scope: 'clinic', clinicIds: [71] }, oneRange, state);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started.map(row => row.kind), ['query', 'page']); assert.equal(active, 2);
  started[0].reject(Error('FICTITIOUS_SQL_FAILURE'));
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(started.map(row => row.kind), ['query', 'page', 'pair']); assert.equal(active, 2);
  started[1].resolve([]); started[2].resolve([]);
  const result = await running;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(maximum, 2); assert.equal(active, 0); assert.equal(result.coverage.detail.status, 'pending');
  assert.deepEqual(Array.from(result.queryPages), []);
});
