'use strict';

const crypto = require('crypto');
const sharp = require('sharp');
const { CloudFrontClient, CreateInvalidationCommand } = require('@aws-sdk/client-cloudfront');
const { DeleteObjectCommand, PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { AssumeRoleCommand, STSClient } = require('@aws-sdk/client-sts');

const DEFAULT_REGION = 'eu-west-3';
const DEFAULT_BUCKET = 'clinicaclick-public-media-eu-west-3';
const DEFAULT_BASE_URL = 'https://media.clinicaclick.com';
const DEFAULT_DISTRIBUTION_ID = 'E3TRXQ4DMSYUVL';
const VERSIONED_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const NON_VERSIONED_CACHE_CONTROL = 'public, max-age=300';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_WHATSAPP_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 128 * 1024;
const MAX_IMAGE_PIXELS = 40 * 1000 * 1000;
const CLINIC_ACCESS_IMAGE_WIDTH = 1200;
const CLINIC_ACCESS_IMAGE_HEIGHT = 675;
const ASSUME_ROLE_REFRESH_SKEW_MS = 5 * 60 * 1000;

let cachedAssumedRoleCredentials = null;

const IMAGE_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/jpg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
  ['image/gif', 'gif']
]);

const TEXT_TYPES = new Map([
  ['text/plain', 'txt']
]);

function cleanText(value) {
  return String(value || '').trim();
}

function normalizeBaseUrl(value) {
  return cleanText(value || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function getConfig() {
  return {
    region: cleanText(process.env.AWS_DEFAULT_REGION || process.env.AWS_REGION || DEFAULT_REGION),
    bucket: cleanText(process.env.PUBLIC_MEDIA_BUCKET || DEFAULT_BUCKET),
    baseUrl: normalizeBaseUrl(process.env.PUBLIC_MEDIA_BASE_URL || DEFAULT_BASE_URL),
    distributionId: cleanText(process.env.CLOUDFRONT_DISTRIBUTION_ID || DEFAULT_DISTRIBUTION_ID),
    assumeRoleArn: cleanText(process.env.PUBLIC_MEDIA_ASSUME_ROLE_ARN || process.env.AWS_PUBLIC_MEDIA_ROLE_ARN || '')
  };
}

function assertAllowedPurpose(purpose) {
  const normalized = cleanText(purpose || 'public_asset').toLowerCase();
  const allowed = new Set([
    'review_team_photo',
    'whatsapp_image',
    'clinic_access_image',
    'clinic_logo',
    'marketing_image',
    'web_editor_media',
    'frontend_asset',
    'test_health',
    'public_asset'
  ]);
  if (!allowed.has(normalized)) {
    const err = new Error('public_media_purpose_not_allowed');
    err.status = 400;
    throw err;
  }
  return normalized;
}

function inferContentType(input = {}) {
  const explicit = cleanText(input.contentType || input.content_type).toLowerCase();
  if (explicit) return explicit;
  const dataUrl = cleanText(input.dataUrl || input.data_url || input.fileData || input.file_data || input.base64);
  const match = dataUrl.match(/^data:([^;,]+)[;,]/i);
  return match ? match[1].toLowerCase() : 'application/octet-stream';
}

function decodePayload(input = {}) {
  const raw = cleanText(input.dataUrl || input.data_url || input.fileData || input.file_data || input.base64 || input.content);
  if (!raw) {
    const err = new Error('public_media_empty_payload');
    err.status = 400;
    throw err;
  }

  const base64Match = raw.match(/^data:([^;,]+);base64,(.+)$/i);
  if (base64Match) {
    return Buffer.from(base64Match[2], 'base64');
  }

  if (input.encoding === 'utf8' || input.encoding === 'text') {
    return Buffer.from(raw, 'utf8');
  }

  return Buffer.from(raw, 'base64');
}

function extensionForContentType(contentType) {
  return IMAGE_TYPES.get(contentType) || TEXT_TYPES.get(contentType) || null;
}

function assertPublicMediaPayload({ purpose, contentType, buffer }) {
  const isHealth = purpose === 'test_health';
  const isImage = IMAGE_TYPES.has(contentType);
  const isText = TEXT_TYPES.has(contentType);

  if (!isImage && !(isHealth && isText)) {
    const err = new Error(isHealth ? 'public_media_health_requires_text_plain' : 'public_media_only_images_allowed');
    err.status = 400;
    throw err;
  }

  const maxBytes = isHealth ? MAX_TEXT_BYTES : MAX_IMAGE_BYTES;
  if (!buffer.length || buffer.length > maxBytes) {
    const err = new Error('public_media_file_size_not_allowed');
    err.status = 413;
    err.details = { maxBytes, sizeBytes: buffer.length };
    throw err;
  }
}

function shouldNormalizeWhatsappImage({ purpose, contentType }) {
  return ['review_team_photo', 'whatsapp_image'].includes(purpose)
    && ['image/webp', 'image/gif'].includes(contentType);
}

async function normalizeWhatsappImageToJpeg(buffer) {
  return sharp(buffer, { failOn: 'none', animated: false })
    .rotate()
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
}

function normalizeImageContentType(value) {
  const normalized = cleanText(value).toLowerCase();
  return normalized === 'image/jpg' ? 'image/jpeg' : normalized;
}

function contentTypeForSharpFormat(format) {
  const formats = {
    jpeg: 'image/jpeg',
    png: 'image/png',
    webp: 'image/webp',
    gif: 'image/gif',
  };
  return formats[String(format || '').toLowerCase()] || null;
}

async function inspectImagePayload(buffer, declaredContentType) {
  let metadata;
  try {
    metadata = await sharp(buffer, {
      failOn: 'error',
      animated: false,
      limitInputPixels: MAX_IMAGE_PIXELS,
    }).metadata();
  } catch (cause) {
    const exceedsPixelLimit = /pixel limit|exceeds? .*pixels?/i.test(String(cause?.message || ''));
    const err = new Error(exceedsPixelLimit
      ? 'public_media_image_dimensions_not_allowed'
      : 'public_media_invalid_image');
    err.status = exceedsPixelLimit ? 413 : 400;
    if (exceedsPixelLimit) err.details = { maxPixels: MAX_IMAGE_PIXELS };
    err.cause = cause;
    throw err;
  }

  const actualContentType = contentTypeForSharpFormat(metadata.format);
  if (!actualContentType || !metadata.width || !metadata.height) {
    const err = new Error('public_media_unsupported_image_format');
    err.status = 400;
    throw err;
  }
  if (Number(metadata.width) * Number(metadata.height) > MAX_IMAGE_PIXELS) {
    const err = new Error('public_media_image_dimensions_not_allowed');
    err.status = 413;
    err.details = {
      maxPixels: MAX_IMAGE_PIXELS,
      width: metadata.width,
      height: metadata.height,
    };
    throw err;
  }

  const declared = normalizeImageContentType(declaredContentType);
  if (declared && declared !== actualContentType) {
    const err = new Error('public_media_content_type_mismatch');
    err.status = 400;
    err.details = { declaredContentType: declared, actualContentType };
    throw err;
  }

  return {
    actualContentType,
    width: Number(metadata.width),
    height: Number(metadata.height),
    format: String(metadata.format || ''),
  };
}

async function normalizeClinicAccessImageToJpeg(buffer) {
  return sharp(buffer, {
    failOn: 'error',
    animated: false,
    limitInputPixels: MAX_IMAGE_PIXELS,
  })
    .rotate()
    .resize(CLINIC_ACCESS_IMAGE_WIDTH, CLINIC_ACCESS_IMAGE_HEIGHT, {
      fit: 'contain',
      background: '#ffffff',
      withoutEnlargement: false,
    })
    .flatten({ background: '#ffffff' })
    .jpeg({ quality: 86, mozjpeg: true, chromaSubsampling: '4:2:0' })
    .toBuffer();
}

async function normalizeWebEditorImageToWebp(buffer) {
  // Content disarm, no antivirus: decodificamos y volvemos a codificar únicamente
  // los píxeles. Sharp no copia EXIF, GPS, XMP, perfiles incrustados ni bytes
  // adicionales si no se invoca withMetadata(). Los binarios que Sharp no pueda
  // interpretar se rechazan de forma fail-closed.
  return sharp(buffer, {
    failOn: 'error',
    animated: false,
    limitInputPixels: MAX_IMAGE_PIXELS,
  })
    .rotate()
    .webp({ quality: 88, effort: 4, smartSubsample: true })
    .toBuffer();
}

async function preparePublicMediaPayload(input = {}) {
  const purpose = assertAllowedPurpose(input.purpose);
  let contentType = inferContentType(input);
  let buffer = Buffer.isBuffer(input.buffer) ? input.buffer : decodePayload(input);

  // Limitar los bytes originales antes de decodificar con Sharp evita que una
  // imagen comprimida enorme use CPU/memoria antes de ser rechazada.
  assertPublicMediaPayload({ purpose, contentType, buffer });

  let sourceImage = null;
  let transformed = false;
  if (IMAGE_TYPES.has(contentType)) {
    sourceImage = await inspectImagePayload(buffer, contentType);
  }

  if (purpose === 'clinic_access_image') {
    buffer = await normalizeClinicAccessImageToJpeg(buffer);
    contentType = 'image/jpeg';
    transformed = true;
  } else if (shouldNormalizeWhatsappImage({ purpose, contentType })) {
    buffer = await normalizeWhatsappImageToJpeg(buffer);
    contentType = 'image/jpeg';
    transformed = true;
  } else if (purpose === 'web_editor_media') {
    buffer = await normalizeWebEditorImageToWebp(buffer);
    contentType = 'image/webp';
    transformed = true;
  }

  assertPublicMediaPayload({ purpose, contentType, buffer });
  if (purpose === 'clinic_access_image' && buffer.length > MAX_WHATSAPP_IMAGE_BYTES) {
    const err = new Error('clinic_access_image_too_large_for_whatsapp');
    err.status = 413;
    err.details = { maxBytes: MAX_WHATSAPP_IMAGE_BYTES, sizeBytes: buffer.length };
    throw err;
  }

  const outputImage = IMAGE_TYPES.has(contentType)
    ? await inspectImagePayload(buffer, contentType)
    : null;

  return {
    purpose,
    contentType,
    buffer,
    imageMetadata: sourceImage ? {
      source_content_type: sourceImage.actualContentType,
      source_width: sourceImage.width,
      source_height: sourceImage.height,
      output_content_type: outputImage?.actualContentType || contentType,
      output_width: outputImage?.width || null,
      output_height: outputImage?.height || null,
      transformed,
      metadata_stripped: ['clinic_access_image', 'web_editor_media'].includes(purpose),
      content_disarm: purpose === 'web_editor_media' ? 'sharp_reencode_v1' : null,
      malware_scan_status: purpose === 'web_editor_media' ? 'not_available' : null,
      whatsapp_compatible: purpose === 'clinic_access_image'
        ? buffer.length <= MAX_WHATSAPP_IMAGE_BYTES
        : null,
    } : null,
  };
}

function publicUrlForKey(key) {
  const { baseUrl } = getConfig();
  return `${baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function prefixForPurpose(purpose) {
  switch (purpose) {
    case 'review_team_photo':
      return 'whatsapp/reviews/team';
    case 'whatsapp_image':
      return 'whatsapp/images';
    case 'clinic_access_image':
      return 'whatsapp/clinic-access';
    case 'clinic_logo':
      return 'logos/clinicas';
    case 'marketing_image':
      return 'marketing';
    case 'web_editor_media':
      return 'marketing/web-editor';
    case 'frontend_asset':
      return 'frontend';
    case 'test_health':
      return 'test';
    default:
      return 'public';
  }
}

function generateObjectKey({ purpose, contentType, clinicId = null, groupId = null, explicitKey = null }) {
  const normalizedPurpose = assertAllowedPurpose(purpose);
  const extension = extensionForContentType(contentType);
  if (!extension) {
    const err = new Error('public_media_unsupported_content_type');
    err.status = 400;
    throw err;
  }

  if (normalizedPurpose === 'test_health') {
    return 'test/health.txt';
  }

  if (explicitKey) {
    const cleanKey = cleanText(explicitKey)
      .replace(/^\/+/, '')
      .replace(/[^a-zA-Z0-9/_\-.]/g, '-')
      .replace(/\/{2,}/g, '/');
    if (!cleanKey || cleanKey.includes('..')) {
      const err = new Error('public_media_invalid_key');
      err.status = 400;
      throw err;
    }
    return cleanKey;
  }

  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const scope = clinicId ? `clinic-${clinicId}` : (groupId ? `group-${groupId}` : 'global');
  const id = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
  return `${prefixForPurpose(normalizedPurpose)}/${scope}/${yyyy}/${mm}/${id}.${extension}`;
}

function getCredentialProvider() {
  const { region, assumeRoleArn } = getConfig();
  if (!assumeRoleArn) return null;

  return async () => {
    const now = Date.now();
    const expiresAt = cachedAssumedRoleCredentials?.expiration
      ? new Date(cachedAssumedRoleCredentials.expiration).getTime()
      : 0;

    if (
      cachedAssumedRoleCredentials
      && cachedAssumedRoleCredentials.accessKeyId
      && expiresAt
      && expiresAt - ASSUME_ROLE_REFRESH_SKEW_MS > now
    ) {
      return cachedAssumedRoleCredentials;
    }

    const client = new STSClient({ region });
    const response = await client.send(new AssumeRoleCommand({
      RoleArn: assumeRoleArn,
      RoleSessionName: `clinicaclick-public-media-${process.pid}`,
      DurationSeconds: 3600
    }));
    const credentials = response.Credentials;
    if (!credentials?.AccessKeyId || !credentials?.SecretAccessKey) {
      const err = new Error('public_media_assume_role_credentials_missing');
      err.status = 503;
      throw err;
    }

    cachedAssumedRoleCredentials = {
      accessKeyId: credentials.AccessKeyId,
      secretAccessKey: credentials.SecretAccessKey,
      sessionToken: credentials.SessionToken,
      expiration: credentials.Expiration
    };
    return cachedAssumedRoleCredentials;
  };
}

function clientOptions(region) {
  const credentials = getCredentialProvider();
  return credentials ? { region, credentials } : { region };
}

function s3Client() {
  const { region } = getConfig();
  return new S3Client(clientOptions(region));
}

function cloudFrontClient() {
  return new CloudFrontClient(clientOptions('us-east-1'));
}

async function uploadPublicMedia(input = {}) {
  const prepared = input.preparedPayload || await preparePublicMediaPayload(input);
  if (
    !prepared
    || prepared.purpose !== assertAllowedPurpose(input.purpose)
    || !Buffer.isBuffer(prepared.buffer)
  ) {
    const err = new Error('public_media_invalid_prepared_payload');
    err.status = 400;
    throw err;
  }
  const {
    purpose,
    contentType,
    buffer,
    imageMetadata,
  } = prepared;

  const { region, bucket } = getConfig();
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  const clinicId = Number.isInteger(Number(input.clinicId || input.clinica_id))
    ? Number(input.clinicId || input.clinica_id)
    : null;
  const groupId = Number.isInteger(Number(input.groupId || input.grupo_clinica_id))
    ? Number(input.groupId || input.grupo_clinica_id)
    : null;
  const key = generateObjectKey({
    purpose,
    contentType,
    clinicId,
    groupId,
    explicitKey: input.key || input.object_key || null
  });
  const cacheControl = cleanText(input.cacheControl || input.cache_control)
    || (input.versioned === false ? NON_VERSIONED_CACHE_CONTROL : VERSIONED_CACHE_CONTROL);

  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    Body: buffer,
    ContentType: contentType,
    CacheControl: cacheControl,
    Metadata: {
      purpose,
      sensitivity: 'public',
      sha256
    }
  });

  const response = await s3Client().send(command);

  if (input.invalidate === true) {
    await invalidatePublicMediaKey(key);
  }

  return {
    bucket,
    region,
    key,
    url: publicUrlForKey(key),
    contentType,
    sizeBytes: buffer.length,
    sha256,
    etag: response.ETag || null,
    cacheControl,
    imageMetadata,
  };
}

async function deleteWebEditorMediaObject(objectKey) {
  const key = cleanText(objectKey).replace(/^\/+/, '');
  if (!/^marketing\/web-editor\/(?:clinic|group)-[1-9][0-9]*\//.test(key) || key.includes('..')) {
    const err = new Error('web_editor_media_delete_key_not_allowed');
    err.status = 400;
    throw err;
  }
  const { bucket } = getConfig();
  await s3Client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  return true;
}

async function invalidatePublicMediaKey(key) {
  const { distributionId } = getConfig();
  if (!distributionId) {
    const err = new Error('public_media_cloudfront_distribution_missing');
    err.status = 503;
    throw err;
  }
  const path = `/${cleanText(key).replace(/^\/+/, '')}`;
  const command = new CreateInvalidationCommand({
    DistributionId: distributionId,
    InvalidationBatch: {
      CallerReference: `public-media-${Date.now()}-${crypto.randomBytes(6).toString('hex')}`,
      Paths: {
        Quantity: 1,
        Items: [path]
      }
    }
  });
  return cloudFrontClient().send(command);
}

function getPublicMediaStatus() {
  const { region, bucket, baseUrl, distributionId, assumeRoleArn } = getConfig();
  return {
    provider: 's3_cloudfront',
    region,
    bucket,
    base_url: baseUrl,
    cloudfront_distribution_id: distributionId,
    credential_mode: assumeRoleArn ? 'assume_role' : 'default_provider_chain',
    assume_role_configured: !!assumeRoleArn,
    assume_role_arn: assumeRoleArn || null,
    allowed_use: 'public_non_clinical_assets_only',
    clinical_storage: false,
    bucket_public: false,
    acl_public_read: false,
    clinic_access_image: {
      content_type: 'image/jpeg',
      width: CLINIC_ACCESS_IMAGE_WIDTH,
      height: CLINIC_ACCESS_IMAGE_HEIGHT,
      max_source_bytes: MAX_IMAGE_BYTES,
      max_output_bytes: MAX_WHATSAPP_IMAGE_BYTES,
      strips_metadata: true,
      physical_delete_supported: false,
    },
  };
}

module.exports = {
  CLINIC_ACCESS_IMAGE_HEIGHT,
  CLINIC_ACCESS_IMAGE_WIDTH,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_PIXELS,
  MAX_WHATSAPP_IMAGE_BYTES,
  VERSIONED_CACHE_CONTROL,
  getConfig,
  getPublicMediaStatus,
  uploadPublicMedia,
  deleteWebEditorMediaObject,
  invalidatePublicMediaKey,
  preparePublicMediaPayload,
  publicUrlForKey,
};
