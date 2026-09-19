'use strict';
const {randomUUID,createHash}=require('node:crypto'),{UUID,fail}=require('./event'),{stamp}=require('./view-contract');
const {positive}=require('./google-property-disconnect-event');
const keys=['version','eventId','correlationId','occurredAt','action','stage','outcome','reason','actor','subjectUserId','sessionRef','scope',
  'provider','connectionRef','assetRef','clinicCount','clinicSetDigest','capturePolicy'];
const exact=(v,k)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Object.keys(v).sort().join(',')===k.slice().sort().join(',');
const PHASES=Object.freeze({authorization_requested:0,credentials_staged:0,authorization_cancel_requested:1,authorization_cancelled:1});
const reasons=Object.keys(PHASES);
function metaOAuthEvent(v){
  if(!exact(v,keys)||!exact(v.actor,['type','id'])||!exact(v.scope,['type','id'])||v.version!==22||!UUID.test(v.eventId)||!UUID.test(v.correlationId)
    ||!stamp(v.occurredAt)||v.action!=='integration.oauth.authorize'||!reasons.includes(v.reason)||!positive(v.subjectUserId)
    ||!['clinic','group'].includes(v.scope.type)||!positive(v.scope.id)||v.provider!=='meta_marketing'
    ||v.assetRef!==`meta-enroll:${v.scope.type}:${v.scope.id}`||typeof v.connectionRef!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v.connectionRef)
    ||!Number.isInteger(v.clinicCount)||v.clinicCount<1||v.clinicCount>1000||v.scope.type==='clinic'&&v.clinicCount!==1
    ||!/^[a-f0-9]{64}$/.test(v.clinicSetDigest)||v.capturePolicy!=='meta-oauth-candidate-v1')fail();
  const requested=v.reason.endsWith('_requested');
  if(v.stage!==(requested?'attempted':'completed')||v.outcome!==(requested?'unknown':v.reason==='credentials_staged'?'success':'denied'))fail();
  if(v.actor.type==='user'){if(v.actor.id!==v.subjectUserId||!UUID.test(v.sessionRef))fail();}
  else if(v.actor.type!=='job'||v.actor.id!=='meta_marketing_oauth_worker'||v.sessionRef!==null||v.reason==='authorization_requested')fail();
  return Object.fromEntries(keys.map(k=>[k,['actor','scope'].includes(k)?{...v[k]}:v[k]]));
}
function fromFlow(row,reason,now,worker=false){
  const [type,id]=row.scope_key.split(':'),clinics=JSON.parse(row.clinic_ids);
  return metaOAuthEvent({version:22,eventId:randomUUID(),correlationId:row.flow_id,occurredAt:now.toISOString(),action:'integration.oauth.authorize',
    stage:reason.endsWith('_requested')?'attempted':'completed',outcome:reason.endsWith('_requested')?'unknown':reason==='credentials_staged'?'success':'denied',reason,
    actor:worker?{type:'job',id:'meta_marketing_oauth_worker'}:{type:'user',id:String(row.actor_user_id)},subjectUserId:String(row.actor_user_id),sessionRef:worker?null:row.session_ref,
    scope:{type,id},provider:'meta_marketing',connectionRef:row.connection_ref,assetRef:row.asset_ref,clinicCount:clinics.length,
    clinicSetDigest:createHash('sha256').update(row.clinic_ids).digest('hex'),capturePolicy:'meta-oauth-candidate-v1'});
}
module.exports={metaOAuthEvent,fromFlow,PHASES};
