'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {filters,createAppointmentRemindersReadService}=require('../../services/appointmentRemindersRead.service');
test('read projection defaults to pending and validates bounded server paging',()=>{
  assert.deepEqual(filters({}),{page:0,pageSize:25,status:'pending',sort:'scheduled_at',direction:'asc',q:'',from:null,to:null});
  assert.throws(()=>filters({page_size:0}));assert.throws(()=>filters({page:-1}));assert.throws(()=>filters({page_size:101}));
});
test('sort and status allowlists reject SQL and unknown states',()=>{
  for(const value of [{sort:'id;DROP TABLE Messages'},{direction:'desc;--'},{status:'completed'}])assert.throws(()=>filters(value),{code:'appointment_reminders_invalid_filter'});
});
test('clinical local date ranges must be real and ascending',()=>{
  assert.throws(()=>filters({date_from:'2030-02-30'}));
  assert.throws(()=>filters({date_from:'2030-05-04',date_to:'2030-05-03'}));
  assert.equal(filters({date_from:'2030-03-31',date_to:'2030-03-31'}).to,'2030-03-31');
});
test('search is bounded literal text, not client SQL',()=>{
  assert.equal(filters({q:' %_ = '} ).q,'%_ =');assert.throws(()=>filters({q:'x'.repeat(161)}));assert.throws(()=>filters({q:{sql:'bad'}}));
});
test('unauthorized scope is rejected before any table capability/data read',async()=>{
  let reads=0;const db={sequelize:{query:()=>{reads++;throw Error('unexpected SQL');}}};
  const service=createAppointmentRemindersReadService({db,canAccess:async({featureKey})=>featureKey!=='patients.sensitive.view'});
  await assert.rejects(service.list({actorId:7,clinicId:1}),{code:'access_policy_forbidden'});assert.equal(reads,0);
});
test('service refuses invalid actor/clinic before reading',async()=>{
  const service=createAppointmentRemindersReadService({db:{},canAccess:async()=>true});
  await assert.rejects(service.list({actorId:'1 OR 1=1',clinicId:1}));await assert.rejects(service.list({actorId:1,clinicId:'0'}));
});
