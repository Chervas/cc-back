'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { validate } = require('../../../services/integrations-broker/src/ai-contract');
const { createAiBroker } = require('../../services/aiBroker.service');

function load(name, broker, extra = '') {
  const filename = path.join(__dirname, '../../services/', name + '.service.js');
  const local = createRequire(filename), telemetry = [], policy = [];
  const module = { exports: {} };
  const empty = { Sequelize: { Op: {} } };
  const dependencies = {
    axios: { post() { throw Error('Unexpected direct provider request'); } }, './aiBroker.service': broker,
    '../../models': empty, sequelize: { Op: {} }, './jobRequests.service': {}, './clinicalPrivateStorage.service': {},
    './accounting.service': {}, './webProjects.service': { positiveInteger: value => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : null }, './webContentMedia.service': {},
    '../lib/webDocument': { canonicalSerialize: value => local('../lib/webDocument').canonicalSerialize(JSON.parse(JSON.stringify(value))) },
    './securityMonitoring.service': { async assertAiAllowed(value) { policy.push(value); } },
    './aiUsageTelemetry.service': { async recordProviderResponse(value) { telemetry.push(value); }, async recordProviderFailure() {} },
  };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8') + extra, { module, exports: module.exports,
    require: key => Object.hasOwn(dependencies, key) ? dependencies[key] : local(key),
    Buffer, FormData, Blob, URL, URLSearchParams, process: { env: {} }, console,
    setTimeout, clearTimeout }, { filename });
  return { service: module.exports, telemetry, policy };
}
test('every current AI consumer works without local provider keys and preserves the reviewed broker payload', async () => {
  const calls = [];
  const broker = { enabled: () => true, async execute(provider, useCase, body, options) {
    const payload = JSON.parse(JSON.stringify({ useCase, body, timeoutMs: options.timeoutMs }));
    validate(provider, payload); calls.push({ provider, ...payload });
    const text = useCase === 'accounting_ocr' ? '{"total":12.5}' : useCase === 'web_content' ? '{"title":"Fictitious"}' : 'Fictitious response';
    return { data: provider === 'groq' ? { text, duration: 1.2 }
      : provider === 'gemini' ? { model: body.model, outputs: [{ type: 'text', text }], usage: { total_tokens: 9 } }
      : { model: body.model, status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 4, output_tokens: 5, total_tokens: 9 } } };
  } };
  const groq = load('groqAudio', broker);
  assert.equal(groq.service.isConfigured(), true);
  assert.equal((await groq.service.transcribeAudioBuffer({ buffer: Buffer.from('fictitious audio'), mimeType: 'audio/ogg; codecs=opus' })).text, 'Fictitious response');
  const accounting = load('accountingIngestion', broker, '\nmodule.exports.extractForTest = extractWithOpenAi;');
  assert.equal((await accounting.service.extractForTest({ content_type: 'application/pdf', original_filename: 'fictitious.pdf' }, Buffer.from('fictitious PDF'))).data.total, 12.5);
  const web = load('webContentGeneration', broker);
  const generated = await web.service.__testing.runOpenAiGeneration({ locale: 'es-ES', tone: 'concise', contentType: 'benefit',
    objective: 'present_benefits', contextSnapshot: { clinic: { name: 'Fictitious clinic' }, context: { kind: 'topic', code: 'patient_experience' } } });
  assert.equal(generated.output.title, 'Fictitious');
  const visibility = load('marketingAiVisibility', broker);
  const input = { query: 'Fictitious clinic query', clinic: { id: 123, name: 'Fictitious', city: 'Madrid', country: 'España' } };
  await visibility.service.__testing.runOpenAiSearch(input);
  await visibility.service.__testing.runGeminiSearch(input);
  assert.deepEqual(calls.map(c => c.useCase), ['whatsapp_audio', 'accounting_ocr', 'web_content', 'visibility_openai', 'visibility_gemini']);
  assert.equal(calls[1].timeoutMs, 120000); assert.equal(calls[2].timeoutMs, 90000);
  assert.equal(calls[0].body.model, 'whisper-large-v3-turbo'); assert.equal(calls[1].body.model, 'gpt-5.4-nano');
  assert.equal(groq.telemetry.length + accounting.telemetry.length + web.telemetry.length + visibility.telemetry.length, 5);
  assert.equal(groq.policy.length + accounting.policy.length + web.policy.length + visibility.policy.length, 5);
});
test('broker configuration and provider failures never fall back to a legacy key', async () => {
  let calls = 0;
  const env = { AI_BROKER_ENVIRONMENT: 'dev', AI_BROKER_GROQ_ENABLED: 'true', AI_BROKER_GROQ_CONNECTION_REF: 'ai:groq:dev',
    GROQ_API_KEY: 'FICTITIOUS_LEGACY_KEY' };
  const adapter = createAiBroker({ env, readFile: () => Buffer.from('fictitious'), clientFactory: () => ({
    async execute(command) { calls++; assert.equal(command.tenantRef, 'platform:dev');
      assert(!JSON.stringify(command).includes('FICTITIOUS_LEGACY_KEY'));
      throw Object.assign(Error('provider_unauthorized'), { code: 'provider_unauthorized' }); },
  }) });
  await assert.rejects(adapter.execute('groq', 'whatsapp_audio', {}), error => error.response.status === 401);
  assert.equal(calls, 1);
  env.AI_BROKER_ENVIRONMENT = 'other';
  await assert.rejects(adapter.execute('groq', 'whatsapp_audio', {}), { code: 'broker_configuration_invalid' });
  assert.equal(calls, 1);
});
