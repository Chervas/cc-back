'use strict';

const { Op, fn, col, literal } = require('sequelize');
const db = require('../../models');
const { resolveClinicScope, buildAssetScopeWhere } = require('../lib/clinicScope');

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
} = db;

const QueryTypes = db.Sequelize.QueryTypes;
const sequelize = db.sequelize;

const DAY_MS = 86400000;
const CITED_LEAD_STATUSES = new Set(['citado', 'acudio_cita', 'convertido']);
const ATTENDED_LEAD_STATUSES = new Set(['acudio_cita', 'convertido']);
const CONTACTED_LEAD_STATUSES = new Set(['contactado', 'esperando_info', 'info_recibida', 'citado', 'acudio_cita', 'convertido']);

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

const BUSINESS_PROFILE_METRIC_GROUPS = {
  views: [
    'BUSINESS_IMPRESSIONS_TOTAL',
    'BUSINESS_IMPRESSIONS_DESKTOP_MAPS',
    'BUSINESS_IMPRESSIONS_DESKTOP_SEARCH',
    'BUSINESS_IMPRESSIONS_MOBILE_MAPS',
    'BUSINESS_IMPRESSIONS_MOBILE_SEARCH'
  ],
  calls: ['BUSINESS_CONVERSIONS_CALL_CLICKS', 'CALL_CLICKS'],
  directions: ['BUSINESS_CONVERSIONS_DIRECTIONS', 'BUSINESS_DIRECTION_REQUESTS'],
  websiteClicks: ['BUSINESS_CONVERSIONS_WEBSITE_CLICKS', 'WEBSITE_CLICKS']
};

function money(value) {
  return round(value, 2);
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

function deriveChannelKey(row) {
  const source = String(row.source || 'unknown').toLowerCase();
  const utmSource = String(row.utm_source || '').toLowerCase();
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

function emptyChannelStats() {
  return { leads: 0, citas: 0, acudieron: 0 };
}

function channelLabel(key) {
  const map = {
    google_ads: { name: 'Google Ads', icon: 'heroicons_outline:cursor-arrow-ripple', source: 'Google Ads' },
    meta_ads: { name: 'Meta Ads (Facebook / Instagram)', icon: 'heroicons_outline:megaphone', source: 'Meta Ads' },
    seo: { name: 'SEO (búsqueda orgánica)', icon: 'heroicons_outline:magnifying-glass', source: 'Search Console' },
    web: { name: 'Web directa', icon: 'heroicons_outline:globe-alt', source: 'ClinicaClick' },
    direct: { name: 'Directo', icon: 'heroicons_outline:globe-alt', source: 'ClinicaClick' },
    whatsapp: { name: 'WhatsApp', icon: 'heroicons_outline:chat-bubble-left-right', source: 'ClinicaClick' },
    social_organic: { name: 'Redes sociales orgánico', icon: 'heroicons_outline:share', source: 'Redes sociales' },
    call_click: { name: 'Llamada telefónica', icon: 'heroicons_outline:phone', source: 'ClinicaClick' },
    local_services: { name: 'Perfil de Empresa Google', icon: 'heroicons_outline:map-pin', source: 'Perfil Google' },
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

async function aggregateLeads(scope, range) {
  const where = {
    ...scopedWhere('clinica_id', scope),
    ...buildSequelizeDateWhere('created_at', range),
  };
  const rows = await LeadIntake.findAll({
    attributes: [
      'source',
      'utm_source',
      'status_lead',
      [fn('COUNT', col('id')), 'count'],
    ],
    where,
    group: ['source', 'utm_source', 'status_lead'],
    raw: true,
  });

  const channels = new Map();
  const totals = { leads: 0, contactados: 0, citas: 0, acudieron: 0 };

  for (const row of rows) {
    const count = toNumber(row.count);
    const status = String(row.status_lead || '').toLowerCase();
    const key = deriveChannelKey(row);
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
  }

  return { totals, channels };
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

async function aggregateForms(scope, range) {
  if (!FormSubmissionEvent) return 0;
  return FormSubmissionEvent.count({
    where: {
      ...scopedWhere('clinic_id', scope),
      ...buildSequelizeDateWhere('submitted_at', range),
    },
  });
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

async function aggregateGoogleAds(scope, range) {
  if (!GoogleAdsInsightsDaily) {
    return { totals: { spend: 0, clicks: 0, impressions: 0, conversions: 0 }, campaigns: [], connected: false, lastSync: null };
  }

  const where = {
    ...buildAdsScopeWhere(scope, 'clinicaId', 'grupoClinicaId'),
    ...buildDateOnlyWhere('date', range),
  };

  const [totalRow] = await GoogleAdsInsightsDaily.findAll({
    attributes: [
      [fn('SUM', col('impressions')), 'impressions'],
      [fn('SUM', col('clicks')), 'clicks'],
      [fn('SUM', col('costMicros')), 'costMicros'],
      [fn('SUM', col('conversions')), 'conversions'],
      [fn('MAX', col('date')), 'lastDate'],
    ],
    where,
    raw: true,
  });

  const campaignRows = await GoogleAdsInsightsDaily.findAll({
    attributes: [
      'campaignId',
      'campaignName',
      [fn('SUM', col('costMicros')), 'costMicros'],
      [fn('SUM', col('conversions')), 'conversions'],
      [fn('SUM', col('clicks')), 'clicks'],
    ],
    where,
    group: ['campaignId', 'campaignName'],
    order: [[literal('SUM(costMicros)'), 'DESC']],
    limit: 5,
    raw: true,
  });

  const accountWhere = buildAssetScopeWhere(scope);
  const activeAccounts = ClinicGoogleAdsAccount
    ? await ClinicGoogleAdsAccount.count({ where: accountWhere })
    : 0;
  const latestAccount = ClinicGoogleAdsAccount
    ? await ClinicGoogleAdsAccount.findOne({ where: accountWhere, order: [['lastSyncedAt', 'DESC']], raw: true })
    : null;

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
      cpl: leads ? money(inversion / leads) : 0,
      cpaCita: 0,
      alert: inversion >= 25 && leads === 0
        ? 'Esta campaña está gastando sin registrar conversiones en Google Ads. Revisa su destino y medición.'
        : undefined,
    };
  });

  return {
    totals,
    campaigns,
    connected: activeAccounts > 0 || totals.spend > 0 || totals.clicks > 0,
    lastSync: latestAccount?.lastSyncedAt || totalRow?.lastDate || null,
  };
}

async function aggregateMetaAds(scope, range) {
  if (!SocialAdsInsightsDaily) {
    return { totals: { spend: 0, clicks: 0, impressions: 0, conversions: 0 }, campaigns: [], connected: false, lastSync: null };
  }

  const scopeWhere = buildAdsScopeWhere(scope, 'clinica_id', 'grupo_clinica_id');
  const baseWhere = {
    ...scopeWhere,
    ...buildDateOnlyWhere('date', range),
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
          ...buildDateOnlyWhere('date', range),
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
      ...buildDateOnlyWhere('date', range),
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

  const assetWhere = buildAssetScopeWhere(scope);
  assetWhere.assetType = 'ad_account';
  const activeAccounts = ClinicMetaAsset
    ? await ClinicMetaAsset.count({ where: assetWhere })
    : 0;

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
      cpl: leads ? money(inversion / leads) : 0,
      cpaCita: 0,
      alert: inversion >= 25 && leads === 0
        ? 'Esta campaña está gastando sin registrar leads. Revisa la creatividad, el destino o la atribución.'
        : undefined,
    };
  });

  return {
    totals,
    campaigns,
    connected: activeAccounts > 0 || totals.spend > 0 || totals.clicks > 0,
    lastSync: totalRow?.lastDate || null,
  };
}

async function aggregateGa(scope, range) {
  if (!WebGaDaily) return { sessions: 0, activeUsers: 0, newUsers: 0, conversions: 0, connected: false, lastSync: null };
  const where = {
    ...scopedWhere('clinica_id', scope),
    ...buildDateOnlyWhere('date', range),
  };
  const [row] = await WebGaDaily.findAll({
    attributes: [
      [fn('SUM', col('sessions')), 'sessions'],
      [fn('SUM', col('active_users')), 'activeUsers'],
      [fn('SUM', col('new_users')), 'newUsers'],
      [fn('SUM', col('conversions')), 'conversions'],
      [fn('MAX', col('date')), 'lastDate'],
    ],
    where,
    raw: true,
  });
  return {
    sessions: toNumber(row?.sessions),
    activeUsers: toNumber(row?.activeUsers),
    newUsers: toNumber(row?.newUsers),
    conversions: toNumber(row?.conversions),
    connected: toNumber(row?.sessions) > 0 || toNumber(row?.activeUsers) > 0,
    lastSync: row?.lastDate || null,
  };
}

async function aggregateSeo(scope, range) {
  const empty = {
    summary: { clicks: 0, impressions: 0, ctr: 0, avgPosition: 0 },
    queries: [],
    pages: [],
    connected: false,
    lastSync: null,
  };
  if (!WebScDaily || !WebScQueryDaily) return empty;

  const where = {
    ...scopedWhere('clinica_id', scope),
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
  const clinicSql = scopedRawSql('clinica_id', scope, replacements, 'seoClinicIds');
  const queryRows = await sequelize.query(
    `SELECT query,
            SUM(clicks) AS clicks,
            SUM(impressions) AS impressions,
            CASE WHEN SUM(impressions) > 0 THEN SUM(position * impressions) / SUM(impressions) ELSE AVG(position) END AS position
       FROM WebScQueryDaily
      WHERE date BETWEEN :start AND :end ${clinicSql}
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
      WHERE date BETWEEN :start AND :end ${clinicSql}
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

async function aggregateSocialOrganic(scope, range) {
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

  const assetWhere = buildAssetScopeWhere(scope);
  const [facebookMappings, instagramMappings] = await Promise.all([
    ClinicMetaAsset.count({ where: { ...assetWhere, assetType: 'facebook_page' } }),
    ClinicMetaAsset.count({ where: { ...assetWhere, assetType: 'instagram_business' } }),
  ]);

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
      ...scopedWhere('clinica_id', scope),
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
      ...scopedWhere('clinica_id', scope),
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
  const postClinicSql = scopedRawSql('p.clinica_id', scope, replacements, 'socialPostClinicIds');
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
        ${postClinicSql}
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
    limit: 5,
  };
  const leadClinicSql = scopedRawSql('clinica_id', scope, replacements, 'leadPageClinicIds');
  const formClinicSql = scopedRawSql('clinic_id', scope, replacements, 'formPageClinicIds');

  const rows = await sequelize.query(
    `SELECT url,
            SUM(leads) AS leads,
            SUM(clicks_tel) AS clicksTel,
            SUM(clicks_wa) AS clicksWa,
            SUM(formularios) AS formularios
       FROM (
             SELECT COALESCE(NULLIF(page_url, ''), NULLIF(landing_url, ''), 'Sin página') AS url,
                    COUNT(*) AS leads,
                    SUM(CASE WHEN source = 'call_click' THEN 1 ELSE 0 END) AS clicks_tel,
                    SUM(CASE WHEN source = 'whatsapp' THEN 1 ELSE 0 END) AS clicks_wa,
                    0 AS formularios
               FROM LeadIntakes
              WHERE created_at >= :startTs AND created_at < :endTs ${leadClinicSql}
              GROUP BY COALESCE(NULLIF(page_url, ''), NULLIF(landing_url, ''), 'Sin página')
             UNION ALL
             SELECT COALESCE(NULLIF(page_url, ''), 'Sin página') AS url,
                    0 AS leads,
                    0 AS clicks_tel,
                    0 AS clicks_wa,
                    COUNT(*) AS formularios
               FROM FormSubmissionEvents
              WHERE submitted_at >= :startTs AND submitted_at < :endTs ${formClinicSql}
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
    const visits = Math.max(toNumber(seoClicksByPath.get(normalizeUrlKey(row.url))), leads + formularios);
    return {
      url: row.url || 'Sin página',
      shortName: shortUrl(row.url || 'Sin página'),
      visitas: visits,
      leads,
      conversionRate: ratioPct(leads, visits, 2),
      clicksTel: toNumber(row.clicksTel),
      clicksWa: toNumber(row.clicksWa),
      formularios,
    };
  });
}

async function aggregateBusinessProfile(scope, range) {
  const empty = {
    metrics: { views: 0, calls: 0, directions: 0, websiteClicks: 0, newReviews: 0, averageRating: 0, totalReviews: 0 },
    connected: false,
    lastSync: null,
    unansweredReviews: 0,
  };
  if (!ClinicBusinessLocation || !BusinessProfileDailyMetric || !BusinessProfileReview) return empty;

  const locationWhere = {
    ...scopedWhere('clinica_id', scope),
    is_active: true,
  };
  const latestLocation = await ClinicBusinessLocation.findOne({ where: locationWhere, order: [['last_synced_at', 'DESC']], raw: true });
  const locations = await ClinicBusinessLocation.count({ where: locationWhere });

  const metricWhere = {
    ...scopedWhere('clinica_id', scope),
    ...buildDateOnlyWhere('date', range),
  };
  const rows = await BusinessProfileDailyMetric.findAll({ where: metricWhere, raw: true });
  const sumBy = (metrics) => {
    const allowed = new Set(Array.isArray(metrics) ? metrics : [metrics]);
    return rows
      .filter((row) => allowed.has(row.metric_type))
      .reduce((acc, row) => acc + toNumber(row.value), 0);
  };

  const reviewWhere = scopedWhere('clinica_id', scope);
  const reviews = await BusinessProfileReview.findAll({ where: reviewWhere, raw: true });
  const totalReviews = reviews.length;
  const averageRating = totalReviews
    ? round(reviews.reduce((acc, row) => acc + toNumber(row.star_rating), 0) / totalReviews, 1)
    : 0;
  const newReviews = reviews.filter((row) => row.is_new).length;
  const unansweredReviews = reviews.filter((row) => !row.has_reply).length;

  const metrics = {
    views: sumBy(BUSINESS_PROFILE_METRIC_GROUPS.views),
    calls: sumBy(BUSINESS_PROFILE_METRIC_GROUPS.calls),
    directions: sumBy(BUSINESS_PROFILE_METRIC_GROUPS.directions),
    websiteClicks: sumBy(BUSINESS_PROFILE_METRIC_GROUPS.websiteClicks),
    newReviews,
    averageRating,
    totalReviews,
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
    };
  });
}

function distributeCampaignAppointments(campaigns, platformChannelStats) {
  const totalLeads = campaigns.reduce((acc, row) => acc + toNumber(row.leads), 0);
  const citaRate = totalLeads && platformChannelStats?.leads
    ? toNumber(platformChannelStats.citas) / toNumber(platformChannelStats.leads)
    : 0;
  return campaigns.map((row) => {
    const citas = Math.round(toNumber(row.leads) * citaRate);
    return {
      ...row,
      citas,
      cpaCita: citas ? money(row.inversion / citas) : 0,
    };
  });
}

function buildSources({ intakeConfigCount, leadsTotal, seo, googleAds, metaAds, ga, businessProfile, social, mappingCounts = {} }) {
  const clinicaClickConnected = intakeConfigCount > 0 || leadsTotal > 0;
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
      tooltip: clinicaClickConnected
        ? 'Hay configuración de medición o leads capturados por ClinicaClick.'
        : 'Aún no hay configuración o datos capturados por el snippet de ClinicaClick.',
      lastSync: leadsTotal > 0 ? 'Tiempo real' : undefined,
      source: 'ClinicaClick',
    },
    {
      name: 'Search Console',
      icon: 'heroicons_outline:magnifying-glass',
      connected: searchConsoleMapped,
      label: searchConsoleMapped ? 'Conectado' : 'Sin datos',
      tooltip: 'Search Console mide cómo te encuentra la gente en Google.',
      lastSync: relativeSyncLabel(seo.lastSync),
      source: 'Search Console',
    },
    {
      name: 'Google Ads',
      icon: 'heroicons_outline:currency-euro',
      connected: googleAdsMapped,
      label: googleAdsMapped ? 'Conectado' : 'Pendiente',
      tooltip: 'Datos de campañas de Google Ads sincronizados.',
      lastSync: relativeSyncLabel(googleAds.lastSync),
      source: 'Google Ads',
    },
    {
      name: 'Meta Ads',
      icon: 'heroicons_outline:megaphone',
      connected: metaAdsMapped,
      label: metaAdsMapped ? 'Conectado' : 'Pendiente',
      tooltip: 'Datos de campañas de Facebook e Instagram sincronizados.',
      lastSync: relativeSyncLabel(metaAds.lastSync),
      source: 'Meta Ads',
    },
    {
      name: 'Facebook',
      icon: 'heroicons_outline:flag',
      connected: facebookMapped,
      label: facebookMapped ? 'Conectado' : 'Pendiente',
      tooltip: 'Publicaciones, alcance, seguidores y visitas orgánicas de tu página de Facebook.',
      lastSync: relativeSyncLabel(socialPlatformSync.get('Facebook')),
      source: 'Facebook',
    },
    {
      name: 'Instagram',
      icon: 'heroicons_outline:camera',
      connected: instagramMapped,
      label: instagramMapped ? 'Conectado' : 'Pendiente',
      tooltip: 'Publicaciones, alcance, seguidores y visitas orgánicas de tu cuenta de Instagram.',
      lastSync: relativeSyncLabel(socialPlatformSync.get('Instagram')),
      source: 'Instagram',
    },
    {
      name: 'Perfil de Empresa Google',
      icon: 'heroicons_outline:map-pin',
      connected: businessProfileMapped,
      label: businessProfileMapped ? 'Conectado' : 'Pendiente',
      tooltip: 'Conecta tu Perfil de Empresa de Google para ver llamadas, reseñas y visitas a tu ficha.',
      lastSync: relativeSyncLabel(businessProfile.lastSync),
      source: 'Perfil Google',
    },
    {
      name: 'Google Analytics 4',
      icon: 'heroicons_outline:presentation-chart-line',
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

async function buildSyncStatus(scope, { seo, googleAds, metaAds, ga, businessProfile }) {
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
    ClinicWebAsset ? ClinicWebAsset.count({ where: { ...scopedWhere('clinicaId', scope), isActive: true } }) : 0,
    ClinicAnalyticsProperty ? ClinicAnalyticsProperty.count({ where: { ...scopedWhere('clinicaId', scope), isActive: true } }) : 0,
    ClinicBusinessLocation ? ClinicBusinessLocation.findAll({ where: { ...scopedWhere('clinica_id', scope), is_active: true }, raw: true }) : [],
    ClinicGoogleAdsAccount ? ClinicGoogleAdsAccount.count({ where: { ...buildAdsScopeWhere(scope, 'clinicaId', 'grupoClinicaId'), isActive: true } }) : 0,
    ClinicMetaAsset ? ClinicMetaAsset.count({ where: { ...buildAssetScopeWhere(scope), assetType: 'ad_account' } }) : 0,
    ClinicMetaAsset ? ClinicMetaAsset.count({ where: { ...buildAssetScopeWhere(scope), assetType: 'facebook_page' } }) : 0,
    ClinicMetaAsset ? ClinicMetaAsset.count({ where: { ...buildAssetScopeWhere(scope), assetType: 'instagram_business' } }) : 0,
    recentJobsForSource(SOURCE_SYNC_CONFIG.search_console, scope),
    recentJobsForSource(SOURCE_SYNC_CONFIG.analytics, scope),
    recentJobsForSource(SOURCE_SYNC_CONFIG.business_profile, scope),
    recentJobsForSource(SOURCE_SYNC_CONFIG.google_ads, scope),
    recentJobsForSource(SOURCE_SYNC_CONFIG.meta_ads, scope),
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

function buildKpis(current, previous) {
  const { leads, citas, acudieron, spend } = current;
  const cpl = leads ? spend / leads : 0;
  const cpaCita = citas ? spend / citas : 0;
  const cpaAcudio = acudieron ? spend / acudieron : 0;
  return [
    {
      id: 'leads',
      label: 'Leads reales recibidos',
      value: leads,
      helpText: 'Personas que dejaron sus datos a través de tu web, WhatsApp, llamada o campañas.',
      trend: pct(leads, previous.leads),
      trendLabel: 'vs. periodo anterior',
      source: 'ClinicaClick',
    },
    {
      id: 'citas',
      label: 'Citas creadas desde esos leads',
      value: citas,
      helpText: 'Leads que acabaron con una cita agendada en tu clínica.',
      trend: pct(citas, previous.citas),
      trendLabel: 'vs. periodo anterior',
      source: 'ClinicaClick',
    },
    {
      id: 'acudieron',
      label: 'Pacientes que acudieron',
      value: acudieron,
      helpText: 'De las citas creadas desde leads, cuántos pacientes vinieron realmente.',
      trend: pct(acudieron, previous.acudieron),
      trendLabel: 'vs. periodo anterior',
      source: 'ClinicaClick',
    },
    {
      id: 'tasa',
      label: 'Tasa lead -> cita',
      value: ratioPct(citas, leads, 0),
      suffix: '%',
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
      helpText: 'Cuánto cuesta conseguir cada lead real registrado en ClinicaClick.',
      trend: pct(cpl, previous.leads ? previous.spend / previous.leads : 0),
      trendLabel: 'vs. periodo anterior',
      source: 'ClinicaClick',
    },
    {
      id: 'cpa-cita',
      label: 'Coste medio por cita',
      value: money(cpaCita),
      prefix: '€',
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
      helpText: 'Cuánto cuesta que un paciente venga realmente a consulta.',
      trend: pct(cpaAcudio, previous.acudieron ? previous.spend / previous.acudieron : 0),
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
      description: 'Los formularios, llamadas y WhatsApp ya pueden atribuirse a leads. Pageviews propios quedan para la siguiente fase de analítica.',
      severity: 'success',
    });
  }

  return recs.slice(0, 6);
}

exports.getOverview = async (req, res) => {
  try {
    const scope = await resolveReportScope(req);
    const range = buildRange(req.query.startDate, req.query.endDate, 30);

    const [
      leads,
      previousLeads,
      appointments,
      previousAppointments,
      formsCount,
      intakeConfigCount,
      googleAds,
      previousGoogleAds,
      metaAds,
      previousMetaAds,
      ga,
      seo,
      social,
      businessProfile,
    ] = await Promise.all([
      aggregateLeads(scope, range),
      aggregateLeads(scope, range.previous),
      countAppointments(scope, range),
      countAppointments(scope, range.previous),
      aggregateForms(scope, range),
      getIntakeConfigCount(scope),
      aggregateGoogleAds(scope, range),
      aggregateGoogleAds(scope, range.previous),
      aggregateMetaAds(scope, range),
      aggregateMetaAds(scope, range.previous),
      aggregateGa(scope, range),
      aggregateSeo(scope, range),
      aggregateSocialOrganic(scope, range),
      aggregateBusinessProfile(scope, range),
    ]);

    const webPages = await aggregateWebPages(scope, range, seo.pages);

    const currentSpend = money(googleAds.totals.spend + metaAds.totals.spend);
    const previousSpend = money(previousGoogleAds.totals.spend + previousMetaAds.totals.spend);

    const citas = Math.max(leads.totals.citas, appointments.creadas);
    const acudieron = Math.max(leads.totals.acudieron, appointments.completadas);
    const previousCitas = Math.max(previousLeads.totals.citas, previousAppointments.creadas);
    const previousAcudieron = Math.max(previousLeads.totals.acudieron, previousAppointments.completadas);

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
      ga.sessions,
      googleAds.totals.clicks + metaAds.totals.clicks + seo.summary.clicks,
      leads.totals.leads,
      1
    );

    const kpis = buildKpis(
      { leads: leads.totals.leads, citas, acudieron, spend: currentSpend },
      { leads: previousLeads.totals.leads, citas: previousCitas, acudieron: previousAcudieron, spend: previousSpend }
    );

    const funnel = [
      { id: 'visitas', label: ga.sessions ? 'Sesiones / visitas' : 'Visitas / clicks', value: visitsOrClicks, color: '#6366f1', helpText: 'Sesiones GA4 si existen; si no, clicks medidos desde SEO y Ads.' },
      { id: 'leads', label: 'Leads', value: leads.totals.leads, color: '#8b5cf6', helpText: 'Personas que dejaron sus datos.' },
      { id: 'contacto', label: 'Contactados', value: leads.totals.contactados, color: '#a78bfa', helpText: 'Leads con contacto o avance comercial.' },
      { id: 'citas', label: 'Cita creada', value: citas, color: '#c4b5fd', helpText: 'Leads que agendaron cita.' },
      { id: 'acudio', label: 'Acudió', value: acudieron, color: '#22c55e', helpText: 'Pacientes que acudieron a consulta.' },
    ];

    const webSummary = {
      totalVisitas: visitsOrClicks,
      clicksTelefono: leads.channels.get('call_click')?.leads || 0,
      clicksWhatsApp: leads.channels.get('whatsapp')?.leads || 0,
      formularios: formsCount,
    };

    const sync = await buildSyncStatus(scope, {
      seo,
      googleAds,
      metaAds,
      ga,
      businessProfile,
    });

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
        firstPartyPageviews: false,
        note: 'V1 usa leads, formularios, citas y agregados externos existentes. Pageviews propios requieren WebEvents/WebPageDaily.',
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
