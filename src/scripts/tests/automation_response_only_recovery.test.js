'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {isResponseOnlyRecoveryWait}=require('../../lib/automation-response-only-recovery');
const node={id:'W',type:'delay/wait_response'};
const execution={id:10,clinic_id:66,waiting_meta:{recovery_response_only:true},context:{recovery_review:{
 kind:'operator_reviewed_response_wait_recovery',first_notice_replayed:false,source_execution_id:10,
 clinic_id:66,wait_node_id:'W',source_outbound_id:20}}};
test('the exact reviewed wait can suppress its timeout, not another execution or node',()=>{
 assert.equal(isResponseOnlyRecoveryWait(execution,node),true);
 for(const patch of [{source_execution_id:11},{clinic_id:72},{wait_node_id:'other'},{first_notice_replayed:true},
  {kind:'unreviewed'},{source_outbound_id:null}]){
  const e=structuredClone(execution);Object.assign(e.context.recovery_review,patch);assert.equal(isResponseOnlyRecoveryWait(e,node),false);
 }
 assert.equal(isResponseOnlyRecoveryWait(execution,{...node,type:'action/send_whatsapp'}),false);
 assert.equal(isResponseOnlyRecoveryWait({id:10,clinic_id:66},node),false);
});
