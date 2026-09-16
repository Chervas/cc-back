'use strict';

const db = require('../../models');

const PRICE_PER_MILLION_USD = Object.freeze({
  'eu.amazon.nova-micro-v1:0': { input: 0.039, output: 0.156 },
  'eu.amazon.nova-lite-v1:0': { input: 0.066, output: 0.264 },
  'eu.amazon.nova-pro-v1:0': { input: 0.88, output: 3.52 },
});

function clean(value, max = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function nonNegativeInteger(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function estimateCostUsd(model, inputTokens, outputTokens) {
  const price = PRICE_PER_MILLION_USD[clean(model)] || null;
  if (!price) return 0;
  return Number((((inputTokens * price.input) + (outputTokens * price.output)) / 1_000_000).toFixed(8));
}

function publicErrorCode(error) {
  return clean(
    error?.code
    || error?.name
    || error?.Code
    || error?.$metadata?.httpStatusCode
    || 'ai_request_failed',
    100,
  );
}

function positiveIntegerOrNull(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function normalizeTenantScope({ clinicId = null, groupId = null } = {}) {
  const normalizedClinicId = positiveIntegerOrNull(clinicId);
  const normalizedGroupId = positiveIntegerOrNull(groupId);
  return {
    clinicId: normalizedClinicId,
    groupId: normalizedGroupId,
    scopeKey: normalizedClinicId
      ? `clinic:${normalizedClinicId}`
      : (normalizedGroupId ? `group:${normalizedGroupId}` : 'global'),
  };
}

async function findOrCreateUsage(defaults) {
  const where = {
    usageDate: defaults.usageDate,
    provider: defaults.provider,
    model: defaults.model,
    useCase: defaults.useCase,
    scopeKey: defaults.scopeKey,
  };
  try {
    const [row] = await db.AiUsageDaily.findOrCreate({ where, defaults });
    return row;
  } catch (error) {
    if (error?.name === 'SequelizeUniqueConstraintError') {
      return db.AiUsageDaily.findOne({ where });
    }
    throw error;
  }
}

async function recordAiUsage({
  provider,
  model,
  useCase,
  status = 'success',
  inputTokens = 0,
  outputTokens = 0,
  cachedInputTokens = 0,
  audioSeconds = 0,
  searchRequests = 0,
  usageKnown = true,
  latencyMs = 0,
  fallbackUsed = false,
  error = null,
  metadata = null,
  clinicId = null,
  groupId = null,
} = {}) {
  if (!db.AiUsageDaily) return null;
  const normalizedProvider = clean(provider, 32).toLowerCase();
  const normalizedModel = clean(model);
  const normalizedUseCase = clean(useCase, 80).toLowerCase();
  if (!normalizedProvider || !normalizedModel || !normalizedUseCase) return null;

  const safeInputTokens = nonNegativeInteger(inputTokens);
  const safeOutputTokens = nonNegativeInteger(outputTokens);
  const safeLatency = nonNegativeInteger(latencyMs);
  const succeeded = status === 'success';
  const now = new Date();
  const tenant = normalizeTenantScope({ clinicId, groupId });

  try {
    const pricing = require('./aiPricing.service');
    const price = await pricing.effective(normalizedProvider, normalizedModel);
    const measured = { inputTokens: safeInputTokens, outputTokens: safeOutputTokens,
      cachedInputTokens: Math.min(safeInputTokens, nonNegativeInteger(cachedInputTokens)),
      audioSeconds: Math.max(0, Number(audioSeconds) || 0), searchRequests: nonNegativeInteger(searchRequests), usageKnown };
    const estimate = pricing.estimate(price, measured);
    const row = await findOrCreateUsage({
      usageDate: now.toISOString().slice(0, 10),
      provider: normalizedProvider,
      model: normalizedModel,
      useCase: normalizedUseCase,
      scopeKey: tenant.scopeKey,
      clinicId: tenant.clinicId,
      groupId: tenant.groupId,
      requestCount: 0,
      successCount: 0,
      errorCount: 0,
      fallbackCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      latencyMsTotal: 0,
      estimatedCostUsd: 0,
    });
    if (!row) return null;
    await row.increment({
      requestCount: 1,
      successCount: succeeded ? 1 : 0,
      errorCount: succeeded ? 0 : 1,
      fallbackCount: fallbackUsed ? 1 : 0,
      inputTokens: safeInputTokens,
      outputTokens: safeOutputTokens,
      latencyMsTotal: safeLatency,
      estimatedCostUsd: estimate.cost,
      cachedInputTokens: measured.cachedInputTokens,
      audioSeconds: measured.audioSeconds,
      searchRequests: measured.searchRequests,
      unpricedRequests: estimate.complete ? 0 : 1,
    });
    await row.update({
      lastStatus: succeeded ? 'success' : 'error',
      lastErrorCode: succeeded ? null : publicErrorCode(error),
      lastUsedAt: now,
      metadata: { ...(metadata && typeof metadata === 'object' ? metadata : {}), price: estimate.snapshot,
        price_complete: estimate.complete },
    });
    return row;
  } catch (telemetryError) {
    console.warn('[ai-telemetry] No se pudo registrar el agregado de uso', {
      provider: normalizedProvider,
      model: normalizedModel,
      use_case: normalizedUseCase,
      error: telemetryError?.message || telemetryError,
    });
    return null;
  }
}

// Count the provider response once, before parsing business output. Only usage
// metrics enter telemetry; never prompts, audio, identifiers or response text.
async function recordProviderResponse({provider,model,useCase,response,clinicId=null,groupId=null,audioSeconds=null,searchRequests=0,status='success',error=null}) {
  const raw=response?.usage || response?.usageMetadata || {};
  const input=raw.input_tokens ?? raw.prompt_tokens ?? raw.total_input_tokens ?? raw.promptTokenCount;
  const outputBase=raw.output_tokens ?? raw.completion_tokens ?? raw.total_output_tokens ?? raw.candidatesTokenCount;
  const output=outputBase==null?undefined:Number(outputBase)+(provider==='gemini'?Number(raw.total_thought_tokens??raw.thoughtsTokenCount??0):0);
  const cached=raw.input_tokens_details?.cached_tokens ?? raw.prompt_tokens_details?.cached_tokens ?? raw.total_cached_tokens ?? raw.cachedContentTokenCount ?? 0;
  return recordAiUsage({provider,model:response?.model||model,useCase,inputTokens:input,outputTokens:output,
    cachedInputTokens:cached,audioSeconds:audioSeconds??response?.duration??0,searchRequests,clinicId,groupId,status,error,
    usageKnown:provider==='groq'?Number.isFinite(Number(audioSeconds??response?.duration)):input!=null&&output!=null});
}

async function recordProviderFailure({error,...context}) {
  return recordProviderResponse({...context,response:{usage:error?.response?.data?.usage},status:'error',error:{code:publicErrorCode(error)}});
}

module.exports = {
  PRICE_PER_MILLION_USD,
  estimateCostUsd,
  recordAiUsage,
  recordProviderResponse,
  recordProviderFailure,
  __testing: { publicErrorCode, nonNegativeInteger, normalizeTenantScope },
};
