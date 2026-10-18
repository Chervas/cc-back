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
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const waitSignal = async (promise, label) => {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(Error('OWNED race barrier timeout: ' + label)), 10000);
  })]); } finally { clearTimeout(timer); }
};

test('native privacy HTTP endpoints enforce JWT/MFA/ACL and exact patient/clinic/appointment scope', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 180000,
}, async () => withIsolatedCampaignMysql(async owned => {
  owned.models.EconomicBudgetSignatureRequest = require('../../../models/economicbudgetsignaturerequest')(owned.sql, S.DataTypes);
  await owned.models.EconomicBudgetSignatureRequest.sync();
  const f = await createOwnedVisitAuthAclFixture({ ...owned, includeConsentRoutes: true,
    includePatientMobileVerificationRoutes: true, nativeFinalHandler: true });
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
  const calendarTreatment = 93501;
  const calendarAppointments = [
    { id_cita: appointmentId, paciente_id: patientId, tratamiento_id: null },
    { id_cita: 78502, paciente_id: patientId, tratamiento_id: calendarTreatment },
    { id_cita: 78503, paciente_id: importedId, tratamiento_id: null },
    { id_cita: 78504, paciente_id: importedId, tratamiento_id: calendarTreatment },
  ];
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
    await db.Tratamiento.create({ id_tratamiento: calendarTreatment, clinica_id: 72, grupo_clinica_id: ids.group,
      nombre: 'OWNED calendar consent regression', disciplina: 'medicina', origen: 'clinica', activo: true,
      precio_base: 0, eliminado_por_clinica: [] });
    await db.CitaPaciente.bulkCreate(calendarAppointments.map((row, index) => ({ ...row, clinica_id: 72,
      inicio: new Date(+start + index * 1800000), fin: new Date(+start + (index + 1) * 1800000),
      estado: 'info_enviada', tipo_cita: row.tratamiento_id ? 'primera_con_trat' : 'primera_sin_trat' })));
    const clinicalTemplate = await db.ClinicConsentTemplate.create({ public_id: 'qa_privacy_calendar_clinical', clinic_id: 72,
      catalog_key: 'qa_privacy_calendar_clinical', name: 'Independent clinical requirement', purpose: 'clinical', status: 'active',
      is_default: false, blocking_policy: 'hard', validity_mode: 'manual' });
    await db.TreatmentConsentRequirement.create({ tratamiento_id: calendarTreatment, clinica_id: 72,
      clinic_template_id: clinicalTemplate.id, required: true, blocking_policy: 'hard' });
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
    const calendarRoute = '/api/citas/calendar?' + new URLSearchParams({ clinica_id: '72',
      startDate: new Date(+start - 3600000).toISOString(), endDate: new Date(+start + 86400000).toISOString() });
    const calendarRead = async ({ state, attention, importedState = 'not_requested', importedAttention = true }) => {
      const snapshot = await fingerprint(), previousQuiet = await silent();
      const result = await request('GET', calendarRoute, undefined, reception);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.equal(result.headers['x-agenda-endpoint'], 'calendar-lite');
      assert.equal(result.body.length, calendarAppointments.length);
      for (const expected of calendarAppointments) {
        const row = result.body.find(item => Number(item.id_cita) === expected.id_cita);
        assert(row, `Native calendar DTO preserves appointment ${expected.id_cita}`);
        assert.equal(row.tratamiento_id, expected.tratamiento_id);
        assert.equal(Number(row.paciente_id), expected.paciente_id);
        assert.equal(row.paciente.public_id, `pac_privacy_http_${expected.paciente_id}`);
        const summary = row.consent_summary;
        assert(summary?.privacy, `Native calendar must include LOPD projection even without treatment: ${expected.id_cita}`);
        const isImported = expected.paciente_id === importedId;
        assert.equal(summary.privacy.state, isImported ? importedState : state);
        assert.equal(summary.privacy.attention_required, isImported ? importedAttention : attention);
        assert.equal(summary.privacy.required, !isImported);
        assert.equal(summary.privacy.allowed, isImported || state === 'signed', 'Visual LOPD alert never tightens the imported care gate');
        assert.equal(summary.privacy.has_pending, ['pending', 'sent', 'viewed'].includes(isImported ? importedState : state),
          'An absent document is an attention item, not an invented pending request');
        assert.equal(summary.privacy.patient_id, expected.paciente_id);
        assert.equal(summary.privacy.clinic_id, 72);
        assert.equal(summary.privacy.appointment_id, expected.id_cita);
        // Privacy is independent of treatment consent counters, even when its
        // attention indicator changes from missing to sent/signed/paper.
        const clinical = expected.tratamiento_id ? 1 : 0;
        assert.equal(Number(summary.required_total || 0), clinical);
        assert.equal(Number(summary.signed_required || 0), 0);
        assert.equal(Number(summary.pending_required || 0), clinical);
        assert.equal(Number(summary.pending_optional || 0), 0);
        assert.equal(!!summary.has_pending, clinical > 0);
      }
      const summaryResult = await request('GET', `${calendarRoute}&summary=true`, undefined, reception);
      assert.equal(summaryResult.status, 200, JSON.stringify(summaryResult.body));
      assert.equal(summaryResult.headers['x-agenda-endpoint'], 'calendar-summary');
      assert.equal(summaryResult.body.length, calendarAppointments.length);
      assert(summaryResult.body.every(row => !Object.hasOwn(row, 'consent_summary') && !Object.hasOwn(row, 'paciente')),
        'Availability/month summary remains minimal, without per-patient privacy data');
      assert.deepEqual(await fingerprint(), snapshot, 'All calendar GETs leave domain/signature/package/delivery data unchanged');
      assert.deepEqual(await silent(), previousQuiet, 'Calendar and summary-only GETs create no message/job/flow/questionnaire/dispatch');
      return result.body;
    };
    const initial = await read(reception); assert.equal(initial.state, 'not_requested'); assert.equal(initial.required, true);
    assert.equal(initial.allowed, false); assert.equal(initial.attention_required, true); assert.deepEqual(await fingerprint(), before);
    await calendarRead({ state: 'not_requested', attention: true });
    await expect('GET', calendarRoute, undefined, undefined, 401);
    await expect('GET', calendarRoute, undefined, outsider, 403);
    await expect('GET', `${calendarRoute}&summary=true`, undefined, outsider, 403);
    const consentDenied = await db.AccessPolicyOverride.create({ scope_type: 'clinic', scope_id: 72,
      feature_key: 'consents.view', role_code: 'reception', effect: 'deny', updated_by: ids.owner });
    const redacted = await expect('GET', calendarRoute, undefined, reception, 200);
    assert(redacted.every(row => row.consent_summary === null), 'Calendar does not leak LOPD when consents.view is denied');
    await consentDenied.destroy();
    await expect('GET', `${path}/privacy?clinic_id=72`, undefined, undefined, 401);
    await expect('GET', `${path}/privacy?clinic_id=72`, undefined, outsider, 403);
    await expect('GET', `${path}/privacy?clinic_id=72&appointment_id=78503`, undefined, reception, 404);
    await expect('GET', `${path}/privacy?clinic_id=66&appointment_id=${appointmentId}`, undefined, reception, 403);
    await expect('GET', `/api/consentimientos/patients/pac_privacy_http_${foreignId}/privacy?clinic_id=72`, undefined, reception, 403);
    await expect('GET', `${path}/privacy?clinic_id=72&appointment_id=1bad`, undefined, reception, 400);
    await expect('POST', `${path}/privacy-package`, { clinic_id: 72, patientId: foreignId }, reception, 400);
    await expect('POST', `${path}/privacy-paper`, { clinic_id: 72, acknowledged: false }, reception, 400);
    await expect('POST', `${path}/privacy-paper`, { clinic_id: 72, acknowledged: true, appointment_id: appointmentId }, reception, 400);
    assert.deepEqual(await fingerprint(), before, 'Rejected native requests mutate no domain/clinical/signature record');
    const imported = await expect('GET', `/api/consentimientos/patients/pac_privacy_http_${importedId}/privacy?clinic_id=72`, undefined, reception, 200);
    assert.equal(imported.required, false); assert.equal(imported.allowed, true);
    assert.equal(imported.attention_required, true); assert.equal(imported.state, 'not_requested');
    assert.equal(imported.has_pending, false); assert.equal(imported.document_id, null);
    const prepared = await expect('POST', `${path}/privacy-package`, { clinic_id: 72 }, reception, 201);
    assert.equal(prepared.created_count, 1); assert.equal(await db.PatientIntakeRequest.count(), 0);
    const pending = await read(reception); assert.equal(pending.state, 'pending'); assert.equal(pending.package_id, prepared.package_id);
    await calendarRead({ state: 'pending', attention: true });
    const docs = await db.PatientConsentDocument.findAll({ where: { package_id: prepared.package_id } });
    assert.equal(docs.length, 1); assert.equal(docs[0].purpose, 'data_protection'); assert.equal(docs[0].tratamiento_id, null);
    const tablet = await expect('POST', `/api/consentimientos/packages/${prepared.package_id}/tablet-session`, {}, reception, 200);
    assert.equal((await read(reception)).state, 'sent');
    await calendarRead({ state: 'sent', attention: true });
    const tabletPath = `/api/consentimientos/public/${encodeURIComponent(tablet.public_token)}`;
    const viewed = await expect('GET', tabletPath, undefined, undefined, 200);
    assert.equal(viewed.documents.length, 1); assert.equal(viewed.intake, null);
    assert.equal((await read(reception)).state, 'viewed');
    await calendarRead({ state: 'viewed', attention: true });
    const pkg = await db.ConsentSignaturePackage.findByPk(prepared.package_id); await pkg.update({ status: 'cancelled' });
    assert.equal((await read(reception)).state, 'not_requested');
    await pkg.update({ status: 'pending' });
    const signature = { signer_name: 'OWNED fictitious signer', accepted_statement: true,
      signature_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=' };
    await expect('POST', `/api/consentimientos/documents/${docs[0].id}/sign`, signature, reception, 409);
    const confirmed = await expect('POST', `${tabletPath}/documents/${docs[0].id}/personal-data`, {
      schema_version: viewed.documents[0].personal_data_form.schema_version, snapshot_hash: viewed.documents[0].snapshot_hash,
      values: { ...viewed.documents[0].personal_data_form.values, dni: 'QA-PRIVACY-NO-REAL',
        direccion: 'Calle ficticia QA 19', ciudad: 'Alicante', email: 'privacy-review@example.invalid',
        fecha_nacimiento: '1980-01-02', telefono: '+34000000009' },
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
    {
      const autoMaster = await db.Paciente.findByPk(patientId);
      assert.equal(autoMaster.dni, 'QA-PRIVACY-NO-REAL'); assert.equal(autoMaster.direccion, 'Calle ficticia QA 19');
      assert.equal(autoMaster.email, 'privacy-review@example.invalid'); assert.equal(autoMaster.telefono_movil, '34000000009');
      assert.equal(await db.PatientOperationalEvent.count({ where: { patient_id: patientId,
        event_type: 'patient.privacy_profile_autofilled' } }), 1);
      // Explicitly seed the pre-rollout document-only situation in this owned
      // database; it still needs safe per-field reconciliation/backfill support.
      await db.Paciente.update({ dni: null, direccion: null, poblacion: null, fecha_nacimiento: null,
        email: null, telefono_movil: null }, { where: { id_paciente: patientId } });
      const reviewPath = `${path}/privacy-profile`, getReview = () => expect('GET', `${reviewPath}?clinic_id=72`, undefined, reception, 200);
      const frozenDoc = (await docs[0].reload()).toJSON(), beforeReview = await fingerprint();
      const review = await getReview();
      assert.equal(review.available, true); assert.equal(review.commercial_choice, 'no');
      assert.equal(review.document.id, docs[0].id);
      assert.equal(review.fields.find(field => field.key === 'direccion').selected_by_default, true);
      assert.equal(review.fields.find(field => field.key === 'email').selected_by_default, false);
      assert.equal(review.fields.find(field => field.key === 'telefono_movil').selected_by_default, false);
      assert.deepEqual(await fingerprint(), beforeReview, 'Review GET never synchronizes publicly submitted fields automatically');
      await expect('GET', `${reviewPath}?clinic_id=72`, undefined, undefined, 401);
      await expect('GET', `${reviewPath}?clinic_id=72`, undefined, outsider, 403);
      const body = { clinic_id: 72, document_id: review.document.id, snapshot_hash: review.document.snapshot_hash,
        patient_version: review.patient_version, fields: ['dni', 'direccion', 'poblacion', 'fecha_nacimiento', 'email'] };
      await expect('POST', reviewPath, body, reception, 400);
      await expect('POST', reviewPath, { ...body, patient_version: 'stale', acknowledge_contact_changes: true }, reception, 409);
      await expect('POST', reviewPath, { ...body, fields: ['notas_medicas'] }, reception, 400);
      const denyEdit = await db.AccessPolicyOverride.create({ scope_type: 'clinic', scope_id: 72,
        feature_key: 'patients.edit', role_code: 'reception', effect: 'deny', updated_by: ids.owner });
      await expect('POST', reviewPath, { ...body, acknowledge_contact_changes: true }, reception, 403); await denyEdit.destroy();
      const pauseBeforeAnchors = async (change, expectedStatus) => {
        const reached = deferred(), release = deferred(), original = db.Clinica.findByPk; let paused = false;
        db.Clinica.findByPk = async function(id, options) {
          if (options?.lock === 'UPDATE' && !paused) { paused = true; reached.resolve(); await release.promise; }
          return original.call(this, id, options);
        };
        try {
          const pendingApply = request('POST', reviewPath, { ...body, acknowledge_contact_changes: true }, reception);
          await waitSignal(reached.promise, 'profile apply awaits sorted clinic anchors');
          const cleanup = await change(); release.resolve();
          const response = await pendingApply; assert.equal(response.status, expectedStatus, JSON.stringify(response.body));
          if (cleanup) await cleanup();
        } finally { release.resolve(); db.Clinica.findByPk = original; }
      };
      await pauseBeforeAnchors(async () => {
        await db.Paciente.update({ direccion: 'Cambio concurrente ficticio' }, { where: { id_paciente: patientId } });
        return () => db.Paciente.update({ direccion: null }, { where: { id_paciente: patientId } });
      }, 409);
      await pauseBeforeAnchors(async () => {
        const revoked = await db.AccessPolicyOverride.create({ scope_type: 'clinic', scope_id: 72,
          feature_key: 'patients.edit', role_code: 'reception', effect: 'deny', updated_by: ids.owner });
        return () => revoked.destroy();
      }, 403);
      {
        const auditCreate = db.PatientOperationalEvent.create, masterBefore = (await db.Paciente.findByPk(patientId)).toJSON();
        try {
          for (const code of ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT']) {
            db.PatientOperationalEvent.create = async function(values, options) {
              if (values.event_type === 'patient.privacy_profile_applied') {
                throw Object.assign(Error('OWNED recoverable SQL lock fixture'), { original: { code } });
              }
              return auditCreate.call(this, values, options);
            };
            const locked = await expect('POST', reviewPath, { ...body, acknowledge_contact_changes: true }, reception, 409);
            assert.equal(locked.code, 'privacy_profile_changed');
            assert.deepEqual((await db.Paciente.findByPk(patientId)).toJSON(), masterBefore,
              'A recoverable database lock error rolls back the earlier selected patient writes atomically');
            assert.equal(await db.PatientOperationalEvent.count({ where: { patient_id: patientId, event_type: 'patient.privacy_profile_applied' } }), 0);
          }
        } finally { db.PatientOperationalEvent.create = auditCreate; }
      }
      const applied = await expect('POST', reviewPath, { ...body, acknowledge_contact_changes: true }, reception, 200);
      assert.equal(applied.applied, true);
      const master = await db.Paciente.findByPk(patientId);
      assert.equal(master.dni, 'QA-PRIVACY-NO-REAL'); assert.equal(master.direccion, 'Calle ficticia QA 19');
      assert.equal(master.poblacion, 'Alicante'); assert.equal(master.email, 'privacy-review@example.invalid');
      assert.equal(master.telefono_movil, null, 'Unselected contact is never changed');
      assert.deepEqual((await docs[0].reload()).toJSON(), frozenDoc, 'Applying reviewed master data leaves every signed document byte immutable');
      assert.equal(await db.PatientOperationalEvent.count({ where: { patient_id: patientId, event_type: 'patient.privacy_profile_applied' } }), 1);
      await expect('POST', reviewPath, { ...body, acknowledge_contact_changes: true }, reception, 409);
      const next = await getReview();
      await db.Paciente.update({ telefono_movil: '+34 000 000 009' }, { where: { id_paciente: importedId } });
      const collision = await expect('POST', reviewPath, { clinic_id: 72, document_id: next.document.id,
        snapshot_hash: next.document.snapshot_hash, patient_version: next.patient_version,
        fields: ['telefono_movil'], acknowledge_contact_changes: true }, reception, 409);
      assert.equal(collision.code, 'privacy_profile_contact_collision');
      assert.equal((await master.reload()).telefono_movil, null);
      await db.Paciente.update({ telefono_movil: null }, { where: { id_paciente: importedId } });
      const phoneBody = { clinic_id: 72, document_id: next.document.id, snapshot_hash: next.document.snapshot_hash,
        patient_version: next.patient_version, fields: ['telefono_movil'], acknowledge_contact_changes: true };
      const foreignChat = await db.Conversation.create({ clinic_id: 72, channel: 'whatsapp',
        patient_id: importedId, contact_id: '+34 000 000 009' });
      const chatCollision = await expect('POST', reviewPath, phoneBody, reception, 409);
      assert.equal(chatCollision.code, 'privacy_profile_phone_chat_collision');
      await foreignChat.destroy();
      const existingChat = await db.Conversation.create({ clinic_id: 72, channel: 'whatsapp',
        patient_id: patientId, contact_id: '34000000008' });
      const oldChat = (await existingChat.reload()).toJSON();
      const contactApplied = await expect('POST', reviewPath, phoneBody, reception, 200);
      assert.equal(contactApplied.applied, true); assert.equal((await master.reload()).telefono_movil, '34000000009');
      assert.deepEqual((await existingChat.reload()).toJSON(), oldChat, 'Explicit acceptance changes master contact, never repoints or merges the old conversation');
      await expect('POST', reviewPath, phoneBody, reception, 409);
      assert.equal(await db.PatientOperationalEvent.count({ where: { patient_id: patientId,
        event_type: 'patient.mobile_verification_requested' } }), 1, 'Exactly one pending verification event, no automatic send');
      const verificationPath = `/api/pacientes/pac_privacy_http_${patientId}/mobile-verification`;
      const verification = await expect('GET', `${verificationPath}?clinic_id=72`, undefined, reception, 200);
      assert.equal(verification.items[0].state, 'pending'); assert.equal(verification.items[0].delivery_enabled, false);
      assert(!JSON.stringify(verification).includes('reply_token'));
      await expect('GET', `${verificationPath}?clinic_id=72`, undefined, undefined, 401);
      await expect('GET', `${verificationPath}?clinic_id=72`, undefined, outsider, 403);
      await expect('GET', `${verificationPath}?clinic_id=72&phone=forged`, undefined, reception, 400);
      const verificationBody = { clinic_id: 72, action: 'confirm', request_event_id: verification.items[0].request_event_id,
        revision: verification.items[0].revision };
      await expect('POST', verificationPath, verificationBody, outsider, 403);
      await expect('POST', verificationPath, verificationBody, reception, 200);
      await expect('POST', verificationPath, verificationBody, reception, 409);
      const verified = await expect('GET', `${verificationPath}?clinic_id=72`, undefined, reception, 200);
      assert.equal(verified.items[0].state, 'confirmed'); assert.equal(verified.items[0].actor_user_id, ids.reception);
      assert.equal(verified.items[0].provenance, 'manual_review'); assert(verified.items[0].resolved_at);
      assert.equal((await master.reload()).telefono_movil, '34000000009');
      const correctionBody = { clinic_id: 72, action: 'correct', request_event_id: verified.items[0].request_event_id,
        revision: verified.items[0].revision, phone: '34000000010', acknowledged: true };
      await expect('POST', verificationPath, { ...correctionBody, acknowledged: false }, reception, 400);
      assert.equal((await master.reload()).telefono_movil, '34000000009');
      const replacement = await expect('POST', verificationPath, correctionBody, reception, 200);
      assert.equal(replacement.corrected, true);
      const replacementEvent = await db.PatientOperationalEvent.findByPk(replacement.request_event_id);
      assert.equal(replacementEvent.source, 'reception_mobile_verification');
      assert.equal(replacementEvent.metadata.document_id, docs[0].id);
      assert.equal(replacementEvent.metadata.snapshot_hash, frozenDoc.snapshot_hash);
      assert.equal(replacementEvent.metadata.previous_phone, '34000000009');
      assert.equal(replacementEvent.metadata.phone, '34000000010');
      assert.equal(replacementEvent.metadata.delivery_enabled, false);
      assert.equal((await master.reload()).telefono_movil, '34000000010');
      await expect('POST', verificationPath, correctionBody, reception, 409);
      const correctedState = await expect('GET', `${verificationPath}?clinic_id=72`, undefined, reception, 200);
      assert.equal(correctedState.items[0].request_event_id, replacement.request_event_id);
      assert.equal(correctedState.items[0].current, true);
      assert.equal(correctedState.items[1].current, false);
      assert(!JSON.stringify(correctedState).includes('reply_token'));
      const pendingBody = { clinic_id: 72, action: 'pending', request_event_id: replacement.request_event_id,
        revision: correctedState.items[0].revision };
      await expect('POST', verificationPath, pendingBody, reception, 200);
      const keptPending = await expect('GET', `${verificationPath}?clinic_id=72`, undefined, reception, 200);
      assert.equal(keptPending.items[0].state, 'pending');
      assert.equal(keptPending.items[0].provenance, 'manual_pending');
      assert.equal(keptPending.items[0].manually_resolved, false);
      assert.equal(keptPending.items[0].resolved_at, null);
      const concurrentBody = { ...pendingBody, action: 'confirm', revision: keptPending.items[0].revision };
      const competing = await Promise.all([request('POST', verificationPath, concurrentBody, reception),
        request('POST', verificationPath, { ...concurrentBody, action: 'pending' }, reception)]);
      assert.deepEqual(competing.map(row => row.status).sort(), [200, 409], 'Same-revision native mutations serialize with one CAS winner');
      const finalProjection = await expect('GET', `${verificationPath}?clinic_id=72`, undefined, reception, 200);
      if (finalProjection.items[0].state !== 'confirmed') {
        await expect('POST', verificationPath, { ...concurrentBody, revision: finalProjection.items[0].revision }, reception, 200);
      }
      assert.equal((await master.reload()).telefono_movil, '34000000010');
      assert.deepEqual((await existingChat.reload()).toJSON(), oldChat, 'Manual verification/correction never transports or merges an old-number conversation');
      owned.report.checks.push('Native JWT/MFA/ACL patient-mobile routes: explicit reception acceptance produces an inactive request, scoped/token-free GET, forbidden and stale POST rejected, audited manual confirmation without sending');
      owned.report.checks.push('Native reception correction requires explicit acknowledgement and creates one disabled replacement using the same document receipt; manual-pending stays unresolved; concurrent same-revision actions have one CAS winner; old request and chat stay retired/immutable');
      assert.deepEqual((await docs[0].reload()).toJSON(), frozenDoc, 'Explicit safe contact copy never changes the signed source snapshot');
      const refused = await require('../../lib/bs-privacy-commercial-preferences').commercialRefusals({ db,
        clinicIds: [72], patientIds: [patientId] });
      assert(refused.patientIds.has(patientId));
      await assert.rejects(require('../../lib/bs-privacy-commercial-preferences').assertCommercialAllowed({ db,
        clinicIds: [66], patientIds: [patientId] }), error => error.code === 'AUTOMATION_COMMUNICATIONS_RESTRICTED');
      owned.report.checks.push('Authenticated signed-LOPD profile review: exact signed snapshot and master receipt, opt-in selected-field application, contact acknowledgement/collision rejection, patients.edit ACL, no blank clears, immutable signed history, audited one-time apply; commercial No derived read-only across BS clinics');
    }
    await calendarRead({ state: 'signed', attention: false });
    const importedPath = `/api/consentimientos/patients/pac_privacy_http_${importedId}`;
    const cancelledImported = await expect('POST', `${importedPath}/privacy-package`, { clinic_id: 72 }, reception, 201);
    const importedPending = await expect('GET', `${importedPath}/privacy?clinic_id=72`, undefined, reception, 200);
    assert.equal(importedPending.state, 'pending'); assert.equal(importedPending.attention_required, true);
    assert.equal(importedPending.allowed, true); assert.equal(importedPending.required, false); assert.equal(importedPending.has_pending, true);
    await calendarRead({ state: 'signed', attention: false, importedState: 'pending' });
    const cancelledImportedPackage = await db.ConsentSignaturePackage.findByPk(cancelledImported.package_id);
    const cancelledImportedDoc = await db.PatientConsentDocument.findOne({ where: { package_id: cancelledImported.package_id } });
    await cancelledImportedPackage.update({ status: 'cancelled' });
    await cancelledImportedDoc.update({ status: 'cancelled' });
    const cancelledSnapshot = (await cancelledImportedDoc.reload()).toJSON();
    const importedAbsent = await expect('GET', `${importedPath}/privacy?clinic_id=72`, undefined, reception, 200);
    assert.equal(importedAbsent.state, 'not_requested'); assert.equal(importedAbsent.attention_required, true);
    assert.equal(importedAbsent.allowed, true); assert.equal(importedAbsent.required, false);
    assert.equal(importedAbsent.has_pending, false); assert.equal(importedAbsent.document_id, null); assert.equal(importedAbsent.package_id, null);
    await calendarRead({ state: 'signed', attention: false });
    assert.deepEqual((await cancelledImportedDoc.reload()).toJSON(), cancelledSnapshot,
      'Read-only missing-signature alert does not reopen or alter a cancelled imported document');
    const importedPrepared = await expect('POST', `${importedPath}/privacy-package`, { clinic_id: 72 }, reception, 201);
    const importedDoc = await db.PatientConsentDocument.findOne({ where: { package_id: importedPrepared.package_id } });
    const importedTablet = await expect('POST', `/api/consentimientos/packages/${importedPrepared.package_id}/tablet-session`, {}, reception, 200);
    const importedSent = await expect('GET', `${importedPath}/privacy?clinic_id=72`, undefined, reception, 200);
    assert.equal(importedSent.state, 'sent'); assert.equal(importedSent.attention_required, true);
    assert.equal(importedSent.required, false); assert.equal(importedSent.allowed, true); assert.equal(importedSent.has_pending, true);
    await calendarRead({ state: 'signed', attention: false, importedState: 'sent', importedAttention: true });
    await expect('GET', `/api/consentimientos/public/${encodeURIComponent(importedTablet.public_token)}`, undefined, undefined, 200);
    const importedViewed = await expect('GET', `${importedPath}/privacy?clinic_id=72`, undefined, reception, 200);
    assert.equal(importedViewed.state, 'viewed'); assert.equal(importedViewed.attention_required, true);
    assert.equal(importedViewed.required, false); assert.equal(importedViewed.allowed, true);
    await calendarRead({ state: 'signed', attention: false, importedState: 'viewed' });
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
    await calendarRead({ state: 'signed', attention: false, importedState: 'paper', importedAttention: false });
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
    // Hold the real InnoDB locks in both adverse orders. These barriers only
    // pause native model calls; no controller, ACL, signature or SQL is mocked.
    const prepareRace = async id => {
      await db.Paciente.create({ id_paciente: id, clinica_id: 72, public_id: `pac_privacy_http_${id}`,
        nombre: 'OWNED fictitious race', apellidos: String(id), numero_historia: String(id), historia_scope: 'clinic:72',
        telefono_movil: null, telefono_secundario: null });
      const racePath = `/api/consentimientos/patients/pac_privacy_http_${id}`;
      const issued = await expect('POST', `${racePath}/privacy-package`, { clinic_id: 72 }, reception, 201);
      const access = await expect('POST', `/api/consentimientos/packages/${issued.package_id}/tablet-session`, {}, reception, 200);
      const publicPath = `/api/consentimientos/public/${encodeURIComponent(access.public_token)}`;
      const shown = await expect('GET', publicPath, undefined, undefined, 200), shownDoc = shown.documents[0];
      const confirmedView = await expect('POST', `${publicPath}/documents/${shownDoc.id}/personal-data`, {
        schema_version: shownDoc.personal_data_form.schema_version, snapshot_hash: shownDoc.snapshot_hash,
        values: shownDoc.personal_data_form.values,
      }, undefined, 200);
      const current = confirmedView.documents[0];
      return { id, path: racePath, publicPath, packageId: issued.package_id, documentId: current.id,
        sign: () => request('POST', `${publicPath}/sign`, { ...signature,
          document_snapshot_hashes: { [current.id]: current.snapshot_hash },
          document_choices: { [current.id]: { schema_version: choices.CHOICE_SCHEMA_VERSION,
            answers: Object.fromEntries(choices.CHOICE_KEYS.map(name => [name, 'no'])) } } }),
        paper: () => request('POST', `${racePath}/privacy-paper`, { clinic_id: 72, acknowledged: true }, reception) };
    };
    {
      const race = await prepareRace(92504), signedLocked = deferred(), paperWaiting = deferred(), releaseSign = deferred();
      const originalDocumentRead = db.PatientConsentDocument.findByPk, originalClinicRead = db.Clinica.findByPk;
      let signaturePaused = false;
      db.PatientConsentDocument.findByPk = async function(id, options) {
        const row = await originalDocumentRead.call(this, id, options);
        if (Number(id) === race.documentId && options?.lock === 'UPDATE' && !signaturePaused) {
          signaturePaused = true; signedLocked.resolve(); await releaseSign.promise;
        }
        return row;
      };
      db.Clinica.findByPk = async function(id, options) {
        if (Number(id) === 72 && options?.lock === 'SHARE' && signaturePaused) paperWaiting.resolve();
        return originalClinicRead.call(this, id, options);
      };
      try {
        const signPromise = race.sign(); await waitSignal(signedLocked.promise, 'signature holds package/document');
        const paperPromise = race.paper(); await waitSignal(paperWaiting.promise, 'paper waits at the shared clinic anchor held by signing');
        releaseSign.resolve();
        const [signedFirst, paperAfter] = await Promise.all([signPromise, paperPromise]);
        assert.equal(signedFirst.status, 200, JSON.stringify(signedFirst.body)); assert.equal(paperAfter.status, 201, JSON.stringify(paperAfter.body));
        assert.equal((await db.PatientConsentDocument.findByPk(race.documentId)).status, 'signed', 'Paper CAS never supersedes a concurrent completed signature');
      } finally { releaseSign.resolve(); db.PatientConsentDocument.findByPk = originalDocumentRead; db.Clinica.findByPk = originalClinicRead; }
    }
    {
      const race = await prepareRace(92505), paperLocked = deferred(), signatureWaiting = deferred(), releasePaper = deferred();
      const originalPackageRead = db.ConsentSignaturePackage.findByPk, originalClinicRead = db.Clinica.findByPk; let attempts = 0;
      db.ConsentSignaturePackage.findByPk = async function(id, options) {
        const matches = Number(id) === race.packageId && options?.lock === 'UPDATE';
        if (matches && ++attempts === 1) {
          const row = await originalPackageRead.call(this, id, options);
          paperLocked.resolve(); await releasePaper.promise; return row;
        }
        return originalPackageRead.call(this, id, options);
      };
      db.Clinica.findByPk = async function(id, options) {
        if (Number(id) === 72 && options?.lock === 'UPDATE') signatureWaiting.resolve();
        return originalClinicRead.call(this, id, options);
      };
      try {
        const paperPromise = race.paper(); await waitSignal(paperLocked.promise, 'paper holds patient/package');
        const signPromise = race.sign(); await waitSignal(signatureWaiting.promise, 'signature waits at the clinic anchor held by paper');
        releasePaper.resolve();
        const [paperFirst, signAfter] = await Promise.all([paperPromise, signPromise]);
        assert.equal(paperFirst.status, 201, JSON.stringify(paperFirst.body)); assert.equal(signAfter.status, 409, JSON.stringify(signAfter.body));
        const closed = await db.PatientConsentDocument.findByPk(race.documentId);
        assert.equal(closed.status, 'superseded'); assert.equal(closed.signed_at, null);
      } finally { releasePaper.resolve(); db.ConsentSignaturePackage.findByPk = originalPackageRead; db.Clinica.findByPk = originalClinicRead; }
    }
    assert.deepEqual(await silent(), quiet, 'No questionnaire, provider message, job, flow, review or operational dispatch is created');
    owned.report.checks.push('Actual JWT/MFA/session/ACL/router: read-only GET, all six UI states, exact patient-clinic-group scope and optional appointment mismatch');
    owned.report.checks.push('Actual patient prepare creates one independent LOPD only; explicit tablet session; four No choices valid; missing choices rejected without signature');
    owned.report.checks.push('Native patient paper v2 without appointment, idempotent, no invented digital document; no provider/job/flow/questionnaire/review sends');
    owned.report.checks.push('Sent LOPD -> paper supersedes outstanding family attempts and removes kiosk task; reopening creates nothing; mixed clinical document preserved and remains usable');
    owned.report.checks.push('Adversarial native clinic->patient->package lock races: signature-first preserves signed evidence; paper-first rejects the waiting signature with 409; no deadlock or invented signature');
    owned.report.checks.push('Native GET calendar-lite/mapCalendar DTO: treatment and treatment-free cards preserve privacy across not_requested/pending/sent/viewed/signed/paper; missing imported signature is visible without tightening allowed/required care gate; independent clinical counters unchanged');
    owned.report.checks.push('Imported cancelled historical LOPD remains cancelled and unmodified: patient/calendar attention=true, no active document/request, allowed=true, required=false; explicit manual pending/sent/viewed/paper workflow remains usable without automatic sends');
    owned.report.checks.push('Native calendar JWT/clinic/consent ACL redacts unauthorized privacy; summary=true remains minimal; all calendar reads preserve domain fingerprints and create no sends/jobs/flows/intake/dispatch');
    owned.report.requests = f.requests; owned.report.externalFetchAttempts = f.externalFetchAttempts;
  } finally { await f.close(); }
}));
