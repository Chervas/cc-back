'use strict';

// Synthetic appointments and resources only. No DB, runtime flags or providers.
const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBookingProfile } = require('../../lib/booking-profile');
const { solveBookingProfile, occupancyForSolution } = require('../../lib/booking-profile-solver');
const { planStaffAttentionSteps } = require('../../lib/booking-attention');

const BASE = Date.parse('2030-01-07T09:00:00Z');
const at = minutes => new Date(BASE + minutes * 60000).toISOString();
const setup = { mode: 'start_only', start_minutes: 5, start_window_minutes: 15 };
const attended = { mode: 'start_continuous', start_minutes: 5, start_window_minutes: 15 };
const resource = patch => ({ windows: [{ start: at(0), end: at(180) }], busy: [], clinic_id: 72,
  attention_visits: [], schedule_verified: true, absence_windows: [], ...patch });
const phase = (key, offset = 0, doctor = 5, room = 9, patch = {}) => ({ key, duration_minutes: 15,
  start_offset_minutes: offset, installation_ids: [room], professionals: { mode: 'any', ids: [doctor], preferred_id: doctor }, ...patch });
const profile = (...phases) => normalizeBookingProfile({ version: 4, phases });
function fixture(p = profile(phase('flex'), phase('strict', 15, 6, 10))) {
  const doctors = new Map([[5, resource({ agenda_flexible: true, windows: [{ start: at(15), end: at(180) }] })],
    [6, resource()], [7, resource()]]);
  const installations = new Map([[9, resource({ resource_key: 'installation:9', windows: [{ start: at(15), end: at(180) }], profesionales_permitidos: [6] })],
    [10, resource({ resource_key: 'installation:10' })], [11, resource({ resource_key: 'installation:11' })]]);
  const equipment = new Map([[1, { id: 1, name: 'Unidad ficticia', status: 'available', turnaround_minutes: 0,
    installation_ids: new Set([9, 10, 11]), busy: [], attention_policy: { mode: 'continuous', patient_preparation_minutes: 0 } }]]);
  return { profile: p, start: at(0), doctors, installations, equipment,
    clinicWindows: [{ start: at(15), end: at(180) }], selections: { flex: { doctor_id: 5, installation_id: 9 } } };
}
const force = f => solveBookingProfile({ ...f, allowOverlap: true });

test('mixed flexible and strict phases use actual offsets/span with complete joint verification and an explicit receipt', () => {
  const f = fixture(profile(phase('flex', 0, 5, 9, { duration_minutes: 30 }), phase('strict', 15, 6, 10, { duration_minutes: 30 })));
  const before = structuredClone(f);
  assert.equal(solveBookingProfile(f), null);
  const solution = force(f);
  assert(solution); assert.equal(solution.end_at, at(45)); assert.equal(solution.capacity_fully_verified, true);
  assert.equal(solution.requires_overlap_acknowledgement, true);
  assert.deepEqual(solution.phases.map(row => [row.start_at, row.end_at]), [[at(0), at(30)], [at(15), at(45)]]);
  const warning = solution.warnings.find(row => row.code === 'FLEXIBLE_AGENDA');
  assert.equal(warning.phase_key, 'flex');
  assert.deepEqual(warning.reasons, ['clinic_schedule', 'installation_schedule', 'room_staff_incompatible', 'staff_schedule']);
  assert.deepEqual(occupancyForSolution(solution).filter(row => row.resource_kind === 'doctor').map(row => [row.doctor_id, row.start_at, row.end_at]),
    [[5, at(0), at(30)], [6, at(15), at(45)]]);
  assert.deepEqual(f, before, 'Raw schedule, absence, busy and room policies are not rewritten');
});

test('a flexible clinician is scoped to the explicitly selected phase, even when the same person owns another phase', () => {
  const f = fixture(profile(phase('flex'), phase('strict', 15, 5, 10)));
  assert(force(f));
  f.profile.phases[1].start_offset_minutes = 10;
  assert.equal(force(f), null, 'First-phase exception cannot extend the unselected second-phase working window');
  f.profile.phases[1].start_offset_minutes = 15;
  f.doctors.get(5).busy.push({ start: at(20), end: at(25), appointment_id: 901 });
  assert.equal(force(f), null, 'An existing busy interval is not deleted by appointment ID');
  f.doctors.get(5).busy = []; f.selections = {};
  assert.equal(force(f), null, 'A single eligible clinician is still not an explicit exception selection');
  f.selections.flex = { doctor_id: 6 };
  assert.equal(force(f), null, 'The requested clinician must actually be eligible');
});

test('step-local windows constrain every preparation/continuous task inside one clinician joint timeline', () => {
  const f = fixture(profile(phase('flex', 0, 5, 9, { staff_attention: [setup] }), phase('strict', 15, 5, 10, { duration_minutes: 30 })));
  const solution = force(f);
  assert(solution);
  assert.deepEqual(solution.phases[0].staff_intervals, [{ start_at: at(0), end_at: at(5), kind: 'start' }]);
  assert.deepEqual(solution.phases[1].staff_intervals, [{ start_at: at(15), end_at: at(45), kind: 'continuous' }]);
  f.profile.phases[1].start_offset_minutes = 0; f.profile.phases[1].staff_attention = [setup];
  assert.equal(force(f), null, 'The strict preparation cannot borrow the flexible preparation window');
  const original = resource({ windows: [{ start: at(15), end: at(30) }] });
  assert.equal(planStaffAttentionSteps({ resource: original, steps: [
    { key: 'flex', start: at(0), end: at(15), policies: [setup], resource: resource() },
    { key: 'strict', start: at(0), end: at(15), policies: [setup], resource: original },
  ] }), null);
});

test('continuous application cannot overlap an internal act just because the assigned doctor is flexible', () => {
  const f = fixture(profile(phase('flex', 0, 5, 9, { duration_minutes: 30, staff_attention: [attended] }),
    phase('strict', 15, 5, 10, { duration_minutes: 15 })));
  assert.equal(force(f), null, 'INDIBA continuous interval remains occupied after preparation');
  f.profile.phases[1].start_offset_minutes = 30;
  const solution = force(f);
  assert(solution); assert.equal(solution.phases[0].staff_intervals.at(-1).end_at, at(30));
});

test('clinic-hour exception cannot cover a non-flexible step or an uncovered gap in the visit envelope', () => {
  const f = fixture(); f.profile.phases[1].start_offset_minutes = 10;
  assert.equal(force(f), null, 'A simultaneous strict step at a closed time stays forbidden');
  f.profile.phases[1].start_offset_minutes = 30;
  f.clinicWindows = [{ start: at(30), end: at(180) }];
  assert.equal(force(f), null, 'No phase explicitly covers closed 15–30 between the two steps');
  f.clinicWindows = [{ start: at(15), end: at(180) }];
  assert(force(f));
});

test('physical room aliases, ordinary/manual/foreign busy intervals and maintenance remain hard where unshareable', () => {
  for (const interval of [{ start: at(0), end: at(15) }, { start: at(0), end: at(15), appointment_id: 901 },
    { start: at(0), end: at(15), appointment_id: 901, can_share: false, diagnostic: { kind: 'other_clinic' } }]) {
    for (const kind of ['doctors', 'installations']) {
      const f = fixture(); f[kind].get(kind === 'doctors' ? 5 : 9).busy.push(interval);
      assert.equal(force(f), null);
    }
  }
  const f = fixture(); f.installations.get(11).resource_key = 'installation:9';
  f.installations.get(11).busy.push({ start: at(0), end: at(15), appointment_id: 902 });
  assert.equal(force(f), null, 'Another visible column of the same physical room is not additional capacity');
  f.installations.get(11).busy = []; f.installations.get(9).profesionales_permitidos = ['bad'];
  assert.equal(force(f), null, 'Malformed eligibility is not repaired into an exception');
});

test('every physical equipment occupancy, overlapping use, fixed-room policy and turnaround remain protected', () => {
  const p = profile(phase('flex', 0, 5, 9, { staff_attention: [setup], equipment_requirements: [{ equipment_ids: [1] }] }),
    phase('strict', 15, 6, 10, { equipment_requirements: [{ equipment_ids: [1] }] }));
  const f = fixture(p); assert(force(f));
  f.equipment.get(1).busy.push({ start: at(0), end: at(15), appointment_id: 903, can_share: true });
  assert.equal(force(f), null, 'Even an ordinary confirmation cannot double a unit');
  f.equipment.get(1).busy = []; f.profile.phases[1].start_offset_minutes = 10;
  assert.equal(force(f), null);
  f.profile.phases[1].start_offset_minutes = 15; f.equipment.get(1).turnaround_minutes = 10;
  assert.equal(force(f), null);
  f.profile.phases[1].start_offset_minutes = 25; assert(force(f));
  f.equipment.get(1).installation_ids = new Set([9]); assert.equal(force(f), null);
  f.equipment.get(1).installation_ids = new Set([9, 10]); f.equipment.get(1).status = 'maintenance';
  assert.equal(force(f), null);
});

test('absence evidence is not replaced by extended windows, and absence-only substitutions keep original proof', () => {
  const f = fixture();
  f.doctors.get(5).absence_windows.push({ start: at(0), end: at(15) });
  assert.equal(force(f), null, 'Explicit vacation cannot be bypassed even if absent from the generic busy array');
  f.doctors.get(5).absence_windows = [];
  const staff = { mode: 'any', ids: [5, 6], preferred_id: 5, fallback_when: 'absence_only' };
  f.profile.phases[0].professionals = staff; f.selections.flex.doctor_id = 6;
  Object.assign(f.doctors.get(6), { agenda_flexible: true, windows: [{ start: at(15), end: at(180) }] });
  f.profile.phases[1].professionals = { mode: 'any', ids: [7], preferred_id: 7 };
  assert(force(f), 'Configured absence of primary remains visible even while the selected alternative has a scoped exception');
  f.doctors.get(5).windows = [{ start: at(0), end: at(180) }];
  f.doctors.get(5).busy.push({ start: at(0), end: at(15), appointment_id: 904 });
  assert.equal(force(f), null, 'Busy primary is not clinical absence');
  f.profile.phases[0].professionals.fallback_when = 'unavailable'; assert(force(f));
});

test('same-start source origin, pending checks and ALL team constraints survive a flexible phase', () => {
  const p = profile(phase('flex', 0, 5, 9, { staff_attention: [setup], preparation_sharing: { mode: 'same_start' } }), phase('strict', 15, 6, 10));
  const f = fixture(p);
  f.doctors.get(5).attention_visits.push({ appointment_id: 905, clinic_id: 72, start: at(-5), end: at(25), version: 4, verified: true, partial: true,
    phases: [{ key: 'origin', start: at(-5), end: at(25), partial: true, preparation_sharing: { mode: 'same_start' }, start_window_minutes: 15 }] });
  assert.equal(force(f), null);
  f.doctors.get(5).attention_visits[0].verified = false; assert.equal(force(f), null);
  f.doctors.get(5).attention_visits = [];
  f.profile.phases[0].attention_requirements_pending = [{ key: 'check', label: 'Duración pendiente' }];
  assert.throws(() => force(f), { code: 'pending_attention_requirements' });
  delete f.profile.phases[0].attention_requirements_pending;
  f.profile.phases[1].professionals = { mode: 'all', ids: [6, 7], preferred_id: null };
  f.doctors.get(7).busy.push({ start: at(15), end: at(30), appointment_id: 906 });
  assert.equal(force(f), null);
  f.doctors.get(7).busy = []; assert(force(f), 'A mixed required team is possible when its own original constraints fit');
  f.doctors.get(7).windows = []; f.doctors.get(7).agenda_flexible = true;
  f.selections.strict = { doctor_id: 7 }; assert.equal(force(f), null, 'ALL cannot become ANY through a flexible selection');
});
