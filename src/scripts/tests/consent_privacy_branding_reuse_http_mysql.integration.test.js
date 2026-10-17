'use strict';
// Diagnostics for the published version. Only this launcher's new, owned SQL
// is changed; no production DB, browser, provider or real credentials are used.
const test = require('node:test'), assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const S = require('sequelize'), jwt = require('jsonwebtoken');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitAuthAclFixture } = require('./helpers/owned-visit-auth-acl-fixture');
const choices = require('../../lib/consent-document-choices'), blocks = require('../../lib/consent-document-blocks');
const registration = require('../../lib/registration-privacy-template');
const signature = { signer_name: 'Paciente Ficticio', accepted_statement: true,
  signature_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=' };

test('published BS privacy: new branding/gate, immutable legacy pending reuse and exact kiosk clinic/group boundary', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 180000,
}, async () => withIsolatedCampaignMysql(async owned => {
  const f = await createOwnedVisitAuthAclFixture({ ...owned, includeConsentRoutes: true, includePatientIntakeSettingsRoutes: true });
  const { db, ids, request } = f, service = require('../../services/consentimientos.service');
  for (const name of ['PatientCustomField', 'PatientConsentExternalAttestation', 'EconomicBudgetSignatureRequest']) {
    db[name] = require(`../../../models/${name.toLowerCase()}`)(owned.sql, S.DataTypes); await db[name].sync();
  }
  const expect = async (method, route, body, token, status) => {
    const response = await request(method, route, body, token);
    assert.equal(response.status, status, `${method} ${route.replace(/public\/[^/]+/, 'public/[redacted]')}: ${JSON.stringify(response.body)}`);
    return response.body;
  };
  const C = require('../../services/authEmailChallenge.contract');
  const login = async id => {
    const begun = await expect('POST', '/api/auth/sign-in', { email: `owned-${id}@example.invalid`, password: f.password }, null, 202);
    const row = await db.AuthEmailChallenge.findOne({ where: { challenge_hash: C.challengeHash(begun.challengeToken) } });
    return (await expect('POST', '/api/auth/email-code/verify', { challengeToken: begun.challengeToken, code: f.codeFor(row.challenge_id) }, null, 200)).token;
  };
  const contexts = new Map();
  try {
    await db.GrupoClinica.create({ id_grupo: 60, nombre: 'BS ficticias de prueba aislada' });
    for (const clinicId of [66, 72]) {
      await db.Clinica.create({ id_clinica: clinicId, grupoClinicaId: 60, nombre_clinica: `BS ${clinicId === 72 ? 'Medical' : 'Capilar'} · Ficticia QA`,
        configuracion: { patient_intake: { privacy_enabled: true, privacy_before_first_care: true, medical_questionnaire_enabled: false,
          additional_documents: [], privacy_controller: { legal_name: 'Responsable ficticio QA S.L.', tax_id: 'QA-NOT-A-REAL-CIF',
            address: 'Calle Ficticia 1', email: 'clinica@example.invalid', phone: '600000000', dpo_email: 'dpo@example.invalid' } } } });
      await db.UsuarioClinica.create({ id_usuario: ids.owner, id_clinica: clinicId, rol_clinica: 'propietario' });
    }
    const owner = await login(ids.owner), outsider = await login(ids.outsider);
    for (const clinicId of [66, 72]) {
      const draft = registration.bsDraft();
      const model = await expect('POST', '/api/consentimientos/clinic/templates', { clinic_id: clinicId,
        name: 'LOPD ficticia de prueba de presentación', title: draft.title, purpose: 'data_protection', status: 'active', version_status: 'published',
        is_default: true, blocking_policy: 'hard', validity_mode: 'manual', requires_patient_signature: true,
        requires_representative_when_minor: true, requires_professional_signature: false,
        body_html: draft.body_html, body_json: draft.body_json }, owner, 201);
      const clinic = await db.Clinica.findByPk(clinicId);
      await clinic.update({ configuracion: { ...clinic.configuracion, patient_intake: { ...clinic.configuracion.patient_intake,
        privacy_template_id: model.id } } });
      const patientId = 92900 + clinicId;
      await db.Paciente.create({ id_paciente: patientId, clinica_id: clinicId, public_id: 'pac_branding_owned_' + clinicId,
        nombre: 'Paciente', apellidos: 'Ficticio ' + clinicId, numero_historia: String(patientId), historia_scope: `clinic:${clinicId}` });
      await db.PacienteClinica.create({ paciente_id: patientId, clinica_id: clinicId, es_principal: true });
      const appointment = await db.CitaPaciente.create({ paciente_id: patientId, clinica_id: clinicId, doctor_id: ids.doctorOne,
        inicio: new Date(Date.now() - 60000), fin: new Date(Date.now() + 1200000), estado: 'info_confirmada', es_provisional: false });
      await expect('POST', '/api/citas/' + appointment.id_cita + '/care/arrive', { clinic_id: clinicId }, owner, 200);
      const before = await expect('POST', '/api/citas/' + appointment.id_cita + '/care/start', { clinic_id: clinicId }, owner, 409);
      assert.equal(before.code, 'appointment_consent_privacy_required');
      await expect('POST', '/api/consentimientos/patients/' + patientId + '/intake-package', {}, outsider, 403);
      const prepared = await expect('POST', '/api/consentimientos/patients/' + patientId + '/intake-package', { clinic_id: clinicId === 72 ? 66 : 72 }, owner, 201);
      const pending = await db.PatientConsentDocument.findOne({ where: { package_id: prepared.package_id } });
      // Exact synthetic reconstruction of an issued pre-branding document:
      // remove only the later presentation DTO, preserving body and ownership.
      const snapshot = JSON.parse(JSON.stringify(pending.snapshot_json)); delete snapshot.document_branding;
      await pending.update({ snapshot_json: snapshot, snapshot_hash: choices.choiceSnapshotHash(snapshot, pending.snapshot_html) });
      await pending.reload(); // Compare the persisted SQL date precision/key order.
      const frozenOld = JSON.stringify(pending.toJSON());
      const retry = await expect('POST', '/api/consentimientos/patients/' + patientId + '/intake-package', {}, owner, 200);
      assert.equal(retry.created_count, 0); assert.deepEqual(retry.current_package_ids, [prepared.package_id]);
      assert.equal(JSON.stringify((await pending.reload()).toJSON()), frozenOld);
      const oldSession = await service.createTabletSession(prepared.package_id), oldRoute = '/api/consentimientos/public/' + encodeURIComponent(oldSession.public_token);
      const oldView = await expect('GET', oldRoute, undefined, undefined, 200);
      assert.equal(oldView.documents[0].document_branding, null, 'Re-request reuses an immutable earlier unbranded pending document');
      assert.equal(oldView.documents[0].personal_data_form.fields.length, 12);
      const prior = JSON.stringify((await pending.reload()).toJSON());
      const body = { ...draft.body_json, document_blocks: { schema_version: blocks.SCHEMA, blocks: [
        { id: 'identity', type: 'patient_data', fields: [...blocks.KEYS] }, { id: 'legal', type: 'text', html: draft.body_html },
        { id: 'choices', type: 'decisions' }, { id: 'signature', type: 'signature' }] } };
      await expect('PUT', '/api/consentimientos/clinic/templates/' + model.id, { body_html: draft.body_html, body_json: body }, owner, 200);
      const fresh = await expect('POST', '/api/consentimientos/patients/' + patientId + '/intake-package', {}, owner, 201);
      assert.notEqual(fresh.package_id, prepared.package_id);
      const session = await service.createTabletSession(fresh.package_id), route = '/api/consentimientos/public/' + encodeURIComponent(session.public_token);
      let doc = (await expect('GET', route, undefined, undefined, 200)).documents[0];
      assert.equal(doc.document_branding.logos.length, 2); assert.deepEqual(doc.document_branding.logos.map(logo => logo.alt), ['BS Medical', 'BS Capilar']);
      assert(doc.document_branding.footer_lines.some(line => line.includes('Responsable ficticio QA')));
      assert(doc.document_branding.footer_lines.includes('Calle Ficticia 1'));
      assert.equal(doc.document_blocks.blocks[0].type, 'patient_data');
      assert.equal(JSON.stringify((await pending.reload()).toJSON()), prior, 'New explicit version does not rewrite/supersede the earlier pending package');
      assert.equal(pending.status, 'viewed', 'Both pending attempts remain active after version replacement: diagnostic, not a fix');
      contexts.set(clinicId, { clinic, model, patientId, appointment, pending, oldSession, oldRoute, fresh, session, route, doc });
    }
    // Native kiosk scope: access to the same corporate group is NOT granted
    // until explicitly configured, and revocation applies to existing tokens.
    const access = await expect('POST', '/api/consentimientos/clinic/72/tablet-kiosk', { display_name: 'Tablet ficticia QA' }, owner, 201);
    const kioskLogin = await expect('POST', '/api/consentimientos/tablet/login', { username: access.kiosk.username, password: access.kiosk.one_time_password }, null, 200);
    const kioskToken = kioskLogin.token, kioskId = access.kiosk.id;
    await expect('POST', '/api/consentimientos/tablet/packages/' + contexts.get(72).fresh.package_id + '/session', {}, kioskToken, 200);
    await expect('POST', '/api/consentimientos/tablet/packages/' + contexts.get(66).fresh.package_id + '/session', {}, kioskToken, 403);
    await expect('PATCH', '/api/consentimientos/clinic/72/tablet-kiosk/' + kioskId + '/scope', { include_group_consents: true }, owner, 200);
    await expect('POST', '/api/consentimientos/tablet/packages/' + contexts.get(66).fresh.package_id + '/session', {}, kioskToken, 200);
    await expect('PATCH', '/api/consentimientos/clinic/72/tablet-kiosk/' + kioskId + '/scope', { include_group_consents: false }, owner, 200);
    await expect('POST', '/api/consentimientos/tablet/packages/' + contexts.get(66).fresh.package_id + '/session', {}, kioskToken, 403);
    const wrongRealm = jwt.sign({ ...jwt.decode(kioskToken) }, randomBytes(32));
    await expect('GET', '/api/consentimientos/tablet/session', undefined, wrongRealm, 401);
    for (const c of contexts.values()) {
      c.doc = (await expect('POST', c.route + '/documents/' + c.doc.id + '/personal-data', { schema_version: c.doc.personal_data_form.schema_version,
        snapshot_hash: c.doc.snapshot_hash, values: c.doc.personal_data_form.values }, undefined, 200)).documents[0];
      const signed = await expect('POST', c.route + '/sign', { ...signature, document_ids: [c.doc.id], document_snapshot_hashes: { [c.doc.id]: c.doc.snapshot_hash },
        document_choices: { [c.doc.id]: { schema_version: c.doc.choice_form.schema_version,
          answers: Object.fromEntries(c.doc.choice_form.fields.map(field => [field.key, 'no'])) } } }, undefined, 200);
      assert.equal(signed.documents[0].document_branding.logos.length, 2);
      const frozen = JSON.stringify((await db.PatientConsentDocument.findByPk(c.doc.id)).toJSON());
      await expect('POST', '/api/citas/' + c.appointment.id_cita + '/care/start', { clinic_id: c.clinic.id_clinica }, owner, 200);
      assert.equal(JSON.stringify((await db.PatientConsentDocument.findByPk(c.doc.id)).toJSON()), frozen);
      const printed = await service.renderConsentDocument(c.doc.id);
      assert(printed.includes('data-document-branding="header"')); assert(printed.includes('data-document-branding="footer"'));
      assert(printed.includes('BS Medical') && printed.includes('BS Capilar'));
      const oldStillPending = await db.PatientConsentDocument.findByPk(c.pending.id);
      assert.equal(oldStillPending.status, 'superseded', 'Signing the newer reusable LOPD supersedes the older pending attempt');
      assert.equal(oldStillPending.snapshot_hash, c.pending.snapshot_hash);
      assert.equal(oldStillPending.snapshot_html, c.pending.snapshot_html);
    }
    for (const model of ['Message', 'FlowExecutionV2', 'JobRequest']) assert.equal(await db[model].count(), 0);
    assert.equal(f.externalFetchAttempts, 0);
    owned.report.checks.push('Both fictitious BS clinics: full 12-field block LOPD + two pinned source logos + legal footer + native care gate409 before and200 after all-No signature; printable branding and signed rows unchanged');
    owned.report.checks.push('Observed current behavior: old issued pending without branding is reused byte-exact on same-version request (created0, public brandingnull); new explicit version issues a new branded package while old pending remains active until the new signature supersedes it without changing its snapshot/body/hash');
    owned.report.checks.push('Native tablet kiosk: ownclinic200, peergroup403 bydefault, explicitgroup200, revokedgroup403 using same token; different JWT signer401. No claim of live DEV/CRM cross-environment login test');
  } finally { await f.close(); }
}));
