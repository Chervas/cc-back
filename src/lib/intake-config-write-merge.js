'use strict';

const EDITOR_FEATURE_KEYS = Object.freeze([
  'chat_enabled',
  'tel_modal_enabled',
  'viewcontent_enabled',
  'form_intercept_enabled',
  'webevents_enabled',
  'consent_mode_enabled',
  'consent_provider',
  'external_cmp_provider',
]);

const EDITOR_GOOGLE_ADS_KEYS = Object.freeze([
  ['enabled', null],
  ['customer_id', 'customerId'],
  ['conversion_action', 'conversionAction'],
  ['conversion_action_id', 'conversionActionId'],
  ['send_to', 'sendTo'],
  ['currency', null],
]);

// These are the only events and fields exposed by Marketing > Web. In
// particular qualified_lead, destinations, values and enhanced-conversion
// policy state remain server-owned even if an old browser echoes them back.
const EDITOR_GOOGLE_ADS_EVENTS = Object.freeze(['lead', 'contact', 'schedule', 'purchase']);
const EDITOR_GOOGLE_ADS_EVENT_KEYS = Object.freeze([
  ['enabled', null],
  ['conversion_action_id', 'conversionActionId'],
  ['currency', null],
]);

const NORMALIZED_GOOGLE_ADS_KEYS = Object.freeze([
  'enabled',
  'customer_id',
  'conversion_action',
  'conversion_action_id',
  'send_to',
  'currency',
]);

function isPlainObject(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function hasOwnAlias(source, snakeKey, camelKey) {
  return Object.prototype.hasOwnProperty.call(source, snakeKey)
    || Boolean(camelKey && Object.prototype.hasOwnProperty.call(source, camelKey));
}

/**
 * Applies a normalized Google Ads patch without replacing the raw persisted
 * object. Unknown/current fields survive, including gate state introduced by
 * newer backend versions.
 */
function overlayNormalizedGoogleAdsConfig(currentConfig, normalizedConfig) {
  const current = isPlainObject(currentConfig) ? currentConfig : {};
  const normalized = isPlainObject(normalizedConfig) ? normalizedConfig : {};
  const next = { ...current };
  for (const key of NORMALIZED_GOOGLE_ADS_KEYS) {
    if (Object.prototype.hasOwnProperty.call(normalized, key)) next[key] = normalized[key];
  }

  const currentEvents = isPlainObject(current.events) ? current.events : {};
  const normalizedEvents = isPlainObject(normalized.events) ? normalized.events : {};
  const nextEvents = { ...currentEvents };
  for (const [eventName, normalizedEvent] of Object.entries(normalizedEvents)) {
    if (!isPlainObject(normalizedEvent)) continue;
    nextEvents[eventName] = {
      ...(isPlainObject(currentEvents[eventName]) ? currentEvents[eventName] : {}),
      ...normalizedEvent,
    };
  }
  next.events = nextEvents;
  return next;
}

function mergeIntakeEditorGoogleAdsConfig(currentConfig, incomingConfig, normalizeGoogleAdsConfig) {
  const current = isPlainObject(currentConfig) ? currentConfig : {};
  const incoming = isPlainObject(incomingConfig) ? incomingConfig : {};
  const normalized = normalizeGoogleAdsConfig(incoming);
  const next = { ...current };

  for (const [snakeKey, camelKey] of EDITOR_GOOGLE_ADS_KEYS) {
    if (hasOwnAlias(incoming, snakeKey, camelKey)) next[snakeKey] = normalized[snakeKey];
  }

  const currentEvents = isPlainObject(current.events) ? current.events : {};
  const incomingEvents = isPlainObject(incoming.events) ? incoming.events : {};
  const normalizedEvents = isPlainObject(normalized.events) ? normalized.events : {};
  const nextEvents = { ...currentEvents };
  for (const eventName of EDITOR_GOOGLE_ADS_EVENTS) {
    const rawEvent = incomingEvents[eventName];
    const normalizedEvent = normalizedEvents[eventName];
    if (!isPlainObject(rawEvent) || !isPlainObject(normalizedEvent)) continue;
    const nextEvent = {
      ...(isPlainObject(currentEvents[eventName]) ? currentEvents[eventName] : {}),
    };
    for (const [snakeKey, camelKey] of EDITOR_GOOGLE_ADS_EVENT_KEYS) {
      if (hasOwnAlias(rawEvent, snakeKey, camelKey)) nextEvent[snakeKey] = normalizedEvent[snakeKey];
    }
    nextEvents[eventName] = nextEvent;
  }
  next.events = nextEvents;
  return next;
}

function mergeIntakeEditorFeatures(currentFeatures, incomingFeatures) {
  const current = isPlainObject(currentFeatures) ? currentFeatures : {};
  const incoming = isPlainObject(incomingFeatures) ? incomingFeatures : {};
  const next = { ...current };
  for (const key of EDITOR_FEATURE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(incoming, key)) next[key] = incoming[key];
  }
  return next;
}

function mergeIntakeConfigForEditorWrite(
  existingConfig,
  body,
  normalizeGoogleAdsConfig,
  normalizeMetaAdsConfig = null,
) {
  const current = isPlainObject(existingConfig) ? existingConfig : {};
  const requestBody = isPlainObject(body) ? body : {};
  const source = isPlainObject(requestBody.config) ? requestBody.config : requestBody;
  const next = { ...current };

  if (isPlainObject(source.features)) {
    next.features = mergeIntakeEditorFeatures(current.features, source.features);
  }
  if (isPlainObject(source.flow)) next.flow = source.flow;
  if (Array.isArray(source.flows)) next.flows = source.flows;
  if (isPlainObject(source.appearance)) next.appearance = source.appearance;
  if (isPlainObject(source.texts)) next.texts = source.texts;
  if (Array.isArray(source.locations)) next.locations = source.locations;
  if (isPlainObject(source.google_ads)) {
    next.google_ads = mergeIntakeEditorGoogleAdsConfig(
      current.google_ads,
      source.google_ads,
      normalizeGoogleAdsConfig,
    );
  }
  if (isPlainObject(source.meta_ads) && typeof normalizeMetaAdsConfig === 'function') {
    next.meta_ads = {
      ...(isPlainObject(current.meta_ads) ? current.meta_ads : {}),
      ...normalizeMetaAdsConfig(source.meta_ads),
    };
  }
  return next;
}

module.exports = {
  mergeIntakeConfigForEditorWrite,
  mergeIntakeEditorFeatures,
  mergeIntakeEditorGoogleAdsConfig,
  overlayNormalizedGoogleAdsConfig,
};
