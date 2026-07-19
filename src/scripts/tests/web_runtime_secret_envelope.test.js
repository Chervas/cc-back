'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  decryptRuntimeSecret,
  encryptRuntimeSecret,
} = require('../../lib/webRuntimeSecretEnvelope');

const SECRET = 'runtime-test-hmac-0123456789abcdef';
const CONTEXT = {
  id: '11111111-1111-4111-8111-111111111111',
  scopeType: 'clinic',
  scopeId: 66,
  generation: 3,
  slot: 'source',
};
const DEDICATED_ENV = {
  MARKETING_WEB_RUNTIME_ENVELOPE_KEY: Buffer.alloc(32, 7).toString('base64url'),
  MARKETING_WEB_RUNTIME_ENVELOPE_KEY_ID: 'runtime-envelope-test-v1',
};

test('AES-256-GCM no persiste plaintext y autentica contexto y slot', () => {
  const sealed = encryptRuntimeSecret(SECRET, CONTEXT, { env: DEDICATED_ENV });
  assert.equal(typeof sealed, 'string');
  assert.equal(sealed.includes(SECRET), false);
  assert.equal(decryptRuntimeSecret(sealed, CONTEXT, { env: DEDICATED_ENV }), SECRET);

  for (const changed of [
    { ...CONTEXT, scopeId: 67 },
    { ...CONTEXT, generation: 4 },
    { ...CONTEXT, slot: 'target' },
  ]) {
    assert.throws(
      () => decryptRuntimeSecret(sealed, changed, { env: DEDICATED_ENV }),
      (error) => error.code === 'web_runtime_envelope_decrypt_failed'
    );
  }
});

test('un envelope alterado y una clave ausente fallan cerrados', () => {
  const sealed = encryptRuntimeSecret(SECRET, CONTEXT, { env: DEDICATED_ENV });
  const tampered = JSON.parse(sealed);
  tampered.ciphertext = `${tampered.ciphertext[0] === 'A' ? 'B' : 'A'}${tampered.ciphertext.slice(1)}`;
  assert.throws(
    () => decryptRuntimeSecret(JSON.stringify(tampered), CONTEXT, { env: DEDICATED_ENV }),
    (error) => error.code === 'web_runtime_envelope_decrypt_failed'
  );
  assert.throws(
    () => encryptRuntimeSecret(SECRET, CONTEXT, { env: {} }),
    (error) => error.code === 'web_runtime_envelope_key_missing'
  );
  assert.throws(
    () => decryptRuntimeSecret(sealed, CONTEXT, { env: {} }),
    (error) => error.code === 'web_runtime_envelope_key_missing'
  );
  assert.throws(
    () => encryptRuntimeSecret(SECRET, CONTEXT, {
      env: { MARKETING_WEB_RUNTIME_ENVELOPE_KEY: 'x'.repeat(32) },
    }),
    (error) => error.code === 'web_runtime_envelope_key_invalid'
  );
  assert.throws(
    () => encryptRuntimeSecret(SECRET, CONTEXT, {
      env: { MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY: 'x'.repeat(32) },
    }),
    (error) => error.code === 'web_runtime_envelope_key_missing'
  );
});

test('la bootstrap key válida deriva una subkey exclusiva mediante HKDF', () => {
  const env = {
    MARKETING_WEB_PLUGIN_BOOTSTRAP_KEY: Buffer.alloc(32, 11).toString('base64url'),
  };
  const sealed = encryptRuntimeSecret(SECRET, CONTEXT, { env });
  assert.equal(decryptRuntimeSecret(sealed, CONTEXT, { env }), SECRET);
  assert.equal(JSON.parse(sealed).key_id, 'bootstrap-hkdf-v1');
});
