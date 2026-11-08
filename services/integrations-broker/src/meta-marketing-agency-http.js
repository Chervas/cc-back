'use strict';
const https=require('node:https'),{createHmac}=require('node:crypto');
const A=require('./meta-marketing-agency-contract'),C=require('./meta-marketing-oauth-contract'),M=require('./meta-marketing-contract'),{BrokerError,fail}=require('./errors'),{tokenText}=require('./whatsapp-secrets');
function createMetaMarketingAgencyHttp({request=https.request,timeoutMs=8000,now=Date.now,pacer,bootstrap}={}){
 if(!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>10000)fail('invalid_request');
 async function call(binding,operation,{token,appSecret,code,id,subjectId,tasks,name,after,signal,authorize=()=>{},beforeDispatch=()=>{}}){
  const b=A.bindingFor(binding),c=b.businessLogin,version=c.graphVersion;
  if(!(signal instanceof AbortSignal)||!Buffer.isBuffer(appSecret)||!/^[a-f0-9]{32}$/.test(appSecret.toString('ascii'))||operation!=='exchange'&&(!Buffer.isBuffer(token)||!tokenText(token.toString('utf8'))))fail('invalid_request');
  const proof=()=>createHmac('sha256',appSecret).update(token).digest('hex');let method='GET',path,body,mutates=false;
  const fields=(node,edge,value,extra={})=>`/${version}/${node}${edge?'/'+edge:''}?`+new URLSearchParams({fields:value,limit:'100',appsecret_proof:proof(),...extra,...(after?{after}:{})});
  if(after!==undefined&&after!==null&&!/^[A-Za-z0-9_+/=-]{1,2048}$/.test(after))fail('invalid_request');
  const post=(node,edge,params)=>{method='POST';mutates=true;path=`/${version}/${node}/${edge}`;body=Buffer.from(new URLSearchParams({...params,appsecret_proof:proof()}).toString());};
  if(operation==='exchange'){
   if(!Buffer.isBuffer(code)||!/^[\x21-\x7e]{1,4096}$/.test(code.toString('latin1')))fail('invalid_request');
   path=`/${version}/oauth/access_token?`+new URLSearchParams({client_id:b.appId,client_secret:appSecret.toString('ascii'),code:code.toString('ascii'),redirect_uri:b.redirectUri});
  }else if(operation==='debug')path=`/${version}/debug_token?`+new URLSearchParams({input_token:token.toString('utf8')});
  else if(operation==='me')path=fields('me',null,'id');
  else if(['pageDerive','pageLead','pageForms'].includes(operation)){if(!M.graphId(id))fail('invalid_request');path=operation==='pageDerive'?fields(id,null,'id,access_token'):operation==='pageLead'?(M.graphId(subjectId)?fields(id,null,`id,has_lead_access.user_id(${subjectId}).app_id(${b.appId})`):fail('invalid_request')):fields(id,'leadgen_forms','id,page_id',{limit:'1'});}
  else if(operation==='adminBusinesses')path=fields('me','business_users','id,role,business{id}');
  else if(operation==='ownedApps')path=fields(c.issuerBusinessId,'owned_apps','id');
  else if(operation==='systemUsers')path=fields(c.issuerBusinessId,'system_users','id,name,role');
  else if(['systemAssignedAds','systemAssignedPages'].includes(operation)){if(!M.graphId(id))fail('invalid_request');path=fields(id,operation==='systemAssignedAds'?'assigned_ad_accounts':'assigned_pages','id');}
  else if(['ownedAds','clientAds','ownedPages','clientPages'].includes(operation))path=fields(c.issuerBusinessId,{ownedAds:'owned_ad_accounts',clientAds:'client_ad_accounts',ownedPages:'owned_pages',clientPages:'client_pages'}[operation],'id');
  else if(operation==='create'){
   if(name!==`Clinicaclick Marketing ${c.bootstrap.id}`)fail('invalid_request');post(c.issuerBusinessId,'system_users',{name,role:'EMPLOYEE'});
  }else if(operation==='install'){
   if(!M.graphId(id))fail('invalid_request');post(id,'applications',{business_app:b.appId});
  }else if(['assignAd','assignPage'].includes(operation)){
   if(!M.graphId(id)||!Array.isArray(tasks)||!tasks.length||tasks.some(v=>typeof v!=='string'))fail('invalid_request');
   const permitted=c.bootstrap.assets.find(a=>a.assetRef===`meta-${operation==='assignAd'?'ad_account':'facebook_page'}:${id}`);
   if(!permitted||JSON.stringify(tasks)!==JSON.stringify(permitted.tasks)||!M.graphId(name))fail('invalid_request');
   post(operation==='assignAd'?'act_'+id:id,'assigned_users',{user:name,tasks:JSON.stringify(tasks),...(operation==='assignAd'?{business:c.issuerBusinessId}:{})});
  }else if(['adUsers','pageUsers'].includes(operation)){
   if(!M.graphId(id))fail('invalid_request');path=fields(operation==='adUsers'?'act_'+id:id,'assigned_users','id,tasks',{business:c.issuerBusinessId});
  }else if(operation==='mint'){
   if(!M.graphId(id))fail('invalid_request');post(id,'access_tokens',{business_app:b.appId,scope:A.SCOPES.join(','),set_token_expires_in_60_days:'true'});
  }else if(operation==='refresh'){
   path=`/${version}/oauth/access_token?`+new URLSearchParams({grant_type:'fb_exchange_token',client_id:b.appId,client_secret:appSecret.toString('ascii'),fb_exchange_token:token.toString('utf8'),set_token_expires_in_60_days:'true'});mutates=true;
  }else fail('operation_denied');
  const pacing=require('./meta-marketing-graph-pacing').scoped({pacer,request,now},b.appId);
  try{return await pacing.run(signal,()=>new Promise((resolve,reject)=>{let req,res,timer,settled=false,size=0;const chunks=[];
   const done=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);signal.removeEventListener('abort',abort);for(const chunk of chunks)chunk.fill(0);chunks.length=0;error?reject(error):resolve(value);};
   const abort=()=>{done(new BrokerError('provider_timeout'));res?.destroy();req?.destroy();};timer=setTimeout(abort,timeoutMs);timer.unref?.();
   try{if(signal.aborted)return abort();authorize();let bearer=operation==='exchange'?null:operation==='debug'?Buffer.concat([Buffer.from(b.appId+'|'),appSecret]):token;
    const headers={accept:'application/json','accept-encoding':'identity',...(bearer?{authorization:'Bearer '+bearer.toString('utf8')}:{}),...(body?{'content-type':'application/x-www-form-urlencoded','content-length':body.length}:{})};if(operation==='debug')bearer.fill(0);if(mutates)beforeDispatch();
    req=pacing.request({protocol:'https:',hostname:'graph.facebook.com',port:443,path,method,headers,agent:false,rejectUnauthorized:true,minVersion:'TLSv1.2'},response=>{
     res=response;if(settled){res.destroy();return;}if(String(res.headers['content-type']||'').split(';')[0].trim().toLowerCase()!=='application/json'||!['','identity'].includes(String(res.headers['content-encoding']||'').toLowerCase())||res.statusCode>=300&&res.statusCode<400){done(new BrokerError('provider_failed'));res.destroy();req?.destroy();return;}
     res.on('data',chunk=>{size+=chunk.length;if(settled){chunk.fill(0);return;}if(size>(operation==='debug'?524288:65536)){done(new BrokerError('provider_failed'));chunk.fill(0);res.destroy();req?.destroy();}else chunks.push(chunk);});
     res.on('aborted',()=>done(new BrokerError('provider_failed')));res.on('error',()=>done(new BrokerError('provider_failed')));
     res.on('end',()=>{if(settled)return;let raw;try{raw=Buffer.concat(chunks);const value=JSON.parse(raw.toString('utf8'));
      if(res.statusCode===429||[4,17,32,613].includes(value?.error?.code)){const error=new BrokerError('rate_limited');if(mutates&&C.exact(value,'error')&&Number.isInteger(value.error?.code))Object.defineProperty(error,'knownNotApplied',{value:true});throw error;}
      if([190,102].includes(value?.error?.code))fail('credential_revoked');if([401,403].includes(res.statusCode)||[10,200].includes(value?.error?.code))fail('provider_unauthorized');
      if(res.statusCode!==200||!value||Object.getPrototypeOf(value)!==Object.prototype&&!(operation==='install'&&value===true)||value.error)fail('provider_failed');authorize();if(signal.aborted)fail('provider_timeout');done(null,value);
     }catch(error){const safe=require('./meta-marketing-graph-pacing').safeError(error);if(error.knownNotApplied===true)Object.defineProperty(safe,'knownNotApplied',{value:true});done(safe);}finally{raw?.fill(0);}});
    });req.on('error',()=>done(new BrokerError('provider_failed')));signal.addEventListener('abort',abort,{once:true});if(signal.aborted||settled)abort();else req.end(body);
   }catch(error){done(require('./meta-marketing-graph-pacing').safeError(error));req?.destroy();}
  }),authorize);}finally{body?.fill(0);}
 }
 async function inspect({binding,token,appSecret,signal,authorize=()=>{},systemUserId}){
  const raw=await call(binding,'debug',{token,appSecret,signal,authorize}),me=await call(binding,'me',{token,appSecret,signal,authorize});
  if(!C.exact(me,'id'))fail('oauth_identity_mismatch');const id=systemUserId||me.id;const value=A.inspected(raw,binding,now(),{id:me.id,systemUserId:id});
  if(value.expiresAt<=now()||value.expiresAt>now()+61*86400000)fail('oauth_credentials_incomplete');return value;
 }
 async function verifyPages({binding,metadata,token,appSecret,signal,authorize=()=>{},assets}){
  A.metadata(metadata,binding);const refs=assets||A.bindingFor(binding).credentialAssetRefs?.map(ref=>({kind:ref.startsWith('meta-facebook_page:')?'facebook_page':'ad_account',id:ref.split(':')[1]}));if(!Array.isArray(refs))fail('scope_denied');
  for(const asset of refs.filter(a=>a.kind==='facebook_page')){let pageToken,raw;try{raw=await call(binding,'pageDerive',{id:asset.id,token,appSecret,signal,authorize});if(!C.exact(raw,'id,access_token')||raw.id!==asset.id||!tokenText(raw.access_token))fail('scope_denied');pageToken=Buffer.from(raw.access_token);delete raw.access_token;
   const debug=await call(binding,'debug',{token:pageToken,appSecret,signal,authorize}),d=debug?.data;if(!d||d.is_valid!==true||d.app_id!==metadata.appId||d.type!=='PAGE'||d.profile_id!=null&&d.profile_id!==asset.id||!Array.isArray(d.scopes)||!d.scopes.includes('leads_retrieval')||[d.expires_at,d.data_access_expires_at].some(v=>!Number.isSafeInteger(v)||v<0||v!==0&&v*1000<=now()))fail('scope_denied');
   const access=await call(binding,'pageLead',{id:asset.id,subjectId:metadata.subjectId,token:pageToken,appSecret,signal,authorize});if(!C.exact(access,'id,has_lead_access')||access.id!==asset.id||access.has_lead_access&&Object.hasOwn(access.has_lead_access,'user_id')&&access.has_lead_access.user_id!==metadata.subjectId)fail('scope_denied');if(!require('./meta-marketing-page-lead-access').hasLeadAccess(access.has_lead_access,asset.id)){const error=new BrokerError('oauth_credentials_incomplete');Object.defineProperty(error,'credentialValidationReason',{value:'page_lead_access_denied'});throw error;}
   const forms=await call(binding,'pageForms',{id:asset.id,token:pageToken,appSecret,signal,authorize});if(!forms||Object.getPrototypeOf(forms)!==Object.prototype||Object.keys(forms).some(k=>!['data','paging'].includes(k))||!Array.isArray(forms.data)||forms.data.length>1||forms.data.some(f=>!C.exact(f,'id,page_id')||!M.graphId(f.id)||f.page_id!==asset.id))fail('scope_denied');
  }finally{pageToken?.fill(0);if(raw)delete raw.access_token;}}return true;
 }
 async function use(options,work){const own=Buffer.from(options.token);const wipe=()=>own.fill(0);options.signal.addEventListener('abort',wipe,{once:true});
  try{const metadata=await inspect({...options,token:own});await verifyPages({...options,token:own,metadata});const value=await work(own,metadata,options.signal);const text=JSON.stringify(value);if(typeof text!=='string'||text.includes(own.toString('utf8'))||text.includes(options.appSecret.toString('utf8')))fail('provider_failed');return value;}finally{options.signal.removeEventListener('abort',wipe);wipe();}}
 return {call,inspect,verifyPages,
  async withExchangedToken({binding,flowId,code,appSecret,signal,authorize=()=>{}},work){if(!bootstrap||typeof bootstrap.run!=='function')fail('operation_denied');const app=Buffer.from(appSecret),ownCode=Buffer.from(code);let admin,result;
   try{result=await call(binding,'exchange',{code:ownCode,appSecret:app,signal,authorize});if(!tokenText(result.access_token))fail('oauth_credentials_incomplete');admin=Buffer.from(result.access_token);delete result.access_token;
    const raw=await call(binding,'debug',{token:admin,appSecret:app,signal,authorize}),b=A.bindingFor(binding),checked=M.inspectCredential(raw,{appId:b.appId,subjectId:raw?.data?.user_id,scopes:A.SETUP_SCOPES},now(),A.SETUP_SCOPES);
    if(checked.tokenType!=='USER'||checked.expiresAt!==null&&checked.expiresAt<=now())fail('oauth_identity_mismatch');
    const me=await call(binding,'me',{token:admin,appSecret:app,signal,authorize});if(!C.exact(me,'id')||me.id!==checked.subjectId)fail('oauth_identity_mismatch');
    return await bootstrap.run({binding,flowId,adminSubjectId:checked.subjectId,signal,authorize,call:(operation,params={})=>call(binding,operation,{...params,token:admin,appSecret:app,signal,authorize})},async(token,systemUserId)=>use({binding,token,appSecret:app,signal,authorize,systemUserId},work));
   }finally{app.fill(0);ownCode.fill(0);admin?.fill(0);if(result)delete result.access_token;}
  },
  async withManagedToken({binding,current,token,appSecret,fetchOnly=false,signal,authorize=()=>{},beforeManage=()=>{}},work){const old=Buffer.from(token),app=Buffer.from(appSecret);let fresh,result;
   try{const before=await inspect({binding,token:old,appSecret:app,signal,authorize,systemUserId:current.systemUserId});if(require('./meta-marketing-business-issuer').identityKeys(current).some(k=>before[k]!==current[k]))fail('oauth_identity_mismatch');
    // There is no documented fetch_only equivalent for generic System User
    // refresh. An uncertain refresh is retained for explicit reconciliation;
    // it must never issue a second refresh speculatively.
    if(fetchOnly)fail('outcome_unknown');
    result=await call(binding,'refresh',{token:old,appSecret:app,signal,authorize,beforeDispatch:beforeManage});
    if(!tokenText(result.access_token)||Object.keys(result).some(k=>!['access_token','token_type','expires_in'].includes(k))||result.token_type!=='bearer'||!Number.isSafeInteger(result.expires_in)||result.expires_in<=0||result.expires_in>61*86400)fail('oauth_credentials_incomplete');fresh=Buffer.from(result.access_token);delete result.access_token;
    return await use({binding,token:fresh,appSecret:app,signal,authorize,systemUserId:current.systemUserId},async(t,m,s)=>{if(require('./meta-marketing-business-issuer').identityKeys(current).some(k=>m[k]!==current[k])||m.expiresAt<=current.expiresAt)fail('oauth_identity_mismatch');return work(t,m,s);});
   }finally{old.fill(0);app.fill(0);fresh?.fill(0);if(result)delete result.access_token;}
  },
 };
}
module.exports={createMetaMarketingAgencyHttp};
