'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {pollOnce}=require('../whatsapp-inbox-consumer');
function fixture(){
 const calls=[],imports=[],health=[];let config={version:1,scopes:[{assetId:1,wabaId:'101',phoneId:'201',clinicIds:[71]}]};
 const client={request:async(method,path,body)=>{calls.push({method,path,body});
  if(path==='/pending')return {status:200,data:{automaticActionsAllowed:false,receipts:[{receipt:'receipt'}]}};
  if(path==='/lease')return {status:200,data:{receipt:'receipt',lease:'lease',receivedAt:Date.now()-300000,rawBase64:Buffer.from('FICTITIOUS').toString('base64')}};
  if(path==='/confirm')return {status:200,data:{businessProcessed:true}};return {status:200};}};
 const options={env:{},scope:{clinicId:19},requiresScoped:true,recoveryNotBefore:'2026-09-22T14:00:37Z',
  loadConfiguration:()=>config,publish:(_,s)=>health.push(s),importScoped:async(c,lease,s,{loadConfiguration})=>{
   assert.deepEqual(s,loadConfiguration());imports.push({config:s,lease});return {importReceipt:'committed'};
  }};
 return {calls,imports,health,options,client,setConfig:c=>{config=c},poll:()=>pollOnce({},client,options)};
}
test('new activation is visible on the next poll without restarting and stale messages remain passive',async()=>{
 const f=fixture();await f.poll();const expanded={version:1,scopes:[...f.imports[0].config.scopes,{assetId:2,wabaId:'102',phoneId:'202',clinicIds:[72,73]}]};
 f.setConfig(expanded);await f.poll();
 assert.equal(f.imports[0].config.scopes.length,1);assert.equal(f.imports[1].config.scopes.length,2);
 assert.equal(f.health[1].length,2);assert.equal(f.calls.filter(c=>c.path==='/confirm').length,2);
 assert(f.imports.every(i=>i.lease.recoveryWithoutAutomation));assert(f.imports.every(i=>i.lease.raw.every(b=>b===0)));
});
test('a freshly restored receipt remains passive even inside the fresh-inbound window',async()=>{
 const f=fixture();f.options.recoveryNotBefore=null;
 const request=f.client.request;
 f.client.request=async(method,path,body)=>path==='/lease'
  ? {status:200,data:{receipt:'receipt',lease:'lease',receivedAt:Date.now(),recoveryWithoutAutomation:true,
   rawBase64:Buffer.from('FICTITIOUS').toString('base64')}}
  : request(method,path,body);
 await f.poll();assert.equal(f.imports[0].lease.recoveryWithoutAutomation,true);
 assert.equal(f.calls.filter(c=>c.path==='/confirm').length,1);
});
test('a missing or unreadable scoped catalogue fails before leasing and never falls back to the pilot',async()=>{
 const f=fixture();await f.poll();f.calls.length=0;f.setConfig(null);await assert.rejects(f.poll(),/configuration_invalid/);assert.equal(f.calls.length,0);
 f.options.loadConfiguration=()=>{throw Error('unreadable')};await assert.rejects(f.poll(),/unreadable/);assert.equal(f.calls.length,0);
});
test('configuration drift inside a batch defers without acknowledging, then a fresh poll imports',async()=>{
 const f=fixture();const normal=f.options.importScoped;f.options.importScoped=async()=>{f.setConfig({version:1,scopes:[{assetId:3,wabaId:'103',phoneId:'203',clinicIds:[74]}]});throw Object.assign(Error('changed'),{inboxReason:'import_retry'})};
 await f.poll();assert.equal(f.calls.filter(c=>c.path==='/confirm').length,0);assert.equal(f.calls.at(-1).body.reason,'import_retry');
 f.options.importScoped=normal;await f.poll();assert.equal(f.imports[0].config.scopes[0].assetId,3);assert.equal(f.calls.filter(c=>c.path==='/confirm').length,1);
});
test('poll failures expose only a bounded technical stage and never raw provider details',async()=>{
 const f=fixture();f.client.request=async()=>{throw Error('private provider detail')};
 await assert.rejects(f.poll(),error=>error.code==='inbox_pending_transport_unavailable'
  && error.pollStage==='pending'&&!error.message.includes('private'));
 f.client.request=async()=>({status:503,data:{secret:'private'}});
 await assert.rejects(f.poll(),error=>error.code==='inbox_pending_http_error'
  && error.httpStatus===503&&!error.message.includes('private'));
 f.client.request=async()=>({status:200,data:{automaticActionsAllowed:false,receipts:[]}});
 f.options.publish=()=>{throw Error('private filesystem detail')};
 await assert.rejects(f.poll(),error=>error.code==='inbox_health_publish_failed'
  && error.pollStage==='health'&&!error.message.includes('private'));
});
