'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { UUID, fail } = require('./event'); const { stamp } = require('./view-contract');
const { positive } = require('./google-property-disconnect-event');
const keys = ['version', 'eventId', 'correlationId', 'occurredAt', 'action', 'stage', 'outcome', 'reason', 'actor',
  'subjectUserId', 'sessionRef', 'scope', 'provider', 'connectionRef', 'assetRef', 'mappingId', 'previousState', 'state',
  'previousScope', 'previousClinicId', 'clinicId', 'affectedClinicCount', 'affectedClinicHash', 'authorizationPolicyVersion', 'capturePolicy'];
const exact = (value, names) => {
  if (!value || Object.getPrototypeOf(value) !== Object.prototype || Object.keys(value).length !== names.length
    || names.some(k => !Object.hasOwn(value, k))) fail();
};
function scope(value) { exact(value, ['type', 'id']); if (!['clinic', 'group'].includes(value.type) || !positive(value.id)) fail(); }
function googleAdsMappingEvent(v) {
  exact(v, keys); exact(v.actor, ['type', 'id']); scope(v.scope);
  if (v.version !== 12 || !UUID.test(v.eventId) || !UUID.test(v.correlationId) || !stamp(v.occurredAt)
    || v.action !== 'integration.asset.map' || v.stage !== 'completed' || v.outcome !== 'success'
    || !positive(v.subjectUserId) || v.actor.type !== 'user' || v.actor.id !== v.subjectUserId || !UUID.test(v.sessionRef)
    || v.provider !== 'google_ads' || !positive(v.mappingId) || v.state !== 'active' || !['active', 'staged'].includes(v.previousState)
    || typeof v.assetRef !== 'string' || !/^ads:\d{10}$/.test(v.assetRef) || v.assetRef === 'ads:0000000000'
    || typeof v.connectionRef !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v.connectionRef)
    || !(v.clinicId === null || positive(v.clinicId)) || !(v.previousClinicId === null || positive(v.previousClinicId))
    || !Number.isInteger(v.affectedClinicCount) || v.affectedClinicCount < 1 || v.affectedClinicCount > 1000
    || typeof v.affectedClinicHash !== 'string' || !/^[a-f0-9]{64}$/.test(v.affectedClinicHash)
    || v.authorizationPolicyVersion !== 'connection-scope-write-v1' || v.capturePolicy !== 'google-ads-mapping-durable-v1') fail();
  scope(v.previousScope);
  if (v.reason !== (v.previousState === 'staged' ? 'mapping_activated' : 'mapping_updated')) fail();
  return Object.fromEntries(keys.map(k => [k, ['actor', 'scope', 'previousScope'].includes(k) ? { ...v[k] } : v[k]]));
}
function fromMapping({ before, after, binding, clinicIds, actorId, sessionRef, correlationId, now }) {
  const owner = row => ({ type: row.assignmentScope, id: String(row.assignmentScope === 'group' ? row.grupoClinicaId : row.clinicaId) });
  const clinics = [...new Set(clinicIds.map(Number))].sort((a, b) => a - b);
  if (clinics.length !== clinicIds.length || clinics.some(id => !positive(String(id)))) fail();
  return googleAdsMappingEvent({ version: 12, eventId: randomUUID(), correlationId, occurredAt: now.toISOString(),
    action: 'integration.asset.map', stage: 'completed', outcome: 'success', reason: binding.state === 'staged' ? 'mapping_activated' : 'mapping_updated',
    actor: { type: 'user', id: String(actorId) }, subjectUserId: String(actorId), sessionRef, scope: owner(after),
    provider: 'google_ads', connectionRef: binding.connection_ref, assetRef: binding.asset_ref, mappingId: String(after.id),
    previousState: binding.state, state: 'active', previousScope: owner(before),
    previousClinicId: before.clinicaId == null ? null : String(before.clinicaId), clinicId: after.clinicaId == null ? null : String(after.clinicaId),
    affectedClinicCount: clinics.length, affectedClinicHash: createHash('sha256').update(JSON.stringify(clinics)).digest('hex'),
    authorizationPolicyVersion: 'connection-scope-write-v1', capturePolicy: 'google-ads-mapping-durable-v1' });
}
module.exports = { googleAdsMappingEvent, fromMapping };
