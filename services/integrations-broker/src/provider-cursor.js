'use strict';
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { fail } = require('./errors');
// Opaque, authenticated pagination only; this key never encrypts provider credentials.
function cursorCodec(key, now = () => Date.now()) {
  if (!Buffer.isBuffer(key) || key.length !== 32) fail('invalid_request');
  const aad = scope => Buffer.from(JSON.stringify(['provider-cursor-v1', scope.principalId, scope.tenantRef,
    scope.binding.connectionRef, scope.assetRef, scope.operation, scope.policyVersion]));
  return {
    seal(token, scope) {
      if (typeof token !== 'string' || !token || token.length > 2048) fail('provider_failed');
      const iv = randomBytes(12); const cipher = createCipheriv('aes-256-gcm', key, iv); cipher.setAAD(aad(scope));
      const bytes = Buffer.from(JSON.stringify({ token, expiresAt: now() + 600000 }));
      const encrypted = Buffer.concat([cipher.update(bytes), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64url');
    },
    open(value, scope) {
      try {
        if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{40,4096}$/.test(value)) fail('invalid_request');
        const bytes = Buffer.from(value, 'base64url'); if (bytes.toString('base64url') !== value) fail('invalid_request');
        const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12));
        decipher.setAuthTag(bytes.subarray(12, 28)); decipher.setAAD(aad(scope));
        const v = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]));
        if (Object.keys(v).sort().join(',') !== 'expiresAt,token' || typeof v.token !== 'string' || !v.token || v.token.length > 2048
          || !Number.isSafeInteger(v.expiresAt) || v.expiresAt <= now() || v.expiresAt > now() + 600000) fail('invalid_request');
        return v.token;
      } catch { fail('invalid_request'); }
    },
  };
}
module.exports = { cursorCodec };
