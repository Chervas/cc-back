'use strict';
const { exact, fail } = require('./reader-protocol');
const { criteriaFor, stamp } = require('./view-contract');
const uuid = v => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
function readEvent(v) {
  exact(v, ['version', 'eventId', 'correlationId', 'occurredAt', 'action', 'stage', 'outcome', 'reason', 'actor', 'sessionRef',
    'scope', 'criteria', 'resultCount', 'resultDigest', 'capturePolicy']); exact(v.actor, ['type', 'id']); exact(v.scope, ['type', 'id']);
  if (v.version !== 3 || !uuid(v.eventId) || !uuid(v.correlationId) || !stamp(v.occurredAt) || v.action !== 'audit.records.read'
    || v.actor.type !== 'user' || !/^[1-9]\d{0,9}$/.test(v.actor.id) || typeof v.actor.id !== 'string'
    || !(uuid(v.sessionRef) || v.outcome === 'denied' && v.sessionRef === null)
    || v.scope.type !== 'platform' || v.scope.id !== null || v.capturePolicy !== 'audit-view-v1') fail('audit_integrity_invalid');
  if (v.stage === 'attempted') {
    if (v.outcome !== 'unknown' || v.reason !== 'query_requested' || v.resultCount !== null || v.resultDigest !== null) fail();
  } else if (v.stage === 'completed') {
    if (v.outcome === 'success') {
      if (v.reason !== 'records_verified' || !Number.isInteger(v.resultCount) || v.resultCount < 0 || v.resultCount > 25
        || typeof v.resultDigest !== 'string' || !/^[a-f0-9]{64}$/.test(v.resultDigest)) fail();
    } else if (v.outcome === 'denied') {
      if (!['access_denied', 'query_invalid'].includes(v.reason) || v.criteria !== null || v.resultCount !== 0 || v.resultDigest !== null) fail();
    } else if (v.outcome !== 'error' || !['reader_unavailable', 'integrity_invalid'].includes(v.reason) || v.resultCount !== 0 || v.resultDigest !== null) fail();
  } else fail();
  return { version: 3, eventId: v.eventId, correlationId: v.correlationId, occurredAt: v.occurredAt, action: v.action,
    stage: v.stage, outcome: v.outcome, reason: v.reason, actor: { type: 'user', id: v.actor.id }, sessionRef: v.sessionRef,
    scope: { type: 'platform', id: null }, criteria: v.outcome === 'denied' ? null : criteriaFor(v.criteria), resultCount: v.resultCount,
    resultDigest: v.resultDigest, capturePolicy: v.capturePolicy };
}
module.exports = { readEvent };
