'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { UUID, fail } = require('./event'); const { stamp } = require('./view-contract');
const { positive } = require('./google-property-disconnect-event');
const keys = ['version', 'eventId', 'correlationId', 'occurredAt', 'action', 'stage', 'outcome', 'reason', 'actor',
  'subjectUserId', 'sessionRef', 'scope', 'provider', 'connectionRef', 'assetRef', 'operation', 'affectedClinicCount',
  'affectedClinicHash', 'authorizationPolicyVersion', 'capturePolicy'];
function exact(value, names) {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== names.length || names.some(k => !Object.hasOwn(value, k))) fail();
}
function googleAdsDisconnectEvent(v) {
  exact(v, keys); exact(v.actor, ['type', 'id']); exact(v.scope, ['type', 'id']);
  if (v.version !== 11 || !UUID.test(v.eventId) || !UUID.test(v.correlationId) || !stamp(v.occurredAt)
    || v.action !== 'integration.asset.disconnect' || !positive(v.subjectUserId) || !(v.sessionRef === null || UUID.test(v.sessionRef))
    || !['clinic', 'group'].includes(v.scope.type) || !positive(v.scope.id) || v.provider !== 'google_ads'
    || typeof v.assetRef !== 'string' || !/^ads:\d{10}$/.test(v.assetRef) || v.assetRef === 'ads:0000000000'
    || v.operation !== 'google.ads.asset.revoke.v1' || typeof v.connectionRef !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v.connectionRef)
    || !Number.isInteger(v.affectedClinicCount) || v.affectedClinicCount < 1 || v.affectedClinicCount > 1000
    || typeof v.affectedClinicHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.affectedClinicHash)
    || v.authorizationPolicyVersion !== 'connection-scope-write-v1' || v.capturePolicy !== 'google-ads-disconnect-durable-v1') fail();
  if (v.stage === 'attempted') {
    if (v.actor.type !== 'user' || v.actor.id !== v.subjectUserId || v.outcome !== 'unknown' || v.reason !== 'revocation_requested') fail();
  } else if (v.stage === 'completed') {
    if (v.actor.type !== 'job' || v.actor.id !== 'google_ads_revocation_worker' || v.sessionRef !== null
      || v.outcome !== 'success' || v.reason !== 'revocation_confirmed') fail();
  } else fail();
  return Object.fromEntries(keys.map(k => [k, ['actor', 'scope'].includes(k) ? { ...v[k] } : v[k]]));
}
function fromRevocation(row, stage, now, sessionRef = null) {
  const clinics = JSON.parse(row.clinic_ids); const [type, id] = row.scope_key.split(':');
  return googleAdsDisconnectEvent({ version: 11, eventId: randomUUID(), correlationId: row.request_id, occurredAt: now.toISOString(),
    action: 'integration.asset.disconnect', stage, outcome: stage === 'attempted' ? 'unknown' : 'success',
    reason: stage === 'attempted' ? 'revocation_requested' : 'revocation_confirmed',
    actor: stage === 'attempted' ? { type: 'user', id: String(row.actor_user_id) } : { type: 'job', id: 'google_ads_revocation_worker' },
    subjectUserId: String(row.actor_user_id), sessionRef, scope: { type, id }, provider: 'google_ads', connectionRef: row.connection_ref,
    assetRef: row.asset_ref, operation: 'google.ads.asset.revoke.v1', affectedClinicCount: clinics.length,
    affectedClinicHash: createHash('sha256').update(row.clinic_ids).digest('hex'),
    authorizationPolicyVersion: 'connection-scope-write-v1', capturePolicy: 'google-ads-disconnect-durable-v1' });
}
module.exports = { googleAdsDisconnectEvent, fromRevocation };
