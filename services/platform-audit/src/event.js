'use strict';
// Dependency-free contract also consumed by the Node 18 application.
const { createHash } = require('node:crypto');
const { isIP } = require('node:net');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const uuid = value => typeof value === 'string' && UUID.test(value);
const ACTIONS = new Set(['auth.sign_in', 'auth.token_sign_in', 'auth.unlock']);
function fail(code = 'audit_event_invalid') { throw Object.assign(Error(code), { code }); }
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) fail();
}
function event(value) {
  if (value?.version === 2) return require('./session-event').sessionEvent(value);
  if (value?.version === 3) return require('./read-event').readEvent(value);
  if (value?.version === 4) return require('./permission-event').permissionEvent(value);
  if (value?.version === 5) return require('./realtime-event').realtimeEvent(value);
  exact(value, ['version', 'eventId', 'occurredAt', 'correlationId', 'action', 'stage', 'outcome', 'reason',
    'actor', 'effectiveActor', 'sessionRef', 'scope', 'resource', 'capturePolicy', 'authorizationPolicyVersion', 'origin']);
  exact(value.actor, ['type', 'id']); exact(value.scope, ['type', 'id']); exact(value.resource, ['type', 'id']);
  exact(value.origin, ['kind', 'ip']);
  if (value.version !== 1 || !uuid(value.eventId) || !uuid(value.correlationId)
    || !ACTIONS.has(value.action) || typeof value.occurredAt !== 'string'
    || !/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.occurredAt)
    || !Number.isFinite(Date.parse(value.occurredAt)) || new Date(value.occurredAt).toISOString() !== value.occurredAt
    || value.effectiveActor !== null || value.authorizationPolicyVersion !== null
    || value.capturePolicy !== 'auth-durable-v1' || value.scope.type !== 'platform' || value.scope.id !== null
    || value.resource.type !== 'session' || value.resource.id !== null
    || value.origin.kind !== 'direct_peer' || !(value.origin.ip === null || typeof value.origin.ip === 'string' && isIP(value.origin.ip))) fail();
  const anonymous = value.actor.type === 'anonymous' && value.actor.id === null;
  const user = value.actor.type === 'user' && typeof value.actor.id === 'string' && /^[1-9]\d{0,18}$/.test(value.actor.id);
  if (!anonymous && !user) fail();
  if (value.stage === 'attempted') {
    if (value.outcome !== 'unknown' || value.reason !== 'started' || !anonymous || value.sessionRef !== null) fail();
  } else if (value.stage === 'completed') {
    if (value.outcome === 'success') {
      if (!user || !uuid(value.sessionRef) || value.reason !== (value.action === 'auth.token_sign_in' ? 'token_verified' : 'credentials_verified')) fail();
    } else {
      const reasons = value.outcome === 'denied'
        ? value.action === 'auth.token_sign_in' ? ['token_rejected', 'token_expired', 'request_invalid'] : ['credentials_rejected', 'request_invalid']
        : value.outcome === 'error' ? ['internal_error'] : [];
      if (!anonymous || value.sessionRef !== null || !reasons.includes(value.reason)) fail();
    }
  } else fail();
  return { version: 1, eventId: value.eventId, occurredAt: value.occurredAt, correlationId: value.correlationId,
    action: value.action, stage: value.stage, outcome: value.outcome, reason: value.reason,
    actor: { type: value.actor.type, id: value.actor.id }, effectiveActor: null, sessionRef: value.sessionRef,
    scope: { type: 'platform', id: null }, resource: { type: 'session', id: null }, capturePolicy: 'auth-durable-v1',
    authorizationPolicyVersion: null, origin: { kind: 'direct_peer', ip: value.origin.ip } };
}
function pack(value) {
  const validated = event(value); const body = JSON.stringify(validated);
  return { event: validated, body, digest: createHash('sha256').update(body).digest('hex') };
}
function unpack(row) {
  if (typeof row.body !== 'string' || Buffer.byteLength(row.body) > 4096) fail();
  let value; try { value = pack(JSON.parse(row.body)); } catch { fail(); }
  if (value.body !== row.body || value.digest !== row.digest) fail('audit_integrity_invalid');
  return value;
}
function keyFor(row) {
  const value = unpack(row);
  return `app/platform/v${value.event.version}/${value.event.occurredAt.slice(0, 10)}/${value.event.eventId}-${value.digest}.json`;
}
function receiptFor(row, value) {
  exact(value, ['key', 'digest', 'versionId']);
  if (value.key !== keyFor(row) || value.digest !== row.digest || typeof value.versionId !== 'string'
    || !/^[A-Za-z0-9_.+/=-]{1,1024}$/.test(value.versionId) || value.versionId === 'null') fail('audit_receipt_invalid');
  return { key: value.key, digest: value.digest, versionId: value.versionId };
}
module.exports = { UUID, ACTIONS, event, pack, unpack, keyFor, receiptFor, fail };
