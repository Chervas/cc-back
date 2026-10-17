'use strict';
// Real native HTTP/services/SQL, in a new owned skip-networking database only.
const test = require('node:test'), assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitAuthAclFixture } = require('./helpers/owned-visit-auth-acl-fixture');
const blocks = require('../../lib/consent-document-blocks'), completion = require('../../lib/consent-document-completion');
const choices = require('../../lib/consent-document-choices');
const signature = { signer_name: 'Paciente Ficticio', accepted_statement: true,
  signature_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=' };
const definition = identity => ({ schema_version: blocks.SCHEMA, blocks: [
  { id: 'intro', type: 'text', html: '<h3><strong>Datos para tu visita</strong></h3><p>{{paciente.nombre_completo}}</p>' },
  ...(identity ? [{ id: 'identity', type: 'patient_data', fields: [...blocks.KEYS] }] : []),
  { id: 'questions', type: 'fields', title: 'Preguntas de prueba', fields: [
    { key: 'commercial', label: '¿Solicitas copia impresa?', type: 'yes_no', required: true },
    { key: 'score', label: 'Valoración', type: 'number', required: true, min: 0, max: 10 },
    { key: 'notes', label: 'Observaciones', type: 'textarea', required: false },
  ] }, { id: 'ending', type: 'text', html: '<p>Fin del documento.</p>' }, { id: 'signature', type: 'signature' },
] });
test('native block builder authoring + ordered immutable signed/completed answers + identity CAS + ACL + no patient grants', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 180000,
}, async () => withIsolatedCampaignMysql(async owned => {
  const f = await createOwnedVisitAuthAclFixture({ ...owned, includeConsentRoutes: true, includePatientIntakeSettingsRoutes: true });
  const { db, ids, request } = f;
  for (const name of ['PatientCustomField', 'PatientConsentExternalAttestation', 'EconomicBudgetSignatureRequest']) {
    db[name] = require(`../../../models/${name.toLowerCase()}`)(owned.sql, S.DataTypes); await db[name].sync();
  }
  const service = require('../../services/consentimientos.service');
  const expect = async (method, route, body, token, status) => {
    const result = await request(method, route, body, token);
    assert.equal(result.status, status, `${method} ${route.replace(/public\/[^/]+/, 'public/[redacted]')}: ${JSON.stringify(result.body)}`);
    return result.body;
  };
  const C = require('../../services/authEmailChallenge.contract');
  const login = async id => {
    const begun = await expect('POST', '/api/auth/sign-in', { email: `owned-${id}@example.invalid`, password: f.password }, null, 202);
    const row = await db.AuthEmailChallenge.findOne({ where: { challenge_hash: C.challengeHash(begun.challengeToken) } });
    return (await expect('POST', '/api/auth/email-code/verify', { challengeToken: begun.challengeToken, code: f.codeFor(row.challenge_id) }, null, 200)).token;
  };
  try {
    const owner = await login(ids.owner), outsider = await login(ids.outsider);
    const marker = { schema_version: completion.SCHEMA, signature_mode: 'none', completion_mode: 'acknowledge' };
    const base = { clinic_id: ids.clinic, name: 'Documento compuesto ficticio', title: 'Información ficticia para tu visita',
      purpose: 'other', status: 'active', version_status: 'published', blocking_policy: 'hard', validity_mode: 'manual',
      requires_patient_signature: false, requires_representative_when_minor: false, requires_professional_signature: false,
      body_html: '<p>Fuente histórica conservada.</p>', body_json: { document_completion: marker, document_blocks: definition(false),
        document_branding: { schema_version: 'cc-document-branding/v1', show_logo: true, show_footer: true } } };
    const beforeInvalid = await db.ClinicConsentTemplate.count();
    const injected = JSON.parse(JSON.stringify(base)); injected.body_json.document_blocks.blocks[0].html = '<script>alert(1)</script>';
    await expect('POST', '/api/consentimientos/clinic/templates', injected, owner, 400);
    assert.equal(await db.ClinicConsentTemplate.count(), beforeInvalid);
    await expect('POST', '/api/consentimientos/clinic/templates', base, outsider, 403);
    const unsigned = await expect('POST', '/api/consentimientos/clinic/templates', base, owner, 201);
    const previous = await db.ClinicConsentTemplateVersion.findOne({ where: { clinic_template_id: unsigned.id } });
    const frozenPrevious = JSON.stringify(previous.toJSON());
    const revised = JSON.parse(JSON.stringify(base.body_json)); revised.document_blocks.blocks.splice(1, 0,
      { id: 'inserted', type: 'text', html: '<p onclick="notAllowed()"><strong>Bloque añadido.</strong></p>' });
    await expect('PUT', '/api/consentimientos/clinic/templates/' + unsigned.id, { body_json: revised }, owner, 200);
    const latest = await db.ClinicConsentTemplateVersion.findOne({ where: { clinic_template_id: unsigned.id }, order: [['version', 'DESC']] });
    assert.equal(latest.version, previous.version + 1); assert(!JSON.stringify(latest.body_json).includes('onclick'));
    assert.equal(JSON.stringify((await previous.reload()).toJSON()), frozenPrevious, 'Editing composes a new version; it never rewrites the earlier version');
    const signed = await expect('POST', '/api/consentimientos/clinic/templates', { ...base, name: 'Identidad y preguntas ficticias',
      requires_patient_signature: true, requires_representative_when_minor: true,
      body_json: { document_blocks: definition(true) } }, owner, 201);
    const clinic = await db.Clinica.findByPk(ids.clinic);
    await clinic.update({ url_avatar: '/uploads/qa-clinic-logo.png', configuracion: { ...clinic.configuracion, patient_intake: { privacy_enabled: false, privacy_before_first_care: true,
      medical_questionnaire_enabled: false, additional_documents: [{ template_id: unsigned.id, required: true, sort_order: 0 },
        { template_id: signed.id, required: true, sort_order: 1 }] } } });
    const patientId = 92891;
    await db.Paciente.create({ id_paciente: patientId, clinica_id: ids.clinic, public_id: 'pac_block_composer_owned', nombre: 'Paciente',
      apellidos: 'Ficticio', numero_historia: String(patientId), historia_scope: `clinic:${ids.clinic}`, acepta_marketing: false });
    await db.PacienteClinica.create({ paciente_id: patientId, clinica_id: ids.clinic, es_principal: true });
    const patientBefore = JSON.stringify((await db.Paciente.findByPk(patientId)).toJSON());
    const pack = await service.createPatientIntakePackage(patientId, { clinicId: ids.clinic, createdBy: ids.owner });
    const session = await service.createTabletSession(pack.package_id), route = '/api/consentimientos/public/' + encodeURIComponent(session.public_token);
    const view = await expect('GET', route, undefined, undefined, 200);
    let signDoc = view.documents.find(doc => doc.completion_mode === 'signature');
    const completeDoc = view.documents.find(doc => doc.completion_mode === 'acknowledge');
    assert(signDoc && completeDoc); assert.equal(completeDoc.document_blocks.schema_version, blocks.SCHEMA);
    assert.equal(completeDoc.document_block_answers, null); assert.equal(signDoc.personal_data_form.fields.length, 12);
    assert(signDoc.document_branding && completeDoc.document_branding);
    assert.equal(completeDoc.document_branding.logos[0].url, 'https://crm.clinicaclick.com/uploads/qa-clinic-logo.png');
    assert(!signDoc.snapshot_html.includes('data-document-branding'), 'Branding is outside the frozen body to avoid duplicate tablet headers');
    const values = { commercial: 'no', score: 0, notes: 'Texto <literal>\nsegunda línea.' };
    const answerPayload = doc => ({ document_ids: [doc.id], document_snapshot_hashes: { [doc.id]: doc.snapshot_hash },
      document_block_answers: { [doc.id]: { snapshot_hash: doc.snapshot_hash, answers: values } } });
    const noAnswers = { acknowledged: true, document_ids: [completeDoc.id], document_snapshot_hashes: { [completeDoc.id]: completeDoc.snapshot_hash } };
    await expect('POST', route + '/complete', noAnswers, undefined, 400);
    await expect('POST', route + '/complete', { acknowledged: true, ...answerPayload(completeDoc),
      document_block_answers: { [completeDoc.id]: { snapshot_hash: '0'.repeat(64), answers: values } } }, undefined, 409);
    const completePayload = { acknowledged: true, ...answerPayload(completeDoc) };
    const eventBefore = await db.ConsentDeliveryEvent.count();
    const donePair = await Promise.all([expect('POST', route + '/complete', completePayload, undefined, 200),
      expect('POST', route + '/complete', completePayload, undefined, 200)]);
    assert.deepEqual(donePair.map(result => result.completed_count).sort(), [0, 1]);
    assert.equal(await db.ConsentDeliveryEvent.count(), eventBefore + 1);
    const done = await db.PatientConsentDocument.findByPk(completeDoc.id);
    assert(completion.isCompleted(done)); assert.equal(done.signed_at, null); assert.equal(done.snapshot_json.signature_evidence, undefined);
    assert.deepEqual(done.snapshot_json.document_block_answers.answers, values);
    assert(done.snapshot_html.includes('Texto &lt;literal&gt;')); assert(done.snapshot_html.includes('<dd>0</dd>'));
    const completeFrozen = JSON.stringify(done.toJSON());
    const changed = JSON.parse(JSON.stringify(completePayload)); changed.document_block_answers[completeDoc.id].answers.commercial = 'yes';
    await expect('POST', route + '/complete', changed, undefined, 409);
    assert.equal(JSON.stringify((await done.reload()).toJSON()), completeFrozen);
    await expect('POST', route + '/sign', { ...signature, ...answerPayload(signDoc) }, undefined, 409);
    const personalValues = { ...signDoc.personal_data_form.values, telefono: '+34 600 000 123', email: 'ficticio@example.invalid' };
    const corrected = await expect('POST', route + '/documents/' + signDoc.id + '/personal-data', {
      schema_version: signDoc.personal_data_form.schema_version, snapshot_hash: signDoc.snapshot_hash, values: personalValues }, undefined, 200);
    const stale = answerPayload(signDoc); signDoc = corrected.documents.find(doc => doc.id === signDoc.id);
    await expect('POST', route + '/sign', { ...signature, ...stale }, undefined, 409);
    const signPayload = { ...signature, ...answerPayload(signDoc) };
    const signedView = await expect('POST', route + '/sign', signPayload, undefined, 200);
    assert.deepEqual(signedView.documents.find(doc => doc.id === signDoc.id).document_block_answers, values);
    const actualSigned = await db.PatientConsentDocument.findByPk(signDoc.id), signedFrozen = JSON.stringify(actualSigned.toJSON());
    assert.equal(actualSigned.snapshot_hash, choices.choiceSnapshotHash(actualSigned.snapshot_json, actualSigned.snapshot_html));
    assert(actualSigned.snapshot_html.indexOf('Datos del paciente') < actualSigned.snapshot_html.indexOf('Preguntas de prueba'));
    assert.equal(actualSigned.snapshot_json.context.paciente.telefono, personalValues.telefono);
    assert.equal(signedView.package.status, 'completed'); assert.equal(signedView.package.signed_count, 1); assert.equal(signedView.package.completed_count, 1);
    await expect('POST', route + '/sign', signPayload, undefined, 409);
    await expect('POST', route + '/documents/' + signDoc.id + '/personal-data', {
      schema_version: signDoc.personal_data_form.schema_version, snapshot_hash: actualSigned.snapshot_hash, values: personalValues }, undefined, 409);
    await clinic.update({ configuracion: { ...clinic.configuracion, document_branding: { show_logo: false } }, nombre_clinica: 'Nombre cambiado tras la firma' });
    const printed = await service.renderConsentDocument(signDoc.id);
    assert(printed.includes('Texto &lt;literal&gt;')); assert(printed.includes('data-document-branding="header"'));
    assert(!printed.includes('Nombre cambiado tras la firma'));
    assert.equal(JSON.stringify((await actualSigned.reload()).toJSON()), signedFrozen);
    assert.equal(JSON.stringify((await done.reload()).toJSON()), completeFrozen);
    assert.equal(JSON.stringify((await db.Paciente.findByPk(patientId)).toJSON()), patientBefore, 'Other identity and all generic questions never edit patient master data, contact or marketing');
    // The new folio is also a real LOPD, not merely a successful signature
    // which the first-care gate would reject/re-request afterwards.
    const registration = require('../../lib/registration-privacy-template'), privacyDraft = registration.bsDraft();
    const privacyDefinition = { schema_version: blocks.SCHEMA, blocks: [
      { id: 'identity', type: 'patient_data', fields: [...blocks.KEYS] }, { id: 'legal', type: 'text', html: privacyDraft.body_html },
      { id: 'decisions', type: 'decisions' }, { id: 'signature', type: 'signature' }] };
    const privacyTemplate = await expect('POST', '/api/consentimientos/clinic/templates', { ...base,
      name: 'LOPD compuesta ficticia', title: privacyDraft.title, purpose: 'data_protection', is_default: true,
      requires_patient_signature: true, requires_representative_when_minor: true,
      body_html: privacyDraft.body_html, body_json: { ...privacyDraft.body_json, document_blocks: privacyDefinition } }, owner, 201);
    const controller = { legal_name: 'Clínica Ficticia QA S.L.', tax_id: 'QA-FICTICIO', address: 'Calle de prueba 1',
      email: 'clinica@example.invalid', phone: '600000999', dpo_name: '', dpo_email: '' };
    await clinic.update({ configuracion: { ...clinic.configuracion, patient_intake: { privacy_enabled: true,
      privacy_template_id: privacyTemplate.id, privacy_controller: controller, privacy_before_first_care: true,
      medical_questionnaire_enabled: false, additional_documents: [] } } });
    const privacyPatient = patientId + 1;
    await db.Paciente.create({ id_paciente: privacyPatient, clinica_id: ids.clinic, public_id: 'pac_block_privacy_owned', nombre: 'Alta',
      apellidos: 'Ficticia', numero_historia: String(privacyPatient), historia_scope: `clinic:${ids.clinic}`, acepta_marketing: false });
    await db.PacienteClinica.create({ paciente_id: privacyPatient, clinica_id: ids.clinic, es_principal: true });
    const appointment = await expect('POST', '/api/citas', f.body({ paciente: { id_paciente: privacyPatient } }), owner, 201);
    await expect('POST', '/api/citas/' + appointment.id_cita + '/care/arrive', { clinic_id: ids.clinic }, owner, 200);
    const blocked = await expect('POST', '/api/citas/' + appointment.id_cita + '/care/start', { clinic_id: ids.clinic }, owner, 409);
    assert.equal(blocked.code, 'appointment_consent_privacy_required');
    const privacyPack = await service.createPatientIntakePackage(privacyPatient, { clinicId: ids.clinic, createdBy: ids.owner, privacyOnly: true });
    const privacySession = await service.createTabletSession(privacyPack.package_id), privacyRoute = '/api/consentimientos/public/' + encodeURIComponent(privacySession.public_token);
    const privacyView = await expect('GET', privacyRoute, undefined, undefined, 200); let privacyDoc = privacyView.documents[0];
    const privacyCorrected = await expect('POST', privacyRoute + '/documents/' + privacyDoc.id + '/personal-data', {
      schema_version: privacyDoc.personal_data_form.schema_version, snapshot_hash: privacyDoc.snapshot_hash,
      values: privacyDoc.personal_data_form.values }, undefined, 200);
    privacyDoc = privacyCorrected.documents[0];
    await expect('POST', privacyRoute + '/sign', { ...signature, document_ids: [privacyDoc.id],
      document_snapshot_hashes: { [privacyDoc.id]: privacyDoc.snapshot_hash }, document_choices: { [privacyDoc.id]: {
      schema_version: privacyDoc.choice_form.schema_version,
      answers: Object.fromEntries(privacyDoc.choice_form.fields.map(field => [field.key, 'no'])) } } }, undefined, 200);
    const privacySaved = await db.PatientConsentDocument.findByPk(privacyDoc.id), frozenPrivacy = JSON.stringify(privacySaved.toJSON());
    assert.equal(require('../../services/appointmentPrivacyEligibility.service').isValidSignedPrivacyDocument({ document: privacySaved,
      template: await db.ClinicConsentTemplate.findByPk(privacyTemplate.id), patientId: privacyPatient, clinicId: ids.clinic,
      approvedVersions: await require('../../services/appointmentPrivacyEligibility.service').approvedPrivacyVersions({ db,
        template: (await db.ClinicConsentTemplate.findByPk(privacyTemplate.id)).toJSON(),
        version: (await db.ClinicConsentTemplateVersion.findOne({ where: { clinic_template_id: privacyTemplate.id } })).toJSON() }), now: new Date() }), true);
    const reordered = JSON.parse(JSON.stringify(privacySaved.snapshot_json.version.body_json));
    [reordered.document_blocks.blocks[0], reordered.document_blocks.blocks[1]] = [reordered.document_blocks.blocks[1], reordered.document_blocks.blocks[0]];
    await expect('PUT', '/api/consentimientos/clinic/templates/' + privacyTemplate.id, { body_html: privacyDraft.body_html, body_json: reordered }, owner, 200);
    const assess = () => db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, transaction =>
      require('../../services/appointmentPrivacyEligibility.service').assessPrivacyBeforeStart({ db,
        appointment: { id_cita: appointment.id_cita, paciente_id: privacyPatient, clinica_id: ids.clinic }, transaction }));
    assert.equal((await assess()).allowed, true, 'A layout-only new version preserves the exact earlier LOPD signature');
    const changedLegal = JSON.parse(JSON.stringify(reordered)); changedLegal.document_blocks.blocks.find(block => block.type === 'text').html = '<p>Cláusula legal distinta.</p>';
    await expect('PUT', '/api/consentimientos/clinic/templates/' + privacyTemplate.id, { body_html: '<p>Cláusula legal distinta.</p>', body_json: changedLegal }, owner, 200);
    assert.equal((await assess()).allowed, false, 'A changed clause does not inherit the old signature');
    const changedChoices = JSON.parse(JSON.stringify(reordered)); changedChoices.consent_form.fields[0].label += ' Condición distinta.';
    await expect('PUT', '/api/consentimientos/clinic/templates/' + privacyTemplate.id, { body_html: privacyDraft.body_html, body_json: changedChoices }, owner, 200);
    assert.equal((await assess()).allowed, false, 'A changed choice does not inherit the old signature');
    await expect('PUT', '/api/consentimientos/clinic/templates/' + privacyTemplate.id, { body_html: privacyDraft.body_html, body_json: reordered }, owner, 200);
    const reusedPrivacy = await service.createPatientIntakePackage(privacyPatient, { clinicId: ids.clinic, createdBy: ids.owner, privacyOnly: true });
    assert.equal(reusedPrivacy.created_count, 0); assert.equal(reusedPrivacy.privacy_signed, true);
    await expect('POST', '/api/citas/' + appointment.id_cita + '/care/start', { clinic_id: ids.clinic }, owner, 200);
    assert.equal(JSON.stringify((await privacySaved.reload()).toJSON()), frozenPrivacy, 'Care/reuse does not rewrite the issued signed folio');
    const phoneOnly = await expect('POST', '/api/consentimientos/clinic/templates', { ...base, name: 'Teléfono ficticio sin apellidos',
      body_json: { document_completion: marker, document_blocks: { schema_version: blocks.SCHEMA, blocks: [
        { id: 'identity', type: 'patient_data', fields: ['telefono'] }, { id: 'text', type: 'text', html: '<p>Datos de contacto del documento.</p>' },
        { id: 'signature', type: 'signature' }] } } }, owner, 201);
    await clinic.update({ configuracion: { ...clinic.configuracion, patient_intake: { privacy_enabled: false,
      medical_questionnaire_enabled: false, additional_documents: [{ template_id: phoneOnly.id, required: true, sort_order: 0 }] } } });
    const phonePatient = patientId + 2;
    await db.Paciente.create({ id_paciente: phonePatient, clinica_id: ids.clinic, public_id: 'pac_block_phone_only_owned', nombre: 'Nombre Completo Histórico',
      apellidos: '', email: 'legacy-invalid-email', numero_historia: String(phonePatient), historia_scope: `clinic:${ids.clinic}` });
    const phonePatientBefore = JSON.stringify((await db.Paciente.findByPk(phonePatient)).toJSON());
    const phonePack = await service.createPatientIntakePackage(phonePatient, { clinicId: ids.clinic, createdBy: ids.owner, additionalTemplateId: phoneOnly.id });
    const phoneSession = await service.createTabletSession(phonePack.package_id), phoneRoute = '/api/consentimientos/public/' + encodeURIComponent(phoneSession.public_token);
    let phoneDoc = (await expect('GET', phoneRoute, undefined, undefined, 200)).documents[0];
    assert.deepEqual(phoneDoc.personal_data_form.fields.map(field => field.key), ['telefono']);
    const phoneData = { ...phoneDoc.personal_data_form.values, telefono: '+34 600 000 777', apellidos: 'Cambio invisible no permitido', email: 'hidden@example.invalid' };
    phoneDoc = (await expect('POST', phoneRoute + '/documents/' + phoneDoc.id + '/personal-data', {
      schema_version: phoneDoc.personal_data_form.schema_version, snapshot_hash: phoneDoc.snapshot_hash, values: phoneData }, undefined, 200)).documents[0];
    assert.equal(phoneDoc.personal_data_form.confirmed, true); assert.equal(phoneDoc.personal_data_form.values.apellidos, '');
    assert.equal(phoneDoc.personal_data_form.values.email, 'legacy-invalid-email');
    await expect('POST', phoneRoute + '/complete', { acknowledged: true, document_ids: [phoneDoc.id],
      document_snapshot_hashes: { [phoneDoc.id]: phoneDoc.snapshot_hash } }, undefined, 200);
    assert(completion.isCompleted(await db.PatientConsentDocument.findByPk(phoneDoc.id)));
    assert.equal(JSON.stringify((await db.Paciente.findByPk(phonePatient)).toJSON()), phonePatientBefore);
    for (const model of ['Message', 'FlowExecutionV2', 'JobRequest']) assert.equal(await db[model].count(), 0);
    assert.equal(f.externalFetchAttempts, 0);
    owned.report.checks.push('Real HTTP authoring ACL, strict block HTML schema/sanitization, ordered new version without rewriting priorversion, 12-field Other identity confirmation CAS, generic all-No/0 answers, concurrent completion idempotence, signed immutable ordered HTML/hash and readback, frozen branding/PDF, mixed counts, no marketing/profile/messages/automation/provider effects');
    owned.report.checks.push('New block LOPD all-No signature remains verified and reusable; real first-care gate 409 before and 200 after, no duplicate issued document and no mutation of signed snapshot');
    owned.report.checks.push('Other phone-only patient_data: legacy empty surname and hidden invalid email do not block completion; hidden edits ignored; exact patient master row remains unchanged');
  } finally { await f.close(); }
}));
