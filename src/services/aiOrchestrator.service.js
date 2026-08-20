'use strict';

const bedrock = require('./bedrockAiProvider.service');
const aiUsageTelemetry = require('./aiUsageTelemetry.service');

const DEFAULT_MODELS = Object.freeze({
  fast: 'eu.amazon.nova-micro-v1:0',
  complex: 'eu.amazon.nova-lite-v1:0',
  assistant: 'eu.amazon.nova-pro-v1:0',
  fallback: 'eu.amazon.nova-lite-v1:0',
});

function clean(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function models() {
  return {
    fast: clean(process.env.BEDROCK_MODEL_FAST, 160) || DEFAULT_MODELS.fast,
    complex: clean(process.env.BEDROCK_MODEL_COMPLEX, 160) || DEFAULT_MODELS.complex,
    assistant: clean(process.env.BEDROCK_MODEL_ASSISTANT, 160) || DEFAULT_MODELS.assistant,
    fallback: clean(process.env.BEDROCK_MODEL_FALLBACK, 160) || DEFAULT_MODELS.fallback,
  };
}

function normalizeMode(value) {
  const mode = clean(value, 40).toLowerCase();
  return ['quick_qa', 'complex_reasoning', 'assistant'].includes(mode) ? mode : 'auto';
}

function routeFor({ useCase, analysisMode, prompt, inputText, outputFormat } = {}) {
  const configured = models();
  const mode = normalizeMode(analysisMode);
  let tier = 'fast';
  if (mode === 'assistant') tier = 'assistant';
  else if (mode === 'complex_reasoning') tier = 'complex';
  else if (mode === 'auto') {
    const totalChars = String(prompt || '').length + String(inputText || '').length;
    const outputFields = Object.keys(outputFormat || {}).length;
    const complex = totalChars > 900 || outputFields > 3 || /historial|razonamiento|resume|extrae|diagnost/i.test(`${prompt || ''} ${inputText || ''}`);
    tier = complex ? 'complex' : 'fast';
  }
  const primary = configured[tier];
  const fallback = configured.fallback && configured.fallback !== primary ? configured.fallback : null;
  return {
    use_case: clean(useCase, 80).toLowerCase() || 'automation_v2_analysis',
    mode,
    tier,
    primary,
    fallback,
  };
}

function coerceByFormat(value, outputFormat = {}) {
  const output = {};
  for (const [key, type] of Object.entries(outputFormat || {})) {
    const raw = value?.[key];
    if (type === 'number') {
      const parsed = Number(raw);
      output[key] = Number.isFinite(parsed) ? parsed : 0;
    } else if (type === 'boolean') {
      output[key] = raw === true || String(raw).toLowerCase() === 'true';
    } else {
      output[key] = raw === undefined || raw === null ? '' : String(raw);
    }
  }
  return output;
}

async function runCandidate({ candidate, fallbackUsed, route, request }) {
  const startedAt = Date.now();
  try {
    const result = await bedrock.analyzeStructured({ ...request, model: candidate });
    await aiUsageTelemetry.recordAiUsage({
      provider: 'bedrock',
      model: result.model,
      useCase: route.use_case,
      status: 'success',
      inputTokens: result.usage?.input_tokens,
      outputTokens: result.usage?.output_tokens,
      latencyMs: result.latency_ms,
      fallbackUsed,
      metadata: { region: bedrock.getConfig().region, tier: route.tier },
    });
    return result;
  } catch (error) {
    await aiUsageTelemetry.recordAiUsage({
      provider: 'bedrock',
      model: candidate,
      useCase: route.use_case,
      status: 'error',
      latencyMs: Date.now() - startedAt,
      fallbackUsed,
      error,
      metadata: { region: bedrock.getConfig().region, tier: route.tier },
    });
    throw error;
  }
}

async function analyzeStructured({
  useCase,
  systemPrompt,
  prompt,
  inputText,
  outputFormat,
  analysisMode,
  maxTokens,
} = {}) {
  const route = routeFor({ useCase, analysisMode, prompt, inputText, outputFormat });
  const request = { systemPrompt, prompt, inputText, outputFormat, maxTokens, temperature: 0 };
  try {
    const result = await runCandidate({ candidate: route.primary, fallbackUsed: false, route, request });
    return {
      ...coerceByFormat(result.value, outputFormat),
      _ai_provider: 'bedrock',
      _ai_model: result.model,
      _ai_analysis_mode: route.mode,
      _ai_tier: route.tier,
      _ai_fallback_used: false,
      _ai_usage: result.usage,
      _ai_latency_ms: result.latency_ms,
    };
  } catch (primaryError) {
    if (!route.fallback || !bedrock.isRetryableError(primaryError)) throw primaryError;
    const result = await runCandidate({ candidate: route.fallback, fallbackUsed: true, route, request });
    return {
      ...coerceByFormat(result.value, outputFormat),
      _ai_provider: 'bedrock',
      _ai_model: result.model,
      _ai_analysis_mode: route.mode,
      _ai_tier: route.tier,
      _ai_fallback_used: true,
      _ai_primary_error: bedrock.providerErrorCode(primaryError),
      _ai_usage: result.usage,
      _ai_latency_ms: result.latency_ms,
    };
  }
}

function buildSimulatedOutput(outputFormat, analysisMode, useCase) {
  const base = coerceByFormat({}, outputFormat);
  if (Object.prototype.hasOwnProperty.call(outputFormat || {}, 'decision')) base.decision = 'simulado';
  const route = routeFor({ useCase, analysisMode, outputFormat });
  return {
    ...base,
    _ai_provider: 'bedrock',
    _ai_model: route.primary,
    _ai_analysis_mode: route.mode,
    _ai_tier: route.tier,
    _ai_simulated: true,
  };
}

module.exports = {
  analyzeStructured,
  buildSimulatedOutput,
  models,
  routeFor,
  __testing: { coerceByFormat, normalizeMode },
};
