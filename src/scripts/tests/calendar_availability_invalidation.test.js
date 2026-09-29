'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {notifyCalendarAvailability}=require('../../lib/calendar-availability-invalidation');
const {withCalendarMutation}=require('../../services/appointmentCalendarMutation.service');
test('calendar changes invalidate current and shared clinic rooms without patient or block data',async()=>{
 const published=[];const db={DoctorClinica:{findAll:async q=>{assert.deepEqual(q.attributes,['clinica_id']);return [{clinica_id:72},{clinica_id:66}];}}};
 await notifyCalendarAvailability({db,doctorId:5},{related:async ids=>{assert.deepEqual(ids,[72,66]);return [81,66];},publish:id=>published.push(id)});
 assert.deepEqual(published,[72,66,81]);
});
test('invalid resource scope never broadcasts',async()=>{let sent=0;await assert.rejects(notifyCalendarAvailability({db:{},clinicId:0.5},{related:async()=>[],publish:()=>sent++}));assert.equal(sent,0);});
test('successful writes register notification after commit, failures never notify',async()=>{
 const hooks=[];const tx={options:{isolationLevel:'READ COMMITTED'},afterCommit:fn=>hooks.push(fn)};let sent=0;
 const args={db:{},doctorId:5,enabled:false,realtimeEnabled:true,transaction:tx,notify:async()=>sent++};
 assert.equal(await withCalendarMutation({...args,mutate:async()=>42}),42);assert.equal(sent,0);await hooks[0]();assert.equal(sent,1);
 await assert.rejects(withCalendarMutation({...args,mutate:async()=>{throw Error('rollback')}}));assert.equal(hooks.length,1);
});
test('a failed socket cannot turn an already committed write into an API error',async()=>{
 let hook;const tx={options:{isolationLevel:'READ COMMITTED'},afterCommit:fn=>hook=fn};
 await withCalendarMutation({db:{},clinicId:72,enabled:false,realtimeEnabled:true,transaction:tx,mutate:async()=>1,notify:async()=>{throw Error('offline')}});
 await assert.doesNotReject(hook());
});
