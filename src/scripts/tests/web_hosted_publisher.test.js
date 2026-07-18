'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { canonicalSerialize } = require('../../lib/webDocument');
const {
  normalizeHost,
  normalizeRoutePath,
  publishHostedArtifact,
  restoreHostedRoutePointer,
  routeLinkPath,
  verifyHostedPointer,
} = require('../../services/webHostedPublisher.service');

function artifact(label) {
  const files = { 'index.html': `<!doctype html><title>${label}</title>`, 'assets/site.css': 'body{}' };
  const fileManifest = Object.fromEntries(Object.entries(files).map(([filePath, body]) => [filePath, {
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    content_type: filePath.endsWith('.css') ? 'text/css' : 'text/html',
    size_bytes: Buffer.byteLength(body),
  }]));
  const core = { schema_version: 1, files: fileManifest, label };
  const hash = crypto.createHash('sha256').update(canonicalSerialize(core)).digest('hex');
  return { artifact_hash: hash, manifest: { ...core, artifact_hash: hash }, files };
}

const signer = () => ({
  signature_version: 1,
  algorithm: 'Ed25519',
  key_id: 'ed25519-test',
  manifest_sha256: 'd'.repeat(64),
  signature: 'AAAA',
});

test('normaliza host/ruta y rechaza traversal, IP y puertos', () => {
  assert.equal(normalizeHost('Landing.Example.COM.'), 'landing.example.com');
  assert.equal(normalizeRoutePath('/implantes/barcelona'), '/implantes/barcelona/');
  assert.throws(() => normalizeHost('127.0.0.1'));
  assert.throws(() => normalizeHost('example.com:8443'));
  assert.throws(() => normalizeRoutePath('/../secret'));
});

test('rechaza artifacts symlink antes de escribir fuera del hosting root', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-hosting-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-outside-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true }),
  ]));
  await fs.symlink(outside, path.join(root, 'artifacts'));
  const item = artifact('symlink-parent');
  await assert.rejects(
    () => publishHostedArtifact({
      artifact: item,
      host: 'sites.example.com',
      routePath: '/demo/',
      hostingRoot: root,
      signer,
    }),
    (error) => error.code === 'web_hosted_route_tree_invalid'
  );
  await assert.rejects(() => fs.access(path.join(outside, item.artifact_hash)), { code: 'ENOENT' });
});

test('materializa una vez y conmuta el puntero atómicamente con rollback disponible', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-hosting-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = artifact('first');
  const second = artifact('second');
  const initial = await publishHostedArtifact({
    artifact: first,
    host: 'sites.example.com',
    routePath: '/demo/',
    hostingRoot: root,
    signer,
  });
  assert.equal(initial.verified, true);
  assert.equal(initial.previous_artifact_hash, null);
  assert.equal(await verifyHostedPointer({
    artifactHash: first.artifact_hash,
    host: 'sites.example.com', routePath: '/demo/', hostingRoot: root,
  }), true);

  const next = await publishHostedArtifact({
    artifact: second,
    host: 'sites.example.com',
    routePath: '/demo/',
    hostingRoot: root,
    signer,
  });
  assert.equal(next.previous_artifact_hash, first.artifact_hash);
  assert.equal(await verifyHostedPointer({
    artifactHash: second.artifact_hash,
    host: 'sites.example.com', routePath: '/demo/', hostingRoot: root,
  }), true);

  const rollback = await publishHostedArtifact({
    artifact: first,
    host: 'sites.example.com',
    routePath: '/demo/',
    hostingRoot: root,
    signer,
  });
  assert.equal(rollback.previous_artifact_hash, second.artifact_hash);
  const link = routeLinkPath(root, 'sites.example.com', '/demo/');
  assert.equal(path.basename(await fs.realpath(link)), first.artifact_hash);
  assert.equal((await fs.readdir(path.join(root, 'artifacts'))).filter((name) => !name.startsWith('.')).length, 2);
});

test('una segunda publicación del mismo hash reutiliza artefacto inmutable', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-hosting-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const item = artifact('same');
  const first = await publishHostedArtifact({ artifact: item, host: 'sites.example.com', routePath: '/same/', hostingRoot: root, signer });
  const second = await publishHostedArtifact({ artifact: item, host: 'sites.example.com', routePath: '/same/', hostingRoot: root, signer });
  assert.equal(first.artifact_created, true);
  assert.equal(second.artifact_created, false);
  assert.equal(second.previous_artifact_hash, item.artifact_hash);
});

test('rechaza reutilizar un artefacto alterado o con symlinks aunque conserve el mismo hash', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-hosting-integrity-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-hosting-integrity-outside-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true }),
  ]));
  const item = artifact('immutable');
  await publishHostedArtifact({ artifact: item, host: 'sites.example.com', routePath: '/immutable/', hostingRoot: root, signer });
  const directory = path.join(root, 'artifacts', item.artifact_hash);
  await fs.writeFile(path.join(directory, 'assets', 'site.css'), 'body{color:red}');
  await assert.rejects(
    publishHostedArtifact({ artifact: item, host: 'sites.example.com', routePath: '/immutable/', hostingRoot: root, signer }),
    (error) => error.code === 'web_hosted_artifact_integrity_failed'
      && error.details?.path === 'assets/site.css'
  );

  await fs.writeFile(path.join(outside, 'site.css'), 'body{}');
  await fs.rm(path.join(directory, 'assets', 'site.css'));
  await fs.symlink(path.join(outside, 'site.css'), path.join(directory, 'assets', 'site.css'));
  assert.equal(await verifyHostedPointer({
    artifactHash: item.artifact_hash,
    artifact: item,
    host: 'sites.example.com',
    routePath: '/immutable/',
    hostingRoot: root,
    signer,
  }), false);
});

test('restaura la última versión válida si falla la verificación local y retira una primera publicación fallida', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-hosting-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = artifact('last-known-good');
  const failed = artifact('failed');
  await publishHostedArtifact({
    artifact: first, host: 'sites.example.com', routePath: '/safe/', hostingRoot: root, signer,
  });
  await assert.rejects(
    publishHostedArtifact({
      artifact: failed,
      host: 'sites.example.com',
      routePath: '/safe/',
      hostingRoot: root,
      signer,
      verifyPointer: async () => false,
    }),
    (error) => error.code === 'web_hosted_pointer_verification_failed'
  );
  assert.equal(
    path.basename(await fs.realpath(routeLinkPath(root, 'sites.example.com', '/safe/'))),
    first.artifact_hash
  );

  await assert.rejects(
    publishHostedArtifact({
      artifact: failed,
      host: 'sites.example.com',
      routePath: '/first/',
      hostingRoot: root,
      signer,
      verifyPointer: async () => false,
    }),
    (error) => error.code === 'web_hosted_pointer_verification_failed'
  );
  await assert.rejects(
    fs.lstat(routeLinkPath(root, 'sites.example.com', '/first/')),
    (error) => error.code === 'ENOENT'
  );

  const thrown = artifact('verification-threw');
  await assert.rejects(
    publishHostedArtifact({
      artifact: thrown,
      host: 'sites.example.com',
      routePath: '/safe/',
      hostingRoot: root,
      signer,
      verifyPointer: async () => {
        const error = new Error('readback unavailable');
        error.code = 'readback_unavailable';
        throw error;
      },
    }),
    (error) => error.code === 'readback_unavailable'
      && error.pointer_compensation?.reason === 'previous_artifact_restored'
  );
  assert.equal(
    path.basename(await fs.realpath(routeLinkPath(root, 'sites.example.com', '/safe/'))),
    first.artifact_hash
  );
});

test('una primera publicación anidada fallida limpia directorios vacíos y no bloquea a su ruta padre', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-hosting-empty-route-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const failed = artifact('nested-failed');
  await assert.rejects(
    publishHostedArtifact({
      artifact: failed,
      host: 'sites.example.com',
      routePath: '/campanas/google/implantes/',
      hostingRoot: root,
      signer,
      verifyPointer: async () => false,
    }),
    (error) => error.code === 'web_hosted_pointer_verification_failed'
  );
  await assert.rejects(
    fs.lstat(path.join(root, 'routes', 'sites.example.com', 'campanas')),
    (error) => error.code === 'ENOENT'
  );
  const parent = await publishHostedArtifact({
    artifact: artifact('parent-after-failure'),
    host: 'sites.example.com',
    routePath: '/campanas/',
    hostingRoot: root,
    signer,
  });
  assert.equal(parent.verified, true);
});

test('la compensación no pisa una publicación concurrente más nueva', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-hosting-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const first = artifact('first');
  const failed = artifact('failed');
  const concurrent = artifact('concurrent');
  await publishHostedArtifact({ artifact: first, host: 'sites.example.com', routePath: '/race/', hostingRoot: root, signer });
  await publishHostedArtifact({ artifact: failed, host: 'sites.example.com', routePath: '/race/', hostingRoot: root, signer });
  await publishHostedArtifact({ artifact: concurrent, host: 'sites.example.com', routePath: '/race/', hostingRoot: root, signer });

  const compensation = await restoreHostedRoutePointer({
    host: 'sites.example.com',
    routePath: '/race/',
    failedArtifactHash: failed.artifact_hash,
    previousArtifactHash: first.artifact_hash,
    hostingRoot: root,
  });
  assert.equal(compensation.restored, false);
  assert.equal(compensation.reason, 'pointer_changed');
  assert.equal(
    path.basename(await fs.realpath(routeLinkPath(root, 'sites.example.com', '/race/'))),
    concurrent.artifact_hash
  );
  assert.equal((await fs.readdir(path.join(root, 'artifacts'))).filter((name) => !name.startsWith('.')).length, 3);
});

test('rechaza rutas ancestro/descendiente solapadas sin escribir dentro del artefacto', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-hosting-overlap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const parent = artifact('parent');
  const child = artifact('child');
  await publishHostedArtifact({
    artifact: parent,
    host: 'sites.example.com',
    routePath: '/tratamientos/',
    hostingRoot: root,
    signer,
  });
  await assert.rejects(
    publishHostedArtifact({
      artifact: child,
      host: 'sites.example.com',
      routePath: '/tratamientos/implantes/',
      hostingRoot: root,
      signer,
    }),
    (error) => error.code === 'web_hosted_route_overlap'
      && error.details?.conflicting_path === '/tratamientos/'
  );
  const parentDirectory = await fs.realpath(routeLinkPath(root, 'sites.example.com', '/tratamientos/'));
  await assert.rejects(
    fs.lstat(path.join(parentDirectory, 'implantes')),
    (error) => error.code === 'ENOENT'
  );

  await publishHostedArtifact({
    artifact: child,
    host: 'other.example.com',
    routePath: '/tratamientos/implantes/',
    hostingRoot: root,
    signer,
  });
  await assert.rejects(
    publishHostedArtifact({
      artifact: parent,
      host: 'other.example.com',
      routePath: '/tratamientos/',
      hostingRoot: root,
      signer,
    }),
    (error) => error.code === 'web_hosted_route_overlap'
      && error.details?.conflicting_path === '/tratamientos/implantes/'
  );
});

test('considera la raíz solapada con cualquier ruta del mismo host', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-hosting-root-overlap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const rootArtifact = artifact('root');
  const child = artifact('child');
  await publishHostedArtifact({
    artifact: rootArtifact,
    host: 'root-first.example.com',
    routePath: '/',
    hostingRoot: root,
    signer,
  });
  await assert.rejects(
    publishHostedArtifact({
      artifact: child,
      host: 'root-first.example.com',
      routePath: '/cita/',
      hostingRoot: root,
      signer,
    }),
    (error) => error.code === 'web_hosted_route_overlap'
      && error.details?.conflicting_path === '/'
  );

  await publishHostedArtifact({
    artifact: child,
    host: 'child-first.example.com',
    routePath: '/cita/',
    hostingRoot: root,
    signer,
  });
  await assert.rejects(
    publishHostedArtifact({
      artifact: rootArtifact,
      host: 'child-first.example.com',
      routePath: '/',
      hostingRoot: root,
      signer,
    }),
    (error) => error.code === 'web_hosted_route_overlap'
      && error.details?.conflicting_path === '/cita/'
  );
});

test('no sigue symlinks manipulados al crear host, ancestros o descendientes', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-hosting-symlink-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-hosting-outside-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true }),
  ]));
  const bundle = artifact('symlink-attack');
  await fs.mkdir(path.join(root, 'routes'), { recursive: true });
  await fs.symlink(outside, path.join(root, 'routes', 'host-link.example.com'), 'dir');
  await assert.rejects(
    publishHostedArtifact({
      artifact: bundle,
      host: 'host-link.example.com',
      routePath: '/cita/',
      hostingRoot: root,
      signer,
    }),
    (error) => error.code === 'web_hosted_route_tree_invalid'
  );
  assert.deepEqual(await fs.readdir(outside), []);

  const nestedHost = path.join(root, 'routes', 'nested-link.example.com');
  await fs.mkdir(nestedHost, { recursive: true });
  await fs.symlink(outside, path.join(nestedHost, 'campanas'), 'dir');
  await assert.rejects(
    publishHostedArtifact({
      artifact: bundle,
      host: 'nested-link.example.com',
      routePath: '/campanas/google/',
      hostingRoot: root,
      signer,
    }),
    (error) => error.code === 'web_hosted_route_tree_invalid'
  );
  assert.deepEqual(await fs.readdir(outside), []);

  const descendantHost = path.join(root, 'routes', 'descendant-link.example.com');
  await fs.mkdir(path.join(descendantHost, 'campanas'), { recursive: true });
  await fs.symlink(outside, path.join(descendantHost, 'campanas', 'google'), 'dir');
  await assert.rejects(
    publishHostedArtifact({
      artifact: bundle,
      host: 'descendant-link.example.com',
      routePath: '/campanas/',
      hostingRoot: root,
      signer,
    }),
    (error) => error.code === 'web_hosted_route_tree_invalid'
  );
  assert.deepEqual(await fs.readdir(outside), []);
});

test('serializa publicaciones solapadas concurrentes y solo admite una', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-hosting-overlap-race-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const results = await Promise.allSettled([
    publishHostedArtifact({
      artifact: artifact('race-parent'),
      host: 'sites.example.com',
      routePath: '/campanas/',
      hostingRoot: root,
      signer,
    }),
    publishHostedArtifact({
      artifact: artifact('race-child'),
      host: 'sites.example.com',
      routePath: '/campanas/google/',
      hostingRoot: root,
      signer,
    }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  const rejected = results.find((result) => result.status === 'rejected');
  assert.equal(rejected?.reason?.code, 'web_hosted_route_overlap');
});
