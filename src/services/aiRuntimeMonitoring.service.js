'use strict';

const axios = require('axios');
const { Op } = require('sequelize');
const db = require('../../models');
const bedrock = require('./bedrockAiProvider.service');
const aiOrchestrator = require('./aiOrchestrator.service');

const CACHE_TTL_MS = Math.max(
  60_000,
  Number.parseInt(String(process.env.AI_HEALTH_CACHE_TTL_MS || (4 * 60 * 60 * 1000)), 10) || (4 * 60 * 60 * 1000),
);
const healthCache = { expiresAt: 0, value: null, promise: null };

function clean(value, max = 200) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function configuredInventory() {
  const configured = aiOrchestrator.models();
  return [
    {
      key: 'bedrock_fast',
      provider: 'bedrock',
      model: configured.fast,
      purpose: 'Clasificación rápida de respuestas y nodos IA breves',
      data_scope: 'Datos de pacientes dentro de la UE',
      role: 'Principal rápido',
      configured: bedrock.enabled(),
    },
    {
      key: 'bedrock_complex',
      provider: 'bedrock',
      model: configured.complex,
      purpose: 'Análisis estructurado complejo de Automatizaciones V2',
      data_scope: 'Datos de pacientes dentro de la UE',
      role: 'Principal complejo',
      configured: bedrock.enabled(),
    },
    {
      key: 'bedrock_assistant',
      provider: 'bedrock',
      model: configured.assistant,
      purpose: 'Asistente clínico futuro con herramientas autorizadas',
      data_scope: 'Preparado; no hay asistente clínico activo',
      role: 'Reservado',
      configured: bedrock.enabled(),
    },
    {
      key: 'bedrock_fallback',
      provider: 'bedrock',
      model: configured.fallback,
      purpose: 'Continuidad ante fallos transitorios del modelo principal',
      data_scope: 'Datos de pacientes dentro de la UE',
      role: 'Fallback controlado',
      configured: bedrock.enabled(),
    },
    {
      key: 'groq_audio',
      provider: 'groq',
      model: clean(process.env.GROQ_STT_MODEL) || 'whisper-large-v3-turbo',
      purpose: 'Transcripción de audios de WhatsApp',
      data_scope: 'Audio de pacientes; pendiente de migración a proveedor UE',
      role: 'Transcripción',
      configured: !!clean(process.env.GROQ_API_KEY),
    },
    {
      key: 'openai_accounting',
      provider: 'openai',
      model: clean(process.env.ACCOUNTING_OCR_MODEL) || 'gpt-5.4-nano',
      purpose: 'Extracción de facturas y nóminas',
      data_scope: 'Documentos contables; fuera del runtime conversacional',
      role: 'OCR contable',
      configured: !!clean(process.env.OPENAI_API_KEY),
    },
    {
      key: 'openai_web',
      provider: 'openai',
      model: clean(process.env.OPENAI_WEB_CONTENT_MODEL) || 'gpt-5.6',
      purpose: 'Generación de contenido web',
      data_scope: 'Contenido de marketing sin historia clínica',
      role: 'Contenido web',
      configured: !!clean(process.env.OPENAI_API_KEY),
    },
    {
      key: 'openai_visibility',
      provider: 'openai',
      model: clean(process.env.OPENAI_AI_VISIBILITY_MODEL) || 'gpt-5.6',
      purpose: 'Informes de visibilidad en asistentes',
      data_scope: 'Búsquedas de marketing sin historia clínica',
      role: 'Visibilidad IA',
      configured: !!clean(process.env.OPENAI_API_KEY),
    },
    {
      key: 'gemini_visibility',
      provider: 'gemini',
      model: clean(process.env.GEMINI_AI_VISIBILITY_MODEL) || 'gemini-3.5-flash',
      purpose: 'Informes de visibilidad en asistentes',
      data_scope: 'Búsquedas de marketing sin historia clínica',
      role: 'Visibilidad IA',
      configured: !!clean(process.env.GEMINI_API_KEY),
    },
  ];
}

async function checkGroqAudio() {
  const checkedAt = new Date().toISOString();
  const apiKey = clean(process.env.GROQ_API_KEY, 300);
  const model = clean(process.env.GROQ_STT_MODEL) || 'whisper-large-v3-turbo';
  if (!apiKey) return { ok: false, model, checked_at: checkedAt, detail: 'GROQ_API_KEY no configurada.' };
  try {
    const baseUrl = (clean(process.env.GROQ_API_BASE_URL) || 'https://api.groq.com/openai/v1').replace(/\/+$/, '');
    const response = await axios.get(`${baseUrl}/models`, {
      timeout: 5_000,
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    const available = Array.isArray(response?.data?.data)
      ? response.data.data.some((item) => clean(item?.id) === model)
      : true;
    return {
      ok: available,
      model,
      checked_at: checkedAt,
      detail: available ? 'Clave válida y modelo de audio disponible.' : 'La clave valida, pero el modelo de audio no aparece disponible.',
    };
  } catch (error) {
    return {
      ok: false,
      model,
      checked_at: checkedAt,
      error_code: clean(error?.response?.status || error?.code || error?.name, 100),
      detail: 'No se pudo validar el proveedor de transcripción.',
    };
  }
}

async function loadHealth({ force = false } = {}) {
  const now = Date.now();
  if (!force && healthCache.value && healthCache.expiresAt > now) return healthCache.value;
  if (!force && healthCache.promise) return healthCache.promise;

  healthCache.promise = (async () => {
    const inventory = configuredInventory();
    const bedrockModels = [...new Set(inventory
      .filter((item) => item.provider === 'bedrock' && item.configured)
      .map((item) => item.model))];
    const bedrockChecks = await Promise.all(bedrockModels.map((model) => bedrock.checkModel(model)));
    const byModel = new Map(bedrockChecks.map((check) => [check.model, check]));
    const groqAudio = await checkGroqAudio();
    return {
      checked_at: new Date().toISOString(),
      models: inventory.map((item) => {
        if (item.provider === 'bedrock') {
          const check = item.configured
            ? byModel.get(item.model)
            : { ok: false, detail: 'Bedrock está desactivado en este runtime.', checked_at: new Date().toISOString() };
          return { ...item, health: check };
        }
        if (item.key === 'groq_audio') return { ...item, health: groqAudio };
        return {
          ...item,
          health: {
            ok: item.configured,
            checked_at: new Date().toISOString(),
            detail: item.configured
              ? 'Configurado; su módulo registra el resultado de cada ejecución.'
              : 'No configurado en este runtime.',
          },
        };
      }),
    };
  })();

  try {
    const value = await healthCache.promise;
    healthCache.value = value;
    healthCache.expiresAt = Date.now() + CACHE_TTL_MS;
    return value;
  } finally {
    healthCache.promise = null;
  }
}

async function loadUsage(days = 30) {
  if (!db.AiUsageDaily) return [];
  const from = new Date();
  from.setUTCDate(from.getUTCDate() - Math.max(0, days - 1));
  try {
    const rows = await db.AiUsageDaily.findAll({
      where: { usageDate: { [Op.gte]: from.toISOString().slice(0, 10) } },
      order: [['usage_date', 'DESC'], ['provider', 'ASC'], ['model', 'ASC']],
      raw: true,
    });
    return rows.map((row) => ({
      date: row.usageDate || row.usage_date,
      provider: row.provider,
      model: row.model,
      use_case: row.useCase || row.use_case,
      requests: Number(row.requestCount ?? row.request_count ?? 0),
      successes: Number(row.successCount ?? row.success_count ?? 0),
      errors: Number(row.errorCount ?? row.error_count ?? 0),
      fallbacks: Number(row.fallbackCount ?? row.fallback_count ?? 0),
      input_tokens: Number(row.inputTokens ?? row.input_tokens ?? 0),
      output_tokens: Number(row.outputTokens ?? row.output_tokens ?? 0),
      latency_ms_total: Number(row.latencyMsTotal ?? row.latency_ms_total ?? 0),
      estimated_cost_usd: Number(row.estimatedCostUsd ?? row.estimated_cost_usd ?? 0),
      last_status: row.lastStatus || row.last_status || null,
      last_error_code: row.lastErrorCode || row.last_error_code || null,
      last_used_at: row.lastUsedAt || row.last_used_at || null,
    }));
  } catch (error) {
    if (error?.original?.code === 'ER_NO_SUCH_TABLE') return [];
    throw error;
  }
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + Number(row?.[key] || 0), 0);
}

async function getOverview({ force = false } = {}) {
  const [health, usage] = await Promise.all([loadHealth({ force }), loadUsage(30)]);
  const today = new Date().toISOString().slice(0, 10);
  const todayUsage = usage.filter((row) => row.date === today);
  const failing = health.models.filter((item) => item.configured && item.health?.ok === false);
  return {
    success: true,
    checked_at: health.checked_at,
    cache_ttl_ms: CACHE_TTL_MS,
    region: bedrock.getConfig().region,
    processing_scope: 'Unión Europea mediante perfiles geográficos EU de Amazon Bedrock',
    content_logging_enabled: false,
    summary: {
      status: failing.length ? 'error' : 'healthy',
      configured_models: health.models.filter((item) => item.configured).length,
      failing_models: failing.length,
      requests_today: sum(todayUsage, 'requests'),
      requests_30d: sum(usage, 'requests'),
      input_tokens_30d: sum(usage, 'input_tokens'),
      output_tokens_30d: sum(usage, 'output_tokens'),
      estimated_cost_usd_today: Number(sum(todayUsage, 'estimated_cost_usd').toFixed(6)),
      estimated_cost_usd_30d: Number(sum(usage, 'estimated_cost_usd').toFixed(6)),
    },
    models: health.models,
    usage,
  };
}

module.exports = {
  getOverview,
  loadHealth,
  __testing: { configuredInventory, loadUsage },
};
