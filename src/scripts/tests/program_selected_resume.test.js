'use strict';

// Offline synthetic purchases. The program service and canonical booking
// command execute against a transactional in-memory DB, never models/index,
// credentials, CRM, provider calls or deployment flags.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const { Op } = require('sequelize');
const { snapshot } = require('../../lib/economicProgramSnapshot');
const { solveBookingProfile } = require('../../lib/booking-profile-solver');
const { bookingSegments } = require('../../lib/appointment-booking-segments');
const { resumeInfo, resumeSelectionInfo, resumeOptions, resumeSessions } = require('../../lib/program-replan');
const serviceFile = require.resolve('../../services/patientProgramBooking.service');
const commandFile = require.resolve('../../services/appointmentBookingCommand.service');
const actualRequire = createRequire(serviceFile);
const profileService = actualRequire('./treatmentBookingProfile.service');
const programBooking = actualRequire('../lib/program-booking');
const clone = value => JSON.parse(JSON.stringify(value));
const now = new Date('2030-01-01T00:00:00Z');
const caps = { simple: true, multi: true, relativeSteps: true };

function purePlan(statuses) {
  return { sessions: statuses.map((scheduling_status, position) => ({ key: `s${position}`, label: `Sesión ${position + 1}`, position,
    scheduling_status, record: { id: position + 1 }, start_at: '2030-02-01T09:00:00Z',
    appointment: { estado: scheduling_status === 'reserved' ? 'pendiente' : scheduling_status,
      import_metadata: { automation_policy: 'hold' } } })) };
}
function bookingProfile({ machine = false, alternatives = false, mandatoryTeam = false } = {}) {
  return { version: machine ? 2 : 4, phases: [
    { key: 'setup', label: 'Paso sintético inicial', duration_minutes: 30, installation_ids: alternatives ? [9, 11] : [9],
      professionals: { mode: 'any', ids: alternatives ? [5, 7] : [5], preferred_id: 5,
        ...(!machine && alternatives ? { fallback_when: 'unavailable' } : {}) },
      ...(machine ? { equipment_requirements: [{ equipment_ids: [11] }] } : { start_offset_minutes: 0 }) },
    { key: 'apply', label: 'Paso sintético final', duration_minutes: 30, installation_ids: [10],
      professionals: mandatoryTeam ? { mode: 'all', ids: [6, 7] } : { mode: 'any', ids: [6], preferred_id: 6 }, ...(!machine ? { start_offset_minutes: 15 } : {}) },
  ] };
}
function rowModel(data) {
  return { ...clone(data), toJSON() { return Object.fromEntries(Object.entries(this).filter(([, value]) => typeof value !== 'function')); },
    async update(values) { Object.assign(this, clone(values)); return this; }, async reload() { return this; } };
}
function matches(row, where = {}) {
  return Reflect.ownKeys(where).every(key => {
    const condition = where[key];
    if (key === Op.or) return condition.some(item => matches(row, item));
    if (condition && typeof condition === 'object') return Reflect.ownKeys(condition).every(operator => {
      if (operator === Op.in) return condition[operator].map(String).includes(String(row[key]));
      if (operator === Op.notIn) return !condition[operator].map(String).includes(String(row[key]));
      if (operator === Op.ne) return String(row[key]) !== String(condition[operator]);
      throw Error('Unknown synthetic query operator');
    });
    return String(row[key]) === String(condition);
  });
}
function loadModule(filename, injected) {
  const requireLocal = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, console, Date, Map, Set, Promise, structuredClone,
    require: name => Object.hasOwn(injected, name) ? injected[name] : requireLocal(name) }, { filename });
  return module.exports;
}
function fixture({ manual = true, machine = false, alternatives = false, turnaround = 0, offsets = null,
  capabilities = caps, count = 4, mandatoryTeam = false } = {}) {
  const profile = bookingProfile({ machine, alternatives, mandatoryTeam });
  let fixtureNow = new Date(now);
  const frozen = snapshot({ id: 'synthetic-program', version: 1, kind: 'program', status: 'active', name: 'Programa sintético',
    total_price: 120, summary: { issues: [] }, appointments: Array.from({ length: count }, (_, index) => ({ key: `s${index}`,
      label: `Sesión ${index + 1}`, offset_days: offsets ? offsets[index] : manual ? null : index * 7,
      treatment_ids: [3], duration_minutes: machine ? 60 : 45,
      treatments: [{ id: 3, name: 'Tratamiento sintético', duration_minutes: machine ? 60 : 45, booking_profile: profile }] })) });
  const state = { records: [], appointments: [], requests: [], occupancies: [], events: [], busy: [], contexts: [], commits: 0, rollbacks: 0,
    voucher: rowModel({ id: 1, public_id: 'synthetic-purchase', clinic_id: 72, patient_id: 1, budget_id: 4,
      budget_line_key: 'line', source_system: 'treatment_program', status: 'active', total_units: count, available_units: count, sold_amount: 120 }),
    budget: rowModel({ id: 4, clinic_id: 72, patient_id: 1, status: 'accepted', current_version: 1 }) };
  const clinic = { id_clinica: 72, grupoClinicaId: 29, configuracion: { timezone: 'Europe/Madrid' }, equipment_booking_enabled: true };
  const treatment = { id_tratamiento: 3, origen: 'clinica', clinica_id: 72, activo: true, clinical_config: { booking_profile: profile } };
  const query = (rows, options) => rows.filter(row => matches(row, options.where));
  const noEconomics = async () => { throw Error('Replanning must not change a purchase, budget, price, activation or consumption'); };
  const db = {
    Sequelize: { Op },
    sequelize: { transaction: async (options, callback) => {
      const before = clone(state), tx = { options, LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } };
      try { const result = await callback(tx); state.commits++; return result; }
      catch (error) {
        for (const key of ['records', 'appointments', 'requests']) state[key] = before[key].map(rowModel);
        state.occupancies = before.occupancies; state.events = before.events;
        state.voucher = rowModel(before.voucher); state.budget = rowModel(before.budget); state.rollbacks++;
        throw error;
      }
    } },
    PatientVoucher: { findOne: async options => query([state.voucher], options)[0] || null,
      findByPk: async id => Number(id) === 1 ? state.voucher : null, update: noEconomics, create: noEconomics },
    PatientVoucherMovement: { create: noEconomics, findAll: async () => [] },
    EconomicBudget: { findOne: async options => query([state.budget], options)[0] || null, update: noEconomics },
    EconomicBudgetVersion: { findOne: async () => ({ lines: [{ key: 'line', program_snapshot: frozen }] }) },
    Clinica: { findByPk: async id => Number(id) === 72 ? clinic : null }, Tratamiento: { findByPk: async id => Number(id) === 3 ? treatment : null },
    PatientProgramSession: { findAll: async options => query(state.records, options),
      findOne: async options => query(state.records, options)[0] || null,
      create: async values => { const record = rowModel({ id: state.records.length + 1, ...values }); state.records.push(record); return record; } },
    PatientProgramBookingRequest: { findOne: async options => query(state.requests, options)[0] || null,
      create: async values => { const record = rowModel(values); state.requests.push(record); return record; } },
    PatientOperationalEvent: { create: async values => { state.events.push(clone(values)); } },
    CitaPaciente: { findAll: async options => query(state.appointments, options),
      findByPk: async id => state.appointments.find(row => Number(row.id_cita) === Number(id)) || null,
      create: async (values, { transaction }) => { assert(transaction); const appointment = rowModel({ id_cita: state.appointments.length + 100, ...values }); state.appointments.push(appointment); return appointment; } },
    AppointmentBookingResource: { upsert: async () => {}, findByPk: async () => ({}) },
    AppointmentBookingOccupancy: { findAll: async options => query(state.occupancies, options),
      destroy: async options => { state.occupancies = state.occupancies.filter(row => !matches(row, options.where)); },
      bulkCreate: async rows => { state.occupancies.push(...clone(rows)); } },
  };
  const free = () => ({ windows: [{ start: '2030-01-01T00:00:00Z', end: '2031-01-01T00:00:00Z' }], busy: [],
    schedule_verified: true, absence_windows: [], clinic_id: 72 });
  const availability = {
    resolveInstallationKeys: async ({ installationIds }) => ({ keys: new Map(installationIds.map(id => [id, `installation:${id}`])) }),
    loadBookingContext: async args => {
      state.contexts.push({ ignored: [...(args.ignoreAppointmentIds || [])], start: new Date(args.start).toISOString(), end: new Date(args.end).toISOString() });
      const context = { doctors: new Map([5, 6, 7].map(id => [id, { ...free(), name: `Profesional sintético ${id}` }])),
        installations: new Map([9, 10, 11].map(id => [id, { ...free(), name: `Sala sintética ${id}`, resource_key: `installation:${id}` }])),
        installationKeys: new Map([9, 10, 11].map(id => [id, `installation:${id}`])),
        equipment: new Map([[11, { id: 11, name: 'Equipo sintético', status: 'available', installation_ids: new Set([9, 11]),
          busy: [], turnaround_minutes: turnaround, attention_policy: { mode: 'continuous', patient_preparation_minutes: 0 } }]]),
        patientBusy: [], timeZone: 'Europe/Madrid' };
      const ignored = new Set((args.ignoreAppointmentIds || []).map(Number));
      for (const row of state.occupancies.filter(row => !ignored.has(Number(row.appointment_id))
        && state.appointments.find(appointment => appointment.id_cita === row.appointment_id)?.estado !== 'cancelada')) {
        const resource = row.resource_kind === 'equipment' ? context.equipment.get(Number(row.resource_key.split(':')[1]))
          : row.resource_kind === 'doctor' ? context.doctors.get(row.doctor_id) : context.installations.get(row.installation_id);
        resource?.busy.push({ start: row.start_at, end: row.end_at });
      }
      context.patientBusy.push(...state.appointments.filter(row => !ignored.has(row.id_cita) && !['cancelada', 'no_asistio'].includes(row.estado))
        .map(row => ({ start: row.inicio, end: row.fin })));
      for (const row of state.busy) {
        const resource = row.kind === 'doctor' ? context.doctors.get(row.id) : row.kind === 'installation' ? context.installations.get(row.id)
          : row.kind === 'equipment' ? context.equipment.get(row.id) : null;
        if (resource) resource.busy.push({ start: row.start, end: row.end });
        else if (row.kind === 'patient') context.patientBusy.push({ start: row.start, end: row.end });
      }
      return context;
    },
    solutionsForCalendar: ({ profile, context, date }) => [9, 10, 11].map(hour => {
      const solution = solveBookingProfile({ profile, ...context, start: `${date}T${hour.toString().padStart(2, '0')}:00:00Z` });
      return solution && !context.patientBusy.some(row => new Date(row.start) < new Date(solution.end_at) && new Date(row.end) > new Date(solution.start_at)) ? solution : null;
    }).filter(Boolean),
  };
  const boundedProfiles = { ...profileService, bookingCapabilities: () => capabilities,
    requireOperationalProfile: (row, options = {}) => profileService.requireOperationalProfile(row, { capabilities, ...options }) };
  const command = loadModule(commandFile, { './appointmentBookingAvailability.service': availability,
    './treatmentBookingProfile.service': boundedProfiles,
    '../lib/program-booking': { ...programBooking, programBookingEnabled: () => true } });
  const service = loadModule(serviceFile, { './appointmentBookingAvailability.service': availability,
    './appointmentBookingCommand.service': command }).createPatientProgramBookingService({ db, enabled: () => true,
    capabilities: () => capabilities, now: () => new Date(fixtureNow) });
  const options = { publicId: state.voucher.public_id, clinicId: 72, actorId: 1 };
  const booked = key => state.records.find(row => row.session_key === key);
  const appointment = key => state.appointments.find(row => row.id_cita === booked(key)?.appointment_id);
  return { state, frozen, service, options, booked, appointment, advance: instant => { fixtureNow = new Date(instant); },
    read: () => service.read(options),
    propose: payload => service.propose({ ...options, payload }),
    book: (sessions, extra = {}) => service.book({ ...options, payload: { request_key: `synthetic-booking-${state.requests.length}`,
      snapshot_sha256: frozen.sha256, sessions, ...extra } }) };
}
const session = (key, date) => ({ key, start_at: `${date}T09:00:00.000Z` });
async function resumePayload(f, key) { return { mode: 'resume', replan_from_key: key, expected_plan_revision: (await f.read()).plan_revision }; }

test('selectable suffix is position-based, preserves the prefix and retains the legacy interruption signal', () => {
  const p = purePlan(['completed', 'missed', 'pending', 'reserved']), before = clone(p);
  assert.equal(resumeInfo(p, now).from_key, 's1');
  assert.deepEqual(resumeSessions(p, 's2', now).map(row => row.key), ['s2', 's3']);
  assert.equal(resumeSelectionInfo(p, 's2', now).earlier_pending_count, 1);
  assert.deepEqual(resumeOptions(p, now).map(row => row.from_key), ['s1', 's2', 's3']);
  assert.deepEqual(p, before);
  const uninterrupted = purePlan(['pending', 'pending']);
  assert.equal(resumeInfo(uninterrupted, now), null);
  assert.deepEqual(resumeSessions(uninterrupted, 's1', now).map(row => row.key), ['s1']);
});
test('completed/consumed origins and later completed units remain protected', () => {
  const p = purePlan(['pending', 'completed', 'pending']);
  assert.equal(resumeSelectionInfo(p, 's1', now), null);
  assert.throws(() => resumeSessions(p, 's0', now), { code: 'program_resume_review_required' });
  assert.deepEqual(resumeSessions(p, 's2', now).map(row => row.key), ['s2']);
  p.sessions[2].record.consumption_movement_id = 9;
  assert.equal(resumeSelectionInfo(p, 's2', now), null);
});
test('attendance and communications blockers are limited to the affected suffix and malformed metadata fails closed', () => {
  const p = purePlan(['reserved', 'pending', 'reserved']);
  p.sessions[0].start_at = '2029-12-01T09:00:00Z'; p.sessions[0].appointment.import_metadata = {};
  assert.equal(resumeSelectionInfo(p, 's1', now).blocked_reason, null);
  p.sessions[2].appointment.import_metadata = '{bad';
  assert.match(resumeSelectionInfo(p, 's1', now).blocked_reason, /comunicaciones/);
  p.sessions[2].appointment.import_metadata = { automation_policy: 'hold' }; p.sessions[2].start_at = null;
  assert.match(resumeSelectionInfo(p, 's1', now).blocked_reason, /asistió/);
});
test('bounded suffixes can be selected without claiming that earlier pending units were performed', () => {
  const p = purePlan(Array(32).fill('pending'));
  assert.match(resumeSelectionInfo(p, 's0', now).blocked_reason, /treinta/);
  assert.equal(resumeSelectionInfo(p, 's2', now).affected_count, 30);
  assert.equal(resumeSelectionInfo(p, 's2', now).earlier_pending_count, 2);
});
test('manual and ordinary pending DTOs expose selectable origins without requiring a resume or inventing dates', async () => {
  for (const manual of [true, false]) {
    const f = fixture({ manual }), plan = await f.read();
    assert.equal(plan.resume, null); assert.equal(plan.can_schedule, true); assert.equal(plan.can_resume, true);
    assert.deepEqual(clone(plan.resume_options.map(row => row.from_key)), ['s0', 's1', 's2', 's3']);
    assert(plan.sessions.every(row => row.start_at === null));
    const preview = await f.propose({ from_date: '2030-01-07', days: 1, session_keys: ['s2'] });
    assert.equal(preview.proposals.length, 1);
    if (manual) { assert.equal(preview.proposals[0].solution, null); assert.equal(f.state.contexts.length, 0); }
    assert.equal(f.state.appointments.length, 0);
  }
});
test('manual resume retains old dates only as history and never constrains a new choice with an unchosen affected date', async () => {
  const f = fixture();
  await f.book([session('s0', '2030-01-07'), session('s1', '2030-01-14'), session('s3', '2030-01-22')]);
  const before = clone(f.state.appointments), resume = await resumePayload(f, 's2');
  const empty = await f.propose({ ...resume, from_date: '2030-01-29', days: 1 });
  assert.equal(empty.resume.from_key, 's2'); assert.deepEqual(clone(empty.resume.affected_keys), ['s2', 's3']);
  assert(empty.proposals.every(row => row.solution === null && row.reason_code === 'program_manual_date_required'));
  const proposed = await f.propose({ ...resume, from_date: '2030-01-29', days: 1, session_keys: ['s2'],
    manual_sessions: [{ key: 's2', start_local: '2030-01-29T10:00' }] });
  assert(proposed.proposals[0].solution); assert.equal(proposed.proposals[0].solution.start_at, '2030-01-29T09:00:00.000Z');
  assert.deepEqual(clone(f.state.appointments), before);
  await assert.rejects(f.book([session('s2', '2030-01-29')], resume), { code: 'program_resume_incomplete' });
});
test('manual selected resume books the entire suffix with real canonical snapshots and leaves an undated prefix pending', async () => {
  const f = fixture(), purchase = clone(f.state.voucher), frozen = clone(f.frozen), resume = await resumePayload(f, 's1');
  const result = await f.book([session('s1', '2030-01-14'), session('s2', '2030-01-21'), session('s3', '2030-01-28')], resume);
  assert.equal(result.sessions.length, 3); assert(result.sessions.every(row => row.action === 'created'));
  const plan = await f.read(); assert.equal(plan.sessions[0].scheduling_status, 'pending'); assert.equal(plan.sessions[0].appointment_id, null);
  assert.equal(f.booked('s0'), undefined); assert(f.state.appointments.every(row => bookingSegments(row.toJSON()).length === 2));
  assert.deepEqual(clone(f.state.voucher), purchase); assert.deepEqual(f.frozen, frozen); assert.equal(f.state.voucher.available_units, 4);
});
test('selected future reservations retain IDs and every prefix appointment/record/occupancy stays literally unchanged', async () => {
  const f = fixture({ manual: false });
  await f.book([session('s0', '2030-01-07'), session('s1', '2030-01-14'), session('s2', '2030-01-21'), session('s3', '2030-01-28')]);
  f.appointment('s0').nota = 'Synthetic human note';
  const prefix = clone([f.appointment('s0'), f.appointment('s1'), f.booked('s0'), f.booked('s1')]);
  const ids = [f.appointment('s2').id_cita, f.appointment('s3').id_cita], prefixIds = prefix.slice(0, 2).map(row => row.id_cita);
  const occupancy = clone(f.state.occupancies.filter(row => prefixIds.includes(row.appointment_id))), purchase = clone(f.state.voucher);
  const result = await f.book([session('s2', '2030-02-04'), session('s3', '2030-02-11')], await resumePayload(f, 's2'));
  assert.deepEqual(clone(result.sessions.map(row => row.appointment_id)), ids); assert(result.sessions.every(row => row.action === 'rescheduled'));
  assert.deepEqual(clone([f.appointment('s0'), f.appointment('s1'), f.booked('s0'), f.booked('s1')]), prefix);
  assert.deepEqual(clone(f.state.occupancies.filter(row => prefixIds.includes(row.appointment_id))), occupancy);
  assert.deepEqual(clone(f.state.voucher), purchase);
  assert(f.state.contexts.at(-1).ignored.every(id => ids.includes(id)));
});
test('past no-shows/cancellations and live notifications in the prefix are not normalized or moved', async () => {
  const f = fixture(); await f.book([session('s0', '2030-01-07'), session('s1', '2030-01-14')]);
  f.appointment('s0').estado = 'no_asistio'; f.appointment('s0').import_metadata.automation_policy = 'live';
  f.appointment('s1').estado = 'cancelada'; const before = clone([f.appointment('s0'), f.appointment('s1'), f.booked('s0'), f.booked('s1')]);
  await f.book([session('s2', '2030-02-04'), session('s3', '2030-02-11')], await resumePayload(f, 's2'));
  assert.deepEqual(clone([f.appointment('s0'), f.appointment('s1'), f.booked('s0'), f.booked('s1')]), before);
  assert.equal(f.state.voucher.available_units, 4);
});
test('full affected-set confirmation rejects missing/extra sessions and cannot write an earlier pending prefix', async () => {
  for (const keys of [['s2'], ['s0', 's2', 's3'], ['s2', 'unknown']]) {
    const f = fixture(), resume = await resumePayload(f, 's2');
    await assert.rejects(f.book(keys.map((key, index) => session(key, `2030-02-${String(4 + index * 7).padStart(2, '0')}`)), resume),
      { code: 'program_resume_incomplete' });
    assert.equal(f.state.records.length, 0); assert.equal(f.state.appointments.length, 0);
  }
});
test('plan CAS detects prefix changes, balance changes and snapshot mismatch before any booking mutation', async () => {
  for (const change of [f => { f.appointment('s0').nota = 'Later human edit'; }, f => { f.appointment('s0').inicio = '2030-01-08T09:00:00Z'; },
    f => { f.state.voucher.available_units = 3; }]) {
    const f = fixture(); await f.book([session('s0', '2030-01-07')]); const resume = await resumePayload(f, 's2'); change(f);
    const before = clone(f.state.appointments);
    await assert.rejects(f.book([session('s2', '2030-02-04'), session('s3', '2030-02-11')], resume), { code: 'program_resume_changed' });
    assert.deepEqual(clone(f.state.appointments), before); assert.equal(f.state.records.length, 1);
  }
  const f = fixture(); await assert.rejects(f.book([session('s3', '2030-02-04')], { ...await resumePayload(f, 's3'), snapshot_sha256: 'b'.repeat(64) }),
    { code: 'program_snapshot_changed' });
});
test('unaffected prior reservations constrain ordering, cadence, occupancy and available units', async () => {
  const f = fixture({ manual: false }); await f.book([session('s0', '2030-02-01')]);
  const resume = await resumePayload(f, 's1');
  await assert.rejects(f.book([session('s1', '2030-02-02'), session('s2', '2030-02-09'), session('s3', '2030-02-16')], resume),
    { code: 'program_cadence_conflict' });
  f.state.voucher.available_units = 3;
  await assert.rejects(f.book([session('s1', '2030-02-08'), session('s2', '2030-02-15'), session('s3', '2030-02-22')], await resumePayload(f, 's1')),
    { code: 'program_units_insufficient' });
  assert.equal(f.state.appointments.length, 1);
});
test('automatic fixed proposals revalidate exact selected staff, cabin, machine and patient without writes', async () => {
  for (const [kind, id] of [['doctor', 5], ['installation', 9], ['equipment', 11], ['patient', 1]]) {
    const f = fixture({ manual: false, machine: true, alternatives: true });
    const resume = await resumePayload(f, 's1');
    f.state.busy.push({ kind, id, start: '2030-01-08T09:00:00Z', end: '2030-01-08T10:00:00Z' });
    await assert.rejects(f.propose({ ...resume, from_date: '2030-01-15', days: 1, session_keys: ['s2'],
      fixed_sessions: [{ ...session('s1', '2030-01-08'), selections: { t1_p1: { doctor_id: 5, installation_id: 9 }, t1_p2: { doctor_id: 6, installation_id: 10 } } }] }),
      { code: 'program_fixed_session_unavailable' });
    assert.equal(f.state.appointments.length, 0); assert.equal(f.state.voucher.available_units, 4);
  }
});
test('automatic fixed proposals project machine turnaround as virtual occupancy, not just patient clocks', async () => {
  const f = fixture({ manual: false, machine: true, turnaround: 60, offsets: [0, 0, 0, 0] });
  const result = await f.propose({ ...await resumePayload(f, 's1'), from_date: '2030-01-08', days: 1, session_keys: ['s2'],
    fixed_sessions: [session('s1', '2030-01-08')] });
  assert.equal(result.proposals[0].solution.start_at, '2030-01-08T11:00:00.000Z');
  assert.equal(f.state.appointments.length, 0);
});
test('fixed proposals cannot claim an earlier prefix, unknown phases, duplicate keys or unknown selection fields', async () => {
  for (const fixed of [[session('s0', '2030-01-08')], [session('s1', '2030-01-08'), session('s1', '2030-01-09')],
    [{ ...session('s1', '2030-01-08'), selections: { unknown: { doctor_id: 5 } } }],
    [{ ...session('s1', '2030-01-08'), selections: { t1_p1: { doctor_ids: [5] } } }]]) {
    const f = fixture({ manual: false });
    await assert.rejects(f.propose({ ...await resumePayload(f, 's1'), from_date: '2030-01-15', days: 1, session_keys: ['s2'], fixed_sessions: fixed }));
    assert.equal(f.state.appointments.length, 0);
  }
});
test('fixed proposal validation preserves an ALL team and cannot narrow it to one participant', async () => {
  const f = fixture({ manual: false, machine: true, mandatoryTeam: true }), resume = await resumePayload(f, 's1');
  const base = { ...resume, from_date: '2030-01-15', days: 1, session_keys: ['s2'] };
  await assert.rejects(f.propose({ ...base, fixed_sessions: [{ ...session('s1', '2030-01-08'), selections: { t1_p2: { doctor_id: 6 } } }] }),
    { code: 'program_fixed_session_unavailable' });
  const result = await f.propose({ ...base, fixed_sessions: [{ ...session('s1', '2030-01-08'), selections: { t1_p2: { installation_id: 10 } } }] });
  assert.deepEqual(clone(result.proposals[0].solution.phases[1].doctor_ids), [6, 7]);
  assert.equal(f.state.appointments.length, 0);
});
test('completed and consumed prefix appointments/snapshots remain immutable while a later pending suffix is booked', async () => {
  const f = fixture(); await f.book([session('s0', '2030-01-07')]);
  f.advance('2030-01-08T00:00:00Z'); f.appointment('s0').estado = 'completada'; f.booked('s0').consumption_movement_id = 88;
  f.state.voucher.available_units = 3;
  const before = clone([f.appointment('s0'), f.booked('s0'), f.state.voucher]);
  const plan = await f.read(); assert(!plan.resume_options.some(row => row.from_key === 's0'));
  await f.book([session('s2', '2030-02-04'), session('s3', '2030-02-11')], await resumePayload(f, 's2'));
  assert.deepEqual(clone([f.appointment('s0'), f.booked('s0'), f.state.voucher]), before);
  assert.equal((await f.read()).sessions[1].scheduling_status, 'pending');
});
test('fixed manual proposals cannot hide an unchanged prior reservation or overwrite its phase choice', async () => {
  const f = fixture(); await f.book([session('s0', '2030-01-07')]);
  const before = clone([f.appointment('s0'), f.booked('s0')]);
  const result = await f.propose({ ...await resumePayload(f, 's1'), from_date: '2030-01-07', days: 1, session_keys: ['s1'],
    manual_sessions: [{ key: 's1', start_local: '2030-01-07T10:15' }] });
  assert.equal(result.proposals[0].solution, null);
  assert(!f.state.contexts.at(-1).ignored.includes(f.appointment('s0').id_cita));
  assert.deepEqual(clone([f.appointment('s0'), f.booked('s0')]), before);
});
test('selected resume cannot accept a presented budget, activate a purchase or trust client position/economic claims', async () => {
  const held = fixture(); held.state.budget.status = 'presented';
  await assert.rejects(held.book([session('s3', '2030-02-04')], await resumePayload(held, 's3')), { code: 'program_purchase_not_schedulable' });
  assert.equal(held.state.budget.status, 'presented'); assert.equal(held.state.appointments.length, 0);
  const f = fixture();
  await f.book([{ ...session('s3', '2030-02-04'), position: 0, consumption_movement_id: 88 }],
    { ...await resumePayload(f, 's3'), patient_id: 999, available_units: 999, total_price: 1 });
  assert.equal(f.booked('s3').position, 3); assert.equal(f.booked('s0'), undefined);
  assert.equal(f.appointment('s3').paciente_id, 1); assert.equal(f.state.voucher.available_units, 4); assert.equal(f.state.voucher.sold_amount, 120);
});
test('selected resume is atomic when a later resource is busy and idempotent only for the same origin and dates', async () => {
  const failed = fixture(), resume = await resumePayload(failed, 's2');
  failed.state.busy.push({ kind: 'doctor', id: 5, start: '2030-02-11T09:00:00Z', end: '2030-02-11T10:00:00Z' });
  await assert.rejects(failed.book([session('s2', '2030-02-04'), session('s3', '2030-02-11')], resume), { code: 'program_booking_unavailable' });
  assert.equal(failed.state.records.length, 0); assert.equal(failed.state.appointments.length, 0); assert.equal(failed.state.requests.length, 0);
  const f = fixture(), chosen = await resumePayload(f, 's2'), sessions = [session('s2', '2030-02-04'), session('s3', '2030-02-11')];
  const extra = { ...chosen, request_key: 'stable-selected-resume' }, result = await f.book(sessions, extra);
  const replay = await f.book(sessions, extra); assert.equal(replay.replayed, true); assert.deepEqual(clone(replay.sessions), clone(result.sessions));
  await assert.rejects(f.book(sessions, { ...extra, replan_from_key: 's1' }), { code: 'program_booking_request_conflict' });
  assert.equal(f.state.appointments.length, 2); assert.equal(f.state.voucher.available_units, 4);
});
test('relative gates and inactive purchases still block selected resume without changing economics', async () => {
  const off = fixture({ capabilities: { simple: true, multi: true, relativeSteps: false } }), plan = await off.read();
  assert.equal(plan.can_resume, false); assert.equal(plan.can_schedule, false);
  await assert.rejects(off.propose({ ...await resumePayload(off, 's2'), from_date: '2030-02-04', days: 1 }), { code: 'booking_profile_runtime_unavailable' });
  const inactive = fixture(); inactive.state.voucher.status = 'pending';
  await assert.rejects(inactive.book([session('s3', '2030-02-04')], await resumePayload(inactive, 's3')), { code: 'program_purchase_not_schedulable' });
  assert.equal(inactive.state.appointments.length, 0); assert.equal(inactive.state.voucher.status, 'pending');
});
