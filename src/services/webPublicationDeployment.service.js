'use strict';

const crypto = require('node:crypto');
const axios = require('axios');
const db = require('../../models');
const { compileRevision } = require('./webArtifacts.service');
const { storeArtifactBundle } = require('./webArtifactStorage.service');
const {
  publishHostedArtifact,
  restoreHostedRoutePointer,
  verifyHostedPointer,
} = require('./webHostedPublisher.service');
const { trustedRuntime: normalizeTrustedRuntime } = require('../lib/webMeasurementRuntime');
const { publicHttpUrl, resolveSafeHttpTarget } = require('../lib/safeHttpTarget');
const {
  normalizeCampaignContext,
  positiveInteger,
  scopeColumns,
  scopeFromProject,
} = require('./webProjects.service');
const jobRequestsService = require('./jobRequests.service');
const {
  WebPublicationServiceError,
  publicationBaseUrl,
  serializeDeployment,
  serializePublication,
} = require('./webPublications.service');
const {
  installationApiBase,
  measurementFromIntake,
} = require('./webWordpressInstallations.service');
const { assertWebPublishingChannelEnabled } = require('../lib/marketingWebFeatureFlags');
const { inspectDns, inspectTls } = require('./webDomains.service');
const {
  MIN_GLOBAL_INTAKE_PLUGIN_VERSION,
  manifestHasGlobalIntakeContract,
  semverAtLeast,
} = require('../lib/webWordpressCompatibility');

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function safeError(error) {
  return {
    code: String(error?.code || error?.message || 'web_publication_deploy_failed').slice(0, 128),
    message: String(error?.message || 'No se pudo desplegar la publicación.').slice(0, 1000),
  };
}

const LANDING_PUBLISHED_EVENT = 'marketing_web.landing_published.v1';

function campaignDestinationUrl(publication) {
  // Campaigns canonicalizes the public route through WHATWG URL. Because all
  // publication paths are directory routes, its exact contract includes `/`.
  return `${publicationBaseUrl(publication)}/`;
}

function sameCampaignContext(left, right) {
  return left?.strategy_id === right?.strategy_id
    && left?.target_kind === right?.target_kind
    && left?.treatment_id === right?.treatment_id;
}

function landingPublishedEvent({ project, publication, deployment, artifact, occurredAt = new Date() }) {
  const context = normalizeCampaignContext(plain(project)?.campaignContext);
  if (!context) return null;
  if (plain(project)?.purpose !== 'landing') {
    throw new WebPublicationServiceError(
      'web_campaign_context_project_invalid',
      'Una estrategia de campana solo puede publicar proyectos landing.',
      409
    );
  }
  const snapshot = normalizeCampaignContext(plain(publication)?.configuration?.campaign_context);
  if (!snapshot || !sameCampaignContext(context, snapshot)) {
    throw new WebPublicationServiceError(
      'web_campaign_context_snapshot_mismatch',
      'La publicacion no conserva el contexto canonico de la estrategia.',
      409
    );
  }
  const destinationUrl = campaignDestinationUrl(publication);
  const eventId = `webpub:${publication.id}:${artifact.id}`;
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{7,79}$/.test(eventId)) {
    throw new WebPublicationServiceError(
      'web_campaign_event_id_invalid',
      'No se pudo construir la clave idempotente de publicacion.',
      500
    );
  }
  return {
    event_id: eventId,
    occurred_at: new Date(occurredAt).toISOString(),
    strategy_id: context.strategy_id,
    target_kind: context.target_kind,
    treatment_id: context.treatment_id,
    publication_id: publication.id,
    project_id: project.id,
    revision_id: artifact.revisionId,
    artifact_id: artifact.id,
    destination_url: destinationUrl,
    destination_digest: crypto.createHash('sha256').update(destinationUrl).digest('hex'),
    requested_by_user_id: positiveInteger(deployment.actorUserId),
  };
}

async function enqueueLandingPublishedEvent({ event, models, sequelize, transaction, enqueueUniqueJob }) {
  if (!event) return null;
  const enqueue = enqueueUniqueJob || jobRequestsService.enqueueUniqueJobRequest;
  const queued = await enqueue({
    type: LANDING_PUBLISHED_EVENT,
    payload: event,
    dedupeScope: event.event_id,
    priority: 'high',
    status: 'pending',
    origin: 'marketing_web:publication',
    requestedBy: event.requested_by_user_id,
    requestedByName: 'Clinicaclick',
    requestedByRole: 'system',
    maxAttempts: 8,
  }, {
    transaction,
    JobRequestModel: models.JobRequest,
    sequelizeInstance: sequelize,
  });
  return {
    event_id: event.event_id,
    job_request_id: positiveInteger(plain(queued?.job)?.id),
    created: queued?.created !== false,
  };
}

async function lockDeploymentGraph({ deploymentId, publicationId, models, transaction }) {
  const pointer = await models.WebPublicationDeployment.findByPk(String(deploymentId || ''), {
    attributes: ['id', 'publicationId', 'projectId'],
    transaction,
  });
  if (!pointer || (publicationId && String(pointer.publicationId) !== String(publicationId))) {
    throw new WebPublicationServiceError('web_publication_deployment_not_found', 'El despliegue no existe.', 404);
  }
  const project = await models.WebProject.findByPk(pointer.projectId, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!project) throw new WebPublicationServiceError('web_publication_deployment_not_found', 'El despliegue no existe.', 404);
  const publication = await models.WebPublication.findByPk(pointer.publicationId, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  const deployment = await models.WebPublicationDeployment.findByPk(pointer.id, {
    transaction,
    lock: transaction.LOCK.UPDATE,
  });
  if (!publication || !deployment || publication.projectId !== project.id || deployment.projectId !== project.id) {
    throw new WebPublicationServiceError('web_publication_deployment_not_found', 'El despliegue no existe.', 404);
  }
  return { project, publication, deployment };
}

async function claimDeployment({
  deploymentId,
  publicationId,
  jobRequest,
  models,
  sequelize,
  env = process.env,
  assertPublishingChannel = assertWebPublishingChannelEnabled,
}) {
  return sequelize.transaction(async (transaction) => {
    const graph = await lockDeploymentGraph({ deploymentId, publicationId, models, transaction });
    const { project, publication, deployment } = graph;
    if (deployment.jobRequestId && jobRequest?.id && Number(deployment.jobRequestId) !== Number(jobRequest.id)) {
      return { terminal: true, skipped: 'stale_job', ...graph };
    }
    if (['verified', 'failed', 'superseded'].includes(deployment.status)) {
      return { terminal: true, skipped: `already_${deployment.status}`, ...graph };
    }
    // El gate se revalida dentro del mismo lock y antes de cualquier cambio de
    // estado. Así, apagar un canal también detiene jobs ya encolados y retries;
    // no basta con haber pasado la comprobación cuando se creó el JobRequest.
    assertPublishingChannel(scopeFromProject(plain(project)), publication.channel, env);
    if (Number(publication.version) !== Number(deployment.expectedPublicationVersion)) {
      await deployment.update({
        status: 'superseded',
        completedAt: new Date(),
        errorCode: 'web_publication_version_changed',
        errorDetails: { expected: deployment.expectedPublicationVersion, actual: publication.version },
      }, { transaction });
      return { terminal: true, skipped: 'publication_version_changed', ...graph };
    }
    if (deployment.action === 'publish' && String(publication.desiredRevisionId) !== String(deployment.revisionId)) {
      await deployment.update({
        status: 'superseded',
        completedAt: new Date(),
        errorCode: 'web_publication_revision_changed',
      }, { transaction });
      return { terminal: true, skipped: 'publication_revision_changed', ...graph };
    }
    await Promise.all([
      deployment.update({
        status: 'running',
        startedAt: deployment.startedAt || new Date(),
        errorCode: null,
        errorDetails: null,
      }, { transaction }),
      publication.update({
        status: deployment.action === 'rollback' ? 'rolling_back' : 'publishing',
        lastErrorCode: null,
        lastErrorMessage: null,
      }, { transaction }),
    ]);
    return { terminal: false, ...graph };
  });
}

async function persistArtifactPreparation({
  deploymentId,
  publicationId,
  artifactId,
  storage,
  models,
  sequelize,
}) {
  return sequelize.transaction(async (transaction) => {
    const { publication, deployment } = await lockDeploymentGraph({ deploymentId, publicationId, models, transaction });
    if (Number(publication.version) !== Number(deployment.expectedPublicationVersion)) {
      throw new WebPublicationServiceError(
        'web_publication_version_changed',
        'La publicación cambió durante el despliegue.',
        409
      );
    }
    await deployment.update({ artifactId, storage: storage || deployment.storage || {} }, { transaction });
    return { publication: plain(publication), deployment: plain(deployment) };
  });
}

async function intakeConfigForPublication(publication, { models }) {
  if (publication.scopeType === 'group') {
    return models.IntakeConfig.findOne({
      where: { assignment_scope: 'group', group_id: positiveInteger(publication.grupoClinicaId) },
      raw: true,
    });
  }
  const clinicId = positiveInteger(publication.clinicaId);
  const direct = await models.IntakeConfig.findOne({
    where: { assignment_scope: 'clinic', clinic_id: clinicId },
    raw: true,
  });
  if (direct) return direct;
  const clinic = await models.Clinica.findByPk(clinicId, { attributes: ['grupoClinicaId'], raw: true });
  const groupId = positiveInteger(clinic?.grupoClinicaId);
  if (!groupId) return null;
  const inherited = await models.IntakeConfig.findOne({
    where: { assignment_scope: 'group', group_id: groupId },
    raw: true,
  });
  const locations = Array.isArray(inherited?.config?.locations) ? inherited.config.locations : [];
  return locations.some((location) => positiveInteger(location?.id ?? location?.clinic_id) === clinicId)
    ? inherited
    : null;
}

async function trustedRuntimeForPublication(publication, { models, env = process.env }) {
  const intake = await intakeConfigForPublication(publication, { models });
  const measurement = measurementFromIntake(intake);
  return normalizeTrustedRuntime({
    measurement: measurement.enabled
      ? { ...measurement, api_url: installationApiBase(env) }
      : measurement,
  }, { environment: 'production' });
}

async function loadArtifactBundle({ deployment, publication, models, compile, env = process.env }) {
  const runtime = await trustedRuntimeForPublication(publication, { models, env });
  if (deployment.artifactId) {
    const artifact = await models.WebArtifact.findByPk(deployment.artifactId);
    if (!artifact || artifact.projectId !== publication.projectId || artifact.environment !== 'production') {
      throw new WebPublicationServiceError('web_artifact_not_found', 'El artefacto no existe.', 404);
    }
    if (artifact.runtimeConfigHash === runtime.runtime_config_hash) {
      return { row: artifact, serialized: {
        id: artifact.id,
        artifact_hash: artifact.artifactHash,
        manifest: artifact.manifest,
        files: artifact.files,
      } };
    }
  }
  const clinicId = positiveInteger(publication.configuration?.clinic_id);
  const serialized = await compile({
    actorId: deployment.actorUserId,
    revisionId: deployment.revisionId,
    body: {
      environment: 'production',
      base_url: publicationBaseUrl(publication),
      clinic_id: clinicId,
      intake_endpoint: '/_clinicaclick/intake',
    },
    trustedRuntime: runtime,
    // A rollback may target an immutable revision which became `superseded`
    // after a newer revision was approved. The compiler accepts that status
    // only after revalidating this previously verified production artifact.
    rollbackSource: deployment.action === 'rollback'
      ? { publicationId: publication.id, artifactId: deployment.artifactId }
      : null,
  });
  const row = await models.WebArtifact.findByPk(serialized.id);
  if (!row) throw new WebPublicationServiceError('web_artifact_not_found', 'El artefacto no existe.', 404);
  return { row, serialized };
}

function shouldStorePublicBundle(publication, env) {
  if (publication.channel === 'wordpress') return true;
  return ['1', 'true', 'on', 'yes'].includes(String(env.MARKETING_WEB_ARTIFACT_STORE_ENABLED || '').toLowerCase());
}

function artifactStorageContract(storage, artifact) {
  const value = storage && typeof storage === 'object' && !Array.isArray(storage) ? storage : {};
  const artifactHash = String(artifact?.artifact_hash || '').trim();
  const manifestHash = String(artifact?.manifest?.artifact_hash || '').trim();
  const providerSupported = value.provider === 's3_immutable' || value.provider === 'authenticated_db';
  const storedHash = String(value.artifact_hash || '').trim();
  const expectedPaths = Object.keys(artifact?.files || {}).sort();
  const storedFiles = value.files && typeof value.files === 'object' && !Array.isArray(value.files)
    ? value.files
    : null;
  const storedPaths = storedFiles ? Object.keys(storedFiles).sort() : [];
  const pathsMatch = storedFiles !== null
    && expectedPaths.length === storedPaths.length
    && expectedPaths.every((path, index) => path === storedPaths[index]);
  const urls = [value.manifest_url, value.signature_url]
    .concat(storedFiles ? Object.values(storedFiles) : []);
  let origin = null;
  const urlsSafe = urls.length >= 2 && urls.every((input) => {
    try {
      const url = new URL(String(input || ''));
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return false;
      const currentOrigin = url.origin.toLowerCase();
      if (origin && origin !== currentOrigin) return false;
      origin = currentOrigin;
      return true;
    } catch {
      return false;
    }
  });
  const artifactValid = /^[a-f0-9]{64}$/.test(artifactHash) && artifactHash === manifestHash;
  return {
    ready: artifactValid
      && providerSupported
      && storedHash === artifactHash
      && pathsMatch
      && urlsSafe,
    artifact_hash: artifactHash,
  };
}

function assertArtifactStorageContract(storage, artifact) {
  const contract = artifactStorageContract(storage, artifact);
  if (!contract.ready) {
    throw new WebPublicationServiceError(
      'web_artifact_storage_contract_invalid',
      'El almacenamiento no corresponde al artefacto compilado.',
      503
    );
  }
  return storage;
}

async function verifyPublicArtifact({
  publicUrl,
  inputHash,
  httpClient = axios,
  resolveTarget = resolveSafeHttpTarget,
  timeoutMs = 10000,
  attempts = 1,
  retryDelayMs = 350,
  maxRedirects = 3,
}) {
  if (!httpClient || typeof httpClient.get !== 'function' || typeof resolveTarget !== 'function') return false;
  const count = Math.max(1, Math.min(5, Number(attempts) || 1));
  const redirects = Math.max(0, Math.min(5, Number(maxRedirects) || 0));
  for (let attempt = 1; attempt <= count; attempt += 1) {
    try {
      const initial = publicHttpUrl(publicUrl, { requireHttps: true });
      if (!initial) return false;
      const target = new URL(initial);
      target.searchParams.set(
        'cc_health',
        `${String(inputHash || '').slice(0, 16)}-${attempt}-${Date.now()}`
      );
      let currentUrl = target.toString();
      for (let redirectCount = 0; redirectCount <= redirects; redirectCount += 1) {
        // Every hop resolves again and the HTTP agents pin that exact public
        // address set. A later DNS answer therefore cannot rebind the socket to
        // loopback, RFC1918 or metadata services.
        const safeTarget = await resolveTarget(currentUrl);
        let response;
        try {
          response = await httpClient.get(safeTarget.url, {
            timeout: Math.max(500, Math.min(30000, Number(timeoutMs) || 10000)),
            maxRedirects: 0,
            maxContentLength: 1024 * 1024,
            maxBodyLength: 1024 * 1024,
            responseType: 'text',
            transformResponse: [(value) => value],
            proxy: false,
            validateStatus: (status) => status >= 200 && status < 400,
            httpAgent: safeTarget.httpAgent,
            httpsAgent: safeTarget.httpsAgent,
            headers: {
              accept: 'text/html,application/xhtml+xml',
              'cache-control': 'no-cache, no-store, max-age=0',
              pragma: 'no-cache',
              'user-agent': 'Clinicaclick-Web-Health/1.0',
            },
          });
        } finally {
          safeTarget.httpAgent?.destroy?.();
          safeTarget.httpsAgent?.destroy?.();
        }
        const status = Number(response?.status || 0);
        if (status >= 300 && status < 400) {
          const location = String(response?.headers?.location || '').trim();
          if (!location || redirectCount === redirects) break;
          let redirected = null;
          try {
            redirected = new URL(location, safeTarget.url).toString();
          } catch {
            redirected = null;
          }
          currentUrl = publicHttpUrl(redirected, { requireHttps: true });
          if (!currentUrl) break;
          continue;
        }
        if (status === 200) {
          const html = String(response?.data || '').slice(0, 256 * 1024);
          const match = html.match(/<meta\s+name=["']clinicaclick-artifact-input["']\s+content=["']([a-f0-9]{64})["']/i);
          if (match?.[1] === inputHash) return true;
        }
        break;
      }
    } catch {
      // A public CDN/origin may need a short propagation window.
    }
    if (attempt < count && retryDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, Math.min(2000, retryDelayMs)));
    }
  }
  return false;
}

function domainMatchesPublication(domain, publication) {
  const value = plain(domain);
  if (!value || value.kind !== 'custom_domain' || String(value.id) !== String(publication.domainId)) return false;
  if (String(value.host || '').toLowerCase() !== String(publication.host || '').toLowerCase()) return false;
  if (value.scopeType !== publication.scopeType) return false;
  return value.scopeType === 'clinic'
    ? Number(value.clinicaId) === Number(publication.clinicaId)
    : Number(value.grupoClinicaId) === Number(publication.grupoClinicaId);
}

async function revalidateCustomDomain({
  publication,
  models,
  inspectDomainDns = inspectDns,
  inspectDomainTls = inspectTls,
}) {
  const domain = await models.WebDomain.findByPk(publication.domainId);
  if (!domainMatchesPublication(domain, publication) || domain.status !== 'ready') {
    throw new WebPublicationServiceError(
      'web_domain_not_ready',
      'El dominio personalizado ya no está listo para publicar.',
      409
    );
  }
  const dnsResult = await inspectDomainDns({ domain });
  if (dnsResult?.ownership_verified !== true || dnsResult?.routing_verified !== true) {
    throw new WebPublicationServiceError(
      'web_domain_dns_revalidation_failed',
      'El DNS del dominio cambió durante la publicación.',
      503,
      { domain_id: domain.id }
    );
  }
  const tlsResult = await inspectDomainTls(domain.host);
  if (tlsResult?.ready !== true) {
    throw new WebPublicationServiceError(
      'web_domain_tls_revalidation_failed',
      'El certificado del dominio dejó de estar disponible durante la publicación.',
      503,
      { domain_id: domain.id, reason: String(tlsResult?.reason || 'tls_not_ready').slice(0, 64) }
    );
  }
  return {
    domain_id: domain.id,
    ownership_verified: true,
    routing_verified: true,
    tls_ready: true,
    checked_at: new Date().toISOString(),
  };
}

async function channelDeploy({
  publication,
  deployment,
  artifact,
  storage,
  env,
  publishHosted,
  restoreHosted = restoreHostedRoutePointer,
  verifyHosted,
  verifyPublic,
  inspectDomainDns = inspectDns,
  inspectDomainTls = inspectTls,
  models,
}) {
  if (publication.channel === 'wordpress') {
    const installation = await models.WebWordpressInstallation.findByPk(publication.wordpressInstallationId);
    // Re-check at the final pointer transition as well as at enqueue time. A
    // token rotation can move an installation back to pending while a job is
    // running; an old lastArtifactHash must never complete that publication.
    if (!installation || installation.status !== 'connected') {
      throw new WebPublicationServiceError('web_wordpress_not_connected', 'El plugin de WordPress no está conectado.', 409);
    }
    if (manifestHasGlobalIntakeContract(artifact.manifest)) {
      const actualVersion = String(installation.pluginVersion || '').trim() || null;
      if (!semverAtLeast(actualVersion, MIN_GLOBAL_INTAKE_PLUGIN_VERSION)) {
        throw new WebPublicationServiceError(
          'web_wordpress_global_intake_plugin_outdated',
          'Actualiza el plugin de WordPress antes de desplegar un formulario global.',
          409,
          {
            actual_plugin_version: actualVersion,
            required_plugin_version: MIN_GLOBAL_INTAKE_PLUGIN_VERSION,
          }
        );
      }
    }
    if (String(installation.lastArtifactHash || '') !== String(artifact.artifact_hash)) {
      return {
        waiting: true,
        result: {
          reason: 'wordpress_waiting_for_pull',
          desired_artifact_hash: artifact.artifact_hash,
          installation_id: installation.id,
        },
      };
    }
    const publicUrl = `${publicationBaseUrl(publication)}/`;
    const publicVerified = await verifyPublic({
      publicUrl,
      inputHash: artifact.manifest?.artifact_input_hash,
      attempts: 3,
      retryDelayMs: 500,
    });
    if (!publicVerified) {
      throw new WebPublicationServiceError(
        'web_wordpress_public_healthcheck_failed',
        'WordPress ha sincronizado el artefacto, pero la URL pública todavía no sirve esa revisión.',
        503,
        { public_url: publicUrl }
      );
    }
    return {
      waiting: false,
      result: {
        provider: 'wordpress_pull',
        verified: true,
        public_verified: true,
        public_url: publicUrl,
        plugin_version: installation.pluginVersion || null,
        last_seen_at: installation.lastSeenAt || null,
      },
    };
  }

  const domainHealth = publication.channel === 'custom_domain'
    ? await revalidateCustomDomain({ publication, models, inspectDomainDns, inspectDomainTls })
    : null;
  const hosted = await publishHosted({
    artifact,
    host: publication.host,
    routePath: publication.path,
    hostingRoot: env.MARKETING_WEB_HOSTING_ROOT,
  });
  try {
    const localVerified = hosted.verified && await verifyHosted({
      artifactHash: artifact.artifact_hash,
      artifact,
      host: publication.host,
      routePath: publication.path,
      hostingRoot: env.MARKETING_WEB_HOSTING_ROOT,
    });
    if (!localVerified) {
      throw new WebPublicationServiceError(
        'web_hosted_pointer_verification_failed',
        'El origen no ha confirmado el nuevo artefacto.',
        503
      );
    }
    const inputHash = artifact.manifest?.artifact_input_hash;
    const publicVerified = await verifyPublic({
      publicUrl: hosted.public_url,
      inputHash,
    });
    if (!publicVerified) {
      throw new WebPublicationServiceError(
        'web_public_healthcheck_failed',
        'La URL pública todavía no sirve la revisión esperada.',
        503,
        { public_url: hosted.public_url }
      );
    }
    return {
      waiting: false,
      result: {
        ...hosted,
        public_verified: true,
        storage_manifest_url: storage?.manifest_url || null,
        ...(domainHealth ? { domain_health: domainHealth } : {}),
      },
    };
  } catch (error) {
    try {
      error.pointer_compensation = await restoreHosted({
        host: publication.host,
        routePath: publication.path,
        failedArtifactHash: artifact.artifact_hash,
        previousArtifactHash: hosted.previous_artifact_hash ?? null,
        hostingRoot: env.MARKETING_WEB_HOSTING_ROOT,
      });
    } catch (compensationError) {
      throw new WebPublicationServiceError(
        'web_hosted_pointer_compensation_failed',
        'No se pudo restaurar de forma segura la última versión válida.',
        503,
        {
          original_error: String(error?.code || error?.message || 'healthcheck_failed').slice(0, 128),
          compensation_error: String(compensationError?.code || compensationError?.message || 'compensation_failed').slice(0, 128),
        }
      );
    }
    throw error;
  }
}

async function compensateHostedDeployment({ publication, artifact, channelResult, env, restoreHosted }) {
  if (publication.channel === 'wordpress' || !channelResult?.result) return null;
  return restoreHosted({
    host: publication.host,
    routePath: publication.path,
    failedArtifactHash: artifact.artifact_hash,
    previousArtifactHash: channelResult.result.previous_artifact_hash ?? null,
    hostingRoot: env.MARKETING_WEB_HOSTING_ROOT,
  });
}

async function finishDeployment({
  deploymentId,
  publicationId,
  artifactId,
  result,
  storage,
  models,
  sequelize,
  enqueueUniqueJob = jobRequestsService.enqueueUniqueJobRequest,
}) {
  return sequelize.transaction(async (transaction) => {
    const { project, publication, deployment } = await lockDeploymentGraph({
      deploymentId, publicationId, models, transaction,
    });
    if (deployment.status === 'verified') {
      return { publication: serializePublication(publication), deployment: serializeDeployment(deployment) };
    }
    if (Number(publication.version) !== Number(deployment.expectedPublicationVersion)) {
      await deployment.update({ status: 'superseded', completedAt: new Date(), errorCode: 'web_publication_version_changed' }, { transaction });
      return { publication: serializePublication(publication), deployment: serializeDeployment(deployment), superseded: true };
    }
    const artifact = await models.WebArtifact.findByPk(artifactId, { transaction });
    if (!artifact || artifact.projectId !== project.id || artifact.environment !== 'production') {
      throw new WebPublicationServiceError('web_artifact_not_found', 'El artefacto no existe.', 404);
    }
    const now = new Date();
    const integrationEvent = landingPublishedEvent({
      project, publication, deployment, artifact, occurredAt: now,
    });
    const activateProject = project.status === 'active'
      ? Promise.resolve(project)
      : project.update({
        status: 'active',
        version: Number(project.version || 0) + 1,
        updatedByUserId: deployment.actorUserId || project.updatedByUserId || null,
      }, { transaction });
    await Promise.all([
      activateProject,
      deployment.update({
        artifactId: artifact.id,
        status: 'verified',
        storage: storage || deployment.storage || {},
        result: result || {},
        completedAt: now,
        errorCode: null,
        errorDetails: null,
      }, { transaction }),
      publication.update({
        activeRevisionId: artifact.revisionId,
        desiredRevisionId: artifact.revisionId,
        activeArtifactId: artifact.id,
        lastGoodArtifactId: artifact.id,
        status: 'published',
        health: {
          status: 'healthy',
          artifact_hash: artifact.artifactHash,
          checked_at: now.toISOString(),
          channel: publication.channel,
        },
        lastHealthyAt: now,
        publishedAt: now,
        jobRequestId: null,
        version: Number(publication.version) + 1,
        lastErrorCode: null,
        lastErrorMessage: null,
      }, { transaction }),
      models.WebAuditEvent.create({
        projectId: project.id,
        ...scopeColumns(scopeFromProject(plain(project))),
        actorUserId: deployment.actorUserId || null,
        eventType: deployment.action === 'rollback'
          ? 'web.publication.rolled_back'
          : 'web.publication.published',
        entityType: 'web_publication_deployment',
        entityId: deployment.id,
        requestId: deployment.requestId || null,
        previousHash: null,
        nextHash: artifact.artifactHash,
        metadata: {
          publication_id: publication.id,
          sequence: deployment.sequence,
          channel: publication.channel,
          campaign_event_id: integrationEvent?.event_id || null,
        },
      }, { transaction }),
    ]);
    const integration = await enqueueLandingPublishedEvent({
      event: integrationEvent,
      models,
      sequelize,
      transaction,
      enqueueUniqueJob,
    });
    return {
      publication: serializePublication(publication),
      deployment: serializeDeployment(deployment),
      integration_event: integration,
    };
  });
}

async function failDeployment({ deploymentId, publicationId, error, models, sequelize }) {
  const safe = safeError(error);
  return sequelize.transaction(async (transaction) => {
    const { project, publication, deployment } = await lockDeploymentGraph({
      deploymentId, publicationId, models, transaction,
    });
    if (['verified', 'failed', 'superseded'].includes(deployment.status)) return;
    await Promise.all([
      deployment.update({
        status: 'failed',
        errorCode: safe.code,
        errorDetails: { message: safe.message },
        completedAt: new Date(),
      }, { transaction }),
      publication.update({
        status: 'failed',
        lastErrorCode: safe.code,
        lastErrorMessage: safe.message,
        jobRequestId: null,
      }, { transaction }),
      models.WebAuditEvent.create({
        projectId: project.id,
        ...scopeColumns(scopeFromProject(plain(project))),
        actorUserId: deployment.actorUserId || null,
        eventType: 'web.publication.failed',
        entityType: 'web_publication_deployment',
        entityId: deployment.id,
        requestId: deployment.requestId || null,
        metadata: { publication_id: publication.id, error_code: safe.code },
      }, { transaction }),
    ]);
  });
}

async function runPublicationDeploymentJob(payload = {}, jobRequest = null, dependencies = {}) {
  const publicationId = String(payload.publication_id || '').trim();
  const deploymentId = String(payload.deployment_id || '').trim();
  if (!publicationId || !deploymentId) {
    return {
      status: 'failed', retryable: false,
      error: new Error('web_publication_deploy requires publication_id and deployment_id'),
    };
  }
  const models = dependencies.models || db;
  const sequelize = dependencies.sequelize || db.sequelize;
  const env = dependencies.env || process.env;
  try {
    const claimed = await claimDeployment({
      deploymentId,
      publicationId,
      jobRequest,
      models,
      sequelize,
      env,
      assertPublishingChannel: dependencies.assertWebPublishingChannelEnabled
        || assertWebPublishingChannelEnabled,
    });
    if (claimed.terminal) {
      return { status: 'completed', result: { skipped: true, reason: claimed.skipped } };
    }
    let publication = plain(claimed.publication);
    let deployment = plain(claimed.deployment);
    const bundle = await loadArtifactBundle({
      deployment,
      publication,
      models,
      compile: dependencies.compileRevision || compileRevision,
      env,
    });
    let storage = deployment.storage || {};
    if (shouldStorePublicBundle(publication, env)) {
      // El runtime de medición forma parte del hash del artefacto. Un retry
      // puede recompilar tras rotar HMAC/runtime aunque el deployment conserve
      // el descriptor inmutable anterior; una URL existente no demuestra que
      // ese descriptor pertenezca al bundle recién compilado.
      if (!artifactStorageContract(storage, bundle.serialized).ready) {
        storage = await (dependencies.storeArtifactBundle || storeArtifactBundle)({
          artifact: bundle.serialized,
          installationId: publication.wordpressInstallationId || null,
          env,
        });
      }
      assertArtifactStorageContract(storage, bundle.serialized);
    }
    const persisted = await persistArtifactPreparation({
      deploymentId,
      publicationId,
      artifactId: bundle.row.id,
      storage,
      models,
      sequelize,
    });
    publication = persisted.publication;
    deployment = persisted.deployment;
    const channelResult = await channelDeploy({
      publication,
      deployment,
      artifact: bundle.serialized,
      storage,
      env,
      publishHosted: dependencies.publishHostedArtifact || publishHostedArtifact,
      restoreHosted: dependencies.restoreHostedRoutePointer || restoreHostedRoutePointer,
      verifyHosted: dependencies.verifyHostedPointer || verifyHostedPointer,
      verifyPublic: dependencies.verifyPublicArtifact || verifyPublicArtifact,
      inspectDomainDns: dependencies.inspectDomainDns || inspectDns,
      inspectDomainTls: dependencies.inspectDomainTls || inspectTls,
      models,
    });
    if (channelResult.waiting) {
      return {
        status: 'waiting',
        nextAllowedAt: new Date(Date.now() + 60 * 1000),
        result: channelResult.result,
      };
    }
    let finished;
    try {
      finished = await (dependencies.finishDeployment || finishDeployment)({
        deploymentId,
        publicationId,
        artifactId: bundle.row.id,
        result: channelResult.result,
        storage,
        models,
        sequelize,
        enqueueUniqueJob: dependencies.enqueueUniqueJobRequest || jobRequestsService.enqueueUniqueJobRequest,
      });
    } catch (error) {
      await compensateHostedDeployment({
        publication,
        artifact: bundle.serialized,
        channelResult,
        env,
        restoreHosted: dependencies.restoreHostedRoutePointer || restoreHostedRoutePointer,
      });
      throw error;
    }
    if (finished?.superseded) {
      await compensateHostedDeployment({
        publication,
        artifact: bundle.serialized,
        channelResult,
        env,
        restoreHosted: dependencies.restoreHostedRoutePointer || restoreHostedRoutePointer,
      });
    }
    return { status: 'completed', result: finished };
  } catch (error) {
    if (['web_publishing_channel_disabled', 'web_publishing_disabled', 'web_editor_disabled'].includes(error?.code)) {
      return {
        status: 'waiting',
        nextAllowedAt: new Date(Date.now() + 15 * 60 * 1000),
        result: {
          reason: 'web_publishing_gate_closed',
          code: String(error.code),
          channel: error?.details?.channel || null,
          rollout_reason: error?.details?.rollout_reason || null,
        },
      };
    }
    const retryable = Number(error?.status || 500) >= 500;
    const attempts = Number(jobRequest?.attempts || 0);
    const maxAttempts = Number(jobRequest?.max_attempts || jobRequest?.maxAttempts || 5);
    if (!retryable || (attempts > 0 && attempts >= maxAttempts)) {
      await failDeployment({ deploymentId, publicationId, error, models, sequelize }).catch(() => undefined);
    }
    return { status: 'failed', retryable, error };
  }
}

module.exports = {
  LANDING_PUBLISHED_EVENT,
  artifactStorageContract,
  assertArtifactStorageContract,
  campaignDestinationUrl,
  channelDeploy,
  compensateHostedDeployment,
  claimDeployment,
  failDeployment,
  finishDeployment,
  landingPublishedEvent,
  loadArtifactBundle,
  intakeConfigForPublication,
  lockDeploymentGraph,
  persistArtifactPreparation,
  runPublicationDeploymentJob,
  safeError,
  shouldStorePublicBundle,
  trustedRuntimeForPublication,
  revalidateCustomDomain,
  verifyPublicArtifact,
};
