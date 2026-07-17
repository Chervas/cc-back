'use strict';

const crypto = require('crypto');
const axios = require('axios');
const db = require('../../models');
const jobRequestsService = require('./jobRequests.service');

const {
  MarketingAiVisibilityRun,
  Clinica,
  ClinicBusinessLocation,
} = db;
const { Op } = db.Sequelize;

const JOB_TYPE = 'marketing_ai_visibility_run';
const QUERY_MIN_LENGTH = 8;
const QUERY_MAX_LENGTH = 500;
const RUN_RETENTION_DAYS = clampInt(process.env.AI_VISIBILITY_RETENTION_DAYS, 1, 180, 30);
const CACHE_HOURS = clampInt(process.env.AI_VISIBILITY_CACHE_HOURS, 1, 168, 24);
const MAX_RUNS_PER_CLINIC_24H = clampInt(process.env.AI_VISIBILITY_MAX_RUNS_PER_CLINIC_24H, 1, 30, 3);
const MAX_ATTEMPTS_PER_QUERY_24H = clampInt(process.env.AI_VISIBILITY_MAX_ATTEMPTS_PER_QUERY_24H, 1, 6, 2);
const ACTIVE_RUN_REUSE_MINUTES = clampInt(process.env.AI_VISIBILITY_ACTIVE_RUN_REUSE_MINUTES, 5, 180, 15);
const PARTIAL_RUN_RETRY_MINUTES = clampInt(process.env.AI_VISIBILITY_PARTIAL_RUN_RETRY_MINUTES, 5, 1440, 60);
const PROVIDER_TIMEOUT_MS = clampInt(process.env.AI_VISIBILITY_PROVIDER_TIMEOUT_MS, 10000, 180000, 90000);
const OPENAI_MODEL = cleanString(process.env.OPENAI_AI_VISIBILITY_MODEL) || 'gpt-5.6';
const GEMINI_MODEL = cleanString(process.env.GEMINI_AI_VISIBILITY_MODEL) || 'gemini-3.5-flash';

const TYPICAL_QUERY_DEFINITIONS = Object.freeze([
  Object.freeze({ key: 'best_local', label: 'Mejor clínica de la zona' }),
  Object.freeze({ key: 'recommended_local', label: 'Clínica recomendada' }),
  Object.freeze({ key: 'trusted_reviews', label: 'Clínica con buenas reseñas' }),
]);

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function cleanString(value, maxLength = null) {
  const normalized = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;
  return maxLength ? normalized.slice(0, maxLength) : normalized;
}

function normalizeQuery(value) {
  const query = cleanString(value, QUERY_MAX_LENGTH + 1);
  if (!query || query.length < QUERY_MIN_LENGTH) {
    const error = new Error('Escribe una búsqueda local de al menos 8 caracteres.');
    error.code = 'AI_VISIBILITY_QUERY_TOO_SHORT';
    error.status = 400;
    throw error;
  }
  if (query.length > QUERY_MAX_LENGTH) {
    const error = new Error(`La búsqueda no puede superar ${QUERY_MAX_LENGTH} caracteres.`);
    error.code = 'AI_VISIBILITY_QUERY_TOO_LONG';
    error.status = 400;
    throw error;
  }
  if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(query)) {
    const error = new Error('No incluyas correos de pacientes en una consulta pública de visibilidad.');
    error.code = 'AI_VISIBILITY_PERSONAL_DATA';
    error.status = 400;
    throw error;
  }
  if (/(?:\+?\d[\s().-]*){9,}/.test(query)) {
    const error = new Error('No incluyas teléfonos en una consulta pública de visibilidad.');
    error.code = 'AI_VISIBILITY_PERSONAL_DATA';
    error.status = 400;
    throw error;
  }
  return query;
}

function queryHash(query) {
  return crypto.createHash('sha256').update(query.toLocaleLowerCase('es-ES')).digest('hex');
}

function safeUrl(value) {
  try {
    const url = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    return url.toString();
  } catch (_) {
    return null;
  }
}

function uniqueStrings(values, limit = 20) {
  const seen = new Set();
  const result = [];
  for (const value of values || []) {
    const normalized = cleanString(value, 300);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeCitation(annotation, textLength, index) {
  if (!annotation || annotation.type !== 'url_citation') return null;
  const url = safeUrl(annotation.url || annotation.uri);
  if (!url) return null;
  const rawStart = Number(annotation.start_index ?? annotation.startIndex ?? 0);
  const rawEnd = Number(annotation.end_index ?? annotation.endIndex ?? rawStart);
  const startIndex = Math.max(0, Math.min(textLength, Number.isFinite(rawStart) ? rawStart : 0));
  const endIndex = Math.max(startIndex, Math.min(textLength, Number.isFinite(rawEnd) ? rawEnd : startIndex));
  return {
    id: index + 1,
    title: cleanString(annotation.title, 240) || new URL(url).hostname,
    url,
    start_index: startIndex,
    end_index: endIndex,
  };
}

function appendTextBlock(accumulator, block) {
  const text = String(block?.text || '');
  if (!text) return;
  const separator = accumulator.text ? '\n\n' : '';
  const offset = accumulator.text.length + separator.length;
  accumulator.text += separator + text;
  for (const annotation of block.annotations || []) {
    const citation = normalizeCitation(annotation, text.length, accumulator.citations.length);
    if (!citation) continue;
    accumulator.citations.push({
      ...citation,
      start_index: citation.start_index + offset,
      end_index: citation.end_index + offset,
    });
  }
}

function parseOpenAiResponse(payload = {}) {
  const parsed = { text: '', citations: [], queries: [], sources: [] };
  for (const item of Array.isArray(payload.output) ? payload.output : []) {
    if (item?.type === 'web_search_call') {
      const action = item.action || {};
      parsed.queries.push(...(Array.isArray(action.queries) ? action.queries : []));
      if (action.query) parsed.queries.push(action.query);
      for (const source of Array.isArray(action.sources) ? action.sources : []) {
        const url = safeUrl(source?.url);
        if (!url) continue;
        parsed.sources.push({
          title: cleanString(source?.title, 240) || new URL(url).hostname,
          url,
        });
      }
    }
    if (item?.type === 'message') {
      for (const block of Array.isArray(item.content) ? item.content : []) {
        if (block?.type === 'output_text' || block?.type === 'text') appendTextBlock(parsed, block);
      }
    }
  }
  if (!parsed.text && cleanString(payload.output_text)) parsed.text = String(payload.output_text);
  parsed.queries = uniqueStrings(parsed.queries);
  parsed.sources = dedupeSources([...parsed.citations, ...parsed.sources]);
  return parsed;
}

function parseGeminiResponse(payload = {}) {
  const parsed = { text: '', citations: [], queries: [], sources: [], search_suggestions_html: [] };
  for (const step of Array.isArray(payload.steps) ? payload.steps : []) {
    const type = cleanString(step?.type);
    if (type === 'google_search_call') {
      parsed.queries.push(...(Array.isArray(step?.arguments?.queries) ? step.arguments.queries : []));
      if (step?.arguments?.query) parsed.queries.push(step.arguments.query);
    } else if (type === 'google_search_result') {
      // Durante la transición de Interactions API se han documentado ambas
      // formas: una lista de items y un único objeto result. Aceptamos las dos
      // sin perder el widget obligatorio de sugerencias de Google.
      const resultItems = Array.isArray(step.result)
        ? step.result
        : (step.result && typeof step.result === 'object' ? [step.result] : []);
      for (const item of resultItems) {
        const html = String(item?.search_suggestions || item?.searchSuggestions || '').trim();
        if (html) parsed.search_suggestions_html.push(html.slice(0, 100000));
      }
    } else if (type === 'model_output') {
      for (const block of Array.isArray(step.content) ? step.content : []) {
        if (block?.type === 'text' || block?.type === 'output_text') appendTextBlock(parsed, block);
      }
    }
  }
  if (!parsed.text && cleanString(payload.output_text || payload.outputText)) {
    parsed.text = String(payload.output_text || payload.outputText);
  }
  parsed.queries = uniqueStrings(parsed.queries);
  parsed.sources = dedupeSources(parsed.citations);
  parsed.search_suggestions_html = uniqueStrings(parsed.search_suggestions_html, 5);
  return parsed;
}

function openAiCountryCode(country) {
  const normalized = cleanString(country)?.toLocaleLowerCase('es-ES') || '';
  if (/france|francia/.test(normalized)) return 'FR';
  if (/portugal/.test(normalized)) return 'PT';
  if (/italia|italy/.test(normalized)) return 'IT';
  if (/andorra/.test(normalized)) return 'AD';
  return 'ES';
}

function dedupeSources(values = []) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const url = safeUrl(value?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    result.push({
      title: cleanString(value?.title, 240) || new URL(url).hostname,
      url,
    });
    if (result.length >= 30) break;
  }
  return result;
}

function publicProviderError(provider, error) {
  const status = Number(error?.response?.status || 0) || null;
  const code = cleanString(error?.response?.data?.error?.status || error?.response?.data?.error?.code || error?.code, 80);
  const rawMessage = cleanString(error?.response?.data?.error?.message || error?.message, 500) || 'El proveedor no respondió.';
  const billing = status === 402
    || status === 429 && /credit|quota|billing|prepaid|saldo|factur/i.test(rawMessage)
    || /credit|prepaid|billing account|saldo|facturaci[oó]n/i.test(rawMessage);
  const auth = status === 401 || status === 403 || /api key|credential|unauth|permission/i.test(rawMessage);
  return {
    provider,
    status: billing ? 'billing_required' : (auth ? 'credentials_invalid' : 'error'),
    model: provider === 'openai' ? OPENAI_MODEL : GEMINI_MODEL,
    message: billing
      ? 'El proveedor necesita saldo o facturación activa antes de ejecutar esta comprobación.'
      : (auth
        ? 'La credencial del proveedor no es válida o no tiene permiso para esta función.'
        : 'No se pudo completar la comprobación con este proveedor.'),
    error: { http_status: status, code },
  };
}

function asObject(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_) {
    return {};
  }
}

function countryNameFromRegionCode(regionCode, fallback = null) {
  const code = cleanString(regionCode)?.toUpperCase();
  if (code === 'ES') return 'España';
  if (code === 'FR') return 'Francia';
  if (code === 'PT') return 'Portugal';
  if (code === 'IT') return 'Italia';
  if (code === 'AD') return 'Andorra';
  return cleanString(fallback) || 'España';
}

async function resolveClinicContext(clinicId) {
  const clinic = await Clinica.findByPk(clinicId, {
    attributes: [
      'id_clinica',
      'nombre_clinica',
      'url_web',
      'url_ficha_local',
      'direccion',
      'codigo_postal',
      'ciudad',
      'provincia',
      'pais',
    ],
    raw: true,
  });
  if (!clinic) {
    const error = new Error('Clínica no encontrada.');
    error.code = 'CLINIC_NOT_FOUND';
    error.status = 404;
    throw error;
  }
  const location = ClinicBusinessLocation
    ? await ClinicBusinessLocation.findOne({
      where: { clinica_id: clinicId, is_active: true },
      attributes: ['location_name', 'primary_category', 'raw_payload', 'last_synced_at'],
      order: [['last_synced_at', 'DESC'], ['id', 'DESC']],
      raw: true,
    })
    : null;
  const locationPayload = asObject(location?.raw_payload);
  const storefrontAddress = asObject(locationPayload.storefrontAddress || locationPayload.storefront_address);
  const addressLines = Array.isArray(storefrontAddress.addressLines)
    ? storefrontAddress.addressLines
    : (Array.isArray(storefrontAddress.address_lines) ? storefrontAddress.address_lines : []);
  const city = cleanString(clinic.ciudad)
    || cleanString(storefrontAddress.locality)
    || cleanString(storefrontAddress.sublocality);
  const province = cleanString(clinic.provincia)
    || cleanString(storefrontAddress.administrativeArea)
    || cleanString(storefrontAddress.administrative_area);
  const country = countryNameFromRegionCode(
    storefrontAddress.regionCode || storefrontAddress.region_code,
    clinic.pais,
  );
  return {
    id: Number(clinic.id_clinica),
    name: cleanString(location?.location_name) || cleanString(clinic.nombre_clinica) || `Clínica ${clinicId}`,
    category: cleanString(location?.primary_category) || 'clínica',
    website: safeUrl(clinic.url_web),
    local_profile_url: safeUrl(clinic.url_ficha_local),
    address: [
      cleanString(clinic.direccion) || addressLines.map((value) => cleanString(value)).filter(Boolean).join(', '),
      cleanString(clinic.codigo_postal) || cleanString(storefrontAddress.postalCode || storefrontAddress.postal_code),
      city,
      province,
      country,
    ]
      .map((value) => cleanString(value))
      .filter(Boolean)
      .join(', '),
    city,
    province,
    country,
  };
}

function buildProviderPrompt(query, clinic) {
  const identity = [
    `nombre público: ${clinic.name}`,
    clinic.category ? `categoría: ${clinic.category}` : null,
    clinic.address ? `ubicación: ${clinic.address}` : null,
    clinic.website ? `web oficial: ${clinic.website}` : null,
  ].filter(Boolean).join('; ');
  return [
    'Actúa como un asistente de búsqueda local neutral y usa búsqueda web actual.',
    `Responde exactamente a esta consulta local generada por el sistema: «${query}».`,
    `Después comprueba la presencia de esta clínica auditada (${identity}).`,
    'La identidad auditada es solo una referencia de comparación: no la introduzcas en la respuesta ni la favorezcas si no aparece de forma natural en las fuentes consultadas.',
    'No inventes posiciones. Indica claramente si aparece o no y qué otras clínicas se mencionan de forma verificable.',
    'No infieras ni incluyas datos de pacientes, tratamientos de personas concretas ni información clínica sensible.',
    'Responde en español y de forma concisa con: respuesta a la búsqueda, presencia de la clínica analizada, competidores mencionados y señales que explican la respuesta.',
    'Toda afirmación verificable debe conservar sus citas web.',
  ].join('\n');
}

async function runOpenAiSearch({ query, clinic }, dependencies = {}) {
  const apiKey = cleanString(process.env.OPENAI_API_KEY);
  if (!apiKey) {
    return {
      provider: 'openai',
      status: 'not_configured',
      model: OPENAI_MODEL,
      message: 'OpenAI todavía no está configurado en el servidor.',
    };
  }
  const http = dependencies.axios || axios;
  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  const organization = cleanString(process.env.OPENAI_ORGANIZATION_ID);
  const project = cleanString(process.env.OPENAI_PROJECT_ID);
  if (organization) headers['OpenAI-Organization'] = organization;
  if (project) headers['OpenAI-Project'] = project;
  const webSearchTool = {
    type: 'web_search',
    search_context_size: 'medium',
    external_web_access: true,
  };
  if (clinic.city || clinic.province) {
    webSearchTool.user_location = {
      type: 'approximate',
      country: openAiCountryCode(clinic.country),
      ...(clinic.city ? { city: clinic.city } : {}),
      ...(clinic.province ? { region: clinic.province } : {}),
      timezone: 'Europe/Madrid',
    };
  }
  try {
    const response = await http.post('https://api.openai.com/v1/responses', {
      model: OPENAI_MODEL,
      store: false,
      reasoning: { effort: 'low' },
      tools: [webSearchTool],
      tool_choice: 'required',
      include: ['web_search_call.action.sources'],
      max_output_tokens: 2200,
      input: buildProviderPrompt(query, clinic),
    }, { headers, timeout: PROVIDER_TIMEOUT_MS });
    const parsed = parseOpenAiResponse(response.data || {});
    if (!cleanString(parsed.text)) {
      return {
        provider: 'openai',
        status: 'no_result',
        model: response.data?.model || OPENAI_MODEL,
        message: 'OpenAI completó la consulta pero no devolvió una respuesta visible.',
        ...parsed,
      };
    }
    return {
      provider: 'openai',
      status: 'completed',
      model: cleanString(response.data?.model) || OPENAI_MODEL,
      generated_at: new Date().toISOString(),
      ...parsed,
    };
  } catch (error) {
    return publicProviderError('openai', error);
  }
}

async function runGeminiSearch({ query, clinic }, dependencies = {}) {
  const apiKey = cleanString(process.env.GEMINI_API_KEY);
  if (!apiKey) {
    return {
      provider: 'gemini',
      status: 'not_configured',
      model: GEMINI_MODEL,
      message: 'Gemini todavía no está configurado en el servidor.',
    };
  }
  const http = dependencies.axios || axios;
  try {
    const response = await http.post('https://generativelanguage.googleapis.com/v1beta/interactions', {
      model: GEMINI_MODEL,
      store: false,
      input: buildProviderPrompt(query, clinic),
      tools: [{ type: 'google_search' }],
    }, {
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      timeout: PROVIDER_TIMEOUT_MS,
    });
    const parsed = parseGeminiResponse(response.data || {});
    if (!cleanString(parsed.text)) {
      return {
        provider: 'gemini',
        status: 'no_result',
        model: response.data?.model || GEMINI_MODEL,
        message: 'Gemini completó la consulta pero no devolvió una respuesta visible.',
        ...parsed,
      };
    }
    return {
      provider: 'gemini',
      status: 'completed',
      model: cleanString(response.data?.model) || GEMINI_MODEL,
      generated_at: new Date().toISOString(),
      ...parsed,
    };
  } catch (error) {
    return publicProviderError('gemini', error);
  }
}

function providerConfiguration() {
  const openAiConfigured = !!cleanString(process.env.OPENAI_API_KEY);
  const geminiConfigured = !!cleanString(process.env.GEMINI_API_KEY);
  return {
    openai: {
      configured: openAiConfigured,
      status: openAiConfigured ? 'ready' : 'not_configured',
      model: OPENAI_MODEL,
      storage: 'disabled',
      message: openAiConfigured
        ? 'ChatGPT está listo para las comprobaciones automáticas.'
        : 'ChatGPT está pendiente de configuración segura en el servidor.',
    },
    gemini: {
      configured: geminiConfigured,
      status: geminiConfigured ? 'ready' : 'not_configured',
      model: GEMINI_MODEL,
      storage: 'disabled',
      message: geminiConfigured
        ? 'Gemini está listo para las comprobaciones automáticas.'
        : 'Gemini está pendiente de configuración segura en el servidor.',
    },
  };
}

function buildTypicalQueries(clinic) {
  const category = cleanString(clinic?.category)?.toLocaleLowerCase('es-ES') || 'clínica';
  const place = cleanString(clinic?.city) || cleanString(clinic?.province) || 'mi zona';
  const queries = [
    `¿Cuál es la mejor ${category} en ${place}?`,
    `¿Qué ${category} recomiendan en ${place}?`,
    `¿Qué ${category} tiene buenas reseñas en ${place}?`,
  ];
  return TYPICAL_QUERY_DEFINITIONS.map((definition, index) => ({
    ...definition,
    query: queries[index],
  }));
}

function buildSuggestedQueries(clinic) {
  return buildTypicalQueries(clinic).map((item) => item.query);
}

function findTypicalQuery(clinic, { queryKey = null, legacyQuery = null } = {}) {
  const typicalQueries = buildTypicalQueries(clinic);
  const normalizedKey = cleanString(queryKey, 64)?.toLocaleLowerCase('es-ES');
  if (normalizedKey) {
    const byKey = typicalQueries.find((item) => item.key === normalizedKey);
    if (byKey) return byKey;
  }
  const normalizedLegacy = cleanString(legacyQuery)?.toLocaleLowerCase('es-ES');
  if (normalizedLegacy) {
    const byExactText = typicalQueries.find(
      (item) => item.query.toLocaleLowerCase('es-ES') === normalizedLegacy,
    );
    if (byExactText) return byExactText;
  }
  return typicalQueries[0];
}

function partialRunIsReusable(run, now = new Date()) {
  if (run?.status !== 'completed_with_errors') return false;
  const currentProviders = providerConfiguration();
  const storedProviders = asObject(run.provider_status);
  const sameConfiguration = ['openai', 'gemini'].every((provider) => (
    Boolean(storedProviders?.[provider]?.configured) === Boolean(currentProviders?.[provider]?.configured)
  ));
  if (!sameConfiguration) return false;

  const statuses = Object.values(storedProviders)
    .map((provider) => cleanString(provider?.status))
    .filter(Boolean);
  const onlyWaitingForConfiguration = statuses.length > 0
    && statuses.every((status) => ['completed', 'not_configured'].includes(status));
  const retryMinutes = onlyWaitingForConfiguration
    ? CACHE_HOURS * 60
    : PARTIAL_RUN_RETRY_MINUTES;
  const createdAt = new Date(run.created_at || 0);
  return Number.isFinite(createdAt.getTime())
    && createdAt.getTime() >= now.getTime() - retryMinutes * 60 * 1000;
}

function serializeRun(run, typicalQueries = []) {
  const value = run?.get ? run.get({ plain: true }) : run;
  if (!value) return null;
  const normalizedQuery = cleanString(value.query)?.toLocaleLowerCase('es-ES');
  const typicalQuery = (typicalQueries || []).find(
    (item) => cleanString(item?.query)?.toLocaleLowerCase('es-ES') === normalizedQuery,
  );
  return {
    id: Number(value.id),
    clinic_id: Number(value.clinica_id),
    query: value.query,
    query_key: typicalQuery?.key || null,
    query_source: typicalQuery ? 'system' : 'legacy',
    status: value.status,
    provider_status: value.provider_status || {},
    provider_results: value.provider_results || {},
    errors: value.error_summary || [],
    job_request_id: value.job_request_id ? Number(value.job_request_id) : null,
    started_at: value.started_at || null,
    completed_at: value.completed_at || null,
    expires_at: value.expires_at || null,
    created_at: value.created_at || null,
    updated_at: value.updated_at || null,
  };
}

function overviewState({ providers, automatic, runs }) {
  const configuredProviders = Object.values(providers).filter((provider) => provider.configured).length;
  if (!configuredProviders) {
    return {
      status: 'configuration_required',
      message: 'Las consultas están preparadas y comenzarán automáticamente cuando se configure al menos un proveedor.',
    };
  }
  if (runs.some((run) => ['queued', 'running'].includes(run.status))) {
    return {
      status: 'collecting',
      message: 'ClinicaClick está consultando automáticamente las búsquedas locales habituales.',
    };
  }
  if (automatic.status === 'temporarily_unavailable') {
    return {
      status: 'temporarily_unavailable',
      message: 'No se han podido preparar las consultas automáticas. Se volverá a intentar al cargar el informe.',
    };
  }
  const completedRuns = runs.filter((run) => ['completed', 'completed_with_errors'].includes(run.status));
  if (completedRuns.length) {
    const hasPartialResults = configuredProviders < 2
      || completedRuns.some((run) => run.status === 'completed_with_errors');
    return {
      status: hasPartialResults ? 'partial' : 'ready',
      message: hasPartialResults
        ? 'Hay resultados disponibles y algún proveedor todavía requiere atención.'
        : 'Las consultas locales habituales están actualizadas.',
    };
  }
  return {
    status: automatic.status === 'partial' ? 'partial' : 'collecting',
    message: automatic.message,
  };
}

async function getOverview(clinicId, {
  limit = 10,
  autoStart = true,
  requestedBy = null,
  requestedByName = null,
  requestedByRole = null,
} = {}, dependencies = {}) {
  const RunModel = dependencies.RunModel || MarketingAiVisibilityRun;
  const resolver = dependencies.resolveClinicContext || resolveClinicContext;
  const clinic = await resolver(clinicId);
  const providers = providerConfiguration();
  const typicalQueries = buildTypicalQueries(clinic);
  let automatic = {
    enabled: true,
    status: 'disabled_for_request',
    triggered: false,
    queued: 0,
    reused: 0,
    errors: [],
    message: 'La ejecución automática está deshabilitada para esta lectura técnica.',
  };
  if (autoStart) {
    automatic = await ensureTypicalRuns({
      clinicId,
      clinic,
      typicalQueries,
      requestedBy,
      requestedByName,
      requestedByRole,
    }, dependencies);
  }
  const rows = await RunModel.findAll({
    where: {
      clinica_id: clinicId,
      expires_at: { [Op.gt]: new Date() },
    },
    order: [['created_at', 'DESC']],
    limit: Math.max(3, Math.min(20, Number(limit) || 10)),
  });
  const serializedRuns = rows.map((row) => serializeRun(row, typicalQueries));
  const state = overviewState({ providers, automatic, runs: serializedRuns });
  return {
    success: true,
    ...state,
    clinic: {
      id: clinic.id,
      name: clinic.name,
      category: clinic.category,
      city: clinic.city,
      province: clinic.province,
    },
    providers,
    automatic,
    typical_queries: typicalQueries,
    // Compatibilidad de una versión con el frontend anterior. Nunca se usan
    // para aceptar texto libre en el backend.
    suggested_queries: typicalQueries.map((item) => item.query),
    cache_hours: CACHE_HOURS,
    max_runs_per_clinic_24h: MAX_RUNS_PER_CLINIC_24H,
    max_attempts_per_query_24h: MAX_ATTEMPTS_PER_QUERY_24H,
    runs: serializedRuns,
  };
}

async function getRun(runId, clinicId, dependencies = {}) {
  const RunModel = dependencies.RunModel || MarketingAiVisibilityRun;
  const resolver = dependencies.resolveClinicContext || resolveClinicContext;
  const row = await RunModel.findOne({
    where: { id: runId, clinica_id: clinicId },
  });
  if (!row) {
    const error = new Error('Comprobación de visibilidad no encontrada.');
    error.code = 'AI_VISIBILITY_RUN_NOT_FOUND';
    error.status = 404;
    throw error;
  }
  const clinic = await resolver(clinicId);
  return serializeRun(row, buildTypicalQueries(clinic));
}

async function enqueueRun({
  clinicId,
  query,
  clinic = null,
  typicalQueries = null,
  requestedBy = null,
  requestedByName = null,
  requestedByRole = null,
}, dependencies = {}) {
  const RunModel = dependencies.RunModel || MarketingAiVisibilityRun;
  const jobs = dependencies.jobRequestsService || jobRequestsService;
  // Carga diferida: jobScheduler -> jobExecutor también registra este
  // servicio. Resolverlo dentro del endpoint evita una dependencia circular
  // durante el arranque del worker.
  const scheduler = dependencies.jobScheduler || require('./jobScheduler.service');
  const normalizedQuery = normalizeQuery(query);
  const resolvedClinic = clinic || await (dependencies.resolveClinicContext || resolveClinicContext)(clinicId);
  const resolvedTypicalQueries = typicalQueries || buildTypicalQueries(resolvedClinic);
  const hash = queryHash(normalizedQuery);
  const now = new Date();
  const cacheCutoff = new Date(now.getTime() - CACHE_HOURS * 60 * 60 * 1000);
  const activeCutoff = new Date(now.getTime() - ACTIVE_RUN_REUSE_MINUTES * 60 * 1000);
  let reusable = await RunModel.findOne({
    where: {
      clinica_id: clinicId,
      query_hash: hash,
      expires_at: { [Op.gt]: now },
      [Op.or]: [
        {
          status: { [Op.in]: ['completed', 'completed_with_errors'] },
          created_at: { [Op.gte]: cacheCutoff },
        },
        {
          status: { [Op.in]: ['queued', 'running'] },
          created_at: { [Op.gte]: activeCutoff },
        },
      ],
    },
    order: [['created_at', 'DESC']],
  });
  if (reusable?.status === 'completed_with_errors' && !partialRunIsReusable(reusable, now)) {
    reusable = null;
  }
  if (reusable) {
    return {
      run: serializeRun(reusable, resolvedTypicalQueries),
      reused: true,
      queued: ['queued', 'running'].includes(reusable.status),
    };
  }

  const windowStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const recentAttemptsForQuery = await RunModel.count({
    where: {
      clinica_id: clinicId,
      query_hash: hash,
      created_at: { [Op.gte]: windowStart },
    },
  });
  if (recentAttemptsForQuery >= MAX_ATTEMPTS_PER_QUERY_24H) {
    const error = new Error('Esta consulta ya ha agotado sus reintentos de las últimas 24 horas.');
    error.code = 'AI_VISIBILITY_QUERY_ATTEMPT_LIMIT';
    error.status = 429;
    throw error;
  }
  const recentDistinctQueries = await RunModel.count({
    where: { clinica_id: clinicId, created_at: { [Op.gte]: windowStart } },
    distinct: true,
    col: 'query_hash',
  });
  if (!recentAttemptsForQuery && recentDistinctQueries >= MAX_RUNS_PER_CLINIC_24H) {
    const error = new Error(`Esta clínica ya ha usado sus ${MAX_RUNS_PER_CLINIC_24H} comprobaciones de las últimas 24 horas.`);
    error.code = 'AI_VISIBILITY_RATE_LIMIT';
    error.status = 429;
    throw error;
  }

  const expiresAt = new Date(now.getTime() + RUN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const row = await RunModel.create({
    clinica_id: clinicId,
    requested_by_user_id: requestedBy || null,
    query: normalizedQuery,
    query_hash: hash,
    status: 'queued',
    provider_status: providerConfiguration(),
    expires_at: expiresAt,
  });

  try {
    const jobInput = {
      type: JOB_TYPE,
      payload: { runId: Number(row.id), clinicId: Number(clinicId) },
      priority: 'low',
      origin: 'marketing_reports:ai_visibility_automatic',
      requestedBy,
      requestedByName,
      requestedByRole,
      maxAttempts: 2,
      dedupeScope: `ai_visibility:${Number(clinicId)}:${hash}`,
    };
    let job;
    let jobCreated = true;
    if (typeof jobs.enqueueUniqueJobRequest === 'function') {
      const unique = await jobs.enqueueUniqueJobRequest(jobInput);
      job = unique.job;
      jobCreated = unique.created;
    } else {
      job = await jobs.enqueueJobRequest(jobInput);
    }
    if (!jobCreated) {
      const existingPayload = asObject(job?.payload);
      const existingRunId = Number(existingPayload.runId || existingPayload.run_id || 0);
      const existingRun = existingRunId > 0 ? await RunModel.findByPk(existingRunId) : null;
      if (existingRun) {
        if (typeof row.destroy === 'function') await row.destroy();
        return {
          run: serializeRun(existingRun, resolvedTypicalQueries),
          reused: true,
          queued: ['queued', 'running'].includes(existingRun.status),
        };
      }
      const error = new Error('No se pudo recuperar la comprobación automática ya encolada.');
      error.code = 'AI_VISIBILITY_DEDUPE_RUN_NOT_FOUND';
      throw error;
    }
    await row.update({ job_request_id: job.id });
    scheduler.triggerImmediate(job.id).catch((error) => {
      console.error('❌ Error despertando job de visibilidad IA:', error.message);
    });
    return { run: serializeRun(row, resolvedTypicalQueries), reused: false, queued: true };
  } catch (error) {
    if (typeof row.update === 'function') {
      await row.update({
        status: 'failed',
        completed_at: new Date(),
        error_summary: [{ code: 'AI_VISIBILITY_QUEUE_ERROR', message: 'No se pudo encolar la comprobación.' }],
      });
    }
    throw error;
  }
}

async function ensureTypicalRuns({
  clinicId,
  clinic = null,
  typicalQueries = null,
  requestedBy = null,
  requestedByName = null,
  requestedByRole = null,
}, dependencies = {}) {
  const providers = providerConfiguration();
  const configuredProviders = Object.values(providers).filter((provider) => provider.configured).length;
  const resolvedClinic = clinic || await (dependencies.resolveClinicContext || resolveClinicContext)(clinicId);
  const queries = typicalQueries || buildTypicalQueries(resolvedClinic);
  if (!configuredProviders) {
    return {
      enabled: true,
      status: 'waiting_configuration',
      triggered: false,
      queued: 0,
      reused: 0,
      errors: [],
      message: 'Las tres consultas habituales están preparadas y se ejecutarán automáticamente al configurar ChatGPT o Gemini.',
    };
  }

  const results = [];
  const errors = [];
  for (const typicalQuery of queries) {
    try {
      const result = await enqueueRun({
        clinicId,
        clinic: resolvedClinic,
        typicalQueries: queries,
        query: typicalQuery.query,
        requestedBy,
        requestedByName,
        requestedByRole,
      }, dependencies);
      results.push({ query_key: typicalQuery.key, ...result });
    } catch (error) {
      errors.push({
        query_key: typicalQuery.key,
        code: cleanString(error?.code, 80) || 'AI_VISIBILITY_AUTOMATIC_ERROR',
        message: ['AI_VISIBILITY_RATE_LIMIT', 'AI_VISIBILITY_QUERY_ATTEMPT_LIMIT'].includes(error?.code)
          ? 'La consulta se actualizará cuando se libere el límite diario.'
          : 'No se pudo preparar esta consulta automática.',
      });
    }
  }
  const created = results.filter((result) => !result.reused).length;
  const reused = results.filter((result) => result.reused).length;
  const pending = results.filter((result) => result.queued).length;
  const status = errors.length
    ? (results.length ? 'partial' : 'temporarily_unavailable')
    : (created || pending ? 'queued' : 'up_to_date');
  return {
    enabled: true,
    status,
    triggered: created > 0,
    queued: pending,
    reused,
    errors,
    message: status === 'up_to_date'
      ? 'Las tres consultas habituales ya están actualizadas.'
      : (status === 'queued'
        ? 'ClinicaClick está actualizando automáticamente las tres consultas habituales.'
        : (status === 'partial'
          ? 'Algunas consultas están disponibles y otras se actualizarán más adelante.'
          : 'No se han podido preparar las consultas automáticas.')),
  };
}

async function enqueueTypicalRun({
  clinicId,
  queryKey = null,
  legacyQuery = null,
  requestedBy = null,
  requestedByName = null,
  requestedByRole = null,
}, dependencies = {}) {
  const clinic = await (dependencies.resolveClinicContext || resolveClinicContext)(clinicId);
  const typicalQueries = buildTypicalQueries(clinic);
  const typicalQuery = findTypicalQuery(clinic, { queryKey, legacyQuery });
  return enqueueRun({
    clinicId,
    clinic,
    typicalQueries,
    query: typicalQuery.query,
    requestedBy,
    requestedByName,
    requestedByRole,
  }, dependencies);
}

async function executeRun(payload = {}, dependencies = {}) {
  const RunModel = dependencies.RunModel || MarketingAiVisibilityRun;
  const runId = Number(payload.runId || payload.run_id || 0);
  if (!Number.isInteger(runId) || runId <= 0) throw new Error('marketing_ai_visibility_run requires payload.runId');
  const row = await RunModel.findByPk(runId);
  if (!row) {
    return { status: 'completed', result: { skipped: true, reason: 'run_not_found', run_id: runId } };
  }
  if (['completed', 'completed_with_errors', 'failed'].includes(row.status)) {
    return { status: 'completed', result: { skipped: true, reason: 'already_terminal', run_id: runId } };
  }

  await row.update({ status: 'running', started_at: row.started_at || new Date(), error_summary: null });
  try {
    const clinic = await (dependencies.resolveClinicContext || resolveClinicContext)(Number(row.clinica_id));
    const input = { query: row.query, clinic };
    const [openai, gemini] = await Promise.all([
      (dependencies.runOpenAiSearch || runOpenAiSearch)(input, dependencies),
      (dependencies.runGeminiSearch || runGeminiSearch)(input, dependencies),
    ]);
    const results = { openai, gemini };
    const failures = Object.values(results)
      .filter((result) => result?.status !== 'completed')
      .map((result) => ({
        provider: result?.provider || 'unknown',
        status: result?.status || 'error',
        message: result?.message || 'No se pudo completar la consulta.',
      }));
    const completed = Object.values(results).filter((result) => result?.status === 'completed').length;
    const status = failures.length ? 'completed_with_errors' : 'completed';
    await row.update({
      status,
      provider_status: Object.fromEntries(Object.entries(results).map(([provider, result]) => [provider, {
        configured: result?.status !== 'not_configured',
        status: result?.status || 'error',
        model: result?.model || null,
      }])),
      provider_results: results,
      error_summary: failures,
      completed_at: new Date(),
    });
    return {
      status: 'completed',
      result: { run_id: runId, run_status: status, providers_completed: completed, providers_total: 2 },
    };
  } catch (error) {
    await row.update({
      status: 'failed',
      completed_at: new Date(),
      error_summary: [{ code: cleanString(error.code, 80), message: 'No se pudo completar la comprobación de visibilidad.' }],
    });
    throw error;
  }
}

async function cleanupExpiredRuns(now = new Date()) {
  return MarketingAiVisibilityRun.destroy({ where: { expires_at: { [Op.lt]: now } } });
}

module.exports = {
  JOB_TYPE,
  getOverview,
  getRun,
  enqueueRun,
  enqueueTypicalRun,
  ensureTypicalRuns,
  executeRun,
  cleanupExpiredRuns,
  providerConfiguration,
  __testing: {
    buildProviderPrompt,
    buildSuggestedQueries,
    buildTypicalQueries,
    findTypicalQuery,
    normalizeCitation,
    normalizeQuery,
    parseGeminiResponse,
    parseOpenAiResponse,
    openAiCountryCode,
    partialRunIsReusable,
    publicProviderError,
    queryHash,
    resolveClinicContext,
    runGeminiSearch,
    runOpenAiSearch,
    serializeRun,
  },
};
