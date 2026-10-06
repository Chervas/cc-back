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
  loadConfiguration:()=>config,publish:(_,s)=>health.push(s),importScoped:async(c,lease,s,{loadConfiguration,accountSyncEnabled,playbackEnabled})=>{
   assert.deepEqual(s,loadConfiguration());imports.push({config:s,lease,accountSyncEnabled,playbackEnabled});return {importReceipt:'committed'};
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
test('resolved-review maintenance runs after new imports and never delays a full fresh batch',async()=>{
 const f=fixture();let resumed=0;
 f.options.env.WHATSAPP_INBOX_ROUTING_REVIEW_ENABLED='true';
 f.options.resumeReviews=async()=>{assert.equal(f.calls.at(-1).path,'/confirm');resumed++;throw Error('FICTITIOUS MAINTENANCE ERROR');};
 assert.equal(await f.poll(),1);assert.equal(resumed,1);
 assert.equal(f.calls.filter(c=>c.path==='/confirm').length,1);
 const request=f.client.request;
 f.client.request=async(method,path,body)=>path==='/pending'
  ? {status:200,data:{automaticActionsAllowed:false,receipts:Array.from({length:20},()=>({receipt:'receipt'}))}}
  : request(method,path,body);
 assert.equal(await f.poll(),20);assert.equal(resumed,1);
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
test('account-event rollout uses the supplied runtime flag on every poll',async()=>{
 const f=fixture();await f.poll();
 f.options.env.WHATSAPP_INBOX_ADMIN_SYNC_ENABLED='true';await f.poll();
 assert.deepEqual(f.imports.map(item=>item.accountSyncEnabled),[false,true]);
});
test('playback rollout uses the supplied runtime flag and keeps clinical recovery cuts',async()=>{
 const f=fixture();await f.poll();
 f.options.env.WHATSAPP_INBOX_PLAYBACK_ENABLED='true';await f.poll();
 assert.deepEqual(f.imports.map(item=>item.playbackEnabled),[false,true]);
 assert(f.imports.every(item=>item.lease.recoveryWithoutAutomation));
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
test('a full poll reports its bounded batch size only after every lease is committed or deferred',async()=>{
 const f=fixture();let listed=20,confirmed=0,deferred=0;
 f.client.request=async(method,path,body)=>{
  if(path==='/pending')return {status:200,data:{automaticActionsAllowed:false,receipts:Array.from({length:listed},(_,n)=>({receipt:'receipt-'+n}))}};
  if(path==='/lease')return {status:200,data:{receipt:body.receipt,lease:'lease',receivedAt:Date.now(),rawBase64:Buffer.from('FICTITIOUS').toString('base64')}};
  if(path==='/confirm'){confirmed++;return {status:200,data:{businessProcessed:true}};}
  if(path==='/defer'){deferred++;return {status:200};}
 };
 f.options.importScoped=async(_,lease)=>{
  if(lease.receipt==='receipt-3')throw Object.assign(Error('FICTITIOUS'),{inboxReason:'import_retry'});
  return {importReceipt:'committed'};
 };
 assert.equal(await f.poll(),20);assert.equal(confirmed,19);assert.equal(deferred,1);
 listed=0;assert.equal(await f.poll(),0);assert.equal(confirmed,19);
 listed=21;await assert.rejects(f.poll(),error=>error.code==='inbox_pending_invalid_response');
});
test('unsettled full batches keep the normal retry delay after a lease or defer failure',async()=>{
 const f=fixture();let failLease=true,confirmed=0;
 f.client.request=async(method,path,body)=>{
  if(path==='/pending')return {status:200,data:{automaticActionsAllowed:false,receipts:Array.from({length:20},(_,n)=>({receipt:'receipt-'+n}))}};
  if(path==='/lease')return failLease&&body.receipt==='receipt-3' ? {status:503}
   : {status:200,data:{receipt:body.receipt,lease:'lease',receivedAt:Date.now(),rawBase64:Buffer.from('FICTITIOUS').toString('base64')}};
  if(path==='/confirm'){confirmed++;return {status:200,data:{businessProcessed:true}};}
  if(path==='/defer')throw Error('FICTITIOUS');
 };
 assert.equal(await f.poll(),0);assert.equal(confirmed,19);
 failLease=false;f.options.importScoped=async(_,lease)=>{
  if(lease.receipt==='receipt-3')throw Object.assign(Error('FICTITIOUS'),{inboxReason:'import_retry'});
  return {importReceipt:'committed'};
 };
 assert.equal(await f.poll(),0);assert.equal(confirmed,38);
});
