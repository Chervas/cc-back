'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const https = require('node:https');
const { execFileSync } = require('node:child_process'); const { generateKeyPairSync } = require('node:crypto');
const { createServer } = require('../src/writer-server'); const { WriterStore } = require('../src/writer-store');
const P = require('../src/writer-protocol'); const { pack, keyFor } = require('../src/event'); const { fixture } = require('./fixture.cjs');
const { httpsAgentForTestServer } = require('./offline-guard.cjs'); const { createClient } = require('../../../src/lib/auditWriterClient');
const sourceRoleArn = 'arn:aws:iam::137819318729:role/fictitious-audit-runtime';
const batch = () => { const row = pack(fixture()); return { version: 1, sourceRoleArn, records: [{ body: row.body, digest: row.digest }] }; };
const success = value => ({ version: 1, results: value.records.map(row => ({ eventId: JSON.parse(row.body).eventId, digest: row.digest,
  status: 'delivered', receipt: { key: keyFor(row), digest: row.digest, versionId: 'fictitious-version' } })) });
async function setup(t, options = {}) {
  const dir = fs.mkdtempSync('/tmp/cc-audit-writer-tls-'); fs.chmodSync(dir, 0o700);
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', dir + '/tls.key',
    '-out', dir + '/tls.crt', '-days', '1', '-subj', '/CN=fictitious-audit-writer', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const keys = generateKeyPairSync('ed25519'); let calls = 0;
  const store = new WriterStore(dir + '/state.sqlite');
  const principals = [{ keyId: 'staging-writer', enabled: true, publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) }];
  const server = createServer({ store, principals, sourceRoleArn, now: options.now || Date.now,
    write: async value => { calls++; return options.write ? options.write(value) : success(value); } },
    { key: fs.readFileSync(dir + '/tls.key'), cert: fs.readFileSync(dir + '/tls.crt') });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = httpsAgentForTestServer(server);
  const settings = { origin: `https://127.0.0.1:${server.address().port}`, ca: fs.readFileSync(dir + '/tls.crt'), agent,
    keyId: 'staging-writer', privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const rawRequest = (signed, change = {}) => new Promise((resolve, reject) => {
    const request = https.request(new URL(P.PATH, settings.origin), { method: 'POST', ca: settings.ca, agent,
      headers: signed.headers, ...change }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }));
      response.on('error', reject);
    }); request.on('error', reject); request.end(signed.raw);
  });
  t.after(async () => { agent.destroy(); await new Promise(resolve => server.close(resolve)); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, store, settings, rawRequest, principals, calls: () => calls, client: createClient(settings) };
}

test('real TLS writer returns validated receipts and persistent replay protection stops a second write', async t => {
  const f = await setup(t); const value = batch();
  assert.deepEqual(await f.client.write(value), success(value)); assert.equal(f.calls(), 1);
  const signed = P.signRequest(batch(), f.settings);
  assert.equal((await f.rawRequest(signed)).status, 200); assert.equal(f.calls(), 2);
  assert.equal((await f.rawRequest(signed)).status, 409); assert.equal(f.calls(), 2);
  const reopened = new WriterStore(f.dir + '/state.sqlite');
  try { assert.throws(() => reopened.accept(f.settings.keyId, signed.input, Date.now()), /audit_writer_replayed/); }
  finally { reopened.close(); }
  const row = f.store.db.prepare('SELECT * FROM writes LIMIT 1').get();
  assert.deepEqual(Object.keys(row).sort(), ['id', 'principal', 'batch_digest', 'count', 'started', 'finished', 'delivered'].sort());
  assert.equal(row.delivered, 1); assert(!JSON.stringify(row).includes('actor'));
});

test('TLS trust, signature, enabled principal, source role and freshness are checked before the writer', async t => {
  const f = await setup(t); const value = batch(); const foreign = generateKeyPairSync('ed25519');
  await assert.rejects(createClient({ ...f.settings, ca: Buffer.from('FICTITIOUS_WRONG_CA') }).write(value), /audit_writer_unavailable/);
  await assert.rejects(createClient({ ...f.settings, privateKey: foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }) }).write(value), /audit_writer_denied/);
  await assert.rejects(createClient({ ...f.settings, keyId: 'not-authorized' }).write(value), /audit_writer_denied/);
  f.principals[0].enabled = false; await assert.rejects(f.client.write(value), /audit_writer_denied/); f.principals[0].enabled = true;
  await assert.rejects(f.client.write({ ...value, sourceRoleArn: 'arn:aws:iam::137819318729:role/another-runtime' }), /audit_writer_denied/);
  for (const offset of [-61000, 61000]) assert.equal((await f.rawRequest(P.signRequest(value, { ...f.settings, now: Date.now() + offset }))).status, 403);
  const tampered = P.signRequest(value, f.settings); tampered.raw = Buffer.from(tampered.raw.toString().replace('fictitious-audit-runtime', 'fictitious-audit-runtimX'));
  assert.equal((await f.rawRequest(tampered)).status, 403); assert.equal(f.calls(), 0);
});

test('closed schema, route, batch limits and reader audience cannot reach AWS writes', async t => {
  const f = await setup(t); const value = batch();
  assert.throws(() => P.signRequest(value, { ...f.settings, keyId: undefined }), /audit_writer_invalid/);
  for (const changed of [{ ...value, endpoint: 'https://forbidden.invalid' }, { ...value, records: [] },
    { ...value, records: Array.from({ length: 51 }, () => value.records[0]) },
    { ...value, records: [{ ...value.records[0], digest: '0'.repeat(64) }] }]) assert.throws(() => f.client.write(changed));
  const readerAudience = P.signRequest(value, f.settings); readerAudience.raw = Buffer.from(readerAudience.raw.toString().replace(P.AUDIENCE, 'clinicaclick-audit-reader-v1'));
  assert.equal((await f.rawRequest(readerAudience)).status, 400);
  assert.equal((await f.rawRequest(P.signRequest(value, f.settings), { path: '/v1/audit/read' })).status, 400);
  const oversize = P.signRequest(value, f.settings); oversize.raw = Buffer.alloc(P.MAX_BYTES + 1, 32);
  oversize.headers['content-length'] = oversize.raw.length;
  assert.equal((await f.rawRequest(oversize)).status, 400);
  assert.equal(f.calls(), 0);
});

test('journal rate limits and failure prevent AWS calls; unknown results cannot become receipts', async t => {
  const now = Date.now(); const f = await setup(t, { now: () => now });
  for (let i = 0; i < 30; i++) { const input = P.signRequest(batch(), f.settings).input; f.store.accept('staging-writer', input, now); f.store.finish(input, success(input.batch), now); }
  await assert.rejects(f.client.write(batch()), /audit_writer_limited/); assert.equal(f.calls(), 0);
  t.mock.method(f.store, 'accept', () => { throw Error('FICTITIOUS_STORAGE_SECRET'); });
  await assert.rejects(f.client.write(batch()), error => { assert.equal(error.code, 'audit_writer_unavailable'); assert(!error.message.includes('SECRET')); return true; });
  assert.equal(f.calls(), 0);
});

test('remote failure or a poisoned receipt never acknowledges a batch and exposes no provider details', async t => {
  let mode = 'error'; const f = await setup(t, { write: value => {
    if (mode === 'error') throw Error('FICTITIOUS_PROVIDER_SECRET');
    const result = success(value); result.results[0].receipt.digest = '0'.repeat(64); return result;
  } });
  for (mode of ['error', 'tamper']) await assert.rejects(f.client.write(batch()), error => { assert(!error.message.includes('SECRET')); return true; });
  assert.equal(f.calls(), 2);
  assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM writes WHERE delivered IS NOT NULL').get().n, 0);
});

test('a transport timeout leaves delivery uncertain without an automatic second request', async t => {
  const f = await setup(t, { write: async value => { await new Promise(resolve => setTimeout(resolve, 80)); return success(value); } });
  await assert.rejects(createClient({ ...f.settings, timeoutMs: 20 }).write(batch()), /audit_writer_unavailable/);
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(f.calls(), 1);
});
