'use strict';

const RETRYABLE_NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
]);
const AMBIGUOUS_DELIVERY_NETWORK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNRESET',
  'ETIMEDOUT',
]);

// Errores transitorios y de rate limit documentados por Graph/WhatsApp.
// Los errores funcionales de plantilla, credenciales o destinatario quedan
// deliberadamente fuera para no repetir envíos que nunca podrán prosperar.
const RETRYABLE_META_ERROR_CODES = new Set([
  1,
  2,
  4,
  17,
  32,
  613,
  130429,
  131000,
  131016,
  131048,
  131056,
]);

function toPositiveInteger(value, fallback = 1) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function extractMetaError(error) {
  const responseData = error?.response?.data;
  const nested = responseData?.error?.error || responseData?.error || {};
  return {
    http_status: Number(error?.response?.status || error?.status || error?.statusCode || 0) || null,
    network_code: String(error?.code || '').trim().toUpperCase() || null,
    meta_code: Number(nested?.code || 0) || null,
    meta_is_transient: nested?.is_transient === true,
  };
}

function classifyRetryableWhatsappFailure(error) {
  const details = extractMetaError(error);
  if (
    (details.network_code && AMBIGUOUS_DELIVERY_NETWORK_ERROR_CODES.has(details.network_code))
    || (
      !error?.response
      && error?.request
      && !(details.network_code && RETRYABLE_NETWORK_ERROR_CODES.has(details.network_code))
    )
  ) {
    // El POST puede haber llegado a Meta aunque se pierda la respuesta. Sin
    // una clave de idempotencia del proveedor, repetirlo puede duplicar el
    // recordatorio; se marca como entrega desconocida y no se reintenta.
    return { retryable: false, reason: 'delivery_unknown', delivery_unknown: true, ...details };
  }
  if (details.network_code && RETRYABLE_NETWORK_ERROR_CODES.has(details.network_code)) {
    return { retryable: true, reason: `network_${details.network_code.toLowerCase()}`, ...details };
  }
  if (details.http_status === 429 || details.http_status >= 500) {
    return { retryable: true, reason: `http_${details.http_status}`, ...details };
  }
  if (details.meta_is_transient) {
    return { retryable: true, reason: 'meta_transient', ...details };
  }
  if (details.meta_code && RETRYABLE_META_ERROR_CODES.has(details.meta_code)) {
    return { retryable: true, reason: `meta_${details.meta_code}`, ...details };
  }
  return { retryable: false, reason: 'non_retryable', ...details };
}

function buildWhatsappOutboundRetryDecision({
  error,
  retryOnFailure = false,
  attemptsMade = 0,
  maxAttempts = 1,
} = {}) {
  const normalizedMaxAttempts = toPositiveInteger(maxAttempts, 1);
  const normalizedAttemptsMade = Math.max(0, Number.parseInt(String(attemptsMade ?? 0), 10) || 0);
  const currentAttempt = Math.min(normalizedMaxAttempts, normalizedAttemptsMade + 1);
  const classification = classifyRetryableWhatsappFailure(error);
  const attemptsRemaining = Math.max(0, normalizedMaxAttempts - currentAttempt);
  const shouldRetry = retryOnFailure === true
    && classification.retryable
    && attemptsRemaining > 0;

  return {
    ...classification,
    retry_enabled: retryOnFailure === true,
    should_retry: shouldRetry,
    current_attempt: currentAttempt,
    max_attempts: normalizedMaxAttempts,
    attempts_remaining: attemptsRemaining,
  };
}

module.exports = {
  AMBIGUOUS_DELIVERY_NETWORK_ERROR_CODES,
  RETRYABLE_META_ERROR_CODES,
  RETRYABLE_NETWORK_ERROR_CODES,
  buildWhatsappOutboundRetryDecision,
  classifyRetryableWhatsappFailure,
  extractMetaError,
};
