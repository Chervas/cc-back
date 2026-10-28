'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const migration = require('../../../migrations/20261018150000-create-search-console-analytics');
const { createSearchConsoleAnalytics } = require('../../services/searchConsoleAnalytics.service');
const { loadDiscoverySource } = require('./fixtures/business_profile_discovery.fixture');
let ownedRoot;
async function main() {
  await withIsolatedCampaignMysql(async ({ sql, report }) => {
    ownedRoot = report.root;
    const env = { SC_ANALYTICS_WRITE_ENABLED: 'true', SC_ANALYTICS_READ_ENABLED: 'true', SC_ANALYTICS_ARCHIVE_ENABLED: 'true', SC_ANALYTICS_PURGE_ENABLED: 'true' };
    let clock = new Date('2026-10-18T00:00:00Z');
    const repo = createSearchConsoleAnalytics({ sequelize: sql, env, now: () => clock });
    const rows = async (q, replacements = {}) => (await sql.query(q, { replacements, logging: false }))[0];
    const count = async table => Number((await rows(`SELECT COUNT(*) AS n FROM ${table}`))[0].n);
    const validate = async () => true;
    const options = { siteUrl: 'sc-domain:fixture.example', startDate: '2026-09-01', endDate: '2026-09-03', complete: true, rowLimitReached: false, validate };
    const detail = [{ keys: ['2026-09-01', 'clínica 🦷', 'https://fixture.example/á'], clicks: 2, impressions: 10, position: 3.123456789123 },
      { keys: ['2026-09-02', '歯科', 'https://fixture.example/歯'], clicks: 1, impressions: 20, position: 7 }];
    await migration.up(sql.getQueryInterface()); await migration.up(sql.getQueryInterface());
    const binary = await rows("SELECT DATA_TYPE,CHARACTER_MAXIMUM_LENGTH FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name='ScAnalyticsQueries' AND column_name='value_hash'");
    assert.equal(binary[0].DATA_TYPE, 'binary'); assert.equal(Number(binary[0].CHARACTER_MAXIMUM_LENGTH), 32);
    const pk = await rows('SHOW INDEX FROM ScAnalyticsDaily'); assert.equal(pk.length, 4);
    report.checks.push('additive migration twice, BINARY(32), four-column compact primary key');
    for (let clinic = 0; clinic < 4; clinic++) await repo.writeInterval({ ...options, rows: detail });
    assert.equal(await count('ScAnalyticsProperties'), 1); assert.equal(await count('ScAnalyticsDaily'), 2);
    assert.equal(await count('ScAnalyticsQueries'), 2); assert.equal(await count('ScAnalyticsPages'), 2);
    const before = await rows('SELECT HEX(row_digest) digest,updated_at FROM ScAnalyticsDaily ORDER BY date');
    clock = new Date('2026-10-19T00:00:00Z');
    assert.equal((await repo.writeInterval({ ...options, rows: detail })).changed, 0);
    assert.deepEqual(await rows('SELECT HEX(row_digest) digest,updated_at FROM ScAnalyticsDaily ORDER BY date'), before);
    const read = async args => { const replacements = {}; const source = await repo.rawSource({ ...options, siteUrls: [options.siteUrl], replacements, ...args }); return rows(`SELECT * FROM ${source.sqlFrom} ORDER BY date`, replacements); };
    assert.equal((await read({})).length, 2);
    await repo.writeTotalsInterval({ ...options, rows: [{ keys: ['2026-09-01'], clicks: 100, impressions: 1000, position: 4 }] });
    assert.equal(Number((await read({ totals: true }))[0].clicks), 100);
    assert.equal(Number((await read({ ranking: true }))[0].queries_top10), 1);
    assert.equal(Number((await read({ ranking: true }))[0].queries_top3), 0);
    const horizon = await repo.availability({ siteUrls: [options.siteUrl, options.siteUrl, 'sc-domain:missing.example'], startDate: '2026-09-01', endDate: '2026-09-10' });
    assert.equal(horizon.properties.length, 2);
    assert.equal(horizon.properties[0].totalsFrom, '2026-09-01');
    assert.equal(horizon.properties[0].totalsThrough, '2026-09-03');
    assert.equal(horizon.properties[0].detailThrough, '2026-09-03');
    assert.equal(horizon.properties[1].totalsThrough, null);
    report.checks.push('coverage metadata deduplicates authorized properties, preserves missing-property null and separates totals/detail horizons');
    const handlers = new Map();
    loadDiscoverySource('routes/web.routes.js', {
      express: { Router: () => ({ use() {}, get: (route, handler) => handlers.set(route, handler), post() {} }) },
      '../../models': { Sequelize: require('sequelize'), sequelize: sql }, './auth.middleware': () => {},
      '../lib/searchConsoleReadSource': require('../../lib/searchConsoleReadSource'),
      '../services/searchConsoleAnalytics.service': repo,
      '../services/googleLegacyCredentials.service': { safe: () => 'fixture_unavailable' },
      '../services/searchConsoleBroker.service': { prepare: async () => null },
      '../services/accessSession.service': { bearer: token => token, verify: async () => ({ userId: 501, sessionVersion: 1, jti: 'fixture-session' }) },
      '../lib/marketingScopeAccess': { hasMarketingClinicScopeAccess: async () => true },
      '../services/effectiveMarketingAssets.service': { resolveEffectiveMarketingAssetInventory: async () => ({ google: { available_assets: { search_console:
        [71, 72, 73, 74].map(clinic_id => ({ mapping_id: clinic_id, clinic_id, connection_id: 81, site_url: options.siteUrl })) } } }) },
    }, { env: { SC_ANALYTICS_READ_ENABLED: 'true' } });
    const request = async route => {
      const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
      await handlers.get(route)({ params: { clinicaId: '72' }, query: { startDate: options.startDate, endDate: options.endDate },
        headers: { authorization: 'fictitious-local-session' }, webClinicId: 72, webClinicUserId: 501, method: 'GET' }, response);
      assert.equal(response.statusCode, 200); return response.body;
    };
    const panelPages = await request('/clinica/:clinicaId/sc/pages');
    assert.equal(panelPages.items.length, 2); assert.equal(panelPages.items.reduce((sum, page) => sum + page.clicks, 0), 3);
    const panelSeries = await request('/clinica/:clinicaId/seo/timeseries');
    assert.equal(panelSeries.series.length, 1); assert.equal(panelSeries.series[0].clicks, 100);
    report.checks.push('actual panel pages SQL and authoritative daily series execute against compact store without multiplying four mappings or inventing absent date rows');

    await assert.rejects(read({ endDate: '2026-09-04' }), { code: 'sc_analytics_incomplete_coverage' });
    await repo.writeInterval({ ...options, rows: detail, totalsRows: [] });
    assert.equal((await read({ totals: true })).length, 0); // Complete empty totals replace old nonzero totals.
    await repo.writeTotalsInterval({ ...options, rows: [{ keys: ['2026-09-01'], clicks: 100, impressions: 1000, position: 4 }] });
    report.checks.push('four clinic clones stored once, Unicode dictionaries, metric no-op timestamps, authoritative totals and rankings, coverage gate');
    await assert.rejects(repo.writeInterval({ ...options, rows: detail, complete: false }), { code: 'sc_analytics_incomplete_interval' });
    const aborted = await repo.beginInterval(options); await repo.stageRows(aborted, detail);
    await assert.rejects(repo.commitInterval(aborted, { complete: true, rowLimitReached: false, validate: async () => false }), { code: 'sc_analytics_authority_changed' });
    await repo.abortInterval(aborted); assert.deepEqual(await rows('SELECT HEX(row_digest) digest,updated_at FROM ScAnalyticsDaily ORDER BY date'), before);
    const first = await repo.beginInterval(options), obsolete = await repo.beginInterval(options);
    await repo.stageRows(first, [{ ...detail[0], clicks: 3 }]); await repo.stageRows(obsolete, detail);
    await repo.commitInterval(first, { complete: true, rowLimitReached: false, validate });
    await assert.rejects(repo.commitInterval(obsolete, { complete: true, rowLimitReached: false, validate }), { code: 'sc_analytics_superseded_interval' }); await repo.abortInterval(obsolete);
    const collision = await rows('SELECT HEX(value_hash) hash FROM ScAnalyticsQueries LIMIT 1');
    await sql.query('UPDATE ScAnalyticsQueries SET value_text=\'deliberately conflicting fixture\' WHERE value_hash=UNHEX(:hash)', { replacements: collision[0], logging: false });
    await assert.rejects(repo.writeInterval({ ...options, rows: detail }), { code: 'sc_analytics_hash_collision' });
    await sql.query('UPDATE ScAnalyticsQueries SET value_text=:text WHERE value_hash=UNHEX(:hash)', { replacements: { ...collision[0], text: detail.find(row => require('node:crypto').createHash('sha256').update(row.keys[1]).digest('hex').toUpperCase() === collision[0].hash).keys[1] }, logging: false });
    report.checks.push('incomplete page cannot publish, revoked authority rollback, CAS rejects obsolete interval, hash collision fails closed');
    const old = { siteUrl: 'sc-domain:archive.example', startDate: '2024-02-01', endDate: '2024-02-29', validate, complete: true, rowLimitReached: false };
    const historical = [
      { date: '2024-02-01', query: 'weighted', page_url: 'https://archive.example/a', clicks: 1, impressions: 10, position: 2 },
      { date: '2024-02-29', query: 'weighted', page_url: 'https://archive.example/a', clicks: 3, impressions: 30, position: 4 },
      { date: '2024-02-01', query: 'zero', page_url: '', clicks: 0, impressions: 0, position: 2 },
      { date: '2024-02-29', query: 'zero', page_url: '', clicks: 0, impressions: 0, position: 4 },
    ];
    async function* cloned() { for (let clinic = 0; clinic < 4; clinic++) for (const row of historical) yield { ...row, site_url: old.siteUrl }; }
    const clonedRows = []; for await (const row of cloned()) clonedRows.push(row);
    // This legacy fixture exercises the repository/archive. Historical backfill
    // now requires the separate bounded audit, totals and per-date evidence.
    await repo.writeInterval({ ...old, rows: clonedRows });
    assert.equal(Number((await rows('SELECT COUNT(*) AS n FROM ScAnalyticsDaily d JOIN ScAnalyticsProperties p ON p.id=d.property_id WHERE p.site_url=:url', { url: old.siteUrl }))[0].n), 4);
    async function* conflicting() { yield { ...historical[0], site_url: old.siteUrl }; yield { ...historical[0], clicks: 99, site_url: old.siteUrl }; }
    const conflictingRows = []; for await (const row of conflicting()) conflictingRows.push(row);
    await assert.rejects(repo.writeInterval({ ...old, rows: conflictingRows }), { code: 'sc_analytics_conflicting_duplicate' });
    let corrupt = false; const archivedBodies = new Map();
    const store = { independent: true, async put({ key, body }) { let content = ''; for await (const chunk of body) content += chunk; archivedBodies.set(key, content); return { key }; }, async read(receipt) { return archivedBodies.get(receipt.key) + (corrupt ? 'corrupt' : ''); } };
    const archiveArgs = { siteUrl: old.siteUrl, month: '2024-02', archiveStore: store, validate };
    corrupt = true; await assert.rejects(repo.archiveMonth(archiveArgs), { code: 'sc_analytics_archive_verification_failed' });
    assert.equal(await count('ScAnalyticsArchiveBatches'), 0); assert.equal(await count('ScAnalyticsMonthly'), 0);
    corrupt = false; const archive = await repo.archiveMonth(archiveArgs); assert.equal(archive.rows, 4);
    assert.equal((await repo.archiveMonth(archiveArgs)).replay, true);
    const oldRead = async overrides => { const replacements = {}; const source = await repo.rawSource({ ...old, siteUrls: [old.siteUrl], replacements, ...overrides }); return rows(`SELECT * FROM ${source.sqlFrom} ORDER BY query`, replacements); };
    const monthly = await oldRead({}); assert.equal(monthly.length, 2);
    assert.equal(Number(monthly[0].clicks), 4); assert.equal(Number(monthly[0].impressions), 40); assert.equal(Number(monthly[0].position), 3.5);
    assert.equal(Number(monthly[1].position), 3);
    await assert.rejects(oldRead({ startDate: '2024-02-02' }), { code: 'sc_analytics_monthly_partial_range' });
    const locked = createSearchConsoleAnalytics({ sequelize: sql, env: { ...env, SC_ANALYTICS_PURGE_ENABLED: 'false' }, now: () => clock });
    await assert.rejects(locked.purgeArchivedMonth(archiveArgs), { code: 'sc_analytics_purge_disabled' });
    corrupt = true; await assert.rejects(repo.purgeArchivedMonth(archiveArgs), { code: 'sc_analytics_archive_verification_failed' }); corrupt = false;
    assert.deepEqual(await repo.purgeArchivedMonth({ ...archiveArgs, chunkSize: 1, maxChunks: 1 }), { removed: 1, done: false });
    assert.equal((await oldRead({})).length, 2); // Published monthly hides all daily remnants.
    assert.deepEqual(await repo.purgeArchivedMonth({ ...archiveArgs, chunkSize: 1, maxChunks: 3 }), { removed: 3, done: true });
    assert.deepEqual(await repo.purgeArchivedMonth(archiveArgs), { removed: 0, done: true });
    await assert.rejects(repo.writeInterval({ ...old, rows: historical }), { code: 'sc_analytics_month_already_archived' });
    await assert.rejects(repo.archiveMonth({ ...archiveArgs, month: '2024-10' }), { code: 'sc_analytics_retention_window' });
    const march = { ...old, startDate: '2024-03-01', endDate: '2024-03-31' }, april = { ...old, startDate: '2024-04-01', endDate: '2024-04-30' };
    await repo.writeInterval({ ...march, rows: [{ date: '2024-03-01', query: 'zero', page_url: '', clicks: 0, impressions: 0, position: 6 }] });
    await repo.writeInterval({ ...april, rows: [{ date: '2024-04-01', query: 'zero', page_url: '', clicks: 0, impressions: 0, position: 8 }] });
    await repo.archiveMonth({ ...archiveArgs, month: '2024-03' });
    const mixedReplacements = {}, mixed = await repo.rawSource({ siteUrls: [old.siteUrl, old.siteUrl], startDate: old.startDate, endDate: april.endDate, replacements: mixedReplacements });
    const aggregate = async source => (await rows(`SELECT SUM(impressions) AS impressions,SUM(position_weighted) AS weighted,SUM(position_sum) AS positions,SUM(position_count) AS observations,CASE WHEN SUM(impressions)>0 THEN SUM(position_weighted)/SUM(impressions) ELSE SUM(position_sum)/NULLIF(SUM(position_count),0) END AS position FROM ${source.sqlFrom} WHERE query='zero'`, mixedReplacements))[0];
    const zero = await aggregate(mixed); assert.equal(Number(zero.impressions), 0); assert.equal(Number(zero.positions), 20); assert.equal(Number(zero.observations), 4); assert.equal(Number(zero.position), 5);
    await repo.writeTotalsInterval({ ...old, rows: [{ date: '2024-02-01', clicks: 0, impressions: 0, position: 2 }, { date: '2024-02-29', clicks: 0, impressions: 0, position: 4 }] });
    await repo.writeTotalsInterval({ ...march, rows: [{ date: '2024-03-01', clicks: 0, impressions: 0, position: 6 }] });
    await repo.writeTotalsInterval({ ...april, rows: [{ date: '2024-04-01', clicks: 0, impressions: 0, position: 8 }] });
    const totalReplacements = {}, mixedTotals = await repo.rawSource({ siteUrls: [old.siteUrl], startDate: old.startDate, endDate: april.endDate, replacements: totalReplacements, totals: true });
    const totalZero = (await rows(`SELECT SUM(position_weighted) AS weighted,SUM(position_sum) AS positions,SUM(position_count) AS observations,SUM(position_sum)/SUM(position_count) AS position FROM ${mixedTotals.sqlFrom}`, totalReplacements))[0];
    assert.equal(Number(totalZero.weighted), 0); assert.equal(Number(totalZero.positions), 20); assert.equal(Number(totalZero.observations), 4); assert.equal(Number(totalZero.position), 5);
    report.checks.push('two monthly periods plus daily detail preserve zero-impression observation weights; authoritative totals expose the same exact accumulators');
    const historicalHorizon = await repo.availability({ siteUrls: [old.siteUrl], startDate: old.startDate, endDate: april.endDate });
    assert.deepEqual(historicalHorizon.properties[0].monthlyPeriods, ['2024-02', '2024-03']);
    assert.equal(historicalHorizon.properties[0].totalsThrough, '2024-04-30');
    report.checks.push('availability exposes only actually published monthly periods and authoritative ledger horizons');

    const raceOptions = { ...old, siteUrl: 'sc-domain:race.example', startDate: '2024-03-01', endDate: '2024-03-31' };
    const raceRow = { date: '2024-03-01', query: 'race', page_url: '', clicks: 1, impressions: 1, position: 1 };
    await repo.writeInterval({ ...raceOptions, rows: [raceRow] });
    let racingContent;
    const racingStore = { independent: true, async put({ body }) { racingContent = ''; for await (const chunk of body) racingContent += chunk;
      await repo.writeInterval({ ...raceOptions, rows: [{ ...raceRow, clicks: 2 }] }); return { fixture: 'race' }; }, async read() { return racingContent; } };
    await assert.rejects(repo.archiveMonth({ siteUrl: raceOptions.siteUrl, month: '2024-03', archiveStore: racingStore, validate }), { code: 'sc_analytics_archive_source_changed' });
    assert.equal(await count('ScAnalyticsArchiveBatches'), 2);
    assert.equal(Number((await rows('SELECT d.clicks FROM ScAnalyticsDaily d JOIN ScAnalyticsProperties p ON p.id=d.property_id WHERE p.site_url=:url', { url: raceOptions.siteUrl }))[0].clicks), 2);
    const publication = { ...old, siteUrl: 'sc-domain:publication.example', startDate: '2024-05-01', endDate: '2024-05-31' };
    await repo.writeInterval({ ...publication, rows: [{ date: '2024-05-01', query: 'partial', page_url: '', clicks: 1, impressions: 10, position: 2 },
      { date: '2024-05-31', query: 'partial', page_url: '', clicks: 9, impressions: 90, position: 4 }] });
    const firstHalfParams = {}, firstHalf = await repo.rawSource({ ...publication, siteUrls: [publication.siteUrl], endDate: '2024-05-15', replacements: firstHalfParams });
    const lastDaysParams = {}, lastDays = await repo.rawSource({ ...publication, siteUrls: [publication.siteUrl], startDate: '2024-05-02', replacements: lastDaysParams });
    const fullParams = {}, fullMonth = await repo.rawSource({ ...publication, siteUrls: [publication.siteUrl], replacements: fullParams });
    await repo.archiveMonth({ siteUrl: publication.siteUrl, month: '2024-05', archiveStore: store, validate });
    await rows(`SELECT SUM(clicks) FROM ${firstHalf.sqlFrom}`, firstHalfParams);
    await rows(`SELECT SUM(clicks) FROM ${lastDays.sqlFrom}`, lastDaysParams);
    await assert.rejects(firstHalf.validate(), { code: 'sc_analytics_monthly_partial_range' });
    await assert.rejects(lastDays.validate(), { code: 'sc_analytics_monthly_partial_range' });
    assert.equal(Number((await rows(`SELECT SUM(clicks) AS clicks FROM ${fullMonth.sqlFrom}`, fullParams))[0].clicks), 10);
    assert.equal(await fullMonth.validate(), true);
    report.checks.push('publication between rawSource and SELECT is rejected by post-read validation for both partial-month boundaries; full-month result remains exact');
    report.checks.push('repository clone fixture, conflicting clones abort, leap-month exact weighted/zero-position rollup, independent archive read-back failure safe, partial monthly range explicit, resumable verified purge, retry idempotence, concurrent ingestion prevents stale archive publication');
    assert.equal(await count('ScAnalyticsStagedRows'), 0); assert.equal(await count('ScAnalyticsStagedTotals'), 0);
  });
  // The fixture owns cleanup and honors explicit data retention for reproduction.
  const reportFile = path.join(ownedRoot, 'result.json'); const report = JSON.parse(fs.readFileSync(reportFile));
  assert.equal(report.success, true); assert.equal(report.shutdown.code, 0);
  assert.equal(report.dataCleanup.status, process.env.CAMPAIGN_OPTIMIZATION_MYSQL_KEEP_DATA === '1' ? 'retained' : 'removed');
  console.log(JSON.stringify({ report: reportFile, dataCleanup: report.dataCleanup.status }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
