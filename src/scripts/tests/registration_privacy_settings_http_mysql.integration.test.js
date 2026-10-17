'use strict';
// Native HTTP/auth/ACL + generic registration under an owned local mysqld.
// Every phone/patient/template is fictitious; all provider sockets are denied.
const test = require('node:test'), assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitAuthAclFixture } = require('./helpers/owned-visit-auth-acl-fixture');
const registration = require('../../lib/registration-privacy-template');
const choices = require('../../lib/consent-document-choices');
const privacy = require('../../services/appointmentPrivacyEligibility.service');
const paper = require('../../lib/registration-privacy-paper');
const signature = { signer_name: 'Firmante ficticio QA', accepted_statement: true,
  signature_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=' };

test('generic intake settings and native editable LOPD: ACL, CAS, legal entities, additional documents, independent send and paper', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 180000,
}, async () => withIsolatedCampaignMysql(async owned => {
  owned.models.EconomicBudgetSignatureRequest = require('../../../models/economicbudgetsignaturerequest')(owned.sql, S.DataTypes);
  await owned.models.EconomicBudgetSignatureRequest.sync();
  const f = await createOwnedVisitAuthAclFixture({ ...owned, includeConsentRoutes: true, includePatientIntakeSettingsRoutes: true });
  const { db, ids, request } = f;
  for (const name of ['PatientCustomField', 'PatientConsentExternalAttestation']) {
    db[name] = require(`../../../models/${name.toLowerCase()}`)(owned.sql, S.DataTypes); await db[name].sync();
  }
  const C = require('../../services/authEmailChallenge.contract');
  const login = async id => {
    const started = await request('POST', '/api/auth/sign-in', { email: `owned-${id}@example.invalid`, password: f.password });
    assert.equal(started.status, 202);
    const row = await db.AuthEmailChallenge.findOne({ where: { challenge_hash: C.challengeHash(started.body.challengeToken) } });
    const verified = await request('POST', '/api/auth/email-code/verify', { challengeToken: started.body.challengeToken,
      code: f.codeFor(row.challenge_id) }); assert.equal(verified.status, 200); return verified.body.token;
  };
  const expect = async (method, path, body, token, status) => {
    const result = await request(method, path, body, token); assert.equal(result.status, status, JSON.stringify(result.body)); return result.body;
  };
  try {
    const owner = await login(ids.owner), reception = await login(ids.reception), outsider = await login(ids.outsider);
    const clinicId = ids.clinic, route = `/api/clinicas/${clinicId}/patient-intake-settings`;
    let setting = await expect('GET', route, undefined, owner, 200);
    assert.equal(setting.patient_intake.privacy_enabled, false);
    await expect('GET', route, undefined, undefined, 401);
    await expect('GET', route, undefined, outsider, 403);
    const clinical = await db.ClinicConsentTemplate.create({ public_id: 'qa_generic_optional', clinic_id: clinicId,
      name: 'Documento adicional ficticio', purpose: 'clinical', status: 'active', is_default: false, blocking_policy: 'optional' });
    await db.ClinicConsentTemplateVersion.create({ clinic_template_id: clinical.id, version: 1, locale: 'es', status: 'published',
      title: 'Documento adicional', body_html: '<p>Documento adicional ficticio de prueba.</p>' });
    const draft = await expect('POST', `${route}/standard-template`, {}, owner, 201);
    const template = await db.ClinicConsentTemplate.findByPk(draft.template_id), version = await db.ClinicConsentTemplateVersion.findOne({ where: { clinic_template_id: draft.template_id } });
    assert.equal(template.status, 'draft'); assert.equal(version.status, 'draft');
    assert(registration.schema(version.body_json));
    assert.equal((await expect('GET', route, undefined, owner, 200)).patient_intake.privacy_enabled, false, 'Creating a draft does not activate registration');
    const update = { privacy_enabled: true, privacy_before_first_care: true, privacy_template_id: template.id,
      medical_questionnaire_enabled: false, additional_documents: [{ template_id: clinical.id, required: false, sort_order: 1 }],
      privacy_controller: { legal_name: 'Sociedad clínica A ficticia', tax_id: 'QA-A-NO-REAL', address: 'Dirección ficticia A',
        email: 'clinic-a@example.invalid', phone: '+34000000001', dpo_name: 'DPO QA', dpo_email: 'dpo-a@example.invalid' } };
    await expect('PUT', route, { patient_intake: update, expected_version: setting.version }, owner, 400);
    await template.update({ status: 'active' }); await version.update({ status: 'published', published_at: new Date() });
    await expect('PUT', route, { patient_intake: update, expected_version: 'stale' }, owner, 409);
    const denied = await db.AccessPolicyOverride.create({ scope_type: 'clinic', scope_id: clinicId,
      feature_key: 'clinic.settings.edit', role_code: 'reception', effect: 'deny', updated_by: ids.owner });
    await expect('PUT', route, { patient_intake: update, expected_version: setting.version }, reception, 403);
    await denied.destroy();
    setting = await expect('PUT', route, { patient_intake: update, expected_version: setting.version }, owner, 200);
    assert.equal(setting.patient_intake.additional_documents[0].template_id, clinical.id);
    await expect('PUT', route, { patient_intake: { additional_documents: [{ template_id: template.id, required: true, sort_order: 0 }] }, expected_version: setting.version }, owner, 400);
    const foreign = await db.ClinicConsentTemplate.create({ public_id: 'qa_generic_foreign', clinic_id: ids.peerClinic,
      name: 'Extranjero QA', purpose: 'clinical', status: 'active' });
    await expect('PUT', route, { patient_intake: { additional_documents: [{ template_id: foreign.id, required: false, sort_order: 0 }] }, expected_version: setting.version }, owner, 400);
    owned.report.checks.push('native settings HTTP: JWT/MFA/clinic ACL, draft never activates, template scope/publication, CAS and ordered extras validated');

    const service = require('../../services/consentimientos.service'), patientId = 92601;
    await db.Paciente.create({ id_paciente: patientId, clinica_id: clinicId, public_id: 'pac_generic_qa', nombre: 'Paciente', apellidos: 'Ficticio',
      numero_historia: String(patientId), historia_scope: `clinic:${clinicId}`, telefono_movil: null, telefono_secundario: null });
    await db.PacienteClinica.create({ paciente_id: patientId, clinica_id: clinicId, es_principal: true });
    const prepared = await service.createPatientIntakePackage(patientId, { clinicId, createdBy: ids.owner, privacyOnly: true });
    assert.equal(prepared.created_count, 1, 'Independent LOPD never includes configured extras or medical questionnaire');
    assert.equal(await db.ConsentDeliveryEvent.count(), 0, 'Preparation never sends');
    const session = await service.createTabletSession(prepared.package_id, { createdBy: ids.owner });
    const publicRoute = '/api/consentimientos/public/' + encodeURIComponent(session.public_token);
    const viewed = await expect('GET', publicRoute, undefined, undefined, 200), doc = viewed.documents[0];
    assert.equal(doc.personal_data_form.schema_version, registration.IDENTITY_SCHEMA);
    assert.deepEqual(doc.choice_form.fields.map(row => row.key), ['commercial', 'sms_whatsapp']);
    assert(doc.snapshot_html.includes('Sociedad clínica A ficticia')); assert(!doc.snapshot_html.includes('INSTITUTO OBES'));
    const corrected = await expect('POST', `${publicRoute}/documents/${doc.id}/personal-data`, {
      schema_version: registration.IDENTITY_SCHEMA, snapshot_hash: doc.snapshot_hash,
      values: { ...doc.personal_data_form.values, dni: 'QA-PATIENT-NOT-REAL', fecha_nacimiento: '1980-01-02',
        direccion: 'Calle ficticia 9', ciudad: 'Alicante', telefono: '+34000000003', telefono2: '+34000000004', email: 'patient-qa@example.invalid' },
    }, undefined, 200);
    const current = corrected.documents[0];
    await expect('POST', publicRoute + '/sign', { ...signature,
      document_snapshot_hashes: { [doc.id]: current.snapshot_hash }, document_choices: { [doc.id]: {
        schema_version: registration.CHOICE_SCHEMA, answers: { commercial: 'no', sms_whatsapp: 'no' } } } }, undefined, 200);
    const signed = await db.PatientConsentDocument.findByPk(doc.id);
    assert.deepEqual(choices.signedConsentChoiceAnswers(signed), { commercial: 'no', sms_whatsapp: 'no' });
    const frozen = JSON.stringify(signed.toJSON());
    const state = await db.sequelize.transaction(transaction => require('../../services/patientPrivacyStatus.service').getPatientPrivacyStatus({ db, patientId, clinicId, transaction }));
    assert.equal(state.state, 'signed'); assert.equal(state.allowed, true);
    const assessment = await db.sequelize.transaction(transaction => privacy.assessPrivacyBeforeStart({ db,
      appointment: { id_cita: 99001, paciente_id: patientId, clinica_id: clinicId }, transaction }));
    assert.equal(assessment.allowed, true);
    const refusals = await require('../../lib/bs-privacy-commercial-preferences').channelRefusals({ db, clinicIds: [clinicId], phone: '+34000000003' });
    assert(refusals.phoneDigits.has('34000000003'));
    const full = await service.createPatientIntakePackage(patientId, { clinicId, createdBy: ids.owner, privacyOnly: false });
    assert.equal(full.created_count, 1, 'Explicit full intake adds only the configured additional document after signed LOPD');
    const extra = await db.PatientConsentDocument.findOne({ where: { package_id: full.package_id } });
    assert.equal(extra.clinic_template_id, clinical.id); assert.equal(extra.purpose, 'clinical'); assert.equal(extra.required, false);
    assert.equal(await db.PatientIntakeRequest.count(), 0);
    assert.equal(JSON.stringify((await signed.reload()).toJSON()), frozen, 'All later reads/preparations preserve signed snapshot');
    owned.report.checks.push('generic tablet: native identity12 + combined explicit choices, No valid for care, scoped channel refusal, immutable signed evidence, privacy-only vs explicit extras, no medical form');

    const paperPatient = 92602;
    await db.Paciente.create({ id_paciente: paperPatient, clinica_id: clinicId, public_id: 'pac_generic_paper_qa', nombre: 'Papel', apellidos: 'Ficticio',
      numero_historia: String(paperPatient), historia_scope: `clinic:${clinicId}` });
    const result = await db.sequelize.transaction(transaction => paper.recordPatientRegistrationPrivacyPaper({ db,
      patientId: paperPatient, clinicId, actorId: ids.owner, acknowledged: true, transaction }));
    assert.equal(result.created, true);
    const receipt = await db.PatientOperationalEvent.findOne({ where: { patient_id: paperPatient, event_type: paper.PAPER_EVENT } });
    assert.equal(receipt.source, paper.CONFIGURED_PAPER_SOURCE);
    const paperState = await db.sequelize.transaction(transaction => require('../../services/patientPrivacyStatus.service').getPatientPrivacyStatus({ db,
      patientId: paperPatient, clinicId, transaction }));
    assert.equal(paperState.state, 'paper'); assert.equal(paperState.allowed, true);
    assert.equal((await require('../../lib/bs-privacy-commercial-preferences').channelRefusals({ db, clinicIds: [clinicId], patientIds: [paperPatient] })).patientIds.size, 0);
    owned.report.checks.push('generic reception paper v3 receipt satisfies configured LOPD only; never creates digital signature or channel/marketing opt-in');

    // The real SQL operator rehearses on the same owned Unix socket only.
    // A signed old BS notice remains byte-identical and valid after v2 issue.
    const digital = require('../../lib/bs-privacy-digital-template'), old = digital.buildBsPrivacyDigitalHtml();
    const bsTemplates = new Map();
    await db.GrupoClinica.create({ id_grupo: 99, nombre: 'Grupo BS ficticio operador' });
    for (const id of [66, 72]) {
      await db.Clinica.create({ id_clinica: id, grupoClinicaId: 99, nombre_clinica: `Ficticia BS ${id}`,
        configuracion: { patient_intake: { medical_questionnaire_enabled: false }, unrelated: { preserve: true } } });
      const header = await db.ClinicConsentTemplate.create({ public_id: `qa_operator_bs_${id}`, clinic_id: id,
        catalog_key: privacy.FINAL_PRIVACY_KEY, name: 'LOPD BS QA', purpose: 'data_protection', status: 'active', is_default: true,
        blocking_policy: 'hard', validity_mode: 'manual' });
      const source = await db.ClinicConsentTemplateVersion.create({ clinic_template_id: header.id, version: 2, locale: 'es',
        title: 'Protección de datos', status: 'published', body_html: old.html,
        body_json: { digital_presentation: old.metadata, consent_form: old.consent_form }, variable_schema: { consent_form: old.consent_form } });
      bsTemplates.set(id, { header, source });
    }
    await db.Usuario.create({ id_usuario: 1, nombre: 'Admin ficticio operador', email_usuario: 'qa-operator@example.invalid', estado_cuenta: 'activo' });
    const op = require('../registration-privacy-settings-release');
    const raw = await db.sequelize.connectionManager.getConnection({ type: 'WRITE' });
    const connection = raw.promise();
    try {
      const before = await op.capture(connection), plan = op.makePlan(before, 'dev', 1), backups = [];
      const saveBackup = (_file, value) => backups.push(value);
      const documentBefore = JSON.stringify((await signed.reload()).toJSON());
      const options = { connection, plan, approvedHash: op.hash(plan), backupPath: 'owned-fixture-memory-only', saveBackup };
      const dry = await op.execute(options);
      assert.equal(dry.mode, 'rolled_back_dry_run'); assert.equal(dry.created_versions, 2);
      assert.equal(op.hash(await op.capture(connection)), op.hash(before));
      assert.equal(backups.length, 1); assert.equal(backups[0].plan_sha256, op.hash(plan));
      const applied = await op.execute({ ...options, dryRun: false });
      assert.equal(applied.mode, 'applied'); assert.equal(applied.created_versions, 2);
      const after = await op.capture(connection);
      assert.equal(after.versions.length, before.versions.length + 2);
      for (const clinic of after.clinics) {
        const configuration = require('../../lib/registration-privacy-configuration').object(clinic.configuracion);
        assert.equal(configuration.unrelated.preserve, true);
        assert.equal(configuration.patient_intake.medical_questionnaire_enabled, false);
        assert.deepEqual(configuration.patient_intake.additional_documents, []);
      }
      for (const id of [66, 72]) {
        const { header, source } = bsTemplates.get(id), current = await db.ClinicConsentTemplateVersion.findOne({ where: {
          clinic_template_id: header.id, status: 'published' }, order: [['version', 'DESC']] });
        const versions = await privacy.approvedPrivacyVersions({ db, template: header.toJSON(), version: current.toJSON() });
        assert(versions.has(source.id), 'Old BS v1 approval survives new combined-channel version');
      }
      assert.equal(JSON.stringify((await signed.reload()).toJSON()), documentBefore);
      await assert.rejects(op.execute(options), /PLAN_CHANGED_REPLAN_REQUIRED/);
      const replayPlan = op.makePlan(await op.capture(connection), 'dev', 1);
      assert(replayPlan.entries.every(row => row.create_version === false), 'A reviewed replay does not duplicate published versions');
    } finally { await db.sequelize.connectionManager.releaseConnection(raw); }
    owned.report.checks.push('real BS SQL release: read plan, backup before DML, locked dry-run rollback exact, additive v2 only, old approved v1 remains eligible, unrelated settings/signed rows intact, stale plan rejected and fresh replay creates no duplicate version');
  } finally { await f.close(); }
}));
