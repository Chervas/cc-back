'use strict';

// This suite owns a new mysqld + Unix socket and never loads the real model
// index. No DEV/CRM record, provider, queue or real tablet token is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { Sequelize, DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const privacy = require('../../lib/bs-privacy-digital-template');
const choices = require('../../lib/consent-document-choices');
const eligibility = require('../../services/appointmentPrivacyEligibility.service');
const SCHEMA = 'bs-lopd-identity/v1';
const IDENTITY_KEYS = ['nombre', 'apellidos', 'dni', 'fecha_nacimiento', 'compania', 'direccion',
  'codigo_postal', 'ciudad', 'provincia', 'telefono', 'telefono2', 'email'];
const sha256 = value => createHash('sha256').update(value).digest('hex');
// Captured from the approved renderer before the two optional source fields
// were added. Existing nine-field/empty legal documents must remain byte exact.
const HISTORICAL_NINE_FIELD_HTML_SHA256 = 'cc6bcea18f396b599abbe67e128d722b707e2330231c8a0a9e8312ba161b20c2';
const APPROVED_EMPTY_HTML_SHA256 = 'ed70068001f5fc936c7478481865aa7c62eba04c623723b580831c2a519bf893';
const historicalPatient = { nombre_completo: 'Paciente antiguo ficticio', dni: 'QA-OLD-NOT-REAL',
  fecha_nacimiento: '02/01/1980', direccion: 'Calle antigua 2', codigo_postal: '03003', ciudad: 'Alicante',
  provincia: 'Alicante', telefono: '+34000000000', email: 'old@example.invalid' };
const TEST_TOKEN_SECRET = 'OWNED-ISOLATED-LOPD-IDENTITY-TEST-NOT-A-PRODUCTION-SECRET';
const noChoices = () => ({ schema_version: choices.CHOICE_SCHEMA_VERSION,
  answers: Object.fromEntries(choices.CHOICE_KEYS.map(key => [key, 'no'])) });
const signature = { signer_name: 'Firmante ficticio QA', accepted_statement: true,
  signature_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=' };
const snapshotOf = row => JSON.stringify(row.toJSON());
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

function defineModels(sql, db) {
  db.Sequelize = Sequelize;
  db.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true },
    grupoClinicaId: D.INTEGER, nombre_clinica: D.STRING(100), datos_fiscales_clinica: D.JSON, configuracion: D.JSON,
    direccion: D.STRING(150), codigo_postal: D.STRING(12), ciudad: D.STRING(100), provincia: D.STRING(100),
    pais: D.STRING(100), email: D.STRING(100), telefono: D.STRING(40), telefono_whatsapp: D.STRING(40),
  }, { tableName: 'Clinicas', timestamps: false });
  db.Paciente = sql.define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true },
    clinica_id: D.INTEGER, public_id: D.STRING(80), nombre: D.STRING(100), apellidos: D.STRING(100),
    dni: D.STRING(40), email: D.STRING(100), telefono_movil: D.STRING(40), telefono_secundario: D.STRING(40), fecha_nacimiento: D.DATEONLY,
    direccion: D.STRING(150), codigo_postal: D.STRING(12), ciudad: D.STRING(100), poblacion: D.STRING(100), provincia: D.STRING(100),
    alergias: D.TEXT, medicacion: D.TEXT, antecedentes: D.TEXT, edad: D.INTEGER,
    acepta_marketing: { type: D.BOOLEAN, defaultValue: false },
  }, { tableName: 'Pacientes', timestamps: false });
  db.Tratamiento = sql.define('Tratamiento', { id_tratamiento: { type: D.INTEGER, primaryKey: true },
    nombre: D.STRING(100), disciplina: D.STRING(100) }, { tableName: 'Tratamientos', timestamps: false });
  db.CitaPaciente = sql.define('CitaPaciente', { id_cita: { type: D.INTEGER, primaryKey: true },
    clinica_id: D.INTEGER, paciente_id: D.INTEGER, tratamiento_id: D.INTEGER, inicio: D.DATE, fin: D.DATE,
    estado: D.STRING(40), es_provisional: D.BOOLEAN, care_started_at: D.DATE, care_legacy_attendance: D.BOOLEAN,
  }, { tableName: 'CitasPacientes', timestamps: false });
  for (const name of ['ClinicConsentTemplate', 'ClinicConsentTemplateVersion', 'ConsentSignaturePackage',
    'PatientConsentDocument', 'ConsentDeliveryEvent', 'PatientIntakeRequest', 'PatientCustomField',
    'PacienteClinica', 'PatientConsentExternalAttestation', 'PatientOperationalEvent', 'TreatmentConsentRequirement']) {
    db[name] = require(`../../../models/${name.toLowerCase()}`)(sql, D);
  }
  db.PatientOperationalEvent.options.indexes.forEach((index, i) => { index.name = `qa_identity_patient_event_${i}`; });
  const belongs = (model, target, foreignKey, as, targetKey) => model.belongsTo(target,
    { foreignKey, as, targetKey, constraints: false });
  for (const model of [db.ConsentSignaturePackage, db.PatientConsentDocument]) {
    belongs(model, db.Paciente, 'paciente_id', 'paciente', 'id_paciente');
    belongs(model, db.Clinica, 'clinica_id', 'clinica', 'id_clinica');
    belongs(model, db.Tratamiento, 'tratamiento_id', 'tratamiento', 'id_tratamiento');
  }
  belongs(db.PatientConsentDocument, db.ConsentSignaturePackage, 'package_id', 'package', 'id');
  db.ConsentSignaturePackage.hasMany(db.PatientConsentDocument, { foreignKey: 'package_id', as: 'documents', constraints: false });
}

test('editable independent BS LOPD identity: native MySQL scope, CAS, frozen evidence, PDF and compatibility', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 180000,
}, async () => withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  defineModels(sql, db);
  await sql.sync(); // Fixture first proves this is its own newly initialized DB.
  const previousSecret = process.env.CONSENT_PUBLIC_TOKEN_SECRET;
  process.env.CONSENT_PUBLIC_TOKEN_SECRET = TEST_TOKEN_SECRET;
  const service = require('../../services/consentimientos.service');
  if (previousSecret === undefined) delete process.env.CONSENT_PUBLIC_TOKEN_SECRET;
  else process.env.CONSENT_PUBLIC_TOKEN_SECRET = previousSecret;
  const update = (...args) => service.updatePublicDocumentPersonalData(...args);
  assert.equal(typeof service.updatePublicDocumentPersonalData, 'function');
  const canonical = privacy.buildBsPrivacyDigitalHtml();
  assert.equal(sha256(canonical.html), APPROVED_EMPTY_HTML_SHA256, 'Published empty body must not change for optional identity fields');
  assert.equal(sha256(privacy.buildBsPrivacyDigitalHtml({ paciente: historicalPatient }).html), HISTORICAL_NINE_FIELD_HTML_SHA256,
    'Previously signed nine-field document HTML remains byte exact');
  const versions = {};
  for (const clinicId of [66, 72]) {
    await db.Clinica.create({ id_clinica: clinicId, grupoClinicaId: 9, nombre_clinica: `Clínica ficticia ${clinicId}`,
      configuracion: { patient_intake: { medical_questionnaire_enabled: false } } });
    const template = await db.ClinicConsentTemplate.create({ public_id: `qa_identity_template_${clinicId}`,
      clinic_id: clinicId, catalog_key: eligibility.FINAL_PRIVACY_KEY, name: 'LOPD ficticia QA',
      purpose: 'data_protection', status: 'active', is_default: true, blocking_policy: 'hard', validity_mode: 'manual' });
    versions[clinicId] = await db.ClinicConsentTemplateVersion.create({ clinic_template_id: template.id,
      version: 2, locale: 'es', title: 'Protección de datos', status: 'published', body_html: canonical.html,
      body_json: { digital_presentation: canonical.metadata, consent_form: canonical.consent_form },
      variable_schema: { consent_form: canonical.consent_form } });
  }
  let patientId = 1000;
  const prepare = async (clinicId = 72, patch = {}) => {
    const id = ++patientId;
    const patient = await db.Paciente.create({ id_paciente: id, clinica_id: clinicId, public_id: `qa_identity_patient_${id}`,
      nombre: 'Paciente', apellidos: `Ficticio ${id}`, dni: 'QA-NO-REAL', fecha_nacimiento: '1980-01-02',
      direccion: 'Calle inicial 1', codigo_postal: '03003', ciudad: 'Alicante', poblacion: 'Alicante', provincia: 'Alicante',
      telefono_movil: '+34000000000', telefono_secundario: '+34000000001',
      email: `qa-${id}@example.invalid`, acepta_marketing: false, ...patch });
    const prepared = await service.createPatientIntakePackage(id, { clinicId, createdBy: 1 });
    const session = await service.createTabletSession(prepared.package_id);
    const view = await service.getPublicPackage(session.public_token);
    assert.equal(view.documents.length, 1);
    assert.equal(view.intake, null);
    assert.equal(await db.PatientIntakeRequest.count({ where: { patient_id: id } }), 0);
    const doc = view.documents[0];
    assert.equal(doc.personal_data_form.schema_version, SCHEMA);
    assert.deepEqual(doc.personal_data_form.fields.map(field => field.key), IDENTITY_KEYS);
    assert.deepEqual(Object.keys(doc.personal_data_form.values).sort(), [...IDENTITY_KEYS].sort());
    assert.equal(doc.personal_data_form.editable, true);
    assert.equal(doc.personal_data_form.confirmed, false);
    assert.equal(doc.choice_answers, null);
    return { patient, patientId: id, clinicId, prepared, session, view, doc };
  };
  const refresh = item => db.PatientConsentDocument.findByPk(item.doc.id);
  const payload = (doc, values = doc.personal_data_form.values) => ({ schema_version: SCHEMA,
    snapshot_hash: doc.snapshot_hash, values: structuredClone(values) });
  const signPayload = doc => ({ ...signature, document_choices: { [doc.id]: noChoices() },
    document_snapshot_hashes: { [doc.id]: doc.snapshot_hash } });
  const confirm = async (item, values = item.doc.personal_data_form.values) => {
    const result = await update(item.session.public_token, String(item.doc.id), payload(item.doc, values),
      { ip: '127.0.0.1', userAgent: 'OWNED isolated test' });
    assert.equal(result.documents.length, 1);
    assert.equal(result.intake, null);
    const doc = result.documents[0];
    assert.equal(doc.personal_data_form.confirmed, true);
    assert.equal(doc.personal_data_form.editable, true);
    assert.notEqual(doc.snapshot_hash, item.doc.snapshot_hash);
    return doc;
  };
  const assess = async item => sql.transaction(transaction => eligibility.assessPrivacyBeforeStart({ db,
    appointment: { id_cita: item.patientId, clinica_id: item.clinicId, paciente_id: item.patientId }, transaction }));
  const unchangedRejection = async (item, run, statuses = [400, 409]) => {
    const before = snapshotOf(await refresh(item)), eventCount = await db.ConsentDeliveryEvent.count();
    await assert.rejects(run(), error => statuses.includes(error.statusCode));
    assert.equal(snapshotOf(await refresh(item)), before);
    assert.equal(await db.ConsentDeliveryEvent.count(), eventCount);
  };

  // Both real published presentation pins are used, not a simplified fake legal
  // body. Changing editable data must not alter the approved legal source.
  for (const clinicId of [66, 72]) {
    const item = await prepare(clinicId);
    assert.equal(item.doc.personal_data_form.values.nombre, 'Paciente');
    assert.equal(item.doc.personal_data_form.values.apellidos, `Ficticio ${item.patientId}`);
    assert.equal(item.doc.personal_data_form.values.fecha_nacimiento, '1980-01-02');
    assert.equal(item.doc.personal_data_form.values.direccion, 'Calle inicial 1');
    assert.equal(item.doc.personal_data_form.values.compania, '', 'Do not invent a company not present in the patient record');
    assert.equal(item.doc.personal_data_form.values.telefono2, '+34000000001', 'Secondary telephone is prefilled from the real patient field');
    assert.equal(item.doc.personal_data_form.fields.filter(field => field.required).length, 2);
    const patientBefore = snapshotOf(await db.Paciente.findByPk(item.patientId));
    assert.equal((await assess(item)).allowed, false);
    await unchangedRejection(item, () => service.signPublicPackage(item.session.public_token, signPayload(item.doc)));
    const values = { ...item.doc.personal_data_form.values, nombre: 'Paciente Corregido',
      dni: '', direccion: 'Calle corregida 99 & prueba', ciudad: 'Elche', email: 'corregido@example.invalid',
      compania: 'Compañía ficticia QA', telefono2: '+34000000002' };
    const corrected = await confirm(item, values);
    const persisted = await refresh(item);
    assert.equal(persisted.snapshot_json.context.paciente.nombre, values.nombre);
    assert.equal(persisted.snapshot_json.context.paciente.nombre_completo, `${values.nombre} ${values.apellidos}`);
    assert.equal(persisted.snapshot_json.context.paciente.dni, '');
    assert.equal(persisted.snapshot_json.context.paciente.direccion, values.direccion);
    assert.equal(persisted.snapshot_json.context.paciente.ciudad, 'Elche');
    assert.equal(persisted.snapshot_json.context.paciente.compania, values.compania);
    assert.equal(persisted.snapshot_json.context.paciente.telefono2, values.telefono2);
    assert.equal(persisted.snapshot_json.patient_identity.values.compania, values.compania);
    assert.equal(persisted.snapshot_json.patient_identity.values.telefono2, values.telefono2);
    assert(persisted.snapshot_json.patient_identity, 'Confirmation evidence belongs to this single document');
    assert.equal(persisted.snapshot_html, privacy.buildBsPrivacyDigitalHtml(persisted.snapshot_json.context).html);
    assert.equal(persisted.snapshot_hash, choices.choiceSnapshotHash(persisted.snapshot_json, persisted.snapshot_html));
    assert.equal(snapshotOf(await db.Paciente.findByPk(item.patientId)), patientBefore,
      'Public contact corrections never silently overwrite master data or external delivery destinations');
    await unchangedRejection(item, () => service.signPublicPackage(item.session.public_token, {
      ...signature, document_snapshot_hashes: { [corrected.id]: corrected.snapshot_hash } }));
    await unchangedRejection(item, () => service.signPublicPackage(item.session.public_token, {
      ...signature, document_choices: { [corrected.id]: noChoices() } }));
    await unchangedRejection(item, () => service.signPublicPackage(item.session.public_token, signPayload(item.doc)));
    const result = await service.signPublicPackage(item.session.public_token, signPayload(corrected));
    assert.equal(result.signed_count, 1);
    const signed = await refresh(item), frozen = snapshotOf(signed);
    assert.equal(signed.status, 'signed');
    assert.deepEqual(choices.signedConsentChoiceAnswers(signed), noChoices().answers);
    assert.equal(signed.snapshot_hash, choices.choiceSnapshotHash(signed.snapshot_json, signed.snapshot_html));
    assert.equal((await assess(item)).allowed, true);
    const printed = await service.renderConsentDocument(String(corrected.id));
    assert(printed.includes('Paciente Corregido'));
    assert(printed.includes('Calle corregida 99 &amp; prueba'));
    assert(printed.includes('Compañía ficticia QA'));
    assert(printed.includes('+34000000002'));
    assert(!printed.includes('Calle inicial 1'));
    assert.equal((printed.match(/☐ Sí · ☑ No/g) || []).length, 4);
    assert(printed.includes(signed.snapshot_hash));
    const pdf = await service.generateConsentDocumentPdf(String(corrected.id));
    assert.equal(pdf.buffer.subarray(0, 5).toString(), '%PDF-');
    const pdfPath = path.join(report.root, `fictitious-lopd-${clinicId}.pdf`);
    fs.writeFileSync(pdfPath, pdf.buffer, { mode: 0o600 });
    const { stdout: pdfText } = await promisify(execFile)('pdftotext', ['-layout', pdfPath, '-']);
    assert(pdfText.includes('Paciente Corregido'));
    assert(pdfText.includes('Calle corregida 99 & prueba'));
    assert(pdfText.includes('Compañía ficticia QA'));
    assert(pdfText.includes('+34000000002'));
    assert(pdfText.includes('INSTITUTO OBES ALICANTE S.L.'));
    assert(pdfText.includes('Opciones indicadas al firmar'));
    await unchangedRejection(item, () => update(item.session.public_token, corrected.id, payload(corrected)));
    await unchangedRejection(item, () => service.signPublicPackage(item.session.public_token, signPayload(corrected)));
    assert.equal(snapshotOf(await refresh(item)), frozen);
    assert.equal(snapshotOf(await db.Paciente.findByPk(item.patientId)), patientBefore);
    assert.equal(await db.PatientIntakeRequest.count({ where: { patient_id: item.patientId } }), 0);
    report.checks.push(`clinic ${clinicId}: all 12 identity fields including optional company and secondary phone prefill/edit -> same frozen LOPD; explicit choices + current-hash required; four No signed; real PDF text + first-care eligibility; immutable history; no master/intake mutation`);
  }

  const profile = require('../../services/patientPrivacyProfile.service');
  const empty = await prepare(66, { dni: null, fecha_nacimiento: null, direccion: null, codigo_postal: null,
    ciudad: null, poblacion: null, provincia: null, telefono_movil: null, telefono_secundario: null, email: null });
  const emptyBefore = snapshotOf(await db.Paciente.findByPk(empty.patientId));
  const emptyCorrected = await confirm(empty, { ...empty.doc.personal_data_form.values,
    nombre: 'Nombre declarado distinto', dni: 'QA-EMPTY-ONLY', fecha_nacimiento: '1984-02-29',
    direccion: 'Dirección aportada 21', codigo_postal: '03004', ciudad: 'Elche', provincia: 'Alicante',
    telefono: '+34000000991', telefono2: '+34000000992', email: 'empty-autofill@example.invalid' });
  assert.equal(snapshotOf(await db.Paciente.findByPk(empty.patientId)), emptyBefore, 'Typing/confirming is still document-only');
  await service.signPublicPackage(empty.session.public_token, signPayload(emptyCorrected));
  const emptyAfter = await db.Paciente.findByPk(empty.patientId);
  assert.equal(emptyAfter.nombre, 'Paciente', 'A non-empty master value is never overwritten by signing');
  assert.equal(emptyAfter.dni, 'QA-EMPTY-ONLY'); assert.equal(emptyAfter.fecha_nacimiento, '1984-02-29');
  assert.equal(emptyAfter.direccion, 'Dirección aportada 21'); assert.equal(emptyAfter.poblacion, 'Elche');
  assert.equal(emptyAfter.email, 'empty-autofill@example.invalid'); assert.equal(emptyAfter.telefono_movil, '34000000991');
  const emptyFrozen = snapshotOf(await refresh(empty));
  const autoEvents = await db.PatientOperationalEvent.count({ where: { patient_id: empty.patientId, event_type: 'patient.privacy_profile_autofilled' } });
  assert.equal(autoEvents, 1);
  assert.equal((await profile.autofillEmptyFromDocument({ db, documentId: empty.doc.id })).applied, false);
  assert.equal(await db.PatientOperationalEvent.count({ where: { patient_id: empty.patientId, event_type: 'patient.privacy_profile_autofilled' } }), autoEvents);
  let review = await profile.view({ db, patientId: empty.patientId, clinicId: empty.clinicId });
  assert.deepEqual(review.fields.map(field => field.key), ['nombre']);
  await sql.transaction(async transaction => profile.apply({ db, patientId: empty.patientId, clinicId: empty.clinicId,
    actorId: 1, authorizedPrimaryClinicId: empty.clinicId, transaction, payload: { clinic_id: empty.clinicId,
      document_id: review.document.id, snapshot_hash: review.document.snapshot_hash, patient_version: review.patient_version, fields: ['nombre'] } }));
  assert.equal((await db.Paciente.findByPk(empty.patientId)).nombre, 'Nombre declarado distinto');
  assert.equal(snapshotOf(await refresh(empty)), emptyFrozen);
  report.checks.push('signing atomically fills empty identity and contacts only; conflicts remain per-field; explicit single-field CAS updates preserve signed document; replay has zero writes');

  const phoneChange = await prepare(72, { telefono_movil: '+34000000993' });
  const phoneCorrected = await confirm(phoneChange, { ...phoneChange.doc.personal_data_form.values, telefono: '+34000000994' });
  await service.signPublicPackage(phoneChange.session.public_token, signPayload(phoneCorrected));
  assert.equal((await db.Paciente.findByPk(phoneChange.patientId)).telefono_movil, '+34000000993');
  review = await profile.view({ db, patientId: phoneChange.patientId, clinicId: phoneChange.clinicId });
  await sql.transaction(transaction => profile.apply({ db, patientId: phoneChange.patientId, clinicId: phoneChange.clinicId,
    actorId: 1, authorizedPrimaryClinicId: phoneChange.clinicId, transaction, payload: { clinic_id: phoneChange.clinicId,
      document_id: review.document.id, snapshot_hash: review.document.snapshot_hash, patient_version: review.patient_version,
      fields: ['telefono_movil'], acknowledge_contact_changes: true } }));
  const verificationEvents = await db.PatientOperationalEvent.findAll({ where: {
    patient_id: phoneChange.patientId, event_type: 'patient.mobile_verification_requested' } });
  assert.equal(verificationEvents.length, 1);
  assert.equal(verificationEvents[0].metadata.phone, '34000000994');
  assert.equal(verificationEvents[0].metadata.delivery_enabled, false);
  assert.equal(verificationEvents[0].metadata.state, 'pending');
  report.checks.push('explicit mobile overwrite creates one durable pending verification handoff with delivery disabled; no appointment or marketing authorization is changed');

  const collisionEmpty = await prepare(66, { email: null, direccion: null });
  const collisionCorrected = await confirm(collisionEmpty, { ...collisionEmpty.doc.personal_data_form.values,
    email: 'qa-1001@example.invalid', direccion: 'Dirección sin colisión 7' });
  await service.signPublicPackage(collisionEmpty.session.public_token, signPayload(collisionCorrected));
  const collisionMaster = await db.Paciente.findByPk(collisionEmpty.patientId);
  assert.equal(collisionMaster.email, null); assert.equal(collisionMaster.direccion, 'Dirección sin colisión 7');
  const collisionAudit = await db.PatientOperationalEvent.findOne({ where: {
    patient_id: collisionEmpty.patientId, event_type: 'patient.privacy_profile_autofilled' } });
  assert.deepEqual(collisionAudit.metadata.skipped_fields, [{ key: 'email', reason: 'privacy_profile_contact_collision' }]);
  report.checks.push('contact collision never steals another identity or prevents signing; safe empty fields fill and skipped conflict is auditable');

  const autoRollback = await prepare(72, { direccion: null });
  const autoRollbackConfirmed = await confirm(autoRollback, { ...autoRollback.doc.personal_data_form.values, direccion: 'No debe quedar guardada' });
  const autoRollbackDoc = snapshotOf(await refresh(autoRollback));
  const autoRollbackPatient = snapshotOf(await db.Paciente.findByPk(autoRollback.patientId));
  db.PatientOperationalEvent.addHook('beforeCreate', 'qa-autofill-rollback', row => {
    if (row.patient_id === autoRollback.patientId && row.event_type === 'patient.privacy_profile_autofilled') {
      throw Error('OWNED_AUTOFILL_AUDIT_FAILURE');
    }
  });
  await assert.rejects(service.signPublicPackage(autoRollback.session.public_token, signPayload(autoRollbackConfirmed)), /OWNED_AUTOFILL_AUDIT_FAILURE/);
  db.PatientOperationalEvent.removeHook('beforeCreate', 'qa-autofill-rollback');
  assert.equal(snapshotOf(await refresh(autoRollback)), autoRollbackDoc);
  assert.equal(snapshotOf(await db.Paciente.findByPk(autoRollback.patientId)), autoRollbackPatient);
  assert.equal((await db.ConsentSignaturePackage.findByPk(autoRollback.prepared.package_id)).signed_count, 0);
  await service.signPublicPackage(autoRollback.session.public_token, signPayload(autoRollbackConfirmed));
  assert.equal((await db.Paciente.findByPk(autoRollback.patientId)).direccion, 'No debe quedar guardada');
  report.checks.push('autofill audit failure rolls back both master data and signature/package counts; retry succeeds atomically');

  const backfill = require('../patient-privacy-empty-fields-backfill');
  // Simulate a valid already-signed pre-rollout document whose master address
  // was not transferred by the previous document-only implementation.
  await db.Paciente.update({ direccion: null }, { where: { id_paciente: autoRollback.patientId } });
  const backfillPlan = await backfill.buildPlan({ db, clinicIds: [66, 72] });
  assert(backfillPlan.entries.some(entry => entry.patient_id === autoRollback.patientId && entry.fields.includes('direccion')));
  const beforeBackfillDoc = snapshotOf(await refresh(autoRollback));
  const beforeBackfillEvents = await db.PatientOperationalEvent.count();
  const rehearsal = await backfill.applyPlan({ db, plan: backfillPlan, dryRun: true });
  assert(rehearsal.applied_patients >= 1);
  assert.equal((await db.Paciente.findByPk(autoRollback.patientId)).direccion, null);
  assert.equal(await db.PatientOperationalEvent.count(), beforeBackfillEvents);
  let backupCalled = false;
  const backfilled = await backfill.applyPlan({ db, plan: backfillPlan, dryRun: false, backup: value => {
    backupCalled = true; assert(value.before.some(row => row.patient.id_paciente === autoRollback.patientId));
  } });
  assert(backupCalled); assert(backfilled.applied_patients >= 1);
  assert.equal((await db.Paciente.findByPk(autoRollback.patientId)).direccion, 'No debe quedar guardada');
  assert.equal(snapshotOf(await refresh(autoRollback)), beforeBackfillDoc);
  const afterBackfillEvents = await db.PatientOperationalEvent.count();
  const replayBackfill = await backfill.applyPlan({ db, plan: backfillPlan, dryRun: false });
  assert.equal(replayBackfill.applied_patients, 0);
  assert.equal(await db.PatientOperationalEvent.count(), afterBackfillEvents);
  report.checks.push('bounded historical empty-field plan is privately backed up, SQL-rehearsed with rollback, applied without touching signatures, and replayed with zero writes');

  const invalid = await prepare();
  const base = payload(invalid.doc);
  for (const changed of [
    { ...base, schema_version: 'forged' }, { ...base, snapshot_hash: '0'.repeat(64) },
    { ...base, values: { ...base.values, nombre: '' } }, { ...base, values: { ...base.values, apellidos: '   ' } },
    { ...base, values: { ...base.values, email: 'not an email' } },
    { ...base, values: { ...base.values, fecha_nacimiento: '2026-02-30' } },
    { ...base, values: { ...base.values, fecha_nacimiento: '2999-01-01' } },
    { ...base, values: { ...base.values, nombre: { toString: 'forged' } } },
    { ...base, values: { ...base.values, direccion: 'x'.repeat(2001) } },
    { ...base, values: { ...base.values, compania: 'x'.repeat(151) } },
    { ...base, values: { ...base.values, telefono2: '<script>bad()</script>' } },
    { ...base, values: { ...base.values, clinica_id: 66 } },
    { ...base, values: { ...base.values, acepta_marketing: true } },
  ]) await unchangedRejection(invalid, () => update(invalid.session.public_token, invalid.doc.id, changed));
  const hostile = { ...base.values, nombre: '<script>ficticio()</script>', direccion: '<img src=x onerror="ficticio()">' };
  const escaped = await confirm(invalid, hostile);
  assert(!/<script>|<img\b/i.test(escaped.snapshot_html));
  assert(escaped.snapshot_html.includes('&lt;script&gt;ficticio()&lt;/script&gt;'));
  assert(escaped.snapshot_html.includes('&lt;img src=x onerror=&quot;ficticio()&quot;&gt;'));
  report.checks.push('bounded strict schema rejects invalid dates/email/types/overflows/unknown keys; identity HTML escaped; all rejected writes preserve snapshot/events');

  const scopeA = await prepare(66), scopeB = await prepare(72);
  await unchangedRejection(scopeB, () => update(scopeA.session.public_token, scopeB.doc.id, payload(scopeB.doc)), [403, 404]);
  const badToken = scopeA.session.public_token.slice(0, -10) + 'tamperedxx';
  await unchangedRejection(scopeA, () => update(badToken, scopeA.doc.id, payload(scopeA.doc)), [401]);
  const jwt = require('jsonwebtoken'), claims = jwt.decode(scopeA.session.public_token);
  // Only a test-owned secret and its disposable package are used to exercise
  // expiry/type validation. Native service-issued tokens cover all valid paths.
  const expiredToken = jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 10 }, TEST_TOKEN_SECRET);
  await unchangedRejection(scopeA, () => update(expiredToken, scopeA.doc.id, payload(scopeA.doc)), [401]);
  const wrongType = jwt.sign({ ...claims, type: 'tablet_kiosk' }, TEST_TOKEN_SECRET);
  await unchangedRejection(scopeA, () => update(wrongType, scopeA.doc.id, payload(scopeA.doc)), [401]);
  for (const state of ['cancelled', 'expired']) {
    const item = await prepare();
    await db.ConsentSignaturePackage.update({ status: state }, { where: { id: item.prepared.package_id } });
    await unchangedRejection(item, () => update(item.session.public_token, item.doc.id, payload(item.doc)), [410]);
  }
  const expires = await prepare();
  await db.ConsentSignaturePackage.update({ expires_at: new Date(Date.now() - 1000) }, { where: { id: expires.prepared.package_id } });
  await unchangedRejection(expires, () => update(expires.session.public_token, expires.doc.id, payload(expires.doc)), [410]);
  const expiredDoc = await prepare();
  await db.PatientConsentDocument.update({ expires_at: new Date(Date.now() - 1000) }, { where: { id: expiredDoc.doc.id } });
  await unchangedRejection(expiredDoc, () => update(expiredDoc.session.public_token, expiredDoc.doc.id, payload(expiredDoc.doc)), [410]);
  for (const status of ['revoked', 'rejected', 'cancelled', 'superseded', 'voided']) {
    const closedDoc = await prepare();
    await db.PatientConsentDocument.update({ status, ...(status === 'revoked' ? { revoked_at: new Date() } : {}) },
      { where: { id: closedDoc.doc.id } });
    await unchangedRejection(closedDoc, () => update(closedDoc.session.public_token, closedDoc.doc.id, payload(closedDoc.doc)), [409]);
  }
  report.checks.push('token package scope, signature/type/expiry and cancelled/expired package lifecycle deny identity writes before mutation');

  const rollback = await prepare();
  db.ConsentDeliveryEvent.addHook('beforeCreate', 'qa-identity-event-rollback', row => {
    if (row.patient_consent_document_id === rollback.doc.id && row.event_payload?.event === 'document_personal_data_confirmed') {
      throw Object.assign(Error('OWNED_IDENTITY_EVENT_FAILURE'), { statusCode: 500 });
    }
  });
  await unchangedRejection(rollback, () => update(rollback.session.public_token, rollback.doc.id, payload(rollback.doc)), [500]);
  db.ConsentDeliveryEvent.removeHook('beforeCreate', 'qa-identity-event-rollback');
  const late = await prepare(), captured = deferred(), release = deferred(); let paused = false;
  db.ConsentSignaturePackage.addHook('afterFind', 'qa-identity-late-close', async (row, options) => {
    if (paused || options.transaction || Number(row?.id) !== late.prepared.package_id
      || !options.include?.some(include => include.as === 'documents')) return;
    paused = true; captured.resolve(); await release.promise;
  });
  const lateBefore = snapshotOf(await refresh(late));
  const lateWork = Promise.allSettled([update(late.session.public_token, late.doc.id, payload(late.doc))]);
  await captured.promise;
  await db.ConsentSignaturePackage.update({ status: 'cancelled' }, { where: { id: late.prepared.package_id } });
  release.resolve(); const [lateResult] = await lateWork;
  db.ConsentSignaturePackage.removeHook('afterFind', 'qa-identity-late-close');
  assert.equal(lateResult.status, 'rejected'); assert.equal(lateResult.reason.statusCode, 410);
  assert.equal(snapshotOf(await refresh(late)), lateBefore);
  assert.equal((await db.ConsentSignaturePackage.findByPk(late.prepared.package_id)).status, 'cancelled');
  report.checks.push('identity audit insertion failure rolls back frozen correction; package cancellation after initial token resolution is rechecked under lock');

  const mixed = await prepare(), mixedConfirmed = await confirm(mixed);
  const extra = await db.PatientConsentDocument.create({ public_id: `qa_identity_extra_${mixed.patientId}`,
    package_id: mixed.prepared.package_id, paciente_id: mixed.patientId, clinica_id: mixed.clinicId,
    purpose: 'clinical', title: 'Segundo documento ficticio', status: 'pending',
    snapshot_json: { context: { paciente: { nombre_completo: 'Paciente ficticio QA' } } },
    snapshot_html: '<p>Segundo documento ficticio QA</p>', snapshot_hash: 'f'.repeat(64) });
  await service.refreshPackageCounts(mixed.prepared.package_id);
  const mixedPrivacyBefore = snapshotOf(await refresh(mixed)), mixedOtherBefore = snapshotOf(await db.PatientConsentDocument.findByPk(extra.id));
  const mixedEvents = await db.ConsentDeliveryEvent.count();
  db.ConsentDeliveryEvent.addHook('beforeCreate', 'qa-identity-batch-rollback', row => {
    if (row.patient_consent_document_id === extra.id && row.event_payload?.event === 'document_signed') throw Error('OWNED_BATCH_EVENT_FAILURE');
  });
  await assert.rejects(service.signPublicPackage(mixed.session.public_token, signPayload(mixedConfirmed)), /OWNED_BATCH_EVENT_FAILURE/);
  db.ConsentDeliveryEvent.removeHook('beforeCreate', 'qa-identity-batch-rollback');
  assert.equal(snapshotOf(await refresh(mixed)), mixedPrivacyBefore);
  assert.equal(snapshotOf(await db.PatientConsentDocument.findByPk(extra.id)), mixedOtherBefore);
  assert.equal(await db.ConsentDeliveryEvent.count(), mixedEvents);
  assert.equal((await db.ConsentSignaturePackage.findByPk(mixed.prepared.package_id)).signed_count, 0);
  const mixedResult = await service.signPublicPackage(mixed.session.public_token, signPayload(mixedConfirmed));
  assert.equal(mixedResult.signed_count, 2);
  assert.equal((await db.ConsentSignaturePackage.findByPk(mixed.prepared.package_id)).signed_count, 2);
  report.checks.push('mixed additional document batch rolls back all signatures/events/counts on later failure; retry signs both atomically without medical intake');

  const withOldMedical = await prepare(66);
  const retainedIntake = await db.PatientIntakeRequest.create({ package_id: withOldMedical.prepared.package_id,
    patient_id: withOldMedical.patientId, clinic_id: 66,
    schema_version: require('../../lib/patient-intake-questionnaire').VERSION, personal_snapshot: {}, created_by: 1 });
  const retainedBefore = snapshotOf(await db.PatientIntakeRequest.findByPk(retainedIntake.id));
  const oldMedicalCorrected = await confirm(withOldMedical);
  assert.equal((await service.getPublicPackage(withOldMedical.session.public_token)).intake, null);
  await service.signPublicPackage(withOldMedical.session.public_token, signPayload(oldMedicalCorrected));
  assert.equal(snapshotOf(await db.PatientIntakeRequest.findByPk(retainedIntake.id)), retainedBefore);
  assert.equal((await assess(withOldMedical)).allowed, true);
  report.checks.push('historical pending health form stays immutable and hidden when disabled; same independent LOPD identity can be corrected and signed without it');

  const race = await prepare();
  const raceValues = race.doc.personal_data_form.values;
  const edited = await Promise.allSettled(['A', 'B'].map(suffix => update(race.session.public_token, race.doc.id,
    payload(race.doc, { ...raceValues, direccion: `Corrección simultánea ${suffix}` }))));
  assert.equal(edited.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(edited.filter(result => result.status === 'rejected' && result.reason.statusCode === 409).length, 1);
  const winner = edited.find(result => result.status === 'fulfilled').value.documents[0];
  const raceSign = await Promise.allSettled([
    service.signPublicPackage(race.session.public_token, signPayload(winner)),
    update(race.session.public_token, race.doc.id, payload(winner, { ...winner.personal_data_form.values, ciudad: 'Otro cambio simultáneo' })),
  ]);
  assert.equal(raceSign.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(raceSign.filter(result => result.status === 'rejected' && result.reason.statusCode === 409).length, 1);
  const raceFinal = await refresh(race);
  if (raceFinal.status === 'signed') assert.deepEqual(choices.signedConsentChoiceAnswers(raceFinal), noChoices().answers);
  assert.equal(raceFinal.snapshot_hash, choices.choiceSnapshotHash(raceFinal.snapshot_json, raceFinal.snapshot_html));
  report.checks.push('native InnoDB simultaneous edit/edit and sign/edit accept exactly one current snapshot; no lost correction or overwritten signature');

  const minor = await prepare(72, { fecha_nacimiento: '2020-01-01' });
  const minorAdult = await confirm(minor, { ...minor.doc.personal_data_form.values, fecha_nacimiento: '1980-01-01' });
  assert.equal((await refresh(minor)).snapshot_json.patient_flags.is_minor, true);
  await unchangedRejection(minor, () => service.signPublicPackage(minor.session.public_token, signPayload(minorAdult)), [400]);
  await service.signPublicPackage(minor.session.public_token, { ...signPayload(minorAdult), signer_role: 'representative', relationship: 'Tutor ficticio' });
  assert.equal((await assess(minor)).allowed, true);
  const adult = await prepare();
  const adultMinor = await confirm(adult, { ...adult.doc.personal_data_form.values, fecha_nacimiento: '2020-01-01' });
  assert.equal((await refresh(adult)).snapshot_json.patient_flags.is_minor, true);
  await unchangedRejection(adult, () => service.signPublicPackage(adult.session.public_token, signPayload(adultMinor)), [400]);
  report.checks.push('edited birthdate can tighten but cannot remove representative protection; representative signature accepted without medical form');

  const historical = await prepare();
  const historicalDoc = await refresh(historical), oldSnapshot = structuredClone(historicalDoc.snapshot_json);
  delete oldSnapshot.patient_identity;
  oldSnapshot.context.paciente = { ...oldSnapshot.context.paciente, nombre: 'Paciente antiguo', apellidos: 'ficticio', ...historicalPatient };
  delete oldSnapshot.context.paciente.compania;
  delete oldSnapshot.context.paciente.telefono2;
  const evidence = { ...signature, signed_at: new Date(Date.now() - 1000).toISOString(), consent_choices: noChoices() };
  oldSnapshot.signature_evidence = evidence;
  const historicalBody = privacy.buildBsPrivacyDigitalHtml(oldSnapshot.context).html;
  assert.equal(sha256(historicalBody), HISTORICAL_NINE_FIELD_HTML_SHA256);
  const oldHtml = choices.appendSignedChoiceHtml(historicalBody, historicalDoc, noChoices());
  await historicalDoc.update({ status: 'signed', signed_at: new Date(evidence.signed_at), snapshot_json: oldSnapshot,
    snapshot_html: oldHtml, snapshot_hash: choices.choiceSnapshotHash(oldSnapshot, oldHtml) });
  const historicBefore = snapshotOf(await refresh(historical));
  assert.equal((await assess(historical)).allowed, true, 'Existing canonical signatures predate editable identity and remain valid');
  await unchangedRejection(historical, () => update(historical.session.public_token, historical.doc.id, payload(historical.doc)));
  assert.equal(snapshotOf(await refresh(historical)), historicBefore);
  for (const clinicId of [66, 72]) assert.equal((await db.ClinicConsentTemplateVersion.findByPk(versions[clinicId].id)).body_html, canonical.html);
  assert.equal(await db.PatientIntakeRequest.count(), 1, 'Only the explicitly injected historical request exists; no action creates another');
  assert.equal(await db.TreatmentConsentRequirement.count(), 0);
  assert.equal(await db.Paciente.count({ where: { acepta_marketing: true } }), 0);
  const deliveries = await db.ConsentDeliveryEvent.findAll({ raw: true });
  assert(deliveries.every(event => event.channel === 'tablet'));
  report.checks.push('historical canonical signature remains valid and immutable; approved published body unchanged; no new questionnaire, marketing grant, treatment requirement or provider channel');
  report.boundaries = { real_mysql_and_services: true, real_pdf: true, real_external_sends: 0,
    production_records: 0, public_controller_browser_e2e: false };
}));
