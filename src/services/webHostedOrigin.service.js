'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { normalizeHost, resolveRoot } = require('./webHostedPublisher.service');
const { safeFilePath } = require('./webArtifactStorage.service');

const MAX_PATH_BYTES = 2048;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const SAFE_HEADERS = new Set([
  'content-security-policy',
  'cross-origin-opener-policy',
  'cross-origin-resource-policy',
  'permissions-policy',
  'referrer-policy',
  'x-content-type-options',
  'x-frame-options',
]);

class WebHostedOriginError extends Error {
  constructor(code, message, status = 404) {
    super(message);
    this.name = 'WebHostedOriginError';
    this.code = code;
    this.status = status;
  }
}

function requestHost(value) {
  const raw = String(value || '').trim();
  if (!raw || raw.length > 253 || /[\x00-\x20\x7f]/.test(raw)) return null;
  try {
    const url = new URL(`http://${raw}`);
    if (url.username || url.password || (url.port && !['80', '443'].includes(url.port))) return null;
    return normalizeHost(url.hostname);
  } catch {
    return null;
  }
}

function safeRequestPath(value) {
  const raw = String(value || '/').split('?')[0];
  if (!raw.startsWith('/') || Buffer.byteLength(raw, 'utf8') > MAX_PATH_BYTES || raw.includes('\\')) {
    throw new WebHostedOriginError('web_hosted_path_invalid', 'Página no encontrada.');
  }
  const trailingSlash = raw.endsWith('/');
  const segments = raw.split('/').filter(Boolean).map((segment) => {
    let decoded;
    try { decoded = decodeURIComponent(segment); } catch { throw new WebHostedOriginError('web_hosted_path_invalid', 'Página no encontrada.'); }
    if (
      !decoded
      || decoded === '.'
      || decoded === '..'
      || decoded.includes('/')
      || decoded.includes('\\')
      || decoded.startsWith('.')
      || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(decoded)
    ) throw new WebHostedOriginError('web_hosted_path_invalid', 'Página no encontrada.');
    return decoded;
  });
  return { raw, segments, trailingSlash };
}

async function directoryExists(value) {
  try { return (await fs.stat(value)).isDirectory(); } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

async function selectRoute({ root, host, segments }) {
  const hostRoot = path.join(root, 'routes', host);
  if (!await directoryExists(hostRoot)) return null;
  const artifactsRoot = path.join(root, 'artifacts');
  for (let length = segments.length; length >= 0; length -= 1) {
    const candidate = length === 0
      ? path.join(hostRoot, '__root__')
      : path.join(hostRoot, ...segments.slice(0, length));
    try {
      const stat = await fs.lstat(candidate);
      if (!stat.isSymbolicLink()) continue;
      const target = await fs.realpath(candidate);
      const relative = path.relative(artifactsRoot, target);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative) || !/^[a-f0-9]{64}$/.test(path.basename(target))) {
        throw new WebHostedOriginError('web_hosted_pointer_invalid', 'Página temporalmente no disponible.', 503);
      }
      return { target, consumed: length };
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
  }
  return { target: null, consumed: 0 };
}

async function readManifest(target) {
  const manifestPath = path.join(target, 'manifest.json');
  const stat = await fs.stat(manifestPath);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_MANIFEST_BYTES) {
    throw new WebHostedOriginError('web_hosted_manifest_invalid', 'Página temporalmente no disponible.', 503);
  }
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (
    manifest?.environment !== 'production'
    || !/^[a-f0-9]{64}$/.test(String(manifest.artifact_hash || ''))
    || manifest.artifact_hash !== path.basename(target)
    || !manifest.files
    || typeof manifest.files !== 'object'
    || Array.isArray(manifest.files)
  ) throw new WebHostedOriginError('web_hosted_manifest_invalid', 'Página temporalmente no disponible.', 503);
  return manifest;
}

function responseHeaders(manifest, filePath, metadata) {
  const headers = {};
  for (const [name, value] of Object.entries(manifest.headers || {})) {
    const normalizedName = String(name).trim().toLowerCase();
    const normalizedValue = String(value || '').trim();
    if (SAFE_HEADERS.has(normalizedName) && normalizedValue && normalizedValue.length <= 8192 && !/[\r\n]/.test(normalizedValue)) {
      headers[normalizedName] = normalizedValue;
    }
  }
  headers['content-type'] = String(metadata.content_type || 'application/octet-stream');
  headers.etag = `"sha256-${metadata.sha256}"`;
  headers['cache-control'] = filePath.endsWith('.html')
    ? 'public, max-age=0, must-revalidate'
    : filePath.startsWith('assets/')
      ? 'public, max-age=31536000, immutable'
      : 'public, max-age=300, must-revalidate';
  return headers;
}

async function resolveHostedResponse({ host, pathname, hostingRoot = null } = {}) {
  const normalizedHost = requestHost(host);
  if (!normalizedHost) return null;
  const requestPath = safeRequestPath(pathname);
  const root = resolveRoot(hostingRoot);
  const route = await selectRoute({ root, host: normalizedHost, segments: requestPath.segments });
  if (route === null) return null;
  if (!route.target) return { status: 404, headers: { 'cache-control': 'no-store' }, body: Buffer.from('Página no encontrada.') };
  const manifest = await readManifest(route.target);
  const remainder = requestPath.segments.slice(route.consumed);
  let filePath = remainder.join('/');
  if (!filePath || requestPath.trailingSlash) filePath = filePath ? `${filePath}/index.html` : 'index.html';
  if (!requestPath.trailingSlash && filePath && !path.posix.extname(filePath)) {
    const indexPath = safeFilePath(`${filePath}/index.html`);
    if (manifest.files[indexPath]) {
      return {
        status: 308,
        headers: { location: `${requestPath.raw}/`, 'cache-control': 'public, max-age=300' },
        body: Buffer.alloc(0),
      };
    }
  }
  filePath = safeFilePath(filePath);
  const metadata = manifest.files[filePath];
  if (
    !metadata
    || !/^[a-f0-9]{64}$/.test(String(metadata.sha256 || ''))
    || !Number.isSafeInteger(Number(metadata.size_bytes))
    || Number(metadata.size_bytes) < 0
    || Number(metadata.size_bytes) > MAX_RESPONSE_BYTES
  ) return { status: 404, headers: { 'cache-control': 'no-store' }, body: Buffer.from('Página no encontrada.') };
  const file = path.join(route.target, ...filePath.split('/'));
  const realFile = await fs.realpath(file);
  if (!realFile.startsWith(`${route.target}${path.sep}`)) {
    throw new WebHostedOriginError('web_hosted_file_invalid', 'Página temporalmente no disponible.', 503);
  }
  const body = await fs.readFile(realFile);
  const actualHash = crypto.createHash('sha256').update(body).digest('hex');
  if (body.length !== Number(metadata.size_bytes) || actualHash !== metadata.sha256) {
    throw new WebHostedOriginError('web_hosted_file_hash_mismatch', 'Página temporalmente no disponible.', 503);
  }
  return { status: 200, headers: responseHeaders(manifest, filePath, metadata), body };
}

module.exports = {
  MAX_RESPONSE_BYTES,
  SAFE_HEADERS,
  WebHostedOriginError,
  requestHost,
  resolveHostedResponse,
  safeRequestPath,
  selectRoute,
};
