'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'); const assert = require('node:assert/strict');
const { searchConsoleFixture } = require('./fixtures/search_console_broker.fixture');
const { loadBusinessProfileJobs } = require('./fixtures/business_profile_jobs.fixture');
const range = { startDate: '2026-09-01', endDate: '2026-09-02' };
test('managed SC context has no tokens and binds current mapping, independent registry and external credential metadata', async () => {
  const f = searchConsoleFixture(); const context = await f.service.prepare(f.mapping); assert.deepEqual(context, {});
  const result = await f.service.read(f.mapping, context, 'timeseries', range); assert.equal(result.data.rows[0].clicks, 2);
  assert(!JSON.stringify(result).includes('FICTITIOUS_HIDDEN')); assert.equal(f.state.calls.length, 1);
  await assert.rejects(f.service.read(f.mapping, {}, 'timeseries', range), { code: 'broker_binding_invalid' });
  f.state.enabled = false; await assert.rejects(f.service.prepare(f.mapping), { code: 'broker_cohort_disabled' });
  await assert.rejects(f.service.read(f.mapping, context, 'timeseries', range), { code: 'broker_cohort_disabled' });
  assert.equal(f.state.calls.length, 1);
});
test('deletion, recreation, changed owner/connection, missing markers and blocked state cannot fall back', async () => {
  for (const change of [f => { f.state.mapping = null; }, f => { f.state.mapping.id = 92; }, f => { f.state.mapping.clinicaId = 72; },
    f => { f.state.mapping.googleConnectionId = 82; }, f => { f.state.mapping.isActive = false; },
    f => { f.state.mapping.broker_read_asset_ref = null; }, f => { f.state.record = null; }, f => { f.state.record.state = 'blocked'; },
    f => { f.state.record.connection_ref = 'different'; }, f => { f.state.connection = { ...f.state.connection, credentials_external: 0 }; },
    f => { f.state.connection = null; }]) {
    const f = searchConsoleFixture(); change(f);
    await assert.rejects(f.create().prepare(f.mapping)); assert.equal(f.state.calls.length, 0);
  }
});
test('an unmarked mapping can select legacy, but partial or persistent managed markers prohibit downgrade', async () => {
  const f = searchConsoleFixture(); f.state.record = null; f.state.mapping.broker_read_connection_ref = null; f.state.mapping.broker_read_asset_ref = null;
  assert.equal(await f.service.prepare(f.mapping), null);
  f.state.record = f.record; await assert.rejects(f.service.prepare(f.mapping), { code: 'broker_binding_invalid' });
});
test('a changed binding or a failed caller revalidation discards the provider result', async () => {
  const f = searchConsoleFixture(); const context = await f.service.prepare(f.mapping); f.state.afterCall = () => { f.state.record.state = 'blocked'; };
  await assert.rejects(f.service.read(f.mapping, context, 'timeseries', range), { code: 'broker_binding_invalid' });
  const g = searchConsoleFixture(); const other = await g.service.prepare(g.mapping); let checks = 0;
  await assert.rejects(g.service.read(g.mapping, other, 'inspection', {}, { beforeExecute: async () => {
    if (++checks === 2) throw Object.assign(Error('search_console_scope_forbidden'), { code: 'search_console_scope_forbidden' });
  } }), { code: 'search_console_scope_forbidden' }); assert.equal(g.state.calls.length, 1);
});
test('pages and queries preserve all requested rows across bounded pages with a check around every send', async () => {
  const f = searchConsoleFixture(); const context = await f.service.prepare(f.mapping);
  f.state.response = ({ payload }) => ({ rows: Array.from({ length: payload.rowLimit }, (_, i) => ({ keys: ['https://example.invalid/p' + (payload.startRow + i)], clicks: 1 })) });
  const pages = await f.service.read(f.mapping, context, 'pages', { ...range, startRow: 42, rowLimit: 750 });
  assert.equal(pages.data.rows.length, 750); assert.deepEqual(f.state.calls.map(c => c.payload.startRow), [42, 542]);
  assert.deepEqual(f.state.calls.map(c => c.payload.rowLimit), [500, 250]);
  const g = searchConsoleFixture(); const second = await g.service.prepare(g.mapping); let checks = 0;
  g.state.response = ({ payload }) => ({ rows: Array.from({ length: payload.pageToken ? 2 : 500 }, (_, i) => ({ keys: [range.startDate, 'q' + (payload.pageToken ? 500 + i : i), 'https://example.invalid/'] })),
    nextPageToken: payload.pageToken ? null : 'FICTITIOUS_CURSOR', rowLimitReached: false });
  const queries = await g.service.read(g.mapping, second, 'queries', range, { beforeExecute: async () => { checks++; } });
  assert.equal(queries.data.rows.length, 502); assert.equal(queries.data.rowLimitReached, false); assert.equal(checks, 4);
  assert(!JSON.stringify(queries).includes('FICTITIOUS_CURSOR'));
});
test('query replay/duplicate rows and an exceeded aggregate deadline fail without returning a partial dataset', async () => {
  const f = searchConsoleFixture(); const context = await f.service.prepare(f.mapping);
  f.state.response = () => ({ rows: Array.from({ length: 500 }, (_, i) => ({ keys: [range.startDate, 'q' + i, 'https://example.invalid/'] })), nextPageToken: 'FICTITIOUS_CURSOR', rowLimitReached: false });
  await assert.rejects(f.service.read(f.mapping, context, 'queries', range), { code: 'broker_response_invalid' }); assert.equal(f.state.calls.length, 2);
  const g = searchConsoleFixture(); const second = await g.service.prepare(g.mapping); g.state.afterCall = () => { g.state.at += 450000; };
  await assert.rejects(g.service.read(g.mapping, second, 'pages', { ...range, rowLimit: 100, startRow: 0 }), { code: 'broker_timeout' });
});
test('actual web jobs and targeted backfills use the broker for all SC query families and never load a legacy token', async () => {
  for (const method of ['executeWebSync', 'executeWebBackfill', 'executeWebBackfillForSites']) {
    const f = searchConsoleFixture(); const rows = []; const updates = [];
    const models = { ClinicWebAsset: { findAll: async () => [f.mapping] }, SyncLog: { create: async () => ({ update: async value => updates.push(value) }) },
      WebScDaily: { findOrCreate: async ({ defaults }) => { rows.push(defaults); return [null, true]; } },
      WebScQueryDaily: { bulkCreate: async values => rows.push(...values) }, WebScDailyAgg: { findOrCreate: async ({ defaults }) => { rows.push(defaults); return [null, true]; } } };
    const jobs = loadBusinessProfileJobs({ models, searchConsole: f.service, credentials: { safe: () => 'unexpected_test_error',
      load: () => assert.fail('Managed jobs cannot load tokens'), request: () => assert.fail('Managed jobs cannot call Google') },
      legacyHttp: new Proxy({}, { get: () => () => assert.fail('Managed jobs cannot call legacy HTTP') }), logs: f.state.logs,
      env: { WEB_PSI_ENABLED: 'false', WEB_SYNC_RECENT_DAYS: '1', WEB_BACKFILL_DAYS: '1' } }).metaSyncJobs;
    const result = await jobs[method]([{ clinicId: 71, siteUrl: f.mapping.siteUrl }]);
    assert.equal(result.status, 'completed', JSON.stringify(result)); assert.equal(result.report.errors.length, 0);
    assert.equal(result.processed, 1); assert.equal(f.state.calls.length, 2); assert.equal(rows.length, 3); assert.equal(updates.at(-1).status, 'completed');
  }
});
