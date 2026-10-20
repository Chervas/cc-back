'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs');
const fixture = require('../qa/program-closure-dev-fixture');
const clone = value => JSON.parse(JSON.stringify(value));
const valid = () => ({ clinic: { id_clinica: 1, nombre_clinica: 'Clinica ficticia DEV' },
  patient: { id_paciente: 33021, public_id: 'pac_09202026000000000001', clinica_id: 1 },
  actor: { id_usuario: 1, email_usuario: 'carlos@clinicaclick.com' },
  rooms: [73, 74].map(id => ({ id, clinica_id: 1, activo: 1, descripcion: 'bs-startup-isolated-20260920', profesionales_permitidos: [] })),
  doctors: [220, 221].map(doctor_id => ({ doctor_id, clinica_id: 1, activo: 1, recibe_citas: 1, notas_usuario: 'bs-startup-isolated-20260920' })),
  runtime_gates: { TREATMENT_PROGRAM_BOOKING_ENABLED: 'true', TREATMENT_PROGRAM_ECONOMICS_ENABLED: 'true',
    BOOKING_PROFILES_ENABLED: 'true', BOOKING_MULTI_RESOURCE_ENABLED: 'true', JOB_RUNTIME_NAMESPACE: 'dev', JOBS_WORKER_ENABLED: 'false', JOBS_CRON_LEADER: 'false' } });

test('fixture accepts only exact named isolated clinic/patient and dedicated resources', () => {
  assert.equal(fixture.validateScope(valid()), true);
  for (const edit of [
    value => { value.clinic.id_clinica = 82; }, value => { value.clinic.nombre_clinica = 'BS Medical'; },
    value => { value.patient.id_paciente = 33022; }, value => { value.patient.public_id = 'real-patient'; },
    value => { value.patient.clinica_id = 121; }, value => { value.actor.id_usuario = 2; },
    value => { value.rooms[0].descripcion = 'not-our-fixture'; }, value => { value.rooms[0].clinica_id = 121; },
    value => { value.doctors[0].notas_usuario = 'not-our-fixture'; }, value => { value.doctors[0].recibe_citas = 0; },
    value => { value.rooms[0].profesionales_permitidos = [221]; }, value => { value.rooms.pop(); },
  ]) { const value = valid(); edit(value); assert.throws(() => fixture.validateScope(value)); }
});
test('fixture fails closed without current full program gates and isolated disabled workers', () => {
  const base = valid().runtime_gates;
  fixture.assertRuntimeGates(base);
  for (const key of ['TREATMENT_PROGRAM_BOOKING_ENABLED', 'TREATMENT_PROGRAM_ECONOMICS_ENABLED', 'BOOKING_PROFILES_ENABLED', 'BOOKING_MULTI_RESOURCE_ENABLED']) {
    assert.throws(() => fixture.assertRuntimeGates({ ...base, [key]: 'false' }));
    const missing = clone(base); delete missing[key]; assert.throws(() => fixture.assertRuntimeGates(missing));
  }
  assert.throws(() => fixture.assertRuntimeGates({ ...base, JOB_RUNTIME_NAMESPACE: 'crm' }));
  assert.throws(() => fixture.assertRuntimeGates({ ...base, JOBS_WORKER_ENABLED: 'true' }));
  assert.throws(() => fixture.assertRuntimeGates({ ...base, JOBS_CRON_LEADER: 'true' }));
});
test('prepare requires exact opt-in before opening a database or loading production models', async () => {
  for (const gateValue of ['', '82', 'bs-startup-isolated-20260920', 'true']) {
    await assert.rejects(fixture.prepare({ gateValue }), /EXPLICIT_SYNTHETIC_DEV_WRITE_AUTHORIZATION_REQUIRED/);
  }
  await assert.rejects(fixture.prepare({ gateValue: fixture.MARKER, direct: 'true' }), /EXPLICIT_DIRECT_PROGRAM_MODE_REQUIRED/);
});
test('direct fixture branch returns a separate catalog only before any budget/enrollment/booking operation', () => {
  const code = fs.readFileSync(require.resolve('../qa/program-closure-dev-fixture'), 'utf8');
  const branch = code.slice(code.indexOf('    if (direct) {'), code.indexOf("    const economics = require('../../services/patientEconomics.service');"));
  assert(branch.includes('budget_created: false, voucher_created: false'));
  assert(branch.includes('EXISTING_BUDGETS_CHANGED'));
  assert.doesNotMatch(branch, /\.create\(|\.assign\(|\.book\(|transitionBudget|createBudget/);
  assert(code.includes("idempotency_key: direct ? MARKER + '-direct' : MARKER"));
});
test('operator inherits only validated live DEV runtime gates, never hardcodes enablement or copies credentials', () => {
  const flags = { ...valid().runtime_gates, BOOKING_PHASE_OFFSETS_ENABLED: 'false', DB_PASSWORD: 'must-not-copy', DELIVERY_ENABLED: 'true' };
  const environment = { DB_PASSWORD: 'own-dev-credential', TREATMENT_PROGRAM_BOOKING_ENABLED: 'false', BOOKING_PHASE_OFFSETS_ENABLED: 'true' };
  fixture.applyObservedRuntimeGates(flags, environment);
  assert.equal(environment.TREATMENT_PROGRAM_BOOKING_ENABLED, 'true');
  assert.equal(environment.BOOKING_PHASE_OFFSETS_ENABLED, 'false');
  assert.equal(environment.DB_PASSWORD, 'own-dev-credential'); assert.equal(environment.DELIVERY_ENABLED, undefined);
  const before = clone(environment);
  assert.throws(() => fixture.applyObservedRuntimeGates({ ...flags, TREATMENT_PROGRAM_BOOKING_ENABLED: 'false' }, environment));
  assert.deepEqual(environment, before);
  const absentRelative = { ...flags }; delete absentRelative.BOOKING_PHASE_OFFSETS_ENABLED;
  fixture.applyObservedRuntimeGates(absentRelative, environment); assert.equal(environment.BOOKING_PHASE_OFFSETS_ENABLED, undefined);
});
test('operator never forces flags, invokes old bootstrap/fixtures, books or sends; canonical economics own purchase activation', () => {
  const code = fs.readFileSync(require.resolve('../qa/program-closure-dev-fixture'), 'utf8');
  assert.doesNotMatch(code, /process\.env\.[A-Z_]+\s*=/);
  assert.doesNotMatch(code, /require\(['"][^'"]*(?:app\.js|isolated-bs-programs|prepare-isolated-clinical-fixture|crm-program-resume)/);
  assert.doesNotMatch(code, /(?:booking\.book|mutateAppointmentBooking|createPayment|createFiscalDocument|sendMessage|sendTemplate)\s*\(/);
  for (const expected of ['programs.create(', 'economics.createBudget(', 'economics.transitionBudget(', 'START TRANSACTION READ ONLY',
    "send_channel: 'none'", "collection_method: 'pending'", 'EXISTING_ROOMS_CHANGED', 'EXISTING_DOCTORS_CHANGED']) assert(code.includes(expected));
});
