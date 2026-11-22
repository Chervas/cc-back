'use strict';
const { createHash } = require('node:crypto');
const C = require('./googleOAuthAdmissionAttempt.contract');
const { SCOPES } = require('./googleOAuthAdmissionOwner.adapter');
const RETURN_PATH = '/pages/settings';
const FIELDS = Object.freeze(['state_hash', 'attempt_id', 'binding_digest', 'session_ref_hash', 'actor_user_id',
  'scope_key', 'service', 'clinic_digest', 'return_path', 'session_expires_at', 'created_at', 'expires_at']);
const HASH = /^[a-f0-9]{64}$/;
const fail = (status = 503) => { throw C.problem(status === 409 ? 'google_oauth_admission_attempt_conflict'
  : status === 400 ? 'google_oauth_admission_attempt_invalid' : 'google_oauth_admission_attempt_unavailable', status); };
const hash = value => createHash('sha256').update(value).digest('hex');
function stateHash(state) {
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state)) fail(400);
  return hash(state);
}
function beginStateHash(result, row, { clientId, redirectUri }) {
  const attempt = C.record(row), expected = { ...C.dto(attempt), authorizationState: 'prepared' };
  if (!C.exact(result, [...Object.keys(expected), 'authorizationUrl'])
    || Object.keys(expected).some(key => result[key] !== expected[key]) || attempt.state !== 'prepared'
    || typeof result.authorizationUrl !== 'string' || result.authorizationUrl.length > 8192) fail(409);
  let url; try { url = new URL(result.authorizationUrl); } catch { fail(); }
  const keys = ['access_type', 'client_id', 'code_challenge', 'code_challenge_method', 'prompt', 'redirect_uri', 'response_type', 'scope', 'state'];
  if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.username || url.password || url.port || url.hash
    || JSON.stringify([...url.searchParams.keys()].sort()) !== JSON.stringify(keys)
    || url.searchParams.get('client_id') !== clientId || url.searchParams.get('redirect_uri') !== redirectUri
    || url.searchParams.get('response_type') !== 'code' || url.searchParams.get('code_challenge_method') !== 'S256'
    || !/^[A-Za-z0-9_-]{43}$/.test(url.searchParams.get('code_challenge'))
    || url.searchParams.get('access_type') !== 'offline' || url.searchParams.get('prompt') !== 'consent'
    || JSON.stringify(url.searchParams.get('scope')?.split(' ').sort())
      !== JSON.stringify(['openid', 'email', 'profile', SCOPES[attempt.service]].sort())) fail();
  return stateHash(url.searchParams.get('state'));
}
function fromAttempt(row, hashedState, now) {
  const attempt = C.record(row), at = C.clock(now);
  if (!HASH.test(hashedState) || attempt.state !== 'prepared' || +attempt.expires_at <= at) fail(409);
  return record({ state_hash: hashedState, attempt_id: attempt.attempt_id, binding_digest: attempt.binding_digest,
    session_ref_hash: attempt.session_ref_hash, actor_user_id: attempt.actor_user_id, scope_key: attempt.scope_key,
    service: attempt.service, clinic_digest: attempt.clinic_digest, return_path: RETURN_PATH,
    session_expires_at: attempt.session_expires_at, created_at: new Date(at), expires_at: attempt.expires_at });
}
function record(value) {
  if (!C.exact(value, FIELDS)) fail();
  const row = { ...value };
  if (['state_hash', 'binding_digest', 'session_ref_hash', 'clinic_digest'].some(key => typeof row[key] !== 'string' || !HASH.test(row[key]))
    || typeof row.attempt_id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(row.attempt_id)
    || !Number.isSafeInteger(row.actor_user_id) || row.actor_user_id <= 0 || row.actor_user_id > 2147483647
    || !C.SERVICES.includes(row.service) || typeof row.scope_key !== 'string'
    || !/^(clinic|group):[1-9]\d{0,9}$/.test(row.scope_key) || Number(row.scope_key.split(':')[1]) > 2147483647
    || row.return_path !== RETURN_PATH || ['created_at', 'expires_at', 'session_expires_at'].some(key => !(row[key] instanceof Date)
      || !Number.isSafeInteger(row[key].getTime()))
    || +row.created_at < 0 || +row.created_at >= +row.expires_at || +row.expires_at > +row.session_expires_at
    || +row.expires_at > +row.created_at + C.TTL_MS) fail();
  for (const key of ['created_at', 'expires_at', 'session_expires_at']) row[key] = new Date(row[key]);
  return row;
}
function assertAttempt(returnRecord, row) {
  const stored = record(returnRecord), attempt = C.record(row);
  const expected = fromAttempt({ ...attempt, state: 'prepared', revision: 0, completed_at: null, updated_at: attempt.requested_at },
    stored.state_hash, stored.created_at);
  if (FIELDS.some(key => stored[key] instanceof Date ? +stored[key] !== +expected[key] : stored[key] !== expected[key])) fail(409);
  return { stored, attempt };
}
module.exports = { RETURN_PATH, FIELDS, stateHash, beginStateHash, fromAttempt, record, assertAttempt };
