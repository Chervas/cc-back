'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {UUID,fail}=require('./event');const {stamp}=require('./view-contract');
const {positive}=require('./google-property-disconnect-event');
const keys=['version','eventId','correlationId','occurredAt','action','stage','outcome','reason','actor','subjectUserId','sessionRef','scope',
  'provider','connectionRef','assetRef','operation','affectedClinicCount','affectedClinicHash','authorizationPolicyVersion','capturePolicy'];
const exact=(v,names)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===names.slice().sort().join(',');
function metaDisconnectEvent(v){
  if(!exact(v,keys)||!exact(v.actor,['type','id'])||!exact(v.scope,['type','id'])||v.version!==21||!UUID.test(v.eventId)||!UUID.test(v.correlationId)
    ||!stamp(v.occurredAt)||v.action!=='integration.asset.disconnect'||!positive(v.subjectUserId)||!(v.sessionRef===null||UUID.test(v.sessionRef))
    ||!['clinic','group'].includes(v.scope.type)||!positive(v.scope.id)||v.provider!=='meta_marketing'||typeof v.assetRef!=='string'
    ||!/^meta-(ad_account|facebook_page|instagram_business):[1-9][0-9]{0,29}$/.test(v.assetRef)||v.operation!=='meta.marketing.asset.revoke.v1'
    ||typeof v.connectionRef!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(v.connectionRef)
    ||!Number.isInteger(v.affectedClinicCount)||v.affectedClinicCount<1||v.affectedClinicCount>1000
    ||typeof v.affectedClinicHash!=='string'||!/^[a-f0-9]{64}$/.test(v.affectedClinicHash)
    ||v.authorizationPolicyVersion!=='connection-scope-write-v1'||v.capturePolicy!=='meta-disconnect-durable-v1')fail();
  if(v.stage==='attempted'){
    if(v.actor.type!=='user'||v.actor.id!==v.subjectUserId||v.outcome!=='unknown'||v.reason!=='revocation_requested'||!UUID.test(v.sessionRef))fail();
  }else if(v.stage==='completed'){
    if(v.actor.type!=='job'||v.actor.id!=='meta_marketing_revocation_worker'||v.sessionRef!==null||v.outcome!=='success'||v.reason!=='revocation_confirmed')fail();
  }else fail();
  return Object.fromEntries(keys.map(k=>[k,['actor','scope'].includes(k)?{...v[k]}:v[k]]));
}
function fromRevocation(row,stage,now,sessionRef=null){
  const clinics=JSON.parse(row.clinic_ids),[type,id]=row.scope_key.split(':');
  return metaDisconnectEvent({version:21,eventId:randomUUID(),correlationId:row.request_id,occurredAt:now.toISOString(),action:'integration.asset.disconnect',stage,
    outcome:stage==='attempted'?'unknown':'success',reason:stage==='attempted'?'revocation_requested':'revocation_confirmed',
    actor:stage==='attempted'?{type:'user',id:String(row.actor_user_id)}:{type:'job',id:'meta_marketing_revocation_worker'},subjectUserId:String(row.actor_user_id),sessionRef,
    scope:{type,id},provider:'meta_marketing',connectionRef:row.connection_ref,assetRef:row.asset_ref,operation:'meta.marketing.asset.revoke.v1',
    affectedClinicCount:clinics.length,affectedClinicHash:createHash('sha256').update(row.clinic_ids).digest('hex'),
    authorizationPolicyVersion:'connection-scope-write-v1',capturePolicy:'meta-disconnect-durable-v1'});
}
module.exports={metaDisconnectEvent,fromRevocation};
