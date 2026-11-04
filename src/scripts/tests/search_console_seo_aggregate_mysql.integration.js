'use strict';
// Real MySQL on an owned Unix socket; all properties and data are fictitious.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createSearchConsoleAnalytics } = require('../../services/searchConsoleAnalytics.service');
const C = require('../../lib/searchConsoleAnalyticsContract');
const reads = require('../../lib/searchConsoleReadSource');
const migration = require('../../../migrations/20261018150000-create-search-console-analytics');
const files = ['src/services/searchConsoleAnalytics.service.js', 'src/lib/searchConsoleReadSource.js',
  'src/controllers/marketingReports.controller.js', 'src/scripts/tests/search_console_seo_aggregate_mysql.integration.js'];
const sourceHashes = () => Object.fromEntries(files.map(file => [file, createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
const metrics = ['clicks', 'impressions', 'position_weighted', 'position_sum', 'position_count'];
const position = reads.positionAggregateSql();
const sorted = rows => rows.map(row => JSON.stringify(row)).sort();

withIsolatedCampaignMysql(async ({ sql, report }) => {
  report.sourceHashes = sourceHashes();
  await migration.up(sql.getQueryInterface());
  const env = { SC_ANALYTICS_WRITE_ENABLED: 'true', SC_ANALYTICS_READ_ENABLED: 'true', SC_ANALYTICS_ARCHIVE_ENABLED: 'true', SC_ANALYTICS_PURGE_ENABLED: 'true' };
  const repo = createSearchConsoleAnalytics({ sequelize: sql, env, now: () => new Date('2026-11-04T00:00:00Z') });
  const query = async (statement, replacements = {}) => (await sql.query(statement, { replacements, logging: false }))[0];
  const property = async siteUrl => {
    const value = C.property(siteUrl);
    await query('INSERT INTO ScAnalyticsProperties(site_hash,site_url) VALUES(UNHEX(:hash),:url)', { hash: value.siteHash, url: value.siteUrl });
    return (await query('SELECT id FROM ScAnalyticsProperties WHERE site_hash=UNHEX(:hash)', { hash: value.siteHash }))[0].id;
  };
  const dictionary = async (table, text) => {
    await query(`INSERT IGNORE INTO ${table}(value_hash,value_text) VALUES(UNHEX(:hash),:text)`, { hash: C.hash(text), text });
    return (await query(`SELECT id FROM ${table} WHERE value_hash=UNHEX(:hash)`, { hash: C.hash(text) }))[0].id;
  };
  const cover = async (propertyId, startDate, endDate) => {
    for (let at = Date.parse(startDate); at <= Date.parse(endDate); at += 86400000) {
      await query('INSERT INTO ScAnalyticsCoverageDaily(property_id,date,detail_complete,totals_complete) VALUES(:property,:date,1,1)',
        { property: propertyId, date: new Date(at).toISOString().slice(0, 10) });
    }
  };
  const fact = async (propertyId, date, queryText, pageText, extra = {}) => {
    const normalized = C.normalize({ date, query: queryText || 'fixture-empty-compatibility', page_url: pageText,
      clicks: extra.clicks ?? 1, impressions: extra.impressions ?? 10, position: Object.hasOwn(extra, 'position') ? extra.position : 3 }, { startDate: date, endDate: date });
    const parameters = { property: propertyId, date, query: extra.queryId ?? await dictionary('ScAnalyticsQueries', queryText),
      page: extra.pageId ?? await dictionary('ScAnalyticsPages', pageText), ...Object.fromEntries(metrics.map(key => [key, normalized[key]])), digest: normalized.row_digest };
    await query(`INSERT INTO ScAnalyticsDaily(property_id,date,query_id,page_id,${metrics.join(',')},row_digest,updated_at)
      VALUES(:property,:date,:query,:page,${metrics.map(key => ':' + key).join(',')},UNHEX(:digest),'2030-01-01 00:00:00')`, parameters);
  };
  const dimensions = {
    query: { select: "COALESCE(NULLIF(query,''),'Sin query') AS value", group: "COALESCE(NULLIF(query,''),'Sin query')", order: 'SUM(impressions) DESC,SUM(clicks) DESC', limit: 80 },
    page: { select: "COALESCE(NULLIF(page_url,''),'Sin página') AS value", group: "COALESCE(NULLIF(page_url,''),'Sin página')", order: 'SUM(impressions) DESC,SUM(clicks) DESC', limit: 40 },
    pair: { select: "COALESCE(NULLIF(query,''),'Sin query') AS query,COALESCE(NULLIF(page_url,''),'Sin página') AS page", group: "COALESCE(NULLIF(query,''),'Sin query'),COALESCE(NULLIF(page_url,''),'Sin página')", order: 'SUM(clicks) DESC,SUM(impressions) DESC', limit: 250 },
  };
  function statement(source, name, { limit = dimensions[name].limit, weights = false } = {}) {
    const spec = dimensions[name];
    const select = weights ? (name === 'pair'
      ? "HEX(MIN(WEIGHT_STRING(COALESCE(NULLIF(query,''),'Sin query')))) AS queryKey,HEX(MIN(WEIGHT_STRING(COALESCE(NULLIF(page_url,''),'Sin página')))) AS pageKey"
      : `HEX(MIN(WEIGHT_STRING(${spec.group}))) AS valueKey`) : spec.select;
    return `SELECT ${select},SUM(clicks) AS clicks,SUM(impressions) AS impressions,${position} AS position,
      SUM(position_weighted) AS weighted,SUM(position_sum) AS positionSum,SUM(position_count) AS observations,MAX(date) AS lastDate
      FROM ${source.sqlFrom} WHERE date BETWEEN :eqStart AND :eqEnd GROUP BY ${spec.group}
      HAVING SUM(clicks)>0 OR SUM(impressions)>0 ORDER BY ${spec.order} LIMIT ${limit}`;
  }
  async function sources(options) {
    const beforeParams = {}, afterParams = {};
    const before = await repo.rawSource({ ...options, prefix: 'eq', replacements: beforeParams });
    const after = await repo.rawSource({ ...options, prefix: 'eq', replacements: afterParams, aggregate: true });
    assert.deepEqual(afterParams, beforeParams);
    return { before, after, parameters: beforeParams };
  }
  const examples = {};
  async function compare(options, { weights = false, example = false } = {}) {
    const source = await sources(options);
    for (const name of Object.keys(dimensions)) {
      for (const limit of [dimensions[name].limit, 2000]) {
        const beforeSql = statement(source.before, name, { limit, weights });
        const afterSql = statement(source.after, name, { limit, weights });
        const before = await query(beforeSql, source.parameters), after = await query(afterSql, source.parameters);
        assert.deepEqual(sorted(after), sorted(before), name + ' aggregate must preserve every exact SQL metric and group');
        if (example && limit === dimensions[name].limit) examples[name] = { beforeSql, afterSql, parameters: source.parameters };
      }
    }
    assert.equal(await source.before.validate(), true); assert.equal(await source.after.validate(), true);
    return source;
  }

  const siteA = 'sc-domain:seo-aggregate-one.example', siteB = 'sc-domain:seo-aggregate-two.example', excludedSite = 'sc-domain:seo-excluded.example';
  const a = await property(siteA), b = await property(siteB), excluded = await property(excludedSite);
  const current = { siteUrls: [siteA, siteA, siteB, siteA], startDate: '2026-09-30', endDate: '2026-10-02' };
  for (const id of [a, b, excluded]) await cover(id, current.startDate, current.endDate);
  for (const date of ['2026-09-30', '2026-10-01', '2026-10-02']) {
    await fact(a, date, 'repeated 🦷', 'https://seo-aggregate-one.example/á', { clicks: 17, impressions: 100, position: 3.123456789123 });
    await fact(b, date, 'repeated 🦷', 'https://seo-aggregate-one.example/á', { clicks: 7, impressions: 70, position: 1.333333333333 });
    await fact(excluded, date, 'MUST_NOT_APPEAR', 'https://seo-excluded.example/', { clicks: 999999, impressions: 999999 });
  }
  for (const [text, page, amount] of [['', '', 30000], ['Sin query', 'Sin página', 31000], ['A', 'https://seo-aggregate-one.example/A', 32000],
    ['á', 'https://seo-aggregate-one.example/á', 33000], ['á', 'https://seo-aggregate-one.example/á', 34000], ['   ', ' ', 35000]]) {
    await fact(a, '2026-09-30', text, page, { clicks: amount, impressions: amount + 10000 });
  }
  await fact(a, '2026-09-30', 'zero', '', { clicks: 1, impressions: 0, position: 2 });
  await fact(a, '2026-10-01', 'zero', '', { clicks: 1, impressions: 0, position: 4 });
  await fact(a, '2026-10-02', 'zero', '', { clicks: 1, impressions: 0, position: null });
  await fact(a, '2026-09-30', 'wide integer', '', { clicks: '9007199254740993', impressions: '9007199254740999', position: '7.123456789' });
  for (let i = 0; i < 300; i++) {
    await fact(a, '2026-09-30', 'limit-query-' + i, 'https://seo-aggregate-one.example/limit-' + i, { clicks: 100 + i, impressions: 1000 + i });
    await fact(a, '2026-10-01', 'limit-query-' + i, 'https://seo-aggregate-one.example/limit-' + i, { clicks: 100 + i, impressions: 1000 + i });
  }
  const compact = await compare(current, { example: true });
  const countBefore = Number((await query(`SELECT COUNT(*) AS n FROM ${compact.before.sqlFrom}`, compact.parameters))[0].n);
  const countAfter = Number((await query(`SELECT COUNT(*) AS n FROM ${compact.after.sqlFrom}`, compact.parameters))[0].n);
  assert(countAfter < countBefore, 'Only explicitly opted-in sources reduce fact-row cardinality');
  assert(!JSON.stringify(await query(statement(compact.after, 'query', { limit: 2000 }), compact.parameters)).includes('MUST_NOT_APPEAR'));
  report.checks.push('Daily equivalence for query80/page40/pair250 plus full groups: exact Unicode/placeholders, BIGINT/DECIMAL accumulators, weighted/null/zero positions, property deduplication, limits and original maximum dates');

  await fact(a, '2026-10-02', 'orphan-query', '', { queryId: 9999999, clicks: 777777, impressions: 777777 });
  await fact(a, '2026-10-02', 'orphan-page', '', { pageId: 9999998, clicks: 888888, impressions: 888888 });
  const withOrphans = await compare(current);
  assert.equal(Number((await query(`SELECT COUNT(*) AS n FROM ${withOrphans.before.sqlFrom}`, withOrphans.parameters))[0].n), countBefore);
  assert.equal(Number((await query(`SELECT COUNT(*) AS n FROM ${withOrphans.after.sqlFrom}`, withOrphans.parameters))[0].n), countAfter);
  report.checks.push('Both dictionary joins still exclude query/page orphans; default raw source retains its original row cardinality');

  // Compatibility test only: production's native dictionaries were verified bin.
  for (const table of ['ScAnalyticsQueries', 'ScAnalyticsPages']) await query(`ALTER TABLE ${table} MODIFY value_text MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL`);
  await compare(current, { weights: true });
  for (const table of ['ScAnalyticsQueries', 'ScAnalyticsPages']) await query(`ALTER TABLE ${table} MODIFY value_text MEDIUMTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL`);
  report.checks.push('Isolated ai_ci compatibility preserves textual collation groups and all metrics despite distinct dictionary IDs, without claiming an unspecified representative spelling');

  const archiveSite = 'sc-domain:seo-aggregate-archive.example';
  const archivedBodies = new Map();
  const archiveStore = { independent: true, put: async ({ key, body }) => {
    let value = ''; for await (const chunk of body) value += chunk; archivedBodies.set(key, value); return { key };
  }, read: async receipt => archivedBodies.get(receipt.key) };
  const validate = async () => true;
  const oldMonths = ['2024-02', '2024-03', '2024-04'];
  for (const month of oldMonths) {
    const bounds = C.monthRange(month);
    await repo.writeInterval({ siteUrl: archiveSite, ...bounds, validate, complete: true, rowLimitReached: false, rows: [
      { date: bounds.startDate, query: 'old weighted', page_url: '', clicks: 1, impressions: 10, position: 2 },
      { date: bounds.endDate, query: 'old weighted', page_url: '', clicks: 2, impressions: 30, position: 4 },
      { date: bounds.startDate, query: 'old zero', page_url: 'Sin página', clicks: 1, impressions: 0, position: 2 },
      { date: bounds.endDate, query: 'old zero', page_url: 'Sin página', clicks: 1, impressions: 0, position: 4 },
    ] });
    if (month !== '2024-04') await repo.archiveMonth({ siteUrl: archiveSite, month, archiveStore, validate });
  }
  const old = { siteUrls: [archiveSite], startDate: '2024-02-01', endDate: '2024-04-30' };
  await compare(old);
  const oldProperty = (await query('SELECT id FROM ScAnalyticsProperties WHERE site_url=:site', { site: archiveSite }))[0].id;
  await query(`INSERT INTO ScAnalyticsMonthly(property_id,month,query_id,page_id,${metrics.join(',')},source_rows,source_days)
    SELECT property_id,'2024-04-01',query_id,page_id,${metrics.map(key => `SUM(${key})`).join(',')},COUNT(*),COUNT(DISTINCT date)
    FROM ScAnalyticsDaily WHERE property_id=:id AND date BETWEEN '2024-04-01' AND '2024-04-30' GROUP BY property_id,query_id,page_id`, { id: oldProperty });
  await compare(old);
  await repo.purgeArchivedMonth({ siteUrl: archiveSite, month: '2024-02', archiveStore, validate, chunkSize: 1, maxChunks: 1 });
  const monthly = await compare(old);
  const zero = (await query(statement(monthly.after, 'query', { limit: 2000 }), monthly.parameters)).find(row => row.value === 'old zero');
  assert.equal(Number(zero.position), 3); assert.equal(String(zero.observations), '6');
  assert.equal(zero.lastDate, '2024-04-30');
  for (const aggregate of [false, true]) await assert.rejects(repo.rawSource({ ...old, startDate: '2024-02-02', replacements: {}, aggregate }), { code: 'sc_analytics_monthly_partial_range' });
  report.checks.push('Two published months plus live daily detail remain exact with partial daily purge and unpublished monthly rows excluded; full-month guard and observation-weighted zero positions remain intact');

  const raceSite = 'sc-domain:seo-aggregate-publication.example';
  await repo.writeInterval({ siteUrl: raceSite, startDate: '2024-05-01', endDate: '2024-05-31', validate, complete: true, rowLimitReached: false,
    rows: [{ date: '2024-05-01', query: 'publication', page_url: '', clicks: 1, impressions: 10, position: 2 },
      { date: '2024-05-31', query: 'publication', page_url: '', clicks: 9, impressions: 90, position: 4 }] });
  const partial = await sources({ siteUrls: [raceSite], startDate: '2024-05-01', endDate: '2024-05-15' });
  await repo.archiveMonth({ siteUrl: raceSite, month: '2024-05', archiveStore, validate });
  for (const source of [partial.before, partial.after]) {
    await query(statement(source, 'query'), partial.parameters);
    await assert.rejects(source.validate(), { code: 'sc_analytics_monthly_partial_range' });
  }
  await compare({ siteUrls: [raceSite], startDate: '2024-05-01', endDate: '2024-05-31' });
  for (const aggregate of [false, true]) await assert.rejects(repo.rawSource({ siteUrls: [siteA], startDate: '2026-09-30', endDate: '2026-10-03', aggregate, replacements: {} }), { code: 'sc_analytics_incomplete_coverage' });
  report.checks.push('Archive publication during a partial-period SELECT is still rejected by post-read guards in both modes; uncovered days never become zero or a legacy fallback');

  for (const change of ['permission', 'mapping', 'gate']) {
    let allowed = true, sites = current.siteUrls, gate = true;
    await assert.rejects(reads.readWithCurrentScope({ allowed: async () => allowed, capture: async () => sites, readEnabled: () => gate,
      generate: async () => {
        const result = await query(statement(compact.after, 'query'), compact.parameters);
        if (change === 'permission') allowed = false;
        if (change === 'mapping') sites = [siteB];
        if (change === 'gate') gate = false;
        return result;
      }, validate: compact.after.validate }), error => error.code === (change === 'gate' ? 'sc_analytics_configuration_changed' : 'search_console_scope_forbidden'));
  }
  report.checks.push('Actual aggregate SQL remains enclosed by live permission, canonical property-set and read-gate checks before disclosure');

  const exampleFile = path.join(report.root, 'seo-aggregate-generated.fixture.json');
  fs.writeFileSync(exampleFile, JSON.stringify(examples, null, 2), { mode: 0o600, flag: 'wx' });
  report.sqlExamples = { path: exampleFile, sha256: createHash('sha256').update(fs.readFileSync(exampleFile)).digest('hex'), fictitiousDataOnly: true };
  report.cardinality = { defaultRows: countBefore, aggregateRows: countAfter, performanceClaim: false };
  assert.deepEqual(sourceHashes(), report.sourceHashes, 'Source files must remain frozen throughout the SQL proof');
}).catch(error => { console.error(error); process.exitCode = 1; });
