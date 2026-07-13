'use strict';

const crypto = require('crypto');
const db = require('../../models');
const {
  GOOGLE_DATA_MANAGER_SCOPE,
  GOOGLE_ENHANCED_CONVERSION_ALLOWED_IDENTIFIERS,
  GOOGLE_ENHANCED_CONVERSION_POLICY_MODE,
  GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_CUSTOMER_IDS,
  GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_EVENTS,
  buildEnhancedConversionUserIdentifiers,
  uploadConversionEvent
} = require('./googleDataManagerConversion.service');
const { resolveScopedGoogleAdsRuntime } = require('./googleAdsScopedRuntime.service');
const { extractGoogleLeadIdentity } = require('../lib/google-lead-routing');

const GOOGLE_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

function cleanString(raw) {
  if (raw === undefined || raw === null) return null;
  const value = String(raw).trim();
  return value || null;
}

function cleanGoogleCustomerId(raw) {
  const value = String(raw || '').replace(/\D/g, '');
  return value || null;
}

function parseInteger(raw) {
  if (raw === undefined || raw === null || raw === '') return null;
  const value = Number.parseInt(String(raw), 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

function coalesce(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function toGoogleAdsDateTime(value) {
  if (typeof value === 'string' && GOOGLE_DATETIME_REGEX.test(value.trim())) return value.trim();
  const parsed = value instanceof Date ? value : new Date(value || Date.now());
  const date = Number.isFinite(parsed.getTime()) ? parsed : new Date();
  const pad = (number) => String(number).padStart(2, '0');
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${sign}${pad(Math.floor(absoluteOffset / 60))}:${pad(absoluteOffset % 60)}`;
}

function normalizeGoogleConsent(consent) {
  if (consent === undefined || consent === null) return null;
  const fromValue = (value) => {
    if (value === undefined || value === null) return null;
    if (typeof value === 'boolean') return value ? 'GRANTED' : 'DENIED';
    const normalized = String(value).trim().toLowerCase();
    if (['granted', 'grant', 'accepted', 'accept', 'yes', 'true', '1', 'optin', 'opt_in'].includes(normalized)) return 'GRANTED';
    if (['denied', 'deny', 'rejected', 'reject', 'no', 'false', '0', 'optout', 'opt_out'].includes(normalized)) return 'DENIED';
    return null;
  };
  if (typeof consent !== 'object' || Array.isArray(consent)) return fromValue(consent);
  // Contact/phone/WhatsApp and analytics permissions are separate purposes. They
  // must never be promoted to permission to send advertising conversions.
  const statuses = [
    fromValue(consent.ad_user_data ?? consent.adUserData),
    fromValue(consent.marketing)
  ].filter(Boolean);
  if (statuses.includes('DENIED')) return 'DENIED';
  if (statuses.includes('GRANTED')) return 'GRANTED';
  return null;
}

function mergeGoogleConsent(...values) {
  const statuses = values.map(normalizeGoogleConsent).filter(Boolean);
  if (statuses.includes('DENIED')) return 'DENIED';
  if (statuses.includes('GRANTED')) return 'GRANTED';
  return null;
}

function mergeExplicitGoogleAdvertisingConsent(...values) {
  return mergeGoogleConsent(...values.filter((value) => (
    value
      && typeof value === 'object'
      && !Array.isArray(value)
      && (
        Object.prototype.hasOwnProperty.call(value, 'ad_user_data')
        || Object.prototype.hasOwnProperty.call(value, 'adUserData')
        || Object.prototype.hasOwnProperty.call(value, 'marketing')
      )
  )));
}

function normalizeExplicitAdUserDataConsent(...values) {
  const statuses = [];
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const hasSnakeCase = Object.prototype.hasOwnProperty.call(value, 'ad_user_data');
    const hasCamelCase = Object.prototype.hasOwnProperty.call(value, 'adUserData');
    if (!hasSnakeCase && !hasCamelCase) continue;
    for (const candidate of [
      ...(hasSnakeCase ? [value.ad_user_data] : []),
      ...(hasCamelCase ? [value.adUserData] : [])
    ]) {
      const status = normalizeGoogleConsent({ ad_user_data: candidate });
      if (status) statuses.push(status);
    }
  }
  if (statuses.includes('DENIED')) return 'DENIED';
  if (statuses.includes('GRANTED')) return 'GRANTED';
  return null;
}

function normalizeExplicitAdPersonalizationConsent(...values) {
  const explicitStatuses = [];
  const marketingFallbacks = [];
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const hasSnakeCase = Object.prototype.hasOwnProperty.call(value, 'ad_personalization');
    const hasCamelCase = Object.prototype.hasOwnProperty.call(value, 'adPersonalization');
    for (const candidate of [
      ...(hasSnakeCase ? [value.ad_personalization] : []),
      ...(hasCamelCase ? [value.adPersonalization] : [])
    ]) {
      const status = normalizeGoogleConsent(candidate);
      if (status) explicitStatuses.push(status);
    }
    if (Object.prototype.hasOwnProperty.call(value, 'marketing')) {
      const status = normalizeGoogleConsent(value.marketing);
      if (status) marketingFallbacks.push(status);
    }
  }
  const statuses = explicitStatuses.length ? explicitStatuses : marketingFallbacks;
  if (statuses.includes('DENIED')) return 'DENIED';
  if (statuses.includes('GRANTED')) return 'GRANTED';
  return null;
}

function parseSendToActionId(sendTo) {
  const value = cleanString(sendTo);
  if (!value) return null;
  const parts = value.split('/');
  const candidate = parts.length > 1 ? String(parts[1] || '').trim() : '';
  return /^\d+$/.test(candidate) ? candidate : null;
}

function buildConversionActionResource({ customerId, conversionAction, conversionActionId, sendTo }) {
  const cleanCustomer = cleanGoogleCustomerId(customerId);
  if (!cleanCustomer) return null;
  const rawAction = cleanString(conversionAction);
  if (rawAction?.startsWith('customers/')) {
    const match = rawAction.match(/^customers\/(\d+)\/conversionActions\/(\d+)$/);
    return match && match[1] === cleanCustomer ? rawAction : null;
  }
  if (rawAction && /^\d+$/.test(rawAction)) {
    return `customers/${cleanCustomer}/conversionActions/${rawAction}`;
  }
  const actionId = (/^\d+$/.test(String(conversionActionId || '').trim())
    ? String(conversionActionId).trim()
    : null) || parseSendToActionId(sendTo);
  return actionId ? `customers/${cleanCustomer}/conversionActions/${actionId}` : null;
}

function normalizeGoogleAdsConfig(rawConfig) {
  if (!rawConfig || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) return {};
  return {
    ...rawConfig,
    customer_id: cleanGoogleCustomerId(rawConfig.customer_id || rawConfig.customerId),
    conversion_action: cleanString(rawConfig.conversion_action || rawConfig.conversionAction),
    conversion_action_id: cleanString(rawConfig.conversion_action_id || rawConfig.conversionActionId),
    send_to: cleanString(rawConfig.send_to || rawConfig.sendTo),
    currency: cleanString(rawConfig.currency)
  };
}

function normalizeGoogleAdsActionTarget(rawTarget = {}) {
  const target = rawTarget && typeof rawTarget === 'object' && !Array.isArray(rawTarget)
    ? rawTarget
    : {};
  return {
    conversion_action: cleanString(target.conversion_action ?? target.conversionAction),
    conversion_action_id: cleanString(target.conversion_action_id ?? target.conversionActionId),
    send_to: cleanString(target.send_to ?? target.sendTo)
  };
}

function resolveGoogleAdsActionTarget(...rawTargets) {
  for (const rawTarget of rawTargets) {
    const target = normalizeGoogleAdsActionTarget(rawTarget);
    if (target.conversion_action || target.conversion_action_id || target.send_to) return target;
  }
  return {
    conversion_action: null,
    conversion_action_id: null,
    send_to: null
  };
}

function normalizeConfiguredCampaignIds(...values) {
  const normalized = [];
  for (const value of values) {
    const candidates = Array.isArray(value) ? value : [value];
    for (const candidate of candidates) {
      const cleaned = cleanGoogleCustomerId(candidate);
      if (cleaned && !normalized.includes(cleaned)) normalized.push(cleaned);
    }
  }
  return normalized;
}

function getBaseGoogleAdsEventConfig(googleAdsConfig, eventName) {
  const eventKey = String(eventName || '').trim().toLowerCase();
  const mapped = eventKey === ''
    ? 'lead'
    : ['lead', 'contact', 'qualified_lead', 'schedule', 'purchase'].includes(eventKey)
      ? eventKey
      : null;
  if (!mapped) return null;
  const rawEvents = googleAdsConfig?.events && typeof googleAdsConfig.events === 'object'
    ? googleAdsConfig.events
    : {};
  const hasExplicitEventConfig = Object.prototype.hasOwnProperty.call(rawEvents, mapped);
  const nested = hasExplicitEventConfig
    ? (rawEvents[mapped] || {})
    : {};
  // An action resource, action id and send_to are alternative representations
  // of one target. Resolve them as a unit so an event-specific id cannot be
  // paired with (and then shadowed by) the legacy global Lead resource.
  const actionTarget = resolveGoogleAdsActionTarget(
    nested,
    {
      conversion_action: googleAdsConfig[`${mapped}_conversion_action`],
      conversion_action_id: googleAdsConfig[`${mapped}_conversion_action_id`],
      send_to: googleAdsConfig[`${mapped}_send_to`]
    },
    // `qualified_lead` nunca puede heredar la acción global legacy de Lead:
    // solo existe si su acción CRM está mapeada de forma explícita.
    mapped === 'qualified_lead' ? null : googleAdsConfig
  );
  return {
    event_name: mapped,
    enabled: googleAdsConfig.enabled !== false
      && nested.enabled !== false
      && (mapped !== 'qualified_lead' || hasExplicitEventConfig),
    customer_id: cleanGoogleCustomerId(
      nested.customer_id
        ?? nested.customerId
        ?? googleAdsConfig[`${mapped}_customer_id`]
        ?? googleAdsConfig.customer_id
    ),
    conversion_action: actionTarget.conversion_action,
    conversion_action_id: actionTarget.conversion_action_id,
    send_to: actionTarget.send_to,
    value: coalesce(nested.value, googleAdsConfig[`${mapped}_value`], googleAdsConfig.value, mapped === 'purchase' ? null : 0),
    currency: coalesce(nested.currency, googleAdsConfig[`${mapped}_currency`], googleAdsConfig.currency, 'EUR'),
    phone_country_code: cleanGoogleCustomerId(
      nested.phone_country_code
        ?? nested.phoneCountryCode
        ?? googleAdsConfig[`${mapped}_phone_country_code`]
        ?? googleAdsConfig.phone_country_code
        ?? googleAdsConfig.phoneCountryCode
    ),
    user_properties: nested.user_properties
      ?? nested.userProperties
      ?? googleAdsConfig[`${mapped}_user_properties`]
      ?? googleAdsConfig.user_properties
      ?? googleAdsConfig.userProperties
      ?? null,
    user_data_enabled: nested.user_data_enabled === true
      || nested.userDataEnabled === true
      || googleAdsConfig[`${mapped}_user_data_enabled`] === true
      || googleAdsConfig.user_data_enabled === true
      || googleAdsConfig.userDataEnabled === true,
    campaign_ids: normalizeConfiguredCampaignIds(
      nested.campaign_ids,
      nested.campaignIds,
      nested.campaign_id,
      nested.campaignId
    ),
    consent: normalizeGoogleConsent(
      nested.consent
        ?? googleAdsConfig[`${mapped}_consent`]
        ?? googleAdsConfig.consent
    )
  };
}

function getGoogleAdsEventConfigs(googleAdsConfig, eventName) {
  const base = getBaseGoogleAdsEventConfig(googleAdsConfig, eventName);
  if (!base) return [];
  const nested = googleAdsConfig?.events && typeof googleAdsConfig.events === 'object'
    ? (googleAdsConfig.events[base.event_name] || {})
    : {};
  const hasExplicitDestinations = Object.prototype.hasOwnProperty.call(nested, 'destinations');
  if (!hasExplicitDestinations) {
    return [{
      ...base,
      destination_key: `legacy_${base.customer_id || base.event_name}`
    }];
  }
  if (!Array.isArray(nested.destinations) || nested.destinations.length === 0) return [];

  const destinations = [];
  const seenTargets = new Set();
  for (let index = 0; index < nested.destinations.length; index += 1) {
    const raw = nested.destinations[index];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const customerId = cleanGoogleCustomerId(raw.customer_id || raw.customerId);
    const canInheritBaseAction = customerId && customerId === base.customer_id;
    const actionTarget = resolveGoogleAdsActionTarget(
      raw,
      canInheritBaseAction ? base : null
    );
    const destination = {
      event_name: base.event_name,
      destination_key: truncate(
        raw.key || raw.destination_key || raw.destinationKey || `destination_${customerId || index + 1}`,
        128
      ),
      enabled: base.enabled && raw.enabled !== false,
      customer_id: customerId,
      conversion_action: actionTarget.conversion_action,
      conversion_action_id: actionTarget.conversion_action_id,
      send_to: actionTarget.send_to,
      value: coalesce(raw.value, base.value),
      currency: coalesce(raw.currency, base.currency, 'EUR'),
      phone_country_code: cleanGoogleCustomerId(
        raw.phone_country_code ?? raw.phoneCountryCode ?? base.phone_country_code
      ),
      user_properties: raw.user_properties ?? raw.userProperties ?? base.user_properties ?? null,
      user_data_enabled: raw.user_data_enabled === true
        || raw.userDataEnabled === true
        || base.user_data_enabled === true,
      campaign_ids: normalizeConfiguredCampaignIds(
        raw.campaign_ids,
        raw.campaignIds,
        raw.campaign_id,
        raw.campaignId,
        base.campaign_ids
      ),
      consent: normalizeGoogleConsent(raw.consent) || base.consent || null
    };
    const canonicalAction = buildConversionActionResource({
      customerId: destination.customer_id,
      conversionAction: destination.conversion_action,
      conversionActionId: destination.conversion_action_id,
      sendTo: destination.send_to
    });
    const identity = canonicalAction
      ? `${destination.customer_id}|${canonicalAction}`
      : [
          destination.customer_id,
          destination.conversion_action,
          destination.conversion_action_id,
          destination.send_to
        ].join('|');
    if (seenTargets.has(identity)) continue;
    seenTargets.add(identity);
    destinations.push(destination);
  }
  return destinations;
}

function getGoogleAdsEventConfig(googleAdsConfig, eventName) {
  return getGoogleAdsEventConfigs(googleAdsConfig, eventName)[0];
}

function selectClickId(customData = {}) {
  for (const type of ['gclid', 'gbraid', 'wbraid']) {
    const value = cleanString(customData[type]);
    if (value) return { type, value, hash: sha256(value) };
  }
  return null;
}

function buildConversionUploadDedupeKey({
  customerId,
  conversionAction,
  eventName,
  eventId,
  clickIdHash,
  userIdentifierHash
}) {
  return sha256([
    cleanGoogleCustomerId(customerId) || 'missing-customer',
    cleanString(conversionAction) || 'missing-action',
    cleanString(eventName) || 'lead',
    cleanString(eventId) || 'missing-event-id',
    cleanString(clickIdHash) || cleanString(userIdentifierHash) || 'missing-identifiers'
  ].join('|'));
}

function selectConfiguredEventConfigs(eventConfigs = [], customData = {}) {
  const configured = Array.isArray(eventConfigs) ? eventConfigs : [];
  if (!configured.length) return { configs: [], reason: null, selector: null };

  const requestedIdentity = extractGoogleLeadIdentity(customData);
  const requestedCustomerId = requestedIdentity.customerId;
  let candidates = configured;
  if (requestedCustomerId) {
    candidates = configured.filter((item) => item.customer_id === requestedCustomerId);
    if (!candidates.length) {
      return {
        configs: [],
        reason: 'request_customer_not_configured',
        selector: { customer_id: requestedCustomerId }
      };
    }
  }

  if (candidates.length === 1) {
    return {
      configs: candidates,
      reason: null,
      selector: requestedCustomerId ? { customer_id: requestedCustomerId } : null
    };
  }

  const requestedCampaignId = requestedIdentity.campaignId;
  if (requestedCampaignId) {
    const campaignMatches = candidates.filter((item) => (
      Array.isArray(item.campaign_ids) && item.campaign_ids.includes(requestedCampaignId)
    ));
    if (campaignMatches.length === 1) {
      return {
        configs: campaignMatches,
        reason: null,
        selector: {
          ...(requestedCustomerId ? { customer_id: requestedCustomerId } : {}),
          campaign_id: requestedCampaignId
        }
      };
    }
  }

  return {
    configs: [],
    reason: 'ambiguous_destination',
    selector: {
      ...(requestedCustomerId ? { customer_id: requestedCustomerId } : {}),
      ...(requestedCampaignId ? { campaign_id: requestedCampaignId } : {})
    }
  };
}

function appendHistory(row) {
  const history = Array.isArray(row?.history) ? [...row.history] : [];
  if (!row) return history;
  history.push({
    status: row.status || null,
    reason: row.reason || null,
    attempted_at: row.attemptedAt || null,
    completed_at: row.completedAt || null,
    error_code: row.lastErrorCode || null,
    error_message: row.lastErrorMessage || null
  });
  return history.slice(-20);
}

async function prepareAuditRow({ auditModel, values, status, reason = null }) {
  const existing = await auditModel.findOne({ where: { dedupeKey: values.dedupeKey } });
  if (['accepted', 'succeeded', 'partial_success'].includes(existing?.status)) {
    return { row: existing, duplicate: true, inProgress: false, terminalStatus: existing.status };
  }
  const existingAttemptedAt = existing?.attemptedAt ? new Date(existing.attemptedAt).getTime() : 0;
  const pendingIsFresh = existing?.status === 'pending'
    && Number.isFinite(existingAttemptedAt)
    && existingAttemptedAt > Date.now() - 5 * 60 * 1000;
  if (pendingIsFresh) return { row: existing, duplicate: false, inProgress: true };

  const now = new Date();
  const nextValues = {
    ...values,
    status,
    reason,
    attemptedAt: now,
    completedAt: status === 'pending' ? null : now,
    lastErrorCode: null,
    lastErrorMessage: null
  };
  if (!existing) {
    try {
      return {
        row: await auditModel.create({ ...nextValues, attemptCount: 1, history: [] }),
        duplicate: false,
        inProgress: false
      };
    } catch (error) {
      const isUniqueCollision = error?.name === 'SequelizeUniqueConstraintError'
        || error?.original?.code === 'ER_DUP_ENTRY'
        || error?.parent?.code === 'ER_DUP_ENTRY';
      if (!isUniqueCollision) throw error;
      const concurrent = await auditModel.findOne({ where: { dedupeKey: values.dedupeKey } });
      if (!concurrent) throw error;
      return {
        row: concurrent,
        duplicate: ['accepted', 'succeeded', 'partial_success'].includes(concurrent.status),
        inProgress: concurrent.status === 'pending',
        terminalStatus: ['accepted', 'succeeded', 'partial_success'].includes(concurrent.status)
          ? concurrent.status
          : null,
        collision: true
      };
    }
  }

  await existing.update({
    ...nextValues,
    attemptCount: Number(existing.attemptCount || 0) + 1,
    history: appendHistory(existing)
  });
  return { row: existing, duplicate: false, inProgress: false };
}

function truncate(value, maxLength) {
  const cleaned = cleanString(value);
  if (!cleaned) return null;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

function redactSensitiveText(value, sensitiveValues = []) {
  let output = cleanString(value);
  if (!output) return null;
  for (const sensitiveValue of sensitiveValues) {
    const needle = cleanString(sensitiveValue);
    if (!needle) continue;
    output = output.split(needle).join('[redacted]');
  }
  return output;
}

function providerRequestId(result) {
  return truncate(result?.requestId || result?.request_id || result?.jobId || result?.job_id, 191);
}

function summarizeResponse(result) {
  return {
    transport: 'google_data_manager',
    request_accepted: Boolean(result?.requestId || result?.request_id),
    processing_status: (result?.requestId || result?.request_id) ? 'PROCESSING' : null,
    result_count: Array.isArray(result?.results) ? result.results.length : 0,
    partial_failure: Boolean(result?.partialFailureError || result?.partial_failure_error),
    has_job_id: Boolean(result?.jobId || result?.job_id)
  };
}

function summarizeProviderError(error) {
  const providerError = error?.providerError || error?.response?.data?.error || null;
  return {
    code: truncate(error?.code || providerError?.code || providerError?.status, 128),
    message: truncate(error?.message || providerError?.message || 'Error al subir conversión', 2000),
    metadata: {
      http_status: Number(error?.response?.status) || null,
      provider_status: truncate(providerError?.status, 128),
      provider_code: truncate(providerError?.code, 128)
    }
  };
}

function annotateError(error, metadata = {}) {
  const normalized = error instanceof Error ? error : new Error(String(error || 'Error desconocido'));
  try {
    Object.assign(normalized, metadata);
    return normalized;
  } catch (_assignError) {
    const wrapped = new Error(normalized.message);
    wrapped.cause = normalized;
    Object.assign(wrapped, metadata);
    return wrapped;
  }
}

function auditPersistenceError({ cause, destination, conversionAccepted, providerError = null }) {
  const error = new Error(conversionAccepted
    ? 'Google Ads aceptó la conversión, pero no se pudo persistir su auditoría'
    : 'No se pudo persistir el resultado del intento de Google Ads');
  error.code = conversionAccepted
    ? 'GOOGLE_ADS_AUDIT_FAILED_AFTER_ACCEPTANCE'
    : 'GOOGLE_ADS_AUDIT_PERSISTENCE_FAILED';
  error.cause = cause;
  error.providerError = providerError;
  error.conversionAccepted = conversionAccepted === true;
  error.conversionDestination = destination;
  error.isGoogleAdsDestinationProcessingError = true;
  return error;
}

function buildScope({ cfgRecord, googleConfig, clinicId, groupId, assignmentScope }) {
  const normalizedClinicId = parseInteger(clinicId ?? cfgRecord?.clinic_id ?? cfgRecord?.clinica_id);
  const normalizedGroupId = parseInteger(groupId ?? cfgRecord?.group_id ?? cfgRecord?.grupo_clinica_id);
  const requestedScope = String(assignmentScope || cfgRecord?.assignment_scope || '').trim().toLowerCase();
  const configSource = String(googleConfig?.config_source || '').trim().toLowerCase();
  const normalizedAssignmentScope = requestedScope === 'group' || (configSource === 'group' && normalizedGroupId)
    ? 'group'
    : 'clinic';
  return {
    clinicId: normalizedClinicId,
    groupId: normalizedGroupId,
    assignmentScope: normalizedAssignmentScope
  };
}

function requestedTargetMismatchesConfig(customData, eventConfig, configuredAction) {
  const requestedCustomer = cleanGoogleCustomerId(customData.customer_id || customData.customerId || customData.google_customer_id);
  if (requestedCustomer && requestedCustomer !== eventConfig.customer_id) return true;
  const requestedConversionAction = customData.conversion_action || customData.conversionAction;
  const requestedConversionActionId = customData.conversion_action_id || customData.conversionActionId;
  const requestedSendTo = customData.send_to || customData.sendTo;
  if (!requestedConversionAction && !requestedConversionActionId && !requestedSendTo) return false;
  if (!requestedConversionAction && !requestedConversionActionId && requestedSendTo) {
    return cleanString(requestedSendTo) !== cleanString(eventConfig.send_to);
  }
  const requestedAction = buildConversionActionResource({
    customerId: eventConfig.customer_id,
    conversionAction: requestedConversionAction,
    conversionActionId: requestedConversionActionId,
    sendTo: requestedSendTo
  });
  return !requestedAction || requestedAction !== configuredAction;
}

function hasRequestedTargetOverride(customData = {}) {
  return Boolean(
    customData.customer_id
      || customData.customerId
      || customData.google_customer_id
      || customData.conversion_action
      || customData.conversionAction
      || customData.conversion_action_id
      || customData.conversionActionId
      || customData.send_to
      || customData.sendTo
  );
}

function hasRequestedActionOverride(customData = {}) {
  return Boolean(
    customData.conversion_action
      || customData.conversionAction
      || customData.conversion_action_id
      || customData.conversionActionId
      || customData.send_to
      || customData.sendTo
  );
}

function normalizeOpaquePolicyReference(value, maxLength = 191) {
  const normalized = cleanString(value);
  if (!normalized || normalized.length > maxLength) return null;
  // Evidence is referenced by an opaque email-thread/decision id. URLs are not accepted
  // here so a landing page or treatment URL cannot become event metadata.
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{5,190}$/.test(normalized)) return null;
  return normalized;
}

function normalizeAuthorizationDate(value) {
  const raw = cleanString(value);
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function getEnhancedConversionPolicyConfig(googleConfig = {}) {
  const raw = googleConfig.enhanced_conversions ?? googleConfig.enhancedConversions;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
}

function resolveDocumentedEnhancedConversionAuthorization(googleConfig = {}, eventConfig = {}, options = {}) {
  const policyConfig = getEnhancedConversionPolicyConfig(googleConfig);
  if (policyConfig.enabled !== true) return { valid: false, reason: 'policy_disabled' };
  const policyMode = cleanString(policyConfig.policy_mode ?? policyConfig.policyMode)?.toLowerCase();
  if (policyMode !== GOOGLE_ENHANCED_CONVERSION_POLICY_MODE) {
    return { valid: false, reason: 'policy_mode_invalid' };
  }
  const customerId = cleanGoogleCustomerId(eventConfig.customer_id);
  const eventName = cleanString(eventConfig.event_name)?.toLowerCase() || null;
  if (!customerId || !eventName) return { valid: false, reason: 'destination_scope_missing' };
  if (
    !GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_CUSTOMER_IDS.includes(customerId)
    || !GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_EVENTS.includes(eventName)
  ) {
    return { valid: false, reason: 'outside_propdental_account_event_scope' };
  }
  const allowlist = Array.isArray(policyConfig.allowlist) ? policyConfig.allowlist : [];
  const matches = allowlist.filter((entry) => (
    entry
      && typeof entry === 'object'
      && !Array.isArray(entry)
      && entry.enabled === true
      && cleanGoogleCustomerId(entry.customer_id ?? entry.customerId) === customerId
      && cleanString(entry.event_name ?? entry.eventName ?? entry.event)?.toLowerCase() === eventName
  ));
  if (matches.length === 0) return { valid: false, reason: 'account_event_not_allowlisted' };
  if (matches.length > 1) return { valid: false, reason: 'duplicate_account_event_authorization' };

  const rawAuthorization = matches[0].authorization;
  if (!rawAuthorization || typeof rawAuthorization !== 'object' || Array.isArray(rawAuthorization)) {
    return { valid: false, reason: 'authorization_metadata_missing' };
  }
  const googleEvidenceRef = normalizeOpaquePolicyReference(
    rawAuthorization.google_evidence_ref ?? rawAuthorization.googleEvidenceRef,
    191
  );
  const advertiserAuthorizationRef = normalizeOpaquePolicyReference(
    rawAuthorization.advertiser_authorization_ref ?? rawAuthorization.advertiserAuthorizationRef,
    191
  );
  const googleGuidanceAt = normalizeAuthorizationDate(
    rawAuthorization.google_guidance_at ?? rawAuthorization.googleGuidanceAt
  );
  const advertiserAuthorizedAt = normalizeAuthorizationDate(
    rawAuthorization.advertiser_authorized_at ?? rawAuthorization.advertiserAuthorizedAt
  );
  const expiresAtRaw = rawAuthorization.expires_at ?? rawAuthorization.expiresAt;
  const expiresAt = expiresAtRaw ? normalizeAuthorizationDate(expiresAtRaw) : null;
  const rawPermittedIdentifiers = rawAuthorization.permitted_identifiers
    ?? rawAuthorization.permittedIdentifiers;
  const permittedIdentifiers = Array.isArray(rawPermittedIdentifiers)
    ? rawPermittedIdentifiers.map((value) => String(value || '').trim().toLowerCase())
    : [];
  const identifiersAreValid = permittedIdentifiers.length > 0
    && permittedIdentifiers.every((value) => GOOGLE_ENHANCED_CONVERSION_ALLOWED_IDENTIFIERS.includes(value))
    && new Set(permittedIdentifiers).size === permittedIdentifiers.length;
  if (
    !googleEvidenceRef
    || !advertiserAuthorizationRef
    || !googleGuidanceAt
    || !advertiserAuthorizedAt
    || (expiresAtRaw && !expiresAt)
    || !identifiersAreValid
    || rawAuthorization.policy_ambiguity_acknowledged !== true
    || rawAuthorization.formal_policy_exception_claimed !== false
    || rawAuthorization.measurement_only !== true
    || rawAuthorization.customer_match_enabled !== false
    || rawAuthorization.conversion_based_customer_lists_enabled !== false
    || rawAuthorization.remarketing_enabled !== false
    || String(rawAuthorization.ad_personalization_source || '').trim().toLowerCase() !== 'visitor_consent'
  ) {
    return { valid: false, reason: 'authorization_metadata_invalid' };
  }
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (!Number.isFinite(now.getTime())) return { valid: false, reason: 'authorization_check_time_invalid' };
  if (
    new Date(googleGuidanceAt).getTime() > now.getTime() + 5 * 60 * 1000
    || new Date(advertiserAuthorizedAt).getTime() > now.getTime() + 5 * 60 * 1000
  ) {
    return { valid: false, reason: 'authorization_not_yet_valid' };
  }
  if (expiresAt && new Date(expiresAt).getTime() <= now.getTime()) {
    return { valid: false, reason: 'authorization_expired' };
  }

  const authorization = {
    policyMode: GOOGLE_ENHANCED_CONVERSION_POLICY_MODE,
    customerId,
    eventName,
    googleEvidenceRef,
    advertiserAuthorizationRef,
    googleGuidanceAt,
    advertiserAuthorizedAt,
    expiresAt,
    permittedIdentifiers,
    policyAmbiguityAcknowledged: true,
    formalPolicyExceptionClaimed: false,
    measurementOnly: true,
    customerMatchEnabled: false,
    conversionBasedCustomerListsEnabled: false,
    remarketingEnabled: false,
    adPersonalizationSource: 'visitor_consent'
  };
  return {
    valid: true,
    reason: 'authorized_documented_guidance_and_advertiser_authorization',
    authorization: {
      ...authorization,
      digest: sha256(JSON.stringify(authorization))
    }
  };
}

function resolveUserDataPolicy(googleConfig = {}, eventConfig = {}, options = {}) {
  const explicitlyRequested = eventConfig.user_data_enabled === true
    || googleConfig.user_data_enabled === true
    || googleConfig.userDataEnabled === true;
  if (!explicitlyRequested) {
    return { enabled: false, requested: false, reason: 'blocked_healthcare' };
  }
  const resolved = resolveDocumentedEnhancedConversionAuthorization(googleConfig, eventConfig, options);
  if (!resolved.valid) {
    const reason = ['policy_disabled', 'policy_mode_invalid'].includes(resolved.reason)
      ? 'blocked_healthcare'
      : `blocked_${resolved.reason}`;
    return { enabled: false, requested: true, reason };
  }
  if (options.adUserDataConsentStatus !== 'GRANTED') {
    return {
      enabled: false,
      requested: true,
      reason: options.adUserDataConsentStatus === 'DENIED'
        ? 'blocked_ad_user_data_consent_denied'
        : 'blocked_ad_user_data_consent_missing',
      authorization: resolved.authorization
    };
  }
  if (!['GRANTED', 'DENIED'].includes(options.adPersonalizationConsentStatus)) {
    return {
      enabled: false,
      requested: true,
      reason: 'blocked_ad_personalization_consent_missing',
      authorization: resolved.authorization
    };
  }
  return {
    enabled: true,
    requested: true,
    reason: resolved.reason,
    authorization: resolved.authorization
  };
}

async function uploadGoogleConversionDestination({
  cfgRecord,
  googleAdsConfig,
  eventConfig: suppliedEventConfig = null,
  eventName,
  customData = {},
  userData = {},
  consent,
  eventId,
  clinicId = null,
  groupId = null,
  assignmentScope = null,
  allowUpload = true,
  consentModeEnabled = null,
  userProperties = null,
  dependencies = {}
}) {
  const auditModel = dependencies.auditModel || db.GoogleAdsConversionUploadAttempt;
  const resolveRuntime = dependencies.resolveRuntime || resolveScopedGoogleAdsRuntime;
  const uploadConversion = dependencies.uploadConversion || uploadConversionEvent;
  const cfgObject = cfgRecord && typeof cfgRecord.config === 'object' ? cfgRecord.config : {};
  const googleConfig = googleAdsConfig
    ? normalizeGoogleAdsConfig(googleAdsConfig)
    : normalizeGoogleAdsConfig(cfgObject.google_ads || {});
  const eventConfig = suppliedEventConfig || getGoogleAdsEventConfig(googleConfig, eventName);
  if (!eventConfig) {
    return {
      sent: false,
      reason: getBaseGoogleAdsEventConfig(googleConfig, eventName)
        ? 'no_configured_destination'
        : 'unsupported_conversion_event',
      destination_key: null,
      customer_id: null
    };
  }
  const destinationMeta = {
    destination_key: eventConfig.destination_key || `legacy_${eventConfig.customer_id || eventConfig.event_name}`,
    customer_id: eventConfig.customer_id || null
  };
  const destinationResult = (result) => ({ ...destinationMeta, ...result });
  const clickId = selectClickId(customData);
  const defaultPhoneCountryCode = eventConfig.phone_country_code
    || googleConfig.phone_country_code
    || process.env.GOOGLE_DATA_MANAGER_DEFAULT_PHONE_COUNTRY_CODE
    || null;
  const configuredConsentModeEnabled = cfgObject.features?.consent_mode_enabled === true;
  // Advertising conversions always require an explicit, per-visitor grant.
  // A disabled/missing Consent Mode configuration is a blocker, never a
  // legacy permission or an invitation to infer consent from analytics/contact.
  const requiresExplicitAdvertisingConsent = true;
  const requestConsentStatus = mergeExplicitGoogleAdvertisingConsent(customData.consent, consent);
  const requestedAdUserDataConsentStatus = normalizeExplicitAdUserDataConsent(customData.consent, consent);
  const requestedAdPersonalizationConsentStatus = normalizeExplicitAdPersonalizationConsent(
    customData.consent,
    consent
  );
  const consentStatus = configuredConsentModeEnabled && consentModeEnabled !== false
    ? requestConsentStatus
    : (requestConsentStatus === 'DENIED' ? 'DENIED' : null);
  const adUserDataConsentStatus = configuredConsentModeEnabled && consentModeEnabled !== false
    ? requestedAdUserDataConsentStatus
    : (requestedAdUserDataConsentStatus === 'DENIED' ? 'DENIED' : null);
  const adPersonalizationConsentStatus = configuredConsentModeEnabled && consentModeEnabled !== false
    ? requestedAdPersonalizationConsentStatus
    : (requestedAdPersonalizationConsentStatus === 'DENIED' ? 'DENIED' : null);
  const authorizationCheckNow = typeof dependencies.now === 'function'
    ? dependencies.now()
    : (dependencies.now || new Date());
  const userDataPolicy = resolveUserDataPolicy(googleConfig, eventConfig, {
    adUserDataConsentStatus,
    adPersonalizationConsentStatus,
    now: authorizationCheckNow
  });
  const userIdentifiers = userDataPolicy.enabled
    ? buildEnhancedConversionUserIdentifiers({
        email: userData?.email || null,
        phone: userData?.phone || userData?.telefono || null,
        defaultPhoneCountryCode,
        permittedIdentifiers: userDataPolicy.authorization?.permittedIdentifiers
      })
    : [];
  const userIdentifierHash = userIdentifiers.length
    ? sha256(JSON.stringify(userIdentifiers))
    : null;

  const scope = buildScope({ cfgRecord, googleConfig, clinicId, groupId, assignmentScope });
  const conversionAction = buildConversionActionResource({
    customerId: eventConfig.customer_id,
    conversionAction: eventConfig.conversion_action,
    conversionActionId: eventConfig.conversion_action_id,
    sendTo: eventConfig.send_to
  });
  const dedupeKey = buildConversionUploadDedupeKey({
    customerId: eventConfig.customer_id,
    conversionAction,
    eventName: eventConfig.event_name,
    eventId,
    clickIdHash: clickId?.hash || null,
    userIdentifierHash
  });
  const auditBase = {
    dedupeKey,
    clinicaId: scope.clinicId,
    grupoClinicaId: scope.groupId,
    intakeConfigId: parseInteger(cfgRecord?.id),
    assignmentScope: scope.assignmentScope,
    destinationKey: destinationMeta.destination_key,
    customerId: eventConfig.customer_id,
    conversionAction,
    eventName: eventConfig.event_name,
    eventId: truncate(eventId, 191),
    clickIdType: clickId?.type || null,
    clickIdHash: clickId?.hash || null,
    consentStatus: consentStatus || 'UNSPECIFIED',
    requestMetadata: {
      transport: 'google_data_manager',
      currency: String(coalesce(customData.currency, eventConfig.currency, 'EUR')).toUpperCase(),
      has_value: coalesce(customData.value, eventConfig.value) !== undefined,
      has_email: Boolean(userData?.email),
      has_phone: Boolean(userData?.phone || userData?.telefono),
      has_address: false,
      user_identifier_count: userIdentifiers.length,
      user_identifier_types: userIdentifiers.map((identifier) => (
        identifier.emailAddress ? 'email' : 'phone'
      )),
      has_click_id: Boolean(clickId),
      click_id_type: clickId?.type || null,
      has_client_id: Boolean(customData.client_id || customData.clientId || customData.ga_client_id),
      has_user_id: Boolean(userData?.userId || userData?.user_id || customData.user_id || customData.userId),
      user_data_policy: userDataPolicy.reason,
      user_data_requested: userDataPolicy.requested,
      user_data_sent: userDataPolicy.enabled && userIdentifiers.length > 0,
      enhanced_conversion_authorized: userDataPolicy.enabled,
      enhanced_conversion_policy_mode: userDataPolicy.authorization?.policyMode || null,
      enhanced_conversion_google_evidence_ref: userDataPolicy.authorization?.googleEvidenceRef || null,
      enhanced_conversion_google_guidance_at: userDataPolicy.authorization?.googleGuidanceAt || null,
      enhanced_conversion_advertiser_authorization_ref:
        userDataPolicy.authorization?.advertiserAuthorizationRef || null,
      enhanced_conversion_advertiser_authorized_at:
        userDataPolicy.authorization?.advertiserAuthorizedAt || null,
      enhanced_conversion_expires_at: userDataPolicy.authorization?.expiresAt || null,
      enhanced_conversion_authorization_digest: userDataPolicy.authorization?.digest || null,
      enhanced_conversion_policy_ambiguity_acknowledged:
        userDataPolicy.authorization?.policyAmbiguityAcknowledged === true,
      enhanced_conversion_formal_policy_exception_claimed:
        userDataPolicy.authorization?.formalPolicyExceptionClaimed === true,
      enhanced_conversion_measurement_only: userDataPolicy.authorization?.measurementOnly === true,
      enhanced_conversion_audience_use: false,
      enhanced_conversion_page_url_sent: false,
      enhanced_conversion_treatment_sent: false,
      enhanced_conversion_remarketing_enabled: false,
      enhanced_conversion_customer_match_enabled: false,
      enhanced_conversion_conversion_based_customer_lists_enabled: false,
      enhanced_conversion_ad_personalization_source:
        userDataPolicy.authorization?.adPersonalizationSource || null,
      visitor_ad_personalization_consent_status: adPersonalizationConsentStatus || 'UNSPECIFIED',
      consent_mode_configured: configuredConsentModeEnabled,
      explicit_advertising_consent_required: requiresExplicitAdvertisingConsent,
      explicit_ad_user_data_consent_status: adUserDataConsentStatus || 'UNSPECIFIED'
    }
  };

  const skip = async (reason) => {
    const prepared = await prepareAuditRow({ auditModel, values: auditBase, status: 'skipped', reason });
    const finalReason = prepared.duplicate
      ? (prepared.terminalStatus === 'succeeded'
          ? 'duplicate_already_succeeded'
          : 'duplicate_already_accepted')
      : prepared.inProgress
        ? 'duplicate_upload_in_progress'
        : reason;
    return destinationResult({ sent: false, reason: finalReason, audit_id: prepared.row?.id || null });
  };

  if (!clickId && !userIdentifiers.length) return skip('no_permitted_identifiers');
  if (!eventConfig.enabled) return skip('google_ads_disabled');
  if (!eventConfig.customer_id) return skip('missing_scoped_customer_id');
  if (!conversionAction) return skip('missing_or_invalid_scoped_conversion_action');
  if (hasRequestedActionOverride(customData)) {
    return skip('request_target_override_not_allowed');
  }
  if (requestedTargetMismatchesConfig(customData, eventConfig, conversionAction)) {
    return skip('request_target_mismatch');
  }
  if (
    allowUpload === false
    || consentStatus === 'DENIED'
    || (requiresExplicitAdvertisingConsent && consentStatus !== 'GRANTED')
  ) return skip('consent_not_granted');
  if (!scope.clinicId && !scope.groupId) return skip('scope_required');

  const existingAudit = await auditModel.findOne({ where: { dedupeKey } });
  if (['accepted', 'succeeded', 'partial_success'].includes(existingAudit?.status)) {
    return destinationResult({
      sent: false,
      accepted: true,
      reason: existingAudit.status === 'succeeded'
        ? 'duplicate_already_succeeded'
        : 'duplicate_already_accepted',
      audit_id: existingAudit.id || null
    });
  }
  const existingAttemptedAt = existingAudit?.attemptedAt ? new Date(existingAudit.attemptedAt).getTime() : 0;
  if (existingAudit?.status === 'pending' && existingAttemptedAt > Date.now() - 5 * 60 * 1000) {
    return destinationResult({ sent: false, reason: 'duplicate_upload_in_progress', audit_id: existingAudit.id || null });
  }

  let runtime;
  try {
    runtime = await resolveRuntime({
      clinicId: scope.clinicId,
      groupId: scope.groupId,
      assignmentScope: scope.assignmentScope,
      customerId: eventConfig.customer_id,
      requiredScopes: [GOOGLE_DATA_MANAGER_SCOPE]
    });
  } catch (error) {
    return skip(String(error.code || 'scoped_connection_unavailable').toLowerCase());
  }

  const values = {
    ...auditBase,
    googleConnectionId: runtime.connection?.id || null,
    googleConnectionAssignmentId: runtime.assignment?.id || null,
    connectionSource: runtime.connectionSource || null,
    loginCustomerId: runtime.loginCustomerId || null
  };
  const prepared = await prepareAuditRow({ auditModel, values, status: 'pending' });
  if (prepared.duplicate) {
    return destinationResult({
      sent: false,
      accepted: true,
      reason: prepared.terminalStatus === 'succeeded'
        ? 'duplicate_already_succeeded'
        : 'duplicate_already_accepted',
      audit_id: prepared.row?.id || null
    });
  }
  if (prepared.inProgress) {
    return destinationResult({ sent: false, reason: 'duplicate_upload_in_progress', audit_id: prepared.row?.id || null });
  }

  const valueRaw = coalesce(customData.value, eventConfig.value, 0);
  const value = Number.isFinite(Number(valueRaw)) ? Number(valueRaw) : 0;
  const currency = String(coalesce(customData.currency, eventConfig.currency, 'EUR') || 'EUR').toUpperCase();
  const conversionDateTime = toGoogleAdsDateTime(customData.conversion_time || customData.conversionDateTime || new Date());

  let result;
  try {
    result = await uploadConversion({
      customerId: eventConfig.customer_id,
      conversionAction,
      ...(clickId ? { [clickId.type]: clickId.value } : {}),
      value,
      currency,
      conversionDateTime,
      externalId: eventId || null,
      ...(userDataPolicy.enabled ? {
        ...(userDataPolicy.authorization?.permittedIdentifiers.includes('email')
          ? { email: userData?.email || null }
          : {}),
        ...(userDataPolicy.authorization?.permittedIdentifiers.includes('phone')
          ? { phone: userData?.phone || userData?.telefono || null }
          : {}),
        enhancedConversionAuthorization: userDataPolicy.authorization
      } : {}),
      eventName: eventConfig.event_name,
      // Data Manager receives the visitor's two Consent Mode v2 signals. The
      // upload gate above remains based on explicit advertising consent, while
      // ad_user_data is never inferred from a generic marketing grant.
      consentStatus: adUserDataConsentStatus,
      adPersonalizationStatus: adPersonalizationConsentStatus,
      accessToken: runtime.accessToken,
      loginCustomerId: runtime.loginCustomerId,
      defaultPhoneCountryCode
    });
    if (!providerRequestId(result)) {
      const protocolError = new Error('Google Data Manager no devolvió requestId');
      protocolError.code = 'DATA_MANAGER_REQUEST_ID_MISSING';
      protocolError.providerError = result;
      throw protocolError;
    }
  } catch (rawError) {
    const error = annotateError(rawError, {
      conversionDestination: destinationMeta,
      isGoogleAdsProviderError: true
    });
    const summary = summarizeProviderError(error);
    summary.message = redactSensitiveText(summary.message, [
      clickId?.value,
      userData?.email,
      userData?.phone,
      userData?.telefono,
      customData.client_id,
      customData.clientId,
      customData.ga_client_id,
      userData?.userId,
      userData?.user_id,
      customData.user_id,
      customData.userId
    ]);
    try {
      await prepared.row.update({
        status: 'failed',
        reason: 'provider_error',
        providerRequestId: providerRequestId(error?.response?.data),
        responseMetadata: summary.metadata,
        lastErrorCode: summary.code,
        lastErrorMessage: summary.message,
        completedAt: new Date()
      });
    } catch (auditError) {
      throw auditPersistenceError({
        cause: auditError,
        destination: destinationMeta,
        conversionAccepted: false,
        providerError: error
      });
    }
    throw error;
  }

  try {
    await prepared.row.update({
      status: 'accepted',
      reason: 'provider_processing',
      providerRequestId: providerRequestId(result),
      responseMetadata: summarizeResponse(result),
      completedAt: null
    });
  } catch (auditError) {
    throw auditPersistenceError({
      cause: auditError,
      destination: destinationMeta,
      conversionAccepted: true
    });
  }
  return destinationResult({
    sent: true,
    accepted: true,
    reason: 'provider_processing',
    result,
    audit_id: prepared.row?.id || null
  });
}

async function maybeUploadGoogleConversion(options) {
  const cfgObject = options?.cfgRecord && typeof options.cfgRecord.config === 'object'
    ? options.cfgRecord.config
    : {};
  const googleConfig = options?.googleAdsConfig
    ? normalizeGoogleAdsConfig(options.googleAdsConfig)
    : normalizeGoogleAdsConfig(cfgObject.google_ads || {});
  const configuredEventConfigs = getGoogleAdsEventConfigs(googleConfig, options?.eventName);
  const destinationSelection = selectConfiguredEventConfigs(
    configuredEventConfigs,
    options?.customData || {}
  );
  const eventConfigs = destinationSelection.configs;
  const results = [];
  const providerErrors = [];
  const processingErrors = [];

  for (const eventConfig of eventConfigs) {
    try {
      results.push(await uploadGoogleConversionDestination({
        ...options,
        googleAdsConfig: googleConfig,
        eventConfig
      }));
    } catch (error) {
      const destination = error.conversionDestination || {
        destination_key: eventConfig.destination_key || null,
        customer_id: eventConfig.customer_id || null
      };
      if (!error.isGoogleAdsProviderError) {
        const conversionAccepted = error.conversionAccepted === true;
        results.push({
          ...destination,
          sent: conversionAccepted,
          reason: conversionAccepted ? 'audit_persistence_error' : 'destination_processing_error',
          error_code: truncate(error.code, 128)
        });
        processingErrors.push(error);
        continue;
      }
      const summary = summarizeProviderError(error);
      results.push({
        ...destination,
        sent: false,
        reason: 'provider_error',
        error_code: summary.code
      });
      providerErrors.push(error);
    }
  }

  const sentCount = results.filter((item) => item.sent === true).length;
  const alreadySucceededCount = results.filter((item) => item.reason === 'duplicate_already_succeeded').length;
  const alreadyAcceptedCount = results.filter((item) => item.reason === 'duplicate_already_accepted').length;
  const acceptedCount = sentCount + alreadySucceededCount + alreadyAcceptedCount;
  const failedCount = results.filter((item) => item.reason === 'provider_error').length;
  const processingErrorCount = results.filter((item) => (
    item.reason === 'audit_persistence_error' || item.reason === 'destination_processing_error'
  )).length;
  const aggregate = {
    sent: sentCount > 0,
    accepted: acceptedCount > 0,
    partial: acceptedCount > 0 && acceptedCount < results.length,
    destination_count: results.length,
    sent_count: sentCount,
    already_succeeded_count: alreadySucceededCount,
    already_accepted_count: alreadyAcceptedCount,
    accepted_count: acceptedCount,
    failed_count: failedCount,
    processing_error_count: processingErrorCount,
    skipped_count: results.length - sentCount - failedCount - processingErrorCount,
    destinations: results
  };
  if (results.length === 0) {
    aggregate.reason = destinationSelection.reason || (
      getBaseGoogleAdsEventConfig(googleConfig, options?.eventName)
        ? 'no_configured_destination'
        : 'unsupported_conversion_event'
    );
    aggregate.configured_destination_count = configuredEventConfigs.length;
    if (destinationSelection.selector) aggregate.destination_selector = destinationSelection.selector;
  }

  if (processingErrors.length > 0) {
    if (processingErrors.length === 1 && results.length === 1) {
      processingErrors[0].conversionResult = aggregate;
      throw processingErrors[0];
    }
    const aggregateError = new AggregateError(
      processingErrors,
      'Falló el procesamiento o la auditoría de uno o más destinos Google Ads'
    );
    aggregateError.code = 'GOOGLE_ADS_DESTINATION_PROCESSING_FAILED';
    aggregateError.conversionResult = aggregate;
    throw aggregateError;
  }

  if (acceptedCount === 0 && providerErrors.length > 0) {
    if (providerErrors.length === 1 && results.length === 1) throw providerErrors[0];
    const aggregateError = new AggregateError(providerErrors, 'Fallaron todos los destinos Google Ads que intentaron subir la conversión');
    aggregateError.code = 'GOOGLE_ADS_ALL_DESTINATIONS_FAILED';
    aggregateError.conversionResult = aggregate;
    throw aggregateError;
  }

  if (results.length === 1) {
    return { ...aggregate, ...results[0], destinations: results };
  }
  return aggregate;
}

module.exports = {
  buildConversionActionResource,
  buildConversionUploadDedupeKey,
  getGoogleAdsEventConfig,
  getGoogleAdsEventConfigs,
  hasRequestedActionOverride,
  hasRequestedTargetOverride,
  maybeUploadGoogleConversion,
  mergeGoogleConsent,
  normalizeExplicitAdPersonalizationConsent,
  normalizeExplicitAdUserDataConsent,
  normalizeGoogleConsent,
  prepareAuditRow,
  requestedTargetMismatchesConfig,
  resolveDocumentedEnhancedConversionAuthorization,
  resolveUserDataPolicy,
  selectConfiguredEventConfigs,
  selectClickId,
  toGoogleAdsDateTime,
  uploadGoogleConversionDestination
};
