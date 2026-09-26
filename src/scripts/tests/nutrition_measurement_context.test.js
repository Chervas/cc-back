'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createNutritionMeasurementContextResolver } = require('../../services/nutritionMeasurementContext.service');

const matches = (row, where) => Reflect.ownKeys(where).every(key => {
  const value = where[key];
  return value && typeof value === 'object' ? value[require('sequelize').Op.in]?.includes(row[key]) : row[key] === value;
});
function fixture() {
  const clinics = [{ id_clinica: 10, grupoClinicaId: 1, nombre_clinica: 'Principal ficticia' },
    { id_clinica: 20, grupoClinicaId: 1, nombre_clinica: 'Secundaria ficticia' }, { id_clinica: 30, grupoClinicaId: 2 }];
  const patient = { id_paciente: 1, public_id: 'pac_ficticio', clinica_id: 10, clinica: clinics[0], nombre: 'Ficticio', apellidos: 'Nutrición' };
  const state = { rows: [], reports: [], assets: [], calls: [], grants: [10, 20], deniedFeatures: [], links: [{ id: 1, paciente_id: 1, clinica_id: 20 }],
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
  const findAll = (name, rows) => async options => {
    state.calls.push({ name, ...options });
    return rows().filter(row => matches(row, options.where)).sort((a, b) => Number(b.id) - Number(a.id)).slice(0, options.limit);
  };
  const record = row => ({ ...row, toJSON() { return { ...this }; }, async save() {} });
  const db = {
    Sequelize: require('sequelize'),
    sequelize: { transaction: async callback => {
      const before = state.rows.length;
      try { return await callback(tx); } catch (error) { state.rows.length = before; throw error; }
    } },
    Paciente: { findOne: findOne('patient', () => [patient]) },
    PacienteClinica: { findOne: findOne('membership', () => state.links), findAll: findAll('memberships', () => state.links) },
    CitaPaciente: { findOne: findOne('appointment', () => state.appointments), findByPk: async id => state.appointments.find(row => row.id_cita === id) },
    Clinica: { findByPk: async id => clinics.find(row => row.id_clinica === id) },
    Tratamiento: { findByPk: async id => state.treatments.find(row => row.id_tratamiento === id), findAll: async () => [] },
    UsuarioClinica: { findOne: findOne('professional', () => state.memberships) },
    PatientVoucher: { findOne: findOne('voucher', () => state.vouchers) },
    PatientProgramSession: { findOne: findOne('session', () => state.sessions) },
    PatientNutritionMeasurement: {
      create: async (values, options) => {
        state.calls.push({ name: 'create', ...options });
        const row = { id: state.rows.length + 1, ...values, toJSON() { return { ...this }; } };
        state.rows.push(row); return row;
      },
      findAll: findAll('measurements', () => state.rows), findOne: findOne('measurement', () => state.rows),
    },
    PatientNutritionReport: {
      findAll: findAll('reports', () => state.reports), findOne: findOne('report', () => state.reports),
      create: async values => { const row = record({ id: state.reports.length + 1, ...values }); state.reports.push(row); return row; },
      update: async (values, options) => { for (const row of state.reports.filter(row => matches(row, options.where))) Object.assign(row, values); },
    },
    ClinicalPrivateAsset: { findAll: findAll('assets', () => state.assets), findOne: findOne('asset', () => state.assets) },
  };
  const permission = async args => {
    state.calls.push({ name: 'permission', ...args });
    if (!state.grants.includes(args.clinicId) || state.deniedFeatures.includes(args.featureKey)) throw Object.assign(new Error('access_policy_forbidden'), { status: 403 });
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
  const wrappedRequire = name => name === '../../models' ? db : name === '../lib/access-policy' ? {
    assertUserCanAccessFeature: permission,
    getAccessibleClinicIdsForFeature: async ({ clinicIds, featureKey }) => state.deniedFeatures.includes(featureKey) ? [] : clinicIds.filter(id => state.grants.includes(id)),
  }
    : name === './medicalAreaContracts.service' ? { ...contracts, getContractForArea: async () => contracts.getBaseContractForArea('nutricion') }
      : name === './clinicalPrivateStorage.service' ? {
        readClinicalPrivateAsset: async asset => { state.calls.push({ name: 'readBinary', asset }); return { buffer: Buffer.from('private fictitious binary'), filename: 'fictitious.pdf' }; },
        storeClinicalPrivateAsset: async values => { state.calls.push({ name: 'storeBinary', values }); return { id: 100 }; },
      } : realRequire(name);
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
    [[10, 'patients.view'], [10, 'patients.sensitive.view'], [10, 'nutrition.workspace.view'], [10, 'nutrition.measurements.create']]);
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
  const report = await f.service.getNutritionMeasurementReport('pac_ficticio', row.id, { actorUserId: 7 });
  assert.equal(report.patient.clinic_id, 20); assert.equal(report.patient.clinic_name, 'Secundaria ficticia');
  assert.equal(f.patient.clinica_id, 10);
});

async function sharedHistoryFixture() {
  const f = fixture();
  await f.save({ measured_at: '2026-09-01', notes: 'primary clinic private' });
  await f.save({ measured_at: '2026-09-08', clinic_id: 20, notes: 'secondary clinic private' });
  for (const row of f.state.rows) f.state.assets.push({ id: row.id, patient_id: 1, clinic_id: row.clinic_id,
    owner_id: String(row.id), owner_type: 'patient_nutrition_measurement', purpose: 'nutrition_clinical_photo', status: 'active' });
  assert.equal(f.state.reports.length, 2, 'fixture persists real generated snapshots');
  return f;
}
test('secondary-only professional sees only allowed measurements, photos, evolution and comparisons', async () => {
  const f = await sharedHistoryFixture(); f.state.grants = [20];
  const workspace = await f.service.getPatientNutritionWorkspace('pac_ficticio', { actorUserId: 7 });
  assert.equal(workspace.patient.clinic_id, 20); assert.equal(workspace.measurements.length, 1);
  assert.equal(workspace.measurements[0].id, 2); assert.equal(workspace.evolution.length, 1);
  assert.equal(workspace.projection.available, false); assert.equal(workspace.reports[0].comparison.available, false);
  assert.equal(workspace.measurements[0].clinical_photos.length, 1);
  assert.equal(workspace.reports[0].snapshot, undefined, 'the existing comparison snapshot is not exposed');
  assert(!JSON.stringify(workspace).includes('primary clinic private'));
  assert.equal(f.patient.clinica_id, 10, 'reading does not move the patient');
});
test('users with both permissions retain the shared history and original snapshots', async () => {
  const f = await sharedHistoryFixture();
  const workspace = await f.service.getPatientNutritionWorkspace('pac_ficticio', { actorUserId: 7 });
  assert.equal(workspace.measurements.length, 2); assert.equal(workspace.reports[0].snapshot.id, 2);
  assert.equal(workspace.projection.available, true);
  const html = await f.service.renderNutritionMeasurementReport('pac_ficticio', 2, { actorUserId: 7 });
  assert.equal(html, f.state.reports[1].snapshot_html);
});
for (const feature of ['patients.view', 'patients.sensitive.view', 'nutrition.workspace.view']) test(`workspace and save require ${feature}`, async () => {
  const f = fixture(); f.state.deniedFeatures = [feature];
  await assert.rejects(f.service.getPatientNutritionWorkspace('pac_ficticio', { actorUserId: 7 }), e => e.status === 403);
  await assert.rejects(f.save({}), e => e.status === 403); assert.equal(f.state.rows.length, 0);
});
test('no actor, unlinked selection, denied primary and malformed selection fail closed', async () => {
  const f = fixture();
  await assert.rejects(f.service.getPatientNutritionWorkspace('pac_ficticio'), e => e.status === 401);
  await assert.rejects(f.service.getPatientNutritionWorkspace('pac_ficticio', { actorUserId: 7, clinicId: 30 }), e => e.status === 403);
  await assert.rejects(f.service.getPatientNutritionWorkspace('pac_ficticio', { actorUserId: 7, clinicId: '20garbage' }), e => e.status === 400);
  f.state.grants = [20];
  await assert.rejects(f.service.getPatientNutritionWorkspace('pac_ficticio', { actorUserId: 7, clinicId: 10 }), e => e.status === 403);
});
for (const action of ['getNutritionMeasurementReport', 'renderNutritionMeasurementReport', 'listNutritionMeasurementClinicalPhotos']) test(`${action} cannot access an unauthorized measurement by ID`, async () => {
  const f = await sharedHistoryFixture(); f.state.grants = [20];
  await assert.rejects(f.service[action]('pac_ficticio', 1, { actorUserId: 7 }), e => e.status === 404);
});
test('photo binary authorization and clinic consistency happen before private storage access', async () => {
  const f = await sharedHistoryFixture(); f.state.grants = [20];
  await assert.rejects(f.service.readNutritionMeasurementClinicalPhoto('pac_ficticio', 1, 1, { actorUserId: 7 }), e => e.status === 404);
  f.state.assets[1].clinic_id = 10;
  await assert.rejects(f.service.readNutritionMeasurementClinicalPhoto('pac_ficticio', 2, 2, { actorUserId: 7 }), e => e.status === 404);
  assert(!f.state.calls.some(c => c.name === 'readBinary'));
});
test('restricted draft renders only allowed values; original snapshot stays unchanged', async () => {
  const f = await sharedHistoryFixture(); const before = f.state.reports[1].snapshot_hash; f.state.grants = [20];
  const html = await f.service.renderNutritionMeasurementReport('pac_ficticio', 2, { actorUserId: 7 });
  assert.notEqual(html, f.state.reports[1].snapshot_html);
  assert.equal(f.state.reports[1].snapshot_hash, before); assert.equal(f.state.reports.length, 2);
  const report = await f.service.getNutritionMeasurementReport('pac_ficticio', 2, { actorUserId: 7 });
  assert.equal(report.previous_measurement, null); assert.equal(report.report.comparison.available, false);
  await assert.rejects(f.service.renderNutritionMeasurementReport('pac_ficticio', 2, { actorUserId: 7, compareMeasurementId: 1 }), e => e.message === 'report_comparison_not_found');
});
test('restricted final HTML/PDF is refused rather than regenerated or read from cache', async () => {
  const f = await sharedHistoryFixture(); f.state.reports[1].status = 'final'; f.state.reports[1].pdf_asset_id = 99;
  f.state.grants = [20];
  await assert.rejects(f.service.renderNutritionMeasurementReport('pac_ficticio', 2, { actorUserId: 7 }), e => e.code === 'nutrition_report_scope_forbidden');
  await assert.rejects(f.service.generateNutritionMeasurementReportPdf('pac_ficticio', 2, 7), e => e.code === 'nutrition_report_scope_forbidden');
  assert(!f.state.calls.some(c => c.name === 'readBinary')); assert.equal(f.state.reports[1].pdf_asset_id, 99);
});
test('snapshot creation/finalization cannot overwrite a draft containing restricted comparisons', async () => {
  const f = await sharedHistoryFixture(); f.state.grants = [20];
  await assert.rejects(f.service.createNutritionMeasurementReportSnapshot('pac_ficticio', 2, 7), e => e.status === 403);
  await assert.rejects(f.service.finalizeNutritionMeasurementReportSnapshot('pac_ficticio', 2, 7), e => e.status === 403);
  assert.equal(f.state.reports.length, 2); assert.equal(f.state.reports[1].status, 'active');
});
test('secondary-only write creates its snapshot without comparing inaccessible primary history', async () => {
  const f = await sharedHistoryFixture(); f.state.grants = [20];
  const row = await f.save({ clinic_id: 20, measured_at: '2026-09-15' });
  assert(row.report_snapshot); const snapshot = f.state.reports[2].snapshot_json;
  assert.equal(snapshot.previous_measurement.id, 2);
  assert(snapshot.meta.source_measurements.every(row => row.clinic_id === 20));
});
test('write permissions belong to the measurement clinic, not to its primary clinic', async () => {
  const f = await sharedHistoryFixture(); f.state.grants = [20]; f.state.deniedFeatures = ['nutrition.measurements.create'];
  await assert.rejects(f.service.addNutritionMeasurementClinicalPhoto('pac_ficticio', 2, { data_url: 'data:image/png;base64,YQ==' }, 7), e => e.status === 403);
  await assert.rejects(f.service.createNutritionMeasurementReportSnapshot('pac_ficticio', 2, 7), e => e.status === 403);
  f.state.deniedFeatures = ['nutrition.reports.finalize'];
  await assert.rejects(f.service.finalizeNutritionMeasurementReportSnapshot('pac_ficticio', 2, 7), e => e.status === 403);
  assert(!f.state.calls.some(c => c.name === 'storeBinary'));
});
test('legacy snapshots without the new provenance retain comparisons safely', async () => {
  const f = await sharedHistoryFixture(); delete f.state.reports[1].snapshot_json.meta.source_measurements;
  assert.equal(await f.service.renderNutritionMeasurementReport('pac_ficticio', 2, { actorUserId: 7 }), f.state.reports[1].snapshot_html);
  f.state.grants = [20]; f.state.reports[1].status = 'final';
  await assert.rejects(f.service.renderNutritionMeasurementReport('pac_ficticio', 2, { actorUserId: 7 }), e => e.status === 403);
});
test('projection-only dependencies are checked even without a previous measurement', async () => {
  const f = await sharedHistoryFixture(); const s = f.state.reports[1].snapshot_json;
  s.previous_measurement = null; s.report.comparison = { available: false }; delete s.meta.source_measurements;
  assert(s.projection.available); f.state.grants = [20]; f.state.reports[1].status = 'final';
  await assert.rejects(f.service.renderNutritionMeasurementReport('pac_ficticio', 2, { actorUserId: 7 }), e => e.status === 403);
});
test('current membership and dependency ownership are rechecked, not trusted from old snapshots', async () => {
  const f = await sharedHistoryFixture(); f.state.rows[0].patient_id = 2; f.state.reports[1].status = 'final';
  await assert.rejects(f.service.renderNutritionMeasurementReport('pac_ficticio', 2, { actorUserId: 7 }), e => e.status === 403);
  f.state.rows[0].patient_id = 1; f.state.links.length = 0;
  await assert.rejects(f.service.renderNutritionMeasurementReport('pac_ficticio', 2, { actorUserId: 7 }), e => e.status === 404);
});
test('final PDF cache is served only after its exact private owner has been verified', async () => {
  const f = await sharedHistoryFixture(); const snapshot = f.state.reports[1]; snapshot.status = 'final'; snapshot.pdf_asset_id = 99;
  f.state.assets.push({ id: 99, patient_id: 1, clinic_id: 20, owner_type: 'patient_nutrition_report', owner_id: String(snapshot.id), purpose: 'nutrition_report_pdf', status: 'active' });
  const result = await f.service.generateNutritionMeasurementReportPdf('pac_ficticio', 2, 7);
  assert.equal(result.cached, true); assert.equal(result.buffer.toString(), 'private fictitious binary');
  assert.equal(f.state.calls.find(c => c.name === 'readBinary').asset.owner_id, String(snapshot.id));
});
