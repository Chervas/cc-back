'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { prepare } = require('./prepare.cjs');
const source = path.resolve(__dirname, '../../../services/integrations-broker');
require(path.join(source, 'test/offline-guard.cjs'));
const originalHashes = Object.fromEntries(['bedrock-contract.js', 'bedrock-http.js', 'bedrock-limits.js'].map(name =>
  [name, fs.readFileSync(path.join(source, 'src', name))]));
const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-sonnet-contract-'));
const trial = path.join(parent, 'broker');
const receipt = prepare(source, trial);
const contract = require(path.join(trial, 'src/bedrock-contract'));
const httpModule = require(path.join(trial, 'src/bedrock-http'));
const fixture = require(path.join(source, 'test/bedrock-fixture.cjs'));
test.after(() => fs.rmSync(parent, { recursive: true, force: true }));

function payload() {
  const p = fixture.payload();
  p.useCase = 'google_review_reply_draft';
  p.body.modelId = contract.MODEL;
  p.body.inferenceConfig = { maxTokens: 1000 };
  p.body.toolConfig.toolChoice = { auto: {} };
  p.body.additionalModelRequestFields = { thinking: { type: 'between_tools' } };
  return p;
}
function context(p = payload(), id = contract.PRINCIPAL) {
  return { principal: { id }, request: { operation: 'ai.bedrock.converse.v1', tenantRef: 'platform:staging',
    connectionRef: 'bedrock:staging', assetRef: 'ai:' + p.useCase, payload: p },
    binding: { provider: 'aws_bedrock', bedrock: { region: 'eu-south-2', models: [contract.MODEL, fixture.payload().body.modelId] } } };
}
test('trial keeps valid Nova contracts and forced tools unchanged', () => {
  const p = fixture.payload();
  assert.equal(contract.validate(p), p);
  assert.doesNotThrow(() => contract.authorize(context(p, 'bedrock:staging')));
  p.body.toolConfig.toolChoice = { auto: {} };
  assert.throws(() => contract.validate(p), { code: 'invalid_request' });
});
test('trial identity cannot use Nova and CRM cannot use Sonnet even with a hypothetical grant', () => {
  assert.doesNotThrow(() => contract.authorize(context()));
  assert.throws(() => contract.authorize(context(payload(), 'bedrock:staging')), { code: 'scope_denied' });
  assert.throws(() => contract.authorize(context(fixture.payload())), { code: 'scope_denied' });
  for (const patch of [{ tenantRef: 'platform:dev' }, { connectionRef: 'bedrock:foreign' }, { assetRef: 'ai:custom' }]) {
    const c = context(); Object.assign(c.request, patch);
    assert.throws(() => contract.authorize(c), { code: 'scope_denied' });
  }
});
test('Sonnet trial rejects arbitrary purposes, settings, tools, routing and large outputs', () => {
  const valid = payload(), before = structuredClone(valid);
  assert.equal(contract.validate(valid), valid); assert.deepEqual(valid, before);
  for (const mutate of [p => { p.useCase = 'custom'; }, p => { p.body.inferenceConfig.temperature = 0; },
    p => { p.body.inferenceConfig.maxTokens = 1201; }, p => { p.body.additionalModelRequestFields.thinking.type = 'adaptive'; },
    p => { p.body.additionalModelRequestFields.endpoint = 'https://foreign.invalid'; },
    p => { p.body.modelId = 'global.anthropic.claude-sonnet-5-5'; },
    p => { p.body.toolConfig.toolChoice = { tool: { name: 'submit_analysis' } }; },
    p => { p.body.toolConfig.tools[0].toolSpec.inputSchema.json.required = []; },
    p => { p.body.toolConfig.tools[0].toolSpec.name = 'publish_review'; },
    p => { p.body.messages[0].content.push({ text: 'extra' }); },
    p => { p.body.messages[0].role = 'assistant'; }, p => { p.credentials = fixture.credentials; }]) {
    const p = payload(); mutate(p); assert.throws(() => contract.validate(p), { code: 'invalid_request' });
  }
});
test('real SDK serializes Sonnet native auto tool and thinking settings with no provider-side changes', async () => {
  let observed;
  const call = httpModule.createBedrockHttp({ handlerFactory: () => ({ async handle(request) {
    observed = { host: request.hostname, path: request.path,
      body: JSON.parse(Buffer.from(request.body.buffer, request.body.byteOffset, request.body.byteLength).toString('utf8')) };
    return { response: { statusCode: 200, headers: { 'content-type': 'application/json' },
      body: Readable.from([Buffer.from(JSON.stringify(fixture.response()))]) } };
  }, destroy() {} }) });
  const p = payload();
  const r = await call({ payload: p, token: Buffer.from(JSON.stringify(fixture.credentials)) });
  const expected = structuredClone(p.body); delete expected.modelId;
  assert.deepEqual(observed.body, expected);
  assert.equal(observed.host, 'bedrock-runtime.eu-south-2.amazonaws.com');
  assert.equal(observed.path, '/model/' + encodeURIComponent(contract.MODEL) + '/converse');
  assert.equal(r.usage.inputTokens, 42); assert.equal(r.usage.outputTokens, 12);
  assert.deepEqual(r.trialValidation, { version: 1, valid: true, errors: [], toolUseCount: 1 });
  assert(!JSON.stringify(observed.body).includes(fixture.credentials.accessKeyId));
});
test('model binding admits only the exact EU trial model alongside existing Nova', () => {
  const Ajv = require(path.join(source, 'node_modules/ajv'));
  const check = new Ajv({ strict: true }).compile(contract.bindingSchema);
  assert(check({ region: 'eu-south-2', models: [fixture.payload().body.modelId, contract.MODEL] }));
  assert(!check({ region: 'us-east-1', models: [contract.MODEL] }));
  assert(!check({ region: 'eu-south-2', models: ['global.anthropic.claude-sonnet-5-5'] }));
});
test('preparation refuses overwrite of a prepared destination', () => {
  assert.throws(() => prepare(source, trial), /new isolated destination/);
});

function responseCall(result, p = payload()) {
  let sends = 0;
  const call = httpModule.createBedrockHttp({ clientFactory: config => {
    assert.equal(config.maxAttempts, p.body.modelId === contract.MODEL ? 1 : 2);
    return { async send() { sends++; return result; }, destroy() {} };
  }, handlerFactory: () => ({}) });
  return call({ payload: p, token: Buffer.from(JSON.stringify(fixture.credentials)) }).then(value => {
    assert.equal(sends, 1); return value;
  });
}

test('Sonnet makes one SDK attempt for 429/500; every Nova model retains two', async () => {
  const models = [contract.MODEL, ...require(path.join(source, 'src/bedrock-limits')).MODELS];
  for (const model of models) for (const [status, type, code] of [
    [429, 'ThrottlingException', 'bedrock_throttled'], [500, 'InternalServerException', 'bedrock_internal_error'],
  ]) {
    let attempts = 0;
    const p = model === contract.MODEL ? payload() : fixture.payload(); p.body.modelId = model;
    const call = httpModule.createBedrockHttp({ handlerFactory: () => ({ async handle() {
      attempts++;
      return { response: { statusCode: status, headers: { 'content-type': 'application/json', 'x-amzn-errortype': type },
        body: Readable.from([Buffer.from(JSON.stringify({ __type: type, message: 'PRIVATE_PROVIDER_DETAIL' }))]) } };
    }, destroy() {} }) });
    await assert.rejects(call({ payload: p, token: Buffer.from(JSON.stringify(fixture.credentials)) }), { code, message: code });
    assert.equal(attempts, model === contract.MODEL ? 1 : 2);
  }
});

test('invalid output keeps usage, latency and safe identifiers, never throws or retries', async () => {
  const cases = [
    ['output_schema_invalid', r => { r.output.message.content[0].toolUse.input.confirmado = 'true'; }],
    ['output_schema_invalid', r => { delete r.output.message.content[0].toolUse.input.motivo; }],
    ['output_schema_invalid', r => { r.output.message.content[0].toolUse.input.PRIVATE_EXTRA_FIELD = 'PRIVATE_PROVIDER_DETAIL'; }],
    ['invalid_tool_use', r => { r.output.message.content[0].toolUse.input = []; }],
    ['invalid_tool_use', r => { r.output.message.content[0].toolUse.input = null; }],
    ['invalid_tool_use', r => { delete r.output.message.content[0].toolUse.toolUseId; }],
    ['unexpected_tool_name', r => { r.output.message.content[0].toolUse.name = 'PRIVATE_PROVIDER_DETAIL'; }],
    ['tool_use_multiple', r => { r.output.message.content.push(structuredClone(r.output.message.content[0])); }],
    ['tool_use_multiple', r => { r.output.message.content.push({ toolUse: { name: 'PRIVATE_PROVIDER_DETAIL' } }); }],
    ['tool_use_missing', r => { r.output.message.content = [{ text: 'PRIVATE_PROVIDER_DETAIL' }]; }],
    ['tool_use_missing', r => { r.output.message.content = [{ reasoningContent: { reasoningText: { text: 'PRIVATE_PROVIDER_DETAIL' } } }]; }],
    ['invalid_response_structure', r => { r.output.message.role = 'user'; }],
    ['invalid_response_structure', r => { r.output.message.content = {}; }],
    ['invalid_response_structure', r => { r.output.message.content.push(null); }],
    ['invalid_response_structure', r => { r.output.message.content[0].text = 'PRIVATE_PROVIDER_DETAIL'; }],
    ['invalid_response_structure', r => { delete r.output; }],
  ];
  for (const [expected, mutate] of cases) {
    const r = fixture.response(); mutate(r);
    const actual = await responseCall(r);
    assert.equal(actual.trialValidation.valid, false);
    assert(actual.trialValidation.errors.includes(expected), expected);
    assert.deepEqual(actual.output.message.content, []);
    assert.deepEqual(actual.usage, r.usage); assert.deepEqual(actual.metrics, r.metrics);
    assert.equal(actual.$metadata.requestId, 'fictitious-request');
    assert.doesNotMatch(JSON.stringify(actual), /PRIVATE_|FICTITIOUS_OUTPUT/);
  }
});

test('truncation, refusal and other stops invalidate even schema-valid tools without losing metrics', async () => {
  for (const stopReason of ['max_tokens', 'end_turn', 'refusal', 'guardrail_intervened', 'content_filtered',
    'malformed_model_output', 'malformed_tool_use', 'model_context_window_exceeded', 'stop_sequence']) {
    const r = fixture.response(); r.stopReason = stopReason;
    const actual = await responseCall(r);
    assert.deepEqual(actual.trialValidation, { version: 1, valid: false, errors: ['invalid_stop_reason'], toolUseCount: 1 });
    assert.equal(actual.stopReason, stopReason); assert.deepEqual(actual.usage, r.usage);
    assert.deepEqual(actual.output.message.content, []);
  }
  const r = fixture.response(); r.stopReason = 'PRIVATE_PROVIDER_DETAIL'; r.$metadata.requestId = 'PRIVATE PROVIDER DETAIL';
  const actual = await responseCall(r);
  assert.equal(actual.stopReason, ''); assert.equal(actual.$metadata.requestId, '');
  assert.doesNotMatch(JSON.stringify(actual), /PRIVATE/);
});

test('validation uses the submitted schema including enums, ranges, types and additionalProperties', async () => {
  const p = payload();
  const schema = p.body.toolConfig.tools[0].toolSpec.inputSchema.json;
  schema.properties.motivo.enum = ['allowed'];
  schema.properties.confianza = { type: 'number', minimum: 0, maximum: 1 }; schema.required.push('confianza');
  for (const [motivo, confianza, valid] of [['allowed', 0.5, true], ['PRIVATE_PROVIDER_DETAIL', 0.5, false],
    ['allowed', 1.1, false], ['allowed', '0.5', false]]) {
    const r = fixture.response(); Object.assign(r.output.message.content[0].toolUse.input, { motivo, confianza });
    const actual = await responseCall(r, p);
    assert.equal(actual.trialValidation.valid, valid);
    assert.deepEqual(actual.trialValidation.errors, valid ? [] : ['output_schema_invalid']);
  }
});

test('valid tools survive accompanying text/reasoning; ancillary provider content is omitted', async () => {
  const r = fixture.response();
  r.output.message.content.unshift({ text: 'PRIVATE_PROVIDER_DETAIL' }, { reasoningContent: { redactedContent: 'PRIVATE_PROVIDER_DETAIL' } });
  const actual = await responseCall(r);
  assert.deepEqual(actual.trialValidation, { version: 1, valid: true, errors: [], toolUseCount: 1 });
  assert.equal(actual.output.message.content[0].toolUse.input.confirmado, true);
  assert.doesNotMatch(JSON.stringify(actual), /PRIVATE_PROVIDER_DETAIL/);
});

test('credential reflection is invalid output with preserved metrics and fixed error codes', async () => {
  for (const value of Object.values(fixture.credentials)) for (const secret of [value, encodeURIComponent(value), Buffer.from(value).toString('base64')]) {
    const r = fixture.response(); r.output.message.content[0].toolUse.input.motivo = secret;
    const actual = await responseCall(r);
    assert.deepEqual(actual.trialValidation, { version: 1, valid: false, errors: ['credential_reflection'], toolUseCount: 1 });
    assert.deepEqual(actual.usage, r.usage); assert.deepEqual(actual.output.message.content, []);
    assert(!JSON.stringify(actual).includes(secret));
  }
});

test('concurrent Sonnet requests do not exchange validity or metrics', async () => {
  const gates = [];
  const call = httpModule.createBedrockHttp({ clientFactory: () => ({
    send: () => new Promise(resolve => gates.push(resolve)), destroy() {},
  }), handlerFactory: () => ({}) });
  const args = () => ({ payload: payload(), token: Buffer.from(JSON.stringify(fixture.credentials)) });
  const first = call(args()), second = call(args());
  const good = fixture.response(), bad = fixture.response(); bad.usage.inputTokens = 99; bad.stopReason = 'max_tokens';
  gates[1](bad); const result2 = await second;
  gates[0](good); const result1 = await first;
  assert.equal(result1.trialValidation.valid, true); assert.equal(result1.usage.inputTokens, 42);
  assert.equal(result2.trialValidation.valid, false); assert.equal(result2.usage.inputTokens, 99);
});

test('Nova projection and transport errors remain unchanged; no trial metadata', async () => {
  const original = require(path.join(source, 'src/bedrock-http'));
  for (const invalid of [false, true]) {
    const r = fixture.response();
    if (invalid) { r.stopReason = 'max_tokens'; r.output.message.content[0].toolUse.input = { arbitrary: true }; }
    assert.deepEqual(await responseCall(r, fixture.payload()), original.project(r));
  }
  const call = httpModule.createBedrockHttp({ clientFactory: () => ({ async send() {
    throw Object.assign(Error('PRIVATE_PROVIDER_DETAIL'), { name: 'AbortError' });
  }, destroy() {} }), handlerFactory: () => ({}) });
  for (const p of [payload(), fixture.payload()]) {
    await assert.rejects(call({ payload: p, token: Buffer.from(JSON.stringify(fixture.credentials)) }),
      { code: 'provider_timeout', message: 'provider_timeout' });
  }
});

test('prepare installs both wrappers only in the trial and pins the original HTTP', () => {
  for (const [name, bytes] of Object.entries(originalHashes)) assert.deepEqual(fs.readFileSync(path.join(source, 'src', name)), bytes);
  assert.deepEqual(fs.readFileSync(path.join(trial, 'src/bedrock-http-original.js')), originalHashes['bedrock-http.js']);
  assert.deepEqual(fs.readFileSync(path.join(trial, 'src/bedrock-http.js')), fs.readFileSync(path.join(__dirname, 'http.cjs')));
  assert.match(receipt.httpOverlaySHA256, /^[a-f0-9]{64}$/);
  assert.equal(receipt.originalHttpSHA256, '955444fead5f3e4dbcec39bf7b064f61e88fb98b7e7c97578c702749a94460c8');
  const fixtureSource = path.join(parent, 'modified-source'); fs.mkdirSync(path.join(fixtureSource, 'src'), { recursive: true });
  for (const [name, bytes] of Object.entries(originalHashes)) fs.writeFileSync(path.join(fixtureSource, 'src', name), bytes);
  fs.appendFileSync(path.join(fixtureSource, 'src/bedrock-http.js'), '\n// changed\n');
  const destination = path.join(parent, 'refused-trial');
  assert.throws(() => prepare(fixtureSource, destination), /Original HTTP changed/);
  assert.equal(fs.existsSync(destination), false);
});

test('private overlay sources retain original runtime modes on every installed module', () => {
  const overlaySource = path.join(parent, 'private-overlays'); fs.mkdirSync(overlaySource);
  for (const name of ['prepare.cjs', 'contract.cjs', 'http.cjs']) {
    fs.copyFileSync(path.join(__dirname, name), path.join(overlaySource, name));
    fs.chmodSync(path.join(overlaySource, name), 0o600);
  }
  const privatePrepare = require(path.join(overlaySource, 'prepare.cjs')).prepare;
  // 0644 reproduces the deployed runtime; 0640 verifies no hardcoded widening.
  for (const mode of [0o644, 0o640]) {
    const runtime = path.join(parent, `mode-source-${mode}`);
    const destination = path.join(parent, `mode-trial-${mode}`);
    fs.mkdirSync(path.join(runtime, 'src'), { recursive: true });
    for (const [name, bytes] of Object.entries(originalHashes)) {
      fs.writeFileSync(path.join(runtime, 'src', name), bytes);
      fs.chmodSync(path.join(runtime, 'src', name), mode);
    }
    privatePrepare(runtime, destination);
    for (const name of ['bedrock-contract.js', 'bedrock-contract-original.js',
      'bedrock-http.js', 'bedrock-http-original.js', 'bedrock-limits.js']) {
      const actual = fs.statSync(path.join(destination, 'src', name)).mode & 0o777;
      assert.equal(actual, mode, `${name} must retain original runtime mode`);
      if (mode === 0o644) assert.equal(actual & 0o004, 0o004, `${name} must remain readable by the service UID`);
    }
    for (const [name, bytes] of Object.entries(originalHashes)) {
      assert.equal(fs.statSync(path.join(runtime, 'src', name)).mode & 0o777, mode);
      assert.deepEqual(fs.readFileSync(path.join(runtime, 'src', name)), bytes);
    }
  }
  for (const name of ['contract.cjs', 'http.cjs']) assert.equal(fs.statSync(path.join(overlaySource, name)).mode & 0o777, 0o600);
});
