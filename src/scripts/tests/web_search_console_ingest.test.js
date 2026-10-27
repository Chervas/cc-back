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

function jobsFixture({ count = 1, sites = 1, env = {}, storage, helper } = {}) {
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
    legacyHttp: { post: async (url, payload, config) => {
      f.state.calls.push({ url, payload, config });
      if (payload.dimensions.length === 1 && f.state.timeseriesRows) return { data: { rows: f.state.timeseriesRows(url, payload) } };
      if (payload.dimensions.length === 1) return { data: { rows: [{ keys: [payload.startDate], clicks: 1, impressions: 3, ctr: 1 / 3, position: 1.2344 }] } };
      if (f.state.failQueries?.(url, payload)) throw Error('FICTITIOUS_PROVIDER_FAILURE');
      if (f.state.queryRows) return { data: { rows: f.state.queryRows(url, payload) } };
      const point = { keys: [payload.startDate, 'fictitious query', 'https://example.invalid/page'], clicks: 1 + f.state.revisions, impressions: 3, position: 1.2344 };
      return { data: { rows: f.state.truncate ? Array(25000).fill(point) : [point] } };
    } },
    env: { WEB_PSI_ENABLED: 'false', WEB_SYNC_RECENT_DAYS: '1', WEB_BACKFILL_DAYS: '1', ...env },
    overrides: { ...(storage ? { '../services/searchConsoleAnalytics.service': storage } : {}),
      ...(helper ? { '../lib/searchConsoleIngest': helper } : {}) },
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

test('bounded interval failures leave other complete ranges intact and are reported as retryable', async () => {
  const f = jobsFixture({ env: { WEB_SYNC_RECENT_DAYS: '70' } });
  f.state.failQueries = (_url, payload) => payload.startDate.slice(5, 7) === '09';
  const result = await f.jobs.executeWebSync();
  assert.equal(result.status, 'failed'); assert.equal(result.retryable, true);
  assert.equal(result.report.ingestion.failedIntervals, 10);
  assert.equal(result.report.ingestion.completedIntervals, 14);
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
  f.state.queryRows = (_url, payload) => ['13', '14', '15', '16', '17', '18'].map(day => ({
    keys: ['2026-10-' + day, 'fictitious query', 'https://example.invalid/page'], clicks: 1, impressions: 3, position: 2
  })).filter(row => row.keys[0] >= payload.startDate && row.keys[0] <= payload.endDate);
  assert.equal((await f.jobs.executeWebSync()).status, 'completed');
  assert.equal(writes.length, 5);
  assert.deepEqual(writes.filter(request => request.method === 'writeInterval').map(request =>
    ({ other: request.siteUrl.includes('other1'), start: request.startDate, end: request.endDate })), [
    { other: false, start: '2026-10-15', end: '2026-10-15' },
    { other: true, start: '2026-10-14', end: '2026-10-15' },
    { other: false, start: '2026-10-16', end: '2026-10-16' }
  ]);
  for (const request of writes) {
    const other = request.siteUrl.includes('other1');
    assert(request.startDate >= (other ? '2026-10-14' : '2026-10-15'));
    assert(request.endDate <= (other ? '2026-10-15' : '2026-10-16'));
    if (request.method === 'writeTotalsInterval') {
      assert.equal(request.startDate, other ? '2026-10-14' : '2026-10-15');
      assert.equal(request.endDate, other ? '2026-10-15' : '2026-10-16');
    }
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


// Dense Search Console intervals: all fixtures are fictitious and all real I/O is denied.
const fs = require('node:fs'), vm = require('node:vm');
const deny = () => { throw Error('REAL_IO_FORBIDDEN_IN_SC_OFFLINE_QA'); };
for (const key of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork']) require('node:child_process')[key] = deny;
require('node:dgram').createSocket = deny;
for (const key of ['writeFile','writeFileSync','appendFile','appendFileSync','unlink','unlinkSync','rename','renameSync','mkdir','mkdirSync','rmdir','rmdirSync','rm','rmSync','truncate','truncateSync','createWriteStream']) fs[key] = deny;
const originalOpen = fs.openSync; fs.openSync = (filename, flags, ...args) => {
  if (!(flags === 0 || typeof flags === 'string' && !/[wax+]/.test(flags))) deny();
  return originalOpen(filename, flags, ...args);
};
const asset = { id: 91, clinicaId: 71, googleConnectionId: 81, siteUrl: 'https://example.invalid/' };
const credentials = { connection: { id: 81 } };
const day = value => new Date(value + 'T00:00:00.000Z');
const label = value => value.toISOString().slice(0, 10);
const point = (date, index = 0) => ({ keys: [date, 'fictitious ' + index, 'https://example.invalid/p' + index], clicks: 1, impressions: 3, position: 2 });
const full = date => Array(25000).fill(point(date));
function reader({ raw, validate = async () => {}, now, implementation = ingest }) {
  const state = { calls: [], reused: 0, splits: 0, incompleteReused: 0 };
  const download = implementation.createDownloadReader({ validate, read: async (a, c, family, payload, options) => {
    state.calls.push({ a, family, payload, options });
    return raw(a, c, family, payload, options);
  } });
  const read = implementation.createQueryIntervalReader({ read: download, validate, now,
    onReuse: () => { state.reused++; }, onIncompleteReuse: () => { state.incompleteReused++; }, onSplit: () => { state.splits++; } });
  return { state, read };
}
const response = (rows, rowLimitReached = false) => ({ data: { rows, rowLimitReached } });
const dailyRows = Array.from({ length: 3 }, (_, index) => Array.from({ length: 10000 }, (_, row) => point('2026-10-' + (16 + index), row)));
const subset = payload => dailyRows.flat().filter(row => row.keys[0] >= payload.startDate && row.keys[0] <= payload.endDate).slice(0, 25000);

test('a genuine 30000-row three-day interval splits inclusively without overlap and discards capped parent rows', async () => {
  const f = reader({ raw: async (_a,_c,_family,payload) => response(subset(payload)) });
  const intervals = await f.read(asset, credentials, { s: '2026-10-16', e: '2026-10-18' });
  assert.deepEqual(intervals.map(({ s,e,rows }) => ({ s,e,count:rows.length })), [
    { s:'2026-10-16',e:'2026-10-16',count:10000 },{ s:'2026-10-17',e:'2026-10-17',count:10000 },{ s:'2026-10-18',e:'2026-10-18',count:10000 }]);
  assert.equal(intervals.flatMap(x => x.rows).length, 30000);
  assert.equal(new Set(intervals.flatMap(x => x.rows).map(x => JSON.stringify(x.keys))).size,30000);
  assert.equal(f.state.calls.length,4); assert.equal(f.state.splits,1);
  assert(f.state.calls.every(c => Object.keys(c.payload).sort().join(',') === 'endDate,startDate'));
});

test('the complete >25000-row parent is reused for four legacy mappings with current authority checks', async () => {
  const checked = new Set(); let revoked;
  const f = reader({ raw: async (_a,_c,_family,payload) => response(subset(payload)), validate: async a => {
    checked.add(a.id); if (a.id === revoked) throw Error('REVOKED');
  } });
  const range = { s:'2026-10-16',e:'2026-10-18' };
  for (let i=0;i<4;i++) assert.equal((await f.read({ ...asset,id:91+i,clinicaId:71+i },credentials,range)).flatMap(x=>x.rows).length,30000);
  assert.equal(f.state.calls.length,4);assert.equal(f.state.reused,3);assert.equal(checked.size,4);
  revoked=91;
  await assert.rejects(f.read({ ...asset,id:94,clinicaId:74 },credentials,range), /REVOKED/);
  assert.equal(f.state.calls.length,4);
});

test('broker tenants never reuse a completed parent across mappings and never invoke legacy fallback', async () => {
  const f = reader({ raw: async (_a,c,_family,p) => { assert(c.brokerContext); return response([point(p.startDate)]); } });
  for (let i=0;i<2;i++) await f.read({ ...asset,id:91+i,clinicaId:71+i,broker_read_connection_ref:'conn',broker_read_asset_ref:'property' },
    { brokerContext:{} },{ s:'2026-10-16',e:'2026-10-18' });
  assert.equal(f.state.calls.length,2);assert.equal(f.state.reused,0);
});

test('a capped day stays terminal and is memoized without rows so the same job does not redownload it', async () => {
  const f = reader({ raw: async (_a,_c,_family,p) => response(full(p.startDate),false) });
  for (let i=0;i<2;i++) await assert.rejects(f.read(asset,credentials,{s:'2026-10-16',e:'2026-10-18'}), e => {
    assert.equal(e.code,'search_console_interval_truncated');assert.deepEqual(e.range,{s:'2026-10-16',e:'2026-10-16'});return true;
  });
  assert.equal(f.state.calls.filter(c=>c.payload.endDate==='2026-10-18'&&c.payload.startDate==='2026-10-16').length,1);
  assert.equal(f.state.reused,0);assert.equal(f.state.incompleteReused,1);
});

test('real executeWebSync publishes the 30000 complete rows once and an unchanged retry writes nothing', async () => {
  const f = jobsFixture({env:{WEB_SYNC_RECENT_DAYS:'3'}});f.state.queryRows=(_url,payload)=>subset(payload);
  const result = await f.jobs.executeWebSync();
  assert.equal(result.status,'completed');assert.equal(result.report.ingestion.completedIntervals,1);
  assert.equal(result.report.ingestion.splitIntervals,1);assert.equal(result.report.ingestion.written,30000);
  assert.equal(f.state.tables.query.size,30000);assert.equal(f.state.tables.agg.size,3);
  const retry=await f.jobs.executeWebSync();assert.equal(retry.status,'completed');
  assert.equal(retry.report.ingestion.written,0);assert.equal(retry.report.ingestion.unchanged,30000);
});

test('a late child failure leaves prior monthly SQL and compact detail coverage unchanged', async () => {
  const compact=[];const storage={writeInterval:async request=>compact.push(request),writeTotalsInterval:async()=>{}};
  const f=jobsFixture({env:{WEB_SYNC_RECENT_DAYS:'3',SC_ANALYTICS_WRITE_ENABLED:'true'},storage});
  f.state.queryRows=(_url,payload)=>subset(payload);
  const prior={clinica_id:71,date:'2026-10-16',query_hash:'PRIOR',page_url_hash:'PRIOR',clicks:8};
  f.state.tables.query.set('prior',{...prior});
  f.state.failQueries=(_url,p)=>p.startDate==='2026-10-18'&&p.endDate==='2026-10-18';
  const failed=await f.jobs.executeWebSync();
  assert.equal(failed.status,'failed');assert.equal(failed.report.ingestion.failedIntervals,1);
  assert.equal(f.state.tables.query.size,1);assert.deepEqual(f.state.tables.query.get('prior'),prior);
  assert.equal(f.state.tables.agg.size,0);assert.equal(f.state.writes.length,0);assert.equal(compact.length,0);
});

test('enabled compact storage receives only complete bounded leaves, while default flags stay off', async () => {
  const requests=[];const storage={writeInterval:async r=>requests.push(r),writeTotalsInterval:async()=>{}};
  const f=jobsFixture({env:{WEB_SYNC_RECENT_DAYS:'3',SC_ANALYTICS_WRITE_ENABLED:'true'},storage});
  f.state.timeseriesRows=()=>['2026-10-16','2026-10-17','2026-10-18'].map(date=>({keys:[date],clicks:1,impressions:3,position:2}));
  f.state.queryRows=(_url,p)=>subset(p);
  assert.equal((await f.jobs.executeWebSync()).status,'completed');
  assert.equal(requests.length,3);assert(requests.every(x=>x.complete===true&&x.rowLimitReached===false&&x.rows.length<25000));
  assert.deepEqual(requests.map(x=>[x.startDate,x.endDate]),[['2026-10-16','2026-10-16'],['2026-10-17','2026-10-17'],['2026-10-18','2026-10-18']]);
});

function helperWithByteCounter(byteLength) {
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../../lib/searchConsoleIngest'),'utf8'),{
    module,exports:module.exports,Buffer:{byteLength},require:name=>name==='sequelize'?require('sequelize'):
      name==='node:crypto'?require('node:crypto'):(()=>{throw Error('UNEXPECTED_DEPENDENCY');})(),Date
  },{filename:'genuine-candidate-helper-byte-counter.fixture',timeout:2000});
  return module.exports;
}

test('the original 40MB aggregate byte budget includes discarded parents and completed siblings', async () => {
  const implementation=helperWithByteCounter(()=>16000000);
  const f=reader({implementation,raw:async(_a,_c,_fam,p)=>response(p.startDate===p.endDate?[point(p.startDate)]:full(p.startDate))});
  await assert.rejects(f.read(asset,credentials,{s:'2026-10-16',e:'2026-10-17'}),{code:'search_console_interval_budget_exceeded'});
  assert.equal(f.state.calls.length,3);assert.equal(f.state.reused,0);
});

test('the aggregate 450s deadline is propagated to genuine broker before each page and prevents another send', async () => {
  const {searchConsoleFixture}=require('./fixtures/search_console_broker.fixture');
  const f=searchConsoleFixture(),context=await f.service.prepare(f.mapping);
  f.state.response=()=>({rows:Array.from({length:500},(_,i)=>point('2026-10-16',i)),nextPageToken:'FICTITIOUS_CURSOR',rowLimitReached:false});
  f.state.afterCall=()=>{f.state.at+=450001;};
  const r=reader({now:()=>f.state.at,raw:(a,c,family,p,options)=>f.service.read(a,c.brokerContext,family,p,options)});
  await assert.rejects(r.read(f.mapping,{brokerContext:context},{s:'2026-10-16',e:'2026-10-17'}),{code:'search_console_interval_budget_exceeded'});
  assert.equal(f.state.calls.length,1);
});

test('legacy HTTP receives only a tighter remaining timeout; post-response overrun cannot publish', async () => {
  let at=1000;
  const r=reader({now:()=>at,raw:async(_a,_c,_fam,p,{beforeExecute})=>{
    at=450990;assert.equal(beforeExecute().timeoutMs,10);at=451001;return response([point(p.startDate)]);
  }});
  await assert.rejects(r.read(asset,credentials,{s:'2026-10-16',e:'2026-10-16'}),{code:'search_console_interval_budget_exceeded'});
  assert.equal(r.state.calls.length,1);
});

test('splitting leap-day labels is disjoint and retains all dates without timezone conversion; 31 days means at most32 reads and dense follow-up skips the parent', async () => {
  const implementation=helperWithByteCounter(()=>1);
  const f=reader({implementation,raw:async(_a,_c,_fam,p)=>response(p.startDate===p.endDate?[point(p.startDate)]:full(p.startDate))});
  const leap=await f.read(asset,credentials,{s:'2024-02-28',e:'2024-03-01'});
  assert.deepEqual(Array.from(leap,x=>x.s),['2024-02-28','2024-02-29','2024-03-01']);
  const before=f.state.calls.length;
  const days=await f.read(asset,credentials,{s:'2026-10-01',e:'2026-10-31'});
  assert.equal(days.length,31);assert.equal(f.state.calls.length-before,31);
  await assert.rejects(f.read(asset,credentials,{s:'2026-10-01',e:'2026-11-01'}),{code:'search_console_range_invalid'});
  await assert.rejects(f.read(asset,credentials,{s:'2026-02-30',e:'2026-03-01'}),{code:'search_console_range_invalid'});
});

test('child responses outside their inclusive dates are rejected before any complete parent is returned', async () => {
  const f=reader({raw:async()=>response([point('2026-10-15')])});
  await assert.rejects(f.read(asset,credentials,{s:'2026-10-16',e:'2026-10-18'}),{code:'search_console_response_range_invalid'});
});


test('Sep then Oct is downloaded once for four shared legacy mappings; known density skips the October parent', async () => {
  const f=reader({raw:async(_a,_c,_family,p)=>{
    const rows=[];
    for(let date=day(p.startDate);date<=day(p.endDate);date.setUTCDate(date.getUTCDate()+1)) {
      const count=label(date).startsWith('2026-09')?10000:1000;
      for(let i=0;i<count&&rows.length<25000;i++)rows.push(point(label(date),i));
    }
    return response(rows);
  }});
  const ranges=[{s:'2026-09-28',e:'2026-09-30'},{s:'2026-10-01',e:'2026-10-27'}];
  for(let i=0;i<4;i++)for(const range of ranges){
    const rows=(await f.read({...asset,id:91+i,clinicaId:71+i},credentials,range)).flatMap(x=>x.rows);
    assert.equal(rows.length,range.s.startsWith('2026-09')?30000:27000);
  }
  assert.equal(f.state.calls.length,31);assert.equal(f.state.reused,6);
  assert(!f.state.calls.some(x=>x.payload.startDate==='2026-10-01'&&x.payload.endDate==='2026-10-27'));
});

test('LRU holds at most two parents and evicts by the combined 40000000-byte cache budget', async () => {
  const ranges=[1,2,3].map(i=>({s:'2026-10-0'+i,e:'2026-10-0'+i}));
  const large=reader({implementation:helperWithByteCounter(()=>21000000),raw:async(_a,_c,_fam,p)=>response([point(p.startDate)])});
  await large.read(asset,credentials,ranges[0]);await large.read(asset,credentials,ranges[1]);await large.read(asset,credentials,ranges[0]);
  assert.equal(large.state.calls.length,3);assert.equal(large.state.reused,0);
  const small=reader({implementation:helperWithByteCounter(()=>1000000),raw:async(_a,_c,_fam,p)=>response([point(p.startDate)])});
  for(const index of [0,1,0,2,1])await small.read(asset,credentials,ranges[index]);
  assert.equal(small.state.calls.length,4);assert.equal(small.state.reused,1);
});

test('provider/unknown failures are not cached as complete or as canonical capped days', async () => {
  const f=reader({raw:async()=>{throw Error('FICTITIOUS_PROVIDER_FAILURE');}});
  for(let i=0;i<2;i++)await assert.rejects(f.read(asset,credentials,{s:'2026-10-16',e:'2026-10-18'}),/FICTITIOUS_PROVIDER_FAILURE/);
  assert.equal(f.state.calls.length,2);assert.equal(f.state.reused,0);assert.equal(f.state.incompleteReused,0);
});


test('genuine legacy _readSearchConsole narrows only its own HTTP timeout to the remaining shared deadline', async () => {
  const f=jobsFixture();
  await f.jobs._readSearchConsole(asset,{...credentials,accessToken:'FICTITIOUS_OFFLINE_TOKEN'},'queries',
    {startDate:'2026-10-18',endDate:'2026-10-18'},{beforeExecute:()=>({timeoutMs:7})});
  assert.equal(f.state.calls[0].config.timeout,7);
  await f.jobs._readSearchConsole(asset,{...credentials,accessToken:'FICTITIOUS_OFFLINE_TOKEN'},'timeseries',
    {startDate:'2026-10-18',endDate:'2026-10-18'});
  assert.equal(Object.hasOwn(f.state.calls[1].config,'timeout'),false);
});


test('three-day publication ranges are inclusive, disjoint, and stop at month and leap-day boundaries', () => {
  const ranges=[...ingest.queryRanges('2024-02-25','2024-03-10')];
  assert.equal(ingest.QUERY_PUBLICATION_DAYS,3);
  assert.deepEqual(ranges,[{s:'2024-02-25',e:'2024-02-27'},{s:'2024-02-28',e:'2024-02-29'},
    {s:'2024-03-01',e:'2024-03-03'},{s:'2024-03-04',e:'2024-03-06'},{s:'2024-03-07',e:'2024-03-09'},{s:'2024-03-10',e:'2024-03-10'}]);
  const dates=ranges.flatMap(range=>{
    const output=[];for(let d=day(range.s);d<=day(range.e);d.setUTCDate(d.getUTCDate()+1))output.push(label(d));return output;
  });
  assert.equal(dates.length,15);assert.equal(new Set(dates).size,15);assert(dates.includes('2024-02-29'));
  assert.deepEqual([...ingest.queryRanges('2026-10-01','2026-10-27')],[
    {s:'2026-10-01',e:'2026-10-03'},{s:'2026-10-04',e:'2026-10-06'},{s:'2026-10-07',e:'2026-10-09'},
    {s:'2026-10-10',e:'2026-10-12'},{s:'2026-10-13',e:'2026-10-15'},{s:'2026-10-16',e:'2026-10-18'},
    {s:'2026-10-19',e:'2026-10-21'},{s:'2026-10-22',e:'2026-10-24'},{s:'2026-10-25',e:'2026-10-27'}]);
});

const rowsForDates = payload => {
  const rows=[];for(let d=day(payload.startDate);d<=day(payload.endDate);d.setUTCDate(d.getUTCDate()+1))rows.push(point(label(d)));
  return rows;
};

test('a month exceeding 40MB can complete separate bounded ranges without expanding the reader budget', async () => {
  const weightedBytes=json=>JSON.parse(json).length*3000000;
  const helper=helperWithByteCounter(weightedBytes);
  const monthly=reader({implementation:helper,raw:async(_a,_c,_family,p)=>response(rowsForDates(p))});
  await assert.rejects(monthly.read(asset,credentials,{s:'2026-10-02',e:'2026-10-18'}),{code:'search_console_interval_budget_exceeded'});
  const f=jobsFixture({helper,env:{WEB_SYNC_RECENT_DAYS:'17'}});f.state.queryRows=(_url,p)=>rowsForDates(p);
  const accepted=await f.jobs.executeWebSync();
  assert.equal(accepted.status,'completed');assert.equal(accepted.report.ingestion.completedIntervals,6);
  assert.equal(f.state.tables.query.size,17);assert.equal(f.state.tables.agg.size,17);
  assert(f.state.calls.filter(call=>call.payload.dimensions.length===3).every(call=>day(call.payload.endDate)-day(call.payload.startDate)<=2*86400000));
  // A three-day range itself over budget is still rejected; only another
  // independent complete range may commit. This is not whole-month acceptance.
  const limited=jobsFixture({helper:helperWithByteCounter(json=>JSON.parse(json).length*14000000),env:{WEB_SYNC_RECENT_DAYS:'17'}});
  limited.state.queryRows=(_url,p)=>rowsForDates(p);
  const partial=await limited.jobs.executeWebSync();assert.equal(partial.status,'failed');
  assert.equal(partial.report.ingestion.failedIntervals,5);assert.equal(partial.report.ingestion.completedIntervals,1);
  assert.equal(limited.state.tables.query.size,2);
  assert([...limited.state.tables.query.values()].every(row=>row.date>='2026-10-17'));
  assert(partial.report.errors.every(error=>error.message==='search_console_interval_budget_exceeded'));
});

test('a late property or SQL failure rolls back only its three-day range with all properties, and retry is idempotent', async () => {
  for(const failure of ['property','sql']) {
    const f=jobsFixture({sites:2,env:{WEB_SYNC_RECENT_DAYS:'18'}});f.state.queryRows=(_url,p)=>rowsForDates(p);
    if(failure==='property')f.state.failQueries=(url,p)=>url.includes('other1')&&p.startDate==='2026-10-04';
    else f.state.failWrite=2;
    const first=await f.jobs.executeWebSync();assert.equal(first.status,'failed');
    assert.equal(first.report.ingestion.completedIntervals,5);assert.equal(first.report.ingestion.failedIntervals,1);
    assert.equal(f.state.tables.query.size,15);assert.equal(f.state.tables.agg.size,15);
    assert([...f.state.tables.query.values()].every(row=>row.date<'2026-10-04'||row.date>'2026-10-06'));
    assert([...f.state.tables.query.values()].every(row=>row.clicks===2));
    f.state.failQueries=null;f.state.failWrite=0;
    const retry=await f.jobs.executeWebSync();assert.equal(retry.status,'completed');
    assert.equal(retry.report.ingestion.inserted,3);assert.equal(retry.report.ingestion.unchanged,15);
    assert.equal(f.state.tables.query.size,18);assert.equal(f.state.tables.agg.size,18);
    assert([...f.state.tables.agg.values()].every(row=>row.queries_top3===1&&row.queries_top10===1));
    const unchanged=await f.jobs.executeWebSync();assert.equal(unchanged.report.ingestion.written,0);
  }
});
