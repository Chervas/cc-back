'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const net = require('node:net'); const { execFileSync } = require('node:child_process');
const { randomUUID, randomBytes } = require('node:crypto');
const { provisioningFixture } = require('./whatsapp-provisioning-fixture.cjs');
const { allowPort, removePort } = require('./offline-guard.cjs');
const { configuredClient, configuration } = require('../../../src/lib/whatsappOnboardingBrokerClient');
const runtime = require('../src/whatsapp-onboarding-main'); const C = require('../src/whatsapp-onboarding-contract');
const { enrollmentLoader } = require('../src/whatsapp-enrollment-loader');
const { createWhatsappAuthorizedRegistry } = require('../src/whatsapp-authorized-registry');
const A = require('../src/whatsapp-authorized-contract'); const P = require('../src/whatsapp-provisioning-contract');
test('Configured gateway automatically prepares a previously unknown clinic over signed TLS, completes OAuth and lists after restart', async t => {
  const p = provisioningFixture(t), f = p.f, file = name => f.dir + '/' + name;
  const cert = file('tls.crt'), key = file('tls.key');
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1',
    '-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  for (const name of [cert,key]) fs.chmodSync(name, 0o600);
  const probe = net.createServer(); await new Promise(r => probe.listen(0,'127.0.0.1',r));
  const port = probe.address().port; await new Promise(r => probe.close(r)); allowPort(port);
  const policy = { ...f.policy, connections: [], grants: [] };
  const cfg = { enabled: true, cohort: C.COHORT, listenAddress: '127.0.0.1', port,
    stateFile: file('runtime.sqlite'), tlsCertFile: cert, tlsKeyFile: key, policy, provisioning: p.settings };
  fs.writeFileSync(file('broker.json'), JSON.stringify(cfg), { mode: 0o600 });
  const start = () => runtime.main(file('broker.json'), { awsFactory: async () => ({ secrets: p.aws,
    sink: { write: async row => ({ digest: row.digest, versionId: 'FICTITIOUS_AUDIT_VERSION' }) }, close() {} }),
    http: f.http, exchangeFactory: f.exchangeFactory });
  let app = await start(); t.after(async () => { if (app) await app.close(); removePort(port); });
  const signing = file('gateway.pem'); fs.writeFileSync(signing,f.gateway.privateKey.export({type:'pkcs8',format:'pem'}),{mode:0o600});
  fs.writeFileSync(file('state.key'), Buffer.alloc(32,7), {mode:0o600});
  const gateway = { version:1,origin:`https://127.0.0.1:${port}`,audience:f.policy.audience,keyId:'qa-gateway',
    privateKeyFile:signing,caFile:cert,bindings:[],automatic:p.publicTemplate };
  fs.writeFileSync(file('gateway.json'), JSON.stringify(gateway), {mode:0o600});
  const env = { WHATSAPP_ONBOARDING_ENABLED:'true',RUNTIME_ROLE:'gateway',JOB_RUNTIME_NAMESPACE:'gateway',QUEUE_PREFIX:'gateway',
    JOBS_WORKER_ENABLED:'false',CRON_ENABLED:'false',AUTH_SESSION_MODE:'enforce',AUTH_EMAIL_MFA_MODE:'enforce',
    PLATFORM_AUDIT_AUTH_ENABLED:'true',PLATFORM_AUDIT_AUTH_POLICY:'auth-durable-v1',PLATFORM_AUDIT_WHATSAPP_ONBOARDING_ENABLED:'true',
    PLATFORM_AUDIT_WHATSAPP_ONBOARDING_POLICY:'whatsapp-onboarding-v1',WHATSAPP_ONBOARDING_STATE_KEY_FILE:file('state.key'),
    WHATSAPP_ONBOARDING_BROKER_CONFIG_FILE:file('gateway.json') };
  const client = configuredClient({ environment:() => env });
  const row = {requestId:randomUUID(),status:'awaiting',scope:{type:'clinic',id:123},clinicIds:[123],
    scopeDigest:C.hash('FICTITIOUS_CLINIC_SCOPE'),clinicSetDigest:C.hash('[123]'),state:randomBytes(32).toString('base64url'),
    expiresAt:new Date(Date.now()+599000).toISOString()};
  const begin = await client.begin(row); assert.equal(begin.authorization.configId,'102'); assert.equal(p.metadata.size,1);
  assert.equal((await client.finish(row,{state:row.state,code:'FICTITIOUS_TLS_AUTO_CODE',wabaId:'301',phoneId:'401'})).status,'staged');
  const loadEnrollmentBinding = enrollmentLoader({enrollmentConfigFile:file('broker.json'),enrollmentStateFile:cfg.stateFile});
  const enrollmentBinding = loadEnrollmentBinding(P.connectionRef('clinic:123'));
  assert.equal(enrollmentBinding.whatsappOnboarding.scopeKey,'clinic:123');
  const staged = app.store.db.prepare('SELECT * FROM whatsapp_onboarding_flows WHERE id=?').get(row.requestId);
  const definition = {connectionRef:'wa-operational:123',authorizationId:row.requestId,enrollmentBinding,phoneId:'401',wabaId:'301',
    candidateDigest:staged.secret_digest,expiresAt:null,enabled:false};
  let registry = createWhatsappAuthorizedRegistry({filename:cfg.stateFile,authorizations:[definition],loadEnrollmentBinding});
  const operationalBinding = {connectionRef:definition.connectionRef,provider:A.PROVIDER};
  try {
    assert.equal(registry.review(operationalBinding).definition.authorizationId,row.requestId);
    assert.throws(()=>registry.assert(operationalBinding),{code:'connection_blocked'});
  } finally {registry.close();}
  registry = createWhatsappAuthorizedRegistry({filename:cfg.stateFile,authorizations:[{...definition,enabled:true}],loadEnrollmentBinding});
  try {assert.equal(registry.assert(operationalBinding).metadata.phoneId,'401');} finally {registry.close();}
  const changedCapacity = {...cfg,provisioning:{...cfg.provisioning,maxConnections:cfg.provisioning.maxConnections+1}};
  fs.writeFileSync(file('broker.json'),JSON.stringify(changedCapacity));
  assert.equal(C.fingerprint(loadEnrollmentBinding(P.connectionRef('clinic:123'))),C.fingerprint(enrollmentBinding));
  fs.writeFileSync(file('broker.json'),JSON.stringify({...changedCapacity,provisioning:{...changedCapacity.provisioning,configId:'103'}}));
  assert.throws(()=>loadEnrollmentBinding(P.connectionRef('clinic:123')),{code:'scope_denied'});
  fs.writeFileSync(file('broker.json'),JSON.stringify(cfg));
  const creates = p.state.creates; await app.close(); app = await start();
  assert.equal((await client.statusReadOnly(row)).status,'staged'); assert.equal(p.state.creates,creates);
  assert.equal((await client.begin({...row,requestId:randomUUID(),state:randomBytes(32).toString('base64url')})).status,'awaiting');
  assert.equal(p.state.creates,creates); assert.equal(f.state.codes,1);
  fs.writeFileSync(file('gateway.json'),JSON.stringify({...gateway,automaticPreparationEnabled:false}));
  assert.equal((await client.statusReadOnly(row)).status,'staged');
  await assert.rejects(client.begin(row),{code:'whatsapp_onboarding_preparation_disabled'});
  assert.equal(p.state.creates,creates);
  fs.writeFileSync(file('gateway.json'),JSON.stringify(gateway));
  env.RUNTIME_ROLE='dev'; await assert.rejects(client.begin(row)); env.RUNTIME_ROLE='gateway';
  assert.equal(p.state.creates,creates);
  const bad = structuredClone(gateway); bad.automatic.scopes.push('ads_management');
  fs.writeFileSync(file('gateway.json'),JSON.stringify(bad)); assert.throws(() => configuration(env));
  await app.close(); app = null;
});
