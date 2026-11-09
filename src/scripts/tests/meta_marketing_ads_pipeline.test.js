'use strict';
// Actual controller/job code, isolated SQL models and a typed broker double.
// No application bootstrap, MySQL, provider HTTP or process environment changes.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Op, fn, col } = require('sequelize');
const { buildClinicMatcher } = require('../../lib/clinicAttribution');
const { createMetaMarketingAdsReader, safeError, validateJobFilters } = require('../../services/metaMarketingAdsReader.service');
const A = require('../../../services/integrations-broker/src/meta-marketing-ads-contract');
const controllerSource = fs.readFileSync(require.resolve('../../controllers/metasync.controller'), 'utf8');
const jobsSource = fs.readFileSync(require.resolve('../../jobs/sync.jobs'), 'utf8');
const quiet = { log() {}, warn() {}, error() {} };
const fail = code => Object.assign(Error(code), { code });
const clone = value => JSON.parse(JSON.stringify(value));
const range = { startDate: '2026-11-01', endDate: '2026-11-01' };

function readerFixture() {
  const context = Object.freeze({});
  const state = { commands: [], asserts: 0, enabled: true, blocked: false };
  const expected = { kind: 'ad_account', id: '301', connectionRef: 'meta:fixture', assetRef: 'meta-ad_account:301', tenantRef: 'clinic:11' };
  const scope = { prepare: async () => context, assertContext: async actual => {
    assert.equal(actual, context); state.asserts++;
    if (state.blocked) throw fail('asset_revoked');
    return expected;
  } };
  const client = { execute: async command => {
    state.commands.push(command);
    const data = state.data || { results: [], nextPageToken: null, usage: { usagePct: 3, nextAllowedAt: 0, pauseUntil: 0 } };
    await state.onCommand?.(command);
    return { requestId: command.requestId, data };
  } };
  const reader = createMetaMarketingAdsReader({ scope, client, enabled: () => state.enabled });
  return { reader, state };
}

test('typed reader requires opt-in and validates payload before contacting the broker', async () => {
  const f = readerFixture(); f.state.enabled = false;
  await assert.rejects(() => f.reader.prepare(1), { code: 'meta_ads_sync_disabled' });
  assert.equal(f.state.asserts, 0); assert.equal(f.state.commands.length, 0);
  f.state.enabled = true; const context = await f.reader.prepare(1);
  await assert.rejects(() => f.reader.read(context, 'insights', { ...range, pageToken: null, accessToken: 'SENTINEL' }), { code: 'invalid_request' });
  await assert.rejects(() => f.reader.read(context, 'insights', { startDate: '2026-10-01', endDate: '2026-11-01', pageToken: null }), { code: 'invalid_request' });
  assert.equal(f.state.commands.length, 0);
});

test('typed reader pins identity to captured context and rejects revocation or extra credential fields after I/O', async () => {
  const f = readerFixture(); const context = await f.reader.prepare(1);
  const result = await f.reader.read(context, 'campaigns', { pageToken: null });
  assert.equal(result.results.length, 0);
  const command = f.state.commands[0];
  assert.equal(command.operation, A.OPERATIONS.campaigns);
  assert.equal(command.assetRef, 'meta-ad_account:301'); assert.equal(command.tenantRef, 'clinic:11');
  assert.deepEqual(command.payload, { pageToken: null });
  f.state.data = { ...result, accessToken: 'SENTINEL' };
  await assert.rejects(() => f.reader.read(context, 'campaigns', { pageToken: null }), { code: 'broker_response_invalid' });
  f.state.data = result; f.state.onCommand = () => { f.state.blocked = true; };
  await assert.rejects(() => f.reader.read(context, 'campaigns', { pageToken: null }), { code: 'asset_revoked' });
});

test('reader does not retry a rate limit or disclose the provider error payload', async () => {
  const f = readerFixture(); f.state.onCommand = () => { throw Object.assign(fail('rate_limited'), { config: { token: 'SENTINEL' }, retryAfterMs: 7200000 }); };
  const source = await f.reader.sourceForAsset(1);
  await assert.rejects(() => source.readPage('campaigns', { pageToken: null }), error => {
    assert.equal(error.code, 'rate_limited'); assert.equal(error.retryAfterMs, 7200000);
    assert.equal(error.retryable, false); assert(!JSON.stringify(error).includes('SENTINEL')); return true;
  });
  assert.equal(f.state.commands.length, 1);
});

function persistenceFixture() {
  const state = { blocked: false, writes: 0, legacy: 0, requests: [], entities: new Map(), insights: new Map(), actions: [], stats: new Map(), promotions: [], transactions: 0, rollbacks: 0, actionsDeletes: 0, insightSequence: 0 };
  const dataset = {
    campaigns: [{ id: '401', name: '**Clínica Uno** Campaña', status: 'ACTIVE' }],
    adsets: [{ id: '402', name: 'Conjunto', campaign_id: '401', status: 'ACTIVE' }],
    ads: [{ id: '403', name: 'Anuncio', adset_id: '402', campaign_id: '401', status: 'ACTIVE', creative: { id: '404', effective_instagram_media_id: '405' } }],
    insights: [
      { ad_id: '403', date_start: '2026-11-01', publisher_platform: 'facebook', platform_position: 'feed', impressions: '100', reach: '50', clicks: '4', inline_link_clicks: '3', spend: '12.50' },
      { ad_id: '403', date_start: '2026-11-01', publisher_platform: 'instagram', platform_position: 'story', impressions: '40', reach: '30', clicks: '2', inline_link_clicks: '1', spend: '3.50' },
    ],
    actions: [{ ad_id: '403', date_start: '2026-11-01', publisher_platform: 'facebook', actions: [{ action_type: 'lead', value: '2' }] }],
  };
  let activeTransaction = null;
  const assertActive = async options => {
    if (activeTransaction) {
      assert.equal(options?.transaction, activeTransaction, 'every SQL-window guard must reuse its caller transaction');
      activeTransaction.guards++; activeTransaction.guardedWrites = state.writes;
    } else assert.equal(options, undefined);
    if (state.blocked) throw fail('asset_revoked');
  };
  const assertDataTransaction = options => {
    assert.equal(options?.transaction, activeTransaction);
    assert(activeTransaction?.guards > 0, 'full authority must be guarded before the first data query');
  };
  const sequelize = {
    query: async (sql, options) => { if (activeTransaction) assertDataTransaction(options); state.writes++; return [[], 0]; },
    transaction: async (options, callback) => {
      assert.equal(options.isolationLevel, 'REPEATABLE READ');
      assert.equal(activeTransaction, null);
      activeTransaction = { fixture: true, LOCK: { UPDATE: 'UPDATE' }, guards: 0, guardedWrites: null };
      state.transactions++; const before = { actions: clone(state.actions), insights: clone([...state.insights]) };
      try { const result = await callback(activeTransaction);
        assert(activeTransaction.guards >= 2);
        assert.equal(activeTransaction.guardedWrites, state.writes, 'full authority must be rechecked after the final data write');
        return result; }
      catch (error) { state.actions = before.actions; state.insights = new Map(before.insights); state.rollbacks++; throw error; }
      finally { activeTransaction = null; }
    },
  };
  const models = {
    Clinica: { findByPk: async () => ({ id_clinica: 11, nombre_clinica: 'Clínica Uno' }) }, GrupoClinica: {},
    SocialAdsEntity: { sequelize, upsert: async row => { state.writes++; state.entities.set(row.entity_id, clone(row)); } },
    SocialAdsInsightsDaily: { sequelize, upsert: async (row, options) => {
      assertDataTransaction(options); state.writes++;
      const key = [row.entity_id, row.date, row.publisher_platform, row.platform_position].join('|');
      state.insights.set(key, { id: state.insights.get(key)?.id || ++state.insightSequence, ...clone(row) });
      await state.onInsightsUpsert?.();
    }, findAll: async options => { if (options.transaction) assertDataTransaction(options); return [...state.insights.values()].filter(row => {
      const dates = options.where.date;
      return typeof dates === 'string' ? row.date === dates : row.date >= dates[Op.between][0] && row.date <= dates[Op.between][1];
    }); }, destroy: async options => {
      assertDataTransaction(options); state.writes++;
      for (const [key, row] of state.insights) if (options.where.id[Op.in].includes(row.id)) state.insights.delete(key);
    } },
    SocialAdsActionsDaily: { sequelize, destroy: async options => {
      assertDataTransaction(options); state.writes++; state.actionsDeletes++;
      const dates = options.where.date[Op.in]; state.actions = state.actions.filter(row => !dates.includes(row.date));
    }, bulkCreate: async (rows, options) => { assertDataTransaction(options); state.writes++; state.actions.push(...clone(rows)); await state.onActionsInsert?.(); } },
    SocialAdsAdsetDailyAgg: { sequelize, destroy: async options => { assertDataTransaction(options); state.writes++; } },
    SocialStatsDaily: { findAll: async ({ where }) => [...state.stats.values()].filter(row => row.asset_id === where.asset_id && row.asset_type === where.asset_type && row.date === where.date), findOne: async ({ where }) => {
      const key = `${where.clinica_id}:${where.asset_id}:${where.date}`;
      return state.stats.has(key) ? { update: async row => { state.writes++; state.stats.set(key, { ...state.stats.get(key), ...clone(row) }); } } : null;
    }, create: async row => { state.writes++; state.stats.set(`${row.clinica_id}:${row.asset_id}:${row.date}`, clone(row)); } },
    SocialPosts: { findOne: async options => options.where.asset_type === 'instagram_business' ? { id: 9, asset_type: 'instagram_business' } : null },
    PostPromotions: { findOne: async () => null, create: async row => { state.writes++; state.promotions.push(clone(row)); } },
    AdAttributionIssue: { update: async () => { state.writes++; }, findOrCreate: async () => [{ update: async () => {} }, true] },
  };
  const source = { assert: assertActive, async *pages(family, requestedRange) {
    assert.equal(activeTransaction, null, 'provider reads must stay outside persistence transactions');
    state.requests.push({ family, range: clone(requestedRange || {}) }); await state.onFamily?.(family);
    if (state.failFamily === family) throw fail('provider_failed');
    yield dataset[family];
    if (state.failSecondPage === family) throw fail('provider_failed');
  } };
  const module = { exports: {} };
  vm.runInNewContext(controllerSource, { module, exports: module.exports, Date, Map, Set, process: { env: {} }, console: quiet,
    require: name => {
      if (name === '../../models') return models;
      if (name === 'sequelize') return { Op, fn, col };
      if (name === '../lib/clinicAttribution') return { buildClinicMatcher };
      if (name === '../lib/metaQuarantineHttp') return { create: () => ({ get: () => { state.legacy++; throw Error('legacy_forbidden'); } }) };
      if (name === '../lib/metaClient') return { metaGet: () => { state.legacy++; throw Error('legacy_forbidden'); } };
      throw Error('unexpected_controller_import:' + name);
    } });
  const asset = { id: 1, metaAssetId: '301', clinicaId: 11, grupoClinicaId: null };
  const run = (options = {}) => module.exports.syncAdAccountMetrics(asset, null, new Date(options.startDate || range.startDate), new Date(options.endDate || range.endDate),
    { assignment: { mode: 'manual', clinicaId: 11 }, adsSource: source, ...options });
  return { state, dataset, source, asset, run };
}

test('actual Ads pipeline preserves dimensions, attribution, post linkage and idempotent metrics/actions', async () => {
  const f = persistenceFixture(); const result = await f.run();
  assert.equal(result.status, 'completed'); assert.equal(result.entities, 3); assert.equal(result.insightsRows, 2); assert.equal(result.actionsRows, 1);
  assert.equal(f.state.entities.size, 3); assert.equal(f.state.insights.size, 2); assert.equal(f.state.actions.length, 1);
  assert.deepEqual([...f.state.insights.values()].map(row => [row.clinica_id, row.publisher_platform, row.platform_position]), [[11, 'facebook', 'feed'], [11, 'instagram', 'story']]);
  const stats = [...f.state.stats.values()][0]; assert.equal(stats.spend_facebook, 12.5); assert.equal(stats.spend_instagram, 3.5);
  assert.equal(f.state.promotions[0].effective_instagram_media_id, '405'); assert.equal(f.state.legacy, 0);
  await f.run(); assert.equal(f.state.insights.size, 2); assert.equal(f.state.actions.length, 1);
});

test('group attribution still inherits the campaign token instead of assigning every group row to the pivot clinic', async () => {
  const f = persistenceFixture(); f.asset.clinicaId = null; f.asset.grupoClinicaId = 5;
  const matcher = buildClinicMatcher([{ id_clinica: 11, nombre_clinica: 'Clínica Uno' }, { id_clinica: 12, nombre_clinica: 'Clínica Dos' }]);
  await f.run({ assignment: { mode: 'group-auto', groupId: 5, matcher } });
  for (const row of f.state.insights.values()) { assert.equal(row.clinica_id, 11); assert.equal(row.grupo_clinica_id, 5); assert.equal(row.clinic_match_source, 'campaign'); }
});

test('a complete empty snapshot clears old Ads metrics/actions and zeros only the owned paid aggregate fields', async () => {
  const f = persistenceFixture(); await f.run();
  const statsKey = [...f.state.stats.keys()][0];
  f.state.stats.get(statsKey).followers = 424;
  const organic = { clinica_id: 11, asset_id: 99, asset_type: 'facebook_page', date: '2026-11-01', followers: 1000, reach_facebook: 50 };
  f.state.stats.set('11:99:2026-11-01', clone(organic));
  f.dataset.insights = []; f.dataset.actions = [];
  const result = await f.run();
  assert.equal(result.status, 'completed'); assert.equal(result.insightsRows, 0); assert.equal(result.actionsRows, 0);
  assert.equal(f.state.insights.size, 0); assert.equal(f.state.actions.length, 0);
  const aggregate = f.state.stats.get(statsKey);
  for (const key of ['spend_facebook', 'spend_instagram', 'reach_facebook', 'reach_instagram', 'impressions_facebook', 'impressions_instagram']) assert.equal(aggregate[key], 0);
  assert.equal(aggregate.followers, 424); assert.deepEqual(f.state.stats.get('11:99:2026-11-01'), organic);
});

test('a complete narrower snapshot removes stale dimensions while retaining the upsert identity of the surviving row', async () => {
  const f = persistenceFixture(); await f.run();
  const kept = [...f.state.insights.values()].find(row => row.publisher_platform === 'facebook');
  f.dataset.insights = [f.dataset.insights[0]];
  await f.run();
  assert.equal(f.state.insights.size, 1); assert.equal([...f.state.insights.values()][0].id, kept.id);
  const aggregate = [...f.state.stats.values()][0]; assert.equal(aggregate.spend_facebook, 12.5); assert.equal(aggregate.spend_instagram, 0);
});

test('an interrupted insights page never replaces or clears the previous complete snapshot', async () => {
  const f = persistenceFixture(); await f.run(); const before = clone([...f.state.insights]);
  f.dataset.insights[0].spend = '99.99'; f.state.failSecondPage = 'insights';
  await assert.rejects(() => f.run(), { code: 'provider_failed' });
  assert.deepEqual([...f.state.insights], before); assert.equal([...f.state.stats.values()][0].spend_facebook, 12.5);
});

test('revocation after an insights upsert rolls back the complete window before its SQL commit', async () => {
  const f = persistenceFixture(); await f.run(); const before = clone([...f.state.insights]);
  f.dataset.insights[0].spend = '99.99'; f.state.onInsightsUpsert = () => { f.state.blocked = true; };
  await assert.rejects(() => f.run(), { code: 'asset_revoked' });
  assert.deepEqual([...f.state.insights], before); assert.equal(f.state.rollbacks, 1);
});

test('a failed page propagates failure and never replaces actions with partial results', async () => {
  const f = persistenceFixture(); f.state.actions = [{ date: '2026-11-01', value: 99 }]; f.state.failSecondPage = 'actions';
  await assert.rejects(() => f.run(), { code: 'provider_failed' });
  assert.equal(f.state.actions.length, 1); assert.equal(f.state.actions[0].value, 99); assert.equal(f.state.actionsDeletes, 0);
});

test('revocation between actions delete/insert and commit rolls back the replacement', async () => {
  const f = persistenceFixture(); f.state.actions = [{ date: '2026-11-01', value: 99 }];
  f.state.onActionsInsert = () => { f.state.blocked = true; };
  await assert.rejects(() => f.run(), { code: 'asset_revoked' });
  assert.equal(f.state.rollbacks, 1); assert.equal(f.state.actions[0].value, 99);
});

test('revocation before the first persisted row prevents all business writes', async () => {
  const f = persistenceFixture(); f.state.onFamily = () => { f.state.blocked = true; };
  await assert.rejects(() => f.run(), { code: 'asset_revoked' }); assert.equal(f.state.writes, 0);
});

test('a real empty account is successful only after all five typed read families complete', async () => {
  const f = persistenceFixture(); for (const family of Object.keys(f.dataset)) f.dataset[family] = [];
  const result = await f.run(); assert.equal(result.status, 'completed'); assert.equal(result.entities, 0);
  assert.deepEqual(f.state.requests.map(row => row.family), ['campaigns', 'adsets', 'ads', 'insights', 'actions']);
  f.state.failFamily = 'insights'; await assert.rejects(() => f.run(), { code: 'provider_failed' });
});

test('a range spanning Madrid DST is divided into complete, nonoverlapping windows of at most three UTC dates', async () => {
  const f = persistenceFixture(); for (const family of Object.keys(f.dataset)) f.dataset[family] = [];
  await f.run({ startDate: '2026-10-24', endDate: '2026-10-27' });
  for (const family of ['insights', 'actions']) assert.deepEqual(f.state.requests.filter(row => row.family === family).map(row => row.range), [
    { startDate: '2026-10-24', endDate: '2026-10-26' }, { startDate: '2026-10-27', endDate: '2026-10-27' },
  ]);
});

function jobFixture() {
  const state = { assets: [{ id: 1, metaConnectionId: 2, assetType: 'ad_account', metaAssetId: '301', metaAssetName: 'Ficticia', clinicaId: 11, grupoClinicaId: null }], bindings: [{ mapping_id: 1 }], selections: [], runs: [], logs: [], preparations: [] };
  for (const key of ['pageAccessToken', 'metaConnection', 'additionalData']) Object.defineProperty(state.assets[0], key, { get: () => assert.fail('credential access: ' + key) });
  const models = { Clinica: {}, SyncLog: { create: async () => ({ update: async patch => state.logs.push(patch) }), count: async () => 1 },
    ClinicMetaAsset: { findAll: async options => { state.selections.push(options); return state.assets; } },
    MetaMarketingBrokerBinding: { findAll: async () => state.bindings } };
  const env = { JOBS_AUTO_START: 'false', RUNTIME_ROLE: 'gateway', META_MARKETING_ADS_SYNC_ENABLED: 'true', META_MARKETING_BROKER_ENABLED: 'true' };
  const reader = { safeError, validateJobFilters, forModels: () => ({ sourceForAsset: async id => {
    state.preparations.push(id); if (state.prepareError) throw state.prepareError;
    return { assert: async () => {}, usage: () => ({ usagePct: 0, nextAllowedAt: 0, pauseUntil: 0 }) };
  } }) };
  const modules = { sequelize: { Op, fn, col }, axios: { create: () => ({}) }, '../../models': models,
    '../services/metaMarketingAdsReader.service': reader,
    '../controllers/metasync.controller': { syncAdAccountMetrics: async (...args) => {
      state.runs.push(args); if (state.runError) throw state.runError;
      return { status: 'completed', entities: 1, insightsRows: 2, actionsRows: 1 };
    } } };
  const module = { exports: {} };
  vm.runInNewContext(jobsSource, { module, exports: module.exports, Date, Map, Set, URL, URLSearchParams,
    process: { env }, console: quiet, setTimeout: () => assert.fail('unexpected timer'), require: name => modules[name] || {} });
  const job = module.exports.metaSyncJobs; job.config.ads.betweenAccountsSleepMs = 0;
  job._buildMetaAssignmentContext = async () => ({ mode: 'manual', clinicaId: 11 });
  return { job, state, env };
}

test('recent and backfill jobs select metadata only, use active bindings and pass no legacy credentials', async () => {
  for (const method of ['executeAdsSync', 'executeAdsBackfill']) {
    const f = jobFixture(); const result = await f.job[method](range);
    assert.equal(result.status, 'completed'); assert.equal(result.processed, 1); assert.equal(f.state.runs[0][1], null);
    assert(!f.state.selections[0].attributes.some(key => /token|additionalData/i.test(key)));
    assert.equal(f.state.selections[0].include.length, 1); assert.equal(f.state.preparations.length, 1);
    f.state.bindings = []; const skipped = await f.job[method](range);
    assert.equal(skipped.skipped, true); assert.equal(skipped.reason, 'meta_ads_not_enrolled');
    assert.equal(f.state.preparations.length, 1);
  }
});

test('job failures and quota pauses are visible rather than reported as completed accounts', async () => {
  for (const method of ['executeAdsSync', 'executeAdsBackfill']) {
    const f = jobFixture(); f.state.runError = fail('provider_failed');
    let result = await f.job[method](range); assert.equal(result.status, 'failed'); assert.equal(result.processed, 0);
    assert.equal(f.state.logs.at(-1).status, 'failed'); assert.equal(result.retryable, false);
    f.state.runError = Object.assign(fail('rate_limited'), { retryAfterMs: 7200000 });
    result = await f.job[method](range); assert.equal(result.status, 'waiting'); assert.equal(result.reason, 'rate_limited');
    assert(result.nextRunAt.getTime() > Date.now() + 7100000); assert.equal(result.processed, 0);
    // Exercise the actual executor's resolver: it consumes nextAllowedAt, not nextRunAt.
    const executorSource = fs.readFileSync(require.resolve('../../services/jobExecutor.service'), 'utf8');
    const resolverSource = executorSource.slice(executorSource.indexOf('function resolveNextRun('), executorSource.indexOf('\nasync function runJob(', executorSource.indexOf('function resolveNextRun(')));
    const resolve = vm.runInNewContext(resolverSource + '\nresolveNextRun', { Date, Number, DEFAULT_WAITING_BACKOFF_MS: 900000 });
    assert.equal(resolve({ pauseUntil: result.nextAllowedAt }).getTime(), result.nextRunAt.getTime());
    f.env.META_MARKETING_ADS_SYNC_ENABLED = 'false'; const before = f.state.selections.length;
    result = await f.job[method](range); assert.equal(result.skipped, true); assert.equal(f.state.selections.length, before);
  }
});

test('malformed clinic/group filters fail before selecting accounts instead of widening the collection scope', async () => {
  for (const method of ['executeAdsSync', 'executeAdsBackfill']) {
    const f = jobFixture();
    for (const filters of [{ groupIds: ['bad'] }, { clinicIds: [0] }, { groupIds: 5 }, { clinicIds: [null] }]) {
      await assert.rejects(() => f.job[method]({ ...range, ...filters }), { code: 'invalid_request' });
    }
    assert.equal(f.state.selections.length, 0); assert.equal(f.state.preparations.length, 0);
  }
});
