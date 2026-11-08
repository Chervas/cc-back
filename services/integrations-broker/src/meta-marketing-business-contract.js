'use strict';
const {schema}=require('./contracts'),{fail}=require('./errors');
const C=require('./meta-marketing-oauth-contract'),M=require('./meta-marketing-contract');
const COHORT='meta-marketing-business-v1';
const SCOPES=Object.freeze(['ads_read','business_management','leads_retrieval','pages_manage_ads','pages_manage_metadata','pages_read_engagement','pages_show_list']);
const PAID_COHORT='meta-marketing-business-paid-leads-v2';
const PAID_SCOPES=Object.freeze(['ads_management',...SCOPES]);
function scopesForCohort(cohort=COHORT){if(cohort===COHORT)return SCOPES;if(cohort===PAID_COHORT)return PAID_SCOPES;fail('invalid_request');}
const OPERATIONS=Object.freeze(Object.fromEntries(['begin','finish','status','drain','activate','abort'].map(n=>[n,`meta.marketing.business.${n}.v1`])));
const STATES=Object.freeze(['awaiting','processing','staged','active','aborted','rejected','interrupted','not_found']);
const uuid={type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'},digest={type:'string',pattern:'^[a-f0-9]{64}$'},epoch={type:'integer',minimum:0,maximum:Number.MAX_SAFE_INTEGER-1};
const old={oldEnrollmentId:uuid,expectedEpoch:epoch,expectedVersionId:uuid,expectedCandidateDigest:digest};
const validators={begin:schema({handoverId:uuid,flowId:uuid,newEnrollmentId:uuid,...old,assetSetDigest:digest,oldScopeDigest:digest,scopeDigest:digest,clinicSetDigest:digest,state:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'},expiresAt:{type:'integer',minimum:1,maximum:Number.MAX_SAFE_INTEGER}}),
 finish:schema({handoverId:uuid,flowId:uuid,state:{type:'string',pattern:'^[A-Za-z0-9_-]{43}$'},code:{type:'string',pattern:'^[\\x21-\\x7e]{1,4096}$'}}),status:schema({handoverId:uuid}),drain:schema({handoverId:uuid}),abort:schema({handoverId:uuid}),
 activate:schema({handoverId:uuid,...old,newEnrollmentId:uuid,oldGrantDigest:digest,candidateVersionId:uuid,candidateDigest:digest,drainDigest:digest})};
const bindings=new WeakMap();
function config(value){
 if(!C.exact(value,'enabled,cohort,configId,graphVersion,providerBusinessId,scopeKeys')||typeof value.enabled!=='boolean'||![COHORT,PAID_COHORT].includes(value.cohort)
  ||!M.graphId(value.configId)||!M.graphId(value.providerBusinessId)||!/^v(?:24|25|26|27)\.0$/.test(value.graphVersion)
  ||!Array.isArray(value.scopeKeys)||!value.scopeKeys.length||value.scopeKeys.length>64||new Set(value.scopeKeys).size!==value.scopeKeys.length
  ||value.scopeKeys.some(v=>!/^(clinic|group):[1-9][0-9]{0,9}$/.test(v)))fail('invalid_request');return value;
}
function derive(base,value,assets=null){const c=config(value),b=C.bindingFor(base);if(!c.scopeKeys.includes(b.scopeKey))fail('scope_denied');
 const binding={...base,metaMarketingOAuth:{...b,scopes:[...scopesForCohort(c.cohort)]}};const targets=assets===null?null:require('./meta-marketing-enrollment-contract').assets(assets).flatMap(a=>[a.id,...(a.parentPageId?[a.parentPageId]:[])]);bindings.set(binding,{base,config:structuredClone(c),targets,assetRefs:assets===null?null:assets.map(a=>a.assetRef)});return binding;}
const isBinding=b=>bindings.has(b);
const baseBinding=b=>bindings.get(b)?.base||b;
function bindingFor(binding){const info=bindings.get(binding);if(!info)fail('invalid_request');const base=C.bindingFor(info.base);return {...base,scopes:[...scopesForCohort(info.config.cohort)],businessLogin:info.config,credentialTargets:info.targets,credentialAssetRefs:info.assetRefs};}
function fingerprint(binding){const info=bindings.get(binding),b=bindingFor(binding);return C.hash(JSON.stringify([C.fingerprint(info.base),b.businessLogin.cohort,b.businessLogin.configId,b.businessLogin.graphVersion,b.businessLogin.providerBusinessId,scopesForCohort(b.businessLogin.cohort)]));}
function validateMetadata(value,expected){const b={appId:expected.appId},c=expected,scopes=scopesForCohort(expected.cohort);
 if(!M.graphId(b.appId)||!M.graphId(c.configId)||!/^v(?:24|25|26|27)\.0$/.test(c.graphVersion))fail('invalid_request');
 if(!C.exact(value,'appId,subjectId,tokenType,clientBusinessId,configId,graphVersion,scopes,expiresAt,dataAccessExpiresAt,granularScopes')
  ||value.appId!==b.appId||!M.graphId(value.subjectId)||value.tokenType!=='SYSTEM_USER'||!M.graphId(value.clientBusinessId)||value.clientBusinessId===c.providerBusinessId
  ||value.configId!==c.configId||value.graphVersion!==c.graphVersion||JSON.stringify(value.scopes)!==JSON.stringify(scopes)
  ||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=0||value.dataAccessExpiresAt!==null&&(!Number.isSafeInteger(value.dataAccessExpiresAt)||value.dataAccessExpiresAt<=0)
  ||!Array.isArray(value.granularScopes)||value.granularScopes.length>scopes.length||value.granularScopes.some((v,i,all)=>!C.exact(v,'scope,targetIds')||!scopes.includes(v.scope)
   ||i>0&&v.scope<=all[i-1].scope||!Array.isArray(v.targetIds)||v.targetIds.length>1000||v.targetIds.some((id,j,ids)=>!M.graphId(id)||j>0&&id<=ids[j-1])))fail('oauth_credentials_incomplete');
 const management=value.granularScopes.find(row=>row.scope==='business_management');if(management&&!management.targetIds.includes(value.clientBusinessId)){const error=new (require('./errors').BrokerError)('oauth_credentials_incomplete');Object.defineProperty(error,'credentialValidationReason',{value:'business_management_denied'});throw error;}
 if(expected.subjectId!==undefined&&value.subjectId!==expected.subjectId||expected.clientBusinessId!==undefined&&value.clientBusinessId!==expected.clientBusinessId)fail('oauth_identity_mismatch');
 return Object.fromEntries(['appId','subjectId','tokenType','clientBusinessId','configId','graphVersion','scopes','expiresAt','dataAccessExpiresAt','granularScopes'].map(key=>[key,structuredClone(value[key])]));
}
function metadata(value,binding){const b=bindingFor(binding);return validateMetadata(value,{...b.businessLogin,appId:b.appId});}
function inspected(raw,binding,now,client){const b=bindingFor(binding);
 if(!client||!C.exact(client,'id,client_business_id')||client.id!==raw?.data?.user_id||!M.graphId(client.client_business_id))fail('oauth_identity_mismatch');
 const scopes=scopesForCohort(b.businessLogin.cohort),expected={appId:b.appId,subjectId:client.id,scopes};
 const v=b.businessLogin.cohort===COHORT?M.inspectBusinessCredential(raw,expected,now):M.inspectCredential(raw,expected,now,scopes);delete v.verifiedAt;
 if(b.credentialTargets!==null){const targets=new Set([...b.credentialTargets,client.client_business_id]);v.granularScopes=v.granularScopes.map(row=>({...row,targetIds:row.targetIds.filter(id=>targets.has(id))}));}
 v.granularScopes=v.granularScopes.map(v=>({scope:v.scope,targetIds:v.targetIds.sort()})).sort((a,b)=>a.scope.localeCompare(b.scope));
 return metadata({...v,clientBusinessId:client.client_business_id,configId:b.businessLogin.configId,graphVersion:b.businessLogin.graphVersion},binding);
}
function validate(operation,payload){const name=Object.keys(OPERATIONS).find(n=>OPERATIONS[n]===operation);if(!name)fail('operation_denied');validators[name](payload);
 if(payload.flowId&&payload.flowId!==payload.handoverId||payload.newEnrollmentId&&payload.newEnrollmentId!==payload.handoverId||payload.candidateVersionId&&payload.candidateVersionId!==payload.handoverId)fail('invalid_request');return name;}
function authorize({request,binding,principal},environment){const b=bindingFor(binding),roles={gateway:`gateway:${environment}:meta-marketing-oauth`,control:`control:${environment}:meta-marketing-oauth`};
 if(request.tenantRef!=='clinic:'+b.clinicIds[0]||request.assetRef!=='meta-enroll:'+b.scopeKey||![roles.gateway,roles.control].includes(principal.id)
  ||principal.id===roles.control&&![OPERATIONS.status,OPERATIONS.abort,OPERATIONS.drain].includes(request.operation))fail('scope_denied');}
const drainDigest=(handoverId,oldGrantDigest,receiptRefs)=>C.hash(JSON.stringify([handoverId,oldGrantDigest,receiptRefs]));
module.exports={drainDigest,COHORT,SCOPES,PAID_COHORT,PAID_SCOPES,scopesForCohort,OPERATIONS,STATES,validators,config,derive,isBinding,baseBinding,bindingFor,fingerprint,validateMetadata,metadata,inspected,validate,authorize};
