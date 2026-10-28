'use strict';

// No configuration, models, credentials or providers are imported here. Source
// SQL and historical evidence verification are separate, injected authorities.
const C = require('./searchConsoleAnalyticsContract');
const prepared = new WeakMap();
const DAY = 86400000;
const DEFAULT_LIMITS = Object.freeze({ pageRows: 250, maxRows: 50000, maxBytes: 40000000, maxMs: 30000 });
const TABLES = Object.freeze({ detail: 'WebScQueryDaily', totals: 'WebScDaily' });
const digest = value => C.hash(JSON.stringify(value));
const hex = value => Buffer.isBuffer(value) ? value.toString('hex') : String(value || '').toLowerCase();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;

function scope(input) {
  const { siteUrl } = C.property(input?.siteUrl);
  const { startDate, endDate } = C.range(input?.startDate, input?.endDate);
  if ((Date.parse(endDate) - Date.parse(startDate)) / DAY > 2) C.fail('sc_analytics_backfill_range_too_large');
  if (!Array.isArray(input.clinicIds) || !input.clinicIds.length || input.clinicIds.length > 200
    || input.clinicIds.some(id => !Number.isSafeInteger(id) || id < 1)) C.fail('sc_analytics_invalid_legacy_scope');
  return { siteUrl, startDate, endDate, clinicIds: [...new Set(input.clinicIds)].sort((a, b) => a - b) };
}
function limits(input = {}) {
  const result = { ...DEFAULT_LIMITS, ...input };
  for (const key of Object.keys(result)) if (!Object.hasOwn(DEFAULT_LIMITS, key) || !Number.isSafeInteger(result[key]) || result[key] < 1
    || result[key] > DEFAULT_LIMITS[key]) C.fail('sc_analytics_invalid_legacy_limits');
  return result;
}
async function authorize(validate) {
  if (typeof validate !== 'function' || await validate() !== true) C.fail('sc_analytics_authority_changed');
}
function dates(bounds) {
  const result = [];
  for (let t = Date.parse(bounds.startDate); t <= Date.parse(bounds.endDate); t += DAY) result.push(new Date(t).toISOString().slice(0, 10));
  return result;
}
function sourceSql(kind, pageRows) {
  if (!Object.hasOwn(TABLES, kind) || !Number.isSafeInteger(pageRows) || pageRows < 1 || pageRows > 250) C.fail('sc_analytics_invalid_legacy_limits');
  // The clinic/date predicate uses the existing index. Do not filter site_url:
  // that would hide historical cross-property identities from the audit.
  return `SELECT /*+ MAX_EXECUTION_TIME(5000) */ id,clinica_id,site_url,date,clicks,impressions,position${kind === 'detail' ? ',query,query_hash,page_url,page_url_hash' : ''}
    FROM ${TABLES[kind]} WHERE clinica_id=:clinic AND date BETWEEN :start AND :end
    AND (date>:cursorDate OR (date=:cursorDate AND id>:cursorId)) ORDER BY date,id LIMIT ${pageRows}`;
}

async function readLegacyInterval({ sequelize, validate, sourceIdentity, now = () => Date.now(), ...input } = {}) {
  const bounds = scope(input), budget = limits(input.limits);
  if (!sequelize?.query || !sequelize?.transaction || !sourceIdentity || !SHA.test(sourceIdentity.metadataSha256 || '')
    || typeof sourceIdentity.serverUuid !== 'string' || !sourceIdentity.serverUuid) C.fail('sc_analytics_legacy_identity_required');
  await authorize(validate);
  const started = now(), detail = [], totals = [];
  let rowsRead = 0, bytesRead = 0, pagesRead = 0;
  const check = () => { if (now() - started >= budget.maxMs || rowsRead > budget.maxRows || bytesRead > budget.maxBytes) C.fail('sc_analytics_legacy_budget_exceeded'); };
  return sequelize.transaction({ isolationLevel: 'REPEATABLE READ', readOnly: true }, async transaction => {
    for (const kind of ['detail', 'totals']) for (const clinic of bounds.clinicIds) {
      let cursorDate = bounds.startDate, cursorId = '0';
      for (;;) {
        check(); await authorize(validate); check();
        const [page] = await sequelize.query(sourceSql(kind, budget.pageRows), { replacements: {
          clinic, start: bounds.startDate, end: bounds.endDate, cursorDate, cursorId }, transaction, logging: false });
        const [warnings] = await sequelize.query('SHOW WARNINGS', { transaction, logging: false });
        if (!Array.isArray(page) || page.length > budget.pageRows || !Array.isArray(warnings) || warnings.length) C.fail('sc_analytics_legacy_read_invalid');
        pagesRead++;
        for (const row of page) {
          const id = C.integer(row.id).toString(), when = C.date(row.date);
          if (Number(row.clinica_id) !== clinic || when < bounds.startDate || when > bounds.endDate || when < cursorDate
            || when === cursorDate && BigInt(id) <= BigInt(cursorId)) C.fail('sc_analytics_legacy_cursor_invalid');
          cursorDate = when; cursorId = id;
          rowsRead++; bytesRead += Buffer.byteLength(JSON.stringify(row)); check();
          (kind === 'detail' ? detail : totals).push({ ...row });
        }
        await authorize(validate); check();
        if (page.length < budget.pageRows) break; // An exact full page needs the next empty page.
      }
    }
    await authorize(validate); check();
    return { scope: bounds, sourceIdentity: { serverUuid: sourceIdentity.serverUuid, metadataSha256: sourceIdentity.metadataSha256 },
      detail, totals, exhausted: true, audit: { rowsRead, bytesRead, pagesRead, elapsedMs: now() - started } };
  });
}

function normalizedRows(rows, bounds, totals, counts) {
  if (!Array.isArray(rows)) C.fail('sc_analytics_legacy_read_invalid');
  const unique = new Map();
  for (const row of rows) {
    if (row.site_url !== bounds.siteUrl || !bounds.clinicIds.includes(Number(row.clinica_id))) C.fail('sc_analytics_ambiguous_legacy_property');
    const n = C.normalize(row, bounds, totals);
    if (!totals && (hex(row.query_hash) !== n.query_hash || hex(row.page_url_hash) !== n.page_hash)) C.fail('sc_analytics_legacy_hash_mismatch');
    const key = JSON.stringify(totals ? [n.date] : [n.date, n.query_hash, n.page_hash]);
    const prior = unique.get(key);
    if (prior && prior.row_digest !== n.row_digest) C.fail('sc_analytics_conflicting_duplicate');
    if (prior && !totals && (prior.query !== n.query || prior.page_url !== n.page_url)) C.fail('sc_analytics_hash_collision');
    if (prior) counts.clones++; else unique.set(key, n);
  }
  return [...unique.values()].sort((a, b) => a.date.localeCompare(b.date) || (a.query_hash || '').localeCompare(b.query_hash || '') || (a.page_hash || '').localeCompare(b.page_hash || ''));
}
function summary(rows, when, totals = false) {
  const subset = rows.filter(row => row.date === when);
  const sums = Object.fromEntries(['clicks', 'impressions', 'position_weighted', 'position_sum', 'position_count'].map(key => [key,
    ['position_weighted', 'position_sum'].includes(key) ? C.formatted(subset.reduce((n, r) => n + C.decimal(r[key]), 0n)) : subset.reduce((n, r) => n + C.integer(r[key]), 0n).toString()]));
  const value = { rows: subset.length, sha256: digest(subset.map(r => r.row_digest)), metrics: sums };
  if (!totals) {
    const top3 = new Set(), top10 = new Set();
    for (const r of subset) if (r.position_count !== '0') {
      const denominator = C.integer(r.impressions) || C.integer(r.position_count);
      const numerator = C.decimal(r.impressions !== '0' ? r.position_weighted : r.position_sum);
      if (numerator <= 3n * C.SCALE * denominator) top3.add(r.query_hash);
      if (numerator <= 10n * C.SCALE * denominator) top10.add(r.query_hash);
    }
    value.rankings = { top3: top3.size, top10: top10.size };
  }
  return value;
}
const ref = value => value && typeof value.path === 'string' && value.path.startsWith('/') && SHA.test(value.sha256 || '');
function freeze(value) { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }

async function prepareLegacyBackfill({ snapshot, evidence = [], validateEvidence } = {}) {
  const bounds = scope(snapshot?.scope);
  const base = { schema: 'sc-analytics-legacy-backfill-plan/1', scope: bounds, status: 'UNPROVEN', reasons: [] };
  try {
    if (snapshot.exhausted !== true || !SHA.test(snapshot.sourceIdentity?.metadataSha256 || '') || !snapshot.sourceIdentity?.serverUuid) C.fail('sc_analytics_legacy_source_unproven');
    const cloneCounts = { clones: 0 };
    const detail = normalizedRows(snapshot.detail, bounds, false, cloneCounts), totals = normalizedRows(snapshot.totals, bounds, true, cloneCounts);
    const daily = dates(bounds).map(date => ({ date, detail: summary(detail, date), totals: summary(totals, date, true) }));
    base.sourceIdentity = { serverUuid: snapshot.sourceIdentity.serverUuid, metadataSha256: snapshot.sourceIdentity.metadataSha256 };
    base.sourceRows = { detail: snapshot.detail.length, totals: snapshot.totals.length };
    base.identicalClones = cloneCounts.clones; base.days = daily;
    const refs = [];
    for (const day of daily) for (const family of ['detail', 'totals']) {
      const matches = evidence.filter(e => e?.siteUrl === bounds.siteUrl && e?.date === day.date && e?.family === family);
      const e = matches[0];
      // A digest proves equivalence only. Historical exhaustion/property lineage
      // must also be authenticated by the caller's independent evidence reader.
      if (matches.length !== 1 || e.completeness !== 'EXHAUSTED_REVIEWED_COHORT' || !ref(e.sourceRef) || !ref(e.authorityRef)
        || e.rows !== day[family].rows || e.sha256 !== day[family].sha256 || typeof validateEvidence !== 'function'
        || await validateEvidence(e, { scope: bounds, sourceIdentity: base.sourceIdentity, observed: day[family] }) !== true) C.fail('sc_analytics_legacy_coverage_unproven');
      refs.push({ date: day.date, family, sourceRef: { path: e.sourceRef.path, sha256: e.sourceRef.sha256 },
        authorityRef: { path: e.authorityRef.path, sha256: e.authorityRef.sha256 } });
    }
    base.evidenceRefs = refs; base.status = 'PROVEN'; base.reasons = [];
    base.planSha256 = digest(base);
    const result = freeze(base);
    // Callers receive summaries, not analytics text. Mutation of raw snapshots
    // after audit cannot alter the records eventually staged.
    prepared.set(result, { detail: freeze(detail), totals: freeze(totals) });
    return result;
  } catch (error) {
    if (!/^sc_analytics_[a-z_]+$/.test(error?.code || '')) throw error;
    base.reasons = [error.code]; return freeze(base);
  }
}

function records(plan) {
  const value = prepared.get(plan);
  if (!value || plan.status !== 'PROVEN') C.fail('sc_analytics_backfill_review_required');
  const convert = r => ({ date: r.date, query: r.query, page_url: r.page_url, clicks: r.clicks, impressions: r.impressions,
    position: r.position_count === '0' ? null : r.position_sum });
  return { detail: value.detail.map(convert), totals: value.totals.map(convert) };
}

function createBackfillJournal(directory) {
  const fs = require('node:fs'), path = require('node:path');
  const root = path.resolve(directory), st = fs.lstatSync(root);
  if (fs.realpathSync(root) !== root || !st.isDirectory() || st.isSymbolicLink() || st.uid !== process.geteuid()
    || (st.mode & 0o777) !== 0o700) C.fail('sc_analytics_backfill_private_journal_required');
  const anchor = fs.openSync(root, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  const check = () => {
    const current = fs.lstatSync(root), opened = fs.fstatSync(anchor);
    if (current.dev !== opened.dev || current.ino !== opened.ino || current.uid !== process.geteuid()
      || (current.mode & 0o777) !== 0o700 || fs.realpathSync(root) !== root) C.fail('sc_analytics_backfill_journal_changed');
  };
  function entries(batchId) {
    if (!UUID.test(batchId || '')) C.fail('sc_analytics_invalid_batch');
    check();
    const names = fs.readdirSync(root).filter(name => name.startsWith(batchId + '.')).sort();
    if (names.length > 10000) C.fail('sc_analytics_backfill_journal_limit');
    let last = null;
    names.forEach((name, index) => {
      if (name !== `${batchId}.${String(index + 1).padStart(6, '0')}.json`) C.fail('sc_analytics_backfill_journal_invalid');
      const fd = fs.openSync(path.join(root, name), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const s = fs.fstatSync(fd);
        if (!s.isFile() || s.nlink !== 1 || s.uid !== process.geteuid() || (s.mode & 0o777) !== 0o600 || s.size > 16384) C.fail('sc_analytics_backfill_journal_invalid');
        const value = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (value.binding?.batchId !== batchId || !SHA.test(value.binding?.sourceDigest || '')
          || last && digest(value.binding) !== digest(last.binding)) C.fail('sc_analytics_backfill_journal_invalid');
        last = value;
      } finally { fs.closeSync(fd); }
    });
    check(); return { last, length: names.length };
  }
  return {
    durable: true,
    async load(batchId) { return entries(batchId).last; },
    async record(value) {
      if (!/^(INSPECT_INTENT|BEGIN_INTENT|BEGIN_ACK|STAGE_INTENT|STAGE_ACK|COMMIT_INTENT|COMMIT_ACK|COMMITTED_OBSERVED|UNCERTAIN)$/.test(value?.event || '')) C.fail('sc_analytics_backfill_journal_invalid');
      const batchId = value?.binding?.batchId, prior = entries(batchId);
      if (prior.last && digest(prior.last.binding) !== digest(value.binding)) C.fail('sc_analytics_backfill_binding_changed');
      const body = JSON.stringify(value) + '\n';
      if (Buffer.byteLength(body) > 16384) C.fail('sc_analytics_backfill_journal_limit');
      const fd = fs.openSync(path.join(root, `${batchId}.${String(prior.length + 1).padStart(6, '0')}.json`), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try { fs.writeFileSync(fd, body); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      fs.fsyncSync(anchor); check();
    },
    close() { fs.closeSync(anchor); }
  };
}

module.exports = { DEFAULT_LIMITS, scope, sourceSql, readLegacyInterval, prepareLegacyBackfill, records, createBackfillJournal, digest, summary, UUID, SHA };
