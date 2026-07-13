'use strict';

const crypto = require('crypto');
const axios = require('axios');

const GOOGLE_DATA_MANAGER_SCOPE = 'https://www.googleapis.com/auth/datamanager';
const GOOGLE_DATA_MANAGER_USER_DATA_POLICY = 'blocked_healthcare';
const GOOGLE_ENHANCED_CONVERSION_POLICY_MODE = 'documented_google_account_team_guidance_and_advertiser_authorization';
const GOOGLE_ENHANCED_CONVERSION_ALLOWED_IDENTIFIERS = Object.freeze(['email', 'phone']);
const GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_CUSTOMER_IDS = Object.freeze(['1851215478', '5992356722']);
const GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_EVENTS = Object.freeze(['lead', 'contact', 'qualified_lead', 'schedule']);
const DEFAULT_DATA_MANAGER_BASE_URL = 'https://datamanager.googleapis.com/v1';

function scopedCredentialError() {
  const error = new Error('Se requiere un access token OAuth con permisos de Google Data Manager para el scope');
  error.code = 'SCOPED_GOOGLE_DATA_MANAGER_CREDENTIAL_REQUIRED';
  return error;
}

function cleanDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function cleanString(value) {
  if (value === undefined || value === null) return null;
  const cleaned = String(value).trim();
  return cleaned || null;
}

function isOpaquePolicyReference(value) {
  const normalized = cleanString(value);
  return Boolean(normalized && /^[A-Za-z0-9][A-Za-z0-9._:-]{5,190}$/.test(normalized));
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function normalizeAndHashEmail(email) {
  const raw = cleanString(email)?.toLowerCase().replace(/\s+/g, '') || null;
  if (!raw) return null;
  const at = raw.indexOf('@');
  if (at <= 0 || at === raw.length - 1 || raw.indexOf('@', at + 1) !== -1) return null;
  let local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.split('+')[0];
    local = local.replace(/\./g, '');
  }
  if (!local || !domain) return null;
  return sha256Hex(`${local}@${domain}`);
}

function normalizePhoneE164(phone, defaultCountryCode = null) {
  const raw = cleanString(phone);
  if (!raw) return null;
  let digits = cleanDigits(raw);
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  const explicitlyInternational = raw.startsWith('+') || raw.startsWith('00');
  if (!explicitlyInternational) {
    const countryCode = cleanDigits(defaultCountryCode);
    if (!countryCode) return null;
    if (!digits.startsWith(countryCode)) digits = `${countryCode}${digits}`;
  }
  if (digits.length < 8 || digits.length > 15) return null;
  return `+${digits}`;
}

function normalizeAndHashPhone(phone, defaultCountryCode = null) {
  const e164 = normalizePhoneE164(phone, defaultCountryCode);
  return e164 ? sha256Hex(e164) : null;
}

function normalizeAndHashName(name) {
  const normalized = cleanString(name)
    ?.normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim() || null;
  return normalized ? sha256Hex(normalized) : null;
}

function buildAddressIdentifier({
  givenName,
  firstName,
  familyName,
  lastName,
  regionCode,
  postalCode,
  address
} = {}) {
  const nested = address && typeof address === 'object' && !Array.isArray(address) ? address : {};
  const normalizedGivenName = normalizeAndHashName(
    givenName ?? firstName ?? nested.givenName ?? nested.given_name ?? nested.firstName ?? nested.first_name
  );
  const normalizedFamilyName = normalizeAndHashName(
    familyName ?? lastName ?? nested.familyName ?? nested.family_name ?? nested.lastName ?? nested.last_name
  );
  const normalizedRegionCode = cleanString(
    regionCode ?? nested.regionCode ?? nested.region_code ?? nested.countryCode ?? nested.country_code
  )?.toUpperCase() || null;
  const normalizedPostalCode = cleanString(
    postalCode ?? nested.postalCode ?? nested.postal_code ?? nested.zip ?? nested.zipCode ?? nested.zip_code
  );
  if (
    !normalizedGivenName
    || !normalizedFamilyName
    || !/^[A-Z]{2}$/.test(normalizedRegionCode || '')
    || !normalizedPostalCode
  ) return null;
  return {
    address: {
      givenName: normalizedGivenName,
      familyName: normalizedFamilyName,
      regionCode: normalizedRegionCode,
      postalCode: normalizedPostalCode
    }
  };
}

function buildUserIdentifiers({
  email,
  phone,
  defaultPhoneCountryCode = null,
  givenName,
  firstName,
  familyName,
  lastName,
  regionCode,
  postalCode,
  address
} = {}) {
  const identifiers = [];
  const emailAddress = normalizeAndHashEmail(email);
  const phoneNumber = normalizeAndHashPhone(phone, defaultPhoneCountryCode);
  if (emailAddress) identifiers.push({ emailAddress });
  if (phoneNumber) identifiers.push({ phoneNumber });
  const addressIdentifier = buildAddressIdentifier({
    givenName,
    firstName,
    familyName,
    lastName,
    regionCode,
    postalCode,
    address
  });
  if (addressIdentifier) identifiers.push(addressIdentifier);
  return identifiers;
}

function buildEnhancedConversionUserIdentifiers({
  email,
  phone,
  defaultPhoneCountryCode = null,
  permittedIdentifiers = GOOGLE_ENHANCED_CONVERSION_ALLOWED_IDENTIFIERS
} = {}) {
  const permitted = new Set(
    (Array.isArray(permittedIdentifiers) ? permittedIdentifiers : [])
      .map((value) => String(value || '').trim().toLowerCase())
      .filter((value) => GOOGLE_ENHANCED_CONVERSION_ALLOWED_IDENTIFIERS.includes(value))
  );
  const identifiers = [];
  // Email and phone are deliberately preferred and are the only identifiers
  // supported by the documented-guidance path. This is not a formal policy
  // exception. Names/address are never used as a fallback because they add
  // context that is unnecessary for this use case.
  if (permitted.has('email')) {
    const emailAddress = normalizeAndHashEmail(email);
    if (emailAddress) identifiers.push({ emailAddress });
  }
  if (permitted.has('phone')) {
    const phoneNumber = normalizeAndHashPhone(phone, defaultPhoneCountryCode);
    if (phoneNumber) identifiers.push({ phoneNumber });
  }
  return identifiers;
}

function enhancedConversionAuthorizationError(reason) {
  const error = new Error(
    'Las señales de Conversiones mejoradas requieren orientación documentada y autorización expresa del anunciante'
  );
  error.code = reason === 'ad_user_data_consent_not_granted'
    ? 'ENHANCED_CONVERSION_AD_USER_DATA_CONSENT_REQUIRED'
    : reason === 'ad_personalization_consent_missing'
      ? 'ENHANCED_CONVERSION_AD_PERSONALIZATION_CONSENT_REQUIRED'
      : 'ENHANCED_CONVERSION_AUTHORIZATION_REQUIRED';
  error.policyReason = reason;
  return error;
}

function validateEnhancedConversionAuthorization({
  authorization,
  customerId,
  eventName,
  consentStatus,
  adPersonalizationStatus,
  now = new Date()
} = {}) {
  if (!authorization || typeof authorization !== 'object' || Array.isArray(authorization)) {
    return { valid: false, reason: 'authorization_missing' };
  }
  const normalizedCustomerId = cleanDigits(customerId);
  const normalizedEventName = cleanString(eventName)?.toLowerCase() || null;
  const permittedIdentifiers = Array.isArray(authorization.permittedIdentifiers)
    ? authorization.permittedIdentifiers.map((value) => String(value || '').trim().toLowerCase())
    : [];
  const hasOnlySupportedIdentifiers = permittedIdentifiers.length > 0
    && permittedIdentifiers.every((value) => GOOGLE_ENHANCED_CONVERSION_ALLOWED_IDENTIFIERS.includes(value))
    && new Set(permittedIdentifiers).size === permittedIdentifiers.length;
  if (
    authorization.policyMode !== GOOGLE_ENHANCED_CONVERSION_POLICY_MODE
    || !GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_CUSTOMER_IDS.includes(normalizedCustomerId)
    || !GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_EVENTS.includes(normalizedEventName)
    || cleanDigits(authorization.customerId) !== normalizedCustomerId
    || cleanString(authorization.eventName)?.toLowerCase() !== normalizedEventName
    || !isOpaquePolicyReference(authorization.googleEvidenceRef)
    || !isOpaquePolicyReference(authorization.advertiserAuthorizationRef)
    || !cleanString(authorization.googleGuidanceAt)
    || !cleanString(authorization.advertiserAuthorizedAt)
    || authorization.policyAmbiguityAcknowledged !== true
    || authorization.formalPolicyExceptionClaimed !== false
    || authorization.measurementOnly !== true
    || authorization.customerMatchEnabled !== false
    || authorization.conversionBasedCustomerListsEnabled !== false
    || authorization.remarketingEnabled !== false
    || authorization.adPersonalizationSource !== 'visitor_consent'
    || !hasOnlySupportedIdentifiers
  ) {
    return { valid: false, reason: 'authorization_scope_invalid' };
  }
  const googleGuidanceAt = new Date(authorization.googleGuidanceAt);
  const advertiserAuthorizedAt = new Date(authorization.advertiserAuthorizedAt);
  const checkedAt = now instanceof Date ? now : new Date(now);
  if (
    !Number.isFinite(googleGuidanceAt.getTime())
    || !Number.isFinite(advertiserAuthorizedAt.getTime())
    || !Number.isFinite(checkedAt.getTime())
  ) {
    return { valid: false, reason: 'authorization_date_invalid' };
  }
  if (
    googleGuidanceAt.getTime() > checkedAt.getTime() + 5 * 60 * 1000
    || advertiserAuthorizedAt.getTime() > checkedAt.getTime() + 5 * 60 * 1000
  ) {
    return { valid: false, reason: 'authorization_not_yet_valid' };
  }
  if (authorization.expiresAt) {
    const expiresAt = new Date(authorization.expiresAt);
    if (!Number.isFinite(expiresAt.getTime()) || expiresAt.getTime() <= checkedAt.getTime()) {
      return { valid: false, reason: 'authorization_expired' };
    }
  }
  if (String(consentStatus || '').trim().toUpperCase() !== 'GRANTED') {
    return { valid: false, reason: 'ad_user_data_consent_not_granted' };
  }
  if (!['GRANTED', 'DENIED'].includes(String(adPersonalizationStatus || '').trim().toUpperCase())) {
    return { valid: false, reason: 'ad_personalization_consent_missing' };
  }
  return {
    valid: true,
    reason: 'authorized_documented_guidance_and_advertiser_authorization',
    permittedIdentifiers
  };
}

function buildUserProperties(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const properties = {};
  const customerType = cleanString(input.customerType ?? input.customer_type)?.toUpperCase();
  const customerValueBucket = cleanString(
    input.customerValueBucket ?? input.customer_value_bucket
  )?.toUpperCase();
  if (['NEW', 'RETURNING', 'REENGAGED'].includes(customerType)) {
    properties.customerType = customerType;
  }
  if (['LOW', 'MEDIUM', 'HIGH'].includes(customerValueBucket)) {
    properties.customerValueBucket = customerValueBucket;
  }

  const rawAdditional = input.additionalUserProperties ?? input.additional_user_properties;
  const candidates = Array.isArray(rawAdditional)
    ? rawAdditional
    : rawAdditional && typeof rawAdditional === 'object'
      ? Object.entries(rawAdditional).map(([propertyName, value]) => ({ propertyName, value }))
      : [];
  const additionalUserProperties = [];
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
    const propertyName = cleanString(candidate.propertyName ?? candidate.property_name)?.slice(0, 100);
    const value = cleanString(candidate.value)?.slice(0, 500);
    if (!propertyName || !value || seen.has(propertyName)) continue;
    seen.add(propertyName);
    additionalUserProperties.push({ propertyName, value });
    if (additionalUserProperties.length >= 25) break;
  }
  if (additionalUserProperties.length) properties.additionalUserProperties = additionalUserProperties;
  return Object.keys(properties).length ? properties : null;
}

function extractConversionActionId(conversionAction) {
  const value = cleanString(conversionAction);
  if (!value) return null;
  if (/^\d+$/.test(value)) return value;
  const match = value.match(/^customers\/\d+\/conversionActions\/(\d+)$/);
  return match ? match[1] : null;
}

function toRfc3339(value) {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.toISOString();
  const raw = cleanString(value);
  if (!raw) return new Date().toISOString();
  const googleAdsFormat = raw.match(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})([+-]\d{2}:\d{2})$/);
  const parsed = new Date(googleAdsFormat
    ? `${googleAdsFormat[1]}T${googleAdsFormat[2]}${googleAdsFormat[3]}`
    : raw);
  if (!Number.isFinite(parsed.getTime())) {
    const error = new Error('conversionDateTime no tiene un formato válido');
    error.code = 'INVALID_CONVERSION_DATETIME';
    throw error;
  }
  return parsed.toISOString();
}

function buildConsent(consentStatus, adPersonalizationStatus = null) {
  const consent = {};
  const normalized = String(consentStatus || '').trim().toUpperCase();
  if (normalized === 'GRANTED' || normalized === 'CONSENT_GRANTED') {
    consent.adUserData = 'CONSENT_GRANTED';
  } else if (normalized === 'DENIED' || normalized === 'CONSENT_DENIED') {
    consent.adUserData = 'CONSENT_DENIED';
  }
  const normalizedPersonalization = String(adPersonalizationStatus || '').trim().toUpperCase();
  if (normalizedPersonalization === 'GRANTED' || normalizedPersonalization === 'CONSENT_GRANTED') {
    consent.adPersonalization = 'CONSENT_GRANTED';
  } else if (normalizedPersonalization === 'DENIED' || normalizedPersonalization === 'CONSENT_DENIED') {
    consent.adPersonalization = 'CONSENT_DENIED';
  }
  return Object.keys(consent).length ? consent : null;
}

function buildAdIdentifiers({ gclid, gbraid, wbraid } = {}) {
  if (cleanString(gclid)) return { gclid: cleanString(gclid) };
  if (cleanString(gbraid)) return { gbraid: cleanString(gbraid) };
  if (cleanString(wbraid)) return { wbraid: cleanString(wbraid) };
  return null;
}

function buildDataManagerEventRequest({
  customerId,
  conversionAction,
  gclid,
  gbraid,
  wbraid,
  value = 0,
  currency = 'EUR',
  conversionDateTime,
  externalId,
  eventName,
  consentStatus,
  adPersonalizationStatus = null,
  email = null,
  phone = null,
  enhancedConversionAuthorization = null,
  loginCustomerId = null,
  eventSource = 'WEB',
  defaultPhoneCountryCode = process.env.GOOGLE_DATA_MANAGER_DEFAULT_PHONE_COUNTRY_CODE || null,
  validateOnly = false
} = {}) {
  const operatingAccountId = cleanDigits(customerId);
  const productDestinationId = extractConversionActionId(conversionAction);
  if (!operatingAccountId) {
    const error = new Error('customerId es obligatorio');
    error.code = 'CUSTOMER_ID_REQUIRED';
    throw error;
  }
  if (!productDestinationId) {
    const error = new Error('conversionAction debe identificar una acción de conversión numérica');
    error.code = 'CONVERSION_ACTION_REQUIRED';
    throw error;
  }

  const destination = {
    operatingAccount: {
      accountType: 'GOOGLE_ADS',
      accountId: operatingAccountId
    },
    productDestinationId
  };
  const loginAccountId = cleanDigits(loginCustomerId);
  if (loginAccountId) {
    destination.loginAccount = {
      accountType: 'GOOGLE_ADS',
      accountId: loginAccountId
    };
  }

  const event = {
    eventTimestamp: toRfc3339(conversionDateTime),
    eventSource: String(eventSource || 'WEB').trim().toUpperCase(),
    conversionValue: Number.isFinite(Number(value)) ? Number(value) : 0,
    currency: String(currency || 'EUR').trim().toUpperCase()
  };
  const transactionId = cleanString(externalId);
  if (transactionId) event.transactionId = transactionId;
  const normalizedEventName = cleanString(eventName);
  if (normalizedEventName) event.eventName = normalizedEventName;
  const adIdentifiers = buildAdIdentifiers({ gclid, gbraid, wbraid });
  if (adIdentifiers) event.adIdentifiers = adIdentifiers;
  const consent = buildConsent(consentStatus, adPersonalizationStatus);
  if (consent) event.consent = consent;
  const userDataWasProvided = Boolean(cleanString(email) || cleanString(phone));
  const enhancedConversionWasRequested = userDataWasProvided || Boolean(enhancedConversionAuthorization);
  let userIdentifiers = [];
  if (enhancedConversionWasRequested) {
    const authorizationResult = validateEnhancedConversionAuthorization({
      authorization: enhancedConversionAuthorization,
      customerId: operatingAccountId,
      eventName: normalizedEventName,
      consentStatus,
      adPersonalizationStatus
    });
    if (!authorizationResult.valid) {
      throw enhancedConversionAuthorizationError(authorizationResult.reason);
    }
    userIdentifiers = buildEnhancedConversionUserIdentifiers({
      email,
      phone,
      defaultPhoneCountryCode,
      permittedIdentifiers: authorizationResult.permittedIdentifiers
    });
    if (userIdentifiers.length) event.userData = { userIdentifiers };
  }
  if (!event.adIdentifiers && !userIdentifiers.length) {
    const error = new Error('Se requiere un click id o una señal de usuario expresamente autorizada');
    error.code = 'NO_IDENTIFIERS_PROVIDED';
    throw error;
  }

  const payload = {
    destinations: [destination],
    events: [event],
    validateOnly: validateOnly === true
  };
  if (userIdentifiers.length) payload.encoding = 'HEX';
  return payload;
}

function getDataManagerBaseUrl() {
  return String(process.env.GOOGLE_DATA_MANAGER_API_BASE_URL || DEFAULT_DATA_MANAGER_BASE_URL).replace(/\/+$/, '');
}

function getQuotaProjectId(explicitValue = null) {
  return cleanString(
    explicitValue
      || process.env.GOOGLE_DATA_MANAGER_QUOTA_PROJECT
      || process.env.GOOGLE_CLOUD_PROJECT
  );
}

function requireQuotaProjectId(explicitValue = null) {
  const quotaProjectId = getQuotaProjectId(explicitValue);
  if (quotaProjectId) return quotaProjectId;
  const error = new Error('Falta GOOGLE_DATA_MANAGER_QUOTA_PROJECT para facturación y cuota de Data Manager');
  error.code = 'GOOGLE_DATA_MANAGER_QUOTA_PROJECT_REQUIRED';
  throw error;
}

async function uploadConversionEvent({
  accessToken,
  request = axios,
  timeoutMs = 10000,
  quotaProjectId = null,
  ...input
} = {}) {
  if (!accessToken) throw scopedCredentialError();
  const resolvedQuotaProjectId = requireQuotaProjectId(quotaProjectId);
  const data = buildDataManagerEventRequest(input);
  const response = await request.post(`${getDataManagerBaseUrl()}/events:ingest`, data, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-goog-user-project': resolvedQuotaProjectId,
      'Content-Type': 'application/json'
    },
    timeout: timeoutMs
  });
  return response?.data || {};
}

async function retrieveRequestStatus({
  accessToken,
  requestId,
  request = axios,
  timeoutMs = 10000,
  quotaProjectId = null
} = {}) {
  if (!accessToken) throw scopedCredentialError();
  const resolvedQuotaProjectId = requireQuotaProjectId(quotaProjectId);
  const normalizedRequestId = cleanString(requestId);
  if (!normalizedRequestId) {
    const error = new Error('requestId es obligatorio');
    error.code = 'REQUEST_ID_REQUIRED';
    throw error;
  }
  const response = await request.get(`${getDataManagerBaseUrl()}/requestStatus:retrieve`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'x-goog-user-project': resolvedQuotaProjectId
    },
    params: { requestId: normalizedRequestId },
    timeout: timeoutMs
  });
  return response?.data || {};
}

module.exports = {
  GOOGLE_DATA_MANAGER_SCOPE,
  GOOGLE_DATA_MANAGER_USER_DATA_POLICY,
  GOOGLE_ENHANCED_CONVERSION_ALLOWED_IDENTIFIERS,
  GOOGLE_ENHANCED_CONVERSION_POLICY_MODE,
  GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_CUSTOMER_IDS,
  GOOGLE_ENHANCED_CONVERSION_PROPDENTAL_EVENTS,
  buildAdIdentifiers,
  buildAddressIdentifier,
  buildConsent,
  buildDataManagerEventRequest,
  buildEnhancedConversionUserIdentifiers,
  buildUserIdentifiers,
  buildUserProperties,
  extractConversionActionId,
  getQuotaProjectId,
  normalizeAndHashEmail,
  normalizeAndHashName,
  normalizeAndHashPhone,
  normalizePhoneE164,
  retrieveRequestStatus,
  requireQuotaProjectId,
  scopedCredentialError,
  toRfc3339,
  uploadConversionEvent,
  validateEnhancedConversionAuthorization
};
