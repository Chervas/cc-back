'use strict';

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
  assertWebScopeEnabled(scope);
  const normalized = normalizedScopeKey(scope);
  const enabled = publishingScopeKeys();
  const rolloutReason = enabled && !enabled.has(normalized.key)
    ? 'scope_not_enabled'
    : null;
  if (webPublishingEnabled() && !rolloutReason) return true;
  const error = new Error('La publicación web todavía no está habilitada.');
  error.name = 'MarketingWebFeatureDisabledError';
  error.code = 'web_publishing_disabled';
  error.status = 503;
  error.details = {
    scope_type: normalized.type,
    scope_id: normalized.id,
    rollout_reason: rolloutReason || 'publishing_disabled',
  };
  throw error;
}

module.exports = {
  assertWebPublishingEnabled,
  assertWebScopeEnabled,
  disabledScopeKeys,
  enabledScopeKeys,
  envBoolean,
  normalizedScopeKey,
  publishingScopeKeys,
  scopeKeysFromEnv,
  webEditorEnabled,
  webPublishingEnabled,
};
