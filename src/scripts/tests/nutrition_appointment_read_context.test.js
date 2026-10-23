'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const fixtureFile = path.join(__dirname, 'nutrition_measurement_context.test.js');
const moduleFixture = { exports: {} };
vm.runInNewContext(`(function(require,module,exports,__dirname){${fs.readFileSync(fixtureFile, 'utf8')}\nmodule.exports={fixture};})`,
  { console, Buffer, process })(name => name === 'node:test' ? () => {} : createRequire(fixtureFile)(name),
  moduleFixture, moduleFixture.exports, __dirname);
const fixture = moduleFixture.exports.fixture;
const plain = value => JSON.parse(JSON.stringify(value));
const workspace = (f, appointmentId, clinicId = 10) => f.service.getPatientNutritionWorkspace('pac_ficticio', {
  actorUserId: 7, clinicId, ...(appointmentId === undefined ? {} : { appointmentId }),
});

test('the ordinary workspace does not read appointment/program contexts or add a new response field', async () => {
  const f = fixture(); const page = await workspace(f);
  assert.equal(Object.hasOwn(page, 'measurement_context'), false);
  assert(!f.state.calls.some(call => ['appointment', 'voucher', 'session'].includes(call.name)));
  assert.equal(f.state.rows.length, 0); assert.equal(f.state.reports.length, 0);
});

test('an explicit mixed-program appointment exposes only canonical Nutrition IDs without financial snapshots or writes', async () => {
  const f = fixture();
  f.state.sessions[0].snapshot.treatments = [{ id: 7, price: 900 }, { id: 5, price: 90 }];
  f.state.sessions[0].snapshot.total = 990;
  const page = await workspace(f, '101');
  assert.deepEqual(plain(page.measurement_context), { appointment_id: 101, nutrition_treatment_ids: [5] });
  assert.doesNotMatch(JSON.stringify(page.measurement_context), /price|total|990|900|90/);
  assert.equal(f.state.calls.filter(call => call.name === 'appointment').length, 1);
  assert.equal(f.state.rows.length, 0); assert.equal(f.state.reports.length, 0);
  assert(!f.state.calls.some(call => ['create', 'storeBinary'].includes(call.name)));
});

test('primary Nutrition and an inactive service retain evidence only for the selected existing appointment', async () => {
  const f = fixture();
  assert.deepEqual(plain((await workspace(f, 100)).measurement_context), { appointment_id: 100, nutrition_treatment_ids: [5] });
  f.state.treatments[0].activo = false;
  f.state.treatments[0].precio_base = 123;
  f.state.treatments[0].clinical_config = { source_price: { gross_amount: 123 }, price_profile: { private: 'TESTONLY fiscal metadata' }, nutrition: { service_kind: 'follow_up' } };
  const historical = await workspace(f, 100);
  assert.deepEqual(plain(historical.measurement_context), { appointment_id: 100, nutrition_treatment_ids: [5] });
  assert.equal(historical.treatments.length, 1);
  assert.equal(historical.treatments[0].name, 'Nutrición ficticia');
  assert.equal(historical.treatments[0].price_base, null);
  assert.deepEqual(plain(historical.treatments[0].clinical_config), { nutrition: { service_kind: 'follow_up' } });
  assert.deepEqual(plain((await workspace(f, 101)).measurement_context), { appointment_id: 101, nutrition_treatment_ids: [5] });
});

test('a contextual choice never duplicates or overwrites a normal active catalogue item', async () => {
  const f = fixture();
  const current = { ...f.state.treatments[0], precio_base: 45, clinical_config: { nutrition: { service_kind: 'consultation' } } };
  f.db.Tratamiento.findAll = async () => [{ toJSON: () => current }];
  const page = await workspace(f, 101);
  assert.equal(page.treatments.length, 1); assert.equal(page.treatments[0].id, 5);
  assert.equal(page.treatments[0].price_base, 45);
  assert.deepEqual(plain(page.treatments[0].clinical_config), current.clinical_config);
});

test('a selected secondary clinic uses its actual appointment, while other patients/clinics and denied scopes fail closed', async () => {
  const f = fixture(); f.state.grants = [20];
  const page = await workspace(f, 200, 20);
  assert.equal(page.patient.clinic_id, 20);
  assert.deepEqual(plain(page.measurement_context), { appointment_id: 200, nutrition_treatment_ids: [6] });
  await assert.rejects(workspace(f, 201, 20), error => error.status === 404 && error.code === 'nutrition_appointment_not_found');
  await assert.rejects(workspace(f, 100, 20), error => error.status === 404 && error.code === 'nutrition_appointment_not_found');
  const before = f.state.calls.filter(call => call.name === 'appointment').length;
  await assert.rejects(workspace(f, 100, 10), error => error.status === 403);
  assert.equal(f.state.calls.filter(call => call.name === 'appointment').length, before);
});

test('malformed explicit IDs are rejected instead of choosing a default appointment', async () => {
  const f = fixture();
  for (const id of [null, '', 0, -1, 1.5, '00100', '1e2', '0x64', '100x', [], ['100'], {}, Number.MAX_SAFE_INTEGER + 1]) {
    await assert.rejects(workspace(f, id), error => error.status === 400 && error.code === 'nutrition_appointment_id_invalid');
  }
  assert(!f.state.calls.some(call => call.name === 'appointment'));
});

test('booking metadata and foreign vouchers cannot manufacture program composition', async () => {
  const f = fixture(); const appointment = f.state.appointments.find(row => row.id_cita === 101);
  appointment.import_metadata = { program_session: { treatments: [{ id: 5 }] } };
  f.state.vouchers[0].patient_id = 2;
  assert.deepEqual(plain((await workspace(f, 101)).measurement_context), { appointment_id: 101, nutrition_treatment_ids: [] });
  f.state.vouchers[0].patient_id = 1; f.state.sessions.length = 0;
  assert.deepEqual(plain((await workspace(f, 101)).measurement_context), { appointment_id: 101, nutrition_treatment_ids: [] });
});

test('program components must resolve to real Nutrition treatments within the clinic scope', async () => {
  const f = fixture();
  f.state.sessions[0].snapshot.treatments = [{ id: 5 }, { id: 7 }, { id: 8 }, { id: 9 }, { id: 999 }];
  assert.deepEqual(plain((await workspace(f, 101)).measurement_context), { appointment_id: 101, nutrition_treatment_ids: [5, 9] });
  f.state.treatments[0].eliminado_por_clinica = [10];
  assert.deepEqual(plain((await workspace(f, 101)).measurement_context), { appointment_id: 101, nutrition_treatment_ids: [9] });
});

test('the native controller forwards the explicit selection and returns precise private 400/404 errors', async () => {
  const file = path.resolve(__dirname, '../../controllers/nutritionWorkspace.controller.js');
  const module = { exports: {} }; let received; let failure;
  vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(file, 'utf8')}\n})`, { Buffer })(
    name => name === 'express-async-handler' ? fn => fn : { getPatientNutritionWorkspace: async (...args) => {
      received = args; if (failure) throw failure; return {};
    } }, module, module.exports);
  const req = { params: { id: 'pac_TESTONLY' }, userData: { userId: 7 }, query: { clinic_id: '20', appointment_id: '200', actorUserId: 999 } };
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await module.exports.getPatientNutritionWorkspace(req, response);
  assert.equal(received[1].appointmentId, '200'); assert.equal(received[1].actorUserId, 7);
  for (const [status, code] of [[400, 'nutrition_appointment_id_invalid'], [404, 'nutrition_appointment_not_found']]) {
    failure = Object.assign(new Error('TESTONLY context unavailable'), { status, code });
    await module.exports.getPatientNutritionWorkspace(req, response);
    assert.equal(response.statusCode, status); assert.equal(response.body.code, code);
  }
});
