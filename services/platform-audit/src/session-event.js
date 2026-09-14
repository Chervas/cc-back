'use strict';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const userId = value => typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value);
const timestamp = value => typeof value === 'string' && /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
function invalid() { throw Object.assign(Error('audit_event_invalid'), { code: 'audit_event_invalid' }); }
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function sessionEvent(v) {
  exact(v, ['version', 'eventId', 'correlationId', 'occurredAt', 'effectiveAt', 'action', 'stage', 'outcome', 'reason',
    'actor', 'subjectUserId', 'sessionRef', 'scope', 'capturePolicy']);
  exact(v.actor, ['type', 'id']);
  exact(v.scope, ['type', 'id']);
  const reasons = { 'session.issued': ['credentials_verified', 'account_created', 'invite_claimed'],
    'session.renewed': ['token_verified'], 'session.revoked': ['user_sign_out', 'user_revoke_all'], 'session.expired': ['expiry_observed'] };
  if (v.version !== 2 || !uuid(v.eventId) || !uuid(v.correlationId) || !timestamp(v.occurredAt) || !timestamp(v.effectiveAt)
    || v.effectiveAt > v.occurredAt || typeof v.action !== 'string' || !Object.hasOwn(reasons, v.action)
    || !reasons[v.action].includes(v.reason) || v.stage !== 'completed' || v.outcome !== 'success'
    || !userId(v.subjectUserId) || !uuid(v.sessionRef) || v.capturePolicy !== 'managed-session-v1'
    || v.scope.type !== 'platform' || v.scope.id !== null) invalid();
  if (v.action === 'session.expired' ? v.actor.type !== 'job' || v.actor.id !== 'auth_session_expiry'
    : v.actor.type !== 'user' || v.actor.id !== v.subjectUserId || v.effectiveAt !== v.occurredAt) invalid();
  return { version: 2, eventId: v.eventId, correlationId: v.correlationId, occurredAt: v.occurredAt,
    effectiveAt: v.effectiveAt, action: v.action, stage: 'completed', outcome: 'success', reason: v.reason,
    actor: { type: v.actor.type, id: v.actor.id }, subjectUserId: v.subjectUserId, sessionRef: v.sessionRef,
    scope: { type: 'platform', id: null }, capturePolicy: v.capturePolicy };
}
module.exports = { sessionEvent };
