'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {execFileSync}=require('node:child_process'),{randomUUID}=require('node:crypto');
const {systemdProcessObservation}=require('../../lib/clinicalCutSystemdIdentity');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
test('real owned systemd stop tolerates stale MainPID without treating a sampled vanished process as running or stopped',async()=>{
 assert.equal(process.env.CLINICAL_CUT_SYSTEMD_TEST,'1','Explicit CLINICAL_CUT_SYSTEMD_TEST=1 is required');
 const id='clinicaclick-cut-qa-'+randomUUID()+'.service';assert(/^clinicaclick-cut-qa-[a-f0-9-]+\.service$/.test(id));
 const command=(bin,args)=>execFileSync('sudo',['-n',bin,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000}).trim();
 const show=()=>Object.fromEntries(command('systemctl',['show',id,'--property=MainPID,ActiveState']).split('\n').map(s=>s.split('=')));
 const wait=async state=>{const deadline=Date.now()+5000;for(;;){const values=show(),observation=systemdProcessObservation(values);if(observation.state===state)return{values,observation};assert(Date.now()<deadline);await delay(10);}};
 let pid;
 try{
  command('systemd-run',['--unit='+id,'--collect','--property=User=ubuntu','--property=PrivateNetwork=yes','--property=ProtectSystem=strict','--property=NoNewPrivileges=yes','--property=TimeoutStopSec=5','/usr/bin/node','-e','setInterval(()=>{},1000)']);
  const original=await wait('running');pid=original.observation.pid;assert(original.observation.identity.startTicks);
  command('systemctl',['stop','--no-block',id]);const stopped=await wait('stopped');assert.equal(stopped.observation.pid,0);
  assert(!fs.existsSync('/proc/'+pid));
  const stale=systemdProcessObservation(original.values);assert.equal(stale.state,'transitioning');assert.equal(stale.pid,pid);assert.equal(stale.identity,null);
  console.log(JSON.stringify({kind:'owned_systemd_identity',unit:id,pid,staleMainPidHandled:true,stopped:true,success:true}));
 }finally{
  const current=show();if(current.ActiveState!=='inactive')command('systemctl',['stop',id]);
  if(pid)assert(!fs.existsSync('/proc/'+pid));
 }
});
