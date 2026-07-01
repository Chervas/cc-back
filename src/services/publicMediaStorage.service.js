'use strict';

const crypto = require('crypto');
const { CloudFrontClient, CreateInvalidationCommand } = require('@aws-sdk/client-cloudfront');
const { PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { AssumeRoleCommand, STSClient } = require('@aws-sdk/client-sts');

const DEFAULT_REGION = 'eu-west-3';
const DEFAULT_BUCKET = 'clinicaclick-public-media-eu-west-3';
const DEFAULT_BASE_URL = 'https://media.clinicaclick.com';
const DEFAULT_DISTRIBUTION_ID = 'E3TRXQ4DMSYUVL';
const VERSIONED_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const NON_VERSIONED_CACHE_CONTROL = 'public, max-age=300';
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_TEXT_BYTES = 128 * 1024;
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
    'clinic_logo',
    'marketing_image',
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
    case 'clinic_logo':
      return 'logos/clinicas';
    case 'marketing_image':
      return 'marketing';
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
  const purpose = assertAllowedPurpose(input.purpose);
  const contentType = inferContentType(input);
  const buffer = Buffer.isBuffer(input.buffer) ? input.buffer : decodePayload(input);
  assertPublicMediaPayload({ purpose, contentType, buffer });

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
    cacheControl
  };
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
    acl_public_read: false
  };
}

module.exports = {
  VERSIONED_CACHE_CONTROL,
  getConfig,
  getPublicMediaStatus,
  uploadPublicMedia,
  invalidatePublicMediaKey,
  publicUrlForKey
};
