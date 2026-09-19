'use strict';
const { randomUUID } = require('node:crypto');
const { UUID, fail } = require('./event');
const { stamp } = require('./view-contract');
const KEYS = ['version', 'eventId', 'correlationId', 'occurredAt', 'action', 'stage', 'outcome', 'reason',
  'actor', 'sessionRef', 'initiatorUserId', 'initiatorSessionRef', 'scope', 'provider', 'connectionRef',
  'assetRef', 'operationRef', 'mappingId', 'family', 'executionRef', 'nodeRef', 'runtimeNamespace',
  'clinicCount', 'clinicSetDigest', 'inputDigest', 'capturePolicy'];
const id = v => typeof v === 'string' && /^[1-9]\d{0,9}$/.test(v) && Number(v) <= 2147483647;
const uuid = v => typeof v === 'string' && UUID.test(v);
const exact = (v, keys) => {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).sort().join(',') !== [...keys].sort().join(',')) fail();
};
function businessProfileMutationEvent(v) {
  exact(v, KEYS); exact(v.actor, ['type', 'id']); exact(v.scope, ['type', 'id']);
  if (v.version !== 25 || !uuid(v.eventId) || !uuid(v.correlationId) || !uuid(v.operationRef)
    || v.correlationId !== v.operationRef || !stamp(v.occurredAt) || v.action !== 'integration.google_business_profile.mutation'
    || !id(v.initiatorUserId) || v.scope.type !== 'clinic' || !id(v.scope.id) || !id(v.mappingId)
    || v.provider !== 'google_business_profile' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v.connectionRef || '')
    || !/^gbp:[1-9]\d{0,29}:[1-9]\d{0,29}$/.test(v.assetRef || '')
    || !['replyUpdate', 'replyDelete', 'photo', 'hours'].includes(v.family)
    || !/^[a-z][a-z0-9_-]{0,31}$/.test(v.runtimeNamespace || '')
    || !Number.isInteger(v.clinicCount) || v.clinicCount < 1 || v.clinicCount > 1000
    || !/^[a-f0-9]{64}$/.test(v.clinicSetDigest || '') || !/^[a-f0-9]{64}$/.test(v.inputDigest || '')
    || v.capturePolicy !== 'business-profile-mutation-durable-v1') fail();
  const automated = v.executionRef !== null;
  if (automated ? !id(v.executionRef) || typeof v.nodeRef !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(v.nodeRef)
    || v.initiatorSessionRef !== null || v.family !== 'hours'
    : v.nodeRef !== null || !uuid(v.initiatorSessionRef)) fail();
  if (v.actor.type === 'user') {
    if (v.actor.id !== v.initiatorUserId || !uuid(v.sessionRef)) fail();
  } else if (v.actor.type !== 'job' || !automated || v.actor.id !== v.executionRef || v.sessionRef !== null) fail();
  if (v.reason === 'mutation_admitted') {
    if (v.stage !== 'attempted' || v.outcome !== 'unknown' || (automated ? v.actor.type !== 'job'
      : v.sessionRef !== v.initiatorSessionRef)) fail();
  } else if (!['mutation_applied', 'mutation_recovered'].includes(v.reason) || v.stage !== 'completed' || v.outcome !== 'success') fail();
  return Object.fromEntries(KEYS.map(key => [key, ['actor', 'scope'].includes(key) ? { ...v[key] } : v[key]]));
}
function fromMutation(row, captured, actor, reason, now) {
  const job = actor.type === 'automation';
  return businessProfileMutationEvent({ version: 25, eventId: randomUUID(), correlationId: row.operation_id,
    occurredAt: now.toISOString(), action: 'integration.google_business_profile.mutation',
    stage: reason === 'mutation_admitted' ? 'attempted' : 'completed', outcome: reason === 'mutation_admitted' ? 'unknown' : 'success', reason,
    actor: { type: job ? 'job' : 'user', id: String(job ? actor.executionId : actor.userId) },
    sessionRef: job ? null : actor.sessionRef, initiatorUserId: String(row.actor_user_id), initiatorSessionRef: row.session_ref,
    scope: { type: 'clinic', id: String(row.requested_clinic_id) }, provider: 'google_business_profile',
    connectionRef: row.connection_ref, assetRef: row.asset_ref, operationRef: row.operation_id, mappingId: String(row.mapping_id),
    family: row.kind, executionRef: row.execution_id === null ? null : String(row.execution_id), nodeRef: row.node_id,
    runtimeNamespace: row.runtime_namespace, clinicCount: captured.clinicIds.length,
    clinicSetDigest: require('node:crypto').createHash('sha256').update(JSON.stringify(captured.clinicIds)).digest('hex'),
    inputDigest: row.input_digest, capturePolicy: 'business-profile-mutation-durable-v1' });
}
module.exports = { businessProfileMutationEvent, fromMutation };
