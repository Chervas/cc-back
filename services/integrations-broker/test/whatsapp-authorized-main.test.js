'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const net = require('node:net');
const { execFileSync } = require('node:child_process'); const { randomUUID } = require('node:crypto');
const { fixture, textMessage } = require('./whatsapp-authorized-fixture.cjs'); const { TOKEN, APP } = require('./whatsapp-onboarding-fixture.cjs');
const C = require('../src/whatsapp-authorized-contract'); const E = require('../src/whatsapp-onboarding-contract');
const runtime = require('../src/whatsapp-authorized-main'); const { allowPort, removePort } = require('./offline-guard.cjs');
const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
function config(f) {
  const definition = structuredClone(f.definition); definition.expiresAt = f.f.binding.expiresAt - 1000;
  const policy = structuredClone(f.policy); policy.connections[0].expiresAt = definition.expiresAt;
  return { cohort: C.COHORT, enabled: true, listenAddress: '127.0.0.1', port: 19095,
    stateFile: path.join(f.f.dir, 'runtime.sqlite'), enrollmentStateFile: f.f.filename,
    enrollmentConfigFile: path.join(f.f.dir, 'enrollment-config.json'),
    tlsKeyFile: path.join(f.f.dir, 'tls.key'), tlsCertFile: path.join(f.f.dir, 'tls.crt'), policy, authorizations: [definition] };
}
function writeConfig(f, c) {
  const enrollment = { cohort: E.COHORT, enabled: true, listenAddress: '127.0.0.1', port: 19094,
    stateFile: f.f.filename, tlsKeyFile: c.tlsKeyFile, tlsCertFile: c.tlsCertFile, policy: f.f.policy };
  fs.writeFileSync(c.enrollmentConfigFile, JSON.stringify(enrollment), { mode: 0o600 });
  const filename = path.join(f.f.dir, 'authorized-config.json'); fs.writeFileSync(filename, JSON.stringify(c), { mode: 0o600 });
  return { filename, enrollment };
}
function tlsFiles(c) {
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',c.tlsKeyFile,'-out',c.tlsCertFile,
    '-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  fs.chmodSync(c.tlsKeyFile, 0o600); fs.chmodSync(c.tlsCertFile, 0o600);
}
test('Authorized runtime rejects mixed identities, grants, enrollment slots and aliased paths before AWS', async t => {
  const f = await fixture(t, { enabled: false }); const base = config(f); runtime.validateConfig(base);
  const changes = [c => { c.cohort = 'whatsapp-messaging-v1'; }, c => { c.enabled = false; },
    c => { c.authorizations[0].enabled = 'false'; }, c => { delete c.authorizations[0].enabled; },
    c => { c.policy.principals[0].id = 'dev:whatsapp'; c.policy.grants.filter(g => g.principalId === 'staging:whatsapp').forEach(g => { g.principalId = 'dev:whatsapp'; }); },
    c => { c.policy.principals[1].publicKey = c.policy.principals[0].publicKey; },
    c => { c.policy.principals[0].maxPerMinute = 61; },
    c => { c.policy.grants.pop(); }, c => { c.policy.grants[0].operations = [C.REVOKE]; },
    c => { c.policy.grants[1].operations.push(C.SEND); }, c => { c.policy.grants[0].tenantRef = 'clinic:999'; },
    c => { c.policy.grants[0].assetRef = 'wa-phone:402'; }, c => { c.policy.grants[2] = structuredClone(c.policy.grants[0]); },
    c => { c.policy.connections[0].secretArn = 'bypass'; }, c => { c.policy.connections[0].provider = 'meta_whatsapp'; },
    c => { c.policy.connections[0].expiresAt++; }, c => { c.authorizations[0].candidateDigest = 'x'.repeat(64); },
    c => { c.authorizations[0].enrollmentBinding.secretArn = c.authorizations[0].enrollmentBinding.clientSecretArn; },
    c => { c.authorizations[0].enrollmentBinding.secretArn = c.authorizations[0].enrollmentBinding.secretArn.replace('/prod/', '/dev/'); },
    c => { c.authorizations[0].enrollmentBinding.whatsappOnboarding.scopes.push('ads_management'); },
    c => { c.stateFile = c.enrollmentStateFile; }, c => { c.stateFile = 'relative.sqlite'; },
    c => { c.enrollmentConfigFile = c.tlsKeyFile; }, c => { c.enrollmentStateFile = f.f.dir + '/../state.sqlite'; }];
  let aws = 0;
  for (const change of changes) {
    const c = structuredClone(base); change(c); const filename = path.join(f.f.dir, 'bad.json'); fs.writeFileSync(filename, JSON.stringify(c), { mode: 0o600 });
    await assert.rejects(runtime.main(filename, { awsFactory: async () => { aws++; throw Error('FORBIDDEN_AWS'); } }), { code: 'invalid_request' });
  }
  assert.equal(aws, 0); assert.equal(fs.existsSync(base.stateFile), false);
});
test('An ongoing grant requires an ongoing enrollment; missing and invalid dates stay rejected',async t=>{
 const f=await fixture(t);const c=config(f);
 c.authorizations[0].expiresAt=null;c.policy.connections[0].expiresAt=null;
 assert.throws(()=>runtime.validateConfig(c),{code:'invalid_request'});
 c.authorizations[0].enrollmentBinding.expiresAt=null;
 runtime.validateConfig(c);
 for(const value of [undefined,0,-1,'never',false]){
  const bad=structuredClone(c);bad.authorizations[0].expiresAt=value;bad.policy.connections[0].expiresAt=value;
  assert.throws(()=>runtime.validateConfig(bad),{code:'invalid_request'});
 }
});
test('Private enrollment configuration, ledger identity and TLS are checked before AWS or writable store creation', async t => {
  const f = await fixture(t, { enabled: false }); const c = config(f); const { filename, enrollment } = writeConfig(f, c); tlsFiles(c);
  let aws = 0; const start = () => runtime.main(filename, { awsFactory: async () => { aws++; throw Error('FORBIDDEN_AWS'); } });
  fs.chmodSync(c.enrollmentConfigFile, 0o644); await assert.rejects(start(), { code: 'invalid_request' }); fs.chmodSync(c.enrollmentConfigFile, 0o600);
  fs.chmodSync(c.enrollmentStateFile, 0o644); await assert.rejects(start(), { code: 'invalid_request' }); fs.chmodSync(c.enrollmentStateFile, 0o600);
  fs.linkSync(c.enrollmentStateFile, c.stateFile); await assert.rejects(start(), { code: 'invalid_request' }); fs.unlinkSync(c.stateFile);
  fs.symlinkSync(c.enrollmentStateFile, c.stateFile); await assert.rejects(start(), { code: 'invalid_request' }); fs.unlinkSync(c.stateFile);
  const changed = structuredClone(enrollment); changed.policy.connections[0].whatsappOnboarding.configId = '999';
  fs.writeFileSync(c.enrollmentConfigFile, JSON.stringify(changed)); await assert.rejects(start(), { code: 'invalid_request' });
  fs.writeFileSync(c.enrollmentConfigFile, JSON.stringify(enrollment));
  fs.writeFileSync(c.tlsKeyFile, 'FICTITIOUS_INVALID_KEY'); await assert.rejects(start(), { code: 'invalid_request' });
  assert.equal(aws, 0); assert.equal(fs.existsSync(c.stateFile), false);
});
test('Disabled authorizations serve signed TLS denials with zero secret/provider reads and survive graceful restart', async t => {
  const f = await fixture(t, { enabled: false }); const c = config(f); tlsFiles(c);
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0,'127.0.0.1',resolve)); c.port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const { filename } = writeConfig(f, c); let opened = 0; let closed = 0; let secretCalls = 0; let providerCalls = 0; const events = [];
  const sink = { async write(row) { events.push(JSON.parse(row.event)); return { versionId: 'FICTITIOUS_AUDIT', digest: row.digest }; } };
  const start = () => runtime.main(filename, { awsFactory: async () => { opened++; return {
    secrets: { async send() { secretCalls++; throw Error('FORBIDDEN_SECRET_READ'); } }, sink, close() { closed++; } }; },
    http: async () => { providerCalls++; throw Error('FORBIDDEN_PROVIDER_CALL'); } });
  const before = f.f.snapshot(); let app = await start(); allowPort(c.port);
  t.after(async () => { if (app) await app.close(); removePort(c.port); });
  const caller = createIntegrationsBrokerClient({ origin: `https://127.0.0.1:${c.port}`, audience: c.policy.audience,
    keyId: 'qa-staging', privateKey: f.f.gateway.privateKey.export({ type: 'pkcs8', format: 'pem' }), ca: fs.readFileSync(c.tlsCertFile) });
  const request = () => ({ requestId: randomUUID(), tenantRef: 'clinic:71', connectionRef: c.authorizations[0].connectionRef,
    assetRef: 'wa-phone:401', operation: C.SEND, payload: { authorizationId: c.authorizations[0].authorizationId, phoneId: '401', message: textMessage() } });
  await assert.rejects(caller.execute(request()), { code: 'connection_blocked' });
  assert.equal(secretCalls, 0); assert.equal(providerCalls, 0); assert.equal(app.store.db.prepare('SELECT COUNT(*) n FROM commands').get().n, 0);
  await Promise.all([app.close(),app.close()]); app = null;
  assert.equal(closed, 1); assert.equal(f.f.snapshot(), before);
  app = await start(); await assert.rejects(caller.execute(request()), { code: 'connection_blocked' }); await app.close(); app = null;
  assert.equal(opened, 2); assert.equal(closed, 2); assert.equal(secretCalls, 0); assert.equal(providerCalls, 0); assert.equal(f.f.snapshot(), before);
  assert(events.some(e => e.action === 'integration.denied' && e.reason === 'connection_blocked'));
  for (const value of [TOKEN, APP, textMessage().text.body]) assert(!JSON.stringify(events).includes(value));
});
test('AWS startup failure closes the readonly registry and leaves enrollment unchanged without provider calls', async t => {
  const f = await fixture(t, { enabled: false }); const c = config(f); tlsFiles(c); const { filename } = writeConfig(f, c);
  const before = f.f.snapshot(); let aws = 0; let calls = 0;
  await assert.rejects(runtime.main(filename, { awsFactory: async () => { aws++; throw Error('FICTITIOUS_STARTUP_FAILURE'); },
    http: async () => { calls++; throw Error('FORBIDDEN_PROVIDER_CALL'); } }), /FICTITIOUS_STARTUP_FAILURE/);
  assert.equal(aws, 1); assert.equal(calls, 0); assert.equal(f.f.snapshot(), before);
  // Removal succeeds after cleanup; reopening the original enrollment is still functional.
  assert.equal((await f.f.status({ flowId: f.definition.authorizationId })).data.status, 'staged');
});

test('Multiple phones may share exactly one immutable enrollment binding without sharing operational identity or grants', async t => {
  const f=await fixture(t,{enabled:false}),base=config(f),a=structuredClone(base.authorizations[0]);
  a.connectionRef='connection:authorized-second';a.authorizationId=randomUUID();a.phoneId='402';
  base.authorizations.push(a);base.policy.connections.push({...base.policy.connections[0],connectionRef:a.connectionRef});
  base.policy.grants.push(...base.policy.grants.map(g=>({...g,connectionRef:a.connectionRef,assetRef:'wa-phone:402'})));
  assert.equal(runtime.validateConfig(base),base);
  for(const change of [c=>{c.authorizations[1].phoneId='401';},c=>{c.authorizations[1].authorizationId=c.authorizations[0].authorizationId;},
    c=>{c.authorizations[1].enrollmentBinding.whatsappOnboarding.clinicIds=[71];},
    c=>{c.authorizations[1].enrollmentBinding.secretArn+='other';},
    c=>{c.authorizations[1].enrollmentBinding.whatsappOnboarding.configId='999';},
    c=>{c.authorizations[1].enrollmentBinding.connectionRef+='other';},
    c=>{c.authorizations[1].enrollmentBinding.initialState='blocked';},
    c=>{c.policy.grants.at(-1).tenantRef='clinic:999';}]){
    const changed=structuredClone(base);change(changed);assert.throws(()=>runtime.validateConfig(changed));
  }
  assert(base.authorizations.every(v=>v.enabled===false));
});

test('DEV identity is optional, distinct and granted per clinic/phone without replacing public grants', async t => {
  const f = await fixture(t); const c = config(f);
  const key = require('node:crypto').generateKeyPairSync('ed25519');
  c.policy.principals.push({ id: 'dev:whatsapp', keyId: 'dev-whatsapp-v1', enabled: true, maxPerMinute: 30,
    publicKey: key.publicKey.export({ type: 'spki', format: 'pem' }) });
  runtime.validateConfig(c); // A key alone grants no access.
  const grant = { ...c.policy.grants[0], principalId: 'dev:whatsapp', operations: [require('../src/whatsapp-inbound-media').READ] };
  c.policy.grants.push(grant); runtime.validateConfig(c);
  for (const change of [v => { v.policy.grants.at(-1).operations = [C.REVOKE]; },
    v => { v.policy.grants.at(-1).tenantRef = 'clinic:999'; },
    v => { v.policy.principals.at(-1).publicKey = v.policy.principals[0].publicKey; },
    v => { v.policy.grants.push(structuredClone(v.policy.grants.at(-1))); },
    v => { v.policy.grants.splice(0, 1); },
    v => { v.policy.principals.at(-1).id = 'prod:whatsapp'; }]) {
    const bad = structuredClone(c); change(bad);
    assert.throws(() => runtime.validateConfig(bad), { code: 'invalid_request' });
  }
});
