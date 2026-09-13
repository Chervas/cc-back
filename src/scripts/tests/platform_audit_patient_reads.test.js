'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto');
const { createCapture, track, patientIds } = require('../../services/platformAudit.patientReads');
const { pack } = require('../../../services/platform-audit/src/event');
const SECRET = 'FICTITIOUS_CLINICAL_CONTENT';
function fixture(options = {}) {
  const state = { rows: [], checks: 0, permissionChecks: 0, work: 0, transaction: 0, pending: 0, ...options };
  const req = { userData: { userId: 501 }, authSession: { id: randomUUID() }, query: { q: SECRET }, headers: { authorization: SECRET } };
  const repository = { health: async () => ({ pending: state.pending, oldestAgeSeconds: state.age || 0 }),
    append: async (event, opts = {}) => {
      pack(event); await state.beforeAppend?.(event);
      (opts.transaction || state.rows).push(event);
    } };
  const capture = createCapture({ repository, enabled: () => state.flag ?? 'true',
    verifySession: async () => { state.checks++; await state.verify?.(state.checks); },
    transaction: async fn => { state.transaction++; const batch = []; await fn(batch); await state.beforeCommit?.(batch); state.rows.push(...batch); await state.afterCommit?.(); } });
  const read = async (_req, res) => {
    state.work++;
    track(req, { clinicIds: [71], patientIds: state.ids || [901], resultCount: state.ids?.length ?? 1, includesSensitive: true },
      async () => { state.permissionChecks++; await state.permission?.(state.permissionChecks); });
    res.json({ patient: SECRET });
  };
  return { state, req, capture, read, run: work => capture.run('patient.list', req, work || read) };
}
test('success persists metadata before releasing the response, with repeated identity and permission checks', async () => {
  const f = fixture(); const result = await f.run(); assert.equal(result.status, 200); assert.equal(result.body.patient, SECRET);
  assert.deepEqual(f.state.rows.map(e => e.stage), ['attempted', 'completed']);
  assert.equal(f.state.checks, 3); assert.equal(f.state.permissionChecks, 2); assert.equal(f.state.transaction, 1);
  assert(!JSON.stringify(f.state.rows).includes(SECRET)); assert.deepEqual(f.state.rows[1].patientIds, ['901']);
  assert.equal(f.state.rows[0].correlationId, f.state.rows[1].correlationId);
});
test('batched IDs are sorted and all parts share a digest; a failed transaction exposes no content', async () => {
  const ids = Array.from({ length: 205 }, (_, i) => 1205 - i); const f = fixture({ ids });
  assert.equal((await f.run()).status, 200);
  const parts = f.state.rows.slice(1); assert.deepEqual(parts.map(e => e.patientIds.length), [100, 100, 5]);
  assert.equal(new Set(parts.map(e => e.resultSetDigest)).size, 1); assert.deepEqual(parts.flatMap(e => e.patientIds), [...ids].sort((a,b) => a-b).map(String));
  const broken = fixture({ ids, beforeCommit: () => { throw Error(SECRET); } });
  const result = await broken.run(); assert.equal(result.status, 503); assert(!JSON.stringify(result).includes(SECRET));
  assert.deepEqual(broken.state.rows.map(e => e.outcome), ['unknown', 'error']);
});
test('audit admission failures stop domain work and never fabricate a completion without an attempt', async () => {
  for (const options of [{ pending: 10000 }, { age: 3600 }, { beforeAppend: () => { throw Error(SECRET); } }, { flag: 'yes' }]) {
    const f = fixture(options); assert.equal((await f.run()).status, 503); assert.equal(f.state.work, 0); assert.equal(f.state.rows.length, 0);
  }
});
test('backlog growth between attempt and completion rejects the whole prepared body', async () => {
  const f = fixture({ pending: 9999, ids: Array.from({ length: 101 }, (_, i) => i + 1) });
  assert.equal((await f.run()).status, 503); assert.equal(f.state.transaction, 0);
  assert.equal(f.state.rows.at(-1).outcome, 'error');
});
test('revocation before SQL commit denies with no successful parts; revocation after commit records a discard', async () => {
  for (const at of [2, 3]) {
    const f = fixture({ verify: count => { if (count === at) throw Object.assign(Error(SECRET), { status: 401 }); } });
    const result = await f.run(); assert.equal(result.status, 401); assert(!JSON.stringify(result).includes(SECRET));
    assert.equal(f.state.rows.at(-1).stage, at === 2 ? 'completed' : 'discarded');
    assert.equal(f.state.rows.filter(e => e.outcome === 'success').length, at === 2 ? 0 : 1);
    assert.deepEqual(f.state.rows.at(-1).patientIds, []);
  }
});
test('permission changes before and after commit suppress the response and use closed outcomes', async () => {
  for (const at of [1, 2]) {
    const f = fixture({ permission: count => { if (count === at) throw Object.assign(Error(SECRET), { status: 403 }); } });
    assert.equal((await f.run()).status, 403); assert.equal(f.state.rows.at(-1).reason, at === 1 ? 'access_denied' : 'access_changed');
  }
});
test('a failed discard acknowledgement closes the response without leaking clinical content', async () => {
  const f = fixture({ verify: n => { if (n === 3) throw Object.assign(Error(SECRET), { status: 401 }); },
    beforeAppend: e => { if (e.stage === 'discarded') throw Error(SECRET); } });
  assert.equal((await f.run()).status, 503); assert.equal(f.state.rows.length, 2);
});
test('denied and missing requests record no targets; successful uninstrumented responses are blocked', async () => {
  for (const status of [400, 401, 403, 404, 500]) {
    const f = fixture(); assert.equal((await f.run(async (_, res) => res.status(status).json({ message: 'closed' }))).status, status);
    assert.deepEqual(f.state.rows[1].patientIds, []); assert.equal(f.state.transaction, 0);
  }
  const f = fixture(); assert.equal((await f.run(async (_, res) => res.json({ patient: SECRET }))).status, 503);
});
test('disabled capture retains domain response without SQL or extra session work; request contexts are cleaned', async () => {
  const f = fixture({ flag: 'false' }); assert.equal((await f.run()).status, 200); assert.equal(f.state.rows.length, 0); assert.equal(f.state.checks, 0);
  track(f.req, () => assert.fail('No retained context'));
  const g = fixture(); await g.run(); track(g.req, () => assert.fail('No retained context'));
});
test('metadata excludes clinical extras and over-limit inventories; nested IDs include redacted references separately', async () => {
  for (const metadata of [{ clinicIds: [71], patientIds: [901], resultCount: 1, includesSensitive: true, name: SECRET },
    { clinicIds: [71], patientIds: Array.from({ length: 10001 }, (_,i) => i+1), resultCount: 10001, includesSensitive: true }]) {
    const f = fixture(); assert.equal((await f.run(async (_,res) => { track(f.req, metadata); res.json({ patient: SECRET }); })).status, 503);
  }
  const rows = [{ id_paciente: 901, relaciones: [{ relacionado: { id_paciente: 902, privacy_redacted: true } }], tutorDe: [{ paciente: { id_paciente: 903 } }] }];
  assert.deepEqual(patientIds(rows), ['901', '902', '903']);
  assert.deepEqual(patientIds(rows, { excludeRedactedRelations: true }), ['901', '903']);
});
