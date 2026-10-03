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

function fixture({ enabled = true, equipment = true, denied = false, busy = false, multiplePhases = false } = {}) {
  const clinic = { id_clinica: 1, grupoClinicaId: null, nombre_clinica: 'Fictitious test',
    configuracion: { timezone: 'Europe/Madrid' }, equipment_booking_enabled: enabled };
  const profile = { version: equipment ? 2 : 1, phases: [{ key: 'care', duration_minutes: 30,
    installation_ids: [9], professionals: { mode: 'any', ids: [5], preferred_id: 5 },
    ...(equipment ? { equipment_requirements: [{ equipment_ids: [6] }] } : {}) }] };
  if (multiplePhases) profile.phases.push({ ...profile.phases[0], key: 'second' });
  const calls = { clinic: 0, acl: 0, context: 0, equipment: 0, solve: 0 };
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
        }, solutionsForCalendar: args => {
          calls.solve++;
          assert.equal(args.profile, profile);
          return busy ? [] : [{ start_local: args.date + 'T10:00:00', end_local: args.date + 'T10:30:00' }];
        },
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
  return { calls, response, request, check: () => exported.check(request, response), slots: () => exported.slots(request, response),
    grid: query => exported.grid({ ...request, query: { clinica_id: '1', tratamiento_id: '10', duracion_min: '30',
      dates: ['2030-01-07', '2030-01-08'], mode: 'doctor', column_ids: [5, 6], peer_instalacion_ids: [9, 10], ...query } }, response) };
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
test('ordinary slots uses the canonical solver for one phase with equipment', async () => {
  const f = fixture(); await f.slots();
  assert.equal(f.response.statusCode, 200); assert.equal(f.response.body.slots.length, 1);
  assert.equal(f.calls.context, 1); assert.equal(f.calls.equipment, 1); assert.equal(f.calls.solve, 1);
});
test('single-phase slots stay closed when the machine is occupied or opt-in is off', async () => {
  const f = fixture({ busy: true }); await f.slots(); assert.equal(f.response.body.slots.length, 0);
  await assert.rejects(fixture({ enabled: false }).slots(), { code: 'booking_equipment_disabled' });
});
test('multi-phase grid is explicit rather than painting only the first phase', async () => {
  const f = fixture({ multiplePhases: true });
  await assert.rejects(f.slots(), { code: 'booking_profile_use_treatment_slots' });
  await assert.rejects(f.grid(), { code: 'booking_profile_use_treatment_slots' });
  assert.equal(f.calls.context, 0);
});
test('treatment weekly grid loads one context and skips incompatible columns before solving', async () => {
  const f = fixture(); await f.grid();
  assert.equal(f.calls.acl, 1); assert.equal(f.calls.clinic, 1); assert.equal(f.calls.context, 1);
  assert.equal(f.calls.equipment, 1); assert.equal(f.calls.solve, 2);
  assert.equal(f.response.body.rows.length, 4);
  for (const row of f.response.body.rows) {
    assert.equal(row.ok, true);
    assert.equal(row.slots_by_instalacion[9].length, row.column_id === '5' ? 1 : 0);
    assert.equal(row.slots_by_instalacion[10].length, 0);
  }
  await f.grid(); assert.equal(f.calls.context, 2, 'a new request must reload occupancy');
});
test('grid respects ACL and clinic equipment opt-in before computing any slots', async () => {
  const f = fixture({ denied: true }); await assert.rejects(f.grid(), { statusCode: 403 });
  assert.equal(f.calls.context, 0);
  await assert.rejects(fixture({ enabled: false }).grid(), { code: 'booking_equipment_disabled' });
});
test('ordinary profile grid does not query equipment and oversized ranges fail early', async () => {
  const f = fixture({ equipment: false, enabled: false }); await f.grid({ mode: 'installation', column_ids: [9, 10], peer_doctor_ids: [5, 6] });
  assert.equal(f.calls.equipment, 0); assert.equal(f.calls.context, 1);
  const invalid = fixture(); await invalid.grid({ dates: ['2030-01-07', '2031-01-07'] });
  assert.equal(invalid.response.statusCode, 400); assert.equal(invalid.calls.context, 0);
});
