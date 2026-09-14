'use strict';
const { randomUUID } = require('node:crypto'); const { UUID, fail } = require('./event'); const { stamp } = require('./view-contract');
const ACTION = 'integration.asset.disconnect'; const OPERATION = 'google.business_profile.asset.revoke.v1';
const keys = ['version', 'eventId', 'correlationId', 'occurredAt', 'action', 'stage', 'outcome', 'reason', 'actor',
  'subjectUserId', 'sessionRef', 'scope', 'provider', 'connectionRef', 'assetRef', 'operation', 'authorizationPolicyVersion', 'capturePolicy'];
const positive = v => typeof v === 'string' && /^[1-9]\d{0,9}$/.test(v) && Number(v) <= 2147483647;
const uuid = v => typeof v === 'string' && UUID.test(v);
function exact(v, names) { if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).length !== names.length || names.some(k => !Object.hasOwn(v,k))) fail(); }
function integrationDisconnectEvent(v) {
  exact(v,keys); exact(v.actor,['type','id']); exact(v.scope,['type','id']);
  if (v.version !== 7 || !uuid(v.eventId) || !uuid(v.correlationId) || !stamp(v.occurredAt) || v.action !== ACTION
    || !positive(v.subjectUserId) || !(v.sessionRef === null || uuid(v.sessionRef)) || v.scope.type !== 'clinic' || !positive(v.scope.id)
    || v.provider !== 'google_business_profile' || typeof v.connectionRef !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v.connectionRef)
    || typeof v.assetRef !== 'string' || !/^gbp:[1-9]\d{0,29}:[1-9]\d{0,29}$/.test(v.assetRef)
    || v.operation !== OPERATION || v.authorizationPolicyVersion !== 'connection-scope-write-v1' || v.capturePolicy !== 'provider-disconnect-durable-v1') fail();
  if (v.stage === 'attempted') {
    if (v.actor.type !== 'user' || v.actor.id !== v.subjectUserId || v.outcome !== 'unknown' || v.reason !== 'revocation_requested') fail();
  } else if (v.stage === 'completed') {
    if (v.actor.type !== 'job' || v.actor.id !== 'gbp_revocation_worker' || v.sessionRef !== null
      || v.outcome !== 'success' || v.reason !== 'revocation_confirmed') fail();
  } else fail();
  return Object.fromEntries(keys.map(k => [k, ['actor','scope'].includes(k) ? { type: v[k].type, id: v[k].id } : v[k]]));
}
function fromRevocation(row, stage, now, sessionRef = null) {
  return integrationDisconnectEvent({ version: 7, eventId: randomUUID(), correlationId: row.request_id, occurredAt: now.toISOString(),
    action: ACTION, stage, outcome: stage === 'attempted' ? 'unknown' : 'success', reason: stage === 'attempted' ? 'revocation_requested' : 'revocation_confirmed',
    actor: stage === 'attempted' ? { type: 'user', id: String(row.actor_user_id) } : { type: 'job', id: 'gbp_revocation_worker' },
    subjectUserId: String(row.actor_user_id), sessionRef: uuid(sessionRef) ? sessionRef : null,
    scope: { type: 'clinic', id: String(row.clinica_id) }, provider: 'google_business_profile',
    connectionRef: row.connection_ref, assetRef: row.asset_ref, operation: OPERATION,
    authorizationPolicyVersion: 'connection-scope-write-v1', capturePolicy: 'provider-disconnect-durable-v1' });
}
module.exports = { integrationDisconnectEvent, fromRevocation, ACTION, OPERATION, positive };
