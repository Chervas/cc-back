'use strict';
const {randomUUID,createHash}=require('node:crypto'),{UUID,fail}=require('./event'),{stamp}=require('./view-contract');
const PHASES=Object.freeze({meta_credential_renewal_requested:[1,'user'],meta_credential_candidate_staged:[2,'job'],
  meta_credential_renewal_activation_requested:[3,'user'],meta_credential_renewal_activated:[4,'job'],
  meta_credential_renewal_cancel_requested:[5,'either'],meta_credential_renewal_cancelled:[6,'job'],meta_credential_renewal_rejected:[7,'job']});
const KEYS=['version','eventId','correlationId','occurredAt','action','stage','outcome','reason','actor','subjectUserId','sessionRef','scope',
  'requestRef','enrollmentRef','previousCredentialVersionRef','credentialVersionRef','epoch','clinicCount','clinicSetDigest','assetCount','assetSetDigest','capturePolicy'];
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
const positive=value=>typeof value==='string'&&/^[1-9][0-9]{0,9}$/.test(value),hash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function metaCredentialRenewalEvent(value){
  const phase=PHASES[value?.reason];
  if(!phase||!exact(value,KEYS)||value.version!==28||!exact(value.actor,['type','id'])||!exact(value.scope,['type','id'])
    ||![value.eventId,value.correlationId,value.requestRef,value.enrollmentRef,value.previousCredentialVersionRef].every(id=>UUID.test(id||''))
    ||value.credentialVersionRef!==null&&(!UUID.test(value.credentialVersionRef)||value.credentialVersionRef!==value.requestRef)||value.correlationId!==value.requestRef||!stamp(value.occurredAt)
    ||value.action!=='integration.meta.credential_renewal'||value.stage!=='completed'||value.outcome!==(phase[0]===7?'denied':'success')
    ||!positive(value.subjectUserId)||!['clinic','group'].includes(value.scope.type)||!positive(value.scope.id)||value.scope.type==='clinic'&&value.clinicCount!==1
    ||!Number.isSafeInteger(value.epoch)||value.epoch<0||!Number.isInteger(value.clinicCount)||value.clinicCount<1||value.clinicCount>1000
    ||!Number.isInteger(value.assetCount)||value.assetCount<1||value.assetCount>100||![value.clinicSetDigest,value.assetSetDigest].every(hash)
    ||value.capturePolicy!=='meta-credential-renewal-durable-v1')fail();
  if(value.actor.type==='user'){
    if(!positive(value.actor.id)||value.actor.id!==value.subjectUserId||!UUID.test(value.sessionRef||'')||phase[1]==='job')fail();
  }else if(value.actor.type!=='job'||value.actor.id!=='meta_marketing_credential_renewal_worker'||value.sessionRef!==null||phase[1]==='user')fail();
  return Object.fromEntries(KEYS.map(key=>[key,['actor','scope'].includes(key)?{...value[key]}:value[key]]));
}
function fromRenewal(row,reason,{now=new Date(),actorId,sessionRef}={}){
  const phase=PHASES[reason];if(!phase)fail();const human=phase[1]==='user'||actorId!==undefined,[type,id]=row.scope_key.split(':');
  let candidate;try{candidate=row.candidate_metadata?JSON.parse(row.candidate_metadata):null;}catch{fail();}
  return metaCredentialRenewalEvent({version:28,eventId:randomUUID(),correlationId:row.renewal_id,occurredAt:now.toISOString(),action:'integration.meta.credential_renewal',
    stage:'completed',outcome:phase[0]===7?'denied':'success',reason,actor:human?{type:'user',id:String(actorId??row.actor_user_id)}:{type:'job',id:'meta_marketing_credential_renewal_worker'},
    subjectUserId:String(row.actor_user_id),sessionRef:human?(sessionRef??row.session_ref):null,scope:{type,id},requestRef:row.renewal_id,enrollmentRef:row.enrollment_id,
    previousCredentialVersionRef:row.expected_version_id,credentialVersionRef:candidate?.versionId??null,epoch:Number(row.expected_epoch)+(row.state==='active'?1:0),
    clinicCount:JSON.parse(row.clinic_ids).length,clinicSetDigest:createHash('sha256').update(row.clinic_ids).digest('hex'),assetCount:JSON.parse(row.assets).length,
    assetSetDigest:row.asset_set_digest,capturePolicy:'meta-credential-renewal-durable-v1'});
}
module.exports={PHASES,metaCredentialRenewalEvent,fromRenewal};
