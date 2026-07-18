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

function routeTreeError(details = undefined) {
  return new WebHostedPublisherError(
    'web_hosted_route_tree_invalid',
    'El árbol de rutas publicadas no es seguro.',
    503,
    details
  );
}

function routeOverlapError({ host, routePath, conflictingPath }) {
  return new WebHostedPublisherError(
    'web_hosted_route_overlap',
    'La ruta se solapa con otra publicación del mismo host.',
    409,
    { host, route_path: routePath, conflicting_path: conflictingPath }
  );
}

function artifactIntegrityError(details = undefined) {
  return new WebHostedPublisherError(
    'web_hosted_artifact_integrity_failed',
    'El artefacto alojado no coincide con su versión inmutable.',
    503,
    details
  );
}

async function lstatOrNull(value) {
  try { return await fs.lstat(value); } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureDirectoryWithoutSymlinks(root, segments) {
  await fs.mkdir(root, { recursive: true, mode: 0o755 });
  const rootStat = await fs.lstat(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw routeTreeError({ segment: '.' });
  let cursor = root;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    try {
      await fs.mkdir(cursor, { mode: 0o755 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    const stat = await fs.lstat(cursor);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw routeTreeError({ segment });
    }
  }
  return cursor;
}

async function assertArtifactPointer({ root, linkPath }) {
  const stat = await lstatOrNull(linkPath);
  if (!stat) return null;
  if (!stat.isSymbolicLink()) throw routeTreeError({ path: path.relative(root, linkPath) });
  let target;
  let artifactsRoot;
  try {
    [target, artifactsRoot] = await Promise.all([
      fs.realpath(linkPath),
      fs.realpath(path.join(root, 'artifacts')),
    ]);
  } catch {
    throw routeTreeError({ path: path.relative(root, linkPath) });
  }
  if (
    path.dirname(target) !== artifactsRoot
    || !/^[a-f0-9]{64}$/.test(path.basename(target))
  ) throw routeTreeError({ path: path.relative(root, linkPath) });
  return target;
}

async function findDescendantPointer({ root, directory, routePrefix }) {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const stat = await fs.lstat(entryPath);
    if (stat.isSymbolicLink()) {
      await assertArtifactPointer({ root, linkPath: entryPath });
      return `${routePrefix}${entry.name}/`;
    }
    if (!stat.isDirectory()) throw routeTreeError({ path: path.relative(root, entryPath) });
    const nested = await findDescendantPointer({
      root,
      directory: entryPath,
      routePrefix: `${routePrefix}${entry.name}/`,
    });
    if (nested) return nested;
  }
  return null;
}

async function removeEmptyDirectoryTree(directory) {
  const stat = await lstatOrNull(directory);
  if (!stat) return;
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw routeTreeError({ path: directory });
  }
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    const entryStat = await fs.lstat(entryPath);
    if (entryStat.isSymbolicLink() || !entryStat.isDirectory()) {
      throw routeTreeError({ path: entryPath });
    }
    await removeEmptyDirectoryTree(entryPath);
  }
  await fs.rmdir(directory);
}

async function pruneEmptyRouteAncestors({ root, host, startDirectory }) {
  const hostRoot = path.join(root, 'routes', host);
  let cursor = startDirectory;
  while (cursor !== hostRoot && cursor.startsWith(`${hostRoot}${path.sep}`)) {
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) throw routeTreeError({ path: path.relative(root, cursor) });
      await fs.rmdir(cursor);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        cursor = path.dirname(cursor);
        continue;
      }
      if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') return;
      throw error;
    }
    cursor = path.dirname(cursor);
  }
}

async function prepareRoutePointerLocation({ root, host, routePath }) {
  const hostRoot = await ensureDirectoryWithoutSymlinks(root, ['routes', host]);
  const pieces = routePath === '/' ? [] : routePath.split('/').filter(Boolean);
  const rootPointer = path.join(hostRoot, '__root__');
  const rootPointerStat = await lstatOrNull(rootPointer);

  if (routePath !== '/' && rootPointerStat) {
    await assertArtifactPointer({ root, linkPath: rootPointer });
    throw routeOverlapError({ host, routePath, conflictingPath: '/' });
  }

  if (routePath === '/') {
    if (rootPointerStat) await assertArtifactPointer({ root, linkPath: rootPointer });
    const entries = await fs.readdir(hostRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '__root__') continue;
      const entryPath = path.join(hostRoot, entry.name);
      const stat = await fs.lstat(entryPath);
      if (stat.isSymbolicLink()) {
        await assertArtifactPointer({ root, linkPath: entryPath });
        throw routeOverlapError({ host, routePath, conflictingPath: `/${entry.name}/` });
      }
      if (!stat.isDirectory()) throw routeTreeError({ path: path.relative(root, entryPath) });
      const descendant = await findDescendantPointer({
        root,
        directory: entryPath,
        routePrefix: `/${entry.name}/`,
      });
      if (descendant) throw routeOverlapError({ host, routePath, conflictingPath: descendant });
    }
    return { linkPath: rootPointer, emptyDirectory: false };
  }

  let cursor = hostRoot;
  for (let index = 0; index < pieces.length; index += 1) {
    const candidate = path.join(cursor, pieces[index]);
    const stat = await lstatOrNull(candidate);
    if (!stat) break;
    const candidateRoute = `/${pieces.slice(0, index + 1).join('/')}/`;
    if (stat.isSymbolicLink()) {
      await assertArtifactPointer({ root, linkPath: candidate });
      if (index < pieces.length - 1) {
        throw routeOverlapError({ host, routePath, conflictingPath: candidateRoute });
      }
      return { linkPath: candidate, emptyDirectory: false };
    }
    if (!stat.isDirectory()) throw routeTreeError({ path: path.relative(root, candidate) });
    if (index === pieces.length - 1) {
      const descendant = await findDescendantPointer({
        root,
        directory: candidate,
        routePrefix: candidateRoute,
      });
      if (descendant) throw routeOverlapError({ host, routePath, conflictingPath: descendant });
      return { linkPath: candidate, emptyDirectory: true };
    }
    cursor = candidate;
  }

  const parentPieces = pieces.slice(0, -1);
  await ensureDirectoryWithoutSymlinks(root, ['routes', host, ...parentPieces]);
  return {
    linkPath: path.join(hostRoot, ...pieces),
    emptyDirectory: false,
  };
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

function buffersEqual(left, right) {
  const a = Buffer.isBuffer(left) ? left : Buffer.from(left);
  const b = Buffer.isBuffer(right) ? right : Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function collectRegularFiles(directory, prefix = '') {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw artifactIntegrityError({ path: prefix || '.' });
  }
  const files = [];
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolute = path.join(directory, entry.name);
    const entryStat = await fs.lstat(absolute);
    if (entryStat.isSymbolicLink()) throw artifactIntegrityError({ path: relative });
    if (entryStat.isDirectory()) {
      files.push(...await collectRegularFiles(absolute, relative));
      continue;
    }
    if (!entryStat.isFile()) throw artifactIntegrityError({ path: relative });
    files.push(relative);
  }
  return files;
}

async function assertMaterializedArtifact({ directory, artifact, signer = signWebArtifactManifest }) {
  const { manifest, files } = assertArtifactBundle(artifact);
  if (path.basename(directory) !== String(manifest.artifact_hash || '')) {
    throw artifactIntegrityError({ path: '.' });
  }
  const expectedSignature = signer(manifest);
  const expectedPaths = [...Object.keys(files), 'manifest.json', 'manifest.sig.json'].sort();
  let actualPaths;
  try {
    actualPaths = (await collectRegularFiles(directory)).sort();
  } catch (error) {
    if (error instanceof WebHostedPublisherError) throw error;
    throw artifactIntegrityError({ path: '.' });
  }
  if (canonicalSerialize(actualPaths) !== canonicalSerialize(expectedPaths)) {
    throw artifactIntegrityError({ path: '.', reason: 'file_set_mismatch' });
  }
  const expectedBodies = {
    ...Object.fromEntries(Object.entries(files).map(([filePath, descriptor]) => [filePath, descriptor.body])),
    'manifest.json': Buffer.from(canonicalSerialize(manifest), 'utf8'),
    'manifest.sig.json': Buffer.from(canonicalSerialize(expectedSignature), 'utf8'),
  };
  for (const [filePath, expected] of Object.entries(expectedBodies)) {
    let actual;
    try {
      actual = await fs.readFile(path.join(directory, ...filePath.split('/')));
    } catch {
      throw artifactIntegrityError({ path: filePath });
    }
    if (!buffersEqual(actual, expected)) throw artifactIntegrityError({ path: filePath });
  }
  return true;
}

async function materializeArtifact({ artifact, root, signer }) {
  const { manifest, files } = assertArtifactBundle(artifact);
  const artifactHash = String(manifest.artifact_hash);
  // Valida/crea la cadena antes de cualquier lstat, mkdir o staging. Un
  // `root/artifacts` convertido en symlink no puede desviar una publicación
  // fuera de MARKETING_WEB_HOSTING_ROOT.
  const artifactsRoot = await ensureDirectoryWithoutSymlinks(root, ['artifacts']);
  const finalDirectory = path.join(artifactsRoot, artifactHash);
  try {
    const stat = await fs.lstat(finalDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('not_directory');
    await assertMaterializedArtifact({ directory: finalDirectory, artifact, signer });
    return { directory: finalDirectory, created: false, signature: null };
  } catch (error) {
    if (error instanceof WebHostedPublisherError) throw error;
    if (error?.code !== 'ENOENT') {
      throw new WebHostedPublisherError(
        'web_hosted_artifact_invalid_existing_path',
        'La ruta del artefacto inmutable ya existe con un formato no válido.'
      );
    }
  }
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
      await assertMaterializedArtifact({ directory: finalDirectory, artifact, signer });
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
      const stat = await fs.lstat(lockPath).catch(() => null);
      if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
        throw new WebHostedPublisherError(
          'web_hosted_route_lock_invalid',
          'El bloqueo de la ruta no es seguro.'
        );
      }
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

async function withHostRouteLock(root, host, callback) {
  const lockRoot = await ensureDirectoryWithoutSymlinks(root, ['route-locks']);
  const lockKey = crypto.createHash('sha256').update(host).digest('hex');
  return withRoutePointerLock(path.join(lockRoot, lockKey), callback);
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
  return withHostRouteLock(root, host, async () => {
    const prepared = await prepareRoutePointerLocation({ root, host, routePath });
    const { linkPath } = prepared;
    if (prepared.emptyDirectory) {
      try {
        await removeEmptyDirectoryTree(linkPath);
      } catch (error) {
        if (error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST') {
          throw routeTreeError({ path: path.relative(root, linkPath) });
        }
        throw error;
      }
    }
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
  return withHostRouteLock(root, normalizedHost, async () => {
    const pieces = normalizedPath === '/' ? [] : normalizedPath.split('/').filter(Boolean);
    const hostRoot = await ensureDirectoryWithoutSymlinks(root, ['routes', normalizedHost, ...pieces.slice(0, -1)]);
    const linkPath = normalizedPath === '/'
      ? path.join(hostRoot, '__root__')
      : path.join(hostRoot, pieces[pieces.length - 1]);
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
      await pruneEmptyRouteAncestors({
        root,
        host: normalizedHost,
        startDirectory: path.dirname(linkPath),
      });
      return { restored: true, reason: 'first_publication_removed', current_artifact_hash: null };
    }
    const previousDirectory = path.join(root, 'artifacts', previousHash);
    const previousStat = await fs.lstat(previousDirectory).catch(() => null);
    if (!previousStat?.isDirectory() || previousStat.isSymbolicLink()) {
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
      artifact,
      host: normalizedHost,
      routePath: normalizedPath,
      hostingRoot: root,
      signer,
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

async function verifyHostedPointer({
  artifactHash,
  artifact = null,
  host,
  routePath = '/',
  hostingRoot = null,
  signer = signWebArtifactManifest,
} = {}) {
  const root = resolveRoot(hostingRoot);
  const linkPath = routeLinkPath(root, host, routePath);
  try {
    const target = await fs.realpath(linkPath);
    const expected = await fs.realpath(path.join(root, 'artifacts', String(artifactHash || '')));
    if (target !== expected) return false;
    if (artifact) {
      if (String(artifact.artifact_hash || artifact.manifest?.artifact_hash || '') !== String(artifactHash || '')) return false;
      await assertMaterializedArtifact({ directory: target, artifact, signer });
    }
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
  assertMaterializedArtifact,
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
