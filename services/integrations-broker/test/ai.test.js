'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { fixture } = require('./helpers');
const { allowPort, removePort } = require('./offline-guard.cjs');
const { createAiHttp } = require('../src/ai-http');
const { validate, authorize } = require('../src/ai-contract');
const C = require('../src/ai-file-reference');
const { OPERATIONS, MODEL_CHECK_OPERATION } = require('../src/ai-limits');
const { validateConfig, main } = require('../src/ai-main');
const { SECRET_KEY } = require('../src/google-main');
const { createAiBroker } = require('../../../src/services/aiBroker.service');
const { createIntegrationsBrokerClient } = require('../../../src/lib/integrationsBrokerClient');
const { drainAudit } = require('../src/audit');
const transferOrigin = 'https://fictitious.invalid';
const ref = (useCase, mimeType, fill) => ({ version: 1, environment: 'staging', requestId: randomUUID(), useCase,
  url: transferOrigin + C.PREFIX + Buffer.alloc(32, fill).toString('base64url'), expiresAt: Date.now() + 240000,
  mimeType, fileName: 'fictitious', sizeBytes: 50000, sha256: 'a'.repeat(64) });
const payloads = {
  openai: { useCase: 'accounting_ocr', timeoutMs: 120000, body: { model: 'gpt-fictitious', store: false, max_output_tokens: 1800,
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'FICTITIOUS_DOCUMENT_ONLY' },
      { type: 'input_file', file_ref: ref('accounting_ocr', 'application/pdf', 1) }] }] } },
  gemini: { useCase: 'visibility_gemini', timeoutMs: 90000, body: { model: 'gemini-fictitious', store: false,
    input: 'FICTITIOUS_SEARCH_ONLY', tools: [{ type: 'google_search' }] } },
  groq: { useCase: 'whatsapp_audio', timeoutMs: 30000, body: { model: 'whisper-fictitious', response_format: 'verbose_json',
    fileRef: ref('whatsapp_audio', 'audio/ogg', 2) } },
};
function stubHttp({ status = 200, body = { text: 'FICTITIOUS_TRANSCRIPTION', usage: { input_tokens: 2 } }, stall = false } = {}) {
  const calls = [];
  const request = (options, cb) => {
    const req = new EventEmitter(); req.destroy = () => { req.destroyed = true; };
    req.end = bytes => { calls.push({ options, bytes: Buffer.from(bytes) }); if (stall) return;
      setImmediate(() => { const res = new PassThrough(); res.statusCode = status; res.headers = { 'content-type': 'application/json' };
        cb(res); res.end(JSON.stringify(body)); }); };
    return req;
  };
  return { calls, http: createAiHttp({ request }) };
}
test('AI transports use fixed HTTPS hosts, preserve input and attach the key only on AWS side', async () => {
  for (const provider of Object.keys(payloads)) {
    const f = stubHttp(); const token = Buffer.from('FICTITIOUS_PROVIDER_KEY');
    const result = await f.http({ provider, payload: payloads[provider], token, binding: { ai: { organization: 'org-fictitious', project: 'proj-fictitious', fileTransferOrigin: transferOrigin } },
      environment: 'staging', requestId: provider === 'groq' ? payloads.groq.body.fileRef.requestId : payloads.openai.body.input[0].content[1].file_ref.requestId });
    assert.equal(result.text, 'FICTITIOUS_TRANSCRIPTION'); assert.equal(f.calls.length, 1);
    const { options, bytes } = f.calls[0]; assert.equal(options.rejectUnauthorized, true); assert.equal(options.method, 'POST');
    assert.equal(options.headers[provider === 'gemini' ? 'x-goog-api-key' : 'authorization'], provider === 'gemini' ? token.toString() : `Bearer ${token}`);
    assert(!bytes.includes(token)); assert.equal(options.port, 443);
    assert.equal(options.hostname, { openai: 'api.openai.com', gemini: 'generativelanguage.googleapis.com', groq: 'api.groq.com' }[provider]);
    assert(bytes.length < 1500);
    if (provider === 'groq') { assert(!bytes.includes(Buffer.alloc(50000, 66))); assert(bytes.includes(Buffer.from(payloads.groq.body.fileRef.url))); assert(!bytes.includes(Buffer.from('name="file"'))); assert.match(bytes.toString(), /name="response_format"\r\n\r\nverbose_json/); }
    else if (provider === 'openai') { const expected = structuredClone(payloads.openai.body); expected.input[0].content[1] = { type: 'input_file', file_url: expected.input[0].content[1].file_ref.url }; assert.deepEqual(JSON.parse(bytes), expected); }
    else assert.deepEqual(JSON.parse(bytes), payloads[provider].body);
  }
});
test('AI schema rejects external resources, extra credentials, storage, streaming, tools and malformed audio', () => {
  for (const [provider, change] of [
    ['openai', p => { p.body.store = true; }], ['openai', p => { p.body.stream = true; }],
    ['openai', p => { p.body.input[0].content[1] = { type: 'input_image', image_url: 'http://169.254.169.254/private' }; }],
    ['openai', p => { p.body.tools = [{ type: 'mcp', server_url: 'https://example.invalid' }]; }],
    ['groq', p => { p.body.fileName = 'x\r\nAuthorization: injected'; }], ['groq', p => { p.body.fileBase64 = 'Zh=='; }],
    ['gemini', p => { p.body.api_key = 'FICTITIOUS_INJECTED'; }], ['gemini', p => { p.body.tools = [{ type: 'url_context' }]; }],
  ]) { const value = structuredClone(payloads[provider]); change(value); assert.throws(() => validate(provider, value), { code: 'invalid_request' }); }
});
test('upstream errors, redirects and ambiguous timeouts never retry or expose provider errors', async () => {
  for (const [status, code] of [[302, 'provider_failed'], [401, 'provider_unauthorized'], [403, 'provider_unauthorized'], [429, 'rate_limited'], [500, 'provider_failed']]) {
    const f = stubHttp({ status, body: { error: 'FICTITIOUS_SECRET_IN_PROVIDER_ERROR' } });
    await assert.rejects(f.http({ provider: 'gemini', payload: payloads.gemini, token: Buffer.from('FICTITIOUS_KEY'), binding: { ai: {} } }), { code, message: code });
    assert.equal(f.calls.length, 1);
  }
  const f = stubHttp({ stall: true }); const controller = new AbortController();
  const pending = f.http({ provider: 'gemini', payload: payloads.gemini, token: Buffer.from('FICTITIOUS_KEY'), binding: { ai: {} }, signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { code: 'provider_timeout' }); assert.equal(f.calls.length, 1);
});
test('actual TLS AI runtime sends only references, preserves large output, isolates environment and audits without content or keys', async t => {
  const f = fixture(t); const cert = path.join(f.dir, 'ai.crt'); const key = path.join(f.dir, 'ai.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  fs.chmodSync(cert, 0o600); fs.chmodSync(key, 0o600);
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); allowPort(port);
  const policy = structuredClone(f.policy); policy.connections = []; policy.grants = [];
  for (const provider of Object.keys(payloads)) {
    const connectionRef = `ai:${provider}:staging`;
    policy.connections.push({ connectionRef, provider: `ai_${provider}`, initialState: 'active', ai: { models: [payloads[provider].body.model], fileTransferOrigin: transferOrigin },
      secretArn: `arn:aws:secretsmanager:eu-west-3:137819318729:secret:/clinicaclick/integrations/prod/ai/${provider}/key-abcdef` });
    policy.grants.push({ principalId: 'api:test', tenantRef: 'platform:staging', connectionRef,
      assetRef: `ai:${payloads[provider].useCase}`, operations: [OPERATIONS[provider]] });
  }
  policy.grants.push({ principalId: 'api:test', tenantRef: 'platform:staging', connectionRef: 'ai:groq:staging',
    assetRef: 'ai:provider_health', operations: [MODEL_CHECK_OPERATION] });
  const config = { enabled: true, cohort: 'ai-providers-v1', environment: 'staging', policy, listenAddress: '127.0.0.1', port,
    stateFile: path.join(f.dir, 'ai.sqlite'), tlsCertFile: cert, tlsKeyFile: key };
  const wrongEnvironment = structuredClone(config); wrongEnvironment.environment = 'dev';
  assert.throws(() => validateConfig(wrongEnvironment), { code: 'invalid_request' });
  const wrongGrant = structuredClone(config); wrongGrant.policy.grants[0].assetRef = 'ai:whatsapp_audio';
  assert.throws(() => validateConfig(wrongGrant), { code: 'invalid_request' });
  const filename = path.join(f.dir, 'ai.json'); fs.writeFileSync(filename, JSON.stringify(config), { mode: 0o600 });
  const deliveries = [], providerCalls = []; let keyBuffers = []; let leak = false; let healthCalls = 0;
  const secrets = { async send(command) {
    const binding = policy.connections.find(c => c.secretArn === command.input.SecretId); assert(binding);
    if (command.constructor.name === 'DescribeSecretCommand') return { ARN: binding.secretArn, KmsKeyId: SECRET_KEY };
    assert.equal(command.input.VersionStage, 'AWSCURRENT');
    return { ARN: binding.secretArn, VersionId: 'fictitious', VersionStages: ['AWSCURRENT'],
      SecretString: JSON.stringify({ version: 1, provider: binding.provider, connectionRef: binding.connectionRef, accessToken: 'FICTITIOUS_KEY_SENTINEL' }) };
  } };
  const sink = { async write(row) { deliveries.push(JSON.parse(row.event)); return { versionId: 'fictitious-audit', digest: row.digest }; } };
  const runtime = await main(filename, { modelHealthHttp: async ({ payload, token }) => {
    healthCalls++; assert.equal(token.toString(), 'FICTITIOUS_KEY_SENTINEL'); return { model: payload.body.model, available: true }; }, awsFactory: async () => ({ secrets, sink, close() {} }),
    http: async input => { providerCalls.push(input.provider); keyBuffers.push(input.token); assert.equal(input.token.toString(), 'FICTITIOUS_KEY_SENTINEL');
      return { model: input.payload.body.model, text: leak ? input.token.toString() : 'FICTITIOUS_OUTPUT_CONTENT'.repeat(60000), usage: { input_tokens: 17 } }; } });
  t.after(async () => { await runtime.close(); removePort(port); });
  const env = { AI_BROKER_ENVIRONMENT: 'staging', AI_BROKER_ORIGIN: `https://127.0.0.1:${port}`,
    AI_BROKER_AUDIENCE: policy.audience, AI_BROKER_KEY_ID: 'qa-key', AI_BROKER_CA_FILE: cert, AI_BROKER_KEY_FILE: path.join(f.dir, 'signing.key') };
  fs.writeFileSync(env.AI_BROKER_KEY_FILE, f.keys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  for (const provider of Object.keys(payloads)) { env[`AI_BROKER_${provider.toUpperCase()}_ENABLED`] = 'true'; env[`AI_BROKER_${provider.toUpperCase()}_CONNECTION_REF`] = `ai:${provider}:staging`; }
  const client = createAiBroker({ env });
  for (const [provider, payload] of Object.entries(payloads)) {
    const requestId = provider === 'groq' ? payload.body.fileRef.requestId : provider === 'openai' ? payload.body.input[0].content[1].file_ref.requestId : randomUUID();
    const response = await client.execute(provider, payload.useCase, payload.body, { requestId, timeoutMs: payload.timeoutMs });
    assert(response.data.text.length > 1048576); assert.equal(response.data.usage.input_tokens, 17);
    await assert.rejects(client.execute(provider, payload.useCase, payload.body, { requestId, timeoutMs: payload.timeoutMs }), { code: 'outcome_unknown' });
  }
  assert.deepEqual(providerCalls, ['openai', 'gemini', 'groq']); assert(keyBuffers.every(buffer => buffer.every(byte => byte === 0)));
  assert.deepEqual((await client.checkModel('groq', payloads.groq.body.model)).data, { model: payloads.groq.body.model, available: true });
  assert.equal(healthCalls, 1);
  await assert.rejects(client.checkModel('groq', 'unapproved-model'), { code: 'scope_denied' });
  assert.equal(healthCalls, 1);
  const foreign = createAiBroker({ env: { ...env, AI_BROKER_ENVIRONMENT: 'dev' } });
  await assert.rejects(foreign.execute('groq', 'whatsapp_audio', payloads.groq.body), { code: 'scope_denied' });
  await assert.rejects(client.execute('groq', 'whatsapp_audio', { ...payloads.groq.body, model: 'unapproved-model' }), { code: 'scope_denied' });
  await assert.rejects(foreign.checkModel('groq', payloads.groq.body.model), { code: 'scope_denied' });
  assert.equal(healthCalls, 1);
  leak = true; const leakingBody = structuredClone(payloads.groq.body); leakingBody.fileRef.requestId = randomUUID();
  await assert.rejects(client.execute('groq', 'whatsapp_audio', leakingBody, { requestId: leakingBody.fileRef.requestId }), { code: 'provider_failed' });
  await drainAudit(runtime.store, sink);
  assert.equal(runtime.store.backlog().pending, 0);
  assert.equal(deliveries.filter(event => event.action === 'integration.completed').length, 4);
  assert(deliveries.some(event => event.operation === OPERATIONS.openai));
  const persisted = JSON.stringify(runtime.store.db.prepare('SELECT * FROM commands').all()) + JSON.stringify(deliveries);
  for (const marker of ['FICTITIOUS_KEY_SENTINEL', 'FICTITIOUS_OUTPUT_CONTENT', 'FICTITIOUS_DOCUMENT_ONLY', payloads.groq.body.fileRef.url, payloads.openai.body.input[0].content[1].file_ref.url]) assert(!persisted.includes(marker));
  const legacy = createIntegrationsBrokerClient({ origin: env.AI_BROKER_ORIGIN, audience: policy.audience, keyId: 'qa-key',
    ca: fs.readFileSync(cert), privateKey: fs.readFileSync(env.AI_BROKER_KEY_FILE) });
  await assert.rejects(legacy.execute({ operation: OPERATIONS.openai, connectionRef: 'ai:openai:staging', tenantRef: 'platform:staging',
    assetRef: 'ai:accounting_ocr', payload: { ...payloads.openai, body: { ...payloads.openai.body, input: 'x'.repeat(40000) } } }), { code: 'invalid_request' });
});

test('AWS authorization rejects a substituted origin, expired reference, wrong request, environment or purpose', () => {
  const request = { requestId: payloads.groq.body.fileRef.requestId, tenantRef: 'platform:staging', operation: OPERATIONS.groq,
    assetRef: 'ai:whatsapp_audio', payload: payloads.groq };
  const binding = { provider: 'ai_groq', ai: { models: ['whisper-fictitious'], fileTransferOrigin: transferOrigin } };
  authorize('groq', { request, binding });
  for (const change of [{ environment: 'dev' }, { requestId: randomUUID() }, { useCase: 'accounting_ocr' }, { url: 'https://169.254.169.254/private' },
    { url: payloads.groq.body.fileRef.url + '?redirect=1' }, { expiresAt: Date.now() - 1 }]) {
    const other = structuredClone(request); Object.assign(other.payload.body.fileRef, change);
    assert.throws(() => authorize('groq', { request: other, binding }), { code: 'scope_denied' });
  }
});
test('AI operations reject provider output that echoes a temporary capability', async () => {
  const { createAiOperations } = require('../src/ai-operations');
  const operation = createAiOperations({ http: async () => ({ text: payloads.groq.body.fileRef.url }) })[OPERATIONS.groq];
  await assert.rejects(operation.execute({ requestId: payloads.groq.body.fileRef.requestId, tenantRef: 'platform:staging', payload: payloads.groq, assertActive() {} }), { code: 'provider_failed' });
});
