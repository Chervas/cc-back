'use strict';
const axios = require('axios');
const crypto = require('crypto');
const { normalizePhoneDigits } = require('../lib/phone');

const DEFAULT_PIXEL_ID = process.env.META_PIXEL_ID;
const DEFAULT_CAPI_TOKEN = process.env.META_CAPI_TOKEN;
const PRIMARY_VERSION = process.env.META_API_VERSION || 'v25.0';
const FALLBACK_VERSIONS = (process.env.META_API_FALLBACKS || 'v20.0,v19.0,v18.0,v17.0')
  .split(',')
  .map(v => v.trim())
  .filter(Boolean);

const hashSha256 = (value) => {
  if (!value) return null;
  return crypto.createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
};

const normalizePhone = (phone) => {
  return normalizePhoneDigits(phone);
};

async function sendEvent(payload, options = {}) {
  const pixelId = options.pixelId || DEFAULT_PIXEL_ID;
  const accessToken = options.accessToken || DEFAULT_CAPI_TOKEN;
  if (!pixelId || !accessToken) return;
  const versions = [PRIMARY_VERSION, ...FALLBACK_VERSIONS];
  let lastError = null;
  for (const version of versions) {
    const url = `https://graph.facebook.com/${version}/${pixelId}/events`;
    try {
      await axios.post(url, payload, {
        params: { access_token: accessToken },
        timeout: 8000
      });
      return;
    } catch (err) {
      lastError = err.response?.data || err.message;
      // Only retry on path/version errors
      if (err.response?.data?.error?.code === 2500 || err.response?.data?.error?.code === 100) {
        continue;
      }
      break;
    }
  }
  console.warn('⚠️ Meta CAPI event failed:', lastError);
}

function buildUserData({ email, phone, ip, ua, fbp, fbc, externalId }) {
  const userData = {};
  const em = hashSha256(email);
  const ph = hashSha256(normalizePhone(phone));
  const ext = externalId ? hashSha256(externalId) : null;
  if (em) userData.em = [em];
  if (ph) userData.ph = [ph];
  if (ext) userData.external_id = [ext];
  if (ip) userData.client_ip_address = ip;
  if (ua) userData.client_user_agent = ua;
  if (fbp) userData.fbp = fbp;
  if (fbc) userData.fbc = fbc;
  return userData;
}

async function sendMetaEvent({
  eventName = 'Lead',
  eventTime = Math.floor(Date.now() / 1000),
  eventId,
  actionSource = 'website',
  eventSourceUrl,
  clinicId,
  source,
  sourceDetail,
  utmCampaign,
  value,
  currency = 'EUR',
  userData,
  pixelId = null,
  accessToken = null
}) {
  if (!(pixelId || DEFAULT_PIXEL_ID) || !(accessToken || DEFAULT_CAPI_TOKEN)) return;

  const data = [{
    event_name: eventName,
    event_time: eventTime,
    event_id: eventId,
    action_source: actionSource,
    event_source_url: eventSourceUrl,
    custom_data: {
      clinic_id: clinicId || undefined,
      source: source || undefined,
      source_detail: sourceDetail || undefined,
      utm_campaign: utmCampaign || undefined,
      value: value || undefined,
      currency: value ? currency : undefined
    },
    user_data: userData
  }];

  return sendEvent({ data }, { pixelId, accessToken });
}

module.exports = {
  sendLead: sendMetaEvent,
  sendMetaEvent,
  buildUserData
};
