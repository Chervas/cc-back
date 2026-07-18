'use strict';

const crypto = require('node:crypto');
const { PutObjectCommand, S3Client } = require('@aws-sdk/client-s3');
const { canonicalSerialize } = require('../lib/webDocument');
const { signWebArtifactManifest } = require('../lib/webArtifactSignature');

const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const MANIFEST_CACHE_CONTROL = 'public, max-age=31536000, immutable';
const SAFE_FILE_PATH = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*$/;

class WebArtifactStorageError extends Error {
  constructor(code, message, status = 503, details = undefined) {
    super(message);
    this.name = 'WebArtifactStorageError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function cleanPrefix(value) {
  const prefix = String(value || 'web-artifacts/v1').trim().replace(/^\/+|\/+$/g, '');
  if (!prefix || !SAFE_FILE_PATH.test(`${prefix}/placeholder`)) {
    throw new WebArtifactStorageError(
      'web_artifact_storage_prefix_invalid',
      'El prefijo de almacenamiento de publicaciones no es válido.'
    );
  }
  return prefix;
}

function safeFilePath(value) {
  const path = String(value || '').trim().replace(/^\/+/, '');
  if (!path || path.includes('..') || !SAFE_FILE_PATH.test(path)) {
    throw new WebArtifactStorageError(
      'web_artifact_file_path_invalid',
      'El artefacto contiene una ruta de fichero no publicable.',
      422,
      { path }
    );
  }
  return path;
}

function safeBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('unsafe');
    return url.toString().replace(/\/+$/, '');
  } catch {
    throw new WebArtifactStorageError(
      'web_artifact_storage_base_url_invalid',
      'La URL pública del almacén de publicaciones debe ser HTTPS y estable.'
    );
  }
}

function getArtifactStorageConfig(env = process.env) {
  const bucket = String(env.MARKETING_WEB_ARTIFACT_BUCKET || '').trim();
  const baseUrl = String(env.MARKETING_WEB_ARTIFACT_BASE_URL || '').trim();
  if (!bucket) {
    throw new WebArtifactStorageError(
      'web_artifact_storage_bucket_missing',
      'Falta configurar el bucket exclusivo de publicaciones web.'
    );
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new WebArtifactStorageError(
      'web_artifact_storage_bucket_invalid',
      'El bucket de publicaciones web no es válido.'
    );
  }
  return {
    bucket,
    region: String(env.MARKETING_WEB_ARTIFACT_REGION || env.AWS_DEFAULT_REGION || env.AWS_REGION || 'eu-west-3').trim(),
    baseUrl: safeBaseUrl(baseUrl),
    prefix: cleanPrefix(env.MARKETING_WEB_ARTIFACT_PREFIX),
  };
}

function getArtifactStorageMode(env = process.env, { client = null, config = null } = {}) {
  const explicit = String(env.MARKETING_WEB_ARTIFACT_STORE_MODE || '').trim().toLowerCase();
  if (explicit && !['authenticated_db', 's3'].includes(explicit)) {
    throw new WebArtifactStorageError(
      'web_artifact_storage_mode_invalid',
      'MARKETING_WEB_ARTIFACT_STORE_MODE debe ser authenticated_db o s3.'
    );
  }
  if (explicit) return explicit;
  // Preserve explicit/injected S3 callers and existing production setups. A
  // server without S3 configuration falls back to the authenticated control
  // plane backed by the immutable WebArtifact row already persisted.
  if (client || config || (
    String(env.MARKETING_WEB_ARTIFACT_BUCKET || '').trim()
    && String(env.MARKETING_WEB_ARTIFACT_BASE_URL || '').trim()
  )) return 's3';
  return 'authenticated_db';
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function assertArtifactBundle(artifact) {
  const manifest = artifact?.manifest;
  const files = artifact?.files;
  if (
    !manifest
    || typeof manifest !== 'object'
    || Array.isArray(manifest)
    || !/^[a-f0-9]{64}$/.test(String(manifest.artifact_hash || artifact?.artifact_hash || ''))
    || !files
    || typeof files !== 'object'
    || Array.isArray(files)
  ) {
    throw new WebArtifactStorageError(
      'web_artifact_bundle_invalid',
      'El artefacto compilado no tiene un manifest publicable.',
      422
    );
  }
  const manifestPaths = Object.keys(manifest.files || {}).sort();
  const actualPaths = Object.keys(files).sort();
  if (canonicalSerialize(manifestPaths) !== canonicalSerialize(actualPaths)) {
    throw new WebArtifactStorageError(
      'web_artifact_bundle_file_set_mismatch',
      'Los ficheros del artefacto no coinciden con su manifest.',
      422
    );
  }
  const normalized = {};
  for (const path of actualPaths) {
    const safePath = safeFilePath(path);
    const body = Buffer.isBuffer(files[path]) ? files[path] : Buffer.from(String(files[path]), 'utf8');
    const expected = manifest.files[path] || {};
    const actualHash = sha256(body);
    if (
      actualHash !== expected.sha256
      || Number(expected.size_bytes) !== body.length
      || !String(expected.content_type || '').trim()
    ) {
      throw new WebArtifactStorageError(
        'web_artifact_bundle_file_integrity_invalid',
        'Un fichero no coincide con el hash, tamaño o tipo declarado.',
        422,
        { path: safePath }
      );
    }
    normalized[safePath] = {
      body,
      sha256: actualHash,
      contentType: String(expected.content_type),
    };
  }
  return { manifest, files: normalized };
}

function publicUrl(config, key) {
  return `${config.baseUrl}/${key.split('/').map(encodeURIComponent).join('/')}`;
}

function safeInstallationId(value) {
  const id = String(value || '').trim().toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) {
    throw new WebArtifactStorageError(
      'web_artifact_installation_id_invalid',
      'El almacenamiento autenticado requiere una instalación WordPress válida.',
      422
    );
  }
  return id;
}

function artifactApiBase(env = process.env) {
  return safeBaseUrl(env.MARKETING_WEB_API_BASE_URL || 'https://crm.clinicaclick.com');
}

function pathToken(path) {
  return Buffer.from(safeFilePath(path), 'utf8').toString('base64url');
}

function decodePathToken(value) {
  const token = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{2,2048}$/.test(token)) {
    throw new WebArtifactStorageError('web_artifact_file_token_invalid', 'La ruta solicitada no es válida.', 404);
  }
  let decoded;
  try {
    decoded = Buffer.from(token, 'base64url').toString('utf8');
  } catch {
    throw new WebArtifactStorageError('web_artifact_file_token_invalid', 'La ruta solicitada no es válida.', 404);
  }
  if (Buffer.from(decoded, 'utf8').toString('base64url') !== token) {
    throw new WebArtifactStorageError('web_artifact_file_token_invalid', 'La ruta solicitada no es válida.', 404);
  }
  return safeFilePath(decoded);
}

function authenticatedDbStorageDescriptor({ artifact, installationId, env = process.env } = {}) {
  const installation = safeInstallationId(installationId);
  const { manifest, files } = assertArtifactBundle(artifact);
  const artifactHash = String(manifest.artifact_hash);
  const root = `${artifactApiBase(env)}/api/marketing/web-installations/${installation}/artifacts/${artifactHash}`;
  return {
    provider: 'authenticated_db',
    installation_id: installation,
    artifact_hash: artifactHash,
    key_id: null,
    manifest_url: `${root}/manifest`,
    signature_url: `${root}/envelope`,
    files: Object.fromEntries(Object.keys(files).sort().map((path) => [
      path,
      `${root}/files/${pathToken(path)}`,
    ])),
  };
}

async function storeArtifactBundle({
  artifact,
  client = null,
  config = null,
  signer = signWebArtifactManifest,
  installationId = null,
  env = process.env,
  mode = null,
} = {}) {
  const resolvedMode = getArtifactStorageMode({
    ...env,
    ...(mode === null || mode === undefined || mode === ''
      ? {}
      : { MARKETING_WEB_ARTIFACT_STORE_MODE: mode }),
  }, { client, config });
  if (resolvedMode === 'authenticated_db') {
    return authenticatedDbStorageDescriptor({ artifact, installationId, env });
  }
  const resolvedConfig = config || getArtifactStorageConfig(env);
  const { manifest, files } = assertArtifactBundle(artifact);
  const artifactHash = String(manifest.artifact_hash);
  const objectPrefix = `${resolvedConfig.prefix}/${artifactHash}`;
  const s3 = client || new S3Client({ region: resolvedConfig.region });
  const signature = signer(manifest);

  const uploads = [];
  for (const path of Object.keys(files).sort()) {
    const file = files[path];
    const key = `${objectPrefix}/${path}`;
    uploads.push(s3.send(new PutObjectCommand({
      Bucket: resolvedConfig.bucket,
      Key: key,
      Body: file.body,
      ContentType: file.contentType,
      CacheControl: IMMUTABLE_CACHE_CONTROL,
      Metadata: {
        artifact_hash: artifactHash,
        file_sha256: file.sha256,
        sensitivity: 'public',
        immutable: 'true',
      },
    })));
  }
  await Promise.all(uploads);

  const manifestText = canonicalSerialize(manifest);
  const signatureText = canonicalSerialize(signature);
  await Promise.all([
    s3.send(new PutObjectCommand({
      Bucket: resolvedConfig.bucket,
      Key: `${objectPrefix}/manifest.json`,
      Body: Buffer.from(manifestText, 'utf8'),
      ContentType: 'application/json; charset=utf-8',
      CacheControl: MANIFEST_CACHE_CONTROL,
      Metadata: { artifact_hash: artifactHash, sensitivity: 'public', immutable: 'true' },
    })),
    s3.send(new PutObjectCommand({
      Bucket: resolvedConfig.bucket,
      Key: `${objectPrefix}/manifest.sig.json`,
      Body: Buffer.from(signatureText, 'utf8'),
      ContentType: 'application/json; charset=utf-8',
      CacheControl: MANIFEST_CACHE_CONTROL,
      Metadata: { artifact_hash: artifactHash, key_id: signature.key_id, sensitivity: 'public', immutable: 'true' },
    })),
  ]);

  return {
    provider: 's3_immutable',
    region: resolvedConfig.region,
    bucket: resolvedConfig.bucket,
    object_prefix: objectPrefix,
    artifact_hash: artifactHash,
    key_id: signature.key_id,
    manifest_url: publicUrl(resolvedConfig, `${objectPrefix}/manifest.json`),
    signature_url: publicUrl(resolvedConfig, `${objectPrefix}/manifest.sig.json`),
    files: Object.fromEntries(Object.keys(files).sort().map((path) => [
      path,
      publicUrl(resolvedConfig, `${objectPrefix}/${path}`),
    ])),
  };
}

module.exports = {
  IMMUTABLE_CACHE_CONTROL,
  WebArtifactStorageError,
  artifactApiBase,
  assertArtifactBundle,
  authenticatedDbStorageDescriptor,
  decodePathToken,
  getArtifactStorageConfig,
  getArtifactStorageMode,
  pathToken,
  safeFilePath,
  storeArtifactBundle,
};
