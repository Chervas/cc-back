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
  define('CitaPaciente','CitasPacientes',{id_cita:id,clinica_id:D.INTEGER,paciente_id:D.INTEGER,estado:D.STRING,inicio:D.DATE,titulo:D.STRING});
  define('AutomationFlowTemplateV2','AutomationFlowTemplatesV2',{id,template_key:D.STRING,version:D.INTEGER,public_id:D.STRING,name:D.STRING,clinic_id:D.INTEGER,group_id:D.INTEGER,is_system:D.BOOLEAN,created_by:D.INTEGER,is_active:D.BOOLEAN,published_at:D.DATE});
  define('FlowExecutionV2','FlowExecutionsV2',{id,trigger_entity_id:D.INTEGER,trigger_entity_type:D.STRING,trigger_type:D.STRING,clinic_id:D.INTEGER,template_version_id:D.INTEGER,idempotency_key:D.STRING,status:D.STRING,wait_until:D.DATE,created_at:D.DATE,context:D.JSON});
  define('JobRequest','JobRequests',{id,type:D.STRING,status:D.STRING,payload:D.JSON,result_summary:D.JSON,next_run_at:D.DATE,created_at:D.DATE});
  define('Conversation','Conversations',{id,clinic_id:D.INTEGER,patient_id:D.INTEGER,channel:D.STRING});
  define('Message','Messages',{id,conversation_id:D.INTEGER,status:D.STRING,direction:D.STRING,message_type:D.STRING,metadata:D.JSON,sent_at:D.DATE,createdAt:D.DATE});
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
}).catch(error=>{console.error(error.stack||error.message);process.exitCode=1;});
