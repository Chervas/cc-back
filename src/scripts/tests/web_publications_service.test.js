'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createPublication,
  enqueueDeployment,
  hostedTarget,
  normalizeSiteUrl,
  publicationBaseUrl,
  retireWordpressPublication,
} = require('../../services/webPublications.service');
const {
  MIN_GLOBAL_INTAKE_PLUGIN_VERSION,
  compareSemver,
  documentHasGlobalIntakeForm,
  semverAtLeast,
} = require('../../lib/webWordpressCompatibility');

class Row {
  constructor(value) { Object.assign(this, value); }
  get() { return { ...this }; }
  async update(patch) { Object.assign(this, patch); return this; }
}

function sequelize() {
  return {
    async transaction(callback) {
      return callback({ LOCK: { UPDATE: 'UPDATE' } });
    },
  };
}

function project() {
  return new Row({
    id: '87abf692-1c71-4e35-a871-a52d9610c507',
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    status: 'active',
  });
}

test('el target hosted lo decide servidor y soporta path o subdomain', () => {
  assert.deepEqual(hostedTarget({ slug: 'implantes-badalona' }, {
    MARKETING_WEB_HOSTED_DOMAIN: 'sites.clinicaclick.com',
    MARKETING_WEB_HOSTED_MODE: 'path',
  }), {
    host: 'sites.clinicaclick.com',
    path: '/implantes-badalona/',
    slug: 'implantes-badalona',
    hosted_mode: 'path',
  });
  assert.equal(hostedTarget({ slug: 'implantes-badalona' }, {
    MARKETING_WEB_HOSTED_DOMAIN: 'sites.clinicaclick.com',
    MARKETING_WEB_HOSTED_MODE: 'subdomain',
  }).host, 'implantes-badalona.sites.clinicaclick.com');
  assert.throws(() => hostedTarget({ slug: '../admin' }, {}), /identificador público/);
});

test('WordPress exige origen HTTPS exacto', () => {
  assert.deepEqual(normalizeSiteUrl('https://cliente.example.com/'), {
    url: 'https://cliente.example.com',
    host: 'cliente.example.com',
  });
  assert.throws(() => normalizeSiteUrl('http://cliente.example.com'));
  assert.throws(() => normalizeSiteUrl('https://cliente.example.com/wp?token=x'));
});

test('WordPress conserva /cita/ para el piloto y asigna una ruta hija solo con capability v2', async () => {
  const source = project();
  source.name = 'Implantes Badalona';
  const installation = new Row({
    id: 'b77c9c88-740f-474c-8160-9178afed7e70',
    scopeType: 'clinic', clinicaId: 66, grupoClinicaId: null,
    siteUrl: 'https://cliente.example.com', status: 'connected',
    pluginVersion: '2.0.0-alpha.7', capabilities: {},
  });
  const saved = [];
  const pilot = new Row({
    id: '11111111-1111-4111-8111-111111111111',
    projectId: 'pilot-project', channel: 'wordpress',
    wordpressInstallationId: installation.id,
    host: 'cliente.example.com', path: '/cita/', status: 'published',
  });
  let existing = [];
  const models = {
    WebProject: { findByPk: async () => source },
    WebWordpressInstallation: { findByPk: async () => installation },
    WebPublication: {
      findAll: async ({ where }) => (where.wordpressInstallationId ? existing : existing),
      create: async (value) => {
        saved.push(value);
        return new Row({ ...value, created_at: new Date(), updated_at: new Date() });
      },
    },
    WebArtifact: {
      findByPk: async (id) => (id === 'pilot-artifact'
        ? new Row({ id, manifest: { page_routes: { page: { page_path: '/implantes-badalona/' } } } })
        : null),
    },
    WebPublicationDeployment: { findOne: async () => null },
    WebAuditEvent: { create: async () => true },
  };
  const common = {
    actorId: 9,
    models,
    sequelize: sequelize(),
    assertAccess: async () => true,
    assertPublishing: () => true,
  };
  const first = await createPublication({
    ...common,
    body: {
      project_id: source.id,
      channel: 'wordpress',
      wordpress_installation_id: installation.id,
      slug: 'ignorado-en-piloto',
    },
  });
  assert.equal(first.path, '/cita/');

  existing = [pilot];
  await assert.rejects(
    () => createPublication({
      ...common,
      body: { project_id: source.id, channel: 'wordpress', wordpress_installation_id: installation.id },
    }),
    (error) => error.code === 'web_wordpress_multi_publication_plugin_update_required'
  );

  installation.pluginVersion = '2.0.0-alpha.8';
  installation.capabilities = { multi_publication_v2: true };
  pilot.activeArtifactId = 'pilot-artifact';
  await assert.rejects(
    () => createPublication({
      ...common,
      body: {
        project_id: source.id,
        channel: 'wordpress',
        wordpress_installation_id: installation.id,
        slug: 'implantes-badalona',
      },
    }),
    (error) => error.code === 'web_wordpress_publication_manifest_route_conflict'
  );
  pilot.activeArtifactId = null;
  const child = await createPublication({
    ...common,
    body: {
      project_id: source.id,
      channel: 'wordpress',
      wordpress_installation_id: installation.id,
      slug: 'implantes-badalona',
    },
  });
  assert.equal(child.path, '/cita/implantes-badalona/');
  assert.equal(child.public_url, 'https://cliente.example.com/cita/implantes-badalona/');
  assert.equal(saved.length, 2);
});

test('una landing de clínica puede publicar en el WordPress compartido de su grupo sin ampliar el scope', async () => {
  const source = project();
  const installation = new Row({
    id: 'b77c9c88-740f-474c-8160-9178afed7e70',
    scopeType: 'group',
    clinicaId: null,
    grupoClinicaId: 5,
    siteUrl: 'https://cliente.example.com',
    status: 'connected',
    pluginVersion: '2.0.0-alpha.8',
    capabilities: { multi_publication_v2: true },
  });
  let created = null;
  const models = {
    WebProject: { findByPk: async () => source },
    Clinica: {
      findByPk: async (id) => Number(id) === 66
        ? { id_clinica: 66, grupoClinicaId: 5, estado_clinica: true }
        : null,
    },
    WebWordpressInstallation: { findByPk: async () => installation },
    WebPublication: {
      findAll: async () => [],
      create: async (value) => { created = value; return new Row(value); },
    },
    WebPublicationDeployment: { findOne: async () => null },
    WebArtifact: { findByPk: async () => null },
    WebAuditEvent: { create: async () => true },
  };

  const publication = await createPublication({
    actorId: 9,
    body: {
      project_id: source.id,
      channel: 'wordpress',
      wordpress_installation_id: installation.id,
    },
    models,
    sequelize: sequelize(),
    assertAccess: async () => true,
    assertPublishing: () => true,
  });

  assert.equal(publication.scope.type, 'clinic');
  assert.equal(publication.scope.id, 66);
  assert.equal(created.scopeType, 'clinic');
  assert.equal(created.clinicaId, 66);
  assert.deepEqual(created.configuration.wordpress_installation_scope, { type: 'group', id: 5 });
  assert.equal(created.configuration.wordpress_inherited_from_group, true);

  installation.grupoClinicaId = 6;
  await assert.rejects(
    () => createPublication({
      actorId: 9,
      body: {
        project_id: source.id,
        channel: 'wordpress',
        wordpress_installation_id: installation.id,
      },
      models,
      sequelize: sequelize(),
      assertAccess: async () => true,
      assertPublishing: () => true,
    }),
    (error) => error.code === 'web_wordpress_installation_not_found'
  );
});

test('un proyecto de grupo bloquea y revalida la clínica materializada antes de crear la publicación WordPress', async () => {
  const source = new Row({
    ...project().get(),
    scopeType: 'group',
    clinicaId: null,
    grupoClinicaId: 5,
  });
  const installation = new Row({
    id: 'b77c9c88-740f-474c-8160-9178afed7e70',
    scopeType: 'group',
    clinicaId: null,
    grupoClinicaId: 5,
    siteUrl: 'https://cliente.example.com',
    status: 'connected',
    pluginVersion: '2.0.0-alpha.8',
    capabilities: { multi_publication_v2: true },
  });
  const clinic = new Row({ id_clinica: 66, grupoClinicaId: 5, estado_clinica: true });
  let clinicRead = null;
  let created = null;
  const models = {
    WebProject: { findByPk: async () => source },
    Clinica: {
      findByPk: async (_id, options) => {
        clinicRead = options;
        return clinic;
      },
    },
    WebWordpressInstallation: { findByPk: async () => installation },
    WebPublication: {
      findAll: async () => [],
      create: async (value) => { created = value; return new Row(value); },
    },
    WebPublicationDeployment: { findOne: async () => null },
    WebArtifact: { findByPk: async () => null },
    WebAuditEvent: { create: async () => true },
  };

  const publication = await createPublication({
    actorId: 9,
    body: {
      project_id: source.id,
      clinic_id: 66,
      channel: 'wordpress',
      wordpress_installation_id: installation.id,
      slug: 'primera-visita-hospitalet',
    },
    models,
    sequelize: sequelize(),
    assertAccess: async () => true,
    assertPublishing: () => true,
  });

  assert.equal(clinicRead.raw, undefined);
  assert.equal(clinicRead.lock, 'UPDATE');
  assert.ok(clinicRead.transaction);
  assert.deepEqual(clinicRead.attributes, ['id_clinica', 'grupoClinicaId', 'estado_clinica']);
  assert.equal(created.scopeType, 'group');
  assert.equal(created.configuration.clinic_id, 66);
  assert.equal(publication.configuration.clinic_id, 66);

  clinic.estado_clinica = false;
  await assert.rejects(
    () => createPublication({
      actorId: 9,
      body: {
        project_id: source.id,
        clinic_id: 66,
        channel: 'wordpress',
        wordpress_installation_id: installation.id,
        slug: 'otra-landing',
      },
      models,
      sequelize: sequelize(),
      assertAccess: async () => true,
      assertPublishing: () => true,
    }),
    (error) => error.code === 'web_publication_clinic_not_found'
  );
});

test('un tombstone retirado y confirmado libera un slot pero conserva su ruta, con historial total acotado', async () => {
  const source = project();
  source.name = 'Nueva landing';
  const retiredId = '11111111-1111-4111-8111-111111111111';
  const installation = new Row({
    id: 'b77c9c88-740f-474c-8160-9178afed7e70',
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    siteUrl: 'https://cliente.example.com',
    status: 'connected',
    pluginVersion: '2.0.0-alpha.8',
    capabilities: { multi_publication_v2: true },
    reportedState: {
      confirmed_routes: {
        [retiredId]: { status: 'retired', route_prefix: '/cita/old/', artifact_hash: null },
      },
    },
  });
  const publications = Array.from({ length: 20 }, (_, index) => new Row({
    id: index === 0 ? retiredId : `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
    projectId: `project-${index}`,
    channel: 'wordpress',
    wordpressInstallationId: installation.id,
    host: 'cliente.example.com',
    path: index === 0 ? '/cita/old/' : (index === 1 ? '/cita/' : `/cita/existing-${index}/`),
    status: index === 0 ? 'retired' : 'published',
    activeArtifactId: null,
    lastGoodArtifactId: null,
  }));
  let created = 0;
  const models = {
    WebProject: { findByPk: async () => source },
    WebWordpressInstallation: { findByPk: async () => installation },
    WebPublication: {
      findAll: async () => publications,
      create: async (value) => { created += 1; return new Row(value); },
    },
    WebPublicationDeployment: { findOne: async () => null },
    WebArtifact: { findByPk: async () => null },
    WebAuditEvent: { create: async () => true },
  };
  const common = {
    actorId: 9,
    models,
    sequelize: sequelize(),
    assertAccess: async () => true,
    assertPublishing: () => true,
  };
  const createdPublication = await createPublication({
    ...common,
    body: {
      project_id: source.id,
      channel: 'wordpress',
      wordpress_installation_id: installation.id,
      slug: 'nueva',
    },
  });
  assert.equal(createdPublication.path, '/cita/nueva/');
  assert.equal(created, 1);

  await assert.rejects(
    () => createPublication({
      ...common,
      body: {
        project_id: source.id,
        channel: 'wordpress',
        wordpress_installation_id: installation.id,
        slug: 'old',
      },
    }),
    (error) => error.code === 'web_publication_route_overlap'
  );

  installation.reportedState = {};
  await assert.rejects(
    () => createPublication({
      ...common,
      body: {
        project_id: source.id,
        channel: 'wordpress',
        wordpress_installation_id: installation.id,
        slug: 'otra',
      },
    }),
    (error) => error.code === 'web_wordpress_publication_limit_reached'
  );

  installation.reportedState = {
    confirmed_routes: {
      [retiredId]: { status: 'retired', route_prefix: '/cita/old/', artifact_hash: null },
    },
  };
  publications.push(...Array.from({ length: 180 }, (_, index) => new Row({
    id: `33333333-3333-4333-8333-${String(index).padStart(12, '0')}`,
    path: `/cita/archive-${index}/`,
    status: 'retired',
  })));
  await assert.rejects(
    () => createPublication({
      ...common,
      body: {
        project_id: source.id,
        channel: 'wordpress',
        wordpress_installation_id: installation.id,
        slug: 'history-overflow',
      },
    }),
    (error) => error.code === 'web_wordpress_publication_history_limit_reached'
  );
});

test('retirar WordPress crea el tombstone auditable sin esperar un job ni reutilizar la ruta', async () => {
  const source = project();
  const installation = new Row({
    id: 'b77c9c88-740f-474c-8160-9178afed7e70',
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    status: 'connected',
  });
  const publication = new Row({
    id: '11111111-1111-4111-8111-111111111111',
    projectId: source.id,
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    channel: 'wordpress',
    wordpressInstallationId: installation.id,
    host: 'cliente.example.com',
    path: '/cita/implantes/',
    status: 'published',
    desiredRevisionId: '22222222-2222-4222-8222-222222222222',
    activeArtifactId: '33333333-3333-4333-8333-333333333333',
    version: 4,
  });
  const audits = [];
  const models = {
    WebProject: { findByPk: async () => source },
    WebWordpressInstallation: { findByPk: async () => installation },
    WebPublication: {
      findByPk: async () => publication,
      findAll: async () => [publication],
    },
    WebPublicationDeployment: { findOne: async () => null },
    WebAuditEvent: { create: async (value) => { audits.push(value); } },
  };
  const first = await retireWordpressPublication({
    actorId: 9,
    publicationId: publication.id,
    requestId: 'req-retire',
    models,
    sequelize: sequelize(),
    assertAccess: async () => true,
  });
  assert.equal(first.already_retired, false);
  assert.equal(first.publication.status, 'retired');
  assert.ok(first.publication.retired_at instanceof Date);
  assert.equal(publication.version, 5);
  assert.equal(publication.desiredRevisionId, null);
  assert.equal(publication.activeArtifactId, '33333333-3333-4333-8333-333333333333');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].eventType, 'web.publication.retired');
  assert.equal(audits[0].metadata.tombstone_pending, true);

  const replay = await retireWordpressPublication({
    actorId: 9,
    publicationId: publication.id,
    models,
    sequelize: sequelize(),
    assertAccess: async () => true,
  });
  assert.equal(replay.already_retired, true);
  assert.equal(audits.length, 1);
});

test('retirar WordPress falla cerrado mientras hay un despliegue en curso', async () => {
  const source = project();
  const installation = new Row({
    id: 'b77c9c88-740f-474c-8160-9178afed7e70',
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
  });
  const publication = new Row({
    id: '11111111-1111-4111-8111-111111111111',
    projectId: source.id,
    channel: 'wordpress',
    wordpressInstallationId: installation.id,
    status: 'published',
    version: 4,
  });
  const models = {
    WebProject: { findByPk: async () => source },
    WebWordpressInstallation: { findByPk: async () => installation },
    WebPublication: { findByPk: async () => publication, findAll: async () => [publication] },
    WebPublicationDeployment: {
      findOne: async () => new Row({ status: 'running', jobRequestId: 91 }),
    },
    WebAuditEvent: { create: async () => { throw new Error('must_not_audit'); } },
  };
  await assert.rejects(
    () => retireWordpressPublication({
      actorId: 9,
      publicationId: publication.id,
      models,
      sequelize: sequelize(),
      assertAccess: async () => true,
    }),
    (error) => error.code === 'web_publication_busy' && error.details?.job_request_id === 91
  );
  assert.equal(publication.status, 'published');
});

test('el mínimo WordPress para intake global compara SemVer y prereleases sin atajos por major', () => {
  assert.equal(MIN_GLOBAL_INTAKE_PLUGIN_VERSION, '2.0.0-alpha.7');
  assert.equal(compareSemver('2.0.0-alpha.6', '2.0.0-alpha.7'), -1);
  assert.equal(compareSemver('2.0.0-alpha.10', '2.0.0-alpha.7'), 1);
  assert.equal(compareSemver('2.0.0-beta.1', '2.0.0-alpha.7'), 1);
  assert.equal(compareSemver('2.0.0', '2.0.0-alpha.7'), 1);
  assert.equal(semverAtLeast('2.0.0-alpha.7+build.3', MIN_GLOBAL_INTAKE_PLUGIN_VERSION), true);
  assert.equal(semverAtLeast('2.0.0-alpha.6', MIN_GLOBAL_INTAKE_PLUGIN_VERSION), false);
  assert.equal(semverAtLeast('2.0', MIN_GLOBAL_INTAKE_PLUGIN_VERSION), false);
  assert.equal(semverAtLeast('2.0.0-alpha.07', MIN_GLOBAL_INTAKE_PLUGIN_VERSION), false);
  assert.equal(semverAtLeast(null, MIN_GLOBAL_INTAKE_PLUGIN_VERSION), false);
});

test('solo detecta intake alcanzable desde header o footer, no formularios locales', () => {
  const document = {
    globals: { header_node_id: 'header', footer_node_id: 'footer' },
    nodes: {
      header: { type: 'section', children: ['copy'] },
      footer: { type: 'section', children: [] },
      copy: { type: 'text', children: [] },
      local_form: { type: 'intake_form', children: [] },
    },
  };
  assert.equal(documentHasGlobalIntakeForm(document), false);
  document.nodes.header.children.push('global_form');
  document.nodes.global_form = { type: 'intake_form', children: [] };
  assert.equal(documentHasGlobalIntakeForm(document), true);
});

test('crea una publicación hosted con scope y destino inyectados por servidor', async () => {
  const saved = [];
  const models = {
    WebProject: { findByPk: async () => project() },
    WebPublication: {
      findAll: async () => [],
      create: async (value) => { saved.push(value); return new Row({ ...value, created_at: new Date(), updated_at: new Date() }); },
    },
    WebAuditEvent: { create: async (value) => saved.push({ audit: value }) },
  };
  const result = await createPublication({
    actorId: 9,
    body: { project_id: project().id, channel: 'clinicaclick_hosted', slug: 'implantes-badalona' },
    models,
    sequelize: sequelize(),
    env: { MARKETING_WEB_HOSTED_DOMAIN: 'sites.clinicaclick.com', MARKETING_WEB_HOSTED_MODE: 'path' },
    assertAccess: async () => true,
    assertPublishing: () => true,
  });
  assert.equal(result.public_url, 'https://sites.clinicaclick.com/implantes-badalona/');
  assert.equal(saved[0].clinicaId, 66);
  assert.equal(saved[0].configuration.clinic_id, 66);
  assert.equal(saved[0].host, 'sites.clinicaclick.com');
  assert.equal(publicationBaseUrl(saved[0]), 'https://sites.clinicaclick.com/implantes-badalona');
});

test('copia campaign_context desde el proyecto y nunca confia en el body', async () => {
  const source = project();
  source.campaignContext = { strategy_id: 41, target_kind: 'treatment', treatment_id: 88 };
  const saved = [];
  const models = {
    WebProject: { findByPk: async () => source },
    WebPublication: {
      findAll: async () => [],
      create: async (value) => {
        saved.push(value);
        return new Row({ ...value, created_at: new Date(), updated_at: new Date() });
      },
    },
    WebAuditEvent: { create: async (value) => saved.push({ audit: value }) },
  };
  await createPublication({
    actorId: 9,
    body: {
      project_id: source.id,
      channel: 'clinicaclick_hosted',
      slug: 'implantes-campana',
      campaign_context: { strategy_id: 999, target_kind: 'general', treatment_id: null },
    },
    models,
    sequelize: sequelize(),
    env: { MARKETING_WEB_HOSTED_DOMAIN: 'sites.clinicaclick.com', MARKETING_WEB_HOSTED_MODE: 'path' },
    assertAccess: async () => true,
    assertPublishing: () => true,
  });
  assert.deepEqual(saved[0].configuration.campaign_context, source.campaignContext);
  assert.deepEqual(saved[1].audit.metadata.campaign_context, source.campaignContext);
});

test('reserva incluso rutas retiradas y rechaza solapes antes de crear el job de publicación', async () => {
  let created = 0;
  const models = {
    WebProject: { findByPk: async () => project() },
    WebPublication: {
      findAll: async () => [new Row({
        id: 'existing',
        host: 'sites.clinicaclick.com',
        path: '/implantes/barcelona/',
        status: 'retired',
      })],
      create: async () => { created += 1; },
    },
    WebAuditEvent: { create: async () => true },
  };
  await assert.rejects(
    createPublication({
      actorId: 9,
      body: {
        project_id: project().id,
        channel: 'clinicaclick_hosted',
        slug: 'implantes',
      },
      models,
      sequelize: sequelize(),
      env: { MARKETING_WEB_HOSTED_DOMAIN: 'sites.clinicaclick.com', MARKETING_WEB_HOSTED_MODE: 'path' },
      assertAccess: async () => true,
      assertPublishing: () => true,
    }),
    (error) => error.code === 'web_publication_route_overlap'
      && error.details?.conflicting_path === '/implantes/barcelona/'
  );
  assert.equal(created, 0);
});

function deploymentModels({ publicationStatus = 'draft', revisionStatus = 'approved' } = {}) {
  const p = project();
  const publication = new Row({
    id: '4c41c538-187d-4686-af4d-3a947f4cfa94',
    projectId: p.id,
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    channel: 'clinicaclick_hosted',
    host: 'sites.clinicaclick.com',
    path: '/implantes/',
    status: publicationStatus,
    configuration: { clinic_id: 66 },
    health: {},
    version: 1,
  });
  const created = [];
  return {
    created,
    publication,
    models: {
      WebProject: { findByPk: async () => p },
      WebPublication: {
        findByPk: async () => publication,
        findAll: async () => [publication],
      },
      WebRevision: {
        findByPk: async () => new Row({
          id: '6cf410dc-cc39-4405-b7e5-9fb56ccbc8f4',
          projectId: p.id,
          status: revisionStatus,
          documentHash: 'a'.repeat(64),
        }),
      },
      WebArtifact: { findByPk: async () => null },
      WebPublicationDeployment: {
        findOne: async () => null,
        create: async (value) => {
          const row = new Row({ ...value, created_at: new Date() });
          created.push(row);
          return row;
        },
      },
      WebAuditEvent: { create: async () => true },
      JobRequest: {},
    },
  };
}

test('encola publicación aprobada en la misma transacción y deja puntero auditable', async () => {
  const fixture = deploymentModels();
  const jobs = [];
  const result = await enqueueDeployment({
    actorId: 9,
    publicationId: fixture.publication.id,
    revisionId: '6cf410dc-cc39-4405-b7e5-9fb56ccbc8f4',
    action: 'publish',
    requestId: 'req-1',
    models: fixture.models,
    sequelize: sequelize(),
    assertAccess: async () => true,
    assertPublishing: () => true,
    enqueueJob: async (value, options) => {
      jobs.push({ value, options });
      return new Row({ id: 314, status: 'pending' });
    },
  });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].value.type, 'web_publication_deploy');
  assert.equal(jobs[0].value.payload.publication_id, fixture.publication.id);
  assert.ok(jobs[0].options.transaction);
  assert.equal(fixture.publication.status, 'pending');
  assert.equal(fixture.publication.version, 2);
  assert.equal(result.deployment.job_request_id, 314);
});

test('una publicación ocupada no encola un segundo despliegue', async () => {
  const fixture = deploymentModels({ publicationStatus: 'publishing' });
  let jobs = 0;
  await assert.rejects(() => enqueueDeployment({
    actorId: 9,
    publicationId: fixture.publication.id,
    revisionId: '6cf410dc-cc39-4405-b7e5-9fb56ccbc8f4',
    action: 'publish',
    models: fixture.models,
    sequelize: sequelize(),
    assertAccess: async () => true,
    assertPublishing: () => true,
    enqueueJob: async () => { jobs += 1; },
  }), (error) => error.code === 'web_publication_busy');
  assert.equal(jobs, 0);
});

test('POST publish no resucita una publicación retirada ni encola un despliegue', async () => {
  const fixture = deploymentModels({ publicationStatus: 'retired' });
  let jobs = 0;
  await assert.rejects(() => enqueueDeployment({
    actorId: 9,
    publicationId: fixture.publication.id,
    revisionId: '6cf410dc-cc39-4405-b7e5-9fb56ccbc8f4',
    action: 'publish',
    models: fixture.models,
    sequelize: sequelize(),
    assertAccess: async () => true,
    assertPublishing: () => true,
    enqueueJob: async () => { jobs += 1; },
  }), (error) => error.code === 'web_publication_retired' && error.status === 409);
  assert.equal(jobs, 0);
  assert.equal(fixture.created.length, 0);
  assert.equal(fixture.publication.status, 'retired');
  assert.equal(fixture.publication.version, 1);
});

test('una revisión no aprobada no puede entrar al orquestador', async () => {
  const fixture = deploymentModels({ revisionStatus: 'review' });
  await assert.rejects(() => enqueueDeployment({
    actorId: 9,
    publicationId: fixture.publication.id,
    revisionId: '6cf410dc-cc39-4405-b7e5-9fb56ccbc8f4',
    action: 'publish',
    models: fixture.models,
    sequelize: sequelize(),
    assertAccess: async () => true,
    assertPublishing: () => true,
    enqueueJob: async () => { throw new Error('must_not_enqueue'); },
  }), (error) => error.code === 'web_revision_not_approved');
});

test('WordPress permite configurar pending pero solo activa al quedar connected', async () => {
  const fixture = deploymentModels();
  fixture.publication.channel = 'wordpress';
  fixture.publication.wordpressInstallationId = 'b77c9c88-740f-474c-8160-9178afed7e70';
  const installation = new Row({
    id: fixture.publication.wordpressInstallationId,
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    status: 'pending',
  });
  fixture.models.WebWordpressInstallation = { findByPk: async () => installation };
  await assert.rejects(
    () => enqueueDeployment({
      actorId: 9,
      publicationId: fixture.publication.id,
      revisionId: '6cf410dc-cc39-4405-b7e5-9fb56ccbc8f4',
      action: 'publish',
      models: fixture.models,
      sequelize: sequelize(),
      assertAccess: async () => true,
      assertPublishing: () => true,
      enqueueJob: async () => new Row({ id: 314, status: 'pending' }),
    }),
    (error) => error.code === 'web_wordpress_not_connected'
  );
  installation.status = 'connected';
  const result = await enqueueDeployment({
    actorId: 9,
    publicationId: fixture.publication.id,
    revisionId: '6cf410dc-cc39-4405-b7e5-9fb56ccbc8f4',
    action: 'publish',
    models: fixture.models,
    sequelize: sequelize(),
    assertAccess: async () => true,
    assertPublishing: () => true,
    enqueueJob: async () => new Row({ id: 314, status: 'pending' }),
  });
  assert.equal(result.job.status, 'pending');
  assert.equal(fixture.publication.status, 'pending');
});

test('WordPress alpha.6 no encola una revisión con formulario global y alpha.7 sí', async () => {
  const fixture = deploymentModels();
  fixture.publication.channel = 'wordpress';
  fixture.publication.wordpressInstallationId = 'b77c9c88-740f-474c-8160-9178afed7e70';
  const installation = new Row({
    id: fixture.publication.wordpressInstallationId,
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    status: 'connected',
    pluginVersion: '2.0.0-alpha.6',
  });
  const revision = new Row({
    id: '6cf410dc-cc39-4405-b7e5-9fb56ccbc8f4',
    projectId: project().id,
    status: 'approved',
    documentHash: 'a'.repeat(64),
    document: {
      globals: { header_node_id: 'global_header', footer_node_id: null },
      nodes: {
        global_header: { type: 'section', children: ['global_form'] },
        global_form: { type: 'intake_form', children: [] },
      },
    },
  });
  fixture.models.WebWordpressInstallation = { findByPk: async () => installation };
  fixture.models.WebRevision = { findByPk: async () => revision };
  let jobs = 0;
  const enqueue = () => enqueueDeployment({
    actorId: 9,
    publicationId: fixture.publication.id,
    revisionId: revision.id,
    action: 'publish',
    models: fixture.models,
    sequelize: sequelize(),
    assertAccess: async () => true,
    assertPublishing: () => true,
    enqueueJob: async () => {
      jobs += 1;
      return new Row({ id: 314, status: 'pending' });
    },
  });

  await assert.rejects(enqueue, (error) => (
    error.code === 'web_wordpress_global_intake_plugin_outdated'
      && error.details?.actual_plugin_version === '2.0.0-alpha.6'
      && error.details?.required_plugin_version === '2.0.0-alpha.7'
  ));
  assert.equal(jobs, 0);
  assert.equal(fixture.created.length, 0);
  assert.equal(fixture.publication.status, 'draft');

  installation.pluginVersion = '2.0.0-alpha.7';
  const result = await enqueue();
  assert.equal(result.job.status, 'pending');
  assert.equal(jobs, 1);
});

test('WordPress alpha.6 conserva compatibilidad con header global sin formulario', async () => {
  const fixture = deploymentModels();
  fixture.publication.channel = 'wordpress';
  fixture.publication.wordpressInstallationId = 'b77c9c88-740f-474c-8160-9178afed7e70';
  fixture.models.WebWordpressInstallation = { findByPk: async () => new Row({
    id: fixture.publication.wordpressInstallationId,
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    status: 'connected',
    pluginVersion: '2.0.0-alpha.6',
  }) };
  fixture.models.WebRevision = { findByPk: async () => new Row({
    id: '6cf410dc-cc39-4405-b7e5-9fb56ccbc8f4',
    projectId: project().id,
    status: 'approved',
    documentHash: 'a'.repeat(64),
    document: {
      globals: { header_node_id: 'global_header', footer_node_id: null },
      nodes: { global_header: { type: 'section', children: ['brand'] }, brand: { type: 'text', children: [] } },
    },
  }) };
  const result = await enqueueDeployment({
    actorId: 9,
    publicationId: fixture.publication.id,
    revisionId: '6cf410dc-cc39-4405-b7e5-9fb56ccbc8f4',
    action: 'publish',
    models: fixture.models,
    sequelize: sequelize(),
    assertAccess: async () => true,
    assertPublishing: () => true,
    enqueueJob: async () => new Row({ id: 314, status: 'pending' }),
  });
  assert.equal(result.job.status, 'pending');
});
