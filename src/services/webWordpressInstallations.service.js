'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const { canonicalSerialize } = require('../lib/webDocument');
const {
  assertArtifactBundle,
  authenticatedDbStorageDescriptor,
  decodePathToken,
} = require('./webArtifactStorage.service');
const { issueBootstrapTicket } = require('../lib/webWordpressBootstrapTicket');
const {
  publicVerificationKeyDescriptor,
  signWebArtifactManifest,
} = require('../lib/webArtifactSignature');
const { assertWebPublishingEnabled } = require('../lib/marketingWebFeatureFlags');
const {
  assertScopeAccess,
  normalizeScope,
  positiveInteger,
  scopeColumns,
} = require('./webProjects.service');
const {
  WebPublicationServiceError,
  normalizeSiteUrl,
} = require('./webPublications.service');

const INSTALLATION_TOKEN_PREFIX = 'ccw_';
const REPORT_EVENTS = new Set(['sync_result', 'sync_failed', 'heartbeat', 'local_rollback']);
const REPORT_STATUSES = new Set(['empty', 'active', 'retired']);
const MAX_REPORT_BYTES = 32 * 1024;

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function secureEqual(left, right) {
  const a = Buffer.from(String(left || ''), 'utf8');
  const b = Buffer.from(String(right || ''), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function canCanonicalizePendingSite(installation) {
  const value = plain(installation);
  return value?.status === 'pending' && !value.pluginVersion && !value.lastSeenAt;
}

function wordpressSiteCandidates(siteUrl, { includeWwwAlias = false } = {}) {
  const canonical = normalizeSiteUrl(siteUrl).url;
  const candidates = [canonical];
  if (!includeWwwAlias) return candidates;
  const host = new URL(canonical).hostname;
  const aliasHost = host.startsWith('www.') ? host.slice(4) : `www.${host}`;
  if (aliasHost && aliasHost !== host) {
    candidates.push(normalizeSiteUrl(`https://${aliasHost}`).url);
  }
  return candidates;
}

function matchReportedSite(siteUrl, reportHash, { includeWwwAlias = false } = {}) {
  const canonical = normalizeSiteUrl(siteUrl).url;
  for (const candidate of wordpressSiteCandidates(canonical, { includeWwwAlias })) {
    const hashes = [sha256(candidate), sha256(`${candidate}/`)];
    if (hashes.some((expected) => secureEqual(expected, reportHash))) {
      return { site_url: candidate, canonicalized: candidate !== canonical };
    }
  }
  return null;
}

function scopeFromInstallation(row) {
  const value = plain(row);
  return value.scopeType === 'clinic'
    ? { type: 'clinic', id: Number(value.clinicaId) }
    : { type: 'group', id: Number(value.grupoClinicaId) };
}

function scopeWhere(scope) {
  return scope.type === 'clinic'
    ? { scopeType: 'clinic', clinicaId: scope.id }
    : { scopeType: 'group', grupoClinicaId: scope.id };
}

function issueInstallationToken() {
  return `${INSTALLATION_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

function installationApiBase(env = process.env) {
  try {
    const url = new URL(String(env.MARKETING_WEB_API_BASE_URL || 'https://crm.clinicaclick.com').trim());
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
      || url.pathname.replace(/\/+$/, '')
    ) throw new Error('unsafe');
    return `https://${url.hostname.toLowerCase()}`;
  } catch {
    throw new WebPublicationServiceError(
      'web_installation_api_base_invalid',
      'La URL pública del control plane de WordPress no está configurada correctamente.',
      503
    );
  }
}

function tokenHash(token) {
  return sha256(token);
}

function pluginKeyDescriptor(options = {}) {
  const descriptor = publicVerificationKeyDescriptor(options);
  const key = crypto.createPublicKey(descriptor.public_key_pem);
  const der = key.export({ type: 'spki', format: 'der' });
  const prefix = Buffer.from('302a300506032b6570032100', 'hex');
  if (der.length !== prefix.length + 32 || !der.subarray(0, prefix.length).equals(prefix)) {
    throw new WebPublicationServiceError(
      'web_artifact_verification_key_invalid',
      'La clave pública de publicación no tiene un formato Ed25519 compatible.',
      503
    );
  }
  return {
    schema_version: 1,
    algorithm: descriptor.algorithm,
    key_id: descriptor.key_id,
    public_key_base64: der.subarray(prefix.length).toString('base64'),
  };
}

function serializeInstallation(row) {
  const value = plain(row);
  return {
    id: value.id,
    scope: {
      type: value.scopeType,
      id: Number(value.scopeType === 'clinic' ? value.clinicaId : value.grupoClinicaId),
    },
    site_url: value.siteUrl,
    token_prefix: value.tokenPrefix,
    status: value.status,
    plugin_version: value.pluginVersion || null,
    capabilities: value.capabilities || {},
    reported_state: value.reportedState || {},
    public_key_id: value.publicKeyId,
    last_seen_at: value.lastSeenAt || null,
    last_artifact_hash: value.lastArtifactHash || null,
    desired_sequence: Number(value.desiredSequence || 0),
    version: Number(value.version),
    revoked_at: value.revokedAt || null,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

async function createInstallation({
  actorId,
  body = {},
  requestId = null,
  models = db,
  sequelize = db.sequelize,
  assertAccess = assertScopeAccess,
  assertPublishing = assertWebPublishingEnabled,
  signingOptions = {},
  env = process.env,
} = {}) {
  const scope = normalizeScope(body);
  await assertAccess(actorId, scope, 'marketing.web.domains.manage', { models });
  assertPublishing(scope);
  const site = normalizeSiteUrl(body.site_url);
  const token = issueInstallationToken();
  const installationId = crypto.randomUUID();
  const pluginPackage = issueBootstrapTicket({
    installationId,
    actorId: positiveInteger(actorId),
    token,
    env,
  });
  const descriptor = pluginKeyDescriptor(signingOptions);
  try {
    const installation = await sequelize.transaction(async (transaction) => {
      const row = await models.WebWordpressInstallation.create({
        id: installationId,
        ...scopeColumns(scope),
        siteUrl: site.url,
        siteUrlHash: sha256(site.url),
        tokenHash: tokenHash(token),
        tokenPrefix: token.slice(0, 12),
        status: 'pending',
        pluginVersion: null,
        capabilities: {},
        reportedState: {},
        publicKeyId: descriptor.key_id,
        lastSeenAt: null,
        lastArtifactHash: null,
        desiredSequence: 0,
        desiredStateHash: null,
        version: 1,
        createdByUserId: positiveInteger(actorId),
        updatedByUserId: positiveInteger(actorId),
      }, { transaction });
      await models.WebAuditEvent.create({
        projectId: null,
        ...scopeColumns(scope),
        actorUserId: positiveInteger(actorId),
        eventType: 'web.wordpress_installation.created',
        entityType: 'web_wordpress_installation',
        entityId: row.id,
        requestId,
        metadata: { site_url_hash: row.siteUrlHash, public_key_id: row.publicKeyId },
      }, { transaction });
      return row;
    });
    return {
      installation: serializeInstallation(installation),
      plugin_package: {
        download_ticket: pluginPackage.ticket,
        expires_at: pluginPackage.expires_at,
      },
    };
  } catch (error) {
    if (error?.name === 'SequelizeUniqueConstraintError') {
      throw new WebPublicationServiceError(
        'web_wordpress_site_already_registered',
        'Ese WordPress ya está conectado a ClinicaClick.',
        409
      );
    }
    throw error;
  }
}

async function listInstallations({ actorId, query = {}, models = db, assertAccess = assertScopeAccess } = {}) {
  const scope = normalizeScope(query);
  await assertAccess(actorId, scope, 'marketing.web.view', { models });
  const rows = await models.WebWordpressInstallation.findAll({
    where: {
      ...scopeWhere(scope),
      ...(query.include_revoked === 'true' ? {} : { status: { [Op.ne]: 'revoked' } }),
    },
    order: [['created_at', 'DESC'], ['id', 'ASC']],
    limit: 100,
  });
  return rows.map(serializeInstallation);
}

async function getInstallationForActor({
  actorId,
  installationId,
  feature = 'marketing.web.domains.manage',
  models = db,
  assertAccess = assertScopeAccess,
} = {}) {
  const installation = await models.WebWordpressInstallation.findByPk(String(installationId || ''));
  if (!installation) {
    throw new WebPublicationServiceError('web_wordpress_installation_not_found', 'La instalación no existe.', 404);
  }
  const scope = scopeFromInstallation(installation);
  try {
    await assertAccess(actorId, scope, feature, { models });
  } catch (error) {
    if (Number(error?.status) === 403) {
      throw new WebPublicationServiceError('web_wordpress_installation_not_found', 'La instalación no existe.', 404);
    }
    throw error;
  }
  return { installation, scope };
}

async function rotateInstallationToken({
  actorId,
  installationId,
  requestId = null,
  models = db,
  sequelize = db.sequelize,
  assertAccess = assertScopeAccess,
  env = process.env,
} = {}) {
  const { installation, scope } = await getInstallationForActor({ actorId, installationId, models, assertAccess });
  const token = issueInstallationToken();
  const pluginPackage = issueBootstrapTicket({
    installationId: installation.id,
    actorId: positiveInteger(actorId),
    token,
    env,
  });
  const updated = await sequelize.transaction(async (transaction) => {
    const locked = await models.WebWordpressInstallation.findByPk(installation.id, {
      transaction, lock: transaction.LOCK.UPDATE,
    });
    if (!locked || locked.status === 'revoked') {
      throw new WebPublicationServiceError('web_wordpress_installation_not_found', 'La instalación no existe.', 404);
    }
    await locked.update({
      tokenHash: tokenHash(token),
      tokenPrefix: token.slice(0, 12),
      status: 'pending',
      version: Number(locked.version) + 1,
      updatedByUserId: positiveInteger(actorId),
    }, { transaction });
    await models.WebAuditEvent.create({
      projectId: null,
      ...scopeColumns(scope),
      actorUserId: positiveInteger(actorId),
      eventType: 'web.wordpress_installation.token_rotated',
      entityType: 'web_wordpress_installation',
      entityId: locked.id,
      requestId,
      metadata: { token_prefix: locked.tokenPrefix },
    }, { transaction });
    return locked;
  });
  return {
    installation: serializeInstallation(updated),
    plugin_package: {
      download_ticket: pluginPackage.ticket,
      expires_at: pluginPackage.expires_at,
    },
  };
}

async function revokeInstallation({
  actorId,
  installationId,
  requestId = null,
  models = db,
  sequelize = db.sequelize,
  assertAccess = assertScopeAccess,
} = {}) {
  const { installation, scope } = await getInstallationForActor({ actorId, installationId, models, assertAccess });
  const updated = await sequelize.transaction(async (transaction) => {
    const locked = await models.WebWordpressInstallation.findByPk(installation.id, {
      transaction, lock: transaction.LOCK.UPDATE,
    });
    if (!locked) throw new WebPublicationServiceError('web_wordpress_installation_not_found', 'La instalación no existe.', 404);
    if (locked.status !== 'revoked') {
      await locked.update({
        status: 'revoked',
        tokenHash: sha256(`revoked:${crypto.randomUUID()}`),
        revokedAt: new Date(),
        version: Number(locked.version) + 1,
        updatedByUserId: positiveInteger(actorId),
      }, { transaction });
      await models.WebAuditEvent.create({
        projectId: null,
        ...scopeColumns(scope),
        actorUserId: positiveInteger(actorId),
        eventType: 'web.wordpress_installation.revoked',
        entityType: 'web_wordpress_installation',
        entityId: locked.id,
        requestId,
        metadata: {},
      }, { transaction });
    }
    return locked;
  });
  return serializeInstallation(updated);
}

function bearerToken(headers = {}) {
  const value = String(headers.authorization || headers.Authorization || '').trim();
  const match = value.match(/^Bearer ([A-Za-z0-9_-]{24,512})$/);
  return match ? match[1] : null;
}

async function authenticateInstallation({
  installationId,
  headers = {},
  models = db,
} = {}) {
  const pluginVersion = String(headers.pluginVersion || headers['x-clinicaclick-plugin-version'] || '').trim();
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(pluginVersion)) {
    throw new WebPublicationServiceError(
      'web_installation_plugin_version_required',
      'WordPress debe identificar una versión de plugin válida.',
      400
    );
  }
  if (!pluginVersion.startsWith('2.')) {
    throw new WebPublicationServiceError(
      'web_installation_plugin_version_unsupported',
      'Esta versión del plugin debe actualizarse antes de sincronizar.',
      409
    );
  }
  const token = bearerToken(headers);
  if (!token) throw new WebPublicationServiceError('web_installation_unauthorized', 'Credenciales no válidas.', 401);
  const digest = tokenHash(token);
  const installation = await models.WebWordpressInstallation.findOne({ where: { tokenHash: digest } });
  const storedHash = installation?.tokenHash || sha256('clinicaclick-dummy-installation-token');
  if (
    !installation
    || !secureEqual(digest, storedHash)
    || !secureEqual(String(installation.id), String(installationId || ''))
    || installation.status === 'revoked'
  ) {
    throw new WebPublicationServiceError('web_installation_unauthorized', 'Credenciales no válidas.', 401);
  }
  return installation;
}

async function intakeConfigForInstallation(installation, { models = db } = {}) {
  const scope = scopeFromInstallation(installation);
  if (scope.type === 'group') {
    return models.IntakeConfig.findOne({
      where: { assignment_scope: 'group', group_id: scope.id },
      raw: true,
    });
  }
  const direct = await models.IntakeConfig.findOne({
    where: { assignment_scope: 'clinic', clinic_id: scope.id },
    raw: true,
  });
  if (direct) return direct;
  const clinic = await models.Clinica.findByPk(scope.id, { attributes: ['grupoClinicaId'], raw: true });
  const groupId = positiveInteger(clinic?.grupoClinicaId);
  if (!groupId) return null;
  const inherited = await models.IntakeConfig.findOne({
    where: { assignment_scope: 'group', group_id: groupId },
    raw: true,
  });
  const locations = Array.isArray(inherited?.config?.locations) ? inherited.config.locations : [];
  const includesClinic = locations.some((location) => (
    positiveInteger(location?.id ?? location?.clinic_id) === scope.id
  ));
  return includesClinic ? inherited : null;
}

function measurementFromIntake(record) {
  const hmac = String(record?.hmac_key || '').trim();
  if (!record || hmac.length < 16 || hmac.length > 512 || /[\x00-\x20\x7f]/.test(hmac)) {
    return { enabled: false };
  }
  const assignmentScope = record.assignment_scope === 'group' ? 'group' : 'clinic';
  const scopeId = positiveInteger(assignmentScope === 'group' ? record.group_id : record.clinic_id);
  if (!scopeId) return { enabled: false };
  const features = record.config?.features && typeof record.config.features === 'object'
    ? record.config.features
    : {};
  const provider = ['clinicaclick', 'external_cmp'].includes(String(features.consent_provider || '').trim().toLowerCase())
    ? String(features.consent_provider).trim().toLowerCase()
    : 'external_cmp';
  return {
    enabled: true,
    scope_type: assignmentScope,
    scope_id: scopeId,
    loader_path: '/assets/loader.js',
    hmac_key: hmac,
    consent_mode_enabled: features.consent_mode_enabled === true,
    consent_provider: provider,
    chat_enabled: features.chat_enabled === true,
    whatsapp_enabled: typeof features.whatsapp_enabled === 'boolean'
      ? features.whatsapp_enabled
      : features.chat_enabled === true,
    phone_enabled: features.tel_modal_enabled === true,
  };
}

function safeImmutableStorage(storage, artifact, { installationId = null, env = process.env } = {}) {
  const value = storage && typeof storage === 'object' && !Array.isArray(storage) ? storage : {};
  const manifest = artifact?.manifest || {};
  const artifactHash = String(artifact?.artifactHash || manifest.artifact_hash || '');
  const supportedProvider = value.provider === 's3_immutable' || value.provider === 'authenticated_db';
  if (
    !supportedProvider
    || value.artifact_hash !== artifactHash
    || !/^[a-f0-9]{64}$/.test(artifactHash)
    || !value.files
    || typeof value.files !== 'object'
    || Array.isArray(value.files)
  ) {
    throw new WebPublicationServiceError(
      'web_installation_artifact_not_ready',
      'La publicación todavía no tiene un artefacto descargable.',
      409
    );
  }
  if (value.provider === 'authenticated_db') {
    const expected = authenticatedDbStorageDescriptor({ artifact, installationId, env });
    const actualContract = {
      provider: value.provider,
      installation_id: value.installation_id,
      artifact_hash: value.artifact_hash,
      manifest_url: value.manifest_url,
      signature_url: value.signature_url,
      files: value.files,
    };
    const expectedContract = {
      provider: expected.provider,
      installation_id: expected.installation_id,
      artifact_hash: expected.artifact_hash,
      manifest_url: expected.manifest_url,
      signature_url: expected.signature_url,
      files: expected.files,
    };
    if (canonicalSerialize(actualContract) !== canonicalSerialize(expectedContract)) {
      throw new WebPublicationServiceError(
        'web_installation_artifact_storage_mismatch',
        'El descriptor autenticado no corresponde a esta instalación.',
        503
      );
    }
  }
  const urls = [value.manifest_url, value.signature_url, ...Object.values(value.files)];
  let origin = null;
  for (const input of urls) {
    let url;
    try {
      url = new URL(String(input || ''));
      if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('unsafe');
    } catch {
      throw new WebPublicationServiceError('web_installation_artifact_url_invalid', 'El artefacto no tiene URLs seguras.', 503);
    }
    const currentOrigin = url.origin.toLowerCase();
    if (origin && origin !== currentOrigin) {
      throw new WebPublicationServiceError('web_installation_artifact_origin_mismatch', 'El artefacto no comparte un origen único.', 503);
    }
    origin = currentOrigin;
  }
  const expectedPaths = Object.keys(manifest.files || {}).sort();
  const actualPaths = Object.keys(value.files).sort();
  if (canonicalSerialize(expectedPaths) !== canonicalSerialize(actualPaths)) {
    throw new WebPublicationServiceError('web_installation_artifact_files_mismatch', 'El artefacto no tiene un conjunto íntegro de ficheros.', 503);
  }
  return {
    storage_provider: value.provider,
    artifact_hash: artifactHash,
    manifest_url: value.manifest_url,
    envelope_url: value.signature_url,
    files: Object.fromEntries(actualPaths.map((path) => [path, value.files[path]])),
  };
}

async function publicationDesiredState(installation, { models = db, env = process.env } = {}) {
  const publications = await models.WebPublication.findAll({
    where: { wordpressInstallationId: installation.id },
    order: [['created_at', 'DESC']],
    limit: 2,
  });
  if (publications.length === 0) {
    throw new WebPublicationServiceError(
      'web_installation_publication_not_configured',
      'La instalación todavía no tiene una publicación configurada.',
      409
    );
  }
  if (publications.length > 1) {
    throw new WebPublicationServiceError(
      'web_installation_publication_ambiguous',
      'La instalación tiene más de una publicación y requiere revisión.',
      409
    );
  }
  const publication = publications[0];
  if (publication.status === 'retired') return { status: 'retired', publication };

  // WordPress promotes an immutable release before the control plane can run
  // the public healthcheck. If that first publication fails terminally there
  // is no backend LKG to select, so returning 409 would leave the unverified
  // release live indefinitely. A signed retired state removes it from the
  // public route while preserving the cached release for diagnosis/recovery.
  if (
    publication.status === 'failed'
    && !publication.activeArtifactId
    && !publication.lastGoodArtifactId
  ) {
    return { status: 'retired', publication, failedFirstPublication: true };
  }

  let deployment = null;
  if (['pending', 'publishing', 'rolling_back'].includes(publication.status)) {
    deployment = await models.WebPublicationDeployment.findOne({
      where: {
        publicationId: publication.id,
        status: { [Op.in]: ['queued', 'running'] },
        artifactId: { [Op.ne]: null },
      },
      order: [['sequence', 'DESC']],
    });
  }
  const recoveryArtifactId = publication.activeArtifactId || publication.lastGoodArtifactId;
  if (!deployment && recoveryArtifactId) {
    deployment = await models.WebPublicationDeployment.findOne({
      where: {
        publicationId: publication.id,
        artifactId: recoveryArtifactId,
        status: 'verified',
      },
      order: [['sequence', 'DESC']],
    });
  }
  if (!deployment?.artifactId) {
    throw new WebPublicationServiceError(
      'web_installation_artifact_not_ready',
      'La publicación todavía no tiene un artefacto listo para WordPress.',
      409
    );
  }
  const artifact = await models.WebArtifact.findByPk(deployment.artifactId);
  if (!artifact || artifact.projectId !== publication.projectId || artifact.environment !== 'production') {
    throw new WebPublicationServiceError('web_installation_artifact_not_ready', 'El artefacto no está disponible.', 409);
  }
  const bundle = safeImmutableStorage(deployment.storage, artifact, {
    installationId: installation.id,
    env,
  });
  return { status: 'published', publication, deployment, artifact, bundle };
}

async function sequenceForDesiredState({ installation, fingerprint, models = db, sequelize = db.sequelize } = {}) {
  return sequelize.transaction(async (transaction) => {
    const locked = await models.WebWordpressInstallation.findByPk(installation.id, {
      transaction, lock: transaction.LOCK.UPDATE,
    });
    if (!locked || locked.status === 'revoked') {
      throw new WebPublicationServiceError('web_installation_unauthorized', 'Credenciales no válidas.', 401);
    }
    if (!secureEqual(locked.desiredStateHash || '', fingerprint)) {
      const next = Number(locked.desiredSequence || 0) + 1;
      await locked.update({ desiredSequence: next, desiredStateHash: fingerprint }, { transaction });
      return next;
    }
    return Math.max(1, Number(locked.desiredSequence || 0));
  });
}

async function getDesiredState({
  installationId,
  headers = {},
  requestId,
  models = db,
  sequelize = db.sequelize,
  signingOptions = {},
  env = process.env,
} = {}) {
  const installation = await authenticateInstallation({ installationId, headers, models });
  const [publicationState, intake] = await Promise.all([
    publicationDesiredState(installation, { models, env }),
    intakeConfigForInstallation(installation, { models }),
  ]);
  const descriptor = pluginKeyDescriptor(signingOptions);
  if (installation.publicKeyId !== descriptor.key_id) {
    throw new WebPublicationServiceError(
      'web_installation_signing_key_rotation_required',
      'La instalación necesita completar la rotación de la clave de publicación.',
      409
    );
  }
  const measurement = measurementFromIntake(intake);
  const runtimeWithoutSequence = {
    schema_version: 1,
    installation_id: installation.id,
    status: publicationState.status === 'published' ? 'active' : 'retired',
    route_prefix: '/cita',
    desired_artifact_hash: publicationState.status === 'published'
      ? publicationState.bundle.artifact_hash
      : null,
    measurement,
  };
  const fingerprint = sha256(canonicalSerialize({
    publication_status: publicationState.status,
    ...(publicationState.status === 'published' ? publicationState.bundle : {}),
    runtime: runtimeWithoutSequence,
    key_id: descriptor.key_id,
  }));
  const sequence = await sequenceForDesiredState({ installation, fingerprint, models, sequelize });
  const runtime = {
    schema_version: runtimeWithoutSequence.schema_version,
    installation_id: runtimeWithoutSequence.installation_id,
    sequence,
    status: runtimeWithoutSequence.status,
    route_prefix: runtimeWithoutSequence.route_prefix,
    desired_artifact_hash: runtimeWithoutSequence.desired_artifact_hash,
    measurement: runtimeWithoutSequence.measurement,
  };
  const desiredState = {
    status: publicationState.status,
    ...(publicationState.status === 'published' ? publicationState.bundle : {}),
    signing_key_descriptor: descriptor,
    signing_key_descriptor_envelope: {},
    runtime_configuration: runtime,
    runtime_configuration_envelope: signWebArtifactManifest(runtime, signingOptions),
  };
  const response = {
    schema_version: 1,
    request_id: requestId,
    installation_id: installation.id,
    desired_state: desiredState,
  };
  return {
    response,
    // request_id sirve para trazabilidad de cada llamada y no forma parte de
    // la versión deseada; así If-None-Match puede producir un 304 real.
    etag: `"${sha256(canonicalSerialize({ installation_id: installation.id, desired_state: desiredState }))}"`,
  };
}

async function getAuthenticatedArtifactResource({
  installationId,
  artifactHash,
  resource,
  pathToken = null,
  headers = {},
  models = db,
  signingOptions = {},
  env = process.env,
} = {}) {
  const installation = await authenticateInstallation({ installationId, headers, models });
  const state = await publicationDesiredState(installation, { models, env });
  const requestedHash = String(artifactHash || '').trim().toLowerCase();
  if (
    state.status !== 'published'
    || state.deployment?.storage?.provider !== 'authenticated_db'
    || !/^[a-f0-9]{64}$/.test(requestedHash)
    || !secureEqual(requestedHash, state.bundle.artifact_hash)
  ) {
    throw new WebPublicationServiceError(
      'web_installation_artifact_not_found',
      'El artefacto solicitado no es el deseado de esta instalación.',
      404
    );
  }
  const artifact = plain(state.artifact);
  const normalized = assertArtifactBundle({
    artifact_hash: artifact.artifactHash,
    manifest: artifact.manifest,
    files: artifact.files,
  });
  if (resource === 'manifest') {
    const body = Buffer.from(canonicalSerialize(normalized.manifest), 'utf8');
    return {
      body,
      content_type: 'application/json; charset=utf-8',
      sha256: sha256(body),
      artifact_hash: requestedHash,
    };
  }
  if (resource === 'envelope') {
    const body = Buffer.from(canonicalSerialize(signWebArtifactManifest(normalized.manifest, signingOptions)), 'utf8');
    return {
      body,
      content_type: 'application/json; charset=utf-8',
      sha256: sha256(body),
      artifact_hash: requestedHash,
    };
  }
  if (resource !== 'file') {
    throw new WebPublicationServiceError('web_installation_artifact_not_found', 'El recurso no existe.', 404);
  }
  const path = decodePathToken(pathToken);
  const file = normalized.files[path];
  if (!file) {
    throw new WebPublicationServiceError('web_installation_artifact_not_found', 'El fichero no existe.', 404);
  }
  return {
    body: file.body,
    content_type: file.contentType,
    sha256: file.sha256,
    artifact_hash: requestedHash,
    file_path: path,
  };
}

const REPORT_FIELDS = new Set([
  'schema_version', 'event', 'request_id', 'plugin_version', 'wordpress_version', 'php_version',
  'site_hash', 'status', 'active_artifact_hash', 'desired_artifact_hash', 'result', 'error_code',
  'duration_ms', 'reported_at',
]);

function safeShortString(value, { required = false, maximum = 128, pattern = null } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw new WebPublicationServiceError('web_installation_report_invalid', 'El reporte no es válido.', 422);
    return null;
  }
  const normalized = String(value).trim();
  if (!normalized || normalized.length > maximum || (pattern && !pattern.test(normalized))) {
    throw new WebPublicationServiceError('web_installation_report_invalid', 'El reporte no es válido.', 422);
  }
  return normalized;
}

function optionalHash(value) {
  return value === undefined || value === null || value === ''
    ? null
    : safeShortString(value, { maximum: 64, pattern: /^[a-f0-9]{64}$/ });
}

function normalizeReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new WebPublicationServiceError('web_installation_report_invalid', 'El reporte no es válido.', 422);
  }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_REPORT_BYTES) {
    throw new WebPublicationServiceError('web_installation_report_too_large', 'El reporte supera el tamaño permitido.', 413);
  }
  const unknown = Object.keys(body).filter((field) => !REPORT_FIELDS.has(field));
  if (unknown.length || Number(body.schema_version) !== 1 || !REPORT_EVENTS.has(String(body.event || ''))) {
    throw new WebPublicationServiceError(
      'web_installation_report_invalid',
      'El reporte no cumple el contrato permitido.',
      422,
      { unknown_fields: unknown }
    );
  }
  const serialized = JSON.stringify(body);
  if (/(?:token|secret|hmac|authorization|patient|paciente|email|phone|telefono|local_path|body)/i.test(serialized)) {
    throw new WebPublicationServiceError(
      'web_installation_report_sensitive_data_forbidden',
      'El reporte contiene datos que no deben salir de WordPress.',
      422
    );
  }
  const status = body.status === undefined || body.status === null
    ? null
    : safeShortString(body.status, { maximum: 16 });
  if (status && !REPORT_STATUSES.has(status)) {
    throw new WebPublicationServiceError('web_installation_report_invalid', 'El estado reportado no es válido.', 422);
  }
  const duration = body.duration_ms === undefined || body.duration_ms === null
    ? null
    : Number(body.duration_ms);
  if (duration !== null && (!Number.isSafeInteger(duration) || duration < 0 || duration > 24 * 60 * 60 * 1000)) {
    throw new WebPublicationServiceError('web_installation_report_invalid', 'La duración reportada no es válida.', 422);
  }
  const reportedAt = safeShortString(body.reported_at, { required: true, maximum: 64 });
  const reportedTime = new Date(reportedAt);
  if (!Number.isFinite(reportedTime.getTime()) || Math.abs(Date.now() - reportedTime.getTime()) > 48 * 60 * 60 * 1000) {
    throw new WebPublicationServiceError('web_installation_report_invalid', 'La fecha del reporte no es válida.', 422);
  }
  return {
    event: String(body.event),
    request_id: safeShortString(body.request_id, { maximum: 128, pattern: /^[A-Za-z0-9._:-]+$/ }),
    plugin_version: safeShortString(body.plugin_version, { required: true, maximum: 32, pattern: /^[0-9A-Za-z.+-]+$/ }),
    wordpress_version: safeShortString(body.wordpress_version, { maximum: 32, pattern: /^[0-9A-Za-z.+-]+$/ }),
    php_version: safeShortString(body.php_version, { maximum: 32, pattern: /^[0-9A-Za-z.+-]+$/ }),
    site_hash: safeShortString(body.site_hash, { required: true, maximum: 64, pattern: /^[a-f0-9]{64}$/ }),
    status,
    active_artifact_hash: optionalHash(body.active_artifact_hash),
    desired_artifact_hash: optionalHash(body.desired_artifact_hash),
    result: safeShortString(body.result, { maximum: 64, pattern: /^[a-z0-9_.:-]+$/i }),
    error_code: safeShortString(body.error_code, { maximum: 128, pattern: /^[a-z0-9_.:-]+$/i }),
    duration_ms: duration,
    reported_at: reportedAt,
  };
}

async function recordReport({
  installationId,
  headers = {},
  body = {},
  requestId,
  models = db,
  sequelize = db.sequelize,
  env = process.env,
} = {}) {
  const installation = await authenticateInstallation({ installationId, headers, models });
  const report = normalizeReport(body);
  if (!secureEqual(String(headers.pluginVersion || ''), report.plugin_version)) {
    throw new WebPublicationServiceError(
      'web_installation_plugin_version_mismatch',
      'La versión declarada por WordPress no coincide con la cabecera del plugin.',
      422
    );
  }
  const reportedSite = matchReportedSite(installation.siteUrl, report.site_hash, {
    includeWwwAlias: canCanonicalizePendingSite(installation),
  });
  if (!reportedSite) {
    throw new WebPublicationServiceError(
      'web_installation_site_mismatch',
      'El reporte procede de un WordPress distinto al registrado.',
      409
    );
  }
  const desired = await publicationDesiredState(installation, { models, env }).catch((error) => {
    if (error?.code === 'web_installation_publication_not_configured' || error?.code === 'web_installation_artifact_not_ready') {
      return null;
    }
    throw error;
  });
  const expectedDesiredHash = desired?.status === 'published' ? desired.bundle.artifact_hash : null;
  const confirmsPublished = report.event === 'sync_result'
    && report.status === 'active'
    && report.active_artifact_hash
    && expectedDesiredHash
    && secureEqual(report.active_artifact_hash, expectedDesiredHash)
    && (!report.desired_artifact_hash || secureEqual(report.desired_artifact_hash, expectedDesiredHash));
  const reportsRetired = report.event === 'sync_result'
    && report.status === 'retired'
    && !report.desired_artifact_hash;
  const confirmsRetired = reportsRetired && desired?.status === 'retired';
  const confirmsDesired = Boolean(confirmsPublished || confirmsRetired);
  const scope = scopeFromInstallation(installation);
  let updated;
  try {
    updated = await sequelize.transaction(async (transaction) => {
      const locked = await models.WebWordpressInstallation.findByPk(installation.id, {
        transaction, lock: transaction.LOCK.UPDATE,
      });
      if (!locked || locked.status === 'revoked') {
        throw new WebPublicationServiceError('web_installation_unauthorized', 'Credenciales no válidas.', 401);
      }
      const lockedSite = matchReportedSite(locked.siteUrl, report.site_hash, {
        includeWwwAlias: canCanonicalizePendingSite(locked),
      });
      if (!lockedSite) {
        throw new WebPublicationServiceError(
          'web_installation_site_mismatch',
          'El reporte procede de un WordPress distinto al registrado.',
          409
        );
      }
      const repairsSite = lockedSite.canonicalized;
      if (repairsSite) {
        const publications = await models.WebPublication.count({
          where: { wordpressInstallationId: locked.id },
          transaction,
        });
        if (publications > 0) {
          throw new WebPublicationServiceError(
            'web_installation_site_mismatch',
            'El reporte procede de un WordPress distinto al registrado.',
            409
          );
        }
      }
      const reportedState = {
        event: report.event,
        request_id: report.request_id,
        status: report.status,
        active_artifact_hash: report.active_artifact_hash,
        desired_artifact_hash: report.desired_artifact_hash,
        result: report.result,
        error_code: report.error_code,
        duration_ms: report.duration_ms,
        reported_at: report.reported_at,
        wordpress_version: report.wordpress_version,
        php_version: report.php_version,
      };
      const previousSiteHash = locked.siteUrlHash;
      await locked.update({
        ...(repairsSite ? {
          siteUrl: lockedSite.site_url,
          siteUrlHash: sha256(lockedSite.site_url),
          version: Number(locked.version) + 1,
        } : {}),
        status: locked.status === 'outdated' && !confirmsDesired ? 'outdated' : 'connected',
        pluginVersion: report.plugin_version,
        reportedState,
        lastSeenAt: new Date(),
        ...(confirmsPublished
          ? { lastArtifactHash: report.active_artifact_hash }
          : reportsRetired
            ? { lastArtifactHash: null }
            : {}),
      }, { transaction });
      if (repairsSite) {
        await models.WebAuditEvent.create({
          projectId: null,
          ...scopeColumns(scope),
          actorUserId: null,
          eventType: 'web.wordpress_installation.site_canonicalized',
          entityType: 'web_wordpress_installation',
          entityId: locked.id,
          requestId: requestId || report.request_id,
          metadata: {
            previous_site_url_hash: previousSiteHash,
            site_url_hash: locked.siteUrlHash,
            reason: 'first_handshake_www_alias',
          },
        }, { transaction });
      }
      await models.WebAuditEvent.create({
        projectId: desired?.publication?.projectId || null,
        ...scopeColumns(scope),
        actorUserId: null,
        eventType: `web.wordpress_installation.${report.event}`,
        entityType: 'web_wordpress_installation',
        entityId: locked.id,
        requestId: requestId || report.request_id,
        metadata: {
          status: report.status,
          result: report.result,
          error_code: report.error_code,
          confirms_desired: Boolean(confirmsDesired),
          plugin_version: report.plugin_version,
        },
      }, { transaction });
      return locked;
    });
  } catch (error) {
    if (error?.name === 'SequelizeUniqueConstraintError') {
      throw new WebPublicationServiceError(
        'web_wordpress_site_already_registered',
        'Ese WordPress ya está conectado a ClinicaClick.',
        409
      );
    }
    throw error;
  }
  return { accepted: true, confirms_desired: Boolean(confirmsDesired), installation: serializeInstallation(updated) };
}

module.exports = {
  INSTALLATION_TOKEN_PREFIX,
  MAX_REPORT_BYTES,
  REPORT_EVENTS,
  authenticateInstallation,
  bearerToken,
  createInstallation,
  getDesiredState,
  getAuthenticatedArtifactResource,
  getInstallationForActor,
  intakeConfigForInstallation,
  issueInstallationToken,
  installationApiBase,
  listInstallations,
  measurementFromIntake,
  matchReportedSite,
  normalizeReport,
  pluginKeyDescriptor,
  publicationDesiredState,
  recordReport,
  revokeInstallation,
  rotateInstallationToken,
  safeImmutableStorage,
  serializeInstallation,
  tokenHash,
};
