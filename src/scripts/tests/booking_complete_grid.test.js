'use strict';
// Real controller, calendar solver and diagnostics; fictional resources, no SQL
// or providers. Every column constrains only the starting phase of a FULL plan.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const file = require.resolve('../../controllers/disponibilidad.controller'), localRequire = createRequire(file);
const { normalizeBookingProfile } = localRequire('../lib/booking-profile');
const actualAvailability = localRequire('../services/appointmentBookingAvailability.service');
const time = minutes => new Date(Date.parse('2030-01-07T09:00:00Z') + minutes * 60000);
const phase = (key, offset, minutes, doctor, room) => ({ key, label: key, start_offset_minutes: offset,
  duration_minutes: minutes, installation_ids: [room], professionals: { mode: 'any', ids: [doctor], preferred_id: doctor } });
function fixture(mutate = () => {}) {
  const raw = { version: 4, phases: [phase('extraction', 0, 13, 5, 9), phase('application', 13, 17, 6, 10)] };
  const windows = [{ start: time(0), end: time(180) }];
  const context = { timeZone: 'Europe/Madrid', clinicWindows: windows, patientBusy: [], personalBlocks: [],
    doctors: new Map([5, 6, 7].map(id => [id, { name: `Profesional ficticio ${id}`, windows, busy: [], attention_visits: [] }])),
    installations: new Map([9, 10].map(id => [id, { name: `Sala ficticia ${id}`, windows, busy: [], resource_key: `room:${id}` }])),
    equipment: new Map([[1, { id: 1, name: 'Máquina ficticia', status: 'available', installation_ids: new Set([10]), turnaround_minutes: 0, busy: [] }]]) };
  mutate(raw, context); const profile = normalizeBookingProfile(raw), counts = { acl: 0, context: 0 };
  const clinic = { id_clinica: 72, configuracion: { timezone: 'Europe/Madrid' }, equipment_booking_enabled: true };
  const exported = {};
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { exports: exported, console, Date, Map, Set, Promise,
    require: name => {
      if (name === '../../models') return { Sequelize: { Op: {} }, Clinica: { findByPk: async () => clinic } };
      if (name === 'express-async-handler') return fn => fn;
      if (name === '../lib/access-policy') return { assertUserCanAccessFeature: async () => { counts.acl++; } };
      if (name === '../services/treatmentBookingProfile.service') return { ...localRequire(name),
        loadScopedTreatment: async () => ({}), requireOperationalProfile: () => profile,
        bookingCapabilities: () => ({ simple: true, multi: true, relativeSteps: true }) };
      if (name === '../services/patientEconomics.service') return { loadContext: async id => {
        assert.equal(id, 'fictional-public-id'); return { patient: { id_paciente: 42 } }; } };
      if (name === '../services/appointmentBookingAvailability.service') return { ...actualAvailability,
        loadBookingContext: async args => { counts.context++; assert.equal(args.occupancyEnabled, true);
          assert.equal(args.includeDiagnosticLabels, true); return { ...context, patientBusy: args.patientId ? context.patientBusy : [] }; } };
      return localRequire(name);
    } });
  async function grid(mode = 'installation', extra = {}) {
    const res = { json(body) { this.body = body; return this; }, status(status) { this.statusCode = status; return this; } };
    await exported.grid({ userData: { userId: 1 }, query: { clinica_id: '72', tratamiento_id: '99', complete_plan: 'true',
      dates: ['2030-01-07'], duracion_min: '30', granularity_min: '5', from_local: '10:00', to_local: '13:00', mode,
      ...(mode === 'installation' ? { column_ids: [9, 10], peer_doctor_ids: [5, 6, 7] }
        : { column_ids: [5, 6, 7], peer_instalacion_ids: [9, 10] }), ...extra } }, res);
    return res.body;
  }
  return { grid, profile, context, counts };
}
function pair(body, mode = 'installation', doctor = 5, room = 9) {
  const row = body.rows.find(row => row.column_id === String(mode === 'installation' ? room : doctor));
  assert.equal(row.ok, true);
  return { slots: row[mode === 'installation' ? 'slots_by_doctor' : 'slots_by_instalacion'][mode === 'installation' ? doctor : room],
    reasons: row[mode === 'installation' ? 'unavailable_by_doctor' : 'unavailable_by_instalacion'][mode === 'installation' ? doctor : room] };
}
test('preview without patient returns full plans in both column orders, with one snapshot per request', async () => {
  const f = fixture(), installations = await f.grid(), doctors = await f.grid('doctor');
  const a = pair(installations), b = pair(doctors, 'doctor');
  assert.deepEqual(JSON.parse(JSON.stringify(a)), JSON.parse(JSON.stringify(b)));
  assert(a.slots.some(slot => slot.start_local === '2030-01-07T10:00'));
  for (const slot of a.slots) { assert.equal(slot.phases.length, 2); assert.equal(slot.phases[1].doctor_ids[0], 6);
    assert.equal(slot.phases[1].installation_id, 10); assert.equal(+new Date(slot.end_at) - +new Date(slot.start_at), 30 * 60000);
    assert.equal(+new Date(slot.phases[1].start_at) - +new Date(slot.start_at), 13 * 60000); assert(slot.booking_plan_sha256); }
  assert.equal(installations.duracion_min, 30); assert.equal(f.counts.context, 2); assert.equal(f.counts.acl, 2);
  assert.equal(pair(installations, 'installation', 6, 10).slots.length, 0, 'the later phase is not a visit start');
  assert.match(pair(installations, 'installation', 6, 10).reasons[0].resource_conflicts[0].details.message, /no está asignado.*Profesional ficticio 5[\s\S]*Sala ficticia 9/);
});
test('second-phase professional, room and machine conflicts reject starts in BOTH orientations at their real offset', async () => {
  for (const resource of ['professional', 'room', 'machine']) {
    const f = fixture((raw, context) => {
      const target = resource === 'professional' ? context.doctors.get(6) : resource === 'room' ? context.installations.get(10) : context.equipment.get(1);
      if (resource === 'machine') raw.phases[1].equipment_requirements = [{ equipment_ids: [1] }];
      target.busy.push({ start: time(13), end: time(30) });
    });
    for (const mode of ['installation', 'doctor']) {
      const value = pair(await f.grid(mode), mode);
      assert(!value.slots.some(slot => slot.start_local === '2030-01-07T10:00'));
      const reason = value.reasons.find(row => row.start_local === '2030-01-07T10:00').resource_conflicts[0];
      assert.equal(reason.details.phase_key, 'application'); assert.equal(reason.details.start_offset_minutes, 13);
      assert.doesNotMatch(reason.details.message, /clínica.*cerrada|clínica.*fuera de/i);
    }
  }
});
test('ALL starting team remains complete on every member column; a busy member invalidates all', async () => {
  for (const busy of [false, true]) {
    const f = fixture((raw, context) => { raw.phases[0].professionals = { mode: 'all', ids: [5, 7], preferred_id: null };
      if (busy) context.doctors.get(7).busy.push({ start: time(0), end: time(180) }); });
    for (const mode of ['installation', 'doctor']) for (const doctor of [5, 7]) {
      const value = pair(await f.grid(mode), mode, doctor);
      assert.equal(value.slots.length > 0, !busy);
      for (const slot of value.slots) assert.deepEqual([...slot.phases[0].doctor_ids], [5, 7]);
    }
  }
});
test('temporal first phase, not array order, anchors the visit start', async () => {
  const f = fixture(raw => raw.phases.reverse());
  const body = await f.grid(); assert(pair(body).slots.length > 0);
  assert.equal(pair(body, 'installation', 6, 10).slots.length, 0);
});
test('selecting a patient recalculates occupancy without hiding the patientless resource preview', async () => {
  const f = fixture((raw, context) => context.patientBusy.push({ start: time(0), end: time(180) }));
  assert(pair(await f.grid()).slots.length > 0);
  const value = pair(await f.grid('installation', { patient_id: 'fictional-public-id' }));
  assert.equal(value.slots.length, 0);
  assert.equal(value.reasons.find(row => row.start_local === '2030-01-07T10:00').resource_conflicts[0].details.reason_key, 'patient_busy');
  assert.equal(f.counts.context, 2); assert.equal(f.counts.acl, 4);
});
test('complete preview is opt-in; flat mono grid still cannot pretend to check multiple phases', async () => {
  const f = fixture(); await assert.rejects(f.grid('installation', { complete_plan: undefined }), { code: 'booking_profile_use_treatment_slots' });
  assert.equal(f.counts.context, 0);
});
