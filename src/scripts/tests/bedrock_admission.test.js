'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createBedrockAdmission}=require('../../lib/bedrockAdmission');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

test('conversation bursts wait FIFO with at most three in flight and no automatic retry',async()=>{
 const admission=createBedrockAdmission({spacingMs:0});let active=0,peak=0;const starts=[],holds=Array.from({length:12},deferred);
 const jobs=holds.map((hold,i)=>admission.run(async()=>{starts.push(i);peak=Math.max(peak,++active);await hold.promise;active--;if(i===4)throw Object.assign(Error('provider_timeout'),{code:'provider_timeout'});return i;},1000));
 const outcomes=Promise.allSettled(jobs);await tick();assert.deepEqual(starts,[0,1,2]);
 for(let i=0;i<holds.length;i++){holds[i].resolve();await tick();}
 const result=await outcomes;assert.equal(peak,3);assert.deepEqual(starts,Array.from({length:12},(_,i)=>i));
 assert.equal(result.filter(r=>r.status==='fulfilled').length,11);assert.equal(result[4].reason.code,'provider_timeout');
});

test('large UTF-8 requests reserve the complete byte budget rather than only a slot',async()=>{
 const admission=createBedrockAdmission({spacingMs:0});const first=deferred();const started=[];
 const a=admission.run(async()=>{started.push('large');await first.promise;},960*1024);
 const b=admission.run(()=>{started.push('second');},200*1024);
 await tick();assert.deepEqual(started,['large']);first.resolve();await Promise.all([a,b]);assert.deepEqual(started,['large','second']);
 await assert.rejects(admission.run(()=>assert.fail('oversized work ran'),1024*1024+1),{code:'invalid_request'});
});

test('queue overflow and expiry never invoke the provider and release their reservations',async()=>{
 const admission=createBedrockAdmission({maxConcurrent:1,maxWaiting:1,maxWaitingBytes:1000,waitTimeoutMs:30,spacingMs:0});
 const hold=deferred();const first=admission.run(()=>hold.promise,1000);await tick();let calls=0;
 const waiting=admission.run(()=>{calls++;},1000);const expired=assert.rejects(waiting,{code:'broker_queue_timeout'});
 await assert.rejects(admission.run(()=>{calls++;},1),{code:'broker_queue_full'});
 await expired;hold.resolve();await first;await admission.run(()=>{calls++;},1000);assert.equal(calls,1);
});

test('waiting bytes are bounded independently of the queue count',async()=>{
 const admission=createBedrockAdmission({maxConcurrent:1,maxWaitingBytes:2000,spacingMs:0});const hold=deferred();
 const first=admission.run(()=>hold.promise,1000);await tick();const second=admission.run(()=>42,2000);
 await assert.rejects(admission.run(()=>assert.fail('excess bytes ran'),1),{code:'broker_queue_full'});
 hold.resolve();assert.equal(await second,42);await first;
});

test('a delayed expiry timer cannot dispatch an expired conversation after a promise frees capacity',async()=>{
 const admission=createBedrockAdmission({maxConcurrent:1,waitTimeoutMs:20,spacingMs:0});
 const hold=deferred(),first=admission.run(()=>hold.promise,1000);await tick();
 const queued=admission.run(()=>assert.fail('expired conversation reached provider'),1000);
 const rejected=assert.rejects(queued,{code:'broker_queue_timeout'});
 Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,50);
 hold.resolve();await first;await rejected;
 assert.equal(await admission.run(()=>42,1000),42);
});

test('default admission spaces starts even when the provider replies immediately',async()=>{
 const admission=createBedrockAdmission();const starts=[];
 await Promise.all([0,1,2].map(()=>admission.run(()=>{starts.push(performance.now());},100)));
 assert.equal(starts.length,3);assert(starts[1]-starts[0]>=290);assert(starts[2]-starts[1]>=290);
});
