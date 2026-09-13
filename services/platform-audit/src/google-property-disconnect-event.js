'use strict';
const { randomUUID } = require('node:crypto'); const { UUID, fail } = require('./event'); const { stamp } = require('./view-contract');
const ACTION = 'integration.asset.disconnect';
const KINDS = Object.freeze({ search_console: ['google_search_console', 'google.search_console.asset.revoke.v1', /^sc:[a-f0-9]{64}$/],
  analytics: ['google_analytics', 'google.analytics.asset.revoke.v1', /^ga4:[1-9]\d{0,19}$/] });
const positive = v => typeof v === 'string' && /^[1-9]\d{0,9}$/.test(v) && Number(v) <= 2147483647;
const uuid = v => typeof v === 'string' && UUID.test(v);
const keys = ['version', 'eventId', 'correlationId', 'occurredAt', 'action', 'stage', 'outcome', 'reason', 'actor',
  'subjectUserId', 'sessionRef', 'scope', 'provider', 'connectionRef', 'assetRef', 'operation', 'authorizationPolicyVersion', 'capturePolicy'];
function exact(v, names) { if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).length !== names.length || names.some(k => !Object.hasOwn(v, k))) fail(); }
function googlePropertyDisconnectEvent(v) {
  exact(v, keys); exact(v.actor, ['type', 'id']); exact(v.scope, ['type', 'id']);
  const kind = Object.values(KINDS).find(row => row[0] === v.provider);
  if (v.version !== 9 || !uuid(v.eventId) || !uuid(v.correlationId) || !stamp(v.occurredAt) || v.action !== ACTION
    || !positive(v.subjectUserId) || !(v.sessionRef === null || uuid(v.sessionRef)) || v.scope.type !== 'clinic' || !positive(v.scope.id)
    || !kind || typeof v.assetRef !== 'string' || !kind[2].test(v.assetRef) || v.operation !== kind[1]
    || typeof v.connectionRef !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v.connectionRef)
    || v.authorizationPolicyVersion !== 'connection-scope-write-v1' || v.capturePolicy !== 'google-property-disconnect-durable-v1') fail();
  if (v.stage === 'attempted') {
    if (v.actor.type !== 'user' || v.actor.id !== v.subjectUserId || v.outcome !== 'unknown' || v.reason !== 'revocation_requested') fail();
  } else if (v.stage === 'completed') {
    if (v.actor.type !== 'job' || v.actor.id !== 'google_property_revocation_worker' || v.sessionRef !== null
      || v.outcome !== 'success' || v.reason !== 'revocation_confirmed') fail();
  } else fail();
  return Object.fromEntries(keys.map(k => [k, ['actor', 'scope'].includes(k) ? { type: v[k].type, id: v[k].id } : v[k]]));
}
function fromRevocation(row, stage, now, sessionRef = null) {
  if (!Object.hasOwn(KINDS, row.kind)) fail(); const kind = KINDS[row.kind];
  return googlePropertyDisconnectEvent({ version: 9, eventId: randomUUID(), correlationId: row.request_id, occurredAt: now.toISOString(),
    action: ACTION, stage, outcome: stage === 'attempted' ? 'unknown' : 'success', reason: stage === 'attempted' ? 'revocation_requested' : 'revocation_confirmed',
    actor: stage === 'attempted' ? { type: 'user', id: String(row.actor_user_id) } : { type: 'job', id: 'google_property_revocation_worker' },
    subjectUserId: String(row.actor_user_id), sessionRef, scope: { type: 'clinic', id: String(row.clinica_id) }, provider: kind[0],
    connectionRef: row.connection_ref, assetRef: row.asset_ref, operation: kind[1],
    authorizationPolicyVersion: 'connection-scope-write-v1', capturePolicy: 'google-property-disconnect-durable-v1' });
}
module.exports = { googlePropertyDisconnectEvent, fromRevocation, KINDS, ACTION, positive };
