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
