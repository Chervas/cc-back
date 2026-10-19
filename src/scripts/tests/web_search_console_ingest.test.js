'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { Op } = require('sequelize');
const ingest = require('../../lib/searchConsoleIngest');
const { loadBusinessProfileJobs } = require('./fixtures/business_profile_jobs.fixture');

const NativeDate = Date;
const FIXTURE_NOW = NativeDate.parse('2026-10-18T12:00:00.000Z');
class FixtureClockDate extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [FIXTURE_NOW])); }
  static now() { return FIXTURE_NOW; }
}

const keys = ['clinica_id', 'date', 'query_hash', 'page_url_hash'];
const key = (row, fields = keys) => JSON.stringify(fields.map(field => String(row[field] ?? '')));
const row = (index, patch = {}) => ({ clinica_id: 71, date: '2026-10-18', query_hash: 'q' + index,
  page_url_hash: 'p' + index, query: 'fictitious ' + index, page_url: 'https://example.invalid/' + index,
  clicks: 1, impressions: 3, ctr: 1 / 3, position: 1.2344, ...patch });

function database() {
  const state = { tables: { query: new Map(), daily: new Map(), agg: new Map() }, lookups: [], writes: [], failWrite: 0, tick: 0 };
  const table = (name, tx) => (tx?.tables || state.tables)[name];
  const record = entry => ({ ...entry, update: async values => { Object.assign(entry, values); } });
  function model(name, fields) {
    return {
      findAll: async options => {
        state.lookups.push(options);
        return options.where[Op.or].flatMap(where => {
          const existing = table(name, options.transaction).get(key(where, fields));
          return existing ? [{ ...existing }] : [];
        });
      },
      findOrCreate: async ({ where, defaults, transaction }) => {
        const rows = table(name, transaction), id = key(where, fields), previous = rows.get(id);
        if (previous) return [record(previous), false];
        const created = { ...defaults }; rows.set(id, created); return [record(created), true];
      },
      bulkCreate: async (rows, options) => {
        state.writes.push(rows.length);
        if (state.failWrite && state.writes.length === state.failWrite) throw Error('FICTITIOUS_WRITE_FAILURE');
        for (const value of rows) table(name, options.transaction).set(key(value, fields), { ...value, updated_at: ++state.tick });
        await state.afterWrite?.();
      },
    };
  }
  const models = {
    WebScQueryDaily: model('query', keys), WebScDaily: model('daily', ['clinica_id', 'site_url', 'date']),
    WebScDailyAgg: model('agg', ['clinica_id', 'date']),
    sequelize: { transaction: async work => {
      const transaction = { tables: structuredClone(state.tables) };
      const result = await work(transaction); state.tables = transaction.tables; return result;
    } },
  };
  return { state, models };
}

test('exact-key batches skip unchanged rounded DECIMALs and retain their update timestamp', async () => {
  const f = database(), unchanged = row(1, { ctr: '0.333333', position: '1.234', updated_at: 123 });
  f.state.tables.query.set(key(unchanged), unchanged);
  const changed = row(2, { clicks: 2 }), existing = row(2);
  f.state.tables.query.set(key(existing), existing);
  const stats = await ingest.persistChangedRows({ model: f.models.WebScQueryDaily, rows: [row(1), changed, row(3)], keyFields: keys, chunkSize: 2 });
  assert.deepEqual(stats, { received: 3, inserted: 1, updated: 1, unchanged: 1, written: 2 });
  assert.deepEqual(f.state.lookups.map(options => options.where[Op.or].length), [2, 1]);
  assert(f.state.lookups.every(options => options.where[Op.or].every(where => Object.keys(where).length === 4)));
  assert.equal(f.state.tables.query.get(key(unchanged)).updated_at, 123);
  f.state.writes = [];
  const retry = await ingest.persistChangedRows({ model: f.models.WebScQueryDaily, rows: [row(1), changed, row(3)], keyFields: keys });
  assert.equal(retry.unchanged, 3); assert.equal(retry.written, 0); assert.deepEqual(f.state.writes, []);
});

test('a later write-batch failure rolls back the entire interval and permits an idempotent retry', async () => {
  const f = database(); f.state.failWrite = 2;
  const publish = tx => ingest.persistChangedRows({ model: f.models.WebScQueryDaily,
    rows: [row(1), row(2), row(3)], keyFields: keys, chunkSize: 2, transaction: tx });
  await assert.rejects(f.models.sequelize.transaction(publish), /FICTITIOUS_WRITE_FAILURE/);
  assert.equal(f.state.tables.query.size, 0);
  f.state.failWrite = 0;
  assert.equal((await f.models.sequelize.transaction(publish)).written, 3);
  assert.equal((await f.models.sequelize.transaction(publish)).unchanged, 3);
});

test('month windows retain leap days and configured backfill remains full until initial coverage is explicitly verified', () => {
  assert.equal(new FixtureClockDate().toISOString(), '2026-10-18T12:00:00.000Z');
  assert.equal(new FixtureClockDate('2024-02-29T00:00:00.000Z').toISOString(), '2024-02-29T00:00:00.000Z');
  assert.deepEqual([...ingest.monthRanges('2024-02-28', '2024-03-02')], [
    { s: '2024-02-28', e: '2024-02-29' }, { s: '2024-03-01', e: '2024-03-02' }]);
  const config = { backfillDays: 480 };
  assert.equal(ingest.backfillDays(config, {}), 480);
  assert.equal(ingest.backfillDays(config, { WEB_BACKFILL_REVISIT_DAYS: '30' }), 480);
  assert.equal(ingest.backfillDays(config, { WEB_BACKFILL_INITIAL_COVERAGE_VERIFIED: 'true', WEB_BACKFILL_REVISIT_DAYS: '0' }), 480);
  assert.equal(ingest.backfillDays(config, { WEB_BACKFILL_INITIAL_COVERAGE_VERIFIED: 'true', WEB_BACKFILL_REVISIT_DAYS: '30' }), 30);
});

test('one web shared by four legacy mappings downloads once but rechecks every mapping and refuses revoked cached authority', async () => {
  let downloads = 0; const checked = new Set();
  const assets = [71, 72, 73, 74].map(clinicaId => ({ id: clinicaId, clinicaId, googleConnectionId: 81, siteUrl: 'https://example.invalid/' }));
  const revoked = new Set();
  const read = ingest.createDownloadReader({ read: async () => { downloads++; return { data: { rows: [] } }; },
    validate: async asset => { checked.add(asset.id); if (revoked.has(asset.id)) throw Error('REVOKED'); } });
  for (const asset of assets) await read(asset, { connection: {} }, 'queries', { startDate: '2026-10-01' });
  assert.equal(downloads, 1); assert.equal(checked.size, 4);
  revoked.add(assets[0].id);
  await assert.rejects(read(assets[3], { connection: {} }, 'queries', { startDate: '2026-10-01' }), /REVOKED/);
  assert.equal(downloads, 1);
});

test('broker tenants keep separate downloads even for one web and connection', async () => {
  let downloads = 0;
  const read = ingest.createDownloadReader({ validate: async () => {},
    read: async () => { downloads++; return { data: { rows: [] } }; } });
  for (const clinicaId of [71, 72, 73, 74]) await read({ clinicaId, googleConnectionId: 81, siteUrl: 'https://example.invalid/',
    broker_read_connection_ref: 'connection-81', broker_read_asset_ref: 'property-1' }, { brokerContext: {} }, 'queries', {});
  assert.equal(downloads, 4);
});

function jobsFixture({ count = 1, sites = 1, env = {}, storage } = {}) {
  const f = database(); Object.assign(f.state, { calls: [], active: true, failQueries: null, truncate: false, revisions: 0, reports: [], storageCalls: [] });
  const mappings = Array.from({ length: count }, (_, index) => ({ id: 91 + index, clinicaId: 71 + index,
    googleConnectionId: 81, siteUrl: 'https://example.invalid/' }));
  for (let index = 1; index < sites; index++) mappings.push({ ...mappings[0], id: 100 + index, siteUrl: 'https://other' + index + '.invalid/' });
  f.models.ClinicWebAsset = { findAll: async () => mappings };
  f.models.SyncLog = { create: async () => ({ update: async value => f.state.reports.push(value) }) };
  const credentials = { assert: async () => { if (!f.state.active) throw Error('REVOKED'); },
    request: async (_connection, send) => send(), safe: () => 'google_credentials_unavailable' };
  const jobs = loadBusinessProfileJobs({ models: f.models, credentials, clockDate: FixtureClockDate,
    searchConsole: { prepare: async () => { if (!f.state.active) throw Error('REVOKED'); return null; } },
    legacyHttp: { post: async (url, payload) => {
      f.state.calls.push({ url, payload });
      if (payload.dimensions.length === 1 && f.state.timeseriesRows) return { data: { rows: f.state.timeseriesRows(url, payload) } };
      if (payload.dimensions.length === 1) return { data: { rows: [{ keys: [payload.startDate], clicks: 1, impressions: 3, ctr: 1 / 3, position: 1.2344 }] } };
      if (f.state.failQueries?.(url, payload)) throw Error('FICTITIOUS_PROVIDER_FAILURE');
      if (f.state.queryRows) return { data: { rows: f.state.queryRows(url, payload) } };
      const point = { keys: [payload.startDate, 'fictitious query', 'https://example.invalid/page'], clicks: 1 + f.state.revisions, impressions: 3, position: 1.2344 };
      return { data: { rows: f.state.truncate ? Array(25000).fill(point) : [point] } };
    } },
    env: { WEB_PSI_ENABLED: 'false', WEB_SYNC_RECENT_DAYS: '1', WEB_BACKFILL_DAYS: '1', ...env },
    overrides: storage ? { '../services/searchConsoleAnalytics.service': storage } : {},
  }).metaSyncJobs;
  jobs._ensureGoogleAccessToken = async () => ({ accessToken: 'FICTITIOUS_OFFLINE_TOKEN', connection: { id: 81 } });
  return { ...f, jobs };
}

test('actual sync for one web/four mappings retains legacy DTOs and skips all query UPDATEs on retry', async () => {
  const f = jobsFixture({ count: 4 });
  const first = await f.jobs.executeWebSync();
  assert.equal(first.status, 'completed'); assert.equal(first.processed, 4);
  assert.equal(first.report.ingestion.downloads, 2); assert.equal(first.report.ingestion.reusedDownloads, 6);
  assert.equal(first.report.ingestion.written, 4); assert.equal(f.state.tables.query.size, 4);
  const timestamps = [...f.state.tables.query.values()].map(value => value.updated_at);
  const second = await f.jobs.executeWebSync();
  assert.equal(second.report.ingestion.unchanged, 4); assert.equal(second.report.ingestion.written, 0);
  assert.deepEqual([...f.state.tables.query.values()].map(value => value.updated_at), timestamps);
  f.state.revisions++;
  const revised = await f.jobs.executeWebSync(); assert.equal(revised.report.ingestion.updated, 4);
  assert([...f.state.tables.query.values()].every(value => value.clicks === 2));
});

test('one failed property never publishes a partial multi-property legacy interval; retry publishes the complete aggregate', async () => {
  const f = jobsFixture({ sites: 2 });
  f.state.failQueries = url => url.includes('other1');
  const failed = await f.jobs.executeWebSync();
  assert.equal(failed.status, 'failed'); assert.equal(failed.retryable, true);
  assert.equal(f.state.tables.query.size, 0); assert.equal(f.state.tables.agg.size, 0);
  assert.equal(failed.report.ingestion.failedIntervals, 1);
  f.state.failQueries = null;
  const retried = await f.jobs.executeWebSync(); assert.equal(retried.status, 'completed');
  assert.equal(f.state.tables.query.size, 1); assert.equal([...f.state.tables.query.values()][0].clicks, 2);
});

test('truncated intervals and revocation during a write are not published', async () => {
  const limited = jobsFixture(); limited.state.truncate = true;
  const result = await limited.jobs.executeWebSync();
  assert.equal(result.status, 'failed'); assert.equal(result.report.rowLimits.length, 1);
  assert.equal(limited.state.tables.query.size, 0);
  const revoked = jobsFixture(); revoked.state.afterWrite = () => { revoked.state.active = false; };
  assert.equal((await revoked.jobs.executeWebSync()).status, 'failed');
  assert.equal(revoked.state.tables.query.size, 0); assert.equal(revoked.state.tables.agg.size, 0);
});

test('monthly interval failures leave other complete months intact and are reported as retryable', async () => {
  const f = jobsFixture({ env: { WEB_SYNC_RECENT_DAYS: '70' } });
  f.state.failQueries = (_url, payload) => payload.startDate.slice(5, 7) === '09';
  const result = await f.jobs.executeWebSync();
  assert.equal(result.status, 'failed'); assert.equal(result.retryable, true);
  assert.equal(result.report.ingestion.failedIntervals, 1);
  assert.equal(result.report.ingestion.completedIntervals, 2);
  assert([...f.state.tables.query.values()].every(value => value.date.slice(5, 7) !== '09'));
});

test('new property storage stays off by default and enabling it passes a live mapping validator for each complete interval', async () => {
  const calls = [];
  const storage = Object.fromEntries(['writeInterval', 'writeTotalsInterval'].map(method => [method, async request => {
    await request.validate(); assert.equal(request.complete, true); assert.equal(request.rowLimitReached, false);
    calls.push(method);
  }]));
  const disabled = jobsFixture({ storage }); await disabled.jobs.executeWebSync(); assert.deepEqual(calls, []);
  const enabled = jobsFixture({ storage, env: { SC_ANALYTICS_WRITE_ENABLED: 'true' } });
  assert.equal((await enabled.jobs.executeWebSync()).status, 'completed');
  assert.deepEqual(calls, ['writeTotalsInterval', 'writeInterval']);
});


test('compact coverage uses each property observed final bounds and never claims today or unobserved older history', async () => {
  const writes = [];
  const storage = Object.fromEntries(['writeInterval', 'writeTotalsInterval'].map(method => [method, async request => {
    await request.validate(); writes.push({ method, ...request });
  }]));
  const f = jobsFixture({ sites: 2, storage, env: { SC_ANALYTICS_WRITE_ENABLED: 'true', WEB_SYNC_RECENT_DAYS: '6' } });
  f.state.timeseriesRows = url => (url.includes('other1') ? ['2026-10-14', '2026-10-15'] : ['2026-10-15', '2026-10-16'])
    .map(date => ({ keys: [date], clicks: 1, impressions: 3, position: 2 }));
  f.state.queryRows = () => ['13', '14', '15', '16', '17', '18'].map(day => ({
    keys: ['2026-10-' + day, 'fictitious query', 'https://example.invalid/page'], clicks: 1, impressions: 3, position: 2
  }));
  assert.equal((await f.jobs.executeWebSync()).status, 'completed');
  assert.equal(writes.length, 4);
  for (const request of writes) {
    const other = request.siteUrl.includes('other1');
    assert.equal(request.startDate, other ? '2026-10-14' : '2026-10-15');
    assert.equal(request.endDate, other ? '2026-10-15' : '2026-10-16');
    assert(request.rows.every(row => row.keys[0] >= request.startDate && row.keys[0] <= request.endDate));
  }
});

test('an empty final timeseries publishes no compact interval and cannot overwrite prior compact history with zero', async () => {
  let writes = 0;
  const storage = { writeInterval: async () => { writes++; }, writeTotalsInterval: async () => { writes++; } };
  const f = jobsFixture({ storage, env: { SC_ANALYTICS_WRITE_ENABLED: 'true' } });
  f.state.timeseriesRows = () => [];
  const result = await f.jobs.executeWebSync();
  assert.equal(result.status, 'completed'); assert.equal(writes, 0);
  assert.equal(result.report.ingestion.compactCoverage[0].lastObservedFinalDate, null);
});
