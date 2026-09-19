'use strict';
const {randomUUID,createHash}=require('node:crypto');
const {UUID,fail}=require('./event');const {stamp}=require('./view-contract');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const positive=value=>typeof value==='string'&&/^[1-9]\d{0,9}$/.test(value)&&Number(value)<=2147483647;
const hex=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const KEYS=['version','eventId','correlationId','occurredAt','action','stage','outcome','reason','actor','sessionRef','scope',
  'connectionRef','assetRef','mappingId','clinicCount','clinicSetDigest','operation','resultDigest','capturePolicy'];
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
function metaAccessCheckEvent(value) {
  if(!exact(value,KEYS)||!exact(value.actor,['type','id'])||!exact(value.scope,['type','id'])||value.version!==20
    ||!UUID.test(value.eventId)||!UUID.test(value.correlationId)||!UUID.test(value.sessionRef)||!stamp(value.occurredAt)
    ||value.action!=='integration.meta.access_check'||value.actor.type!=='user'||!positive(value.actor.id)
    ||!['clinic','group'].includes(value.scope.type)||!positive(value.scope.id)||!positive(value.mappingId)
    ||typeof value.connectionRef!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value.connectionRef)
    ||typeof value.assetRef!=='string'||!/^meta-(ad_account|facebook_page|instagram_business):[1-9][0-9]{0,29}$/.test(value.assetRef)
    ||!Number.isInteger(value.clinicCount)||value.clinicCount<1||value.clinicCount>1000||!hex(value.clinicSetDigest)
    ||!['meta.marketing.connection.read.v1','meta.marketing.asset.read.v1'].includes(value.operation)
    ||value.capturePolicy!=='meta-access-check-v1')fail();
  if(value.stage==='attempted') {
    if(value.outcome!=='unknown'||value.reason!=='check_requested'||value.resultDigest!==null)fail();
  }else if(value.stage==='completed'){
    if(value.outcome==='success'){
      if(value.reason!==(value.operation==='meta.marketing.asset.read.v1'?'asset_verified':'credential_verified')||!hex(value.resultDigest))fail();
    }else if(value.outcome==='denied'){
      if(value.reason!=='access_changed'||value.resultDigest!==null)fail();
    }else if(value.outcome!=='error'||value.reason!=='read_unavailable'||value.resultDigest!==null)fail();
  }else fail();
  return Object.fromEntries(KEYS.map(k=>[k,['actor','scope'].includes(k)?{...value[k]}:value[k]]));
}
function fromMetaAccessCheck({actor,captured,requestId,operation,reason,result=null,now}){
  const [type,id]=captured.scopeKey.split(':');const attempted=reason==='check_requested';
  return metaAccessCheckEvent({version:20,eventId:randomUUID(),correlationId:requestId,occurredAt:now.toISOString(),action:'integration.meta.access_check',
    stage:attempted?'attempted':'completed',outcome:attempted?'unknown':result!==null?'success':reason==='access_changed'?'denied':'error',reason,
    actor:{type:'user',id:String(actor.userId)},sessionRef:actor.sessionRef,scope:{type,id},connectionRef:captured.connectionRef,assetRef:captured.assetRef,
    mappingId:String(captured.mappingId),clinicCount:captured.clinicIds.length,clinicSetDigest:hash(captured.clinicIds.slice().sort((a,b)=>a-b)),operation,
    resultDigest:result===null?null:hash(result),capturePolicy:'meta-access-check-v1'});
}
module.exports={metaAccessCheckEvent,fromMetaAccessCheck};
