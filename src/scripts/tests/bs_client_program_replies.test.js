'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const planner = require('../../lib/cliniccloud-import/bs-client-program-replies');
const copy = value => JSON.parse(JSON.stringify(value));
function fixture() {
  const decision = { version: 1, authorized_at: '2026-10-15T10:00:00.000Z', default_interval_days: 15,
    workbook_sha256: 'a'.repeat(64), authority_reference: 'Carlos: intervalo de programas 15 días salvo pauta explícita', activation_ids: [] };
  const programs = planner.SPECS.map(spec => ({ id: spec.id, public_id: spec.public_id, clinic_id: spec.clinic_id,
    name: `Programa ${spec.reference}`, kind: 'program', status: 'draft', version_number: 2,
    total_price: '170.00', price_profile: null, cadence: null, notes: 'Procedencia documental conservada.',
    request_key: `source-${spec.id}`, request_payload_hash: 'b'.repeat(64), created_by: 2,
    created_at: '2026-09-27 12:00:00', updated_at: '2026-09-27 12:00:00', updated_by: 2,
    appointments: Array.from({ length: spec.appointments }, (_, index) => ({ key: `a${index + 1}`, label: `Sesión ${index + 1}`,
      treatment_ids: [spec.treatment_id], offset_days: null })) }));
  return { decision, snapshot: { target: 'crm', group_id: 29, captured_at: '2026-10-15T10:05:00.000Z',
    clinics: [{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }], programs },
  createdAt: '2026-10-15T10:06:00.000Z' };
}
function preview(operation, overrides = {}) {
  return { program_id: operation.program_id, checked_at: '2026-10-15T10:06:00.000Z', item: {
    ...copy(operation.after), status: 'active', clinic_id: operation.clinic_id, version: 0,
    summary: { ready_for_activation: true, issues: [] }, commercial_ready: true, commercial_issues: [], ...overrides,
  } };
}
test('prepares default 15 only for exact reviewed existing GLP1, nutrition and psychonutrition', () => {
  const input = fixture(), before = hash(input); const plan = planner.buildPlan(input);
  assert.equal(hash(input), before); assert.equal(plan.operations.length, 3);
  assert.deepEqual(plan.operations.map(operation => operation.after.appointments.map(a => a.offset_days)), [[0, 15, 30], [0, 15, 30], [0, 15, 30, 45, 60]]);
  for (const operation of plan.operations) {
    assert.equal(operation.expected_version, 2); assert.equal(operation.after.status, 'draft');
    assert.equal(operation.after.total_price, 170); assert.equal(operation.activation, false);
    assert.match(operation.after.notes, /^Procedencia documental conservada\./);
    assert.match(operation.after.notes, new RegExp(input.decision.workbook_sha256));
    assert.equal(operation.before_sha256, hash(operation.before));
  }
  assert.equal(plan.policy.purchases_changed, false); assert.equal(plan.policy.messages_sent, false);
  planner.assertPlan(plan);
});
test('15 days never overwrites an explicit weekly cadence', () => {
  const input = fixture(); input.snapshot.programs[0].cadence = { mode: 'weekly', sessions_per_week: 1, min_days_between: 2 };
  const plan = planner.buildPlan(input); assert.equal(plan.operations.length, 2);
  assert.equal(plan.assessments[0].reason, 'EXPLICIT_CADENCE_PRESERVED');
});
test('existing offsets are retained byte-for-value and missing ones use a relative 15 day gap', () => {
  const input = fixture(); input.snapshot.programs[0].appointments[0].offset_days = 0;
  input.snapshot.programs[0].appointments[1].offset_days = 14;
  const operation = planner.buildPlan(input).operations.find(row => row.program_id === 22);
  assert.deepEqual(operation.after.appointments.map(a => a.offset_days), [0, 14, 29]);
});
test('does not squeeze an unknown offset past a subsequent explicit date', () => {
  const input = fixture(); input.snapshot.programs[0].appointments[2].offset_days = 7;
  const plan = planner.buildPlan(input); assert.equal(plan.operations.length, 2);
  assert.equal(plan.assessments[0].reason, 'BS_REPLIES_EXISTING_OFFSETS_CANNOT_BE_RECONCILED');
});
test('explicit complete dates and archived catalogues produce no date operation', () => {
  const input = fixture(); input.snapshot.programs[0].appointments.forEach((row, index) => { row.offset_days = index * 7; });
  input.snapshot.programs[1].status = 'archived';
  const plan = planner.buildPlan(input); assert.equal(plan.operations.length, 1);
  assert.equal(plan.assessments[0].reason, 'NO_AUTHORIZED_CHANGE_REQUIRED');
  assert.equal(plan.assessments[1].reason, 'ARCHIVED_PROGRAM_PRESERVED');
});
test('rejects a different public identity even with the same reviewed numeric ID/name', () => {
  const input = fixture(); input.snapshot.programs[0].public_id = '4b303701-b575-46b1-934c-7bc2de73f81c';
  assert.throws(() => planner.buildPlan(input), /IDENTITY_OR_COMPOSITION_CHANGED/);
});
test('rejects altered composition/counts rather than silently converting it', () => {
  for (const mutate of [input => input.snapshot.programs[0].appointments.pop(), input => { input.snapshot.programs[0].appointments[0].treatment_ids = [2103]; }]) {
    const input = fixture(); mutate(input); assert.throws(() => planner.buildPlan(input), /IDENTITY_OR_COMPOSITION_CHANGED/);
  }
});
test('rejects clinic/group leakage, duplicate identities and malformed authority', () => {
  for (const mutate of [input => { input.snapshot.clinics[0].grupoClinicaId = 30; }, input => { input.snapshot.programs[0].clinic_id = 99; },
    input => input.snapshot.programs.push(copy(input.snapshot.programs[0])), input => { input.decision.workbook_sha256 = 'not-a-sha'; },
    input => { input.decision.default_interval_days = 30; }, input => { input.decision.activation_ids = [6]; }]) {
    const input = fixture(); mutate(input); assert.throws(() => planner.buildPlan(input), /BS_REPLIES_/);
  }
});
test('calendar months/integrated reviews and mixed-frequency series are explicit deferrals', () => {
  const input = fixture();
  for (const id of [6, 10, 19, 27, 28]) input.snapshot.programs.push({ ...copy(input.snapshot.programs[0]), id,
    public_id: `00000000-0000-0000-0000-${String(id).padStart(12, '0')}`, clinic_id: id < 11 ? 66 : 72 });
  const plan = planner.buildPlan(input); assert.equal(plan.operations.length, 3);
  assert.match(plan.assessments.find(row => row.program_id === 6).reason, /CALENDAR_MONTHS/);
  assert.match(plan.assessments.find(row => row.program_id === 27).reason, /TWO_EXPLICIT_FREQUENCIES/);
  assert.match(plan.assessments.find(row => row.program_id === 19).reason, /UNANSWERED/);
});
test('canonical active preview is mandatory and must correspond exactly to the after definition', () => {
  const input = fixture(); input.decision.activation_ids = [22];
  const initial = planner.buildPlan(input);
  assert.equal(initial.operations[0].activation, false);
  assert.match(initial.assessments[0].activation_blocked, /PREVIEW/);
  const valid = preview(initial.operations[0]);
  const active = planner.buildPlan({ ...input, previews: [valid] });
  assert.equal(active.operations[0].activation, true); assert.equal(active.operations[0].after.status, 'active');
  assert.equal(active.operations[1].activation, false);
  planner.assertPlan(active);
});
test('readiness or commercial issues never become activation approval', () => {
  const input = fixture(); input.decision.activation_ids = [22];
  const initial = planner.buildPlan(input), op = initial.operations[0];
  for (const patch of [{ summary: { ready_for_activation: false, issues: [{ code: 'professional_unavailable' }] } },
    { commercial_ready: false, commercial_issues: [{ code: 'program_price_profile_required' }] },
    { clinic_id: 66 }, { version: 2 }, { total_price: 171 }, { status: 'draft' },
    { appointments: op.after.appointments.map(a => ({ ...a, treatment_ids: [999] })) }]) {
    const result = planner.buildPlan({ ...input, previews: [preview(op, patch)] });
    assert.equal(result.operations[0].activation, false);
  }
});
test('separate activation can preserve a complete weekly programme and all its existing definition fields', () => {
  const input = fixture(), spec = planner.ACTIVATION_SPECS.find(row => row.id === 1);
  const row = { ...copy(input.snapshot.programs[0]), ...spec, appointments: copy(input.snapshot.programs[0].appointments),
    cadence: { mode: 'weekly', sessions_per_week: 2, min_days_between: 2 } };
  input.snapshot.programs.push(row); input.decision.activation_ids = [1];
  const fakeOperation = { program_id: 1, clinic_id: 72, after: planner.values(row) };
  const plan = planner.buildPlan({ ...input, previews: [preview(fakeOperation)] });
  const operation = plan.operations.find(value => value.program_id === 1);
  assert.equal(operation.activation, true); assert.equal(operation.dates_changed, false);
  assert.deepEqual(operation.after.appointments, row.appointments); assert.deepEqual(operation.after.cadence, row.cadence);
  assert.equal(operation.after.notes, row.notes); assert.equal(operation.after.status, 'active');
});
test('a programme requiring an explicit clinical decision cannot be added to activation_ids', () => {
  for (const id of [6, 7, 8, 9, 10, 14, 15, 16, 17, 18, 19, 20, 21, 27, 28]) {
    const input = fixture(); input.decision.activation_ids = [id];
    assert.throws(() => planner.buildPlan(input), /DECISION_INVALID/);
  }
});
test('full-row CAS distinguishes pending, after requiring revision verification, and human edits', () => {
  const input = fixture(), op = planner.buildPlan(input).operations[0];
  assert.equal(planner.assessCurrent(op, copy(op.before)), 'pending');
  const after = { ...copy(op.before), ...copy(op.after), version_number: 3, updated_by: 9 };
  assert.equal(planner.assessCurrent(op, after), 'applied_requires_revision_verification');
  assert.equal(planner.assessCurrent(op, { ...op.before, name: 'Human edit' }), 'conflict');
  assert.equal(planner.assessCurrent(op, { ...after, version_number: 4 }), 'conflict');
  assert.equal(planner.assessCurrent(op, { ...after, request_key: 'a changed origin' }), 'conflict');
  assert.equal(planner.assessCurrent(op, null), 'conflict');
});
test('applied state requires exactly one canonical revision with the real actor and identical definition', () => {
  const op = planner.buildPlan(fixture()).operations[0];
  const current = { ...copy(op.before), ...copy(op.after), version_number: 3, updated_by: 9 };
  const revision = { id: 99, program_id: 22, version_number: 3, actor_id: 9, snapshot: copy(current) };
  assert.equal(planner.verifyAppliedRevision(op, current, [revision]), true);
  assert.equal(planner.verifyAppliedRevision(op, current, []), false);
  assert.equal(planner.verifyAppliedRevision(op, current, [revision, revision]), false);
  assert.equal(planner.verifyAppliedRevision(op, current, [{ ...revision, actor_id: null }]), false);
  assert.equal(planner.verifyAppliedRevision(op, current, [{ ...revision, snapshot: { ...revision.snapshot, total_price: 1 } }]), false);
});
test('actual canonical summarize accepts the dates and retains the separate fiscal gate for included-only components', () => {
  const contract = require('../../lib/treatmentPrograms.contract');
  const op = planner.buildPlan(fixture()).operations[0];
  const profile = { version: 1, phases: [{ key: 'main', label: '', duration_minutes: 30, installation_ids: [8],
    professionals: { mode: 'any', ids: [7], preferred_id: 7 } }] };
  const map = new Map([[2123, { id: 2123, name: 'Synthetic GLP follow-up', booking_profile: profile,
    duration_minutes: 30, issues: [], sale_mode: 'program_component_only' }]]);
  const resolved = contract.summarize(op.after, map);
  assert.equal(resolved.summary.ready_for_activation, true); assert.equal(resolved.summary.scheduling_mode, 'automatic');
  assert.equal(resolved.summary.warnings.length, 0);
  const commercial = contract.commercialReadiness({ ...op.after, appointments: resolved.appointments });
  assert.equal(commercial.commercial_ready, false); assert.equal(commercial.commercial_issues[0].code, 'program_price_profile_required');
});
test('tampered sealed package is rejected', () => {
  const plan = planner.buildPlan(fixture()); plan.operations[0].payload.status = 'active';
  assert.throws(() => planner.assertPlan(plan), /PACKAGE_CHANGED/);
});
test('operator contains prepare/check only and cannot write application data', () => {
  const source = fs.readFileSync(path.join(__dirname, '../bs-client-program-replies.js'), 'utf8');
  assert.match(source, /START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY/);
  assert.match(source, /\['prepare', 'check'\]/);
  assert.doesNotMatch(source, /(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE|CREATE TABLE)\s/i);
  assert.doesNotMatch(source, /require\([^\n]*(?:app\.js|\.\.\/\.\.\/models|src\/index)/);
  assert.match(source, /treatment-programs\/preview/);
  assert.match(source, /browser\.disconnect\(\)/);
});
test('scheduling proposal uses the actual canonical normalizer and never adds financial flags', () => {
  const contract = require('../../lib/treatmentPrograms.contract');
  const plan = planner.buildPlan(fixture());
  for (const operation of plan.operations) assert.deepEqual(contract.normalizeValues(operation.payload), operation.after);
  assert.equal(Object.hasOwn(plan.operations[0].payload, 'fiscal_mapping_pending'), false);
});
