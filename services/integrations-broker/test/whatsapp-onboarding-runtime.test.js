'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path'); const net = require('node:net');
const { execFileSync } = require('node:child_process'); const { randomUUID, randomBytes } = require('node:crypto');
const { fixture, TOKEN, APP } = require('./whatsapp-onboarding-fixture.cjs'); const C = require('../src/whatsapp-onboarding-contract');
const runtime = require('../src/whatsapp-onboarding-main'); const { allowPort, removePort } = require('./offline-guard.cjs'); const { drainAudit } = require('../src/audit');
const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
function config(f) { return { cohort: C.COHORT, enabled: true, listenAddress: '127.0.0.1', port: 19092, stateFile: path.join(f.dir, 'runtime.sqlite'),
  tlsCertFile: path.join(f.dir, 'tls.crt'), tlsKeyFile: path.join(f.dir, 'tls.key'), policy: f.policy }; }
test('Onboarding runtime rejects DEV/staging keys, mixed operations/scopes/slots and disabled cohort before AWS', async t => {
  const f = fixture(t); const base = config(f); runtime.validateConfig(base);
  const mutations = [c => { c.enabled = false; }, c => { c.cohort = 'whatsapp-messaging-v1'; },
    c => { c.policy.principals[0].id = 'dev:whatsapp-onboarding'; c.policy.grants[0].principalId = c.policy.principals[0].id; },
    c => { c.policy.principals[0].id = 'staging:whatsapp'; c.policy.grants[0].principalId = c.policy.principals[0].id; },
    c => { c.policy.principals[1].publicKey = c.policy.principals[0].publicKey; },
    c => { c.policy.connections[0].secretArn = c.policy.connections[0].clientSecretArn; },
    c => { c.policy.connections[0].secretArn = c.policy.connections[0].secretArn.replace('/prod/', '/dev/'); },
    c => { c.policy.connections[0].whatsappOnboarding.scopes.push('ads_management'); },
    c => { c.policy.connections[0].whatsappOnboarding.scopes = ['whatsapp_business_management']; },
    c => { c.policy.connections[0].whatsappOnboarding.clinicIds.reverse(); },
    c => { c.policy.connections[0].whatsappOnboarding.redirectUri = 'https://example.invalid/?code=x'; },
    c => { c.policy.grants[0].operations.push('meta.whatsapp.text.send.v1'); },
    c => { c.policy.grants[1].operations.push(C.OPERATIONS.finish); }, c => { c.policy.grants[1].tenantRef = 'clinic:999'; },
    c => { c.policy.connections[0].expiresAt = null; }, c => { c.stateFile = 'relative.sqlite'; },
  ];
  const file = path.join(f.dir, 'bad-config.json'); let aws = 0;
  for (const mutate of mutations) { const c = structuredClone(base); mutate(c); fs.writeFileSync(file, JSON.stringify(c), { mode: 0o600 });
    await assert.rejects(runtime.main(file, { awsFactory: async () => { aws++; throw Error('FORBIDDEN_REAL_AWS'); } }), { code: 'invalid_request' }); }
  assert.equal(aws, 0);
});
for (const customer of [undefined, { businessId: '501', wabaIds: ['301','302'] }])
test('Actual TLS broker exposes authenticated candidate flow only, survives restart and preserves cancellation/audit: ' + (customer ? 'business' : 'single WABA'), async t => {
  const f = fixture(t, { customer }); const c = config(f);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', c.tlsKeyFile, '-out', c.tlsCertFile,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  fs.chmodSync(c.tlsKeyFile, 0o600); fs.chmodSync(c.tlsCertFile, 0o600);
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); c.port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const filename = path.join(f.dir, 'config.json'); fs.writeFileSync(filename, JSON.stringify(c), { mode: 0o600 }); const events = []; let closed = 0;
  const sink = { async write(row) { events.push(JSON.parse(row.event)); return { versionId: 'FICTITIOUS_AUDIT_VERSION', digest: row.digest }; } };
  const start = () => runtime.main(filename, { awsFactory: async () => ({ secrets: f.aws, sink, close() { closed++; } }), http: f.http, exchangeFactory: f.exchangeFactory });
  let app = await start(); allowPort(c.port); t.after(async () => { if (app) await app.close(); removePort(c.port); });
  const client = (control = false) => createIntegrationsBrokerClient({ origin: `https://127.0.0.1:${c.port}`, audience: f.policy.audience,
    keyId: control ? 'qa-control' : 'qa-gateway', privateKey: (control ? f.control : f.gateway).privateKey.export({ type: 'pkcs8', format: 'pem' }), ca: fs.readFileSync(c.tlsCertFile) });
  const scope = { tenantRef: 'clinic:71', connectionRef: f.binding.connectionRef, assetRef: 'wa-enroll:group:9' };
  const id = randomUUID(); const state = randomBytes(32).toString('base64url'); const caller = client();
  const begin = { requestId: id, ...scope, operation: C.OPERATIONS.begin,
    payload: { state, expiresAt: Date.now() + 600000, scopeDigest: C.hash('TLS_SCOPE_SNAPSHOT'), clinicSetDigest: C.clinicDigest(f.binding.whatsappOnboarding) } };
  assert.equal((await caller.execute(begin)).data.status, 'awaiting');
  const finish = { requestId: randomUUID(), ...scope, operation: C.OPERATIONS.finish, payload: { flowId: id, state, code: 'FICTITIOUS_TLS_WA_CODE', wabaId: '301', phoneId: '401' } };
  const result = await caller.execute(finish); assert.equal(result.data.status, 'staged'); assert.equal(result.data.connected, false);
  if (customer) { assert.equal(result.data.candidate.businessId, '501'); assert.deepEqual(result.data.candidate.grantedWabaIds, ['301','302']); }
  for (const value of [TOKEN, APP, state, finish.payload.code]) assert(!JSON.stringify(result).includes(value));
  await assert.rejects(caller.execute({ ...finish, requestId: randomUUID(), operation: 'meta.whatsapp.text.send.v1', payload: {} }));
  assert.equal(f.state.codes, 1); assert.equal(f.state.puts, 1); await app.close(); app = await start();
  assert.equal((await caller.execute({ ...finish, requestId: randomUUID() })).data.status, 'staged'); assert.equal(f.state.codes, 1);
  assert.equal((await client(true).execute({ requestId: randomUUID(), ...scope, operation: C.OPERATIONS.abort, payload: { flowId: id } })).data.status, 'aborted');
  await assert.rejects(caller.execute({ ...finish, requestId: randomUUID() })); assert.equal(f.state.codes, 1);
  await drainAudit(app.store, sink); assert.equal(app.store.backlog().pending, 0);
  assert(events.some(e => e.reason === 'whatsapp_candidate_stored')); assert(events.some(e => e.reason === 'whatsapp_authorization_aborted'));
  for (const value of [TOKEN, APP, state, finish.payload.code]) assert(!JSON.stringify(events).includes(value));
  await app.close(); app = null; assert.equal(closed, 2);
});
