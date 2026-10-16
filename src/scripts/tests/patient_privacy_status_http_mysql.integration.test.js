'use strict';
// Full native HTTP/router + JWT/MFA/session/clinic ACL. All tenants, credentials,
// phone-less patients and the mysqld are disposable and owned by this fixture.
const test = require('node:test'), assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitAuthAclFixture } = require('./helpers/owned-visit-auth-acl-fixture');
const privacy = require('../../services/appointmentPrivacyEligibility.service');
const digital = require('../../lib/bs-privacy-digital-template');
const choices = require('../../lib/consent-document-choices');

test('native privacy HTTP endpoints enforce JWT/MFA/ACL and exact patient/clinic/appointment scope', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 180000,
}, async () => withIsolatedCampaignMysql(async owned => {
  owned.models.EconomicBudgetSignatureRequest = require('../../../models/economicbudgetsignaturerequest')(owned.sql, S.DataTypes);
  await owned.models.EconomicBudgetSignatureRequest.sync();
  const f = await createOwnedVisitAuthAclFixture({ ...owned, includeConsentRoutes: true, nativeFinalHandler: true });
  const { db, ids, request } = f;
  for (const name of ['PatientCustomField', 'PatientConsentExternalAttestation']) {
    db[name] = require(`../../../models/${name.toLowerCase()}`)(owned.sql, S.DataTypes); await db[name].sync();
  }
  const C = require('../../services/authEmailChallenge.contract');
  const login = async id => {
    const challenge = await request('POST', '/api/auth/sign-in', { email: `owned-${id}@example.invalid`, password: f.password });
    assert.equal(challenge.status, 202);
    const row = await db.AuthEmailChallenge.findOne({ where: { challenge_hash: C.challengeHash(challenge.body.challengeToken) } });
    const verified = await request('POST', '/api/auth/email-code/verify', { challengeToken: challenge.body.challengeToken,
      code: f.codeFor(row.challenge_id) }); assert.equal(verified.status, 200); return verified.body.token;
  };
  const patientId = 92501, importedId = 92502, foreignId = 92503, appointmentId = 78501;
  const path = `/api/consentimientos/patients/pac_privacy_http_${patientId}`;
  const fingerprint = async () => ({ ...await f.fingerprint(), paper: await db.PatientConsentExternalAttestation.findAll({ raw: true }),
    imported: await db.PatientCustomField.findAll({ raw: true }) });
  const silent = async () => Object.fromEntries(await Promise.all(['Message', 'FlowExecutionV2', 'FlowExecutionLogV2', 'JobRequest',
    'PatientIntakeRequest', 'AppointmentVisitCommunication', 'AppointmentVisitDispatch'].map(async name => [name, await db[name].count()])));
  const expect = async (method, route, body, token, expectedStatus) => {
    const result = await request(method, route, body, token); assert.equal(result.status, expectedStatus, JSON.stringify(result.body));
    return result.body;
  };
  const read = async token => expect('GET', `${path}/privacy?clinic_id=72&appointment_id=${appointmentId}`, undefined, token, 200);
  try {
    await db.Clinica.bulkCreate([{ id_clinica: 66, grupoClinicaId: ids.group, nombre_clinica: 'OWNED BS66',
      configuracion: { patient_intake: { medical_questionnaire_enabled: false } } },
    { id_clinica: 72, grupoClinicaId: ids.group, nombre_clinica: 'OWNED BS72',
      configuracion: { patient_intake: { medical_questionnaire_enabled: false } } }]);
    await db.UsuarioClinica.bulkCreate([66, 72].map(clinicId => ({ id_usuario: ids.reception, id_clinica: clinicId,
      rol_clinica: 'personaldeclinica', subrol_clinica: 'Recepción / Comercial ventas', estado_invitacion: 'aceptada' })));
    await db.Paciente.bulkCreate([[patientId, 72], [importedId, 66], [foreignId, ids.peerClinic]].map(([id, clinic]) => ({
      id_paciente: id, clinica_id: clinic, public_id: `pac_privacy_http_${id}`, nombre: 'OWNED fictitious', apellidos: String(id),
      numero_historia: String(id), historia_scope: `clinic:${clinic}`, telefono_movil: null, telefono_secundario: null })));
    await db.PacienteClinica.bulkCreate([{ paciente_id: patientId, clinica_id: 72, es_principal: true },
      { paciente_id: importedId, clinica_id: 66, es_principal: true }, { paciente_id: importedId, clinica_id: 72 }]);
    await db.PatientCustomField.create({ paciente_id: importedId, clinica_id: 66, field_key: 'qa_http_source', source: 'cliniccloud',
      source_column: 'idContacto', value: '1075' });
    const start = new Date(Date.now() + 3600000);
    await db.CitaPaciente.create({ id_cita: appointmentId, paciente_id: patientId, clinica_id: 72,
      inicio: start, fin: new Date(+start + 1800000), estado: 'info_enviada', tipo_cita: 'primera_sin_trat' });
    const built = digital.buildBsPrivacyDigitalHtml();
    for (const clinicId of [66, 72]) {
      const template = await db.ClinicConsentTemplate.create({ public_id: `qa_privacy_http_${clinicId}`, clinic_id: clinicId,
        catalog_key: privacy.FINAL_PRIVACY_KEY, name: 'Protección de datos QA', purpose: 'data_protection', status: 'active',
        is_default: true, blocking_policy: 'hard', validity_mode: 'manual' });
      await db.ClinicConsentTemplateVersion.create({ clinic_template_id: template.id, version: 2, locale: 'es', status: 'published',
        title: 'Protección de datos', body_html: built.html, body_json: { consent_form: built.consent_form, digital_presentation: built.metadata },
        variable_schema: { consent_form: built.consent_form } });
    }
    const reception = await login(ids.reception), outsider = await login(ids.outsider), before = await fingerprint(), quiet = await silent();
    const initial = await read(reception); assert.equal(initial.state, 'not_requested'); assert.equal(initial.required, true);
    assert.equal(initial.allowed, false); assert.equal(initial.attention_required, true); assert.deepEqual(await fingerprint(), before);
    await expect('GET', `${path}/privacy?clinic_id=72`, undefined, undefined, 401);
    await expect('GET', `${path}/privacy?clinic_id=72`, undefined, outsider, 403);
    await expect('GET', `${path}/privacy?clinic_id=72&appointment_id=${appointmentId + 1}`, undefined, reception, 404);
    await expect('GET', `${path}/privacy?clinic_id=66&appointment_id=${appointmentId}`, undefined, reception, 403);
    await expect('GET', `/api/consentimientos/patients/pac_privacy_http_${foreignId}/privacy?clinic_id=72`, undefined, reception, 403);
    await expect('GET', `${path}/privacy?clinic_id=72&appointment_id=1bad`, undefined, reception, 400);
    await expect('POST', `${path}/privacy-package`, { clinic_id: 72, patientId: foreignId }, reception, 400);
    await expect('POST', `${path}/privacy-paper`, { clinic_id: 72, acknowledged: false }, reception, 400);
    await expect('POST', `${path}/privacy-paper`, { clinic_id: 72, acknowledged: true, appointment_id: appointmentId }, reception, 400);
    assert.deepEqual(await fingerprint(), before, 'Rejected native requests mutate no domain/clinical/signature record');
    const imported = await expect('GET', `/api/consentimientos/patients/pac_privacy_http_${importedId}/privacy?clinic_id=72`, undefined, reception, 200);
    assert.equal(imported.required, false); assert.equal(imported.attention_required, false); assert.equal(imported.state, 'not_requested');
    const prepared = await expect('POST', `${path}/privacy-package`, { clinic_id: 72 }, reception, 201);
    assert.equal(prepared.created_count, 1); assert.equal(await db.PatientIntakeRequest.count(), 0);
    const pending = await read(reception); assert.equal(pending.state, 'pending'); assert.equal(pending.package_id, prepared.package_id);
    const docs = await db.PatientConsentDocument.findAll({ where: { package_id: prepared.package_id } });
    assert.equal(docs.length, 1); assert.equal(docs[0].purpose, 'data_protection'); assert.equal(docs[0].tratamiento_id, null);
    const tablet = await expect('POST', `/api/consentimientos/packages/${prepared.package_id}/tablet-session`, {}, reception, 200);
    assert.equal((await read(reception)).state, 'sent');
    const tabletPath = `/api/consentimientos/public/${encodeURIComponent(tablet.public_token)}`;
    const viewed = await expect('GET', tabletPath, undefined, undefined, 200);
    assert.equal(viewed.documents.length, 1); assert.equal(viewed.intake, null);
    assert.equal((await read(reception)).state, 'viewed');
    const pkg = await db.ConsentSignaturePackage.findByPk(prepared.package_id); await pkg.update({ status: 'cancelled' });
    assert.equal((await read(reception)).state, 'not_requested');
    await pkg.update({ status: 'pending' });
    const signature = { signer_name: 'OWNED fictitious signer', accepted_statement: true,
      signature_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=' };
    await expect('POST', `/api/consentimientos/documents/${docs[0].id}/sign`, signature, reception, 409);
    const confirmed = await expect('POST', `${tabletPath}/documents/${docs[0].id}/personal-data`, {
      schema_version: viewed.documents[0].personal_data_form.schema_version, snapshot_hash: viewed.documents[0].snapshot_hash,
      values: viewed.documents[0].personal_data_form.values,
    }, undefined, 200);
    const currentDoc = confirmed.documents[0]; assert.equal(currentDoc.personal_data_form.confirmed, true);
    await expect('POST', `${tabletPath}/sign`, { ...signature,
      document_snapshot_hashes: { [docs[0].id]: currentDoc.snapshot_hash } }, undefined, 400);
    assert.equal((await read(reception)).state, 'viewed');
    await expect('POST', `${tabletPath}/sign`, { ...signature,
      document_snapshot_hashes: { [docs[0].id]: currentDoc.snapshot_hash },
      document_choices: { [docs[0].id]: { schema_version: choices.CHOICE_SCHEMA_VERSION,
        answers: Object.fromEntries(choices.CHOICE_KEYS.map(name => [name, 'no'])) } } }, undefined, 200);
    const signed = await read(reception); assert.equal(signed.state, 'signed'); assert.equal(signed.attention_required, false);
    assert.equal(signed.document_id, docs[0].id); assert(!JSON.stringify(signed).includes('consent_choices'));
    const importedPath = `/api/consentimientos/patients/pac_privacy_http_${importedId}`;
    const importedPrepared = await expect('POST', `${importedPath}/privacy-package`, { clinic_id: 72 }, reception, 201);
    const importedDoc = await db.PatientConsentDocument.findOne({ where: { package_id: importedPrepared.package_id } });
    await expect('POST', `/api/consentimientos/packages/${importedPrepared.package_id}/tablet-session`, {}, reception, 200);
    const mixed = await db.ConsentSignaturePackage.create({ public_id: 'qa_mixed_privacy_paper', paciente_id: importedId,
      clinica_id: 72, status: 'pending', expires_at: new Date(Date.now() + 86400000) });
    const originalImported = importedDoc.toJSON();
    const mixedPrivacy = await db.PatientConsentDocument.create({ ...originalImported, id: undefined,
      public_id: 'qa_mixed_privacy_attempt', package_id: mixed.id, status: 'pending' });
    const mixedClinical = await db.PatientConsentDocument.create({ public_id: 'qa_mixed_clinical_untouched', package_id: mixed.id,
      paciente_id: importedId, clinica_id: 72, title: 'Clinical QA preserved', purpose: 'clinical', status: 'pending',
      required: true, blocking_policy: 'hard', snapshot_html: '<p>Unchanged clinical QA</p>' });
    const clinicalBefore = (await mixedClinical.reload()).toJSON();
    const kioskAccess = await expect('POST', '/api/consentimientos/clinic/72/tablet-kiosk', { display_name: 'OWNED privacy QA' }, reception, 201);
    const kiosk = await expect('POST', '/api/consentimientos/tablet/login', { username: kioskAccess.kiosk.username,
      password: kioskAccess.kiosk.one_time_password }, undefined, 200);
    const queued = await expect('GET', '/api/consentimientos/tablet/packages', undefined, kiosk.token, 200);
    assert(queued.items.some(item => item.id === importedPrepared.package_id));
    const paperPath = `/api/consentimientos/patients/pac_privacy_http_${importedId}/privacy-paper`;
    const paperResult = await expect('POST', paperPath, { clinic_id: 72, acknowledged: true }, reception, 201);
    assert.equal(paperResult.privacy_on_paper, true); assert.equal(paperResult.privacy_signed, false);
    await expect('POST', paperPath, { clinic_id: 72, acknowledged: true }, reception, 200);
    const paperState = await expect('GET', `/api/consentimientos/patients/pac_privacy_http_${importedId}/privacy?clinic_id=72`, undefined, reception, 200);
    assert.equal(paperState.state, 'paper'); assert.equal(paperState.document_id, null);
    const evidence = await db.PatientOperationalEvent.findOne({ where: { patient_id: importedId, event_type: 'registration_privacy.paper_recorded' } });
    assert.equal(evidence.metadata.appointment_id, null); assert.equal(evidence.source, 'registration_privacy_paper/v2');
    assert.equal((await importedDoc.reload()).status, 'superseded'); assert.equal((await mixedPrivacy.reload()).status, 'superseded');
    assert.deepEqual((await mixedClinical.reload()).toJSON(), clinicalBefore, 'A mixed-package clinical document stays byte-for-byte unchanged');
    const afterPaperKiosk = await expect('GET', '/api/consentimientos/tablet/packages', undefined, kiosk.token, 200);
    assert(!afterPaperKiosk.items.some(item => item.id === importedPrepared.package_id), 'Solved standalone LOPD disappears from kiosk');
    assert.equal(afterPaperKiosk.items.find(item => item.id === mixed.id)?.pending_count, 1, 'Mixed package still offers its one clinical task only');
    await expect('POST', `/api/consentimientos/packages/${importedPrepared.package_id}/tablet-session`, {}, reception, 409);
    const reopened = await expect('POST', `${importedPath}/privacy-package`, { clinic_id: 72 }, reception, 200);
    assert.equal(reopened.privacy_satisfied, true); assert.equal(reopened.privacy_signed, false); assert.equal(reopened.created_count, 0);
    assert.deepEqual(await silent(), quiet, 'No questionnaire, provider message, job, flow, review or operational dispatch is created');
    owned.report.checks.push('Actual JWT/MFA/session/ACL/router: read-only GET, all six UI states, exact patient-clinic-group scope and optional appointment mismatch');
    owned.report.checks.push('Actual patient prepare creates one independent LOPD only; explicit tablet session; four No choices valid; missing choices rejected without signature');
    owned.report.checks.push('Native patient paper v2 without appointment, idempotent, no invented digital document; no provider/job/flow/questionnaire/review sends');
    owned.report.checks.push('Sent LOPD -> paper supersedes outstanding family attempts and removes kiosk task; reopening creates nothing; mixed clinical document preserved and remains usable');
    owned.report.requests = f.requests; owned.report.externalFetchAttempts = f.externalFetchAttempts;
  } finally { await f.close(); }
}));
