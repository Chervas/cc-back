'use strict';

const crypto = require('crypto');
const db = require('../../models');
const {
  GOOGLE_DATA_MANAGER_SCOPE,
  buildUserIdentifiers,
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
    : ['lead', 'contact', 'schedule', 'purchase'].includes(eventKey)
      ? eventKey
      : null;
  if (!mapped) return null;
  const nested = googleAdsConfig?.events && typeof googleAdsConfig.events === 'object'
    ? (googleAdsConfig.events[mapped] || {})
    : {};
  return {
    event_name: mapped,
    enabled: googleAdsConfig.enabled !== false && nested.enabled !== false,
    customer_id: cleanGoogleCustomerId(
      nested.customer_id
        ?? nested.customerId
        ?? googleAdsConfig[`${mapped}_customer_id`]
        ?? googleAdsConfig.customer_id
    ),
    conversion_action: nested.conversion_action
      ?? nested.conversionAction
      ?? googleAdsConfig[`${mapped}_conversion_action`]
      ?? googleAdsConfig.conversion_action
      ?? null,
    conversion_action_id: nested.conversion_action_id
      ?? nested.conversionActionId
      ?? googleAdsConfig[`${mapped}_conversion_action_id`]
      ?? googleAdsConfig.conversion_action_id
      ?? null,
    send_to: nested.send_to
      ?? nested.sendTo
      ?? googleAdsConfig[`${mapped}_send_to`]
      ?? googleAdsConfig.send_to
      ?? null,
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
    const destination = {
      event_name: base.event_name,
      destination_key: truncate(
        raw.key || raw.destination_key || raw.destinationKey || `destination_${customerId || index + 1}`,
        128
      ),
      enabled: base.enabled && raw.enabled !== false,
      customer_id: customerId,
      conversion_action: raw.conversion_action
        ?? raw.conversionAction
        ?? (canInheritBaseAction ? base.conversion_action : null),
      conversion_action_id: raw.conversion_action_id
        ?? raw.conversionActionId
        ?? (canInheritBaseAction ? base.conversion_action_id : null),
      send_to: raw.send_to
        ?? raw.sendTo
        ?? (canInheritBaseAction ? base.send_to : null),
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

function resolveUserDataPolicy(googleConfig = {}, eventConfig = {}) {
  const explicitlyRequested = eventConfig.user_data_enabled === true
    || googleConfig.user_data_enabled === true
    || googleConfig.userDataEnabled === true;
  // ClinicaClick procesa actividad sanitaria/dental. La política de datos de
  // Google no permite Enhanced Conversions con información de categorías de
  // salud, por lo que ninguna configuración del cliente puede habilitarlo.
  return {
    enabled: false,
    requested: explicitlyRequested,
    reason: 'blocked_healthcare'
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
  const userDataPolicy = resolveUserDataPolicy(googleConfig, eventConfig);
  const userIdentifiers = userDataPolicy.enabled
    ? buildUserIdentifiers({
        email: userData?.email || null,
        phone: userData?.phone || userData?.telefono || null,
        defaultPhoneCountryCode,
        givenName: userData?.givenName ?? userData?.given_name ?? userData?.firstName ?? userData?.first_name,
        familyName: userData?.familyName ?? userData?.family_name ?? userData?.lastName ?? userData?.last_name,
        regionCode: userData?.regionCode ?? userData?.region_code ?? userData?.countryCode ?? userData?.country_code,
        postalCode: userData?.postalCode ?? userData?.postal_code ?? userData?.zip ?? userData?.zip_code,
        address: userData?.address
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
  const configuredConsentModeEnabled = cfgObject.features?.consent_mode_enabled === true;
  // Advertising conversions always require an explicit, per-visitor grant.
  // A disabled/missing Consent Mode configuration is a blocker, never a
  // legacy permission or an invitation to infer consent from analytics/contact.
  const requiresExplicitAdvertisingConsent = true;
  const requestConsentStatus = mergeExplicitGoogleAdvertisingConsent(customData.consent, consent);
  const consentStatus = configuredConsentModeEnabled && consentModeEnabled !== false
    ? requestConsentStatus
    : (requestConsentStatus === 'DENIED' ? 'DENIED' : null);
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
      has_address: userIdentifiers.some((identifier) => Boolean(identifier.address)),
      user_identifier_count: userIdentifiers.length,
      has_click_id: Boolean(clickId),
      click_id_type: clickId?.type || null,
      has_client_id: Boolean(customData.client_id || customData.clientId || customData.ga_client_id),
      has_user_id: Boolean(userData?.userId || userData?.user_id || customData.user_id || customData.userId),
      user_data_policy: userDataPolicy.reason,
      user_data_requested: userDataPolicy.requested,
      user_data_sent: userDataPolicy.enabled && userIdentifiers.length > 0,
      consent_mode_configured: configuredConsentModeEnabled,
      explicit_advertising_consent_required: requiresExplicitAdvertisingConsent
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
        email: userData?.email || null,
        phone: userData?.phone || userData?.telefono || null,
        givenName: userData?.givenName ?? userData?.given_name ?? userData?.firstName ?? userData?.first_name,
        familyName: userData?.familyName ?? userData?.family_name ?? userData?.lastName ?? userData?.last_name,
        regionCode: userData?.regionCode ?? userData?.region_code ?? userData?.countryCode ?? userData?.country_code,
        postalCode: userData?.postalCode ?? userData?.postal_code ?? userData?.zip ?? userData?.zip_code,
        address: userData?.address || null,
        clientId: customData.client_id || customData.clientId || customData.ga_client_id || null,
        userId: userData?.userId || userData?.user_id || customData.user_id || customData.userId || null,
        userProperties: eventConfig.user_properties || userProperties || userData?.userProperties || userData?.user_properties || null
      } : {}),
      eventName: eventConfig.event_name,
      consentStatus,
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
  normalizeGoogleConsent,
  prepareAuditRow,
  requestedTargetMismatchesConfig,
  resolveUserDataPolicy,
  selectConfiguredEventConfigs,
  selectClickId,
  toGoogleAdsDateTime,
  uploadGoogleConversionDestination
};
