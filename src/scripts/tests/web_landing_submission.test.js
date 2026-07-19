'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const { trustedRuntime } = require('../../lib/webMeasurementRuntime');
const {
  prepareWebLandingSubmission,
} = require('../../services/webLandingSubmission.service');
const {
  buildWebLandingAttributionSteps: buildResolvedLandingAuditSteps,
  longestPublicationMatch,
} = require('../../services/webLandingAttribution.service');
const { measurementFromIntake } = require('../../services/webWordpressInstallations.service');
const {
  PUBLIC_WEB_ARTIFACT_METADATA_ATTRIBUTES,
} = require('../../services/webArtifactMetadata.service');

const IDS = {
  project: '11111111-1111-4111-8111-111111111111',
  revision: '22222222-2222-4222-8222-222222222222',
  page: '33333333-3333-4333-8333-333333333333',
  landingPage: '33333333-3333-4333-8333-333333333334',
  landingText: '33333333-3333-4333-8333-333333333335',
  pageRecord: '33333333-3333-4333-8333-333333333336',
  form: '44444444-4444-4444-8444-444444444444',
  publication: '55555555-5555-4555-8555-555555555555',
  artifact: '66666666-6666-4666-8666-666666666666',
};
const HMAC = '0123456789abcdef0123456789abcdef';

function fixture() {
  const intake = {
    assignment_scope: 'clinic',
    clinic_id: 66,
    hmac_key: HMAC,
    config: {},
  };
  const runtime = trustedRuntime({
    measurement: {
      ...measurementFromIntake(intake),
      api_url: 'https://crm.clinicaclick.com',
    },
  }, { environment: 'production' });
  const formFields = [
    { name: 'first_name', type: 'text', required: true },
    { name: 'last_name', type: 'text', required: false },
    { name: 'email', type: 'email', required: false },
    { name: 'phone', type: 'tel', required: true },
    { name: 'message', type: 'textarea', required: false },
    { name: 'preferred_contact', type: 'select', required: false },
    { name: 'privacy_consent', type: 'checkbox', required: true },
  ];
  const document = {
    pages: [
      { id: IDS.page, slug: 'inicio', root_node_ids: [IDS.form] },
      { id: IDS.landingPage, slug: 'informacion', root_node_ids: [IDS.landingText] },
    ],
    nodes: {
      [IDS.form]: { id: IDS.form, type: 'intake_form', props: { fields: formFields }, children: [] },
      [IDS.landingText]: { id: IDS.landingText, type: 'text', children: [] },
    },
  };
  const revision = { id: IDS.revision, projectId: IDS.project, document };
  const publication = {
    id: IDS.publication,
    projectId: IDS.project,
    activeRevisionId: IDS.revision,
    activeArtifactId: IDS.artifact,
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    host: 'landing.example.test',
    path: '/implantes/',
    status: 'published',
  };
  const artifactHash = 'a'.repeat(64);
  const artifactInputHash = 'b'.repeat(64);
  const artifact = {
    id: IDS.artifact,
    projectId: IDS.project,
    revisionId: IDS.revision,
    environment: 'production',
    status: 'ready',
    artifactHash,
    runtimeConfigHash: runtime.runtime_config_hash,
    manifest: {
      project_id: IDS.project,
      revision_id: IDS.revision,
      environment: 'production',
      artifact_hash: artifactHash,
      artifact_input_hash: artifactInputHash,
      runtime_config_hash: runtime.runtime_config_hash,
      page_routes: {
        [IDS.page]: { page_path: '/' },
        [IDS.landingPage]: { page_path: '/informacion/' },
      },
      intake_forms: {
        [IDS.form]: {
          page_path: '/',
          page_id: IDS.page,
          success_anchor: `cc-${IDS.form}-success`,
          error_anchor: `cc-${IDS.form}-error`,
          fields: formFields,
        },
      },
    },
  };
  const models = {
    WebRevision: { findByPk: async () => revision },
    WebPage: {
      findOne: async () => ({
        id: IDS.pageRecord,
        projectId: IDS.project,
        pageKey: IDS.page,
        slug: 'inicio',
      }),
    },
    WebPublication: {
      findAll: async () => [publication],
      findByPk: async (id) => String(id) === String(publication.id) ? publication : null,
    },
    WebArtifact: { findByPk: async () => artifact },
    Clinica: { findByPk: async () => ({ id_clinica: 66, grupoClinicaId: 7 }) },
    IntakeConfig: {
      findOne: async ({ where }) => where.assignment_scope === 'clinic' ? intake : null,
    },
    ClinicGoogleAdsAccount: { findAll: async () => [] },
    ExternalCampaignAssignment: { findOne: async () => null },
    WebProject: { findByPk: async () => ({ id: IDS.project, campaignContext: null }) },
  };
  const body = {
    first_name: 'Ana',
    last_name: 'Pérez',
    email: 'ANA@EXAMPLE.TEST',
    phone: '+34 600 000 000',
    message: 'Quiero pedir una primera visita.',
    preferred_contact: 'telefono',
    privacy_consent: '1',
    _cc_company: '',
    web_project_id: IDS.project,
    web_revision_id: IDS.revision,
    web_page_id: IDS.page,
    web_form_id: IDS.form,
    web_artifact_input_hash: artifactInputHash,
  };
  const headers = {
    referer: 'https://landing.example.test/implantes/?utm_source=google&utm_medium=cpc&gclid=test-click',
    origin: 'https://landing.example.test',
    'user-agent': 'Clinicaclick test',
    'x-forwarded-for': '198.51.100.99',
  };
  return { artifact, body, headers, models, publication };
}

test('fija identidad web, asignación y estrategia resueltas sin copiar campos del navegador', () => {
  const base = {
    clinic_match_source: 'clinicaclick_web_publication',
    clinic_match_value: IDS.publication,
    resolved_clinic_id: 66,
    resolved_group_id: 7,
  };
  const steps = buildResolvedLandingAuditSteps({
    project_id: IDS.project.toUpperCase(),
    revision_id: IDS.revision,
    page_id: IDS.pageRecord,
    document_page_id: IDS.page,
    publication_id: IDS.publication,
    artifact_id: IDS.artifact,
    artifact_hash: 'A'.repeat(64),
    form_id: IDS.form,
    scope_type: 'CLINIC',
    clinic_id: 66,
    group_id: 7,
    google_ads_customer_id: '1851215478',
    google_ads_campaign_id: '21316904358',
    google_ads_assignment_id: 90,
    strategy_campaign_id: 41,
    campaign_request_id: 42,
    target_kind: 'general',
    target_treatment_id: null,
    email: 'must-not-be-copied@example.test',
    raw_payload: { forged: true },
  }, base);

  assert.deepEqual(steps, {
    ...base,
    web_landing: {
      schema_version: 1,
      identity: {
        project_id: IDS.project,
        revision_id: IDS.revision,
        page_id: IDS.pageRecord,
        document_page_id: IDS.page,
        publication_id: IDS.publication,
        artifact_id: IDS.artifact,
        artifact_hash: 'a'.repeat(64),
        form_id: IDS.form,
        scope_type: 'clinic',
        clinic_id: 66,
        group_id: 7,
      },
      google_ads_assignment: {
        provider: 'google_ads',
        assignment_id: 90,
        customer_id: '1851215478',
        campaign_id: '21316904358',
      },
      strategy: {
        strategy_campaign_id: 41,
        campaign_request_id: 42,
        target_kind: 'generic',
        target_treatment_id: null,
      },
    },
  });
  assert.equal(Object.isFrozen(steps), true);
  assert.equal(Object.isFrozen(steps.web_landing), true);
  assert.equal(Object.isFrozen(steps.web_landing.identity), true);
  assert.equal(Object.hasOwn(steps.web_landing, 'email'), false);
  assert.equal(Object.hasOwn(steps.web_landing, 'raw_payload'), false);

  const quickChatSteps = buildResolvedLandingAuditSteps(null, base);
  assert.deepEqual(quickChatSteps, base);
  assert.equal(Object.hasOwn(quickChatSteps, 'web_landing'), false);
  assert.notEqual(quickChatSteps, base, 'the builder must not mutate or reuse the caller object');
});

test('convierte el formulario firmado en un lead atribuido sin inventar consentimiento publicitario', async () => {
  const state = fixture();
  const result = await prepareWebLandingSubmission({
    body: state.body,
    headers: state.headers,
    remoteAddress: '203.0.113.10',
    models: state.models,
    now: () => new Date('2026-07-17T12:00:00.000Z'),
    randomUUID: () => '77777777-7777-4777-8777-777777777777',
  });
  assert.equal(result.spam, false);
  assert.equal(result.payload.source, 'google_ads');
  assert.equal(result.payload.channel, 'paid');
  assert.equal(result.payload.clinic_id, 66);
  assert.equal(result.payload.nombre, 'Ana Pérez');
  assert.equal(result.payload.email, 'ana@example.test');
  assert.equal(result.payload.ip, '203.0.113.10');
  assert.equal(result.payload.consent.contact, 'granted');
  assert.equal(Object.hasOwn(result.payload.consent, 'ad_user_data'), false);
  assert.equal(result.payload.web_project_id, IDS.project);
  assert.equal(result.payload.web_page_id, IDS.pageRecord);
  assert.equal(result.attribution.document_page_id, IDS.page);
  assert.equal(result.payload.form_submission.form_id, IDS.form);
  assert.equal(result.success_url, `https://landing.example.test/implantes/?gclid=test-click&utm_medium=cpc&utm_source=google#cc-${IDS.form}-success`);
  const expected = crypto.createHmac('sha256', HMAC).update(result.raw_body).digest('hex');
  assert.equal(result.signature, expected);
  assert.deepEqual(JSON.parse(result.raw_body.toString('utf8')), result.payload);
});

test('prepare+submission consulta una sola vez únicamente metadatos del artefacto público', async () => {
  const state = fixture();
  let artifactReads = 0;
  Object.defineProperties(state.artifact, {
    files: { get() { throw new Error('files no debe hidratarse ni leerse'); } },
    qaReport: { get() { throw new Error('qaReport no debe hidratarse ni leerse'); } },
  });
  state.models.WebArtifact.findByPk = async (id, options) => {
    artifactReads += 1;
    assert.equal(id, IDS.artifact);
    assert.deepEqual(options.attributes, [...PUBLIC_WEB_ARTIFACT_METADATA_ATTRIBUTES]);
    assert.equal(options.raw, true);
    return state.artifact;
  };

  const result = await prepareWebLandingSubmission({
    body: state.body,
    headers: state.headers,
    models: state.models,
  });

  assert.equal(result.spam, false);
  assert.equal(result.attribution.artifact_id, IDS.artifact);
  assert.equal(artifactReads, 1, 'submission reutiliza el artefacto validado por attribution');
});

test('root y child del mismo proyecto atribuyen por el prefijo publicado más largo', async () => {
  const state = fixture();
  state.publication.path = '/cita/';
  const childArtifact = {
    ...state.artifact,
    id: '66666666-6666-4666-8666-666666666667',
  };
  const child = {
    ...state.publication,
    id: '55555555-5555-4555-8555-555555555556',
    activeArtifactId: childArtifact.id,
    path: '/cita/implantes/',
  };
  state.models.WebPublication.findAll = async (options) => {
    assert.equal(options.where.host, 'landing.example.test');
    assert.equal(Object.hasOwn(options, 'limit'), false);
    return [state.publication, child];
  };
  state.models.WebPublication.findByPk = async (id) => (
    String(id) === String(child.id) ? child : state.publication
  );
  state.models.WebArtifact.findByPk = async (id) => id === childArtifact.id ? childArtifact : state.artifact;
  state.headers.referer = 'https://landing.example.test/cita/implantes/?gclid=child-click';

  const result = await prepareWebLandingSubmission({
    body: state.body,
    headers: state.headers,
    models: state.models,
  });
  assert.equal(result.attribution.publication_id, child.id);
  assert.equal(result.success_url, `https://landing.example.test/cita/implantes/?gclid=child-click#cc-${IDS.form}-success`);

  const root = longestPublicationMatch(
    [state.publication, child],
    new URL('https://landing.example.test/cita/')
  );
  assert.equal(root.id, state.publication.id);
  assert.equal(longestPublicationMatch([
    state.publication,
    { ...state.publication, id: 'duplicate-root' },
  ], new URL('https://landing.example.test/cita/')), null, 'un empate exacto falla cerrado');
});

test('acepta un formulario global solo mediante el contrato firmado de la página actual', async () => {
  const state = fixture();
  const revision = await state.models.WebRevision.findByPk(IDS.revision);
  revision.document.globals = { header_node_id: IDS.form, footer_node_id: null };
  revision.document.pages[0].root_node_ids = [IDS.landingText];
  const flatContract = state.artifact.manifest.intake_forms[IDS.form];
  state.artifact.manifest.intake_forms[IDS.form] = {
    scope: 'global',
    page_contracts: {
      [IDS.page]: flatContract,
      [IDS.landingPage]: {
        ...flatContract,
        page_path: '/informacion/',
        page_id: IDS.landingPage,
      },
    },
  };
  state.body.web_page_id = IDS.landingPage;
  state.headers.referer = 'https://landing.example.test/implantes/informacion/?gclid=global-click';
  state.models.WebPage.findOne = async () => ({
    id: IDS.pageRecord,
    projectId: IDS.project,
    pageKey: IDS.landingPage,
    slug: 'informacion',
  });

  const result = await prepareWebLandingSubmission({
    body: state.body,
    headers: state.headers,
    models: state.models,
  });

  assert.equal(result.attribution.document_page_id, IDS.landingPage);
  assert.equal(result.attribution.form_id, IDS.form);
  assert.equal(
    result.success_url,
    `https://landing.example.test/implantes/informacion/?gclid=global-click#cc-${IDS.form}-success`
  );

  const missing = fixture();
  const missingRevision = await missing.models.WebRevision.findByPk(IDS.revision);
  missingRevision.document.globals = { header_node_id: IDS.form, footer_node_id: null };
  missing.artifact.manifest.intake_forms[IDS.form] = {
    scope: 'global',
    page_contracts: {},
  };
  await assert.rejects(
    () => prepareWebLandingSubmission({ body: missing.body, headers: missing.headers, models: missing.models }),
    (error) => error.code === 'web_landing_form_contract_invalid'
  );
});

test('rechaza campos extra, origen cruzado y ruta que no coincide con el manifest', async () => {
  const unknown = fixture();
  await assert.rejects(
    () => prepareWebLandingSubmission({ body: { ...unknown.body, clinic_id: '999' }, headers: unknown.headers, models: unknown.models }),
    (error) => error.code === 'web_landing_field_unknown'
  );
  const crossed = fixture();
  crossed.headers.origin = 'https://evil.example.test';
  await assert.rejects(
    () => prepareWebLandingSubmission({ body: crossed.body, headers: crossed.headers, models: crossed.models }),
    (error) => error.code === 'web_landing_origin_mismatch'
  );
  const wrongPath = fixture();
  wrongPath.headers.referer = 'https://landing.example.test/implantes/otra/';
  wrongPath.headers.origin = 'https://landing.example.test';
  await assert.rejects(
    () => prepareWebLandingSubmission({ body: wrongPath.body, headers: wrongPath.headers, models: wrongPath.models }),
    (error) => error.code === 'web_landing_page_path_mismatch'
  );
});

test('el honeypot simula éxito pero no construye ni firma un lead', async () => {
  const state = fixture();
  state.body._cc_company = 'spam';
  const result = await prepareWebLandingSubmission({ body: state.body, headers: state.headers, models: state.models });
  assert.equal(result.spam, true);
  assert.equal(result.payload, undefined);
  assert.match(result.success_url, new RegExp(`#cc-${IDS.form}-success$`));
});

test('propaga las decisiones publicitarias explícitas que anota el loader', async () => {
  const state = fixture();
  state.body._cc_ad_user_data = 'granted';
  state.body._cc_ad_personalization = 'denied';
  const result = await prepareWebLandingSubmission({ body: state.body, headers: state.headers, models: state.models });
  assert.equal(result.payload.consent.contact, 'granted');
  assert.equal(result.payload.consent.ad_user_data, 'granted');
  assert.equal(result.payload.consent.ad_personalization, 'denied');
});

test('conserva la atribución de la primera página al enviar desde otra página publicada', async () => {
  const state = fixture();
  state.headers.referer = 'https://landing.example.test/implantes/';
  state.body._cc_attr_landing_path = '/implantes/informacion/';
  state.body._cc_attr_gclid = 'stored-click';
  state.body._cc_attr_utm_source = 'google';
  state.body._cc_attr_utm_medium = 'cpc';
  state.body._cc_attr_utm_campaign = 'implantes barcelona';
  const result = await prepareWebLandingSubmission({ body: state.body, headers: state.headers, models: state.models });
  assert.equal(result.payload.source, 'google_ads');
  assert.equal(result.payload.gclid, 'stored-click');
  assert.equal(result.payload.page_url, 'https://landing.example.test/implantes/?gclid=stored-click&utm_campaign=implantes+barcelona&utm_medium=cpc&utm_source=google');
  assert.equal(result.payload.landing_url, 'https://landing.example.test/implantes/informacion/?gclid=stored-click&utm_campaign=implantes+barcelona&utm_medium=cpc&utm_source=google');
  assert.equal(result.payload.attribution.landing_url, result.payload.landing_url);
});

test('la query actual prevalece y rechaza click IDs o rutas iniciales manipuladas', async () => {
  const current = fixture();
  current.body._cc_attr_gclid = 'stored-click';
  current.headers.referer = 'https://landing.example.test/implantes/?gclid=current-click';
  const result = await prepareWebLandingSubmission({ body: current.body, headers: current.headers, models: current.models });
  assert.equal(result.payload.gclid, 'current-click');

  const invalidClick = fixture();
  invalidClick.body._cc_attr_gclid = 'not allowed';
  await assert.rejects(
    () => prepareWebLandingSubmission({ body: invalidClick.body, headers: invalidClick.headers, models: invalidClick.models }),
    (error) => error.code === 'web_landing_attribution_invalid'
  );

  const spoofedPath = fixture();
  spoofedPath.body._cc_attr_landing_path = '/implantes/no-publicada/';
  await assert.rejects(
    () => prepareWebLandingSubmission({ body: spoofedPath.body, headers: spoofedPath.headers, models: spoofedPath.models }),
    (error) => error.code === 'web_landing_attribution_landing_mismatch'
  );

  const traversal = fixture();
  traversal.body._cc_attr_landing_path = '/implantes/%2e%2e/';
  await assert.rejects(
    () => prepareWebLandingSubmission({ body: traversal.body, headers: traversal.headers, models: traversal.models }),
    (error) => error.code === 'web_landing_attribution_landing_invalid'
  );
});

test('rechaza un page_routes firmado que no coincide exactamente con la revisión', async () => {
  const state = fixture();
  state.artifact.manifest.page_routes[IDS.landingPage] = { page_path: '/otra/' };
  await assert.rejects(
    () => prepareWebLandingSubmission({ body: state.body, headers: state.headers, models: state.models }),
    (error) => error.code === 'web_landing_form_contract_invalid'
  );
});

test('no persiste el pageKey del navegador como FK y exige la proyección WebPage canónica', async () => {
  const state = fixture();
  state.models.WebPage.findOne = async () => null;
  await assert.rejects(
    () => prepareWebLandingSubmission({ body: state.body, headers: state.headers, models: state.models }),
    (error) => error.code === 'web_landing_page_projection_invalid'
  );
});

test('sin HMAC de intake no publica un formulario aparentemente operativo', async () => {
  const state = fixture();
  state.models.IntakeConfig.findOne = async () => null;
  await assert.rejects(
    () => prepareWebLandingSubmission({ body: state.body, headers: state.headers, models: state.models }),
    (error) => error.code === 'web_landing_intake_not_configured' && error.status === 503
  );

  const short = fixture();
  short.models.IntakeConfig.findOne = async () => ({
    assignment_scope: 'clinic',
    clinic_id: 66,
    hmac_key: 'short',
  });
  await assert.rejects(
    () => prepareWebLandingSubmission({ body: short.body, headers: short.headers, models: short.models }),
    (error) => error.code === 'web_landing_intake_not_configured' && error.status === 503
  );
});

test('autoriza cuenta y campaña antes de conservar una atribución Google Ads inequívoca', async () => {
  const state = fixture();
  const calls = [];
  state.headers.referer = 'https://landing.example.test/implantes/?gclid=real-click&cc_gads_customer_id=1851215478&cc_gads_campaign_id=21316904358';
  state.models.ClinicGoogleAdsAccount.findAll = async (options) => {
    calls.push(['account', options]);
    return [{
      id: 8,
      assignmentScope: 'group',
      grupoClinicaId: 7,
      clinicaId: 1,
      customerId: '1851215478',
      isActive: true,
    }];
  };
  state.models.ExternalCampaignAssignment.findOne = async (options) => {
    calls.push(['assignment', options]);
    return {
      id: 90,
      provider: 'google_ads',
      customer_id: '1851215478',
      campaign_id: '21316904358',
      grupo_clinica_id: 7,
      clinica_id: 66,
      status: 'active',
      strategy_campaign_id: 41,
      campaign_request_id: 42,
      target_kind: 'generic',
      target_treatment_id: null,
    };
  };
  state.models.WebProject.findByPk = async () => ({
    id: IDS.project,
    campaignContext: { strategy_id: 41, target_kind: 'general', treatment_id: null },
  });

  const result = await prepareWebLandingSubmission({ body: state.body, headers: state.headers, models: state.models });
  assert.equal(result.payload.google_ads_customer_id, '1851215478');
  assert.equal(result.payload.google_ads_campaign_id, '21316904358');
  assert.equal(result.payload.attribution.google_ads_assignment_id, 90);
  assert.equal(result.payload.attribution.strategy_campaign_id, 41);
  assert.equal(result.attribution.strategy_campaign_id, 41);
  const canonical = new URL(result.payload.page_url);
  assert.equal(canonical.searchParams.get('cc_gads_customer_id'), '1851215478');
  assert.equal(canonical.searchParams.get('cc_gads_campaign_id'), '21316904358');
  assert.equal(canonical.searchParams.has('google_ads_customer_id'), false);
  assert.deepEqual(calls[0][1].where, { customerId: '1851215478', isActive: true });
  assert.deepEqual(calls[1][1].where, {
    provider: 'google_ads',
    customer_id: '1851215478',
    campaign_id: '21316904358',
    clinica_id: 66,
    status: 'active',
  });
});

test('resuelve una asignación legacy sin target desde la campaña exacta elegida en la estrategia', async () => {
  const state = fixture();
  state.headers.referer = 'https://landing.example.test/implantes/?cc_gads_customer_id=1851215478&cc_gads_campaign_id=21316904358';
  state.models.ClinicGoogleAdsAccount.findAll = async () => [{
    id: 8,
    assignmentScope: 'group',
    grupoClinicaId: 7,
    customerId: '1851215478',
    isActive: true,
  }];
  state.models.ExternalCampaignAssignment.findOne = async () => ({
    id: 90,
    provider: 'google_ads',
    customer_id: '1851215478',
    campaign_id: '21316904358',
    grupo_clinica_id: 7,
    clinica_id: 66,
    status: 'active',
    strategy_campaign_id: null,
    campaign_request_id: null,
    target_kind: null,
    target_treatment_id: null,
  });
  state.models.WebProject.findByPk = async () => ({
    id: IDS.project,
    campaignContext: { strategy_id: 41, target_kind: 'general', treatment_id: null },
  });
  state.models.CampaignRequest = {
    findAll: async (options) => {
      assert.deepEqual(options.where, { campaign_id: 41, clinica_id: 66 });
      return [{
        id: 42,
        campaign_id: 41,
        clinica_id: 66,
        solicitud: {
          kind: 'marketing_strategy',
          objective_id: 'new_patients',
          external_targets: [{
            kind: 'generic',
            treatment_id: null,
            campaigns: [{
              provider: 'google_ads',
              customer_id: '1851215478',
              campaign_id: '21316904358',
            }],
          }],
        },
      }];
    },
  };

  const result = await prepareWebLandingSubmission({ body: state.body, headers: state.headers, models: state.models });
  assert.equal(result.attribution.strategy_campaign_id, 41);
  assert.equal(result.attribution.campaign_request_id, 42);
  assert.equal(result.attribution.target_kind, 'generic');
  assert.equal(result.payload.attribution.google_ads_assignment_id, 90);
});

test('no usa el fallback legacy si la campaña no pertenece al target exacto de la landing', async () => {
  const state = fixture();
  state.headers.referer = 'https://landing.example.test/implantes/?cc_gads_customer_id=1851215478&cc_gads_campaign_id=21316904358';
  state.models.ClinicGoogleAdsAccount.findAll = async () => [{
    assignmentScope: 'group', grupoClinicaId: 7, customerId: '1851215478', isActive: true,
  }];
  state.models.ExternalCampaignAssignment.findOne = async () => ({
    id: 90, provider: 'google_ads', customer_id: '1851215478', campaign_id: '21316904358',
    grupo_clinica_id: 7, clinica_id: 66, status: 'active',
  });
  state.models.WebProject.findByPk = async () => ({
    id: IDS.project,
    campaignContext: { strategy_id: 41, target_kind: 'general', treatment_id: null },
  });
  state.models.CampaignRequest = {
    findAll: async () => [{
      id: 42,
      campaign_id: 41,
      clinica_id: 66,
      solicitud: {
        kind: 'marketing_strategy',
        objective_id: 'new_patients',
        external_targets: [{
          kind: 'generic',
          campaigns: [{ provider: 'google_ads', customer_id: '1851215478', campaign_id: '99999999999' }],
        }],
      },
    }],
  };
  await assert.rejects(
    () => prepareWebLandingSubmission({ body: state.body, headers: state.headers, models: state.models }),
    (error) => error.code === 'web_landing_google_strategy_mismatch'
  );
});

test('rechaza IDs Google incompletos, no canónicos o ajenos a la clínica', async () => {
  const incomplete = fixture();
  incomplete.headers.referer = 'https://landing.example.test/implantes/?cc_gads_customer_id=1851215478';
  await assert.rejects(
    () => prepareWebLandingSubmission({ body: incomplete.body, headers: incomplete.headers, models: incomplete.models }),
    (error) => error.code === 'web_landing_google_attribution_incomplete'
  );

  const malformed = fixture();
  malformed.body._cc_attr_cc_gads_customer_id = '185-121-5478';
  malformed.body._cc_attr_cc_gads_campaign_id = '21316904358';
  await assert.rejects(
    () => prepareWebLandingSubmission({ body: malformed.body, headers: malformed.headers, models: malformed.models }),
    (error) => error.code === 'web_landing_attribution_invalid'
  );

  const unauthorized = fixture();
  unauthorized.headers.referer = 'https://landing.example.test/implantes/?cc_gads_customer_id=1851215478&cc_gads_campaign_id=21316904358';
  unauthorized.models.ClinicGoogleAdsAccount.findAll = async () => [{
    id: 9,
    assignmentScope: 'clinic',
    clinicaId: 55,
    customerId: '1851215478',
    isActive: true,
  }];
  await assert.rejects(
    () => prepareWebLandingSubmission({ body: unauthorized.body, headers: unauthorized.headers, models: unauthorized.models }),
    (error) => error.code === 'web_landing_google_account_unauthorized'
  );
});
