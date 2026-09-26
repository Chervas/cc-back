'use strict';
// Same closed producer contract can run against API and the gateway variant,
// without starting models, Redis, providers, timers or sockets.
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {EventEmitter}=require('node:events');
test('producer opt-in emits once locally and never re-produces Redis deliveries',()=>{
  const connections=[],notified=[],redisPublished=[],env={DB_NAME:'fictitious'};
  class FakeRedis extends EventEmitter {
    constructor(){super();connections.push(this);}
    subscribe(){return Promise.resolve();}
    publish(channel,raw){redisPublished.push(JSON.parse(raw));return Promise.resolve(1);}
  }
  const module={exports:{}};
  vm.runInNewContext(fs.readFileSync(require.resolve('../../services/socket.service'),'utf8'),{
    module,console:{warn:()=>{}},process:{env,pid:123,cwd:()=>'/fictitious'},
    require(name){
      if(name==='ioredis')return FakeRedis;
      if(name==='../lib/availability-realtime')return {createInvalidator:()=>({notify:(...args)=>notified.push(args)})};
      if(name==='../lib/socket-realtime-guard')return {deliverRealtime:()=>{}};
      throw Error('UNEXPECTED_DEPENDENCY:'+name);
    },
  });
  const bus=module.exports;bus.setIO({emit:()=>{},to:()=>({emit:()=>{}})});
  const payload={appointment_id:91,clinic_id:71},event='appointment:updated';
  bus.getIO().to('clinic:71').emit(event,payload);assert.equal(notified.length,0);
  env.AVAILABILITY_REALTIME_ENABLED='true';bus.getIO().to('clinic:71').emit(event,payload);
  assert.equal(notified.length,1);assert.equal(notified[0][0],event);assert.equal(notified[0][1],payload);
  connections[0].emit('message','clinicaclick:socket:events:fictitious',JSON.stringify({source:'other-runtime',event,payload,rooms:['clinic:71']}));
  bus.emit('availability:changed',{clinic_id:72},['clinic:72']);assert.equal(notified.length,1);
  assert.equal(redisPublished.length,3);assert.equal(redisPublished[2].event,'availability:changed');
});
