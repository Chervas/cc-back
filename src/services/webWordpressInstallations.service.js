'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const { canonicalSerialize } = require('../lib/webDocument');
const {
  assertArtifactBundle,
  authenticatedDbStorageDescriptor,
  decodePathToken,
  pathToken,
} = require('./webArtifactStorage.service');
const { issueBootstrapTicket } = require('../lib/webWordpressBootstrapTicket');
const {
  loadPrivateKey,
  publicVerificationKeyDescriptor,
  signWebArtifactManifest,
} = require('../lib/webArtifactSignature');
const { assertWebPublishingChannelEnabled } = require('../lib/marketingWebFeatureFlags');
const {
  assertScopeAccess,
  normalizeScope,
  positiveInteger,
  scopeColumns,
} = require('./webProjects.service');
const {
  MAX_WORDPRESS_PUBLICATIONS,
  MAX_WORDPRESS_PUBLICATION_HISTORY,
  WebPublicationServiceError,
  normalizeSiteUrl,
} = require('./webPublications.service');
const {
  MIN_MULTI_PUBLICATION_PLUGIN_VERSION,
  isReleasedWordpressPublication,
  semverAtLeast,
  supportsMultiPublication,
} = require('../lib/webWordpressCompatibility');
const { parseRuntimeInheritance } = require('../lib/webRuntimeInheritance');
const {
  effectiveIntakeConfigForScope,
} = require('./webEffectiveIntakeConfig.service');
const {
  MAX_WEB_ARTIFACT_BUNDLE_BYTES,
  webArtifactBundleFootprintBytes,
} = require('../lib/webArtifactBudget');
const { verifyWordpressSiteClaim } = require('./webWordpressSiteClaim.service');
const {
  clinicMembership,
  filterAuthorizedWordpressPublications,
} = require('./webWordpressScope.service');

const INSTALLATION_TOKEN_PREFIX = 'ccw_';
const DEFAULT_SITE_CLAIM_TTL_SECONDS = 24 * 60 * 60;
const REPORT_EVENTS = new Set(['sync_result', 'sync_failed', 'heartbeat', 'local_rollback']);
const REPORT_STATUSES = new Set(['empty', 'active', 'retired']);
const MAX_REPORT_BYTES = 32 * 1024;
const MAX_WORDPRESS_V2_UNIQUE_FILES = 400;
const MAX_WORDPRESS_V2_DOWNLOAD_REQUESTS = 500;
const MAX_WORDPRESS_V2_CONTROL_BYTES = 768 * 1024;
// A signed registry may legitimately require 500 immutable artifact requests.
// Keep enough room for one complete bounded retry inside the same hour.
const WORDPRESS_V2_ARTIFACT_RATE_LIMIT = 1100;
const AUTHENTICATED_ARTIFACT_CACHE_TTL_MS = 2 * 60 * 1000;
const AUTHENTICATED_ARTIFACT_CACHE_MAX = 64;
const AUTHENTICATED_ARTIFACT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const AUTHENTICATED_ARTIFACT_CACHE_MAX_ENTRY_BYTES = MAX_WEB_ARTIFACT_BUNDLE_BYTES;
const AUTHENTICATED_ARTIFACT_MAX_CONCURRENT_LOADS = 4;
const ARTIFACT_AUTHORIZATION_ATTRIBUTES = Object.freeze([
  'id', 'projectId', 'environment', 'status', 'artifactHash', 'manifest',
]);
const ARTIFACT_BUNDLE_ATTRIBUTES = Object.freeze([
  ...ARTIFACT_AUTHORIZATION_ATTRIBUTES, 'files',
]);
const authenticatedArtifactCache = new Map();
const authenticatedArtifactLoads = new Map();
const authenticatedArtifactLoadWaiters = [];
let authenticatedArtifactCacheBytes = 0;
let authenticatedArtifactActiveLoads = 0;

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

function removeAuthenticatedArtifactCacheEntry(artifactHash) {
  const hash = String(artifactHash || '');
  const entry = authenticatedArtifactCache.get(hash);
  if (!entry) return false;
  authenticatedArtifactCache.delete(hash);
  authenticatedArtifactCacheBytes = Math.max(
    0,
    authenticatedArtifactCacheBytes - Number(entry.size_bytes || 0)
  );
  return true;
}

function pruneExpiredAuthenticatedArtifacts(now = Date.now()) {
  for (const [hash, entry] of authenticatedArtifactCache) {
    if (entry.expires_at <= now) removeAuthenticatedArtifactCacheEntry(hash);
  }
}

function cachedNormalizedBundle(artifact) {
  const value = plain(artifact);
  const hash = String(value?.artifactHash || '');
  const entry = authenticatedArtifactCache.get(hash);
  if (
    !entry
    || entry.expires_at <= Date.now()
    || String(entry.artifact_id || '') !== String(value?.id || '')
  ) {
    removeAuthenticatedArtifactCacheEntry(hash);
    return null;
  }
  // Refresh LRU order without extending the bounded TTL.
  authenticatedArtifactCache.delete(hash);
  authenticatedArtifactCache.set(hash, entry);
  return entry.normalized_bundle;
}

function normalizedBundleSizeBytes(normalized) {
  return webArtifactBundleFootprintBytes(normalized?.manifest);
}

function cacheNormalizedBundle(artifact, normalized) {
  const value = plain(artifact);
  const hash = String(value?.artifactHash || '');
  if (!/^[a-f0-9]{64}$/.test(hash) || !value?.id) return normalized;
  const sizeBytes = normalizedBundleSizeBytes(normalized);
  removeAuthenticatedArtifactCacheEntry(hash);
  pruneExpiredAuthenticatedArtifacts();
  if (
    sizeBytes === null
    || sizeBytes > AUTHENTICATED_ARTIFACT_CACHE_MAX_ENTRY_BYTES
    || sizeBytes > AUTHENTICATED_ARTIFACT_CACHE_MAX_BYTES
  ) return normalized;
  while (
    authenticatedArtifactCache.size >= AUTHENTICATED_ARTIFACT_CACHE_MAX
    || authenticatedArtifactCacheBytes + sizeBytes > AUTHENTICATED_ARTIFACT_CACHE_MAX_BYTES
  ) {
    const oldestHash = authenticatedArtifactCache.keys().next().value;
    if (!oldestHash) break;
    removeAuthenticatedArtifactCacheEntry(oldestHash);
  }
  authenticatedArtifactCache.set(hash, {
    artifact_id: String(value.id),
    normalized_bundle: normalized,
    size_bytes: sizeBytes,
    expires_at: Date.now() + AUTHENTICATED_ARTIFACT_CACHE_TTL_MS,
  });
  authenticatedArtifactCacheBytes += sizeBytes;
  return normalized;
}

function normalizedBundleForArtifact(artifact, validator = assertArtifactBundle) {
  const cached = cachedNormalizedBundle(artifact);
  if (cached) return cached;
  const value = plain(artifact);
  const normalized = validator({
    artifact_hash: String(value?.artifactHash || ''),
    manifest: value?.manifest,
    files: value?.files,
  });
  return cacheNormalizedBundle(value, normalized);
}

function clearAuthenticatedArtifactCache() {
  authenticatedArtifactCache.clear();
  authenticatedArtifactCacheBytes = 0;
}

async function acquireAuthenticatedArtifactLoadSlot() {
  if (authenticatedArtifactActiveLoads < AUTHENTICATED_ARTIFACT_MAX_CONCURRENT_LOADS) {
    authenticatedArtifactActiveLoads += 1;
    return;
  }
  await new Promise((resolve) => authenticatedArtifactLoadWaiters.push(resolve));
}

function releaseAuthenticatedArtifactLoadSlot() {
  const next = authenticatedArtifactLoadWaiters.shift();
  if (next) {
    next();
    return;
  }
  authenticatedArtifactActiveLoads = Math.max(0, authenticatedArtifactActiveLoads - 1);
}

async function loadNormalizedArtifactBundle({
  artifactMetadata,
  requestedHash,
  models,
  artifactBundleValidator,
} = {}) {
  const cached = cachedNormalizedBundle(artifactMetadata);
  if (cached) return cached;
  const loadKey = `${requestedHash}:${String(artifactMetadata?.id || '')}`;
  const existingLoad = authenticatedArtifactLoads.get(loadKey);
  if (existingLoad) return existingLoad;
  const load = (async () => {
    await acquireAuthenticatedArtifactLoadSlot();
    try {
      const afterWait = cachedNormalizedBundle(artifactMetadata);
      if (afterWait) return afterWait;
      const fullArtifact = plain(await models.WebArtifact.findByPk(artifactMetadata.id, {
        attributes: [...ARTIFACT_BUNDLE_ATTRIBUTES],
      }));
      if (
        !fullArtifact
        || String(fullArtifact.id || '') !== String(artifactMetadata.id || '')
        || String(fullArtifact.projectId || '') !== String(artifactMetadata.projectId || '')
        || fullArtifact.environment !== 'production'
        || fullArtifact.status !== 'ready'
        || !secureEqual(fullArtifact.artifactHash, requestedHash)
      ) {
        throw new WebPublicationServiceError(
          'web_installation_artifact_not_found',
          'El artefacto solicitado no es el deseado de esta instalación.',
          404
        );
      }
      return normalizedBundleForArtifact(fullArtifact, artifactBundleValidator);
    } finally {
      releaseAuthenticatedArtifactLoadSlot();
    }
  })();
  authenticatedArtifactLoads.set(loadKey, load);
  try {
    return await load;
  } finally {
    if (authenticatedArtifactLoads.get(loadKey) === load) {
      authenticatedArtifactLoads.delete(loadKey);
    }
  }
}

function assertV2TransportBudget({ routes = {}, artifacts = {}, response = null } = {}) {
  const uniqueFiles = Object.values(artifacts)
    .reduce((total, bundle) => total + Object.keys(bundle?.files || {}).length, 0);
  let downloadRequests = 0;
  for (const route of Object.values(routes)) {
    if (route?.status !== 'active') continue;
    const bundle = artifacts[route.desired_artifact_hash];
    downloadRequests += Object.keys(bundle?.files || {}).length + 2;
  }
  const responseBytes = response === null
    ? null
    : Buffer.byteLength(JSON.stringify(response), 'utf8');
  if (
    uniqueFiles > MAX_WORDPRESS_V2_UNIQUE_FILES
    || downloadRequests > MAX_WORDPRESS_V2_DOWNLOAD_REQUESTS
    || (responseBytes !== null && responseBytes > MAX_WORDPRESS_V2_CONTROL_BYTES)
  ) {
    throw new WebPublicationServiceError(
      'web_installation_transport_budget_exceeded',
      'Las publicaciones superan el presupuesto seguro de sincronización de WordPress.',
      409,
      {
        unique_files: uniqueFiles,
        download_requests: downloadRequests,
        response_bytes: responseBytes,
        max_unique_files: MAX_WORDPRESS_V2_UNIQUE_FILES,
        max_download_requests: MAX_WORDPRESS_V2_DOWNLOAD_REQUESTS,
        max_response_bytes: MAX_WORDPRESS_V2_CONTROL_BYTES,
      }
    );
  }
  return { unique_files: uniqueFiles, download_requests: downloadRequests, response_bytes: responseBytes };
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

async function inheritedWordpressGroupId(scope, { models, transaction = null } = {}) {
  if (scope.type !== 'clinic') return null;
  const membership = await clinicMembership(scope.id, { models, transaction });
  return membership?.active ? membership.group_id : null;
}

function issueInstallationToken() {
  return `${INSTALLATION_TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`;
}

function issueSiteClaimToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function siteClaimTtlSeconds(env = process.env) {
  const requested = Number.parseInt(
    String(env.MARKETING_WEB_WORDPRESS_SITE_CLAIM_TTL_SECONDS || DEFAULT_SITE_CLAIM_TTL_SECONDS),
    10
  );
  return Math.min(
    Math.max(Number.isSafeInteger(requested) ? requested : DEFAULT_SITE_CLAIM_TTL_SECONDS, 15 * 60),
    7 * 24 * 60 * 60
  );
}

function siteClaimWindow(env = process.env, now = new Date()) {
  const issuedAt = new Date(now);
  return {
    issuedAt,
    expiresAt: new Date(issuedAt.getTime() + siteClaimTtlSeconds(env) * 1000),
  };
}

function assertInstallationSiteClaimed(installation) {
  const value = plain(installation);
  if (!value || value.status === 'pending') {
    throw new WebPublicationServiceError(
      'web_wordpress_site_claim_required',
      'WordPress debe demostrar el control del dominio antes de recibir configuración o artefactos.',
      409
    );
  }
  if (
    !/^[a-f0-9]{64}$/.test(String(value.claimedSiteHash || ''))
    || !secureEqual(value.claimedSiteHash, sha256(normalizeSiteUrl(value.siteUrl).url))
  ) {
    throw new WebPublicationServiceError(
      'web_wordpress_site_claim_invalid',
      'La instalación no conserva una prueba válida de control del dominio.',
      409
    );
  }
  return true;
}

function tokenRotationTtlSeconds(env = process.env) {
  const requested = Number.parseInt(String(env.MARKETING_WEB_WORDPRESS_TOKEN_ROTATION_TTL_SECONDS || '86400'), 10);
  return Math.min(Math.max(Number.isSafeInteger(requested) ? requested : 86400, 10 * 60), 7 * 24 * 60 * 60);
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

function signingKeyTransitionForInstallation({
  installationPublicKeyId,
  currentDescriptor,
  retiredKeyIds = [],
  signingOptions = {},
  env = process.env,
} = {}) {
  const installedKeyId = String(installationPublicKeyId || '').trim();
  const retired = new Set((Array.isArray(retiredKeyIds) ? retiredKeyIds : [])
    .map((keyId) => String(keyId || '').trim())
    .filter((keyId) => /^ed25519-[a-f0-9]{16}$/.test(keyId)));
  if (retired.has(currentDescriptor.key_id)) {
    throw new WebPublicationServiceError(
      'web_installation_signing_key_downgrade_blocked',
      'La clave configurada ya fue retirada por esta instalación.',
      409
    );
  }
  if (secureEqual(installedKeyId, currentDescriptor.key_id)) {
    return {
      descriptor: currentDescriptor,
      descriptorEnvelope: {},
      rotating: false,
    };
  }

  const rotationFromKeyId = String(
    signingOptions.rotationFromKeyId
      || env.MARKETING_WEB_SIGNING_ROTATION_FROM_KEY_ID
      || ''
  ).trim();
  if (
    !/^ed25519-[a-f0-9]{16}$/.test(rotationFromKeyId)
    || secureEqual(rotationFromKeyId, currentDescriptor.key_id)
  ) {
    throw new WebPublicationServiceError(
      'web_installation_signing_key_rotation_unavailable',
      'La transición de la clave de publicación no está configurada de forma segura.',
      503
    );
  }
  if (!secureEqual(installedKeyId, rotationFromKeyId)) {
    throw new WebPublicationServiceError(
      'web_installation_signing_key_rotation_not_authorized',
      'La clave confiada por la instalación no pertenece a la transición autorizada.',
      409
    );
  }

  const previousPrivateKeyValue = signingOptions.previousPrivateKey
    || signingOptions.previousPrivateKeyPem
    || env.MARKETING_WEB_SIGNING_PREVIOUS_PRIVATE_KEY_PEM;
  if (!previousPrivateKeyValue) {
    throw new WebPublicationServiceError(
      'web_installation_signing_key_rotation_unavailable',
      'Falta temporalmente la clave anterior necesaria para autorizar la transición.',
      503
    );
  }
  const previousPrivateKey = signingOptions.previousPrivateKey
    || loadPrivateKey(previousPrivateKeyValue);
  const previousPublicKey = crypto.createPublicKey(previousPrivateKey);
  const previousOptions = { privateKey: previousPrivateKey, publicKey: previousPublicKey };
  const previousDescriptor = pluginKeyDescriptor(previousOptions);
  if (!secureEqual(previousDescriptor.key_id, rotationFromKeyId)) {
    throw new WebPublicationServiceError(
      'web_installation_signing_key_rotation_key_mismatch',
      'La clave anterior no coincide con el origen autorizado de la transición.',
      503
    );
  }
  const descriptorEnvelope = signWebArtifactManifest(currentDescriptor, previousOptions);
  if (!secureEqual(descriptorEnvelope.key_id, rotationFromKeyId)) {
    throw new WebPublicationServiceError(
      'web_installation_signing_key_rotation_signature_invalid',
      'No se pudo autorizar la nueva clave con el ancla anterior.',
      503
    );
  }
  return {
    descriptor: currentDescriptor,
    descriptorEnvelope,
    rotating: true,
  };
}

function serializeInstallation(row, metadata = {}) {
  const value = plain(row);
  const inherited = metadata.inherited_from_group === true;
  const stagedTokenExpiresAt = value.nextTokenExpiresAt ? new Date(value.nextTokenExpiresAt) : null;
  const stagedTokenExpired = Boolean(
    value.nextTokenHash
    && (!stagedTokenExpiresAt
      || !Number.isFinite(stagedTokenExpiresAt.getTime())
      || stagedTokenExpiresAt <= new Date())
  );
  return {
    id: value.id,
    scope: {
      type: value.scopeType,
      id: Number(value.scopeType === 'clinic' ? value.clinicaId : value.grupoClinicaId),
    },
    site_url: value.siteUrl,
    status: value.status,
    plugin_version: value.pluginVersion || null,
    capabilities: value.capabilities || {},
    last_seen_at: value.lastSeenAt || null,
    inherited_from_group: inherited,
    source_scope: {
      type: value.scopeType,
      id: Number(value.scopeType === 'clinic' ? value.clinicaId : value.grupoClinicaId),
    },
    version: Number(value.version),
    created_at: value.created_at,
    updated_at: value.updated_at,
    ...(!inherited ? {
      site_claim: {
        claimed: /^[a-f0-9]{64}$/.test(String(value.claimedSiteHash || '')),
        challenge_pending: Boolean(value.siteClaimTokenHash && value.siteClaimExpiresAt),
        challenge_expires_at: value.siteClaimExpiresAt || null,
        claimed_at: value.siteClaimedAt || null,
      },
      token_prefix: value.tokenPrefix,
      token_rotation: value.nextTokenHash ? {
        pending: !stagedTokenExpired,
        expired: stagedTokenExpired,
        token_prefix: value.nextTokenPrefix || null,
        issued_at: value.nextTokenIssuedAt || null,
        expires_at: value.nextTokenExpiresAt || null,
      } : { pending: false },
      reported_state: value.reportedState || {},
      public_key_id: value.publicKeyId,
      last_artifact_hash: value.lastArtifactHash || null,
      desired_sequence: Number(value.desiredSequence || 0),
      revoked_at: value.revokedAt || null,
    } : {}),
    ...(Number.isSafeInteger(metadata.publication_count) ? {
      publication_count: metadata.publication_count,
      publication_limit: MAX_WORDPRESS_PUBLICATIONS,
      released_publication_tombstones: Number(metadata.released_publication_tombstones || 0),
      route_history_count: Number(metadata.route_history_count || 0),
      requires_additional_route: Number(metadata.route_history_count || 0) > 0,
    } : {}),
  };
}

async function createInstallation({
  actorId,
  body = {},
  requestId = null,
  models = db,
  sequelize = db.sequelize,
  assertAccess = assertScopeAccess,
  assertPublishing = assertWebPublishingChannelEnabled,
  signingOptions = {},
  env = process.env,
} = {}) {
  const scope = normalizeScope(body);
  await assertAccess(actorId, scope, 'marketing.web.domains.manage', { models });
  assertPublishing(scope, 'wordpress', env);
  const site = normalizeSiteUrl(body.site_url);
  const token = issueInstallationToken();
  const siteClaimToken = issueSiteClaimToken();
  const claimWindow = siteClaimWindow(env);
  const newInstallationId = crypto.randomUUID();
  // Validate encryption/key material before opening a transaction. The ticket
  // can be reused if this call wins creation; a same-scope pending reissue gets
  // a fresh ticket bound to the existing id after the transaction.
  let pluginPackage = issueBootstrapTicket({
    installationId: newInstallationId,
    actorId: positiveInteger(actorId),
    token,
    siteClaimToken,
    env,
  });
  const descriptor = pluginKeyDescriptor(signingOptions);
  try {
    const result = await sequelize.transaction(async (transaction) => {
      const scopeModel = scope.type === 'clinic' ? models.Clinica : models.GrupoClinica;
      if (!scopeModel || typeof scopeModel.findByPk !== 'function') {
        throw new WebPublicationServiceError(
          'web_wordpress_scope_lock_unavailable',
          'No se puede serializar de forma segura la conexión de WordPress.',
          503
        );
      }
      const lockedScope = await scopeModel.findByPk(scope.id, {
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!lockedScope) {
        throw new WebPublicationServiceError(
          'web_wordpress_scope_not_found',
          'La clínica o grupo ya no está disponible.',
          404
        );
      }
      const pending = await models.WebWordpressInstallation.findOne({
        where: {
          ...scopeWhere(scope),
          siteUrlHash: sha256(site.url),
          status: 'pending',
        },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (pending) {
        await pending.update({
          tokenHash: tokenHash(token),
          tokenPrefix: token.slice(0, 12),
          nextTokenHash: null,
          nextTokenPrefix: null,
          nextTokenIssuedAt: null,
          nextTokenExpiresAt: null,
          claimedSiteHash: null,
          siteClaimTokenHash: sha256(siteClaimToken),
          siteClaimIssuedAt: claimWindow.issuedAt,
          siteClaimExpiresAt: claimWindow.expiresAt,
          siteClaimedAt: null,
          version: Number(pending.version || 0) + 1,
          updatedByUserId: positiveInteger(actorId),
        }, { transaction });
        await models.WebAuditEvent.create({
          projectId: null,
          ...scopeColumns(scope),
          actorUserId: positiveInteger(actorId),
          eventType: 'web.wordpress_installation.pending_reissued',
          entityType: 'web_wordpress_installation',
          entityId: pending.id,
          requestId,
          metadata: {
            site_url_hash: pending.siteUrlHash,
            site_claim_expires_at: claimWindow.expiresAt.toISOString(),
          },
        }, { transaction });
        return { installation: pending, created: false };
      }
      const row = await models.WebWordpressInstallation.create({
        id: newInstallationId,
        ...scopeColumns(scope),
        siteUrl: site.url,
        siteUrlHash: sha256(site.url),
        claimedSiteHash: null,
        siteClaimTokenHash: sha256(siteClaimToken),
        siteClaimIssuedAt: claimWindow.issuedAt,
        siteClaimExpiresAt: claimWindow.expiresAt,
        siteClaimedAt: null,
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
        metadata: {
          site_url_hash: row.siteUrlHash,
          public_key_id: row.publicKeyId,
          site_claim_expires_at: claimWindow.expiresAt.toISOString(),
        },
      }, { transaction });
      return { installation: row, created: true };
    });
    if (!result.created) {
      pluginPackage = issueBootstrapTicket({
        installationId: result.installation.id,
        actorId: positiveInteger(actorId),
        token,
        siteClaimToken,
        env,
      });
    }
    return {
      installation: serializeInstallation(result.installation),
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
  const inheritedGroupId = await inheritedWordpressGroupId(scope, { models });
  const visibleScope = inheritedGroupId
    ? {
        [Op.or]: [
          scopeWhere(scope),
          { scopeType: 'group', grupoClinicaId: inheritedGroupId },
        ],
      }
    : scopeWhere(scope);
  const rows = await models.WebWordpressInstallation.findAll({
    where: {
      ...visibleScope,
      ...(query.include_revoked === 'true' ? {} : { status: { [Op.ne]: 'revoked' } }),
    },
    order: [['created_at', 'DESC'], ['id', 'ASC']],
    limit: 100,
  });
  const ids = rows.map((row) => plain(row).id);
  const publicationRows = ids.length > 0
    ? await models.WebPublication.findAll({
        where: { wordpressInstallationId: { [Op.in]: ids } },
        attributes: ['id', 'wordpressInstallationId', 'status', 'path'],
        raw: true,
      })
    : [];
  const counts = new Map();
  const tombstones = new Map();
  const routeHistory = new Map();
  const installationsById = new Map(rows.map((row) => [String(plain(row).id), plain(row)]));
  for (const publication of publicationRows) {
    const value = plain(publication);
    const installationKey = String(value.wordpressInstallationId ?? value.wordpress_installation_id);
    const currentInstallation = installationsById.get(installationKey);
    if (!currentInstallation) continue;
    routeHistory.set(installationKey, Number(routeHistory.get(installationKey) || 0) + 1);
    if (isReleasedWordpressPublication(currentInstallation, value)) {
      tombstones.set(installationKey, Number(tombstones.get(installationKey) || 0) + 1);
    } else {
      counts.set(installationKey, Number(counts.get(installationKey) || 0) + 1);
    }
  }
  return rows.map((row) => serializeInstallation(row, {
    publication_count: counts.get(String(plain(row).id)) || 0,
    released_publication_tombstones: tombstones.get(String(plain(row).id)) || 0,
    route_history_count: routeHistory.get(String(plain(row).id)) || 0,
    inherited_from_group: scope.type === 'clinic'
      && plain(row).scopeType === 'group'
      && Number(plain(row).grupoClinicaId) === inheritedGroupId,
  }));
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
  assertPublishing = assertWebPublishingChannelEnabled,
  env = process.env,
} = {}) {
  const { installation, scope } = await getInstallationForActor({ actorId, installationId, models, assertAccess });
  assertPublishing(scope, 'wordpress', env);
  const token = issueInstallationToken();
  const pendingClaimToken = installation.status === 'pending' ? issueSiteClaimToken() : null;
  const claimWindow = pendingClaimToken ? siteClaimWindow(env) : null;
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + tokenRotationTtlSeconds(env) * 1000);
  // Validate bootstrap encryption before mutating the row. The final ticket is
  // issued after the lock because a concurrent first claim can turn a pending
  // reissue into a staged connected rotation.
  issueBootstrapTicket({
    installationId: installation.id,
    actorId: positiveInteger(actorId),
    token,
    siteClaimToken: pendingClaimToken,
    env,
  });
  const rotation = await sequelize.transaction(async (transaction) => {
    const locked = await models.WebWordpressInstallation.findByPk(installation.id, {
      transaction, lock: transaction.LOCK.UPDATE,
    });
    if (!locked || locked.status === 'revoked') {
      throw new WebPublicationServiceError('web_wordpress_installation_not_found', 'La instalación no existe.', 404);
    }
    const previousTokenPrefix = locked.tokenPrefix;
    const stagesRotation = locked.status !== 'pending';
    await locked.update({
      ...(stagesRotation ? {
        nextTokenHash: tokenHash(token),
        nextTokenPrefix: token.slice(0, 12),
        nextTokenIssuedAt: issuedAt,
        nextTokenExpiresAt: expiresAt,
      } : {
        tokenHash: tokenHash(token),
        tokenPrefix: token.slice(0, 12),
        nextTokenHash: null,
        nextTokenPrefix: null,
        nextTokenIssuedAt: null,
        nextTokenExpiresAt: null,
        claimedSiteHash: null,
        siteClaimTokenHash: sha256(pendingClaimToken),
        siteClaimIssuedAt: claimWindow.issuedAt,
        siteClaimExpiresAt: claimWindow.expiresAt,
        siteClaimedAt: null,
      }),
      version: Number(locked.version) + 1,
      updatedByUserId: positiveInteger(actorId),
    }, { transaction });
    await models.WebAuditEvent.create({
      projectId: null,
      ...scopeColumns(scope),
      actorUserId: positiveInteger(actorId),
        eventType: stagesRotation
          ? 'web.wordpress_installation.token_rotation_staged'
          : 'web.wordpress_installation.token_reissued',
      entityType: 'web_wordpress_installation',
      entityId: locked.id,
      requestId,
      metadata: {
        previous_token_prefix: previousTokenPrefix,
        token_prefix: stagesRotation ? locked.nextTokenPrefix : locked.tokenPrefix,
        ...(stagesRotation ? { next_token_expires_at: expiresAt.toISOString() } : {}),
        ...(!stagesRotation ? { site_claim_expires_at: claimWindow.expiresAt.toISOString() } : {}),
      },
    }, { transaction });
    return { installation: locked, stagesRotation };
  });
  const pluginPackage = issueBootstrapTicket({
    installationId: rotation.installation.id,
    actorId: positiveInteger(actorId),
    token,
    siteClaimToken: rotation.stagesRotation ? null : pendingClaimToken,
    env,
  });
  return {
    installation: serializeInstallation(rotation.installation),
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
      const publications = await installationPublications(locked, {
        models,
        transaction,
        lock: true,
        allowEmpty: true,
        maxPublications: MAX_WORDPRESS_PUBLICATION_HISTORY,
      });
      const unreleased = publications.filter((row) => (
        !isReleasedWordpressPublication(plain(locked), plain(row))
      ));
      if (unreleased.length) {
        throw new WebPublicationServiceError(
          'web_wordpress_installation_retirement_required',
          'Retira y confirma todas las landings antes de desconectar este WordPress.',
          409,
          {
            publication_ids: unreleased.map((row) => String(plain(row).id)),
            next_action: 'retire_and_confirm_wordpress_publications',
          }
        );
      }
      await locked.update({
        status: 'revoked',
        claimedSiteHash: null,
        siteClaimTokenHash: null,
        siteClaimIssuedAt: null,
        siteClaimExpiresAt: null,
        siteClaimedAt: null,
        tokenHash: sha256(`revoked:${crypto.randomUUID()}`),
        nextTokenHash: null,
        nextTokenPrefix: null,
        nextTokenIssuedAt: null,
        nextTokenExpiresAt: null,
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
  const installation = await models.WebWordpressInstallation.findByPk(String(installationId || ''));
  const dummyHash = sha256('clinicaclick-dummy-installation-token');
  const primaryMatches = secureEqual(digest, installation?.tokenHash || dummyHash);
  const nextMatches = secureEqual(digest, installation?.nextTokenHash || dummyHash);
  const nextExpiresAt = installation?.nextTokenExpiresAt ? new Date(installation.nextTokenExpiresAt) : null;
  const nextIsUsable = nextMatches
    && semverAtLeast(pluginVersion, MIN_MULTI_PUBLICATION_PLUGIN_VERSION)
    && nextExpiresAt
    && Number.isFinite(nextExpiresAt.getTime())
    && nextExpiresAt > new Date();
  const tokenSlot = primaryMatches ? 'primary' : (nextIsUsable ? 'next' : null);
  if (
    !installation
    || !tokenSlot
    || installation.status === 'revoked'
  ) {
    throw new WebPublicationServiceError('web_installation_unauthorized', 'Credenciales no válidas.', 401);
  }
  Object.defineProperties(installation, {
    _ccAuthenticatedTokenSlot: { value: tokenSlot, configurable: true },
    _ccAuthenticatedTokenDigest: { value: digest, configurable: true },
  });
  return installation;
}

function validateLockedInstallationAuthentication({
  locked,
  tokenSlot,
  tokenDigest,
  allowConcurrentPromotion = true,
} = {}) {
  if (!locked || locked.status === 'revoked') {
    throw new WebPublicationServiceError('web_installation_unauthorized', 'Credenciales no válidas.', 401);
  }
  const primaryTokenMatches = secureEqual(tokenDigest, locked.tokenHash);
  const nextTokenMatches = secureEqual(tokenDigest, locked.nextTokenHash);
  const nextTokenExpiresAt = locked.nextTokenExpiresAt ? new Date(locked.nextTokenExpiresAt) : null;
  const nextTokenIsUsable = nextTokenMatches
    && nextTokenExpiresAt
    && Number.isFinite(nextTokenExpiresAt.getTime())
    && nextTokenExpiresAt > new Date();
  const concurrentlyPromoted = allowConcurrentPromotion
    && tokenSlot === 'next'
    && primaryTokenMatches
    && !nextTokenMatches;
  if (
    (tokenSlot === 'primary' && !primaryTokenMatches)
    || (tokenSlot === 'next' && !nextTokenIsUsable && !concurrentlyPromoted)
    || !['primary', 'next'].includes(tokenSlot)
  ) {
    throw new WebPublicationServiceError('web_installation_unauthorized', 'Credenciales no válidas.', 401);
  }
  return { primaryTokenMatches, nextTokenIsUsable, concurrentlyPromoted };
}

async function intakeConfigForInstallation(installation, { models = db, transaction = null } = {}) {
  const scope = scopeFromInstallation(installation);
  return effectiveIntakeConfigForScope({
    scopeType: scope.type,
    ...(scope.type === 'group' ? { groupId: scope.id } : { clinicId: scope.id }),
    models,
    transaction,
  });
}

function measurementFromIntake(record) {
  const hmac = String(record?.hmac_key || '').trim();
  if (!record || hmac.length < 16 || hmac.length > 512 || /[\x00-\x20\x7f]/.test(hmac)) {
    return { enabled: false };
  }
  const assignmentScope = record.assignment_scope === 'group' ? 'group' : 'clinic';
  const assignmentScopeId = positiveInteger(assignmentScope === 'group' ? record.group_id : record.clinic_id);
  const inheritedScope = parseRuntimeInheritance(record.config?.runtime_inheritance);
  const effectiveScope = inheritedScope || { type: assignmentScope, id: assignmentScopeId };
  const scopeId = effectiveScope.id;
  if (!scopeId) return { enabled: false };
  const features = record.config?.features && typeof record.config.features === 'object'
    ? record.config.features
    : {};
  const provider = ['clinicaclick', 'external_cmp'].includes(String(features.consent_provider || '').trim().toLowerCase())
    ? String(features.consent_provider).trim().toLowerCase()
    : 'external_cmp';
  return {
    enabled: true,
    scope_type: effectiveScope.type,
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

function authenticatedDbMetadataContract({ artifactHash, installationId, paths, env = process.env } = {}) {
  const installation = String(installationId || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(installation)) {
    throw new WebPublicationServiceError(
      'web_installation_artifact_storage_mismatch',
      'El descriptor autenticado no corresponde a esta instalación.',
      503
    );
  }
  const root = `${installationApiBase(env)}/api/marketing/web-installations/${installation}/artifacts/${artifactHash}`;
  return {
    provider: 'authenticated_db',
    installation_id: installation,
    artifact_hash: artifactHash,
    manifest_url: `${root}/manifest`,
    signature_url: `${root}/envelope`,
    files: Object.fromEntries(paths.map((path) => [
      path,
      `${root}/files/${pathToken(path)}`,
    ])),
  };
}

function safeImmutableStorage(storage, artifact, {
  installationId = null,
  env = process.env,
  expectedFilePaths = null,
} = {}) {
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
  const actualPaths = Object.keys(value.files).sort();
  const explicitExpectedPaths = Array.isArray(expectedFilePaths)
    ? [...new Set(expectedFilePaths.map((path) => String(path)))].sort()
    : null;
  if (value.provider === 'authenticated_db') {
    const expected = explicitExpectedPaths
      ? authenticatedDbMetadataContract({
          artifactHash,
          installationId,
          paths: explicitExpectedPaths,
          env,
        })
      : authenticatedDbStorageDescriptor({ artifact, installationId, env });
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
  const expectedPaths = explicitExpectedPaths || Object.keys(manifest.files || {}).sort();
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

async function publicationStateForRow(installation, publication, {
  models = db,
  env = process.env,
  allowPending = false,
  transaction = null,
} = {}) {
  if (publication.status === 'retired') return { status: 'retired', publication };

  // WordPress promotes an immutable release before the control plane can run
  // the public healthcheck. A terminal first failure explicitly retires only
  // this route while retaining its cached release for diagnosis.
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
      ...(transaction ? { transaction } : {}),
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
      ...(transaction ? { transaction } : {}),
    });
  }
  if (!deployment?.artifactId) {
    if (allowPending) return { status: 'pending', publication };
    throw new WebPublicationServiceError(
      'web_installation_artifact_not_ready',
      'La publicación todavía no tiene un artefacto listo para WordPress.',
      409
    );
  }
  const artifact = await models.WebArtifact.findByPk(
    deployment.artifactId,
    {
      attributes: [...ARTIFACT_AUTHORIZATION_ATTRIBUTES],
      ...(transaction ? { transaction } : {}),
    }
  );
  if (
    !artifact
    || artifact.projectId !== publication.projectId
    || artifact.environment !== 'production'
    || artifact.status !== 'ready'
  ) {
    if (allowPending) return { status: 'pending', publication };
    throw new WebPublicationServiceError('web_installation_artifact_not_ready', 'El artefacto no está disponible.', 409);
  }
  let bundle;
  try {
    const declaredBundleBytes = webArtifactBundleFootprintBytes(artifact.manifest);
    if (declaredBundleBytes === null || declaredBundleBytes > MAX_WEB_ARTIFACT_BUNDLE_BYTES) {
      throw new WebPublicationServiceError(
        'web_installation_artifact_not_ready',
        'El artefacto supera el presupuesto seguro de publicación.',
        409
      );
    }
    bundle = safeImmutableStorage(deployment.storage, artifact, {
      installationId: installation.id,
      env,
      expectedFilePaths: Object.keys(artifact.manifest.files),
    });
  } catch (error) {
    if (allowPending) return { status: 'pending', publication, error_code: error?.code || 'artifact_not_ready' };
    throw error;
  }
  return { status: 'published', publication, deployment, artifact, bundle };
}

async function installationPublications(installation, {
  models = db,
  transaction = null,
  lock = false,
  excludeReleasedRetired = false,
  allowEmpty = false,
  maxPublications = MAX_WORDPRESS_PUBLICATIONS,
} = {}) {
  const rows = await models.WebPublication.findAll({
    where: { wordpressInstallationId: installation.id },
    order: [['path', 'ASC'], ['id', 'ASC']],
    ...(transaction ? { transaction } : {}),
    ...(transaction && lock ? { lock: transaction.LOCK.UPDATE } : {}),
  });
  const publications = excludeReleasedRetired
    ? rows.filter((row) => !isReleasedWordpressPublication(plain(installation), plain(row)))
    : rows;
  if (publications.length === 0 && !allowEmpty) {
    throw new WebPublicationServiceError(
      'web_installation_publication_not_configured',
      'La instalación todavía no tiene una publicación configurada.',
      409
    );
  }
  if (publications.length > maxPublications) {
    throw new WebPublicationServiceError(
      'web_installation_publication_limit_exceeded',
      'La instalación supera el máximo seguro de publicaciones.',
      409
    );
  }
  return publications;
}

async function publicationDesiredState(installation, {
  models = db, env = process.env, transaction = null, lock = false,
} = {}) {
  const rows = await installationPublications(installation, { models, transaction, lock });
  const publications = await filterAuthorizedWordpressPublications(installation, rows, {
    models,
    transaction,
    lockClinics: lock,
  });
  if (publications.length === 0) {
    throw new WebPublicationServiceError(
      'web_installation_publication_not_configured',
      'La instalación todavía no tiene una publicación autorizada configurada.',
      409
    );
  }
  if (publications.length > 1) {
    throw new WebPublicationServiceError(
      'web_installation_publication_ambiguous',
      'La instalación requiere un plugin compatible con varias publicaciones.',
      409
    );
  }
  return publicationStateForRow(installation, publications[0], { models, env, transaction });
}

async function publicationDesiredStates(installation, {
  models = db, env = process.env, transaction = null, lock = false,
} = {}) {
  const rows = await installationPublications(installation, {
    models,
    transaction,
    lock,
    excludeReleasedRetired: true,
    allowEmpty: true,
  });
  const publications = await filterAuthorizedWordpressPublications(installation, rows, {
    models,
    transaction,
    lockClinics: lock,
  });
  if (publications.length > 1 && !supportsMultiPublication(installation)) {
    throw new WebPublicationServiceError(
      'web_wordpress_multi_publication_plugin_update_required',
      'Actualiza el plugin de WordPress antes de sincronizar varias publicaciones.',
      409
    );
  }
  const states = [];
  for (const publication of publications) {
    states.push(await publicationStateForRow(installation, publication, {
      models, env, allowPending: true, transaction,
    }));
  }
  return states.sort((left, right) => String(left.publication.id).localeCompare(String(right.publication.id)));
}

async function sequenceForDesiredState({
  installation,
  fingerprint,
  models = db,
  sequelize = db.sequelize,
  transaction = null,
} = {}) {
  const updateSequence = async (currentTransaction) => {
    const locked = transaction
      ? installation
      : await models.WebWordpressInstallation.findByPk(installation.id, {
        transaction: currentTransaction, lock: currentTransaction.LOCK.UPDATE,
      });
    if (!locked || locked.status === 'revoked') {
      throw new WebPublicationServiceError('web_installation_unauthorized', 'Credenciales no válidas.', 401);
    }
    if (!secureEqual(locked.desiredStateHash || '', fingerprint)) {
      const next = Number(locked.desiredSequence || 0) + 1;
      await locked.update({ desiredSequence: next, desiredStateHash: fingerprint }, { transaction: currentTransaction });
      return next;
    }
    return Math.max(1, Number(locked.desiredSequence || 0));
  };
  return transaction ? updateSequence(transaction) : sequelize.transaction(updateSequence);
}

async function getDesiredStateV2({
  installation,
  intake,
  measurementOverride = null,
  requestId,
  models,
  sequelize,
  signingOptions,
  env,
  descriptor,
  descriptorEnvelope,
  transaction = null,
}) {
  const states = await publicationDesiredStates(installation, {
    models, env, transaction, lock: Boolean(transaction),
  });
  const routes = {};
  const artifacts = {};
  for (const state of states) {
    const publication = plain(state.publication);
    const active = state.status === 'published';
    routes[publication.id] = {
      publication_id: publication.id,
      route_prefix: String(publication.path),
      status: active ? 'active' : state.status,
      desired_artifact_hash: active ? state.bundle.artifact_hash : null,
    };
    if (active) {
      artifacts[state.bundle.artifact_hash] = state.bundle;
    }
  }
  assertV2TransportBudget({ routes, artifacts });
  const registryWithoutSequence = {
    schema_version: 2,
    installation_id: installation.id,
    measurement: measurementOverride || measurementFromIntake(intake),
    routes,
  };
  const fingerprint = sha256(canonicalSerialize({
    registry: registryWithoutSequence,
    artifacts,
    key_id: descriptor.key_id,
  }));
  const sequence = await sequenceForDesiredState({ installation, fingerprint, models, sequelize, transaction });
  const registry = {
    schema_version: 2,
    installation_id: installation.id,
    sequence,
    measurement: registryWithoutSequence.measurement,
    routes: registryWithoutSequence.routes,
  };
  const desiredState = {
    status: 'multi',
    signing_key_descriptor: descriptor,
    signing_key_descriptor_envelope: descriptorEnvelope,
    registry_configuration: registry,
    registry_configuration_envelope: signWebArtifactManifest(registry, signingOptions),
    artifacts,
  };
  const response = {
    schema_version: 2,
    request_id: requestId,
    installation_id: installation.id,
    desired_state: desiredState,
  };
  assertV2TransportBudget({ routes, artifacts, response });
  return {
    response,
    etag: `"${sha256(canonicalSerialize({ installation_id: installation.id, desired_state: desiredState }))}"`,
  };
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
  const authenticatedTokenSlot = installation._ccAuthenticatedTokenSlot;
  const authenticatedTokenDigest = installation._ccAuthenticatedTokenDigest;
  const descriptor = pluginKeyDescriptor(signingOptions);
  return sequelize.transaction(async (transaction) => {
    const locked = await models.WebWordpressInstallation.findByPk(installation.id, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    validateLockedInstallationAuthentication({
      locked,
      tokenSlot: authenticatedTokenSlot,
      tokenDigest: authenticatedTokenDigest,
    });
    assertInstallationSiteClaimed(locked);
    const signingKeyTransition = signingKeyTransitionForInstallation({
      installationPublicKeyId: locked.publicKeyId,
      currentDescriptor: descriptor,
      retiredKeyIds: locked.reportedState?.signing_key_history,
      signingOptions,
      env,
    });
    const callerInstallation = {
      ...plain(locked),
      pluginVersion: String(headers.pluginVersion || headers['x-clinicaclick-plugin-version'] || '').trim(),
    };
    const intake = await intakeConfigForInstallation(locked, { models, transaction });
    const runtimeRollout = models.WebIntakeRuntimeReconciliation
      ? await require('./webIntakeRuntimeReconciliation.service').desiredRuntimeForInstallation({
          installation: locked,
          models,
          transaction,
          env,
        })
      : null;
    if (supportsMultiPublication(callerInstallation)) {
      return getDesiredStateV2({
        installation: locked,
        intake,
        measurementOverride: runtimeRollout?.measurement || null,
        requestId,
        models,
        sequelize,
        signingOptions,
        env,
        descriptor,
        descriptorEnvelope: signingKeyTransition.descriptorEnvelope,
        transaction,
      });
    }
    const publicationState = await publicationDesiredState(locked, {
      models, env, transaction, lock: true,
    });
    const measurement = runtimeRollout?.measurement || measurementFromIntake(intake);
    const runtimeWithoutSequence = {
      schema_version: 1,
      installation_id: locked.id,
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
    const sequence = await sequenceForDesiredState({
      installation: locked, fingerprint, models, sequelize, transaction,
    });
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
      signing_key_descriptor_envelope: signingKeyTransition.descriptorEnvelope,
      runtime_configuration: runtime,
      runtime_configuration_envelope: signWebArtifactManifest(runtime, signingOptions),
    };
    const response = {
      schema_version: 1,
      request_id: requestId,
      installation_id: locked.id,
      desired_state: desiredState,
    };
    return {
      response,
      // request_id sirve para trazabilidad de cada llamada y no forma parte de
      // la versión deseada; así If-None-Match puede producir un 304 real.
      etag: `"${sha256(canonicalSerialize({ installation_id: locked.id, desired_state: desiredState }))}"`,
    };
  });
}

async function authorizedArtifactForInstallation({
  installation,
  requestedHash,
  callerSupportsMulti,
  models = db,
  env = process.env,
} = {}) {
  if (!callerSupportsMulti) {
    const publicationCount = await models.WebPublication.count({
      where: { wordpressInstallationId: installation.id },
    });
    if (publicationCount > 1) {
      throw new WebPublicationServiceError(
        'web_installation_publication_ambiguous',
        'La instalación requiere un plugin compatible con varias publicaciones.',
        409
      );
    }
  }

  const freshArtifact = await models.WebArtifact.findOne({
    where: { artifactHash: requestedHash, environment: 'production', status: 'ready' },
    attributes: [...ARTIFACT_AUTHORIZATION_ATTRIBUTES],
  });
  const artifact = plain(freshArtifact);
  if (
    !artifact
    || artifact.environment !== 'production'
    || artifact.status !== 'ready'
    || !secureEqual(artifact.artifactHash, requestedHash)
  ) {
    return null;
  }
  const declaredBundleBytes = webArtifactBundleFootprintBytes(artifact.manifest);
  if (
    declaredBundleBytes === null
    || declaredBundleBytes > MAX_WEB_ARTIFACT_BUNDLE_BYTES
  ) return null;

  const deployments = await models.WebPublicationDeployment.findAll({
    where: {
      artifactId: artifact.id,
      status: { [Op.in]: ['queued', 'running', 'verified'] },
    },
    order: [['publicationId', 'ASC'], ['sequence', 'DESC']],
  });
  const deploymentRows = deployments.map(plain);
  const publicationIds = [...new Set(deploymentRows.map((deployment) => String(deployment.publicationId)))];
  if (!publicationIds.length) return null;
  const publicationRows = await models.WebPublication.findAll({
    where: {
      id: { [Op.in]: publicationIds },
      wordpressInstallationId: installation.id,
      status: { [Op.ne]: 'retired' },
    },
    order: [['id', 'ASC']],
  });
  const publications = await filterAuthorizedWordpressPublications(installation, publicationRows, {
    models,
  });

  for (const publicationRow of publications) {
    const publication = plain(publicationRow);
    if (String(publication.projectId) !== String(artifact.projectId)) continue;
    const candidates = deploymentRows.filter((deployment) => (
      String(deployment.publicationId) === String(publication.id)
    ));
    let desiredDeployment = null;
    if (['pending', 'publishing', 'rolling_back'].includes(String(publication.status || ''))) {
      const latest = await models.WebPublicationDeployment.findOne({
        where: {
          publicationId: publication.id,
          status: { [Op.in]: ['queued', 'running'] },
          artifactId: { [Op.ne]: null },
        },
        order: [['sequence', 'DESC']],
      });
      if (latest && String(plain(latest).artifactId) === String(artifact.id)) {
        desiredDeployment = plain(latest);
      }
    } else {
      const recoveryArtifactId = publication.activeArtifactId || publication.lastGoodArtifactId;
      if (String(recoveryArtifactId || '') === String(artifact.id)) {
        desiredDeployment = candidates.find((deployment) => deployment.status === 'verified') || null;
      }
    }
    if (!desiredDeployment) continue;
    try {
      const bundle = safeImmutableStorage(desiredDeployment.storage, artifact, {
        installationId: installation.id,
        env,
        expectedFilePaths: Object.keys(artifact.manifest.files),
      });
      return { publication, deployment: desiredDeployment, artifact, bundle };
    } catch {
      // Another candidate can reference the same immutable artifact. Never
      // reveal storage-integrity details through the authenticated file path.
    }
  }
  return null;
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
  artifactBundleValidator = assertArtifactBundle,
} = {}) {
  const installation = await authenticateInstallation({ installationId, headers, models });
  assertInstallationSiteClaimed(installation);
  const callerInstallation = {
    ...plain(installation),
    pluginVersion: String(headers.pluginVersion || headers['x-clinicaclick-plugin-version'] || '').trim(),
  };
  const requestedHash = String(artifactHash || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(requestedHash)) {
    throw new WebPublicationServiceError(
      'web_installation_artifact_not_found',
      'El artefacto solicitado no es el deseado de esta instalación.',
      404
    );
  }
  const state = await authorizedArtifactForInstallation({
    installation,
    requestedHash,
    callerSupportsMulti: supportsMultiPublication(callerInstallation),
    models,
    env,
  });
  if (
    !state
    || state.deployment?.storage?.provider !== 'authenticated_db'
  ) {
    throw new WebPublicationServiceError(
      'web_installation_artifact_not_found',
      'El artefacto solicitado no es el deseado de esta instalación.',
      404
    );
  }
  const artifactMetadata = plain(state.artifact);
  const normalized = await loadNormalizedArtifactBundle({
    artifactMetadata,
    requestedHash,
    models,
    artifactBundleValidator,
  });
  try {
    safeImmutableStorage(state.deployment.storage, {
      artifactHash: requestedHash,
      manifest: normalized.manifest,
    }, {
      installationId: installation.id,
      env,
      expectedFilePaths: Object.keys(normalized.files),
    });
  } catch {
    throw new WebPublicationServiceError(
      'web_installation_artifact_not_found',
      'El artefacto solicitado no es el deseado de esta instalación.',
      404
    );
  }
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
  'duration_ms', 'reported_at', 'capabilities', 'registry_sequence', 'routes',
  'signing_key_id', 'configuration_sequence',
]);
const REPORT_ROUTE_FIELDS = new Set([
  'publication_id', 'route_prefix', 'status', 'active_artifact_hash', 'desired_artifact_hash',
  'result', 'error_code',
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

function normalizeReportCapabilities(value, schemaVersion) {
  if (value === undefined && schemaVersion === 1) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new WebPublicationServiceError('web_installation_report_invalid', 'Las capacidades reportadas no son válidas.', 422);
  }
  const unknown = Object.keys(value).filter((field) => field !== 'multi_publication_v2');
  if (unknown.length || value.multi_publication_v2 !== true) {
    throw new WebPublicationServiceError('web_installation_report_invalid', 'Las capacidades reportadas no son válidas.', 422);
  }
  return { multi_publication_v2: true };
}

function normalizeReportRoutes(value, schemaVersion) {
  if (schemaVersion === 1) return {};
  // PHP cannot preserve the array/object distinction for an empty associative
  // array without an explicit cast. Accept the already-built alpha.8 wire
  // representation while keeping non-empty JSON lists invalid.
  if (Array.isArray(value) && value.length === 0) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > MAX_WORDPRESS_PUBLICATIONS) {
    throw new WebPublicationServiceError('web_installation_report_invalid', 'Las rutas reportadas no son válidas.', 422);
  }
  const normalized = {};
  const prefixes = new Set();
  for (const [publicationId, candidate] of Object.entries(value)) {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(publicationId)
      || !candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
      throw new WebPublicationServiceError('web_installation_report_invalid', 'Las rutas reportadas no son válidas.', 422);
    }
    const unknown = Object.keys(candidate).filter((field) => !REPORT_ROUTE_FIELDS.has(field));
    const routePrefix = safeShortString(candidate.route_prefix, {
      required: true, maximum: 96, pattern: /^\/cita\/(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\/)?$/,
    });
    const status = safeShortString(candidate.status, { required: true, maximum: 16 });
    if (unknown.length || candidate.publication_id !== publicationId || !REPORT_STATUSES.has(status) || prefixes.has(routePrefix)) {
      throw new WebPublicationServiceError('web_installation_report_invalid', 'Las rutas reportadas no son válidas.', 422);
    }
    prefixes.add(routePrefix);
    const activeArtifactHash = optionalHash(candidate.active_artifact_hash);
    const desiredArtifactHash = optionalHash(candidate.desired_artifact_hash);
    if ((status === 'active' && !activeArtifactHash) || (status !== 'active' && activeArtifactHash)) {
      throw new WebPublicationServiceError('web_installation_report_invalid', 'El estado y el artefacto reportado no son coherentes.', 422);
    }
    normalized[publicationId] = {
      publication_id: publicationId,
      route_prefix: routePrefix,
      status,
      active_artifact_hash: activeArtifactHash,
      desired_artifact_hash: desiredArtifactHash,
      result: safeShortString(candidate.result, { maximum: 64, pattern: /^[a-z0-9_.:-]+$/i }),
      error_code: safeShortString(candidate.error_code, { maximum: 128, pattern: /^[a-z0-9_.:-]+$/i }),
    };
  }
  return normalized;
}

function normalizeReport(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new WebPublicationServiceError('web_installation_report_invalid', 'El reporte no es válido.', 422);
  }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_REPORT_BYTES) {
    throw new WebPublicationServiceError('web_installation_report_too_large', 'El reporte supera el tamaño permitido.', 413);
  }
  const unknown = Object.keys(body).filter((field) => !REPORT_FIELDS.has(field));
  const schemaVersion = Number(body.schema_version);
  if (unknown.length || ![1, 2].includes(schemaVersion) || !REPORT_EVENTS.has(String(body.event || ''))) {
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
  const registrySequence = schemaVersion === 2 ? Number(body.registry_sequence) : null;
  if (schemaVersion === 2 && (!Number.isSafeInteger(registrySequence) || registrySequence < 0)) {
    throw new WebPublicationServiceError('web_installation_report_invalid', 'La secuencia reportada no es válida.', 422);
  }
  const routes = normalizeReportRoutes(body.routes, schemaVersion);
  const signingKeyId = safeShortString(body.signing_key_id, {
    maximum: 25,
    pattern: /^ed25519-[a-f0-9]{16}$/,
  });
  const configurationSequence = body.configuration_sequence === undefined
    || body.configuration_sequence === null
    ? null
    : Number(body.configuration_sequence);
  if (
    (signingKeyId === null) !== (configurationSequence === null)
    || (configurationSequence !== null
      && (!Number.isSafeInteger(configurationSequence) || configurationSequence < 1))
    || (schemaVersion === 2
      && configurationSequence !== null
      && configurationSequence !== registrySequence)
  ) {
    throw new WebPublicationServiceError('web_installation_report_invalid', 'El ACK de firma no es válido.', 422);
  }
  if (schemaVersion === 2 && body.event === 'sync_result') {
    const incoherent = Object.values(routes).some((route) => (
      (route.status === 'active' && !route.desired_artifact_hash)
      || (route.status !== 'active' && route.desired_artifact_hash)
    ));
    if (incoherent) {
      throw new WebPublicationServiceError('web_installation_report_invalid', 'El resultado no identifica el artefacto deseado.', 422);
    }
  }
  return {
    schema_version: schemaVersion,
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
    capabilities: normalizeReportCapabilities(body.capabilities, schemaVersion),
    registry_sequence: registrySequence,
    routes,
    signing_key_id: signingKeyId,
    configuration_sequence: configurationSequence,
  };
}

async function recordReport({
  installationId,
  headers = {},
  body = {},
  requestId,
  models = db,
  sequelize = db.sequelize,
  signingOptions = {},
  env = process.env,
  verifySiteClaim = verifyWordpressSiteClaim,
} = {}) {
  const installation = await authenticateInstallation({ installationId, headers, models });
  const authenticatedTokenSlot = installation._ccAuthenticatedTokenSlot;
  const authenticatedTokenDigest = installation._ccAuthenticatedTokenDigest;
  const report = normalizeReport(body);
  if (!secureEqual(String(headers.pluginVersion || ''), report.plugin_version)) {
    throw new WebPublicationServiceError(
      'web_installation_plugin_version_mismatch',
      'La versión declarada por WordPress no coincide con la cabecera del plugin.',
      422
    );
  }
  if (report.schema_version === 2 && !supportsMultiPublication({
    pluginVersion: report.plugin_version,
    capabilities: report.capabilities,
  })) {
    throw new WebPublicationServiceError(
      'web_installation_report_invalid',
      'La versión del plugin no puede declarar el contrato multi-publicación.',
      422
    );
  }
  const reportCanPromoteStagedToken = report.schema_version === 2 && supportsMultiPublication({
    pluginVersion: report.plugin_version,
    capabilities: report.capabilities,
  });
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
  let siteClaimProof = null;
  if (installation.status === 'pending') {
    const expiresAt = installation.siteClaimExpiresAt
      ? new Date(installation.siteClaimExpiresAt)
      : null;
    if (
      !/^[a-f0-9]{64}$/.test(String(installation.siteClaimTokenHash || ''))
      || !expiresAt
      || !Number.isFinite(expiresAt.getTime())
      || expiresAt <= new Date()
    ) {
      throw new WebPublicationServiceError(
        'web_wordpress_site_claim_expired',
        'La prueba de control ha caducado. Vuelve a generar y descargar el plugin.',
        409
      );
    }
    siteClaimProof = await verifySiteClaim({
      installationId: installation.id,
      siteUrl: reportedSite.site_url,
      expectedClaimTokenHash: installation.siteClaimTokenHash,
    });
  } else {
    assertInstallationSiteClaimed(installation);
  }
  let desired = null;
  let desiredStates = [];
  let confirmsPublished = false;
  let reportsRetired = false;
  let confirmsDesired = false;
  const routeConfirmations = {};
  const reportedSupportsMulti = supportsMultiPublication({
    pluginVersion: report.plugin_version,
    capabilities: report.schema_version === 2 ? report.capabilities : plain(installation).capabilities,
  });
  const reportsPluginDowngrade = supportsMultiPublication(installation) && !reportedSupportsMulti;
  if (report.schema_version === 2) {
    desiredStates = await publicationDesiredStates(installation, { models, env }).catch((error) => {
      if (error?.code === 'web_installation_publication_not_configured') return [];
      throw error;
    });
    const expectedIds = desiredStates.map((state) => String(state.publication.id)).sort();
    const reportedIds = Object.keys(report.routes).sort();
    if (
      reportedIds.some((id) => !expectedIds.includes(id))
      || (report.event === 'sync_result' && canonicalSerialize(expectedIds) !== canonicalSerialize(reportedIds))
    ) {
      throw new WebPublicationServiceError(
        'web_installation_report_route_set_mismatch',
        'El reporte no corresponde al registro firmado de publicaciones.',
        409
      );
    }
    for (const state of desiredStates) {
      const publication = plain(state.publication);
      const candidate = report.routes[publication.id];
      if (!candidate) {
        routeConfirmations[publication.id] = false;
        continue;
      }
      if (candidate.route_prefix !== publication.path) {
        throw new WebPublicationServiceError(
          'web_installation_report_route_set_mismatch',
          'El reporte no corresponde al registro firmado de publicaciones.',
          409
        );
      }
      let confirmed = false;
      if (report.event === 'sync_result' && state.status === 'published') {
        confirmed = candidate.status === 'active'
          && !candidate.error_code
          && ['activated', 'already_current', 'adopted_pilot'].includes(candidate.result)
          && Boolean(candidate.active_artifact_hash)
          && Boolean(candidate.desired_artifact_hash)
          && secureEqual(candidate.active_artifact_hash, state.bundle.artifact_hash)
          && secureEqual(candidate.desired_artifact_hash, state.bundle.artifact_hash);
      } else if (report.event === 'sync_result' && state.status === 'retired') {
        confirmed = candidate.status === 'retired'
          && !candidate.error_code
          && candidate.result === 'retired'
          && !candidate.desired_artifact_hash;
      }
      routeConfirmations[publication.id] = confirmed;
    }
    confirmsDesired = desiredStates.length > 0
      && desiredStates.every((state) => state.status !== 'pending' && routeConfirmations[state.publication.id] === true);
  } else {
    desired = await publicationDesiredState(installation, { models, env }).catch((error) => {
      if (
        error?.code === 'web_installation_publication_not_configured'
        || error?.code === 'web_installation_artifact_not_ready'
        || error?.code === 'web_installation_publication_ambiguous'
      ) {
        return null;
      }
      throw error;
    });
    const expectedDesiredHash = desired?.status === 'published' ? desired.bundle.artifact_hash : null;
    confirmsPublished = report.event === 'sync_result'
      && report.status === 'active'
      && report.active_artifact_hash
      && expectedDesiredHash
      && secureEqual(report.active_artifact_hash, expectedDesiredHash)
      && (!report.desired_artifact_hash || secureEqual(report.desired_artifact_hash, expectedDesiredHash));
    reportsRetired = report.event === 'sync_result'
      && report.status === 'retired'
      && !report.desired_artifact_hash;
    confirmsDesired = Boolean(confirmsPublished || (reportsRetired && desired?.status === 'retired'));
  }
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
      const lockedAuthentication = validateLockedInstallationAuthentication({
        locked,
        tokenSlot: authenticatedTokenSlot,
        tokenDigest: authenticatedTokenDigest,
      });
      const promotesStagedToken = authenticatedTokenSlot === 'next'
        && lockedAuthentication.nextTokenIsUsable
        && reportCanPromoteStagedToken;
      if (
        report.schema_version === 2
        && report.event === 'sync_result'
        && Number(report.registry_sequence) !== Number(locked.desiredSequence || 0)
      ) {
        throw new WebPublicationServiceError(
          'web_installation_report_sequence_mismatch',
          'El reporte corresponde a un registro de publicación anterior.',
          409
        );
      }
      const currentSigningDescriptor = report.schema_version === 2
        && report.event === 'sync_result'
        && report.signing_key_id
        ? pluginKeyDescriptor(signingOptions)
        : null;
      let promotesSigningKey = false;
      if (
        report.schema_version === 2
        && report.event === 'sync_result'
        && report.signing_key_id
        && secureEqual(report.signing_key_id, currentSigningDescriptor.key_id)
        && Number(report.configuration_sequence) === Number(locked.desiredSequence || 0)
        && confirmsDesired
      ) {
        // Re-read and lock the publication set inside the same transaction as
        // publicKeyId promotion. This prevents a report that was exact before
        // a concurrent route change from acknowledging the new signing key.
        const lockedDesiredStates = await publicationDesiredStates(locked, {
          models,
          env,
          transaction,
          lock: true,
        });
        const lockedExpectedIds = lockedDesiredStates.map((state) => String(state.publication.id)).sort();
        const lockedReportedIds = Object.keys(report.routes).sort();
        let lockedConfirmsDesired = lockedDesiredStates.length > 0
          && canonicalSerialize(lockedExpectedIds) === canonicalSerialize(lockedReportedIds);
        for (const state of lockedDesiredStates) {
          const publication = plain(state.publication);
          const candidate = report.routes[publication.id];
          if (!candidate || candidate.route_prefix !== publication.path || state.status === 'pending') {
            lockedConfirmsDesired = false;
            break;
          }
          if (state.status === 'published') {
            lockedConfirmsDesired = lockedConfirmsDesired
              && candidate.status === 'active'
              && !candidate.error_code
              && ['activated', 'already_current', 'adopted_pilot'].includes(candidate.result)
              && Boolean(candidate.active_artifact_hash)
              && Boolean(candidate.desired_artifact_hash)
              && secureEqual(candidate.active_artifact_hash, state.bundle.artifact_hash)
              && secureEqual(candidate.desired_artifact_hash, state.bundle.artifact_hash);
          } else if (state.status === 'retired') {
            lockedConfirmsDesired = lockedConfirmsDesired
              && candidate.status === 'retired'
              && !candidate.error_code
              && candidate.result === 'retired'
              && !candidate.desired_artifact_hash;
          } else {
            lockedConfirmsDesired = false;
          }
          if (!lockedConfirmsDesired) break;
        }
        promotesSigningKey = lockedConfirmsDesired
          && !secureEqual(locked.publicKeyId, currentSigningDescriptor.key_id);
      } else if (
        report.schema_version === 2
        && report.event === 'sync_result'
        && confirmsDesired
        && report.signing_key_id
        && !secureEqual(report.signing_key_id, currentSigningDescriptor.key_id)
      ) {
        throw new WebPublicationServiceError(
          'web_installation_report_signing_key_mismatch',
          'El reporte confirma una clave distinta de la configuración activa.',
          409
        );
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
      const claimsSite = locked.status === 'pending';
      if (claimsSite) {
        const lockedExpiry = locked.siteClaimExpiresAt ? new Date(locked.siteClaimExpiresAt) : null;
        if (
          !siteClaimProof
          || !lockedExpiry
          || !Number.isFinite(lockedExpiry.getTime())
          || lockedExpiry <= new Date()
          || !secureEqual(locked.siteClaimTokenHash, siteClaimProof.claim_token_hash)
          || !secureEqual(lockedSite.site_url, siteClaimProof.site_url)
          || !secureEqual(sha256(lockedSite.site_url), siteClaimProof.site_url_hash)
        ) {
          throw new WebPublicationServiceError(
            'web_wordpress_site_claim_changed',
            'La prueba de control cambió durante la verificación. Descarga de nuevo el plugin.',
            409
          );
        }
      } else {
        assertInstallationSiteClaimed(locked);
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
      const previousConfirmedRoutes = locked.reportedState?.confirmed_routes
        && typeof locked.reportedState.confirmed_routes === 'object'
        ? locked.reportedState.confirmed_routes
        : {};
      const previousSigningKeyHistory = Array.isArray(locked.reportedState?.signing_key_history)
        ? locked.reportedState.signing_key_history
            .map((keyId) => String(keyId || '').trim())
            .filter((keyId) => /^ed25519-[a-f0-9]{16}$/.test(keyId))
        : [];
      const signingKeyHistory = promotesSigningKey
        ? [...new Set([...previousSigningKeyHistory, String(locked.publicKeyId || '')])]
            .filter((keyId) => /^ed25519-[a-f0-9]{16}$/.test(keyId))
            .slice(-32)
        : previousSigningKeyHistory;
      let confirmedRoutes = previousConfirmedRoutes;
      if (report.schema_version === 2 && report.event === 'sync_result') {
        const releasedTombstones = Object.fromEntries(Object.entries(previousConfirmedRoutes)
          .filter(([, acknowledgement]) => acknowledgement?.status === 'retired'));
        confirmedRoutes = {
          ...releasedTombstones,
          ...Object.fromEntries(Object.entries(routeConfirmations)
          .filter(([, confirmed]) => confirmed === true)
          .map(([publicationId]) => {
            const candidate = report.routes[publicationId];
            return [publicationId, {
              registry_sequence: report.registry_sequence,
              status: candidate.status,
              artifact_hash: candidate.status === 'active' ? candidate.active_artifact_hash : null,
              route_prefix: candidate.route_prefix,
              confirmed_at: report.reported_at,
            }];
          })),
        };
      } else if (report.schema_version === 2 && report.event === 'local_rollback') {
        confirmedRoutes = Object.fromEntries(Object.entries(previousConfirmedRoutes).filter(([publicationId, ack]) => {
          const candidate = report.routes[publicationId];
          if (ack?.status === 'retired') return !candidate || candidate.status === 'retired';
          return candidate
            && candidate.status === 'active'
            && candidate.route_prefix === ack.route_prefix
            && candidate.active_artifact_hash === ack.artifact_hash;
        }));
      }
      const reportedState = {
        schema_version: report.schema_version,
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
        signing_key_id: report.signing_key_id,
        configuration_sequence: report.configuration_sequence,
        signing_key_history: signingKeyHistory,
        ...(report.schema_version === 2 ? {
          registry_sequence: report.registry_sequence,
          routes: report.routes,
          route_confirmations: routeConfirmations,
          confirmed_routes: confirmedRoutes,
        } : {}),
      };
      const pilotReport = report.schema_version === 2
        ? Object.values(report.routes).find((route) => route.route_prefix === '/cita/')
        : null;
      const previousSiteHash = locked.siteUrlHash;
      const previousTokenPrefix = locked.tokenPrefix;
      const promotedTokenPrefix = locked.nextTokenPrefix;
      await locked.update({
        ...(repairsSite ? {
          siteUrl: lockedSite.site_url,
          siteUrlHash: sha256(lockedSite.site_url),
        } : {}),
        ...(claimsSite ? {
          claimedSiteHash: siteClaimProof.site_url_hash,
          siteClaimTokenHash: null,
          siteClaimIssuedAt: null,
          siteClaimExpiresAt: null,
          siteClaimedAt: new Date(),
        } : {}),
        ...(repairsSite || claimsSite || promotesStagedToken || promotesSigningKey
          ? { version: Number(locked.version) + 1 }
          : {}),
        ...(promotesStagedToken ? {
          tokenHash: locked.nextTokenHash,
          tokenPrefix: locked.nextTokenPrefix,
          nextTokenHash: null,
          nextTokenPrefix: null,
          nextTokenIssuedAt: null,
          nextTokenExpiresAt: null,
        } : {}),
        ...(promotesSigningKey ? { publicKeyId: currentSigningDescriptor.key_id } : {}),
        status: reportsPluginDowngrade
          ? 'outdated'
          : (locked.status === 'outdated' && !confirmsDesired ? 'outdated' : 'connected'),
        pluginVersion: report.plugin_version,
        capabilities: report.schema_version === 2
          ? report.capabilities
          : (reportsPluginDowngrade ? {} : locked.capabilities),
        reportedState,
        lastSeenAt: new Date(),
        ...(report.schema_version === 2 && report.event === 'sync_result'
          ? (pilotReport?.status === 'active'
            ? { lastArtifactHash: pilotReport.active_artifact_hash }
            : pilotReport?.status === 'retired'
              ? { lastArtifactHash: null }
              : {})
          : confirmsPublished
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
      if (claimsSite) {
        await models.WebAuditEvent.create({
          projectId: null,
          ...scopeColumns(scope),
          actorUserId: null,
          eventType: 'web.wordpress_installation.site_claimed',
          entityType: 'web_wordpress_installation',
          entityId: locked.id,
          requestId: requestId || report.request_id,
          metadata: {
            site_url_hash: siteClaimProof.site_url_hash,
            plugin_version: report.plugin_version,
          },
        }, { transaction });
      }
      if (promotesStagedToken) {
        await models.WebAuditEvent.create({
          projectId: null,
          ...scopeColumns(scope),
          actorUserId: null,
          eventType: 'web.wordpress_installation.token_rotation_promoted',
          entityType: 'web_wordpress_installation',
          entityId: locked.id,
          requestId: requestId || report.request_id,
          metadata: {
            previous_token_prefix: previousTokenPrefix,
            token_prefix: promotedTokenPrefix,
            plugin_version: report.plugin_version,
          },
        }, { transaction });
      }
      if (promotesSigningKey) {
        await models.WebAuditEvent.create({
          projectId: null,
          ...scopeColumns(scope),
          actorUserId: null,
          eventType: 'web.wordpress_installation.signing_key_rotation_promoted',
          entityType: 'web_wordpress_installation',
          entityId: locked.id,
          requestId: requestId || report.request_id,
          metadata: {
            previous_public_key_id: installation.publicKeyId,
            public_key_id: currentSigningDescriptor.key_id,
            registry_sequence: report.registry_sequence,
            plugin_version: report.plugin_version,
          },
        }, { transaction });
      }
      await models.WebAuditEvent.create({
        projectId: report.schema_version === 1 ? (desired?.publication?.projectId || null) : null,
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
          ...(report.schema_version === 2 ? { confirmed_routes: routeConfirmations } : {}),
          plugin_version: report.plugin_version,
        },
      }, { transaction });
      return locked;
    });
  } catch (error) {
    if (error?.name === 'SequelizeUniqueConstraintError') {
      throw new WebPublicationServiceError(
        'web_wordpress_site_claim_conflict',
        'Ese WordPress ya está controlado por otra instalación de ClinicaClick.',
        409
      );
    }
    throw error;
  }
  return {
    accepted: true,
    site_claim_acknowledged: updated.status === 'connected' || updated.status === 'outdated',
    confirms_desired: Boolean(confirmsDesired),
    ...(report.schema_version === 2 ? { route_confirmations: routeConfirmations } : {}),
    installation: serializeInstallation(updated),
  };
}

module.exports = {
  AUTHENTICATED_ARTIFACT_CACHE_MAX_BYTES,
  AUTHENTICATED_ARTIFACT_CACHE_MAX_ENTRY_BYTES,
  INSTALLATION_TOKEN_PREFIX,
  MAX_REPORT_BYTES,
  MAX_WORDPRESS_V2_CONTROL_BYTES,
  MAX_WORDPRESS_V2_DOWNLOAD_REQUESTS,
  MAX_WORDPRESS_V2_UNIQUE_FILES,
  REPORT_EVENTS,
  WORDPRESS_V2_ARTIFACT_RATE_LIMIT,
  assertV2TransportBudget,
  authorizedArtifactForInstallation,
  authenticateInstallation,
  assertInstallationSiteClaimed,
  bearerToken,
  clearAuthenticatedArtifactCache,
  createInstallation,
  getDesiredState,
  getAuthenticatedArtifactResource,
  getInstallationForActor,
  intakeConfigForInstallation,
  issueInstallationToken,
  issueSiteClaimToken,
  installationApiBase,
  listInstallations,
  measurementFromIntake,
  matchReportedSite,
  normalizeReport,
  pluginKeyDescriptor,
  publicationDesiredState,
  publicationDesiredStates,
  recordReport,
  revokeInstallation,
  rotateInstallationToken,
  safeImmutableStorage,
  serializeInstallation,
  signingKeyTransitionForInstallation,
  siteClaimTtlSeconds,
  tokenHash,
};
