'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const { assertWebPublishingChannelEnabled } = require('../lib/marketingWebFeatureFlags');
const {
  assertProjectAccess,
  positiveInteger,
  normalizeCampaignContext,
  scopeColumns,
  scopeFromProject,
} = require('./webProjects.service');
const { normalizeHost, normalizeRoutePath } = require('./webHostedPublisher.service');
const jobRequestsService = require('./jobRequests.service');
const {
  MIN_GLOBAL_INTAKE_PLUGIN_VERSION,
  documentHasGlobalIntakeForm,
  isReleasedWordpressPublication,
  semverAtLeast,
  supportsMultiPublication,
} = require('../lib/webWordpressCompatibility');

const PUBLICATION_CHANNELS = new Set(['clinicaclick_hosted', 'wordpress', 'custom_domain']);
const BUSY_PUBLICATION_STATUSES = new Set(['pending', 'publishing', 'rolling_back']);
const TERMINAL_DEPLOYMENT_STATUSES = new Set(['verified', 'failed', 'superseded']);
const MAX_WORDPRESS_PUBLICATIONS = 20;
// Retired routes remain immutable reservations so an old URL can never be
// silently rebound to another landing. Bound that history to keep the locked
// create/sync working set finite; an explicit archival migration can extend it
// later without weakening route ownership.
const MAX_WORDPRESS_PUBLICATION_HISTORY = 200;
const WORDPRESS_ROOT_PATH = '/cita/';
const WORDPRESS_RESERVED_ROUTE_SEGMENTS = new Set(['assets', 'robots.txt', 'sitemap.xml', 'api']);

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

function slugifyProjectName(value) {
  const slug = String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63)
    .replace(/-+$/g, '');
  return normalizeSlug(slug);
}

function wordpressPublicationPath(project, body, existingCount) {
  if (existingCount === 0) {
    const requested = normalizeRoutePath(body.path || WORDPRESS_ROOT_PATH);
    if (requested !== WORDPRESS_ROOT_PATH) {
      throw new WebPublicationServiceError(
        'web_wordpress_pilot_path_invalid',
        'La primera publicación conserva la ruta estable /cita/.',
        422
      );
    }
    return WORDPRESS_ROOT_PATH;
  }
  let requested = normalizeRoutePath(body.path || WORDPRESS_ROOT_PATH);
  if (requested === WORDPRESS_ROOT_PATH) {
    const slug = body.slug ? normalizeSlug(body.slug) : slugifyProjectName(plain(project)?.name);
    requested = `/cita/${slug}/`;
  }
  const match = requested.match(/^\/cita\/([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\/$/);
  if (!match || WORDPRESS_RESERVED_ROUTE_SEGMENTS.has(match[1])) {
    throw new WebPublicationServiceError(
      'web_wordpress_publication_path_invalid',
      'Las publicaciones adicionales usan una ruta única bajo /cita/.',
      422
    );
  }
  return requested;
}

function wordpressChildSegment(path) {
  const match = String(path || '').match(/^\/cita\/([^/]+)\/$/);
  return match ? match[1] : null;
}

function manifestClaimsWordpressChild(manifest, childSegment) {
  if (!childSegment) return false;
  const routes = manifest?.page_routes;
  if (!routes || typeof routes !== 'object' || Array.isArray(routes)) return false;
  return Object.values(routes).some((route) => {
    const first = String(route?.page_path || '/').split('/').filter(Boolean)[0] || null;
    return first === childSegment;
  });
}

function assertWordpressPilotManifestCompatible(publication, siblings, manifest) {
  const value = plain(publication);
  if (value?.channel !== 'wordpress' || value.path !== WORDPRESS_ROOT_PATH) return true;
  const childSegments = new Set((siblings || [])
    .map(plain)
    .filter((row) => row?.id !== value.id)
    .map((row) => wordpressChildSegment(row?.path))
    .filter(Boolean));
  const conflict = Object.values(manifest?.page_routes || {}).find((route) => {
    const first = String(route?.page_path || '/').split('/').filter(Boolean)[0] || null;
    return first && childSegments.has(first);
  });
  if (conflict) {
    throw new WebPublicationServiceError(
      'web_wordpress_publication_manifest_route_conflict',
      'Una página del piloto ocupa la ruta reservada por otra publicación.',
      409
    );
  }
  return true;
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
    retired_at: value.retiredAt || null,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

async function retireWordpressPublication({
  actorId,
  publicationId,
  requestId = null,
  models = db,
  sequelize = db.sequelize,
  assertAccess = assertProjectAccess,
} = {}) {
  return sequelize.transaction(async (transaction) => {
    const pointer = await models.WebPublication.findByPk(String(publicationId || ''), {
      attributes: ['id', 'projectId', 'channel', 'wordpressInstallationId'],
      transaction,
    });
    if (!pointer) {
      throw new WebPublicationServiceError('web_publication_not_found', 'La publicación no existe.', 404);
    }
    const project = await models.WebProject.findByPk(pointer.projectId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!project) {
      throw new WebPublicationServiceError('web_publication_not_found', 'La publicación no existe.', 404);
    }
    await assertAccess(actorId, project, 'marketing.web.publish', { models, transaction });
    if (pointer.channel !== 'wordpress' || !pointer.wordpressInstallationId) {
      throw new WebPublicationServiceError(
        'web_publication_retire_channel_unsupported',
        'Esta operación de retirada solo está disponible para publicaciones de WordPress.',
        409
      );
    }

    const installation = await models.WebWordpressInstallation.findByPk(pointer.wordpressInstallationId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!installation) {
      throw new WebPublicationServiceError('web_wordpress_installation_not_found', 'La instalación no existe.', 404);
    }
    const siblings = await models.WebPublication.findAll({
      where: { wordpressInstallationId: pointer.wordpressInstallationId },
      order: [['path', 'ASC'], ['id', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const publication = siblings.find((candidate) => String(candidate.id) === String(pointer.id));
    if (!publication || String(publication.projectId) !== String(project.id)) {
      throw new WebPublicationServiceError('web_publication_not_found', 'La publicación no existe.', 404);
    }
    if (publication.status === 'retired') {
      return { publication: serializePublication(publication), already_retired: true };
    }
    if (BUSY_PUBLICATION_STATUSES.has(publication.status)) {
      throw new WebPublicationServiceError(
        'web_publication_busy',
        'Espera a que termine la actualización antes de retirar esta publicación.',
        409,
        { job_request_id: publication.jobRequestId || null }
      );
    }
    const activeDeployment = await models.WebPublicationDeployment.findOne({
      where: {
        publicationId: publication.id,
        status: { [Op.in]: ['queued', 'running'] },
      },
      order: [['sequence', 'DESC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (activeDeployment) {
      throw new WebPublicationServiceError(
        'web_publication_busy',
        'Espera a que termine la actualización antes de retirar esta publicación.',
        409,
        { job_request_id: activeDeployment.jobRequestId || publication.jobRequestId || null }
      );
    }

    const retiredAt = new Date();
    await publication.update({
      status: 'retired',
      retiredAt,
      desiredRevisionId: null,
      jobRequestId: null,
      version: Number(publication.version) + 1,
      updatedByUserId: positiveInteger(actorId),
      lastErrorCode: null,
      lastErrorMessage: null,
    }, { transaction });
    const scope = scopeFromProject(plain(project));
    await models.WebAuditEvent.create({
      projectId: project.id,
      ...scopeColumns(scope),
      actorUserId: positiveInteger(actorId),
      eventType: 'web.publication.retired',
      entityType: 'web_publication',
      entityId: publication.id,
      requestId,
      metadata: {
        channel: 'wordpress',
        wordpress_installation_id: installation.id,
        host_hash: sha256(publication.host),
        path: publication.path,
        tombstone_pending: true,
      },
    }, { transaction });
    return { publication: serializePublication(publication), already_retired: false };
  });
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
    { transaction, lock: transaction?.LOCK?.UPDATE }
  );
  if (!installation || installation.status === 'revoked' || !scopeMatches(installation, scope)) {
    throw new WebPublicationServiceError('web_wordpress_installation_not_found', 'La instalación no existe.', 404);
  }
  const installationPublications = await models.WebPublication.findAll({
    where: { wordpressInstallationId: installation.id },
    order: [['created_at', 'ASC'], ['id', 'ASC']],
    transaction,
    lock: transaction?.LOCK?.UPDATE,
  });
  if (installationPublications.length >= MAX_WORDPRESS_PUBLICATION_HISTORY) {
    throw new WebPublicationServiceError(
      'web_wordpress_publication_history_limit_reached',
      'La instalación ha alcanzado el límite seguro de historial de rutas. Archiva rutas antiguas antes de publicar otra.',
      409
    );
  }
  const slotPublications = installationPublications
    .map(plain)
    .filter((row) => !isReleasedWordpressPublication(plain(installation), row));
  if (slotPublications.length >= MAX_WORDPRESS_PUBLICATIONS) {
    throw new WebPublicationServiceError(
      'web_wordpress_publication_limit_reached',
      `Una instalación admite como máximo ${MAX_WORDPRESS_PUBLICATIONS} publicaciones.`,
      409
    );
  }
  if (installationPublications.length > 0 && !supportsMultiPublication(installation)) {
    throw new WebPublicationServiceError(
      'web_wordpress_multi_publication_plugin_update_required',
      'Actualiza el plugin de WordPress antes de añadir otra publicación.',
      409
    );
  }
  const site = normalizeSiteUrl(installation.siteUrl);
  const requestedPath = wordpressPublicationPath(project, body, installationPublications.length);
  const childSegment = wordpressChildSegment(requestedPath);
  if (childSegment) {
    const pilot = installationPublications.map(plain).find((row) => row.path === WORDPRESS_ROOT_PATH);
    const artifactIds = [...new Set([pilot?.activeArtifactId, pilot?.lastGoodArtifactId].filter(Boolean))];
    if (pilot && typeof models.WebPublicationDeployment?.findOne === 'function') {
      const desiredDeployment = await models.WebPublicationDeployment.findOne({
        where: {
          publicationId: pilot.id,
          status: { [Op.in]: ['queued', 'running'] },
          artifactId: { [Op.ne]: null },
        },
        order: [['sequence', 'DESC']],
        transaction,
        lock: transaction?.LOCK?.UPDATE,
      });
      if (desiredDeployment?.artifactId) artifactIds.push(desiredDeployment.artifactId);
    }
    for (const artifactId of [...new Set(artifactIds)]) {
      const artifact = await models.WebArtifact.findByPk(artifactId, { transaction });
      if (manifestClaimsWordpressChild(plain(artifact)?.manifest, childSegment)) {
        throw new WebPublicationServiceError(
          'web_wordpress_publication_manifest_route_conflict',
          'La ruta ya pertenece a una página publicada dentro de /cita/.',
          409,
          { path: requestedPath }
        );
      }
    }
  }
  return {
    channel,
    host: site.host,
    path: requestedPath,
    domainId: null,
    wordpressInstallationId: installation.id,
    wordpress_status: installation.status,
    wordpress_publications: installationPublications.map(plain),
  };
}

async function createPublication({
  actorId,
  body = {},
  models = db,
  sequelize = db.sequelize,
  env = process.env,
  assertAccess = assertProjectAccess,
  assertPublishing = assertWebPublishingChannelEnabled,
} = {}) {
  const projectId = String(body.project_id || '').trim();
  return sequelize.transaction(async (transaction) => {
    const project = await models.WebProject.findByPk(projectId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!project) throw new WebPublicationServiceError('web_project_not_found', 'El proyecto no existe.', 404);
    await assertAccess(actorId, project, 'marketing.web.publish', { models, transaction });
    const scope = scopeFromProject(plain(project));
    const channel = String(body.channel || '').trim().toLowerCase();
    if (!PUBLICATION_CHANNELS.has(channel)) {
      throw new WebPublicationServiceError('web_publication_channel_invalid', 'El canal de publicación no es válido.', 422);
    }
    assertPublishing(scope, channel, env);
    if (project.status === 'archived') {
      throw new WebPublicationServiceError('web_project_archived', 'Un proyecto archivado no se puede publicar.', 409);
    }
    const target = await resolveTarget({ project, body, models, transaction, env });
    const existingTargets = await models.WebPublication.findAll({
      where: {
        host: target.host,
      },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const overlap = existingTargets
      .map(plain)
      .find((candidate) => {
        if (
          target.channel === 'wordpress'
          && candidate.channel === 'wordpress'
          && candidate.wordpressInstallationId === target.wordpressInstallationId
          && (candidate.path === WORDPRESS_ROOT_PATH || target.path === WORDPRESS_ROOT_PATH)
        ) return candidate.path === target.path;
        return publicationPathsOverlap(candidate.path, target.path);
      });
    if (overlap) {
      throw new WebPublicationServiceError(
        'web_publication_route_overlap',
        'Esa ruta se solapa con otra publicación del mismo dominio.',
        409,
        { path: target.path, conflicting_path: overlap.path }
      );
    }
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

function publicationPathsOverlap(left, right) {
  const a = String(left || '').trim();
  const b = String(right || '').trim();
  if (!a.startsWith('/') || !b.startsWith('/')) return true;
  if (a === '/' || b === '/') return true;
  return a === b || a.startsWith(b) || b.startsWith(a);
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

async function assertChannelReady(publication, { models, transaction, lockedWordpressInstallation = null }) {
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
    const installation = lockedWordpressInstallation || await models.WebWordpressInstallation.findByPk(
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
    return { installation };
  }
  return {};
}

function assertWordpressRevisionCompatibility(publication, installation, revision) {
  if (plain(publication)?.channel !== 'wordpress' || !documentHasGlobalIntakeForm(plain(revision)?.document)) {
    return true;
  }
  const actualVersion = String(plain(installation)?.pluginVersion || '').trim() || null;
  if (semverAtLeast(actualVersion, MIN_GLOBAL_INTAKE_PLUGIN_VERSION)) return true;
  throw new WebPublicationServiceError(
    'web_wordpress_global_intake_plugin_outdated',
    'Actualiza el plugin de WordPress antes de publicar un formulario global.',
    409,
    {
      actual_plugin_version: actualVersion,
      required_plugin_version: MIN_GLOBAL_INTAKE_PLUGIN_VERSION,
    }
  );
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
  assertPublishing = assertWebPublishingChannelEnabled,
  env = process.env,
  enqueueJob = jobRequestsService.enqueueJobRequest,
} = {}) {
  return sequelize.transaction(async (transaction) => {
    const pointer = await models.WebPublication.findByPk(String(publicationId || ''), {
      attributes: ['id', 'projectId', 'channel', 'wordpressInstallationId'], transaction,
    });
    if (!pointer) throw new WebPublicationServiceError('web_publication_not_found', 'La publicación no existe.', 404);
    const project = await models.WebProject.findByPk(pointer.projectId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!project) throw new WebPublicationServiceError('web_publication_not_found', 'La publicación no existe.', 404);
    await assertAccess(actorId, project, 'marketing.web.publish', { models, transaction });
    const scope = scopeFromProject(plain(project));
    let lockedWordpressInstallation = null;
    let wordpressPublications = null;
    if (pointer.channel === 'wordpress') {
      lockedWordpressInstallation = await models.WebWordpressInstallation.findByPk(
        pointer.wordpressInstallationId,
        { transaction, lock: transaction.LOCK.UPDATE }
      );
      wordpressPublications = await models.WebPublication.findAll({
        where: { wordpressInstallationId: pointer.wordpressInstallationId },
        order: [['path', 'ASC'], ['id', 'ASC']],
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
    }
    const publication = wordpressPublications
      ? wordpressPublications.find((row) => String(row.id) === String(pointer.id))
      : await models.WebPublication.findByPk(pointer.id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!publication || publication.projectId !== project.id) {
      throw new WebPublicationServiceError('web_publication_not_found', 'La publicación no existe.', 404);
    }
    if (publication.status === 'retired') {
      throw new WebPublicationServiceError(
        'web_publication_retired',
        'Una publicación retirada conserva su ruta como tombstone y no se puede volver a publicar.',
        409
      );
    }
    assertPublishing(scope, publication.channel, env);
    if (BUSY_PUBLICATION_STATUSES.has(publication.status)) {
      throw new WebPublicationServiceError(
        'web_publication_busy',
        'Ya hay una actualización de esta publicación en curso.',
        409,
        { job_request_id: publication.jobRequestId || null }
      );
    }
    const channelState = await assertChannelReady(publication, {
      models,
      transaction,
      lockedWordpressInstallation,
    });

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
      assertWordpressRevisionCompatibility(publication, channelState.installation, revision);
    } else if (action === 'rollback') {
      artifact = await models.WebArtifact.findByPk(String(artifactId || ''), { transaction });
      if (!artifact || artifact.projectId !== project.id || artifact.environment !== 'production') {
        throw new WebPublicationServiceError('web_artifact_not_found', 'El artefacto no existe.', 404);
      }
      if (publication.channel === 'wordpress') {
        assertWordpressPilotManifestCompatible(publication, wordpressPublications, plain(artifact).manifest);
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
  assertWordpressPilotManifestCompatible,
  assertWordpressRevisionCompatibility,
  campaignContextSnapshot,
  createPublication,
  enqueueDeployment,
  getPublicationForActor,
  hostedTarget,
  listDeployments,
  listProjectPublications,
  normalizeSiteUrl,
  publicationBaseUrl,
  publicationPathsOverlap,
  retireWordpressPublication,
  scopeMatches,
  serializeDeployment,
  serializePublication,
};
