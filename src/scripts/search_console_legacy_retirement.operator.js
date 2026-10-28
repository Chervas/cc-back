'use strict';
// Injection-only: no HTTP/cron, connection creation, credentials, DDL or providers.
const { createHash } = require('node:crypto');
const C = require('../lib/searchConsoleAnalyticsContract');
const L = require('../lib/searchConsoleLegacyBackfill');
const Cut = require('../lib/searchConsoleLegacyDetailCut');
const admitted = new WeakSet();
const FIELDS = ['id', 'clinica_id', 'site_url', 'date', 'query_hash', 'page_url_hash', 'query_text_hash', 'page_text_hash', 'clicks', 'impressions', 'ctr', 'position'];
const REFS = ['mappingManifestRef', 'compactReconciliationRef', 'recoveryRef', 'restorationAcceptanceRef', 'readersAcceptanceRef', 'writerCutAcceptanceRef'];
const SELECT = `SELECT /*+ MAX_EXECUTION_TIME(5000) */ CAST(l.id AS CHAR) AS id,CAST(l.clinica_id AS CHAR) AS clinica_id,l.site_url,
  DATE_FORMAT(l.date,'%Y-%m-%d') AS date,LOWER(l.query_hash) AS query_hash,LOWER(l.page_url_hash) AS page_url_hash,
  LOWER(SHA2(l.query,256)) AS query_text_hash,LOWER(SHA2(COALESCE(l.page_url,''),256)) AS page_text_hash,
  CAST(l.clicks AS CHAR) AS clicks,CAST(l.impressions AS CHAR) AS impressions,CAST(l.ctr AS CHAR) AS ctr,CAST(l.position AS CHAR) AS position
  FROM WebScQueryDaily l`;
const fail = code => C.fail('sc_analytics_legacy_retire_' + code);
const hash = value => C.hash(JSON.stringify(value));
const freeze = x => { if (x && typeof x === 'object') { Object.values(x).forEach(freeze); Object.freeze(x); } return x; };
async function authority(validate, policy) { policy.assertCurrent(); if (typeof validate !== 'function' || await validate() !== true) fail('authority_changed'); policy.assertCurrent(); }
function scopeOf({ clinicId, startDate, endDate, mappings, sourceIdentity }) {
  C.range(startDate, endDate);
  if (!Number.isSafeInteger(clinicId) || clinicId < 1 || Date.parse(endDate) - Date.parse(startDate) > 2 * 86400000
    || !sourceIdentity || !L.SHA.test(sourceIdentity.metadataSha256 || '') || typeof sourceIdentity.serverUuid !== 'string' || !sourceIdentity.serverUuid) fail('scope_invalid');
  return { clinicId, startDate, endDate, mappings: Cut.mappingSet(mappings, clinicId),
    sourceIdentity: { serverUuid: sourceIdentity.serverUuid, metadataSha256: sourceIdentity.metadataSha256 } };
}
async function query(sql, text, replacements, transaction) {
  const [rows, metadata] = await sql.query(text, { replacements, transaction, logging: false });
  const [warnings] = await sql.query('SHOW WARNINGS', { transaction, logging: false });
  if (!Array.isArray(warnings) || warnings.length) fail('warnings');
  return { rows, metadata };
}
function signed(row, scope) {
  const id = C.integer(row.id).toString(), date = C.date(row.date);
  if (id === '0' || Number(row.clinica_id) !== scope.clinicId || date < scope.startDate || date > scope.endDate
    || !scope.mappings.some(m => m[3] === row.site_url) || !L.SHA.test(row.query_hash || '') || !L.SHA.test(row.page_url_hash || '')
    || row.query_hash !== row.query_text_hash || row.page_url_hash !== row.page_text_hash) fail('source_identity_unproven');
  return { id, date, signature: hash(FIELDS.map(key => row[key])) };
}
async function evidenceVerified(evidence, plan, verifyEvidence) {
  if (!evidence || evidence.schema !== 'sc-analytics-legacy-retirement-evidence/1' || evidence.scopeSha256 !== plan.scopeSha256
    || evidence.sourceDigest !== plan.sourceDigest || evidence.sourceRows !== plan.sourceRows
    || REFS.some(key => typeof evidence[key]?.path !== 'string' || !evidence[key].path.startsWith('/') || !L.SHA.test(evidence[key].sha256 || ''))
    || typeof verifyEvidence !== 'function') fail('evidence_unproven');
  // The trusted injected verifier must authenticate the references and actual
  // compact/totals/ranking reconciliation, recovery/restore, readers and durable
  // writer-cut/drain. A boolean or a request-supplied "reviewed" flag is rejected.
  const result = await verifyEvidence(evidence, { scope: plan.scope, scopeSha256: plan.scopeSha256, sourceDigest: plan.sourceDigest, sourceRows: plan.sourceRows });
  if (!result || result.verified !== true || result.evidenceSha256 !== hash(evidence)) fail('evidence_unproven');
}
async function prepareLegacyRetirement({ sql, env, validate, verifyEvidence, evidence, now = Date.now, ...input } = {}) {
  const policy = Cut.captureCutPolicy(env); if (!policy.enabled) fail('cut_disabled');
  const scope = scopeOf(input), scopeSha256 = hash(scope), rows = []; let bytes = 0;
  const started = now();
  if (!sql?.query || !sql?.transaction) fail('sql_required');
  await authority(validate, policy);
  await sql.transaction({ isolationLevel: 'REPEATABLE READ', readOnly: true }, async transaction => {
    let cursorDate = scope.startDate, cursorId = '0';
    for (;;) {
      await authority(validate, policy); if (now() - started >= 30000) fail('budget');
      const { rows: page } = await query(sql, `${SELECT} WHERE l.clinica_id=:clinic AND l.date BETWEEN :start AND :end
        AND (l.date>:date OR (l.date=:date AND l.id>:id)) ORDER BY l.date,l.id LIMIT 250`,
      { clinic: scope.clinicId, start: scope.startDate, end: scope.endDate, date: cursorDate, id: cursorId }, transaction);
      if (!Array.isArray(page) || page.length > 250) fail('source_invalid');
      for (const row of page) {
        const item = signed(row, scope);
        if (item.date < cursorDate || item.date === cursorDate && BigInt(item.id) <= BigInt(cursorId)) fail('source_cursor');
        rows.push(item); bytes += Buffer.byteLength(JSON.stringify(row)); cursorDate = item.date; cursorId = item.id;
        if (rows.length > 50000 || bytes > 40000000 || now() - started >= 30000) fail('budget');
      }
      if (page.length < 250) break;
    }
    await authority(validate, policy);
  });
  const plan = { schema: 'sc-analytics-legacy-retirement-plan/1', status: 'UNPROVEN', scope, scopeSha256,
    sourceRows: rows.length, sourceDigest: hash(rows), rows, evidence: evidence || null, reasons: [] };
  try { await evidenceVerified(evidence, plan, verifyEvidence); plan.status = 'PROVEN'; }
  catch (error) { if (!String(error.code).startsWith('sc_analytics_legacy_retire_')) throw error; plan.reasons = [error.code]; }
  plan.planSha256 = hash(plan); freeze(plan); if (plan.status === 'PROVEN') admitted.add(plan); return plan;
}
async function admitPersistedRetirementPlan(plan, { expectedSha256, verifyEvidence } = {}) {
  // A future launcher reads the pinned plan from its private owner0600 file.
  // Re-admission after a process restart authenticates its evidence again.
  const { planSha256, ...body } = plan || {};
  if (planSha256 !== expectedSha256 || !L.SHA.test(planSha256 || '') || hash(body) !== planSha256 || plan.status !== 'PROVEN'
    || plan.schema !== 'sc-analytics-legacy-retirement-plan/1' || hash(plan.scope) !== plan.scopeSha256
    || !Array.isArray(plan.rows) || plan.rows.length > 50000 || plan.rows.length !== plan.sourceRows || hash(plan.rows) !== plan.sourceDigest) fail('plan_invalid');
  const rebuilt = scopeOf({ ...plan.scope, mappings: plan.scope.mappings.map(m => ({ id: m[0], clinicaId: m[1], googleConnectionId: m[2], siteUrl: m[3] })) });
  if (hash(rebuilt) !== plan.scopeSha256) fail('plan_invalid');
  let previous = { date: plan.scope.startDate, id: '0' };
  for (const row of plan.rows) {
    if (!L.SHA.test(row.signature || '') || C.integer(row.id).toString() !== row.id || row.id === '0' || C.date(row.date) < plan.scope.startDate
      || row.date > plan.scope.endDate || row.date < previous.date || row.date === previous.date && BigInt(row.id) <= BigInt(previous.id)) fail('plan_invalid');
    previous = row;
  }
  await evidenceVerified(plan.evidence, plan, verifyEvidence); const result = freeze(JSON.parse(JSON.stringify(plan))); admitted.add(result); return result;
}
function chunkId(operationId, index, size) {
  const raw = createHash('sha256').update(JSON.stringify(['legacy-retirement', operationId, index, size])).digest();
  raw[6] = raw[6] & 15 | 64; raw[8] = raw[8] & 63 | 128;
  const h = raw.toString('hex').slice(0, 32); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
async function retireLegacyRange({ sql, plan, operationId, journal, env, validate, verifyEvidence, resolveMappings,
  confirmPreviousAttemptClosed, chunkSize = 250, maxChunks = 1 } = {}) {
  if (!admitted.has(plan) || plan.status !== 'PROVEN') fail('plan_unproven');
  const policy = Cut.captureCutPolicy(env); if (!policy.enabled) fail('cut_disabled');
  if (!sql?.query || !sql?.transaction || !L.UUID.test(operationId || '') || journal?.durable !== true
    || typeof journal.load !== 'function' || typeof journal.record !== 'function' || typeof resolveMappings !== 'function'
    || !Number.isInteger(chunkSize) || chunkSize < 1 || chunkSize > 500 || !Number.isInteger(maxChunks) || maxChunks < 1 || maxChunks > 100) fail('inputs_invalid');
  const binding = { batchId: operationId, sourceDigest: plan.planSha256, operation: 'RETIRE_LEGACY_DETAIL', chunkSize };
  const prior = await journal.load(operationId);
  if (prior && hash(prior.binding) !== hash(binding)) fail('journal_binding_changed');
  if (prior && (typeof confirmPreviousAttemptClosed !== 'function' || await confirmPreviousAttemptClosed(prior) !== true)) fail('previous_attempt_closure_required');
  const revalidate = async () => {
    await authority(validate, policy); await evidenceVerified(plan.evidence, plan, verifyEvidence);
    const current = Cut.mappingSet(await resolveMappings(plan.scope.clinicId), plan.scope.clinicId);
    if (hash(current) !== hash(plan.scope.mappings)) fail('mapping_universe_changed');
  };
  await revalidate(); await journal.record({ event: 'BEGIN_INTENT', binding });
  let processed = 0, removed = 0, observed = 0;
  try {
    for (let offset = 0, index = 0; offset < plan.rows.length; offset += chunkSize, index++) {
      const expected = plan.rows.slice(offset, offset + chunkSize), id = chunkId(operationId, index, chunkSize);
      const cb = { batchId: id, sourceDigest: plan.planSha256, operationId, index, chunkSize };
      const previous = await journal.load(id);
      if (previous && hash(previous.binding) !== hash(cb)) fail('journal_binding_changed');
      const params = Object.fromEntries(expected.map((r, i) => ['id' + i, r.id]));
      const ids = expected.map((_, i) => ':id' + i).join(',');
      const read = async transaction => (await query(sql, `${SELECT} WHERE l.id IN (${ids}) ORDER BY l.date,l.id`, params, transaction)).rows;
      await revalidate();
      const current = (await read()).map(row => signed(row, plan.scope));
      if (!current.length) {
        if (!previous) fail('source_disappeared_without_intent');
        await journal.record({ event: 'COMMITTED_OBSERVED', binding: cb }); observed += expected.length; continue;
      }
      if (previous && ['COMMIT_ACK', 'COMMITTED_OBSERVED'].includes(previous.event)) fail('legacy_recreated_after_ack');
      if (hash(current) !== hash(expected)) fail('source_changed');
      if (processed >= maxChunks) break;
      await journal.record({ event: 'STAGE_INTENT', binding: cb, action: 'DELETE_EXACT_CAPTURED_IDS', rows: expected.length, idsSha256: hash(expected) });
      await sql.transaction(async transaction => {
        await revalidate();
        const locked = (await query(sql, `${SELECT} WHERE l.id IN (${ids}) ORDER BY l.date,l.id FOR UPDATE`, params, transaction)).rows.map(row => signed(row, plan.scope));
        if (hash(locked) !== hash(expected)) fail('source_changed');
        const result = await query(sql, `DELETE FROM WebScQueryDaily WHERE clinica_id=:clinic AND date BETWEEN :start AND :end AND id IN (${ids})`,
          { ...params, clinic: plan.scope.clinicId, start: plan.scope.startDate, end: plan.scope.endDate }, transaction);
        const affected = Number(result.metadata?.affectedRows ?? result.rows?.affectedRows ?? result.metadata);
        if (affected !== expected.length) fail('delete_ack_unproven');
        await revalidate();
      });
      await authority(validate, policy);
      if ((await read()).length) fail('absence_unproven');
      await journal.record({ event: 'COMMIT_ACK', binding: cb, rows: expected.length }); processed++; removed += expected.length;
    }
    const result = await query(sql, 'SELECT /*+ MAX_EXECUTION_TIME(5000) */ COUNT(*) AS count FROM WebScQueryDaily WHERE clinica_id=:clinic AND date BETWEEN :start AND :end',
      { clinic: plan.scope.clinicId, start: plan.scope.startDate, end: plan.scope.endDate });
    const remaining = Number(result.rows[0]?.count);
    if (!Number.isSafeInteger(remaining) || remaining < 0 || remaining !== plan.sourceRows - observed - removed) fail('unexpected_rows');
    await revalidate(); await journal.record({ event: remaining === 0 ? 'COMMIT_ACK' : 'STAGE_ACK', binding, remaining, removed, observed });
    return { status: remaining === 0 ? 'LEGACY_DETAIL_RETIRED' : 'LEGACY_DETAIL_RETIREMENT_PARTIAL', operationId,
      planSha256: plan.planSha256, removed, observed, remaining, done: remaining === 0, requiresCallerPhysicalClosure: true,
      logicalRowsRemovedOnly: true, filesystemBytesReclaimed: null };
  } catch (error) { await journal.record({ event: 'UNCERTAIN', binding }).catch(() => {}); throw error; }
}
module.exports = { prepareLegacyRetirement, admitPersistedRetirementPlan, retireLegacyRange };
