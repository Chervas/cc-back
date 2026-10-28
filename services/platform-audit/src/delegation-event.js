'use strict';
// A separate generation: existing authentication/session contracts remain exact.
const { UUID, fail } = require('./event');
const ACTIONS = Object.freeze(['delegation.requested', 'delegation.started', 'delegation.revoked',
  'delegation.expired', 'delegation.http', 'delegation.socket', 'delegation.job', 'delegation.canonical']);
const KEYS = ['version', 'eventId', 'correlationId', 'requestCorrelationId', 'occurredAt', 'action', 'stage', 'outcome',
  'reason', 'actor', 'effectiveActor', 'adminUserId', 'sessionRef', 'parentSessionRef', 'delegationId', 'expiresAt',
  'runtimeNamespace', 'scope', 'http', 'socket', 'job', 'sourceEvent', 'capturePolicy'];
const uuid = v => typeof v === 'string' && UUID.test(v);
const id = v => typeof v === 'string' && /^[1-9]\d{0,9}$/.test(v) && Number(v) <= 2147483647;
const stamp = v => typeof v === 'string' && /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v)
  && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const safeName = v => typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,100}$/.test(v);
function exact(v, keys) {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).length !== keys.length
    || keys.some(k => !Object.hasOwn(v, k))) fail();
}
function delegationEvent(v) {
  exact(v, KEYS); exact(v.actor, ['type', 'id']); exact(v.effectiveActor, ['type', 'id']); exact(v.scope, ['type', 'id']);
  if (v.version !== 27 || ![v.eventId, v.correlationId, v.requestCorrelationId, v.sessionRef, v.parentSessionRef, v.delegationId].every(uuid)
    || v.sessionRef !== v.delegationId || v.parentSessionRef === v.sessionRef || !stamp(v.occurredAt) || !stamp(v.expiresAt)
    || !ACTIONS.includes(v.action) || !id(v.adminUserId) || v.effectiveActor.type !== 'user' || !id(v.effectiveActor.id)
    || v.adminUserId === v.effectiveActor.id || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(v.runtimeNamespace || '')
    || !(v.scope.type === 'platform' && v.scope.id === null || ['clinic', 'group'].includes(v.scope.type) && id(v.scope.id))
    || v.capturePolicy !== 'delegated-session-durable-v1') fail();
  const userActor = v.actor.type === 'user' && v.actor.id === v.adminUserId;
  if (!userActor && !(v.actor.type === 'job' && safeName(v.actor.id))) fail();
  if (['delegation.requested', 'delegation.started', 'delegation.revoked', 'delegation.expired'].includes(v.action)) {
    const reasons = { 'delegation.requested': ['admin_requested'], 'delegation.started': ['handoff_exchanged'],
      'delegation.revoked': ['child_exit', 'admin_revoked'], 'delegation.expired': ['expiry_observed'] };
    if (v.stage !== 'completed' || v.outcome !== 'success' || !reasons[v.action].includes(v.reason)
      || v.http !== null || v.socket !== null || v.job !== null || v.sourceEvent !== null || v.scope.type !== 'platform'
      || (v.action === 'delegation.expired' ? v.actor.type !== 'job' || v.actor.id !== 'auth_delegation_expiry' : !userActor)) fail();
  } else if (v.action === 'delegation.http') {
    exact(v.http, ['method', 'route', 'status']);
    if (!userActor || v.socket !== null || v.job !== null || v.sourceEvent !== null
      || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(v.http.method)
      // Express route patterns only; raw URLs, queries, bodies and header values are never recorded.
      || typeof v.http.route !== 'string' || !/^\/[A-Za-z0-9_/:.*()?-]{0,299}$/.test(v.http.route)
      || !(v.http.status === null || Number.isInteger(v.http.status) && v.http.status >= 100 && v.http.status <= 599)) fail();
    if (v.stage === 'attempted' ? v.outcome !== 'unknown' || v.reason !== 'request_admitted' || v.http.status !== null
      : v.stage !== 'completed' || !(v.outcome === 'observed' && v.reason === 'http_response_observed' && v.http.status !== null
        || v.outcome === 'unknown' && v.reason === 'connection_closed' && v.http.status === null)) fail();
  } else if (v.action === 'delegation.socket') {
    exact(v.socket, ['event']);
    if (!userActor || !safeName(v.socket.event) || v.http !== null || v.job !== null || v.sourceEvent !== null
      || v.stage !== 'completed' || v.outcome !== 'observed' || v.reason !== 'packet_admitted') fail();
  } else if (v.action === 'delegation.job') {
    exact(v.job, ['kind', 'type', 'jobRef', 'enqueueRef', 'attempt', 'result']);
    if (v.actor.type !== 'job' || v.http !== null || v.socket !== null || v.sourceEvent !== null || !['native', 'bull'].includes(v.job.kind)
      || !safeName(v.job.type) || typeof v.job.jobRef !== 'string' || !/^[A-Za-z0-9_.:-]{1,100}$/.test(v.job.jobRef)
      || !uuid(v.job.enqueueRef) || !Number.isInteger(v.job.attempt) || v.job.attempt < 0 || v.job.attempt > 100000
      || ![null, 'returned', 'waiting', 'completed', 'failed', 'threw'].includes(v.job.result)) fail();
    if (v.stage === 'attempted' ? v.outcome !== 'unknown' || v.reason !== 'job_admitted' || v.job.result !== null
      : v.stage !== 'completed' || !(v.outcome === 'observed' && v.reason === 'job_handler_returned' && ['returned', 'waiting', 'completed', 'failed'].includes(v.job.result)
        || v.outcome === 'error' && v.reason === 'job_handler_threw' && v.job.result === 'threw')) fail();
  } else {
    exact(v.sourceEvent, ['eventId', 'correlationId', 'version', 'action']);
    if (v.http !== null || v.socket !== null || v.job !== null || !uuid(v.sourceEvent.eventId) || !uuid(v.sourceEvent.correlationId)
      || !Number.isInteger(v.sourceEvent.version) || v.sourceEvent.version < 1 || v.sourceEvent.version > 26
      || !safeName(v.sourceEvent.action) || v.stage !== 'completed' || v.outcome !== 'observed'
      || v.reason !== 'canonical_event_recorded') fail();
  }
  return Object.fromEntries(KEYS.map(k => [k, v[k] && typeof v[k] === 'object' ? { ...v[k] } : v[k]]));
}
module.exports = { delegationEvent, ACTIONS, uuid, id, stamp };
