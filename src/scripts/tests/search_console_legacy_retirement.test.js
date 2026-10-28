'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test'), assert = require('node:assert/strict');
const C = require('../../lib/searchConsoleAnalyticsContract');
const O = require('../search_console_legacy_retirement.operator');
const env = { SC_ANALYTICS_LEGACY_DETAIL_CUT_ENABLED: 'true', SC_ANALYTICS_WRITE_ENABLED: 'true', SC_ANALYTICS_READ_ENABLED: 'true' };
const input = { clinicId: 701, startDate: '2026-10-01', endDate: '2026-10-01',
  mappings: [{ id: 1, clinicaId: 701, googleConnectionId: 17, siteUrl: 'sc-domain:fixture.example' }],
  sourceIdentity: { serverUuid: 'offline-only-server', metadataSha256: C.hash('offline metadata') } };
const sql = { async transaction(options, work) { assert.equal(options.readOnly, true); return work({}); },
  async query(text, options) { assert.equal(options.logging, false); assert.doesNotMatch(text, /^(INSERT|DELETE|UPDATE|DROP|ALTER)/); return [[], {}]; } };
const validate = async () => true;
const reference = key => ({ path: '/offline/' + key + '.json', sha256: C.hash(key) });
function evidence(plan) {
  return { schema: 'sc-analytics-legacy-retirement-evidence/1', scopeSha256: plan.scopeSha256, sourceDigest: plan.sourceDigest, sourceRows: plan.sourceRows,
    ...Object.fromEntries(['mappingManifestRef', 'compactReconciliationRef', 'recoveryRef', 'restorationAcceptanceRef', 'readersAcceptanceRef', 'writerCutAcceptanceRef'].map(key => [key, reference(key)])) };
}
test('capture is read-only/bounded and missing evidence never grants retirement', async () => {
  const result = await O.prepareLegacyRetirement({ ...input, sql, env, validate });
  assert.equal(result.status, 'UNPROVEN'); assert.equal(result.sourceRows, 0);
  await assert.rejects(O.retireLegacyRange({ plan: result }), { code: 'sc_analytics_legacy_retire_plan_unproven' });
});
test('a boolean reviewed response is insufficient; reference authentication must bind exact evidence digest', async () => {
  const sample = await O.prepareLegacyRetirement({ ...input, sql, env, validate });
  const proof = evidence(sample);
  for (const verifyEvidence of [async () => true, async () => ({ verified: true, evidenceSha256: C.hash('different') })]) {
    const plan = await O.prepareLegacyRetirement({ ...input, sql, env, validate, evidence: proof, verifyEvidence });
    assert.equal(plan.status, 'UNPROVEN');
  }
});
test('a pinned plan is re-admitted only with matching digest and authenticated references after restart', async () => {
  const sample = await O.prepareLegacyRetirement({ ...input, sql, env, validate }), proof = evidence(sample);
  const verifyEvidence = async e => ({ verified: true, evidenceSha256: C.hash(JSON.stringify(e)) });
  const plan = await O.prepareLegacyRetirement({ ...input, sql, env, validate, evidence: proof, verifyEvidence });
  assert.equal(plan.status, 'PROVEN');
  const serialized = JSON.parse(JSON.stringify(plan));
  const admitted = await O.admitPersistedRetirementPlan(serialized, { expectedSha256: plan.planSha256, verifyEvidence });
  assert.equal(admitted.planSha256, plan.planSha256); assert(Object.isFrozen(admitted));
  serialized.scope.clinicId = 702;
  await assert.rejects(O.admitPersistedRetirementPlan(serialized, { expectedSha256: plan.planSha256, verifyEvidence }), { code: 'sc_analytics_legacy_retire_plan_invalid' });
});
test('cut flag and READ/WRITE remain explicit requirements; budget expiry never yields a proven plan', async () => {
  await assert.rejects(O.prepareLegacyRetirement({ ...input, sql, env: {}, validate }), { code: 'sc_analytics_legacy_retire_cut_disabled' });
  await assert.rejects(O.prepareLegacyRetirement({ ...input, sql, env: { ...env, SC_ANALYTICS_READ_ENABLED: 'false' }, validate }), { code: 'search_console_cut_requires_compact_read_write' });
  let clock = 0;
  await assert.rejects(O.prepareLegacyRetirement({ ...input, sql, env, validate, now: () => (clock += 31000) }), { code: 'sc_analytics_legacy_retire_budget' });
});
