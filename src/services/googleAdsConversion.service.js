'use strict';

const crypto = require('crypto');
const { googleAdsRequest, normalizeCustomerId } = require('../lib/googleAdsClient');

function scopedCredentialError() {
  const error = new Error('Se requiere el access token OAuth resuelto para la clínica o grupo');
  error.code = 'SCOPED_GOOGLE_CREDENTIAL_REQUIRED';
  return error;
}

function assertSuccessfulUploadResponse(data) {
  const partialFailure = data?.partialFailureError || data?.partial_failure_error || null;
  if (!partialFailure) return data;

  const error = new Error(
    partialFailure.message || 'Google Ads rechazó parcial o totalmente la conversión'
  );
  error.code = 'GOOGLE_ADS_PARTIAL_FAILURE';
  error.providerError = partialFailure;
  throw error;
}

async function createConversionActions({
  customerId,
  actions = [],
  accessToken,
  loginCustomerId = null,
  validateOnly = false,
  request = googleAdsRequest
} = {}) {
  if (!accessToken) throw scopedCredentialError();
  const cleanCustomerId = normalizeCustomerId(customerId);
  if (!cleanCustomerId) {
    const error = new Error('customerId es obligatorio');
    error.code = 'CUSTOMER_ID_REQUIRED';
    throw error;
  }

  return request('POST', `customers/${cleanCustomerId}/conversionActions:mutate`, {
    accessToken,
    loginCustomerId: loginCustomerId || undefined,
    singleAttempt: true,
    timeoutMs: 10000,
    data: {
      operations: actions.map((action) => ({ create: action })),
      validateOnly: validateOnly === true
    }
  });
}

function buildClickConversion({
  conversionAction,
  gclid,
  gbraid,
  wbraid,
  value = 0,
  currency = 'EUR',
  conversionDateTime,
  externalId,
  email,
  phone,
  consentStatus
}) {
  const userIdentifiers = buildUserIdentifiers({ email, phone });
  const conversion = {
    conversionAction,
    conversionDateTime,
    currencyCode: currency,
    conversionValue: value,
    ...(gclid ? { gclid } : {}),
    ...(gbraid ? { gbraid } : {}),
    ...(wbraid ? { wbraid } : {}),
    ...(externalId ? { orderId: externalId } : {})
  };
  if (userIdentifiers.length) conversion.userIdentifiers = userIdentifiers;
  if (consentStatus) conversion.consent = { adUserData: consentStatus };
  return conversion;
}

async function uploadClickConversion({
  customerId,
  conversionAction,
  gclid,
  gbraid,
  wbraid,
  value = 0,
  currency = 'EUR',
  conversionDateTime,
  externalId,
  email,
  phone,
  consentStatus,
  accessToken,
  loginCustomerId = null,
  validateOnly = false,
  request = googleAdsRequest
}) {
  if (!accessToken) throw scopedCredentialError();
  const cleanCustomerId = normalizeCustomerId(customerId);
  if (!cleanCustomerId) {
    const error = new Error('customerId es obligatorio');
    error.code = 'CUSTOMER_ID_REQUIRED';
    throw error;
  }

  const conversion = buildClickConversion({
    conversionAction,
    gclid,
    gbraid,
    wbraid,
    value,
    currency,
    conversionDateTime,
    externalId,
    email,
    phone,
    consentStatus
  });
  const data = await request('POST', `customers/${cleanCustomerId}:uploadClickConversions`, {
    accessToken,
    loginCustomerId: loginCustomerId || undefined,
    singleAttempt: true,
    timeoutMs: 10000,
    data: {
      conversions: [conversion],
      partialFailure: true,
      validateOnly: validateOnly === true
    }
  });
  return assertSuccessfulUploadResponse(data);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function normalizeAndHashEmail(email) {
  if (!email) return null;
  const raw = String(email).trim().toLowerCase();
  const at = raw.indexOf('@');
  if (at <= 0 || at === raw.length - 1) return null;
  let local = raw.slice(0, at);
  const domain = raw.slice(at + 1);
  if (!domain) return null;
  if (domain === 'gmail.com' || domain === 'googlemail.com') {
    local = local.replace(/\./g, '');
  }
  return sha256(`${local}@${domain}`);
}

function normalizeAndHashPhone(phone) {
  if (!phone) return null;
  let digits = String(phone).replace(/\D/g, '');
  if (!digits) return null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  return sha256(`+${digits}`);
}

function buildUserIdentifiers({ email, phone }) {
  const out = [];
  const hashedEmail = normalizeAndHashEmail(email);
  if (hashedEmail) out.push({ hashedEmail, userIdentifierSource: 'FIRST_PARTY' });
  const hashedPhone = normalizeAndHashPhone(phone);
  if (hashedPhone) out.push({ hashedPhoneNumber: hashedPhone, userIdentifierSource: 'FIRST_PARTY' });
  return out;
}

function leadActionPayload(name = 'Lead - ClinicaClick') {
  return {
    name,
    category: 'SUBMIT_LEAD_FORM',
    type: 'UPLOAD_CLICKS',
    status: 'ENABLED',
    includeInConversionsMetric: true,
    valueSettings: {
      defaultValue: 0,
      alwaysUseDefaultValue: false,
      defaultCurrencyCode: 'EUR'
    },
    countingType: 'ONE_PER_CLICK'
  };
}

function purchaseActionPayload(name = 'Purchase - ClinicaClick') {
  return {
    ...leadActionPayload(name),
    category: 'PURCHASE'
  };
}

module.exports = {
  assertSuccessfulUploadResponse,
  buildClickConversion,
  buildUserIdentifiers,
  createConversionActions,
  leadActionPayload,
  normalizeAndHashEmail,
  normalizeAndHashPhone,
  purchaseActionPayload,
  uploadClickConversion
};
