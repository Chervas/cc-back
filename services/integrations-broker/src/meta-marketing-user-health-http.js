'use strict';
const {fail}=require('./errors'),C=require('./meta-marketing-oauth-contract');
const {tokenText}=require('./whatsapp-secrets');
const fs=require('node:fs');
const HEALTH_ERRORS=new Set(['invalid_request','scope_denied','operation_denied','connection_blocked','asset_revoked',
 'rate_limited','provider_failed','provider_timeout','provider_unauthorized','credential_revoked','secret_unavailable',
 'secret_version_changed','oauth_identity_mismatch','oauth_credentials_incomplete','audit_unavailable','internal_error']);
function observeFailure(scopeKey,raw,error){
 try{
  const bounded=value=>Number.isSafeInteger(value)&&value>=0&&value<=2147483647?value:null;
  const nested=raw?.data?.error,outer=raw?.error;
  const value={event:'meta_marketing_user_health_failed',version:1,scopeKey,credentialContext:'primary',
   isValid:typeof raw?.data?.is_valid==='boolean'?raw.data.is_valid:null,
   metaCode:bounded(nested?.code)??bounded(outer?.code),
   metaSubcode:bounded(nested?.error_subcode)??bounded(nested?.subcode)??bounded(outer?.error_subcode)??bounded(outer?.subcode),
   error:HEALTH_ERRORS.has(error?.code)?error.code:'internal_error'};
  const line=JSON.stringify(value)+'\n';if(Buffer.byteLength(line)<=512)fs.writeSync(2,line);
 }catch{/* Observation must never replace or retry the original failure. */}
}
function createUserHealthHttp(options={}){
 return {async inspect({binding,token,appSecret,signal,authorize=()=>{}}){
  const b=C.bindingFor(binding);
  if(!Buffer.isBuffer(token)||!tokenText(token.toString('utf8'))||!Buffer.isBuffer(appSecret)
   ||!/^[a-f0-9]{32}$/.test(appSecret.toString('ascii'))||typeof authorize!=='function')fail('invalid_request');
  const appToken=Buffer.concat([Buffer.from(b.appId+'|'),appSecret]);
  let raw;
  try{
   authorize();if(signal?.aborted)fail('provider_timeout');
   const read=require('./meta-marketing-http').createMetaMarketingHttp({...options,appId:b.appId,authorize});
   try{raw=await read({action:'inspect',id:b.appId,token:appToken,candidate:token,signal});}
   catch(error){if(error.code==='credential_revoked')fail('secret_unavailable');throw error;}
   authorize();// Health reports observed expiry; it never authorizes a data read with it.
   const metadata=C.inspected(raw,binding,0);
   if(metadata.tokenType!=='USER')fail('oauth_identity_mismatch');return metadata;
  }catch(error){observeFailure(b.scopeKey,raw,error);throw error;}
  finally{appToken.fill(0);}
 }};
}
module.exports={createUserHealthHttp};
