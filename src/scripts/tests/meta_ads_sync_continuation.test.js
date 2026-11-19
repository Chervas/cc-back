'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const { Op, fn, col } = require('sequelize');
const continuation = require('../../lib/metaAdsSyncContinuation');
const { safeError, validateJobFilters } = require('../../services/metaMarketingAdsReader.service');
const source = fs.readFileSync(require.resolve('../../jobs/sync.jobs'), 'utf8');
const quiet = { log() {}, warn() {}, error() {} };
const range = { startDate: '2026-11-01', endDate: '2026-11-03' };
const asset = id => ({ id, metaConnectionId: id < 400 ? 173 : 172, assetType: 'ad_account',
  metaAssetId: String(100000 + id), assignmentScope: 'clinic', clinicaId: 70, grupoClinicaId: null });
function fixture() {
  const state = { now: Date.UTC(2026, 10, 19, 12), assets: [359, 391, 406, 409].map(asset), runs: [],
    preparations: [], asserts: [], logs: [], countQueries: [], limitedId: 406, cooldownUntil: 0,
    blocked: new Set(), providerCalls: 0 };
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [state.now])); }
    static now() { return state.now; }
  }
  const models = { Clinica: {}, SyncLog: {
    async create(value) {
      if (value.asset_id != null && value.asset_id === state.failedSuccessLogId) throw Error('local_success_log_unavailable');
      const row = { ...value, id: state.logs.length + 1,
        async update(patch) { Object.assign(row, patch); } };
      state.logs.push(row); return row;
    },
    async count(options) {
      state.countQueries.push(options);
      return state.logs.filter(row => row.asset_id === options.where.asset_id
        && row.clinica_id === options.where.clinica_id && row.status === 'completed'
        && row.status_report?.metaAdsAccountDigest === options.where['status_report.metaAdsAccountDigest']).length;
    },
  },
  ClinicMetaAsset: { findAll: async () => state.assets },
  MetaMarketingBrokerBinding: { findAll: async () => state.assets.map(row => ({ mapping_id: row.id })) } };
  const reader = { safeError, validateJobFilters, forModels: () => ({ async sourceForAsset(id) {
    state.preparations.push(id);
    return { async assert() { state.asserts.push(id); if (state.blocked.has(id)) throw Object.assign(Error('asset_revoked'), { code: 'asset_revoked' }); },
      usage: () => ({ usagePct: 0, nextAllowedAt: 0, pauseUntil: state.cooldownUntil }) };
  } }) };
  const modules = { sequelize: { Op, fn, col }, axios: { create: () => ({}) }, '../../models': models,
    '../lib/metaAdsSyncContinuation': continuation,
    '../services/metaMarketingAdsReader.service': reader,
    '../controllers/metasync.controller': { async syncAdAccountMetrics(value, token, start, end, options) {
      assert.equal(token, null); await options.adsSource.assert();
      state.runs.push({ id: value.id, start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) });
      if (state.cooldownUntil > state.now) throw Object.assign(Error('rate_limited'), {
        code: 'rate_limited', retryAfterMs: state.cooldownUntil - state.now });
      state.providerCalls++;
      if (state.limitedId === value.id) {
        state.cooldownUntil = state.now + 7200000;
        throw Object.assign(Error('rate_limited'), { code: 'rate_limited', retryAfterMs: 7200000 });
      }
      return { status: 'completed', entities: 1, insightsRows: 2, actionsRows: 1 };
    } } };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, Date: Clock, Map, Set, URL, URLSearchParams,
    process: { env: { JOBS_AUTO_START: 'false', RUNTIME_ROLE: 'gateway', META_MARKETING_ADS_SYNC_ENABLED: 'true',
      META_MARKETING_BROKER_ENABLED: 'true' } }, console: quiet,
    setTimeout: () => assert.fail('no waiting sleep in this fixture'),
    require: name => modules[name] || {} });
  const job = module.exports.metaSyncJobs;
  job.config.ads.betweenAccountsSleepMs = 0;
  job._buildMetaAssignmentContext = async () => ({ mode: 'manual', clinicaId: 70 });
  return { state, job };
}
function resumed(request, result) {
  return { ...request, status: 'running', attempts: 2, next_run_at: new Date(result.nextAllowedAt), result_summary: result };
}
const cases = [
  ['executeAdsSync', 'meta_ads_recent', {}],
  ['executeAdsSync', 'meta_ads_midday', { windowLabel: 'midday' }],
  ['executeAdsBackfill', 'meta_ads_backfill', {}],
];
for (const [method, type, defaults] of cases) {
  test(`${type} resumes only unfinished accounts in the identical window after a durable quota wait`, async () => {
    const { state, job } = fixture(), request = { id: 123, type, result_summary: null };
    const first = await job[method]({ ...defaults, ...range }, continuation.contextForJob(request));
    assert.equal(first.status, 'waiting'); assert.equal(first.reason, 'rate_limited');
    assert.deepEqual(state.runs.map(row => row.id), [359, 391, 406]);
    assert.equal(state.providerCalls, 3); assert.equal(first.nextAllowedAt, state.now + 7200000);
    assert.deepEqual(first[continuation.KEY].completedMappingIds, [359, 391]);
    assert.equal(state.logs.filter(row => row.asset_id === 406).length, 0, 'partial work is not completed evidence');
    Object.assign(request, resumed(request, JSON.parse(JSON.stringify(first))));
    state.runs.length = 0; state.preparations.length = 0; state.asserts.length = 0;
    state.now = first.nextAllowedAt + 1000; state.limitedId = null;
    const second = await job[method]({ ...defaults, ...range }, continuation.contextForJob(request, state.now));
    assert.equal(second.status, 'completed'); assert.equal(second.processed, 2); assert.equal(second.resumedSkipped, 2);
    assert.deepEqual(state.runs.map(row => row.id), [406, 409]);
    assert.deepEqual(state.preparations, [359, 391, 406, 409], 'completed accounts are locally reauthorized, not blindly skipped');
    assert(state.asserts.includes(359) && state.asserts.includes(391));
    assert(state.runs.every(row => row.start === range.startDate && row.end === range.endDate));
    assert.deepEqual(second[continuation.KEY].completedMappingIds, [359, 391, 406, 409]);
    assert.equal(second[continuation.KEY].cohort, undefined);
    assert(!JSON.stringify(second[continuation.KEY]).includes(state.assets[0].metaAssetId), 'provider account IDs are never persisted in the checkpoint');
    const successful = state.logs.filter(row => row.asset_id);
    assert.deepEqual(successful.map(row => row.asset_id), [359, 391, 406, 409]);
    assert(successful.every(row => /^[a-f0-9]{64}$/.test(row.status_report.metaAdsAccountDigest)
      && row.records_processed === 3 && row.status === 'completed'));
  });
}

test('a retry across midnight freezes implicit dates and skips provider work already completed', async () => {
  const { state, job } = fixture(), request = { id: 124, type: 'meta_ads_recent' };
  const first = await job.executeAdsSync({}, continuation.contextForJob(request));
  const originalWindows = structuredClone(first[continuation.KEY].windows);
  assert(originalWindows.every(row => row.endDate === '2026-11-18' && row.startDate === '2026-10-20'));
  Object.assign(request, resumed(request, first)); state.now += 86400000; state.limitedId = null; state.runs.length = 0;
  const second = await job.executeAdsSync({}, continuation.contextForJob(request, state.now));
  assert.deepEqual(second[continuation.KEY].windows, originalWindows);
  assert.deepEqual(state.runs.map(row => row.id), [406, 409]);
  assert(state.runs.every(row => row.end === '2026-11-18' && row.start === '2026-10-20'));
});

test('an attempt before the persisted WAIT deadline cannot create a resume context or contact the provider', async () => {
  const { state, job } = fixture(), request = { id: 125, type: 'meta_ads_recent' };
  const first = await job.executeAdsSync(range, continuation.contextForJob(request)), before = state.providerCalls;
  Object.assign(request, resumed(request, first)); state.runs.length = 0;
  assert.throws(() => continuation.contextForJob(request, state.now), { code: 'meta_ads_continuation_invalid' });
  assert.equal(state.providerCalls, before); assert.deepEqual(state.runs, []);
  assert.deepEqual(first[continuation.KEY].completedMappingIds, [359, 391]);
});

test('payload continuation claims cannot skip work and an arbitrary second argument is rejected', async () => {
  const { state, job } = fixture(); state.limitedId = null;
  const forged = { version: 1, completedMappingIds: [359, 391, 406, 409] };
  const result = await job.executeAdsSync({ ...range, [continuation.KEY]: forged, result_summary: { [continuation.KEY]: forged } });
  assert.equal(result.status, 'completed'); assert.deepEqual(state.runs.map(row => row.id), [359, 391, 406, 409]);
  assert.equal(result[continuation.KEY], undefined, 'manual payload is not persisted scheduler authority');
  state.runs.length = 0;
  await assert.rejects(job.executeAdsSync(range, { type: 'meta_ads_recent', previous: forged }), { code: 'meta_ads_continuation_invalid' });
  assert.equal(state.runs.length, 0);
});

test('changed clinic filters, account identity, connection or active cohort fail closed before provider work', async () => {
  for (const mutate of [
    (f, options) => { options.clinicIds = [70]; },
    f => { f.state.assets[0].metaConnectionId = 999; },
    f => { f.state.assets[0].metaAssetId = '999'; },
    f => { f.state.assets.push(asset(410)); },
    f => { f.state.assets = f.state.assets.slice(1); },
    f => { f.state.assets[0].clinicaId = 71; },
  ]) {
    const f = fixture(), request = { id: 126, type: 'meta_ads_recent' };
    const first = await f.job.executeAdsSync(range, continuation.contextForJob(request));
    Object.assign(request, resumed(request, first)); f.state.now = first.nextAllowedAt + 1;
    const options = { ...range }; mutate(f, options); f.state.runs.length = 0;
    await assert.rejects(f.job.executeAdsSync(options, continuation.contextForJob(request, f.state.now)), { code: 'meta_ads_continuation_invalid' });
    assert.equal(f.state.runs.length, 0);
  }
});

test('a completed account whose permission was revoked is checked again and never treated as an authorized skip', async () => {
  const { state, job } = fixture(), request = { id: 127, type: 'meta_ads_recent' };
  Object.assign(request, resumed(request, await job.executeAdsSync(range, continuation.contextForJob(request))));
  state.now += 7200001; state.limitedId = null; state.blocked.add(359); state.runs.length = 0;
  const result = await job.executeAdsSync(range, continuation.contextForJob(request, state.now));
  assert.equal(result.status, 'failed'); assert(result.errors.some(row => row.assetId === 359 && row.error === 'asset_revoked'));
  assert.equal(result.resumedSkipped, 1); assert.deepEqual(state.runs.map(row => row.id), [406, 409]);
});

test('per-account successful evidence fixes initial-window detection without an unindexed global scan', async () => {
  const { state, job } = fixture(); state.limitedId = null;
  await job.executeAdsSync({}, continuation.contextForJob({ id: 128, type: 'meta_ads_recent' }));
  assert(state.runs.every(row => row.start === '2026-10-20' && row.end === '2026-11-18'));
  state.runs.length = 0;
  await job.executeAdsSync({}, continuation.contextForJob({ id: 129, type: 'meta_ads_recent' }));
  assert(state.runs.every(row => row.start === '2026-11-12' && row.end === '2026-11-18'));
  for (const options of state.countQueries) {
    assert.equal(options.where.clinica_id, 70); assert(Number.isInteger(options.where.asset_id));
    assert.match(options.where['status_report.metaAdsAccountDigest'], /^[a-f0-9]{64}$/); assert.equal(options.logging, false);
  }
});

test('malformed, cross-job, cross-type and oversized stored checkpoints cannot authorize a skip', async () => {
  const f = fixture(), request = { id: 130, type: 'meta_ads_recent' };
  const first = await f.job.executeAdsSync(range, continuation.contextForJob(request));
  f.state.now = first.nextAllowedAt + 1;
  for (const mutate of [
    value => { value.jobId = 131; }, value => { value.type = 'meta_ads_backfill'; },
    value => { value.completedMappingIds = [359, 999]; }, value => { value.completedMappingIds = [359, 359]; },
    value => { value.completedMappingIds = [391, 359]; }, value => { value.windows[0].startDate = '1900-01-01'; },
    value => { value.windows[0].endDate = '2026-02-30'; }, value => { value.windows[0].mappingId = 999; },
    value => { value.windows[0].url = 'https://example.invalid'; }, value => { value.skipPermissions = true; },
  ]) {
    const summary = structuredClone(first); mutate(summary[continuation.KEY]); f.state.runs.length = 0;
    await assert.rejects(f.job.executeAdsSync(range, continuation.contextForJob(resumed(request, summary), f.state.now)),
      { code: 'meta_ads_continuation_invalid' });
    assert.equal(f.state.runs.length, 0);
  }
  assert.throws(() => continuation.contextForJob({ ...request, result_summary: '{invalid' }), { code: 'meta_ads_continuation_invalid' });
});

test('the actual scheduler wrapper passes only the persisted result column through an opaque context', async () => {
  const executor = fs.readFileSync(require.resolve('../../services/jobExecutor.service'), 'utf8');
  const code = executor.slice(executor.indexOf('function buildScheduledJobHandlers()'), executor.indexOf('\nconst JOB_HANDLERS ='));
  let observed;
  const config = fixture().job.config.ads, assets = [asset(359)];
  const plan = continuation.createRun({ context: continuation.contextForJob({ id: 131, type: 'meta_ads_recent' }),
    type: 'meta_ads_recent', options: range, adsConfig: config, assets });
  plan.initialize([{ mappingId: 359, ...range }]); plan.complete(359);
  const handlers = vm.runInNewContext(code + '\nbuildScheduledJobHandlers()', {
    SCHEDULED_JOB_DEFINITIONS: { ads: { type: 'meta_ads_recent', executorMethod: 'executeAdsSync' } },
    metaSyncJobs: { executeAdsSync: async (options, context) => { observed = continuation.createRun({ context,
      type: 'meta_ads_recent', options, adsConfig: config, assets }); return { status: 'completed' }; } },
    require: name => { assert.equal(name, '../lib/metaAdsSyncContinuation'); return continuation; },
  });
  const persisted = { status: 'waiting', reason: 'rate_limited', nextAllowedAt: Date.now() - 1000, ...plan.result() };
  await handlers.meta_ads_recent({ ...range, [continuation.KEY]: { completedMappingIds: [] } },
    resumed({ id: 131, type: 'meta_ads_recent' }, JSON.parse(JSON.stringify(persisted))));
  assert.equal(observed.isCompleted(359), true);
});

test('terminal results and a first attempt never recycle completed account claims as a resumed WAIT', async () => {
  const { job, state } = fixture(), request = { id: 132, type: 'meta_ads_recent' };
  const first = await job.executeAdsSync(range, continuation.contextForJob(request)), due = first.nextAllowedAt + 1;
  const valid = resumed(request, first);
  for (const change of [{ status: 'pending' }, { attempts: 1 }, { next_run_at: new Date(first.nextAllowedAt + 1000) },
    { result_summary: { ...first, status: 'completed' } }, { result_summary: { ...first, reason: 'other' } }]) {
    assert.throws(() => continuation.contextForJob({ ...valid, ...change }, due), { code: 'meta_ads_continuation_invalid' });
  }
  assert(state.providerCalls > 0);
});

test('calendar dates use the cron civil timezone and UTC day arithmetic across DST', () => {
  const cases = [
    ['2026-07-01T23:45:00Z', false, '2026-07-01'], ['2026-07-01T23:45:00Z', true, '2026-07-02'],
    ['2026-03-29T01:30:00Z', false, '2026-03-28'], ['2026-10-25T01:30:00Z', false, '2026-10-24'],
  ];
  for (const [now, includeToday, expected] of cases) {
    assert.equal(continuation.calendarEnd({ now: Date.parse(now), timeZone: 'Europe/Madrid', includeToday }).toISOString(), expected + 'T00:00:00.000Z');
  }
  assert.throws(() => continuation.calendarEnd({ timeZone: 'not/a/timezone' }));
});

test('a fresh Node process reconstructs the resume from persisted JSON without the original opaque context', async () => {
  const { job, state } = fixture(), request = { id: 133, type: 'meta_ads_recent' };
  const first = await job.executeAdsSync(range, continuation.contextForJob(request));
  const persisted = JSON.parse(JSON.stringify(first));
  // MySQL's JSON normalization can reorder object keys; the checksum pins the
  // canonical tuple, not the serializer's incidental property order.
  persisted[continuation.KEY].windows = persisted[continuation.KEY].windows.map(row => ({
    endDate: row.endDate, mappingId: row.mappingId, startDate: row.startDate,
  }));
  const script = `
    const fs = require('node:fs'), C = require(process.argv[1]);
    const input = JSON.parse(fs.readFileSync(0, 'utf8'));
    const run = C.createRun({context:C.contextForJob(input.job, input.now),
      type:input.job.type, options:input.options, adsConfig:input.adsConfig, assets:input.assets});
    process.stdout.write(JSON.stringify({pending:input.assets.filter(row => !run.isCompleted(row.id)).map(row=>row.id), windows:run.windows}));
  `;
  const actual = JSON.parse(execFileSync(process.execPath, ['-e', script, require.resolve('../../lib/metaAdsSyncContinuation')], {
    input: JSON.stringify({ job: resumed(request, persisted), now: first.nextAllowedAt + 1,
      options: range, adsConfig: { ...job.config.ads, timeZone: job.config.timezone }, assets: state.assets }),
    env: { TZ: 'Europe/Madrid' }, encoding: 'utf8', timeout: 5000,
  }));
  assert.deepEqual(actual.pending, [406, 409]);
  assert.deepEqual(actual.windows, JSON.parse(JSON.stringify(first[continuation.KEY].windows)));
});

test('a failed local success record never becomes a completed-account checkpoint', async () => {
  const { state, job } = fixture(), request = { id: 134, type: 'meta_ads_recent' };
  state.failedSuccessLogId = 359;
  const first = await job.executeAdsSync(range, continuation.contextForJob(request));
  assert.equal(first.status, 'waiting');
  assert.deepEqual(first[continuation.KEY].completedMappingIds, [391]);
  assert(first.errors.some(row => row.assetId === 359));
  state.failedSuccessLogId = null; state.limitedId = null; state.now = first.nextAllowedAt + 1; state.runs.length = 0;
  const second = await job.executeAdsSync(range, continuation.contextForJob(resumed(request, first), state.now));
  assert.equal(second.status, 'completed');
  assert.deepEqual(state.runs.map(row => row.id), [359, 406, 409]);
});

test('persisted WAIT dates survive DATETIME(0) precision without shortening the provider cooldown', async () => {
  for (const [method, type, defaults] of cases) {
    const { state, job } = fixture(), request = { id: 135, type };
    state.now += 966;
    const first = await job[method]({ ...defaults, ...range }, continuation.contextForJob(request));
    assert.equal(first.nextAllowedAt % 1000, 0);
    assert(first.nextAllowedAt >= state.cooldownUntil && first.nextAllowedAt - state.cooldownUntil < 1000);
    const persisted = resumed(request, JSON.parse(JSON.stringify(first)));
    persisted.next_run_at = new Date(Math.floor(+persisted.next_run_at / 1000) * 1000);
    const providerCalls = state.providerCalls;
    assert.throws(() => continuation.contextForJob(persisted, first.nextAllowedAt - 1), { code: 'meta_ads_continuation_invalid' });
    assert.equal(state.providerCalls, providerCalls);
    state.now = first.nextAllowedAt; state.limitedId = null; state.runs.length = 0;
    const second = await job[method]({ ...defaults, ...range }, continuation.contextForJob(persisted, state.now));
    assert.equal(second.status, 'completed');
    assert.deepEqual(state.runs.map(row => row.id), [406, 409]);
  }
});
