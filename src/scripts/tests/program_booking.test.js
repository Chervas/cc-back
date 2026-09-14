'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { composeAppointmentProfile, normalizeCadence, seriesIssues, bookingRequest, programBookingEnabled } = require('../../lib/program-booking');
const { operationalSnapshot, snapshot } = require('../../lib/economicProgramSnapshot');
const { createPatientProgramBookingService, addVirtualBusy, consumeProgramSession } = require('../../services/patientProgramBooking.service');
const { solveBookingProfile } = require('../../lib/booking-profile-solver');
const { programAppointmentContext, programTreatmentDoctorIds } = require('../../lib/program-appointment-context');
const profile = (room = 9, doctors = [5]) => ({ version: 1, phases: [{ key: 'treatment', duration_minutes: 30, installation_ids: [room], professionals: { mode: 'any', ids: doctors, preferred_id: doctors[0] } }] });
const treatment = (id, room = 9) => ({ id, name: `Tratamiento ${id}`, booking_profile: profile(room) });
const appointments = () => [0, 7].map((offset, i) => ({ key: `s${i}`, label: `Sesión ${i + 1}`, offset_days: offset, treatment_ids: [20, 21], duration_minutes: 60, treatments: [treatment(20), treatment(21, 10)] }));
const definition = () => ({ id: 'test-program', version: 1, status: 'active', name: 'Programa', kind: 'program', total_price: 100, summary: { issues: [] }, appointments: appointments() });
const free = () => ({ windows: [{ start: '2030-01-07T08:00:00Z', end: '2030-01-07T20:00:00Z' }], busy: [] });

test('consent professional context follows treatment phases, not the primary appointment doctor', () => {
  const frozen = { phase_treatments: [{ key: 't1_p1', treatment_id: 20 }, { key: 't2_p1', treatment_id: 21 }] };
  const appointment = { import_metadata: { booking: { phases: [{ key: 't1_p1', doctor_ids: [5] }, { key: 't2_p1', doctor_ids: [8, 9] }] } } };
  assert.deepEqual(programTreatmentDoctorIds(frozen, appointment, 20), [5]);
  assert.deepEqual(programTreatmentDoctorIds(frozen, appointment, 21), [8, 9]);
  assert.deepEqual(programTreatmentDoctorIds(frozen, appointment, 99), []);
});

test('combined session preserves treatment order and sums exact phase durations', () => {
  const combined = composeAppointmentProfile(appointments()[0]);
  assert.equal(combined.duration_minutes, 60);
  assert.deepEqual(combined.profile.phases.map(p => p.installation_ids), [[9], [10]]);
  assert.deepEqual(combined.phase_treatments.map(p => p.treatment_id), [20, 21]);
  assert.deepEqual(composeAppointmentProfile({ treatments: [...appointments()[0].treatments].reverse() }).treatment_ids, [21, 20]);
});
test('combined profile never guesses missing clinical requirements or silently repeats a treatment', () => {
  assert.throws(() => composeAppointmentProfile({ treatments: [{ id: 1 }] }), { code: 'program_profile_missing' });
  assert.throws(() => composeAppointmentProfile({ treatments: [treatment(1), treatment(1)] }), { code: 'program_composition_invalid' });
});
test('weekly cadence is explicit, bounded and rejects invalid shapes', () => {
  assert.equal(normalizeCadence(null), null);
  for (const value of [{}, [], { mode: 'weekly', sessions_per_week: 0, min_days_between: 2 }, { mode: 'weekly', sessions_per_week: '2', min_days_between: 2 }]) assert.throws(() => normalizeCadence(value), { code: 'program_cadence_invalid' });
});
const cadence = { mode: 'weekly', sessions_per_week: 2, min_days_between: 2 };
const sessionAt = (key, date) => ({ key, start_at: `${date}T09:00:00Z`, end_at: `${date}T10:00:00Z` });
test('program enforces nonconsecutive days, weekly count and immutable session order', () => {
  assert.equal(seriesIssues([sessionAt('a', '2030-01-07'), sessionAt('b', '2030-01-09')], cadence, 'Europe/Madrid').length, 0);
  assert.equal(seriesIssues([sessionAt('a', '2030-01-07'), sessionAt('b', '2030-01-08')], cadence, 'Europe/Madrid')[0].code, 'program_minimum_gap');
  assert(seriesIssues(['07', '09', '11'].map((d, i) => sessionAt(String(i), `2030-01-${d}`)), cadence, 'Europe/Madrid').some(issue => issue.code === 'program_weekly_limit'));
  assert(seriesIssues([sessionAt('a', '2030-01-09'), sessionAt('b', '2030-01-07')], null, 'Europe/Madrid').some(issue => issue.code === 'program_session_order'));
});
test('pacing uses clinic civil days across DST, not elapsed multiples of 24 hours', () => {
  const rows = [{ key: 'a', start_at: '2030-03-30T11:00:00Z', end_at: '2030-03-30T12:00:00Z' }, { key: 'b', start_at: '2030-04-01T10:00:00Z', end_at: '2030-04-01T11:00:00Z' }];
  assert.equal(seriesIssues(rows, cadence, 'Europe/Madrid').length, 0);
});
const request = () => ({ request_key: 'request_123', snapshot_sha256: 'a'.repeat(64), sessions: [{ key: 's1', start_at: '2030-01-07T09:00:00Z', selections: { t1_p1: { doctor_id: 5 } } }] });
test('reservation parser rejects duplicate units, invalid dates and non-explicit acknowledgement', () => {
  assert.throws(() => bookingRequest({ ...request(), sessions: [request().sessions[0], request().sessions[0]] }), { code: 'program_booking_session_invalid' });
  for (const date of ['2030-02-30T09:00:00Z', '2030-01-07T09:00:30Z', '2030-01-07T10:00:00+01:00']) assert.throws(() => bookingRequest({ ...request(), sessions: [{ ...request().sessions[0], start_at: date }] }), { code: 'program_booking_session_invalid' });
  assert.throws(() => bookingRequest({ ...request(), sessions: [{ ...request().sessions[0], priority_acknowledged: 'true' }] }));
});
test('request hash is stable under phase/property order and ignores client-owned clinical/price claims', () => {
  const first = request(); first.sessions[0].selections.t1_p1.installation_id = 9;
  const second = request(); second.sessions[0].selections.t1_p1 = { installation_id: 9, doctor_id: 5 }; second.price = 0; second.patient_id = 99;
  assert.equal(bookingRequest(first).request_sha256, bookingRequest(second).request_sha256);
});
test('new canonical snapshot survives MySQL JSON property ordering and rejects tampering', () => {
  const frozen = snapshot(definition());
  const reorder = value => Array.isArray(value) ? value.map(reorder) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).reverse().map(key => [key, reorder(value[key])])) : value;
  assert.equal(operationalSnapshot(reorder(frozen)).appointments[0].booking_profile.phases.length, 2);
  frozen.appointments[0].treatments[0].booking_profile.phases[0].duration_minutes = 5;
  assert.throws(() => operationalSnapshot(frozen), { code: 'program_snapshot_not_operational' });
});
test('legacy preparation snapshots cannot accidentally become a schedulable purchase', () => {
  assert.throws(() => operationalSnapshot({ ...snapshot(definition()), schema_version: 1 }), { code: 'program_snapshot_not_operational' });
});
test('program booking needs all four coordinated gates, never just the old economic switch', async () => {
  assert.equal(programBookingEnabled({}), false);
  assert.equal(programBookingEnabled({ TREATMENT_PROGRAM_ECONOMICS_ENABLED: 'true' }), false);
  const api = createPatientProgramBookingService({ db: {}, enabled: () => false });
  await assert.rejects(api.read({ publicId: 'x', clinicId: 82 }), { code: 'program_booking_disabled' });
  await assert.rejects(api.propose({}), { code: 'program_booking_disabled' });
  await assert.rejects(api.book({}), { code: 'program_booking_disabled' });
});
test('virtual series occupancy blocks both cabins at their phase time and patient for the entire visit', () => {
  const context = { doctors: new Map([[5, free()]]), installations: new Map([[9, free()], [10, free()]]), installationKeys: new Map([[9, 'installation:9'], [10, 'installation:10']]), patientBusy: [] };
  const combined = composeAppointmentProfile(appointments()[0]).profile;
  const solution = solveBookingProfile({ profile: combined, start: '2030-01-07T09:00:00Z', ...context });
  addVirtualBusy(context, solution);
  assert.equal(context.installations.get(9).busy[0].end, '2030-01-07T09:30:00.000Z');
  assert.equal(context.installations.get(10).busy[0].start, '2030-01-07T09:30:00.000Z');
  assert.equal(context.patientBusy[0].end, '2030-01-07T10:00:00.000Z');
  assert.equal(solveBookingProfile({ profile: combined, start: '2030-01-07T09:30:00Z', ...context }), null);
});

test('historical program appointments retain canonical purchased treatment context after rebooking', async () => {
  const calls = [];
  const db = { PatientVoucher: { findOne: async ({ where }) => where.clinic_id === 82 && where.patient_id === 3 ? { id: 4 } : null },
    PatientProgramSession: { findOne: async ({ where }) => { calls.push(where); return where.id === '12' && where.voucher_id === 4 && where.session_key === 'one' ? { snapshot: { treatment_ids: [20, 21] } } : null; } } };
  const appointment = { id_cita: 8, clinica_id: 82, paciente_id: 3, voucher_id: 4, import_metadata: { program_session: { session_id: '12', key: 'one' } } };
  assert.deepEqual((await programAppointmentContext(db, appointment)).treatment_ids, [20, 21]);
  assert.equal(calls[0].appointment_id, 8);
  await assert.rejects(programAppointmentContext(db, { ...appointment, clinica_id: 72 }), { code: 'program_session_not_found' });
  await assert.rejects(programAppointmentContext(db, { ...appointment, paciente_id: 99 }), { code: 'program_session_not_found' });
  await assert.rejects(programAppointmentContext(db, { ...appointment, import_metadata: {} }), { code: 'program_session_not_found' });
});

test('HTTP planning requires patient sensitive access and calendar permission before serving composition', async () => {
  const fs = require('node:fs'), vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../../controllers/patientEconomics.controller'), 'utf8');
  const code = source.slice(source.indexOf('async function programContext('), source.indexOf('exports.getProgramPlan'));
  const checks = [];
  const fn = vm.runInNewContext(`(${code})`, { requireVoucherFeature: async (_, feature) => { checks.push(feature); return 82; },
    requireClinicFeature: async (_, feature) => { checks.push(feature); if (feature === 'patients.sensitive.view') throw Object.assign(new Error('forbidden'), { statusCode: 403 }); }, actorId: () => 1 });
  await assert.rejects(fn({ params: { voucherId: 'x' }, body: {} }), { statusCode: 403 });
  assert.deepEqual(checks, ['patients.view', 'patients.sensitive.view']);
});
