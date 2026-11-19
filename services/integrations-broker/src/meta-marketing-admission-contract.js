'use strict';
// Admission prepares an empty OAuth candidate. It grants no asset access.
const C=require('./meta-marketing-oauth-contract');
const {canonical}=require('./canonical');
const {fail}=require('./errors');
const OPERATION='meta.marketing.admission.prepare.v1';
const ACCOUNT='137819318729';
const ARN_PREFIX=`arn:aws:secretsmanager:eu-west-3:${ACCOUNT}:secret:`;
const scopeKey=value=>typeof value==='string'&&/^(clinic|group):[1-9][0-9]{0,9}$/.test(value)&&Number(value.split(':')[1])<=2147483647;
function prefix(environment){
  if(!['dev','staging'].includes(environment))fail('invalid_request');
  return `/clinicaclick/integrations/prod/meta-marketing/${environment}/automatic/`;
}
function connectionRef(scope){
  if(!scopeKey(scope))fail('invalid_request');
  return 'meta-marketing-auto-'+scope.replace(':','-')+'-v1';
}
function validateSettings(value){
  if(value===undefined)return null;
  if(C.exact(value,'enabled')&&value.enabled===false)return {enabled:false};
  const discovery=Object.hasOwn(value||{},'discoveryScopeKeys');
  const enrollment=Object.hasOwn(value||{},'enrollmentScopeKeys');
  if(!C.exact(value,'enabled,environment,appId,appVersionId,clientSecretArn,redirectUri,scopes,scopeKeys,maxConnections,slotTtlMs'
    +(discovery?',discoveryScopeKeys':'')+(enrollment?',enrollmentScopeKeys':''))||value.enabled!==true)fail('invalid_request');
  const base=prefix(value.environment),appPrefix=ARN_PREFIX+base.replace(/automatic\/$/,'');
  if(typeof value.clientSecretArn!=='string'||!value.clientSecretArn.startsWith(appPrefix)||value.clientSecretArn.startsWith(ARN_PREFIX+base)
    ||!/[A-Za-z0-9]{6}$/.test(value.clientSecretArn)||!/^[A-Za-z0-9/_+=.@-]+$/.test(value.clientSecretArn.slice(ARN_PREFIX.length))
    ||!Number.isInteger(value.maxConnections)||value.maxConnections<1||value.maxConnections>64
    ||!Number.isSafeInteger(value.slotTtlMs)||value.slotTtlMs<60000||value.slotTtlMs>90*86400000
    ||!Array.isArray(value.scopeKeys)||!value.scopeKeys.length||value.scopeKeys.length>64
    ||value.scopeKeys.some((key,i)=>!scopeKey(key)||i>0&&key<=value.scopeKeys[i-1]))fail('invalid_request');
  if(discovery&&(!Array.isArray(value.discoveryScopeKeys)||value.discoveryScopeKeys.length>64
    ||value.discoveryScopeKeys.some((key,i)=>!value.scopeKeys.includes(key)||i>0&&key<=value.discoveryScopeKeys[i-1])))fail('invalid_request');
  if(enrollment&&(!Array.isArray(value.enrollmentScopeKeys)||value.enrollmentScopeKeys.length>64
    ||value.enrollmentScopeKeys.some((key,i)=>!value.discoveryScopeKeys?.includes(key)||i>0&&key<=value.enrollmentScopeKeys[i-1])))fail('invalid_request');
  C.bindingFor({provider:C.PROVIDER,connectionRef:connectionRef('clinic:1'),secretArn:'candidate',clientSecretArn:value.clientSecretArn,expiresAt:1,
    metaMarketingOAuth:{appId:value.appId,appVersionId:value.appVersionId,slotVersionId:'a'.repeat(32),redirectUri:value.redirectUri,
      scopeKey:'clinic:1',clinicIds:[1],scopes:value.scopes}});
  if(JSON.stringify(value.scopes)!==JSON.stringify([...value.scopes].sort()))fail('invalid_request');
  return structuredClone(value);
}
function validatePreparation(value,now){
  if(!C.exact(value,'scopeKey,clinicIds,scopeDigest,clinicSetDigest,expiresAt')||!scopeKey(value.scopeKey)
    ||!Array.isArray(value.clinicIds)||!value.clinicIds.length||value.clinicIds.length>1000
    ||value.clinicIds.some((id,i)=>!Number.isSafeInteger(id)||id<1||id>2147483647||i>0&&id<=value.clinicIds[i-1])
    ||value.scopeKey.startsWith('clinic:')&&(value.clinicIds.length!==1||value.scopeKey!=='clinic:'+value.clinicIds[0])
    ||typeof value.scopeDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.scopeDigest)
    ||value.clinicSetDigest!==C.hash(JSON.stringify(value.clinicIds))
    ||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=now||value.expiresAt>now+30*60000)fail('invalid_request');
  return structuredClone(value);
}
function settingsDigest(value){
  const config=validateSettings(value);if(!config?.enabled)fail('invalid_request');
  const {enabled,scopeKeys,maxConnections,slotTtlMs,discoveryScopeKeys,enrollmentScopeKeys,...identity}=config;
  return C.hash(canonical(identity));
}
function bindingFromSlot(value,row){
  const config=validateSettings(value);
  if(!config?.enabled||!row||row.state!=='ready'||row.config_digest!==settingsDigest(config)||!scopeKey(row.scope)
    ||row.connection!==connectionRef(row.scope)||row.name!==prefix(config.environment)+row.scope.replace(':','-')+'/candidate'
    ||!C.uuid(row.version_id)||typeof row.arn!=='string'||!row.arn.startsWith(ARN_PREFIX+row.name+'-')
    ||!/^[A-Za-z0-9]{6}$/.test(row.arn.slice((ARN_PREFIX+row.name+'-').length))
    ||!Number.isSafeInteger(row.created_at)||!Number.isSafeInteger(row.expires_at)||row.expires_at<=row.created_at)fail('scope_denied');
  let clinicIds;try{clinicIds=JSON.parse(row.clinic_ids);}catch{fail('scope_denied');}
  if(JSON.stringify(clinicIds)!==row.clinic_ids)fail('scope_denied');
  const binding={connectionRef:row.connection,provider:C.PROVIDER,initialState:'active',expiresAt:row.expires_at,
    secretArn:row.arn,clientSecretArn:config.clientSecretArn,metaMarketingOAuth:{scopeKey:row.scope,clinicIds,
      appId:config.appId,appVersionId:config.appVersionId,slotVersionId:row.version_id,redirectUri:config.redirectUri,scopes:[...config.scopes]}};
  C.bindingFor(binding);return binding;
}
function publicBinding(config,row){
  const binding=bindingFromSlot(config,row),b=C.bindingFor(binding);
  return {connectionRef:binding.connectionRef,scopeKey:b.scopeKey,clinicIds:[...b.clinicIds],assetRef:'meta-enroll:'+b.scopeKey,
    appId:b.appId,scopes:[...b.scopes],redirectUri:b.redirectUri,expiresAt:binding.expiresAt};
}
module.exports={OPERATION,PREPARE:OPERATION,ARN_PREFIX,prefix,scopeKey,connectionRef,validateSettings,validatePreparation,settingsDigest,bindingFromSlot,publicBinding};
