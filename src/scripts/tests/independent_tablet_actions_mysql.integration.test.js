'use strict';

// Disposable mysqld only: the fixture owns its Unix socket, denies TCP/provider
// sockets and replaces the model index before any application service is loaded.
const test = require('node:test'), assert = require('node:assert/strict');
const { Sequelize, DataTypes: D } = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const digital = require('../../lib/bs-privacy-digital-template');
const choices = require('../../lib/consent-document-choices');
const privacy = require('../../services/appointmentPrivacyEligibility.service');
const paper = require('../../lib/registration-privacy-paper');
const q = require('../../lib/patient-intake-questionnaire');
const { appointmentTabletStatus } = require('../../services/appointmentTabletStatus.service');

function defineModels(sql, db) {
  db.Sequelize = Sequelize;
  db.Clinica = sql.define('Clinica', { id_clinica: { type: D.INTEGER, primaryKey: true },
    grupoClinicaId: D.INTEGER, nombre_clinica: D.STRING(100), datos_fiscales_clinica: D.JSON, configuracion: D.JSON,
    direccion: D.STRING(100), ciudad: D.STRING(100), provincia: D.STRING(100), pais: D.STRING(100),
    codigo_postal: D.STRING(20), telefono: D.STRING(30), telefono_whatsapp: D.STRING(30), email: D.STRING(100),
  }, { tableName: 'Clinicas', timestamps: false });
  db.Paciente = sql.define('Paciente', { id_paciente: { type: D.INTEGER, primaryKey: true },
    public_id: D.STRING(80), clinica_id: D.INTEGER, nombre: D.STRING(100), apellidos: D.STRING(100), dni: D.STRING(40),
    fecha_nacimiento: D.DATEONLY, telefono_movil: D.STRING(40), email: D.STRING(100), edad: D.INTEGER,
    alergias: D.TEXT, medicacion: D.TEXT, antecedentes: D.TEXT, direccion: D.STRING(100), codigo_postal: D.STRING(20),
    acepta_marketing: { type: D.BOOLEAN, defaultValue: false },
  }, { tableName: 'Pacientes', timestamps: false });
  db.CitaPaciente = sql.define('CitaPaciente', { id_cita: { type: D.INTEGER, primaryKey: true },
    paciente_id: D.INTEGER, clinica_id: D.INTEGER, inicio: D.DATE, estado: D.STRING(40),
    care_started_at: D.DATE, care_legacy_attendance: { type: D.BOOLEAN, defaultValue: false },
  }, { tableName: 'CitasPacientes', timestamps: false });
  db.Tratamiento = sql.define('Tratamiento', { id_tratamiento: { type: D.INTEGER, primaryKey: true },
    nombre: D.STRING(100), disciplina: D.STRING(100) }, { tableName: 'Tratamientos', timestamps: false });
  for (const name of ['ClinicConsentTemplate', 'ClinicConsentTemplateVersion', 'ConsentSignaturePackage',
    'PatientConsentDocument', 'ConsentDeliveryEvent', 'PatientIntakeRequest', 'PatientCustomField',
    'PacienteClinica', 'PatientOperationalEvent', 'PatientConsentExternalAttestation']) {
    db[name] = require(`../../../models/${name.toLowerCase()}`)(sql, D);
  }
  // Production uses explicit DDL; only the QA sync index needs a short name.
  db.PatientOperationalEvent.options.indexes.forEach((index, i) => { index.name = `qa_independent_event_${i}`; });
  for (const model of [db.ConsentSignaturePackage, db.PatientConsentDocument]) {
    model.belongsTo(db.Paciente, { foreignKey: 'paciente_id', targetKey: 'id_paciente', as: 'paciente', constraints: false });
    model.belongsTo(db.Clinica, { foreignKey: 'clinica_id', targetKey: 'id_clinica', as: 'clinica', constraints: false });
    model.belongsTo(db.Tratamiento, { foreignKey: 'tratamiento_id', targetKey: 'id_tratamiento', as: 'tratamiento', constraints: false });
  }
  db.PatientConsentDocument.belongsTo(db.ConsentSignaturePackage, { foreignKey: 'package_id', as: 'package', constraints: false });
  db.ConsentSignaturePackage.hasMany(db.PatientConsentDocument, { foreignKey: 'package_id', as: 'documents', constraints: false });
}

test('independent LOPD/medical actions and status use real isolated MySQL, preserve history and serialize races', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 180000,
}, async () => withIsolatedCampaignMysql(async ({ sql, models: db, report }) => {
  defineModels(sql, db);
  await sql.sync(); // Newly-created, fixture-owned empty database only.
  const consent = require('../../services/consentimientos.service');
  const intake = require('../../services/patientIntake.service');
  await db.Clinica.bulkCreate([{ id_clinica: 66, grupoClinicaId: 29, nombre_clinica: 'Clínica QA 66' },
    { id_clinica: 72, grupoClinicaId: 29, nombre_clinica: 'Clínica QA 72' }]);
  const built = digital.buildBsPrivacyDigitalHtml();
  const template = await db.ClinicConsentTemplate.create({ public_id: 'qa_independent_privacy', clinic_id: 72,
    catalog_key: privacy.FINAL_PRIVACY_KEY, name: 'LOPD QA independiente', purpose: 'data_protection',
    status: 'active', blocking_policy: 'hard', validity_mode: 'manual', is_default: true });
  await db.ClinicConsentTemplateVersion.create({ clinic_template_id: template.id, version: 2, locale: 'es',
    status: 'published', title: 'LOPD QA independiente', body_html: built.html,
    body_json: { consent_form: built.consent_form, digital_presentation: built.metadata } });
  // A retired default must never leak into the explicit privacy action.
  await db.ClinicConsentTemplate.create({ public_id: 'qa_independent_old_medical', clinic_id: 72,
    catalog_key: 'cc_base_formulario_medico_alta_v1', name: 'Médico antiguo QA', purpose: 'data_protection',
    status: 'active', is_default: true });
  const patient = async (id, primary = 72) => {
    const row = await db.Paciente.create({ id_paciente: id, public_id: `qa_independent_patient_${id}`,
      clinica_id: primary, nombre: 'Paciente', apellidos: `Ficticio QA ${id}`, dni: 'QA-NO-VALIDO',
      fecha_nacimiento: '1990-01-01', email: null, telefono_movil: null,
      alergias: '', medicacion: '', antecedentes: '', acepta_marketing: false });
    await db.PacienteClinica.create({ paciente_id: id, clinica_id: 72, es_principal: primary === 72 });
    return row;
  };
  const appointment = async (id, clinicId = 72) => db.CitaPaciente.create({ id_cita: id, paciente_id: id, clinica_id: clinicId,
    inicio: new Date(Date.now() - 60000), estado: 'info_confirmada' });
  const status = a => sql.transaction({ readOnly: true, isolationLevel: 'REPEATABLE READ' }, transaction =>
    appointmentTabletStatus({ db, appointment: a.toJSON(), transaction }));
  const prepHealth = (id, clinicId = 72) => intake.prepare({ patientId: id, clinicId, actorId: 7 });
  const prepPrivacy = (id, clinicId = 72) => consent.createPatientIntakePackage(String(id), {
    clinicId, createdBy: 7, privacyOnly: true, allowLinkedClinic: true });
  const payload = p => ({ schema_version: q.VERSION, expected_version: 1, reviewed_answers: true,
    personal: q.personalSnapshot(p), answers: Object.fromEntries(q.fields.map(f => [f.key, f.type === 'choice' ? 'no' : ''])) });
  const rowJson = row => JSON.stringify(row.toJSON());

  const p = await patient(17, 66), a = await appointment(17);
  await p.reload();
  const patientBefore = rowJson(p);
  assert.deepEqual(await status(a), { privacy: { state: 'not_sent' }, intake: { enabled: true, state: 'not_sent' } });
  const [h1, h2] = await Promise.all([prepHealth(17), prepHealth(17)]);
  assert.equal(h1.package_id, h2.package_id); assert.equal(h1.intake_id, h2.intake_id);
  assert.equal(await db.PatientIntakeRequest.count(), 1); assert.equal(await db.PatientConsentDocument.count(), 0);
  assert.equal((await status(a)).privacy.state, 'not_sent');
  assert.equal((await status(a)).intake.state, 'sent');
  const healthSession = await consent.createTabletSession(h1.package_id, { base_url: 'http://tablet.invalid' });
  const healthView = await consent.getPublicPackage(healthSession.public_token);
  assert.equal(healthView.documents.length, 0); assert.equal(healthView.intake.fields.length, 16);
  assert.equal(await db.ConsentDeliveryEvent.count(), 0);
  report.checks.push('linked patient: concurrent health preparation creates one questionnaire, zero LOPD documents, real public view has 16 fields');

  const [l1, l2] = await Promise.all([prepPrivacy(17), prepPrivacy(17)]);
  const privacyPackageId = l1.package_id || l2.package_id;
  assert(privacyPackageId); assert.notEqual(privacyPackageId, h1.package_id);
  assert.equal(l1.created_count + l2.created_count, 1);
  assert.equal(await db.PatientIntakeRequest.count(), 1);
  assert.equal(await db.PatientIntakeRequest.count({ where: { package_id: privacyPackageId } }), 0);
  assert.equal(await db.PatientConsentDocument.count({ where: { package_id: h1.package_id } }), 0);
  const lopdSession = await consent.createTabletSession(privacyPackageId, { base_url: 'http://tablet.invalid' });
  await consent.createTabletSession(privacyPackageId, { base_url: 'http://tablet.invalid' });
  assert.equal(await db.ConsentDeliveryEvent.count(), 1, 'Sequential tablet hand-offs reuse the queued event');
  const both = await status(a); assert.equal(both.privacy.state, 'sent'); assert.equal(both.intake.state, 'sent');
  assert.notEqual(both.privacy.package_id, both.intake.package_id);
  const lopdView = await consent.getPublicPackage(lopdSession.public_token);
  assert.equal(lopdView.documents.length, 1); assert.equal(lopdView.intake, null);
  const doc = await db.PatientConsentDocument.findOne({ where: { package_id: privacyPackageId } });
  await consent.signPublicPackage(lopdSession.public_token, {
    signer_name: 'Firmante ficticio QA', accepted_statement: true,
    signature_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=',
    document_choices: { [doc.id]: { schema_version: choices.CHOICE_SCHEMA_VERSION,
      answers: Object.fromEntries(choices.CHOICE_KEYS.map(key => [key, 'no'])) } },
  });
  const signedDoc = await db.PatientConsentDocument.findByPk(doc.id), signedBefore = rowJson(signedDoc);
  assert.deepEqual(choices.signedConsentChoiceAnswers(signedDoc), Object.fromEntries(choices.CHOICE_KEYS.map(key => [key, 'no'])));
  assert.equal((await status(a)).privacy.state, 'completed'); assert.equal((await status(a)).intake.state, 'sent');
  report.checks.push('concurrent privacy preparation creates one separate LOPD-only item; real public four-No signature completes privacy but not medical questionnaire');

  const hp = await db.ConsentSignaturePackage.findByPk(h1.package_id);
  await intake.submit(hp, payload(p)); await consent.refreshPackageCounts(hp.id);
  assert.equal((await status(a)).intake.state, 'submitted');
  assert.equal((await intake.submit(hp, payload(p))).replayed, true);
  assert.equal(rowJson(await db.Paciente.findByPk(17)), patientBefore, 'Submitting never applies clinical/personal data automatically');
  const review = await intake.reviewView({ patientId: 17, clinicId: 72 });
  await intake.confirm({ patientId: 17, clinicId: 72, actorId: 7, payload: { id: h1.intake_id,
    expected_version: review.request.version, patient_version: review.patient_version,
    apply_personal_changes: false, summary: review.proposed } });
  assert.equal((await status(a)).intake.state, 'confirmed');
  const next = await prepHealth(17); assert.notEqual(next.package_id, hp.id);
  assert.equal(rowJson(await db.PatientConsentDocument.findByPk(doc.id)), signedBefore);
  assert.equal(await db.PatientConsentDocument.count(), 1);
  report.checks.push('clinical submit is idempotent and requires review to apply; reviewed status persists; requesting another questionnaire never re-signs or edits LOPD');

  // A fully isolated historical combined request remains immutable, but cannot
  // submit behind the new independent questionnaire and hide the new answers.
  const oldP = await patient(18), oldA = await appointment(18);
  const oldLopd = await prepPrivacy(18);
  const oldPkg = await db.ConsentSignaturePackage.findByPk(oldLopd.package_id);
  const oldRequest = await db.PatientIntakeRequest.create({ package_id: oldPkg.id, patient_id: 18, clinic_id: 72,
    schema_version: q.VERSION, personal_snapshot: q.personalSnapshot(oldP), created_by: 7 });
  const oldDoc = await db.PatientConsentDocument.findOne({ where: { package_id: oldPkg.id } });
  await oldRequest.reload();
  const historicalBefore = JSON.stringify([oldPkg.toJSON(), oldRequest.toJSON(), oldDoc.toJSON()]);
  const separate = await prepHealth(18); assert.notEqual(separate.package_id, oldPkg.id);
  await assert.rejects(intake.submit(oldPkg, payload(oldP)), { code: 'intake_request_superseded' });
  assert.equal(JSON.stringify([(await oldPkg.reload()).toJSON(), (await oldRequest.reload()).toJSON(), (await oldDoc.reload()).toJSON()]), historicalBefore);
  assert.equal((await status(oldA)).intake.package_id, separate.package_id);
  report.checks.push('historical combined document/package/request unchanged; old still-open tablet receives 409 superseded instead of hidden answers');

  // Prepare/submit collision under real MySQL locks. Whichever owns the patient
  // anchor wins; the losing action cannot create an invisible submission.
  const raceP = await patient(19); await appointment(19);
  const raceLopd = await prepPrivacy(19), racePkg = await db.ConsentSignaturePackage.findByPk(raceLopd.package_id);
  const raceReq = await db.PatientIntakeRequest.create({ package_id: racePkg.id, patient_id: 19, clinic_id: 72,
    schema_version: q.VERSION, personal_snapshot: q.personalSnapshot(raceP), created_by: 7 });
  const race = await Promise.allSettled([intake.submit(racePkg, payload(raceP)), prepHealth(19)]);
  assert.equal(race.filter(r => r.status === 'fulfilled').length, 1);
  const rejected = race.find(r => r.status === 'rejected').reason;
  assert(['intake_review_pending', 'intake_request_superseded'].includes(rejected.code));
  const latest = await db.PatientIntakeRequest.findOne({ where: { patient_id: 19, clinic_id: 72 }, order: [['id', 'DESC']] });
  const oldRace = await raceReq.reload();
  assert(oldRace.status !== 'submitted' || latest.id === oldRace.id);
  report.checks.push('real MySQL concurrent prepare/submit serializes patient-first: one succeeds, one semantic 409, no hidden submission or deadlock');

  const importedP = await patient(20), importedA = await appointment(20);
  await db.PatientCustomField.create({ paciente_id: 20, clinica_id: 72, source: 'cliniccloud',
    source_column: 'idContacto', field_key: 'qa_source_contact_id', value: '999999' });
  const record = await sql.transaction(transaction => paper.recordRegistrationPrivacyPaper({ db,
    appointment: importedA.toJSON(), actorId: 7, acknowledged: true, transaction }));
  assert.equal((await status(importedA)).privacy.state, 'paper');
  const importedGate = await sql.transaction(transaction => privacy.assessPrivacyBeforeStart({ db, appointment: importedA.toJSON(), transaction }));
  assert.equal(importedGate.reason, 'existing_imported_patient');
  await db.PatientConsentExternalAttestation.update({ revoked_at: new Date(), revoked_by: 7 }, { where: { id: record.evidence.attestation_id } });
  assert.equal((await status(importedA)).privacy.state, 'not_sent');
  assert.equal(await db.PatientConsentDocument.count({ where: { paciente_id: importedP.id_paciente } }), 0);
  assert.equal(rowJson(await db.PatientConsentDocument.findByPk(doc.id)), signedBefore);
  // Both BS scopes retain real LOPD documents in historical combined packages
  // while the optional health questionnaire is disabled. Never cancel a combined
  // package or edit/delete a request merely to hide its questions.
  const capilarTemplate = await db.ClinicConsentTemplate.create({ public_id: 'qa_disabled_privacy_66', clinic_id: 66,
    catalog_key: privacy.FINAL_PRIVACY_KEY, name: 'LOPD QA desactivación 66', purpose: 'data_protection',
    status: 'active', blocking_policy: 'hard', validity_mode: 'manual', is_default: true });
  await db.ClinicConsentTemplateVersion.create({ clinic_template_id: capilarTemplate.id, version: 2, locale: 'es',
    status: 'published', title: 'LOPD QA desactivación 66', body_html: built.html,
    body_json: { consent_form: built.consent_form, digital_presentation: built.metadata } });
  for (const [clinicId, id] of [[66, 21], [72, 22]]) {
    const combinedP = await patient(id, clinicId), combinedA = await appointment(id, clinicId);
    const lopd = await prepPrivacy(id, clinicId);
    const combinedPkg = await db.ConsentSignaturePackage.findByPk(lopd.package_id);
    const combinedRequest = await db.PatientIntakeRequest.create({ package_id: combinedPkg.id, patient_id: id, clinic_id: clinicId,
      schema_version: q.VERSION, personal_snapshot: q.personalSnapshot(combinedP), created_by: 7 });
    const combinedDoc = await db.PatientConsentDocument.findOne({ where: { package_id: combinedPkg.id } });
    const combinedSession = await consent.createTabletSession(combinedPkg.id, { base_url: 'http://tablet.invalid' });
    const healthP = await patient(id + 10, clinicId), health = await prepHealth(id + 10, clinicId);
    const healthPkg = await db.ConsentSignaturePackage.findByPk(health.package_id);
    const healthSessionBeforeDisable = await consent.createTabletSession(healthPkg.id, { base_url: 'http://tablet.invalid' });
    const answeredP = await patient(id + 20, clinicId), answered = await prepHealth(id + 20, clinicId);
    await intake.submit(await db.ConsentSignaturePackage.findByPk(answered.package_id), payload(answeredP));
    const requestsBefore = JSON.stringify((await db.PatientIntakeRequest.findAll({ order: [['id', 'ASC']], raw: true })));
    const patientsBefore = JSON.stringify((await db.Paciente.findAll({ order: [['id_paciente', 'ASC']], raw: true })));
    await db.Clinica.update({ configuracion: { unrelated: { preserve: true },
      patient_intake: { medical_questionnaire_enabled: false } } }, { where: { id_clinica: clinicId } });
    await assert.rejects(prepHealth(id, clinicId), { code: 'patient_intake_disabled', statusCode: 409 });
    await assert.rejects(prepHealth(id + 10, clinicId), { code: 'patient_intake_disabled', statusCode: 409 });
    await assert.rejects(intake.submit(combinedPkg, payload(combinedP)), { code: 'patient_intake_disabled', statusCode: 409 });
    await assert.rejects(intake.submit(healthPkg, payload(healthP)), { code: 'patient_intake_disabled', statusCode: 409 });
    assert.equal(await intake.publicView(combinedPkg), null);
    const combinedView = await consent.getPublicPackage(combinedSession.public_token);
    assert.equal(combinedView.intake, null); assert.equal(combinedView.documents.length, 1);
    assert.equal((await consent.getPublicPackage(healthSessionBeforeDisable.public_token)).intake, null);
    await assert.rejects(consent.createTabletSession(healthPkg.id), { message: 'consent_package_has_no_pending_documents', statusCode: 409 });
    const retained = await prepPrivacy(id, clinicId);
    assert.equal(retained.created_count, 0); assert(retained.current_package_ids.includes(combinedPkg.id));
    const disabledStatus = await status(combinedA);
    assert.equal(disabledStatus.intake.enabled, false); assert.equal(disabledStatus.intake.state, 'not_sent');
    assert.equal(disabledStatus.privacy.state, 'sent');
    await consent.signPublicPackage(combinedSession.public_token, {
      signer_name: 'Firmante ficticio QA', accepted_statement: true,
      signature_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=',
      document_choices: { [combinedDoc.id]: { schema_version: choices.CHOICE_SCHEMA_VERSION,
        answers: Object.fromEntries(choices.CHOICE_KEYS.map(key => [key, 'no'])) } },
    });
    const counts = await consent.refreshPackageCounts(combinedPkg.id);
    assert.equal(counts.status, 'signed'); assert.equal(counts.required_count, 1); assert.equal(counts.signed_count, 1);
    assert.equal((await status(combinedA)).privacy.state, 'completed');
    assert.equal((await db.PatientConsentDocument.findByPk(combinedDoc.id)).status, 'signed');
    assert.equal((await combinedRequest.reload()).status, 'pending', 'Pending historical request is preserved, not cancelled or signed');
    assert.equal(JSON.stringify((await db.PatientIntakeRequest.findAll({ order: [['id', 'ASC']], raw: true }))), requestsBefore);
    assert.equal(JSON.stringify((await db.Paciente.findAll({ order: [['id_paciente', 'ASC']], raw: true }))), patientsBefore);
    const reviewDisabled = await intake.reviewView({ patientId: id + 20, clinicId });
    assert.equal(reviewDisabled.request.status, 'submitted'); assert.equal(reviewDisabled.request.id, answered.intake_id);
    report.checks.push(`clinic ${clinicId} disabled in real JSON: prepare/submit 409, health-only tablet denied, combined LOPD reused/publicly signed/completed, all requests/answers/patients unchanged and existing answers reviewable`);
  }
  const channels = await db.ConsentDeliveryEvent.findAll({ attributes: ['channel'], raw: true });
  assert(channels.every(event => event.channel === 'tablet'));
  assert.equal(await db.Paciente.count({ where: { acepta_marketing: true } }), 0);
  report.checks.push('imported patient paper status reads real audited evidence despite start exemption; revocation restores not_sent, zero digital signatures invented');
  report.checks.push('all delivery events tablet-only, marketing unchanged; no DEV/CRM connection or provider sockets allowed');
}));
