'use strict';

const axios = require('axios');

const PROVIDER = 'google_ads_transparency';
const BASE_URL = process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_BASE
  || 'https://adstransparency.google.com';
const DEFAULT_COUNTRY = String(
  process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_COUNTRY || 'ES'
).trim().toUpperCase();
const DEFAULT_GEO_CRITERIA_ID = 2724; // Spain.

function cleanString(value) {
  const result = value == null ? '' : String(value).trim();
  return result || null;
}

function toInt(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function enabled(env = process.env) {
  const value = cleanString(env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_FAST_PATH_ENABLED);
  if (!value) return true;
  return !['0', 'false', 'off', 'no'].includes(value.toLowerCase());
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

function domainFromUrl(value) {
  const raw = cleanString(value);
  if (!raw) return null;
  try {
    const parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return parsed.hostname.replace(/^www\./i, '').toLowerCase() || null;
  } catch (_) {
    return null;
  }
}

function candidateDomains(competitor = {}) {
  const raw = competitor.raw_place_payload || {};
  return [...new Set([
    domainFromUrl(competitor.website_url),
    domainFromUrl(raw.websiteUri),
    domainFromUrl(raw.website_url),
  ].filter(Boolean))]
    .filter((domain) => !['google.com', 'facebook.com', 'instagram.com'].includes(domain))
    .slice(0, 1);
}

function candidateTerms(competitor = {}) {
  const raw = competitor.raw_place_payload || {};
  const social = raw.clinicaclick_social_profiles || raw.social_profiles || {};
  return [...new Set([
    competitor.name,
    competitor.meta_page_name,
    ...(Array.isArray(competitor.meta_ads_search_terms) ? competitor.meta_ads_search_terms : []),
    social.instagram_username,
    social.facebook_username,
  ].map(cleanString).filter((value) => normalizeName(value).length >= 4))].slice(0, 2);
}

function sharedTokens(left, right) {
  const ignored = new Set(['clinica', 'clinic', 'centro', 'medical', 'medico', 'salud', 'de', 'la', 'el', 'y']);
  const leftTokens = normalizeName(left).split(' ').filter((token) => token.length >= 3 && !ignored.has(token));
  const rightTokens = new Set(normalizeName(right).split(' ').filter((token) => token.length >= 3 && !ignored.has(token)));
  return leftTokens.filter((token) => rightTokens.has(token));
}

function advertiserMatchScore(competitor = {}, advertiserName) {
  const advertiser = normalizeName(advertiserName);
  if (!advertiser) return 0;
  let best = 0;
  for (const candidate of candidateTerms(competitor)) {
    const normalized = normalizeName(candidate);
    if (normalized === advertiser) best = Math.max(best, 100);
    else if (normalized.length >= 5 && (advertiser.includes(normalized) || normalized.includes(advertiser))) {
      best = Math.max(best, 80);
    }
    const tokens = sharedTokens(normalized, advertiser);
    if (tokens.length >= 2) best = Math.max(best, 70);
    else if (tokens.some((token) => token.length >= 6)) best = Math.max(best, 48);
  }
  return best;
}

function regionIds(env = process.env) {
  const explicit = String(env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_GEO_CRITERIA_IDS || '')
    .split(/[,\s]+/)
    .map(toInt)
    .filter(Boolean);
  if (explicit.length) return [...new Set(explicit)];
  return DEFAULT_COUNTRY === 'ES' ? [DEFAULT_GEO_CRITERIA_ID] : [];
}

function requestHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (compatible; ClinicaClickBot/1.0; +https://clinicaclick.com)',
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'X-Same-Domain': '1',
    Referer: `${BASE_URL}/`,
  };
}

async function rpc(path, body, http = axios) {
  const timeout = Math.max(2_000, Math.min(20_000, Number(
    process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_TIMEOUT_MS || 12_000
  )));
  const response = await http.post(
    `${BASE_URL.replace(/\/$/g, '')}/anji/_/rpc/${path}`,
    body,
    {
      timeout,
      maxContentLength: 2 * 1024 * 1024,
      headers: requestHeaders(),
    }
  );
  return response?.data || {};
}

function timestamp(value) {
  const seconds = toNumber(value?.['1'] ?? value?.seconds);
  return seconds ? new Date(seconds * 1_000).toISOString() : null;
}

function findString(value, predicate, seen = new Set()) {
  if (!value) return null;
  if (typeof value === 'string') return predicate(value) ? value : null;
  if (typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    const found = findString(item, predicate, seen);
    if (found) return found;
  }
  return null;
}

function mediaFromPreview(preview) {
  const html = findString(preview, (value) => /<img\b|<video\b/i.test(value));
  if (!html) return {};
  const image = html.match(/<img[^>]+src=["']([^"']+)/i)?.[1] || null;
  const video = html.match(/<video[^>]+src=["']([^"']+)/i)?.[1]
    || html.match(/<source[^>]+src=["']([^"']+)/i)?.[1]
    || null;
  return { image_url: image, thumbnail_url: image, video_url: video, media_url: video || image };
}

function advertiserUrl(advertiserId) {
  return advertiserId
    ? `${BASE_URL}/advertiser/${encodeURIComponent(advertiserId)}?region=${encodeURIComponent(DEFAULT_COUNTRY)}`
    : null;
}

function creativeUrl(advertiserId, creativeId) {
  return advertiserId && creativeId
    ? `${BASE_URL}/advertiser/${encodeURIComponent(advertiserId)}/creative/${encodeURIComponent(creativeId)}?region=${encodeURIComponent(DEFAULT_COUNTRY)}`
    : null;
}

function normalizeAd(ad = {}) {
  const advertiserId = cleanString(ad['1'] || ad.advertiser_id);
  const creativeId = cleanString(ad['2'] || ad.creative_id);
  const advertiserName = cleanString(ad['12'] || ad.advertiser_name);
  const formatCode = toInt(ad['4'] || ad.format);
  const format = { 1: 'Imagen', 2: 'HTML5', 3: 'Vídeo', 4: 'Texto' }[formatCode] || 'Anuncio de Google';
  const libraryUrl = advertiserUrl(advertiserId);
  const snapshotUrl = creativeUrl(advertiserId, creativeId);
  return {
    provider: PROVIDER,
    id: creativeId,
    creative_id: creativeId,
    advertiser_id: advertiserId,
    advertiser_name: advertiserName,
    page_name: advertiserName,
    domain: domainFromUrl(ad['14']) || cleanString(ad['14'] || ad.domain),
    title: format,
    snapshot_url: snapshotUrl,
    ad_snapshot_url: snapshotUrl,
    advertiser_url: libraryUrl,
    library_url: libraryUrl || snapshotUrl,
    platforms: ['GOOGLE'],
    publisher_platforms: ['GOOGLE'],
    format,
    format_code: formatCode,
    created_at: timestamp(ad['6']),
    delivery_start_at: timestamp(ad['6']),
    delivery_stop_at: timestamp(ad['7']),
    media_source: 'google_rpc_preview',
    ...mediaFromPreview(ad['3'] || ad.preview || {}),
  };
}

function normalizeSuggestion(item = {}) {
  const advertiser = item['1'];
  if (!advertiser) return null;
  return {
    name: cleanString(advertiser['1']),
    advertiser_id: cleanString(advertiser['2']),
    country: cleanString(advertiser['3']),
    ads_count_hint: toInt(advertiser['4']?.['1']?.['1'] || advertiser['4']?.['2']?.['1']),
  };
}

async function searchCreatives(query, http) {
  const ids = regionIds();
  if (ids.length) query[8] = ids;
  const limit = Math.max(1, Math.min(25, Number(
    process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_FAST_AD_LIMIT || 12
  )));
  const raw = await rpc('SearchService/SearchCreatives', { 2: limit, 3: query, 7: { 1: 1 } }, http);
  const ads = (Array.isArray(raw?.['1']) ? raw['1'] : []).map(normalizeAd);
  return {
    raw,
    ads,
    total_ads_count: toInt(raw?.['5']) || toInt(raw?.['4']) || ads.length,
  };
}

async function fetchForCompetitor(competitor = {}, options = {}) {
  if (!enabled(options.env || process.env)) {
    const error = new Error('La consulta rápida de Google Ads Transparency está desactivada.');
    error.code = 'GOOGLE_ADS_TRANSPARENCY_FAST_DISABLED';
    throw error;
  }
  const http = options.http || axios;
  const resolution = { mode: 'not_found', domains_checked: [], suggestions_checked: [] };

  for (const domain of candidateDomains(competitor)) {
    resolution.domains_checked.push(domain);
    const result = await searchCreatives({ 12: { 1: domain, 2: true } }, http);
    if (result.ads.length) {
      return {
        ...result,
        resolved: { mode: 'domain', domain },
        raw: { ...result.raw, clinicaclick_resolution: { ...resolution, mode: 'domain', domain } },
      };
    }
  }

  const candidates = [];
  for (const term of candidateTerms(competitor)) {
    const body = { 1: term, 2: 5, 3: 3 };
    const ids = regionIds();
    if (ids.length) body[4] = ids;
    const raw = await rpc('SearchService/SearchSuggestions', body, http);
    const suggestions = (Array.isArray(raw?.['1']) ? raw['1'] : [])
      .map(normalizeSuggestion)
      .filter(Boolean)
      .map((candidate) => ({
        ...candidate,
        term,
        match_score: advertiserMatchScore(competitor, candidate.name),
      }))
      .filter((candidate) => candidate.advertiser_id && candidate.match_score >= 48);
    resolution.suggestions_checked.push({ term, matches: suggestions.slice(0, 3) });
    candidates.push(...suggestions);
  }

  const candidate = candidates.sort((left, right) => right.match_score - left.match_score)[0];
  if (!candidate) {
    return {
      ads: [],
      total_ads_count: 0,
      resolved: null,
      raw: { clinicaclick_resolution: resolution },
    };
  }
  const result = await searchCreatives({ 1: candidate.advertiser_id }, http);
  return {
    ...result,
    resolved: { mode: 'advertiser', ...candidate },
    raw: {
      ...result.raw,
      clinicaclick_resolution: {
        ...resolution,
        mode: 'advertiser',
        advertiser: candidate,
      },
    },
  };
}

module.exports = {
  enabled,
  fetchForCompetitor,
  __testing: {
    advertiserMatchScore,
    candidateDomains,
    candidateTerms,
    normalizeAd,
    normalizeSuggestion,
  },
};
