'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { assessment, restrictionReadProfile, restrictionResourceConflicts } = require('../../lib/booking-restriction-confirmation');
const { solveBookingProfile, occupancyForSolution } = require('../../lib/booking-profile-solver');
const { bookingError, bookingErrorPayload } = require('../../services/treatmentBookingProfile.service');
const start = '2030-01-07T18:30:00.000Z', end = '2030-01-07T19:15:00.000Z';
const windows = [{ start: '2030-01-07T08:00:00.000Z', end: '2030-01-07T19:00:00.000Z' }];
const resource = name => ({ name, windows, busy: [] });
function fixture() {
  return { profile: { version: 1, phases: [{ key: 'valuation', label: 'Valoración', duration_minutes: 45,
    installation_ids: [3], professionals: { mode: 'any', ids: [5], preferred_id: 5 } }] },
    start, selections: { valuation: { doctor_id: 6, installation_id: 7 } }, actorId: 8, clinicId: 72,
    treatmentId: 3, treatmentName: 'Consulta de valoración capilar', patientId: 2,
    context: { timeZone: 'Europe/Madrid', clinicWindows: windows, patientBusy: [],
      doctors: new Map([[5, resource('Doctor Loza')], [6, resource('Celia')]]),
      installations: new Map([[3, resource('C3')], [7, resource('C7')]]) } };
}
test('one explanatory receipt includes treatment assignment, room and exact fifteen-minute overruns together', () => {
  const f = fixture(); f.context.doctors.get(6).busy.push({ start, end, appointment_id: 4,
    diagnostic: { kind: 'appointment', treatment_name: 'Otro tratamiento', installation_name: 'C8' } });
  const result = assessment(f);
  assert.equal(result.canConfirm, true); assert.equal(result.confirmed, false);
  const assigned = result.restrictions.find(row => row.code === 'TREATMENT_PROFESSIONAL_NOT_ALLOWED');
  assert.equal(assigned.doctor.name, 'Celia'); assert.equal(assigned.assigned_doctors[0].name, 'Doctor Loza');
  const late = result.restrictions.find(row => row.code === 'STAFF_OUT_OF_HOURS');
  assert.equal(late.schedule_end, '2030-01-07T19:00:00.000Z'); assert.equal(late.overrun_minutes, 15);
  assert.match(late.message, /20:15.*15 minutos.*20:00/);
  assert(result.restrictions.some(row => row.code === 'STAFF_OVERLAP'));
  assert.equal(solveBookingProfile({ profile: f.profile, start, ...f.context, selections: f.selections }), null);
  const accepted = assessment({ ...f, acknowledgement: result.acknowledgement });
  assert.equal(accepted.confirmed, true); assert.equal(accepted.solution.phases[0].doctor_ids[0], 6);
  assert.equal(accepted.solution.phases[0].installation_id, 7);
});
test('changed appointments, timetables, patient overlap, actor or selection require fresh confirmation', () => {
  const original = assessment(fixture()).acknowledgement;
  for (const change of [
    f => f.context.doctors.get(6).busy.push({ start, end, appointment_id: 99 }),
    f => { f.context.doctors.get(6).windows = [{ start, end: '2030-01-07T18:45:00Z' }]; },
    f => f.context.patientBusy.push({ start, end, appointment_id: 88, clinic_id: 72 }),
    f => { f.actorId = 9; },
    f => { f.selections.valuation.installation_id = 3; },
  ]) {
    const f = fixture(); change(f); const result = assessment({ ...f, acknowledgement: original });
    assert.equal(result.confirmed, false); assert.notEqual(result.acknowledgement, original);
  }
});
test('SQL result ordering does not invalidate a receipt for unchanged evidence', () => {
  const f = fixture(); f.context.doctors.get(6).busy.push({ start, end, appointment_id: 7 }, { start, end, appointment_id: 8 });
  f.context.patientBusy.push({ start, end, appointment_id: 20, clinic_id: 72 }, { start, end, appointment_id: 21, clinic_id: 72 });
  const first = assessment(f).acknowledgement;
  f.context.doctors.get(6).busy.reverse(); f.context.patientBusy.reverse();
  assert.equal(assessment({ ...f, acknowledgement: first }).confirmed, true);
});
test('all external blocks, absences, machine overlaps and patient overlaps are warnings; inactive/missing resources are not', () => {
  const f = fixture(); f.profile.version = 4; f.profile.phases[0].start_offset_minutes = 0;
  f.profile.phases[0].equipment_requirements = [{ equipment_ids: [1] }];
  f.context.equipment = new Map([[1, { id: 1, name: 'Equipo', status: 'available', installation_ids: new Set([7]), turnaround_minutes: 5,
    attention_policy: { mode: 'continuous', patient_preparation_minutes: 0 }, busy: [{ start, end, appointment_id: 22 }] }]]);
  f.context.doctors.get(6).busy.push({ start, end }); f.context.doctors.get(6).absence_windows = [{ start, end }];
  f.context.patientBusy.push({ start, end, clinic_id: 73, appointment_id: 88 });
  const result = assessment(f); assert.equal(result.canConfirm, true);
  assert(result.restrictions.some(row => row.code === 'EQUIPMENT_OVERLAP'));
  assert(result.restrictions.some(row => row.code === 'PATIENT_OVERLAP'));
  assert(result.restrictions.some(row => row.code === 'STAFF_BLOCKED'));
  f.context.equipment.get(1).status = 'maintenance'; assert.equal(assessment(f).canConfirm, false);
  f.context.equipment.get(1).status = 'available'; f.context.equipment.get(1).installation_ids.clear(); assert.equal(assessment(f).canConfirm, false);
  f.context.doctors.delete(6); assert.equal(assessment(f).canConfirm, false);
});
test('combined visits preserve both phases, their relative overlap and every required ALL member', () => {
  const f = fixture(); f.profile.version = 4; f.profile.phases[0].start_offset_minutes = 0; f.profile.phases[0].duration_minutes = 30;
  f.profile.phases.push({ key: 'application', start_offset_minutes: 15, duration_minutes: 30, installation_ids: [3],
    professionals: { mode: 'all', ids: [5, 8], preferred_id: null } });
  f.context.doctors.set(8, resource('Apoyo')); f.selections.application = { installation_id: 3 };
  const result = assessment(f); assert.equal(result.canConfirm, true);
  assert.equal(result.solution.end_at, end);
  assert.deepEqual(result.solution.phases[1].doctor_ids, [5, 8]);
  const rows = occupancyForSolution(result.solution);
  assert.equal(rows.filter(row => row.resource_kind === 'doctor').length, 3);
  assert.equal(result.solution.phases[1].start_at, '2030-01-07T18:45:00.000Z');
  const bad = fixture(); bad.profile = f.profile; bad.context = f.context;
  bad.selections.application = { installation_id: 3, doctor_id: 5 };
  assert.throws(() => assessment(bad), { code: 'booking_restriction_selection_invalid' });
});
test('an exception cannot make two internally simultaneous acts by the same clinician feasible', () => {
  const f = fixture(); f.profile.version = 4; f.profile.phases[0].start_offset_minutes = 0;
  f.profile.phases.push({ ...f.profile.phases[0], key: 'second', start_offset_minutes: 15, installation_ids: [3] });
  f.selections.second = { doctor_id: 6, installation_id: 3 };
  assert.equal(assessment(f).canConfirm, false);
});
test('foreign reservations are explained without patient, appointment ID or foreign treatment data', () => {
  const f = fixture(); f.context.doctors.get(6).busy.push({ start, end, appointment_id: 12345,
    diagnostic: { kind: 'other_clinic', treatment_name: 'Private foreign procedure', patient_name: 'Private patient' } });
  const result = assessment(f), payload = JSON.stringify(result.restrictions);
  assert.doesNotMatch(payload, /12345|Private foreign|Private patient/);
  assert.match(payload, /otra clínica/);
  assert.equal(restrictionResourceConflicts(result).length, result.restrictions.length);
});
test('bulk read profile widens only the footprint, never authorizes bookings or mutates source', () => {
  const f = fixture(), original = structuredClone(f.profile);
  const read = restrictionReadProfile(f.profile, { selections: f.selections, doctorIds: [6], installationIds: [7] });
  assert.deepEqual(read.phases[0].professionals.ids, [5, 6]); assert.deepEqual(read.phases[0].installation_ids, [3, 7]);
  assert.deepEqual(f.profile, original);
  assert.throws(() => restrictionReadProfile(f.profile, { selections: { unknown: {} } }), { code: 'booking_restriction_selection_invalid' });
});
test('HTTP payload exposes a separate acknowledgement, never can_force', () => {
  const result = assessment(fixture());
  const payload = bookingErrorPayload(bookingError('booking_restriction_confirmation_required', 'Confirma', {
    can_confirm_restrictions: true, booking_restriction_acknowledgement: result.acknowledgement, booking_restrictions: result.restrictions,
  }));
  assert.equal(payload.can_force, false); assert.equal(payload.can_confirm_restrictions, true);
  assert.equal(payload.booking_restriction_acknowledgement, result.acknowledgement);
});
test('end-of-shift boundary and starts after the last real shift explain exact closing hour', () => {
  for (const value of ['2030-01-07T19:00:00Z', '2030-01-07T19:10:00Z']) {
    const f = fixture(); f.start = value;
    const item = assessment(f).restrictions.find(row => row.code === 'STAFF_OUT_OF_HOURS');
    assert.equal(item.schedule_end, '2030-01-07T19:00:00.000Z');
    assert.equal(item.overrun_minutes, value.includes('19:10') ? 55 : 45);
    assert.match(item.message, /Celia.*termina a las 20:00/);
  }
});
test('an incompatible support member does not falsely report the room is out of hours', () => {
  const f = fixture(); f.start = '2030-01-07T10:00:00Z'; f.additionalStaffIds = [5];
  const room = f.context.installations.get(7); room.profesionales_permitidos = [6];
  room.schedule_windows = windows; room.windows = [];
  const result = assessment(f);
  assert(result.restrictions.some(row => row.code === 'INSTALLATION_PROFESSIONAL_NOT_ALLOWED'));
  assert(!result.restrictions.some(row => row.code === 'INSTALLATION_OUT_OF_HOURS'));
});
test('only verified continuous attention is explained as requiring the whole professional attention', () => {
  for (const continuous of [false, true]) {
    const f = fixture(); f.context.doctors.get(6).busy.push({ start, end, appointment_id: 99,
      diagnostic: { kind: 'appointment', treatment_name: 'INDIBA', installation_name: 'C12', continuous_attention: continuous } });
    const item = assessment(f).restrictions.find(row => row.code === 'STAFF_OVERLAP');
    assert.match(item.message, /Celia.*INDIBA.*C12/);
    assert.equal(item.message.includes('requiere toda su atención'), continuous);
  }
});
test('unrestricted complete members still seal evidence for an atomic linked movement', () => {
  const f = fixture(); f.start = '2030-01-07T10:00:00Z'; f.selections = { valuation: { doctor_id: 5, installation_id: 3 } };
  const first = assessment(f); assert.equal(first.canConfirm, false); assert.match(first.acknowledgement, /^[a-f0-9]{64}$/);
  f.previous = { inicio: start, fin: end, estado: 'info_confirmada', updated_at: '2030-01-06T10:00:00Z' };
  assert.notEqual(assessment(f).acknowledgement, first.acknowledgement);
});
test('an empty optional support list never invalidates a strict plan in a room with permitted staff', () => {
  const f = fixture(); f.start = '2030-01-07T10:00:00Z'; f.selections = { valuation: { doctor_id: 5, installation_id: 3 } };
  f.profile.phases[0].professionals.ids = [5, 6]; f.profile.phases[0].installation_ids = [3, 7];
  f.context.installations.get(3).profesionales_permitidos = [5, 6];
  const canonicalSolution = solveBookingProfile({ profile: f.profile, start: f.start, ...f.context, selections: f.selections });
  const result = assessment({ ...f, canonicalSolution });
  assert.equal(result.restrictions.length, 0); assert.deepEqual(result.effectiveProfile.phases[0].professionals.ids, [5, 6]);
});
test('linked assessment preserves actual strict preparation instead of inventing a conflict at its earlier relaxed start', () => {
  const f = fixture(); f.start = '2030-01-07T10:00:00Z'; f.selections = { valuation: { doctor_id: 5, installation_id: 3 } };
  f.profile.version = 4; f.profile.phases[0].start_offset_minutes = 0;
  f.profile.phases[0].staff_attention = [{ mode: 'start_only', start_minutes: 5, start_window_minutes: 15 }];
  f.context.doctors.get(5).busy.push({ start: f.start, end: '2030-01-07T10:05:00Z' });
  const canonicalSolution = solveBookingProfile({ profile: f.profile, start: f.start, ...f.context, selections: f.selections });
  assert(canonicalSolution);
  const result = assessment({ ...f, canonicalSolution });
  assert.equal(result.restrictions.length, 0); assert.equal(result.canConfirm, false);
  assert.equal(result.solution.phases[0].staff_intervals[0].start_at, '2030-01-07T10:05:00.000Z');
  assert.deepEqual(result.effectiveProfile.phases[0].professionals.ids, [5]);
});
test('strict primary availability cannot preserve an unconfirmed original plan when full-visit support is busy', () => {
  const f = fixture(); f.start = '2030-01-07T10:00:00Z';
  f.profile.phases[0].professionals.ids = [5, 6]; f.profile.phases[0].installation_ids = [3, 7];
  f.selections = { valuation: { doctor_id: 5, installation_id: 3 } }; f.additionalStaffIds = [6];
  f.context.doctors.get(6).busy.push({ start: f.start, end: '2030-01-07T10:45:00Z', appointment_id: 99 });
  const canonicalSolution = solveBookingProfile({ profile: f.profile, start: f.start, ...f.context, selections: f.selections });
  assert(canonicalSolution);
  const result = assessment({ ...f, canonicalSolution });
  assert.equal(result.canConfirm, true); assert(result.restrictions.some(row => row.resource_role === 'additional_staff'));
  assert.deepEqual(result.effectiveProfile.phases[0].professionals.ids, [5]);
  assert.deepEqual(result.effectiveProfile.phases[0].installation_ids, [3]);
});

test('legacy diagnostics without an appointment ID still identify appointments and preserve known clinical attention windows', () => {
  const f = fixture(); f.start = '2030-01-07T10:00:00Z';
  f.selections = { valuation: { doctor_id: 5, installation_id: 3 } };
  f.profile.version = 4; f.profile.phases[0].start_offset_minutes = 0;
  f.profile.phases[0].staff_attention = [{ mode: 'start_end', start_minutes: 5, start_window_minutes: 10,
    end_minutes: 5, end_window_minutes: 10 }];
  f.context.doctors.get(5).busy = [{ start: f.start, end: '2030-01-07T10:45:00Z',
    diagnostic: { kind: 'appointment', treatment_name: 'Reserva documentada', full_interval: true } }];
  const result = assessment(f), reason = result.restrictions.find(row => row.code === 'STAFF_OVERLAP');
  assert.equal(result.canConfirm, true);
  assert.match(reason.message, /Reserva documentada/);
  assert.match(reason.message, /5 min de puesta en marcha.*primeros 10 min.*5 min de retirada.*últimos 10 min/);
  assert.doesNotMatch(reason.message, /un bloqueo de agenda|requiere toda su atención/);
});
