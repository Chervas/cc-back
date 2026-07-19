'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const db = require('../../models');
const publicMediaStorage = require('./publicMediaStorage.service');
const { canonicalSerialize } = require('../lib/webDocument');
const {
  WEB_CONTENT_STATUSES,
  WEB_CONTENT_TYPES,
  isSafePublicAssetUrl,
  projectSafeMediaMetadata,
  projectSafeMediaRights,
  projectSafeMediaVariants,
  publicMediaIsAuthorizedForWeb,
  validateWebContentEntry,
  validateWebMediaPresentation,
} = require('../lib/webContent');
const {
  assertScopeAccess,
  groupIdForClinic,
  normalizeScope,
  positiveInteger,
  scopeColumns,
} = require('./webProjects.service');

const DEFAULT_PAGE_SIZE = 24;
const MAX_PAGE_SIZE = 100;
const MAX_MEDIA_ID_FILTER = 100;
const ALLOWED_MEDIA_MIME = /^image\/(?:jpeg|png|webp)$/i;
const WEB_MEDIA_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PAGE_NUMBER = 10000;
const QUARANTINE_CLEANUP_LEASE_MS = 15 * 60 * 1000;

class WebContentMediaServiceError extends Error {
  constructor(code, message, status = 400, details = undefined) {
    super(message);
    this.name = 'WebContentMediaServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function plain(row) {
  return row?.get ? row.get({ plain: true }) : row;
}

function boundedInteger(value, fallback, maximum) {
  const parsed = positiveInteger(value);
  return Math.min(parsed || fallback, maximum);
}

function scopeFromResource(value) {
  return value.scopeType === 'clinic'
    ? { type: 'clinic', id: Number(value.clinicaId) }
    : { type: 'group', id: Number(value.grupoClinicaId) };
}

async function assertResourceScopeAccess(actorId, scope, featureKey, notFoundCode, notFoundMessage, options = {}) {
  try {
    await assertScopeAccess(actorId, scope, featureKey, options);
  } catch (error) {
    if (Number(error?.status) === 403) {
      throw new WebContentMediaServiceError(notFoundCode, notFoundMessage, 404);
    }
    throw error;
  }
}

async function assertOwnerOrReviewer(actorId, ownerUserId, scope, options = {}) {
  if (positiveInteger(actorId) === positiveInteger(ownerUserId)) return true;
  try {
    await assertScopeAccess(actorId, scope, 'marketing.web.review', options);
    return true;
  } catch (error) {
    if (Number(error?.status) === 403) {
      throw new WebContentMediaServiceError(
        'web_resource_author_forbidden',
        'Solo el autor o una persona revisora puede modificar este recurso.',
        403
      );
    }
    throw error;
  }
}

function booleanQuery(value) {
  return value === true || String(value || '').trim().toLowerCase() === 'true';
}

function normalizeMediaIdFilter(value) {
  if (value === undefined || value === null) return null;
  const rawValues = Array.isArray(value) ? value : [value];
  const serializedLength = rawValues.reduce((total, item) => total + String(item ?? '').length, 0);
  if (serializedLength > MAX_MEDIA_ID_FILTER * 65) {
    throw new WebContentMediaServiceError(
      'media_ids_filter_too_large',
      `Se pueden consultar hasta ${MAX_MEDIA_ID_FILTER} medios a la vez.`
    );
  }
  const ids = rawValues
    .flatMap((item) => String(item ?? '').split(','))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  if (!ids.length) {
    throw new WebContentMediaServiceError('media_ids_filter_empty', 'El filtro ids no puede estar vacío.');
  }
  if (ids.length > MAX_MEDIA_ID_FILTER) {
    throw new WebContentMediaServiceError(
      'media_ids_filter_too_large',
      `Se pueden consultar hasta ${MAX_MEDIA_ID_FILTER} medios a la vez.`
    );
  }
  if (ids.some((id) => !WEB_MEDIA_ID_PATTERN.test(id))) {
    throw new WebContentMediaServiceError(
      'media_ids_filter_invalid',
      'El filtro ids contiene un identificador de medio no válido.'
    );
  }
  return [...new Set(ids)];
}

function hashValue(value) {
  return crypto.createHash('sha256').update(canonicalSerialize(value), 'utf8').digest('hex');
}

function assertMediaRightsCurrent(rights, status = 'ready') {
  if (status !== 'ready' || !rights?.expires_at) return;
  if (Date.parse(rights.expires_at) <= Date.now()) {
    throw new WebContentMediaServiceError(
      'media_rights_expired',
      'Los derechos de este medio han caducado; archívalo o actualiza la autorización.',
      422
    );
  }
}

function serializeScope(row, requestedScope = null) {
  const value = plain(row);
  const id = value.scopeType === 'clinic' ? value.clinicaId : value.grupoClinicaId;
  return {
    type: value.scopeType,
    id: Number(id),
    inherited: Boolean(
      requestedScope
      && requestedScope.type === 'clinic'
      && value.scopeType === 'group'
    ),
  };
}

function serializeContentEntry(row, options = {}) {
  const value = plain(row);
  const scope = serializeScope(value, options.requestedScope);
  const canEdit = !scope.inherited && (
    options.canEdit === undefined
      ? true
      : Boolean(options.canEdit)
  );
  return {
    id: value.id,
    scope,
    can_edit: canEdit,
    read_only: !canEdit,
    owner_user_id: value.ownerUserId || null,
    type: value.type,
    locale: value.locale,
    title: value.title,
    content: value.content,
    sources: value.sources || [],
    content_hash: value.contentHash,
    status: value.status,
    version: Number(value.version),
    created_by_user_id: value.createdByUserId || null,
    updated_by_user_id: value.updatedByUserId || null,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

function serializeContentVersion(row) {
  const value = plain(row);
  return {
    id: value.id,
    content_entry_id: value.contentEntryId,
    version: Number(value.version),
    type: value.type,
    locale: value.locale,
    title: value.title,
    content: value.content,
    sources: value.sources || [],
    content_hash: value.contentHash,
    status: value.status,
    actor_user_id: value.actorUserId || null,
    created_at: value.created_at,
  };
}

function publicMediaProjection(row, webMedia = null) {
  const value = plain(row);
  if (!value) return null;
  const authorized = webMedia && publicMediaIsAuthorizedForWeb(webMedia, value);
  if (!authorized) return null;
  return {
    id: Number(value.id),
    url: value.public_url,
    content_type: value.content_type,
    size_bytes: Number(value.size_bytes || 0),
  };
}

function serializeMediaAsset(row, options = {}) {
  const value = plain(row);
  const publicAsset = value.publicMediaAsset || value.public_media_asset || options.publicMediaAsset || null;
  const scope = serializeScope(value, options.requestedScope);
  const canEdit = !scope.inherited && (
    options.canEdit === undefined
      ? true
      : Boolean(options.canEdit)
  );
  return {
    id: value.id,
    scope,
    can_edit: canEdit,
    read_only: !canEdit,
    owner_user_id: value.ownerUserId || null,
    public_media: publicMediaProjection(publicAsset, value),
    title: value.title,
    kind: value.kind,
    status: value.status,
    alt_text: value.altText,
    decorative: Boolean(value.decorative),
    focal_points: value.focalPoints || {},
    rights: projectSafeMediaRights(value.rights),
    variants: projectSafeMediaVariants(value.variants),
    metadata: projectSafeMediaMetadata(value.mediaMetadata),
    version: Number(value.version),
    created_by_user_id: value.createdByUserId || null,
    updated_by_user_id: value.updatedByUserId || null,
    created_at: value.created_at,
    updated_at: value.updated_at,
  };
}

async function readScopeWhere(scope, includeInheritedGroup, models, transaction = undefined) {
  const exact = scope.type === 'clinic'
    ? { scopeType: 'clinic', clinicaId: scope.id }
    : { scopeType: 'group', grupoClinicaId: scope.id };
  if (scope.type !== 'clinic' || !includeInheritedGroup) return exact;
  const groupId = await groupIdForClinic(scope.id, { models, transaction });
  if (!groupId) return exact;
  return {
    [Op.or]: [
      exact,
      { scopeType: 'group', grupoClinicaId: groupId },
    ],
  };
}

async function canAccessScopeFeature(actorId, scope, featureKey, options = {}) {
  try {
    await assertScopeAccess(actorId, scope, featureKey, options);
    return true;
  } catch (error) {
    if (Number(error?.status) === 403) return false;
    throw error;
  }
}

async function resolveLibraryCapabilities(actorId, scope, options = {}) {
  const [canEdit, canReview] = await Promise.all([
    canAccessScopeFeature(actorId, scope, 'marketing.web.edit', options),
    canAccessScopeFeature(actorId, scope, 'marketing.web.review', options),
  ]);
  return {
    can_create: canEdit,
    can_edit_own: canEdit,
    can_review: canEdit && canReview,
  };
}

function canEditLibraryResource(row, actorId, capabilities, requestedScope) {
  const value = plain(row);
  const scope = serializeScope(value, requestedScope);
  if (scope.inherited || !capabilities.can_edit_own) return false;
  return positiveInteger(value.ownerUserId) === positiveInteger(actorId)
    || capabilities.can_review;
}

async function audit({ models, transaction, scope, actorId, requestId, eventType, entityType, entityId, previousHash, nextHash, metadata }) {
  await models.WebAuditEvent.create({
    projectId: null,
    ...scopeColumns(scope),
    actorUserId: positiveInteger(actorId),
    eventType,
    entityType,
    entityId,
    requestId,
    previousHash: previousHash || null,
    nextHash: nextHash || null,
    metadata: metadata || {},
  }, { transaction });
}

async function persistContentVersion({ entry, actorId, models, transaction }) {
  const value = plain(entry);
  return models.WebContentEntryVersion.create({
    id: crypto.randomUUID(),
    contentEntryId: value.id,
    version: Number(value.version),
    type: value.type,
    locale: value.locale,
    title: value.title,
    content: value.content,
    sources: value.sources || [],
    contentHash: value.contentHash,
    status: value.status,
    actorUserId: positiveInteger(actorId),
  }, { transaction });
}

async function listContent({ actorId, query = {}, models = db, assertFeatureAccess } = {}) {
  const scope = normalizeScope(query);
  await assertScopeAccess(actorId, scope, 'marketing.web.view', { models, assertFeatureAccess });
  const capabilities = await resolveLibraryCapabilities(actorId, scope, { models, assertFeatureAccess });
  const page = boundedInteger(query.page, 1, MAX_PAGE_NUMBER);
  const limit = boundedInteger(query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const includeInheritedGroup = booleanQuery(query.include_inherited_group);
  const status = String(query.status || '').trim().toLowerCase();
  const type = String(query.type || '').trim().toLowerCase();
  const locale = String(query.locale || '').trim();
  const search = String(query.search || '').trim().slice(0, 120);
  if (status && !WEB_CONTENT_STATUSES.includes(status)) {
    throw new WebContentMediaServiceError('invalid_content_status', 'El estado de contenido no es válido.');
  }
  if (type && !WEB_CONTENT_TYPES.includes(type)) {
    throw new WebContentMediaServiceError('invalid_content_type', 'El tipo de contenido no es válido.');
  }
  if (locale && !/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(locale)) {
    throw new WebContentMediaServiceError('invalid_content_locale', 'El locale no es válido.');
  }
  const scopeWhere = await readScopeWhere(scope, includeInheritedGroup, models);
  const where = {
    ...scopeWhere,
    ...(status ? { status } : {}),
    ...(type ? { type } : {}),
    ...(locale ? { locale } : {}),
    ...(search ? { title: { [Op.like]: `%${search}%` } } : {}),
  };
  const result = await models.WebContentEntry.findAndCountAll({
    where,
    order: [['updated_at', 'DESC'], ['id', 'ASC']],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });
  const total = Number(result.count || 0);
  return {
    scope: { type: scope.type, id: scope.id },
    capabilities,
    items: (result.rows || []).map((row) => serializeContentEntry(row, {
      requestedScope: scope,
      canEdit: canEditLibraryResource(row, actorId, capabilities, scope),
    })),
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  };
}

async function createContent({
  actorId,
  body = {},
  requestId = null,
  models = db,
  sequelize = db.sequelize,
  transaction: outerTransaction = null,
  assertFeatureAccess = undefined,
} = {}) {
  const scope = normalizeScope(body);
  await assertScopeAccess(actorId, scope, 'marketing.web.edit', {
    models,
    transaction: outerTransaction || undefined,
    assertFeatureAccess,
  });
  if (body.status !== undefined && String(body.status).trim().toLowerCase() !== 'draft') {
    throw new WebContentMediaServiceError(
      'content_create_requires_draft',
      'Una entrada nueva se crea como borrador antes de enviarla a revisión.',
      422
    );
  }
  const normalized = validateWebContentEntry(body);
  const createWithinTransaction = async (transaction) => {
    const entry = await models.WebContentEntry.create({
      id: crypto.randomUUID(),
      ...scopeColumns(scope),
      ownerUserId: positiveInteger(actorId),
      type: normalized.type,
      locale: normalized.locale,
      title: normalized.title,
      content: normalized.content,
      sources: normalized.sources,
      contentHash: normalized.hash,
      status: 'draft',
      version: 1,
      createdByUserId: positiveInteger(actorId),
      updatedByUserId: positiveInteger(actorId),
    }, { transaction });
    await persistContentVersion({ entry, actorId, models, transaction });
    await audit({
      models,
      transaction,
      scope,
      actorId,
      requestId,
      eventType: 'web.content.created',
      entityType: 'web_content_entry',
      entityId: entry.id,
      nextHash: entry.contentHash,
      metadata: { version: 1, type: entry.type, status: entry.status },
    });
    return serializeContentEntry(entry, { requestedScope: scope });
  };
  if (outerTransaction) return createWithinTransaction(outerTransaction);
  return sequelize.transaction(createWithinTransaction);
}

const CONTENT_TRANSITIONS = Object.freeze({
  draft: new Set(['draft', 'review', 'archived']),
  review: new Set(['draft', 'review', 'published', 'archived']),
  published: new Set(['published', 'review', 'archived']),
  archived: new Set(['archived', 'draft']),
});

async function updateContent({ actorId, contentId, body = {}, requestId = null, models = db, sequelize = db.sequelize } = {}) {
  const expectedVersion = positiveInteger(body.version ?? body.expected_version);
  if (!expectedVersion) {
    throw new WebContentMediaServiceError('content_version_required', 'version es obligatorio para actualizar.', 428);
  }
  return sequelize.transaction(async (transaction) => {
    const entry = await models.WebContentEntry.findByPk(String(contentId || ''), {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!entry) throw new WebContentMediaServiceError('content_not_found', 'La entrada no existe.', 404);
    const value = plain(entry);
    const scope = scopeFromResource(value);
    await assertResourceScopeAccess(
      actorId,
      scope,
      'marketing.web.edit',
      'content_not_found',
      'La entrada no existe.',
      { models, transaction }
    );
    await assertOwnerOrReviewer(actorId, value.ownerUserId, scope, { models, transaction });
    if (Number(value.version) !== expectedVersion) {
      throw new WebContentMediaServiceError(
        'content_conflict',
        'El contenido cambió en otra sesión. Recarga antes de guardar.',
        409,
        { expected_version: expectedVersion, current_version: Number(value.version) }
      );
    }
    if (body.type !== undefined && String(body.type).trim().toLowerCase() !== value.type) {
      throw new WebContentMediaServiceError('content_type_immutable', 'El tipo de una entrada existente no se puede cambiar.', 422);
    }
    const dataChanged = ['title', 'locale', 'content', 'sources'].some((field) => body[field] !== undefined);
    let targetStatus = body.status === undefined ? value.status : String(body.status || '').trim().toLowerCase();
    if (!WEB_CONTENT_STATUSES.includes(targetStatus)) {
      throw new WebContentMediaServiceError('invalid_content_status', 'El estado solicitado no es válido.', 422);
    }
    if (value.status === 'published' && dataChanged) {
      if (body.status !== undefined && targetStatus !== 'review') {
        throw new WebContentMediaServiceError(
          'published_content_requires_review',
          'Editar contenido publicado crea una versión pendiente de revisión.',
          409
        );
      }
      targetStatus = 'review';
    }
    if (!CONTENT_TRANSITIONS[value.status]?.has(targetStatus)) {
      throw new WebContentMediaServiceError(
        'invalid_content_transition',
        `No se puede pasar de ${value.status} a ${targetStatus}.`,
        409
      );
    }
    if (['published', 'archived'].includes(targetStatus) && targetStatus !== value.status) {
      await assertScopeAccess(actorId, scope, 'marketing.web.review', { models, transaction });
    }
    if (!dataChanged && targetStatus === value.status) {
      throw new WebContentMediaServiceError('empty_content_patch', 'No hay cambios válidos que guardar.');
    }
    const normalized = validateWebContentEntry({
      type: value.type,
      locale: body.locale ?? value.locale,
      title: body.title ?? value.title,
      content: body.content ?? value.content,
      sources: body.sources ?? value.sources,
    });
    const previousHash = value.contentHash;
    await entry.update({
      locale: normalized.locale,
      title: normalized.title,
      content: normalized.content,
      sources: normalized.sources,
      contentHash: normalized.hash,
      status: targetStatus,
      version: expectedVersion + 1,
      updatedByUserId: positiveInteger(actorId),
    }, { transaction });
    await persistContentVersion({ entry, actorId, models, transaction });
    await audit({
      models,
      transaction,
      scope,
      actorId,
      requestId,
      eventType: 'web.content.updated',
      entityType: 'web_content_entry',
      entityId: entry.id,
      previousHash,
      nextHash: entry.contentHash,
      metadata: {
        previous_version: expectedVersion,
        next_version: Number(entry.version),
        previous_status: value.status,
        next_status: entry.status,
      },
    });
    return serializeContentEntry(entry, { requestedScope: scope });
  });
}

async function listContentVersions({ actorId, contentId, query = {}, models = db } = {}) {
  const entry = await models.WebContentEntry.findByPk(String(contentId || ''));
  if (!entry) throw new WebContentMediaServiceError('content_not_found', 'La entrada no existe.', 404);
  const value = plain(entry);
  const scope = scopeFromResource(value);
  await assertResourceScopeAccess(
    actorId,
    scope,
    'marketing.web.view',
    'content_not_found',
    'La entrada no existe.',
    { models }
  );
  const page = boundedInteger(query.page, 1, MAX_PAGE_NUMBER);
  const limit = boundedInteger(query.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const result = await models.WebContentEntryVersion.findAndCountAll({
    where: { contentEntryId: entry.id },
    order: [['version', 'DESC']],
    limit,
    offset: (page - 1) * limit,
  });
  const total = Number(result.count || 0);
  return {
    items: (result.rows || []).map(serializeContentVersion),
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  };
}

function assertPublicMediaUsable(publicAsset, scope, options = {}) {
  const value = plain(publicAsset);
  const sameScope = value && value.scope_type === scope.type
    && Number(scope.type === 'clinic' ? value.clinica_id : value.grupo_clinica_id) === scope.id;
  if (!value || !sameScope) {
    throw new WebContentMediaServiceError(
      'public_media_not_accessible',
      'El medio público no existe o no está disponible en este alcance.',
      404
    );
  }
  const metadata = value.metadata && typeof value.metadata === 'object' ? value.metadata : {};
  const active = value.status === 'active' && value.sensitivity === 'public';
  const quarantine = value.status === 'quarantine'
    && value.sensitivity === 'internal'
    && value.purpose === 'web_editor_media';
  if (
    (!active && !quarantine)
    || metadata.non_clinical_asserted !== true
    || metadata.patient_data_in_public_media === true
    || metadata.patient_name_present === true
  ) {
    throw new WebContentMediaServiceError(
      'public_media_not_eligible',
      'El medio no está autorizado como recurso público no clínico.',
      422
    );
  }
  if (quarantine) {
    const expiresAt = Date.parse(metadata.quarantine_expires_at || '');
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
      throw new WebContentMediaServiceError(
        'web_editor_media_quarantine_expired',
        'La subida temporal ha caducado. Vuelve a subir el archivo.',
        410
      );
    }
  }
  if (
    positiveInteger(options.actorId) !== positiveInteger(value.created_by)
    && options.allowReviewer !== true
  ) {
    throw new WebContentMediaServiceError(
      'web_resource_author_forbidden',
      'Solo quien subió el medio o una persona revisora puede registrarlo.',
      403
    );
  }
  if (!isSafePublicAssetUrl(value.public_url)) {
    throw new WebContentMediaServiceError(
      'public_media_url_not_eligible',
      'El medio debe usar una URL pública https estable y sin credenciales.',
      422
    );
  }
  if (!ALLOWED_MEDIA_MIME.test(String(value.content_type || ''))) {
    throw new WebContentMediaServiceError('public_media_type_not_supported', 'El formato del medio no está soportado.', 422);
  }
  return value;
}

function sanitizeVariants(publicAsset) {
  const metadata = publicAsset.metadata && typeof publicAsset.metadata === 'object' ? publicAsset.metadata : {};
  const image = metadata.image && typeof metadata.image === 'object' ? metadata.image : {};
  const variants = [{
    key: 'original',
    url: publicAsset.public_url,
    content_type: publicAsset.content_type,
    width: positiveInteger(image.output_width ?? image.width),
    height: positiveInteger(image.output_height ?? image.height),
  }];
  const candidates = Array.isArray(metadata.variants) ? metadata.variants.slice(0, 29) : [];
  for (const item of candidates) {
    if (!item || typeof item !== 'object') continue;
    const url = String(item.url || item.public_url || '').trim();
    const contentType = String(item.content_type || '').trim().toLowerCase();
    if (!isSafePublicAssetUrl(url) || !ALLOWED_MEDIA_MIME.test(contentType)) continue;
    const requestedKey = String(item.key || '').trim().toLowerCase();
    const safeKey = /^[a-z0-9][a-z0-9_-]{0,63}$/.test(requestedKey)
      ? requestedKey
      : `variant-${variants.length}`;
    variants.push({
      key: safeKey,
      url,
      content_type: contentType,
      width: positiveInteger(item.width),
      height: positiveInteger(item.height),
    });
  }
  return variants;
}

function sanitizeMediaMetadata(publicAsset) {
  const metadata = publicAsset.metadata && typeof publicAsset.metadata === 'object' ? publicAsset.metadata : {};
  const image = metadata.image && typeof metadata.image === 'object' ? metadata.image : {};
  return {
    content_type: publicAsset.content_type,
    size_bytes: Number(publicAsset.size_bytes || 0),
    width: positiveInteger(image.output_width ?? image.width),
    height: positiveInteger(image.output_height ?? image.height),
  };
}

async function registerMedia({ actorId, body = {}, requestId = null, models = db, sequelize = db.sequelize } = {}) {
  const scope = normalizeScope(body);
  await assertScopeAccess(actorId, scope, 'marketing.web.edit', { models });
  const publicMediaAssetId = positiveInteger(body.public_media_asset_id);
  if (!publicMediaAssetId) {
    throw new WebContentMediaServiceError('public_media_asset_id_required', 'public_media_asset_id es obligatorio.');
  }
  const presentation = validateWebMediaPresentation(body);
  assertMediaRightsCurrent(presentation.rights);
  return sequelize.transaction(async (transaction) => {
    const publicAssetRow = await models.PublicMediaAsset.findByPk(publicMediaAssetId, {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    let reviewer = false;
    if (
      publicAssetRow
      && positiveInteger(plain(publicAssetRow).created_by) !== positiveInteger(actorId)
    ) {
      try {
        await assertScopeAccess(actorId, scope, 'marketing.web.review', { models, transaction });
        reviewer = true;
      } catch (error) {
        if (Number(error?.status) !== 403) throw error;
      }
    }
    const publicAsset = assertPublicMediaUsable(publicAssetRow, scope, {
      actorId,
      allowReviewer: reviewer,
    });
    const existing = await models.WebMediaAsset.findOne({
      where: { publicMediaAssetId },
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (existing) {
      throw new WebContentMediaServiceError('media_already_registered', 'El medio ya está registrado en la biblioteca.', 409, {
        media_id: existing.id,
      });
    }
    const kind = 'image';
    const variants = sanitizeVariants(publicAsset);
    const mediaMetadata = sanitizeMediaMetadata(publicAsset);
    const asset = await models.WebMediaAsset.create({
      id: crypto.randomUUID(),
      ...scopeColumns(scope),
      publicMediaAssetId,
      ownerUserId: positiveInteger(actorId),
      title: presentation.title,
      kind,
      status: 'ready',
      altText: presentation.alt_text,
      decorative: presentation.decorative,
      focalPoints: presentation.focal_points,
      rights: presentation.rights,
      variants,
      mediaMetadata,
      version: 1,
      createdByUserId: positiveInteger(actorId),
      updatedByUserId: positiveInteger(actorId),
    }, { transaction });
    if (publicAsset.status === 'quarantine') {
      const metadata = publicAsset.metadata && typeof publicAsset.metadata === 'object'
        ? publicAsset.metadata
        : {};
      await publicAssetRow.update({
        status: 'active',
        sensitivity: 'public',
        metadata: {
          ...metadata,
          quarantine_expires_at: null,
          activated_at: new Date().toISOString(),
          activated_by: positiveInteger(actorId),
        },
      }, { transaction });
    }
    await audit({
      models,
      transaction,
      scope,
      actorId,
      requestId,
      eventType: 'web.media.registered',
      entityType: 'web_media_asset',
      entityId: asset.id,
      nextHash: hashValue({ presentation, variants, media_metadata: mediaMetadata }),
      metadata: { version: 1, kind, public_media_asset_id: publicMediaAssetId },
    });
    asset.setDataValue('publicMediaAsset', publicAssetRow);
    return serializeMediaAsset(asset, { requestedScope: scope });
  });
}

async function listMedia({ actorId, query = {}, models = db, assertFeatureAccess } = {}) {
  const scope = normalizeScope(query);
  await assertScopeAccess(actorId, scope, 'marketing.web.view', { models, assertFeatureAccess });
  const capabilities = await resolveLibraryCapabilities(actorId, scope, { models, assertFeatureAccess });
  const mediaIds = normalizeMediaIdFilter(query.ids ?? query['ids[]']);
  const page = boundedInteger(query.page, 1, MAX_PAGE_NUMBER);
  const limit = boundedInteger(query.limit, mediaIds?.length || DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const includeInheritedGroup = booleanQuery(query.include_inherited_group);
  const status = String(query.status || '').trim().toLowerCase();
  const kind = String(query.kind || '').trim().toLowerCase();
  const search = String(query.search || '').trim().slice(0, 120);
  if (status && !['processing', 'ready', 'failed', 'archived'].includes(status)) {
    throw new WebContentMediaServiceError('invalid_media_status', 'El estado del medio no es válido.');
  }
  if (kind && kind !== 'image') {
    throw new WebContentMediaServiceError('invalid_media_kind', 'El tipo de medio no es válido.');
  }
  const scopeWhere = await readScopeWhere(scope, includeInheritedGroup, models);
  const where = {
    ...scopeWhere,
    ...(mediaIds ? { id: { [Op.in]: mediaIds } } : {}),
    ...(status ? { status } : {}),
    ...(kind ? { kind } : {}),
    ...(search ? { title: { [Op.like]: `%${search}%` } } : {}),
  };
  const result = await models.WebMediaAsset.findAndCountAll({
    where,
    include: [{
      model: models.PublicMediaAsset,
      as: 'publicMediaAsset',
      attributes: [
        'id',
        'scope_type',
        'clinica_id',
        'grupo_clinica_id',
        'public_url',
        'content_type',
        'size_bytes',
        'sensitivity',
        'status',
        'metadata',
      ],
      required: true,
    }],
    order: [['updated_at', 'DESC'], ['id', 'ASC']],
    limit,
    offset: (page - 1) * limit,
    distinct: true,
  });
  const total = Number(result.count || 0);
  return {
    scope: { type: scope.type, id: scope.id },
    capabilities,
    items: (result.rows || []).map((row) => serializeMediaAsset(row, {
      requestedScope: scope,
      canEdit: canEditLibraryResource(row, actorId, capabilities, scope),
    })),
    pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
  };
}

async function updateMedia({ actorId, mediaId, body = {}, requestId = null, models = db, sequelize = db.sequelize } = {}) {
  const expectedVersion = positiveInteger(body.version ?? body.expected_version);
  if (!expectedVersion) {
    throw new WebContentMediaServiceError('media_version_required', 'version es obligatorio para actualizar.', 428);
  }
  return sequelize.transaction(async (transaction) => {
    const asset = await models.WebMediaAsset.findByPk(String(mediaId || ''), {
      include: [{ model: models.PublicMediaAsset, as: 'publicMediaAsset', required: true }],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!asset) throw new WebContentMediaServiceError('media_not_found', 'El medio no existe.', 404);
    const value = plain(asset);
    const scope = scopeFromResource(value);
    await assertResourceScopeAccess(
      actorId,
      scope,
      'marketing.web.edit',
      'media_not_found',
      'El medio no existe.',
      { models, transaction }
    );
    await assertOwnerOrReviewer(actorId, value.ownerUserId, scope, { models, transaction });
    if (Number(value.version) !== expectedVersion) {
      throw new WebContentMediaServiceError(
        'media_conflict',
        'El medio cambió en otra sesión. Recarga antes de guardar.',
        409,
        { expected_version: expectedVersion, current_version: Number(value.version) }
      );
    }
    const status = body.status === undefined ? value.status : String(body.status || '').trim().toLowerCase();
    if (!['ready', 'archived'].includes(status)) {
      throw new WebContentMediaServiceError('invalid_media_status', 'Solo se puede activar o archivar un medio.', 422);
    }
    const presentationChanged = ['title', 'alt_text', 'decorative', 'focal_points', 'rights']
      .some((field) => body[field] !== undefined);
    if (!presentationChanged && status === value.status) {
      throw new WebContentMediaServiceError('empty_media_patch', 'No hay cambios válidos que guardar.');
    }
    const presentation = validateWebMediaPresentation({
      title: body.title ?? value.title,
      alt_text: body.alt_text ?? value.altText,
      decorative: body.decorative ?? value.decorative,
      focal_points: body.focal_points ?? value.focalPoints,
      rights: body.rights ?? value.rights,
    });
    assertMediaRightsCurrent(presentation.rights, status);
    const previousHash = hashValue({
      title: value.title,
      alt_text: value.altText,
      decorative: value.decorative,
      focal_points: value.focalPoints,
      rights: value.rights,
      status: value.status,
      version: value.version,
    });
    await asset.update({
      title: presentation.title,
      altText: presentation.alt_text,
      decorative: presentation.decorative,
      focalPoints: presentation.focal_points,
      rights: presentation.rights,
      status,
      version: expectedVersion + 1,
      updatedByUserId: positiveInteger(actorId),
    }, { transaction });
    const nextHash = hashValue({
      title: asset.title,
      alt_text: asset.altText,
      decorative: asset.decorative,
      focal_points: asset.focalPoints,
      rights: asset.rights,
      status: asset.status,
      version: asset.version,
    });
    await audit({
      models,
      transaction,
      scope,
      actorId,
      requestId,
      eventType: 'web.media.updated',
      entityType: 'web_media_asset',
      entityId: asset.id,
      previousHash,
      nextHash,
      metadata: {
        previous_version: expectedVersion,
        next_version: Number(asset.version),
        previous_status: value.status,
        next_status: asset.status,
      },
    });
    return serializeMediaAsset(asset, { requestedScope: scope });
  });
}

async function cleanupExpiredQuarantinedMedia({
  now = new Date(),
  limit = 100,
  models = db,
  sequelize = db.sequelize,
  storage = publicMediaStorage,
} = {}) {
  const safeLimit = Math.min(positiveInteger(limit) || 100, 500);
  const rows = await models.PublicMediaAsset.findAll({
    where: { purpose: 'web_editor_media', status: { [Op.in]: ['quarantine', 'cleanup_pending'] } },
    order: [['created_at', 'ASC'], ['id', 'ASC']],
    limit: safeLimit,
  });
  const result = { inspected: rows.length, archived: 0, failed: [] };
  for (const candidate of rows) {
    const candidateId = positiveInteger(plain(candidate).id);
    if (!candidateId) continue;
    let claim;
    try {
      claim = await sequelize.transaction(async (transaction) => {
        const locked = await models.PublicMediaAsset.findByPk(candidateId, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const value = plain(locked);
        if (!value || value.purpose !== 'web_editor_media') return null;
        const metadata = value.metadata && typeof value.metadata === 'object' ? value.metadata : {};
        if (value.status === 'quarantine') {
          const expiresAt = Date.parse(metadata.quarantine_expires_at || '');
          if (!Number.isFinite(expiresAt) || expiresAt > now.getTime()) return null;
        } else if (value.status === 'cleanup_pending') {
          const claimedAt = Date.parse(metadata.quarantine_cleanup_claimed_at || '');
          if (Number.isFinite(claimedAt) && claimedAt + QUARANTINE_CLEANUP_LEASE_MS > now.getTime()) {
            return null;
          }
        } else {
          return null;
        }
        const registered = await models.WebMediaAsset.findOne({
          where: { publicMediaAssetId: candidateId },
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        if (registered) return null;
        const claimId = crypto.randomUUID();
        await locked.update({
          status: 'cleanup_pending',
          sensitivity: 'internal',
          metadata: {
            ...metadata,
            quarantine_cleanup_claim_id: claimId,
            quarantine_cleanup_claimed_at: now.toISOString(),
          },
        }, { transaction });
        return { id: candidateId, claimId, objectKey: value.object_key };
      });
      if (!claim) continue;

      try {
        await storage.deleteWebEditorMediaObject(claim.objectKey);
      } catch (error) {
        await sequelize.transaction(async (transaction) => {
          const locked = await models.PublicMediaAsset.findByPk(claim.id, {
            transaction,
            lock: transaction.LOCK.UPDATE,
          });
          const value = plain(locked);
          const metadata = value?.metadata && typeof value.metadata === 'object' ? value.metadata : {};
          if (value?.status !== 'cleanup_pending'
            || metadata.quarantine_cleanup_claim_id !== claim.claimId) return;
          const {
            quarantine_cleanup_claim_id: ignoredClaimId,
            quarantine_cleanup_claimed_at: ignoredClaimedAt,
            ...rest
          } = metadata;
          await locked.update({
            status: 'quarantine',
            metadata: {
              ...rest,
              quarantine_cleanup_error: String(error?.code || error?.name || 'delete_failed').slice(0, 128),
              quarantine_cleanup_failed_at: now.toISOString(),
            },
          }, { transaction });
        });
        throw error;
      }

      const finalized = await sequelize.transaction(async (transaction) => {
        const locked = await models.PublicMediaAsset.findByPk(claim.id, {
          transaction,
          lock: transaction.LOCK.UPDATE,
        });
        const value = plain(locked);
        const metadata = value?.metadata && typeof value.metadata === 'object' ? value.metadata : {};
        if (value?.status !== 'cleanup_pending'
          || metadata.quarantine_cleanup_claim_id !== claim.claimId) return false;
        const {
          quarantine_cleanup_claim_id: ignoredClaimId,
          quarantine_cleanup_claimed_at: ignoredClaimedAt,
          quarantine_cleanup_error: ignoredError,
          quarantine_cleanup_failed_at: ignoredFailedAt,
          ...rest
        } = metadata;
        await locked.update({
          status: 'archived',
          sensitivity: 'internal',
          metadata: {
            ...rest,
            quarantine_cleaned_at: now.toISOString(),
            quarantine_expires_at: null,
          },
        }, { transaction });
        return true;
      });
      if (finalized) result.archived += 1;
      else result.failed.push({ id: claim.id, code: 'cleanup_claim_lost' });
    } catch (error) {
      result.failed.push({ id: candidateId, code: error?.code || error?.name || 'cleanup_failed' });
    }
  }
  return result;
}

module.exports = {
  DEFAULT_PAGE_SIZE,
  MAX_MEDIA_ID_FILTER,
  MAX_PAGE_SIZE,
  QUARANTINE_CLEANUP_LEASE_MS,
  WebContentMediaServiceError,
  assertPublicMediaUsable,
  assertMediaRightsCurrent,
  assertOwnerOrReviewer,
  assertResourceScopeAccess,
  cleanupExpiredQuarantinedMedia,
  createContent,
  listContent,
  listContentVersions,
  listMedia,
  normalizeMediaIdFilter,
  publicMediaProjection,
  resolveLibraryCapabilities,
  registerMedia,
  sanitizeMediaMetadata,
  sanitizeVariants,
  serializeContentEntry,
  serializeMediaAsset,
  updateContent,
  updateMedia,
};
