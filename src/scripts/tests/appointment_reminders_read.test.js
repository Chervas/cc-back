'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {filters,summarize,matchesStatus,createAppointmentRemindersReadService}=require('../../services/appointmentRemindersRead.service');
test('read projection defaults to pending and validates bounded server paging',()=>{
  assert.deepEqual(filters({}),{page:0,pageSize:25,status:'pending',sort:'scheduled_at',direction:'asc',q:'',from:null,to:null,dateField:'notice',coverage:false,history:true});
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

test('coverage requires a bounded explicit date range and fixed date field',()=>{
  for(const query of [{include_unplanned:true},{include_unplanned:true,date_from:'2030-01-01',date_to:'2031-01-01'},{date_field:'DROP'}]) assert.throws(()=>filters(query),{code:'appointment_reminders_invalid_filter'});
  assert.equal(filters({date_field:'appointment',include_unplanned:true,date_from:'2030-01-01',date_to:'2030-01-02',include_history:false}).coverage,true);
  assert.equal(filters({status:'reception'}).status,'reception');
});

test('server summary deduplicates patients and linked reservations without counting follow-up messages',()=>{
  const facts=[{patient_id:1,appointment_id:10,appointment_status:'recordatorio_confirmado',status:'read',source_kind:'automation',attention_status:'review'},
    {patient_id:1,appointment_id:10,appointment_status:'recordatorio_confirmado',status:'scheduled',source_kind:'automation',attention_status:'review'},
    {patient_id:2,appointment_id:20,appointment_status:'pendiente',status:'unplanned',source_kind:'appointment',suppressed:1}];
  const result=summarize(facts,[{id_cita:11,anchor_id:10,paciente_id:1,estado:'recordatorio_confirmado'},
    {id_cita:12,anchor_id:10,paciente_id:99,estado:'recordatorio_confirmado'}],true);
  assert.equal(result.records,3);assert.equal(result.notices,2);assert.equal(result.patients,2);assert.equal(result.appointments,3);assert.equal(result.confirmed,2);assert.equal(result.reception,1);assert.equal(result.suppressed,1);
});
test('status filtering for server totals preserves delivery vs clinical vs reception distinctions',()=>{
 const row={status:'read',appointment_status:'recordatorio_confirmado',attention_status:'review'};
 for(const status of ['all','confirmed','reception','read'])assert.equal(matchesStatus(row,status),true);
 for(const status of ['sent','failed','pending'])assert.equal(matchesStatus(row,status),false);
 assert.equal(matchesStatus({...row,status:'sent'},'pending'),true);
});
test('an empty summary exposes zeros with no fabricated delivery or reception facts',()=>{
 assert(Object.values(summarize([])).every(value=>value===0));assert.equal(summarize([]).records,0);
});
