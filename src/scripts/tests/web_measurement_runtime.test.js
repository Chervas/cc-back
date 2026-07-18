'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  normalizeTrustedMeasurement,
  safeApiBaseUrl,
  trustedRuntime,
} = require('../../lib/webMeasurementRuntime');

const enabled = {
  enabled: true,
  scope_type: 'group',
  scope_id: 7,
  api_url: 'https://CRM.Clinicaclick.com/',
  loader_path: '/assets/loader.js',
  hmac_key: '0123456789abcdef0123456789abcdef',
  consent_mode_enabled: true,
  consent_provider: 'clinicaclick',
};

test('normaliza un único origen HTTPS sin ruta, puerto ni credenciales', () => {
  assert.equal(safeApiBaseUrl('https://CRM.Clinicaclick.com/'), 'https://crm.clinicaclick.com');
  for (const value of [
    'http://crm.clinicaclick.com',
    'https://user:secret@crm.clinicaclick.com',
    'https://crm.clinicaclick.com:8443',
    'https://crm.clinicaclick.com/api',
  ]) {
    assert.throws(() => safeApiBaseUrl(value), (error) => error.code === 'web_measurement_api_base_invalid');
  }
});

test('preview desactiva siempre el runtime aunque reciba valores', () => {
  assert.deepEqual(normalizeTrustedMeasurement(enabled, { environment: 'preview' }), { enabled: false });
});

test('producción congela scope, consentimiento y loader permitido', () => {
  const runtime = trustedRuntime({ measurement: enabled }, { environment: 'production' });
  assert.equal(runtime.measurement.scope_type, 'group');
  assert.equal(runtime.measurement.loader_url, 'https://crm.clinicaclick.com/assets/loader.js');
  assert.match(runtime.runtime_config_hash, /^[a-f0-9]{64}$/);
  assert.throws(
    () => normalizeTrustedMeasurement({ ...enabled, loader_path: '/evil.js' }, { environment: 'production' }),
    (error) => error.code === 'web_measurement_loader_invalid'
  );
  assert.throws(
    () => normalizeTrustedMeasurement({ ...enabled, hmac_key: 'short' }, { environment: 'production' }),
    (error) => error.code === 'web_measurement_runtime_invalid'
  );
});

test('el hash cambia con el HMAC o consentimiento sin revelar secretos', () => {
  const first = trustedRuntime({ measurement: enabled }, { environment: 'production' });
  const second = trustedRuntime({ measurement: { ...enabled, hmac_key: `${enabled.hmac_key}x` } }, { environment: 'production' });
  const third = trustedRuntime({ measurement: { ...enabled, consent_mode_enabled: false } }, { environment: 'production' });
  assert.notEqual(first.runtime_config_hash, second.runtime_config_hash);
  assert.notEqual(first.runtime_config_hash, third.runtime_config_hash);
  assert.equal(first.runtime_config_hash.includes(enabled.hmac_key), false);
});
