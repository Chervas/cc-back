'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const controllerPath = require.resolve('../../controllers/disponibilidad.controller');
const localRequire = createRequire(controllerPath);
const code = fs.readFileSync(controllerPath, 'utf8');
const start = new Date('2030-01-07T09:00:00Z'), end = new Date('2030-01-07T09:30:00Z');

function fixture({ busy = false, denied = false, enabled = true, foreignIgnore = false } = {}) {
  const calls = { acl: 0, context: 0, writes: 0 };
  const clinic = { id_clinica: 72, grupoClinicaId: 29, configuracion: { timezone: 'Europe/Madrid' } };
  const db = { Sequelize: { Op: {} }, Clinica: { findByPk: async () => clinic },
    Instalacion: { findByPk: async () => ({ id: 9, clinica_id: 72, activo: true, profesionales_permitidos: [5],
      horarios: [{ dia_semana: 1, activo: true, hora_inicio: '09:00', hora_fin: '18:00' }], bloqueos: [] }) },
    CitaPaciente: { findByPk: async () => ({ id_cita: 2, clinica_id: foreignIgnore ? 99 : 72 }) },
    ClinicaHorario: { findAll: async () => [] } };
  const context = { doctors: new Map([[6, { windows: [{ start: new Date('2030-01-07T07:00:00Z'), end: new Date('2030-01-07T19:00:00Z') }],
    busy: busy ? [{ start, end }] : [] }]]) };
  const exported = {};
  vm.runInNewContext(code, { exports: exported, console, Date, Map, Set, Promise,
    require: name => {
      if (name === '../../models') return db;
      if (name === '../services/appointmentResourceCalendar.service') return {
        resourceAppointments: async () => [], resourceInstallationBlocks: async () => [],
      };
      if (name === 'express-async-handler') return fn => fn;
      if (name === '../lib/access-policy') return { assertUserCanAccessFeature: async args => {
        calls.acl++; assert.equal(args.clinicId, 72);
        if (denied) throw Object.assign(Error('denied'), { statusCode: 403 });
      } };
      if (name === '../services/treatmentBookingProfile.service') return { ...localRequire(name), bookingCapabilities: () => ({ simple: enabled, multi: enabled }) };
      if (name === '../services/appointmentBookingAvailability.service') return { ...localRequire(name), loadBookingContext: async args => {
        calls.context++;
        assert.deepEqual(Array.from(args.additionalStaffIds), [6]);
        assert.equal(args.occupancyEnabled, true);
        return context;
      } };
      return localRequire(name);
    },
  }, { filename: controllerPath });
  const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(value) { this.body = value; return this; } };
  return { calls, response, check: (extra = {}) => exported.check({ userData: { userId: 1 }, query: {
    clinica_id: '72', inicio_local: '2030-01-07T10:00:00', fin_local: '2030-01-07T10:30:00',
    'additional_staff_ids[]': ['6'], ...extra } }, response) };
}

test('HTTP check blocks occupied support without disclosing another appointment', async () => {
  const f = fixture({ busy: true });
  await f.check({ force: 'true' });
  assert.equal(f.response.statusCode, 409);
  assert.equal(f.response.body.can_force, false);
  assert.equal(f.calls.acl, 1); assert.equal(f.calls.context, 1);
  assert.doesNotMatch(JSON.stringify(f.response.body), /paciente_id|cita_ids|patient_id|source_reference/);
});

test('HTTP rejects a disallowed installation/support pairing with 409, including force, without a ReferenceError', async () => {
  const f = fixture();
  await f.check({ instalacion_id: '9', force: 'true' });
  assert.equal(f.response.statusCode, 409);
  assert.equal(f.response.body.can_force, false);
  assert(f.response.body.resource_conflicts.some(row => row.code === 'INSTALLATION_PROFESSIONAL_NOT_ALLOWED'));
});

test('HTTP check authorizes clinic before reading supporting staff availability', async () => {
  const f = fixture({ denied: true });
  await assert.rejects(f.check(), { statusCode: 403 });
  assert.equal(f.calls.context, 0);
});

test('HTTP check cannot exclude another clinic appointment from support occupancy', async () => {
  const f = fixture({ foreignIgnore: true });
  await f.check({ ignore_cita_id: '2' });
  assert.equal(f.response.statusCode, 404);
  assert.equal(f.calls.context, 0);
});

test('HTTP check fails closed with unsupported gates or malformed support IDs', async () => {
  const f = fixture({ enabled: false });
  await assert.rejects(f.check(), { code: 'booking_profile_runtime_unavailable' });
  assert.equal(f.calls.context, 0);
  const g = fixture();
  await assert.rejects(g.check({ 'additional_staff_ids[]': ['6x'] }), { code: 'booking_additional_staff_invalid' });
  assert.equal(g.calls.context, 0);
});
