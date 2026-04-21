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
const DEFAULT_COUNTRY = process.env.COMPETITION_META_AD_COUNTRY || 'ES';
const DEFAULT_LANGUAGE = process.env.COMPETITION_GOOGLE_LANGUAGE || 'es';
const DEFAULT_REGION = process.env.COMPETITION_GOOGLE_REGION || 'ES';
const DEFAULT_LIMIT = Math.max(1, Math.min(25, parseInt(process.env.COMPETITION_SUGGESTION_LIMIT || '10', 10)));
const DEFAULT_AD_LIMIT = Math.max(1, Math.min(100, parseInt(process.env.COMPETITION_META_AD_LIMIT || '25', 10)));
const SNAPSHOT_MEDIA_TIMEOUT_MS = Math.max(1000, Math.min(15000, parseInt(process.env.COMPETITION_META_SNAPSHOT_MEDIA_TIMEOUT_MS || '6000', 10)));
const SNAPSHOT_MEDIA_LIMIT = Math.max(0, Math.min(DEFAULT_AD_LIMIT, parseInt(process.env.COMPETITION_META_SNAPSHOT_MEDIA_LIMIT || String(DEFAULT_AD_LIMIT), 10)));

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

function extractFirstMediaFromHtml(html) {
  const text = String(html || '');
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

  if (video || image) return { video_url: video, image_url: image, thumbnail_url: image };

  const videoMatch = text.match(/<(?:video|source)\b[^>]*\bsrc\s*=\s*(['"])(.*?)\1/i);
  const rawVideo = normalizeUrl(decodeHtmlEntities(videoMatch?.[2] || ''));
  return rawVideo ? { video_url: rawVideo, image_url: null, thumbnail_url: null } : null;
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
      note: 'Se usa Meta Ads Library oficial y, si existe snapshot público, se intenta extraer una previsualización visual best-effort. Si no hay media, la UI muestra enlace a Meta.'
    }
  };
}

async function providerStatusForScope(scope, options = {}) {
  let metaTokenSource = null;
  try {
    const resolved = await resolveMetaAdLibraryToken(scope);
    metaTokenSource = resolved?.accessToken ? resolved.source : null;
  } catch (_) {
    metaTokenSource = null;
  }
  return providerStatus({ ...options, metaTokenSource });
}

function getGooglePlacesApiKey() {
  return process.env.GOOGLE_PLACES_API_KEY || process.env.GOOGLE_MAPS_API_KEY || process.env.GOOGLE_API_KEY || null;
}

function getMetaAdLibraryTokenFromEnv() {
  return process.env.META_AD_LIBRARY_ACCESS_TOKEN || null;
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
    google_maps_url: normalizeUrl(place.googleMapsUri),
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
  return cleanString(clinic?.business_primary_category)
    || disciplineSearchHint(clinic)
    || cleanString(clinic?.servicios)
    || cleanString(clinic?.descripcion)?.split(/[.,;]/)[0]
    || null;
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

function disciplineSearchHint(clinic) {
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
    trasplante_capilar: 'trasplante capilar'
  };
  const match = disciplinas.map((item) => map[String(item || '').toLowerCase()]).find(Boolean);
  return match || null;
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

async function searchGooglePlaces({ query, maxResultCount = DEFAULT_LIMIT }) {
  const body = {
    textQuery: query,
    languageCode: DEFAULT_LANGUAGE,
    regionCode: DEFAULT_REGION,
    maxResultCount
  };
  const response = await axios.post(`${GOOGLE_PLACES_API_BASE}/places:searchText`, body, {
    headers: buildPlaceHeaders(PLACE_FIELD_MASK),
    timeout: 15000
  });
  return Array.isArray(response.data?.places) ? response.data.places : [];
}

async function getGooglePlaceDetails(placeId) {
  if (!placeId) return null;
  const response = await axios.get(`${GOOGLE_PLACES_API_BASE}/places/${encodeURIComponent(placeId)}`, {
    headers: buildPlaceHeaders(PLACE_DETAILS_FIELD_MASK),
    timeout: 15000
  });
  return response.data || null;
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

function normalizeMetaAd(ad = {}) {
  const bodies = Array.isArray(ad.ad_creative_bodies) ? ad.ad_creative_bodies : [];
  const titles = Array.isArray(ad.ad_creative_link_titles) ? ad.ad_creative_link_titles : [];
  const descriptions = Array.isArray(ad.ad_creative_link_descriptions) ? ad.ad_creative_link_descriptions : [];
  const urls = Array.isArray(ad.ad_creative_link_urls) ? ad.ad_creative_link_urls : [];
  return {
    id: cleanString(ad.id),
    page_id: cleanString(ad.page_id),
    page_name: cleanString(ad.page_name),
    body: cleanString(bodies[0]),
    title: cleanString(titles[0]),
    description: cleanString(descriptions[0]),
    landing_url: normalizeUrl(urls[0]),
    snapshot_url: normalizeUrl(ad.ad_snapshot_url),
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

async function enrichAdWithSnapshotMedia(ad = {}) {
  const snapshotUrl = normalizeUrl(ad.snapshot_url);
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
      media_source: 'snapshot_html'
    };
  } catch (error) {
    return {
      ...ad,
      media_source: 'snapshot_unavailable',
      media_error: error?.response?.status ? `HTTP ${error.response.status}` : (error?.code || error?.message || 'snapshot_unavailable')
    };
  }
}

async function enrichAdsWithSnapshotMedia(ads = []) {
  if (!SNAPSHOT_MEDIA_LIMIT || !Array.isArray(ads) || !ads.length) return ads;
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
  return enriched;
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

  const params = {
    fields: META_AD_FIELDS,
    ad_type: 'ALL',
    ad_active_status: 'ACTIVE',
    ad_reached_countries: JSON.stringify([DEFAULT_COUNTRY]),
    limit: DEFAULT_AD_LIMIT
  };

  if (competitor.meta_page_id) {
    params.search_page_ids = JSON.stringify([String(competitor.meta_page_id)]);
  } else {
    params.search_terms = searchTerms[0] || fallbackTerm;
    params.search_type = 'KEYWORD_UNORDERED';
  }

  const response = await metaGet('ads_archive', { params, accessToken, timeout: 30000 });
  const data = Array.isArray(response.data?.data) ? response.data.data : [];
  const ads = data.map(normalizeMetaAd);
  return {
    tokenSource: source,
    raw: response.data,
    ads: await enrichAdsWithSnapshotMedia(ads)
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
  const snapshotDate = todayLabel();
  const values = {
    provider: META_ADS_LIBRARY_PROVIDER,
    status: result.status || 'completed',
    ads_count: Array.isArray(result.ads) ? result.ads.length : 0,
    active_ads: Array.isArray(result.ads) ? result.ads : [],
    error_code: result.error_code || null,
    error_message: result.error_message || null,
    raw_payload: result.raw || null
  };
  const [snapshot, created] = await MarketingCompetitorAdSnapshot.findOrCreate({
    where: { competitor_id: competitor.id, provider: META_ADS_LIBRARY_PROVIDER, snapshot_date: snapshotDate },
    defaults: values
  });
  if (!created) await snapshot.update(values);
  return snapshot;
}

function mapCompetitorRow(row, latestSnapshot = null, latestAdSnapshot = null) {
  const plain = typeof row.toJSON === 'function' ? row.toJSON() : row;
  const snapshot = latestSnapshot && typeof latestSnapshot.toJSON === 'function' ? latestSnapshot.toJSON() : latestSnapshot;
  const ads = latestAdSnapshot && typeof latestAdSnapshot.toJSON === 'function' ? latestAdSnapshot.toJSON() : latestAdSnapshot;
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
      maps_url: plain.google_maps_url,
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
      ads_status: ads?.status || null,
      active_ads_count: ads?.ads_count != null ? Number(ads.ads_count) : null,
      active_ads: Array.isArray(ads?.active_ads) ? ads.active_ads : [],
      error_code: ads?.error_code || null,
      error_message: ads?.error_message || null,
      last_synced_at: plain.last_ads_synced_at
    },
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
    const [snapshot, adSnapshot] = await Promise.all([
      MarketingCompetitorSnapshot.findOne({ where: { competitor_id: row.id }, order: [['snapshot_date', 'DESC'], ['id', 'DESC']] }),
      MarketingCompetitorAdSnapshot.findOne({ where: { competitor_id: row.id, provider: META_ADS_LIBRARY_PROVIDER }, order: [['snapshot_date', 'DESC'], ['id', 'DESC']] })
    ]);
    hydrated.push(await attachPlacePhotoUrl(mapCompetitorRow(row, snapshot, adSnapshot), { maxWidthPx: 640 }));
  }
  return hydrated;
}

async function listCompetition(scope, { includeInactive = false } = {}) {
  const rows = await MarketingCompetitor.findAll({
    where: buildCompetitorWhere(scope, { includeInactive }),
    order: [['is_active', 'DESC'], ['review_count', 'DESC'], ['rating', 'DESC'], ['name', 'ASC']]
  });
  const competitors = await hydrateCompetitors(rows);
  return {
    success: true,
    mode: 'real_v1',
    setup: {
      has_competitors: competitors.some((item) => item.is_active),
      refresh_frequency: 'weekly',
      first_setup_requires_google_places: true,
      ads_provider: META_ADS_LIBRARY_PROVIDER
    },
    provider_status: await providerStatusForScope(scope),
    competitors
  };
}

async function suggestCompetitors(scope, { query = null, limit = DEFAULT_LIMIT } = {}) {
  const clinic = await resolvePrimaryClinic(scope);
  const setupBlocker = competitionSetupBlocker(clinic, query);
  if (setupBlocker) {
    const payload = buildSetupRequiredPayload(scope, clinic, setupBlocker, query);
    payload.provider_status = await providerStatusForScope(scope);
    return payload;
  }

  const textQuery = inferCompetitionQuery(clinic, query);
  const existing = await MarketingCompetitor.findAll({ where: buildCompetitorWhere(scope, { includeInactive: true }), raw: true });
  const existingPlaceIds = new Set(existing.map((item) => normalizePlaceId(item.google_place_id)).filter(Boolean));
  const existingNames = new Set(existing.map((item) => normalizeBusinessName(item.name)).filter(Boolean));
  const ownNames = new Set([
    normalizeBusinessName(clinic?.nombre_clinica),
    normalizeBusinessName(clinic?.business_location_name)
  ].filter(Boolean));
  const ownPlaceIds = await resolveOwnBusinessPlaceIds(scope);

  try {
    const places = await searchGooglePlaces({ query: textQuery, maxResultCount: Math.max(1, Math.min(20, Number(limit) || DEFAULT_LIMIT)) });
    const suggestions = await Promise.all(places.map(async (place) => {
      const normalized = normalizePlace(place);
      const normalizedPlaceId = normalizePlaceId(normalized.google_place_id);
      const normalizedName = normalizeBusinessName(normalized.name);
      const isOwnClinic = (normalizedPlaceId && ownPlaceIds.has(normalizedPlaceId))
        || [...ownNames].some((ownName) => businessNamesMatch(normalizedName, ownName));
      const alreadyAdded = isOwnClinic
        || (normalizedPlaceId && existingPlaceIds.has(normalizedPlaceId))
        || [...existingNames].some((existingName) => businessNamesMatch(normalizedName, existingName));
      const score = Math.round(((normalized.rating || 0) * 20) + Math.log10((normalized.review_count || 0) + 1) * 35);
      return attachPlacePhotoUrl({ ...normalized, already_added: alreadyAdded, suggested_score: score }, { maxWidthPx: 640 });
    }));

    return {
      success: true,
      query: textQuery,
      clinic: clinic ? { id: clinic.id_clinica, name: clinic.nombre_clinica } : null,
      provider_status: await providerStatusForScope(scope),
      suggestions: suggestions.filter((item) => item.name)
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
    const placeId = normalizePlaceId(row?.raw_payload?.metadata?.placeId);
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
  const metaSearchTerms = splitSearchTerms(payload.meta_ads_search_terms ?? payload.meta_search_terms);
  const manualPayload = {
    facebook_url: normalizeUrl(payload.facebook_url),
    instagram_url: normalizeUrl(payload.instagram_url),
    notes: cleanString(payload.notes),
    meta_search_terms: metaSearchTerms
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
    meta_page_id: cleanString(payload.meta_page_id),
    meta_page_name: cleanString(payload.meta_page_name),
    meta_page_url: normalizeUrl(payload.meta_page_url) || manualPayload.facebook_url || manualPayload.instagram_url,
    meta_ads_search_terms: metaSearchTerms,
    raw_place_payload: payload.raw_place_payload || normalizedPlace.raw_place_payload || (hasManualPayload ? { manual: manualPayload } : null),
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
  if (payload.latitude !== undefined) patch.latitude = toNumber(payload.latitude);
  if (payload.longitude !== undefined) patch.longitude = toNumber(payload.longitude);
  if (payload.rating !== undefined) patch.rating = toNumber(payload.rating);
  if (payload.review_count !== undefined) patch.review_count = toInt(payload.review_count);
  if (payload.meta_ads_search_terms !== undefined) {
    patch.meta_ads_search_terms = Array.isArray(payload.meta_ads_search_terms) ? payload.meta_ads_search_terms.map(cleanString).filter(Boolean) : [];
  }
  if (payload.is_active !== undefined) patch.is_active = !!payload.is_active;

  await competitor.update(patch);
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
  return { success: true, id: competitor.id, is_active: false };
}

async function refreshOneCompetitor(competitor, scope) {
  const report = {
    competitor_id: competitor.id,
    name: competitor.name,
    places: { status: 'skipped' },
    meta_ads_library: { status: 'skipped' }
  };
  const patch = { last_sync_status: 'completed', last_sync_error: null };

  if (competitor.google_place_id) {
    try {
      const place = await getGooglePlaceDetails(competitor.google_place_id);
      const normalized = normalizePlace(place);
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
        raw_place_payload: place,
        last_places_synced_at: new Date()
      });
      await competitor.update(patch);
      await upsertPlaceSnapshot(competitor, place);
      report.places = { status: 'completed' };
    } catch (error) {
      const normalizedError = normalizeExternalError(error);
      report.places = { status: 'unavailable', error: normalizedError };
      patch.last_sync_status = 'partial_error';
      patch.last_sync_error = normalizedError.message;
    }
  }

  try {
    const metaResult = await fetchMetaAdsForCompetitor(competitor, scope);
    await upsertAdsSnapshot(competitor, { status: 'completed', ads: metaResult.ads, raw: metaResult.raw });
    report.meta_ads_library = {
      status: 'completed',
      ads_count: metaResult.ads.length,
      token_source: metaResult.tokenSource
    };
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

  await competitor.update(patch);
  return report;
}

async function refreshCompetition(scope, { competitorIds = null } = {}) {
  const where = buildCompetitorWhere(scope);
  const ids = Array.isArray(competitorIds) ? competitorIds.map(toInt).filter(Boolean) : [];
  if (ids.length) where.id = { [Op.in]: ids };

  const competitors = await MarketingCompetitor.findAll({ where, order: [['id', 'ASC']] });
  const report = {
    provider: {
      google_places: { configured: !!getGooglePlacesApiKey() },
      meta_ads_library: { configured: !!getMetaAdLibraryTokenFromEnv() }
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
    if (item.places.status === 'completed' || item.meta_ads_library.status === 'completed') report.completed += 1;
    if (item.places.status === 'unavailable' || item.meta_ads_library.status === 'unavailable') {
      report.partial += 1;
      report.errors.push(item);
    }
  }

  return { success: true, report };
}

module.exports = {
  listCompetition,
  suggestCompetitors,
  createCompetitor,
  updateCompetitor,
  deactivateCompetitor,
  refreshCompetition,
  providerStatus,
};
