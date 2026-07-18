'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { cleanPem } = require('./webArtifactSignature');

function envBoolean(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  const error = new Error(`${name} debe ser true/false, 1/0, on/off o yes/no.`);
  error.name = 'MarketingWebConfigurationError';
  error.code = 'marketing_web_invalid_feature_flag';
  error.status = 500;
  throw error;
}

function scopeKeysFromEnv(name, { optional = false, strictCsv = false } = {}) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return optional ? null : new Set();
  }
  const entries = String(raw)
    .split(',')
    .map((value) => value.trim().toLowerCase());
  const invalid = entries.filter((value) => (
    value === '' ? strictCsv : !/^(clinic|group):[1-9][0-9]*$/.test(value)
  ));
  if (invalid.length > 0) {
    const printableInvalid = invalid.map((value) => value || '(vacío)');
    const error = new Error(`${name} contiene entradas inválidas: ${printableInvalid.join(', ')}`);
    error.name = 'MarketingWebConfigurationError';
    error.code = name === 'MARKETING_WEB_ENABLED_SCOPES'
      ? 'marketing_web_invalid_enabled_scopes'
      : name === 'MARKETING_WEB_PUBLISHING_SCOPES'
        ? 'marketing_web_invalid_publishing_scopes'
        : 'marketing_web_invalid_disabled_scopes';
    error.status = 500;
    error.details = { invalid_entries: printableInvalid };
    throw error;
  }
  return new Set(entries.filter(Boolean));
}

function enabledScopeKeys() {
  return scopeKeysFromEnv('MARKETING_WEB_ENABLED_SCOPES', {
    optional: true,
    strictCsv: true,
  });
}

function disabledScopeKeys() {
  return scopeKeysFromEnv('MARKETING_WEB_DISABLED_SCOPES');
}

function publishingScopeKeys() {
  return scopeKeysFromEnv('MARKETING_WEB_PUBLISHING_SCOPES', {
    optional: true,
    strictCsv: true,
  });
}

function normalizedScopeKey(scope) {
  const type = String(scope?.type || '').trim().toLowerCase();
  const id = Number(scope?.id);
  if (!['clinic', 'group'].includes(type) || !Number.isSafeInteger(id) || id <= 0) {
    const error = new Error('El alcance de Marketing Web no es válido.');
    error.name = 'MarketingWebConfigurationError';
    error.code = 'marketing_web_invalid_scope';
    error.status = 500;
    error.details = { scope_type: type || null, scope_id: Number.isSafeInteger(id) ? id : null };
    throw error;
  }
  return { key: `${type}:${id}`, type, id };
}

function webEditorEnabled() {
  return envBoolean('MARKETING_WEB_EDITOR_ENABLED', false);
}

function webPublishingEnabled() {
  return envBoolean('MARKETING_WEB_PUBLISHING_ENABLED', false);
}

const WEB_PUBLISHING_CHANNELS = Object.freeze([
  'clinicaclick_hosted',
  'wordpress',
  'custom_domain',
]);

function nonEmptyEnv(env, name, minimumLength = 1) {
  const value = String(env?.[name] || '').trim();
  return value.length >= minimumLength && !/[\x00-\x1f\x7f]/.test(value);
}

function validHttpsOrigin(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.port
      && !url.search
      && !url.hash
      && !url.pathname.replace(/\/+$/, '');
  } catch {
    return false;
  }
}

function validHttpsBaseUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    return url.protocol === 'https:'
      && !url.username
      && !url.password
      && !url.port
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

function validPublicHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/\.$/, '');
  return host.length <= 253
    && host.includes('.')
    && !host.includes('localhost')
    && !/^\d+(?:\.\d+){3}$/.test(host)
    && host.split('.').every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function artifactStoreOperational(env) {
  const mode = String(env?.MARKETING_WEB_ARTIFACT_STORE_MODE || '').trim().toLowerCase();
  if (mode === 'authenticated_db') return true;
  return mode === 's3'
    && nonEmptyEnv(env, 'MARKETING_WEB_ARTIFACT_BUCKET')
    && validHttpsBaseUrl(env?.MARKETING_WEB_ARTIFACT_BASE_URL);
}

function signingOperational(env) {
  // Usa exactamente la misma normalización que el firmador. Los gestores de
  // secretos suelen entregar PEM en una sola línea con `\\n` literales; el
  // gate no debe cerrar un canal que el runtime sí puede firmar/verificar.
  const privateKey = cleanPem(env?.MARKETING_WEB_SIGNING_PRIVATE_KEY_PEM);
  const publicKey = cleanPem(env?.MARKETING_WEB_SIGNING_PUBLIC_KEY_PEM);
  if (
    privateKey.length < 32
    || publicKey.length < 32
    || privateKey.includes('\0')
    || publicKey.includes('\0')
  ) return false;
  try {
    const privateObject = crypto.createPrivateKey(privateKey);
    const publicObject = crypto.createPublicKey(publicKey);
    if (privateObject.asymmetricKeyType !== 'ed25519' || publicObject.asymmetricKeyType !== 'ed25519') return false;
    const derived = crypto.createPublicKey(privateObject).export({ type: 'spki', format: 'der' });
    const configured = publicObject.export({ type: 'spki', format: 'der' });
    return derived.length === configured.length && crypto.timingSafeEqual(derived, configured);
  } catch {
    return false;
  }
}

function safeHostingRoot(value) {
  const raw = String(value || '').trim();
  if (!raw.startsWith('/') || raw.includes('\0')) return false;
  const normalized = path.resolve(raw);
  return normalized !== '/' && normalized.length >= 8;
}

function optionalChannelFlag(env, name) {
  const raw = env?.[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const normalized = String(raw).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(normalized)) return true;
  if (['0', 'false', 'off', 'no'].includes(normalized)) return false;
  const error = new Error(`${name} debe ser true/false, 1/0, on/off o yes/no.`);
  error.name = 'MarketingWebConfigurationError';
  error.code = 'marketing_web_invalid_feature_flag';
  error.status = 500;
  throw error;
}

function wordpressChannelAvailability(env) {
  const override = optionalChannelFlag(env, 'MARKETING_WEB_WORDPRESS_CHANNEL_ENABLED');
  if (override === false) return { available: false, reason: 'channel_not_enabled' };
  const configured = validHttpsOrigin(env?.MARKETING_WEB_API_BASE_URL)
    && nonEmptyEnv(env, 'MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY', 32)
    && signingOperational(env)
    && artifactStoreOperational(env);
  if (!configured) return { available: false, reason: 'channel_not_configured' };
  return { available: true, reason: null };
}

function hostedChannelAvailability(env) {
  if (optionalChannelFlag(env, 'MARKETING_WEB_HOSTED_CHANNEL_ENABLED') !== true) {
    return { available: false, reason: 'channel_not_enabled' };
  }
  const mode = String(env?.MARKETING_WEB_HOSTED_MODE || '').trim().toLowerCase();
  const configured = validPublicHost(env?.MARKETING_WEB_HOSTED_DOMAIN)
    && ['path', 'subdomain'].includes(mode)
    && safeHostingRoot(env?.MARKETING_WEB_HOSTING_ROOT)
    && signingOperational(env);
  return configured
    ? { available: true, reason: null }
    : { available: false, reason: 'channel_not_configured' };
}

function customDomainChannelAvailability(env) {
  if (optionalChannelFlag(env, 'MARKETING_WEB_CUSTOM_DOMAIN_CHANNEL_ENABLED') !== true) {
    return { available: false, reason: 'channel_not_enabled' };
  }
  const provider = String(env?.MARKETING_WEB_CUSTOM_HOSTNAME_PROVIDER || '').trim().toLowerCase();
  const providerConfigured = provider === 'manual'
    || (provider === 'cloudflare'
      && nonEmptyEnv(env, 'CLOUDFLARE_API_TOKEN', 20)
      && /^[a-f0-9]{32}$/i.test(String(env?.MARKETING_WEB_CLOUDFLARE_ZONE_ID || '').trim())
      && validPublicHost(env?.MARKETING_WEB_CLOUDFLARE_CUSTOM_ORIGIN));
  const configured = ['manual', 'cloudflare'].includes(provider)
    && providerConfigured
    && validPublicHost(env?.MARKETING_WEB_CUSTOM_DOMAIN_TARGET)
    && safeHostingRoot(env?.MARKETING_WEB_HOSTING_ROOT)
    && signingOperational(env);
  return configured
    ? { available: true, reason: null }
    : { available: false, reason: 'channel_not_configured' };
}

function webPublishingChannelAvailability(scope, channel, env = process.env) {
  const normalizedChannel = String(channel || '').trim().toLowerCase();
  if (!WEB_PUBLISHING_CHANNELS.includes(normalizedChannel)) {
    const error = new Error('El canal de publicación web no es válido.');
    error.name = 'MarketingWebConfigurationError';
    error.code = 'marketing_web_invalid_publishing_channel';
    error.status = 500;
    throw error;
  }
  const rollout = webPublishingAvailability(scope);
  if (!rollout.available) return rollout;
  if (normalizedChannel === 'wordpress') return wordpressChannelAvailability(env);
  if (normalizedChannel === 'clinicaclick_hosted') return hostedChannelAvailability(env);
  return customDomainChannelAvailability(env);
}

function webPublishingCapabilities(scope, env = process.env) {
  const rollout = webPublishingAvailability(scope);
  const publishingChannels = Object.fromEntries(WEB_PUBLISHING_CHANNELS.map((channel) => {
    const availability = rollout.available
      ? webPublishingChannelAvailability(scope, channel, env)
      : rollout;
    return [channel, {
      available: availability.available === true,
      unavailable_reason: availability.reason || null,
    }];
  }));
  const publishingAvailable = rollout.available
    && Object.values(publishingChannels).some((channel) => channel.available === true);
  return {
    // Contrato consumible por clientes antiguos: publicar solo está disponible
    // si el rollout y al menos un canal operativo coinciden. El estado de
    // rollout se expone aparte para no confundir despliegue gradual con salud
    // real de infraestructura.
    publishing_available: publishingAvailable,
    publishing_unavailable_reason: publishingAvailable
      ? null
      : (rollout.reason || 'no_operational_channels'),
    publishing_rollout_available: rollout.available,
    publishing_rollout_unavailable_reason: rollout.reason,
    publishing_channels: publishingChannels,
  };
}

function webPublishingAvailability(scope) {
  assertWebScopeEnabled(scope);
  const normalized = normalizedScopeKey(scope);
  const enabled = publishingScopeKeys();
  const rolloutReason = enabled && !enabled.has(normalized.key)
    ? 'scope_not_enabled'
    : null;
  const available = webPublishingEnabled() && !rolloutReason;
  return {
    available,
    reason: available ? null : (rolloutReason || 'publishing_disabled'),
  };
}

function assertWebScopeEnabled(scope) {
  const normalized = normalizedScopeKey(scope);
  const disabled = disabledScopeKeys();
  const enabled = enabledScopeKeys();
  const rolloutReason = disabled.has(normalized.key)
    ? 'disabled_scope'
    : enabled && !enabled.has(normalized.key)
      ? 'scope_not_enabled'
      : null;
  if (webEditorEnabled() && !rolloutReason) return true;
  const error = new Error('El editor web está desactivado temporalmente para este alcance.');
  error.name = 'MarketingWebFeatureDisabledError';
  error.code = 'web_editor_disabled';
  error.status = 503;
  error.details = {
    scope_type: normalized.type,
    scope_id: normalized.id,
    rollout_reason: rolloutReason || 'editor_disabled',
  };
  throw error;
}

function assertWebPublishingEnabled(scope) {
  const normalized = normalizedScopeKey(scope);
  const availability = webPublishingAvailability(scope);
  if (availability.available) return true;
  const error = new Error('La publicación web todavía no está habilitada.');
  error.name = 'MarketingWebFeatureDisabledError';
  error.code = 'web_publishing_disabled';
  error.status = 503;
  error.details = {
    scope_type: normalized.type,
    scope_id: normalized.id,
    rollout_reason: availability.reason,
  };
  throw error;
}

function assertWebPublishingChannelEnabled(scope, channel, env = process.env) {
  const normalized = normalizedScopeKey(scope);
  const normalizedChannel = String(channel || '').trim().toLowerCase();
  const availability = webPublishingChannelAvailability(scope, normalizedChannel, env);
  if (availability.available) return true;
  if (['publishing_disabled', 'scope_not_enabled'].includes(availability.reason)) {
    return assertWebPublishingEnabled(scope);
  }
  const error = new Error('Este canal de publicación web todavía no está operativo.');
  error.name = 'MarketingWebFeatureDisabledError';
  error.code = 'web_publishing_channel_disabled';
  error.status = 503;
  error.details = {
    scope_type: normalized.type,
    scope_id: normalized.id,
    channel: normalizedChannel,
    rollout_reason: availability.reason,
  };
  throw error;
}

module.exports = {
  WEB_PUBLISHING_CHANNELS,
  assertWebPublishingChannelEnabled,
  assertWebPublishingEnabled,
  assertWebScopeEnabled,
  disabledScopeKeys,
  enabledScopeKeys,
  envBoolean,
  normalizedScopeKey,
  publishingScopeKeys,
  scopeKeysFromEnv,
  webEditorEnabled,
  webPublishingAvailability,
  webPublishingCapabilities,
  webPublishingChannelAvailability,
  webPublishingEnabled,
};
