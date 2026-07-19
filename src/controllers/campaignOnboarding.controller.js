'use strict';

const crypto = require('crypto');
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
  overlayNormalizedGoogleAdsConfig,
} = require('../lib/intake-config-write-merge');
const {
  extractGoogleTagId,
  listMetaPixelsForScopeAdAccount,
  mergeGoogleAdsConfig: mergeEffectiveGoogleAdsConfig,
  mergeProvisionedGoogleAdsConfig,
  normalizeMetaAdAccountId,
  normalizeMetaAdsConfig,
  resolveEffectiveMarketingState
} = require('../services/effectiveMarketingAssets.service');
const { resolveScopedGoogleAdsRuntime } = require('../services/googleAdsScopedRuntime.service');
const {
  GOOGLE_DATA_MANAGER_SCOPE,
  GOOGLE_ENHANCED_CONVERSION_ALLOWED_IDENTIFIERS,
  GOOGLE_ENHANCED_CONVERSION_POLICY_MODE,
  GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_CUSTOMER_IDS,
  GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_EVENTS,
  validateEnhancedConversionAuthorization,
  uploadConversionEvent: uploadGoogleDataManagerConversion
} = require('../services/googleDataManagerConversion.service');
const {
  normalizeCanonicalGoogleAdsConversions
} = require('../services/googleAdsCanonicalConversionNormalization.service');
const {
  enqueueGoogleDataManagerControlPlaneReconciliation,
} = require('../services/googleDataManagerDiagnosticsEnqueue.service');
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
  auditConnectOnlyCampaignQuality,
} = require('../services/googleAdsConnectOnlyQualityAudit.service');
const {
  canonicalExternalCampaignIdentity,
  externalCampaignIdentityKey,
} = require('../services/externalCampaignAssignmentTargets.service');
const {
  buildVerificationConfigHash,
  canonicalizeIntakeDomain,
  canonicalizeIntakeDomains,
  cookieNoticeProviderMatches,
  verifyPersistedVerificationAttestation,
} = require('../lib/intake-verification-attestation');

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
const ENHANCED_CONVERSION_ACTIVATION_GATE_VERSION = 3;
const ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID = 5;
// The group-scoped Propdental web configuration covers the Spanish sites.
// Local phone numbers therefore need an explicit country code before hashing;
// France remains outside this IntakeConfig and must use its own clinic scope.
const ENHANCED_CONVERSION_PROPDENTAL_PHONE_COUNTRY_CODE = '34';
const ENHANCED_CONVERSION_GOOGLE_EVIDENCE_REF = '4-1893000040437';
const ENHANCED_CONVERSION_GOOGLE_GUIDANCE_AT = '2026-03-23T07:11:00.000Z';
const ENHANCED_CONVERSION_ADVERTISER_AUTHORIZATION_REF =
  process.env.GOOGLE_ENHANCED_CONVERSION_ADVERTISER_AUTHORIZATION_REF
  || 'propdental-owner-directive-2026-07-13';
const ENHANCED_CONVERSION_ADVERTISER_AUTHORIZED_AT =
  process.env.GOOGLE_ENHANCED_CONVERSION_ADVERTISER_AUTHORIZED_AT
  || '2026-07-13T00:00:00.000Z';
const ENHANCED_CONVERSION_VALUE_POLICY_VERSION = 1;
const AD_PERSONALIZATION_CAPABILITY_VERSION = 2;
const CAMPAIGN_REPORTING_TIME_ZONE = 'Europe/Madrid';
const QUALIFIED_LEAD_STATUSES = new Set(['cualificado', 'citado', 'acudio_cita', 'convertido']);
const APPOINTMENT_LEAD_STATUSES = new Set(['citado', 'acudio_cita', 'convertido']);
const ENHANCED_CONVERSION_REPORTING_VALUES_EUR = Object.freeze({
  lead: 0,
  contact: 0,
  qualified_lead: 10,
  schedule: 40
});

// `managed_self` is retained only to read historical configurations. New
// onboarding/strategy writes must use one of the three current product modes.
const CAMPAIGN_MODES = Object.freeze({
  MEASURE: 'connect_only',
  IMPROVE: 'guided_improvement',
  LEGACY_SELF_MANAGED: 'managed_self',
  AUTOPILOT: 'managed_service'
});
const VALID_MODES = new Set(Object.values(CAMPAIGN_MODES));
const CREATABLE_MODES = new Set([
  CAMPAIGN_MODES.MEASURE,
  CAMPAIGN_MODES.IMPROVE,
  CAMPAIGN_MODES.AUTOPILOT
]);
const MANAGED_CAMPAIGN_REQUEST_ENDPOINT = '/api/marketing/managed-campaigns/request';
const IMPROVEMENT_AUTHORIZATION_VERSION = 1;
const IMPROVEMENT_AUTHORIZATION_SCOPES = Object.freeze([
  'landing_publish',
  'campaign_destination',
  'conversion_goal'
]);
const IMPROVEMENT_WEB_INTEGRATION_HOOK_VERSION = 1;
const IMPROVEMENT_WEB_INTEGRATION_HOOKS = Object.freeze({
  landing_publish: 'marketing_web.landing_published.v1',
  campaign_destination: 'marketing_web.destination_ready.v1'
});

function usesExistingAdvertiserCampaigns(mode) {
  return mode === CAMPAIGN_MODES.MEASURE || mode === CAMPAIGN_MODES.IMPROVE;
}

function ownsCampaignOperations(mode) {
  return mode === CAMPAIGN_MODES.AUTOPILOT;
}

function guardCampaignOnboardingStartMode(mode) {
  if (mode !== CAMPAIGN_MODES.AUTOPILOT) return null;
  return {
    http_status: 409,
    body: {
      success: false,
      error: 'managed_service_request_required',
      message: 'Piloto automático se solicita desde su flujo específico para poder revisar presupuesto, financiación y aprobación antes de operar campañas.',
      next_action: 'request_managed_campaign',
      request_endpoint: MANAGED_CAMPAIGN_REQUEST_ENDPOINT,
      allowed_modes: [CAMPAIGN_MODES.MEASURE, CAMPAIGN_MODES.IMPROVE]
    }
  };
}

function buildCampaignModeContract(mode, improvementAuthorization = null) {
  const normalizedMode = VALID_MODES.has(mode) ? mode : CAMPAIGN_MODES.MEASURE;
  const base = {
    version: 1,
    mode: normalizedMode,
    measurement: true,
    attribution: true,
    consented_conversion_uploads: true,
    recommendations: true,
    mutate_campaigns: false,
    mutate_bids: false,
    mutate_budget: false,
    mutate_campaign_status: false,
    publish_landings: false,
    change_destinations: false,
    manage_conversion_goals: false,
    requires_prepayment: false
  };

  if (normalizedMode === CAMPAIGN_MODES.IMPROVE) {
    const authorization = improvementAuthorization && typeof improvementAuthorization === 'object'
      ? improvementAuthorization
      : {};
    const requestedScopes = Array.isArray(authorization.scopes)
      ? authorization.scopes.map((value) => String(value || '').trim().toLowerCase())
      : [];
    const allowedScopes = requestedScopes.filter((scope) => IMPROVEMENT_AUTHORIZATION_SCOPES.includes(scope));
    const acceptedAt = authorization.accepted_at
      && Number.isFinite(new Date(authorization.accepted_at).getTime())
      ? new Date(authorization.accepted_at).toISOString()
      : null;
    const acceptedByUserId = parseInteger(authorization.accepted_by_user_id);
    const authorized = authorization.accepted === true
      && Number(authorization.version) === IMPROVEMENT_AUTHORIZATION_VERSION
      && !!acceptedAt
      && !!acceptedByUserId;
    const landingPublishAuthorized = authorized && allowedScopes.includes('landing_publish');
    const campaignDestinationAuthorized = authorized && allowedScopes.includes('campaign_destination');
    const conversionGoalAuthorized = authorized && allowedScopes.includes('conversion_goal');
    return {
      ...base,
      // Mejora only enables the three explicitly authorised capabilities. It
      // still cannot change bids, budgets or campaign status. Landing and
      // destination writes are executed through the versioned, read-backed
      // Marketing Web hooks below.
      mutate_campaigns: campaignDestinationAuthorized || conversionGoalAuthorized,
      publish_landings: landingPublishAuthorized,
      change_destinations: campaignDestinationAuthorized,
      manage_conversion_goals: conversionGoalAuthorized,
      integration_hooks: {
        version: IMPROVEMENT_WEB_INTEGRATION_HOOK_VERSION,
        landing_publish: {
          scope_authorized: landingPublishAuthorized,
          status: landingPublishAuthorized ? 'available' : 'not_authorized',
          event: IMPROVEMENT_WEB_INTEGRATION_HOOKS.landing_publish,
          requires_https_destination: true
        },
        campaign_destination: {
          scope_authorized: campaignDestinationAuthorized,
          status: campaignDestinationAuthorized ? 'available_after_landing_published' : 'not_authorized',
          event: IMPROVEMENT_WEB_INTEGRATION_HOOKS.campaign_destination,
          requires_https_destination: true
        },
        conversion_goal: {
          scope_authorized: conversionGoalAuthorized,
          status: conversionGoalAuthorized ? 'available' : 'not_authorized'
        }
      },
      authorization: {
        version: IMPROVEMENT_AUTHORIZATION_VERSION,
        accepted: authorized,
        // Never manufacture acceptance evidence while normalising a stored
        // contract. Only the onboarding command is allowed to stamp it.
        accepted_at: authorized ? acceptedAt : null,
        accepted_by_user_id: authorized ? acceptedByUserId : null,
        scopes: allowedScopes
      }
    };
  }

  if (normalizedMode === CAMPAIGN_MODES.AUTOPILOT) {
    return {
      ...base,
      mutate_campaigns: true,
      mutate_bids: true,
      mutate_budget: true,
      mutate_campaign_status: true,
      publish_landings: true,
      change_destinations: true,
      manage_conversion_goals: true,
      requires_prepayment: true
    };
  }

  return base;
}

function normalizeImprovementAuthorization(input) {
  const source = input && typeof input === 'object' ? input : {};
  const version = Number(source.version);
  const scopes = Array.isArray(source.scopes)
    ? Array.from(new Set(source.scopes
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => IMPROVEMENT_AUTHORIZATION_SCOPES.includes(value))))
    : [];
  return {
    version: Number.isInteger(version) ? version : null,
    accepted: source.accepted === true,
    // Normalisation is read-only: only the onboarding command below may stamp
    // server-side acceptance evidence.
    accepted_at: source.accepted === true && source.accepted_at
      ? String(source.accepted_at)
      : null,
    accepted_by_user_id: source.accepted === true
      ? parseInteger(source.accepted_by_user_id) || null
      : null,
    scopes
  };
}

function validateImprovementAuthorization(mode, input) {
  if (mode !== CAMPAIGN_MODES.IMPROVE) return null;
  const authorization = normalizeImprovementAuthorization(input);
  if (
    authorization.accepted !== true
    || authorization.version !== IMPROVEMENT_AUTHORIZATION_VERSION
    || authorization.scopes.length !== IMPROVEMENT_AUTHORIZATION_SCOPES.length
  ) {
    const error = new Error('Para usar Mejora debes registrar la autorización inicial de sus tres capacidades limitadas: publicar la landing, cambiar el destino y gestionar el objetivo de conversión. Nunca incluye pujas, presupuesto ni estados de campaña.');
    error.code = 'IMPROVEMENT_AUTHORIZATION_REQUIRED';
    error.httpStatus = 400;
    throw error;
  }
  return authorization;
}

function externalTargetsHaveProvider(targets, provider) {
  const normalizedProvider = String(provider || '').trim().toLowerCase();
  return (Array.isArray(targets) ? targets : []).some((target) => (
    (Array.isArray(target?.campaigns) ? target.campaigns : []).some((campaign) => (
      String(campaign?.provider || '').trim().toLowerCase() === normalizedProvider
    ))
  ));
}

function stableHttpsDestination(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return { valid: false, reason: 'missing' };
  let parsed;
  try {
    parsed = new URL(raw);
  } catch (_error) {
    return { valid: false, reason: 'invalid_url' };
  }
  // WHATWG keeps brackets around IPv6 hostnames in Node. Strip them before
  // classifying loopback/link-local/ULA addresses so `[::1]` cannot pass as a
  // public campaign destination.
  const hostname = String(parsed.hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  const privateIpv4 = /^(?:10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.)/;
  const privateIpv6 = hostname === '::1' || hostname.startsWith('fc') || hostname.startsWith('fd') || hostname.startsWith('fe80:');
  if (
    parsed.protocol !== 'https:'
    || !hostname
    || parsed.username
    || parsed.password
    || parsed.hash
    || hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname.endsWith('.local')
    || privateIpv4.test(hostname)
    || privateIpv6
  ) {
    return { valid: false, reason: 'stable_https_required' };
  }
  const ephemeralKeys = new Set(['gclid', 'gbraid', 'wbraid', 'fbclid', 'token', 'signature', 'expires']);
  if (Array.from(parsed.searchParams.keys()).some((key) => ephemeralKeys.has(String(key).toLowerCase()))) {
    return { valid: false, reason: 'ephemeral_query_not_allowed' };
  }
  return { valid: true, url: parsed.toString() };
}
const VALID_PROVIDERS = new Set(['google_ads', 'meta_ads']);
const VALID_EVENTS = ['lead', 'contact', 'qualified_lead', 'schedule', 'purchase'];
// Raw lead/contact measure acquisition. Qualified Lead and Schedule are the
// offline CRM milestones that make Mide y entiende useful for diagnosis, so a
// fresh onboarding must provision both instead of waiting for a manual patch.
const DEFAULT_ENABLED_CONVERSION_EVENTS = ['lead', 'contact', 'qualified_lead', 'schedule'];
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
const LEGACY_STRATEGY_STATUS_MAP = Object.freeze({
  borrador: 'draft',
  pendiente_aceptacion: 'pending_approval',
  activa: 'active',
  pausada: 'paused',
  finalizada: 'completed'
});
const STRATEGY_MODE_FALLBACK_STATUSES = new Set(['active', 'paused']);

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
  qualified_lead: {
    name: 'Qualified Lead - ClinicaClick',
    category: 'QUALIFIED_LEAD',
    detect: ['qualified lead', 'lead válido', 'lead valido', 'cualificado']
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
  if (
    normalizeLookupToken(lead?.google_ads_customer_id)
    || normalizeLookupToken(lead?.google_ads_campaign_id)
    || normalizeLookupToken(lead?.gclid)
    || normalizeLookupToken(lead?.gbraid)
    || normalizeLookupToken(lead?.wbraid)
  ) {
    return 'google_ads';
  }
  if (normalizeLookupToken(lead?.fbclid)) {
    return 'meta_ads';
  }

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

function dateOnlyUtc(year, month, day) {
  return new Date(Date.UTC(year, month - 1, day));
}

function shiftDateOnlyUtc(date, days) {
  const shifted = new Date(date.getTime());
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted;
}

function parseDateOnlyUtc(raw, fallback = null) {
  const match = String(raw || '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return fallback;
  const parsed = dateOnlyUtc(Number(match[1]), Number(match[2]), Number(match[3]));
  return Number.isNaN(parsed.getTime()) ? fallback : parsed;
}

function zonedCalendarParts(date, timeZone = CAMPAIGN_REPORTING_TIME_ZONE) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23'
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second)
  };
}

function zonedDateTimeToUtc({ year, month, day, hour = 0, minute = 0, second = 0 }, timeZone = CAMPAIGN_REPORTING_TIME_ZONE) {
  const targetUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let candidate = targetUtc;

  // Resolve the time-zone offset at the target instant. Repeating handles the
  // offset transition around DST boundaries without relying on MySQL tz tables.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedCalendarParts(new Date(candidate), timeZone);
    const representedUtc = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second
    );
    const next = candidate + (targetUtc - representedUtc);
    if (next === candidate) break;
    candidate = next;
  }

  return new Date(candidate);
}

function buildZonedCalendarRange(startDate, endDate, timeZone = CAMPAIGN_REPORTING_TIME_ZONE) {
  const start = startDate instanceof Date ? startDate : parseDateOnlyUtc(startDate);
  const end = endDate instanceof Date ? endDate : parseDateOnlyUtc(endDate);
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return null;
  }

  const endNext = shiftDateOnlyUtc(end, 1);
  return {
    start: zonedDateTimeToUtc({
      year: start.getUTCFullYear(),
      month: start.getUTCMonth() + 1,
      day: start.getUTCDate()
    }, timeZone),
    endExclusive: zonedDateTimeToUtc({
      year: endNext.getUTCFullYear(),
      month: endNext.getUTCMonth() + 1,
      day: endNext.getUTCDate()
    }, timeZone),
    timeZone
  };
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

async function enqueueMeasurementControlPlaneAfterWrite(req, origin) {
  try {
    return await enqueueGoogleDataManagerControlPlaneReconciliation({
      origin,
      requestedBy: getUserId(req),
      requestedByName: req?.userData?.name
        || req?.userData?.nombre
        || req?.userData?.email
        || null,
      requestedByRole: req?.userData?.role || req?.userData?.rol || null,
    });
  } catch (error) {
    // The configuration write is already durable. The six-hour safety pass
    // will recover if this immediate enqueue is temporarily unavailable.
    console.warn('No se pudo encolar la reconciliación inmediata de medición:', error.message || error);
    return null;
  }
}

function hasScopeText(scopesText, scope) {
  if (!scopesText || !scope) return false;
  return String(scopesText).split(/[\s,]+/).includes(scope);
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
            campaign_ids: listToUniqueArray(
              (Array.isArray(item.campaign_ids) ? item.campaign_ids : Array.isArray(item.campaignIds) ? item.campaignIds : [])
                .map((value) => normalizeCustomerId(value))
                .filter(Boolean)
            ),
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
    normalizedEvent.campaign_ids = listToUniqueArray(
      (Array.isArray(eventCfg.campaign_ids) ? eventCfg.campaign_ids : Array.isArray(eventCfg.campaignIds) ? eventCfg.campaignIds : [])
        .map((value) => normalizeCustomerId(value))
        .filter(Boolean)
    );
    if (hasDestinations) normalizedEvent.destinations = destinations;
    normalized.events[key] = normalizedEvent;
  }
  return normalized;
}

function normalizeCampaignConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return {
      active_mode: null,
      mode_contract: null,
      last_onboarding_id: null,
      last_onboarding_at: null
    };
  }

  const activeMode = String(rawConfig.active_mode || rawConfig.activeMode || '').trim().toLowerCase();
  const normalizedActiveMode = VALID_MODES.has(activeMode) ? activeMode : null;
  const rawModeContract = rawConfig.mode_contract && typeof rawConfig.mode_contract === 'object'
    ? rawConfig.mode_contract
    : rawConfig.modeContract && typeof rawConfig.modeContract === 'object'
      ? rawConfig.modeContract
      : null;
  return {
    active_mode: normalizedActiveMode,
    mode_contract: normalizedActiveMode
      ? buildCampaignModeContract(normalizedActiveMode, rawModeContract?.authorization)
      : null,
    last_onboarding_id: parseInteger(rawConfig.last_onboarding_id || rawConfig.lastOnboardingId) || null,
    last_onboarding_at: rawConfig.last_onboarding_at || rawConfig.lastOnboardingAt || null
  };
}

function normalizeStrategyStatus(rawStatus) {
  const status = String(rawStatus || '').trim().toLowerCase();
  if (VALID_STRATEGY_STATUSES.has(status)) {
    return status;
  }
  return LEGACY_STRATEGY_STATUS_MAP[status] || 'draft';
}

function normalizeStoredStrategyStatus(rawStatus) {
  const status = String(rawStatus || '').trim().toLowerCase();
  if (!VALID_STRATEGY_STATUSES.has(status) && !LEGACY_STRATEGY_STATUS_MAP[status]) {
    return null;
  }
  return normalizeStrategyStatus(status);
}

function strategyCanProvideModeFallback(payload, row, mode) {
  const payloadStatus = normalizeStoredStrategyStatus(payload?.status || row?.estado);
  const persistedStatus = normalizeStoredStrategyStatus(row?.estado);
  if (
    !STRATEGY_MODE_FALLBACK_STATUSES.has(payloadStatus)
    || !STRATEGY_MODE_FALLBACK_STATUSES.has(persistedStatus)
  ) {
    return false;
  }

  if (!usesExistingAdvertiserCampaigns(mode)) return true;
  const readiness = payload?.activation_readiness && typeof payload.activation_readiness === 'object'
    && !Array.isArray(payload.activation_readiness)
    ? payload.activation_readiness
    : {};
  return readiness.ready === true
    && readiness.validated === true
    && readiness.validate_only === true;
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

function buildCurrentExternalCampaignInventoryIndex(rows = []) {
  const index = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const identity = canonicalExternalCampaignIdentity({
      provider: row?.provider,
      account_id: row?.customer_id,
      customer_id: row?.customer_id,
      campaign_id: row?.campaign_id,
      external_campaign_id: row?.campaign_id,
    });
    const key = externalCampaignIdentityKey(identity);
    if (!key) continue;

    const previous = index.get(key);
    const previousSeenAt = new Date(previous?.last_seen_at || previous?.updated_at || 0).getTime();
    const currentSeenAt = new Date(row?.last_seen_at || row?.updated_at || 0).getTime();
    if (previous && previousSeenAt > currentSeenAt) continue;
    index.set(key, row);
  }
  return index;
}

function overlayExternalTargetsWithInventory(rawTargets, inventoryIndex) {
  const targets = normalizeExternalTargets(rawTargets);
  if (!(inventoryIndex instanceof Map) || inventoryIndex.size === 0) {
    return targets;
  }

  return targets.map((target) => ({
    ...target,
    campaigns: target.campaigns.map((campaign) => {
      const inventory = inventoryIndex.get(externalCampaignIdentityKey(campaign));
      if (!inventory) return campaign;
      const currentName = String(inventory.campaign_name || '').trim();
      const currentStatus = String(inventory.status || '').trim();
      return {
        ...campaign,
        ...(currentName ? { name: currentName } : {}),
        ...(currentStatus ? { status: currentStatus } : {}),
      };
    }),
  }));
}

async function loadCurrentExternalCampaignInventoryIndex(payloads = []) {
  if (!ExternalCampaignInventory) return new Map();

  const refs = {
    google_ads: { accountIds: new Set(), campaignIds: new Set(), identities: new Set() },
    meta_ads: { accountIds: new Set(), campaignIds: new Set(), identities: new Set() },
  };
  for (const payload of Array.isArray(payloads) ? payloads : []) {
    const payloadRefs = collectExternalCampaignRefs(payload);
    for (const provider of ['google_ads', 'meta_ads']) {
      for (const value of payloadRefs[provider].accountIds) refs[provider].accountIds.add(value);
      for (const value of payloadRefs[provider].campaignIds) refs[provider].campaignIds.add(value);
      for (const key of payloadRefs[provider].identities.keys()) refs[provider].identities.add(key);
    }
  }

  const where = [];
  for (const provider of ['google_ads', 'meta_ads']) {
    const accountIds = Array.from(refs[provider].accountIds).filter(Boolean);
    const campaignIds = Array.from(refs[provider].campaignIds).filter(Boolean);
    if (!accountIds.length || !campaignIds.length) continue;
    where.push({
      provider,
      customer_id: { [Op.in]: accountIds },
      campaign_id: { [Op.in]: campaignIds },
    });
  }
  if (!where.length) return new Map();

  const rows = await ExternalCampaignInventory.findAll({
    where: { [Op.or]: where },
    raw: true,
  });
  return buildCurrentExternalCampaignInventoryIndex(rows.filter((row) => {
    const key = externalCampaignIdentityKey({
      provider: row.provider,
      account_id: row.customer_id,
      campaign_id: row.campaign_id,
    });
    return refs[row.provider]?.identities.has(key) === true;
  }));
}

async function enrichSingleMetaCampaignReference({ scope, campaignRef }) {
  const campaignId = String(campaignRef?.external_campaign_id || '').trim();
  if (!campaignId) {
    return campaignRef;
  }

  const mappedAccess = await resolveMetaCampaignMappingAccess({
    scope,
    adAccountId: campaignRef?.account_id
  });
  if (!mappedAccess?.connection?.accessToken) {
    return {
      ...campaignRef,
      destination_detection: normalizeExternalCampaignDetection(campaignRef?.destination_detection)
        || createUnknownDestinationDetection(mappedAccess?.reason || 'meta_mapping_connection_unavailable')
    };
  }
  const adAccountId = mappedAccess.adAccountId;

  const baseDetection = normalizeExternalCampaignDetection(campaignRef?.destination_detection);
  const adsetRows = await SocialAdsEntity.findAll({
    where: {
      level: 'adset',
      parent_id: campaignId,
      ad_account_id: adAccountId
    },
    raw: true
  });
  const adsetIds = adsetRows.map((row) => String(row.entity_id || '').trim()).filter(Boolean);
  const adRows = adsetIds.length
    ? await SocialAdsEntity.findAll({
        where: {
          level: 'ad',
          parent_id: { [Op.in]: adsetIds },
          ad_account_id: adAccountId
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
        ad_account_id: adAccountId,
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

  const [enrichedCampaign] = await enrichMetaCampaignDetections({
    campaigns: [{
      ...campaignRef,
      destination_detection: destinationDetection
    }],
    accessToken: mappedAccess.connection.accessToken,
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

function buildLeadAttributionMetrics(rows, rawTargets) {
  const aliasIndex = buildExternalCampaignAliasIndex(rawTargets);
  const linkedCampaignKeys = new Set();
  for (const target of normalizeExternalTargets(rawTargets)) {
    for (const campaign of target.campaigns) {
      const key = externalCampaignIdentityKey(campaign);
      if (key) linkedCampaignKeys.add(key);
    }
  }

  const metricsIndex = new Map();
  const unassignedIndex = new Map();
  const aggregate = {
    clinic_paid_leads: 0,
    linked_leads: 0,
    linked_qualified_leads: 0,
    linked_appointments: 0,
    linked_crm_conversions: 0,
    unassigned_clinic_leads: 0,
    unassigned_by_provider: {
      google_ads: 0,
      meta_ads: 0
    }
  };

  const incrementUnassigned = (row, provider, directIdentity = null) => {
    aggregate.unassigned_clinic_leads += 1;
    if (Object.prototype.hasOwnProperty.call(aggregate.unassigned_by_provider, provider)) {
      aggregate.unassigned_by_provider[provider] += 1;
    }

    const accountId = provider === 'google_ads'
      ? normalizeCustomerId(row?.google_ads_customer_id || '') || null
      : null;
    const campaignId = provider === 'google_ads'
      ? normalizeLookupToken(row?.google_ads_campaign_id) || null
      : null;
    const key = directIdentity
      ? externalCampaignIdentityKey(directIdentity)
      : `${provider}:${accountId || 'unknown'}:${campaignId || 'unknown'}`;
    const current = unassignedIndex.get(key) || {
      provider,
      account_id: accountId,
      campaign_id: campaignId,
      leads: 0
    };
    current.leads += 1;
    unassignedIndex.set(key, current);
  };

  for (const row of Array.isArray(rows) ? rows : []) {
    if (row?.archived_at || String(row?.status_lead || '').trim().toLowerCase() === 'descartado') {
      continue;
    }

    const provider = resolveLeadProvider(row);
    if (!provider) continue;
    aggregate.clinic_paid_leads += 1;

    const matchedCampaigns = new Set();
    const richAccountId = provider === 'google_ads'
      ? normalizeCustomerId(row?.google_ads_customer_id || '')
      : '';
    const richCampaignId = provider === 'google_ads'
      ? normalizeLookupToken(row?.google_ads_campaign_id)
      : '';
    const hasCanonicalRichIdentity = Boolean(richAccountId && richCampaignId);
    const directIdentity = hasCanonicalRichIdentity
      ? canonicalExternalCampaignIdentity({
          provider,
          account_id: richAccountId,
          campaign_id: richCampaignId
        })
      : null;

    // Rich attribution is authoritative. If account + campaign points outside
    // this strategy, do not fall back to a stale UTM name that happens to match.
    if (directIdentity) {
      const directKey = externalCampaignIdentityKey(directIdentity);
      if (directKey && linkedCampaignKeys.has(directKey)) {
        matchedCampaigns.add(directKey);
      }
    } else {
      const tokens = [
        richCampaignId,
        normalizeLookupToken(row?.utm_campaign),
        normalizeLookupToken(row?.source_detail)
      ].filter(Boolean);

      for (const token of tokens) {
        const aliasKey = `${provider}:${token}`;
        const campaignKeys = aliasIndex.get(aliasKey);
        if (!campaignKeys || campaignKeys.size !== 1) continue;
        for (const campaignKey of campaignKeys) {
          matchedCampaigns.add(campaignKey);
        }
      }
    }

    if (matchedCampaigns.size !== 1) {
      incrementUnassigned(row, provider, directIdentity);
      continue;
    }

    const [campaignKey] = Array.from(matchedCampaigns);
    const current = metricsIndex.get(campaignKey) || {
      leads: 0,
      qualified_leads: 0,
      appointments: 0,
      crm_conversions: 0
    };
    const status = String(row?.status_lead || '').trim().toLowerCase();

    current.leads += 1;
    aggregate.linked_leads += 1;
    if (QUALIFIED_LEAD_STATUSES.has(status)) {
      current.qualified_leads += 1;
      aggregate.linked_qualified_leads += 1;
    }
    if (APPOINTMENT_LEAD_STATUSES.has(status)) {
      current.appointments += 1;
      aggregate.linked_appointments += 1;
    }
    if (status === 'convertido') {
      current.crm_conversions += 1;
      aggregate.linked_crm_conversions += 1;
    }

    metricsIndex.set(campaignKey, current);
  }

  return {
    metricsIndex,
    aggregate,
    unassignedCampaigns: Array.from(unassignedIndex.values())
      .sort((a, b) => safeNumber(b.leads) - safeNumber(a.leads))
  };
}

async function loadCurrentLeadAttributionMetrics({
  scope,
  payload,
  days = 30,
  startDate = null,
  endDate = null,
  timeZone = CAMPAIGN_REPORTING_TIME_ZONE
}) {
  if (!LeadIntake) {
    return buildLeadAttributionMetrics([], payload?.external_targets);
  }

  const calendarRange = startDate && endDate
    ? buildZonedCalendarRange(startDate, endDate, timeZone)
    : null;
  const end = calendarRange?.endExclusive || new Date();
  const start = calendarRange?.start || new Date(end.getTime() - (days * 24 * 60 * 60 * 1000));

  const rows = await LeadIntake.findAll({
    attributes: [
      'id',
      'source',
      'external_source',
      'utm_source',
      'utm_campaign',
      'source_detail',
      'status_lead',
      'google_ads_customer_id',
      'google_ads_campaign_id',
      'gclid',
      'gbraid',
      'wbraid',
      'fbclid',
      'archived_at'
    ],
    where: {
      archived_at: null,
      created_at: { [Op.gte]: start, [Op.lt]: end },
      status_lead: { [Op.ne]: 'descartado' },
      ...buildMetricsScopeWhere(scope, { clinicField: 'clinica_id', groupField: 'grupo_clinica_id' })
    },
    raw: true
  });

  return buildLeadAttributionMetrics(rows, payload?.external_targets);
}

async function loadCurrentLeadAttributionMetricsIndex(options) {
  const result = await loadCurrentLeadAttributionMetrics(options);
  return result.metricsIndex;
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

function distinctMappedConnectionIds(rows, field) {
  return Array.from(new Set((Array.isArray(rows) ? rows : [])
    .map((row) => Number.parseInt(String(row?.[field] ?? ''), 10))
    .filter((id) => Number.isInteger(id) && id > 0)));
}

function preferDirectClinicMappings(rows, scope) {
  const candidates = Array.isArray(rows) ? rows : [];
  if (scope?.assignment_scope !== 'clinic' || !scope?.clinic_id) return candidates;
  const direct = candidates.filter((row) => Number(row?.clinicaId) === Number(scope.clinic_id));
  return direct.length ? direct : candidates;
}

async function resolveGoogleCampaignMappingAccess({
  scope,
  customerId,
  accountModel = ClinicGoogleAdsAccount,
  connectionModel = GoogleConnection
}) {
  const normalizedCustomerId = normalizeCustomerId(customerId);
  if (!normalizedCustomerId) {
    return { account: null, connection: null, reason: 'google_ads_customer_missing' };
  }
  const rows = await accountModel.findAll({
    where: {
      customerId: normalizedCustomerId,
      isActive: true,
      ...buildScopeWhere(scope)
    },
    order: [['updated_at', 'DESC']],
    raw: true
  });
  const candidates = preferDirectClinicMappings(rows, scope);
  const connectionIds = distinctMappedConnectionIds(candidates, 'googleConnectionId');
  if (connectionIds.length !== 1) {
    return {
      account: null,
      connection: null,
      reason: connectionIds.length > 1
        ? 'google_ads_account_mapping_ambiguous'
        : 'google_ads_account_mapping_missing'
    };
  }
  const connection = await connectionModel.findByPk(connectionIds[0]);
  if (!connection || Number(connection.id) !== connectionIds[0]) {
    return { account: null, connection: null, reason: 'google_ads_mapping_connection_missing' };
  }
  return {
    account: candidates.find((row) => Number(row.googleConnectionId) === connectionIds[0]) || null,
    connection,
    reason: null
  };
}

function buildMetaAccountConnectionMap(metaAssets, scope = null) {
  const buckets = new Map();
  for (const row of Array.isArray(metaAssets) ? metaAssets : []) {
    const adAccountId = normalizeMetaAdAccountId(row?.metaAssetId);
    if (!adAccountId) continue;
    if (!buckets.has(adAccountId)) buckets.set(adAccountId, []);
    buckets.get(adAccountId).push(row);
  }

  const accountMap = new Map();
  const authorizationIssues = [];
  for (const [adAccountId, rows] of buckets.entries()) {
    const candidates = preferDirectClinicMappings(rows, scope);
    const connectionIds = distinctMappedConnectionIds(candidates, 'metaConnectionId');
    const representative = candidates[0] || {};
    const ready = connectionIds.length === 1;
    accountMap.set(adAccountId, {
      ad_account_id: adAccountId,
      name: representative.metaAssetName || null,
      clinicaId: representative.clinicaId || null,
      grupoClinicaId: representative.grupoClinicaId || null,
      metaConnectionId: ready ? connectionIds[0] : null,
      authorization_status: ready ? 'ready' : (connectionIds.length > 1 ? 'ambiguous' : 'missing')
    });
    if (!ready) {
      authorizationIssues.push({
        ad_account_id: adAccountId,
        reason: connectionIds.length > 1
          ? 'meta_account_mapping_ambiguous'
          : 'meta_account_mapping_connection_missing'
      });
    }
  }
  return { accountMap, authorizationIssues };
}

function metaConnectionUsability(connection, nowMs = Date.now()) {
  if (!connection?.id || !connection?.accessToken) {
    return { usable: false, reason: 'meta_mapping_connection_missing' };
  }
  const expiresAtMs = connection.expiresAt ? new Date(connection.expiresAt).getTime() : NaN;
  if (!Number.isFinite(expiresAtMs)) {
    return { usable: false, reason: 'meta_mapping_token_expiry_unknown' };
  }
  if (expiresAtMs <= nowMs) {
    return { usable: false, reason: 'meta_mapping_token_expired' };
  }
  return { usable: true, reason: null };
}

async function resolveMetaCampaignMappingAccess({
  scope,
  adAccountId,
  assetModel = ClinicMetaAsset,
  connectionModel = MetaConnection,
  nowMs = Date.now()
}) {
  const normalizedAdAccountId = normalizeMetaAdAccountId(adAccountId);
  if (!normalizedAdAccountId) {
    return { adAccountId: null, asset: null, connection: null, reason: 'meta_ad_account_missing' };
  }
  const rawAdAccountId = normalizedAdAccountId.replace(/^act_/, '');
  const rows = await assetModel.findAll({
    where: {
      isActive: true,
      assetType: 'ad_account',
      metaAssetId: { [Op.in]: [normalizedAdAccountId, rawAdAccountId] },
      ...buildScopeWhere(scope)
    },
    order: [['updatedAt', 'DESC']],
    raw: true
  });
  const candidates = preferDirectClinicMappings(rows, scope);
  const connectionIds = distinctMappedConnectionIds(candidates, 'metaConnectionId');
  if (connectionIds.length !== 1) {
    return {
      adAccountId: normalizedAdAccountId,
      asset: null,
      connection: null,
      reason: connectionIds.length > 1
        ? 'meta_account_mapping_ambiguous'
        : 'meta_account_mapping_missing'
    };
  }
  const connection = await connectionModel.findByPk(connectionIds[0]);
  const health = metaConnectionUsability(connection, nowMs);
  if (!health.usable) {
    return {
      adAccountId: normalizedAdAccountId,
      asset: null,
      connection: null,
      reason: health.reason
    };
  }
  return {
    adAccountId: normalizedAdAccountId,
    asset: candidates.find((row) => Number(row.metaConnectionId) === connectionIds[0]) || null,
    connection,
    reason: null
  };
}

async function enrichMetaCampaignsWithMappedConnections({
  campaigns,
  metaAccountMap,
  campaignAdRows,
  connectionModel = MetaConnection,
  enrich = enrichMetaCampaignDetections,
  nowMs = Date.now()
}) {
  const output = Array.isArray(campaigns) ? campaigns.slice() : [];
  const groups = new Map();
  const authorizationIssues = [];
  for (let index = 0; index < output.length; index += 1) {
    const campaign = output[index];
    const adAccountId = normalizeMetaAdAccountId(campaign?.account_id);
    const mapping = adAccountId ? metaAccountMap.get(adAccountId) : null;
    if (!mapping?.metaConnectionId) {
      authorizationIssues.push({
        ad_account_id: adAccountId,
        campaign_id: String(campaign?.external_campaign_id || '') || null,
        reason: mapping?.authorization_status === 'ambiguous'
          ? 'meta_account_mapping_ambiguous'
          : 'meta_account_mapping_connection_missing'
      });
      continue;
    }
    if (!groups.has(mapping.metaConnectionId)) groups.set(mapping.metaConnectionId, []);
    groups.get(mapping.metaConnectionId).push({ index, campaign, adAccountId });
  }

  for (const [connectionId, group] of groups.entries()) {
    const connection = await connectionModel.findByPk(connectionId);
    const health = metaConnectionUsability(connection, nowMs);
    if (!health.usable) {
      for (const item of group) {
        authorizationIssues.push({
          ad_account_id: item.adAccountId,
          campaign_id: String(item.campaign?.external_campaign_id || '') || null,
          reason: health.reason
        });
      }
      continue;
    }
    const enriched = await enrich({
      campaigns: group.map((item) => item.campaign),
      accessToken: connection.accessToken,
      campaignAdRows
    });
    for (let index = 0; index < group.length; index += 1) {
      output[group[index].index] = enriched[index] || group[index].campaign;
    }
  }

  return { campaigns: output, authorizationIssues };
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

function mergeCurrentGoogleCampaignInventory({
  campaigns = [],
  inventoryRows = [],
  reviewedByCampaign = new Map(),
  googleAccountMap = new Map(),
  scope = {},
  activeOnly = true,
} = {}) {
  const merged = (Array.isArray(campaigns) ? campaigns : []).map((item) => ({ ...item }));
  const byKey = new Map(merged.map((item, index) => [
    `${normalizeCustomerId(item.account_id)}:${String(item.external_campaign_id || '')}`,
    index,
  ]));

  for (const inventory of Array.isArray(inventoryRows) ? inventoryRows : []) {
    const customerId = normalizeCustomerId(inventory?.customer_id || '');
    const campaignId = String(inventory?.campaign_id || '').trim();
    if (!customerId || !campaignId) continue;
    const key = `${customerId}:${campaignId}`;
    const assignment = reviewedByCampaign.get(key);
    const existingIndex = byKey.get(key);
    const currentName = String(inventory.campaign_name || '').trim() || null;
    const currentStatus = String(inventory.status || '').trim() || null;
    if (existingIndex !== undefined) {
      const existing = merged[existingIndex];
      merged[existingIndex] = {
        ...existing,
        account_name: inventory.account_name
          || googleAccountMap.get(customerId)?.descriptive_name
          || existing.account_name
          || null,
        name: currentName || existing.name || null,
        status: currentStatus || existing.status || null,
        last_seen_at: inventory.last_seen_at || existing.last_seen_at || null,
        assignment_origin: assignment ? 'reviewed' : existing.assignment_origin,
      };
      continue;
    }
    if (
      scope.assignment_scope !== 'group'
      && (!assignment || Number(assignment.clinica_id) !== Number(scope.clinic_id))
    ) {
      continue;
    }

    merged.push({
      provider: 'google_ads',
      account_id: customerId,
      account_name: inventory.account_name || googleAccountMap.get(customerId)?.descriptive_name || null,
      external_campaign_id: campaignId,
      name: currentName,
      status: currentStatus,
      clinic_ids: assignment?.clinica_id ? [Number(assignment.clinica_id)] : [],
      group_ids: assignment?.grupo_clinica_id
        ? [Number(assignment.grupo_clinica_id)]
        : (scope.group_id ? [Number(scope.group_id)] : []),
      assignment_origin: assignment ? 'reviewed' : 'inventory',
      metrics: inventory.latest_metrics && typeof inventory.latest_metrics === 'object'
        ? {
            impressions: safeNumber(inventory.latest_metrics.impressions),
            clicks: safeNumber(inventory.latest_metrics.clicks),
            spend: safeNumber(inventory.latest_metrics.spend),
            conversions: safeNumber(inventory.latest_metrics.conversions),
          }
        : { impressions: 0, clicks: 0, spend: 0, conversions: 0 },
      last_seen_at: inventory.last_seen_at || null,
      destination_detection: inventory.destination_detection || createWebDestinationDetection('google_ads_inventory', 'medium'),
    });
    byKey.set(key, merged.length - 1);
  }

  return merged
    .filter((item) => !activeOnly || isGoogleCampaignActive(item.status))
    .sort((left, right) => (
      safeNumber(right.metrics?.spend) - safeNumber(left.metrics?.spend)
      || String(left.name || '').localeCompare(String(right.name || ''))
    ));
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

async function loadIntakeRecordForScope(scope, dependencies = {}) {
  const where = scope.assignment_scope === 'group'
    ? { group_id: scope.group_id, assignment_scope: 'group' }
    : { clinic_id: scope.clinic_id };
  const IntakeConfigModel = dependencies.IntakeConfig || IntakeConfig;
  const record = await IntakeConfigModel.findOne({ where, raw: true });
  return record || null;
}

async function upsertCampaignSettingsForScope(scope, campaignPatch) {
  const where = scope.assignment_scope === 'group'
    ? { group_id: scope.group_id, assignment_scope: 'group' }
    : { clinic_id: scope.clinic_id };

  const patch = normalizeCampaignConfig(campaignPatch || {});
  return db.sequelize.transaction(async (transaction) => {
    const existing = await IntakeConfig.findOne({
      where,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const existingConfig = existing?.config && typeof existing.config === 'object'
      && !Array.isArray(existing.config)
      ? existing.config
      : {};
    const currentCampaigns = normalizeCampaignConfig(existingConfig.campaigns || {});
    const nextCampaigns = { ...currentCampaigns, ...patch };

    if (!existing) {
      await IntakeConfig.create({
        clinic_id: scope.assignment_scope === 'clinic' ? scope.clinic_id : null,
        group_id: scope.assignment_scope === 'group' ? scope.group_id : null,
        assignment_scope: scope.assignment_scope,
        domains: [],
        config: { campaigns: nextCampaigns },
        hmac_key: null,
      }, { transaction });
      return nextCampaigns;
    }
    await existing.update({
      config: {
        ...existingConfig,
        campaigns: nextCampaigns,
      },
    }, { transaction });
    return nextCampaigns;
  });
}

async function listClinicIdsForGroup(groupId, dependencies = {}) {
  if (!groupId) return [];
  const ClinicaModel = dependencies.Clinica || Clinica;
  const clinics = await ClinicaModel.findAll({
    where: { grupoClinicaId: groupId },
    attributes: ['id_clinica'],
    raw: true
  });
  return clinics
    .map((clinic) => parseInteger(clinic.id_clinica))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function normalizeResolvedCampaignMode(modeValue, rawModeContract = null) {
  const mode = String(modeValue || '').trim().toLowerCase();
  if (!VALID_MODES.has(mode)) return null;
  const modeContract = rawModeContract && typeof rawModeContract === 'object'
    && !Array.isArray(rawModeContract)
    ? rawModeContract
    : null;
  return {
    mode,
    mode_contract: buildCampaignModeContract(mode, modeContract?.authorization || null)
  };
}

async function findLatestCampaignOnboardingMode(where, matcher, dependencies = {}) {
  const CampaignRequestModel = dependencies.CampaignRequest || CampaignRequest;
  const pageSize = 50;

  // Keep onboarding ahead of the strategy fallback even for scopes with a
  // long CampaignRequest history. A fixed first page could otherwise hide the
  // completed onboarding that established the scope's mode.
  for (let offset = 0; ; offset += pageSize) {
    const rows = await CampaignRequestModel.findAll({
      where,
      attributes: ['id', 'clinica_id', 'solicitud', 'created_at'],
      order: [['created_at', 'DESC'], ['id', 'DESC']],
      limit: pageSize,
      offset,
      raw: true
    });

    for (const row of rows) {
      const payload = row?.solicitud && typeof row.solicitud === 'object' ? row.solicitud : {};
      if (payload.kind !== 'campaign_onboarding' || payload.status !== 'completed') {
        continue;
      }

      if (matcher(payload)) {
        const resolved = normalizeResolvedCampaignMode(payload.mode, payload.mode_contract);
        if (resolved) return resolved;
      }
    }

    if (rows.length < pageSize) return null;
  }
}

async function findLatestMarketingStrategyMode(where, matcher, dependencies = {}) {
  const CampaignRequestModel = dependencies.CampaignRequest || CampaignRequest;
  const pageSize = 50;

  // CampaignRequests stores both onboarding commands and strategies. Paginate
  // through the scoped rows so a long history of completed requests cannot hide
  // the newest still-open strategy behind an arbitrary fixed limit.
  for (let offset = 0; ; offset += pageSize) {
    const rows = await CampaignRequestModel.findAll({
      where,
      attributes: ['id', 'clinica_id', 'solicitud', 'estado', 'created_at', 'updated_at'],
      order: [['updated_at', 'DESC'], ['created_at', 'DESC'], ['id', 'DESC']],
      limit: pageSize,
      offset,
      raw: true
    });

    for (const row of rows) {
      const payload = row?.solicitud && typeof row.solicitud === 'object' ? row.solicitud : {};
      if (payload.kind !== 'marketing_strategy') continue;
      if (!matcher(payload, row)) continue;

      const resolved = normalizeResolvedCampaignMode(
        payload.mode_snapshot || payload.mode,
        payload.mode_contract
      );
      if (!resolved || !strategyCanProvideModeFallback(payload, row, resolved.mode)) continue;

      // The readiness evidence only authorizes the snapshot as a source for the
      // tier. Existing consent and provider gates still decide whether the
      // strategy can run; this resolver never promotes or activates it.
      return resolved;
    }

    if (rows.length < pageSize) return null;
  }
}

async function resolveModeStateForScope(scope, dependencies = {}) {
  if (!scope || typeof scope !== 'object') return null;

  if (scope.assignment_scope === 'clinic' && scope.clinic_id) {
    const clinicRecord = await loadIntakeRecordForScope({
      assignment_scope: 'clinic',
      clinic_id: scope.clinic_id
    }, dependencies);
    const clinicConfig = normalizeCampaignConfig(clinicRecord?.config?.campaigns || {});
    if (clinicConfig.active_mode) {
      return {
        mode: clinicConfig.active_mode,
        mode_contract: clinicConfig.mode_contract
      };
    }

    if (scope.group_id) {
      const groupRecord = await loadIntakeRecordForScope({
        assignment_scope: 'group',
        group_id: scope.group_id
      }, dependencies);
      const groupConfig = normalizeCampaignConfig(groupRecord?.config?.campaigns || {});
      if (groupConfig.active_mode) {
        return {
          mode: groupConfig.active_mode,
          mode_contract: groupConfig.mode_contract
        };
      }
    }

    const clinicMode = await findLatestCampaignOnboardingMode(
      { clinica_id: scope.clinic_id },
      (payload) => {
        const payloadScope = payload.scope && typeof payload.scope === 'object' ? payload.scope : {};
        return payloadScope.assignment_scope === 'clinic'
          && parseInteger(payloadScope.clinic_id) === scope.clinic_id;
      },
      dependencies
    );

    if (clinicMode) {
      return clinicMode;
    }

    let groupClinicIds = [];
    if (scope.group_id) {
      groupClinicIds = await listClinicIdsForGroup(scope.group_id, dependencies);
      if (groupClinicIds.length > 0) {
        const operators = dependencies.operators || Op;
        const groupMode = await findLatestCampaignOnboardingMode(
          { clinica_id: { [operators.in]: groupClinicIds } },
          (payload) => {
            const payloadScope = payload.scope && typeof payload.scope === 'object' ? payload.scope : {};
            return payloadScope.assignment_scope === 'group'
              && parseInteger(payloadScope.group_id) === scope.group_id;
          },
          dependencies
        );
        if (groupMode) return groupMode;
      }
    }

    const clinicStrategyMode = await findLatestMarketingStrategyMode(
      { clinica_id: scope.clinic_id },
      (payload) => {
        const payloadScope = payload.scope && typeof payload.scope === 'object' ? payload.scope : {};
        return payloadScope.assignment_scope === 'clinic'
          && parseInteger(payloadScope.clinic_id) === scope.clinic_id;
      },
      dependencies
    );
    if (clinicStrategyMode) return clinicStrategyMode;

    if (scope.group_id && groupClinicIds.length > 0) {
      const operators = dependencies.operators || Op;
      return findLatestMarketingStrategyMode(
        { clinica_id: { [operators.in]: groupClinicIds } },
        (payload) => {
          const payloadScope = payload.scope && typeof payload.scope === 'object' ? payload.scope : {};
          return payloadScope.assignment_scope === 'group'
            && parseInteger(payloadScope.group_id) === scope.group_id;
        },
        dependencies
      );
    }

    return null;
  }

  if (scope.assignment_scope === 'group' && scope.group_id) {
    const groupRecord = await loadIntakeRecordForScope({
      assignment_scope: 'group',
      group_id: scope.group_id
    }, dependencies);
    const groupConfig = normalizeCampaignConfig(groupRecord?.config?.campaigns || {});
    if (groupConfig.active_mode) {
      return {
        mode: groupConfig.active_mode,
        mode_contract: groupConfig.mode_contract
      };
    }

    const groupClinicIds = Array.isArray(scope.clinic_ids) && scope.clinic_ids.length > 0
      ? scope.clinic_ids
      : await listClinicIdsForGroup(scope.group_id, dependencies);

    if (groupClinicIds.length === 0) {
      return null;
    }

    const operators = dependencies.operators || Op;
    const onboardingMode = await findLatestCampaignOnboardingMode(
      { clinica_id: { [operators.in]: groupClinicIds } },
      (payload) => {
        const payloadScope = payload.scope && typeof payload.scope === 'object' ? payload.scope : {};
        return payloadScope.assignment_scope === 'group'
          && parseInteger(payloadScope.group_id) === scope.group_id;
      },
      dependencies
    );
    if (onboardingMode) return onboardingMode;

    return findLatestMarketingStrategyMode(
      { clinica_id: { [operators.in]: groupClinicIds } },
      (payload) => {
        const payloadScope = payload.scope && typeof payload.scope === 'object' ? payload.scope : {};
        return payloadScope.assignment_scope === 'group'
          && parseInteger(payloadScope.group_id) === scope.group_id;
      },
      dependencies
    );
  }

  return null;
}

async function resolveActiveModeForScope(scope, dependencies = {}) {
  const resolved = await resolveModeStateForScope(scope, dependencies);
  return resolved?.mode || null;
}

async function resolveModeContractForScope(scope, dependencies = {}) {
  const resolved = await resolveModeStateForScope(scope, dependencies);
  return resolved?.mode_contract || null;
}

function normalizeModeTransitionConfirmation(rawValue) {
  const source = rawValue && typeof rawValue === 'object' && !Array.isArray(rawValue)
    ? rawValue
    : {};
  return {
    confirmed: source.confirmed === true,
    from_mode: String(source.from_mode || source.fromMode || '').trim().toLowerCase() || null,
    to_mode: String(source.to_mode || source.toMode || '').trim().toLowerCase() || null,
  };
}

async function assertCampaignModeTransitionSafe({
  scope,
  currentMode,
  nextMode,
  confirmation,
  dependencies = {},
}) {
  if (!currentMode || currentMode === nextMode) return null;
  const normalized = normalizeModeTransitionConfirmation(confirmation);
  if (
    normalized.confirmed !== true
    || normalized.from_mode !== currentMode
    || normalized.to_mode !== nextMode
  ) {
    const error = new Error('Confirma expresamente el cambio de nivel antes de guardar la nueva configuración.');
    error.code = 'CAMPAIGN_MODE_TRANSITION_CONFIRMATION_REQUIRED';
    error.httpStatus = 409;
    error.details = { from_mode: currentMode, to_mode: nextMode };
    throw error;
  }

  const clinicIds = scope.assignment_scope === 'clinic'
    ? [scope.clinic_id].filter(Boolean)
    : (scope.clinic_ids || []);
  const CampaignRequestModel = dependencies.CampaignRequest || CampaignRequest;
  const PolicyModel = dependencies.Policy || db.CampaignOptimizationPolicy;
  const operators = dependencies.operators || Op;
  const rows = clinicIds.length
    ? await CampaignRequestModel.findAll({
        where: { clinica_id: { [operators.in]: clinicIds } },
        attributes: ['id', 'campaign_id', 'solicitud'],
        order: [['updated_at', 'DESC'], ['id', 'DESC']],
        raw: true,
      })
    : [];
  const blockingStrategies = [];
  const seen = new Set();
  for (const row of rows) {
    const payload = row?.solicitud && typeof row.solicitud === 'object' ? row.solicitud : {};
    if (payload.kind !== 'marketing_strategy') continue;
    const status = normalizeStrategyStatus(payload.status || row.estado);
    const mode = String(payload.mode_snapshot || payload.mode || '').trim().toLowerCase();
    const identity = String(row.campaign_id || row.id);
    if (status !== 'completed' && mode !== nextMode && !seen.has(identity)) {
      seen.add(identity);
      blockingStrategies.push({ strategy_id: row.campaign_id || row.id, mode: mode || null, status });
    }
  }
  if (blockingStrategies.length) {
    const error = new Error('Completa o conserva en su nivel actual las estrategias en curso antes de cambiar de nivel.');
    error.code = 'CAMPAIGN_MODE_TRANSITION_ACTIVE_STRATEGIES';
    error.httpStatus = 409;
    error.details = { strategies: blockingStrategies.slice(0, 20) };
    throw error;
  }

  const policyScope = scope.assignment_scope === 'group'
    ? { scopeType: 'group', scopeId: scope.group_id }
    : { scopeType: 'clinic', scopeId: scope.clinic_id };
  const nonTerminalPolicies = await PolicyModel.findAll({
    where: {
      ...policyScope,
      status: { [operators.in]: ['active', 'paused'] },
    },
    attributes: ['id', 'strategyId', 'mode', 'status'],
    raw: true,
  });
  if (nonTerminalPolicies.length) {
    const error = new Error('Hay una política de optimización en curso. Pausa y completa primero su estrategia para evitar perder el control de objetivos.');
    error.code = 'CAMPAIGN_MODE_TRANSITION_ACTIVE_POLICY';
    error.httpStatus = 409;
    error.details = { policies: nonTerminalPolicies.slice(0, 20) };
    throw error;
  }

  return {
    from_mode: currentMode,
    to_mode: nextMode,
    confirmed: true,
  };
}

async function upsertIntakeGoogleAdsForScope(scope, googleAdsPatch, provisioningOptions = null) {
  const where = scope.assignment_scope === 'group'
    ? { group_id: scope.group_id, assignment_scope: 'group' }
    : { clinic_id: scope.clinic_id };

  return db.sequelize.transaction(async (transaction) => {
    const existing = await IntakeConfig.findOne({
      where,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const existingConfig = existing?.config && typeof existing.config === 'object'
      && !Array.isArray(existing.config)
      ? existing.config
      : {};
    const rawGooglePatch = googleAdsPatch && typeof googleAdsPatch === 'object'
      && !Array.isArray(googleAdsPatch)
      ? googleAdsPatch
      : {};
    const normalizedMergedGoogle = provisioningOptions
      ? mergeProvisionedGoogleAdsConfig(
          existingConfig.google_ads || {},
          rawGooglePatch,
          provisioningOptions
        )
      : mergeEffectiveGoogleAdsConfig(existingConfig.google_ads || {}, rawGooglePatch);
    const nextGoogleAds = overlayNormalizedGoogleAdsConfig(
      existingConfig.google_ads,
      normalizedMergedGoogle,
    );

    if (!existing) {
      await IntakeConfig.create({
        clinic_id: scope.assignment_scope === 'clinic' ? scope.clinic_id : null,
        group_id: scope.assignment_scope === 'group' ? scope.group_id : null,
        assignment_scope: scope.assignment_scope,
        domains: [],
        config: { google_ads: nextGoogleAds },
        hmac_key: null,
      }, { transaction });
      return;
    }
    await existing.update({
      config: {
        ...existingConfig,
        google_ads: nextGoogleAds,
      },
    }, { transaction });
  });
}

async function upsertIntakeMetaAdsForScope(scope, metaAdsPatch) {
  const where = scope.assignment_scope === 'group'
    ? { group_id: scope.group_id, assignment_scope: 'group' }
    : { clinic_id: scope.clinic_id };

  const normalizedPatch = normalizeMetaAdsConfig(metaAdsPatch || {});
  return db.sequelize.transaction(async (transaction) => {
    const existing = await IntakeConfig.findOne({
      where,
      transaction,
      lock: transaction.LOCK.UPDATE,
    });
    const existingConfig = existing?.config && typeof existing.config === 'object'
      && !Array.isArray(existing.config)
      ? existing.config
      : {};
    const currentMeta = normalizeMetaAdsConfig(existingConfig.meta_ads || {});
    const mergedMeta = {
      ...currentMeta,
      ...normalizedPatch,
      enabled: normalizedPatch.enabled !== undefined ? normalizedPatch.enabled : currentMeta.enabled,
    };

    if (!existing) {
      await IntakeConfig.create({
        clinic_id: scope.assignment_scope === 'clinic' ? scope.clinic_id : null,
        group_id: scope.assignment_scope === 'group' ? scope.group_id : null,
        assignment_scope: scope.assignment_scope,
        domains: [],
        config: { meta_ads: mergedMeta },
        hmac_key: null,
      }, { transaction });
      return mergedMeta;
    }
    await existing.update({
      config: {
        ...existingConfig,
        meta_ads: mergedMeta,
      },
    }, { transaction });
    return mergedMeta;
  });
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
    counting_type: conversion.countingType || null,
    include_in_conversions_metric: conversion.includeInConversionsMetric !== false,
    primary_for_goal: conversion.primaryForGoal !== false,
    send_to: extractSendToFromTagSnippets(conversion.tagSnippets || [])
  };
}

function buildSuggestedMapping(actions) {
  const mapping = {
    lead: null,
    contact: null,
    qualified_lead: null,
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

function buildClinicaclickManagedMapping(actions) {
  const mapping = { lead: null, contact: null, qualified_lead: null, schedule: null, purchase: null };
  const canonicalNames = new Map(
    VALID_EVENTS.map((key) => [String(EVENT_CATALOG[key].name || '').trim().toLowerCase(), key])
  );
  for (const action of Array.isArray(actions) ? actions : []) {
    const key = canonicalNames.get(String(action?.name || '').trim().toLowerCase());
    if (key && !mapping[key] && action?.id) mapping[key] = String(action.id);
  }
  return mapping;
}

function buildClinicaclickConversionActionCreate(eventKey, currency) {
  if (!VALID_EVENTS.includes(eventKey)) return null;
  return {
    name: EVENT_CATALOG[eventKey].name,
    category: EVENT_CATALOG[eventKey].category,
    type: 'UPLOAD_CLICKS',
    status: 'ENABLED',
    // Las acciones nuevas empiezan como secundarias: recibir datos no debe
    // alterar pujas ni duplicar la columna "Conversiones" del cliente.
    primaryForGoal: false,
    valueSettings: {
      defaultValue: 0,
      alwaysUseDefaultValue: false,
      defaultCurrencyCode: normalizeCurrency(currency)
    },
    // Data Manager rechaza gbraid/wbraid contra acciones ONE_PER_CLICK.
    countingType: 'MANY_PER_CLICK'
  };
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

function buildGoogleAdsCapabilities(
  connected,
  hasAdsScope,
  hasDataManagerScope = false,
  accounts = []
) {
  const adsEnabled = !!connected && !!hasAdsScope;
  const quotaProjectConfigured = Boolean(
    process.env.GOOGLE_DATA_MANAGER_QUOTA_PROJECT
      || process.env.GOOGLE_CLOUD_PROJECT
  );
  const dataManagerMissing = [];
  if (!hasDataManagerScope) dataManagerMissing.push('oauth_scope');
  if (!quotaProjectConfigured) dataManagerMissing.push('quota_project');
  const dataManagerReady = adsEnabled && dataManagerMissing.length === 0;
  const enhancedConversionsEnabledAccounts = (Array.isArray(accounts) ? accounts : [])
    .filter((account) => (
      account?.enhanced_conversions_for_leads_enabled === true
      && GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_CUSTOMER_IDS.includes(
        normalizeCustomerId(account?.customer_id || '')
      )
    ))
    .map((account) => account.customer_id)
    .filter(Boolean);
  return {
    can_list_conversion_actions: adsEnabled,
    can_create_conversion_actions: adsEnabled,
    // Data Manager y la autorización documentada hacen posible el envío, pero
    // Google exige además activar el ajuste en cada cuenta de Ads. Ese campo
    // es de solo lectura en la API y se presenta por cuenta en el bootstrap.
    enhanced_conversions_supported: dataManagerReady,
    can_upload_enhanced_conversions:
      dataManagerReady && enhancedConversionsEnabledAccounts.length > 0,
    enhanced_conversions_enabled_accounts: enhancedConversionsEnabledAccounts,
    enhanced_conversions_require_account_activation:
      dataManagerReady && enhancedConversionsEnabledAccounts.length === 0,
    can_upload_server_side_conversions: dataManagerReady,
    data_manager_ready: dataManagerReady,
    data_manager_scope_granted: !!hasDataManagerScope,
    data_manager_quota_project_configured: quotaProjectConfigured,
    data_manager_missing: dataManagerMissing,
    conversion_validation_required: true,
    conversion_validation_status: 'not_validated',
    user_data_policy: 'documented_account_authorization_required'
  };
}

function readGoogleConversionTrackingSettings(response, customerId) {
  const rows = Array.isArray(response?.results) ? response.results : [];
  const customer = rows[0]?.customer || {};
  const settings = customer.conversionTrackingSetting
    || customer.conversion_tracking_setting
    || {};
  const conversionCustomer = String(
    settings.googleAdsConversionCustomer
      ?? settings.google_ads_conversion_customer
      ?? ''
  ).trim() || null;
  return {
    customer_id: normalizeCustomerId(customer.id || customerId),
    accepted_customer_data_terms:
      (settings.acceptedCustomerDataTerms ?? settings.accepted_customer_data_terms) === true,
    enhanced_conversions_for_leads_enabled:
      (settings.enhancedConversionsForLeadsEnabled
        ?? settings.enhanced_conversions_for_leads_enabled) === true,
    google_ads_conversion_customer: conversionCustomer,
    conversion_customer_id: conversionCustomer
      ? normalizeCustomerId(conversionCustomer.split('/').pop())
      : null
  };
}

async function enrichGoogleAdsAccountsWithConversionTracking({
  userId,
  scope,
  accounts
}) {
  const rows = Array.isArray(accounts) ? accounts : [];
  return Promise.all(rows.map(async (account) => {
    const customerId = normalizeCustomerId(account?.customer_id || '');
    if (!customerId) return account;
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
      return {
        ...account,
        google_connection_healthy: false,
        google_ads_scope_granted: false,
        data_manager_scope_granted: false,
        connection_reason: String(error?.code || 'scoped_google_runtime_unavailable').toLowerCase(),
        conversion_tracking_settings_available: false,
        conversion_tracking_settings_error:
          String(error?.code || error?.response?.data?.error?.status || 'unavailable').toLowerCase()
      };
    }

    const runtimeMetadata = {
      google_connection_healthy: true,
      google_ads_scope_granted: hasScopeText(runtime.connection?.scopes || '', GOOGLE_ADS_SCOPE),
      data_manager_scope_granted: hasScopeText(runtime.connection?.scopes || '', GOOGLE_DATA_MANAGER_SCOPE),
      connection_reason: null,
      connection_source: runtime.connectionSource || null
    };
    try {
      const response = await googleAdsRequest(
        'POST',
        `customers/${customerId}/googleAds:search`,
        {
          accessToken: runtime.accessToken,
          loginCustomerId: runtime.loginCustomerId || undefined,
          singleAttempt: true,
          timeoutMs: 20_000,
          data: {
            query: [
              'SELECT',
              '  customer.id,',
              '  customer.conversion_tracking_setting.accepted_customer_data_terms,',
              '  customer.conversion_tracking_setting.enhanced_conversions_for_leads_enabled,',
              '  customer.conversion_tracking_setting.google_ads_conversion_customer',
              'FROM customer'
            ].join('\n')
          }
        }
      );
      return {
        ...account,
        ...runtimeMetadata,
        ...readGoogleConversionTrackingSettings(response, customerId),
        conversion_tracking_settings_available: true
      };
    } catch (error) {
      return {
        ...account,
        ...runtimeMetadata,
        conversion_tracking_settings_available: false,
        conversion_tracking_settings_error:
          String(error?.code || error?.response?.data?.error?.status || 'unavailable').toLowerCase()
      };
    }
  }));
}

function summarizeGoogleMappedAccountAccess(accounts, customerIds = null) {
  const requested = Array.isArray(customerIds)
    ? new Set(customerIds.map((value) => normalizeCustomerId(value)).filter(Boolean))
    : null;
  const relevant = (Array.isArray(accounts) ? accounts : []).filter((account) => {
    if (!requested) return true;
    return requested.has(normalizeCustomerId(account?.customer_id || ''));
  });
  const healthy = relevant.filter((account) => account?.google_connection_healthy === true);
  return {
    relevant,
    connected: healthy.length > 0,
    all_connected: relevant.length > 0 && healthy.length === relevant.length,
    has_ads_scope: relevant.length > 0 && relevant.every((account) => account?.google_ads_scope_granted === true),
    has_data_manager_scope: relevant.length > 0 && relevant.every((account) => account?.data_manager_scope_granted === true),
    reasons: Array.from(new Set(relevant
      .map((account) => account?.connection_reason)
      .filter(Boolean)))
  };
}

function normalizeConsentDomain(value) {
  return canonicalizeIntakeDomain(value);
}

function normalizeConsentDomains(values) {
  let source = values;
  if (typeof source === 'string') {
    try { source = JSON.parse(source); } catch (_error) { source = [source]; }
  }
  return canonicalizeIntakeDomains(Array.isArray(source) ? source : []);
}

function assessConsentMeasurementReadiness(marketingState) {
  const scope = marketingState?.scope || {};
  const record = scope.assignment_scope === 'group'
    ? marketingState?.records?.groupRecord
    : (marketingState?.records?.clinicRecord || marketingState?.records?.groupRecord);
  const config = record?.config && typeof record.config === 'object' && !Array.isArray(record.config)
    ? record.config
    : {};
  const features = config.features && typeof config.features === 'object' && !Array.isArray(config.features)
    ? config.features
    : {};
  const texts = config.texts && typeof config.texts === 'object' && !Array.isArray(config.texts)
    ? config.texts
    : {};
  const verification = config.snippet_verification
    && typeof config.snippet_verification === 'object'
    && !Array.isArray(config.snippet_verification)
    ? config.snippet_verification
    : {};
  const domains = normalizeConsentDomains(record?.domains);
  const provider = String(features.consent_provider || '').trim().toLowerCase();
  const externalCmpProvider = String(features.external_cmp_provider || '').trim().toLowerCase();
  const recordScopeType = String(record?.assignment_scope || '').trim().toLowerCase() === 'group'
    || (!record?.clinic_id && record?.group_id)
    ? 'group'
    : 'clinic';
  const recordScopeId = recordScopeType === 'group'
    ? parseInteger(record?.group_id)
    : parseInteger(record?.clinic_id);
  const configHash = buildVerificationConfigHash({
    scopeType: recordScopeType,
    scopeId: recordScopeId,
    domains: record?.domains,
    config,
    hmacKey: record?.hmac_key,
  });
  const issues = [];
  const renewalIssues = [];
  const add = (reason, extra = {}) => issues.push({ reason, ...extra });

  if (features.consent_mode_enabled !== true) add('consent_mode_disabled');
  if (!['clinicaclick', 'external_cmp'].includes(provider)) add('consent_provider_missing');
  if (provider === 'external_cmp' && !externalCmpProvider) add('external_cmp_provider_missing');
  if (!domains.length) add('consent_domains_missing');
  const missingLegal = [
    ['legal', texts.legal_url || texts.terms_url],
    ['cookies', texts.cookies_url],
    ['privacy', texts.privacy_url]
  ].filter(([, value]) => !String(value || '').trim()).map(([key]) => key);
  if (missingLegal.length) add('consent_legal_urls_missing', { missing: missingLegal });
  const rawAttestations = verification.attestations_by_domain
    && typeof verification.attestations_by_domain === 'object'
    && !Array.isArray(verification.attestations_by_domain)
    ? verification.attestations_by_domain
    : {};
  const attestations = new Map();
  const validAttestationExpirations = [];
  for (const [rawDomain, token] of Object.entries(rawAttestations)) {
    const domain = normalizeConsentDomain(rawDomain);
    if (domain && !attestations.has(domain) && typeof token === 'string') {
      attestations.set(domain, token);
    }
  }

  for (const domain of domains) {
    const token = attestations.get(domain);
    if (!token) {
      add('consent_attestation_missing', { domain });
      continue;
    }
    const attestation = verifyPersistedVerificationAttestation(token, {
      scopeType: recordScopeType,
      scopeId: recordScopeId,
      domain,
      configHash,
    });
    if (!attestation.valid) {
      if (attestation.reason === 'attestation_operational_expired' && attestation.claims) {
        const renewalIssue = {
          reason: 'consent_attestation_renewal_required',
          domain,
          details: attestation.reason
        };
        issues.push(renewalIssue);
        renewalIssues.push(renewalIssue);
      } else {
        add('consent_attestation_invalid', { domain, details: attestation.reason });
        continue;
      }
    }
    if (Number.isSafeInteger(Number(attestation.operationalExpiresAt))) {
      validAttestationExpirations.push(Number(attestation.operationalExpiresAt));
    }
    const signals = attestation.claims?.signals || {};
    if (signals.installed !== true) add('consent_domain_unverified', { domain });
    if (signals.runtime_compatible !== true) add('consent_runtime_incompatible', { domain });
    if (signals.consent_mode_detected !== true) add('consent_signal_unverified', { domain });
    if (signals.google_consent_mode_detected !== true) add('google_consent_mode_unverified', { domain });
    if (provider === 'external_cmp' && (
      signals.cookie_notice_detected !== true
        || !cookieNoticeProviderMatches(signals.cookie_notice_provider, externalCmpProvider)
    )) {
      add('external_cmp_unverified', {
        domain,
        expected_provider: externalCmpProvider || null,
        detected_provider: signals.cookie_notice_provider || null,
        details: signals.cookie_notice_detected === true
          ? 'external_cmp_provider_mismatch'
          : 'external_cmp_not_detected',
      });
    }
    const pages = signals.legal_pages && typeof signals.legal_pages === 'object' ? signals.legal_pages : {};
    const invalidPages = ['legal', 'cookies', 'privacy'].filter((key) => (
      pages[key]?.configured !== true || pages[key]?.reachable !== true
    ));
    if (invalidPages.length) add('consent_legal_urls_unverified', { domain, missing: invalidPages });
  }

  const reasons = listToUniqueArray(issues.map((issue) => issue.reason));
  const minimumExpiration = validAttestationExpirations
    .filter((value) => Number.isSafeInteger(value) && value > 0)
    .reduce((minimum, value) => minimum === null || value < minimum ? value : minimum, null);
  const renewalIssueSet = new Set(renewalIssues);
  const blockingIssues = issues.filter((issue) => !renewalIssueSet.has(issue));
  return {
    ready: issues.length === 0,
    validated: issues.length === 0,
    reason: reasons[0] || null,
    reasons,
    issues,
    provider: ['clinicaclick', 'external_cmp'].includes(provider) ? provider : null,
    domains,
    expires_at: minimumExpiration ? new Date(minimumExpiration * 1000).toISOString() : null,
    verification_current: renewalIssues.length === 0 && issues.length === 0,
    renewal_required: renewalIssues.length > 0,
    renewal_issues: renewalIssues,
    // A stale observation never grants consent. It only means that the signed,
    // scope-bound configuration is still internally coherent while a new
    // public verification is required. The uploader must continue requiring
    // the visitor's live Consent Mode signal for every conversion.
    runtime_configuration_ready: blockingIssues.length === 0,
  };
}

function resolveWebMeasurementMarketingState(scope, marketingState) {
  const requestedScope = scope || marketingState?.scope || {};
  const records = marketingState?.records || {};
  const clinicRecord = records.clinicRecord || null;
  const groupRecord = records.groupRecord || null;

  if (requestedScope.assignment_scope === 'group') {
    return {
      source: 'group',
      assignment_scope: 'group',
      clinic_id: null,
      group_id: parseInteger(requestedScope.group_id || groupRecord?.group_id),
      record: groupRecord,
      marketingState: {
        ...marketingState,
        scope: {
          ...(marketingState?.scope || {}),
          assignment_scope: 'group',
          clinic_id: null,
          group_id: parseInteger(requestedScope.group_id || groupRecord?.group_id)
        },
        records: { clinicRecord: null, groupRecord }
      }
    };
  }

  const clinicId = parseInteger(requestedScope.clinic_id);
  const groupConfig = readIntakeRecordConfig(groupRecord);
  const groupLocationIds = new Set((Array.isArray(groupConfig.locations) ? groupConfig.locations : [])
    .map((location) => parseInteger(location?.id || location?.clinic_id))
    .filter(Boolean));
  const usesGroupWebMeasurement = Boolean(groupRecord && clinicId && groupLocationIds.has(clinicId));
  const record = usesGroupWebMeasurement ? groupRecord : (clinicRecord || groupRecord);
  const assignmentScope = usesGroupWebMeasurement || (!clinicRecord && groupRecord) ? 'group' : 'clinic';
  const groupId = parseInteger(requestedScope.group_id || groupRecord?.group_id);

  return {
    source: usesGroupWebMeasurement
      ? 'group_web_location'
      : (assignmentScope === 'group' ? 'group_fallback' : 'clinic'),
    assignment_scope: assignmentScope,
    clinic_id: clinicId,
    group_id: groupId,
    record,
    marketingState: {
      ...marketingState,
      scope: {
        ...(marketingState?.scope || {}),
        assignment_scope: assignmentScope,
        clinic_id: assignmentScope === 'clinic' ? clinicId : null,
        group_id: groupId
      },
      records: assignmentScope === 'group'
        ? { clinicRecord: null, groupRecord: record }
        : { clinicRecord: record, groupRecord: null }
    }
  };
}

function asPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function cloneJsonObject(value) {
  return JSON.parse(JSON.stringify(asPlainObject(value)));
}

function enhancedConversionActivationReconciliationKey({ targets, advertiserAuthorization }) {
  const canonical = {
    gate_version: ENHANCED_CONVERSION_ACTIVATION_GATE_VERSION,
    group_id: ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID,
    customer_ids: [...(targets?.customer_ids || [])].sort(),
    event_names: [...(targets?.event_names || [])].sort(),
    pairs: [...(targets?.pairs || [])]
      .map((pair) => `${pair.customer_id}:${pair.event_name}`)
      .sort(),
    google_evidence_ref: ENHANCED_CONVERSION_GOOGLE_EVIDENCE_REF,
    advertiser_authorization_ref: advertiserAuthorization?.reference || null,
    advertiser_authorized_at: advertiserAuthorization?.authorized_at || null,
    ad_personalization_source: 'visitor_consent',
    phone_country_code: ENHANCED_CONVERSION_PROPDENTAL_PHONE_COUNTRY_CODE,
    value_policy_version: ENHANCED_CONVERSION_VALUE_POLICY_VERSION
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function internalAdvertiserAuthorizationRequest() {
  return {
    advertiser_authorization: {
      confirmed: true,
      reference: ENHANCED_CONVERSION_ADVERTISER_AUTHORIZATION_REF,
      authorized_at: ENHANCED_CONVERSION_ADVERTISER_AUTHORIZED_AT
    }
  };
}

function adPersonalizationCapabilityReconciliationKey() {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: AD_PERSONALIZATION_CAPABILITY_VERSION,
    enabled: true,
    consent_source: 'visitor_choice',
    grants_consent: false
  })).digest('hex');
}

function legacyPropdentalPersonalizationCapabilityReconciliationKey() {
  return crypto.createHash('sha256').update(JSON.stringify({
    version: 1,
    group_id: ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID,
    enabled: true,
    consent_source: 'visitor_choice'
  })).digest('hex');
}

function visitorChoicePersonalizationScope(intakeRecord) {
  const record = asPlainObject(intakeRecord);
  const intakeConfigId = parseInteger(record.id);
  const clinicId = parseInteger(record.clinic_id);
  const groupId = parseInteger(record.group_id);
  const assignmentScope = String(record.assignment_scope || '').trim().toLowerCase() === 'group'
    ? 'group'
    : 'clinic';
  return {
    intake_config_id: intakeConfigId,
    assignment_scope: assignmentScope,
    clinic_id: clinicId,
    group_id: groupId,
  };
}

function visitorChoicePersonalizationWhere(intakeRecord) {
  const scope = visitorChoicePersonalizationScope(intakeRecord);
  if (scope.intake_config_id) return { id: scope.intake_config_id };
  if (scope.assignment_scope === 'group' && scope.group_id) {
    return { group_id: scope.group_id, assignment_scope: 'group' };
  }
  if (scope.clinic_id) return { clinic_id: scope.clinic_id, assignment_scope: 'clinic' };
  return null;
}

function buildVisitorChoicePersonalizationConfig(currentConfig, {
  intakeRecord = null,
  now = new Date(),
  activationSource = 'google_data_manager_diagnostics_job'
} = {}) {
  const nextConfig = cloneJsonObject(currentConfig);
  const reconciliationKey = adPersonalizationCapabilityReconciliationKey();
  const scope = visitorChoicePersonalizationScope(intakeRecord);
  nextConfig.features = {
    ...asPlainObject(nextConfig.features),
    ad_personalization_enabled: true,
    ad_personalization_consent_source: 'visitor_choice',
    ad_personalization_activation_audit: {
      version: AD_PERSONALIZATION_CAPABILITY_VERSION,
      reconciliation_key: reconciliationKey,
      activation_source: activationSource,
      applied_at: now.toISOString(),
      ...scope,
      grants_consent: false,
      independent_of_enhanced_conversion_gate: true
    }
  };
  return { nextConfig, reconciliationKey };
}

function isVisitorChoicePersonalizationCapabilityApplied(config, intakeRecord = null) {
  const features = asPlainObject(asPlainObject(config).features);
  const audit = asPlainObject(features.ad_personalization_activation_audit);
  const commonStateApplied = Boolean(
    features.ad_personalization_enabled === true
    && features.ad_personalization_consent_source === 'visitor_choice'
    && audit.grants_consent === false
    && audit.independent_of_enhanced_conversion_gate === true
  );
  const currentCapabilityApplied = commonStateApplied
    && audit.version === AD_PERSONALIZATION_CAPABILITY_VERSION
    && audit.reconciliation_key === adPersonalizationCapabilityReconciliationKey();
  const legacyPropdentalCapabilityApplied = commonStateApplied
    && audit.version === 1
    && Number(audit.group_id) === ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID
    && audit.reconciliation_key === legacyPropdentalPersonalizationCapabilityReconciliationKey();
  if (!currentCapabilityApplied && !legacyPropdentalCapabilityApplied) return false;
  if (!intakeRecord) return true;

  const scope = visitorChoicePersonalizationScope(intakeRecord);
  if (legacyPropdentalCapabilityApplied) {
    return scope.assignment_scope === 'group'
      && scope.group_id === ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID;
  }
  return Boolean(
    (!scope.intake_config_id || Number(audit.intake_config_id) === scope.intake_config_id)
    && audit.assignment_scope === scope.assignment_scope
    && parseInteger(audit.clinic_id) === scope.clinic_id
    && parseInteger(audit.group_id) === scope.group_id
  );
}

async function persistVisitorChoicePersonalizationCapability({
  intakeRecord,
  now = new Date(),
  activationSource = 'google_data_manager_diagnostics_job',
  dependencies = {},
  forceLockedRead = false,
}) {
  if (!intakeRecord) {
    return { status: 'blocked', updated: false, idempotent: false, reason: 'intake_config_missing' };
  }
  const reconciliationKey = adPersonalizationCapabilityReconciliationKey();
  const where = visitorChoicePersonalizationWhere(intakeRecord);
  if (!where) {
    return { status: 'blocked', updated: false, idempotent: false, reason: 'intake_config_scope_invalid' };
  }
  if (!forceLockedRead && isVisitorChoicePersonalizationCapabilityApplied(intakeRecord.config, intakeRecord)) {
    return {
      status: 'already_active',
      updated: false,
      idempotent: true,
      reconciliation_key: reconciliationKey
    };
  }

  const sequelize = dependencies.sequelize || db.sequelize;
  const intakeConfigModel = dependencies.IntakeConfig || IntakeConfig;
  return sequelize.transaction(async (transaction) => {
    const locked = await intakeConfigModel.findOne({
      where,
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!locked) {
      return { status: 'blocked', updated: false, idempotent: false, reason: 'intake_config_missing' };
    }
    if (isVisitorChoicePersonalizationCapabilityApplied(locked.config, locked)) {
      return {
        status: 'already_active',
        updated: false,
        idempotent: true,
        reconciliation_key: reconciliationKey
      };
    }
    const built = buildVisitorChoicePersonalizationConfig(locked.config, {
      intakeRecord: locked,
      now,
      activationSource,
    });
    await locked.update({ config: built.nextConfig }, { transaction });
    return {
      status: 'activated',
      updated: true,
      idempotent: false,
      reconciliation_key: reconciliationKey,
      config: built.nextConfig
    };
  });
}

async function reconcileVisitorChoicePersonalizationCapabilities(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const dependencies = options.dependencies || {};
  const intakeConfigModel = dependencies.IntakeConfig || IntakeConfig;
  const requestedBatchSize = Number.parseInt(String(options.batchSize || ''), 10);
  const batchSize = Number.isInteger(requestedBatchSize) && requestedBatchSize > 0
    ? Math.min(requestedBatchSize, 1000)
    : 100;
  const report = {
    status: 'completed',
    scanned: 0,
    activated: 0,
    already_active: 0,
    missing: 0,
    errors: [],
    idempotent: true,
    grants_consent: false,
    external_mutation_performed: false,
    google_ads_mutated: false,
  };

  let lastId = 0;
  while (true) {
    const rows = await intakeConfigModel.findAll({
      where: lastId > 0 ? { id: { [Op.gt]: lastId } } : {},
      attributes: ['id', 'clinic_id', 'group_id', 'assignment_scope'],
      order: [['id', 'ASC']],
      limit: batchSize,
      raw: true,
    });
    if (!rows.length) break;

    for (const intakeRecord of rows) {
      report.scanned += 1;
      try {
        const result = await persistVisitorChoicePersonalizationCapability({
          intakeRecord,
          now,
          activationSource: 'google_data_manager_diagnostics_job',
          dependencies,
          // The periodic reconciler always verifies the latest row under lock;
          // its initial findAll is only an identity scan, never a config snapshot.
          forceLockedRead: true,
        });
        if (result.status === 'activated') {
          report.activated += 1;
          report.idempotent = false;
        } else if (result.status === 'already_active') {
          report.already_active += 1;
        } else if (result.reason === 'intake_config_missing') {
          report.missing += 1;
        } else {
          report.errors.push({
            intake_config_id: parseInteger(intakeRecord.id),
            reason: result.reason || result.status || 'personalization_reconciliation_blocked',
          });
        }
      } catch (error) {
        report.errors.push({
          intake_config_id: parseInteger(intakeRecord.id),
          reason: error.code || 'personalization_reconciliation_error',
        });
      }
    }

    const pageLastId = rows.reduce((maximum, row) => (
      Math.max(maximum, parseInteger(row.id) || 0)
    ), lastId);
    if (pageLastId <= lastId) {
      report.errors.push({
        intake_config_id: null,
        reason: 'personalization_reconciliation_pagination_stalled',
      });
      break;
    }
    lastId = pageLastId;
  }

  if (report.errors.length > 0) report.status = 'completed_with_errors';
  return report;
}

function collectEnhancedConversionActivationTargets(rawGoogleAdsConfig) {
  const googleAds = asPlainObject(rawGoogleAdsConfig);
  const events = asPlainObject(googleAds.events);
  const pairs = [];
  const issues = [];

  for (const eventName of GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_EVENTS) {
    const eventConfig = events[eventName];
    if (!eventConfig || typeof eventConfig !== 'object' || Array.isArray(eventConfig)) continue;
    const rawDestinations = Object.prototype.hasOwnProperty.call(eventConfig, 'destinations')
      ? (Array.isArray(eventConfig.destinations) ? eventConfig.destinations : [])
      : [eventConfig];
    if (rawDestinations.length === 0) {
      issues.push({ reason: 'enhanced_conversion_destination_missing', event: eventName });
      continue;
    }
    for (const destination of rawDestinations) {
      if (!destination || typeof destination !== 'object' || Array.isArray(destination)) continue;
      const customerId = normalizeCustomerId(
        destination.customer_id
          || destination.customerId
          || eventConfig.customer_id
          || eventConfig.customerId
          || googleAds.customer_id
          || googleAds.customerId
          || ''
      );
      if (!customerId) {
        issues.push({ reason: 'enhanced_conversion_destination_customer_missing', event: eventName });
        continue;
      }
      pairs.push({ customer_id: customerId, event_name: eventName });
    }
  }

  const dedupedPairs = [];
  const seen = new Set();
  for (const pair of pairs) {
    const key = `${pair.customer_id}:${pair.event_name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dedupedPairs.push(pair);
  }
  return {
    pairs: dedupedPairs,
    customer_ids: listToUniqueArray(dedupedPairs.map((pair) => pair.customer_id)),
    event_names: listToUniqueArray(dedupedPairs.map((pair) => pair.event_name)),
    issues
  };
}

function readAdvertiserEnhancedConversionAuthorization(input) {
  const body = asPlainObject(input);
  const nested = asPlainObject(body.advertiser_authorization);
  return {
    confirmed: nested.confirmed === true || body.advertiser_authorization_confirmed === true,
    reference: String(
      nested.reference
        || nested.ref
        || body.advertiser_authorization_ref
        || ''
    ).trim() || null,
    authorized_at: String(
      nested.authorized_at
        || nested.authorizedAt
        || body.advertiser_authorized_at
        || ''
    ).trim() || null
  };
}

function buildEnhancedConversionAuthorization({ customerId, eventName, advertiserAuthorization }) {
  return {
    policyMode: GOOGLE_ENHANCED_CONVERSION_POLICY_MODE,
    customerId,
    eventName,
    googleEvidenceRef: ENHANCED_CONVERSION_GOOGLE_EVIDENCE_REF,
    advertiserAuthorizationRef: advertiserAuthorization.reference,
    googleGuidanceAt: ENHANCED_CONVERSION_GOOGLE_GUIDANCE_AT,
    advertiserAuthorizedAt: advertiserAuthorization.authorized_at,
    expiresAt: null,
    permittedIdentifiers: [...GOOGLE_ENHANCED_CONVERSION_ALLOWED_IDENTIFIERS],
    policyAmbiguityAcknowledged: true,
    formalPolicyExceptionClaimed: false,
    measurementOnly: true,
    customerMatchEnabled: false,
    conversionBasedCustomerListsEnabled: false,
    remarketingEnabled: false,
    // ad_personalization is a per-visitor Consent Mode v2 signal. It is never
    // fixed by the account authorization or by this internal activation gate.
    adPersonalizationSource: 'visitor_consent'
  };
}

function serializeEnhancedConversionAuthorization(authorization) {
  return {
    google_evidence_ref: authorization.googleEvidenceRef,
    advertiser_authorization_ref: authorization.advertiserAuthorizationRef,
    google_guidance_at: authorization.googleGuidanceAt,
    advertiser_authorized_at: authorization.advertiserAuthorizedAt,
    permitted_identifiers: authorization.permittedIdentifiers,
    policy_ambiguity_acknowledged: authorization.policyAmbiguityAcknowledged,
    formal_policy_exception_claimed: authorization.formalPolicyExceptionClaimed,
    measurement_only: authorization.measurementOnly,
    customer_match_enabled: authorization.customerMatchEnabled,
    conversion_based_customer_lists_enabled: authorization.conversionBasedCustomerListsEnabled,
    remarketing_enabled: authorization.remarketingEnabled,
    ad_personalization_source: authorization.adPersonalizationSource
  };
}

function validateEnhancedConversionActivationAllowlist(enhancedConfig, now = new Date()) {
  const config = asPlainObject(enhancedConfig);
  const allowlist = Array.isArray(config.allowlist) ? config.allowlist : [];
  const issues = [];
  for (const entry of allowlist) {
    const customerId = normalizeCustomerId(entry?.customer_id || '');
    const eventName = String(entry?.event_name || '').trim().toLowerCase();
    const raw = asPlainObject(entry?.authorization);
    const authorization = {
      policyMode: config.policy_mode,
      customerId,
      eventName,
      googleEvidenceRef: raw.google_evidence_ref,
      advertiserAuthorizationRef: raw.advertiser_authorization_ref,
      googleGuidanceAt: raw.google_guidance_at,
      advertiserAuthorizedAt: raw.advertiser_authorized_at,
      expiresAt: raw.expires_at || null,
      permittedIdentifiers: raw.permitted_identifiers,
      policyAmbiguityAcknowledged: raw.policy_ambiguity_acknowledged,
      formalPolicyExceptionClaimed: raw.formal_policy_exception_claimed,
      measurementOnly: raw.measurement_only,
      customerMatchEnabled: raw.customer_match_enabled,
      conversionBasedCustomerListsEnabled: raw.conversion_based_customer_lists_enabled,
      remarketingEnabled: raw.remarketing_enabled,
      adPersonalizationSource: raw.ad_personalization_source
    };
    const validation = validateEnhancedConversionAuthorization({
      authorization,
      customerId,
      eventName,
      consentStatus: 'GRANTED',
      adPersonalizationStatus: 'GRANTED',
      now
    });
    if (!validation.valid) {
      issues.push({
        reason: 'enhanced_conversion_authorization_invalid',
        customer_id: customerId || null,
        event: eventName || null,
        details: validation.reason
      });
    }
  }
  if (allowlist.length === 0) issues.push({ reason: 'enhanced_conversion_allowlist_empty' });
  return issues;
}

function buildEnhancedConversionActivationPlan({
  scope,
  intakeRecord,
  consentReadiness,
  scopedAccounts,
  enrichedAccounts,
  dataManagerReady,
  requestBody,
  actorUserId,
  activationSource = 'manual_gate',
  now = new Date()
}) {
  const issues = [];
  const add = (reason, extra = {}) => issues.push({ reason, ...extra });
  if (scope?.assignment_scope !== 'group' || Number(scope?.group_id) !== ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID) {
    add('enhanced_conversion_scope_not_allowlisted');
  }
  if (!intakeRecord) add('intake_config_missing');
  if (dataManagerReady !== true) add('google_data_manager_not_ready');
  if (!consentReadiness?.ready || !consentReadiness?.validated) {
    add('consent_readiness_pending', { reasons: consentReadiness?.reasons || [] });
  }

  const currentConfig = asPlainObject(intakeRecord?.config);
  const features = asPlainObject(currentConfig.features);
  if (String(features.consent_provider || '').trim().toLowerCase() !== 'clinicaclick') {
    add('clinicaclick_consent_provider_required');
  }
  const googleAds = asPlainObject(currentConfig.google_ads);
  const targets = collectEnhancedConversionActivationTargets(googleAds);
  issues.push(...targets.issues);
  if (targets.pairs.length === 0) add('enhanced_conversion_events_missing');

  const mappedByCustomer = new Map((Array.isArray(scopedAccounts) ? scopedAccounts : [])
    .filter((account) => account?.mapped_to_scope === true)
    .map((account) => [normalizeCustomerId(account?.customer_id || ''), account]));
  const settingsByCustomer = new Map((Array.isArray(enrichedAccounts) ? enrichedAccounts : [])
    .map((account) => [normalizeCustomerId(account?.customer_id || ''), account]));
  for (const customerId of targets.customer_ids) {
    if (!GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_CUSTOMER_IDS.includes(customerId)) {
      add('enhanced_conversion_customer_not_allowlisted', { customer_id: customerId });
      continue;
    }
    if (!mappedByCustomer.has(customerId)) {
      add('enhanced_conversion_customer_not_mapped', { customer_id: customerId });
      continue;
    }
    const settings = settingsByCustomer.get(customerId);
    if (!settings || settings.conversion_tracking_settings_available !== true) {
      add('enhanced_conversion_account_settings_unavailable', { customer_id: customerId });
      continue;
    }
    if (settings.accepted_customer_data_terms !== true) {
      add('enhanced_conversion_customer_data_terms_not_accepted', { customer_id: customerId });
    }
    if (settings.enhanced_conversions_for_leads_enabled !== true) {
      add('enhanced_conversions_for_leads_not_enabled', { customer_id: customerId });
    }
  }

  const advertiserAuthorization = readAdvertiserEnhancedConversionAuthorization(requestBody);
  if (advertiserAuthorization.confirmed !== true) add('advertiser_authorization_confirmation_required');
  if (!advertiserAuthorization.reference) add('advertiser_authorization_ref_required');
  if (!advertiserAuthorization.authorized_at) add('advertiser_authorized_at_required');

  const allowlist = targets.pairs.map((pair) => {
    const authorization = buildEnhancedConversionAuthorization({
      customerId: pair.customer_id,
      eventName: pair.event_name,
      advertiserAuthorization
    });
    const validation = validateEnhancedConversionAuthorization({
      authorization,
      customerId: pair.customer_id,
      eventName: pair.event_name,
      consentStatus: 'GRANTED',
      adPersonalizationStatus: 'GRANTED',
      now
    });
    if (!validation.valid) {
      add('enhanced_conversion_authorization_invalid', {
        customer_id: pair.customer_id,
        event: pair.event_name,
        details: validation.reason
      });
    }
    return {
      enabled: true,
      customer_id: pair.customer_id,
      event_name: pair.event_name,
      authorization: serializeEnhancedConversionAuthorization(authorization)
    };
  });

  const reconciliationKey = enhancedConversionActivationReconciliationKey({
    targets,
    advertiserAuthorization
  });

  const appliedAt = now.toISOString();
  const nextConfig = cloneJsonObject(currentConfig);
  const personalizationCapability = buildVisitorChoicePersonalizationConfig(nextConfig, {
    intakeRecord,
    now,
    activationSource
  });
  nextConfig.features = {
    ...asPlainObject(personalizationCapability.nextConfig.features),
    // This flag allows the runtime to reflect the visitor's choice. It does
    // not grant consent by itself; rejected marketing remains DENIED.
    ad_personalization_enabled: true,
    ad_personalization_consent_source: 'visitor_choice',
    google_ads_user_data_enabled: true,
    google_ads_user_data_disclosure_confirmed: true,
    google_ads_user_data_runtime_enabled: true
  };
  const nextGoogleAds = {
    ...asPlainObject(nextConfig.google_ads),
    user_data_enabled: true,
    phone_country_code: ENHANCED_CONVERSION_PROPDENTAL_PHONE_COUNTRY_CODE
  };
  const nextEvents = { ...asPlainObject(nextGoogleAds.events) };
  for (const eventName of targets.event_names) {
    const reportingValue = ENHANCED_CONVERSION_REPORTING_VALUES_EUR[eventName];
    nextEvents[eventName] = {
      ...asPlainObject(nextEvents[eventName]),
      user_data_enabled: true,
      ...(Number.isFinite(reportingValue) ? {
        value: reportingValue,
        currency: 'EUR',
        value_kind: 'campaign_optimization_reporting',
        value_is_revenue: false
      } : {})
    };
  }
  nextGoogleAds.events = nextEvents;
  nextGoogleAds.enhanced_conversions = {
    enabled: true,
    policy_mode: GOOGLE_ENHANCED_CONVERSION_POLICY_MODE,
    allowlist,
    activation_audit: {
      gate_version: ENHANCED_CONVERSION_ACTIVATION_GATE_VERSION,
      reconciliation_key: reconciliationKey,
      activation_source: activationSource,
      applied_at: appliedAt,
      actor_user_id: actorUserId || null,
      group_id: ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID,
      customer_ids: targets.customer_ids,
      event_names: targets.event_names,
      google_evidence_ref: ENHANCED_CONVERSION_GOOGLE_EVIDENCE_REF,
      advertiser_authorization_ref: advertiserAuthorization.reference,
      consent_attestation_expires_at: consentReadiness?.expires_at || null,
      account_gate: {
        checked_at: appliedAt,
        all_enabled: targets.customer_ids.every((customerId) => {
          const settings = settingsByCustomer.get(customerId);
          return settings?.conversion_tracking_settings_available === true
            && settings?.accepted_customer_data_terms === true
            && settings?.enhanced_conversions_for_leads_enabled === true;
        }),
        accounts: targets.customer_ids.map((customerId) => {
          const settings = settingsByCustomer.get(customerId);
          return {
            customer_id: customerId,
            settings_available: settings?.conversion_tracking_settings_available === true,
            customer_data_terms_accepted: settings?.accepted_customer_data_terms === true,
            enhanced_conversions_for_leads_enabled:
              settings?.enhanced_conversions_for_leads_enabled === true
          };
        })
      },
      measurement_only: true,
      permitted_identifiers: [...GOOGLE_ENHANCED_CONVERSION_ALLOWED_IDENTIFIERS],
      phone_country_code: ENHANCED_CONVERSION_PROPDENTAL_PHONE_COUNTRY_CODE,
      ad_personalization_source: 'visitor_consent',
      customer_match_enabled: false,
      conversion_based_customer_lists_enabled: false,
      remarketing_enabled: false
    },
    value_policy: {
      version: ENHANCED_CONVERSION_VALUE_POLICY_VERSION,
      currency: 'EUR',
      purpose: 'campaign_optimization_reporting',
      revenue: false,
      events: {
        ...ENHANCED_CONVERSION_REPORTING_VALUES_EUR,
        purchase: 'actual_value_only'
      }
    }
  };
  nextConfig.google_ads = nextGoogleAds;

  return {
    ready: issues.length === 0,
    issues,
    targets,
    advertiserAuthorization,
    nextConfig,
    summary: {
      gate_version: ENHANCED_CONVERSION_ACTIVATION_GATE_VERSION,
      reconciliation_key: reconciliationKey,
      activation_source: activationSource,
      group_id: ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID,
      customer_ids: targets.customer_ids,
      event_names: targets.event_names,
      google_evidence_ref: ENHANCED_CONVERSION_GOOGLE_EVIDENCE_REF,
      advertiser_authorization_ref: advertiserAuthorization.reference,
      measurement_only: true,
      permitted_identifiers: [...GOOGLE_ENHANCED_CONVERSION_ALLOWED_IDENTIFIERS],
      phone_country_code: ENHANCED_CONVERSION_PROPDENTAL_PHONE_COUNTRY_CODE,
      ad_personalization_source: 'visitor_consent',
      customer_match_enabled: false,
      conversion_based_customer_lists_enabled: false,
      remarketing_enabled: false,
      value_policy: nextGoogleAds.enhanced_conversions.value_policy
    }
  };
}

function isEnhancedConversionActivationApplied(config, reconciliationKey) {
  const safeConfig = asPlainObject(config);
  const features = asPlainObject(safeConfig.features);
  const googleAds = asPlainObject(safeConfig.google_ads);
  const enhanced = asPlainObject(googleAds.enhanced_conversions);
  const audit = asPlainObject(enhanced.activation_audit);
  const valuePolicy = asPlainObject(enhanced.value_policy);
  const events = asPlainObject(googleAds.events);
  const targetEvents = Array.isArray(audit.event_names) ? audit.event_names : [];
  const eventsStillMaterialized = targetEvents.length > 0 && targetEvents.every((eventName) => {
    const eventConfig = asPlainObject(events[eventName]);
    const expectedValue = ENHANCED_CONVERSION_REPORTING_VALUES_EUR[eventName];
    return eventConfig.user_data_enabled === true
      && (!Number.isFinite(expectedValue) || (
        Number(eventConfig.value) === expectedValue
        && String(eventConfig.currency || '').toUpperCase() === 'EUR'
        && eventConfig.value_kind === 'campaign_optimization_reporting'
        && eventConfig.value_is_revenue === false
      ));
  });
  return Boolean(
    reconciliationKey
    && enhanced.enabled === true
    && googleAds.user_data_enabled === true
    && String(googleAds.phone_country_code || '') === ENHANCED_CONVERSION_PROPDENTAL_PHONE_COUNTRY_CODE
    && features.ad_personalization_enabled === true
    && features.google_ads_user_data_enabled === true
    && features.google_ads_user_data_disclosure_confirmed === true
    && features.google_ads_user_data_runtime_enabled === true
    && features.ad_personalization_consent_source === 'visitor_choice'
    && isVisitorChoicePersonalizationCapabilityApplied(safeConfig)
    && valuePolicy.version === ENHANCED_CONVERSION_VALUE_POLICY_VERSION
    && valuePolicy.purpose === 'campaign_optimization_reporting'
    && valuePolicy.revenue === false
    && audit.gate_version === ENHANCED_CONVERSION_ACTIVATION_GATE_VERSION
    && audit.account_gate?.all_enabled === true
    && audit.reconciliation_key === reconciliationKey
    && eventsStillMaterialized
    && validateEnhancedConversionActivationAllowlist(enhanced).length === 0
  );
}

async function persistEnhancedConversionActivationPlan({
  intakeRecord,
  plan,
  now = new Date(),
  dependencies = {}
}) {
  if (!plan?.ready) {
    return { status: 'blocked', updated: false, idempotent: false, issues: plan?.issues || [] };
  }
  const reconciliationKey = plan.summary?.reconciliation_key || null;
  if (isEnhancedConversionActivationApplied(intakeRecord?.config, reconciliationKey)) {
    return { status: 'already_active', updated: false, idempotent: true, reconciliation_key: reconciliationKey };
  }

  const sequelize = dependencies.sequelize || db.sequelize;
  const intakeConfigModel = dependencies.IntakeConfig || IntakeConfig;
  const preflightUpdatedAt = intakeRecord?.updated_at || intakeRecord?.updatedAt || null;
  return sequelize.transaction(async (transaction) => {
    const locked = await intakeConfigModel.findOne({
      where: {
        group_id: ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID,
        assignment_scope: 'group'
      },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!locked) {
      return { status: 'blocked', updated: false, idempotent: false, issues: [{ reason: 'intake_config_missing' }] };
    }
    if (isEnhancedConversionActivationApplied(locked.config, reconciliationKey)) {
      return { status: 'already_active', updated: false, idempotent: true, reconciliation_key: reconciliationKey };
    }
    const lockedUpdatedAt = locked.updated_at || locked.updatedAt || null;
    if (
      preflightUpdatedAt
      && lockedUpdatedAt
      && new Date(preflightUpdatedAt).getTime() !== new Date(lockedUpdatedAt).getTime()
    ) {
      return {
        status: 'stale_retry',
        updated: false,
        idempotent: false,
        issues: [{ reason: 'intake_config_changed_during_reconciliation' }]
      };
    }
    const authorizationIssues = validateEnhancedConversionActivationAllowlist(
      plan.nextConfig.google_ads?.enhanced_conversions,
      now
    );
    if (authorizationIssues.length) {
      return { status: 'blocked', updated: false, idempotent: false, issues: authorizationIssues };
    }
    await locked.update({ config: plan.nextConfig }, { transaction });
    return {
      status: 'activated',
      updated: true,
      idempotent: false,
      reconciliation_key: reconciliationKey
    };
  });
}

async function reconcileEnhancedConversionsInternalActivation(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const dependencies = options.dependencies || {};
  const resolveScope = dependencies.resolveScopeFromInput || resolveScopeFromInput;
  const resolveMarketingState = dependencies.resolveEffectiveMarketingState || resolveEffectiveMarketingState;
  const enrichAccounts = dependencies.enrichGoogleAdsAccountsWithConversionTracking
    || enrichGoogleAdsAccountsWithConversionTracking;
  const assessConsent = dependencies.assessConsentMeasurementReadiness || assessConsentMeasurementReadiness;

  const scope = await resolveScope({
    clinicIdRaw: null,
    groupIdRaw: ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID,
    assignmentScopeRaw: 'group'
  });
  const marketingState = await resolveMarketingState({
    clinicIdRaw: null,
    groupIdRaw: ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID,
    assignmentScopeRaw: 'group'
  });
  const intakeRecord = marketingState.records?.groupRecord || null;
  const consentReadiness = assessConsent(marketingState);
  const scopedAccounts = marketingState.google?.available_accounts || [];
  let enrichedAccounts = scopedAccounts.map((account) => ({
    ...account,
    conversion_tracking_settings_available: false
  }));
  let dataManagerReady = false;

  try {
    enrichedAccounts = await enrichAccounts({ userId: null, scope, accounts: scopedAccounts });
  } catch (_error) {
    // A transient per-mapping/provider failure keeps the Enhanced phase blocked.
    enrichedAccounts = scopedAccounts.map((account) => ({
      ...account,
      google_connection_healthy: false,
      google_ads_scope_granted: false,
      data_manager_scope_granted: false,
      conversion_tracking_settings_available: false,
      connection_reason: 'google_account_enrichment_failed'
    }));
  }
  const quotaProjectConfigured = Boolean(
    process.env.GOOGLE_DATA_MANAGER_QUOTA_PROJECT
      || process.env.GOOGLE_CLOUD_PROJECT
  );
  const activationTargets = collectEnhancedConversionActivationTargets(
    asPlainObject(intakeRecord?.config).google_ads
  );
  const activationAccess = summarizeGoogleMappedAccountAccess(
    enrichedAccounts,
    activationTargets.customer_ids
  );
  dataManagerReady = Boolean(
    quotaProjectConfigured
    && activationAccess.all_connected
    && activationAccess.has_ads_scope
    && activationAccess.has_data_manager_scope
  );

  const plan = buildEnhancedConversionActivationPlan({
    scope,
    intakeRecord,
    consentReadiness,
    scopedAccounts,
    enrichedAccounts,
    dataManagerReady,
    requestBody: internalAdvertiserAuthorizationRequest(),
    actorUserId: null,
    activationSource: 'google_data_manager_diagnostics_job',
    now
  });
  if (!plan.ready) {
    const nonRenewalIssues = plan.issues.filter((issue) => (
      issue?.reason !== 'consent_readiness_pending'
    ));
    const activationAlreadyApplied = isEnhancedConversionActivationApplied(
      intakeRecord?.config,
      plan.summary?.reconciliation_key || null
    );
    if (
      activationAlreadyApplied
      && consentReadiness?.renewal_required === true
      && consentReadiness?.runtime_configuration_ready === true
      && nonRenewalIssues.length === 0
    ) {
      return {
        status: 'already_active',
        updated: false,
        idempotent: true,
        ready: true,
        reconciliation_key: plan.summary.reconciliation_key,
        customer_ids: plan.targets.customer_ids,
        event_names: plan.targets.event_names,
        consent_verification: {
          current: false,
          renewal_required: true,
          expires_at: consentReadiness.expires_at || null,
          runtime_configuration_ready: true,
          // The persisted activation does not grant consent. Upload remains
          // gated by ad_user_data/ad_personalization from the current visitor.
          runtime_continues_with_per_event_visitor_consent: true
        },
        ad_personalization_capability: {
          status: 'already_active',
          updated: false,
          idempotent: true,
          enabled: true,
          consent_source: 'visitor_choice',
          grants_consent: false
        },
        external_mutation_performed: false,
        google_ads_mutated: false
      };
    }
    const capability = await persistVisitorChoicePersonalizationCapability({
      intakeRecord,
      now,
      activationSource: 'google_data_manager_diagnostics_job',
      dependencies
    });
    return {
      status: 'blocked',
      updated: capability.updated,
      idempotent: capability.idempotent,
      ready: false,
      issues: plan.issues,
      customer_ids: plan.targets.customer_ids,
      ad_personalization_capability: {
        ...capability,
        enabled: capability.status === 'activated'
          || capability.status === 'already_active',
        consent_source: 'visitor_choice',
        grants_consent: false
      },
      external_mutation_performed: false,
      google_ads_mutated: false
    };
  }
  const persisted = await persistEnhancedConversionActivationPlan({
    intakeRecord,
    plan,
    now,
    dependencies
  });
  return {
    ...persisted,
    ready: true,
    customer_ids: plan.targets.customer_ids,
    event_names: plan.targets.event_names,
    ad_personalization_capability: {
      status: persisted.status,
      updated: persisted.updated,
      idempotent: persisted.idempotent,
      enabled: persisted.status === 'activated' || persisted.status === 'already_active',
      consent_source: 'visitor_choice',
      grants_consent: false
    },
    consent_verification: {
      current: consentReadiness?.verification_current !== false,
      renewal_required: consentReadiness?.renewal_required === true,
      expires_at: consentReadiness?.expires_at || null,
      runtime_configuration_ready: consentReadiness?.runtime_configuration_ready !== false,
      runtime_continues_with_per_event_visitor_consent: true
    },
    external_mutation_performed: false,
    google_ads_mutated: false
  };
}

function resolveEnabledConversionEvents(rawGoogleAdsConfig) {
  const rawEvents = rawGoogleAdsConfig?.events && typeof rawGoogleAdsConfig.events === 'object'
    && !Array.isArray(rawGoogleAdsConfig.events)
    ? rawGoogleAdsConfig.events
    : {};
  return VALID_EVENTS.filter((eventKey) => {
    const eventConfig = rawEvents[eventKey];
    if (eventKey === 'purchase') return eventConfig?.enabled === true;
    if (!eventConfig || typeof eventConfig !== 'object' || Array.isArray(eventConfig)) {
      return DEFAULT_ENABLED_CONVERSION_EVENTS.includes(eventKey);
    }
    return eventConfig.enabled !== false;
  });
}

function conversionValidationKey(customerId, eventKey, actionId) {
  return [normalizeCustomerId(customerId) || 'missing', eventKey || 'missing', String(actionId || 'missing')].join(':');
}

function buildRequiredConversionPlan(rawGoogleAdsConfig, fallbackCustomerId = null) {
  const normalized = normalizeGoogleAdsConfig(rawGoogleAdsConfig || {});
  const enabledEvents = resolveEnabledConversionEvents(rawGoogleAdsConfig || {});
  const targets = [];
  const issues = [];

  for (const eventKey of enabledEvents) {
    const eventConfig = normalized.events[eventKey] || {};
    const hasExplicitDestinations = Object.prototype.hasOwnProperty.call(eventConfig, 'destinations');
    const eventTargets = hasExplicitDestinations
      ? (eventConfig.destinations || []).filter((destination) => destination?.enabled !== false)
      : [{
          key: `legacy_${eventKey}`,
          enabled: true,
          customer_id: eventConfig.customer_id || normalized.customer_id || normalizeCustomerId(fallbackCustomerId),
          conversion_action_id: eventConfig.conversion_action_id
            || (eventKey === 'lead' ? normalized.conversion_action_id : null),
          campaign_ids: eventConfig.campaign_ids || []
        }];

    if (!eventTargets.length) {
      issues.push({
        reason: 'conversion_destination_missing',
        event: eventKey
      });
      continue;
    }

    for (const destination of eventTargets) {
      const customerId = normalizeCustomerId(destination?.customer_id || '');
      const campaignIds = listToUniqueArray(
        (Array.isArray(destination?.campaign_ids) ? destination.campaign_ids : [])
          .map((value) => normalizeCustomerId(value))
          .filter(Boolean)
      );
      targets.push({
        event: eventKey,
        destination_key: String(destination?.key || `destination_${customerId || targets.length + 1}`),
        customer_id: customerId || null,
        configured_action_id: String(destination?.conversion_action_id || '').trim() || null,
        campaign_ids: campaignIds
      });
      if (!customerId) {
        issues.push({
          reason: 'conversion_destination_customer_missing',
          event: eventKey,
          destination_key: String(destination?.key || '') || null
        });
      }
    }

    const distinctCustomers = listToUniqueArray(
      eventTargets.map((destination) => normalizeCustomerId(destination?.customer_id || '')).filter(Boolean)
    );
    if (distinctCustomers.length > 1) {
      const campaignOwners = new Map();
      for (const destination of eventTargets) {
        const customerId = normalizeCustomerId(destination?.customer_id || '');
        const campaignIds = listToUniqueArray(
          (Array.isArray(destination?.campaign_ids) ? destination.campaign_ids : [])
            .map((value) => normalizeCustomerId(value))
            .filter(Boolean)
        );
        if (!customerId || !campaignIds.length) {
          issues.push({
            reason: 'attribution_selector_missing',
            event: eventKey,
            customer_id: customerId || null,
            destination_key: String(destination?.key || '') || null
          });
          continue;
        }
        for (const campaignId of campaignIds) {
          const previousOwner = campaignOwners.get(campaignId);
          if (previousOwner && previousOwner !== customerId) {
            issues.push({
              reason: 'attribution_selector_ambiguous',
              event: eventKey,
              campaign_id: campaignId,
              customer_ids: [previousOwner, customerId]
            });
          } else {
            campaignOwners.set(campaignId, customerId);
          }
        }
      }
    }
  }

  return {
    enabled_events: enabledEvents,
    customer_ids: listToUniqueArray(targets.map((target) => target.customer_id).filter(Boolean)),
    targets,
    issues
  };
}

function assessConversionOnboardingReadiness({
  plan,
  mappingsByCustomer = {},
  actionsByCustomer = {},
  capabilitiesByCustomer = {},
  validationsByTarget = {}
} = {}) {
  const normalizedPlan = plan || { enabled_events: [], customer_ids: [], targets: [], issues: [] };
  const issues = [...(Array.isArray(normalizedPlan.issues) ? normalizedPlan.issues : [])];
  const canonicalTargets = [];

  for (const customerId of normalizedPlan.customer_ids || []) {
    const capability = capabilitiesByCustomer[customerId] || {};
    if (capability.data_manager_scope_granted !== true) {
      issues.push({ reason: 'data_manager_scope_missing', customer_id: customerId });
    }
    if (capability.data_manager_quota_project_configured !== true) {
      issues.push({ reason: 'data_manager_quota_project_missing', customer_id: customerId });
    }
  }

  for (const target of normalizedPlan.targets || []) {
    if (!target.customer_id) continue;
    const mapping = mappingsByCustomer[target.customer_id] || {};
    const actionId = String(mapping[target.event] || '').trim() || null;
    if (!actionId) {
      issues.push({
        reason: 'canonical_conversion_action_missing',
        customer_id: target.customer_id,
        event: target.event,
        destination_key: target.destination_key
      });
      continue;
    }
    const configuredActionId = String(target.configured_action_id || '').trim() || null;
    if (configuredActionId && configuredActionId !== actionId) {
      issues.push({
        reason: 'conversion_destination_action_drift',
        customer_id: target.customer_id,
        event: target.event,
        destination_key: target.destination_key,
        configured_conversion_action_id: configuredActionId,
        canonical_conversion_action_id: actionId
      });
    }
    const action = (actionsByCustomer[target.customer_id] || [])
      .find((candidate) => String(candidate?.id || '') === actionId);
    const actionEnabled = !!action && String(action.status || '').toUpperCase() === 'ENABLED';
    const braidCompatible = !!action && String(action.counting_type || '').toUpperCase() === 'MANY_PER_CLICK';
    const secondaryForBidding = !!action && action.primary_for_goal === false;
    if (!actionEnabled) {
      issues.push({
        reason: 'canonical_conversion_action_not_enabled',
        customer_id: target.customer_id,
        event: target.event,
        conversion_action_id: actionId
      });
    }
    if (action && !braidCompatible) {
      issues.push({
        reason: 'braid_incompatible_counting_type',
        customer_id: target.customer_id,
        event: target.event,
        conversion_action_id: actionId,
        conversion_action_name: action.name || null,
        counting_type: action.counting_type || null,
        required_counting_type: 'MANY_PER_CLICK'
      });
    }
    if (action && !secondaryForBidding) {
      issues.push({
        reason: 'canonical_action_primary_for_goal',
        customer_id: target.customer_id,
        event: target.event,
        conversion_action_id: actionId,
        conversion_action_name: action.name || null,
        primary_for_goal: action.primary_for_goal
      });
    }
    const validationKey = conversionValidationKey(target.customer_id, target.event, actionId);
    const validation = validationsByTarget[validationKey];
    if (actionEnabled && braidCompatible && secondaryForBidding && validation?.validated !== true) {
      issues.push({
        reason: validation?.status === 'failed'
          ? 'data_manager_validation_failed'
          : 'data_manager_validation_pending',
        customer_id: target.customer_id,
        event: target.event,
        conversion_action_id: actionId,
        message: validation?.message || null
      });
    }
    canonicalTargets.push({
      ...target,
      conversion_action_id: actionId,
      validation_key: validationKey,
      validated: validation?.validated === true
    });
  }

  const uniqueReasons = listToUniqueArray(issues.map((issue) => issue.reason));
  return {
    ready: issues.length === 0,
    validated: issues.length === 0 && canonicalTargets.every((target) => target.validated),
    reason: uniqueReasons[0] || null,
    reasons: uniqueReasons,
    issues,
    enabled_events: normalizedPlan.enabled_events || [],
    customer_ids: normalizedPlan.customer_ids || [],
    targets: canonicalTargets
  };
}

function applyCanonicalMappingsToGoogleAdsConfig(rawGoogleAdsConfig, fallbackCustomerId, mappingsByCustomer) {
  const source = rawGoogleAdsConfig && typeof rawGoogleAdsConfig === 'object' && !Array.isArray(rawGoogleAdsConfig)
    ? rawGoogleAdsConfig
    : {};
  const next = JSON.parse(JSON.stringify(source));
  next.enabled = true;
  next.currency = normalizeCurrency(next.currency || 'EUR');
  next.customer_id = normalizeCustomerId(next.customer_id || fallbackCustomerId || '') || null;
  next.events = next.events && typeof next.events === 'object' && !Array.isArray(next.events)
    ? next.events
    : {};

  for (const eventKey of resolveEnabledConversionEvents(next)) {
    const eventConfig = next.events[eventKey] && typeof next.events[eventKey] === 'object'
      && !Array.isArray(next.events[eventKey])
      ? next.events[eventKey]
      : {};
    eventConfig.enabled = true;
    eventConfig.currency = normalizeCurrency(eventConfig.currency || next.currency);
    if (Object.prototype.hasOwnProperty.call(eventConfig, 'destinations')) {
      eventConfig.destinations = Array.isArray(eventConfig.destinations)
        ? eventConfig.destinations.map((destination) => {
            if (!destination || typeof destination !== 'object' || Array.isArray(destination)) return destination;
            const customerId = normalizeCustomerId(destination.customer_id || destination.customerId || '');
            const actionId = String(mappingsByCustomer?.[customerId]?.[eventKey] || '').trim() || null;
            if (!customerId || !actionId) return destination;
            return {
              ...destination,
              customer_id: customerId,
              conversion_action_id: actionId,
              conversion_action: `customers/${customerId}/conversionActions/${actionId}`
            };
          })
        : [];
    } else {
      const customerId = normalizeCustomerId(eventConfig.customer_id || next.customer_id || fallbackCustomerId || '');
      const actionId = String(mappingsByCustomer?.[customerId]?.[eventKey] || '').trim() || null;
      eventConfig.customer_id = customerId || null;
      eventConfig.conversion_action_id = actionId;
      eventConfig.conversion_action = customerId && actionId
        ? `customers/${customerId}/conversionActions/${actionId}`
        : null;
    }
    next.events[eventKey] = eventConfig;
  }

  const baseCustomerId = normalizeCustomerId(next.customer_id || fallbackCustomerId || '');
  const baseLeadActionId = String(mappingsByCustomer?.[baseCustomerId]?.lead || '').trim() || null;
  next.conversion_action_id = baseLeadActionId;
  next.conversion_action = baseCustomerId && baseLeadActionId
    ? `customers/${baseCustomerId}/conversionActions/${baseLeadActionId}`
    : null;
  return next;
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

function resolveAnalysisDateRange(
  timeframeRaw,
  startDateRaw,
  endDateRaw,
  { now = new Date(), timeZone = CAMPAIGN_REPORTING_TIME_ZONE } = {}
) {
  const todayParts = zonedCalendarParts(now, timeZone);
  const today = dateOnlyUtc(todayParts.year, todayParts.month, todayParts.day);

  const normalized = String(timeframeRaw || '').trim().toLowerCase();
  const explicitStart = startDateRaw ? parseDateOnlyUtc(startDateRaw, null) : null;
  const explicitEnd = endDateRaw ? parseDateOnlyUtc(endDateRaw, null) : null;
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
      start.setUTCDate(start.getUTCDate() - 1);
      end.setUTCDate(end.getUTCDate() - 1);
      break;
    case 'last_week':
      start.setUTCDate(start.getUTCDate() - 13);
      end.setUTCDate(end.getUTCDate() - 7);
      break;
    case 'last_month':
      start.setUTCDate(start.getUTCDate() - 29);
      break;
    case 'all_time':
      start.setUTCFullYear(2020, 0, 1);
      break;
    case 'last_7_days':
    default:
      start.setUTCDate(start.getUTCDate() - 6);
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
    // Compatibility alias: historically rows[].leads contained the advertising
    // provider's conversion metric. New consumers must use provider_conversions
    // and the top-level crm_metrics for actual ClinicaClick leads.
    leads: normalizedLeads,
    provider_conversions: normalizedLeads,
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

function buildCampaignAnalysisMetricContract({ provider, campaignRef, rows, leadAttribution }) {
  const campaignKey = externalCampaignIdentityKey(campaignRef);
  const campaignMetrics = campaignKey
    ? leadAttribution?.metricsIndex?.get(campaignKey)
    : null;
  const aggregate = leadAttribution?.aggregate || {};
  const unassignedByProvider = aggregate.unassigned_by_provider || {};
  const providerConversions = (Array.isArray(rows) ? rows : []).reduce((sum, row) => (
    sum + safeNumber(row?.provider_conversions ?? row?.leads)
  ), 0);
  const providerSpend = (Array.isArray(rows) ? rows : []).reduce((sum, row) => (
    sum + safeNumber(row?.spend)
  ), 0);
  const crmLeads = safeNumber(campaignMetrics?.leads);

  return {
    crm_metrics: {
      leads: crmLeads,
      qualified_leads: safeNumber(campaignMetrics?.qualified_leads),
      appointments: safeNumber(campaignMetrics?.appointments),
      crm_conversions: safeNumber(campaignMetrics?.crm_conversions),
      cost_per_lead: crmLeads > 0 ? Number((providerSpend / crmLeads).toFixed(2)) : null,
      unassigned_clinic_leads: safeNumber(unassignedByProvider[provider]),
      strategy_linked_leads: safeNumber(aggregate.linked_leads),
      clinic_paid_leads: safeNumber(aggregate.clinic_paid_leads)
    },
    provider_metrics: {
      spend: Number(providerSpend.toFixed(2)),
      conversions: Number(providerConversions.toFixed(6))
    },
    unassigned_campaigns: (Array.isArray(leadAttribution?.unassignedCampaigns)
      ? leadAttribution.unassignedCampaigns
      : [])
      .filter((item) => item.provider === provider),
    metric_contract: {
      version: 2,
      reporting_time_zone: CAMPAIGN_REPORTING_TIME_ZONE,
      rows_leads_semantics: 'provider_conversions_legacy',
      crm_leads_field: 'crm_metrics.leads'
    }
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

  const mappedAccess = await resolveGoogleCampaignMappingAccess({
    scope,
    customerId: normalizedCustomerId
  });
  if (!mappedAccess?.account || !mappedAccess?.connection) {
    return null;
  }

  const { account, connection } = mappedAccess;
  const { accessToken } = await ensureGoogleAdsAccess(connection);
  const loginCustomerId = normalizeCustomerId(account.loginCustomerId || account.managerCustomerId || '')
    || await resolveLoginCustomerId(connection.id, normalizedCustomerId, scope)
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

function strategyPayloadUsesGoogleAds(payload) {
  const channels = Array.isArray(payload?.channels) ? payload.channels : [];
  const channelUsesGoogle = channels.some((channel) => (
    String(channel?.channel || channel || '').trim().toLowerCase() === 'google_ads'
      && (typeof channel !== 'object' || channel?.enabled !== false)
  ));
  if (channelUsesGoogle || payload?.measurement?.channel_native?.google_ads_conversions === true) {
    return true;
  }

  const googleConfig = payload?.google_ads && typeof payload.google_ads === 'object'
    && !Array.isArray(payload.google_ads)
    ? payload.google_ads
    : null;
  if (googleConfig && googleConfig.enabled !== false && (
    googleConfig.customer_id
      || googleConfig.account_id
      || Array.isArray(googleConfig.targets)
      || Array.isArray(googleConfig.destinations)
      || googleConfig.events
  )) {
    return true;
  }

  const providerIsGoogle = (value) => {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    return Boolean(
      source.google_ads_customer_id
        || source.cc_gads_customer_id
        || source.google_customer_id
    ) || ['provider', 'platform', 'network', 'channel', 'source', 'type'].some((key) => (
      ['google_ads', 'google', 'adwords'].includes(String(source[key] || '').trim().toLowerCase())
    ));
  };
  const targetCollections = [
    payload?.external_targets,
    payload?.targets,
    payload?.measurement?.targets,
    payload?.measurement?.external_targets,
  ];
  return targetCollections.some((collection) => (
    Array.isArray(collection) && collection.some((target) => (
      providerIsGoogle(target)
        || (Array.isArray(target?.campaigns) && target.campaigns.some(providerIsGoogle))
        || (Array.isArray(target?.targets) && target.targets.some(providerIsGoogle))
    ))
  ));
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

function buildStrategyItemFromRows(rows, campaignsById, inventoryIndex = null) {
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
  const status = normalizedStatus;
  const externalTargets = overlayExternalTargetsWithInventory(payload.external_targets, inventoryIndex);
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
    mode_contract: payload.mode_contract && typeof payload.mode_contract === 'object'
      ? payload.mode_contract
      : (mode ? buildCampaignModeContract(mode, null) : null),
    status,
    activation_readiness: payload.activation_readiness && typeof payload.activation_readiness === 'object'
      ? payload.activation_readiness
      : null,
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
    '  conversion_action.counting_type,',
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
    suggested_mapping: buildSuggestedMapping(actions),
    clinicaclick_mapping: buildClinicaclickManagedMapping(actions)
  };
}

async function ensureConversionActionsInternal({
  accessToken,
  customerId,
  loginCustomerId,
  currency,
  events,
  createMissing
}) {
  const requestedEvents = listToUniqueArray(
    (Array.isArray(events) && events.length ? events : DEFAULT_ENABLED_CONVERSION_EVENTS)
      .filter((key) => VALID_EVENTS.includes(key))
  );
  const current = await listConversionActionsInternal({ accessToken, customerId, loginCustomerId });
  // Provisioning no adopta acciones del cliente por coincidencias vagas. Solo
  // reutiliza nombres canónicos de ClinicaClick y nunca modifica ni elimina el
  // resto de acciones existentes en la cuenta.
  const existingMapping = current.clinicaclick_mapping || {};
  const created = [];
  const existing = [];

  for (const key of requestedEvents) {
    if (existingMapping[key]) {
      const matched = current.actions.find((a) => a.id === existingMapping[key]);
      existing.push({
        event: key,
        id: existingMapping[key],
        name: matched?.name || EVENT_CATALOG[key].name,
        primary_for_goal: matched?.primary_for_goal ?? null,
        counting_type: matched?.counting_type || null
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
        create: buildClinicaclickConversionActionCreate(key, currency)
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
          name: EVENT_CATALOG[event].name,
          primary_for_goal: false
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
      qualified_lead: {
        // No se activa por defecto: solo queda disponible cuando la acción se
        // ha solicitado y existe inequívocamente en esta cuenta.
        enabled: Boolean(existingMapping.qualified_lead),
        conversion_action_id: existingMapping.qualified_lead || null,
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
      qualified_lead: existingMapping.qualified_lead || null,
      schedule: existingMapping.schedule || null,
      purchase: existingMapping.purchase || null
    },
    recommended_google_ads_config: recommended
  };
}

async function evaluateGoogleConversionOnboardingReadiness({
  userId,
  scope,
  rawGoogleAdsConfig,
  fallbackCustomerId,
  currency = 'EUR',
  createMissing = false,
  consentReadiness = null,
  runtimeCache = null
}) {
  const plan = buildRequiredConversionPlan(rawGoogleAdsConfig, fallbackCustomerId);
  const mappingsByCustomer = {};
  const actionsByCustomer = {};
  const capabilitiesByCustomer = {};
  const validationsByTarget = {};
  const runtimesByCustomer = {};
  const runtimeIssues = [];
  const created = [];
  const quotaProjectConfigured = Boolean(
    process.env.GOOGLE_DATA_MANAGER_QUOTA_PROJECT
      || process.env.GOOGLE_CLOUD_PROJECT
  );

  for (const customerId of plan.customer_ids) {
    let runtime;
    try {
      runtime = runtimeCache instanceof Map ? runtimeCache.get(customerId) : null;
      if (!runtime) {
        runtime = await resolveScopedGoogleAdsRuntime({
          userId,
          clinicId: scope.clinic_id,
          groupId: scope.group_id,
          assignmentScope: scope.assignment_scope,
          customerId,
          requiredScopes: [GOOGLE_ADS_SCOPE]
        });
        if (runtimeCache instanceof Map) runtimeCache.set(customerId, runtime);
      }
    } catch (error) {
      capabilitiesByCustomer[customerId] = {
        data_manager_scope_granted: false,
        data_manager_quota_project_configured: quotaProjectConfigured
      };
      runtimeIssues.push({
        reason: String(error.code || 'scoped_google_runtime_unavailable').toLowerCase(),
        customer_id: customerId,
        message: error.message || null
      });
      continue;
    }

    runtimesByCustomer[customerId] = runtime;
    const hasDataManagerScope = hasScopeText(runtime.connection?.scopes || '', GOOGLE_DATA_MANAGER_SCOPE);
    capabilitiesByCustomer[customerId] = {
      data_manager_scope_granted: hasDataManagerScope,
      data_manager_quota_project_configured: quotaProjectConfigured
    };

    const customerEvents = listToUniqueArray(
      plan.targets
        .filter((target) => target.customer_id === customerId)
        .map((target) => target.event)
    );
    try {
      let ensured = await ensureConversionActionsInternal({
        accessToken: runtime.accessToken,
        customerId,
        loginCustomerId: runtime.loginCustomerId,
        currency,
        events: customerEvents,
        createMissing
      });
      if (ensured.created.length) {
        created.push(...ensured.created.map((item) => ({ ...item, customer_id: customerId })));
        ensured = await ensureConversionActionsInternal({
          accessToken: runtime.accessToken,
          customerId,
          loginCustomerId: runtime.loginCustomerId,
          currency,
          events: customerEvents,
          createMissing: false
        });
      }
      const listed = await listConversionActionsInternal({
        accessToken: runtime.accessToken,
        customerId,
        loginCustomerId: runtime.loginCustomerId
      });
      mappingsByCustomer[customerId] = listed.clinicaclick_mapping || {};
      actionsByCustomer[customerId] = listed.actions || [];
    } catch (error) {
      runtimeIssues.push({
        reason: 'conversion_actions_read_failed',
        customer_id: customerId,
        message: error?.response?.data?.error?.message || error.message || null
      });
    }
  }

  const planWithRuntimeIssues = {
    ...plan,
    issues: [...plan.issues, ...runtimeIssues]
  };
  const preValidation = assessConversionOnboardingReadiness({
    plan: planWithRuntimeIssues,
    mappingsByCustomer,
    actionsByCustomer,
    capabilitiesByCustomer,
    validationsByTarget
  });

  for (const target of preValidation.targets) {
    const capability = capabilitiesByCustomer[target.customer_id] || {};
    const runtime = runtimesByCustomer[target.customer_id];
    const action = (actionsByCustomer[target.customer_id] || [])
      .find((candidate) => String(candidate?.id || '') === target.conversion_action_id);
    if (
      !runtime
      || capability.data_manager_scope_granted !== true
      || capability.data_manager_quota_project_configured !== true
      || String(action?.status || '').toUpperCase() !== 'ENABLED'
      || String(action?.counting_type || '').toUpperCase() !== 'MANY_PER_CLICK'
      || action?.primary_for_goal !== false
    ) continue;
    if (validationsByTarget[target.validation_key]) continue;
    try {
      await uploadGoogleDataManagerConversion({
        customerId: target.customer_id,
        conversionAction: `customers/${target.customer_id}/conversionActions/${target.conversion_action_id}`,
        conversionDateTime: new Date(),
        externalId: `cc-onboarding-validation-${target.event}-${Date.now()}`,
        gclid: 'GCLID_1',
        value: 0,
        currency,
        eventName: target.event,
        eventSource: 'WEB',
        accessToken: runtime.accessToken,
        loginCustomerId: runtime.loginCustomerId,
        validateOnly: true
      });
      validationsByTarget[target.validation_key] = {
        status: 'validated',
        validated: true,
        validate_only: true,
        checked_at: new Date().toISOString()
      };
    } catch (error) {
      const providerError = error?.response?.data?.error || null;
      validationsByTarget[target.validation_key] = {
        status: 'failed',
        validated: false,
        validate_only: true,
        checked_at: new Date().toISOString(),
        error: String(providerError?.status || error?.code || 'data_manager_validation_failed').toLowerCase(),
        message: providerError?.message || error.message || 'Google no pudo validar Data Manager'
      };
    }
  }

  const conversionReadiness = assessConversionOnboardingReadiness({
    plan: planWithRuntimeIssues,
    mappingsByCustomer,
    actionsByCustomer,
    capabilitiesByCustomer,
    validationsByTarget
  });
  const reportedConsentIssues = Array.isArray(consentReadiness?.issues)
    ? consentReadiness.issues
    : [];
  const consentIssues = consentReadiness?.ready === true && consentReadiness?.validated === true
    ? []
    : (reportedConsentIssues.length > 0
        ? reportedConsentIssues
        : [{ reason: 'consent_readiness_pending' }]);
  const combinedIssues = [...conversionReadiness.issues, ...consentIssues];
  const combinedReasons = listToUniqueArray(combinedIssues.map((issue) => issue.reason));
  const readiness = {
    ...conversionReadiness,
    ready: conversionReadiness.ready && consentIssues.length === 0,
    validated: conversionReadiness.validated && consentIssues.length === 0,
    reason: combinedReasons[0] || null,
    reasons: combinedReasons,
    issues: combinedIssues,
    consent_readiness: consentReadiness || null
  };
  return {
    ...readiness,
    mappings_by_customer: mappingsByCustomer,
    capabilities_by_customer: capabilitiesByCustomer,
    validations_by_target: validationsByTarget,
    created_actions: created,
    canonical_google_ads_config: readiness.ready
      ? applyCanonicalMappingsToGoogleAdsConfig(rawGoogleAdsConfig, fallbackCustomerId, mappingsByCustomer)
      : null
  };
}

function isConsentVerificationRenewalIssue(issue) {
  return issue?.reason === 'consent_attestation_renewal_required'
    || issue?.details === 'attestation_operational_expired';
}

/**
 * Read-only audit used by the durable Google Ads job for Mide y entiende.
 * It checks the configured destinations against the canonical actions read
 * from Google, executes Data Manager validateOnly and reports consent drift.
 * It never creates actions or changes campaigns, goals, bids or IntakeConfig.
 */
async function auditConnectOnlyMeasurementTarget({
  scope,
  intakeRecord,
  strategyCampaigns,
  dependencies = {},
  now = new Date()
} = {}) {
  const record = intakeRecord || null;
  const rawConfig = asPlainObject(record?.config);
  const rawGoogleAdsConfig = asPlainObject(rawConfig.google_ads);
  const auditScope = {
    assignment_scope: String(scope?.assignment_scope || record?.assignment_scope || '').toLowerCase() === 'group'
      ? 'group'
      : 'clinic',
    clinic_id: parseInteger(scope?.clinic_id || record?.clinic_id),
    group_id: parseInteger(scope?.group_id || record?.group_id)
  };
  const marketingState = {
    scope: auditScope,
    records: auditScope.assignment_scope === 'group'
      ? { clinicRecord: null, groupRecord: record }
      : { clinicRecord: record, groupRecord: null }
  };
  const assessConsent = dependencies.assessConsentMeasurementReadiness
    || assessConsentMeasurementReadiness;
  const evaluateReadiness = dependencies.evaluateGoogleConversionOnboardingReadiness
    || evaluateGoogleConversionOnboardingReadiness;
  const auditCampaignQuality = dependencies.auditConnectOnlyCampaignQuality
    || auditConnectOnlyCampaignQuality;
  const runtimeCache = dependencies.googleAdsRuntimeCache instanceof Map
    ? dependencies.googleAdsRuntimeCache
    : new Map();
  const consentReadiness = assessConsent(marketingState);
  const fallbackCustomerId = normalizeCustomerId(rawGoogleAdsConfig.customer_id || '') || null;
  const conversionReadiness = await evaluateReadiness({
    userId: null,
    scope: auditScope,
    rawGoogleAdsConfig,
    fallbackCustomerId,
    currency: normalizeCurrency(rawGoogleAdsConfig.currency || 'EUR'),
    createMissing: false,
    consentReadiness,
    runtimeCache
  });

  const enhanced = asPlainObject(rawGoogleAdsConfig.enhanced_conversions);
  const activationAudit = asPlainObject(enhanced.activation_audit);
  const activationApplied = isEnhancedConversionActivationApplied(
    rawConfig,
    activationAudit.reconciliation_key || null
  );
  const allowlistIssues = validateEnhancedConversionActivationAllowlist(enhanced, now);
  const collectedIssues = [];
  const issueKey = (issue) => JSON.stringify([
    issue?.code || null,
    issue?.reason || null,
    issue?.details || null,
    issue?.customer_id || null,
    issue?.campaign_id || null,
    issue?.event || null,
    issue?.destination_key || null,
    issue?.conversion_action_id || null
  ]);
  const seenIssues = new Set();
  const addIssue = (rawIssue, forcedSeverity = null) => {
    const issue = asPlainObject(rawIssue);
    const key = issueKey(issue);
    if (seenIssues.has(key)) return;
    seenIssues.add(key);
    collectedIssues.push({
      ...issue,
      severity: forcedSeverity
        || issue.severity
        || (isConsentVerificationRenewalIssue(issue) ? 'warning' : 'critical')
    });
  };
  for (const issue of conversionReadiness?.issues || []) addIssue(issue);
  for (const issue of allowlistIssues) addIssue(issue);
  if (enhanced.enabled !== true) {
    addIssue({ reason: 'enhanced_conversions_runtime_disabled' });
  } else if (!activationApplied) {
    addIssue({ reason: 'enhanced_conversion_activation_drift' });
  }

  const targets = (conversionReadiness?.targets || []).map((target) => ({
    event: target.event || null,
    destination_key: target.destination_key || null,
    customer_id: target.customer_id || null,
    configured_conversion_action_id: target.configured_action_id || null,
    canonical_conversion_action_id: target.conversion_action_id || null,
    campaign_ids: listToUniqueArray(
      (Array.isArray(target.campaign_ids) ? target.campaign_ids : [])
        .map((campaignId) => String(campaignId || '').trim())
        .filter((campaignId) => /^\d+$/.test(campaignId))
    ),
    campaign_count: Array.isArray(target.campaign_ids) ? target.campaign_ids.length : 0,
    validated: target.validated === true,
    validate_only: true
  }));
  let campaignQuality = {
    schema_version: 'clinicaclick-google-ads-connect-only-campaign-quality/v1',
    mode: 'not_requested',
    audited_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    autorepair: false,
    external_mutation_count: 0,
    google_ads_mutated: false,
    healthy: true,
    summary: {
      account_count: 0,
      configured_campaign_count: 0,
      observed_campaign_count: 0,
      issue_count: 0,
      critical_count: 0,
      recommendation_count: 0
    },
    accounts: [],
    issues: [],
    recommendations: []
  };
  if (Array.isArray(strategyCampaigns)) {
    try {
      campaignQuality = await auditCampaignQuality({
        scope: auditScope,
        campaigns: strategyCampaigns,
        canonicalTargets: targets,
        runtimeCache,
        dependencies,
        now
      });
    } catch (error) {
      addIssue({
        code: error.code || 'CONNECT_ONLY_CAMPAIGN_QUALITY_AUDIT_FAILED',
        message: String(error.message || 'No se pudo auditar la calidad de las campañas').slice(0, 500)
      }, 'warning');
      campaignQuality = {
        ...campaignQuality,
        mode: 'connect_only_campaign_quality_read_only',
        healthy: false,
        summary: { ...campaignQuality.summary, issue_count: 1, critical_count: 1 },
        issues: [collectedIssues[collectedIssues.length - 1]],
      };
    }
  }
  const criticalCount = collectedIssues.filter((issue) => issue.severity === 'critical').length;
  const warningCount = collectedIssues.filter((issue) => issue.severity === 'warning').length;
  return {
    schema_version: 'clinicaclick-google-ads-connect-only-measurement-audit/v1',
    mode: 'connect_only_measurement_audit_read_only',
    audited_at: (now instanceof Date ? now : new Date(now)).toISOString(),
    healthy: criticalCount === 0,
    runtime_ready: criticalCount === 0 && activationApplied,
    autorepair: false,
    validate_only: true,
    external_mutation_count: 0,
    google_ads_mutated: false,
    intake_config_id: parseInteger(record?.id),
    scope: auditScope,
    summary: {
      target_count: targets.length,
      account_count: Array.isArray(conversionReadiness?.customer_ids)
        ? conversionReadiness.customer_ids.length
        : 0,
      validated_target_count: targets.filter((target) => target.validated).length,
      critical_count: criticalCount,
      warning_count: warningCount,
      issue_count: collectedIssues.length
    },
    consent: {
      provider: consentReadiness?.provider || null,
      domains: consentReadiness?.domains || [],
      verification_current: consentReadiness?.verification_current !== false
        && consentReadiness?.ready === true,
      renewal_required: consentReadiness?.renewal_required === true,
      expires_at: consentReadiness?.expires_at || null,
      runtime_configuration_ready: consentReadiness?.runtime_configuration_ready === true,
      runtime_consent_source: 'visitor_choice',
      grants_consent: false
    },
    enhanced_conversions: {
      enabled: enhanced.enabled === true,
      activation_applied: activationApplied,
      allowlist_entry_count: Array.isArray(enhanced.allowlist) ? enhanced.allowlist.length : 0,
      account_gate_checked_at: activationAudit.account_gate?.checked_at || null,
      account_gate_all_enabled: activationAudit.account_gate?.all_enabled === true,
      canonical_actions_are_secondary: true,
      reporting_metric: 'all_conversions'
    },
    targets,
    capabilities_by_customer: conversionReadiness?.capabilities_by_customer || {},
    campaign_quality: campaignQuality,
    issues: collectedIssues
  };
}

function readCampaignRequestStrategyPayload(row) {
  const raw = row?.solicitud ?? row?.get?.('solicitud') ?? null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function stableStrategyReadinessStringify(value) {
  if (value === null) return 'null';
  if (value === undefined) return '"__undefined__"';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStrategyReadinessStringify).join(',')}]`;
  }
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStrategyReadinessStringify(value[key])}`
  )).join(',')}}`;
}

function strategyReadinessFingerprint(value) {
  return crypto.createHash('sha256').update(stableStrategyReadinessStringify(value)).digest('hex');
}

function strategyReadinessRelevantPayload(payload) {
  const source = asPlainObject(payload);
  return {
    kind: source.kind || null,
    objective_id: source.objective_id || null,
    status: source.status || null,
    mode_snapshot: source.mode_snapshot || null,
    mode: source.mode || null,
    scope: source.scope || null,
    channels: source.channels || null,
    measurement: source.measurement || null,
    google_ads: source.google_ads || null,
    external_targets: source.external_targets || null,
    targets: source.targets || null,
    destination: source.destination || null
  };
}

function readIntakeRecordConfig(record) {
  const raw = record?.config ?? record?.get?.('config') ?? null;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string' || !raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch (_error) {
    return {};
  }
}

function intakeRecordReadinessFingerprint(record) {
  return strategyReadinessFingerprint({
    id: parseInteger(record?.id),
    assignment_scope: String(record?.assignment_scope || record?.assignmentScope || '').trim().toLowerCase(),
    clinic_id: parseInteger(record?.clinic_id ?? record?.clinicId),
    group_id: parseInteger(record?.group_id ?? record?.groupId),
    domains: normalizeConsentDomains(record?.domains),
    config: readIntakeRecordConfig(record),
    updated_at: String(record?.updated_at || record?.updatedAt || '') || null
  });
}

function extractStrategyGoogleCustomerIds(payload) {
  const customerIds = [];
  for (const collection of [payload?.external_targets, payload?.targets]) {
    for (const target of Array.isArray(collection) ? collection : []) {
      const campaigns = Array.isArray(target?.campaigns)
        ? target.campaigns
        : (Array.isArray(target?.external_campaigns) ? target.external_campaigns : []);
      for (const campaign of campaigns) {
        const provider = String(campaign?.provider || campaign?.type || '').trim().toLowerCase();
        if (provider && provider !== 'google_ads' && provider !== 'google') continue;
        const customerId = normalizeCustomerId(
          campaign?.customer_id
            || campaign?.provider_account_id
            || campaign?.account_id
            || ''
        );
        if (customerId) customerIds.push(customerId);
      }
    }
  }
  return listToUniqueArray(customerIds).sort();
}

function isPropdentalConnectOnlyGoogleReadinessCandidate(row) {
  const payload = readCampaignRequestStrategyPayload(row);
  const scope = asPlainObject(payload.scope);
  return String(row?.estado || '').trim().toLowerCase() === STRATEGY_REQUEST_STATE_MAP.active
    && payload.kind === 'marketing_strategy'
    && payload.objective_id === 'new_patients'
    && usesExistingAdvertiserCampaigns(
      String(payload.mode_snapshot || payload.mode || '').trim().toLowerCase()
    )
    && String(payload.status || '').trim().toLowerCase() === 'active'
    && parseInteger(scope.group_id) === ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID
    && strategyPayloadUsesGoogleAds(payload);
}

function buildPropdentalStrategyReadinessCandidate(row) {
  const payload = readCampaignRequestStrategyPayload(row);
  const scope = asPlainObject(payload.scope);
  const id = parseInteger(row?.id);
  const rowClinicId = parseInteger(row?.clinica_id ?? row?.clinicaId);
  const payloadClinicId = parseInteger(scope.clinic_id);
  const groupId = parseInteger(scope.group_id);
  const assignmentScope = String(scope.assignment_scope || '').trim().toLowerCase();
  const scopedClinicIds = normalizeClinicIds(scope.clinic_ids || []);
  let invalidReason = null;
  if (!id) invalidReason = 'strategy_request_id_invalid';
  else if (assignmentScope !== 'clinic') invalidReason = 'strategy_scope_must_be_clinic';
  else if (!rowClinicId || !payloadClinicId) invalidReason = 'strategy_clinic_scope_missing';
  else if (rowClinicId !== payloadClinicId) invalidReason = 'strategy_row_clinic_mismatch';
  else if (groupId !== ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID) invalidReason = 'strategy_group_scope_mismatch';
  else if (scopedClinicIds.length !== 1 || scopedClinicIds[0] !== payloadClinicId) {
    invalidReason = 'strategy_scope_clinic_ids_mismatch';
  }
  const customerIds = extractStrategyGoogleCustomerIds(payload);
  if (!invalidReason && customerIds.length === 0) invalidReason = 'strategy_google_customer_scope_missing';
  if (!invalidReason && customerIds.some((customerId) => (
    !GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_CUSTOMER_IDS.includes(customerId)
  ))) {
    invalidReason = 'strategy_google_customer_scope_not_allowlisted';
  }
  return {
    id,
    row,
    payload,
    clinic_id: payloadClinicId,
    group_id: groupId,
    customer_ids: customerIds,
    invalid_reason: invalidReason,
    strategy_fingerprint: strategyReadinessFingerprint({
      id,
      estado: String(row?.estado || '').trim().toLowerCase(),
      clinica_id: rowClinicId,
      payload: strategyReadinessRelevantPayload(payload)
    })
  };
}

function hasExplicitGoogleMeasurementConfig(rawConfig) {
  const config = asPlainObject(rawConfig);
  if (config.enabled === false) return false;
  if (normalizeCustomerId(config.customer_id || config.customerId || '')) return true;
  const events = asPlainObject(config.events);
  return Object.values(events).some((eventConfig) => {
    const event = asPlainObject(eventConfig);
    if (event.enabled === false) return false;
    if (normalizeCustomerId(event.customer_id || event.customerId || '')) return true;
    if (event.conversion_action_id || event.conversionActionId || event.conversion_action || event.send_to) return true;
    return (Array.isArray(event.destinations) ? event.destinations : []).some((destination) => (
      normalizeCustomerId(destination?.customer_id || destination?.customerId || '')
        && Boolean(
          destination?.conversion_action_id
          || destination?.conversionActionId
          || destination?.conversion_action
          || destination?.send_to
        )
    ));
  });
}

function exactCustomerScope(left, right) {
  const normalizedLeft = listToUniqueArray((left || []).map(normalizeCustomerId).filter(Boolean)).sort();
  const normalizedRight = listToUniqueArray((right || []).map(normalizeCustomerId).filter(Boolean)).sort();
  return stableStrategyReadinessStringify(normalizedLeft) === stableStrategyReadinessStringify(normalizedRight);
}

function buildSanitizedStrategyValidationTargets(readiness) {
  const validations = asPlainObject(readiness?.validations_by_target);
  return (Array.isArray(readiness?.targets) ? readiness.targets : []).map((target) => {
    const validationKey = String(target?.validation_key || '').trim() || null;
    const validation = validationKey ? asPlainObject(validations[validationKey]) : {};
    return {
      customer_id: normalizeCustomerId(target?.customer_id || '') || null,
      event: String(target?.event || '').trim().toLowerCase() || null,
      conversion_action_id: String(target?.conversion_action_id || '').trim() || null,
      validation_key: validationKey,
      validate_only: validation.validate_only === true,
      validated: validation.validated === true,
      checked_at: String(validation.checked_at || '').trim() || null
    };
  }).filter((target) => (
    target.customer_id
      && target.event
      && target.conversion_action_id
      && target.validation_key
      && target.validate_only
      && target.validated
      && target.checked_at
  ));
}

function consentReadinessIsCurrent(consentReadiness, now = new Date()) {
  const expiresAt = Date.parse(String(consentReadiness?.expires_at || ''));
  return consentReadiness?.ready === true
    && consentReadiness?.validated === true
    && Number.isFinite(expiresAt)
    && expiresAt > now.getTime();
}

function strategyReadinessSnapshotIsCurrent(payload, evidence, now = new Date()) {
  const snapshot = asPlainObject(payload?.activation_readiness);
  const validatedScope = asPlainObject(snapshot.validated_scope);
  const currentTargets = Array.isArray(snapshot.validated_targets) ? snapshot.validated_targets : [];
  return consentReadinessIsCurrent(evidence.consent_readiness, now)
    && snapshot.ready === true
    && snapshot.validated === true
    && snapshot.validate_only === true
    && snapshot.reconciliation_key === evidence.reconciliation_key
    && exactCustomerScope(snapshot.customer_ids, evidence.customer_ids)
    && snapshot?.consent_readiness?.expires_at === evidence.consent_readiness?.expires_at
    && validatedScope.assignment_scope === evidence.validated_scope.assignment_scope
    && parseInteger(validatedScope.group_id) === evidence.validated_scope.group_id
    && parseInteger(validatedScope.clinic_id) === evidence.validated_scope.clinic_id
    && validatedScope.source === evidence.validated_scope.source
    && snapshot.scope_fingerprint === evidence.scope_fingerprint
    && snapshot.strategy_fingerprint === evidence.strategy_fingerprint
    && currentTargets.length > 0
    && currentTargets.every((target) => (
      target?.validate_only === true
        && target?.validated === true
        && Boolean(target?.customer_id && target?.event && target?.conversion_action_id && target?.checked_at)
    ));
}

/**
 * Reconciles the historical activation snapshot of active Propdental
 * connect_only strategies after the scoped Enhanced gate is healthy.
 *
 * This performs Google reads plus Data Manager validateOnly requests through
 * evaluateGoogleConversionOnboardingReadiness. It never creates conversion
 * actions, uploads a real conversion or mutates Campaign/Google state.
 */
async function reconcileVerifiedConnectOnlyStrategyActivationReadiness(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const dependencies = options.dependencies || {};
  const enhancedActivation = options.enhancedActivation || options.enhanced_activation || null;
  const activationStatus = String(enhancedActivation?.status || '').trim().toLowerCase();
  const reconciliationKey = String(enhancedActivation?.reconciliation_key || '').trim() || null;
  if (
    !['activated', 'already_active'].includes(activationStatus)
    || enhancedActivation?.ready !== true
  ) {
    return {
      status: 'skipped',
      reason: 'enhanced_activation_not_ready',
      updated: false,
      idempotent: true,
      reconciled: 0,
      validate_only: true,
      external_mutation_performed: false,
      google_ads_mutated: false
    };
  }

  const gateCustomerIds = listToUniqueArray(
    (Array.isArray(enhancedActivation.customer_ids) ? enhancedActivation.customer_ids : [])
      .map((value) => normalizeCustomerId(value))
      .filter(Boolean)
  );
  if (
    !reconciliationKey
    || reconciliationKey.length > 191
    || gateCustomerIds.length === 0
    || gateCustomerIds.some((customerId) => (
      !GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_CUSTOMER_IDS.includes(customerId)
    ))
  ) {
    return {
      status: 'blocked',
      reason: !reconciliationKey || reconciliationKey.length > 191
        ? 'enhanced_activation_reconciliation_key_invalid'
        : 'enhanced_activation_customer_scope_invalid',
      updated: false,
      idempotent: false,
      reconciled: 0,
      customer_ids: gateCustomerIds,
      validate_only: true,
      external_mutation_performed: false,
      google_ads_mutated: false
    };
  }

  const campaignRequestModel = dependencies.CampaignRequest || CampaignRequest;
  const pendingRows = await campaignRequestModel.findAll({
    where: { estado: STRATEGY_REQUEST_STATE_MAP.active },
    attributes: ['id', 'clinica_id', 'estado', 'solicitud']
  });
  const candidates = (Array.isArray(pendingRows) ? pendingRows : [])
    .filter(isPropdentalConnectOnlyGoogleReadinessCandidate)
    .map(buildPropdentalStrategyReadinessCandidate);
  const candidateIds = candidates.map((candidate) => candidate.id).filter(Boolean);
  if (candidates.length === 0) {
    return {
      status: 'already_reconciled',
      reason: 'no_pending_strategy_readiness',
      updated: false,
      idempotent: true,
      reconciled: 0,
      validate_only: true,
      external_mutation_performed: false,
      google_ads_mutated: false
    };
  }

  const resolveScope = dependencies.resolveScopeFromInput || resolveScopeFromInput;
  const resolveMarketingState = dependencies.resolveEffectiveMarketingState || resolveEffectiveMarketingState;
  const assessConsent = dependencies.assessConsentMeasurementReadiness || assessConsentMeasurementReadiness;
  const evaluateReadiness = dependencies.evaluateGoogleConversionOnboardingReadiness
    || evaluateGoogleConversionOnboardingReadiness;
  const groupScope = await resolveScope({
    clinicIdRaw: null,
    groupIdRaw: ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID,
    assignmentScopeRaw: 'group'
  });
  if (
    groupScope?.assignment_scope !== 'group'
    || parseInteger(groupScope?.group_id) !== ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID
  ) {
    return {
      status: 'blocked',
      reason: 'strategy_readiness_scope_not_allowlisted',
      updated: false,
      idempotent: false,
      reconciled: 0,
      validate_only: true,
      external_mutation_performed: false,
      google_ads_mutated: false
    };
  }

  const groupMarketingState = await resolveMarketingState({
    clinicIdRaw: null,
    groupIdRaw: ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID,
    assignmentScopeRaw: 'group'
  });
  const groupRecord = groupMarketingState?.records?.groupRecord || null;
  const groupConfig = readIntakeRecordConfig(groupRecord);
  const groupLocationIds = new Set((Array.isArray(groupConfig.locations) ? groupConfig.locations : [])
    .map((location) => parseInteger(location?.id || location?.clinic_id))
    .filter(Boolean));
  const groupConsentReadiness = assessConsent(groupMarketingState);
  const blockedById = new Map();
  const addBlocked = (candidate, reason, extra = {}) => {
    if (!candidate?.id || blockedById.has(candidate.id)) return;
    blockedById.set(candidate.id, {
      id: candidate.id,
      clinic_id: candidate.clinic_id || null,
      reason,
      ...(extra.reasons?.length ? { reasons: extra.reasons } : {}),
      ...(extra.issues?.length ? { issues: extra.issues } : {})
    });
  };
  const evaluationCache = new Map();
  const validatedCandidates = [];
  const currentIds = [];

  for (const candidate of candidates) {
    if (candidate.invalid_reason) {
      addBlocked(candidate, candidate.invalid_reason);
      continue;
    }
    const clinicScope = await resolveScope({
      clinicIdRaw: candidate.clinic_id,
      groupIdRaw: null,
      assignmentScopeRaw: 'clinic'
    });
    if (
      clinicScope?.assignment_scope !== 'clinic'
      || parseInteger(clinicScope?.clinic_id) !== candidate.clinic_id
      || parseInteger(clinicScope?.group_id) !== candidate.group_id
    ) {
      addBlocked(candidate, 'strategy_resolved_scope_mismatch');
      continue;
    }

    const isGroupWebLocation = groupLocationIds.has(candidate.clinic_id);
    let evaluationScope;
    let marketingState;
    let sourceRecord;
    let rawGoogleAdsConfig;
    let consentReadiness;
    let source;
    if (isGroupWebLocation) {
      evaluationScope = groupScope;
      marketingState = groupMarketingState;
      sourceRecord = groupRecord;
      rawGoogleAdsConfig = groupConfig.google_ads || {};
      consentReadiness = groupConsentReadiness;
      source = 'group_web_location';
    } else {
      const clinicMarketingState = await resolveMarketingState({
        clinicIdRaw: candidate.clinic_id,
        groupIdRaw: null,
        assignmentScopeRaw: 'clinic'
      });
      sourceRecord = clinicMarketingState?.records?.clinicRecord || null;
      const clinicConfig = readIntakeRecordConfig(sourceRecord);
      rawGoogleAdsConfig = clinicConfig.google_ads || {};
      evaluationScope = clinicScope;
      marketingState = {
        ...clinicMarketingState,
        scope: clinicScope,
        records: { clinicRecord: sourceRecord, groupRecord: null },
        tracking: { ...(clinicMarketingState?.tracking || {}), google_ads: rawGoogleAdsConfig }
      };
      consentReadiness = assessConsent(marketingState);
      source = 'clinic';
      if (!sourceRecord) {
        addBlocked(candidate, 'clinic_scope_intake_config_missing');
        continue;
      }
      if (!hasExplicitGoogleMeasurementConfig(rawGoogleAdsConfig)) {
        addBlocked(candidate, 'clinic_scope_google_measurement_config_missing');
        continue;
      }
    }
    const sourceRecordId = parseInteger(sourceRecord?.id);
    if (!sourceRecordId || !hasExplicitGoogleMeasurementConfig(rawGoogleAdsConfig)) {
      addBlocked(candidate, source === 'group_web_location'
        ? 'group_scope_google_measurement_config_missing'
        : 'clinic_scope_google_measurement_config_missing');
      continue;
    }
    const normalizedGoogleAdsConfig = normalizeGoogleAdsConfig(rawGoogleAdsConfig);
    const validatedScope = {
      assignment_scope: source === 'group_web_location' ? 'group' : 'clinic',
      group_id: candidate.group_id,
      clinic_id: candidate.clinic_id,
      source
    };
    const sourceRecordFingerprint = intakeRecordReadinessFingerprint(sourceRecord);
    const scopeFingerprint = strategyReadinessFingerprint({
      validated_scope: validatedScope,
      source_record_id: sourceRecordId,
      source_record_fingerprint: sourceRecordFingerprint,
      customer_ids: candidate.customer_ids,
      google_ads: rawGoogleAdsConfig,
      consent_expires_at: consentReadiness?.expires_at || null
    });
    const evidenceBase = {
      reconciliation_key: reconciliationKey,
      customer_ids: candidate.customer_ids,
      consent_readiness: consentReadiness,
      validated_scope: validatedScope,
      scope_fingerprint: scopeFingerprint,
      strategy_fingerprint: candidate.strategy_fingerprint
    };
    if (!consentReadinessIsCurrent(consentReadiness, now)) {
      addBlocked(candidate, 'strategy_consent_readiness_not_current', {
        reasons: consentReadiness?.reasons || [],
        issues: consentReadiness?.issues || []
      });
      continue;
    }
    if (strategyReadinessSnapshotIsCurrent(candidate.payload, evidenceBase, now)) {
      currentIds.push(candidate.id);
      continue;
    }

    const evaluationIdentity = strategyReadinessFingerprint({
      assignment_scope: evaluationScope.assignment_scope,
      clinic_id: evaluationScope.assignment_scope === 'clinic' ? evaluationScope.clinic_id : null,
      group_id: evaluationScope.group_id,
      source_record_fingerprint: sourceRecordFingerprint,
      customer_ids: candidate.customer_ids,
      consent_readiness: consentReadiness
    });
    let evaluation = evaluationCache.get(evaluationIdentity);
    if (!evaluation) {
      const fallbackCustomerId = normalizedGoogleAdsConfig.customer_id
        || marketingState?.google?.effective_assets?.account?.customer_id
        || candidate.customer_ids[0]
        || null;
      const readiness = await evaluateReadiness({
        userId: null,
        scope: evaluationScope,
        rawGoogleAdsConfig,
        fallbackCustomerId,
        currency: normalizedGoogleAdsConfig.currency || 'EUR',
        createMissing: false,
        consentReadiness
      });
      const readinessCustomerIds = listToUniqueArray(
        (Array.isArray(readiness?.customer_ids) ? readiness.customer_ids : [])
          .map((value) => normalizeCustomerId(value))
          .filter(Boolean)
      ).sort();
      const validatedTargets = buildSanitizedStrategyValidationTargets(readiness);
      const expectedTargetCount = Array.isArray(readiness?.targets) ? readiness.targets.length : 0;
      const customerScopeMatches = exactCustomerScope(readinessCustomerIds, candidate.customer_ids)
        && exactCustomerScope(readinessCustomerIds, gateCustomerIds);
      const validationEvidenceComplete = expectedTargetCount > 0
        && validatedTargets.length === expectedTargetCount;
      evaluation = {
        readiness,
        customer_ids: readinessCustomerIds,
        validated_targets: validatedTargets,
        ready: readiness?.ready === true
          && readiness?.validated === true
          && customerScopeMatches
          && validationEvidenceComplete,
        reason: !customerScopeMatches
          ? 'strategy_readiness_customer_scope_mismatch'
          : !validationEvidenceComplete
            ? 'strategy_validation_evidence_incomplete'
            : (readiness?.reason || 'strategy_conversion_readiness_pending')
      };
      evaluationCache.set(evaluationIdentity, evaluation);
    }
    if (!evaluation.ready) {
      addBlocked(candidate, evaluation.reason, {
        reasons: evaluation.readiness?.reasons || [],
        issues: evaluation.readiness?.issues || []
      });
      continue;
    }
    validatedCandidates.push({
      ...candidate,
      source_record_id: sourceRecordId,
      source_record_fingerprint: sourceRecordFingerprint,
      consent_readiness: consentReadiness,
      validated_scope: validatedScope,
      scope_fingerprint: scopeFingerprint,
      customer_ids: evaluation.customer_ids,
      enabled_events: evaluation.readiness.enabled_events || [],
      validated_targets: evaluation.validated_targets
    });
  }

  const sequelize = dependencies.sequelize || db.sequelize;
  const intakeConfigModel = dependencies.IntakeConfig || IntakeConfig;
  const nowIso = now.toISOString();
  if (validatedCandidates.length === 0) {
    const blocked = Array.from(blockedById.values());
    return {
      status: blocked.length > 0 ? 'blocked' : 'already_reconciled',
      reason: blocked.length > 0 ? 'strategy_readiness_blocked' : 'no_pending_strategy_readiness',
      updated: false,
      idempotent: blocked.length === 0,
      reconciled: 0,
      candidate_ids: candidateIds,
      current_ids: currentIds,
      blocked,
      validate_only: true,
      external_mutation_performed: false,
      google_ads_mutated: false
    };
  }
  return sequelize.transaction(async (transaction) => {
    const sourceRecordIds = listToUniqueArray(validatedCandidates.map((candidate) => candidate.source_record_id))
      .map(Number);
    const lockedSourceRecords = await intakeConfigModel.findAll({
      where: { id: { [Op.in]: sourceRecordIds } },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    const lockedSourceRecordsById = new Map((Array.isArray(lockedSourceRecords) ? lockedSourceRecords : [])
      .map((record) => [parseInteger(record?.id), record]));
    const persistenceCandidates = [];
    for (const candidate of validatedCandidates) {
      const lockedSourceRecord = lockedSourceRecordsById.get(candidate.source_record_id) || null;
      if (
        !lockedSourceRecord
        || intakeRecordReadinessFingerprint(lockedSourceRecord) !== candidate.source_record_fingerprint
      ) {
        addBlocked(candidate, 'measurement_scope_changed_during_validation');
        continue;
      }
      persistenceCandidates.push(candidate);
    }
    const persistenceCandidateIds = persistenceCandidates.map((candidate) => candidate.id);
    const lockedRows = persistenceCandidateIds.length > 0
      ? await campaignRequestModel.findAll({
          where: { id: { [Op.in]: persistenceCandidateIds } },
          transaction,
          lock: transaction.LOCK.UPDATE
        })
      : [];
    const candidatesById = new Map(persistenceCandidates.map((candidate) => [candidate.id, candidate]));
    let reconciled = 0;
    const reconciledIds = [];
    for (const row of Array.isArray(lockedRows) ? lockedRows : []) {
      const id = parseInteger(row?.id);
      const candidate = candidatesById.get(id) || null;
      if (!candidate || !isPropdentalConnectOnlyGoogleReadinessCandidate(row)) {
        if (candidate) addBlocked(candidate, 'strategy_changed_during_validation');
        continue;
      }
      const payload = readCampaignRequestStrategyPayload(row);
      const lockedCandidate = buildPropdentalStrategyReadinessCandidate(row);
      if (
        lockedCandidate.invalid_reason
        || lockedCandidate.strategy_fingerprint !== candidate.strategy_fingerprint
        || !exactCustomerScope(lockedCandidate.customer_ids, candidate.customer_ids)
      ) {
        addBlocked(candidate, lockedCandidate.invalid_reason || 'strategy_changed_during_validation');
        continue;
      }
      const evidence = {
        reconciliation_key: reconciliationKey,
        customer_ids: candidate.customer_ids,
        consent_readiness: candidate.consent_readiness,
        validated_scope: candidate.validated_scope,
        scope_fingerprint: candidate.scope_fingerprint,
        strategy_fingerprint: candidate.strategy_fingerprint
      };
      if (strategyReadinessSnapshotIsCurrent(payload, evidence, now)) {
        currentIds.push(candidate.id);
        continue;
      }
      const previousActivationReadiness = payload.activation_readiness || null;
      await row.update({
        solicitud: {
          ...payload,
          activation_readiness: {
            ready: true,
            validated: true,
            validate_only: true,
            validated_at: nowIso,
            enabled_events: candidate.enabled_events,
            customer_ids: candidate.customer_ids,
            consent_readiness: candidate.consent_readiness,
            reconciliation_key: reconciliationKey,
            reconciled_by: 'google_data_manager_diagnostics_job',
            validated_scope: candidate.validated_scope,
            scope_fingerprint: candidate.scope_fingerprint,
            strategy_fingerprint: candidate.strategy_fingerprint,
            validated_targets: candidate.validated_targets
          },
          activation_readiness_reconciliation: {
            source: 'google_data_manager_diagnostics_job',
            reconciliation_key: reconciliationKey,
            reconciled_at: nowIso,
            previous_activation_readiness: previousActivationReadiness
          }
        }
      }, { transaction });
      reconciled += 1;
      reconciledIds.push(parseInteger(row.id));
    }
    const blocked = Array.from(blockedById.values());
    return {
      status: reconciled > 0
        ? (blocked.length > 0 ? 'partially_reconciled' : 'reconciled')
        : (blocked.length > 0 ? 'blocked' : 'already_reconciled'),
      updated: reconciled > 0,
      idempotent: reconciled === 0 && blocked.length === 0,
      reconciled,
      candidate_ids: candidateIds,
      reconciled_ids: reconciledIds.filter(Boolean),
      current_ids: listToUniqueArray(currentIds).map(Number),
      blocked,
      reconciliation_key: reconciliationKey,
      validate_only: true,
      external_mutation_performed: false,
      google_ads_mutated: false
    };
  });
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
  const marketingState = await resolveEffectiveMarketingState({
    clinicIdRaw: scope.clinic_id,
    groupIdRaw: scope.group_id,
    assignmentScopeRaw: scope.assignment_scope
  });
  const webMeasurementState = resolveWebMeasurementMarketingState(scope, marketingState);
  const intakeRecord = webMeasurementState.record;
  const intakeGoogleAds = normalizeGoogleAdsConfig(marketingState.tracking.google_ads || {});
  const intakeMetaAds = normalizeMetaAdsConfig(marketingState.tracking.meta_ads || {});
  const consentReadiness = assessConsentMeasurementReadiness(webMeasurementState.marketingState);

  let googleConnected = false;
  let googleReason = null;
  let hasAdsScope = false;
  let hasDataManagerScope = false;
  let googleAccounts = marketingState.google.available_accounts || [];
  let selectedCustomerId = marketingState.google.effective_assets?.account?.customer_id || intakeGoogleAds.customer_id || null;

  if (!selectedCustomerId && googleAccounts.length > 0) {
    selectedCustomerId = googleAccounts[0].customer_id;
  }

  if (googleAccounts.length > 0) {
    googleAccounts = await enrichGoogleAdsAccountsWithConversionTracking({
      userId,
      scope,
      accounts: googleAccounts
    });
  }
  const selectedGoogleAccount = googleAccounts.find((account) => (
    normalizeCustomerId(account?.customer_id || '') === normalizeCustomerId(selectedCustomerId || '')
  )) || googleAccounts[0] || null;
  const googleAccessSummary = summarizeGoogleMappedAccountAccess(
    selectedGoogleAccount ? [selectedGoogleAccount] : []
  );
  googleConnected = googleAccessSummary.connected;
  hasAdsScope = googleAccessSummary.has_ads_scope;
  hasDataManagerScope = googleAccessSummary.has_data_manager_scope;
  googleReason = googleConnected
    ? null
    : (googleAccessSummary.reasons[0] || (googleAccounts.length ? 'connection_unavailable' : 'no_connection'));
  const googleConnectionSource = selectedGoogleAccount?.connection_source
    || (selectedGoogleAccount?.assignment_origin ? `mapping_${selectedGoogleAccount.assignment_origin}` : null);

  let internalEnhancedConversionActivation = {
    applicable: false,
    automatic: true,
    trigger: 'google_data_manager_diagnostics_job',
    bootstrap_mutates_state: false,
    status: 'not_applicable',
    ready: false,
    issues: [],
    ad_personalization_capability: {
      applicable: false,
      automatic: true,
      independent_of_enhanced_conversion_gate: true,
      status: 'not_applicable',
      enabled: false,
      consent_source: null,
      grants_consent: false
    }
  };
  if (
    scope.assignment_scope === 'group'
    && Number(scope.group_id) === ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID
  ) {
    const bootstrapActivationTargets = collectEnhancedConversionActivationTargets(
      asPlainObject(intakeRecord?.config).google_ads || intakeGoogleAds
    );
    const bootstrapActivationAccess = summarizeGoogleMappedAccountAccess(
      googleAccounts,
      bootstrapActivationTargets.customer_ids
    );
    const preview = buildEnhancedConversionActivationPlan({
      scope,
      intakeRecord,
      consentReadiness,
      scopedAccounts: googleAccounts,
      enrichedAccounts: googleAccounts,
      dataManagerReady: Boolean(
        bootstrapActivationAccess.all_connected
        && bootstrapActivationAccess.has_ads_scope
        && bootstrapActivationAccess.has_data_manager_scope
        && (process.env.GOOGLE_DATA_MANAGER_QUOTA_PROJECT || process.env.GOOGLE_CLOUD_PROJECT)
      ),
      requestBody: internalAdvertiserAuthorizationRequest(),
      actorUserId: null,
      activationSource: 'google_data_manager_diagnostics_job'
    });
    const applied = isEnhancedConversionActivationApplied(
      intakeRecord?.config,
      preview.summary.reconciliation_key
    );
    const currentFeatures = asPlainObject(asPlainObject(intakeRecord?.config).features);
    const capabilityEnabled = currentFeatures.ad_personalization_enabled === true
      && currentFeatures.ad_personalization_consent_source === 'visitor_choice';
    const capabilityAudited = isVisitorChoicePersonalizationCapabilityApplied(
      intakeRecord?.config,
      intakeRecord,
    );
    internalEnhancedConversionActivation = {
      applicable: true,
      automatic: true,
      trigger: 'google_data_manager_diagnostics_job',
      bootstrap_mutates_state: false,
      status: applied ? 'active' : (preview.ready ? 'pending_reconciliation' : 'blocked'),
      ready: preview.ready,
      idempotent: applied,
      reconciliation_key: preview.summary.reconciliation_key,
      customer_ids: preview.targets.customer_ids,
      event_names: preview.targets.event_names,
      issues: preview.issues,
      ad_personalization_capability: {
        applicable: true,
        automatic: true,
        independent_of_enhanced_conversion_gate: true,
        status: capabilityAudited ? 'active' : 'pending_reconciliation',
        enabled: capabilityEnabled,
        audited: capabilityAudited,
        consent_source: capabilityEnabled ? 'visitor_choice' : null,
        grants_consent: false
      }
    };
  }

  let metaConnected = false;
  let metaReason = null;
  const metaAssets = marketingState.meta.available_assets || {
    ad_accounts: [],
    facebook_pages: [],
    instagram_business: []
  };
  const selectedMetaAdAccount = marketingState.meta.effective_assets?.ad_account
    || metaAssets.ad_accounts[0]
    || null;
  const metaMappedAccess = selectedMetaAdAccount?.ad_account_id
    ? await resolveMetaCampaignMappingAccess({ scope, adAccountId: selectedMetaAdAccount.ad_account_id })
    : null;
  metaConnected = Boolean(metaMappedAccess?.connection);
  metaReason = metaConnected
    ? null
    : (metaMappedAccess?.reason || (metaAssets.ad_accounts.length ? 'connection_unavailable' : 'no_connection'));
  const metaConnectionSource = selectedMetaAdAccount?.assignment_origin
    ? `mapping_${selectedMetaAdAccount.assignment_origin}`
    : null;

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
      group_web_assignment_mode: scope.group?.web_assignment_mode || null,
      web_measurement_scope: webMeasurementState.assignment_scope,
      web_measurement_source: webMeasurementState.source,
      web_measurement_group_id: webMeasurementState.assignment_scope === 'group'
        ? webMeasurementState.group_id
        : null
    },
    modes: [CAMPAIGN_MODES.MEASURE, CAMPAIGN_MODES.IMPROVE, CAMPAIGN_MODES.AUTOPILOT],
    legacy_modes: ['managed_self'],
    active_mode: activeMode,
    consent_readiness: consentReadiness,
    google_ads: {
      connected: googleConnected,
      reason: googleReason,
      connected_via: mapConnectionSourceToOrigin(googleConnectionSource),
      connection_source: googleConnectionSource,
      source_scope_name: mapConnectionSourceToOrigin(googleConnectionSource) === 'group'
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
      internal_enhanced_conversion_activation: internalEnhancedConversionActivation,
      capabilities: buildGoogleAdsCapabilities(
        googleConnected,
        hasAdsScope,
        hasDataManagerScope,
        googleAccounts
      )
    },
    meta_ads: {
      connected: metaConnected,
      reason: metaReason,
      connected_via: mapConnectionSourceToOrigin(metaConnectionSource),
      connection_source: metaConnectionSource,
      source_scope_name: mapConnectionSourceToOrigin(metaConnectionSource) === 'group'
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
    }).map((item) => ({
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
      googleCampaigns = mergeCurrentGoogleCampaignInventory({
        campaigns: googleCampaigns,
        inventoryRows,
        reviewedByCampaign,
        googleAccountMap,
        scope,
        activeOnly,
      });
    } else {
      googleCampaigns = googleCampaigns.filter((item) => !activeOnly || isGoogleCampaignActive(item.status));
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
  const {
    accountMap: metaAccountMap,
    authorizationIssues: metaMappingAuthorizationIssues
  } = buildMetaAccountConnectionMap(metaAssets, scope);
  let metaAuthorizationIssues = metaMappingAuthorizationIssues.slice();

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

    const enrichedByMapping = await enrichMetaCampaignsWithMappedConnections({
      campaigns: metaCampaigns,
      metaAccountMap,
      campaignAdRows
    });
    metaCampaigns = enrichedByMapping.campaigns;
    metaAuthorizationIssues = metaAuthorizationIssues.concat(enrichedByMapping.authorizationIssues);
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
        campaigns: metaCampaigns,
        authorization_issues: metaAuthorizationIssues
      }
    }
  });
});

exports.gateEnhancedConversionsActivation = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const requestedGroupId = parseInteger(req.body?.group_id);
  const requestedScope = String(req.body?.assignment_scope || 'group').trim().toLowerCase();
  if (
    requestedScope !== 'group'
    || requestedGroupId !== ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID
  ) {
    return res.status(403).json({
      success: false,
      error: 'enhanced_conversion_scope_not_allowlisted',
      message: 'Este gate solo está habilitado para el grupo Propdental autorizado.'
    });
  }

  const scope = await resolveScopeFromInput({
    clinicIdRaw: null,
    groupIdRaw: requestedGroupId,
    assignmentScopeRaw: 'group'
  });
  if (!(await requireMarketingClinicScope(req, res, scope.clinic_ids, 'write'))) return;

  const marketingState = await resolveEffectiveMarketingState({
    clinicIdRaw: null,
    groupIdRaw: requestedGroupId,
    assignmentScopeRaw: 'group'
  });
  const intakeRecord = marketingState.records.groupRecord || null;
  const consentReadiness = assessConsentMeasurementReadiness(marketingState);
  const scopedAccounts = marketingState.google.available_accounts || [];
  let enrichedAccounts = scopedAccounts.map((account) => ({
    ...account,
    conversion_tracking_settings_available: false
  }));
  let dataManagerReady = false;

  const quotaProjectConfigured = Boolean(
    process.env.GOOGLE_DATA_MANAGER_QUOTA_PROJECT
      || process.env.GOOGLE_CLOUD_PROJECT
  );
  enrichedAccounts = await enrichGoogleAdsAccountsWithConversionTracking({
    userId,
    scope,
    accounts: scopedAccounts
  });
  const activationTargets = collectEnhancedConversionActivationTargets(
    asPlainObject(intakeRecord?.config).google_ads
  );
  const activationAccess = summarizeGoogleMappedAccountAccess(
    enrichedAccounts,
    activationTargets.customer_ids
  );
  dataManagerReady = Boolean(
    quotaProjectConfigured
    && activationAccess.all_connected
    && activationAccess.has_ads_scope
    && activationAccess.has_data_manager_scope
  );

  const now = new Date();
  const plan = buildEnhancedConversionActivationPlan({
    scope,
    intakeRecord,
    consentReadiness,
    scopedAccounts,
    enrichedAccounts,
    dataManagerReady,
    requestBody: req.body,
    actorUserId: userId,
    now
  });
  if (!plan.ready) {
    return res.status(409).json({
      success: false,
      error: 'enhanced_conversion_activation_gate_blocked',
      message: 'Conversiones mejoradas siguen bloqueadas. No se ha modificado IntakeConfig ni Google Ads.',
      dry_run: true,
      ready: false,
      issues: plan.issues,
      plan: plan.summary,
      external_mutation_performed: false,
      intake_config_updated: false
    });
  }

  const applyRequested = req.body?.apply === true;
  if (!applyRequested) {
    return res.json({
      success: true,
      dry_run: true,
      ready: true,
      plan: plan.summary,
      external_mutation_performed: false,
      intake_config_updated: false,
      next_action: 'Repite con apply=true y confirm_external_mutation=true cuando quieras habilitar el runtime.'
    });
  }
  if (req.body?.confirm_external_mutation !== true) {
    return res.status(409).json({
      success: false,
      error: 'activation_confirmation_required',
      message: 'apply=true requiere confirm_external_mutation=true.',
      dry_run: true,
      ready: true,
      plan: plan.summary,
      external_mutation_performed: false,
      intake_config_updated: false
    });
  }

  const preflightUpdatedAt = intakeRecord?.updated_at || intakeRecord?.updatedAt || null;
  await db.sequelize.transaction(async (transaction) => {
    const locked = await IntakeConfig.findOne({
      where: {
        group_id: ENHANCED_CONVERSION_PROPDENTAL_GROUP_ID,
        assignment_scope: 'group'
      },
      transaction,
      lock: transaction.LOCK.UPDATE
    });
    if (!locked) {
      const error = new Error('IntakeConfig de Propdental no encontrado');
      error.code = 'INTAKE_CONFIG_MISSING';
      error.httpStatus = 409;
      throw error;
    }
    const lockedUpdatedAt = locked.updated_at || locked.updatedAt || null;
    if (
      preflightUpdatedAt
      && lockedUpdatedAt
      && new Date(preflightUpdatedAt).getTime() !== new Date(lockedUpdatedAt).getTime()
    ) {
      const error = new Error('IntakeConfig cambió durante la comprobación; vuelve a ejecutar el preview');
      error.code = 'INTAKE_CONFIG_CHANGED_DURING_GATE';
      error.httpStatus = 409;
      throw error;
    }
    const authorizationIssues = validateEnhancedConversionActivationAllowlist(
      plan.nextConfig.google_ads?.enhanced_conversions,
      now
    );
    if (authorizationIssues.length > 0) {
      const error = new Error('La allowlist de autorizaciones no superó la validación final');
      error.code = 'ENHANCED_CONVERSION_AUTHORIZATION_INVALID';
      error.httpStatus = 409;
      error.authorizationIssues = authorizationIssues;
      throw error;
    }
    await locked.update({ config: plan.nextConfig }, { transaction });
  });

  return res.json({
    success: true,
    dry_run: false,
    ready: true,
    activated: true,
    plan: plan.summary,
    external_mutation_performed: false,
    intake_config_updated: true,
    google_ads_mutated: false
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
    suggested_mapping: result.suggested_mapping,
    clinicaclick_mapping: result.clinicaclick_mapping
  });
});

exports.validateGoogleDataManagerConversion = asyncHandler(async (req, res) => {
  const userId = getUserId(req);
  if (!userId) return res.status(401).json({ success: false, error: 'unauthenticated' });

  const customerId = normalizeCustomerId(req.body?.customer_id || '');
  const conversionActionId = String(req.body?.conversion_action_id || '').trim();
  const eventKey = String(req.body?.event || '').trim().toLowerCase() || null;
  if (!customerId || !/^\d+$/.test(conversionActionId)) {
    return res.status(400).json({ success: false, error: 'customer_and_conversion_action_required' });
  }
  if (eventKey && !VALID_EVENTS.includes(eventKey)) {
    return res.status(400).json({ success: false, error: 'invalid_conversion_event' });
  }
  if (!req.body?.clinic_id && !req.body?.group_id) {
    return res.status(400).json({ success: false, error: 'scope_required' });
  }

  const scope = await resolveScopeFromInput({
    clinicIdRaw: req.body?.clinic_id,
    groupIdRaw: req.body?.group_id,
    assignmentScopeRaw: req.body?.assignment_scope
  });
  if (!(await requireMarketingClinicScope(req, res, scope.clinic_ids, 'read'))) return;

  let runtime;
  try {
    runtime = await resolveScopedGoogleAdsRuntime({
      userId,
      clinicId: scope.clinic_id,
      groupId: scope.group_id,
      assignmentScope: scope.assignment_scope,
      customerId,
      requiredScopes: [GOOGLE_ADS_SCOPE, GOOGLE_DATA_MANAGER_SCOPE]
    });
  } catch (error) {
    return res.status(error.httpStatus || 409).json({
      success: false,
      error: String(error.code || 'scoped_google_connection_error').toLowerCase(),
      message: error.message,
      missing_scopes: error.missingScopes || []
    });
  }

  const listed = await listConversionActionsInternal({
    accessToken: runtime.accessToken,
    customerId,
    loginCustomerId: runtime.loginCustomerId
  });
  const canonicalMapping = listed.clinicaclick_mapping || {};
  const canonicalEvent = eventKey || VALID_EVENTS.find((key) => canonicalMapping[key] === conversionActionId) || null;
  if (!canonicalEvent || canonicalMapping[canonicalEvent] !== conversionActionId) {
    return res.status(409).json({
      success: false,
      validated: false,
      validate_only: true,
      error: 'canonical_conversion_action_required',
      message: 'La validación solo admite una acción canónica de ClinicaClick para este evento.'
    });
  }
  const canonicalAction = listed.actions.find((action) => String(action?.id || '') === conversionActionId);
  if (String(canonicalAction?.status || '').toUpperCase() !== 'ENABLED') {
    return res.status(409).json({
      success: false,
      validated: false,
      validate_only: true,
      error: 'canonical_conversion_action_not_enabled',
      message: 'La acción canónica de ClinicaClick no está habilitada en Google Ads.'
    });
  }
  if (String(canonicalAction?.counting_type || '').toUpperCase() !== 'MANY_PER_CLICK') {
    return res.status(409).json({
      success: false,
      validated: false,
      validate_only: true,
      error: 'braid_incompatible_counting_type',
      message: 'La acción canónica usa un recuento incompatible con gbraid/wbraid. Debe revisarse antes de validar Data Manager.',
      customer_id: customerId,
      event: canonicalEvent,
      conversion_action_id: conversionActionId,
      conversion_action_name: canonicalAction?.name || null,
      counting_type: canonicalAction?.counting_type || null,
      required_counting_type: 'MANY_PER_CLICK'
    });
  }
  if (canonicalAction?.primary_for_goal !== false) {
    return res.status(409).json({
      success: false,
      validated: false,
      validate_only: true,
      error: 'canonical_action_primary_for_goal',
      message: 'La acción canónica sigue siendo primaria. Debe pasar a secundaria antes de validar para no alterar pujas del cliente.',
      customer_id: customerId,
      event: canonicalEvent,
      conversion_action_id: conversionActionId,
      conversion_action_name: canonicalAction?.name || null,
      primary_for_goal: canonicalAction?.primary_for_goal
    });
  }

  try {
    await uploadGoogleDataManagerConversion({
      customerId,
      conversionAction: `customers/${customerId}/conversionActions/${conversionActionId}`,
      conversionDateTime: new Date(),
      externalId: `cc-dry-run-${Date.now()}`,
      // Placeholder usado por la documentación oficial para validar el
      // contrato sin PII ni un click real. validateOnly impide la ingestión.
      gclid: 'GCLID_1',
      value: 0,
      currency: 'EUR',
      eventName: canonicalEvent,
      eventSource: 'WEB',
      accessToken: runtime.accessToken,
      loginCustomerId: runtime.loginCustomerId,
      validateOnly: true
    });
  } catch (error) {
    const providerError = error?.response?.data?.error || null;
    return res.status(Number(error?.response?.status) || 409).json({
      success: false,
      validated: false,
      validate_only: true,
      error: String(providerError?.status || error?.code || 'data_manager_validation_failed').toLowerCase(),
      message: providerError?.message || error.message || 'Google no pudo validar la configuración de Data Manager',
      details: Array.isArray(providerError?.details) ? providerError.details : []
    });
  }

  return res.json({
    success: true,
    validated: true,
    validate_only: true,
    customer_id: customerId,
    conversion_action_id: conversionActionId,
    event: canonicalEvent,
    message: 'Google validó la estructura y los permisos sin ingerir la conversión.'
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
  const normalizeExisting = req.body?.normalize_existing === true;
  const normalizationValidateOnly = req.body?.validate_only === true;
  if (createMissing && normalizationValidateOnly) {
    return res.status(400).json({
      success: false,
      error: 'validate_only_create_not_supported',
      message: 'La prevalidación sin cambios solo está disponible para ajustar acciones canónicas existentes.'
    });
  }
  if (createMissing && req.body?.confirm_external_mutation !== true) {
    return res.status(409).json({
      success: false,
      error: 'external_mutation_confirmation_required',
      message: 'Confirma explícitamente la creación de acciones canónicas en Google Ads.'
    });
  }
  const events = Array.isArray(req.body?.events) && req.body.events.length
    ? req.body.events.map((e) => String(e || '').trim().toLowerCase())
    : DEFAULT_ENABLED_CONVERSION_EVENTS;

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

  let ensured;
  try {
    ensured = await ensureConversionActionsInternal({
      accessToken: runtime.accessToken,
      customerId,
      loginCustomerId: runtime.loginCustomerId,
      currency,
      events,
      createMissing
    });
  } catch (error) {
    const providerError = error?.response?.data?.error || null;
    return res.status(Number(error?.response?.status) || 409).json({
      success: false,
      error: 'canonical_action_provisioning_failed',
      message: providerError?.message || error.message || 'Google no pudo crear las acciones canónicas de ClinicaClick.',
      details: Array.isArray(providerError?.details) ? providerError.details : []
    });
  }

  let normalization = null;
  let normalized = [];
  let normalizationValidation = null;
  if (normalizeExisting) {
    const expectedActions = listToUniqueArray(events)
      .filter((eventKey) => VALID_EVENTS.includes(eventKey))
      .map((eventKey) => ({
        id: ensured.mapping[eventKey] || null,
        name: EVENT_CATALOG[eventKey].name
      }))
      .filter((action) => !!action.id);
    if (!expectedActions.length) {
      return res.status(409).json({
        success: false,
        error: 'canonical_conversion_action_missing',
        message: 'No hay acciones canónicas verificadas que se puedan ajustar en esta cuenta.'
      });
    }
    const applyNormalization = req.body?.confirm_external_mutation === true && !normalizationValidateOnly;
    try {
      normalization = await normalizeCanonicalGoogleAdsConversions({
        scope: {
          user_id: userId,
          clinic_id: scope.clinic_id,
          group_id: scope.group_id,
          assignment_scope: scope.assignment_scope
        },
        configuredAccounts: [{
          customer_id: customerId,
          expected_actions: expectedActions
        }],
        apply: applyNormalization,
        validateOnly: normalizationValidateOnly,
        confirmExternalMutation: applyNormalization
      });
    } catch (error) {
      return res.status(error.httpStatus || 409).json({
        success: false,
        error: String(error.code || 'canonical_action_normalization_failed').toLowerCase(),
        message: error.message || 'No se pudo preparar el ajuste de acciones canónicas.'
      });
    }
    const accountNormalization = normalization.accounts?.[0] || null;
    const allowedOutcomes = applyNormalization
      ? new Set(['applied', 'unchanged'])
      : normalizationValidateOnly
        ? new Set(['validated', 'unchanged'])
        : new Set(['ready', 'unchanged']);
    if (!accountNormalization || !allowedOutcomes.has(accountNormalization.outcome)) {
      const blocker = accountNormalization?.blockers?.[0]
        || accountNormalization?.plan?.blockers?.[0]
        || accountNormalization?.error
        || null;
      return res.status(409).json({
        success: false,
        error: 'canonical_action_normalization_blocked',
        message: blocker?.message || 'La normalización canónica quedó bloqueada y no se aplicó.',
        normalization
      });
    }
    normalized = (accountNormalization.plan?.actions || [])
      .filter((action) => action?.outcome === 'update_ready')
      .map((action) => ({
        event: action.key || null,
        id: action.id,
        name: action.name,
        previous_counting_type: action.before?.counting_type || null,
        previous_primary_for_goal: action.before?.primary_for_goal ?? null,
        counting_type: 'MANY_PER_CLICK',
        primary_for_goal: false,
        applied: accountNormalization.outcome === 'applied'
      }));
    normalizationValidation = accountNormalization.validation || null;
  }

  if (scope.clinic_id || scope.group_id) {
    await upsertIntakeGoogleAdsForScope(scope, {
      ...ensured.recommended_google_ads_config,
      enabled: true,
      customer_id: customerId
    }, {
      customerId,
      eventKeys: listToUniqueArray(events.filter((eventKey) => VALID_EVENTS.includes(eventKey)))
    });
    await enqueueMeasurementControlPlaneAfterWrite(
      req,
      'marketing:canonical_conversion_actions_ready'
    );
  }

  return res.json({
    success: true,
    customer_id: customerId,
    connection_source: runtime.connectionSource,
    external_mutation_performed: ensured.created.length > 0
      || normalized.some((item) => item.applied === true),
    created: ensured.created,
    existing: ensured.existing,
    normalized,
    normalization_validation: normalizationValidation,
    normalization,
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
  const modeGuard = guardCampaignOnboardingStartMode(mode);
  if (modeGuard) {
    return res.status(modeGuard.http_status).json(modeGuard.body);
  }
  let improvementAuthorization = null;
  try {
    improvementAuthorization = validateImprovementAuthorization(
      mode,
      req.body?.improvement_authorization
    );
    if (improvementAuthorization) {
      improvementAuthorization = {
        ...improvementAuthorization,
        accepted_at: new Date().toISOString(),
        accepted_by_user_id: userId
      };
    }
  } catch (error) {
    return res.status(error.httpStatus || 400).json({
      success: false,
      error: String(error.code || 'improvement_authorization_required').toLowerCase(),
      message: error.message
    });
  }
  const modeContract = buildCampaignModeContract(mode, improvementAuthorization);

  const providers = listToUniqueArray(
    (Array.isArray(req.body?.providers) ? req.body.providers : ['google_ads'])
      .map((p) => String(p || '').trim().toLowerCase())
      .filter((p) => VALID_PROVIDERS.has(p))
  );

  if (!providers.length) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'providers requerido' });
  }
  if (mode === CAMPAIGN_MODES.IMPROVE && !providers.includes('google_ads')) {
    return res.status(409).json({
      success: false,
      error: 'guided_google_ads_required',
      message: 'Mejora necesita al menos una cuenta de Google Ads: por ahora su automatización segura actúa sobre objetivos de conversión de Google. Meta puede seguir conectado para medir, pero no activa este nivel por sí solo.'
    });
  }

  const scope = await resolveScopeFromInput({
    clinicIdRaw: req.body?.clinic_id,
    groupIdRaw: req.body?.group_id,
    assignmentScopeRaw: req.body?.assignment_scope
  });
  if (!(await requireMarketingClinicScope(req, res, scope.clinic_ids, 'write'))) return;
  const previousMode = await resolveActiveModeForScope(scope);
  let modeTransition = null;
  try {
    modeTransition = await assertCampaignModeTransitionSafe({
      scope,
      currentMode: previousMode,
      nextMode: mode,
      confirmation: req.body?.mode_transition,
    });
  } catch (error) {
    return res.status(error.httpStatus || 409).json({
      success: false,
      error: String(error.code || 'campaign_mode_transition_blocked').toLowerCase(),
      message: error.message,
      ...(error.details ? { details: error.details } : {}),
    });
  }
  const marketingState = await resolveEffectiveMarketingState({
    clinicIdRaw: scope.clinic_id,
    groupIdRaw: scope.group_id,
    assignmentScopeRaw: scope.assignment_scope
  });
  // Use the same effective web row exposed by bootstrap. A clinic covered by
  // the shared group website must not turn green in the stepper and then fail
  // activation because this endpoint inspected a different consent record.
  const webMeasurementState = resolveWebMeasurementMarketingState(scope, marketingState);
  const consentReadiness = assessConsentMeasurementReadiness(webMeasurementState.marketingState);
  if (!consentReadiness.ready || !consentReadiness.validated) {
    return res.status(409).json({
      success: false,
      error: 'consent_readiness_pending',
      message: 'La medición de privacidad no está verificada. Comprueba el aviso de cookies y Consent Mode en todos los dominios antes de continuar.',
      reason: consentReadiness.reason || 'consent_readiness_pending',
      reasons: consentReadiness.reasons,
      issues: consentReadiness.issues,
      consent_readiness: consentReadiness,
    });
  }

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

  const steps = ownsCampaignOperations(mode)
    ? [{ key: 'pilot_request', status: 'pending' }]
    : initSteps(providers);
  const initialPayload = {
    kind: 'campaign_onboarding',
    status: 'in_progress',
    current_step: steps[0]?.key || null,
    mode,
    mode_contract: modeContract,
    mode_transition: modeTransition
      ? {
          ...modeTransition,
          confirmed_at: new Date().toISOString(),
          confirmed_by_user_id: userId,
        }
      : null,
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

    if (ownsCampaignOperations(mode)) {
      markStep(steps, 'pilot_request', 'done');
      result.pilot = {
        operation_mode: 'observe',
        funding_status: 'unfunded',
        requires_prepayment: true,
        automatic_conversion_setup: true,
        next_action: 'configure_strategy'
      };
    }

    if (usesExistingAdvertiserCampaigns(mode) && providers.includes('google_ads')) {
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

      const googleMappedAccess = await resolveGoogleCampaignMappingAccess({
        scope,
        customerId: selectedCustomer
      });
      const googleConnection = googleMappedAccess.connection;
      if (!googleMappedAccess.account || !googleConnection) {
        const mappingError = new Error('No existe un único grant Google para la cuenta Ads seleccionada');
        mappingError.code = String(googleMappedAccess.reason || 'GOOGLE_ACCOUNT_MAPPING_UNAVAILABLE').toUpperCase();
        mappingError.httpStatus = 409;
        throw mappingError;
      }
      await ensureGoogleAdsAccess(googleConnection);
      markStep(steps, 'google_connect', 'done');

      markStep(steps, 'google_map_account', 'done', { customer_id: selectedCustomer });

      const autoCreate = req.body?.google_ads?.auto_create_missing_conversions === true
        && req.body?.google_ads?.confirm_external_mutation === true;
      const conversionReadiness = await evaluateGoogleConversionOnboardingReadiness({
        userId,
        scope,
        rawGoogleAdsConfig: marketingState.tracking.google_ads || {},
        fallbackCustomerId: selectedCustomer,
        currency: req.body?.google_ads?.currency || 'EUR',
        createMissing: autoCreate,
        consentReadiness
      });

      if (!conversionReadiness.ready || !conversionReadiness.validated) {
        markStep(steps, 'conversion_actions', 'pending', {
          reason: conversionReadiness.reason || 'conversion_readiness_pending',
          reasons: conversionReadiness.reasons,
          readiness: {
            ready: false,
            validated: false,
            enabled_events: conversionReadiness.enabled_events,
            customer_ids: conversionReadiness.customer_ids,
            issues: conversionReadiness.issues,
            validations_by_target: conversionReadiness.validations_by_target
          }
        });
        const pendingPayload = {
          ...initialPayload,
          status: 'pending',
          current_step: 'conversion_actions',
          steps,
          result: {
            google_ads: {
              customer_id: selectedCustomer,
              readiness: conversionReadiness
            }
          }
        };
        await request.update({
          estado: 'en_creacion',
          solicitud: pendingPayload
        });
        return res.status(409).json({
          success: false,
          error: 'conversion_readiness_pending',
          message: 'Las conversiones de ClinicaClick siguen pendientes y la campaña no se puede activar todavía.',
          reason: conversionReadiness.reason || 'conversion_readiness_pending',
          reasons: conversionReadiness.reasons,
          issues: conversionReadiness.issues,
          onboarding_id: request.id,
          status: 'pending',
          current_step: 'conversion_actions',
          steps
        });
      }

      markStep(steps, 'conversion_actions', 'done', {
        readiness: {
          ready: true,
          validated: true,
          validate_only: true,
          enabled_events: conversionReadiness.enabled_events,
          customer_ids: conversionReadiness.customer_ids,
          validations_by_target: conversionReadiness.validations_by_target
        }
      });

      const mergedGoogleAds = conversionReadiness.canonical_google_ads_config;
      await upsertIntakeGoogleAdsForScope(scope, mergedGoogleAds);
      markStep(steps, 'persist_intake_config', 'done');

      result.google_ads = {
        customer_id: selectedCustomer,
        mappings_by_customer: conversionReadiness.mappings_by_customer,
        created_actions: conversionReadiness.created_actions,
        readiness: {
          ready: true,
          validated: true,
          validate_only: true,
          enabled_events: conversionReadiness.enabled_events,
          customer_ids: conversionReadiness.customer_ids
        }
      };
    }

    if (usesExistingAdvertiserCampaigns(mode) && providers.includes('meta_ads')) {
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

      const metaMappedAccess = await resolveMetaCampaignMappingAccess({
        scope,
        adAccountId: selectedMetaAccount.ad_account_id
      });
      const metaConnection = metaMappedAccess.connection;
      if (!metaMappedAccess.asset || !metaConnection) {
        const mappingError = new Error('No existe un único grant Meta válido para la cuenta seleccionada');
        mappingError.code = String(metaMappedAccess.reason || 'META_ACCOUNT_MAPPING_UNAVAILABLE').toUpperCase();
        mappingError.httpStatus = 409;
        throw mappingError;
      }
      markStep(steps, 'meta_connect', 'done');

      const requestedPixelId = String(req.body?.meta_ads?.pixel_id || '').trim() || null;
      if (requestedPixelId) {
        const scopedPixels = await listMetaPixelsForScopeAdAccount({
          scope,
          adAccountId: selectedMetaAccount.ad_account_id,
          connectionId: metaConnection.id
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
        connection_id: metaConnection.id,
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
      mode_contract: modeContract,
      last_onboarding_id: request.id,
      last_onboarding_at: new Date().toISOString()
    });
    await enqueueMeasurementControlPlaneAfterWrite(
      req,
      'marketing:campaign_onboarding_completed'
    );

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
      error: status >= 400 && status < 500
        ? String(err.code || 'campaign_onboarding_conflict').toLowerCase()
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
  const inventoryIndex = await loadCurrentExternalCampaignInventoryIndex(strategyRows.map((row) => (
    row?.solicitud && typeof row.solicitud === 'object' ? row.solicitud : {}
  )));
  const strategyMap = new Map();
  for (const row of strategyRows) {
    const key = row.campaign_id || row.id;
    if (!strategyMap.has(key)) {
      strategyMap.set(key, []);
    }
    strategyMap.get(key).push(row);
  }

  const items = Array.from(strategyMap.values())
    .map((rows) => buildStrategyItemFromRows(rows, campaignsById, inventoryIndex))
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

  const payload = rows[0]?.solicitud && typeof rows[0].solicitud === 'object' ? rows[0].solicitud : {};
  const inventoryIndex = await loadCurrentExternalCampaignInventoryIndex([payload]);
  const campaignsById = await loadCampaignsByIds(rows.map((row) => row.campaign_id));
  const strategy = buildStrategyItemFromRows(rows, campaignsById, inventoryIndex);
  if (!strategy) {
    return res.status(404).json({ success: false, error: 'not_found', message: 'Estrategia no encontrada' });
  }

  strategy.metrics = await buildLiveStrategyMetrics(
    rows,
    strategy.campaign_id ? campaignsById.get(strategy.campaign_id) || null : null,
    payload
  );
  const scope = extractStrategyScopeFromPayload(payload, rows);
  const liveExternalMetrics = await loadCurrentExternalCampaignMetricsIndex({ scope, payload });
  const liveLeadMetrics = await loadCurrentLeadAttributionMetricsIndex({ scope, payload });
  strategy.external_targets = overlayExternalTargetsWithInventory(
    hydrateExternalTargetsWithMetrics(payload.external_targets, liveExternalMetrics),
    inventoryIndex
  );
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
  const leadAttribution = await loadCurrentLeadAttributionMetrics({
    scope,
    payload,
    startDate: timeframe.start,
    endDate: timeframe.end,
    timeZone: CAMPAIGN_REPORTING_TIME_ZONE
  });
  const metricContract = buildCampaignAnalysisMetricContract({
    provider: requestedIdentity.provider,
    campaignRef,
    rows: rowsOut,
    leadAttribution
  });

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
    ...metricContract,
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
  const effectiveMode = VALID_MODES.has(currentMode) ? currentMode : CAMPAIGN_MODES.MEASURE;
  const objectiveId = String(currentPayload.objective_id || '').trim().toLowerCase();
  const promotionType = String(req.body?.promotion_type || currentPayload.promotion_type || '').trim().toLowerCase() === 'generic'
    ? 'generic'
    : 'treatment';

  const treatments = normalizeStrategyTreatments(req.body?.treatments ?? currentPayload.treatments);
  const externalTargets = usesExistingAdvertiserCampaigns(effectiveMode)
    ? normalizeExternalTargets(req.body?.external_targets ?? currentPayload.external_targets)
    : [];
  const targetDestinations = usesExistingAdvertiserCampaigns(effectiveMode)
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
  const budgetMonthly = !ownsCampaignOperations(effectiveMode)
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
  const addonCalls = ownsCampaignOperations(effectiveMode)
    ? req.body?.addon_calls === true
    : false;
  const targetClinicIds = clinicIdsFromStrategyRows(rows);

  if (promotionType !== 'generic' && !treatments.length) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'Selecciona al menos un tratamiento' });
  }
  if (ownsCampaignOperations(effectiveMode) && (!Number.isFinite(budgetMonthly) || budgetMonthly <= 0)) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'budget_monthly debe ser mayor que 0' });
  }
  if (!channels.length && ownsCampaignOperations(effectiveMode)) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'Selecciona al menos un canal' });
  }
  if (ownsCampaignOperations(effectiveMode) && !channels.some((item) => ['google_ads', 'meta_ads'].includes(item.channel) && item.enabled !== false)) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'Piloto automático requiere Google Ads o Meta Ads' });
  }

  if (usesExistingAdvertiserCampaigns(effectiveMode)) {
    const treatmentIds = new Set(treatments.map((item) => item.id));
    const targetKeys = new Set();
    const assignedCampaignKeys = new Set();
    const totalAssignedCampaigns = externalTargets.reduce((sum, target) => sum + target.campaigns.length, 0);

    if (totalAssignedCampaigns === 0) {
      return res.status(400).json({
        success: false,
        error: 'validation_error',
        message: `Vincula al menos una campaña externa para continuar con ${effectiveMode === CAMPAIGN_MODES.IMPROVE ? 'Mejora' : 'Mide y entiende'}.`
      });
    }
    if (
      effectiveMode === CAMPAIGN_MODES.IMPROVE
      && !externalTargetsHaveProvider(externalTargets, 'google_ads')
    ) {
      return res.status(409).json({
        success: false,
        error: 'guided_google_ads_required',
        message: 'Mejora necesita al menos una campaña Google Search o Performance Max vinculada. Una estrategia solo Meta puede usar Mide y entiende.'
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
      if (destinationItem.uses_web === true) {
        const validatedDestination = stableHttpsDestination(destinationItem.confirmed_url);
        if (!validatedDestination.valid) {
          return res.status(400).json({
            success: false,
            error: 'unstable_campaign_destination',
            message: 'El destino web debe ser una URL HTTPS pública y estable, sin credenciales, fragmentos ni parámetros temporales.',
            reason: validatedDestination.reason
          });
        }
        destinationItem.confirmed_url = validatedDestination.url;
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

  if (effectiveMode === CAMPAIGN_MODES.IMPROVE && representative.campaign_id) {
    const existingPolicy = await db.CampaignOptimizationPolicy.findOne({
      where: { strategyId: representative.campaign_id }
    });
    if (existingPolicy) {
      const { assertGuidedPolicyPayloadCompatible } = require('../services/guidedCampaignOptimizationPolicy.service');
      assertGuidedPolicyPayloadCompatible(existingPolicy, {
        ...currentPayload,
        external_targets: externalTargets,
      });
    }
  }

  // Editing strategy details must never be an activation shortcut. In
  // particular, an external-campaign draft stays a draft until the explicit status
  // transition runs the Google/Data Manager readiness gate.
  const currentStatus = normalizeStrategyStatus(currentPayload.status || representative.estado);
  const campaignName = buildStrategyName({
    objectiveId,
    treatments,
    clinicCount: targetClinicIds.length
  });
  const dominantType = channels.length > 0 ? pickLegacyCampaignTypeFromChannels(channels) : 'web_snippet';

  await db.sequelize.transaction(async (transaction) => {
    if (representative.campaign_id) {
      await Campaign.update({
        nombre: campaignName,
        tipo: dominantType,
        presupuesto: budgetMonthly,
        gestionada: ownsCampaignOperations(effectiveMode),
        activa: currentStatus === 'active'
      }, {
        where: { id: representative.campaign_id },
        transaction,
      });
    }

    for (const row of rows) {
      const rowPayload = row?.solicitud && typeof row.solicitud === 'object' ? row.solicitud : {};
      const nextPayload = {
        ...rowPayload,
        status: currentStatus,
        objective_id: objectiveId,
        mode_contract: buildCampaignModeContract(effectiveMode, currentPayload.mode_contract?.authorization),
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
        where: { id: row.id },
        transaction,
      });
    }
    if (effectiveMode === CAMPAIGN_MODES.IMPROVE && representative.campaign_id) {
      const { syncGuidedPolicyStrategyStatus } = require('../services/guidedCampaignOptimizationPolicy.service');
      await syncGuidedPolicyStrategyStatus({
        strategyId: representative.campaign_id,
        strategyStatus: currentStatus,
        transaction,
      });
    }
  });

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
  const strategyPayloadForTransition = rows[0]?.solicitud && typeof rows[0].solicitud === 'object'
    ? rows[0].solicitud
    : {};
  if (
    strategy?.mode === CAMPAIGN_MODES.IMPROVE
    && nextStatus === 'active'
    && !strategyPayloadUsesGoogleAds(strategyPayloadForTransition)
  ) {
    return res.status(409).json({
      success: false,
      error: 'guided_google_ads_required',
      message: 'Mejora no puede activarse con una estrategia solo Meta. Añade una campaña Google compatible o usa Mide y entiende.'
    });
  }
  if (ownsCampaignOperations(strategy?.mode) && nextStatus === 'active') {
    return res.status(409).json({
      success: false,
      error: 'managed_launch_requires_admin_gate',
      message: 'Piloto automático solo puede activarse desde Operación de campañas tras confirmar prepago, tracking y revisión.'
    });
  }

  let activationReadiness = null;
  if (usesExistingAdvertiserCampaigns(strategy?.mode) && nextStatus === 'active') {
    const strategyPayload = rows[0]?.solicitud && typeof rows[0].solicitud === 'object'
      ? rows[0].solicitud
      : {};
    const strategyScope = extractStrategyScopeFromPayload(strategyPayload, rows);
    const marketingState = await resolveEffectiveMarketingState({
      clinicIdRaw: strategyScope.clinic_id,
      groupIdRaw: strategyScope.group_id,
      assignmentScopeRaw: strategyScope.assignment_scope
    });
    const consentReadiness = assessConsentMeasurementReadiness(marketingState);
    if (!consentReadiness.ready || !consentReadiness.validated) {
      return res.status(409).json({
        success: false,
        error: 'consent_readiness_pending',
        message: 'La estrategia sigue en borrador: verifica el aviso de cookies y Consent Mode en todos los dominios antes de activarla.',
        reason: consentReadiness.reason || 'consent_readiness_pending',
        reasons: consentReadiness.reasons,
        issues: consentReadiness.issues,
        consent_readiness: consentReadiness,
        status: 'draft'
      });
    }
    activationReadiness = {
      ready: true,
      validated: true,
      validate_only: true,
      validated_at: new Date().toISOString(),
      consent_readiness: consentReadiness,
      enabled_events: [],
      customer_ids: []
    };

    if (strategyPayloadUsesGoogleAds(strategyPayload)) {
      const fallbackCustomerId = marketingState.google.effective_assets?.account?.customer_id
        || normalizeGoogleAdsConfig(marketingState.tracking.google_ads || {}).customer_id
        || marketingState.google.available_accounts?.[0]?.customer_id
        || null;
      const readiness = await evaluateGoogleConversionOnboardingReadiness({
        userId,
        scope: strategyScope,
        rawGoogleAdsConfig: marketingState.tracking.google_ads || {},
        fallbackCustomerId,
        currency: normalizeGoogleAdsConfig(marketingState.tracking.google_ads || {}).currency || 'EUR',
        createMissing: false,
        consentReadiness
      });
      if (!readiness.ready || !readiness.validated) {
        return res.status(409).json({
          success: false,
          error: 'conversion_readiness_pending',
          message: 'La estrategia sigue en borrador: completa y valida las conversiones de ClinicaClick antes de activarla.',
          reason: readiness.reason || 'conversion_readiness_pending',
          reasons: readiness.reasons,
          issues: readiness.issues,
          status: 'draft'
        });
      }
      activationReadiness = {
        ...activationReadiness,
        enabled_events: readiness.enabled_events,
        customer_ids: readiness.customer_ids
      };
    }
  }

  const directVerifiedExternalCampaignActivation = usesExistingAdvertiserCampaigns(strategy?.mode)
    && currentStatus === 'draft'
    && nextStatus === 'active'
    && activationReadiness?.validated === true;
  if (!canTransitionStrategy(currentStatus, nextStatus) && !directVerifiedExternalCampaignActivation) {
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
  let guidedOptimizationJob = null;
  let guidedOptimizationPolicyId = null;
  await db.sequelize.transaction(async (transaction) => {
    let guidedPayload = null;
    for (const row of rows) {
      const payload = row?.solicitud && typeof row.solicitud === 'object' ? row.solicitud : {};
      const history = Array.isArray(payload.status_history) ? [...payload.status_history] : [];
      history.push({
        from: currentStatus,
        to: nextStatus,
        changed_at: nowIso,
        user_id: userId
      });
      const nextPayload = {
        ...payload,
        status: nextStatus,
        ...(activationReadiness ? { activation_readiness: activationReadiness } : {}),
        status_history: history,
        updated_at: nowIso
      };
      if (!guidedPayload) guidedPayload = nextPayload;

      await CampaignRequest.update({
        estado: requestState,
        solicitud: nextPayload,
        updated_at: now
      }, {
        where: { id: row.id },
        transaction
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
        where: { id: strategy.campaign_id },
        transaction
      });
    }

    if (
      strategy.mode === CAMPAIGN_MODES.IMPROVE
      && strategy.campaign_id
      && (nextStatus === 'paused' || nextStatus === 'completed')
    ) {
      const { syncGuidedPolicyStrategyStatus } = require('../services/guidedCampaignOptimizationPolicy.service');
      await syncGuidedPolicyStrategyStatus({
        strategyId: strategy.campaign_id,
        strategyStatus: nextStatus,
        transaction,
      });
    }

    if (
      strategy.mode === CAMPAIGN_MODES.IMPROVE
      && nextStatus === 'active'
      && strategy.campaign_id
      && strategyPayloadUsesGoogleAds(guidedPayload)
    ) {
      // Lazy imports break the existing Google goal-policy -> onboarding audit
      // dependency without starting a controller/service circular dependency.
      const { provisionGuidedCampaignOptimization } = require('../services/guidedCampaignOptimizationPolicy.service');
      const { enqueueGuidedGoalPolicyApply } = require('../services/guidedCampaignOptimizationJobs.service');
      const provisioning = await provisionGuidedCampaignOptimization({
        campaign: campaignsById.get(strategy.campaign_id),
        payload: guidedPayload,
        now,
        transaction
      });
      guidedOptimizationPolicyId = provisioning.policy.id;
      guidedOptimizationJob = await enqueueGuidedGoalPolicyApply({
        strategyId: strategy.campaign_id,
        requestedBy: userId,
        requestedByName: req.userData?.name || null,
        requestedByRole: req.userData?.role || null,
        transaction,
        triggerImmediately: false
      });
    }
  });
  if (guidedOptimizationJob?.id) {
    const { triggerGuidedGoalPolicyJob } = require('../services/guidedCampaignOptimizationJobs.service');
    triggerGuidedGoalPolicyJob(guidedOptimizationJob.id);
  }

  return res.json({
    success: true,
    strategy: {
      id: strategy.id,
      status: nextStatus,
      updated_at: nowIso
    },
    ...(guidedOptimizationJob ? {
      guided_optimization: {
        policy_id: guidedOptimizationPolicyId,
        job_request_id: guidedOptimizationJob.id,
        status: 'queued',
        message: 'La medición está activa. Aplicaremos Lead válido como objetivo y verificaremos el resultado en segundo plano.'
      }
    } : {})
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
  // Resolve mode and contract from one snapshot of the precedence chain. This
  // prevents a concurrent IntakeConfig/onboarding write from mixing a mode from
  // one source with a contract from another.
  const resolvedScopeMode = await resolveModeStateForScope(scope);
  const scopeMode = resolvedScopeMode?.mode || null;
  const storedModeContract = resolvedScopeMode?.mode_contract || null;
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
      message: 'La configuración antigua de gestión propia es solo de lectura. Selecciona Mide y entiende, Mejora o Piloto automático antes de crear una estrategia.'
    });
  }
  const modeContract = buildCampaignModeContract(
    effectiveMode,
    storedModeContract?.authorization || null
  );
  if (
    effectiveMode === CAMPAIGN_MODES.IMPROVE
    && modeContract.authorization?.accepted !== true
  ) {
    return res.status(409).json({
      success: false,
      error: 'improvement_authorization_required',
      message: 'Vuelve a completar la configuración de Mejora para autorizar sus acciones limitadas.'
    });
  }
  const treatments = normalizeStrategyTreatments(req.body?.treatments);
  const externalTargets = usesExistingAdvertiserCampaigns(effectiveMode)
    ? normalizeExternalTargets(req.body?.external_targets)
    : [];
  const targetDestinations = usesExistingAdvertiserCampaigns(effectiveMode)
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
  const budgetMonthly = !ownsCampaignOperations(effectiveMode)
    ? (Number.isFinite(parsedBudgetMonthly) && parsedBudgetMonthly > 0 ? parsedBudgetMonthly : null)
    : parsedBudgetMonthly;
  if (ownsCampaignOperations(effectiveMode) && (!Number.isFinite(budgetMonthly) || budgetMonthly <= 0)) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'budget_monthly debe ser mayor que 0' });
  }

  const channels = normalizeStrategyChannels(req.body?.channels);
  if (!channels.length && ownsCampaignOperations(effectiveMode)) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'Selecciona al menos un canal' });
  }
  if (ownsCampaignOperations(effectiveMode) && !channels.some((item) => ['google_ads', 'meta_ads'].includes(item.channel) && item.enabled !== false)) {
    return res.status(400).json({ success: false, error: 'validation_error', message: 'Piloto automático requiere Google Ads o Meta Ads' });
  }

  if (usesExistingAdvertiserCampaigns(effectiveMode)) {
    const treatmentIds = new Set(treatments.map((item) => item.id));
    const targetKeys = new Set();
    const assignedCampaignKeys = new Set();
    const totalAssignedCampaigns = externalTargets.reduce((sum, target) => sum + target.campaigns.length, 0);

    if (totalAssignedCampaigns === 0) {
      return res.status(400).json({
        success: false,
        error: 'validation_error',
        message: `Vincula al menos una campaña externa para continuar con ${effectiveMode === CAMPAIGN_MODES.IMPROVE ? 'Mejora' : 'Mide y entiende'}.`
      });
    }
    if (
      effectiveMode === CAMPAIGN_MODES.IMPROVE
      && !externalTargetsHaveProvider(externalTargets, 'google_ads')
    ) {
      return res.status(409).json({
        success: false,
        error: 'guided_google_ads_required',
        message: 'Mejora necesita al menos una campaña Google Search o Performance Max vinculada. Una estrategia solo Meta puede usar Mide y entiende.'
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
      if (destinationItem.uses_web === true) {
        const validatedDestination = stableHttpsDestination(destinationItem.confirmed_url);
        if (!validatedDestination.valid) {
          return res.status(400).json({
            success: false,
            error: 'unstable_campaign_destination',
            message: 'El destino web debe ser una URL HTTPS pública y estable, sin credenciales, fragmentos ni parámetros temporales.',
            reason: validatedDestination.reason
          });
        }
        destinationItem.confirmed_url = validatedDestination.url;
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

  // Crear la estrategia no equivale a lanzarla. Incluso con campañas externas debe
  // permanecer en borrador hasta que el gate de medición valide Data Manager.
  const initialStatus = 'draft';

  const geo = req.body?.geo && typeof req.body.geo === 'object' ? req.body.geo : {};
  const destination = req.body?.destination && typeof req.body.destination === 'object' ? req.body.destination : null;
  const measurement = req.body?.measurement && typeof req.body.measurement === 'object' ? req.body.measurement : null;
  const automation = req.body?.automation && typeof req.body.automation === 'object' ? req.body.automation : null;
  const addonCalls = ownsCampaignOperations(effectiveMode) ? req.body?.addon_calls === true : false;

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
      gestionada: ownsCampaignOperations(effectiveMode),
      activa: false,
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
        mode_contract: modeContract,
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

    if (ownsCampaignOperations(effectiveMode)) {
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

exports.__test = {
  CAMPAIGN_MODES,
  IMPROVEMENT_AUTHORIZATION_SCOPES,
  IMPROVEMENT_AUTHORIZATION_VERSION,
  IMPROVEMENT_WEB_INTEGRATION_HOOKS,
  applyCanonicalMappingsToGoogleAdsConfig,
  auditConnectOnlyMeasurementTarget,
  assessConsentMeasurementReadiness,
  assessConversionOnboardingReadiness,
  assertCampaignModeTransitionSafe,
  buildCampaignAnalysisMetricContract,
  buildCurrentExternalCampaignInventoryIndex,
  buildMetaAccountConnectionMap,
  buildEnhancedConversionActivationPlan,
  buildLeadAttributionMetrics,
  buildGoogleAdsCapabilities,
  buildRequiredConversionPlan,
  buildZonedCalendarRange,
  buildClinicaclickConversionActionCreate,
  buildClinicaclickManagedMapping,
  conversionValidationKey,
  collectEnhancedConversionActivationTargets,
  adPersonalizationCapabilityReconciliationKey,
  buildVisitorChoicePersonalizationConfig,
  buildCampaignModeContract,
  guardCampaignOnboardingStartMode,
  enhancedConversionActivationReconciliationKey,
  internalAdvertiserAuthorizationRequest,
  isEnhancedConversionActivationApplied,
  isVisitorChoicePersonalizationCapabilityApplied,
  mergeCurrentGoogleCampaignInventory,
  overlayExternalTargetsWithInventory,
  persistEnhancedConversionActivationPlan,
  persistVisitorChoicePersonalizationCapability,
  normalizeImprovementAuthorization,
  normalizeModeTransitionConfirmation,
  readGoogleConversionTrackingSettings,
  reconcileEnhancedConversionsInternalActivation,
  reconcileVisitorChoicePersonalizationCapabilities,
  usesExistingAdvertiserCampaigns,
  validateImprovementAuthorization,
  reconcileVerifiedConnectOnlyStrategyActivationReadiness,
  enrichMetaCampaignsWithMappedConnections,
  metaConnectionUsability,
  resolveGoogleCampaignMappingAccess,
  resolveMetaCampaignMappingAccess,
  resolveAnalysisDateRange,
  resolveLeadProvider,
  resolveActiveModeForScope,
  resolveModeContractForScope,
  resolveWebMeasurementMarketingState,
  resolveEnabledConversionEvents,
  strategyPayloadUsesGoogleAds,
  stableHttpsDestination,
  validateEnhancedConversionActivationAllowlist
};

exports.auditConnectOnlyMeasurementTarget = auditConnectOnlyMeasurementTarget;
exports.reconcileEnhancedConversionsInternalActivation = reconcileEnhancedConversionsInternalActivation;
exports.reconcileVisitorChoicePersonalizationCapabilities =
  reconcileVisitorChoicePersonalizationCapabilities;
exports.reconcileVerifiedConnectOnlyStrategyActivationReadiness =
  reconcileVerifiedConnectOnlyStrategyActivationReadiness;
// Canonical public-HTTPS validator shared with the durable landing-to-campaign
// bridge. Keeping this as an explicit runtime export prevents the production
// worker from depending on the test-only `__test` namespace.
exports.stableHttpsDestination = stableHttpsDestination;
