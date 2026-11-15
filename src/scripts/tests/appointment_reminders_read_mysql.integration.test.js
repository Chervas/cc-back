'use strict';
const assert=require('node:assert/strict'),S=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
withIsolatedCampaignMysql(async({sql,models:db,report})=>{
  const D=S.DataTypes;
  const define=(name,tableName,fields)=>db[name]=sql.define(name,Object.fromEntries(Object.entries(fields).map(([key,value])=>[key,value&&value.type?{...value}:value])),{tableName,timestamps:false});
  const id={type:D.INTEGER,primaryKey:true};
  define('Clinica','Clinicas',{id_clinica:id,grupoClinicaId:D.INTEGER,configuracion:D.JSON});
  define('Paciente','Pacientes',{id_paciente:id,public_id:D.STRING,clinica_id:D.INTEGER,nombre:D.STRING,apellidos:D.STRING});
  define('PacienteClinica','PacienteClinicas',{id,paciente_id:D.INTEGER,clinica_id:D.INTEGER});
  define('UsuarioClinica','UsuarioClinica',{id,id_usuario:D.INTEGER,id_clinica:D.INTEGER,rol_clinica:D.STRING,estado_invitacion:D.STRING});
  define('CitaPaciente','CitasPacientes',{id_cita:id,clinica_id:D.INTEGER,paciente_id:D.INTEGER,estado:D.STRING,inicio:D.DATE,titulo:D.STRING,import_metadata:D.JSON});
  define('AutomationFlowTemplateV2','AutomationFlowTemplatesV2',{id,template_key:D.STRING,version:D.INTEGER,public_id:D.STRING,name:D.STRING,clinic_id:D.INTEGER,group_id:D.INTEGER,is_system:D.BOOLEAN,created_by:D.INTEGER,is_active:D.BOOLEAN,published_at:D.DATE});
  define('FlowExecutionV2','FlowExecutionsV2',{id,trigger_entity_id:D.INTEGER,trigger_entity_type:D.STRING,trigger_type:D.STRING,clinic_id:D.INTEGER,template_version_id:D.INTEGER,idempotency_key:D.STRING,status:D.STRING,wait_until:D.DATE,created_at:D.DATE,context:D.JSON});
  define('JobRequest','JobRequests',{id,type:D.STRING,status:D.STRING,payload:D.JSON,result_summary:D.JSON,next_run_at:D.DATE,created_at:D.DATE});
  define('Conversation','Conversations',{id,clinic_id:D.INTEGER,patient_id:D.INTEGER,channel:D.STRING});
  define('Message','Messages',{id,conversation_id:D.INTEGER,status:D.STRING,direction:D.STRING,message_type:D.STRING,metadata:D.JSON,sender_id:D.INTEGER,sent_at:D.DATE,createdAt:D.DATE});
  await sql.sync({force:true});
  await db.Clinica.bulkCreate([{id_clinica:1,grupoClinicaId:5,configuracion:{timezone:'Europe/Madrid'}},{id_clinica:2,grupoClinicaId:6}]);
  await db.Paciente.bulkCreate([{id_paciente:1,public_id:'FICTICIO-1',clinica_id:1,nombre:'Prueba',apellidos:'%_ Uno'},{id_paciente:2,public_id:'AJENO',clinica_id:2,nombre:'Ajeno'}]);
  await db.UsuarioClinica.create({id:1,id_usuario:7,id_clinica:1,rol_clinica:'personaldeclinica',estado_invitacion:'aceptada'});
  await db.CitaPaciente.bulkCreate([{id_cita:100,clinica_id:1,paciente_id:1,estado:'informacion_confirmada',inicio:'2030-01-20T10:00:00Z',titulo:'Cita ficticia estética'},
    {id_cita:101,clinica_id:1,paciente_id:2,estado:'programada',inicio:'2030-01-20T10:00:00Z',titulo:'Mal vinculada'},
    {id_cita:200,clinica_id:2,paciente_id:2,estado:'programada',inicio:'2030-01-20T10:00:00Z',titulo:'Cita ajena'}]);
  await db.AutomationFlowTemplateV2.bulkCreate([{id:1,template_key:'demo',version:1,public_id:'demo-public',name:'Regla ficticia',clinic_id:1,is_system:false,created_by:7,is_active:true,published_at:new Date()},
    {id:2,template_key:'foreign',version:1,public_id:'foreign-public',name:'Regla ajena',clinic_id:2,is_system:false,created_by:8,is_active:true,published_at:new Date()}]);
  const scheduled='2030-01-19T08:00:00.000Z',window='schedule:appointment_reminder_window:day_before:custom:09:00:'+scheduled;
  const job=(id,appointment=100,status='waiting',extra={})=>({id,type:'appointment_automation_schedule_fire',status,payload:{appointment_id:appointment,trigger_type:'appointment_reminder_window',template_key:'demo',window_identifier:window,scheduled_for:scheduled,__runtime_namespace:'test',...extra},next_run_at:scheduled,created_at:'2030-01-01T00:00:00Z'});
  await db.JobRequest.bulkCreate([job(9,100,'cancelled'),job(10),job(11,101),job(12,200)]);
  let allowClinical=true,allowChat=true,allowMarketing=true;
  const service=require('../../services/appointmentRemindersRead.service').createAppointmentRemindersReadService({db,now:()=>new Date('2030-01-10T10:00:00Z'),nativeEnabled:()=>true,
    runtimePolicy:{namespaces:['test'],claimUnscoped:false},adminIds:()=>[],canAccess:async({clinicId,featureKey})=>clinicId===1&&(featureKey==='quickchat.read_patients'?allowChat:featureKey==='marketing'?allowMarketing:allowClinical)});
  const list=query=>service.list({actorId:7,clinicId:1,query});
  let result=await list({});assert.equal(result.total,1);assert.equal(result.items[0].id,'scheduled:10');assert.equal(result.items[0].status,'scheduled');assert.equal(result.available_sources.visit,false);
  assert.equal(result.items[0].scheduled_at,scheduled);assert(result.items[0].links.automation.includes('demo-public/regla-ficticia/v/1'));
  report.checks.push('future legacy timers visible without optional native tables; duplicate timers collapse and foreign patients/sites excluded');
  assert.equal((await list({q:'%_'})).total,1);assert.equal((await list({q:'%_notwildcard'})).total,0);
  assert.equal((await list({date_from:'2030-01-19',date_to:'2030-01-19'})).total,1);assert.equal((await list({date_from:'2030-01-20'})).total,0);
  report.checks.push('server search escapes literal wildcards and date filters use clinic local bounds');
  const execution=(id,status,windowId=window)=>({id,trigger_entity_id:100,trigger_entity_type:'appointment',trigger_type:'appointment_reminder_window',clinic_id:1,template_version_id:1,
    idempotency_key:'appointment_reminder_window:100:1:'+windowId,status,created_at:'2030-01-01T10:00:00Z',context:{trigger:{schedule_moment:'day_before'}}});
  await db.FlowExecutionV2.bulkCreate([execution(20,'completed'),execution(22,'completed',window+':other'),execution(23,'failed',window+':failed')]);
  await db.Conversation.bulkCreate([{id:1,clinic_id:1,patient_id:1,channel:'whatsapp'},{id:2,clinic_id:2,patient_id:2,channel:'whatsapp'}]);
  await db.Message.bulkCreate([{id:30,conversation_id:1,status:'read',direction:'outbound',message_type:'template',metadata:{execution_id:20},sent_at:'2030-01-09T09:00:00Z'},
    {id:31,conversation_id:2,status:'delivered',direction:'outbound',message_type:'template',metadata:{execution_id:22},sent_at:'2030-01-09T09:00:00Z'}]);
  result=await list({status:'all'});assert.equal(result.total,3);assert.equal(result.items.find(x=>x.id==='message:30').status,'read');
  assert.equal(result.items.find(x=>x.id==='execution:22').status,'unknown');assert.equal(result.items.find(x=>x.id==='execution:23').status,'failed');assert(!result.items.some(x=>x.source.message_id===31));
  assert.equal((await list({})).total,2);assert.equal((await list({status:'all',page_size:1,page:1})).items.length,1);
  report.checks.push('explicit execution/message evidence dedupes the timer; completed without delivery stays unknown; foreign conversation evidence never leaks');
  allowChat=false;allowMarketing=false;result=await list({status:'read'});assert.equal(result.items[0].source.conversation_id,null);assert.equal(result.items[0].links.automation,null);
  allowClinical=false;await assert.rejects(list({}),{code:'access_policy_forbidden'});allowClinical=true;allowChat=true;allowMarketing=true;
  report.checks.push('clinical ACL gates all rows/counts; chat IDs and automation links require additional real read permissions');
  define('AppointmentVisit','AppointmentVisits',{id:{type:D.STRING(36),primaryKey:true},clinic_id:D.INTEGER,patient_id:D.INTEGER,communication_revision:D.INTEGER});
  define('AppointmentVisitCommunication','AppointmentVisitCommunications',{id:{type:D.STRING(36),primaryKey:true},visit_id:D.STRING,clinic_id:D.INTEGER,patient_id:D.INTEGER,owner_appointment_id:D.INTEGER,purpose:D.STRING,status:D.STRING,template_version_id:D.INTEGER,execution_id:D.INTEGER,message_id:D.INTEGER,window_starts_at:D.DATE,communication_revision:D.INTEGER,cancellation_reason:D.STRING,created_at:D.DATE});
  await db.AppointmentVisit.sync();await db.AppointmentVisitCommunication.sync();
  await db.AppointmentVisit.create({id:'visit-1',clinic_id:1,patient_id:1,communication_revision:1});
  const intent=(id,status,extra={})=>({id,visit_id:'visit-1',clinic_id:1,patient_id:1,owner_appointment_id:100,purpose:'reminder_day_before',status,template_version_id:1,window_starts_at:scheduled,communication_revision:1,created_at:'2030-01-01T00:00:00Z',...extra});
  await db.AppointmentVisitCommunication.bulkCreate([intent('intent-1','accepted',{execution_id:20,message_id:30}),intent('intent-2','accepted'),intent('intent-3','unknown'),intent('intent-4','pending',{purpose:'reminder_same_day',window_starts_at:'2030-01-20T08:00:00Z'})]);
  result=await list({status:'all'});assert.equal(result.available_sources.visit,true);assert.equal(result.total,6);assert.equal(result.items.filter(x=>x.source.message_id===30).length,1);
  assert.equal(result.items.find(x=>x.id==='visit:intent-1').status,'read');assert.equal(result.items.find(x=>x.id==='visit:intent-2').status,'unknown');
  assert.equal(result.items.find(x=>x.id==='visit:intent-3').status,'unknown');assert.equal(result.items.find(x=>x.id==='visit:intent-4').status,'scheduled');
  report.checks.push('native future intentions and legacy executions coexist without duplicate message rows; accepted or unknown native results never imply sent');
  await db.FlowExecutionV2.bulkCreate([execution(24,'completed',window+':sent'),execution(25,'completed',window+':delivered'),execution(26,'completed',window+':queued'),execution(27,'completed',window+':processing')]);
  await db.Message.bulkCreate(['sent','delivered','pending','sending'].map((status,index)=>({id:32+index,conversation_id:1,status,direction:'outbound',message_type:'template',metadata:{execution_id:24+index},sent_at:status==='sent'||status==='delivered'?'2030-01-09T09:00:00Z':null})));
  await db.Message.create({id:36,conversation_id:1,status:'pending',direction:'outbound',message_type:'template',metadata:{}});
  await db.AppointmentVisitCommunication.create(intent('intent-cancelled','cancelled',{message_id:36}));
  result=await list({status:'all'});
  for(const [index,status]of ['sent','delivered','queued','processing'].entries())assert.equal(result.items.find(x=>x.id==='message:'+(32+index)).status,status);
  assert.equal(result.items.find(x=>x.id==='visit:intent-cancelled').status,'cancelled');
  report.checks.push('actual sent/delivered receipts are distinct; completed execution with pending transport stays queued; cancelled native pending message remains cancelled');
  await db.JobRequest.create(job(40,100,'waiting',{window_identifier:'different-window',scheduled_for:'2030-01-18T08:00:00.000Z',__runtime_namespace:'foreign-runtime'}));
  await db.JobRequest.create({...job(41,100,'completed',{window_identifier:'skipped-window',scheduled_for:'2030-01-17T08:00:00.000Z'}),result_summary:{skipped:true,reason:'appointment_already_confirmed',raw_error:'PRIVATE DO NOT PROJECT'}});
  const before={jobs:await db.JobRequest.count(),messages:await db.Message.count(),appointments:await db.CitaPaciente.count(),intents:await db.AppointmentVisitCommunication.count()};
  result=await list({status:'all'});assert.equal(result.items.find(x=>x.id==='scheduled:40').status,'blocked');
  const skipped=result.items.find(x=>x.id==='scheduled:41');assert.equal(skipped.status,'skipped');assert.equal(skipped.reason_code,'appointment_already_confirmed');assert(!JSON.stringify(skipped).includes('PRIVATE'));
  assert.deepEqual({jobs:await db.JobRequest.count(),messages:await db.Message.count(),appointments:await db.CitaPaciente.count(),intents:await db.AppointmentVisitCommunication.count()},before);
  assert(result.items.every(x=>x.read_only===true&&!('metadata' in x)&&!('content' in x)&&!('last_error' in x)));
  report.checks.push('wrong runtime schedules are blocked, DTO has no raw message/graph/error payloads and projection creates or changes no source rows');
  let aclCalls=0;
  const revocationReader=require('../../services/appointmentRemindersRead.service').createAppointmentRemindersReadService({db,now:()=>new Date('2030-01-10T10:00:00Z'),nativeEnabled:()=>true,
    runtimePolicy:{namespaces:['test'],claimUnscoped:false},canAccess:async()=>++aclCalls<=3});
  await assert.rejects(revocationReader.list({actorId:7,clinicId:1}),{code:'access_policy_forbidden'});
  report.checks.push('permission revocation during the read is rechecked before any rows or count are returned');
  await db.FlowExecutionV2.create({...execution(50,'completed',window+':foreign-template'),template_version_id:2});
  await db.AppointmentVisitCommunication.create(intent('foreign-template-intent','pending',{template_version_id:2,window_starts_at:'2030-01-20T09:00:00Z'}));
  result=await list({status:'all'});
  for(const id of ['execution:50','visit:foreign-template-intent']) {
    const row=result.items.find(x=>x.id===id);assert(row);assert.equal(row.template_name,null);assert.equal(row.template_version,null);assert.equal(row.links.automation,null);
  }
  assert.equal((await list({q:'Regla ajena',status:'all'})).total,0);
  report.checks.push('a corrupt foreign template binding exposes neither its label/version/link nor a search-count oracle');

  define('ConversationAutomationState','ConversationAutomationStates',{id,conversation_id:D.INTEGER,clinic_id:D.INTEGER,status:D.STRING,stage:D.STRING,source_message_id:D.INTEGER,appointment_id:D.INTEGER,manual_action_required:D.BOOLEAN,needs_response:D.BOOLEAN});
  define('AutomationInboundMessageClaim','AutomationInboundMessageClaims',{id,message_id:D.INTEGER,conversation_id:D.INTEGER,clinic_id:D.INTEGER,owner_type:D.STRING,metadata:D.JSON});
  define('AppointmentReminderSequence','AppointmentReminderSequences',{id,clinic_id:D.INTEGER,patient_id:D.INTEGER,anchor_appointment_id:D.INTEGER,time_zone:D.STRING,local_date:D.DATEONLY,arrival_at:D.DATE});
  await db.ConversationAutomationState.sync();await db.AutomationInboundMessageClaim.sync();await db.AppointmentReminderSequence.sync();
  await db.Paciente.bulkCreate(Array.from({length:5},(_,i)=>({id_paciente:i+3,public_id:'FICTION-'+i,clinica_id:1,nombre:'Ficticio '+i})));
  await db.CitaPaciente.bulkCreate(Array.from({length:5},(_,i)=>({id_cita:300+i,clinica_id:1,paciente_id:i+3,estado:i===2?'recordatorio_confirmado':'recordatorio_enviado',inicio:'2030-01-20T10:00:00Z',titulo:'Solo prueba',import_metadata:i===4?{notification_suppression:{reason:'manual_selection',same_day:true,day_before:true}}:null})));
  await db.CitaPaciente.create({id_cita:305,clinica_id:1,paciente_id:3,estado:'recordatorio_confirmado',inicio:'2030-01-20T11:00:00Z',titulo:'Segunda sesión ficticia'});
  await db.AppointmentReminderSequence.create({id:1,clinic_id:1,patient_id:3,anchor_appointment_id:300,time_zone:'Europe/Madrid',local_date:'2030-01-20',arrival_at:'2030-01-20T10:00:00Z'});
  await db.Conversation.bulkCreate(Array.from({length:4},(_,i)=>({id:10+i,clinic_id:1,patient_id:i+3,channel:'whatsapp'})));
  await db.FlowExecutionV2.bulkCreate(Array.from({length:4},(_,i)=>({...execution(60+i,'completed',window+':fixture-'+i),trigger_entity_id:300+i})));
  const msg=(id,conversation_id,direction,extra={})=>({id,conversation_id,direction,message_type:'text',status:direction==='outbound'?'read':'received',createdAt:'2030-01-09T09:00:00Z',metadata:{},...extra});
  await db.Message.bulkCreate([
    msg(59,10,'outbound',{status:'failed',metadata:{execution_id:60,node_id:'n2'}}),
    msg(60,10,'outbound',{metadata:{execution_id:60,node_id:'n2'}}),msg(61,10,'inbound'),msg(62,10,'outbound',{metadata:{execution_id:60,node_id:'n8'}}),
    msg(69,11,'inbound'),msg(70,11,'outbound',{metadata:{execution_id:61,node_id:'n2'}}),
    msg(80,12,'outbound',{metadata:{execution_id:62,node_id:'n2'}}),msg(85,12,'inbound'),
    msg(90,13,'outbound',{metadata:{execution_id:63,node_id:'n2'}}),msg(91,13,'inbound'),msg(99,13,'outbound',{sender_id:7})]);
  await db.ConversationAutomationState.bulkCreate([{id:1,conversation_id:10,clinic_id:1,status:'review',stage:'review',source_message_id:61,appointment_id:300,manual_action_required:true},
    {id:2,conversation_id:11,clinic_id:1,status:'completed',stage:'completed',source_message_id:50,appointment_id:301}]);
  await db.AutomationInboundMessageClaim.bulkCreate([69,85,91].map((message_id,i)=>({id:i+1,message_id,conversation_id:i+11,clinic_id:1,owner_type:'unclaimed',metadata:{reason:'no_active_message_received_automation'}})));
  const current={status:'all',date_field:'appointment',date_from:'2030-01-20',date_to:'2030-01-20',include_unplanned:true,include_history:false,page_size:100};
  result=await list(current);
  assert.equal(result.items.filter(r=>r.appointment_id===300).length,1);
  const reviewed=result.items.find(r=>r.appointment_id===300);assert.equal(reviewed.source.message_id,60);assert.equal(reviewed.attention.status,'review');assert.equal(reviewed.history_total,3);assert.equal(reviewed.linked_appointments.length,1);assert.equal(reviewed.linked_appointments[0].id,305);
  assert(!result.items.some(r=>r.appointment_id===305));
  assert.equal(result.items.find(r=>r.appointment_id===301).attention.status,'unclaimed','a new automatic reminder must not resolve an earlier unhandled inbound');
  const confirmed=result.items.find(r=>r.appointment_id===302);assert.equal(confirmed.appointment_status,'recordatorio_confirmado');assert.equal(confirmed.attention.status,'unclaimed');
  assert.equal(result.items.find(r=>r.appointment_id===303).attention.status,null,'real human reply resolves pending, including mobile echoes');
  const suppressed=result.items.find(r=>r.appointment_id===304);assert.equal(suppressed.status,'unplanned');assert.equal(suppressed.reason_code,'appointment_notification_suppressed');
  assert.equal(result.summary.reception,3);assert.equal((await list({...current,page_size:1})).summary.reception,3,'KPIs must not count the current page');
  assert.equal((await list({...current,status:'reception'})).total,3);
  report.checks.push('notice vs acknowledgement vs retries, linked coverage, review vs delivery, pre-reminder unclaimed response, confirmed plus later question, human reply, suppression and scoped server KPIs');
  await db.ConversationAutomationState.update({status:'completed',stage:'completed',source_message_id:69},{where:{id:2}});
  assert.equal((await list(current)).items.find(r=>r.appointment_id===301).attention.status,null,'explicit handling closes the same or older pending response');
  allowChat=false;result=await list(current);assert.equal(result.items.find(r=>r.appointment_id===300).attention.conversation_id,null);assert.equal(result.items.find(r=>r.appointment_id===300).attention.message_id,null);allowChat=true;
  const beforeReads={jobs:await db.JobRequest.count(),messages:await db.Message.count(),appointments:await db.CitaPaciente.count(),states:await db.ConversationAutomationState.count(),claims:await db.AutomationInboundMessageClaim.count()};
  result=await list({...current,window:'today_tomorrow'});assert.equal(result.date_from,'2030-01-10');assert.equal(result.date_to,'2030-01-11');
  assert.deepEqual({jobs:await db.JobRequest.count(),messages:await db.Message.count(),appointments:await db.CitaPaciente.count(),states:await db.ConversationAutomationState.count(),claims:await db.AutomationInboundMessageClaim.count()},beforeReads);
  report.checks.push('explicit completed handling, chat privacy, clinic-local prospective defaults and no source writes');

  await db.FlowExecutionV2.create({...execution(1000,'completed',window+':obsolete'),trigger_entity_id:300,context:{trigger:{schedule_moment:'day_before'},appointment:{inicio:'2029-12-20T10:00:00.000Z'}}});
  await db.Message.create(msg(1000,10,'outbound',{metadata:{execution_id:1000,node_id:'n2'}}));
  assert.equal((await list(current)).items.filter(r=>r.appointment_id===300).length,1,'a prior appointment snapshot must not appear as a current notice');
  const historical=(await list({...current,include_history:true})).items.find(r=>r.source.execution_id===1000);assert.equal(historical.superseded,true);assert.equal(historical.original_appointment_start,'2029-12-20T10:00:00.000Z');
  await db.FlowExecutionV2.create({...execution(1001,'failed',window+':configuration-failure'),trigger_entity_id:304,context:{trigger:{schedule_moment:'day_before'},outputs:{n2:{error_message:'whatsapp_config_missing'}}}});
  assert.equal((await list(current)).items.find(r=>r.appointment_id===304).reason_code,'whatsapp_config_missing');
  await db.CitaPaciente.update({import_metadata:'unstructured import receipt'},{where:{id_cita:305}});
  assert((await list(current)).items.length>0,'non-object legacy import metadata must not break other reminders');
  const dstReader=require('../../services/appointmentRemindersRead.service').createAppointmentRemindersReadService({db,now:()=>new Date('2030-03-30T23:30:00Z'),runtimePolicy:{namespaces:['test'],claimUnscoped:false},canAccess:async()=>true});
  const dst=await dstReader.list({actorId:7,clinicId:1,query:{window:'today_tomorrow',date_field:'appointment',status:'all',include_unplanned:true,include_history:false}});
  assert.equal(dst.date_from,'2030-03-31');assert.equal(dst.date_to,'2030-04-01');
  report.checks.push('historical appointment snapshots separated, safe concrete failure reason, irregular import receipt isolation and clinic-local DST defaults');
}).catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
