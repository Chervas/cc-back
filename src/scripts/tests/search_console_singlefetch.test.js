'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test=require('node:test'),assert=require('node:assert/strict');
const {searchConsoleFixture}=require('./fixtures/search_console_broker.fixture');
const {loadBusinessProfileJobs}=require('./fixtures/business_profile_jobs.fixture');
const {createSearchConsoleOperations}=require('../../../services/integrations-broker/src/google-search-console');
const C=require('../../../services/integrations-broker/src/google-search-console-contract');
const I=require('../../lib/searchConsoleIngest'),credentials=require('../../services/googleLegacyCredentials.service');
const range={startDate:'2026-09-01',endDate:'2026-09-02'};
const row=(date,i)=>({keys:[date,'consulta unicode á漢 '+i,'https://example.invalid/'+i],clicks:1,impressions:3,ctr:1/3,position:1.125});
function genuineBridge(makeRows){
 const f=searchConsoleFixture(),httpCalls=[],rpcCalls=[];
 const ops=createSearchConsoleOperations({http:async req=>{httpCalls.push(req.json);return{rows:makeRows(req.json)};},cursor:{open:()=>assert.fail('No cursor expected in single-fetch mode'),seal:()=>assert.fail('No cursor expected in single-fetch mode')}});
 const service=f.create({client:{execute:async command=>{rpcCalls.push(command);const op=ops[command.operation],data=await op.execute({...command,binding:{searchConsoleSites:[{siteUrl:f.mapping.siteUrl,assetRef:f.mapping.broker_read_asset_ref}]},secret:{accessToken:'FICTIONAL_NON_PROVIDER_SECRET'}});return{data:op.project(data)};}}});
 return{f,service,httpCalls,rpcCalls};
}
test('genuine SC operation + contract + facade returns exact25000 in ONE upstream/RPC and signals saturation',async()=>{
 const b=genuineBridge(req=>Array.from({length:25000},(_,i)=>row(req.startDate,i))),ctx=await b.service.prepare(b.f.mapping);
 const result=await b.service.read(b.f.mapping,ctx,'queries',range);
 assert.equal(C.PAGE_SIZE,C.MAX_ROWS);assert.equal(result.data.rows.length,25000);assert.equal(result.data.rowLimitReached,true);assert.equal(b.rpcCalls.length,1);assert.equal(b.httpCalls.length,1);assert.equal(b.httpCalls[0].rowLimit,25000);assert.equal(b.httpCalls[0].startRow,0);assert.deepEqual(b.httpCalls[0].dimensions,['date','query','page']);assert(Buffer.byteLength(JSON.stringify(result.data))>1048576);
});
test('stock interval reader discards capped parent and reads each day; a capped day remains terminal',async()=>{
 const b=genuineBridge(req=>Array.from({length:req.startDate===req.endDate?1:25000},(_,i)=>row(req.startDate,i))),ctx=await b.service.prepare(b.f.mapping);
 const read=I.createQueryIntervalReader({read:(_asset,_credentials,family,payload,options)=>b.service.read(b.f.mapping,ctx,family,payload,options),validate:async()=>{assert(await b.service.prepare(b.f.mapping));},now:()=>b.f.state.at});
 const result=await read(b.f.mapping,{brokerContext:ctx},{s:range.startDate,e:range.endDate});assert.equal(result.length,2);assert(result.every(x=>x.rows.length===1));assert.equal(b.rpcCalls.length,3);assert.deepEqual(b.httpCalls.map(x=>[x.startDate,x.endDate]),[[range.startDate,range.endDate],[range.startDate,range.startDate],[range.endDate,range.endDate]]);
 const d=genuineBridge(req=>Array.from({length:25000},(_,i)=>row(req.startDate,i))),dc=await d.service.prepare(d.f.mapping),daily=I.createQueryIntervalReader({read:(_a,_c,family,payload,options)=>d.service.read(d.f.mapping,dc,family,payload,options),validate:async()=>{assert(await d.service.prepare(d.f.mapping));},now:()=>d.f.state.at});
 await assert.rejects(daily(d.f.mapping,{brokerContext:dc},{s:range.startDate,e:range.startDate}),{code:'search_console_interval_truncated'});assert.equal(d.rpcCalls.length,1);
});
test('single-fetch intra-response duplicates and25001 rows remain invalid, without retry/deduplication',async()=>{
 for(const mode of ['duplicate','oversized']){const b=genuineBridge(req=>mode==='duplicate'?[row(req.startDate,1),row(req.startDate,1)]:Array.from({length:25001},(_,i)=>row(req.startDate,i))),ctx=await b.service.prepare(b.f.mapping);await assert.rejects(b.service.read(b.f.mapping,ctx,'queries',range),{code:'provider_failed'});assert.equal(b.rpcCalls.length,1);}
});
test('typed provider_timeout retry uses1s/2s backoff, max3 dispatches, fresh authority and remaining deadline',async()=>{
 const f=searchConsoleFixture(),times=[],ctx=await f.service.prepare(f.mapping);let attempts=0;
 f.state.response=()=>{times.push(f.state.at);if(attempts++<2)throw Object.assign(Error('provider_timeout'),{code:'provider_timeout'});return{rows:[row(range.startDate,1)],nextPageToken:null,rowLimitReached:false};};
 assert.equal((await f.service.read(f.mapping,ctx,'queries',range)).data.rows.length,1);assert.deepEqual(times.map(x=>x-times[0]),[0,1000,3000]);assert.equal(f.state.calls.length,3);
 const fail=searchConsoleFixture(),fc=await fail.service.prepare(fail.mapping);fail.state.response=()=>{throw Object.assign(Error('provider_timeout'),{code:'provider_timeout'});};await assert.rejects(fail.service.read(fail.mapping,fc,'queries',range),{code:'provider_timeout'});assert.equal(fail.state.calls.length,3);
 const revoke=searchConsoleFixture(),svc=revoke.create({pause:async ms=>{revoke.state.at+=ms;revoke.state.record.state='blocked';}}),rc=await svc.prepare(revoke.mapping);revoke.state.response=()=>{throw Object.assign(Error('provider_timeout'),{code:'provider_timeout'});};await assert.rejects(svc.read(revoke.mapping,rc,'queries',range),{code:'broker_binding_invalid'});assert.equal(revoke.state.calls.length,1);
 const budget=searchConsoleFixture(),bc=await budget.service.prepare(budget.mapping),end=budget.state.at+500;budget.state.response=()=>{throw Object.assign(Error('provider_timeout'),{code:'provider_timeout'});};await assert.rejects(budget.service.read(budget.mapping,bc,'queries',range,{beforeExecute:()=>{if(budget.state.at>=end)throw Object.assign(Error('search_console_interval_budget_exceeded'),{code:'search_console_interval_budget_exceeded'});return{timeoutMs:end-budget.state.at};}}),{code:'search_console_interval_budget_exceeded'});assert.equal(budget.state.calls.length,1);assert.equal(budget.state.at,end);
});
test('actual web job stores only safe typed broker diagnostics and keeps failed intervals retryable without leaking error text',async()=>{
 for(const code of ['rate_limited','provider_timeout','broker_response_invalid','provider_failed','broker_unavailable','UNTRUSTED_PRIVATE_CODE']){
  const f=searchConsoleFixture(),updates=[],rows=[];
  f.state.response=command=>{if(command.operation.endsWith('queries.read.v1'))throw Object.assign(Error('UNTRUSTED_PRIVATE_TEXT'),{code});return{rows:[{keys:[command.payload.startDate],clicks:2,impressions:4,ctr:0.5,position:1}]};};
  const models={ClinicWebAsset:{findAll:async()=>[f.mapping]},SyncLog:{create:async()=>({update:async v=>updates.push(v)})},WebScDaily:{findOrCreate:async({defaults})=>{rows.push(defaults);return[null,true];}},sequelize:{transaction:async work=>work({})},WebScQueryDaily:{findAll:async()=>[],bulkCreate:async values=>rows.push(...values)},WebScDailyAgg:{findOrCreate:async({defaults})=>{rows.push(defaults);return[null,true];}}};
  const jobs=loadBusinessProfileJobs({models,searchConsole:f.service,credentials:{safe:credentials.safe,load:()=>assert.fail('Legacy token forbidden'),request:()=>assert.fail('Legacy provider HTTP forbidden')},legacyHttp:new Proxy({},{get:()=>()=>assert.fail('Legacy HTTP forbidden')}),logs:f.state.logs,env:{WEB_PSI_ENABLED:'false',WEB_SYNC_RECENT_DAYS:'1',WEB_BACKFILL_DAYS:'1'}}).metaSyncJobs;
  const result=await jobs.executeWebSync();assert.equal(result.status,'failed');assert.equal(result.retryable,true);assert(result.report.ingestion.failedIntervals>0);assert(result.report.errors.some(e=>e.phase==='queries'&&e.message===(code==='UNTRUSTED_PRIVATE_CODE'?'google_credentials_unavailable':code)));assert(!JSON.stringify(result).includes('UNTRUSTED_PRIVATE_TEXT'));assert(!JSON.stringify(result).includes('UNTRUSTED_PRIVATE_CODE'));assert.equal(updates.at(-1).status,'failed');
 }
});
