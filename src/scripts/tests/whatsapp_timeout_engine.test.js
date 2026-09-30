'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
require('./fixtures/campaign_offline_runtime.cjs');
const policy=require('../../lib/whatsappAppointmentTimeout');
const text=fs.readFileSync(require.resolve('../../services/flowEngineV2.service'),'utf8');
const source=text.slice(text.indexOf('async function resumeWaitingNode('),text.indexOf('\nfunction findClassifyIntentOutput('));
const notifySource=text.slice(text.indexOf('async function notifyRecoveredReply('),text.indexOf('\nasync function resumeWaitingNode('));
function fixture({healthy=true,reply=false,stale=false,asked=false,review=false,affected=false,pending=false,recovered=false,alertFails=false,next=true}={}) {
 const now=Date.now(),start=new Date(now+3600000).toISOString();
 const context={appointment:{id_cita:1,clinica_id:2,inicio:start,estado:'info_enviada'}};
 const execution={id:4,clinic_id:2,trigger_entity_type:'appointment',trigger_entity_id:1,status:'running',current_node_id:'wait',
   wait_until:new Date(now-(stale?3600000:0)),waiting_meta:{wait_starts_at:new Date(now-7200000).toISOString()},
   templateVersion:{nodes:[{id:'send',type:'action/send_whatsapp'}]},context};
 const snapshot={version:1,observedAt:now,clinics:[{clinicId:2,oldestPendingAt:null,blockingReview:0}]};
 const alerts=[],reviews=[];
 if(review)Object.assign(snapshot.clinics[0],{blockingReview:4,unscopedBlockingReview:0,blockingContactKeys:['a'.repeat(64)]});
 const c={Date,require:name=>{
   if(name==='../lib/whatsappAppointmentTimeout')return policy;
   if(name==='../lib/whatsappPendingReply')return {pendingReply:async()=>recovered?{kind:'recovered',messageId:8}:pending?8:null};
   if(name==='../lib/whatsappInboxHealth')return {...require('../../lib/whatsappInboxHealth'),read:()=>healthy?snapshot:null};
   throw Error('unexpected dependency');
 },cleanString:v=>v||null,readOutputTarget:(n,k)=>n.outputs[k],whatsappAuthorizedBroker:{bindingsForClinic:()=>[{sendEnabled:true,clinicId:2,phoneId:'123'}]},
 resolveWaitResponseAnchor:()=>({listened_output:{conversation_id:3}}),toIntOrNull:Number,parseDateValueOrNull:v=>new Date(v),
 CitaPaciente:{findByPk:async()=>context.appointment},Conversation:{findByPk:async()=>({id:3,clinic_id:2,channel:'whatsapp',contact_id:'19995550101'})},
 Message:{findOne:async()=>reply?{id:8}:null},Op:{gte:Symbol('gte')},
 notifyRecoveredReply:async(...args)=>{alerts.push(args);if(alertFails)throw Error('synthetic_alert_failure');},
 conversationAutomationState:{setState:async patch=>reviews.push(patch)},
 db:{sequelize:{query:async sql=>sql.includes('k.contact_key')?[affected?[{contact_key:'a'.repeat(64)}]:[]]:[asked?[{sent_at:new Date(),appointment_start:start}]:[]]}},
 updateExecutionAndEmit:async(e,p)=>Object.assign(e,p),
 mergeNodeOutput:(c,n,o)=>({...c,outputs:{[n]:o}}),resolveRuntimeTargets:()=>({}),backfillRuntimeTargets:async(e,t)=>t,
 enrichConversationContext:async c=>c};
 vm.createContext(c);vm.runInContext(source+'\nthis.resume=resumeWaitingNode',c);
 return {execution,alerts,reviews,run:()=>c.resume(execution,{id:'wait',type:'delay/wait_response',outputs:{on_timeout:next?'send':null}},context,{mode:'timeout'})};
}
test('real engine timeout branch returns to a durable wait when reception health is unavailable',async()=>{
 const f=fixture({healthy:false});const due=f.execution.wait_until;await f.run();
 assert.equal(f.execution.status,'waiting');assert.equal(f.execution.current_node_id,'wait');
 assert.equal(f.execution.waiting_meta.inbox_original_due_at,due);assert.ok(f.execution.wait_until>Date.now());
});
test('real engine no longer cancels a waiting flow just because an inbound row exists',async()=>{
 const f=fixture({reply:true});await f.run();
 assert.equal(f.execution.status,'running');assert.equal(f.execution.current_node_id,'send');
 assert.notEqual(f.execution.last_error,'reply_already_received');
});
test('real engine still suppresses a duplicate recovery request',async()=>{
 const f=fixture({stale:true,asked:true});await f.run();
 assert.equal(f.execution.status,'cancelled');assert.equal(f.execution.current_node_id,null);
});
test('normal flow retains its next node and marks text followups for final transport checks',async()=>{
 const f=fixture();await f.run();assert.equal(f.execution.status,'running');assert.equal(f.execution.current_node_id,'send');
 assert.equal(f.execution.context.whatsapp_no_response_timeout,true);
});
test('real timeout engine isolates another contact review while retaining the affected alias barrier',async()=>{
 const other=fixture({review:true});await other.run();assert.equal(other.execution.current_node_id,'send');
 const own=fixture({review:true,affected:true});await own.run();assert.equal(own.execution.status,'waiting');assert.equal(own.execution.current_node_id,'wait');
});

test('a durable reply awaiting native dispatch preserves both a followup wait and a terminal wait',async()=>{
 for(const next of [true,false]){const f=fixture({pending:true,next});await f.run();
 assert.equal(f.execution.status,'waiting');assert.equal(f.execution.current_node_id,'wait');
 assert.equal(f.execution.last_error,'inbound_response_dispatch_pending');}
});
test('a recovered reply cancels the followup, alerts reception and preserves manual review',async()=>{
 const f=fixture({recovered:true});await f.run();
 assert.equal(f.execution.status,'cancelled');assert.equal(f.execution.current_node_id,null);
 assert.equal(f.execution.last_error,'inbound_recovery_requires_review');
 assert.equal(f.alerts.length,1);assert.equal(f.reviews.length,1);
 assert.equal(f.reviews[0].sourceMessageId,8);assert.equal(f.reviews[0].manualActionRequired,true);
});
test('a failed recovered-reply alert holds the wait and never sends the followup',async()=>{
 const f=fixture({recovered:true,alertFails:true});await f.run();
 assert.equal(f.execution.status,'waiting');assert.equal(f.execution.current_node_id,'wait');
 assert.equal(f.execution.last_error,'inbound_recovery_review_pending');
 assert.equal(f.reviews.length,0);
});
test('recovered-reply alerts are persistent, linked to the chat and idempotent per assignee',async()=>{
 const saved=new Map(),emitted=[];
 const c={resolveTaskAssigneeUserIds:async()=>[11,12],Notification:{findOrCreate:async({where,defaults})=>{
  if(saved.has(where.dedupeKey))return [saved.get(where.dedupeKey),false];
  saved.set(where.dedupeKey,defaults);return [defaults,true];
 }},emitNotificationCreated:n=>emitted.push(n)};
 vm.createContext(c);vm.runInContext(notifySource+'\nthis.notify=notifyRecoveredReply',c);
 const execution={id:4,clinic_id:2,trigger_entity_id:1};
 await c.notify(execution,3,8);await c.notify(execution,3,8);
 assert.equal(saved.size,2);assert.equal(emitted.length,2);
 for(const value of saved.values()){
  assert.equal(value.event,'automation.persistent_alert');
  assert.equal(value.data.quickChatConversationId,3);
  assert.equal(value.data.quickChatResponseMessageId,8);
  assert.equal(value.data.requiresAcknowledgement,true);
 }
});
