'use strict';
const { randomUUID } = require('node:crypto');
const { UUID, fail } = require('./event');
const { stamp } = require('./view-contract');
const PHASES = Object.freeze({ association_requested: ['prepare_pending',1], association_prepared: ['prepared',2], association_confirmed: ['retire_pending',3], association_retired: ['active',4], association_cancelled: ['cancelled',5] });
const KEYS = ['version','eventId','correlationId','occurredAt','action','stage','outcome','reason','actor','subjectUserId','sessionRef','scope','provider','connectionRef','assetRef','previousAssetRef','mappingId','previousMappingId','state','capturePolicy'];
const positive = v => typeof v === 'string' && /^[1-9]\d{0,9}$/.test(v) && Number(v) <= 2147483647;
const asset = v => typeof v === 'string' && /^gbp:[1-9]\d{0,29}:[1-9]\d{0,29}$/.test(v);
function associationEvent(v) {
  if (!v || Object.getPrototypeOf(v) !== Object.prototype || Object.keys(v).length !== KEYS.length || KEYS.some(k => !Object.hasOwn(v,k))
    || !v.actor || Object.keys(v.actor).sort().join(',') !== 'id,type' || !v.scope || Object.keys(v.scope).sort().join(',') !== 'id,type'
    || v.version !== 31 || !UUID.test(v.eventId) || !UUID.test(v.correlationId) || !stamp(v.occurredAt)
    || v.action !== 'integration.asset.map' || v.stage !== 'completed' || v.outcome !== 'success'
    || !Object.hasOwn(PHASES,v.reason) || v.state !== PHASES[v.reason][0]
    || v.actor.type !== 'user' || !positive(v.actor.id) || v.actor.id !== v.subjectUserId || !UUID.test(v.sessionRef)
    || v.scope.type !== 'clinic' || !positive(v.scope.id) || v.provider !== 'google_business_profile'
    || typeof v.connectionRef !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v.connectionRef)
    || !asset(v.assetRef) || !(v.previousAssetRef === null || asset(v.previousAssetRef))
    || !positive(v.mappingId) || !(v.previousMappingId === null || positive(v.previousMappingId))
    || v.capturePolicy !== 'google-business-profile-association-durable-v1') fail();
  return Object.fromEntries(KEYS.map(k => [k,['actor','scope'].includes(k) ? {...v[k]} : v[k]]));
}
function fromAssociation(row,reason,now,{actorId=row.actor_user_id,sessionRef=row.session_ref}={}) {
  return associationEvent({version:31,eventId:randomUUID(),correlationId:row.attempt_id,occurredAt:now.toISOString(),action:'integration.asset.map',stage:'completed',outcome:'success',reason,
    actor:{type:'user',id:String(actorId)},subjectUserId:String(actorId),sessionRef,scope:{type:'clinic',id:String(row.clinica_id)},provider:'google_business_profile',
    connectionRef:row.connection_ref,assetRef:`gbp:${row.account_id}:${row.location_id}`,previousAssetRef:row.previous_asset_ref || null,mappingId:String(row.target_mapping_id),previousMappingId:row.source_mapping_id == null ? null : String(row.source_mapping_id),state:PHASES[reason]?.[0],capturePolicy:'google-business-profile-association-durable-v1'});
}
module.exports = {associationEvent,fromAssociation,PHASES};
