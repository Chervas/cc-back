'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const https = require('node:https'); const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { generateKeyPairSync, randomUUID } = require('node:crypto');
const { httpsAgentForTestServer } = require('../../../services/platform-audit/test/offline-guard.cjs');
const { fixture } = require('../../../services/platform-audit/test/fixture.cjs');
const { pack, keyFor } = require('../../../services/platform-audit/src/event');
const openssl = args => execFileSync('/usr/bin/openssl', args, { stdio: 'ignore' });

for (const mode of ['writer', 'confirmed', 'reconcile']) test(`${mode}: live trust overlap, CA cutover, renewal, rollback and rejection without client restart`, async t => {
  const dir = fs.mkdtempSync('/tmp/cc-audit-trust-'); fs.chmodSync(dir, 0o700);
  const file = name => path.join(dir, name);
  const put = (name, value) => { fs.writeFileSync(file(name + '.next'), value, { mode: 0o600 }); fs.renameSync(file(name + '.next'), file(name)); };
  const cert = name => fs.readFileSync(file(name + '.crt'));
  fs.writeFileSync(file('ca.cnf'), '[req]\ndistinguished_name=dn\n[dn]\n');
  for (const name of ['old', 'ca', 'foreign']) openssl(['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256',
    '-nodes', '-config', file('ca.cnf'), '-keyout', file(name + '.key'), '-out', file(name + '.crt'), '-days', '2', '-subj', '/CN=FICTITIOUS_' + name,
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'subjectAltName=IP:127.0.0.1']);
  openssl(['req', '-new', '-key', file('old.key'), '-out', file('leaf.csr'), '-subj', '/CN=FICTITIOUS_old']);
  fs.writeFileSync(file('ext'), 'basicConstraints=critical,CA:FALSE\nsubjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  for (const [i, name] of ['leaf', 'renewed'].entries()) openssl(['x509', '-req', '-in', file('leaf.csr'), '-CA', file('ca.crt'),
    '-CAkey', file('ca.key'), '-out', file(name + '.crt'), '-days', '1', '-set_serial', String(i + 1), '-extfile', file('ext')]);
  const signing = generateKeyPairSync('ed25519'); put('signing.key', signing.privateKey.export({ type: 'pkcs8', format: 'pem' }));
  put('trust.pem', cert('old'));
  openssl(['verify', '-CAfile', file('trust.pem'), file('old.crt')]);
  const writer = mode === 'writer'; const kind = writer ? 'writer' : 'reader';
  const P = require(`../../../services/platform-audit/src/${kind}-protocol`);
  const row = pack(fixture()); const receipt = { key: keyFor(row), digest: row.digest, versionId: 'fictitious-version' };
  const command = writer ? { version: 1, sourceRoleArn: 'arn:aws:iam::137819318729:role/fictitious-audit-runtime', records: [{ body: row.body, digest: row.digest }] }
    : { mode, actorId: mode === 'confirmed' ? '1' : 'platform_audit_reconciler', sessionRef: mode === 'confirmed' ? randomUUID() : null,
      refs: [{ ...receipt, versionId: mode === 'confirmed' ? receipt.versionId : null }] };
  let calls = 0; let hold = false; let arrived; let release;
  const reached = new Promise(resolve => { arrived = resolve; }); const blocked = new Promise(resolve => { release = resolve; });
  const server = https.createServer({ key: fs.readFileSync(file('old.key')), cert: cert('old') }, async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks); const input = P.inputFor(JSON.parse(raw));
    P.authenticate(raw, req.headers, input, [{ enabled: true, keyId: 'fictitious-' + mode, modes: [mode],
      publicKey: signing.publicKey.export({ type: 'spki', format: 'pem' }) }], Date.now());
    calls++; if (hold) { hold = false; arrived(); await blocked; }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(writer ? { version: 1, requestId: input.requestId, batch: { version: 1, results: [{ eventId: JSON.parse(row.body).eventId,
      digest: row.digest, status: 'delivered', receipt }] } }
      : { version: 1, requestId: input.requestId, mode, results: [{ status: 'verified', receipt, ...(mode === 'confirmed' ? { body: row.body } : {}) }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = httpsAgentForTestServer(server); agent.maxCachedSessions = 0;
  const connect = agent.createConnection;
  agent.createConnection = (options, callback) => {
    assert(Buffer.isBuffer(options.ca)); assert(options.ca.length > 0);
    const socket = connect(options, callback); socket.on('error', error => t.diagnostic(`TLS ${error.code}; completed handlers: ${calls}`)); return socket;
  };
  const lib = require(`../../lib/audit${writer ? 'Writer' : 'Reader'}Client`); const original = lib.createClient;
  t.mock.method(lib, 'createClient', options => original({ ...options, agent }));
  const savedEnv = { ...process.env }; const servicePath = require.resolve(`../../services/platformAudit.${kind}Client`);
  const prefix = writer ? 'PLATFORM_AUDIT_WRITER' : mode === 'confirmed' ? 'PLATFORM_AUDIT_VIEW' : 'PLATFORM_AUDIT_RECONCILE';
  process.env[`PLATFORM_AUDIT_${kind.toUpperCase()}_ORIGIN`] = `https://127.0.0.1:${server.address().port}`;
  process.env[`PLATFORM_AUDIT_${kind.toUpperCase()}_CA_FILE`] = file('trust.pem');
  process.env[prefix + '_KEY_ID'] = 'fictitious-' + mode; process.env[prefix + '_KEY_FILE'] = file('signing.key');
  delete process.env.PLATFORM_AUDIT_READER_TRANSPORT; delete require.cache[servicePath];
  const service = require(servicePath); const call = () => Promise.resolve().then(() => service[writer ? 'write' : 'read'](command));
  t.after(async () => { release(); agent.destroy(); await new Promise(resolve => server.close(resolve));
    delete require.cache[servicePath]; for (const k of Object.keys(process.env)) if (!Object.hasOwn(savedEnv, k)) delete process.env[k];
    Object.assign(process.env, savedEnv); fs.rmSync(dir, { recursive: true, force: true }); });
  await call(); put('trust.pem', Buffer.concat([cert('old'), cert('ca')])); await call();
  hold = true; const held = call(); held.catch(() => {}); await reached;
  server.setSecureContext({ key: fs.readFileSync(file('old.key')), cert: cert('leaf') });
  await call(); release(); await held;
  server.setSecureContext({ key: fs.readFileSync(file('old.key')), cert: cert('renewed') }); await call();
  server.setSecureContext({ key: fs.readFileSync(file('old.key')), cert: cert('old') }); await call();
  server.setSecureContext({ key: fs.readFileSync(file('old.key')), cert: cert('leaf') });
  put('trust.pem', cert('ca')); await call();
  server.setSecureContext({ key: fs.readFileSync(file('old.key')), cert: cert('old') });
  await assert.rejects(call(), new RegExp(`audit_${kind}_unavailable`));
  server.setSecureContext({ key: fs.readFileSync(file('old.key')), cert: cert('leaf') });
  put('trust.pem', cert('foreign')); await assert.rejects(call(), new RegExp(`audit_${kind}_unavailable`));
  put('trust.pem', cert('ca')); fs.chmodSync(file('trust.pem'), 0o644); await assert.rejects(call(), /configuration_invalid/);
  fs.unlinkSync(file('trust.pem')); fs.symlinkSync(file('ca.crt'), file('trust.pem')); await assert.rejects(call(), /configuration_invalid/);
  fs.unlinkSync(file('trust.pem')); await assert.rejects(call());
  put('trust.pem', cert('ca')); await call(); assert.equal(calls, 8, 'failed trust must never retry or reach the handler');
});
