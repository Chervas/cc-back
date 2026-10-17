'use strict';

// Fictitious, fully offline fixtures: never import models or contact CRM.
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const { createRequire } = require('node:module');
const configuration = require('../../lib/clinic-configuration');
const policy = require('../../lib/patient-intake-configuration');
const q = require('../../lib/patient-intake-questionnaire');
const { preparePatientIntake } = require('../../lib/patient-intake-consents');

test('questionnaire defaults on, parses persisted JSON and only an explicit false disables it', () => {
  for (const value of [null, undefined, '', 'bad json', {}, { patient_intake: {} }, { patient_intake: { medical_questionnaire_enabled: true } }]) {
    assert.equal(policy.medicalQuestionnaireEnabled(value), true);
  }
  assert.equal(policy.medicalQuestionnaireEnabled({ patient_intake: { medical_questionnaire_enabled: false } }), false);
  assert.equal(policy.medicalQuestionnaireEnabled('{"patient_intake":{"medical_questionnaire_enabled":false}}'), false);
});

test('clinic setting is a validated boolean patch that preserves unrelated configuration and future intake keys', () => {
  const current = { disciplinas: ['estetica'], agenda_settings: { slotGranularityMin: 10 },
    patient_intake: { medical_questionnaire_enabled: true, preserve_future_key: 'yes' }, unrelated: { keep: true } };
  const before = JSON.stringify(current);
  const disabled = configuration.mergeClinicConfiguration(current, { patient_intake: { medical_questionnaire_enabled: false } });
  assert.equal(disabled.patient_intake.medical_questionnaire_enabled, false);
  assert.equal(disabled.patient_intake.preserve_future_key, 'yes');
  assert.deepEqual(disabled.agenda_settings, current.agenda_settings); assert.deepEqual(disabled.unrelated, current.unrelated);
  assert.equal(JSON.stringify(current), before);
  assert.equal(configuration.normalizeClinicConfigurationForRead({}).patient_intake.medical_questionnaire_enabled, true);
  assert.equal(configuration.normalizeClinicConfigurationForRead(disabled).patient_intake.medical_questionnaire_enabled, false);
  assert.equal(Object.hasOwn(configuration.filterClinicConfigurationForSettingsAccess(disabled, false), 'patient_intake'), false);
  for (const patient_intake of [null, [], false, { medical_questionnaire_enabled: 'false' }, { medical_questionnaire_enabled: 0 }, { medical_questionnaire_enabled: null }]) {
    assert.throws(() => configuration.mergeClinicConfiguration(current, { patient_intake }), error => error.status === 400);
  }
});

function serviceFixture({ enabled = true, disableInTransaction = false, existing = null, clinicId = 72 } = {}) {
  const calls = [], writes = [], transaction = { LOCK: { SHARE: 'SHARE', UPDATE: 'UPDATE' } };
  const patient = { id_paciente: 17, clinica_id: clinicId, nombre: 'Paciente', apellidos: 'Prueba', alergias: '', medicacion: '', antecedentes: '',
    update: async values => { writes.push(['patient', values]); Object.assign(patient, values); } };
  const pkg = { id: 21, paciente_id: 17, clinica_id: clinicId, status: 'pending', expires_at: '2099-01-01' };
  let request = existing && { id: 22, patient_id: 17, clinic_id: clinicId, package_id: 21, schema_version: q.VERSION,
    version: 1, status: existing, personal_snapshot: q.personalSnapshot(patient), answers: { allergies: 'Respuesta ya recibida' },
    submitted_personal: q.personalSnapshot(patient),
    update: async values => { writes.push(['request-update', values]); Object.assign(request, values); } };
  const db = { Sequelize: { Op: { lt: Symbol('lt'), ne: Symbol('ne') } },
    sequelize: { transaction: async callback => callback(transaction) },
    Clinica: { findByPk: async (id, options) => { calls.push(['clinic', options]); assert.equal(id, clinicId);
      return { id_clinica: id, configuracion: { patient_intake: { medical_questionnaire_enabled: enabled && !(options.transaction && disableInTransaction) } } }; } },
    Paciente: { findByPk: async (id, options) => { calls.push(['patient', options]); return patient; } },
    PatientIntakeRequest: { findOne: async options => { calls.push(['request', options]); return request; },
      create: async values => { writes.push(['request-create', values]); request = { id: 22, ...values }; return request; } },
    ConsentSignaturePackage: { findByPk: async () => pkg, create: async values => { writes.push(['package', values]); return pkg; } },
    PatientConsentDocument: { count: async () => 0 },
  };
  const filename = path.resolve(__dirname, '../../services/patientIntake.service.js'), nativeRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, Date, require: name => name === '../../models' ? db : nativeRequire(name) });
  return { db, service: module.exports, calls, writes, patient, pkg, transaction, request,
    prepare: () => module.exports.prepare({ patientId: 17, clinicId, actorId: 7 }),
    payload: () => ({ schema_version: q.VERSION, expected_version: 1, reviewed_answers: true, personal: q.personalSnapshot(patient),
      answers: Object.fromEntries(q.fields.map(field => [field.key, field.type === 'choice' ? 'no' : ''])) }) };
}

for (const clinicId of [66, 72]) {
  test(`disabled clinic ${clinicId} blocks new and reused medical packages before any writes`, async () => {
    for (const existing of [null, 'pending', 'submitted']) {
      const f = serviceFixture({ clinicId, enabled: false, existing });
      await assert.rejects(f.prepare(), { code: 'patient_intake_disabled', statusCode: 409 });
      assert.equal(f.writes.length, 0); assert(!f.calls.some(([name]) => name === 'request'));
    }
  });
}

test('turning off the questionnaire after preflight is rechecked with a clinic SHARE lock before patient/package locks', async () => {
  const f = serviceFixture({ disableInTransaction: true, existing: 'pending' });
  await assert.rejects(f.prepare(), { code: 'patient_intake_disabled', statusCode: 409 });
  assert.equal(f.writes.length, 0);
  const locked = f.calls.filter(([, options]) => options.transaction);
  assert.deepEqual(locked.map(([name]) => name), ['clinic']);
  assert.equal(locked[0][1].lock, 'SHARE'); assert.equal(locked[0][1].transaction, f.transaction);
});

test('an enabled clinic retains independent questionnaire preparation and current-lock ordering', async () => {
  const f = serviceFixture({ clinicId: 121 }), result = await f.prepare();
  assert.equal(result.package_id, 21); assert.deepEqual(f.writes.map(([name]) => name), ['package', 'request-create']);
  const locked = f.calls.filter(([, options]) => options.transaction);
  assert.equal(locked[0][0], 'clinic'); assert.equal(locked[0][1].lock, 'SHARE'); assert.equal(locked[1][0], 'patient');
});

test('an existing tablet link cannot submit or expose medical questions after disable; received answers remain untouched', async () => {
  const f = serviceFixture({ enabled: false, existing: 'pending' }), before = JSON.stringify(f.request);
  assert.equal(await f.service.publicView(f.pkg), null);
  await assert.rejects(f.service.submit(f.pkg, f.payload()), { code: 'patient_intake_disabled', statusCode: 409 });
  assert.equal(f.writes.length, 0); assert.equal(JSON.stringify(f.request), before);
  assert(!f.calls.some(([name]) => name === 'request'));
});

test('previously submitted answers can still be reviewed and professionally confirmed while new requests are disabled', async () => {
  const f = serviceFixture({ enabled: false, existing: 'submitted' });
  const review = await f.service.reviewView({ patientId: 17, clinicId: 72 });
  assert.equal(review.request.id, 22); assert.equal(review.proposed.alergias, 'Respuesta ya recibida');
  const result = await f.service.confirm({ patientId: 17, clinicId: 72, actorId: 7, payload: {
    id: 22, expected_version: 1, patient_version: review.patient_version, apply_personal_changes: false, summary: review.proposed,
  } });
  assert.equal(result.reviewed, true); assert.equal(f.request.status, 'reviewed');
  assert.equal(f.patient.alergias, 'Respuesta ya recibida');
});

for (const privacyOnly of [false, true]) test(privacyOnly
  ? 'privacy-only preparation reuses a single LOPD package only after excluding any legacy questionnaire'
  : 'legacy full preparation excludes the disabled medical template while preserving its pending package contract', async () => {
  const calls = [], writes = [], transaction = { LOCK: { SHARE: 'SHARE', UPDATE: 'UPDATE' } };
  const db = { Sequelize: { Op: { in: Symbol('in'), or: Symbol('or'), gt: Symbol('gt') } },
    sequelize: { transaction: async callback => callback(transaction) },
    Clinica: { findByPk: async (id, options) => { calls.push(['clinic', options]); return { id_clinica: id,
      configuracion: { patient_intake: { medical_questionnaire_enabled: false } } }; } },
    Paciente: { findByPk: async (id, options) => { calls.push(['patient', options]); return { id_paciente: id, clinica_id: 72 }; } },
    ClinicConsentTemplate: { findAll: async () => [{ id: 1 }, { id: 2, catalog_key: 'cc_base_formulario_medico_alta_v1' }] },
    ClinicConsentTemplateVersion: { findOne: async options => { assert.equal(options.where.clinic_template_id, 1); return { id: 3, body_html: '<p>LOPD</p>' }; } },
    PatientConsentDocument: { findOne: async () => ({ id: 4, package_id: 5, status: 'pending' }),
      findAll: async options => { assert.equal(privacyOnly, true); calls.push(['package-documents', options]);
        assert.deepEqual(options.where, { package_id: 5 }); assert.equal(options.transaction, transaction);
        assert.equal(options.limit, 2); return [{ id: 4 }]; } },
    ConsentSignaturePackage: { findByPk: async () => ({ id: 5, status: 'pending', expires_at: '2099-01-01' }),
      create: async () => { writes.push('package'); throw Error('LOPD must be reused'); } },
    PatientIntakeRequest: { findOne: async options => { assert.equal(privacyOnly, true,
      'The explicit full-intake action preserves its legacy package contract');
      calls.push(['legacy-intake', options]); assert.deepEqual(options.where, { package_id: 5 });
      assert.equal(options.transaction, transaction); return null; } },
  };
  const result = await preparePatientIntake({ db, patientId: 17, clinicId: 72, actorId: 7, privacyOnly,
    snapshot: () => { throw Error('LOPD must be reused'); } });
  assert.equal(result.created_count, 0); assert.equal(result.existing_count, 1); assert.deepEqual(result.current_package_ids, [5]);
  assert.equal(writes.length, 0); assert.equal(calls[0][0], 'clinic'); assert.equal(calls[0][1].lock, 'SHARE');
  assert.equal(calls.some(([name]) => name === 'legacy-intake'), privacyOnly);
  assert.equal(calls.some(([name]) => name === 'package-documents'), privacyOnly);
});
