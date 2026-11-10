'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../../services/jobExecutor.service'),'utf8');
const start=source.indexOf('async function runLeadCallbackReminderJob('),end=source.indexOf('\n}\n',start)+3;
assert(start>0&&end>start);
function fixture(overrides={}){
 const lead={id:12,clinica_id:72,nombre:'Synthetic Lead',callback_reminder_at:new Date(Date.now()-10000),callback_reminder_created_by:44,callback_reminder_job_id:100,...overrides};
 const created=[],emitted=[],updates=[],context={Date,Intl,LeadIntake:{findByPk:async()=>lead,update:async(...x)=>updates.push(x)},Clinica:{findByPk:async()=>({nombre_clinica:'Synthetic Clinic'})},Notification:{create:async n=>{created.push(n);return{id:1,...n}}},buildNotificationContent:()=>({title:'Synthetic callback',message:'Synthetic reminder',icon:'phone',level:'info'}),emitNotificationCreated:n=>emitted.push(n)};
 vm.createContext(context);vm.runInContext(source.slice(start,end)+'\nthis.run=runLeadCallbackReminderJob',context);return{run:context.run,created,emitted,updates};
}
test('a due reminder targets its creator and emits one persistent, clinic-scoped callback alert',async()=>{
 const f=fixture();await f.run({lead_id:12,user_id:999},{id:100});assert.equal(f.created.length,1);const n=f.created[0];assert.equal(n.userId,44);assert.equal(n.clinicaId,72);assert.equal(n.event,'crm.call_back_reminder');assert.equal(n.data.kind,'lead_callback_reminder');assert.equal(n.data.displayMode,'persistent_alert');assert.equal(n.data.requiresAcknowledgement,true);assert.equal(n.data.leadId,12);assert.equal(f.emitted.length,1);assert.equal(f.updates.length,1);
});
test('a future, replaced or cleared reminder cannot produce an early or stale popup',async()=>{
 for(const overrides of [{callback_reminder_at:new Date(Date.now()+60000)},{callback_reminder_job_id:101},{callback_reminder_at:null}]){
 const f=fixture(overrides);await f.run({lead_id:12,user_id:44},{id:100});assert.equal(f.created.length,0);assert.equal(f.emitted.length,0);assert.equal(f.updates.length,0);
 }
});
