'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { UUID, fail } = require('./event');
const { stamp } = require('./view-contract');
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype
  && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const id = v => typeof v === 'string' && /^[1-9]\d{0,9}$/.test(v) && Number(v) <= 2147483647;
const uuid = v => typeof v === 'string' && UUID.test(v);
const hash = v => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const KEYS = 'version,eventId,correlationId,occurredAt,action,stage,outcome,reason,actor,sessionRef,initiatorSessionRef,scope,provider,connectionRef,assetRef,planRef,authorizationRef,requestRef,relatedCommandRef,mappingId,family,receiptState,eventCount,selectionDigest,clinicCount,clinicSetDigest,capturePolicy';
function destinationEvent(v) {
  if (!exact(v, KEYS) || !exact(v.actor, 'type,id') || !exact(v.scope, 'type,id')
    || v.version !== 18 || !uuid(v.eventId) || !uuid(v.correlationId) || v.correlationId !== v.requestRef
    || !uuid(v.planRef) || !uuid(v.authorizationRef) || !uuid(v.requestRef) || !uuid(v.sessionRef) || !uuid(v.initiatorSessionRef)
    || !stamp(v.occurredAt) || v.action !== 'integration.google_ads.destinations' || v.actor.type !== 'user' || !id(v.actor.id)
    || !['clinic','group'].includes(v.scope.type) || !id(v.scope.id) || v.provider !== 'google_ads' || !id(v.mappingId)
    || typeof v.connectionRef !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v.connectionRef)
    || typeof v.assetRef !== 'string' || !/^ads:\d{10}$/.test(v.assetRef) || v.assetRef === 'ads:0000000000'
    || !['authorize','status','revoke'].includes(v.family) || !['none','active','revoked'].includes(v.receiptState)
    || !Number.isInteger(v.eventCount) || v.eventCount < 1 || v.eventCount > 5 || !/^[a-f0-9]{64}$/.test(v.selectionDigest || '')
    || !Number.isInteger(v.clinicCount) || v.clinicCount < 1 || v.clinicCount > 1000 || !/^[a-f0-9]{64}$/.test(v.clinicSetDigest || '')
    || v.capturePolicy !== 'google-destinations-durable-v1') fail();
  if (v.reason === 'command_admitted') {
    if (v.stage !== 'attempted' || v.outcome !== 'unknown' || v.relatedCommandRef !== null || v.sessionRef !== v.initiatorSessionRef) fail();
  } else {
    if (v.stage !== 'completed') fail();
    if (v.reason === 'broker_acknowledged' || v.reason === 'result_recovered') {
      if (v.outcome !== 'success' || v.receiptState === 'none' || v.family === 'authorize' && v.receiptState !== 'active'
        || v.family === 'revoke' && v.receiptState !== 'revoked') fail();
      if (v.reason === 'broker_acknowledged' ? v.relatedCommandRef !== null || v.sessionRef !== v.initiatorSessionRef
        : v.family === 'status' || !uuid(v.relatedCommandRef) || v.relatedCommandRef === v.requestRef) fail();
    } else if (v.reason === 'authorization_withdrawn') {
      if (v.outcome !== 'unknown' || v.family !== 'authorize' || v.receiptState !== 'revoked'
        || !uuid(v.relatedCommandRef) || v.relatedCommandRef === v.requestRef) fail();
    } else fail();
  }
  return Object.fromEntries(KEYS.split(',').map(key => [key, ['actor','scope'].includes(key) ? { ...v[key] } : v[key]]));
}
function fromDestination(row, command, captured, actor, reason, { now, relatedCommandRef = null }) {
  const [type, scopeId] = row.scope_key.split(':');
  return destinationEvent({ version: 18, eventId: randomUUID(), correlationId: command.command_id, occurredAt: now.toISOString(),
    action: 'integration.google_ads.destinations', stage: reason === 'command_admitted' ? 'attempted' : 'completed',
    outcome: ['command_admitted','authorization_withdrawn'].includes(reason) ? 'unknown' : 'success', reason,
    actor: { type: 'user', id: String(actor.userId) }, sessionRef: actor.sessionRef, initiatorSessionRef: command.session_ref,
    scope: { type, id: scopeId }, provider: 'google_ads', connectionRef: captured.connectionRef, assetRef: captured.assetRef,
    planRef: row.plan_id, authorizationRef: row.authorization_id, requestRef: command.command_id, relatedCommandRef,
    mappingId: String(row.mapping_id), family: command.family, receiptState: row.receipt?.state || 'none',
    eventCount: row.input.targets.length, selectionDigest: hash(row.input), clinicCount: captured.clinicIds.length,
    clinicSetDigest: hash([...captured.clinicIds].sort((a,b) => a-b)), capturePolicy: 'google-destinations-durable-v1' });
}
module.exports = { destinationEvent, fromDestination };
