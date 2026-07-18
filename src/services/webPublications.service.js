'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const { assertWebPublishingEnabled } = require('../lib/marketingWebFeatureFlags');
const {
  assertProjectAccess,
  positiveInteger,
  normalizeCampaignContext,
  scopeColumns,
  scopeFromProject,
} = require('./webProjects.service');
const { normalizeHost, normalizeRoutePath } = require('./webHostedPublisher.service');
const jobRequestsService = require('./jobRequests.service');

const PUBLICATION_CHANNELS = new Set(['clinicaclick_hosted', 'wordpress', 'custom_domain']);
const BUSY_PUBLICATION_STATUSES = new Set(['pending', 'publishing', 'rolling_back']);
const TERMINAL_DEPLOYMENT_STATUSES = new Set(['verified', 'failed', 'superseded']);

class WebPublicationServiceError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'WebPublicationServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(slug)) {
    throw new WebPublicationServiceError(
      'web_publication_slug_invalid',
      'El identificador público debe usar letras minúsculas, números y guiones.',
      422
    );
  }
  return slug;
}

function hostedTarget(input = {}, env = process.env) {
  const slug = normalizeSlug(input.slug);
  const baseHost = normalizeHost(env.MARKETING_WEB_HOSTED_DOMAIN || 'sites.clinicaclick.com');
  const mode = String(env.MARKETING_WEB_HOSTED_MODE || 'path').trim().toLowerCase();
  if (mode === 'subdomain') {
    return { host: normalizeHost(`${slug}.${baseHost}`), path: '/', slug, hosted_mode: mode };
  }
  if (mode !== 'path') {
    throw new WebPublicationServiceError(
      'web_publication_hosting_mode_invalid',
      'MARKETING_WEB_HOSTED_MODE debe ser path o subdomain.',
      500
    );
  }
  return { host: baseHost, path: normalizeRoutePath(`/${slug}/`), slug, hosted_mode: mode };
}

function normalizeSiteUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.search
      || url.hash
      || url.port
      || url.pathname.replace(/\/+$/, '')
    ) throw new Error('unsafe');
    return { url: `https://${normalizeHost(url.hostname)}`, host: normalizeHost(url.hostname) };
  } catch {
    throw new WebPublicationServiceError(
      'web_wordpress_site_url_invalid',
      'La URL de WordPress debe ser el origen HTTPS público, sin rutas ni parámetros.',
      422
    );
  }
}

function publicationBaseUrl(publication) {
  const value = plain(publication);
  const normalizedPath = normalizeRoutePath(value.path);
  return `https://${normalizeHost(value.host)}${normalizedPath}`.replace(/\/$/, '');
}

function scopeMatches(resource, scope) {
  const value = plain(resource);
  if (!value || value.scopeType !== scope.type) return false;
  return scope.type === 'clinic'
    ? Number(value.clinicaId) === Number(scope.id)
    : Number(value.grupoClinicaId) === Number(scope.id);
}

function serializePublication(row) {
  const value = plain(row);
  return {
    id: value.id,
    project_id: value.projectId,
    scope: {
      type: value.scopeType,
      id: Number(value.scopeType === 'clinic' ? value.clinicaId : value.grupoClinicaId),
    },
    channel: value.channel,
    domain_id: value.domainId || null,
    wordpress_installation_id: value.wordpressInstallationId || null,
    host: value.host,
    path: value.path,
    public_url: publicationBaseUrl(value) + '/',
    status: value.status,
    desired_revision_id: value.desiredRevisionId || null,
    active_revision_id: value.activeRevisionId || null,
    active_artifact_id: value.activeArtifactId || null,
    last_good_artifact_id: value.lastGoodArtifactId || null,
    configuration: value.configuration || {},
    health: value.health || {},
    last_error: value.lastErrorCode ? {
      code: value.lastErrorCode,
      message: value.lastErrorMessage || null,
    } : null,
    job_request_id: value.jobRequestId || null,
    version: Number(value.version),
    published_at: value.publishedAt || null,
    last_healthy_at: value.lastHealthyAt || null,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

function campaignContextSnapshot(project) {
  return normalizeCampaignContext(plain(project)?.campaignContext);
}

function serializeDeployment(row) {
  const value = plain(row);
  return {
    id: value.id,
    publication_id: value.publicationId,
    project_id: value.projectId,
    revision_id: value.revisionId || null,
    artifact_id: value.artifactId || null,
    previous_artifact_id: value.previousArtifactId || null,
    sequence: Number(value.sequence),
    action: value.action,
    status: value.status,
    storage: value.storage || {},
    result: value.result || {},
    error_code: value.errorCode || null,
    job_request_id: value.jobRequestId || null,
    started_at: value.startedAt || null,
    completed_at: value.completedAt || null,
    created_at: value.created_at,
  };
}

async function selectedClinicForProject(project, requestedClinicId, { models, transaction }) {
  const scope = scopeFromProject(plain(project));
  if (scope.type === 'clinic') return scope.id;
  const clinicId = positiveInteger(requestedClinicId);
  if (!clinicId) {
    throw new WebPublicationServiceError(
      'web_publication_clinic_required',
      'Selecciona la clínica concreta que aportará datos y captación a esta publicación.',
      422
    );
  }
  const clinic = await models.Clinica.findByPk(clinicId, {
    attributes: ['id_clinica', 'grupoClinicaId'],
    raw: true,
    transaction,
  });
  if (!clinic || Number(clinic.grupoClinicaId) !== Number(scope.id)) {
    throw new WebPublicationServiceError('web_publication_clinic_not_found', 'La clínica no existe.', 404);
  }
  return clinicId;
}

async function resolveTarget({ project, body, models, transaction, env }) {
  const channel = String(body.channel || '').trim().toLowerCase();
  if (!PUBLICATION_CHANNELS.has(channel)) {
    throw new WebPublicationServiceError('web_publication_channel_invalid', 'El canal de publicación no es válido.', 422);
  }
  const scope = scopeFromProject(plain(project));
  if (channel === 'clinicaclick_hosted') {
    const target = hostedTarget(body, env);
    return { channel, ...target, domainId: null, wordpressInstallationId: null };
  }
  if (channel === 'custom_domain') {
    const domain = await models.WebDomain.findByPk(String(body.domain_id || ''), { transaction });
    if (!domain || !scopeMatches(domain, scope)) {
      throw new WebPublicationServiceError('web_domain_not_found', 'El dominio no existe.', 404);
    }
    return {
      channel,
      host: normalizeHost(domain.host),
      path: normalizeRoutePath(body.path || '/'),
      domainId: domain.id,
      wordpressInstallationId: null,
      domain_status: domain.status,
    };
  }
  const installation = await models.WebWordpressInstallation.findByPk(
    String(body.wordpress_installation_id || ''),
    { transaction }
  );
  if (!installation || installation.status === 'revoked' || !scopeMatches(installation, scope)) {
    throw new WebPublicationServiceError('web_wordpress_installation_not_found', 'La instalación no existe.', 404);
  }
  const site = normalizeSiteUrl(installation.siteUrl);
  const requestedPath = normalizeRoutePath(body.path || '/cita/');
  if (requestedPath !== '/cita/') {
    throw new WebPublicationServiceError(
      'web_wordpress_publication_path_invalid',
      'Las páginas gestionadas en WordPress se publican bajo /cita/.',
      422
    );
  }
  return {
    channel,
    host: site.host,
    path: requestedPath,
    domainId: null,
    wordpressInstallationId: installation.id,
    wordpress_status: installation.status,
  };
}

async function createPublication({
  actorId,
  body = {},
  models = db,
  sequelize = db.sequelize,
  env = process.env,
  assertAccess = assertProjectAccess,
  assertPublishing = assertWebPublishingEnabled,
} = {}) {
  const projectId = String(body.project_id || '').trim();
  return sequelize.transaction(async (transaction) => {
    const project = await models.WebProject.findByPk(projectId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!project) throw new WebPublicationServiceError('web_project_not_found', 'El proyecto no existe.', 404);
    await assertAccess(actorId, project, 'marketing.web.publish', { models, transaction });
    const scope = scopeFromProject(plain(project));
    assertPublishing(scope);
    if (project.status === 'archived') {
      throw new WebPublicationServiceError('web_project_archived', 'Un proyecto archivado no se puede publicar.', 409);
    }
    const target = await resolveTarget({ project, body, models, transaction, env });
    const clinicId = await selectedClinicForProject(project, body.clinic_id, { models, transaction });
    const campaignContext = campaignContextSnapshot(project);
    try {
      const publication = await models.WebPublication.create({
        id: crypto.randomUUID(),
        projectId: project.id,
        ...scopeColumns(scope),
        channel: target.channel,
        domainId: target.domainId,
        wordpressInstallationId: target.wordpressInstallationId,
        host: target.host,
        path: target.path,
        status: 'draft',
        configuration: {
          clinic_id: clinicId,
          ...(campaignContext ? { campaign_context: campaignContext } : {}),
          ...(target.slug ? { slug: target.slug, hosted_mode: target.hosted_mode } : {}),
        },
        health: {},
        version: 1,
        createdByUserId: positiveInteger(actorId),
        updatedByUserId: positiveInteger(actorId),
      }, { transaction });
      await models.WebAuditEvent.create({
        projectId: project.id,
        ...scopeColumns(scope),
        actorUserId: positiveInteger(actorId),
        eventType: 'web.publication.created',
        entityType: 'web_publication',
        entityId: publication.id,
        requestId: body.request_id || null,
        metadata: {
          channel: target.channel,
          host_hash: sha256(target.host),
          path: target.path,
          campaign_context: campaignContext,
        },
      }, { transaction });
      return serializePublication(publication);
    } catch (error) {
      if (error?.name === 'SequelizeUniqueConstraintError') {
        throw new WebPublicationServiceError(
          'web_publication_target_in_use',
          'Ese destino ya está asignado a otra publicación.',
          409
        );
      }
      throw error;
    }
  });
}

async function getPublicationForActor({
  actorId,
  publicationId,
  feature = 'marketing.web.view',
  models = db,
  assertAccess = assertProjectAccess,
} = {}) {
  const publication = await models.WebPublication.findByPk(String(publicationId || ''));
  if (!publication) throw new WebPublicationServiceError('web_publication_not_found', 'La publicación no existe.', 404);
  const project = await models.WebProject.findByPk(publication.projectId);
  if (!project) throw new WebPublicationServiceError('web_publication_not_found', 'La publicación no existe.', 404);
  try {
    await assertAccess(actorId, project, feature, { models });
  } catch (error) {
    if (Number(error?.status) === 403) {
      throw new WebPublicationServiceError('web_publication_not_found', 'La publicación no existe.', 404);
    }
    throw error;
  }
  return { publication, project };
}

async function listProjectPublications({
  actorId,
  projectId,
  query = {},
  models = db,
  assertAccess = assertProjectAccess,
} = {}) {
  const project = await models.WebProject.findByPk(String(projectId || ''));
  if (!project) throw new WebPublicationServiceError('web_project_not_found', 'El proyecto no existe.', 404);
  await assertAccess(actorId, project, 'marketing.web.view', { models });
  const limit = Math.min(Math.max(1, Number.parseInt(String(query.limit || '20'), 10) || 20), 50);
  const rows = await models.WebPublication.findAll({
    where: {
      projectId: project.id,
      ...(query.include_retired === 'true' ? {} : { status: { [Op.ne]: 'retired' } }),
    },
    order: [['created_at', 'DESC'], ['id', 'DESC']],
    limit,
  });
  return { items: rows.map(serializePublication), pagination: { limit, has_more: rows.length === limit } };
}

async function assertChannelReady(publication, { models, transaction }) {
  const value = plain(publication);
  if (value.channel === 'custom_domain') {
    const domain = await models.WebDomain.findByPk(value.domainId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!domain || domain.status !== 'ready') {
      throw new WebPublicationServiceError(
        'web_domain_not_ready',
        'El dominio todavía no tiene DNS y certificado listos.',
        409
      );
    }
  }
  if (value.channel === 'wordpress') {
    const installation = await models.WebWordpressInstallation.findByPk(
      value.wordpressInstallationId,
      { transaction, lock: transaction.LOCK.UPDATE }
    );
    if (!installation || installation.status !== 'connected') {
      throw new WebPublicationServiceError(
        'web_wordpress_not_connected',
        'El plugin de WordPress todavía no ha confirmado la conexión.',
        409
      );
    }
  }
}

async function enqueueDeployment({
  actorId,
  publicationId,
  action,
  revisionId = null,
  artifactId = null,
  requestId = null,
  models = db,
  sequelize = db.sequelize,
  assertAccess = assertProjectAccess,
  assertPublishing = assertWebPublishingEnabled,
  enqueueJob = jobRequestsService.enqueueJobRequest,
} = {}) {
  return sequelize.transaction(async (transaction) => {
    const pointer = await models.WebPublication.findByPk(String(publicationId || ''), {
      attributes: ['id', 'projectId'], transaction,
    });
    if (!pointer) throw new WebPublicationServiceError('web_publication_not_found', 'La publicación no existe.', 404);
    const project = await models.WebProject.findByPk(pointer.projectId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!project) throw new WebPublicationServiceError('web_publication_not_found', 'La publicación no existe.', 404);
    await assertAccess(actorId, project, 'marketing.web.publish', { models, transaction });
    const scope = scopeFromProject(plain(project));
    assertPublishing(scope);
    const publication = await models.WebPublication.findByPk(pointer.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!publication || publication.projectId !== project.id) {
      throw new WebPublicationServiceError('web_publication_not_found', 'La publicación no existe.', 404);
    }
    if (BUSY_PUBLICATION_STATUSES.has(publication.status)) {
      throw new WebPublicationServiceError(
        'web_publication_busy',
        'Ya hay una actualización de esta publicación en curso.',
        409,
        { job_request_id: publication.jobRequestId || null }
      );
    }
    await assertChannelReady(publication, { models, transaction });

    let revision = null;
    let artifact = null;
    if (action === 'publish') {
      revision = await models.WebRevision.findByPk(String(revisionId || ''), {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!revision || revision.projectId !== project.id) {
        throw new WebPublicationServiceError('web_revision_not_found', 'La revisión no existe.', 404);
      }
      if (revision.status !== 'approved') {
        throw new WebPublicationServiceError(
          'web_revision_not_approved',
          'Solo se puede publicar una revisión aprobada.',
          409
        );
      }
    } else if (action === 'rollback') {
      artifact = await models.WebArtifact.findByPk(String(artifactId || ''), { transaction });
      if (!artifact || artifact.projectId !== project.id || artifact.environment !== 'production') {
        throw new WebPublicationServiceError('web_artifact_not_found', 'El artefacto no existe.', 404);
      }
      const previousVerified = await models.WebPublicationDeployment.findOne({
        where: { publicationId: publication.id, artifactId: artifact.id, status: 'verified' },
        transaction,
      });
      if (!previousVerified) {
        throw new WebPublicationServiceError(
          'web_artifact_not_previously_verified',
          'Solo puedes volver a una versión que ya estuvo publicada y verificada.',
          409
        );
      }
      revision = await models.WebRevision.findByPk(artifact.revisionId, { transaction });
    } else {
      throw new WebPublicationServiceError('web_publication_action_invalid', 'La acción no es válida.', 422);
    }

    const latest = await models.WebPublicationDeployment.findOne({
      where: { publicationId: publication.id },
      order: [['sequence', 'DESC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const sequence = Number(latest?.sequence || 0) + 1;
    const expectedVersion = Number(publication.version) + 1;
    const deployment = await models.WebPublicationDeployment.create({
      id: crypto.randomUUID(),
      publicationId: publication.id,
      projectId: project.id,
      revisionId: revision?.id || null,
      artifactId: artifact?.id || null,
      previousArtifactId: publication.activeArtifactId || null,
      sequence,
      action,
      status: 'queued',
      expectedPublicationVersion: expectedVersion,
      storage: {},
      result: {},
      requestId,
      actorUserId: positiveInteger(actorId),
    }, { transaction });
    await publication.update({
      desiredRevisionId: revision?.id || null,
      status: action === 'rollback' ? 'rolling_back' : 'pending',
      version: expectedVersion,
      updatedByUserId: positiveInteger(actorId),
      lastErrorCode: null,
      lastErrorMessage: null,
    }, { transaction });
    const job = await enqueueJob({
      type: 'web_publication_deploy',
      priority: 'high',
      origin: 'marketing_web',
      maxAttempts: 180,
      requestedBy: positiveInteger(actorId),
      payload: {
        publication_id: publication.id,
        deployment_id: deployment.id,
        scope_type: scope.type,
        ...(scope.type === 'clinic' ? { clinicId: scope.id } : { groupId: scope.id }),
      },
    }, { transaction, JobRequestModel: models.JobRequest });
    await Promise.all([
      deployment.update({ jobRequestId: job.id }, { transaction }),
      publication.update({ jobRequestId: job.id }, { transaction }),
      models.WebAuditEvent.create({
        projectId: project.id,
        ...scopeColumns(scope),
        actorUserId: positiveInteger(actorId),
        eventType: `web.publication.${action}_requested`,
        entityType: 'web_publication_deployment',
        entityId: deployment.id,
        requestId,
        previousHash: null,
        nextHash: revision?.documentHash || artifact?.artifactHash || null,
        metadata: { publication_id: publication.id, sequence, job_request_id: job.id },
      }, { transaction }),
    ]);
    return {
      publication: serializePublication(publication),
      deployment: serializeDeployment(deployment),
      job: { id: job.id, status: job.status },
    };
  });
}

async function listDeployments({
  actorId,
  publicationId,
  query = {},
  models = db,
  assertAccess = assertProjectAccess,
} = {}) {
  const { publication } = await getPublicationForActor({ actorId, publicationId, models, assertAccess });
  const limit = Math.min(Math.max(1, Number.parseInt(String(query.limit || '20'), 10) || 20), 50);
  const rows = await models.WebPublicationDeployment.findAll({
    where: { publicationId: publication.id },
    order: [['sequence', 'DESC']],
    limit,
  });
  return { items: rows.map(serializeDeployment), pagination: { limit, has_more: rows.length === limit } };
}

module.exports = {
  BUSY_PUBLICATION_STATUSES,
  PUBLICATION_CHANNELS,
  TERMINAL_DEPLOYMENT_STATUSES,
  WebPublicationServiceError,
  campaignContextSnapshot,
  createPublication,
  enqueueDeployment,
  getPublicationForActor,
  hostedTarget,
  listDeployments,
  listProjectPublications,
  normalizeSiteUrl,
  publicationBaseUrl,
  scopeMatches,
  serializeDeployment,
  serializePublication,
};
