'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createInvalidator, relatedClinics } = require('../../lib/availability-realtime');
const { packetFor } = require('../../lib/socket-payload');
const { createPolicy } = require('../../services/socketAccess.service');
function fixture(options = {}) {
  let timer; const queries=[], sent=[], warnings=[];
  const queue=createInvalidator({resolve:async ids=>{queries.push(ids);return[71,72,72];},
    publish:(...a)=>sent.push(a),warn:v=>warnings.push(v),
    setTimer:fn=>{timer=fn;return 1;},clearTimer:()=>{timer=null;},...options});
  return {queue,queries,sent,warnings,flush:async()=>{assert(timer);const fn=timer;timer=null;await fn();}};
}
test('appointment bursts share one metadata lookup and produce one content-free signal per peer',async()=>{
  const f=fixture();for(let i=1;i<=30;i++)f.queue.notify('appointment:updated',{clinic_id:71,appointment_id:i,patient_id:'PRIVATE',inicio:'PRIVATE'});
  assert.equal(f.queue.state().pending,1);await f.flush();assert.deepEqual(f.queries,[[71]]);
  assert.deepEqual(f.sent,[['availability:changed',{clinic_id:72},['clinic:72']]]);
});
test('invalidations do not recurse, ordinary events do nothing, IDs cannot be coerced',()=>{
  const f=fixture();for(const name of ['availability:changed','notification:created','message:created'])f.queue.notify(name,{clinic_id:71,appointment_id:1});
  for(const id of [true,0,-1,'71.0',{},null])f.queue.notify('appointment:created',{clinic_id:id,appointment_id:1});
  f.queue.notify('appointment:deleted',{clinic_id:71});assert.equal(f.queue.state().pending,0);
});
test('new edits while lookup is running are retained for a subsequent bounded batch',async()=>{
  let release,active=0,max=0;const f=fixture({resolve:async ids=>{active++;max=Math.max(max,active);await new Promise(r=>{release=r;});active--;return[72];}});
  f.queue.notify('appointment:created',{clinic_id:71,appointment_id:1});const first=f.flush();
  f.queue.notify('appointment:updated',{clinic_id:71,appointment_id:1});assert.equal(f.queue.state().pending,1);
  release();await first;const second=f.flush();release();await second;assert.equal(max,1);assert.equal(f.sent.length,2);
});
test('batch and pending limits bound memory/query work and failures expose no source data',async()=>{
  const f=fixture({maxPending:102});for(let i=1;i<=104;i++)f.queue.notify('appointment:deleted',{clinic_id:i,appointment_id:1});
  assert.equal(f.queue.state().pending,102);assert.deepEqual(f.warnings,['availability_realtime_queue_full','availability_realtime_queue_full']);
  await f.flush();assert.equal(f.queries[0].length,100);await f.flush();assert.deepEqual(f.queries[1],[101,102]);
  const failed=fixture({resolve:async()=>{throw Error('SECRET_SQL');}});failed.queue.notify('appointment:updated',{clinic_id:71,appointment_id:1});await failed.flush();
  assert.deepEqual(failed.warnings,['availability_realtime_refresh_failed']);assert.equal(failed.sent.length,0);
});
test('stop during lookup suppresses late delivery and additional work',async()=>{
  let release;const f=fixture({resolve:()=>new Promise(r=>{release=r;})});f.queue.notify('appointment:updated',{clinic_id:71,appointment_id:1});const work=f.flush();
  f.queue.stop();release([72]);await work;f.queue.notify('appointment:updated',{clinic_id:71,appointment_id:1});assert.equal(f.sent.length,0);assert.equal(f.queue.state().pending,0);
});
test('the SQL resolver makes one bound query, rejects scope overflow and does not load the application',async()=>{
  const calls=[];const db={Sequelize:{QueryTypes:{SELECT:'select'}},sequelize:{query:async(sql,options)=>{calls.push({sql,options});return[{clinic_id:72}];}}};
  assert.deepEqual(await relatedClinics({db,clinicIds:[71,71]}),[72]);assert.equal(calls.length,1);assert.deepEqual(calls[0].options.replacements,{clinicIds:[71]});
  assert(!/CitasPacientes|Pacientes|Usuarios/.test(calls[0].sql));
  for(const clinicIds of [[],[false],['71.0'],Array(101).fill(71)])await assert.rejects(relatedClinics({db,clinicIds}));
  db.sequelize.query=async()=>Array(1001).fill({clinic_id:72});await assert.rejects(relatedClinics({db,clinicIds:[71]}),/scope_limit/);
});
test('closed projection keeps only target clinic and authorizes its calendar without foreign patient access',async()=>{
  const packet=packetFor('availability:changed',{clinic_id:71,appointment_id:12,source_clinic_id:72,patient_id:123,inicio:'SECRET',count:3});
  assert.deepEqual(packet,{event:'availability:changed',body:{clinic_id:71},resource:{type:'calendar',id:'71'}});
  const checks=[];let allowed=true;
  const policy=createPolicy({models:{Clinica:{findByPk:async id=>id===71?{id_clinica:71}:null}},
    isAdmin:()=>false,canAccess:async input=>{checks.push(input);return allowed;}});
  const descriptor=await policy.resolve(packet);assert(await policy.authorize(501,descriptor));
  assert.deepEqual(checks,[{actorId:501,clinicId:71,featureKey:'appointments.view'}]);allowed=false;assert.equal(await policy.authorize(501,descriptor),false);
  assert.equal(await policy.resolve({...packet,body:{clinic_id:72}}),null);
  assert.equal(await policy.resolve(packetFor('availability:changed',{clinic_id:999})),null);
});
