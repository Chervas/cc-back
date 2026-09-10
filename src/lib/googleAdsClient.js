'use strict';

const axios = require('axios');
const { ApiUsageCounter } = require('../../models');

let googleAdsRequestCount = 0;
let googleAdsQuota = null;
let googleAdsUsageResetAt = 0;
let googleAdsPauseUntil = 0;
let lastGoogleUsagePct = 0;
const GOOGLE_ADS_API_VERSION = 'v24';

function startOfNextDay() {
  const d = new Date();
  d.setHours(24, 0, 0, 0);
  return d.getTime();
}

function parseUsageHeader(h) {
  try {
    if (!h) return 0;
    const obj = typeof h === 'string' ? JSON.parse(h) : h;
    if (obj.call_count != null) {
      return Math.max(Number(obj.call_count) || 0, Number(obj.total_cputime) || 0, Number(obj.total_time) || 0);
    }
    const values = Object.values(obj || {});
    if (values.length && Array.isArray(values[0])) {
      return values[0].reduce((m, v) => Math.max(m, Number(v?.usage) || 0), 0);
    }
    return 0;
  } catch (e) {
    return 0;
  }
}

async function resetGoogleUsageCounter(limit) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const defaults = {
    usageDate: todayStr,
    requestCount: 0,
    usagePct: 0,
    pauseUntil: null,
    metadata: { quota: limit }
  };
  const [counter, created] = await ApiUsageCounter.findOrCreate({
    where: { provider: 'google_ads' },
    defaults
  });
  if (!created) {
    await counter.update(defaults);
  }
}

async function ensureDailyWindow(limit) {
  const now = Date.now();
  if (now >= googleAdsUsageResetAt) {
    googleAdsUsageResetAt = startOfNextDay();
    googleAdsRequestCount = 0;
    googleAdsQuota = limit;
    googleAdsPauseUntil = 0;
    lastGoogleUsagePct = 0;
    await resetGoogleUsageCounter(limit);
  }
}

async function updateGoogleUsageCounter({ increment = 0, usagePct = null, pauseUntil = undefined, quota = null }) {
  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const [counter] = await ApiUsageCounter.findOrCreate({
    where: { provider: 'google_ads' },
    defaults: {
      usageDate: todayStr,
      requestCount: 0,
      usagePct: 0,
      pauseUntil: null,
      metadata: { quota: quota ?? googleAdsQuota }
    }
  });
  const updates = {};
  if (counter.usageDate !== todayStr) {
    updates.usageDate = todayStr;
    updates.requestCount = 0;
    updates.usagePct = 0;
    updates.pauseUntil = null;
  }
  const effectiveCount = updates.requestCount != null ? updates.requestCount : counter.requestCount;
  if (increment) {
    updates.requestCount = effectiveCount + increment;
  }
  if (typeof usagePct === 'number' && !Number.isNaN(usagePct)) {
    updates.usagePct = usagePct;
  }
  if (pauseUntil !== undefined) {
    updates.pauseUntil = pauseUntil ? new Date(pauseUntil) : null;
  }
  if (quota) {
    updates.metadata = { ...(counter.metadata || {}), quota };
  }
  if (Object.keys(updates).length) {
    await counter.update(updates);
  }
}

function normalizeCustomerId(raw) {
  if (!raw) return '';
  return String(raw).replace(/[^0-9]/g, '');
}

function formatCustomerId(raw) {
  const clean = normalizeCustomerId(raw);
  if (clean.length !== 10) return clean;
  return `${clean.slice(0,3)}-${clean.slice(3,6)}-${clean.slice(6)}`;
}

function ensureGoogleAdsConfig() {
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN || '';
  if (!developerToken) {
    const err = new Error('GOOGLE_ADS_DEVELOPER_TOKEN no está configurado');
    err.code = 'ADS_CONFIG_MISSING';
    throw err;
  }
  const managerId = normalizeCustomerId(process.env.GOOGLE_ADS_MANAGER_ID || '');
  if (!managerId) {
    const err = new Error('GOOGLE_ADS_MANAGER_ID no está configurado');
    err.code = 'ADS_CONFIG_MISSING';
    throw err;
  }
  return { developerToken, managerId };
}

function buildBaseUrls(apiVersion) {
  if (apiVersion !== undefined && !/^v[1-9]\d*(?:\.\d+)?$/.test(apiVersion)) {
    throw Object.assign(new Error('Invalid Google Ads API version'), { code: 'ADS_API_VERSION_INVALID' });
  }
  const endpoint = (process.env.GOOGLE_ADS_API_ENDPOINT || 'https://googleads.googleapis.com').replace(/\/+$/, '');
  const mainVersion = (process.env.GOOGLE_ADS_API_VERSION || GOOGLE_ADS_API_VERSION).replace(/^\/+/, '');
  if (!/^v[1-9]\d*(?:\.\d+)?$/.test(mainVersion)) {
    throw Object.assign(new Error('Invalid Google Ads API version'), { code: 'ADS_API_VERSION_INVALID' });
  }

  const configured = process.env.GOOGLE_ADS_API_BASE_URL ? process.env.GOOGLE_ADS_API_BASE_URL.replace(/\/+$/, '') : null;
  if (configured) {
    if (apiVersion !== undefined) {
      if (!/\/v\d+(?:\.\d+)?$/.test(configured)) {
        throw Object.assign(new Error('Configured Google Ads base URL has no version'), { code: 'ADS_API_VERSION_INVALID' });
      }
      return [configured.replace(/\/v\d+(?:\.\d+)?$/, `/${apiVersion}`)];
    }
    return [configured];
  }
  return [`${endpoint}/${apiVersion || mainVersion}`];
}

async function googleAdsRequest(method = 'GET', path, {
  accessToken,
  apiVersion,
  loginCustomerId,
  params,
  data,
  waitNextHour = false,
  timeoutMs = Math.max(
    1000,
    Number(process.env.GOOGLE_ADS_HTTP_TIMEOUT_MS || process.env.SYNC_PROVIDER_HTTP_TIMEOUT_MS || 30000) || 30000
  )
} = {}) {
  const { developerToken } = ensureGoogleAdsConfig();
  const [baseUrl] = buildBaseUrls(apiVersion);
  if (typeof method !== 'string' || !/^(GET|POST|PUT|PATCH|DELETE)$/.test(method)) {
    throw Object.assign(new Error('Invalid Google Ads HTTP method'), { code: 'ADS_HTTP_METHOD_INVALID' });
  }
  const quotaLimit = parseInt(process.env.GOOGLE_ADS_DAILY_QUOTA || '1500', 10);
  await ensureDailyWindow(quotaLimit);
  const thresh = parseInt(process.env.GOOGLE_ADS_USAGE_THRESHOLD || '90', 10);

  const now = Date.now();
  if (googleAdsPauseUntil && now < googleAdsPauseUntil) {
    const err = new Error('Google Ads API pausada por límite');
    err.code = 'GOOGLE_ADS_PAUSED';
    err.retryAt = googleAdsPauseUntil;
    throw err;
  }

  googleAdsRequestCount += 1;
  lastGoogleUsagePct = Math.min(100, (googleAdsRequestCount / quotaLimit) * 100);
  await updateGoogleUsageCounter({ increment: 1, usagePct: lastGoogleUsagePct, quota: quotaLimit, pauseUntil: googleAdsPauseUntil ? new Date(googleAdsPauseUntil) : null });
  if (googleAdsRequestCount >= quotaLimit) {
    googleAdsPauseUntil = startOfNextDay();
    await updateGoogleUsageCounter({ usagePct: 100, pauseUntil: new Date(googleAdsPauseUntil), quota: quotaLimit });
    const err = new Error('Se alcanzó el límite diario de Google Ads API');
    err.code = 'GOOGLE_ADS_QUOTA_REACHED';
    err.retryAt = googleAdsPauseUntil;
    throw err;
  }

  const headersBase = {
    Authorization: `Bearer ${accessToken}`,
    'developer-token': developerToken,
    Accept: 'application/json'
  };
  if (loginCustomerId) {
    headersBase['login-customer-id'] = normalizeCustomerId(loginCustomerId);
  }

  const queryParams = { ...(params || {}) };
  if (!Object.prototype.hasOwnProperty.call(queryParams, 'alt')) {
    queryParams.alt = 'json';
  }

  // Never retry a provider command against another API version, route or HTTP method.
  try {
    const headers = method === 'POST' ? { ...headersBase, 'Content-Type': 'application/json' } : headersBase;
    const resp = await axios({
      method, url: `${baseUrl}/${path}`, params: queryParams,
      data: typeof data === 'undefined' ? (method === 'POST' ? {} : undefined) : data,
      headers, timeout: timeoutMs, maxRedirects: 0
    });
    const h = resp.headers || {};
    const usage = Math.max(...['x-app-usage', 'x-ad-account-usage', 'x-page-usage', 'x-business-use-case-usage']
      .map(header => parseUsageHeader(h[header])));
    if (usage) lastGoogleUsagePct = usage;
    if (usage >= thresh) {
      if (waitNextHour) {
        const d = new Date();
        d.setMinutes(60, 0, 0);
        googleAdsPauseUntil = Math.max(googleAdsPauseUntil, d.getTime());
      } else {
        googleAdsPauseUntil = Math.max(googleAdsPauseUntil, Date.now() + 60_000);
      }
    }
    return resp.data;
  } finally {
    await updateGoogleUsageCounter({ usagePct: lastGoogleUsagePct, pauseUntil: googleAdsPauseUntil ? new Date(googleAdsPauseUntil) : null, quota: quotaLimit });
  }
}

async function getGoogleAdsUsageStatus() {
  const quota = parseInt(process.env.GOOGLE_ADS_DAILY_QUOTA || '1500', 10);
  await ensureDailyWindow(quota);
  const counter = await ApiUsageCounter.findOne({ where: { provider: 'google_ads' } });
  return {
    usagePct: counter?.usagePct ?? lastGoogleUsagePct,
    requestCount: counter?.requestCount ?? googleAdsRequestCount,
    quota,
    resetAt: googleAdsUsageResetAt,
    pauseUntil: (counter?.pauseUntil ? new Date(counter.pauseUntil).getTime() : googleAdsPauseUntil) || 0,
    now: Date.now()
  };
}

async function resumeGoogleAdsUsage() {
  googleAdsPauseUntil = 0;
  await updateGoogleUsageCounter({ pauseUntil: null });
}

module.exports = {
  GOOGLE_ADS_API_VERSION,
  GOOGLE_ADS_CONVERSIONS_API_VERSION: GOOGLE_ADS_API_VERSION,
  buildBaseUrls,
  googleAdsRequest,
  normalizeCustomerId,
  formatCustomerId,
  ensureGoogleAdsConfig,
  getGoogleAdsUsageStatus,
  resumeGoogleAdsUsage
};
