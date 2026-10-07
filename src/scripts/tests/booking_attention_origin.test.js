'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const { normalizeBookingProfile } = require('../../lib/booking-profile');
const { solveBookingProfile, occupancyForSolution } = require('../../lib/booking-profile-solver');
const { attentionVisitOrigin, attentionVisitConflict } = require('../../lib/booking-attention-origin');
const { addVirtualBusy } = require('../../services/patientProgramBooking.service');
const start = '2030-01-07T09:00:00.000Z', end = '2030-01-07T09:30:00.000Z';
const initial = { mode: 'start_only', start_minutes: 5, start_window_minutes: 15 };
const profile = () => normalizeBookingProfile({ version: 4, phases: [{ key: 'initial', start_offset_minutes: 0, duration_minutes: 30,
  installation_ids: [9], professionals: { mode: 'any', ids: [5] }, staff_attention: [initial], preparation_sharing: { mode: 'same_start' } }] });
const free = () => ({ clinic_id: 72, windows: [{ start: '2030-01-07T08:00:00Z', end: '2030-01-07T20:00:00Z' }], busy: [], attention_visits: [] });
const context = () => ({ doctors: new Map([[5, free()]]), installations: new Map([[9, free()], [10, free()]]),
  installationKeys: new Map([[9, 'installation:9'], [10, 'installation:10']]), patientBusy: [] });
function evidence() {
  const p = profile(), solution = solveBookingProfile({ profile: p, start, ...context() });
  return { profile: p, solution, appointment: { id_cita: 42, clinica_id: 72, inicio: start, fin: end,
    booking_attention_snapshot: { version: 1, profile: p, phases: solution.phases,
      capacity_fully_verified: true, attention_requirements_pending: [] } },
    occupancies: occupancyForSolution(solution).map(row => ({ ...row, appointment_id: 42 })) };
}

test('attention origin verifies stored geometry, exact staff rows and opt-in without retaining names or notes', () => {
  const f = evidence();
  f.appointment.booking_attention_snapshot.phases[0].doctor_names = ['Private professional label'];
  f.appointment.booking_attention_snapshot.phases[0].label = 'Clinical label';
  f.appointment.patient_name = 'Never copied'; f.appointment.nota = 'Never copied';
  const before = structuredClone(f);
  const origin = attentionVisitOrigin({ ...f, doctorId: 5 });
  assert.equal(origin.verified, true); assert.equal(origin.partial, true);
  assert.deepEqual(origin.phases[0].preparation_sharing, { mode: 'same_start' });
  assert.equal(origin.phases[0].start_window_minutes, 15);
  const rendered = JSON.stringify(origin);
  for (const secret of ['Private professional label', 'Clinical label', 'Never copied', 'patient_name', 'nota']) assert(!rendered.includes(secret));
  assert.deepEqual(f, before);
});
test('JSON column strings and ORM attributes are supported without accepting absent source evidence', () => {
  const f = evidence(), attributes = { ...f.appointment, booking_attention_snapshot: JSON.stringify(f.appointment.booking_attention_snapshot) };
  const origin = attentionVisitOrigin({ appointment: { get: key => attributes[key] }, doctorId: 5, occupancies: f.occupancies });
  assert.equal(origin.verified, true);
  const absent = attentionVisitOrigin({ appointment: { ...f.appointment, booking_attention_snapshot: null }, doctorId: 5, occupancies: f.occupancies });
  assert.equal(absent.verified, false); assert.equal(absent.partial, true); assert.deepEqual(absent.phases, []);
});
test('invalid capacity, pending care, changed intervals or incomplete canonical rows cannot verify an origin', () => {
  for (const corrupt of [f => { delete f.appointment.booking_attention_snapshot.capacity_fully_verified; },
    f => { f.appointment.booking_attention_snapshot.capacity_fully_verified = 'true'; },
    f => { f.appointment.booking_attention_snapshot.attention_requirements_pending = [{ key: 'unknown', label: 'Unknown time' }]; },
    f => { f.appointment.booking_attention_snapshot.phases[0].start_offset_minutes = 5; },
    f => { delete f.appointment.booking_attention_snapshot.phases[0].preparation_sharing; },
    f => { f.occupancies.find(row => row.doctor_id).end_at = end; },
    f => { f.occupancies = f.occupancies.filter(row => !row.doctor_id); },
    f => { f.appointment.clinica_id = null; },
    f => { f.appointment.booking_attention_snapshot = '{malformed'; }]) {
    const f = evidence(); corrupt(f);
    assert.equal(attentionVisitOrigin({ ...f, doctorId: 5 }).verified, false);
  }
});
test('virtual previews preserve verified visit origins, so a later preparation cannot silently reuse a partial gap', () => {
  const f = evidence(), c = context();
  addVirtualBusy(c, f.solution, [], f.profile);
  assert.equal(c.doctors.get(5).attention_visits[0].verified, true);
  const target = profile(); target.phases[0].installation_ids = [10];
  const result = solveBookingProfile({ profile: target, start, ...c });
  assert(result); assert.equal(result.phases[0].staff_intervals[0].start_at, '2030-01-07T09:05:00.000Z');
  assert.equal(solveBookingProfile({ profile: target, start: '2030-01-07T09:10:00Z', ...c }), null);
  const reason = attentionVisitConflict(c.doctors.get(5), { phase: target.phases[0], visitStart: '2030-01-07T09:10:00Z',
    start: '2030-01-07T09:10:00Z', end: '2030-01-07T09:40:00Z', policies: [initial] });
  assert.deepEqual(Object.keys(reason).sort(), ['code', 'message']);
  assert.equal(reason.code, 'preparation_start_mismatch');
  assert(!JSON.stringify(reason).includes('-1')); assert(!JSON.stringify(reason).includes('42'));
});
