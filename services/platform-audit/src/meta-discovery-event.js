'use strict';
const {randomUUID,createHash}=require('node:crypto'),{UUID,fail}=require('./event'),{stamp}=require('./view-contract');
const {positive}=require('./google-property-disconnect-event');
const KEYS=['version','eventId','correlationId','occurredAt','action','stage','outcome','reason','actor','sessionRef','scope','provider','connectionRef','flowRef','candidateDigest','clinicCount','clinicSetDigest','assetCount','resultDigest','capturePolicy'];
const exact=(v,k)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===k.slice().sort().join(',');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function metaDiscoveryEvent(v){
  if(!exact(v,KEYS)||!exact(v.actor,['type','id'])||!exact(v.scope,['type','id'])||v.version!==23||!UUID.test(v.eventId)||!UUID.test(v.correlationId)||!UUID.test(v.flowRef)
    ||!stamp(v.occurredAt)||v.action!=='integration.meta.asset_list'||v.actor.type!=='user'||!positive(v.actor.id)||!UUID.test(v.sessionRef)
    ||!['clinic','group'].includes(v.scope.type)||!positive(v.scope.id)||v.provider!=='meta_marketing'||typeof v.connectionRef!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v.connectionRef)
    ||!hex(v.candidateDigest)||!hex(v.clinicSetDigest)||!Number.isInteger(v.clinicCount)||v.clinicCount<1||v.clinicCount>1000||v.scope.type==='clinic'&&v.clinicCount!==1
    ||!Number.isInteger(v.assetCount)||v.assetCount<0||v.assetCount>500||v.capturePolicy!=='meta-candidate-inventory-v1')fail();
  const phase={inventory_requested:['attempted','unknown'],inventory_verified:['completed','success'],access_changed:['completed','denied'],inventory_unavailable:['completed','error']}[v.reason];
  if(!phase||v.stage!==phase[0]||v.outcome!==phase[1]||(v.reason==='inventory_verified'?!hex(v.resultDigest):v.assetCount!==0||v.resultDigest!==null))fail();
  return Object.fromEntries(KEYS.map(k=>[k,['actor','scope'].includes(k)?{...v[k]}:v[k]]));
}
function fromDiscovery(row,input,requestId,reason,now,result=null){
  const [type,id]=row.scope_key.split(':'),metadata=JSON.parse(row.candidate_metadata),attempt=reason==='inventory_requested';
  const hash=value=>createHash('sha256').update(value).digest('hex');
  return metaDiscoveryEvent({version:23,eventId:randomUUID(),correlationId:requestId,occurredAt:now.toISOString(),action:'integration.meta.asset_list',stage:attempt?'attempted':'completed',
    outcome:attempt?'unknown':result?'success':reason==='access_changed'?'denied':'error',reason,actor:{type:'user',id:String(input.actorId)},sessionRef:input.sessionRef,scope:{type,id},
    provider:'meta_marketing',connectionRef:row.connection_ref,flowRef:row.flow_id,candidateDigest:metadata.digest,clinicCount:JSON.parse(row.clinic_ids).length,clinicSetDigest:hash(row.clinic_ids),
    assetCount:result?result.assets.length:0,resultDigest:result?hash(JSON.stringify(result)):null,capturePolicy:'meta-candidate-inventory-v1'});
}
module.exports={metaDiscoveryEvent,fromDiscovery};
