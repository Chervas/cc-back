'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'); const assert = require('node:assert/strict');
const { credentialsFixture } = require('./fixtures/google_legacy_credentials.fixture');
const { loadBusinessProfileJobs } = require('./fixtures/business_profile_jobs.fixture');
function fixture() {
  const f = credentialsFixture(); const updates = []; const persisted = [];
  const mappings = [{ id: 91, clinicaId: 71, googleConnectionId: 81, siteUrl: 'https://fictitious.invalid/', propertyName: 'properties/123' }];
  const persist = async values => { persisted.push(values); };
  const models = {
    SyncLog: { create: async () => ({ update: async value => updates.push(value) }) },
    ClinicWebAsset: { findAll: async () => mappings }, ClinicAnalyticsProperty: { findAll: async () => mappings },
    WebScDaily: { findOrCreate: async ({ defaults }) => { await persist(defaults); return [null, true]; } },
    WebScDailyAgg: { findOrCreate: async ({ defaults }) => { await persist(defaults); return [null, true]; } },
    WebGaDaily: { upsert: persist }, WebGaDimensionDaily: { upsert: persist },
    WebPsiSnapshot: { findOne: async () => null, create: persist },
  };
  const http = { post: async (url, body, options) => {
    f.state.provider.push({ url, body }); assert.equal(options.headers.Authorization, 'Bearer FICTITIOUS_accessToken_81');
    await f.state.onRequest?.(f.state.provider.length);
    if (url.includes('analyticsdata')) return { data: { rows: [{ dimensionValues: [{ value: '20260901' }, { value: 'fictitious-dimension' }],
      metricValues: [3, 2, 1, 0, 0].map(value => ({ value: String(value) })) }] } };
    return { data: { rows: body.dimensions.length === 1 ? [{ keys: ['2026-09-01'], clicks: 3, impressions: 10 }] : [] } };
  } };
  const { metaSyncJobs: jobs } = loadBusinessProfileJobs({ models, credentials: f.credentials, searchConsole: { prepare: async () => null }, legacyHttp: http, logs: f.state.logs,
    env: { WEB_PSI_ENABLED: 'false', WEB_SYNC_RECENT_DAYS: '1', WEB_BACKFILL_DAYS: '1', ANALYTICS_BACKFILL_DAYS: '1' } });
  return { ...f, jobs, mappings, updates, persisted };
}
test('actual web and analytics synchronization/backfill methods block managed rows with no provider call or token hydration', async () => {
  for (const method of ['executeWebSync', 'executeWebBackfill', 'executeWebBackfillForSites',
    'executeAnalyticsSync', 'executeAnalyticsBackfill', 'executeAnalyticsBackfillForProperties']) {
    const f = fixture(); f.mark(); const result = await f.jobs[method]([{ clinicId: 71, siteUrl: 'https://fictitious.invalid/', propertyId: 91 }]);
    assert.equal(result.status, 'failed', method); assert(result.report.errors.every(e => e.message === 'google_oauth_legacy_closed'));
    assert.equal(f.state.provider.length + f.state.loads + f.state.tokenReads + f.persisted.length, 0, method);
    assert.equal(f.updates.at(-1).status, 'failed');
  }
});
test('unmarked mappings still persist Search Console timeseries and all nine GA report families', async () => {
  const sc = fixture(); const result = await sc.jobs.executeWebSync();
  assert.equal(result.status, 'completed'); assert.equal(result.processed, 1); assert.equal(sc.state.provider.length, 2);
  assert.equal(sc.persisted[0].clicks, 3); assert.equal(sc.state.loads, 1);
  const ga = fixture(); const analytics = await ga.jobs.executeAnalyticsSync();
  assert.equal(analytics.status, 'completed'); assert.equal(analytics.report.rows, 1); assert.equal(analytics.report.dimensionRows, 8);
  assert.equal(ga.state.provider.length, 9); assert.equal(ga.persisted[0].sessions, 3);
});
test('registration during a Search Console result prevents persistence and cached subsequent query sends', async () => {
  const f = fixture(); f.state.onRequest = () => f.mark(); const result = await f.jobs.executeWebSync();
  assert.equal(result.status, 'failed'); assert.equal(f.state.provider.length, 1); assert.equal(f.persisted.length, 0);
  assert(result.report.errors.every(e => e.message === 'google_oauth_legacy_closed'));
});
test('registration between GA dimension reports aborts later sends and marks the property failed', async () => {
  const f = fixture(); f.state.onRequest = call => { if (call === 2) f.mark(); };
  const result = await f.jobs.executeAnalyticsSync(); assert.equal(result.status, 'failed');
  assert.equal(result.report.processedProperties, 0); assert.equal(f.state.provider.length, 2);
  assert.equal(f.persisted.length, 1); assert.equal(result.report.errors[0].message, 'google_oauth_legacy_closed');
});
test('metadata and provider failures produce fixed job reports and logs without arbitrary provider or SQL text', async () => {
  for (const method of ['executeWebSync', 'executeAnalyticsSync']) {
    const f = fixture(); f.state.failMetadata = true; const result = await f.jobs[method]();
    assert.equal(result.status, 'failed'); assert.equal(result.report.errors[0].message, 'google_credentials_unavailable');
    assert(!JSON.stringify([result, f.updates, f.state.logs]).includes('FICTITIOUS_SQL'));
  }
});
