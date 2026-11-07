'use strict';
const {randomUUID,createHash}=require('node:crypto'),{UUID,fail}=require('./event'),{stamp}=require('./view-contract');
const PHASES=Object.freeze({meta_business_requested:[29,1,'user'],meta_business_staged:[29,2,'job'],meta_business_activation_requested:[29,3,'user'],meta_business_activated:[29,4,'job'],meta_business_cancel_requested:[29,5,'either'],meta_business_cancelled:[29,6,'job'],meta_business_rejected:[29,7,'job'],meta_maintenance_requested:[30,1,'job'],meta_maintenance_activated:[30,2,'job'],meta_maintenance_rejected:[30,3,'job']});
const KEYS=['version','eventId','correlationId','occurredAt','action','stage','outcome','reason','actor','subjectUserId','sessionRef','scope','requestRef','previousEnrollmentRef','enrollmentRef','previousCredentialVersionRef','credentialVersionRef','epoch','clinicCount','clinicSetDigest','assetCount','assetSetDigest','capturePolicy'];
const hash=value=>createHash('sha256').update(value).digest('hex'),positive=value=>typeof value==='string'&&/^[1-9][0-9]{0,9}$/.test(value),digest=value=>/^[a-f0-9]{64}$/.test(value||'');
const exact=(value,keys)=>value&&Object.getPrototypeOf(value)===Object.prototype&&Object.keys(value).sort().join(',')===keys.slice().sort().join(',');
function metaBusinessContinuityEvent(value){
  const phase=PHASES[value?.reason],business=value?.version===29;
  if(!phase||phase[0]!==value.version||!exact(value,KEYS)||!exact(value.actor,['type','id'])||!exact(value.scope,['type','id'])||!stamp(value.occurredAt)
    ||![value.eventId,value.correlationId,value.requestRef,value.previousEnrollmentRef,value.enrollmentRef,value.previousCredentialVersionRef].every(id=>UUID.test(id||''))
    ||value.correlationId!==value.requestRef||value.credentialVersionRef!==null&&(!UUID.test(value.credentialVersionRef)||value.credentialVersionRef!==value.requestRef)
    ||value.action!==(business?'integration.meta.business_handover':'integration.meta.credential_maintenance')||value.stage!=='completed'
    ||value.outcome!==(['meta_business_rejected','meta_maintenance_rejected'].includes(value.reason)?'denied':'success')||!positive(value.subjectUserId)
    ||!['clinic','group'].includes(value.scope.type)||!positive(value.scope.id)||!Number.isInteger(value.clinicCount)||value.clinicCount<1||value.clinicCount>1000||value.scope.type==='clinic'&&value.clinicCount!==1
    ||!Number.isInteger(value.assetCount)||value.assetCount<1||value.assetCount>100||!Number.isSafeInteger(value.epoch)||value.epoch<0||![value.clinicSetDigest,value.assetSetDigest].every(digest)
    ||value.capturePolicy!=='meta-business-continuity-durable-v1')fail();
  if(value.actor.type==='user'){if(phase[2]==='job'||!positive(value.actor.id)||value.actor.id!==value.subjectUserId||!UUID.test(value.sessionRef||''))fail();}
  else if(value.actor.type!=='job'||phase[2]==='user'||value.actor.id!==(business?'meta_marketing_business_worker':'meta_marketing_credential_maintenance_worker')||value.sessionRef!==null)fail();
  return Object.fromEntries(KEYS.map(key=>[key,['scope','actor'].includes(key)?{...value[key]}:value[key]]));
}
function build(row,enrollment,reason,{now=new Date(),actorId,sessionRef}={}){
  const phase=PHASES[reason];if(!phase)fail();const business=phase[0]===29,human=phase[2]==='user'||actorId!==undefined,[type,id]=enrollment.scope_key.split(':'),request=business?row.handover_id:row.maintenance_id;
  let candidate;try{candidate=row.candidate_metadata?JSON.parse(row.candidate_metadata):null;}catch{fail();}
  const identity=require('../../integrations-broker/src/meta-marketing-enrollment-contract').identity;
  return metaBusinessContinuityEvent({version:phase[0],eventId:randomUUID(),correlationId:request,occurredAt:now.toISOString(),action:business?'integration.meta.business_handover':'integration.meta.credential_maintenance',stage:'completed',outcome:reason.endsWith('_rejected')?'denied':'success',reason,
    actor:human?{type:'user',id:String(actorId??enrollment.actor_user_id)}:{type:'job',id:business?'meta_marketing_business_worker':'meta_marketing_credential_maintenance_worker'},subjectUserId:String(enrollment.actor_user_id),sessionRef:human?(sessionRef??enrollment.session_ref):null,scope:{type,id},requestRef:request,
    previousEnrollmentRef:business?row.old_enrollment_id:enrollment.enrollment_id,enrollmentRef:business?row.new_enrollment_id:enrollment.enrollment_id,previousCredentialVersionRef:row.expected_version_id,credentialVersionRef:candidate?.versionId??null,
    epoch:business&&row.state==='active'?0:Number(row.expected_epoch)+(row.state==='succeeded'?1:0),clinicCount:JSON.parse(enrollment.clinic_ids).length,clinicSetDigest:hash(enrollment.clinic_ids),assetCount:JSON.parse(enrollment.assets).length,
    assetSetDigest:hash(JSON.stringify(JSON.parse(enrollment.assets).map(identity))),capturePolicy:'meta-business-continuity-durable-v1'});
}
const fromHandover=(row,reason,input)=>build(row,{...row,enrollment_id:row.new_enrollment_id},reason,input);
module.exports={PHASES,metaBusinessContinuityEvent,fromHandover,fromMaintenance:build};
