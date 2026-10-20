'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { hash } = require('../../lib/cliniccloud-import/adapter');
const contract = require('../../lib/treatmentPrograms.contract');
const planner = require('../../lib/cliniccloud-import/bs-program-catalog-closure');
const copy = value => JSON.parse(JSON.stringify(value));

function fixture() {
  const decision = { version: 1, scope: planner.VERSION, authorized_at: '2026-10-20T10:00:00.000Z',
    authority_reference: 'Carlos, respuesta explícita sobre programas del 20/10/2026',
    authority_text: 'Aplicar IVA 21 % a los programas corporales; mantener las pautas escritas y usar 15 días sólo si no hay pauta. Activar Ligereza y Transición si la validación canónica lo permite.',
    corporate_program_tax_percent: 21, default_interval_days: 15, activation_ids: [25, 26] };
  const programs = planner.SPECS.filter(spec => [25, 26].includes(spec.id)).map(spec => ({ id: spec.id, public_id: spec.public_id, clinic_id: spec.clinic_id,
    name: `Oferta ${spec.reference}`, kind: 'program', status: 'draft', version_number: 2,
    total_price: spec.id === 25 ? '430.00' : '670.00', price_profile: null, cadence: null,
    notes: 'Condiciones clínicas y procedencia documental conservadas sin reescritura.',
    request_key: `source-${spec.id}`, request_payload_hash: 'b'.repeat(64), created_by: 2,
    created_at: '2026-09-27 12:00:00', updated_at: '2026-09-27 12:00:00', updated_by: 2,
    appointments: spec.treatments.map((id, index) => ({ key: `a${index + 1}`, label: `Cita ${index + 1}`,
      treatment_ids: [id], offset_days: index * 7 })) }));
  return { decision, snapshot: { target: 'crm', group_id: 29, captured_at: '2026-10-20T10:05:00.000Z',
    clinics: [{ id_clinica: 66, grupoClinicaId: 29 }, { id_clinica: 72, grupoClinicaId: 29 }], programs },
  createdAt: '2026-10-20T10:06:00.000Z' };
}
function preview(operation, overrides = {}) {
  return { program_id: operation.program_id, expected_version: operation.expected_version,
    before_sha256: operation.before_sha256, checked_at: '2026-10-20T10:05:30.000Z',
    item: { ...copy(operation.after), status: 'active', clinic_id: operation.clinic_id, version: 0,
      summary: { ready_for_activation: true, issues: [] }, commercial_ready: true, commercial_issues: [], ...overrides } };
}
function otherProgram(input, id) {
  return { ...copy(input.snapshot.programs[0]), id, public_id: `00000000-0000-0000-0000-${String(id).padStart(12, '0')}` };
}

test('proposes only the two expressly reviewed programme total profiles without mutating input', () => {
  const input = fixture(), before = hash(input), plan = planner.buildPlan(input);
  assert.equal(hash(input), before); assert.deepEqual(plan.operations.map(operation => operation.program_id), [25, 26]);
  for (const operation of plan.operations) {
    assert.deepEqual(operation.after.price_profile, planner.PROFILE_21);
    assert.equal(operation.after.status, 'draft'); assert.equal(operation.activation, false);
    assert.equal(operation.expected_version, 2); assert.equal(operation.payload.expected_version, 2);
    assert.equal(operation.before_sha256, hash(operation.before)); assert.equal(operation.payload_sha256, hash(operation.payload));
    assert.equal(operation.authority_sha256, hash(input.decision.authority_text));
    assert.equal(operation.fiscal_changed, true); assert.equal(operation.dates_changed, false);
    assert.match(plan.assessments.find(assessment => assessment.program_id === operation.program_id).activation_blocked, /PREVIEW/);
    for (const field of ['name', 'kind', 'total_price', 'notes', 'cadence', 'appointments']) {
      assert.deepEqual(operation.after[field], contract.normalizeValues(operation.before)[field]);
    }
  }
  assert.equal(plan.policy.offline_plan_only, true); assert.equal(plan.policy.hold_changed, false);
  assert.equal(plan.policy.messages_sent, false); assert.equal(plan.policy.clinical_composition_changed, false);
  planner.assertPlan(plan);
});

test('a fresh exact canonical preview enables only the expressly requested activation', () => {
  const input = fixture(); input.decision.activation_ids = [25];
  const initial = planner.buildPlan(input), plan = planner.buildPlan({ ...input, previews: [preview(initial.operations[0])] });
  assert.equal(plan.operations[0].activation, true); assert.equal(plan.operations[0].after.status, 'active');
  assert.equal(plan.operations[1].activation, false); assert.equal(plan.operations[1].after.status, 'draft');
  assert.equal(plan.operations[0].canonical_preview.expected_version, 2);
  planner.assertPlan(plan);
});

test('readiness preview must match exact clinic, definition, proposed profile and status', () => {
  const input = fixture(), initial = planner.buildPlan(input), op = initial.operations[0];
  const patches = [{ clinic_id: 66 }, { version: 2 }, { status: 'draft' }, { total_price: 431 },
    { name: 'Another offer' }, { price_profile: null }, { notes: 'Lost clinical conditions' },
    { appointments: op.after.appointments.map(appointment => ({ ...appointment, offset_days: 0 })) },
    { summary: { ready_for_activation: false, issues: [] } },
    { summary: { ready_for_activation: true, issues: [{ code: 'professional_unavailable' }] } },
    { summary: { ready_for_activation: true } }, { commercial_ready: false },
    { commercial_issues: [{ code: 'program_price_profile_required' }] }, { commercial_issues: null }];
  for (const patch of patches) {
    const plan = planner.buildPlan({ ...input, previews: [preview(op, patch)] });
    assert.equal(plan.operations[0].activation, false, JSON.stringify(patch));
    assert.equal(plan.operations[0].after.status, 'draft');
  }
});

test('preview is bound to the full before row and version, not merely the programme name', () => {
  const input = fixture(), op = planner.buildPlan(input).operations[0], valid = preview(op);
  for (const patch of [{ expected_version: 1 }, { before_sha256: 'a'.repeat(64) },
    { checked_at: '2026-10-20T10:04:59.000Z' }, { checked_at: '2026-10-20T10:06:01.000Z' },
    { checked_at: '2026-10-20 10:05:30' }]) {
    const plan = planner.buildPlan({ ...input, previews: [{ ...valid, ...patch }] });
    assert.equal(plan.operations[0].activation, false);
  }
});

test('stale, future, malformed or pre-authority snapshots are rejected before proposing data changes', () => {
  for (const mutate of [input => { input.createdAt = '2026-10-20T10:21:00.001Z'; },
    input => { input.createdAt = '2026-10-20T10:04:59.000Z'; },
    input => { input.snapshot.captured_at = 'invalid'; }, input => { input.createdAt = 'invalid'; },
    input => { input.decision.authorized_at = '2026-10-20T10:05:00.001Z'; }]) {
    const input = fixture(); mutate(input);
    assert.throws(() => planner.buildPlan(input), /SNAPSHOT_INVALID_OR_STALE/);
  }
});

test('preserves explicit weekly offsets, explicit cadence and any manual gaps without inventing default dates', () => {
  const input = fixture();
  input.snapshot.programs[0].cadence = { mode: 'weekly', sessions_per_week: 1, min_days_between: 7 };
  input.snapshot.programs[1].appointments[3].offset_days = null;
  const plan = planner.buildPlan(input);
  assert.deepEqual(plan.operations[0].after.appointments.map(appointment => appointment.offset_days), [0, 7, 14, 21, 28, 35]);
  assert.deepEqual(plan.operations[0].after.cadence, input.snapshot.programs[0].cadence);
  assert.equal(plan.operations[1].after.appointments[3].offset_days, null);
  assert.equal(plan.policy.default_interval_applied, false);
  assert.equal(plan.decisions.resolved.find(decision => decision.key === 'DEFAULT_INTERVAL_DAYS').applied, false);
});

test('cadence provenance is the exact literal protocol, not an importer proposal or populated offsets', () => {
  const input = fixture(); input.snapshot.programs[0].notes = 'Una cita por semana: propuesta base 0,7; revisar con la clínica.';
  input.snapshot.programs[0].appointments.forEach(appointment => { appointment.offset_days = null; });
  const plan = planner.buildPlan(input), operation = plan.operations[0];
  assert.equal(operation.source_cadence.provenance, 'literal_clinic_protocol');
  assert.equal(operation.source_cadence.file_sha256, 'ec28b4ea7bdfcb204afd6af0b2e638f8db1f570e3dc743fc82cec25e0c768672');
  assert.deepEqual(operation.source_cadence.pdf_pages, [29, 30]);
  assert.equal(operation.source_cadence.literal, '6 citas, una por semana.');
  assert.ok(operation.after.appointments.every(appointment => appointment.offset_days == null));
  assert.equal(operation.after.notes, input.snapshot.programs[0].notes);
  assert.equal(plan.decisions.resolved.find(decision => decision.key === 'DEFAULT_INTERVAL_DAYS').applied, false);
  planner.assertPlan(plan);
});

test('does not preserve an invented 15-day proposal that conflicts with the literal weekly source', () => {
  for (const mutate of [input => {
    input.snapshot.programs[0].appointments.forEach((appointment, index) => { appointment.offset_days = index * 15; });
  }, input => { input.snapshot.programs[0].cadence = { mode: 'weekly', sessions_per_week: 2, min_days_between: 2 }; }]) {
    const input = fixture(); mutate(input);
    assert.throws(() => planner.buildPlan(input), /CADENCE_CONFLICTS_WITH_LITERAL_SOURCE/);
  }
});

test('GLP1 without its new explicit tax authority and Contorno remain blocked, without guessing techniques or a pen', () => {
  const input = fixture();
  for (const id of [19, 20, 21, 22]) input.snapshot.programs.push(otherProgram(input, id));
  const before = hash(input.snapshot.programs.slice(2)), plan = planner.buildPlan(input);
  assert.deepEqual(plan.operations.map(operation => operation.program_id), [25, 26]);
  assert.equal(hash(input.snapshot.programs.slice(2)), before);
  for (const id of [19, 20, 21]) {
    assert.match(plan.assessments.find(assessment => assessment.program_id === id).reason, /CARBOXYTHERAPY_HIFU/);
  }
  assert.match(plan.assessments.find(assessment => assessment.program_id === 22).reason, /GLP1_EXPLICIT_AUTHORITY/);
  assert.deepEqual(plan.decisions.blocked.map(decision => decision.program_id), [19, 20, 21]);
});

function addGlp(input) {
  const spec = planner.SPECS.find(spec => spec.id === 22), template = input.snapshot.programs[0];
  input.snapshot.programs.push({ ...copy(template), id: 22, public_id: spec.public_id, name: 'Programa GLP-1', total_price: '250.00',
    appointments: spec.treatments.map((id, index) => ({ key: `obe_22_${index + 1}`, label: `Revisión médica ${index + 1}`,
      treatment_ids: [id], offset_days: index * 15 })) });
  return input;
}
test('new explicit reply prepares GLP1 exemption while preserving three reviews, 250 EUR and 0/15/30, without a pen', () => {
  const input = addGlp(fixture()); input.decision.glp1_three_medical_reviews_no_vat = true; input.decision.activation_ids.push(22);
  const initial = planner.buildPlan(input), proposed = initial.operations.find(operation => operation.program_id === 22);
  assert.deepEqual(proposed.after.price_profile, planner.PROFILE_GLP1); assert.equal(proposed.after.total_price, 250);
  assert.equal(proposed.after.appointments.length, 3);
  assert.deepEqual(proposed.after.appointments.map(appointment => appointment.treatment_ids), [[2123], [2123], [2123]]);
  assert.deepEqual(proposed.after.appointments.map(appointment => appointment.offset_days), [0, 15, 30]);
  assert.equal(proposed.after.notes, input.snapshot.programs[2].notes); assert.equal(proposed.after.status, 'draft');
  const active = planner.buildPlan({ ...input, previews: [preview(proposed)] });
  assert.equal(active.operations.find(operation => operation.program_id === 22).after.status, 'active');
  assert.equal(active.decisions.resolved.find(decision => decision.key === 'GLP1_EXISTING_THREE_MEDICAL_REVIEWS_NO_VAT').pen_included, false);
  planner.assertPlan(initial); planner.assertPlan(active);
});
test('GLP1 cannot be widened to a pen, other techniques, a fourth review or generic corporate VAT', () => {
  for (const mutate of [input => input.snapshot.programs[2].appointments.push({ ...copy(input.snapshot.programs[2].appointments[0]), key: 'fourth_review' }),
    input => { input.snapshot.programs[2].appointments[0].treatment_ids.push(2111); },
    input => { input.snapshot.programs[2].price_profile = copy(planner.PROFILE_21); }]) {
    const input = addGlp(fixture()); input.decision.glp1_three_medical_reviews_no_vat = true; mutate(input);
    assert.throws(() => planner.buildPlan(input), /BS_CLOSURE_/);
  }
  const input = fixture(); input.decision.activation_ids.push(22);
  assert.throws(() => planner.buildPlan(input), /GLP1_EXPLICIT_AUTHORITY_REQUIRED/);
});

test('does not rewrite unrelated capillary, medical, individual or other programme definitions', () => {
  const input = fixture();
  for (const id of [1, 2, 6, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 23, 24, 27, 28, 29]) {
    input.snapshot.programs.push({ ...otherProgram(input, id), clinic_id: [6, 8, 9].includes(id) ? 66 : 72 });
  }
  const plan = planner.buildPlan(input);
  assert.equal(plan.operations.length, 2);
  assert.equal(plan.assessments.filter(assessment => assessment.action === 'preserve').length, 18);
});

function contornoFixture() {
  const input = fixture(), spec = planner.SPECS.find(value => value.id === 11), base = input.snapshot.programs[0];
  input.decision.contorno_standard_8_visits_1040_vat21 = true; input.decision.activation_ids = [11];
  input.snapshot.programs = [{ ...copy(base), id: 11, public_id: spec.public_id, name: 'BS Contorno',
    total_price: '1040.00', version_number: 3, appointments: spec.treatment_sets.map((ids, index) => ({
      key: `cor_05_${index + 1}`, label: `${index + 1}/8 · Cyclone + EXION${ids.length > 1 ? ' + mesoterapia' : ''}`,
      offset_days: index * 7, treatment_ids: copy(ids),
    })) }];
  return input;
}

test('explicit standard Contorno closure retains 1040 EUR, weekly eight visits and extra mesotherapy only in 2/5/8', () => {
  const input = contornoFixture(), before = hash(input), draft = planner.buildPlan(input), op = draft.operations[0];
  assert.equal(hash(input), before); assert.deepEqual(draft.operations.map(value => value.program_id), [11]);
  assert.equal(op.after.total_price, 1040); assert.deepEqual(op.after.price_profile, planner.PROFILE_21);
  assert.deepEqual(op.after.appointments.map(value => value.offset_days), [0, 7, 14, 21, 28, 35, 42, 49]);
  assert.deepEqual(op.after.appointments.map(value => value.treatment_ids), [[2122], [2122, 1974], [2122], [2122], [2122, 1974], [2122], [2122], [2122, 1974]]);
  assert.equal(op.after.status, 'draft'); assert.equal(op.after.notes, input.snapshot.programs[0].notes);
  const active = planner.buildPlan({ ...input, previews: [preview(op)] });
  assert.equal(active.operations[0].after.status, 'active'); assert.equal(active.operations[0].activation, true);
  assert.equal(active.operations[0].expected_version, 3); planner.assertPlan(active);
});

test('Contorno standard requires explicit authority and cannot absorb Arranque/10/Continuidad timing or price changes', () => {
  for (const mutate of [value => value.snapshot.programs[0].total_price = '1041.00',
    value => value.snapshot.programs[0].name = 'Contorno 10', value => value.snapshot.programs[0].appointments[0].treatment_ids = [2122, 1974],
    value => value.snapshot.programs[0].appointments[1].treatment_ids = [1974, 2122],
    value => value.snapshot.programs[0].appointments[1].offset_days = 15,
    value => value.snapshot.programs[0].appointments[1].offset_days = null]) {
    const input = contornoFixture(); mutate(input); assert.throws(() => planner.buildPlan(input), /BS_CLOSURE_/);
  }
  const input = contornoFixture(); delete input.decision.contorno_standard_8_visits_1040_vat21;
  assert.throws(() => planner.buildPlan(input), /CONTORNO_EXPLICIT_AUTHORITY_REQUIRED/);
  input.decision.activation_ids = [];
  assert.equal(planner.buildPlan(input).operations.length, 0);
});

test('rejects scope leaks, duplicate snapshots and a changed stable identity or composition', () => {
  for (const mutate of [input => { input.snapshot.target = 'dev'; }, input => { input.snapshot.group_id = 30; },
    input => { input.snapshot.clinics[0].grupoClinicaId = 30; }, input => { input.snapshot.programs[0].clinic_id = 66; },
    input => { input.snapshot.programs[0].public_id = 'another-id'; },
    input => input.snapshot.programs.push(copy(input.snapshot.programs[0])),
    input => { input.snapshot.programs[0].appointments.pop(); },
    input => { input.snapshot.programs[1].appointments[0].treatment_ids = [1967]; },
    input => { input.snapshot.programs[0].kind = 'voucher'; }, input => { input.snapshot.programs[0].version_number = 0; }]) {
    const input = fixture(); mutate(input);
    assert.throws(() => planner.buildPlan(input), /BS_CLOSURE_/);
  }
});

test('a different existing explicit fiscal profile requires new review instead of silently overwriting it', () => {
  const input = fixture(); input.snapshot.programs[0].price_profile = { schema_version: 1,
    price_semantics: 'gross_tax_included', tax_percent: 0, exemption_reason: 'A prior human review' };
  assert.throws(() => planner.buildPlan(input), /EXISTING_FISCAL_PROFILE_REQUIRES_REVIEW/);
});

test('does not reactivate archived programmes or alter their stored fiscal profile', () => {
  const input = fixture(); input.snapshot.programs[0].status = 'archived';
  const plan = planner.buildPlan(input);
  assert.deepEqual(plan.operations.map(operation => operation.program_id), [26]);
  assert.equal(plan.assessments[0].reason, 'ARCHIVED_PROGRAM_PRESERVED');
});

test('already configured profiles are idempotent; activation is a distinct audited change', () => {
  const input = fixture();
  input.snapshot.programs.forEach(row => { row.price_profile = copy(planner.PROFILE_21); });
  assert.equal(planner.buildPlan(input).operations.length, 0);
  const unconfigured = fixture(), operation = planner.buildPlan(unconfigured).operations[0];
  operation.before = copy(input.snapshot.programs[0]); operation.before_sha256 = hash(operation.before);
  const plan = planner.buildPlan({ ...input, previews: [preview(operation)] });
  assert.equal(plan.operations.length, 1); assert.equal(plan.operations[0].fiscal_changed, false);
  assert.equal(plan.operations[0].activation, true); planner.assertPlan(plan);
});

test('a fresh fiscal proposal for an already active programme preserves its activation state', () => {
  const input = fixture(); input.snapshot.programs[0].status = 'active';
  const plan = planner.buildPlan(input);
  assert.equal(plan.operations[0].activation, false); assert.equal(plan.operations[0].after.status, 'active');
  planner.assertPlan(plan);
});

test('rejects unscoped, old or widened authority and duplicate or unrelated previews', () => {
  for (const mutate of [input => { input.decision.scope = 'generic-import'; },
    input => { input.decision.authorized_at = '2026-10-15T10:00:00.000Z'; },
    input => { input.decision.corporate_program_tax_percent = 4; }, input => { input.decision.default_interval_days = 30; },
    input => { input.decision.activation_ids = [22]; }, input => { input.decision.activation_ids = [25, 25]; },
    input => { input.decision.authority_text = ''; }, input => { input.decision.authority_reference = ''; },
    input => { input.previews = [{ program_id: 22 }]; },
    input => { input.previews = [{ program_id: 25 }, { program_id: 25 }]; }]) {
    const input = fixture(); mutate(input);
    assert.throws(() => planner.buildPlan(input), /BS_CLOSURE_/);
  }
});

test('full-row CAS and immutable revision checks are reused from the established operator', () => {
  const operation = planner.buildPlan(fixture()).operations[0];
  assert.equal(planner.assessCurrent(operation, copy(operation.before)), 'pending');
  const current = { ...copy(operation.before), ...copy(operation.after), version_number: 3, updated_by: 9 };
  assert.equal(planner.assessCurrent(operation, current), 'applied_requires_revision_verification');
  assert.equal(planner.assessCurrent(operation, { ...current, version_number: 4 }), 'conflict');
  assert.equal(planner.assessCurrent(operation, { ...operation.before, notes: 'Concurrent human edit' }), 'conflict');
  assert.equal(planner.assessCurrent(operation, { ...current, request_key: 'changed-origin' }), 'conflict');
  const revision = { program_id: 25, version_number: 3, actor_id: 9, snapshot: copy(current) };
  assert.equal(planner.verifyAppliedRevision(operation, current, [revision]), true);
  assert.equal(planner.verifyAppliedRevision(operation, current, []), false);
  assert.equal(planner.verifyAppliedRevision(operation, current, [revision, revision]), false);
  assert.equal(planner.verifyAppliedRevision(operation, current, [{ ...revision, actor_id: 2 }]), false);
});

test('actual canonical commercial readiness clears the included-only total-profile gate', () => {
  const operation = planner.buildPlan(fixture()).operations[0];
  const resolved = { ...operation.after, appointments: operation.after.appointments.map(appointment => ({ ...appointment,
    treatments: [{ id: 2124, sale_mode: 'program_component_only' }] })) };
  assert.equal(contract.commercialReadiness({ ...resolved, price_profile: null }).commercial_ready, false);
  assert.deepEqual(contract.commercialReadiness(resolved), { commercial_ready: true, commercial_issues: [] });
});

test('tampered packages fail validation, including a rehashed clinical or unverified activation change', () => {
  const plan = planner.buildPlan(fixture()); plan.operations[0].payload.total_price = 1;
  assert.throws(() => planner.assertPlan(plan), /PACKAGE_CHANGED/);
  for (const mutate of [operation => { operation.after.notes = 'Deleted conditions'; },
    operation => { operation.after.status = 'active'; }, operation => { operation.after.appointments[0].offset_days = 15; }]) {
    const forged = planner.buildPlan(fixture()), operation = forged.operations[0]; mutate(operation);
    operation.payload = { ...copy(operation.after), expected_version: operation.expected_version };
    operation.payload_sha256 = hash(operation.payload);
    const { operation_sha256, ...record } = operation; operation.operation_sha256 = hash(record);
    const { package_sha256, ...body } = forged; forged.package_sha256 = hash(body);
    assert.throws(() => planner.assertPlan(forged), /BS_CLOSURE_/);
  }
});

test('planner source is offline and exposes no apply path, transport, models or environment gate changes', () => {
  const source = fs.readFileSync(require.resolve('../../lib/cliniccloud-import/bs-program-catalog-closure'), 'utf8');
  assert.doesNotMatch(source, /require\([^\n]*(?:models|sequelize|https?|app\.js)/);
  assert.doesNotMatch(source, /(?:UPDATE|INSERT INTO|DELETE FROM|ALTER TABLE|CREATE TABLE)\s/i);
  assert.doesNotMatch(source, /process\.env|fetch\(|\.request\(|\.query\(|\.save\(|\.update\(/);
  assert.equal(typeof planner.apply, 'undefined');
});
