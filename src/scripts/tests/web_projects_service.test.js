'use strict';

const crypto = require('node:crypto');

process.env.MARKETING_WEB_EDITOR_ENABLED = 'true';
process.env.MARKETING_WEB_PUBLISHING_ENABLED = 'true';
delete process.env.MARKETING_WEB_PUBLISHING_SCOPES;
process.env.MARKETING_WEB_API_BASE_URL = 'https://crm.clinicaclick.com';
process.env.MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY = 'b'.repeat(32);
const webProjectSigningKeys = crypto.generateKeyPairSync('ed25519');
process.env.MARKETING_WEB_SIGNING_PRIVATE_KEY_PEM = webProjectSigningKeys.privateKey.export({
  type: 'pkcs8', format: 'pem',
});
process.env.MARKETING_WEB_SIGNING_PUBLIC_KEY_PEM = webProjectSigningKeys.publicKey.export({
  type: 'spki', format: 'pem',
});
process.env.MARKETING_WEB_ARTIFACT_STORE_MODE = 'authenticated_db';
delete process.env.MARKETING_WEB_WORDPRESS_CHANNEL_ENABLED;
delete process.env.MARKETING_WEB_HOSTED_CHANNEL_ENABLED;
delete process.env.MARKETING_WEB_CUSTOM_DOMAIN_CHANNEL_ENABLED;

const assert = require('node:assert/strict');
const {
  WebProjectServiceError,
  assertRevisionReadyForApproval,
  collectExternalDocumentReferences,
  createBlankWebDocument,
  createProject,
  getProject,
  applyWebProjectSiteDefaults,
  intakeConfigForWebScope,
  instantiateWebDocument,
  listProjects,
  listTemplates,
  normalizeCampaignContext,
  normalizeScope,
  revisionFeatureForAction,
  saveDraft,
  siteDefaultsFromIntake,
  syncProjectPages,
} = require('../../services/webProjects.service');
const { validateWebDocument } = require('../../lib/webDocument');

function row(values) {
  return {
    ...values,
    get() { return { ...this }; },
    setDataValue(key, value) { this[key] = value; },
  };
}

async function testBlankDocument() {
  const document = createBlankWebDocument({ name: 'Implantes dentales', locale: 'es-ES' });
  const result = validateWebDocument(document);
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(result.stats.pageCount, 1);
  assert.equal(result.stats.nodeCount, 5);
  const page = document.pages[0];
  const section = document.nodes[page.root_node_ids[0]];
  assert.equal(section.props.semantic_tag, 'main');
  assert.equal(section.children.some((id) => document.nodes[id]?.type === 'intake_form'), true);
  assert.equal(document.seo.indexing, 'noindex');
  assert.equal(document.consent.preview_mode, true);
}

function testIntakeDefaultsMakeAConfiguredDraftApprovable() {
  const defaults = siteDefaultsFromIntake({
    id: 24,
    assignment_scope: 'clinic',
    clinic_id: 66,
    updated_at: '2026-07-18T07:00:00.000Z',
    config: {
      features: {
        consent_mode_enabled: true,
        consent_provider: 'clinicaclick',
        chat_enabled: true,
        tel_modal_enabled: true,
      },
      texts: {
        privacy_url: '/politica-de-privacidad/',
        consent_text: 'Acepto la política de privacidad.',
      },
    },
  });
  const document = applyWebProjectSiteDefaults(createBlankWebDocument({ name: 'Lista' }), defaults);
  assert.equal(defaults.configured, true);
  assert.equal(defaults.consent_ready, true);
  assert.equal(document.integrations.intake_config_id, '24');
  assert.equal(document.consent.preview_mode, false);
  assert.equal(document.consent.provider, 'clinicaclick');
  assert.equal(document.consent.privacy_policy_version, 'intake-24-2026-07-18');
  assert.equal(document.integrations.chat_enabled, true);
  assert.equal(document.integrations.phone_enabled, true);
  assert.equal(validateWebDocument(document).valid, true);
}

async function testInheritedIntakeRequiresExplicitLocation() {
  const inherited = {
    id: 9,
    assignment_scope: 'group',
    group_id: 7,
    config: { locations: [{ id: 66 }] },
  };
  const queries = [];
  const models = {
    Clinica: { findByPk: async () => ({ grupoClinicaId: 7 }) },
    IntakeConfig: {
      findOne: async ({ where }) => {
        queries.push(where);
        return where.assignment_scope === 'clinic' ? null : inherited;
      },
    },
  };
  assert.equal(await intakeConfigForWebScope({ type: 'clinic', id: 66 }, { models }), inherited);
  inherited.config.locations = [{ id: 65 }];
  assert.equal(await intakeConfigForWebScope({ type: 'clinic', id: 66 }, { models }), null);
  assert.equal(queries.length, 4);
}

function testTemplateInstantiationDoesNotReuseStructuralIds() {
  const source = createBlankWebDocument({ name: 'Plantilla maestra' });
  const first = instantiateWebDocument(source);
  const second = instantiateWebDocument(source);
  assert.equal(validateWebDocument(first).valid, true);
  assert.equal(validateWebDocument(second).valid, true);
  assert.notEqual(first.pages[0].id, source.pages[0].id);
  assert.notEqual(first.pages[0].id, second.pages[0].id);
  assert.equal(
    Object.keys(first.nodes).some((id) => Object.hasOwn(second.nodes, id)),
    false,
    'dos proyectos creados desde la misma plantilla no pueden compartir IDs de nodos'
  );
  const firstButton = Object.values(first.nodes).find((node) => node.type === 'button');
  assert.equal(first.nodes[firstButton.props.target]?.type, 'intake_form');
}

function testScopeValidation() {
  assert.deepEqual(normalizeScope({ scope_type: 'clinic', scope_id: '66' }), { type: 'clinic', id: 66 });
  assert.deepEqual(normalizeScope({ scope_type: 'group', group_id: 7 }), { type: 'group', id: 7 });
  assert.throws(
    () => normalizeScope({ scope_type: 'all', scope_id: 1 }),
    (error) => error instanceof WebProjectServiceError && error.code === 'invalid_scope_type'
  );
  for (const invalid of ['66foo', '3.9', '01', 3.9, 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(
      () => normalizeScope({ scope_type: 'clinic', scope_id: invalid }),
      (error) => error instanceof WebProjectServiceError && error.code === 'invalid_scope_id'
    );
  }
}

function testCampaignContextContract() {
  assert.deepEqual(normalizeCampaignContext({
    strategy_id: '41', target_kind: 'general', treatment_id: null,
  }), {
    strategy_id: 41, target_kind: 'general', treatment_id: null,
  });
  assert.deepEqual(normalizeCampaignContext({
    strategyId: 41, targetKind: 'treatment', treatmentId: '88',
  }), {
    strategy_id: 41, target_kind: 'treatment', treatment_id: 88,
  });
  for (const invalid of [
    [],
    { strategy_id: 0, target_kind: 'general' },
    { strategy_id: 41, target_kind: 'treatment' },
    { strategy_id: 41, target_kind: 'general', treatment_id: 88 },
    { strategy_id: 41, target_kind: 'general', injected: true },
  ]) {
    assert.throws(
      () => normalizeCampaignContext(invalid),
      (error) => error instanceof WebProjectServiceError && error.code === 'invalid_campaign_context'
    );
  }
}

function testRevisionPermissionContract() {
  assert.equal(revisionFeatureForAction('submit'), 'marketing.web.edit');
  assert.equal(revisionFeatureForAction('approve'), 'marketing.web.review');
}

function testApprovalGateFailsClosedUntilExternalReferencesAreScoped() {
  const document = createBlankWebDocument({ name: 'Gate' });
  assert.throws(
    () => assertRevisionReadyForApproval(document, { type: 'clinic', id: 66 }),
    (error) => error.code === 'web_revision_not_ready'
      && error.details.issues.some((issue) => issue.code === 'privacy_policy_url_missing')
      && error.details.issues.some((issue) => issue.code === 'intake_config_missing')
  );

  document.consent.preview_mode = false;
  document.consent.privacy_policy_url = '/privacidad';
  document.consent.privacy_policy_version = '2026-07-17';
  document.consent.privacy_consent_text = 'Acepto la política de privacidad.';
  const headingId = Object.keys(document.nodes).find((id) => document.nodes[id].type === 'heading');
  document.bindings.binding_clinic = {
    target_node_id: headingId,
    target_prop: 'text',
    source: 'clinic',
    source_id: null,
    field: 'name',
  };
  document.nodes[headingId].binding_ids = ['binding_clinic'];
  assert.equal(
    collectExternalDocumentReferences(document, { type: 'group', id: 4 })
      .some((reference) => reference.kind === 'clinic_scope'),
    true
  );
}

async function testListContract() {
  const project = row({
    id: 'd3020040-3ae8-46ec-a0dc-bd6b24d8cb6f',
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    name: 'Landing Hospitalet',
    purpose: 'landing',
    locale: 'es-ES',
    status: 'draft',
    version: 1,
    pages: [{ id: '3bf8ec4e-90fd-489a-811a-04997b0d49ad' }],
    draft: row({
      id: 'ae6815b1-7862-4d2b-a8d2-b0e04e8d87f0',
      lockVersion: 2,
      documentHash: 'a'.repeat(64),
      baseRevisionId: null,
      updated_at: new Date('2026-07-17T12:00:00Z'),
    }),
    created_at: new Date('2026-07-17T11:00:00Z'),
    updated_at: new Date('2026-07-17T12:00:00Z'),
  });
  const models = {
    Clinica: { findByPk: async () => ({ id_clinica: 66 }) },
    GrupoClinica: {},
    WebProject: { findAndCountAll: async () => ({ count: 1, rows: [project] }) },
    WebPage: {},
    WebDraft: {},
    WebRevision: { findAll: async () => [] },
  };
  const result = await listProjects({
    actorId: 1,
    query: { scope_type: 'clinic', scope_id: 66, page: 1, limit: 12 },
    models,
  });
  assert.deepEqual(result.scope, { type: 'clinic', id: 66 });
  assert.deepEqual(result.capabilities, {
    publishing_available: true,
    publishing_unavailable_reason: null,
    publishing_rollout_available: true,
    publishing_rollout_unavailable_reason: null,
    publishing_channels: {
      clinicaclick_hosted: { available: false, unavailable_reason: 'channel_not_enabled' },
      wordpress: { available: true, unavailable_reason: null },
      custom_domain: { available: false, unavailable_reason: 'channel_not_enabled' },
    },
  });
  assert.equal(result.items.length, 1);
  assert.deepEqual(result.items[0].capabilities, result.capabilities);
  assert.equal(result.items[0].draft.lock_version, 2);
  assert.equal(result.items[0].page_count, 1);
  assert.deepEqual(result.pagination, { page: 1, limit: 12, total: 1, total_pages: 1 });
}

async function testProjectDetailExposesDisabledScopeCapability() {
  const project = row({
    id: '43be301b-5eb8-4b99-9c52-3ae6ad8b22b1',
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    name: 'Landing Hospitalet',
    purpose: 'landing',
    locale: 'es-ES',
    status: 'draft',
    version: 1,
    pages: [],
    draft: null,
    campaignContext: null,
    created_at: new Date('2026-07-17T11:00:00Z'),
    updated_at: new Date('2026-07-17T12:00:00Z'),
  });
  const models = {
    Clinica: { findByPk: async () => ({ id_clinica: 66 }) },
    GrupoClinica: {},
    WebProject: { findByPk: async () => project },
    WebPage: {},
    WebDraft: {},
    WebRevision: { findOne: async () => null },
  };
  const previousScopes = process.env.MARKETING_WEB_PUBLISHING_SCOPES;
  process.env.MARKETING_WEB_PUBLISHING_SCOPES = 'group:4';
  try {
    const detail = await getProject({ actorId: 1, projectId: project.id, models });
    assert.deepEqual(detail.capabilities, {
      publishing_available: false,
      publishing_unavailable_reason: 'scope_not_enabled',
      publishing_rollout_available: false,
      publishing_rollout_unavailable_reason: 'scope_not_enabled',
      publishing_channels: {
        clinicaclick_hosted: { available: false, unavailable_reason: 'scope_not_enabled' },
        wordpress: { available: false, unavailable_reason: 'scope_not_enabled' },
        custom_domain: { available: false, unavailable_reason: 'scope_not_enabled' },
      },
    });
  } finally {
    if (previousScopes === undefined) delete process.env.MARKETING_WEB_PUBLISHING_SCOPES;
    else process.env.MARKETING_WEB_PUBLISHING_SCOPES = previousScopes;
  }
}

async function testTemplateCatalogUsesBoundedDatabasePagination() {
  const queries = [];
  const models = {
    Clinica: {
      findByPk: async () => ({ id_clinica: 66, grupoClinicaId: 7 }),
    },
    GrupoClinica: {},
    WebTemplate: {
      findAll: async () => {
        throw new Error('listTemplates no debe materializar el catálogo completo en memoria');
      },
    },
    sequelize: {
      query: async (sql, options) => {
        queries.push({ sql, options });
        if (/COUNT\(\*\) AS total/.test(sql)) return [{ total: '123' }];
        return [{
          id: '50d92487-9077-47a1-b6cc-b231d3d00658',
          catalog_key: 'implantologia',
          name: 'Implantología',
          description: null,
          category: 'landing',
          version: 3,
          preview_asset_id: null,
          compatibility: '{"schema":"web-document@1"}',
        }];
      },
    },
  };
  const result = await listTemplates({
    actorId: 1,
    query: {
      scope_type: 'clinic',
      scope_id: 66,
      category: 'landing',
      page: 99999,
      limit: 999,
    },
    models,
  });
  assert.equal(queries.length, 2);
  assert.match(queries[0].sql, /ROW_NUMBER\(\) OVER/);
  assert.match(queries[0].sql, /PARTITION BY catalog_key, version/);
  assert.match(queries[0].sql, /scope_type = 'clinic' AND clinica_id = :scopeId/);
  assert.match(queries[0].sql, /scope_type = 'group' AND grupo_clinica_id = :inheritedGroupId/);
  assert.match(queries[0].sql, /LIMIT :limit OFFSET :offset/);
  assert.deepEqual(queries[0].options.replacements, {
    scopeId: 66,
    inheritedGroupId: 7,
    category: 'landing',
    limit: 50,
    offset: 499950,
  });
  assert.equal(result.items[0].compatibility.schema, 'web-document@1');
  assert.deepEqual(result.pagination, {
    page: 10000,
    limit: 50,
    total: 123,
    total_pages: 3,
  });
}

async function testCreateContract() {
  const writes = { pages: null, audit: null, draft: null };
  const fakeTransaction = { LOCK: { UPDATE: 'UPDATE' } };
  const sequelize = { transaction: async (callback) => callback(fakeTransaction) };
  const models = {
    Clinica: { findByPk: async () => ({ id_clinica: 66 }) },
    GrupoClinica: {},
    IntakeConfig: {
      findOne: async ({ where }) => where.assignment_scope === 'clinic' ? {
        id: 24,
        assignment_scope: 'clinic',
        clinic_id: 66,
        updated_at: '2026-07-18T07:00:00.000Z',
        config: {
          features: { consent_mode_enabled: true, consent_provider: 'clinicaclick', chat_enabled: true },
          texts: { privacy_url: '/privacidad/', consent_text: 'Acepto la política de privacidad.' },
        },
      } : null,
    },
    WebTemplate: { findByPk: async () => null },
    WebProject: {
      create: async (values) => row({
        ...values,
        created_at: new Date('2026-07-17T11:00:00Z'),
        updated_at: new Date('2026-07-17T11:00:00Z'),
      }),
    },
    WebPage: { bulkCreate: async (values) => { writes.pages = values; } },
    WebDraft: {
      create: async (values) => {
        writes.draft = values;
        return row({
          ...values,
          updated_at: new Date('2026-07-17T11:00:00Z'),
        });
      },
    },
    WebAuditEvent: { create: async (values) => { writes.audit = values; } },
  };
  const project = await createProject({
    actorId: 1,
    body: {
      scope_type: 'clinic',
      scope_id: 66,
      name: 'Implantes Hospitalet',
      purpose: 'landing',
      locale: 'es-ES',
      campaign_context: { strategy_id: 41, target_kind: 'treatment', treatment_id: 88 },
    },
    requestId: 'test-request',
    models,
    sequelize,
  });
  assert.equal(project.scope_type, 'clinic');
  assert.equal(project.scope_id, 66);
  assert.equal(project.draft.lock_version, 1);
  assert.deepEqual(project.campaign_context, {
    strategy_id: 41, target_kind: 'treatment', treatment_id: 88,
  });
  assert.equal(writes.pages.length, 1);
  assert.match(writes.pages[0].id, /^[0-9a-f-]{36}$/i);
  assert.match(writes.pages[0].pageKey, /^[0-9a-f-]{36}$/i);
  assert.notEqual(writes.pages[0].pageKey, writes.pages[0].id);
  assert.equal(writes.audit.eventType, 'web.project.created');
  assert.equal(writes.audit.requestId, 'test-request');
  assert.deepEqual(writes.audit.metadata.campaign_context, project.campaign_context);
  assert.equal(writes.draft.document.integrations.intake_config_id, '24');
  assert.equal(writes.draft.document.consent.preview_mode, false);
}

async function testSaveConflict() {
  const document = createBlankWebDocument({ name: 'Conflicto' });
  let saved = false;
  const project = row({
    id: 'd3020040-3ae8-46ec-a0dc-bd6b24d8cb6f',
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    version: 2,
    update: async () => { saved = true; },
  });
  const draft = row({
    id: 'ae6815b1-7862-4d2b-a8d2-b0e04e8d87f0',
    projectId: project.id,
    lockVersion: 3,
    documentHash: 'a'.repeat(64),
    save: async () => { saved = true; },
  });
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = {
    Clinica: { findByPk: async () => ({ id_clinica: 66 }) },
    GrupoClinica: {},
    WebProject: { findByPk: async () => project },
    WebDraft: { findOne: async () => draft },
    WebAuditEvent: { create: async () => { saved = true; } },
  };
  const sequelize = { transaction: async (callback) => callback(transaction) };
  await assert.rejects(
    () => saveDraft({
      actorId: 1,
      projectId: project.id,
      body: { lock_version: 2, document },
      models,
      sequelize,
    }),
    (error) => error instanceof WebProjectServiceError
      && error.code === 'draft_conflict'
      && error.status === 409
      && error.details.current_lock_version === 3
  );
  assert.equal(saved, false);
}

async function testSaveLetsSequelizeOwnTheVersionIncrement() {
  const document = createBlankWebDocument({ name: 'Guardado CAS' });
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const project = row({
    id: 'd3020040-3ae8-46ec-a0dc-bd6b24d8cb6f',
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    version: 2,
    update: async function update(values) { Object.assign(this, values); },
  });
  const draft = row({
    id: 'ae6815b1-7862-4d2b-a8d2-b0e04e8d87f0',
    projectId: project.id,
    lockVersion: 2,
    documentHash: 'a'.repeat(64),
    save: async function save() {
      assert.equal(this.lockVersion, 2, 'el servicio no debe adelantar manualmente la versión de Sequelize');
      this.lockVersion += 1;
      this.updated_at = new Date('2026-07-17T14:00:00Z');
    },
  });
  const createdPages = [];
  const models = {
    Clinica: { findByPk: async () => ({ id_clinica: 66 }) },
    GrupoClinica: {},
    WebProject: { findByPk: async () => project },
    WebDraft: { findOne: async () => draft },
    WebPage: {
      findAll: async () => [],
      create: async (values) => { createdPages.push(values); },
    },
    WebAuditEvent: { create: async () => {} },
  };
  const sequelize = { transaction: async (callback) => callback(transaction) };
  const saved = await saveDraft({
    actorId: 1,
    projectId: project.id,
    body: { lock_version: 2, document },
    models,
    sequelize,
  });
  assert.equal(saved.lock_version, 3);
  assert.equal(project.version, 3);
  assert.equal(saved.project_version, 3);
  assert.equal(createdPages.length, 1);
  assert.equal(createdPages[0].pageKey, document.pages[0].id);
  assert.notEqual(createdPages[0].id, document.pages[0].id);
}

async function testPageProjectionSupportsSlugSwapsAndReusingDeletedRoutes() {
  const calls = [];
  const makePage = (values) => row({
    ...values,
    update: async function update(patch) {
      calls.push(['update', this.pageKey, patch.slug]);
      Object.assign(this, patch);
    },
    destroy: async function destroy(options) {
      calls.push(['destroy', this.pageKey, options.force]);
    },
  });
  const first = makePage({ id: '11111111-1111-4111-8111-111111111111', pageKey: 'page_a', slug: 'equipo', version: 1, deleted_at: null });
  const second = makePage({ id: '22222222-2222-4222-8222-222222222222', pageKey: 'page_b', slug: 'tratamientos', version: 1, deleted_at: null });
  const retired = makePage({ id: '33333333-3333-4333-8333-333333333333', pageKey: 'page_old', slug: 'contacto', version: 1, deleted_at: new Date() });
  const models = {
    WebPage: {
      findAll: async (options) => {
        assert.equal(options.paranoid, false);
        return [first, second, retired];
      },
      create: async (values) => calls.push(['create', values.pageKey, values.slug]),
    },
  };
  await syncProjectPages({
    project: { id: 'project-1' },
    document: {
      pages: [
        { id: 'page_a', title: 'A', slug: 'tratamientos', seo: {} },
        { id: 'page_b', title: 'B', slug: 'equipo', seo: {} },
        { id: 'page_new', title: 'Nueva', slug: 'contacto', seo: {} },
      ],
    },
    actorId: 1,
    transaction: {},
    models,
  });
  assert.deepEqual(calls[0], ['destroy', 'page_old', true]);
  assert.match(calls[1][2], /^tmp-/);
  assert.match(calls[2][2], /^tmp-/);
  assert.deepEqual(calls.slice(-3), [
    ['update', 'page_a', 'tratamientos'],
    ['update', 'page_b', 'equipo'],
    ['create', 'page_new', 'contacto'],
  ]);
}

async function main() {
  await testBlankDocument();
  testIntakeDefaultsMakeAConfiguredDraftApprovable();
  await testInheritedIntakeRequiresExplicitLocation();
  testTemplateInstantiationDoesNotReuseStructuralIds();
  testScopeValidation();
  testCampaignContextContract();
  testRevisionPermissionContract();
  testApprovalGateFailsClosedUntilExternalReferencesAreScoped();
  await testListContract();
  await testProjectDetailExposesDisabledScopeCapability();
  await testTemplateCatalogUsesBoundedDatabasePagination();
  await testCreateContract();
  await testSaveConflict();
  await testSaveLetsSequelizeOwnTheVersionIncrement();
  await testPageProjectionSupportsSlugSwapsAndReusingDeletedRoutes();
  console.log('web projects service: ok');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
