'use strict';
// Real kiosk JWT/router/SQL over the owned, networking-disabled fixture.
const test = require('node:test'), assert = require('node:assert/strict');
const S = require('sequelize');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitAuthAclFixture } = require('./helpers/owned-visit-auth-acl-fixture');

test('kiosk lists pending optional children after required signatures/completions, before LIMIT and within live clinic scope', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: 180000,
}, async () => withIsolatedCampaignMysql(async owned => {
  owned.models.EconomicBudgetSignatureRequest = require('../../../models/economicbudgetsignaturerequest')(owned.sql, S.DataTypes);
  await owned.models.EconomicBudgetSignatureRequest.sync();
  const f = await createOwnedVisitAuthAclFixture({ ...owned, includeConsentRoutes: true });
  const { db, ids, request } = f;
  const service = require('../../services/consentimientos.service');
  const expect = async (method, route, body, token, status = 200) => {
    const result = await request(method, route, body, token);
    assert.equal(result.status, status, JSON.stringify(result.body)); return result.body;
  };
  try {
    const access = await service.createClinicKioskAccess(ids.clinic, ids.owner, { display_name: 'OWNED pending-documents QA' });
    const login = await expect('POST', '/api/consentimientos/tablet/login', { username: access.kiosk.username, password: access.kiosk.one_time_password });
    const list = async (limit = 1) => expect('GET', `/api/consentimientos/tablet/packages?limit=${limit}`, undefined, login.token);
    const signedTemplate = await service.createClinicTemplate({ clinic_id: ids.clinic, name: 'Firma requerida ficticia', purpose: 'other',
      title: 'Documento firmado ficticio', body_html: '<p>Texto de prueba con firma.</p>', status: 'active', validity_mode: 'manual',
      requires_patient_signature: true, requires_representative_when_minor: true, requires_professional_signature: false }, ids.owner);
    const unsignedTemplate = await service.createClinicTemplate({ clinic_id: ids.clinic, name: 'Informativo opcional ficticio', purpose: 'other',
      title: 'Información opcional ficticia', body_html: '<p>Texto informativo de prueba sin firma.</p>', status: 'active', validity_mode: 'manual',
      requires_patient_signature: false, requires_representative_when_minor: false, requires_professional_signature: false,
      body_json: { document_completion: { schema_version: 'cc-document-completion/v1', signature_mode: 'none', completion_mode: 'acknowledge' } } }, ids.owner);
    const clinic = await db.Clinica.findByPk(ids.clinic);
    const intake = { privacy_enabled: false, medical_questionnaire_enabled: false, additional_documents: [
      { template_id: signedTemplate.id, required: true, sort_order: 0 }, { template_id: unsignedTemplate.id, required: false, sort_order: 1 }] };
    await clinic.update({ configuracion: { ...clinic.configuracion, patient_intake: intake } });
    const prepared = await service.createPatientIntakePackage(ids.patient, { clinicId: ids.clinic, createdBy: ids.owner });
    const session = await service.createTabletSession(prepared.package_id);
    const publicRoute = `/api/consentimientos/public/${encodeURIComponent(session.public_token)}`;
    const view = await expect('GET', publicRoute);
    const signatureDoc = view.documents.find(doc => doc.required), optionalDoc = view.documents.find(doc => !doc.required);
    assert(signatureDoc && optionalDoc);
    await expect('POST', publicRoute + '/sign', { document_ids: [signatureDoc.id], signer_name: 'Firmante ficticio', accepted_statement: true,
      signature_data_url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=' });
    assert.equal((await db.ConsentSignaturePackage.findByPk(prepared.package_id)).status, 'signed');
    const shown = await list(); assert.deepEqual(shown.items.map(item => item.id), [prepared.package_id]);
    assert.equal(shown.items[0].pending_count, 1); assert.equal(shown.items[0].signed_count, 1);

    // Newer closed parents and ineligible pending children used to consume
    // LIMIT before JS filtering. None may hide the actual optional document.
    let serial = 0;
    const add = async (packagePatch = {}, documentPatch = null) => {
      const pkg = await db.ConsentSignaturePackage.create({ public_id: `cpkg_owned_pending_filter_${++serial}`,
        paciente_id: ids.patient, clinica_id: ids.clinic, status: 'completed', ...packagePatch });
      if (documentPatch) await db.PatientConsentDocument.create({ public_id: `cdoc_owned_pending_filter_${serial}`, package_id: pkg.id,
        paciente_id: pkg.paciente_id, clinica_id: pkg.clinica_id, title: 'Documento ficticio no elegible', purpose: 'other', status: 'pending',
        ...documentPatch });
      return pkg;
    };
    for (let i = 0; i < 4; i++) await add({ status: i % 2 ? 'signed' : 'completed' });
    await add({ status: 'cancelled' }, {}); await add({ status: 'expired' }, {});
    await add({ status: 'completed', expires_at: new Date(Date.now() - 1000) }, {});
    await add({ status: 'pending' }, { expires_at: new Date(Date.now() - 1000) });
    await add({ status: 'pending' }, { revoked_at: new Date() });
    await add({ status: 'pending' }, { status: 'revoked' });
    await add({ status: 'pending' }, { status: 'cancelled' });
    await add({ status: 'pending' }, { signed_at: new Date() });
    const foreign = await add({ clinica_id: ids.peerClinic, paciente_id: ids.foreignPatient, status: 'completed' }, {});
    const wrongChild = await add({ status: 'pending' }, { clinica_id: ids.peerClinic, paciente_id: ids.foreignPatient });
    const healthOnly = await add({ status: 'pending' });
    await db.PatientIntakeRequest.create({ package_id: healthOnly.id, patient_id: ids.patient, clinic_id: ids.clinic,
      schema_version: 'cc-patient-intake/v1', personal_snapshot: {}, status: 'pending', created_by: ids.owner });
    assert.deepEqual((await list()).items.map(item => item.id), [prepared.package_id], 'Resolved, foreign, disabled-health and expired/revoked/cancelled rows never starve LIMIT=1');

    // A completed parent can also retain a pending optional child (e.g. one
    // required unsigned item was completed earlier): do not lose that queue.
    await db.ConsentSignaturePackage.update({ status: 'completed' }, { where: { id: prepared.package_id } });
    assert.deepEqual((await list()).items.map(item => item.id), [prepared.package_id]);
    await clinic.update({ configuracion: { ...clinic.configuracion, patient_intake: { ...intake, medical_questionnaire_enabled: true } } });
    assert((await list(150)).items.some(item => item.id === healthOnly.id), 'An enabled pending health request remains visible alongside other live documents');
    await clinic.update({ configuracion: { ...clinic.configuracion, patient_intake: intake } });
    const kiosk = await db.ClinicTabletKiosk.findByPk(access.kiosk.id);
    await kiosk.update({ consent_group_id: ids.group });
    const groupView = await list(150);
    assert(groupView.items.some(item => item.id === foreign.id), 'Only the current explicit group grant includes sibling clinic requests');
    assert(!groupView.items.some(item => item.id === wrongChild.id));
    await kiosk.update({ consent_group_id: null });
    assert(!(await list(150)).items.some(item => item.id === foreign.id), 'Removing the device grant takes immediate effect on the same token');

    const beforeList = (await f.fingerprint()).sha256;
    await list(); assert.equal((await f.fingerprint()).sha256, beforeList, 'Queue projection never mutates patient documents, packages, events or jobs');
    await expect('POST', publicRoute + '/complete', { document_ids: [optionalDoc.id],
      document_snapshot_hashes: { [optionalDoc.id]: optionalDoc.snapshot_hash }, acknowledged: true });
    assert.equal((await db.ConsentSignaturePackage.findByPk(prepared.package_id)).status, 'completed');
    assert.deepEqual((await list()).items, [], 'Fully resolved mixed package disappears; no ineligible filler leaks into queue');
    for (const model of ['Message', 'FlowExecutionV2', 'JobRequest']) assert.equal(await db[model].count(), 0);
    assert.equal(f.externalFetchAttempts, 0);
    owned.report.checks.push('Real kiosk login/JWT/HTTP/SQL: signed/completed mixed parent with live optional child remains visible; EXISTS before LIMIT=1 excludes resolved parents and revoked/cancelled/expired/foreign children; current group grant and disabled/enabled health are respected; completing optional removes resolved parent; no business write on listing, provider, message or job');
  } finally { await f.close(); }
}));
