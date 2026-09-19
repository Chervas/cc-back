'use strict';
const {randomUUID,createHash}=require('node:crypto'),{UUID,fail}=require('./event'),{stamp}=require('./view-contract');
const {positive}=require('./google-property-disconnect-event');
const PHASES=Object.freeze({meta_enrollment_requested:['prepare_pending',1,'user'],meta_enrollment_prepared:['prepared',2,'job'],
  meta_enrollment_activation_requested:['activate_pending',3,'user'],meta_enrollment_activated:['active',4,'job'],
  meta_enrollment_cancel_requested:['revoke_pending',5,'either'],meta_enrollment_cancelled:['revoked',6,'job']});
const KEYS=['version','eventId','correlationId','occurredAt','action','stage','outcome','reason','actor','subjectUserId','sessionRef','scope',
  'provider','connectionRef','requestRef','flowRef','state','clinicCount','clinicSetDigest','assetCount','assetSetDigest','candidateDigest','selectionDigest','capturePolicy'];
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===keys.slice().sort().join(',');
const hex=v=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
function metaEnrollmentEvent(v){
  const phase=Object.hasOwn(PHASES,v?.reason)?PHASES[v.reason]:null;
  if(!exact(v,KEYS)||!exact(v.actor,['type','id'])||!exact(v.scope,['type','id'])||!phase||v.version!==24
    ||![v.eventId,v.correlationId,v.requestRef,v.flowRef].every(id=>typeof id==='string'&&UUID.test(id))||v.correlationId!==v.requestRef
    ||!stamp(v.occurredAt)||v.action!=='integration.meta.enrollment'||v.stage!=='completed'||v.outcome!=='success'||v.state!==phase[0]
    ||!positive(v.subjectUserId)||!['clinic','group'].includes(v.scope.type)||!positive(v.scope.id)||v.provider!=='meta_marketing'
    ||typeof v.connectionRef!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v.connectionRef)
    ||!Number.isInteger(v.clinicCount)||v.clinicCount<1||v.clinicCount>1000||v.scope.type==='clinic'&&v.clinicCount!==1
    ||!Number.isInteger(v.assetCount)||v.assetCount<1||v.assetCount>100||![v.clinicSetDigest,v.assetSetDigest,v.candidateDigest].every(hex)
    ||v.selectionDigest!==null&&!hex(v.selectionDigest)||['prepared','activate_pending','active'].includes(v.state)&&!hex(v.selectionDigest)
    ||v.state==='prepare_pending'&&v.selectionDigest!==null||v.capturePolicy!=='meta-enrollment-durable-v1')fail();
  if(v.actor.type==='user'){
    if(!positive(v.actor.id)||!UUID.test(v.sessionRef)||phase[2]==='job'||phase[2]==='user'&&v.actor.id!==v.subjectUserId)fail();
  }else if(v.actor.type!=='job'||v.actor.id!=='meta_marketing_enrollment_worker'||v.sessionRef!==null||phase[2]==='user')fail();
  return Object.fromEntries(KEYS.map(k=>[k,['actor','scope'].includes(k)?{...v[k]}:v[k]]));
}
function fromEnrollment(row,reason,{now,actorId,sessionRef}={}){
  const phase=PHASES[reason],human=phase?.[2]==='user'||actorId!==undefined,[type,id]=row.scope_key.split(':');
  const hash=v=>createHash('sha256').update(v).digest('hex');
  return metaEnrollmentEvent({version:24,eventId:randomUUID(),correlationId:row.enrollment_id,occurredAt:now.toISOString(),
    action:'integration.meta.enrollment',stage:'completed',outcome:'success',reason,
    actor:human?{type:'user',id:String(actorId??row.actor_user_id)}:{type:'job',id:'meta_marketing_enrollment_worker'},
    subjectUserId:String(row.actor_user_id),sessionRef:human?(sessionRef??row.session_ref):null,scope:{type,id},provider:'meta_marketing',connectionRef:row.connection_ref,
    requestRef:row.enrollment_id,flowRef:row.flow_id,state:phase?.[0],clinicCount:JSON.parse(row.clinic_ids).length,clinicSetDigest:hash(row.clinic_ids),
    assetCount:JSON.parse(row.assets).length,assetSetDigest:hash(row.assets),candidateDigest:row.candidate_digest,selectionDigest:row.selection_digest,capturePolicy:'meta-enrollment-durable-v1'});
}
module.exports={PHASES,metaEnrollmentEvent,fromEnrollment};
