'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createAiBroker } = require('../../services/aiBroker.service');
const { MODEL_CHECK_OPERATION } = require('../../../services/integrations-broker/src/ai-limits');
function monitoring({ env = {}, checkModel = async (_provider, model) => ({ data: { model, available: true } }) } = {}) {
  const calls = []; const module = { exports: {} };
  const dependencies = {
    axios: { get() { throw Error('direct_provider_forbidden'); } }, sequelize: { Op: {} }, '../../models': {},
    './bedrockAiProvider.service': { enabled: () => false }, './aiOrchestrator.service': { models: () => ({}) },
    './aiBroker.service': { enabled: () => true, checkModel: (...args) => { calls.push(args); return checkModel(...args); } },
  };
  const filename = path.join(__dirname, '../../services/aiRuntimeMonitoring.service.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process: { env },
    require(name) { assert(Object.hasOwn(dependencies, name)); return dependencies[name]; } }, { filename });
  return { service: module.exports, calls };
}
test('AI inventory stays configured without local provider keys; Groq health is fetched once and cached', async () => {
  const f = monitoring(); const health = await f.service.loadHealth();
  for (const model of health.models.filter(row => row.provider !== 'bedrock')) assert.equal(model.configured, true);
  assert.equal(health.models.find(row => row.key === 'groq_audio').health.ok, true);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0][0], 'groq'); assert.equal(f.calls[0][1], 'whisper-large-v3-turbo');
  await f.service.loadHealth(); assert.equal(f.calls.length, 1);
});
test('health failure remains visible and never falls back to the still-present legacy key', async () => {
  const f = monitoring({ env: { GROQ_API_KEY: 'FICTITIOUS_LEGACY_KEY' }, checkModel: async () => { throw Object.assign(Error('provider_unauthorized'), { code: 'provider_unauthorized' }); } });
  const model = (await f.service.loadHealth()).models.find(row => row.key === 'groq_audio');
  assert.equal(model.configured, true); assert.equal(model.health.ok, false); assert.equal(model.health.error_code, 'provider_unauthorized');
  assert.equal(f.calls.length, 1); assert(!JSON.stringify(model).includes('FICTITIOUS_LEGACY_KEY'));
});
test('the application signs a separate health scope and does not forward provider credentials', async () => {
  const calls = [];
  const client = createAiBroker({ env: { AI_BROKER_ENVIRONMENT: 'dev', AI_BROKER_GROQ_ENABLED: 'true',
    AI_BROKER_GROQ_CONNECTION_REF: 'ai:groq:dev', GROQ_API_KEY: 'FICTITIOUS_KEY' }, readFile: () => Buffer.from('fictitious'),
    clientFactory: () => ({ execute: async command => { calls.push(command); return { data: { model: command.payload.body.model, available: true } }; } }) });
  const response = await client.checkModel('groq', 'whisper-large-v3-turbo'); assert.equal(response.data.available, true);
  assert.equal(calls[0].operation, MODEL_CHECK_OPERATION); assert.equal(calls[0].tenantRef, 'platform:dev');
  assert.equal(calls[0].assetRef, 'ai:provider_health'); assert.equal(calls[0].payload.timeoutMs, 5000);
  assert(!JSON.stringify(calls[0]).includes('FICTITIOUS_KEY'));
  assert.throws(() => client.checkModel('openai', 'model'), { code: 'invalid_request' }); assert.equal(calls.length, 1);
});
