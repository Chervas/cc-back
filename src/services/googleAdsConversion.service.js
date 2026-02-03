'use strict';
const axios = require('axios');

const DEV_TOKEN = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_ADS_REFRESH_TOKEN;
const LOGIN_CUSTOMER_ID = (process.env.GOOGLE_ADS_MANAGER_ID || '').replace(/-/g, '');
const API_VERSION = process.env.GOOGLE_ADS_API_VERSION || 'v23';
const DEFAULT_CUSTOMER_ID = (process.env.GOOGLE_ADS_CUSTOMER_ID || '').replace(/-/g, '');

async function getAccessToken() {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    throw new Error('Faltan GOOGLE_CLIENT_ID/SECRET o GOOGLE_ADS_REFRESH_TOKEN');
  }
  const { data } = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
    client_id: CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type: 'refresh_token'
  }), { timeout: 8000 });
  return data.access_token;
}

function buildHeaders(accessToken) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': DEV_TOKEN,
    ...(LOGIN_CUSTOMER_ID ? { 'login-customer-id': LOGIN_CUSTOMER_ID } : {})
  };
}

async function createConversionActions(customerId, actions = []) {
  if (!DEV_TOKEN) throw new Error('Falta GOOGLE_ADS_DEVELOPER_TOKEN');
  const accessToken = await getAccessToken();
  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${String(customerId).replace(/-/g, '')}/conversionActions:mutate`;
  const operations = actions.map(a => ({ create: a }));
  const { data } = await axios.post(url, { operations }, {
    headers: buildHeaders(accessToken),
    timeout: 10000
  });
  return data;
}

async function uploadClickConversion({
  customerId = DEFAULT_CUSTOMER_ID,
  conversionAction,
  gclid,
  gbraid,
  wbraid,
  value = 0,
  currency = 'EUR',
  conversionDateTime,
  externalId,
  userAgent,
  ipAddress
}) {
  if (!DEV_TOKEN) throw new Error('Falta GOOGLE_ADS_DEVELOPER_TOKEN');
  const accessToken = await getAccessToken();
  const url = `https://googleads.googleapis.com/${API_VERSION}/customers/${String(customerId).replace(/-/g, '')}:uploadClickConversions`;
  const conversions = [{
    conversionAction,
    conversionDateTime,
    currencyCode: currency,
    conversionValue: value,
    gclid,
    gbraid,
    wbraid,
    orderId: externalId,
    userIdentifiers: [
      externalId ? { userIdentifierSource: 'FIRST_PARTY', hashedUserId: externalId } : null,
      userAgent ? { userIdentifierSource: 'FIRST_PARTY', userAgent } : null,
      ipAddress ? { userIdentifierSource: 'FIRST_PARTY', ipAddress } : null
    ].filter(Boolean)
  }];
  const body = { customerId: String(customerId).replace(/-/g, ''), conversions, partialFailure: true, validateOnly: false };
  const { data } = await axios.post(url, body, { headers: buildHeaders(accessToken), timeout: 10000 });
  return data;
}

function leadActionPayload(name = 'Lead – ClinicaClick') {
  return {
    name,
    category: 'LEAD',
    type: 'WEBPAGE',
    status: 'ENABLED',
    includeInConversionsMetric: true,
    valueSettings: {
      defaultValue: 0,
      alwaysUseDefaultValue: false,
      defaultCurrencyCode: 'EUR'
    },
    countingType: 'ONE_PER_CLICK',
    attributionModelSettings: { attributionModel: 'LAST_CLICK' }
  };
}

function purchaseActionPayload(name = 'Purchase – ClinicaClick') {
  return {
    name,
    category: 'PURCHASE',
    type: 'WEBPAGE',
    status: 'ENABLED',
    includeInConversionsMetric: true,
    valueSettings: {
      defaultValue: 0,
      alwaysUseDefaultValue: false,
      defaultCurrencyCode: 'EUR'
    },
    countingType: 'ONE_PER_CLICK',
    attributionModelSettings: { attributionModel: 'LAST_CLICK' }
  };
}

module.exports = {
  createConversionActions,
  leadActionPayload,
  purchaseActionPayload,
  uploadClickConversion
};
