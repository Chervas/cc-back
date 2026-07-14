'use strict';

const { fn, col } = require('sequelize');
const { Clinica, GrupoClinica, PublicMediaAsset } = require('../../models');
const publicMediaStorage = require('../services/publicMediaStorage.service');
const {
  assertUserCanAccessFeature,
  getAccessibleClinicIdsForFeature,
} = require('../lib/access-policy');

const CLINIC_VIEW_FEATURE = 'clinic.settings.view';
const CLINIC_EDIT_FEATURE = 'clinic.settings.edit';
const MARKETING_FEATURE = 'marketing';

function uploadFeatureForPurpose(purpose) {
  // La imagen de acceso forma parte de la configuracion de la clinica. Los
  // assets de campanas conservan su permiso de marketing (incluido el flujo
  // de foto de resenas que puede gestionar una agencia).
  return purpose === 'clinic_access_image' ? CLINIC_EDIT_FEATURE : MARKETING_FEATURE;
}

function toInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function resolveScope(req) {
  const scope = String(req.body?.scope || req.query?.scope || '').trim();
  const explicitClinicId = toInt(
    req.body?.clinic_id
    ?? req.body?.clinicId
    ?? req.query?.clinic_id
    ?? req.query?.clinicId
  );
  const selectedClinicId = toInt(req.headers['x-selected-clinic']);
  const groupIdFromScope = scope.startsWith('group:') ? toInt(scope.slice(6)) : null;
  const groupId = toInt(
    req.body?.grupo_clinica_id
    ?? req.body?.group_id
    ?? req.body?.groupId
    ?? req.query?.grupo_clinica_id
    ?? req.query?.group_id
    ?? req.query?.groupId
  ) || groupIdFromScope;

  if (explicitClinicId && groupId) {
    const error = new Error('public_media_scope_ambiguous');
    error.status = 400;
    throw error;
  }
  // El interceptor Angular adjunta X-Selected-Clinic incluso cuando el usuario
  // opera expresamente sobre `group:<id>`. El header es solo fallback: no debe
  // volver ambiguo ni degradar un scope de grupo declarado en body/query.
  if (groupId) {
    return { scopeType: 'group', clinicId: null, groupId };
  }
  const clinicId = explicitClinicId || selectedClinicId;
  if (clinicId) {
    return { scopeType: 'clinic', clinicId, groupId: null };
  }
  const error = new Error('public_media_scope_required');
  error.status = 400;
  throw error;
}

async function assertScopeAccess({ actorId, scope, featureKey }) {
  if (scope.scopeType === 'clinic') {
    const clinic = await Clinica.findByPk(scope.clinicId, {
      attributes: ['id_clinica'],
      raw: true,
    });
    if (!clinic) {
      const error = new Error('public_media_clinic_not_found');
      error.status = 404;
      throw error;
    }
    await assertUserCanAccessFeature({
      actorId,
      featureKey,
      clinicId: scope.clinicId,
    });
    return;
  }

  const group = await GrupoClinica.findByPk(scope.groupId, {
    attributes: ['id_grupo'],
    raw: true,
  });
  if (!group) {
    const error = new Error('public_media_group_not_found');
    error.status = 404;
    throw error;
  }
  const clinics = await Clinica.findAll({
    where: { grupoClinicaId: scope.groupId },
    attributes: ['id_clinica'],
    raw: true,
  });
  const clinicIds = clinics.map((clinic) => Number(clinic.id_clinica)).filter(Number.isFinite);
  if (!clinicIds.length) {
    const error = new Error('public_media_group_has_no_clinics');
    error.status = 409;
    throw error;
  }
  const accessibleClinicIds = await getAccessibleClinicIdsForFeature({
    actorId,
    featureKey,
    clinicIds,
  });
  if (accessibleClinicIds.length !== clinicIds.length) {
    const error = new Error('access_policy_forbidden');
    error.status = 403;
    error.details = { feature_key: featureKey, group_id: scope.groupId };
    throw error;
  }
}

function respondError(res, error) {
  const status = Number(error?.status || error?.$metadata?.httpStatusCode || 500);
  return res.status(status >= 400 && status < 600 ? status : 500).json({
    success: false,
    error: error?.message || 'public_media_request_failed',
    details: error?.details || null,
  });
}

async function buildUsage(scope) {
  if (!PublicMediaAsset) return null;

  const where = { status: 'active', sensitivity: 'public' };
  if (scope.scopeType === 'group' && scope.groupId) {
    where.scope_type = 'group';
    where.grupo_clinica_id = scope.groupId;
  } else if (scope.clinicId) {
    where.scope_type = 'clinic';
    where.clinica_id = scope.clinicId;
  } else {
    return null;
  }

  const row = await PublicMediaAsset.findOne({
    attributes: [
      [fn('COUNT', col('id')), 'asset_count'],
      [fn('COALESCE', fn('SUM', col('size_bytes')), 0), 'size_bytes']
    ],
    where,
    raw: true
  });

  return {
    asset_count: Number(row?.asset_count || 0),
    size_bytes: Number(row?.size_bytes || 0)
  };
}

exports.getStatus = async (req, res) => {
  try {
    const scope = resolveScope(req);
    await assertScopeAccess({
      actorId: req.userData?.userId,
      scope,
      featureKey: CLINIC_VIEW_FEATURE,
    });
    const status = publicMediaStorage.getPublicMediaStatus();
    const usage = await buildUsage(scope);
    return res.json({ success: true, status, usage });
  } catch (error) {
    return respondError(res, error);
  }
};

exports.upload = async (req, res) => {
  try {
    const scope = resolveScope(req);
    const purpose = String(req.body?.purpose || 'public_asset').trim().toLowerCase();
    await assertScopeAccess({
      actorId: req.userData?.userId,
      scope,
      featureKey: uploadFeatureForPurpose(purpose),
    });
    if (req.body?.non_clinical_asserted !== true && req.body?.nonClinicalAsserted !== true) {
      const error = new Error('public_media_non_clinical_assertion_required');
      error.status = 400;
      throw error;
    }
    if (purpose === 'clinic_access_image' && scope.scopeType !== 'clinic') {
      const error = new Error('clinic_access_image_requires_clinic_scope');
      error.status = 400;
      throw error;
    }

    const ownerType = purpose === 'clinic_access_image'
      ? 'clinic_access_guidance'
      : (String(req.body?.owner_type || req.body?.ownerType || '').trim() || null);
    const ownerId = purpose === 'clinic_access_image'
      ? String(scope.clinicId)
      : (String(req.body?.owner_id || req.body?.ownerId || '').trim() || null);

    const upload = await publicMediaStorage.uploadPublicMedia({
      purpose,
      clinicId: scope.clinicId,
      groupId: scope.groupId,
      contentType: req.body?.content_type || req.body?.contentType,
      dataUrl: req.body?.data_url || req.body?.dataUrl || req.body?.file_data || req.body?.fileData,
      base64: req.body?.base64,
      content: req.body?.content,
      encoding: req.body?.encoding,
      // Las rutas HTTP nunca aceptan key/invalidate del cliente. Cada subida
      // genera un objeto versionado y opaco; las sobrescrituras quedan solo
      // para servicios internos controlados.
      versioned: true,
    });

    let asset = null;
    if (PublicMediaAsset) {
      asset = await PublicMediaAsset.create({
        scope_type: scope.scopeType,
        clinica_id: scope.scopeType === 'clinic' ? scope.clinicId : null,
        grupo_clinica_id: scope.scopeType === 'group' ? scope.groupId : null,
        owner_type: ownerType,
        owner_id: ownerId,
        purpose,
        provider: 's3_cloudfront',
        bucket: upload.bucket,
        region: upload.region,
        object_key: upload.key,
        public_url: upload.url,
        content_type: upload.contentType,
        size_bytes: upload.sizeBytes,
        sha256: upload.sha256,
        etag: upload.etag,
        cache_control: upload.cacheControl,
        sensitivity: 'public',
        status: 'active',
        metadata: {
          source: 'public_media_upload',
          original_filename: purpose === 'clinic_access_image'
            ? null
            : (req.body?.file_name || req.body?.fileName || null),
          non_clinical_asserted: true,
          image: upload.imageMetadata || null,
          replacement_policy: purpose === 'clinic_access_image'
            ? 'versioned_reference_update_no_physical_delete'
            : null,
        },
        created_by: req.userData?.userId || null
      });
    }

    const usage = await buildUsage(scope);
    return res.status(201).json({
      success: true,
      asset: {
        id: asset?.id || null,
        url: upload.url,
        key: upload.key,
        content_type: upload.contentType,
        size_bytes: upload.sizeBytes,
        sha256: upload.sha256,
        cache_control: upload.cacheControl,
        scope_type: scope.scopeType,
        clinic_id: scope.clinicId,
        group_id: scope.groupId,
        purpose
      },
      usage
    });
  } catch (err) {
    const status = err.status || err.$metadata?.httpStatusCode || 500;
    const message = err.message || 'public_media_upload_failed';
    console.error('[public-media] upload failed', {
      message,
      status,
      code: err.name || err.Code || null
    });
    return respondError(res, err);
  }
};

exports._private = {
  assertScopeAccess,
  resolveScope,
  uploadFeatureForPurpose,
};
