'use strict';
const {fail}=require('./errors'),C=require('./meta-marketing-oauth-contract');
const {tokenText}=require('./whatsapp-secrets');
function createUserHealthHttp(options={}){
 return {async inspect({binding,token,appSecret,signal,authorize=()=>{}}){
  const b=C.bindingFor(binding);
  if(!Buffer.isBuffer(token)||!tokenText(token.toString('utf8'))||!Buffer.isBuffer(appSecret)
   ||!/^[a-f0-9]{32}$/.test(appSecret.toString('ascii'))||typeof authorize!=='function')fail('invalid_request');
  const appToken=Buffer.concat([Buffer.from(b.appId+'|'),appSecret]);
  try{
   authorize();if(signal?.aborted)fail('provider_timeout');
   const read=require('./meta-marketing-http').createMetaMarketingHttp({...options,appId:b.appId,authorize});
   let raw;try{raw=await read({action:'inspect',id:b.appId,token:appToken,candidate:token,signal});}
   catch(error){if(error.code==='credential_revoked')fail('secret_unavailable');throw error;}
   authorize();// Health reports observed expiry; it never authorizes a data read with it.
   const metadata=C.inspected(raw,binding,0);
   if(metadata.tokenType!=='USER')fail('oauth_identity_mismatch');return metadata;
  }finally{appToken.fill(0);}
 }};
}
module.exports={createUserHealthHttp};
