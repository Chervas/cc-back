'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const L = require('../../lib/searchConsoleLegacyBackfill');
const C = require('../../lib/searchConsoleAnalyticsContract');
const O = require('../search_console_analytics.operator');
const { createSearchConsoleAnalytics } = require('../../services/searchConsoleAnalytics.service');
const scope = { siteUrl: 'sc-domain:backfill-fixture.example', startDate: '2026-09-01', endDate: '2026-09-01', clinicIds: [701, 702] };
const identity = { serverUuid: 'fictitious-offline-server', metadataSha256: C.hash('offline metadata') };
const validate = async () => true;
const detail = (overrides = {}) => ({ id: '1', clinica_id: 701, site_url: scope.siteUrl, date: scope.startDate,
  query: 'consulta 🦷', query_hash: C.hash('consulta 🦷'), page_url: 'https://backfill-fixture.example/a', page_url_hash: C.hash('https://backfill-fixture.example/a'),
  clicks: 2, impressions: 10, position: '2.000', ...overrides });
const total = (overrides = {}) => ({ id: '1', clinica_id: 701, site_url: scope.siteUrl, date: scope.startDate, clicks: 100, impressions: 1000, position: '4.000', ...overrides });
const snapshot = (d = [detail()], t = [total()], s = scope) => ({ scope: s, sourceIdentity: identity, exhausted: true, detail: d, totals: t });
async function audited(s = snapshot(), overrides = {}) {
  const unproven = await L.prepareLegacyBackfill({ snapshot: s });
  const evidence = unproven.days?.flatMap(day => ['detail', 'totals'].map(family => ({ siteUrl: s.scope.siteUrl, date: day.date, family,
    completeness: 'EXHAUSTED_REVIEWED_COHORT', rows: day[family].rows, sha256: day[family].sha256,
    sourceRef: { path: '/offline/source-evidence.json', sha256: C.hash('fictitious captured cohort') },
    authorityRef: { path: '/offline/review.json', sha256: C.hash('fictitious offline review') } }))) || [];
  return L.prepareLegacyBackfill({ snapshot: s, evidence, validateEvidence: validate, ...overrides });
}
function sqlSource(s, { warning = false, advanceClock = () => {}, alter = page => page } = {}) {
  let calls = 0, options;
  return { get calls() { return calls; }, get options() { return options; }, async transaction(input, work) { options = input; return work({ offline: true }); },
    async query(sql, opts) {
      calls++; advanceClock(); assert.equal(opts.logging, false); assert.equal(opts.transaction.offline, true);
      if (sql === 'SHOW WARNINGS') return [warning ? [{ Code: 1287 }] : []];
      assert.match(sql, /MAX_EXECUTION_TIME\(5000\)/); assert.doesNotMatch(sql, /\b(INSERT|DELETE|UPDATE|OFFSET)\b/);
      const family = sql.includes('FROM WebScQueryDaily') ? 'detail' : 'totals';
      assert.ok(sql.includes('FROM ' + (family === 'detail' ? 'WebScQueryDaily' : 'WebScDaily')));
      const p = opts.replacements;
      const rows = s[family].filter(r => Number(r.clinica_id) === p.clinic && r.date >= p.start && r.date <= p.end
        && (r.date > p.cursorDate || r.date === p.cursorDate && BigInt(r.id) > BigInt(p.cursorId)))
        .sort((a, b) => a.date.localeCompare(b.date) || Number(BigInt(a.id) - BigInt(b.id)));
      return [alter(rows.slice(0, Number(sql.match(/LIMIT (\d+)$/)[1])))];
    } };
}

test('imports and plans load no application models; old completeness booleans cannot authorize backfill', async () => {
  assert.equal(Object.keys(require.cache).some(p => p.endsWith('/models/index.js')), false);
  await assert.rejects(O.backfillInterval({ siteUrl: scope.siteUrl, provenanceReviewed: true, complete: true }), { code: 'sc_analytics_backfill_review_required' });
  assert.throws(() => L.scope({ ...scope, endDate: '2026-09-04' }), { code: 'sc_analytics_backfill_range_too_large' });
});
test('genuine bounded reader uses one read-only RR, both independent tables and an empty exhaustion page', async () => {
  const s = snapshot([detail(), detail({ id: '2', query: 'segunda', query_hash: C.hash('segunda') })]);
  const sql = sqlSource(s);
  const read = await L.readLegacyInterval({ ...scope, sequelize: sql, sourceIdentity: identity, validate, limits: { pageRows: 1 } });
  assert.deepEqual(sql.options, { isolationLevel: 'REPEATABLE READ', readOnly: true });
  assert.equal(read.detail.length, 2); assert.equal(read.totals.length, 1); assert.equal(read.exhausted, true);
  assert.equal(read.audit.pagesRead, 7); // Three detail+one empty clinic; two totals+one empty clinic.
});
test('reader rejects WARN, nonmonotonic cursor and changed authority', async () => {
  await assert.rejects(L.readLegacyInterval({ ...scope, sequelize: sqlSource(snapshot(), { warning: true }), sourceIdentity: identity, validate }), { code: 'sc_analytics_legacy_read_invalid' });
  await assert.rejects(L.readLegacyInterval({ ...scope, sequelize: sqlSource(snapshot(), { alter: p => p.length ? [{ ...p[0], id: '0' }] : p }), sourceIdentity: identity, validate }), { code: 'sc_analytics_legacy_cursor_invalid' });
  let n = 0;
  await assert.rejects(L.readLegacyInterval({ ...scope, sequelize: sqlSource(snapshot()), sourceIdentity: identity, validate: async () => ++n < 3 }), { code: 'sc_analytics_authority_changed' });
});
test('source bytes, row and elapsed budgets apply jointly to both families', async () => {
  for (const limits of [{ maxRows: 1 }, { maxBytes: 1 }]) await assert.rejects(L.readLegacyInterval({ ...scope,
    sequelize: sqlSource(snapshot()), sourceIdentity: identity, validate, limits }), { code: 'sc_analytics_legacy_budget_exceeded' });
  let clock = 0;
  await assert.rejects(L.readLegacyInterval({ ...scope, sequelize: sqlSource(snapshot(), { advanceClock: () => { clock += 100; } }),
    sourceIdentity: identity, validate, now: () => clock, limits: { maxMs: 50 } }), { code: 'sc_analytics_legacy_budget_exceeded' });
});
test('absence and a successful SQL exhaustion remain UNPROVEN without authenticated per-family/date evidence', async () => {
  const result = await L.prepareLegacyBackfill({ snapshot: snapshot([], []) });
  assert.equal(result.status, 'UNPROVEN'); assert.equal(result.days[0].totals.rows, 0);
  assert.deepEqual(result.reasons, ['sc_analytics_legacy_coverage_unproven']);
  const complete = await audited(snapshot([], [])); assert.equal(complete.status, 'PROVEN');
  const missingDay = await audited(snapshot([], [], { ...scope, endDate: '2026-09-02' }), { evidence: [] });
  assert.equal(missingDay.status, 'UNPROVEN');
});
test('clone dedupe preserves independent totals and distinct query rankings, including zero impressions', async () => {
  const zero = detail({ id: '2', impressions: 0, clicks: 0, page_url: '', page_url_hash: C.hash(''), position: '4' });
  const plan = await audited(snapshot([detail(), detail({ clinica_id: 702 }), zero], [total(), total({ clinica_id: 702 })]));
  assert.equal(plan.status, 'PROVEN'); assert.equal(plan.identicalClones, 2);
  assert.equal(plan.days[0].detail.rows, 2); assert.deepEqual(plan.days[0].detail.rankings, { top3: 1, top10: 1 });
  assert.equal(plan.days[0].detail.metrics.clicks, '2'); assert.equal(plan.days[0].totals.metrics.clicks, '100');
});
test('conflicting clones, truncated text hashes and cross-property labels are UNPROVEN', async () => {
  for (const [s, reason] of [
    [snapshot([detail(), detail({ clinica_id: 702, clicks: 99 })]), 'sc_analytics_conflicting_duplicate'],
    [snapshot([detail({ query: 'truncated' })]), 'sc_analytics_legacy_hash_mismatch'],
    [snapshot([detail({ site_url: 'sc-domain:foreign.example' })]), 'sc_analytics_ambiguous_legacy_property'],
    [snapshot([detail()], [total(), total({ clinica_id: 702, clicks: 999 })]), 'sc_analytics_conflicting_duplicate']
  ]) assert.deepEqual((await audited(s)).reasons, [reason]);
});
test('evidence digest mismatch and rejected provenance cannot publish; raw mutation cannot change audited rows', async () => {
  const s = snapshot(); const plan = await audited(s); s.detail[0].clicks = 999;
  assert.equal(L.records(plan).detail[0].clicks, '2');
  assert.throws(() => L.records(JSON.parse(JSON.stringify(plan))), { code: 'sc_analytics_backfill_review_required' });
  assert.equal((await audited(snapshot(), { validateEvidence: async () => false })).status, 'UNPROVEN');
  const fake = { siteUrl: scope.siteUrl, date: scope.startDate, family: 'detail', completeness: 'EXHAUSTED_REVIEWED_COHORT', rows: 0, sha256: C.hash('wrong') };
  assert.equal((await audited(snapshot(), { evidence: [fake] })).status, 'UNPROVEN');
});

function memoryRepository({ loseCommitAck = false, failTotals = false } = {}) {
  let state = 'absent', commits = 0, visible = null, detailRows = [], totalsRows = [];
  return { get state() { return state; }, get commits() { return commits; }, get visible() { return visible; }, isWriteEnabled: () => true,
    async inspectInterval(handle) { return { state, handle }; },
    async beginInterval(input) { assert.equal(state, 'absent'); state = 'staging'; return input; },
    async stageRows(handle, rows, { totals }) {
      assert.equal(state, 'staging'); if (totals && failTotals) throw Error('offline stage rollback');
      if (totals) totalsRows = rows; else detailRows = rows;
    },
    async commitInterval(handle, options) {
      assert.equal(options.complete, true); assert.equal(options.rowLimitReached, false);
      assert.equal(options.reconciliation.sourceDigest, handle.sourceDigest);
      commits++; state = 'committed'; visible = { detail: detailRows, totals: totalsRows };
      if (loseCommitAck) throw Error('offline COMMIT acknowledgement lost');
      return { committed: true, batchId: handle.batchId };
    }, async abortInterval() { assert.fail('UNKNOWN must never auto-abort'); } };
}
async function withJournal(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-backfill-journal-')); fs.chmodSync(dir, 0o700);
  const journal = L.createBackfillJournal(dir);
  try { await fn(journal, dir); } finally { journal.close(); fs.rmSync(dir, { recursive: true }); }
}
test('real private file journal binds intent before SQL and known publication contains both independent families', async () => withJournal(async journal => {
  const repository = memoryRepository(), plan = await audited(), batchId = randomUUID();
  const begin = repository.beginInterval;
  repository.beginInterval = async input => { assert.equal((await journal.load(batchId)).event, 'BEGIN_INTENT'); return begin(input); };
  await O.backfillInterval({ repository, plan, batchId, journal, validate });
  assert.equal(repository.visible.detail[0].clicks, '2'); assert.equal(repository.visible.totals[0].clicks, '100');
  assert.equal((await journal.load(batchId)).event, 'COMMIT_ACK');
}));
test('COMMIT ACK lost stops; resume requires closure and observes committed without a second commit', async () => withJournal(async journal => {
  const repository = memoryRepository({ loseCommitAck: true }), plan = await audited(), batchId = randomUUID();
  const args = { repository, plan, batchId, journal, validate };
  await assert.rejects(O.backfillInterval(args), /acknowledgement lost/); assert.equal(repository.commits, 1);
  assert.equal((await journal.load(batchId)).event, 'UNCERTAIN');
  await assert.rejects(O.backfillInterval(args), { code: 'sc_analytics_previous_attempt_closure_required' });
  assert.equal((await O.backfillInterval({ ...args, confirmPreviousAttemptClosed: validate })).replay, true);
  assert.equal(repository.commits, 1);
}));
test('BEGIN acknowledgement loss resumes the persisted same batch and never repeats BEGIN', async () => withJournal(async journal => {
  const repository = memoryRepository(), plan = await audited(), batchId = randomUUID(); let begins = 0;
  const begin = repository.beginInterval;
  repository.beginInterval = async input => { begins++; await begin(input); throw Error('offline BEGIN acknowledgement lost'); };
  const args = { repository, plan, batchId, journal, validate };
  await assert.rejects(O.backfillInterval(args), /BEGIN acknowledgement lost/);
  assert.equal(repository.state, 'staging');
  const result = await O.backfillInterval({ ...args, confirmPreviousAttemptClosed: validate });
  assert.equal(result.committed, true); assert.equal(begins, 1); assert.equal(repository.commits, 1);
}));
test('late totals failure publishes nothing and changed plan cannot reuse a durable batch identity', async () => withJournal(async journal => {
  const repository = memoryRepository({ failTotals: true }), plan = await audited(), batchId = randomUUID();
  await assert.rejects(O.backfillInterval({ repository, plan, batchId, journal, validate }), /stage rollback/);
  assert.equal(repository.visible, null); assert.equal(repository.commits, 0);
  const other = await audited(snapshot([detail({ clicks: 3 })]));
  await assert.rejects(O.backfillInterval({ repository, plan: other, batchId, journal, validate, confirmPreviousAttemptClosed: validate }), { code: 'sc_analytics_backfill_binding_changed' });
}));
test('private journal refuses symlinks, broad permissions and corrupt durable history', async () => withJournal(async (journal, dir) => {
  const batchId = randomUUID(), binding = { batchId, sourceDigest: C.hash('plan') };
  await journal.record({ event: 'INSPECT_INTENT', binding });
  const file = path.join(dir, `${batchId}.000001.json`); assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.writeFileSync(file, '{}'); await assert.rejects(journal.load(batchId), { code: 'sc_analytics_backfill_journal_invalid' });
  fs.chmodSync(dir, 0o755); assert.throws(() => L.createBackfillJournal(dir), { code: 'sc_analytics_backfill_private_journal_required' });
}));
test('actual repository binds caller batch/source digest and inspects the exact persisted identity', async () => {
  const batchId = randomUUID(), sourceDigest = C.hash('plan'); const queries = [];
  const row = { batch_id: batchId, property_id: 41, site_url: scope.siteUrl, start_date: scope.startDate, end_date: scope.endDate,
    kind: 'detail', state: 'staging', source_digest: Buffer.from(sourceDigest, 'hex') };
  const sequelize = { async transaction(work) { return work({}); }, async query(sql, options) {
    queries.push({ sql, p: options.replacements });
    if (sql.startsWith('SELECT id,site_url')) return [[{ id: 41, site_url: scope.siteUrl, revision: 0 }]];
    if (sql.startsWith('SELECT b.*')) return [[row]];
    return [[]];
  } };
  const repo = createSearchConsoleAnalytics({ sequelize, env: { SC_ANALYTICS_WRITE_ENABLED: 'true' } });
  const handle = await repo.beginInterval({ ...scope, batchId, sourceDigest, validate });
  assert.equal(handle.batchId, batchId);
  assert.equal(queries.find(q => q.sql.startsWith('INSERT INTO ScAnalyticsIngestBatches')).p.sourceDigest, sourceDigest);
  assert.equal((await repo.inspectInterval(handle, { sourceDigest, validate })).state, 'staging');
  await assert.rejects(repo.inspectInterval(handle, { sourceDigest: C.hash('different'), validate }), { code: 'sc_analytics_backfill_binding_changed' });
});
test('actual repository refuses a source-bound commit before publication when totals or reconciliation differ', async () => {
  const batchId = randomUUID(), plan = await audited(), p = plan.days[0]; let published = false;
  const b = { batch_id: batchId, property_id: 41, base_revision: 0, start_date: scope.startDate, end_date: scope.endDate,
    kind: 'detail', state: 'staging', source_digest: Buffer.from(plan.planSha256, 'hex'), totals_included: 1 };
  const n = C.normalize(detail(), scope), t = C.normalize(total(), scope, true);
  const sequelize = { async transaction(work) { return work({}); }, async query(sql) {
    if (/^(DELETE|INSERT|UPDATE)/.test(sql)) published = true;
    if (sql.startsWith('SELECT * FROM ScAnalyticsIngestBatches')) return [[b]];
    if (sql.startsWith('SELECT id,revision')) return [[{ id: 41, revision: 0 }]];
    if (sql.includes('FROM ScAnalyticsStagedRows s JOIN')) return [[{ ...n, query_hash: n.query_hash.toUpperCase(), page_hash: n.page_hash.toUpperCase(), row_digest: n.row_digest.toUpperCase() }]];
    if (sql.includes('FROM ScAnalyticsStagedTotals WHERE')) return [[{ ...t, clicks: '999' }]];
    throw Error('unexpected SQL: ' + sql);
  } };
  const repo = createSearchConsoleAnalytics({ sequelize, env: { SC_ANALYTICS_WRITE_ENABLED: 'true' } });
  const args = { complete: true, rowLimitReached: false, validate, reconciliation: { sourceDigest: plan.planSha256, days: [p] } };
  await assert.rejects(repo.commitInterval({ batchId }, args), { code: 'sc_analytics_backfill_reconciliation_failed' });
  assert.equal(published, false);
  b.totals_included = 0;
  await assert.rejects(repo.commitInterval({ batchId }, args), { code: 'sc_analytics_backfill_reconciliation_required' }); assert.equal(published, false);
});
test('historical target guard accepts only uncovered empty families or exact existing facts; covered-empty remains protected', async () => {
  const plan = await audited(), batchId = randomUUID(), n = C.normalize(detail(), scope), t = C.normalize(total(), scope, true);
  async function attempt({ detailRows = [], totalsRows = [], coverage = [], rankings = [] } = {}) {
    let writes = 0;
    const b = { batch_id: batchId, property_id: 41, base_revision: 4, start_date: scope.startDate, end_date: scope.endDate,
      kind: 'detail', state: 'staging', source_digest: Buffer.from(plan.planSha256, 'hex'), totals_included: 1 };
    const sequelize = { async transaction(work) { return work({}); }, async query(sql) {
      if (/^(DELETE|INSERT|UPDATE)/.test(sql)) writes++;
      if (sql.startsWith('SELECT * FROM ScAnalyticsIngestBatches')) return [[b]];
      if (sql.startsWith('SELECT id,revision')) return [[{ id: 41, revision: 4 }]];
      if (sql.includes('FROM ScAnalyticsStagedRows s JOIN')) return [[n]];
      if (sql.includes('FROM ScAnalyticsStagedTotals WHERE')) return [[t]];
      if (sql.includes('FROM ScAnalyticsDaily d LEFT JOIN')) return [detailRows];
      if (sql.includes('FROM ScAnalyticsPropertyDaily WHERE')) return [totalsRows];
      if (sql.includes('FROM ScAnalyticsCoverageDaily WHERE')) return [coverage];
      if (sql.includes('FROM ScAnalyticsRankingDaily WHERE')) return [rankings];
      if (sql.startsWith('SELECT month FROM ScAnalyticsArchiveBatches')) throw Object.assign(Error('offline guard completed'), { code: 'OFFLINE_TARGET_GUARD_PASSED' });
      throw Error('unexpected SQL');
    } };
    const repo = createSearchConsoleAnalytics({ sequelize, env: { SC_ANALYTICS_WRITE_ENABLED: 'true' } });
    let code;
    try { await repo.commitInterval({ batchId }, { complete: true, rowLimitReached: false, validate, reconciliation: { sourceDigest: plan.planSha256, days: plan.days } }); }
    catch (error) { code = error.code; }
    assert.equal(writes, 0); return code;
  }
  assert.equal(await attempt(), 'OFFLINE_TARGET_GUARD_PASSED');
  assert.equal(await attempt({ detailRows: [n], totalsRows: [t], coverage: [{ date: scope.startDate, detail_complete: 1, totals_complete: 1 }],
    rankings: [{ date: scope.startDate, queries_top3: 1, queries_top10: 1 }] }), 'OFFLINE_TARGET_GUARD_PASSED');
  for (const variant of [
    { detailRows: [{ ...n, clicks: '999' }] },
    { totalsRows: [{ ...t, impressions: '9999' }] },
    { coverage: [{ date: scope.startDate, detail_complete: 1, totals_complete: 0 }] },
    { coverage: [{ date: scope.startDate, detail_complete: 0, totals_complete: 1 }] },
    { rankings: [{ date: scope.startDate, queries_top3: 99, queries_top10: 99 }] },
    { detailRows: [{ ...n, query_hash: null }] }
  ]) assert.equal(await attempt(variant), 'sc_analytics_backfill_target_conflict');
  // A matching independent totals family does not block filling only the absent
  // detail family when that detail has never been covered.
  assert.equal(await attempt({ totalsRows: [t], coverage: [{ date: scope.startDate, detail_complete: 0, totals_complete: 1 }] }), 'OFFLINE_TARGET_GUARD_PASSED');
});
