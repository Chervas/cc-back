'use strict';
const {recoverStoppedParticipants}=require('./metaClinicalCutRecovery');
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
  const attempted=[];let gate,ddlStarted=false;
  const verifyQueues=async()=>{for(const q of queues)await q.verify();};
  const recoverProcesses=()=>recoverStoppedParticipants({participants:state,inspect,start,verify:verifyParticipant});
  const restoreQueues=async()=>{
    for(const q of [...attempted].reverse()){
      const receipt=await q.receipt();
      if(receipt?.token===token)await q.restore();
    }
  };
  try {
    await assertQuiet();
    for(let i=0;i<queues.length;i++){
      journal({phase:'queue_pause_requested',index:i,token});attempted.push(queues[i]);
      const receipt=await queues[i].acquire();
      if(!['held','preserved'].includes(receipt.state))throw Error('clinical_cut_queue_not_held');
      journal({phase:'queue_paused',index:i,receipt});
    }
    await verifyQueues();await assertQuiet();
    for(const p of state.filter(p=>p.role==='auxiliary')){
      p.stopRequested=true;journal({phase:'stop_requested',id:p.id});await stop(p.id);
    }
    gate=await acquireSqlGate();journal({phase:'sql_admission_closed',connectionId:gate.connectionId});
    await gate.verify();await verifyQueues();await assertQuiet();
    for(const p of state.filter(p=>p.role==='api')){
      await gate.verify();await verifyQueues();p.stopRequested=true;
      journal({phase:'stop_requested',id:p.id});await stop(p.id);
    }
    await assertStopped();await gate.verify();await verifyQueues();
    await gate.release();gate=null;journal({phase:'sql_admission_released_writers_stopped'});
    // Recheck after release: interrupted SQL sessions must be gone before backup.
    await assertStopped();await backup();await assertStopped();await verifyQueues();
    ddlStarted=true;journal({phase:'ddl_requested'});const result=await apply();await verifyApplied(result);
    journal({phase:'schema_verified'});const recovered=await recoverProcesses();await restoreQueues();
    journal({phase:'cut_complete',recovered});return {result,recovered};
  } catch(error) {
    journal({phase:'cut_failed',ddlStarted,code:/^[a-z_]+$/.test(error.message||'')?error.message:'inspect_evidence'});
    if(gate)await gate.release();
    if(!ddlStarted){const recovered=await recoverProcesses();await restoreQueues();journal({phase:'cancelled_before_ddl_recovered',recovered});}
    // Partial/uncertain DDL preserves stopped processes and queue ownership.
    throw error;
  }
}
module.exports={runClinicalSchemaCut};
