'use strict';

const {
  BedrockRuntimeClient,
  ConverseCommand,
} = require('@aws-sdk/client-bedrock-runtime');

const DEFAULT_REGION = 'eu-south-2';
const DEFAULT_TIMEOUT_MS = 20_000;
const RETRYABLE_ERROR_NAMES = new Set([
  'InternalServerException',
  'ModelErrorException',
  'ModelNotReadyException',
  'ModelTimeoutException',
  'ServiceQuotaExceededException',
  'ServiceUnavailableException',
  'ThrottlingException',
]);

let cachedClient = null;
let cachedClientKey = '';
let injectedClient = null;

function clean(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function enabled() {
  return ['1', 'true', 'yes', 'on'].includes(clean(process.env.BEDROCK_ENABLED, 10).toLowerCase());
}

function getConfig() {
  return {
    enabled: enabled(),
    region: clean(process.env.BEDROCK_REGION, 80) || DEFAULT_REGION,
    accessKeyId: clean(process.env.BEDROCK_AWS_ACCESS_KEY_ID, 200),
    secretAccessKey: clean(process.env.BEDROCK_AWS_SECRET_ACCESS_KEY, 300),
    sessionToken: clean(process.env.BEDROCK_AWS_SESSION_TOKEN, 1000),
    timeoutMs: Math.max(1_000, Number.parseInt(String(process.env.BEDROCK_TIMEOUT_MS || DEFAULT_TIMEOUT_MS), 10) || DEFAULT_TIMEOUT_MS),
  };
}

function assertConfigured() {
  const config = getConfig();
  if (!config.enabled) {
    const error = new Error('bedrock_disabled');
    error.code = 'bedrock_disabled';
    throw error;
  }
  if (!config.accessKeyId || !config.secretAccessKey) {
    const error = new Error('bedrock_credentials_missing');
    error.code = 'bedrock_credentials_missing';
    throw error;
  }
  return config;
}

function getClient() {
  if (injectedClient) return injectedClient;
  const config = assertConfigured();
  const key = `${config.region}:${config.accessKeyId}:${config.sessionToken ? 'session' : 'static'}`;
  if (cachedClient && cachedClientKey === key) return cachedClient;
  cachedClient = new BedrockRuntimeClient({
    region: config.region,
    maxAttempts: 2,
    credentials: {
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
    },
  });
  cachedClientKey = key;
  return cachedClient;
}

function outputSchema(outputFormat = {}) {
  const properties = {};
  const required = [];
  for (const [name, rawType] of Object.entries(outputFormat || {})) {
    const type = ['string', 'number', 'boolean'].includes(rawType) ? rawType : 'string';
    properties[name] = { type };
    required.push(name);
  }
  return {
    type: 'object',
    properties,
    required,
    additionalProperties: false,
  };
}

function extractToolInput(response, toolName) {
  const content = response?.output?.message?.content;
  if (!Array.isArray(content)) return null;
  const toolUse = content.find((item) => item?.toolUse?.name === toolName)?.toolUse;
  const input = toolUse?.input;
  return input && typeof input === 'object' && !Array.isArray(input) ? input : null;
}

function providerErrorCode(error) {
  return clean(error?.code || error?.name || error?.$metadata?.httpStatusCode || 'bedrock_request_failed', 100);
}

function isRetryableError(error) {
  if (error?.code === 'bedrock_invalid_structured_response') return true;
  if (RETRYABLE_ERROR_NAMES.has(error?.name) || RETRYABLE_ERROR_NAMES.has(error?.code)) return true;
  const status = Number(error?.$metadata?.httpStatusCode || error?.statusCode || 0);
  return status === 408 || status === 429 || status >= 500;
}

async function sendWithTimeout(client, command, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    return await client.send(command, { abortSignal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function analyzeStructured({
  model,
  systemPrompt,
  prompt,
  inputText,
  outputFormat,
  maxTokens = 700,
  temperature = 0,
} = {}) {
  const modelId = clean(model, 160);
  if (!modelId) {
    const error = new Error('bedrock_model_required');
    error.code = 'bedrock_model_required';
    throw error;
  }
  const config = assertConfigured();
  const client = getClient();
  const toolName = 'submit_analysis';
  const command = new ConverseCommand({
    modelId,
    system: [{ text: String(systemPrompt || '') }],
    messages: [{
      role: 'user',
      content: [{ text: `Instrucción:\n${String(prompt || '')}\n\nTexto a analizar:\n${String(inputText || '')}` }],
    }],
    inferenceConfig: {
      maxTokens: Math.max(32, Math.min(4096, Number(maxTokens) || 700)),
      temperature: Math.max(0, Math.min(1, Number(temperature) || 0)),
    },
    toolConfig: {
      tools: [{
        toolSpec: {
          name: toolName,
          description: 'Devuelve el resultado estructurado del análisis solicitado.',
          inputSchema: { json: outputSchema(outputFormat) },
        },
      }],
      toolChoice: { tool: { name: toolName } },
    },
  });

  const startedAt = Date.now();
  const response = await sendWithTimeout(client, command, config.timeoutMs);
  const value = extractToolInput(response, toolName);
  if (!value) {
    const error = new Error('bedrock_invalid_structured_response');
    error.code = 'bedrock_invalid_structured_response';
    error.model = modelId;
    throw error;
  }
  return {
    value,
    model: modelId,
    usage: {
      input_tokens: Number(response?.usage?.inputTokens || 0),
      output_tokens: Number(response?.usage?.outputTokens || 0),
      total_tokens: Number(response?.usage?.totalTokens || 0),
    },
    latency_ms: Number(response?.metrics?.latencyMs || (Date.now() - startedAt)),
    stop_reason: clean(response?.stopReason, 80) || null,
    request_id: clean(response?.$metadata?.requestId, 120) || null,
  };
}

async function checkModel(model) {
  const modelId = clean(model, 160);
  const checkedAt = new Date().toISOString();
  if (!modelId) return { ok: false, model: null, checked_at: checkedAt, detail: 'No hay modelo configurado.' };
  try {
    const startedAt = Date.now();
    const response = await analyzeStructured({
      model: modelId,
      systemPrompt: 'Responde mediante la herramienta y cumple exactamente el esquema.',
      prompt: 'Confirma que el modelo está operativo.',
      inputText: 'health_check',
      outputFormat: { ok: 'boolean' },
      maxTokens: 24,
    });
    const ok = response?.value?.ok === true;
    return {
      ok,
      model: modelId,
      checked_at: checkedAt,
      latency_ms: Number(response?.latency_ms || (Date.now() - startedAt)),
      detail: ok ? 'Responde con salida estructurada correcta.' : 'Respondió, pero no cumplió el contrato estructurado.',
    };
  } catch (error) {
    return {
      ok: false,
      model: modelId,
      checked_at: checkedAt,
      error_code: providerErrorCode(error),
      detail: `No operativo (${providerErrorCode(error)}).`,
    };
  }
}

function setClientForTests(client) {
  injectedClient = client || null;
}

module.exports = {
  analyzeStructured,
  checkModel,
  enabled,
  getConfig,
  isRetryableError,
  providerErrorCode,
  __testing: {
    outputSchema,
    extractToolInput,
    setClientForTests,
  },
};
