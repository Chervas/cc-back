'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeBookingProfile } = require('../../lib/booking-profile');
const { solveBookingProfile, occupancyForSolution } = require('../../lib/booking-profile-solver');
const { bookingCapabilities, requireOperationalProfile } = require('../../services/treatmentBookingProfile.service');
const { loadBookingContext, searchTreatmentSlots } = require('../../services/appointmentBookingAvailability.service');
const { mutateAppointmentBooking } = require('../../services/appointmentBookingCommand.service');
const { bookingSegments } = require('../../lib/appointment-booking-segments');
const { normalizeAdditionalStaff, additionalStaffPayload } = require('../../lib/appointment-additional-staff');
const { importReviewVersion, hasReviewedImportResources, importResourceFingerprint } = require('../../lib/appointment-import-review');
const { importedEquipmentProfile } = require('../../lib/appointment-import-equipment');

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

function fixture({ bookingProfile = profile(phase('one')), failOccupancy = false, appointments = [], occupancies = [], aliases = [],
  equipment = [], equipmentClinics = [], roomPolicies = [], equipmentEnabled = false } = {}) {
  const withBookingMarker = row => {
    let metadata = row.import_metadata;
    if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { metadata = { booking: true }; } }
    return { ...row, booking_protected: metadata && ('booking' in metadata || 'program_session' in metadata || 'additional_staff' in metadata) ? 1 : 0 };
  };
  const state = { appointments: [...appointments], occupancies: [...occupancies], events: [], commits: 0, rollbacks: 0, calls: [], locks: [], persists: 0 };
  let id = 100;
  let txId = 0;
  const mutexes = new Map();
  const clinic = { id_clinica: 72, grupoClinicaId: 2, configuracion: { timezone: 'Europe/Madrid' }, equipment_booking_enabled: equipmentEnabled };
  const clinics = [clinic, { id_clinica: 73, grupoClinicaId: 2, equipment_booking_enabled: equipmentEnabled }];
  const installations = [9, 10, 12].map((installationId) => ({ id: installationId, clinica_id: 72, activo: true, horarios: hours, clinica: clinic }));
  installations.push({ id: 19, clinica_id: 73, activo: true, horarios: hours, clinica: clinics[1] });
  const query = (name, rows, options) => { state.calls.push([name, options]); return rows.filter((row) => matches(row, options.where)); };
  const allAppointments = (tx) => [...state.appointments.filter((row) => !tx?.replacements.has(row.id_cita)), ...(tx?.pending || [])];
  const allOccupancies = (tx) => [...state.occupancies.filter((row) => !tx?.deleted.has(row.appointment_id)), ...(tx?.occupancies || [])];
  const db = {
    PatientOperationalEvent: { create: async (event, { transaction }) => { transaction.events.push(event); } },
    Sequelize: { Op, fn: (name, ...args) => ({ name, args }), col: name => ({ col: name }), literal: value => ({ literal: value }) },
    sequelize: { transaction: async (options, callback) => {
      const tx = { id: ++txId, options, LOCK: { UPDATE: 'UPDATE' }, pending: [], events: [], occupancies: [], deleted: new Set(), replacements: new Set(), release: new Map() };
      try {
        const result = await callback(tx);
        state.appointments = [...state.appointments.filter((row) => !tx.replacements.has(row.id_cita)), ...tx.pending];
        state.occupancies = [...state.occupancies.filter((row) => !tx.deleted.has(row.appointment_id)), ...tx.occupancies];
        state.events.push(...tx.events);
        state.commits++;
        return result;
      } catch (error) { state.rollbacks++; throw error; }
      finally { tx.release.forEach((release) => release()); }
    } },
    Clinica: { findByPk: async (value) => clinics.find((row) => row.id_clinica === Number(value)) },
    TreatmentConsentRequirement: { findAll: async () => [] },
    Tratamiento: { findByPk: async () => ({ id_tratamiento: 3, clinica_id: 72, grupo_clinica_id: 2, origen: equipmentEnabled ? 'grupo' : 'clinica', activo: true, clinical_config: { booking_profile: bookingProfile } }) },
    DoctorClinica: { findAll: async (options) => query('doctors', (equipmentEnabled ? [72, 73] : [72]).flatMap(clinicId => [5, 6].map((doctorId) => ({ doctor_id: doctorId, clinica_id: clinicId, activo: true, recibe_citas: true, horarios: hours }))), options) },
    DoctorHorario: {}, DoctorHorarioExcepcion: {}, InstalacionHorario: {}, DoctorBloqueoExcepcion: {},
    Instalacion: { findAll: async (options) => query('installations', installations, options) },
    ClinicaHorario: { findAll: async (options) => { state.calls.push(['hours', options]); return hours; } },
    DoctorBloqueo: { findAll: async (options) => { state.calls.push(['blocks', options]); return []; } },
    InstalacionBloqueo: { findAll: async (options) => { state.calls.push(['cab-blocks', options]); return []; } },
    InstallationPhysicalAlias: { findAll: async (options) => query('aliases', aliases, options) },
    BookingEquipment: { findAll: async options => query('equipment', equipment.map(unit => ({ ...unit, owner_clinic: clinics.find(c => c.id_clinica === unit.owner_clinic_id) })), options) },
    BookingEquipmentClinic: { findAll: async options => query('equipment-clinics', equipmentClinics, options) },
    BookingEquipmentRoomPolicy: { findAll: async options => query('equipment-policies', roomPolicies, options) },
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
      findAll: async (options) => query('appointments', allAppointments(options.transaction).map(withBookingMarker), options),
      findByPk: async (appointmentId, options = {}) => allAppointments(options.transaction).find((row) => row.id_cita === Number(appointmentId)),
    },
    AppointmentBookingOccupancy: {
      findAll: async (options) => query('occupancies', allOccupancies(options.transaction).filter((row) => !options.include
        || allAppointments(options.transaction).some((appointment) => appointment.id_cita === row.appointment_id && appointment.estado !== 'cancelada'))
        .map(row => ({ ...row, appointment: withBookingMarker(allAppointments(options.transaction).find(appointment => appointment.id_cita === row.appointment_id)) })), options),
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
  assert.deepEqual(f.state.locks.filter(([tx]) => tx === 1).map(([, key]) => key), ['doctor:5', 'installation:9', 'patient:1']);
});

test('one-off support reserves one appointment and both people, without changing the treatment', async () => {
  const f = fixture({ bookingProfile: null });
  const saved = await f.reserve({ additionalStaffIds: [6, '6'] });
  assert.equal(f.state.appointments.length, 1);
  assert.equal(saved.doctor_id, 5);
  assert.deepEqual(saved.import_metadata.additional_staff.ids, [6]);
  assert.equal(saved.import_metadata.booking, undefined);
  assert.deepEqual(f.state.occupancies.filter(r => r.doctor_id).map(r => r.doctor_id), [5, 6]);
  assert.equal(f.state.occupancies.filter(r => r.installation_id).length, 1);
  assert(f.state.locks.some(([, key]) => key === 'doctor:6'));
});

test('support requires compatible gates and active scheduled clinic membership', async () => {
  for (const ids of [[99], [true], null, Array(11).fill(6)]) {
    const f = fixture();
    await assert.rejects(f.reserve({ additionalStaffIds: ids }));
    assert.equal(f.state.persists, 0);
  }
  const f = fixture();
  await assert.rejects(f.reserve({ additionalStaffIds: [6], capabilities: { simple: true, multi: false } }),
    { code: 'booking_profile_runtime_unavailable' });
  assert.equal(f.state.persists, 0);
});

test('busy support cannot be forced, even when primary doctor and room are free', async () => {
  const f = fixture({ bookingProfile: null, appointments: [{ id_cita: 1, clinica_id: 72, paciente_id: 2,
    doctor_id: 6, instalacion_id: 12, inicio: start, fin: end, estado: 'pendiente' }] });
  await assert.rejects(f.reserve({ additionalStaffIds: [6], force: true }), error =>
    error.code === 'booking_unavailable' && error.details.can_force === false);
  assert.equal(f.state.persists, 0);
});

test('a support reservation blocks a concurrent ordinary booking for that person', async () => {
  const f = fixture({ bookingProfile: null });
  const results = await Promise.allSettled([
    f.reserve({ additionalStaffIds: [6] }),
    f.reserve({ appointmentValues: { ...f.values, paciente_id: 2, doctor_id: 6, instalacion_id: 12 }, force: true }),
  ]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.state.appointments.length, 1);
});

test('support survives rescheduling, explicit removal releases it, cancellation releases capacity', async () => {
  const f = fixture({ bookingProfile: null });
  const original = await f.reserve({ additionalStaffIds: [6] });
  const nextStart = end, nextEnd = '2030-01-07T10:00:00.000Z';
  const moved = await f.reserve({ existingAppointmentId: original.id_cita,
    appointmentValues: { inicio: nextStart, fin: nextEnd } });
  assert.deepEqual(moved.import_metadata.additional_staff.ids, [6]);
  assert.equal(moved.import_metadata.additional_staff.start_at, nextStart);
  assert.equal(f.state.occupancies.find(r => r.doctor_id === 6).end_at, nextEnd);
  await f.reserve({ existingAppointmentId: original.id_cita, appointmentValues: { estado: 'cancelada' }, stateOnly: true });
  await f.reserve({ appointmentValues: { ...f.values, paciente_id: 2, doctor_id: 6, instalacion_id: 12, inicio: nextStart, fin: nextEnd } });
  await assert.rejects(f.reserve({ existingAppointmentId: original.id_cita, appointmentValues: { estado: 'pendiente' } }),
    { code: 'booking_unavailable' });
  const restored = await f.reserve({ existingAppointmentId: original.id_cita,
    appointmentValues: { estado: 'pendiente' }, additionalStaffIds: [] });
  assert.equal(restored.import_metadata?.additional_staff, undefined);
  assert(!f.state.occupancies.some(r => r.appointment_id === original.id_cita && r.doctor_id === 6));
});

test('support in a later treatment phase occupies the whole appointment without double counting', async () => {
  const f = fixture({ bookingProfile: profile(phase('one', [9], [5]), phase('two', [12], [6])) });
  await f.reserve({ additionalStaffIds: [6], appointmentValues: { ...f.values, fin: '2030-01-07T10:00:00.000Z' } });
  const support = f.state.occupancies.filter(r => r.doctor_id === 6);
  assert.equal(support.length, 1);
  assert.equal(support[0].start_at, start);
  assert.equal(support[0].end_at, '2030-01-07T10:00:00.000Z');
});

test('client metadata cannot forge support and a status-only call cannot replace it', async () => {
  const f = fixture({ bookingProfile: null });
  const saved = await f.reserve({ appointmentValues: { ...f.values,
    import_metadata: { additional_staff: { version: 1, ids: [99] } } } });
  assert.equal(saved.import_metadata?.additional_staff, undefined);
  await assert.rejects(f.reserve({ existingAppointmentId: saved.id_cita, stateOnly: true,
    additionalStaffIds: [6], appointmentValues: { estado: 'confirmada' } }), { code: 'booking_additional_staff_invalid' });
});

test('canonical booking rejects forged import-resource approval and preserves only the stored marker', async () => {
  const f=fixture({bookingProfile:null}), forged={version:1,actor_id:999,request_hash:'a'.repeat(64)};
  const saved=await f.reserve({appointmentValues:{...f.values,import_metadata:{import_resource_resolution:forged}}});
  assert.equal(saved.import_metadata?.import_resource_resolution,undefined);
  const stored={version:1,actor_id:7,request_hash:'b'.repeat(64)};
  f.state.appointments.find(row=>row.id_cita===saved.id_cita).import_metadata={import_resource_resolution:stored};
  const revised=await f.reserve({existingAppointmentId:saved.id_cita,appointmentValues:{import_metadata:{import_resource_resolution:forged}}});
  assert.deepEqual(revised.import_metadata.import_resource_resolution,stored);
});

test('support DTO is bounded, date-bound and excludes metadata, history and patient fields', async () => {
  assert.equal(normalizeAdditionalStaff(undefined), undefined);
  assert.deepEqual(normalizeAdditionalStaff([]), []);
  const f = fixture({ bookingProfile: null });
  const saved = await f.reserve({ additionalStaffIds: [6] });
  assert.deepEqual(additionalStaffPayload(saved), [{ id: 6, name: '' }]);
  assert.deepEqual(additionalStaffPayload({ ...saved, inicio: end }), []);
  assert.deepEqual(additionalStaffPayload({ ...saved, import_metadata: '{invalid' }), []);
  assert.deepEqual(additionalStaffPayload({ ...saved, import_metadata: { additional_staff: { version: 1, ids: [true], names: ['x'], start_at: start, end_at: end } } }), []);
});

test('treatment slot search excludes busy support using one bulk context, not queries per candidate', async () => {
  const f = fixture({ appointments: [{ id_cita: 1, clinica_id: 73, paciente_id: 99,
    doctor_id: 6, inicio: start, fin: end, estado: 'pendiente' }] });
  const slots = await searchTreatmentSlots({ db: f.db, clinic: f.clinic, treatmentId: 3,
    date: '2030-01-07', capabilities, now: new Date(start), limit: 20, additionalStaffIds: [6] });
  assert(slots.slots.length > 1);
  assert(slots.slots.every(slot => new Date(slot.start_at) >= new Date(end)));
  assert.equal(f.state.calls.filter(([kind]) => kind === 'doctors').length, 1);
  assert.equal(f.state.calls.filter(([kind]) => kind === 'appointments').length, 1);
  assert.equal(f.state.calls.filter(([kind]) => kind === 'occupancies').length, 1);
});

test('failed support rebooking rolls the prior team and occupancy back together', async () => {
  const f = fixture({ bookingProfile: null });
  const saved = await f.reserve({ additionalStaffIds: [6] });
  const before = JSON.stringify({ appointments: f.state.appointments, occupancies: f.state.occupancies });
  await assert.rejects(f.reserve({ existingAppointmentId: saved.id_cita,
    appointmentValues: { inicio: end, fin: '2030-01-07T10:00:00Z' }, additionalStaffIds: [99] }),
  { code: 'booking_unavailable' });
  assert.equal(JSON.stringify({ appointments: f.state.appointments, occupancies: f.state.occupancies }), before);
});

test('support-only command preserves status, time, primary resources and reminder suppression', async () => {
  const { changeAppointmentSupport } = require('../../services/appointmentSupport.service');
  const f = fixture({ bookingProfile: null });
  const saved = await f.reserve({ appointmentValues: { ...f.values, estado: 'recordatorio_confirmado',
    import_metadata: { notification_suppression: { day_before: true, same_day: true } } } });
  const find = f.db.CitaPaciente.findByPk;
  f.db.CitaPaciente.findByPk = async (...args) => {
    const row = await find(...args);
    return row && { ...row, toJSON: () => row,
      update: (values, { transaction }) => f.persist({ values, existing: row, transaction }) };
  };
  const changed = await changeAppointmentSupport({ db: f.db, appointmentId: saved.id_cita, actorId: 42,
    ids: [6], expectedRange: { start, end }, capabilities });
  for (const key of ['estado', 'inicio', 'fin', 'doctor_id', 'instalacion_id', 'paciente_id']) assert.equal(changed[key], saved[key]);
  assert.deepEqual(changed.import_metadata.notification_suppression, saved.import_metadata.notification_suppression);
  assert.equal(f.state.events.length, 1);
  assert.equal(f.state.events[0].event_type, 'appointment.staff_changed');
  assert.equal(f.state.events[0].actor_user_id, 42);
  assert.deepEqual(f.state.events[0].metadata.additional_staff, [{ id: 6, name: '' }]);
  await changeAppointmentSupport({ db: f.db, appointmentId: saved.id_cita, actorId: 42,
    ids: [6], expectedRange: { start, end }, capabilities });
  assert.equal(f.state.events.length, 1, 'same team does not create another clinical event');
});

test('support-only change rejects stale intervals, closed appointments and mixed payloads', async () => {
  const f = fixture({ bookingProfile: null });
  const saved = await f.reserve();
  const base = { existingAppointmentId: saved.id_cita, additionalStaffIds: [6], supportOnly: true,
    expectedRange: { start, end }, appointmentValues: { updated_by: 42 } };
  await assert.rejects(f.reserve({ ...base, expectedRange: { start: end, end } }), { code: 'booking_appointment_changed' });
  await assert.rejects(f.reserve({ ...base, appointmentValues: { estado: 'reprogramada' } }), { code: 'booking_additional_staff_invalid' });
  await f.reserve({ existingAppointmentId: saved.id_cita, stateOnly: true, appointmentValues: { estado: 'cancelada' } });
  await assert.rejects(f.reserve(base), { code: 'booking_additional_staff_closed' });
});

test('support event failure rolls back the team and the canonical appointment together', async () => {
  const { changeAppointmentSupport } = require('../../services/appointmentSupport.service');
  const f = fixture({ bookingProfile: null });
  const saved = await f.reserve();
  const before = JSON.stringify({ appointments: f.state.appointments, occupancies: f.state.occupancies });
  const find = f.db.CitaPaciente.findByPk;
  f.db.CitaPaciente.findByPk = async (...args) => {
    const row = await find(...args);
    return row && { ...row, toJSON: () => row, update: (values, { transaction }) => f.persist({ values, existing: row, transaction }) };
  };
  f.db.PatientOperationalEvent.create = async () => { throw Error('audit unavailable'); };
  await assert.rejects(changeAppointmentSupport({ db: f.db, appointmentId: saved.id_cita, actorId: 42,
    ids: [6], expectedRange: { start, end }, capabilities }), /audit unavailable/);
  assert.equal(JSON.stringify({ appointments: f.state.appointments, occupancies: f.state.occupancies }), before);
});

test('occupancy failure rolls the canonical appointment back too; no partial reservation', async () => {
  const f = fixture({ failOccupancy: true });
  await assert.rejects(f.reserve(), /simulated occupancy failure/);
  assert.equal(f.state.appointments.length, 0);
  assert.equal(f.state.occupancies.length, 0);
  assert.equal(f.state.rollbacks, 1);
});

test('unsigned clinical completion fails before appointment persistence or occupancy mutation', async () => {
  const f = fixture();
  const original = await f.reserve();
  f.db.TreatmentConsentRequirement.findAll = async () => [{ tratamiento_id: 3, clinic_template_id: 7,
    required: true, blocking_policy: 'hard', clinicTemplate: { purpose: 'clinical', status: 'active', validity_mode: 'single_act' } }];
  f.db.PatientConsentDocument = { findAll: async () => [] };
  const persists = f.state.persists;
  await assert.rejects(f.reserve({ existingAppointmentId: original.id_cita, stateOnly: true,
    appointmentValues: { estado: 'completada' }, force: true }), { code: 'appointment_consent_required' });
  assert.equal(f.state.persists, persists);
  assert.equal(f.state.appointments[0].estado, 'pendiente');
  assert.equal(f.state.occupancies.length, 2);
});

test('ordinary overlap requires confirmation and remains forceable after occupancy is written', async () => {
  const f = fixture({ bookingProfile: null });
  await f.reserve();
  const values = { ...f.values, paciente_id: 2 };
  await assert.rejects(f.reserve({ appointmentValues: values }), error => error.code === 'booking_unavailable' && error.details.can_force === true);
  await assert.rejects(f.reserve({ appointmentValues: values, force: 'true' }), { code: 'booking_unavailable' });
  await f.reserve({ appointmentValues: values, force: true });
  assert.equal(f.state.appointments.length, 2);
  assert.equal(f.state.occupancies.length, 4);
});

test('force never bypasses a profiled reservation, another clinic, a patient overlap or a calendar block', async () => {
  const ordinary = { id_cita: 88, clinica_id: 72, paciente_id: 2, doctor_id: 5, instalacion_id: 9,
    inicio: start, fin: end, estado: 'pendiente' };
  for (const change of [ { clinica_id: 73 }, { paciente_id: 1 }, { import_metadata: { booking: { profile: profile(phase('one')) } } },
    { source_system: 'treatment_program' }, { import_metadata: '{invalid' } ]) {
    const f = fixture({ bookingProfile: null, appointments: [{ ...ordinary, ...change }] });
    await assert.rejects(f.reserve({ force: true }), error => error.code === 'booking_unavailable' && error.details.can_force === false);
    assert.equal(f.state.persists, 0);
  }
  const f = fixture({ bookingProfile: null });
  f.db.InstalacionBloqueo.findAll = async () => [{ instalacion_id: 9, fecha_inicio: start, fecha_fin: end }];
  await assert.rejects(f.reserve({ force: true }), error => error.code === 'booking_unavailable' && error.details.can_force === false);
  const profiled = fixture({ appointments: [ordinary] });
  await assert.rejects(profiled.reserve({ force: true }), error => error.code === 'booking_unavailable' && error.details.can_force === false);
});

test('force retains opening hours and does not leak conflict identities in HTTP', async () => {
  const f = fixture({ bookingProfile: null });
  await assert.rejects(f.reserve({ force: true, appointmentValues: { ...f.values,
    inicio: '2030-01-07T03:00:00Z', fin: '2030-01-07T03:30:00Z' } }), error => error.details.can_force === false);
  const { bookingErrorPayload, bookingError } = require('../../services/treatmentBookingProfile.service');
  const payload = bookingErrorPayload(bookingError('booking_unavailable', 'Ocupado', { can_force: true }));
  assert.equal(payload.reason, 'overlap');
  assert.equal(payload.can_force, true);
  assert.deepEqual(payload.conflicts, [{ type: 'overlap', message: 'Recurso ocupado por otra cita de esta clínica' }]);
  assert.equal(bookingErrorPayload(bookingError('booking_priority_confirmation_required', 'Confirmar', { can_force: true })).can_force, false);
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

test('installation restriction blocks legacy/profile/support writes and force cannot bypass it', async () => {
  for (const kind of ['legacy', 'profile', 'support']) {
    const f = fixture({ bookingProfile: kind === 'profile' ? profile(phase('one')) : null });
    const read = f.db.Instalacion.findAll;
    f.db.Instalacion.findAll = async args => (await read(args)).map(room => ({ ...room,
      profesionales_permitidos: kind === 'support' ? [5] : [6] }));
    await assert.rejects(f.reserve({ force: true, ...(kind === 'support' ? { additionalStaffIds: [6] } : {}) }), { code: 'booking_unavailable' });
    assert.equal(f.state.persists, 0); assert.equal(f.state.occupancies.length, 0);
  }
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

const eqCaps = { ...capabilities, equipment: true };
const machinePhase = (room = 9, doctor = 5, id = 1) => ({ ...phase('machine', [room], [doctor]), equipment_requirements: [{ equipment_ids: [id] }] });
const machine = (id = 1, extra = {}) => ({ id, owner_clinic_id: 72, group_id: 2, name: `Equipo ${id}`, family_key: 'exion',
  mobility: 'mobile', status: 'available', turnaround_minutes: 0, home_installation_id: 9, ...extra });
function equipmentFixture(overrides = {}) {
  return fixture({ bookingProfile: { version: 2, phases: [machinePhase()] }, equipmentEnabled: true,
    equipment: [machine()], equipmentClinics: [{ equipment_id: 1, clinic_id: 72 }],
    roomPolicies: [{ installation_id: 9, mode: 'all' }], ...overrides });
}

test('equipment is opt-in: no machine SQL for psychology, even in an equipped clinic', async () => {
  for (const enabled of [false, true]) {
    const f = fixture({ equipmentEnabled: enabled });
    await f.reserve({ capabilities: eqCaps });
    assert.equal(f.state.calls.filter(([name]) => name.startsWith('equipment')).length, 0);
    assert(!f.state.locks.some(([, key]) => key.startsWith('equipment:')));
  }
});

test('a required machine cannot silently disappear when clinic or runtime is disabled', async () => {
  for (const override of [{ equipmentEnabled: false }, {}]) {
    const f = equipmentFixture(override);
    await assert.rejects(f.reserve({ capabilities: { ...capabilities, equipment: false } }), { code: 'booking_equipment_disabled' });
    assert.equal(f.state.calls.filter(([name]) => name.startsWith('equipment')).length, 0);
    assert.equal(f.state.persists, 0);
  }
  const f = equipmentFixture({ equipmentEnabled: false });
  await assert.rejects(f.reserve({ capabilities: eqCaps }), { code: 'booking_equipment_disabled' });
});

test('v2 reserves a physical unit and returns its name in the canonical phase DTO', async () => {
  const f = equipmentFixture();
  const saved = await f.reserve({ capabilities: eqCaps });
  assert.equal(saved.import_metadata.booking.profile.version, 2);
  assert.equal(f.state.occupancies.length, 3);
  assert(f.state.locks.some(([, key]) => key === 'equipment:1'));
  const segments = bookingSegments(saved);
  assert.deepEqual(segments[0].equipment, [{ id: 1, name: 'Equipo 1' }]);
  assert.equal(f.state.calls.filter(([name]) => name.startsWith('equipment')).length, 3);
});

test('presotherapy and carbo reject mobile machines; fixed machines remain usable', async () => {
  for (const policy of [[], [{ installation_id: 9, mode: 'none' }], [{ installation_id: 9, mode: 'selected', equipment_ids: [2] }]]) {
    const f = equipmentFixture({ roomPolicies: policy });
    await assert.rejects(f.reserve({ capabilities: eqCaps, force: true }), error => error.code === 'booking_unavailable' && !error.details.can_force);
    assert.equal(f.state.persists, 0);
  }
  const f = equipmentFixture({ roomPolicies: [], equipment: [machine(1, { mobility: 'fixed' })] });
  assert(await f.reserve({ capabilities: eqCaps }));
});

test('fixed machine cannot be reserved in another physical room; shared alias is the same room', async () => {
  const wrong = equipmentFixture({ equipment: [machine(1, { mobility: 'fixed', home_installation_id: 12 })] });
  await assert.rejects(wrong.reserve({ capabilities: eqCaps }), { code: 'booking_unavailable' });
  const alias = equipmentFixture({ equipment: [machine(1, { mobility: 'fixed', home_installation_id: 19 })],
    aliases: [{ installation_id: 19, canonical_installation_id: 9, group_id: 2 }] });
  assert(await alias.reserve({ capabilities: eqCaps }));
});

test('sharing one unit never creates capacity for two patients in different clinics', async () => {
  const f = equipmentFixture({ equipmentClinics: [{ equipment_id: 1, clinic_id: 72 }, { equipment_id: 1, clinic_id: 73 }],
    roomPolicies: [{ installation_id: 9, mode: 'all' }, { installation_id: 19, mode: 'all' }] });
  f.db.Tratamiento.findByPk = async id => ({ id_tratamiento: id, origen: 'clinica', clinica_id: id === 3 ? 72 : 73, activo: true,
    clinical_config: { booking_profile: { version: 2, phases: [machinePhase(id === 3 ? 9 : 19, id === 3 ? 5 : 6)] } } });
  const results = await Promise.allSettled([f.reserve({ capabilities: eqCaps }), f.reserve({ capabilities: eqCaps,
    appointmentValues: { ...f.values, clinica_id: 73, tratamiento_id: 4, doctor_id: 6, instalacion_id: 19, paciente_id: 2 } })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(results.find(r => r.status === 'rejected').reason.code, 'booking_unavailable');
  assert.equal(f.state.occupancies.filter(r => r.resource_kind === 'equipment').length, 1);
});

test('a missing share, foreign group or maintenance state never offers the device', async () => {
  for (const changes of [{ equipmentClinics: [] }, { equipment: [machine(1, { owner_clinic_id: 73, group_id: 55 })] }]) {
    const f = equipmentFixture(changes);
    await assert.rejects(f.reserve({ capabilities: eqCaps }), { code: 'booking_equipment_scope' });
  }
  const f = equipmentFixture({ equipment: [machine(1, { status: 'maintenance' })] });
  await assert.rejects(f.reserve({ capabilities: eqCaps, force: true }), { code: 'booking_unavailable' });
});

test('turnaround protects both sides of the reservation, without lengthening the patient visit', async () => {
  const f = equipmentFixture({ equipment: [machine(1, { turnaround_minutes: 10 })] });
  const saved = await f.reserve({ capabilities: eqCaps });
  assert.equal(saved.fin, end);
  assert.equal(f.state.occupancies.find(r => r.resource_kind === 'equipment').end_at, '2030-01-07T09:40:00.000Z');
  await assert.rejects(f.reserve({ capabilities: eqCaps, appointmentValues: { ...f.values, paciente_id: 2,
    inicio: '2030-01-07T09:30:00Z', fin: '2030-01-07T10:00:00Z' } }), { code: 'booking_unavailable' });
  await assert.rejects(f.reserve({ capabilities: eqCaps, appointmentValues: { ...f.values, paciente_id: 2,
    inicio: '2030-01-07T08:30:00Z', fin: start } }), { code: 'booking_unavailable' });
});

test('cancellation releases machinery and reopening rechecks occupation', async () => {
  const f = equipmentFixture();
  const first = await f.reserve({ capabilities: eqCaps });
  await f.reserve({ capabilities: eqCaps, existingAppointmentId: first.id_cita, appointmentValues: { estado: 'cancelada' }, stateOnly: true });
  await f.reserve({ capabilities: eqCaps, appointmentValues: { ...f.values, paciente_id: 2 } });
  await assert.rejects(f.reserve({ capabilities: eqCaps, existingAppointmentId: first.id_cita, appointmentValues: { estado: 'pendiente' }, stateOnly: true }), { code: 'booking_unavailable' });
  assert.equal(f.state.appointments.find(a => a.id_cita === first.id_cita).estado, 'cancelada');
});

test('slot query count is constant across days and candidates with equipment', async () => {
  const counts = [];
  for (const days of [1, 7]) {
    const f = equipmentFixture();
    const result = await searchTreatmentSlots({ db: f.db, clinic: f.clinic, treatmentId: 3, date: '2030-01-07', days,
      stepMinutes: 5, limit: 500, capabilities: eqCaps, now: new Date('2029-01-01') });
    assert(result.slots.length > 0);
    counts.push(f.state.calls.length);
    assert.equal(f.state.calls.filter(([name]) => name.startsWith('equipment')).length, 3);
  }
  assert.equal(counts[0], counts[1]);
});

function importedEquipmentFixture(options = {}, changes = {}) {
  const f = equipmentFixture({ bookingProfile: null, ...options });
  const row = { ...f.values, id_cita: 80, source_system: 'cliniccloud', source_reference: 'source-id-80',
    updated_at: '2029-01-01T00:00:00.000Z', nota: 'Original',
    import_metadata: { cliniccloud_delta: { pending_assignment: ['doctor_id', 'installation_id'] },
      notification_suppression: { appointment_details: true, day_before: true, same_day: true } }, ...changes };
  f.state.appointments.push(row);
  const assignment = { expected_version: importReviewVersion(row), source_sha256: 'a'.repeat(64), equipment_ids: [1] };
  const reconcile = (overrides = {}) => f.db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, transaction =>
    f.reserve({ capabilities: eqCaps, appointmentValues: {}, existingAppointmentId: row.id_cita,
      transaction, importEquipmentAssignment: assignment, ...overrides }));
  return { ...f, row, assignment, reconcile };
}

test('documentary equipment reconciliation preserves the appointment and occupies the unit canonically', async () => {
  const f = importedEquipmentFixture();
  const before = structuredClone(f.row);
  const saved = await f.reconcile();
  assert.deepEqual({ ...saved, import_metadata: before.import_metadata }, before);
  assert.deepEqual({ ...saved.import_metadata, booking: undefined }, { ...before.import_metadata, booking: undefined });
  assert.equal(saved.import_metadata.booking.profile.version, 2);
  assert.deepEqual(saved.import_metadata.booking.profile.phases[0].equipment_requirements, [{ equipment_ids: [1] }]);
  assert.deepEqual(f.state.occupancies.map(r => r.resource_key).sort(), ['doctor:5', 'equipment:1', 'installation:9']);
  assert.equal(f.state.events.length, 0);
  assert.equal(f.state.calls.filter(([name]) => name.startsWith('equipment')).length, 3);
  assert.deepEqual(bookingSegments(saved)[0].equipment, [{ id: 1, name: 'Equipo 1' }]);
});

test('documentary equipment profile is derived, bounded, and cannot choose new clinical resources', () => {
  const f = importedEquipmentFixture();
  const expected = importedEquipmentProfile(f.row, { ...f.assignment, equipment_ids: [3, 1] });
  assert.deepEqual(expected.phases[0].installation_ids, [9]);
  assert.deepEqual(expected.phases[0].professionals.ids, [5]);
  assert.equal(expected.phases[0].duration_minutes, 30);
  assert.deepEqual(expected.phases[0].equipment_requirements, [{ equipment_ids: [1] }, { equipment_ids: [3] }]);
  for (const changes of [{ equipment_ids: [] }, { equipment_ids: [1, 1] }, { equipment_ids: ['1'] },
    { equipment_ids: [0] }, { equipment_ids: Array.from({ length: 9 }, (_, i) => i + 1) },
    { source_sha256: 'unknown' }, { expected_version: 'b'.repeat(64) }, { profile: expected },
    { duration_minutes: 10 }, { doctor_id: 6 }, { installation_id: 10 }]) {
    assert.throws(() => importedEquipmentProfile(f.row, { ...f.assignment, ...changes }), { code: 'booking_import_equipment_invalid' });
  }
});

test('only complete, unchanged, open ClinicCloud appointments in HOLD can receive documentary machines', async () => {
  for (const changes of [{ source_system: 'native' }, { source_reference: null }, { doctor_id: null },
    { instalacion_id: null }, { tratamiento_id: null }, { estado: 'completada' }, { estado: 'no_asistio' },
    { estado: 'cancelada' }, { estado: 'reprogramada' }, { voucher_id: 9 }, { lead_intake_id: 9 },
    { es_provisional: true }, { hold_expires_at: start }, { updated_at: null }, { fin: '2030-01-07T09:30:01.000Z' }]) {
    const f = importedEquipmentFixture({}, changes);
    await assert.rejects(f.reconcile(), { code: 'booking_import_equipment_invalid' });
    assert.equal(f.state.persists, 0);
  }
  for (const change of [{ booking: {} }, { program_session: {} }, { additional_staff: { version: 1, ids: [6] } },
    { notification_suppression: { appointment_details: true, same_day: true, day_before: false } }]) {
    const f = importedEquipmentFixture();
    Object.assign(f.row.import_metadata, change);
    f.assignment.expected_version = importReviewVersion(f.row);
    await assert.rejects(f.reconcile());
    assert.equal(f.state.persists, 0);
  }
  const f = importedEquipmentFixture();
  f.row.nota = 'A concurrent clinical edit';
  await assert.rejects(f.reconcile(), { code: 'booking_import_equipment_invalid' });
  assert.equal(f.state.persists, 0);
});

test('documentary reconciliation requires explicit transaction and cannot piggyback another mutation', async () => {
  const overrides = [{ transaction: null }, { existingAppointmentId: null }, { stateOnly: true }, { supportOnly: true },
    { force: true }, { trustedProgramSession: {} }, { preparedContext: {} }, { additionalStaffIds: [] },
    { appointmentValues: { estado: 'completada' } }, { appointmentValues: { doctor_id: 6 } },
    { selections: { appointment: { doctor_id: 6 } } }, { capabilities: { ...eqCaps, multi: false } },
    { capabilities: { ...eqCaps, equipment: false } }];
  for (const override of overrides) {
    const f = importedEquipmentFixture();
    await assert.rejects(f.reconcile(override), { code: 'booking_import_equipment_invalid' });
    assert.equal(f.state.persists, 0);
    assert.equal(f.state.occupancies.length, 0);
  }
  const f = importedEquipmentFixture({ bookingProfile: profile(phase('existing')) });
  await assert.rejects(f.reconcile(), { code: 'booking_import_equipment_invalid' });
  assert.equal(f.state.persists, 0);
});

test('ordinary payload fields cannot opt into the operator-only equipment reconciliation', async () => {
  const f = importedEquipmentFixture();
  const saved = await f.reserve({ capabilities: eqCaps, existingAppointmentId: f.row.id_cita,
    appointmentValues: { importEquipmentAssignment: f.assignment, import_metadata: { ...f.row.import_metadata,
      booking: { profile: importedEquipmentProfile(f.row, f.assignment) } } } });
  assert.equal(saved.import_metadata.booking, undefined);
  assert.equal(f.state.occupancies.filter(r => r.resource_kind === 'equipment').length, 0);
  assert.equal(f.state.calls.filter(([name]) => name.startsWith('equipment')).length, 0);
});

test('documentary machine assignment respects mobile restrictions, fixed rooms, authorization and maintenance', async () => {
  for (const options of [{ roomPolicies: [] }, { equipmentClinics: [] }, { equipmentEnabled: false },
    { equipment: [machine(1, { status: 'maintenance' })] },
    { equipment: [machine(1, { mobility: 'fixed', home_installation_id: 12 })] }]) {
    const f = importedEquipmentFixture(options);
    await assert.rejects(f.reconcile());
    assert.equal(f.state.persists, 0);
    assert.equal(f.state.occupancies.length, 0);
  }
  const fixed = importedEquipmentFixture({ roomPolicies: [], equipment: [machine(1, { mobility: 'fixed' })] });
  assert(await fixed.reconcile());
});

test('an occupied unit or patient prevents reconciliation without changing the imported row', async () => {
  for (const patient of [false, true]) {
    const other = { id_cita: 99, clinica_id: 73, paciente_id: patient ? 1 : 2, doctor_id: 6, instalacion_id: 19,
      inicio: start, fin: end, estado: 'pendiente' };
    const f = importedEquipmentFixture({ appointments: [other], occupancies: patient ? [] : [{
      appointment_id: 99, resource_kind: 'equipment', resource_key: 'equipment:1',
      start_at: start, end_at: end, phase_key: 'other', equipment_id: 1,
    }] });
    const before = structuredClone(f.row);
    await assert.rejects(f.reconcile(), e => e.code === 'booking_unavailable' && !e.details.can_force);
    assert.deepEqual(f.state.appointments.find(a => a.id_cita === 80), before);
    assert.equal(f.state.persists, 0);
  }
});

test('adding documentary equipment invalidates previous resource review without erasing its evidence', async () => {
  const f = importedEquipmentFixture();
  f.row.import_metadata.import_resource_resolution = { version: 1, actor_id: 7, request_hash: 'c'.repeat(64),
    reservation_fingerprint: importResourceFingerprint(f.row) };
  assert(hasReviewedImportResources(f.row));
  f.assignment.expected_version = importReviewVersion(f.row);
  const saved = await f.reconcile();
  assert(!hasReviewedImportResources(saved));
  assert.deepEqual(saved.import_metadata.import_resource_resolution, f.row.import_metadata.import_resource_resolution);
});

test('documentary equipment survives normal editing and cancellation; reopening revalidates the same unit', async () => {
  const f = importedEquipmentFixture();
  const first = await f.reconcile();
  const edited = await f.reserve({ capabilities: eqCaps, existingAppointmentId: first.id_cita,
    appointmentValues: { nota: 'An edited note', import_metadata: { booking: null } } });
  assert.deepEqual(edited.import_metadata.booking.profile, first.import_metadata.booking.profile);
  assert.deepEqual(edited.import_metadata.notification_suppression, first.import_metadata.notification_suppression);
  await f.reserve({ capabilities: eqCaps, existingAppointmentId: first.id_cita, appointmentValues: { estado: 'cancelada' }, stateOnly: true });
  const reopened = await f.reserve({ capabilities: eqCaps, existingAppointmentId: first.id_cita, appointmentValues: { estado: 'pendiente' }, stateOnly: true });
  assert.deepEqual(reopened.import_metadata.booking.profile, first.import_metadata.booking.profile);
  assert.equal(f.state.occupancies.filter(r => r.resource_kind === 'equipment').length, 1);
  await f.db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    await assert.rejects(f.reserve({ capabilities: eqCaps, existingAppointmentId: first.id_cita, appointmentValues: {}, transaction,
      importEquipmentAssignment: { ...f.assignment, expected_version: importReviewVersion(reopened) } }), { code: 'booking_import_equipment_invalid' });
  });
});

test('failed documentary occupancy write rolls back the row and does not leave a partial machine reservation', async () => {
  const f = importedEquipmentFixture({ failOccupancy: true });
  const before = structuredClone(f.row);
  await assert.rejects(f.reconcile(), /offline simulated occupancy failure/);
  assert.deepEqual(f.state.appointments.find(a => a.id_cita === 80), before);
  assert.equal(f.state.occupancies.length, 0);
  assert.equal(f.state.events.length, 0);
});
