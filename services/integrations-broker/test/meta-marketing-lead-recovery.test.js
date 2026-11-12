'use strict';
require('./offline-guard.cjs');
const test=require('node:test'),assert=require('node:assert/strict'),{randomBytes,randomUUID,createHash}=require('node:crypto'),{EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const {createMetaMarketingLeadsHttp}=require('../src/meta-marketing-leads-http'),{cursorCodec}=require('../src/provider-cursor'),L=require('../src/meta-marketing-leads-contract'),M=require('../src/meta-marketing-contract');
const AT=Date.UTC(2026,10,12,12),TOKEN='FICTITIOUS_RECOVERY_PRIMARY',PAGE_TOKEN='FICTITIOUS_RECOVERY_PAGE',APP='0123456789abcdef'.repeat(2),CONTACT='FICTITIOUS_PRIVATE_PATIENT';
const dates={startDate:'2026-11-09',endDate:'2026-11-12'};
const lead=(patch={})=>({id:'701',form_id:'702',ad_id:'603',campaign_id:'601',created_time:'2026-11-10T12:00:00+0000',is_organic:false,...patch});
function fixture(){
 let clock=AT;const calls=[],scopes=[...M.SCOPES].sort(),context={principalId:'staging:meta-marketing',tenantRef:'clinic:71',policyVersion:'qa-recovery',credentialEpoch:1,credentialVersionId:randomUUID(),credentialDigest:'d'.repeat(64)};
 const binding={provider:'meta_marketing_onboarding',connectionRef:'qa:recovery',expiresAt:AT+86400000,secretArn:'qa-slot',clientSecretArn:'qa-app',metaMarketingOAuth:{appId:'101',redirectUri:'https://example.invalid/oauth/meta/marketing/callback',appVersionId:'a'.repeat(32),slotVersionId:'s'.repeat(32),scopeKey:'group:9',clinicIds:[71,72],scopes}};
 const metadata={appId:'101',subjectId:'201',tokenType:'USER',scopes,expiresAt:null,dataAccessExpiresAt:null,granularScopes:[]};
 const account={assetRef:'meta-ad_account:301',kind:'ad_account',id:'301',parentPageId:null},asset={assetRef:'meta-facebook_page:401',kind:'facebook_page',id:'401',parentPageId:null};
 const state={list:[lead()],paging:null,formPage:'401',adAccount:'301',current:lead(),recipient:71,alter:null};
 const request=(options,cb)=>{const url=new URL('https://graph.facebook.com'+options.path);calls.push({path:url.pathname,query:Object.fromEntries(url.searchParams),bearer:options.headers.authorization});
  const req=new EventEmitter();req.destroy=()=>{};req.end=()=>queueMicrotask(()=>{try{
   assert.equal(options.hostname,'graph.facebook.com');assert.equal(options.method,'GET');assert.equal(options.rejectUnauthorized,true);let raw;
   if(url.pathname.endsWith('/debug_token')){const page=url.searchParams.get('input_token')===PAGE_TOKEN;raw={data:{app_id:'101',...(page?{type:'PAGE',profile_id:'401'}:{type:'USER',user_id:'201'}),is_valid:true,expires_at:0,data_access_expires_at:0,scopes}};}
   else if(url.pathname==='/v24.0/401')raw={id:'401',access_token:PAGE_TOKEN};
   else if(url.pathname==='/v24.0/me')raw={id:'401'};
   else if(url.pathname==='/v24.0/702')raw={id:'702',name:'Fictitious form',page_id:state.formPage,status:'ACTIVE',questions:[{key:'full_name',type:'FULL_NAME'},{key:'phone',type:'PHONE'},{key:'question',type:'CUSTOM',label:'Fictitious question'}]};
   else if(url.pathname==='/v24.0/702/leads'){assert.equal(url.searchParams.get('limit'),'20');assert(!url.searchParams.get('fields').includes('field_data'));raw={data:state.list,...(state.paging?{paging:state.paging}:{})};}
   else if(url.pathname==='/v24.0/701')raw={...state.current,...(url.searchParams.get('fields').includes('field_data')?{field_data:[{name:'full_name',values:[CONTACT]},{name:'phone',values:['+34600000000']},{name:'question',values:['FICTITIOUS_PRIVATE_ANSWER']}]}:{})};
   else if(url.pathname==='/v24.0/603')raw={id:'603',account_id:state.adAccount,campaign_id:'601',adset_id:'602'};
   else throw Error('Unexpected fixed path');
   raw=state.alter?state.alter(url,raw):raw;const res=new PassThrough();res.statusCode=200;res.headers={'content-type':'application/json'};cb(res);res.end(JSON.stringify(raw));
  }catch(error){req.emit('error',error)}});return req;};
 const http=createMetaMarketingLeadsHttp({request,cursor:cursorCodec(randomBytes(32),()=>clock),pacer:{run:async(_s,_o,work)=>work(),observe(){},usage:()=>({usagePct:0,nextAllowedAt:0,pauseUntil:0})},now:()=>clock});
 const run=(family,payload,overrides={})=>http.read({binding,metadata,token:Buffer.from(TOKEN),appSecret:Buffer.from(APP),asset,account,operation:L.OPERATIONS[family],payload:{adAccountAssetRef:account.assetRef,...payload},signal:new AbortController().signal,authorize(){},context,recipientClinicId:state.recipient,...overrides});
 const list=(patch={})=>run('recoveryList',{formId:'702',...dates,cursor:null,...patch});
 return {run,list,read:proof=>run('recoveryRead',{proof}),calls,state,context,advance:ms=>{clock+=ms}};
}
test('recovery scans a verified form with the documented lower filter, emits no contacts and reads only a sealed observed lead',async()=>{
 const f=fixture();f.state.list=[{...lead(),field_data:[{name:CONTACT,values:[CONTACT]}],unknown:CONTACT}];
 const list=await f.list();assert.equal(list.results.length,1);assert.equal(list.nextCursor,null);assert(!JSON.stringify(list).includes(CONTACT));assert(!JSON.stringify(list).includes(TOKEN));assert.equal(f.calls.filter(c=>c.query.fields?.includes('field_data')).length,0);
 const query=f.calls.find(c=>c.path==='/v24.0/702/leads').query;assert.deepEqual(JSON.parse(query.filtering),[{field:'time_created',operator:'GREATER_THAN',value:Date.UTC(2026,10,9)/1000-1}]);assert.equal(query.since,undefined);assert.equal(query.until,undefined);
 const proof=list.results[0].proof,read=await f.read(proof);assert.equal(read.recipientClinicId,71);assert.equal(read.lead.id,'701');assert.equal(read.identity.account_id,'301');assert.equal(read.form_response.version,2);assert.equal(read.form_response.fields.find(v=>v.key==='question').values[0],'FICTITIOUS_PRIVATE_ANSWER');
 assert.deepEqual(read.recovery,{proofDigest:createHash('sha256').update(proof).digest('hex'),formId:'702',...dates});assert.equal(read.lead.field_data.find(v=>v.name==='full_name').values[0],CONTACT);
 const contactIndex=f.calls.findIndex(c=>c.query.fields?.includes('field_data'));assert(contactIndex>f.calls.findIndex(c=>c.path==='/v24.0/603'));
 L.validateResponse(L.OPERATIONS.recoveryRead,read,{adAccountAssetRef:'meta-ad_account:301',proof});
});
test('inclusive UTC dates discard out-of-window metadata before proofs, without trusting the provider filter',async()=>{
 const f=fixture();f.state.list=[lead({id:'700',created_time:'2026-11-08T23:59:59Z'}),lead({created_time:'2026-11-09T00:00:00Z'}),lead({id:'703',created_time:'2026-11-12T23:59:59Z'}),lead({id:'704',created_time:'2026-11-13T00:00:00Z'})];
 const result=await f.list();assert.deepEqual(result.results.map(r=>r.leadId),['701','703']);assert(result.results.every(r=>r.proof));
});
test('invalid or over-seven-day windows and arbitrary lead IDs are rejected before provider calls',async()=>{
 const f=fixture();for(const patch of [{startDate:'2026-02-30'},{startDate:'2026-11-13'},{startDate:'2026-11-01'},{leadId:'701'},{url:'https://foreign.invalid'}])await assert.rejects(f.list(patch),{code:'invalid_request'});
 await assert.rejects(f.run('recoveryRead',{leadId:'701'}),{code:'invalid_request'});await assert.rejects(f.read('A'.repeat(64)),{code:'invalid_request'});assert.equal(f.calls.length,0);
});
test('proofs expire within the existing ten-minute codec and bind epoch, version, digest, route and principal',async()=>{
 for(const change of [f=>f.advance(600001),f=>f.context.credentialEpoch++,f=>f.context.credentialVersionId=randomUUID(),f=>f.context.credentialDigest='e'.repeat(64),f=>f.state.recipient=72,f=>f.context.principalId='another-principal',f=>f.context.policyVersion='new-policy']){
  const f=fixture(),proof=(await f.list()).results[0].proof,before=f.calls.length;change(f);await assert.rejects(f.read(proof),{code:'invalid_request'});assert.equal(f.calls.length,before);
 }
 const f=fixture(),proof=(await f.list()).results[0].proof,before=f.calls.length;await assert.rejects(f.read(proof.slice(0,-2)+'XX'),{code:'invalid_request'});assert.equal(f.calls.length,before);
});
test('a list cursor cannot serve as a read proof, or cross form/window/account/context',async()=>{
 const f=fixture();f.state.paging={cursors:{after:'QA_RECOVERY_AFTER'},next:'https://graph.facebook.com/v24.0/702/leads?after=QA_RECOVERY_AFTER'};
 const first=await f.list();assert(first.nextCursor);const before=f.calls.length;
 await assert.rejects(f.read(first.nextCursor),{code:'invalid_request'});await assert.rejects(f.list({cursor:first.results[0].proof}),{code:'invalid_request'});
 await assert.rejects(f.list({cursor:first.nextCursor,formId:'999'}),{code:'invalid_request'});await assert.rejects(f.list({cursor:first.nextCursor,startDate:'2026-11-10'}),{code:'invalid_request'});assert.equal(f.calls.length,before);
 f.state.paging=null;await f.list({cursor:first.nextCursor});assert.equal(f.calls.findLast(c=>c.path==='/v24.0/702/leads').query.after,'QA_RECOVERY_AFTER');
});
test('recovery does not read contacts if current form, ad account or observed metadata changed',async()=>{
 for(const change of [f=>f.state.formPage='999',f=>f.state.adAccount='999',f=>f.state.current=lead({created_time:'2026-11-11T00:00:00Z'}),f=>f.state.current=lead({ad_id:'999'}),f=>f.state.current=lead({form_id:'999'})]){
  const f=fixture(),proof=(await f.list()).results[0].proof;change(f);await assert.rejects(f.read(proof),{code:'scope_denied'});assert.equal(f.calls.filter(c=>c.query.fields?.includes('field_data')).length,0);
 }
});
test('organic proof retains an explicit clinic route and never fabricates a paid identity',async()=>{
 const f=fixture();f.state.current=lead({ad_id:null,campaign_id:null,is_organic:true});f.state.list=[f.state.current];const proof=(await f.list()).results[0].proof,read=await f.read(proof);assert.equal(read.identity,null);assert.equal(read.lead.is_organic,true);assert.equal(read.recipientClinicId,71);
 const ambiguous=fixture();ambiguous.state.recipient=null;await assert.rejects(ambiguous.list(),{code:'invalid_request'});assert.equal(ambiguous.calls.length,0);
});
test('filtered empty pages keep their bounded cursor but foreign pagination never yields a partial result',async()=>{
 const f=fixture();f.state.list=[lead({created_time:'2026-11-13T00:00:00Z'})];f.state.paging={cursors:{after:'QA_NEXT'},next:'https://graph.facebook.com/v24.0/702/leads?after=QA_NEXT'};
 const result=await f.list();assert.deepEqual(result.results,[]);assert(result.nextCursor);
 f.state.list=[lead()];f.state.paging.next='https://foreign.invalid/v24.0/702/leads?after=QA_NEXT';await assert.rejects(f.list(),{code:'provider_failed'});assert(!f.calls.some(c=>c.path.includes('foreign')));
});
test('closed recovery responses reject extra contacts, mixed windows and arbitrary proof digests',async()=>{
 const f=fixture(),list=await f.list(),proof=list.results[0].proof,read=await f.read(proof),payload={adAccountAssetRef:'meta-ad_account:301',proof};
 for(const change of [v=>v.extra=CONTACT,v=>v.recovery.proofDigest='f'.repeat(64),v=>v.recovery.formId='999',v=>v.recovery.endDate='2026-11-09',v=>v.recipientClinicId=null]){
  const value=structuredClone(read);change(value);assert.throws(()=>L.validateResponse(L.OPERATIONS.recoveryRead,value,payload));
 }
 const bad=structuredClone(list);bad.results[0].field_data=[CONTACT];assert.throws(()=>L.validateResponse(L.OPERATIONS.recoveryList,bad,{adAccountAssetRef:'meta-ad_account:301',formId:'702',...dates,cursor:null}));
});
