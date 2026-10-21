'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), { Op } = require('sequelize');
const { attachAppointmentVoucherIdentities } = require('../../services/appointmentVoucherRead.service');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const appointment = (id = 1, patch = {}) => ({ id_cita: id, voucher_id: 42, clinica_id: 72, paciente_id: 11, estado: 'pendiente', ...patch });
function fixture(vouchers = [{ id: 42, public_id: 'owned-voucher', clinic_id: 72, patient_id: 11 }]) {
  const calls = [];
  return { calls, PatientVoucher: { findAll: async options => { calls.push(options); return vouchers; } } };
}
test('ordinary voucher appointments receive only their exact patient/clinic public purchase identity', async () => {
  const db = fixture(), row = appointment(), before = { ...row };
  await attachAppointmentVoucherIdentities(db, row);
  assert.equal(row.voucher_public_id, 'owned-voucher');
  const { voucher_public_id, ...after } = row; assert.deepEqual(after, before);
  assert.deepEqual(db.calls[0].attributes, ['id', 'public_id', 'clinic_id', 'patient_id']);
  assert.deepEqual(db.calls[0].where[Op.or], [{ id: 42, clinic_id: 72, patient_id: 11 }]);
});
test('missing, malformed, cross-patient and cross-clinic references fail closed without stale identities', async () => {
  for (const voucher of [{ id: 42, public_id: 'foreign', clinic_id: 73, patient_id: 11 },
    { id: 42, public_id: 'foreign', clinic_id: 72, patient_id: 12 },
    { id: 43, public_id: 'different', clinic_id: 72, patient_id: 11 },
    { id: 42, public_id: 'https://external.invalid', clinic_id: 72, patient_id: 11 }]) {
    const row = appointment(1, { voucher_public_id: 'stale' }); await attachAppointmentVoucherIdentities(fixture([voucher]), row); assert.equal(row.voucher_public_id, null);
  }
  const db = fixture(), rows = [appointment(1, { voucher_id: null }), appointment(2, { paciente_id: null }), { id_cita: 3 }];
  await attachAppointmentVoucherIdentities(db, rows); assert.equal(db.calls.length, 0); rows.forEach(row => assert.equal(row.voucher_public_id, null));
});
test('large lists use bounded batches, support Sequelize rows and never query financial columns', async () => {
  const db = fixture(), rows = Array.from({ length: 401 }, (_, index) => appointment(index + 1));
  await attachAppointmentVoucherIdentities(db, rows); assert.equal(db.calls.length, 3); assert(rows.every(row => row.voucher_public_id === 'owned-voucher'));
  assert(db.calls.every(call => call.where[Op.or].length <= 200 && !call.attributes.some(key => /amount|unit|price/.test(key))));
  const value = appointment(), wrapper = { toJSON: () => value, setDataValue: (key, data) => { value[key] = data; } };
  await attachAppointmentVoucherIdentities(db, wrapper); assert.equal(value.voucher_public_id, 'owned-voucher');
});
test('the actual appointment privacy guard removes public purchase identity without sensitive clinical access', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../controllers/citas.controller.js'), 'utf8');
  const start = source.indexOf('function protectAppointmentPayload('), end = source.indexOf('\nasync function protectAppointmentsForRequest(', start);
  assert(start >= 0 && end > start);
  const context = { resolveClinicTimezone: () => 'Europe/Madrid', appointmentImportReview: () => null,
    bookingCapabilities: () => ({ simple: false }), redactAppointmentPatient: () => ({ privacy_redacted: true }), redactAppointmentLead: () => null };
  vm.runInNewContext(source.slice(start, end) + '\nthis.protect=protectAppointmentPayload;', context);
  const row = { ...appointment(), care: { state: 'pending' }, voucher_public_id: 'owned-voucher' };
  assert.equal(context.protect(row, { patientSensitive: false }).voucher_public_id, null);
  assert.equal(context.protect(row, { patientSensitive: true }).voucher_public_id, 'owned-voucher');
  assert.equal(row.voucher_public_id, 'owned-voucher', 'redaction must not alter the source row');
});
