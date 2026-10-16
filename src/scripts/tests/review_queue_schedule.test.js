'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const policy=require('../../lib/review-queue-schedule');
const now=new Date('2026-10-16T12:00:00Z');
const raw={mode:'custom',time_mode:'specific_time',batch_size:5,delay_ms:3600000,
  start_date:'2026-10-19',scheduled_time:'10:00',scheduled_at:'2026-10-19T08:00:00Z',include_weekends:false,
  business_hours:{start_time:'09:00',end_time:'18:00',timezone:'UTC'}};
test('only editable scheduling fields are accepted; routing, security, counters and job identity cannot be overwritten',()=>{
 const next=policy.normalize({...raw,job_id:2,status:'sending',cancel_requested:false,sender_origin_id:99,max_opt_out_rate:1},now);
 for(const k of ['job_id','status','cancel_requested','sender_origin_id','max_opt_out_rate'])assert.equal(next[k],undefined);
 assert.equal(next.business_hours.timezone,'Europe/Madrid');assert.equal(next.scheduled_at,'2026-10-19T08:00:00.000Z');
 assert.equal(policy.normalize({...raw,mode:'all_at_once'},now).batch_size,1);assert.equal(policy.normalize({...raw,mode:'all_at_once'},now).delay_ms,600000);
});
for(const [name,patch]of Object.entries({zeroBatch:{batch_size:0},fractional:{batch_size:1.5},tinyDelay:{delay_ms:59999},hugeDelay:{delay_ms:31*86400000},
 badMode:{mode:'bypass'},badWindow:{business_hours:{start_time:'18:00',end_time:'09:00'}},badStart:{scheduled_time:'22:00'},past:{start_date:'2026-10-15'},
 weekend:{start_date:'2026-10-17'},invalidDay:{start_date:'2026-99-99'},invalidTime:{scheduled_time:'25:00'}})){
 test('invalid schedule rejects: '+name,()=>assert.throws(()=>policy.normalize({...raw,...patch},now),{status:400}));
}
test('clock change uses Madrid and does not accept an invented or nonexistent local hour',()=>{
 const next=policy.normalize({...raw,start_date:'2026-10-26',scheduled_time:'10:00'},now);assert.equal(next.scheduled_at,'2026-10-26T09:00:00.000Z');
 assert.throws(()=>policy.normalize({...raw,start_date:'2027-03-28',scheduled_time:'02:30',include_weekends:true,business_hours:{start_time:'00:00',end_time:'23:00'}},now),{status:400});
});
test('all clinics of a queue must be in scope; no reactivation of completed queues',()=>{
 const list={status:'paused',clinica_id:null,clinic_ids:[59,66],criteria:{dispatch:{status:'paused_config'}}};
 assert.throws(()=>policy.assertQueue(list,{clinicIds:[59]},()=>true),{status:403});
 assert.deepEqual(policy.assertQueue(list,{clinicIds:[59,66]},()=>true),[59,66]);
 assert.throws(()=>policy.assertQueue({...list,status:'completed'},{clinicIds:[59,66]},()=>true),{status:409});
 assert.deepEqual(policy.assertQueue({...list,status:'completed'},{clinicIds:[59,66]},()=>true,true),[59,66]);
});
