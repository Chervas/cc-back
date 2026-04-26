'use strict';

const axios = require('axios');
const db = require('../../models');
const { metaGet } = require('../lib/metaClient');

const {
  MarketingCompetitor,
  MarketingCompetitorSnapshot,
  MarketingCompetitorAdSnapshot,
  Clinica,
  ClinicMetaAsset,
  MetaConnection,
  ClinicBusinessLocation,
} = db;

const { Op } = db.Sequelize;

const GOOGLE_PLACES_API_BASE = 'https://places.googleapis.com/v1';
const META_ADS_LIBRARY_PROVIDER = 'meta_ads_library';
const GOOGLE_ADS_TRANSPARENCY_PROVIDER = 'google_ads_transparency';
const GOOGLE_ADS_TRANSPARENCY_BASE = process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_BASE || 'https://adstransparency.google.com';
const DEFAULT_COUNTRY = process.env.COMPETITION_META_AD_COUNTRY || 'ES';
const DEFAULT_LANGUAGE = process.env.COMPETITION_GOOGLE_LANGUAGE || 'es';
const DEFAULT_REGION = process.env.COMPETITION_GOOGLE_REGION || 'ES';
const DEFAULT_LIMIT = Math.max(1, Math.min(25, parseInt(process.env.COMPETITION_SUGGESTION_LIMIT || '10', 10)));
const DEFAULT_AD_LIMIT = Math.max(1, Math.min(100, parseInt(process.env.COMPETITION_META_AD_LIMIT || '25', 10)));
const GOOGLE_TRANSPARENCY_AD_LIMIT = Math.max(1, Math.min(100, parseInt(process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_AD_LIMIT || '100', 10)));
const GOOGLE_TRANSPARENCY_ADVERTISER_LIMIT = Math.max(1, Math.min(10, parseInt(process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_ADVERTISER_LIMIT || '5', 10)));
const GOOGLE_TRANSPARENCY_TIMEOUT_MS = Math.max(2000, Math.min(30000, parseInt(process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_TIMEOUT_MS || '12000', 10)));
const GOOGLE_TRANSPARENCY_SCRIPT_MEDIA_LIMIT = Math.max(0, Math.min(GOOGLE_TRANSPARENCY_AD_LIMIT, parseInt(process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_SCRIPT_MEDIA_LIMIT || '25', 10)));
const DEFAULT_RANKING_LIMIT = Math.max(1, Math.min(5, parseInt(process.env.COMPETITION_LOCAL_RANKING_TERMS_LIMIT || '3', 10)));
const SNAPSHOT_MEDIA_TIMEOUT_MS = Math.max(1000, Math.min(15000, parseInt(process.env.COMPETITION_META_SNAPSHOT_MEDIA_TIMEOUT_MS || '6000', 10)));
const SNAPSHOT_MEDIA_LIMIT = Math.max(0, Math.min(DEFAULT_AD_LIMIT, parseInt(process.env.COMPETITION_META_SNAPSHOT_MEDIA_LIMIT || String(DEFAULT_AD_LIMIT), 10)));
const META_BROWSER_MEDIA_MODE = String(process.env.COMPETITION_META_BROWSER_MEDIA_MODE || (envFlagEnabled(process.env.COMPETITION_META_BROWSER_MEDIA_ENABLED, false) ? 'on' : 'auto')).trim().toLowerCase();
const META_BROWSER_MEDIA_LIMIT = Math.max(0, Math.min(DEFAULT_AD_LIMIT, parseInt(process.env.COMPETITION_META_BROWSER_MEDIA_LIMIT || '5', 10)));
const META_BROWSER_MEDIA_TIMEOUT_MS = Math.max(3000, Math.min(45000, parseInt(process.env.COMPETITION_META_BROWSER_MEDIA_TIMEOUT_MS || '15000', 10)));
const META_BROWSER_MEDIA_IDLE_MS = Math.max(0, Math.min(300000, parseInt(process.env.COMPETITION_META_BROWSER_MEDIA_IDLE_MS || '60000', 10)));
const META_BROWSER_MEDIA_MIN_MISSING = Math.max(1, Math.min(DEFAULT_AD_LIMIT, parseInt(process.env.COMPETITION_META_BROWSER_MEDIA_MIN_MISSING || '1', 10)));
const LOCAL_HEATMAP_GRID_SIZE = Math.max(3, Math.min(5, parseInt(process.env.COMPETITION_LOCAL_HEATMAP_GRID_SIZE || '5', 10)));
const LOCAL_HEATMAP_MAX_POINTS = Math.max(1, Math.min(25, parseInt(process.env.COMPETITION_LOCAL_HEATMAP_MAX_POINTS || '25', 10)));
const LOCAL_HEATMAP_RESULT_LIMIT = Math.max(3, Math.min(20, parseInt(process.env.COMPETITION_LOCAL_HEATMAP_RESULT_LIMIT || '20', 10)));
const SOCIAL_DISCOVERY_TIMEOUT_MS = Math.max(1000, Math.min(15000, parseInt(process.env.COMPETITION_SOCIAL_DISCOVERY_TIMEOUT_MS || '8000', 10)));
const SOCIAL_DISCOVERY_PAGE_LIMIT = Math.max(1, Math.min(6, parseInt(process.env.COMPETITION_SOCIAL_DISCOVERY_PAGE_LIMIT || '4', 10)));
const META_PAGE_MATCH_THRESHOLD = Math.max(20, Math.min(100, parseInt(process.env.COMPETITION_META_PAGE_MATCH_THRESHOLD || '45', 10)));
const GOOGLE_ADVERTISER_MATCH_THRESHOLD = Math.max(20, Math.min(100, parseInt(process.env.COMPETITION_GOOGLE_ADS_ADVERTISER_MATCH_THRESHOLD || '45', 10)));
const COMPETITION_CACHE_MAX_ENTRIES = Math.max(50, Math.min(2000, parseInt(process.env.COMPETITION_CACHE_MAX_ENTRIES || '600', 10)));
const COMPETITION_REPORT_CACHE_TTL_MS = Math.max(0, Math.min(3600000, parseInt(process.env.COMPETITION_REPORT_CACHE_TTL_MS || '180000', 10)));
const COMPETITION_SUGGESTIONS_CACHE_TTL_MS = Math.max(0, Math.min(3600000, parseInt(process.env.COMPETITION_SUGGESTIONS_CACHE_TTL_MS || '600000', 10)));
const COMPETITION_PROVIDER_CACHE_TTL_MS = Math.max(0, Math.min(300000, parseInt(process.env.COMPETITION_PROVIDER_CACHE_TTL_MS || '60000', 10)));
const COMPETITION_PLACES_CACHE_TTL_MS = Math.max(0, Math.min(86400000, parseInt(process.env.COMPETITION_PLACES_CACHE_TTL_MS || '21600000', 10)));
const COMPETITION_PLACE_DETAILS_CACHE_TTL_MS = Math.max(0, Math.min(86400000, parseInt(process.env.COMPETITION_PLACE_DETAILS_CACHE_TTL_MS || '43200000', 10)));
const COMPETITION_PLACE_PHOTO_CACHE_TTL_MS = Math.max(0, Math.min(86400000, parseInt(process.env.COMPETITION_PLACE_PHOTO_CACHE_TTL_MS || '43200000', 10)));
const COMPETITION_HEATMAP_CACHE_TTL_MS = Math.max(0, Math.min(86400000, parseInt(process.env.COMPETITION_HEATMAP_CACHE_TTL_MS || '21600000', 10)));
const COMPETITION_STATIC_MAP_CACHE_TTL_MS = Math.max(0, Math.min(86400000, parseInt(process.env.COMPETITION_STATIC_MAP_CACHE_TTL_MS || '21600000', 10)));
const COMPETITION_GOOGLE_CONCURRENCY = Math.max(1, Math.min(5, parseInt(process.env.COMPETITION_GOOGLE_CONCURRENCY || '3', 10)));
const COMPETITION_CACHE_VERSION = process.env.COMPETITION_CACHE_VERSION || 'competition-v7-podology-relevance';

const competitionRuntimeCache = new Map();
const competitionInFlight = new Map();

const GOOGLE_COUNTRY_GEO_CRITERIA_IDS = {
  AD: 2020,
  AR: 2032,
  AU: 2036,
  BE: 2056,
  BR: 2076,
  CA: 2124,
  CH: 2756,
  CL: 2152,
  CO: 2170,
  DE: 2276,
  DK: 2208,
  ES: 2724,
  FR: 2250,
  GB: 2826,
  IE: 2372,
  IT: 2380,
  MX: 2484,
  NL: 2528,
  PT: 2620,
  US: 2840
};

const SOCIAL_DISCOVERY_INTERNAL_LINK_HINTS = [
  'contact',
  'contacto',
  'about',
  'sobre',
  'quienes',
  'quien',
  'clinica',
  'equipo',
  'nosotros'
];

const GENERIC_BUSINESS_TOKENS = new Set([
  'clinica',
  'clinic',
  'clinical',
  'centro',
  'center',
  'medical',
  'medica',
  'medico',
  'medicina',
  'grupo',
  'instituto',
  'doctor',
  'doctora',
  'dra',
  'dr',
  'the',
  'and',
  'para',
  'con',
  'de',
  'del',
  'la',
  'las',
  'los',
  'el',
  'en',
  'y'
]);

const PLACE_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.rating',
  'places.userRatingCount',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.types',
  'places.websiteUri',
  'places.nationalPhoneNumber',
  'places.googleMapsUri',
  'places.businessStatus',
  'places.photos'
].join(',');

const PLACE_DETAILS_FIELD_MASK = [
  'id',
  'displayName',
  'formattedAddress',
  'location',
  'rating',
  'userRatingCount',
  'primaryType',
  'primaryTypeDisplayName',
  'types',
  'websiteUri',
  'nationalPhoneNumber',
  'googleMapsUri',
  'businessStatus',
  'photos'
].join(',');

const META_AD_FIELDS = [
  'id',
  'page_id',
  'page_name',
  'ad_creation_time',
  'ad_delivery_start_time',
  'ad_delivery_stop_time',
  'ad_snapshot_url',
  'publisher_platforms',
  'ad_creative_bodies',
  'ad_creative_link_titles',
  'ad_creative_link_descriptions',
  'ad_creative_link_captions',
  'ad_creative_link_urls',
  'ad_reached_countries'
].join(',');

function todayLabel(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function toInt(value) {
  const num = Number.parseInt(value, 10);
  return Number.isFinite(num) ? num : null;
}

function toNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function envFlagEnabled(value, defaultValue = true) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function cleanString(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || null;
}

function stableStringify(value) {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function scopeCacheKey(scope) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.map(toInt).filter(Boolean).sort((a, b) => a - b) : [];
  return stableStringify({
    all: !!scope?.isAll,
    scope: scope?.scope || null,
    groupId: toInt(scope?.groupId),
    clinicIds
  });
}

function cacheKey(parts) {
  return [COMPETITION_CACHE_VERSION, ...parts].map((part) => typeof part === 'string' ? part : stableStringify(part)).join('|');
}

function pruneCompetitionCache(now = Date.now()) {
  if (competitionRuntimeCache.size <= COMPETITION_CACHE_MAX_ENTRIES) return;
  const expired = [];
  for (const [key, entry] of competitionRuntimeCache.entries()) {
    if (!entry || entry.expiresAt <= now) expired.push(key);
  }
  for (const key of expired) competitionRuntimeCache.delete(key);
  if (competitionRuntimeCache.size <= COMPETITION_CACHE_MAX_ENTRIES) return;

  const ordered = [...competitionRuntimeCache.entries()]
    .sort((left, right) => (left[1].lastAccessed || left[1].createdAt || 0) - (right[1].lastAccessed || right[1].createdAt || 0));
  const overflow = competitionRuntimeCache.size - COMPETITION_CACHE_MAX_ENTRIES;
  for (const [key] of ordered.slice(0, overflow)) competitionRuntimeCache.delete(key);
}

async function cachedCompetitionValue(key, ttlMs, loader, options = {}) {
  if (!ttlMs) return loader();
  const cachePredicate = typeof options.cachePredicate === 'function' ? options.cachePredicate : () => true;
  const now = Date.now();
  const current = competitionRuntimeCache.get(key);
  if (current && current.expiresAt > now) {
    current.lastAccessed = now;
    return current.value;
  }
  if (current) competitionRuntimeCache.delete(key);
  if (competitionInFlight.has(key)) return competitionInFlight.get(key);

  const promise = Promise.resolve()
    .then(loader)
    .then((value) => {
      if (cachePredicate(value)) {
        competitionRuntimeCache.set(key, {
          value,
          createdAt: Date.now(),
          lastAccessed: Date.now(),
          expiresAt: Date.now() + ttlMs
        });
        pruneCompetitionCache();
      }
      return value;
    })
    .finally(() => competitionInFlight.delete(key));

  competitionInFlight.set(key, promise);
  return promise;
}

function clearCompetitionRuntimeCache() {
  competitionRuntimeCache.clear();
}

async function mapWithConcurrency(items, concurrency, iteratee) {
  const list = Array.isArray(items) ? items : [];
  const limit = Math.max(1, Math.min(Number(concurrency) || 1, list.length || 1));
  const results = new Array(list.length);
  let index = 0;

  async function worker() {
    while (index < list.length) {
      const currentIndex = index;
      index += 1;
      results[currentIndex] = await iteratee(list[currentIndex], currentIndex);
    }
  }

  await Promise.all(Array.from({ length: limit }, worker));
  return results;
}

function normalizeBusinessName(value) {
  const text = cleanString(value);
  if (!text) return null;
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function businessNameTokens(value) {
  const normalized = normalizeBusinessName(value);
  if (!normalized) return [];
  return normalized
    .split(' ')
    .map(cleanString)
    .filter((token) => token && token.length >= 3 && !GENERIC_BUSINESS_TOKENS.has(token));
}

function sharedBusinessTokens(left, right) {
  const leftTokens = new Set(businessNameTokens(left));
  const rightTokens = new Set(businessNameTokens(right));
  return [...leftTokens].filter((token) => rightTokens.has(token));
}

function normalizePlaceId(value) {
  const text = cleanString(value);
  if (!text) return null;
  return text.replace(/^places\//i, '');
}

function businessNamesMatch(left, right) {
  const a = normalizeBusinessName(left);
  const b = normalizeBusinessName(right);
  if (!a || !b) return false;
  if (a === b) return true;
  const minLength = Math.min(a.length, b.length);
  return minLength >= 6 && (a.includes(b) || b.includes(a));
}

function normalizeUrl(value) {
  const text = cleanString(value);
  if (!text) return null;
  if (/^\/\//.test(text)) return `https:${text}`;
  if (/^https?:\/\//i.test(text)) return text;
  if (/^[a-z][a-z0-9+.-]*:/i.test(text)) return null;
  return `https://${text}`;
}

function domainFromUrl(value) {
  const url = normalizeUrl(value);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    return host || null;
  } catch (_) {
    return null;
  }
}

function removeQueryParams(value, names = []) {
  const url = normalizeUrl(value);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    for (const name of names) parsed.searchParams.delete(name);
    return parsed.toString();
  } catch (_) {
    return url;
  }
}

function metaAdsLibraryPageUrl(pageId, { activeStatus = 'active' } = {}) {
  const id = cleanString(pageId);
  if (!id) return null;
  const params = new URLSearchParams({
    active_status: activeStatus,
    ad_type: 'all',
    country: DEFAULT_COUNTRY,
    is_targeted_country: 'false',
    media_type: 'all',
    search_type: 'page',
    view_all_page_id: id
  });
  return `https://www.facebook.com/ads/library/?${params.toString()}`;
}

function metaAdsLibraryAdUrl(adId) {
  const id = cleanString(adId);
  return id ? `https://www.facebook.com/ads/library/?id=${encodeURIComponent(id)}` : null;
}

function buildGoogleMapsUrl(placeId, query = null) {
  const id = normalizePlaceId(placeId);
  if (!id) return null;
  const text = cleanString(query) || id;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(text)}&query_place_id=${encodeURIComponent(id)}`;
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function extractMetaTagContent(html, keys = []) {
  const wanted = new Set(keys.map((key) => String(key || '').toLowerCase()));
  const tagRegex = /<meta\b[^>]*>/gi;
  let match;
  while ((match = tagRegex.exec(String(html || ''))) !== null) {
    const tag = match[0];
    const attrs = {};
    const attrRegex = /([a-zA-Z_:.-]+)\s*=\s*(['"])(.*?)\2/g;
    let attrMatch;
    while ((attrMatch = attrRegex.exec(tag)) !== null) {
      attrs[attrMatch[1].toLowerCase()] = decodeHtmlEntities(attrMatch[3]);
    }
    const key = String(attrs.property || attrs.name || '').toLowerCase();
    const content = normalizeUrl(attrs.content);
    if (wanted.has(key) && content) return content;
  }
  return null;
}

function decodeEscapedHtml(value) {
  let text = decodeHtmlEntities(value);
  for (let i = 0; i < 2; i += 1) {
    text = text
      .replace(/\\u([0-9a-fA-F]{4})/g, (_, code) => String.fromCharCode(parseInt(code, 16)))
      .replace(/\\\//g, '/')
      .replace(/\\"/g, '"')
      .replace(/\\'/g, "'")
      .replace(/\\&/g, '&');
  }
  return text;
}

function decodePercentEncodedText(value) {
  const text = String(value || '');
  if (!/%[0-9a-f]{2}/i.test(text)) return text;
  try {
    return decodeURIComponent(text);
  } catch (_) {
    return text.replace(/%([0-9a-f]{2})/ig, (_, hex) => {
      try {
        return String.fromCharCode(parseInt(hex, 16));
      } catch (__) {
        return `%${hex}`;
      }
    });
  }
}

function extractAttributeUrl(html, attrName) {
  const attrRegex = new RegExp(`\\b${attrName}\\s*=\\s*(['"])(.*?)\\1`, 'i');
  const match = String(html || '').match(attrRegex);
  const url = normalizeUrl(decodeEscapedHtml(match?.[2] || ''));
  return isUsableSnapshotMediaUrl(url) ? url : null;
}

function isUsableSnapshotMediaUrl(value) {
  const url = normalizeUrl(value);
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'static.xx.fbcdn.net') return false;
    if (host === 'cdn.ampproject.org') return false;
    if (host === 'facebook.com' || host.endsWith('.facebook.com')) return false;
    if (host === 'fonts.gstatic.com') return false;
    if (host === 'gstatic.com' || host === 'www.gstatic.com') return false;
    if (/googlematerialicons|\/gm_.*-48dp\//i.test(parsed.pathname)) return false;
    if (/\/rsrc\.php\//i.test(parsed.pathname)) return false;
    return true;
  } catch (_) {
    return false;
  }
}

function extractFirstUrlByExtension(text, extensions = []) {
  const ext = extensions.map((item) => item.replace(/^\./, '')).join('|');
  if (!ext) return null;
  const regex = new RegExp(`https?:\\/\\/[^"'<>\\s\\\\]+?\\.(?:${ext})(?:\\?[^"'<>\\s\\\\]*)?`, 'ig');
  const matches = String(text || '').match(regex) || [];
  for (const match of matches) {
    const url = normalizeUrl(decodeEscapedHtml(match));
    if (isUsableSnapshotMediaUrl(url)) return url;
  }
  return null;
}

function extractGoogleImageUrls(text) {
  const source = decodeEscapedHtml(text);
  const decodedSource = decodePercentEncodedText(source);
  const patterns = [
    /https?:\/\/tpc\.googlesyndication\.com\/archive\/simgad\/[^"'<>\s\\]+/ig,
    /https?:\/\/i\.ytimg\.com\/vi\/[^"'<>\s\\]+/ig,
    /https?:\/\/lh\d+\.googleusercontent\.com\/[^"'<>\s\\]+/ig,
    /https?:\/\/encrypted-tbn\d*\.gstatic\.com\/[^"'<>\s\\]+/ig,
    /https?:\/\/[^"'<>\s\\]+\.googleusercontent\.com\/[^"'<>\s\\]+(?:\.(?:jpg|jpeg|png|webp|gif)|[?][^"'<>\s\\]*)/ig
  ];
  const urls = [];
  for (const candidateSource of [...new Set([source, decodedSource])]) {
    for (const pattern of patterns) {
      const matches = candidateSource.match(pattern) || [];
      for (const match of matches) {
        const url = normalizeUrl(decodePercentEncodedText(decodeEscapedHtml(match)));
        if (isUsableSnapshotMediaUrl(url) && !urls.includes(url)) urls.push(url);
      }
    }
  }
  return urls;
}

function extractFirstGoogleImageUrl(text) {
  return extractGoogleImageUrls(text)[0] || null;
}

function mediaAssetFromUrl(url, type = 'image', extra = {}) {
  const normalized = normalizeUrl(url);
  if (!isUsableSnapshotMediaUrl(normalized)) return null;
  return {
    type,
    url: normalized,
    thumbnail_url: type === 'image' ? normalized : (extra.thumbnail_url || null),
    ...extra
  };
}

function youtubeUrlFromThumbnail(url) {
  const normalized = normalizeUrl(url);
  const match = normalized?.match(/i\.ytimg\.com\/vi\/([^/?#]+)/i);
  return match?.[1] ? `https://www.youtube.com/watch?v=${encodeURIComponent(match[1])}` : null;
}

function uniqueMediaAssets(assets = []) {
  const output = [];
  const seen = new Set();
  for (const asset of assets) {
    if (!asset?.url) continue;
    const key = `${asset.type || 'image'}:${asset.url}`;
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(asset);
  }
  return output;
}

function extractMediaAssetsFromHtml(html) {
  const text = decodeEscapedHtml(String(html || ''));
  const decodedText = decodePercentEncodedText(text);
  const assets = [];

  const video = extractMetaTagContent(text, [
    'og:video:secure_url',
    'og:video:url',
    'og:video',
    'twitter:player:stream'
  ]);
  const image = extractMetaTagContent(text, [
    'og:image:secure_url',
    'og:image:url',
    'og:image',
    'twitter:image'
  ]);
  if (video) assets.push(mediaAssetFromUrl(video, 'video', { thumbnail_url: image || null }));
  if (image) assets.push(mediaAssetFromUrl(image, 'image'));

  const tagRegex = /<(img|video|source|iframe)\b[^>]*>/ig;
  let tagMatch;
  while ((tagMatch = tagRegex.exec(text)) !== null) {
    const tagName = tagMatch[1].toLowerCase();
    const tag = tagMatch[0];
    const src = extractAttributeUrl(tag, 'src');
    const poster = extractAttributeUrl(tag, 'poster');
    if (tagName === 'video' || tagName === 'source') {
      if (src) assets.push(mediaAssetFromUrl(src, 'video', { thumbnail_url: poster || null }));
      if (poster) assets.push(mediaAssetFromUrl(poster, 'image'));
    } else if (tagName === 'iframe') {
      if (src && /youtube\.com|youtu\.be/i.test(src)) {
        assets.push(mediaAssetFromUrl(src, 'external_video'));
      }
    } else if (src) {
      assets.push(mediaAssetFromUrl(src, 'image'));
    }
  }

  for (const url of [
    ...extractGoogleImageUrls(text),
    ...(String(text || '').match(/https?:\/\/[^"'<>\\s]+?\.(?:mp4|mov|webm)(?:\?[^"'<>\\s]*)?/ig) || []),
    ...(String(decodedText || '').match(/https?:\/\/[^"'<>\\s]+?\.(?:mp4|mov|webm)(?:\?[^"'<>\\s]*)?/ig) || [])
  ]) {
    const normalized = normalizeUrl(decodePercentEncodedText(decodeEscapedHtml(url)));
    if (!normalized) continue;
    const youtubeUrl = youtubeUrlFromThumbnail(normalized);
    if (youtubeUrl) {
      assets.push(mediaAssetFromUrl(normalized, 'external_video', {
        thumbnail_url: normalized,
        external_url: youtubeUrl
      }));
    } else if (/\.(mp4|mov|webm)(?:\?|$)/i.test(normalized)) {
      assets.push(mediaAssetFromUrl(normalized, 'video'));
    } else {
      assets.push(mediaAssetFromUrl(normalized, 'image'));
    }
  }

  return uniqueMediaAssets(assets).filter(Boolean);
}

function extractFirstMediaFromHtml(html) {
  const mediaAssets = extractMediaAssetsFromHtml(html);
  const firstVideo = mediaAssets.find((asset) => asset.type === 'video');
  const firstExternalVideo = mediaAssets.find((asset) => asset.type === 'external_video');
  const firstImage = mediaAssets.find((asset) => asset.type === 'image');
  if (firstVideo || firstExternalVideo || firstImage) {
    return {
      video_url: firstVideo?.url || null,
      external_video_url: firstExternalVideo?.external_url || firstExternalVideo?.url || null,
      image_url: firstImage?.url || firstExternalVideo?.thumbnail_url || firstVideo?.thumbnail_url || null,
      thumbnail_url: firstImage?.url || firstExternalVideo?.thumbnail_url || firstVideo?.thumbnail_url || null,
      media_assets: mediaAssets
    };
  }

  const text = decodeEscapedHtml(String(html || ''));
  const attrVideo = extractAttributeUrl(text.match(/<(?:video|source)\b[^>]*>/i)?.[0] || '', 'src');
  const anyVideo = attrVideo
    || extractFirstUrlByExtension(text, ['mp4', 'mov', 'webm'])
    || normalizeUrl(cleanString(text.match(/"(?:playable_url|browser_native_sd_url|browser_native_hd_url|video_url)"\s*:\s*"([^"]+)"/i)?.[1]));

  const attrPoster = extractAttributeUrl(text.match(/<video\b[^>]*>/i)?.[0] || '', 'poster');
  const attrImage = extractAttributeUrl(text.match(/<img\b[^>]*>/i)?.[0] || '', 'src');
  const anyImage = attrPoster
    || attrImage
    || extractFirstUrlByExtension(text, ['jpg', 'jpeg', 'png', 'webp'])
    || extractFirstGoogleImageUrl(text)
    || normalizeUrl(cleanString(text.match(/"(?:image_url|thumbnail_url|poster)"\s*:\s*"([^"]+)"/i)?.[1]));

  if (anyVideo || anyImage) {
    return {
      video_url: anyVideo || null,
      image_url: anyImage || null,
      thumbnail_url: anyImage || null,
      media_assets: uniqueMediaAssets([
        anyVideo ? mediaAssetFromUrl(anyVideo, 'video', { thumbnail_url: anyImage || null }) : null,
        anyImage ? mediaAssetFromUrl(anyImage, 'image') : null
      ]).filter(Boolean)
    };
  }
  return null;
}

function absolutizeUrl(value, baseUrl = null) {
  const text = cleanString(decodeHtmlEntities(value));
  if (!text) return null;
  try {
    if (baseUrl) return normalizeUrl(new URL(text, baseUrl).toString());
    return normalizeUrl(text);
  } catch (_) {
    return normalizeUrl(text);
  }
}

function normalizeSocialProfileUrl(value, baseUrl = null) {
  const url = absolutizeUrl(value, baseUrl);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'fb.com') parsed.hostname = 'facebook.com';
    const normalizedHost = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (!['facebook.com', 'instagram.com'].includes(normalizedHost)) return null;

    const path = parsed.pathname.replace(/\/+$/g, '');
    const ignored = [
      '/share',
      '/sharer',
      '/dialog',
      '/plugins',
      '/privacy',
      '/legal',
      '/explore',
      '/accounts',
      '/p',
      '/reel',
      '/stories',
      '/ads',
      '/ads/library'
    ];
    if (!path || path === '/' || ignored.some((prefix) => path.toLowerCase().startsWith(prefix))) return null;
    parsed.hash = '';
    parsed.search = '';
    return parsed.toString().replace(/\/$/g, '');
  } catch (_) {
    return null;
  }
}

function usernameFromSocialUrl(value, platform) {
  const url = normalizeSocialProfileUrl(value);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./i, '').toLowerCase();
    if (platform === 'instagram' && host !== 'instagram.com') return null;
    if (platform === 'facebook' && host !== 'facebook.com') return null;
    const first = parsed.pathname.split('/').map(cleanString).filter(Boolean)[0];
    return first || null;
  } catch (_) {
    return null;
  }
}

function socialUrlFromUsername(value, platform) {
  const text = cleanString(value);
  if (!text) return null;
  if (/^https?:\/\//i.test(text)) return normalizeSocialProfileUrl(text);
  const username = text.replace(/^@/, '').replace(/^\/+/, '').split(/[/?#]/)[0];
  if (!username) return null;
  if (platform === 'instagram') return `https://www.instagram.com/${username}`;
  if (platform === 'facebook') return `https://www.facebook.com/${username}`;
  return null;
}

function extractSocialProfilesFromHtml(html, baseUrl) {
  const profiles = {};
  const text = String(html || '');
  const hrefRegex = /\bhref\s*=\s*(['"])(.*?)\1/gi;
  let match;
  while ((match = hrefRegex.exec(text)) !== null) {
    const url = normalizeSocialProfileUrl(match[2], baseUrl);
    if (!url) continue;
    const host = new URL(url).hostname.replace(/^www\./i, '').toLowerCase();
    if (host === 'instagram.com' && !profiles.instagram_url) profiles.instagram_url = url;
    if (host === 'facebook.com' && !profiles.facebook_url) profiles.facebook_url = url;
    if (profiles.instagram_url && profiles.facebook_url) break;
  }

  if (profiles.instagram_url) profiles.instagram_username = usernameFromSocialUrl(profiles.instagram_url, 'instagram');
  if (profiles.facebook_url) profiles.facebook_username = usernameFromSocialUrl(profiles.facebook_url, 'facebook');
  return profiles;
}

function extractCandidateInternalLinks(html, baseUrl) {
  const base = normalizeUrl(baseUrl);
  if (!base) return [];
  const urls = [];
  try {
    const baseParsed = new URL(base);
    const hrefRegex = /\bhref\s*=\s*(['"])(.*?)\1/gi;
    let match;
    while ((match = hrefRegex.exec(String(html || ''))) !== null) {
      const url = absolutizeUrl(match[2], base);
      if (!url) continue;
      const parsed = new URL(url);
      if (parsed.hostname.replace(/^www\./i, '').toLowerCase() !== baseParsed.hostname.replace(/^www\./i, '').toLowerCase()) continue;
      parsed.hash = '';
      parsed.search = '';
      const normalized = parsed.toString().replace(/\/$/g, '');
      const path = normalizeBusinessName(parsed.pathname);
      if (!path || !SOCIAL_DISCOVERY_INTERNAL_LINK_HINTS.some((hint) => path.includes(hint))) continue;
      if (!urls.includes(normalized)) urls.push(normalized);
      if (urls.length >= SOCIAL_DISCOVERY_PAGE_LIMIT - 1) break;
    }
  } catch (_) {
    return [];
  }
  return urls;
}

function extractSocialProfilesFromObject(value, seen = new Set()) {
  if (!value) return null;
  if (typeof value === 'string') {
    const direct = buildSocialProfilesFromPayload({ website_url: value, facebook_url: value, instagram_url: value });
    if (Object.keys(direct).length) return direct;
    const profiles = {};
    const urlRegex = /https?:\/\/[^\s"'<>]+/gi;
    let match;
    while ((match = urlRegex.exec(value)) !== null) {
      const profile = buildSocialProfilesFromPayload({ website_url: match[0], facebook_url: match[0], instagram_url: match[0] });
      Object.assign(profiles, mergeSocialProfiles(profiles, profile) || {});
      if (profiles.instagram_url && profiles.facebook_url) break;
    }
    return Object.keys(profiles).length ? profiles : null;
  }
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);

  let profiles = null;
  if (Array.isArray(value)) {
    for (const item of value) {
      profiles = mergeSocialProfiles(profiles, extractSocialProfilesFromObject(item, seen));
      if (profiles?.instagram_url && profiles?.facebook_url) break;
    }
    return profiles;
  }

  profiles = mergeSocialProfiles(profiles, buildSocialProfilesFromPayload(value));
  for (const item of Object.values(value)) {
    profiles = mergeSocialProfiles(profiles, extractSocialProfilesFromObject(item, seen));
    if (profiles?.instagram_url && profiles?.facebook_url) break;
  }
  return profiles;
}

function socialProfilesFromPayload(payload = {}) {
  return payload?.clinicaclick_social_profiles || payload?.manual?.social_profiles || null;
}

function mergeSocialProfiles(left = null, right = null) {
  const result = {};
  for (const source of [left, right]) {
    if (!source || typeof source !== 'object') continue;
    for (const field of [
      'instagram_url',
      'instagram_username',
      'instagram_followers_count',
      'facebook_url',
      'facebook_username',
      'facebook_followers_count',
      'followers_count',
      'source',
      'checked_at',
      'error'
    ]) {
      if (source[field] && !result[field]) result[field] = source[field];
    }
  }
  return Object.keys(result).length ? result : null;
}

function buildSocialProfilesFromPayload(payload = {}) {
  const websiteSocialUrl = normalizeSocialProfileUrl(payload.website_url);
  const websiteHost = websiteSocialUrl ? new URL(websiteSocialUrl).hostname.replace(/^www\./i, '').toLowerCase() : null;
  const instagramUrl = normalizeSocialProfileUrl(payload.instagram_url)
    || (websiteHost === 'instagram.com' ? websiteSocialUrl : null)
    || socialUrlFromUsername(payload.instagram_username, 'instagram');
  const facebookUrl = normalizeSocialProfileUrl(payload.facebook_url)
    || (websiteHost === 'facebook.com' ? websiteSocialUrl : null)
    || socialUrlFromUsername(payload.facebook_username, 'facebook');
  const profiles = {
    instagram_url: instagramUrl,
    instagram_username: cleanString(payload.instagram_username) || usernameFromSocialUrl(instagramUrl, 'instagram'),
    facebook_url: facebookUrl,
    facebook_username: cleanString(payload.facebook_username) || usernameFromSocialUrl(facebookUrl, 'facebook'),
    source: instagramUrl || facebookUrl ? 'manual' : null,
    checked_at: instagramUrl || facebookUrl ? new Date().toISOString() : null
  };
  return Object.fromEntries(Object.entries(profiles).filter(([, value]) => !!value));
}

async function enrichSocialProfilesWithMetaPublicMetrics(profiles, pageId, accessToken) {
  const normalizedPageId = cleanString(pageId);
  if (!profiles || !normalizedPageId || !accessToken) return profiles;

  try {
    const response = await metaGet(encodeURIComponent(normalizedPageId), {
      params: { fields: 'id,name,link,fan_count,followers_count' },
      accessToken,
      timeout: 12000
    });
    const facebookFollowers = toInt(response.data?.followers_count) || toInt(response.data?.fan_count);
    if (!facebookFollowers) return profiles;
    return mergeSocialProfiles(profiles, {
      facebook_followers_count: facebookFollowers,
      followers_count: Math.max(toInt(profiles.followers_count) || 0, facebookFollowers),
      source: profiles.source || 'meta_public_page',
      checked_at: new Date().toISOString()
    });
  } catch (error) {
    const message = error?.response?.data?.error?.message || error?.message || 'meta_public_metrics_unavailable';
    return mergeSocialProfiles(profiles, {
      source: profiles.source || 'meta_public_page',
      checked_at: new Date().toISOString(),
      error: cleanString(message)
    });
  }
}

function withSocialProfilesInRawPayload(rawPayload, profiles) {
  if (!profiles || !Object.keys(profiles).length) return rawPayload || null;
  const base = rawPayload && typeof rawPayload === 'object' && !Array.isArray(rawPayload) ? rawPayload : {};
  return {
    ...base,
    clinicaclick_social_profiles: mergeSocialProfiles(socialProfilesFromPayload(base), profiles)
  };
}

function metaTermsFromCompetitor(competitor, socialProfiles = null) {
  const terms = [
    ...(Array.isArray(competitor?.meta_ads_search_terms) ? competitor.meta_ads_search_terms : []),
    competitor?.name,
    socialProfiles?.instagram_username ? `@${socialProfiles.instagram_username}` : null,
    socialProfiles?.instagram_username,
    socialProfiles?.facebook_username,
  ];
  return [...new Set(terms.map(cleanString).filter(Boolean))].slice(0, 8);
}

async function discoverSocialProfiles(competitor, candidate = {}) {
  const existing = socialProfilesFromPayload(competitor?.raw_place_payload);
  const manual = buildSocialProfilesFromPayload(candidate);
  const rawProfiles = mergeSocialProfiles(
    extractSocialProfilesFromObject(candidate.raw_place_payload),
    extractSocialProfilesFromObject(competitor?.raw_place_payload)
  );
  let profiles = mergeSocialProfiles(mergeSocialProfiles(existing, manual), rawProfiles);
  if (profiles?.instagram_url && profiles?.facebook_url) return profiles;

  const websiteUrl = normalizeUrl(candidate.website_url) || normalizeUrl(competitor?.website_url);
  if (!websiteUrl) return profiles;

  const pagesToCheck = [websiteUrl];
  const errors = [];
  try {
    for (let index = 0; index < pagesToCheck.length && index < SOCIAL_DISCOVERY_PAGE_LIMIT; index += 1) {
      const pageUrl = pagesToCheck[index];
      try {
        const response = await axios.get(pageUrl, {
          timeout: SOCIAL_DISCOVERY_TIMEOUT_MS,
          maxContentLength: 1024 * 1024,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; ClinicaClickBot/1.0; +https://clinicaclick.com)',
            'Accept': 'text/html,application/xhtml+xml'
          }
        });
        const discovered = extractSocialProfilesFromHtml(response.data, pageUrl);
        profiles = mergeSocialProfiles(profiles, {
          ...discovered,
          source: Object.keys(discovered).length ? (index === 0 ? 'website_homepage' : 'website_internal_page') : null,
          checked_at: new Date().toISOString()
        });
        if (profiles?.instagram_url && profiles?.facebook_url) return profiles;
        if (index === 0) {
          for (const link of extractCandidateInternalLinks(response.data, pageUrl)) {
            if (!pagesToCheck.includes(link)) pagesToCheck.push(link);
            if (pagesToCheck.length >= SOCIAL_DISCOVERY_PAGE_LIMIT) break;
          }
        }
      } catch (error) {
        errors.push(error?.response?.status ? `HTTP ${error.response.status}` : (error?.code || error?.message || 'social_discovery_failed'));
      }
    }
    return mergeSocialProfiles(profiles, errors.length && !profiles ? {
      source: 'website_pages',
      checked_at: new Date().toISOString(),
      error: errors.slice(0, 2).join('; ')
    } : null);
  } catch (error) {
    return mergeSocialProfiles(profiles, {
      source: 'website_pages',
      checked_at: new Date().toISOString(),
      error: error?.response?.status ? `HTTP ${error.response.status}` : (error?.code || error?.message || 'social_discovery_failed')
    });
  }
}

function splitSearchTerms(value) {
  const source = Array.isArray(value) ? value : String(value || '').split(/[,\n;]/);
  return source.map(cleanString).filter(Boolean);
}

function extractPhotoNames(place = {}) {
  const photos = Array.isArray(place?.photos) ? place.photos : [];
  return photos
    .map((photo) => cleanString(photo?.name || photo))
    .filter(Boolean);
}

async function resolvePlacePhotoUrl(photoName, { maxWidthPx = 640 } = {}) {
  const resourceName = cleanString(photoName);
  if (!resourceName) return null;
  return cachedCompetitionValue(cacheKey(['places-photo', resourceName, maxWidthPx]), COMPETITION_PLACE_PHOTO_CACHE_TTL_MS, async () => {
    try {
      const response = await axios.get(`${GOOGLE_PLACES_API_BASE}/${resourceName.replace(/\/media$/i, '')}/media`, {
        headers: {
          'X-Goog-Api-Key': getGooglePlacesApiKey()
        },
        params: {
          maxWidthPx,
          skipHttpRedirect: true
        },
        timeout: 10000
      });
      return normalizeUrl(response.data?.photoUri);
    } catch (_) {
      return null;
    }
  });
}

async function attachPlacePhotoUrl(item, { maxWidthPx = 640 } = {}) {
  const photoName = cleanString(item?.photo_name) || (Array.isArray(item?.photo_names) ? item.photo_names[0] : null);
  if (!photoName) return item;
  const photoUrl = await resolvePlacePhotoUrl(photoName, { maxWidthPx });
  return {
    ...item,
    photo_url: photoUrl || null
  };
}

function providerStatus({ googleError = null, metaError = null, metaTokenSource = null } = {}) {
  const googleKey = getGooglePlacesApiKey();
  const metaToken = getMetaAdLibraryTokenFromEnv();
  const googleAdsTransparencyEnabled = isGoogleAdsTransparencyEnabled();
  return {
    google_places: {
      provider: 'google_places',
      available: !!googleKey && !googleError,
      configured: !!googleKey,
      error: googleError ? normalizeExternalError(googleError) : null,
      required_env: 'GOOGLE_PLACES_API_KEY',
      fallback_env: ['GOOGLE_MAPS_API_KEY', 'GOOGLE_API_KEY']
    },
    meta_ads_library: {
      provider: META_ADS_LIBRARY_PROVIDER,
      available: (!!metaToken || !!metaTokenSource) && !metaError,
      configured: !!metaToken || !!metaTokenSource,
      token_source: metaToken ? 'env' : (metaTokenSource || null),
      error: metaError ? normalizeExternalError(metaError) : null,
      required_env: 'META_AD_LIBRARY_ACCESS_TOKEN',
      fallback_env: ['META_GRAPH_TOKEN'],
      note: 'Se usa Meta Ads Library oficial y, si existe snapshot público, se intenta extraer una previsualización visual best-effort. Si no hay media, la UI muestra enlace a Meta.'
    },
    google_ads_transparency: {
      provider: GOOGLE_ADS_TRANSPARENCY_PROVIDER,
      available: googleAdsTransparencyEnabled,
      configured: googleAdsTransparencyEnabled,
      error: null,
      optional_env: 'COMPETITION_GOOGLE_ADS_TRANSPARENCY_ENABLED=false',
      note: 'Se consulta el Ads Transparency Center público de Google mediante RPC asíncrono y limitado. No se ejecuta navegador ni se bloquea la carga del informe.'
    }
  };
}

async function providerStatusForScope(scope, options = {}) {
  const hasErrorContext = !!options.googleError || !!options.metaError;
  const loader = async () => {
    let metaTokenSource = null;
    try {
      const resolved = await resolveMetaAdLibraryToken(scope);
      metaTokenSource = resolved?.accessToken ? resolved.source : null;
    } catch (_) {
      metaTokenSource = null;
    }
    return providerStatus({ ...options, metaTokenSource });
  };
  if (hasErrorContext) return loader();
  return cachedCompetitionValue(
    cacheKey(['provider-status', scopeCacheKey(scope)]),
    COMPETITION_PROVIDER_CACHE_TTL_MS,
    loader
  );
}

function getGooglePlacesApiKey() {
  return process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY || null;
}

function staticMapZoomForRadius(radiusKm) {
  const radius = Number(radiusKm) || 3;
  if (radius <= 1) return 15;
  if (radius <= 3) return 14;
  return 13;
}

async function buildLocalHeatmapStaticMap(center, points = [], radiusKm = 3) {
  const apiKey = getGooglePlacesApiKey();
  if (!apiKey || !center?.latitude || !center?.longitude) {
    return { dataUrl: null, error: { code: 'STATIC_MAP_NOT_CONFIGURED', message: 'Maps Static API no está configurada para este entorno.' } };
  }
  return cachedCompetitionValue(cacheKey(['static-map-background', center.latitude, center.longitude, radiusKm]), COMPETITION_STATIC_MAP_CACHE_TTL_MS, async () => {
    try {
      const params = new URLSearchParams({
        center: `${center.latitude},${center.longitude}`,
        zoom: String(staticMapZoomForRadius(radiusKm)),
        size: '640x420',
        scale: '2',
        maptype: 'roadmap',
        language: DEFAULT_LANGUAGE,
        region: DEFAULT_REGION,
        key: apiKey
      });
      const response = await axios.get(`https://maps.googleapis.com/maps/api/staticmap?${params.toString()}`, {
        responseType: 'arraybuffer',
        timeout: 12000,
        maxContentLength: 1024 * 1024,
        validateStatus: () => true
      });
      const contentType = response.headers?.['content-type'] || 'image/png';
      if (response.status >= 400 || !String(contentType).startsWith('image/')) {
        return {
          dataUrl: null,
          error: {
            code: `STATIC_MAP_HTTP_${response.status}`,
            message: 'Google Static Maps no ha devuelto una imagen válida.',
            status: response.status
          }
        };
      }
      return {
        dataUrl: `data:${contentType};base64,${Buffer.from(response.data).toString('base64')}`,
        error: null
      };
    } catch (error) {
      const normalized = normalizeExternalError(error);
      return {
        dataUrl: null,
        error: {
          code: normalized.code || 'STATIC_MAP_ERROR',
          message: normalized.message || 'No se pudo generar el mapa estático.',
          status: normalized.status || null
        }
      };
    }
  }, {
    cachePredicate: (value) => !!value?.dataUrl
  });
}

function getMetaAdLibraryTokenFromEnv() {
  return process.env.META_AD_LIBRARY_ACCESS_TOKEN || process.env.META_GRAPH_TOKEN || null;
}

function extractMetaPageIdFromUrl(value) {
  const url = normalizeUrl(value);
  if (!url) return null;
  try {
    const parsed = new URL(url);
    const queryId = parsed.searchParams.get('view_all_page_id')
      || parsed.searchParams.get('search_page_ids')
      || parsed.searchParams.get('page_id')
      || parsed.searchParams.get('id');
    const cleanQueryId = cleanString(queryId)?.match(/\d{5,}/)?.[0] || null;
    if (cleanQueryId) return cleanQueryId;
    const pathId = parsed.pathname.match(/(?:\/profile\.php).*?[?&]id=(\d{5,})/)?.[1]
      || parsed.pathname.match(/\/(\d{5,})(?:\/|$)/)?.[1]
      || parsed.pathname.match(/-(\d{5,})(?:\/|$)/)?.[1]
      || null;
    return pathId || null;
  } catch (_) {
    return null;
  }
}

function normalizeExternalError(error) {
  const data = error?.response?.data || null;
  const meta = data?.error || null;
  return {
    code: meta?.code || data?.error?.status || error?.code || 'provider_error',
    subcode: meta?.error_subcode || null,
    message: meta?.message || data?.error?.message || data?.error_message || error?.message || 'Proveedor no disponible',
    details: meta?.error_data?.details || data?.error?.details || null,
    status: error?.response?.status || null,
    fbtrace_id: meta?.fbtrace_id || null
  };
}

function normalizePlace(place = {}) {
  const displayName = place.displayName?.text || place.displayName || null;
  const primaryCategory = place.primaryTypeDisplayName?.text || place.primaryTypeDisplayName || place.primaryType || null;
  const location = place.location || {};
  const photoNames = extractPhotoNames(place);
  return {
    source: 'google_places',
    name: cleanString(displayName) || 'Competidor sin nombre',
    google_place_id: cleanString(place.id),
    google_maps_url: normalizeUrl(place.googleMapsUri) || buildGoogleMapsUrl(place.id, displayName),
    website_url: normalizeUrl(place.websiteUri),
    phone: cleanString(place.nationalPhoneNumber),
    address: cleanString(place.formattedAddress),
    city: null,
    latitude: toNumber(location.latitude),
    longitude: toNumber(location.longitude),
    primary_category: cleanString(primaryCategory),
    rating: toNumber(place.rating),
    review_count: toInt(place.userRatingCount),
    business_status: cleanString(place.businessStatus),
    photo_name: photoNames[0] || null,
    photo_names: photoNames,
    raw_place_payload: place
  };
}

function buildCompetitorWhere(scope, { includeInactive = false } = {}) {
  const where = {};
  if (!includeInactive) where.is_active = true;

  if (scope?.isAll) return where;

  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.map(toInt).filter(Boolean) : [];
  const groupId = toInt(scope?.groupId);

  if (scope?.scope === 'group' && groupId) {
    const clauses = [{ grupo_clinica_id: groupId }];
    if (clinicIds.length) clauses.push({ clinica_id: { [Op.in]: clinicIds } });
    return { ...where, [Op.or]: clauses };
  }

  if (clinicIds.length === 1) return { ...where, clinica_id: clinicIds[0] };
  if (clinicIds.length > 1) return { ...where, clinica_id: { [Op.in]: clinicIds } };
  return { ...where, id: { [Op.in]: [] } };
}

function buildAssetScopeWhere(scope) {
  if (scope?.isAll) return {};
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.map(toInt).filter(Boolean) : [];
  const groupId = toInt(scope?.groupId);
  if (scope?.scope === 'group' && groupId) {
    const clauses = [{ grupoClinicaId: groupId }];
    if (clinicIds.length) clauses.push({ clinicaId: { [Op.in]: clinicIds } });
    return { [Op.or]: clauses };
  }
  if (clinicIds.length === 1) return { clinicaId: clinicIds[0] };
  if (clinicIds.length > 1) return { clinicaId: { [Op.in]: clinicIds } };
  return {};
}

async function resolvePrimaryClinic(scope) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.map(toInt).filter(Boolean) : [];
  const clinicId = clinicIds.length === 1 ? clinicIds[0] : null;
  if (!clinicId) return null;
  const clinic = await Clinica.findByPk(clinicId, {
    attributes: [
      'id_clinica',
      'nombre_clinica',
      'direccion',
      'codigo_postal',
      'ciudad',
      'provincia',
      'pais',
      'servicios',
      'descripcion',
      'url_web',
      'url_ficha_local',
      'configuracion'
    ],
    raw: true
  });
  if (!clinic || !ClinicBusinessLocation) return clinic;

  const businessLocation = await ClinicBusinessLocation.findOne({
    where: { clinica_id: clinicId, is_active: true },
    attributes: ['location_name', 'location_id', 'primary_category', 'sync_status', 'raw_payload'],
    order: [['last_synced_at', 'DESC'], ['updated_at', 'DESC']],
    raw: true
  });

  return {
    ...clinic,
    business_location_name: businessLocation?.location_name || null,
    business_location_id: businessLocation?.location_id || null,
    business_primary_category: businessLocation?.primary_category || null,
    business_sync_status: businessLocation?.sync_status || null,
    business_place_id: normalizePlaceId(businessLocation?.raw_payload?.metadata?.placeId)
      || normalizePlaceId(businessLocation?.raw_payload?.placeId)
      || null
  };
}

function competitionServiceHint(clinic) {
  return disciplineSearchHint(clinic)
    || cleanString(clinic?.servicios)
    || cleanString(clinic?.descripcion)?.split(/[.,;]/)[0]
    || cleanString(clinic?.business_primary_category)
    || null;
}

function clinicLocationLabel(clinic) {
  const parts = [clinic?.ciudad, clinic?.provincia, clinic?.codigo_postal]
    .map(cleanString)
    .filter(Boolean);
  return parts.length ? parts.join(', ') : cleanString(clinic?.direccion);
}

function rankingTermsForClinic(clinic, limit = DEFAULT_RANKING_LIMIT) {
  const serviceHint = competitionServiceHint(clinic);
  const city = cleanString(clinic?.ciudad) || cleanString(clinic?.provincia);
  if (!serviceHint || !city) return [];

  const disciplineKeys = Array.isArray(clinic?.configuracion?.disciplinas)
    ? clinic.configuracion.disciplinas.map((item) => String(item || '').toLowerCase())
    : [];
  let baseTerms = [serviceHint];

  if (disciplineKeys.some((item) => ['capilar', 'medicina_capilar', 'trasplante_capilar'].includes(item))) {
    baseTerms = ['clínica capilar', 'injerto capilar', 'trasplante capilar', 'tratamiento capilar'];
  } else if (disciplineKeys.includes('podologia')) {
    baseTerms = ['podólogo', 'clínica podológica', 'podología', 'podólogo uñas encarnadas'];
  } else if (disciplineKeys.some((item) => ['dental', 'odontologia'].includes(item))) {
    baseTerms = ['clínica dental', 'dentista', 'implantes dentales', 'ortodoncia'];
  }

  return [...new Set(baseTerms.map((term) => `${term} en ${city}`))].slice(0, limit);
}

function competitionSetupBlocker(clinic, explicitQuery = null) {
  const hasLocalProfileAnchor = !!(
    cleanString(clinic?.url_ficha_local)
    || (
      cleanString(clinic?.business_primary_category)
      && (
        cleanString(clinic?.business_place_id)
        || cleanString(clinic?.business_location_id)
        || cleanString(clinic?.business_location_name)
      )
    )
  );

  if (!hasLocalProfileAnchor) {
    return {
      code: 'LOCAL_PROFILE_REQUIRED',
      action: 'connect_google_business_profile',
      message: 'Conecta la ficha local de Google de esta clínica o añade su URL de ficha local antes de buscar competidores. Así evitamos sugerencias genéricas que no correspondan a su especialidad.'
    };
  }

  if (!cleanString(explicitQuery) && !competitionServiceHint(clinic)) {
    return {
      code: 'LOCAL_CATEGORY_REQUIRED',
      action: 'complete_clinic_medical_area',
      message: 'Completa la categoría/especialidad de la clínica antes de buscar competidores. No usamos una búsqueda genérica de clínica médica porque genera ruido.'
    };
  }

  return null;
}

function buildSetupRequiredPayload(scope, clinic, blocker, query = null) {
  return {
    success: false,
    query: cleanString(query),
    clinic: clinic ? { id: clinic.id_clinica, name: clinic.nombre_clinica } : null,
    provider_status: null,
    suggestions: [],
    setup_required: true,
    setup_code: blocker.code,
    setup_action: blocker.action,
    error: {
      code: blocker.code,
      message: blocker.message
    },
    scope_hint: {
      type: scope?.scope || null,
      clinicIds: scope?.clinicIds || []
    }
  };
}

function clinicSpecialtyText(clinic) {
  const config = clinic?.configuracion && typeof clinic.configuracion === 'object' ? clinic.configuracion : {};
  return normalizeBusinessName([
    clinic?.nombre_clinica,
    clinic?.servicios,
    clinic?.descripcion,
    clinic?.business_location_name,
    clinic?.business_primary_category,
    config.area_medica,
    config.disciplina,
    ...(Array.isArray(config.disciplinas) ? config.disciplinas : [])
  ].map(cleanString).filter(Boolean).join(' '));
}

function specialtyHintFromText(value) {
  const text = normalizeBusinessName(value);
  if (!text) return null;
  if (/(^| )(capilar|alopecia|injerto capilar|trasplante capilar|pelo|hair)( |$)/.test(text)) return 'clínica capilar';
  if (/(^| )(hepatobiliar|pancreat|laparoscop|cirugia digestiva|cirujano digestivo|digestiv)( |$)/.test(text)) return 'cirujano hepatobiliar';
  if (/(^| )(podolog|podologo|podologa|podologia|pies|pie)( |$)/.test(text)) return 'podólogo';
  if (/(^| )(dental|dentista|odontolog|ortodoncia|implante dental)( |$)/.test(text)) return 'clínica dental';
  return null;
}

function disciplineSearchHint(clinic) {
  const localProfileHint = specialtyHintFromText([
    clinic?.business_primary_category,
    clinic?.business_location_name
  ].map(cleanString).filter(Boolean).join(' '));
  if (localProfileHint) return localProfileHint;

  const disciplinas = Array.isArray(clinic?.configuracion?.disciplinas)
    ? clinic.configuracion.disciplinas
    : [];
  const map = {
    dental: 'clínica dental',
    odontologia: 'clínica dental',
    podologia: 'podólogo',
    estetica: 'clínica estética',
    fisioterapia: 'fisioterapia',
    medicina_estetica: 'medicina estética',
    dermatologia: 'dermatólogo',
    oftalmologia: 'oftalmólogo',
    capilar: 'clínica capilar',
    medicina_capilar: 'clínica capilar',
    trasplante_capilar: 'trasplante capilar',
    cirugia_digestiva: 'cirujano hepatobiliar',
    cirugia_hepatobiliar: 'cirujano hepatobiliar',
    hepatobiliar: 'cirujano hepatobiliar'
  };
  const match = disciplinas.map((item) => map[String(item || '').toLowerCase()]).find(Boolean);
  if (match) return match;

  return specialtyHintFromText(clinicSpecialtyText(clinic));
}

function inferCompetitionQuery(clinic, explicitQuery = null) {
  const query = cleanString(explicitQuery);
  if (query) return query;

  const serviceHint = competitionServiceHint(clinic);
  const locationParts = [clinic?.ciudad, clinic?.provincia, clinic?.codigo_postal]
    .map(cleanString)
    .filter(Boolean);
  const address = locationParts.length ? locationParts.join(', ') : cleanString(clinic?.direccion);
  if (address) return `${serviceHint} en ${address}`;
  return serviceHint;
}

async function resolveOwnClinicProfile(clinic) {
  if (!clinic) return null;

  const ownPlaceId = normalizePlaceId(clinic.business_place_id);
  if (ownPlaceId) {
    try {
      const details = await getGooglePlaceDetails(ownPlaceId);
      return attachPlacePhotoUrl(normalizePlace(details), { maxWidthPx: 640 });
    } catch (_) {
      // Si el place_id almacenado falla, intentamos localizar por nombre.
    }
  }

  const query = [clinic.nombre_clinica, clinicLocationLabel(clinic)].map(cleanString).filter(Boolean).join(' ');
  if (!query) return null;

  try {
    const places = await searchGooglePlaces({ query, maxResultCount: 5 });
    const normalized = places.map(normalizePlace);
    const ownName = cleanString(clinic.business_location_name) || cleanString(clinic.nombre_clinica);
    const match = normalized.find((place) => businessNamesMatch(place.name, ownName)) || normalized[0] || null;
    return match ? attachPlacePhotoUrl(match, { maxWidthPx: 640 }) : null;
  } catch (_) {
    return null;
  }
}

async function buildLocalRanking(clinic, ownProfile) {
  const terms = rankingTermsForClinic(clinic);
  if (!terms.length) return { terms: [], entries: [] };

  const ownPlaceId = normalizePlaceId(ownProfile?.google_place_id || clinic?.business_place_id);
  const ownName = cleanString(ownProfile?.name) || cleanString(clinic?.business_location_name) || cleanString(clinic?.nombre_clinica);
  const location = clinicLocationLabel(clinic);

  const entries = await mapWithConcurrency(terms, COMPETITION_GOOGLE_CONCURRENCY, async (term) => {
    try {
      const places = await searchGooglePlaces({ query: term, maxResultCount: 10 });
      const normalized = places.map(normalizePlace).filter((place) => place.name);
      const ownIndex = normalized.findIndex((place) => {
        const placeId = normalizePlaceId(place.google_place_id);
        return (ownPlaceId && placeId === ownPlaceId) || businessNamesMatch(place.name, ownName);
      });

      return {
        term,
        myPosition: ownIndex >= 0 ? ownIndex + 1 : null,
        aboveMe: ownIndex > 0 ? normalized.slice(0, ownIndex).map((place) => place.name).slice(0, 5) : [],
        belowMe: ownIndex >= 0
          ? normalized.slice(ownIndex + 1, ownIndex + 6).map((place) => place.name)
          : [],
        visibleResults: ownIndex < 0 ? normalized.slice(0, 5).map((place) => place.name) : [],
        lastMeasured: new Date().toISOString(),
        location,
        source: 'google_places_text_search'
      };
    } catch (error) {
      return {
        term,
        myPosition: null,
        aboveMe: [],
        belowMe: [],
        lastMeasured: new Date().toISOString(),
        location,
        error: normalizeExternalError(error),
        source: 'google_places_text_search'
      };
    }
  });

  return { terms, entries };
}

function clampHeatmapZoom(value) {
  const parsed = Number(value);
  if (parsed === 1 || parsed === 3 || parsed === 5) return parsed;
  return 3;
}

function rankingHeatmapOffsets(radiusKm) {
  const size = LOCAL_HEATMAP_GRID_SIZE % 2 === 0 ? LOCAL_HEATMAP_GRID_SIZE - 1 : LOCAL_HEATMAP_GRID_SIZE;
  const half = Math.floor(size / 2);
  const step = half > 0 ? radiusKm / half : 0;
  const offsets = [];
  for (let y = half; y >= -half; y -= 1) {
    for (let x = -half; x <= half; x += 1) {
      offsets.push({ xKm: x * step, yKm: y * step });
    }
  }
  return offsets.slice(0, LOCAL_HEATMAP_MAX_POINTS);
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function heatmapSearchTermForClinic(term, clinic) {
  const raw = cleanString(term) || competitionServiceHint(clinic);
  if (!raw) return null;

  const normalizedRaw = normalizeBusinessName(raw);
  const normalizedLocations = [
    clinic?.ciudad,
    clinic?.provincia,
    clinic?.codigo_postal,
    clinic?.pais
  ].map(normalizeBusinessName).filter(Boolean);

  let stripped = raw;
  const normalizedAfterEn = normalizedRaw?.includes(' en ')
    ? normalizedRaw.slice(normalizedRaw.lastIndexOf(' en ') + 4)
    : null;
  if (normalizedAfterEn && normalizedLocations.some((location) => normalizedAfterEn.includes(location))) {
    stripped = stripped.replace(/\s+en\s+.+$/i, '').trim();
  }

  for (const location of [clinic?.ciudad, clinic?.provincia, clinic?.codigo_postal, clinic?.pais].map(cleanString).filter(Boolean)) {
    stripped = stripped
      .replace(new RegExp(`[,\\s]+${escapeRegExp(location)}\\b.*$`, 'i'), '')
      .trim();
  }

  return cleanString(stripped) || raw;
}

function heatmapRestrictionHalfSizeMeters() {
  // Each tile simulates a search from that point. The zoom changes where the
  // points are placed, but not the local search window itself.
  return 650;
}

function rectangleAroundPoint(point, halfSizeMeters) {
  const latitude = Number(point?.latitude);
  const longitude = Number(point?.longitude);
  const meters = Number(halfSizeMeters);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || !Number.isFinite(meters)) return null;

  const km = meters / 1000;
  const latDelta = km / 111.32;
  const lngDelta = km / (111.32 * Math.cos(latitude * Math.PI / 180));
  return {
    rectangle: {
      low: {
        latitude: Math.round((latitude - latDelta) * 1000000) / 1000000,
        longitude: Math.round((longitude - lngDelta) * 1000000) / 1000000
      },
      high: {
        latitude: Math.round((latitude + latDelta) * 1000000) / 1000000,
        longitude: Math.round((longitude + lngDelta) * 1000000) / 1000000
      }
    }
  };
}

function offsetLatLng(center, xKm, yKm) {
  const latitude = Number(center?.latitude);
  const longitude = Number(center?.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const lat = latitude + (yKm / 111.32);
  const lng = longitude + (xKm / (111.32 * Math.cos(latitude * Math.PI / 180)));
  return {
    latitude: Math.round(lat * 1000000) / 1000000,
    longitude: Math.round(lng * 1000000) / 1000000
  };
}

function heatmapScore(position) {
  if (!position) return 5;
  if (position <= 3) return 100;
  if (position <= 9) return 65;
  return 20;
}

async function getLocalRankingHeatmap(scope, { term = null, zoomKm = 3 } = {}) {
  const normalizedTerm = cleanString(term) || null;
  const normalizedZoomKm = clampHeatmapZoom(zoomKm);
  return cachedCompetitionValue(
    cacheKey(['local-heatmap', scopeCacheKey(scope), normalizedTerm || '__auto__', normalizedZoomKm]),
    COMPETITION_HEATMAP_CACHE_TTL_MS,
    async () => {
  const clinic = await resolvePrimaryClinic(scope);
  const setupBlocker = competitionSetupBlocker(clinic, normalizedTerm);
  if (setupBlocker) {
    return {
      success: false,
      setup_required: true,
      setup_code: setupBlocker.code,
      message: setupBlocker.message,
      points: []
    };
  }

  const ownProfile = await resolveOwnClinicProfile(clinic);
  const center = {
    latitude: Number(ownProfile?.latitude ?? clinic?.latitud ?? clinic?.latitude),
    longitude: Number(ownProfile?.longitude ?? clinic?.longitud ?? clinic?.longitude)
  };
  if (!Number.isFinite(center.latitude) || !Number.isFinite(center.longitude)) {
    return {
      success: false,
      setup_required: true,
      setup_code: 'LOCAL_COORDINATES_REQUIRED',
      message: 'No tenemos coordenadas fiables de la ficha local de esta clínica para simular búsquedas por zona.',
      points: []
    };
  }

  const terms = rankingTermsForClinic(clinic);
  const selectedTerm = normalizedTerm || terms[0];
  if (!selectedTerm) {
    return {
      success: false,
      setup_required: true,
      setup_code: 'LOCAL_TERM_REQUIRED',
      message: 'Falta una búsqueda relevante para calcular el mapa de posición local.',
      points: []
    };
  }

  const radiusKm = normalizedZoomKm;
  const heatmapQuery = heatmapSearchTermForClinic(selectedTerm, clinic) || selectedTerm;
  const restrictionHalfSizeMeters = heatmapRestrictionHalfSizeMeters(radiusKm);
  const ownPlaceId = normalizePlaceId(ownProfile?.google_place_id || clinic?.business_place_id);
  const ownName = cleanString(ownProfile?.name) || cleanString(clinic?.business_location_name) || cleanString(clinic?.nombre_clinica);
  const points = await mapWithConcurrency(rankingHeatmapOffsets(radiusKm), COMPETITION_GOOGLE_CONCURRENCY, async (offset) => {
    const point = offsetLatLng(center, offset.xKm, offset.yKm);
    if (!point) return null;
    try {
      const locationRestriction = rectangleAroundPoint(point, restrictionHalfSizeMeters);
      const places = await searchGooglePlaces({
        query: heatmapQuery,
        maxResultCount: LOCAL_HEATMAP_RESULT_LIMIT,
        locationRestriction,
        rankPreference: 'DISTANCE'
      });
      let normalized = places.map(normalizePlace).filter((place) => place.name);

      if (!normalized.length) {
        const fallbackPlaces = await searchGooglePlaces({
          query: heatmapQuery,
          maxResultCount: LOCAL_HEATMAP_RESULT_LIMIT,
          locationBias: {
            circle: {
              center: point,
              radius: Math.max(500, Math.round((radiusKm * 1000) / 3))
            }
          },
          rankPreference: 'DISTANCE'
        });
        normalized = fallbackPlaces.map(normalizePlace).filter((place) => place.name);
      }
      const ownIndex = normalized.findIndex((place) => {
        const placeId = normalizePlaceId(place.google_place_id);
        return (ownPlaceId && placeId === ownPlaceId) || businessNamesMatch(place.name, ownName);
      });
      const myPosition = ownIndex >= 0 ? ownIndex + 1 : null;
      return {
        latitude: point.latitude,
        longitude: point.longitude,
        x_km: offset.xKm,
        y_km: offset.yKm,
        my_position: myPosition,
        score: heatmapScore(myPosition),
        top_results: normalized.slice(0, 5).map((place) => place.name),
        measured_at: new Date().toISOString()
      };
    } catch (error) {
      return {
        latitude: point.latitude,
        longitude: point.longitude,
        x_km: offset.xKm,
        y_km: offset.yKm,
        my_position: null,
        score: 0,
        top_results: [],
        error: normalizeExternalError(error),
        measured_at: new Date().toISOString()
      };
    }
  }).then((items) => items.filter(Boolean));

  const staticMap = await buildLocalHeatmapStaticMap(center, points, radiusKm);

  return {
    success: true,
    term: selectedTerm,
    effective_term: heatmapQuery,
    available_terms: terms,
    zoom_km: radiusKm,
    grid_size: LOCAL_HEATMAP_GRID_SIZE % 2 === 0 ? LOCAL_HEATMAP_GRID_SIZE - 1 : LOCAL_HEATMAP_GRID_SIZE,
    result_limit: LOCAL_HEATMAP_RESULT_LIMIT,
    center,
    map_image_data_url: staticMap.dataUrl,
    map_provider: staticMap.dataUrl ? 'google_static_maps' : null,
    map_error: staticMap.error,
    own_profile: ownProfile ? {
      name: ownProfile.name,
      google_place_id: normalizePlaceId(ownProfile.google_place_id),
      google_maps_url: ownProfile.google_maps_url
    } : null,
    points
  };
    },
    { cachePredicate: (value) => !value?.success || !!value?.map_image_data_url }
  );
}

function buildPlaceHeaders(fieldMask) {
  const apiKey = getGooglePlacesApiKey();
  if (!apiKey) {
    const err = new Error('GOOGLE_PLACES_API_KEY no está configurada');
    err.code = 'GOOGLE_PLACES_NOT_CONFIGURED';
    throw err;
  }
  return {
    'Content-Type': 'application/json',
    'X-Goog-Api-Key': apiKey,
    'X-Goog-FieldMask': fieldMask
  };
}

async function searchGooglePlaces({
  query,
  maxResultCount = DEFAULT_LIMIT,
  locationBias = null,
  locationRestriction = null,
  rankPreference = null
}) {
  const body = {
    textQuery: query,
    languageCode: DEFAULT_LANGUAGE,
    regionCode: DEFAULT_REGION,
    maxResultCount
  };
  if (locationRestriction) body.locationRestriction = locationRestriction;
  else if (locationBias) body.locationBias = locationBias;
  if (rankPreference) body.rankPreference = rankPreference;
  return cachedCompetitionValue(cacheKey(['places-search', body]), COMPETITION_PLACES_CACHE_TTL_MS, async () => {
    const response = await axios.post(`${GOOGLE_PLACES_API_BASE}/places:searchText`, body, {
      headers: buildPlaceHeaders(PLACE_FIELD_MASK),
      timeout: 15000
    });
    return Array.isArray(response.data?.places) ? response.data.places : [];
  });
}

async function getGooglePlaceDetails(placeId, { bypassCache = false } = {}) {
  if (!placeId) return null;
  const loader = async () => {
    const response = await axios.get(`${GOOGLE_PLACES_API_BASE}/places/${encodeURIComponent(placeId)}`, {
      headers: buildPlaceHeaders(PLACE_DETAILS_FIELD_MASK),
      timeout: 15000
    });
    return response.data || null;
  };
  return bypassCache
    ? loader()
    : cachedCompetitionValue(cacheKey(['place-details', normalizePlaceId(placeId) || placeId]), COMPETITION_PLACE_DETAILS_CACHE_TTL_MS, loader);
}

async function resolveMetaAdLibraryToken(scope) {
  const envToken = getMetaAdLibraryTokenFromEnv();
  if (envToken) return { accessToken: envToken, source: 'env' };

  const asset = await ClinicMetaAsset.findOne({
    where: {
      ...buildAssetScopeWhere(scope),
      assetType: { [Op.in]: ['ad_account', 'facebook_page'] },
      isActive: true
    },
    include: [{ model: MetaConnection, as: 'metaConnection', attributes: ['id', 'accessToken', 'expiresAt'] }],
    order: [['assetType', 'ASC'], ['updatedAt', 'DESC']]
  });

  const token = asset?.metaConnection?.accessToken || null;
  return token ? { accessToken: token, source: `meta_connection:${asset.metaConnection.id}` } : { accessToken: null, source: null };
}

function competitorMetaIdentityValues(competitor = {}) {
  const socialProfiles = socialProfilesFromPayload(competitor.raw_place_payload);
  return [
    competitor.meta_page_name,
    competitor.name,
    ...(Array.isArray(competitor.meta_ads_search_terms) ? competitor.meta_ads_search_terms : []),
    socialProfiles?.facebook_username,
    socialProfiles?.instagram_username,
    socialProfiles?.facebook_url,
    socialProfiles?.instagram_url,
    competitor.meta_page_url
  ].map(cleanString).filter(Boolean);
}

function scoreMetaPageMatch(competitor = {}, page = {}) {
  const pageName = cleanString(page.page_name || page.name);
  const pageId = cleanString(page.page_id || page.id);
  if (pageId && cleanString(competitor.meta_page_id) && pageId === cleanString(competitor.meta_page_id)) return 100;
  if (!pageName) return 0;

  let score = businessNamesMatch(pageName, competitor.name) ? 80 : 0;
  const tokens = sharedBusinessTokens(competitor.name, pageName);
  if (tokens.length >= 2) score = Math.max(score, 70);
  if (tokens.some((token) => token.length >= 6)) score = Math.max(score, 45);

  for (const value of competitorMetaIdentityValues(competitor)) {
    const normalizedValue = normalizeBusinessName(value);
    if (!normalizedValue) continue;
    const pageNormalized = normalizeBusinessName(pageName);
    if (pageNormalized && normalizedValue.length >= 6 && (pageNormalized.includes(normalizedValue) || normalizedValue.includes(pageNormalized))) {
      score = Math.max(score, 70);
    }
    const valueTokens = sharedBusinessTokens(value, pageName);
    if (valueTokens.length >= 2) score = Math.max(score, 60);
    if (valueTokens.some((token) => token.length >= 6)) score = Math.max(score, 45);
  }

  return score;
}

function filterMetaAdsForCompetitor(competitor, ads = []) {
  return ads
    .map((ad) => ({ ...ad, match_score: scoreMetaPageMatch(competitor, ad) }))
    .filter((ad) => ad.match_score >= META_PAGE_MATCH_THRESHOLD);
}

function normalizeMetaAd(ad = {}) {
  const bodies = Array.isArray(ad.ad_creative_bodies) ? ad.ad_creative_bodies : [];
  const titles = Array.isArray(ad.ad_creative_link_titles) ? ad.ad_creative_link_titles : [];
  const descriptions = Array.isArray(ad.ad_creative_link_descriptions) ? ad.ad_creative_link_descriptions : [];
  const urls = Array.isArray(ad.ad_creative_link_urls) ? ad.ad_creative_link_urls : [];
  const adId = cleanString(ad.id);
  const pageId = cleanString(ad.page_id);
  const renderUrl = normalizeUrl(ad.ad_snapshot_url);
  const safeAdUrl = metaAdsLibraryAdUrl(adId) || removeQueryParams(renderUrl, ['access_token']);
  const pageLibraryUrl = metaAdsLibraryPageUrl(pageId);
  return {
    id: adId,
    page_id: pageId,
    page_name: cleanString(ad.page_name),
    body: cleanString(bodies[0]),
    title: cleanString(titles[0]),
    description: cleanString(descriptions[0]),
    landing_url: normalizeUrl(urls[0]),
    snapshot_url: safeAdUrl,
    ad_snapshot_url: safeAdUrl,
    library_url: pageLibraryUrl || safeAdUrl,
    page_library_url: pageLibraryUrl,
    _render_snapshot_url: renderUrl,
    platforms: Array.isArray(ad.publisher_platforms) ? ad.publisher_platforms : [],
    reached_countries: Array.isArray(ad.ad_reached_countries) ? ad.ad_reached_countries : [],
    media_url: normalizeUrl(ad.media_url),
    image_url: normalizeUrl(ad.image_url),
    thumbnail_url: normalizeUrl(ad.thumbnail_url),
    video_url: normalizeUrl(ad.video_url),
    media_source: cleanString(ad.media_source),
    created_at: cleanString(ad.ad_creation_time),
    delivery_start_at: cleanString(ad.ad_delivery_start_time),
    delivery_stop_at: cleanString(ad.ad_delivery_stop_time)
  };
}

async function resolveFacebookPageFromUrlOrUsername(value, accessToken) {
  const url = normalizeSocialProfileUrl(value) || normalizeUrl(value);
  const explicitId = extractMetaPageIdFromUrl(url || value);
  let isFacebookUrl = false;
  try {
    isFacebookUrl = !!url && new URL(url).hostname.replace(/^www\./i, '').toLowerCase() === 'facebook.com';
  } catch (_) {
    isFacebookUrl = false;
  }
  if (url && !isFacebookUrl && !explicitId) return null;

  let username = usernameFromSocialUrl(url || value, 'facebook') || (!url ? cleanString(value) : null);
  if (username) username = username.replace(/^@/, '').replace(/^\/+/, '').split(/[/?#]/)[0];

  const idsToTry = [...new Set([explicitId, username && /^\d{5,}$/.test(username) ? username : null].filter(Boolean))];
  for (const id of idsToTry) {
    try {
      const response = await metaGet(String(id), {
        params: { fields: 'id,name,link' },
        accessToken,
        timeout: 12000
      });
      return {
        page_id: cleanString(response.data?.id) || id,
        page_name: cleanString(response.data?.name),
        page_url: normalizeUrl(response.data?.link) || socialUrlFromUsername(id, 'facebook'),
        source: 'facebook_page_url'
      };
    } catch (_) {
      return { page_id: id, page_name: null, page_url: socialUrlFromUsername(id, 'facebook'), source: 'facebook_page_url' };
    }
  }

  if (!username || /^\d+$/.test(username)) return null;
  try {
    const response = await metaGet(encodeURIComponent(username), {
      params: { fields: 'id,name,link' },
      accessToken,
      timeout: 12000
    });
    if (!response.data?.id) return null;
    return {
      page_id: cleanString(response.data.id),
      page_name: cleanString(response.data.name),
      page_url: normalizeUrl(response.data.link) || socialUrlFromUsername(username, 'facebook'),
      source: 'facebook_username'
    };
  } catch (_) {
    return null;
  }
}

async function resolveMetaPageFromKnownProfiles(competitor, accessToken) {
  const socialProfiles = socialProfilesFromPayload(competitor.raw_place_payload);
  const candidates = [
    competitor.meta_page_url,
    socialProfiles?.facebook_url,
    socialProfiles?.facebook_username ? socialUrlFromUsername(socialProfiles.facebook_username, 'facebook') : null
  ].map(cleanString).filter(Boolean);

  for (const candidate of [...new Set(candidates)]) {
    const resolved = await resolveFacebookPageFromUrlOrUsername(candidate, accessToken);
    if (!resolved?.page_id) continue;
    const score = resolved.page_name ? scoreMetaPageMatch(competitor, { page_id: resolved.page_id, page_name: resolved.page_name }) : META_PAGE_MATCH_THRESHOLD;
    if (score >= META_PAGE_MATCH_THRESHOLD || extractMetaPageIdFromUrl(candidate)) {
      return { ...resolved, match_score: score };
    }
  }
  return null;
}

async function searchMetaAdsArchive(params, accessToken) {
  const response = await metaGet('ads_archive', { params, accessToken, timeout: 30000 });
  return {
    raw: response.data,
    ads: Array.isArray(response.data?.data) ? response.data.data.map(normalizeMetaAd) : []
  };
}

async function resolveMetaPageFromAdsArchive(competitor, accessToken) {
  const candidateTerms = competitorMetaIdentityValues(competitor)
    .filter((value) => !/^https?:\/\//i.test(value))
    .filter((value) => normalizeBusinessName(value)?.length >= 3);

  for (const term of [...new Set(candidateTerms)].slice(0, 4)) {
    const params = {
      fields: META_AD_FIELDS,
      ad_type: 'ALL',
      ad_active_status: 'ACTIVE',
      ad_reached_countries: JSON.stringify([DEFAULT_COUNTRY]),
      search_terms: term,
      search_type: 'KEYWORD_EXACT_PHRASE',
      limit: Math.min(DEFAULT_AD_LIMIT, 25)
    };
    const result = await searchMetaAdsArchive(params, accessToken);
    const matches = filterMetaAdsForCompetitor(competitor, result.ads)
      .filter((ad) => ad.page_id)
      .sort((a, b) => (b.match_score || 0) - (a.match_score || 0));
    const best = matches[0];
    if (best) {
      return {
        page_id: best.page_id,
        page_name: best.page_name,
        page_url: best.page_id ? `https://www.facebook.com/${best.page_id}` : null,
        source: 'ads_archive_exact_search',
        match_score: best.match_score
      };
    }
  }
  return null;
}

async function enrichAdWithSnapshotMedia(ad = {}) {
  const snapshotUrl = normalizeUrl(ad._render_snapshot_url || ad.snapshot_url);
  if (!snapshotUrl || ad.image_url || ad.video_url || ad.media_url) return ad;
  try {
    const response = await axios.get(snapshotUrl, {
      timeout: SNAPSHOT_MEDIA_TIMEOUT_MS,
      maxContentLength: 5 * 1024 * 1024,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ClinicaClickBot/1.0; +https://clinicaclick.com)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    const media = extractFirstMediaFromHtml(response.data);
    if (!media?.image_url && !media?.video_url) {
      return { ...ad, media_source: ad.media_source || 'snapshot_unavailable' };
    }
    return {
      ...ad,
      ...media,
      media_url: media.video_url || media.image_url || ad.media_url || null,
      _render_snapshot_url: undefined,
      media_source: 'snapshot_html'
    };
  } catch (error) {
    return {
      ...ad,
      _render_snapshot_url: snapshotUrl,
      media_source: 'snapshot_unavailable',
      media_error: error?.response?.status ? `HTTP ${error.response.status}` : (error?.code || error?.message || 'snapshot_unavailable')
    };
  }
}

function adHasMedia(ad = {}) {
  return !!(ad.image_url || ad.thumbnail_url || ad.video_url || ad.media_url || ad.external_video_url);
}

function loadOptionalBrowserAutomation() {
  const candidates = ['playwright-core', 'playwright', 'puppeteer-core', 'puppeteer'];
  for (const packageName of candidates) {
    try {
      // Optional dependency: only loaded if the runtime explicitly enables browser recovery.
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const mod = require(packageName);
      if (mod?.chromium) return { type: 'playwright', chromium: mod.chromium };
      if (typeof mod?.launch === 'function') return { type: 'puppeteer', puppeteer: mod };
    } catch (_) {
      // Try next optional package.
    }
  }
  return null;
}

const metaBrowserRuntime = {
  automation: undefined,
  browser: null,
  browserType: null,
  idleTimer: null,
  launchPromise: null,
  queue: Promise.resolve(),
  metrics: {
    mode: META_BROWSER_MEDIA_MODE,
    enabled: META_BROWSER_MEDIA_MODE !== 'off',
    browser_available: null,
    launches: 0,
    sleep_count: 0,
    batches: 0,
    attempted_ads: 0,
    recovered_ads: 0,
    no_media_ads: 0,
    failed_ads: 0,
    unavailable_ads: 0,
    last_error: null,
    last_duration_ms: 0,
    last_memory_delta_mb: null,
    idle_timeout_ms: META_BROWSER_MEDIA_IDLE_MS,
    limit: META_BROWSER_MEDIA_LIMIT
  }
};

function cloneMetaBrowserMetrics() {
  return {
    ...metaBrowserRuntime.metrics,
    browser_awake: !!metaBrowserRuntime.browser,
    browser_type: metaBrowserRuntime.browserType
  };
}

function resetMetaBrowserBatchMetrics() {
  metaBrowserRuntime.metrics.batches = 0;
  metaBrowserRuntime.metrics.attempted_ads = 0;
  metaBrowserRuntime.metrics.recovered_ads = 0;
  metaBrowserRuntime.metrics.no_media_ads = 0;
  metaBrowserRuntime.metrics.failed_ads = 0;
  metaBrowserRuntime.metrics.unavailable_ads = 0;
  metaBrowserRuntime.metrics.last_error = null;
  metaBrowserRuntime.metrics.last_duration_ms = 0;
  metaBrowserRuntime.metrics.last_memory_delta_mb = null;
}

function shouldUseMetaBrowserForAds(indexes = []) {
  if (META_BROWSER_MEDIA_MODE === 'off') return false;
  if (!META_BROWSER_MEDIA_LIMIT) return false;
  if (!indexes.length) return false;
  if (META_BROWSER_MEDIA_MODE === 'on') return true;
  return indexes.length >= META_BROWSER_MEDIA_MIN_MISSING;
}

function getMetaBrowserAutomation() {
  if (metaBrowserRuntime.automation !== undefined) return metaBrowserRuntime.automation;
  metaBrowserRuntime.automation = loadOptionalBrowserAutomation();
  metaBrowserRuntime.metrics.browser_available = !!metaBrowserRuntime.automation;
  if (!metaBrowserRuntime.automation) {
    metaBrowserRuntime.metrics.last_error = 'browser_runtime_unavailable';
  }
  return metaBrowserRuntime.automation;
}

function clearMetaBrowserIdleTimer() {
  if (metaBrowserRuntime.idleTimer) {
    clearTimeout(metaBrowserRuntime.idleTimer);
    metaBrowserRuntime.idleTimer = null;
  }
}

function scheduleMetaBrowserSleep() {
  clearMetaBrowserIdleTimer();
  if (!metaBrowserRuntime.browser) return;

  if (!META_BROWSER_MEDIA_IDLE_MS) {
    const browser = metaBrowserRuntime.browser;
    metaBrowserRuntime.browser = null;
    metaBrowserRuntime.browserType = null;
    browser.close()
      .then(() => { metaBrowserRuntime.metrics.sleep_count += 1; })
      .catch(() => {});
    return;
  }

  metaBrowserRuntime.idleTimer = setTimeout(async () => {
    const browser = metaBrowserRuntime.browser;
    metaBrowserRuntime.browser = null;
    metaBrowserRuntime.browserType = null;
    metaBrowserRuntime.idleTimer = null;
    if (browser) {
      await browser.close().catch(() => {});
      metaBrowserRuntime.metrics.sleep_count += 1;
    }
  }, META_BROWSER_MEDIA_IDLE_MS);
  if (typeof metaBrowserRuntime.idleTimer.unref === 'function') {
    metaBrowserRuntime.idleTimer.unref();
  }
}

async function getMetaBrowserInstance() {
  clearMetaBrowserIdleTimer();
  if (metaBrowserRuntime.browser) return metaBrowserRuntime.browser;
  if (metaBrowserRuntime.launchPromise) return metaBrowserRuntime.launchPromise;

  const automation = getMetaBrowserAutomation();
  if (!automation) return null;

  const launchOptions = {
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  };
  if (process.env.COMPETITION_BROWSER_EXECUTABLE_PATH) {
    launchOptions.executablePath = process.env.COMPETITION_BROWSER_EXECUTABLE_PATH;
  }

  metaBrowserRuntime.launchPromise = (async () => {
    const browser = automation.type === 'playwright'
      ? await automation.chromium.launch(launchOptions)
      : await automation.puppeteer.launch(launchOptions);
    metaBrowserRuntime.browser = browser;
    metaBrowserRuntime.browserType = automation.type;
    metaBrowserRuntime.metrics.launches += 1;
    metaBrowserRuntime.metrics.browser_available = true;
    return browser;
  })();

  try {
    return await metaBrowserRuntime.launchPromise;
  } catch (error) {
    metaBrowserRuntime.browser = null;
    metaBrowserRuntime.browserType = null;
    metaBrowserRuntime.metrics.browser_available = false;
    metaBrowserRuntime.metrics.last_error = error?.message || error?.code || 'browser_launch_failed';
    return null;
  } finally {
    metaBrowserRuntime.launchPromise = null;
  }
}

async function withMetaBrowser(fn) {
  const previous = metaBrowserRuntime.queue;
  let release;
  metaBrowserRuntime.queue = new Promise((resolve) => { release = resolve; });
  await previous.catch(() => {});
  try {
    const browser = await getMetaBrowserInstance();
    if (!browser) return null;
    return await fn(browser, metaBrowserRuntime.browserType);
  } finally {
    release();
    scheduleMetaBrowserSleep();
  }
}

async function extractMediaWithPlaywright(browser, ad) {
  const snapshotUrl = normalizeUrl(ad._render_snapshot_url || ad.snapshot_url);
  if (!snapshotUrl) return null;
  const page = await browser.newPage();
  try {
    await page.goto(snapshotUrl, {
      waitUntil: 'domcontentloaded',
      timeout: META_BROWSER_MEDIA_TIMEOUT_MS
    });
    await page.waitForTimeout(Math.min(1500, Math.floor(META_BROWSER_MEDIA_TIMEOUT_MS / 3)));
    const domAssets = await page.evaluate(() => {
      const normalize = (value) => value || null;
      const nodes = Array.from(document.querySelectorAll('img,video,source,iframe,[style]')).map((node) => {
        const tag = node.tagName.toLowerCase();
        return {
          tag,
          src: normalize(node.getAttribute('src') || node.currentSrc || node.getAttribute('data-src')),
          srcset: normalize(node.getAttribute('srcset')),
          poster: normalize(node.getAttribute('poster')),
          backgroundImage: normalize(window.getComputedStyle(node).backgroundImage),
          width: Number(node.getAttribute('width') || node.clientWidth || 0),
          height: Number(node.getAttribute('height') || node.clientHeight || 0)
        };
      });
      const resources = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((url) => /fbcdn|scontent|\.mp4|\.webp|\.jpg|\.jpeg|\.png/i.test(url));
      return { nodes, resources };
    });
    const assets = [];
    const domNodes = Array.isArray(domAssets) ? domAssets : (domAssets?.nodes || []);
    for (const item of domNodes || []) {
      const srcsetUrl = String(item.srcset || '').split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean)[0];
      const bgUrl = String(item.backgroundImage || '').match(/url\(["']?(.*?)["']?\)/i)?.[1] || null;
      const candidateSrc = item.src || srcsetUrl || bgUrl;
      if (item.tag === 'video' || item.tag === 'source') {
        if (candidateSrc) assets.push(mediaAssetFromUrl(candidateSrc, 'video', { thumbnail_url: item.poster || null }));
        if (item.poster) assets.push(mediaAssetFromUrl(item.poster, 'image'));
      } else if (item.tag === 'iframe' && /youtube\.com|youtu\.be/i.test(item.src || '')) {
        assets.push(mediaAssetFromUrl(item.src, 'external_video'));
      } else if (candidateSrc) {
        assets.push(mediaAssetFromUrl(candidateSrc, /\.(mp4|mov|webm)(?:\?|$)/i.test(candidateSrc) ? 'video' : 'image'));
      }
    }
    for (const url of domAssets?.resources || []) {
      assets.push(mediaAssetFromUrl(url, /\.(mp4|mov|webm)(?:\?|$)/i.test(url) ? 'video' : 'image'));
    }
    const htmlMedia = extractFirstMediaFromHtml(await page.content());
    const mediaAssets = uniqueMediaAssets([
      ...assets,
      ...(Array.isArray(htmlMedia?.media_assets) ? htmlMedia.media_assets : [])
    ].filter(Boolean));
    if (!mediaAssets.length) return null;
    const firstVideo = mediaAssets.find((asset) => asset.type === 'video');
    const firstExternalVideo = mediaAssets.find((asset) => asset.type === 'external_video');
    const firstImage = mediaAssets.find((asset) => asset.type === 'image');
    return {
      video_url: firstVideo?.url || null,
      external_video_url: firstExternalVideo?.external_url || firstExternalVideo?.url || null,
      image_url: firstImage?.url || firstExternalVideo?.thumbnail_url || firstVideo?.thumbnail_url || null,
      thumbnail_url: firstImage?.url || firstExternalVideo?.thumbnail_url || firstVideo?.thumbnail_url || null,
      media_assets: mediaAssets
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function extractMediaWithPuppeteer(browser, ad) {
  const snapshotUrl = normalizeUrl(ad._render_snapshot_url || ad.snapshot_url);
  if (!snapshotUrl) return null;
  const page = await browser.newPage();
  try {
    await page.goto(snapshotUrl, {
      waitUntil: 'domcontentloaded',
      timeout: META_BROWSER_MEDIA_TIMEOUT_MS
    });
    await new Promise((resolve) => setTimeout(resolve, Math.min(1500, Math.floor(META_BROWSER_MEDIA_TIMEOUT_MS / 3))));
    const domAssets = await page.evaluate(() => {
      const normalize = (value) => value || null;
      const nodes = Array.from(document.querySelectorAll('img,video,source,iframe,[style]')).map((node) => {
        const tag = node.tagName.toLowerCase();
        return {
          tag,
          src: normalize(node.getAttribute('src') || node.currentSrc || node.getAttribute('data-src')),
          srcset: normalize(node.getAttribute('srcset')),
          poster: normalize(node.getAttribute('poster')),
          backgroundImage: normalize(window.getComputedStyle(node).backgroundImage),
          width: Number(node.getAttribute('width') || node.clientWidth || 0),
          height: Number(node.getAttribute('height') || node.clientHeight || 0)
        };
      });
      const resources = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .filter((url) => /fbcdn|scontent|\.mp4|\.webp|\.jpg|\.jpeg|\.png/i.test(url));
      return { nodes, resources };
    });
    const assets = [];
    const domNodes = Array.isArray(domAssets) ? domAssets : (domAssets?.nodes || []);
    for (const item of domNodes || []) {
      const srcsetUrl = String(item.srcset || '').split(',').map((part) => part.trim().split(/\s+/)[0]).filter(Boolean)[0];
      const bgUrl = String(item.backgroundImage || '').match(/url\(["']?(.*?)["']?\)/i)?.[1] || null;
      const candidateSrc = item.src || srcsetUrl || bgUrl;
      if (item.tag === 'video' || item.tag === 'source') {
        if (candidateSrc) assets.push(mediaAssetFromUrl(candidateSrc, 'video', { thumbnail_url: item.poster || null }));
        if (item.poster) assets.push(mediaAssetFromUrl(item.poster, 'image'));
      } else if (item.tag === 'iframe' && /youtube\.com|youtu\.be/i.test(item.src || '')) {
        assets.push(mediaAssetFromUrl(item.src, 'external_video'));
      } else if (candidateSrc) {
        assets.push(mediaAssetFromUrl(candidateSrc, /\.(mp4|mov|webm)(?:\?|$)/i.test(candidateSrc) ? 'video' : 'image'));
      }
    }
    for (const url of domAssets?.resources || []) {
      assets.push(mediaAssetFromUrl(url, /\.(mp4|mov|webm)(?:\?|$)/i.test(url) ? 'video' : 'image'));
    }
    const htmlMedia = extractFirstMediaFromHtml(await page.content());
    const mediaAssets = uniqueMediaAssets([
      ...assets,
      ...(Array.isArray(htmlMedia?.media_assets) ? htmlMedia.media_assets : [])
    ].filter(Boolean));
    if (!mediaAssets.length) return null;
    const firstVideo = mediaAssets.find((asset) => asset.type === 'video');
    const firstExternalVideo = mediaAssets.find((asset) => asset.type === 'external_video');
    const firstImage = mediaAssets.find((asset) => asset.type === 'image');
    return {
      video_url: firstVideo?.url || null,
      external_video_url: firstExternalVideo?.external_url || firstExternalVideo?.url || null,
      image_url: firstImage?.url || firstExternalVideo?.thumbnail_url || firstVideo?.thumbnail_url || null,
      thumbnail_url: firstImage?.url || firstExternalVideo?.thumbnail_url || firstVideo?.thumbnail_url || null,
      media_assets: mediaAssets
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function enrichAdsWithBrowserMedia(ads = []) {
  if (!Array.isArray(ads) || !ads.length) return ads;

  const indexes = ads
    .map((ad, index) => ({ ad, index }))
    .filter(({ ad }) => !adHasMedia(ad) && normalizeUrl(ad._render_snapshot_url || ad.snapshot_url))
    .slice(0, META_BROWSER_MEDIA_LIMIT);
  if (!shouldUseMetaBrowserForAds(indexes)) return ads;
  if (!indexes.length) return ads;

  const startedAt = Date.now();
  const memoryBefore = process.memoryUsage().rss;
  const enriched = [...ads];
  metaBrowserRuntime.metrics.batches += 1;
  metaBrowserRuntime.metrics.attempted_ads += indexes.length;

  const automation = getMetaBrowserAutomation();
  if (!automation) {
    metaBrowserRuntime.metrics.unavailable_ads += indexes.length;
    for (const { ad, index } of indexes) {
      enriched[index] = { ...ad, media_source: ad.media_source || 'meta_browser_unavailable' };
    }
    metaBrowserRuntime.metrics.last_duration_ms = Date.now() - startedAt;
    metaBrowserRuntime.metrics.last_memory_delta_mb = Math.round(((process.memoryUsage().rss - memoryBefore) / 1024 / 1024) * 10) / 10;
    return enriched;
  }

  const browserResult = await withMetaBrowser(async (browser, browserType) => {
    if (!browser) {
      metaBrowserRuntime.metrics.unavailable_ads += indexes.length;
      return;
    }
    for (const { ad, index } of indexes) {
      try {
        const media = browserType === 'playwright'
          ? await extractMediaWithPlaywright(browser, ad)
          : await extractMediaWithPuppeteer(browser, ad);
        if (media?.image_url || media?.video_url || media?.external_video_url) {
          enriched[index] = {
            ...ad,
            ...media,
            media_url: media.video_url || media.image_url || ad.media_url || null,
            media_source: 'meta_browser_snapshot'
          };
          metaBrowserRuntime.metrics.recovered_ads += 1;
        } else {
          enriched[index] = { ...ad, media_source: ad.media_source || 'meta_browser_no_media' };
          metaBrowserRuntime.metrics.no_media_ads += 1;
        }
      } catch (error) {
        enriched[index] = {
          ...ad,
          media_source: ad.media_source || 'meta_browser_error',
          media_error: error?.message || error?.code || 'meta_browser_error'
        };
        metaBrowserRuntime.metrics.failed_ads += 1;
        metaBrowserRuntime.metrics.last_error = error?.message || error?.code || 'meta_browser_error';
      }
    }
    return true;
  });
  if (!browserResult) {
    metaBrowserRuntime.metrics.unavailable_ads += indexes.length;
    for (const { ad, index } of indexes) {
      if (enriched[index] === ad) {
        enriched[index] = { ...ad, media_source: ad.media_source || 'meta_browser_unavailable' };
      }
    }
  }

  metaBrowserRuntime.metrics.last_duration_ms = Date.now() - startedAt;
  metaBrowserRuntime.metrics.last_memory_delta_mb = Math.round(((process.memoryUsage().rss - memoryBefore) / 1024 / 1024) * 10) / 10;
  return enriched;
}

async function enrichAdsWithSnapshotMedia(ads = []) {
  if (!Array.isArray(ads) || !ads.length) return ads;
  if (!SNAPSHOT_MEDIA_LIMIT) return ads.map(stripPrivateAdFields);
  const enriched = [...ads];
  let cursor = 0;
  const workerCount = Math.min(3, SNAPSHOT_MEDIA_LIMIT, ads.length);
  async function worker() {
    while (cursor < Math.min(SNAPSHOT_MEDIA_LIMIT, ads.length)) {
      const index = cursor++;
      enriched[index] = await enrichAdWithSnapshotMedia(ads[index]);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
  const browserEnriched = await enrichAdsWithBrowserMedia(enriched);
  return browserEnriched.map(stripPrivateAdFields);
}

function stripPrivateAdFields(ad = {}) {
  if (!ad || typeof ad !== 'object') return ad;
  const { _render_snapshot_url, ...safe } = ad;
  return safe;
}

async function fetchMetaAdsForCompetitor(competitor, scope) {
  const { accessToken, source } = await resolveMetaAdLibraryToken(scope);
  if (!accessToken) {
    const err = new Error('No hay token para Meta Ads Library API. Configura META_AD_LIBRARY_ACCESS_TOKEN o una conexión Meta con acceso válido.');
    err.code = 'META_AD_LIBRARY_NOT_CONFIGURED';
    throw err;
  }

  const searchTerms = Array.isArray(competitor.meta_ads_search_terms)
    ? competitor.meta_ads_search_terms.map(cleanString).filter(Boolean)
    : [];
  const fallbackTerm = cleanString(competitor.meta_page_name) || cleanString(competitor.name);
  if (!competitor.meta_page_id && !searchTerms.length && !fallbackTerm) {
    const err = new Error('Competidor sin meta_page_id ni términos de búsqueda para Meta Ads Library');
    err.code = 'META_AD_LIBRARY_MISSING_QUERY';
    throw err;
  }

  const resolvedPage = competitor.meta_page_id
    ? { page_id: String(competitor.meta_page_id), page_name: cleanString(competitor.meta_page_name), page_url: normalizeUrl(competitor.meta_page_url), source: 'stored' }
    : (await resolveMetaPageFromKnownProfiles(competitor, accessToken)
      || await resolveMetaPageFromAdsArchive(competitor, accessToken));

  const baseParams = {
    fields: META_AD_FIELDS,
    ad_type: 'ALL',
    ad_active_status: 'ACTIVE',
    ad_reached_countries: JSON.stringify([DEFAULT_COUNTRY]),
    limit: DEFAULT_AD_LIMIT
  };

  let result;
  if (resolvedPage?.page_id) {
    result = await searchMetaAdsArchive({
      ...baseParams,
      search_page_ids: JSON.stringify([String(resolvedPage.page_id)])
    }, accessToken);
  } else {
    result = await searchMetaAdsArchive({
      ...baseParams,
      search_terms: searchTerms[0] || fallbackTerm,
      search_type: 'KEYWORD_EXACT_PHRASE'
    }, accessToken);
    result.ads = filterMetaAdsForCompetitor(competitor, result.ads);
  }

  const baseSocialProfiles = mergeSocialProfiles(
    socialProfilesFromPayload(competitor.raw_place_payload),
    resolvedPage?.page_id ? {
      facebook_url: resolvedPage.page_url || metaAdsLibraryPageUrl(resolvedPage.page_id),
      facebook_username: usernameFromSocialUrl(resolvedPage.page_url, 'facebook'),
      source: 'meta_ads_library',
      checked_at: new Date().toISOString()
    } : null
  );
  const socialProfiles = resolvedPage?.page_id
    ? await enrichSocialProfilesWithMetaPublicMetrics(
      baseSocialProfiles,
      resolvedPage.page_id,
      accessToken
    )
    : baseSocialProfiles;

  return {
    tokenSource: source,
    resolvedPage: resolvedPage || null,
    socialProfiles,
    raw: {
      ...result.raw,
      clinicaclick_resolution: {
        page: resolvedPage || null,
        fallback_filtered: !resolvedPage?.page_id
      }
    },
    ads: await enrichAdsWithSnapshotMedia(result.ads)
  };
}

function isGoogleAdsTransparencyEnabled() {
  return envFlagEnabled(process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_ENABLED, true);
}

function googleTransparencyRegionIds() {
  const explicit = String(process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_GEO_CRITERIA_IDS || '')
    .split(/[,\s]+/)
    .map(toInt)
    .filter(Boolean);
  if (explicit.length) return [...new Set(explicit)];

  const country = cleanString(process.env.COMPETITION_GOOGLE_ADS_TRANSPARENCY_COUNTRY || DEFAULT_COUNTRY || DEFAULT_REGION)
    ?.toUpperCase();
  const id = country ? GOOGLE_COUNTRY_GEO_CRITERIA_IDS[country] : null;
  return id ? [id] : [];
}

function googleTransparencyHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (compatible; ClinicaClickBot/1.0; +https://clinicaclick.com)',
    'Accept': 'application/json',
    'Content-Type': 'application/json',
    'X-Same-Domain': '1',
    'Referer': `${GOOGLE_ADS_TRANSPARENCY_BASE}/`
  };
}

async function googleTransparencyRpc(path, body) {
  const response = await axios.post(
    `${GOOGLE_ADS_TRANSPARENCY_BASE.replace(/\/$/g, '')}/anji/_/rpc/${path}`,
    body,
    {
      timeout: GOOGLE_TRANSPARENCY_TIMEOUT_MS,
      maxContentLength: 2 * 1024 * 1024,
      headers: googleTransparencyHeaders()
    }
  );
  return response.data || {};
}

function googleTransparencyTimestamp(value) {
  const seconds = toNumber(value?.['1'] ?? value?.seconds);
  if (!seconds) return null;
  return new Date(seconds * 1000).toISOString();
}

function findStringInObject(value, predicate, seen = new Set()) {
  if (!value) return null;
  if (typeof value === 'string') return predicate(value) ? value : null;
  if (typeof value !== 'object') return null;
  if (seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringInObject(item, predicate, seen);
      if (found) return found;
    }
    return null;
  }

  for (const item of Object.values(value)) {
    const found = findStringInObject(item, predicate, seen);
    if (found) return found;
  }
  return null;
}

function googleTransparencyPreviewHtml(preview) {
  return findStringInObject(preview, (value) => /<img\b|<video\b|<iframe\b/i.test(value));
}

function googleTransparencyPreviewScriptUrl(preview) {
  const script = findStringInObject(preview, (value) => /displayads-formats\.googleusercontent\.com\/ads\/preview\/content\.js/i.test(value));
  return normalizeUrl(script);
}

function googleTransparencyCreativeUrl(advertiserId, creativeId) {
  if (!advertiserId || !creativeId) return null;
  return `${GOOGLE_ADS_TRANSPARENCY_BASE.replace(/\/$/g, '')}/advertiser/${encodeURIComponent(advertiserId)}/creative/${encodeURIComponent(creativeId)}?region=${encodeURIComponent(DEFAULT_COUNTRY)}`;
}

function googleTransparencyAdvertiserUrl(advertiserId) {
  if (!advertiserId) return null;
  return `${GOOGLE_ADS_TRANSPARENCY_BASE.replace(/\/$/g, '')}/advertiser/${encodeURIComponent(advertiserId)}?region=${encodeURIComponent(DEFAULT_COUNTRY)}`;
}

function googleTransparencyFormatLabel(value) {
  const format = toInt(value);
  if (format === 1) return 'Imagen';
  if (format === 2) return 'HTML5';
  if (format === 3) return 'Vídeo';
  if (format === 4) return 'Texto';
  return format ? `Formato ${format}` : null;
}

function normalizeGoogleTransparencyAd(ad = {}) {
  const advertiserId = cleanString(ad['1'] || ad.advertiser_id);
  const creativeId = cleanString(ad['2'] || ad.creative_id);
  const preview = ad['3'] || ad.preview || {};
  const previewHtml = googleTransparencyPreviewHtml(preview);
  const previewScriptUrl = googleTransparencyPreviewScriptUrl(preview);
  const media = previewHtml ? extractFirstMediaFromHtml(previewHtml) : null;
  const imageUrl = media?.image_url || null;
  const videoUrl = media?.video_url || null;
  const externalVideoUrl = media?.external_video_url || null;
  const formatLabel = googleTransparencyFormatLabel(ad['4'] || ad.format);
  const advertiserUrl = googleTransparencyAdvertiserUrl(advertiserId);
  const creativeUrl = googleTransparencyCreativeUrl(advertiserId, creativeId);

  return {
    provider: GOOGLE_ADS_TRANSPARENCY_PROVIDER,
    id: creativeId,
    creative_id: creativeId,
    advertiser_id: advertiserId,
    advertiser_name: cleanString(ad['12'] || ad.advertiser_name),
    page_name: cleanString(ad['12'] || ad.advertiser_name),
    domain: domainFromUrl(ad['14']) || cleanString(ad['14'] || ad.domain),
    body: null,
    title: formatLabel || 'Anuncio de Google',
    description: null,
    snapshot_url: creativeUrl,
    ad_snapshot_url: creativeUrl,
    advertiser_url: advertiserUrl,
    library_url: advertiserUrl || creativeUrl,
    preview_html: previewHtml || null,
    preview_script_url: previewScriptUrl || null,
    platforms: ['GOOGLE'],
    publisher_platforms: ['GOOGLE'],
    format: formatLabel,
    format_code: toInt(ad['4'] || ad.format),
    served_days: toInt(ad['13'] || ad.served_days),
    image_url: imageUrl,
    thumbnail_url: imageUrl,
    video_url: videoUrl,
    external_video_url: externalVideoUrl,
    media_url: videoUrl || imageUrl || null,
    media_assets: Array.isArray(media?.media_assets) ? media.media_assets : [],
    media_source: imageUrl || videoUrl ? 'google_rpc_preview' : (previewScriptUrl ? 'google_preview_script_pending' : null),
    created_at: googleTransparencyTimestamp(ad['6']),
    delivery_start_at: googleTransparencyTimestamp(ad['6']),
    delivery_stop_at: googleTransparencyTimestamp(ad['7'])
  };
}

async function enrichGoogleAdWithPreviewScript(ad = {}) {
  if (ad.image_url || ad.video_url || !ad.preview_script_url) return ad;
  try {
    const response = await axios.get(ad.preview_script_url, {
      timeout: Math.min(GOOGLE_TRANSPARENCY_TIMEOUT_MS, 15000),
      maxContentLength: 1024 * 1024,
      headers: {
        'User-Agent': googleTransparencyHeaders()['User-Agent'],
        'Accept': 'application/javascript,text/javascript,*/*',
        'Referer': `${GOOGLE_ADS_TRANSPARENCY_BASE}/`
      }
    });
    const media = extractFirstMediaFromHtml(response.data);
    if (!media?.image_url && !media?.video_url) {
      return { ...ad, media_source: 'google_preview_script_unavailable' };
    }
    return {
      ...ad,
      ...media,
      media_url: media.video_url || media.image_url || ad.media_url || null,
      media_source: 'google_preview_script'
    };
  } catch (error) {
    return {
      ...ad,
      media_source: 'google_preview_script_unavailable',
      media_error: error?.response?.status ? `HTTP ${error.response.status}` : (error?.code || error?.message || 'google_preview_script_unavailable')
    };
  }
}

async function enrichGoogleAdsWithPreviewScripts(ads = []) {
  if (!GOOGLE_TRANSPARENCY_SCRIPT_MEDIA_LIMIT || !Array.isArray(ads) || !ads.length) return ads;
  const enriched = [...ads];
  let cursor = 0;
  const limit = Math.min(GOOGLE_TRANSPARENCY_SCRIPT_MEDIA_LIMIT, ads.length);
  const workerCount = Math.min(3, limit);
  async function worker() {
    while (cursor < limit) {
      const index = cursor++;
      enriched[index] = await enrichGoogleAdWithPreviewScript(ads[index]);
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker));
  return enriched;
}

function googleTransparencyMediaScore(ad = {}) {
  const media = ad.video_url || ad.image_url || ad.thumbnail_url || ad.media_url;
  if (ad.video_url) return 50;
  if (/tpc\.googlesyndication\.com\/archive\/simgad/i.test(media || '')) return 40;
  if (/encrypted-tbn\d*\.gstatic\.com|googleusercontent\.com/i.test(media || '')) return 30;
  if (media) return 10;
  return 0;
}

function sortGoogleTransparencyAds(ads = []) {
  return [...ads]
    .map((ad, index) => ({ ad, index }))
    .sort((left, right) => {
      const scoreDelta = googleTransparencyMediaScore(right.ad) - googleTransparencyMediaScore(left.ad);
      if (scoreDelta) return scoreDelta;
      return left.index - right.index;
    })
    .map((item) => item.ad);
}

function googleAdsCandidateDomains(competitor = {}) {
  const raw = competitor.raw_place_payload || {};
  const domains = [
    domainFromUrl(competitor.website_url),
    domainFromUrl(raw.websiteUri),
    domainFromUrl(raw.website_url),
    domainFromUrl(competitor.google_maps_url)
  ].filter(Boolean);
  return [...new Set(domains)]
    .filter((domain) => !['google.com', 'maps.google.com', 'facebook.com', 'instagram.com'].includes(domain))
    .slice(0, 3);
}

function googleAdsCandidateTerms(competitor = {}) {
  const socialProfiles = socialProfilesFromPayload(competitor.raw_place_payload);
  const terms = [
    competitor.name,
    competitor.meta_page_name,
    ...(Array.isArray(competitor.meta_ads_search_terms) ? competitor.meta_ads_search_terms : []),
    socialProfiles?.instagram_username,
    socialProfiles?.facebook_username
  ];
  return [...new Set(terms.map(cleanString).filter((term) => term && normalizeBusinessName(term)?.length >= 3))].slice(0, 4);
}

function normalizeGoogleSuggestion(item = {}) {
  const advertiser = item['1'] || null;
  const domain = item['2'] || null;
  if (advertiser) {
    const count = advertiser['4']?.['1']?.['1'] || advertiser['4']?.['2']?.['1'] || null;
    return {
      type: 'advertiser',
      name: cleanString(advertiser['1']),
      advertiser_id: cleanString(advertiser['2']),
      country: cleanString(advertiser['3']),
      ads_count_hint: toInt(count)
    };
  }
  if (domain) {
    return {
      type: 'domain',
      domain: domainFromUrl(domain['1']) || cleanString(domain['1'])
    };
  }
  return null;
}

function scoreGoogleAdvertiserMatch(competitor = {}, suggestion = {}) {
  if (suggestion.type !== 'advertiser') return 0;
  let score = businessNamesMatch(competitor.name, suggestion.name) ? 80 : 0;
  const tokens = sharedBusinessTokens(competitor.name, suggestion.name);
  if (tokens.length >= 2) score = Math.max(score, 70);
  if (tokens.some((token) => token.length >= 6)) score = Math.max(score, 45);
  for (const term of googleAdsCandidateTerms(competitor)) {
    const termTokens = sharedBusinessTokens(term, suggestion.name);
    if (businessNamesMatch(term, suggestion.name)) score = Math.max(score, 70);
    if (termTokens.length >= 2) score = Math.max(score, 60);
    if (termTokens.some((token) => token.length >= 6)) score = Math.max(score, 45);
  }
  return score;
}

async function searchGoogleTransparencySuggestions(query) {
  const body = {
    1: query,
    2: GOOGLE_TRANSPARENCY_ADVERTISER_LIMIT,
    3: 3
  };
  const regionIds = googleTransparencyRegionIds();
  if (regionIds.length) body[4] = regionIds;
  const raw = await googleTransparencyRpc('SearchService/SearchSuggestions', body);
  const suggestions = (Array.isArray(raw?.['1']) ? raw['1'] : [])
    .map(normalizeGoogleSuggestion)
    .filter(Boolean);
  return { raw, suggestions };
}

async function searchGoogleTransparencyCreativesByDomain(domain, limit = GOOGLE_TRANSPARENCY_AD_LIMIT) {
  const protoQuery = { 12: { 1: domain, 2: true } };
  const regionIds = googleTransparencyRegionIds();
  if (regionIds.length) protoQuery[8] = regionIds;
  const raw = await googleTransparencyRpc('SearchService/SearchCreatives', {
    2: limit,
    3: protoQuery,
    7: { 1: 1 }
  });
  return {
    raw,
    ads: Array.isArray(raw?.['1']) ? raw['1'].map(normalizeGoogleTransparencyAd) : [],
    next_page_token: cleanString(raw?.['2']),
    lower_bound: toInt(raw?.['4']),
    upper_bound: toInt(raw?.['5']),
    total_ads_count: toInt(raw?.['5']) || toInt(raw?.['4']) || null
  };
}

async function searchGoogleTransparencyCreativesByAdvertiser(advertiserId, limit = GOOGLE_TRANSPARENCY_AD_LIMIT) {
  const protoQuery = { 1: advertiserId };
  const regionIds = googleTransparencyRegionIds();
  if (regionIds.length) protoQuery[8] = regionIds;
  const raw = await googleTransparencyRpc('SearchService/SearchCreatives', {
    2: limit,
    3: protoQuery,
    7: { 1: 1 }
  });
  return {
    raw,
    ads: Array.isArray(raw?.['1']) ? raw['1'].map(normalizeGoogleTransparencyAd) : [],
    next_page_token: cleanString(raw?.['2']),
    lower_bound: toInt(raw?.['4']),
    upper_bound: toInt(raw?.['5']),
    total_ads_count: toInt(raw?.['5']) || toInt(raw?.['4']) || null
  };
}

async function fetchGoogleAdsTransparencyForCompetitor(competitor = {}) {
  if (!isGoogleAdsTransparencyEnabled()) {
    const err = new Error('Google Ads Transparency está desactivado por configuración');
    err.code = 'GOOGLE_ADS_TRANSPARENCY_DISABLED';
    throw err;
  }

  const domains = googleAdsCandidateDomains(competitor);
  const resolution = { mode: null, domains_checked: [], advertisers_checked: [], suggestions: [] };
  for (const domain of domains) {
    resolution.domains_checked.push(domain);
    const result = await searchGoogleTransparencyCreativesByDomain(domain);
    if (result.ads.length) {
      const ads = await enrichGoogleAdsWithPreviewScripts(result.ads.slice(0, GOOGLE_TRANSPARENCY_AD_LIMIT));
      return {
        raw: { ...result.raw, clinicaclick_resolution: { ...resolution, mode: 'domain', domain } },
        ads: sortGoogleTransparencyAds(ads),
        total_ads_count: result.total_ads_count || result.upper_bound || result.lower_bound || result.ads.length,
        resolved: { mode: 'domain', domain, lower_bound: result.lower_bound, upper_bound: result.upper_bound }
      };
    }
  }

  const advertiserCandidates = [];
  for (const term of googleAdsCandidateTerms(competitor)) {
    const result = await searchGoogleTransparencySuggestions(term);
    resolution.suggestions.push({ term, suggestions: result.suggestions.slice(0, 10) });
    for (const suggestion of result.suggestions) {
      if (suggestion.type !== 'advertiser' || !suggestion.advertiser_id) continue;
      const score = scoreGoogleAdvertiserMatch(competitor, suggestion);
      if (score < GOOGLE_ADVERTISER_MATCH_THRESHOLD) continue;
      advertiserCandidates.push({ ...suggestion, match_score: score, term });
    }
  }

  const uniqueAdvertisers = [];
  const seen = new Set();
  for (const candidate of advertiserCandidates.sort((a, b) => (b.match_score || 0) - (a.match_score || 0))) {
    if (seen.has(candidate.advertiser_id)) continue;
    seen.add(candidate.advertiser_id);
    uniqueAdvertisers.push(candidate);
    if (uniqueAdvertisers.length >= 2) break;
  }

  let combinedRaw = null;
  const combinedAds = [];
  let totalAdsCount = null;
  for (const candidate of uniqueAdvertisers) {
    resolution.advertisers_checked.push(candidate);
    const remaining = GOOGLE_TRANSPARENCY_AD_LIMIT - combinedAds.length;
    if (remaining <= 0) break;
    const result = await searchGoogleTransparencyCreativesByAdvertiser(candidate.advertiser_id, remaining);
    combinedRaw = combinedRaw || result.raw;
    totalAdsCount = Math.max(totalAdsCount || 0, result.total_ads_count || result.upper_bound || result.lower_bound || result.ads.length || 0);
    combinedAds.push(...result.ads.map((ad) => ({
      ...ad,
      match_score: candidate.match_score,
      matched_term: candidate.term
    })));
  }

  return {
    raw: {
      ...(combinedRaw || {}),
      clinicaclick_resolution: { ...resolution, mode: uniqueAdvertisers.length ? 'advertiser' : 'not_found' }
    },
    ads: sortGoogleTransparencyAds(await enrichGoogleAdsWithPreviewScripts(combinedAds.slice(0, GOOGLE_TRANSPARENCY_AD_LIMIT))),
    total_ads_count: totalAdsCount || combinedAds.length,
    resolved: uniqueAdvertisers[0] || null
  };
}

async function upsertPlaceSnapshot(competitor, placePayload) {
  const place = normalizePlace(placePayload || competitor.raw_place_payload || {});
  const snapshotDate = todayLabel();
  const values = {
    rating: place.rating,
    review_count: place.review_count,
    primary_category: place.primary_category,
    website_url: place.website_url,
    phone: place.phone,
    address: place.address,
    business_status: place.business_status,
    raw_payload: placePayload || competitor.raw_place_payload || null
  };
  const [snapshot, created] = await MarketingCompetitorSnapshot.findOrCreate({
    where: { competitor_id: competitor.id, snapshot_date: snapshotDate },
    defaults: values
  });
  if (!created) await snapshot.update(values);
  return snapshot;
}

async function upsertAdsSnapshot(competitor, result) {
  return upsertProviderAdsSnapshot(competitor, META_ADS_LIBRARY_PROVIDER, result);
}

async function upsertProviderAdsSnapshot(competitor, provider, result) {
  const snapshotDate = todayLabel();
  const visibleAds = Array.isArray(result.ads) ? result.ads.map(stripPrivateAdFields) : [];
  const adsCount = result.total_ads_count != null
    ? Math.max(toInt(result.total_ads_count) || 0, visibleAds.length)
    : visibleAds.length;
  const values = {
    provider,
    status: result.status || 'completed',
    ads_count: adsCount,
    active_ads: visibleAds,
    error_code: result.error_code || null,
    error_message: result.error_message || null,
    raw_payload: {
      ...(result.raw || {}),
      clinicaclick_total_ads_count: adsCount,
      clinicaclick_visible_ads_count: visibleAds.length
    }
  };
  const [snapshot, created] = await MarketingCompetitorAdSnapshot.findOrCreate({
    where: { competitor_id: competitor.id, provider, snapshot_date: snapshotDate },
    defaults: values
  });
  if (!created) await snapshot.update(values);
  return snapshot;
}

function adSnapshotPayload(snapshot) {
  const ads = snapshot && typeof snapshot.toJSON === 'function' ? snapshot.toJSON() : snapshot;
  const activeAds = Array.isArray(ads?.active_ads) ? ads.active_ads : [];
  return {
    ads_status: ads?.status || null,
    active_ads_count: ads?.ads_count != null ? Number(ads.ads_count) : null,
    total_ads_count: ads?.ads_count != null ? Number(ads.ads_count) : null,
    visible_ads_count: activeAds.length,
    active_ads: activeAds,
    error_code: ads?.error_code || null,
    error_message: ads?.error_message || null,
    last_synced_at: ads?.updated_at || null
  };
}

function mapCompetitorRow(row, latestSnapshot = null, latestAdSnapshot = null, latestGoogleAdSnapshot = null) {
  const plain = typeof row.toJSON === 'function' ? row.toJSON() : row;
  const snapshot = latestSnapshot && typeof latestSnapshot.toJSON === 'function' ? latestSnapshot.toJSON() : latestSnapshot;
  const ads = adSnapshotPayload(latestAdSnapshot);
  const googleAds = adSnapshotPayload(latestGoogleAdSnapshot);
  return {
    id: plain.id,
    name: plain.name,
    source: plain.source,
    scope: {
      clinic_id: plain.clinica_id || null,
      group_id: plain.grupo_clinica_id || null
    },
    google: {
      place_id: plain.google_place_id,
      maps_url: plain.google_maps_url || buildGoogleMapsUrl(plain.google_place_id, plain.name),
      rating: plain.rating != null ? Number(plain.rating) : null,
      review_count: plain.review_count != null ? Number(plain.review_count) : null,
      primary_category: plain.primary_category,
      business_status: plain.business_status,
      last_synced_at: plain.last_places_synced_at
    },
    contact: {
      website_url: plain.website_url,
      phone: plain.phone,
      address: plain.address,
      city: plain.city,
      latitude: plain.latitude != null ? Number(plain.latitude) : null,
      longitude: plain.longitude != null ? Number(plain.longitude) : null
    },
    meta: {
      page_id: plain.meta_page_id,
      page_name: plain.meta_page_name,
      page_url: plain.meta_page_url,
      search_terms: plain.meta_ads_search_terms || [],
      ads_status: ads.ads_status,
      active_ads_count: ads.active_ads_count,
      total_ads_count: ads.total_ads_count,
      visible_ads_count: ads.visible_ads_count,
      active_ads: ads.active_ads,
      error_code: ads.error_code,
      error_message: ads.error_message,
      last_synced_at: plain.last_ads_synced_at
    },
    google_ads: {
      provider: GOOGLE_ADS_TRANSPARENCY_PROVIDER,
      ads_status: googleAds.ads_status,
      active_ads_count: googleAds.active_ads_count,
      total_ads_count: googleAds.total_ads_count,
      visible_ads_count: googleAds.visible_ads_count,
      active_ads: googleAds.active_ads,
      error_code: googleAds.error_code,
      error_message: googleAds.error_message,
      last_synced_at: googleAds.last_synced_at
    },
    social_profiles: socialProfilesFromPayload(plain.raw_place_payload),
    photo_name: extractPhotoNames(plain.raw_place_payload || [])[0] || null,
    latest_snapshot: snapshot ? {
      date: snapshot.snapshot_date,
      rating: snapshot.rating != null ? Number(snapshot.rating) : null,
      review_count: snapshot.review_count != null ? Number(snapshot.review_count) : null,
      primary_category: snapshot.primary_category,
      business_status: snapshot.business_status
    } : null,
    last_sync_status: plain.last_sync_status,
    last_sync_error: plain.last_sync_error,
    is_active: !!plain.is_active,
    created_at: plain.created_at,
    updated_at: plain.updated_at
  };
}

async function hydrateCompetitors(rows) {
  const hydrated = [];
  for (const row of rows) {
    const [snapshot, adSnapshot, googleAdSnapshot] = await Promise.all([
      MarketingCompetitorSnapshot.findOne({ where: { competitor_id: row.id }, order: [['snapshot_date', 'DESC'], ['id', 'DESC']] }),
      MarketingCompetitorAdSnapshot.findOne({ where: { competitor_id: row.id, provider: META_ADS_LIBRARY_PROVIDER }, order: [['snapshot_date', 'DESC'], ['id', 'DESC']] }),
      MarketingCompetitorAdSnapshot.findOne({ where: { competitor_id: row.id, provider: GOOGLE_ADS_TRANSPARENCY_PROVIDER }, order: [['snapshot_date', 'DESC'], ['id', 'DESC']] })
    ]);
    hydrated.push(await attachPlacePhotoUrl(mapCompetitorRow(row, snapshot, adSnapshot, googleAdSnapshot), { maxWidthPx: 640 }));
  }
  return hydrated;
}

function competitionDisciplineKeys(clinic) {
  const configured = Array.isArray(clinic?.configuracion?.disciplinas)
    ? clinic.configuracion.disciplinas.map((item) => String(item || '').toLowerCase()).filter(Boolean)
    : [];
  if (configured.length) return configured;

  const hint = disciplineSearchHint(clinic);
  if (hint === 'clínica capilar' || hint === 'trasplante capilar') return ['capilar'];
  if (hint === 'podólogo') return ['podologia'];
  if (hint === 'clínica dental') return ['dental'];
  return [];
}

function competitorRelevanceForClinic(competitor, clinic) {
  const keys = competitionDisciplineKeys(clinic);
  if (!keys.length) return { status: 'unknown', score: null, label: 'Sin especialidad de referencia' };

  const text = [
    competitor?.name,
    competitor?.google?.primary_category,
    competitor?.latest_snapshot?.primary_category,
    competitor?.contact?.website_url,
    competitor?.contact?.address,
  ].map((value) => String(value || '').toLowerCase()).join(' ');

  const groups = [
    {
      keys: ['capilar', 'medicina_capilar', 'trasplante_capilar'],
      terms: ['capilar', 'injerto', 'trasplante', 'hair', 'sven', 'pelo', 'alopecia'],
      label: 'capilar'
    },
    {
      keys: ['cirugia_digestiva', 'cirugia_hepatobiliar', 'hepatobiliar'],
      terms: ['hepatobiliar', 'pancreat', 'digestiv', 'endoscop', 'cirugia', 'cirujano', 'laparoscop'],
      label: 'cirugía digestiva/hepatobiliar'
    },
    {
      keys: ['podologia'],
      terms: ['podolog', 'podólog', 'pie', 'pies', 'podoactiva', 'plantilla', 'quiropod', 'uña encarnada', 'uñas encarnadas'],
      label: 'podología'
    },
    {
      keys: ['dental', 'odontologia'],
      terms: ['dental', 'dentista', 'odont', 'ortodon', 'implante'],
      label: 'dental'
    }
  ];
  const group = groups.find((item) => keys.some((key) => item.keys.includes(key)));
  if (!group) return { status: 'unknown', score: null, label: 'Sin regla de relevancia' };

  if (
    group.label === 'podología'
    && /(nail|nails|manicura|pedicura|estetica|estética)/i.test(text)
    && !/(podolog|podólog|podoactiva|quiropod|plantilla|pie|pies|uña encarnada|uñas encarnadas)/i.test(text)
  ) {
    return { status: 'review', score: 0, label: 'Revisar: parece centro de estética/uñas, no podología' };
  }

  const matches = group.terms.filter((term) => text.includes(term));
  if (matches.length) return { status: 'match', score: matches.length, label: `Relacionado con ${group.label}` };
  return { status: 'review', score: 0, label: `Revisar: no parece ${group.label}` };
}

function providerStatusWithObservedErrors(status, competitors = []) {
  const output = { ...status };
  const metaPermissionError = competitors.find((competitor) => {
    const code = String(competitor?.meta?.error_code || '');
    const message = String(competitor?.meta?.error_message || '').toLowerCase();
    return code === '10' || message.includes('does not have permission') || message.includes('no tiene permiso');
  });

  if (metaPermissionError && output.meta_ads_library) {
    output.meta_ads_library = {
      ...output.meta_ads_library,
      available: false,
      configured: true,
      error: {
        code: metaPermissionError.meta.error_code || 'permission_denied',
        message: 'Meta Ads Library está configurada, pero el token actual no tiene permiso para consultar ads_archive.',
        details: metaPermissionError.meta.error_message || null,
        status: null,
        fbtrace_id: null
      }
    };
  }

  return output;
}

async function listCompetition(scope, { includeInactive = false } = {}) {
  return cachedCompetitionValue(
    cacheKey(['competition-list', scopeCacheKey(scope), includeInactive ? 'with-inactive' : 'active-only']),
    COMPETITION_REPORT_CACHE_TTL_MS,
    async () => {
  const clinic = await resolvePrimaryClinic(scope);
  const rows = await MarketingCompetitor.findAll({
    where: buildCompetitorWhere(scope, { includeInactive }),
    order: [['is_active', 'DESC'], ['review_count', 'DESC'], ['rating', 'DESC'], ['name', 'ASC']]
  });
  const competitors = (await hydrateCompetitors(rows))
    .map((competitor) => ({
      ...competitor,
      relevance: competitorRelevanceForClinic(competitor, clinic)
    }));
  const setupBlocker = competitionSetupBlocker(clinic, null);
  const ownProfile = setupBlocker ? null : await resolveOwnClinicProfile(clinic);
  const localRanking = setupBlocker
    ? { terms: rankingTermsForClinic(clinic), entries: [] }
    : await buildLocalRanking(clinic, ownProfile);
  return {
    success: true,
    mode: 'real_v1',
    setup: {
      has_competitors: competitors.some((item) => item.is_active),
      refresh_frequency: 'weekly',
      first_setup_requires_google_places: true,
      ads_provider: META_ADS_LIBRARY_PROVIDER
    },
    provider_status: providerStatusWithObservedErrors(await providerStatusForScope(scope), competitors),
    own_profile: ownProfile ? {
      name: ownProfile.name,
      google_place_id: normalizePlaceId(ownProfile.google_place_id),
      google_maps_url: ownProfile.google_maps_url,
      rating: ownProfile.rating,
      reviews_count: ownProfile.review_count,
      category: ownProfile.primary_category,
      address: ownProfile.address,
      photo_url: ownProfile.photo_url || null
    } : null,
    local_ranking: localRanking.entries,
    ranking_terms: localRanking.terms,
    setup_required: !!setupBlocker,
    setup_code: setupBlocker?.code || null,
    competitors
  };
    }
  );
}

async function suggestCompetitors(scope, { query = null, limit = DEFAULT_LIMIT } = {}) {
  const normalizedLimit = Math.max(1, Math.min(20, Number(limit) || DEFAULT_LIMIT));
  const normalizedQuery = cleanString(query) || null;
  return cachedCompetitionValue(
    cacheKey(['competition-suggestions', scopeCacheKey(scope), normalizedQuery || '__auto__', normalizedLimit]),
    COMPETITION_SUGGESTIONS_CACHE_TTL_MS,
    async () => {
  const clinic = await resolvePrimaryClinic(scope);
  const setupBlocker = competitionSetupBlocker(clinic, normalizedQuery);
  if (setupBlocker) {
    const payload = buildSetupRequiredPayload(scope, clinic, setupBlocker, normalizedQuery);
    payload.provider_status = await providerStatusForScope(scope);
    return payload;
  }

  const textQuery = inferCompetitionQuery(clinic, normalizedQuery);
  const existing = await MarketingCompetitor.findAll({ where: buildCompetitorWhere(scope, { includeInactive: true }), raw: true });
  const existingPlaceIds = new Set(existing.map((item) => normalizePlaceId(item.google_place_id)).filter(Boolean));
  const existingNames = new Set(existing.map((item) => normalizeBusinessName(item.name)).filter(Boolean));
  const ownNames = new Set([
    normalizeBusinessName(clinic?.nombre_clinica),
    normalizeBusinessName(clinic?.business_location_name)
  ].filter(Boolean));
  const ownPlaceIds = await resolveOwnBusinessPlaceIds(scope);

  try {
    const places = await searchGooglePlaces({ query: textQuery, maxResultCount: normalizedLimit });
    const suggestions = await Promise.all(places.map(async (place) => {
      const normalized = normalizePlace(place);
      const relevance = competitorRelevanceForClinic({
        name: normalized.name,
        google: { primary_category: normalized.primary_category },
        latest_snapshot: { primary_category: normalized.primary_category },
        contact: { website_url: normalized.website_url, address: normalized.address }
      }, clinic);
      const normalizedPlaceId = normalizePlaceId(normalized.google_place_id);
      const normalizedName = normalizeBusinessName(normalized.name);
      const isOwnClinic = (normalizedPlaceId && ownPlaceIds.has(normalizedPlaceId))
        || [...ownNames].some((ownName) => businessNamesMatch(normalizedName, ownName));
      const alreadyAdded = isOwnClinic
        || (normalizedPlaceId && existingPlaceIds.has(normalizedPlaceId))
        || [...existingNames].some((existingName) => businessNamesMatch(normalizedName, existingName));
      const relevanceBoost = relevance.status === 'match' ? 1000 : (relevance.status === 'review' ? -500 : 0);
      const score = Math.round(relevanceBoost + ((normalized.rating || 0) * 20) + Math.log10((normalized.review_count || 0) + 1) * 35);
      return attachPlacePhotoUrl({ ...normalized, relevance, already_added: alreadyAdded, is_own_clinic: isOwnClinic, suggested_score: score }, { maxWidthPx: 640 });
    }));

    const sortedSuggestions = suggestions
      .filter((item) => item.name && !item.is_own_clinic)
      .sort((a, b) => (b.suggested_score || 0) - (a.suggested_score || 0));

    return {
      success: true,
      query: textQuery,
      clinic: clinic ? { id: clinic.id_clinica, name: clinic.nombre_clinica } : null,
      provider_status: await providerStatusForScope(scope),
      suggestions: sortedSuggestions
    };
  } catch (error) {
    return {
      success: false,
      query: textQuery,
      clinic: clinic ? { id: clinic.id_clinica, name: clinic.nombre_clinica } : null,
      provider_status: await providerStatusForScope(scope, { googleError: error }),
      suggestions: [],
      error: normalizeExternalError(error)
    };
  }
    }
  );
}

async function resolveOwnBusinessPlaceIds(scope) {
  if (!ClinicBusinessLocation) return new Set();
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.map(toInt).filter(Boolean) : [];
  if (!clinicIds.length) return new Set();

  const targetClinicIds = new Set(clinicIds);
  const clinics = await Clinica.findAll({
    where: { id_clinica: { [Op.in]: clinicIds } },
    attributes: ['grupoClinicaId'],
    raw: true
  });
  const groupIds = clinics.map((clinic) => toInt(clinic.grupoClinicaId)).filter(Boolean);
  if (groupIds.length) {
    const groupClinics = await Clinica.findAll({
      where: { grupoClinicaId: { [Op.in]: groupIds } },
      attributes: ['id_clinica'],
      raw: true
    });
    for (const clinic of groupClinics) {
      const id = toInt(clinic.id_clinica);
      if (id) targetClinicIds.add(id);
    }
  }

  const rows = await ClinicBusinessLocation.findAll({
    where: { clinica_id: { [Op.in]: [...targetClinicIds] }, is_active: true },
    attributes: ['raw_payload'],
    raw: true
  });

  const ids = new Set();
  for (const row of rows) {
    const placeId = normalizePlaceId(row?.raw_payload?.metadata?.placeId)
      || normalizePlaceId(row?.raw_payload?.placeId)
      || normalizePlaceId(row?.raw_payload?.id);
    if (placeId) ids.add(placeId);
  }
  return ids;
}

function scopeDefaults(scope) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.map(toInt).filter(Boolean) : [];
  if (scope?.scope === 'group' && scope?.groupId) {
    return { grupo_clinica_id: toInt(scope.groupId), clinica_id: null };
  }
  return { clinica_id: clinicIds.length === 1 ? clinicIds[0] : null, grupo_clinica_id: null };
}

async function createCompetitor(scope, payload = {}) {
  const socialProfiles = buildSocialProfilesFromPayload(payload);
  const metaSearchTerms = [...new Set([
    ...splitSearchTerms(payload.meta_ads_search_terms ?? payload.meta_search_terms),
    ...(socialProfiles.instagram_username ? [`@${socialProfiles.instagram_username}`, socialProfiles.instagram_username] : []),
    ...(socialProfiles.facebook_username ? [socialProfiles.facebook_username] : [])
  ].map(cleanString).filter(Boolean))];
  const metaPageUrl = normalizeUrl(payload.meta_page_url) || normalizeUrl(payload.facebook_url) || normalizeUrl(payload.instagram_url);
  const metaPageId = cleanString(payload.meta_page_id) || extractMetaPageIdFromUrl(metaPageUrl);
  const manualPayload = {
    facebook_url: normalizeUrl(payload.facebook_url),
    instagram_url: normalizeUrl(payload.instagram_url),
    notes: cleanString(payload.notes),
    meta_search_terms: metaSearchTerms,
    social_profiles: socialProfiles
  };
  const hasManualPayload = Object.values(manualPayload).some((value) => Array.isArray(value) ? value.length : !!value);
  const normalizedPlace = payload.google_place_id || payload.raw_place_payload ? normalizePlace({
    id: payload.google_place_id,
    displayName: { text: payload.name },
    formattedAddress: payload.address,
    location: { latitude: payload.latitude, longitude: payload.longitude },
    rating: payload.rating,
    userRatingCount: payload.review_count,
    primaryTypeDisplayName: { text: payload.primary_category },
    websiteUri: payload.website_url,
    nationalPhoneNumber: payload.phone,
    googleMapsUri: payload.google_maps_url,
    businessStatus: payload.business_status,
    ...(payload.raw_place_payload || {})
  }) : {};

  const values = {
    ...scopeDefaults(scope),
    source: payload.source || normalizedPlace.source || 'manual',
    name: cleanString(payload.name) || normalizedPlace.name,
    google_place_id: cleanString(payload.google_place_id) || normalizedPlace.google_place_id,
    google_maps_url: normalizeUrl(payload.google_maps_url) || normalizedPlace.google_maps_url,
    website_url: normalizeUrl(payload.website_url) || normalizedPlace.website_url,
    phone: cleanString(payload.phone) || normalizedPlace.phone,
    address: cleanString(payload.address) || normalizedPlace.address,
    city: cleanString(payload.city) || normalizedPlace.city,
    latitude: toNumber(payload.latitude) ?? normalizedPlace.latitude,
    longitude: toNumber(payload.longitude) ?? normalizedPlace.longitude,
    primary_category: cleanString(payload.primary_category) || normalizedPlace.primary_category,
    rating: toNumber(payload.rating) ?? normalizedPlace.rating,
    review_count: toInt(payload.review_count) ?? normalizedPlace.review_count,
    business_status: cleanString(payload.business_status) || normalizedPlace.business_status,
    meta_page_id: metaPageId,
    meta_page_name: cleanString(payload.meta_page_name),
    meta_page_url: metaPageUrl,
    meta_ads_search_terms: metaSearchTerms,
    raw_place_payload: withSocialProfilesInRawPayload(payload.raw_place_payload || normalizedPlace.raw_place_payload || (hasManualPayload ? { manual: manualPayload } : null), socialProfiles),
    is_active: payload.is_active !== false,
    last_sync_status: 'created'
  };

  if (!values.name) {
    const err = new Error('name es obligatorio para crear un competidor');
    err.status = 400;
    throw err;
  }

  const duplicateWhere = buildCompetitorWhere(scope, { includeInactive: true });
  if (values.google_place_id) duplicateWhere.google_place_id = values.google_place_id;
  else duplicateWhere.name = values.name;

  const [competitor, created] = await MarketingCompetitor.findOrCreate({ where: duplicateWhere, defaults: values });
  if (!created) {
    await competitor.update({ ...values, is_active: true, last_sync_status: 'updated' });
  }

  if (competitor.google_place_id || competitor.raw_place_payload) {
    await upsertPlaceSnapshot(competitor, competitor.raw_place_payload);
  }

  clearCompetitionRuntimeCache();
  return mapCompetitorRow(competitor, await MarketingCompetitorSnapshot.findOne({ where: { competitor_id: competitor.id }, order: [['snapshot_date', 'DESC']] }), null);
}

async function updateCompetitor(scope, competitorId, payload = {}) {
  const competitor = await MarketingCompetitor.findOne({
    where: { ...buildCompetitorWhere(scope, { includeInactive: true }), id: competitorId }
  });
  if (!competitor) {
    const err = new Error('Competidor no encontrado');
    err.status = 404;
    throw err;
  }

  const patch = {};
  for (const field of ['name', 'source', 'google_place_id', 'google_maps_url', 'website_url', 'phone', 'address', 'city', 'primary_category', 'business_status', 'meta_page_id', 'meta_page_name', 'meta_page_url', 'last_sync_status', 'last_sync_error']) {
    if (payload[field] !== undefined) patch[field] = cleanString(payload[field]);
  }
  for (const field of ['google_maps_url', 'website_url', 'meta_page_url']) {
    if (payload[field] !== undefined) patch[field] = normalizeUrl(payload[field]);
  }
  if (payload.meta_page_url === undefined && (payload.facebook_url !== undefined || payload.instagram_url !== undefined)) {
    patch.meta_page_url = normalizeUrl(payload.facebook_url) || normalizeUrl(payload.instagram_url);
  }
  if (payload.latitude !== undefined) patch.latitude = toNumber(payload.latitude);
  if (payload.longitude !== undefined) patch.longitude = toNumber(payload.longitude);
  if (payload.rating !== undefined) patch.rating = toNumber(payload.rating);
  if (payload.review_count !== undefined) patch.review_count = toInt(payload.review_count);
  if (payload.meta_ads_search_terms !== undefined) {
    patch.meta_ads_search_terms = Array.isArray(payload.meta_ads_search_terms) ? payload.meta_ads_search_terms.map(cleanString).filter(Boolean) : [];
  }
  const socialProfiles = buildSocialProfilesFromPayload(payload);
  if (Object.keys(socialProfiles).length) {
    patch.raw_place_payload = withSocialProfilesInRawPayload(competitor.raw_place_payload, socialProfiles);
    patch.meta_ads_search_terms = [...new Set([
      ...(patch.meta_ads_search_terms || competitor.meta_ads_search_terms || []),
      ...(socialProfiles.instagram_username ? [`@${socialProfiles.instagram_username}`, socialProfiles.instagram_username] : []),
      ...(socialProfiles.facebook_username ? [socialProfiles.facebook_username] : [])
    ].map(cleanString).filter(Boolean))];
    if (!patch.meta_page_url && socialProfiles.facebook_url) patch.meta_page_url = socialProfiles.facebook_url;
  }
  if (!patch.meta_page_id && (payload.meta_page_url !== undefined || payload.facebook_url !== undefined || payload.instagram_url !== undefined)) {
    patch.meta_page_id = extractMetaPageIdFromUrl(patch.meta_page_url || payload.facebook_url || payload.instagram_url);
  }
  if (payload.is_active !== undefined) patch.is_active = !!payload.is_active;

  await competitor.update(patch);
  clearCompetitionRuntimeCache();
  return mapCompetitorRow(competitor, null, null);
}

async function deactivateCompetitor(scope, competitorId) {
  const competitor = await MarketingCompetitor.findOne({
    where: { ...buildCompetitorWhere(scope, { includeInactive: true }), id: competitorId }
  });
  if (!competitor) {
    const err = new Error('Competidor no encontrado');
    err.status = 404;
    throw err;
  }
  await competitor.update({ is_active: false, last_sync_status: 'deactivated' });
  clearCompetitionRuntimeCache();
  return { success: true, id: competitor.id, is_active: false };
}

async function refreshOneCompetitor(competitor, scope) {
  const report = {
    competitor_id: competitor.id,
    name: competitor.name,
    places: { status: 'skipped' },
    meta_ads_library: { status: 'skipped' },
    google_ads_transparency: { status: 'skipped' }
  };
  const patch = { last_sync_status: 'completed', last_sync_error: null };

  if (competitor.google_place_id) {
    try {
      const place = await getGooglePlaceDetails(competitor.google_place_id, { bypassCache: true });
      const normalized = normalizePlace(place);
      const socialProfiles = await discoverSocialProfiles(competitor, {
        website_url: normalized.website_url,
        facebook_url: competitor.meta_page_url,
        raw_place_payload: place
      });
      Object.assign(patch, {
        google_maps_url: normalized.google_maps_url,
        website_url: normalized.website_url,
        phone: normalized.phone,
        address: normalized.address,
        latitude: normalized.latitude,
        longitude: normalized.longitude,
        primary_category: normalized.primary_category,
        rating: normalized.rating,
        review_count: normalized.review_count,
        business_status: normalized.business_status,
        raw_place_payload: withSocialProfilesInRawPayload(place, socialProfiles),
        last_places_synced_at: new Date()
      });
      if (socialProfiles) {
        patch.meta_ads_search_terms = metaTermsFromCompetitor({ ...competitor.toJSON(), ...patch }, socialProfiles);
        if (!patch.meta_page_url && socialProfiles.facebook_url) patch.meta_page_url = socialProfiles.facebook_url;
        if (!patch.meta_page_id && patch.meta_page_url) patch.meta_page_id = extractMetaPageIdFromUrl(patch.meta_page_url);
      }
      await competitor.update(patch);
      await upsertPlaceSnapshot(competitor, place);
      report.places = { status: 'completed' };
    } catch (error) {
      const normalizedError = normalizeExternalError(error);
      report.places = { status: 'unavailable', error: normalizedError };
      patch.last_sync_status = 'partial_error';
      patch.last_sync_error = normalizedError.message;
    }
  } else {
    const socialProfiles = await discoverSocialProfiles(competitor, {
      website_url: competitor.website_url,
      facebook_url: competitor.meta_page_url
    });
    if (socialProfiles) {
      patch.raw_place_payload = withSocialProfilesInRawPayload(competitor.raw_place_payload, socialProfiles);
      patch.meta_ads_search_terms = metaTermsFromCompetitor({ ...competitor.toJSON(), ...patch }, socialProfiles);
      if (!patch.meta_page_url && socialProfiles.facebook_url) patch.meta_page_url = socialProfiles.facebook_url;
      if (!patch.meta_page_id && patch.meta_page_url) patch.meta_page_id = extractMetaPageIdFromUrl(patch.meta_page_url);
      await competitor.update(patch);
    }
  }

  const competitorForAds = { ...competitor.toJSON(), ...patch };

  try {
    const metaResult = await fetchMetaAdsForCompetitor(competitorForAds, scope);
    await upsertAdsSnapshot(competitor, { status: 'completed', ads: metaResult.ads, raw: metaResult.raw });
    report.meta_ads_library = {
      status: 'completed',
      ads_count: metaResult.ads.length,
      visible_ads_count: metaResult.ads.length,
      token_source: metaResult.tokenSource
    };
    if (metaResult.resolvedPage?.page_id && !cleanString(competitor.meta_page_id)) {
      patch.meta_page_id = metaResult.resolvedPage.page_id;
    }
    if (metaResult.resolvedPage?.page_name && !cleanString(competitor.meta_page_name)) {
      patch.meta_page_name = metaResult.resolvedPage.page_name;
    }
    if (metaResult.resolvedPage?.page_url && !cleanString(competitor.meta_page_url)) {
      patch.meta_page_url = metaResult.resolvedPage.page_url;
    }
    if (metaResult.socialProfiles) {
      patch.raw_place_payload = withSocialProfilesInRawPayload(patch.raw_place_payload || competitor.raw_place_payload, metaResult.socialProfiles);
    }
    patch.last_ads_synced_at = new Date();
  } catch (error) {
    const normalizedError = normalizeExternalError(error);
    await upsertAdsSnapshot(competitor, {
      status: 'unavailable',
      ads: [],
      error_code: normalizedError.code,
      error_message: normalizedError.message,
      raw: normalizedError
    });
    report.meta_ads_library = { status: 'unavailable', error: normalizedError };
    patch.last_sync_status = patch.last_sync_status === 'partial_error' ? 'error' : 'partial_error';
    patch.last_sync_error = normalizedError.message;
    patch.last_ads_synced_at = new Date();
  }

  if (isGoogleAdsTransparencyEnabled()) {
    try {
      const googleResult = await fetchGoogleAdsTransparencyForCompetitor({ ...competitorForAds, ...patch });
      await upsertProviderAdsSnapshot(competitor, GOOGLE_ADS_TRANSPARENCY_PROVIDER, {
        status: 'completed',
        ads: googleResult.ads,
        total_ads_count: googleResult.total_ads_count,
        raw: googleResult.raw
      });
      report.google_ads_transparency = {
        status: 'completed',
        ads_count: googleResult.total_ads_count || googleResult.ads.length,
        visible_ads_count: googleResult.ads.length,
        resolved: googleResult.resolved
      };
    } catch (error) {
      const normalizedError = normalizeExternalError(error);
      await upsertProviderAdsSnapshot(competitor, GOOGLE_ADS_TRANSPARENCY_PROVIDER, {
        status: 'unavailable',
        ads: [],
        error_code: normalizedError.code,
        error_message: normalizedError.message,
        raw: normalizedError
      });
      report.google_ads_transparency = { status: 'unavailable', error: normalizedError };
      patch.last_sync_status = patch.last_sync_status === 'partial_error' ? 'error' : 'partial_error';
      patch.last_sync_error = normalizedError.message;
    }
  }

  await competitor.update(patch);
  return report;
}

async function refreshCompetition(scope, { competitorIds = null } = {}) {
  resetMetaBrowserBatchMetrics();
  const where = buildCompetitorWhere(scope);
  const ids = Array.isArray(competitorIds) ? competitorIds.map(toInt).filter(Boolean) : [];
  if (ids.length) where.id = { [Op.in]: ids };

  const competitors = await MarketingCompetitor.findAll({ where, order: [['id', 'ASC']] });
  const report = {
    provider: {
      google_places: { configured: !!getGooglePlacesApiKey() },
      meta_ads_library: { configured: !!getMetaAdLibraryTokenFromEnv() },
      google_ads_transparency: { configured: isGoogleAdsTransparencyEnabled() },
      meta_browser_media: cloneMetaBrowserMetrics()
    },
    competitors: competitors.length,
    processed: 0,
    completed: 0,
    partial: 0,
    errors: []
  };

  for (const competitor of competitors) {
    const item = await refreshOneCompetitor(competitor, scope);
    report.processed += 1;
    if (
      item.places.status === 'completed'
      || item.meta_ads_library.status === 'completed'
      || item.google_ads_transparency.status === 'completed'
    ) report.completed += 1;
    if (
      item.places.status === 'unavailable'
      || item.meta_ads_library.status === 'unavailable'
      || item.google_ads_transparency.status === 'unavailable'
    ) {
      report.partial += 1;
      report.errors.push(item);
    }
  }

  report.provider.meta_browser_media = cloneMetaBrowserMetrics();
  clearCompetitionRuntimeCache();

  return { success: true, report };
}

module.exports = {
  listCompetition,
  suggestCompetitors,
  createCompetitor,
  updateCompetitor,
  deactivateCompetitor,
  refreshCompetition,
  getLocalRankingHeatmap,
  providerStatus,
};
