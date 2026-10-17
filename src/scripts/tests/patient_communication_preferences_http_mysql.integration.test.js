'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitAuthAclFixture } = require('./helpers/owned-visit-auth-acl-fixture');
test('native communication preferences enforce real auth/clinic/patient ACL, full-number CAS, independent channel refusal and audited rollback', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 180000,
}, async () => withIsolatedCampaignMysql(async owned => {
  const f = await createOwnedVisitAuthAclFixture({ ...owned, includePatientCommunicationRoutes: true });
  const { db, ids, request } = f;
  const C = require('../../services/authEmailChallenge.contract');
  const login = async id => {
    const challenge = await request('POST', '/api/auth/sign-in', { email: `owned-${id}@example.invalid`, password: f.password });
    assert.equal(challenge.status, 202);
    const row = await db.AuthEmailChallenge.findOne({ where: { challenge_hash: C.challengeHash(challenge.body.challengeToken) } });
    const verified = await request('POST', '/api/auth/email-code/verify', { challengeToken: challenge.body.challengeToken, code: f.codeFor(row.challenge_id) });
    assert.equal(verified.status, 200); return verified.body.token;
  };
  const path = `/api/pacientes/${ids.patient}/communication-preferences`;
  const expect = async (method, route, body, token, status) => { const result = await request(method, route, body, token); assert.equal(result.status, status, JSON.stringify(result.body)); return result.body; };
  try {
    await require('../../../migrations/20261017190000-add-patient-declared-origin-code').up(owned.sql.getQueryInterface(), S);
    const patient = await db.Paciente.findByPk(ids.patient); await patient.update({ telefono_movil: '34000000009', como_nos_conocio: 'recomendación' });
    const reception = await login(ids.reception), outsider = await login(ids.outsider);
    await expect('GET', path + '?clinic_id=100', undefined, undefined, 401);
    await expect('GET', path + '?clinic_id=100', undefined, outsider, 403);
    await expect('GET', `/api/pacientes/${ids.foreignPatient}/communication-preferences?clinic_id=100`, undefined, reception, 403);
    const before = await db.Paciente.findByPk(ids.patient, { raw: true });
    const initial = await expect('GET', path + '?clinic_id=100', undefined, reception, 200);
    assert.equal(initial.whatsapp.state, 'not_recorded'); assert.equal(initial.whatsapp.refused, false);
    assert.equal(initial.platform_origin.state, 'not_recorded'); assert.equal(await db.MarketingContactOptOut.count(), 0);
    const contacts = require('../../services/patientContact.service');
    const startContact = authorizationConfirmed => owned.sql.transaction(transaction => contacts.startPatientWhatsappConversation({
      patientId: ids.patient, clinicId: 100, duplicateScopeClinicIds: [100], actorUserId: ids.reception, authorizationConfirmed, transaction }));
    const noEvidenceStart = await startContact(false);
    assert.equal(noEvidenceStart.conversationCreated, true); assert.equal(noEvidenceStart.authorizationRecorded, false);
    assert.equal(await db.PatientOperationalEvent.count({ where: { event_type: contacts.PATIENT_EVENT_TYPES.whatsappAuthorized } }), 0,
      'No consta remains operationally allowed without creating an authorization event');
    const body = { clinic_id: 100, whatsapp_allowed: false, phone_digits: initial.whatsapp.phone_digits, version: initial.whatsapp.version };
    const denied = await db.AccessPolicyOverride.create({ scope_type: 'clinic', scope_id: 100, feature_key: 'patients.edit', role_code: 'reception', effect: 'deny', updated_by: ids.owner });
    await expect('POST', path, body, reception, 403); await denied.destroy();
    await expect('POST', path, { ...body, phone_digits: '34000000008' }, reception, 409);
    const replies = await Promise.all([request('POST', path, body, reception), request('POST', path, body, reception)]);
    assert.deepEqual(replies.map(row => row.status).sort(), [200, 409]);
    let current = await expect('GET', path + '?clinic_id=100', undefined, reception, 200);
    assert.equal(current.whatsapp.refused, true); assert.equal(await db.MarketingContactOptOut.count(), 1);
    assert.equal(await db.PatientOperationalEvent.count({ where: { event_type: 'patient.whatsapp_preference_changed' } }), 1);
    await db.UsuarioClinica.create({ id_usuario: ids.reception, id_clinica: 200, rol_clinica: 'personaldeclinica', subrol_clinica: 'Recepción / Comercial ventas', estado_invitacion: 'aceptada' });
    await db.PacienteClinica.create({ paciente_id: ids.patient, clinica_id: 200, es_principal: false });
    const unrelated = await expect('GET', path + '?clinic_id=200', undefined, reception, 200);
    assert.equal(unrelated.whatsapp.refused, false, 'Channel refusal is clinic scoped, not a patient-wide legal claim');
    const marketing = await db.MarketingContactOptOut.create({ clinica_id: 100, paciente_id: ids.patient, phone_digits: '34000000009', channel: 'whatsapp', scope: 'marketing', source: 'manual_before_this_task', status: 'active' });
    await expect('POST', path, { ...body, version: current.whatsapp.version, whatsapp_allowed: true }, reception, 200);
    assert.equal((await marketing.reload()).status, 'active', 'Allowing WhatsApp never removes commercial/import/manual restrictions');
    current = await expect('GET', path + '?clinic_id=100', undefined, reception, 200); assert.equal(current.whatsapp.state, 'allowed');
    const createEvent = db.PatientOperationalEvent.create;
    db.PatientOperationalEvent.create = async function(values, options) { if (values.event_type === 'patient.whatsapp_preference_changed') throw Error('OWNED_AUDIT_FAILURE'); return createEvent.call(this, values, options); };
    try { await expect('POST', path, { ...body, version: current.whatsapp.version }, reception, 500); }
    finally { db.PatientOperationalEvent.create = createEvent; }
    assert.equal((await expect('GET', path + '?clinic_id=100', undefined, reception, 200)).whatsapp.refused, false, 'Failure to audit rolls back the refusal');
    const stale = current.whatsapp;
    await patient.update({ telefono_movil: '34000000008' });
    await expect('POST', path, { ...body, version: stale.version }, reception, 409);
    assert.equal((await expect('GET', path + '?clinic_id=100', undefined, reception, 200)).whatsapp.refused, false, 'An old full-number refusal does not attach to a changed mobile');
    await patient.update({ telefono_movil: before.telefono_movil });
    assert.equal((await patient.reload()).como_nos_conocio, 'recomendación'); assert.equal(patient.como_nos_conocio_codigo, null, 'No invented migration of ambiguous legacy declaration');

    // Native source/version, immutable rendered snapshot, choice hash and actual
    // SQL evidence lookup: a manual checkbox cannot erase a signed channel No.
    const registration = require('../../lib/registration-privacy-template'), choices = require('../../lib/consent-document-choices');
    const source = registration.standardDraft();
    const template = await db.ClinicConsentTemplate.create({ public_id: 'owned_channel_lopd', clinic_id: 100,
      name: 'OWNED fictitious privacy notice', purpose: 'data_protection', status: 'active' });
    const version = await db.ClinicConsentTemplateVersion.create({ clinic_template_id: template.id, locale: 'es',
      status: 'published', ...source });
    const signedDocument = async (answer, signedAt, publicId) => {
      const evidence = { schema_version: source.body_json.consent_form.schema_version,
        answers: { health_nonmedical: 'no', commercial: 'yes', financing: 'no', sms_whatsapp: answer } };
      const snapshot = { template: { id: template.id, clinic_id: 100 },
        version: { id: version.id, body_html: version.body_html, body_json: version.body_json },
        context: { paciente: { id: ids.patient, telefono: '34000000009', nombre_completo: 'OWNED fictitious patient' },
          clinica: { id: 100 }, responsable: { razon_social: 'OWNED fictitious controller', cif: 'QA-NOT-REAL' } },
        integrity: { algorithm: choices.CHOICE_HASH_ALGORITHM },
        signature_evidence: { accepted_statement: true, signed_at: signedAt, consent_choices: evidence } };
      const document = { public_id: publicId, paciente_id: ids.patient, clinica_id: 100, clinic_template_id: template.id,
        clinic_template_version_id: version.id, purpose: 'data_protection', status: 'signed', signed_at: signedAt,
        title: source.title, snapshot_json: snapshot };
      document.snapshot_html = choices.appendSignedChoiceHtml(registration.render(version, snapshot.context), document, evidence);
      document.snapshot_hash = choices.choiceSnapshotHash(snapshot, document.snapshot_html);
      return db.PatientConsentDocument.create(document);
    };
    const signedNo = await signedDocument('no', new Date(Date.now() - 2000).toISOString(), 'owned_channel_no');
    const frozenNo = structuredClone(signedNo.snapshot_json), frozenHtml = signedNo.snapshot_html, frozenHash = signedNo.snapshot_hash;
    current = await expect('GET', path + '?clinic_id=100', undefined, reception, 200);
    assert.equal(current.whatsapp.refused, true); assert.equal(current.whatsapp.source, 'signed_privacy_document'); assert.equal(current.whatsapp.can_clear, false);
    await expect('POST', path, { ...body, version: current.whatsapp.version, whatsapp_allowed: true }, reception, 409);
    const whatsApp = require('../../services/whatsapp.service'), optOut = require('../../services/marketingOptOut.service');
    await assert.rejects(whatsApp.assertRecipientCanReceive({ to: '34000000009', clinicConfig: { clinicId: 100 } }), error => error.code === 'WHATSAPP_CHANNEL_REFUSED');
    const targetBefore = (await contacts.findPatientContactTargets({ query: String(ids.patient), clinicIds: [100], selectedClinicId: 100 })).items[0];
    assert.equal(targetBefore.whatsapp_contact_blocked, true); assert.equal(targetBefore.whatsapp_contact_authorized, false);
    const chatCountBeforeRefusedStart = await db.Conversation.count();
    await assert.rejects(startContact(false), error => error.code === 'WHATSAPP_CHANNEL_REFUSED');
    assert.equal(await db.Conversation.count(), chatCountBeforeRefusedStart, 'An explicit refusal is checked before creating another chat');
    const cards = await optOut.getActiveContactRestrictionsForConversations([
      { id: 90001, clinic_id: 100, patient_id: ids.patient, contact_id: '34000000009' },
      { id: 90002, clinic_id: 100, patient_id: ids.patient, contact_id: '34000000008' },
      { id: 90003, clinic_id: 200, patient_id: ids.patient, contact_id: '34000000009' },
    ]);
    assert.equal(cards.get(90001).whatsapp_channel_opt_out, true);
    assert.equal(cards.get(90002).whatsapp_channel_opt_out, false); assert.equal(cards.get(90003).whatsapp_channel_opt_out, false);
    await signedDocument('yes', new Date(Date.now() - 1000).toISOString(), 'owned_channel_yes');
    await whatsApp.assertRecipientCanReceive({ to: '34000000009', clinicConfig: { clinicId: 100 } });
    assert.equal((await expect('GET', path + '?clinic_id=100', undefined, reception, 200)).whatsapp.refused, false, 'A newer verified signed Yes can supersede signed No for this same full number');
    const started = await startContact(false);
    assert.equal(started.authorizationRecorded, false); assert.equal(started.conversationCreated, false);
    assert.equal(await db.PatientOperationalEvent.count({ where: { event_type: contacts.PATIENT_EVENT_TYPES.whatsappAuthorized } }), 0, 'An allowed operational start does not invent consent evidence');
    const targetAfter = (await contacts.findPatientContactTargets({ query: String(ids.patient), clinicIds: [100], selectedClinicId: 100 })).items[0];
    assert.equal(targetAfter.whatsapp_contact_allowed_default, true); assert.equal(targetAfter.whatsapp_contact_blocked, false); assert.equal(targetAfter.whatsapp_contact_authorized, false);
    assert.equal((await startContact(true)).authorizationRecorded, true, 'Only an explicit legacy attestation writes its distinct authorization event');
    assert.equal(await db.PatientOperationalEvent.count({ where: { event_type: contacts.PATIENT_EVENT_TYPES.whatsappAuthorized } }), 1);
    assert.deepEqual((await signedNo.reload()).snapshot_json, frozenNo); assert.equal(signedNo.snapshot_html, frozenHtml); assert.equal(signedNo.snapshot_hash, frozenHash);
    assert.equal(await db.Message.count(), 0); assert.equal(await db.FlowExecutionV2.count(), 0); assert.equal(await db.JobRequest.count(), 0);
    owned.report.checks.push('Real JWT/MFA/native ACL; read-only No consta; clinic/full-number CAS; one winner under concurrency; precise refusal lifecycle; marketing/manual legacy holds retained; audit failure rollback; mobile change invalidates stale request; native signed v2 No blocks final transport and QuickChat only for its clinic/full number; manual allow cannot erase signed No; newer verified signed Yes supersedes signed No without modifying evidence; starting a No consta chat creates no invented consent event and explicit refusal is checked before chat creation; only an explicit attestation records an authorization; no messages/jobs/executions');
    owned.report.requests = f.requests; owned.report.externalFetchAttempts = f.externalFetchAttempts;
  } finally { await f.close(); }
}));
