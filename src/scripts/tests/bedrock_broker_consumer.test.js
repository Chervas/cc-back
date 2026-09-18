'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createBedrockBroker } = require('../../services/bedrockBroker.service');
const { createBedrockAdmission } = require('../../lib/bedrockAdmission');
const contract = require('../../../services/integrations-broker/src/bedrock-contract');
const { PROVIDER_ERRORS } = require('../../../services/integrations-broker/src/bedrock-errors');
const { response } = require('../../../services/integrations-broker/test/bedrock-fixture.cjs');
const plain = value => JSON.parse(JSON.stringify(value));
const input = { useCase: 'confirm_appointment', model: 'eu.amazon.nova-micro-v1:0', systemPrompt: 'Ficticio.',
  prompt: 'Confirma la cita.', inputText: 'Sí, allí estaré. 日本語 👍', outputFormat: { confirmado: 'boolean', motivo: 'string' } };
function load(name, env, dependencies) {
  const filename = path.join(__dirname, '../../services/', name + '.service.js'), local = createRequire(filename), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process: { env },
    require: key => Object.hasOwn(dependencies, key) ? dependencies[key] : local(key), console, AbortController, setTimeout, clearTimeout }, { filename });
  return module.exports;
}
function setup(work = async () => response(), admission = createBedrockAdmission({spacingMs:0})) {
  const env = { BEDROCK_ENABLED: 'true', BEDROCK_BROKER_ENABLED: 'true', BEDROCK_BROKER_ENVIRONMENT: 'staging',
    BEDROCK_BROKER_AUDIENCE: 'clinicaclick:bedrock:staging:v1', BEDROCK_BROKER_CONNECTION_REF: 'bedrock:staging' };
  const calls = [], usage = [], pauses = []; let paused = false;
  for (const key of ['BEDROCK_AWS_ACCESS_KEY_ID', 'BEDROCK_AWS_SECRET_ACCESS_KEY', 'BEDROCK_AWS_SESSION_TOKEN'])
    Object.defineProperty(env, key, { get() { throw Error('LOCAL_PROVIDER_CREDENTIAL_WAS_READ'); } });
  const broker = createBedrockBroker({ env, admission, readFile: () => Buffer.from('fictitious signing identity'), clientFactory: config => {
    assert.equal(config.transportProfile, 'ai');
    return { async execute(command, options) {
      contract.validate(plain(command.payload)); calls.push(plain(command));
      assert.equal(options.timeoutMs, command.payload.timeoutMs + 10000);
      return { data: await work(command, calls.length) };
    } };
  } });
  const bedrock = load('bedrockAiProvider', env, { './bedrockBroker.service': broker,
    './aiUsageTelemetry.service': { async recordAiUsage(event) { usage.push(event); } } });
  bedrock.__testing.setClientForTests({ send() { throw Error('DIRECT_BEDROCK_WAS_CALLED'); } });
  const orchestrator = load('aiOrchestrator', env, { './bedrockAiProvider.service': bedrock,
    './aiUsageTelemetry.service': { async recordAiUsage(event) { usage.push(event); } },
    './securityMonitoring.service': { async assertAiAllowed(useCase) { pauses.push(useCase); if (paused) throw Object.assign(Error('ai_paused'), { code: 'ai_paused' }); } } });
  return { env, broker, bedrock, orchestrator, calls, usage, pauses, pause() { paused = true; } };
}

test('broker uses exactly the direct adapter native request, without reading a provider credential', async () => {
  const directEnv = { BEDROCK_ENABLED: 'true', BEDROCK_AWS_ACCESS_KEY_ID: 'FICTITIOUS', BEDROCK_AWS_SECRET_ACCESS_KEY: 'FICTITIOUS' };
  const direct = load('bedrockAiProvider', directEnv, { './bedrockBroker.service': { enabled: () => false } });
  const bodies = []; direct.__testing.setClientForTests({ async send(command) { bodies.push(plain(command.input)); return response(); } });
  const f = setup();
  for (const text of [input.inputText, 'Historial ficticio largo. ñ 日本語 👍\n'.repeat(8000)]) {
    const expected = await direct.analyzeStructured({ ...input, inputText: text });
    const actual = await f.bedrock.analyzeStructured({ ...input, inputText: text });
    assert.deepEqual(f.calls.at(-1).payload.body, bodies.at(-1));
    assert.deepEqual(plain(actual), plain(expected));
    assert.equal(f.calls.at(-1).assetRef, 'ai:confirm_appointment');
    assert.equal(f.calls.at(-1).tenantRef, 'platform:staging');
  }
  assert.equal(f.bedrock.getConfig().accessKeyId, '');
  await f.bedrock.checkModel(input.model); assert.equal(f.calls.at(-1).assetRef, 'ai:health_check');
});

test('orchestrator retains provider fallback, usage and purpose, but never retries broker admission/auth/secret failures', async () => {
  for (const [name, code] of Object.entries(PROVIDER_ERRORS)) {
    const f = setup(async (_command, count) => {
      if (count === 1) throw Object.assign(Error(code), { code }); return response();
    });
    const retryable = f.bedrock.isRetryableError({ name });
    if (retryable) {
      const result = await f.orchestrator.analyzeStructured({ ...input, analysisMode: 'quick_qa' });
      assert.equal(result._ai_fallback_used, true); assert.equal(f.calls.length, 2); assert.equal(f.usage.length, 2);
      assert.deepEqual(f.calls.map(c => c.payload.body.modelId), ['eu.amazon.nova-micro-v1:0', 'eu.amazon.nova-lite-v1:0']);
    } else {
      await assert.rejects(f.orchestrator.analyzeStructured(input), { code }); assert.equal(f.calls.length, 1);
    }
    assert(f.calls.every(c => c.payload.useCase === input.useCase));
  }
  for (const code of ['rate_limited', 'scope_denied', 'secret_unavailable', 'audit_unavailable', 'connection_blocked',
    'provider_unauthorized', 'provider_timeout', 'broker_timeout', 'broker_unavailable', 'broker_queue_full', 'broker_queue_timeout']) {
    const f = setup(async () => { throw Object.assign(Error(code), { code }); });
    await assert.rejects(f.orchestrator.analyzeStructured(input), { code }); assert.equal(f.calls.length, 1);
  }
});

test('queued conversations recheck the pause and provider switch immediately before dispatch', async () => {
  for (const scenario of ['pause','disabled']) {
    let release;
    const hold=new Promise(resolve=>{release=resolve;});
    const f=setup(async()=>{await hold;return response();},createBedrockAdmission({maxConcurrent:1,spacingMs:0}));
    const first=f.orchestrator.analyzeStructured(input);await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.calls.length,1);
    const second=f.orchestrator.analyzeStructured(input);const denied=assert.rejects(second,{code:scenario==='pause'?'ai_paused':'bedrock_disabled'});
    await new Promise(resolve=>setImmediate(resolve));
    if(scenario==='pause')f.pause();else f.env.BEDROCK_ENABLED='false';
    release();await first;await denied;assert.equal(f.calls.length,1);
  }
});

test('a waiting request snapshots the native context before the caller can mutate it', async () => {
  let run;let received;
  const f=setup();
  const body={modelId:input.model,system:[{text:'ORIGINAL'}]};
  // Use a dedicated minimal client: this check concerns snapshotting, not the
  // native Converse contract (validated independently by the other tests).
  const broker=createBedrockBroker({env:f.env,readFile:()=>Buffer.from('fictitious'),admission:{run(work){run=work;return new Promise(resolve=>{run=()=>work().then(resolve);});}},clientFactory:()=>({async execute(command){received=command.payload.body;return {data:{ok:true}};}})});
  const promise=broker.execute('custom',body);body.system[0].text='MUTATED';await run();await promise;
  assert.equal(received.system[0].text,'ORIGINAL');
});

test('pause, disabled provider and foreign broker environment stop inference; malformed output retains the existing controlled fallback', async () => {
  const paused = setup(); paused.pause();
  await assert.rejects(paused.orchestrator.analyzeStructured(input), { code: 'ai_paused' }); assert.equal(paused.calls.length, 0);
  const disabled = setup(); disabled.env.BEDROCK_ENABLED = 'false';
  await assert.rejects(disabled.orchestrator.analyzeStructured(input), { code: 'bedrock_disabled' }); assert.equal(disabled.calls.length, 0);
  const foreign = setup(); foreign.env.BEDROCK_BROKER_ENVIRONMENT = 'dev';
  await assert.rejects(foreign.orchestrator.analyzeStructured(input), { code: 'broker_configuration_invalid' }); assert.equal(foreign.calls.length, 0);
  const malformed = setup(async (_command, count) => count === 1 ? { output: { message: { content: [] } }, usage: { inputTokens: 7, outputTokens: 2 } } : response());
  const result = await malformed.orchestrator.analyzeStructured(input);
  assert.equal(result._ai_fallback_used, true); assert.equal(malformed.calls.length, 2);
  assert.equal(malformed.usage[0].inputTokens, 7); assert.equal(malformed.usage[0].outputTokens, 2);
  assert(malformed.usage.every(event => !Object.hasOwn(event, 'inputText') && !Object.hasOwn(event, 'prompt')));
});
