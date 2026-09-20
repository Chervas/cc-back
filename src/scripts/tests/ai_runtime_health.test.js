'use strict';
// Runs the monitoring service with synthetic provider replies and no database/network.
// Also applies to public consumers that still use the direct provider transport.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function fixture({ env = {}, audioReply = { data: [{ id: 'whisper-large-v3-turbo' }] }, bedrock = true } = {}) {
  let checks = 0;
  const dependencies = {
    axios: { get: async () => { checks++; return { data: audioReply }; } },
    sequelize: { Op: {} }, '../../models': {},
    './bedrockAiProvider.service': { enabled: () => bedrock, getConfig: () => ({ region: 'eu-south-2' }),
      checkModel: async model => ({ model, ok: true, checked_at: '2026-09-20T00:00:00Z' }) },
    './aiOrchestrator.service': { models: () => ({ fast: 'fast', complex: 'complex', assistant: 'assistant', fallback: 'complex' }) },
    './aiBroker.service': { enabled: () => false },
  };
  const module = { exports: {} };
  const filename = path.join(__dirname, '../../services/aiRuntimeMonitoring.service.js');
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, process: { env },
    require(name) { assert(Object.hasOwn(dependencies, name)); return dependencies[name]; } }, { filename });
  return { service: module.exports, checks: () => checks };
}
test('local OpenAI/Gemini keys do not manufacture availability checks or timestamps', async () => {
  const f = fixture({ env: { OPENAI_API_KEY: 'FICTITIOUS', GEMINI_API_KEY: 'FICTITIOUS' } });
  const result = await f.service.getOverview();
  const unchecked = result.models.filter(model => ['openai', 'gemini'].includes(model.provider));
  assert.equal(unchecked.length, 4);
  for (const model of unchecked) { assert.equal(model.configured, true); assert.equal(model.health.ok, null); assert.equal(model.health.checked_at, null); }
  assert.equal(result.summary.status, 'unverified'); assert.equal(result.summary.unverified_models, 4);
  assert.equal(f.checks(), 0); assert(!JSON.stringify(result).includes('FICTITIOUS'));
});
test('confirmed failure precedes unchecked models, and cached reads do not repeat provider checks', async () => {
  const f = fixture({ env: { GROQ_API_KEY: 'FICTITIOUS', OPENAI_API_KEY: 'FICTITIOUS' }, audioReply: {} });
  const result = await f.service.getOverview();
  const audio = result.models.find(model => model.key === 'groq_audio');
  assert.equal(audio.health.ok, false); assert.equal(audio.health.error_code, 'provider_invalid_response');
  assert.equal(result.summary.status, 'error'); assert.equal(result.summary.failing_models, 1);
  assert.equal(result.summary.unverified_models, 3);
  await f.service.getOverview(); assert.equal(f.checks(), 1);
});
test('a well-formed catalogue without the configured model remains a failure', async () => {
  const result = await fixture({ env: { GROQ_API_KEY: 'FICTITIOUS' }, audioReply: { data: [{ id: 'another-model' }] } }).service.getOverview();
  assert.equal(result.summary.status, 'error'); assert.equal(result.summary.failing_models, 1);
});
test('all configured models checked successfully produces healthy, no configuration does not', async () => {
  const result = await fixture({ env: { GROQ_API_KEY: 'FICTITIOUS' } }).service.getOverview();
  assert.equal(result.summary.status, 'healthy'); assert.equal(result.summary.unverified_models, 0);
  const empty = await fixture({ bedrock: false }).service.getOverview();
  assert.equal(empty.summary.status, 'unverified'); assert.equal(empty.summary.configured_models, 0);
});
