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
const REFRESH_INTERVAL_DAYS = clampInt(process.env.AI_VISIBILITY_REFRESH_INTERVAL_DAYS, 7, 30, 7);
const CACHE_HOURS = REFRESH_INTERVAL_DAYS * 24;
const RUN_RETENTION_DAYS = clampInt(process.env.AI_VISIBILITY_RETENTION_DAYS, REFRESH_INTERVAL_DAYS, 180, 30);
const MAX_RUNS_PER_CLINIC_7D = clampInt(process.env.AI_VISIBILITY_MAX_RUNS_PER_CLINIC_7D, 4, 30, 4);
// Contrato de producto: una consulta no vuelve a llamar a proveedores antes
// de siete días, aunque el resultado anterior fuese parcial o fallase.
const MAX_ATTEMPTS_PER_QUERY_7D = 1;
const ACTIVE_RUN_REUSE_MINUTES = clampInt(process.env.AI_VISIBILITY_ACTIVE_RUN_REUSE_MINUTES, 5, 180, 15);
const PROVIDER_TIMEOUT_MS = clampInt(process.env.AI_VISIBILITY_PROVIDER_TIMEOUT_MS, 10000, 180000, 90000);
const OPENAI_MODEL = cleanString(process.env.OPENAI_AI_VISIBILITY_MODEL) || 'gpt-5.6';
const GEMINI_MODEL = cleanString(process.env.GEMINI_AI_VISIBILITY_MODEL) || 'gemini-3.5-flash';
const LOCAL_PROFILE_URL_RESOLUTION_CONFIG_KEY = 'marketing_competition_local_profile';

const TYPICAL_QUERY_DEFINITIONS = Object.freeze([
  Object.freeze({ key: 'best_local', label: 'Mejor clínica de la zona' }),
  Object.freeze({ key: 'category_options', label: 'Opciones de esta especialidad' }),
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

function normalizedSearchText(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('es-ES')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function specialtyFromText(value) {
  const text = normalizedSearchText(value);
  if (!text) return null;
  if (/(^| )(capilar|alopecia|injerto capilar|trasplante capilar|pelo|hair)( |$)/.test(text)) {
    return 'clínica capilar';
  }
  if (/(^| )(hepatobiliar|pancreat|laparoscop|cirugia digestiva|cirujano digestivo|digestiv)( |$)/.test(text)) {
    return 'clínica de cirugía digestiva y hepatobiliar';
  }
  if (/(^| )(podolog|podologo|podologa|podologia)( |$)/.test(text)) return 'clínica podológica';
  if (/(^| )(dental|dentist|dentista|odontolog|ortodoncia|implante dental)( |$)/.test(text)) {
    return 'clínica dental';
  }
  const hasPlasticSurgery = /(^| )(cirugia plastica|cirujano plastico|plastic surgery)( |$)/.test(text);
  const hasAestheticMedicine = /(^| )(medicina estetica|clinica estetica|estetica medica|estetica)( |$)/.test(text);
  if (hasPlasticSurgery && hasAestheticMedicine) {
    return 'clínica de medicina estética y cirugía plástica';
  }
  if (hasPlasticSurgery) return 'clínica de cirugía plástica';
  if (hasAestheticMedicine) return 'clínica de medicina estética';
  if (/(^| )(fisioterap|rehabilitacion)( |$)/.test(text)) return 'clínica de fisioterapia';
  if (/(^| )(dermatolog)( |$)/.test(text)) return 'clínica dermatológica';
  if (/(^| )(oftalmolog|oculista)( |$)/.test(text)) return 'clínica oftalmológica';
  if (/(^| )(nutricion|nutricionista|dietista)( |$)/.test(text)) return 'clínica de nutrición';
  if (/(^| )(ginecolog)( |$)/.test(text)) return 'clínica ginecológica';
  if (/(^| )(traumatolog)( |$)/.test(text)) return 'clínica traumatológica';
  if (/(^| )(psicolog|psiquiatr)( |$)/.test(text)) return 'clínica de psicología y salud mental';
  return null;
}

function isGenericClinicCategory(value) {
  const category = normalizedSearchText(value);
  return !category || [
    'clinica',
    'clinica medica',
    'clinica especializada',
    'centro medico',
    'centro de salud',
    'medico',
    'doctor',
    'hospital',
    'medical clinic',
    'medical center',
    'specialized clinic',
  ].includes(category);
}

function resolvedLocalProfileFromClinic(clinic) {
  const config = asObject(clinic?.configuracion);
  const profile = asObject(config[LOCAL_PROFILE_URL_RESOLUTION_CONFIG_KEY]);
  if (profile.status !== 'resolved') return {};
  const currentUrl = safeUrl(clinic?.url_ficha_local);
  const sourceUrl = safeUrl(profile.source_url);
  if (!currentUrl || !sourceUrl || currentUrl !== sourceUrl) return {};
  return profile;
}

function resolveDisciplineCategory(clinic, location = null, resolvedProfile = null) {
  const config = asObject(clinic?.configuracion);
  const profile = resolvedProfile || resolvedLocalProfileFromClinic(clinic);
  const primaryCategories = [
    cleanString(location?.primary_category),
    cleanString(profile?.primary_category),
  ].filter(Boolean);
  const specificPrimaryCategory = primaryCategories.find((value) => !isGenericClinicCategory(value));
  if (specificPrimaryCategory) {
    return specialtyFromText(specificPrimaryCategory)
      || specificPrimaryCategory.toLocaleLowerCase('es-ES');
  }

  const configuredDisciplines = [
    config.area_medica,
    config.disciplina,
    ...(Array.isArray(config.disciplinas) ? config.disciplinas : []),
  ];
  return specialtyFromText([
    ...primaryCategories,
    ...configuredDisciplines,
    clinic?.servicios,
    clinic?.descripcion,
    profile?.name,
    location?.location_name,
    clinic?.nombre_clinica,
  ].map((value) => cleanString(value)).filter(Boolean).join(' '));
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
      'servicios',
      'descripcion',
      'configuracion',
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
  const resolvedProfile = resolvedLocalProfileFromClinic(clinic);
  const storefrontAddress = asObject(locationPayload.storefrontAddress || locationPayload.storefront_address);
  const addressLines = Array.isArray(storefrontAddress.addressLines)
    ? storefrontAddress.addressLines
    : (Array.isArray(storefrontAddress.address_lines) ? storefrontAddress.address_lines : []);
  const city = cleanString(clinic.ciudad)
    || cleanString(storefrontAddress.locality)
    || cleanString(storefrontAddress.sublocality)
    || cleanString(resolvedProfile.locality);
  const province = cleanString(clinic.provincia)
    || cleanString(storefrontAddress.administrativeArea)
    || cleanString(storefrontAddress.administrative_area)
    || cleanString(resolvedProfile.administrative_area);
  const country = countryNameFromRegionCode(
    storefrontAddress.regionCode
      || storefrontAddress.region_code
      || resolvedProfile.country_code
      || resolvedProfile.country,
    clinic.pais,
  );
  return {
    id: Number(clinic.id_clinica),
    name: cleanString(location?.location_name)
      || cleanString(resolvedProfile.name)
      || cleanString(clinic.nombre_clinica)
      || `Clínica ${clinicId}`,
    category: resolveDisciplineCategory(clinic, location, resolvedProfile),
    website: safeUrl(clinic.url_web) || safeUrl(resolvedProfile.website_url),
    local_profile_url: safeUrl(clinic.url_ficha_local),
    address: [
      cleanString(clinic.direccion)
        || addressLines.map((value) => cleanString(value)).filter(Boolean).join(', ')
        || cleanString(resolvedProfile.address),
      cleanString(clinic.codigo_postal)
        || cleanString(storefrontAddress.postalCode || storefrontAddress.postal_code)
        || cleanString(resolvedProfile.postal_code),
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
  const category = cleanString(clinic?.category)?.toLocaleLowerCase('es-ES');
  const place = cleanString(clinic?.city) || cleanString(clinic?.province);
  if (!category || isGenericClinicCategory(category) || !place) return [];
  const bestLocalQuery = /^cl[ií]nica\b/u.test(category)
    ? `¿Cuál es la mejor ${category} en ${place}?`
    : `¿Qué ${category} es la mejor opción en ${place}?`;
  const queries = [
    bestLocalQuery,
    `¿Qué opciones de ${category} destacan en ${place}?`,
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
  if (!typicalQueries.length) return null;
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
  const createdAt = new Date(run.created_at || 0);
  return Number.isFinite(createdAt.getTime())
    && createdAt.getTime() >= now.getTime() - CACHE_HOURS * 60 * 60 * 1000;
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
  if (automatic.status === 'setup_required') {
    return {
      status: 'setup_required',
      message: automatic.message,
    };
  }
  const configuredProviders = Object.values(providers).filter((provider) => provider.configured).length;
  const failedRuns = runs.filter((run) => run.status === 'failed');
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
    const hasPartialResults = failedRuns.length > 0
      || configuredProviders < 2
      || completedRuns.some((run) => run.status === 'completed_with_errors');
    return {
      status: hasPartialResults ? 'partial' : 'ready',
      message: hasPartialResults
        ? 'Hay resultados disponibles y algún proveedor todavía requiere atención.'
        : 'Las consultas locales habituales están actualizadas.',
    };
  }
  if (failedRuns.length) {
    return {
      status: 'temporarily_unavailable',
      message: 'La comprobación semanal no pudo completarse. Se volverá a intentar al abrir Informes cuando corresponda la siguiente actualización.',
    };
  }
  return {
    status: automatic.status === 'partial' ? 'partial' : 'collecting',
    message: automatic.message,
  };
}

async function getOverview(clinicId, {
  limit = 10,
  // Solo el GET de entrada a Informes pasa autoStart=true. Mantener el
  // default cerrado evita que una lectura técnica o un polling de run
  // adquiera por accidente semántica de disparador automático.
  autoStart = false,
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
  const canonicalQueryHashes = typicalQueries.map((item) => queryHash(item.query));
  const rows = await RunModel.findAll({
    where: {
      clinica_id: clinicId,
      query_hash: { [Op.in]: canonicalQueryHashes },
      expires_at: { [Op.gt]: new Date() },
      [Op.or]: [
        { status: { [Op.ne]: 'failed' } },
        { job_request_id: { [Op.ne]: null } },
        { started_at: { [Op.ne]: null } },
      ],
    },
    order: [['created_at', 'DESC']],
    limit: Math.max(4, Math.min(20, Number(limit) || 10)),
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
    refresh_interval_days: REFRESH_INTERVAL_DAYS,
    max_runs_per_clinic_7d: MAX_RUNS_PER_CLINIC_7D,
    max_attempts_per_query_7d: MAX_ATTEMPTS_PER_QUERY_7D,
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
  const currentTypicalQueries = buildTypicalQueries(resolvedClinic);
  const resolvedTypicalQueries = typicalQueries || currentTypicalQueries;
  const currentCanonicalHashes = Array.from(new Set(
    currentTypicalQueries.map((item) => queryHash(normalizeQuery(item.query))),
  ));
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
          status: 'failed',
          created_at: { [Op.gte]: cacheCutoff },
          [Op.or]: [
            { job_request_id: { [Op.ne]: null } },
            { started_at: { [Op.ne]: null } },
          ],
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

  const windowStart = new Date(now.getTime() - REFRESH_INTERVAL_DAYS * 24 * 60 * 60 * 1000);
  const recentAttemptsForQuery = await RunModel.count({
    where: {
      clinica_id: clinicId,
      query_hash: hash,
      created_at: { [Op.gte]: windowStart },
      [Op.or]: [
        { status: { [Op.ne]: 'failed' } },
        { job_request_id: { [Op.ne]: null } },
        { started_at: { [Op.ne]: null } },
      ],
    },
  });
  if (recentAttemptsForQuery >= MAX_ATTEMPTS_PER_QUERY_7D) {
    const error = new Error('Esta consulta ya se comprobó durante los últimos siete días.');
    error.code = 'AI_VISIBILITY_QUERY_ATTEMPT_LIMIT';
    error.status = 429;
    throw error;
  }
  const recentDistinctQueries = await RunModel.count({
    where: {
      clinica_id: clinicId,
      query_hash: { [Op.in]: currentCanonicalHashes },
      created_at: { [Op.gte]: windowStart },
      [Op.or]: [
        { status: { [Op.ne]: 'failed' } },
        { job_request_id: { [Op.ne]: null } },
        { started_at: { [Op.ne]: null } },
      ],
    },
    distinct: true,
    col: 'query_hash',
  });
  if (!recentAttemptsForQuery && recentDistinctQueries >= MAX_RUNS_PER_CLINIC_7D) {
    const error = new Error(`Esta clínica ya ha usado sus ${MAX_RUNS_PER_CLINIC_7D} comprobaciones de los últimos siete días.`);
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

  let jobCreatedForRun = false;
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
      jobCreatedForRun = unique.created === true;
    } else {
      job = await jobs.enqueueJobRequest(jobInput);
      jobCreatedForRun = true;
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
    // Si nunca se creó un JobRequest, tampoco hubo una ejecución ni una
    // llamada a proveedores: la fila no debe consumir la cuota semanal.
    if (!jobCreatedForRun) {
      try {
        if (typeof row.destroy === 'function') {
          await row.destroy();
        } else if (typeof row.update === 'function') {
          await row.update({
            status: 'failed',
            completed_at: new Date(),
            error_summary: [{ code: 'AI_VISIBILITY_QUEUE_ERROR', message: 'No se pudo encolar la comprobación.' }],
          });
        }
      } catch (cleanupError) {
        console.error('❌ Error limpiando run IA sin job:', {
          run_id: Number(row.id || 0) || null,
          message: cleanupError.message,
        });
      }
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
  if (!queries.length) {
    return {
      enabled: true,
      status: 'setup_required',
      triggered: false,
      queued: 0,
      reused: 0,
      errors: [{
        code: 'AI_VISIBILITY_DISCIPLINE_REQUIRED',
        message: 'Falta la especialidad concreta de la clínica.',
      }],
      message: 'Completa o conecta la especialidad de la clínica para generar búsquedas de IA relevantes. No se harán consultas genéricas.',
    };
  }
  if (!configuredProviders) {
    return {
      enabled: true,
      status: 'waiting_configuration',
      triggered: false,
      queued: 0,
      reused: 0,
      errors: [],
      message: 'Las cuatro consultas habituales están preparadas y se ejecutarán al abrir Informes cuando ChatGPT o Gemini esté configurado.',
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
          ? 'La consulta se actualizará al volver a Informes cuando se cumplan siete días desde la comprobación anterior.'
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
      ? 'Las cuatro consultas habituales ya están actualizadas para esta semana.'
      : (status === 'queued'
        ? 'ClinicaClick está actualizando las cuatro consultas habituales.'
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
  if (!typicalQuery) {
    const error = new Error('La clínica necesita una especialidad y una localidad concretas antes de comprobar su visibilidad en IA.');
    error.code = 'AI_VISIBILITY_DISCIPLINE_REQUIRED';
    error.status = 409;
    throw error;
  }
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
    resolveDisciplineCategory,
    resolveClinicContext,
    resolvedLocalProfileFromClinic,
    runGeminiSearch,
    runOpenAiSearch,
    serializeRun,
  },
};
