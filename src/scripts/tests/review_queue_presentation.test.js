'use strict';const test=require('node:test'),assert=require('node:assert/strict');const {deliveryPlan,queueAttention,liveQueue}=require('../../lib/review-queue-presentation');
const dispatch={batch_size:1,delay_ms:600000,business_hours:{start_time:'09:00',end_time:'20:40',allowed_weekdays:[1,2,3,4,5],timezone:'Europe/Madrid'}};
test('daily capacity follows the effective cadence, hours and current remaining window',()=>{
 const p=deliveryPlan(dispatch,{now:new Date('2026-11-02T08:00:00Z'),pending:200,status:'sending'});assert.equal(p.max_per_day,70);assert.equal(p.planned_today,70);assert.equal(p.by_weekday[5].capacity,0);
 assert.equal(deliveryPlan(dispatch,{now:new Date('2026-11-02T19:30:00Z'),pending:200,status:'sending'}).planned_today,1);
 assert.equal(deliveryPlan(dispatch,{now:new Date('2026-11-01T08:00:00Z'),pending:200,status:'sending'}).planned_today,0);
 assert.equal(deliveryPlan(dispatch,{now:new Date('2026-11-02T08:00:00Z'),pending:4,status:'sending'}).planned_today,4);
 const p2=deliveryPlan({...dispatch,delivery_governance:{effective_batch_size:1,effective_delay_ms:1200000}},{pending:200});assert.equal(p2.max_per_day,35);
});
test('split windows carry the interval and overlapping ranges never duplicate capacity',()=>{
 const p=deliveryPlan({...dispatch,delay_ms:3600000,business_hours:{allowed_weekdays:[1],intervals_by_weekday:{1:[{start_time:'09:00',end_time:'10:30'},{start_time:'10:00',end_time:'11:00'},{start_time:'16:00',end_time:'17:30'}]}}},{pending:10});assert.equal(p.max_per_day,4);
 assert.equal(deliveryPlan({...dispatch,business_hours:{...dispatch.business_hours,allowed_weekdays:[]}},{}).by_weekday[6].capacity,70);
 assert.equal(deliveryPlan({...dispatch,business_hours:{}},{}),null);
});
test('failed recipients do not stop a live queue; unfinished pauses stay visible and terminal failures stay finished',()=>{
 assert(liveQueue({status:'waiting_next_batch',status_group:'active',failed:10,started:true},{group:true}));
 assert(liveQueue({status:'paused_quality',status_group:'paused',pending:10},{group:true}));
 assert(liveQueue({status:'paused',status_group:'paused',pending:10}));
 assert(!liveQueue({status:'completed',status_group:'history',failed:20,pending:0}));
 assert(!liveQueue({status:'scheduled',status_group:'active',started:false},{group:true}));
});
test('attention explains who paused the queue and retains its real quality threshold',()=>{
 const a=queueAttention({paused_reason:'opt_out_rate_high',requires_admin_review:true,max_opt_out_rate:.03,quality_snapshot:{sent:77,opt_out_rate:3/77}},'paused_quality');assert.equal(a.source,'platform');assert.equal(a.requires_admin_review,true);assert.equal(a.max_opt_out_rate,.03);assert.equal(a.sample_sent,77);
 assert.equal(queueAttention({paused_reason:'paused_by_user'},'paused').source,'user');assert.equal(queueAttention({},'held_meta').source,'meta');assert.equal(queueAttention({},'sending'),null);assert.equal(queueAttention({last_error:'bad_recipient'},'completed'),null);
});

test('group lifecycle tabs distinguish live blocked queues from finished ones and omit unstarted group campaigns',()=>{
 const {queuePage}=require('../../services/reviewOverview.service');const rows=[{id:'marketing:1',status:'waiting_next_batch',status_group:'active',started:true,failed:10},{id:'marketing:2',status:'paused_quality',status_group:'paused',pending:10,attention:{source:'platform'}},{id:'marketing:3',status:'completed',status_group:'history',failed:30},{id:'marketing:4',status:'scheduled',status_group:'active',started:false}];
 const page=queuePage(rows,{group:true,layout:'lifecycle'});assert.equal(page.total,2);assert.equal(page.counts.inactive,1);assert.equal(page.counts.issues,1);assert.equal(queuePage(rows,{group:true,layout:'lifecycle',view:'inactive'}).items[0].id,'marketing:3');
});

test('forecast starts on the next allowed local day and respects remaining recipients and next batch',()=>{
 const sunday=deliveryPlan(dispatch,{now:new Date('2026-11-01T08:00:00Z'),pending:4,status:'sending'});assert.equal(sunday.planned_day,'2026-11-02');assert.equal(sunday.planned_for_day,4);
 const next=deliveryPlan({...dispatch,next_allowed_at:'2026-11-02T18:00:00Z'},{now:new Date('2026-11-01T08:00:00Z'),pending:200,status:'waiting_next_batch'});assert.equal(next.planned_for_day,10);
 assert.equal(deliveryPlan(dispatch,{pending:200,status:'paused_quality'}).planned_for_day,0);
});

test('payment rejection is a configuration pause, independent of Meta quality holds',()=>{const p=queueAttention({paused_reason:'meta_error_131042_payment_missing'},'paused_config');assert.equal(p.source,'configuration');assert.equal(p.automatic,false);});
