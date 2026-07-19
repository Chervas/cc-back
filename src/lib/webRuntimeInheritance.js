'use strict';

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseRuntimeInheritance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join(',') !== 'schema_version,scope_id,scope_type') return null;
  if (value.schema_version !== 1 || !['clinic', 'group'].includes(value.scope_type)) return null;
  const id = positiveInteger(value.scope_id);
  return id ? { type: value.scope_type, id } : null;
}

const RUNTIME_FEATURE_KEYS = Object.freeze([
  'consent_mode_enabled',
  'consent_provider',
  'chat_enabled',
  'whatsapp_enabled',
  'tel_modal_enabled',
]);

function recordDeclaresRuntime(record) {
  const value = record?.get ? record.get({ plain: true }) : (record || {});
  const config = value.config && typeof value.config === 'object' && !Array.isArray(value.config)
    ? value.config
    : {};
  const features = config.features && typeof config.features === 'object' && !Array.isArray(config.features)
    ? config.features
    : {};
  return RUNTIME_FEATURE_KEYS.some((key) => Object.prototype.hasOwnProperty.call(features, key))
    || Object.prototype.hasOwnProperty.call(config, 'locations')
    || Object.prototype.hasOwnProperty.call(config, 'snippet_verification')
    || Boolean(String(value.hmac_key || '').trim())
    || Boolean(parseRuntimeInheritance(config.runtime_inheritance));
}

module.exports = {
  RUNTIME_FEATURE_KEYS,
  parseRuntimeInheritance,
  recordDeclaresRuntime,
};
