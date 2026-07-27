'use strict';

const axios = require('axios');
const { publicHttpUrl, resolveSafeHttpTarget } = require('../lib/safeHttpTarget');

const GOOGLE_PLACES_API_BASE = 'https://places.googleapis.com/v1';
const DEFAULT_LANGUAGE = process.env.COMPETITION_GOOGLE_LANGUAGE || 'es';
const DEFAULT_REGION = process.env.COMPETITION_GOOGLE_REGION || 'ES';
const GOOGLE_PROFILE_REDIRECT_LIMIT = 6;
const GOOGLE_PROFILE_REDIRECT_TIMEOUT_MS = 10000;
const GOOGLE_PROFILE_ALLOWED_HOSTS = new Set([
  'share.google',
  'maps.app.goo.gl',
  'goo.gl',
  'google.com',
  'www.google.com',
  'maps.google.com',
  'consent.google.com',
  'google.es',
  'www.google.es',
  'maps.google.es',
]);
const GOOGLE_PROFILE_RESOLUTION_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.addressComponents',
  'places.location',
  'places.primaryType',
  'places.primaryTypeDisplayName',
  'places.types',
  'places.websiteUri',
  'places.googleMapsUri',
  'places.businessStatus',
].join(',');
const GOOGLE_PROFILE_DETAILS_FIELD_MASK = GOOGLE_PROFILE_RESOLUTION_FIELD_MASK
  .split(',')
  .map((field) => field.replace(/^places\./, ''))
  .join(',');

function resolverError(code, message, details = null) {
  const error = new Error(message);
  error.code = code;
  if (details) error.details = details;
  return error;
}

function cleanString(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text || null;
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

function namesMatch(left, right) {
  const normalizedLeft = normalizeBusinessName(left);
  const normalizedRight = normalizeBusinessName(right);
  if (!normalizedLeft || !normalizedRight) return false;
  if (normalizedLeft === normalizedRight) return true;
  const minLength = Math.min(normalizedLeft.length, normalizedRight.length);
  return minLength >= 6
    && (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft));
}

function domainFromUrl(value) {
  try {
    return new URL(String(value || '')).hostname.replace(/^www\./i, '').toLowerCase() || null;
  } catch (_) {
    return null;
  }
}

function normalizeGoogleProfileUrl(value) {
  const normalized = publicHttpUrl(String(value || ''), { requireHttps: true });
  if (!normalized) {
    throw resolverError(
      'GOOGLE_PROFILE_URL_INVALID',
      'La URL de la ficha local no es una URL HTTPS pública válida.',
    );
  }
  const host = new URL(normalized).hostname.toLowerCase();
  if (!GOOGLE_PROFILE_ALLOWED_HOSTS.has(host)) {
    throw resolverError(
      'GOOGLE_PROFILE_URL_HOST_NOT_ALLOWED',
      'La URL de la ficha local debe pertenecer a Google Maps o Google Search.',
      { host },
    );
  }
  return normalized;
}

async function fetchGoogleRedirectStep(url, dependencies = {}) {
  const resolveTarget = dependencies.resolveTarget || resolveSafeHttpTarget;
  const httpGet = dependencies.httpGet || axios.get;
  const target = await resolveTarget(normalizeGoogleProfileUrl(url));
  const response = await httpGet(target.url, {
    timeout: GOOGLE_PROFILE_REDIRECT_TIMEOUT_MS,
    maxRedirects: 0,
    responseType: 'stream',
    validateStatus: (status) => status >= 200 && status < 400,
    httpAgent: target.httpAgent,
    httpsAgent: target.httpsAgent,
    headers: {
      'User-Agent': 'ClinicaClick-GoogleProfileResolver/1.0',
      Accept: 'text/html,application/xhtml+xml',
    },
  });
  if (typeof response?.data?.destroy === 'function') response.data.destroy();
  return {
    status: Number(response?.status) || 0,
    location: cleanString(response?.headers?.location),
  };
}

async function followGoogleProfileUrl(value, dependencies = {}) {
  const fetchStep = dependencies.fetchStep || fetchGoogleRedirectStep;
  let current = normalizeGoogleProfileUrl(value);
  const visited = new Set();

  for (let index = 0; index <= GOOGLE_PROFILE_REDIRECT_LIMIT; index += 1) {
    if (visited.has(current)) {
      throw resolverError('GOOGLE_PROFILE_URL_REDIRECT_LOOP', 'La URL de Google entra en un bucle de redirecciones.');
    }
    visited.add(current);
    const step = await fetchStep(current);
    if (step.status >= 200 && step.status < 300) return current;
    if (step.status < 300 || step.status >= 400 || !step.location) {
      throw resolverError(
        'GOOGLE_PROFILE_URL_REDIRECT_INVALID',
        'Google no devolvió una redirección utilizable para esta ficha local.',
      );
    }
    const next = new URL(step.location, current).toString();
    current = normalizeGoogleProfileUrl(next);
  }

  throw resolverError(
    'GOOGLE_PROFILE_URL_REDIRECT_LIMIT',
    'La URL de Google supera el máximo de redirecciones permitido.',
  );
}

function parseGoogleProfileUrlIdentity(value) {
  const url = normalizeGoogleProfileUrl(value);
  const parsed = new URL(url);
  const query = cleanString(
    parsed.searchParams.get('q')
    || parsed.searchParams.get('query')
    || parsed.searchParams.get('destination'),
  );
  const googleEntityId = cleanString(
    parsed.searchParams.get('kgmid')
    || parsed.searchParams.get('ludocid')
    || parsed.searchParams.get('cid'),
  );
  const queryPlaceId = cleanString(
    parsed.searchParams.get('query_place_id')
    || parsed.searchParams.get('destination_place_id'),
  );
  const pathPlaceId = decodeURIComponent(parsed.pathname)
    .match(/!1s((?:ChI|GhI)[^!/?&]+)/)?.[1] || null;
  const coordinateMatch = decodeURIComponent(parsed.pathname)
    .match(/@(-?\d{1,2}(?:\.\d+)?),(-?\d{1,3}(?:\.\d+)?)/);

  return {
    url,
    query,
    google_entity_id: googleEntityId,
    place_id: queryPlaceId || pathPlaceId,
    latitude: coordinateMatch ? Number(coordinateMatch[1]) : null,
    longitude: coordinateMatch ? Number(coordinateMatch[2]) : null,
  };
}

function addressComponent(place, types) {
  const components = Array.isArray(place?.addressComponents) ? place.addressComponents : [];
  const component = types
    .map((expectedType) => components.find((item) => (
      Array.isArray(item?.types) && item.types.includes(expectedType)
    )))
    .find(Boolean);
  return {
    long: cleanString(component?.longText || component?.long_name),
    short: cleanString(component?.shortText || component?.short_name),
  };
}

function googlePlaceAddress(place) {
  const locality = addressComponent(place, ['locality', 'postal_town']);
  const administrativeArea = addressComponent(place, [
    'administrative_area_level_2',
    'administrative_area_level_1',
  ]);
  const postalCode = addressComponent(place, ['postal_code']);
  const country = addressComponent(place, ['country']);
  return {
    address: cleanString(place?.formattedAddress),
    locality: locality.long,
    administrative_area: administrativeArea.long,
    postal_code: postalCode.long,
    country: country.short || country.long,
  };
}

function placeDisplayName(place) {
  return cleanString(place?.displayName?.text || place?.displayName);
}

function selectGoogleProfilePlace(places, context = {}) {
  const clinicName = cleanString(context.clinicName);
  const redirectedQuery = cleanString(context.redirectedQuery);
  const clinicDomain = domainFromUrl(context.websiteUrl);
  const locationHint = normalizeBusinessName(context.locationHint);

  const ranked = (Array.isArray(places) ? places : [])
    .map((place, index) => {
      const name = placeDisplayName(place);
      const websiteDomain = domainFromUrl(place?.websiteUri);
      const address = normalizeBusinessName(place?.formattedAddress);
      const queryMatch = namesMatch(name, redirectedQuery);
      const clinicNameMatch = namesMatch(name, clinicName);
      const websiteMatch = !!clinicDomain && websiteDomain === clinicDomain;
      const locationMatch = !!locationHint && !!address && address.includes(locationHint);
      const score = (websiteMatch ? 160 : 0)
        + (queryMatch ? 100 : 0)
        + (clinicNameMatch ? 80 : 0)
        + (locationMatch ? 40 : 0)
        - index;
      return {
        place,
        name,
        score,
        websiteMatch,
        queryMatch,
        clinicNameMatch,
      };
    })
    .filter((item) => item.name && cleanString(item.place?.id))
    .sort((left, right) => right.score - left.score);

  const best = ranked[0] || null;
  const second = ranked[1] || null;
  const strongIdentity = !!best && (
    best.websiteMatch
    || (best.queryMatch && best.clinicNameMatch)
  );
  const uniqueEnough = !second
    || best.websiteMatch
    || best.score - second.score >= 20;
  if (!best || !strongIdentity || !uniqueEnough) {
    throw resolverError(
      'GOOGLE_PROFILE_URL_AMBIGUOUS',
      'La URL abre Google, pero no permite identificar una única ficha local con suficiente seguridad.',
    );
  }
  return best.place;
}

function normalizeResolvedPlace(place, context = {}) {
  const location = place?.location || {};
  const address = googlePlaceAddress(place);
  const primaryCategory = cleanString(
    place?.primaryTypeDisplayName?.text
    || place?.primaryTypeDisplayName
    || place?.primaryType,
  );
  return {
    source: 'google_profile_url',
    source_url: context.sourceUrl,
    resolved_url: context.resolvedUrl,
    google_entity_id: context.googleEntityId || null,
    place_id: cleanString(place?.id),
    name: placeDisplayName(place),
    maps_url: cleanString(place?.googleMapsUri),
    primary_category: primaryCategory,
    website_url: cleanString(place?.websiteUri),
    business_status: cleanString(place?.businessStatus),
    latitude: Number.isFinite(Number(location.latitude)) ? Number(location.latitude) : null,
    longitude: Number.isFinite(Number(location.longitude)) ? Number(location.longitude) : null,
    ...address,
  };
}

async function resolveGoogleLocalProfileUrl(input, dependencies = {}) {
  const sourceUrl = normalizeGoogleProfileUrl(input?.url);
  const followUrl = dependencies.followUrl || followGoogleProfileUrl;
  const placesPost = dependencies.placesPost || axios.post;
  const placesGet = dependencies.placesGet || axios.get;
  const apiKey = cleanString(input?.apiKey);
  if (!apiKey) {
    throw resolverError(
      'GOOGLE_PROFILE_URL_PROVIDER_NOT_CONFIGURED',
      'Falta una clave de Google Places para resolver la ficha local.',
    );
  }

  const resolvedUrl = await followUrl(sourceUrl);
  const redirectIdentity = parseGoogleProfileUrlIdentity(resolvedUrl);
  let place;

  if (redirectIdentity.place_id) {
    const response = await placesGet(
      `${GOOGLE_PLACES_API_BASE}/places/${encodeURIComponent(redirectIdentity.place_id)}`,
      {
        timeout: 15000,
        headers: {
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': GOOGLE_PROFILE_DETAILS_FIELD_MASK,
        },
      },
    );
    place = response?.data || null;
  } else {
    const textQuery = redirectIdentity.query || cleanString(input?.clinicName);
    if (!textQuery) {
      throw resolverError(
        'GOOGLE_PROFILE_URL_QUERY_MISSING',
        'La URL de Google no contiene un nombre ni un Place ID que se pueda resolver.',
      );
    }
    const response = await placesPost(
      `${GOOGLE_PLACES_API_BASE}/places:searchText`,
      {
        textQuery,
        languageCode: DEFAULT_LANGUAGE,
        regionCode: DEFAULT_REGION,
        pageSize: 5,
      },
      {
        timeout: 15000,
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': GOOGLE_PROFILE_RESOLUTION_FIELD_MASK,
        },
      },
    );
    place = selectGoogleProfilePlace(response?.data?.places, {
      clinicName: input?.clinicName,
      redirectedQuery: redirectIdentity.query,
      websiteUrl: input?.websiteUrl,
      locationHint: input?.locationHint,
    });
  }

  if (!place || !cleanString(place.id)) {
    throw resolverError(
      'GOOGLE_PROFILE_URL_PLACE_NOT_FOUND',
      'Google no devolvió una ficha local válida para esta URL.',
    );
  }

  return normalizeResolvedPlace(place, {
    sourceUrl,
    resolvedUrl,
    googleEntityId: redirectIdentity.google_entity_id,
  });
}

module.exports = {
  GOOGLE_PROFILE_ALLOWED_HOSTS,
  GOOGLE_PROFILE_DETAILS_FIELD_MASK,
  GOOGLE_PROFILE_RESOLUTION_FIELD_MASK,
  followGoogleProfileUrl,
  googlePlaceAddress,
  normalizeGoogleProfileUrl,
  normalizeResolvedPlace,
  parseGoogleProfileUrlIdentity,
  resolveGoogleLocalProfileUrl,
  selectGoogleProfilePlace,
  __testing: {
    fetchGoogleRedirectStep,
    namesMatch,
  },
};
