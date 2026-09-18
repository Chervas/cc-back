'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const https = require('node:https');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { fixture } = require('./helpers');
const { payload, response, credentials } = require('./bedrock-fixture.cjs');
const { allowPort, removePort } = require('./offline-guard.cjs');
const { main, validateConfig } = require('../src/bedrock-main');
const { validateConfig: validateAiConfig } = require('../src/ai-main');
const { OPERATION, MODELS, USE_CASES } = require('../src/bedrock-limits');
const { SECRET_KEY } = require('../src/google-main');
const { createAwsSecretStore } = require('../src/secrets');
const { createBedrockBroker } = require('../../../src/services/bedrockBroker.service');
const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
const { drainAudit } = require('../src/audit');
const { createServer } = require('../src/server');

async function setup(t) {
  const f = fixture(t), cert = path.join(f.dir, 'bedrock.crt'), key = path.join(f.dir, 'bedrock.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  fs.chmodSync(cert, 0o600); fs.chmodSync(key, 0o600);
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); allowPort(port);
  const policy = structuredClone(f.policy); policy.audience = 'clinicaclick:bedrock:staging:v1';
  const binding = { connectionRef: 'bedrock:staging', provider: 'aws_bedrock', initialState: 'active', bedrock: { region: 'eu-south-2', models: [MODELS[0], MODELS[1]] },
    secretArn: 'arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/ai/bedrock/key-abcdef' };
  policy.connections = [binding]; policy.grants = USE_CASES.map(use => ({ principalId: 'api:test', tenantRef: 'platform:staging',
    connectionRef: binding.connectionRef, assetRef: `ai:${use}`, operations: [OPERATION] }));
  const config = { enabled: true, cohort: 'bedrock-conversation-v1', environment: 'staging', policy, listenAddress: '127.0.0.1', port,
    stateFile: path.join(f.dir, 'bedrock.sqlite'), tlsCertFile: cert, tlsKeyFile: key };
  const filename = path.join(f.dir, 'bedrock.json'); fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  const calls = [], secretCalls = [], buffers = [], events = [];
  const secrets = { async send(command) {
    secretCalls.push(command.input); assert.equal(command.input.SecretId, binding.secretArn);
    if (command.constructor.name === 'DescribeSecretCommand') return { ARN: binding.secretArn, KmsKeyId: SECRET_KEY };
    return { ARN: binding.secretArn, VersionId: 'fictitious', VersionStages: ['AWSCURRENT'], SecretString: JSON.stringify({ version: 1,
      connectionRef: binding.connectionRef, provider: binding.provider, credentials }) };
  } };
  const sink = { async write(row) { events.push(JSON.parse(row.event)); return { versionId: 'fictitious-audit', digest: row.digest }; } };
  const runtime = await main(filename, { awsFactory: async () => ({ secrets, sink, close() {} }), http: async input => {
    calls.push(input.payload); buffers.push(input.token); assert.deepEqual(JSON.parse(input.token.toString()), credentials); return response();
  } });
  t.after(async () => { await runtime.close(); removePort(port); });
  const env = { BEDROCK_BROKER_ENABLED: 'true', BEDROCK_BROKER_ENVIRONMENT: 'staging', BEDROCK_BROKER_ORIGIN: `https://127.0.0.1:${port}`,
    BEDROCK_BROKER_CONNECTION_REF: binding.connectionRef, BEDROCK_BROKER_AUDIENCE: policy.audience, BEDROCK_BROKER_KEY_ID: 'qa-key',
    BEDROCK_BROKER_CA_FILE: cert, BEDROCK_BROKER_KEY_FILE: path.join(f.dir, 'signing.key') };
  fs.writeFileSync(env.BEDROCK_BROKER_KEY_FILE, f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const client = createBedrockBroker({ env });
  return { ...f, config, env, client, runtime, sink, calls, secretCalls, buffers, events, secrets };
}

test('signed TLS Bedrock preserves context, scopes access, has no content persistence and cannot replay a completed inference', async t => {
  const f = await setup(t), p = payload(), requestId = randomUUID();
  p.body.messages[0].content[0].text += '\nCONTEXTO_ñ_日本語_👍'.repeat(10000);
  const result = await f.client.execute(p.useCase, p.body, { timeoutMs: p.timeoutMs, requestId });
  assert.equal(result.output.message.content[0].toolUse.input.confirmado, true);
  assert.deepEqual(f.calls[0], p);
  assert(f.buffers[0].every(value => value === 0));
  await assert.rejects(f.client.execute(p.useCase, p.body, { requestId }), { code: 'outcome_unknown' });
  const low = createIntegrationsBrokerClient({ origin: f.env.BEDROCK_BROKER_ORIGIN, audience: f.env.BEDROCK_BROKER_AUDIENCE,
    keyId: 'qa-key', privateKey: fs.readFileSync(f.env.BEDROCK_BROKER_KEY_FILE), ca: fs.readFileSync(f.env.BEDROCK_BROKER_CA_FILE), transportProfile: 'ai' });
  for (const change of [{ tenantRef: 'platform:dev' }, { connectionRef: 'bedrock:foreign' }, { assetRef: 'ai:custom' },
    { operation: 'ai.groq.audio.transcribe.v1' }]) {
    await assert.rejects(low.execute({ operation: OPERATION, connectionRef: 'bedrock:staging', assetRef: 'ai:confirm_appointment',
      tenantRef: 'platform:staging', payload: p, ...change }), { code: 'scope_denied' });
  }
  await assert.rejects(f.client.execute(p.useCase, { ...p.body, modelId: MODELS[2] }), { code: 'scope_denied' });
  assert.equal(f.calls.length, 1); assert.equal(f.secretCalls.length, 2);
  await drainAudit(f.runtime.store, f.sink); assert.equal(f.runtime.store.backlog().pending, 0);
  assert(f.events.some(event => event.action === 'integration.completed' && event.operation === OPERATION));
  const persisted = JSON.stringify(f.runtime.store.db.prepare('SELECT * FROM commands').all()) + JSON.stringify(f.events);
  for (const text of [...Object.values(credentials), 'FICTITIOUS_CONVERSATION', 'FICTITIOUS_OUTPUT', 'CONTEXTO_ñ_日本語_👍']) assert(!persisted.includes(text));
});

test('Bedrock runtime rejects mixed AI policies, foreign region/environment, broad secret paths and audiences', async t => {
  const f = await setup(t);
  for (const mutate of [c => { c.environment = 'dev'; }, c => { c.policy.audience = 'clinicaclick:ai:staging:v1'; },
    c => { c.policy.connections[0].bedrock.region = 'us-east-1'; }, c => { c.policy.connections[0].ai = { models: ['fake'] }; },
    c => { c.policy.connections[0].secretArn = c.policy.connections[0].secretArn.replace('/bedrock/', '/groq/'); },
    c => { c.policy.grants[0].operations.push('ai.groq.audio.transcribe.v1'); }, c => { c.policy.grants[0].assetRef = 'ai:whatsapp_audio'; }]) {
    const config = structuredClone(f.config); mutate(config); assert.throws(() => validateConfig(config), { code: 'invalid_request' });
  }
  const config = structuredClone(f.config); config.cohort = 'ai-providers-v1';
  assert.throws(() => validateAiConfig(config), { code: 'invalid_request' });
});

test('structured vault credentials are scoped, uncached and cleared even when provider work fails', async t => {
  const f = await setup(t), binding = f.config.policy.connections[0];
  const store = createAwsSecretStore({ client: f.secrets, accountId: '137819318729', prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: SECRET_KEY });
  let observed;
  await assert.rejects(store.withSecret(binding, bytes => { observed = bytes; throw Error('fictitious_work_failed'); }), /fictitious_work_failed/);
  assert(observed.every(value => value === 0));
  await store.withSecret(binding, bytes => { assert.deepEqual(JSON.parse(bytes.toString()), credentials); });
  assert.equal(f.secretCalls.length, 4);
  for (const patch of [{ provider: 'ai_groq' }, { connectionRef: 'bedrock:foreign' }, { accessToken: 'injected' },
    { credentials: { ...credentials, extra: 'wrong' } }, { credentials: { accessKeyId: credentials.accessKeyId } }]) {
    const bad = { async send(command) {
      const reply = await f.secrets.send(command);
      if (reply.SecretString) reply.SecretString = JSON.stringify({ ...JSON.parse(reply.SecretString), ...patch });
      return reply;
    } };
    await assert.rejects(createAwsSecretStore({ client: bad, accountId: '137819318729', prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: SECRET_KEY })
      .withSecret(binding, () => assert.fail('invalid credential reached provider')), { code: 'secret_unavailable' });
  }
});

test('four occupied audio/OCR slots cannot starve a separate Bedrock runtime', { timeout: 10000 }, async t => {
  const f = await setup(t), pending = [], arrivals = [];
  const audio = createServer({ execute: () => new Promise(resolve => { pending.push(resolve); arrivals.shift()?.(); }) },
    { cert: fs.readFileSync(f.config.tlsCertFile), key: fs.readFileSync(f.config.tlsKeyFile) }, { transportProfile: 'ai' });
  await new Promise(resolve => audio.listen(0, '127.0.0.1', resolve));
  const port = audio.address().port; allowPort(port);
  t.after(async () => { for (const done of pending) done({ data: {}, replayed: false, requestId: 'fictitious' });
    audio.closeAllConnections(); await new Promise(resolve => audio.close(resolve)); removePort(port); });
  function request() { return new Promise((resolve, reject) => {
    const req = https.request({ hostname: '127.0.0.1', port, path: '/v1/execute', method: 'POST', agent: false,
      ca: fs.readFileSync(f.config.tlsCertFile), headers: { 'content-type': 'application/json', 'content-length': 2 } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    }); req.on('error', reject); req.end('{}');
  }); }
  const requests = [];
  for (let i = 0; i < 4; i++) { const arrival = new Promise(resolve => arrivals.push(resolve)); requests.push(request()); await arrival; }
  assert.equal(await request(), 429);
  const p = payload(); assert.equal((await f.client.execute(p.useCase, p.body)).output.message.content[0].toolUse.input.confirmado, true);
  assert.equal(pending.length, 4);
  for (const done of pending) done({ data: {}, replayed: false, requestId: 'fictitious' });
  assert.deepEqual(await Promise.all(requests), [200, 200, 200, 200]);
});
