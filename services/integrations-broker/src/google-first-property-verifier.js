'use strict';
// Private first-only descriptions. No RPC, operator grant, reuse or enumeration.
const {randomUUID}=require('node:crypto');
const {canonical}=require('./canonical'),{fail,BrokerError}=require('./errors');
const {token,subject}=require('./google-oauth-secrets'),oauth=require('./google-oauth-contract');
const {requiredScopesFor}=require('./google-first-identity-provider');
const SC=require('./google-search-console-contract'),GA=require('./google-analytics-contract');
const D=require('./google-property-discovery-contract');
const {createSearchConsoleOperations}=require('./google-search-console');
const {createAnalyticsOperations}=require('./google-analytics');
const exact=(v,keys)=>v&&Object.getPrototypeOf(v)===Object.prototype&&Reflect.ownKeys(v).length===keys.split(',').length&&keys.split(',').every(k=>Object.hasOwn(v,k));
const SAFE=new Set(['invalid_request','operation_denied','scope_denied','oauth_flow_interrupted','outcome_unknown','idempotency_conflict','secret_unavailable','secret_version_changed',
 'provider_failed','provider_timeout','provider_unauthorized','credential_revoked','oauth_identity_mismatch','oauth_credentials_incomplete']);
function createFirstGooglePropertyVerifier({vault,ledger,http,now=Date.now}={}){
 if(typeof vault?.withCandidate!=='function'||typeof ledger?.preflight!=='function'||typeof ledger?.approve!=='function'
  ||typeof ledger?.getPrivateState!=='function'||typeof http!=='function'||typeof now!=='function')fail('invalid_request');
 let running=false;
 const clock=()=>{const at=now();if(!Number.isSafeInteger(at)||at<=0)fail('invalid_request');return at;};
 function locator(service,selection,value){
  if(service==='search_console'){
   if(!exact(value,'siteUrl'))fail('invalid_request');const parsed=SC.site(value.siteUrl);
   if(parsed.assetRef!==selection.assetRef)fail('scope_denied');return parsed;
  }
  if(service==='analytics'){
   if(!exact(value,'propertyName'))fail('invalid_request');const parsed=GA.property(value.propertyName);
   if(parsed.assetRef!==selection.assetRef)fail('scope_denied');return parsed;
  }
  fail('operation_denied');
 }
 async function verify(proof,owner,selection,resource,{signal}={},persist=true){
  if(running)fail('oauth_flow_busy');running=true;let access;
  try{
   if(signal!==undefined&&!(signal instanceof AbortSignal))fail('invalid_request');
   const activeSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000);
   const requested=locator(proof?.service,selection,resource),pins=ledger.preflight(proof,owner,selection),fingerprint=canonical(pins);
   let prior=null;
   try{prior=ledger.getPrivateState(proof,owner);}catch(error){if(!(error instanceof BrokerError)||error.code!=='scope_denied')throw error;}
   if(prior?.selectionDigest&&prior.selectionDigest!==pins.selectionDigest)fail('idempotency_conflict');
   if(prior?.state==='activation_intent')fail('outcome_unknown');
   if(prior?.approval?.validUntil<=clock())fail('oauth_flow_interrupted');
   let accessExpiresAt=null,projected;
   const guard=()=>{
    if(activeSignal.aborted||accessExpiresAt!==null&&accessExpiresAt<=clock())fail('provider_timeout');
    if(canonical(ledger.preflight(proof,owner,selection))!==fingerprint)fail('idempotency_conflict');return true;
   };
   const guardedHttp=async input=>{guard();const result=await http(input);guard();return result;};
   const native=proof.service==='search_console'
    ?createSearchConsoleOperations({http:guardedHttp})[D.SC_OPERATION]
    :createAnalyticsOperations({http:guardedHttp})[D.GA_OPERATION];
   native.validate({});
   await vault.withCandidate(pins.vaultPlan,async candidate=>{
    guard();const expected=requiredScopesFor(proof.service);
    if(candidate.googleUserId!==pins.vaultPlan.googleUserId||candidate.clientId!==pins.vaultPlan.clientId
     ||canonical(candidate.scopes)!==canonical(expected))fail('oauth_credentials_incomplete');
    const startedAt=clock(),form=new URLSearchParams({grant_type:'refresh_token',refresh_token:candidate.refreshToken.toString('utf8'),
     client_id:candidate.clientId,client_secret:candidate.clientSecret.toString('utf8')}).toString();
    const result=await guardedHttp({hostname:'oauth2.googleapis.com',path:'/token',form,signal:activeSignal});
    if(!result||Object.getPrototypeOf(result)!==Object.prototype||!token(result.access_token)||typeof result.token_type!=='string'
     ||result.token_type.toLowerCase()!=='bearer'||!Number.isSafeInteger(result.expires_in)||result.expires_in<120||result.expires_in>86400
     ||result.scope!==undefined&&(typeof result.scope!=='string'||result.scope.length>8192||/[\r\n\t]/.test(result.scope)
      ||canonical(oauth.normalizeScopes(result.scope.split(' ').filter(Boolean)))!==canonical(expected)))fail('oauth_credentials_incomplete');
    accessExpiresAt=startedAt+result.expires_in*1000;access=Buffer.from(result.access_token);guard();
    const identity=await guardedHttp({hostname:'www.googleapis.com',path:'/oauth2/v2/userinfo',token:access,signal:activeSignal});
    if(!identity||Object.getPrototypeOf(identity)!==Object.prototype||!subject(identity.id)||identity.id!==candidate.googleUserId)fail('oauth_identity_mismatch');
    const binding=proof.service==='search_console'?{searchConsoleSites:[requested]}:{analyticsProperties:[requested]};
    const verified=await native.execute({payload:{},secret:access,signal:activeSignal,binding,assetRef:selection.assetRef});guard();
    projected=native.project(verified);
    const visible=JSON.stringify(projected);
    for(const secret of [access.toString('utf8'),candidate.refreshToken.toString('utf8'),candidate.clientSecret.toString('utf8')])if(secret&&visible.includes(secret))fail('provider_failed');
   },{signal:activeSignal,assertActive:guard});
   guard();const observedAt=clock();
   if(!persist)return Object.freeze({resource:structuredClone(projected),selectionDigest:pins.selectionDigest,credentialDigest:pins.credentialDigest,
    observedAt,validUntil:Math.min(proof.expiresAt,accessExpiresAt,observedAt+60000),authorizationConfirmed:false,connected:false});
   const approval=prior?.approval||{approvalId:randomUUID(),selectionDigest:pins.selectionDigest,credentialDigest:pins.credentialDigest,
    observedAt,validUntil:Math.min(proof.expiresAt,accessExpiresAt,observedAt+60000),...(proof.service==='search_console'?{resource:projected}:{})};
   if(prior?.approval&&(approval.selectionDigest!==pins.selectionDigest||approval.credentialDigest!==pins.credentialDigest
    ||proof.service==='search_console'&&canonical(approval.resource)!==canonical(projected)))fail('idempotency_conflict');
   const state=ledger.approve(proof,owner,selection,approval);
   return Object.freeze({approval:structuredClone(approval),resource:structuredClone(projected),state});
  }catch(error){throw new BrokerError(error instanceof BrokerError&&SAFE.has(error.code)?error.code:'provider_failed');}
  finally{access?.fill(0);running=false;}
 }
 return Object.freeze({verifyAndApprove:(p,o,s,r,options)=>verify(p,o,s,r,options,true),observe:(p,o,s,r,options)=>verify(p,o,s,r,options,false)});
}
module.exports={createFirstGooglePropertyVerifier};
