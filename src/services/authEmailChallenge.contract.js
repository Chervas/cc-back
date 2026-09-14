'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const LIMITS = Object.freeze({ codeSeconds: 300, absoluteSeconds: 600, minResendSeconds: 60,
  maxAttempts: 5, maxSends: 3, sendsPerUserHour: 5 });
function fail(code = 'auth_email_invalid', status = 401) { throw Object.assign(Error(code), { code, status }); }
function mode(env = process.env) {
  const value = env.AUTH_EMAIL_MFA_MODE || 'off';
  if (!['off', 'enforce'].includes(value)) fail('auth_email_configuration_invalid', 503);
  if (value === 'enforce' && (env.AUTH_SESSION_MODE !== 'enforce'
    || env.PLATFORM_AUDIT_AUTH_ENABLED !== 'true' || env.PLATFORM_AUDIT_AUTH_POLICY !== 'auth-durable-v1')) {
    fail('auth_email_configuration_invalid', 503);
  }
  return value;
}
function settings(env = process.env) {
  const value = mode(env);
  if (value === 'off') return { mode: value };
  try {
    const file = env.AUTH_EMAIL_MFA_KEY_FILE;
    if (typeof file !== 'string' || !path.isAbsolute(file) || fs.realpathSync(file) !== file) fail();
    const stat = fs.statSync(file);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size !== 32) fail();
    const key = fs.readFileSync(file);
    if (key.length !== 32) fail();
    return { mode: value, key };
  } catch { fail('auth_email_configuration_invalid', 503); }
}
const challengeToken = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const code = value => typeof value === 'string' && /^[0-9]{6}$/.test(value);
function challengeHash(value) { if (!challengeToken(value)) fail(); return createHash('sha256').update(value).digest('hex'); }
function codeHash(key, id, value) { return createHmac('sha256', key).update('clinicaclick-email-code-v1\0').update(id).update('\0').update(value).digest('hex'); }
function equalHash(a, b) { return typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a)
  && /^[a-f0-9]{64}$/.test(b) && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
const emailHash = value => createHash('sha256').update(String(value).trim().toLowerCase()).digest('hex');
function maskedEmail(value) {
  const [local, domain] = String(value).split('@');
  if (!local || !domain) fail('auth_email_unavailable', 503);
  return local[0] + '***@' + domain;
}
module.exports = { LIMITS, fail, mode, settings, challengeToken, challengeHash, code, codeHash, equalHash, emailHash, maskedEmail };
