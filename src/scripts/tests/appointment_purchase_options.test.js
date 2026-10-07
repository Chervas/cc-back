'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), vm = require('node:vm');
const { Op } = require('sequelize');
function fixture() {
  const calls = [], writes = () => { throw Error('Read projection must not write'); };
  const voucher = { id: 1, public_id: 'voucher-1', clinic_id: 72, patient_id: 8, status: 'active', source_system: 'clinicaclick', treatment_id: 4, name: 'Bono', unit_label: 'sesiones', available_units: 4 };
  const state = { vouchers: [voucher], appointments: [{ id_cita: 11, voucher_id: 1 }, { id_cita: 12, voucher_id: 1 }], consumptions: [{ voucher_id: 1, appointment_id: 11 }], planError: null };
  const model = (name, rows) => ({ create: writes, update: writes, destroy: writes, findAll: async input => { calls.push({ name, input }); return rows(); } });
  const db = { Sequelize: { Op }, PatientVoucher: model('vouchers', () => state.vouchers), PatientVoucherMovement: model('movements', () => state.consumptions), CitaPaciente: model('appointments', () => state.appointments) };
  db.CitaPaciente.findAll = async input => { calls.push({ name: 'appointments', input }); return input.group ? [{ tratamiento_id: 4 }] : state.appointments; };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../services/appointmentPurchaseOptions.service'), 'utf8'), { module, Date, Number, String, Math,
    require: path => path === './voucherScheduleAvailability.service' ? { activeAppointmentWhere: () => ({ estado: { [Op.ne]: 'cancelada' } }) }
      : path === './treatmentBookingProfile.service' ? { loadScopedTreatment: async ({ treatmentId, clinic }) => { assert.equal(treatmentId, 4); assert.equal(clinic.id_clinica, 72); return { nombre: 'Nombre sin cambiar', clinical_config: { catalog_badge: 'Antiguo' } }; }, requireOperationalProfile: () => null }
        : path === '../lib/treatment-commercial-policy' ? { assertStandalone: () => {} }
          : path === '../lib/treatment-booking-visibility' ? require('../../lib/treatment-booking-visibility') : (() => { throw Error(path); })(),
  });
  const service = module.exports.createAppointmentPurchaseOptions({ db,
    economics: { loadContext: async (patient, clinic) => { assert.equal(patient, 'pac-test'); assert.equal(clinic, 72); return { patient: { id_paciente: 8 }, clinic: { id_clinica: 72 } }; } },
    programs: { read: async input => { assert.equal(input.clinicId, 72); assert.equal(input.actorId, 3); if (state.planError) throw state.planError; return { kind: 'voucher', name: 'Bono de programa', pending_count: 2, can_schedule: true, sessions: [{ scheduling_status: 'pending', label: 'Sesión 2' }] }; } },
    now: () => new Date('2026-10-05T10:00:00Z'),
  });
  return { state, calls, read: () => service.read({ clinicId: 72, patientIdentifier: 'pac-test', actorId: 3 }) };
}
test('scoped patient choices expose remaining-to-book, not a fabricated balance or billing history; zero writes', async () => {
  const f = fixture(), result = await f.read(), item = result.items[0];
  assert.equal(item.available_units, 4); assert.equal(item.pending_count, 3); assert.equal(item.badge, 'Antiguo'); assert.equal(item.treatment_name, 'Nombre sin cambiar');
  assert.equal(item.can_schedule, true); assert.equal(item.scheduler, 'voucher');
  assert.equal(JSON.stringify(result.started_treatment_ids), '["4"]');
  assert(!JSON.stringify(result).includes('movements')); assert(!JSON.stringify(result).includes('sold_amount'));
  for (const call of f.calls.filter(row => row.name === 'appointments')) { assert.equal(call.input.where.clinica_id, 72); assert.equal(call.input.where.paciente_id, 8); }
  assert.equal(f.calls.find(row => row.name === 'vouchers').input.where.status, 'active');
});
test('all reserved or expired units cannot be booked, and program-backed vouchers stay in Bonos', async () => {
  const f = fixture(); f.state.vouchers[0].available_units = 1;
  let result = await f.read(); assert.equal(result.items[0].can_schedule, false); assert.equal(result.items[0].pending_count, 0);
  f.state.vouchers[0].expires_at = '2026-10-04T00:00:00Z'; assert.equal((await f.read()).items.length, 0);
  f.state.vouchers = [{ id: 3, public_id: 'program-voucher', source_system: 'treatment_program', status: 'active', available_units: 2 }];
  result = await f.read(); assert.equal(result.items[0].kind, 'voucher'); assert.equal(result.items[0].scheduler, 'program'); assert.equal(result.items[0].next_session, 'Sesión 2');
});
test('unexpected operational failure is an error, never a false empty patient list', async () => {
  const f = fixture(); f.state.vouchers[0].source_system = 'treatment_program'; f.state.planError = Error('database unavailable');
  await assert.rejects(f.read(), /database unavailable/);
});
test('HTTP projection retains patient membership, sensitive-data and appointment ACLs', () => {
  const code = fs.readFileSync(require.resolve('../../controllers/patientEconomics.controller'), 'utf8');
  const handler = code.slice(code.indexOf('exports.getAppointmentPurchaseOptions'), code.indexOf('async function programContext'));
  for (const feature of ['patients.view', 'patients.sensitive.view', 'appointments.view']) assert(handler.includes(feature));
  assert(handler.includes('patientIdentifier: req.params.patientId'));
  const service = fs.readFileSync(require.resolve('../../services/appointmentPurchaseOptions.service'), 'utf8'); assert(service.includes('economics.loadContext(patientIdentifier, clinicId)'));
});
