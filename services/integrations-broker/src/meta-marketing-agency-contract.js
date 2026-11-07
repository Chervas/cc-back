'use strict';
const C=require('./meta-marketing-oauth-contract'),M=require('./meta-marketing-contract'),{fail}=require('./errors');
const COHORT='meta-marketing-agency-system-user-v1',ISSUER='AGENCY_SYSTEM_USER';
const SCOPES=Object.freeze(['ads_read','leads_retrieval','pages_manage_ads','pages_manage_metadata','pages_read_engagement','pages_show_list']);
const SETUP_SCOPES=Object.freeze([...SCOPES,'business_management'].sort());
const KEYS=Object.freeze(['appId','subjectId','tokenType','issuerKind','issuerBusinessId','systemUserId','configId','graphVersion','scopes','expiresAt','dataAccessExpiresAt','granularScopes']);
const bindings=new WeakMap(),UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PAGE_TASKS=new Set(['ADVERTISE','ANALYZE','MANAGE_LEADS','PROFILE_PLUS_ADVERTISE','PROFILE_PLUS_ANALYZE','PROFILE_PLUS_MANAGE_LEADS','MANAGE','PROFILE_PLUS_MANAGE']);
function config(value){
 if(!C.exact(value,'enabled,cohort,configId,graphVersion,issuerBusinessId,scopeKeys,bootstrap')||typeof value.enabled!=='boolean'||value.cohort!==COHORT
  ||!M.graphId(value.configId)||!M.graphId(value.issuerBusinessId)||value.graphVersion!=='v27.0'||!Array.isArray(value.scopeKeys)||!value.scopeKeys.length||value.scopeKeys.length>64
  ||new Set(value.scopeKeys).size!==value.scopeKeys.length||value.scopeKeys.some(v=>!/^(clinic|group):[1-9][0-9]{0,9}$/.test(v)))fail('invalid_request');
 const p=value.bootstrap;
 if(!C.exact(p,'id,role,eligibilityEvidenceSha256,eligibilityExpiresAt,regularLimit,assets')||!UUID.test(p.id)||p.role!=='EMPLOYEE'
  ||!/^[a-f0-9]{64}$/.test(p.eligibilityEvidenceSha256)||!Number.isSafeInteger(p.eligibilityExpiresAt)||p.eligibilityExpiresAt<=0||![1,10].includes(p.regularLimit)
  ||!Array.isArray(p.assets)||!p.assets.length||p.assets.length>100||new Set(p.assets.map(a=>a?.assetRef)).size!==p.assets.length)fail('invalid_request');
 for(const a of p.assets){if(!C.exact(a,'assetRef,tasks')||!/^meta-(ad_account|facebook_page):[1-9][0-9]{0,29}$/.test(a.assetRef)||!Array.isArray(a.tasks)||!a.tasks.length||new Set(a.tasks).size!==a.tasks.length
   ||a.assetRef.startsWith('meta-ad_account:')&&(JSON.stringify(a.tasks)!=='["ANALYZE"]')||a.assetRef.startsWith('meta-facebook_page:')&&a.tasks.some(v=>!PAGE_TASKS.has(v)))fail('invalid_request');}
 return value;
}
function derive(base,value,assets=null){const c=config(value),b=C.bindingFor(base);if(!c.scopeKeys.includes(b.scopeKey))fail('scope_denied');
 const selected=assets===null?null:require('./meta-marketing-enrollment-contract').assets(assets);
 if(selected&&selected.some(a=>!c.bootstrap.assets.some(v=>v.assetRef===a.assetRef)))fail('scope_denied');
 const binding={...base,metaMarketingOAuth:{...b,scopes:[...SCOPES]}};bindings.set(binding,{base,config:structuredClone(c),assets:selected});return binding;}
const isBinding=b=>bindings.has(b),baseBinding=b=>bindings.get(b)?.base||b;
function bindingFor(binding){const info=bindings.get(binding);if(!info)fail('invalid_request');return {...C.bindingFor(info.base),scopes:[...SCOPES],businessLogin:info.config,
 credentialTargets:info.assets===null?null:info.assets.map(a=>a.id),credentialAssetRefs:info.assets===null?null:info.assets.map(a=>a.assetRef)};}
function fingerprint(binding){const b=bindingFor(binding);return C.hash(JSON.stringify([C.fingerprint(baseBinding(binding)),COHORT,b.businessLogin.configId,b.businessLogin.graphVersion,b.businessLogin.issuerBusinessId,b.businessLogin.bootstrap,SCOPES]));}
function validateAgencyMetadata(value,expected){
 if(!expected||!M.graphId(expected.appId)||!M.graphId(expected.issuerBusinessId)||!M.graphId(expected.configId)||expected.graphVersion!=='v27.0')fail('invalid_request');
 if(!C.exact(value,KEYS.join(','))||value.appId!==expected.appId||!M.graphId(value.subjectId)||value.tokenType!=='SYSTEM_USER'||value.issuerKind!==ISSUER
  ||value.issuerBusinessId!==expected.issuerBusinessId||!M.graphId(value.systemUserId)||value.subjectId!==value.systemUserId||value.configId!==expected.configId||value.graphVersion!==expected.graphVersion
  ||JSON.stringify(value.scopes)!==JSON.stringify(SCOPES)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=0
  ||value.dataAccessExpiresAt!==null&&(!Number.isSafeInteger(value.dataAccessExpiresAt)||value.dataAccessExpiresAt<=0)||!Array.isArray(value.granularScopes)||value.granularScopes.length>SCOPES.length
  ||value.granularScopes.some((r,i,all)=>!C.exact(r,'scope,targetIds')||!SCOPES.includes(r.scope)||i>0&&r.scope<=all[i-1].scope||!Array.isArray(r.targetIds)||r.targetIds.length>1000||r.targetIds.some((id,j,ids)=>!M.graphId(id)||j>0&&id<=ids[j-1])))fail('oauth_credentials_incomplete');
 if(expected.subjectId!==undefined&&value.subjectId!==expected.subjectId||expected.systemUserId!==undefined&&value.systemUserId!==expected.systemUserId)fail('oauth_identity_mismatch');
 return Object.fromEntries(KEYS.map(k=>[k,structuredClone(value[k])]));
}
function metadata(value,binding){const b=bindingFor(binding);return validateAgencyMetadata(value,{appId:b.appId,...b.businessLogin});}
function inspected(raw,binding,now,identity){const b=bindingFor(binding);if(!C.exact(identity,'id,systemUserId')||identity.id!==raw?.data?.user_id||identity.id!==identity.systemUserId)fail('oauth_identity_mismatch');
 const v=M.inspectCredential(raw,{appId:b.appId,subjectId:identity.id,scopes:SCOPES},now,SCOPES);delete v.verifiedAt;if(v.tokenType!=='SYSTEM_USER')fail('oauth_identity_mismatch');
 if(b.credentialTargets!==null){const ids=new Set(b.credentialTargets);v.granularScopes=v.granularScopes.map(r=>({...r,targetIds:r.targetIds.filter(id=>ids.has(id))}));}
 v.granularScopes=v.granularScopes.map(r=>({...r,targetIds:r.targetIds.sort()})).sort((a,b)=>a.scope.localeCompare(b.scope));
 return metadata({...v,issuerKind:ISSUER,issuerBusinessId:b.businessLogin.issuerBusinessId,systemUserId:identity.systemUserId,configId:b.businessLogin.configId,graphVersion:b.businessLogin.graphVersion},binding);
}
module.exports={COHORT,ISSUER,SCOPES,SETUP_SCOPES,KEYS,PAGE_TASKS,config,derive,isBinding,baseBinding,bindingFor,fingerprint,validateAgencyMetadata,metadata,inspected};
