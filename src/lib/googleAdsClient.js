'use strict';

const axios = require('axios');
const { ApiUsageCounter } = require('../../models');

let googleAdsRequestCount = 0;
let googleAdsQuota = null;
let googleAdsUsageResetAt = 0;
let googleAdsPauseUntil = 0;
let lastGoogleUsagePct = 0;

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

function buildBaseUrls() {
  const endpoint = (process.env.GOOGLE_ADS_API_ENDPOINT || 'https://googleads.googleapis.com').replace(/\/+$/, '');
  const mainVersion = (process.env.GOOGLE_ADS_API_VERSION || 'v21').replace(/^\/+/, '');
  const fallbacks = (process.env.GOOGLE_ADS_API_VERSION_FALLBACKS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
    .map(v => v.replace(/^\/+/, ''));

  const configured = process.env.GOOGLE_ADS_API_BASE_URL ? process.env.GOOGLE_ADS_API_BASE_URL.replace(/\/+$/, '') : null;
  if (configured) {
    return [configured];
  }
  const versions = [mainVersion, ...fallbacks];
  const bases = [];
  for (const version of versions) {
    bases.push(`${endpoint}/googleads/${version}`);
    bases.push(`${endpoint}/${version}`);
  }
  return bases;
}

async function googleAdsRequest(method = 'GET', path, { accessToken, loginCustomerId, params, data } = {}) {
  const { developerToken } = ensureGoogleAdsConfig();
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

  const baseUrls = buildBaseUrls();
  if (!baseUrls.length) {
    const err = new Error('No hay endpoints configurados para Google Ads');
    err.code = 'ADS_ENDPOINT_MISSING';
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

  const preferredMethods = Array.isArray(method) ? method : [method];
  if (!preferredMethods.includes('POST')) {
    preferredMethods.push('POST');
  }

  let lastError = null;
  for (const httpMethod of preferredMethods) {
    for (let i = 0; i < baseUrls.length; i += 1) {
      const base = baseUrls[i];
      const isLastAttempt = httpMethod === preferredMethods[preferredMethods.length - 1] && i === baseUrls.length - 1;
      const requestUrl = `${base}/${path}`;
      try {
        const headers = (httpMethod === 'POST')
          ? { ...headersBase, 'Content-Type': 'application/json' }
          : headersBase;
        const resp = await axios({
          method: httpMethod,
          url: requestUrl,
          params: queryParams,
          data: typeof data === 'undefined' ? (httpMethod === 'POST' ? {} : undefined) : data,
          headers
        });
        const h = resp.headers || {};
        const appUsage = parseUsageHeader(h['x-app-usage']);
        const adUsage = parseUsageHeader(h['x-ad-account-usage']);
        const pageUsage = parseUsageHeader(h['x-page-usage']);
        const bizUsage = parseUsageHeader(h['x-business-use-case-usage']);
        const usage = Math.max(appUsage, adUsage, pageUsage, bizUsage);
        if (usage) {
          lastGoogleUsagePct = usage;
        }
        if (usage >= thresh) {
          if (waitNextHour) {
            const d = new Date();
            d.setMinutes(60, 0, 0); // top of next hour
            googleAdsPauseUntil = Math.max(googleAdsPauseUntil, d.getTime());
            console.warn(`⚠️ Uso alto (${usage}%). Pausando hasta la próxima hora.`);
          } else {
            googleAdsPauseUntil = Math.max(googleAdsPauseUntil, Date.now() + 60_000);
            console.warn(`⚠️ Uso alto (${usage}%). Pausando 60s.`);
          }
        }
        await updateGoogleUsageCounter({ usagePct: lastGoogleUsagePct, pauseUntil: googleAdsPauseUntil ? new Date(googleAdsPauseUntil) : null, quota: quotaLimit });
        return resp.data;
      } catch (err) {
        const status = err.response?.status;
        if ((status === 404 || status === 405) && !isLastAttempt) {
          lastError = err;
          if (status === 405) break; // probar con POST
          continue;
        }
        await updateGoogleUsageCounter({ usagePct: lastGoogleUsagePct, pauseUntil: googleAdsPauseUntil ? new Date(googleAdsPauseUntil) : null, quota: quotaLimit });
        throw err;
      }
    }
  }
  if (lastError) throw lastError;
  const fallbackError = new Error('No se pudo contactar con Google Ads API');
  fallbackError.code = 'ADS_API_UNREACHABLE';
  throw fallbackError;
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
  googleAdsRequest,
  normalizeCustomerId,
  formatCustomerId,
  ensureGoogleAdsConfig,
  getGoogleAdsUsageStatus,
  resumeGoogleAdsUsage
};
