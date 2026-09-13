'use strict';
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const id = v => typeof v === 'string' && /^[1-9][0-9]{0,9}$/.test(v) && Number(v) <= 2147483647;
function fail() { throw Object.assign(Error('audit_event_invalid'), { code: 'audit_event_invalid' }); }
function exact(v, keys) { if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).length !== keys.length || keys.some(k => !Object.hasOwn(v, k))) fail(); }
function whatsappAuthorizationEvent(v) {
  exact(v, ['version', 'eventId', 'correlationId', 'occurredAt', 'action', 'stage', 'outcome', 'reason', 'actor', 'scope', 'sessionRef', 'requestRef', 'capturePolicy']);
  exact(v.actor, ['type', 'id']); exact(v.scope, ['type', 'id']);
  if (v.version !== 15 || !uuid(v.eventId) || !uuid(v.correlationId) || !uuid(v.sessionRef) || !uuid(v.requestRef)
    || typeof v.occurredAt !== 'string' || !/^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v.occurredAt)
    || !Number.isFinite(Date.parse(v.occurredAt)) || new Date(v.occurredAt).toISOString() !== v.occurredAt
    || v.action !== 'integration.whatsapp.authorization_state' || v.stage !== 'completed' || v.outcome !== 'success'
    || !['state_issued', 'state_claimed', 'state_cancelled'].includes(v.reason) || v.actor.type !== 'user' || !id(v.actor.id)
    || !['clinic', 'group'].includes(v.scope.type) || !id(v.scope.id) || v.capturePolicy !== 'whatsapp-onboarding-v1') fail();
  return { version: 15, eventId: v.eventId, correlationId: v.correlationId, occurredAt: v.occurredAt,
    action: v.action, stage: v.stage, outcome: v.outcome, reason: v.reason,
    actor: { type: v.actor.type, id: v.actor.id }, scope: { type: v.scope.type, id: v.scope.id },
    sessionRef: v.sessionRef, requestRef: v.requestRef, capturePolicy: v.capturePolicy };
}
module.exports = { whatsappAuthorizationEvent };
