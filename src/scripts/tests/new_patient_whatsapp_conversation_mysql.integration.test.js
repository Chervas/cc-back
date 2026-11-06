'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {Sequelize,DataTypes:D}=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {loadSource}=require('./fixtures/business_profile_flow_runtime.fixture');
const {link}=require('../../services/newPatientWhatsappConversation.service');
const {createAppointmentWithPatientLanguage}=require('../../lib/patient-language');

test('new registration links only an unambiguous unowned chat before the real isolated sender lookup',async t=>{
 await withIsolatedCampaignMysql(async({sql,models:db,report})=>{
  db.Sequelize=Sequelize;db.sequelize=sql;
  const define=(name,fields,tableName)=>sql.define(name,fields,{tableName,timestamps:false});
  db.Clinica=define('Clinica',{id_clinica:{type:D.INTEGER,primaryKey:true}},'Clinicas');
  db.Paciente=define('Paciente',{id_paciente:{type:D.INTEGER,primaryKey:true},clinica_id:D.INTEGER,telefono_movil:D.STRING},'Pacientes');
  db.PacienteClinica=define('PacienteClinica',{paciente_id:D.INTEGER,clinica_id:D.INTEGER},'PacienteClinicas');
  db.Conversation=define('Conversation',{id:{type:D.INTEGER,primaryKey:true,autoIncrement:true},clinic_id:D.INTEGER,channel:D.STRING,
   contact_id:D.STRING,patient_id:D.INTEGER,lead_id:D.INTEGER,last_message_at:D.DATE,updatedAt:D.DATE,unread_count:D.INTEGER},'Conversations');
  db.Message=define('Message',{conversation_id:D.INTEGER,content:D.STRING},'Messages');
  db.CitaPaciente=define('CitaPaciente',{clinica_id:D.INTEGER,paciente_id:D.INTEGER,estado:D.STRING},'CitasPacientes');
  await sql.sync();await db.Clinica.bulkCreate([{id_clinica:35},{id_clinica:72}]);
  const canonical=loadSource('../lib/canonical-conversation',{'../../models':db,'./phone':require('../../lib/phone'),
   '../services/whatsapp.service':{},'../services/temporaryPatientDirection.service':{observeConversation:async row=>row}},{});
  const lookup=overrides=>canonical.findCanonicalWhatsappConversation({clinicId:35,patientId:1,contactId:'+34600000001',
   requireExactContact:true,isolatePatientContact:true,createIfMissing:true,...overrides});
  const reset=async()=>{for(const model of [db.CitaPaciente,db.Message,db.Conversation,db.PacienteClinica,db.Paciente])await model.destroy({where:{}})};
  const patient=async(values={})=>db.Paciente.create({id_paciente:1,clinica_id:35,telefono_movil:'34600000001',...values});
  const chat=values=>db.Conversation.create({clinic_id:35,channel:'whatsapp',contact_id:'+34 600 000 001',patient_id:null,lead_id:null,
   unread_count:4,last_message_at:new Date('2026-01-01T12:00Z'),...values});
  await t.test('booking commits the initial binding before sender selection and preserves the chat history',async()=>{
   const p=await patient(),c=await chat(),m=await db.Message.create({conversation_id:c.id,content:'Fictitious inbound'});
   await assert.rejects(lookup(),e=>e.code==='whatsapp_contact_identity_conflict');
   const before=(await c.reload()).toJSON();
   await createAppointmentWithPatientLanguage({sequelize:sql,AppointmentModel:db.CitaPaciente,patient:p,
    appointmentValues:{clinica_id:35,paciente_id:1,estado:'pendiente'},
    afterPersist:async(appointment,transaction)=>{assert.equal(await link({db,patient:p,clinicId:35,transaction}),c.id)}});
   assert.equal((await lookup()).id,c.id);await c.reload();
   assert.deepEqual({...c.toJSON(),patient_id:null},before);
   assert.deepEqual((await m.reload()).content,'Fictitious inbound');assert.equal(await db.Conversation.count(),1);
   assert.equal((await db.CitaPaciente.findOne()).estado,'pendiente');
  });
  await t.test('registration without an existing chat does not create one; isolated sender creates it once',async()=>{
   await reset();const p=await patient();await sql.transaction(transaction=>link({db,patient:p,clinicId:35,transaction}));
   assert.equal(await db.Conversation.count(),0);const c=await lookup();assert.equal((await lookup()).id,c.id);
   assert.equal(await db.Conversation.count(),1);
  });
  for(const kind of ['foreign','lead','duplicate','shared_patient','other_clinic','foreign_suffix'])await t.test(kind+' cannot be silently attached',async()=>{
   await reset();const p=await patient(),c=await chat(kind==='foreign'?{patient_id:99}:kind==='lead'?{lead_id:20}:
    kind==='other_clinic'?{clinic_id:72}:kind==='foreign_suffix'?{contact_id:'+1600000001'}:{});
   if(kind==='duplicate')await chat({contact_id:'0034600000001'});
   if(kind==='shared_patient')await patient({id_paciente:2});
   const snapshot=(await db.Conversation.findAll({raw:true}));
   assert.equal(await sql.transaction(transaction=>link({db,patient:p,clinicId:35,transaction})),null);
   assert.deepEqual(await db.Conversation.findAll({raw:true}),snapshot);
   if(['foreign','lead','duplicate'].includes(kind))await assert.rejects(lookup(),e=>e.code==='whatsapp_contact_identity_conflict');
  });
  await t.test('rollback undoes both the booking and initial chat ownership',async()=>{
   await reset();const p=await patient(),c=await chat();
   await assert.rejects(createAppointmentWithPatientLanguage({sequelize:sql,AppointmentModel:db.CitaPaciente,patient:p,
    appointmentValues:{clinica_id:35,paciente_id:1,estado:'pendiente'},afterPersist:async(a,transaction)=>{
     await link({db,patient:p,clinicId:35,transaction});throw Error('FICTITIOUS_ROLLBACK');}}),/FICTITIOUS_ROLLBACK/);
   assert.equal((await c.reload()).patient_id,null);assert.equal(await db.CitaPaciente.count(),0);
  });
  await t.test('concurrent registration callbacks are idempotent and retain one conversation',async()=>{
   await reset();const p=await patient(),c=await chat();
   await Promise.all([1,2,3].map(()=>sql.transaction(transaction=>link({db,patient:p,clinicId:35,transaction}))));
   assert.equal((await c.reload()).patient_id,1);assert.equal(await db.Conversation.count(),1);
  });
  await t.test('diagnostic lookup never claims an unowned/lead chat, merges duplicates or creates missing chats',async()=>{
   const diagnostic=()=>canonical.findCanonicalWhatsappConversation({clinicId:35,patientId:1,contactId:'+34600000001',
    requireExactContact:true,readOnly:true,createIfMissing:true,lastMessageAt:new Date()});
   for(const kind of ['unowned','lead','foreign','duplicate','missing','owned']){
    await reset();await patient();if(kind!=='missing')await chat(kind==='owned'||kind==='duplicate'?{patient_id:1}:
     kind==='foreign'?{patient_id:99}:kind==='lead'?{lead_id:20}:{});
    if(kind==='duplicate')await chat({patient_id:1});
    const snapshot=await db.Conversation.findAll({raw:true}),result=await diagnostic();
    assert.equal(Boolean(result),kind==='owned');assert.deepEqual(await db.Conversation.findAll({raw:true}),snapshot);
   }
  });
  report.checks.push('initial registration/booking binding; no sender relaxation; transaction rollback; concurrency; ownership/clinic/lead/duplicate denial; diagnostic lookup without identity writes');
 });
});
