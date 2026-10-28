'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { jobsFixture } = require('./web_search_console_ingest.test');
const Cut = require('../../lib/searchConsoleLegacyDetailCut');
const { createSearchConsoleAnalytics } = require('../../services/searchConsoleAnalytics.service');
const CUT = { SC_ANALYTICS_LEGACY_DETAIL_CUT_ENABLED: 'true', SC_ANALYTICS_WRITE_ENABLED: 'true', SC_ANALYTICS_READ_ENABLED: 'true' };
function compact() {
  const requests = new Map(), writes = [], confirmations = [];
  const store = { writes, confirmations, async writeInterval(request) { return commit(request, 'detail'); },
    async writeTotalsInterval(request) { return commit(request, 'totals'); },
    async confirmPublication(proof) {
      const request = requests.get(proof.batchId); assert.ok(request);
      assert.deepEqual(JSON.parse(JSON.stringify(proof)), request);
      confirmations.push(proof);
      return { ...request, committed: true, detailComplete: request.kind === 'detail', totalsComplete: request.kind === 'totals' };
    } };
  async function commit(request, kind) {
    await request.validate(); const batchId = randomUUID();
    requests.set(batchId, { batchId, siteUrl: request.siteUrl, startDate: request.startDate, endDate: request.endDate, kind });
    writes.push({ ...request, kind, batchId }); return { committed: true, batchId };
  }
  return store;
}
test('explicit cut stays off independently of compact WRITE/READ; invalid cut dependencies fail before job writes', async () => {
  const normal = jobsFixture({ env: { SC_ANALYTICS_WRITE_ENABLED: 'true' }, storage: compact() });
  assert.equal((await normal.jobs.executeWebSync()).status, 'completed'); assert.equal(normal.state.tables.query.size, 1);
  for (const missing of ['SC_ANALYTICS_READ_ENABLED', 'SC_ANALYTICS_WRITE_ENABLED']) {
    const f = jobsFixture({ env: { ...CUT, [missing]: 'false' }, storage: compact() });
    await assert.rejects(f.jobs.executeWebSync(), { code: 'search_console_cut_requires_compact_read_write' });
    assert.equal(f.state.calls.length, 0); assert.equal(f.state.tables.query.size, 0); assert.equal(f.state.tables.daily.size, 0);
  }
});
test('actual multi-property sync confirms all compact publications then skips only mass legacy detail, retaining independent small summaries', async () => {
  const storage = compact(), f = jobsFixture({ sites: 2, storage, env: CUT });
  assert.equal((await f.jobs.executeWebSync()).status, 'completed');
  assert.equal(f.state.tables.query.size, 0); assert.equal(f.state.tables.daily.size, 2); assert.equal(f.state.tables.agg.size, 1);
  assert.equal([...f.state.tables.agg.values()][0].queries_top3, 1);
  assert.equal(storage.confirmations.length, 4); assert.equal(storage.writes.length, 4);
  assert.equal((await f.jobs.executeWebSync()).report.ingestion.legacyDetailRowsSkipped, 1);
  assert.equal(f.state.tables.query.size, 0); assert.deepEqual(f.state.writes, []);
});
test('unproven ACK or database publication for either property stops without recreating legacy detail', async () => {
  for (const kind of ['ack', 'db']) {
    const storage = compact(), write = storage.writeInterval, confirm = storage.confirmPublication;
    if (kind === 'ack') storage.writeInterval = async request => request.siteUrl.includes('other1') ? { committed: false } : write(request);
    else storage.confirmPublication = async proof => proof.siteUrl.includes('other1') ? { committed: true } : confirm(proof);
    const f = jobsFixture({ sites: 2, storage, env: CUT }); const result = await f.jobs.executeWebSync();
    assert.equal(result.status, 'failed'); assert.equal(f.state.tables.query.size, 0); assert.equal(f.state.tables.agg.size, 0);
    assert.deepEqual(f.state.writes, []);
  }
});
test('all active mappings must match the selected clinic universe, so a targeted subset cannot retire mixed legacy facts', async () => {
  const storage = compact(), f = jobsFixture({ sites: 2, storage, env: CUT });
  const load = f.models.ClinicWebAsset.findAll;
  f.models.ClinicWebAsset.findAll = async options => { const all = await load(options); return options?.where?.clinicaId ? all : all.slice(0, 1); };
  assert.equal((await f.jobs.executeWebSync()).status, 'failed'); assert.equal(f.state.tables.query.size, 0); assert.equal(f.state.tables.agg.size, 0);
});
test('final-data lag with an empty future tail is accepted without invented coverage; a row beyond confirmed final dates fails', async () => {
  const storage = compact(), f = jobsFixture({ storage, env: { ...CUT, WEB_SYNC_RECENT_DAYS: '3' } });
  f.state.timeseriesRows = () => [{ keys: ['2026-10-16'], clicks: 1, impressions: 3, position: 2 }];
  f.state.queryRows = () => [{ keys: ['2026-10-16', 'one', ''], clicks: 1, impressions: 3, position: 2 }];
  assert.equal((await f.jobs.executeWebSync()).status, 'completed');
  assert(storage.writes.every(r => r.endDate === '2026-10-16'));
  assert.equal(f.state.tables.query.size, 0);
  f.state.queryRows = () => [{ keys: ['2026-10-17', 'not final', ''], clicks: 1, impressions: 3, position: 2 }];
  assert.equal((await f.jobs.executeWebSync()).status, 'failed'); assert.equal(f.state.tables.query.size, 0);
});
test('empty final timeseries and empty queries do not invent coverage or fail solely because today is not final', async () => {
  const storage = compact(), f = jobsFixture({ storage, env: CUT });
  f.state.timeseriesRows = () => []; f.state.queryRows = () => [];
  assert.equal((await f.jobs.executeWebSync()).status, 'completed'); assert.equal(storage.writes.length, 0);
  assert.equal(storage.confirmations.length, 0); assert.equal(f.state.tables.query.size, 0); assert.equal(f.state.tables.agg.size, 0);
});
test('configuration drift after a compact ACK fails before legacy or aggregate publication', async () => {
  let env; const storage = compact(), confirm = storage.confirmPublication;
  storage.confirmPublication = async proof => { const result = await confirm(proof); env.SC_ANALYTICS_READ_ENABLED = 'false'; return result; };
  const f = jobsFixture({ storage, env: CUT, cutHelper: { ...Cut, captureCutPolicy: input => { env = input; return Cut.captureCutPolicy(input); } } });
  assert.equal((await f.jobs.executeWebSync()).status, 'failed'); assert.equal(f.state.tables.query.size, 0); assert.equal(f.state.tables.agg.size, 0);
});
test('both full and targeted backfill paths reuse the cut writer and cannot repopulate detail', async () => {
  for (const targeted of [false, true]) {
    const storage = compact(), f = jobsFixture({ storage, env: CUT });
    const result = targeted ? await f.jobs.executeWebBackfillForSites([{ clinicId: 71, siteUrl: 'https://example.invalid/' }]) : await f.jobs.executeWebBackfill();
    assert.equal(result.status, 'completed'); assert.equal(f.state.tables.query.size, 0); assert.equal(f.state.tables.daily.size, 1);
    assert.equal(storage.confirmations.length, 2);
  }
});
test('actual repository verifies committed scope and coverage rather than trusting an ACK boolean', async () => {
  const batchId = randomUUID(), siteUrl = 'sc-domain:publication-fixture.example';
  const proof = { batchId, siteUrl, startDate: '2026-10-01', endDate: '2026-10-03', kind: 'detail' };
  const b = { batch_id: batchId, property_id: 4, start_date: proof.startDate, end_date: proof.endDate, kind: 'detail', state: 'committed', committed_at: new Date() };
  let covered = 3, writes = 0;
  const sql = { async transaction(work) { return work({}); }, async query(q) {
    if (/^(INSERT|UPDATE|DELETE)/.test(q)) writes++;
    if (q.startsWith('SELECT id,site_url')) return [[{ id: 4, site_url: siteUrl, revision: 5 }]];
    if (q.startsWith('SELECT * FROM ScAnalyticsIngestBatches')) return [[b]];
    if (q.startsWith('SELECT COUNT(*) AS covered')) return [[{ covered }]];
    throw Error('Unexpected offline SQL');
  } };
  const repo = createSearchConsoleAnalytics({ sequelize: sql, env: CUT });
  assert.equal((await repo.confirmPublication(proof, { validate: async () => true })).detailComplete, true); assert.equal(writes, 0);
  b.state = 'staging'; await assert.rejects(repo.confirmPublication(proof, { validate: async () => true }), { code: 'sc_analytics_publication_unproven' });
  b.state = 'committed'; covered = 2;
  await assert.rejects(repo.confirmPublication(proof, { validate: async () => true }), { code: 'sc_analytics_incomplete_coverage' });
  covered = 3; b.start_date = '2026-09-01';
  await assert.rejects(repo.confirmPublication(proof, { validate: async () => true }), { code: 'sc_analytics_publication_unproven' }); assert.equal(writes, 0);
});
