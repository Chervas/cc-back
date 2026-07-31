'use strict';

const axios = require('axios');
const { Op, fn, col, literal } = require('sequelize');
const db = require('../../models');
const {
  resolveEffectiveMarketingAssetInventory,
} = require('./effectiveMarketingAssets.service');
const {
  DEFAULT_TIME_ZONE,
  resolveClinicTimeZone,
} = require('./clinicOpeningHours.service');

const {
  ClinicBusinessLocation,
  BusinessProfileDailyMetric,
  BusinessProfileReview,
  BusinessProfilePost,
  GoogleConnection,
  PublicMediaAsset,
  GroupAssetClinicAssignment,
  Clinica,
  ClinicaHorario,
  sequelize,
} = db;

const GOOGLE_MY_BUSINESS_API = 'https://mybusiness.googleapis.com/v4';
const GOOGLE_BUSINESS_INFORMATION_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const DAY_MS = 86400000;
const MAX_SPECIAL_HOURS_PLAN_ITEMS = 80;
const MAX_SPECIAL_HOURS_DAYS = 730;
const REVIEW_OBJECTIVE_ID = 'mass_sends';
const BUSINESS_PROFILE_ASSET_TYPE = 'google.business_profile';
const GBP_MEDIA_CATEGORIES = Object.freeze([
  'ADDITIONAL',
  'COVER',
  'PROFILE',
  'LOGO',
  'EXTERIOR',
  'INTERIOR',
  'PRODUCT',
  'AT_WORK',
  'TEAMS',
]);

const METRIC_DEFINITIONS = Object.freeze({
  profile_views: Object.freeze({
    preferred: ['BUSINESS_IMPRESSIONS_TOTAL'],
    fallback: [
      'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
      'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
      'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
      'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    ],
  }),
  search_views: Object.freeze({
    preferred: ['BUSINESS_IMPRESSIONS_SEARCH'],
    fallback: [
      'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
      'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
    ],
  }),
  map_views: Object.freeze({
    preferred: ['BUSINESS_IMPRESSIONS_MAPS'],
    fallback: [
      'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
      'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
    ],
  }),
  call_clicks: Object.freeze({
    preferred: ['BUSINESS_CONVERSIONS_CALL_CLICKS'],
    fallback: ['CALL_CLICKS'],
  }),
  direction_clicks: Object.freeze({
    preferred: ['BUSINESS_CONVERSIONS_DIRECTIONS'],
    fallback: ['BUSINESS_DIRECTION_REQUESTS'],
  }),
  website_clicks: Object.freeze({
    preferred: ['BUSINESS_CONVERSIONS_WEBSITE_CLICKS'],
    fallback: ['WEBSITE_CLICKS'],
  }),
});

const ALL_METRIC_TYPES = Array.from(new Set(Object.values(METRIC_DEFINITIONS)
  .flatMap((definition) => [...definition.preferred, ...definition.fallback])));
const RAW_REPORTING_COMPLETENESS_METRICS = Object.freeze([
  'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
  'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
  'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
  'BUSINESS_IMPRESSIONS_MOBILE_SEARCH',
  'BUSINESS_DIRECTION_REQUESTS',
  'CALL_CLICKS',
  'WEBSITE_CLICKS',
]);
const LEGACY_NULL_COERCION_METRICS = Object.freeze([
  ...RAW_REPORTING_COMPLETENESS_METRICS,
  'BUSINESS_BOOKINGS',
  'BUSINESS_CONVERSATIONS',
]);
// Performance publica su cola por métrica y no siempre completa todas las
// series el mismo día. Esta ventana cubre el retraso observado sin ocultar
// huecos históricos que sí deben investigarse.
const BUSINESS_PROFILE_PROVISIONAL_WINDOW_DAYS = 7;
const LEGACY_NULL_COERCION_WRITTEN_FROM = Date.parse('2026-07-15T00:00:00.000Z');
const LEGACY_NULL_COERCION_WRITTEN_BEFORE = Date.parse('2026-07-18T00:00:00.000Z');

function toInt(value) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function toNumber(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function resolveDateRange(startDate, endDate, fallbackDays = 90) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const parse = (value, fallback) => {
    if (!value) return fallback;
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return fallback;
    parsed.setHours(0, 0, 0, 0);
    return parsed;
  };
  const end = parse(endDate, today);
  const fallbackStart = new Date(end.getTime() - ((fallbackDays - 1) * DAY_MS));
  const start = parse(startDate, fallbackStart);
  if (end < start) {
    const error = new Error('local_date_range_invalid');
    error.status = 400;
    throw error;
  }
  const spanDays = Math.round((end - start) / DAY_MS) + 1;
  const previousEnd = new Date(start.getTime() - DAY_MS);
  const previousStart = new Date(previousEnd.getTime() - ((spanDays - 1) * DAY_MS));
  const endExclusive = new Date(end.getTime() + DAY_MS);
  return {
    start: formatDate(start),
    end: formatDate(end),
    startObj: start,
    endObj: end,
    endExclusive,
    previous: {
      start: formatDate(previousStart),
      end: formatDate(previousEnd),
    },
  };
}

function rawPayload(location) {
  const raw = location?.raw_payload ?? location?.rawPayload;
  return raw && typeof raw === 'object' ? raw : {};
}

function isPublishableBusinessProfileMediaAsset(asset, clinicId) {
  if (!asset) return false;
  const metadata = asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata)
    ? asset.metadata
    : {};
  return toInt(asset.clinica_id) === toInt(clinicId)
    && asset.scope_type === 'clinic'
    && asset.status === 'active'
    && asset.sensitivity === 'public'
    && asset.purpose === 'marketing_image'
    && asset.owner_type === 'google_business_profile_media'
    && String(asset.content_type || '').startsWith('image/')
    && metadata.non_clinical_asserted === true
    && metadata.patient_data_in_public_media !== true
    && metadata.patient_name_present !== true;
}

function normalizeAddress(raw) {
  const address = raw.storefrontAddress || raw.address || {};
  const addressLines = Array.isArray(address.addressLines) ? address.addressLines : [];
  return {
    lines: addressLines,
    postalCode: address.postalCode || null,
    locality: address.locality || null,
    region: address.administrativeArea || null,
    country: address.regionCode || null,
    formatted: [...addressLines, address.postalCode, address.locality, address.administrativeArea]
      .filter(Boolean)
      .join(', '),
  };
}

function normalizeCategory(category) {
  if (!category || typeof category !== 'object') return null;
  return {
    name: category.name || null,
    displayName: category.displayName || category.display_name || category.name || null,
  };
}

function serializeVerification(raw, location) {
  const suspended = location.is_suspended === true;
  const voiceState = raw.clinicaclick_voice_of_merchant_state
    && typeof raw.clinicaclick_voice_of_merchant_state === 'object'
    && !Array.isArray(raw.clinicaclick_voice_of_merchant_state)
    ? raw.clinicaclick_voice_of_merchant_state
    : null;
  const metadataVoice = typeof raw.metadata?.hasVoiceOfMerchant === 'boolean'
    ? raw.metadata.hasVoiceOfMerchant
    : null;
  const hasVoice = typeof voiceState?.hasVoiceOfMerchant === 'boolean'
    ? voiceState.hasVoiceOfMerchant
    : metadataVoice;
  const hasAuthority = typeof voiceState?.hasBusinessAuthority === 'boolean'
    ? voiceState.hasBusinessAuthority
    : null;

  if (voiceState?.complyWithGuidelines || suspended) {
    const reason = cleanString(voiceState?.complyWithGuidelines?.recommendationReason);
    const disabled = reason === 'BUSINESS_LOCATION_DISABLED';
    return {
      state: 'attention',
      label: disabled ? 'Ficha desactivada' : 'Ficha suspendida',
      action: 'comply_with_guidelines',
      signal: voiceState ? 'getVoiceOfMerchantState' : 'location_suspension',
      hasBusinessAuthority: hasAuthority,
      detail: disabled
        ? 'Google indica que la ubicación está desactivada y requiere seguir sus pasos de restitución.'
        : 'Google indica que la ubicación está suspendida y requiere seguir sus pasos de restitución.',
    };
  }
  if (hasVoice === true || (hasVoice === null && location.is_verified === true)) {
    return {
      state: 'verified',
      label: 'Ficha verificada',
      action: 'none',
      signal: voiceState ? 'getVoiceOfMerchantState' : 'hasVoiceOfMerchant',
      hasBusinessAuthority: hasAuthority,
      detail: 'Google confirma que la empresa está en regla y tiene control sobre esta ficha.',
    };
  }
  if (voiceState?.resolveOwnershipConflict) {
    return {
      state: 'attention',
      label: 'Conflicto de propiedad',
      action: 'resolve_ownership_conflict',
      signal: 'getVoiceOfMerchantState',
      hasBusinessAuthority: hasAuthority,
      detail: 'Google ha detectado otra ficha dominante del mismo negocio. Solicita acceso a su propietario o usa la ficha que ya está en regla.',
    };
  }
  if (voiceState?.waitForVoiceOfMerchant) {
    return {
      state: 'pending',
      label: 'Ficha en revisión',
      action: 'wait_for_review',
      signal: 'getVoiceOfMerchantState',
      hasBusinessAuthority: hasAuthority,
      detail: 'Google está revisando la ficha. No requiere iniciar otra verificación mientras termina esa revisión.',
    };
  }
  if (voiceState?.verify) {
    const hasPendingVerification = voiceState.verify.hasPendingVerification === true;
    return {
      state: 'pending',
      label: hasPendingVerification ? 'Verificación pendiente de completar' : 'Ficha pendiente de verificación',
      action: hasPendingVerification ? 'complete_verification' : 'start_verification',
      signal: 'getVoiceOfMerchantState',
      hasBusinessAuthority: hasAuthority,
      detail: hasPendingVerification
        ? 'Google indica que ya se inició una verificación y todavía debe completarse en Perfil de Empresa.'
        : 'Google requiere iniciar la verificación. Abre Perfil de Empresa para elegir uno de los métodos disponibles.',
    };
  }
  return {
    state: 'unknown',
    label: 'Estado de control no disponible',
    action: 'refresh_verification_state',
    signal: voiceState ? 'getVoiceOfMerchantState' : 'hasVoiceOfMerchant',
    hasBusinessAuthority: hasAuthority,
    detail: hasVoice === false
      ? 'Google aún no confirma que la ficha esté en regla y bajo control. Sincroniza de nuevo para obtener la acción exacta recomendada por Google.'
      : 'Google no ha devuelto todavía el estado de control de esta ficha.',
  };
}

function serializeLocation(location, { assignmentOrigin = null, timeZone = DEFAULT_TIME_ZONE } = {}) {
  const raw = rawPayload(location);
  const suspended = location.is_suspended === true;
  const verification = serializeVerification(raw, location);
  const categories = raw.categories || {};
  const primaryCategory = normalizeCategory(categories.primaryCategory || raw.primaryCategory);
  const additionalCategories = (Array.isArray(categories.additionalCategories)
    ? categories.additionalCategories
    : []).map(normalizeCategory).filter(Boolean);
  return {
    id: location.id,
    locationId: location.location_id,
    name: location.location_name,
    storeCode: location.store_code,
    primaryCategory: location.primary_category || primaryCategory?.displayName || null,
    categories: {
      primary: primaryCategory,
      additional: additionalCategories,
    },
    description: raw.profile?.description || raw.description || null,
    // El snapshot vigente de Google es canónico. `is_verified` puede quedar
    // rezagado entre sincronizaciones (caso real Badalona), por lo que solo se
    // usa como fallback si el proveedor no entregó Voice of Merchant.
    verified: verification.state === 'verified',
    verification,
    suspended,
    syncStatus: location.sync_status,
    lastSyncedAt: location.last_synced_at,
    websiteUri: raw.websiteUri || null,
    phone: raw.phoneNumbers?.primaryPhone || null,
    address: normalizeAddress(raw),
    mapsUri: raw.metadata?.mapsUri || null,
    newReviewUri: raw.metadata?.newReviewUri || null,
    regularHours: raw.regularHours || null,
    specialHours: raw.specialHours || null,
    specialHoursPlan: raw.clinicaclick_special_hours_plan || null,
    specialHoursSyncedAt: raw.clinicaclick_special_hours_synced_at || null,
    timeZone: cleanString(raw.clinicaclick_special_hours_plan?.timeZone) || timeZone || DEFAULT_TIME_ZONE,
    moreHours: Array.isArray(raw.moreHours) ? raw.moreHours : [],
    serviceArea: raw.serviceArea || null,
    labels: Array.isArray(raw.labels) ? raw.labels : [],
    assignmentOrigin,
    contentSyncedAt: raw.clinicaclick_content_synced_at || null,
    reviewsSyncedAt: raw.clinicaclick_reviews_synced_at || null,
    detailsSyncedAt: raw.clinicaclick_details_synced_at || null,
    metricsSyncedAt: raw.clinicaclick_metrics_synced_at || null,
    postsSyncedAt: raw.clinicaclick_posts_synced_at || null,
  };
}

async function resolveEffectiveLocations(clinicIdRaw, dependencies = {}) {
  const clinicId = toInt(clinicIdRaw);
  if (!clinicId) {
    const error = new Error('local_clinic_invalid');
    error.status = 400;
    throw error;
  }
  const inventoryResolver = dependencies.resolveEffectiveMarketingAssetInventory
    || resolveEffectiveMarketingAssetInventory;
  const locationModel = dependencies.ClinicBusinessLocation || ClinicBusinessLocation;
  const clinicModel = dependencies.Clinica || Clinica;
  const clinic = clinicModel ? await clinicModel.findByPk(clinicId, {
    attributes: ['id_clinica', 'configuracion'],
    raw: true,
  }) : null;
  const timeZone = resolveClinicTimeZone(clinic);
  const inventory = await inventoryResolver({
    clinicIdRaw: clinicId,
    groupIdRaw: null,
    assignmentScopeRaw: 'clinic',
  });
  const assets = Array.isArray(inventory?.google?.available_assets?.business_profile)
    ? inventory.google.available_assets.business_profile
    : [];
  const mappingIds = assets.map((asset) => toInt(asset.mapping_id)).filter(Boolean);
  if (!mappingIds.length) {
    return { clinicId, inventory, locations: [], assets: [], primaryLocationId: null, timeZone };
  }
  const rows = await locationModel.findAll({
    where: { id: { [Op.in]: mappingIds }, is_active: true },
  });
  const byId = new Map(rows.map((row) => [Number(row.id), row]));
  const primaryLocationId = toInt(inventory?.google?.effective_assets?.business_profile?.mapping_id)
    || mappingIds[0];
  const orderedAssets = [...assets].sort((left, right) => {
    if (toInt(left.mapping_id) === primaryLocationId) return -1;
    if (toInt(right.mapping_id) === primaryLocationId) return 1;
    return String(left.name || '').localeCompare(String(right.name || ''), 'es');
  });
  const locations = orderedAssets
    .map((asset) => byId.get(toInt(asset.mapping_id)))
    .filter(Boolean);
  return { clinicId, inventory, locations, assets: orderedAssets, primaryLocationId, timeZone };
}

async function resolvePhotoMutationClinicIds(resolved, dependencies = {}) {
  const location = resolved?.locations?.[0] || null;
  const assetId = toInt(location?.id || resolved?.primaryLocationId);
  const ownerClinicId = toInt(location?.clinica_id ?? location?.clinicaId);
  const requesterClinicId = toInt(resolved?.clinicId);
  if (!location || !assetId || !ownerClinicId || !requesterClinicId) {
    const error = new Error('business_profile_photo_scope_unavailable');
    error.status = 409;
    throw error;
  }

  const assignmentModel = dependencies.GroupAssetClinicAssignment || GroupAssetClinicAssignment;
  const clinicModel = dependencies.Clinica || Clinica;
  const asset = (resolved?.assets || []).find((item) => toInt(item?.mapping_id) === assetId) || null;
  const affected = new Set([requesterClinicId, ownerClinicId]);

  const assignments = assignmentModel ? await assignmentModel.findAll({
    where: { assetType: BUSINESS_PROFILE_ASSET_TYPE, assetId },
    attributes: ['clinicaId'],
    raw: true,
  }) : [];
  for (const row of assignments || []) {
    const clinicId = toInt(row?.clinicaId ?? row?.clinica_id);
    if (clinicId) affected.add(clinicId);
  }

  const groupId = toInt(resolved?.inventory?.scope?.group_id);
  if (asset?.assignment_origin === 'group' && groupId && clinicModel) {
    const groupClinics = await clinicModel.findAll({
      where: { grupoClinicaId: groupId },
      attributes: ['id_clinica'],
      raw: true,
    });
    for (const row of groupClinics || []) {
      const clinicId = toInt(row?.id_clinica);
      if (clinicId) affected.add(clinicId);
    }
  }

  return [...affected].sort((left, right) => left - right);
}

function buildStatus(resolved) {
  const originById = new Map((resolved.assets || [])
    .map((asset) => [toInt(asset.mapping_id), asset.assignment_origin || null]));
  const locations = (resolved.locations || []).map((location) => serializeLocation(location, {
    assignmentOrigin: originById.get(Number(location.id)) || null,
    timeZone: resolved.timeZone || DEFAULT_TIME_ZONE,
  }));
  return { success: true, hasMappings: locations.length > 0, locations };
}

function collapseMetricRows(rows) {
  const latest = new Map();
  for (const row of rows || []) {
    const locationId = row.business_location_id ?? row.businessLocationId ?? '';
    const key = `${locationId}|${row.date}|${row.metric_type}|${row.metric_subtype || ''}`;
    const current = latest.get(key);
    const rowUpdated = new Date(row.updated_at || row.updatedAt || 0).getTime();
    const currentUpdated = current
      ? new Date(current.updated_at || current.updatedAt || 0).getTime()
      : -1;
    if (!current || rowUpdated >= currentUpdated) latest.set(key, row);
  }
  const collapsed = Array.from(latest.values());
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const provisionalStart = new Date(today.getTime() - (BUSINESS_PROFILE_PROVISIONAL_WINDOW_DAYS * DAY_MS));
  const grouped = new Map();
  for (const row of collapsed) {
    const locationId = row.business_location_id ?? row.businessLocationId ?? '';
    const date = String(row.date || '');
    const key = `${locationId}|${date}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(row);
  }
  const provisionalKeys = new Set();
  for (const [key, dateRows] of grouped.entries()) {
    const date = new Date(`${String(dateRows[0]?.date || '')}T00:00:00.000Z`);
    const types = new Set(dateRows.map((row) => row.metric_type));
    const hasCompleteRawShape = RAW_REPORTING_COMPLETENESS_METRICS.every((metric) => types.has(metric));
    const allZero = dateRows.every((row) => toNumber(row.value) === 0);
    const isRecentProviderTail = Number.isFinite(date.getTime())
      && date >= provisionalStart
      && date <= today;
    // The old parser converted an absent protobuf value into 0. The affected
    // cohort is bounded by its write window and exact nine-series batch shape,
    // so those already-persisted rows stay hidden after the rolling provisional
    // window expires. A real explicit zero written by the fixed parser outside
    // that cohort remains reportable after the same window.
    const hasLegacyNullCoercionShape = LEGACY_NULL_COERCION_METRICS.every((metric) => types.has(metric));
    const isKnownLegacyNullCoercionBatch = hasLegacyNullCoercionShape && dateRows.every((row) => {
      const writtenAt = new Date(row.created_at || row.createdAt || row.updated_at || row.updatedAt || 0).getTime();
      return Number.isFinite(writtenAt)
        && writtenAt >= LEGACY_NULL_COERCION_WRITTEN_FROM
        && writtenAt < LEGACY_NULL_COERCION_WRITTEN_BEFORE;
    });
    const hasAnyRawMetric = RAW_REPORTING_COMPLETENESS_METRICS.some((metric) => types.has(metric));
    const isIncompleteProviderTail = isRecentProviderTail && hasAnyRawMetric && !hasCompleteRawShape;
    if (isIncompleteProviderTail || (allZero && ((hasCompleteRawShape && isRecentProviderTail) || isKnownLegacyNullCoercionBatch))) {
      provisionalKeys.add(key);
    }
  }
  return collapsed.filter((row) => {
    const locationId = row.business_location_id ?? row.businessLocationId ?? '';
    return !provisionalKeys.has(`${locationId}|${String(row.date || '')}`);
  });
}

function metricValueByDate(rows, definition) {
  const byLocationAndDate = new Map();
  for (const row of collapseMetricRows(rows)) {
    const locationId = row.business_location_id ?? row.businessLocationId ?? '';
    const date = String(row.date);
    const key = `${locationId}|${date}`;
    if (!byLocationAndDate.has(key)) byLocationAndDate.set(key, { date, rows: [] });
    byLocationAndDate.get(key).rows.push(row);
  }
  const totalsByDate = new Map();
  for (const { date, rows: dateRows } of byLocationAndDate.values()) {
    const preferred = dateRows.filter((row) => definition.preferred.includes(row.metric_type));
    const selected = preferred.length
      ? preferred
      : dateRows.filter((row) => definition.fallback.includes(row.metric_type));
    const locationValue = selected.reduce((sum, row) => sum + toNumber(row.value), 0);
    totalsByDate.set(date, (totalsByDate.get(date) || 0) + locationValue);
  }
  return Array.from(totalsByDate.entries())
    .map(([date, value]) => ({ date, value }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

function sumMetric(rows, definition) {
  return metricValueByDate(rows, definition).reduce((sum, point) => sum + point.value, 0);
}

function delta(current, previous) {
  if (!previous) return null;
  return (current - previous) / previous;
}

async function loadMetricRows(locationIds, range) {
  if (!locationIds.length) return { current: [], previous: [] };
  const common = {
    business_location_id: { [Op.in]: locationIds },
    metric_type: { [Op.in]: ALL_METRIC_TYPES },
  };
  const [current, previous] = await Promise.all([
    BusinessProfileDailyMetric.findAll({
      where: { ...common, date: { [Op.between]: [range.start, range.end] } },
      raw: true,
    }),
    BusinessProfileDailyMetric.findAll({
      where: { ...common, date: { [Op.between]: [range.previous.start, range.previous.end] } },
      raw: true,
    }),
  ]);
  return { current, previous };
}

async function buildOverview(resolved, startDate, endDate) {
  const range = resolveDateRange(startDate, endDate, 90);
  const locationIds = resolved.locations.map((location) => Number(location.id));
  const [{ current: metrics, previous: prevMetrics }, reviewTotals, newReviews] = await Promise.all([
    loadMetricRows(locationIds, range),
    locationIds.length
      ? BusinessProfileReview.findOne({
        where: { business_location_id: { [Op.in]: locationIds } },
        attributes: [
          [fn('COUNT', col('id')), 'total'],
          [fn('AVG', col('star_rating')), 'averageRating'],
          [literal('SUM(CASE WHEN is_negative = 1 THEN 1 ELSE 0 END)'), 'negativeReviews'],
          [literal('SUM(CASE WHEN has_reply = 0 THEN 1 ELSE 0 END)'), 'unansweredReviews'],
        ],
        raw: true,
      })
      : Promise.resolve(null),
    locationIds.length
      ? BusinessProfileReview.count({
        where: {
          business_location_id: { [Op.in]: locationIds },
          create_time: { [Op.gte]: range.startObj, [Op.lt]: range.endExclusive },
        },
      })
      : Promise.resolve(0),
  ]);
  const current = {};
  const previous = {};
  for (const [key, definition] of Object.entries(METRIC_DEFINITIONS)) {
    current[key] = sumMetric(metrics, definition);
    previous[key] = sumMetric(prevMetrics, definition);
  }
  const metric = (key) => ({
    current: current[key],
    previous: previous[key],
    delta: delta(current[key], previous[key]),
  });
  return {
    success: true,
    period: { start: range.start, end: range.end },
    comparison: range.previous,
    metrics: {
      profileViews: metric('profile_views'),
      searchViews: metric('search_views'),
      mapViews: metric('map_views'),
      callClicks: metric('call_clicks'),
      directionClicks: metric('direction_clicks'),
      websiteClicks: metric('website_clicks'),
      reviews: {
        total: toNumber(reviewTotals?.total),
        averageRating: Number(Number(reviewTotals?.averageRating || 0).toFixed(2)),
        newReviews: toNumber(newReviews),
        negativeReviews: toNumber(reviewTotals?.negativeReviews),
        unansweredReviews: toNumber(reviewTotals?.unansweredReviews),
      },
    },
  };
}

async function buildTimeseries(resolved, metric, startDate, endDate) {
  const range = resolveDateRange(startDate, endDate, 90);
  const definition = METRIC_DEFINITIONS[metric] || METRIC_DEFINITIONS.profile_views;
  const locationIds = resolved.locations.map((location) => Number(location.id));
  if (!locationIds.length) {
    return { success: true, metric, period: { start: range.start, end: range.end }, comparison: range.previous, current: [], previous: [] };
  }
  const [currentRows, previousRows] = await Promise.all([
    BusinessProfileDailyMetric.findAll({
      where: {
        business_location_id: { [Op.in]: locationIds },
        metric_type: { [Op.in]: ALL_METRIC_TYPES },
        date: { [Op.between]: [range.start, range.end] },
      },
      raw: true,
    }),
    BusinessProfileDailyMetric.findAll({
      where: {
        business_location_id: { [Op.in]: locationIds },
        metric_type: { [Op.in]: ALL_METRIC_TYPES },
        date: { [Op.between]: [range.previous.start, range.previous.end] },
      },
      raw: true,
    }),
  ]);
  return {
    success: true,
    metric,
    period: { start: range.start, end: range.end },
    comparison: range.previous,
    current: metricValueByDate(currentRows, definition),
    previous: metricValueByDate(previousRows, definition),
  };
}

async function buildSeasonality(resolved, monthsRaw = 18) {
  const months = Math.max(6, Math.min(36, Number(monthsRaw) || 18));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const start = new Date(today.getFullYear(), today.getMonth() - (months - 1), 1);
  const end = new Date(today.getFullYear(), today.getMonth() + 1, 0);
  const locationIds = resolved.locations.map((location) => Number(location.id));
  const rows = locationIds.length
    ? await BusinessProfileDailyMetric.findAll({
      where: {
        business_location_id: { [Op.in]: locationIds },
        metric_type: { [Op.in]: ALL_METRIC_TYPES },
        date: { [Op.between]: [formatDate(start), formatDate(end)] },
      },
      raw: true,
    })
    : [];
  const byMonth = new Map();
  for (let cursor = new Date(start); cursor <= end; cursor.setMonth(cursor.getMonth() + 1)) {
    const month = cursor.toISOString().slice(0, 7);
    byMonth.set(month, { month, views: 0, calls: 0, directions: 0, websiteClicks: 0, totalActions: 0 });
  }
  const collapsed = collapseMetricRows(rows);
  const rowsByMonth = new Map();
  for (const row of collapsed) {
    const month = String(row.date).slice(0, 7);
    if (!rowsByMonth.has(month)) rowsByMonth.set(month, []);
    rowsByMonth.get(month).push(row);
  }
  for (const [month, monthRows] of rowsByMonth.entries()) {
    const bucket = byMonth.get(month);
    if (!bucket) continue;
    bucket.views = sumMetric(monthRows, METRIC_DEFINITIONS.profile_views);
    bucket.calls = sumMetric(monthRows, METRIC_DEFINITIONS.call_clicks);
    bucket.directions = sumMetric(monthRows, METRIC_DEFINITIONS.direction_clicks);
    bucket.websiteClicks = sumMetric(monthRows, METRIC_DEFINITIONS.website_clicks);
    bucket.totalActions = bucket.calls + bucket.directions + bucket.websiteClicks;
  }
  const series = Array.from(byMonth.values());
  const comparable = series.filter((item) => item.views > 0 || item.totalActions > 0);
  const bestMonth = comparable.length
    ? comparable.reduce((best, item) => (item.views > best.views ? item : best), comparable[0])
    : null;
  const weakestMonth = comparable.length
    ? comparable.reduce((weakest, item) => (item.views < weakest.views ? item : weakest), comparable[0])
    : null;
  return {
    success: true,
    period: { start: formatDate(start), end: formatDate(end), months },
    series,
    insight: {
      bestMonth: bestMonth?.month || null,
      weakestMonth: weakestMonth?.month || null,
      hasEnoughHistory: comparable.length >= 12,
    },
  };
}

function clampPage(value, fallback, max) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.max(0, Math.min(max, parsed));
}

async function listReviews(resolved, query = {}) {
  const locationIds = resolved.locations.map((location) => Number(location.id));
  const limit = Math.max(1, clampPage(query.limit, 10, 50));
  const offset = clampPage(query.offset, 0, 100000);
  if (!locationIds.length) return { success: true, items: [], total: 0, limit, offset };
  const where = { business_location_id: { [Op.in]: locationIds } };
  if (query.rating) where.star_rating = Math.max(1, Math.min(5, Number(query.rating)));
  if (String(query.unreplied) === 'true') where.has_reply = false;
  if (String(query.unreplied) === 'false') where.has_reply = true;
  if (String(query.negative) === 'true') where.is_negative = true;
  if (String(query.negative) === 'false') where.is_negative = false;
  const [rows, total] = await Promise.all([
    BusinessProfileReview.findAll({
      where,
      attributes: { exclude: ['raw_payload'] },
      order: [['create_time', 'DESC'], ['id', 'DESC']],
      limit,
      offset,
      raw: true,
    }),
    BusinessProfileReview.count({ where }),
  ]);
  return { success: true, items: rows, total, limit, offset };
}

async function listPosts(resolved, query = {}) {
  const locationIds = resolved.locations.map((location) => Number(location.id));
  const limit = Math.max(1, clampPage(query.limit, 10, 50));
  const offset = clampPage(query.offset, 0, 100000);
  if (!locationIds.length) return { success: true, items: [], total: 0, limit, offset };
  const where = { business_location_id: { [Op.in]: locationIds } };
  const [rows, total] = await Promise.all([
    BusinessProfilePost.findAll({
      where,
      attributes: { exclude: ['raw_payload'] },
      order: [['create_time', 'DESC'], ['id', 'DESC']],
      limit,
      offset,
      raw: true,
    }),
    BusinessProfilePost.count({ where }),
  ]);
  return { success: true, items: rows, total, limit, offset };
}

function formatMoney(price) {
  if (!price || typeof price !== 'object') return null;
  const money = price.money || price;
  const units = Number(money.units || 0);
  const nanos = Number(money.nanos || 0);
  const value = units + (nanos / 1e9);
  if (!Number.isFinite(value) || (!value && !money.currencyCode)) return null;
  const currency = money.currencyCode || money.currency_code || 'EUR';
  try {
    return new Intl.NumberFormat('es-ES', { style: 'currency', currency }).format(value);
  } catch (_) {
    return `${value.toFixed(2)} ${currency}`;
  }
}

function normalizeServiceItem(item, index) {
  const freeForm = item?.freeFormServiceItem || item?.free_form_service_item || null;
  const structured = item?.structuredServiceItem || item?.structured_service_item || null;
  const label = freeForm?.label || {};
  const serviceTypeId = structured?.serviceTypeId || structured?.service_type_id || null;
  const categoryName = freeForm?.category || structured?.category || null;
  const name = label.displayName
    || label.display_name
    || structured?.displayName
    || structured?.display_name
    || (serviceTypeId ? String(serviceTypeId).split('/').pop().replace(/_/g, ' ') : null)
    || `Servicio ${index + 1}`;
  const description = label.description || freeForm?.description || structured?.description || null;
  return {
    id: String(serviceTypeId || `${categoryName || 'free'}:${name}:${index}`),
    name,
    category: categoryName ? String(categoryName).split('/').pop().replace(/^gcid:/, '').replace(/_/g, ' ') : 'Servicio',
    categoryResource: categoryName,
    description,
    sourceKind: freeForm ? 'free_form_service' : (structured ? 'structured_service' : 'unknown'),
    descriptionSource: description ? 'google_business_profile' : 'missing_in_google_business_profile',
    priceFrom: formatMoney(item?.price),
    priceInterpretation: item?.price?.priceInterpretation || item?.price?.price_interpretation || null,
    status: description ? 'publicado' : 'falta-descripcion',
  };
}

function mediaType(category) {
  const normalized = String(category || '').toUpperCase();
  if (normalized === 'COVER') return 'portada';
  if (['LOGO', 'PROFILE'].includes(normalized)) return 'logo';
  if (['TEAMS', 'TEAM'].includes(normalized)) return 'equipo';
  if (['INTERIOR', 'EXTERIOR', 'AT_WORK'].includes(normalized)) return 'instalaciones';
  if (normalized === 'PRODUCT') return 'tratamiento';
  return 'instalaciones';
}

function mediaCategoryLabel(category, mediaFormat = 'PHOTO') {
  const normalized = String(category || '').toUpperCase();
  if (String(mediaFormat || '').toUpperCase() === 'VIDEO') {
    return normalized === 'ADDITIONAL' ? 'Vídeo de la clínica' : 'Vídeo del Perfil de Empresa';
  }
  const labels = {
    ADDITIONAL: 'Foto de la clínica',
    COVER: 'Foto de portada',
    PROFILE: 'Foto de perfil',
    LOGO: 'Logotipo',
    EXTERIOR: 'Exterior de la clínica',
    INTERIOR: 'Interior de la clínica',
    PRODUCT: 'Servicio o tratamiento',
    AT_WORK: 'Equipo trabajando',
    TEAM: 'Equipo de la clínica',
    TEAMS: 'Equipo de la clínica',
  };
  return labels[normalized] || 'Contenido de la clínica';
}

function mediaPlaybackUrl(item) {
  const mediaFormat = String(item?.mediaFormat || item?.media_format || '').toUpperCase();
  const sourceUrl = cleanString(item?.sourceUrl || item?.source_url);
  if (mediaFormat !== 'VIDEO' || !sourceUrl) return null;
  return /\.(?:mp4|m4v|mov|webm)(?:[?#]|$)/i.test(sourceUrl) ? sourceUrl : null;
}

function normalizeMediaItem(item, index) {
  const category = item?.locationAssociation?.category
    || item?.location_association?.category
    || 'ADDITIONAL';
  const rawAttribution = item?.attribution && typeof item.attribution === 'object'
    ? item.attribution
    : null;
  const attribution = rawAttribution ? {
    profileName: cleanString(rawAttribution.profileName),
    profilePhotoUrl: cleanString(rawAttribution.profilePhotoUrl),
    profileUrl: cleanString(rawAttribution.profileUrl),
    takedownUrl: cleanString(rawAttribution.takedownUrl),
  } : null;
  const mediaFormat = String(item?.mediaFormat || item?.media_format || 'PHOTO').toUpperCase();
  const url = item?.googleUrl || item?.sourceUrl || item?.thumbnailUrl || null;
  const thumbnailUrl = item?.thumbnailUrl || url;
  const rawDescription = cleanString(item?.description);
  const description = rawDescription && rawDescription.toUpperCase() !== String(category).toUpperCase()
    ? rawDescription
    : null;
  return {
    id: item?.name || `media:${index}`,
    url,
    thumbnailUrl,
    mediaFormat,
    isVideo: mediaFormat === 'VIDEO',
    playbackUrl: mediaPlaybackUrl(item),
    type: mediaType(category),
    label: description || mediaCategoryLabel(category, mediaFormat),
    category,
    createTime: item?.createTime || null,
    widthPixels: toNumber(item?.dimensions?.widthPixels),
    heightPixels: toNumber(item?.dimensions?.heightPixels),
    viewCount: item?.insights?.viewCount == null ? null : toNumber(item.insights.viewCount),
    attribution: attribution && Object.values(attribution).some(Boolean) ? attribution : null,
  };
}

function buildContent(resolved) {
  const location = resolved.locations[0] || null;
  const raw = rawPayload(location);
  const serviceItems = Array.isArray(raw.serviceItems) ? raw.serviceItems : [];
  const mediaItems = Array.isArray(raw.clinicaclick_media_items)
    ? raw.clinicaclick_media_items
    : (Array.isArray(raw.mediaItems) ? raw.mediaItems : []);
  return {
    success: true,
    services: serviceItems.map(normalizeServiceItem),
    photos: mediaItems.map(normalizeMediaItem).filter((item) => item.url),
    syncedAt: raw.clinicaclick_content_synced_at || null,
  };
}

function emptyHeatmap() {
  const weekdays = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
  const hours = Array.from({ length: 24 }, (_item, index) => index);
  return weekdays.map((day) => ({
    name: day,
    data: hours.map((hour) => ({ x: `${String(hour).padStart(2, '0')}:00`, y: 0 })),
  }));
}

function buildReviewResponseHeatmaps(rows = []) {
  const heatmaps = {
    winter: { label: 'Invierno', total: 0, series: emptyHeatmap() },
    summer: { label: 'Verano', total: 0, series: emptyHeatmap() },
  };
  for (const row of rows || []) {
    const season = String(row.season || '');
    if (!heatmaps[season]) continue;
    const weekday = Number(row.weekday);
    const hour = Number(row.hour);
    const total = Number(row.total || 0);
    if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) continue;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) continue;
    heatmaps[season].series[weekday].data[hour].y = total;
    heatmaps[season].total += total;
  }
  return heatmaps;
}

function calculateFiveStarReviewsNeeded(totalReviews, ratingSum, targetAverage) {
  if (!totalReviews || targetAverage <= 0 || targetAverage >= 5) return 0;
  if ((ratingSum / totalReviews) >= targetAverage) return 0;
  return Math.max(1, Math.ceil(((targetAverage * totalReviews) - ratingSum) / (5 - targetAverage)));
}

function buildGoogleRatingSummary(row = {}) {
  const totalReviews = Number(row.total_reviews || 0);
  const ratingSum = Number(row.rating_sum || 0);
  const averageRating = totalReviews > 0 ? Number((ratingSum / totalReviews).toFixed(2)) : 0;
  const targetAverage = 4.95;
  const visibleTargets = totalReviews
    ? Array.from(new Set([
      Math.min(4.9, Math.max(0.1, (Math.floor((Math.round(averageRating * 10) / 10) * 10) + 1) / 10)),
      Math.min(4.9, Math.max(0.1, (Math.floor((Math.round(averageRating * 10) / 10) * 10) + 2) / 10)),
      5,
    ]))
    : [];
  return {
    total_reviews: totalReviews,
    five_star_reviews: Number(row.five_star_reviews || 0),
    average_rating: averageRating,
    rating_sum: ratingSum,
    target_average: targetAverage,
    needed_five_star_reviews_for_5: totalReviews
      ? calculateFiveStarReviewsNeeded(totalReviews, ratingSum, targetAverage)
      : 1,
    rating_targets: visibleTargets.map((visibleAverage) => {
      const target = visibleAverage >= 5 ? 4.95 : Math.max(0.05, visibleAverage - 0.05);
      return {
        visible_average: visibleAverage,
        target_average: Number(target.toFixed(2)),
        needed_five_star_reviews: calculateFiveStarReviewsNeeded(totalReviews, ratingSum, target),
      };
    }),
  };
}

async function buildReviewInsights(resolved) {
  const clinicId = resolved.clinicId;
  const locationIds = resolved.locations.map((location) => Number(location.id));
  const reviewRatingsCte = `
    WITH review_ratings AS (
      SELECT
        e.id,
        e.list_id,
        e.item_id,
        e.payload,
        e.occurred_at,
        i.sent_at,
        ROW_NUMBER() OVER (
          PARTITION BY COALESCE(
            CASE WHEN COALESCE(e.paciente_id, i.paciente_id) IS NOT NULL THEN CONCAT('p:', COALESCE(e.paciente_id, i.paciente_id)) END,
            CASE WHEN NULLIF(TRIM(i.phone), '') IS NOT NULL THEN CONCAT('ph:', TRIM(REPLACE(REPLACE(REPLACE(REPLACE(i.phone, '+', ''), ' ', ''), '-', ''), '.', ''))) END,
            CASE WHEN NULLIF(TRIM(i.email), '') IS NOT NULL THEN CONCAT('em:', LOWER(TRIM(i.email))) END,
            CASE WHEN NULLIF(TRIM(i.name), '') IS NOT NULL THEN CONCAT('nm:', LOWER(TRIM(i.name))) END,
            CONCAT('event:', e.id)
          )
          ORDER BY e.occurred_at DESC, e.id DESC
        ) AS contact_rank
      FROM MarketingPatientContactEvents e
      INNER JOIN MarketingPatientLists l ON l.id = e.list_id
      INNER JOIN MarketingPatientListItems i ON i.id = e.item_id
      WHERE l.objective_id = :objectiveId
        AND COALESCE(i.clinica_id, l.clinica_id) = :clinicId
        AND (
          JSON_UNQUOTE(JSON_EXTRACT(l.criteria, '$.review_request')) IN ('true', '1')
          OR JSON_UNQUOTE(JSON_EXTRACT(l.criteria, '$.template_usage')) = 'solicitud_resena'
        )
        AND (
          i.sent_at IS NOT NULL
          OR i.dispatch_status IN ('queued','sending','sent','delivered','read','replied')
        )
        AND NOT EXISTS (
          SELECT 1
          FROM MarketingPatientContactEvents te
          WHERE te.list_id = i.list_id
            AND te.item_id = i.id
            AND te.event_type IN ('mass_campaign_test_sent', 'mass_campaign_test_failed')
        )
        AND e.event_type IN ('review_rating_received', 'review_request_rating')
        AND CAST(JSON_UNQUOTE(JSON_EXTRACT(e.payload, '$.rating')) AS UNSIGNED) BETWEEN 1 AND 5
    )
  `;
  const [heatmapRows, googleRatingRows] = await Promise.all([
    db.sequelize.query(
      `
      ${reviewRatingsCte}
      SELECT
        CASE
          WHEN MONTH(COALESCE(sent_at, occurred_at)) IN (12, 1, 2) THEN 'winter'
          WHEN MONTH(COALESCE(sent_at, occurred_at)) IN (6, 7, 8) THEN 'summer'
          ELSE 'other'
        END AS season,
        WEEKDAY(occurred_at) AS weekday,
        HOUR(occurred_at) AS hour,
        COUNT(*) AS total
      FROM review_ratings
      WHERE contact_rank = 1
      GROUP BY season, WEEKDAY(occurred_at), HOUR(occurred_at)
      ORDER BY season, weekday, hour
      `,
      { replacements: { clinicId, objectiveId: REVIEW_OBJECTIVE_ID }, type: db.Sequelize.QueryTypes.SELECT }
    ),
    locationIds.length
      ? db.sequelize.query(
        `
        SELECT
          COUNT(*) AS total_reviews,
          SUM(CAST(star_rating AS UNSIGNED)) AS rating_sum,
          AVG(CAST(star_rating AS UNSIGNED)) AS average_rating,
          SUM(CASE WHEN CAST(star_rating AS UNSIGNED) = 5 THEN 1 ELSE 0 END) AS five_star_reviews
        FROM BusinessProfileReviews
        WHERE business_location_id IN (:locationIds)
          AND CAST(star_rating AS UNSIGNED) BETWEEN 1 AND 5
        `,
        { replacements: { locationIds }, type: db.Sequelize.QueryTypes.SELECT }
      )
      : Promise.resolve([{}]),
  ]);
  return {
    success: true,
    review_response_heatmaps: buildReviewResponseHeatmaps(heatmapRows),
    google_rating_summary: buildGoogleRatingSummary(googleRatingRows?.[0] || {}),
  };
}

async function buildDashboard(resolved, query = {}) {
  const startDate = query.startDate;
  const endDate = query.endDate;
  const tasks = {
    overview: () => buildOverview(resolved, startDate, endDate),
    timeseries: () => buildTimeseries(resolved, query.metric || 'profile_views', startDate, endDate),
    seasonality: () => buildSeasonality(resolved, query.months || 18),
    reviews: () => listReviews(resolved, {
      limit: query.reviewLimit || query.limit || 10,
      offset: query.reviewOffset || 0,
      rating: query.rating,
      unreplied: query.unreplied,
      negative: query.negative,
    }),
    posts: () => listPosts(resolved, {
      limit: query.postLimit || 10,
      offset: query.postOffset || 0,
    }),
    content: () => Promise.resolve(buildContent(resolved)),
    reviewInsights: () => buildReviewInsights(resolved),
  };
  const names = Object.keys(tasks);
  const settled = await Promise.allSettled(names.map((name) => tasks[name]()));
  const errors = [];
  const sections = {};
  settled.forEach((result, index) => {
    const name = names[index];
    if (result.status === 'fulfilled') {
      sections[name] = result.value;
    } else {
      sections[name] = null;
      errors.push({ section: name, error: result.reason?.message || 'local_section_failed' });
    }
  });
  return {
    success: true,
    partial: errors.length > 0,
    errors,
    status: buildStatus(resolved),
    ...sections,
  };
}

async function ensureGoogleAccessToken(connectionId) {
  const connection = await GoogleConnection.findByPk(connectionId);
  if (!connection) {
    const error = new Error('google_connection_not_found');
    error.status = 409;
    throw error;
  }
  let accessToken = connection.accessToken;
  const expiresAt = connection.expiresAt ? new Date(connection.expiresAt).getTime() : Number.NaN;
  const mustRefresh = !accessToken
    || !Number.isFinite(expiresAt)
    || expiresAt < Date.now() + 60000;
  if (mustRefresh && connection.refreshToken) {
    const params = new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      grant_type: 'refresh_token',
      refresh_token: connection.refreshToken,
    });
    const response = await axios.post('https://oauth2.googleapis.com/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000,
    });
    const refreshedAccessToken = cleanString(response.data?.access_token);
    if (!refreshedAccessToken) {
      const error = new Error('google_access_token_refresh_failed');
      error.status = 409;
      throw error;
    }
    accessToken = refreshedAccessToken;
    const expiresIn = Number(response.data?.expires_in || 3600);
    await connection.update({ accessToken, expiresAt: new Date(Date.now() + (expiresIn * 1000)) });
  }
  if (!accessToken || (mustRefresh && !connection.refreshToken)) {
    const error = new Error('google_access_token_unavailable');
    error.status = 409;
    throw error;
  }
  return accessToken;
}

function buildBusinessProfileV4LocationPath(location) {
  const raw = rawPayload(location);
  const accountName = cleanString(raw.accountName || raw.account_name);
  const locationId = cleanString(location.location_id)?.split('/').pop();
  if (!accountName || !locationId) return null;
  return `${accountName}/locations/${locationId}`;
}

async function publishPhoto(resolved, payload = {}) {
  const location = resolved.locations[0] || null;
  if (!location) {
    const error = new Error('business_profile_location_not_configured');
    error.status = 409;
    throw error;
  }
  const publicMediaAssetId = toInt(payload.publicMediaAssetId || payload.public_media_asset_id);
  if (!publicMediaAssetId) {
    const error = new Error('public_media_asset_required');
    error.status = 400;
    throw error;
  }
  const asset = await PublicMediaAsset.findOne({
    where: {
      id: publicMediaAssetId,
      clinica_id: resolved.clinicId,
      scope_type: 'clinic',
      status: 'active',
      sensitivity: 'public',
      purpose: 'marketing_image',
      owner_type: 'google_business_profile_media',
    },
  });
  if (!asset || !asset.public_url || !isPublishableBusinessProfileMediaAsset(asset, resolved.clinicId)) {
    const error = new Error('public_media_asset_not_available');
    error.status = 404;
    throw error;
  }
  const resourceBase = buildBusinessProfileV4LocationPath(location);
  if (!resourceBase) {
    const error = new Error('business_profile_media_parent_unavailable');
    error.status = 409;
    throw error;
  }
  const requestedCategory = String(payload.category || 'ADDITIONAL').trim().toUpperCase();
  const category = GBP_MEDIA_CATEGORIES.includes(requestedCategory) ? requestedCategory : 'ADDITIONAL';
  const accessToken = await ensureGoogleAccessToken(location.google_connection_id);
  const body = {
    mediaFormat: 'PHOTO',
    locationAssociation: { category },
    sourceUrl: asset.public_url,
  };
  const description = cleanString(payload.description);
  if (description && category !== 'COVER') body.description = description.slice(0, 1024);
  const response = await axios.post(
    `${GOOGLE_MY_BUSINESS_API}/${resourceBase}/media`,
    body,
    { headers: { Authorization: `Bearer ${accessToken}` }, timeout: 20000 }
  );
  const media = response.data || {};
  const mediaName = media.name || null;
  await sequelize.transaction(async (transaction) => {
    const locked = await ClinicBusinessLocation.findByPk(toInt(location.id), {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!locked) throw new Error('business_profile_location_not_configured');
    const currentRaw = rawPayload(locked);
    const current = Array.isArray(currentRaw.clinicaclick_media_items)
      ? currentRaw.clinicaclick_media_items
      : [];
    const merged = [media, ...current.filter((item) => !mediaName || item?.name !== mediaName)].slice(0, 500);
    await locked.update({
      raw_payload: {
        ...currentRaw,
        clinicaclick_media_items: merged,
        clinicaclick_content_synced_at: new Date().toISOString(),
      },
    }, { transaction });
  });
  return { success: true, photo: normalizeMediaItem(media, 0) };
}

function specialHoursError(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeIsoDate(value) {
  const match = cleanString(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function addIsoDateDays(value, days) {
  const normalized = normalizeIsoDate(value);
  if (!normalized) return null;
  const [year, month, day] = normalized.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + Number(days || 0)));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function isoDateToGoogleDate(value) {
  const normalized = normalizeIsoDate(value);
  if (!normalized) return null;
  const [year, month, day] = normalized.split('-').map(Number);
  return { year, month, day };
}

function normalizeHHmm(value) {
  const match = cleanString(value).match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function hhmmToGoogleTime(value) {
  const normalized = normalizeHHmm(value);
  if (!normalized) return null;
  const [hours, minutes] = normalized.split(':').map(Number);
  return minutes ? { hours, minutes } : { hours };
}

function isValidTimeZone(value) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch (_error) {
    return false;
  }
}

function normalizeSpecialHoursPlan(payload = {}, fallbackTimeZone = DEFAULT_TIME_ZONE) {
  const source = Array.isArray(payload?.periods) ? payload.periods : [];
  if (source.length > MAX_SPECIAL_HOURS_PLAN_ITEMS) {
    throw specialHoursError('business_profile_special_hours_too_many_items');
  }
  const requestedTimeZone = cleanString(payload?.timeZone || payload?.timezone || fallbackTimeZone);
  const timeZone = isValidTimeZone(requestedTimeZone) ? requestedTimeZone : null;
  if (!timeZone) throw specialHoursError('business_profile_special_hours_timezone_invalid');

  let expandedDayCount = 0;
  const rulesByDate = new Map();
  const periods = source.map((item, index) => {
    const kind = cleanString(item?.kind || item?.type).toLowerCase();
    if (kind !== 'closed' && kind !== 'open') {
      throw specialHoursError('business_profile_special_hours_kind_invalid');
    }
    const startDate = normalizeIsoDate(item?.startDate || item?.start_date);
    const endDate = normalizeIsoDate(item?.endDate || item?.end_date || startDate);
    if (!startDate || !endDate || endDate < startDate) {
      throw specialHoursError('business_profile_special_hours_dates_invalid');
    }
    const openTime = kind === 'open' ? normalizeHHmm(item?.openTime || item?.open_time) : null;
    const closeTime = kind === 'open' ? normalizeHHmm(item?.closeTime || item?.close_time) : null;
    if (kind === 'open' && (!openTime || !closeTime || closeTime <= openTime)) {
      throw specialHoursError('business_profile_special_hours_times_invalid');
    }

    let cursor = startDate;
    while (cursor && cursor <= endDate) {
      expandedDayCount += 1;
      if (expandedDayCount > MAX_SPECIAL_HOURS_DAYS) {
        throw specialHoursError('business_profile_special_hours_range_too_large');
      }
      const dayRules = rulesByDate.get(cursor) || [];
      if (kind === 'closed' && dayRules.length) {
        throw specialHoursError('business_profile_special_hours_overlap');
      }
      if (kind === 'open') {
        if (dayRules.some((rule) => rule.kind === 'closed')) {
          throw specialHoursError('business_profile_special_hours_overlap');
        }
        const openStart = Number(openTime.slice(0, 2)) * 60 + Number(openTime.slice(3));
        const openEnd = Number(closeTime.slice(0, 2)) * 60 + Number(closeTime.slice(3));
        if (dayRules.some((rule) => rule.kind === 'open' && openStart < rule.end && openEnd > rule.start)) {
          throw specialHoursError('business_profile_special_hours_overlap');
        }
        dayRules.push({ kind, start: openStart, end: openEnd });
      } else {
        dayRules.push({ kind });
      }
      rulesByDate.set(cursor, dayRules);
      cursor = addIsoDateDays(cursor, 1);
    }

    return {
      id: (cleanString(item?.id) || '').slice(0, 80) || `special-hours-${index + 1}`,
      kind,
      label: (cleanString(item?.label) || '').slice(0, 120),
      startDate,
      endDate,
      openTime,
      closeTime,
    };
  });

  return { version: 1, timeZone, periods };
}

function buildGoogleSpecialHourPeriods(plan) {
  const result = [];
  for (const item of Array.isArray(plan?.periods) ? plan.periods : []) {
    let cursor = item.startDate;
    while (cursor && cursor <= item.endDate) {
      const startDate = isoDateToGoogleDate(cursor);
      if (item.kind === 'closed') {
        result.push({ startDate, endDate: startDate, closed: true });
      } else {
        result.push({
          startDate,
          endDate: startDate,
          openTime: hhmmToGoogleTime(item.openTime),
          closeTime: hhmmToGoogleTime(item.closeTime),
        });
      }
      cursor = addIsoDateDays(cursor, 1);
    }
  }
  return result;
}

async function updateSpecialHours(resolved, payload = {}) {
  const location = resolved?.locations?.[0] || null;
  if (!location) throw specialHoursError('business_profile_location_not_configured', 409);
  const raw = rawPayload(location);
  const regularPeriods = raw.regularHours?.periods || location.regularHours?.periods || [];
  if (!Array.isArray(regularPeriods) || !regularPeriods.length) {
    throw specialHoursError('business_profile_regular_hours_required', 409);
  }
  const locationName = cleanString(location.location_id);
  if (!/^locations\/[^/]+$/.test(locationName)) {
    throw specialHoursError('business_profile_location_name_invalid', 409);
  }

  const plan = normalizeSpecialHoursPlan(payload, resolved?.timeZone || DEFAULT_TIME_ZONE);
  const specialHours = { specialHourPeriods: buildGoogleSpecialHourPeriods(plan) };
  const accessToken = await ensureGoogleAccessToken(location.google_connection_id);
  let response;
  try {
    response = await axios.patch(
      `${GOOGLE_BUSINESS_INFORMATION_API}/${locationName}`,
      { name: locationName, specialHours },
      {
        params: { updateMask: 'specialHours' },
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 20000,
      }
    );
  } catch (providerError) {
    const error = specialHoursError('business_profile_special_hours_sync_failed', 502);
    error.cause = providerError;
    throw error;
  }

  const syncedAt = new Date().toISOString();
  const providerSpecialHours = response?.data?.specialHours || specialHours;
  const persistedPlan = { ...plan, syncedAt, sourceClinicId: Number(resolved.clinicId) };
  await sequelize.transaction(async (transaction) => {
    const locked = await ClinicBusinessLocation.findByPk(toInt(location.id), {
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    if (!locked) throw specialHoursError('business_profile_location_not_configured', 409);
    const currentRaw = rawPayload(locked);
    await locked.update({
      raw_payload: {
        ...currentRaw,
        specialHours: providerSpecialHours,
        clinicaclick_special_hours_plan: persistedPlan,
        clinicaclick_special_hours_synced_at: syncedAt,
      },
      sync_status: 'synced',
      last_synced_at: new Date(syncedAt),
    }, { transaction });
  });

  return {
    success: true,
    specialHours: providerSpecialHours,
    plan: persistedPlan,
    timeZone: plan.timeZone,
    syncedAt,
  };
}

function todayInTimeZone(timeZone = DEFAULT_TIME_ZONE, date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function preserveSpecialHoursOutsideRange(item, incoming, today) {
  const originalStart = normalizeIsoDate(item?.startDate || item?.start_date);
  const originalEnd = normalizeIsoDate(item?.endDate || item?.end_date || originalStart);
  if (!originalStart || !originalEnd || originalEnd < today) return [];
  const startDate = originalStart < today ? today : originalStart;
  if (cleanString(item?.id) === incoming.id) return [];
  if (originalEnd < incoming.startDate || startDate > incoming.endDate) {
    return [{ ...item, startDate, endDate: originalEnd }];
  }

  const baseId = (cleanString(item?.id) || 'special-hours').slice(0, 48);
  const segments = [];
  if (startDate < incoming.startDate) {
    const endDate = addIsoDateDays(incoming.startDate, -1);
    if (endDate && endDate >= startDate) {
      segments.push({
        ...item,
        id: `${baseId}-before-${incoming.startDate}`.slice(0, 80),
        startDate,
        endDate,
      });
    }
  }
  if (originalEnd > incoming.endDate) {
    const afterStart = addIsoDateDays(incoming.endDate, 1);
    if (afterStart && afterStart <= originalEnd) {
      segments.push({
        ...item,
        id: `${baseId}-after-${incoming.endDate}`.slice(0, 80),
        startDate: afterStart,
        endDate: originalEnd,
      });
    }
  }
  return segments;
}

async function applyScheduledSpecialHoursPeriod(clinicIdRaw, payload = {}) {
  const resolved = await resolveEffectiveLocations(clinicIdRaw);
  const location = resolved?.locations?.[0] || null;
  if (!location) throw specialHoursError('business_profile_location_not_configured', 409);

  const requested = normalizeSpecialHoursPlan({
    timeZone: payload.timeZone || payload.time_zone || resolved.timeZone,
    periods: [payload.period || payload],
  }, resolved.timeZone);
  const incoming = requested.periods[0];
  const raw = rawPayload(location);
  const storedPlan = raw.clinicaclick_special_hours_plan;
  const storedPeriods = Array.isArray(storedPlan?.periods) ? storedPlan.periods : [];
  const today = todayInTimeZone(requested.timeZone);
  const preserved = storedPeriods.flatMap((item) => preserveSpecialHoursOutsideRange(item, incoming, today));

  return updateSpecialHours(resolved, {
    timeZone: requested.timeZone,
    periods: [...preserved, incoming],
  });
}

function googleTimeToHHmm(value) {
  if (!value || typeof value !== 'object') return null;
  const rawHours = value.hours ?? value.hour;
  if (rawHours === undefined || rawHours === null || rawHours === '') return null;
  const hours = Number(rawHours);
  const minutes = Number(value.minutes ?? value.minute ?? 0);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes)) return null;
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function hhmmToMinutes(value) {
  const match = String(value || '').match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;
  const minutes = Number(match[1]) * 60 + Number(match[2]);
  return Number.isFinite(minutes) ? minutes : null;
}

function minutesToHHmm(value) {
  const minutes = Math.max(0, Math.min((24 * 60) - 1, Math.round(Number(value || 0))));
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function googleDayToClinicDay(value) {
  const normalized = String(value || '').trim().toUpperCase();
  const map = {
    SUNDAY: 0,
    MONDAY: 1,
    TUESDAY: 2,
    WEDNESDAY: 3,
    THURSDAY: 4,
    FRIDAY: 5,
    SATURDAY: 6,
  };
  return Object.prototype.hasOwnProperty.call(map, normalized) ? map[normalized] : null;
}

function normalizeGoogleHoursPeriods(periods) {
  const byDay = new Map();

  for (const period of Array.isArray(periods) ? periods : []) {
    const openDay = googleDayToClinicDay(period?.openDay || period?.open_day || period?.day);
    const closeDay = googleDayToClinicDay(period?.closeDay || period?.close_day || period?.openDay || period?.open_day || period?.day);
    const open = googleTimeToHHmm(period?.openTime || period?.open_time);
    const close = googleTimeToHHmm(period?.closeTime || period?.close_time);
    const startMin = hhmmToMinutes(open);
    const endMin = hhmmToMinutes(close);
    if (openDay === null || closeDay === null || startMin === null || endMin === null) continue;

    const push = (day, start, end) => {
      if (day === null || start === null || end === null || end <= start) return;
      const list = byDay.get(day) || [];
      list.push({ startMin: start, endMin: end });
      byDay.set(day, list);
    };

    if (openDay === closeDay) {
      push(openDay, startMin, endMin);
    } else {
      push(openDay, startMin, (24 * 60) - 1);
      push(closeDay, 0, endMin);
    }
  }

  const rows = [];
  for (const [day, intervals] of byDay.entries()) {
    const sorted = [...intervals].sort((left, right) => left.startMin - right.startMin || left.endMin - right.endMin);
    const merged = [];
    for (const interval of sorted) {
      const last = merged[merged.length - 1];
      if (last && interval.startMin <= last.endMin) {
        last.endMin = Math.max(last.endMin, interval.endMin);
      } else {
        merged.push({ ...interval });
      }
    }
    for (const interval of merged) {
      rows.push({
        dia_semana: day,
        activo: true,
        hora_inicio: minutesToHHmm(interval.startMin),
        hora_fin: minutesToHHmm(interval.endMin),
      });
    }
  }
  return rows.sort((left, right) => left.dia_semana - right.dia_semana || left.hora_inicio.localeCompare(right.hora_inicio));
}

async function importRegularHoursToClinic(resolved) {
  if (!ClinicaHorario) {
    const error = new Error('clinic_hours_model_unavailable');
    error.status = 503;
    throw error;
  }
  const location = resolved.locations[0] || null;
  if (!location) {
    const error = new Error('business_profile_location_not_configured');
    error.status = 409;
    throw error;
  }
  const raw = rawPayload(location);
  const periods = location.regularHours?.periods
    || location.regular_hours?.periods
    || raw.regularHours?.periods
    || raw.regular_hours?.periods
    || [];
  const rows = normalizeGoogleHoursPeriods(periods).map((row) => ({
    ...row,
    clinica_id: resolved.clinicId,
  }));
  if (!rows.length) {
    const error = new Error('business_profile_hours_empty');
    error.status = 409;
    throw error;
  }

  const horarios = await sequelize.transaction(async (transaction) => {
    await ClinicaHorario.destroy({
      where: { clinica_id: resolved.clinicId },
      transaction,
    });
    await ClinicaHorario.bulkCreate(rows, { transaction });
    return ClinicaHorario.findAll({
      where: { clinica_id: resolved.clinicId },
      order: [['dia_semana', 'ASC'], ['hora_inicio', 'ASC'], ['id', 'ASC']],
      transaction,
    });
  });

  return {
    success: true,
    imported: rows.length,
    horarios,
  };
}

module.exports = {
  METRIC_DEFINITIONS,
  GBP_MEDIA_CATEGORIES,
  resolveDateRange,
  resolveEffectiveLocations,
  resolvePhotoMutationClinicIds,
  buildStatus,
  buildOverview,
  buildTimeseries,
  buildSeasonality,
  listReviews,
  listPosts,
  buildContent,
  buildReviewInsights,
  buildDashboard,
  updateSpecialHours,
  applyScheduledSpecialHoursPeriod,
  importRegularHoursToClinic,
  publishPhoto,
  serializeLocation,
  normalizeServiceItem,
  normalizeMediaItem,
  buildGoogleRatingSummary,
  collapseMetricRows,
  metricValueByDate,
  isPublishableBusinessProfileMediaAsset,
  normalizeSpecialHoursPlan,
  buildGoogleSpecialHourPeriods,
  preserveSpecialHoursOutsideRange,
};
