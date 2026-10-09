'use strict';

// Real availability HTTP handlers, with explicit synthetic ACL/patient resolver
// and calendars. This tests scoped wiring, not authentication or real SQL.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), { createRequire } = require('node:module');
const S = require('sequelize');
const profileService = require('../../services/treatmentBookingProfile.service');
const filename = require.resolve('../../controllers/disponibilidad.controller'), local = createRequire(filename);
const caps = { simple: true, multi: true, relativeSteps: true, equipment: true };
function fixture({ denied = null, existing = null, resolverFails = false, patientBusy = true } = {}) {
  const acl = [], resolved = [], calendars = [], searches = [];
  const clinic = { id_clinica: 100, grupoClinicaId: 50, configuracion: { timezone: 'Europe/Madrid' } };
  const profile = { version: 1, phases: [{ key: 'care', duration_minutes: 30, installation_ids: [101], professionals: { mode: 'any', ids: [1], preferred_id: 1 } }] };
  const treatment = { id_tratamiento: 4, clinica_id: 100, origen: 'clinica', activo: true, clinical_config: { catalog_status: 'active', booking_profile: profile } };
  const db = { Sequelize: S, Clinica: { findByPk: async id => Number(id) === 100 ? clinic : null },
    Tratamiento: { findByPk: async id => Number(id) === 4 ? treatment : null },
    CitaPaciente: { findByPk: async id => existing && Number(id) === Number(existing.id_cita) ? existing : null } };
  const free = () => ({ windows: [{ start: '2030-01-01T00:00:00Z', end: '2031-01-01T00:00:00Z' }], busy: [], clinic_id: 100 });
  const availability = local('../services/appointmentBookingAvailability.service');
  const exported = {};
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { exports: exported, console, Date, Map, Set, Promise,
    require: name => name === '../../models' ? db : name === 'express-async-handler' ? fn => fn
      : name === '../lib/access-policy' ? { assertUserCanAccessFeature: async input => { acl.push(input); if (input.featureKey === denied) throw Object.assign(Error('Synthetic permission denied'), { statusCode: 403 }); } }
        : name === '../services/patientEconomics.service' ? { loadContext: async (identifier, clinicId) => {
          resolved.push([identifier, clinicId]); if (resolverFails || identifier !== 'synthetic-public-patient' || clinicId !== 100) throw Object.assign(Error('Patient not in clinic'), { statusCode: 404 });
          return { patient: { id_paciente: 1 }, clinic };
        } }
          : name === '../services/treatmentBookingProfile.service' ? { ...profileService, bookingCapabilities: () => caps,
            requireOperationalProfile: (row, options) => profileService.requireOperationalProfile(row, { capabilities: caps, ...options }) }
            : name === '../services/appointmentBookingAvailability.service' ? { ...availability,
              searchTreatmentSlots: async input => { searches.push(input); return { slots: [], timezone: 'Europe/Madrid' }; },
              loadBookingContext: async input => { calendars.push(input); return { doctors: new Map([[1, { ...free(), name: 'Synthetic target' }]]),
                installations: new Map([[101, { ...free(), name: 'Synthetic room', profesionales_permitidos: [1] }]]), installationKeys: new Map([[101, 'installation:101']]),
                timeZone: 'Europe/Madrid', patientBusy: patientBusy && Number(input.patientId) === 1 ? [{ start: '2030-01-07T09:00:00Z', end: '2030-01-07T09:30:00Z', appointment_id: 200, doctor_id: 2, clinic_id: 100 }] : [] }; } }
              : local(name),
  }, { filename });
  const query = { clinica_id: '100', tratamiento_id: '4', doctor_id: '1', instalacion_id: '101', inicio_local: '2030-01-07T10:00',
    fin_local: '2030-01-07T10:30', fecha_local: '2030-01-07', dates: ['2030-01-07'], column_ids: ['1'], mode: 'doctor', duracion_min: '30', limit: '100' };
  const invoke = async (handler, patch = {}) => { const response = { statusCode: 200, status(value) { this.statusCode = value; return this; }, json(body) { this.body = body; return this; } };
    await exported[handler]({ userData: { userId: 9 }, query: { ...query, ...patch } }, response); return response; };
  return { invoke, acl, resolved, calendars, searches, clinic, profile };
}
test('ordinary public patient identifier is resolved after scoped view+sensitive ACLs in every profile preview circuit', async () => {
  for (const handler of ['check', 'treatmentSlots', 'slots', 'grid', 'summary']) {
    const f = fixture(); await f.invoke(handler, { patient_id: 'synthetic-public-patient' });
    assert.deepEqual(f.acl.map(row => row.featureKey), ['appointments.view', 'patients.view', 'patients.sensitive.view']);
    assert(f.acl.every(row => row.actorId === 9 && row.clinicId === 100)); assert.deepEqual(f.resolved, [['synthetic-public-patient', 100]]);
    assert.equal((handler === 'treatmentSlots' ? f.searches : f.calendars)[0].patientId, 1);
  }
});
test('paciente_id alias forwards only the server-resolved ID; no identifier keeps generic ordinary availability unchanged', async () => {
  const alias = fixture(); await alias.invoke('check', { paciente_id: 'synthetic-public-patient' }); assert.equal(alias.calendars[0].patientId, 1);
  const generic = fixture(); const response = await generic.invoke('check'); assert.equal(response.body.available, true);
  assert.deepEqual(generic.acl.map(row => row.featureKey), ['appointments.view']); assert.equal(generic.resolved.length, 0); assert.equal(generic.calendars[0].patientId, undefined);
});
test('ordinary patient preview denies before occupancy reads when either patient ACL or membership resolution fails', async () => {
  for (const denied of ['patients.view', 'patients.sensitive.view']) {
    const f = fixture({ denied }); await assert.rejects(f.invoke('check', { patient_id: 'synthetic-public-patient' }), { statusCode: 403 });
    assert.equal(f.resolved.length, 0); assert.equal(f.calendars.length, 0);
  }
  const absent = fixture({ resolverFails: true }); await assert.rejects(absent.invoke('treatmentSlots', { patient_id: 'synthetic-public-patient' }), { statusCode: 404 });
  assert.equal(absent.searches.length, 0);
});
test('existing canonical appointment infers server patient in all circuits and only excludes its own ID', async () => {
  for (const handler of ['check', 'treatmentSlots', 'slots', 'grid', 'summary']) {
    const f = fixture({ existing: { id_cita: 70, clinica_id: 100, paciente_id: 1, tratamiento_id: 4, voucher_id: null,
      inicio: '2030-01-07T11:00:00Z', fin: '2030-01-07T11:30:00Z', estado: 'pendiente', import_metadata: {} } });
    await f.invoke(handler, { ignore_cita_id: '70' }); const context = (handler === 'treatmentSlots' ? f.searches : f.calendars)[0];
    assert.equal(context.patientId, 1); assert.equal(Number(context.existingAppointmentId ?? context.ignoreAppointmentId), 70);
    assert.equal(f.resolved.length, 0);
  }
});
test('foreign clinic, different treatment, unknown appointment and explicit patient mismatch fail before calendar access', async () => {
  const base = { id_cita: 70, clinica_id: 100, paciente_id: 1, tratamiento_id: 4, estado: 'pendiente' };
  for (const existing of [{ ...base, clinica_id: 200 }, { ...base, tratamiento_id: 99 }, { ...base, paciente_id: 2 }, null]) {
    const f = fixture({ existing }); await assert.rejects(f.invoke('check', { ignore_cita_id: 70, patient_id: 'synthetic-public-patient' }), { code: 'appointment_not_found', statusCode: 404 });
    assert.equal(f.calendars.length, 0);
  }
});
test('patient collision explains its time with a separate acknowledgement, without identity or source appointment IDs', async () => {
  const f = fixture(); const response = await f.invoke('check', { patient_id: 'synthetic-public-patient', force: true });
  assert.equal(response.statusCode, 409); assert.equal(response.body.reason, 'restriction'); assert.equal(response.body.can_force, false);
  assert.equal(response.body.can_confirm_restrictions, true); assert.match(response.body.booking_restriction_acknowledgement, /^[a-f0-9]{64}$/);
  assert.match(response.body.booking_restrictions[0].message, /10:00.*10:30/);
  assert.doesNotMatch(JSON.stringify(response.body.booking_restrictions), /appointment_id|doctor_id|clinic_id|patient_id|paciente_id/);
});
test('ordinary slots/grid/summary use patient calendars but preserve available alternatives outside the busy interval', async () => {
  const f = fixture(); const response = await f.invoke('slots', { patient_id: 'synthetic-public-patient', from_local: '10:00', to_local: '11:00', granularity_min: '15' });
  assert(response.body.slots.every(row => row.start_at >= '2030-01-07T09:30:00.000Z')); assert(response.body.slots.length > 0);
});
