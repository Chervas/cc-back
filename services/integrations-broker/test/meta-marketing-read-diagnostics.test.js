'use strict';
require('./offline-guard.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),{spawnSync}=require('node:child_process'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const A=require('../src/meta-marketing-ads-contract'),L=require('../src/meta-marketing-leads-contract'),M=require('../src/meta-marketing-contract');
const R=require('../src/meta-marketing-read-diagnostics'),{createPacing}=require('../src/meta-marketing-ads-pacing');
const ADS=require('../src/meta-marketing-ads-http'),LEADS=require('../src/meta-marketing-leads-http');
const BASE='/home/ubuntu/wt/back-staging/services/integrations-broker/src/';
const TOKEN='FICTITIOUS_DIAGNOSTIC_TOKEN',APP='0123456789abcdef'.repeat(2),PAGE_TOKEN='FICTITIOUS_DIAGNOSTIC_PAGE_TOKEN';
const CANARY='NEVER_EMIT_PATIENT_NAME_TOKEN_EMAIL_qa@example.invalid',AT=Date.UTC(2026,10,8);
function row(name){
 if(name==='campaigns')return{id:'601',name:'Fictitious campaign'};
 if(name==='adsets')return{id:'602',name:'Fictitious adset',campaign_id:'601'};
 if(name==='ads')return{id:'603',name:'Fictitious ad',campaign_id:'601',adset_id:'602'};
 const b={ad_id:'603',date_start:'2026-11-07',date_stop:'2026-11-07',publisher_platform:'instagram',platform_position:'feed'};
 return name==='actions'?{...b,actions:[{action_type:'lead',value:'1'}]}:{...b,impressions:'3',reach:'2',clicks:'1',inline_link_clicks:'1',spend:'0.25',cpc:'0.25',cpm:'83.33',ctr:'33.33',frequency:'1.5'};
}
function fixture({family='insights',lead=false,alter,base=false,paused=false,status=200,cursorState}={}){
 let clock=AT;const calls=[],map=new Map(),scope='meta-ads-app:101';
 const state={load:k=>map.get(k)||{next_allowed_at:0,pause_until:0},save:(k,v)=>map.set(k,{...v})};
 if(paused)state.save(scope,{next_allowed_at:AT,pause_until:AT+7200000});
 const makePacing=base?require(BASE+'meta-marketing-ads-pacing').createPacing:createPacing;
 const pacer=makePacing({state,now:()=>clock,wait:async ms=>{clock+=ms;}});
 const scopes=[...M.SCOPES].sort(),binding={provider:'meta_marketing_onboarding',connectionRef:'qa:diagnostic',expiresAt:AT+86400000,secretArn:'qa-slot',clientSecretArn:'qa-app',metaMarketingOAuth:{appId:'101',redirectUri:'https://example.invalid/oauth/meta/marketing/callback',appVersionId:'a'.repeat(32),slotVersionId:'s'.repeat(32),scopeKey:'group:9',clinicIds:[71,72],scopes}};
 const metadata={appId:'101',subjectId:'201',tokenType:'USER',scopes,expiresAt:null,dataAccessExpiresAt:null,granularScopes:[]};
 const account={assetRef:'meta-ad_account:301',kind:'ad_account',id:'301',parentPageId:null},page={assetRef:'meta-facebook_page:401',kind:'facebook_page',id:'401',parentPageId:null};
 const request=(options,cb)=>{const u=new URL('https://graph.facebook.com'+options.path);calls.push({path:u.pathname,fields:u.searchParams.get('fields'),at:clock});
  const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{
   let raw,kind,code=200;
   if(u.pathname.endsWith('/debug_token')){kind=u.searchParams.get('input_token')===PAGE_TOKEN?'page_debug':'user_debug';raw={data:{app_id:'101',...(kind==='page_debug'?{type:'PAGE',profile_id:'401'}:{type:'USER',user_id:'201'}),is_valid:true,expires_at:0,data_access_expires_at:0,scopes}};}
   else if(u.searchParams.get('fields')==='id,access_token'){kind='derive_page';raw={id:'401',access_token:PAGE_TOKEN};}
   else if(u.pathname.endsWith('/me')){kind='page_identity';raw={id:'401'};}
   else if(u.pathname.endsWith('/subscribed_apps')){kind='subscription';raw={data:[{id:'101',subscribed_fields:['leadgen']}]};}
   else if(u.pathname==='/v24.0/401/leadgen_forms'){kind='page_access';raw={data:[{id:'702',page_id:'401'}]};}
   else if(u.pathname==='/v24.0/702/leads'){kind='lead_probe';raw={data:[]};}
   else{kind='ads_data';raw={data:[row(family)]};}
   if(!['user_debug','page_debug'].includes(kind))code=status;
   const changed=alter?.(kind,raw,u);if(changed){raw=changed.raw??raw;code=changed.status??code;}
   const res=new PassThrough();res.statusCode=code;res.headers={'content-type':'application/json'};cb(res);res.end(JSON.stringify(raw));
  });return req;};
 const module=base?require(BASE+(lead?'meta-marketing-leads-http':'meta-marketing-ads-http')):lead?LEADS:ADS;
 const http=(lead?module.createMetaMarketingLeadsHttp:module.createMetaMarketingAdsHttp)({request,pacer,cursor:{open(){if(cursorState)return JSON.stringify(cursorState);throw Error('No cursor');},seal(){return 'A'.repeat(64);}},now:()=>clock});
 const operation=lead?L.OPERATIONS[family]:A.OPERATIONS[family],payload=lead?{adAccountAssetRef:account.assetRef,...(family==='pageEnable'?{expectedSubscriptionRevision:'a'.repeat(64)}:family==='destinations'?{campaignId:'601',cursor:cursorState?'A'.repeat(64):null}:{})}:['insights','actions'].includes(family)?{pageToken:cursorState?'A'.repeat(64):null,startDate:'2026-11-07',endDate:'2026-11-07'}:{pageToken:cursorState?'A'.repeat(64):null};
 const input={binding,metadata,token:Buffer.from(TOKEN),appSecret:Buffer.from(APP),asset:lead?page:account,...(lead?{account}:{}),operation,payload,signal:new AbortController().signal,authorize(){},context:{principalId:'staging:meta-marketing',tenantRef:'clinic:71',policyVersion:'qa:diagnostic'}};
 return{run:()=>http.read(input),calls,pacer,state:map,operation,assetRef:input.asset.assetRef,metadata};
}
async function capture(work,{throwObserver=false}={}){
 const write=fs.writeSync,lines=[];let result,error;
 fs.writeSync=function(fd,chunk,...args){if(fd!==2)return write.call(this,fd,chunk,...args);if(throwObserver)throw Object.assign(Error(CANARY),{code:'EPIPE'});lines.push(String(chunk));return Buffer.byteLength(String(chunk));};
 try{result=await work();}catch(e){error=e;}finally{fs.writeSync=write;}
 return{result,error,lines,events:lines.map(s=>JSON.parse(s))};
}
function closed(c){assert.equal(c.lines.length,1);assert(Buffer.byteLength(c.lines[0])<=2048);assert(!c.lines[0].includes(CANARY));assert(!c.lines[0].includes(TOKEN));assert(!c.lines[0].includes(APP));
 const e=c.events[0];assert.deepEqual(Object.keys(e).sort(),['assetRef','credentialContext','debugScopes','error','event','httpStatus','metaCode','metaSubcode','operation','pagination','paginationPathVariant','paginationPathShape','phase','shape','stage','version'].sort());assert.equal(e.event,R.EVENT);return e;}
test('five successful Ads reads retain exact results/calls/pacing and emit no event',async()=>{
 for(const family of Object.keys(A.OPERATIONS)){const f=fixture({family}),b=fixture({family,base:true}),c=await capture(f.run),original=await capture(b.run);assert.ifError(c.error);assert.equal(c.lines.length,0);assert.deepEqual(c.result,original.result);assert.deepEqual(f.calls,b.calls);assert.deepEqual([...f.state],[...b.state]);}
});
test('Ads HTTP failure emits only closed numeric error metadata, never provider message/body/unknown keys',async()=>{
 const alter=(kind)=>kind==='ads_data'?{status:400,raw:{error:{code:100,error_subcode:33,message:CANARY,error_user_title:TOKEN,unknown:APP},[CANARY]:CANARY}}:null;
 const f=fixture({alter}),b=fixture({alter,base:true}),c=await capture(f.run),original=await capture(b.run),e=closed(c);
 assert.equal(c.error.code,original.error.code);assert.equal(e.phase,'data_http');assert.equal(e.stage,'http');assert.equal(e.httpStatus,400);assert.equal(e.metaCode,100);assert.equal(e.metaSubcode,33);assert.equal(e.shape,null);assert.deepEqual(f.calls,b.calls);assert.deepEqual([...f.state],[...b.state]);
 assert.deepEqual(e.debugScopes,{hasAdsReadScope:true,hasAdsManagementScope:false});
});
test('Ads projection identifies the first row rejected by the existing validator without row values or unknown keys',async()=>{
 const bad={...row('insights'),ad_id:123456789,name:CANARY,[CANARY]:TOKEN};
 const f=fixture({alter:k=>k==='ads_data'?{raw:{data:[row('insights'),bad,{...bad,ad_id:CANARY}]}}:null}),c=await capture(f.run),e=closed(c);
 assert.equal(c.error.code,'provider_failed');assert.equal(e.phase,'data_projection');assert.equal(e.httpStatus,200);assert.equal(e.shape.rowIndex,1);assert.equal(e.shape.fields.ad_id,'number_bad');assert(!c.lines[0].includes('123456789'));assert(!c.lines[0].includes('name'));assert.equal(e.metaCode,null);
});
test('all five Ads row families produce fixed field shapes on normal-validator failure',async()=>{
 for(const family of Object.keys(A.OPERATIONS)){const f=fixture({family,alter:k=>k==='ads_data'?{raw:{data:[{[CANARY]:CANARY}]}}:null}),c=await capture(f.run),e=closed(c);assert.equal(e.phase,'data_projection');assert.equal(e.shape.rowIndex,0);assert.equal(e.shape.kind,'ads_row');assert.equal(c.error.code,'provider_failed');}
});
test('page-level projection failure does not invent a rejected-row shape',async()=>{
 const f=fixture({alter:k=>k==='ads_data'?{raw:{data:Array.from({length:51},()=>row('insights'))}}:null}),c=await capture(f.run),e=closed(c);assert.equal(e.phase,'data_projection');assert.equal(e.shape,null);
});
test('PageStatus foreign Form response fails before lead probe and never emits provider contact or metadata values',async()=>{
 const f=fixture({lead:true,family:'pageStatus',alter:k=>k==='page_access'?{raw:{data:[{id:'702',page_id:'999',[CANARY]:TOKEN}]}}:null}),c=await capture(f.run),e=closed(c);
 assert.equal(c.error.code,'scope_denied');assert.equal(e.phase,'page_access_projection');assert.equal(e.httpStatus,200);assert.equal(e.shape,null);assert(!f.calls.some(v=>v.path.endsWith('/leads')));assert(!f.calls.some(v=>v.path.endsWith('/subscribed_apps')));
});
test('PageStatus HTTP failure differs from shape failure; subscription is never requested after error',async()=>{
 const f=fixture({lead:true,family:'pageStatus',alter:k=>k==='page_access'?{status:400,raw:{error:{code:100,error_subcode:88,message:CANARY}}}:null}),c=await capture(f.run),e=closed(c);
 assert.equal(e.phase,'page_access_http');assert.equal(e.stage,'http');assert.equal(e.metaCode,100);assert.equal(e.shape,null);assert.equal(c.error.code,'provider_failed');assert(!f.calls.some(v=>v.path.endsWith('/subscribed_apps')));
});
test('cooldown and 429 preserve the original retry hint, pacing state and request counts without retry',async()=>{
 for(const options of [{paused:true},{alter:k=>k==='ads_data'?{status:429,raw:{error:{code:4,message:CANARY}}}:null}]){
  const f=fixture(options),b=fixture({...options,base:true}),c=await capture(f.run),original=await capture(b.run),e=closed(c);
  assert.equal(c.error.code,'rate_limited');assert.equal(c.error.retryAfterMs,original.error.retryAfterMs);assert.deepEqual(f.calls,b.calls);assert.deepEqual([...f.state],[...b.state]);assert.equal(e.httpStatus,options.paused?null:429);assert.equal(e.stage,options.paused?'pacing':'headers');
 }
});
test('throwing journal observer cannot replace normal provider error or change request/pacer behavior',async()=>{
 const alter=k=>k==='ads_data'?{status:400,raw:{error:{code:100,message:CANARY}}}:null;
 const f=fixture({alter}),b=fixture({alter,base:true}),c=await capture(f.run,{throwObserver:true}),original=await capture(b.run);assert.equal(c.error.code,original.error.code);assert.equal(c.lines.length,0);assert.deepEqual(f.calls,b.calls);assert.deepEqual([...f.state],[...b.state]);
 const success=fixture(),baseline=fixture({base:true}),good=await capture(success.run,{throwObserver:true}),prior=await capture(baseline.run);assert.ifError(good.error);assert.deepEqual(good.result,prior.result);assert.equal(good.lines.length,0);assert.deepEqual(success.calls,baseline.calls);
});
test('PageStatus empty owned-form collection is false and silent; failed PageEnable has the same safe diagnostics',async()=>{
 const f=fixture({lead:true,family:'pageStatus',alter:k=>k==='page_access'?{raw:{data:[]}}:null});
 const c=await capture(f.run);assert.ifError(c.error);assert.equal(c.result.page.has_lead_access,false);assert.equal(c.lines.length,0);assert(!f.calls.some(v=>v.path.endsWith('/leads')));
 const other=fixture({lead:true,family:'pageEnable',status:400}),failed=await capture(other.run);assert(failed.error);assert.equal(closed(failed).operation,L.OPERATIONS.pageEnable);
});
test('observer is one-shot, bounded and ignores invalid operation/assets and unsafe error/phase/code values',async()=>{
 const c=await capture(async()=>{const d=R.create({operation:A.OPERATIONS.insights,assetRef:'meta-ad_account:301'});d.phase(CANARY);d.status(999999);d.meta({code:CANARY,error_subcode:-1,message:CANARY});d.fail({code:CANARY,message:TOKEN});d.fail({code:'provider_failed'});});const e=closed(c);assert.equal(e.phase,'unknown');assert.equal(e.httpStatus,null);assert.equal(e.metaCode,null);assert.equal(e.metaSubcode,null);assert.equal(e.error,'provider_failed');
 const silent=await capture(async()=>{for(const input of [{operation:CANARY,assetRef:'meta-ad_account:301'},{operation:A.OPERATIONS.ads,assetRef:CANARY},{operation:L.OPERATIONS.receiptAccept,assetRef:'meta-facebook_page:401'},{operation:L.OPERATIONS.challenge,assetRef:'meta-facebook_page:401'}])R.create(input).fail({code:'provider_failed'});});assert.equal(silent.lines.length,0);
 const internal=await capture(async()=>R.create({operation:A.OPERATIONS.ads,assetRef:'meta-ad_account:301'}).fail({code:'internal_error',message:CANARY}));assert.equal(closed(internal).error,'internal_error');
});
test('only two booleans may describe already-observed debug scopes; unobserved or malformed arrays remain null',async()=>{
 const c=await capture(async()=>{const d=R.create({operation:A.OPERATIONS.ads,assetRef:'meta-ad_account:301'});d.scopes(['ads_read','ads_management','unrelated_scope']);d.fail({code:'provider_failed'});});
 assert.deepEqual(closed(c).debugScopes,{hasAdsReadScope:true,hasAdsManagementScope:true});assert(!c.lines[0].includes('unrelated_scope'));
 for(const scopes of [undefined,[CANARY],Array.from({length:65},()=>CANARY)]){const r=await capture(async()=>{const d=R.create({operation:A.OPERATIONS.ads,assetRef:'meta-ad_account:301'});d.scopes(scopes);d.fail({code:'provider_failed'});});assert.equal(closed(r).debugScopes,null);}
});
test('application debug authentication cannot classify the inspected primary credential as revoked',async()=>{
 for(const lead of [false,true])for(const code of [190,102]){
  const f=fixture({lead,family:lead?'pageStatus':'campaigns',alter:k=>k==='user_debug'?{status:400,raw:{error:{code,error_subcode:123,message:CANARY}}}:null});
  const c=await capture(f.run),e=closed(c);assert.equal(c.error.code,'secret_unavailable');assert.equal(e.credentialContext,'application');
  assert.equal(e.phase,'before_credential_http');assert.equal(e.metaCode,code);assert.equal(e.metaSubcode,123);assert.equal(f.calls.length,1);
 }
});
test('an invalid inspected primary or rejection authenticating with that primary still closes credential access',async()=>{
 for(const lead of [false,true]){
  const family=lead?'pageStatus':'campaigns';
  const invalid=fixture({lead,family,alter:(k,v)=>k==='user_debug'?{raw:{data:{...v.data,is_valid:false}}}:null}),c=await capture(invalid.run);
  assert.equal(c.error.code,'credential_revoked');assert.equal(closed(c).credentialContext,'primary');assert.equal(invalid.calls.length,1);
  const data=fixture({lead,family,alter:k=>k===(lead?'derive_page':'ads_data')?{status:400,raw:{error:{code:190,error_subcode:460,message:CANARY}}}:null}),d=await capture(data.run),e=closed(d);
  assert.equal(d.error.code,'credential_revoked');assert.equal(e.credentialContext,'primary');assert.equal(e.metaSubcode,460);
 }
});
test('derived Page failures and its inspector authentication do not revoke the primary credential',async()=>{
 for(const [kind,expected,context]of [['page_identity','provider_unauthorized','page'],['page_access','provider_unauthorized','page'],['page_debug','secret_unavailable','application']]){
  const f=fixture({lead:true,family:'pageStatus',alter:k=>k===kind?{status:400,raw:{error:{code:190,error_subcode:463,message:CANARY}}}:null}),c=await capture(f.run),e=closed(c);
  assert.equal(c.error.code,expected);assert.equal(e.credentialContext,context);assert.equal(e.metaCode,190);assert.equal(e.metaSubcode,463);
 }
 const f=fixture({lead:true,family:'pageStatus',alter:(k,v)=>k==='page_debug'?{raw:{data:{...v.data,expires_at:(AT-1000)/1000}}}:null}),c=await capture(f.run);
 assert.equal(c.error.code,'provider_unauthorized');assert.equal(closed(c).phase,'page_token_debug_validation');assert.equal(c.events[0].credentialContext,'page');
});
test('a shorter future validity allows the current bounded read without declaring revocation or modifying stored metadata',async()=>{
 for(const lead of [false,true]){
  const f=fixture({lead,family:lead?'pageStatus':'campaigns',alter:(k,v)=>k==='user_debug'?{raw:{data:{...v.data,expires_at:(AT+1800000)/1000}}}:null});
  const before=JSON.stringify(f.metadata),c=await capture(f.run);assert.ifError(c.error);assert(c.result);assert.equal(c.lines.length,0);
  assert.equal(JSON.stringify(f.metadata),before);assert(f.calls.length>1);
  const expired=fixture({lead,family:lead?'pageStatus':'campaigns',alter:(k,v)=>k==='user_debug'?{raw:{data:{...v.data,expires_at:(AT-1000)/1000}}}:null}),d=await capture(expired.run);
  assert.equal(d.error.code,'credential_revoked');assert.equal(closed(d).credentialContext,'primary');assert.equal(expired.calls.length,1);
 }
});
test('a primary expiry observed after data I/O still prevents returning the result',async()=>{
 for(const lead of [false,true]){
  let inspections=0;const f=fixture({lead,family:lead?'pageStatus':'campaigns',alter:(k,v)=>k==='user_debug'&&++inspections===2?{raw:{data:{...v.data,expires_at:(AT-1000)/1000}}}:null}),c=await capture(f.run),e=closed(c);
  assert.equal(c.result,undefined);assert.equal(c.error.code,'credential_revoked');assert.equal(e.phase,'after_credential_validation');assert.equal(e.credentialContext,'primary');
 }
});
test('all provider-reading Lead families retain bounded codes and subcodes without recording webhook bodies or contacts',async()=>{
 for(const operation of Object.values(L.OPERATIONS).filter(op=>!L.RECEPTION_OPERATIONS.includes(op))){
  const c=await capture(async()=>{const d=R.create({operation,assetRef:'meta-facebook_page:401'});d.credential('page');d.status(400);d.meta({code:190,error_subcode:463,message:CANARY,access_token:TOKEN});d.fail({code:'provider_unauthorized',message:CANARY});}),e=closed(c);
  assert.equal(e.operation,operation);assert.equal(e.metaCode,190);assert.equal(e.metaSubcode,463);assert.equal(e.credentialContext,'page');
 }
});
test('strict Ads pagination failures expose fixed booleans only and never fetch or record the provider next URL',async()=>{
 const next=()=>({data:[row('campaigns')],paging:{cursors:{after:'QA_AFTER'},next:'https://graph.facebook.com/v24.0/act_301/campaigns?after=QA_AFTER'}});
 const cases=[['urlInvalid',v=>v.paging.next='%%%'+CANARY],['protocolRejected',v=>v.paging.next=v.paging.next.replace('https:','http:')],
  ['hostRejected',v=>v.paging.next=v.paging.next.replace('graph.facebook.com','foreign.example.invalid')],['authorityRejected',v=>v.paging.next=v.paging.next.replace('graph.facebook.com','user:private@graph.facebook.com')],
  ['fragmentRejected',v=>v.paging.next+='#'+CANARY],['pathMismatch',v=>v.paging.next=v.paging.next.replace('/campaigns?','/ads?')],
  ['cursorMissing',v=>delete v.paging.cursors.after],['cursorMalformed',v=>v.paging.cursors.after='bad cursor'],['cursorUrlMismatch',v=>v.paging.cursors.after='OTHER_AFTER'],
  ['emptyPage',v=>v.data=[]],['credentialReflection',v=>{v.paging.cursors.after=TOKEN;v.paging.next='https://graph.facebook.com/v24.0/act_301/campaigns?after='+TOKEN;}]];
 for(const [flag,change]of cases){const raw=next();change(raw);const f=fixture({family:'campaigns',alter:k=>k==='ads_data'?{raw}:null}),c=await capture(f.run),e=closed(c);
  assert.equal(c.error.code,'provider_failed');assert.equal(e.phase,'pagination');assert.equal(e.pagination[flag],true);assert(Object.values(e.pagination).every(v=>typeof v==='boolean'));
  assert.equal(f.calls.filter(v=>v.path.endsWith('/campaigns')).length,1);assert(!c.lines[0].includes('QA_AFTER'));assert(!c.lines[0].includes('foreign.example.invalid'));
 }
 for(const [flag,state]of [['cursorRepeated',{after:'QA_AFTER',pages:1,startDate:null,endDate:null}],['pageLimitReached',{after:'EARLIER_AFTER',pages:1999,startDate:null,endDate:null}]]){
  const f=fixture({family:'campaigns',cursorState:state,alter:k=>k==='ads_data'?{raw:next()}:null}),c=await capture(f.run);assert.equal(c.error.code,'provider_failed');assert.equal(closed(c).pagination[flag],true);
 }
 const good=fixture({family:'campaigns',alter:k=>k==='ads_data'?{raw:next()}:null}),ok=await capture(good.run);assert.ifError(ok.error);assert.equal(ok.result.nextPageToken,'A'.repeat(64));assert.equal(ok.lines.length,0);
});
test('Lead destinations retain the same strict pagination and safe failure flags',async()=>{
 const raw={data:[{id:'603',account_id:'301',campaign_id:'601',adset_id:'602',effective_status:'ACTIVE',creative:{id:'604',object_story_spec:{page_id:'401',link_data:{call_to_action:{value:{lead_gen_form_id:'702'}}}}}}],
  paging:{cursors:{after:'QA_AFTER'},next:'https://foreign.example.invalid/v24.0/act_301/ads?after=QA_AFTER&access_token='+TOKEN}};
 const f=fixture({lead:true,family:'destinations',alter:k=>k==='ads_data'?{raw}:null}),c=await capture(f.run),e=closed(c);assert.equal(c.error.code,'provider_failed');assert.equal(e.phase,'pagination');assert.equal(e.pagination.hostRejected,true);assert.equal(e.credentialContext,'primary');
 assert(!f.calls.some(v=>v.path.includes('foreign')));assert(!c.lines[0].includes('QA_AFTER'));
});
test('Ads path variants are closed diagnostics and never allow aliases, other versions, accounts or edges',async()=>{
 const cases=[['/v24.0/301/ads','numeric_account'],['/act_301/ads','versionless_same_account'],['/301/ads','versionless_same_account'],
  ['/v23.0/301/ads','other'],['/v23.0/act_301/ads','other'],['/v24.0/302/ads','other'],['/v24.0/301/campaigns','other'],
  ['/v24.0/act_301/ads/','other'],['/v24.0/301%2Fads','other']];
 for(const [pathname,variant]of cases){
  const raw={data:[row('ads')],paging:{cursors:{after:'QA_AFTER'},next:`https://graph.facebook.com${pathname}?after=QA_AFTER&access_token=${TOKEN}`}};
  const f=fixture({family:'ads',alter:k=>k==='ads_data'?{raw}:null}),c=await capture(f.run),e=closed(c);
  assert.equal(c.error.code,'provider_failed');assert.equal(e.phase,'pagination');assert.equal(e.pagination.pathMismatch,true);assert.equal(e.paginationPathVariant,variant);
  assert.equal(f.calls.filter(v=>v.path.endsWith('/ads')).length,1);assert(!c.lines[0].includes('QA_AFTER'));assert(!c.lines[0].includes(pathname));
 }
 const exact={data:[row('ads')],paging:{cursors:{after:'QA_AFTER'},next:'https://graph.facebook.com/v24.0/act_301/ads?after=QA_AFTER#private'}};
 const f=fixture({family:'ads',alter:k=>k==='ads_data'?{raw:exact}:null}),c=await capture(f.run),e=closed(c);
 assert.equal(c.error.code,'provider_failed');assert.equal(e.pagination.pathMismatch,false);assert.equal(e.pagination.fragmentRejected,true);assert.equal(e.paginationPathVariant,'exact');
});
test('Ads path shape qualifies public versions, account equality and fixed edges without exposing path values',async()=>{
 const cases=[['/v25.0/act_301/ads',{version:'v25.0',versionRelation:'other',account:'same_act',edge:'ads',edgeMatches:true,trailingSlash:false,canonicalPattern:true}],
  ['/v24.0/301/ads',{version:'v24.0',versionRelation:'current',account:'same_numeric',edge:'ads',edgeMatches:true,canonicalPattern:true}],
  ['/v24.0/act_302/ads',{account:'other_numeric',edge:'ads',edgeMatches:true,canonicalPattern:true}],
  ['/act_301/ads/',{version:null,versionRelation:'versionless',account:'same_act',edge:'ads',edgeMatches:true,trailingSlash:true,canonicalPattern:true}],
  ['/v24.0/act_301/ads/',{segmentCount:3,emptySegments:false,account:'same_act',trailingSlash:true,canonicalPattern:true}],
  ['/v24.0//act_301/ads',{emptySegments:true,account:'missing',edge:null,edgeMatches:false,canonicalPattern:false}],
  ['/v24.0/%61ct_301/ads',{percentEncoding:true,account:'other',edge:'ads',edgeMatches:true,canonicalPattern:false}],
  ['/v24.0/act_301/campaigns',{account:'same_act',edge:'campaigns',edgeMatches:false,canonicalPattern:true}],
  ['/v24.0/act_301/'+CANARY,{account:'same_act',edge:null,edgeMatches:false,canonicalPattern:false}]];
 for(const [pathname,expected]of cases){
  const raw={data:[row('ads')],paging:{cursors:{after:'QA_AFTER'},next:`https://graph.facebook.com${pathname}?after=QA_AFTER&access_token=${TOKEN}`}};
  const f=fixture({family:'ads',alter:k=>k==='ads_data'?{raw}:null}),c=await capture(f.run),e=closed(c);
  assert.equal(c.error.code,'provider_failed');assert.equal(e.pagination.pathMismatch,true);
  for(const [key,value]of Object.entries(expected))assert.equal(e.paginationPathShape[key],value);
  const shape=JSON.stringify(e.paginationPathShape);
  assert(!c.lines[0].includes(pathname));assert(!shape.includes('301'));assert(!shape.includes('302'));assert(!c.lines[0].includes('QA_AFTER'));
  assert.equal(f.calls.filter(v=>v.path.endsWith('/ads')).length,1);
 }
});
test('diagnostic pagination and credential context reject unsafe values rather than copying provider data',async()=>{
 const c=await capture(async()=>{const d=R.create({operation:A.OPERATIONS.ads,assetRef:'meta-ad_account:301'});d.credential(CANARY);d.pagination({hostRejected:CANARY,provider:CANARY});d.paginationPathVariant(CANARY);d.paginationPathShape({version:CANARY});d.fail({code:'provider_failed'});}),e=closed(c);
 assert.equal(e.credentialContext,null);assert.equal(e.pagination,null);assert.equal(e.paginationPathVariant,null);assert.equal(e.paginationPathShape,null);
});
test('a real closed fd2 cannot emit an asynchronous stream error or replace the original failure',()=>{
 const code=`const fs=require('node:fs'),assert=require('node:assert/strict'),R=require(${JSON.stringify(require.resolve('../src/meta-marketing-read-diagnostics'))});fs.closeSync(2);const original=Object.assign(Error('FICTITIOUS_ORIGINAL'),{code:'provider_failed'});let preserved=false;try{throw original;}catch(error){R.create({operation:'meta.marketing.ads.insights.read.v1',assetRef:'meta-ad_account:301'}).fail(error);preserved=error===original&&error.code==='provider_failed';}process.stdout.write(JSON.stringify({preserved,completed:true})+'\\n');`;
 const child=spawnSync(process.execPath,['--eval',code],{encoding:'utf8',timeout:5000});assert.equal(child.status,0);assert.equal(child.signal,null);assert.equal(child.stderr,'');assert.deepEqual(JSON.parse(child.stdout),{preserved:true,completed:true});
});
