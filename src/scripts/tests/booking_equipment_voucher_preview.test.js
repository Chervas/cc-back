'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = require.resolve('../../services/patientVoucherAppointments.service');
const localRequire = createRequire(filename);
const { assertEquipmentEnabled } = localRequire('./bookingEquipmentAvailability.service');
function fixture(enabled = true) {
  const calls = { clinics: 0, contexts: 0, writes: 0 };
  const clinic = { id_clinica: 1, configuracion: { timezone: 'Europe/Madrid' }, grupoClinicaId: null, equipment_booking_enabled: enabled };
  const profile = { version: 2, phases: [{ key: 'care', duration_minutes: 30, installation_ids: [9],
    professionals: { mode: 'any', ids: [5], preferred_id: 5 }, equipment_requirements: [{ equipment_ids: [6] }] }] };
  const db = {
    PatientVoucher: { findOne: async () => ({ id: 1, public_id: 'fictitious-voucher', clinic_id: 1, patient_id: 1,
      treatment_id: 1, status: 'active', available_units: 2, name: 'Fictitious machine voucher', source_system: null }) },
    Clinica: { findByPk: async (id, { attributes }) => { calls.clinics++; return Object.fromEntries(attributes.map(key => [key, clinic[key]])); } },
    CitaPaciente: { findAll: async () => [], create: async () => { calls.writes++; throw Error('Preview must not write'); } },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, console, Date, Map, Set, Promise,
    require: name => {
      if (name === '../../models') return db;
      if (name === './appointmentAutomationV2Runtime.service') return {};
      if (name === './treatmentBookingProfile.service') return {
        ...localRequire(name), loadScopedTreatment: async () => ({ id_tratamiento: 1, nombre: 'Fictitious equipment treatment' }),
        requireOperationalProfile: () => profile,
      };
      if (name === './appointmentBookingAvailability.service') return { loadBookingContext: async ({ clinic }) => {
        calls.contexts++; assertEquipmentEnabled(clinic, true); return {};
      } };
      if (name === '../lib/booking-profile-solver') return { solveBookingProfile: ({ start }) => ({
        end_at: new Date(start.getTime() + 30 * 60000).toISOString(), warnings: [], requires_priority_acknowledgement: false,
        phases: [{ equipment: [{ id: 6, name: 'Fictitious EXION' }] }],
      }) };
      return localRequire(name);
    },
  }, { filename });
  return { calls, preview: () => module.exports.preview({ publicId: 'fictitious-voucher', payload: { count: 2,
    interval_days: 7, start_at: '2030-01-07T10:00:00+01:00' } }) };
}
test('voucher preview preserves equipment opt-in and loads one context for the whole series', async () => {
  const f = fixture(), plan = await f.preview();
  assert.equal(plan.has_conflicts, false); assert.equal(plan.appointments.length, 2);
  assert(plan.appointments.every(a => a.phases[0].equipment[0].id === 6));
  assert.deepEqual(f.calls, { clinics: 1, contexts: 1, writes: 0 });
});
test('voucher preview cannot bypass a disabled clinic equipment feature', async () => {
  const f = fixture(false); await assert.rejects(f.preview(), { code: 'booking_equipment_disabled' });
  assert.equal(f.calls.writes, 0);
});
