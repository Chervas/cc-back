'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
require('node:net').Socket.prototype.connect=()=>{throw Error('OFFLINE_NETWORK_FORBIDDEN');};
const C=require('../../services/metaMarketingBusiness.contract'),{configurationFrom}=require('../../services/metaMarketingBusiness.service');
test('scope modes are explicit server policy with no issuer fallback or cross-scope default',()=>{
  const env={META_MARKETING_BUSINESS_SCOPE_MODES:JSON.stringify({'group:28':'BISU','group:29':'AGENCY_SYSTEM_USER'}),META_MARKETING_BUSINESS_CONFIG_ID:'111',META_MARKETING_BUSINESS_GRAPH_VERSION:'v27.0',META_MARKETING_AGENCY_SETUP_CONFIG_ID:'222',META_MARKETING_AGENCY_ISSUER_BUSINESS_ID:'348',META_MARKETING_AGENCY_GRAPH_VERSION:'v27.0'};
  assert.deepEqual(configurationFrom(env,'group:28'),{issuerKind:'BISU',issuerBusinessId:null,configId:'111',graphVersion:'v27.0'});
  assert.deepEqual(configurationFrom(env,'group:29'),{issuerKind:'AGENCY_SYSTEM_USER',issuerBusinessId:'348',configId:'222',graphVersion:'v27.0'});
  assert.equal(configurationFrom(env,'group:30'),null);assert.equal(configurationFrom({...env,META_MARKETING_BUSINESS_SCOPE_MODES:undefined},'group:29'),null);
  assert.equal(configurationFrom({...env,META_MARKETING_BUSINESS_SCOPE_MODES:'{"group:29":"USER"}'},'group:29'),null);
});
test('agency credentials are a separate issuer with finite expiry, six working permissions and no fabricated client business',()=>{
  const pin={issuerKind:'AGENCY_SYSTEM_USER',issuerBusinessId:'348',appId:'101',configId:'222',graphVersion:'v27.0'},value={appId:'101',subjectId:'829',tokenType:'SYSTEM_USER',issuerKind:'AGENCY_SYSTEM_USER',issuerBusinessId:'348',systemUserId:'829',configId:'222',graphVersion:'v27.0',scopes:[...C.A.SCOPES],expiresAt:1893456000000,dataAccessExpiresAt:null,granularScopes:[]};
  assert.deepEqual(C.metadata(value,pin),value);assert.equal(C.candidate({versionId:randomUUID(),digest:'a'.repeat(64),...value},pin).issuerKind,'AGENCY_SYSTEM_USER');
  for(const change of[v=>v.clientBusinessId='348',v=>v.issuerBusinessId='999',v=>v.systemUserId='830',v=>v.scopes=[...C.A.SETUP_SCOPES],v=>v.expiresAt=null,v=>v.configId='111',v=>v.graphVersion='v24.0']){
    const bad=structuredClone(value);change(bad);assert.throws(()=>C.metadata(bad,pin));
  }
  const bisu={appId:'101',subjectId:'828',tokenType:'SYSTEM_USER',clientBusinessId:'928',configId:'111',graphVersion:'v27.0',scopes:[...C.B.SCOPES],expiresAt:1893456000000,dataAccessExpiresAt:null,granularScopes:[]};
  assert.throws(()=>C.metadata(bisu,pin),{code:'meta_business_identity_mismatch'});
  assert.throws(()=>C.metadata(value,{issuerKind:'BISU',issuerBusinessId:null,appId:'101',configId:'111',graphVersion:'v27.0'}),{code:'meta_business_identity_mismatch'});
});
test('the actual Business route accepts only the observed issuer-specific five-field confirmation',async()=>{
  const calls=[],id=randomUUID(),claims={sessionVersion:1,jti:randomUUID(),userId:99,exp:1893456000};
  const service={confirm:async(...args)=>{calls.push(args);return {ok:true};}},router=require('../../routes/metaMarketingBusiness.routes').createRouter({sessions:{verify:async()=>claims},service});
  const layer=router.stack.find(value=>value.route?.path==='/business-connection/:id/confirmation').route.stack[0].handle;
  const body={candidateDigest:'a'.repeat(64),issuerKind:'AGENCY_SYSTEM_USER',providerBusinessId:'348',clientBusinessId:null,subjectId:'829'};
  async function invoke(value){const result={status:200};const res={set:()=>{},status:code=>{result.status=code;return res;},json:value=>{result.value=value;return result;}};await layer({headers:{authorization:'Bearer FICTITIOUS_ACCESS_TOKEN'},query:{assignment_scope:'group',group_id:'29'},params:{id},body:value},res);return result;}
  assert.equal((await invoke(body)).status,200);assert.equal(calls[0][0].actorId,99);assert.deepEqual(calls[0][2],body);
  for(const bad of[{...body,clientBusinessId:'348'},{...body,providerBusinessId:null},{...body,issuerKind:'BISU'},{candidateDigest:body.candidateDigest,clientBusinessId:'928',subjectId:'828'}])assert.equal((await invoke(bad)).status,400);
  assert.equal(calls.length,1);
  service.confirm=async()=>{throw Object.assign(Error('meta_business_session_required'),{code:'meta_business_session_required',httpStatus:409});};
  assert.deepEqual(await invoke(body),{status:409,value:{success:false,error:'meta_business_session_required'}});
});
test('the real owner drain digest binds handover and immutable old grant in both SQL validators',()=>{
  const handoverId=randomUUID(),oldEnrollmentId=randomUUID(),oldGrantDigest='a'.repeat(64),refs=[randomUUID(),randomUUID()].sort();
  const digest=C.B.drainDigest(handoverId,oldGrantDigest,refs),drain={closed:true,receiptRefs:refs,receiptSetDigest:digest,activeOperations:0};
  const metadata={appId:'101',subjectId:'828',tokenType:'SYSTEM_USER',clientBusinessId:'928',configId:'111',graphVersion:'v27.0',scopes:[...C.B.SCOPES],expiresAt:1893456000000,dataAccessExpiresAt:null,granularScopes:[]};
  const row={handover_id:handoverId,old_enrollment_id:oldEnrollmentId,old_grant_digest:oldGrantDigest,asset_set_digest:'b'.repeat(64),app_id:'101',config_id:'111',graph_version:'v27.0',issuer_kind:'BISU',issuer_business_id:null};
  const receipt={handoverId,flowId:handoverId,newEnrollmentId:handoverId,oldEnrollmentId,status:'staged',oldGrantDigest,assetSetDigest:row.asset_set_digest,candidate:{versionId:handoverId,digest:'c'.repeat(64),metadata},newEnrollment:null,handoverApplied:false,drain};
  const ownerProof=require('../../services/metaMarketingBusinessDrain.service').ownerProof;
  assert.equal(C.receipt(receipt,row).drain.receiptSetDigest,digest);assert.equal(ownerProof(drain,handoverId,oldGrantDigest).digest,digest);
  for(const wrong of[C.hash(JSON.stringify(refs)),C.B.drainDigest(randomUUID(),oldGrantDigest,refs),C.B.drainDigest(handoverId,'d'.repeat(64),refs)]){
    assert.throws(()=>C.receipt({...receipt,drain:{...drain,receiptSetDigest:wrong}},row));assert.throws(()=>ownerProof({...drain,receiptSetDigest:wrong},handoverId,oldGrantDigest));
  }
});
