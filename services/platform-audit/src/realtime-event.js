'use strict';
const { UUID, fail } = require('./event');
const { stamp } = require('./view-contract');
const { SOCKET_EVENTS, REALTIME_ACTIONS, MAX_CLINICS, positive } = require('./realtime-contract');
const keys = ['version', 'eventId', 'correlationId', 'occurredAt', 'action', 'stage', 'outcome', 'reason', 'actor',
  'sessionRef', 'scope', 'resource', 'socketEvent', 'clinicIds', 'authorizationPolicyVersion', 'capturePolicy'];
function exact(v, names) { if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).length !== names.length || names.some(k => !Object.hasOwn(v, k))) fail(); }
function realtimeEvent(v) {
  exact(v, keys); exact(v.actor, ['type', 'id']); exact(v.scope, ['type', 'id']); exact(v.resource, ['type', 'id']);
  const uuid = x => typeof x === 'string' && UUID.test(x);
  const id = x => typeof x === 'string' && positive(x);
  if (v.version !== 5 || !uuid(v.eventId) || !uuid(v.correlationId) || !stamp(v.occurredAt)
    || !REALTIME_ACTIONS.includes(v.action) || v.actor.type !== 'user' || !id(v.actor.id)
    || !(v.sessionRef === null || uuid(v.sessionRef)) || v.capturePolicy !== 'realtime-durable-v1' || v.authorizationPolicyVersion !== 'realtime-scope-v1'
    || !(v.scope.type === 'platform' && v.scope.id === null || ['clinic', 'group'].includes(v.scope.type) && id(v.scope.id))
    || !Array.isArray(v.clinicIds) || v.clinicIds.length > MAX_CLINICS || v.clinicIds.some(x => !id(x))
    || new Set(v.clinicIds).size !== v.clinicIds.length) fail();
  if (v.action === 'realtime.subscribe') {
    if (v.socketEvent !== null || v.resource.type !== 'subscription' || v.resource.id !== null || v.scope.type !== 'platform') fail();
  } else if (!SOCKET_EVENTS.includes(v.socketEvent) || ({ message: 'conversation', conversation: 'conversation', lead: 'lead', appointment: 'appointment', flow_execution: 'execution', notification: 'notification' })[v.socketEvent.split(':')[0]] !== v.resource.type || !id(v.resource.id)) fail();
  if (v.stage === 'attempted') {
    if (v.outcome !== 'unknown' || v.reason !== 'request_received' || v.clinicIds.length) fail();
  } else if (v.stage === 'completed') {
    if (v.outcome === 'success') {
      if (v.reason !== (v.action === 'realtime.subscribe' ? 'subscription_prepared' : 'packet_prepared')) fail();
      if (v.action === 'realtime.read' && (v.scope.type === 'clinic' && (v.clinicIds.length !== 1 || v.clinicIds[0] !== v.scope.id)
        || v.scope.type === 'group' && v.clinicIds.length === 0 || v.scope.type === 'platform' && (v.resource.type !== 'notification' || v.clinicIds.length))) fail();
    } else if (v.clinicIds.length || !(v.outcome === 'denied' && ['access_denied', 'request_invalid'].includes(v.reason)
      || v.outcome === 'error' && v.reason === 'operation_unconfirmed')) fail();
  } else fail();
  return Object.fromEntries(keys.map(k => [k, k === 'actor' || k === 'scope' || k === 'resource' ? { type: v[k].type, id: v[k].id }
    : k === 'clinicIds' ? [...v.clinicIds] : v[k]]));
}
module.exports = { realtimeEvent };
