'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { Op } = require('sequelize');
const { attachAppointmentProgramContexts } = require('../../services/appointmentProgramRead.service');
const appointment = (id = 10) => ({ id_cita: id, clinica_id: 82, paciente_id: 2812, voucher_id: 942,
  source_system: 'treatment_program', import_metadata: { program_session: { session_id: String(id + 100), key: `s${id}` } } });
const session = (id = 10) => ({ id: id + 100, appointment_id: id, voucher_id: 942, session_key: `s${id}`, position: 0 });
const voucher = () => ({ id: 942, clinic_id: 82, patient_id: 2812, name: 'Programa comprado', total_units: '3.00', sold_amount: '120.00' });
function database(sessions = [session()], vouchers = [voucher()]) {
  const calls = [];
  return { calls,
    PatientProgramSession: { findAll: async options => { calls.push(['sessions', options]); return sessions.filter(s => options.where.appointment_id[Op.in].includes(s.appointment_id)); } },
    PatientVoucher: { findAll: async options => { calls.push(['vouchers', options]); return vouchers.filter(v => options.where.id[Op.in].includes(v.id)); } },
  };
}
test('program read model resolves the purchased identity without exposing or recalculating financial totals', async () => {
  const row = appointment(), db = database();
  await attachAppointmentProgramContexts(db, row);
  assert.deepEqual(row.program_context, { kind: 'program', status: 'linked', name: 'Programa comprado', session_number: 1, session_count: 3 });
  assert.equal(db.calls.length, 2);
  assert(!db.calls[1][1].attributes.includes('sold_amount'));
  assert.doesNotMatch(JSON.stringify(row.program_context), /price|amount|patient|clinic|voucher|942/);
});
test('ordinary appointments have no added queries and stale read models are cleared', async () => {
  const rows = [{ id_cita: 1, program_context: { name: 'stale' } }, { source_system: 'cliniccloud' }], db = database();
  await attachAppointmentProgramContexts(db, rows);
  assert.equal(db.calls.length, 0); rows.forEach(r => assert.equal(r.program_context, null));
  await attachAppointmentProgramContexts(db, null); assert.equal(db.calls.length, 0);
});
test('missing, ambiguous and cross-patient/clinic/purchase relations fail closed', async () => {
  const scenarios = [
    { sessions: [] }, { sessions: [session(), session()] },
    { vouchers: [{ ...voucher(), clinic_id: 83 }] }, { vouchers: [{ ...voucher(), patient_id: 2813 }] },
    { change: { voucher_id: 943 } }, { change: { paciente_id: null } },
    { change: { import_metadata: {} } }, { change: { import_metadata: '{invalid' } },
    { change: { import_metadata: { program_session: { session_id: 999, key: 's10' } } } },
    { sessions: [{ ...session(), session_key: 'other' }] }, { sessions: [{ ...session(), position: 3 }] },
    { sessions: [{ ...session(), position: -1 }] }, { vouchers: [{ ...voucher(), total_units: '1.5' }] },
    { vouchers: [{ ...voucher(), name: '' }] },
  ];
  for (const scenario of scenarios) {
    const row = { ...appointment(), ...scenario.change };
    await attachAppointmentProgramContexts(database(scenario.sessions, scenario.vouchers), row);
    assert.deepEqual(row.program_context, { kind: 'program', status: 'unavailable' });
  }
});
test('Sequelize and JSON-string metadata are supported without rewriting stored metadata', async () => {
  const original = appointment(); original.import_metadata = JSON.stringify(original.import_metadata);
  const wrapper = { toJSON: () => original, setDataValue: (key, value) => { original[key] = value; } };
  await attachAppointmentProgramContexts(database(), wrapper);
  assert.equal(original.program_context.status, 'linked'); assert.equal(typeof original.import_metadata, 'string');
});
test('large lists use bounded batches rather than N+1 queries', async () => {
  const rows = Array.from({ length: 401 }, (_, i) => appointment(i + 1));
  const db = database(rows.map(r => session(r.id_cita)));
  await attachAppointmentProgramContexts(db, rows);
  assert.equal(db.calls.length, 6);
  assert.deepEqual(db.calls.filter(c => c[0] === 'sessions').map(c => c[1].where.appointment_id[Op.in].length), [200, 200, 1]);
  rows.forEach(row => assert.equal(row.program_context.status, 'linked'));
});
const source = fs.readFileSync(path.resolve(__dirname, '../../controllers/citas.controller.js'), 'utf8');
function code(start, end) { const a = source.indexOf(start), b = source.indexOf(end, a); assert(a >= 0 && b > a); return source.slice(a, b); }
const context = { module: { exports: {} }, plainCita: x => x, DEFAULT_TIMEZONE: 'Europe/Madrid',
  appointmentImportReview: () => null, bookingCapabilities: () => ({ simple: false }),
  redactAppointmentPatient: () => ({ privacy_redacted: true }), redactAppointmentLead: () => null,
  preferredLanguagePayload: () => ({}), formatDateTimeLocal: x => x };
vm.runInNewContext(code('function normalizeMoneyValue(', '\nfunction attachResolvedAppointmentPricesToCitas(')
  + code('function protectAppointmentPayload(', '\nasync function protectAppointmentsForRequest(')
  + code('function mapCalendarCitaRow(', '\nconst { buildHorarioExceptionMap')
  + '\nmodule.exports={resolveCitaAppointmentPrice,protectAppointmentPayload,mapCalendarCitaRow};', context);
test('actual appointment price resolver never prices a purchased program as its first treatment', () => {
  const treatment = { precio_base: 50, clinical_config: { appointment_type_prices: { continuacion: 25 } } };
  const ordinary = { tratamiento: treatment, tipo_cita: 'continuacion' };
  assert.equal(context.module.exports.resolveCitaAppointmentPrice(ordinary), 25);
  assert.equal(context.module.exports.resolveCitaAppointmentPrice({ ...ordinary, source_system: 'treatment_program' }), null);
  assert.equal(context.module.exports.resolveCitaAppointmentPrice({ ...ordinary, program_context: { kind: 'program', status: 'unavailable' } }), null);
});
test('calendar DTO preserves backend program context, privacy guard removes it and its price without clinical access', async () => {
  const row = { ...appointment(), tratamiento: { precio_base: 50 } };
  await attachAppointmentProgramContexts(database(), row);
  const mapped = context.module.exports.mapCalendarCitaRow(row);
  assert.equal(mapped.program_context.name, 'Programa comprado'); assert.equal(mapped.precio_cita_resuelto, null);
  const hidden = context.module.exports.protectAppointmentPayload(mapped, { patientSensitive: false });
  assert.equal(hidden.program_context, null); assert.equal(hidden.precio_cita_resuelto, null);
  assert.doesNotMatch(JSON.stringify(hidden), /Programa comprado/);
  assert.equal(context.module.exports.protectAppointmentPayload(mapped, { patientSensitive: true }).program_context.name, 'Programa comprado');
});
test('all full appointment readers attach context; lightweight summary does not load program purchases', () => {
  assert.equal((source.match(/await attachAppointmentProgramContexts\(db,/g) || []).length, 4);
  const summary = code('    const summaryOnly =', '\n    const citas = await CitaPaciente.findAll({');
  assert.doesNotMatch(summary, /attachAppointmentProgramContexts/);
});
