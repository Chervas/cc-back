'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { canonicalSerialize } = require('../../lib/webDocument');
const { publishHostedArtifact, routeLinkPath } = require('../../services/webHostedPublisher.service');
const { resolveHostedResponse, safeRequestPath } = require('../../services/webHostedOrigin.service');

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

const signer = () => ({
  signature_version: 1,
  algorithm: 'Ed25519',
  key_id: 'ed25519-test',
  manifest_sha256: 'd'.repeat(64),
  signature: 'AAAA',
});

test('sirve el puntero publicado con headers firmados y caché según tipo', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-origin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const item = artifact();
  await publishHostedArtifact({ artifact: item, host: 'sites.example.com', routePath: '/demo/', hostingRoot: root, signer });

  const home = await resolveHostedResponse({ host: 'sites.example.com', pathname: '/demo/', hostingRoot: root });
  assert.equal(home.status, 200);
  assert.match(home.body.toString('utf8'), /Inicio/);
  assert.equal(home.headers['content-security-policy'], "default-src 'none'");
  assert.equal(home.headers['set-cookie'], undefined);
  assert.equal(home.headers['cache-control'], 'public, max-age=0, must-revalidate');

  const redirect = await resolveHostedResponse({ host: 'sites.example.com', pathname: '/demo/implantes', hostingRoot: root });
  assert.equal(redirect.status, 308);
  assert.equal(redirect.headers.location, '/demo/implantes/');
  const page = await resolveHostedResponse({ host: 'sites.example.com', pathname: '/demo/implantes/', hostingRoot: root });
  assert.match(page.body.toString('utf8'), /Implantes/);

  const css = await resolveHostedResponse({ host: 'sites.example.com:443', pathname: '/demo/assets/site.123.css', hostingRoot: root });
  assert.equal(css.headers['cache-control'], 'public, max-age=31536000, immutable');
  assert.equal(await resolveHostedResponse({ host: 'unknown.example.com', pathname: '/', hostingRoot: root }), null);
});

test('no expone manifest ni rutas fuera del artefacto y detecta manipulación', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-web-origin-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const item = artifact();
  await publishHostedArtifact({ artifact: item, host: 'sites.example.com', routePath: '/demo/', hostingRoot: root, signer });
  const manifest = await resolveHostedResponse({ host: 'sites.example.com', pathname: '/demo/manifest.json', hostingRoot: root });
  assert.equal(manifest.status, 404);
  assert.throws(() => safeRequestPath('/demo/%2e%2e/secret'));

  const target = await fs.realpath(routeLinkPath(root, 'sites.example.com', '/demo/'));
  await fs.writeFile(path.join(target, 'index.html'), 'tampered');
  await assert.rejects(
    resolveHostedResponse({ host: 'sites.example.com', pathname: '/demo/', hostingRoot: root }),
    (error) => error.code === 'web_hosted_file_hash_mismatch'
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
