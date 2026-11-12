'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
const F=require('../../services/metaMarketingEffectiveCredential.service');
function fixture(){
 const at=new Date('2030-01-01T12:00:00Z'),id=randomUUID(),flowId=randomUUID(),digest='a'.repeat(64);
 const metadata={appId:'101',subjectId:'201',tokenType:'USER',scopes:['ads_read','public_profile'],expiresAt:+at+3600000,dataAccessExpiresAt:null,granularScopes:[]};
 const candidate={versionId:flowId,digest,...metadata},grant={enrollment_id:id,state:'active',flow_id:flowId,candidate_digest:digest,app_id:'101',meta_user_id:'201',scope_key:'group:29',clinic_ids:'[66,72]',meta_connection_id:172,actor_user_id:1,activated_at:at};
 const flow={flow_id:flowId,app_id:'101',scopes:JSON.stringify(metadata.scopes),candidate_metadata:JSON.stringify(candidate)};
 const pointer={enrollment_id:id,renewal_id:null,epoch:0,version_id:flowId,candidate_digest:digest,candidate_metadata:JSON.stringify(candidate),owner_receipt_digest:null,activated_at:at,last_error:'credential_revoked',last_error_at:new Date(+at-1000)};
 const state={evidence:null,changed:1,transactions:0,updates:[],grant,pointer};
 const models={MetaMarketingEnrollmentRequest:{findByPk:async()=>state.grant},MetaMarketingOAuthRequest:{findByPk:async()=>flow},
  MetaMarketingCredentialMaintenance:{findOne:async()=>state.evidence&&{health_metadata:JSON.stringify(state.evidence)}},
  MetaMarketingEffectiveCredential:{findByPk:async()=>state.pointer,update:async(patch,options)=>{state.updates.push(options);if(state.changed===1)Object.assign(pointer,patch);return[state.changed];}},
  sequelize:{transaction:async(_opts,work)=>{state.transactions++;return work({LOCK:{UPDATE:'UPDATE'}});}}};
 return{at,id,flowId,digest,metadata,state,grant,flow,api:F.createEffectiveCredentials({models,now:()=>at})};
}
function evidence(f,values={}){return{enrollmentId:f.id,epoch:0,versionId:f.flowId,digest:f.digest,verifiedAt:+f.at,expiresAt:+f.at+1800000,dataAccessExpiresAt:null,healthy:true,reason:null,...values};}
test('sequential USER health observations keep the earlier finite deadline through later dates, null and denial',async()=>{
 const f=fixture(),{boundedObservation}=require('../../lib/metaMarketingUserHealth');f.state.pointer.last_error=null;
 async function save(observed){const current=await f.api.resolve(f.grant,f.flow,null,{allowExpired:true});f.state.evidence=boundedObservation(observed,current.metadata);}
 const floor=+f.at+1800000;await save(evidence(f));assert.equal((await f.api.resolve(f.grant,f.flow)).metadata.expiresAt,floor);
 await save(evidence(f,{expiresAt:+f.at+7200000}));assert.equal((await f.api.resolve(f.grant,f.flow)).metadata.expiresAt,floor);
 await save(evidence(f,{expiresAt:null}));assert.equal((await f.api.resolve(f.grant,f.flow)).metadata.expiresAt,floor);
 await save(evidence(f,{expiresAt:null,healthy:false,reason:'permissions_lost'}));assert.equal((await f.api.resolve(f.grant,f.flow)).metadata.expiresAt,floor);
 f.at.setTime(+f.at+1801000);await save(evidence(f,{expiresAt:+f.at+7200000}));
 assert.equal(f.state.evidence.reason,'credential_expired');assert.equal(f.state.evidence.healthy,false);
 await assert.rejects(f.api.resolve(f.grant,f.flow),{code:'meta_credential_renewal_required'});
});
test('observed expiry is distinct from revocation and never permits a data read',async()=>{
 const f=fixture();f.state.evidence=evidence(f,{expiresAt:+f.at-1000,healthy:false,reason:'credential_expired'});
 await assert.rejects(f.api.resolve(f.grant,f.flow),{code:'meta_credential_renewal_required'});
 const status=await f.api.getCredentialStatus(f.grant);assert.equal(status.healthKind,'expired');assert.equal(status.requiresRenewal,true);assert.equal(status.expired,true);
});
test('a verified current health observation shares its caller transaction and updates the exact digest CAS',async()=>{
 const f=fixture(),transaction={LOCK:{UPDATE:'UPDATE'}};
 assert.equal(await f.api.recordHealthy({enrollmentId:f.id,epoch:0,versionId:f.flowId},evidence(f),{transaction}),true);
 assert.equal(f.state.transactions,0);assert.equal(f.state.pointer.last_error,null);assert.equal(f.state.updates[0].transaction,transaction);assert.equal(f.state.updates[0].where.candidate_digest,f.digest);
});
test('failed CAS, wrong digest, stale observation and retired enrollment cannot clear a failure',async()=>{
 for(const kind of['cas','digest','stale','retired']){
  const f=fixture(),value=evidence(f);if(kind==='cas')f.state.changed=0;if(kind==='digest')value.digest='b'.repeat(64);if(kind==='stale')value.verifiedAt=+f.at-61000;if(kind==='retired')f.state.grant.state='revoked';
  let changed;try{changed=await f.api.recordHealthy({enrollmentId:f.id,epoch:0,versionId:f.flowId},value);}catch(error){assert.equal(kind,'retired');}
  assert.notEqual(changed,true);assert.equal(f.state.pointer.last_error,'credential_revoked');
 }
});
test('an unrelated or stale epoch health proof cannot project its dates into USER status',async()=>{
 const f=fixture();f.state.evidence=evidence(f,{epoch:1});await assert.rejects(f.api.getCredentialStatus(f.grant),{code:'meta_credential_version_invalid'});
});


test('zero changed rows is accepted only for the exact already-applied healthy state under the same pin',async()=>{
 const f=fixture();f.state.pointer.last_error=null;f.state.pointer.last_error_at=null;f.state.pointer.unknown_since=null;f.state.pointer.last_healthy_at=f.at;
 f.state.changed=0;assert.equal(await f.api.recordHealthy({enrollmentId:f.id,epoch:0,versionId:f.flowId},evidence(f)),true);
 f.state.pointer.last_healthy_at=new Date(+f.at-1);assert.equal(await f.api.recordHealthy({enrollmentId:f.id,epoch:0,versionId:f.flowId},evidence(f)),false);
});
