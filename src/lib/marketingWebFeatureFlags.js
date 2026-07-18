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

function disabledScopeKeys() {
  const entries = String(process.env.MARKETING_WEB_DISABLED_SCOPES || '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  const invalid = entries.filter((value) => !/^(clinic|group):[1-9][0-9]*$/.test(value));
  if (invalid.length > 0) {
    const error = new Error(`MARKETING_WEB_DISABLED_SCOPES contiene entradas inválidas: ${invalid.join(', ')}`);
    error.name = 'MarketingWebConfigurationError';
    error.code = 'marketing_web_invalid_disabled_scopes';
    error.status = 500;
    error.details = { invalid_entries: invalid };
    throw error;
  }
  return new Set(entries);
}

function webEditorEnabled() {
  return envBoolean('MARKETING_WEB_EDITOR_ENABLED', false);
}

function webPublishingEnabled() {
  return envBoolean('MARKETING_WEB_PUBLISHING_ENABLED', false);
}

function assertWebScopeEnabled(scope) {
  const key = `${scope?.type || ''}:${Number(scope?.id) || ''}`;
  if (webEditorEnabled() && !disabledScopeKeys().has(key)) return true;
  const error = new Error('El editor web está desactivado temporalmente para este alcance.');
  error.name = 'MarketingWebFeatureDisabledError';
  error.code = 'web_editor_disabled';
  error.status = 503;
  error.details = { scope_type: scope?.type || null, scope_id: Number(scope?.id) || null };
  throw error;
}

function assertWebPublishingEnabled(scope) {
  assertWebScopeEnabled(scope);
  if (webPublishingEnabled()) return true;
  const error = new Error('La publicación web todavía no está habilitada.');
  error.name = 'MarketingWebFeatureDisabledError';
  error.code = 'web_publishing_disabled';
  error.status = 503;
  error.details = { scope_type: scope?.type || null, scope_id: Number(scope?.id) || null };
  throw error;
}

module.exports = {
  assertWebPublishingEnabled,
  assertWebScopeEnabled,
  disabledScopeKeys,
  envBoolean,
  webEditorEnabled,
  webPublishingEnabled,
};
