'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), { createRequire } = require('node:module');
const { preparePatientIntake } = require('../../lib/patient-intake-consents');
const choices = require('../../lib/consent-document-choices'), digital = require('../../lib/bs-privacy-digital-template');
const privacy = require('../../services/appointmentPrivacyEligibility.service');
const q = require('../../lib/patient-intake-questionnaire');
const file = path.resolve(__dirname, '../../services/patientIntake.service.js'), normal = createRequire(file);

function fixture({ primary = 66, linked = true, targetGroup = 29, oldParentStatus = null, foreignRequest = false,
  removeLinkInTransaction = false, foreignRequestId = false } = {}) {
  const writes = [], queries = [], transaction = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } };
  const patient = { id_paciente: 17, public_id: 'pac_ficticio', clinica_id: primary, nombre: 'Paciente', apellidos: 'Ficticio',
    dni: '', fecha_nacimiento: null, email: '', telefono_movil: '', alergias: '', medicacion: '', antecedentes: '',
    update: async patch => { writes.push(['patient', patch]); Object.assign(patient, patch); } };
  const built = digital.buildBsPrivacyDigitalHtml();
  const template = { id: 90, clinic_id: 72, purpose: 'data_protection', status: 'active', is_default: true,
    blocking_policy: 'hard', catalog_key: privacy.FINAL_PRIVACY_KEY };
  const version = { id: 313, clinic_template_id: 90, version: 2, status: 'published', locale: 'es', title: 'LOPD digital',
    body_html: built.html, body_json: { consent_form: built.consent_form, digital_presentation: built.metadata } };
  const doc = { id: 800, package_id: 700, paciente_id: 17, clinica_id: 72, clinic_template_id: 90,
    clinic_template_version_id: 313, purpose: 'data_protection', status: 'signed', signed_at: '2026-01-01',
    snapshot_json: { template, version, context: {}, integrity: { algorithm: choices.CHOICE_HASH_ALGORITHM },
      signature_evidence: { accepted_statement: true, signed_at: '2026-01-01', consent_choices: {
        schema_version: choices.CHOICE_SCHEMA_VERSION, answers: Object.fromEntries(choices.CHOICE_KEYS.map(key => [key, 'no'])) } } } };
  doc.snapshot_html = choices.appendSignedChoiceHtml(built.html, doc, doc.snapshot_json.signature_evidence.consent_choices);
  doc.snapshot_hash = choices.choiceSnapshotHash(doc.snapshot_json, doc.snapshot_html);
  const signedBefore = JSON.stringify(doc);
  const packages = [{ id: 700, paciente_id: 17, clinica_id: 72, trigger_source: 'patient_intake', status: 'signed', expires_at: new Date('2099-01-01') }];
  const requests = [];
  const requestRow = row => ({ schema_version: q.VERSION, version: 1, personal_snapshot: q.personalSnapshot(patient),
    ...row, update: async patch => { writes.push(['request-update', row.id, patch]); Object.assign(requests.find(item => item.id === row.id), patch); } });
  if (oldParentStatus) {
    packages.push({ id: 99, paciente_id: 17, clinica_id: 72, status: oldParentStatus, expires_at: new Date('2099-01-01') });
    requests.push(requestRow({ id: 4, package_id: 99, patient_id: 17, clinic_id: 72, status: 'pending' }));
  }
  if (foreignRequest) requests.push(requestRow({ id: 5, package_id: 98, patient_id: 17, clinic_id: 66,
    status: 'submitted', answers: { allergies: 'Respuesta privada de otra clínica' }, submitted_at: new Date('2026-01-01') }));
  const Op = { in: Symbol('in'), gt: Symbol('gt'), lt: Symbol('lt'), ne: Symbol('ne'), or: Symbol('or') };
  const matches = (row, where) => Object.entries(where || {}).every(([key, value]) => {
    if (!value || typeof value !== 'object' || value instanceof Date) return row[key] === value;
    if (value[Op.in]) return value[Op.in].includes(row[key]);
    if (Object.hasOwn(value, Op.gt)) return new Date(row[key]) > new Date(value[Op.gt]);
    if (Object.hasOwn(value, Op.lt)) return row[key] < value[Op.lt];
    if (Object.hasOwn(value, Op.ne)) return row[key] !== value[Op.ne];
    return false;
  });
  const db = { Sequelize: { Op }, sequelize: { transaction: async callback => callback(transaction) },
    Paciente: { findByPk: async (id, options) => { queries.push(['patient', id, options]); return patient; } },
    PacienteClinica: { findOne: async options => { queries.push(['membership', options]); return linked && !(removeLinkInTransaction && options.transaction)
      ? { id: 2, paciente_id: 17, clinica_id: 72 } : null; } },
    Clinica: { findByPk: async (id, options) => { queries.push(['clinic', id, options]); return { id_clinica: id, grupoClinicaId: id === 66 ? 29 : targetGroup }; } },
    ClinicConsentTemplate: { findAll: async options => { assert.equal(options.where.clinic_id, 72); return [template]; } },
    ClinicConsentTemplateVersion: { findOne: async () => version, findAll: async () => [] },
    PatientConsentExternalAttestation: { findAll: async () => [] }, PatientOperationalEvent: { findAll: async () => [] },
    PatientConsentDocument: {
      findOne: async options => { assert.equal(options.where.paciente_id, 17); assert.equal(options.where.clinica_id, 72); return doc; },
      count: async options => options.where.package_id === 700 ? 1 : 0,
      create: async () => { throw Error('A valid signed LOPD must never be duplicated or signed by preparation'); },
    },
    ConsentSignaturePackage: {
      findByPk: async id => packages.find(row => row.id === id),
      findOne: async options => packages.filter(row => matches(row, options.where)).sort((a, b) => b.id - a.id)[0] || null,
      create: async (values, options) => { assert.equal(options.transaction, transaction); const row = { id: 900, ...values };
        packages.push(row); writes.push(['package', row]); return row; },
    },
    PatientIntakeRequest: {
      findOne: async options => { queries.push(['request', options]);
        if (foreignRequestId && options.where.id) return null;
        return requests.filter(row => matches(row, options.where)).sort((a, b) => b.id - a.id)[0] || null;
      },
      create: async (values, options) => { assert.equal(options.transaction, transaction);
        const row = requestRow({ id: 901, status: 'pending', ...values }); requests.push(row); writes.push(['request', row]); return row; },
    },
  };
  let privacyCalls = 0;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { module, exports: module.exports, Date, require(name) {
    if (name === '../../models') return db;
    if (name === './consentimientos.service') return { createPatientIntakePackage: async (id, options) => {
      privacyCalls++; assert.equal(id, 17); assert.equal(options.clinicId, 72); assert.equal(options.allowLinkedClinic, true);
      assert.equal(options.transaction, transaction); assert.equal(options.structuredQuestionnaire, true);
      return preparePatientIntake({ db, patientId: id, clinicId: options.clinicId, actorId: options.createdBy,
        structuredQuestionnaire: true, allowLinkedClinic: true, transaction: options.transaction,
        snapshot: () => { throw Error('Existing signature must be reused without a new document snapshot'); } });
    } };
    return normal(name);
  } });
  return { service: module.exports, db, transaction, patient, packages, requests, doc, signedBefore, queries, writes,
    privacyCalls: () => privacyCalls, prepare: () => module.exports.prepare({ patientId: 17, clinicId: 72, actorId: 7 }) };
}

test('shared patient with an existing real four-No LOPD receives only a new health questionnaire in the selected clinic', async () => {
  const f = fixture(), result = await f.prepare();
  assert.equal(result.package_id, 900); assert.equal(result.intake_id, 901); assert.equal(result.reused, false);
  assert.deepEqual(f.writes.map(row => row[0]), ['package', 'request']);
  assert.equal(f.requests[0].patient_id, 17); assert.equal(f.requests[0].clinic_id, 72); assert.equal(f.requests[0].status, 'pending');
  assert.equal(JSON.stringify(f.doc), f.signedBefore); assert.equal(f.doc.status, 'signed');
  assert.equal(f.packages.find(row => row.id === 900).clinica_id, 72);
  const replay = await f.prepare(); assert.equal(replay.package_id, 900); assert.equal(replay.reused, true);
  assert.equal(f.writes.length, 2, 'Repeated send reuses the questionnaire and never creates another LOPD or request');
});
test('cancelled or expired old questionnaire parents are preserved and never reused', async () => {
  for (const status of ['cancelled', 'expired']) {
    const f = fixture({ oldParentStatus: status }), old = JSON.stringify([f.packages[1], f.requests[0]]);
    const result = await f.prepare(); assert.equal(result.package_id, 900); assert.equal(result.reused, false);
    assert.equal(JSON.stringify([f.packages[1], f.requests[0]]), old); assert.equal(JSON.stringify(f.doc), f.signedBefore);
  }
});
test('questionnaires are isolated by clinic: another clinic submission does not block, populate or get overwritten', async () => {
  const f = fixture({ foreignRequest: true }), before = JSON.stringify(f.requests[0]);
  await f.prepare(); const review = await f.service.reviewView({ patientId: 17, clinicId: 72 });
  assert.equal(review.request.id, 901); assert.equal(review.request.clinic_id, 72);
  assert.equal(review.proposed.alergias, ''); assert.equal(JSON.stringify(f.requests[0]), before);
  assert.equal(JSON.stringify(f.doc), f.signedBefore);
});
test('membership removed between controller/preflight and transaction stops before privacy or questionnaire writes', async () => {
  const f = fixture({ removeLinkInTransaction: true }); await assert.rejects(f.prepare(), { code: 'intake_patient_scope', statusCode: 403 });
  assert.equal(f.privacyCalls(), 0); assert.equal(f.writes.length, 0);
});
test('no membership or another group is rejected without preparing privacy, disclosing answers or writing', async () => {
  for (const options of [{ linked: false }, { targetGroup: 30 }]) {
    const f = fixture(options);
    await assert.rejects(f.prepare(), { code: 'intake_patient_scope' });
    await assert.rejects(f.service.reviewView({ patientId: 17, clinicId: 72 }), { code: 'intake_patient_scope' });
    assert.equal(f.privacyCalls(), 0); assert.equal(f.writes.length, 0);
  }
});
test('review and professional confirmation use the same linked scope while binding exact request, patient and clinic', async () => {
  const f = fixture(); await f.prepare(); const request = f.requests.find(row => row.id === 901);
  Object.assign(request, { status: 'submitted', answers: { allergies: 'Respuesta ficticia' }, submitted_personal: q.personalSnapshot(f.patient) });
  const review = await f.service.reviewView({ patientId: 17, clinicId: 72 });
  const result = await f.service.confirm({ patientId: 17, clinicId: 72, actorId: 7, payload: {
    id: request.id, expected_version: request.version, patient_version: review.patient_version,
    apply_personal_changes: false, summary: review.proposed,
  } });
  assert.equal(result.reviewed, true); assert.equal(request.status, 'reviewed'); assert.equal(request.reviewed_by, 7);
  assert.equal(f.patient.clinica_id, 66, 'Review never transfers the patient to the selected clinic');
  assert.equal(f.patient.alergias, 'Respuesta ficticia'); assert.equal(JSON.stringify(f.doc), f.signedBefore);
  const lockedPatients = f.queries.filter(([kind, , options]) => kind === 'patient' && options?.transaction);
  assert(lockedPatients.length > 0); assert(lockedPatients.every(([, , options]) => options.lock === 'UPDATE'));
  const anchors = f.queries.filter(([kind, , options]) => kind === 'clinic' && options?.attributes?.includes('grupoClinicaId') && options.transaction);
  assert(anchors.every(([, , options]) => options.lock === 'SHARE'));
});
test('professional confirmation cannot select a request from another clinic even when the patient is shared', async () => {
  const f = fixture({ foreignRequest: true, foreignRequestId: true });
  await assert.rejects(f.service.confirm({ patientId: 17, clinicId: 72, actorId: 7, payload: { id: 5, expected_version: 1 } }), { code: 'intake_review_conflict' });
  assert.equal(f.writes.length, 0); assert.equal(f.requests[0].status, 'submitted');
});
