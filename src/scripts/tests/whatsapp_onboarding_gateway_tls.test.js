'use strict';
const { allowPort, removePort } = require('../../../services/integrations-broker/test/offline-guard.cjs');
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const net = require('node:net');
const { execFileSync } = require('node:child_process'); const { randomUUID, randomBytes } = require('node:crypto');
const { brokerForGateway } = require('./fixtures/whatsapp_onboarding_gateway.fixture.cjs');
const { configuredClient } = require('../../lib/whatsappOnboardingBrokerClient');
const runtime = require('../../../services/integrations-broker/src/whatsapp-onboarding-main');
const C = require('../../../services/integrations-broker/src/whatsapp-onboarding-contract');
test('Production gateway file configuration uses the signed TLS runtime and refuses DEV or insecure signing files', async t => {
  const g = brokerForGateway(t); const f = g.f; const file = name => f.dir + '/' + name;
  const cert = file('tls.crt'); const key = file('tls.key');
  execFileSync('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  for (const p of [cert, key]) fs.chmodSync(p, 0o600);
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  fs.writeFileSync(file('broker.json'), JSON.stringify({ enabled: true, cohort: C.COHORT, listenAddress: '127.0.0.1', port,
    stateFile: file('runtime.sqlite'), tlsCertFile: cert, tlsKeyFile: key, policy: f.policy }), { mode: 0o600 });
  let app = await runtime.main(file('broker.json'), { awsFactory: async () => ({ secrets: f.aws,
    sink: { write: async row => ({ digest: row.digest, versionId: 'FICTITIOUS_AUDIT_VERSION' }) }, close() {} }), http: f.http, exchangeFactory: f.exchangeFactory });
  allowPort(port); t.after(async () => { if (app) await app.close(); removePort(port); });
  const signingKey = file('gateway.pem'); fs.writeFileSync(signingKey, f.gateway.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  fs.writeFileSync(file('state.key'), Buffer.alloc(32, 7), { mode: 0o600 });
  fs.writeFileSync(file('gateway.json'), JSON.stringify({ version: 1, origin: `https://127.0.0.1:${port}`, audience: f.policy.audience,
    keyId: 'qa-gateway', privateKeyFile: signingKey, caFile: cert, bindings: [g.metadata] }), { mode: 0o600 });
  const env = { WHATSAPP_ONBOARDING_ENABLED: 'true', RUNTIME_ROLE: 'gateway', JOB_RUNTIME_NAMESPACE: 'gateway', QUEUE_PREFIX: 'gateway', JOBS_WORKER_ENABLED: 'false', CRON_ENABLED: 'false',
    AUTH_SESSION_MODE: 'enforce', AUTH_EMAIL_MFA_MODE: 'enforce', PLATFORM_AUDIT_AUTH_ENABLED: 'true', PLATFORM_AUDIT_AUTH_POLICY: 'auth-durable-v1',
    PLATFORM_AUDIT_WHATSAPP_ONBOARDING_ENABLED: 'true', PLATFORM_AUDIT_WHATSAPP_ONBOARDING_POLICY: 'whatsapp-onboarding-v1',
    WHATSAPP_ONBOARDING_STATE_KEY_FILE: file('state.key'), WHATSAPP_ONBOARDING_BROKER_CONFIG_FILE: file('gateway.json') };
  const client = configuredClient({ environment: () => env });
  const row = { requestId: randomUUID(), status: 'awaiting', scope: { type: 'group', id: 9 }, clinicIds: [71,72],
    scopeDigest: C.hash('FICTITIOUS_TLS_GATEWAY_SCOPE'), clinicSetDigest: C.hash('[71,72]'), state: randomBytes(32).toString('base64url'), expiresAt: new Date(Date.now() + 599000).toISOString() };
  assert.equal((await client.begin(row)).authorization.configId, '102');
  assert.equal((await client.finish(row, { state: row.state, code: 'FICTITIOUS_CONFIGURED_CODE', wabaId: '301', phoneId: '401' })).status, 'staged');
  assert.equal((await client.status(row)).connected, false); const calls = f.state.awsCalls.length;
  env.JOB_RUNTIME_NAMESPACE = 'dev'; await assert.rejects(client.status(row), { code: 'whatsapp_onboarding_configuration_invalid' }); env.JOB_RUNTIME_NAMESPACE = 'gateway';
  fs.chmodSync(signingKey, 0o644); await assert.rejects(client.status(row), { code: 'whatsapp_onboarding_configuration_invalid' }); fs.chmodSync(signingKey, 0o600);
  assert.equal(f.state.awsCalls.length, calls); assert.equal((await client.abort(row)).status, 'aborted'); assert.equal(f.state.codes, 1);
  await app.close(); app = null;
});
