'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {spawn}=require('node:child_process'),{randomUUID}=require('node:crypto');
const Redis=require('ioredis'),{Queue,Worker}=require('bullmq');
const {clinicalBullmqCutGate}=require('../../lib/clinicalBullmqCutGate');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};
test('owned Redis pause drains an active worker, preserves previous pauses, recovers lost receipts and refuses another operator control',async()=>{
 const root=fs.mkdtempSync('/tmp/cc-clinical-cut-redis-');fs.chmodSync(root,0o700);
 const socket=path.join(root,'redis.sock');
 const original=net.Socket.prototype.connect,rejected=[];
 net.Socket.prototype.connect=function(...args){const input=Array.isArray(args[0])?args[0][0]:args[0];const target=typeof input==='string'?input:input?.path;
  if(target!==socket||input?.host||input?.port){rejected.push('foreign socket');throw Error('CLINICAL_CUT_QA_FOREIGN_SOCKET');}return original.apply(this,args);};
 const child=spawn('/usr/bin/redis-server',['--port','0','--unixsocket',socket,'--unixsocketperm','700','--save','','--appendonly','no','--dir',root],{stdio:'ignore'});
 const exited=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
 let client,worker,queue,previousQueue;const firstStarted=deferred(),finishFirst=deferred(),lateFinished=deferred();
 const report={root,pid:child.pid,success:false,rejected};
 try {
  const deadline=Date.now()+5000;while(!fs.existsSync(socket)){assert(Date.now()<deadline);await delay(20);}
  client=new Redis({path:socket,maxRetriesPerRequest:null,retryStrategy:()=>null});await client.ping();
  const prefix='clinical-cut-qa',name='outbound_whatsapp',token=randomUUID();
  queue=new Queue(name,{prefix,connection:client});await queue.waitUntilReady();
  let calls=0;worker=new Worker(name,async job=>{calls++;if(job.name==='first'){firstStarted.resolve();await finishFirst.promise;}else{lateFinished.resolve();}return{fictitious:true};},{prefix,connection:client});
  await worker.waitUntilReady();await queue.add('first',{}, {jobId:'first'});await firstStarted.promise;
  const gate=clinicalBullmqCutGate({client,prefix,name,token});const receipt=await gate.acquire();assert.equal(receipt.state,'held');
  assert.deepEqual(await gate.acquire(),receipt,'Lost receipt recovery must not add a second pause event');
  await assert.rejects(clinicalBullmqCutGate({client,prefix,name,token:randomUUID()}).acquire(),/owned/);
  await queue.add('late',{}, {jobId:'late'});await delay(75);assert.equal(calls,1);assert.equal(await queue.getActiveCount(),1);
  finishFirst.resolve();const until=Date.now()+5000;while(await queue.getActiveCount()){assert(Date.now()<until);await delay(10);}
  await gate.verify();assert.equal(calls,1);assert.equal(await queue.getWaitingCount(),1);
  const restored=await gate.restore();assert.equal(restored.state,'restored');assert.deepEqual(await gate.restore(),restored);
  await lateFinished.promise;assert.equal(calls,2);await assert.rejects(gate.verify(),/not_held/);
  await worker.close();worker=null;
  previousQueue=new Queue('webhook_whatsapp',{prefix,connection:client});await previousQueue.waitUntilReady();await previousQueue.pause();
  const previous=clinicalBullmqCutGate({client,prefix,name:'webhook_whatsapp',token:randomUUID()});assert.equal((await previous.acquire()).state,'preserved');
  await previous.verify();await previous.restore();assert.equal(await previousQueue.isPaused(),true);
  const next=clinicalBullmqCutGate({client,prefix,name,token:randomUUID()});await next.acquire();await queue.pause();
  await assert.rejects(next.verify(),/external_control/);await assert.rejects(next.restore(),/external_control/);assert.equal(await queue.isPaused(),true);
  await assert.rejects(clinicalBullmqCutGate({client,prefix,name:'automation_defaults',token:randomUUID()}).acquire(),/missing/);
  assert.deepEqual(rejected,[]);report.success=true;report.calls=calls;report.checks=['Active worker finishes without new admissions; lost receipt and restore acknowledgements are idempotent; previous global pause preserved; another pause blocks automatic restore; unknown queue rejected'];
 }finally{
  finishFirst.resolve();if(worker)await worker.close();if(queue)await queue.close();if(previousQueue)await previousQueue.close();if(client)client.disconnect();
  child.kill('SIGTERM');report.shutdown=await exited;net.Socket.prototype.connect=original;console.log(JSON.stringify(report));
 }
});
