'use strict';
// Own mysqld + Unix socket only; the production model index and every external
// connection are denied by the fixture before any service can load.
const test = require('node:test'), assert = require('node:assert/strict');
const { Sequelize, DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const privacy = require('../../services/appointmentPrivacyEligibility.service');
const status = require('../../services/patientPrivacyStatus.service');
const paper = require('../../lib/registration-privacy-paper');
const digital = require('../../lib/bs-privacy-digital-template');
const choices = require('../../lib/consent-document-choices');

test('native MySQL privacy projection, paper without appointment, scope and batched agenda metadata', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 180000,
}, async () => withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  db.Sequelize = Sequelize;
  db.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true }, grupoClinicaId: D.INTEGER,
    nombre_clinica: D.STRING(100), configuracion: D.JSON }, { tableName: 'Clinicas', timestamps: false });
  db.Paciente = sql.define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true }, clinica_id: D.INTEGER,
    public_id: D.STRING(80), nombre: D.STRING(100), apellidos: D.STRING(100) }, { tableName: 'Pacientes', timestamps: false });
  db.CitaPaciente = sql.define('CitaPaciente', { id_cita: { type: D.INTEGER, primaryKey: true }, paciente_id: D.INTEGER,
    clinica_id: D.INTEGER, tratamiento_id: D.INTEGER, care_started_at: D.DATE, care_legacy_attendance: D.BOOLEAN },
  { tableName: 'CitasPacientes', timestamps: false });
  for (const name of ['ClinicConsentTemplate', 'ClinicConsentTemplateVersion', 'PatientCustomField', 'PacienteClinica',
    'ConsentSignaturePackage', 'PatientConsentDocument', 'ConsentDeliveryEvent', 'PatientConsentExternalAttestation', 'PatientOperationalEvent', 'PatientIntakeRequest']) {
    db[name] = require(`../../../models/${name.toLowerCase()}`)(sql, D);
  }
  db.PatientOperationalEvent.options.indexes.forEach((index, i) => { index.name = `qa_privacy_status_${i}`; });
  await sql.sync();
  await db.Clinica.bulkCreate([{ id_clinica: 66, grupoClinicaId: 9, nombre_clinica: 'Clínica QA 66' },
    { id_clinica: 72, grupoClinicaId: 9, nombre_clinica: 'Clínica QA 72' },
    { id_clinica: 88, grupoClinicaId: 10, nombre_clinica: 'Otro grupo QA' }]);
  await db.Paciente.bulkCreate([{ id_paciente: 2, clinica_id: 72, public_id: 'pac_privacy_qa_2', nombre: 'Paciente ficticio' },
    { id_paciente: 3, clinica_id: 66, public_id: 'pac_privacy_qa_3', nombre: 'Importado ficticio' }]);
  await db.PacienteClinica.create({ paciente_id: 3, clinica_id: 72 });
  const built = digital.buildBsPrivacyDigitalHtml(), versions = {};
  for (const clinicId of [66, 72]) {
    const template = await db.ClinicConsentTemplate.create({ public_id: `qa_privacy_status_${clinicId}`, clinic_id: clinicId,
      catalog_key: privacy.FINAL_PRIVACY_KEY, name: 'LOPD QA', purpose: 'data_protection', status: 'active',
      is_default: true, blocking_policy: 'hard', validity_mode: 'manual' });
    const version = await db.ClinicConsentTemplateVersion.create({ clinic_template_id: template.id, version: 2,
      locale: 'es', status: 'published', title: 'Protección de datos', body_html: built.html,
      body_json: { consent_form: built.consent_form, digital_presentation: built.metadata },
      variable_schema: { consent_form: built.consent_form } });
    versions[clinicId] = { template: template.toJSON(), version: version.toJSON() };
  }
  await db.CitaPaciente.bulkCreate([{ id_cita: 11, paciente_id: 2, clinica_id: 72 }, { id_cita: 12, paciente_id: 2, clinica_id: 72 },
    { id_cita: 13, paciente_id: 3, clinica_id: 66 }]);
  const state = (patientId = 2, clinicId = 72, appointmentId = 11) => sql.transaction({ readOnly: true, isolationLevel: 'REPEATABLE READ' },
    transaction => status.getPatientPrivacyStatus({ db, patientId, clinicId, appointmentId, transaction }));
  const counts = async () => Promise.all(Object.values(db).filter(model => typeof model.count === 'function').map(model => model.count()));
  const before = await counts(), empty = await state();
  assert.equal(empty.state, 'not_requested'); assert.equal(empty.required, true); assert.equal(empty.allowed, false);
  await state(); await state(); assert.deepEqual(await counts(), before, 'GET is completely non-mutating');
  await db.PatientCustomField.create({ paciente_id: 3, clinica_id: 66, source: 'cliniccloud', source_column: 'idContacto', field_key: 'qa_source', value: '1075' });
  const imported = await state(3, 66, 13); assert.equal(imported.required, false); assert.equal(imported.attention_required, false);
  await sql.transaction(async transaction => {
    assert.equal((await status.patientForPrivacyClinic({ db, identifier: 'pac_privacy_qa_3', clinicId: 72, transaction })).id_paciente, 3);
    await assert.rejects(status.patientForPrivacyClinic({ db, identifier: 'pac_privacy_qa_3', clinicId: 88, transaction }), { statusCode: 403 });
  });
  const { template, version } = versions[72];
  const pkg = await db.ConsentSignaturePackage.create({ public_id: 'cpkg_privacy_qa', paciente_id: 2, clinica_id: 72,
    status: 'pending', expires_at: new Date(Date.now() + 86400000) });
  const doc = await db.PatientConsentDocument.create({ public_id: 'cdoc_privacy_qa', paciente_id: 2, clinica_id: 72,
    package_id: pkg.id, clinic_template_id: template.id, clinic_template_version_id: version.id,
    title: 'Protección de datos', purpose: 'data_protection', status: 'pending',
    snapshot_json: { template, version: { id: version.id, body_json: version.body_json } }, snapshot_html: built.html });
  assert.equal((await state()).state, 'pending');
  await db.ConsentDeliveryEvent.create({ package_id: pkg.id, patient_consent_document_id: doc.id, channel: 'tablet', status: 'queued' });
  assert.equal((await state()).state, 'sent');
  await doc.update({ status: 'viewed' }); assert.equal((await state()).state, 'viewed');
  await pkg.update({ status: 'cancelled' }); assert.equal((await state()).state, 'not_requested');
  await pkg.update({ status: 'pending' });
  const record = () => sql.transaction(transaction => paper.recordPatientRegistrationPrivacyPaper({ db, patientId: 2, clinicId: 72,
    actorId: 7, acknowledged: true, transaction }));
  const nativeCreate = db.PatientOperationalEvent.create;
  db.PatientOperationalEvent.create = function(values, options) {
    if (values.event_type === 'registration_privacy.pending_superseded') throw Error('OWNED injected retirement audit failure');
    return nativeCreate.call(this, values, options);
  };
  await assert.rejects(record(), /OWNED injected retirement audit failure/);
  db.PatientOperationalEvent.create = nativeCreate;
  assert.equal(await db.PatientConsentExternalAttestation.count(), 0, 'Paper and retirement both roll back on audit failure');
  assert.equal((await db.PatientConsentDocument.findByPk(doc.id)).status, 'viewed');
  assert.equal(await db.PatientOperationalEvent.count(), 0);
  const [one, two] = await Promise.all([record(), record()]);
  assert.equal(Number(one.created) + Number(two.created), 1); assert.equal(await db.PatientConsentExternalAttestation.count(), 1);
  const receipt = (await db.PatientOperationalEvent.findOne()).toJSON(); assert.equal(receipt.metadata.appointment_id, null);
  const onPaper = await state(); assert.equal(onPaper.state, 'paper'); assert.equal(onPaper.document_id, null); assert.equal(onPaper.allowed, true);
  assert.equal((await db.PatientConsentDocument.findByPk(doc.id)).status, 'superseded');
  assert.equal((await db.ConsentSignaturePackage.findByPk(pkg.id)).status, 'draft');
  const careAssessment = await sql.transaction(transaction => privacy.assessPrivacyBeforeStart({ db,
    appointment: { id_cita: 11, paciente_id: 2, clinica_id: 72 }, transaction }));
  assert.equal(careAssessment.reason, 'privacy_received_on_paper');
  const frozen = doc.toJSON(), signedAt = new Date(Date.now() - 1000).toISOString();
  frozen.snapshot_json.integrity = { algorithm: choices.CHOICE_HASH_ALGORITHM };
  frozen.snapshot_json.signature_evidence = { accepted_statement: true, signed_at: signedAt,
    consent_choices: { schema_version: choices.CHOICE_SCHEMA_VERSION, answers: Object.fromEntries(choices.CHOICE_KEYS.map(name => [name, 'no'])) } };
  const html = choices.appendSignedChoiceHtml(built.html.trim(), frozen, frozen.snapshot_json.signature_evidence.consent_choices);
  await doc.update({ status: 'signed', signed_at: signedAt, snapshot_json: frozen.snapshot_json, snapshot_html: html,
    snapshot_hash: choices.choiceSnapshotHash(frozen.snapshot_json, html) });
  const signed = await state(); assert.equal(signed.state, 'signed'); assert.equal(signed.document_id, doc.id);
  assert(!JSON.stringify(signed).includes('consent_choices'));
  await db.CitaPaciente.update({ care_started_at: new Date(Date.now() - 1000) }, { where: { id_cita: 13 } });
  // Native grouped SQL must work under ONLY_FULL_GROUP_BY with nullable dates.
  assert.equal((await state(3, 66, null)).allowed, true);
  const service = require('../../services/consentimientos.service');
  const rows = await db.CitaPaciente.findAll({ where: { paciente_id: 2 } });
  const unchanged = await counts(); await service.attachConsentSummaryToCitas(rows); assert.deepEqual(await counts(), unchanged);
  for (const row of rows) {
    const summary = row.getDataValue('consent_summary'); assert.equal(summary.status, 'none'); assert.equal(summary.has_pending, false);
    assert.equal(summary.privacy.state, 'signed'); assert.equal(summary.privacy_error, undefined);
  }
  report.checks.push('native grouped read-only privacy status: new/imported/pending/sent/viewed/cancelled/signed/paper');
  report.checks.push('patient-level paper double-click serializes to one append-only receipt with null appointment; legal care gate accepts it');
  report.checks.push('exact clinic/group membership; no GET writes, tokens, PHI or clinical count changes; batched agenda DTO uses same state');
}));
