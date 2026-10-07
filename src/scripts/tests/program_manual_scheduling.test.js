'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const { Op } = require('sequelize');
const { snapshot, operationalSnapshot, programPlans } = require('../../lib/economicProgramSnapshot');
const { materializeSession, bookingRequest, composeAppointmentProfile, seriesIssues } = require('../../lib/program-booking');
const { solveBookingProfile } = require('../../lib/booking-profile-solver');
const { appointmentLinkRequest, compatibleLinkedAppointment } = require('../../lib/program-appointment-link');
const { importReviewVersion } = require('../../lib/appointment-import-review');
const { programTreatmentDoctorIds } = require('../../lib/program-appointment-context');
const { serializeAppointmentStatusActivity } = require('../../services/appointmentActivity.service');
const clone = value => JSON.parse(JSON.stringify(value));
const baseProfile = duration => ({ version: 1, phases: [{ key: 'care', duration_minutes: duration,
  installation_ids: [8], professionals: { mode: 'any', ids: [7], preferred_id: 7 } }] });
function definition(duration = 30, offsets = [null, null, null]) {
  return { id: 'manual-program', version: 1, kind: 'program', status: 'active', name: 'Programa sintético', total_price: 120,
    summary: { issues: [] }, appointments: offsets.map((offset_days, index) => ({ key: `s${index}`, label: `Sesión ${index + 1}`,
      offset_days, treatment_ids: [10], duration_minutes: duration,
      treatments: [{ id: 10, name: 'Tratamiento sintético', duration_minutes: duration, booking_profile: baseProfile(duration) }] })) };
}
function model(data) {
  return { ...clone(data), toJSON() { return Object.fromEntries(Object.entries(this).filter(([, value]) => typeof value !== 'function')); },
    async update(values) { Object.assign(this, clone(values)); return this; } };
}
function matches(row, where) {
  return Reflect.ownKeys(where).every(key => where[key]?.[Op.in] ? where[key][Op.in].includes(row[key]) : row[key] === where[key]);
}
function fixture({ duration = 30, offsets, appointment = null, automaticProposals = false, profile = null, relativeSteps = false } = {}) {
  const purchase = definition(duration, offsets);
  if (profile) for (const session of purchase.appointments) session.treatments[0].booking_profile = clone(profile);
  const frozen = snapshot(purchase);
  const state = { records: [], appointments: appointment ? [model(appointment)] : [], requests: [], events: [], commands: [], contextReads: 0,
    voucher: model({ id: 1, public_id: 'purchase', clinic_id: 72, patient_id: 3, budget_id: 4, budget_line_key: 'line',
      source_system: 'treatment_program', status: 'active', total_units: 3, available_units: 3, sold_amount: 120 }),
    budget: model({ id: 4, clinic_id: 72, patient_id: 3, status: 'accepted', current_version: 1 }) };
  const clinic = { id_clinica: 72, grupoClinicaId: 1, configuracion: { timezone: 'Europe/Madrid' } };
  const fakeDb = { Sequelize: { Op },
    sequelize: { queue: Promise.resolve(), transaction(options, callback) {
      const run = this.queue.then(async () => {
        const before = clone(state);
        try { return await callback({ options, LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } }); }
        catch (error) {
          for (const key of ['records', 'appointments', 'requests']) state[key] = before[key].map(model);
          for (const key of ['events', 'commands']) state[key] = before[key];
          state.voucher = model(before.voucher); state.budget = model(before.budget);
          throw error;
        }
      });
      this.queue = run.catch(() => {}); return run;
    } },
    PatientVoucher: { findOne: async ({ where }) => matches(state.voucher, where) ? state.voucher : null },
    EconomicBudget: { findOne: async ({ where }) => matches(state.budget, where) ? state.budget : null },
    EconomicBudgetVersion: { findOne: async () => ({ lines: [{ key: 'line', program_snapshot: frozen }] }) },
    Clinica: { findByPk: async id => id === 72 ? clinic : null },
    Tratamiento: { findByPk: async id => id === 10 ? { id_tratamiento: 10, clinica_id: 72, origen: 'clinica', activo: true,
      clinical_config: { catalog_status: 'active', booking_profile: profile || baseProfile(duration) } } : null },
    Instalacion: { findAll: async () => [{ id: 8 }] }, DoctorClinica: { findAll: async () => [{ doctor_id: 7 }] },
    PatientProgramSession: { findAll: async ({ where }) => state.records.filter(row => matches(row, where)),
      findOne: async ({ where }) => state.records.find(row => matches(row, where)) || null,
      create: async data => { const row = model({ id: state.records.length + 1, ...data }); state.records.push(row); return row; } },
    PatientProgramBookingRequest: { findOne: async ({ where }) => state.requests.find(row => matches(row, where)) || null,
      create: async data => { state.requests.push(model(data)); } },
    PatientOperationalEvent: { create: async data => { state.events.push(clone(data)); } },
    CitaPaciente: { findAll: async ({ where }) => state.appointments.filter(row => matches(row, where)),
      findOne: async ({ where }) => state.appointments.find(row => matches(row, where)) || null,
      create: async data => { const row = model({ id_cita: state.appointments.length + 100, ...data }); state.appointments.push(row); return row; } },
  };
  const servicePath = require.resolve('../../services/patientProgramBooking.service');
  const actualRequire = createRequire(servicePath);
  const source = fs.readFileSync(servicePath, 'utf8');
  const free = () => ({ windows: [{ start: '2030-01-01T00:00:00Z', end: '2031-01-01T00:00:00Z' }], busy: [], resource_key: 'installation:8' });
  const injected = { './appointmentBookingAvailability.service': {
    resolveInstallationKeys: async () => ({ keys: new Map([[8, 'installation:8']]) }),
    loadBookingContext: async options => { state.contextReads++; state.contextVersion = options.profile.version; return { doctors: new Map([[7, free()]]), installations: new Map([[8, free()]]),
      installationKeys: new Map([[8, 'installation:8']]), patientBusy: [], equipment: new Map() }; },
    solutionsForCalendar: options => {
      if (!automaticProposals) throw Error('Automatic date suggestions forbidden for this manual fixture');
      const result = solveBookingProfile({ profile: options.profile, ...options.context, start: `${options.date}T09:00:00Z` });
      return result ? [result] : [];
    },
  }, './appointmentBookingCommand.service': { lockBookingResources: async () => {},
    mutateAppointmentBooking: async options => {
      state.commands.push({ values: clone(options.appointmentValues), snapshot: clone(options.trustedProgramSession.snapshot), capabilities: clone(options.capabilities) });
      assert(options.trustedProgramSession.snapshot.booking_profile.phases.every(phase => phase.duration_minutes > 0));
      return options.persist({ values: options.appointmentValues, existing: null });
    } } };
  const module = { exports: {} };
  vm.runInNewContext(source, { module, exports: module.exports, require: name => injected[name] || actualRequire(name), Date, Map, Set, structuredClone });
  return { state, frozen, db: fakeDb, service: module.exports.createPatientProgramBookingService({ db: fakeDb, enabled: () => true,
    capabilities: () => ({ simple: true, multi: true, relativeSteps }),
    now: () => new Date('2030-01-01T00:00:00Z') }), options: { publicId: 'purchase', clinicId: 72, actorId: 9 } };
}
function individual(extra = {}) {
  return { id_cita: 5, clinica_id: 72, paciente_id: 3, doctor_id: 7, instalacion_id: 8, tratamiento_id: 10,
    inicio: '2030-01-07T09:00:00Z', fin: '2030-01-07T09:30:00Z', updated_at: '2030-01-01T01:00:00Z',
    estado: 'info_confirmada', source_system: 'cliniccloud', source_reference: 'source-synthetic',
    import_metadata: { automation_policy: 'hold', source_receipt: { preserved: true } }, ...extra };
}
async function linkPayload(f, extra = {}) {
  const plan = await f.service.read(f.options);
  return { request_key: 'link-synthetic-request', snapshot_sha256: f.frozen.sha256, expected_plan_revision: plan.plan_revision,
    expected_appointment_revision: importReviewVersion(f.state.appointments[0].toJSON()), session_key: 's1', appointment_id: 5, ...extra };
}

test('manual purchase exposes every unbooked unit as pending without fictional dates', async () => {
  const f = fixture();
  const plan = await f.service.read(f.options);
  assert.equal(plan.scheduling_mode, 'manual'); assert.equal(plan.automatic_scheduling_available, false);
  assert.equal(plan.pending_count, 3); assert.equal(plan.can_schedule, true);
  assert(plan.sessions.every(row => row.start_at === null && row.scheduling_status === 'pending'));
  const preview = await f.service.propose({ ...f.options, payload: { from_date: '2030-01-07', days: 10 } });
  assert(preview.proposals.every(row => row.solution === null && row.reason_code === 'program_manual_date_required'));
  assert.equal(f.state.contextReads, 0); assert.equal(f.state.commands.length, 0);
});
const relativeProfile = pending => ({ version: 4, phases: [{ ...baseProfile(30).phases[0], start_offset_minutes: 0,
  staff_attention: [{ mode: 'start_only', start_minutes: 5, start_window_minutes: 15 }],
  ...(pending ? { attention_requirements_pending: [{ key: 'check', label: 'Comprobación intermedia: tiempo pendiente de confirmar' }] } : {}) }] });
test('v4 purchase stays readable but preview and reservation fail closed with the relative writer off', async () => {
  const f = fixture({ profile: relativeProfile() });
  const plan = await f.service.read(f.options);
  assert.equal(plan.sessions[0].booking_profile.version, 4); assert.equal(plan.pending_count, 3);
  assert.equal(plan.can_schedule, false); assert.equal(plan.booking_restriction.code, 'booking_profile_runtime_unavailable');
  await assert.rejects(f.service.propose({ ...f.options, payload: { from_date: '2030-01-07', days: 1 } }), { code: 'booking_profile_runtime_unavailable' });
  await assert.rejects(f.service.book({ ...f.options, payload: { request_key: 'relative-gate-request', snapshot_sha256: f.frozen.sha256,
    sessions: [{ key: 's0', start_at: '2030-01-07T09:00:00Z' }] } }), { code: 'booking_profile_runtime_unavailable' });
  assert.equal(f.state.contextReads, 0); assert.equal(f.state.records.length, 0); assert.equal(f.state.commands.length, 0);
  assert.equal(f.state.voucher.available_units, 3); assert.equal(f.state.voucher.sold_amount, 120);
});
test('v4 strict program preview preserves offsets and attention while reserve passes real capabilities without changing economics', async () => {
  const f = fixture({ profile: relativeProfile(), relativeSteps: true });
  const preview = await f.service.propose({ ...f.options, payload: { from_date: '2030-01-07', days: 1, session_keys: ['s0'],
    manual_sessions: [{ key: 's0', start_local: '2030-01-07T10:15' }] } });
  assert.equal(f.state.contextVersion, 4); assert.equal(preview.proposals[0].solution.capacity_fully_verified, true);
  assert.equal(preview.proposals[0].solution.phases[0].start_offset_minutes, 0);
  assert.equal(preview.proposals[0].solution.phases[0].staff_intervals[0].kind, 'start');
  const payload = { request_key: 'relative-book-request', snapshot_sha256: f.frozen.sha256,
    sessions: [{ key: 's0', start_at: preview.proposals[0].solution.start_at }] };
  await f.service.book({ ...f.options, payload });
  assert.equal(f.state.commands[0].snapshot.booking_profile.version, 4);
  assert.equal(f.state.commands[0].snapshot.booking_profile.phases[0].start_offset_minutes, 0);
  assert.equal(f.state.commands[0].capabilities.relativeSteps, true);
  assert.equal(f.state.voucher.available_units, 3); assert.equal(f.state.voucher.sold_amount, 120);
  assert.equal((await f.service.read(f.options)).pending_count, 2);
  assert.equal((await f.service.book({ ...f.options, payload })).replayed, true);
  assert.equal(f.state.commands.length, 1);
});
test('unknown v4 attention remains a clinical blocker even with all writer capabilities enabled', async () => {
  const f = fixture({ profile: relativeProfile(true), relativeSteps: true });
  const plan = await f.service.read(f.options);
  assert.equal(plan.can_schedule, false); assert.equal(plan.booking_restriction.code, 'pending_attention_requirements');
  await assert.rejects(f.service.propose({ ...f.options, payload: { from_date: '2030-01-07', days: 1, session_keys: ['s0'],
    manual_sessions: [{ key: 's0', start_local: '2030-01-07T10:15' }] } }), { code: 'pending_attention_requirements' });
  await assert.rejects(f.service.book({ ...f.options, payload: { request_key: 'relative-pending-request', snapshot_sha256: f.frozen.sha256,
    sessions: [{ key: 's0', start_at: '2030-01-07T09:00:00Z' }] } }), { code: 'pending_attention_requirements' });
  assert.equal(f.state.contextReads, 0); assert.equal(f.state.commands.length, 0); assert.equal(f.state.records.length, 0);
});
test('linking an equivalent existing v4 appointment cannot bypass the relative writer gate', async () => {
  const profile = relativeProfile();
  const free = { windows: [{ start: '2030-01-01T00:00:00Z', end: '2031-01-01T00:00:00Z' }], busy: [] };
  const solution = solveBookingProfile({ profile, start: '2030-01-07T09:00:00Z', doctors: new Map([[7, free]]), installations: new Map([[8, free]]) });
  const appointment = individual({ import_metadata: { booking: { version: 1, profile, phases: solution.phases,
    capacity_fully_verified: true, attention_requirements_pending: [] } } });
  const f = fixture({ profile, appointment }), before = f.state.appointments[0].toJSON();
  await assert.rejects(f.service.linkAppointment({ ...f.options, payload: await linkPayload(f) }), { code: 'booking_profile_runtime_unavailable' });
  assert.deepEqual(f.state.appointments[0].toJSON(), before); assert.equal(f.state.records.length, 0); assert.equal(f.state.events.length, 0);
});
test('manual preview is the exact chosen local instant and booking leaves remaining units pending and economics untouched', async () => {
  const f = fixture({ duration: null });
  const preview = await f.service.propose({ ...f.options, payload: { from_date: '2030-01-07', days: 1, session_keys: ['s0'],
    manual_sessions: [{ key: 's0', start_local: '2030-01-07T10:15', duration_minutes: 40 }] } });
  assert.equal(preview.proposals[0].solution.start_at, '2030-01-07T09:15:00.000Z');
  const payload = { request_key: 'manual-reservation-1', snapshot_sha256: f.frozen.sha256,
    sessions: [{ key: 's0', start_at: preview.proposals[0].solution.start_at, duration_minutes: 40 }] };
  const result = await f.service.book({ ...f.options, payload });
  assert.equal(result.sessions.length, 1); assert.equal(f.state.commands[0].snapshot.duration_minutes, 40);
  assert.equal(f.frozen.appointments[0].duration_minutes, null);
  const plan = await f.service.read(f.options);
  assert.equal(plan.pending_count, 2); assert.equal(plan.sessions[0].duration_minutes, 40);
  assert.equal(plan.sessions[1].start_at, null); assert.equal(f.state.voucher.available_units, 3); assert.equal(f.state.voucher.sold_amount, 120);
  const replay = await f.service.book({ ...f.options, payload });
  assert.equal(replay.replayed, true); assert.equal(f.state.commands.length, 1);
});
test('duration cannot be guessed, silently shortened, overridden when defined, or allocated between unknown phases', () => {
  const single = operationalSnapshot(snapshot(definition(null))).appointments[0];
  assert.throws(() => materializeSession(single), { code: 'program_duration_required' });
  assert.equal(materializeSession(single, { duration_minutes: 35 }).duration_minutes, 35);
  assert.throws(() => materializeSession(operationalSnapshot(snapshot(definition())).appointments[0], { duration_minutes: 10 }), { code: 'program_duration_locked' });
  const multi = { ...single, booking_profile: { ...single.booking_profile, phases: [single.booking_profile.phases[0], { ...single.booking_profile.phases[0], key: 't1_p2' }] } };
  assert.throws(() => materializeSession(multi, { duration_minutes: 40 }), { code: 'program_duration_required' });
  assert.equal(materializeSession(multi, { phase_durations: { t1_p1: 10, t1_p2: 30 } }).duration_minutes, 40);
  assert.throws(() => materializeSession(multi, { phase_durations: { invented: 10 } }), { code: 'program_duration_locked' });
});
test('explicit durations are hash bound without changing the old reservation idempotency contract', () => {
  const payload = { request_key: 'manual-reservation', snapshot_sha256: 'a'.repeat(64), sessions: [{ key: 's0', start_at: '2030-01-07T09:00:00Z' }] };
  assert.notEqual(bookingRequest(payload).request_sha256, bookingRequest({ ...payload, sessions: [{ ...payload.sessions[0], duration_minutes: 40 }] }).request_sha256);
  assert.throws(() => bookingRequest({ ...payload, sessions: [{ ...payload.sessions[0], duration_minutes: '40' }] }), { code: 'program_duration_invalid' });
});
test('fixed manual previews participate in ordering and resource occupancy, not just final reservation', async () => {
  const f = fixture();
  const input = { from_date: '2030-01-07', days: 1, session_keys: ['s1'], fixed_sessions: [{ key: 's0', start_at: '2030-01-07T09:00:00Z' }],
    manual_sessions: [{ key: 's1', start_local: '2030-01-07T10:15' }] };
  const overlap = await f.service.propose({ ...f.options, payload: input });
  assert.equal(overlap.proposals[0].solution, null); assert.equal(overlap.proposals[0].reason_code, 'program_cadence_conflict');
  const separate = await f.service.propose({ ...f.options, payload: { ...input, manual_sessions: [{ key: 's1', start_local: '2030-01-07T10:30' }] } });
  assert.equal(separate.proposals[0].solution.start_at, '2030-01-07T09:30:00.000Z');
});
test('documented partial intervals survive manual preview/reserve without inventing dates for unknown sessions', async () => {
  const f = fixture({ offsets: [0, 14, null] });
  await f.service.book({ ...f.options, payload: { request_key: 'known-offset-first', snapshot_sha256: f.frozen.sha256,
    sessions: [{ key: 's0', start_at: '2030-01-07T09:00:00Z' }] } });
  const preview = await f.service.propose({ ...f.options, payload: { from_date: '2030-01-08', days: 1, session_keys: ['s1'],
    manual_sessions: [{ key: 's1', start_local: '2030-01-08T10:00' }] } });
  assert.equal(preview.proposals[0].solution, null); assert.equal(preview.proposals[0].reason_code, 'program_cadence_conflict');
  await assert.rejects(f.service.book({ ...f.options, payload: { request_key: 'known-offset-invalid', snapshot_sha256: f.frozen.sha256,
    sessions: [{ key: 's1', start_at: '2030-01-08T09:00:00Z' }] } }), { code: 'program_cadence_conflict' });
  assert.equal(f.state.records.length, 1); assert.equal((await f.service.read(f.options)).sessions[2].start_at, null);
  const rows = [{ key: 's0', offset_days: 0, start_at: '2030-03-24T09:00:00Z', end_at: '2030-03-24T09:30:00Z' },
    { key: 's1', offset_days: 14, start_at: '2030-04-07T08:00:00Z', end_at: '2030-04-07T08:30:00Z' }];
  assert.equal(seriesIssues(rows, null, 'Europe/Madrid').length, 0);
});
test('automatic proposals after entering at an intermediate unit use offset differences, not a fictional day-zero date', async () => {
  const f = fixture({ offsets: [0, 14, 28], appointment: individual(), automaticProposals: true });
  await f.service.linkAppointment({ ...f.options, payload: await linkPayload(f) });
  const result = await f.service.propose({ ...f.options, payload: { from_date: '2030-01-08', days: 40, session_keys: ['s2'] } });
  assert.equal(result.proposals[0].solution.start_at, '2030-01-21T09:00:00.000Z');
  assert.equal((await f.service.read(f.options)).sessions[0].start_at, null);
});
test('existing appointment links preserve state, times, source, automation and original evidence; prior units are not marked performed', async () => {
  const f = fixture({ appointment: individual() }), payload = await linkPayload(f);
  const before = f.state.appointments[0].toJSON();
  const result = await f.service.linkAppointment({ ...f.options, payload });
  const after = f.state.appointments[0].toJSON();
  for (const key of ['inicio', 'fin', 'estado', 'source_system', 'source_reference', 'tratamiento_id', 'doctor_id', 'instalacion_id']) assert.equal(after[key], before[key]);
  assert.deepEqual(after.import_metadata.source_receipt, before.import_metadata.source_receipt);
  assert.equal(after.import_metadata.automation_policy, 'hold'); assert.equal(after.voucher_id, 1);
  assert.deepEqual([...result.prior_pending_keys], ['s0']); assert.deepEqual([...result.following_pending_keys], ['s2']);
  assert.equal(result.consumed_units, 0); assert.equal(result.payment_created, false);
  assert.equal(f.state.voucher.available_units, 3); assert.equal(f.state.voucher.sold_amount, 120);
  assert.equal(f.state.events[0].event_type, 'appointment.program_linked'); assert.equal(f.state.commands.length, 0);
  const replay = await f.service.linkAppointment({ ...f.options, payload });
  assert.equal(replay.replayed, true); assert.equal(f.state.records.length, 1); assert.equal(f.state.events.length, 1);
  const plan = await f.service.read(f.options); assert.equal(plan.sessions[1].scheduling_status, 'reserved'); assert.equal(plan.pending_count, 2);
});
test('linking rejects cross-patient/tenant ownership, already-claimed appointments and stale appointment/plan revisions atomically', async () => {
  for (const change of [{ paciente_id: 99 }, { clinica_id: 99 }]) {
    const f = fixture({ appointment: individual(change) });
    await assert.rejects(f.service.linkAppointment({ ...f.options, payload: await linkPayload(f) }), { code: 'program_link_appointment_not_found' });
    assert.equal(f.state.records.length, 0);
  }
  const stale = fixture({ appointment: individual() }), payload = await linkPayload(stale);
  stale.state.appointments[0].nota = 'Concurrent note';
  await assert.rejects(stale.service.linkAppointment({ ...stale.options, payload }), { code: 'program_link_appointment_changed' });
  assert.equal(stale.state.records.length, 0); assert.equal(stale.state.events.length, 0);
  const concurrent = fixture({ appointment: individual() }), first = await linkPayload(concurrent);
  const outcomes = await Promise.allSettled([concurrent.service.linkAppointment({ ...concurrent.options, payload: first }),
    concurrent.service.linkAppointment({ ...concurrent.options, payload: { ...first, request_key: 'different-link-request' } })]);
  assert.equal(outcomes.filter(row => row.status === 'fulfilled').length, 1); assert.equal(concurrent.state.records.length, 1);
});
test('linking cannot imply historical completion, care, treatment aliasing or a duration change', async () => {
  for (const [extra, code] of [[{ estado: 'completada' }, 'program_link_appointment_closed'], [{ estado: 'no_asistio' }, 'program_link_appointment_closed'],
    [{ care_started_at: '2030-01-01T00:00:00Z' }, 'program_link_appointment_closed'], [{ voucher_id: 99 }, 'program_link_appointment_claimed'],
    [{ tratamiento_id: 11 }, 'program_link_treatment_mismatch'], [{ fin: '2030-01-07T09:20:00Z' }, 'program_link_duration_mismatch']]) {
    const f = fixture({ appointment: individual(extra) });
    await assert.rejects(f.service.linkAppointment({ ...f.options, payload: await linkPayload(f) }), { code });
    assert.equal(f.state.records.length, 0); assert.equal(f.state.voucher.available_units, 3);
  }
});
test('link request cannot omit scope revisions or forge financial/clinical fields', () => {
  const payload = { request_key: 'link-existing-request', snapshot_sha256: 'a'.repeat(64), expected_plan_revision: 'b'.repeat(64), expected_appointment_revision: 'c'.repeat(64), session_key: 's1', appointment_id: 5 };
  assert.throws(() => appointmentLinkRequest({ ...payload, expected_appointment_revision: null }), { code: 'program_link_request_invalid' });
  assert.equal(appointmentLinkRequest(payload).request_sha256, appointmentLinkRequest({ ...payload, patient_id: 99, consumed_units: 9, price: 0 }).request_sha256);
});
test('canonical original phase keys retain professional consent context without rewriting the booking snapshot', () => {
  const session = { ...composeAppointmentProfile({ treatments: [{ id: 10, name: 'Care', booking_profile: baseProfile(30) }] }), treatment_ids: [10] };
  session.booking_profile = session.profile;
  const appt = individual({ import_metadata: { booking: { version: 1, profile: baseProfile(30), phases: [{ key: 'care', start_at: '2030-01-07T09:00:00Z',
    end_at: '2030-01-07T09:30:00Z', installation_id: 8, doctor_ids: [7], staff_time_scope: 'phase' }] } } });
  const linked = compatibleLinkedAppointment(session, appt);
  assert.deepEqual(programTreatmentDoctorIds({ ...linked, linked_appointment: { id: 5 } }, appt, 10), [7]);
  const malformed = clone(appt); malformed.import_metadata.booking.phases[0].staff_time_scope = 'appointment';
  assert.throws(() => compatibleLinkedAppointment(session, malformed), { code: 'program_link_resources_mismatch' });
});
test('linking cannot weaken whole-appointment staff ownership to one phase, even for an all-team with one member', () => {
  const original = { version: 1, phases: [{ ...baseProfile(30).phases[0], key: 'part1' },
    { ...baseProfile(30).phases[0], key: 'part2', professionals: { mode: 'any', ids: [9], preferred_id: 9 } }] };
  const purchased = clone(original); purchased.phases[0].professionals = { mode: 'all', ids: [7], preferred_id: null };
  const composed = composeAppointmentProfile({ treatments: [{ id: 10, name: 'Care', booking_profile: purchased }] });
  const session = { ...composed, treatment_ids: [10], booking_profile: composed.profile };
  const appt = individual({ fin: '2030-01-07T10:00:00Z', import_metadata: { booking: { version: 1, profile: original, phases: [
    { key: 'part1', start_at: '2030-01-07T09:00:00Z', end_at: '2030-01-07T09:30:00Z', installation_id: 8, doctor_ids: [7], staff_time_scope: 'phase' },
    { key: 'part2', start_at: '2030-01-07T09:30:00Z', end_at: '2030-01-07T10:00:00Z', installation_id: 8, doctor_ids: [9], staff_time_scope: 'phase' },
  ] } } });
  assert.throws(() => compatibleLinkedAppointment(session, appt), { code: 'program_link_resources_mismatch' });
});
test('program projection keeps manual sessions pending and new activity describes linking, not a status transition', () => {
  const frozen = snapshot(definition()), [plan] = programPlans({ budget: { status: 'accepted' }, lines: [{ key: 'line', program_snapshot: frozen }], sessions: [],
    vouchers: [{ id: 1, public_id: 'purchase', budget_line_key: 'line', status: 'active' }], bookingEnabled: true });
  assert.equal(plan.scheduling_mode, 'manual'); assert.equal(plan.scheduling_counts.pending, 3);
  assert(plan.appointments.every(row => row.scheduling_status === 'pending_planning' && row.start_at === null));
  const activity = serializeAppointmentStatusActivity({ id: 1, event_type: 'appointment.program_linked', metadata: { appointment_id: 5, program_name: 'Programa', session_number: 2 } });
  assert.equal(activity.tipo, 'appointment_program_linked'); assert.match(activity.descripcion, /no se registra ningún cobro ni consumo/);
});
