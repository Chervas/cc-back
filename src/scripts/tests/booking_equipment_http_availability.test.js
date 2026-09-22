'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const controllerPath = require.resolve('../../controllers/disponibilidad.controller');
const localRequire = createRequire(controllerPath);
const { assertEquipmentEnabled } = localRequire('../services/bookingEquipmentAvailability.service');
const source = fs.readFileSync(controllerPath, 'utf8');

function fixture({ enabled = true, equipment = true, denied = false, busy = false } = {}) {
  const clinic = { id_clinica: 1, grupoClinicaId: null, nombre_clinica: 'Fictitious test',
    configuracion: { timezone: 'Europe/Madrid' }, equipment_booking_enabled: enabled };
  const profile = { version: equipment ? 2 : 1, phases: [{ key: 'care', duration_minutes: 30,
    installation_ids: [9], professionals: { mode: 'any', ids: [5], preferred_id: 5 },
    ...(equipment ? { equipment_requirements: [{ equipment_ids: [6] }] } : {}) }] };
  const calls = { clinic: 0, acl: 0, context: 0, equipment: 0 };
  const db = { Sequelize: { Op: {} }, Clinica: { findByPk: async (id, options = {}) => {
    calls.clinic++; assert.equal(id, 1);
    // Emulate SQL projection, rather than returning fields the controller did
    // not request. This catches a real failure hidden by broader ORM stubs.
    return options.attributes ? Object.fromEntries(options.attributes.map(key => [key, clinic[key]])) : { ...clinic };
  } } };
  const exported = {};
  vm.runInNewContext(source, { exports: exported, console, Date, Map, Set, Promise,
    require: name => {
      if (name === '../../models') return db;
      if (name === 'express-async-handler') return fn => fn;
      if (name === '../lib/access-policy') return { assertUserCanAccessFeature: async () => {
        calls.acl++; if (denied) throw Object.assign(Error('denied'), { statusCode: 403 });
      } };
      if (name === '../services/treatmentBookingProfile.service') return {
        ...localRequire(name), loadScopedTreatment: async () => ({}), requireOperationalProfile: () => profile,
        bookingCapabilities: () => ({ simple: true, multi: true }),
      };
      if (name === '../services/appointmentBookingAvailability.service') return {
        loadBookingContext: async args => {
          calls.context++;
          if (equipment) { calls.equipment++; assertEquipmentEnabled(args.clinic, true); }
          return {};
        }, solutionsForCalendar: () => [],
      };
      if (name === '../lib/booking-profile-solver') return {
        ...localRequire(name), solveBookingProfile: () => busy ? null : {
          end_at: '2030-01-07T09:30:00.000Z', phases: [{ doctor_ids: [5], installation_id: 9 }], warnings: [],
        },
      };
      return localRequire(name);
    },
  }, { filename: controllerPath });
  const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } };
  const request = { userData: { userId: 1 }, query: { clinica_id: '1', tratamiento_id: '10', doctor_id: '5', instalacion_id: '9',
    inicio_local: '2030-01-07T10:00', fin_local: '2030-01-07T10:30', fecha_local: '2030-01-07', duracion_min: '30' } };
  return { calls, response, check: () => exported.check(request, response), slots: () => exported.slots(request, response) };
}

test('exact-slot HTTP check retains clinic equipment opt-in in its SQL projection', async () => {
  const f = fixture(); await f.check();
  assert.equal(f.response.statusCode, 200); assert.equal(f.response.body.available, true);
  assert.equal(f.calls.clinic, 1); assert.equal(f.calls.context, 1); assert.equal(f.calls.equipment, 1);
});
test('exact-slot HTTP check still rejects a clinic without equipment opt-in', async () => {
  const f = fixture({ enabled: false }); await assert.rejects(f.check(), { code: 'booking_equipment_disabled' });
});
test('equipment collision cannot be forced and does not disclose another appointment', async () => {
  const f = fixture({ busy: true }); await f.check();
  assert.equal(f.response.statusCode, 409); assert.equal(f.response.body.can_force, false);
  assert.doesNotMatch(JSON.stringify(f.response.body), /patient_id|paciente_id|cita_ids|source_reference/);
});
test('equipment check requires clinic permission before consulting availability', async () => {
  const f = fixture({ denied: true }); await assert.rejects(f.check(), { statusCode: 403 });
  assert.equal(f.calls.context, 0);
});
test('ordinary HTTP check and slots do not consult equipment metadata', async () => {
  for (const enabled of [true, false]) {
    const f = fixture({ equipment: false, enabled }); await f.check(); await f.slots();
    assert.equal(f.response.statusCode, 200); assert.equal(f.calls.equipment, 0);
    assert.equal(f.calls.clinic, 2); assert.equal(f.calls.context, 2);
  }
});
test('legacy slots rejects equipment profiles in favor of the canonical treatment search', async () => {
  const f = fixture(); await f.slots();
  assert.equal(f.response.statusCode, 409); assert.equal(f.response.body.code, 'booking_profile_use_treatment_slots');
  assert.equal(f.calls.context, 0);
});
