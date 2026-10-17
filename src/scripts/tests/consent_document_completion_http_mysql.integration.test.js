'use strict';
// Owns a new local mysqld + loopback HTTP. Production model index, provider
// sockets, queues and real patient/template records are forbidden by fixture.
const test = require('node:test'), assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitAuthAclFixture } = require('./helpers/owned-visit-auth-acl-fixture');
const completion = require('../../lib/consent-document-completion');
const signature = { signer_name: 'Firmante ficticio QA', accepted_statement: true,
  signature_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=' };

test('native unsigned intake: explicit capability, atomic receipts, mixed package, gate, reuse, immutability and scope', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 180000,
}, async () => withIsolatedCampaignMysql(async owned => {
  const f = await createOwnedVisitAuthAclFixture({ ...owned, includeConsentRoutes: true, includePatientIntakeSettingsRoutes: true });
  const { db, ids, request } = f;
  for (const name of ['PatientCustomField', 'PatientConsentExternalAttestation', 'EconomicBudgetSignatureRequest']) {
    db[name] = require(`../../../models/${name.toLowerCase()}`)(owned.sql, S.DataTypes); await db[name].sync();
  }
  const service = require('../../services/consentimientos.service');
  const expect = async (method, path, body, token, status) => {
    const response = await request(method, path, body, token);
    assert.equal(response.status, status, `${method} ${path.replace(/public\/[^/]+/, 'public/[redacted]')}: ${JSON.stringify(response.body)}`);
    return response.body;
  };
  const C = require('../../services/authEmailChallenge.contract');
  const login = async id => {
    const started = await expect('POST', '/api/auth/sign-in', { email: `owned-${id}@example.invalid`, password: f.password }, null, 202);
    const row = await db.AuthEmailChallenge.findOne({ where: { challenge_hash: C.challengeHash(started.challengeToken) } });
    const verified = await expect('POST', '/api/auth/email-code/verify', { challengeToken: started.challengeToken, code: f.codeFor(row.challenge_id) }, null, 200);
    return verified.token;
  };
  try {
    const owner = await login(ids.owner), outsider = await login(ids.outsider);
    const marker = { schema_version: completion.SCHEMA, signature_mode: 'none', completion_mode: 'acknowledge' };
    const modelPayload = { clinic_id: ids.clinic, name: 'Información de alta ficticia', title: 'Información para tu visita',
      purpose: 'other', status: 'active', version_status: 'published', blocking_policy: 'hard', validity_mode: 'manual',
      requires_patient_signature: false, requires_representative_when_minor: false, requires_professional_signature: false,
      body_html: '<p>Información de prueba. Confirma que has leído este documento antes de continuar.</p>',
      body_json: { document_completion: marker } };
    const beforeInvalid = await db.ClinicConsentTemplate.count();
    for (const patch of [{ purpose: 'data_protection' }, { purpose: 'clinical' }, { requires_patient_signature: true },
      { body_json: { document_completion: { ...marker, extra: true } } }]) {
      await expect('POST', '/api/consentimientos/clinic/templates', { ...modelPayload, ...patch }, owner, 400);
    }
    assert.equal(await db.ClinicConsentTemplate.count(), beforeInvalid, 'Invalid definitions cannot leave a template/version');
    await expect('POST', '/api/consentimientos/clinic/templates', modelPayload, outsider, 403);
    const template = await expect('POST', '/api/consentimientos/clinic/templates', modelPayload, owner, 201);
    await expect('PUT', `/api/consentimientos/clinic/templates/${template.id}`, { requires_patient_signature: true }, owner, 400);
    const source = await db.ClinicConsentTemplate.findByPk(template.id);
    const latest = await db.ClinicConsentTemplateVersion.findOne({ where: { clinic_template_id: template.id } });
    assert.equal(completion.policy(latest.toJSON(), source.toJSON()).completion_mode, 'acknowledge');
    // Native migration proves idempotent additive DDL on an owned schema only.
    await require('../../../migrations/20261017180000-add-unsigned-document-completion').up(owned.sql.getQueryInterface());
    const clinic = await db.Clinica.findByPk(ids.clinic), intake = { privacy_enabled: false, privacy_before_first_care: true,
      medical_questionnaire_enabled: false, additional_documents: [{ template_id: template.id, required: true, sort_order: 0 }] };
    await clinic.update({ configuracion: { ...clinic.configuracion, patient_intake: intake } });
    const patientId = 92791;
    await db.Paciente.create({ id_paciente: patientId, clinica_id: ids.clinic, public_id: 'pac_unsigned_owned', nombre: 'Paciente',
      apellidos: 'Ficticio', numero_historia: String(patientId), historia_scope: `clinic:${ids.clinic}`, acepta_marketing: false });
    await db.PacienteClinica.create({ paciente_id: patientId, clinica_id: ids.clinic, es_principal: true });
    const patientBefore = JSON.stringify((await db.Paciente.findByPk(patientId)).toJSON());
    const booked = await expect('POST', '/api/citas', f.body({ paciente: { id_paciente: patientId } }), owner, 201);
    const docsRoute = `/api/consentimientos/appointments/${booked.id_cita}/registration-documents`;
    await expect('POST', `/api/citas/${booked.id_cita}/care/arrive`, { clinic_id: ids.clinic }, owner, 200);
    const careBefore = (await f.fingerprint()).sha256;
    const blocked = await expect('POST', `/api/citas/${booked.id_cita}/care/start`, { clinic_id: ids.clinic }, owner, 409);
    assert.equal(blocked.code, 'appointment_intake_documents_required');
    assert.equal((await f.fingerprint()).sha256, careBefore);
    const prepared = await expect('POST', `${docsRoute}/${template.id}/package`, {}, owner, 201);
    const session = await service.createTabletSession(prepared.package_id);
    const route = `/api/consentimientos/public/${encodeURIComponent(session.public_token)}`;
    const view = await expect('GET', route, undefined, undefined, 200), doc = view.documents[0];
    assert.equal(doc.requires_patient_signature, false); assert.equal(doc.completion_mode, 'acknowledge');
    assert.equal(doc.signature_evidence, null); assert.equal(doc.completion_evidence, null);
    const payload = { document_ids: [doc.id], document_snapshot_hashes: { [doc.id]: doc.snapshot_hash }, acknowledged: true };
    await expect('POST', route + '/sign', { ...signature, document_ids: [doc.id] }, undefined, 409);
    for (const invalid of [{ ...payload, acknowledged: false }, { ...payload, document_ids: [] },
      { ...payload, signature_data_url: signature.signature_data_url }, { ...payload, document_ids: [doc.id, doc.id] }]) {
      await expect('POST', route + '/complete', invalid, undefined, 400);
    }
    await expect('POST', route + '/complete', { ...payload, document_snapshot_hashes: { [doc.id]: '0'.repeat(64) } }, undefined, 409);
    const foreignPackage = await db.ConsentSignaturePackage.create({ public_id: 'cpkg_unsigned_foreign', paciente_id: ids.foreignPatient,
      clinica_id: ids.peerClinic, status: 'pending' });
    const foreignDoc = await db.PatientConsentDocument.create({ ...(await db.PatientConsentDocument.findByPk(doc.id)).toJSON(),
      id: undefined, public_id: 'cdoc_unsigned_foreign', package_id: foreignPackage.id, paciente_id: ids.foreignPatient, clinica_id: ids.peerClinic });
    await expect('POST', route + '/complete', { acknowledged: true, document_ids: [foreignDoc.id],
      document_snapshot_hashes: { [foreignDoc.id]: doc.snapshot_hash } }, undefined, 404);
    const beforeConcurrentEvents = await db.ConsentDeliveryEvent.count();
    const concurrent = await Promise.all([expect('POST', route + '/complete', payload, undefined, 200),
      expect('POST', route + '/complete', payload, undefined, 200)]);
    assert.deepEqual(concurrent.map(row => row.completed_count).sort(), [0, 1]);
    assert.equal(await db.ConsentDeliveryEvent.count(), beforeConcurrentEvents + 1);
    const completed = await db.PatientConsentDocument.findByPk(doc.id), frozen = JSON.stringify(completed.toJSON());
    assert.equal(completed.status, 'completed'); assert.equal(completed.signed_at, null);
    assert.equal(completed.snapshot_json.signature_evidence, undefined); assert(completion.isCompleted(completed));
    const rawCompleted = await db.PatientConsentDocument.findByPk(doc.id, { raw: true });
    assert(completion.isCompleted(rawCompleted), `Raw SQL receipt validates (${typeof rawCompleted.snapshot_json} snapshot)`);
    assert.equal((await db.ConsentSignaturePackage.findByPk(prepared.package_id)).status, 'completed');
    const after = await expect('GET', route, undefined, undefined, 200);
    assert.equal(after.documents[0].completion_evidence.acknowledged, true);
    assert.equal(after.package.signed_count, 0); assert.equal(after.package.completed_count, 1);
    assert.equal(after.package.satisfied_count, 1);
    assert.equal((await expect('GET', docsRoute, undefined, owner, 200)).items[0].state, 'completed');
    await expect('POST', `/api/citas/${booked.id_cita}/care/start`, { clinic_id: ids.clinic }, owner, 200);
    const reuse = await expect('POST', `${docsRoute}/${template.id}/package`, {}, owner, 200);
    assert.equal(reuse.created_count, 0); assert.deepEqual(reuse.current_package_ids, []);
    const beforeIdempotent = (await f.fingerprint()).sha256;
    await expect('POST', route + '/complete', payload, undefined, 200);
    assert.equal((await f.fingerprint()).sha256, beforeIdempotent, 'A receipt retry does not touch timestamps, counts, events or documents');
    assert.equal(JSON.stringify((await completed.reload()).toJSON()), frozen);
    assert.equal(JSON.stringify((await db.Paciente.findByPk(patientId)).toJSON()), patientBefore, 'No patient/contact/marketing permission mutation');
    const printed = await service.renderConsentDocument(doc.id);
    assert(printed.includes('Documento completado sin firma')); assert(!printed.includes('Firma del paciente'));
    assert(printed.includes('<div class="document-kicker">Documento del paciente</div>'));
    assert(printed.includes('<div class="document-title">DOCUMENTO</div>'));
    owned.report.checks.push('HTTP ACL + authoring opt-in validation, no invalid writes; real first-care gate409 then200; canonical completed receipt, 2 concurrent completions/one event, zero forged signature, reuse and PDF evidence');

    // A complete action cannot finalize signatures, legacy false flags or
    // another package; mixed batches validate before their first mutation.
    const legacy = await service.createClinicTemplate({ ...modelPayload, name: 'Legado sin capacidad nueva', body_json: {} }, ids.owner);
    const signedTemplate = await service.createClinicTemplate({ ...modelPayload, name: 'Documento firmado independiente',
      body_json: {}, requires_patient_signature: true, requires_representative_when_minor: true }, ids.owner);
    const secondId = 92792;
    await db.Paciente.create({ id_paciente: secondId, clinica_id: ids.clinic, public_id: 'pac_unsigned_mixed_owned', nombre: 'Paquete', apellidos: 'Ficticio',
      numero_historia: String(secondId), historia_scope: `clinic:${ids.clinic}` });
    await db.PacienteClinica.create({ paciente_id: secondId, clinica_id: ids.clinic, es_principal: true });
    await clinic.update({ configuracion: { ...clinic.configuracion, patient_intake: { ...intake, additional_documents: [
      { template_id: template.id, required: true, sort_order: 0 }, { template_id: signedTemplate.id, required: true, sort_order: 1 },
      { template_id: legacy.id, required: false, sort_order: 2 }] } } });
    const mixed = await service.createPatientIntakePackage(secondId, { clinicId: ids.clinic, createdBy: ids.owner });
    const mixedSession = await service.createTabletSession(mixed.package_id), mixedRoute = `/api/consentimientos/public/${encodeURIComponent(mixedSession.public_token)}`;
    const mixedView = await expect('GET', mixedRoute, undefined, undefined, 200);
    const unsigned = mixedView.documents.find(row => row.completion_mode === 'acknowledge');
    const signedDoc = mixedView.documents.find(row => row.title === modelPayload.title && row.id !== unsigned.id && row.required);
    const oldDoc = mixedView.documents.find(row => !row.required);
    assert(unsigned && signedDoc && oldDoc); assert.equal(oldDoc.requires_patient_signature, true, 'Historical false flags retain the signature path');
    const invalidMixed = { acknowledged: true, document_ids: [unsigned.id, signedDoc.id],
      document_snapshot_hashes: { [unsigned.id]: unsigned.snapshot_hash, [signedDoc.id]: signedDoc.snapshot_hash } };
    const beforeMixed = (await f.fingerprint()).sha256;
    await expect('POST', mixedRoute + '/complete', invalidMixed, undefined, 409);
    await expect('POST', mixedRoute + '/complete', { acknowledged: true, document_ids: [oldDoc.id], document_snapshot_hashes: { [oldDoc.id]: oldDoc.snapshot_hash } }, undefined, 409);
    assert.equal((await f.fingerprint()).sha256, beforeMixed, 'Invalid mixed/legacy completion has zero partial writes');
    const unsignedPayload = { acknowledged: true, document_ids: [unsigned.id], document_snapshot_hashes: { [unsigned.id]: unsigned.snapshot_hash } };
    await Promise.all([expect('POST', mixedRoute + '/sign', { ...signature, document_ids: [signedDoc.id] }, undefined, 200),
      expect('POST', mixedRoute + '/complete', unsignedPayload, undefined, 200)]);
    const mixedSigned = JSON.stringify((await db.PatientConsentDocument.findByPk(signedDoc.id)).toJSON());
    const mixedAfter = await expect('GET', mixedRoute, undefined, undefined, 200);
    assert.equal(mixedAfter.package.status, 'completed'); assert.equal(mixedAfter.package.signed_count, 1);
    assert.equal(mixedAfter.package.completed_count, 1); assert.equal(mixedAfter.package.satisfied_count, 2);
    assert.equal(JSON.stringify((await db.PatientConsentDocument.findByPk(signedDoc.id)).toJSON()), mixedSigned);
    await expect('POST', route + '/complete', unsignedPayload, undefined, 404);
    const currentMixed = await db.ConsentSignaturePackage.findByPk(mixed.package_id);
    await currentMixed.update({ status: 'cancelled' });
    await expect('POST', mixedRoute + '/complete', unsignedPayload, undefined, 410);
    await currentMixed.update({ status: 'pending', expires_at: new Date(Date.now() - 1000) });
    await expect('POST', mixedRoute + '/complete', unsignedPayload, undefined, 410);
    const pendingUnsigned = await db.PatientConsentDocument.findByPk(unsigned.id);
    assert(completion.isCompleted(pendingUnsigned), 'Package cancellation never rewrites the historical completed document');

    // A real write failure in the second receipt must roll back the first
    // document, first delivery event and parent counts together.
    const otherUnsigned = await service.createClinicTemplate({ ...modelPayload, name: 'Segundo informativo ficticio' }, ids.owner);
    await clinic.update({ configuracion: { ...clinic.configuracion, patient_intake: { ...intake, additional_documents: [
      { template_id: template.id, required: true, sort_order: 0 }, { template_id: otherUnsigned.id, required: true, sort_order: 1 }] } } });
    const thirdId = 92793;
    await db.Paciente.create({ id_paciente: thirdId, clinica_id: ids.clinic, public_id: 'pac_unsigned_rollback_owned', nombre: 'Rollback', apellidos: 'Ficticio',
      numero_historia: String(thirdId), historia_scope: `clinic:${ids.clinic}` });
    const pair = await service.createPatientIntakePackage(thirdId, { clinicId: ids.clinic, createdBy: ids.owner });
    const pairSession = await service.createTabletSession(pair.package_id), pairRoute = `/api/consentimientos/public/${encodeURIComponent(pairSession.public_token)}`;
    const pairView = await expect('GET', pairRoute, undefined, undefined, 200);
    assert.equal(pairView.documents.length, 2);
    const pairPayload = { acknowledged: true, document_ids: pairView.documents.map(row => row.id),
      document_snapshot_hashes: Object.fromEntries(pairView.documents.map(row => [row.id, row.snapshot_hash])) };
    const lastId = Math.max(...pairPayload.document_ids), pairBefore = (await f.fingerprint()).sha256;
    db.PatientConsentDocument.addHook('beforeBulkUpdate', 'owned_unsigned_rollback', options => {
      if (options.where.id === lastId) throw Error('OWNED_SECOND_COMPLETION_FAILURE');
    });
    try { await expect('POST', pairRoute + '/complete', pairPayload, undefined, 500); }
    finally { db.PatientConsentDocument.removeHook('beforeBulkUpdate', 'owned_unsigned_rollback'); }
    assert.equal((await f.fingerprint()).sha256, pairBefore, 'The first row/event/count are rolled back when the second SQL write fails');
    const expiring = await db.PatientConsentDocument.findByPk(lastId);
    await expiring.update({ expires_at: new Date(Date.now() - 1000) });
    await expect('POST', pairRoute + '/complete', pairPayload, undefined, 410);
    await expiring.update({ expires_at: null, revoked_at: new Date() });
    await expect('POST', pairRoute + '/complete', pairPayload, undefined, 409);
    const firstPair = await db.PatientConsentDocument.findByPk(Math.min(...pairPayload.document_ids));
    assert.equal(firstPair.status, 'viewed', 'Expired or revoked second document cannot partly finalize the first');

    // Required signatures can close the parent as signed while an optional
    // information document is still pending. Reception remains independently
    // completable afterwards; no reopening or fake extra signature is needed.
    await clinic.update({ configuracion: { ...clinic.configuracion, patient_intake: { ...intake, additional_documents: [
      { template_id: signedTemplate.id, required: true, sort_order: 0 }, { template_id: template.id, required: false, sort_order: 1 }] } } });
    const fourthId = 92794;
    await db.Paciente.create({ id_paciente: fourthId, clinica_id: ids.clinic, public_id: 'pac_unsigned_optional_owned', nombre: 'Opcional', apellidos: 'Ficticio',
      numero_historia: String(fourthId), historia_scope: `clinic:${ids.clinic}` });
    const optionalPackage = await service.createPatientIntakePackage(fourthId, { clinicId: ids.clinic, createdBy: ids.owner });
    const optionalSession = await service.createTabletSession(optionalPackage.package_id), optionalRoute = `/api/consentimientos/public/${encodeURIComponent(optionalSession.public_token)}`;
    const optionalView = await expect('GET', optionalRoute, undefined, undefined, 200);
    const requiredSign = optionalView.documents.find(row => row.required), optionalUnsigned = optionalView.documents.find(row => !row.required);
    await expect('POST', optionalRoute + '/sign', { ...signature, document_ids: [requiredSign.id] }, undefined, 200);
    assert.equal((await db.ConsentSignaturePackage.findByPk(optionalPackage.package_id)).status, 'signed');
    const signBeforeOptional = JSON.stringify((await db.PatientConsentDocument.findByPk(requiredSign.id)).toJSON());
    const optionalDone = await expect('POST', optionalRoute + '/complete', { acknowledged: true, document_ids: [optionalUnsigned.id],
      document_snapshot_hashes: { [optionalUnsigned.id]: optionalUnsigned.snapshot_hash } }, undefined, 200);
    assert.equal(optionalDone.package.status, 'completed'); assert.equal(optionalDone.package.signed_count, 1);
    assert.equal(optionalDone.package.completed_count, 1);
    assert.equal(JSON.stringify((await db.PatientConsentDocument.findByPk(requiredSign.id)).toJSON()), signBeforeOptional);
    await assert.rejects(() => require('../../../migrations/20261017180000-add-unsigned-document-completion').down(owned.sql.getQueryInterface()), /rollback_requires_review/);
    for (const model of ['Message', 'FlowExecutionV2', 'JobRequest']) assert.equal(await db[model].count(), 0);
    assert.equal(f.externalFetchAttempts, 0); assert.equal(await db.PatientIntakeRequest.count(), 0);
    owned.report.checks.push('Mixed signed/unsigned/legacy package: scoped independent actions, real signed_count, whole-batch rollback, preserved signatures; stale/cancelled/expired/cross-patient fail; no medical requests, messages, automations, jobs, provider access or patient preference changes');
  } finally { await f.close(); }
}));
