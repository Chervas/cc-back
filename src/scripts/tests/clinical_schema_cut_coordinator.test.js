'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {runClinicalSchemaCut}=require('../../lib/clinicalSchemaCutCoordinator');
const token='c6918544-7c1e-41d9-8a6c-4d7831169174';
function fixture(){
 const participants=[{id:'api',role:'api',originalPid:11},{id:'gateway',role:'api',originalPid:12},{id:'inbox',role:'auxiliary',originalPid:13},{id:'fresh',role:'auxiliary',originalPid:14}];
 const processes=Object.fromEntries(participants.map(p=>[p.id,{state:'running',pid:p.originalPid}]));
 const calls=[],events=[],owned={token,state:'held'};let paused=false,sqlHeld=false;
 const gate={connectionId:1,verify:async()=>assert(sqlHeld),release:async()=>{calls.push('sql-release');sqlHeld=false;}};
 const queue={acquire:async()=>{calls.push('pause');paused=true;return owned;},verify:async()=>assert(paused),receipt:async()=>paused?owned:null,restore:async()=>{calls.push('resume');paused=false;}};
 const options={participants,queues:[queue],token,inspect:async id=>processes[id],
  stop:async id=>{calls.push('stop:'+id);if(['api','gateway'].includes(id))assert(sqlHeld);processes[id]={state:'stopped',pid:0};},
  start:async id=>{assert(!sqlHeld);calls.push('start:'+id);processes[id]={state:'running',pid:100+calls.length};},
  verifyParticipant:async()=>{},assertQuiet:async()=>{},
  acquireSqlGate:async()=>{calls.push('sql-acquire');sqlHeld=true;return gate;},
  assertStopped:async()=>{assert(Object.values(processes).every(p=>p.state==='stopped'));},
  backup:async()=>{assert(!sqlHeld);calls.push('backup');},apply:async()=>{calls.push('apply');return{compatible:true};},verifyApplied:async()=>{},journal:event=>events.push(event)};
 return{options,calls,events,processes,queue,gate,isPaused:()=>paused};
}
test('new SQL job during auxiliary stop cancels without restarting untouched APIs',async()=>{
 const f=fixture();f.options.acquireSqlGate=async()=>{throw Error('clinical_cut_gate_active_jobs');};
 await assert.rejects(runClinicalSchemaCut(f.options),/active_jobs/);
 assert.deepEqual(f.calls,['pause','stop:inbox','stop:fresh','start:inbox','start:fresh','resume']);assert.equal(f.processes.api.pid,11);assert.equal(f.processes.gateway.pid,12);
 assert.equal(f.events.at(-1).phase,'cancelled_before_ddl_recovered');
});
test('SQL admission remains closed through both API stops and opens only once writers are gone',async()=>{
 const f=fixture();await runClinicalSchemaCut(f.options);
 assert.deepEqual(f.calls,['pause','stop:inbox','stop:fresh','sql-acquire','stop:api','stop:gateway','sql-release','backup','apply','start:api','start:gateway','start:inbox','start:fresh','resume']);
 assert.equal(f.events.at(-1).phase,'cut_complete');assert.equal(f.isPaused(),false);
});
test('partial manager stop failure releases SQL gate and starts only participants actually stopped',async()=>{
 const f=fixture(),original=f.options.stop;f.options.stop=async id=>{if(id==='gateway')throw Error('manager_failed');await original(id);};
 await assert.rejects(runClinicalSchemaCut(f.options),/manager_failed/);
 assert(!f.calls.includes('start:gateway'));assert(!f.calls.includes('backup'));assert(f.calls.indexOf('sql-release')<f.calls.indexOf('start:api'));
});
test('lost pause acknowledgement is recovered by durable ownership without a second pause',async()=>{
 const f=fixture(),original=f.queue.acquire;f.queue.acquire=async()=>{await original();throw Error('response_lost');};
 await assert.rejects(runClinicalSchemaCut(f.options),/response_lost/);assert.deepEqual(f.calls,['pause','resume']);
});
test('DDL error preserves stopped writers and owned queue pause for explicit inspection',async()=>{
 const f=fixture();f.options.apply=async()=>{throw Error('migration_failed');};
 await assert.rejects(runClinicalSchemaCut(f.options),/migration_failed/);assert(Object.values(f.processes).every(p=>p.state==='stopped'));assert(f.isPaused());assert(!f.calls.includes('resume'));
});
test('original failure remains identifiable when recovery also fails, without journaling SQL or credentials',async()=>{
 const f=fixture();
 const primary=Object.assign(Error('SQL contained PRIVATE_TOKEN and a patient value'),{code:'ER_LOCK_WAIT_TIMEOUT',errno:1205,sqlState:'HY000'});
 f.options.assertQuiet=async context=>{if(context.admissionClosed)throw primary;};
 f.options.inspect=async()=>({state:'running',pid:999});
 await assert.rejects(runClinicalSchemaCut(f.options),error=>error===primary);
 const failure=f.events.find(e=>e.phase==='cut_failed');assert.equal(failure.stage,'activity_with_admission_closed');
 assert.equal(failure.failure.code,'ER_LOCK_WAIT_TIMEOUT');assert.equal(failure.failure.errno,1205);
 assert.equal(primary.recoveryFailures[0].failure.reason,'meta_cut_recovery_unexpected_process_state');
 assert.equal(f.events.at(-1).phase,'recovery_failed');assert(f.isPaused());assert(!JSON.stringify(f.events).includes('PRIVATE_TOKEN'));
});
test('unknown SQL gate release keeps participants and queues held and preserves the primary failure',async()=>{
 const f=fixture(),primary=Error('clinical_cut_primary_failure');f.options.assertQuiet=async c=>{if(c.admissionClosed)throw primary;};
 f.gate.release=async()=>{throw Error('clinical_cut_release_uncertain');};
 await assert.rejects(runClinicalSchemaCut(f.options),e=>e===primary);
 assert.equal(primary.recoveryFailures[0].stage,'sql_release');assert(f.isPaused());assert(!f.calls.some(c=>c.startsWith('start:')));
});
test('pending-work guard is relaxed only after SQL and queue admission are verified closed',async()=>{
 const f=fixture(),contexts=[];
 f.options.assertQuiet=async context=>{contexts.push(context.admissionClosed);if(context.admissionClosed){await f.gate.verify();assert(f.isPaused());}};
 await runClinicalSchemaCut(f.options);assert.deepEqual(contexts,[false,false,true]);
});
