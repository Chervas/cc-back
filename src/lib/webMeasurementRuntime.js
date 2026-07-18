'use strict';

const crypto = require('node:crypto');
const { canonicalSerialize } = require('./webDocument');

const SAFE_PROVIDERS = new Set(['clinicaclick', 'external_cmp']);

class WebMeasurementRuntimeError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.name = 'WebMeasurementRuntimeError';
    this.code = code;
    this.status = status;
  }
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeApiBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (
      url.protocol !== 'https:'
      || url.username
      || url.password
      || url.port
      || url.search
      || url.hash
      || url.pathname.replace(/\/+$/, '')
    ) throw new Error('unsafe');
    return `https://${url.hostname.toLowerCase()}`;
  } catch {
    throw new WebMeasurementRuntimeError(
      'web_measurement_api_base_invalid',
      'La URL pública de medición de ClinicaClick no es válida.',
      503
    );
  }
}

function disabledMeasurement() {
  return Object.freeze({ enabled: false });
}

/**
 * Normaliza únicamente configuración interna y confiable. Este valor nunca debe
 * construirse a partir del body de una petición del editor.
 */
function normalizeTrustedMeasurement(value, { environment = 'preview' } = {}) {
  if (environment !== 'production' || !value || value.enabled !== true) {
    return disabledMeasurement();
  }
  const scopeType = value.scope_type === 'group' ? 'group' : 'clinic';
  const scopeId = Number(value.scope_id);
  const hmacKey = String(value.hmac_key || '').trim();
  const provider = String(value.consent_provider || '').trim().toLowerCase();
  if (
    !Number.isSafeInteger(scopeId)
    || scopeId <= 0
    || hmacKey.length < 16
    || hmacKey.length > 512
    || /[\x00-\x20\x7f]/.test(hmacKey)
    || !SAFE_PROVIDERS.has(provider)
  ) {
    throw new WebMeasurementRuntimeError(
      'web_measurement_runtime_invalid',
      'La configuración interna de medición no es publicable.',
      503
    );
  }
  const apiUrl = safeApiBaseUrl(value.api_url);
  const loaderPath = String(value.loader_path || '/assets/loader.js').trim();
  if (loaderPath !== '/assets/loader.js') {
    throw new WebMeasurementRuntimeError(
      'web_measurement_loader_invalid',
      'El cargador de medición configurado no es compatible.',
      503
    );
  }
  return Object.freeze({
    enabled: true,
    scope_type: scopeType,
    scope_id: scopeId,
    api_url: apiUrl,
    loader_url: `${apiUrl}${loaderPath}`,
    hmac_key: hmacKey,
    consent_mode_enabled: value.consent_mode_enabled === true,
    consent_provider: provider,
    chat_enabled: value.chat_enabled === true,
    whatsapp_enabled: value.whatsapp_enabled === true,
    phone_enabled: value.phone_enabled === true,
  });
}

function trustedRuntime(value = {}, options = {}) {
  const measurement = normalizeTrustedMeasurement(value.measurement, options);
  const normalized = { schema_version: 1, measurement };
  return Object.freeze({
    ...normalized,
    runtime_config_hash: sha256(canonicalSerialize(normalized)),
  });
}

module.exports = {
  WebMeasurementRuntimeError,
  disabledMeasurement,
  normalizeTrustedMeasurement,
  safeApiBaseUrl,
  trustedRuntime,
};
