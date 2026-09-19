'use strict';
const {schema}=require('./contracts'),{fail}=require('./errors'),C=require('./meta-marketing-oauth-contract'),M=require('./meta-marketing-contract');
const OPERATION='meta.marketing.oauth.assets.v1';
const validate=schema({flowId:{type:'string',pattern:'^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'},scopeDigest:{type:'string',pattern:'^[a-f0-9]{64}$'}});
const MAX_ASSETS=500,MAX_PAGES=10,MAX_BYTES=1048576,MAX_RESULT_BYTES=262144;
function kinds(metadata){
  const s=metadata.scopes,out=[];
  if(s.includes('ads_read'))out.push('ad_account');
  if(['pages_show_list','pages_read_engagement'].every(v=>s.includes(v)))out.push('facebook_page');
  if(out.includes('facebook_page')&&s.includes('instagram_basic'))out.push('instagram_business');
  return out;
}
function fresh(raw,binding,stored,now){
  const v=C.inspected(raw,binding,now);
  if(['appId','subjectId','tokenType','scopes','granularScopes'].some(k=>JSON.stringify(v[k])!==JSON.stringify(stored[k])))fail('oauth_identity_mismatch');
  if([stored.expiresAt,stored.dataAccessExpiresAt].some(x=>x!==null&&x<=now))fail('credential_revoked');
  if(['expiresAt','dataAccessExpiresAt'].some(k=>v[k]!==null&&(stored[k]===null||v[k]<stored[k])))fail('credential_revoked');
  return v;
}
function project(raw,kind,parentPageId=null){
  const id=kind==='ad_account'?raw?.account_id:raw?.id;
  if(!M.graphId(id)||kind==='instagram_business'&&!M.graphId(parentPageId))fail('provider_failed');
  const asset={assetRef:`meta-${kind}:${id}`,kind,id,parentPageId};
  return {...M.projectAsset(raw,asset),id,parentPageId};
}
function checkAssets(assets,metadata){
  const availableKinds=kinds(metadata),seen=new Set();
  if(!Array.isArray(assets)||assets.length>MAX_ASSETS)fail('provider_failed');
  for(const a of assets){
    const keys='assetRef,kind,id,name,parentPageId'+(a.kind==='ad_account'?',accountStatus,currency,timezone':a.kind==='instagram_business'?',username':'');
    if(!C.exact(a,keys)||!availableKinds.includes(a.kind)||!M.graphId(a.id)||a.assetRef!==`meta-${a.kind}:${a.id}`||seen.has(a.assetRef)
      ||(a.kind==='instagram_business'?!M.graphId(a.parentPageId):a.parentPageId!==null))fail('provider_failed');
    M.assertAssetCredential(metadata,a);seen.add(a.assetRef);
    const raw={id:a.kind==='ad_account'?'act_'+a.id:a.id,name:a.name,
      ...(a.kind==='ad_account'?{account_id:a.id,account_status:a.accountStatus,currency:a.currency,timezone_name:a.timezone}:a.kind==='instagram_business'?{username:a.username}:{})};
    project(raw,a.kind,a.parentPageId);
  }
  return availableKinds;
}
function result({assets,metadata,request,binding,row,now}){
  const availableKinds=checkAssets(assets,metadata);
  const value={flowId:row.id,candidateVersionId:row.id,candidateDigest:row.secret_digest,scopeDigest:row.scope_digest,
    scopeKey:C.bindingFor(binding).scopeKey,clinicSetDigest:row.clinic_digest,observedAt:now,
    expiresAt:Math.min(now+300000,...[metadata.expiresAt,metadata.dataAccessExpiresAt,binding.expiresAt].filter(v=>v!==null)),
    accessBlocked:true,availableKinds,assets:assets.slice().sort((a,b)=>a.assetRef.localeCompare(b.assetRef))};
  if(value.expiresAt<=now||request.payload.scopeDigest!==row.scope_digest||Buffer.byteLength(JSON.stringify(value))>MAX_RESULT_BYTES)fail('scope_denied');
  return value;
}
function validateResult(value,{flowId,candidateDigest,scopeDigest,scopeKey,clinicSetDigest,metadata,startedAt,now}){
  if(!C.exact(value,'flowId,candidateVersionId,candidateDigest,scopeDigest,scopeKey,clinicSetDigest,observedAt,expiresAt,accessBlocked,availableKinds,assets')
    ||value.flowId!==flowId||value.candidateVersionId!==flowId||value.candidateDigest!==candidateDigest||value.scopeDigest!==scopeDigest
    ||value.scopeKey!==scopeKey||value.clinicSetDigest!==clinicSetDigest||value.accessBlocked!==true
    ||!Number.isSafeInteger(value.observedAt)||value.observedAt<startedAt-5000||value.observedAt>now+5000
    ||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now||value.expiresAt>value.observedAt+300000
    ||[metadata.expiresAt,metadata.dataAccessExpiresAt].some(v=>v!==null&&value.expiresAt>v)
    ||JSON.stringify(value.availableKinds)!==JSON.stringify(checkAssets(value.assets,metadata))||Buffer.byteLength(JSON.stringify(value))>MAX_RESULT_BYTES)fail('provider_failed');
  return structuredClone(value);
}
module.exports={OPERATION,validate,MAX_ASSETS,MAX_PAGES,MAX_BYTES,MAX_RESULT_BYTES,kinds,fresh,project,result,validateResult};
