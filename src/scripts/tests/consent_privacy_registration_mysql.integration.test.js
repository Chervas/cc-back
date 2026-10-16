'use strict';

// Explicit, disposable MySQL QA only. The fixture substitutes the model index
// before any application service loads and denies every non-owned socket.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { Sequelize, DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const choices = require('../../lib/consent-document-choices');
const { FINAL_PRIVACY_KEY, assessPrivacyBeforeStart } = require('../../services/appointmentPrivacyEligibility.service');
const sha = data => createHash('sha256').update(data).digest('hex');
const manifestPath = '/home/ubuntu/secure-imports/bs-final-consents-editable-html-20261015-v3/manifest.json';
const expectedManifestSha = 'bc367fc5b04bb61073facdf23503f5b72c27724f6b9344a6a2358bcafa916937';
const form = () => ({ schema_version: choices.CHOICE_SCHEMA_VERSION, fields: choices.CHOICE_KEYS.map(key =>
  ({ key, label: choices.CHOICE_LABELS[key], type: 'yes_no', required: true })) });
const allNo = () => ({ schema_version: choices.CHOICE_SCHEMA_VERSION,
  answers: Object.fromEntries(choices.CHOICE_KEYS.map(key => [key, 'no'])) });
const signature = { signer_name: 'Firmante ficticio QA', accepted_statement: true,
  signature_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=' };
const noPayload = id => ({ ...signature, document_choices: { [id]: allNo() } });
const frozen = row => JSON.stringify(row.toJSON());

function defineModels(sql, db) {
  db.Sequelize = Sequelize;
  // Small fictitious parent tables. Consent tables below use their production
  // factories and services; no real model index, associations or env are loaded.
  db.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true },
    grupoClinicaId: D.INTEGER, nombre_clinica: D.STRING(100), datos_fiscales_clinica: D.JSON, configuracion: D.JSON,
    direccion: D.STRING(150), codigo_postal: D.STRING(12), ciudad: D.STRING(100), provincia: D.STRING(100),
    pais: D.STRING(100), email: D.STRING(100), telefono: D.STRING(40), telefono_whatsapp: D.STRING(40),
  }, { tableName: 'Clinicas', timestamps: false });
  db.Paciente = sql.define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true },
    clinica_id: D.INTEGER, public_id: D.STRING(80), nombre: D.STRING(100), apellidos: D.STRING(100),
    dni: D.STRING(40), email: D.STRING(100), telefono_movil: D.STRING(40), fecha_nacimiento: D.DATEONLY,
    direccion: D.STRING(150), codigo_postal: D.STRING(12), ciudad: D.STRING(100), provincia: D.STRING(100),
    alergias: D.TEXT, medicacion: D.TEXT, antecedentes: D.TEXT, edad: D.INTEGER,
    acepta_marketing: { type: D.BOOLEAN, defaultValue: false },
  }, { tableName: 'Pacientes', timestamps: false });
  db.Tratamiento = sql.define('Tratamiento', { id_tratamiento: { type: D.INTEGER, primaryKey: true },
    nombre: D.STRING(100), disciplina: D.STRING(100) }, { tableName: 'Tratamientos', timestamps: false });
  db.CitaPaciente = sql.define('CitaPaciente', { id_cita: { type: D.INTEGER, primaryKey: true },
    clinica_id: D.INTEGER, paciente_id: D.INTEGER, tratamiento_id: D.INTEGER, inicio: D.DATE, fin: D.DATE,
    estado: D.STRING(40), es_provisional: { type: D.BOOLEAN, defaultValue: false }, import_metadata: D.JSON,
    arrived_at: D.DATE, arrived_by: D.INTEGER, care_started_at: D.DATE, care_started_by: D.INTEGER,
    care_completed_at: D.DATE, care_completed_by: D.INTEGER, care_schedule_start: D.DATE,
    care_legacy_attendance: { type: D.BOOLEAN, defaultValue: false }, updated_by: D.INTEGER, created_by: D.INTEGER,
  }, { tableName: 'CitasPacientes', timestamps: false });
  db.Conversation = sql.define('Conversation', { id: { type: D.INTEGER, primaryKey: true },
    clinic_id: D.INTEGER, patient_id: D.INTEGER, lead_id: D.INTEGER, channel: D.STRING(20),
  }, { tableName: 'Conversations', timestamps: false });
  for (const name of ['ClinicConsentTemplate', 'ClinicConsentTemplateVersion', 'ConsentTemplateCatalogVersion', 'ConsentSignaturePackage',
    'PatientConsentDocument', 'ConsentDeliveryEvent', 'PatientIntakeRequest', 'PatientCustomField',
    'PacienteClinica', 'AppointmentCareEvent', 'PatientOperationalEvent', 'PatientConsentExternalAttestation', 'TreatmentConsentRequirement']) {
    db[name] = require(`../../../models/${name.toLowerCase()}`)(sql, D);
  }
  // Production creates these through explicit migrations. Its implicit sync
  // name exceeds MySQL's identifier limit, so give only the QA index a name.
  db.PatientOperationalEvent.options.indexes.forEach((index, i) => { index.name = `qa_patient_event_${i}`; });
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

test('actual LOPD + intake + care services, 44 final bodies, two BS clinics, isolated MySQL', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 180000,
}, async () => withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  const manifestBytes = fs.readFileSync(manifestPath);
  assert.equal(sha(manifestBytes), expectedManifestSha, 'Reviewed final-v3 manifest changed');
  const manifest = JSON.parse(manifestBytes);
  assert.equal(manifest.documents.length, 44);
  report.manifest_sha256 = expectedManifestSha;
  defineModels(sql, db);
  await sql.sync(); // The fixture has proved this is its newly-created, empty DB.
  const migration = require('../../../migrations/20261015100000-expand-consent-html-mediumtext');
  const columns = [['ClinicConsentTemplateVersions', 'body_html'], ['ConsentTemplateCatalogVersions', 'body_html'],
    ['PatientConsentDocuments', 'snapshot_html']];
  for (const [table, column] of columns) await sql.query(`ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` TEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NULL`);
  await db.ClinicConsentTemplateVersion.create({ clinic_template_id: 999, title: 'QA migration', body_html: '<p>Texto clínico: áéíóú ✓</p>' });
  await db.ConsentTemplateCatalogVersion.create({ catalog_id: 999, title: 'QA migration', body_html: '<p>Catálogo intacto</p>' });
  await db.PatientConsentDocument.create({ public_id: 'qa_migration_signed', paciente_id: 999, clinica_id: 88,
    title: 'QA migration', status: 'signed', signed_at: new Date('2026-01-01T12:00:00Z'), snapshot_html: '<p>Firma histórica intacta</p>',
    snapshot_json: { signature_evidence: { historical: true } }, snapshot_hash: 'qa-historical-hash' });
  const capacityHash = async () => sha(JSON.stringify(await Promise.all(columns.map(async ([table]) => {
    const [rows] = await sql.query(`SELECT * FROM \`${table}\` ORDER BY id`); return rows;
  }))));
  const initialHash = await capacityHash();
  await migration.up(sql.getQueryInterface());
  assert.equal(await capacityHash(), initialHash);
  await migration.up(sql.getQueryInterface());
  assert.equal(await capacityHash(), initialHash);
  await migration.down(sql.getQueryInterface());
  assert.equal(await capacityHash(), initialHash);
  await migration.up(sql.getQueryInterface());
  assert.equal(await capacityHash(), initialHash);
  report.checks.push('actual schema migration up, replay, safe down/up preserve all row hashes including signed snapshot');
  const service = require('../../services/consentimientos.service');
  const intake = require('../../services/patientIntake.service');
  const care = require('../../services/appointmentCare.service');
  await db.Clinica.bulkCreate([
    { id_clinica: 66, grupoClinicaId: 9, nombre_clinica: 'Clínica ficticia 66' },
    { id_clinica: 72, grupoClinicaId: 9, nombre_clinica: 'Clínica ficticia 72' },
    { id_clinica: 88, grupoClinicaId: 10, nombre_clinica: 'Otro grupo ficticio' },
  ]);
  const privacyTemplates = {};
  for (const clinicId of [66, 72]) for (const source of manifest.documents) {
    const bytes = fs.readFileSync(source.body_html.path);
    assert.equal(bytes.length, source.body_html.bytes);
    assert.equal(sha(bytes), source.body_html.sha256);
    const isPrivacy = source.catalog_key === FINAL_PRIVACY_KEY;
    const template = await db.ClinicConsentTemplate.create({ public_id: `qa_${clinicId}_${source.source_sha256}`,
      clinic_id: clinicId, catalog_key: source.catalog_key, name: source.source_name,
      purpose: isPrivacy ? 'data_protection' : 'clinical', status: 'active',
      is_default: isPrivacy, blocking_policy: isPrivacy ? 'hard' : 'optional', validity_mode: 'manual' });
    const version = await db.ClinicConsentTemplateVersion.create({ clinic_template_id: template.id, version: 1,
      locale: 'es', title: source.source_name, status: 'published', body_html: bytes.toString('utf8'),
      body_json: isPrivacy ? { consent_form: form() } : { source_sha256: source.source_sha256 },
      variable_schema: isPrivacy ? { consent_form: form() } : null });
    const persisted = await db.ClinicConsentTemplateVersion.findByPk(version.id);
    assert.equal(sha(Buffer.from(persisted.body_html)), source.body_html.sha256, 'HTML must not truncate at TEXT size');
    if (isPrivacy) privacyTemplates[clinicId] = { template, version };
  }
  assert.equal(await db.ClinicConsentTemplate.count(), 88);
  assert.equal(await db.TreatmentConsentRequirement.count(), 0, 'Library import never creates treatment associations');
  const fullHash = await capacityHash();
  await assert.rejects(migration.down(sql.getQueryInterface()), /CONSENT_HTML_DOWNGRADE_WOULD_TRUNCATE/);
  assert.equal(await capacityHash(), fullHash);
  const [types] = await sql.query(`SELECT COLUMN_TYPE FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE()
    AND ((TABLE_NAME IN ('ClinicConsentTemplateVersions','ConsentTemplateCatalogVersions') AND COLUMN_NAME='body_html')
      OR (TABLE_NAME='PatientConsentDocuments' AND COLUMN_NAME='snapshot_html'))`);
  assert.equal(types.length, 3); assert(types.every(row => row.COLUMN_TYPE === 'mediumtext'));
  report.checks.push('real migration down refuses >64KB before any DDL or content change');
  report.checks.push('44 final text bodies x2 clinics round-trip exact hashes, including >64KB; no treatment requirements');

  const patient = async (id, clinicId = 72, patch = {}) => db.Paciente.create({ id_paciente: id, clinica_id: clinicId,
    public_id: `qa_patient_${id}`, nombre: 'Paciente ficticio', apellidos: `Prueba ${id}`,
    dni: 'QA-NOT-A-REAL-ID', fecha_nacimiento: '1980-01-01', acepta_marketing: false, ...patch });
  const appointment = async (id, patientId, clinicId = 72, patch = {}) => {
    const start = new Date(Date.now() - 3600000);
    return db.CitaPaciente.create({ id_cita: id, paciente_id: patientId, clinica_id: clinicId,
      estado: 'ha_acudido', inicio: start, fin: new Date(start.getTime() + 1800000),
      arrived_at: start, arrived_by: 1, care_schedule_start: start, ...patch });
  };
  const assess = a => sql.transaction(transaction => assessPrivacyBeforeStart({ db, appointment: a, transaction }));
  const signAndVerify = async (doc, mode, token = null, extra = {}) => {
    const original = frozen(await db.PatientConsentDocument.findByPk(doc.id));
    const writesBefore = await db.ConsentDeliveryEvent.count();
    const run = payload => mode === 'public' ? service.signPublicPackage(token, payload) : service.signConsentDocument(String(doc.id), payload);
    for (const payload of [{ ...signature }, { ...noPayload(doc.id), accepted_statement: false },
      { ...noPayload(doc.id), document_choices: { [doc.id]: { ...allNo(), schema_version: 'forged' } } },
      { ...noPayload(doc.id), document_choices: { [doc.id]: allNo(), 999999: allNo() } }]) {
      await assert.rejects(run(payload));
      assert.equal(frozen(await db.PatientConsentDocument.findByPk(doc.id)), original);
      assert.equal(await db.ConsentDeliveryEvent.count(), writesBefore);
    }
    await run({ ...noPayload(doc.id), ...extra });
    const signed = await db.PatientConsentDocument.findByPk(doc.id);
    assert.equal(signed.status, 'signed');
    assert.deepEqual(choices.signedConsentChoiceAnswers(signed), allNo().answers);
    assert.equal((signed.snapshot_html.match(/☐ Sí · ☑ No/g) || []).length, 4);
    assert.equal(signed.snapshot_json.integrity.algorithm, choices.CHOICE_HASH_ALGORITHM);
    assert.equal(signed.snapshot_hash, choices.choiceSnapshotHash(signed.snapshot_json, signed.snapshot_html));
    const print = await service.renderConsentDocument(String(doc.id));
    assert(print.includes(signed.snapshot_html));
    assert.equal((print.match(/☐ Sí · ☑ No/g) || []).length, 4);
    const beforeReplay = frozen(signed);
    await assert.rejects(run(noPayload(doc.id)));
    assert.equal(frozen(await db.PatientConsentDocument.findByPk(doc.id)), beforeReplay);
    assert.equal((await db.Paciente.findByPk(signed.paciente_id)).acepta_marketing, false);
    return signed;
  };

  for (const clinicId of [66, 72]) {
    await patient(clinicId, clinicId);
    const a = await appointment(clinicId, clinicId, clinicId);
    const before = frozen(await db.CitaPaciente.findByPk(a.id_cita));
    await assert.rejects(care.record({ appointmentId: a.id_cita, clinicId, actorId: 1, action: 'start' }),
      { code: 'appointment_consent_privacy_required' });
    assert.equal(frozen(await db.CitaPaciente.findByPk(a.id_cita)), before);
    assert.equal(await db.AppointmentCareEvent.count(), clinicId === 66 ? 0 : 1);
    const prepared = await service.createPatientIntakePackage(clinicId, { clinicId, createdBy: 1 });
    const reused = await service.createPatientIntakePackage(clinicId, { clinicId, createdBy: 1 });
    assert.equal(reused.package_id, null);
    assert.deepEqual(reused.current_package_ids, [prepared.package_id]);
    const session = await service.createTabletSession(prepared.package_id);
    const view = await service.getPublicPackage(session.public_token);
    assert.equal(view.documents.length, 1);
    assert.equal(view.documents[0].choice_form.schema_version, choices.CHOICE_SCHEMA_VERSION);
    assert.equal(view.documents[0].choice_answers, null);
    const doc = await db.PatientConsentDocument.findOne({ where: { package_id: prepared.package_id } });
    assert.equal(doc.snapshot_hash, choices.choiceSnapshotHash(doc.snapshot_json, doc.snapshot_html), 'unsigned hash survives native MySQL JSON storage too');
    await signAndVerify(doc, clinicId === 66 ? 'direct' : 'public', session.public_token);
    assert.equal((await assess(a)).allowed, true);
    const started = await care.record({ appointmentId: a.id_cita, clinicId, actorId: 1, action: 'start' });
    assert.equal(started.appointment.estado, 'en_atencion');
    const replay = await care.record({ appointmentId: a.id_cita, clinicId, actorId: 1, action: 'start' });
    assert.equal(replay.replayed, true);
    report.checks.push(`clinic ${clinicId}: first care blocked without changes; tablet/public + ${clinicId === 66 ? 'direct' : 'public'} signature four No; real start and idempotent replay`);
  }

  await patient(500, 66);
  await db.PacienteClinica.create({ paciente_id: 500, clinica_id: 72 });
  await assert.rejects(service.createPatientIntakePackage(500, { clinicId: 72, createdBy: 1 }), { message: 'patient_clinic_changed' });
  const linked = await service.createPatientIntakePackage(500, { clinicId: 72, createdBy: 1, allowLinkedClinic: true });
  assert.equal((await db.ConsentSignaturePackage.findByPk(linked.package_id)).clinica_id, 72);
  await db.PacienteClinica.create({ paciente_id: 500, clinica_id: 88 });
  await assert.rejects(service.createPatientIntakePackage(500, { clinicId: 88, createdBy: 1, allowLinkedClinic: true }), { message: 'patient_clinic_changed' });
  report.checks.push('shared patient: primary API cannot cross clinic, explicit actual same-group membership allows, another group denied');

  await patient(501);
  const importedAppointment = await appointment(501, 501);
  await db.PatientCustomField.create({ paciente_id: 501, clinica_id: 66, source: 'cliniccloud',
    source_column: 'idContacto', field_key: 'cliniccloud_source_contact_id:1075', value: '1075' });
  assert.equal((await assess(importedAppointment)).reason, 'existing_imported_patient');
  await patient(502);
  const prior = await appointment(502, 502, 72, { care_started_at: new Date(Date.now() - 1000), estado: 'en_atencion' });
  const returning = await appointment(503, 502);
  assert.equal((await assess(returning)).reason, 'existing_clinical_patient');
  assert.equal((await assess({ ...returning.toJSON(), clinica_id: 88 })).reason, 'outside_registration_scope');
  report.checks.push('suffixed imported marker and prior real care remain exempt; unrelated clinics unchanged');

  await patient(504);
  const legacyTemplate = await db.ClinicConsentTemplate.create({ public_id: 'qa_old_privacy', clinic_id: 72,
    catalog_key: 'qa_old_privacy', name: 'Modelo antiguo ficticio', purpose: 'data_protection',
    status: 'archived', is_default: false });
  const legacyVersion = await db.ClinicConsentTemplateVersion.create({ clinic_template_id: legacyTemplate.id,
    title: 'Modelo anterior ficticio', body_html: '<p>Anterior conservado</p>', status: 'published' });
  const oldPackage = await db.ConsentSignaturePackage.create({ public_id: 'qa_old_package', paciente_id: 504,
    clinica_id: 72, trigger_source: 'patient_intake', expires_at: new Date(Date.now() + 86400000) });
  const oldDocument = await db.PatientConsentDocument.create({ public_id: 'qa_old_document', package_id: oldPackage.id,
    paciente_id: 504, clinica_id: 72, clinic_template_id: legacyTemplate.id, clinic_template_version_id: legacyVersion.id,
    purpose: 'data_protection', title: 'Anterior', snapshot_html: '<p>Anterior conservado</p>' });
  const oldIntake = await db.PatientIntakeRequest.create({ package_id: oldPackage.id, patient_id: 504, clinic_id: 72,
    schema_version: require('../../lib/patient-intake-questionnaire').VERSION, personal_snapshot: {}, created_by: 1 });
  const oldBefore = frozen(await db.PatientConsentDocument.findByPk(oldDocument.id));
  const registration = await intake.prepare({ patientId: 504, clinicId: 72, actorId: 1 });
  assert.notEqual(registration.package_id, oldPackage.id);
  assert.equal((await intake.prepare({ patientId: 504, clinicId: 72, actorId: 1 })).package_id, registration.package_id);
  assert.equal(frozen(await db.PatientConsentDocument.findByPk(oldDocument.id)), oldBefore);
  assert.equal((await db.PatientIntakeRequest.findByPk(oldIntake.id)).status, 'pending');
  const regPackage = await db.ConsentSignaturePackage.findByPk(registration.package_id);
  const q = require('../../lib/patient-intake-questionnaire');
  await intake.submit(regPackage, { schema_version: q.VERSION, reviewed_answers: true, expected_version: 1,
    personal: q.personalSnapshot(await db.Paciente.findByPk(504)), answers: {} });
  // Medical preparation and privacy are independent actions. Completing the
  // former must not implicitly create/sign/send the latter.
  assert.equal(await db.PatientConsentDocument.count({ where: { package_id: regPackage.id } }), 0);
  const regPrivacy = await service.createPatientIntakePackage(504, { clinicId: 72, createdBy: 1, privacyOnly: true });
  const regDocument = await db.PatientConsentDocument.findOne({ where: { package_id: regPrivacy.package_id } });
  const regSession = await service.createTabletSession(regPrivacy.package_id);
  await signAndVerify(regDocument, 'public', regSession.public_token);
  report.checks.push('registration old pending package is not reused after replacement; current reuse stable; health submission + four No signed, old history unchanged');

  await patient(505, 72, { fecha_nacimiento: '2020-01-01' });
  const minorPackage = await service.createPatientIntakePackage(505, { clinicId: 72, createdBy: 1 });
  const minorDocument = await db.PatientConsentDocument.findOne({ where: { package_id: minorPackage.package_id } });
  assert.equal(minorDocument.snapshot_json.patient_flags.is_minor, true);
  await assert.rejects(service.signConsentDocument(String(minorDocument.id), noPayload(minorDocument.id)), { message: 'representative_signature_required' });
  await signAndVerify(minorDocument, 'direct', null, { signer_role: 'representative', relationship: 'Tutor ficticio' });
  report.checks.push('minor representative required with relationship; independent four No preserved');

  await patient(506);
  const invalidPackage = await service.createPatientIntakePackage(506, { clinicId: 72, createdBy: 1 });
  const invalid = await db.PatientConsentDocument.findOne({ where: { package_id: invalidPackage.package_id } });
  await invalid.update({ status: 'signed', signed_at: new Date(Date.now() - 1000) });
  const badBefore = frozen(await db.PatientConsentDocument.findByPk(invalid.id));
  assert.equal((await assess(await appointment(506, 506))).allowed, false);
  const repaired = await service.createPatientIntakePackage(506, { clinicId: 72, createdBy: 1 });
  assert.equal(repaired.created_count, 1, 'Invalid signed evidence must not strand registration without a new signable document');
  assert.equal(frozen(await db.PatientConsentDocument.findByPk(invalid.id)), badBefore, 'Do not mutate old signature evidence during repair');
  report.checks.push('signed current-version record lacking four-answer evidence is preserved and replaced with a new signable pending document');
  await patient(507);
  const malformedPackage = await service.createPatientIntakePackage(507, { clinicId: 72, createdBy: 1 });
  const malformed = await db.PatientConsentDocument.findOne({ where: { package_id: malformedPackage.package_id } });
  await malformed.update({ snapshot_json: { ...malformed.snapshot_json, integrity: { algorithm: 'unknown/v2' } } });
  const malformedBefore = frozen(await db.PatientConsentDocument.findByPk(malformed.id));
  await assert.rejects(service.signConsentDocument(String(malformed.id), noPayload(malformed.id)), { code: 'consent_document_choice_schema_invalid' });
  assert.equal(frozen(await db.PatientConsentDocument.findByPk(malformed.id)), malformedBefore);
  report.checks.push('unknown integrity algorithm fails closed before any signature write; unsigned and signed canonical hashes round-trip MySQL JSON');
  await patient(508);
  const countsBeforeRollback = [await db.ConsentSignaturePackage.count(), await db.PatientConsentDocument.count()];
  await assert.rejects(sql.transaction(async transaction => {
    await service.createPatientIntakePackage(508, { clinicId: 72, createdBy: 1, transaction });
    throw Error('qa_parent_rollback');
  }), /qa_parent_rollback/);
  assert.deepEqual([await db.ConsentSignaturePackage.count(), await db.PatientConsentDocument.count()], countsBeforeRollback);
  await patient(509);
  const concurrent = await Promise.all([1, 2].map(() => service.createPatientIntakePackage(509, { clinicId: 72, createdBy: 1 })));
  assert.equal(concurrent.reduce((sum, result) => sum + result.created_count, 0), 1);
  assert.equal(await db.PatientConsentDocument.count({ where: { paciente_id: 509 } }), 1);
  report.checks.push('server-owned external transaction rollback leaves no orphan package; simultaneous preparations create one document');
  const deliveries = await db.ConsentDeliveryEvent.findAll({ attributes: ['channel', 'status'], raw: true });
  assert(deliveries.every(event => event.channel === 'tablet'), 'No email, WhatsApp, review or marketing delivery');
  assert.equal(await db.TreatmentConsentRequirement.count(), 0);
  report.checks.push('all events are tablet-local; no provider, marketing flags or treatment associations written');
}));
