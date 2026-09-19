'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'); const assert = require('node:assert/strict');
const { analyticsFixture, analyticsReport } = require('./fixtures/analytics_broker.fixture');
const { loadBusinessProfileJobs } = require('./fixtures/business_profile_jobs.fixture');
const range = { startDate: '2026-09-01', endDate: '2026-09-02' };
test('GA managed contexts contain no credentials and require the exact active binding and external-token metadata', async () => {
  const f = analyticsFixture(); const context = await f.service.prepare(f.mapping); assert.deepEqual(context, {});
  const report = await f.service.read(f.mapping, context, 'daily', range); assert.equal(report.rows[0].metricValues[0].value, '3');
  assert.equal(f.state.metadataReads, 9); assert.equal(f.state.calls[0].assetRef, 'ga4:123'); assert.equal(f.state.calls[0].tenantRef, 'clinic:71');
  await assert.rejects(f.service.read(f.mapping, {}, 'daily', range), { code: 'broker_binding_invalid' });
  for (const payload of [{ ...range, propertyName: 'properties/999' }, { ...range, pageToken: null }, { ...range, endDate: '2026-02-30' }])
    await assert.rejects(f.service.read(f.mapping, context, 'daily', payload), { code: 'invalid_request' });
  f.state.enabled = false; await assert.rejects(f.service.prepare(f.mapping), { code: 'broker_cohort_disabled' }); assert.equal(f.state.calls.length, 1);
});
test('GA independent markers prohibit fallback after mapping/connection deletion, recreation or rebinding', async () => {
  for (const change of [f => { f.state.mapping = null; }, f => { f.state.mapping.id = 92; }, f => { f.state.mapping.clinicaId = 72; },
    f => { f.state.mapping.googleConnectionId = 82; }, f => { f.state.mapping.propertyName = 'properties/999'; }, f => { f.state.mapping.isActive = false; },
    f => { f.state.mapping.broker_read_asset_ref = null; }, f => { f.state.record = null; }, f => { f.state.record.state = 'blocked'; },
    f => { f.state.record.google_user_id = 'foreign'; }, f => { f.state.connection = null; }, f => { f.state.connection.credentials_external = 0; }]) {
    const f = analyticsFixture(); change(f); await assert.rejects(f.create().prepare(f.mapping)); assert.equal(f.state.calls.length, 0);
  }
  const f = analyticsFixture(); f.state.record = null; f.state.mapping.broker_read_connection_ref = null; f.state.mapping.broker_read_asset_ref = null;
  assert.equal(await f.service.prepare(f.mapping), null); f.state.record = f.record;
  await assert.rejects(f.service.prepare(f.mapping), { code: 'broker_binding_invalid' });
});
test('GA pagination aggregates the full rowCount and excludes cursor/provider metadata outside the contract', async () => {
  const f = analyticsFixture(); const context = await f.service.prepare(f.mapping);
  f.state.response = command => ({ ...analyticsReport('city', { count: command.payload.pageToken ? 2 : 500, total: 502, offset: command.payload.pageToken ? 500 : 0 }),
    nextPageToken: command.payload.pageToken ? null : 'FICTITIOUS_CURSOR', rowLimitReached: false, privateToken: 'FICTITIOUS_HIDDEN' });
  const result = await f.service.read(f.mapping, context, 'city', range);
  assert.equal(result.rows.length, 502); assert.equal(result.rowCount, 502); assert.equal(result.rowLimitReached, false); assert.equal(f.state.calls.length, 2);
  assert(!JSON.stringify(result).includes('FICTITIOUS_CURSOR')); assert(!JSON.stringify(result).includes('FICTITIOUS_HIDDEN'));
});
test('GA accepts an independently registered clinic mapping without inheriting another mapping grant', async () => {
  const f = analyticsFixture(); f.state.otherBindings = [{ ...f.record, mapping_id: 191, clinica_id: 72, state: 'blocked' }];
  const context = await f.service.prepare(f.mapping); await f.service.read(f.mapping, context, 'daily', range);
  assert.equal(f.state.calls[0].tenantRef, 'clinic:71');
  f.state.record = null; f.state.mapping.broker_read_connection_ref = null; f.state.mapping.broker_read_asset_ref = null;
  await assert.rejects(f.service.prepare(f.mapping), { code: 'broker_binding_invalid' });
  assert.equal(f.state.calls.length, 1);
});
test('GA pagination rejects cross-page duplicates, changed cardinality/metadata and dishonest termination', async () => {
  for (const mutate of [r => { r.rows[0].dimensionValues[1].value = 'FICTITIOUS_DIMENSION_0'; }, r => { r.rowCount = 503; },
    r => { r.metadata.currencyCode = 'USD'; }, r => { r.nextPageToken = 'FICTITIOUS_MORE'; }, r => { r.rowLimitReached = true; }]) {
    const f = analyticsFixture(); const context = await f.service.prepare(f.mapping);
    f.state.response = c => { const next = !!c.payload.pageToken; const r = { ...analyticsReport('city', { count: next ? 2 : 500, total: 502, offset: next ? 500 : 0 }),
      nextPageToken: next ? null : 'FICTITIOUS_CURSOR', rowLimitReached: false }; if (next) mutate(r); return r; };
    await assert.rejects(f.service.read(f.mapping, context, 'city', range), { code: 'broker_response_invalid' }); assert.equal(f.state.calls.length, 2);
  }
});
test('GA reaches the original 100,000-row ceiling and reports provider rows beyond it', async () => {
  const f = analyticsFixture(); const context = await f.service.prepare(f.mapping); let offset = 0;
  f.state.response = () => { const previous = offset; offset += 500; return { ...analyticsReport('city', { count: 500, total: 100001, offset: previous }),
    nextPageToken: offset === 100000 ? null : 'FICTITIOUS_CURSOR_' + offset, rowLimitReached: offset === 100000 }; };
  const result = await f.service.read(f.mapping, context, 'city', range); assert.equal(result.rows.length, 100000);
  assert.equal(result.rowCount, 100001); assert.equal(result.rowLimitReached, true); assert.equal(f.state.calls.length, 200);
});
test('GA block, deadline and metadata failures discard the response with fixed errors', async () => {
  for (const [mutate, code] of [[f => { f.state.record.state = 'blocked'; }, 'broker_binding_invalid'],
    [f => { f.state.at += 450000; }, 'broker_timeout'], [f => { f.state.sqlFailure = true; }, 'analytics_read_failed']]) {
    const f = analyticsFixture(); const context = await f.service.prepare(f.mapping); f.state.afterCall = () => mutate(f);
    await assert.rejects(f.service.read(f.mapping, context, 'daily', range), error => error.code === code && error.message === code && !error.response);
  }
});
test('GA does not dispatch after metadata consumes the remaining aggregate deadline', async () => {
  const f = analyticsFixture(); const context = await f.service.prepare(f.mapping);
  f.state.beforeMappingRead = () => { f.state.at += 450000; };
  await assert.rejects(f.service.read(f.mapping, context, 'daily', range), { code: 'broker_timeout' });
  assert.equal(f.state.calls.length, 0);
});
function jobFixture() {
  const f = analyticsFixture(); const persisted = []; const updates = [];
  const models = { ClinicAnalyticsProperty: { findAll: async () => [f.mapping] }, WebGaDaily: { upsert: async r => persisted.push(r) },
    WebGaDimensionDaily: { upsert: async r => persisted.push(r) }, SyncLog: { create: async () => ({ update: async r => updates.push(r) }) } };
  const deny = () => assert.fail('GA managed jobs cannot load credentials or call legacy providers');
  const jobs = loadBusinessProfileJobs({ models, analytics: f.service, legacyHttp: { post: deny }, credentials: { load: deny, request: deny }, logs: f.state.logs,
    env: { ANALYTICS_SYNC_RECENT_DAYS: '1', ANALYTICS_BACKFILL_DAYS: '1' } }).metaSyncJobs;
  return { ...f, jobs, persisted, updates };
}
test('actual analytics sync and both backfills use all nine broker families and retain the historical business DTO', async () => {
  for (const method of ['executeAnalyticsSync', 'executeAnalyticsBackfill', 'executeAnalyticsBackfillForProperties']) {
    const f = jobFixture(); const result = await f.jobs[method]([{ clinicId: 71, propertyId: 91 }]);
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.report.rows, 1); assert.equal(result.report.dimensionRows, 8);
    assert.equal(result.report.dataQuality.length, 9); assert.equal(result.report.dataQuality[0].currencyCode, 'EUR');
    assert.equal(f.persisted.length, 9); assert.equal(f.persisted[0].conversions, 2); assert.equal(f.persisted[0].total_revenue, -12.5);
    assert.equal(f.state.calls.length, 9); assert.equal(f.updates.at(-1).status, 'completed');
  }
});
test('a revoked binding between GA families marks the property failed and prevents later sends or legacy fallback', async () => {
  const f = jobFixture(); f.state.afterCall = () => { if (f.state.calls.length === 2) f.state.record.state = 'blocked'; };
  const result = await f.jobs.executeAnalyticsSync(); assert.equal(result.status, 'failed'); assert.equal(result.report.processedProperties, 0);
  assert.equal(f.state.calls.length, 2); assert.equal(f.persisted.length, 1); assert.equal(result.report.errors[0].message, 'broker_binding_invalid');
  assert.equal(f.updates.at(-1).status, 'failed');
});
test('GA stops a property when currency or timezone changes between report families', async () => {
  for (const patch of [{ currencyCode: 'USD' }, { timeZone: 'America/New_York' }]) {
    const f = jobFixture(); f.state.response = c => {
      const family = c.operation.slice('google.analytics.'.length).split('.')[0];
      const result = { ...analyticsReport(family, { start: c.payload.startDate }), nextPageToken: null, rowLimitReached: false };
      if (f.state.calls.length > 1) Object.assign(result.metadata, patch); return result;
    };
    const result = await f.jobs.executeAnalyticsSync(); assert.equal(result.status, 'failed'); assert.equal(f.persisted.length, 1);
    assert.equal(result.report.errors[0].message, 'broker_response_invalid'); assert.equal(f.state.calls.length, 2);
  }
});
