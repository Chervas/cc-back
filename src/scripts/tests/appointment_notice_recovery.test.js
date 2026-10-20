'use strict';
const assert=require('node:assert/strict'),test=require('node:test');
const C=require('../../lib/appointment-notice-recovery');
const now=Date.parse('2026-10-20T10:00:00Z');
function snapshot(){return {appointment:{id_cita:900001,clinica_id:72,paciente_id:900002,doctor_id:900003,
  tipo_cita:'primera_sin_trat',estado:'pendiente',inicio:'2026-10-27T16:00:00.000Z',fin:'2026-10-27T16:30:00.000Z',
  created_at:'2026-10-20T07:28:23.000Z',updated_at:'2026-10-20T07:28:23.000Z',import_metadata:{}},
  patient:{has_phone:1,phone_fingerprint:'TESTONLY'},messages:[],events:[],executions:[],treatment:null};}
const message=(values={})=>({id:1,direction:'outbound',message_type:'text',status:'delivered',createdAt:'2026-10-20T08:00:00.000Z',content:'TESTONLY',...values});
test('only current future incident appointments with unchanged evidence qualify; card events are not sends',()=>{
  const s=snapshot();assert(C.assess(s,{now}).eligible);s.messages=[message({message_type:'event'})];
  assert(C.assess(s,{now}).eligible);assert.equal(C.assess(s,{now}).reviewRequired,false);
  for(const patch of [{estado:'cancelada'},{estado:'recordatorio_confirmado'},{inicio:'2026-10-20T10:05:00Z'},
    {clinica_id:35},{created_at:'2026-10-19T09:00:00Z'},{es_provisional:1},{hold_expires_at:'2026-10-20T10:30:00Z'},
    {arrived_at:'2026-10-20T09:00:00Z'},{source_system:'lead_resolution_historical'},
    {import_metadata:{synthetic_data_only:true}}]){
    const x=snapshot();Object.assign(x.appointment,patch);assert.equal(C.assess(x,{now}).eligible,false,JSON.stringify(patch));
  }
  for(const has_phone of [0,'0',null]){const x=snapshot();x.patient.has_phone=has_phone;assert(!C.assess(x,{now}).eligible);}
});
test('manual replies require individual review; pending or uncertain delivery and any existing native attempt block recovery',()=>{
  const s=snapshot();s.messages=[message()];let result=C.assess(s,{now});assert(result.eligible&&result.reviewRequired);
  for(const patch of [{status:'pending'},{status:'sending'},{outcome_unknown:true},{delivery_unknown:'true'},{dispatch_wait:1}]){
    s.messages=[message(patch)];assert(C.assess(s,{now}).reasons.includes('pending_or_uncertain_delivery'));
  }
  s.messages=[];
  for(const status of ['failed','waiting','completed','cancelled']){
    s.executions=[{id:20,trigger_type:'appointment_created',created_at:'2026-10-20T07:28:23Z',status}];
    assert(!C.assess(s,{now}).eligible);
  }
  s.executions=[{id:20,trigger_type:'appointment_reminder_window',created_at:'2026-10-20T07:04:23Z',status:'completed'}];
  assert(C.assess(s,{now}).eligible);s.messages=[message({execution_id:20})];assert(!C.assess(s,{now}).eligible);
});
test('reschedule recovery uses latest factual date or exact explicit send receipt, never a stale date or declined notice',()=>{
  const s=snapshot(),a=s.appointment;a.created_at='2026-10-04T07:00:00Z';a.estado='reprogramada';a.reschedule_reason='patient_request';
  s.events=[{id:44,event_type:'appointment.status_changed',occurred_at:'2026-10-20T09:00:00Z',metadata:{route:'reagendarCita',appointment_start:a.inicio}}];
  assert.equal(C.assess(s,{now}).source.type,'appointment_rescheduled');assert(C.assess(s,{now}).eligible);
  a.inicio='2026-10-29T16:05:00.000Z';assert(!C.assess(s,{now}).eligible);
  a.import_metadata.reschedule_notice={version:1,send:true,appointment_id:a.id_cita,patient_id:a.paciente_id,clinic_id:72,
    start_at:a.inicio,end_at:a.fin,checked_at:'2026-10-20T09:02:00.000Z',acknowledgement:'a'.repeat(64)};
  assert(C.assess(s,{now}).eligible);assert.equal(C.assess(s,{now}).source.id,'a'.repeat(64));
  a.import_metadata.reschedule_notice.send=false;assert(!C.assess(s,{now}).eligible);
});
test('recipient, appointment, treatment, received/sent evidence and explicit choices are frozen by the reviewed digest',()=>{
  const s=snapshot(),digest=C.evidenceHash(s);
  for(const change of [s=>s.patient.phone_fingerprint='CHANGED',s=>s.appointment.tipo_cita='revision',
    s=>s.appointment.care_schedule_start='2026-10-27T16:05:00Z',s=>s.appointment.doctor_id++,
    s=>s.appointment.import_metadata.notification_suppression={appointment_details:true},
    s=>s.messages.push(message()),s=>s.treatment={automation_template_bindings:{appointment_before:{enabled:false}}}]){
    const copy=structuredClone(s);change(copy);assert.notEqual(C.evidenceHash(copy),digest);
  }
});
test('bounded recovery delegates to the native resolver/enqueuer and rechecks under its transaction without changing any status',async()=>{
  const s=snapshot();let writes=0,checks=0,changed=false;
  const original={id:900010,clinic_id:72,is_active:true,published_at:'2026-10-20T09:43:45Z',
    template_key:'env_o_de_datos_de_la_cita_tras_agendar__clinic_72',trigger_type:'appointment_created',
    nodes:[{id:'send',type:'action/send_whatsapp'},{id:'wait',type:'delay/wait_response',config:{appointment_single_notice_v1:{revision:1,retired_node_id:'removed',first_send_node_id:'send'}}}]};
  const item={appointmentId:s.appointment.id_cita,eventName:'appointment_created',source:C.assess(s,{now}).source,approved:true,evidenceHash:C.evidenceHash(s)};
  const db={CitaPaciente:{findByPk:async(_id,{lock})=>{assert.equal(lock,'UPDATE');checks++;}}};
  const runtime={resolveTemplateForCitaEvent:async()=>original,enqueueExecutionForTemplate:async(a,t,options)=>{
    assert.equal(a.estado,'pendiente');assert.equal(t,original);assert.equal(options.event_name,'appointment_created');
    assert(!options.window_identifier);assert(options.trigger_data.explicit_notice_recovery);
    if(changed)s.patient.phone_fingerprint='CHANGED';await options.jobClaim.assert({transaction:{LOCK:{UPDATE:'UPDATE'}}});writes++;return {success:true};
  }};
  const args={db,runtime,item,load:async()=>structuredClone(s),actorId:44,now:()=>now};
  await C.recoverOne(args);assert.equal(writes,1);assert.equal(checks,1);assert.equal(s.appointment.estado,'pendiente');
  changed=true;await assert.rejects(C.recoverOne(args),/notice_recovery_evidence_changed/);assert.equal(writes,1);
  s.patient.phone_fingerprint='TESTONLY';await assert.rejects(C.recoverOne({...args,item:{...item,approved:false}}),/notice_recovery_evidence_changed/);
  original.nodes.push({type:'action/request_review'});await assert.rejects(C.recoverOne(args),/notice_recovery_template_ineligible/);
});
