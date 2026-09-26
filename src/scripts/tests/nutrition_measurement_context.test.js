'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createNutritionMeasurementContextResolver } = require('../../services/nutritionMeasurementContext.service');

const matches = (row, where) => Reflect.ownKeys(where).every(key => row[key] === where[key]);
function fixture() {
  const clinics = [{ id_clinica: 10, grupoClinicaId: 1, nombre_clinica: 'Principal ficticia' },
    { id_clinica: 20, grupoClinicaId: 1, nombre_clinica: 'Secundaria ficticia' }, { id_clinica: 30, grupoClinicaId: 2 }];
  const patient = { id_paciente: 1, public_id: 'pac_ficticio', clinica_id: 10, clinica: clinics[0], nombre: 'Ficticio', apellidos: 'Nutrición' };
  const state = { rows: [], calls: [], grants: [10, 20], links: [{ id: 1, paciente_id: 1, clinica_id: 20 }],
    appointments: [
      { id_cita: 100, paciente_id: 1, clinica_id: 10, tratamiento_id: 5 },
      { id_cita: 200, paciente_id: 1, clinica_id: 20, tratamiento_id: 6 },
      { id_cita: 201, paciente_id: 2, clinica_id: 20, tratamiento_id: 6 },
      { id_cita: 300, paciente_id: 1, clinica_id: 30, tratamiento_id: 8 },
      { id_cita: 101, paciente_id: 1, clinica_id: 10, tratamiento_id: 7, voucher_id: 50 },
    ],
    treatments: [
      { id_tratamiento: 5, nombre: 'Nutrición ficticia', origen: 'clinica', clinica_id: 10, disciplina: 'nutricion', activo: true },
      { id_tratamiento: 6, origen: 'clinica', clinica_id: 20, disciplina: 'nutricion', activo: true },
      { id_tratamiento: 7, origen: 'clinica', clinica_id: 10, disciplina: 'estetica', activo: true },
      { id_tratamiento: 8, origen: 'grupo', grupo_clinica_id: 2, disciplina: 'nutricion', activo: true },
      { id_tratamiento: 9, origen: 'grupo', grupo_clinica_id: 1, disciplina: 'nutricion', activo: true },
    ],
    memberships: [{ id_usuario: 8, id_clinica: 20, rol_clinica: 'personaldeclinica', estado_invitacion: 'aceptada' }],
    vouchers: [{ id: 50, patient_id: 1, clinic_id: 10, source_system: 'treatment_program' }],
    sessions: [{ voucher_id: 50, appointment_id: 101, snapshot: { treatments: [{ id: 7 }, { id: 5 }] } }],
  };
  const tx = { LOCK: { UPDATE: 'UPDATE' } };
  const findOne = (name, rows) => async options => {
    state.calls.push({ name, ...options });
    return rows().find(row => matches(row, options.where)) || null;
  };
  const db = {
    Sequelize: require('sequelize'),
    sequelize: { transaction: async callback => {
      const before = state.rows.length;
      try { return await callback(tx); } catch (error) { state.rows.length = before; throw error; }
    } },
    Paciente: { findOne: findOne('patient', () => [patient]) },
    PacienteClinica: { findOne: findOne('membership', () => state.links) },
    CitaPaciente: { findOne: findOne('appointment', () => state.appointments), findByPk: async id => state.appointments.find(row => row.id_cita === id) },
    Clinica: { findByPk: async id => clinics.find(row => row.id_clinica === id) },
    Tratamiento: { findByPk: async id => state.treatments.find(row => row.id_tratamiento === id) },
    UsuarioClinica: { findOne: findOne('professional', () => state.memberships) },
    PatientVoucher: { findOne: findOne('voucher', () => state.vouchers) },
    PatientProgramSession: { findOne: findOne('session', () => state.sessions) },
    PatientNutritionMeasurement: {
      create: async (values, options) => {
        state.calls.push({ name: 'create', ...options });
        const row = { id: state.rows.length + 1, ...values, toJSON() { return { ...this }; } };
        state.rows.push(row); return row;
      },
      findAll: async () => state.rows,
    },
  };
  const permission = async args => {
    state.calls.push({ name: 'permission', ...args });
    if (!state.grants.includes(args.clinicId)) throw Object.assign(new Error('access_policy_forbidden'), { status: 403 });
  };
  const resolver = createNutritionMeasurementContextResolver({ db, assertUserCanAccessFeature: permission });
  const resolve = payload => resolver({ patient, payload, actorUserId: 7, transaction: tx });
  const filename = path.resolve(__dirname, '../../services/nutritionWorkspace.service.js');
  const realRequire = createRequire(filename), mod = { exports: {} };
  const contractsModule = { exports: {} };
  const contractsFile = path.resolve(__dirname, '../../services/medicalAreaContracts.service.js');
  vm.runInNewContext(`(function(require,module,exports){${fs.readFileSync(contractsFile, 'utf8')}\n})`,
    { console })(name => name === '../../models' ? db : createRequire(contractsFile)(name), contractsModule, contractsModule.exports);
  const contracts = contractsModule.exports;
  const wrappedRequire = name => name === '../../models' ? db : name === '../lib/access-policy' ? { assertUserCanAccessFeature: permission }
    : name === './medicalAreaContracts.service' ? { ...contracts, getContractForArea: async () => contracts.getBaseContractForArea('nutricion') }
      : name === './clinicalPrivateStorage.service' ? {} : realRequire(name);
  vm.runInNewContext(`(function(require,module,exports,__dirname){${fs.readFileSync(filename, 'utf8')}\n})`,
    { console, Buffer, process, Date })(wrappedRequire, mod, mod.exports, path.dirname(filename));
  const service = mod.exports;
  const save = payload => service.createNutritionMeasurement('pac_ficticio', {
    profile_code: 'quick', raw_values: { weight_kg: 70, stature_cm: 170, waist_cm: 80, hip_cm: 90 }, ...payload,
  }, 7);
  return { state, db, patient, tx, resolve, save, service };
}

test('independent measurement defaults to primary clinic and authenticated author', async () => {
  const f = fixture();
  assert.deepEqual(await f.resolve({}), { clinic_id: 10, appointment_id: null, treatment_id: null, professional_id: 7 });
  assert.deepEqual(f.state.calls.filter(c => c.name === 'permission').map(c => [c.clinicId, c.featureKey]),
    [[10, 'nutrition.workspace.view'], [10, 'nutrition.measurements.create']]);
});
test('a linked secondary-clinic appointment supplies the clinic and treatment', async () => {
  const f = fixture();
  assert.deepEqual(await f.resolve({ appointment_id: 200 }), { clinic_id: 20, appointment_id: 200, treatment_id: 6, professional_id: 7 });
  const calls = f.state.calls.filter(c => ['appointment', 'membership'].includes(c.name));
  assert.equal(calls.length, 2);
  for (const call of calls) { assert.equal(call.transaction, f.tx); assert.equal(call.lock, 'UPDATE'); }
});
for (const [name, payload, code] of [
  ['another patient appointment', { appointment_id: 201 }, 'nutrition_appointment_invalid'],
  ['unknown appointment', { appointment_id: 999 }, 'nutrition_appointment_invalid'],
  ['appointment/clinic mismatch', { appointment_id: 200, clinic_id: 10 }, 'nutrition_appointment_clinic_mismatch'],
  ['unlinked clinic', { appointment_id: 300 }, 'nutrition_patient_clinic_mismatch'],
  ['foreign treatment', { treatment_id: 6 }, 'nutrition_treatment_invalid'],
  ['foreign group treatment', { treatment_id: 8 }, 'nutrition_treatment_invalid'],
  ['other appointment treatment', { appointment_id: 100, treatment_id: 9 }, 'nutrition_appointment_treatment_mismatch'],
  ['non-nutrition treatment', { treatment_id: 7 }, 'nutrition_treatment_area_mismatch'],
  ['foreign professional', { professional_id: 8 }, 'nutrition_professional_invalid'],
]) test(`rejects ${name} before persisting`, async () => {
  const f = fixture(); await assert.rejects(f.save(payload), error => error.code === code && error.status === 400);
  assert.equal(f.state.rows.length, 0); assert(!f.state.calls.some(c => c.name === 'create'));
});
for (const field of ['appointment_id', 'clinic_id', 'professional_id', 'treatment_id']) {
  test(`rejects malformed ${field} instead of silently falling back`, async () => {
    for (const value of ['20oops', -1, 1.1, true, [], {}, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(fixture().resolve({ [field]: value }), error => error.code === `nutrition_${field}_invalid`);
    }
  });
}
test('membership does not grant target-clinic permission', async () => {
  const f = fixture(); f.state.grants = [10];
  await assert.rejects(f.save({ appointment_id: 200 }), error => error.status === 403);
  assert.equal(f.state.rows.length, 0);
});
test('shared group treatment and linked active professional are accepted', async () => {
  const f = fixture(); assert.equal((await f.resolve({ clinic_id: 20, treatment_id: 9, professional_id: 8 })).professional_id, 8);
  f.state.memberships[0].estado_invitacion = 'pendiente';
  await assert.rejects(f.resolve({ clinic_id: 20, professional_id: 8 }), error => error.code === 'nutrition_professional_invalid');
});
test('persisted program composition permits Nutrition after a different primary treatment', async () => {
  const f = fixture(); assert.equal((await f.resolve({ appointment_id: 101, treatment_id: 5 })).treatment_id, 5);
  f.state.vouchers[0].patient_id = 2;
  await assert.rejects(f.resolve({ appointment_id: 101, treatment_id: 5 }), error => error.code === 'nutrition_appointment_treatment_mismatch');
});
test('obsolete treatment is retained only for its existing appointment', async () => {
  const f = fixture(); f.state.treatments[0].activo = false;
  assert.equal((await f.resolve({ appointment_id: 100 })).treatment_id, 5);
  await assert.rejects(f.resolve({ treatment_id: 5 }), error => error.code === 'nutrition_treatment_inactive');
});
test('service writes all verified links atomically and report uses the measurement clinic', async () => {
  const f = fixture(); const row = await f.save({ appointment_id: 200 });
  assert.equal(row.clinic_id, 20); assert.equal(row.appointment_id, 200); assert.equal(row.treatment_id, 6);
  const create = f.state.calls.find(c => c.name === 'create'); assert.equal(create.transaction, f.tx);
  assert(f.state.calls.some(c => c.name === 'patient' && c.transaction === f.tx && c.lock === 'UPDATE'));
  const report = await f.service.getNutritionMeasurementReport('pac_ficticio', row.id);
  assert.equal(report.patient.clinic_id, 20); assert.equal(report.patient.clinic_name, 'Secundaria ficticia');
  assert.equal(f.patient.clinica_id, 10);
});
