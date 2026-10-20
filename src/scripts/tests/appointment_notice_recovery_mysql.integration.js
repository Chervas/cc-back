'use strict';
const assert=require('node:assert/strict'),D=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {loadSource}=require('./fixtures/business_profile_flow_runtime.fixture');
const C=require('../../lib/appointment-notice-recovery');
const {buildSingleNoticeFlow}=require('../../lib/appointment-single-notice-flow');

withIsolatedCampaignMysql(async({sql,models:db,report})=>{
  db.Sequelize=D;
  for(const file of ['automationflowtemplatev2','flowexecutionv2','citapaciente']){
    const model=require('../../../models/'+file)(sql,D);db[model.name]=model;
  }
  db.Clinica=sql.define('Clinica',{id_clinica:{type:D.INTEGER,primaryKey:true},grupoClinicaId:D.INTEGER,configuracion:D.JSON},{tableName:'Clinicas'});
  db.Paciente=sql.define('Paciente',{id_paciente:{type:D.INTEGER,primaryKey:true},idioma_preferido:D.STRING},{tableName:'Pacientes'});
  db.AutomationFlowCatalog={findAll:async()=>[]};
  await sql.sync();
  await db.Clinica.create({id_clinica:72,grupoClinicaId:29,configuracion:{timezone:'Europe/Madrid'}});
  await db.Paciente.create({id_paciente:900002,idioma_preferido:'es'});
  const first={id:'N2',type:'action/send_whatsapp',config:{template_name:'TESTONLY_initial'},outputs:{on_success:'N3'}};
  const nodes=[{id:'N1',type:'trigger/appointment_created',outputs:{on_success:'N2'}},first,
    {id:'N3',type:'delay/wait_response',config:{listens_to_node_id:'N2',timeout_duration:2,timeout_unit:'hours'},outputs:{on_timeout:'N4'}},
    {id:'N4',type:'action/send_whatsapp',config:{template_name:'clinicaclick_confirmacion_datos_cita_48_sin_respuesta_v1'},outputs:{on_success:'N5'}},
    {id:'N5',type:'delay/wait_response',config:{listens_to_node_id:'N4',timeout_duration:12,timeout_unit:'hours'},outputs:{}}];
  const values={public_id:'TESTONLY_recovery',template_key:'env_o_de_datos_de_la_cita_tras_agendar__clinic_72',version:1,
    trigger_type:'appointment_created',entry_node_id:'N1',nodes,trigger_config:{},clinic_id:72,group_id:29,is_active:true,
    published_at:new Date(),created_by:44,name:'TESTONLY recovery'};
  const template=await db.AutomationFlowTemplateV2.create({...values,...buildSingleNoticeFlow(values)});
  const base={clinica_id:72,paciente_id:900002,doctor_id:900003,tipo_cita:'primera_sin_trat',estado:'pendiente',
    inicio:new Date('2026-10-27T16:00:00Z'),fin:new Date('2026-10-27T16:30:00Z'),
    created_at:new Date('2026-10-20T07:28:23Z'),updated_at:new Date('2026-10-20T07:28:23Z'),import_metadata:{}};
  await db.CitaPaciente.bulkCreate([1,2,3].map(id=>({...base,id_cita:900000+id})));
  const jobs=new Map();let immediate=0;
  const runtime=loadSource('appointmentAutomationV2Runtime.service',{
    '../../models':db,'./socket.service':{getIO:()=>null},
    './jobRequests.service':{enqueueUniqueJobRequest:async options=>{
      if(!jobs.has(options.dedupeScope))jobs.set(options.dedupeScope,{id:jobs.size+1,...options});
      return {job:jobs.get(options.dedupeScope)};
    }},'./jobScheduler.service':{triggerImmediate:async()=>{immediate++;}},
    './appointmentVisitManaged.service':{current:()=>({managedVisit:async()=>null})},
    './appointmentPatientLinks.service':{follower:async()=>false},
  },{JOB_RUNTIME_NAMESPACE:'dev',RUNTIME_ROLE:'api'});
  const load=async(id,transaction)=>{
    const a=(await db.CitaPaciente.findByPk(id,{transaction})).toJSON();
    for(const key of ['inicio','fin','created_at','updated_at','hold_expires_at','arrived_at','care_started_at','care_schedule_start','care_completed_at'])if(a[key])a[key]=new Date(a[key]).toISOString();
    const executions=await db.FlowExecutionV2.findAll({where:{trigger_entity_id:id,trigger_entity_type:'appointment'},raw:true,transaction});
    return {appointment:a,patient:{has_phone:1,phone_fingerprint:'TESTONLY_frozen'},events:[],messages:[],executions,treatment:null};
  };
  const approve=async id=>{const s=await load(id);const assessment=C.assess(s,{now:Date.parse('2026-10-20T10:00:00Z')});assert(assessment.eligible);
    return {appointmentId:id,eventName:assessment.source.type,source:assessment.source,approved:true,evidenceHash:assessment.evidenceHash};};
  const item=await approve(900001),args={db,runtime,item,load,actorId:44,now:()=>Date.parse('2026-10-20T10:00:00Z')};
  const results=await Promise.allSettled([C.recoverOne(args),C.recoverOne(args)]);
  assert(results.some(r=>r.status==='fulfilled'&&r.value.execution));
  assert.equal(await db.FlowExecutionV2.count(),1);assert.equal(jobs.size,1);
  const execution=await db.FlowExecutionV2.findOne();assert.equal(execution.template_version_id,template.id);
  assert.equal(execution.context.appointment.inicio,'2026-10-27T16:00:00.000Z');
  assert.equal(execution.context.trigger.data.explicit_notice_recovery.approved_evidence,item.evidenceHash);
  assert.equal((await db.CitaPaciente.findByPk(900001)).estado,'pendiente');
  await assert.rejects(C.recoverOne(args),/notice_recovery_evidence_changed/);
  const changed=await approve(900002);let reads=0;
  const changingLoad=async(id,transaction)=>{
    if(++reads===2)await db.CitaPaciente.update({inicio:new Date('2026-10-28T16:00:00Z')},{where:{id_cita:id},transaction});
    return load(id,transaction);
  };
  await assert.rejects(C.recoverOne({...args,item:changed,load:changingLoad}),/notice_recovery_evidence_changed/);
  assert.equal(await db.FlowExecutionV2.count(),1);assert.equal(jobs.size,1);
  assert.equal((await db.CitaPaciente.findByPk(900002)).inicio.toISOString(),'2026-10-27T16:00:00.000Z','Claim failure rolls back the isolated concurrent mutation');
  const stopped=await approve(900003);await template.update({is_active:false});
  await assert.rejects(C.recoverOne({...args,item:stopped}),/notice_recovery_template_ineligible/);
  assert.equal(await db.FlowExecutionV2.count(),1);
  report.checks.push('Real native resolver, native enqueue, actual createExecution transaction and InnoDB: two concurrent recovery calls yield one execution/job; reviewed range and audit retained, status unchanged, repeat blocks');
  report.checks.push('Evidence changed inside native claim transaction aborts insertion and rolls back; a current manual OFF prevents recovery; no provider, consent or review calls and no real data');
  report.nativeJobs=jobs.size;report.immediateRequests=immediate;report.providerCalls=0;
}).catch(error=>{console.error(error);process.exitCode=1;});
