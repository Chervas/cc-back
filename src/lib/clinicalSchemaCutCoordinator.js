'use strict';
const {recoverStoppedParticipants}=require('./metaClinicalCutRecovery');
const {clinicalCutFailure}=require('./clinicalCutFailure');
// No managers, credentials, SQL, Redis, or migrations are imported here. The
// root operator binds the reviewed participants/plan and fsyncs each journal event.
async function runClinicalSchemaCut(options) {
  const {participants,queues,token,inspect,stop,start,verifyParticipant,assertQuiet,
    acquireSqlGate,assertStopped,backup,apply,verifyApplied,journal}=options;
  for(const f of [inspect,stop,start,verifyParticipant,assertQuiet,acquireSqlGate,assertStopped,backup,apply,verifyApplied,journal])if(typeof f!=='function')throw Error('clinical_cut_controls_required');
  const ids=new Set();
  const state=participants.map(p=>{
    if(!p.id||ids.has(p.id)||!['api','auxiliary'].includes(p.role)||!Number.isInteger(p.originalPid)||p.originalPid<1)throw Error('clinical_cut_participant_invalid');
    ids.add(p.id);return {...p,stopRequested:false};
  });
  if(!state.some(p=>p.role==='api')||!state.some(p=>p.role==='auxiliary')||!queues.length)throw Error('clinical_cut_participant_invalid');
  const attempted=[];let gate,ddlStarted=false,stage='preflight';
  const step=async(name,action)=>{stage=name;return action();};
  const verifyQueues=async()=>{for(let i=0;i<queues.length;i++)await step('queue_verify_'+i,()=>queues[i].verify());};
  const recoverProcesses=()=>recoverStoppedParticipants({participants:state,inspect,start,verify:verifyParticipant});
  const restoreQueues=async()=>{
    for(const q of [...attempted].reverse()){
      const receipt=await q.receipt();
      if(receipt?.token===token)await q.restore();
    }
  };
  try {
    await step('activity_before_pause',()=>assertQuiet({admissionClosed:false}));
    for(let i=0;i<queues.length;i++){
      journal({phase:'queue_pause_requested',index:i,token});attempted.push(queues[i]);
      const receipt=await step('queue_acquire_'+i,()=>queues[i].acquire());
      if(!['held','preserved'].includes(receipt.state))throw Error('clinical_cut_queue_not_held');
      journal({phase:'queue_paused',index:i,receipt});
    }
    await verifyQueues();await step('activity_before_auxiliary_stop',()=>assertQuiet({admissionClosed:false}));
    for(const p of state.filter(p=>p.role==='auxiliary')){
      p.stopRequested=true;journal({phase:'stop_requested',id:p.id});await step('stop_'+p.id,()=>stop(p.id));
    }
    gate=await step('sql_acquire',acquireSqlGate);journal({phase:'sql_admission_closed',connectionId:gate.connectionId});
    await step('sql_verify',()=>gate.verify());await verifyQueues();
    await step('activity_with_admission_closed',()=>assertQuiet({admissionClosed:true}));
    for(const p of state.filter(p=>p.role==='api')){
      await step('sql_verify',()=>gate.verify());await verifyQueues();p.stopRequested=true;
      journal({phase:'stop_requested',id:p.id});await step('stop_'+p.id,()=>stop(p.id));
    }
    await step('writers_stopped_with_gate',assertStopped);await step('sql_verify',()=>gate.verify());await verifyQueues();
    await step('sql_release',()=>gate.release());gate=null;journal({phase:'sql_admission_released_writers_stopped'});
    // Recheck after release: interrupted SQL sessions must be gone before backup.
    await step('writers_stopped_before_backup',assertStopped);await step('backup',backup);
    await step('writers_stopped_before_ddl',assertStopped);await verifyQueues();
    ddlStarted=true;journal({phase:'ddl_requested'});const result=await step('ddl_apply',apply);await step('schema_verify',()=>verifyApplied(result));
    journal({phase:'schema_verified'});const recovered=await step('process_recovery',recoverProcesses);await step('queue_restore',restoreQueues);
    journal({phase:'cut_complete',recovered});return {result,recovered};
  } catch(error) {
    const failure=clinicalCutFailure(error),failedStage=stage,recoveryFailures=[];
    const record=event=>{try{journal(event);}catch(journalError){recoveryFailures.push({stage:'failure_journal',failure:clinicalCutFailure(journalError)});}};
    record({phase:'cut_failed',ddlStarted,stage:failedStage,code:failure.reason,failure});
    let gateReleased=!gate;
    if(gate){try{await gate.release();gateReleased=true;}catch(releaseError){
      const failure=clinicalCutFailure(releaseError);recoveryFailures.push({stage:'sql_release',failure});record({phase:'recovery_failed',stage:'sql_release',failure});
    }}
    if(!ddlStarted&&gateReleased){
      try{const recovered=await step('process_recovery',recoverProcesses);await step('queue_restore',restoreQueues);record({phase:'cancelled_before_ddl_recovered',recovered});}
      catch(recoveryError){const failure=clinicalCutFailure(recoveryError);recoveryFailures.push({stage,failure});record({phase:'recovery_failed',stage,failure});}
    }
    // A secondary failure must never replace the original evidence. These
    // details are already sanitized; the original Error remains the rejection.
    if(recoveryFailures.length)Object.defineProperty(error,'recoveryFailures',{value:recoveryFailures,configurable:true});
    // Partial/uncertain DDL preserves stopped processes and queue ownership.
    throw error;
  }
}
module.exports={runClinicalSchemaCut};
