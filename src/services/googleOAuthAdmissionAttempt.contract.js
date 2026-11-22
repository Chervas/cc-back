'use strict';

const { createHash } = require('node:crypto');

// Same four closed service names and 1,000-clinic bound as the neighboring
// Google OAuth/enrollment contracts. This record is only a local intention;
// it supplies no Google identity, provider authorization or resource grant.
const SERVICES = Object.freeze(['business_profile', 'search_console', 'analytics', 'ads']);
const STATES = Object.freeze(['prepared', 'cancelled', 'expired']);
const MAX_CLINICS = 1000;
const TTL_MS = 600000;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const HASH = /^[a-f0-9]{64}$/;
const DOMAIN = 'clinicaclick-google-oauth-admission-attempt/1';
const INPUT_FIELDS = Object.freeze(['attemptId', 'actorId', 'sessionRef', 'sessionExpiresAt', 'scopeKey', 'clinicIds', 'service']);
const ROW_FIELDS = Object.freeze(['attempt_id', 'actor_user_id', 'session_ref_hash', 'session_expires_at', 'scope_key',
  'clinic_ids', 'clinic_count', 'clinic_digest', 'service', 'binding_digest', 'state', 'revision',
  'requested_at', 'expires_at', 'updated_at', 'completed_at']);
const problem = (code = 'google_oauth_admission_attempt_invalid', status = 400) => Object.assign(new Error(code), { code, status });
const fail = (code, status) => { throw problem(code, status); };
const conflict = () => fail('google_oauth_admission_attempt_conflict', 409);
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field));
const positive = value => Number.isSafeInteger(value) && value > 0 && value <= 2147483647;
const clock = value => {
  const date = value instanceof Date ? value.getTime() : value;
  if (!Number.isSafeInteger(date) || date < 0 || !Number.isFinite(new Date(date).getTime())) {
    fail('google_oauth_admission_attempt_unavailable', 503);
  }
  return date;
};
const date = value => value instanceof Date && Number.isSafeInteger(value.getTime()) && value.getTime() >= 0;
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function authorityFields(value) {
  if (typeof value.attemptId !== 'string' || !UUID.test(value.attemptId) || !positive(value.actorId)
    || !Number.isSafeInteger(value.sessionExpiresAt) || value.sessionExpiresAt < 0
    || !Number.isFinite(new Date(value.sessionExpiresAt).getTime()) || !SERVICES.includes(value.service)
    || typeof value.scopeKey !== 'string' || !/^(clinic|group):[1-9]\d{0,9}$/.test(value.scopeKey)
    || !positive(Number(value.scopeKey.split(':')[1])) || !Array.isArray(value.clinicIds)
    || !value.clinicIds.length || value.clinicIds.length > MAX_CLINICS
    || value.clinicIds.some((id, index) => !positive(id) || index > 0 && id <= value.clinicIds[index - 1])
    || value.scopeKey.startsWith('clinic:') && (value.clinicIds.length !== 1 || value.scopeKey !== 'clinic:' + value.clinicIds[0])) fail();
  return Object.freeze({ ...value, clinicIds: Object.freeze([...value.clinicIds]) });
}

function input(value) {
  if (!exact(value, INPUT_FIELDS) || typeof value.sessionRef !== 'string' || !UUID.test(value.sessionRef)) fail();
  return authorityFields(value);
}

function sessionHash(sessionRef) {
  if (typeof sessionRef !== 'string' || !UUID.test(sessionRef)) fail();
  return digest([DOMAIN, 'session_ref', sessionRef]);
}

const boundDigest = (v, hashedSession) => digest([DOMAIN, v.attemptId, v.actorId, hashedSession,
  v.sessionExpiresAt, v.scopeKey, v.clinicIds, v.service]);
function bindingDigest(value) {
  const v = input(value);
  return boundDigest(v, sessionHash(v.sessionRef));
}

function context(row) {
  let clinicIds;
  try { clinicIds = JSON.parse(row.clinic_ids); } catch { fail(); }
  return authorityFields({ attemptId: row.attempt_id, actorId: row.actor_user_id,
    sessionExpiresAt: row.session_expires_at?.getTime(), scopeKey: row.scope_key, clinicIds, service: row.service });
}

function record(value) {
  if (!exact(value, ROW_FIELDS)) fail();
  const v = { ...value };
  if (!date(v.session_expires_at) || !date(v.requested_at) || !date(v.expires_at) || !date(v.updated_at)) fail();
  const bound = context(v);
  if (!STATES.includes(v.state) || !Number.isSafeInteger(v.revision) || v.revision < 0 || v.revision > 1
    || v.clinic_ids !== JSON.stringify(bound.clinicIds) || v.clinic_count !== bound.clinicIds.length
    || typeof v.clinic_digest !== 'string' || !HASH.test(v.clinic_digest) || v.clinic_digest !== digest(bound.clinicIds)
    || typeof v.session_ref_hash !== 'string' || !HASH.test(v.session_ref_hash)
    || typeof v.binding_digest !== 'string' || !HASH.test(v.binding_digest) || v.binding_digest !== boundDigest(bound, v.session_ref_hash)
    || +v.expires_at !== Math.min(+v.requested_at + TTL_MS, +v.session_expires_at)
    || +v.expires_at <= +v.requested_at || +v.updated_at < +v.requested_at) fail();
  if (v.state === 'prepared' ? v.revision !== 0 || v.completed_at !== null || +v.updated_at !== +v.requested_at
    : v.revision !== 1 || !date(v.completed_at) || +v.completed_at !== +v.updated_at
      || v.state === 'cancelled' && +v.completed_at >= +v.expires_at
      || v.state === 'expired' && +v.completed_at < +v.expires_at) fail();
  for (const key of ['session_expires_at', 'requested_at', 'expires_at', 'updated_at', 'completed_at']) {
    if (v[key] !== null) v[key] = new Date(v[key].getTime());
  }
  return v;
}

function assertLive(value, at) {
  const v = input(value), time = clock(at);
  if (v.sessionExpiresAt <= time) fail('google_oauth_admission_session_required', 401);
  return v;
}

function prepare(value, at) {
  const v = assertLive(value, at), time = clock(at);
  return record({ attempt_id: v.attemptId, actor_user_id: v.actorId, session_ref_hash: sessionHash(v.sessionRef),
    session_expires_at: new Date(v.sessionExpiresAt), scope_key: v.scopeKey, clinic_ids: JSON.stringify(v.clinicIds),
    clinic_count: v.clinicIds.length, clinic_digest: digest(v.clinicIds), service: v.service, binding_digest: bindingDigest(v),
    state: 'prepared', revision: 0, requested_at: new Date(time), expires_at: new Date(Math.min(time + TTL_MS, v.sessionExpiresAt)),
    updated_at: new Date(time), completed_at: null });
}

function assertBound(value, supplied) {
  const row = record(value), bound = input(supplied);
  if (row.binding_digest !== bindingDigest(bound)) conflict();
  return row;
}

function expire(value, at) {
  const row = record(value), time = clock(at);
  if (time < +row.updated_at) fail('google_oauth_admission_attempt_unavailable', 503);
  if (row.state !== 'prepared' || time < +row.expires_at) return { row, changed: false };
  return { row: record({ ...row, state: 'expired', revision: 1, updated_at: new Date(time), completed_at: new Date(time) }), changed: true };
}

function cancel(value, expectedRevision, at) {
  const original = record(value);
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision > 1) fail();
  if (original.state !== 'prepared') {
    if (![original.revision, original.revision - 1].includes(expectedRevision)) conflict();
    return { row: expire(original, at).row, changed: false, replayed: true };
  }
  if (expectedRevision !== original.revision) conflict();
  const expired = expire(original, at);
  if (expired.changed) return { ...expired, replayed: false };
  const time = clock(at);
  return { row: record({ ...original, state: 'cancelled', revision: 1, updated_at: new Date(time), completed_at: new Date(time) }),
    changed: true, replayed: false };
}

function dto(value) {
  const row = record(value);
  return { attemptId: row.attempt_id, scopeKey: row.scope_key, service: row.service, state: row.state,
    revision: row.revision, expiresAt: row.expires_at.toISOString(), authorizationConfirmed: false, connected: false };
}

module.exports = { SERVICES, STATES, MAX_CLINICS, TTL_MS, INPUT_FIELDS, ROW_FIELDS, problem, exact,
  input, sessionHash, bindingDigest, record, assertLive, prepare, assertBound, expire, cancel, dto, clock };
