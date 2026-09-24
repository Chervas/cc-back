'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');
const { fixture } = require('./helpers');
const { allowPort, removePort } = require('./offline-guard.cjs');
const { main, validateConfig } = require('../src/public-media-main');
const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
const publicMediaBroker = require('../../../src/services/publicMediaBroker.service');
const L = require('../src/public-media-limits');

const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('FICTITIOUS_PUBLIC_IMAGE')]);

async function setup(t) {
  const f = fixture(t), cert = path.join(f.dir, 'media.crt'), key = path.join(f.dir, 'media.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  fs.chmodSync(cert, 0o600); fs.chmodSync(key, 0o600);
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); allowPort(port);
  const ref = 'public-media:dev';
  const policy = structuredClone(f.policy);
  policy.audience = 'clinicaclick:public-media:dev:v1';
  policy.principals[0].id = ref;
  policy.connections = [{ connectionRef: ref, provider: L.PROVIDER, initialState: 'active' }];
  policy.grants = [{ principalId: ref, tenantRef: 'clinic:1', connectionRef: ref,
    assetRef: 'public-media:clinic:1', operations: [L.OPERATIONS.PUT_EMAIL_IMAGE] }];
  const config = { enabled: true, cohort: 'public-media-email-images-v1', environment: 'dev', policy,
    listenAddress: '127.0.0.1', port, stateFile: path.join(f.dir, 'media.sqlite'), tlsCertFile: cert, tlsKeyFile: key };
  const filename = path.join(f.dir, 'media.json'); fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  const puts = [], events = [];
  const media = { async send(command) { puts.push(command.input); return { ETag: '"fictitious-etag"' }; } };
  const sink = { async write(row) { events.push(JSON.parse(row.event)); return { versionId: 'fictitious-audit', digest: row.digest }; } };
  const runtime = await main(filename, { awsFactory: async () => ({ media, sink, close() {} }) });
  t.after(async () => { publicMediaBroker.resetForTests(); await runtime.close(); removePort(port); });
  const signingKey = path.join(f.dir, 'signing.key');
  fs.writeFileSync(signingKey, f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const env = { PUBLIC_MEDIA_BROKER_ENABLED: 'true', PUBLIC_MEDIA_BROKER_ENVIRONMENT: 'dev',
    PUBLIC_MEDIA_BROKER_ORIGIN: `https://127.0.0.1:${port}`, PUBLIC_MEDIA_BROKER_CONNECTION_REF: ref,
    PUBLIC_MEDIA_BROKER_AUDIENCE: policy.audience, PUBLIC_MEDIA_BROKER_KEY_ID: 'qa-key',
    PUBLIC_MEDIA_BROKER_KEY_FILE: signingKey, PUBLIC_MEDIA_BROKER_CA_FILE: cert };
  const low = createIntegrationsBrokerClient({ origin: env.PUBLIC_MEDIA_BROKER_ORIGIN, audience: env.PUBLIC_MEDIA_BROKER_AUDIENCE,
    keyId: 'qa-key', privateKey: fs.readFileSync(signingKey), ca: fs.readFileSync(cert), timeoutMs: 30000,
    transportProfile: 'public-media' });
  const payload = { scopeType: 'clinic', scopeId: 1, purpose: 'marketing_image', contentType: 'image/png',
    dataBase64: PNG.toString('base64'), sha256: createHash('sha256').update(PNG).digest('hex') };
  const command = (change = {}) => ({ requestId: randomUUID(), operation: L.OPERATIONS.PUT_EMAIL_IMAGE,
    tenantRef: 'clinic:1', connectionRef: ref, assetRef: 'public-media:clinic:1', payload, ...change });
  return { ...f, config, env, runtime, puts, events, low, command };
}

test('signed public-media transport writes a fixed-scope immutable image without exposing AWS credentials', async t => {
  const f = await setup(t);
  const result = await publicMediaBroker.uploadEmailImage({ purpose: 'marketing_image', clinicId: 1,
    contentType: 'image/png', buffer: PNG }, { env: f.env, requestId: '12345678-1234-4234-9234-1234567890ab' });
  assert.equal(result.url, 'https://media.clinicaclick.com/marketing/email/clinic-1/'
    + result.key.split('/').slice(-3).join('/'));
  assert.match(result.key, /^marketing\/email\/clinic-1\/\d{4}\/\d{2}\/12345678-1234-4234-9234-1234567890ab\.png$/);
  assert.equal(result.sha256, createHash('sha256').update(PNG).digest('hex'));
  assert.equal(f.puts.length, 1);
  assert.equal(f.puts[0].Bucket, 'clinicaclick-public-media-eu-west-3');
  assert.equal(f.puts[0].ExpectedBucketOwner, '137819318729');
  assert.equal(f.puts[0].IfNoneMatch, '*');
  assert.deepEqual(f.puts[0].Body, PNG);
  assert.equal(f.puts[0].ACL, undefined);
  const persisted = JSON.stringify(f.runtime.store.db.prepare('SELECT * FROM commands').all());
  assert(!persisted.includes(PNG.toString('base64')));
});

test('broker deduplicates an identical command and rejects scope or content substitution before S3', async t => {
  const f = await setup(t), command = f.command({ requestId: '22345678-1234-4234-9234-1234567890ab' });
  const first = await f.low.execute(command); const replay = await f.low.execute(command);
  assert.equal(first.replayed, false); assert.equal(replay.replayed, true); assert.equal(f.puts.length, 1);
  for (const patch of [{ tenantRef: 'clinic:2' }, { assetRef: 'public-media:clinic:2' },
    { payload: { ...command.payload, scopeId: 2 } }]) {
    await assert.rejects(f.low.execute({ ...command, requestId: randomUUID(), ...patch }), { code: 'scope_denied' });
  }
  const html = Buffer.from('<html>not an image</html>');
  await assert.rejects(f.low.execute({ ...command, requestId: randomUUID(), payload: { ...command.payload,
    dataBase64: html.toString('base64'), sha256: createHash('sha256').update(html).digest('hex') } }), { code: 'invalid_request' });
  assert.equal(f.puts.length, 1);
});

test('runtime configuration admits only exact environment grants and no provider secret', async t => {
  const f = await setup(t);
  assert.equal(validateConfig(structuredClone(f.config)).environment, 'dev');
  const catalogConfig = structuredClone(f.config);
  catalogConfig.policy.grants[0].tenantRef = 'catalog:1';
  catalogConfig.policy.grants[0].assetRef = 'public-media:catalog:1';
  assert.equal(validateConfig(catalogConfig).environment, 'dev');
  for (const mutate of [
    value => { value.environment = 'staging'; },
    value => { value.policy.connections[0].secretArn = 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:forbidden'; },
    value => { value.policy.grants[0].assetRef = 'public-media:clinic:2'; },
    value => { value.policy.grants[0].operations = ['storage.public-media.delete.v1']; },
  ]) {
    const value = structuredClone(f.config); mutate(value); assert.throws(() => validateConfig(value), { code: 'invalid_request' });
  }
});
