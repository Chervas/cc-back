/**
 * Meta Client · HTTP helper for Meta Graph/Marketing API
 *
 * Qué es
 * - Capa del backend que centraliza las llamadas a la API de Meta (Graph/Marketing).
 * - Aplica protección de cuota/rate‑limit, reintentos con backoff, y logging de errores.
 * - Expone `metaGet(url, { params, accessToken, timeout })` y `getUsageStatus()`.
 *
 * Funciones clave
 * - Retraso suave entre llamadas (`METASYNC_REQUEST_DELAY_MS`) para evitar picos.
 * - Parseo de cabeceras de uso (x-app-usage, x-ad-account-usage, x-page-usage,
 *   x-business-use-case-usage) y pausa automática si se supera `METASYNC_RATE_LIMIT_THRESHOLD`.
 * - Rate limit handling (codes 4/17/613): espera hasta la próxima hora o backoff corto
 *   según `METASYNC_WAIT_NEXT_HOUR_ON_LIMIT`.
 * - Errores 400 (Bad Request): no reintenta; registra el detalle y devuelve el error.
 * - Logging de diagnóstico: status, code, subcode, message, fbtrace_id y endpoint.
 *
 * Configuración (variables de entorno)
 * - META_API_BASE_URL: Base URL de la Graph API (p.ej. https://graph.facebook.com/v23.0)
 * - METASYNC_REQUEST_DELAY_MS: Retardo (ms) entre llamadas (por defecto 300–800ms recomendado)
 * - METASYNC_RATE_LIMIT_THRESHOLD: Umbral (%) para activar pausa/backoff (p.ej. 85–93)
 * - METASYNC_MAX_RETRIES: Reintentos para errores transitorios (no aplica a 400)
 * - METASYNC_WAIT_NEXT_HOUR_ON_LIMIT: true|false → esperar hasta la próxima hora si hay RL
 *
 * Uso básico
 *   const { metaGet } = require('../lib/metaClient');
 *   const resp = await metaGet('act_1234567890/campaigns', {
 *     params: { fields: 'id,name,status', limit: 25 },
 *     accessToken
 *   });
 *   const data = resp.data;
 *
 * Estado de uso
 *   const { getUsageStatus } = require('../lib/metaClient');
 *   const { usagePct, nextAllowedAt, now } = getUsageStatus();
 *
 * Seguridad
 * - Nunca se loguea el access token.
 * - El caller es responsable de la autorización (Page/Ad Account tokens válidos).
 */
'use strict';
const axios = require('axios');
const { ApiUsageCounter } = require('../../models');
const { recordApiUsage } = require('../services/apiUsageTelemetry.service');

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

function rateLimitCooldownMs() {
  return Math.max(
    60 * 60 * 1000,
    Number(process.env.METASYNC_RATE_LIMIT_COOLDOWN_MS || 2 * 60 * 60 * 1000) || 2 * 60 * 60 * 1000
  );
}

async function persistedPauseUntil() {
  try {
    const counter = await ApiUsageCounter.findOne({ where: { provider: 'meta_ads' } });
    const pauseMs = counter?.pauseUntil ? new Date(counter.pauseUntil).getTime() : 0;
    return Number.isFinite(pauseMs) && pauseMs > Date.now() ? pauseMs : 0;
  } catch (error) {
    console.warn('⚠️ MetaClient: no se pudo leer la pausa compartida:', error.message);
    return 0;
  }
}

function pausedError(pauseUntilMs) {
  const error = new Error(`Meta requests paused until ${new Date(pauseUntilMs).toISOString()}`);
  error.code = 'META_RATE_LIMIT_PAUSED';
  error.retryable = false;
  error.pauseUntil = new Date(pauseUntilMs);
  return error;
}

async function updateMetaUsageCounter(usage, {
  source = 'meta_client',
  operation = 'graph_request',
  status = 'ok',
  pauseUntil = undefined,
    error = null,
    requestCount = 1
} = {}) {
  if (typeof usage !== 'number' || Number.isNaN(usage)) {
    return;
  }
  const now = new Date();
  const todayStr = now.toISOString().slice(0, 10);
  const hourBucket = new Date(now); hourBucket.setMinutes(0, 0, 0);
  await recordApiUsage({
    provider: 'meta_ads',
    source,
    operation,
    status,
    usagePct: usage,
    requestCount,
    pauseUntil,
    error,
    metadata: { hourStart: hourBucket.toISOString() }
  });
}

async function metaGet(url, {
  params = {},
  accessToken,
  timeout = 30000,
  source = 'meta_client',
  operation = null
} = {}) {
  const META_API_BASE_URL = process.env.META_API_BASE_URL || 'https://graph.facebook.com/v23.0';
  // Retardo suave entre requests (ms). Previene picos de uso.
  const delayMs = parseInt(process.env.METASYNC_REQUEST_DELAY_MS || '300', 10);
  // Umbral de uso (%) a partir del cual activamos backoff
  const thresh = parseInt(process.env.METASYNC_RATE_LIMIT_THRESHOLD || '90', 10);
  // Reintentos máximos para errores no RL
  const maxRetries = parseInt(process.env.METASYNC_MAX_RETRIES || '3', 10);
  // En rate limit, esperar hasta la siguiente hora (true) o hacer backoff corto (false)
  const waitNextHour = String(process.env.METASYNC_WAIT_NEXT_HOUR_ON_LIMIT || 'true') === 'true';

  // El gate compartido falla rápido: nunca bloquea el carril de jobs durante
  // horas ni vuelve a golpear Graph desde otro proceso tras un reinicio.
  const sharedPauseUntil = await persistedPauseUntil();
  nextAllowedAt = Math.max(nextAllowedAt, sharedPauseUntil);
  if (Date.now() < nextAllowedAt) {
    throw pausedError(nextAllowedAt);
  }

  let attempt = 0;
  let lastErr;
  while (attempt <= maxRetries) {
    attempt++;
    try {
      // Delay gentle between calls
      if (attempt === 1 && delayMs > 0) await sleep(delayMs);

      const fullUrl = url.startsWith('http') ? url : `${META_API_BASE_URL}/${url.replace(/^\//,'')}`;
      const telemetryOperation = operation || String(url || 'graph_request').split('?')[0].slice(0, 120);
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
        nextAllowedAt = Math.max(nextAllowedAt, Date.now() + rateLimitCooldownMs());
        console.warn(`⚠️ Uso alto (${usage}%). Pausando nuevas llamadas Meta.`);
      }
      await updateMetaUsageCounter(usage, {
        source,
        operation: telemetryOperation,
        status: usage >= thresh ? 'rate_limited' : 'ok',
        pauseUntil: nextAllowedAt ? new Date(nextAllowedAt) : undefined
      });

      return resp;
    } catch (err) {
      lastErr = err;
      const status = err?.response?.status;
      const eobj = err?.response?.data?.error || {};
      const code = eobj?.code;
      const subcode = eobj?.error_subcode;

      // Log detallado para diagnóstico
      try {
        const safeUrl = (typeof url === 'string') ? url : '';
        console.error('❌ Meta API error', {
          status,
          code,
          subcode,
          type: eobj?.type,
          message: eobj?.message,
          fbtrace_id: eobj?.fbtrace_id,
          url: safeUrl,
          attempt,
          maxRetries
        });
      } catch {}

      const isRatelimit = code === 4 || code === 17 || code === 613; // common RL codes
      if (isRatelimit) {
        nextAllowedAt = Math.max(nextAllowedAt, Date.now() + rateLimitCooldownMs());
        console.warn(`⏸️ Rate limit Meta (code ${code}). Se corta el lote hasta ${new Date(nextAllowedAt).toISOString()}.`);
        err.code = 'META_RATE_LIMITED';
        err.retryable = false;
        err.pauseUntil = new Date(nextAllowedAt);
        err.metaRateLimited = true;
        await updateMetaUsageCounter(100, {
          source,
          operation: operation || String(url || 'graph_request').split('?')[0].slice(0, 120),
          status: 'rate_limited',
          pauseUntil: nextAllowedAt ? new Date(nextAllowedAt) : undefined,
          error: err
        });
        throw err;
      }
      // El rate limit de Graph también llega como HTTP 400 y debe tratarse antes.
      if (status === 400) {
        throw err;
      }
      if (attempt <= maxRetries) {
        const backoff = 1000 * attempt;
        console.warn(`⚠️ Error Meta (intento ${attempt}/${maxRetries}) status=${status} code=${code}/${subcode}: ${err.message}. Reintentando en ${backoff}ms`);
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
module.exports.getUsageStatus = async function getUsageStatus() {
  try {
    const counter = await ApiUsageCounter.findOne({ where: { provider: 'meta_ads' } });
    const now = Date.now();
    if (!counter) {
      return { usagePct: lastUsagePct, nextAllowedAt, now };
    }
    const metadata = counter.metadata || {};
    const persistedPause = counter.pauseUntil ? new Date(counter.pauseUntil).getTime() : 0;
    nextAllowedAt = Math.max(nextAllowedAt, Number.isFinite(persistedPause) ? persistedPause : 0);
    const hourStart = metadata.hourStart ? new Date(metadata.hourStart) : null;
    if (!hourStart || now - hourStart.getTime() >= 3600000) {
      const newHour = new Date(); newHour.setMinutes(0, 0, 0);
      return { usagePct: nextAllowedAt > now ? (counter.usagePct || 0) : 0, nextAllowedAt, now, waiting: nextAllowedAt > now };
    }
    return {
      usagePct: counter.usagePct || 0,
      nextAllowedAt,
      now,
      waiting: nextAllowedAt > now
    };
  } catch (err) {
    console.error('⚠️ Error obteniendo uso Meta:', err.message);
    return { usagePct: lastUsagePct, nextAllowedAt, now: Date.now(), waiting: nextAllowedAt > Date.now() };
  }
};

module.exports._test = {
  pausedError,
  persistedPauseUntil,
  resetState() {
    nextAllowedAt = 0;
    lastUsagePct = 0;
  },
};
