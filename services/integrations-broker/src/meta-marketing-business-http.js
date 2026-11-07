'use strict';
const https=require('node:https'),{createHmac}=require('node:crypto'),{BrokerError,fail}=require('./errors');
const B=require('./meta-marketing-business-contract'),C=require('./meta-marketing-oauth-contract'),M=require('./meta-marketing-contract'),{tokenText}=require('./whatsapp-secrets');
function createMetaMarketingBusinessHttp({request=https.request,timeoutMs=8000,now=Date.now,pacer}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)fail('invalid_request');
 // Only callers below construct paths. No URL, method, fields or body can be
 // provided by an RPC client. Tokens, codes and secret proofs stay in RAM.
 async function call(binding,operation,{token,appSecret,code,metadata,assetIds,fetchOnly=false,signal,authorize=()=>{},beforeDispatch=()=>{}}){
  const b=B.bindingFor(binding),version=b.businessLogin.graphVersion;
  if(!(signal instanceof AbortSignal)||!Buffer.isBuffer(appSecret)||!/^[a-f0-9]{32}$/.test(appSecret.toString('ascii'))
   ||!['exchange','debug','business','manage'].includes(operation)||operation!=='exchange'&&(!Buffer.isBuffer(token)||!tokenText(token.toString('utf8'))))fail('invalid_request');
  let method='GET',path,body;
  const proof=()=>createHmac('sha256',appSecret).update(token).digest('hex');
  if(operation==='exchange'){
   if(!Buffer.isBuffer(code)||!/^[\x21-\x7e]{1,4096}$/.test(code.toString('latin1')))fail('invalid_request');
   path=`/${version}/oauth/access_token?`+new URLSearchParams({client_id:b.appId,client_secret:appSecret.toString('ascii'),code:code.toString('ascii'),redirect_uri:b.redirectUri});
  }else if(operation==='debug')path=`/${version}/debug_token?`+new URLSearchParams({input_token:token.toString('utf8')});
  else if(operation==='business')path=`/${version}/me?`+new URLSearchParams({fields:'client_business_id',appsecret_proof:proof()});
  else{
   B.metadata(metadata,binding);
   if(!Array.isArray(assetIds)||!assetIds.length||assetIds.length>100||new Set(assetIds).size!==assetIds.length||assetIds.some(id=>!M.graphId(id))||typeof fetchOnly!=='boolean')fail('invalid_request');
   method='POST';path=`/${version}/${metadata.clientBusinessId}/system_user_access_tokens`;
   body=Buffer.from(new URLSearchParams({appsecret_proof:proof(),asset:[...assetIds].sort().join(','),scope:B.SCOPES.join(','),set_token_expires_in_60_days:'true',fetch_only:String(fetchOnly)}).toString());
   // Optional system_user_id is deliberately omitted: /me.id is app scoped,
   // and no undocumented identity equivalence is assumed.
  }
  const pacing=require('./meta-marketing-graph-pacing').scoped({pacer,request,now},b.appId);
  try{return await pacing.run(signal,()=>new Promise((resolve,reject)=>{
   let req,res,timer,settled=false,size=0;const chunks=[];
   const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);for(const v of chunks)v.fill(0);chunks.length=0;error?reject(error):resolve(value);};
   const abort=()=>{done(new BrokerError('provider_timeout'));res?.destroy();req?.destroy();};
   timer=setTimeout(abort,timeoutMs);timer.unref?.();
   try{
    if(signal.aborted)return abort();authorize();
    const bearer=operation==='exchange'?null:operation==='debug'?Buffer.concat([Buffer.from(b.appId+'|'),appSecret]):token;
    const headers={accept:'application/json','accept-encoding':'identity',...(bearer?{authorization:'Bearer '+bearer.toString('utf8')}:{}),...(body?{'content-type':'application/x-www-form-urlencoded','content-length':body.length}:{})};
    if(operation==='debug')bearer.fill(0);
    if(operation==='manage')beforeDispatch();
    req=pacing.request({protocol:'https:',hostname:'graph.facebook.com',port:443,path,method,headers,agent:false,rejectUnauthorized:true,minVersion:'TLSv1.2'},response=>{
     res=response;if(settled){res.destroy();return;}
     if(String(res.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json'||!['','identity'].includes(String(res.headers['content-encoding']||'').toLowerCase())||res.statusCode>=300&&res.statusCode<400){done(new BrokerError('provider_failed'));res.destroy();req?.destroy();return;}
     res.on('data',chunk=>{size+=chunk.length;if(settled){chunk.fill(0);return;}if(size>(operation==='debug'?524288:32768)){done(new BrokerError('provider_failed'));chunk.fill(0);res.destroy();req?.destroy();}else chunks.push(chunk);});
     res.on('aborted',()=>done(new BrokerError('provider_failed')));res.on('error',()=>done(new BrokerError('provider_failed')));
     res.on('end',()=>{if(settled)return;let raw;try{
      raw=Buffer.concat(chunks);const value=JSON.parse(raw.toString('utf8'));
      if(res.statusCode===429||[4,17,32,613].includes(value?.error?.code)){const error=new BrokerError('rate_limited');if(operation==='manage'&&C.exact(value,'error')&&Number.isInteger(value.error?.code))Object.defineProperty(error,'knownNotApplied',{value:true});throw error;}
      if([190,102].includes(value?.error?.code))fail('credential_revoked');
      if([401,403].includes(res.statusCode)||[10,200].includes(value?.error?.code))fail('provider_unauthorized');
      if(res.statusCode!==200||!value||Object.getPrototypeOf(value)!==Object.prototype||value.error)fail('provider_failed');
      authorize();if(signal.aborted)fail('provider_timeout');done(null,value);
     }catch(error){const safe=require('./meta-marketing-graph-pacing').safeError(error);if(error.knownNotApplied===true)Object.defineProperty(safe,'knownNotApplied',{value:true});done(safe);}finally{raw?.fill(0);}});
    });
    req.on('error',()=>done(new BrokerError('provider_failed')));signal.addEventListener('abort',abort,{once:true});if(signal.aborted||settled)abort();else req.end(body);
   }catch(error){done(require('./meta-marketing-graph-pacing').safeError(error));req?.destroy();}
  }),authorize);}finally{body?.fill(0);}
 }
 async function inspect({binding,token,appSecret,signal,authorize=()=>{}}){
  let raw;
  try{raw=await call(binding,'debug',{token,appSecret,signal,authorize});}catch(error){if(error.code==='credential_revoked')fail('secret_unavailable');throw error;}
  const client=await call(binding,'business',{token,appSecret,signal,authorize});
  const value=B.inspected(raw,binding,now(),client);
  if(value.expiresAt<=now()||value.expiresAt>now()+61*86400000)fail('oauth_credentials_incomplete');
  return value;
 }
 async function use({binding,token,appSecret,signal,authorize},work){
  const owned=Buffer.from(token);let inspected;
  const wipe=()=>owned.fill(0);signal.addEventListener('abort',wipe,{once:true});
  try{inspected=await inspect({binding,token:owned,appSecret,signal,authorize});const result=await work(owned,inspected,signal);
   const text=JSON.stringify(result);if(typeof text!=='string'||text.includes(owned.toString('utf8'))||text.includes(appSecret.toString('utf8')))fail('provider_failed');return result;
  }finally{signal.removeEventListener('abort',wipe);wipe();}
 }
 return {
  inspect,
  async withExchangedToken({binding,code,appSecret,signal,authorize=()=>{}},work){
   const ownCode=Buffer.from(code),app=Buffer.from(appSecret);let token,value;
   try{value=await call(binding,'exchange',{code:ownCode,appSecret:app,signal,authorize});if(!tokenText(value.access_token))fail('oauth_credentials_incomplete');
    token=Buffer.from(value.access_token);delete value.access_token;
    return await use({binding,token,appSecret:app,signal,authorize},work);
   }finally{ownCode.fill(0);app.fill(0);token?.fill(0);if(value)delete value.access_token;}
  },
  async withManagedToken({binding,current,token,appSecret,assets,fetchOnly=false,signal,authorize=()=>{},beforeManage=()=>{}},work){
   const own=Buffer.from(token),app=Buffer.from(appSecret);let fresh,value;
   try{
    const before=await inspect({binding,token:own,appSecret:app,signal,authorize});
    if(['appId','subjectId','clientBusinessId','configId','graphVersion'].some(k=>before[k]!==current[k]))fail('oauth_identity_mismatch');
    value=await call(binding,'manage',{metadata:current,assetIds:assets.map(a=>a.id),fetchOnly,token:own,appSecret:app,signal,authorize,beforeDispatch:fetchOnly?()=>{}:beforeManage});
    if(!C.exact(value,'access_token')||!tokenText(value.access_token))fail('oauth_credentials_incomplete');fresh=Buffer.from(value.access_token);delete value.access_token;
    return await use({binding,token:fresh,appSecret:app,signal,authorize},async(t,m,s)=>{
     if(['appId','subjectId','clientBusinessId','configId','graphVersion'].some(k=>m[k]!==current[k]))fail('oauth_identity_mismatch');
     if(m.expiresAt<=current.expiresAt)fail('oauth_credentials_incomplete');
     return work(t,m,s);
    });
   }finally{own.fill(0);app.fill(0);fresh?.fill(0);if(value)delete value.access_token;}
  },
 };
}
module.exports={createMetaMarketingBusinessHttp};
