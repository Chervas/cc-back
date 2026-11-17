'use strict';
const {randomUUID,createHash}=require('node:crypto'),{UUID,fail}=require('./event'),{stamp}=require('./view-contract');
const KEYS=['version','eventId','correlationId','occurredAt','action','stage','outcome','reason','actor','sessionRef','scope','connectionRef','enrollmentRef','credentialVersionRef','epoch','clinicCount','clinicSetDigest','assetCount','resultDigest','capturePolicy'];
const exact=(v,k)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===k.slice().sort().join(',');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v),positive=v=>typeof v==='string'&&/^[1-9][0-9]{0,9}$/.test(v)&&Number(v)<=2147483647;
function metaActiveInventoryEvent(v){
 const phase={inventory_requested:['attempted','unknown'],inventory_verified:['completed','success'],access_changed:['completed','denied'],inventory_unavailable:['completed','error']}[v?.reason];
 if(!exact(v,KEYS)||!exact(v.actor,['type','id'])||!exact(v.scope,['type','id'])||v.version!==32||!phase||v.stage!==phase[0]||v.outcome!==phase[1]
  ||![v.eventId,v.correlationId,v.sessionRef,v.enrollmentRef,v.credentialVersionRef].every(id=>UUID.test(id||''))||!stamp(v.occurredAt)
  ||v.action!=='integration.meta.active_asset_list'||v.actor.type!=='user'||!positive(v.actor.id)||!['clinic','group'].includes(v.scope.type)||!positive(v.scope.id)
  ||typeof v.connectionRef!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v.connectionRef)||!Number.isSafeInteger(v.epoch)||v.epoch<0
  ||!Number.isInteger(v.clinicCount)||v.clinicCount<1||v.clinicCount>1000||v.scope.type==='clinic'&&v.clinicCount!==1||!hex(v.clinicSetDigest)
  ||!Number.isInteger(v.assetCount)||v.assetCount<0||v.assetCount>100||v.capturePolicy!=='meta-active-inventory-v1'
  ||(v.reason==='inventory_verified'?!hex(v.resultDigest):v.assetCount!==0||v.resultDigest!==null))fail();
 return Object.fromEntries(KEYS.map(k=>[k,['actor','scope'].includes(k)?{...v[k]}:v[k]]));
}
function fromActiveInventory(captured,input,requestId,reason,now,result=null){
 const [type,id]=captured.row.scope_key.split(':'),hash=v=>createHash('sha256').update(v).digest('hex'),attempt=reason==='inventory_requested';
 return metaActiveInventoryEvent({version:32,eventId:randomUUID(),correlationId:requestId,occurredAt:now.toISOString(),action:'integration.meta.active_asset_list',stage:attempt?'attempted':'completed',
  outcome:attempt?'unknown':result?'success':reason==='access_changed'?'denied':'error',reason,actor:{type:'user',id:String(input.actorId)},sessionRef:input.sessionRef,scope:{type,id},
  connectionRef:captured.row.connection_ref,enrollmentRef:captured.row.enrollment_id,credentialVersionRef:captured.effective.versionId,epoch:captured.effective.epoch,
  clinicCount:captured.row.clinicIds.length,clinicSetDigest:hash(captured.row.clinic_ids),assetCount:result?result.assets.length:0,resultDigest:result?hash(JSON.stringify(result)):null,capturePolicy:'meta-active-inventory-v1'});
}
module.exports={metaActiveInventoryEvent,fromActiveInventory};
