'use strict';
const fs = require('node:fs'); const path = require('node:path'); const { createHash, createHmac, timingSafeEqual } = require('node:crypto');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[0-9a-f]{12}$/;
const id = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
const uuid = value => typeof value === 'string' && UUID.test(value);
const token = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const code = value => typeof value === 'string' && /^[\x21-\x7e]{1,4096}$/.test(value);
const digest = value => createHash('sha256').update(value).digest('hex');
function fail(code = 'whatsapp_authorization_invalid', status = 400) { throw Object.assign(Error(code), { code, status, httpStatus: status }); }
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail();
}
function actor(input) {
  if (!id(input.userId) || !uuid(input.sessionRef) || !Number.isSafeInteger(input.sessionExpiresAt)
    || input.sessionExpiresAt <= 0 || input.sessionExpiresAt > 8640000000000) fail();
}
function request(input, operation) {
  if (!['issue', 'claim', 'assertClaimActive', 'status', 'cancel'].includes(operation)) fail();
  const keys = ['requestId', 'userId', 'sessionRef', 'sessionExpiresAt'];
  if (operation === 'issue') keys.push('scope', ...(Object.hasOwn(input || {}, 'channelRole') ? ['channelRole'] : []));
  if (operation === 'claim') keys.push('state', 'code');
  exact(input, keys); actor(input); if (!uuid(input.requestId)) fail();
  if (operation === 'issue') { exact(input.scope, ['type', 'id']); if (!['clinic', 'group'].includes(input.scope.type) || !id(input.scope.id)
    || Object.hasOwn(input, 'channelRole') && !['primary','secondary'].includes(input.channelRole)) fail(); }
  if (operation === 'claim' && (!token(input.state) || !code(input.code))) fail();
  return structuredClone(input);
}
function channelRole(value) {
  if (value === null || value === undefined) return 'primary';
  if (!['primary','secondary'].includes(value)) fail('whatsapp_authorization_unavailable', 503);
  return value;
}
function contextDigest(row) {
  const role = channelRole(row.channel_role);
  const parts = ['whatsapp-onboarding-v1', row.request_id, row.user_id, row.session_ref,
    row.session_expires_at.toISOString(), row.scope_type, row.scope_id, row.original_clinic_ids,
    row.scope_digest, row.created_at.toISOString(), row.expires_at.toISOString()];
  // NULL belongs to already-issued v1 states; never rewrite their context/MAC.
  if (row.channel_role != null) { parts[0] = 'whatsapp-onboarding-v2'; parts.push(role); }
  return digest(JSON.stringify(parts));
}
function settings(env = process.env) {
  if (env.WHATSAPP_ONBOARDING_ENABLED !== 'true') fail('whatsapp_onboarding_disabled', 503);
  if (env.RUNTIME_ROLE !== 'gateway' || env.JOB_RUNTIME_NAMESPACE !== 'gateway' || env.QUEUE_PREFIX !== 'gateway'
    || env.JOBS_WORKER_ENABLED !== 'false' || env.CRON_ENABLED !== 'false'
    || env.AUTH_SESSION_MODE !== 'enforce' || require('./authEmailChallenge.contract').mode(env) !== 'enforce'
    || env.PLATFORM_AUDIT_WHATSAPP_ONBOARDING_ENABLED !== 'true'
    || env.PLATFORM_AUDIT_WHATSAPP_ONBOARDING_POLICY !== 'whatsapp-onboarding-v1') fail('whatsapp_onboarding_configuration_invalid', 503);
  try {
    const file = env.WHATSAPP_ONBOARDING_STATE_KEY_FILE;
    if (typeof file !== 'string' || !path.isAbsolute(file) || fs.realpathSync(file) !== file) fail();
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size !== 32 || stat.mode & 0o077) fail();
    const key = fs.readFileSync(file); if (key.length !== 32) { key.fill(0); fail(); }
    return { key };
  } catch { fail('whatsapp_onboarding_configuration_invalid', 503); }
}
function stateFor(key, row) {
  return createHmac('sha256', key).update('clinicaclick-whatsapp-authorization-v1\0').update(row.request_id).update('\0').update(row.context_digest).digest('base64url');
}
function equalHash(a, b) { return typeof a === 'string' && typeof b === 'string' && /^[a-f0-9]{64}$/.test(a) && /^[a-f0-9]{64}$/.test(b)
  && timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
module.exports = { id, uuid, token, code, digest, fail, exact, request, settings, stateFor, equalHash, channelRole, contextDigest };
