'use strict';
const axios = require('axios');

let nextAllowedAt = 0; // epoch ms
let lastUsagePct = 0; // last observed usage percentage across headers

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function parseUsageHeader(h) {
  try {
    if (!h) return 0;
    const obj = typeof h === 'string' ? JSON.parse(h) : h;
    // Headers can be {call_count:%, total_cputime:%, total_time:%} or more nested
    if (obj.call_count != null) {
      return Math.max(Number(obj.call_count)||0, Number(obj.total_cputime)||0, Number(obj.total_time)||0);
    }
    // X-Business-Use-Case-Usage example: {"174...": [{... usage: 85}]} — take max usage
    const values = Object.values(obj);
    if (values.length && Array.isArray(values[0])) {
      return values[0].reduce((m, v) => Math.max(m, Number(v?.usage)||0), 0);
    }
    return 0;
  } catch {
    return 0;
  }
}

async function metaGet(url, { params = {}, accessToken, timeout = 30000 } = {}) {
  const META_API_BASE_URL = process.env.META_API_BASE_URL || 'https://graph.facebook.com/v23.0';
  // Retardo suave entre requests (ms). Previene picos de uso.
  const delayMs = parseInt(process.env.METASYNC_REQUEST_DELAY_MS || '300', 10);
  // Umbral de uso (%) a partir del cual activamos backoff
  const thresh = parseInt(process.env.METASYNC_RATE_LIMIT_THRESHOLD || '90', 10);
  // Reintentos máximos para errores no RL
  const maxRetries = parseInt(process.env.METASYNC_MAX_RETRIES || '3', 10);
  // En rate limit, esperar hasta la siguiente hora (true) o hacer backoff corto (false)
  const waitNextHour = String(process.env.METASYNC_WAIT_NEXT_HOUR_ON_LIMIT || 'true') === 'true';

  // Respect global gate
  const now = Date.now();
  if (now < nextAllowedAt) {
    const toWait = nextAllowedAt - now;
    console.log(`⏸️ MetaClient: esperando ${Math.ceil(toWait/1000)}s por rate-limit`);
    await sleep(toWait);
  }

  let attempt = 0;
  let lastErr;
  while (attempt <= maxRetries) {
    attempt++;
    try {
      // Delay gentle between calls
      if (attempt === 1 && delayMs > 0) await sleep(delayMs);

      const fullUrl = url.startsWith('http') ? url : `${META_API_BASE_URL}/${url.replace(/^\//,'')}`;
      const resp = await axios.get(fullUrl, {
        params: accessToken ? { ...params, access_token: accessToken } : params,
        timeout
      });

      // Parse usage headers to update nextAllowedAt if needed
      const h = resp.headers || {};
      const appUsage = parseUsageHeader(h['x-app-usage']);
      const adUsage = parseUsageHeader(h['x-ad-account-usage']);
      const pageUsage = parseUsageHeader(h['x-page-usage']);
      const bizUsage = parseUsageHeader(h['x-business-use-case-usage']);
      const usage = Math.max(appUsage, adUsage, pageUsage, bizUsage);
      lastUsagePct = usage;
      if (usage >= thresh) {
        if (waitNextHour) {
          const d = new Date();
          d.setMinutes(60, 0, 0); // top of next hour
          nextAllowedAt = Math.max(nextAllowedAt, d.getTime());
          console.warn(`⚠️ Uso alto (${usage}%). Pausando hasta la próxima hora.`);
        } else {
          nextAllowedAt = Math.max(nextAllowedAt, Date.now() + 60_000);
          console.warn(`⚠️ Uso alto (${usage}%). Pausando 60s.`);
        }
      }

      return resp;
    } catch (err) {
      lastErr = err;
      const code = err?.response?.data?.error?.code;
      const subcode = err?.response?.data?.error?.error_subcode;
      const isRatelimit = code === 4 || code === 17 || code === 613; // common RL codes
      if (isRatelimit) {
        if (waitNextHour) {
          const d = new Date(); d.setMinutes(60, 0, 0);
          nextAllowedAt = Math.max(nextAllowedAt, d.getTime());
          console.warn(`⏸️ Rate limit (code ${code}). Esperando hasta la próxima hora.`);
        } else {
          const backoff = Math.min(30_000 * attempt, 120_000); // up to 2m
          console.warn(`⏸️ Rate limit (code ${code}). Reintentando en ${Math.ceil(backoff/1000)}s (intento ${attempt}/${maxRetries})`);
          await sleep(backoff);
        }
        continue;
      }
      if (attempt <= maxRetries) {
        const backoff = 1000 * attempt;
        console.warn(`⚠️ Error Meta (intento ${attempt}/${maxRetries}): ${err.message}. Reintentando en ${backoff}ms`);
        await sleep(backoff);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

module.exports = { metaGet };

// Exponer estado de uso/limit para monitorización
module.exports.getUsageStatus = function getUsageStatus() {
  return {
    usagePct: lastUsagePct,
    nextAllowedAt,
    now: Date.now()
  };
}
