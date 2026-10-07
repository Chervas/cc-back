'use strict';

// Synthetic, offline service + canonical-command fixtures. No model index,
// credentials, database, patients or provider calls are loaded by this suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { normalizeBookingProfile, bookingProfileDurationMinutes } = require('../../lib/booking-profile');
const { solveBookingProfile } = require('../../lib/booking-profile-solver');
const { bookingSegments } = require('../../lib/appointment-booking-segments');

const serviceFile = require.resolve('../../services/patientVoucherAppointments.service');
const commandFile = require.resolve('../../services/appointmentBookingCommand.service');
const serviceRequire = createRequire(serviceFile);
const profileService = serviceRequire('./treatmentBookingProfile.service');
const Op = Object.fromEntries(['ne', 'in', 'notIn', 'or', 'lt', 'lte', 'gt'].map(key => [key, Symbol(key)]));
const clone = value => JSON.parse(JSON.stringify(value));
const payload = { start_at: '2030-01-07T10:00:00+01:00', count: 2, interval_days: 7 };
const phase = (key, doctor, room, offset = 0) => ({ key, label: `Paso sintético ${key}`, duration_minutes: 30,
  installation_ids: [room], professionals: { mode: 'any', ids: [doctor] }, start_offset_minutes: offset });
const relative = () => ({ version: 4, phases: [phase('draw', 5, 9), phase('apply', 6, 10, 15)] });
const legacy = version => ({ version, phases: relative().phases.map(({ start_offset_minutes, ...row }) => row) });
const free = () => ({ windows: [{ start: '2030-01-01T00:00:00Z', end: '2030-03-01T00:00:00Z' }], busy: [],
  schedule_verified: true, absence_windows: [], clinic_id: 72 });

function loadModule(filename, overrides) {
  const actualRequire = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, console, Date, Map, Set, Promise,
    require: name => Object.hasOwn(overrides, name) ? overrides[name] : actualRequire(name),
  }, { filename });
  return module.exports;
}

function fixture({ profile = relative(), duration = 90, expiresAt = null, reserved = [], consumed = [],
  alternativesByDate = false, capabilities = { simple: true, multi: true, relativeSteps: true },
  solve = solveBookingProfile, voucherStatus = 'active', sourceSystem = null } = {}) {
  const state = { appointments: [...reserved], occupancies: [], automation: [], selections: [], contexts: [], commits: 0, rollbacks: 0 };
  let nextId = 100;
  const clinic = { id_clinica: 72, grupoClinicaId: 29, configuracion: { timezone: 'Europe/Madrid' }, equipment_booking_enabled: true };
  const treatment = { id_tratamiento: 3, nombre: 'Visita sintética combinada', origen: 'clinica', clinica_id: 72, activo: true,
    duracion_min: duration, clinical_config: { catalog_status: 'active', ...(profile ? { booking_profile: profile } : {}) } };
  const voucher = { id: 1, public_id: 'synthetic-combined-voucher', clinic_id: 72, patient_id: 1, treatment_id: 3,
    status: voucherStatus, total_units: 5, available_units: '5.00', sold_amount: '225.00', unit_label: 'sesiones',
    source_system: sourceSystem, expires_at: expiresAt, name: 'Bono sintético' };
  const purchaseBefore = clone(voucher);
  const forbiddenEconomicWrite = async () => { throw Error('Booking cannot change a purchase, activation, price, budget or movement'); };
  const rows = transaction => [...state.appointments, ...(transaction?.pendingAppointments || [])];
  const db = {
    Sequelize: { Op },
    sequelize: { transaction: async (options, callback) => {
      if (typeof options === 'function') { callback = options; options = {}; }
      const transaction = { options, LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' }, pendingAppointments: [], pendingOccupancies: [] };
      try {
        const result = await callback(transaction);
        state.appointments.push(...transaction.pendingAppointments); state.occupancies.push(...transaction.pendingOccupancies);
        state.commits++; return result;
      } catch (error) { state.rollbacks++; throw error; }
    } },
    PatientVoucher: { findOne: async () => voucher, update: forbiddenEconomicWrite, create: forbiddenEconomicWrite },
    PatientVoucherMovement: { findAll: async () => consumed.map(appointment_id => ({ appointment_id })), create: forbiddenEconomicWrite },
    EconomicBudget: { update: forbiddenEconomicWrite, create: forbiddenEconomicWrite },
    Clinica: { findByPk: async () => clinic },
    Tratamiento: { findByPk: async () => treatment },
    DoctorClinica: { findOne: async () => ({ activo: true, recibe_citas: true }) },
    Instalacion: { findOne: async () => ({ activo: true }) },
    CitaPaciente: {
      findAll: async ({ where, transaction }) => rows(transaction).filter(row => !where.voucher_id || row.voucher_id === where.voucher_id)
        .filter(row => row.estado !== 'cancelada'),
      create: async (values, { transaction }) => {
        assert(transaction); const appointment = { id_cita: nextId++, ...clone(values) };
        transaction.pendingAppointments.push(appointment); return appointment;
      },
    },
    AppointmentBookingResource: { upsert: async () => {}, findByPk: async () => ({}) },
    AppointmentBookingOccupancy: {
      destroy: async () => {},
      bulkCreate: async (records, { transaction }) => transaction.pendingOccupancies.push(...clone(records)),
    },
  };
  const availability = {
    resolveInstallationKeys: async ({ installationIds }) => ({ keys: new Map(installationIds.map(id => [id, `installation:${id}`])) }),
    loadBookingContext: async args => {
      state.contexts.push({ start: new Date(args.start).toISOString(), end: new Date(args.end).toISOString(), transaction: args.transaction });
      const doctors = new Map([5, 6, 7].map(id => [id, { ...free(), name: `Profesional sintético ${id}` }]));
      const installations = new Map([9, 10].map(id => [id, { ...free(), resource_key: `installation:${id}`, name: `Sala sintética ${id}` }]));
      if (alternativesByDate) {
        doctors.get(7).busy.push({ start: '2030-01-07T09:00:00Z', end: '2030-01-07T10:00:00Z' });
        doctors.get(5).busy.push({ start: '2030-01-14T09:00:00Z', end: '2030-01-14T10:00:00Z' });
      }
      for (const row of [...state.occupancies, ...(args.transaction?.pendingOccupancies || [])]) {
        const resource = row.resource_kind === 'doctor' ? doctors.get(row.doctor_id) : installations.get(row.installation_id);
        resource?.busy.push({ start: row.start_at, end: row.end_at });
      }
      const equipment = new Map([[11, { id: 11, name: 'Equipo sintético', status: 'available', installation_ids: new Set([9]),
        turnaround_minutes: 0, busy: [], attention_policy: { mode: 'continuous', patient_preparation_minutes: 0 } }]]);
      return { doctors, installations, equipment, patientBusy: [], timeZone: 'Europe/Madrid' };
    },
  };
  const boundedProfileService = { ...profileService, bookingCapabilities: () => capabilities,
    requireOperationalProfile: (row, options = {}) => profileService.requireOperationalProfile(row, { capabilities, ...options }) };
  const command = loadModule(commandFile, {
    './appointmentBookingAvailability.service': availability, './treatmentBookingProfile.service': boundedProfileService,
  });
  const service = loadModule(serviceFile, {
    sequelize: { Op }, '../../models': db,
    './appointmentAutomationV2Runtime.service': {
      enqueueExecutionForCita: async row => state.automation.push(['enqueue', row.id_cita]),
      syncScheduledTriggersForCita: async row => state.automation.push(['sync', row.id_cita]),
    },
    './treatmentBookingProfile.service': boundedProfileService,
    './appointmentBookingAvailability.service': availability,
    '../lib/booking-profile-solver': { solveBookingProfile: solve },
    './appointmentBookingCommand.service': { mutateAppointmentBooking: async args => {
      state.selections.push(clone(args.selections)); return command.mutateAppointmentBooking(args);
    } },
  });
  return { service, state, voucher, purchaseBefore, treatment, profile,
    preview: (changes = {}) => service.preview({ publicId: voucher.public_id, payload: { ...payload, ...changes } }),
    create: (changes = {}) => service.create({ publicId: voucher.public_id, actorId: 1, payload: { ...payload, ...changes } }) };
}

test('combined voucher preview uses v4 span and exact solution clocks, not phase sum or catalog duration', async () => {
  const f = fixture(), plan = await f.preview();
  assert.equal(plan.configuration.duration_minutes, 45);
  assert.equal(plan.has_conflicts, false);
  assert.equal(plan.appointments[0].start_at, '2030-01-07T09:00:00.000Z');
  assert.equal(plan.appointments[0].end_at, '2030-01-07T09:45:00.000Z');
  assert.deepEqual(clone(plan.appointments[0].phases.map(row => row.start_offset_minutes)), [0, 15]);
  assert.equal(plan.appointments[0].phases[1].start_at, '2030-01-07T09:15:00.000Z');
  assert.equal(plan.appointments[0].capacity_fully_verified, true);
  assert.equal(f.state.contexts.length, 1);
  assert.equal(f.state.contexts[0].end, '2030-01-14T09:45:00.000Z');
  assert(!Object.hasOwn(plan, 'selectionsBySequence'));
  assert.deepEqual(f.voucher, f.purchaseBefore); assert.equal(f.state.appointments.length, 0);
});

test('out-of-time-order v4 phases retain declared identity and use max(offset + duration)', async () => {
  const profile = relative(); profile.phases.reverse();
  const f = fixture({ profile }), plan = await f.preview({ count: 1 });
  assert.equal(plan.configuration.duration_minutes, 45);
  assert.deepEqual(clone(plan.appointments[0].phases.map(row => row.key)), ['apply', 'draw']);
  assert.deepEqual(clone(plan.appointments[0].phases.map(row => row.start_offset_minutes)), [15, 0]);
  await f.create({ count: 1 });
  assert.equal(bookingSegments(f.state.appointments[0]).length, 2);
  assert.equal(f.state.appointments[0].fin, '2030-01-07T09:45:00.000Z');
});

for (const version of [1, 2, 3]) test(`voucher profile v${version} keeps sequential duration and snapshots`, async () => {
  const f = fixture({ profile: legacy(version) }), plan = await f.preview({ count: 1 });
  assert.equal(plan.configuration.duration_minutes, 60);
  assert.equal(plan.appointments[0].end_at, '2030-01-07T10:00:00.000Z');
  assert.equal(plan.appointments[0].phases[1].start_at, '2030-01-07T09:30:00.000Z');
  assert(!Object.hasOwn(plan.appointments[0], 'capacity_fully_verified'));
  await f.create({ count: 1 });
  assert.equal(f.state.appointments[0].import_metadata.booking.profile.version, version);
  assert.equal(bookingSegments(f.state.appointments[0]).length, 2);
  assert.deepEqual(f.voucher, f.purchaseBefore);
});

test('v3 partial staff attention and the canonical snapshot survive a combined voucher booking', async () => {
  const profile = legacy(3);
  profile.phases[0].equipment_requirements = [{ equipment_ids: [11] }];
  profile.phases[0].staff_attention = [{ mode: 'start_end', start_minutes: 5, start_window_minutes: 15, end_minutes: 5, end_window_minutes: 15 }];
  const f = fixture({ profile });
  const plan = await f.preview({ count: 1 }); await f.create({ count: 1 });
  const snapshot = f.state.appointments[0].import_metadata.booking;
  assert.equal(plan.configuration.duration_minutes, 60); assert.equal(snapshot.profile.version, 3);
  assert.deepEqual(clone(snapshot.phases[0].staff_intervals), clone(plan.appointments[0].phases[0].staff_intervals));
  assert.deepEqual(snapshot.phases[0].staff_intervals.map(row => row.kind), ['start', 'end']);
  assert.equal(bookingSegments(f.state.appointments[0]).length, 2);
});

test('fixed combined geometry does not stretch to a conflicting explicit total duration', async () => {
  const f = fixture(), plan = await f.preview({ count: 1, duration_minutes: 60 });
  assert.equal(plan.has_conflicts, true); assert.equal(plan.appointments[0].conflicts[0].code, 'BOOKING_UNAVAILABLE');
  await assert.rejects(f.create({ count: 1, duration_minutes: 60 }), { code: 'voucher_schedule_conflicts' });
  assert.equal(f.state.appointments.length, 0); assert.equal(f.state.automation.length, 0);
  assert.deepEqual(f.voucher, f.purchaseBefore);
});

test('v4 voucher expiry uses the actual visit span, not the sequential phase sum', async () => {
  const allowed = fixture({ expiresAt: '2030-01-07T09:50:00Z' });
  assert.equal((await allowed.preview({ count: 1 })).has_conflicts, false);
  await allowed.create({ count: 1 });
  const expired = fixture({ expiresAt: '2030-01-07T09:40:00Z' });
  assert.equal((await expired.preview({ count: 1 })).appointments[0].conflicts[0].code, 'VOUCHER_EXPIRED');
  await assert.rejects(expired.create({ count: 1 }), { code: 'voucher_schedule_conflicts' });
  assert.equal(expired.state.appointments.length, 0);
});

function alternatingFixture() {
  const profile = relative();
  profile.phases[0].professionals = { mode: 'any', ids: [5, 7], preferred_id: 5, fallback_when: 'unavailable' };
  const selections = {
    1: { draw: { doctor_id: 5, installation_id: 9 }, apply: { doctor_id: 6, installation_id: 10 } },
    2: { draw: { doctor_id: 7, installation_id: 9 }, apply: { doctor_id: 6, installation_id: 10 } },
  };
  return { ...fixture({ profile, alternativesByDate: true }), selections };
}

test('series confirmation preserves the exact per-date alternatives and one reservation per visit', async () => {
  const f = alternatingFixture(), args = { booking_selections_by_sequence: f.selections, booking_priority_acknowledged: true };
  const plan = await f.preview(args), result = await f.create(args);
  assert.equal(plan.has_conflicts, false); assert.equal(plan.appointments[1].requires_priority_acknowledgement, true);
  assert.equal(result.created.length, 2); assert.equal(f.state.appointments.length, 2);
  assert.deepEqual(f.state.selections, [f.selections[1], f.selections[2]]);
  assert.deepEqual(f.state.appointments.map(row => row.import_metadata.booking.phases[0].doctor_ids), [[5], [7]]);
  assert(f.state.appointments.every(row => row.voucher_id === 1 && row.tratamiento_id === 3));
  assert(f.state.appointments.every(row => bookingSegments(row).length === 2));
  assert.equal(f.state.automation.filter(([kind]) => kind === 'enqueue').length, 2);
  assert.deepEqual(f.voucher, f.purchaseBefore);
  const remaining = await f.preview({ count: 1 });
  assert.equal(remaining.voucher.reserved_units, 2); assert.equal(remaining.voucher.available_to_schedule, 3);
  // Two clinical steps do not double either reservation or the unit balance.
  assert.equal(remaining.voucher.available_units, 5);
});

test('a non-priority date still requires explicit acknowledgement and rolls back the whole series', async () => {
  const f = alternatingFixture();
  await assert.rejects(f.create({ booking_selections_by_sequence: f.selections }), { code: 'booking_priority_confirmation_required' });
  assert.equal(f.state.rollbacks, 1); assert.equal(f.state.commits, 0);
  assert.equal(f.state.appointments.length, 0); assert.equal(f.state.automation.length, 0);
  assert.deepEqual(f.voucher, f.purchaseBefore);
});

test('mandatory ALL teams are preserved without narrowing them to doctor_ids[0]', async () => {
  const profile = relative(); profile.phases[1].professionals = { mode: 'all', ids: [6, 7] };
  const f = fixture({ profile });
  const selections = { draw: { doctor_id: 5, installation_id: 9 }, apply: { installation_id: 10 } };
  const args = { booking_selections_by_sequence: { 1: selections, 2: selections } };
  const plan = await f.preview(args); await f.create(args);
  assert.deepEqual(clone(plan.appointments[0].phases[1].doctor_ids), [6, 7]);
  assert(f.state.appointments.every(row => row.import_metadata.booking.phases[1].doctor_ids.join(',') === '6,7'));
  assert.equal(f.state.occupancies.filter(row => row.resource_kind === 'doctor' && row.phase_key === 'apply').length, 4);
  const narrowed = fixture({ profile });
  assert.equal((await narrowed.preview({ count: 1, booking_selection: { apply: { doctor_id: 6, installation_id: 10 } } })).has_conflicts, true);
  await assert.rejects(narrowed.create({ count: 1, booking_selection: { apply: { doctor_id: 6 } } }), { code: 'voucher_schedule_conflicts' });
  assert.equal(narrowed.state.appointments.length, 0);
});

test('legacy common selection remains common to preview and every canonical create', async () => {
  const f = fixture({ profile: legacy(1) });
  const selection = { draw: { doctor_id: 5, installation_id: 9 }, apply: { doctor_id: 6, installation_id: 10 } };
  assert.equal((await f.preview({ booking_selection: selection })).has_conflicts, false);
  await f.create({ booking_selection: selection });
  assert.deepEqual(f.state.selections, [selection, selection]);
});

test('per-sequence selections reject ambiguity, malformed keys, missing dates and unsafe records before solving', async () => {
  const invalidMaps = [null, undefined, [], {}, { 1: {} }, { 1: {}, 2: {}, 3: {} }, { '01': {}, 2: {} },
    { 0: {}, 2: {} }, { '-1': {}, 2: {} }, { '1.0': {}, 2: {} }, { '1e0': {}, 2: {} },
    JSON.parse('{"1":{},"__proto__":{}}'), JSON.parse('{"1":{},"constructor":{}}'),
    Object.assign(Object.create({ 1: {} }), { 2: {} }), new Map([[1, {}], [2, {}]])];
  for (const value of invalidMaps) {
    const f = fixture();
    await assert.rejects(f.preview({ booking_selections_by_sequence: value }), { code: 'voucher_schedule_selection_invalid' });
    assert.equal(f.state.contexts.length, 0); assert.equal(f.state.appointments.length, 0);
  }
  const ambiguous = fixture();
  await assert.rejects(ambiguous.create({ booking_selection: {}, booking_selections_by_sequence: { 1: {}, 2: {} } }),
    { code: 'voucher_schedule_selection_invalid' });
  assert.equal(ambiguous.state.appointments.length, 0);
});

test('phase selections validate actual profile keys, allowed fields and positive resource IDs', async () => {
  const invalidChoices = [{ nonexistent: {} }, { draw: null }, { draw: [] }, { draw: { doctor_ids: [5] } },
    { draw: { equipment_id: 11 } }, { draw: { doctor_id: null } }, { draw: { doctor_id: undefined } },
    { draw: { doctor_id: true } }, { draw: { doctor_id: 0 } }, { draw: { doctor_id: -1 } },
    { draw: { doctor_id: 1.5 } }, { draw: { doctor_id: '5x' } }, { draw: { doctor_id: '' } },
    JSON.parse('{"draw":{"__proto__":{}}}'), JSON.parse('{"constructor":{}}'),
    { draw: Object.create({ doctor_id: 5 }) }];
  for (const value of invalidChoices) {
    const f = fixture();
    await assert.rejects(f.preview({ booking_selections_by_sequence: { 1: value, 2: {} } }),
      { code: 'voucher_schedule_selection_invalid' });
    await assert.rejects(f.preview({ booking_selection: value }), { code: 'voucher_schedule_selection_invalid' });
    assert.equal(f.state.contexts.length, 0); assert.equal(f.state.appointments.length, 0);
  }
  let getterCalls = 0;
  const getter = { get draw() { getterCalls++; return {}; } };
  const f = fixture();
  await assert.rejects(f.preview({ booking_selection: getter }), { code: 'voucher_schedule_selection_invalid' });
  assert.equal(getterCalls, 0);
});

test('resource eligibility remains authoritative in the solver after shape validation', async () => {
  for (const selection of [{ draw: { doctor_id: 99 } }, { draw: { installation_id: 99 } }]) {
    const f = fixture();
    assert.equal((await f.preview({ count: 1, booking_selection: selection })).has_conflicts, true);
    await assert.rejects(f.create({ count: 1, booking_selection: selection }), { code: 'voucher_schedule_conflicts' });
    assert.equal(f.state.appointments.length, 0);
  }
});

test('a no-profile legacy voucher keeps explicit catalog duration, never invents30, and cannot introduce a phase map', async () => {
  for (const [duration, expected] of [[25, 25]]) {
    const f = fixture({ profile: null, duration });
    const plan = await f.preview({ count: 1 });
    assert.equal(plan.configuration.duration_minutes, expected);
    assert(!Object.hasOwn(plan.appointments[0], 'phases'));
    await assert.rejects(f.preview({ count: 1, booking_selections_by_sequence: { 1: {} } }),
      { code: 'voucher_schedule_selection_invalid' });
  }
  const unknown = fixture({ profile: null, duration: null });
  await assert.rejects(unknown.preview({ count: 1 }), { code: 'booking_duration_required', statusCode: 422 });
  assert.equal((await unknown.preview({ count: 1, duration_minutes: 45 })).configuration.duration_minutes, 45);
  assert.equal(unknown.state.appointments.length, 0);
});

test('partial capacity or noncanonical solution clocks cannot become a bookable v4 preview', async () => {
  for (const change of [solution => { solution.capacity_fully_verified = false; },
    solution => { delete solution.capacity_fully_verified; }, solution => { delete solution.attention_requirements_pending; },
    solution => { solution.attention_requirements_pending = [{ phase_key: 'draw', key: 'check', label: 'Pendiente sintético' }]; },
    solution => { delete solution.start_at; },
    solution => { solution.start_at = '2030-01-07T09:05:00.000Z'; },
    solution => { solution.end_at = '2030-01-07T10:00:00.000Z'; }]) {
    const f = fixture({ solve: args => { const solution = solveBookingProfile(args); change(solution); return solution; } });
    const plan = await f.preview({ count: 1 }); assert.equal(plan.has_conflicts, true);
    assert(!Object.hasOwn(plan.appointments[0], 'phases'));
    await assert.rejects(f.create({ count: 1 }), { code: 'voucher_schedule_conflicts' });
    assert.equal(f.state.appointments.length, 0); assert.deepEqual(f.voucher, f.purchaseBefore);
  }
});

test('pending attention and closed relative-writer gates remain blockers with zero purchase or booking writes', async () => {
  const profile = relative(); profile.phases[0].attention_requirements_pending = [{ key: 'check', label: 'Comprobación aún no cuantificada' }];
  const pending = fixture({ profile });
  await assert.rejects(pending.preview(), { code: 'pending_attention_requirements' });
  await assert.rejects(pending.create(), { code: 'pending_attention_requirements' });
  const closed = fixture({ capabilities: { simple: true, multi: true, relativeSteps: false } });
  await assert.rejects(closed.preview(), { code: 'booking_profile_runtime_unavailable' });
  await assert.rejects(closed.create(), { code: 'booking_profile_runtime_unavailable' });
  for (const f of [pending, closed]) {
    assert.equal(f.state.contexts.length, 0); assert.equal(f.state.appointments.length, 0);
    assert.deepEqual(f.voucher, f.purchaseBefore);
  }
});

test('booking does not activate pending purchases, change no-show reservation policy or count phases as units', async () => {
  const reserved = [{ id_cita: 42, voucher_id: 1, estado: 'no_asistio' }, { id_cita: 43, voucher_id: 1, estado: 'completada' }];
  const f = fixture({ reserved, consumed: [43], voucherStatus: 'pending' });
  const plan = await f.preview({ count: 1 });
  assert.equal(plan.voucher.reserved_units, 1); assert.equal(plan.voucher.available_to_schedule, 4);
  await f.create({ count: 1 });
  assert.equal(f.state.appointments.length, 3); assert.deepEqual(f.voucher, f.purchaseBefore);
  assert.equal(f.voucher.status, 'pending');
});

test('purchase identity stays original while each newly booked combined appointment freezes its own profile', async () => {
  const f = fixture(); await f.create({ count: 1 });
  const before = clone(f.state.appointments[0]);
  f.treatment.clinical_config.booking_profile.phases[0].duration_minutes = 50;
  assert.equal(bookingProfileDurationMinutes(normalizeBookingProfile(f.treatment.clinical_config.booking_profile)), 50);
  assert.deepEqual(f.state.appointments[0], before);
  assert.equal(f.state.appointments[0].import_metadata.booking.profile.phases[0].duration_minutes, 30);
  assert.deepEqual(f.voucher, f.purchaseBefore); assert.equal(f.voucher.treatment_id, 3);
});
