'use strict';

// Entirely synthetic, offline fixtures: no patients, database or providers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const { composeAppointmentProfile, materializeSession } = require('../../lib/program-booking');
const { snapshot, operationalSnapshot, programPlans } = require('../../lib/economicProgramSnapshot');
const { compatibleLinkedAppointment, programBookingSelections } = require('../../lib/program-appointment-link');
const { treatmentDto } = require('../../lib/treatmentPrograms.contract');
const { solveBookingProfile } = require('../../lib/booking-profile-solver');
const { normalizeBookingProfile } = require('../../lib/booking-profile');
const { addVirtualBusy } = require('../../services/patientProgramBooking.service');
const clone = value => structuredClone(value);
const start = '2030-01-07T09:00:00.000Z';
const phase = (key, doctor, room, offset, duration = 30) => ({ key, duration_minutes: duration,
  start_offset_minutes: offset, installation_ids: [room], professionals: { mode: 'any', ids: [doctor] } });
const relative = () => ({ version: 4, phases: [phase('draw', 5, 9, 0), phase('apply', 6, 10, 15)] });
const legacy = (mode = 'any') => ({ version: 1, phases: [{ key: 'care', duration_minutes: 20,
  installation_ids: [11], professionals: { mode, ids: mode === 'all' ? [7, 8] : [7] } }] });
const treatment = (id, profile) => ({ id, name: `Técnica sintética ${id}`, booking_profile: profile });
const compose = profiles => composeAppointmentProfile({ treatments: profiles.map((profile, index) => treatment(20 + index, profile)) });
const free = () => ({ windows: [{ start, end: '2030-01-07T20:00:00Z' }], busy: [] });
const context = () => ({ doctors: new Map([[5, free()], [6, free()], [7, free()]]),
  installations: new Map([[9, free()], [10, free()], [11, free()]]),
  installationKeys: new Map([[9, 'installation:9'], [10, 'installation:10'], [11, 'installation:11']]), equipment: new Map() });

test('virtual v4 preparation preserves same-start capacity but cannot free a later legacy or flexible destination', () => {
  const p = normalizeBookingProfile({ version: 4, phases: [{ ...phase('setup', 5, 9, 0), installation_ids: [9, 10, 11],
    staff_attention: [{ mode: 'start_only', start_minutes: 5, start_window_minutes: 15 }], preparation_sharing: { mode: 'same_start' } }] });
  for (const corrupt of [() => {}, solution => { solution.capacity_fully_verified = false; }]) {
    const ctx = context(); ctx.patientBusy = []; ctx.doctors.get(5).clinic_id = 72;
    const solution = solveBookingProfile({ profile: p, start, ...ctx }); corrupt(solution);
    addVirtualBusy(ctx, solution, [], p);
    assert.equal(ctx.doctors.get(5).attention_visits[0].protected_attention_origin, true);
    assert(ctx.doctors.get(5).busy.every(row => row.protected_attention_origin === true));
    if (solution.capacity_fully_verified) {
      const next = solveBookingProfile({ profile: p, start, ...ctx, selections: { setup: { installation_id: 10 } } });
      assert(next); assert.equal(next.phases[0].staff_intervals[0].start_at, '2030-01-07T09:05:00.000Z');
    }
    const old = { version: 1, phases: [{ key: 'old', duration_minutes: 20, installation_ids: [10],
      professionals: { mode: 'any', ids: [5], preferred_id: 5 } }] };
    const options = { profile: old, start: '2030-01-07T09:10:00.000Z', ...ctx, selections: { old: { doctor_id: 5, installation_id: 10 } } };
    assert.equal(solveBookingProfile(options), null);
    ctx.doctors.get(5).agenda_flexible = true;
    assert.equal(solveBookingProfile({ ...options, allowOverlap: true }), null);
  }
});

test('composition retains v4 offsets and span, and translates following techniques by span rather than sum', () => {
  const original = relative(), before = clone(original);
  const single = compose([original]);
  assert.equal(single.profile.version, 4); assert.equal(single.duration_minutes, 45);
  assert.deepEqual(single.profile.phases.map(p => p.start_offset_minutes), [0, 15]);
  const following = compose([original, legacy()]);
  assert.equal(following.duration_minutes, 65);
  assert.deepEqual(following.profile.phases.map(p => p.start_offset_minutes), [0, 15, 45]);
  const preceding = compose([legacy(), original]);
  assert.deepEqual(preceding.profile.phases.map(p => p.start_offset_minutes), [0, 20, 35]);
  assert.equal(preceding.duration_minutes, 65);
  assert.deepEqual(original, before);
  assert.deepEqual(following.phase_treatments.map(p => p.treatment_id), [20, 20, 21]);
});
test('mixed composition never silently changes an old whole-visit team into a phase-only team', () => {
  assert.throws(() => compose([relative(), legacy('all')]), { code: 'program_profile_v4_legacy_team_unsupported' });
  const team = compose([legacy('all'), legacy()]);
  assert.equal(team.profile.version, 1); assert.equal(team.duration_minutes, 40);
  assert.equal(team.profile.phases[0].professionals.mode, 'all');
  assert.equal(Object.hasOwn(team.profile.phases[0], 'start_offset_minutes'), false);
});
test('unknown duration before another relative component blocks rather than inventing a next technique start', () => {
  const source = relative(); source.phases[0].duration_minutes = null;
  assert.throws(() => composeAppointmentProfile({ treatments: [treatment(20, source), treatment(21, legacy())] },
    { allowMissingDuration: true }), { code: 'program_profile_v4_duration_required' });
});
test('v4 chosen total cannot fabricate an interior act duration; explicit phase durations preserve offsets', () => {
  const source = relative(); source.phases[0].duration_minutes = null;
  const composed = composeAppointmentProfile({ treatments: [treatment(20, source)] }, { allowMissingDuration: true });
  const session = { key: 's0', booking_profile: composed.profile, duration_minutes: null, treatment_ids: [20] };
  assert.equal(composed.duration_minutes, null);
  assert.throws(() => materializeSession(session, { duration_minutes: 45 }), { code: 'program_duration_required' });
  const chosen = materializeSession(session, { phase_durations: { t1_p1: 20 } });
  assert.equal(chosen.duration_minutes, 45);
  assert.deepEqual(chosen.booking_profile.phases.map(p => p.duration_minutes), [20, 30]);
  assert.deepEqual(chosen.booking_profile.phases.map(p => p.start_offset_minutes), [0, 15]);
  assert.throws(() => materializeSession(session, { duration_minutes: 50, phase_durations: { t1_p1: 20 } }), { code: 'program_duration_locked' });
  const endpoint = materializeSession(session, { duration_minutes: 60 });
  assert.equal(endpoint.booking_profile.phases[0].duration_minutes, 60);
  assert.equal(endpoint.duration_minutes, 60);
  const finalUnknown = relative(); finalUnknown.phases[1].duration_minutes = null;
  const finalTemplate = composeAppointmentProfile({ treatments: [treatment(20, finalUnknown)] }, { allowMissingDuration: true });
  assert.equal(materializeSession({ ...session, booking_profile: finalTemplate.profile }, { duration_minutes: 45 }).booking_profile.phases[1].duration_minutes, 30);
});
test('a five-unit voucher freezes five visits, not ten phases, and retains v4 geometry under catalog edits', () => {
  const source = relative();
  const program = { id: 'synthetic-voucher', version: 1, kind: 'voucher', status: 'active', name: 'Bono sintético', total_price: 225,
    summary: { issues: [] }, appointments: Array.from({ length: 5 }, (_, index) => ({ key: `s${index}`, label: `Sesión ${index + 1}`,
      offset_days: null, treatment_ids: [20], duration_minutes: 45,
      treatments: [{ ...treatment(20, source), duration_minutes: 45 }] })) };
  const frozen = snapshot(program), evidence = clone(frozen);
  source.phases[0].duration_minutes = 50;
  const purchase = operationalSnapshot(frozen);
  assert.equal(purchase.appointments.length, 5); assert.equal(purchase.catalog_total_price, 225);
  assert(purchase.appointments.every(s => s.duration_minutes === 45 && s.booking_profile.version === 4));
  assert(purchase.appointments.every(s => s.booking_profile.phases.length === 2));
  assert.deepEqual(frozen, evidence);
  const corrupt = clone(frozen); corrupt.appointments[0].treatments[0].booking_profile.phases[1].start_offset_minutes = 20;
  assert.throws(() => operationalSnapshot(corrupt), { code: 'program_snapshot_not_operational' });
});
function linkedFixture(profile = relative()) {
  const canonical = normalizeBookingProfile(profile);
  const solution = solveBookingProfile({ profile: canonical, ...context(), start });
  const appointment = { id_cita: 44, inicio: solution.start_at, fin: solution.end_at, tratamiento_id: 20,
    doctor_id: 5, instalacion_id: 9, estado: 'info_confirmada', source_system: 'cliniccloud',
    import_metadata: { booking: { version: 1, profile: canonical, phases: solution.phases,
      capacity_fully_verified: solution.capacity_fully_verified, attention_requirements_pending: [] } } };
  const composed = compose([profile]);
  return { appointment, session: { key: 's1', booking_profile: composed.profile, treatment_ids: [20], duration_minutes: composed.duration_minutes } };
}
test('equivalent original v4 visit can link into a purchased unit without moving or renaming its reservation', () => {
  const f = linkedFixture(), before = clone(f.appointment);
  const linked = compatibleLinkedAppointment(f.session, f.appointment);
  assert.equal(linked.duration_minutes, 45); assert.equal(linked.booking_profile.version, 4);
  assert.deepEqual(linked.linked_resources.map(p => p.key), ['draw', 'apply']);
  assert.deepEqual(f.appointment, before);
  const selections = programBookingSelections({ ...linked, linked_appointment: { id: 44 } }, f.appointment,
    { apply: { doctor_id: 6, installation_id: 10 } });
  assert.deepEqual(selections, { t1_p2: { doctor_id: 6, installation_id: 10 } });
});
test('v4 link rejects forged clocks, resources, partial capacity and incompatible attention', () => {
  for (const change of [a => { a.fin = '2030-01-07T10:00:00Z'; },
    a => { a.import_metadata.booking.phases[1].start_offset_minutes = 20; },
    a => { a.import_metadata.booking.phases[1].doctor_ids = [5]; },
    a => { delete a.import_metadata.booking.capacity_fully_verified; },
    a => { a.import_metadata.booking.capacity_fully_verified = false; }]) {
    const f = linkedFixture(); change(f.appointment);
    assert.throws(() => compatibleLinkedAppointment(f.session, f.appointment), error => /^program_link_(duration|resources)_mismatch$/.test(error.code));
  }
  const f = linkedFixture(); f.session.booking_profile.phases[0].staff_attention = [{ mode: 'start_only', start_minutes: 5, start_window_minutes: 15 }];
  assert.throws(() => compatibleLinkedAppointment(f.session, f.appointment), { code: 'program_link_resources_mismatch' });
});
test('v4 program composition freezes substitution decisions; linking cannot silently widen them', () => {
  const source = relative();
  source.phases[0].professionals = { mode: 'any', ids: [5, 7], preferred_id: 5, fallback_when: 'absence_only' };
  const composed = compose([source]);
  assert.equal(composed.profile.phases[0].professionals.fallback_when, 'absence_only');
  const f = linkedFixture(source), before = clone(f.appointment);
  assert.doesNotThrow(() => compatibleLinkedAppointment(f.session, f.appointment));
  f.session.booking_profile.phases[0].professionals.fallback_when = 'unavailable';
  assert.throws(() => compatibleLinkedAppointment(f.session, f.appointment), { code: 'program_link_resources_mismatch' });
  assert.deepEqual(f.appointment, before);
});
test('catalog DTO reports span and pending requirements without publishing clinically incomplete capacity', () => {
  const source = relative(); source.phases[0].attention_requirements_pending = [{ key: 'check', label: 'Comprobación pendiente de definir' }];
  const dto = treatmentDto({ id_tratamiento: 20, nombre: 'Técnica sintética', activo: true, precio_base: 45,
    clinical_config: { catalog_status: 'active', booking_profile: source } });
  assert.equal(dto.duration_minutes, 45); assert.equal(dto.booking_ready, false);
  assert(dto.issues.some(issue => issue.code === 'pending_attention_requirements'));
  assert.equal(dto.booking_profile.version, 4);
  const ambiguous = relative(); ambiguous.phases[0].equipment_requirements = [{ equipment_ids: [1] }, { equipment_ids: [2] }];
  const ambiguousDto = treatmentDto({ id_tratamiento: 20, nombre: 'Técnica sintética', activo: true,
    clinical_config: { catalog_status: 'active', booking_profile: ambiguous } });
  assert(ambiguousDto.issues.some(issue => issue.code === 'booking_profile_attention_ambiguous'));
  assert.equal(ambiguousDto.booking_ready, false);
});
function frozenProgram(profile = relative()) {
  return snapshot({ id: 'synthetic-program', version: 1, kind: 'program', status: 'active', name: 'Programa sintético', total_price: 45,
    summary: { issues: [] }, appointments: [{ key: 's0', label: 'Visita sintética', offset_days: 0, treatment_ids: [20], duration_minutes: 45,
      treatments: [{ ...treatment(20, profile), duration_minutes: 45 }] }] });
}
test('economic scheduling signals reflect the v4 gate but do not hide purchased historical plans', () => {
  const frozen = frozenProgram();
  const args = { budget: { status: 'accepted' }, lines: [{ key: 'line', program_snapshot: frozen }], sessions: [],
    vouchers: [{ id: 1, public_id: 'synthetic-purchase', budget_line_key: 'line', status: 'active' }], bookingEnabled: true };
  const off = programPlans({ ...args, capabilities: { simple: true, multi: true, relativeSteps: false } })[0];
  assert.equal(off.appointment_count, 1); assert.equal(off.can_view_schedule, true); assert.equal(off.can_schedule, false);
  assert.equal(off.automatic_scheduling_available, false); assert.equal(off.capability_reason, 'booking_profile_runtime_unavailable');
  const on = programPlans({ ...args, capabilities: { simple: true, multi: true, relativeSteps: true } })[0];
  assert.equal(on.can_schedule, true); assert.equal(on.automatic_scheduling_available, true);
  const pending = relative(); pending.phases[0].attention_requirements_pending = [{ key: 'check', label: 'Tiempo pendiente' }];
  const incomplete = programPlans({ ...args, lines: [{ key: 'line', program_snapshot: frozenProgram(pending) }],
    capabilities: { simple: true, multi: true, relativeSteps: true } })[0];
  assert.equal(incomplete.can_schedule, false); assert.equal(incomplete.capability_reason, 'pending_attention_requirements');
  assert.equal(incomplete.can_view_schedule, true);
});
test('presenting a frozen v4 economic line enforces the shared gate without mutating process flags or historic parsing', () => {
  const sourcePath = require.resolve('../../lib/economicProgramSnapshot'), actualRequire = createRequire(sourcePath), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(sourcePath, 'utf8'), { module, exports: module.exports, Date, Set, Map, process,
    require: name => name === './program-booking'
      ? { ...actualRequire(name), programBookingEnabled: () => true } : actualRequire(name) });
  const frozen = frozenProgram(), line = { program_id: frozen.program_id, program_snapshot: frozen }, before = clone(line);
  assert.throws(() => module.exports.assertOperational([line], { capabilities: { simple: true, multi: true, relativeSteps: false } }),
    { code: 'booking_profile_runtime_unavailable' });
  assert.doesNotThrow(() => module.exports.assertOperational([line], { capabilities: { simple: true, multi: true, relativeSteps: true } }));
  assert.equal(module.exports.operationalSnapshot(frozen).appointments[0].booking_profile.version, 4);
  assert.deepEqual(line, before);
});
