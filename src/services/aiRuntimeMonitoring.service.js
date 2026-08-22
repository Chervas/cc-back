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
      purpose: 'Medición de presencia de la clínica en respuestas de asistentes (marketing)',
      data_scope: 'Búsquedas de marketing sin historia clínica',
      role: 'Visibilidad en asistentes',
      configured: !!clean(process.env.OPENAI_API_KEY),
    },
    {
      key: 'gemini_visibility',
      provider: 'gemini',
      model: clean(process.env.GEMINI_AI_VISIBILITY_MODEL) || 'gemini-3.5-flash',
      purpose: 'Medición de presencia de la clínica en respuestas de asistentes (marketing)',
      data_scope: 'Búsquedas de marketing sin historia clínica',
      role: 'Visibilidad en asistentes',
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

function normalizeUsageRow(row) {
  return {
    date: row.usageDate || row.usage_date,
    provider: row.provider,
    model: row.model,
    use_case: row.useCase || row.use_case,
    scope_key: row.scopeKey || row.scope_key || 'global',
    clinic_id: Number(row.clinicId ?? row.clinic_id ?? 0) || null,
    group_id: Number(row.groupId ?? row.group_id ?? 0) || null,
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
  };
}

async function loadUsageRange(fromDate, toDate) {
  if (!db.AiUsageDaily) return [];
  try {
    const rows = await db.AiUsageDaily.findAll({
      where: { usageDate: { [Op.between]: [fromDate, toDate] } },
      order: [['usage_date', 'DESC'], ['provider', 'ASC'], ['model', 'ASC']],
      raw: true,
    });
    return rows.map(normalizeUsageRow);
  } catch (error) {
    if (error?.original?.code === 'ER_NO_SUCH_TABLE') return [];
    throw error;
  }
}

async function loadUsage(days = 30) {
  const to = new Date().toISOString().slice(0, 10);
  const from = addUtcDays(to, -Math.max(0, days - 1));
  return loadUsageRange(from, to);
}

function sum(rows, key) {
  return rows.reduce((total, row) => total + Number(row?.[key] || 0), 0);
}

function parseDateKey(value, fallback) {
  const raw = clean(value, 20);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return fallback;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) ? fallback : raw;
}

function addUtcDays(dateKey, days) {
  const date = new Date(`${dateKey}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function daysInclusive(from, to) {
  return Math.floor((new Date(`${to}T00:00:00.000Z`) - new Date(`${from}T00:00:00.000Z`)) / 86_400_000) + 1;
}

function aggregateUsage(rows) {
  const requests = sum(rows, 'requests');
  return {
    requests,
    successes: sum(rows, 'successes'),
    errors: sum(rows, 'errors'),
    fallbacks: sum(rows, 'fallbacks'),
    input_tokens: sum(rows, 'input_tokens'),
    output_tokens: sum(rows, 'output_tokens'),
    latency_ms_total: sum(rows, 'latency_ms_total'),
    average_latency_ms: requests ? Math.round(sum(rows, 'latency_ms_total') / requests) : 0,
    estimated_cost_usd: Number(sum(rows, 'estimated_cost_usd').toFixed(6)),
  };
}

function groupUsage(rows, keyBuilder) {
  const grouped = new Map();
  rows.forEach((row) => {
    const descriptor = keyBuilder(row);
    const key = descriptor.key;
    if (!grouped.has(key)) grouped.set(key, { ...descriptor, rows: [] });
    grouped.get(key).rows.push(row);
  });
  return [...grouped.values()].map(({ rows: groupedRows, ...descriptor }) => ({
    ...descriptor,
    ...aggregateUsage(groupedRows),
  }));
}

function percentageChange(current, previous) {
  const currentValue = Number(current || 0);
  const previousValue = Number(previous || 0);
  if (previousValue <= 0) return null;
  return Number((((currentValue - previousValue) / previousValue) * 100).toFixed(1));
}

function buildClientComparison(rows, previousRows, labels) {
  const attributedRows = rows.filter((row) => row.scope_key && row.scope_key !== 'global');
  const previousAttributedRows = previousRows.filter((row) => row.scope_key && row.scope_key !== 'global');
  const previousByScope = new Map(groupUsage(previousAttributedRows, (row) => ({
    key: row.scope_key,
  })).map((item) => [item.key, item]));
  const groupedClients = groupUsage(attributedRows, (row) => {
    const scopeKey = row.scope_key;
    let label = 'Cliente sin nombre';
    if (row.clinic_id) label = labels.clinics.get(row.clinic_id) || `Clínica ${row.clinic_id}`;
    else if (row.group_id) label = labels.groups.get(row.group_id) || `Grupo ${row.group_id}`;
    return {
      key: scopeKey,
      scope_key: scopeKey,
      clinic_id: row.clinic_id,
      group_id: row.group_id,
      label,
    };
  }).sort((a, b) => b.estimated_cost_usd - a.estimated_cost_usd || b.requests - a.requests);
  const attributedCost = sum(groupedClients, 'estimated_cost_usd');
  const clients = groupedClients.map((client, index) => {
    const previous = previousByScope.get(client.scope_key) || aggregateUsage([]);
    return {
      ...client,
      rank: index + 1,
      cost_share_pct: attributedCost > 0
        ? Number(((client.estimated_cost_usd / attributedCost) * 100).toFixed(1))
        : 0,
      cost_per_request_usd: client.requests > 0
        ? Number((client.estimated_cost_usd / client.requests).toFixed(6))
        : 0,
      previous_estimated_cost_usd: previous.estimated_cost_usd,
      previous_requests: previous.requests,
      cost_change_pct: percentageChange(client.estimated_cost_usd, previous.estimated_cost_usd),
      request_change_pct: percentageChange(client.requests, previous.requests),
    };
  });
  const topFiveCost = sum(clients.slice(0, 5), 'estimated_cost_usd');
  return {
    clients,
    summary: {
      active_clients: clients.length,
      attributed_cost_usd: Number(attributedCost.toFixed(6)),
      average_cost_per_client_usd: clients.length
        ? Number((attributedCost / clients.length).toFixed(6))
        : 0,
      top_client: clients[0] || null,
      top_five_cost_share_pct: attributedCost > 0
        ? Number(((topFiveCost / attributedCost) * 100).toFixed(1))
        : 0,
    },
  };
}

async function resolveScopeLabels(rows) {
  const clinicIds = [...new Set(rows.map((row) => row.clinic_id).filter(Boolean))];
  const groupIds = [...new Set(rows.map((row) => row.group_id).filter(Boolean))];
  const [clinics, groups] = await Promise.all([
    clinicIds.length && db.Clinica
      ? db.Clinica.findAll({ where: { id_clinica: { [Op.in]: clinicIds } }, attributes: ['id_clinica', 'nombre_clinica'], raw: true })
      : [],
    groupIds.length && db.GrupoClinica
      ? db.GrupoClinica.findAll({ where: { id_grupo: { [Op.in]: groupIds } }, attributes: ['id_grupo', 'nombre_grupo'], raw: true })
      : [],
  ]);
  return {
    clinics: new Map(clinics.map((clinic) => [Number(clinic.id_clinica), clinic.nombre_clinica])),
    groups: new Map(groups.map((group) => [Number(group.id_grupo), group.nombre_grupo])),
  };
}

async function getCostBreakdown({ from: rawFrom, to: rawTo } = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const to = parseDateKey(rawTo, today);
  const from = parseDateKey(rawFrom, addUtcDays(to, -29));
  const rangeDays = daysInclusive(from, to);
  if (rangeDays < 1 || rangeDays > 731) {
    const error = new Error('ai_cost_range_invalid');
    error.status = 400;
    throw error;
  }
  const previousTo = addUtcDays(from, -1);
  const previousFrom = addUtcDays(previousTo, -(rangeDays - 1));
  const [rows, previousRows] = await Promise.all([
    loadUsageRange(from, to),
    loadUsageRange(previousFrom, previousTo),
  ]);
  const labels = await resolveScopeLabels(rows);
  const current = aggregateUsage(rows);
  const previous = aggregateUsage(previousRows);
  const costChangePct = previous.estimated_cost_usd > 0
    ? Number((((current.estimated_cost_usd - previous.estimated_cost_usd) / previous.estimated_cost_usd) * 100).toFixed(1))
    : null;
  const requestChangePct = previous.requests > 0
    ? Number((((current.requests - previous.requests) / previous.requests) * 100).toFixed(1))
    : null;

  const byDate = new Map(groupUsage(rows, (row) => ({ key: row.date, date: row.date })).map((item) => [item.date, item]));
  const timeseries = [];
  for (let date = from; date <= to; date = addUtcDays(date, 1)) {
    timeseries.push(byDate.get(date) || { date, ...aggregateUsage([]) });
  }
  const models = groupUsage(rows, (row) => ({
    key: `${row.provider}:${row.model}`,
    provider: row.provider,
    model: row.model,
  })).sort((a, b) => b.estimated_cost_usd - a.estimated_cost_usd || b.requests - a.requests);
  const useCases = groupUsage(rows, (row) => ({ key: row.use_case, use_case: row.use_case }))
    .sort((a, b) => b.estimated_cost_usd - a.estimated_cost_usd || b.requests - a.requests);
  const clientComparison = buildClientComparison(rows, previousRows, labels);
  const attributedRequests = sum(rows.filter((row) => row.scope_key !== 'global'), 'requests');

  return {
    success: true,
    generated_at: new Date().toISOString(),
    currency: 'USD',
    scope: 'global_admin',
    period: { from, to, days: rangeDays, previous_from: previousFrom, previous_to: previousTo },
    summary: {
      ...current,
      previous_cost_usd: previous.estimated_cost_usd,
      previous_requests: previous.requests,
      cost_change_pct: costChangePct,
      request_change_pct: requestChangePct,
    },
    attribution: {
      attributed_requests: attributedRequests,
      unattributed_requests: Math.max(0, current.requests - attributedRequests),
    },
    timeseries,
    models,
    use_cases: useCases,
    clients: clientComparison.clients,
    client_comparison: clientComparison.summary,
  };
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
  getCostBreakdown,
  loadHealth,
  __testing: {
    configuredInventory,
    loadUsage,
    parseDateKey,
    daysInclusive,
    aggregateUsage,
    groupUsage,
    percentageChange,
    buildClientComparison,
  },
};
