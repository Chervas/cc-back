'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Op}=require('sequelize');
const {createAppointmentPurchaseOptions}=require('../../services/appointmentPurchaseOptions.service');
function fixture(plan){
  const db={Sequelize:{Op},PatientVoucher:{findAll:async()=>[{id:1,public_id:'owned-program-option',source_system:'treatment_program',name:'Ficticio',available_units:2,unit_label:'citas'}]},
    CitaPaciente:{findAll:async()=>[]},PatientVoucherMovement:{findAll:async()=>[]}};
  return createAppointmentPurchaseOptions({db,economics:{loadContext:async()=>({patient:{id_paciente:1},clinic:{id_clinica:100}})},
    programs:{read:async()=>{if(plan instanceof Error)throw plan;return plan;}},now:()=>new Date('2030-01-01Z')}).read({clinicId:100,patientIdentifier:1,actorId:1});
}
const ordinary=()=>({name:'Programa ficticio',kind:'program',pending_count:2,can_schedule:true,can_resume:true,resume:null,
  sessions:[{scheduling_status:'pending',label:'Sesión 1'}]});
test('new pending programs expose resume capability without routing them as an interrupted legacy plan',async()=>{
  const result=await fixture(ordinary()),item=result.items[0];
  assert.equal(item.can_schedule,true);assert.equal(item.can_resume,true);assert.equal(item.requires_resume,false);
});
test('actual interrupted and manual no-show programs require the legacy resume flow; external unrecorded prefix does not',async()=>{
  const interrupted=ordinary();interrupted.resume={from_key:'s1'};interrupted.can_schedule=false;
  assert.equal((await fixture(interrupted)).items[0].requires_resume,true);
  const manual=ordinary();manual.sessions[0].scheduling_status='missed';
  assert.equal((await fixture(manual)).items[0].requires_resume,true);
  const external={...ordinary(),start_from_position:2,unrecorded_units:1,managed_units:2,consumed_units:0,
    sessions:[{scheduling_status:'unrecorded',label:'Sesión 1'},{scheduling_status:'pending',label:'Sesión 2'}]};
  const item=(await fixture(external)).items[0];assert.equal(item.requires_resume,false);assert.equal(item.next_session,'Sesión 2');
  assert.equal(item.unrecorded_units,1);assert.equal(item.managed_units,2);assert.equal(item.consumed_units,0);
});
test('unreadable/inactive program options never invent schedule or resume capabilities',async()=>{
  const item=(await fixture(Object.assign(Error('Programa inconsistente'),{statusCode:409}))).items[0];
  assert.equal(item.can_schedule,false);assert.equal(item.can_resume,false);assert.equal(item.requires_resume,false);
});
