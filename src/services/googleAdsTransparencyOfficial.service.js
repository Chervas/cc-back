'use strict';

const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const weeklyBilling = require('./googleWeeklyBilling.service');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BIGQUERY_API = 'https://bigquery.googleapis.com/bigquery/v2';
const BIGQUERY_SCOPE = 'https://www.googleapis.com/auth/bigquery';
const DATASET_TABLE = 'bigquery-public-data.google_ads_transparency_center.creative_stats';
const DEFAULT_LOCATION = 'US';
const DEFAULT_REGION_CODES = ['ES'];
const tokenCache = new Map();

function cleanString(value) {
  const result = value == null ? '' : String(value).trim();
  return result || null;
}

function normalizeName(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sharedTokens(left, right) {
  const ignored = new Set(['clinica', 'clinic', 'centro', 'medical', 'medico', 'salud', 'de', 'la', 'el', 'y']);
  const leftTokens = normalizeName(left).split(' ').filter((token) => token.length >= 3 && !ignored.has(token));
  const rightTokens = new Set(normalizeName(right).split(' ').filter((token) => token.length >= 3 && !ignored.has(token)));
  return leftTokens.filter((token) => rightTokens.has(token));
}

function matchScore(competitor, advertiserName) {
  const advertiser = normalizeName(advertiserName);
  if (!advertiser) return 0;
  const candidates = candidateNamesForCompetitor(competitor);
  let best = 0;
  for (const candidate of candidates) {
    const normalized = normalizeName(candidate);
    if (!normalized) continue;
    if (normalized === advertiser) best = Math.max(best, 100);
    else if (normalized.length >= 5 && (advertiser.includes(normalized) || normalized.includes(advertiser))) best = Math.max(best, 80);
    const tokens = sharedTokens(normalized, advertiser);
    if (tokens.length >= 2) best = Math.max(best, 70);
    else if (tokens.some((token) => token.length >= 6)) best = Math.max(best, 48);
  }
  return best;
}

function envFlagEnabled(value, fallback = true) {
  if (value == null || String(value).trim() === '') return fallback;
  return !['0', 'false', 'off', 'no'].includes(String(value).trim().toLowerCase());
}

function parseJsonCredential(raw) {
  if (!raw) return null;
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!parsed || typeof parsed !== 'object') return null;
    const clientEmail = cleanString(parsed.client_email);
    const privateKey = cleanString(parsed.private_key)?.replace(/\\n/g, '\n');
    const projectId = cleanString(parsed.project_id);
    if (!clientEmail || !privateKey || !projectId) return null;
    return { client_email: clientEmail, private_key: privateKey, project_id: projectId };
  } catch (_) {
    return null;
  }
}

function loadServiceAccount(env = process.env) {
  const direct = cleanString(env.GOOGLE_BIGQUERY_SERVICE_ACCOUNT_JSON)
    || cleanString(env.GOOGLE_ADS_TRANSPARENCY_SERVICE_ACCOUNT_JSON);
  const parsedDirect = parseJsonCredential(direct);
  if (parsedDirect) return parsedDirect;

  const encoded = cleanString(env.GOOGLE_BIGQUERY_SERVICE_ACCOUNT_JSON_BASE64)
    || cleanString(env.GOOGLE_ADS_TRANSPARENCY_SERVICE_ACCOUNT_JSON_BASE64);
  if (encoded) {
    try {
      const parsedEncoded = parseJsonCredential(Buffer.from(encoded, 'base64').toString('utf8'));
      if (parsedEncoded) return parsedEncoded;
    } catch (_) {
      // El estado de configuración se informa sin exponer el secreto ni su contenido.
    }
  }

  const credentialPath = cleanString(env.GOOGLE_APPLICATION_CREDENTIALS);
  if (credentialPath) {
    try {
      return parseJsonCredential(fs.readFileSync(credentialPath, 'utf8'));
    } catch (_) {
      return null;
    }
  }
  return null;
}

function configuration(env = process.env) {
  const enabled = envFlagEnabled(env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_ENABLED, true);
  const credentials = loadServiceAccount(env);
  return {
    enabled,
    configured: enabled && !!credentials,
    projectId: cleanString(env.GOOGLE_CLOUD_PROJECT) || credentials?.project_id || null,
    location: cleanString(env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_BIGQUERY_LOCATION) || DEFAULT_LOCATION,
    credentials,
    billingEnabled: env.GOOGLE_CLOUD_COSTS_WEEKLY_ENABLED === 'true',
  };
}

function configurationError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.status = 503;
  return error;
}

async function accessToken(credentials, http = axios) {
  const cached = tokenCache.get(credentials.client_email);
  if (cached && cached.expiresAt > Date.now() + 60_000) return cached.value;

  const now = Math.floor(Date.now() / 1000);
  const assertion = jwt.sign({
    iss: credentials.client_email,
    scope: BIGQUERY_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }, credentials.private_key, { algorithm: 'RS256' });

  const response = await http.post(TOKEN_URL, new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion,
  }).toString(), {
    timeout: 15_000,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  });
  const value = cleanString(response?.data?.access_token);
  if (!value) throw configurationError('GOOGLE_ATC_BIGQUERY_TOKEN_MISSING', 'Google no devolvió un token para consultar su dataset público de transparencia.');
  const expiresIn = Math.max(300, Number(response?.data?.expires_in || 3600));
  tokenCache.set(credentials.client_email, { value, expiresAt: Date.now() + expiresIn * 1000 });
  return value;
}

function candidateNamesForCompetitor(competitor = {}) {
  const raw = competitor.raw_place_payload || {};
  const social = raw.clinicaclick_social_profiles || raw.social_profiles || {};
  const values = [
    competitor.name,
    competitor.meta_page_name,
    ...(Array.isArray(competitor.meta_ads_search_terms) ? competitor.meta_ads_search_terms : []),
    social.instagram_username,
    social.facebook_username,
  ];
  return [...new Set(values.map(cleanString).filter((value) => normalizeName(value).length >= 4))].slice(0, 5);
}

function advertiserIdFromUrl(value) {
  const raw = cleanString(value);
  if (!raw) return null;
  return cleanString(raw.match(/(?:^|\/)advertiser\/([^/?#]+)/i)?.[1]);
}

function candidateAdvertiserIdsForCompetitor(competitor = {}) {
  const raw = competitor.raw_place_payload || {};
  const identity = raw.clinicaclick_google_ads || raw.google_ads_transparency || {};
  return [...new Set([
    competitor.google_ads_advertiser_id,
    identity.advertiser_id,
    advertiserIdFromUrl(competitor.google_ads_advertiser_url),
    advertiserIdFromUrl(identity.advertiser_url),
  ].map(cleanString).filter(Boolean))].slice(0, 3);
}

function queryParameters(candidateNames, candidateIds, regionCodes, lookbackDays, rowLimit) {
  const array = (name, values) => ({
    name,
    parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
    parameterValue: { arrayValues: values.map((value) => ({ value })) },
  });
  return [
    array('candidate_names', candidateNames),
    array('candidate_ids', candidateIds),
    array('region_codes', regionCodes),
    { name: 'lookback_days', parameterType: { type: 'INT64' }, parameterValue: { value: String(lookbackDays) } },
    { name: 'row_limit', parameterType: { type: 'INT64' }, parameterValue: { value: String(rowLimit) } },
  ];
}

function buildQuery() {
  return `
SELECT
  creative.advertiser_id,
  ANY_VALUE(creative.advertiser_disclosed_name) AS advertiser_disclosed_name,
  ANY_VALUE(creative.advertiser_legal_name) AS advertiser_legal_name,
  COUNT(DISTINCT creative.creative_id) AS ads_count,
  MAX(region.last_shown) AS last_shown
FROM \`${DATASET_TABLE}\` AS creative
CROSS JOIN UNNEST(creative.region_stats) AS region
WHERE region.region_code IN UNNEST(@region_codes)
  AND SAFE_CAST(region.last_shown AS DATE) >= DATE_SUB(CURRENT_DATE(), INTERVAL @lookback_days DAY)
  AND (
    creative.advertiser_id IN UNNEST(@candidate_ids)
    OR EXISTS (
      SELECT 1
      FROM UNNEST(@candidate_names) AS candidate
      WHERE STRPOS(NORMALIZE_AND_CASEFOLD(COALESCE(creative.advertiser_disclosed_name, '')), NORMALIZE_AND_CASEFOLD(candidate)) > 0
         OR STRPOS(NORMALIZE_AND_CASEFOLD(COALESCE(creative.advertiser_legal_name, '')), NORMALIZE_AND_CASEFOLD(candidate)) > 0
         OR STRPOS(NORMALIZE_AND_CASEFOLD(candidate), NORMALIZE_AND_CASEFOLD(COALESCE(creative.advertiser_disclosed_name, ''))) > 0
         OR STRPOS(NORMALIZE_AND_CASEFOLD(candidate), NORMALIZE_AND_CASEFOLD(COALESCE(creative.advertiser_legal_name, ''))) > 0
    )
  )
GROUP BY creative.advertiser_id
ORDER BY last_shown DESC
LIMIT @row_limit`;
}

function simpleRows(payload = {}) {
  const fields = Array.isArray(payload?.schema?.fields) ? payload.schema.fields : [];
  return (Array.isArray(payload?.rows) ? payload.rows : []).map((row) => {
    const values = Array.isArray(row?.f) ? row.f : [];
    return fields.reduce((result, field, index) => {
      result[field.name] = values[index]?.v ?? null;
      return result;
    }, {});
  });
}

function requestIdForRun(runKey) {
  const hex = crypto.createHash('sha256').update(String(runKey || 'manual')).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function maximumBytesBilled(env = process.env) {
  return Math.max(
    100_000_000,
    Number(env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_MAX_BYTES_BILLED || 25_000_000_000),
  );
}

async function runQuery({
  config,
  candidateNames,
  candidateIds,
  regionCodes,
  lookbackDays,
  rowLimit,
  runKey,
  http = axios,
}) {
  if (!config.enabled) throw configurationError('GOOGLE_ATC_BIGQUERY_DISABLED', 'La fuente oficial de transparencia de Google está desactivada.');
  if (!config.credentials || !config.projectId) {
    throw configurationError(
      'GOOGLE_ATC_BIGQUERY_CREDENTIALS_MISSING',
      'Falta la credencial server-side de BigQuery para consultar el dataset público de Google Ads Transparency.',
    );
  }
  if (config.billingEnabled && (config.projectId !== 'clinicaclick' || config.location !== 'US')) {
    throw configurationError('GOOGLE_BILLING_LOCATION_INVALID', 'El lote conjunto requiere clinicaclick y región US.');
  }
  const cutoff = weeklyBilling.cutoffForRun(runKey);
  if (cutoff > new Date().toISOString().slice(0, 10)) throw configurationError('GOOGLE_ATC_RUN_INVALID', 'La semana solicitada todavía no ha comenzado.');
  const token = await accessToken(config.credentials, http);
  const bytesLimit = maximumBytesBilled();
  if (!Number.isSafeInteger(bytesLimit)) throw configurationError('GOOGLE_ATC_BIGQUERY_BYTES_LIMIT', 'Límite de consulta inválido.');
  const parameters = queryParameters(candidateNames, candidateIds, regionCodes, lookbackDays, rowLimit);
  if (config.billingEnabled) parameters.push({ name: 'billing_cutoff', parameterType: { type: 'DATE' }, parameterValue: { value: cutoff } });
  const query = config.billingEnabled ? weeklyBilling.combinedQuery(buildQuery()) : buildQuery();
  const queryConfig = { query, useLegacySql: false, parameterMode: 'NAMED', queryParameters: parameters,
    useQueryCache: true, maximumBytesBilled: String(bytesLimit), priority: 'INTERACTIVE' };
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(queryConfig)).digest('hex').slice(0, 40);
  // A stable job ID survives lost acknowledgements and process restarts. The
  // jobs.query requestId alone does not deduplicate read-only queries durably.
  const jobId = 'cc_google_weekly_' + cutoff.replace(/-/g, '');
  const root = `${BIGQUERY_API}/projects/${encodeURIComponent(config.projectId)}`;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const readJob = async () => (await http.get(`${root}/jobs/${jobId}`, { timeout: 15000, headers, params: { location: config.location } })).data;
  let job, dryRunBytes = null;
  try { job = await readJob(); } catch (error) { if (error.response?.status !== 404) throw error; }
  if (!job) {
    const dry = await http.post(`${root}/queries`, { query, useLegacySql: false, parameterMode: 'NAMED',
      queryParameters: parameters, location: config.location, maximumBytesBilled: String(bytesLimit),
      dryRun: true, useQueryCache: false, timeoutMs: 30000 }, { timeout: 35000, headers });
    dryRunBytes = Number(dry.data?.totalBytesProcessed ?? dry.data?.statistics?.query?.totalBytesProcessed);
    if (!Number.isSafeInteger(dryRunBytes) || dryRunBytes < 0 || dryRunBytes > bytesLimit) {
      throw configurationError('GOOGLE_ATC_BIGQUERY_BYTES_LIMIT', 'La consulta supera el límite de bytes o no aporta una estimación válida.');
    }
    try {
      job = (await http.post(`${root}/jobs`, { jobReference: { projectId: config.projectId, jobId, location: config.location },
        configuration: { query: queryConfig, labels: { clinicaclick_module: 'competition', clinicaclick_cadence: 'weekly',
          clinicaclick_contract: fingerprint } } }, { timeout: 35000, headers })).data;
    } catch (error) {
      // A 409 or uncertain insert must read the same job, never invent another ID.
      try { job = await readJob(); } catch { throw error; }
    }
  }
  if (job?.jobReference?.jobId !== jobId || job?.configuration?.labels?.clinicaclick_contract !== fingerprint) {
    throw configurationError('GOOGLE_ATC_WEEKLY_JOB_CONFLICT', 'Ya existe una consulta semanal con parámetros diferentes. No se repetirá.');
  }
  if (job.status?.errorResult) throw configurationError('GOOGLE_ATC_BIGQUERY_QUERY_ERROR', 'La consulta semanal de Google falló; se conserva la caché anterior.');
  const rows = [], tokens = new Set(); let pageToken, schema, totalBytesProcessed = 0, declaredRows;
  let waits = 0, pages = 0;
  do {
    const response = await http.get(`${root}/queries/${jobId}`, { timeout: 35000, headers,
      params: { location: config.location, timeoutMs: 30000, maxResults: 1000, ...(pageToken ? { pageToken } : {}) } });
    const payload = response.data || {};
    if (payload.errors?.length) throw configurationError('GOOGLE_ATC_BIGQUERY_QUERY_ERROR', 'Google rechazó la consulta semanal.');
    if (payload.jobComplete === false) {
      if (++waits > 5) throw configurationError('GOOGLE_ATC_BIGQUERY_TIMEOUT', 'La consulta sigue ejecutándose; se recuperará el mismo job.');
      continue;
    }
    if (payload.jobComplete !== true || ++pages > 20) throw configurationError('GOOGLE_ATC_BIGQUERY_RESULT_INVALID', 'Resultado incompleto de Google.');
    schema ||= payload.schema;
    if (!Array.isArray(schema?.fields)) throw configurationError('GOOGLE_ATC_BIGQUERY_RESULT_INVALID', 'Falta el esquema del resultado.');
    declaredRows ??= Number(payload.totalRows);
    totalBytesProcessed = Number(payload.totalBytesProcessed || job.statistics?.query?.totalBytesProcessed || 0);
    rows.push(...simpleRows({ ...payload, schema }));
    if (rows.length > rowLimit + 200) throw configurationError('GOOGLE_ATC_BIGQUERY_RESULT_INVALID', 'El resultado excede el límite previsto.');
    pageToken = payload.pageToken;
    if (pageToken && (typeof pageToken !== 'string' || tokens.has(pageToken))) throw configurationError('GOOGLE_ATC_BIGQUERY_RESULT_INVALID', 'Paginación inválida.');
    if (pageToken) tokens.add(pageToken);
    else break;
  } while (true);
  if (!Number.isSafeInteger(declaredRows) || rows.length !== declaredRows) throw configurationError('GOOGLE_ATC_BIGQUERY_RESULT_INVALID', 'El resultado está truncado.');
  const collectedAt = new Date(Number(job.statistics?.creationTime)).toISOString();
  const split = config.billingEnabled ? weeklyBilling.splitRows(rows, { runKey, collectedAt }) : { advertisers: rows, snapshots: [] };
  return { rows: split.advertisers, billingSnapshots: split.snapshots, jobId, collectedAt,
    dryRunBytes, maximumBytesBilled: bytesLimit, totalBytesProcessed };
}

function advertiserUrl(advertiserId) {
  return advertiserId
    ? `https://adstransparency.google.com/advertiser/${encodeURIComponent(advertiserId)}?region=ES`
    : null;
}

function normalizeAd(row = {}) {
  const advertiserId = cleanString(row.advertiser_id);
  const creativeId = cleanString(row.creative_id);
  const creativeUrl = cleanString(row.creative_page_url);
  const disclosedName = cleanString(row.advertiser_disclosed_name);
  const legalName = cleanString(row.advertiser_legal_name);
  return {
    provider: 'google_ads_transparency',
    id: creativeId,
    creative_id: creativeId,
    advertiser_id: advertiserId,
    advertiser_name: disclosedName || legalName,
    page_name: disclosedName || legalName,
    title: cleanString(row.ad_format_type) || 'Anuncio de Google',
    description: cleanString(row.topic),
    format: cleanString(row.ad_format_type),
    snapshot_url: creativeUrl,
    ad_snapshot_url: creativeUrl,
    advertiser_url: advertiserUrl(advertiserId),
    library_url: creativeUrl || advertiserUrl(advertiserId),
    platforms: ['GOOGLE'],
    publisher_platforms: ['GOOGLE'],
    delivery_start_at: cleanString(row.first_shown),
    delivery_stop_at: cleanString(row.last_shown),
    impressions_lower_bound: row.times_shown_lower_bound == null ? null : Number(row.times_shown_lower_bound),
    impressions_upper_bound: row.times_shown_upper_bound == null ? null : Number(row.times_shown_upper_bound),
    advertiser_location: cleanString(row.advertiser_location),
    advertiser_verification_status: cleanString(row.advertiser_verification_status),
    region_code: cleanString(row.region_code),
    funded_by: cleanString(row.ad_funded_by),
    media_source: 'official_dataset_metadata',
  };
}

async function fetchForCompetitors(competitors = [], options = {}) {
  const config = options.config || configuration();
  const eligible = competitors.filter((competitor) => (
    candidateNamesForCompetitor(competitor).length
    || candidateAdvertiserIdsForCompetitor(competitor).length
  ));
  const result = new Map(eligible.map((competitor) => [String(competitor.id), {
    ads: [], total_ads_count: 0, resolved: null,
    raw: { clinicaclick_resolution: { mode: 'official_bigquery', matched: false } },
  }]));
  if (!eligible.length && !config.billingEnabled) return result;

  const candidateNames = [...new Set(eligible.flatMap(candidateNamesForCompetitor))].slice(0, 5_000);
  const candidateIds = [...new Set(eligible.flatMap(candidateAdvertiserIdsForCompetitor))].slice(0, 5_000);
  const lookbackDays = Math.max(7, Math.min(3650, Number(process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_LOOKBACK_DAYS || 365)));
  const rowLimit = Math.max(25, Math.min(5_000, Number(process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_QUERY_ROW_LIMIT || 2_000)));
  const regionCodes = String(process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_REGION_CODES || DEFAULT_REGION_CODES.join(','))
    .split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
  const queryResult = await runQuery({
    config,
    candidateNames,
    candidateIds,
    regionCodes,
    lookbackDays,
    rowLimit,
    runKey: options.runKey,
    http: options.http || axios,
  });
  result.billingSnapshots = queryResult.billingSnapshots;
  result.metadata = {
    job_id: queryResult.jobId,
    collected_at: queryResult.collectedAt,
    run_key: cleanString(options.runKey),
    candidates: candidateNames.length,
    advertiser_ids: candidateIds.length,
    rows_returned: queryResult.rows.length,
    dry_run_bytes: queryResult.dryRunBytes,
    maximum_bytes_billed: queryResult.maximumBytesBilled,
    total_bytes_processed: queryResult.totalBytesProcessed,
  };

  for (const row of queryResult.rows) {
    const advertiserId = cleanString(row.advertiser_id);
    const advertiserName = cleanString(row.advertiser_disclosed_name) || cleanString(row.advertiser_legal_name);
    const matches = eligible
      .map((competitor) => ({
        competitor,
        score: candidateAdvertiserIdsForCompetitor(competitor).includes(advertiserId)
          ? 1000
          : matchScore(competitor, advertiserName),
      }))
      .filter((item) => item.score >= 48)
      .sort((left, right) => right.score - left.score);
    if (!matches.length) continue;
    const bestScore = matches[0].score;
    const recipients = bestScore >= 70
      ? matches.filter((item) => item.score === bestScore)
      : [matches[0]];
    for (const match of recipients) {
      const key = String(match.competitor.id);
      const bucket = result.get(key);
      bucket.total_ads_count += Math.max(0, Number(row.ads_count || 0));
      if (!bucket.resolved || match.score > bucket.resolved.match_score) {
        bucket.resolved = {
          mode: 'official_bigquery',
          advertiser_id: advertiserId,
          advertiser_name: advertiserName,
          advertiser_url: advertiserUrl(advertiserId),
          last_shown: cleanString(row.last_shown),
          match_score: match.score,
        };
      }
    }
  }

  for (const bucket of result.values()) {
    bucket.raw = {
      clinicaclick_resolution: {
        mode: 'official_bigquery',
        matched: !!bucket.resolved,
        advertiser: bucket.resolved,
        measurement: 'recent_es_creatives',
        lookback_days: lookbackDays,
        weekly_run_key: cleanString(options.runKey),
        dry_run_bytes: queryResult.dryRunBytes,
        maximum_bytes_billed: queryResult.maximumBytesBilled,
        total_bytes_processed: queryResult.totalBytesProcessed,
      },
    };
  }
  return result;
}

module.exports = {
  configuration,
  fetchForCompetitors,
  __testing: {
    buildQuery,
    candidateAdvertiserIdsForCompetitor,
    candidateNamesForCompetitor,
    matchScore,
    maximumBytesBilled,
    normalizeAd,
    parseJsonCredential,
    requestIdForRun,
    simpleRows,
    runQuery,
  },
};
