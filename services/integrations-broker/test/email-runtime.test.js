'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./helpers');
const { allowPort, removePort } = require('./offline-guard.cjs');
const { main, validateConfig } = require('../src/email-main');
const { createServer } = require('../src/server');
const { SECRET_KEY } = require('../src/google-main');
const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
const { createEmailBroker } = require('../../../src/services/emailBroker.service');
const { drainAudit } = require('../src/audit');
const L = require('../src/email-limits');
const F = require('./email-fixture.cjs');

async function setup(t, work = async () => F.accepted(), identityWork = async input => ({
  identityName: input.payload.identityName,
  verificationStatus: 'success',
  verifiedForSending: true,
  dkimStatus: 'success',
  dkimTokens: ['fictitious_token'],
  mailFromDomain: `bounce.${input.payload.identityName}`,
  mailFromStatus: 'success',
})) {
  const f = fixture(t), cert = path.join(f.dir, 'email.crt'), key = path.join(f.dir, 'email.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  fs.chmodSync(cert, 0o600); fs.chmodSync(key, 0o600);
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); allowPort(port);
  const policy = structuredClone(f.policy); policy.audience = 'clinicaclick:email:staging:v1';
  policy.principals[0].id = 'email:staging'; policy.connections = [F.binding()];
  policy.grants = L.TEMPLATES.map(template => ({ principalId: 'email:staging', tenantRef: 'platform:staging',
    connectionRef: 'email:staging', assetRef: `email:${template}`, operations: [L.OPERATION] }));
  policy.grants.push({ principalId: 'email:staging', tenantRef: 'platform:staging', connectionRef: 'email:staging',
    assetRef: 'email:identity-management', operations: [L.OPERATIONS.IDENTITY_ENSURE, L.OPERATIONS.IDENTITY_GET] });
  const config = { enabled: true, cohort: 'email-ses-transactional-v1', environment: 'staging', policy, listenAddress: '127.0.0.1', port,
    stateFile: path.join(f.dir, 'email.sqlite'), tlsCertFile: cert, tlsKeyFile: key };
  const filename = path.join(f.dir, 'email.json'); fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  const calls = [], identityCalls = [], buffers = [], events = [], secretCalls = [];
  const secrets = { async send(command) {
    secretCalls.push(command.input); assert.equal(command.input.SecretId, policy.connections[0].secretArn);
    if (command.constructor.name === 'DescribeSecretCommand') return { ARN: command.input.SecretId, KmsKeyId: SECRET_KEY };
    return { ARN: command.input.SecretId, VersionId: 'fictitious-email', VersionStages: ['AWSCURRENT'], SecretString: JSON.stringify({
      version: 1, connectionRef: 'email:staging', provider: 'aws_ses', credentials: F.credentials }) };
  } };
  const sink = { async write(row) { events.push(JSON.parse(row.event)); return { versionId: 'fictitious-audit', digest: row.digest }; } };
  const runtime = await main(filename, { awsFactory: async () => ({ secrets, sink, close() {} }), http: async input => {
    calls.push(input.payload); buffers.push(input.token); assert.deepEqual(JSON.parse(input.token.toString()), F.credentials); return work(input);
  }, identityHttp: async input => {
    identityCalls.push({ action: input.action, payload: input.payload });
    assert.deepEqual(JSON.parse(input.token.toString()), F.credentials);
    return identityWork(input);
  } });
  t.after(async () => { await runtime.close(); removePort(port); });
  const env = { EMAIL_BROKER_ENABLED: 'true', EMAIL_BROKER_ENVIRONMENT: 'staging', EMAIL_BROKER_ORIGIN: `https://127.0.0.1:${port}`,
    EMAIL_BROKER_CONNECTION_REF: 'email:staging', EMAIL_BROKER_AUDIENCE: policy.audience, EMAIL_BROKER_KEY_ID: 'qa-key',
    EMAIL_BROKER_CA_FILE: cert, EMAIL_BROKER_KEY_FILE: path.join(f.dir, 'signing.key') };
  fs.writeFileSync(env.EMAIL_BROKER_KEY_FILE, f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const low = createIntegrationsBrokerClient({ origin: env.EMAIL_BROKER_ORIGIN, audience: env.EMAIL_BROKER_AUDIENCE,
    keyId: 'qa-key', privateKey: fs.readFileSync(env.EMAIL_BROKER_KEY_FILE), ca: fs.readFileSync(cert), transportProfile: 'email' });
  const command = (p, change = {}) => ({ operation: L.OPERATION, tenantRef: 'platform:staging', connectionRef: 'email:staging',
    assetRef: `email:${p.templateKey}`, payload: p, ...change });
  // These cases exercise broker concurrency/fencing directly. Consumer pacing
  // is tested separately with its actual admission queue.
  return { ...f, config, env, runtime, sink, calls, identityCalls, secretCalls, buffers, events, low, command,
    client: createEmailBroker({ env, admission: { run: work => work() } }) };
}

test('signed email transport admits identity ensure and get operations end to end', async t => {
  const f = await setup(t);
  const ensured = await f.client.ensureIdentity('clinic.example');
  const read = await f.client.getIdentity('clinic.example');
  assert.equal(ensured.identityName, 'clinic.example');
  assert.equal(read.mailFromDomain, 'bounce.clinic.example');
  assert.deepEqual(f.identityCalls, [
    { action: 'ensure', payload: { identityName: 'clinic.example', timeoutMs: 15000 } },
    { action: 'get', payload: { identityName: 'clinic.example', timeoutMs: 15000 } },
  ]);
  assert.equal(f.calls.length, 0);
  assert.equal(f.secretCalls.length, 4);
});

test('signed TLS delivery preserves long Unicode content, metadata-only audit, and durable accepted dedupe', async t => {
  const f = await setup(t), p = F.payload({ text: 'FICTITIOUS_CONTEXT ñ 日本語 👍\n'.repeat(1800) });
  assert(Buffer.byteLength(JSON.stringify(p)) > 32768);
  const result = await f.client.send(p);
  assert.equal(result.providerMessageId, F.accepted().providerMessageId); assert.deepEqual(f.calls, [p]);
  assert(f.buffers[0].every(value => value === 0));
  assert.deepEqual(await f.client.send(p), result);
  assert.deepEqual(await f.client.send({ ...p, attempt: 2 }), result);
  assert.equal(f.calls.length, 1);
  await drainAudit(f.runtime.store, f.sink); assert.equal(f.runtime.store.backlog().pending, 0);
  assert(f.events.some(e => e.reason === 'email_ses_accepted' && e.result === 'success'));
  const persisted = JSON.stringify(f.runtime.store.db.prepare('SELECT * FROM commands').all())
    + JSON.stringify(f.runtime.store.db.prepare('SELECT * FROM email_deliveries').all()) + JSON.stringify(f.events);
  for (const value of [p.to, p.subject, p.html, 'FICTITIOUS_CONTEXT', ...Object.values(F.credentials)]) assert(!persisted.includes(value));
  await assert.rejects(f.low.execute(f.command({ ...p, text: 'changed' })), { code: 'idempotency_conflict' });
  assert.equal(f.calls.length, 1);
});

test('explicit throttle retries once on a later outbox attempt and is recorded as failure, not acceptance', async t => {
  let count = 0;
  const f = await setup(t, async () => ++count === 1 ? F.throttled() : F.accepted()), p = F.payload();
  for (let i = 0; i < 2; i++) await assert.rejects(f.client.send(p), { code: 'email_ses_throttled', retryable: true });
  assert.equal(f.calls.length, 1);
  assert.equal((await f.client.send({ ...p, attempt: 2 })).accepted, true);
  assert.equal(f.calls.length, 2);
  await drainAudit(f.runtime.store, f.sink);
  assert(f.events.some(e => e.action === 'integration.failed' && e.reason === 'email_ses_throttled' && e.result === 'failed'));
});

test('ambiguous provider failures and in-flight concurrent attempts cannot cause a second delivery', async t => {
  let release, entered;
  const arrival = new Promise(resolve => { entered = resolve; });
  const f = await setup(t, async () => { entered(); await new Promise(resolve => { release = resolve; }); throw Error('private transport error'); });
  const p = F.payload();
  const first = assert.rejects(f.client.send(p), { code: 'email_provider_broker_unknown_outcome', retryable: false });
  await arrival;
  await assert.rejects(f.client.send({ ...p, attempt: 2 }), { code: 'email_provider_broker_unknown_outcome', retryable: false });
  release(); await first;
  await assert.rejects(f.client.send({ ...p, attempt: 3 }), { code: 'email_provider_broker_unknown_outcome', retryable: false });
  assert.equal(f.calls.length, 1);
  assert.equal(f.runtime.store.db.prepare('SELECT state FROM email_deliveries').get().state, 'unknown');
});

test('acceptance after broker timeout stays durable and a new attempt only reconciles the accepted result', async t => {
  let release, finished;
  const done = new Promise(resolve => { finished = resolve; });
  const f = await setup(t, async () => { await new Promise(resolve => { release = resolve; }); finished(); return F.accepted(); });
  f.runtime.broker.timeoutMs = 20;
  const p = F.payload();
  await assert.rejects(f.client.send(p), { code: 'email_provider_broker_unknown_outcome', retryable: false });
  release(); await done;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.runtime.store.db.prepare('SELECT state FROM email_deliveries').get().state, 'accepted');
  assert.equal((await f.client.send({ ...p, attempt: 2 })).accepted, true);
  assert.equal(f.calls.length, 1);
});

test('failure while committing the command receipt cannot erase SES acceptance or produce another send', async t => {
  const f = await setup(t), p = F.payload(), original = f.runtime.store.complete;
  f.runtime.store.complete = () => { throw Error('fictitious audit commit failure'); };
  await assert.rejects(f.client.send(p), { code: 'email_provider_broker_unknown_outcome', retryable: false });
  assert.equal(f.runtime.store.db.prepare('SELECT state FROM email_deliveries').get().state, 'accepted');
  f.runtime.store.complete = original;
  assert.equal((await f.client.send({ ...p, attempt: 2 })).providerMessageId, F.accepted().providerMessageId);
  assert.equal(f.calls.length, 1);
});

test('scopes bind recipient policy, template, sender, configuration, region and environment before secret access', async t => {
  const f = await setup(t), p = F.payload();
  for (const change of [{ tenantRef: 'platform:dev' }, { connectionRef: 'email:dev' }, { assetRef: 'email:auth.password_reset' }]) {
    await assert.rejects(f.low.execute(f.command(p, change)), { code: 'scope_denied' });
  }
  for (const patch of [{ to: 'foreign@example.test' }, { from: 'foreign@example.test' }, { replyTo: 'foreign@example.test' },
    { configurationSet: 'marketing' }, { recipientPolicy: 'registered-account', templateKey: 'automation.generic' }]) {
    const next = { ...p, ...patch }; await assert.rejects(f.low.execute(f.command(next)), { code: 'scope_denied' });
  }
  assert.equal(f.calls.length, 0); assert.equal(f.secretCalls.length, 0);
  // The signer is the trusted outbox worker, which has already checked the
  // persisted live challenge. A template label alone grants no arbitrary mail.
  await f.client.send({ ...p, recipientPolicy: 'registered-account', to: 'registered@example.test' });
  assert.equal(f.calls.length, 1);
  for (const mutate of [c => { c.environment = 'dev'; }, c => { c.policy.connections[0].email.region = 'us-east-1'; },
    c => { c.policy.connections[0].secretArn = c.policy.connections[0].secretArn.replace('/email/ses/', '/ai/bedrock/'); },
    c => { c.policy.grants[0].operations.push('ai.bedrock.converse.v1'); }, c => { c.policy.principals[0].id = 'gateway'; }]) {
    const config = structuredClone(f.config); mutate(config); assert.throws(() => validateConfig(config), { code: 'invalid_request' });
  }
});

test('dedicated email transport admits two pending requests and does not treat overload as an SES retry', async t => {
  const f = await setup(t), pending = [], arrivals = [];
  const server = createServer({ execute: () => new Promise(resolve => { pending.push(resolve); arrivals.shift()?.(); }) },
    { cert: fs.readFileSync(f.config.tlsCertFile), key: fs.readFileSync(f.config.tlsKeyFile) }, { transportProfile: 'email' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; allowPort(port);
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); removePort(port); });
  const request = () => new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port, path: '/v1/execute', method: 'POST', agent: false,
      ca: fs.readFileSync(f.config.tlsCertFile), headers: { 'content-type': 'application/json', 'content-length': 2 } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }); req.on('error', reject); req.end('{}');
  });
  const requests = [];
  for (let i = 0; i < 2; i++) { const arrived = new Promise(resolve => arrivals.push(resolve)); requests.push(request()); await arrived; }
  assert.equal(await request(), 429);
  assert.equal((await f.client.send(F.payload())).accepted, true);
  for (const complete of pending) complete({ data: {}, replayed: false, requestId: randomUUID() });
  assert.deepEqual(await Promise.all(requests), [200, 200]);
});
