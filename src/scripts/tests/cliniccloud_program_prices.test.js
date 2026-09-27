'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const { normalizeValues, payloadHash } = require('../../lib/treatmentPrograms.contract');
const { AUTHORIZATION, SOURCES, SPECS, APPLIED_NOTE, prepare, verifyPackage, verifyState } = require('../../lib/cliniccloud-import/program-prices');
const { execute, assertPreserved, run } = require('../cliniccloud-import-program-prices');

function fixture() {
  const old = {
    corporal: 'Tarifa desde 01/10/2026: no aplicada al precio comercial; confirmar vigencia y fiscalidad.',
    capillary: 'No aplicada al precio de venta; revisar vigencia y fiscalidad antes de activar.',
    obesity: 'Vigencia desde 01/10/2026; no aplicado al precio comercial. Pendientes: consentimientos, precio vigente y fiscalidad.',
  };
  const programs = SPECS.map((s, i) => ({
    id: i + 100, public_id: `00000000-0000-4000-8000-${String(i + 100).padStart(12, '0')}`, clinic_id: s.clinic,
    name: s.name, kind: 'program', status: 'draft', total_price: null, version_number: i % 2 + 1,
    appointments: Array.from({ length: s.count }, (_, index) => ({ key: `visit_${index}`, label: `Sesión ${index + 1}`,
      treatment_ids: index % 2 ? [] : [10], offset_days: index % 2 ? null : index * 7 })),
    cadence: null, notes: `No activa ni aprueba. ${old[s.family]}\n${Object.values(SOURCES).join('\n')}\nNota humana que debe conservarse. Precio condicional de cirugía 590 €, no aplicar automáticamente.`,
    request_key: payloadHash([s.clinic, `${s.importVersion}:${s.code}`]), request_payload_hash: 'immutable-creation-hash',
    created_by: 1, updated_by: 1, created_at: '2026-09-25 10:00:00', updated_at: '2026-09-25 10:00:00',
  }));
  return { programs, clinics: [{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }],
    sourceHashes: structuredClone(SOURCES), authorization: AUTHORIZATION };
}
function applied(op, actor = 1) {
  return { ...op.before, ...normalizeValues(op.payload, { current: op.before }), total_price: op.source_gross_price.toFixed(2),
    version_number: op.before.version_number + 1, updated_by: actor, updated_at: '2026-09-27 13:00:00' };
}
function state(pkg, complete = false) {
  return { clinics: structuredClone(pkg.clinics), programs: pkg.operations.map(op => complete ? applied(op) : structuredClone(op.before)),
    revisions: complete ? pkg.operations.map((op, i) => ({ id: i + 200, program_id: op.before.id, version_number: op.before.version_number + 1,
      snapshot: applied(op), actor_id: 1 })) : [] };
}
test('exact 23 regular gross prices, not conditional surgery/Arranque reductions or zero/included', () => {
  const f = fixture(), before = structuredClone(f), p = prepare(f); verifyPackage(p);
  assert.deepEqual(p.operations.map(o => o.source_gross_price),
    [1040, 780, 860, 690, 440, 1290, 1050, 690, 129, 349, 590, 690, 790, 840, 990, 1350, 250, 170, 275, 430, 670, 1090, 1290]);
  assert.deepEqual(f, before);
  for (const op of p.operations) {
    assert.deepEqual(Object.keys(op.payload), ['expected_version', 'total_price', 'notes']);
    assert(op.payload.notes.includes(APPLIED_NOTE)); assert(op.payload.notes.includes('Nota humana'));
    assert(op.payload.notes.includes('Precio condicional de cirugía 590 €'));
    assert.deepEqual(normalizeValues(op.payload, { current: op.before }).appointments, op.before.appointments);
    assert.equal(op.before.status, 'draft');
  }
  assert.equal(p.operations.filter(op => op.clinic_id === 66).length, 5);
  assert.equal(p.policy.reminders_activated, false); assert.equal(p.policy.tax_classification_changed, false);
});
for (const [name, mutate, message] of [
  ['without early authorization', f => f.authorization = null, /AUTHORIZATION/],
  ['different source', f => f.sourceHashes['Tarifa-2026-Corporal.pdf'] = 'x', /SOURCE_CHANGED/],
  ['missing source', f => delete f.sourceHashes['Tarifa-2026-Corporal.pdf'], /SOURCE_CHANGED/],
  ['another group', f => f.clinics[0].grupoClinicaId = 1, /SCOPE_CHANGED/],
  ['name-only match', f => f.programs[0].request_key = 'other', /IDENTITY_NOT_UNIQUE/],
  ['duplicate identity', f => f.programs.push(structuredClone(f.programs[0])), /IDENTITY_NOT_UNIQUE/],
  ['another clinic', f => f.programs[0].clinic_id = 66, /SCOPE_CHANGED/],
  ['active program', f => f.programs[0].status = 'active', /DRAFT_REQUIRED/],
  ['existing price even equal to source', f => f.programs[0].total_price = 1040, /EXISTING_PRICE/],
  ['explicit zero price', f => f.programs[0].total_price = 0, /EXISTING_PRICE/],
  ['renamed program', f => f.programs[0].name = 'Nueva definición', /IDENTITY_CHANGED/],
  ['different visit count', f => f.programs[0].appointments.pop(), /COMPOSITION_CHANGED/],
  ['changed price note', f => f.programs[0].notes = 'Nota editada por clínica', /PROVENANCE_MISSING/],
  ['ambiguous repeated note', f => f.programs[0].notes += f.programs[0].notes, /NOTE_CHANGED/],
]) test('rejects ' + name, () => { const f = fixture(); mutate(f); assert.throws(() => prepare(f), message); });

test('package cannot smuggle another price or appointment even with a recalculated hash', () => {
  for (const mutate of [p => p.operations[0].payload.total_price = 1,
    p => p.operations[0].payload.status = 'active', p => p.operations[0].payload.appointments = []]) {
    const p = prepare(fixture()); mutate(p); const { package_sha256, ...body } = p; p.package_sha256 = hash(body);
    assert.throws(() => verifyPackage(p), /PACKAGE_CHANGED/);
  }
});
test('allows exact before, partial completion and audited replay; SQL/JSON dates compare consistently', () => {
  const p = prepare(fixture()); assert.deepEqual(verifyState(state(p), p), { before: 23, applied: 0 });
  const after = state(p, true);
  for (const r of after.revisions) {
    r.snapshot.created_at = '2026-09-25T10:00:00.000Z'; r.snapshot.updated_at = '2026-09-27T13:00:00.000Z';
  }
  assert.deepEqual(verifyState(after, p, { complete: true }), { before: 0, applied: 23 });
  after.programs[0] = structuredClone(p.operations[0].before); after.revisions.shift();
  assert.deepEqual(verifyState(after, p), { before: 1, applied: 22 });
  assert.throws(() => verifyState(after, p, { complete: true }), /INCOMPLETE/);
});
test('after-state rejects concurrent edits, missing/replaced history, actor forgery and activation', () => {
  const p = prepare(fixture());
  for (const mutate of [s => s.programs[0].version_number++, s => s.programs[0].status = 'active',
    s => s.programs[0].notes += '\nOtro cambio', s => s.programs[0].appointments[0].offset_days = 99,
    s => s.programs[0].clinic_id = 66, s => s.programs[0].request_payload_hash = 'overwritten',
    s => s.programs[0].updated_by = 0, s => s.revisions.shift(),
    s => s.revisions[0].snapshot.total_price = 1, s => s.revisions[0].actor_id = 99]) {
    const changed = state(p, true); mutate(changed); assert.throws(() => verifyState(changed, p));
  }
});
function fakeApi(pkg, initial = state(pkg)) {
  let actual = structuredClone(initial); const calls = [];
  return { calls, read: async () => structuredClone(actual),
    call: async (route, method, payload) => {
      calls.push({ route, method, payload });
      const clinic = Number(route.split('clinic_id=')[1]);
      if (method === 'POST') return { status: 200, body: { item: { ...payload, version: 0, clinic_id: clinic, purchase_enabled: false } } };
      assert.equal(method, 'PATCH');
      const op = pkg.operations.find(op => route.includes(op.before.public_id));
      const index = actual.programs.findIndex(p => p.id === op.before.id);
      if (actual.programs[index].version_number !== payload.expected_version) return { status: 409, body: {} };
      actual.programs[index] = applied(op);
      actual.revisions.push({ id: 1000 + index, program_id: op.before.id, version_number: op.before.version_number + 1, snapshot: applied(op), actor_id: 1 });
      return { status: 200, body: { item: { ...normalizeValues(actual.programs[index]), version: op.before.version_number + 1, clinic_id: clinic, purchase_enabled: false } } };
    } };
}
test('operator uses canonical PATCH, one revision each; replay has zero API mutations', async () => {
  const p = prepare(fixture()), before = state(p), api = fakeApi(p);
  assert.deepEqual(await execute({ pkg: p, before, ...api }), { updated: 23, skipped: 0, previewed: 0 });
  assert.equal(api.calls.length, 23);
  assert.deepEqual(await execute({ pkg: p, before, ...api }), { updated: 0, skipped: 23, previewed: 0 });
  assert.equal(api.calls.length, 23);
});
test('canonical preview makes no persistent changes', async () => {
  const p = prepare(fixture()), before = state(p), api = fakeApi(p);
  assert.deepEqual(await execute({ pkg: p, before, ...api, preview: true }), { updated: 0, skipped: 0, previewed: 23 });
  assert.deepEqual(await api.read(), before); assert(api.calls.every(c => c.method === 'POST' && c.route.includes('/preview?')));
});
test('timeout after API commit is reconciled from revision, never blindly PATCHed twice', async () => {
  const p = prepare(fixture()), before = state(p), api = fakeApi(p); let lost = true;
  await assert.rejects(execute({ pkg: p, before, ...api, call: async (...args) => {
    const response = await api.call(...args); if (lost) { lost = false; throw Error('TEST_RESPONSE_LOST'); } return response;
  } }), /TEST_RESPONSE_LOST/);
  assert.deepEqual(await execute({ pkg: p, before, ...api }), { updated: 22, skipped: 1, previewed: 0 });
  assert.equal(api.calls.length, 23);
});
test('401 and 409 stop before the next program; no SQL or force fallback', async () => {
  for (const status of [401, 409]) {
    const p = prepare(fixture()), before = state(p); let calls = 0;
    await assert.rejects(execute({ pkg: p, before, read: async () => before, call: async () => { calls++; return { status, body: {} }; } }), /API_REJECTED/);
    assert.equal(calls, 1);
  }
});
test('retains earlier revisions and unrelated programs', () => {
  const p = prepare(fixture()), before = state(p);
  before.programs.push({ id: 999, name: 'Tono fuera de este alcance' });
  before.revisions.push({ id: 999, program_id: 999, version_number: 1 });
  const actual = structuredClone(before); actual.programs.at(-1).name = 'Alterado';
  assert.throws(() => assertPreserved(actual, before, p), /OTHER_PROGRAM/);
  actual.programs = before.programs; actual.revisions = [];
  assert.throws(() => assertPreserved(actual, before, p), /OLD_REVISION/);
});
test('target and mode are explicit before any database/browser connection', async () => {
  await assert.rejects(run(['--target', 'dev', '--mode', 'apply']), /EXPLICIT_CRM/);
  await assert.rejects(run(['--target', 'crm', '--mode', 'activate']), /EXPLICIT_PROGRAM_PRICE_MODE/);
});
