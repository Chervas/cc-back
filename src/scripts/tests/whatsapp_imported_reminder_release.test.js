'use strict';
const test=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm');
const release=require('../../lib/whatsappImportedReminderRelease');
const now=Date.parse('2026-10-05T10:00:00Z');
function fixture(){
 const policy=release.validate({version:1,purpose:'day_before_reminder',approvalRef:'user_approval_20261005',approvedBy:1,
  approvedAt:'2026-10-05T09:00:00.000Z',startsNotBefore:'2026-10-05T22:00:00.000Z',expiresAt:'2026-10-12T22:00:00.000Z',
  automaticBacklogReplay:false,sameDayAllowed:false,appointments:[{id:10,clinicId:72,patientId:20,templateVersionId:1552,
   startAt:'2026-10-06T15:00:00.000Z',sourceSystem:'cliniccloud',sourceReference:'source:10'}]});
 const appointment={id_cita:10,clinica_id:72,paciente_id:20,inicio:'2026-10-06T15:00:00.000Z',estado:'pendiente',source_system:'cliniccloud',source_reference:'source:10',
  import_metadata:{cliniccloud_reconciliation:{automation_policy:'hold'},notification_suppression:{day_before:true,same_day:true}}};
 const execution={id:50,clinic_id:72,template_version_id:1552,trigger_type:'appointment_reminder_window',trigger_entity_type:'appointment',trigger_entity_id:10,
  created_at:'2026-10-05T09:10:00.000Z',context:{appointment:{inicio:appointment.inicio}}};
 const c={module:{exports:{}},Date,Intl,require:name=>{
  if(name==='./whatsappImportedReminderRelease')return {...release,permits:(a,o)=>release.permits(a,{...o,now:o?.now??now,policy})};
  if(name==='./whatsappImportedAppointmentOperations')return {permits:()=>false,permitsPatientHoldOverride:()=>false,allowsSuppressionOverride:()=>false};
  throw Error('unexpected_dependency');
 }};vm.createContext(c);vm.runInContext(fs.readFileSync(require.resolve('../../lib/whatsappAppointmentEligibility'),'utf8'),c);
 return {policy,appointment,execution,eligibility:c.module.exports};
}
test('an exact fresh day-before release overrides import hold without mutating provenance or clinical metadata',()=>{
 const f=fixture(),before=JSON.stringify(f.appointment);
 assert.equal(f.eligibility.assertAppointmentEligibility({...f,clinicId:72,patientId:20,templateName:'clinicaclick_recordatorio_dia_antes_v11',now}),true);
 assert.equal(JSON.stringify(f.appointment),before);
});
test('no scope, start, source, template, historical execution or expired release substitution',()=>{
 const f=fixture();
 for(const change of [{id_cita:11},{clinica_id:66},{paciente_id:21},{inicio:'2026-10-06T15:01:00Z'},{source_reference:'other'},{source_system:'lead_resolution_historical'}])
  assert.equal(release.permits({...f.appointment,...change},{policy:f.policy,execution:f.execution,now}),false);
 for(const change of [{template_version_id:1782},{created_at:'2026-10-05T08:59:00Z'},{trigger_entity_type:'entity'},{clinic_id:66},{trigger_type:'appointment_created'}])
  assert.equal(release.permits(f.appointment,{policy:f.policy,execution:{...f.execution,...change},now}),false);
 for(const time of [Date.parse('2026-10-05T08:00Z'),Date.parse(f.policy.expiresAt)])assert.equal(release.permits(f.appointment,{policy:f.policy,now:time}),false);
});
test('same-day sends, cancelled/confirmed appointments and tomorrow mismatch remain rejected',()=>{
 for(const change of [{templateName:'clinicaclick_recordatorio_mismo_dia_v9'},{appointment:{estado:'cancelada'}},{appointment:{estado:'recordatorio_confirmado'}},{now:Date.parse('2026-10-06T08:00Z')}]){
  const f=fixture();const input={...f,clinicId:72,patientId:20,templateName:'clinicaclick_recordatorio_dia_antes_v11',now,...change};
  if(change.appointment)input.appointment={...f.appointment,...change.appointment};assert.throws(()=>f.eligibility.assertAppointmentEligibility(input));
 }
});
test('patient hold is bypassed only for the exact released reminder execution, not unrelated automations',async()=>{
 const f=fixture(),input={message:{metadata:{execution_id:50}},conversation:{clinic_id:72,patient_id:20},patientHeld:async()=>true,
  loadExecution:async()=>f.execution,loadAppointment:async()=>f.appointment,payload:{type:'template',template:{name:'clinicaclick_recordatorio_dia_antes_v11'}}};
 // Inject the fixed test clock without changing process clock or runtime config.
 const original=f.eligibility.assertAppointmentEligibility;
 const fakeDate=class extends Date {static now(){return now}};
 const c={module:{exports:{}},Date:fakeDate,Intl,require:name=>{
  if(name==='./whatsappImportedReminderRelease')return {permits:(a,o)=>release.permits(a,{...o,policy:f.policy,now})};
  if(name==='./whatsappImportedAppointmentOperations')return {permits:()=>false,permitsPatientHoldOverride:()=>false,allowsSuppressionOverride:()=>false};throw Error(name);
 }};vm.createContext(c);vm.runInContext(fs.readFileSync(require.resolve('../../lib/whatsappAppointmentEligibility'),'utf8'),c);
 assert.equal(await c.module.exports.assertAutomatedMessageEligibility(input),true);
 await assert.rejects(c.module.exports.assertAutomatedMessageEligibility({...input,loadExecution:async()=>({...f.execution,trigger_entity_type:'entity'})}),{code:'whatsapp_patient_import_held'});
 await assert.rejects(c.module.exports.assertAutomatedMessageEligibility({...input,loadExecution:async()=>({...f.execution,created_at:'2026-10-05T08:00Z'})}),{code:'whatsapp_patient_import_held'});
 assert.equal(typeof original,'function');
});
test('the registry fails closed for DEV, gateway and absent configuration',()=>{
 assert.equal(release.read({}),null);
 assert.equal(release.read({WHATSAPP_AUTHORIZED_BROKER_CONFIG_FILE:'/etc/clinicaclick-whatsapp-authorized/dev/config.json'}),null);
 assert.equal(release.read({RUNTIME_ROLE:'gateway',WHATSAPP_AUTHORIZED_BROKER_CONFIG_FILE:'/etc/clinicaclick-whatsapp-authorized/staging/config.json'}),null);
});
test('fresh inbound release requires a sent reminder in the same conversation and revalidates the current reservation',async()=>{
 const f=fixture(),queries=[],db={sequelize:{query:async(sql,options)=>{queries.push({sql,options});return [[f.execution]]}},
  CitaPaciente:{findByPk:async()=>f.appointment}};
 const conversation={id:60,clinic_id:72,patient_id:20},message={sent_at:'2026-10-05T09:55:00.000Z'};
 assert.equal(await release.permitsReply(conversation,message,db,null,{policy:f.policy,now}),true);
 assert.match(queries[0].sql,/m.status IN \('sent','delivered','read'\)/);
 assert.match(queries[0].sql,/m.message_type<>'event'/);
 assert.match(queries[0].sql,/m.conversation_id=:conversationId/);
 assert.equal(queries[0].options.replacements.conversationId,60);
 assert.equal(await release.permitsReply({...conversation,clinic_id:66},message,db,null,{policy:f.policy,now}),false);
 f.appointment.inicio='2026-10-06T15:01:00Z';
 assert.equal(await release.permitsReply(conversation,message,db,null,{policy:f.policy,now}),false);
});
