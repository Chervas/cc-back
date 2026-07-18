'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LANDING_PUBLISHED_EVENT,
  channelDeploy,
  runPublicationDeploymentJob,
  verifyPublicArtifact,
} = require('../../services/webPublicationDeployment.service');
const { compileRevision } = require('../../services/webArtifacts.service');
const { createBlankWebDocument } = require('../../services/webProjects.service');
const { trustedRuntime } = require('../../lib/webMeasurementRuntime');

class Row {
  constructor(value) { Object.assign(this, value); }
  get() { return { ...this }; }
  async update(patch) { Object.assign(this, patch); return this; }
}

function fakeSequelize() {
  return { transaction: async (callback) => callback({ LOCK: { UPDATE: 'UPDATE' } }) };
}

function fixture(channel = 'clinicaclick_hosted', withCampaign = false) {
  const runtimeConfigHash = trustedRuntime({}, { environment: 'production' }).runtime_config_hash;
  const project = new Row({
    id: 'a337cc47-211a-4903-b7a5-a080e45e24e8',
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    purpose: 'landing',
    status: 'draft',
    version: 1,
    campaignContext: withCampaign
      ? { strategy_id: 41, target_kind: 'treatment', treatment_id: 88 }
      : null,
  });
  const publication = new Row({
    id: '818188f3-b38d-4c0b-b168-79371edb2ee7',
    projectId: project.id,
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    channel,
    domainId: channel === 'custom_domain' ? 'd1b5fb80-a6db-444c-8c6b-d49e43e5a99a' : null,
    wordpressInstallationId: channel === 'wordpress' ? 'b77c9c88-740f-474c-8160-9178afed7e70' : null,
    host: channel === 'wordpress'
      ? 'cliente.example.com'
      : channel === 'custom_domain'
        ? 'landing.example.com'
        : 'sites.clinicaclick.com',
    path: channel === 'wordpress' ? '/cita/implantes/' : '/implantes/',
    status: 'pending',
    desiredRevisionId: 'c482e859-4551-46b0-bce2-ab74da5887df',
    activeRevisionId: null,
    activeArtifactId: null,
    lastGoodArtifactId: null,
    configuration: {
      clinic_id: 66,
      ...(withCampaign ? {
        campaign_context: { strategy_id: 41, target_kind: 'treatment', treatment_id: 88 },
      } : {}),
    },
    health: {},
    jobRequestId: 77,
    version: 2,
  });
  const deployment = new Row({
    id: '4686e0c6-004d-4b26-b3a0-d253abec00b6',
    publicationId: publication.id,
    projectId: project.id,
    revisionId: publication.desiredRevisionId,
    artifactId: null,
    previousArtifactId: null,
    sequence: 1,
    action: 'publish',
    status: 'queued',
    expectedPublicationVersion: 2,
    storage: {},
    result: {},
    jobRequestId: 77,
    actorUserId: 9,
    requestId: 'req-1',
    startedAt: null,
  });
  const artifact = new Row({
    id: 'f9a0120f-3b36-43ee-92fd-2ac5f2144fba',
    projectId: project.id,
    revisionId: deployment.revisionId,
    environment: 'production',
    runtimeConfigHash,
    artifactHash: 'a'.repeat(64),
    manifest: { artifact_hash: 'a'.repeat(64), artifact_input_hash: 'b'.repeat(64), files: {} },
    files: {},
  });
  const installation = new Row({
    id: publication.wordpressInstallationId,
    status: 'connected',
    lastArtifactHash: null,
    pluginVersion: '2.0.0',
    lastSeenAt: new Date(),
  });
  const domain = new Row({
    id: publication.domainId,
    scopeType: 'clinic',
    clinicaId: 66,
    grupoClinicaId: null,
    host: publication.host,
    kind: 'custom_domain',
    status: 'ready',
    expectedDns: {
      ownership: { name: `_clinicaclick-verify.${publication.host}` },
      routing: { target: 'sites.clinicaclick.com' },
    },
  });
  const audits = [];
  const models = {
    WebPublicationDeployment: { findByPk: async () => deployment },
    WebProject: { findByPk: async () => project },
    WebPublication: { findByPk: async () => publication },
    WebArtifact: { findByPk: async (id) => String(id) === artifact.id ? artifact : null },
    WebWordpressInstallation: { findByPk: async () => installation },
    WebDomain: { findByPk: async (id) => String(id) === String(domain.id) ? domain : null },
    IntakeConfig: { findOne: async () => null },
    Clinica: { findByPk: async () => ({ grupoClinicaId: null }) },
    WebAuditEvent: { create: async (value) => { audits.push(value); return value; } },
    JobRequest: {},
  };
  return { project, publication, deployment, artifact, installation, domain, audits, models };
}

function dependencies(state, overrides = {}) {
  return {
    models: state.models,
    sequelize: fakeSequelize(),
    env: {
      MARKETING_WEB_HOSTING_ROOT: '/tmp/not-used-in-fake',
      MARKETING_WEB_API_BASE_URL: 'https://crm.clinicaclick.com',
    },
    compileRevision: async () => ({
      id: state.artifact.id,
      artifact_hash: state.artifact.artifactHash,
      manifest: state.artifact.manifest,
      files: state.artifact.files,
    }),
    publishHostedArtifact: async ({ artifact }) => ({
      verified: true,
      artifact_hash: artifact.artifact_hash,
      previous_artifact_hash: 'c'.repeat(64),
      public_url: 'https://sites.clinicaclick.com/implantes/',
    }),
    restoreHostedRoutePointer: async () => ({ restored: true, reason: 'previous_artifact_restored' }),
    verifyHostedPointer: async () => true,
    verifyPublicArtifact: async () => true,
    storeArtifactBundle: async () => ({ manifest_url: 'https://artifacts.example/manifest.json' }),
    ...overrides,
  };
}

test('despliegue hosted compila, verifica y conmuta estado solo tras readback', async () => {
  const state = fixture();
  const result = await runPublicationDeploymentJob({
    publication_id: state.publication.id,
    deployment_id: state.deployment.id,
  }, { id: 77, attempts: 1, max_attempts: 5 }, dependencies(state));
  assert.equal(result.status, 'completed');
  assert.equal(state.deployment.status, 'verified');
  assert.equal(state.deployment.artifactId, state.artifact.id);
  assert.equal(state.publication.status, 'published');
  assert.equal(state.publication.activeArtifactId, state.artifact.id);
  assert.equal(state.publication.version, 3);
  assert.equal(state.project.status, 'active');
  assert.equal(state.project.version, 2);
  assert.equal(state.audits[0].eventType, 'web.publication.published');
});

test('rollback recompila R1 superseded con el runtime vigente y conserva el LKG verificado', async () => {
  const state = fixture();
  const revisionR1Id = state.deployment.revisionId;
  const revisionR2Id = '2b80ef9e-08ab-4ef9-8b36-4ad9684a0eb0';
  const artifactR2Id = '151304c4-22bc-4ee8-87bc-dbf3efea20c6';
  const oldHmac = '0123456789abcdef0123456789abcdef';
  const currentHmac = 'abcdef0123456789abcdef0123456789';
  const measurement = (hmacKey) => ({
    enabled: true,
    scope_type: 'clinic',
    scope_id: 66,
    api_url: 'https://crm.clinicaclick.com',
    loader_path: '/assets/loader.js',
    hmac_key: hmacKey,
    consent_mode_enabled: true,
    consent_provider: 'clinicaclick',
  });
  const oldRuntimeHash = trustedRuntime(
    { measurement: measurement(oldHmac) },
    { environment: 'production' }
  ).runtime_config_hash;
  const currentRuntimeHash = trustedRuntime(
    { measurement: measurement(currentHmac) },
    { environment: 'production' }
  ).runtime_config_hash;

  state.project.name = 'Landing R1';
  state.project.locale = 'es-ES';
  state.publication.activeRevisionId = revisionR2Id;
  state.publication.activeArtifactId = artifactR2Id;
  state.publication.lastGoodArtifactId = artifactR2Id;
  state.deployment.action = 'rollback';
  state.deployment.artifactId = state.artifact.id;
  state.deployment.previousArtifactId = artifactR2Id;
  state.deployment.actorUserId = 1;
  state.artifact.runtimeConfigHash = oldRuntimeHash;
  state.artifact.revisionId = revisionR1Id;
  state.artifact.artifactHash = '1'.repeat(64);
  state.artifact.manifest = {
    artifact_hash: state.artifact.artifactHash,
    artifact_input_hash: '2'.repeat(64),
    files: {},
  };
  const rollbackDocument = createBlankWebDocument({ name: 'Landing R1', locale: 'es-ES' });
  rollbackDocument.consent = {
    provider: 'clinicaclick',
    preview_mode: false,
    privacy_policy_url: 'https://example.test/privacidad/',
    privacy_policy_version: '2026-07',
    privacy_consent_text: 'Acepto la política de privacidad.',
  };
  rollbackDocument.integrations = {
    intake_config_id: '91',
    chat_enabled: false,
    whatsapp_enabled: false,
    phone_enabled: false,
  };
  const revisionR1 = new Row({
    id: revisionR1Id,
    projectId: state.project.id,
    status: 'superseded',
    document: rollbackDocument,
    documentHash: '3'.repeat(64),
    contentSnapshot: {
      schema_version: 1,
      content_entries: {},
      media_assets: {},
      live_bindings: [],
      intake_config: { id: '91' },
    },
  });
  const verifiedR1 = new Row({
    id: '33d73f94-a76c-42e2-ad45-97074dad34f0',
    publicationId: state.publication.id,
    projectId: state.project.id,
    revisionId: revisionR1Id,
    artifactId: state.artifact.id,
    status: 'verified',
  });
  const artifacts = new Map([[state.artifact.id, state.artifact]]);
  state.models.WebRevision = {
    findByPk: async (id) => String(id) === revisionR1Id ? revisionR1 : null,
  };
  state.models.WebPublicationDeployment.findOne = async ({ where }) => (
    String(where.publicationId) === state.publication.id
    && String(where.artifactId) === state.artifact.id
    && where.status === 'verified'
      ? verifiedR1
      : null
  );
  state.models.WebArtifact = {
    findByPk: async (id) => artifacts.get(String(id)) || null,
    findOne: async ({ where }) => [...artifacts.values()].find((artifact) => (
      artifact.revisionId === where.revisionId
      && artifact.rendererVersion === where.rendererVersion
      && artifact.environment === where.environment
      && artifact.baseUrlHash === where.baseUrlHash
      && artifact.runtimeConfigHash === where.runtimeConfigHash
    )) || null,
    create: async (value) => {
      const artifact = new Row({ ...value, created_at: new Date() });
      artifacts.set(artifact.id, artifact);
      return artifact;
    },
  };
  state.models.IntakeConfig.findOne = async ({ where }) => (
    where.assignment_scope === 'clinic' && Number(where.clinic_id) === 66
      ? {
        assignment_scope: 'clinic',
        clinic_id: 66,
        hmac_key: currentHmac,
        config: { features: { consent_mode_enabled: true, consent_provider: 'clinicaclick' } },
      }
      : null
  );
  state.models.Clinica.findByPk = async (id) => Number(id) === 66 ? new Row({
    id_clinica: 66,
    grupoClinicaId: null,
    estado_clinica: 1,
    nombre_clinica: 'Clínica segura',
    direccion: 'Carrer de la Salut 1',
    codigo_postal: '08001',
    ciudad: 'Barcelona',
    provincia: 'Barcelona',
    pais: 'España',
    telefono: '+34930000000',
    telefono_fijo: null,
    telefono_movil: null,
    email: 'hola@example.test',
    url_web: 'https://example.test/',
    horario_atencion: 'Lunes a viernes',
  }) : null;

  const previousEditorGate = process.env.MARKETING_WEB_EDITOR_ENABLED;
  const previousGate = process.env.MARKETING_WEB_PUBLISHING_ENABLED;
  process.env.MARKETING_WEB_EDITOR_ENABLED = 'true';
  process.env.MARKETING_WEB_PUBLISHING_ENABLED = 'true';
  try {
    await assert.rejects(
      () => compileRevision({
        actorId: 1,
        revisionId: revisionR1Id,
        body: {
          environment: 'production',
          base_url: 'https://sites.clinicaclick.com/implantes',
          clinic_id: 66,
          rollbackSource: { publicationId: state.publication.id, artifactId: state.artifact.id },
        },
        trustedRuntime: { measurement: measurement(currentHmac) },
        models: state.models,
        sequelize: fakeSequelize(),
      }),
      (error) => error.code === 'web_revision_not_approved',
      'el body público no puede fabricar la prueba interna de rollback'
    );
    const result = await runPublicationDeploymentJob({
      publication_id: state.publication.id,
      deployment_id: state.deployment.id,
    }, { id: 77, attempts: 1, max_attempts: 5 }, dependencies(state, {
      compileRevision: (input) => compileRevision({
        ...input,
        models: state.models,
        sequelize: fakeSequelize(),
      }),
    }));

    assert.equal(result.status, 'completed', result.error?.stack || result.error?.message);
    assert.equal(revisionR1.status, 'superseded', 'el rollback no reactiva ni muta la revisión histórica');
    assert.notEqual(state.deployment.artifactId, state.artifact.id, 'debe materializar un artefacto con el runtime nuevo');
    const rolledBackArtifact = artifacts.get(state.deployment.artifactId);
    assert.equal(rolledBackArtifact.revisionId, revisionR1Id);
    assert.equal(rolledBackArtifact.runtimeConfigHash, currentRuntimeHash);
    assert.notEqual(rolledBackArtifact.runtimeConfigHash, oldRuntimeHash);
    assert.equal(state.publication.activeRevisionId, revisionR1Id);
    assert.equal(state.publication.activeArtifactId, rolledBackArtifact.id);
    assert.equal(state.publication.lastGoodArtifactId, rolledBackArtifact.id);
    assert.equal(state.deployment.status, 'verified');
  } finally {
    if (previousEditorGate === undefined) delete process.env.MARKETING_WEB_EDITOR_ENABLED;
    else process.env.MARKETING_WEB_EDITOR_ENABLED = previousEditorGate;
    if (previousGate === undefined) delete process.env.MARKETING_WEB_PUBLISHING_ENABLED;
    else process.env.MARKETING_WEB_PUBLISHING_ENABLED = previousGate;
  }
});

test('rollback verificado conserva el proyecto activo sin inflar su versión', async () => {
  const state = fixture();
  state.project.status = 'active';
  state.project.version = 5;
  state.deployment.action = 'rollback';
  const result = await runPublicationDeploymentJob({
    publication_id: state.publication.id,
    deployment_id: state.deployment.id,
  }, { id: 77, attempts: 1, max_attempts: 5 }, dependencies(state));
  assert.equal(result.status, 'completed');
  assert.equal(state.project.status, 'active');
  assert.equal(state.project.version, 5);
  assert.equal(state.audits[0].eventType, 'web.publication.rolled_back');
});

test('publicacion sana emite una sola vez el evento canonico para Campanas', async () => {
  const state = fixture('clinicaclick_hosted', true);
  const enqueued = [];
  const deps = dependencies(state, {
    enqueueUniqueJobRequest: async (input, options) => {
      enqueued.push({ input, options });
      return { job: new Row({ id: 515 }), created: true };
    },
  });
  const first = await runPublicationDeploymentJob({
    publication_id: state.publication.id,
    deployment_id: state.deployment.id,
  }, { id: 77, attempts: 1, max_attempts: 5 }, deps);
  assert.equal(first.status, 'completed');
  assert.equal(enqueued.length, 1);
  const { input, options } = enqueued[0];
  assert.equal(input.type, LANDING_PUBLISHED_EVENT);
  assert.equal(input.dedupeScope, input.payload.event_id);
  assert.equal(input.payload.event_id, `webpub:${state.publication.id}:${state.artifact.id}`);
  assert.equal(input.payload.strategy_id, 41);
  assert.equal(input.payload.target_kind, 'treatment');
  assert.equal(input.payload.treatment_id, 88);
  assert.equal(input.payload.destination_url, 'https://sites.clinicaclick.com/implantes/');
  assert.equal(
    input.payload.destination_digest,
    require('node:crypto').createHash('sha256')
      .update('https://sites.clinicaclick.com/implantes/').digest('hex')
  );
  assert.ok(options.transaction?.LOCK, 'el evento debe compartir la transaccion del puntero publicado');
  assert.equal(first.result.integration_event.job_request_id, 515);
  assert.equal(state.audits[0].metadata.campaign_event_id, input.payload.event_id);

  const second = await runPublicationDeploymentJob({
    publication_id: state.publication.id,
    deployment_id: state.deployment.id,
  }, { id: 77, attempts: 2, max_attempts: 5 }, deps);
  assert.equal(second.status, 'completed');
  assert.equal(second.result.reason, 'already_verified');
  assert.equal(enqueued.length, 1, 'releer un deployment terminal no duplica el outbox');
});

test('WordPress espera al pull y luego termina idempotentemente con heartbeat', async () => {
  const state = fixture('wordpress');
  const healthChecks = [];
  const deps = dependencies(state, {
    verifyPublicArtifact: async (options) => { healthChecks.push(options); return true; },
  });
  const waiting = await runPublicationDeploymentJob({
    publication_id: state.publication.id,
    deployment_id: state.deployment.id,
  }, { id: 77, attempts: 1, max_attempts: 180 }, deps);
  assert.equal(waiting.status, 'waiting');
  assert.equal(waiting.result.reason, 'wordpress_waiting_for_pull');
  assert.equal(state.deployment.status, 'running');
  assert.equal(state.publication.status, 'publishing');
  assert.equal(state.deployment.storage.manifest_url, 'https://artifacts.example/manifest.json');

  state.installation.lastArtifactHash = state.artifact.artifactHash;
  const completed = await runPublicationDeploymentJob({
    publication_id: state.publication.id,
    deployment_id: state.deployment.id,
  }, { id: 77, attempts: 2, max_attempts: 180 }, deps);
  assert.equal(completed.status, 'completed');
  assert.equal(state.publication.status, 'published');
  assert.equal(healthChecks.length, 1, 'el heartbeat no sustituye el GET de salud público');
  assert.equal(healthChecks[0].publicUrl, 'https://cliente.example.com/cita/implantes/');
  assert.equal(healthChecks[0].inputHash, state.artifact.manifest.artifact_input_hash);
  assert.equal(completed.result.deployment.result.public_verified, true);
});

test('un retry recupera idempotentemente un deployment running cuyo artefacto quedó ready sin puntero', async () => {
  const state = fixture('wordpress');
  state.deployment.status = 'running';
  state.deployment.startedAt = new Date('2026-07-18T10:51:03.000Z');
  state.deployment.artifactId = null;
  state.publication.status = 'publishing';
  let compileCalls = 0;
  const deps = dependencies(state, {
    compileRevision: async () => {
      compileCalls += 1;
      return {
        id: state.artifact.id,
        artifact_hash: state.artifact.artifactHash,
        manifest: state.artifact.manifest,
        files: state.artifact.files,
      };
    },
    verifyPublicArtifact: async () => true,
  });

  const recovered = await runPublicationDeploymentJob({
    publication_id: state.publication.id,
    deployment_id: state.deployment.id,
  }, { id: 77, attempts: 3, max_attempts: 180 }, deps);
  assert.equal(recovered.status, 'waiting');
  assert.equal(recovered.result.reason, 'wordpress_waiting_for_pull');
  assert.equal(state.deployment.artifactId, state.artifact.id);
  assert.equal(state.deployment.status, 'running');
  assert.equal(state.publication.status, 'publishing');
  assert.equal(compileCalls, 1);

  state.installation.lastArtifactHash = state.artifact.artifactHash;
  const completed = await runPublicationDeploymentJob({
    publication_id: state.publication.id,
    deployment_id: state.deployment.id,
  }, { id: 77, attempts: 4, max_attempts: 180 }, deps);
  assert.equal(completed.status, 'completed');
  assert.equal(state.deployment.status, 'verified');
  assert.equal(state.publication.status, 'published');
  assert.equal(compileCalls, 1, 'el segundo intento reutiliza el artefacto ya enlazado');
});

test('WordPress no confirma publicado si el permalink público no sirve el marcador esperado', async () => {
  const state = fixture('wordpress');
  state.installation.lastArtifactHash = state.artifact.artifactHash;
  const result = await runPublicationDeploymentJob({
    publication_id: state.publication.id,
    deployment_id: state.deployment.id,
  }, { id: 77, attempts: 1, max_attempts: 5 }, dependencies(state, {
    verifyPublicArtifact: async () => false,
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, true);
  assert.equal(state.publication.status, 'publishing');
  assert.equal(state.publication.activeArtifactId, null);
});

test('WordPress marca terminal el primer despliegue insano sin inventar una versión buena', async () => {
  const state = fixture('wordpress');
  state.installation.lastArtifactHash = state.artifact.artifactHash;
  const result = await runPublicationDeploymentJob({
    publication_id: state.publication.id,
    deployment_id: state.deployment.id,
  }, { id: 77, attempts: 5, max_attempts: 5 }, dependencies(state, {
    verifyPublicArtifact: async () => false,
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, true);
  assert.equal(state.deployment.status, 'failed');
  assert.equal(state.publication.status, 'failed');
  assert.equal(state.publication.activeArtifactId, null);
  assert.equal(state.publication.lastGoodArtifactId, null);
});

test('WordPress revalida connected antes de confirmar el puntero final', async () => {
  const state = fixture('wordpress');
  state.installation.status = 'pending';
  state.installation.lastArtifactHash = state.artifact.artifactHash;
  await assert.rejects(
    () => channelDeploy({
      publication: state.publication,
      deployment: state.deployment,
      artifact: { artifact_hash: state.artifact.artifactHash },
      storage: {},
      env: {},
      models: state.models,
    }),
    (error) => error.code === 'web_wordpress_not_connected' && error.status === 409
  );
});

test('un job antiguo no toca el puntero', async () => {
  const state = fixture();
  const result = await runPublicationDeploymentJob({
    publication_id: state.publication.id,
    deployment_id: state.deployment.id,
  }, { id: 999, attempts: 1, max_attempts: 5 }, dependencies(state));
  assert.equal(result.status, 'completed');
  assert.equal(result.result.reason, 'stale_job');
  assert.equal(state.publication.status, 'pending');
});

test('un fallo público transitorio no marca failed antes de agotar reintentos', async () => {
  const state = fixture();
  const result = await runPublicationDeploymentJob({
    publication_id: state.publication.id,
    deployment_id: state.deployment.id,
  }, { id: 77, attempts: 1, max_attempts: 5 }, dependencies(state, {
    verifyPublicArtifact: async () => false,
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, true);
  assert.equal(state.deployment.status, 'running');
  assert.equal(state.publication.status, 'publishing');
});

test('al agotar reintentos conserva el último válido y hace visible el fallo', async () => {
  const state = fixture();
  state.publication.activeArtifactId = 'old-artifact';
  state.publication.lastGoodArtifactId = 'old-artifact';
  const result = await runPublicationDeploymentJob({
    publication_id: state.publication.id,
    deployment_id: state.deployment.id,
  }, { id: 77, attempts: 5, max_attempts: 5 }, dependencies(state, {
    verifyPublicArtifact: async () => false,
  }));
  assert.equal(result.status, 'failed');
  assert.equal(state.deployment.status, 'failed');
  assert.equal(state.publication.status, 'failed');
  assert.equal(state.publication.activeArtifactId, 'old-artifact');
  assert.equal(state.publication.lastGoodArtifactId, 'old-artifact');
});

test('custom_domain revalida fila, DNS y TLS justo antes del puntero y la salud pública', async () => {
  const state = fixture('custom_domain');
  const order = [];
  const result = await channelDeploy({
    publication: state.publication,
    deployment: state.deployment,
    artifact: {
      artifact_hash: state.artifact.artifactHash,
      manifest: state.artifact.manifest,
    },
    storage: {},
    env: { MARKETING_WEB_HOSTING_ROOT: '/tmp/not-used-in-fake' },
    models: state.models,
    publishHosted: async () => {
      order.push('publish');
      return {
        verified: true,
        artifact_hash: state.artifact.artifactHash,
        public_url: 'https://landing.example.com/implantes/',
      };
    },
    inspectDomainDns: async ({ domain }) => {
      order.push(`dns:${domain.id}`);
      return { ownership_verified: true, routing_verified: true };
    },
    inspectDomainTls: async (host) => {
      order.push(`tls:${host}`);
      return { ready: true };
    },
    verifyHosted: async () => { order.push('pointer'); return true; },
    verifyPublic: async () => { order.push('public'); return true; },
  });
  assert.deepEqual(order, [
    `dns:${state.domain.id}`,
    'tls:landing.example.com',
    'publish',
    'pointer',
    'public',
  ]);
  assert.equal(result.result.domain_health.domain_id, state.domain.id);
  assert.equal(result.result.domain_health.tls_ready, true);
});

test('custom_domain no conmuta puntero si el DNS o el certificado cambiaron', async () => {
  for (const failure of ['dns', 'tls']) {
    const state = fixture('custom_domain');
    let pointerChecks = 0;
    let publishes = 0;
    await assert.rejects(
      () => channelDeploy({
        publication: state.publication,
        deployment: state.deployment,
        artifact: {
          artifact_hash: state.artifact.artifactHash,
          manifest: state.artifact.manifest,
        },
        storage: {},
        env: { MARKETING_WEB_HOSTING_ROOT: '/tmp/not-used-in-fake' },
        models: state.models,
        publishHosted: async () => {
          publishes += 1;
          return {
            verified: true,
            artifact_hash: state.artifact.artifactHash,
            public_url: 'https://landing.example.com/implantes/',
          };
        },
        inspectDomainDns: async () => ({
          ownership_verified: failure !== 'dns',
          routing_verified: failure !== 'dns',
        }),
        inspectDomainTls: async () => ({ ready: failure !== 'tls', reason: 'certificate_expired' }),
        verifyHosted: async () => { pointerChecks += 1; return true; },
        verifyPublic: async () => { pointerChecks += 1; return true; },
      }),
      (error) => error.code === (failure === 'dns'
        ? 'web_domain_dns_revalidation_failed'
        : 'web_domain_tls_revalidation_failed')
        && error.status === 503
    );
    assert.equal(publishes, 0);
    assert.equal(pointerChecks, 0);
  }
});

test('restaura el puntero hosted si falla la salud pública', async () => {
  const state = fixture();
  const compensations = [];
  await assert.rejects(
    () => channelDeploy({
      publication: state.publication,
      deployment: state.deployment,
      artifact: {
        artifact_hash: state.artifact.artifactHash,
        manifest: state.artifact.manifest,
      },
      storage: {},
      env: { MARKETING_WEB_HOSTING_ROOT: '/srv/hosting' },
      models: state.models,
      publishHosted: async () => ({
        verified: true,
        artifact_hash: state.artifact.artifactHash,
        previous_artifact_hash: 'c'.repeat(64),
        public_url: 'https://sites.clinicaclick.com/implantes/',
      }),
      restoreHosted: async (options) => {
        compensations.push(options);
        return { restored: true, reason: 'previous_artifact_restored' };
      },
      verifyHosted: async () => true,
      verifyPublic: async () => false,
    }),
    (error) => error.code === 'web_public_healthcheck_failed'
  );
  assert.deepEqual(compensations, [{
    host: state.publication.host,
    routePath: state.publication.path,
    failedArtifactHash: state.artifact.artifactHash,
    previousArtifactHash: 'c'.repeat(64),
    hostingRoot: '/srv/hosting',
  }]);
});

test('restaura el puntero hosted si falla la segunda lectura local', async () => {
  const state = fixture();
  const compensations = [];
  await assert.rejects(
    () => channelDeploy({
      publication: state.publication,
      deployment: state.deployment,
      artifact: {
        artifact_hash: state.artifact.artifactHash,
        manifest: state.artifact.manifest,
      },
      storage: {},
      env: { MARKETING_WEB_HOSTING_ROOT: '/srv/hosting' },
      models: state.models,
      publishHosted: async () => ({
        verified: true,
        artifact_hash: state.artifact.artifactHash,
        previous_artifact_hash: 'c'.repeat(64),
        public_url: 'https://sites.clinicaclick.com/implantes/',
      }),
      restoreHosted: async (options) => {
        compensations.push(options);
        return { restored: true, reason: 'previous_artifact_restored' };
      },
      verifyHosted: async () => false,
      verifyPublic: async () => {
        assert.fail('la salud pública no debe ejecutarse si falla el readback local');
      },
    }),
    (error) => error.code === 'web_hosted_pointer_verification_failed'
  );
  assert.equal(compensations.length, 1);
  assert.equal(compensations[0].failedArtifactHash, state.artifact.artifactHash);
});

test('restaura el puntero si la transacción final falla después del healthcheck', async () => {
  const state = fixture();
  const compensations = [];
  const result = await runPublicationDeploymentJob({
    publication_id: state.publication.id,
    deployment_id: state.deployment.id,
  }, { id: 77, attempts: 1, max_attempts: 5 }, dependencies(state, {
    finishDeployment: async () => {
      const error = new Error('commit failed');
      error.status = 503;
      error.code = 'database_commit_failed';
      throw error;
    },
    restoreHostedRoutePointer: async (options) => {
      compensations.push(options);
      return { restored: true, reason: 'previous_artifact_restored' };
    },
  }));
  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, true);
  assert.equal(compensations.length, 1);
  assert.equal(compensations[0].failedArtifactHash, state.artifact.artifactHash);
  assert.equal(compensations[0].previousArtifactHash, 'c'.repeat(64));
  assert.equal(state.publication.activeArtifactId, null);
});

test('restaura el puntero si la publicación queda superada al cerrar la transacción', async () => {
  const state = fixture();
  const compensations = [];
  const result = await runPublicationDeploymentJob({
    publication_id: state.publication.id,
    deployment_id: state.deployment.id,
  }, { id: 77, attempts: 1, max_attempts: 5 }, dependencies(state, {
    finishDeployment: async () => ({ superseded: true }),
    restoreHostedRoutePointer: async (options) => {
      compensations.push(options);
      return { restored: false, reason: 'pointer_changed' };
    },
  }));
  assert.equal(result.status, 'completed');
  assert.equal(result.result.superseded, true);
  assert.equal(compensations.length, 1);
  assert.equal(compensations[0].failedArtifactHash, state.artifact.artifactHash);
  assert.equal(compensations[0].previousArtifactHash, 'c'.repeat(64));
});

test('healthcheck público exige 200 y el marcador exacto', async () => {
  const inputHash = 'c'.repeat(64);
  const resolver = async (url) => ({
    url,
    httpAgent: { destroy() {} },
    httpsAgent: { destroy() {} },
  });
  const ok = await verifyPublicArtifact({
    publicUrl: 'https://example.test/',
    inputHash,
    resolveTarget: resolver,
    httpClient: {
      get: async () => ({
        status: 200,
        data: `<meta name="clinicaclick-artifact-input" content="${inputHash}">`,
      }),
    },
  });
  assert.equal(ok, true);
  const wrong = await verifyPublicArtifact({
    publicUrl: 'https://example.test/',
    inputHash,
    resolveTarget: resolver,
    httpClient: {
      get: async () => ({
        status: 200,
        data: '<meta name="clinicaclick-artifact-input" content="deadbeef">',
      }),
    },
  });
  assert.equal(wrong, false);
});

test('healthcheck fija DNS por salto, desactiva redirects automáticos y rechaza rebinding privado', async () => {
  const inputHash = 'd'.repeat(64);
  const resolved = [];
  const requests = [];
  let destroyed = 0;
  const resolveTarget = async (url) => {
    resolved.push(url);
    return {
      url,
      httpAgent: { id: `http:${url}`, destroy() { destroyed += 1; } },
      httpsAgent: { id: `https:${url}`, destroy() { destroyed += 1; } },
    };
  };
  const httpClient = {
    async get(url, config) {
      requests.push({ url, config });
      if (requests.length === 1) {
        return { status: 302, headers: { location: 'https://www.example.test/final/' }, data: '' };
      }
      return {
        status: 200,
        data: `<meta name="clinicaclick-artifact-input" content="${inputHash}">`,
      };
    },
  };
  const ok = await verifyPublicArtifact({
    publicUrl: 'https://example.test/', inputHash, httpClient, resolveTarget,
  });
  assert.equal(ok, true);
  assert.equal(resolved.length, 2);
  assert.match(resolved[0], /^https:\/\/example\.test\/\?cc_health=/);
  assert.match(resolved[1], /^https:\/\/www\.example\.test\/final\/$/);
  assert.ok(requests.every(({ config }) => (
    config.maxRedirects === 0
    && config.proxy === false
    && config.httpAgent
    && config.httpsAgent
  )));
  assert.equal(destroyed, 4);

  let privateTargetResolved = false;
  const rejected = await verifyPublicArtifact({
    publicUrl: 'https://example.test/',
    inputHash,
    resolveTarget: async (url) => {
      if (url.includes('169.254.169.254')) privateTargetResolved = true;
      return {
        url,
        httpAgent: { destroy() {} },
        httpsAgent: { destroy() {} },
      };
    },
    httpClient: {
      get: async () => ({
        status: 302,
        headers: { location: 'http://169.254.169.254/latest/meta-data/' },
        data: '',
      }),
    },
  });
  assert.equal(rejected, false);
  assert.equal(privateTargetResolved, false);
});
