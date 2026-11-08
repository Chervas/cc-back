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
function fixture({family='insights',lead=false,alter,base=false,paused=false,status=200}={}){
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
   else if(u.pathname==='/v24.0/401'){kind='page_access';raw={id:'401',has_lead_access:{can_access_lead:true,app_has_leads_permission:true,user_has_leads_permission:true,page_id:'401'}};}
   else{kind='ads_data';raw={data:[row(family)]};}
   if(!['user_debug','page_debug'].includes(kind))code=status;
   const changed=alter?.(kind,raw,u);if(changed){raw=changed.raw??raw;code=changed.status??code;}
   const res=new PassThrough();res.statusCode=code;res.headers={'content-type':'application/json'};cb(res);res.end(JSON.stringify(raw));
  });return req;};
 const module=base?require(BASE+(lead?'meta-marketing-leads-http':'meta-marketing-ads-http')):lead?LEADS:ADS;
 const http=(lead?module.createMetaMarketingLeadsHttp:module.createMetaMarketingAdsHttp)({request,pacer,cursor:{open(){throw Error('No cursor');},seal(){throw Error('No cursor');}},now:()=>clock});
 const operation=lead?L.OPERATIONS[family]:A.OPERATIONS[family],payload=lead?{adAccountAssetRef:account.assetRef,...(family==='pageEnable'?{expectedSubscriptionRevision:'a'.repeat(64)}:{})}:['insights','actions'].includes(family)?{pageToken:null,startDate:'2026-11-07',endDate:'2026-11-07'}:{pageToken:null};
 const input={binding,metadata,token:Buffer.from(TOKEN),appSecret:Buffer.from(APP),asset:lead?page:account,...(lead?{account}:{}),operation,payload,signal:new AbortController().signal,authorize(){},context:{principalId:'staging:meta-marketing',tenantRef:'clinic:71',policyVersion:'qa:diagnostic'}};
 return{run:()=>http.read(input),calls,pacer,state:map,operation,assetRef:input.asset.assetRef};
}
async function capture(work,{throwObserver=false}={}){
 const write=fs.writeSync,lines=[];let result,error;
 fs.writeSync=function(fd,chunk,...args){if(fd!==2)return write.call(this,fd,chunk,...args);if(throwObserver)throw Object.assign(Error(CANARY),{code:'EPIPE'});lines.push(String(chunk));return Buffer.byteLength(String(chunk));};
 try{result=await work();}catch(e){error=e;}finally{fs.writeSync=write;}
 return{result,error,lines,events:lines.map(s=>JSON.parse(s))};
}
function closed(c){assert.equal(c.lines.length,1);assert(Buffer.byteLength(c.lines[0])<=2048);assert(!c.lines[0].includes(CANARY));assert(!c.lines[0].includes(TOKEN));assert(!c.lines[0].includes(APP));
 const e=c.events[0];assert.deepEqual(Object.keys(e).sort(),['assetRef','debugScopes','error','event','httpStatus','metaCode','metaSubcode','operation','phase','shape','stage','version'].sort());assert.equal(e.event,R.EVENT);return e;}
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
test('PageStatus HasLeadAccess failure records types/presence only; no reason text or unknown names',async()=>{
 const f=fixture({lead:true,family:'pageStatus',alter:k=>k==='page_access'?{raw:{id:'401',has_lead_access:{failure_reason:CANARY,[CANARY]:TOKEN}}}:null}),c=await capture(f.run),e=closed(c);
 assert.equal(c.error.code,'provider_failed');assert.equal(e.phase,'page_access_projection');assert.equal(e.httpStatus,200);assert.equal(e.shape.kind,'page_access');assert.equal(e.shape.fields.can_access_lead,'missing');assert.equal(e.shape.fields.failure_reason,'string_ok');assert.equal(e.shape.unknownKeysPresent,true);assert(!f.calls.some(v=>v.path.endsWith('/subscribed_apps')));
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
test('PageStatus valid false access is successful and silent; other Leads operations never emit this event',async()=>{
 const f=fixture({lead:true,family:'pageStatus',alter:k=>k==='page_access'?{raw:{id:'401',has_lead_access:{can_access_lead:false}}}:null}),b=fixture({lead:true,family:'pageStatus',base:true,alter:k=>k==='page_access'?{raw:{id:'401',has_lead_access:{can_access_lead:false}}}:null});
 const c=await capture(f.run),original=await capture(b.run);assert.ifError(c.error);assert.equal(c.result.page.has_lead_access,false);assert.equal(c.lines.length,0);assert.deepEqual(c.result,original.result);assert.deepEqual(f.calls,b.calls);
 const other=fixture({lead:true,family:'pageEnable',status:400}),failed=await capture(other.run);assert(failed.error);assert.equal(failed.lines.length,0);
});
test('observer is one-shot, bounded and ignores invalid operation/assets and unsafe error/phase/code values',async()=>{
 const c=await capture(async()=>{const d=R.create({operation:A.OPERATIONS.insights,assetRef:'meta-ad_account:301'});d.phase(CANARY);d.status(999999);d.meta({code:CANARY,error_subcode:-1,message:CANARY});d.fail({code:CANARY,message:TOKEN});d.fail({code:'provider_failed'});});const e=closed(c);assert.equal(e.phase,'unknown');assert.equal(e.httpStatus,null);assert.equal(e.metaCode,null);assert.equal(e.metaSubcode,null);assert.equal(e.error,'provider_failed');
 const silent=await capture(async()=>{for(const input of [{operation:CANARY,assetRef:'meta-ad_account:301'},{operation:A.OPERATIONS.ads,assetRef:CANARY},{operation:L.OPERATIONS.pageEnable,assetRef:'meta-facebook_page:401'}])R.create(input).fail({code:'provider_failed'});});assert.equal(silent.lines.length,0);
 const internal=await capture(async()=>R.create({operation:A.OPERATIONS.ads,assetRef:'meta-ad_account:301'}).fail({code:'internal_error',message:CANARY}));assert.equal(closed(internal).error,'internal_error');
});
test('only two booleans may describe already-observed debug scopes; unobserved or malformed arrays remain null',async()=>{
 const c=await capture(async()=>{const d=R.create({operation:A.OPERATIONS.ads,assetRef:'meta-ad_account:301'});d.scopes(['ads_read','ads_management','unrelated_scope']);d.fail({code:'provider_failed'});});
 assert.deepEqual(closed(c).debugScopes,{hasAdsReadScope:true,hasAdsManagementScope:true});assert(!c.lines[0].includes('unrelated_scope'));
 for(const scopes of [undefined,[CANARY],Array.from({length:65},()=>CANARY)]){const r=await capture(async()=>{const d=R.create({operation:A.OPERATIONS.ads,assetRef:'meta-ad_account:301'});d.scopes(scopes);d.fail({code:'provider_failed'});});assert.equal(closed(r).debugScopes,null);}
});
test('a real closed fd2 cannot emit an asynchronous stream error or replace the original failure',()=>{
 const code=`const fs=require('node:fs'),assert=require('node:assert/strict'),R=require(${JSON.stringify(require.resolve('../src/meta-marketing-read-diagnostics'))});fs.closeSync(2);const original=Object.assign(Error('FICTITIOUS_ORIGINAL'),{code:'provider_failed'});let preserved=false;try{throw original;}catch(error){R.create({operation:'meta.marketing.ads.insights.read.v1',assetRef:'meta-ad_account:301'}).fail(error);preserved=error===original&&error.code==='provider_failed';}process.stdout.write(JSON.stringify({preserved,completed:true})+'\\n');`;
 const child=spawnSync(process.execPath,['--eval',code],{encoding:'utf8',timeout:5000});assert.equal(child.status,0);assert.equal(child.signal,null);assert.equal(child.stderr,'');assert.deepEqual(JSON.parse(child.stdout),{preserved:true,completed:true});
});
