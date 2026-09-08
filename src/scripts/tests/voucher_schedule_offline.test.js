#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const calendar = require('../../lib/voucher-schedule-calendar');
const { normalizeBookingProfile, requiresMultiResourceBooking } = require('../../lib/booking-profile');
const { inspectSeries } = require('../../services/voucherScheduleAvailability.service');

const Op = Object.fromEntries(['ne', 'in', 'notIn', 'or', 'lt', 'lte', 'gt'].map((key) => [key, Symbol(key)]));
const allDays = Array.from({ length: 7 }, (_, dia_semana) => ({
  id: dia_semana + 1, dia_semana, activo: true, hora_inicio: '08:00', hora_fin: '20:00', excepciones: [],
}));
const series = (start = '2030-01-07T10:00:00+01:00', count = 2, intervalDays = 7) => calendar.buildSeriesSlots({
  startAt: calendar.parseSeriesStart(start, 'Europe/Madrid'), count, intervalDays, durationMinutes: 30, timeZone: 'Europe/Madrid',
});

function fixture({ appointments = [], blocks = [], clinicHours = allDays, doctorHours = allDays, installationBlocks = [] } = {}) {
  const calls = [];
  const db = {
    Sequelize: { Op },
    ClinicaHorario: { findAll: async (query) => { calls.push(['clinic', query]); return clinicHours; } },
    DoctorBloqueo: { findAll: async (query) => { calls.push(['blocks', query]); return blocks; } },
    DoctorBloqueoExcepcion: {},
    CitaPaciente: { findAll: async (query) => { calls.push(['appointments', query]); return appointments; } },
  };
  return {
    calls,
    input: {
      db, slots: series(), clinicId: 72, doctorId: 5, installationId: 9, timeZone: 'Europe/Madrid',
      doctor: { recibe_citas: true, horarios: doctorHours }, installation: { horarios: allDays, bloqueos: installationBlocks },
    },
  };
}

test('series preserves clinic wall time through spring and autumn changes', () => {
  const spring = series('2027-03-27T10:00:00+01:00', 2, 1);
  assert.equal(spring[0].start.toISOString(), '2027-03-27T09:00:00.000Z');
  assert.equal(spring[1].start.toISOString(), '2027-03-28T08:00:00.000Z');
  const autumn = series('2026-10-24T10:00:00+02:00', 2, 1);
  assert.equal(autumn[1].start.toISOString(), '2026-10-25T09:00:00.000Z');
  assert.equal(calendar.parseSeriesStart('2030-01-07T10:00', 'Europe/Madrid').toISOString(), '2030-01-07T09:00:00.000Z');
});

test('series rejects missing/ambiguous future local times rather than changing the patient appointment', () => {
  for (const value of ['2027-03-27T02:30:00+01:00', '2026-10-24T02:30:00+02:00']) {
    assert.throws(() => series(value, 2, 1), { code: 'voucher_schedule_dst_conflict' });
  }
  assert.throws(() => calendar.parseSeriesStart('2030-02-31T10:00', 'Europe/Madrid'));
});

test('series preloads occupancy once across clinics, retaining every non-cancelled state and excluding PII fields', async () => {
  const f = fixture({ appointments: [{ doctor_id: 5, instalacion_id: 99, clinica_id: 66,
    inicio: '2030-01-07T09:00:00Z', fin: '2030-01-07T09:30:00Z', titulo: 'PRIVATE PATIENT', id_cita: 999 }] });
  const result = await inspectSeries(f.input);
  assert.equal(result[0].conflicts[0].code, 'STAFF_OVERLAP');
  assert.equal(result[1].conflicts.length, 0);
  const query = f.calls.find(([kind]) => kind === 'appointments')[1];
  assert.equal(query.where.clinica_id, undefined);
  assert.equal(query.where.estado[Op.ne], 'cancelada');
  assert.equal(f.calls.filter(([kind]) => kind === 'appointments').length, 1);
  assert.deepEqual(query.attributes, ['doctor_id', 'instalacion_id', 'inicio', 'fin']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|999|clinica_id|appointment_id/);
});

test('adjacent appointments do not conflict at an exclusive endpoint', async () => {
  const f = fixture({ appointments: [
    { doctor_id: 5, inicio: '2030-01-07T08:30:00Z', fin: '2030-01-07T09:00:00Z' },
    { doctor_id: 5, inicio: '2030-01-07T09:30:00Z', fin: '2030-01-07T10:00:00Z' },
  ] });
  assert.equal((await inspectSeries(f.input))[0].conflicts.length, 0);
});

test('checks clinic, doctor and installation opening hours', async () => {
  const f = fixture({ clinicHours: [{ ...allDays[1], hora_inicio: '11:00' }], doctorHours: [] });
  f.input.installation.horarios = [];
  const codes = (await inspectSeries(f.input))[0].conflicts.map((item) => item.code);
  assert.deepEqual(codes, ['CLINIC_OUT_OF_HOURS', 'INSTALLATION_OUT_OF_HOURS', 'STAFF_OUT_OF_HOURS']);
});

test('expands recurring staff blocks with exceptions and checks exact overlap', async () => {
  const weekly = { fecha_inicio: new Date('2030-01-07T09:00:00Z'), fecha_fin: new Date('2030-01-07T09:30:00Z'), recurrente: 'weekly', excepciones: [{ fecha: '2030-01-14', cancelado: true }] };
  const f = fixture({ blocks: [weekly] });
  const result = await inspectSeries(f.input);
  assert.equal(result[0].conflicts[0].code, 'STAFF_BLOCKED');
  assert.equal(result[1].conflicts.length, 0);
  weekly.fecha_inicio = new Date('2030-01-07T14:00:00Z');
  weekly.fecha_fin = new Date('2030-01-07T15:00:00Z');
  assert.equal((await inspectSeries(f.input))[0].conflicts.length, 0);
});

test('checks installation blocking and propagates transaction to every preload', async () => {
  const f = fixture({ installationBlocks: [{ fecha_inicio: '2030-01-07T08:59:00Z', fecha_fin: '2030-01-07T09:01:00Z', motivo: 'PRIVATE NOTE' }] });
  const transaction = { name: 'offline transaction' };
  f.input.transaction = transaction;
  const result = await inspectSeries(f.input);
  assert.equal(result[0].conflicts[0].code, 'INSTALLATION_BLOCKED');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE NOTE/);
  assert(f.calls.every(([, query]) => query.transaction === transaction));
});

function loadService({ reserved = [], conflict = false, expiresAt = null, sourceSystem = null } = {}) {
  const writes = [];
  const automation = [];
  const transaction = { LOCK: { UPDATE: 'update' } };
  const f = fixture({ appointments: conflict ? [{ doctor_id: 5, inicio: '2030-01-07T09:00:00Z', fin: '2030-01-07T09:30:00Z' }] : [] });
  const occupancy = f.input.db.CitaPaciente.findAll;
  const db = Object.assign(f.input.db, {
    sequelize: { transaction: async (callback) => callback(transaction) },
    PatientVoucher: { findOne: async () => ({ id: 1, public_id: 'offline', clinic_id: 72, patient_id: 1, treatment_id: 3, status: 'active', available_units: 2, expires_at: expiresAt, source_system: sourceSystem }) },
    PatientVoucherMovement: { findAll: async () => [] },
    Tratamiento: { findByPk: async () => ({ id_tratamiento: 3, nombre: 'Offline treatment', duracion_min: 30 }) },
    Clinica: { findByPk: async () => ({ configuracion: { timezone: 'Europe/Madrid' } }) },
    DoctorClinica: { findOne: async () => f.input.doctor }, DoctorHorario: {}, DoctorHorarioExcepcion: {},
    Instalacion: { findOne: async () => f.input.installation }, InstalacionHorario: {}, InstalacionBloqueo: {},
    Usuario: {},
    CitaPaciente: {
      findAll: async (query) => {
        if (query.where.voucher_id) {
          assert.equal(query.where.estado[Op.ne], 'cancelada');
          return reserved;
        }
        return occupancy(query);
      },
      create: async (values, options) => { assert.equal(options.transaction, transaction); writes.push(values); return { id_cita: writes.length, ...values }; },
    },
  });
  const runtime = {
    enqueueExecutionForCita: async (...args) => automation.push(['enqueue', ...args]),
    syncScheduledTriggersForCita: async (...args) => automation.push(['sync', ...args]),
  };
  const filename = path.resolve(__dirname, '../../services/patientVoucherAppointments.service.js');
  const context = { module: { exports: {} }, console, Date, require: (request) => {
    if (request === '../../models') return db;
    if (request === 'sequelize') return { Op };
    if (request === './appointmentAutomationV2Runtime.service') return runtime;
    return require(path.resolve(path.dirname(filename), request));
  } };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), context, { filename });
  return { service: context.module.exports, writes, automation };
}

const payload = { start_at: '2030-01-07T10:00:00+01:00', count: 2, interval_days: 7, doctor_id: 5, installation_id: 9 };

test('program vouchers cannot bypass their pending program planner through the ordinary series API', async () => {
  const f = loadService({ sourceSystem: 'treatment_program' });
  await assert.rejects(f.service.preview({ publicId: 'offline', payload }), { code: 'program_batch_booking_pending' });
  await assert.rejects(f.service.create({ publicId: 'offline', actorId: 1, payload }), { code: 'program_batch_booking_pending' });
  assert.equal(f.writes.length, 0);
  assert.equal(f.automation.length, 0);
});

test('explicit invalid count/duration must not silently use defaults', async () => {
  for (const change of [{ count: -2 }, { count: '2foo' }, { duration_minutes: -1 }, { duration_minutes: '30min' }]) {
    const f = loadService();
    await assert.rejects(f.service.preview({ publicId: 'offline', payload: { ...payload, ...change } }));
    assert.equal(f.writes.length, 0);
  }
});

test('reprogrammed linked appointment continues to reserve its voucher unit', async () => {
  const f = loadService({ reserved: [{ id_cita: 22, estado: 'reprogramada' }] });
  await assert.rejects(f.service.preview({ publicId: 'offline', payload }), { code: 'voucher_schedule_count_invalid' });
  assert.equal(f.writes.length, 0);
});

test('conflict prevents all series writes and all automation', async () => {
  const f = loadService({ conflict: true });
  await assert.rejects(f.service.create({ publicId: 'offline', actorId: 1, payload }), { code: 'voucher_schedule_conflicts' });
  assert.equal(f.writes.length, 0);
  assert.equal(f.automation.length, 0);
});

test('voucher expiry is visible in preview and prevents creation', async () => {
  const f = loadService({ expiresAt: '2030-01-10T00:00:00Z' });
  const preview = await f.service.preview({ publicId: 'offline', payload });
  assert.equal(preview.appointments[1].conflicts[0].code, 'VOUCHER_EXPIRED');
  await assert.rejects(f.service.create({ publicId: 'offline', actorId: 1, payload }), { code: 'voucher_schedule_conflicts' });
});

test('valid series creates once per appointment and keeps ordinary post-commit automation', async () => {
  const f = loadService();
  const result = await f.service.create({ publicId: 'offline', actorId: 1, payload });
  assert.equal(result.created.length, 2);
  assert.equal(f.writes.length, 2);
  assert.equal(f.automation.filter(([kind]) => kind === 'enqueue').length, 2);
});

test('booking profile separates alternatives, priority and mandatory team', () => {
  const profile = normalizeBookingProfile({ version: 1, phases: [{ duration_minutes: 30, installation_ids: [9, '9', 12], professionals: { mode: 'any', ids: [5] } }] });
  assert.deepEqual(profile.phases[0].installation_ids, [9, 12]);
  assert.equal(profile.phases[0].professionals.preferred_id, 5);
  assert.equal(requiresMultiResourceBooking(profile), false);
  assert.throws(() => normalizeBookingProfile({ version: 1, phases: [{ duration_minutes: 30, installation_ids: [9], professionals: { mode: 'any', ids: [5, 6] } }] }), { code: 'booking_profile_invalid' });
  profile.phases[0].professionals = { mode: 'all', ids: [5, 6], preferred_id: null };
  assert.equal(requiresMultiResourceBooking(normalizeBookingProfile(profile)), true);
  const draft = normalizeBookingProfile({ version: 1, phases: [{}] }, { allowIncomplete: true });
  assert.equal(draft.phases[0].duration_minutes, null);
  assert.throws(() => normalizeBookingProfile(draft), { code: 'booking_profile_invalid' });
});
