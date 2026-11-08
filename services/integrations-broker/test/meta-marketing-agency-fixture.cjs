'use strict';
const assert=require('node:assert/strict'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const A=require('../src/meta-marketing-agency-contract');
const ADMIN='FICTITIOUS_AGENCY_ADMIN_TOKEN',PAGE='FICTITIOUS_AGENCY_PAGE_TOKEN_';
function config(){return {enabled:true,cohort:A.COHORT,configId:'778',graphVersion:'v27.0',issuerBusinessId:'901',scopeKeys:['group:9'],
 bootstrap:{id:'c3c3c3c3-c3c3-43c3-83c3-c3c3c3c3c3c3',role:'EMPLOYEE',eligibilityEvidenceSha256:'a'.repeat(64),eligibilityExpiresAt:Date.now()+600000,regularLimit:1,
 assets:[{assetRef:'meta-ad_account:301',tasks:['ANALYZE']},{assetRef:'meta-facebook_page:401',tasks:['ADVERTISE','ANALYZE','MANAGE_LEADS']}]}};}
function request({state,now,binding,fallback,appSecret,cohort=()=>A.COHORT}){
 const tokens=new Map(),assigned=new Map(),users=[];let lastToken=0;state.agency={tokens,assigned,users,creates:0,installs:0,mints:0,refreshes:0};
 return (settings,callback)=>{
  const u=new URL('https://graph.facebook.com'+settings.path),bearer=String(settings.headers.authorization||'').replace(/^Bearer /,''),input=u.searchParams.get('input_token'),code=u.searchParams.get('code');
  const ours=code?.startsWith('FICTITIOUS_AGENCY_CODE_')||input===ADMIN||tokens.has(input)||input?.startsWith(PAGE)||bearer===ADMIN||tokens.has(bearer)||bearer.startsWith(PAGE)||tokens.has(u.searchParams.get('fb_exchange_token'));
  if(!ours)return fallback(settings,callback);
  const req=new EventEmitter();let destroyed=false;req.destroy=()=>{destroyed=true;};req.end=body=>queueMicrotask(async()=>{try{
   assert.equal(settings.hostname,'graph.facebook.com');assert.equal(settings.rejectUnauthorized,true);assert.equal(settings.minVersion,'TLSv1.2');assert(u.pathname.startsWith('/v27.0/'));state.httpCalls.push({kind:'agency:'+u.pathname});
   const parts=u.pathname.split('/').filter(Boolean),node=parts[1],edge=parts[2],p=new URLSearchParams(body?.toString()||'');let response,statusCode=200;
   if(code){assert.equal(settings.method,'GET');assert.equal(u.searchParams.get('grant_type'),null);assert.equal(u.searchParams.get('client_secret'),appSecret);state.codes++;response={access_token:ADMIN,token_type:'bearer',expires_in:3600};}
   else if(node==='debug_token'){
    if(input===ADMIN)response={data:{app_id:'101',user_id:'201',type:'USER',is_valid:true,expires_at:Math.floor(now()/1000)+3600,data_access_expires_at:0,scopes:[...A.setupScopesForCohort(cohort())],granular_scopes:[]}};
    else if(input.startsWith(PAGE))response={data:{app_id:'101',user_id:'601',profile_id:input.slice(PAGE.length),type:'PAGE',is_valid:true,expires_at:Math.floor(now()/1000)+3600,data_access_expires_at:0,scopes:['leads_retrieval']}};
    else{const v=tokens.get(input);response={data:{app_id:'101',user_id:v.subjectId,type:'SYSTEM_USER',is_valid:true,expires_at:v.expiresAt,data_access_expires_at:0,scopes:[...v.scopes],granular_scopes:[]}};}
   }else if(node==='me'&&edge==='business_users')response={data:[{id:'502',role:'ADMIN',business:{id:'901'}}]};
   else if(node==='me'&&u.searchParams.get('fields')==='id,has_lead_access'){const pageId=bearer.slice(PAGE.length);response={id:pageId,has_lead_access:{can_access_lead:true,app_has_leads_permission:true,user_has_leads_permission:true,enabled_lead_access_manager:true,page_id:pageId}};}
   else if(node==='me')response={id:bearer===ADMIN?'201':bearer.startsWith(PAGE)?bearer.slice(PAGE.length):tokens.get(bearer).subjectId};
   else if(edge==='owned_apps')response={data:[{id:'101'}]};
   else if(edge==='system_users'&&settings.method==='GET')response={data:users.map(v=>({...v}))};
   else if(edge==='system_users'){assert.equal(p.get('role'),'EMPLOYEE');assert.match(p.get('name'),/^Clinicaclick Marketing [a-f0-9-]{36}$/);state.agency.creates++;const v={id:'601',name:p.get('name'),role:'EMPLOYEE'};users.push(v);response={id:v.id};}
   else if(['owned_ad_accounts','owned_pages'].includes(edge))response={data:[]};
   else if(edge==='client_ad_accounts')response={data:[{id:'act_301'},...(state.extraAssets?[{id:'act_302'}]:[])]};
   else if(edge==='client_pages')response={data:[{id:'401'},...(state.extraAssets?[{id:'402'}]:[])]};
   else if(edge==='applications'){assert.equal(node,'601');assert.equal(p.get('business_app'),'101');state.agency.installs++;state.agency.installed=true;response={success:true};}
   else if(edge==='assigned_users'){
    const id=node.replace(/^act_/,'');if(settings.method==='POST'){assert.equal(p.get('user'),'601');const tasks=JSON.parse(p.get('tasks'));assert.deepEqual(tasks,node.startsWith('act_')?['ANALYZE']:['ADVERTISE','ANALYZE','MANAGE_LEADS']);assigned.set(id,tasks);response={success:true};}
    else response={data:assigned.has(id)?[{id:'601',tasks:[...assigned.get(id)]}]:[]};
   }else if(edge==='access_tokens'){
    assert.equal(node,'601');assert.equal(p.get('business_app'),'101');assert.equal(p.get('scope'),A.scopesForCohort(cohort()).join(','));assert(!p.get('scope').includes('business_management'));assert.equal(p.get('set_token_expires_in_60_days'),'true');state.agency.mints++;if(!state.agency.installed){response={error:{code:100}};}else{
    const token='FICTITIOUS_AGENCY_SYSTEM_TOKEN_'+(++lastToken);tokens.set(token,{subjectId:'601',expiresAt:Math.floor(now()/1000)+60*86400,scopes:p.get('scope').split(',')});response={access_token:token};}
   }else if(node==='oauth'&&edge==='access_token'){
    assert.equal(settings.method,'GET');assert.equal(u.searchParams.get('grant_type'),'fb_exchange_token');assert.equal(u.searchParams.get('set_token_expires_in_60_days'),'true');assert.equal(u.searchParams.get('client_secret'),appSecret);assert(tokens.has(u.searchParams.get('fb_exchange_token')));state.agency.refreshes++;
    const token='FICTITIOUS_AGENCY_SYSTEM_TOKEN_'+(++lastToken);tokens.set(token,{...tokens.get(u.searchParams.get('fb_exchange_token')),expiresAt:Math.floor(now()/1000)+60*86400});response={access_token:token,token_type:'bearer',expires_in:60*86400};
   }else if(edge==='assigned_ad_accounts'&&bearer===ADMIN)response={data:[...assigned.keys()].filter(id=>['301','302'].includes(id)).map(id=>({id:'act_'+id}))};
   else if(edge==='assigned_pages'&&bearer===ADMIN)response={data:[...assigned.keys()].filter(id=>['401','402'].includes(id)).map(id=>({id}))};
   else if(edge==='assigned_ad_accounts')response={data:['301',...(state.extraAssets?['302']:[])].map(id=>({id:'act_'+id,account_id:id,name:'Fictitious shared ad',account_status:1,currency:'EUR',timezone_name:'Europe/Madrid'}))};
   else if(edge==='assigned_pages')response={data:['401',...(state.extraAssets?['402']:[])].map(id=>({id,name:'Fictitious shared page'}))};
   else if(edge==='leadgen_forms'){assert(bearer.startsWith(PAGE));assert.equal(u.searchParams.get('fields'),'id,page_id');assert.equal(u.searchParams.get('limit'),'1');response={data:[{id:'801',page_id:node}]};}
   else if(edge==='leads'){assert(bearer.startsWith(PAGE));assert.equal(u.searchParams.get('fields'),'id');assert.equal(u.searchParams.get('limit'),'1');response={data:[{id:'9011'}]};}
   else if(['401','402'].includes(node)&&u.searchParams.get('fields')==='id,access_token')response={id:node,access_token:PAGE+node};
   else if(['401','402'].includes(node)&&u.searchParams.get('fields')==='id,has_lead_access.user_id(601).app_id(101)')response={id:node,has_lead_access:{user_id:'601',can_access_lead:true,app_has_leads_permission:true,user_has_leads_permission:true,enabled_lead_access_manager:true,page_id:node}};
   else if(node==='act_301')response={id:'act_301',account_id:'301',name:'Fictitious shared ad',account_status:1,currency:'EUR',timezone_name:'Europe/Madrid'};
   else assert.fail('Unexpected agency fixture path '+u.pathname);
   if(state.afterAgency)response=await state.afterAgency({node,edge,fields:u.searchParams.get('fields'),method:settings.method,input,bearer,params:p},response);
   if(destroyed)return;const res=new PassThrough();res.statusCode=statusCode;res.headers={'content-type':'application/json'};callback(res);res.end(JSON.stringify(response));
  }catch(error){state.fixtureError=error;req.emit('error',error);}});return req;
 };
}
module.exports={config,request,ADMIN,PAGE};
