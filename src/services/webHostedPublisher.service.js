'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { canonicalSerialize } = require('../lib/webDocument');
const { signWebArtifactManifest } = require('../lib/webArtifactSignature');
const { assertArtifactBundle, safeFilePath } = require('./webArtifactStorage.service');

const DEFAULT_ROOT = '/var/lib/clinicaclick-web-hosting';
const ROUTE_LOCK_STALE_MS = 30 * 1000;
const ROUTE_LOCK_WAIT_MS = 25;
const ROUTE_LOCK_ATTEMPTS = 200;

class WebHostedPublisherError extends Error {
  constructor(code, message, status = 503, details = undefined) {
    super(message);
    this.name = 'WebHostedPublisherError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

function normalizeHost(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  try {
    const url = new URL(`https://${raw}`);
    if (
      !raw
      || url.hostname !== raw
      || url.port
      || url.username
      || url.password
      || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(raw)
      || /^\d+(?:\.\d+){3}$/.test(raw)
    ) throw new Error('unsafe');
    return raw;
  } catch {
    throw new WebHostedPublisherError('web_publication_host_invalid', 'El host de publicación no es válido.', 422);
  }
}

function normalizeRoutePath(value) {
  const raw = String(value || '/').trim();
  if (!raw.startsWith('/') || raw.includes('?') || raw.includes('#') || raw.includes('\\')) {
    throw new WebHostedPublisherError('web_publication_path_invalid', 'La ruta de publicación no es válida.', 422);
  }
  const pieces = raw.split('/').filter(Boolean);
  if (pieces.some((part) => part === '.' || part === '..' || !/^[a-z0-9][a-z0-9_-]{0,79}$/.test(part))) {
    throw new WebHostedPublisherError('web_publication_path_invalid', 'La ruta de publicación no es válida.', 422);
  }
  return pieces.length ? `/${pieces.join('/')}/` : '/';
}

function resolveRoot(value = process.env.MARKETING_WEB_HOSTING_ROOT) {
  const root = path.resolve(String(value || DEFAULT_ROOT).trim());
  if (!path.isAbsolute(root) || root === '/' || root.length < 8) {
    throw new WebHostedPublisherError('web_hosting_root_invalid', 'La raíz del hosting web no es segura.');
  }
  return root;
}

function routeLinkPath(root, host, routePath) {
  const routeRoot = path.join(root, 'routes', normalizeHost(host));
  const normalized = normalizeRoutePath(routePath);
  return normalized === '/'
    ? path.join(routeRoot, '__root__')
    : path.join(routeRoot, ...normalized.split('/').filter(Boolean));
}

async function writeFileAtomic(filePath, body) {
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o755 });
  await fs.writeFile(filePath, body, { mode: 0o644, flag: 'wx' });
}

async function materializeArtifact({ artifact, root, signer }) {
  const { manifest, files } = assertArtifactBundle(artifact);
  const artifactHash = String(manifest.artifact_hash);
  const artifactsRoot = path.join(root, 'artifacts');
  const finalDirectory = path.join(artifactsRoot, artifactHash);
  try {
    const stat = await fs.stat(finalDirectory);
    if (!stat.isDirectory()) throw new Error('not_directory');
    return { directory: finalDirectory, created: false, signature: null };
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw new WebHostedPublisherError(
        'web_hosted_artifact_invalid_existing_path',
        'La ruta del artefacto inmutable ya existe con un formato no válido.'
      );
    }
  }

  await fs.mkdir(artifactsRoot, { recursive: true, mode: 0o755 });
  const stageDirectory = path.join(artifactsRoot, `.${artifactHash}.${crypto.randomUUID()}.tmp`);
  await fs.mkdir(stageDirectory, { mode: 0o755 });
  try {
    for (const [filePath, descriptor] of Object.entries(files)) {
      const safePath = safeFilePath(filePath);
      await writeFileAtomic(path.join(stageDirectory, ...safePath.split('/')), descriptor.body);
    }
    const signature = signer(manifest);
    await writeFileAtomic(path.join(stageDirectory, 'manifest.json'), Buffer.from(canonicalSerialize(manifest), 'utf8'));
    await writeFileAtomic(path.join(stageDirectory, 'manifest.sig.json'), Buffer.from(canonicalSerialize(signature), 'utf8'));
    try {
      await fs.rename(stageDirectory, finalDirectory);
      return { directory: finalDirectory, created: true, signature };
    } catch (error) {
      if (error?.code !== 'EEXIST' && error?.code !== 'ENOTEMPTY') throw error;
      await fs.rm(stageDirectory, { recursive: true, force: true });
      return { directory: finalDirectory, created: false, signature };
    }
  } catch (cause) {
    await fs.rm(stageDirectory, { recursive: true, force: true }).catch(() => undefined);
    throw cause;
  }
}

async function currentTarget(linkPath) {
  try {
    return await fs.readlink(linkPath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withRoutePointerLock(linkPath, callback) {
  const lockPath = `${linkPath}.lock`;
  const ownerPath = path.join(lockPath, 'owner');
  const owner = crypto.randomUUID();
  for (let attempt = 0; attempt < ROUTE_LOCK_ATTEMPTS; attempt += 1) {
    try {
      await fs.mkdir(lockPath, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat && Date.now() - stat.mtimeMs > ROUTE_LOCK_STALE_MS) {
        await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
      } else {
        await sleep(ROUTE_LOCK_WAIT_MS);
      }
      continue;
    }
    try {
      await fs.writeFile(ownerPath, owner, { mode: 0o600, flag: 'wx' });
    } catch (error) {
      await fs.rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    try {
      return await callback();
    } finally {
      const currentOwner = await fs.readFile(ownerPath, 'utf8').catch(() => null);
      if (currentOwner === owner) await fs.rm(lockPath, { recursive: true, force: true });
    }
  }
  throw new WebHostedPublisherError(
    'web_hosted_route_pointer_busy',
    'La ruta está siendo actualizada por otro proceso. Vuelve a intentarlo.'
  );
}

function artifactHashFromTarget({ root, linkPath, target }) {
  if (!target) return null;
  const absolute = path.resolve(path.dirname(linkPath), target);
  const artifactsRoot = path.join(root, 'artifacts');
  if (path.dirname(absolute) !== artifactsRoot) return null;
  const hash = path.basename(absolute);
  return /^[a-f0-9]{64}$/.test(hash) ? hash : null;
}

async function replaceRoutePointer(linkPath, artifactDirectory) {
  const temporaryLink = `${linkPath}.next.${crypto.randomUUID()}`;
  await fs.symlink(artifactDirectory, temporaryLink, 'dir');
  try {
    await fs.rename(temporaryLink, linkPath);
  } catch (cause) {
    await fs.unlink(temporaryLink).catch(() => undefined);
    throw cause;
  }
}

async function swapRoutePointer({ root, host, routePath, artifactDirectory }) {
  const linkPath = routeLinkPath(root, host, routePath);
  await fs.mkdir(path.dirname(linkPath), { recursive: true, mode: 0o755 });
  return withRoutePointerLock(linkPath, async () => {
    const previousTarget = await currentTarget(linkPath);
    await replaceRoutePointer(linkPath, artifactDirectory);
    return { linkPath, previousTarget };
  });
}

async function restoreHostedRoutePointer({
  host,
  routePath = '/',
  failedArtifactHash,
  previousArtifactHash = null,
  hostingRoot = null,
} = {}) {
  const root = resolveRoot(hostingRoot);
  const normalizedHost = normalizeHost(host);
  const normalizedPath = normalizeRoutePath(routePath);
  const failedHash = String(failedArtifactHash || '').trim().toLowerCase();
  const previousHash = previousArtifactHash == null
    ? null
    : String(previousArtifactHash).trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(failedHash) || (previousHash && !/^[a-f0-9]{64}$/.test(previousHash))) {
    throw new WebHostedPublisherError(
      'web_hosted_compensation_hash_invalid',
      'No se puede restaurar un puntero con hashes no válidos.',
      500
    );
  }
  const linkPath = routeLinkPath(root, normalizedHost, normalizedPath);
  await fs.mkdir(path.dirname(linkPath), { recursive: true, mode: 0o755 });
  return withRoutePointerLock(linkPath, async () => {
    const target = await currentTarget(linkPath);
    const currentHash = artifactHashFromTarget({ root, linkPath, target });
    if (currentHash !== failedHash) {
      return {
        restored: false,
        reason: target ? 'pointer_changed' : 'pointer_missing',
        current_artifact_hash: currentHash,
      };
    }
    if (!previousHash) {
      await fs.unlink(linkPath);
      return { restored: true, reason: 'first_publication_removed', current_artifact_hash: null };
    }
    const previousDirectory = path.join(root, 'artifacts', previousHash);
    const previousStat = await fs.stat(previousDirectory).catch(() => null);
    if (!previousStat?.isDirectory()) {
      throw new WebHostedPublisherError(
        'web_hosted_previous_artifact_unavailable',
        'La última versión válida no está disponible para restaurarla.'
      );
    }
    await replaceRoutePointer(linkPath, previousDirectory);
    return { restored: true, reason: 'previous_artifact_restored', current_artifact_hash: previousHash };
  });
}

async function publishHostedArtifact({
  artifact,
  host,
  routePath = '/',
  hostingRoot = null,
  signer = signWebArtifactManifest,
  verifyPointer = verifyHostedPointer,
} = {}) {
  const root = resolveRoot(hostingRoot);
  const normalizedHost = normalizeHost(host);
  const normalizedPath = normalizeRoutePath(routePath);
  const materialized = await materializeArtifact({ artifact, root, signer });
  const swapped = await swapRoutePointer({
    root,
    host: normalizedHost,
    routePath: normalizedPath,
    artifactDirectory: materialized.directory,
  });
  const artifactHash = String(artifact.manifest.artifact_hash);
  const previousArtifactHash = swapped.previousTarget
    ? path.basename(swapped.previousTarget)
    : null;
  try {
    const verified = await verifyPointer({
      artifactHash,
      host: normalizedHost,
      routePath: normalizedPath,
      hostingRoot: root,
    });
    if (verified) {
      return {
        provider: 'local_atomic_hosting',
        host: normalizedHost,
        path: normalizedPath,
        artifact_hash: artifactHash,
        route_pointer: path.relative(root, swapped.linkPath),
        previous_artifact_hash: previousArtifactHash,
        artifact_created: materialized.created,
        public_url: `https://${normalizedHost}${normalizedPath}`,
        verified: true,
      };
    }
    throw new WebHostedPublisherError(
      'web_hosted_pointer_verification_failed',
      'El origen no ha confirmado el nuevo artefacto.'
    );
  } catch (error) {
    const compensation = await restoreHostedRoutePointer({
      host: normalizedHost,
      routePath: normalizedPath,
      failedArtifactHash: artifactHash,
      previousArtifactHash,
      hostingRoot: root,
    });
    error.pointer_compensation = compensation;
    throw error;
  }
}

async function verifyHostedPointer({ artifactHash, host, routePath = '/', hostingRoot = null } = {}) {
  const root = resolveRoot(hostingRoot);
  const linkPath = routeLinkPath(root, host, routePath);
  try {
    const target = await fs.realpath(linkPath);
    const expected = await fs.realpath(path.join(root, 'artifacts', String(artifactHash || '')));
    if (target !== expected) return false;
    const [manifest, signature, index] = await Promise.all([
      fs.stat(path.join(target, 'manifest.json')),
      fs.stat(path.join(target, 'manifest.sig.json')),
      fs.stat(path.join(target, 'index.html')),
    ]);
    return manifest.isFile() && signature.isFile() && index.isFile();
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_ROOT,
  WebHostedPublisherError,
  normalizeHost,
  normalizeRoutePath,
  publishHostedArtifact,
  restoreHostedRoutePointer,
  resolveRoot,
  routeLinkPath,
  verifyHostedPointer,
};
