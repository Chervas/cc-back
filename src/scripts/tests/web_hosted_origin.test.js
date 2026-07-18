'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { canonicalSerialize } = require('../../lib/webDocument');
const { signWebArtifactManifest } = require('../../lib/webArtifactSignature');
const { publishHostedArtifact, routeLinkPath } = require('../../services/webHostedPublisher.service');
const { resolveHostedResponse, safeRequestPath } = require('../../services/webHostedOrigin.service');

const signingKeys = crypto.generateKeyPairSync('ed25519');
const signer = (manifest) => signWebArtifactManifest(manifest, {
  privateKey: signingKeys.privateKey,
  publicKey: signingKeys.publicKey,
});

function resolveSigned(options) {
  return resolveHostedResponse({ ...options, publicKey: signingKeys.publicKey });
}

function artifact() {
  const files = {
    'index.html': '<!doctype html><title>Inicio</title>',
    'implantes/index.html': '<!doctype html><title>Implantes</title>',
    'assets/site.123.css': 'body{color:#111}',
  };
  const descriptors = Object.fromEntries(Object.entries(files).map(([filePath, body]) => [filePath, {
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    content_type: filePath.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8',
    size_bytes: Buffer.byteLength(body),
  }]));
  const core = {
    schema_version: 1,
    environment: 'production',
    files: descriptors,
    headers: {
      'content-security-policy': "default-src 'none'",
      'x-content-type-options': 'nosniff',
      'set-cookie': 'forbidden=1',
    },
  };
  const hash = crypto.createHash('sha256').update(canonicalSerialize(core)).digest('hex');
  return { artifact_hash: hash, manifest: { ...core, artifact_hash: hash }, files };
}

test('sirve el puntero publicado con headers firmados y caché según tipo', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-origin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const item = artifact();
  await publishHostedArtifact({ artifact: item, host: 'sites.example.com', routePath: '/demo/', hostingRoot: root, signer });

  const home = await resolveSigned({ host: 'sites.example.com', pathname: '/demo/', hostingRoot: root });
  assert.equal(home.status, 200);
  assert.match(home.body.toString('utf8'), /Inicio/);
  assert.equal(home.headers['content-security-policy'], "default-src 'none'");
  assert.equal(home.headers['set-cookie'], undefined);
  assert.equal(home.headers['cache-control'], 'public, max-age=0, must-revalidate');

  const redirect = await resolveSigned({ host: 'sites.example.com', pathname: '/demo/implantes', hostingRoot: root });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, '/demo/implantes/');
  const page = await resolveSigned({ host: 'sites.example.com', pathname: '/demo/implantes/', hostingRoot: root });
  assert.match(page.body.toString('utf8'), /Implantes/);

  const css = await resolveSigned({ host: 'sites.example.com:443', pathname: '/demo/assets/site.123.css', hostingRoot: root });
  assert.equal(css.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(await resolveHostedResponse({ host: 'unknown.example.com', pathname: '/', hostingRoot: root }), null);
});

test('no expone manifest ni rutas fuera del artefacto y detecta manipulación', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-origin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const item = artifact();
  await publishHostedArtifact({ artifact: item, host: 'sites.example.com', routePath: '/demo/', hostingRoot: root, signer });
  const manifest = await resolveSigned({ host: 'sites.example.com', pathname: '/demo/manifest.json', hostingRoot: root });
  assert.equal(manifest.status, 404);
  assert.throws(() => safeRequestPath('/demo/%2e%2e/secret'));

  const target = await fs.realpath(routeLinkPath(root, 'sites.example.com', '/demo/'));
  await fs.writeFile(path.join(target, 'index.html'), 'tampered');
  await assert.rejects(
    resolveSigned({ host: 'sites.example.com', pathname: '/demo/', hostingRoot: root }),
    (error) => error.code === 'web_hosted_file_hash_mismatch'
  );
});

test('falla cerrado si falta la firma, no coincide o no hay una clave pública válida', async (t) => {
  const cases = [
    {
      label: 'missing-signature',
      mutate: async (target) => fs.unlink(path.join(target, 'manifest.sig.json')),
      options: { publicKey: signingKeys.publicKey },
    },
    {
      label: 'tampered-manifest',
      mutate: async (target) => {
        const manifestPath = path.join(target, 'manifest.json');
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
        manifest.headers['referrer-policy'] = 'unsafe-url';
        await fs.writeFile(manifestPath, canonicalSerialize(manifest));
      },
      options: { publicKey: signingKeys.publicKey },
    },
    {
      label: 'wrong-key',
      mutate: async () => undefined,
      options: { publicKey: crypto.generateKeyPairSync('ed25519').publicKey },
    },
    {
      label: 'missing-key',
      mutate: async () => undefined,
      options: { publicKeyPem: '' },
    },
  ];

  for (const item of cases) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `cc-web-origin-${item.label}-`));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const bundle = artifact();
    await publishHostedArtifact({
      artifact: bundle,
      host: 'sites.example.com',
      routePath: '/demo/',
      hostingRoot: root,
      signer,
    });
    const target = await fs.realpath(routeLinkPath(root, 'sites.example.com', '/demo/'));
    await item.mutate(target);
    await assert.rejects(
      resolveHostedResponse({
        host: 'sites.example.com',
        pathname: '/demo/',
        hostingRoot: root,
        ...item.options,
      }),
      (error) => error.code === 'web_hosted_signature_invalid' && error.status === 503,
      item.label
    );
  }
});

test('revalida la firma en cada lectura y no reutiliza un artefacto alterado', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-origin-reverify-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = artifact();
  await publishHostedArtifact({
    artifact: bundle,
    host: 'sites.example.com',
    routePath: '/demo/',
    hostingRoot: root,
    signer,
  });
  assert.equal((await resolveSigned({
    host: 'sites.example.com', pathname: '/demo/', hostingRoot: root,
  })).status, 200);

  const target = await fs.realpath(routeLinkPath(root, 'sites.example.com', '/demo/'));
  await fs.writeFile(path.join(target, 'manifest.sig.json'), '{"algorithm":"Ed25519"}');
  await assert.rejects(
    resolveSigned({ host: 'sites.example.com', pathname: '/demo/', hostingRoot: root }),
    (error) => error.code === 'web_hosted_signature_invalid'
  );
});

test('la plantilla Nginx permite solo los dos puentes POST y admite el wrapper de eventos', async () => {
  const nginxPath = path.resolve(__dirname, '../../../ops/nginx/sites.clinicaclick.com.conf');
  const source = await fs.readFile(nginxPath, 'utf8');
  const exactLocation = (endpoint) => {
    const escaped = endpoint.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = source.match(new RegExp(`location = ${escaped} \\{([\\s\\S]*?)\\n    \\}`));
    assert.ok(match, `falta el location exacto ${endpoint}`);
    return match[1];
  };
  const intake = exactLocation('/_clinicaclick/intake');
  const events = exactLocation('/_clinicaclick/events');
  assert.match(intake, /limit_except POST \{ deny all; \}/);
  assert.match(events, /limit_except POST \{ deny all; \}/);
  assert.match(events, /client_max_body_size 80k;/);
  assert.match(source, /location \/ \{\s*limit_except GET HEAD \{ deny all; \}/);
});
