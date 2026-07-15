'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const { metaGet } = require('../lib/metaClient');
const {
  normalizeScope,
  resolveMetaConnectionForScope,
  resolveGoogleConnectionForScope
} = require('./scopeConnectionResolver.service');

const IntakeConfig = db.IntakeConfig;
const Clinica = db.Clinica;
const GrupoClinica = db.GrupoClinica;
const ClinicMetaAsset = db.ClinicMetaAsset;
const ClinicGoogleAdsAccount = db.ClinicGoogleAdsAccount;
const ClinicWebAsset = db.ClinicWebAsset;
const ClinicAnalyticsProperty = db.ClinicAnalyticsProperty;
const ClinicBusinessLocation = db.ClinicBusinessLocation;
const GroupAssetClinicAssignment = db.GroupAssetClinicAssignment;
const MetaConnection = db.MetaConnection;

const GROUP_ASSET_TYPES = Object.freeze({
  META_AD_ACCOUNT: 'meta.ad_account',
  META_FACEBOOK_PAGE: 'meta.facebook_page',
  META_INSTAGRAM_BUSINESS: 'meta.instagram_business',
  GOOGLE_ADS_ACCOUNT: 'google.ads_account',
  GOOGLE_SEARCH_CONSOLE: 'google.search_console',
  GOOGLE_ANALYTICS: 'google.analytics',
  GOOGLE_BUSINESS_PROFILE: 'google.business_profile'
});

const META_GROUP_ASSET_TYPE_BY_ASSET_TYPE = Object.freeze({
  ad_account: GROUP_ASSET_TYPES.META_AD_ACCOUNT,
  facebook_page: GROUP_ASSET_TYPES.META_FACEBOOK_PAGE,
  instagram_business: GROUP_ASSET_TYPES.META_INSTAGRAM_BUSINESS
});

const GOOGLE_PROPERTY_ASSET_CONFIG = Object.freeze({
  search_console: Object.freeze({
    assetType: GROUP_ASSET_TYPES.GOOGLE_SEARCH_CONSOLE,
    model: ClinicWebAsset,
    clinicField: 'clinicaId',
    activeField: 'isActive',
    modeField: 'search_console_assignment_mode',
    primaryField: 'search_console_primary_asset_id',
    identityField: 'siteUrl'
  }),
  analytics: Object.freeze({
    assetType: GROUP_ASSET_TYPES.GOOGLE_ANALYTICS,
    model: ClinicAnalyticsProperty,
    clinicField: 'clinicaId',
    activeField: 'isActive',
    modeField: 'analytics_assignment_mode',
    primaryField: 'analytics_primary_property_id',
    identityField: 'propertyName'
  }),
  business_profile: Object.freeze({
    assetType: GROUP_ASSET_TYPES.GOOGLE_BUSINESS_PROFILE,
    model: ClinicBusinessLocation,
    clinicField: 'clinica_id',
    activeField: 'is_active',
    modeField: 'business_profile_assignment_mode',
    primaryField: 'business_profile_primary_location_id',
    identityField: 'location_id'
  })
});

function parseInteger(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const parsed = Number.parseInt(raw, 10);
  return Number.isInteger(parsed) ? parsed : null;
}

function parseBoolean(raw, fallback = false) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return fallback;
}

function cleanString(raw) {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  return value || null;
}

function cleanGoogleCustomerId(raw) {
  const cleaned = String(raw || '').replace(/\D+/g, '');
  return cleaned || null;
}

function hasOwnAlias(source, snakeKey, camelKey) {
  return Object.prototype.hasOwnProperty.call(source, snakeKey)
    || Boolean(camelKey && Object.prototype.hasOwnProperty.call(source, camelKey));
}

function normalizeGoogleCampaignIds(...rawValues) {
  const seen = new Set();
  const normalized = [];
  for (const rawValue of rawValues) {
    const values = Array.isArray(rawValue) ? rawValue : rawValue == null ? [] : [rawValue];
    for (const value of values) {
      const campaignId = cleanGoogleCustomerId(value);
      if (!campaignId || seen.has(campaignId)) continue;
      seen.add(campaignId);
      normalized.push(campaignId);
    }
  }
  return normalized;
}

function normalizeMetaAdAccountId(raw) {
  const value = cleanString(raw);
  if (!value) return null;
  if (value.startsWith('act_')) return value;
  return /^\d+$/.test(value) ? `act_${value}` : value;
}

function extractGoogleTagId(sendTo) {
  const raw = cleanString(sendTo);
  if (!raw) return null;
  const match = raw.match(/(AW-\d+)/i);
  return match ? match[1].toUpperCase() : null;
}

function normalizeGoogleAdsDestinations(rawDestinations, fallbackCurrency = 'EUR') {
  if (!Array.isArray(rawDestinations)) return [];
  const normalized = [];
  const seenTargets = new Set();
  for (let index = 0; index < rawDestinations.length; index += 1) {
    const raw = rawDestinations[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const customerId = cleanGoogleCustomerId(raw.customer_id || raw.customerId) || null;
    const conversionAction = cleanString(raw.conversion_action || raw.conversionAction);
    const conversionActionId = cleanString(raw.conversion_action_id || raw.conversionActionId);
    const sendTo = cleanString(raw.send_to || raw.sendTo);
    const identity = [customerId, conversionAction, conversionActionId, sendTo].join('|');
    if (seenTargets.has(identity)) continue;
    seenTargets.add(identity);
    normalized.push({
      key: cleanString(raw.key || raw.destination_key || raw.destinationKey)
        || `destination_${customerId || index + 1}`,
      enabled: raw.enabled !== false,
      customer_id: customerId,
      conversion_action: conversionAction,
      conversion_action_id: conversionActionId,
      send_to: sendTo,
      currency: cleanString(raw.currency) || fallbackCurrency,
      campaign_ids: normalizeGoogleCampaignIds(raw.campaign_ids, raw.campaignIds),
      ...(raw.value !== undefined ? { value: raw.value } : {}),
      ...(raw.consent !== undefined ? { consent: raw.consent } : {}),
      ...(raw.user_data_enabled !== undefined || raw.userDataEnabled !== undefined
        ? { user_data_enabled: raw.user_data_enabled === true || raw.userDataEnabled === true }
        : {}),
      ...(raw.phone_country_code !== undefined || raw.phoneCountryCode !== undefined
        ? { phone_country_code: cleanGoogleCustomerId(raw.phone_country_code || raw.phoneCountryCode) }
        : {}),
      ...(raw.user_properties !== undefined || raw.userProperties !== undefined
        ? { user_properties: raw.user_properties ?? raw.userProperties }
        : {})
    });
  }
  return normalized;
}

function normalizeMetaAdsConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    return {
      enabled: true,
      connection_id: null,
      ad_account_id: null,
      pixel_id: null
    };
  }

  return {
    enabled: rawConfig.enabled !== false,
    connection_id: parseInteger(rawConfig.connection_id || rawConfig.connectionId),
    ad_account_id: normalizeMetaAdAccountId(rawConfig.ad_account_id || rawConfig.adAccountId),
    pixel_id: cleanString(rawConfig.pixel_id || rawConfig.pixelId)
  };
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
    customer_id: cleanGoogleCustomerId(rawConfig.customer_id || rawConfig.customerId) || null,
    conversion_action: cleanString(rawConfig.conversion_action || rawConfig.conversionAction),
    conversion_action_id: cleanString(rawConfig.conversion_action_id || rawConfig.conversionActionId),
    send_to: cleanString(rawConfig.send_to || rawConfig.sendTo),
    currency: cleanString(rawConfig.currency) || 'EUR',
    ...(hasOwnAlias(rawConfig, 'phone_country_code', 'phoneCountryCode')
      ? {
        phone_country_code: cleanGoogleCustomerId(
          rawConfig.phone_country_code || rawConfig.phoneCountryCode
        ) || null,
      }
      : {}),
    ...(hasOwnAlias(rawConfig, 'user_data_enabled', 'userDataEnabled')
      ? { user_data_enabled: rawConfig.user_data_enabled === true || rawConfig.userDataEnabled === true }
      : {}),
    ...(hasOwnAlias(rawConfig, 'enhanced_conversions', 'enhancedConversions')
      ? {
        enhanced_conversions: rawConfig.enhanced_conversions
          && typeof rawConfig.enhanced_conversions === 'object'
          && !Array.isArray(rawConfig.enhanced_conversions)
          ? { ...rawConfig.enhanced_conversions }
          : (rawConfig.enhancedConversions
            && typeof rawConfig.enhancedConversions === 'object'
            && !Array.isArray(rawConfig.enhancedConversions)
            ? { ...rawConfig.enhancedConversions }
            : null),
      }
      : {}),
    ...(rawConfig.value !== undefined ? { value: rawConfig.value } : {}),
    ...(rawConfig.consent !== undefined ? { consent: rawConfig.consent } : {}),
    ...(rawConfig.user_properties !== undefined || rawConfig.userProperties !== undefined
      ? { user_properties: rawConfig.user_properties ?? rawConfig.userProperties }
      : {}),
    events: {}
  };

  const rawEvents = rawConfig.events && typeof rawConfig.events === 'object' && !Array.isArray(rawConfig.events)
    ? rawConfig.events
    : {};

  for (const [eventKey, eventValue] of Object.entries(rawEvents)) {
    if (!eventValue || typeof eventValue !== 'object' || Array.isArray(eventValue)) continue;
    const normalizedEvent = {
      enabled: eventValue.enabled !== false,
      customer_id: cleanGoogleCustomerId(eventValue.customer_id || eventValue.customerId) || null,
      conversion_action: cleanString(eventValue.conversion_action || eventValue.conversionAction),
      conversion_action_id: cleanString(eventValue.conversion_action_id || eventValue.conversionActionId),
      send_to: cleanString(eventValue.send_to || eventValue.sendTo),
      currency: cleanString(eventValue.currency) || normalized.currency,
      ...(hasOwnAlias(eventValue, 'phone_country_code', 'phoneCountryCode')
        ? {
          phone_country_code: cleanGoogleCustomerId(
            eventValue.phone_country_code || eventValue.phoneCountryCode
          ) || null,
        }
        : {}),
      ...(hasOwnAlias(eventValue, 'user_data_enabled', 'userDataEnabled')
        ? { user_data_enabled: eventValue.user_data_enabled === true || eventValue.userDataEnabled === true }
        : {}),
      ...(eventValue.value !== undefined ? { value: eventValue.value } : {}),
      ...(eventValue.consent !== undefined ? { consent: eventValue.consent } : {}),
      ...(eventValue.user_properties !== undefined || eventValue.userProperties !== undefined
        ? { user_properties: eventValue.user_properties ?? eventValue.userProperties }
        : {})
    };
    normalizedEvent.campaign_ids = normalizeGoogleCampaignIds(
      eventValue.campaign_ids,
      eventValue.campaignIds
    );
    if (Object.prototype.hasOwnProperty.call(eventValue, 'destinations')) {
      normalizedEvent.destinations = normalizeGoogleAdsDestinations(
        eventValue.destinations,
        cleanString(eventValue.currency) || normalized.currency
      );
    }
    normalized.events[eventKey] = normalizedEvent;
  }

  return normalized;
}

function hasMetaAdsConfig(rawConfig) {
  const normalized = normalizeMetaAdsConfig(rawConfig);
  return Boolean(normalized.connection_id || normalized.ad_account_id || normalized.pixel_id);
}

function hasGoogleAdsConfig(rawConfig) {
  const normalized = normalizeGoogleAdsConfig(rawConfig);
  if (normalized.customer_id || normalized.conversion_action || normalized.conversion_action_id || normalized.send_to) {
    return true;
  }
  return Object.values(normalized.events || {}).some((eventCfg) => (
    eventCfg?.customer_id || eventCfg?.conversion_action || eventCfg?.conversion_action_id || eventCfg?.send_to
      || (Array.isArray(eventCfg?.destinations) && eventCfg.destinations.length > 0)
  ));
}

function mergeGoogleAdsEvents(baseEvents = {}, overrideEvents = {}, rawOverrideEvents = {}) {
  const merged = { ...baseEvents };
  for (const [eventKey, overrideValue] of Object.entries(overrideEvents || {})) {
    const baseValue = merged[eventKey] && typeof merged[eventKey] === 'object' ? merged[eventKey] : {};
    const rawValue = rawOverrideEvents[eventKey] && typeof rawOverrideEvents[eventKey] === 'object'
      ? rawOverrideEvents[eventKey]
      : {};
    const pickEventValue = (snakeKey, camelKey, fallbackValue) => (
      Object.prototype.hasOwnProperty.call(rawValue, snakeKey)
        || (camelKey && Object.prototype.hasOwnProperty.call(rawValue, camelKey))
        ? overrideValue[snakeKey]
        : fallbackValue
    );
    const mergedEvent = {
      enabled: Object.prototype.hasOwnProperty.call(rawValue, 'enabled') ? overrideValue.enabled : baseValue.enabled,
      customer_id: pickEventValue('customer_id', 'customerId', baseValue.customer_id),
      conversion_action: pickEventValue('conversion_action', 'conversionAction', baseValue.conversion_action),
      conversion_action_id: pickEventValue('conversion_action_id', 'conversionActionId', baseValue.conversion_action_id),
      send_to: pickEventValue('send_to', 'sendTo', baseValue.send_to),
      currency: Object.prototype.hasOwnProperty.call(rawValue, 'currency') ? overrideValue.currency : baseValue.currency,
      phone_country_code: pickEventValue(
        'phone_country_code',
        'phoneCountryCode',
        baseValue.phone_country_code
      ),
      user_data_enabled: pickEventValue(
        'user_data_enabled',
        'userDataEnabled',
        baseValue.user_data_enabled
      ),
      value: Object.prototype.hasOwnProperty.call(rawValue, 'value')
        ? overrideValue.value
        : baseValue.value,
      consent: Object.prototype.hasOwnProperty.call(rawValue, 'consent')
        ? overrideValue.consent
        : baseValue.consent,
      user_properties: pickEventValue(
        'user_properties',
        'userProperties',
        baseValue.user_properties
      ),
      campaign_ids: (
        Object.prototype.hasOwnProperty.call(rawValue, 'campaign_ids')
          || Object.prototype.hasOwnProperty.call(rawValue, 'campaignIds')
      ) ? overrideValue.campaign_ids : (baseValue.campaign_ids || [])
    };
    if (Object.prototype.hasOwnProperty.call(rawValue, 'destinations')) {
      mergedEvent.destinations = overrideValue.destinations;
    } else if (Object.prototype.hasOwnProperty.call(baseValue, 'destinations')) {
      mergedEvent.destinations = baseValue.destinations;
    }
    merged[eventKey] = mergedEvent;
  }
  return merged;
}

function mergeGoogleAdsConfig(baseConfig, overrideConfig) {
  const base = normalizeGoogleAdsConfig(baseConfig);
  const rawOverride = overrideConfig && typeof overrideConfig === 'object' && !Array.isArray(overrideConfig)
    ? overrideConfig
    : {};
  const override = normalizeGoogleAdsConfig(rawOverride);
  const pickOverride = (snakeKey, camelKey, normalizedValue, fallbackValue) => (
    Object.prototype.hasOwnProperty.call(rawOverride, snakeKey)
      || (camelKey && Object.prototype.hasOwnProperty.call(rawOverride, camelKey))
      ? normalizedValue
      : fallbackValue
  );
  return {
    enabled: Object.prototype.hasOwnProperty.call(rawOverride, 'enabled') ? override.enabled : base.enabled,
    customer_id: pickOverride('customer_id', 'customerId', override.customer_id, base.customer_id),
    conversion_action: pickOverride('conversion_action', 'conversionAction', override.conversion_action, base.conversion_action),
    conversion_action_id: pickOverride('conversion_action_id', 'conversionActionId', override.conversion_action_id, base.conversion_action_id),
    send_to: pickOverride('send_to', 'sendTo', override.send_to, base.send_to),
    currency: Object.prototype.hasOwnProperty.call(rawOverride, 'currency') ? override.currency : base.currency,
    phone_country_code: pickOverride(
      'phone_country_code',
      'phoneCountryCode',
      override.phone_country_code,
      base.phone_country_code
    ),
    user_data_enabled: pickOverride(
      'user_data_enabled',
      'userDataEnabled',
      override.user_data_enabled,
      base.user_data_enabled
    ),
    enhanced_conversions: pickOverride(
      'enhanced_conversions',
      'enhancedConversions',
      override.enhanced_conversions,
      base.enhanced_conversions
    ),
    value: Object.prototype.hasOwnProperty.call(rawOverride, 'value') ? override.value : base.value,
    consent: Object.prototype.hasOwnProperty.call(rawOverride, 'consent') ? override.consent : base.consent,
    user_properties: pickOverride(
      'user_properties',
      'userProperties',
      override.user_properties,
      base.user_properties
    ),
    events: mergeGoogleAdsEvents(base.events, override.events, rawOverride.events || {})
  };
}

function hasGoogleAdsActionTarget(config) {
  return Boolean(
    cleanString(config?.conversion_action || config?.conversionAction)
    || cleanString(config?.conversion_action_id || config?.conversionActionId)
    || cleanString(config?.send_to || config?.sendTo)
  );
}

function findGoogleAdsDestinationTemplate(config, eventKey, customerId) {
  const events = config?.events && typeof config.events === 'object'
    ? config.events
    : {};
  const orderedEvents = [events[eventKey], ...Object.entries(events)
    .filter(([candidateKey]) => candidateKey !== eventKey)
    .map(([, eventConfig]) => eventConfig)];

  for (const eventConfig of orderedEvents) {
    const destinations = Array.isArray(eventConfig?.destinations)
      ? eventConfig.destinations
      : [];
    const match = destinations.find((destination) => (
      cleanGoogleCustomerId(destination?.customer_id || destination?.customerId) === customerId
    ));
    if (match) return match;
  }

  return null;
}

function buildLegacyGoogleAdsDestination(config, eventKey, template) {
  const eventConfig = config?.events?.[eventKey];
  if (!eventConfig || !hasGoogleAdsActionTarget(eventConfig)) return null;
  const customerId = cleanGoogleCustomerId(eventConfig.customer_id || config.customer_id);
  if (!customerId) return null;

  return {
    key: cleanString(template?.key) || `destination_${customerId}`,
    enabled: eventConfig.enabled !== false,
    customer_id: customerId,
    conversion_action: cleanString(eventConfig.conversion_action),
    conversion_action_id: cleanString(eventConfig.conversion_action_id),
    send_to: cleanString(eventConfig.send_to),
    currency: cleanString(eventConfig.currency) || cleanString(config.currency) || 'EUR',
    campaign_ids: eventConfig.campaign_ids?.length
      ? eventConfig.campaign_ids
      : (template?.campaign_ids || [])
  };
}

// The provisioning endpoint can be called once per Ads account for the same
// scope. Keep those canonical actions as explicit per-account destinations so
// provisioning a second account never replaces the first account's action.
function mergeProvisionedGoogleAdsConfig(baseConfig, provisionedConfig, options = {}) {
  const normalizedBase = normalizeGoogleAdsConfig(baseConfig);
  const rawProvisioned = provisionedConfig && typeof provisionedConfig === 'object'
    && !Array.isArray(provisionedConfig)
    ? provisionedConfig
    : {};
  const customerId = cleanGoogleCustomerId(
    options.customerId
    || options.customer_id
    || rawProvisioned.customer_id
    || rawProvisioned.customerId
  );
  const hasExplicitEventKeys = Array.isArray(options.eventKeys)
    || Array.isArray(options.event_keys);
  const rawEventKeys = Array.isArray(options.eventKeys)
    ? options.eventKeys
    : Array.isArray(options.event_keys)
      ? options.event_keys
      : [];
  const eventKeys = [...new Set(rawEventKeys
    .map((value) => cleanString(value)?.toLowerCase())
    .filter((eventKey) => eventKey && rawProvisioned.events?.[eventKey]))];

  if (!customerId || !hasExplicitEventKeys) {
    return mergeGoogleAdsConfig(normalizedBase, rawProvisioned);
  }
  if (eventKeys.length === 0) return normalizedBase;

  // A recommendation contains a snapshot of every canonical event in the
  // current Ads account. Only merge the events explicitly requested by the
  // caller; the rest may belong to other destinations already configured.
  const scopedProvisioned = {
    ...rawProvisioned,
    events: Object.fromEntries(eventKeys.map((eventKey) => [
      eventKey,
      rawProvisioned.events[eventKey]
    ]))
  };
  const normalizedProvisioned = normalizeGoogleAdsConfig(scopedProvisioned);
  const merged = mergeGoogleAdsConfig(normalizedBase, scopedProvisioned);

  for (const eventKey of eventKeys) {
    const provisionedEvent = normalizedProvisioned.events[eventKey];
    if (!hasGoogleAdsActionTarget(provisionedEvent)) {
      if (normalizedBase.events[eventKey]) {
        merged.events[eventKey] = normalizedBase.events[eventKey];
      }
      continue;
    }

    const baseEvent = normalizedBase.events[eventKey] || null;
    const hadExplicitDestinations = Object.prototype.hasOwnProperty.call(baseEvent || {}, 'destinations');
    const destinations = hadExplicitDestinations ? [...baseEvent.destinations] : [];
    const template = findGoogleAdsDestinationTemplate(normalizedBase, eventKey, customerId);

    if (!hadExplicitDestinations) {
      const legacyCustomerId = cleanGoogleCustomerId(baseEvent?.customer_id || normalizedBase.customer_id);
      const legacyTemplate = legacyCustomerId
        ? findGoogleAdsDestinationTemplate(normalizedBase, eventKey, legacyCustomerId)
        : null;
      const legacyDestination = buildLegacyGoogleAdsDestination(
        normalizedBase,
        eventKey,
        legacyTemplate
      );
      if (legacyDestination) destinations.push(legacyDestination);
    }

    const existingDestination = destinations.find((destination) => (
      cleanGoogleCustomerId(destination?.customer_id) === customerId
    ));
    const destinationTemplate = existingDestination || template;
    const nextDestination = {
      ...(existingDestination || {}),
      key: cleanString(destinationTemplate?.key) || `destination_${customerId}`,
      enabled: provisionedEvent.enabled !== false,
      customer_id: customerId,
      conversion_action: cleanString(provisionedEvent.conversion_action),
      conversion_action_id: cleanString(provisionedEvent.conversion_action_id),
      send_to: cleanString(provisionedEvent.send_to),
      currency: cleanString(provisionedEvent.currency) || merged.currency || 'EUR',
      campaign_ids: existingDestination
        ? (existingDestination.campaign_ids || [])
        : (destinationTemplate?.campaign_ids || provisionedEvent.campaign_ids || [])
    };

    let inserted = false;
    const nextDestinations = [];
    for (const destination of destinations) {
      if (cleanGoogleCustomerId(destination?.customer_id) !== customerId) {
        nextDestinations.push(destination);
      } else if (!inserted) {
        nextDestinations.push(nextDestination);
        inserted = true;
      }
    }
    if (!inserted) nextDestinations.push(nextDestination);

    merged.events[eventKey] = {
      ...merged.events[eventKey],
      destinations: normalizeGoogleAdsDestinations(
        nextDestinations,
        provisionedEvent.currency || merged.currency
      )
    };
  }

  return merged;
}

function mergeMetaAdsConfig(baseConfig, overrideConfig) {
  const base = normalizeMetaAdsConfig(baseConfig);
  const override = normalizeMetaAdsConfig(overrideConfig);
  return {
    enabled: override.enabled !== undefined ? override.enabled : base.enabled,
    connection_id: override.connection_id || base.connection_id || null,
    ad_account_id: override.ad_account_id || base.ad_account_id || null,
    pixel_id: override.pixel_id || base.pixel_id || null
  };
}

function getScopeAssignmentScope(scope) {
  return String(scope?.assignment_scope || scope?.assignmentScope || '').trim().toLowerCase() === 'group'
    ? 'group'
    : 'clinic';
}

function getScopeClinicId(scope) {
  return parseInteger(scope?.clinic_id ?? scope?.clinicId);
}

function getScopeGroupId(scope) {
  return parseInteger(scope?.group_id ?? scope?.groupId);
}

function getScopeClinicIds(scope) {
  const clinicIds = Array.isArray(scope?.clinic_ids)
    ? scope.clinic_ids
    : Array.isArray(scope?.clinicIds)
      ? scope.clinicIds
      : [];
  return clinicIds
    .map((value) => parseInteger(value))
    .filter((value) => Number.isInteger(value) && value > 0);
}

function buildScopedAssetWhere(scope, explicitAssetIds = []) {
  const assignmentScope = getScopeAssignmentScope(scope);
  const clinicId = getScopeClinicId(scope);
  const groupId = getScopeGroupId(scope);
  const clinicIds = getScopeClinicIds(scope);

  if (assignmentScope === 'group') {
    const or = [];
    if (groupId) {
      or.push({ grupoClinicaId: groupId });
    }
    if (clinicIds.length > 0) {
      or.push({ clinicaId: { [Op.in]: clinicIds } });
    }
    return or.length > 0 ? { [Op.or]: or } : {};
  }

  const or = [];
  if (clinicId) {
    or.push({ clinicaId: clinicId });
  }
  if (groupId) {
    or.push({ grupoClinicaId: groupId, assignmentScope: 'group' });
  }
  const normalizedExplicitAssetIds = explicitAssetIds
    .map((value) => parseInteger(value))
    .filter((value) => Number.isInteger(value) && value > 0);
  if (normalizedExplicitAssetIds.length > 0) {
    or.push({ id: { [Op.in]: normalizedExplicitAssetIds } });
  }
  return or.length > 0 ? { [Op.or]: or } : {};
}

function resolveAssetOrigin(row, scope) {
  if (row?.effectiveAssignmentOrigin) return row.effectiveAssignmentOrigin;
  const clinicId = getScopeClinicId(scope);
  const groupId = getScopeGroupId(scope);
  const rowClinicId = parseInteger(row?.clinicaId ?? row?.clinica_id);
  const rowGroupId = parseInteger(row?.grupoClinicaId ?? row?.grupo_clinica_id);
  if (
    String(row?.assignmentScope || row?.assignment_scope || '').trim().toLowerCase() === 'group'
    && groupId
    && rowGroupId === groupId
  ) {
    return 'group';
  }
  if (clinicId && rowClinicId === clinicId) return 'clinic';
  if (groupId && rowGroupId === groupId) return 'group';
  return String(row?.assignmentScope || '').trim().toLowerCase() === 'group' ? 'group' : 'clinic';
}

function getOriginPriority(origin) {
  if (origin === 'clinic') return 0;
  if (origin === 'shared') return 1;
  return 2;
}

function sortRowsForSelection(scope, rows) {
  return [...rows].sort((left, right) => {
    const leftOrigin = resolveAssetOrigin(left, scope);
    const rightOrigin = resolveAssetOrigin(right, scope);
    const originDiff = getOriginPriority(leftOrigin) - getOriginPriority(rightOrigin);
    if (originDiff !== 0) return originDiff;
    const leftUpdated = new Date(left?.updatedAt || left?.updated_at || 0).getTime();
    const rightUpdated = new Date(right?.updatedAt || right?.updated_at || 0).getTime();
    return rightUpdated - leftUpdated;
  });
}

function dedupePreferred(scope, rows, keyBuilder) {
  const result = [];
  const seen = new Set();
  for (const row of sortRowsForSelection(scope, rows)) {
    const key = keyBuilder(row);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(row);
  }
  return result;
}

async function loadScopeDescriptors(scope) {
  const clinicId = getScopeClinicId(scope);
  const groupId = getScopeGroupId(scope);
  const [clinic, group] = await Promise.all([
    clinicId
      ? Clinica.findOne({
        where: { id_clinica: clinicId },
        attributes: ['id_clinica', 'nombre_clinica'],
        raw: true
      })
      : null,
    groupId
      ? GrupoClinica.findOne({
        where: { id_grupo: groupId },
        attributes: ['id_grupo', 'nombre_grupo'],
        raw: true
      })
      : null
  ]);

  return {
    clinic_name: clinic?.nombre_clinica || null,
    group_name: group?.nombre_grupo || null
  };
}

async function loadScopeIntakeRecords(scope) {
  const clinicId = getScopeClinicId(scope);
  const groupId = getScopeGroupId(scope);

  const [clinicRecord, groupRecord] = await Promise.all([
    clinicId
      ? IntakeConfig.findOne({ where: { clinic_id: clinicId }, raw: true })
      : null,
    groupId
      ? IntakeConfig.findOne({ where: { group_id: groupId, assignment_scope: 'group' }, raw: true })
      : null
  ]);

  return {
    clinicRecord: clinicRecord || null,
    groupRecord: groupRecord || null
  };
}

function resolveEffectiveTrackingConfig(scope, records = {}) {
  const assignmentScope = getScopeAssignmentScope(scope);
  const clinicConfig = records?.clinicRecord?.config && typeof records.clinicRecord.config === 'object'
    ? records.clinicRecord.config
    : {};
  const groupConfig = records?.groupRecord?.config && typeof records.groupRecord.config === 'object'
    ? records.groupRecord.config
    : {};

  const groupGoogle = normalizeGoogleAdsConfig(groupConfig.google_ads);
  const clinicGoogle = normalizeGoogleAdsConfig(clinicConfig.google_ads);
  const effectiveGoogle = assignmentScope === 'group'
    ? groupGoogle
    : mergeGoogleAdsConfig(groupConfig.google_ads, clinicConfig.google_ads);
  const googleSource = assignmentScope === 'group'
    ? (hasGoogleAdsConfig(groupConfig.google_ads) ? 'group' : null)
    : hasGoogleAdsConfig(clinicConfig.google_ads)
      ? 'clinic'
      : hasGoogleAdsConfig(groupConfig.google_ads)
        ? 'group'
        : null;

  const groupMeta = normalizeMetaAdsConfig(groupConfig.meta_ads);
  const clinicMeta = normalizeMetaAdsConfig(clinicConfig.meta_ads);
  const effectiveMeta = assignmentScope === 'group'
    ? groupMeta
    : mergeMetaAdsConfig(groupMeta, clinicMeta);
  let metaSource = assignmentScope === 'group'
    ? (hasMetaAdsConfig(groupConfig.meta_ads) ? 'group' : null)
    : hasMetaAdsConfig(clinicConfig.meta_ads)
      ? 'clinic'
      : hasMetaAdsConfig(groupConfig.meta_ads)
        ? 'group'
        : null;

  const globalPixelId = cleanString(process.env.META_PIXEL_ID);
  const globalCapiToken = cleanString(process.env.META_CAPI_TOKEN);
  const effectivePixelId = effectiveMeta.pixel_id || globalPixelId || null;
  if (!metaSource && effectivePixelId) {
    metaSource = 'global';
  }

  return {
    google_ads: {
      ...effectiveGoogle,
      tag_id: extractGoogleTagId(effectiveGoogle.send_to),
      config_source: googleSource
    },
    meta_ads: {
      ...effectiveMeta,
      pixel_id: effectivePixelId,
      global_pixel_id: globalPixelId,
      has_global_capi_token: Boolean(globalCapiToken),
      config_source: metaSource
    }
  };
}

async function loadExplicitAssetAssignments(scope, assetTypes, dependencies = {}) {
  const assignmentModel = dependencies.assignmentModel || GroupAssetClinicAssignment;
  const clinicId = getScopeClinicId(scope);
  const groupId = getScopeGroupId(scope);
  if (!assignmentModel || !clinicId || getScopeAssignmentScope(scope) === 'group') {
    return [];
  }

  const normalizedTypes = (Array.isArray(assetTypes) ? assetTypes : [assetTypes])
    .map((value) => cleanString(value))
    .filter(Boolean);
  if (!normalizedTypes.length) return [];

  const where = {
    clinicaId: clinicId,
    assetType: normalizedTypes.length === 1
      ? normalizedTypes[0]
      : { [Op.in]: normalizedTypes }
  };
  if (groupId) where.grupoClinicaId = groupId;

  return assignmentModel.findAll({ where, raw: true });
}

async function loadGooglePropertyGroupPolicy(scope, dependencies = {}) {
  const groupId = getScopeGroupId(scope);
  const groupModel = dependencies.groupModel || GrupoClinica;
  if (!groupId || !groupModel) return null;

  return groupModel.findByPk(groupId, {
    attributes: [
      'id_grupo',
      'search_console_assignment_mode',
      'search_console_primary_asset_id',
      'analytics_assignment_mode',
      'analytics_primary_property_id',
      'business_profile_assignment_mode',
      'business_profile_primary_location_id'
    ],
    raw: true
  });
}

async function loadGooglePropertyAssignments(scope, dependencies = {}) {
  const assignmentModel = dependencies.assignmentModel || GroupAssetClinicAssignment;
  const groupId = getScopeGroupId(scope);
  if (!assignmentModel || !groupId) return [];

  const where = {
    grupoClinicaId: groupId,
    assetType: {
      [Op.in]: Object.values(GOOGLE_PROPERTY_ASSET_CONFIG).map((config) => config.assetType)
    }
  };
  const clinicId = getScopeClinicId(scope);
  if (getScopeAssignmentScope(scope) !== 'group' && clinicId) {
    where.clinicaId = clinicId;
  }
  return assignmentModel.findAll({ where, raw: true });
}

function buildGooglePropertyAssetWhere(scope, config, candidateAssetIds = []) {
  const clinicId = getScopeClinicId(scope);
  const clinicIds = getScopeClinicIds(scope);
  const or = [];

  if (getScopeAssignmentScope(scope) === 'group') {
    if (clinicIds.length) {
      or.push({ [config.clinicField]: { [Op.in]: clinicIds } });
    }
  } else if (clinicId) {
    or.push({ [config.clinicField]: clinicId });
  }

  const ids = Array.from(new Set(candidateAssetIds
    .map((value) => parseInteger(value))
    .filter((value) => Number.isInteger(value) && value > 0)));
  if (ids.length) or.push({ id: { [Op.in]: ids } });
  if (!or.length) return null;

  return {
    [config.activeField]: true,
    [Op.or]: or
  };
}

function annotateGooglePropertyRows(scope, config, rows, assignmentRows, groupPolicy) {
  const clinicId = getScopeClinicId(scope);
  const groupMode = cleanString(groupPolicy?.[config.modeField]) || 'clinic';
  const primaryId = groupMode === 'group'
    ? parseInteger(groupPolicy?.[config.primaryField])
    : null;
  const explicitlyAssignedIds = new Set((assignmentRows || [])
    .filter((assignment) => assignment.assetType === config.assetType)
    .map((assignment) => parseInteger(assignment.assetId))
    .filter(Boolean));

  return (rows || []).map((row) => {
    const rowId = parseInteger(row?.id);
    let origin = null;
    if (primaryId && rowId === primaryId) {
      origin = 'group';
    } else if (clinicId && parseInteger(row?.[config.clinicField]) === clinicId) {
      origin = 'clinic';
    } else if (explicitlyAssignedIds.has(rowId)) {
      origin = 'shared';
    } else if (getScopeAssignmentScope(scope) === 'group') {
      origin = 'clinic';
    }
    return origin ? { ...row, effectiveAssignmentOrigin: origin } : row;
  });
}

function googlePropertyIdentity(config, row) {
  const value = cleanString(row?.[config.identityField]);
  if (value) return value.toLowerCase().replace(/\/$/, '');
  const id = parseInteger(row?.id);
  return id ? `mapping:${id}` : null;
}

function serializeGoogleProperty(section, row, scope) {
  const common = {
    mapping_id: parseInteger(row.id),
    mapped_to_scope: true,
    assignment_origin: resolveAssetOrigin(row, scope),
    clinic_id: parseInteger(row.clinicaId ?? row.clinica_id),
    connection_id: parseInteger(row.googleConnectionId ?? row.google_connection_id)
  };

  if (section === 'search_console') {
    return {
      ...common,
      site_url: cleanString(row.siteUrl),
      property_type: cleanString(row.propertyType),
      permission_level: cleanString(row.permissionLevel),
      verified: parseBoolean(row.verified, true)
    };
  }
  if (section === 'analytics') {
    return {
      ...common,
      property_name: cleanString(row.propertyName),
      display_name: cleanString(row.propertyDisplayName),
      measurement_id: cleanString(row.measurementId)
    };
  }
  return {
    ...common,
    location_id: cleanString(row.location_id),
    name: cleanString(row.location_name),
    sync_status: cleanString(row.sync_status),
    verified: parseBoolean(row.is_verified, false),
    suspended: parseBoolean(row.is_suspended, false),
    last_synced_at: row.last_synced_at || null
  };
}

async function listScopedGoogleProperties(scope, dependencies = {}) {
  const [groupPolicy, assignmentRows] = await Promise.all([
    loadGooglePropertyGroupPolicy(scope, dependencies),
    loadGooglePropertyAssignments(scope, dependencies)
  ]);
  const propertyModels = dependencies.propertyModels || {};
  const result = {};

  for (const [section, config] of Object.entries(GOOGLE_PROPERTY_ASSET_CONFIG)) {
    const model = propertyModels[section] || config.model;
    if (!model) {
      result[section] = [];
      continue;
    }
    const relevantAssignments = groupPolicy?.[config.modeField] === 'group'
      ? []
      : assignmentRows.filter((assignment) => assignment.assetType === config.assetType);
    const primaryId = groupPolicy?.[config.modeField] === 'group'
      ? parseInteger(groupPolicy?.[config.primaryField])
      : null;
    const candidateIds = [
      ...relevantAssignments.map((assignment) => assignment.assetId),
      primaryId
    ].filter(Boolean);
    const where = buildGooglePropertyAssetWhere(scope, config, candidateIds);
    if (!where) {
      result[section] = [];
      continue;
    }

    const rawRows = await model.findAll({ where, raw: true });
    const rows = annotateGooglePropertyRows(
      scope,
      config,
      rawRows,
      relevantAssignments,
      groupPolicy
    );
    result[section] = dedupePreferred(
      scope,
      rows,
      (row) => googlePropertyIdentity(config, row)
    ).map((row) => serializeGoogleProperty(section, row, scope));
  }

  return result;
}

function markExplicitlyAssignedRows(scope, rows, assignmentRows, assetTypeForRow) {
  const clinicId = getScopeClinicId(scope);
  if (!clinicId || !Array.isArray(assignmentRows) || !assignmentRows.length) return rows;

  const assignmentKeys = new Set(assignmentRows.map((row) => (
    `${cleanString(row.assetType)}:${parseInteger(row.assetId)}`
  )));
  return rows.map((row) => {
    if (parseInteger(row?.clinicaId) === clinicId) return row;
    if (
      String(row?.assignmentScope || '').trim().toLowerCase() === 'group'
      && parseInteger(row?.grupoClinicaId) === getScopeGroupId(scope)
    ) {
      return row;
    }
    const assetType = assetTypeForRow(row);
    const key = `${cleanString(assetType)}:${parseInteger(row?.id)}`;
    return assignmentKeys.has(key)
      ? { ...row, effectiveAssignmentOrigin: 'shared' }
      : row;
  });
}

async function listScopedMetaAssets(scope, dependencies = {}) {
  const assetModel = dependencies.assetModel || ClinicMetaAsset;
  const assignmentRows = await loadExplicitAssetAssignments(
    scope,
    Object.values(META_GROUP_ASSET_TYPE_BY_ASSET_TYPE),
    dependencies
  );
  const explicitAssetIds = assignmentRows.map((row) => row.assetId);
  const rawRows = await assetModel.findAll({
    where: {
      isActive: true,
      assetType: { [Op.in]: ['facebook_page', 'instagram_business', 'ad_account'] },
      ...buildScopedAssetWhere(scope, explicitAssetIds)
    },
    order: [['updatedAt', 'DESC']],
    raw: true
  });
  const rows = markExplicitlyAssignedRows(
    scope,
    rawRows,
    assignmentRows,
    (row) => META_GROUP_ASSET_TYPE_BY_ASSET_TYPE[row.assetType]
  );

  const adAccounts = dedupePreferred(scope, rows.filter((row) => row.assetType === 'ad_account'), (row) => normalizeMetaAdAccountId(row.metaAssetId));
  const facebookPages = dedupePreferred(scope, rows.filter((row) => row.assetType === 'facebook_page'), (row) => cleanString(row.metaAssetId));
  const instagramAccounts = dedupePreferred(scope, rows.filter((row) => row.assetType === 'instagram_business'), (row) => cleanString(row.metaAssetId));

  return {
    ad_accounts: adAccounts.map((row) => ({
      ad_account_id: normalizeMetaAdAccountId(row.metaAssetId),
      name: row.metaAssetName || null,
      mapped_to_scope: true,
      assignment_origin: resolveAssetOrigin(row, scope),
      connection_id: parseInteger(row.metaConnectionId),
      clinic_id: parseInteger(row.clinicaId),
      group_id: parseInteger(row.grupoClinicaId),
      mapping_id: parseInteger(row.id)
    })),
    facebook_pages: facebookPages.map((row) => ({
      page_id: cleanString(row.metaAssetId),
      name: row.metaAssetName || null,
      mapped_to_scope: true,
      assignment_origin: resolveAssetOrigin(row, scope),
      connection_id: parseInteger(row.metaConnectionId),
      clinic_id: parseInteger(row.clinicaId),
      group_id: parseInteger(row.grupoClinicaId),
      mapping_id: parseInteger(row.id)
    })),
    instagram_business: instagramAccounts.map((row) => ({
      instagram_business_id: cleanString(row.metaAssetId),
      name: row.metaAssetName || null,
      mapped_to_scope: true,
      assignment_origin: resolveAssetOrigin(row, scope),
      connection_id: parseInteger(row.metaConnectionId),
      clinic_id: parseInteger(row.clinicaId),
      group_id: parseInteger(row.grupoClinicaId),
      mapping_id: parseInteger(row.id)
    }))
  };
}

function pickEffectiveMetaAsset(metaAssets, metaConfig) {
  const effectiveAdAccount = metaConfig?.ad_account_id
    ? metaAssets.ad_accounts.find((item) => item.ad_account_id === metaConfig.ad_account_id) || null
    : metaAssets.ad_accounts[0] || null;

  const effectivePage = metaAssets.facebook_pages[0] || null;
  const effectiveInstagram = metaAssets.instagram_business[0] || null;

  return {
    ad_account: effectiveAdAccount,
    facebook_page: effectivePage,
    instagram_business: effectiveInstagram,
    pixel: {
      pixel_id: metaConfig?.pixel_id || null,
      assignment_origin: metaConfig?.config_source || null,
      connection_id: metaConfig?.connection_id || effectiveAdAccount?.connection_id || null
    }
  };
}

async function listScopedGoogleAccounts(scope, dependencies = {}) {
  const accountModel = dependencies.accountModel || ClinicGoogleAdsAccount;
  const assignmentRows = await loadExplicitAssetAssignments(
    scope,
    GROUP_ASSET_TYPES.GOOGLE_ADS_ACCOUNT,
    dependencies
  );
  const explicitAssetIds = assignmentRows.map((row) => row.assetId);
  const rawRows = await accountModel.findAll({
    where: {
      isActive: true,
      ...buildScopedAssetWhere(scope, explicitAssetIds)
    },
    order: [['updated_at', 'DESC']],
    raw: true
  });
  const rows = markExplicitlyAssignedRows(
    scope,
    rawRows,
    assignmentRows,
    () => GROUP_ASSET_TYPES.GOOGLE_ADS_ACCOUNT
  );

  const deduped = dedupePreferred(scope, rows, (row) => cleanGoogleCustomerId(row.customerId));
  return deduped.map((row) => {
    const customerId = cleanGoogleCustomerId(row.customerId);
    return {
      customer_id: customerId,
      formatted_customer_id: customerId
        ? `${customerId.slice(0, 3)}-${customerId.slice(3, 6)}-${customerId.slice(6)}`
        : null,
      descriptive_name: row.descriptiveName || null,
      currency_code: row.currencyCode || null,
      time_zone: row.timeZone || null,
      is_linked: row.managerLinkStatus === 'ACTIVE',
      manager_link_status: row.managerLinkStatus || null,
      mapped_to_scope: true,
      login_customer_id: cleanGoogleCustomerId(row.loginCustomerId || row.managerCustomerId) || null,
      assignment_origin: resolveAssetOrigin(row, scope),
      connection_id: parseInteger(row.googleConnectionId),
      clinic_id: parseInteger(row.clinicaId),
      group_id: parseInteger(row.grupoClinicaId),
      mapping_id: parseInteger(row.id),
      last_synced_at: row.lastSyncedAt || row.last_synced_at || null
    };
  });
}

function pickEffectiveGoogleAccount(googleAccounts, googleConfig) {
  const selected = googleConfig?.customer_id
    ? googleAccounts.find((item) => item.customer_id === googleConfig.customer_id) || null
    : googleAccounts[0] || null;

  return {
    account: selected,
    tag_id: extractGoogleTagId(googleConfig?.send_to)
  };
}

async function listMetaPixelsForScopeAdAccount({ scope, adAccountId, connectionId = null }) {
  const normalizedAccountId = normalizeMetaAdAccountId(adAccountId);
  if (!normalizedAccountId) return [];

  let resolvedConnectionId = parseInteger(connectionId);
  if (!resolvedConnectionId) {
    const metaAssets = await listScopedMetaAssets(scope);
    const matchingAccount = metaAssets.ad_accounts.find((item) => item.ad_account_id === normalizedAccountId) || null;
    resolvedConnectionId = matchingAccount?.connection_id || null;
  }

  if (!resolvedConnectionId) {
    return [];
  }

  const connection = await MetaConnection.findByPk(resolvedConnectionId, {
    attributes: ['id', 'accessToken'],
    raw: true
  });
  if (!connection?.accessToken) {
    return [];
  }

  const response = await metaGet(`${normalizedAccountId}/adspixels`, {
    accessToken: connection.accessToken,
    params: {
      fields: 'id,name,creation_time,business{id,name},is_created_by_business',
      limit: 200
    },
    timeout: 15000
  });

  const rows = Array.isArray(response?.data?.data) ? response.data.data : [];
  return rows.map((row) => ({
    pixel_id: cleanString(row.id),
    name: row.name || null,
    creation_time: row.creation_time || null,
    business_id: cleanString(row?.business?.id),
    business_name: row?.business?.name || null,
    is_created_by_business: row?.is_created_by_business === true
  }));
}

async function resolveEffectiveMarketingAssetInventory(
  { clinicIdRaw = null, groupIdRaw = null, assignmentScopeRaw = null },
  dependencies = {}
) {
  const normalizeScopeFn = dependencies.normalizeScope || normalizeScope;
  const clinicModel = dependencies.clinicModel || Clinica;
  const normalizedScope = await normalizeScopeFn({ clinicIdRaw, groupIdRaw, assignmentScopeRaw });
  const scope = {
    assignment_scope: normalizedScope.assignmentScope,
    clinic_id: normalizedScope.clinicId,
    group_id: normalizedScope.groupId,
    clinic_ids: normalizedScope.groupId
      ? ((await clinicModel.findAll({
        where: { grupoClinicaId: normalizedScope.groupId },
        attributes: ['id_clinica'],
        raw: true
      })).map((row) => parseInteger(row.id_clinica)).filter(Boolean))
      : (normalizedScope.clinicId ? [normalizedScope.clinicId] : [])
  };

  const descriptorLoader = dependencies.loadScopeDescriptors || loadScopeDescriptors;
  const intakeLoader = dependencies.loadScopeIntakeRecords || loadScopeIntakeRecords;
  const metaAssetLoader = dependencies.listScopedMetaAssets || listScopedMetaAssets;
  const googleAccountLoader = dependencies.listScopedGoogleAccounts || listScopedGoogleAccounts;
  const googlePropertyLoader = dependencies.listScopedGoogleProperties || listScopedGoogleProperties;
  const [descriptors, records, metaAssets, googleAccounts, googleProperties] = await Promise.all([
    descriptorLoader(scope),
    intakeLoader(scope),
    metaAssetLoader(scope, dependencies),
    googleAccountLoader(scope, dependencies),
    googlePropertyLoader(scope, dependencies)
  ]);

  const tracking = resolveEffectiveTrackingConfig(scope, records);
  const effectiveMeta = pickEffectiveMetaAsset(metaAssets, tracking.meta_ads);
  const effectiveGoogle = pickEffectiveGoogleAccount(googleAccounts, tracking.google_ads);

  return {
    scope,
    descriptors,
    records,
    tracking,
    meta: {
      available_assets: metaAssets,
      effective_assets: effectiveMeta
    },
    google: {
      available_accounts: googleAccounts,
      available_assets: googleProperties,
      effective_assets: {
        ...effectiveGoogle,
        search_console: googleProperties.search_console?.[0] || null,
        analytics: googleProperties.analytics?.[0] || null,
        business_profile: googleProperties.business_profile?.[0] || null
      }
    }
  };
}

function buildEffectiveGoogleMappingMetadata(asset, scope, descriptors = {}) {
  const assignmentOrigin = cleanString(asset?.assignment_origin) || 'clinic';
  const ownerClinicId = parseInteger(asset?.clinic_id);
  const groupId = parseInteger(asset?.group_id) || getScopeGroupId(scope);
  const isClinicScope = getScopeAssignmentScope(scope) === 'clinic';
  const targetClinicId = isClinicScope
    ? getScopeClinicId(scope)
    : null;

  return {
    ...asset,
    assignment_origin: assignmentOrigin,
    inherited: assignmentOrigin === 'shared' || (isClinicScope && assignmentOrigin === 'group'),
    read_only: true,
    target_clinic_id: targetClinicId,
    owner_clinic_id: ownerClinicId,
    source_scope: {
      type: assignmentOrigin,
      clinic_id: assignmentOrigin === 'group' ? null : ownerClinicId,
      group_id: groupId,
      group_name: descriptors?.group_name || null
    }
  };
}

function buildEffectiveGoogleMappings(inventory) {
  const scope = inventory?.scope || {};
  const descriptors = inventory?.descriptors || {};
  const properties = inventory?.google?.available_assets || {};
  const decorate = (items) => (Array.isArray(items) ? items : [])
    .map((asset) => buildEffectiveGoogleMappingMetadata(asset, scope, descriptors));

  return {
    scope,
    descriptors,
    effective_mappings: {
      search_console: decorate(properties.search_console),
      analytics: decorate(properties.analytics),
      business_profile: decorate(properties.business_profile),
      google_ads: decorate(inventory?.google?.available_accounts)
    }
  };
}

async function resolveEffectiveGoogleMappings(params, dependencies = {}) {
  const inventoryResolver = dependencies.resolveEffectiveMarketingAssetInventory
    || resolveEffectiveMarketingAssetInventory;
  const inventory = await inventoryResolver(params, dependencies);
  return buildEffectiveGoogleMappings(inventory);
}

async function resolveEffectiveMarketingState(
  { clinicIdRaw = null, groupIdRaw = null, assignmentScopeRaw = null },
  dependencies = {}
) {
  const params = { clinicIdRaw, groupIdRaw, assignmentScopeRaw };
  const inventoryResolver = dependencies.resolveEffectiveMarketingAssetInventory
    || resolveEffectiveMarketingAssetInventory;
  const inventory = await inventoryResolver(params, dependencies);
  const scope = inventory.scope;
  const metaConnectionResolver = dependencies.resolveMetaConnectionForScope
    || resolveMetaConnectionForScope;
  const googleConnectionResolver = dependencies.resolveGoogleConnectionForScope
    || resolveGoogleConnectionForScope;
  const [metaConnectionResolution, googleConnectionResolution] = await Promise.all([
    metaConnectionResolver({
      clinicIdRaw: scope.clinic_id,
      groupIdRaw: scope.group_id,
      assignmentScopeRaw: scope.assignment_scope,
      allowLegacyUserFallback: true
    }),
    googleConnectionResolver({
      clinicIdRaw: scope.clinic_id,
      groupIdRaw: scope.group_id,
      assignmentScopeRaw: scope.assignment_scope,
      allowLegacyUserFallback: true
    })
  ]);

  return {
    ...inventory,
    meta: {
      ...inventory.meta,
      connection: metaConnectionResolution?.connection || null,
      connection_source: metaConnectionResolution?.source || null
    },
    google: {
      ...inventory.google,
      connection: googleConnectionResolution?.connection || null,
      connection_source: googleConnectionResolution?.source || null
    }
  };
}

module.exports = {
  extractGoogleTagId,
  mergeGoogleAdsConfig,
  mergeProvisionedGoogleAdsConfig,
  normalizeMetaAdAccountId,
  normalizeMetaAdsConfig,
  normalizeGoogleAdsConfig,
  normalizeGoogleAdsDestinations,
  loadScopeIntakeRecords,
  resolveEffectiveTrackingConfig,
  listScopedMetaAssets,
  listScopedGoogleAccounts,
  listScopedGoogleProperties,
  loadExplicitAssetAssignments,
  pickEffectiveMetaAsset,
  pickEffectiveGoogleAccount,
  listMetaPixelsForScopeAdAccount,
  resolveEffectiveMarketingAssetInventory,
  resolveEffectiveGoogleMappings,
  buildEffectiveGoogleMappings,
  buildEffectiveGoogleMappingMetadata,
  resolveEffectiveMarketingState
};
