'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const bedrock = require('../../services/bedrockAiProvider.service');
const orchestrator = require('../../services/aiOrchestrator.service');
const telemetry = require('../../services/aiUsageTelemetry.service');
const classifier = require('../../services/reviewResponseClassification.service');
const migration = require('../../../migrations/20260820010000-create-ai-usage-daily');

const ENV_KEYS = [
  'BEDROCK_ENABLED',
  'BEDROCK_REGION',
  'BEDROCK_AWS_ACCESS_KEY_ID',
  'BEDROCK_AWS_SECRET_ACCESS_KEY',
  'BEDROCK_MODEL_FAST',
  'BEDROCK_MODEL_COMPLEX',
  'BEDROCK_MODEL_ASSISTANT',
  'BEDROCK_MODEL_FALLBACK',
];

function response(input, modelRequestId = 'request-test') {
  return {
    output: { message: { content: [{ toolUse: { name: 'submit_analysis', input } }] } },
    usage: { inputTokens: 20, outputTokens: 8, totalTokens: 28 },
    metrics: { latencyMs: 42 },
    stopReason: 'tool_use',
    $metadata: { requestId: modelRequestId, httpStatusCode: 200 },
  };
}

async function withRuntime(mockClient, callback) {
  const previous = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const originalTelemetry = telemetry.recordAiUsage;
  const usage = [];
  process.env.BEDROCK_ENABLED = 'true';
  process.env.BEDROCK_REGION = 'eu-south-2';
  process.env.BEDROCK_AWS_ACCESS_KEY_ID = 'AKIATEST';
  process.env.BEDROCK_AWS_SECRET_ACCESS_KEY = 'secret-test';
  process.env.BEDROCK_MODEL_FAST = 'eu.amazon.nova-micro-v1:0';
  process.env.BEDROCK_MODEL_COMPLEX = 'eu.amazon.nova-lite-v1:0';
  process.env.BEDROCK_MODEL_ASSISTANT = 'eu.amazon.nova-pro-v1:0';
  process.env.BEDROCK_MODEL_FALLBACK = 'eu.amazon.nova-lite-v1:0';
  telemetry.recordAiUsage = async (event) => { usage.push(event); return null; };
  bedrock.__testing.setClientForTests(mockClient);
  try {
    await callback(usage);
  } finally {
    bedrock.__testing.setClientForTests(null);
    telemetry.recordAiUsage = originalTelemetry;
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('Bedrock fuerza una salida estructurada con el contrato del nodo V2', async () => {
  let commandInput = null;
  await withRuntime({
    send: async (command) => {
      commandInput = command.input;
      return response({ decision: 'confirmado', confidence: 0.96, reason: 'Respuesta afirmativa' });
    },
  }, async (usage) => {
    const result = await orchestrator.analyzeStructured({
      useCase: 'automation_v2_analysis',
      analysisMode: 'quick_qa',
      systemPrompt: 'Clasifica.',
      prompt: 'Confirma la cita.',
      inputText: 'Sí, allí estaré.',
      outputFormat: { decision: 'string', confidence: 'number', reason: 'string' },
    });
    assert.equal(result.decision, 'confirmado');
    assert.equal(result._ai_provider, 'bedrock');
    assert.equal(result._ai_model, 'eu.amazon.nova-micro-v1:0');
    assert.equal(result._ai_fallback_used, false);
    assert.equal(commandInput.toolConfig.toolChoice.tool.name, 'submit_analysis');
    assert.deepEqual(
      commandInput.toolConfig.tools[0].toolSpec.inputSchema.json.required,
      ['decision', 'confidence', 'reason'],
    );
    assert.equal(usage.length, 1);
    assert.equal(usage[0].inputTokens, 20);
    assert.equal(Object.prototype.hasOwnProperty.call(usage[0], 'inputText'), false);
  });
});

test('usa Nova Lite solo ante un fallo transitorio del principal', async () => {
  const models = [];
  await withRuntime({
    send: async (command) => {
      models.push(command.input.modelId);
      if (models.length === 1) {
        const error = new Error('temporary outage');
        error.name = 'ServiceUnavailableException';
        error.$metadata = { httpStatusCode: 503 };
        throw error;
      }
      return response({ intent: 'ambiguous', rating: 0, confidence: 0.8, reason: '' });
    },
  }, async (usage) => {
    const result = await orchestrator.analyzeStructured({
      useCase: 'review_response_classification',
      analysisMode: 'quick_qa',
      systemPrompt: 'Clasifica.',
      prompt: 'Clasifica.',
      inputText: 'Luego os digo.',
      outputFormat: { intent: 'string', rating: 'number', confidence: 'number', reason: 'string' },
    });
    assert.deepEqual(models, ['eu.amazon.nova-micro-v1:0', 'eu.amazon.nova-lite-v1:0']);
    assert.equal(result._ai_fallback_used, true);
    assert.equal(result._ai_model, 'eu.amazon.nova-lite-v1:0');
    assert.equal(usage.length, 2);
    assert.equal(usage[0].status, 'error');
    assert.equal(usage[1].fallbackUsed, true);
  });
});

test('no intenta otro modelo ante un error de permisos', async () => {
  let calls = 0;
  await withRuntime({
    send: async () => {
      calls += 1;
      const error = new Error('denied');
      error.name = 'AccessDeniedException';
      error.$metadata = { httpStatusCode: 403 };
      throw error;
    },
  }, async () => {
    await assert.rejects(
      orchestrator.analyzeStructured({
        useCase: 'automation_v2_analysis',
        analysisMode: 'quick_qa',
        systemPrompt: 'Clasifica.',
        prompt: 'Clasifica.',
        inputText: 'Sí.',
        outputFormat: { decision: 'string' },
      }),
      /denied/,
    );
    assert.equal(calls, 1);
  });
});

test('las reglas claras no invocan Bedrock', async () => {
  let calls = 0;
  await withRuntime({ send: async () => { calls += 1; return response({}); } }, async () => {
    const result = await classifier.classifyReviewResponse({ text: 'Os doy un 5 😊', allowAi: true });
    assert.equal(result.intent, 'rating');
    assert.equal(result.source, 'rule');
    assert.equal(calls, 0);
  });
});

test('la migración de telemetría no almacena prompts ni respuestas', () => {
  const source = migration.up.toString();
  assert.match(source, /input_tokens/);
  assert.match(source, /estimated_cost_usd/);
  assert.doesNotMatch(source, /prompt|response_text|patient|phone/i);
});

test('calcula el coste con la tarifa configurada para Nova Micro', () => {
  assert.equal(
    telemetry.estimateCostUsd('eu.amazon.nova-micro-v1:0', 1_000_000, 1_000_000),
    0.195,
  );
});

test('Automation V2 usa el orquestador común y no contiene cliente Groq de texto', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../services/flowEngineV2.service.js'), 'utf8');
  assert.match(source, /aiOrchestrator\.analyzeStructured\(/);
  assert.match(source, /aiOrchestrator\.buildSimulatedOutput\(/);
  assert.doesNotMatch(source, /runGroqAiAnalysis|chat\/completions|pickGroqModel/);
});
