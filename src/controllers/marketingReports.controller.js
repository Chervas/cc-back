'use strict';

const { Op, fn, col, literal } = require('sequelize');
const db = require('../../models');
const { resolveClinicScope, buildAssetScopeWhere } = require('../lib/clinicScope');
const webEventsService = require('../services/webEvents.service');
const {
  resolveEffectiveMarketingAssetInventory,
} = require('../services/effectiveMarketingAssets.service');
const { hasMarketingClinicScopeAccess } = require('../lib/marketingScopeAccess');
const { isGlobalAdmin } = require('../lib/role-helpers');
const {
  METRIC_DEFINITIONS: BUSINESS_PROFILE_LOCAL_METRIC_DEFINITIONS,
  collapseMetricRows: collapseBusinessProfileMetricRows,
  metricValueByDate: businessProfileMetricValueByDate,
} = require('../services/businessProfileLocal.service');

const {
  LeadIntake,
  FormSubmissionEvent,
  CitaPaciente,
  IntakeConfig,
  ClinicWebAsset,
  ClinicAnalyticsProperty,
  GoogleAdsInsightsDaily,
  ClinicGoogleAdsAccount,
  SocialAdsInsightsDaily,
  SocialAdsActionsDaily,
  SocialAdsAdsetDailyAgg,
  SocialAdsEntity,
  ClinicMetaAsset,
  SocialStatsDaily,
  SocialPosts,
  WebScDaily,
  WebScQueryDaily,
  WebGaDaily,
  ClinicBusinessLocation,
  BusinessProfileDailyMetric,
  BusinessProfileReview,
  JobRequest,
  WhatsAppWebOrigin,
  WebPageDaily,
  WebSessionDaily,
} = db;

const QueryTypes = db.Sequelize.QueryTypes;
const sequelize = db.sequelize;

const DAY_MS = 86400000;
const GOOGLE_ADS_REMOTE_FACT_GROUP = [
  'clinicaId',
  'grupoClinicaId',
  'customerId',
  'campaignId',
  'date',
  'adGroupId',
  'network',
  'device',
];
const CITED_LEAD_STATUSES = new Set(['citado', 'acudio_cita', 'convertido']);
const ATTENDED_LEAD_STATUSES = new Set(['acudio_cita', 'convertido']);
const CONVERTED_LEAD_STATUSES = new Set(['convertido']);
const CONTACTED_LEAD_STATUSES = new Set(['contactado', 'esperando_info', 'info_recibida', 'cualificado', 'citado', 'acudio_cita', 'convertido']);

function parseDate(value, fallback) {
  if (!value) return fallback;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return fallback;
  parsed.setHours(0, 0, 0, 0);
  return parsed;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function formatDateTime(date) {
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function buildRange(startDate, endDate, fallbackDays = 30) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const end = parseDate(endDate, today);
  const startFallback = new Date(end.getTime() - (fallbackDays - 1) * DAY_MS);
  const start = parseDate(startDate, startFallback);
  if (end < start) {
    const err = new Error('Rango de fechas inválido');
    err.status = 400;
    throw err;
  }
  const endExclusive = new Date(end.getTime() + DAY_MS);
  const spanDays = Math.round((end - start) / DAY_MS) + 1;
  const previousEnd = new Date(start.getTime() - DAY_MS);
  const previousStart = new Date(previousEnd.getTime() - (spanDays - 1) * DAY_MS);
  return {
    start,
    end,
    endExclusive,
    spanDays,
    startLabel: formatDate(start),
    endLabel: formatDate(end),
    startSql: formatDateTime(start),
    endExclusiveSql: formatDateTime(endExclusive),
    previous: {
      start: previousStart,
      end: previousEnd,
      endExclusive: new Date(previousEnd.getTime() + DAY_MS),
      startLabel: formatDate(previousStart),
      endLabel: formatDate(previousEnd),
      startSql: formatDateTime(previousStart),
      endExclusiveSql: formatDateTime(new Date(previousEnd.getTime() + DAY_MS)),
    },
  };
}

function enumerateDateLabels(range) {
  const labels = [];
  for (let ts = range.start.getTime(); ts < range.endExclusive.getTime(); ts += DAY_MS) {
    labels.push(formatDate(new Date(ts)));
  }
  return labels;
}

function compactNumericSeries(values, maxPoints = 18) {
  const list = Array.isArray(values) ? values.map((value) => toNumber(value)) : [];
  if (list.length <= maxPoints) return list;
  const bucketSize = Math.ceil(list.length / maxPoints);
  const compacted = [];
  for (let index = 0; index < list.length; index += bucketSize) {
    const bucket = list.slice(index, index + bucketSize);
    compacted.push(round(bucket.reduce((sum, value) => sum + value, 0), 2));
  }
  return compacted;
}

function toNumber(value) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

function round(value, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round(toNumber(value) * factor) / factor;
}

function pct(current, previous) {
  const cur = toNumber(current);
  const prev = toNumber(previous);
  if (!prev) return undefined;
  return round(((cur - prev) / prev) * 100, 1);
}

function ratioPct(numerator, denominator, decimals = 1) {
  const den = toNumber(denominator);
  if (!den) return 0;
  return round((toNumber(numerator) / den) * 100, decimals);
}

function money(value) {
  return round(value, 2);
}

function googleAdsRemoteFactAttributes() {
  return [
    ...GOOGLE_ADS_REMOTE_FACT_GROUP,
    [fn('MAX', col('campaignName')), 'campaignName'],
    [fn('MAX', col('impressions')), 'impressions'],
    [fn('MAX', col('clicks')), 'clicks'],
    [fn('MAX', col('costMicros')), 'costMicros'],
    [fn('MAX', col('conversions')), 'conversions'],
  ];
}

function dateLabel(start, end) {
  return `${start} - ${end}`;
}

function relativeSyncLabel(value) {
  if (!value) return undefined;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return String(value).slice(0, 10);
  return date.toISOString().slice(0, 10);
}

function buildSequelizeDateWhere(field, range) {
  return {
    [field]: {
      [Op.gte]: range.start,
      [Op.lt]: range.endExclusive,
    },
  };
}

function buildDateOnlyWhere(field, range) {
  return {
    [field]: {
      [Op.between]: [range.startLabel, range.endLabel],
    },
  };
}

function normalizeDateOnly(value) {
  if (!value) return null;
  const direct = String(value).trim().slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(direct)) return direct;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString().slice(0, 10) : null;
}

function humanDateEs(value) {
  const normalized = normalizeDateOnly(value);
  if (!normalized) return null;
  const [year, month, day] = normalized.split('-').map(Number);
  const months = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  return `${day} ${months[month - 1]} ${year}`;
}

function comparablePaidRangeStart(range, coverageStart) {
  const normalizedCoverageStart = normalizeDateOnly(coverageStart);
  if (!normalizedCoverageStart) return range.startLabel;
  return normalizedCoverageStart > range.startLabel
    ? normalizedCoverageStart
    : range.startLabel;
}

function buildComparablePaidDateWhere(field, range, coverageStart) {
  return {
    [field]: {
      [Op.between]: [comparablePaidRangeStart(range, coverageStart), range.endLabel],
    },
  };
}

function scopedWhere(field, scope) {
  if (scope.isAll) return {};
  const clinicIds = Array.isArray(scope.clinicIds) ? scope.clinicIds : [];
  if (!clinicIds.length) return { [field]: { [Op.in]: [] } };
  return clinicIds.length === 1
    ? { [field]: clinicIds[0] }
    : { [field]: { [Op.in]: clinicIds } };
}

function scopedRawSql(field, scope, replacements, key) {
  if (scope.isAll) return '';
  const clinicIds = Array.isArray(scope.clinicIds) ? scope.clinicIds : [];
  if (!clinicIds.length) return ' AND 1 = 0';
  if (clinicIds.length === 1) {
    replacements[key] = clinicIds[0];
    return ` AND ${field} = :${key}`;
  }
  replacements[key] = clinicIds;
  return ` AND ${field} IN (:${key})`;
}

function scopedRawOrEffectiveSql(
  scopeField,
  scope,
  replacements,
  scopeKey,
  effectiveField,
  effectiveIds,
  effectiveKey
) {
  if (
    !scope?.isAll
    && effectiveIds.length
    && (scope?.scope === 'group' || scope?.scope === 'multi')
  ) {
    replacements[effectiveKey] = effectiveIds;
    return ` AND ${effectiveField} IN (:${effectiveKey})`;
  }
  const historicalSql = scopedRawSql(scopeField, scope, replacements, scopeKey);
  if (!effectiveIds.length || scope?.isAll) return historicalSql;
  replacements[effectiveKey] = effectiveIds;
  const historicalCondition = historicalSql.startsWith(' AND ')
    ? historicalSql.slice(5)
    : '1 = 1';
  return ` AND (${historicalCondition} OR ${effectiveField} IN (:${effectiveKey}))`;
}

function buildAdsScopeWhere(scope, clinicField, groupField) {
  if (scope.isAll) return {};
  const clinicIds = Array.isArray(scope.clinicIds) ? scope.clinicIds : [];
  if (scope.scope === 'group' && scope.groupId) {
    const clauses = [];
    if (clinicIds.length) {
      clauses.push(clinicIds.length === 1
        ? { [clinicField]: clinicIds[0] }
        : { [clinicField]: { [Op.in]: clinicIds } });
    }
    clauses.push({ [clinicField]: { [Op.is]: null }, [groupField]: scope.groupId });
    return { [Op.or]: clauses };
  }
  return scopedWhere(clinicField, scope);
}

function sourceMatchesSocialOrganic(utmSource) {
  const value = String(utmSource || '').toLowerCase();
  return ['instagram', 'facebook', 'fb', 'ig', 'linkedin', 'tiktok', 'social', 'threads'].some((token) => value.includes(token));
}

function hasAttributionValue(value) {
  return String(value ?? '').trim().length > 0;
}

function deriveChannelKey(row) {
  const source = String(row.source || 'unknown').toLowerCase();
  const utmSource = String(row.utm_source || '').toLowerCase();
  if (
    hasAttributionValue(row.google_ads_customer_id)
    || hasAttributionValue(row.google_ads_campaign_id)
    || hasAttributionValue(row.gclid)
    || hasAttributionValue(row.gbraid)
    || hasAttributionValue(row.wbraid)
  ) return 'google_ads';
  if (hasAttributionValue(row.fbclid)) return 'meta_ads';
  if (source === 'google_ads') return 'google_ads';
  if (source === 'meta_ads' || source === 'tiktok_ads') return 'meta_ads';
  if (source === 'seo') return 'seo';
  if (source === 'whatsapp') return 'whatsapp';
  if (source === 'call_click') return 'call_click';
  if (source === 'local_services') return 'local_services';
  if (sourceMatchesSocialOrganic(utmSource)) return 'social_organic';
  if (source === 'direct') return 'direct';
  return 'web';
}

const LEAD_ACQUISITION_CHANNEL_SQL = `CASE
  WHEN NULLIF(TRIM(COALESCE(google_ads_customer_id, '')), '') IS NOT NULL
    OR NULLIF(TRIM(COALESCE(google_ads_campaign_id, '')), '') IS NOT NULL
    OR NULLIF(TRIM(COALESCE(gclid, '')), '') IS NOT NULL
    OR NULLIF(TRIM(COALESCE(gbraid, '')), '') IS NOT NULL
    OR NULLIF(TRIM(COALESCE(wbraid, '')), '') IS NOT NULL
    THEN 'google_ads'
  WHEN NULLIF(TRIM(COALESCE(fbclid, '')), '') IS NOT NULL THEN 'meta_ads'
  WHEN LOWER(COALESCE(source, '')) = 'google_ads' THEN 'google_ads'
  WHEN LOWER(COALESCE(source, '')) IN ('meta_ads', 'tiktok_ads') THEN 'meta_ads'
  WHEN LOWER(COALESCE(source, '')) = 'seo' THEN 'seo'
  WHEN LOWER(COALESCE(source, '')) = 'whatsapp' THEN 'whatsapp'
  WHEN LOWER(COALESCE(source, '')) = 'call_click' THEN 'call_click'
  WHEN LOWER(COALESCE(source, '')) = 'local_services' THEN 'local_services'
  WHEN LOWER(COALESCE(utm_source, '')) LIKE '%instagram%'
    OR LOWER(COALESCE(utm_source, '')) LIKE '%facebook%'
    OR LOWER(COALESCE(utm_source, '')) LIKE '%linkedin%'
    OR LOWER(COALESCE(utm_source, '')) LIKE '%tiktok%'
    OR LOWER(COALESCE(utm_source, '')) LIKE '%threads%'
    OR LOWER(COALESCE(utm_source, '')) = 'fb'
    OR LOWER(COALESCE(utm_source, '')) = 'ig'
    OR LOWER(COALESCE(utm_source, '')) = 'social'
    THEN 'social_organic'
  WHEN LOWER(COALESCE(source, '')) = 'direct' THEN 'direct'
  ELSE 'web'
END`;

async function resolvePaidAttributionCoverage(scope, dependencies = {}) {
  const LeadModel = dependencies.LeadIntake || LeadIntake;
  if (!LeadModel) {
    return {
      start: null,
      googleAdsStart: null,
      metaAdsStart: null,
    };
  }

  const rows = await LeadModel.findAll({
    attributes: [
      [fn('MIN', literal(`CASE WHEN (${LEAD_ACQUISITION_CHANNEL_SQL}) = 'google_ads' THEN created_at END`)), 'googleAdsStart'],
      [fn('MIN', literal(`CASE WHEN (${LEAD_ACQUISITION_CHANNEL_SQL}) = 'meta_ads' THEN created_at END`)), 'metaAdsStart'],
    ],
    where: {
      archived_at: null,
      ...scopedWhere('clinica_id', scope),
    },
    raw: true,
  });

  const googleAdsStart = normalizeDateOnly(rows?.[0]?.googleAdsStart);
  const metaAdsStart = normalizeDateOnly(rows?.[0]?.metaAdsStart);
  const starts = [googleAdsStart, metaAdsStart].filter(Boolean).sort();

  return {
    start: starts[0] || null,
    googleAdsStart,
    metaAdsStart,
  };
}

function buildPaidAttributionCoverageSummary(range, coverage) {
  const commonStart = normalizeDateOnly(coverage?.start);
  const effectiveStart = commonStart
    ? comparablePaidRangeStart(range, commonStart)
    : range.startLabel;
  const truncated = Boolean(commonStart && commonStart > range.startLabel);
  const hasComparableData = !commonStart || effectiveStart <= range.endLabel;

  return {
    start: commonStart,
    effectiveStart,
    truncated,
    hasComparableData,
    basis: commonStart ? 'first_attributable_paid_lead' : 'selected_period',
    note: truncated
      ? (hasComparableData
        ? `La inversión y los costes publicitarios se calculan desde el ${humanDateEs(commonStart)}, primer día con un lead atribuible a publicidad en ClinicaClick. El resto del informe conserva el periodo seleccionado.`
        : `En este periodo ClinicaClick todavía no podía atribuir leads publicitarios. Por eso no mezclamos el gasto histórico con leads posteriores; la medición comparable empieza el ${humanDateEs(commonStart)}.`)
      : null,
  };
}

function emptyChannelStats() {
  return { leads: 0, citas: 0, acudieron: 0, convertidos: 0 };
}

function sumChannelStats(channels, keys, field) {
  return keys.reduce((sum, key) => sum + toNumber(channels.get(key)?.[field]), 0);
}

function channelLabel(key) {
  const map = {
    google_ads: { name: 'Google Ads', icon: 'brand:google-ads', source: 'Google Ads' },
    meta_ads: { name: 'Meta Ads (Facebook / Instagram)', icon: 'brand:meta', source: 'Meta Ads' },
    seo: { name: 'SEO (búsqueda orgánica)', icon: 'brand:google', source: 'Search Console' },
    web: {
      name: 'Web propia (sin campaña)',
      icon: 'heroicons_outline:globe-alt',
      source: 'ClinicaClick',
      helpText: 'Formularios, chat o teléfono de la web sin una señal que permita atribuir el contacto a Ads, SEO o redes sociales.',
    },
    direct: { name: 'Directo', icon: 'heroicons_outline:globe-alt', source: 'ClinicaClick' },
    whatsapp: { name: 'WhatsApp', icon: 'heroicons_outline:chat-bubble-left-right', source: 'ClinicaClick' },
    social_organic: { name: 'Redes sociales orgánico', icon: 'heroicons_outline:share', source: 'Redes sociales' },
    call_click: { name: 'Llamada telefónica', icon: 'heroicons_outline:phone', source: 'ClinicaClick' },
    local_services: { name: 'Perfil de Empresa Google', icon: 'brand:google-business-profile', source: 'Perfil Google' },
  };
  return map[key] || { name: 'Otros', icon: 'heroicons_outline:squares-2x2', source: 'ClinicaClick' };
}

function socialPlatformLabel(assetType) {
  return assetType === 'instagram_business' ? 'Instagram' : 'Facebook';
}

function truncateText(value, fallback = 'Publicación') {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return fallback;
  return text.length > 96 ? `${text.slice(0, 93)}...` : text;
}

async function resolveReportScope(req) {
  const rawScope = req.query.clinicId || req.query.clinica_id || req.query.scope || 'all';
  const scope = await resolveClinicScope(rawScope, { allowAll: true });
  if (scope.notFound) {
    const err = new Error('Grupo de clínicas no encontrado');
    err.status = 404;
    throw err;
  }
  if (!scope.isValid && !scope.isAll) {
    const err = new Error('clinicId/grupo inválido');
    err.status = 400;
    throw err;
  }
  return scope;
}

function buildEffectiveMarketingStateInput(scope) {
  if (scope?.scope === 'clinic' && scope.clinicIds?.length === 1) {
    return {
      clinicIdRaw: scope.clinicIds[0],
      groupIdRaw: null,
      assignmentScopeRaw: 'clinic',
    };
  }
  if (scope?.scope === 'group' && scope.groupId) {
    return {
      clinicIdRaw: null,
      groupIdRaw: scope.groupId,
      assignmentScopeRaw: 'group',
    };
  }
  return null;
}

async function resolveReportMarketingState(scope, dependencies = {}) {
  const resolver = dependencies.resolveEffectiveMarketingAssetInventory
    || resolveEffectiveMarketingAssetInventory;
  const input = buildEffectiveMarketingStateInput(scope);
  if (input) return resolver(input);
  if (scope?.scope !== 'multi' || !Array.isArray(scope.clinicIds) || !scope.clinicIds.length) {
    return null;
  }

  const states = await Promise.all(scope.clinicIds.map((clinicId) => resolver({
    clinicIdRaw: clinicId,
    groupIdRaw: null,
    assignmentScopeRaw: 'clinic',
  })));
  return mergeEffectiveMarketingStates(states, scope);
}

function effectiveGoogleAccounts(marketingState) {
  return Array.isArray(marketingState?.google?.available_accounts)
    ? marketingState.google.available_accounts
    : [];
}

function effectiveMetaAssets(marketingState) {
  const assets = marketingState?.meta?.available_assets;
  return {
    adAccounts: Array.isArray(assets?.ad_accounts) ? assets.ad_accounts : [],
    facebookPages: Array.isArray(assets?.facebook_pages) ? assets.facebook_pages : [],
    instagramAccounts: Array.isArray(assets?.instagram_business) ? assets.instagram_business : [],
  };
}

function effectiveGoogleProperties(marketingState) {
  const assets = marketingState?.google?.available_assets;
  return {
    searchConsole: Array.isArray(assets?.search_console) ? assets.search_console : [],
    analytics: Array.isArray(assets?.analytics) ? assets.analytics : [],
    businessProfiles: Array.isArray(assets?.business_profile) ? assets.business_profile : [],
  };
}

function normalizedUniqueStrings(values) {
  return Array.from(new Set((values || [])
    .map((value) => String(value || '').trim())
    .filter(Boolean)));
}

function normalizedUniqueIntegers(values) {
  return Array.from(new Set((values || [])
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0)));
}

function dedupeRows(rows, keyBuilder) {
  const seen = new Set();
  return (rows || []).filter((row) => {
    const key = keyBuilder(row);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function mergeEffectiveMarketingStates(states, scope) {
  const validStates = (states || []).filter(Boolean);
  const googleAccounts = dedupeRows(
    validStates.flatMap((state) => effectiveGoogleAccounts(state)),
    (row) => String(row.customer_id || '').replace(/\D+/g, '')
  );
  const metaAssets = validStates.map((state) => effectiveMetaAssets(state));
  const googleProperties = validStates.map((state) => effectiveGoogleProperties(state));
  const adAccounts = dedupeRows(
    metaAssets.flatMap((assets) => assets.adAccounts),
    (row) => String(row.ad_account_id || '').replace(/^act_/, '')
  );
  const facebookPages = dedupeRows(
    metaAssets.flatMap((assets) => assets.facebookPages),
    (row) => String(row.page_id || row.mapping_id || '')
  );
  const instagramAccounts = dedupeRows(
    metaAssets.flatMap((assets) => assets.instagramAccounts),
    (row) => String(row.instagram_business_id || row.mapping_id || '')
  );
  const searchConsole = dedupeRows(
    googleProperties.flatMap((assets) => assets.searchConsole),
    (row) => String(row.site_url || row.mapping_id || '').trim().toLowerCase().replace(/\/$/, '')
  );
  const analytics = dedupeRows(
    googleProperties.flatMap((assets) => assets.analytics),
    (row) => String(row.property_name || row.mapping_id || '').trim().toLowerCase()
  );
  const businessProfiles = dedupeRows(
    googleProperties.flatMap((assets) => assets.businessProfiles),
    (row) => String(row.location_id || row.mapping_id || '').trim().toLowerCase()
  );

  return {
    scope: {
      assignment_scope: 'multi',
      clinic_id: null,
      group_id: null,
      clinic_ids: [...scope.clinicIds],
    },
    descriptors: {},
    records: {},
    tracking: validStates[0]?.tracking || {},
    google: {
      available_accounts: googleAccounts,
      available_assets: {
        search_console: searchConsole,
        analytics,
        business_profile: businessProfiles,
      },
      effective_assets: {
        account: googleAccounts[0] || null,
        tag_id: null,
        search_console: searchConsole[0] || null,
        analytics: analytics[0] || null,
        business_profile: businessProfiles[0] || null,
      },
    },
    meta: {
      available_assets: {
        ad_accounts: adAccounts,
        facebook_pages: facebookPages,
        instagram_business: instagramAccounts,
      },
      effective_assets: {
        ad_account: adAccounts[0] || null,
        facebook_page: facebookPages[0] || null,
        instagram_business: instagramAccounts[0] || null,
      },
    },
  };
}

function effectiveGoogleCustomerIds(marketingState) {
  return normalizedUniqueStrings(effectiveGoogleAccounts(marketingState).map((account) => account.customer_id));
}

function effectiveMetaAdAccountIds(marketingState) {
  return normalizedUniqueStrings(effectiveMetaAssets(marketingState).adAccounts.map((account) => account.ad_account_id));
}

function effectiveSocialMappingIds(marketingState) {
  const assets = effectiveMetaAssets(marketingState);
  return normalizedUniqueIntegers([
    ...assets.facebookPages.map((asset) => asset.mapping_id),
    ...assets.instagramAccounts.map((asset) => asset.mapping_id),
  ]);
}

function effectiveSearchConsoleSiteUrls(marketingState) {
  return normalizedUniqueStrings(
    effectiveGoogleProperties(marketingState).searchConsole.map((asset) => asset.site_url)
  );
}

function effectiveSearchConsoleMetricPairs(marketingState, scope) {
  const aggregateScope = scope?.scope === 'group' || scope?.scope === 'multi';
  const historicalClinicIds = new Set((scope?.clinicIds || [])
    .map((value) => Number.parseInt(value, 10))
    .filter((value) => Number.isInteger(value) && value > 0));
  return dedupeRows(
    effectiveGoogleProperties(marketingState).searchConsole
      .map((asset) => ({
        clinica_id: Number.parseInt(asset.clinic_id, 10),
        site_url: String(asset.site_url || '').trim(),
      }))
      .filter((asset) => (
        Number.isInteger(asset.clinica_id)
        && asset.clinica_id > 0
        && asset.site_url
        && (aggregateScope || !historicalClinicIds.has(asset.clinica_id))
      )),
    (asset) => `${asset.clinica_id}:${asset.site_url.toLowerCase().replace(/\/$/, '')}`
  );
}

function effectiveAnalyticsMappingIds(marketingState) {
  return normalizedUniqueIntegers(
    effectiveGoogleProperties(marketingState).analytics.map((asset) => asset.mapping_id)
  );
}

function effectiveBusinessLocationIds(marketingState) {
  return normalizedUniqueIntegers(
    effectiveGoogleProperties(marketingState).businessProfiles.map((asset) => asset.mapping_id)
  );
}

function scopeWithEffectiveAssetOwners(scope, assets) {
  if (!scope || scope.isAll) return scope;
  const clinicIds = normalizedUniqueIntegers([
    ...(Array.isArray(scope.clinicIds) ? scope.clinicIds : []),
    ...(Array.isArray(assets) ? assets.map((asset) => asset?.clinic_id) : []),
  ]);
  if (
    clinicIds.length === (scope.clinicIds || []).length
    && clinicIds.every((clinicId, index) => clinicId === scope.clinicIds[index])
  ) {
    return scope;
  }
  return { ...scope, clinicIds };
}

function applyEffectiveAssetIdFilter(where, field, ids) {
  if (!ids.length) return where;
  return {
    ...where,
    [field]: ids.length === 1 ? ids[0] : { [Op.in]: ids },
  };
}

function buildHistoricalOrEffectiveWhere(scope, scopeField, effectiveField, ids) {
  const historicalScope = scopedWhere(scopeField, scope);
  if (!ids.length || scope?.isAll) return historicalScope;
  const effectiveScope = applyEffectiveAssetIdFilter({}, effectiveField, ids);
  if (scope?.scope === 'group' || scope?.scope === 'multi') return effectiveScope;
  return { [Op.or]: [historicalScope, effectiveScope] };
}

function buildEffectiveSnapshotWhere(scope, scopeField, effectiveField, ids) {
  const normalizedIds = normalizedUniqueIntegers(ids);
  if (!normalizedIds.length || scope?.isAll) return scopedWhere(scopeField, scope);
  return applyEffectiveAssetIdFilter({}, effectiveField, normalizedIds);
}

function buildSearchConsoleDataWhere(scope, marketingState) {
  const historicalScope = scopedWhere('clinica_id', scope);
  if (scope?.isAll) return historicalScope;
  const pairs = effectiveSearchConsoleMetricPairs(marketingState, scope);
  if (!pairs.length) return historicalScope;
  return scope?.scope === 'group' || scope?.scope === 'multi'
    ? { [Op.or]: pairs }
    : { [Op.or]: [historicalScope, ...pairs] };
}

function searchConsoleRawScopeSql(scope, marketingState, replacements, keyPrefix) {
  const historicalSql = scopedRawSql(
    'clinica_id',
    scope,
    replacements,
    `${keyPrefix}ClinicIds`
  );
  if (scope?.isAll) return historicalSql;
  const pairs = effectiveSearchConsoleMetricPairs(marketingState, scope);
  if (!pairs.length) return historicalSql;
  const historicalCondition = historicalSql.startsWith(' AND ')
    ? historicalSql.slice(5)
    : '1 = 1';
  const pairConditions = pairs.map((pair, index) => {
    const ownerKey = `${keyPrefix}Owner${index}`;
    const siteKey = `${keyPrefix}Site${index}`;
    replacements[ownerKey] = pair.clinica_id;
    replacements[siteKey] = pair.site_url;
    return `(clinica_id = :${ownerKey} AND site_url = :${siteKey})`;
  });
  if (scope?.scope === 'group' || scope?.scope === 'multi') {
    return ` AND (${pairConditions.join(' OR ')})`;
  }
  return ` AND (${historicalCondition} OR ${pairConditions.join(' OR ')})`;
}

function buildGoogleAdsDataWhere(scope, marketingState) {
  void marketingState;
  return buildAdsScopeWhere(scope, 'clinicaId', 'grupoClinicaId');
}

function buildMetaAdsDataWhere(scope, marketingState) {
  void marketingState;
  return buildAdsScopeWhere(scope, 'clinica_id', 'grupo_clinica_id');
}

function latestEffectiveGoogleSync(marketingState) {
  return effectiveGoogleAccounts(marketingState)
    .map((account) => account.last_synced_at)
    .filter(Boolean)
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] || null;
}

async function aggregateLeads(scope, range) {
  const where = {
    archived_at: null,
    ...scopedWhere('clinica_id', scope),
    ...buildSequelizeDateWhere('created_at', range),
  };
  const rows = await LeadIntake.findAll({
    attributes: [
      [literal(LEAD_ACQUISITION_CHANNEL_SQL), 'channel_key'],
      'status_lead',
      [fn('COUNT', col('id')), 'count'],
    ],
    where,
    group: [literal(LEAD_ACQUISITION_CHANNEL_SQL), 'status_lead'],
    raw: true,
  });

  const channels = new Map();
  const totals = { leads: 0, contactados: 0, citas: 0, acudieron: 0, convertidos: 0 };

  for (const row of rows) {
    const count = toNumber(row.count);
    const status = String(row.status_lead || '').toLowerCase();
    const key = String(row.channel_key || deriveChannelKey(row));
    if (!channels.has(key)) channels.set(key, emptyChannelStats());
    const entry = channels.get(key);
    entry.leads += count;
    totals.leads += count;
    if (CONTACTED_LEAD_STATUSES.has(status)) totals.contactados += count;
    if (CITED_LEAD_STATUSES.has(status)) {
      entry.citas += count;
      totals.citas += count;
    }
    if (ATTENDED_LEAD_STATUSES.has(status)) {
      entry.acudieron += count;
      totals.acudieron += count;
    }
    if (CONVERTED_LEAD_STATUSES.has(status)) {
      entry.convertidos += count;
      totals.convertidos += count;
    }
  }

  return { totals, channels };
}

async function aggregateLeadSeries(scope, range) {
  if (!LeadIntake) return { leads: [], paidLeads: [], citas: [], acudieron: [], convertidos: [] };
  const labels = enumerateDateLabels(range);
  const empty = labels.map(() => 0);
  const byDate = new Map(labels.map((label) => [label, {
    leads: 0,
    paidLeads: 0,
    citas: 0,
    acudieron: 0,
    convertidos: 0,
  }]));

  const rows = await LeadIntake.findAll({
    attributes: [
      [fn('DATE', col('created_at')), 'date'],
      [literal(LEAD_ACQUISITION_CHANNEL_SQL), 'channel_key'],
      'status_lead',
      [fn('COUNT', col('id')), 'count'],
    ],
    where: {
      archived_at: null,
      ...scopedWhere('clinica_id', scope),
      ...buildSequelizeDateWhere('created_at', range),
    },
    group: [literal('DATE(created_at)'), literal(LEAD_ACQUISITION_CHANNEL_SQL), 'status_lead'],
    raw: true,
  });

  for (const row of rows) {
    const date = String(row.date || '').slice(0, 10);
    const bucket = byDate.get(date);
    if (!bucket) continue;
    const count = toNumber(row.count);
    const status = String(row.status_lead || '').toLowerCase();
    const channelKey = String(row.channel_key || deriveChannelKey(row));
    bucket.leads += count;
    if (channelKey === 'google_ads' || channelKey === 'meta_ads') bucket.paidLeads += count;
    if (CITED_LEAD_STATUSES.has(status)) bucket.citas += count;
    if (ATTENDED_LEAD_STATUSES.has(status)) bucket.acudieron += count;
    if (CONVERTED_LEAD_STATUSES.has(status)) bucket.convertidos += count;
  }

  if (!labels.length) return { leads: empty, paidLeads: empty, citas: empty, acudieron: empty, convertidos: empty };
  return {
    leads: labels.map((label) => byDate.get(label)?.leads || 0),
    paidLeads: labels.map((label) => byDate.get(label)?.paidLeads || 0),
    citas: labels.map((label) => byDate.get(label)?.citas || 0),
    acudieron: labels.map((label) => byDate.get(label)?.acudieron || 0),
    convertidos: labels.map((label) => byDate.get(label)?.convertidos || 0),
  };
}

async function countAppointments(scope, range) {
  if (!CitaPaciente) return { creadas: 0, completadas: 0, noAsistio: 0 };
  const baseWhere = {
    ...scopedWhere('clinica_id', scope),
    ...buildSequelizeDateWhere('created_at', range),
    lead_intake_id: { [Op.ne]: null },
  };
  const [creadas, completadas, noAsistio] = await Promise.all([
    CitaPaciente.count({ where: baseWhere }),
    CitaPaciente.count({ where: { ...baseWhere, estado: 'completada' } }),
    CitaPaciente.count({ where: { ...baseWhere, estado: 'no_asistio' } }),
  ]);
  return { creadas, completadas, noAsistio };
}

async function aggregateAppointmentSeries(scope, range) {
  if (!CitaPaciente) return { citas: [], acudieron: [] };
  const labels = enumerateDateLabels(range);
  const byDate = new Map(labels.map((label) => [label, { citas: 0, acudieron: 0 }]));

  const rows = await CitaPaciente.findAll({
    attributes: [
      [fn('DATE', col('created_at')), 'date'],
      'estado',
      [fn('COUNT', col('id_cita')), 'count'],
    ],
    where: {
      ...scopedWhere('clinica_id', scope),
      ...buildSequelizeDateWhere('created_at', range),
      lead_intake_id: { [Op.ne]: null },
    },
    group: [literal('DATE(created_at)'), 'estado'],
    raw: true,
  });

  for (const row of rows) {
    const date = String(row.date || '').slice(0, 10);
    const bucket = byDate.get(date);
    if (!bucket) continue;
    const count = toNumber(row.count);
    bucket.citas += count;
    if (String(row.estado || '').toLowerCase() === 'completada') bucket.acudieron += count;
  }

  return {
    citas: labels.map((label) => byDate.get(label)?.citas || 0),
    acudieron: labels.map((label) => byDate.get(label)?.acudieron || 0),
  };
}

async function aggregateSpendSeries(scope, range, marketingState = null, paidCoverageStart = null) {
  const labels = enumerateDateLabels(range);
  const byDate = new Map(labels.map((label) => [label, 0]));

  if (GoogleAdsInsightsDaily) {
    const rows = await GoogleAdsInsightsDaily.findAll({
      attributes: googleAdsRemoteFactAttributes(),
      where: {
        ...buildGoogleAdsDataWhere(scope, marketingState),
        ...buildComparablePaidDateWhere('date', range, paidCoverageStart),
      },
      group: GOOGLE_ADS_REMOTE_FACT_GROUP,
      raw: true,
    });
    for (const row of rows) {
      const date = String(row.date || '').slice(0, 10);
      if (byDate.has(date)) {
        byDate.set(date, byDate.get(date) + (toNumber(row.costMicros) / 1_000_000));
      }
    }
  }

  if (SocialAdsInsightsDaily) {
    const rows = await SocialAdsInsightsDaily.findAll({
      attributes: [
        'date',
        [fn('SUM', col('spend')), 'spend'],
      ],
      where: {
        ...buildMetaAdsDataWhere(scope, marketingState),
        ...buildComparablePaidDateWhere('date', range, paidCoverageStart),
        level: 'campaign',
      },
      group: ['date'],
      raw: true,
    });
    for (const row of rows) {
      const date = String(row.date || '').slice(0, 10);
      if (byDate.has(date)) {
        byDate.set(date, byDate.get(date) + toNumber(row.spend));
      }
    }
  }

  return labels.map((label) => money(byDate.get(label) || 0));
}

async function aggregateForms(scope, range) {
  if (!FormSubmissionEvent) return 0;
  return FormSubmissionEvent.count({
    where: {
      ...scopedWhere('clinic_id', scope),
      ...buildSequelizeDateWhere('submitted_at', range),
    },
  });
}

async function aggregateWhatsappWebOrigins(scope, range) {
  const empty = { clicks: 0, confirmed: 0 };
  if (!WhatsAppWebOrigin) return empty;

  const [row] = await WhatsAppWebOrigin.findAll({
    attributes: [
      [fn('COUNT', col('id')), 'clicks'],
      [fn('SUM', literal('CASE WHEN used_at IS NOT NULL OR used_conversation_id IS NOT NULL OR used_message_id IS NOT NULL THEN 1 ELSE 0 END')), 'confirmed'],
    ],
    where: {
      ...scopedWhere('clinic_id', scope),
      ...buildSequelizeDateWhere('createdAt', range),
    },
    raw: true,
  });

  return {
    clicks: toNumber(row?.clicks),
    confirmed: toNumber(row?.confirmed),
  };
}

async function getIntakeConfigCount(scope) {
  if (!IntakeConfig) return 0;
  if (scope.isAll) return IntakeConfig.count();
  const clinicIds = Array.isArray(scope.clinicIds) ? scope.clinicIds : [];
  const clauses = [];
  if (clinicIds.length) {
    clauses.push(clinicIds.length === 1
      ? { clinic_id: clinicIds[0] }
      : { clinic_id: { [Op.in]: clinicIds } });
  }
  if (scope.scope === 'group' && scope.groupId) clauses.push({ group_id: scope.groupId });
  if (!clauses.length) return 0;
  return IntakeConfig.count({ where: { [Op.or]: clauses } });
}

async function aggregateGoogleAds(scope, range, marketingState = null, paidCoverageStart = null) {
  if (!GoogleAdsInsightsDaily) {
    return { totals: { spend: 0, clicks: 0, impressions: 0, conversions: 0 }, campaigns: [], connected: false, lastSync: null };
  }

  const where = {
    ...buildGoogleAdsDataWhere(scope, marketingState),
    ...buildComparablePaidDateWhere('date', range, paidCoverageStart),
  };

  const factRows = await GoogleAdsInsightsDaily.findAll({
    attributes: googleAdsRemoteFactAttributes(),
    where,
    group: GOOGLE_ADS_REMOTE_FACT_GROUP,
    raw: true,
  });

  const totalRow = {
    impressions: 0,
    clicks: 0,
    costMicros: 0,
    conversions: 0,
    lastDate: null,
  };
  const campaignMap = new Map();
  for (const row of factRows) {
    totalRow.impressions += toNumber(row.impressions);
    totalRow.clicks += toNumber(row.clicks);
    totalRow.costMicros += toNumber(row.costMicros);
    totalRow.conversions += toNumber(row.conversions);
    const date = normalizeDateOnly(row.date);
    if (date && (!totalRow.lastDate || date > totalRow.lastDate)) totalRow.lastDate = date;

    const campaignKey = `${String(row.customerId || '')}:${String(row.campaignId || '')}`;
    const campaign = campaignMap.get(campaignKey) || {
      campaignId: row.campaignId,
      campaignName: row.campaignName,
      costMicros: 0,
      conversions: 0,
      clicks: 0,
    };
    campaign.campaignName = campaign.campaignName || row.campaignName;
    campaign.costMicros += toNumber(row.costMicros);
    campaign.conversions += toNumber(row.conversions);
    campaign.clicks += toNumber(row.clicks);
    campaignMap.set(campaignKey, campaign);
  }
  const campaignRows = Array.from(campaignMap.values())
    .sort((left, right) => right.costMicros - left.costMicros)
    .slice(0, 5);

  const scopedAccounts = effectiveGoogleAccounts(marketingState);
  const accountWhere = buildAssetScopeWhere(scope);
  const activeAccounts = marketingState
    ? scopedAccounts.length
    : (ClinicGoogleAdsAccount ? await ClinicGoogleAdsAccount.count({ where: accountWhere }) : 0);
  const latestAccount = marketingState
    ? null
    : (ClinicGoogleAdsAccount
      ? await ClinicGoogleAdsAccount.findOne({ where: accountWhere, order: [['lastSyncedAt', 'DESC']], raw: true })
      : null);

  const spend = money(toNumber(totalRow?.costMicros) / 1_000_000);
  const totals = {
    spend,
    clicks: toNumber(totalRow?.clicks),
    impressions: toNumber(totalRow?.impressions),
    conversions: toNumber(totalRow?.conversions),
  };

  const campaigns = campaignRows.map((row) => {
    const inversion = money(toNumber(row.costMicros) / 1_000_000);
    const leads = Math.round(toNumber(row.conversions));
    return {
      name: row.campaignName || 'Campaña sin nombre',
      platform: 'Google Ads',
      inversion,
      leads,
      citas: 0,
      convertidos: 0,
      cpl: leads ? money(inversion / leads) : 0,
      cpaCita: 0,
      cpaConvertido: 0,
      alert: inversion >= 25 && leads === 0
        ? 'Esta campaña está gastando sin registrar conversiones en Google Ads. Revisa su destino y medición.'
        : undefined,
    };
  });

  return {
    totals,
    campaigns,
    connected: activeAccounts > 0,
    lastSync: latestEffectiveGoogleSync(marketingState) || latestAccount?.lastSyncedAt || totalRow?.lastDate || null,
  };
}

async function aggregateMetaAds(scope, range, marketingState = null, paidCoverageStart = null) {
  if (!SocialAdsInsightsDaily) {
    return { totals: { spend: 0, clicks: 0, impressions: 0, conversions: 0 }, campaigns: [], connected: false, lastSync: null };
  }

  const scopeWhere = buildMetaAdsDataWhere(scope, marketingState);
  const baseWhere = {
    ...scopeWhere,
    ...buildComparablePaidDateWhere('date', range, paidCoverageStart),
  };

  const fetchInsightRows = async (level) => {
    const where = { ...baseWhere, level };
    const [rows, totals] = await Promise.all([
      SocialAdsInsightsDaily.findAll({
        attributes: [
          'entity_id',
          [fn('SUM', col('spend')), 'spend'],
          [fn('SUM', col('clicks')), 'clicks'],
          [fn('SUM', col('impressions')), 'impressions'],
          [fn('MAX', col('date')), 'lastDate'],
        ],
        where,
        group: ['entity_id'],
        order: [[literal('SUM(spend)'), 'DESC']],
        limit: 5,
        raw: true,
      }),
      SocialAdsInsightsDaily.findAll({
        attributes: [
          [fn('SUM', col('spend')), 'spend'],
          [fn('SUM', col('clicks')), 'clicks'],
          [fn('SUM', col('impressions')), 'impressions'],
          [fn('MAX', col('date')), 'lastDate'],
        ],
        where,
        raw: true,
      }),
    ]);
    return { level, rows, total: totals?.[0] || {} };
  };

  let selectedInsights = await fetchInsightRows('campaign');
  for (const level of ['adset', 'ad']) {
    if (
      toNumber(selectedInsights.total?.spend) > 0 ||
      toNumber(selectedInsights.total?.clicks) > 0 ||
      toNumber(selectedInsights.total?.impressions) > 0
    ) {
      break;
    }
    const fallbackInsights = await fetchInsightRows(level);
    if (
      fallbackInsights.rows.length > 0 ||
      toNumber(fallbackInsights.total?.spend) > 0 ||
      toNumber(fallbackInsights.total?.clicks) > 0 ||
      toNumber(fallbackInsights.total?.impressions) > 0
    ) {
      selectedInsights = fallbackInsights;
      break;
    }
  }

  let campaignRows = selectedInsights.rows;
  let totalRow = selectedInsights.total;
  let selectedLevel = selectedInsights.level;

  const campaignNames = new Map();
  if (SocialAdsEntity && campaignRows.length) {
    const ids = campaignRows.map((row) => String(row.entity_id || '').trim()).filter(Boolean);
    const entities = await SocialAdsEntity.findAll({
      where: { level: selectedLevel, entity_id: { [Op.in]: ids } },
      raw: true,
    });
    entities.forEach((entity) => campaignNames.set(String(entity.entity_id), entity.name));
  }

  let actionLeadsByCampaignId = new Map();
  if (SocialAdsActionsDaily && campaignRows.length) {
    const ids = campaignRows.map((row) => String(row.entity_id || '').trim()).filter(Boolean);
    if (ids.length) {
      const actionRows = await SocialAdsActionsDaily.findAll({
        attributes: [
          'entity_id',
          [fn('SUM', literal(`CASE WHEN action_type IN ('lead','offsite_conversion.fb_pixel_lead','onsite_conversion.lead_form','leadgen.other','onsite_conversion.lead_grouped') THEN value ELSE 0 END`)), 'leads'],
        ],
        where: {
          ...scopeWhere,
          level: selectedLevel,
          entity_id: { [Op.in]: ids },
          ...buildComparablePaidDateWhere('date', range, paidCoverageStart),
        },
        group: ['entity_id'],
        raw: true,
      });
      actionLeadsByCampaignId = new Map(actionRows.map((row) => [String(row.entity_id), toNumber(row.leads)]));
    }
  }

  let usedAdsetFallback = false;
  const totalActionLeads = Array.from(actionLeadsByCampaignId.values()).reduce((acc, value) => acc + toNumber(value), 0);
  if (totalActionLeads > 0) {
    totalRow.conversions = totalActionLeads;
  }
  if (toNumber(totalRow.spend) === 0 && SocialAdsAdsetDailyAgg) {
    usedAdsetFallback = true;
    const fallbackWhere = {
      ...scopeWhere,
      ...buildComparablePaidDateWhere('date', range, paidCoverageStart),
    };
    const [fallbackTotal] = await SocialAdsAdsetDailyAgg.findAll({
      attributes: [
        [fn('SUM', col('spend')), 'spend'],
        [fn('SUM', col('clicks')), 'clicks'],
        [fn('SUM', col('leads')), 'leads'],
        [fn('MAX', col('date')), 'lastDate'],
      ],
      where: fallbackWhere,
      raw: true,
    });
    totalRow = {
      spend: fallbackTotal?.spend,
      clicks: fallbackTotal?.clicks,
      impressions: 0,
      conversions: fallbackTotal?.leads,
      lastDate: fallbackTotal?.lastDate,
    };
    campaignRows = await SocialAdsAdsetDailyAgg.findAll({
      attributes: [
        'adset_id',
        [fn('SUM', col('spend')), 'spend'],
        [fn('SUM', col('clicks')), 'clicks'],
        [fn('SUM', col('leads')), 'leads'],
      ],
      where: fallbackWhere,
      group: ['adset_id'],
      order: [[literal('SUM(spend)'), 'DESC']],
      limit: 5,
      raw: true,
    });
    selectedLevel = 'adset';
  }

  const effectiveAccounts = effectiveMetaAssets(marketingState).adAccounts;
  const assetWhere = buildAssetScopeWhere(scope);
  assetWhere.assetType = 'ad_account';
  const activeAccounts = marketingState
    ? effectiveAccounts.length
    : (ClinicMetaAsset ? await ClinicMetaAsset.count({ where: assetWhere }) : 0);

  const totals = {
    spend: money(totalRow?.spend),
    clicks: toNumber(totalRow?.clicks),
    impressions: toNumber(totalRow?.impressions),
    conversions: toNumber(totalRow?.conversions || totalRow?.leads),
  };

  const campaigns = campaignRows.map((row) => {
    const inversion = money(row.spend);
    const campaignActionLeads = usedAdsetFallback ? 0 : actionLeadsByCampaignId.get(String(row.entity_id));
    const leads = Math.round(toNumber(campaignActionLeads || row.conversions || row.leads));
    const id = usedAdsetFallback ? row.adset_id : row.entity_id;
    const fallbackLabel = selectedLevel === 'ad'
      ? 'Anuncio'
      : selectedLevel === 'adset'
        ? 'Conjunto'
        : 'Campaña';
    return {
      name: campaignNames.get(String(id)) || `${fallbackLabel} ${id || 'sin nombre'}`,
      platform: 'Meta Ads',
      inversion,
      leads,
      citas: 0,
      convertidos: 0,
      cpl: leads ? money(inversion / leads) : 0,
      cpaCita: 0,
      cpaConvertido: 0,
      alert: inversion >= 25 && leads === 0
        ? 'Esta campaña está gastando sin registrar leads. Revisa la creatividad, el destino o la atribución.'
        : undefined,
    };
  });

  return {
    totals,
    campaigns,
    connected: activeAccounts > 0,
    lastSync: totalRow?.lastDate || null,
  };
}

async function aggregateGa(scope, range, marketingState = null) {
  if (!WebGaDaily) return { sessions: 0, activeUsers: 0, newUsers: 0, connected: false, lastSync: null };
  const dataScope = buildHistoricalOrEffectiveWhere(
    scope,
    'clinica_id',
    'property_id',
    effectiveAnalyticsMappingIds(marketingState)
  );
  const where = {
    ...dataScope,
    ...buildDateOnlyWhere('date', range),
  };
  const [row] = await WebGaDaily.findAll({
    attributes: [
      [fn('SUM', col('sessions')), 'sessions'],
      [fn('SUM', col('active_users')), 'activeUsers'],
      [fn('SUM', col('new_users')), 'newUsers'],
      [fn('MAX', col('date')), 'lastDate'],
    ],
    where,
    raw: true,
  });
  return {
    sessions: toNumber(row?.sessions),
    activeUsers: toNumber(row?.activeUsers),
    newUsers: toNumber(row?.newUsers),
    connected: toNumber(row?.sessions) > 0 || toNumber(row?.activeUsers) > 0,
    lastSync: row?.lastDate || null,
  };
}

async function aggregateSeo(scope, range, marketingState = null) {
  const empty = {
    summary: { clicks: 0, impressions: 0, ctr: 0, avgPosition: 0 },
    queries: [],
    pages: [],
    connected: false,
    lastSync: null,
  };
  if (!WebScDaily || !WebScQueryDaily) return empty;

  const where = {
    ...buildSearchConsoleDataWhere(scope, marketingState),
    ...buildDateOnlyWhere('date', range),
  };

  const [summaryRow] = await WebScDaily.findAll({
    attributes: [
      [fn('SUM', col('clicks')), 'clicks'],
      [fn('SUM', col('impressions')), 'impressions'],
      [literal('CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE AVG(position) END'), 'position'],
      [fn('MAX', col('date')), 'lastDate'],
    ],
    where,
    raw: true,
  });

  const replacements = { start: range.startLabel, end: range.endLabel, limit: 8 };
  const seoScopeSql = searchConsoleRawScopeSql(scope, marketingState, replacements, 'seo');
  const queryRows = await sequelize.query(
    `SELECT query,
            SUM(clicks) AS clicks,
            SUM(impressions) AS impressions,
            CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE AVG(position) END AS position
       FROM WebScQueryDaily
      WHERE date BETWEEN :start AND :end ${seoScopeSql}
      GROUP BY query
      ORDER BY SUM(clicks) DESC
      LIMIT :limit`,
    { replacements, type: QueryTypes.SELECT }
  );

  const pageRows = await sequelize.query(
    `SELECT COALESCE(NULLIF(page_url, ''), 'Sin página') AS page,
            SUM(clicks) AS clicks,
            SUM(impressions) AS impressions,
            CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE AVG(position) END AS position
       FROM WebScQueryDaily
      WHERE date BETWEEN :start AND :end ${seoScopeSql}
      GROUP BY COALESCE(NULLIF(page_url, ''), 'Sin página')
      ORDER BY SUM(clicks) DESC
      LIMIT 5`,
    { replacements, type: QueryTypes.SELECT }
  );

  const clicks = toNumber(summaryRow?.clicks);
  const impressions = toNumber(summaryRow?.impressions);
  const summary = {
    clicks,
    impressions,
    ctr: ratioPct(clicks, impressions, 2),
    avgPosition: round(summaryRow?.position, 1),
  };

  return {
    summary,
    queries: queryRows.map((row) => ({
      query: row.query || 'Sin query',
      clicks: toNumber(row.clicks),
      impressions: toNumber(row.impressions),
      ctr: ratioPct(row.clicks, row.impressions, 2),
      position: round(row.position, 1),
    })),
    pages: pageRows.map((row) => ({
      page: row.page || 'Sin página',
      shortName: shortUrl(row.page || 'Sin página'),
      clicks: toNumber(row.clicks),
      impressions: toNumber(row.impressions),
      ctr: ratioPct(row.clicks, row.impressions, 2),
      position: round(row.position, 1),
    })),
    connected: clicks > 0 || impressions > 0,
    lastSync: summaryRow?.lastDate || null,
  };
}

async function aggregateSocialOrganic(scope, range, marketingState = null) {
  const empty = {
    summary: {
      reach: 0,
      impressions: 0,
      profileVisits: 0,
      followers: 0,
      followersDelta: 0,
      posts: 0,
    },
    platforms: [
      { platform: 'Facebook', connected: false, reach: 0, impressions: 0, profileVisits: 0, followers: 0, followersDelta: 0, posts: 0, lastSync: null },
      { platform: 'Instagram', connected: false, reach: 0, impressions: 0, profileVisits: 0, followers: 0, followersDelta: 0, posts: 0, lastSync: null },
    ],
    topPosts: [],
    connected: false,
    lastSync: null,
  };
  if (!SocialStatsDaily || !SocialPosts || !ClinicMetaAsset) return empty;

  const effectiveAssets = effectiveMetaAssets(marketingState);
  const assetWhere = buildAssetScopeWhere(scope);
  const [facebookMappings, instagramMappings] = marketingState
    ? [effectiveAssets.facebookPages.length, effectiveAssets.instagramAccounts.length]
    : await Promise.all([
      ClinicMetaAsset.count({ where: { ...assetWhere, assetType: 'facebook_page' } }),
      ClinicMetaAsset.count({ where: { ...assetWhere, assetType: 'instagram_business' } }),
    ]);
  const effectiveSocialAssetIds = effectiveSocialMappingIds(marketingState);
  const socialDataScope = buildHistoricalOrEffectiveWhere(
    scope,
    'clinica_id',
    'asset_id',
    effectiveSocialAssetIds
  );

  const statRows = await SocialStatsDaily.findAll({
    attributes: [
      'asset_type',
      'asset_id',
      [literal('SUM(COALESCE(reach_total, reach, 0))'), 'reach'],
      [fn('SUM', col('impressions')), 'impressions'],
      [fn('SUM', col('views')), 'views'],
      [fn('SUM', col('profile_visits')), 'profileVisits'],
      [fn('MAX', col('followers')), 'followers'],
      [fn('SUM', col('followers_day')), 'followersDelta'],
      [fn('MAX', col('date')), 'lastDate'],
    ],
    where: {
      ...socialDataScope,
      asset_type: { [Op.in]: ['facebook_page', 'instagram_business'] },
      ...buildDateOnlyWhere('date', range),
    },
    group: ['asset_type', 'asset_id'],
    raw: true,
  });

  const postRows = await SocialPosts.findAll({
    attributes: [
      'asset_type',
      [fn('COUNT', col('id')), 'posts'],
    ],
    where: {
      ...socialDataScope,
      asset_type: { [Op.in]: ['facebook_page', 'instagram_business'] },
      ...buildSequelizeDateWhere('published_at', range),
    },
    group: ['asset_type'],
    raw: true,
  });

  const postCounts = new Map(postRows.map((row) => [row.asset_type, toNumber(row.posts)]));
  const byPlatform = new Map([
    ['facebook_page', { platform: 'Facebook', connected: facebookMappings > 0, reach: 0, impressions: 0, profileVisits: 0, followers: 0, followersDelta: 0, posts: postCounts.get('facebook_page') || 0, lastSync: null }],
    ['instagram_business', { platform: 'Instagram', connected: instagramMappings > 0, reach: 0, impressions: 0, profileVisits: 0, followers: 0, followersDelta: 0, posts: postCounts.get('instagram_business') || 0, lastSync: null }],
  ]);

  for (const row of statRows) {
    const entry = byPlatform.get(row.asset_type);
    if (!entry) continue;
    entry.reach += toNumber(row.reach);
    const impressions = toNumber(row.impressions);
    const views = toNumber(row.views);
    entry.impressions += impressions || views;
    entry.profileVisits += toNumber(row.profileVisits);
    entry.followers += toNumber(row.followers);
    entry.followersDelta += toNumber(row.followersDelta);
    if (row.lastDate && (!entry.lastSync || String(row.lastDate) > String(entry.lastSync))) {
      entry.lastSync = row.lastDate;
    }
  }

  const replacements = {
    startDate: range.startLabel,
    endDate: range.endLabel,
    startTs: range.startSql,
    endTs: range.endExclusiveSql,
    limit: 5,
  };
  const postScopeSql = scopedRawOrEffectiveSql(
    'p.clinica_id',
    scope,
    replacements,
    'socialPostClinicIds',
    'p.asset_id',
    effectiveSocialAssetIds,
    'socialAssetIds'
  );
  const topPosts = await sequelize.query(
    `SELECT p.id,
            p.asset_type AS assetType,
            p.title,
            p.content,
            p.permalink_url AS permalinkUrl,
            p.media_url AS mediaUrl,
            p.published_at AS publishedAt,
            COALESCE(SUM(s.reach), 0) AS reach,
            COALESCE(SUM(s.impressions), 0) AS impressions,
            COALESCE(SUM(s.engagement), 0) AS engagement
       FROM SocialPosts p
       LEFT JOIN SocialPostStatsDaily s
              ON s.post_id = p.id
             AND s.date BETWEEN :startDate AND :endDate
      WHERE p.asset_type IN ('facebook_page', 'instagram_business')
        AND p.published_at >= :startTs
        AND p.published_at < :endTs
        ${postScopeSql}
      GROUP BY p.id, p.asset_type, p.title, p.content, p.permalink_url, p.media_url, p.published_at
      ORDER BY COALESCE(SUM(s.reach), 0) DESC, p.published_at DESC
      LIMIT :limit`,
    { replacements, type: QueryTypes.SELECT }
  );

  const platforms = Array.from(byPlatform.values());
  const summary = platforms.reduce((acc, row) => {
    acc.reach += toNumber(row.reach);
    acc.impressions += toNumber(row.impressions);
    acc.profileVisits += toNumber(row.profileVisits);
    acc.followers += toNumber(row.followers);
    acc.followersDelta += toNumber(row.followersDelta);
    acc.posts += toNumber(row.posts);
    return acc;
  }, { reach: 0, impressions: 0, profileVisits: 0, followers: 0, followersDelta: 0, posts: 0 });

  const lastSync = platforms
    .map((row) => row.lastSync)
    .filter(Boolean)
    .sort()
    .pop() || null;

  return {
    summary,
    platforms,
    topPosts: topPosts.map((row) => ({
      platform: socialPlatformLabel(row.assetType),
      title: truncateText(row.title || row.content),
      publishedAt: row.publishedAt || null,
      reach: toNumber(row.reach),
      impressions: toNumber(row.impressions),
      engagement: toNumber(row.engagement),
      permalinkUrl: row.permalinkUrl || null,
      mediaUrl: row.mediaUrl || null,
    })),
    connected: facebookMappings > 0 || instagramMappings > 0,
    lastSync,
  };
}

async function aggregateWebPages(scope, range, seoPages = []) {
  const replacements = {
    startTs: range.startSql,
    endTs: range.endExclusiveSql,
    startDate: range.startLabel,
    endDate: range.endLabel,
    limit: 5,
  };
  const leadClinicSql = scopedRawSql('clinica_id', scope, replacements, 'leadPageClinicIds');
  const formClinicSql = scopedRawSql('clinic_id', scope, replacements, 'formPageClinicIds');
  const whatsappClinicSql = scopedRawSql('clinic_id', scope, replacements, 'waPageClinicIds');
  const webPageClinicSql = WebPageDaily ? scopedRawSql('clinic_id', scope, replacements, 'webPageClinicIds') : '';

  const rows = await sequelize.query(
    `SELECT url,
            SUM(visits) AS visits,
            SUM(leads) AS leads,
            SUM(clicks_tel) AS clicksTel,
            SUM(clicks_wa) AS clicksWa,
            SUM(whatsapp_confirmados) AS whatsappConfirmados,
            SUM(formularios) AS formularios
       FROM (
             ${WebPageDaily ? `
             SELECT COALESCE(NULLIF(page_url, ''), 'Sin página') AS url,
                    SUM(pageviews) AS visits,
                    0 AS leads,
                    SUM(tel_clicks) AS clicks_tel,
                    SUM(whatsapp_clicks) AS clicks_wa,
                    0 AS whatsapp_confirmados,
                    SUM(form_submits) AS formularios
               FROM WebPageDaily
              WHERE date >= :startDate AND date <= :endDate ${webPageClinicSql}
              GROUP BY COALESCE(NULLIF(page_url, ''), 'Sin página')
             UNION ALL` : ''}
             SELECT COALESCE(NULLIF(page_url, ''), NULLIF(landing_url, ''), 'Sin página') AS url,
                    0 AS visits,
                    COUNT(*) AS leads,
                    SUM(CASE WHEN source = 'call_click' THEN 1 ELSE 0 END) AS clicks_tel,
                    0 AS clicks_wa,
                    0 AS whatsapp_confirmados,
                    0 AS formularios
               FROM LeadIntakes
              WHERE archived_at IS NULL
                AND created_at >= :startTs AND created_at < :endTs ${leadClinicSql}
              GROUP BY COALESCE(NULLIF(page_url, ''), NULLIF(landing_url, ''), 'Sin página')
             UNION ALL
             SELECT COALESCE(NULLIF(page_url, ''), 'Sin página') AS url,
                    0 AS visits,
                    0 AS leads,
                    0 AS clicks_tel,
                    0 AS clicks_wa,
                    0 AS whatsapp_confirmados,
                    COUNT(*) AS formularios
               FROM FormSubmissionEvents
              WHERE submitted_at >= :startTs AND submitted_at < :endTs ${formClinicSql}
              GROUP BY COALESCE(NULLIF(page_url, ''), 'Sin página')
             UNION ALL
             SELECT COALESCE(NULLIF(page_url, ''), 'Sin página') AS url,
                    0 AS visits,
                    0 AS leads,
                    0 AS clicks_tel,
                    COUNT(*) AS clicks_wa,
                    SUM(CASE WHEN used_at IS NOT NULL OR used_conversation_id IS NOT NULL OR used_message_id IS NOT NULL THEN 1 ELSE 0 END) AS whatsapp_confirmados,
                    0 AS formularios
               FROM WhatsAppWebOrigins
              WHERE createdAt >= :startTs AND createdAt < :endTs ${whatsappClinicSql}
              GROUP BY COALESCE(NULLIF(page_url, ''), 'Sin página')
       ) x
      GROUP BY url
      ORDER BY SUM(leads) DESC, SUM(formularios) DESC
      LIMIT :limit`,
    { replacements, type: QueryTypes.SELECT }
  );

  const seoClicksByPath = new Map();
  for (const page of seoPages || []) {
    seoClicksByPath.set(normalizeUrlKey(page.page), toNumber(page.clicks));
  }

  return rows.map((row) => {
    const leads = toNumber(row.leads);
    const formularios = toNumber(row.formularios);
    const clicksTel = toNumber(row.clicksTel);
    const clicksWa = toNumber(row.clicksWa);
    const visits = Math.max(toNumber(row.visits), toNumber(seoClicksByPath.get(normalizeUrlKey(row.url))), leads + formularios + clicksTel + clicksWa);
    return {
      url: row.url || 'Sin página',
      shortName: shortUrl(row.url || 'Sin página'),
      visitas: visits,
      leads,
      conversionRate: ratioPct(leads, visits, 2),
      clicksTel,
      clicksWa,
      whatsappConfirmados: toNumber(row.whatsappConfirmados),
      formularios,
    };
  });
}

async function aggregateBusinessProfile(scope, range, marketingState = null) {
  const empty = {
    metrics: {
      views: 0,
      calls: 0,
      directions: 0,
      websiteClicks: 0,
      newReviews: 0,
      averageRating: 0,
      totalReviews: 0,
      performanceStatus: 'empty',
      latestPerformanceDate: null,
    },
    connected: false,
    lastSync: null,
    unansweredReviews: 0,
  };
  if (!ClinicBusinessLocation || !BusinessProfileDailyMetric || !BusinessProfileReview) return empty;

  const effectiveLocationIds = effectiveBusinessLocationIds(marketingState);
  const locationWhere = {
    ...buildEffectiveSnapshotWhere(scope, 'clinica_id', 'id', effectiveLocationIds),
    is_active: true,
  };
  const latestLocation = await ClinicBusinessLocation.findOne({ where: locationWhere, order: [['last_synced_at', 'DESC']], raw: true });
  const locations = await ClinicBusinessLocation.count({ where: locationWhere });

  const metricWhere = {
    ...buildHistoricalOrEffectiveWhere(
      scope,
      'clinica_id',
      'business_location_id',
      effectiveLocationIds
    ),
    ...buildDateOnlyWhere('date', range),
  };
  const rows = await BusinessProfileDailyMetric.findAll({ where: metricWhere, raw: true });
  const reportableMetricRows = collapseBusinessProfileMetricRows(rows);
  const rawMetricDates = new Set(rows.map((row) => String(row.date || '')).filter(Boolean));
  const reportableMetricDates = new Set(reportableMetricRows.map((row) => String(row.date || '')).filter(Boolean));
  const hasProvisionalMetricDates = [...rawMetricDates].some((date) => !reportableMetricDates.has(date));
  const latestPerformanceDate = [...reportableMetricDates].sort().at(-1) || null;
  const performanceStatus = reportableMetricRows.length
    ? (hasProvisionalMetricDates ? 'partial' : 'available')
    : (hasProvisionalMetricDates ? 'pending' : 'empty');
  const sumDefinition = (definition) => businessProfileMetricValueByDate(rows, definition)
    .reduce((sum, point) => sum + toNumber(point.value), 0);

  const reviewWhere = buildEffectiveSnapshotWhere(
    scope,
    'clinica_id',
    'business_location_id',
    effectiveLocationIds
  );
  const [reviewTotals, newReviews] = await Promise.all([
    BusinessProfileReview.findOne({
      where: reviewWhere,
      attributes: [
        [fn('COUNT', col('id')), 'totalReviews'],
        [fn('AVG', col('star_rating')), 'averageRating'],
        [literal('SUM(CASE WHEN has_reply = 0 THEN 1 ELSE 0 END)'), 'unansweredReviews'],
      ],
      raw: true,
    }),
    BusinessProfileReview.count({
      where: {
        ...reviewWhere,
        create_time: { [Op.gte]: range.start, [Op.lt]: range.endExclusive },
      },
    }),
  ]);
  const totalReviews = toNumber(reviewTotals?.totalReviews);
  const averageRating = round(reviewTotals?.averageRating, 1);
  const unansweredReviews = toNumber(reviewTotals?.unansweredReviews);

  const metrics = {
    views: sumDefinition(BUSINESS_PROFILE_LOCAL_METRIC_DEFINITIONS.profile_views),
    calls: sumDefinition(BUSINESS_PROFILE_LOCAL_METRIC_DEFINITIONS.call_clicks),
    directions: sumDefinition(BUSINESS_PROFILE_LOCAL_METRIC_DEFINITIONS.direction_clicks),
    websiteClicks: sumDefinition(BUSINESS_PROFILE_LOCAL_METRIC_DEFINITIONS.website_clicks),
    newReviews,
    averageRating,
    totalReviews,
    performanceStatus,
    latestPerformanceDate,
  };

  return {
    metrics,
    connected: locations > 0,
    lastSync: latestLocation?.last_synced_at || null,
    unansweredReviews,
  };
}

function normalizeUrlKey(value) {
  if (!value) return '';
  try {
    const url = new URL(String(value));
    return `${url.hostname}${url.pathname}`.replace(/\/$/, '').toLowerCase();
  } catch (_err) {
    return String(value).replace(/\/$/, '').toLowerCase();
  }
}

function shortUrl(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === 'Sin página') return 'Sin página';
  try {
    const url = new URL(raw);
    const path = url.pathname && url.pathname !== '/' ? url.pathname : '/';
    return path === '/' ? 'Página principal' : path.replace(/^\//, '').replace(/[-_]/g, ' ').slice(0, 48);
  } catch (_err) {
    const clean = raw.replace(/^https?:\/\/[^/]+/i, '').replace(/^\//, '');
    return clean ? clean.replace(/[-_]/g, ' ').slice(0, 48) : 'Página principal';
  }
}

function buildChannels(leadChannels, spendByKey) {
  const order = ['google_ads', 'meta_ads', 'seo', 'web', 'direct', 'whatsapp', 'social_organic', 'call_click', 'local_services'];
  const keys = Array.from(new Set([...order, ...leadChannels.keys()]))
    .filter((key) => leadChannels.has(key) || toNumber(spendByKey[key]) > 0);

  return keys.map((key) => {
    const stats = leadChannels.get(key) || emptyChannelStats();
    const spend = money(spendByKey[key] || 0);
    const label = channelLabel(key);
    return {
      name: label.name,
      icon: label.icon,
      leads: stats.leads,
      citas: stats.citas,
      acudieron: stats.acudieron,
      inversion: spend,
      cpl: stats.leads ? money(spend / stats.leads) : 0,
      cpaCita: stats.citas ? money(spend / stats.citas) : 0,
      source: label.source,
      helpText: label.helpText || null,
    };
  });
}

function distributeCampaignAppointments(campaigns, platformChannelStats) {
  const totalLeads = campaigns.reduce((acc, row) => acc + toNumber(row.leads), 0);
  const citaRate = totalLeads && platformChannelStats?.leads
    ? toNumber(platformChannelStats.citas) / toNumber(platformChannelStats.leads)
    : 0;
  const convertidoRate = totalLeads && platformChannelStats?.leads
    ? toNumber(platformChannelStats.convertidos) / toNumber(platformChannelStats.leads)
    : 0;
  return campaigns.map((row) => {
    const citas = Math.round(toNumber(row.leads) * citaRate);
    const convertidos = Math.round(toNumber(row.leads) * convertidoRate);
    return {
      ...row,
      citas,
      convertidos,
      cpaCita: citas ? money(row.inversion / citas) : 0,
      cpaConvertido: convertidos ? money(row.inversion / convertidos) : 0,
    };
  });
}

function buildSources({ intakeConfigCount, leadsTotal, seo, googleAds, metaAds, ga, businessProfile, social, firstParty, mappingCounts = {} }) {
  const clinicaClickConnected = intakeConfigCount > 0 || leadsTotal > 0 || !!firstParty?.connected;
  const searchConsoleMapped = toNumber(mappingCounts.search_console) > 0;
  const analyticsMapped = toNumber(mappingCounts.analytics) > 0;
  const businessProfileMapped = toNumber(mappingCounts.business_profile) > 0;
  const googleAdsMapped = toNumber(mappingCounts.google_ads) > 0;
  const metaAdsMapped = toNumber(mappingCounts.meta_ads) > 0;
  const facebookMapped = toNumber(mappingCounts.facebook) > 0;
  const instagramMapped = toNumber(mappingCounts.instagram) > 0;
  const socialPlatformSync = new Map((social?.platforms || []).map((row) => [row.platform, row.lastSync]));
  return [
    {
      name: 'ClinicaClick Analytics',
      icon: 'heroicons_outline:chart-bar-square',
      connected: clinicaClickConnected,
      label: clinicaClickConnected ? 'Activo' : 'Pendiente',
      tooltip: firstParty?.connected
        ? 'ClinicaClick Analytics está capturando visitas y acciones propias con WebEvents.'
        : clinicaClickConnected
        ? 'Hay configuración de medición o leads capturados por ClinicaClick.'
        : 'Aún no hay configuración o datos capturados por el snippet de ClinicaClick.',
      lastSync: firstParty?.lastDate || (leadsTotal > 0 ? 'Tiempo real' : undefined),
      source: 'ClinicaClick',
    },
    {
      name: 'Search Console',
      icon: 'brand:google',
      connected: searchConsoleMapped,
      label: searchConsoleMapped ? 'Conectado' : 'Sin datos',
      tooltip: 'Search Console mide cómo te encuentra la gente en Google.',
      lastSync: relativeSyncLabel(seo.lastSync),
      source: 'Search Console',
    },
    {
      name: 'Google Ads',
      icon: 'brand:google-ads',
      connected: googleAdsMapped,
      label: googleAdsMapped ? 'Conectado' : 'Pendiente',
      tooltip: 'Datos de campañas de Google Ads sincronizados.',
      lastSync: relativeSyncLabel(googleAds.lastSync),
      source: 'Google Ads',
    },
    {
      name: 'Meta Ads',
      icon: 'brand:meta',
      connected: metaAdsMapped,
      label: metaAdsMapped ? 'Conectado' : 'Pendiente',
      tooltip: 'Datos de campañas de Facebook e Instagram sincronizados.',
      lastSync: relativeSyncLabel(metaAds.lastSync),
      source: 'Meta Ads',
    },
    {
      name: 'Facebook',
      icon: 'brand:facebook',
      connected: facebookMapped,
      label: facebookMapped ? 'Conectado' : 'Pendiente',
      tooltip: 'Publicaciones, alcance, seguidores y visitas orgánicas de tu página de Facebook.',
      lastSync: relativeSyncLabel(socialPlatformSync.get('Facebook')),
      source: 'Facebook',
    },
    {
      name: 'Instagram',
      icon: 'brand:instagram',
      connected: instagramMapped,
      label: instagramMapped ? 'Conectado' : 'Pendiente',
      tooltip: 'Publicaciones, alcance, seguidores y visitas orgánicas de tu cuenta de Instagram.',
      lastSync: relativeSyncLabel(socialPlatformSync.get('Instagram')),
      source: 'Instagram',
    },
    {
      name: 'Perfil de Empresa Google',
      icon: 'brand:google-business-profile',
      connected: businessProfileMapped,
      label: businessProfileMapped ? 'Conectado' : 'Pendiente',
      tooltip: 'Conecta tu Perfil de Empresa de Google para ver llamadas, reseñas y visitas a tu ficha.',
      lastSync: relativeSyncLabel(businessProfile.lastSync),
      source: 'Perfil Google',
    },
    {
      name: 'Google Analytics 4',
      icon: 'brand:google-analytics',
      connected: analyticsMapped,
      label: analyticsMapped ? 'Conectado' : 'Opcional',
      tooltip: 'GA4 es opcional. ClinicaClick Analytics debe ser la fuente principal nueva.',
      lastSync: relativeSyncLabel(ga.lastSync),
      source: 'GA4 opcional',
    },
  ];
}

const SYNC_ACTIVE_STATUSES = ['pending', 'queued', 'running', 'waiting'];
const SYNC_RECENT_STATUSES = [...SYNC_ACTIVE_STATUSES, 'completed', 'failed'];
const SOURCE_SYNC_CONFIG = {
  search_console: {
    source: 'Search Console',
    label: 'Search Console',
    jobTypes: ['web_backfill_for_sites', 'web_backfill', 'web_recent'],
  },
  analytics: {
    source: 'GA4 opcional',
    label: 'Google Analytics',
    jobTypes: ['analytics_backfill', 'analytics_backfill_properties', 'analytics_recent'],
  },
  business_profile: {
    source: 'Perfil Google',
    label: 'Perfil de Empresa Google',
    jobTypes: ['business_profile_backfill_locations', 'business_profile_backfill', 'business_profile_recent'],
  },
  google_ads: {
    source: 'Google Ads',
    label: 'Google Ads',
    jobTypes: ['google_ads_recent', 'google_ads_backfill'],
  },
  meta_ads: {
    source: 'Meta Ads',
    label: 'Meta Ads',
    jobTypes: ['meta_ads_recent', 'meta_ads_backfill', 'meta_ads_backfill_for_sites'],
  },
};

function normalizeSourceSyncErrorMessage(label, detail) {
  const message = String(detail || '').trim();
  if (!message) {
    return `${label} tiene una sincronización con error. Revisa la conexión o vuelve a lanzar el mapeo.`;
  }

  const lower = message.toLowerCase();
  if (lower.includes('google my business api') && lower.includes('disabled')) {
    const projectMatch = message.match(/project\s+(\d+)/i);
    const project = projectMatch?.[1] || null;
    const projectText = project ? ` en el proyecto Google ${project}` : '';
    return `${label} no puede recuperar reseñas ni publicaciones porque Google está rechazando Google My Business API (mybusiness.googleapis.com) como no habilitada${projectText}. Revisa ese servicio exacto en Google Cloud, espera unos minutos si acabas de activarlo y vuelve a lanzar el resync.`;
  }

  if (lower.includes('sin accountname')) {
    return `${label} no puede sincronizar reseñas/publicaciones porque la ficha no conserva el accountName de Google. Vuelve a mapear el Perfil de Empresa.`;
  }

  return `${label} tiene una sincronización con error: ${message}`;
}

function sourceSyncMessage(label, state, detail = null) {
  if (state === 'error') {
    return normalizeSourceSyncErrorMessage(label, detail);
  }
  return `Estamos recabando datos de ${label}. Los resultados pueden tardar unos minutos en aparecer.`;
}

function extractJobSyncError(job) {
  if (!job) return null;
  if (job.error_message) return job.error_message;

  const summary = job.result_summary || {};
  const candidates = [
    summary?.error,
    summary?.message,
    summary?.report?.error,
    summary?.report?.message,
    summary?.report?.errors?.[0]?.message,
    summary?.errors?.[0]?.message,
  ];

  return candidates.find((value) => typeof value === 'string' && value.trim()) || null;
}

function normalizePayloadArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  return [value];
}

function collectClinicIdsFromPayload(value, out = new Set()) {
  if (!value || typeof value !== 'object') return out;
  if (Array.isArray(value)) {
    value.forEach((item) => collectClinicIdsFromPayload(item, out));
    return out;
  }

  normalizePayloadArray(value.clinicIds).forEach((id) => {
    const parsed = Number(id);
    if (Number.isInteger(parsed)) out.add(parsed);
  });
  normalizePayloadArray(value.clinicaIds).forEach((id) => {
    const parsed = Number(id);
    if (Number.isInteger(parsed)) out.add(parsed);
  });

  const single = Number(value.clinicId || value.clinicaId);
  if (Number.isInteger(single)) out.add(single);

  ['mappings', 'siteMappings', 'sites', 'locations', 'properties', 'accounts'].forEach((key) => {
    if (Array.isArray(value[key])) {
      value[key].forEach((item) => collectClinicIdsFromPayload(item, out));
    }
  });

  return out;
}

function jobMatchesScope(job, scope) {
  const clinicIds = Array.isArray(scope?.clinicIds) ? scope.clinicIds.map(Number).filter(Number.isInteger) : [];
  if (!clinicIds.length || scope?.isAll) return true;
  const payloadClinicIds = Array.from(collectClinicIdsFromPayload(job?.payload));
  if (!payloadClinicIds.length) return false;
  return payloadClinicIds.some((id) => clinicIds.includes(id));
}

async function recentJobsForSource(config, scope) {
  if (!JobRequest || !Array.isArray(config?.jobTypes) || !config.jobTypes.length) {
    return [];
  }
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const rows = await JobRequest.findAll({
    where: {
      type: { [Op.in]: config.jobTypes },
      status: { [Op.in]: SYNC_RECENT_STATUSES },
      created_at: { [Op.gte]: since },
    },
    order: [['updated_at', 'DESC'], ['created_at', 'DESC'], ['id', 'DESC']],
    limit: 100,
    raw: true,
  });
  return rows.filter((row) => jobMatchesScope(row, scope));
}

function buildSourceSyncState({ config, mapped, lastSync, jobs = [], pendingRecords = 0, errorRecords = 0 }) {
  if (!mapped) return null;
  const activeJob = jobs.find((job) => SYNC_ACTIVE_STATUSES.includes(job.status));

  if (activeJob) {
    return {
      source: config.source,
      label: config.label,
      state: 'syncing',
      active: true,
      message: sourceSyncMessage(config.label, 'syncing'),
      jobId: activeJob?.id || null,
      updatedAt: activeJob?.updated_at || activeJob?.created_at || null,
    };
  }

  const terminalJob = jobs.find((job) => ['failed', 'completed'].includes(job.status));
  if (errorRecords > 0 || terminalJob?.status === 'failed') {
    const errorJob = terminalJob?.status === 'failed' ? terminalJob : jobs.find((job) => extractJobSyncError(job));
    return {
      source: config.source,
      label: config.label,
      state: 'error',
      active: true,
      message: sourceSyncMessage(config.label, 'error', extractJobSyncError(errorJob)),
      jobId: errorJob?.id || null,
      updatedAt: errorJob?.updated_at || errorJob?.created_at || null,
    };
  }

  if (terminalJob?.status === 'completed') {
    return {
      source: config.source,
      label: config.label,
      state: 'completed',
      active: false,
      message: `${config.label} sincronizado.`,
      jobId: terminalJob?.id || null,
      updatedAt: lastSync || terminalJob?.completed_at || terminalJob?.updated_at || terminalJob?.created_at || null,
    };
  }

  if (pendingRecords > 0 || !lastSync) {
    return {
      source: config.source,
      label: config.label,
      state: 'syncing',
      active: true,
      message: sourceSyncMessage(config.label, 'syncing'),
      jobId: null,
      updatedAt: null,
    };
  }

  return {
    source: config.source,
    label: config.label,
    state: 'completed',
    active: false,
    message: `${config.label} sincronizado.`,
    updatedAt: lastSync || null,
  };
}

async function buildSyncStatus(scope, { seo, googleAds, metaAds, ga, businessProfile }, marketingState = null) {
  const scopedGoogleAccounts = effectiveGoogleAccounts(marketingState);
  const scopedGoogleProperties = effectiveGoogleProperties(marketingState);
  const scopedMetaAssets = effectiveMetaAssets(marketingState);
  const searchConsoleJobScope = scopeWithEffectiveAssetOwners(scope, scopedGoogleProperties.searchConsole);
  const analyticsJobScope = scopeWithEffectiveAssetOwners(scope, scopedGoogleProperties.analytics);
  const businessProfileJobScope = scopeWithEffectiveAssetOwners(scope, scopedGoogleProperties.businessProfiles);
  const googleAdsJobScope = scopeWithEffectiveAssetOwners(scope, scopedGoogleAccounts);
  const metaAdsJobScope = scopeWithEffectiveAssetOwners(scope, scopedMetaAssets.adAccounts);
  const [
    searchConsoleMappings,
    analyticsMappings,
    businessLocations,
    googleAdsMappings,
    metaAdsMappings,
    facebookMappings,
    instagramMappings,
    searchConsoleJobs,
    analyticsJobs,
    businessProfileJobs,
    googleAdsJobs,
    metaAdsJobs,
  ] = await Promise.all([
    marketingState
      ? scopedGoogleProperties.searchConsole.length
      : (ClinicWebAsset ? ClinicWebAsset.count({ where: { ...scopedWhere('clinicaId', scope), isActive: true } }) : 0),
    marketingState
      ? scopedGoogleProperties.analytics.length
      : (ClinicAnalyticsProperty ? ClinicAnalyticsProperty.count({ where: { ...scopedWhere('clinicaId', scope), isActive: true } }) : 0),
    marketingState
      ? scopedGoogleProperties.businessProfiles
      : (ClinicBusinessLocation ? ClinicBusinessLocation.findAll({ where: { ...scopedWhere('clinica_id', scope), is_active: true }, raw: true }) : []),
    marketingState
      ? scopedGoogleAccounts.length
      : (ClinicGoogleAdsAccount ? ClinicGoogleAdsAccount.count({ where: { ...buildAdsScopeWhere(scope, 'clinicaId', 'grupoClinicaId'), isActive: true } }) : 0),
    marketingState
      ? scopedMetaAssets.adAccounts.length
      : (ClinicMetaAsset ? ClinicMetaAsset.count({ where: { ...buildAssetScopeWhere(scope), assetType: 'ad_account' } }) : 0),
    marketingState
      ? scopedMetaAssets.facebookPages.length
      : (ClinicMetaAsset ? ClinicMetaAsset.count({ where: { ...buildAssetScopeWhere(scope), assetType: 'facebook_page' } }) : 0),
    marketingState
      ? scopedMetaAssets.instagramAccounts.length
      : (ClinicMetaAsset ? ClinicMetaAsset.count({ where: { ...buildAssetScopeWhere(scope), assetType: 'instagram_business' } }) : 0),
    recentJobsForSource(SOURCE_SYNC_CONFIG.search_console, searchConsoleJobScope),
    recentJobsForSource(SOURCE_SYNC_CONFIG.analytics, analyticsJobScope),
    recentJobsForSource(SOURCE_SYNC_CONFIG.business_profile, businessProfileJobScope),
    recentJobsForSource(SOURCE_SYNC_CONFIG.google_ads, googleAdsJobScope),
    recentJobsForSource(SOURCE_SYNC_CONFIG.meta_ads, metaAdsJobScope),
  ]);

  const businessPending = businessLocations.filter((row) => row.sync_status === 'pending' || !row.last_synced_at).length;
  const businessErrors = businessLocations.filter((row) => row.sync_status === 'error').length;
  const mappingCounts = {
    search_console: searchConsoleMappings,
    analytics: analyticsMappings,
    business_profile: businessLocations.length,
    google_ads: googleAdsMappings,
    meta_ads: metaAdsMappings,
    facebook: facebookMappings,
    instagram: instagramMappings,
  };

  const states = [
    buildSourceSyncState({
      config: SOURCE_SYNC_CONFIG.search_console,
      mapped: searchConsoleMappings > 0,
      lastSync: seo.lastSync,
      jobs: searchConsoleJobs,
    }),
    buildSourceSyncState({
      config: SOURCE_SYNC_CONFIG.analytics,
      mapped: analyticsMappings > 0,
      lastSync: ga.lastSync,
      jobs: analyticsJobs,
    }),
    buildSourceSyncState({
      config: SOURCE_SYNC_CONFIG.business_profile,
      mapped: businessLocations.length > 0,
      lastSync: businessProfile.lastSync,
      jobs: businessProfileJobs,
      pendingRecords: businessPending,
      errorRecords: businessErrors,
    }),
    buildSourceSyncState({
      config: SOURCE_SYNC_CONFIG.google_ads,
      mapped: googleAdsMappings > 0,
      lastSync: googleAds.lastSync,
      jobs: googleAdsJobs,
    }),
    buildSourceSyncState({
      config: SOURCE_SYNC_CONFIG.meta_ads,
      mapped: metaAdsMappings > 0,
      lastSync: metaAds.lastSync,
      jobs: metaAdsJobs,
    }),
  ].filter(Boolean);

  const activeSources = states.filter((state) => state.active);
  const errorSources = activeSources.filter((state) => state.state === 'error');
  return {
    active: activeSources.length > 0,
    sources: activeSources,
    allSources: states,
    mappingCounts,
    message: activeSources.length
      ? (errorSources.length
        ? errorSources.map((source) => source.message).join(' ')
        : `Estamos recabando datos de ${activeSources.map((source) => source.label).join(', ')}. Los resultados pueden tardar unos minutos en aparecer.`)
      : null,
  };
}

function buildKpis(current, previous, series = {}) {
  const { leads, citas, acudieron, convertidos, spend } = current;
  const paidLeads = toNumber(current.paidLeads);
  const previousPaidLeads = toNumber(previous.paidLeads);
  const cpl = paidLeads ? spend / paidLeads : 0;
  const cpaCita = citas ? spend / citas : 0;
  const cpaAcudio = acudieron ? spend / acudieron : 0;
  const cpaConvertido = convertidos ? spend / convertidos : 0;
  const leadSeries = Array.isArray(series.leads) ? series.leads : [];
  const paidLeadSeries = Array.isArray(series.paidLeads) ? series.paidLeads : [];
  const citaSeries = Array.isArray(series.citas) ? series.citas : [];
  const acudioSeries = Array.isArray(series.acudieron) ? series.acudieron : [];
  const convertidoSeries = Array.isArray(series.convertidos) ? series.convertidos : [];
  const spendSeries = Array.isArray(series.spend) ? series.spend : [];
  const ratioSeries = leadSeries.map((value, index) => ratioPct(citaSeries[index] || 0, value, 1));
  const cplSeries = paidLeadSeries.map((value, index) => value ? money((spendSeries[index] || 0) / value) : 0);
  const cpaCitaSeries = citaSeries.map((value, index) => value ? money((spendSeries[index] || 0) / value) : 0);
  const cpaAcudioSeries = acudioSeries.map((value, index) => value ? money((spendSeries[index] || 0) / value) : 0);
  const cpaConvertidoSeries = convertidoSeries.map((value, index) => value ? money((spendSeries[index] || 0) / value) : 0);

  return [
    {
      id: 'leads',
      label: 'Leads reales recibidos',
      value: leads,
      sparkline: compactNumericSeries(leadSeries),
      helpText: 'Personas que dejaron sus datos a través de tu web, WhatsApp, llamada o campañas.',
      trend: pct(leads, previous.leads),
      trendLabel: 'vs. periodo anterior',
      source: 'ClinicaClick',
    },
    {
      id: 'citas',
      label: 'Citas creadas desde esos leads',
      value: citas,
      sparkline: compactNumericSeries(citaSeries),
      helpText: 'Leads que acabaron con una cita agendada en tu clínica.',
      trend: pct(citas, previous.citas),
      trendLabel: 'vs. periodo anterior',
      source: 'ClinicaClick',
    },
    {
      id: 'acudieron',
      label: 'Pacientes que acudieron',
      value: acudieron,
      sparkline: compactNumericSeries(acudioSeries),
      helpText: 'De las citas creadas desde leads, cuántos pacientes vinieron realmente.',
      trend: pct(acudieron, previous.acudieron),
      trendLabel: 'vs. periodo anterior',
      source: 'ClinicaClick',
    },
    {
      id: 'convertidos',
      label: 'Pacientes que realizan tratamiento',
      value: convertidos,
      sparkline: compactNumericSeries(convertidoSeries),
      helpText: 'Pacientes marcados como convertidos tras acudir y avanzar a tratamiento. En V1 se alimenta desde LeadIntake.status_lead=convertido.',
      trend: pct(convertidos, previous.convertidos),
      trendLabel: 'vs. periodo anterior',
      source: 'ClinicaClick',
    },
    {
      id: 'ratio-lead-cita',
      label: 'Ratio de conversión lead -> cita',
      value: ratioPct(citas, leads, 0),
      suffix: '%',
      sparkline: compactNumericSeries(ratioSeries),
      helpText: 'De cada 100 leads, cuántos acaban con cita.',
      trend: pct(ratioPct(citas, leads, 2), ratioPct(previous.citas, previous.leads, 2)),
      trendLabel: 'vs. periodo anterior',
      source: 'ClinicaClick',
    },
    {
      id: 'inversion',
      label: 'Inversión total en publicidad',
      value: money(spend),
      prefix: '€',
      sparkline: compactNumericSeries(spendSeries),
      helpText: 'Gasto sincronizado de Google Ads y Meta Ads en el periodo.',
      trend: pct(spend, previous.spend),
      trendLabel: 'vs. periodo anterior',
      source: 'Google Ads',
    },
    {
      id: 'cpl',
      label: 'Coste medio por lead',
      value: money(cpl),
      prefix: '€',
      sparkline: compactNumericSeries(cplSeries),
      helpText: 'Inversión publicitaria dividida entre los leads atribuidos a Google Ads o Meta Ads dentro de la misma ventana comparable.',
      trend: pct(cpl, previousPaidLeads ? previous.spend / previousPaidLeads : 0),
      trendLabel: 'vs. periodo anterior',
      source: 'ClinicaClick',
    },
    {
      id: 'cpa-cita',
      label: 'Coste medio por cita',
      value: money(cpaCita),
      prefix: '€',
      sparkline: compactNumericSeries(cpaCitaSeries),
      helpText: 'Cuánto cuesta que un lead acabe con cita agendada.',
      trend: pct(cpaCita, previous.citas ? previous.spend / previous.citas : 0),
      trendLabel: 'vs. periodo anterior',
      source: 'ClinicaClick',
    },
    {
      id: 'cpa-acudio',
      label: 'Coste por paciente que acudió',
      value: money(cpaAcudio),
      prefix: '€',
      sparkline: compactNumericSeries(cpaAcudioSeries),
      helpText: 'Cuánto cuesta que un paciente venga realmente a consulta.',
      trend: pct(cpaAcudio, previous.acudieron ? previous.spend / previous.acudieron : 0),
      trendLabel: 'vs. periodo anterior',
      source: 'ClinicaClick',
    },
    {
      id: 'cpa-convertido',
      label: 'Coste por paciente con tratamiento',
      value: money(cpaConvertido),
      prefix: '€',
      sparkline: compactNumericSeries(cpaConvertidoSeries),
      helpText: 'Cuánto cuesta captar un paciente que acaba realizando tratamiento.',
      trend: pct(cpaConvertido, previous.convertidos ? previous.spend / previous.convertidos : 0),
      trendLabel: 'vs. periodo anterior',
      source: 'ClinicaClick',
    },
  ];
}

function buildRecommendations({ businessProfile, adsCampaigns, webPages, intakeConfigCount }) {
  const recs = [];
  if (!businessProfile.connected) {
    recs.push({
      id: 'connect-gbp',
      icon: 'heroicons_outline:map-pin',
      iconColor: 'text-amber-500',
      title: 'Conecta tu Perfil de Empresa de Google',
      description: 'Podrás ver llamadas, reseñas, visitas y acciones generadas por tu ficha de Google Maps.',
      actionLabel: 'Conectar ahora',
      severity: 'warning',
    });
  }

  const campaignAlert = adsCampaigns.find((campaign) => campaign.alert);
  if (campaignAlert) {
    recs.push({
      id: 'campaign-no-leads',
      icon: 'heroicons_outline:exclamation-triangle',
      iconColor: 'text-red-500',
      title: `Campaña "${campaignAlert.name}" sin leads`,
      description: campaignAlert.alert,
      actionLabel: 'Ver campaña',
      severity: 'warning',
    });
  }

  if (businessProfile.unansweredReviews > 0) {
    recs.push({
      id: 'respond-reviews',
      icon: 'heroicons_outline:chat-bubble-bottom-center-text',
      iconColor: 'text-blue-500',
      title: `Tienes ${businessProfile.unansweredReviews} reseñas sin responder`,
      description: 'Responder reseñas mejora confianza y ayuda al posicionamiento local.',
      actionLabel: 'Ver reseñas',
      severity: 'info',
    });
  }

  const bestPage = [...webPages].sort((a, b) => b.conversionRate - a.conversionRate)[0];
  if (bestPage && bestPage.leads > 0) {
    recs.push({
      id: 'top-page',
      icon: 'heroicons_outline:arrow-trending-up',
      iconColor: 'text-green-500',
      title: `La página "${bestPage.shortName}" está generando pacientes`,
      description: `Ha generado ${bestPage.leads} leads en el periodo. Puede ser buen destino para campañas o contenidos.`,
      severity: 'success',
    });
  }

  if (intakeConfigCount > 0) {
    recs.push({
      id: 'snippet-ok',
      icon: 'heroicons_outline:check-badge',
      iconColor: 'text-green-500',
      title: 'ClinicaClick Analytics tiene configuración activa',
      description: 'Los formularios, llamadas, WhatsApp y pageviews propios se agregan en backend cuando WebEvents está activo.',
      severity: 'success',
    });
  }

  return recs.slice(0, 6);
}

exports.getOverview = async (req, res) => {
  try {
    const scope = await resolveReportScope(req);
    const userId = Number(req.userData?.userId || 0);
    const allowed = scope.isAll
      ? isGlobalAdmin(userId)
      : await hasMarketingClinicScopeAccess({
        userId,
        clinicIds: scope.clinicIds || [],
        access: 'read',
      });
    if (!allowed) {
      const error = new Error('scope_forbidden');
      error.status = 403;
      throw error;
    }
    const range = buildRange(req.query.startDate, req.query.endDate, 30);
    const marketingState = await resolveReportMarketingState(scope);
    const paidAttributionCoverage = await resolvePaidAttributionCoverage(scope);
    const paidCoverageSummary = buildPaidAttributionCoverageSummary(range, paidAttributionCoverage);

    const [
      leads,
      previousLeads,
      leadSeries,
      appointments,
      previousAppointments,
      appointmentSeries,
      spendSeries,
      formsCount,
      whatsappWeb,
      intakeConfigCount,
      googleAds,
      previousGoogleAds,
      metaAds,
      previousMetaAds,
      ga,
      seo,
      social,
      businessProfile,
      firstParty,
    ] = await Promise.all([
      aggregateLeads(scope, range),
      aggregateLeads(scope, range.previous),
      aggregateLeadSeries(scope, range),
      countAppointments(scope, range),
      countAppointments(scope, range.previous),
      aggregateAppointmentSeries(scope, range),
      aggregateSpendSeries(scope, range, marketingState, paidAttributionCoverage.start),
      aggregateForms(scope, range),
      aggregateWhatsappWebOrigins(scope, range),
      getIntakeConfigCount(scope),
      aggregateGoogleAds(scope, range, marketingState, paidAttributionCoverage.start),
      aggregateGoogleAds(scope, range.previous, marketingState, paidAttributionCoverage.start),
      aggregateMetaAds(scope, range, marketingState, paidAttributionCoverage.start),
      aggregateMetaAds(scope, range.previous, marketingState, paidAttributionCoverage.start),
      aggregateGa(scope, range, marketingState),
      aggregateSeo(scope, range, marketingState),
      aggregateSocialOrganic(scope, range, marketingState),
      aggregateBusinessProfile(scope, range, marketingState),
      webEventsService.getFirstPartySummary(scope, range),
    ]);

    const webPages = await aggregateWebPages(scope, range, seo.pages);

    const currentSpend = money(googleAds.totals.spend + metaAds.totals.spend);
    const previousSpend = money(previousGoogleAds.totals.spend + previousMetaAds.totals.spend);

    const citas = Math.max(leads.totals.citas, appointments.creadas);
    const acudieron = Math.max(leads.totals.acudieron, appointments.completadas);
    const convertidos = leads.totals.convertidos;
    const previousCitas = Math.max(previousLeads.totals.citas, previousAppointments.creadas);
    const previousAcudieron = Math.max(previousLeads.totals.acudieron, previousAppointments.completadas);
    const previousConvertidos = previousLeads.totals.convertidos;
    const paidLeads = sumChannelStats(leads.channels, ['google_ads', 'meta_ads'], 'leads');
    const previousPaidLeads = sumChannelStats(previousLeads.channels, ['google_ads', 'meta_ads'], 'leads');

    const channels = buildChannels(leads.channels, {
      google_ads: googleAds.totals.spend,
      meta_ads: metaAds.totals.spend,
    });

    const googleCampaigns = distributeCampaignAppointments(googleAds.campaigns, leads.channels.get('google_ads'));
    const metaCampaigns = distributeCampaignAppointments(metaAds.campaigns, leads.channels.get('meta_ads'));
    const adsCampaigns = [...googleCampaigns, ...metaCampaigns]
      .sort((a, b) => b.inversion - a.inversion)
      .slice(0, 8);

    const visitsOrClicks = Math.max(
      firstParty.pageviews,
      firstParty.sessions,
      ga.sessions,
      googleAds.totals.clicks + metaAds.totals.clicks + seo.summary.clicks,
      leads.totals.leads,
      1
    );

    const kpis = buildKpis(
      { leads: leads.totals.leads, paidLeads, citas, acudieron, convertidos, spend: currentSpend },
      { leads: previousLeads.totals.leads, paidLeads: previousPaidLeads, citas: previousCitas, acudieron: previousAcudieron, convertidos: previousConvertidos, spend: previousSpend },
      {
        leads: leadSeries.leads,
        paidLeads: leadSeries.paidLeads,
        citas: leadSeries.citas.map((value, index) => Math.max(value, appointmentSeries.citas[index] || 0)),
        acudieron: leadSeries.acudieron.map((value, index) => Math.max(value, appointmentSeries.acudieron[index] || 0)),
        convertidos: leadSeries.convertidos,
        spend: spendSeries,
      }
    );

    const funnelBase = [
      { id: 'visitas', label: firstParty.pageviews ? 'Visitas web propias' : (ga.sessions ? 'Sesiones / visitas' : 'Visitas / clicks'), value: visitsOrClicks, color: '#6366f1', helpText: firstParty.pageviews ? 'Pageviews capturados por ClinicaClick Analytics con consentimiento.' : 'Sesiones GA4 si existen; si no, clicks medidos desde SEO y Ads.' },
      { id: 'leads', label: 'Leads', value: leads.totals.leads, color: '#8b5cf6', helpText: 'Personas que dejaron sus datos.' },
      { id: 'contacto', label: 'Contactados', value: leads.totals.contactados, color: '#a78bfa', helpText: 'Leads con contacto o avance comercial.' },
      { id: 'citas', label: 'Cita creada', value: citas, color: '#c4b5fd', helpText: 'Leads que agendaron cita.' },
      { id: 'acudio', label: 'Acudió', value: acudieron, color: '#22c55e', helpText: 'Pacientes que acudieron a consulta.' },
      { id: 'tratamiento', label: 'Realiza tratamiento', value: convertidos, color: '#15803d', helpText: 'Pacientes marcados como convertidos porque realizan tratamiento.' },
    ];
    const funnel = funnelBase.map((step, index) => ({
      ...step,
      ratioFromPrevious: index > 0 ? ratioPct(step.value, funnelBase[index - 1].value, 0) : null,
    }));

    const legacyWhatsappLeads = leads.channels.get('whatsapp')?.leads || 0;
    const whatsappWebClicks = Math.max(whatsappWeb.clicks, legacyWhatsappLeads);
    const webConvertedPatients = sumChannelStats(
      leads.channels,
      ['web', 'direct', 'call_click', 'whatsapp'],
      'convertidos'
    );

    const webSummary = {
      totalVisitas: visitsOrClicks,
      sessions: firstParty.sessions,
      visitors: firstParty.visitors,
      firstPartyPageviews: firstParty.pageviews,
      clicksTelefono: Math.max(firstParty.telClicks, leads.channels.get('call_click')?.leads || 0),
      clicksWhatsApp: Math.max(firstParty.whatsappClicks, whatsappWebClicks),
      whatsappWebClicks,
      whatsappWebConfirmed: whatsappWeb.confirmed,
      webConvertedPatients,
      formularios: Math.max(firstParty.formSubmits, formsCount),
    };

    const sync = await buildSyncStatus(scope, {
      seo,
      googleAds,
      metaAds,
      ga,
      businessProfile,
    }, marketingState);

    const syncBySource = new Map((sync.allSources || []).map((item) => [item.source, item]));
    const sources = buildSources({
      intakeConfigCount,
      leadsTotal: leads.totals.leads,
      seo,
      googleAds,
      metaAds,
      ga,
      businessProfile,
      social,
      firstParty,
      mappingCounts: sync.mappingCounts,
    }).map((source) => ({
      ...source,
      sync: syncBySource.get(source.source) || null,
    }));

    const recommendations = buildRecommendations({
      businessProfile,
      adsCampaigns,
      webPages,
      intakeConfigCount,
    });

    return res.json({
      success: true,
      mode: 'real_v1',
      scope: {
        type: scope.scope,
        clinicIds: scope.clinicIds || [],
        groupId: scope.groupId || null,
        original: scope.original || null,
      },
      period: { start: range.startLabel, end: range.endLabel, label: dateLabel(range.startLabel, range.endLabel) },
      comparison: { start: range.previous.startLabel, end: range.previous.endLabel, label: dateLabel(range.previous.startLabel, range.previous.endLabel) },
      lastUpdated: new Date().toISOString(),
      sources,
      sync,
      kpis,
      funnel,
      channels,
      webSummary,
      webPages,
      seoSummary: seo.summary,
      seoQueries: seo.queries,
      seoPages: seo.pages,
      social,
      adsCampaigns,
      businessProfile: businessProfile.metrics,
      recommendations,
      dataQuality: {
        firstPartyPageviews: firstParty.connected,
        paidAttributionCoverage: paidCoverageSummary,
        note: firstParty.connected
          ? 'V1 usa WebEvents propios agregados en backend, además de leads, formularios, citas y fuentes externas.'
          : 'V1 usa leads, formularios, citas y agregados externos existentes. Pageviews propios aparecerán cuando WebEvents tenga datos agregados.',
      },
    });
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) {
      console.error('❌ marketing reports overview error:', error);
    }
    return res.status(status).json({
      success: false,
      error: error.message || 'Error generando informe de marketing',
    });
  }
};

exports.__testing = {
  deriveChannelKey,
  leadAcquisitionChannelSql: LEAD_ACQUISITION_CHANNEL_SQL,
  normalizeDateOnly,
  buildRange,
  comparablePaidRangeStart,
  buildComparablePaidDateWhere,
  resolvePaidAttributionCoverage,
  buildPaidAttributionCoverageSummary,
  googleAdsRemoteFactGroup: GOOGLE_ADS_REMOTE_FACT_GROUP,
  aggregateLeads,
  aggregateGoogleAds,
  aggregateSpendSeries,
  channelLabel,
  buildChannels,
  buildKpis,
  buildEffectiveMarketingStateInput,
  resolveReportMarketingState,
  mergeEffectiveMarketingStates,
  effectiveGoogleCustomerIds,
  effectiveMetaAdAccountIds,
  effectiveSocialMappingIds,
  effectiveSearchConsoleSiteUrls,
  effectiveSearchConsoleMetricPairs,
  effectiveAnalyticsMappingIds,
  effectiveBusinessLocationIds,
  scopeWithEffectiveAssetOwners,
  buildHistoricalOrEffectiveWhere,
  buildEffectiveSnapshotWhere,
  scopedRawOrEffectiveSql,
  buildSearchConsoleDataWhere,
  buildGoogleAdsDataWhere,
  buildMetaAdsDataWhere,
  latestEffectiveGoogleSync,
};
