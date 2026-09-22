'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
require('./fixtures/campaign_offline_runtime.cjs');
const policy=require('../../lib/whatsappAppointmentTimeout');
const text=fs.readFileSync(require.resolve('../../services/flowEngineV2.service'),'utf8');
const source=text.slice(text.indexOf('async function resumeWaitingNode('),text.indexOf('\nfunction findClassifyIntentOutput('));
function fixture({healthy=true,reply=false,stale=false,asked=false}={}) {
 const now=Date.now(),start=new Date(now+3600000).toISOString();
 const context={appointment:{id_cita:1,clinica_id:2,inicio:start,estado:'info_enviada'}};
 const execution={id:4,clinic_id:2,trigger_entity_type:'appointment',trigger_entity_id:1,status:'running',current_node_id:'wait',
   wait_until:new Date(now-(stale?3600000:0)),waiting_meta:{wait_starts_at:new Date(now-7200000).toISOString()},
   templateVersion:{nodes:[{id:'send',type:'action/send_whatsapp'}]},context};
 const snapshot={version:1,observedAt:now,clinics:[{clinicId:2,oldestPendingAt:null,blockingReview:0}]};
 const c={Date,require:name=>{
   if(name==='../lib/whatsappAppointmentTimeout')return policy;
   if(name==='../lib/whatsappInboxHealth')return {read:()=>healthy?snapshot:null};
   throw Error('unexpected dependency');
 },cleanString:v=>v||null,readOutputTarget:(n,k)=>n.outputs[k],whatsappAuthorizedBroker:{bindingsForClinic:()=>[{sendEnabled:true}]},
 resolveWaitResponseAnchor:()=>({listened_output:{conversation_id:3}}),toIntOrNull:Number,parseDateValueOrNull:v=>new Date(v),
 CitaPaciente:{findByPk:async()=>context.appointment},Conversation:{findByPk:async()=>({clinic_id:2})},
 Message:{findOne:async()=>reply?{id:8}:null},Op:{gte:Symbol('gte')},
 db:{sequelize:{query:async()=>[asked?[{sent_at:new Date(),appointment_start:start}]:[]]}},
 updateExecutionAndEmit:async(e,p)=>Object.assign(e,p),
 mergeNodeOutput:(c,n,o)=>({...c,outputs:{[n]:o}}),resolveRuntimeTargets:()=>({}),backfillRuntimeTargets:async(e,t)=>t,
 enrichConversationContext:async c=>c};
 vm.createContext(c);vm.runInContext(source+'\nthis.resume=resumeWaitingNode',c);
 return {execution,run:()=>c.resume(execution,{id:'wait',type:'delay/wait_response',outputs:{on_timeout:'send'}},context,{mode:'timeout'})};
}
test('real engine timeout branch returns to a durable wait when reception health is unavailable',async()=>{
 const f=fixture({healthy:false});const due=f.execution.wait_until;await f.run();
 assert.equal(f.execution.status,'waiting');assert.equal(f.execution.current_node_id,'wait');
 assert.equal(f.execution.waiting_meta.inbox_original_due_at,due);assert.ok(f.execution.wait_until>Date.now());
});
test('real engine never enters the send node after an already received reply or a duplicate recovery request',async()=>{
 for(const options of [{reply:true},{stale:true,asked:true}]){const f=fixture(options);await f.run();assert.equal(f.execution.status,'cancelled');assert.equal(f.execution.current_node_id,null);}
});
test('normal flow retains its next node and marks text followups for final transport checks',async()=>{
 const f=fixture();await f.run();assert.equal(f.execution.status,'running');assert.equal(f.execution.current_node_id,'send');
 assert.equal(f.execution.context.whatsapp_no_response_timeout,true);
});
