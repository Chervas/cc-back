'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBookingProfile } = require('../../lib/booking-profile');
const { solveBookingProfile, occupancyForSolution } = require('../../lib/booking-profile-solver');
const { bookingCapabilities, requireOperationalProfile } = require('../../services/treatmentBookingProfile.service');
const { loadBookingContext, searchTreatmentSlots } = require('../../services/appointmentBookingAvailability.service');
const { mutateAppointmentBooking } = require('../../services/appointmentBookingCommand.service');
const { bookingSegments } = require('../../lib/appointment-booking-segments');
const fs = require('node:fs');
const path = require('node:path');

const capabilities = { simple: true, multi: true };
const Op = Object.fromEntries(['ne', 'in', 'or', 'lt', 'lte', 'gt'].map((key) => [key, Symbol(key)]));
const hours = Array.from({ length: 7 }, (_, dia_semana) => ({ dia_semana, activo: true, hora_inicio: '08:00', hora_fin: '20:00', excepciones: [] }));
const phase = (key, installations = [9], doctors = [5], mode = 'any') => ({ key, duration_minutes: 30, installation_ids: installations,
  professionals: { mode, ids: doctors, preferred_id: mode === 'any' ? doctors[0] : null } });
const profile = (...phases) => normalizeBookingProfile({ version: 1, phases });
const start = '2030-01-07T09:00:00.000Z';
const end = '2030-01-07T09:30:00.000Z';
const free = (busy = []) => ({ windows: [{ start: '2030-01-07T07:00:00Z', end: '2030-01-07T19:00:00Z' }], busy });

function matches(row, where = {}) {
  return Reflect.ownKeys(where).every((key) => {
    if (key === Op.or) return where[key].some((condition) => matches(row, condition));
    const condition = where[key];
    const value = row[key];
    if (condition && typeof condition === 'object' && !(condition instanceof Date)) {
      return Reflect.ownKeys(condition).every((operator) => {
        const expected = condition[operator];
        if (operator === Op.in) return expected.map(String).includes(String(value));
        if (operator === Op.ne) return String(value) !== String(expected);
        const left = new Date(value).getTime();
        const right = new Date(expected).getTime();
        if (operator === Op.lt) return left < right;
        if (operator === Op.lte) return left <= right;
        if (operator === Op.gt) return left > right;
        throw new Error('unimplemented offline operator');
      });
    }
    return String(value) === String(condition);
  });
}

function fixture({ bookingProfile = profile(phase('one')), failOccupancy = false, appointments = [], occupancies = [], aliases = [] } = {}) {
  const state = { appointments: [...appointments], occupancies: [...occupancies], commits: 0, rollbacks: 0, calls: [], locks: [], persists: 0 };
  let id = 100;
  let txId = 0;
  const mutexes = new Map();
  const clinic = { id_clinica: 72, grupoClinicaId: 2, configuracion: { timezone: 'Europe/Madrid' } };
  const clinics = [clinic, { id_clinica: 73, grupoClinicaId: 2 }];
  const installations = [9, 10, 12].map((installationId) => ({ id: installationId, clinica_id: 72, activo: true, horarios: hours, clinica: clinic }));
  installations.push({ id: 19, clinica_id: 73, activo: true, horarios: hours, clinica: clinics[1] });
  const query = (name, rows, options) => { state.calls.push([name, options]); return rows.filter((row) => matches(row, options.where)); };
  const allAppointments = (tx) => [...state.appointments.filter((row) => !tx?.replacements.has(row.id_cita)), ...(tx?.pending || [])];
  const allOccupancies = (tx) => [...state.occupancies.filter((row) => !tx?.deleted.has(row.appointment_id)), ...(tx?.occupancies || [])];
  const db = {
    Sequelize: { Op },
    sequelize: { transaction: async (options, callback) => {
      const tx = { id: ++txId, options, LOCK: { UPDATE: 'UPDATE' }, pending: [], occupancies: [], deleted: new Set(), replacements: new Set(), release: new Map() };
      try {
        const result = await callback(tx);
        state.appointments = [...state.appointments.filter((row) => !tx.replacements.has(row.id_cita)), ...tx.pending];
        state.occupancies = [...state.occupancies.filter((row) => !tx.deleted.has(row.appointment_id)), ...tx.occupancies];
        state.commits++;
        return result;
      } catch (error) { state.rollbacks++; throw error; }
      finally { tx.release.forEach((release) => release()); }
    } },
    Clinica: { findByPk: async (value) => clinics.find((row) => row.id_clinica === Number(value)) },
    Tratamiento: { findByPk: async () => ({ id_tratamiento: 3, clinica_id: 72, origen: 'clinica', activo: true, clinical_config: { booking_profile: bookingProfile } }) },
    DoctorClinica: { findAll: async (options) => query('doctors', [5, 6].map((doctorId) => ({ doctor_id: doctorId, clinica_id: 72, activo: true, recibe_citas: true, horarios: hours })), options) },
    DoctorHorario: {}, DoctorHorarioExcepcion: {}, InstalacionHorario: {}, DoctorBloqueoExcepcion: {},
    Instalacion: { findAll: async (options) => query('installations', installations, options) },
    ClinicaHorario: { findAll: async (options) => { state.calls.push(['hours', options]); return hours; } },
    DoctorBloqueo: { findAll: async (options) => { state.calls.push(['blocks', options]); return []; } },
    InstalacionBloqueo: { findAll: async (options) => { state.calls.push(['cab-blocks', options]); return []; } },
    InstallationPhysicalAlias: { findAll: async (options) => query('aliases', aliases, options) },
    AppointmentBookingResource: {
      upsert: async (row, { transaction: tx }) => {
        if (tx.release.has(row.resource_key)) return;
        const previous = mutexes.get(row.resource_key) || Promise.resolve();
        let release;
        const current = new Promise((resolve) => { release = resolve; });
        mutexes.set(row.resource_key, current);
        await previous;
        tx.release.set(row.resource_key, release);
        state.locks.push([tx.id, row.resource_key]);
      },
      findByPk: async () => ({}),
    },
    CitaPaciente: {
      findAll: async (options) => query('appointments', allAppointments(options.transaction), options),
      findByPk: async (appointmentId, options = {}) => allAppointments(options.transaction).find((row) => row.id_cita === Number(appointmentId)),
    },
    AppointmentBookingOccupancy: {
      findAll: async (options) => query('occupancies', allOccupancies(options.transaction).filter((row) => !options.include
        || allAppointments(options.transaction).some((appointment) => appointment.id_cita === row.appointment_id && appointment.estado !== 'cancelada')), options),
      destroy: async ({ where, transaction: tx }) => { tx.deleted.add(Number(where.appointment_id)); tx.occupancies = tx.occupancies.filter((row) => row.appointment_id !== Number(where.appointment_id)); },
      bulkCreate: async (rows, { transaction: tx }) => { if (failOccupancy) throw new Error('offline simulated occupancy failure'); tx.occupancies.push(...rows); },
    },
  };
  const persist = async ({ values, existing, transaction: tx }) => {
    state.persists++;
    if (existing) tx.replacements.add(existing.id_cita);
    const appointment = { ...values, id_cita: existing?.id_cita || ++id };
    tx.pending.push(appointment);
    return appointment;
  };
  const values = { clinica_id: 72, paciente_id: 1, tratamiento_id: 3, doctor_id: 5, instalacion_id: 9, inicio: start, fin: end, estado: 'pendiente' };
  return { db, state, clinic, values, persist, reserve: (overrides = {}) => mutateAppointmentBooking({ db, appointmentValues: values, persist, capabilities, ...overrides }) };
}

test('flags are closed by default; incomplete rollout cannot create advanced bookings', () => {
  assert.deepEqual(bookingCapabilities({}), { simple: false, multi: false });
  const treatment = { clinical_config: { booking_profile: profile(phase('one'), phase('two')) } };
  assert.throws(() => requireOperationalProfile(treatment, { capabilities: { simple: true, multi: false } }), { code: 'booking_profile_runtime_unavailable' });
});

test('solver prefers primary, uses a secondary only when needed and reports the actual alternatives', () => {
  const input = { profile: profile(phase('one', [9, 12], [5, 6])), start,
    doctors: new Map([[5, free([{ start, end }])], [6, free()]]), installations: new Map([[9, free()], [12, free()]]) };
  const solution = solveBookingProfile(input);
  assert.deepEqual(solution.phases[0].doctor_ids, [6]);
  assert.equal(solution.warnings[0].only_available_alternative, true);
  assert.equal(solution.warnings[0].preferred_available, false);
  input.doctors.set(5, free());
  assert.deepEqual(solveBookingProfile(input).phases[0].doctor_ids, [5]);
  assert.equal(solveBookingProfile(input).warnings.length, 0);
});

test('phases are sequential; ALL reserves both clinicians for the whole appointment', () => {
  const input = { profile: profile(phase('one', [9], [5, 6], 'all'), phase('two', [12], [5])), start,
    doctors: new Map([[5, free()], [6, free()]]), installations: new Map([[9, free()], [12, free()]]) };
  const solution = solveBookingProfile(input);
  assert.equal(solution.end_at, '2030-01-07T10:00:00.000Z');
  assert.equal(solution.phases[1].start_at, end);
  const rows = occupancyForSolution(solution);
  assert(rows.some((row) => row.doctor_id === 6 && row.start_at === start && row.end_at === solution.end_at));
  input.doctors.set(6, free([{ start: end, end: solution.end_at }]));
  assert.equal(solveBookingProfile(input), null, 'ALL must not pretend staff is free outside its named phase');
});

test('two simultaneous writers for an empty slot serialize on anchors, then one fails', async () => {
  const f = fixture();
  const results = await Promise.allSettled([f.reserve(), f.reserve()]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.find((result) => result.status === 'rejected').reason.code, 'booking_unavailable');
  assert.equal(f.state.appointments.length, 1);
  assert.equal(f.state.occupancies.length, 2);
  assert.equal(f.state.commits, 1);
  assert.equal(f.state.rollbacks, 1);
  assert.deepEqual(f.state.locks.filter(([tx]) => tx === 1).map(([, key]) => key), ['doctor:5', 'installation:9']);
});

test('occupancy failure rolls the canonical appointment back too; no partial reservation', async () => {
  const f = fixture({ failOccupancy: true });
  await assert.rejects(f.reserve(), /simulated occupancy failure/);
  assert.equal(f.state.appointments.length, 0);
  assert.equal(f.state.occupancies.length, 0);
  assert.equal(f.state.rollbacks, 1);
});

test('rescheduling without explicit resources retains the locked current professional, not a stale controller copy', async () => {
  const f = fixture({ bookingProfile: profile(phase('one', [9], [5, 6])) });
  const original = await f.reserve({ appointmentValues: { ...f.values, doctor_id: 6 }, priorityAcknowledged: true });
  const moved = await f.reserve({ existingAppointmentId: original.id_cita,
    appointmentValues: { inicio: '2030-01-07T10:00:00Z', fin: '2030-01-07T10:30:00Z' }, priorityAcknowledged: true });
  assert.equal(moved.doctor_id, 6);
  assert.equal(moved.instalacion_id, 9);
  assert.equal(f.state.appointments.length, 1);
  assert.equal(f.state.occupancies.length, 2);
  const controller = fs.readFileSync(path.resolve(__dirname, '../../controllers/citas.controller.js'), 'utf8');
  assert.match(controller, /nextDoctorIdRaw !== undefined \? \{ doctor_id: nextDoctorId \} : \{\}/);
  assert.match(controller, /nextInstalacionIdRaw !== undefined \? \{ instalacion_id: nextInstalacionId \} : \{\}/);
});

test('failed reschedule restores the prior appointment range and all original occupancy', async () => {
  const bookingProfile = profile(phase('one'));
  const solution = solveBookingProfile({ profile: bookingProfile, start, doctors: new Map([[5, free()]]), installations: new Map([[9, free()]]) });
  const old = { id_cita: 22, clinica_id: 72, paciente_id: 1, tratamiento_id: 3, doctor_id: 5, instalacion_id: 9,
    inicio: start, fin: end, estado: 'pendiente', import_metadata: { booking: { version: 1, profile: bookingProfile, phases: solution.phases } } };
  const rows = occupancyForSolution(solution).map((row) => ({ ...row, appointment_id: 22 }));
  const f = fixture({ failOccupancy: true, appointments: [old], occupancies: rows });
  await assert.rejects(f.reserve({ existingAppointmentId: 22, appointmentValues: { inicio: '2030-01-07T10:00:00Z', fin: '2030-01-07T10:30:00Z' } }), /simulated occupancy failure/);
  assert.equal(f.state.appointments[0].inicio, start);
  assert.deepEqual(f.state.occupancies, rows);
});

test('cancellation retains the trusted profile but releases capacity; reactivation must recheck it', async () => {
  const f = fixture();
  const original = await f.reserve();
  const canceled = await f.reserve({ existingAppointmentId: original.id_cita, appointmentValues: { estado: 'cancelada', import_metadata: { booking: { forged: true } } }, stateOnly: true });
  assert.equal(canceled.import_metadata.booking.forged, undefined);
  assert.equal(canceled.import_metadata.booking.profile.version, 1);
  assert.equal(f.state.occupancies.length, 2);
  await f.reserve();
  await assert.rejects(f.reserve({ existingAppointmentId: original.id_cita, appointmentValues: { estado: 'pendiente' }, stateOnly: true }), { code: 'booking_unavailable' });
  assert.equal(f.state.appointments.find((row) => row.id_cita === original.id_cita).estado, 'cancelada');
});

test('legacy creation strips forged booking snapshots while preserving unrelated provenance', async () => {
  const f = fixture({ bookingProfile: null });
  const created = await f.reserve({ appointmentValues: { ...f.values, import_metadata: { source_batch: 'synthetic', booking: { version: 1, forged: true } } } });
  assert.deepEqual(created.import_metadata, { source_batch: 'synthetic' });
  const controller = fs.readFileSync(path.resolve(__dirname, '../../controllers/citas.controller.js'), 'utf8');
  assert.match(controller, /delete baseImportMetadata\.booking/, 'HTTP must strip fake snapshots even with flags off or historical registration');
  assert.deepEqual(bookingSegments({ id_cita: 1, import_metadata: { booking: { version: 1, phases: [phase('fake')] } } }), []);
});

test('mandatory team persists one appointment and every physical phase under one transaction', async () => {
  const f = fixture({ bookingProfile: profile(phase('one', [9], [5, 6], 'all'), phase('two', [12], [5])) });
  const created = await f.reserve({ appointmentValues: { ...f.values, fin: '2030-01-07T10:00:00Z' } });
  assert.equal(f.state.appointments.length, 1);
  assert.equal(f.state.persists, 1);
  assert.equal(new Set(f.state.occupancies.map((row) => row.appointment_id)).size, 1);
  assert.equal(created.import_metadata.booking.phases.length, 2);
  assert(f.state.occupancies.some((row) => row.doctor_id === 6 && row.end_at === '2030-01-07T10:00:00.000Z'));
});

test('non-priority confirmation is required inside the transaction and does not use force', async () => {
  const f = fixture({ bookingProfile: profile(phase('one', [9], [5, 6])), appointments: [{ id_cita: 1, doctor_id: 5,
    instalacion_id: 19, clinica_id: 73, estado: 'reprogramada', inicio: start, fin: end }] });
  const values = { ...f.values, doctor_id: 6, force: true };
  await assert.rejects(f.reserve({ appointmentValues: values }), { code: 'booking_priority_confirmation_required' });
  assert.equal(f.state.persists, 0);
  const created = await f.reserve({ appointmentValues: values, priorityAcknowledged: true });
  assert.equal(created.doctor_id, 6);
  assert.equal(created.import_metadata.booking.priority_acknowledged, true);
  assert.doesNotMatch(JSON.stringify(created.import_metadata.booking.warnings), /clinica|paciente|appointment_id/);
});

test('physical aliases block the same cabin across clinics without returning foreign appointment details', async () => {
  const f = fixture({ aliases: [{ installation_id: 19, canonical_installation_id: 9, group_id: 2 }],
    appointments: [{ id_cita: 800, doctor_id: 99, instalacion_id: 19, clinica_id: 73, estado: 'cambio_solicitado', inicio: start, fin: end, titulo: 'PRIVATE' }] });
  await assert.rejects(f.reserve(), (error) => error.code === 'booking_unavailable' && !/800|PRIVATE|73/.test(JSON.stringify(error.details)));
  assert.equal(f.state.persists, 0);
});

test('segmented appointment does not occupy its primary cabin during later phases', async () => {
  const f = fixture({ appointments: [{ id_cita: 800, doctor_id: 5, instalacion_id: 9, estado: 'pendiente', inicio: start, fin: '2030-01-07T10:00:00Z' }],
    occupancies: [{ appointment_id: 800, resource_key: 'installation:9', start_at: start, end_at: end },
      { appointment_id: 800, resource_key: 'installation:12', start_at: end, end_at: '2030-01-07T10:00:00Z' },
      { appointment_id: 800, resource_key: 'doctor:5', start_at: start, end_at: '2030-01-07T10:00:00Z' }] });
  const context = await loadBookingContext({ db: f.db, clinic: f.clinic, profile: profile(phase('one', [9], [6])),
    start: new Date(end), end: new Date('2030-01-07T10:00:00Z'), occupancyEnabled: true });
  assert(solveBookingProfile({ profile: profile(phase('one', [9], [6])), start: end, ...context }));
});

test('batch search is bounded, includes chosen doctor/cabin and runs no DB query per candidate', async () => {
  const f = fixture();
  const result = await searchTreatmentSlots({ db: f.db, clinic: f.clinic, treatmentId: 3, date: '2030-01-07', limit: 20, capabilities });
  assert.equal(result.slots.length, 20);
  assert.equal(result.slots[0].doctor_id, 5);
  assert.equal(result.slots[0].installation_id, 9);
  assert.equal(f.state.calls.filter(([name]) => name === 'appointments').length, 1);
  assert.equal(f.state.calls.filter(([name]) => name === 'occupancies').length, 1);
  await assert.rejects(searchTreatmentSlots({ db: f.db, clinic: f.clinic, treatmentId: 3, date: '2030-01-07', days: 8, capabilities }), { code: 'booking_search_invalid' });
});

test('one appointment produces phase DTOs without duplicating identity or clinical labels for redacted users', () => {
  const bookingProfile = profile(phase('one'), phase('two', [12]));
  const solution = solveBookingProfile({ profile: bookingProfile, start,
    doctors: new Map([[5, free()]]), installations: new Map([[9, free()], [12, free()]]) });
  solution.phases[0].label = 'PRIVATE CLINICAL PROTOCOL';
  const segments = bookingSegments({ id_cita: 77, import_metadata: { booking: { version: 1, profile: bookingProfile, phases: solution.phases } } }, { includeClinicalLabels: false });
  assert.deepEqual(segments.map((segment) => segment.appointment_id), [77, 77]);
  assert.deepEqual(segments.map((segment) => segment.phase_index), [1, 2]);
  assert(!JSON.stringify(segments).includes('PRIVATE'));
});
