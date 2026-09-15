'use strict';
const test=require('node:test'),assert=require('node:assert/strict');const {EventEmitter}=require('node:events');
const {invalidation}=require('../../lib/socket-view-invalidation');
test('view invalidations expose only IDs and cannot become an automation input',()=>{
 const value=invalidation('message:created',{id:1,conversation_id:2,content:'FICTITIOUS_PRIVATE_TEXT',resume_text:'MUST_NOT_RESUME',status:'read',metadata:{token:'SENTINEL'}});
 assert.deepEqual(value,{id:1,conversation_id:2,realtime_refresh:true});
 for(const [event,payload]of[['message:created',{id:true,conversation_id:2}],['unread:updated',{id:1,conversation_id:2}]])assert.throws(()=>invalidation(event,payload));
});
test('standalone bus confirms subscription, rejects missing subscribers and bounds offline queuing',async()=>{
 let count=0,published,options;class FakeRedis extends EventEmitter{constructor(_url,value){super();options=value;this.status='wait'}async connect(){this.status='ready'}async publish(_channel,raw){published=JSON.parse(raw);return count}}
 const r=require.resolve('ioredis'),s=require.resolve('../../services/socket.service'),beforeR=require.cache[r],beforeS=require.cache[s];
 require.cache[r]={id:r,filename:r,loaded:true,exports:FakeRedis};delete require.cache[s];
 try{const bus=require('../../services/socket.service');assert.equal(bus.getIO(),null);bus.enableBackgroundPublishing();assert.equal(typeof bus.getIO().to,'function');
 const value={id:1,conversation_id:2};await assert.rejects(bus.publishConfirmed('message:created',value,['clinic:71']),/bus_unavailable/);count=1;assert.equal(await bus.publishConfirmed('message:created',value,['clinic:71']),1);assert.deepEqual(published.payload,{id:1,conversation_id:2,realtime_refresh:true});assert.equal(options.enableOfflineQueue,false);assert.equal(options.maxRetriesPerRequest,1);await assert.rejects(bus.publishConfirmed('message:created',value,[]),/packet_invalid/);
 }finally{if(beforeR)require.cache[r]=beforeR;else delete require.cache[r];if(beforeS)require.cache[s]=beforeS;else delete require.cache[s]}
});
