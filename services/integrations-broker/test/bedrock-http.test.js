'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable, PassThrough } = require('node:stream');
const { createBedrockHttp, limitedHandler, MAX_REPLY_BYTES } = require('../src/bedrock-http');
const contract = require('../src/bedrock-contract');
const { PROVIDER_ERRORS } = require('../src/bedrock-errors');
const { payload, response, credentials } = require('./bedrock-fixture.cjs');
const token = () => Buffer.from(JSON.stringify(credentials));

test('actual Bedrock SDK signs only the pinned Converse endpoint and preserves native text/schema', async () => {
  let calls = 0, destroyed = 0, observed;
  const p = payload();
  p.body.messages[0].content[0].text = 'CONTEXTO_FICTICIO_ñ_日本語_👍\n'.repeat(8000);
  const http = createBedrockHttp({ handlerFactory: () => ({ async handle(request) {
    calls++;
    observed = { ...request, body: Buffer.from(request.body.buffer, request.body.byteOffset, request.body.byteLength).toString('utf8') };
    return { response: { statusCode: 200, headers: { 'content-type': 'application/json', 'x-amzn-requestid': 'fictitious-request' },
      body: Readable.from([Buffer.from(JSON.stringify(response()))]) } };
  }, destroy() { destroyed++; } }) });
  const result = await http({ payload: p, token: token() });
  assert.equal(observed.hostname, 'bedrock-runtime.eu-south-2.amazonaws.com');
  assert.equal(observed.path, '/model/eu.amazon.nova-micro-v1%3A0/converse');
  const expected = { ...p.body }; delete expected.modelId;
  assert.deepEqual(JSON.parse(observed.body), expected);
  assert(observed.headers.authorization.includes(credentials.accessKeyId));
  assert(!observed.body.includes(credentials.secretAccessKey));
  assert(!observed.body.includes(credentials.accessKeyId));
  assert.equal(calls, 1); assert(destroyed >= 1);
  assert.equal(result.output.message.content[0].toolUse.input.confirmado, true);
  assert.equal(result.usage.totalTokens, 54); assert.equal(result.$metadata.requestId, 'fictitious-request');
});

test('SDK preserves two provider attempts for throttling; never follows redirects or retries authorization failures', async () => {
  for (const [status, type, expected, attempts] of [[429, 'ThrottlingException', 'bedrock_throttled', 2],
    [403, 'AccessDeniedException', 'provider_unauthorized', 1], [302, 'Redirect', 'provider_failed', 1]]) {
    let calls = 0;
    const http = createBedrockHttp({ handlerFactory: () => ({ async handle() {
      calls++;
      return { response: { statusCode: status, headers: { 'content-type': 'application/json', location: 'https://foreign.invalid', 'x-amzn-errortype': type },
        body: Readable.from([Buffer.from(JSON.stringify({ message: credentials.secretAccessKey, __type: type }))]) } };
    } }) });
    await assert.rejects(http({ payload: payload(), token: token() }), { code: expected, message: expected });
    assert.equal(calls, attempts);
  }
});

test('typed Bedrock errors remain distinguishable without provider bodies; capacity errors are separate', async () => {
  for (const [name, code] of Object.entries(PROVIDER_ERRORS)) {
    const http = createBedrockHttp({ clientFactory: config => {
      assert.equal(config.maxAttempts, 2); assert.deepEqual(config.credentials, credentials);
      return { async send() { throw Object.assign(Error(credentials.secretAccessKey), { name }); } };
    }, handlerFactory: () => ({}) });
    await assert.rejects(http({ payload: payload(), token: token() }), { code, message: code });
  }
});

test('Bedrock schema forbids tools, files, URLs as resources, model endpoints and injected credentials', () => {
  for (const mutate of [p => { p.body.endpoint = 'http://169.254.169.254'; }, p => { p.credentials = credentials; },
    p => { p.body.modelId = 'arn:aws:bedrock:us-east-1:000000000000:inference-profile/foreign'; },
    p => { p.body.messages[0].content.push({ image: { source: { bytes: 'fake' } } }); },
    p => { p.body.messages[0].role = 'assistant'; }, p => { p.body.toolConfig.toolChoice = { auto: {} }; },
    p => { p.body.toolConfig.tools[0].toolSpec.inputSchema.json.required = ['confirmado']; },
    p => { p.body.toolConfig.tools[0].toolSpec.name = 'foreign_tool'; }, p => { p.useCase = 'arbitrary'; },
    p => { p.timeoutMs = 120001; }, p => { p.body.inferenceConfig.maxTokens = 4097; }]) {
    const p = payload(); mutate(p); assert.throws(() => contract.validate(p), { code: 'invalid_request' });
  }
  const p = payload(); p.body.messages[0].content[0].text += ' Texto que menciona https://example.invalid sin descargarlo.';
  assert.equal(contract.validate(p), p);
});

test('no ambient AWS credentials, and provider reflection of each credential is suppressed', async () => {
  for (const value of [{}, { ...credentials, extra: 'bad' }, { ...credentials, sessionToken: '' }]) {
    await assert.rejects(createBedrockHttp()({ payload: payload(), token: Buffer.from(JSON.stringify(value)) }), { code: 'secret_unavailable' });
  }
  for (const value of Object.values(credentials)) for (const secret of [value, encodeURIComponent(value), Buffer.from(value).toString('base64')]) {
    const http = createBedrockHttp({ clientFactory: () => ({ async send() {
      const r = response(); r.output.message.content[0].toolUse.input.motivo = secret; return r;
    } }), handlerFactory: () => ({}) });
    await assert.rejects(http({ payload: payload(), token: token() }), { code: 'provider_failed' });
  }
});

test('response limit, invalid structured output and abort are handled without unbounded buffering', async () => {
  let stream;
  const handler = limitedHandler({ async handle() { return { response: { body: stream } }; } }, payload().body.modelId);
  const request = { protocol: 'https:', hostname: 'bedrock-runtime.eu-south-2.amazonaws.com', port: 443,
    method: 'POST', path: '/model/eu.amazon.nova-micro-v1%3A0/converse' };
  stream = Readable.from([Buffer.alloc(MAX_REPLY_BYTES + 1)]);
  await assert.rejects(handler.handle(request, {}), { code: 'provider_failed' }); assert(stream.destroyed);
  const controller = new AbortController(); stream = new PassThrough();
  const pending = handler.handle(request, { abortSignal: controller.signal });
  await new Promise(resolve => setImmediate(resolve)); controller.abort();
  await assert.rejects(pending, { code: 'provider_timeout' }); assert(stream.destroyed);
  let reached = false;
  const pinned = limitedHandler({ async handle() { reached = true; } }, payload().body.modelId);
  for (const change of [{ hostname: 'foreign.invalid' }, { path: '/invoke' }, { protocol: 'http:' }, { query: { token: 'bad' } }])
    await assert.rejects(pinned.handle({ ...request, ...change }, {}), { code: 'invalid_request' });
  assert.equal(reached, false);
  const http = createBedrockHttp({ clientFactory: () => ({ async send() {
    return { output: { message: { content: [{ text: 'Unstructured response' }] } }, usage: { inputTokens: 9, outputTokens: 3 } };
  } }), handlerFactory: () => ({}) });
  const result = await http({ payload: payload(), token: token() });
  assert.deepEqual(result.output.message.content, []); assert.equal(result.usage.inputTokens, 9);
});
