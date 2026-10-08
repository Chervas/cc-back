'use strict';

// Synthetic resources only. No database, provider, runtime bootstrap or writes.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBookingProfile } = require('../../lib/booking-profile');
const { solveBookingProfile, occupancyForSolution } = require('../../lib/booking-profile-solver');
const { attentionVisitOrigin } = require('../../lib/booking-attention-origin');
const { bookingPlanHash, assertBookingPlanReceipt } = require('../../lib/booking-plan-receipt');
const { solutionsForCalendar, guidedTreatmentOptions } = require('../../services/appointmentBookingAvailability.service');

const BASE = Date.parse('2030-01-07T09:00:00Z');
const at = minutes => new Date(BASE + minutes * 60000).toISOString();
const DOCTOR = 221, CLINIC = 72, SOURCE = 42;
const partial = { mode: 'start_end', start_minutes: 5, end_minutes: 5,
  start_window_minutes: 10, end_window_minutes: 10 };
const initial = { mode: 'start_only', start_minutes: 5, start_window_minutes: 15 };
const resource = patch => ({ clinic_id: CLINIC, schedule_verified: true, absence_windows: [],
  windows: [{ start: at(-60), end: at(180) }], busy: [], attention_visits: [], ...patch });
const unit = id => ({ id, name: 'Synthetic machine', status: 'available', turnaround_minutes: 0,
  installation_ids: new Set([9, 10]), busy: [], attention_policy: { mode: 'continuous', patient_preparation_minutes: 0 } });

function sourceEvidence() {
  const profile = normalizeBookingProfile({ version: 3, phases: [{ key: 'source', duration_minutes: 20,
    installation_ids: [9], professionals: { mode: 'any', ids: [DOCTOR] },
    equipment_requirements: [{ equipment_ids: [1] }], staff_attention: [partial] }] });
  const solution = solveBookingProfile({ profile, start: at(0),
    doctors: new Map([[DOCTOR, resource()]]), installations: new Map([[9, resource()]]), equipment: new Map([[1, unit(1)]]) });
  assert(solution);
  return { appointment: { id_cita: SOURCE, clinica_id: CLINIC, source_system: 'cliniccloud', inicio: at(0), fin: at(20),
    booking_legacy_attention_snapshot: { version: 1, profile, phases: solution.phases } },
    occupancies: occupancyForSolution(solution).map(row => ({ ...row, appointment_id: SOURCE })) };
}
function origin(evidence) { return attentionVisitOrigin({ ...evidence, doctorId: DOCTOR }); }
function fixture(evidence = sourceEvidence()) {
  const profile = normalizeBookingProfile({ version: 4, phases: [{ key: 'ems', duration_minutes: 30,
    start_offset_minutes: 0, installation_ids: [10], professionals: { mode: 'any', ids: [DOCTOR] },
    equipment_requirements: [{ equipment_ids: [2] }], staff_attention: [initial], preparation_sharing: { mode: 'same_start' } }] });
  const busy = evidence.occupancies.filter(row => row.resource_key === `doctor:${DOCTOR}`)
    .map(row => ({ start: row.start_at, end: row.end_at, appointment_id: Number(evidence.appointment.id_cita), can_share: false }));
  return { profile, start: at(0), selections: { ems: { doctor_id: DOCTOR, installation_id: 10 } },
    clinicWindows: [{ start: at(-60), end: at(180) }],
    doctors: new Map([[DOCTOR, resource({ agenda_flexible: true, allow_legacy_attention_confirmation: true,
      busy, attention_visits: [origin(evidence)] })]]),
    installations: new Map([[9, resource({ resource_key: 'installation:9' })], [10, resource({ resource_key: 'installation:10' })]]),
    equipment: new Map([[1, unit(1)], [2, unit(2)]]) };
}
const confirmed = f => solveBookingProfile({ ...f, allowOverlap: true });

test('a valid partial imported v3 snapshot becomes narrow evidence, never a verified v4 sharing contract', () => {
  const f = sourceEvidence(), before = structuredClone(f);
  const row = origin(f);
  assert.equal(row.verified, false);
  assert.equal(row.legacy_partial_verified, true);
  assert.equal(row.partial, true);
  assert.equal(row.clinic_id, CLINIC);
  assert.deepEqual(f, before);
  const attrs = { ...f.appointment, booking_legacy_attention_snapshot: JSON.stringify(f.appointment.booking_legacy_attention_snapshot) };
  assert.equal(attentionVisitOrigin({ appointment: { get: key => attrs[key] }, doctorId: DOCTOR,
    occupancies: f.occupancies }).legacy_partial_verified, true);
  const privateEvidence = sourceEvidence();
  privateEvidence.appointment.patient_name = 'Private patient'; privateEvidence.appointment.nota = 'Private note';
  privateEvidence.appointment.booking_legacy_attention_snapshot.phases[0].doctor_names = ['Private doctor'];
  privateEvidence.appointment.booking_legacy_attention_snapshot.phases[0].label = 'Private clinical label';
  const serialized = JSON.stringify(origin(privateEvidence));
  for (const secret of ['Private patient', 'Private note', 'Private doctor', 'Private clinical label']) assert(!serialized.includes(secret));
  const spoof = sourceEvidence(); delete spoof.appointment.booking_legacy_attention_snapshot;
  spoof.appointment.import_metadata = { legacy_partial_verified: true, booking: f.appointment.booking_legacy_attention_snapshot };
  assert.notEqual(origin(spoof).legacy_partial_verified, true, 'A caller-named flag is not stored source evidence');
});

test('legacy evidence rejects missing, duplicate, extra or changed staff rows and malformed geometry', () => {
  const corruptions = [
    f => { f.occupancies = f.occupancies.filter(row => row.resource_key !== `doctor:${DOCTOR}`); },
    f => { f.occupancies.push({ ...f.occupancies.find(row => row.resource_key === `doctor:${DOCTOR}`) }); },
    f => { f.occupancies.push({ ...f.occupancies.find(row => row.resource_key === `doctor:${DOCTOR}`), start_at: at(5), end_at: at(10) }); },
    f => { f.occupancies.find(row => row.resource_key === `doctor:${DOCTOR}`).end_at = at(10); },
    f => { f.occupancies.find(row => row.resource_key === `doctor:${DOCTOR}`).phase_key = 'other'; },
    f => { f.appointment.fin = at(25); },
    f => { f.appointment.booking_legacy_attention_snapshot.phases[0].start_at = at(5); },
    f => { f.appointment.booking_legacy_attention_snapshot.phases[0].doctor_ids = [222]; },
    f => { f.appointment.booking_legacy_attention_snapshot.phases[0].staff_attention[0].end_minutes = 10; },
    f => { f.appointment.booking_legacy_attention_snapshot.version = 2; },
    f => { f.appointment.booking_legacy_attention_snapshot.attention_requirements_pending = ['pending']; },
    f => { f.appointment.booking_legacy_attention_snapshot.attention_requirements_pending = {}; },
    f => { f.appointment.booking_legacy_attention_snapshot = '{malformed'; },
    f => { f.appointment.clinica_id = null; },
    f => { f.appointment.source_system = null; },
    f => { f.appointment.source_system = 'treatment_program'; },
    f => { f.appointment.source_system = 'clinicaclick'; },
  ];
  for (const mutate of corruptions) {
    const f = sourceEvidence(); mutate(f);
    assert.notEqual(origin(f).legacy_partial_verified, true, mutate.toString());
    assert.equal(confirmed(fixture(f)), null, mutate.toString());
  }
});

test('continuous or multiphase historical snapshots are not narrow partial-source evidence', () => {
  const f = sourceEvidence(), booking = f.appointment.booking_legacy_attention_snapshot;
  booking.profile.phases[0].staff_attention = [{ mode: 'continuous', patient_preparation_minutes: 0 }];
  booking.phases[0].staff_attention = [{ mode: 'continuous', patient_preparation_minutes: 0 }];
  booking.phases[0].staff_intervals = [{ start_at: at(0), end_at: at(20), kind: 'continuous' }];
  f.occupancies = f.occupancies.filter(row => row.resource_key !== `doctor:${DOCTOR}`);
  f.occupancies.push({ appointment_id: SOURCE, phase_key: 'source', resource_key: `doctor:${DOCTOR}`, doctor_id: DOCTOR,
    start_at: at(0), end_at: at(20) });
  assert.notEqual(origin(f).legacy_partial_verified, true);
  assert.equal(confirmed(fixture(f)), null);

  const multi = sourceEvidence(), snapshot = multi.appointment.booking_legacy_attention_snapshot;
  snapshot.profile.phases.push({ ...snapshot.profile.phases[0], key: 'source_2' });
  snapshot.phases.push({ ...snapshot.phases[0], key: 'source_2', start_at: at(20), end_at: at(40),
    staff_intervals: [{ start_at: at(20), end_at: at(25), kind: 'start' }, { start_at: at(30), end_at: at(35), kind: 'end' }] });
  multi.appointment.fin = at(40);
  multi.occupancies.push(...multi.occupancies.filter(row => row.resource_key === `doctor:${DOCTOR}`).map((row, index) => ({
    ...row, phase_key: 'source_2', start_at: at(index ? 30 : 20), end_at: at(index ? 35 : 25) })));
  assert.notEqual(origin(multi).legacy_partial_verified, true);
});

test('confirmed scoped exception fits free actual attention and records an explicit pinned warning', () => {
  const f = fixture(), before = structuredClone(f);
  assert.equal(solveBookingProfile(f), null);
  const solution = confirmed(f);
  assert(solution);
  assert.equal(solution.capacity_fully_verified, true);
  assert.equal(solution.requires_overlap_acknowledgement, true);
  assert.deepEqual(solution.phases[0].staff_intervals, [{ start_at: at(5), end_at: at(10), kind: 'start' }]);
  const warning = solution.warnings.find(row => row.code === 'FLEXIBLE_AGENDA'
    && row.reasons?.includes('legacy_attention_origin'));
  assert(warning);
  assert.equal(warning.phase_key, 'ems'); assert.equal(warning.doctor_id, DOCTOR);
  assert.deepEqual(warning.appointment_ids, [SOURCE]); assert(warning.message);
  assert.deepEqual(f, before, 'Existing attention and resources are never moved or relaxed');
});

test('permission, explicit selected doctor and same-clinic origin are all mandatory', () => {
  for (const mutate of [
    f => { f.doctors.get(DOCTOR).allow_legacy_attention_confirmation = false; },
    f => { f.doctors.get(DOCTOR).agenda_flexible = false; },
    f => { delete f.doctors.get(DOCTOR).allow_legacy_attention_confirmation; },
    f => { f.selections = {}; },
    f => { f.selections.ems.doctor_id = 222; },
    f => { f.doctors.get(DOCTOR).attention_visits[0].clinic_id = 66; },
  ]) {
    const f = fixture(); mutate(f); assert.equal(confirmed(f), null, mutate.toString());
  }
  const f = fixture();
  f.doctors.set(222, resource({ agenda_flexible: true, allow_legacy_attention_confirmation: true }));
  delete f.doctors.get(DOCTOR).allow_legacy_attention_confirmation;
  assert.equal(confirmed(f), null, 'A flag on another doctor cannot authorize this selected doctor');
});

test('v4 evidence, including invalid v4 snapshots, cannot use the legacy exception', () => {
  const source = sourceEvidence();
  const f = fixture(source), p = normalizeBookingProfile({ version: 4, phases: [{ key: 'v4_source', duration_minutes: 30,
    start_offset_minutes: 0, installation_ids: [9], professionals: { mode: 'any', ids: [DOCTOR] },
    staff_attention: [initial], preparation_sharing: { mode: 'same_start' } }] });
  const solution = solveBookingProfile({ profile: p, start: at(-5), doctors: new Map([[DOCTOR, resource()]]),
    installations: new Map([[9, resource()]]) });
  assert(solution);
  const evidence = { appointment: { id_cita: SOURCE, clinica_id: CLINIC, source_system: 'cliniccloud', inicio: at(-5), fin: at(25),
    booking_attention_snapshot: { version: 1, profile: p, phases: solution.phases,
      capacity_fully_verified: true, attention_requirements_pending: [] } },
    occupancies: occupancyForSolution(solution).map(row => ({ ...row, appointment_id: SOURCE })) };
  const v4 = origin(evidence); assert.equal(v4.verified, true); assert.notEqual(v4.legacy_partial_verified, true);
  f.doctors.get(DOCTOR).attention_visits = [v4];
  assert.equal(confirmed(f), null, 'A valid v4 different-start contract retains its sharing restriction');
  evidence.appointment.booking_attention_snapshot.capacity_fully_verified = false;
  const invalid = origin(evidence);
  assert.equal(invalid.verified, false); assert.notEqual(invalid.legacy_partial_verified, true);
  f.doctors.get(DOCTOR).attention_visits = [invalid];
  assert.equal(confirmed(f), null, 'Corrupt v4 evidence is not reclassified as old evidence');
});

test('actual attention, manual blocks, absences, physical rooms and equipment remain hard', () => {
  const cases = [
    f => { f.doctors.get(DOCTOR).busy.push({ start: at(5), end: at(15), appointment_id: 99, can_share: true }); },
    f => { f.doctors.get(DOCTOR).busy.push({ start: at(5), end: at(15) }); },
    f => { f.doctors.get(DOCTOR).absence_windows.push({ start: at(5), end: at(15) }); },
    f => { f.installations.get(10).busy.push({ start: at(0), end: at(30), appointment_id: 99, can_share: true }); },
    f => { f.installations.get(10).busy.push({ start: at(0), end: at(30) }); },
    f => { f.installations.get(9).resource_key = 'installation:10'; f.installations.get(9).busy.push({ start: at(0), end: at(30) }); },
    f => { f.equipment.get(2).busy.push({ start: at(0), end: at(30), appointment_id: 99, can_share: true }); },
    f => { f.equipment.get(2).status = 'maintenance'; },
  ];
  for (const mutate of cases) { const f = fixture(); mutate(f); assert.equal(confirmed(f), null, mutate.toString()); }
});

test('source gate exception does not cover an unselected second phase of the same doctor', () => {
  const f = fixture();
  f.profile = normalizeBookingProfile({ version: 4, phases: [...f.profile.phases, {
    key: 'unselected', start_offset_minutes: 15, duration_minutes: 15,
    installation_ids: [9], professionals: { mode: 'any', ids: [DOCTOR] } }] });
  assert.equal(confirmed(f), null);
});

test('grid/search and guided placement expose the same confirmable plan without adding support-staff authority', () => {
  const f = fixture(), context = { ...f, timeZone: 'UTC', patientBusy: [] };
  const options = { profile: f.profile, context, date: '2030-01-07', stepMinutes: 5, limit: 1,
    selections: f.selections, exactStartLocal: '2030-01-07T09:00', now: new Date('2029-12-01T00:00:00Z') };
  assert.deepEqual(solutionsForCalendar(options), []);
  const slots = solutionsForCalendar({ ...options, allowConfirmedOverlap: true });
  assert.equal(slots.length, 1); assert.equal(slots[0].requires_overlap_acknowledgement, true);
  assert.equal(slots[0].booking_plan_sha256, bookingPlanHash(f.profile, confirmed(f)));
  const guided = guidedTreatmentOptions({ profile: f.profile, context, date: options.date,
    startLocal: options.exactStartLocal, selections: f.selections, now: options.now });
  assert.equal(guided.slots.length, 1);
  assert.equal(guided.slots[0].booking_plan_sha256, slots[0].booking_plan_sha256);
  context.doctors.set(222, resource());
  assert.deepEqual(solutionsForCalendar({ ...options, allowConfirmedOverlap: true, additionalStaffIds: [222] }), [],
    'The legacy exception cannot be offered as permission for a supporting team');
});

test('receipt pins affected historical appointment identities and explicit confirmation', () => {
  const f = fixture(), solution = confirmed(f); assert(solution);
  const hash = bookingPlanHash(f.profile, solution);
  assert.doesNotThrow(() => assertBookingPlanReceipt(hash, f.profile, solution));
  const changed = structuredClone(solution);
  changed.warnings.find(row => row.reasons?.includes('legacy_attention_origin')).appointment_ids = [SOURCE + 1];
  assert.notEqual(bookingPlanHash(f.profile, changed), hash);
  assert.throws(() => assertBookingPlanReceipt(hash, f.profile, changed), { code: 'booking_plan_changed' });
  const notAcknowledged = { ...solution, requires_overlap_acknowledgement: false };
  assert.notEqual(bookingPlanHash(f.profile, notAcknowledged), hash);
  const evidence = sourceEvidence(); evidence.appointment.id_cita = SOURCE + 1;
  evidence.occupancies.forEach(row => { row.appointment_id = SOURCE + 1; });
  const other = fixture(evidence), next = confirmed(other); assert(next);
  assert.notEqual(bookingPlanHash(other.profile, next), hash, 'A changed actual origin also changes the preview receipt');
});
