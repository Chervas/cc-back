'use strict';
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const userId = value => typeof value === 'string' && /^[1-9][0-9]{0,9}$/.test(value);
function invalid() { throw Object.assign(Error('audit_event_invalid'), { code: 'audit_event_invalid' }); }
function exact(value, keys) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== keys.length
    || keys.some(key => !Object.hasOwn(value, key))) invalid();
}
function emailAuthEvent(v) {
  exact(v, ['version', 'eventId', 'correlationId', 'occurredAt', 'action', 'stage', 'outcome', 'reason',
    'actor', 'scope', 'challengeRef', 'sessionRef', 'capturePolicy']);
  exact(v.actor, ['type', 'id']); exact(v.scope, ['type', 'id']);
  const anonymous = v.actor.type === 'anonymous' && v.actor.id === null;
  const identified = v.actor.type === 'user' && userId(v.actor.id);
  const reset = v.action === 'auth.password_reset';
  const reasons = { pending: ['code_queued', 'code_resent'], success: ['code_verified'],
    denied: ['credentials_rejected', 'request_invalid', 'code_rejected', 'code_expired', 'attempts_exhausted',
      'challenge_rejected', 'credentials_changed', 'credentials_change_blocked', 'rate_limited'], error: ['delivery_unavailable', 'internal_error'] };
  if (v.version !== 13 || !uuid(v.eventId) || !uuid(v.correlationId) || (!reset && v.action !== 'auth.email_code')
    || v.stage !== 'completed' || (reset ? v.outcome !== 'success' || v.reason !== 'credentials_reset' || !identified
      || v.challengeRef !== null || v.sessionRef !== null : !Object.hasOwn(reasons, v.outcome) || !reasons[v.outcome].includes(v.reason))
    || typeof v.occurredAt !== 'string' || !/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.occurredAt)
    || !Number.isFinite(Date.parse(v.occurredAt)) || new Date(v.occurredAt).toISOString() !== v.occurredAt
    || (!anonymous && !identified) || v.scope.type !== 'platform' || v.scope.id !== null
    || !(v.challengeRef === null || uuid(v.challengeRef)) || v.capturePolicy !== 'email-login-v1'
    || (!reset && (v.outcome === 'success' ? !identified || !uuid(v.challengeRef) || !uuid(v.sessionRef) : v.sessionRef !== null))
    || (v.outcome === 'pending' && (!identified || !uuid(v.challengeRef)))) invalid();
  return { version: 13, eventId: v.eventId, correlationId: v.correlationId, occurredAt: v.occurredAt,
    action: v.action, stage: v.stage, outcome: v.outcome, reason: v.reason,
    actor: { type: v.actor.type, id: v.actor.id }, scope: { type: 'platform', id: null },
    challengeRef: v.challengeRef, sessionRef: v.sessionRef, capturePolicy: v.capturePolicy };
}
module.exports = { emailAuthEvent };
