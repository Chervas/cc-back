'use strict';

const axios = require('axios');
const asyncHandler = require('express-async-handler');
const { Op, fn, col, literal } = require('sequelize');
const db = require('../../models');
const {
  googleAdsRequest,
  normalizeCustomerId,
  formatCustomerId,
  ensureGoogleAdsConfig
} = require('../lib/googleAdsClient');
const { metaGet } = require('../lib/metaClient');
const {
  resolveGoogleConnectionForScope,
  resolveMetaConnectionForScope
} = require('../services/scopeConnectionResolver.service');
const {
  extractGoogleTagId,
  listMetaPixelsForScopeAdAccount,
  mergeGoogleAdsConfig: mergeEffectiveGoogleAdsConfig,
  normalizeMetaAdAccountId,
  normalizeMetaAdsConfig,
  resolveEffectiveMarketingState
} = require('../services/effectiveMarketingAssets.service');
const { resolveScopedGoogleAdsRuntime } = require('../services/googleAdsScopedRuntime.service');
const {
  clinicIdsFromStrategyRows,
  hasMarketingClinicScopeAccess,
  normalizeClinicIds,
  requestIdsFromRows
} = require('../lib/marketingScopeAccess');
const {
  provisionManagedCampaignsFromStrategy
} = require('../services/managedCampaignProvisioning.service');
const {
  canonicalExternalCampaignIdentity,
  externalCampaignIdentityKey,
} = require('../services/externalCampaignAssignmentTargets.service');

const GoogleConnection = db.GoogleConnection;
const MetaConnection = db.MetaConnection;
const Clinica = db.Clinica;
const GrupoClinica = db.GrupoClinica;
const IntakeConfig = db.IntakeConfig;
const ClinicGoogleAdsAccount = db.ClinicGoogleAdsAccount;
const ClinicMetaAsset = db.ClinicMetaAsset;
const CampaignRequest = db.CampaignRequest;
const Campaign = db.Campaign;
const AdminCampaignPlaybook = db.AdminCampaignPlaybook;
const Tratamiento = db.Tratamiento;
const LeadIntake = db.LeadIntake;
const GoogleAdsInsightsDaily = db.GoogleAdsInsightsDaily;
const GoogleAdsAdInsightsDaily = db.GoogleAdsAdInsightsDaily;
const ExternalCampaignInventory = db.ExternalCampaignInventory;
const ExternalCampaignAssignment = db.ExternalCampaignAssignment;
const SocialAdsEntity = db.SocialAdsEntity;
const SocialAdsInsightsDaily = db.SocialAdsInsightsDaily;
const SocialAdsActionsDaily = db.SocialAdsActionsDaily;

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const GOOGLE_ADS_SCOPE = 'https://www.googleapis.com/auth/adwords';

// `managed_self` is retained only to read historical configurations. New
// onboarding/strategy writes must use one of the two current product modes.
const VALID_MODES = new Set(['connect_only', 'managed_self', 'managed_service']);
const CREATABLE_MODES = new Set(['connect_only', 'managed_service']);
const VALID_PROVIDERS = new Set(['google_ads', 'meta_ads']);
const VALID_EVENTS = ['lead', 'contact', 'schedule', 'purchase'];
const VALID_STRATEGY_OBJECTIVES = new Set(['new_patients']);
const VALID_STRATEGY_CHANNELS = new Set(['meta_ads', 'google_ads', 'whatsapp', 'email', 'remarketing', 'landing', 'youtube', 'phone']);
const VALID_STRATEGY_STATUSES = new Set(['draft', 'pending_approval', 'active', 'paused', 'completed']);
const STRATEGY_STATUS_TRANSITIONS = {
  draft: ['pending_approval'],
  pending_approval: ['active', 'draft'],
  active: ['paused', 'completed'],
  paused: ['active', 'completed'],
  completed: []
};
const STRATEGY_REQUEST_STATE_MAP = {
  draft: 'pendiente_aceptacion',
  pending_approval: 'pendiente_aceptacion',
  active: 'activa',
  paused: 'pausada',
  completed: 'finalizada'
};

const EVENT_CATALOG = {
  lead: {
    name: 'Lead - ClinicaClick',
    category: 'SUBMIT_LEAD_FORM',
    detect: ['lead', 'leads', 'formulario']
  },
  contact: {
    name: 'Contact - ClinicaClick',
    category: 'CONTACT',
    detect: ['contact', 'llamada', 'call']
  },
  schedule: {
    name: 'Schedule - ClinicaClick',
    category: 'BOOK_APPOINTMENT',
    detect: ['schedule', 'appointment', 'cita', 'agenda']
  },
  purchase: {
    name: 'Purchase - ClinicaClick',
    category: 'PURCHASE',
    detect: ['purchase', 'venta', 'tratamiento', 'pago']
  }
};

function parseInteger(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function mapConnectionSourceToOrigin(source) {
  const normalized = String(source || '').trim().toLowerCase();
  if (normalized.includes('group')) return 'group';
  if (normalized.includes('clinic')) return 'clinic';
  return null;
}

function parseDate(raw, fallback) {
  if (!raw) return fallback;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return fallback;
  parsed.setHours(0, 0, 0, 0);
  return parsed;
}

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function safeNumber(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function normalizeLookupToken(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

function resolveLeadProvider(lead) {
  const candidates = [
    lead?.source,
    lead?.external_source,
    lead?.utm_source
  ]
    .map((value) => normalizeLookupToken(value))
    .filter(Boolean);

  for (const candidate of candidates) {
    if (candidate.includes('google')) return 'google_ads';
    if (candidate.includes('meta') || candidate.includes('facebook') || candidate.includes('instagram')) return 'meta_ads';
  }

  return null;
}

function microsToCurrency(value) {
  return safeNumber(value) / 1_000_000;
}

function normalizeCurrency(raw) {
  const code = String(raw || 'EUR').trim().toUpperCase();
  if (!code) return 'EUR';
  return code;
}

function getUserId(req) {
  const parsed = parseInteger(req?.userData?.userId);
  return parsed;
}

function hasScopeText(scopesText, scope) {
  if (!scopesText || !scope) return false;
  return String(scopesText).split(/\s+/).includes(scope);
}

function normalizeGoogleAdsConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return {
      enabled: false,
      customer_id: null,
      conversion_action: null,
      conversion_action_id: null,
      send_to: null,
      currency: 'EUR',
      events: {}
    };
  }
  const normalized = {
    enabled: rawConfig.enabled !== false,
    customer_id: normalizeCustomerId(rawConfig.customer_id || rawConfig.customerId || null) || null,
    conversion_action: rawConfig.conversion_action || rawConfig.conversionAction || null,
    conversion_action_id: rawConfig.conversion_action_id || rawConfig.conversionActionId || null,
    send_to: rawConfig.send_to || rawConfig.sendTo || null,
    currency: normalizeCurrency(rawConfig.currency || 'EUR'),
    events: {}
  };
  const events = rawConfig.events && typeof rawConfig.events === 'object' ? rawConfig.events : {};
  for (const key of VALID_EVENTS) {
    const eventCfg = events[key];
    if (!eventCfg || typeof eventCfg !== 'object') continue;
    const hasDestinations = Object.prototype.hasOwnProperty.call(eventCfg, 'destinations');
    const destinations = hasDestinations && Array.isArray(eventCfg.destinations)
      ? eventCfg.destinations
          .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
          .map((item, index) => ({
            key: String(item.key || item.destination_key || item.destinationKey || `destination_${index + 1}`).trim().slice(0, 128),
            enabled: item.enabled !== false,
            customer_id: normalizeCustomerId(item.customer_id || item.customerId || '') || null,
            conversion_action: item.conversion_action || item.conversionAction || null,
            conversion_action_id: item.conversion_action_id || item.conversionActionId || null,
            send_to: item.send_to || item.sendTo || null,
            currency: normalizeCurrency(item.currency || eventCfg.currency || normalized.currency || 'EUR'),
            ...(item.value !== undefined ? { value: item.value } : {}),
            ...(item.consent !== undefined ? { consent: item.consent } : {})
          }))
      : [];
    const normalizedEvent = {
      enabled: eventCfg.enabled !== false,
      customer_id: normalizeCustomerId(eventCfg.customer_id || eventCfg.customerId || '') || null,
      conversion_action: eventCfg.conversion_action || eventCfg.conversionAction || null,
      conversion_action_id: eventCfg.conversion_action_id || eventCfg.conversionActionId || null,
      send_to: eventCfg.send_to || eventCfg.sendTo || null,
      currency: normalizeCurrency(eventCfg.currency || normalized.currency || 'EUR')
    };
    if (hasDestinations) normalizedEvent.destinations = destinations;
    normalized.events[key] = normalizedEvent;
  }
  return normalized;
}

function normalizeCampaignConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return {
      active_mode: null,
      last_onboarding_id: null,
      last_onboarding_at: null
    };
  }

  const activeMode = String(rawConfig.active_mode || rawConfig.activeMode || '').trim().toLowerCase();
  return {
    active_mode: VALID_MODES.has(activeMode) ? activeMode : null,
    last_onboarding_id: parseInteger(rawConfig.last_onboarding_id || rawConfig.lastOnboardingId) || null,
    last_onboarding_at: rawConfig.last_onboarding_at || rawConfig.lastOnboardingAt || null
  };
}

function normalizeStrategyStatus(rawStatus) {
  const status = String(rawStatus || '').trim().toLowerCase();
  if (VALID_STRATEGY_STATUSES.has(status)) {
    return status;
  }
  const legacyMap = {
    borrador: 'draft',
    pendiente_aceptacion: 'pending_approval',
    activa: 'active',
    pausada: 'paused',
    finalizada: 'completed'
  };
  return legacyMap[status] || 'draft';
}

function mapStrategyStatusToRequestState(status) {
  return STRATEGY_REQUEST_STATE_MAP[normalizeStrategyStatus(status)] || 'pendiente_aceptacion';
}

function canTransitionStrategy(fromStatus, toStatus) {
  const from = normalizeStrategyStatus(fromStatus);
  const to = normalizeStrategyStatus(toStatus);
  return (STRATEGY_STATUS_TRANSITIONS[from] || []).includes(to);
}

function createEmptyStrategyMetrics() {
  return {
    investment: 0,
    leads: 0,
    conversions: 0,
    revenue: 0,
    cpl: null,
    cost_per_conversion: null
  };
}

function buildExternalCampaignMetrics(payload) {
  const targets = Array.isArray(payload?.external_targets) ? payload.external_targets : [];
  const uniqueCampaigns = new Map();

  for (const target of targets) {
    const campaigns = Array.isArray(target?.campaigns) ? target.campaigns : [];
    for (const campaign of campaigns) {
      const key = externalCampaignIdentityKey(campaign);
      if (!key) continue;
      if (uniqueCampaigns.has(key)) {
        continue;
      }

      const metrics = campaign?.metrics && typeof campaign.metrics === 'object'
        ? campaign.metrics
        : {};

      uniqueCampaigns.set(key, {
        investment: safeNumber(metrics.spend),
        conversions: safeNumber(metrics.conversions)
      });
    }
  }

  return Array.from(uniqueCampaigns.values()).reduce((acc, item) => ({
    investment: acc.investment + safeNumber(item.investment),
    conversions: acc.conversions + safeNumber(item.conversions)
  }), { investment: 0, conversions: 0 });
}

function hydrateExternalTargetsWithMetrics(rawTargets, metricsIndex) {
  const targets = normalizeExternalTargets(rawTargets);
  if (!(metricsIndex instanceof Map) || metricsIndex.size === 0) {
    return targets;
  }

  return targets.map((target) => ({
    ...target,
    campaigns: target.campaigns.map((campaign) => {
      const key = externalCampaignIdentityKey(campaign);
      const liveMetrics = metricsIndex.get(key);
      if (!liveMetrics) {
        return campaign;
      }
      return {
        ...campaign,
        metrics: {
          ...campaign.metrics,
          spend: safeNumber(liveMetrics.investment),
          conversions: safeNumber(liveMetrics.conversions)
        }
      };
    })
  }));
}

async function enrichSingleMetaCampaignReference({ scope, campaignRef }) {
  const campaignId = String(campaignRef?.external_campaign_id || '').trim();
  if (!campaignId) {
    return campaignRef;
  }

  const baseDetection = normalizeExternalCampaignDetection(campaignRef?.destination_detection);
  const adsetRows = await SocialAdsEntity.findAll({
    where: {
      level: 'adset',
      parent_id: campaignId
    },
    raw: true
  });
  const adsetIds = adsetRows.map((row) => String(row.entity_id || '').trim()).filter(Boolean);
  const adRows = adsetIds.length
    ? await SocialAdsEntity.findAll({
        where: {
          level: 'ad',
          parent_id: { [Op.in]: adsetIds }
        },
        raw: true
      })
    : [];

  const adIds = adRows.map((row) => String(row.entity_id || '').trim()).filter(Boolean);
  const campaignAdRows = new Map([
    [campaignId, adRows]
  ]);

  let destinationDetection = baseDetection;
  if (adIds.length) {
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end.getTime() - (29 * 86400000));
    const adActionRows = await SocialAdsActionsDaily.findAll({
      attributes: [
        'ad_account_id',
        'entity_id',
        'clinica_id',
        'grupo_clinica_id',
        'action_type',
        [fn('SUM', col('value')), 'value']
      ],
      where: {
        level: 'ad',
        entity_id: { [Op.in]: adIds },
        date: { [Op.between]: [formatDate(start), formatDate(end)] },
        ...buildMetricsScopeWhere(scope, { clinicField: 'clinica_id', groupField: 'grupo_clinica_id' })
      },
      group: ['ad_account_id', 'entity_id', 'clinica_id', 'grupo_clinica_id', 'action_type'],
      raw: true
    });
    const campaignEntitiesById = new Map([[campaignId, {
      entity_id: campaignId,
      name: campaignRef?.name || null,
      effective_status: campaignRef?.status || null,
      status: campaignRef?.status || null
    }]]);
    const rolledActionRows = await rollupMetaAdActionRowsToCampaignSignals(adActionRows, campaignEntitiesById);
    const actionTotals = summarizeMetaCampaignActions(rolledActionRows.filter((row) => String(row.entity_id || '').trim() === campaignId));
    destinationDetection = inferMetaDestinationDetection({ actionTotals });
  }

  const metaResolved = await resolveMetaConnectionForScope({
    clinicIdRaw: scope.clinic_id,
    groupIdRaw: scope.group_id,
    assignmentScopeRaw: scope.assignment_scope,
    allowLegacyUserFallback: true
  });

  const [enrichedCampaign] = await enrichMetaCampaignDetections({
    campaigns: [{
      ...campaignRef,
      destination_detection: destinationDetection
    }],
    accessToken: metaResolved?.connection?.accessToken || null,
    campaignAdRows
  });

  return enrichedCampaign || {
    ...campaignRef,
    destination_detection: destinationDetection
  };
}

async function resolveAnalysisCampaignReference({ strategy, payload, scope, identity }) {
  const normalizedTargets = Array.isArray(strategy?.external_targets) && strategy.external_targets.length
    ? strategy.external_targets
    : normalizeExternalTargets(payload?.external_targets);
  const requestedKey = externalCampaignIdentityKey(identity);
  const baseRef = normalizedTargets
    .flatMap((target) => Array.isArray(target?.campaigns) ? target.campaigns : [])
    .find((campaign) => externalCampaignIdentityKey(campaign) === requestedKey);

  if (!baseRef) {
    return null;
  }

  if (identity.provider === 'google_ads') {
    return {
      ...baseRef,
      destination_detection: normalizeExternalCampaignDetection(baseRef.destination_detection || createWebDestinationDetection('google_ads_default', 'medium'))
    };
  }

  const currentDetection = normalizeExternalCampaignDetection(baseRef.destination_detection)
    || createUnknownDestinationDetection('meta_not_enough_data');
  const hasUsefulDetection = currentDetection.kind === 'web'
    || currentDetection.kind === 'lead_form'
    || (Array.isArray(currentDetection.urls) && currentDetection.urls.length > 0)
    || !!currentDetection.instant_form
    || !!currentDetection.creative_preview?.media_url
    || !!currentDetection.creative_preview?.body
    || !!currentDetection.creative_preview?.title;

  if (hasUsefulDetection) {
    return {
      ...baseRef,
      destination_detection: currentDetection
    };
  }

  return enrichSingleMetaCampaignReference({ scope, campaignRef: baseRef });
}

function buildExternalCampaignAliasIndex(rawTargets) {
  const targets = normalizeExternalTargets(rawTargets);
  const aliasIndex = new Map();

  for (const target of targets) {
    for (const campaign of target.campaigns) {
      const campaignKey = externalCampaignIdentityKey(campaign);
      if (!campaignKey) continue;
      const tokens = new Set([
        normalizeLookupToken(campaign.external_campaign_id),
        normalizeLookupToken(campaign.name)
      ].filter(Boolean));

      for (const token of tokens) {
        const aliasKey = `${campaign.provider}:${token}`;
        if (!aliasIndex.has(aliasKey)) {
          aliasIndex.set(aliasKey, new Set());
        }
        aliasIndex.get(aliasKey).add(campaignKey);
      }
    }
  }

  return aliasIndex;
}

async function loadCurrentLeadAttributionMetricsIndex({ scope, payload, days = 30 }) {
  if (!LeadIntake) {
    return new Map();
  }

  const aliasIndex = buildExternalCampaignAliasIndex(payload?.external_targets);
  if (aliasIndex.size === 0) {
    return new Map();
  }

  const end = new Date();
  const start = new Date(end.getTime() - (days * 24 * 60 * 60 * 1000));

  const rows = await LeadIntake.findAll({
    attributes: [
      'id',
      'source',
      'external_source',
      'utm_source',
      'utm_campaign',
      'source_detail',
      'status_lead'
    ],
    where: {
      created_at: { [Op.between]: [start, end] },
      status_lead: { [Op.ne]: 'descartado' },
      ...buildMetricsScopeWhere(scope, { clinicField: 'clinica_id', groupField: 'grupo_clinica_id' })
    },
    raw: true
  });

  const metricsIndex = new Map();

  for (const row of rows) {
    const provider = resolveLeadProvider(row);
    if (!provider) {
      continue;
    }

    const matchedCampaigns = new Set();
    const tokens = [
      normalizeLookupToken(row?.utm_campaign),
      normalizeLookupToken(row?.source_detail)
    ].filter(Boolean);

    for (const token of tokens) {
      const aliasKey = `${provider}:${token}`;
      const campaignKeys = aliasIndex.get(aliasKey);
      if (!campaignKeys || campaignKeys.size !== 1) {
        continue;
      }
      for (const campaignKey of campaignKeys) {
        matchedCampaigns.add(campaignKey);
      }
    }

    if (matchedCampaigns.size !== 1) {
      continue;
    }

    const [campaignKey] = Array.from(matchedCampaigns);
    const current = metricsIndex.get(campaignKey) || {
      leads: 0,
      crm_conversions: 0
    };

    current.leads += 1;
    if (String(row?.status_lead || '').trim().toLowerCase() === 'convertido') {
      current.crm_conversions += 1;
    }

    metricsIndex.set(campaignKey, current);
  }

  return metricsIndex;
}

function buildTargetSummaries(externalTargets, targetDestinations, leadMetricsIndex = new Map()) {
  const targets = normalizeExternalTargets(externalTargets);
  const destinations = normalizeTargetDestinations(targetDestinations);
  const destinationMap = new Map(
    destinations.map((item) => [
      `${item.kind}:${item.treatment_id || 'generic'}`,
      item
    ])
  );

  return targets.map((target) => {
    const key = `${target.kind}:${target.treatment_id || 'generic'}`;
    const destination = destinationMap.get(key) || null;
    const providerSet = new Set();
    const destinationKinds = new Set();
    let investment = 0;
    let leads = 0;
    let channelConversions = 0;
    let crmConversions = 0;

    for (const campaign of target.campaigns) {
      providerSet.add(campaign.provider);
      const detectedKind = String(campaign?.destination_detection?.kind || '').trim().toLowerCase();
      if (detectedKind === 'web' || detectedKind === 'lead_form') {
        destinationKinds.add(detectedKind);
      }
      investment += safeNumber(campaign?.metrics?.spend);
      channelConversions += safeNumber(campaign?.metrics?.conversions);

      const leadMetrics = leadMetricsIndex instanceof Map
        ? leadMetricsIndex.get(externalCampaignIdentityKey(campaign))
        : null;
      if (leadMetrics) {
        leads += safeNumber(leadMetrics.leads);
        crmConversions += safeNumber(leadMetrics.crm_conversions);
      }
    }

    let destinationKind = 'unknown';
    if (destinationKinds.has('web') && destinationKinds.has('lead_form')) {
      destinationKind = 'mixed';
    } else if (destinationKinds.has('web')) {
      destinationKind = 'web';
    } else if (destinationKinds.has('lead_form')) {
      destinationKind = 'lead_form';
    } else if (destination?.uses_web === true) {
      destinationKind = 'web';
    } else if (destination?.uses_web === false) {
      destinationKind = 'lead_form';
    }

    return {
      kind: target.kind,
      treatment_id: target.treatment_id || null,
      treatment_name: target.treatment_name || null,
      campaign_count: target.campaigns.length,
      providers: Array.from(providerSet),
      destination_kind: destinationKind,
      destination_url: destination?.confirmed_url || null,
      metrics: {
        investment: Number(investment.toFixed(2)),
        leads,
        channel_conversions: channelConversions,
        crm_conversions: crmConversions,
        patients_converted: crmConversions > 0 ? crmConversions : channelConversions
      }
    };
  });
}

function serializeStrategyCatalogItem(item) {
  const data = item?.toJSON ? item.toJSON() : item;
  const treatment = data?.treatment || null;

  return {
    id: String(data.id),
    display_name: data.display_name,
    objective_id: data.objective_id,
    promotion_kind: data.promotion_kind,
    treatment_id: data.treatment_id ? Number(data.treatment_id) : null,
    area_medica: data.area_medica || null,
    family_key: data.family_key || null,
    status: data.status,
    channels_supported: Array.isArray(data.channels_supported) ? data.channels_supported : [],
    channels_default: Array.isArray(data.channels_default) ? data.channels_default : [],
    recommended_budget_min: data.recommended_budget_min ?? null,
    recommended_budget_max: data.recommended_budget_max ?? null,
    destination_policy: data.destination_policy || null,
    measurement_profile: data.measurement_profile || null,
    automation_strategy: data.automation_strategy || null,
    treatment: treatment
      ? {
          id_tratamiento: Number(treatment.id_tratamiento),
          nombre: treatment.nombre,
          codigo: treatment.codigo || null,
          area_medica: treatment.disciplina || null,
          categoria: treatment.categoria || null
        }
      : null
  };
}

function asPositiveNumber(rawValue) {
  const value = Number(rawValue);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function asNullableNumber(rawValue) {
  if (rawValue === null || rawValue === undefined || rawValue === '') {
    return null;
  }
  const value = Number(rawValue);
  return Number.isFinite(value) ? value : null;
}

async function ensureGoogleAccessToken(conn, { allowExpired = false } = {}) {
  if (!conn) {
    const err = new Error('No existe conexión Google para este usuario');
    err.code = 'NO_CONNECTION';
    throw err;
  }
  if (!conn.accessToken) {
    const err = new Error('No existe access token de Google almacenado');
    err.code = 'NO_TOKEN';
    throw err;
  }

  let accessToken = conn.accessToken;
  let expiresAt = conn.expiresAt ? new Date(conn.expiresAt) : null;
  const now = Date.now();
  const refreshThreshold = now + 60_000;

  const shouldRefresh = conn.refreshToken && (!expiresAt || expiresAt.getTime() <= refreshThreshold);
  if (shouldRefresh) {
    try {
      const refreshResp = await axios.post(
        'https://oauth2.googleapis.com/token',
        new URLSearchParams({
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          grant_type: 'refresh_token',
          refresh_token: conn.refreshToken
        }).toString(),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
      );
      const nextToken = refreshResp.data?.access_token;
      const expiresIn = refreshResp.data?.expires_in || 3600;
      if (nextToken) {
        accessToken = nextToken;
        expiresAt = new Date(Date.now() + expiresIn * 1000);
        await conn.update({ accessToken, expiresAt });
      }
    } catch (refreshErr) {
      if (!allowExpired) {
        const err = new Error(refreshErr.response?.data?.error_description || refreshErr.message || 'No se pudo refrescar el token');
        err.code = 'REFRESH_FAILED';
        throw err;
      }
    }
  }

  const isExpired = expiresAt ? expiresAt.getTime() <= now : false;
  if (isExpired && !allowExpired) {
    const err = new Error('El token de Google ha expirado');
    err.code = 'TOKEN_EXPIRED';
    throw err;
  }

  return { accessToken, expiresAt, expired: isExpired };
}

async function ensureGoogleAdsAccess(conn) {
  if (!hasScopeText(conn?.scopes || '', GOOGLE_ADS_SCOPE)) {
    const err = new Error('La conexión Google no tiene permisos de Google Ads');
    err.code = 'INSUFFICIENT_SCOPE';
    throw err;
  }
  ensureGoogleAdsConfig();
  return ensureGoogleAccessToken(conn);
}

async function resolveScopeFromInput({ clinicIdRaw, groupIdRaw, assignmentScopeRaw }) {
  const clinicId = parseInteger(clinicIdRaw);
  let groupId = parseInteger(groupIdRaw);
  const assignmentScope = String(assignmentScopeRaw || '').trim().toLowerCase();

  if (!clinicId && !groupId) {
    const err = new Error('clinic_id o group_id es obligatorio');
    err.httpStatus = 400;
    throw err;
  }

  if (assignmentScope === 'group' && !groupId && clinicId) {
    const clinic = await Clinica.findOne({
      where: { id_clinica: clinicId },
      attributes: ['id_clinica', 'grupoClinicaId'],
      raw: true
    });
    if (!clinic) {
      const err = new Error('Clínica no encontrada');
      err.httpStatus = 404;
      throw err;
    }
    groupId = clinic.grupoClinicaId || null;
  }

  if (groupId) {
    const group = await GrupoClinica.findByPk(groupId, {
      attributes: ['id_grupo', 'nombre_grupo', 'ads_assignment_mode', 'web_assignment_mode', 'web_primary_url'],
      raw: true
    });
    if (!group) {
      const err = new Error('Grupo no encontrado');
      err.httpStatus = 404;
      throw err;
    }
    const clinics = await Clinica.findAll({
      where: { grupoClinicaId: groupId },
      attributes: ['id_clinica', 'nombre_clinica', 'url_web'],
      order: [['nombre_clinica', 'ASC']],
      raw: true
    });
    return {
      assignment_scope: 'group',
      clinic_id: clinicId || null,
      group_id: groupId,
      clinics,
      clinic_ids: clinics.map((c) => c.id_clinica).filter(Boolean),
      group
    };
  }

  const clinic = await Clinica.findOne({
    where: { id_clinica: clinicId },
    attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId', 'url_web'],
    raw: true
  });
  if (!clinic) {
    const err = new Error('Clínica no encontrada');
    err.httpStatus = 404;
    throw err;
  }

  let group = null;
  if (clinic.grupoClinicaId) {
    group = await GrupoClinica.findByPk(clinic.grupoClinicaId, {
      attributes: ['id_grupo', 'nombre_grupo', 'ads_assignment_mode', 'web_assignment_mode', 'web_primary_url'],
      raw: true
    });
  }

  return {
    assignment_scope: 'clinic',
    clinic_id: clinic.id_clinica,
    group_id: clinic.grupoClinicaId || null,
    clinics: [clinic],
    clinic_ids: [clinic.id_clinica],
    group
  };
}

function buildScopeWhere(scope) {
  if (!scope || typeof scope !== 'object') return {};
  if (scope.assignment_scope === 'group') {
    if (!scope.group_id) return {};
    if (scope.clinic_ids.length > 0) {
      return {
        [Op.or]: [
          { grupoClinicaId: scope.group_id },
          { clinicaId: { [Op.in]: scope.clinic_ids } }
        ]
      };
    }
    return { grupoClinicaId: scope.group_id };
  }

  if (!scope.clinic_id && !scope.group_id) return {};
  if (!scope.clinic_id && scope.group_id) {
    return {
      grupoClinicaId: scope.group_id,
      assignmentScope: 'group'
    };
  }

  const or = [{ clinicaId: scope.clinic_id }];
  if (scope.group_id) {
    or.push({
      grupoClinicaId: scope.group_id,
      assignmentScope: 'group'
    });
  }
  return { [Op.or]: or };
}

function buildMetricsScopeWhere(scope, { clinicField, groupField }) {
  if (!scope || typeof scope !== 'object') return {};

  if (scope.assignment_scope === 'group') {
    const or = [];
    if (scope.group_id) {
      or.push({ [groupField]: scope.group_id });
    }
    if (Array.isArray(scope.clinic_ids) && scope.clinic_ids.length > 0) {
      or.push({ [clinicField]: { [Op.in]: scope.clinic_ids } });
    }
    return or.length > 0 ? { [Op.or]: or } : {};
  }

  const or = [];
  if (scope.clinic_id) {
    or.push({ [clinicField]: scope.clinic_id });
  }
  if (scope.group_id) {
    or.push({
      [groupField]: scope.group_id,
      [clinicField]: { [Op.is]: null }
    });
  }
  return or.length > 0 ? { [Op.or]: or } : {};
}

function isGoogleCampaignActive(status) {
  const normalized = String(status || '').trim().toUpperCase();
  if (!normalized) return true;
  return normalized === 'ENABLED' || normalized === 'ACTIVE';
}

function isMetaCampaignActive(status) {
  const normalized = String(status || '').trim().toUpperCase();
  if (!normalized) return true;
  return normalized === 'ACTIVE';
}

function reduceExternalCampaignRows(rows, {
  provider,
  idKey,
  accountKey,
  nameKey,
  statusKey,
  extraMapper
}) {
  const byCampaign = new Map();

  for (const row of rows) {
    const accountId = String(row?.[accountKey] || '').trim();
    const campaignId = String(row?.[idKey] || '').trim();
    if (!accountId || !campaignId) continue;

    const mapKey = `${accountId}:${campaignId}`;
    if (!byCampaign.has(mapKey)) {
      byCampaign.set(mapKey, {
        provider,
        account_id: accountId,
        external_campaign_id: campaignId,
        name: row?.[nameKey] || null,
        status: row?.[statusKey] || null,
        clinic_ids: new Set(),
        group_ids: new Set(),
        metrics: {
          impressions: 0,
          clicks: 0,
          spend: 0,
          conversions: 0
        },
        last_seen_at: null,
        ...((typeof extraMapper === 'function' ? extraMapper(row) : {}) || {})
      });
    }

    const item = byCampaign.get(mapKey);
    if (row?.clinicaId || row?.clinica_id) {
      item.clinic_ids.add(Number(row.clinicaId || row.clinica_id));
    }
    if (row?.grupoClinicaId || row?.grupo_clinica_id) {
      item.group_ids.add(Number(row.grupoClinicaId || row.grupo_clinica_id));
    }

    item.metrics.impressions += safeNumber(row.impressions);
    item.metrics.clicks += safeNumber(row.clicks);
    item.metrics.spend += safeNumber(row.spend);
    item.metrics.conversions += safeNumber(row.conversions);

    const lastSeen = row?.last_seen_at || row?.lastSeenAt || null;
    if (lastSeen && (!item.last_seen_at || String(lastSeen) > String(item.last_seen_at))) {
      item.last_seen_at = lastSeen;
    }
  }

  return Array.from(byCampaign.values()).map((item) => ({
    ...item,
    clinic_ids: Array.from(item.clinic_ids.values()).filter(Number.isFinite),
    group_ids: Array.from(item.group_ids.values()).filter(Number.isFinite),
    assignment_origin: (() => {
      const clinicIds = Array.from(item.clinic_ids.values()).filter(Number.isFinite);
      const groupIds = Array.from(item.group_ids.values()).filter(Number.isFinite);
      return groupIds.length > 0 && clinicIds.length === 0
        ? 'group'
        : clinicIds.length > 0
          ? 'clinic'
          : 'unknown';
    })(),
    metrics: {
      ...item.metrics,
      spend: Number(item.metrics.spend.toFixed(2))
    }
  }));
}

function createUnknownDestinationDetection(reason = 'unknown') {
  return {
    kind: 'unknown',
    confidence: 'low',
    reason,
    urls: [],
    instant_form: null,
    creative_preview: null
  };
}

function createWebDestinationDetection(reason = 'web', confidence = 'medium', urls = []) {
  return {
    kind: 'web',
    confidence,
    reason,
    urls: Array.isArray(urls) ? urls.filter(Boolean) : [],
    instant_form: null,
    creative_preview: null
  };
}

function createMetaLeadFormDetection(reason = 'meta_lead_form_detected') {
  return {
    kind: 'lead_form',
    confidence: 'medium',
    reason,
    urls: [],
    instant_form: {
      id: null,
      name: null,
      preview_available: false,
      preview_summary: 'Formulario instantáneo detectado por señales de rendimiento sincronizadas.'
    },
    creative_preview: null
  };
}

function createMetaCreativePreview({
  adId = null,
  adName = null,
  title = null,
  body = null,
  mediaUrl = null,
  permalinkUrl = null,
  ctaType = null
} = {}) {
  const previewSummary = [title, body].filter(Boolean).join(' · ').slice(0, 280) || null;
  return {
    available: Boolean(title || body || mediaUrl || permalinkUrl),
    ad_id: adId || null,
    ad_name: adName || null,
    title: title || null,
    body: body || null,
    media_url: mediaUrl || null,
    permalink_url: permalinkUrl || null,
    cta_type: ctaType || null,
    preview_summary: previewSummary
  };
}

function normalizeMetaUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return null;
  if (/^https?:\/\/fb\.me\/?$/i.test(value)) return null;
  if (/^https?:\/\/l\.facebook\.com\//i.test(value)) return value;
  if (/^https?:\/\//i.test(value)) return value;
  return null;
}

function sanitizeCreativeCopy(rawValue) {
  const value = String(rawValue || '')
    .replace(/\{\{[^}]+\}\}/g, ' ')
    .replace(/\b\d{4}-\d{2}-\d{2}-[a-f0-9]{24,}\b/gi, ' ')
    .replace(/\b[a-f0-9]{24,}\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return value || null;
}

function pickMetaCreativeFields(creative = {}) {
  const objectStorySpec = creative.object_story_spec && typeof creative.object_story_spec === 'object'
    ? creative.object_story_spec
    : {};
  const linkData = objectStorySpec.link_data && typeof objectStorySpec.link_data === 'object'
    ? objectStorySpec.link_data
    : {};
  const videoData = objectStorySpec.video_data && typeof objectStorySpec.video_data === 'object'
    ? objectStorySpec.video_data
    : {};
  const templateData = objectStorySpec.template_data && typeof objectStorySpec.template_data === 'object'
    ? objectStorySpec.template_data
    : {};

  const linkUrl = normalizeMetaUrl(
    linkData.link
    || templateData.link
    || videoData.call_to_action?.value?.link
    || linkData.call_to_action?.value?.link
    || templateData.call_to_action?.value?.link
    || creative.link_url
    || null
  );

  const leadFormId = String(
    videoData.call_to_action?.value?.lead_gen_form_id
    || linkData.call_to_action?.value?.lead_gen_form_id
    || templateData.call_to_action?.value?.lead_gen_form_id
    || ''
  ).trim() || null;

  const videoId = String(
    videoData.video_id
    || templateData.video_id
    || ''
  ).trim() || null;

  const title = sanitizeCreativeCopy(videoData.title || linkData.name || templateData.name || creative.name || null);
  const body = sanitizeCreativeCopy(videoData.message || linkData.message || templateData.message || null);
  const mediaUrl = videoData.image_url || linkData.picture || templateData.picture || creative.image_url || creative.thumbnail_url || null;
  const permalinkUrl = creative.instagram_permalink_url || null;
  const ctaType = videoData.call_to_action?.type
    || linkData.call_to_action?.type
    || templateData.call_to_action?.type
    || creative.call_to_action_type
    || null;

  return {
    linkUrl,
    leadFormId,
    videoId,
    preview: createMetaCreativePreview({
      title,
      body,
      mediaUrl,
      permalinkUrl,
      ctaType
    })
  };
}

async function fetchMetaLeadFormDetails({ formId, accessToken }) {
  if (!formId || !accessToken) return null;
  try {
    const resp = await metaGet(String(formId), {
      params: {
        fields: 'id,name,status,locale,follow_up_action_url,context_card,questions,privacy_policy_url'
      },
      accessToken,
      timeout: 15000
    });
    const data = resp.data || {};
    const contextTitle = String(data.context_card?.title || '').trim();
    const firstContextLine = Array.isArray(data.context_card?.content)
      ? String(data.context_card.content.find(Boolean) || '').trim()
      : '';
    const previewSummary = [contextTitle, firstContextLine].filter(Boolean).join(' · ').slice(0, 280) || null;
    return {
      id: String(data.id || formId),
      name: data.name || null,
      status: data.status || null,
      locale: data.locale || null,
      follow_up_action_url: normalizeMetaUrl(data.follow_up_action_url || null),
      preview_available: Boolean(contextTitle || firstContextLine || Array.isArray(data.questions) && data.questions.length > 0),
      preview_summary: previewSummary,
      questions_preview: Array.isArray(data.questions)
        ? data.questions.slice(0, 4).map((question) => ({
            key: question?.key || null,
            label: question?.label || null,
            type: question?.type || null
          }))
        : []
    };
  } catch (err) {
    return {
      id: String(formId),
      name: null,
      status: null,
      locale: null,
      follow_up_action_url: null,
      preview_available: false,
      preview_summary: 'Formulario instantáneo detectado, pero no se pudo recuperar su ficha en Meta.',
      questions_preview: []
    };
  }
}

async function fetchMetaVideoMediaUrl({ videoId, accessToken, videoCache }) {
  const normalizedVideoId = String(videoId || '').trim();
  if (!normalizedVideoId || !accessToken) {
    return null;
  }
  if (videoCache?.has(normalizedVideoId)) {
    return videoCache.get(normalizedVideoId);
  }

  let resolved = null;
  try {
    const resp = await metaGet(normalizedVideoId, {
      params: {
        fields: 'id,source,picture,thumbnails'
      },
      accessToken,
      timeout: 15000
    });
    const data = resp.data || {};
    resolved = String(
      data.source
      || data.thumbnails?.data?.find((item) => item?.uri)?.uri
      || data.picture
      || ''
    ).trim() || null;
  } catch (_err) {
    resolved = null;
  }

  if (videoCache) {
    videoCache.set(normalizedVideoId, resolved);
  }
  return resolved;
}

async function fetchMetaInstagramMediaPreview({ mediaId, accessToken, mediaCache }) {
  const normalizedMediaId = String(mediaId || '').trim();
  if (!normalizedMediaId || !accessToken) {
    return null;
  }
  if (mediaCache?.has(normalizedMediaId)) {
    return mediaCache.get(normalizedMediaId);
  }

  let resolved = null;
  try {
    const resp = await metaGet(normalizedMediaId, {
      params: {
        fields: 'id,media_type,media_url,thumbnail_url,permalink,caption'
      },
      accessToken,
      timeout: 15000
    });
    const data = resp.data || {};
    resolved = {
      mediaUrl: String(data.media_url || '').trim() || null,
      thumbnailUrl: String(data.thumbnail_url || '').trim() || null,
      permalinkUrl: String(data.permalink || '').trim() || null,
      text: sanitizeCreativeCopy(data.caption || null)
    };
  } catch (_err) {
    resolved = null;
  }

  if (mediaCache) {
    mediaCache.set(normalizedMediaId, resolved);
  }
  return resolved;
}

async function fetchMetaStoryPreview({ storyId, accessToken, storyCache }) {
  const normalizedStoryId = String(storyId || '').trim();
  if (!normalizedStoryId || !accessToken) {
    return null;
  }
  if (storyCache?.has(normalizedStoryId)) {
    return storyCache.get(normalizedStoryId);
  }

  let resolved = null;
  try {
    const resp = await metaGet(normalizedStoryId, {
      params: {
        fields: 'id,message,permalink_url,full_picture,attachments{media,target,url,unshimmed_url,title,description}'
      },
      accessToken,
      timeout: 15000
    });
    const data = resp.data || {};
    const attachment = Array.isArray(data.attachments?.data) ? data.attachments.data[0] : null;
    const mediaImage = attachment?.media?.image?.src || attachment?.media?.image?.uri || null;
    resolved = {
      mediaUrl: String(data.full_picture || mediaImage || '').trim() || null,
      thumbnailUrl: String(mediaImage || data.full_picture || '').trim() || null,
      permalinkUrl: String(data.permalink_url || attachment?.url || attachment?.unshimmed_url || '').trim() || null,
      text: sanitizeCreativeCopy(data.message || attachment?.description || attachment?.title || null)
    };
  } catch (_err) {
    resolved = null;
  }

  if (storyCache) {
    storyCache.set(normalizedStoryId, resolved);
  }
  return resolved;
}

async function buildMetaAdPreviewFromCreative({
  adRow,
  creative,
  accessToken,
  formCache,
  videoCache,
  mediaCache,
  storyCache
}) {
  const extracted = pickMetaCreativeFields(creative);
  const preview = {
    ...extracted.preview,
    ad_id: String(adRow?.id || '').trim() || null,
    ad_name: adRow?.name || null
  };

  let creativeImageUrl = preview.media_url || null;
  let thumbnailUrl = preview.media_url || null;
  let creativeText = preview.body || preview.preview_summary || preview.title || null;
  let previewPermalinkUrl = preview.permalink_url || null;

  const instagramMediaPreview = creative?.effective_instagram_media_id
    ? await fetchMetaInstagramMediaPreview({
        mediaId: creative.effective_instagram_media_id,
        accessToken,
        mediaCache
      })
    : null;
  if (instagramMediaPreview) {
    creativeImageUrl = instagramMediaPreview.mediaUrl || creativeImageUrl;
    thumbnailUrl = instagramMediaPreview.thumbnailUrl || thumbnailUrl;
    creativeText = instagramMediaPreview.text || creativeText;
    previewPermalinkUrl = instagramMediaPreview.permalinkUrl || previewPermalinkUrl;
  }

  const storyPreview = !instagramMediaPreview && creative?.effective_object_story_id
    ? await fetchMetaStoryPreview({
        storyId: creative.effective_object_story_id,
        accessToken,
        storyCache
      })
    : null;
  if (storyPreview) {
    creativeImageUrl = storyPreview.mediaUrl || creativeImageUrl;
    thumbnailUrl = storyPreview.thumbnailUrl || thumbnailUrl;
    creativeText = storyPreview.text || creativeText;
    previewPermalinkUrl = storyPreview.permalinkUrl || previewPermalinkUrl;
  }

  if (extracted.videoId) {
    const videoMediaUrl = await fetchMetaVideoMediaUrl({
      videoId: extracted.videoId,
      accessToken,
      videoCache
    });
    if (videoMediaUrl) {
      creativeImageUrl = videoMediaUrl;
    }
  }

  let instantForm = null;
  if (extracted.leadFormId) {
    if (!formCache.has(extracted.leadFormId)) {
      formCache.set(extracted.leadFormId, await fetchMetaLeadFormDetails({ formId: extracted.leadFormId, accessToken }));
    }
    instantForm = formCache.get(extracted.leadFormId) || null;
  }

  return {
    adName: adRow?.name || null,
    statusText: String(adRow?.effective_status || adRow?.status || '').trim() || null,
    thumbnailUrl: thumbnailUrl || creativeImageUrl || null,
    creativeImageUrl: creativeImageUrl || null,
    creativeText: creativeText || null,
    creativeCta: preview.cta_type || null,
    creativeDestinationUrl: extracted.linkUrl || instantForm?.follow_up_action_url || previewPermalinkUrl || null,
    instantFormName: instantForm?.name || null,
    instantFormQuestions: Array.isArray(instantForm?.questions_preview) ? instantForm.questions_preview : [],
    followUpUrl: instantForm?.follow_up_action_url || null
  };
}

async function fetchMetaAnalysisAdPreviews({ campaignId, adIds, accessToken }) {
  const normalizedCampaignId = String(campaignId || '').trim();
  const previewTargetIds = (Array.isArray(adIds) ? adIds : [])
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .slice(0, 12);
  const targetIds = new Set(previewTargetIds);
  const byAdId = new Map();
  const byAdsetId = new Map();
  if (!normalizedCampaignId || !targetIds.size || !accessToken) {
    return { byAdId, byAdsetId };
  }

  const formCache = new Map();
  const videoCache = new Map();
  const mediaCache = new Map();
  const storyCache = new Map();
  try {
    const resp = await metaGet(`${normalizedCampaignId}/ads`, {
      params: {
        fields: 'id,name,adset_id,status,effective_status,creative{id,name,effective_instagram_media_id,effective_object_story_id,instagram_permalink_url,object_story_spec,object_type,thumbnail_url,image_url,link_url,call_to_action_type}',
        limit: Math.min(Math.max(targetIds.size, 12), 50)
      },
      accessToken,
      timeout: 15000
    });
    const payload = resp.data || {};
    const rows = Array.isArray(payload.data) ? payload.data : [];
    for (const adRow of rows) {
      const adId = String(adRow?.id || '').trim();
      const creative = adRow?.creative && typeof adRow.creative === 'object'
        ? adRow.creative
        : {};
      const preview = await buildMetaAdPreviewFromCreative({
        adRow,
        creative,
        accessToken,
        formCache,
        videoCache,
        mediaCache,
        storyCache
      });
      const adsetId = String(adRow?.adset_id || '').trim();
      if (adId && targetIds.has(adId) && !byAdId.has(adId)) {
        byAdId.set(adId, preview);
      }
      if (adsetId && !byAdsetId.has(adsetId)) {
        byAdsetId.set(adsetId, preview);
      }
    }
  } catch (_err) {
    return { byAdId, byAdsetId };
  }

  return { byAdId, byAdsetId };
}

async function fetchMetaAnalysisAdMetricsLive({ campaignId, timeframe, accessToken }) {
  const normalizedCampaignId = String(campaignId || '').trim();
  if (!normalizedCampaignId || !accessToken || !timeframe?.start || !timeframe?.end) {
    return { byAdId: new Map(), byAdsetId: new Map() };
  }

  const byAdId = new Map();
  const rawByAdsetId = new Map();
  try {
    const resp = await metaGet(`${normalizedCampaignId}/insights`, {
      params: {
        level: 'ad',
        fields: 'ad_id,ad_name,adset_id,adset_name,impressions,clicks,spend,actions',
        time_range: JSON.stringify({
          since: formatDate(timeframe.start),
          until: formatDate(timeframe.end)
        }),
        limit: 100
      },
      accessToken,
      timeout: 15000
    });
    const rows = Array.isArray(resp.data?.data) ? resp.data.data : [];
    for (const row of rows) {
      const adId = String(row?.ad_id || '').trim();
      const adsetId = String(row?.adset_id || '').trim();
      const actionTotals = summarizeMetaCampaignActions(Array.isArray(row?.actions)
        ? row.actions.map((action) => ({
            action_type: action?.action_type,
            value: action?.value
          }))
        : []);
      const metric = {
        name: String(row?.ad_name || '').trim() || null,
        spend: safeNumber(row?.spend),
        leads: resolveMetaLeadTotalFromActionTotals(actionTotals),
        impressions: safeNumber(row?.impressions),
        clicks: safeNumber(row?.clicks)
      };
      if (adId && !byAdId.has(adId)) {
        byAdId.set(adId, metric);
      }
      if (adsetId) {
        if (!rawByAdsetId.has(adsetId)) {
          rawByAdsetId.set(adsetId, []);
        }
        rawByAdsetId.get(adsetId).push(metric);
      }
    }
  } catch (_err) {
    return { byAdId: new Map(), byAdsetId: new Map() };
  }

  const byAdsetId = new Map();
  for (const [adsetId, metrics] of rawByAdsetId.entries()) {
    const rows = Array.isArray(metrics) ? metrics : [];
    const total = rows.reduce((acc, metric) => {
      acc.spend += safeNumber(metric.spend);
      acc.leads += safeNumber(metric.leads);
      acc.impressions += safeNumber(metric.impressions);
      acc.clicks += safeNumber(metric.clicks);
      acc.count += 1;
      return acc;
    }, { spend: 0, leads: 0, impressions: 0, clicks: 0, count: 0 });
    byAdsetId.set(adsetId, total);
  }

  return { byAdId, byAdsetId };
}

async function enrichMetaCampaignDetections({
  campaigns,
  accessToken,
  campaignAdRows
}) {
  if (!Array.isArray(campaigns) || !campaigns.length || !accessToken) {
    return campaigns || [];
  }

  const formCache = new Map();
  const enriched = [];

  for (const campaign of campaigns) {
    const adRows = Array.isArray(campaignAdRows.get(String(campaign.external_campaign_id || '').trim()))
      ? campaignAdRows.get(String(campaign.external_campaign_id || '').trim())
      : [];
    const limit = Math.max(1, Math.min(adRows.length || 1, 10));
    if (!limit) {
      enriched.push(campaign);
      continue;
    }

    try {
      const adsResp = await metaGet(`${String(campaign.external_campaign_id || '').trim()}/ads`, {
        params: {
          fields: 'id,name,creative{id,name,effective_instagram_media_id,effective_object_story_id,instagram_permalink_url,object_story_spec,object_type,thumbnail_url,image_url,link_url,call_to_action_type}',
          limit
        },
        accessToken,
        timeout: 15000
      });
      const candidateAds = Array.isArray(adsResp.data?.data) ? adsResp.data.data : [];
      if (!candidateAds.length) {
        enriched.push(campaign);
        continue;
      }

      let destinationDetection = campaign.destination_detection || createUnknownDestinationDetection('meta_not_enough_data');
      let detectedWebUrl = null;
      let detectedLeadForm = null;
      let detectedPreview = null;
      let hasWeb = false;
      let hasLeadForm = false;

      for (const adRow of candidateAds) {
        const creative = adRow?.creative || {};
        const extracted = pickMetaCreativeFields(creative);
        extracted.preview.ad_id = String(adRow?.id || '');
        extracted.preview.ad_name = adRow?.name || null;

        if (!detectedPreview && extracted.preview?.available) {
          detectedPreview = extracted.preview;
        }

        if (extracted.linkUrl) {
          hasWeb = true;
          if (!detectedWebUrl) {
            detectedWebUrl = extracted.linkUrl;
          }
        }

        if (extracted.leadFormId) {
          hasLeadForm = true;
          if (!formCache.has(extracted.leadFormId)) {
            formCache.set(extracted.leadFormId, await fetchMetaLeadFormDetails({ formId: extracted.leadFormId, accessToken }));
          }
          if (!detectedLeadForm) {
            detectedLeadForm = formCache.get(extracted.leadFormId);
          }
        }

        if ((hasWeb && hasLeadForm) || (hasWeb && detectedPreview) || (hasLeadForm && detectedLeadForm && detectedPreview)) {
          // Ya tenemos suficiente señal para clasificar o marcar mezcla.
          if (hasWeb && hasLeadForm) break;
        }
      }

      if (hasWeb && hasLeadForm) {
        destinationDetection = {
          kind: 'unknown',
          confidence: 'medium',
          reason: 'meta_mixed_destinations_detected',
          urls: detectedWebUrl ? [detectedWebUrl] : [],
          instant_form: detectedLeadForm,
          creative_preview: detectedPreview
        };
      } else if (hasLeadForm) {
        destinationDetection = {
          kind: 'lead_form',
          confidence: 'high',
          reason: 'meta_lead_form_creative_detected',
          urls: [],
          instant_form: detectedLeadForm,
          creative_preview: detectedPreview
        };
      } else if (hasWeb) {
        destinationDetection = {
          kind: 'web',
          confidence: 'high',
          reason: 'meta_destination_url_detected',
          urls: detectedWebUrl ? [detectedWebUrl] : [],
          instant_form: null,
          creative_preview: detectedPreview
        };
      } else if (detectedPreview) {
        destinationDetection = {
          ...destinationDetection,
          creative_preview: detectedPreview
        };
      }

      enriched.push({
        ...campaign,
        destination_detection: destinationDetection
      });
    } catch (err) {
      enriched.push(campaign);
    }
  }

  return enriched;
}

function summarizeMetaCampaignActions(actionRows) {
  const totals = {};
  for (const row of actionRows || []) {
    const actionType = String(row?.action_type || '').trim();
    if (!actionType) continue;
    totals[actionType] = (totals[actionType] || 0) + safeNumber(row.value);
  }
  return totals;
}

function inferMetaDestinationDetection({ actionTotals }) {
  const totals = actionTotals && typeof actionTotals === 'object' ? actionTotals : {};
  const linkClicks = safeNumber(totals.link_click);
  const leadFormSignals = safeNumber(totals['onsite_conversion.lead_form'])
    + safeNumber(totals['leadgen.other'])
    + safeNumber(totals['onsite_conversion.lead_grouped']);

  if (linkClicks > 0) {
    return createWebDestinationDetection('meta_link_clicks_detected', 'high');
  }
  if (leadFormSignals > 0) {
    return createMetaLeadFormDetection('meta_lead_form_actions_detected');
  }
  return createUnknownDestinationDetection('meta_not_enough_data');
}

async function rollupMetaAdActionRowsToCampaignSignals(actionRows, campaignEntitiesById) {
  if (!Array.isArray(actionRows) || actionRows.length === 0) return [];

  const byAdId = new Map();
  for (const row of actionRows) {
    const entityId = String(row?.entity_id || '').trim();
    if (!entityId) continue;
    if (!byAdId.has(entityId)) {
      byAdId.set(entityId, []);
    }
    byAdId.get(entityId).push(row);
  }

  const adIds = Array.from(byAdId.keys());
  if (!adIds.length) return [];

  const adEntities = await SocialAdsEntity.findAll({
    where: {
      level: 'ad',
      entity_id: { [Op.in]: adIds }
    },
    raw: true
  });
  const adEntityMap = new Map(adEntities.map((row) => [String(row.entity_id), row]));

  const adsetIds = Array.from(new Set(adEntities
    .map((row) => String(row.parent_id || '').trim())
    .filter(Boolean)));
  if (!adsetIds.length) return [];

  const adsetEntities = await SocialAdsEntity.findAll({
    where: {
      level: 'adset',
      entity_id: { [Op.in]: adsetIds }
    },
    raw: true
  });
  const adsetEntityMap = new Map(adsetEntities.map((row) => [String(row.entity_id), row]));

  const rolledRows = [];
  for (const [adId, rows] of byAdId.entries()) {
    const adEntity = adEntityMap.get(adId);
    const adsetEntity = adEntity
      ? adsetEntityMap.get(String(adEntity.parent_id || '').trim())
      : null;
    const campaignId = String(adsetEntity?.parent_id || '').trim();
    if (!campaignId) continue;

    const campaignEntity = campaignEntitiesById.get(campaignId) || null;
    for (const row of rows) {
      rolledRows.push({
        ad_account_id: row.ad_account_id,
        entity_id: campaignId,
        clinica_id: row.clinica_id ?? null,
        grupo_clinica_id: row.grupo_clinica_id ?? null,
        action_type: row.action_type,
        value: row.value,
        campaignName: campaignEntity?.name || null,
        campaignStatus: campaignEntity?.effective_status || campaignEntity?.status || null,
        objective: campaignEntity?.objective || null
      });
    }
  }

  return rolledRows;
}

function rollupMetaAdRowsToCampaignRows(adRows, campaignEntitiesById) {
  if (!Array.isArray(adRows) || adRows.length === 0) return [];

  const byAdId = new Map();
  for (const row of adRows) {
    const entityId = String(row?.entity_id || '').trim();
    if (entityId) {
      byAdId.set(entityId, row);
    }
  }

  const adIds = Array.from(byAdId.keys());
  if (!adIds.length) return [];

  return SocialAdsEntity.findAll({
    where: {
      level: 'ad',
      entity_id: { [Op.in]: adIds }
    },
    raw: true
  }).then(async (adEntities) => {
    const adEntityMap = new Map(adEntities.map((row) => [String(row.entity_id), row]));
    const adsetIds = Array.from(new Set(adEntities
      .map((row) => String(row.parent_id || '').trim())
      .filter(Boolean)));
    if (!adsetIds.length) return [];

    const adsetEntities = await SocialAdsEntity.findAll({
      where: {
        level: 'adset',
        entity_id: { [Op.in]: adsetIds }
      },
      raw: true
    });
    const adsetEntityMap = new Map(adsetEntities.map((row) => [String(row.entity_id), row]));

    return adRows
      .map((row) => {
        const adEntity = adEntityMap.get(String(row.entity_id || '').trim());
        const adsetEntity = adEntity
          ? adsetEntityMap.get(String(adEntity.parent_id || '').trim())
          : null;
        const campaignId = String(adsetEntity?.parent_id || '').trim();
        if (!campaignId) return null;

        const campaignEntity = campaignEntitiesById.get(campaignId) || null;
        return {
          ad_account_id: row.ad_account_id,
          entity_id: campaignId,
          clinica_id: row.clinica_id ?? null,
          grupo_clinica_id: row.grupo_clinica_id ?? null,
          impressions: row.impressions ?? 0,
          clicks: row.clicks ?? 0,
          spend: row.spend ?? 0,
          conversions: row.conversions ?? 0,
          last_seen_at: row.last_seen_at || null,
          campaignName: campaignEntity?.name || null,
          campaignStatus: campaignEntity?.effective_status || campaignEntity?.status || null,
          objective: campaignEntity?.objective || null
        };
      })
      .filter(Boolean);
  });
}

async function loadIntakeRecordForScope(scope) {
  const where = scope.assignment_scope === 'group'
    ? { group_id: scope.group_id, assignment_scope: 'group' }
    : { clinic_id: scope.clinic_id };
  const record = await IntakeConfig.findOne({ where, raw: true });
  return record || null;
}

async function upsertCampaignSettingsForScope(scope, campaignPatch) {
  const where = scope.assignment_scope === 'group'
    ? { group_id: scope.group_id, assignment_scope: 'group' }
    : { clinic_id: scope.clinic_id };

  const existing = await IntakeConfig.findOne({ where });
  const patch = normalizeCampaignConfig(campaignPatch || {});

  if (!existing) {
    await IntakeConfig.create({
      clinic_id: scope.assignment_scope === 'clinic' ? scope.clinic_id : null,
      group_id: scope.assignment_scope === 'group' ? scope.group_id : null,
      assignment_scope: scope.assignment_scope,
      domains: [],
      config: { campaigns: patch },
      hmac_key: null
    });
    return patch;
  }

  const existingConfig = existing.config && typeof existing.config === 'object' ? existing.config : {};
  const currentCampaigns = normalizeCampaignConfig(existingConfig.campaigns || {});
  const nextCampaigns = {
    ...currentCampaigns,
    ...patch
  };

  await existing.update({
    config: {
      ...existingConfig,
      campaigns: nextCampaigns
    }
  });

  return nextCampaigns;
}

async function listClinicIdsForGroup(groupId) {
  if (!groupId) return [];
  const clinics = await Clinica.findAll({
    where: { grupoClinicaId: groupId },
    attributes: ['id_clinica'],
    raw: true
  });
  return clinics
    .map((clinic) => parseInteger(clinic.id_clinica))
    .filter((value) => Number.isInteger(value) && value > 0);
}

async function findLatestCampaignMode(where, matcher) {
  const rows = await CampaignRequest.findAll({
    where,
    attributes: ['id', 'clinica_id', 'solicitud', 'created_at'],
    order: [['created_at', 'DESC']],
    limit: 50,
    raw: true
  });

  for (const row of rows) {
    const payload = row?.solicitud && typeof row.solicitud === 'object' ? row.solicitud : {};
    if (payload.kind !== 'campaign_onboarding' || payload.status !== 'completed') {
      continue;
    }

    const mode = String(payload.mode || '').trim().toLowerCase();
    if (!VALID_MODES.has(mode)) {
      continue;
    }

    if (matcher(payload)) {
      return mode;
    }
  }

  return null;
}

async function resolveActiveModeForScope(scope) {
  if (!scope || typeof scope !== 'object') return null;

  if (scope.assignment_scope === 'clinic' && scope.clinic_id) {
    const clinicRecord = await loadIntakeRecordForScope({
      assignment_scope: 'clinic',
      clinic_id: scope.clinic_id
    });
    const clinicConfig = normalizeCampaignConfig(clinicRecord?.config?.campaigns || {});
    if (clinicConfig.active_mode) {
      return clinicConfig.active_mode;
    }

    if (scope.group_id) {
      const groupRecord = await loadIntakeRecordForScope({
        assignment_scope: 'group',
        group_id: scope.group_id
      });
      const groupConfig = normalizeCampaignConfig(groupRecord?.config?.campaigns || {});
      if (groupConfig.active_mode) {
        return groupConfig.active_mode;
      }
    }

    const clinicMode = await findLatestCampaignMode(
      { clinica_id: scope.clinic_id },
      (payload) => {
        const payloadScope = payload.scope && typeof payload.scope === 'object' ? payload.scope : {};
        return payloadScope.assignment_scope === 'clinic'
          && parseInteger(payloadScope.clinic_id) === scope.clinic_id;
      }
    );

    if (clinicMode) {
      return clinicMode;
    }

    if (scope.group_id) {
      const groupClinicIds = await listClinicIdsForGroup(scope.group_id);
      if (groupClinicIds.length > 0) {
        return findLatestCampaignMode(
          { clinica_id: { [Op.in]: groupClinicIds } },
          (payload) => {
            const payloadScope = payload.scope && typeof payload.scope === 'object' ? payload.scope : {};
            return payloadScope.assignment_scope === 'group'
              && parseInteger(payloadScope.group_id) === scope.group_id;
          }
        );
      }
    }

    return null;
  }

  if (scope.assignment_scope === 'group' && scope.group_id) {
    const groupRecord = await loadIntakeRecordForScope({
      assignment_scope: 'group',
      group_id: scope.group_id
    });
    const groupConfig = normalizeCampaignConfig(groupRecord?.config?.campaigns || {});
    if (groupConfig.active_mode) {
      return groupConfig.active_mode;
    }

    const groupClinicIds = Array.isArray(scope.clinic_ids) && scope.clinic_ids.length > 0
      ? scope.clinic_ids
      : await listClinicIdsForGroup(scope.group_id);

    if (groupClinicIds.length === 0) {
      return null;
    }

    return findLatestCampaignMode(
      { clinica_id: { [Op.in]: groupClinicIds } },
      (payload) => {
        const payloadScope = payload.scope && typeof payload.scope === 'object' ? payload.scope : {};
        return payloadScope.assignment_scope === 'group'
          && parseInteger(payloadScope.group_id) === scope.group_id;
      }
    );
  }

  return null;
}

async function upsertIntakeGoogleAdsForScope(scope, googleAdsPatch) {
  const where = scope.assignment_scope === 'group'
    ? { group_id: scope.group_id, assignment_scope: 'group' }
    : { clinic_id: scope.clinic_id };

  const existing = await IntakeConfig.findOne({ where });
  if (!existing) {
    await IntakeConfig.create({
      clinic_id: scope.assignment_scope === 'clinic' ? scope.clinic_id : null,
      group_id: scope.assignment_scope === 'group' ? scope.group_id : null,
      assignment_scope: scope.assignment_scope,
      domains: [],
      config: { google_ads: normalizeGoogleAdsConfig(googleAdsPatch) },
      hmac_key: null
    });
    return;
  }

  const existingConfig = existing.config && typeof existing.config === 'object' ? existing.config : {};
  const rawGooglePatch = googleAdsPatch && typeof googleAdsPatch === 'object' && !Array.isArray(googleAdsPatch)
    ? googleAdsPatch
    : {};
  const mergedGoogle = mergeEffectiveGoogleAdsConfig(existingConfig.google_ads || {}, rawGooglePatch);
  const nextConfig = {
    ...existingConfig,
    google_ads: mergedGoogle
  };
  await existing.update({ config: nextConfig });
}

async function upsertIntakeMetaAdsForScope(scope, metaAdsPatch) {
  const where = scope.assignment_scope === 'group'
    ? { group_id: scope.group_id, assignment_scope: 'group' }
    : { clinic_id: scope.clinic_id };

  const normalizedPatch = normalizeMetaAdsConfig(metaAdsPatch || {});
  const existing = await IntakeConfig.findOne({ where });
  if (!existing) {
    await IntakeConfig.create({
      clinic_id: scope.assignment_scope === 'clinic' ? scope.clinic_id : null,
      group_id: scope.assignment_scope === 'group' ? scope.group_id : null,
      assignment_scope: scope.assignment_scope,
      domains: [],
      config: { meta_ads: normalizedPatch },
      hmac_key: null
    });
    return normalizedPatch;
  }

  const existingConfig = existing.config && typeof existing.config === 'object' ? existing.config : {};
  const currentMeta = normalizeMetaAdsConfig(existingConfig.meta_ads || {});
  const mergedMeta = {
    ...currentMeta,
    ...normalizedPatch,
    enabled: normalizedPatch.enabled !== undefined ? normalizedPatch.enabled : currentMeta.enabled
  };

  await existing.update({
    config: {
      ...existingConfig,
      meta_ads: mergedMeta
    }
  });

  return mergedMeta;
}

function extractSendToFromTagSnippets(tagSnippets) {
  if (!Array.isArray(tagSnippets) || !tagSnippets.length) return null;
  const asText = JSON.stringify(tagSnippets);
  const match = asText.match(/AW-\d+\/[A-Za-z0-9\-_]+/);
  return match ? match[0] : null;
}

function mapConversionActionRow(row) {
  const conversion = row?.conversionAction || {};
  const id = conversion.id ? String(conversion.id) : null;
  const resourceName = conversion.resourceName || null;
  return {
    id,
    resource_name: resourceName,
    name: conversion.name || null,
    category: conversion.category || null,
    type: conversion.type || null,
    status: conversion.status || null,
    include_in_conversions_metric: conversion.includeInConversionsMetric !== false,
    primary_for_goal: conversion.primaryForGoal !== false,
    send_to: extractSendToFromTagSnippets(conversion.tagSnippets || [])
  };
}

function buildSuggestedMapping(actions) {
  const mapping = {
    lead: null,
    contact: null,
    schedule: null,
    purchase: null
  };

  for (const action of actions) {
    const name = String(action.name || '').toLowerCase();
    for (const key of VALID_EVENTS) {
      if (mapping[key]) continue;
      const detectTerms = EVENT_CATALOG[key].detect;
      if (detectTerms.some((term) => name.includes(term))) {
        mapping[key] = action.id;
      }
    }
  }

  if (!mapping.lead && actions.length > 0) {
    mapping.lead = actions[0].id;
  }

  return mapping;
}

function listToUniqueArray(values) {
  const out = [];
  const seen = new Set();
  for (const item of values || []) {
    if (!item) continue;
    const key = String(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function buildGoogleAdsCapabilities(connected, hasAdsScope) {
  const enabled = !!connected && !!hasAdsScope;
  return {
    can_list_conversion_actions: enabled,
    can_create_conversion_actions: enabled,
    can_upload_enhanced_conversions: enabled
  };
}

function parseClinicIds(rawValue) {
  if (!Array.isArray(rawValue)) return [];
  return Array.from(new Set(rawValue
    .map((value) => parseInteger(value))
    .filter((value) => Number.isInteger(value) && value > 0)));
}

function normalizeStrategyChannels(rawChannels) {
  if (!Array.isArray(rawChannels)) return [];
  return rawChannels
    .filter((channel) => channel && typeof channel === 'object')
    .map((channel) => ({
      channel: String(channel.channel || '').trim().toLowerCase(),
      enabled: channel.enabled !== false,
      percentage: Number(channel.percentage || 0)
    }))
    .filter((channel) => channel.enabled && VALID_STRATEGY_CHANNELS.has(channel.channel))
    .sort((a, b) => Number(b.percentage || 0) - Number(a.percentage || 0));
}

function normalizeStrategyTreatments(rawTreatments) {
  if (!Array.isArray(rawTreatments)) return [];
  return rawTreatments
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({
      id: parseInteger(item.id),
      nombre: String(item.nombre || '').trim(),
      precio_base: item.precio_base ?? null
    }))
    .filter((item) => item.id && item.nombre);
}

function normalizeExternalCampaignDetection(rawDetection) {
  if (!rawDetection || typeof rawDetection !== 'object') {
    return null;
  }

  const instantForm = rawDetection.instant_form && typeof rawDetection.instant_form === 'object'
    ? {
        id: rawDetection.instant_form.id ? String(rawDetection.instant_form.id).trim() : null,
        name: typeof rawDetection.instant_form.name === 'string' ? String(rawDetection.instant_form.name).trim() || null : null,
        status: typeof rawDetection.instant_form.status === 'string' ? String(rawDetection.instant_form.status).trim() || null : null,
        locale: typeof rawDetection.instant_form.locale === 'string' ? String(rawDetection.instant_form.locale).trim() || null : null,
        follow_up_action_url: typeof rawDetection.instant_form.follow_up_action_url === 'string'
          ? String(rawDetection.instant_form.follow_up_action_url).trim() || null
          : null,
        preview_available: rawDetection.instant_form.preview_available === true,
        preview_summary: typeof rawDetection.instant_form.preview_summary === 'string'
          ? String(rawDetection.instant_form.preview_summary).trim() || null
          : null,
        questions_preview: Array.isArray(rawDetection.instant_form.questions_preview)
          ? rawDetection.instant_form.questions_preview
              .filter((item) => item && typeof item === 'object')
              .map((item) => ({
                key: item.key ? String(item.key).trim() : null,
                label: typeof item.label === 'string' ? String(item.label).trim() || null : null,
                type: typeof item.type === 'string' ? String(item.type).trim() || null : null
              }))
          : []
      }
    : null;

  const creativePreview = rawDetection.creative_preview && typeof rawDetection.creative_preview === 'object'
    ? {
        available: rawDetection.creative_preview.available !== false,
        ad_id: rawDetection.creative_preview.ad_id ? String(rawDetection.creative_preview.ad_id).trim() : null,
        ad_name: typeof rawDetection.creative_preview.ad_name === 'string' ? String(rawDetection.creative_preview.ad_name).trim() || null : null,
        title: typeof rawDetection.creative_preview.title === 'string' ? String(rawDetection.creative_preview.title).trim() || null : null,
        body: typeof rawDetection.creative_preview.body === 'string' ? String(rawDetection.creative_preview.body).trim() || null : null,
        media_url: typeof rawDetection.creative_preview.media_url === 'string' ? String(rawDetection.creative_preview.media_url).trim() || null : null,
        permalink_url: typeof rawDetection.creative_preview.permalink_url === 'string' ? String(rawDetection.creative_preview.permalink_url).trim() || null : null,
        cta_type: typeof rawDetection.creative_preview.cta_type === 'string' ? String(rawDetection.creative_preview.cta_type).trim() || null : null,
        preview_summary: typeof rawDetection.creative_preview.preview_summary === 'string'
          ? String(rawDetection.creative_preview.preview_summary).trim() || null
          : null
      }
    : null;

  const googleAdsPreview = rawDetection.google_ads_preview && typeof rawDetection.google_ads_preview === 'object'
    ? {
        headlines: listToUniqueArray(Array.isArray(rawDetection.google_ads_preview.headlines) ? rawDetection.google_ads_preview.headlines : []),
        descriptions: listToUniqueArray(Array.isArray(rawDetection.google_ads_preview.descriptions) ? rawDetection.google_ads_preview.descriptions : []),
        display_url: typeof rawDetection.google_ads_preview.display_url === 'string'
          ? String(rawDetection.google_ads_preview.display_url).trim() || null
          : null,
        sitelinks: Array.isArray(rawDetection.google_ads_preview.sitelinks)
          ? rawDetection.google_ads_preview.sitelinks
              .filter((item) => item && typeof item === 'object')
              .map((item) => ({
                title: typeof item.title === 'string' ? String(item.title).trim() || null : null,
                url: typeof item.url === 'string' ? String(item.url).trim() || null : null
              }))
              .filter((item) => item.title || item.url)
          : []
      }
    : null;

  return {
    kind: String(rawDetection.kind || '').trim().toLowerCase() === 'lead_form'
      ? 'lead_form'
      : String(rawDetection.kind || '').trim().toLowerCase() === 'web'
      ? 'web'
      : 'unknown',
    confidence: String(rawDetection.confidence || '').trim().toLowerCase() === 'high'
      ? 'high'
      : String(rawDetection.confidence || '').trim().toLowerCase() === 'low'
      ? 'low'
      : 'medium',
    reason: typeof rawDetection.reason === 'string' ? String(rawDetection.reason).trim() || null : null,
    urls: listToUniqueArray(Array.isArray(rawDetection.urls) ? rawDetection.urls : []),
    instant_form: instantForm,
    creative_preview: creativePreview,
    google_ads_preview: googleAdsPreview
  };
}

function normalizeExternalCampaignAssignments(rawAssignments) {
  if (!Array.isArray(rawAssignments)) return [];
  return rawAssignments
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const identity = canonicalExternalCampaignIdentity(item);
      const provider = String(item.provider || '').trim().toLowerCase();
      const externalCampaignId = String(item.external_campaign_id ?? item.campaign_id ?? '').trim();
      const accountId = String(item.account_id ?? item.customer_id ?? '').trim();
      return {
        provider: identity?.provider || provider,
        external_campaign_id: identity?.external_campaign_id || externalCampaignId,
        campaign_id: identity?.campaign_id || externalCampaignId,
        account_id: identity?.account_id || accountId,
        customer_id: identity?.customer_id || accountId,
        account_name: typeof item.account_name === 'string' ? String(item.account_name).trim() || null : null,
        name: typeof item.name === 'string' ? String(item.name).trim() || null : null,
        status: typeof item.status === 'string' ? String(item.status).trim() || null : null,
        metrics: item.metrics && typeof item.metrics === 'object'
          ? {
              impressions: safeNumber(item.metrics.impressions),
              clicks: safeNumber(item.metrics.clicks),
              spend: safeNumber(item.metrics.spend),
              conversions: safeNumber(item.metrics.conversions)
            }
          : {
              impressions: 0,
              clicks: 0,
              spend: 0,
              conversions: 0
            },
        destination_detection: normalizeExternalCampaignDetection(item.destination_detection)
      };
    })
    .filter((item) => (
      (item.provider === 'google_ads' || item.provider === 'meta_ads')
      && item.external_campaign_id
    ));
}

function normalizeExternalTargets(rawTargets) {
  if (!Array.isArray(rawTargets)) return [];
  return rawTargets
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const kind = String(item.kind || '').trim().toLowerCase() === 'generic' ? 'generic' : 'treatment';
      const treatmentId = kind === 'treatment' ? parseInteger(item.treatment_id) : null;
      return {
        kind,
        treatment_id: treatmentId,
        treatment_name: typeof item.treatment_name === 'string' ? String(item.treatment_name).trim() || null : null,
        campaigns: normalizeExternalCampaignAssignments(item.campaigns)
      };
    })
    .filter((item) => (item.kind === 'generic' || !!item.treatment_id));
}

function normalizeTargetDestinations(rawDestinations) {
  if (!Array.isArray(rawDestinations)) return [];
  return rawDestinations
    .filter((item) => item && typeof item === 'object')
    .map((item) => {
      const kind = String(item.kind || '').trim().toLowerCase() === 'generic' ? 'generic' : 'treatment';
      const treatmentId = kind === 'treatment' ? parseInteger(item.treatment_id) : null;
      const rawUrl = typeof item.confirmed_url === 'string' ? String(item.confirmed_url).trim() : '';
      return {
        kind,
        treatment_id: treatmentId,
        treatment_name: typeof item.treatment_name === 'string' ? String(item.treatment_name).trim() || null : null,
        confirmed_url: rawUrl || null,
        uses_web: item.uses_web === true ? true : item.uses_web === false ? false : null
      };
    })
    .filter((item) => (item.kind === 'generic' || !!item.treatment_id));
}

function extractStrategyScopeFromPayload(payload, rows = []) {
  const scope = payload?.scope && typeof payload.scope === 'object' ? payload.scope : {};
  const assignmentScope = String(scope.assignment_scope || '').trim().toLowerCase() === 'group'
    ? 'group'
    : 'clinic';
  const fallbackClinicId = parseInteger(rows[0]?.clinica_id);

  return {
    assignment_scope: assignmentScope,
    clinic_id: assignmentScope === 'clinic'
      ? parseInteger(scope.clinic_id) || fallbackClinicId || null
      : null,
    group_id: parseInteger(scope.group_id) || null,
    clinic_ids: parseClinicIds(scope.clinic_ids)
  };
}

function resolveAnalysisDateRange(timeframeRaw, startDateRaw, endDateRaw) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const normalized = String(timeframeRaw || '').trim().toLowerCase();
  const explicitStart = startDateRaw ? parseDate(startDateRaw, null) : null;
  const explicitEnd = endDateRaw ? parseDate(endDateRaw, null) : null;
  if (explicitStart && explicitEnd) {
    return {
      key: normalized || 'custom',
      start: explicitStart,
      end: explicitEnd
    };
  }

  const end = new Date(today);
  const start = new Date(today);

  switch (normalized) {
    case 'yesterday':
      start.setDate(start.getDate() - 1);
      end.setDate(end.getDate() - 1);
      break;
    case 'last_week':
      start.setDate(start.getDate() - 13);
      end.setDate(end.getDate() - 7);
      break;
    case 'last_month':
      start.setDate(start.getDate() - 29);
      break;
    case 'all_time':
      start.setFullYear(2020, 0, 1);
      break;
    case 'last_7_days':
    default:
      start.setDate(start.getDate() - 6);
      break;
  }

  return {
    key: normalized || 'last_7_days',
    start,
    end
  };
}

function resolveMetaLeadTotalFromActionTotals(totals) {
  const normalized = totals && typeof totals === 'object' ? totals : {};
  return safeNumber(normalized.lead)
    + safeNumber(normalized['offsite_conversion.fb_pixel_lead'])
    + safeNumber(normalized['onsite_conversion.lead_form'])
    + safeNumber(normalized['leadgen.other'])
    + safeNumber(normalized['onsite_conversion.lead_grouped']);
}

function buildAnalysisLeafRow({
  kind,
  key,
  name,
  spend,
  leads,
  impressions,
  clicks,
  mock = false,
  warningText = null,
  thumbnailUrl = null,
  creativeImageUrl = null,
  creativeText = null,
  creativeCta = null,
  creativeDestinationUrl = null,
  googleAdsHeadlines = [],
  googleAdsDescriptions = [],
  googleAdsDisplayUrl = null,
  googleAdsSitelinks = [],
  instantFormName = null,
  instantFormQuestions = [],
  followUpUrl = null,
  statusText = null
}) {
  const normalizedSpend = safeNumber(spend);
  const normalizedLeads = leads == null ? null : safeNumber(leads);
  const normalizedImpressions = safeNumber(impressions);
  const normalizedClicks = safeNumber(clicks);
  const computedCtr = normalizedImpressions > 0 ? (normalizedClicks / normalizedImpressions) * 100 : null;

  return {
    kind,
    key,
    name: name || 'Sin nombre',
    summary: null,
    mock: mock === true,
    spend: Number(normalizedSpend.toFixed(2)),
    leads: normalizedLeads,
    cpl: normalizedLeads && normalizedLeads > 0 ? Number((normalizedSpend / normalizedLeads).toFixed(2)) : null,
    ctr: computedCtr != null ? Number(computedCtr.toFixed(2)) : null,
    impressions: normalizedImpressions,
    clicks: normalizedClicks,
    hasWarning: normalizedSpend > 0 && !normalizedLeads,
    warningText: warningText || (normalizedSpend > 0 && !normalizedLeads ? 'Sin leads' : null),
    thumbnail_url: thumbnailUrl || creativeImageUrl || null,
    creative_image_url: creativeImageUrl || null,
    creative_text: creativeText || null,
    creative_cta: creativeCta || null,
    creative_destination_url: creativeDestinationUrl || null,
    google_ads_headlines: Array.isArray(googleAdsHeadlines) ? googleAdsHeadlines.filter(Boolean) : [],
    google_ads_descriptions: Array.isArray(googleAdsDescriptions) ? googleAdsDescriptions.filter(Boolean) : [],
    google_ads_display_url: googleAdsDisplayUrl || null,
    google_ads_sitelinks: Array.isArray(googleAdsSitelinks) ? googleAdsSitelinks.filter((item) => item && item.title && item.url) : [],
    instant_form_name: instantFormName || null,
    instant_form_questions: Array.isArray(instantFormQuestions) ? instantFormQuestions : [],
    follow_up_url: followUpUrl || null,
    status_text: statusText || null
  };
}

function normalizeJsonArray(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue;
  }
  if (typeof rawValue === 'string') {
    try {
      const parsed = JSON.parse(rawValue);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_err) {
      return [];
    }
  }
  return [];
}

function extractGoogleAdTextAssets(items) {
  const list = Array.isArray(items) ? items : [];
  return list
    .map((item) => {
      if (typeof item === 'string') return item.trim();
      if (item && typeof item === 'object') {
        return String(item.text || item.assetText || item.textAsset?.text || '').trim();
      }
      return '';
    })
    .filter(Boolean);
}

function buildGoogleDisplayUrl(rawUrl) {
  const value = String(rawUrl || '').trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '';
    return `${parsed.host}${path}`;
  } catch (_err) {
    return value;
  }
}

function extractGoogleAdPreviewFields(row) {
  const adGroupAd = row?.adGroupAd || row?.ad_group_ad || {};
  const ad = adGroupAd?.ad || {};
  const responsiveSearchAd = ad?.responsiveSearchAd || ad?.responsive_search_ad || {};
  const finalUrls = Array.isArray(ad?.finalUrls || ad?.final_urls) ? (ad.finalUrls || ad.final_urls) : [];
  const finalMobileUrls = Array.isArray(ad?.finalMobileUrls || ad?.final_mobile_urls) ? (ad.finalMobileUrls || ad.final_mobile_urls) : [];
  const finalUrl = String(finalUrls.find(Boolean) || finalMobileUrls.find(Boolean) || '').trim() || null;
  const headlines = extractGoogleAdTextAssets(responsiveSearchAd?.headlines);
  const descriptions = extractGoogleAdTextAssets(responsiveSearchAd?.descriptions);

  return {
    adId: ad?.id ? String(ad.id).trim() : null,
    adName: typeof ad?.name === 'string' ? String(ad.name).trim() || null : null,
    adType: typeof ad?.type === 'string' ? String(ad.type).trim() || null : null,
    adStatus: typeof adGroupAd?.status === 'string' ? String(adGroupAd.status).trim() || null : null,
    finalUrl,
    displayUrl: buildGoogleDisplayUrl(finalUrl),
    headlines,
    descriptions
  };
}

async function fetchGoogleCampaignAnalysisAdRowsLive({ accessToken, loginCustomerId, customerId, campaignId, timeframe }) {
  const cleanCustomerId = normalizeCustomerId(customerId);
  const cleanCampaignId = String(campaignId || '').trim();
  if (!accessToken || !cleanCustomerId || !cleanCampaignId) {
    return [];
  }

  const variants = [
    {
      name: 'full',
      fields: [
        'campaign.id',
        'campaign.name',
        'campaign.status',
        'ad_group.id',
        'ad_group.name',
        'ad_group.status',
        'ad_group_ad.status',
        'ad_group_ad.ad.id',
        'ad_group_ad.ad.name',
        'ad_group_ad.ad.type',
        'ad_group_ad.ad.final_urls',
        'ad_group_ad.ad.final_mobile_urls',
        'ad_group_ad.ad.responsive_search_ad.headlines',
        'ad_group_ad.ad.responsive_search_ad.descriptions',
        'segments.date',
        'segments.ad_network_type',
        'segments.device',
        'metrics.impressions',
        'metrics.clicks',
        'metrics.cost_micros',
        'metrics.conversions'
      ]
    },
    {
      name: 'basic',
      fields: [
        'campaign.id',
        'campaign.name',
        'campaign.status',
        'ad_group.id',
        'ad_group.name',
        'ad_group.status',
        'ad_group_ad.status',
        'ad_group_ad.ad.id',
        'ad_group_ad.ad.name',
        'ad_group_ad.ad.type',
        'segments.date',
        'segments.ad_network_type',
        'segments.device',
        'metrics.impressions',
        'metrics.clicks',
        'metrics.cost_micros',
        'metrics.conversions'
      ]
    }
  ];

  for (const variant of variants) {
    const query = [
      'SELECT',
      ...variant.fields.map((field, index) => `  ${field}${index < variant.fields.length - 1 ? ',' : ''}`),
      'FROM ad_group_ad',
      `WHERE campaign.id = '${cleanCampaignId}'`,
      `  AND segments.date BETWEEN '${formatDate(timeframe.start)}' AND '${formatDate(timeframe.end)}'`
    ].join('\n');

    try {
      let pageToken = null;
      const out = [];
      do {
        const resp = await googleAdsRequest('POST', `customers/${cleanCustomerId}/googleAds:search`, {
          accessToken,
          loginCustomerId: loginCustomerId || undefined,
          data: { query, pageToken }
        });
        const results = Array.isArray(resp?.results) ? resp.results : [];
        out.push(...results);
        pageToken = resp?.nextPageToken || resp?.next_page_token || null;
      } while (pageToken);
      return out;
    } catch (err) {
      const invalidArgument = err?.response?.data?.error?.status === 'INVALID_ARGUMENT';
      if (!invalidArgument || variant.name === variants[variants.length - 1].name) {
        throw err;
      }
    }
  }

  return [];
}

async function persistGoogleCampaignAnalysisAdRows({ account, scope, rows }) {
  if (!account?.id || !Array.isArray(rows) || !rows.length) {
    return 0;
  }

  const payloadRows = rows
    .map((row) => {
      const campaign = row?.campaign || {};
      const adGroup = row?.adGroup || row?.ad_group || {};
      const segments = row?.segments || {};
      const metrics = row?.metrics || {};
      const preview = extractGoogleAdPreviewFields(row);
      if (!segments?.date || !campaign?.id || !preview.adId) {
        return null;
      }
      return {
        clinicGoogleAdsAccountId: account.id,
        clinicaId: scope?.clinic_id || account.clinicaId || null,
        grupoClinicaId: scope?.group_id || account.grupoClinicaId || null,
        customerId: normalizeCustomerId(account.customerId || ''),
        campaignId: String(campaign.id),
        campaignName: campaign.name || null,
        campaignStatus: campaign.status || null,
        adGroupId: adGroup?.id ? String(adGroup.id) : null,
        adGroupName: adGroup?.name || null,
        adId: preview.adId,
        adName: preview.adName,
        adType: preview.adType,
        adStatus: preview.adStatus,
        date: segments.date,
        network: String(segments?.adNetworkType || segments?.ad_network_type || '').trim(),
        device: String(segments?.device || '').trim(),
        impressions: safeNumber(metrics?.impressions),
        clicks: safeNumber(metrics?.clicks),
        costMicros: safeNumber(metrics?.costMicros || metrics?.cost_micros),
        conversions: safeNumber(metrics?.conversions),
        ctr: safeNumber(metrics?.ctr),
        finalUrl: preview.finalUrl,
        displayUrl: preview.displayUrl,
        headlines: preview.headlines,
        descriptions: preview.descriptions
      };
    })
    .filter(Boolean);

  if (!payloadRows.length) {
    return 0;
  }

  const dates = payloadRows.map((row) => row.date).filter(Boolean);
  const campaignIds = Array.from(new Set(payloadRows.map((row) => row.campaignId).filter(Boolean)));
  if (campaignIds.length && dates.length) {
    await GoogleAdsAdInsightsDaily.destroy({
      where: {
        clinicGoogleAdsAccountId: account.id,
        customerId: normalizeCustomerId(account.customerId || ''),
        campaignId: { [Op.in]: campaignIds },
        date: { [Op.between]: [dates.sort()[0], dates.sort().slice(-1)[0]] }
      }
    });
  }

  await GoogleAdsAdInsightsDaily.bulkCreate(payloadRows, {
    updateOnDuplicate: [
      'campaignName',
      'campaignStatus',
      'adGroupId',
      'adGroupName',
      'adName',
      'adType',
      'adStatus',
      'clinicaId',
      'grupoClinicaId',
      'impressions',
      'clicks',
      'costMicros',
      'conversions',
      'ctr',
      'finalUrl',
      'displayUrl',
      'headlines',
      'descriptions',
      'updated_at'
    ]
  });

  return payloadRows.length;
}

async function resolveGoogleCampaignAnalysisAccess({ userId, scope, customerId }) {
  const normalizedCustomerId = normalizeCustomerId(customerId);
  if (!userId || !normalizedCustomerId) {
    return null;
  }

  const account = await ClinicGoogleAdsAccount.findOne({
    where: {
      customerId: normalizedCustomerId,
      isActive: true,
      ...buildScopeWhere(scope)
    },
    order: [['updated_at', 'DESC']],
    raw: true
  });
  if (!account) {
    return null;
  }

  const googleResolved = await resolveGoogleConnectionForScope({
    userId,
    clinicIdRaw: scope?.clinic_id,
    groupIdRaw: scope?.group_id,
    assignmentScopeRaw: scope?.assignment_scope,
    allowLegacyUserFallback: true
  });
  if (!googleResolved?.connection) {
    return null;
  }

  const { accessToken } = await ensureGoogleAdsAccess(googleResolved.connection);
  const loginCustomerId = normalizeCustomerId(account.loginCustomerId || account.managerCustomerId || '')
    || await resolveLoginCustomerId(googleResolved.connection.id, normalizedCustomerId, scope)
    || undefined;

  return {
    account,
    accessToken,
    loginCustomerId,
    customerId: normalizedCustomerId
  };
}

async function warmGoogleCampaignAnalysisCache({ userId, scope, campaignRef, timeframe }) {
  const customerId = normalizeCustomerId(campaignRef?.account_id || '');
  const campaignId = String(campaignRef?.external_campaign_id || '').trim();
  if (!userId || !customerId || !campaignId) {
    return 0;
  }

  const runtime = await resolveGoogleCampaignAnalysisAccess({ userId, scope, customerId });
  if (!runtime?.account) {
    return 0;
  }

  const liveRows = await fetchGoogleCampaignAnalysisAdRowsLive({
    accessToken: runtime.accessToken,
    loginCustomerId: runtime.loginCustomerId,
    customerId: runtime.customerId,
    campaignId,
    timeframe
  });

  return persistGoogleCampaignAnalysisAdRows({ account: runtime.account, scope, rows: liveRows });
}

async function fetchGooglePerformanceMaxAnalysisRowsLive({ accessToken, loginCustomerId, customerId, campaignId, timeframe, previewDestinationUrl }) {
  const cleanCustomerId = normalizeCustomerId(customerId);
  const cleanCampaignId = String(campaignId || '').trim();
  if (!accessToken || !cleanCustomerId || !cleanCampaignId) {
    return [];
  }

  const groupQuery = [
    'SELECT',
    '  campaign.id,',
    '  campaign.name,',
    '  asset_group.id,',
    '  asset_group.name,',
    '  metrics.impressions,',
    '  metrics.clicks,',
    '  metrics.cost_micros,',
    '  metrics.conversions',
    'FROM asset_group',
    `WHERE campaign.id = '${cleanCampaignId}'`,
    `  AND segments.date BETWEEN '${formatDate(timeframe.start)}' AND '${formatDate(timeframe.end)}'`
  ].join('\n');

  const assetQuery = [
    'SELECT',
    '  campaign.id,',
    '  asset_group.id,',
    '  asset_group.name,',
    '  asset_group_asset.field_type,',
    '  asset_group_asset.status,',
    '  asset.id,',
    '  asset.name,',
    '  asset.type,',
    '  asset.text_asset.text,',
    '  asset.image_asset.full_size.url,',
    '  asset.youtube_video_asset.youtube_video_id',
    'FROM asset_group_asset',
    `WHERE campaign.id = '${cleanCampaignId}'`
  ].join('\n');

  const [groupResp, assetResp] = await Promise.all([
    googleAdsRequest('POST', `customers/${cleanCustomerId}/googleAds:search`, {
      accessToken,
      loginCustomerId: loginCustomerId || undefined,
      data: { query: groupQuery }
    }),
    googleAdsRequest('POST', `customers/${cleanCustomerId}/googleAds:search`, {
      accessToken,
      loginCustomerId: loginCustomerId || undefined,
      data: { query: assetQuery }
    })
  ]);

  const metricRows = Array.isArray(groupResp?.results) ? groupResp.results : [];
  const assetRows = Array.isArray(assetResp?.results) ? assetResp.results : [];
  if (!metricRows.length) {
    return [];
  }

  const assetsByGroupId = new Map();
  for (const row of assetRows) {
    const assetGroupId = String(row?.assetGroup?.id || '').trim();
    if (!assetGroupId) continue;
    if (!assetsByGroupId.has(assetGroupId)) {
      assetsByGroupId.set(assetGroupId, []);
    }
    assetsByGroupId.get(assetGroupId).push(row);
  }

  return metricRows.map((row) => {
    const assetGroupId = String(row?.assetGroup?.id || '').trim();
    const assetGroupName = row?.assetGroup?.name || 'Asset group';
    const spend = microsToCurrency(row?.metrics?.costMicros);
    const leads = safeNumber(row?.metrics?.conversions);
    const impressions = safeNumber(row?.metrics?.impressions);
    const clicks = safeNumber(row?.metrics?.clicks);
    const groupAssets = Array.isArray(assetsByGroupId.get(assetGroupId)) ? assetsByGroupId.get(assetGroupId) : [];

    const enabledAssets = groupAssets.filter((assetRow) => String(assetRow?.assetGroupAsset?.status || '').trim().toUpperCase() !== 'REMOVED');
    const headlines = enabledAssets
      .filter((assetRow) => ['HEADLINE', 'LONG_HEADLINE', 'BUSINESS_NAME'].includes(String(assetRow?.assetGroupAsset?.fieldType || '').trim().toUpperCase()))
      .map((assetRow) => String(assetRow?.asset?.textAsset?.text || '').trim())
      .filter(Boolean);
    const descriptions = enabledAssets
      .filter((assetRow) => String(assetRow?.assetGroupAsset?.fieldType || '').trim().toUpperCase() === 'DESCRIPTION')
      .map((assetRow) => String(assetRow?.asset?.textAsset?.text || '').trim())
      .filter(Boolean);
    const imageUrl = enabledAssets
      .map((assetRow) => String(assetRow?.asset?.imageAsset?.fullSize?.url || '').trim())
      .find(Boolean) || null;
    const youtubeVideoId = enabledAssets
      .map((assetRow) => String(assetRow?.asset?.youtubeVideoAsset?.youtubeVideoId || '').trim())
      .find(Boolean) || null;
    const mediaUrl = imageUrl || (youtubeVideoId ? `https://i.ytimg.com/vi/${youtubeVideoId}/hqdefault.jpg` : null);

    const groupRow = buildAnalysisLeafRow({
      kind: 'ad_group',
      key: `google_ads:asset_group:${assetGroupId}`,
      name: assetGroupName,
      spend,
      leads,
      impressions,
      clicks
    });

    const previewRow = buildAnalysisLeafRow({
      kind: 'ad',
      key: `google_ads:asset_preview:${assetGroupId}`,
      name: headlines[0] || assetGroupName,
      spend,
      leads,
      impressions,
      clicks,
      mock: false,
      warningText: groupRow.warningText,
      thumbnailUrl: mediaUrl,
      creativeImageUrl: mediaUrl,
      creativeText: descriptions.join(' ') || null,
      creativeDestinationUrl: previewDestinationUrl,
      googleAdsHeadlines: headlines,
      googleAdsDescriptions: descriptions,
      googleAdsDisplayUrl: previewDestinationUrl,
      googleAdsSitelinks: []
    });

    return {
      ...groupRow,
      ads: [previewRow]
    };
  }).sort((a, b) => safeNumber(b.spend) - safeNumber(a.spend));
}

async function buildGoogleCampaignAnalysisRows({ scope, campaignRef, timeframe }) {
  const customerId = normalizeCustomerId(campaignRef?.account_id || '');
  const campaignId = String(campaignRef?.external_campaign_id || '').trim();
  if (!customerId || !campaignId) {
    return [];
  }
  const googlePreview = campaignRef?.destination_detection?.google_ads_preview && typeof campaignRef.destination_detection.google_ads_preview === 'object'
    ? campaignRef.destination_detection.google_ads_preview
    : {};
  const previewDestinationUrl = typeof googlePreview.display_url === 'string' && googlePreview.display_url.trim()
    ? String(googlePreview.display_url).trim()
    : Array.isArray(campaignRef?.destination_detection?.urls) && campaignRef.destination_detection.urls[0]
    ? String(campaignRef.destination_detection.urls[0]).trim()
    : null;

  let adRows = await GoogleAdsAdInsightsDaily.findAll({
    where: {
      customerId,
      campaignId,
      date: { [Op.between]: [formatDate(timeframe.start), formatDate(timeframe.end)] },
      ...buildMetricsScopeWhere(scope, { clinicField: 'clinicaId', groupField: 'grupoClinicaId' })
    },
    order: [['adGroupName', 'ASC'], ['adName', 'ASC']],
    raw: true
  });

  if (adRows.length) {
    const grouped = new Map();
    for (const row of adRows) {
      const adGroupId = String(row.adGroupId || '').trim() || `group:${campaignId}`;
      const adGroupName = row.adGroupName || 'Grupo principal';
      const adId = String(row.adId || '').trim();
      if (!adId) continue;
      const groupKey = adGroupId;
      if (!grouped.has(groupKey)) {
        grouped.set(groupKey, {
          adGroupId,
          adGroupName,
          spend: 0,
          leads: 0,
          impressions: 0,
          clicks: 0,
          ads: new Map()
        });
      }
      const group = grouped.get(groupKey);
      const adKey = adId;
      if (!group.ads.has(adKey)) {
        group.ads.set(adKey, {
          adId,
          adName: row.adName || null,
          adType: row.adType || null,
          adStatus: row.adStatus || null,
          spend: 0,
          leads: 0,
          impressions: 0,
          clicks: 0,
          finalUrl: row.finalUrl || null,
          displayUrl: row.displayUrl || null,
          headlines: normalizeJsonArray(row.headlines),
          descriptions: normalizeJsonArray(row.descriptions)
        });
      }
      const ad = group.ads.get(adKey);
      const spend = microsToCurrency(row.costMicros);
      const leads = safeNumber(row.conversions);
      const impressions = safeNumber(row.impressions);
      const clicks = safeNumber(row.clicks);

      ad.spend += spend;
      ad.leads += leads;
      ad.impressions += impressions;
      ad.clicks += clicks;

      group.spend += spend;
      group.leads += leads;
      group.impressions += impressions;
      group.clicks += clicks;
    }

    return Array.from(grouped.values())
      .map((group) => {
        const groupRow = buildAnalysisLeafRow({
          kind: 'ad_group',
          key: `google_ads:ad_group:${group.adGroupId}`,
          name: group.adGroupName,
          spend: group.spend,
          leads: group.leads,
          impressions: group.impressions,
          clicks: group.clicks
        });

        const ads = Array.from(group.ads.values())
          .map((ad) => buildAnalysisLeafRow({
            kind: 'ad',
            key: `google_ads:ad:${ad.adId}`,
            name: ad.adName || ad.headlines?.[0] || group.adGroupName,
            spend: ad.spend,
            leads: ad.leads,
            impressions: ad.impressions,
            clicks: ad.clicks,
            mock: false,
            warningText: ad.spend > 0 && !ad.leads ? 'Sin leads' : null,
            creativeText: Array.isArray(ad.descriptions) ? ad.descriptions.filter(Boolean).join(' ') : null,
            creativeDestinationUrl: ad.finalUrl || previewDestinationUrl,
            googleAdsHeadlines: Array.isArray(ad.headlines) ? ad.headlines : [],
            googleAdsDescriptions: Array.isArray(ad.descriptions) ? ad.descriptions : [],
            googleAdsDisplayUrl: ad.displayUrl || previewDestinationUrl,
            googleAdsSitelinks: Array.isArray(googlePreview.sitelinks) ? googlePreview.sitelinks : [],
            statusText: ad.adStatus || null
          }))
          .sort((a, b) => safeNumber(b.spend) - safeNumber(a.spend));

        return {
          ...groupRow,
          ads
        };
      })
      .sort((a, b) => safeNumber(b.spend) - safeNumber(a.spend));
  }

  const rows = await GoogleAdsInsightsDaily.findAll({
    attributes: [
      'adGroupId',
      'adGroupName',
      [fn('SUM', col('impressions')), 'impressions'],
      [fn('SUM', col('clicks')), 'clicks'],
      [fn('SUM', col('costMicros')), 'costMicros'],
      [fn('SUM', col('conversions')), 'conversions']
    ],
    where: {
      customerId,
      campaignId,
      date: { [Op.between]: [formatDate(timeframe.start), formatDate(timeframe.end)] },
      ...buildMetricsScopeWhere(scope, { clinicField: 'clinicaId', groupField: 'grupoClinicaId' })
    },
    group: ['adGroupId', 'adGroupName'],
    raw: true
  });

  return rows
    .map((row, index) => {
      const adGroupId = String(row.adGroupId || '').trim() || `ad-group-${index + 1}`;
      const adGroupName = row.adGroupName || 'Grupo principal';
      const spend = microsToCurrency(row.costMicros);
      const leads = safeNumber(row.conversions);
      const groupRow = buildAnalysisLeafRow({
        kind: 'ad_group',
        key: `google_ads:ad_group:${adGroupId}`,
        name: adGroupName,
        spend,
        leads,
        impressions: row.impressions,
        clicks: row.clicks
      });

      const previewLabel = campaignRef?.destination_detection?.google_ads_preview?.headlines?.[0]
        || campaignRef?.name
        || adGroupName;
      const previewRow = buildAnalysisLeafRow({
        kind: 'ad',
        key: `google_ads:ad_preview:${adGroupId}`,
        name: previewLabel,
        spend,
        leads,
        impressions: row.impressions,
        clicks: row.clicks,
        mock: true,
        warningText: groupRow.warningText,
        creativeText: Array.isArray(googlePreview.descriptions) ? googlePreview.descriptions.filter(Boolean).join(' ') : null,
        creativeDestinationUrl: previewDestinationUrl,
        googleAdsHeadlines: Array.isArray(googlePreview.headlines) ? googlePreview.headlines : [],
        googleAdsDescriptions: Array.isArray(googlePreview.descriptions) ? googlePreview.descriptions : [],
        googleAdsDisplayUrl: previewDestinationUrl,
        googleAdsSitelinks: Array.isArray(googlePreview.sitelinks) ? googlePreview.sitelinks : []
      });

      return {
        ...groupRow,
        ads: [previewRow]
      };
    })
    .sort((a, b) => safeNumber(b.spend) - safeNumber(a.spend));
}

async function buildMetaCampaignAnalysisRows({ scope, campaignRef, timeframe }) {
  const campaignId = String(campaignRef?.external_campaign_id || '').trim();
  if (!campaignId) {
    return [];
  }
  const detection = campaignRef?.destination_detection && typeof campaignRef.destination_detection === 'object'
    ? campaignRef.destination_detection
    : {};
  const creativePreview = detection?.creative_preview && typeof detection.creative_preview === 'object'
    ? detection.creative_preview
    : {};
  const instantForm = detection?.instant_form && typeof detection.instant_form === 'object'
    ? detection.instant_form
    : {};
  const creativeDestinationUrl = Array.isArray(detection?.urls) && detection.urls[0]
    ? String(detection.urls[0]).trim()
    : typeof instantForm.follow_up_action_url === 'string'
    ? String(instantForm.follow_up_action_url).trim()
    : null;

  const adsetEntities = await SocialAdsEntity.findAll({
    where: {
      level: 'adset',
      parent_id: campaignId
    },
    raw: true
  });
  if (!adsetEntities.length) {
    return [];
  }

  const adsetIds = adsetEntities.map((row) => String(row.entity_id || '').trim()).filter(Boolean);
  const adEntities = adsetIds.length
    ? await SocialAdsEntity.findAll({
        where: {
          level: 'ad',
          parent_id: { [Op.in]: adsetIds }
        },
        raw: true
      })
    : [];

  const scopeWhereInsights = buildMetricsScopeWhere(scope, { clinicField: 'clinica_id', groupField: 'grupo_clinica_id' });
  const rangeWhere = { [Op.between]: [formatDate(timeframe.start), formatDate(timeframe.end)] };

  const adsetInsightRows = adsetIds.length
    ? await SocialAdsInsightsDaily.findAll({
        attributes: [
          'entity_id',
          [fn('SUM', col('impressions')), 'impressions'],
          [fn('SUM', col('clicks')), 'clicks'],
          [fn('SUM', col('spend')), 'spend']
        ],
        where: {
          level: 'adset',
          entity_id: { [Op.in]: adsetIds },
          date: rangeWhere,
          ...scopeWhereInsights
        },
        group: ['entity_id'],
        raw: true
      })
    : [];

  const adsetActionRows = adsetIds.length
    ? await SocialAdsActionsDaily.findAll({
        attributes: [
          'entity_id',
          'action_type',
          [fn('SUM', col('value')), 'value']
        ],
        where: {
          level: 'adset',
          entity_id: { [Op.in]: adsetIds },
          date: rangeWhere,
          ...buildMetricsScopeWhere(scope, { clinicField: 'clinica_id', groupField: 'grupo_clinica_id' })
        },
        group: ['entity_id', 'action_type'],
        raw: true
      })
    : [];

  const adIds = adEntities.map((row) => String(row.entity_id || '').trim()).filter(Boolean);
  const adInsightRows = adIds.length
    ? await SocialAdsInsightsDaily.findAll({
        attributes: [
          'entity_id',
          [fn('SUM', col('impressions')), 'impressions'],
          [fn('SUM', col('clicks')), 'clicks'],
          [fn('SUM', col('spend')), 'spend']
        ],
        where: {
          level: 'ad',
          entity_id: { [Op.in]: adIds },
          date: rangeWhere,
          ...scopeWhereInsights
        },
        group: ['entity_id'],
        raw: true
      })
    : [];

  const adActionRows = adIds.length
    ? await SocialAdsActionsDaily.findAll({
        attributes: [
          'entity_id',
          'action_type',
          [fn('SUM', col('value')), 'value']
        ],
        where: {
          level: 'ad',
          entity_id: { [Op.in]: adIds },
          date: rangeWhere,
          ...buildMetricsScopeWhere(scope, { clinicField: 'clinica_id', groupField: 'grupo_clinica_id' })
        },
        group: ['entity_id', 'action_type'],
        raw: true
      })
    : [];

  const metaAdPreviews = { byAdId: new Map(), byAdsetId: new Map() };
  const metaAdMetricsLive = { byAdId: new Map(), byAdsetId: new Map() };

  const insightByEntityId = new Map(adsetInsightRows.map((row) => [String(row.entity_id || '').trim(), row]));
  const adInsightByEntityId = new Map(adInsightRows.map((row) => [String(row.entity_id || '').trim(), row]));
  const actionsByEntityId = new Map();
  for (const row of adsetActionRows) {
    const key = String(row.entity_id || '').trim();
    if (!key) continue;
    if (!actionsByEntityId.has(key)) actionsByEntityId.set(key, []);
    actionsByEntityId.get(key).push(row);
  }
  const adActionsByEntityId = new Map();
  for (const row of adActionRows) {
    const key = String(row.entity_id || '').trim();
    if (!key) continue;
    if (!adActionsByEntityId.has(key)) adActionsByEntityId.set(key, []);
    adActionsByEntityId.get(key).push(row);
  }

  const adRowsByAdsetId = new Map();
  for (const ad of adEntities) {
    const adsetId = String(ad.parent_id || '').trim();
    if (!adsetId) continue;
    if (!adRowsByAdsetId.has(adsetId)) adRowsByAdsetId.set(adsetId, []);
    adRowsByAdsetId.get(adsetId).push(ad);
  }

  return adsetEntities
    .map((adset) => {
      const adsetId = String(adset.entity_id || '').trim();
      const adsetInsight = insightByEntityId.get(adsetId) || null;
      const adsetActionTotals = summarizeMetaCampaignActions(actionsByEntityId.get(adsetId) || []);
      const ads = (adRowsByAdsetId.get(adsetId) || [])
        .map((ad, index) => {
          const adId = String(ad.entity_id || '').trim();
          const adInsight = adInsightByEntityId.get(adId) || null;
          const adActionTotals = summarizeMetaCampaignActions(adActionsByEntityId.get(adId) || []);
          const adsetId = String(ad.parent_id || '').trim();
          const adPreview = metaAdPreviews.byAdId.get(adId)
            || metaAdPreviews.byAdsetId.get(adsetId)
            || null;
          const liveAdMetrics = metaAdMetricsLive.byAdId.get(adId) || null;
          const adsetLiveMetrics = metaAdMetricsLive.byAdsetId.get(adsetId) || null;
          const cachedSpend = safeNumber(adInsight?.spend);
          const cachedImpressions = safeNumber(adInsight?.impressions);
          const cachedClicks = safeNumber(adInsight?.clicks);
          const cachedLeads = resolveMetaLeadTotalFromActionTotals(adActionTotals);
          const hasCachedMetrics = cachedSpend > 0 || cachedImpressions > 0 || cachedClicks > 0 || cachedLeads > 0;
          const fallbackCount = Math.max(1, (adRowsByAdsetId.get(adsetId) || []).length);
          const fallbackMetric = !hasCachedMetrics && !liveAdMetrics && adsetLiveMetrics
            ? {
                spend: safeNumber(adsetLiveMetrics.spend) / fallbackCount,
                leads: safeNumber(adsetLiveMetrics.leads) / fallbackCount,
                impressions: Math.round(safeNumber(adsetLiveMetrics.impressions) / fallbackCount),
                clicks: Math.round(safeNumber(adsetLiveMetrics.clicks) / fallbackCount)
              }
            : null;
          return buildAnalysisLeafRow({
            kind: 'ad',
            key: `meta_ads:ad:${adId || index + 1}`,
            name: adPreview?.adName || ad.name || `Anuncio ${index + 1}`,
            spend: hasCachedMetrics
              ? adInsight?.spend
              : liveAdMetrics?.spend ?? fallbackMetric?.spend ?? 0,
            leads: hasCachedMetrics
              ? cachedLeads
              : liveAdMetrics?.leads ?? fallbackMetric?.leads ?? 0,
            impressions: hasCachedMetrics
              ? adInsight?.impressions
              : liveAdMetrics?.impressions ?? fallbackMetric?.impressions ?? 0,
            clicks: hasCachedMetrics
              ? adInsight?.clicks
              : liveAdMetrics?.clicks ?? fallbackMetric?.clicks ?? 0,
            thumbnailUrl: adPreview?.thumbnailUrl || creativePreview.media_url || null,
            creativeImageUrl: adPreview?.creativeImageUrl || creativePreview.media_url || null,
            creativeText: adPreview?.creativeText || creativePreview.body || creativePreview.preview_summary || creativePreview.title || null,
            creativeCta: adPreview?.creativeCta || creativePreview.cta_type || null,
            creativeDestinationUrl: adPreview?.creativeDestinationUrl || creativeDestinationUrl,
            instantFormName: adPreview?.instantFormName || instantForm.name || null,
            instantFormQuestions: Array.isArray(adPreview?.instantFormQuestions) && adPreview.instantFormQuestions.length
              ? adPreview.instantFormQuestions
              : Array.isArray(instantForm.questions_preview)
                ? instantForm.questions_preview
                : [],
            followUpUrl: adPreview?.followUpUrl || instantForm.follow_up_action_url || null,
            statusText: adPreview?.statusText || ad.delivery_status || ad.status || null
          });
        })
        .sort((a, b) => safeNumber(b.spend) - safeNumber(a.spend));

      const rolledSpend = ads.reduce((sum, ad) => sum + safeNumber(ad.spend), 0);
      const rolledLeads = ads.reduce((sum, ad) => sum + safeNumber(ad.leads), 0);
      const rolledImpressions = ads.reduce((sum, ad) => sum + safeNumber(ad.impressions), 0);
      const rolledClicks = ads.reduce((sum, ad) => sum + safeNumber(ad.clicks), 0);
      const adsetLeads = resolveMetaLeadTotalFromActionTotals(adsetActionTotals) || rolledLeads;

      const groupRow = buildAnalysisLeafRow({
        kind: 'ad_set',
        key: `meta_ads:ad_set:${adsetId}`,
        name: adset.name || 'Conjunto principal',
        spend: adsetInsight?.spend ?? rolledSpend,
        leads: adsetLeads,
        impressions: adsetInsight?.impressions ?? rolledImpressions,
        clicks: adsetInsight?.clicks ?? rolledClicks
      });

      return {
        ...groupRow,
        ads
      };
    })
    .sort((a, b) => safeNumber(b.spend) - safeNumber(a.spend));
}

function collectExternalCampaignRefs(payload) {
  const refs = {
    google_ads: { accountIds: new Set(), campaignIds: new Set(), identities: new Map() },
    meta_ads: { accountIds: new Set(), campaignIds: new Set(), identities: new Map() }
  };

  const targets = Array.isArray(payload?.external_targets) ? payload.external_targets : [];
  for (const target of targets) {
    const campaigns = Array.isArray(target?.campaigns) ? target.campaigns : [];
    for (const campaign of campaigns) {
      const identity = canonicalExternalCampaignIdentity(campaign);
      const key = externalCampaignIdentityKey(identity);
      if (!identity || !key) continue;
      refs[identity.provider].accountIds.add(identity.account_id);
      refs[identity.provider].campaignIds.add(identity.campaign_id);
      refs[identity.provider].identities.set(key, identity);
    }
  }

  return refs;
}

async function loadCurrentExternalCampaignMetricsIndex({ scope, payload, days = 30 }) {
  const refs = collectExternalCampaignRefs(payload);
  const result = new Map();
  const end = new Date();
  end.setHours(0, 0, 0, 0);
  const start = new Date(end.getTime() - (Math.max(1, Math.min(180, days)) - 1) * 86400000);
  const startStr = formatDate(start);
  const endStr = formatDate(end);

  const googleCustomerIds = Array.from(refs.google_ads.accountIds).map((id) => normalizeCustomerId(id)).filter(Boolean);
  const googleCampaignIds = Array.from(refs.google_ads.campaignIds).filter(Boolean);
  if (googleCustomerIds.length && googleCampaignIds.length) {
    const googleRows = await GoogleAdsInsightsDaily.findAll({
      attributes: [
        'customerId',
        'campaignId',
        [fn('SUM', col('costMicros')), 'costMicros'],
        [fn('SUM', col('conversions')), 'conversions']
      ],
      where: {
        customerId: { [Op.in]: googleCustomerIds },
        campaignId: { [Op.in]: googleCampaignIds },
        date: { [Op.between]: [startStr, endStr] },
        ...buildMetricsScopeWhere(scope, { clinicField: 'clinicaId', groupField: 'grupoClinicaId' })
      },
      group: ['customerId', 'campaignId'],
      raw: true
    });

    for (const row of googleRows) {
      const identity = canonicalExternalCampaignIdentity({
        provider: 'google_ads',
        customer_id: row.customerId,
        campaign_id: row.campaignId,
      });
      const key = externalCampaignIdentityKey(identity);
      if (!key || !refs.google_ads.identities.has(key)) continue;
      result.set(key, {
        investment: microsToCurrency(row.costMicros),
        conversions: safeNumber(row.conversions)
      });
    }
  }

  const metaAccountIds = Array.from(refs.meta_ads.accountIds).map((id) => {
    const raw = String(id || '').trim();
    return raw && !raw.startsWith('act_') ? `act_${raw}` : raw;
  }).filter(Boolean);
  const metaCampaignIds = Array.from(refs.meta_ads.campaignIds).filter(Boolean);
  if (metaAccountIds.length && metaCampaignIds.length) {
    const campaignEntities = await SocialAdsEntity.findAll({
      where: {
        level: 'campaign',
        ad_account_id: { [Op.in]: metaAccountIds },
        entity_id: { [Op.in]: metaCampaignIds }
      },
      raw: true
    });
    const entityMap = new Map(campaignEntities.map((row) => [String(row.entity_id || '').trim(), row]));

    const campaignInsightRows = await SocialAdsInsightsDaily.findAll({
      attributes: [
        'ad_account_id',
        'entity_id',
        [fn('SUM', col('spend')), 'spend']
      ],
      where: {
        level: 'campaign',
        ad_account_id: { [Op.in]: metaAccountIds },
        entity_id: { [Op.in]: metaCampaignIds },
        date: { [Op.between]: [startStr, endStr] },
        ...buildMetricsScopeWhere(scope, { clinicField: 'clinica_id', groupField: 'grupo_clinica_id' })
      },
      group: ['ad_account_id', 'entity_id'],
      raw: true
    });

    const adsetRows = await SocialAdsEntity.findAll({
      where: {
        level: 'adset',
        parent_id: { [Op.in]: metaCampaignIds }
      },
      raw: true
    });
    const adsetIds = adsetRows.map((row) => String(row.entity_id || '').trim()).filter(Boolean);
    const adRows = adsetIds.length
      ? await SocialAdsEntity.findAll({
          where: {
            level: 'ad',
            parent_id: { [Op.in]: adsetIds }
          },
          raw: true
        })
      : [];
    const adIds = adRows.map((row) => String(row.entity_id || '').trim()).filter(Boolean);

    const adInsightRows = adIds.length
      ? await SocialAdsInsightsDaily.findAll({
          attributes: [
            'ad_account_id',
            'entity_id',
            'clinica_id',
            'grupo_clinica_id',
            [fn('MAX', col('date')), 'last_seen_at'],
            [fn('SUM', col('impressions')), 'impressions'],
            [fn('SUM', col('clicks')), 'clicks'],
            [fn('SUM', col('spend')), 'spend']
          ],
          where: {
            level: 'ad',
            ad_account_id: { [Op.in]: metaAccountIds },
            entity_id: { [Op.in]: adIds },
            date: { [Op.between]: [startStr, endStr] },
            ...buildMetricsScopeWhere(scope, { clinicField: 'clinica_id', groupField: 'grupo_clinica_id' })
          },
          group: ['ad_account_id', 'entity_id', 'clinica_id', 'grupo_clinica_id'],
          raw: true
        })
      : [];

    const adActionRows = adIds.length
      ? await SocialAdsActionsDaily.findAll({
          attributes: [
            'ad_account_id',
            'entity_id',
            'clinica_id',
            'grupo_clinica_id',
            'action_type',
            [fn('SUM', col('value')), 'value']
          ],
          where: {
            level: 'ad',
            ad_account_id: { [Op.in]: metaAccountIds },
            entity_id: { [Op.in]: adIds },
            date: { [Op.between]: [startStr, endStr] },
            ...buildMetricsScopeWhere(scope, { clinicField: 'clinica_id', groupField: 'grupo_clinica_id' })
          },
          group: ['ad_account_id', 'entity_id', 'clinica_id', 'grupo_clinica_id', 'action_type'],
          raw: true
        })
      : [];

    const adRolledRows = adInsightRows.length
      ? await rollupMetaAdRowsToCampaignRows(adInsightRows, entityMap)
      : [];
    const adRolledActionRows = adActionRows.length
      ? await rollupMetaAdActionRowsToCampaignSignals(adActionRows, entityMap)
      : [];

    const metaMetrics = new Map();
    for (const row of campaignInsightRows) {
      const key = externalCampaignIdentityKey({
        provider: 'meta_ads',
        account_id: row.ad_account_id,
        campaign_id: row.entity_id,
      });
      if (!key || !refs.meta_ads.identities.has(key)) continue;
      metaMetrics.set(key, {
        investment: safeNumber(row.spend),
        conversions: 0
      });
    }
    for (const row of adRolledRows) {
      const key = externalCampaignIdentityKey({
        provider: 'meta_ads',
        account_id: row.ad_account_id,
        campaign_id: row.entity_id,
      });
      if (!key || !refs.meta_ads.identities.has(key)) continue;
      const current = metaMetrics.get(key) || { investment: 0, conversions: 0 };
      metaMetrics.set(key, {
        investment: current.investment > 0 ? current.investment : safeNumber(row.spend),
        conversions: current.conversions
      });
    }
    for (const row of adRolledActionRows) {
      const key = externalCampaignIdentityKey({
        provider: 'meta_ads',
        account_id: row.ad_account_id,
        campaign_id: row.entity_id,
      });
      if (!key || !refs.meta_ads.identities.has(key)) continue;
      const current = metaMetrics.get(key) || { investment: 0, conversions: 0 };
      metaMetrics.set(key, {
        investment: current.investment,
        conversions: current.conversions + safeNumber(row.conversions)
      });
    }
    for (const [key, metrics] of metaMetrics.entries()) {
      result.set(key, metrics);
    }
  }

  return result;
}

function pickLegacyCampaignTypeFromChannels(channels) {
  const top = Array.isArray(channels) && channels.length > 0 ? channels[0].channel : null;
  return top === 'google_ads' ? 'google_ads' : 'meta_ads';
}

function buildStrategyName({ objectiveId, treatments, clinicCount }) {
  const objectiveName = objectiveId === 'new_patients' ? 'Captar Nuevos Pacientes' : objectiveId;
  const treatmentNames = Array.isArray(treatments) ? treatments.map((item) => item.nombre).filter(Boolean) : [];
  const treatmentLabel = treatmentNames.length > 0
    ? treatmentNames.slice(0, 2).join(', ')
    : 'General';
  const scopeLabel = clinicCount > 1 ? ` · ${clinicCount} clínicas` : '';
  return `${objectiveName} · ${treatmentLabel}${scopeLabel}`;
}

function buildStrategyMetrics(campaign, payload) {
  const payloadMetrics = payload?.metrics && typeof payload.metrics === 'object' ? payload.metrics : {};
  const externalMetrics = buildExternalCampaignMetrics(payload);
  const investment = asPositiveNumber(payloadMetrics.investment ?? campaign?.gasto ?? externalMetrics.investment ?? 0);
  const leads = asPositiveNumber(payloadMetrics.leads ?? campaign?.total_leads ?? 0);
  const conversions = asPositiveNumber(payloadMetrics.conversions ?? externalMetrics.conversions ?? 0);
  const revenue = asPositiveNumber(payloadMetrics.revenue ?? 0);

  const cpl = asNullableNumber(
    payloadMetrics.cpl
    ?? campaign?.cpl
    ?? (leads > 0 ? Number((investment / leads).toFixed(2)) : null)
  );
  const costPerConversion = asNullableNumber(
    payloadMetrics.cost_per_conversion
    ?? payloadMetrics.costPerConversion
    ?? (conversions > 0 ? Number((investment / conversions).toFixed(2)) : null)
  );

  return {
    investment,
    leads,
    conversions,
    revenue,
    cpl,
    cost_per_conversion: costPerConversion
  };
}

async function buildLiveStrategyMetrics(rows, campaign, payload) {
  const baseMetrics = buildStrategyMetrics(campaign, payload);
  const scope = extractStrategyScopeFromPayload(payload, rows);
  const currentExternalMetrics = await loadCurrentExternalCampaignMetricsIndex({ scope, payload });
  const currentLeadMetrics = await loadCurrentLeadAttributionMetricsIndex({ scope, payload });

  if (!currentExternalMetrics.size && !currentLeadMetrics.size) {
    return baseMetrics;
  }

  const refs = collectExternalCampaignRefs(payload);
  let liveInvestment = 0;
  let liveConversions = 0;
  let liveLeads = 0;
  let liveCrmConversions = 0;

  for (const key of [
    ...refs.google_ads.identities.keys(),
    ...refs.meta_ads.identities.keys(),
  ]) {
    const metrics = currentExternalMetrics.get(key);
    if (!metrics) continue;
    liveInvestment += safeNumber(metrics.investment);
    liveConversions += safeNumber(metrics.conversions);
  }

  for (const key of [
    ...refs.google_ads.identities.keys(),
    ...refs.meta_ads.identities.keys(),
  ]) {
    const metrics = currentLeadMetrics.get(key);
    if (!metrics) continue;
    liveLeads += safeNumber(metrics.leads);
    liveCrmConversions += safeNumber(metrics.crm_conversions);
  }

  const resolvedInvestment = liveInvestment > 0 ? liveInvestment : baseMetrics.investment;
  const resolvedLeads = liveLeads > 0 ? liveLeads : baseMetrics.leads;
  const resolvedConversions = liveCrmConversions > 0 ? liveCrmConversions : liveConversions;
  const cpl = resolvedLeads > 0
    ? Number((resolvedInvestment / resolvedLeads).toFixed(2))
    : baseMetrics.cpl;

  const costPerConversion = resolvedConversions > 0
    ? Number((resolvedInvestment / resolvedConversions).toFixed(2))
    : baseMetrics.cost_per_conversion;

  return {
    ...baseMetrics,
    investment: resolvedInvestment,
    leads: resolvedLeads,
    conversions: resolvedConversions,
    cpl,
    cost_per_conversion: costPerConversion
  };
}

function buildStrategyItemFromRows(rows, campaignsById) {
  const normalizedRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!normalizedRows.length) return null;

  const orderedRows = [...normalizedRows].sort((a, b) => String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')));
  const representative = orderedRows[0];
  const payload = representative?.solicitud && typeof representative.solicitud === 'object' ? representative.solicitud : {};
  const campaignId = representative.campaign_id || null;
  const campaign = campaignId ? campaignsById.get(campaignId) || null : null;
  const clinicIds = Array.from(new Set(orderedRows.map((row) => parseInteger(row.clinica_id)).filter((value) => value)));
  const mode = payload.mode_snapshot || payload.mode || null;
  const normalizedStatus = normalizeStrategyStatus(payload.status || representative.estado);
  const status = mode === 'connect_only' && (normalizedStatus === 'draft' || normalizedStatus === 'pending_approval')
    ? 'active'
    : normalizedStatus;
  const externalTargets = normalizeExternalTargets(payload.external_targets);
  const targetDestinations = normalizeTargetDestinations(payload.target_destinations);

  return {
    id: campaignId || representative.id,
    request_id: representative.id,
    campaign_id: campaignId,
    name: campaign?.nombre || payload.summary?.name || 'Estrategia',
    objective_id: payload.objective_id || null,
    promotion_type: payload.promotion_type || 'treatment',
    area_medica_id: payload.area_medica_id ?? payload.summary?.area_medica_id ?? null,
    area_medica_nombre: payload.area_medica_nombre ?? payload.summary?.area_medica_nombre ?? null,
    mode,
    status,
    budget_monthly: Number(payload.summary?.budget_monthly ?? campaign?.presupuesto ?? 0) || 0,
    scope_type: payload.scope?.assignment_scope || 'clinic',
    scope_id: payload.scope?.assignment_scope === 'group'
      ? (parseInteger(payload.scope?.group_id) || null)
      : (parseInteger(payload.scope?.clinic_id) || parseInteger(representative.clinica_id) || null),
    clinic_ids: clinicIds,
    treatments: Array.isArray(payload.treatments) ? payload.treatments : [],
    destination: payload.destination && typeof payload.destination === 'object' ? payload.destination : null,
    channels: Array.isArray(payload.channels) ? payload.channels : [],
    measurement: payload.measurement && typeof payload.measurement === 'object' ? payload.measurement : null,
    geo: payload.geo && typeof payload.geo === 'object' ? payload.geo : {},
    automation: payload.automation && typeof payload.automation === 'object' ? payload.automation : null,
    addons: payload.addons && typeof payload.addons === 'object' ? payload.addons : {},
    addon_calls: payload.addons?.call_leads === true,
    external_targets: externalTargets,
    target_destinations: targetDestinations,
    target_summaries: buildTargetSummaries(externalTargets, targetDestinations),
    metrics: buildStrategyMetrics(campaign, payload),
    created_at: representative.created_at,
    updated_at: representative.updated_at || representative.created_at
  };
}

async function loadCampaignsByIds(campaignIds) {
  const uniqueIds = Array.from(new Set((campaignIds || []).map((id) => parseInteger(id)).filter((id) => id)));
  if (!uniqueIds.length) {
    return new Map();
  }

  const campaigns = await Campaign.findAll({
    where: { id: { [Op.in]: uniqueIds } },
    raw: true
  });
  return new Map(campaigns.map((item) => [item.id, item]));
}

async function loadStrategyRowsByIdentifier(strategyId) {
  const numericId = parseInteger(strategyId);
  if (!numericId) {
    return [];
  }

  const campaignRows = await CampaignRequest.findAll({
    where: { campaign_id: numericId },
    order: [['updated_at', 'DESC'], ['created_at', 'DESC']],
    raw: true
  });
  if (campaignRows.length > 0) {
    return campaignRows;
  }

  const directRequest = await CampaignRequest.findByPk(numericId, { raw: true });
  return directRequest ? [directRequest] : [];
}

async function requireMarketingClinicScope(req, res, clinicIds, access = 'read') {
  const allowed = await hasMarketingClinicScopeAccess({
    userId: getUserId(req),
    clinicIds,
    access
  });
  if (allowed) return true;

  res.status(403).json({
    success: false,
    error: 'scope_forbidden',
    message: 'No tienes acceso a todas las clínicas de esta configuración.'
  });
  return false;
}

async function resolveOnboardingClinicIds(record, payload) {
  const scope = payload?.scope && typeof payload.scope === 'object' ? payload.scope : {};
  const assignmentScope = String(scope.assignment_scope || '').trim().toLowerCase();
  const groupId = parseInteger(scope.group_id);
  if (assignmentScope === 'group' && groupId) {
    return listClinicIdsForGroup(groupId);
  }

  return normalizeClinicIds([
    scope.clinic_id,
    ...(Array.isArray(scope.clinic_ids) ? scope.clinic_ids : []),
    record?.clinica_id
  ]);
}

async function resolveModeForClinic(clinicId) {
  if (!clinicId) return null;
  const clinic = await Clinica.findOne({
    where: { id_clinica: clinicId },
    attributes: ['id_clinica', 'grupoClinicaId'],
    raw: true
  });

  if (!clinic) return null;

  return resolveActiveModeForScope({
    assignment_scope: 'clinic',
    clinic_id: clinic.id_clinica,
    group_id: clinic.grupoClinicaId || null,
    clinics: [],
    clinic_ids: [clinic.id_clinica],
    group: null
  });
}

async function findBlockingStrategyConflicts(clinicIds, { excludeCampaignId = null, excludeRequestIds = [] } = {}) {
  if (!Array.isArray(clinicIds) || clinicIds.length === 0) return [];

  const rows = await CampaignRequest.findAll({
    where: {
      clinica_id: { [Op.in]: clinicIds }
    },
    attributes: ['id', 'clinica_id', 'campaign_id', 'solicitud', 'estado', 'created_at', 'updated_at'],
    order: [['created_at', 'DESC']],
    raw: true
  });

  return rows
    .filter((row) => {
      const payload = row?.solicitud && typeof row.solicitud === 'object' ? row.solicitud : {};
      if (payload.kind !== 'marketing_strategy') {
        return false;
      }

      if (excludeCampaignId && parseInteger(row.campaign_id) === parseInteger(excludeCampaignId)) {
        return false;
      }

      if (excludeRequestIds.includes(parseInteger(row.id))) {
        return false;
      }

      const status = normalizeStrategyStatus(payload.status || row.estado);
      return status !== 'completed';
    })
    .map((row) => ({
      request_id: row.id,
      clinica_id: row.clinica_id,
      campaign_id: row.campaign_id || null,
      status: normalizeStrategyStatus((row?.solicitud || {}).status || row.estado)
    }));
}

async function findExternalCampaignAssignmentConflicts(clinicIds, externalTargets, { excludeRequestIds = [] } = {}) {
  if (!Array.isArray(clinicIds) || clinicIds.length === 0) return [];

  const requestedKeys = new Set();
  for (const target of normalizeExternalTargets(externalTargets)) {
    for (const campaign of target.campaigns) {
      const key = externalCampaignIdentityKey(campaign);
      if (key) requestedKeys.add(key);
    }
  }

  if (!requestedKeys.size) {
    return [];
  }

  const rows = await CampaignRequest.findAll({
    where: {
      clinica_id: { [Op.in]: clinicIds }
    },
    attributes: ['id', 'clinica_id', 'campaign_id', 'solicitud', 'estado', 'created_at', 'updated_at'],
    order: [['updated_at', 'DESC'], ['created_at', 'DESC']],
    raw: true
  });

  const conflicts = [];
  const seen = new Set();

  for (const row of rows) {
    const requestId = parseInteger(row.id);
    if (excludeRequestIds.includes(requestId)) {
      continue;
    }

    const payload = row?.solicitud && typeof row.solicitud === 'object' ? row.solicitud : {};
    if (payload.kind !== 'marketing_strategy') {
      continue;
    }

    const status = normalizeStrategyStatus(payload.status || row.estado);
    if (status === 'completed') {
      continue;
    }

    const rowTargets = normalizeExternalTargets(payload.external_targets);
    for (const target of rowTargets) {
      for (const campaign of target.campaigns) {
        const identity = canonicalExternalCampaignIdentity(campaign);
        const key = externalCampaignIdentityKey(identity);
        if (!identity || !key) continue;
        if (!requestedKeys.has(key) || seen.has(`${requestId}:${key}`)) {
          continue;
        }
        seen.add(`${requestId}:${key}`);
        conflicts.push({
          request_id: requestId,
          clinica_id: parseInteger(row.clinica_id) || null,
          strategy_campaign_id: parseInteger(row.campaign_id) || null,
          status,
          provider: identity.provider,
          account_id: identity.account_id,
          customer_id: identity.customer_id,
          campaign_id: identity.campaign_id,
          external_campaign_id: identity.external_campaign_id,
          target_kind: target.kind,
          treatment_id: target.treatment_id || null,
          treatment_name: target.treatment_name || null
        });
      }
    }
  }

  return conflicts;
}

async function findMappedGoogleAccountsForScope(connectionId, scope) {
  const where = {
    googleConnectionId: connectionId,
    isActive: true,
    ...buildScopeWhere(scope)
  };
  const rows = await ClinicGoogleAdsAccount.findAll({
    where,
    order: [['updated_at', 'DESC']],
    raw: true
  });

  const byCustomer = new Map();
  for (const row of rows) {
    const customerId = normalizeCustomerId(row.customerId || '');
    if (!customerId || byCustomer.has(customerId)) continue;
    byCustomer.set(customerId, {
      customer_id: customerId,
      formatted_customer_id: formatCustomerId(customerId),
      descriptive_name: row.descriptiveName || null,
      currency_code: row.currencyCode || null,
      time_zone: row.timeZone || null,
      is_linked: row.managerLinkStatus === 'ACTIVE',
      manager_link_status: row.managerLinkStatus || null,
      mapped_to_scope: true,
      login_customer_id: normalizeCustomerId(row.loginCustomerId || row.managerCustomerId || '') || null
    });
  }

  return Array.from(byCustomer.values());
}

async function findMappedMetaAssetsForScope(metaConnectionId, scope) {
  const where = {
    metaConnectionId,
    isActive: true,
    ...buildScopeWhere(scope)
  };
  const rows = await ClinicMetaAsset.findAll({
    where,
    order: [['updatedAt', 'DESC']],
    raw: true
  });
  const adAccounts = [];
  const byAsset = new Set();
  for (const row of rows) {
    if (row.assetType !== 'ad_account') continue;
    const key = String(row.metaAssetId || '');
    if (!key || byAsset.has(key)) continue;
    byAsset.add(key);
    adAccounts.push({
      ad_account_id: key.startsWith('act_') ? key : `act_${key}`,
      name: row.metaAssetName || null,
      mapped_to_scope: true
    });
  }
  return {
    ad_accounts: adAccounts,
    pixels: []
  };
}

async function resolveLoginCustomerId(connectionId, customerId, scope) {
  const where = {
    googleConnectionId: connectionId,
    customerId: normalizeCustomerId(customerId),
    isActive: true,
    ...buildScopeWhere(scope)
  };
  const mapped = await ClinicGoogleAdsAccount.findOne({
    where,
    order: [['updated_at', 'DESC']],
    raw: true
  });
  if (mapped?.loginCustomerId) return normalizeCustomerId(mapped.loginCustomerId);
  if (mapped?.managerCustomerId) return normalizeCustomerId(mapped.managerCustomerId);
  try {
    return ensureGoogleAdsConfig().managerId;
  } catch (_e) {
    return null;
  }
}

async function listConversionActionsInternal({ accessToken, customerId, loginCustomerId }) {
  const cleanCustomer = normalizeCustomerId(customerId);
  if (!cleanCustomer) {
    const err = new Error('customer_id requerido');
    err.httpStatus = 400;
    throw err;
  }

  const query = [
    'SELECT',
    '  conversion_action.id,',
    '  conversion_action.resource_name,',
    '  conversion_action.name,',
    '  conversion_action.category,',
    '  conversion_action.type,',
    '  conversion_action.status,',
    '  conversion_action.include_in_conversions_metric,',
    '  conversion_action.primary_for_goal,',
    '  conversion_action.tag_snippets',
    'FROM conversion_action',
    "WHERE conversion_action.type = 'UPLOAD_CLICKS'"
  ].join('\n');

  const data = await googleAdsRequest('POST', `customers/${cleanCustomer}/googleAds:search`, {
    accessToken,
    loginCustomerId: loginCustomerId || undefined,
    data: { query }
  });

  const rows = Array.isArray(data?.results) ? data.results : [];
  const actions = rows
    .map(mapConversionActionRow)
    .filter((item) => !!item.id && item.status !== 'REMOVED')
    .sort((a, b) => {
      const aEnabled = a.status === 'ENABLED' ? 1 : 0;
      const bEnabled = b.status === 'ENABLED' ? 1 : 0;
      return bEnabled - aEnabled;
    });

  return {
    actions,
    suggested_mapping: buildSuggestedMapping(actions)
  };
}

async function ensureConversionActionsInternal({ accessToken, customerId, loginCustomerId, currency, events, createMissing }) {
  const requestedEvents = listToUniqueArray(
    (Array.isArray(events) && events.length ? events : VALID_EVENTS).filter((key) => VALID_EVENTS.includes(key))
  );
  const current = await listConversionActionsInternal({ accessToken, customerId, loginCustomerId });
  const existingMapping = current.suggested_mapping || {};
  const created = [];
  const existing = [];

  for (const key of requestedEvents) {
    if (existingMapping[key]) {
      const matched = current.actions.find((a) => a.id === existingMapping[key]);
      existing.push({
        event: key,
        id: existingMapping[key],
        name: matched?.name || EVENT_CATALOG[key].name
      });
    }
  }

  if (createMissing) {
    const operations = [];
    const toCreateEvents = [];
    for (const key of requestedEvents) {
      if (existingMapping[key]) continue;
      toCreateEvents.push(key);
      operations.push({
        create: {
          name: EVENT_CATALOG[key].name,
          category: EVENT_CATALOG[key].category,
          type: 'UPLOAD_CLICKS',
          status: 'ENABLED',
          valueSettings: {
            defaultValue: 0,
            alwaysUseDefaultValue: false,
            defaultCurrencyCode: normalizeCurrency(currency)
          },
          countingType: 'ONE_PER_CLICK'
        }
      });
    }

    if (operations.length > 0) {
      const mutate = await googleAdsRequest('POST', `customers/${normalizeCustomerId(customerId)}/conversionActions:mutate`, {
        accessToken,
        loginCustomerId: loginCustomerId || undefined,
        singleAttempt: true,
        timeoutMs: 15000,
        data: { operations }
      });
      const results = Array.isArray(mutate?.results) ? mutate.results : [];
      for (let i = 0; i < toCreateEvents.length; i += 1) {
        const event = toCreateEvents[i];
        const resourceName = results[i]?.resourceName || null;
        const id = resourceName ? String(resourceName).split('/').pop() : null;
        if (!id) continue;
        existingMapping[event] = id;
        created.push({
          event,
          id,
          name: EVENT_CATALOG[event].name
        });
      }
    }
  }

  const recommended = {
    enabled: true,
    customer_id: normalizeCustomerId(customerId),
    conversion_action_id: existingMapping.lead || null,
    conversion_action: existingMapping.lead
      ? `customers/${normalizeCustomerId(customerId)}/conversionActions/${existingMapping.lead}`
      : null,
    send_to: null,
    currency: normalizeCurrency(currency),
    events: {
      lead: {
        enabled: true,
        conversion_action_id: existingMapping.lead || null,
        currency: normalizeCurrency(currency)
      },
      contact: {
        enabled: true,
        conversion_action_id: existingMapping.contact || null,
        currency: normalizeCurrency(currency)
      },
      schedule: {
        enabled: true,
        conversion_action_id: existingMapping.schedule || null,
        currency: normalizeCurrency(currency)
      },
      purchase: {
        enabled: false,
        conversion_action_id: existingMapping.purchase || null,
        currency: normalizeCurrency(currency)
      }
    }
  };

  return {
    created,
    existing,
    mapping: {
      lead: existingMapping.lead || null,
      contact: existingMapping.contact || null,
      schedule: existingMapping.schedule || null,
      purchase: existingMapping.purchase || null
    },
    recommended_google_ads_config: recommended
  };
}

function initSteps(providers) {
  const steps = [];
  if (providers.includes('google_ads')) {
    steps.push(
      { key: 'google_connect', status: 'pending' },
      { key: 'google_map_account', status: 'pending' },
      { key: 'conversion_actions', status: 'pending' },
      { key: 'persist_intake_config', status: 'pending' }
    );
  }
  if (providers.includes('meta_ads')) {
    steps.push(
      { key: 'meta_connect', status: 'pending' },
      { key: 'meta_map_assets', status: 'pending' }
    );
  }
  return steps;
}

function markStep(steps, key, status, extra) {
  const idx = steps.findIndex((s) => s.key === key);
  if (idx < 0) return;
  steps[idx] = {
    ...steps[idx],
    status,
    ...(extra || {})
  };
}

exports.getCampaignOnboardingBootstrap = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const scope = await resolveScopeFromInput({
    clinicIdRaw: req.query.clinic_id,
    groupIdRaw: req.query.group_id,
    assignmentScopeRaw: req.query.assignment_scope
  });
  if (!(await requireMarketingClinicScope(req, res, scope.clinic_ids, 'read'))) return;
  const activeMode = await resolveActiveModeForScope(scope);
  const scopedRequest = Boolean(scope.clinic_id || scope.group_id);
  const marketingState = await resolveEffectiveMarketingState({
    clinicIdRaw: scope.clinic_id,
    groupIdRaw: scope.group_id,
    assignmentScopeRaw: scope.assignment_scope
  });
  const intakeRecord = scope.assignment_scope === 'group'
    ? marketingState.records.groupRecord
    : (marketingState.records.clinicRecord || marketingState.records.groupRecord);
  const intakeGoogleAds = normalizeGoogleAdsConfig(marketingState.tracking.google_ads || {});
  const intakeMetaAds = normalizeMetaAdsConfig(marketingState.tracking.meta_ads || {});

  let googleConnected = false;
  let googleReason = null;
  let hasAdsScope = false;
  let googleAccounts = marketingState.google.available_accounts || [];
  let selectedCustomerId = marketingState.google.effective_assets?.account?.customer_id || intakeGoogleAds.customer_id || null;

  const googleResolved = await resolveGoogleConnectionForScope({
    userId,
    clinicIdRaw: scope.clinic_id,
    groupIdRaw: scope.group_id,
    assignmentScopeRaw: scope.assignment_scope,
    allowLegacyUserFallback: !scopedRequest
  });
  const googleConnection = googleResolved.connection;
  if (!googleConnection) {
    googleReason = 'no_connection';
  } else {
    hasAdsScope = hasScopeText(googleConnection.scopes || '', GOOGLE_ADS_SCOPE);
    if (!hasAdsScope) {
      googleReason = 'insufficient_scope';
    } else {
      try {
        await ensureGoogleAdsAccess(googleConnection);
        googleConnected = true;
      } catch (err) {
        googleReason = err.code === 'TOKEN_EXPIRED' || err.code === 'REFRESH_FAILED'
          ? 'token_expired'
          : err.code === 'ADS_CONFIG_MISSING'
            ? 'config_missing'
            : 'token_error';
      }
    }
  }

  if (!selectedCustomerId && googleAccounts.length > 0) {
    selectedCustomerId = googleAccounts[0].customer_id;
  }

  let metaConnected = false;
  let metaReason = null;
  const metaAssets = marketingState.meta.available_assets || {
    ad_accounts: [],
    facebook_pages: [],
    instagram_business: []
  };
  const metaResolved = await resolveMetaConnectionForScope({
    userId,
    clinicIdRaw: scope.clinic_id,
    groupIdRaw: scope.group_id,
    assignmentScopeRaw: scope.assignment_scope,
    allowLegacyUserFallback: !scopedRequest
  });
  const metaConnection = metaResolved.connection;
  if (!metaConnection) {
    metaReason = 'no_connection';
  } else {
    metaConnected = true;
  }

  const capiMissing = [];
  if (!metaAssets.ad_accounts.length) capiMissing.push('ad_account_mapping');
  if (!marketingState.meta.effective_assets?.pixel?.pixel_id && !process.env.META_PIXEL_ID) capiMissing.push('pixel_id');
  if (!(intakeRecord?.hmac_key || '').trim()) capiMissing.push('intake_hmac_key');

  return res.json({
    success: true,
    scope: {
      assignment_scope: scope.assignment_scope,
      clinic_id: scope.clinic_id || null,
      group_id: scope.group_id || null,
      clinic_website_url: scope.assignment_scope === 'clinic'
        ? (scope.clinics?.[0]?.url_web || null)
        : null,
      group_web_primary_url: scope.group?.web_primary_url || null,
      group_web_assignment_mode: scope.group?.web_assignment_mode || null
    },
    modes: ['connect_only', 'managed_service'],
    legacy_modes: ['managed_self'],
    active_mode: activeMode,
    google_ads: {
      connected: googleConnected,
      reason: googleReason,
      connected_via: mapConnectionSourceToOrigin(googleResolved?.source),
      connection_source: googleResolved?.source || null,
      source_scope_name: mapConnectionSourceToOrigin(googleResolved?.source) === 'group'
        ? (marketingState.descriptors.group_name || null)
        : (marketingState.descriptors.clinic_name || null),
      manager_id: (() => {
        try {
          return formatCustomerId(ensureGoogleAdsConfig().managerId);
        } catch (_e) {
          return null;
        }
      })(),
      accounts: googleAccounts,
      selected_customer_id: selectedCustomerId,
      intake_google_ads: intakeGoogleAds,
      effective_assets: {
        customer_id: marketingState.google.effective_assets?.account?.customer_id || null,
        descriptive_name: marketingState.google.effective_assets?.account?.descriptive_name || null,
        assignment_origin: marketingState.google.effective_assets?.account?.assignment_origin || null,
        send_to: intakeGoogleAds.send_to || null,
        tag_id: marketingState.google.effective_assets?.tag_id || extractGoogleTagId(intakeGoogleAds.send_to)
      },
      capabilities: buildGoogleAdsCapabilities(googleConnected, hasAdsScope)
    },
    meta_ads: {
      connected: metaConnected,
      reason: metaReason,
      connected_via: mapConnectionSourceToOrigin(metaResolved?.source),
      connection_source: metaResolved?.source || null,
      source_scope_name: mapConnectionSourceToOrigin(metaResolved?.source) === 'group'
        ? (marketingState.descriptors.group_name || null)
        : (marketingState.descriptors.clinic_name || null),
      ad_accounts: metaAssets.ad_accounts,
      facebook_pages: metaAssets.facebook_pages,
      instagram_business: metaAssets.instagram_business,
      pixels: [],
      intake_meta_ads: intakeMetaAds,
      selected_ad_account_id: marketingState.meta.effective_assets?.ad_account?.ad_account_id || null,
      selected_pixel_id: marketingState.meta.effective_assets?.pixel?.pixel_id || null,
      effective_assets: {
        ad_account_id: marketingState.meta.effective_assets?.ad_account?.ad_account_id || null,
        ad_account_name: marketingState.meta.effective_assets?.ad_account?.name || null,
        ad_account_origin: marketingState.meta.effective_assets?.ad_account?.assignment_origin || null,
        facebook_page_id: marketingState.meta.effective_assets?.facebook_page?.page_id || null,
        facebook_page_name: marketingState.meta.effective_assets?.facebook_page?.name || null,
        facebook_page_origin: marketingState.meta.effective_assets?.facebook_page?.assignment_origin || null,
        pixel_id: marketingState.meta.effective_assets?.pixel?.pixel_id || null,
        pixel_origin: marketingState.meta.effective_assets?.pixel?.assignment_origin || null
      },
      capi_readiness: {
        ready: capiMissing.length === 0,
        missing: capiMissing
      }
    }
  });
});

exports.listMetaPixels = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const adAccountId = normalizeMetaAdAccountId(req.query.ad_account_id || req.query.adAccountId);
  if (!adAccountId) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'ad_account_id requerido' });
  }

  const scope = await resolveScopeFromInput({
    clinicIdRaw: req.query.clinic_id,
    groupIdRaw: req.query.group_id,
    assignmentScopeRaw: req.query.assignment_scope
  });
  if (!(await requireMarketingClinicScope(req, res, scope.clinic_ids, 'read'))) return;

  const pixels = await listMetaPixelsForScopeAdAccount({
    scope,
    adAccountId
  });

  return res.json({
    success: true,
    ad_account_id: adAccountId,
    pixels
  });
});

exports.listStrategyCatalog = asyncHandler(async (req, res) => {
  const objectiveId = String(req.query.objective_id || '').trim().toLowerCase();

  if (objectiveId && !VALID_STRATEGY_OBJECTIVES.has(objectiveId)) {
    return res.status(400).json({ success: false, error: 'invalid_objective_id' });
  }

  const where = { status: 'active' };
  if (objectiveId) {
    where.objective_id = objectiveId;
  }

  const items = await AdminCampaignPlaybook.findAll({
    where,
    include: [{
      model: Tratamiento,
      as: 'treatment',
      attributes: ['id_tratamiento', 'nombre', 'codigo', 'disciplina', 'categoria'],
      required: false
    }],
    order: [['display_name', 'ASC'], ['created_at', 'DESC']]
  });

  return res.json({
    success: true,
    items: items.map(serializeStrategyCatalogItem)
  });
});

exports.listExternalCampaigns = asyncHandler(async (req, res) => {
  const scope = await resolveScopeFromInput({
    clinicIdRaw: req.query.clinic_id,
    groupIdRaw: req.query.group_id,
    assignmentScopeRaw: req.query.assignment_scope
  });
  if (!(await requireMarketingClinicScope(req, res, scope.clinic_ids, 'read'))) return;

  const providerFilter = String(req.query.provider || '').trim().toLowerCase();
  const includeGoogle = !providerFilter || providerFilter === 'google_ads';
  const includeMeta = !providerFilter || providerFilter === 'meta_ads';
  if (providerFilter && !includeGoogle && !includeMeta) {
    return res.status(400).json({ success: false, error: 'invalid_provider' });
  }

  const activeOnly = String(req.query.active_only || 'true').trim().toLowerCase() !== 'false';
  const end = parseDate(req.query.end_date, (() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  })());
  const daysRaw = parseInteger(req.query.days) || 30;
  const days = Math.max(1, Math.min(180, daysRaw));
  const start = parseDate(req.query.start_date, new Date(end.getTime() - (days - 1) * 86400000));
  const startStr = formatDate(start);
  const endStr = formatDate(end);

  const googleWhere = buildScopeWhere(scope);
  const googleAccounts = includeGoogle
    ? await ClinicGoogleAdsAccount.findAll({
      where: { isActive: true, ...googleWhere },
      raw: true
    })
    : [];
  const googleAccountMap = new Map();
  for (const row of googleAccounts) {
    const customerId = normalizeCustomerId(row.customerId || '');
    if (!customerId || googleAccountMap.has(customerId)) continue;
    googleAccountMap.set(customerId, {
      customer_id: customerId,
      formatted_customer_id: formatCustomerId(customerId),
      descriptive_name: row.descriptiveName || null
    });
  }

  let googleCampaigns = [];
  if (includeGoogle && googleAccountMap.size > 0) {
    const customerIds = Array.from(googleAccountMap.keys());
    const reviewedAssignments = ExternalCampaignAssignment
      ? await ExternalCampaignAssignment.findAll({
          where: {
            provider: 'google_ads',
            customer_id: { [Op.in]: customerIds },
            status: 'active'
          },
          raw: true
        })
      : [];
    const reviewedByCampaign = new Map(reviewedAssignments.map((row) => [
      `${normalizeCustomerId(row.customer_id || '')}:${String(row.campaign_id || '')}`,
      row
    ]));
    const rows = await GoogleAdsInsightsDaily.findAll({
      attributes: [
        'customerId',
        'campaignId',
        'clinicaId',
        'grupoClinicaId',
        [fn('MAX', col('campaignName')), 'campaignName'],
        [fn('MAX', col('campaignStatus')), 'campaignStatus'],
        [fn('MAX', col('date')), 'last_seen_at'],
        [fn('SUM', col('impressions')), 'impressions'],
        [fn('SUM', col('clicks')), 'clicks'],
        [fn('SUM', col('costMicros')), 'costMicros'],
        [fn('SUM', col('conversions')), 'conversions']
      ],
      where: {
        customerId: { [Op.in]: customerIds },
        date: { [Op.between]: [startStr, endStr] },
        ...buildMetricsScopeWhere(scope, { clinicField: 'clinicaId', groupField: 'grupoClinicaId' })
      },
      group: ['customerId', 'campaignId', 'clinicaId', 'grupoClinicaId'],
      order: [[literal('SUM(costMicros)'), 'DESC']],
      raw: true
    });

    const scopedRows = rows
      .map((row) => {
        const assignment = reviewedByCampaign.get(`${normalizeCustomerId(row.customerId || '')}:${String(row.campaignId || '')}`);
        return assignment
          ? {
              ...row,
              clinicaId: Number(assignment.clinica_id) || null,
              grupoClinicaId: Number(assignment.grupo_clinica_id) || row.grupoClinicaId || null,
              reviewed_assignment: true,
              reviewed_match_kind: assignment.match_kind || null
            }
          : row;
      })
      .filter((row) => (
        scope.assignment_scope === 'group'
        || (row.reviewed_assignment && Number(row.clinicaId) === Number(scope.clinic_id))
        || (!row.reviewed_assignment && Number(row.clinicaId) === Number(scope.clinic_id))
      ));

    googleCampaigns = reduceExternalCampaignRows(scopedRows.map((row) => ({
      ...row,
      spend: microsToCurrency(row.costMicros)
    })), {
      provider: 'google_ads',
      accountKey: 'customerId',
      idKey: 'campaignId',
      nameKey: 'campaignName',
      statusKey: 'campaignStatus',
      extraMapper: (row) => ({
        account_name: googleAccountMap.get(normalizeCustomerId(row.customerId || ''))?.descriptive_name || null
      })
    }).filter((item) => !activeOnly || isGoogleCampaignActive(item.status))
      .map((item) => ({
        ...item,
        destination_detection: createWebDestinationDetection('google_ads_default', 'medium')
      }));

    if (ExternalCampaignInventory) {
      const inventoryRows = await ExternalCampaignInventory.findAll({
        where: {
          provider: 'google_ads',
          customer_id: { [Op.in]: customerIds }
        },
        raw: true,
        order: [['campaign_name', 'ASC']]
      });
      const existingKeys = new Set(googleCampaigns.map((item) => `${normalizeCustomerId(item.account_id)}:${item.external_campaign_id}`));
      for (const inventory of inventoryRows) {
        const key = `${normalizeCustomerId(inventory.customer_id)}:${String(inventory.campaign_id)}`;
        if (existingKeys.has(key)) continue;
        const assignment = reviewedByCampaign.get(key);
        if (
          scope.assignment_scope !== 'group'
          && (!assignment || Number(assignment.clinica_id) !== Number(scope.clinic_id))
        ) {
          continue;
        }
        if (activeOnly && !isGoogleCampaignActive(inventory.status)) continue;
        googleCampaigns.push({
          provider: 'google_ads',
          account_id: normalizeCustomerId(inventory.customer_id),
          account_name: inventory.account_name || googleAccountMap.get(normalizeCustomerId(inventory.customer_id))?.descriptive_name || null,
          external_campaign_id: String(inventory.campaign_id),
          name: inventory.campaign_name || null,
          status: inventory.status || null,
          clinic_ids: assignment?.clinica_id ? [Number(assignment.clinica_id)] : [],
          group_ids: assignment?.grupo_clinica_id ? [Number(assignment.grupo_clinica_id)] : (scope.group_id ? [Number(scope.group_id)] : []),
          assignment_origin: assignment ? 'reviewed' : 'inventory',
          metrics: inventory.latest_metrics && typeof inventory.latest_metrics === 'object'
            ? {
                impressions: safeNumber(inventory.latest_metrics.impressions),
                clicks: safeNumber(inventory.latest_metrics.clicks),
                spend: safeNumber(inventory.latest_metrics.spend),
                conversions: safeNumber(inventory.latest_metrics.conversions)
              }
            : { impressions: 0, clicks: 0, spend: 0, conversions: 0 },
          last_seen_at: inventory.last_seen_at || null,
          destination_detection: inventory.destination_detection || createWebDestinationDetection('google_ads_inventory', 'medium')
        });
        existingKeys.add(key);
      }
      googleCampaigns.sort((left, right) => safeNumber(right.metrics?.spend) - safeNumber(left.metrics?.spend) || String(left.name || '').localeCompare(String(right.name || '')));
    }
  }

  const metaWhere = buildScopeWhere(scope);
  const metaAssets = includeMeta
    ? await ClinicMetaAsset.findAll({
      where: {
        isActive: true,
        assetType: 'ad_account',
        ...metaWhere
      },
      raw: true
    })
    : [];
  const metaAccountMap = new Map();
  for (const row of metaAssets) {
    const rawId = String(row.metaAssetId || '').trim();
    if (!rawId) continue;
    const adAccountId = rawId.startsWith('act_') ? rawId : `act_${rawId}`;
    if (!metaAccountMap.has(adAccountId)) {
      metaAccountMap.set(adAccountId, {
        ad_account_id: adAccountId,
        name: row.metaAssetName || null,
        clinicaId: row.clinicaId || null,
        grupoClinicaId: row.grupoClinicaId || null
      });
    }
  }

  let metaCampaigns = [];
  if (includeMeta && metaAccountMap.size > 0) {
    const campaignInsightRows = await SocialAdsInsightsDaily.findAll({
      attributes: [
        'ad_account_id',
        'entity_id',
        'clinica_id',
        'grupo_clinica_id',
        [fn('MAX', col('date')), 'last_seen_at'],
        [fn('SUM', col('impressions')), 'impressions'],
        [fn('SUM', col('clicks')), 'clicks'],
        [fn('SUM', col('spend')), 'spend']
      ],
      where: {
        level: 'campaign',
        ad_account_id: { [Op.in]: Array.from(metaAccountMap.keys()) },
        date: { [Op.between]: [startStr, endStr] },
        ...buildMetricsScopeWhere(scope, { clinicField: 'clinica_id', groupField: 'grupo_clinica_id' })
      },
      group: ['ad_account_id', 'entity_id', 'clinica_id', 'grupo_clinica_id'],
      order: [[literal('SUM(spend)'), 'DESC']],
      raw: true
    });

    const adInsightRows = await SocialAdsInsightsDaily.findAll({
      attributes: [
        'ad_account_id',
        'entity_id',
        'clinica_id',
        'grupo_clinica_id',
        [fn('MAX', col('date')), 'last_seen_at'],
        [fn('SUM', col('impressions')), 'impressions'],
        [fn('SUM', col('clicks')), 'clicks'],
        [fn('SUM', col('spend')), 'spend']
      ],
      where: {
        level: 'ad',
        ad_account_id: { [Op.in]: Array.from(metaAccountMap.keys()) },
        date: { [Op.between]: [startStr, endStr] },
        ...buildMetricsScopeWhere(scope, { clinicField: 'clinica_id', groupField: 'grupo_clinica_id' })
      },
      group: ['ad_account_id', 'entity_id', 'clinica_id', 'grupo_clinica_id'],
      order: [[literal('SUM(spend)'), 'DESC']],
      raw: true
    });

    const adActionRows = await SocialAdsActionsDaily.findAll({
      attributes: [
        'ad_account_id',
        'entity_id',
        'clinica_id',
        'grupo_clinica_id',
        'action_type',
        [fn('SUM', col('value')), 'value']
      ],
      where: {
        level: 'ad',
        ad_account_id: { [Op.in]: Array.from(metaAccountMap.keys()) },
        date: { [Op.between]: [startStr, endStr] },
        ...buildMetricsScopeWhere(scope, { clinicField: 'clinica_id', groupField: 'grupo_clinica_id' })
      },
      group: ['ad_account_id', 'entity_id', 'clinica_id', 'grupo_clinica_id', 'action_type'],
      raw: true
    });
    const adMetricsByEntityId = new Map();
    for (const row of adInsightRows) {
      const entityId = String(row.entity_id || '').trim();
      if (!entityId) continue;
      adMetricsByEntityId.set(entityId, {
        spend: safeNumber(row.spend),
        clicks: safeNumber(row.clicks),
        last_seen_at: row.last_seen_at || null
      });
    }

    const entities = await SocialAdsEntity.findAll({
      where: {
        level: 'campaign',
        ad_account_id: { [Op.in]: Array.from(metaAccountMap.keys()) }
      },
      raw: true
    });
    const campaignIds = entities.map((row) => String(row.entity_id || '').trim()).filter(Boolean);
    const adsetRows = campaignIds.length
      ? await SocialAdsEntity.findAll({
          where: {
            level: 'adset',
            parent_id: { [Op.in]: campaignIds }
          },
          raw: true
        })
      : [];
    const adsetIds = adsetRows.map((row) => String(row.entity_id || '').trim()).filter(Boolean);
    const adRows = adsetIds.length
      ? await SocialAdsEntity.findAll({
          where: {
            level: 'ad',
            parent_id: { [Op.in]: adsetIds }
          },
          raw: true
        })
      : [];
    const adsetToCampaign = new Map(adsetRows.map((row) => [String(row.entity_id || '').trim(), String(row.parent_id || '').trim()]));
    const campaignAdRows = new Map();
    for (const row of adRows) {
      const campaignId = adsetToCampaign.get(String(row.parent_id || '').trim()) || null;
      if (!campaignId) continue;
      if (!campaignAdRows.has(campaignId)) {
        campaignAdRows.set(campaignId, []);
      }
      campaignAdRows.get(campaignId).push({
        ...row,
        __metrics: adMetricsByEntityId.get(String(row.entity_id || '').trim()) || null
      });
    }
    for (const rows of campaignAdRows.values()) {
      rows.sort((a, b) => {
        const spendDiff = safeNumber(b?.__metrics?.spend) - safeNumber(a?.__metrics?.spend);
        if (spendDiff !== 0) return spendDiff;
        const clickDiff = safeNumber(b?.__metrics?.clicks) - safeNumber(a?.__metrics?.clicks);
        if (clickDiff !== 0) return clickDiff;
        return String(b?.__metrics?.last_seen_at || b?.updated_time || '').localeCompare(String(a?.__metrics?.last_seen_at || a?.updated_time || ''));
      });
    }
    const entityMap = new Map(entities.map((row) => [String(row.entity_id), row]));
    const rowsByEntityId = new Map();
    for (const row of campaignInsightRows) {
      rowsByEntityId.set(String(row.entity_id || ''), row);
    }
    const adRolledRows = await rollupMetaAdRowsToCampaignRows(adInsightRows, entityMap);
    const adRolledActionRows = await rollupMetaAdActionRowsToCampaignSignals(adActionRows, entityMap);
    const adRowsByEntityId = new Map();
    for (const row of adRolledRows) {
      const entityId = String(row.entity_id || '').trim();
      if (!entityId) continue;
      if (!adRowsByEntityId.has(entityId)) {
        adRowsByEntityId.set(entityId, []);
      }
      adRowsByEntityId.get(entityId).push(row);
    }
    const actionRowsByEntityId = new Map();
    for (const row of adRolledActionRows) {
      const entityId = String(row.entity_id || '').trim();
      if (!entityId) continue;
      if (!actionRowsByEntityId.has(entityId)) {
        actionRowsByEntityId.set(entityId, []);
      }
      actionRowsByEntityId.get(entityId).push(row);
    }

    const stitchedRows = [];
    for (const entity of entities) {
      const entityId = String(entity.entity_id || '').trim();
      const campaignRows = rowsByEntityId.has(entityId)
        ? [rowsByEntityId.get(entityId)]
        : (adRowsByEntityId.get(entityId) || [null]);
      const assetScope = metaAccountMap.get(String(entity.ad_account_id || '')) || {};
      for (const existing of campaignRows) {
        stitchedRows.push({
          ad_account_id: entity.ad_account_id,
          entity_id: entity.entity_id,
          clinica_id: existing?.clinica_id ?? assetScope.clinicaId ?? null,
          grupo_clinica_id: existing?.grupo_clinica_id ?? assetScope.grupoClinicaId ?? null,
          impressions: existing?.impressions ?? 0,
          clicks: existing?.clicks ?? 0,
          spend: existing?.spend ?? 0,
          conversions: existing?.conversions ?? 0,
          last_seen_at: existing?.last_seen_at || entity.updated_time || entity.updated_at || null,
          campaignName: entity.name || null,
          campaignStatus: entity.effective_status || entity.status || null,
          objective: entity.objective || null
        });
      }
    }

    metaCampaigns = reduceExternalCampaignRows(stitchedRows, {
      provider: 'meta_ads',
      accountKey: 'ad_account_id',
      idKey: 'entity_id',
      nameKey: 'campaignName',
      statusKey: 'campaignStatus',
      extraMapper: (row) => ({
        account_name: metaAccountMap.get(String(row.ad_account_id || ''))?.name || null,
        objective: row.objective || null
      })
    }).filter((item) => !activeOnly || isMetaCampaignActive(item.status))
      .map((item) => {
        const entityId = String(item.external_campaign_id || '').trim();
        const actionTotals = summarizeMetaCampaignActions(actionRowsByEntityId.get(entityId) || []);
        return {
          ...item,
          destination_detection: inferMetaDestinationDetection({ actionTotals })
        };
      });

    const metaResolved = await resolveMetaConnectionForScope({
      clinicIdRaw: scope.clinic_id,
      groupIdRaw: scope.group_id,
      assignmentScopeRaw: scope.assignment_scope,
      allowLegacyUserFallback: true
    });
    metaCampaigns = await enrichMetaCampaignDetections({
      campaigns: metaCampaigns,
      accessToken: metaResolved?.connection?.accessToken || null,
      campaignAdRows
    });
  }

  return res.json({
    success: true,
    scope: {
      assignment_scope: scope.assignment_scope,
      clinic_id: scope.clinic_id || null,
      group_id: scope.group_id || null,
      clinic_ids: scope.clinic_ids || []
    },
    period: {
      start: startStr,
      end: endStr,
      days
    },
    providers: {
      google_ads: {
        available: googleAccountMap.size > 0,
        campaigns: googleCampaigns
      },
      meta_ads: {
        available: metaAccountMap.size > 0,
        campaigns: metaCampaigns
      }
    }
  });
});

exports.listGoogleAdsConversionActions = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const customerId = normalizeCustomerId(req.query.customer_id || '');
  if (!customerId) return res.status(400).json({ success: false, error: 'customer_id_required' });
  if (!req.query.clinic_id && !req.query.group_id) {
    return res.status(400).json({ success: false, error: 'scope_required' });
  }

  const scope = await resolveScopeFromInput({
    clinicIdRaw: req.query.clinic_id,
    groupIdRaw: req.query.group_id,
    assignmentScopeRaw: req.query.assignment_scope
  });
  if (!(await requireMarketingClinicScope(req, res, scope.clinic_ids, 'read'))) return;

  let runtime;
  try {
    runtime = await resolveScopedGoogleAdsRuntime({
      userId,
      clinicId: scope.clinic_id,
      groupId: scope.group_id,
      assignmentScope: scope.assignment_scope,
      customerId
    });
  } catch (error) {
    return res.status(error.httpStatus || 409).json({
      success: false,
      error: String(error.code || 'scoped_google_connection_error').toLowerCase(),
      message: error.message
    });
  }

  const result = await listConversionActionsInternal({
    accessToken: runtime.accessToken,
    customerId,
    loginCustomerId: runtime.loginCustomerId
  });
  return res.json({
    success: true,
    customer_id: customerId,
    connection_source: runtime.connectionSource,
    actions: result.actions,
    suggested_mapping: result.suggested_mapping
  });
});

exports.ensureGoogleAdsConversionActions = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const customerId = normalizeCustomerId(req.body?.customer_id || '');
  if (!customerId) return res.status(400).json({ success: false, error: 'invalid_customer_id' });
  if (!req.body?.clinic_id && !req.body?.group_id) {
    return res.status(400).json({ success: false, error: 'scope_required' });
  }

  const currency = normalizeCurrency(req.body?.currency || 'EUR');
  const createMissing = req.body?.create_missing === true;
  if (createMissing && req.body?.confirm_external_mutation !== true) {
    return res.status(409).json({
      success: false,
      error: 'external_mutation_confirmation_required',
      message: 'Confirma explícitamente la creación de conversiones en Google Ads.'
    });
  }
  const events = Array.isArray(req.body?.events) && req.body.events.length
    ? req.body.events.map((e) => String(e || '').trim().toLowerCase())
    : VALID_EVENTS;

  const scope = await resolveScopeFromInput({
    clinicIdRaw: req.body?.clinic_id,
    groupIdRaw: req.body?.group_id,
    assignmentScopeRaw: req.body?.assignment_scope
  });
  if (!(await requireMarketingClinicScope(req, res, scope.clinic_ids, 'write'))) return;

  let runtime;
  try {
    runtime = await resolveScopedGoogleAdsRuntime({
      userId,
      clinicId: scope.clinic_id,
      groupId: scope.group_id,
      assignmentScope: scope.assignment_scope,
      customerId
    });
  } catch (error) {
    return res.status(error.httpStatus || 409).json({
      success: false,
      error: String(error.code || 'scoped_google_connection_error').toLowerCase(),
      message: error.message
    });
  }

  const ensured = await ensureConversionActionsInternal({
    accessToken: runtime.accessToken,
    customerId,
    loginCustomerId: runtime.loginCustomerId,
    currency,
    events,
    createMissing
  });

  if (scope.clinic_id || scope.group_id) {
    await upsertIntakeGoogleAdsForScope(scope, {
      ...ensured.recommended_google_ads_config,
      enabled: true,
      customer_id: customerId
    });
  }

  return res.json({
    success: true,
    customer_id: customerId,
    connection_source: runtime.connectionSource,
    external_mutation_performed: createMissing && ensured.created.length > 0,
    created: ensured.created,
    existing: ensured.existing,
    mapping: ensured.mapping,
    recommended_google_ads_config: ensured.recommended_google_ads_config
  });
});

exports.startCampaignOnboarding = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const mode = String(req.body?.mode || '').trim().toLowerCase();
  if (!CREATABLE_MODES.has(mode)) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'mode inválido' });
  }

  const providers = listToUniqueArray(
    (Array.isArray(req.body?.providers) ? req.body.providers : ['google_ads'])
      .map((p) => String(p || '').trim().toLowerCase())
      .filter((p) => VALID_PROVIDERS.has(p))
  );

  if (!providers.length) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'providers requerido' });
  }

  const scope = await resolveScopeFromInput({
    clinicIdRaw: req.body?.clinic_id,
    groupIdRaw: req.body?.group_id,
    assignmentScopeRaw: req.body?.assignment_scope
  });
  if (!(await requireMarketingClinicScope(req, res, scope.clinic_ids, 'write'))) return;
  const marketingState = await resolveEffectiveMarketingState({
    clinicIdRaw: scope.clinic_id,
    groupIdRaw: scope.group_id,
    assignmentScopeRaw: scope.assignment_scope
  });

  const anchorClinicId = scope.clinic_id || scope.clinic_ids[0] || null;
  const running = await CampaignRequest.findAll({
    where: {
      clinica_id: anchorClinicId,
      estado: 'en_creacion'
    },
    order: [['created_at', 'DESC']],
    limit: 5
  });
  const hasRunning = running.some((row) => {
    const reqPayload = row?.solicitud || {};
    return reqPayload.kind === 'campaign_onboarding' && reqPayload.status === 'in_progress';
  });
  if (hasRunning) {
    return res.status(409).json({ success: false, error: 'onboarding_already_running' });
  }

  const steps = mode === 'managed_service'
    ? [{ key: 'pilot_request', status: 'pending' }]
    : initSteps(providers);
  const initialPayload = {
    kind: 'campaign_onboarding',
    status: 'in_progress',
    current_step: steps[0]?.key || null,
    mode,
    providers,
    scope: {
      assignment_scope: scope.assignment_scope,
      clinic_id: scope.clinic_id || null,
      group_id: scope.group_id || null
    },
    request: {
      google_ads: req.body?.google_ads || null,
      meta_ads: req.body?.meta_ads || null,
      billing: req.body?.billing || null
    },
    steps,
    result: {}
  };

  const request = await CampaignRequest.create({
    clinica_id: anchorClinicId,
    campaign_id: null,
    estado: 'en_creacion',
    solicitud: initialPayload
  });

  try {
    const result = {};

    if (mode === 'managed_service') {
      markStep(steps, 'pilot_request', 'done');
      result.pilot = {
        operation_mode: 'observe',
        funding_status: 'unfunded',
        requires_prepayment: true,
        automatic_conversion_setup: true,
        next_action: 'configure_strategy'
      };
    }

    if (mode === 'connect_only' && providers.includes('google_ads')) {
      const googleResolved = await resolveGoogleConnectionForScope({
        userId,
        clinicIdRaw: scope.clinic_id,
        groupIdRaw: scope.group_id,
        assignmentScopeRaw: scope.assignment_scope,
        allowLegacyUserFallback: !Boolean(scope.clinic_id || scope.group_id)
      });
      const googleConnection = googleResolved.connection;
      if (!googleConnection) throw new Error('No hay conexión Google');
      if (!hasScopeText(googleConnection.scopes || '', GOOGLE_ADS_SCOPE)) {
        const scopeErr = new Error('La conexión Google no tiene scope de Ads');
        scopeErr.code = 'INSUFFICIENT_SCOPE';
        throw scopeErr;
      }

      const { accessToken } = await ensureGoogleAdsAccess(googleConnection);
      markStep(steps, 'google_connect', 'done');

      const scopeAccounts = marketingState.google.available_accounts || [];
      const requestedCustomer = normalizeCustomerId(req.body?.google_ads?.customer_id || '');
      if (requestedCustomer && !scopeAccounts.some((account) => (
        normalizeCustomerId(account?.customer_id || '') === requestedCustomer
      ))) {
        const customerScopeError = new Error('La cuenta de Google Ads no está asignada a esta clínica o grupo');
        customerScopeError.code = 'CUSTOMER_NOT_ASSIGNED_TO_SCOPE';
        customerScopeError.httpStatus = 403;
        throw customerScopeError;
      }
      const selectedCustomer = requestedCustomer
        || marketingState.google.effective_assets?.account?.customer_id
        || scopeAccounts[0]?.customer_id
        || null;
      if (!selectedCustomer) {
        throw new Error('No hay customer_id de Google Ads mapeado para este scope');
      }

      markStep(steps, 'google_map_account', 'done', { customer_id: selectedCustomer });
      const loginCustomerId = await resolveLoginCustomerId(googleConnection.id, selectedCustomer, scope);

      const autoCreate = req.body?.google_ads?.auto_create_missing_conversions === true
        && req.body?.google_ads?.confirm_external_mutation === true;
      const ensurePayload = await ensureConversionActionsInternal({
        accessToken,
        customerId: selectedCustomer,
        loginCustomerId,
        currency: req.body?.google_ads?.currency || 'EUR',
        events: VALID_EVENTS,
        createMissing: autoCreate
      });

      markStep(steps, 'conversion_actions', 'done');

      const mergedGoogleAds = {
        ...ensurePayload.recommended_google_ads_config,
        enabled: true,
        customer_id: selectedCustomer,
        send_to: req.body?.google_ads?.send_to || null
      };
      await upsertIntakeGoogleAdsForScope(scope, mergedGoogleAds);
      markStep(steps, 'persist_intake_config', 'done');

      result.google_ads = {
        customer_id: selectedCustomer,
        mapping: ensurePayload.mapping,
        created_actions: ensurePayload.created
      };
    }

    if (mode === 'connect_only' && providers.includes('meta_ads')) {
      const metaResolved = await resolveMetaConnectionForScope({
        userId,
        clinicIdRaw: scope.clinic_id,
        groupIdRaw: scope.group_id,
        assignmentScopeRaw: scope.assignment_scope,
        allowLegacyUserFallback: !Boolean(scope.clinic_id || scope.group_id)
      });
      const metaConnection = metaResolved.connection;
      if (!metaConnection) throw new Error('No hay conexión Meta');
      markStep(steps, 'meta_connect', 'done');

      const assets = marketingState.meta.available_assets || { ad_accounts: [] };
      const requestedMetaAccountId = normalizeMetaAdAccountId(req.body?.meta_ads?.ad_account_id);
      const selectedMetaAccount = (requestedMetaAccountId
        ? assets.ad_accounts.find((item) => item.ad_account_id === requestedMetaAccountId)
        : null)
        || marketingState.meta.effective_assets?.ad_account
        || assets.ad_accounts[0]
        || null;
      if (!selectedMetaAccount?.ad_account_id) {
        throw new Error('No hay cuenta publicitaria de Meta mapeada para esta clínica');
      }

      const requestedPixelId = String(req.body?.meta_ads?.pixel_id || '').trim() || null;
      if (requestedPixelId) {
        const scopedPixels = await listMetaPixelsForScopeAdAccount({
          scope,
          adAccountId: selectedMetaAccount.ad_account_id,
          connectionId: selectedMetaAccount.connection_id || metaConnection.id
        });
        if (!scopedPixels.some((pixel) => String(pixel?.pixel_id || '').trim() === requestedPixelId)) {
          const pixelScopeError = new Error('El píxel de Meta no pertenece a la cuenta publicitaria asignada a esta clínica o grupo');
          pixelScopeError.code = 'PIXEL_NOT_ASSIGNED_TO_SCOPE';
          pixelScopeError.httpStatus = 403;
          throw pixelScopeError;
        }
      }
      const selectedPixelId = requestedPixelId
        || marketingState.meta.effective_assets?.pixel?.pixel_id
        || null;

      await upsertIntakeMetaAdsForScope(scope, {
        enabled: true,
        connection_id: selectedMetaAccount.connection_id || metaConnection.id,
        ad_account_id: selectedMetaAccount.ad_account_id,
        pixel_id: selectedPixelId
      });
      markStep(steps, 'meta_map_assets', 'done');
      result.meta_ads = {
        ad_account_id: selectedMetaAccount.ad_account_id,
        pixel_id: selectedPixelId
      };
    }

    const finalPayload = {
      ...initialPayload,
      status: 'completed',
      current_step: null,
      steps,
      result
    };
    await request.update({
      estado: 'aprobada',
      solicitud: finalPayload
    });
    await upsertCampaignSettingsForScope(scope, {
      active_mode: mode,
      last_onboarding_id: request.id,
      last_onboarding_at: new Date().toISOString()
    });

    return res.status(201).json({
      success: true,
      onboarding_id: request.id,
      status: 'completed',
      current_step: null,
      next_action: 'none'
    });
  } catch (err) {
    const failedPayload = {
      ...(request.solicitud || initialPayload),
      status: 'failed',
      current_step: null,
      steps,
      error: err.message || 'internal_error'
    };
    await request.update({
      estado: 'solicitar_cambio',
      solicitud: failedPayload
    });

    const status = Number(err.httpStatus) || (err.code === 'INSUFFICIENT_SCOPE' ? 403 : 500);
    return res.status(status).json({
      success: false,
      error: status === 403
        ? String(err.code || 'insufficient_scope').toLowerCase()
        : 'internal_error',
      message: err.message || 'Error iniciando onboarding',
      onboarding_id: request.id
    });
  }
});

exports.getCampaignOnboardingStatus = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const onboardingId = parseInteger(req.params.onboardingId);
  if (!onboardingId) return res.status(400).json({ success: false, error: 'invalid_onboarding_id' });

  const record = await CampaignRequest.findByPk(onboardingId);
  if (!record) return res.status(404).json({ success: false, error: 'not_found' });

  const payload = record.solicitud && typeof record.solicitud === 'object' ? record.solicitud : {};
  if (payload.kind !== 'campaign_onboarding') {
    return res.status(404).json({ success: false, error: 'not_found' });
  }
  const onboardingClinicIds = await resolveOnboardingClinicIds(record, payload);
  if (!(await requireMarketingClinicScope(req, res, onboardingClinicIds, 'read'))) return;

  return res.json({
    success: true,
    onboarding_id: record.id,
    status: payload.status || 'in_progress',
    mode: payload.mode || null,
    steps: Array.isArray(payload.steps) ? payload.steps : [],
    result: payload.result || {}
  });
});

exports.listMarketingStrategies = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const scope = await resolveScopeFromInput({
    clinicIdRaw: req.query.clinic_id,
    groupIdRaw: req.query.group_id,
    assignmentScopeRaw: req.query.assignment_scope
  });
  if (!(await requireMarketingClinicScope(req, res, scope.clinic_ids, 'read'))) return;

  const targetClinicIds = scope.assignment_scope === 'clinic'
    ? [scope.clinic_id].filter(Boolean)
    : scope.clinic_ids;
  const objectiveFilter = String(req.query.objective_id || '').trim().toLowerCase() || null;

  const requests = await CampaignRequest.findAll({
    where: {
      clinica_id: { [Op.in]: targetClinicIds }
    },
    order: [['updated_at', 'DESC'], ['created_at', 'DESC']],
    raw: true
  });

  const strategyRows = requests.filter((row) => {
    const payload = row?.solicitud && typeof row.solicitud === 'object' ? row.solicitud : {};
    return payload.kind === 'marketing_strategy';
  });

  const campaignsById = await loadCampaignsByIds(strategyRows.map((row) => row.campaign_id));
  const strategyMap = new Map();
  for (const row of strategyRows) {
    const key = row.campaign_id || row.id;
    if (!strategyMap.has(key)) {
      strategyMap.set(key, []);
    }
    strategyMap.get(key).push(row);
  }

  const items = Array.from(strategyMap.values())
    .map((rows) => buildStrategyItemFromRows(rows, campaignsById))
    .filter(Boolean)
    .filter((item) => !objectiveFilter || item.objective_id === objectiveFilter)
    .sort((a, b) => String(b.updated_at || b.created_at).localeCompare(String(a.updated_at || a.created_at)));

  return res.json({
    success: true,
    items
  });
});

exports.getMarketingStrategyAutomationRecommendation = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) {
    return res.status(401).json({ success: false, error: 'unauthenticated' });
  }

  return res.json({
    success: true,
    primary_recommendation: null,
    clinic_recommendations: [],
    group_recommendation: null,
    global_recommendation: null,
    is_fully_uniform: true
  });
});

exports.getMarketingStrategyDetail = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const rows = await loadStrategyRowsByIdentifier(req.params.id);
  if (!rows.length) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Estrategia no encontrada' });
  }
  if (!(await requireMarketingClinicScope(req, res, clinicIdsFromStrategyRows(rows), 'read'))) return;

  const campaignsById = await loadCampaignsByIds(rows.map((row) => row.campaign_id));
  const strategy = buildStrategyItemFromRows(rows, campaignsById);
  if (!strategy) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Estrategia no encontrada' });
  }

  const payload = rows[0]?.solicitud && typeof rows[0].solicitud === 'object' ? rows[0].solicitud : {};
  strategy.metrics = await buildLiveStrategyMetrics(
    rows,
    strategy.campaign_id ? campaignsById.get(strategy.campaign_id) || null : null,
    payload
  );
  const scope = extractStrategyScopeFromPayload(payload, rows);
  const liveExternalMetrics = await loadCurrentExternalCampaignMetricsIndex({ scope, payload });
  const liveLeadMetrics = await loadCurrentLeadAttributionMetricsIndex({ scope, payload });
  strategy.external_targets = hydrateExternalTargetsWithMetrics(payload.external_targets, liveExternalMetrics);
  strategy.target_summaries = buildTargetSummaries(strategy.external_targets, payload.target_destinations, liveLeadMetrics);

  return res.json({
    success: true,
    strategy
  });
});

exports.getMarketingStrategyMetrics = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const rows = await loadStrategyRowsByIdentifier(req.params.id);
  if (!rows.length) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Estrategia no encontrada' });
  }
  if (!(await requireMarketingClinicScope(req, res, clinicIdsFromStrategyRows(rows), 'read'))) return;

  const campaignsById = await loadCampaignsByIds(rows.map((row) => row.campaign_id));
  const strategy = buildStrategyItemFromRows(rows, campaignsById);
  const now = new Date();
  const from = new Date(now.getTime() - (30 * 24 * 60 * 60 * 1000));
  const payload = rows[0]?.solicitud && typeof rows[0].solicitud === 'object' ? rows[0].solicitud : {};
  const metrics = await buildLiveStrategyMetrics(
    rows,
    strategy?.campaign_id ? campaignsById.get(strategy.campaign_id) || null : null,
    payload
  );

  return res.json({
    success: true,
    strategy_id: strategy.id,
    metrics: metrics || createEmptyStrategyMetrics(),
    period: {
      from: from.toISOString(),
      to: now.toISOString()
    }
  });
});

exports.getMarketingStrategyAnalysisCampaign = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const provider = String(req.query?.provider || '').trim().toLowerCase();
  const externalCampaignId = String(req.query?.external_campaign_id || '').trim();
  const requestedIdentity = canonicalExternalCampaignIdentity({
    provider,
    account_id: req.query?.account_id,
    customer_id: req.query?.customer_id,
    campaign_id: externalCampaignId,
  });
  if (!requestedIdentity) {
    return res.status(400).json({
      success: false,
      error: 'validation_error',
      message: 'provider, account_id/customer_id y external_campaign_id son obligatorios'
    });
  }

  const rows = await loadStrategyRowsByIdentifier(req.params.id);
  if (!rows.length) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Estrategia no encontrada' });
  }
  if (!(await requireMarketingClinicScope(req, res, clinicIdsFromStrategyRows(rows), 'read'))) return;

  const campaignsById = await loadCampaignsByIds(rows.map((row) => row.campaign_id));
  const strategy = buildStrategyItemFromRows(rows, campaignsById);
  if (!strategy) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Estrategia no encontrada' });
  }

  const payload = rows[0]?.solicitud && typeof rows[0].solicitud === 'object' ? rows[0].solicitud : {};
  const scope = extractStrategyScopeFromPayload(payload, rows);
  const timeframe = resolveAnalysisDateRange(
    req.query?.timeframe,
    req.query?.start_date,
    req.query?.end_date
  );

  const campaignRef = await resolveAnalysisCampaignReference({
    strategy,
    payload,
    scope,
    identity: requestedIdentity,
  });

  if (!campaignRef) {
    return res.status(404).json({
      success: false,
      error: 'not_found',
      message: 'Campaña externa no vinculada a esta configuración'
    });
  }

  const rowsOut = requestedIdentity.provider === 'meta_ads'
    ? await buildMetaCampaignAnalysisRows({ scope, campaignRef, timeframe })
    : await buildGoogleCampaignAnalysisRows({ scope, campaignRef, timeframe });

  return res.json({
    success: true,
    strategy_id: strategy.id,
    provider: requestedIdentity.provider,
    account_id: requestedIdentity.account_id,
    customer_id: requestedIdentity.customer_id,
    campaign_id: requestedIdentity.campaign_id,
    external_campaign_id: requestedIdentity.external_campaign_id,
    timeframe: {
      key: timeframe.key,
      start: formatDate(timeframe.start),
      end: formatDate(timeframe.end)
    },
    cached: true,
    rows: rowsOut
  });
});

exports.updateMarketingStrategy = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const rows = await loadStrategyRowsByIdentifier(req.params.id);
  if (!rows.length) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Estrategia no encontrada' });
  }
  if (!(await requireMarketingClinicScope(req, res, clinicIdsFromStrategyRows(rows), 'write'))) return;

  const representative = rows[0];
  const currentPayload = representative?.solicitud && typeof representative.solicitud === 'object' ? representative.solicitud : {};
  const currentScope = extractStrategyScopeFromPayload(currentPayload, rows);
  const currentMode = String(currentPayload.mode_snapshot || currentPayload.mode || '').trim().toLowerCase();
  const effectiveMode = VALID_MODES.has(currentMode) ? currentMode : 'connect_only';
  const objectiveId = String(currentPayload.objective_id || '').trim().toLowerCase();
  const promotionType = String(req.body?.promotion_type || currentPayload.promotion_type || '').trim().toLowerCase() === 'generic'
    ? 'generic'
    : 'treatment';

  const treatments = normalizeStrategyTreatments(req.body?.treatments ?? currentPayload.treatments);
  const externalTargets = effectiveMode === 'connect_only'
    ? normalizeExternalTargets(req.body?.external_targets ?? currentPayload.external_targets)
    : [];
  const targetDestinations = effectiveMode === 'connect_only'
    ? normalizeTargetDestinations(req.body?.target_destinations ?? currentPayload.target_destinations)
    : [];
  const areaMedicaIdRaw = req.body?.area_medica_id ?? currentPayload.area_medica_id ?? currentPayload.summary?.area_medica_id;
  const areaMedicaId = Number.isFinite(Number(areaMedicaIdRaw)) && Number(areaMedicaIdRaw) > 0
    ? Number(areaMedicaIdRaw)
    : null;
  const areaMedicaNombre = typeof (req.body?.area_medica_nombre ?? currentPayload.area_medica_nombre ?? currentPayload.summary?.area_medica_nombre) === 'string'
    ? String(req.body?.area_medica_nombre ?? currentPayload.area_medica_nombre ?? currentPayload.summary?.area_medica_nombre).trim() || null
    : null;
  const rawBudgetMonthly = req.body?.budget_monthly ?? currentPayload.summary?.budget_monthly ?? 0;
  const parsedBudgetMonthly = Number(rawBudgetMonthly ?? 0);
  const budgetMonthly = effectiveMode === 'connect_only'
    ? (Number.isFinite(parsedBudgetMonthly) && parsedBudgetMonthly > 0 ? parsedBudgetMonthly : null)
    : parsedBudgetMonthly;
  const channels = normalizeStrategyChannels(req.body?.channels ?? currentPayload.channels);
  const destination = req.body?.destination && typeof req.body.destination === 'object'
    ? req.body.destination
    : (currentPayload.destination && typeof currentPayload.destination === 'object' ? currentPayload.destination : null);
  const measurement = req.body?.measurement && typeof req.body.measurement === 'object'
    ? req.body.measurement
    : (currentPayload.measurement && typeof currentPayload.measurement === 'object' ? currentPayload.measurement : null);
  const automation = req.body?.automation && typeof req.body.automation === 'object'
    ? req.body.automation
    : (currentPayload.automation && typeof currentPayload.automation === 'object' ? currentPayload.automation : null);
  const geo = req.body?.geo && typeof req.body.geo === 'object'
    ? req.body.geo
    : (currentPayload.geo && typeof currentPayload.geo === 'object' ? currentPayload.geo : {});
  const addonCalls = effectiveMode === 'managed_service'
    ? req.body?.addon_calls === true
    : false;
  const targetClinicIds = clinicIdsFromStrategyRows(rows);

  if (promotionType !== 'generic' && !treatments.length) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'Selecciona al menos un tratamiento' });
  }
  if (effectiveMode !== 'connect_only' && (!Number.isFinite(budgetMonthly) || budgetMonthly <= 0)) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'budget_monthly debe ser mayor que 0' });
  }
  if (!channels.length && effectiveMode !== 'connect_only') {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'Selecciona al menos un canal' });
  }
  if (effectiveMode === 'managed_service' && !channels.some((item) => ['google_ads', 'meta_ads'].includes(item.channel) && item.enabled !== false)) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'Piloto automático requiere Google Ads o Meta Ads' });
  }

  if (effectiveMode === 'connect_only') {
    const treatmentIds = new Set(treatments.map((item) => item.id));
    const targetKeys = new Set();
    const assignedCampaignKeys = new Set();
    const totalAssignedCampaigns = externalTargets.reduce((sum, target) => sum + target.campaigns.length, 0);

    if (totalAssignedCampaigns === 0) {
      return res.status(400).json({
        success: false,
        error: 'validation_error',
        message: 'Vincula al menos una campaña externa para continuar con Solo Conectar.'
      });
    }

    for (const target of externalTargets) {
      if (promotionType === 'generic' && target.kind !== 'generic') {
        return res.status(400).json({ success: false, error: 'validation_error', message: 'Las campañas externas deben vincularse al target genérico de la estrategia.' });
      }
      if (promotionType !== 'generic' && (!target.treatment_id || !treatmentIds.has(target.treatment_id))) {
        return res.status(400).json({ success: false, error: 'validation_error', message: 'Hay campañas externas vinculadas a tratamientos que no pertenecen a la estrategia.' });
      }
      const targetKey = `${target.kind}:${target.treatment_id || 'generic'}`;
      targetKeys.add(targetKey);

      for (const campaign of target.campaigns) {
        const campaignKey = externalCampaignIdentityKey(campaign);
        if (!campaignKey) {
          return res.status(400).json({ success: false, error: 'validation_error', message: 'Cada campaña externa debe incluir proveedor, cuenta y campaign_id válidos.' });
        }
        if (assignedCampaignKeys.has(campaignKey)) {
          return res.status(400).json({ success: false, error: 'validation_error', message: 'La misma campaña externa no puede asignarse a dos targets distintos.' });
        }
        assignedCampaignKeys.add(campaignKey);
      }
    }

    for (const destinationItem of targetDestinations) {
      const targetKey = `${destinationItem.kind}:${destinationItem.treatment_id || 'generic'}`;
      if (promotionType === 'generic' && destinationItem.kind !== 'generic') {
        return res.status(400).json({ success: false, error: 'validation_error', message: 'Los destinos solo pueden definirse para el target genérico de la estrategia.' });
      }
      if (promotionType !== 'generic' && (!destinationItem.treatment_id || !treatmentIds.has(destinationItem.treatment_id))) {
        return res.status(400).json({ success: false, error: 'validation_error', message: 'Hay destinos definidos para tratamientos que no pertenecen a la estrategia.' });
      }
      if (targetKeys.size > 0 && !targetKeys.has(targetKey)) {
        return res.status(400).json({ success: false, error: 'validation_error', message: 'Hay destinos definidos para targets sin campañas externas vinculadas.' });
      }
      if (destinationItem.uses_web === true && !destinationItem.confirmed_url) {
        return res.status(400).json({ success: false, error: 'validation_error', message: 'Confirma la URL de cada target que lleve tráfico a web.' });
      }
    }

    const externalCampaignConflicts = await findExternalCampaignAssignmentConflicts(targetClinicIds, externalTargets, {
      excludeRequestIds: requestIdsFromRows(rows)
    });
    if (externalCampaignConflicts.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'external_campaign_already_assigned',
        message: 'Alguna de las campañas externas ya está vinculada a otra estrategia. Desvincúlala antes de reutilizarla.',
        conflicts: externalCampaignConflicts
      });
    }
  }

  const currentStatus = effectiveMode === 'connect_only'
    ? 'active'
    : normalizeStrategyStatus(currentPayload.status || representative.estado);
  const campaignName = buildStrategyName({
    objectiveId,
    treatments,
    clinicCount: targetClinicIds.length
  });
  const dominantType = channels.length > 0 ? pickLegacyCampaignTypeFromChannels(channels) : 'web_snippet';

  if (representative.campaign_id) {
    await Campaign.update({
      nombre: campaignName,
      tipo: dominantType,
      presupuesto: budgetMonthly,
      gestionada: effectiveMode !== 'connect_only',
      activa: currentStatus === 'active'
    }, {
      where: { id: representative.campaign_id }
    });
  }

  for (const row of rows) {
    const rowPayload = row?.solicitud && typeof row.solicitud === 'object' ? row.solicitud : {};
    const nextPayload = {
      ...rowPayload,
      status: currentStatus,
      objective_id: objectiveId,
      promotion_type: promotionType,
      summary: {
        ...(rowPayload.summary && typeof rowPayload.summary === 'object' ? rowPayload.summary : {}),
        name: campaignName,
        budget_monthly: budgetMonthly,
        area_medica_id: areaMedicaId,
        area_medica_nombre: areaMedicaNombre
      },
      area_medica_id: areaMedicaId,
      area_medica_nombre: areaMedicaNombre,
      treatments,
      external_targets: externalTargets,
      target_destinations: targetDestinations,
      destination,
      measurement,
      geo,
      channels,
      automation,
      addons: {
        ...(rowPayload.addons && typeof rowPayload.addons === 'object' ? rowPayload.addons : {}),
        call_leads: addonCalls
      }
    };

    await CampaignRequest.update({
      solicitud: nextPayload,
      estado: mapStrategyStatusToRequestState(currentStatus)
    }, {
      where: { id: row.id }
    });
  }

  const refreshedRows = await loadStrategyRowsByIdentifier(req.params.id);
  const campaignsById = await loadCampaignsByIds(refreshedRows.map((row) => row.campaign_id));
  const strategy = buildStrategyItemFromRows(refreshedRows, campaignsById);
  const refreshedPayload = refreshedRows[0]?.solicitud && typeof refreshedRows[0].solicitud === 'object'
    ? refreshedRows[0].solicitud
    : {};
  strategy.metrics = await buildLiveStrategyMetrics(
    refreshedRows,
    strategy?.campaign_id ? campaignsById.get(strategy.campaign_id) || null : null,
    refreshedPayload
  );
  const refreshedScope = extractStrategyScopeFromPayload(refreshedPayload, refreshedRows);
  const refreshedLiveExternalMetrics = await loadCurrentExternalCampaignMetricsIndex({
    scope: refreshedScope,
    payload: refreshedPayload
  });
  const refreshedLeadMetrics = await loadCurrentLeadAttributionMetricsIndex({
    scope: refreshedScope,
    payload: refreshedPayload
  });
  strategy.external_targets = hydrateExternalTargetsWithMetrics(refreshedPayload.external_targets, refreshedLiveExternalMetrics);
  strategy.target_summaries = buildTargetSummaries(strategy.external_targets, refreshedPayload.target_destinations, refreshedLeadMetrics);

  return res.json({
    success: true,
    strategy
  });
});

exports.transitionMarketingStrategyStatus = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const requestedStatus = String(req.body?.status || '').trim().toLowerCase();
  if (!VALID_STRATEGY_STATUSES.has(requestedStatus)) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'status inválido' });
  }
  const nextStatus = normalizeStrategyStatus(requestedStatus);

  const rows = await loadStrategyRowsByIdentifier(req.params.id);
  if (!rows.length) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Estrategia no encontrada' });
  }
  if (!(await requireMarketingClinicScope(req, res, clinicIdsFromStrategyRows(rows), 'write'))) return;

  const campaignsById = await loadCampaignsByIds(rows.map((row) => row.campaign_id));
  const strategy = buildStrategyItemFromRows(rows, campaignsById);
  const currentStatus = normalizeStrategyStatus(strategy?.status);
  if (strategy?.mode === 'managed_service' && nextStatus === 'active') {
    return res.status(409).json({
      success: false,
      error: 'managed_launch_requires_admin_gate',
      message: 'Piloto automático solo puede activarse desde Operación de campañas tras confirmar prepago, tracking y revisión.'
    });
  }

  if (!canTransitionStrategy(currentStatus, nextStatus)) {
    return res.status(409).json({
      success: false,
      error: 'invalid_transition',
      message: `Transición no permitida: ${currentStatus} → ${nextStatus}`
    });
  }

  if (nextStatus === 'pending_approval' || nextStatus === 'active') {
    const conflicts = await findBlockingStrategyConflicts(strategy.clinic_ids, {
      excludeCampaignId: strategy.campaign_id,
      excludeRequestIds: rows.map((row) => parseInteger(row.id)).filter((value) => value)
    });

    if (conflicts.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'active_strategy_exists',
        message: 'Ya existe una estrategia en curso para al menos una de las clínicas seleccionadas. Edita la actual o complétala antes de crear otra.',
        conflicts
      });
    }
  }

  const now = new Date();
  const nowIso = now.toISOString();
  const requestState = mapStrategyStatusToRequestState(nextStatus);

  for (const row of rows) {
    const payload = row?.solicitud && typeof row.solicitud === 'object' ? row.solicitud : {};
    const history = Array.isArray(payload.status_history) ? [...payload.status_history] : [];
    history.push({
      from: currentStatus,
      to: nextStatus,
      changed_at: nowIso,
      user_id: userId
    });

    await CampaignRequest.update({
      estado: requestState,
      solicitud: {
        ...payload,
        status: nextStatus,
        status_history: history,
        updated_at: nowIso
      },
      updated_at: now
    }, {
      where: { id: row.id }
    });
  }

  if (strategy.campaign_id) {
    await Campaign.update({
      activa: nextStatus === 'active',
      fecha_inicio: nextStatus === 'active'
        ? (campaignsById.get(strategy.campaign_id)?.fecha_inicio || now)
        : campaignsById.get(strategy.campaign_id)?.fecha_inicio || null,
      fecha_fin: nextStatus === 'completed' ? now : null
    }, {
      where: { id: strategy.campaign_id }
    });

  }

  return res.json({
    success: true,
    strategy: {
      id: strategy.id,
      status: nextStatus,
      updated_at: nowIso
    }
  });
});

exports.createMarketingStrategy = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const objectiveId = String(req.body?.objective_id || '').trim().toLowerCase();
  const promotionType = String(req.body?.promotion_type || '').trim().toLowerCase() === 'generic'
    ? 'generic'
    : 'treatment';
  if (!VALID_STRATEGY_OBJECTIVES.has(objectiveId)) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'objective_id inválido o no disponible' });
  }

  const scope = await resolveScopeFromInput({
    clinicIdRaw: req.body?.clinic_id ?? (req.body?.scope_type === 'clinic' ? req.body?.scope_id : null),
    groupIdRaw: req.body?.group_id ?? (req.body?.scope_type === 'group' ? req.body?.scope_id : null),
    assignmentScopeRaw: req.body?.assignment_scope ?? req.body?.scope_type
  });

  const selectedClinicIds = parseClinicIds(req.body?.clinic_ids);
  const targetClinicIds = scope.assignment_scope === 'clinic'
    ? [scope.clinic_id].filter(Boolean)
    : (selectedClinicIds.length > 0
      ? selectedClinicIds.filter((id) => scope.clinic_ids.includes(id))
      : scope.clinic_ids);

  if (!targetClinicIds.length) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'No hay clínicas válidas en el scope seleccionado' });
  }
  if (!(await requireMarketingClinicScope(req, res, targetClinicIds, 'write'))) return;

  if (objectiveId === 'new_patients' && scope.assignment_scope !== 'clinic') {
    return res.status(400).json({
      success: false,
      error: 'validation_error',
      message: 'Captar Nuevos Pacientes se configura por clínica. Selecciona una clínica concreta para crear la estrategia.'
    });
  }

  const clinicModes = await Promise.all(targetClinicIds.map((clinicId) => resolveModeForClinic(clinicId)));
  const uniqueClinicModes = Array.from(new Set(clinicModes.filter((mode) => VALID_MODES.has(mode))));
  if (uniqueClinicModes.length > 1) {
    return res.status(409).json({
      success: false,
      error: 'mixed_modes',
      message: 'Las clínicas seleccionadas no comparten el mismo modo de gestión. Alinea el modo desde Configuración o reduce la selección.'
    });
  }

  const requestedMode = String(req.body?.mode || '').trim().toLowerCase();
  const scopeMode = await resolveActiveModeForScope(scope);
  const effectiveMode = uniqueClinicModes[0]
    || (VALID_MODES.has(scopeMode) ? scopeMode : null)
    || (VALID_MODES.has(requestedMode) ? requestedMode : null);

  if (!effectiveMode) {
    return res.status(409).json({
      success: false,
      error: 'mode_not_configured',
      message: 'Antes de crear una estrategia debes completar la configuración técnica del scope.'
    });
  }
  if (!CREATABLE_MODES.has(effectiveMode)) {
    return res.status(409).json({
      success: false,
      error: 'legacy_mode_read_only',
      message: 'La configuración antigua de gestión propia es solo de lectura. Selecciona Conecta y mide o Piloto automático antes de crear una estrategia.'
    });
  }

  const treatments = normalizeStrategyTreatments(req.body?.treatments);
  const externalTargets = effectiveMode === 'connect_only'
    ? normalizeExternalTargets(req.body?.external_targets)
    : [];
  const targetDestinations = effectiveMode === 'connect_only'
    ? normalizeTargetDestinations(req.body?.target_destinations)
    : [];
  const areaMedicaIdRaw = req.body?.area_medica_id;
  const areaMedicaId = Number.isFinite(Number(areaMedicaIdRaw)) && Number(areaMedicaIdRaw) > 0
    ? Number(areaMedicaIdRaw)
    : null;
  const areaMedicaNombre = typeof req.body?.area_medica_nombre === 'string'
    ? String(req.body?.area_medica_nombre).trim() || null
    : null;
  if (promotionType !== 'generic' && !treatments.length) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'Selecciona al menos un tratamiento' });
  }

  const rawBudgetMonthly = req.body?.budget_monthly;
  const parsedBudgetMonthly = Number(rawBudgetMonthly ?? 0);
  const budgetMonthly = effectiveMode === 'connect_only'
    ? (Number.isFinite(parsedBudgetMonthly) && parsedBudgetMonthly > 0 ? parsedBudgetMonthly : null)
    : parsedBudgetMonthly;
  if (effectiveMode !== 'connect_only' && (!Number.isFinite(budgetMonthly) || budgetMonthly <= 0)) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'budget_monthly debe ser mayor que 0' });
  }

  const channels = normalizeStrategyChannels(req.body?.channels);
  if (!channels.length && effectiveMode !== 'connect_only') {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'Selecciona al menos un canal' });
  }
  if (effectiveMode === 'managed_service' && !channels.some((item) => ['google_ads', 'meta_ads'].includes(item.channel) && item.enabled !== false)) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'Piloto automático requiere Google Ads o Meta Ads' });
  }

  if (effectiveMode === 'connect_only') {
    const treatmentIds = new Set(treatments.map((item) => item.id));
    const targetKeys = new Set();
    const assignedCampaignKeys = new Set();
    const totalAssignedCampaigns = externalTargets.reduce((sum, target) => sum + target.campaigns.length, 0);

    if (totalAssignedCampaigns === 0) {
      return res.status(400).json({
        success: false,
        error: 'validation_error',
        message: 'Vincula al menos una campaña externa para continuar con Solo Conectar.'
      });
    }

    for (const target of externalTargets) {
      if (promotionType === 'generic' && target.kind !== 'generic') {
        return res.status(400).json({ success: false, error: 'validation_error', message: 'Las campañas externas deben vincularse al target genérico de la estrategia.' });
      }
      if (promotionType !== 'generic' && (!target.treatment_id || !treatmentIds.has(target.treatment_id))) {
        return res.status(400).json({ success: false, error: 'validation_error', message: 'Hay campañas externas vinculadas a tratamientos que no pertenecen a la estrategia.' });
      }

      const targetKey = `${target.kind}:${target.treatment_id || 'generic'}`;
      targetKeys.add(targetKey);

      for (const campaign of target.campaigns) {
        const campaignKey = externalCampaignIdentityKey(campaign);
        if (!campaignKey) {
          return res.status(400).json({ success: false, error: 'validation_error', message: 'Cada campaña externa debe incluir proveedor, cuenta y campaign_id válidos.' });
        }
        if (assignedCampaignKeys.has(campaignKey)) {
          return res.status(400).json({ success: false, error: 'validation_error', message: 'La misma campaña externa no puede asignarse a dos targets distintos.' });
        }
        assignedCampaignKeys.add(campaignKey);
      }
    }

    for (const destinationItem of targetDestinations) {
      const targetKey = `${destinationItem.kind}:${destinationItem.treatment_id || 'generic'}`;
      if (promotionType === 'generic' && destinationItem.kind !== 'generic') {
        return res.status(400).json({ success: false, error: 'validation_error', message: 'Los destinos solo pueden definirse para el target genérico de la estrategia.' });
      }
      if (promotionType !== 'generic' && (!destinationItem.treatment_id || !treatmentIds.has(destinationItem.treatment_id))) {
        return res.status(400).json({ success: false, error: 'validation_error', message: 'Hay destinos definidos para tratamientos que no pertenecen a la estrategia.' });
      }
      if (targetKeys.size > 0 && !targetKeys.has(targetKey)) {
        return res.status(400).json({ success: false, error: 'validation_error', message: 'Hay destinos definidos para targets sin campañas externas vinculadas.' });
      }
      if (destinationItem.uses_web === true && !destinationItem.confirmed_url) {
        return res.status(400).json({ success: false, error: 'validation_error', message: 'Confirma la URL de cada target que lleve tráfico a web.' });
      }
    }

    const externalCampaignConflicts = await findExternalCampaignAssignmentConflicts(targetClinicIds, externalTargets);
    if (externalCampaignConflicts.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'external_campaign_already_assigned',
        message: 'Alguna de las campañas externas ya está vinculada a otra estrategia. Desvincúlala antes de reutilizarla.',
        conflicts: externalCampaignConflicts
      });
    }
  }

  const conflicts = await findBlockingStrategyConflicts(targetClinicIds);
  if (conflicts.length > 0) {
    return res.status(409).json({
      success: false,
      error: 'active_strategy_exists',
      message: 'Ya existe una estrategia en curso para al menos una de las clínicas seleccionadas. Edita la actual o complétala antes de crear otra.',
      conflicts
    });
  }

  const dominantType = channels.length > 0
    ? pickLegacyCampaignTypeFromChannels(channels)
    : 'web_snippet';
  const campaignName = buildStrategyName({
    objectiveId,
    treatments,
    clinicCount: targetClinicIds.length
  });

  const initialStatus = effectiveMode === 'connect_only' ? 'active' : 'draft';

  const geo = req.body?.geo && typeof req.body.geo === 'object' ? req.body.geo : {};
  const destination = req.body?.destination && typeof req.body.destination === 'object' ? req.body.destination : null;
  const measurement = req.body?.measurement && typeof req.body.measurement === 'object' ? req.body.measurement : null;
  const automation = req.body?.automation && typeof req.body.automation === 'object' ? req.body.automation : null;
  const addonCalls = effectiveMode === 'managed_service' ? req.body?.addon_calls === true : false;

  let campaign;
  const createdRequests = [];
  let managedCampaignIds = [];
  await db.sequelize.transaction(async (transaction) => {
    campaign = await Campaign.create({
      nombre: campaignName,
      tipo: dominantType,
      clinica_id: scope.assignment_scope === 'clinic' ? scope.clinic_id : null,
      grupo_clinica_id: scope.group_id || null,
      campaign_id_externo: null,
      gestionada: effectiveMode !== 'connect_only',
      activa: effectiveMode === 'connect_only',
      fecha_inicio: null,
      fecha_fin: null,
      presupuesto: budgetMonthly
    }, { transaction });

    for (const clinicId of targetClinicIds) {
      const payload = {
        kind: 'marketing_strategy',
        status: initialStatus,
        objective_id: objectiveId,
        mode_snapshot: effectiveMode,
        scope: {
          assignment_scope: scope.assignment_scope,
          clinic_id: scope.assignment_scope === 'clinic' ? clinicId : null,
          group_id: scope.group_id || null,
          clinic_ids: targetClinicIds
        },
        summary: {
          name: campaignName,
          budget_monthly: budgetMonthly,
          area_medica_id: areaMedicaId,
          area_medica_nombre: areaMedicaNombre
        },
        promotion_type: promotionType,
        area_medica_id: areaMedicaId,
        area_medica_nombre: areaMedicaNombre,
        treatments,
        external_targets: externalTargets,
        target_destinations: targetDestinations,
        destination,
        measurement,
        geo,
        channels,
        automation,
        addons: { call_leads: addonCalls }
      };

      const request = await CampaignRequest.create({
        clinica_id: clinicId,
        campaign_id: campaign.id,
        estado: mapStrategyStatusToRequestState(initialStatus),
        solicitud: payload
      }, { transaction });

      createdRequests.push({ id: request.id, clinica_id: clinicId });
    }

    if (effectiveMode === 'managed_service') {
      managedCampaignIds = await provisionManagedCampaignsFromStrategy({
        strategyCampaign: campaign,
        campaignRequest: createdRequests[0] || null,
        clinicId: targetClinicIds[0],
        groupId: scope.group_id || null,
        userId,
        payload: {
          promotion_type: promotionType,
          treatments,
          area_medica_id: areaMedicaId,
          area_medica_nombre: areaMedicaNombre,
          destination,
          measurement,
          geo,
        },
        budgetMonthly,
        channels,
        transaction,
      });
    }
  });

  return res.status(201).json({
    success: true,
    campaign: {
      id: campaign.id,
      nombre: campaign.nombre,
      tipo: campaign.tipo,
      clinica_id: campaign.clinica_id,
      grupo_clinica_id: campaign.grupo_clinica_id,
      presupuesto: campaign.presupuesto,
      gestionada: campaign.gestionada,
      activa: campaign.activa
    },
    strategy: {
      id: campaign.id,
      objective_id: objectiveId,
      promotion_type: promotionType,
      mode: effectiveMode,
      status: initialStatus,
      clinic_ids: targetClinicIds,
      addon_calls: addonCalls,
      request_ids: createdRequests.map((item) => item.id),
      managed_campaign_ids: managedCampaignIds
    }
  });
});
