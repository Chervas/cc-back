'use strict';

const fs = require('fs');
const axios = require('axios');
const jwt = require('jsonwebtoken');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const BIGQUERY_API = 'https://bigquery.googleapis.com/bigquery/v2';
const BIGQUERY_SCOPE = 'https://www.googleapis.com/auth/bigquery';
const DATASET_TABLE = 'bigquery-public-data.google_ads_transparency_center.creative_stats';
const DEFAULT_LOCATION = 'US';
const DEFAULT_REGION_CODES = ['ES', 'EEA'];
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

function queryParameters(candidateNames, regionCodes, lookbackDays, rowLimit) {
  const array = (name, values) => ({
    name,
    parameterType: { type: 'ARRAY', arrayType: { type: 'STRING' } },
    parameterValue: { arrayValues: values.map((value) => ({ value })) },
  });
  return [
    array('candidate_names', candidateNames),
    array('region_codes', regionCodes),
    { name: 'lookback_days', parameterType: { type: 'INT64' }, parameterValue: { value: String(lookbackDays) } },
    { name: 'row_limit', parameterType: { type: 'INT64' }, parameterValue: { value: String(rowLimit) } },
  ];
}

function buildQuery() {
  return `
SELECT
  creative.advertiser_id,
  creative.creative_id,
  creative.creative_page_url,
  creative.ad_format_type,
  creative.advertiser_disclosed_name,
  creative.advertiser_legal_name,
  creative.advertiser_location,
  creative.advertiser_verification_status,
  region.region_code,
  CAST(region.first_shown AS STRING) AS first_shown,
  CAST(region.last_shown AS STRING) AS last_shown,
  region.times_shown_lower_bound,
  region.times_shown_upper_bound,
  creative.topic,
  creative.ad_funded_by
FROM \`${DATASET_TABLE}\` AS creative
CROSS JOIN UNNEST(creative.region_stats) AS region
WHERE region.region_code IN UNNEST(@region_codes)
  AND region.last_shown >= DATE_SUB(CURRENT_DATE(), INTERVAL @lookback_days DAY)
  AND EXISTS (
    SELECT 1
    FROM UNNEST(@candidate_names) AS candidate
    WHERE STRPOS(NORMALIZE_AND_CASEFOLD(COALESCE(creative.advertiser_disclosed_name, '')), NORMALIZE_AND_CASEFOLD(candidate)) > 0
       OR STRPOS(NORMALIZE_AND_CASEFOLD(COALESCE(creative.advertiser_legal_name, '')), NORMALIZE_AND_CASEFOLD(candidate)) > 0
       OR STRPOS(NORMALIZE_AND_CASEFOLD(candidate), NORMALIZE_AND_CASEFOLD(COALESCE(creative.advertiser_disclosed_name, ''))) > 0
       OR STRPOS(NORMALIZE_AND_CASEFOLD(candidate), NORMALIZE_AND_CASEFOLD(COALESCE(creative.advertiser_legal_name, ''))) > 0
  )
ORDER BY region.last_shown DESC
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

async function runQuery({ config, candidateNames, regionCodes, lookbackDays, rowLimit, http = axios }) {
  if (!config.enabled) throw configurationError('GOOGLE_ATC_BIGQUERY_DISABLED', 'La fuente oficial de transparencia de Google está desactivada.');
  if (!config.credentials || !config.projectId) {
    throw configurationError(
      'GOOGLE_ATC_BIGQUERY_CREDENTIALS_MISSING',
      'Falta la credencial server-side de BigQuery para consultar el dataset público de Google Ads Transparency.',
    );
  }
  const token = await accessToken(config.credentials, http);
  const maximumBytesBilled = Math.max(
    100_000_000,
    Number(process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_MAX_BYTES_BILLED || 10_000_000_000),
  );
  const body = {
    query: buildQuery(),
    useLegacySql: false,
    parameterMode: 'NAMED',
    queryParameters: queryParameters(candidateNames, regionCodes, lookbackDays, rowLimit),
    useQueryCache: true,
    timeoutMs: '30000',
    maxResults: String(rowLimit),
    maximumBytesBilled: String(maximumBytesBilled),
    labels: { clinicaclick_module: 'competition' },
    location: config.location,
  };
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let response = await http.post(`${BIGQUERY_API}/projects/${encodeURIComponent(config.projectId)}/queries`, body, { timeout: 35_000, headers });
  let payload = response?.data || {};
  const jobId = cleanString(payload?.jobReference?.jobId);
  for (let attempt = 0; payload.jobComplete === false && jobId && attempt < 5; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 700 + attempt * 300));
    response = await http.get(`${BIGQUERY_API}/projects/${encodeURIComponent(config.projectId)}/queries/${encodeURIComponent(jobId)}`, {
      timeout: 15_000,
      headers,
      params: { location: config.location, maxResults: rowLimit },
    });
    payload = response?.data || {};
  }
  if (payload.jobComplete === false) throw configurationError('GOOGLE_ATC_BIGQUERY_TIMEOUT', 'La consulta oficial de transparencia de Google continúa en proceso. Se reintentará desde la cola.');
  if (Array.isArray(payload.errors) && payload.errors.length) {
    const error = configurationError('GOOGLE_ATC_BIGQUERY_QUERY_ERROR', cleanString(payload.errors[0]?.message) || 'Google rechazó la consulta de transparencia.');
    error.details = payload.errors.map((item) => ({ reason: item?.reason || null, location: item?.location || null }));
    throw error;
  }
  return { rows: simpleRows(payload), totalBytesProcessed: cleanString(payload.totalBytesProcessed) };
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
  const eligible = competitors.filter((competitor) => candidateNamesForCompetitor(competitor).length);
  const result = new Map(eligible.map((competitor) => [String(competitor.id), {
    ads: [], total_ads_count: 0, resolved: null,
    raw: { clinicaclick_resolution: { mode: 'official_bigquery', matched: false } },
  }]));
  if (!eligible.length) return result;

  const candidateNames = [...new Set(eligible.flatMap(candidateNamesForCompetitor))].slice(0, 100);
  const lookbackDays = Math.max(7, Math.min(3650, Number(process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_LOOKBACK_DAYS || 365)));
  const rowLimit = Math.max(25, Math.min(1000, Number(process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_QUERY_ROW_LIMIT || 500)));
  const regionCodes = String(process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_REGION_CODES || DEFAULT_REGION_CODES.join(','))
    .split(',').map((value) => value.trim().toUpperCase()).filter(Boolean);
  const queryResult = await runQuery({ config, candidateNames, regionCodes, lookbackDays, rowLimit, http: options.http || axios });

  for (const row of queryResult.rows) {
    const advertiserName = cleanString(row.advertiser_disclosed_name) || cleanString(row.advertiser_legal_name);
    const matches = eligible
      .map((competitor) => ({ competitor, score: matchScore(competitor, advertiserName) }))
      .filter((item) => item.score >= 48)
      .sort((left, right) => right.score - left.score);
    if (!matches.length) continue;
    const best = matches[0];
    const key = String(best.competitor.id);
    const bucket = result.get(key);
    const ad = { ...normalizeAd(row), match_score: best.score };
    if (!bucket.ads.some((item) => item.creative_id === ad.creative_id)) bucket.ads.push(ad);
    if (!bucket.resolved || best.score > bucket.resolved.match_score) {
      bucket.resolved = {
        mode: 'official_bigquery',
        advertiser_id: ad.advertiser_id,
        advertiser_name: ad.advertiser_name,
        match_score: best.score,
      };
    }
  }

  for (const bucket of result.values()) {
    bucket.ads.sort((left, right) => String(right.delivery_stop_at || '').localeCompare(String(left.delivery_stop_at || '')));
    bucket.total_ads_count = bucket.ads.length;
    bucket.raw = {
      clinicaclick_resolution: {
        mode: 'official_bigquery',
        matched: !!bucket.resolved,
        advertiser: bucket.resolved,
        measurement: 'recent_eea_creatives',
        lookback_days: lookbackDays,
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
    candidateNamesForCompetitor,
    matchScore,
    normalizeAd,
    parseJsonCredential,
    simpleRows,
  },
};
