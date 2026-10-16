'use strict';
// Independent QA: all rows below are in-memory fictitious values. No DB/model bootstrap.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), vm = require('node:vm'), path = require('node:path');
const { createRequire } = require('node:module');
const { appointmentTabletStatus } = require('../../services/appointmentTabletStatus.service');
const { preparePatientIntake } = require('../../lib/patient-intake-consents');
const digital = require('../../lib/bs-privacy-digital-template');
const privacy = require('../../services/appointmentPrivacyEligibility.service');
const choices = require('../../lib/consent-document-choices');
const q = require('../../lib/patient-intake-questionnaire');
const SERVICE = path.resolve(__dirname, '../../services/patientIntake.service.js');
const normal = createRequire(SERVICE);

function signedStatusFixture(reason, patch = {}) {
  const transaction = { LOCK: { SHARE: 'SHARE', UPDATE: 'UPDATE' } }, calls = [];
  const Op = { in: Symbol('in'), or: Symbol('or'), gt: Symbol('gt'), ne: Symbol('ne') };
  const built = digital.buildBsPrivacyDigitalHtml();
  const template = { id: 90, clinic_id: 72, catalog_key: privacy.FINAL_PRIVACY_KEY, purpose: 'data_protection',
    status: 'active', is_default: true, blocking_policy: 'hard' };
  const version = { id: 313, clinic_template_id: 90, version: 2, locale: 'es', status: 'published',
    body_html: built.html, body_json: { consent_form: built.consent_form, digital_presentation: built.metadata } };
  const document = { id: 800, package_id: 700, paciente_id: 17, clinica_id: 72, clinic_template_id: 90,
    clinic_template_version_id: 313, purpose: 'data_protection', status: 'signed', signed_at: '2026-01-01T12:00:00Z',
    snapshot_json: { template, version, context: {}, integrity: { algorithm: choices.CHOICE_HASH_ALGORITHM },
      signature_evidence: { accepted_statement: true, signed_at: '2026-01-01T12:00:00Z', consent_choices: {
        schema_version: choices.CHOICE_SCHEMA_VERSION, answers: Object.fromEntries(choices.CHOICE_KEYS.map(key => [key, 'no'])) } } }, ...patch };
  document.snapshot_html = choices.appendSignedChoiceHtml(built.html, document, document.snapshot_json.signature_evidence.consent_choices);
  document.snapshot_hash = choices.choiceSnapshotHash(document.snapshot_json, document.snapshot_html);
  const db = { Sequelize: { Op },
    Clinica: { findByPk: async (id, options) => { calls.push(options); return { id_clinica: id }; } },
    ClinicConsentTemplate: { findAll: async options => { calls.push(options); return [options.attributes
      ? Object.fromEntries(options.attributes.map(key => [key, template[key]])) : template]; } },
    ClinicConsentTemplateVersion: { findOne: async options => { calls.push(options); return version; }, findAll: async options => { calls.push(options); return []; } },
    PatientConsentDocument: { findAll: async options => { calls.push(options); return [document]; } },
    PatientConsentExternalAttestation: { findAll: async options => { calls.push(options); return []; } },
    PatientOperationalEvent: { findAll: async options => { calls.push(options); return []; } },
    PatientIntakeRequest: { findOne: async options => { calls.push(options); return null; } },
    ConsentSignaturePackage: { findByPk: async () => { throw Error('Signed evidence must not depend on its expired tablet package'); } },
  };
  return { db, template, version, document, calls, transaction, run: () => appointmentTabletStatus({ db,
    appointment: { id_cita: 10, paciente_id: 17, clinica_id: 72 }, transaction,
    now: new Date('2026-10-15T10:00:00Z'), assessPrivacy: async () => ({ allowed: true, required: false, reason }) }) };
}

for (const reason of ['existing_imported_patient', 'existing_clinical_patient']) {
  test(`audited paper privacy stays paper when the start gate exempts ${reason}`, async () => {
    const f = signedStatusFixture(reason), paper = require('../../lib/registration-privacy-paper');
    const at = new Date('2026-10-15T08:00:00Z');
    const attestation = { id: 400, paciente_id: 17, clinica_id: 72, tratamiento_id: null,
      purpose: 'data_protection', source: paper.PAPER_SOURCE, status: 'active', attested_by: 7, attested_at: at, revoked_at: null };
    const event = { id: 401, patient_id: 17, clinic_id: 72, actor_user_id: 7, source: paper.PAPER_SOURCE,
      event_type: paper.PAPER_EVENT, channel: 'internal', occurred_at: at, metadata: {
        schema_version: paper.PAPER_SOURCE, attestation_id: 400, appointment_id: 10, clinic_template_id: 90,
        clinic_template_version_id: 313, catalog_key: privacy.FINAL_PRIVACY_KEY,
        source_document_sha256: digital.SOURCE_DOCUMENT_SHA256, legal_text_sha256: digital.LEGAL_TEXT_SHA256,
        acknowledged: true, recorded_at: at.toISOString(),
      } };
    f.db.PatientConsentDocument.findAll = async () => [];
    f.db.PatientConsentExternalAttestation.findAll = async options => { f.calls.push(options); return [attestation]; };
    f.db.PatientOperationalEvent.findAll = async options => { f.calls.push(options); return [event]; };
    const before = JSON.stringify([attestation, event]), result = await f.run();
    assert.equal(result.privacy.state, 'paper'); assert.equal(result.intake.state, 'not_sent');
    assert.equal(JSON.stringify([attestation, event]), before);
    assert(f.calls.every(options => options.transaction === f.transaction));
    assert(!JSON.stringify(result).includes('signature'));
    attestation.revoked_at = new Date('2026-10-15T09:00:00Z');
    assert.equal((await f.run()).privacy.state, 'not_sent');
  });
}

for (const reason of ['existing_imported_patient', 'existing_clinical_patient']) {
  test(`real signed privacy stays completed when the start gate exempts ${reason}`, async () => {
    const f = signedStatusFixture(reason), before = JSON.stringify(f.document), result = await f.run();
    assert.equal(result.privacy.state, 'completed');
    assert.equal(result.intake.state, 'not_sent');
    assert.equal(JSON.stringify(f.document), before);
    assert(f.calls.every(options => options.transaction === f.transaction));
    assert(!JSON.stringify(result).includes('consent_choices'));
    assert(!JSON.stringify(result).includes('snapshot'));
  });
}
for (const patch of [{ revoked_at: '2026-10-14T00:00:00Z' }, { paciente_id: 99 }, { clinica_id: 66 },
  { expires_at: '2026-01-02T00:00:00Z' }, { signed_at: null }]) {
  test(`start exemption does not validate bad signed privacy: ${JSON.stringify(patch)}`, async () => {
    const result = await signedStatusFixture('existing_imported_patient', patch).run();
    assert.equal(result.privacy.state, 'not_sent');
  });
}

function healthFixture({ oldCombined = false, oldSubmitted = false } = {}) {
  const writes = [], calls = [], packages = [], requests = [];
  let id = 900, tail = Promise.resolve();
  const patient = { id_paciente: 17, clinica_id: 72, nombre: 'Paciente', apellidos: 'Ficticio', dni: '',
    fecha_nacimiento: null, telefono_movil: '', email: '', alergias: '', medicacion: '', antecedentes: '' };
  const Op = { in: Symbol('in'), or: Symbol('or'), gt: Symbol('gt'), lt: Symbol('lt'), ne: Symbol('ne') };
  const matches = (row, where) => Object.entries(where || {}).every(([key, value]) => {
    if (!value || typeof value !== 'object' || value instanceof Date) return row[key] === value;
    if (Object.hasOwn(value, Op.gt)) return new Date(row[key]) > new Date(value[Op.gt]);
    if (Object.hasOwn(value, Op.lt)) return row[key] < value[Op.lt];
    if (Object.hasOwn(value, Op.ne)) return row[key] !== value[Op.ne];
    if (value[Op.in]) return value[Op.in].includes(row[key]);
    throw Error('Unexpected in-memory predicate');
  });
  const row = values => ({ version: 1, schema_version: q.VERSION, status: 'pending', personal_snapshot: q.personalSnapshot(patient),
    ...values, async update(patch) { writes.push(['request-update', this.id]); Object.assign(this, patch); } });
  if (oldCombined) {
    packages.push({ id: 700, paciente_id: 17, clinica_id: 72, status: 'viewed', expires_at: new Date('2099-01-01') });
    requests.push(row({ id: 800, package_id: 700, patient_id: 17, clinic_id: 72, status: oldSubmitted ? 'submitted' : 'pending' }));
  }
  const db = { Sequelize: { Op }, sequelize: { transaction: async callback => {
    const transaction = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } };
    const previous = tail; let release;
    tail = new Promise(resolve => { release = resolve; });
    await previous;
    try { return await callback(transaction); } finally { release(); }
  } }, Paciente: { findByPk: async (key, options) => { calls.push(['patient', options]);
    assert.equal(key, 17); if (options?.transaction) assert.equal(options.lock, 'UPDATE'); return patient; } },
  Clinica: { findByPk: async id => ({ id_clinica: id }) },
  PatientIntakeRequest: {
    findOne: async options => { calls.push(['request', options]); return requests.filter(r => matches(r, options.where)).sort((a, b) => b.id - a.id)[0] || null; },
    create: async (values, options) => { assert(options.transaction); const created = row({ id: ++id, ...values });
      requests.push(created); writes.push(['request-create', created.id]); return created; },
  }, ConsentSignaturePackage: {
    findByPk: async key => packages.find(p => p.id === key) || null,
    create: async (values, options) => { assert(options.transaction); const created = { id: ++id, ...values };
      packages.push(created); writes.push(['package-create', created.id]); return created; },
  }, PatientConsentDocument: { count: async options => oldCombined && options.where.package_id === 700 ? 1 : 0 },
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(SERVICE, 'utf8'), { module, exports: module.exports, Date, require(name) {
    if (name === '../../models') return db;
    if (name === './consentimientos.service') throw Error('An explicit medical questionnaire must never prepare/sign/send LOPD');
    return normal(name);
  } });
  const service = module.exports;
  return { service, patient, packages, requests, calls, writes,
    prepare: () => service.prepare({ patientId: 17, clinicId: 72, actorId: 7 }),
    payload: () => ({ schema_version: q.VERSION, expected_version: 1, reviewed_answers: true,
      answers: Object.fromEntries(q.fields.map(f => [f.key, f.type === 'choice' ? 'no' : ''])), personal: q.personalSnapshot(patient) }) };
}

test('first medical preparation has no privacy dependency and two concurrent requests converge on one questionnaire', async () => {
  const f = healthFixture();
  const [a, b] = await Promise.all([f.prepare(), f.prepare()]);
  assert.equal(a.package_id, b.package_id); assert.equal(a.intake_id, b.intake_id);
  assert.equal(f.packages.length, 1); assert.equal(f.requests.length, 1);
  assert.equal(f.writes.length, 2); assert.equal(a.reused, false); assert.equal(b.reused, true);
  assert(f.calls.filter(([name]) => name === 'request').some(([, options]) => options.transaction && options.lock === 'SHARE'));
});

test('separating an old combined request never edits the old pending package or document', async () => {
  const f = healthFixture({ oldCombined: true }), before = JSON.stringify([f.packages[0], f.requests[0]]);
  const result = await f.prepare();
  assert.notEqual(result.package_id, 700); assert.equal(result.reused, false);
  assert.equal(JSON.stringify([f.packages[0], f.requests[0]]), before);
  assert.deepEqual(f.writes.map(([name]) => name), ['package-create', 'request-create']);
});

test('a submitted historical combined questionnaire blocks a fresh empty request until clinical review', async () => {
  const f = healthFixture({ oldCombined: true, oldSubmitted: true });
  await assert.rejects(f.prepare(), { code: 'intake_review_pending', statusCode: 409 });
  assert.equal(f.writes.length, 0);
});

test('an older combined tablet cannot silently submit answers behind the newly prepared questionnaire', async () => {
  const f = healthFixture({ oldCombined: true });
  await f.prepare();
  // The old tab/token is still active. Accepting it as "submitted" would leave
  // reviewView showing only the newer empty request, hiding the patient's data.
  await assert.rejects(f.service.submit(f.packages[0], f.payload()), error =>
    ['intake_request_superseded', 'intake_version_conflict', 'intake_already_submitted'].includes(error.code));
  assert.equal(f.requests[0].status, 'pending');
});

test('privacy-only preparation does not report signed success when only the retired medical default exists', async () => {
  const transaction = { LOCK: { UPDATE: 'UPDATE', SHARE: 'SHARE' } }, writes = [];
  const db = { Sequelize: { Op: {} }, sequelize: { transaction: callback => callback(transaction) },
    Paciente: { findByPk: async () => ({ id_paciente: 17, clinica_id: 72 }) },
    Clinica: { findByPk: async () => ({ id_clinica: 72 }) },
    ClinicConsentTemplate: { findAll: async () => [{ id: 99, catalog_key: 'cc_base_formulario_medico_alta_v1' }] },
    ConsentSignaturePackage: { create: async () => { writes.push('package'); throw Error('Must not create empty package'); } },
  };
  await assert.rejects(preparePatientIntake({ db, patientId: 17, clinicId: 72, actorId: 7, privacyOnly: true,
    snapshot: () => { throw Error('Retired medical template must not be snapshotted'); } }), /intake_published_templates_required/);
  assert.equal(writes.length, 0);
});
