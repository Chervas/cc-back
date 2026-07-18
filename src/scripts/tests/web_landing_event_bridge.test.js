'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { trustedRuntime } = require('../../lib/webMeasurementRuntime');
const { measurementFromIntake } = require('../../services/webWordpressInstallations.service');
const {
  prepareWebLandingEventBridge,
} = require('../../services/webLandingEventBridge.service');

const IDS = {
  project: '11111111-1111-4111-8111-111111111111',
  revision: '22222222-2222-4222-8222-222222222222',
  page: '33333333-3333-4333-8333-333333333333',
  pageProjection: '44444444-4444-4444-8444-444444444444',
  publication: '55555555-5555-4555-8555-555555555555',
  artifact: '66666666-6666-4666-8666-666666666666',
};
const HMAC = '0123456789abcdef0123456789abcdef';
const ENV = { MARKETING_WEB_API_BASE_URL: 'https://crm.clinicaclick.com' };

function fixture(endpoint = 'events') {
  const intake = {
    assignment_scope: 'clinic',
    clinic_id: 66,
    hmac_key: HMAC,
    config: { features: { consent_provider: 'external_cmp' } },
  };
  const measurement = measurementFromIntake(intake);
  const runtime = trustedRuntime({
    measurement: { ...measurement, api_url: ENV.MARKETING_WEB_API_BASE_URL },
  }, { environment: 'production' });
  const publication = {
    id: IDS.publication,
    projectId: IDS.project,
    activeRevisionId: IDS.revision,
    activeArtifactId: IDS.artifact,
    scopeType: 'clinic',
    clinicaId: 66,
    host: 'landing.example.test',
    path: '/implantes/',
    status: 'published',
  };
  const artifactHash = 'a'.repeat(64);
  const artifact = {
    id: IDS.artifact,
    projectId: IDS.project,
    revisionId: IDS.revision,
    environment: 'production',
    status: 'ready',
    artifactHash,
    manifest: {
      project_id: IDS.project,
      revision_id: IDS.revision,
      artifact_hash: artifactHash,
      runtime_config_hash: runtime.runtime_config_hash,
      page_routes: { [IDS.page]: { page_path: '/' } },
    },
  };
  const models = {
    WebRevision: { findByPk: async () => ({
      id: IDS.revision,
      projectId: IDS.project,
      document: { pages: [{ id: IDS.page, slug: 'inicio' }] },
    }) },
    WebPage: { findOne: async () => ({
      id: IDS.pageProjection,
      projectId: IDS.project,
      pageKey: IDS.page,
      slug: 'inicio',
    }) },
    WebPublication: { findAll: async () => [publication] },
    WebArtifact: { findByPk: async () => artifact },
    Clinica: { findByPk: async () => ({ id_clinica: 66, grupoClinicaId: 7, estado_clinica: 1 }) },
    IntakeConfig: { findOne: async ({ where }) => where.assignment_scope === 'clinic' ? intake : null },
    ClinicGoogleAdsAccount: { findAll: async () => [] },
    ExternalCampaignAssignment: { findOne: async () => null },
    WebProject: { findByPk: async () => ({ id: IDS.project, campaignContext: null }) },
  };
  return {
    artifact,
    body: {
      schema_version: 1,
      endpoint,
      payload: {
        clinic_id: 999,
        group_id: 888,
        domain: 'evil.example.test',
        page_url: 'https://evil.example.test/',
        event_name: 'CallInitiated',
        event_data: { clicked_tel: '+34600000000' },
      },
      web_project_id: IDS.project,
      web_revision_id: IDS.revision,
      web_page_id: IDS.page,
    },
    headers: {
      referer: 'https://landing.example.test/implantes/?gclid=real-click',
      origin: 'https://landing.example.test',
    },
    intake,
    models,
  };
}

test('firma server-side y sustituye scope, host y URL elegidos por el navegador', async () => {
  const state = fixture('events');
  const result = await prepareWebLandingEventBridge({ ...state, env: ENV });
  assert.equal(result.endpoint, 'events');
  assert.equal(result.payload.clinic_id, 66);
  assert.equal(result.payload.group_id, 7);
  assert.equal(result.payload.domain, 'landing.example.test');
  assert.equal(result.payload.page_url, state.headers.referer);
  assert.equal(result.payload.event_source_url, state.headers.referer);
  assert.equal(Object.hasOwn(result.payload, 'web_project_id'), false);
  assert.deepEqual(result.attribution, {
    project_id: IDS.project,
    revision_id: IDS.revision,
    page_id: IDS.pageProjection,
    document_page_id: IDS.page,
    publication_id: IDS.publication,
    artifact_id: IDS.artifact,
    artifact_hash: state.artifact.artifactHash,
    form_id: null,
    scope_type: 'clinic',
    clinic_id: 66,
    group_id: 7,
  });
  assert.equal(
    result.signature,
    crypto.createHmac('sha256', HMAC).update(result.raw_body).digest('hex')
  );
});

test('el mismo contrato cubre leads de chat y el registro previo de WhatsApp', async () => {
  for (const endpoint of ['leads', 'whatsapp-origin']) {
    const state = fixture(endpoint);
    if (endpoint === 'leads') state.body.payload.lead_data = { telefono: '+34600000000' };
    if (endpoint === 'whatsapp-origin') state.body.payload.ref = 'abcdef1234567890';
    const result = await prepareWebLandingEventBridge({ ...state, env: ENV });
    assert.equal(result.endpoint, endpoint);
    assert.equal(result.payload.clinic_id, 66);
    assert.equal(result.payload.domain, 'landing.example.test');
    assert.equal(
      result.signature,
      crypto.createHmac('sha256', HMAC).update(result.raw_body).digest('hex')
    );
  }
});

test('rechaza origen cruzado, endpoint libre y runtime distinto al artefacto aprobado', async () => {
  const crossed = fixture();
  crossed.headers.origin = 'https://evil.example.test';
  await assert.rejects(
    () => prepareWebLandingEventBridge({ ...crossed, env: ENV }),
    (error) => error.code === 'web_event_bridge_origin_mismatch'
  );

  const endpoint = fixture();
  endpoint.body.endpoint = '../admin';
  await assert.rejects(
    () => prepareWebLandingEventBridge({ ...endpoint, env: ENV }),
    (error) => error.code === 'web_event_bridge_endpoint_invalid'
  );

  const drift = fixture();
  drift.artifact.manifest.runtime_config_hash = 'f'.repeat(64);
  await assert.rejects(
    () => prepareWebLandingEventBridge({ ...drift, env: ENV }),
    (error) => error.code === 'web_event_bridge_runtime_drift'
  );
});

test('no construye el relay si desaparece o se invalida el HMAC de intake', async () => {
  for (const hmacKey of ['', 'short']) {
    const state = fixture();
    state.intake.hmac_key = hmacKey;
    await assert.rejects(
      () => prepareWebLandingEventBridge({ ...state, env: ENV }),
      (error) => error.code === 'web_event_bridge_runtime_drift'
    );
  }
});
