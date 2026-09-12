'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { Op } = require('sequelize');
const helpers = require('../../lib/googleAdsSyncHelpers');
const { daysBetween } = require('../../services/googleAdCache.service');
const syncSource = fs.readFileSync(require.resolve('../../jobs/sync.jobs'), 'utf8');
const searchOutput = { exports: {} };
vm.runInNewContext(fs.readFileSync(require.resolve('../../lib/googleAdsSearchRows'), 'utf8'), {
  module: searchOutput, exports: searchOutput.exports, Date,
  require: () => ({ normalizeCustomerId: value => String(value).replace(/-/g, '') }),
});
const baseAccount = { id: 11, customerId: '1234567890', googleConnectionId: 2, assignmentScope: 'group',
  grupoClinicaId: 5, clinicaId: 59, isActive: true, loginCustomerId: '9876543210', timeZone: 'Europe/Madrid' };
const window = { startDate: '2026-09-09', endDate: '2026-09-10' };

function fixture() {
  const state = { accounts: [{ ...baseAccount }], collections: [], saves: [], ads: [], requests: [], logs: [], synced: [], tokenReads: 0, inventory: [] };
  const models = { ClinicGoogleAdsAccount: { findAll: async () => state.accounts,
    update: async (patch, options) => { state.synced.push({ patch, options }); return [1]; } },
  SyncLog: { create: async () => ({ id: 8, update: async patch => state.logs.push(patch) }) },
  ExternalCampaignInventory: { upsert: async value => state.inventory.push(value) } };
  const metrics = { API_VERSION: 'v24', collectGoogleCampaignMetrics: async options => {
    state.collections.push(options); if (state.collectionError) throw state.collectionError; return { account: options.account, start: options.start, end: options.end };
  }, persistGoogleCampaignMetrics: async options => { state.saves.push(options); if (state.saveError) throw state.saveError; return { rows: 4 }; } };
  const ads = { daysBetween, syncGoogleAdCache: async options => {
    state.ads.push(options); if (state.adError) throw state.adError;
    await options.request('POST', `customers/${options.account.customerId}/googleAds:search`, { data: { query: 'SELECT campaign.id FROM campaign' } });
    return { metricRows: 3, inventoryRows: 2, days: 2 };
  } };
  const client = { ensureGoogleAdsConfig: () => ({ managerId: baseAccount.loginCustomerId }),
    normalizeCustomerId: value => String(value || '').replace(/-/g, ''), formatCustomerId: String,
    getGoogleAdsUsageStatus: async () => ({ pauseUntil: null }),
    googleAdsRequest: async (method, path, options) => { state.requests.push({ method, path, options }); return state.response || {}; } };
  const modules = { sequelize: { Op }, axios: { create: () => ({}) }, '../../models': models,
    '../lib/googleAdsSyncHelpers': helpers, '../lib/googleAdsClient': client,
    '../lib/googleAdsSearchRows': searchOutput.exports,
    '../services/googleAdCache.service': ads, '../services/googleCampaignMetricsCache.service': metrics,
    '../services/notifications.service': { dispatchEvent: async () => {} } };
  const module = { exports: {} };
  vm.runInNewContext(syncSource, { module, exports: module.exports, Date, Map, Set, URL, URLSearchParams,
    process: { env: { JOBS_AUTO_START: 'false', RUNTIME_ROLE: 'gateway' } }, console: { log() {}, warn() {}, error() {} },
    setTimeout: () => { throw new Error('unexpected_job_timer'); }, require: name => modules[name] || {} });
  const job = module.exports.metaSyncJobs;
  job.config.googleAds.betweenAccountsSleepMs = 0;
  job._getGoogleAccessToken = async () => { state.tokenReads++; return 'synthetic'; };
  const publishing = job._syncGoogleAdsPublishingState.bind(job);
  job._syncGoogleAdsPublishingState = async () => ({ rows: 2 });
  return { state, models, metrics, ads, job, publishing };
}

test('recent and backfill jobs use the reconciled writer once per shared customer', async () => {
  for (const method of ['executeGoogleAdsSync', 'executeGoogleAdsBackfill']) {
    const f = fixture();
    f.state.accounts.push({ ...baseAccount, id: 20, customerId: '123-456-7890', assignmentScope: 'clinic' });
    const result = await f.job[method](window);
    assert.equal(result.status, 'completed'); assert.equal(result.accounts, 1); assert.equal(result.duplicateMappings, 1);
    assert.equal(result.processed, 1); assert.equal(result.rows, 7); assert.equal(f.state.tokenReads, 1);
    assert.equal(f.state.saves.length, 1); assert.equal(f.state.saves[0].useGroupAttribution, true);
    assert.equal(f.state.collections[0].start, window.startDate); assert.equal(f.state.collections[0].end, window.endDate);
    assert.equal(f.state.requests[0].options.apiVersion, 'v24'); assert.match(f.state.requests[0].path, /googleAds:search$/);
    assert.equal(f.state.synced.length, 1); assert.equal(f.state.logs.at(-1).status, 'completed');
    assert.equal(result.syncLogId, 8);
  }
});

test('both jobs honor exact customer scope and reject malformed filters before token access', async () => {
  for (const method of ['executeGoogleAdsSync', 'executeGoogleAdsBackfill']) {
    const f = fixture(); f.state.accounts.push({ ...baseAccount, id: 30, customerId: '9999999999' });
    await f.job[method]({ ...window, customerIds: ['123-456-7890'] });
    assert.equal(f.state.collections.length, 1); assert.equal(f.state.collections[0].account.customerId, baseAccount.customerId);
    for (const key of ['customerIds', 'clinicIds', 'groupIds']) {
      const bad = fixture(); await assert.rejects(bad.job[method]({ ...window, [key]: ['bad'] }), /google_ads_invalid/);
      assert.equal(bad.state.tokenReads, 0); assert.equal(bad.state.logs.at(-1).status, 'failed');
    }
  }
});

test('conflicting owners are reported instead of being fetched once per clinic', async () => {
  const f = fixture(); f.state.accounts.push({ ...baseAccount, id: 20, grupoClinicaId: 9 });
  const result = await f.job.executeGoogleAdsSync({ ...window, groupIds: [5] });
  assert.equal(result.status, 'failed'); assert.equal(result.processed, 0); assert.equal(result.accounts, 1);
  assert.equal(f.state.tokenReads, 0); assert.equal(f.state.logs.at(-1).status, 'failed');
});

test('a clinic-scoped refresh of a shared customer uses its existing group owner without selecting extra accounts', async () => {
  const f = fixture(); f.state.accounts[0].clinicaId = 36;
  f.state.accounts.push({ ...baseAccount, id: 20, assignmentScope: 'clinic', clinicaId: 59 });
  f.state.accounts.push({ ...baseAccount, id: 30, customerId: '9999999999', clinicaId: 36 });
  const result = await f.job.executeGoogleAdsSync({ ...window, clinicIds: [59] });
  assert.equal(result.status, 'completed'); assert.equal(f.state.collections.length, 1);
  assert.equal(f.state.collections[0].account.id, 11); assert.equal(f.state.collections[0].account.customerId, baseAccount.customerId);
});

test('partial metrics never fall back to click-only rows or mark the account synchronized', async () => {
  for (const method of ['executeGoogleAdsSync', 'executeGoogleAdsBackfill']) {
    const f = fixture(); f.state.collectionError = Object.assign(Error('invalid Google query'), { response: { data: { error: { status: 'INVALID_ARGUMENT' } } } });
    const result = await f.job[method](window);
    assert.equal(result.status, 'failed'); assert.equal(f.state.saves.length, 0); assert.equal(f.state.ads.length, 0);
    assert.equal(f.state.collections.length, 1); assert.equal(f.state.synced.length, 0); assert.equal(f.state.logs.at(-1).status, 'failed');
  }
});

test('a failed ad phase retains metric progress without recording complete account synchronization', async () => {
  const f = fixture(); f.state.adError = Error('ad_schema_not_ready');
  const result = await f.job.executeGoogleAdsSync(window);
  assert.equal(result.status, 'failed'); assert.equal(f.state.saves.length, 1); assert.equal(f.state.synced.length, 0);
  assert.equal(f.state.logs.at(-1).status, 'failed');
  assert.equal(result.errors[0].progress.persistedMetricsRows, 4);
});

test('a failed destination audit does not stop independent caches or masquerade as a complete refresh', async () => {
  const f = fixture(); f.job._syncGoogleAdsPublishingState = async () => ({ rows: 2, destinationError: Error('destination_read_failed') });
  const result = await f.job.executeGoogleAdsSync(window);
  assert.equal(f.state.saves.length, 1); assert.equal(f.state.ads.length, 1);
  assert.equal(result.status, 'failed'); assert.equal(result.errors[0].error, 'destination_read_failed');
  assert.equal(result.errors[0].progress.persistedInventoryRows, 2); assert.equal(f.state.synced.length, 0);
  assert.equal(result.errors[0].progress.adCache.metricRows, 3);
  assert.equal(result.errors[0].progress.adCache.inventoryRows, 2);
});

test('the default nightly window refreshes both 30-day comparison periods', async () => {
  const f = fixture(); f.job.config.googleAds.recentDays = 7;
  const result = await f.job.executeGoogleAdsSync({});
  assert.equal(result.status, 'completed'); assert.equal(result.windowDays, 60);
  assert.equal(f.state.collections.length, 1);
  assert.equal(daysBetween(f.state.collections[0].start, f.state.collections[0].end).length, 60);
});

test('a mixed batch distinguishes partial success in its durable log and return value', async () => {
  const f = fixture(); f.state.accounts.push({ ...baseAccount, id: 30, customerId: '9999999999' });
  f.metrics.collectGoogleCampaignMetrics = async options => { if (options.account.id === 30) throw Error('provider_failed'); return options; };
  const result = await f.job.executeGoogleAdsSync(window);
  assert.equal(result.status, 'completed_with_errors'); assert.equal(result.partial, true); assert.equal(result.processed, 1);
  assert.equal(f.state.logs.at(-1).status, 'failed'); assert.equal(f.state.logs.at(-1).status_report.status, 'completed_with_errors');
});

test('an account changed during the run cannot receive a fresh sync timestamp', async () => {
  const f = fixture(); f.models.ClinicGoogleAdsAccount.update = async (_patch, options) => {
    assert.equal(options.where.isActive, true); assert.equal(options.where.googleConnectionId, baseAccount.googleConnectionId);
    assert.equal(options.where.assignmentScope, baseAccount.assignmentScope); assert.equal(options.where.grupoClinicaId, baseAccount.grupoClinicaId);
    return [0];
  };
  const result = await f.job.executeGoogleAdsSync(window);
  assert.equal(result.status, 'failed'); assert.equal(result.processed, 0); assert.equal(result.errors[0].error, 'google_ads_account_changed');
});

test('180-day backfill uses consecutive bounded snapshots and only marks completion after every phase', async () => {
  const f = fixture();
  const result = await f.job.executeGoogleAdsBackfill({ endDate: window.endDate, windowDays: 180 });
  assert.equal(result.status, 'completed'); assert.equal(f.state.saves.length, 3);
  const windows = f.state.collections.flatMap(row => daysBetween(row.start, row.end));
  assert.equal(windows.length, 180); assert.equal(new Set(windows).size, 180); assert.equal(windows.at(-1), window.endDate);
  assert.equal(f.state.ads.length, 1); assert.equal(f.state.synced.length, 1);
});

test('publishing observation rejects partial pagination without changing inventory or publishing metadata', async () => {
  const f = fixture(); let updates = 0;
  f.state.response = { partialFailureError: { code: 3 }, results: [{ campaign: { id: '456' } }] };
  await assert.rejects(f.publishing({ ...baseAccount, update: async () => updates++ }, { accessToken: 'synthetic', effectiveLoginCustomerId: '9876543210' }),
    { code: 'GOOGLE_ADS_SEARCH_INCOMPLETE' });
  assert.equal(updates, 0); assert.equal(f.state.inventory.length, 0); assert.equal(f.state.requests[0].options.apiVersion, 'v24');
});

test('sync dates follow the account calendar across Madrid DST and reject open or malformed ranges', () => {
  assert.equal(helpers.googleAdsSyncWindow({}, baseAccount, 7, new Date('2026-09-11T22:30:00Z')).end, '2026-09-11');
  assert.equal(helpers.googleAdsSyncWindow({}, { timeZone: 'America/Los_Angeles' }, 7, new Date('2026-09-11T22:30:00Z')).end, '2026-09-10');
  for (const now of ['2026-03-29T22:30:00Z', '2026-10-25T23:30:00Z']) {
    const range = helpers.googleAdsSyncWindow({}, baseAccount, 7, new Date(now));
    assert.equal(daysBetween(range.start, range.end).length, 7);
  }
  for (const bad of [{ windowDays: 0 }, { windowDays: 999 }, { windowDays: 1.5 }, { endDate: '2026-09-12' },
    { startDate: '2026-09-11', endDate: '2026-09-10' }, { startDate: '2026-02-30' }]) {
    assert.throws(() => helpers.googleAdsSyncWindow(bad, baseAccount, 7, new Date('2026-09-12T01:00:00Z')), /google_ads_invalid/);
  }
});
