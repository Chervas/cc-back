'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const migration = require('../../../migrations/20261018150000-create-search-console-analytics');
const { createSearchConsoleAnalytics } = require('../../services/searchConsoleAnalytics.service');
const { backfillInterval } = require('../search_console_analytics.operator');
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
    await backfillInterval({ repository: repo, source: cloned(), ...old, provenanceReviewed: true });
    assert.equal(Number((await rows('SELECT COUNT(*) AS n FROM ScAnalyticsDaily d JOIN ScAnalyticsProperties p ON p.id=d.property_id WHERE p.site_url=:url', { url: old.siteUrl }))[0].n), 4);
    async function* conflicting() { yield { ...historical[0], site_url: old.siteUrl }; yield { ...historical[0], clicks: 99, site_url: old.siteUrl }; }
    await assert.rejects(backfillInterval({ repository: repo, source: conflicting(), ...old, provenanceReviewed: true }), { code: 'sc_analytics_conflicting_duplicate' });
    let content = '', corrupt = false;
    const store = { independent: true, async put({ body }) { content = ''; for await (const chunk of body) content += chunk; return { fixture: 'independent-memory-archive' }; }, async read() { return content + (corrupt ? 'corrupt' : ''); } };
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
    const raceOptions = { ...old, siteUrl: 'sc-domain:race.example', startDate: '2024-03-01', endDate: '2024-03-31' };
    const raceRow = { date: '2024-03-01', query: 'race', page_url: '', clicks: 1, impressions: 1, position: 1 };
    await repo.writeInterval({ ...raceOptions, rows: [raceRow] });
    let racingContent;
    const racingStore = { independent: true, async put({ body }) { racingContent = ''; for await (const chunk of body) racingContent += chunk;
      await repo.writeInterval({ ...raceOptions, rows: [{ ...raceRow, clicks: 2 }] }); return { fixture: 'race' }; }, async read() { return racingContent; } };
    await assert.rejects(repo.archiveMonth({ siteUrl: raceOptions.siteUrl, month: '2024-03', archiveStore: racingStore, validate }), { code: 'sc_analytics_archive_source_changed' });
    assert.equal(await count('ScAnalyticsArchiveBatches'), 1);
    assert.equal(Number((await rows('SELECT d.clicks FROM ScAnalyticsDaily d JOIN ScAnalyticsProperties p ON p.id=d.property_id WHERE p.site_url=:url', { url: raceOptions.siteUrl }))[0].clicks), 2);
    report.checks.push('reviewed legacy clone backfill, conflicting clones abort, leap-month exact weighted/zero-position rollup, independent archive read-back failure safe, partial monthly range explicit, resumable verified purge, retry idempotence, concurrent ingestion prevents stale archive publication');
    assert.equal(await count('ScAnalyticsStagedRows'), 0); assert.equal(await count('ScAnalyticsStagedTotals'), 0);
  });
  // Only our successfully closed fixture datadir; preserve report and error log.
  const reportFile = path.join(ownedRoot, 'result.json'); const report = JSON.parse(fs.readFileSync(reportFile));
  assert.equal(report.success, true); assert.equal(report.shutdown.code, 0);
  fs.rmSync(path.join(ownedRoot, 'data'), { recursive: true, force: true });
  report.ownDatadirRemoved = true; fs.writeFileSync(reportFile, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ report: reportFile, ownDatadirRemoved: true }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
