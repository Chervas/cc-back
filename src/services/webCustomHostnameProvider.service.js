'use strict';

const { normalizeHost } = require('./webHostedPublisher.service');
const { WebPublicationServiceError } = require('./webPublications.service');

const API_ORIGIN = 'https://api.cloudflare.com';
const SAFE_PROVIDER_STATUS = /^[a-z][a-z0-9_-]{0,63}$/;

function configuredProvider(env = process.env) {
  const name = String(env.MARKETING_WEB_CUSTOM_HOSTNAME_PROVIDER || '').trim().toLowerCase();
  if (!name || name === 'manual') return null;
  if (name !== 'cloudflare') {
    throw new WebPublicationServiceError(
      'web_custom_hostname_provider_invalid',
      'El proveedor de dominios propios no está configurado correctamente.',
      503
    );
  }
  const token = String(env.CLOUDFLARE_API_TOKEN || '').trim();
  const zoneId = String(env.MARKETING_WEB_CLOUDFLARE_ZONE_ID || '').trim();
  if (token.length < 20 || token.length > 512 || /[\x00-\x20\x7f]/.test(token) || !/^[a-f0-9]{32}$/i.test(zoneId)) {
    throw new WebPublicationServiceError(
      'web_custom_hostname_provider_not_configured',
      'La emisión automática de TLS para dominios propios requiere configuración del proveedor.',
      503
    );
  }
  let customOrigin = null;
  if (String(env.MARKETING_WEB_CLOUDFLARE_CUSTOM_ORIGIN || '').trim()) {
    customOrigin = normalizeHost(env.MARKETING_WEB_CLOUDFLARE_CUSTOM_ORIGIN);
  }
  return { name, token, zoneId: zoneId.toLowerCase(), customOrigin };
}

async function providerFetch(pathname, {
  method = 'GET',
  body = null,
  config,
  fetchImpl = global.fetch,
  timeoutMs = 15_000,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new WebPublicationServiceError('web_custom_hostname_provider_unavailable', 'El proveedor TLS no está disponible.', 503);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${API_ORIGIN}${pathname}`, {
      method,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${config.token}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const raw = (await response.text()).slice(0, 256 * 1024);
    let decoded = null;
    try { decoded = JSON.parse(raw); } catch { decoded = null; }
    if (!response.ok || decoded?.success !== true) {
      const providerCode = Number(decoded?.errors?.[0]?.code || response.status || 0);
      throw new WebPublicationServiceError(
        'web_custom_hostname_provider_failed',
        'El proveedor todavía no ha podido preparar el certificado del dominio.',
        503,
        { provider: 'cloudflare', provider_code: Number.isFinite(providerCode) ? providerCode : null }
      );
    }
    return decoded.result;
  } catch (error) {
    if (error instanceof WebPublicationServiceError) throw error;
    throw new WebPublicationServiceError(
      'web_custom_hostname_provider_unavailable',
      'El proveedor TLS no está disponible temporalmente.',
      503
    );
  } finally {
    clearTimeout(timeout);
  }
}

function safeProviderString(value, maximum = 255) {
  const text = String(value || '').trim();
  return text && text.length <= maximum && !/[\x00-\x1f\x7f]/.test(text) ? text : null;
}

function normalizeProviderState(result, expectedHost) {
  if (!result || normalizeHost(result.hostname) !== expectedHost || !/^[a-f0-9]{32}$/i.test(String(result.id || ''))) {
    throw new WebPublicationServiceError('web_custom_hostname_provider_response_invalid', 'El proveedor TLS devolvió un estado no válido.', 503);
  }
  const hostnameStatus = SAFE_PROVIDER_STATUS.test(String(result.status || '')) ? String(result.status) : 'unknown';
  const sslStatus = SAFE_PROVIDER_STATUS.test(String(result.ssl?.status || '')) ? String(result.ssl.status) : 'unknown';
  const ownership = result.ownership_verification && typeof result.ownership_verification === 'object'
    ? {
        type: String(result.ownership_verification.type || '').toLowerCase() === 'txt' ? 'TXT' : null,
        name: safeProviderString(result.ownership_verification.name),
        value: safeProviderString(result.ownership_verification.value, 1024),
      }
    : null;
  return {
    provider: 'cloudflare',
    id: String(result.id).toLowerCase(),
    hostname_status: hostnameStatus,
    ssl_status: sslStatus,
    ready: hostnameStatus === 'active' && sslStatus === 'active',
    ownership_verification: ownership?.type && ownership.name && ownership.value ? ownership : null,
    checked_at: new Date().toISOString(),
  };
}

async function findExisting(host, { config, fetchImpl }) {
  const result = await providerFetch(
    `/client/v4/zones/${config.zoneId}/custom_hostnames?hostname=${encodeURIComponent(host)}&per_page=50`,
    { config, fetchImpl }
  );
  if (!Array.isArray(result)) return null;
  return result.find((entry) => {
    try { return normalizeHost(entry?.hostname) === host; } catch { return false; }
  }) || null;
}

async function ensureCustomHostname(domain, {
  env = process.env,
  fetchImpl = global.fetch,
} = {}) {
  const config = configuredProvider(env);
  if (!config) return null;
  const host = normalizeHost(domain.host);
  const storedId = String(domain.tls?.provider?.id || '').trim().toLowerCase();
  let result = null;
  if (/^[a-f0-9]{32}$/.test(storedId)) {
    result = await providerFetch(`/client/v4/zones/${config.zoneId}/custom_hostnames/${storedId}`, { config, fetchImpl });
  } else {
    result = await findExisting(host, { config, fetchImpl });
    if (!result) {
      const request = {
        hostname: host,
        custom_metadata: { clinicaclick_domain_id: String(domain.id) },
        ssl: {
          method: 'http',
          type: 'dv',
          bundle_method: 'ubiquitous',
          certificate_authority: 'lets_encrypt',
          settings: { min_tls_version: '1.2', http2: 'on', tls_1_3: 'on' },
        },
        ...(config.customOrigin ? {
          custom_origin_server: config.customOrigin,
          custom_origin_sni: config.customOrigin,
        } : {}),
      };
      result = await providerFetch(`/client/v4/zones/${config.zoneId}/custom_hostnames`, {
        method: 'POST', config, fetchImpl, body: request,
      });
    }
  }
  return normalizeProviderState(result, host);
}

module.exports = {
  API_ORIGIN,
  configuredProvider,
  ensureCustomHostname,
  normalizeProviderState,
  providerFetch,
};
