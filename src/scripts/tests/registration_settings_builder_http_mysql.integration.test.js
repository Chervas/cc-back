'use strict';
// Reproduce the Settings -> editor -> library -> Settings round trip against
// native HTTP/auth/ACL and a private, disposable mysqld. No production model
// index, provider socket, email delivery or application worker is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { withIsolatedCampaignMysql } = require('./fixtures/isolated_campaign_mysql.fixture');
const { createOwnedVisitAuthAclFixture } = require('./helpers/owned-visit-auth-acl-fixture');
const registration = require('../../lib/registration-privacy-template');

const legalController = {
  legal_name: 'Clínica ficticia de pruebas de alta', tax_id: 'QA-NO-REAL',
  address: 'Dirección ficticia de pruebas', email: 'privacy@example.invalid',
  phone: '+34000000001', dpo_name: '', dpo_email: '',
};
const identityKeys = ['nombre', 'apellidos', 'dni', 'fecha_nacimiento', 'compania', 'direccion',
  'codigo_postal', 'ciudad', 'provincia', 'telefono', 'telefono2', 'email'];
function editorPayload(draft, clinicId, status) {
  return {
    name: 'LOPD ficticia del constructor', title: draft.title, purpose: 'data_protection', status,
    blocking_policy: 'hard', validity_mode: 'manual', requires_patient_signature: true,
    requires_representative_when_minor: true, requires_professional_signature: false,
    clinica_id: clinicId, apply_to_group: false, tratamiento_ids: [], locale: 'es',
    body_html: draft.body_html,
    body_json: { ...draft.body_json, document_blocks: { schema_version: 'cc-document-blocks/v1', blocks: [
      { id: 'patient_identity', type: 'patient_data', fields: identityKeys },
      { id: 'legal_text', type: 'text', html: draft.body_html },
      { id: 'authorizations', type: 'decisions' }, { id: 'signature', type: 'signature' },
    ] } }, variable_schema: { consent_form: draft.body_json.consent_form },
  };
}

// Optional visual QA bridge. The browser owner redirects only the allowlisted
// synthetic API requests here; an independent random bridge credential is kept
// in a 0600 file. Native fixture JWTs remain solely in this process's memory.
async function holdBrowserBridge({ f, owned, owner, credentialsPath }) {
  const { db } = f;
  const clinicId = 1;
  assert(path.isAbsolute(credentialsPath));
  assert(fs.statSync(path.dirname(credentialsPath)).isDirectory());
  assert.equal(fs.statSync(path.dirname(credentialsPath)).uid, process.getuid());
  assert(!fs.existsSync(credentialsPath), 'Do not overwrite an existing credentials artifact');
  await db.Clinica.create({ id_clinica: clinicId, grupoClinicaId: f.ids.group,
    nombre_clinica: 'Clínica 1 · QA aislada (sin pacientes reales)', configuracion: { timezone: 'Europe/Madrid', patient_intake: {
      privacy_enabled: false, privacy_template_id: null, privacy_before_first_care: true,
      medical_questionnaire_enabled: false, additional_documents: [], privacy_controller: legalController,
    } } });
  await db.UsuarioClinica.create({ id_usuario: f.ids.owner, id_clinica: clinicId,
    rol_clinica: 'propietario', estado_invitacion: 'aceptada' });
  const bridgeKey = crypto.randomBytes(32).toString('hex');
  const audit = [];
  let stop;
  const stopped = new Promise(resolve => { stop = resolve; });
  const server = http.createServer(async (req, res) => {
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.headers['x-owned-fixture-key'] !== bridgeKey) return send(401, { code: 'owned_fixture_credential_required' });
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'POST' && url.pathname === '/__owned__/stop') {
        send(200, { stopping: true }); return stop('parent_requested');
      }
      if (req.method === 'GET' && url.pathname === '/__owned__/status') {
        return send(200, { clinic_id: clinicId, native_requests: f.requests, bridge_requests: audit,
          templates: await db.ClinicConsentTemplate.count({ where: { clinic_id: clinicId } }),
          provider_requests: f.externalFetchAttempts });
      }
      const settings = `/api/clinicas/${clinicId}/patient-intake-settings`;
      const valid = (url.pathname === settings && ['GET', 'PUT'].includes(req.method))
        || (url.pathname === settings + '/standard-template-draft' && req.method === 'GET')
        || (url.pathname === '/api/consentimientos/clinic/templates' && ['GET', 'POST'].includes(req.method))
        || (/^\/api\/consentimientos\/clinic\/templates\/[1-9]\d*$/.test(url.pathname) && req.method === 'PUT');
      if (!valid) return send(403, { code: 'owned_fixture_route_forbidden' });
      let raw = '';
      for await (const chunk of req) {
        raw += chunk;
        if (Buffer.byteLength(raw) > 1000000) return send(413, { code: 'owned_fixture_body_too_large' });
      }
      const body = raw ? JSON.parse(raw) : undefined;
      if (url.pathname === '/api/consentimientos/clinic/templates') {
        if (req.method === 'GET' && Number(url.searchParams.get('clinica_id') || url.searchParams.get('clinic_id')) !== clinicId)
          return send(403, { code: 'owned_fixture_scope_forbidden' });
        if (req.method === 'POST' && (Number(body?.clinica_id ?? body?.clinic_id) !== clinicId || body?.apply_to_group === true))
          return send(403, { code: 'owned_fixture_scope_forbidden' });
      }
      if (req.method === 'PUT' && url.pathname.startsWith('/api/consentimientos/clinic/templates/')) {
        const template = await db.ClinicConsentTemplate.findByPk(Number(url.pathname.split('/').pop()));
        if (Number(template?.clinic_id) !== clinicId || body?.apply_to_group === true)
          return send(403, { code: 'owned_fixture_scope_forbidden' });
      }
      const response = await f.request(req.method, url.pathname + url.search, body, owner);
      audit.push({ method: req.method, pathname: url.pathname, status: response.status });
      return send(response.status, response.body);
    } catch (error) { return send(500, { code: 'owned_fixture_bridge_error', message: error.message }); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  owned.registerOwnedLoopbackServer(server);
  fs.writeFileSync(credentialsPath, JSON.stringify({ baseUrl: `http://127.0.0.1:${server.address().port}`,
    bridgeKey, clinicId, fixtureRoot: owned.report.root }, null, 2), { mode: 0o600, flag: 'wx' });
  const timer = setTimeout(() => stop('timeout_30_minutes'), 30 * 60000);
  timer.unref();
  try {
    const reason = await stopped;
    owned.report.browserBridge = { reason, clinic_id: clinicId, requests: audit };
    assert.equal(f.externalFetchAttempts, 0);
    const state = await f.request('GET', settingsPath(clinicId), undefined, owner);
    assert.equal(state.status, 200);
    owned.report.browserBridge.finalSettings = state.body.patient_intake;
    owned.report.browserBridge.finalTemplates = state.body.templates;
  } finally {
    clearTimeout(timer);
    await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
  }
}
function settingsPath(clinicId) { return `/api/clinicas/${clinicId}/patient-intake-settings`; }

test('native settings editor round trip: explicit draft vs active, published versions, clinic scope and persisted selection', {
  skip: process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST !== '1', timeout: process.env.REGISTRATION_SETTINGS_BROWSER_HOLD === '1' ? 1900000 : 180000,
}, async () => withIsolatedCampaignMysql(async owned => {
  const f = await createOwnedVisitAuthAclFixture({ ...owned, includeConsentRoutes: true, includePatientIntakeSettingsRoutes: true });
  const { db, ids, request } = f;
  const expect = async (method, route, body, token, status) => {
    const response = await request(method, route, body, token);
    assert.equal(response.status, status, JSON.stringify(response.body)); return response.body;
  };
  const login = async id => {
    const started = await expect('POST', '/api/auth/sign-in', { email: `owned-${id}@example.invalid`, password: f.password }, undefined, 202);
    const contract = require('../../services/authEmailChallenge.contract');
    const challenge = await db.AuthEmailChallenge.findOne({ where: { challenge_hash: contract.challengeHash(started.challengeToken) } });
    return (await expect('POST', '/api/auth/email-code/verify', { challengeToken: started.challengeToken,
      code: f.codeFor(challenge.challenge_id) }, undefined, 200)).token;
  };
  try {
    const owner = await login(ids.owner), outsider = await login(ids.outsider);
    const route = settingsPath(ids.clinic);
    const initial = await expect('GET', route, undefined, owner, 200);
    const beforeDraft = { templates: await db.ClinicConsentTemplate.count(), versions: await db.ClinicConsentTemplateVersion.count(),
      events: await db.PatientOperationalEvent.count() };
    const draft = await expect('GET', route + '/standard-template-draft', undefined, owner, 200);
    assert.deepEqual({ templates: await db.ClinicConsentTemplate.count(), versions: await db.ClinicConsentTemplateVersion.count(),
      events: await db.PatientOperationalEvent.count() }, beforeDraft);
    assert.equal((await expect('GET', route, undefined, owner, 200)).version, initial.version);

    // This is exactly the old editor status: draft, with no version_status.
    // The API returns/preserves it; the UI correctly may not request it yet.
    const draftCreated = await expect('POST', '/api/consentimientos/clinic/templates', editorPayload(draft, ids.clinic, 'draft'), owner, 201);
    assert.equal(draftCreated.status, 'draft');
    assert.equal(draftCreated.purpose, 'data_protection');
    assert.equal(draftCreated.clinic_id, ids.clinic);
    assert.equal(draftCreated.versions.length, 1);
    assert.equal(draftCreated.versions[0].status, 'published', 'Template lifecycle and version publication are distinct API fields');
    const afterDraft = await expect('GET', route, undefined, owner, 200);
    assert.equal(afterDraft.templates.find(row => row.id === draftCreated.id).status, 'draft');
    assert.equal(afterDraft.templates.find(row => row.id === draftCreated.id).published, true);
    assert.equal(afterDraft.patient_intake.privacy_template_id, null);
    assert.equal(afterDraft.version, initial.version, 'Saving a library document does not mutate Settings');
    const selected = { privacy_enabled: true, privacy_template_id: draftCreated.id, privacy_before_first_care: true,
      medical_questionnaire_enabled: false, additional_documents: [], privacy_controller: legalController };
    const invalid = await expect('PUT', route, { patient_intake: selected, expected_version: initial.version }, owner, 400);
    assert.equal(invalid.code, 'patient_intake_privacy_template_unpublished');
    assert.equal((await expect('GET', route, undefined, owner, 200)).version, initial.version);

    // Metadata activation does not silently create/replace a legal version.
    const active = await expect('PUT', '/api/consentimientos/clinic/templates/' + draftCreated.id, { status: 'active' }, owner, 200);
    assert.equal(active.status, 'active'); assert.equal(active.versions.length, 1);
    const refreshed = await expect('GET', route, undefined, owner, 200);
    const option = refreshed.templates.find(row => row.id === active.id);
    assert.equal(option.status, 'active'); assert.equal(option.published, true); assert.equal(option.version_status, 'published');
    assert.equal(refreshed.patient_intake.privacy_template_id, null, 'Activation alone does not replace the configured notice');
    const persisted = await expect('PUT', route, { patient_intake: selected, expected_version: refreshed.version }, owner, 200);
    assert.equal(persisted.patient_intake.privacy_template_id, active.id);
    const reloaded = await expect('GET', route, undefined, owner, 200);
    assert.deepEqual(reloaded.patient_intake, persisted.patient_intake);
    assert.equal(reloaded.version, persisted.version);
    const reopen = await expect('GET', '/api/consentimientos/clinic/templates?clinica_id=' + ids.clinic, undefined, owner, 200);
    const reopened = reopen.find(row => row.id === active.id);
    assert.equal(reopened.status, 'active'); assert.equal(reopened.versions.length, 1);
    assert.deepEqual(reopened.versions[0].body_json.document_blocks, draftCreated.versions[0].body_json.document_blocks);
    await expect('GET', route, undefined, outsider, 403);
    await expect('POST', '/api/consentimientos/clinic/templates', editorPayload(draft, ids.clinic, 'active'), outsider, 403);

    // The corrected Settings CTA can create an active, published model in one
    // save; the subsequent Settings save remains explicit and CAS-protected.
    const direct = await expect('POST', '/api/consentimientos/clinic/templates', {
      ...editorPayload(draft, ids.clinic, 'active'), name: 'LOPD activa ficticia desde Ajustes',
    }, owner, 201);
    assert.equal(direct.status, 'active'); assert(direct.versions.some(row => row.status === 'published'));
    const afterDirect = await expect('GET', route, undefined, owner, 200);
    assert.equal(afterDirect.templates.find(row => row.id === direct.id).published, true);
    assert.equal(afterDirect.patient_intake.privacy_template_id, active.id, 'No implicit replacement on new document save');
    const final = await expect('PUT', route, { patient_intake: { ...selected, privacy_template_id: direct.id }, expected_version: afterDirect.version }, owner, 200);
    assert.equal((await expect('GET', route, undefined, owner, 200)).patient_intake.privacy_template_id, direct.id);
    assert.notEqual(final.version, afterDirect.version);
    await expect('PUT', route, { patient_intake: selected, expected_version: afterDirect.version }, owner, 409);
    assert.equal(await db.ConsentSignaturePackage.count(), 0); assert.equal(await db.PatientConsentDocument.count(), 0);
    assert.equal(await db.ConsentDeliveryEvent.count(), 0); assert.equal(f.externalFetchAttempts, 0);
    owned.report.checks.push('Native MFA/JWT/ACL HTTP: read-only standard draft; old draft save is returned but intentionally not selectable; active+published create/update appears immediately; Settings assignment explicit/CAS and survives GET/reopen; no issuance/provider calls');
    owned.report.roundTrip = { draft_template_id: draftCreated.id, active_template_id: direct.id,
      old_editor_status: draftCreated.status, old_editor_version_status: draftCreated.versions[0].status,
      initial_configured_id: initial.patient_intake.privacy_template_id, final_configured_id: final.patient_intake.privacy_template_id };
    if (process.env.REGISTRATION_SETTINGS_BROWSER_HOLD === '1') {
      assert(process.env.REGISTRATION_SETTINGS_BROWSER_CREDENTIALS, 'Explicit private credentials output is required');
      await holdBrowserBridge({ f, owned, owner, credentialsPath: process.env.REGISTRATION_SETTINGS_BROWSER_CREDENTIALS });
    }
  } finally { await f.close(); }
}));
