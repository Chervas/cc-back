'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const { canonicalSerialize } = require('../../lib/webDocument');
const { MAX_WEB_ARTIFACT_BUNDLE_BYTES } = require('../../lib/webArtifactBudget');
const {
  WebArtifactStorageError,
  authenticatedDbStorageDescriptor,
  assertArtifactBundle,
  decodePathToken,
  getArtifactStorageConfig,
  getArtifactStorageMode,
  pathToken,
  safeFilePath,
  storeArtifactBundle,
} = require('../../services/webArtifactStorage.service');

function fixture() {
  const files = {
    'assets/styles.css': 'body{}',
    'index.html': '<!doctype html><title>Test</title>',
  };
  const fileManifest = Object.fromEntries(Object.entries(files).map(([path, body]) => [path, {
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    content_type: path.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8',
    size_bytes: Buffer.byteLength(body),
  }]));
  const core = { schema_version: 1, files: fileManifest };
  const artifactHash = crypto.createHash('sha256').update(canonicalSerialize(core)).digest('hex');
  return {
    artifact_hash: artifactHash,
    manifest: { ...core, artifact_hash: artifactHash },
    files,
  };
}

test('valida rutas y exige configuración exclusiva', () => {
  assert.equal(safeFilePath('assets/styles.a.css'), 'assets/styles.a.css');
  assert.throws(() => safeFilePath('../secret'), WebArtifactStorageError);
  assert.throws(() => getArtifactStorageConfig({}), /bucket exclusivo/);
  assert.throws(() => getArtifactStorageConfig({ MARKETING_WEB_ARTIFACT_BUCKET: 'valid-bucket' }), /URL pública/);
  assert.equal(getArtifactStorageMode({}), 'authenticated_db');
  assert.equal(getArtifactStorageMode({
    MARKETING_WEB_ARTIFACT_BUCKET: 'valid-bucket',
    MARKETING_WEB_ARTIFACT_BASE_URL: 'https://artifacts.example.test',
  }), 's3');
  assert.equal(getArtifactStorageMode({ MARKETING_WEB_ARTIFACT_STORE_MODE: 'authenticated_db' }), 'authenticated_db');
  assert.throws(
    () => getArtifactStorageMode({ MARKETING_WEB_ARTIFACT_STORE_MODE: 'filesystem' }),
    (error) => error.code === 'web_artifact_storage_mode_invalid'
  );
});

test('rechaza un artifact_hash que no deriva del manifest canónico o no coincide con la fila', () => {
  const canonical = fixture();
  const forgedManifest = {
    ...canonical,
    artifact_hash: 'f'.repeat(64),
    manifest: { ...canonical.manifest, artifact_hash: 'f'.repeat(64) },
  };
  assert.throws(
    () => assertArtifactBundle(forgedManifest),
    (error) => error.code === 'web_artifact_bundle_hash_invalid'
  );
  assert.throws(
    () => assertArtifactBundle({ ...canonical, artifact_hash: 'e'.repeat(64) }),
    (error) => error.code === 'web_artifact_bundle_hash_invalid'
  );
  assert.throws(
    () => assertArtifactBundle({ ...canonical, artifactHash: 'e'.repeat(64) }),
    (error) => error.code === 'web_artifact_bundle_hash_invalid'
  );
});

test('fallback DB genera URLs opacas mismo origen y no duplica el artefacto', async () => {
  const artifact = fixture();
  const installationId = 'd6d6d9bb-093e-4a40-8465-5ebf9edcde44';
  const env = { MARKETING_WEB_API_BASE_URL: 'https://crm.clinicaclick.com' };
  const descriptor = authenticatedDbStorageDescriptor({ artifact, installationId, env });
  const stored = await storeArtifactBundle({ artifact, installationId, env });
  assert.deepEqual(stored, descriptor);
  assert.equal(stored.provider, 'authenticated_db');
  assert.equal(stored.manifest_url.startsWith('https://crm.clinicaclick.com/api/marketing/web-installations/'), true);
  for (const [path, url] of Object.entries(stored.files)) {
    const token = url.split('/').pop();
    assert.equal(decodePathToken(token), path);
    assert.equal(pathToken(path), token);
  }
  assert.throws(() => decodePathToken(Buffer.from('../secret').toString('base64url')), WebArtifactStorageError);
  await assert.rejects(
    () => storeArtifactBundle({ artifact, installationId, env, mode: 'filesystem' }),
    (error) => error.code === 'web_artifact_storage_mode_invalid'
  );
});

test('rechaza diferencias de hash, tamaño y conjunto de ficheros', () => {
  const good = fixture();
  assert.equal(Object.keys(assertArtifactBundle(good).files).length, 2);
  assert.throws(() => assertArtifactBundle({ ...good, files: { ...good.files, 'extra.txt': 'x' } }), /no coinciden/);
  assert.throws(() => assertArtifactBundle({ ...good, files: { ...good.files, 'index.html': 'alterado' } }), /hash/);
});

test('rechaza un bundle que supera el contrato común antes de almacenarlo', async () => {
  const body = Buffer.alloc(MAX_WEB_ARTIFACT_BUNDLE_BYTES, 1);
  const core = {
    schema_version: 1,
    files: {
      'index.html': {
        sha256: crypto.createHash('sha256').update(body).digest('hex'),
        content_type: 'text/html; charset=utf-8',
        size_bytes: body.length,
      },
    },
  };
  const artifactHash = crypto.createHash('sha256').update(canonicalSerialize(core)).digest('hex');
  const artifact = {
    artifact_hash: artifactHash,
    manifest: { ...core, artifact_hash: artifactHash },
    files: { 'index.html': body },
  };
  let uploads = 0;
  await assert.rejects(
    () => storeArtifactBundle({
      artifact,
      client: { async send() { uploads += 1; } },
      config: {
        bucket: 'clinicaclick-web-artifacts',
        region: 'eu-west-3',
        baseUrl: 'https://artifacts.example.test',
        prefix: 'web-artifacts/v1',
      },
    }),
    (error) => error.code === 'web_artifact_bundle_too_large'
  );
  assert.equal(uploads, 0);
});

test('sube primero ficheros y después envelope firmado bajo prefijo inmutable', async () => {
  const calls = [];
  const client = { send: async (command) => { calls.push(command.input); return { ETag: 'ok' }; } };
  const artifact = fixture();
  const result = await storeArtifactBundle({
    artifact,
    client,
    config: {
      bucket: 'clinicaclick-web-artifacts',
      region: 'eu-west-3',
      baseUrl: 'https://artifacts.example.test',
      prefix: 'web-artifacts/v1',
    },
    signer: () => ({
      signature_version: 1,
      algorithm: 'Ed25519',
      key_id: 'ed25519-test',
      manifest_sha256: 'c'.repeat(64),
      signature: 'AAAA',
    }),
  });
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.CacheControl.includes('immutable')));
  assert.deepEqual(calls.slice(0, 2).map((call) => call.Key), [
    `web-artifacts/v1/${artifact.artifact_hash}/assets/styles.css`,
    `web-artifacts/v1/${artifact.artifact_hash}/index.html`,
  ]);
  assert.deepEqual(calls.slice(2).map((call) => call.Key).sort(), [
    `web-artifacts/v1/${artifact.artifact_hash}/manifest.json`,
    `web-artifacts/v1/${artifact.artifact_hash}/manifest.sig.json`,
  ]);
  assert.match(result.manifest_url, new RegExp(artifact.artifact_hash));
  assert.equal(result.files['index.html'].endsWith('/index.html'), true);
});
