'use strict';

const { Op, fn, col } = require('sequelize');
const { PublicMediaAsset } = require('../../models');
const publicMediaStorage = require('../services/publicMediaStorage.service');

function toInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function resolveScope(req) {
  const scope = String(req.body?.scope || req.query?.scope || '').trim();
  const clinicId = toInt(req.body?.clinic_id ?? req.body?.clinicId ?? req.headers['x-selected-clinic']);
  const groupIdFromScope = scope.startsWith('group:') ? toInt(scope.slice(6)) : null;
  const groupId = toInt(req.body?.grupo_clinica_id ?? req.body?.group_id ?? req.body?.groupId) || groupIdFromScope;

  if (groupId && !clinicId) {
    return { scopeType: 'group', clinicId: null, groupId };
  }
  return { scopeType: 'clinic', clinicId, groupId: null };
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
  const scope = resolveScope(req);
  const status = publicMediaStorage.getPublicMediaStatus();
  const usage = await buildUsage(scope);
  return res.json({ success: true, status, usage });
};

exports.upload = async (req, res) => {
  try {
    const scope = resolveScope(req);
    const purpose = String(req.body?.purpose || 'public_asset').trim();
    const ownerType = String(req.body?.owner_type || req.body?.ownerType || '').trim() || null;
    const ownerId = String(req.body?.owner_id || req.body?.ownerId || '').trim() || null;

    const upload = await publicMediaStorage.uploadPublicMedia({
      purpose,
      clinicId: scope.clinicId,
      groupId: scope.groupId,
      contentType: req.body?.content_type || req.body?.contentType,
      dataUrl: req.body?.data_url || req.body?.dataUrl || req.body?.file_data || req.body?.fileData,
      base64: req.body?.base64,
      content: req.body?.content,
      encoding: req.body?.encoding,
      key: req.body?.key,
      versioned: req.body?.versioned !== false,
      invalidate: req.body?.invalidate === true
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
          original_filename: req.body?.file_name || req.body?.fileName || null,
          non_clinical_asserted: req.body?.non_clinical_asserted === true || req.body?.nonClinicalAsserted === true
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
    return res.status(status >= 400 && status < 600 ? status : 500).json({
      success: false,
      error: message,
      details: err.details || null
    });
  }
};
