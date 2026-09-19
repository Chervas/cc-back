'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {recoverStoppedParticipants}=require('../../lib/metaClinicalCutRecovery');
function fixture() {
  const participants=[['api',101],['gateway',102],['inbox',103],['fresh',104]].map(([id,originalPid])=>({id,originalPid,stopRequested:false}));
  const state=Object.fromEntries(participants.map(p=>[p.id,{state:'running',pid:p.originalPid}]));
  const started=[],verified=[];
  return {participants,state,started,verified,options:{participants,inspect:async id=>state[id],
    start:async id=>{started.push(id);state[id]={state:'running',pid:200+started.length};},verify:async id=>{verified.push(id);}}};
}
test('job starts after WhatsApp stop: recovery preserves untouched APIs and resumes only stopped units',async()=>{
  const f=fixture();for(const id of ['inbox','fresh']){f.participants.find(p=>p.id===id).stopRequested=true;f.state[id]={state:'stopped',pid:0};}
  const result=await recoverStoppedParticipants(f.options);
  assert.deepEqual(f.started,['inbox','fresh']);assert.equal(f.state.api.pid,101);assert.equal(f.state.gateway.pid,102);
  assert.deepEqual(result.map(r=>r.action),['preserved','preserved','started','started']);assert.equal(f.verified.length,4);
});
test('partial API stop restarts only the process actually stopped and preserves the running sibling',async()=>{
  const f=fixture();for(const p of f.participants)p.stopRequested=true;f.state.api={state:'stopped',pid:0};
  await recoverStoppedParticipants(f.options);assert.deepEqual(f.started,['api']);assert.equal(f.state.gateway.pid,102);
});
test('foreign replacement, failure state, unfinished stop and an unrequested stop require review',async()=>{
  for(const current of [{state:'running',pid:999},{state:'failed',pid:0},{state:'stopping',pid:101},{state:'stopped',pid:0}]){
    const f=fixture();f.state.api=current;await assert.rejects(recoverStoppedParticipants(f.options),/unexpected_process_state/);assert.deepEqual(f.started,[]);
  }
});
test('duplicate participants and failed start are rejected without retrying any command',async()=>{
  const f=fixture();f.participants.push({...f.participants[0]});await assert.rejects(recoverStoppedParticipants(f.options),/plan_invalid/);assert.deepEqual(f.started,[]);
  const g=fixture();g.participants[0].stopRequested=true;g.state.api={state:'stopped',pid:0};
  g.options.start=async id=>g.started.push(id);
  await assert.rejects(recoverStoppedParticipants(g.options),/start_failed/);assert.deepEqual(g.started,['api']);
});
