'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createAppointmentVisitManagedService}=require('../../services/appointmentVisitManaged.service');
const transaction={options:{isolationLevel:'READ COMMITTED'},LOCK:{UPDATE:'UPDATE'}};
function service({enabled=false,error='ER_NO_SUCH_TABLE',stored=null}={}) {
 const db={FlowExecutionV2:{findByPk:async()=>({id:1,status:'running',context:{},created_by:1})},
  AppointmentVisitMember:{findByPk:async()=>{if(error)throw Object.assign(Error('uninstalled'),{original:{code:error}});return {visit_id:1};}},
  AppointmentVisit:{findByPk:async()=>stored}};
 return createAppointmentVisitManagedService({db,enabled:()=>enabled});
}
test('unenrolled legacy status mutation tolerates uninstalled managed tables only while rollout is closed',async()=>{
 assert.equal(await service().assertMutationNode({id:1,context:{}},{id:'change'},{transaction,appointmentId:1,clinicId:72}),null);
 await assert.rejects(service({enabled:true}).assertMutationNode({id:1,context:{}},{id:'change'},{transaction,appointmentId:1}),/uninstalled/);
 await assert.rejects(service({error:'ER_LOCK_DEADLOCK'}).assertMutationNode({id:1,context:{}},{id:'change'},{transaction,appointmentId:1}),/uninstalled/);
});
test('lost execution binding and stored enrollment remain fail-closed; no legacy fallback',async()=>{
 await assert.rejects(service().assertMutationNode({id:1,context:{appointment_visit:{visit_id:1}}},{id:'change'},
  {transaction,appointmentId:1}),e=>e.code==='appointment_visit_runtime_mutation_binding_required');
 await assert.rejects(service({error:null,stored:{runtime_enrollment:{}}}).assertMutationNode({id:1,context:{}},{id:'change'},
  {transaction,appointmentId:1}),e=>e.code==='appointment_visit_runtime_mutation_binding_required');
});
