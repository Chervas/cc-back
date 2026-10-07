'use strict';

// Real managed employee auth/ACL plus clinic-tablet JWT and consent routes.
// The launcher's freshly owned MySQL/socket and loopback server are the only
// allowed connections. Synthetic clinical text/signatures, no actual patient,
// email delivery, provider, worker, migration of a tenant or medical approval.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitAuthAclFixture } = require('./helpers/owned-visit-auth-acl-fixture');

withIsolatedCampaignMysql(async owned => {
  const { report } = owned;
  const f = await createOwnedVisitAuthAclFixture({ ...owned, includeConsentRoutes: true });
  const { db, ids, request, fingerprint } = f;
  const C = require('../../services/authEmailChallenge.contract');
  const sourceFiles = ['routes/auth.routes', 'routes/auth.middleware', 'lib/access-policy',
    'services/authEmailChallenge.service', 'services/accessSession.service',
    'routes/consentimientos.routes', 'controllers/consentimientos.controller', 'services/consentimientos.service',
    'routes/citas.routes', 'controllers/citas.controller', 'services/appointmentCare.service',
    'services/appointmentConsentEligibility.service', 'services/treatmentDocumentation.service'];
  report.proof = { auth: f.boundaries.auth, acl: f.boundaries.acl, email: f.boundaries.email,
    clinicalText: 'Fictitious explicitly published test versions, no clinical instructions or live approval',
    rollout: 'Closed managed communication registry/flags; no future managed birth, provider, worker or browser proof',
    fixtureHashes: Object.fromEntries([__filename, require.resolve('./helpers/owned-visit-auth-acl-fixture')]
      .map(file => [file, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')])),
    sourceHashes: Object.fromEntries(sourceFiles.map(file => [file, crypto.createHash('sha256')
      .update(fs.readFileSync(require.resolve('../../' + file))).digest('hex')])) };
  const signIn = async id => {
    const challenge = await request('POST', '/api/auth/sign-in', { email: 'owned-' + id + '@example.invalid', password: f.password });
    assert.equal(challenge.status, 202, JSON.stringify(challenge));
    const row = await db.AuthEmailChallenge.findOne({ where: { challenge_hash: C.challengeHash(challenge.body.challengeToken) } });
    const verified = await request('POST', '/api/auth/email-code/verify', {
      challengeToken: challenge.body.challengeToken, code: f.codeFor(row.challenge_id) });
    assert.equal(verified.status, 200, JSON.stringify(verified));
    return verified.body.token;
  };
  const deniedUnchanged = async (method, url, body, token, status, reason) => {
    const before = await fingerprint(), result = await request(method, url, body, token);
    assert.equal(result.status, status, reason + ': ' + JSON.stringify(result.body));
    assert.deepEqual(await fingerprint(), before, reason + ': no domain mutation');
    return result;
  };
  const png = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  const signature = ids => ({ document_ids: ids, accepted_statement: true, signer_name: 'OWNED fictitious adult',
    signer_role: 'patient', signature_data_url: png, method: 'tablet_signature', device_label: 'OWNED isolated tablet' });
  // The care HTTP contract returns code/message, not a blocking count. Read the
  // real SQL eligibility assessor independently; do not invent response fields.
  const clinicalConsent = appointmentId => db.sequelize.transaction(async transaction =>
    require('../../services/appointmentConsentEligibility.service').assessAppointmentClinicalConsent({ db,
      appointment: await db.CitaPaciente.findByPk(appointmentId, { transaction }), transaction }));
  try {
    // Separate human sign-in sessions. This circuit does not certify concurrent
    // first email challenges; the initial four-way setup returned503 and its
    // failed OWNED report is retained for a separate auth-concurrency audit.
    const assistant = await signIn(ids.assistant), reception = await signIn(ids.reception);
    const owner = await signIn(ids.owner), outsider = await signIn(ids.outsider);
    assert.equal(await db.Usuario.count({ where: { id_usuario: [1, 44] } }), 0);
    const templates = [];
    for (const needsProfessional of [true, false]) {
      const created = await request('POST', '/api/consentimientos/clinic/templates', { clinic_id: ids.clinic,
        name: 'OWNED fictitious required consent ' + templates.length, purpose: 'clinical', validity_mode: 'single_act',
        blocking_policy: 'hard', requires_patient_signature: true, requires_professional_signature: needsProfessional,
        locale: 'es', version_status: 'published', body_html: '<p>OWNED test document, not clinical instructions.</p>' }, owner);
      assert.equal(created.status, 201, JSON.stringify(created));
      templates.push(created.body);
      assert.equal(created.body.versions[0].status, 'published');
    }
    const requirements = await request('PUT', '/api/consentimientos/treatments/' + ids.treatment + '/requirements', {
      clinic_id: ids.clinic, requirements: templates.map(template => ({ clinic_template_id: template.id,
        required: true, blocking_policy: 'hard' })) }, owner);
    assert.equal(requirements.status, 200, JSON.stringify(requirements));
    assert.equal(await db.TreatmentConsentRequirement.count({ where: { tratamiento_id: ids.treatment, required: true, blocking_policy: 'hard' } }), 2);
    const protocol = await request('POST', '/api/treatment-documentation/protocols', { clinic_id: ids.clinic,
      title: 'OWNED fictitious approved protocol', kind: 'protocol', status: 'approved',
      source: 'OWNED synthetic test source; no live clinical approval',
      content: 'OWNED synthetic text; not clinical instructions.', treatment_ids: [ids.treatment] }, owner);
    assert.equal(protocol.status, 201, JSON.stringify(protocol));
    report.checks.push('Actual owner bcrypt/MFA/session authoring routes create two hard clinical requirements with Spanish published versions and one synthetic approved protocol; non-global employee tokens are native');

    const created = await request('POST', '/api/citas', f.body(), assistant);
    assert.equal(created.status, 201, JSON.stringify(created));
    const appointmentId = created.body.id_cita;
    const arrived = await request('POST', '/api/citas/' + appointmentId + '/care/arrive', { clinic_id: ids.clinic }, reception);
    assert.equal(arrived.status, 200, JSON.stringify(arrived));
    const blocked = await deniedUnchanged('POST', '/api/citas/' + appointmentId + '/care/start', { clinic_id: ids.clinic }, assistant, 409,
      'Arrival alone does not authorize care without the required clinical signatures');
    assert.equal(blocked.body.code, 'appointment_consent_required');
    assert.equal((await clinicalConsent(appointmentId)).blocking_count, 2);
    const packaged = await request('POST', '/api/consentimientos/appointments/' + appointmentId + '/package', {}, reception);
    assert.equal(packaged.status, 201, JSON.stringify(packaged));
    const pkg = packaged.body, documents = pkg.documents;
    assert.equal(documents.length, 2); assert.equal(pkg.required_count, 2);
    for (const doc of documents) {
      assert.equal(doc.cita_id, appointmentId); assert.equal(doc.paciente_id, ids.patient);
      assert.equal(doc.clinica_id, ids.clinic); assert.equal(doc.snapshot_json.template.purpose, 'clinical');
    }
    await deniedUnchanged('POST', '/api/consentimientos/packages/' + pkg.id + '/tablet-session', {}, outsider, 403,
      'Foreign-clinic employee cannot issue a patient consent token');
    report.checks.push('Actual booking/arrival/care require both hard signatures:HTTP409 code/message and independent native SQL eligibility count2, no state/event writes; native reception prepares exact appointment/patient/clinic package, foreign membership cannot issue public rights');

    const kioskResult = await request('POST', '/api/consentimientos/clinic/' + ids.clinic + '/tablet-kiosk',
      { display_name: 'OWNED synthetic reception tablet', username: 'owned-reception-tablet' }, owner);
    assert.equal(kioskResult.status, 201, JSON.stringify(kioskResult));
    const kiosk = kioskResult.body.kiosk;
    assert.equal(typeof kiosk.one_time_password, 'string');
    assert(kiosk.one_time_password.length > 0);
    const tabletLogin = await request('POST', '/api/consentimientos/tablet/login', { username: kiosk.username, password: kiosk.one_time_password });
    assert.equal(tabletLogin.status, 200, JSON.stringify(tabletLogin));
    const tabletToken = tabletLogin.body.token;
    await deniedUnchanged('POST', '/api/citas', f.body(), tabletToken, 401, 'Consent-kiosk JWT is not an employee access session');
    await deniedUnchanged('POST', '/api/consentimientos/tablet/packages/' + pkg.id + '/session', {}, assistant, 401,
      'Employee JWT is not a clinic-tablet token');
    const foreignPassword = 'OWNED_PRIVATE_FOREIGN_TABLET_ONLY';
    await db.ClinicTabletKiosk.create({ public_id: 'owned-foreign-tablet', clinic_id: ids.peerClinic,
      username: 'owned-foreign-tablet', password_hash: await bcrypt.hash(foreignPassword, 4), status: 'active' });
    const foreignLogin = await request('POST', '/api/consentimientos/tablet/login', { username: 'owned-foreign-tablet', password: foreignPassword });
    assert.equal(foreignLogin.status, 200, JSON.stringify(foreignLogin));
    await deniedUnchanged('POST', '/api/consentimientos/tablet/packages/' + pkg.id + '/session', {}, foreignLogin.body.token, 403,
      'Foreign kiosk scope cannot issue a patient token for another clinic');
    const tabletSession = await request('POST', '/api/consentimientos/tablet/packages/' + pkg.id + '/session',
      { base_url: 'https://owned-tablet.invalid' }, tabletToken);
    assert.equal(tabletSession.status, 200, JSON.stringify(tabletSession));
    const publicToken = tabletSession.body.public_token;
    assert(publicToken); assert.equal(await db.Message.count(), 0); assert.equal(await db.JobRequest.count(), 0);
    report.checks.push('Actual native kiosk bcrypt/login JWT plus current clinic scope issues the local patient package token; employee/kiosk tokens cannot be interchanged and foreign kiosk cannot cross clinics; no message, email, job or transport');

    await deniedUnchanged('POST', '/api/consentimientos/public/' + publicToken + '/sign', { accepted_statement: true }, undefined, 400,
      'Drawn signature evidence is required and missing evidence creates no signature/count/event');
    const firstSign = await request('POST', '/api/consentimientos/public/' + publicToken + '/sign', signature([documents[0].id]));
    assert.equal(firstSign.status, 200, JSON.stringify(firstSign)); assert.equal(firstSign.body.signed_count, 1);
    const stillBlocked = await deniedUnchanged('POST', '/api/citas/' + appointmentId + '/care/start', { clinic_id: ids.clinic }, assistant, 409,
      'One patient signature cannot cover another pending document or required countersignature');
    assert.equal(stillBlocked.body.code, 'appointment_consent_required');
    const secondSign = await request('POST', '/api/consentimientos/public/' + publicToken + '/sign', signature([documents[1].id]));
    assert.equal(secondSign.status, 200, JSON.stringify(secondSign));
    const professionalDocument = await db.PatientConsentDocument.findOne({ where: { package_id: pkg.id, clinic_template_id: templates[0].id } });
    const signedState = (await db.PatientConsentDocument.findAll({ where: { package_id: pkg.id }, raw: true }));
    const needsProfessional = await deniedUnchanged('POST', '/api/citas/' + appointmentId + '/care/start', { clinic_id: ids.clinic }, assistant, 409,
      'Both patient signatures still require the configured professional countersignature');
    assert.equal(needsProfessional.body.code, 'appointment_consent_required');
    assert.equal((await clinicalConsent(appointmentId)).blocking_count, 1);
    await deniedUnchanged('POST', '/api/consentimientos/documents/' + professionalDocument.id + '/sign-professional',
      { accepted_statement: true }, reception, 403, 'Reception cannot forge clinical professional countersignature');
    const countersigned = await request('POST', '/api/consentimientos/documents/' + professionalDocument.id + '/sign-professional',
      { accepted_statement: true, professional_signed_by: 1 }, assistant);
    assert.equal(countersigned.status, 200, JSON.stringify(countersigned));
    assert.equal((await professionalDocument.reload()).professional_signed_by, ids.assistant);
    report.checks.push('Actual public tablet sign routes validate drawn evidence, selected documents and hard countersignature gate; reception denied clinical signing; assistant attribution comes from authenticated session, not forged actor1');

    const started = await request('POST', '/api/citas/' + appointmentId + '/care/start', { clinic_id: ids.clinic }, assistant);
    assert.equal(started.status, 200, JSON.stringify(started));
    assert.equal((await db.CitaPaciente.findByPk(appointmentId)).care_started_by, ids.assistant);
    const careEvent = await db.PatientOperationalEvent.findOne({ where: { event_type: 'appointment_care_changed',
      metadata: { appointment_id: appointmentId, action: 'start' } }, raw: true });
    assert.deepEqual(careEvent.metadata.documentation_snapshot.revisions.map(ref => [ref.id, ref.version]), [[protocol.body.item.id, 1]]);
    const beforeRepeat = await fingerprint();
    assert.equal((await request('POST', '/api/citas/' + appointmentId + '/care/start', { clinic_id: ids.clinic }, assistant)).status, 200);
    assert.deepEqual(await fingerprint(), beforeRepeat);
    const changedTemplate = await request('PUT', '/api/consentimientos/clinic/templates/' + templates[0].id,
      { name: 'OWNED later template', body_html: '<p>OWNED later content, not clinical instructions.</p>', version_status: 'published' }, owner);
    assert.equal(changedTemplate.status, 200, JSON.stringify(changedTemplate));
    for (const doc of signedState) {
      const actual = await db.PatientConsentDocument.findByPk(doc.id);
      assert.equal(typeof doc.snapshot_html, 'string');
      assert(doc.snapshot_html.includes('OWNED test document'));
      assert.equal(actual.snapshot_html, doc.snapshot_html);
      assert.deepEqual(actual.snapshot_json.version, doc.snapshot_json.version);
      assert.deepEqual(actual.snapshot_json.template, doc.snapshot_json.template);
      assert.equal(actual.signed_at.getTime(), doc.signed_at.getTime());
      assert.equal(actual.status, 'signed');
    }
    const revoked = await request('POST', '/api/consentimientos/documents/' + documents[1].id + '/revoke',
      { reason: 'OWNED synthetic revocation after start' }, assistant);
    assert.equal(revoked.status, 200, JSON.stringify(revoked));
    const completionBlocked = await deniedUnchanged('PATCH', '/api/citas/' + appointmentId + '/estado', { estado: 'completada' }, assistant, 409,
      'Revoked required document cannot authorize completion or rewrite frozen start/signature history');
    assert.equal(completionBlocked.body.code, 'appointment_consent_required');
    report.checks.push('All actual consent evidence enables authenticated care start with approved immutable protocolv1; replay adds nothing, later template edit preserves signed content/evidence; native revocation denies completion without rewriting start history');
    report.proof.positive = { appointmentId, employeeId: ids.assistant, receptionId: ids.reception,
      hardRequiredDocuments: documents.length, signatureEvents: await db.ConsentDeliveryEvent.count({ where: { package_id: pkg.id } }),
      providerRequests: 0, fetchAttempts: f.externalFetchAttempts, httpRequests: f.requests,
      messages: await db.Message.count(), jobs: await db.JobRequest.count(), executions: await db.FlowExecutionV2.count(),
      visitCommunications: await db.AppointmentVisitCommunication.count(), externalRejected: report.rejected };
    assert.equal(f.externalFetchAttempts, 0); assert.equal(await db.Message.count(), 0);
    assert.equal(await db.JobRequest.count(), 0); assert.equal(await db.FlowExecutionV2.count(), 0);
  } finally { await f.close(); }
}).catch(error => { console.error(error); process.exitCode = 1; });
