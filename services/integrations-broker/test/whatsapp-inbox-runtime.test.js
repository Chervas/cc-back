'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os'); const net = require('node:net'); const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { randomUUID, randomBytes, createHmac, X509Certificate } = require('node:crypto');
const runtime = require('../src/whatsapp-inbox-main'); const { PAYLOAD_KEY, createInboxKeyProvider } = require('../src/whatsapp-inbox-key');
const { SECRET_KEY } = require('../src/google-main'); const { createInboxApplicationSecret } = require('../src/whatsapp-inbox-secret');
const { allowPort, removePort } = require('./offline-guard.cjs');
const APP = '0123456789abcdef0123456789abcdef';
function tlsFiles(dir) {
  const run = args => execFileSync('openssl', args, { stdio: 'ignore' });
  const ca = path.join(dir, 'ca.crt'); const caKey = path.join(dir, 'ca.key');
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', caKey, '-out', ca, '-days', '365', '-subj', '/CN=FICTITIOUS_INBOX_CA']);
  const certs = {};
  for (const name of ['server', 'gateway', 'staging', 'unlisted']) {
    const key = path.join(dir, name + '.key'); const csr = path.join(dir, name + '.csr'); const cert = path.join(dir, name + '.crt');
    const ext = path.join(dir, name + '.ext'); fs.writeFileSync(ext, name === 'server'
      ? 'subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' : 'extendedKeyUsage=clientAuth\n');
    run(['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', csr, '-subj', '/CN=FICTITIOUS_' + name]);
    run(['x509', '-req', '-in', csr, '-CA', ca, '-CAkey', caKey, '-CAcreateserial', '-out', cert, '-days', '1', '-extfile', ext]);
    certs[name] = { key, cert, certificateSha256: new X509Certificate(fs.readFileSync(cert)).fingerprint256.replaceAll(':', '').toLowerCase() };
  }
  for (const name of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, name), 0o600);
  return { ...certs, ca };
}
async function fixture(t, { keyPins = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-wa-inbox-runtime-')); fs.chmodSync(dir, 0o700);
  const tls = tlsFiles(dir); const dataKey = randomBytes(32); const awsCalls = []; const events = [];
  let appVersion = randomUUID(); let unavailable = false; let placeholder = false;
  const application = { appId: '101', secretArn: 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/qa/application-Ab1234', versionId: appVersion };
  const secrets = { async send(command) {
    awsCalls.push(command.constructor.name); const input = command.input;
    assert.equal(input.SecretId, application.secretArn);
    if (unavailable) throw Error('FICTITIOUS_AWS_ERROR_WITH_NO_PUBLIC_DETAIL');
    if (command.constructor.name === 'DescribeSecretCommand') return { ARN: application.secretArn, KmsKeyId: SECRET_KEY, VersionIdsToStages: { [appVersion]: ['AWSCURRENT'] } };
    assert.equal(command.constructor.name, 'GetSecretValueCommand'); assert.equal(input.VersionId, application.versionId); assert.equal(input.VersionStage, 'AWSCURRENT');
    return { ARN: application.secretArn, VersionId: appVersion, VersionStages: ['AWSCURRENT'],
      SecretString: JSON.stringify(placeholder ? { version: 1, provider: 'meta-app-unconfigured', appId: '101' } : { version: 1, provider: 'meta-app', appId: '101', appSecret: APP }) };
  } };
  const kms = { async send(command) {
    awsCalls.push(command.constructor.name); assert.equal(command.input.KeyId, PAYLOAD_KEY);
    if (command.constructor.name === 'GenerateDataKeyCommand') return { KeyId: PAYLOAD_KEY, Plaintext: Buffer.from(dataKey), CiphertextBlob: Buffer.from('FICTITIOUS_WRAPPED_KEY') };
    assert.equal(command.constructor.name, 'DecryptCommand');
    assert.equal(command.input.EncryptionContext.appId, '101');
    return { KeyId: PAYLOAD_KEY, EncryptionAlgorithm: 'SYMMETRIC_DEFAULT', Plaintext: Buffer.from(dataKey) };
  } };
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const config = { cohort: runtime.COHORT, enabled: true, consumerEnabled: true, application,
    listenAddress: '127.0.0.1', port, stateFile: path.join(dir, 'inbox.sqlite'), keyManifestFile: path.join(dir, 'data-key.json'),
    tlsKeyFile: tls.server.key, tlsCertFile: tls.server.cert, tlsCaFile: tls.ca,
    bindings: [{ wabaId: '301', phoneIds: ['401'] }],
    auditContext: { tenantRef: 'clinic:71', connectionRef: 'connection:inbox-qa', resourceRef: 'wa-inbox:101', operation: 'whatsapp.webhook.capture', policyVersion: 'qa-v1' },
    limits: { maxRows: 100, maxBytes: 10485760, maxAuditBacklog: 100 },
    principals: ['gateway', 'staging'].map(name => ({ id: name + ':whatsapp-inbox', certificateSha256: tls[name].certificateSha256, maxPerMinute: 600 })) };
  if (keyPins) for (const principal of config.principals) {
    const name = principal.id.split(':')[0];
    principal.publicKeySha256 = require('node:crypto').createHash('sha256').update(new X509Certificate(fs.readFileSync(tls[name].cert)).publicKey.export({type:'spki',format:'der'})).digest('hex');
  }
  const manifest = await createInboxKeyProvider(kms).prepare('101'); fs.writeFileSync(config.keyManifestFile, JSON.stringify(manifest), { mode: 0o600 });
  const file = path.join(dir, 'config.json');
  const awsFactory = async () => ({ secrets, kms, sink: { async write(row) { events.push(JSON.parse(row.event)); return { versionId: 'FICTITIOUS_AUDIT', digest: row.digest }; } }, close() {} });
  let app;
  const start = async () => { fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 }); app = await runtime.main(file, { awsFactory }); };
  await start(); allowPort(port);
  t.after(async () => { await app?.close(); removePort(port); dataKey.fill(0); fs.rmSync(dir, { recursive: true, force: true }); });
  const send = (identity, url, { method = 'POST', body, signature } = {}) => new Promise((resolve, reject) => {
    const raw = Buffer.isBuffer(body) ? body : body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
    const request = https.request({ hostname: '127.0.0.1', port, path: url, method, agent: false, ca: fs.readFileSync(tls.ca), rejectUnauthorized: true,
      ...(identity ? { key: fs.readFileSync(tls[identity].key), cert: fs.readFileSync(tls[identity].cert) } : {}),
      headers: { 'content-type': 'application/json', ...(signature ? { 'x-hub-signature-256': signature } : {}) } }, res => {
      let text = ''; res.on('data', c => { text += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text), cache: res.headers['cache-control'], retry: res.headers['retry-after'] }));
    }); request.once('error', reject); request.end(raw);
  });
  return { dir, tls, config, file, events, awsCalls, send, application, secrets, get app() { return app; },
    rotate() { appVersion = randomUUID(); }, unavailable() { unavailable = true; }, placeholder() { placeholder = true; },
    async restart() { await app.close(); app = null; await start(); }, async stop() { await app.close(); app = null; },
    raw: Buffer.from(JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: '301', changes: [{ field: 'messages',
      value: { metadata: { phone_number_id: '401' }, messages: [{ id: 'synthetic-wamid-1', from: '34000000001', text: { body: 'FICTITIOUS_INBOX_ONLY' } }] } }] }] })) };
}
const BASE = '/v1/whatsapp/inbox';
const packet = raw => ({ body: raw, signature: 'sha256=' + createHmac('sha256', APP).update(raw).digest('hex') });
test('mTLS rejects absent/unlisted certificates and cross-role routes before any secret read', async t => {
  const f = await fixture(t); const baseline = f.awsCalls.length;
  await assert.rejects(f.send(null, BASE, packet(f.raw)));
  assert.equal((await f.send('unlisted', BASE, packet(f.raw))).status, 403);
  assert.equal((await f.send('gateway', BASE + '/pending', { method: 'GET' })).status, 403);
  assert.equal((await f.send('gateway', BASE + '/defer', { body: { receipt: randomUUID(), lease: randomUUID(), reason: 'unsupported_event' } })).status, 403);
  assert.equal((await f.send('staging', BASE, packet(f.raw))).status, 403);
  assert.equal((await f.send('gateway', BASE + '?export=true', packet(f.raw))).status, 403);
  assert.equal(f.awsCalls.length, baseline); assert.equal(f.app.inbox.pending().length, 0);
});
test('consumer can defer its live lease without acknowledging clinical processing',async t=>{
 const f=await fixture(t);await f.send('gateway',BASE,packet(f.raw));
 const pending=await f.send('staging',BASE+'/pending',{method:'GET'});
 assert.ok(pending.body.health.observedAt);const receipt=pending.body.receipts[0].receipt;
 const leased=await f.send('staging',BASE+'/lease',{body:{receipt}});
 const rejected=await f.send('staging',BASE+'/defer',{body:{receipt,lease:randomUUID(),reason:'unsupported_event'}});assert.equal(rejected.status,403);
 const deferred=await f.send('staging',BASE+'/defer',{body:{receipt,lease:leased.body.lease,reason:'unsupported_event'}});
 assert.equal(deferred.status,200);assert.equal(deferred.body.businessProcessed,false);
 const health=await f.send('staging',BASE+'/pending',{method:'GET'});assert.equal(health.body.receipts.length,0);assert.equal(health.body.health.groups[0].review,1);
});
test('TLS receive, durable restart, lease/import confirmation and duplicate preserve one passive message', async t => {
  const f = await fixture(t);
  const receive = await f.send('gateway', BASE, packet(f.raw)); assert.equal(receive.status, 200); assert.equal(receive.cache, 'no-store');
  assert.deepEqual(receive.body, { received: true });
  const pending = await f.send('staging', BASE + '/pending', { method: 'GET' }); assert.equal(pending.body.receipts.length, 1);
  const receipt = pending.body.receipts[0].receipt; await f.restart();
  assert.equal((await f.send('gateway', BASE, packet(f.raw))).status, 200);
  const leased = await f.send('staging', BASE + '/lease', { body: { receipt } }); assert.equal(leased.status, 200);
  assert.equal(leased.body.automaticActionsAllowed, false); assert(Buffer.from(leased.body.rawBase64, 'base64').equals(f.raw));
  assert.equal((await f.send('staging', BASE + '/pending', { method: 'GET' })).body.receipts.length, 0);
  assert.equal((await f.send('staging', BASE + '/lease', { body: { receipt } })).status, 403);
  const complete = { receipt, lease: leased.body.lease, importReceipt: randomUUID() };
  assert.equal((await f.send('gateway', BASE + '/confirm', { body: complete })).status, 403);
  assert.equal((await f.send('staging', BASE + '/confirm', { body: { ...complete, lease: randomUUID() } })).status, 403);
  assert.equal((await f.send('staging', BASE + '/confirm', { body: complete })).body.businessProcessed, true);
  assert.equal((await f.send('staging', BASE + '/confirm', { body: complete })).body.businessProcessed, true);
  assert.equal(f.app.store.db.prepare('SELECT COUNT(*) AS n FROM whatsapp_inbox').get().n, 1);
  await require('../src/audit').drainAudit(f.app.store, { async write(row) { f.events.push(JSON.parse(row.event)); return { versionId: 'FICTITIOUS', digest: row.digest }; } });
  assert(f.events.some(e => e.reason === 'whatsapp_inbox_imported' && e.actorId === 'staging:whatsapp-inbox'));
  assert(!JSON.stringify(f.events).includes('FICTITIOUS_INBOX_ONLY')); assert(!JSON.stringify(f.events).includes(APP));
  assert.equal(f.awsCalls.filter(name => name === 'GenerateDataKeyCommand').length, 1);
});
test('a placeholder, rotated pin or AWS failure returns retryable 503 without accepting data', async t => {
  const f = await fixture(t); f.placeholder();
  const r = await f.send('gateway', BASE, packet(f.raw)); assert.equal(r.status, 503); assert.equal(r.retry, '60');
  assert.equal(f.app.inbox.pending().length, 0); f.rotate();
  assert.equal((await f.send('gateway', BASE, packet(f.raw))).status, 503); f.unavailable();
  const failed = await f.send('gateway', BASE, packet(f.raw)); assert.equal(failed.status, 503); assert(!JSON.stringify(failed).includes('FICTITIOUS_AWS'));
});
test('closed consumer and cross-clinic/key rebinding stay blocked across restart', async t => {
  const f = await fixture(t); f.config.consumerEnabled = false; await f.restart();
  assert.equal((await f.send('gateway', BASE, packet(f.raw))).status, 200);
  assert.equal((await f.send('staging', BASE + '/pending', { method: 'GET' })).status, 503);
  f.config.auditContext.tenantRef = 'clinic:999'; await assert.rejects(f.restart(), { code: 'scope_denied' });
});
test('application secret preserves HMAC errors and wipes the buffer borrowed for synchronous work', async t => {
  const f = await fixture(t); const source = createInboxApplicationSecret(f.secrets, f.application); let borrowed;
  assert.equal(await source.withSecret(secret => { borrowed = secret; assert.equal(secret.toString(), APP); return 7; }), 7);
  assert(borrowed.equals(Buffer.alloc(32))); source.close();
  await assert.rejects(source.withSecret(() => assert.fail('closed secret was used')), { code: 'secret_unavailable' });
  assert.equal((await f.send('gateway', BASE, { body: f.raw, signature: 'sha256=' + '0'.repeat(64) })).status, 401);
});

function renewClient(f, name, { changeKey = false } = {}) {
  const run = args => execFileSync('openssl', args, { stdio: 'ignore' });
  const before = fs.readFileSync(f.tls[name].cert);
  if (changeKey) run(['genpkey','-algorithm','RSA','-pkeyopt','rsa_keygen_bits:2048','-out',f.tls[name].key]);
  run(['req','-new','-key',f.tls[name].key,'-out',f.dir + '/renew.csr','-subj','/CN=FICTITIOUS_' + name]);
  run(['x509','-req','-in',f.dir + '/renew.csr','-CA',f.tls.ca,'-CAkey',f.dir + '/ca.key',
    '-set_serial','984','-out',f.tls[name].cert,'-days','1','-extfile',f.dir + '/' + name + '.ext']);
  fs.chmodSync(f.tls[name].cert,0o600); fs.chmodSync(f.tls[name].key,0o600);
  assert.notDeepEqual(before,fs.readFileSync(f.tls[name].cert));
}
test('opt-in key pins accept renewed client certificates and preserve gateway/consumer separation', async t => {
  const f = await fixture(t, { keyPins: true });
  renewClient(f,'gateway'); renewClient(f,'staging');
  assert.equal((await f.send('gateway',BASE,packet(f.raw))).status,200);
  assert.equal((await f.send('staging',BASE+'/pending',{method:'GET'})).status,200);
  assert.equal((await f.send('gateway',BASE+'/pending',{method:'GET'})).status,403);
  assert.equal((await f.send('staging',BASE,packet(f.raw))).status,403);
  renewClient(f,'gateway',{changeKey:true});
  assert.equal((await f.send('gateway',BASE,packet(f.raw))).status,403);
  await f.restart();
  assert.equal((await f.send('staging',BASE+'/pending',{method:'GET'})).status,200);
});
test('certificate pins remain strict unless key pin migration is explicitly configured', async t => {
  const f = await fixture(t); renewClient(f,'gateway');
  assert.equal((await f.send('gateway',BASE,packet(f.raw))).status,403);
});

test('long-running inbox client adopts a renewed certificate without restarting and rejects a different key',async t=>{
  const f=await fixture(t,{keyPins:true});const events=[];
  const {createInboxClient}=require('../../../src/lib/whatsappInboxClient');
  const client=createInboxClient({origin:'https://127.0.0.1:'+f.config.port,ca:fs.readFileSync(f.tls.ca),
    cert:fs.readFileSync(f.tls.staging.cert),key:fs.readFileSync(f.tls.staging.key),
    readCertificate:()=>fs.readFileSync(f.tls.staging.cert),report:e=>events.push(e)});
  t.after(()=>client.close());
  assert.equal((await client.request('GET','/pending')).status,200);
  renewClient(f,'staging');assert.equal((await client.request('GET','/pending')).status,200);
  assert.equal(events.at(-1).status,'reloaded');
  renewClient(f,'staging',{changeKey:true});assert.equal((await client.request('GET','/pending')).status,200);
  assert.equal(events.at(-1).status,'reload_failed');
  assert.equal((await client.request('POST','',f.raw)).status,403);
  client.close();await assert.rejects(client.request('GET','/pending'),/inbox_unavailable/);
});
