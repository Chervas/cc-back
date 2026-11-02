'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createService}=require('../../services/whatsappQueueResolution.service');
test('authorization invokes the existing resume once, using the administrator and saved queue',async()=>{
 const calls=[];
 const service=createService({governance:{resolvePausedQueue:async()=>{calls.push('approved');return{success:true,queue_id:855,decision:'authorized'};}},
 queues:{mutateSendQueue:async request=>{assert.deepEqual(request,{userId:1,queueId:'marketing:855',action:'resume'});calls.push('resume');return{dispatch:{status:'scheduled',next_allowed_at:'2026-11-03T09:00:00Z'}};}}});
 const r=await service.resolve({listId:855,decision:'authorized',adminUserId:1});assert.deepEqual(calls,['approved','resume']);assert.equal(r.resumption.status,'resumed');assert.equal(r.resumption.dispatch_status,'scheduled');
});
for(const decision of ['changes_required','cancelled'])test(decision+' never resumes',async()=>{
 const service=createService({governance:{resolvePausedQueue:async()=>({decision})},queues:{mutateSendQueue:()=>assert.fail('must not resume')}});
 assert.equal((await service.resolve({decision})).resumption,undefined);
});
test('rejected approval never resumes; blocked sender retains approval; uncertain response never retries',async()=>{
 let attempts=0;
 const queues={mutateSendQueue:async()=>{attempts++;throw Object.assign(Error('Sender blocked'),{status:409});}};
 let service=createService({governance:{resolvePausedQueue:async()=>{throw Object.assign(Error('already resolved'),{status:409})}},queues});
 await assert.rejects(service.resolve({}),{status:409});assert.equal(attempts,0);
 const governance={resolvePausedQueue:async()=>({success:true,queue_id:855,decision:'authorized'})};service=createService({governance,queues});
 const blocked=await service.resolve({adminUserId:1});assert.equal(blocked.success,true);assert.equal(blocked.resumption.status,'blocked');assert.equal(attempts,1);
 queues.mutateSendQueue=async()=>{attempts++;throw Error('Timeout after commit');};
 assert.equal((await service.resolve({adminUserId:1})).resumption.status,'unconfirmed');assert.equal(attempts,2);
});
