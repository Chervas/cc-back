'use strict';
const assert=require('node:assert/strict'),S=require('sequelize'),{DataTypes:D}=S;
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {loadSource}=require('./fixtures/business_profile_flow_runtime.fixture');
const C=require('../../lib/manual-appointment-notice');
withIsolatedCampaignMysql(async({sql,models:db,report})=>{
  db.Sequelize=S;
  const define=(name,fields,tableName=name)=>sql.define(name,fields,{tableName,timestamps:false});
  db.Clinica=define('Clinica',{id_clinica:{type:D.INTEGER,primaryKey:true},nombre_clinica:D.STRING,direccion:D.STRING,configuracion:D.JSON},'Clinicas');
  db.Paciente=define('Paciente',{id_paciente:{type:D.INTEGER,primaryKey:true},clinica_id:D.INTEGER,nombre:D.STRING,telefono_movil:D.STRING,idioma_preferido:D.STRING},'Pacientes');
  db.PacienteClinica=define('PacienteClinica',{paciente_id:D.INTEGER,clinica_id:D.INTEGER},'PacienteClinicas');
  db.CitaPaciente=define('CitaPaciente',{id_cita:{type:D.INTEGER,primaryKey:true},paciente_id:D.INTEGER,clinica_id:D.INTEGER,estado:D.STRING,
    inicio:D.DATE,fin:D.DATE,source_system:D.STRING,source_reference:D.STRING,import_metadata:D.JSON,es_provisional:D.BOOLEAN},'CitasPacientes');
  db.Conversation=define('Conversation',{id:{type:D.INTEGER,autoIncrement:true,primaryKey:true},clinic_id:D.INTEGER,patient_id:D.INTEGER,
    lead_id:D.INTEGER,channel:D.STRING,contact_id:D.STRING,unread_count:D.INTEGER,last_message_at:D.DATE,updatedAt:D.DATE},'Conversations');
  db.Message=require('../../../models/message')(sql,D);
  db.JobRequest=require('../../../models/jobrequest')(sql,D);
  db.PatientOperationalEvent=require('../../../models/patientoperationalevent')(sql,D);
  db.PatientOperationalEvent.options.indexes=db.PatientOperationalEvent.options.indexes.map((index,i)=>({...index,name:'qa_patient_event_'+i}));
  db.PatientOperationalEvent._indexes=db.PatientOperationalEvent.options.indexes;
  db.WhatsappTemplateCatalog=require('../../../models/whatsapptemplatecatalog')(sql,D);
  db.WhatsappTemplate=require('../../../models/whatsapptemplate')(sql,D);
  db.FlowExecutionV2=define('FlowExecutionV2',{id:{type:D.INTEGER,primaryKey:true},status:D.STRING,context:D.JSON,trigger_entity_type:D.STRING,trigger_entity_id:D.INTEGER},'FlowExecutionsV2');
  for(const model of Object.values(db).filter(m=>m?.sync&&m!==sql))await model.sync();
  await db.Clinica.bulkCreate([{id_clinica:72,nombre_clinica:'QA Clinic',direccion:'QA Street 1',configuracion:{timezone:'Europe/Madrid'}},
    {id_clinica:66,nombre_clinica:'Other QA clinic',direccion:'Other street'}]);
  await db.Paciente.create({id_paciente:1,clinica_id:72,nombre:'Alex',telefono_movil:'34600000002',idioma_preferido:'es'});
  await db.CitaPaciente.create({id_cita:10,clinica_id:72,paciente_id:1,estado:'reprogramada',inicio:'2026-11-12T17:30Z',fin:'2026-11-12T17:50Z'});
  await db.FlowExecutionV2.create({id:99,status:'waiting',context:{ownership:'unchanged'}});
  const old=await db.Conversation.create({clinic_id:72,patient_id:1,contact_id:'+34600000001',channel:'whatsapp',unread_count:3,last_message_at:new Date('2026-10-01T12:00Z')});
  const oldMessage=await db.Message.create({conversation_id:old.id,direction:'outbound',message_type:'text',status:'read',content:'Fictitious old history'});
  const oldSnapshot=(await old.reload()).toJSON(),oldMessageSnapshot=(await oldMessage.reload()).toJSON();
  const catalog=await db.WhatsappTemplateCatalog.create({name:C.FAMILY,family_key:C.FAMILY,locale:'es',category:'UTILITY',body_text:C.COPY.es,is_active:true});
  const template=await db.WhatsappTemplate.create({name:C.FAMILY,waba_id:'101',catalog_template_id:catalog.id,language:'es',status:'APPROVED',category:'UTILITY',is_active:true,components:[{type:'BODY',text:C.COPY.es}]});
  const canonical=loadSource('../lib/canonical-conversation',{'../../models':db,'./phone':require('../../lib/phone'),'../services/whatsapp.service':{},
    '../services/temporaryPatientDirection.service':{observeConversation:async row=>row}},{});
  const flags={hold:false,deny:false,quiet:false},queued=[];
  const sender={originId:9,wabaId:'101',phoneNumberId:'201',authorizedBroker:{assetId:9,sendEnabled:true}};
  const service=require('../../services/appointmentManualNotice.service').createService({models:db,namespace:'TESTONLY',now:()=>new Date('2026-11-05T12:00Z'),
    loadSender:async()=>sender,authorize:async()=>{if(flags.deny)throw Object.assign(Error('forbidden'),{statusCode:403});},
    patientHeld:async()=>flags.hold,communicationAllowed:async()=>{},resolveConversation:canonical.findCanonicalWhatsappConversation,
    sendWindow:()=>flags.quiet?{delayMs:60000,scheduledAt:new Date('2026-11-06T06:00Z')}:{delayMs:0,scheduledAt:null},
    enqueue:async(payload,options)=>queued.push({payload,options}),emitCreated:()=>{}});
  const input={appointmentId:10,clinicId:72,userId:7},preview=await service.preview(input);
  assert.equal(preview.recipient,'+34600000002');assert(preview.text.includes('12-11-2026'));
  const send={...input,revision:preview.revision,requestId:'00000000-0000-4000-8000-000000000001'};
  const results=await Promise.all([service.send(send),service.send(send),service.send(send)]);
  assert.equal(new Set(results.map(x=>x.message_id)).size,1);assert.equal(await db.JobRequest.count(),1);assert.equal(await db.PatientOperationalEvent.count(),1);
  const message=await db.Message.findByPk(results[0].message_id),conversation=await db.Conversation.findByPk(message.conversation_id);
  assert.notEqual(conversation.id,old.id);assert.equal(conversation.contact_id,'+34600000002');assert.equal(await db.Conversation.count(),2);
  assert.deepEqual((await old.reload()).toJSON(),oldSnapshot);assert.deepEqual((await oldMessage.reload()).toJSON(),oldMessageSnapshot);
  assert.equal((await db.CitaPaciente.findByPk(10)).estado,'reprogramada');assert.equal((await db.FlowExecutionV2.findByPk(99)).status,'waiting');assert.equal(await db.FlowExecutionV2.count(),1);
  assert(!message.metadata.execution_id);assert.equal(message.metadata.suppress_flow_event,true);
  const binding={connectionRef:'wa:qa:72',authorizationId:'a1234567-1234-4234-8234-123456789abc',clinicId:72,assetId:9,phoneId:'201',wabaId:'101',revision:1,sendEnabled:true};
  const config={version:1,origin:'https://broker.example.invalid:8445',keyId:'staging-whatsapp',audience:'authorized-wa',messageNotBefore:'2026-09-15T00:00:00Z',
    privateKeyFile:'/etc/clinicaclick-whatsapp-authorized/staging/private.pem',caFile:'/etc/clinicaclick-whatsapp-authorized/staging/ca.pem',bindings:[binding]};
  let transportCalls=0,finalChecks=0;
  const broker=require('../../lib/whatsappAuthorizedBrokerClient').createWhatsappAuthorizedBrokerClient({
    environment:()=>({RUNTIME_ROLE:'api',JOB_RUNTIME_NAMESPACE:'staging',QUEUE_PREFIX:'staging',JOBS_WORKER_ENABLED:'true'}),loadConfiguration:()=>config,
    loadAsset:async()=>({id:9,assetType:'whatsapp_phone_number',assignmentScope:'clinic',clinicaId:72,grupoClinicaId:null,phoneNumberId:'201',wabaId:'101',isActive:true}),
    loadClinic:async()=>({id_clinica:72,grupoClinicaId:null}),isBlocked:async()=>false,patientHeld:async()=>false,
    authorizeManualNotice:async input=>{finalChecks++;assert.equal(input.message.sender_id,7);assert.equal(input.message.automation_delivery_key,message.automation_delivery_key);return service.assertReady(input)},
    createTransport:()=>({execute:async command=>{transportCalls++;return {requestId:command.requestId,replayed:false,data:{messages:[{id:'wamid.FICTITIOUS_ACCEPTED',message_status:'accepted'}]}}}})});
  const brokerPayload={messaging_product:'whatsapp',recipient_type:'individual',to:'34600000002',type:'template',template:{name:C.FAMILY,language:{code:'es'},components:[{type:'body',parameters:Object.values(message.metadata.template_params).map(text=>({type:'text',text}))}]}};
  await broker.send({messageId:String(message.id),clinicId:72,assetId:9,expectedBinding:binding,message:brokerPayload});
  assert.equal(finalChecks,2);assert.equal(transportCalls,1);
  report.checks.push('native broker loads the persisted actor and delivery key; both final preflights use the real manual service before one simulated transport');
  report.checks.push('three concurrent requests, one message/job/event; new-number chat, old history and appointment/flow state intact');
  await service.dispatch({message_id:message.id});await service.dispatch({message_id:message.id});
  assert.equal(queued.length,2);assert.equal(queued[0].options.jobId,queued[1].options.jobId);
  await message.update({status:'read',metadata:{...message.metadata,wamid:'FICTITIOUS_ACCEPTED'}});await service.dispatch({message_id:message.id});assert.equal(queued.length,2);
  const previous=await service.preview(input);assert(previous.last_request?.at_label);assert(previous.last_sent?.at_label);assert.equal(previous.last_sent.recipient,'+34600000002');
  await message.update({status:'pending',metadata:{...message.metadata,wamid:null}});
  await db.Paciente.update({telefono_movil:'34600000003'},{where:{id_paciente:1}});
  await assert.rejects(service.assertReady({message,conversation}),{code:'manual_appointment_changed'});
  await assert.rejects(service.send({...send,requestId:'00000000-0000-4000-8000-000000000002'}),{code:'manual_appointment_changed'});
  assert.equal(await db.JobRequest.count(),1);
  await db.Paciente.update({telefono_movil:'34600000002'},{where:{id_paciente:1}});
  flags.hold=true;await assert.rejects(service.preview(input),{code:'whatsapp_patient_import_held'});flags.hold=false;
  flags.deny=true;await assert.rejects(service.send(send),e=>e.statusCode===403);flags.deny=false;
  await assert.rejects(service.preview({...input,clinicId:66}),{code:'appointment_not_found'});
  await template.update({status:'PENDING'});await assert.rejects(service.preview(input),{code:'manual_appointment_template_pending'});await template.update({status:'APPROVED'});
  const payload={type:'template',template:{name:C.FAMILY,language:{code:'es'},components:[{type:'body',parameters:Object.values(message.metadata.template_params).map(text=>({type:'text',text}))}]}};
  await service.assertReady({message,conversation,payload});payload.template.components[0].parameters[0].text='tampered';
  await assert.rejects(service.assertReady({message,conversation,payload}),{code:'manual_appointment_payload_changed'});
  flags.quiet=true;const deferred=await service.dispatch({message_id:message.id});assert.equal(deferred.status,'waiting');assert.equal(queued.length,2);flags.quiet=false;
  await db.CitaPaciente.update({estado:'cancelada'},{where:{id_cita:10}});await service.dispatch({message_id:message.id});assert.equal((await message.reload()).status,'failed');
  report.checks.push('changed phone/appointment, revoked permission, clinic scope, HOLD, pending approval, payload tamper and quiet hours block transport; accepted identity is not resent');
  const eventsBefore=await db.PatientOperationalEvent.count();let emitted=0;
  const record=require('../../services/patientWhatsappContactChange.service').record;
  await sql.transaction(async transaction=>record({db,patientId:1,clinicId:72,previousPhone:'+34600000001',nextPhone:'34600000002',actorId:7,transaction,emit:()=>emitted++}));
  assert.equal(await db.PatientOperationalEvent.count(),eventsBefore+1);assert.equal(emitted,1);
  await assert.rejects(sql.transaction(async transaction=>{await record({db,patientId:1,clinicId:72,previousPhone:'+34600000002',nextPhone:'34600000003',actorId:7,transaction,emit:()=>emitted++});throw Error('rollback')}),/rollback/);
  assert.equal(await db.PatientOperationalEvent.count(),eventsBefore+1);assert.equal(emitted,1);
  await sql.transaction(async transaction=>record({db,patientId:1,clinicId:72,previousPhone:'600000002',nextPhone:'+34600000002',actorId:7,transaction,emit:()=>emitted++}));
  assert.equal(await db.PatientOperationalEvent.count(),eventsBefore+1);
  const human=loadSource('conversationPendingReply.service',{'../../models':db,'./socket.service':{getIO:()=>null},
    './notificationsRealtime.service':{},'./conversationAutomationState.service':{}},{});
  await message.update({status:'delivered'});
  assert.equal(await human.findHumanReplyAfterMessage(conversation.id,oldMessage.id),null);
  const genuine=await db.Message.create({conversation_id:conversation.id,sender_id:7,direction:'outbound',message_type:'text',status:'sent',content:'Fictitious human answer'});
  assert.equal((await human.findHumanReplyAfterMessage(conversation.id,oldMessage.id)).id,genuine.id);
  report.checks.push('phone change event is atomic/equivalent-safe; manual appointment resend is not treated as a human answer to a pending patient question');
}).catch(error=>{console.error(error.stack||error.message);process.exitCode=1});
