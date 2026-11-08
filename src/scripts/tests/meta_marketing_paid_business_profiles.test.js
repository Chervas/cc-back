'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{randomUUID}=require('node:crypto');
require('node:net').Socket.prototype.connect=()=>{throw Error('OFFLINE_NETWORK_FORBIDDEN');};
const C=require('../../services/metaMarketingBusiness.contract'),F=require('../../services/metaMarketingEffectiveCredential.service'),{configurationFrom}=require('../../services/metaMarketingBusiness.service');
const BASE=['ads_read','leads_retrieval','pages_manage_ads','pages_manage_metadata','pages_read_engagement','pages_show_list'];
function row(kind,profile){return {app_id:'101',config_id:kind==='BISU'?'1777':'1778',graph_version:'v27.0',issuer_kind:kind,issuer_business_id:kind==='BISU'?null:'901',scopes:JSON.stringify(C.scopesFor(kind,profile))};}
function metadata(kind,profile){return {appId:'101',subjectId:'601',tokenType:'SYSTEM_USER',...(kind==='BISU'?{clientBusinessId:'701'}:{issuerKind:kind,issuerBusinessId:'901',systemUserId:'601'}),configId:kind==='BISU'?'1777':'1778',graphVersion:'v27.0',scopes:[...C.scopesFor(kind,profile)],expiresAt:1893456000000,dataAccessExpiresAt:null,granularScopes:[]};}

test('server policy opts in per issuer and defaults to the exact legacy configuration object',()=>{
 const env={META_MARKETING_BUSINESS_SCOPE_MODES:'{"group:28":"BISU","group:29":"AGENCY_SYSTEM_USER"}',META_MARKETING_BUSINESS_CONFIG_ID:'1777',META_MARKETING_BUSINESS_GRAPH_VERSION:'v27.0',META_MARKETING_AGENCY_SETUP_CONFIG_ID:'1778',META_MARKETING_AGENCY_ISSUER_BUSINESS_ID:'901',META_MARKETING_AGENCY_GRAPH_VERSION:'v27.0'};
 assert.equal(Object.hasOwn(configurationFrom(env,'group:28'),'permissionProfile'),false);assert.equal(Object.hasOwn(configurationFrom(env,'group:29'),'permissionProfile'),false);
 assert.deepEqual(configurationFrom({...env,META_MARKETING_BUSINESS_PERMISSION_PROFILE:'paid-leads-v2'},'group:28'),{issuerKind:'BISU',issuerBusinessId:null,configId:'1777',graphVersion:'v27.0',permissionProfile:'paid-leads-v2'});
 assert.equal(configurationFrom({...env,META_MARKETING_AGENCY_PERMISSION_PROFILE:'paid-leads-v2'},'group:29').permissionProfile,'paid-leads-v2');
 for(const value of ['','paid','system_user','{"scopes":["ads_management"]}']){assert.equal(configurationFrom({...env,META_MARKETING_BUSINESS_PERMISSION_PROFILE:value},'group:28'),null);assert.equal(configurationFrom({...env,META_MARKETING_AGENCY_PERMISSION_PROFILE:value},'group:29'),null);}
 assert.equal(configurationFrom({...env,META_MARKETING_BUSINESS_PERMISSION_PROFILE:'paid-leads-v2'},'group:29').permissionProfile,undefined);
});

test('closed profiles preserve legacy digest inputs, distinguish paid scopes and reject arbitrary scope arrays',()=>{
 assert.deepEqual(C.scopesFor('AGENCY_SYSTEM_USER'),BASE);assert.deepEqual(C.scopesFor('BISU'),[BASE[0],'business_management',...BASE.slice(1)]);
 assert.deepEqual(C.policyDigestParts({issuerKind:'BISU'}),[]);assert.deepEqual(C.policyDigestParts({issuerKind:'AGENCY_SYSTEM_USER',permissionProfile:'legacy-v1'}),[]);
 for(const kind of C.ISSUERS){assert.equal(C.profileForScopes(kind,row(kind,'legacy-v1').scopes),'legacy-v1');assert.equal(C.profileForScopes(kind,row(kind,'paid-leads-v2').scopes),'paid-leads-v2');assert.equal(C.scopesFor(kind,'paid-leads-v2').includes('ads_management'),true);
  assert.deepEqual(C.policyDigestParts({issuerKind:kind,permissionProfile:'paid-leads-v2'}),['paid-leads-v2',C.scopesFor(kind,'paid-leads-v2')]);
  for(const scopes of [JSON.stringify([...C.scopesFor(kind),'whatsapp_business_messaging']),JSON.stringify([...C.scopesFor(kind,'paid-leads-v2')].reverse()),JSON.stringify(['ads_management']),undefined])assert.throws(()=>C.profileForScopes(kind,scopes));
 }
 for(const profile of [null,'','v2','USER'])assert.throws(()=>C.permissionProfile(profile));assert.throws(()=>C.scopesFor('USER','paid-leads-v2'));
});

for(const kind of C.ISSUERS)test(`${kind} API pin, receipt and effective candidate use the frozen profile, never extra provider permissions`,()=>{
 const old=row(kind,'legacy-v1'),paid=row(kind,'paid-leads-v2'),oldPin=C.pin(old),paidPin=C.pin(paid),value=metadata(kind,'paid-leads-v2');
 assert.equal(Object.hasOwn(oldPin,'cohort'),false);assert.equal(paidPin.cohort,kind==='BISU'?C.B.PAID_COHORT:C.A.PAID_COHORT);assert.deepEqual(C.metadata(value,paidPin),value);
 assert.throws(()=>C.metadata(value,oldPin));assert.throws(()=>C.metadata(metadata(kind,'legacy-v1'),paidPin));assert.throws(()=>C.metadata({...value,scopes:[...value.scopes,'whatsapp_business_messaging']},paidPin));
 assert.throws(()=>C.metadata({...value,tokenType:'USER'},paidPin));assert.throws(()=>C.metadata({...value,configId:'999'},paidPin));
 const candidate={versionId:randomUUID(),digest:'a'.repeat(64),...value},enrollment={app_id:'101',meta_user_id:'601',businessCredential:paidPin};
 assert.deepEqual(F.candidate(candidate,enrollment,value.scopes),candidate);assert.throws(()=>F.candidate(candidate,{...enrollment,businessCredential:oldPin},value.scopes));assert.throws(()=>F.candidate(candidate,enrollment,C.scopesFor(kind)));
 const id=candidate.versionId,receiptRow={...paid,handover_id:id,old_enrollment_id:randomUUID(),old_grant_digest:'b'.repeat(64),asset_set_digest:'c'.repeat(64)};
 const receipt={handoverId:id,flowId:id,newEnrollmentId:id,oldEnrollmentId:receiptRow.old_enrollment_id,status:'staged',oldGrantDigest:receiptRow.old_grant_digest,assetSetDigest:receiptRow.asset_set_digest,candidate:{versionId:id,digest:candidate.digest,metadata:value},newEnrollment:null,handoverApplied:false,drain:null};
 assert.deepEqual(C.receipt(receipt,receiptRow),receipt);assert.throws(()=>C.receipt(receipt,{...receiptRow,scopes:old.scopes}));
 assert.notEqual(C.sourceDigest({...receiptRow,candidate_metadata:JSON.stringify(candidate)}),C.sourceDigest({...receiptRow,scopes:old.scopes,candidate_metadata:JSON.stringify(candidate)}));
 // The old snapshot remains independently valid after a new target is defined.
 assert.deepEqual(C.metadata(metadata(kind,'legacy-v1'),oldPin),metadata(kind,'legacy-v1'));
});
