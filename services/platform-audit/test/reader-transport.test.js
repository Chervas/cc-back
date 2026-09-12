'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs');
const { execFileSync } = require('node:child_process'); const { generateKeyPairSync, randomUUID } = require('node:crypto');
const { createServer } = require('../src/reader-server'); const { ReaderStore } = require('../src/reader-store');
const { readBatch } = require('../src/reader'); const { fixture } = require('./fixture.cjs'); const { pack, keyFor } = require('../src/event');
const { KEY_ARN } = require('../src/s3'); const { Readable } = require('node:stream');
const { httpsAgentForTestServer } = require('./offline-guard.cjs'); const { createClient } = require('../../../src/lib/auditReaderClient');
test('actual TLS reader verifies signatures and mode grants; wrong CA, user scope and oversharing are rejected', async t => {
  const dir = fs.mkdtempSync('/tmp/cc-audit-reader-tls-'); fs.chmodSync(dir, 0o700);
  const keyFile = dir + '/tls.key'; const certFile = dir + '/tls.crt';
  execFileSync('/usr/bin/openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile,
    '-days', '1', '-subj', '/CN=fictitious-audit-reader', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const keys = generateKeyPairSync('ed25519'); const row = pack(fixture()); let calls = 0;
  const store = new ReaderStore(dir + '/state.sqlite');
  const sharedKey = keys.publicKey.export({ type: 'spki', format: 'pem' });
  assert.throws(() => createServer({ store, read: () => { throw Error('must not read'); }, principals: [
    { keyId: 'viewer', enabled: true, modes: ['confirmed'], publicKey: sharedKey },
    { keyId: 'reconciler', enabled: true, modes: ['reconcile'], publicKey: sharedKey },
  ] }, { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) }), /audit_reader_invalid/);
  const server = createServer({ store, principals: [{ keyId: 'viewer', enabled: true, modes: ['confirmed'], publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }) }],
    read: input => readBatch(input, { send: async () => { calls++; return { Body: Readable.from([row.body]), ContentLength: Buffer.byteLength(row.body),
      ContentType: 'application/json', ChecksumSHA256: Buffer.from(row.digest, 'hex').toString('base64'), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KEY_ARN, VersionId: 'fictitious-version' }; } }) },
  { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); const agent = httpsAgentForTestServer(server);
  t.after(async () => { agent.destroy(); await new Promise(resolve => server.close(resolve)); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const settings = { origin: `https://127.0.0.1:${server.address().port}`, ca: fs.readFileSync(certFile), keyId: 'viewer',
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), agent };
  const command = { mode: 'confirmed', actorId: '1', sessionRef: randomUUID(), refs: [{ key: keyFor(row), digest: row.digest, versionId: 'fictitious-version' }] };
  const client = createClient(settings); assert.equal((await client.read(command)).results[0].body, row.body); assert.equal(calls, 1);
  await assert.rejects(client.read({ ...command, mode: 'reconcile', actorId: 'platform_audit_reconciler', sessionRef: null, refs: [{ ...command.refs[0], versionId: null }] }), /audit_reader_denied/);
  assert.throws(() => client.read({ ...command, actorId: '701' }));
  const foreign = generateKeyPairSync('ed25519');
  await assert.rejects(createClient({ ...settings, privateKey: foreign.privateKey.export({ type: 'pkcs8', format: 'pem' }) }).read(command), /audit_reader_denied/);
  await assert.rejects(createClient({ ...settings, ca: Buffer.from('FICTITIOUS_WRONG_CA') }).read(command), /audit_reader_unavailable/);
  assert.equal(calls, 1);
});
