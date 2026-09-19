'use strict';
const {processIdentity}=require('./clinicalCutProcessIdentity');
function systemdProcessObservation(values) {
  const pid=Number(values.MainPID);
  if(!Number.isInteger(pid)||pid<0)throw Error('clinical_cut_unit_pid_invalid');
  let identity=null;
  if(pid){
    try{identity=processIdentity(pid);}
    catch(error){
      // MainPID is a sampled manager property: normal stop can reap /proc
      // before the next show. A vanished process is transitional, not an
      // operator failure and not proof that systemd has finished stopping.
      if(!['ENOENT','ESRCH'].includes(error.code)&&error.message!=='clinical_cut_process_exited')throw error;
    }
  }
  const state=values.ActiveState==='active'?(identity?'running':'transitioning')
    :values.ActiveState==='inactive'?(pid?'transitioning':'stopped'):values.ActiveState;
  return{state,pid,identity};
}
module.exports={systemdProcessObservation};
