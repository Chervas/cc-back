'use strict';

require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReviewCareContext } = require('../../services/reviewCareContext.service');
const snapshots = require('../../lib/review-care-snapshot');

const list = () => ({ id: 98, created_by: 225,
  criteria: { review_care_version: 1, review_care_actor_id: 225 } });
const recipient = (patientId = 11, clinicId = 1, extra = {}) => ({ paciente_id: patientId,
  clinica_id: clinicId, status: 'ready', selected: true, custom_fields: { nombre: 'Ficticio' }, ...extra });
const fact = (patientId, clinicId, date, kind = 'performed_service_import') => ({ patientId, clinicId,
  latestCare: date ? { date, kind, precision: 'day', provenance: [{ kind,
    sourceRecordId: '90071992547409931', qualificationVersion: 'arriaga-confirmed-performed-services/1',
    rowSha256: 'a'.repeat(64), notes: 'FICTITIOUS_PRIVATE_NOTE' }] } : null,
  importedMessagesHold: false });
function sealed(patientId = 11, clinicId = 1) {
  const item = recipient(patientId, clinicId);
  const snapshot = snapshots.sealCareSnapshot({ care: fact(patientId, clinicId, '2026-09-10'),
    item, actorId: 225, capturedAt: '2026-11-12T12:00:00Z' });
  return { ...snapshots.bindCareSnapshot({ ...item, custom_fields: { ...item.custom_fields,
    [snapshots.KEY]: snapshot } }, 98), list_id: 98 };
}

function fixture() {
  const state = { calls: [], facts: new Map(), held: new Set(), sessionValid: true, actorActive: true,
    clinicPermissions: new Set([1, 70]), memberships: new Set(['11:1', '11:70', '12:1', '12:70']),
    holdError: false, onHold: null, onPair: null, onRead: null };
  const denied = (code, status = 403) => Object.assign(Error(code), { code, status });
  const authority = { actorId: 225, async authorize(input) {
    state.calls.push(['authorize', { ...input }]);
    if (!state.sessionValid) throw denied('FICTITIOUS_SESSION_REVOKED', 401);
    if (!state.actorActive || !state.clinicPermissions.has(input.clinicId)) throw denied('FICTITIOUS_PERMISSION_DENIED');
    return { actorId: 225, sessionRef: 'fictitious-session' };
  } };
  const access = {
    async assertActorClinics(input) {
      state.calls.push(['actor', { actorId: input.actorId, clinicIds: [...input.clinicIds] }]);
      if (input.actorId !== 225 || !state.actorActive
        || input.clinicIds.some(id => !state.clinicPermissions.has(id))) throw denied('FICTITIOUS_ACTOR_OR_PERMISSION_DENIED');
      return input;
    },
    async assertPatientPairs(input) {
      state.calls.push(['pairs', input.pairs.map(pair => ({ ...pair }))]);
      assert(input.pairs.length <= 1000, 'context must respect access batch bound');
      if (input.pairs.some(pair => !state.memberships.has(`${pair.patientId}:${pair.clinicId}`))) {
        throw denied('FICTITIOUS_PATIENT_CLINIC_DENIED');
      }
      await state.onPair?.(input);
      return input.pairs;
    },
  };
  const db = { sequelize: { async query(sql, options) {
    state.calls.push(['hold', [...options.replacements.patientIds]]);
    assert.equal(options.logging, false);
    assert.equal(options.type, 'SELECT');
    assert.match(sql, /^SELECT patient_id FROM PatientImportedIdentities/);
    assert.match(sql, /messages_hold=1/);
    assert.match(sql, /source='cliniccloud'/);
    assert.match(sql, /import\.automation_policy/);
    assert.match(sql, /import\.messages_enabled/);
    assert(!/\b(?:UPDATE|DELETE|INSERT|ALTER|DROP)\b/i.test(sql));
    assert(!/clinica_id\s*=/.test(sql), 'HOLD is global for the patient, not restricted to a site');
    assert(options.replacements.patientIds.length <= 200);
    if (state.holdError) throw Error('FICTITIOUS_PRIVATE_SQL_OR_TOKEN');
    await state.onHold?.();
    return options.replacements.patientIds.filter(id => state.held.has(id)).map(patient_id => ({ patient_id }));
  } } };
  const createReader = ({ authorize, repository }) => {
    assert.equal(typeof repository.memberships, 'function');
    return { async read(input) {
      state.calls.push(['read', { clinicId: input.clinicId, patientIds: [...input.patientIds] }]);
      await authorize({ clinicId: input.clinicId, phase: 'before' });
      await state.onRead?.(input);
      await authorize({ clinicId: input.clinicId, phase: 'after' });
      return { items: input.patientIds.map(id => structuredClone(state.facts.get(`${id}:${input.clinicId}`)
        || fact(id, input.clinicId, null))) };
    } };
  };
  const service = createReviewCareContext({ db, access, createReader });
  const scope = { clinicIds: [1, 70], reviewCareAuthority: authority };
  return { state, service, scope, access, authority };
}

test('factory and legacy enrichment perform no I/O or source projection without HTTP authority', async () => {
  const { state, service } = fixture();
  assert.deepEqual(state.calls, []);
  const items = [recipient()];
  assert.equal(await service.enrich(items, { clinicIds: [1] }), items);
  await service.guard({ list: { id: 3 }, items });
  assert.deepEqual(state.calls, []);
});

test('enrichment keeps a distinct latest source for the same patient in each site and minimal provenance', async () => {
  const { state, service, scope } = fixture();
  state.facts.set('11:1', fact(11, 1, '2026-09-10'));
  state.facts.set('11:70', fact(11, 70, '2026-10-04', 'attended_appointment'));
  const input = [recipient(11, 1), recipient(11, 70)], before = structuredClone(input);
  const output = await service.enrich(input, scope);
  assert.deepEqual(input, before, 'source recipients are not mutated');
  assert.deepEqual(output.map(row => snapshots.snapshotOf(row).date), ['2026-09-10', '2026-10-04']);
  assert.deepEqual(output.map(row => snapshots.snapshotOf(row).clinicId), [1, 70]);
  assert.equal(snapshots.snapshotOf(output[0]).kind, 'performed_service_import');
  assert.equal(snapshots.snapshotOf(output[1]).kind, 'attended_appointment');
  assert.equal(snapshots.snapshotOf(output[0]).provenance[0].qualificationVersion,
    'arriaga-confirmed-performed-services/1');
  assert(!JSON.stringify(output).includes('FICTITIOUS_PRIVATE_NOTE'));
  assert(!output.some(row => 'fecha_ultima_cita_asistida' in row.custom_fields));
  assert.deepEqual(state.calls.filter(([name]) => name === 'read').map(([, input]) => input), [
    { clinicId: 1, patientIds: [11] }, { clinicId: 70, patientIds: [11] },
  ]);
  assert.deepEqual(state.calls.filter(([name]) => name === 'authorize').slice(-2).map(([, input]) => input), [
    { clinicId: 1, phase: 'after' }, { clinicId: 70, phase: 'after' },
  ]);
});

test('a later declared date wins only for that patient and site; an earlier one keeps registered care', async () => {
  const { state, service, scope } = fixture();
  state.facts.set('11:1', fact(11, 1, '2026-09-10'));
  state.facts.set('11:70', fact(11, 70, '2026-10-04'));
  const output = await service.enrich([
    recipient(11, 1, { custom_fields: { fecha_ultima_cita_asistida: '01/10/2026' } }),
    recipient(11, 70, { custom_fields: { fecha_ultima_cita_asistida: '01/09/2026' } }),
  ], scope);
  assert.equal(snapshots.snapshotOf(output[0]).date, '2026-10-01');
  assert.equal(snapshots.snapshotOf(output[0]).kind, 'declared_care_date');
  assert.deepEqual(snapshots.snapshotOf(output[0]).provenance, []);
  assert.equal(snapshots.snapshotOf(output[1]).date, '2026-10-04');
  assert.equal(snapshots.snapshotOf(output[1]).kind, 'performed_service_import');
});

test('HOLD preserves the date but excludes the recipient; no care is excluded without inventing a date', async () => {
  const { state, service, scope } = fixture();
  state.facts.set('11:1', fact(11, 1, '2026-09-10')); state.held.add(11);
  const output = await service.enrich([recipient(11, 1), recipient(12, 1)], scope);
  assert.equal(output[0].status, 'excluded_import_hold'); assert.equal(output[0].selected, false);
  assert.equal(snapshots.snapshotOf(output[0]).date, '2026-09-10');
  assert.equal(snapshots.snapshotOf(output[0]).importedMessagesHold, true);
  assert.equal(output[1].status, 'excluded_no_performed_care'); assert.equal(output[1].selected, false);
  assert.equal(snapshots.snapshotOf(output[1]), null);
  assert.deepEqual([...state.held], [11], 'reading does not release or rewrite HOLD');
  assert(!state.calls.some(([name]) => ['send', 'enqueue', 'message', 'write'].includes(name)));
});

test('an unlinked imported contact is excluded without manufacturing patient care evidence', async () => {
  const { state, service, scope } = fixture();
  const [output] = await service.enrich([recipient(null, 1)], scope);
  assert.equal(output.status, 'excluded_patient_missing'); assert.equal(output.selected, false);
  assert.equal(snapshots.snapshotOf(output), null);
  assert(!state.calls.some(([name]) => name === 'read'));
});

test('care enrichment retains prior opt-out exclusions instead of restoring selected state', async () => {
  const { state, service, scope } = fixture();
  state.facts.set('11:1', fact(11, 1, '2026-09-10')); state.held.add(11);
  const excluded = recipient(11, 1, { status: 'excluded_opt_out', selected: false,
    exclusion_reason: 'no_marketing', reason: 'Fictitious opted out' });
  const [output] = await service.enrich([excluded], scope);
  assert.equal(output.status, excluded.status); assert.equal(output.selected, false);
  assert.equal(output.exclusion_reason, excluded.exclusion_reason);
  assert.equal(output.reason, excluded.reason);
});

test('enrichment denies a foreign site before source reads and rechecks permission after HOLD reads', async () => {
  const { state, service, scope } = fixture();
  await assert.rejects(service.enrich([recipient(11, 66)], scope), { code: 'review_care_scope_invalid', status: 403 });
  assert.deepEqual(state.calls, []);
  state.facts.set('11:1', fact(11, 1, '2026-09-10'));
  state.onHold = () => { state.clinicPermissions.delete(1); };
  await assert.rejects(service.enrich([recipient()], scope), { code: 'FICTITIOUS_PERMISSION_DENIED', status: 403 });
});

test('HTTP guards require the original authority even when an actor ID or creator is supplied', async () => {
  const { state, service } = fixture();
  await assert.rejects(service.guard({ list: list(), items: [sealed()], scope: { clinicIds: [1] }, actorId: 225 }),
    { code: 'review_care_authority_required', status: 403 });
  assert.deepEqual(state.calls, [], 'HTTP does not substitute background actor checks for a session');
});

test('HTTP logout or permission revocation blocks before disclosure, including revocation during pair reads', async () => {
  for (const loss of ['session', 'permission']) {
    const { state, service, scope } = fixture();
    if (loss === 'session') state.sessionValid = false; else state.clinicPermissions.delete(1);
    await assert.rejects(service.guard({ list: list(), items: [sealed()], scope }), error => [401, 403].includes(error.status));
    assert(!state.calls.some(([name]) => name === 'pairs'));
  }
  for (const loss of ['session', 'permission']) {
    const { state, service, scope } = fixture();
    state.onPair = () => { if (loss === 'session') state.sessionValid = false; else state.clinicPermissions.delete(1); };
    await assert.rejects(service.guard({ list: list(), items: [sealed()], scope }), error => [401, 403].includes(error.status));
    assert.equal(state.calls.filter(([name]) => name === 'pairs').length, 2);
  }
});

test('a scheduled campaign uses the current creator account without requiring an online session', async () => {
  const { state, service } = fixture(); state.sessionValid = false;
  await service.guard({ list: list(), items: [sealed()], background: true, checkHold: true });
  assert.equal(state.calls.filter(([name]) => name === 'actor').length, 2);
  assert(!state.calls.some(([name]) => name === 'authorize'));
  assert(state.calls.filter(([name]) => name === 'actor').every(([, input]) => input.actorId === 225));
  state.actorActive = false;
  await assert.rejects(service.guard({ list: list(), items: [sealed()], background: true }), { status: 403 });
  state.actorActive = true; state.clinicPermissions.delete(1);
  await assert.rejects(service.guard({ list: list(), items: [sealed()], background: true }), { status: 403 });
  await assert.rejects(service.guard({ list: { id: 98, criteria: { review_care_version: 1 } },
    items: [sealed()], background: true, actorId: 225 }), { code: 'review_care_authority_required', status: 403 });
});

test('a flagged recipient with no date snapshot still requires exact pair membership and global HOLD clearance', async () => {
  const { state, service, scope } = fixture(); state.held.add(11);
  const items = [recipient(11, 70, { list_id: 98 })];
  await assert.rejects(service.guard({ list: list(), items, scope, checkHold: true }),
    { code: 'review_care_messages_held', status: 409 });
  assert.deepEqual(state.calls.find(([name]) => name === 'pairs')[1], [{ patientId: 11, clinicId: 70 }]);
  assert.deepEqual(state.calls.find(([name]) => name === 'hold')[1], [11]);
  state.held.clear(); state.memberships.delete('11:70');
  await assert.rejects(service.guard({ list: list(), items, scope, checkHold: true }), { status: 403 });
});

test('after HOLD clearance a protected recipient still cannot be sent without retained care evidence', async () => {
  const { state, service, scope } = fixture();
  const items = [recipient(11, 1, { list_id: 98 })];
  await service.guard({ list: list(), items, scope, checkHold: false });
  for (const options of [{ scope }, { background: true }]) {
    await assert.rejects(service.guard({ list: list(), items, checkHold: true, ...options }),
      { code: 'review_care_evidence_required', status: 409 });
  }
  assert(state.calls.some(([name]) => name === 'hold'));
  assert.equal(state.held.size, 0, 'missing evidence is independent of HOLD');
});

test('the same patient in multiple sites never passes by having a link to only one of them', async () => {
  const { state, service, scope } = fixture();
  const items = [sealed(11, 1), sealed(11, 70)];
  await service.guard({ list: list(), items, scope });
  const first = state.calls.find(([name]) => name === 'pairs')[1];
  assert.deepEqual(first, [{ patientId: 11, clinicId: 1 }, { patientId: 11, clinicId: 70 }]);
  state.memberships.delete('11:70');
  await assert.rejects(service.guard({ list: list(), items, scope }), { status: 403 });
  state.memberships.add('11:70'); let count = 0;
  state.onPair = () => { if (++count === 1) state.memberships.delete('11:70'); };
  await assert.rejects(service.guard({ list: list(), items, scope }), { status: 403 });
});

test('snapshot residue remains protected when a legacy list has no flag and tampering fails before any HOLD read', async () => {
  const { state, service, scope } = fixture();
  const row = sealed(); row.custom_fields[snapshots.KEY].date = '2026-10-10';
  await assert.rejects(service.guard({ list: { id: 98 }, items: [row], scope, checkHold: true }),
    { code: 'review_care_snapshot_invalid', status: 409 });
  assert(!state.calls.some(([name]) => name === 'hold'));
});

test('HOLD storage failures are sanitized and never convert to an allowed recipient', async () => {
  const { state, service, scope } = fixture(); state.holdError = true;
  await assert.rejects(service.guard({ list: list(), items: [sealed()], scope, checkHold: true }), error =>
    error.status === 503 && error.code === 'review_care_hold_unavailable'
      && !error.message.includes('FICTITIOUS_PRIVATE_SQL_OR_TOKEN'));
  await assert.rejects(service.enrich([recipient()], scope), { code: 'review_care_hold_unavailable', status: 503 });
});

test('large protected lists chunk membership checks and HOLD reads without skipping the final recipient', async () => {
  const { state, service, scope } = fixture();
  const items = Array.from({ length: 2001 }, (_, i) => sealed(i + 1, 1));
  state.memberships = new Set(items.map(item => `${item.paciente_id}:1`));
  await service.guard({ list: list(), items, scope, checkHold: true });
  assert.deepEqual(state.calls.filter(([name]) => name === 'pairs').map(([, pairs]) => pairs.length), [1000, 1000, 1, 1000, 1000, 1]);
  const holdBatches = state.calls.filter(([name]) => name === 'hold').map(([, ids]) => ids);
  assert.equal(holdBatches.length, 11); assert.equal(holdBatches.at(-1).at(-1), 2001);
  assert.equal(new Set(holdBatches.flat()).size, 2001);
  state.held.add(2001);
  await assert.rejects(service.guard({ list: list(), items, scope, checkHold: true }),
    { code: 'review_care_messages_held', status: 409 });
});
