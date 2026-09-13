'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
require('./fixtures/security_offline_runtime.cjs');
const C = require('../../services/authEmailChallenge.contract');
const env = { AUTH_EMAIL_MFA_MODE: 'enforce', AUTH_SESSION_MODE: 'enforce', PLATFORM_AUDIT_AUTH_ENABLED: 'true', PLATFORM_AUDIT_AUTH_POLICY: 'auth-durable-v1' };
test('email enforcement requires managed audited sessions and a dedicated private raw 32-byte key', () => {
  assert.deepEqual(C.settings({}), { mode: 'off' });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-email-key-qa-')); const key = path.join(root, 'key');
  try {
    fs.writeFileSync(key, Buffer.alloc(32, 8), { mode: 0o600 });
    assert.equal(C.settings({ ...env, AUTH_EMAIL_MFA_KEY_FILE: key }).key.length, 32);
    for (const patch of [{ AUTH_SESSION_MODE: 'observe' }, { PLATFORM_AUDIT_AUTH_ENABLED: 'false' },
      { AUTH_EMAIL_MFA_MODE: 'optional' }, { AUTH_EMAIL_MFA_KEY_FILE: 'relative' }]) {
      assert.throws(() => C.settings({ ...env, AUTH_EMAIL_MFA_KEY_FILE: key, ...patch }), { code: 'auth_email_configuration_invalid' });
    }
    fs.symlinkSync(key, path.join(root, 'link'));
    assert.throws(() => C.settings({ ...env, AUTH_EMAIL_MFA_KEY_FILE: path.join(root, 'link') }));
    fs.chmodSync(key, 0o644); assert.throws(() => C.settings({ ...env, AUTH_EMAIL_MFA_KEY_FILE: key }));
    fs.chmodSync(key, 0o600); fs.writeFileSync(key, Buffer.alloc(31));
    assert.throws(() => C.settings({ ...env, AUTH_EMAIL_MFA_KEY_FILE: key }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('short codes are challenge-bound and constant-time hash comparison rejects malformed input', () => {
  const key = Buffer.alloc(32, 9); const a = C.codeHash(key, 'one', '123456');
  assert.equal(C.equalHash(a, C.codeHash(key, 'two', '123456')), false);
  assert.equal(C.equalHash(a, a), true); assert.equal(C.equalHash(a, 'bad'), false);
  for (const value of [123456, '12345', '1234567', '１２３４５６', ' 123456']) assert.equal(C.code(value), false);
});
