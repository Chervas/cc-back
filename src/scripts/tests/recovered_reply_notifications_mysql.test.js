'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {createService}=require('../../services/recoveredReplyNotifications.service');
test('real SQL reconciles only evidenced, owned recovered alerts and preserves new questions and recipient boundaries',async()=>{
 await withIsolatedCampaignMysql(async({sql,models,report})=>{
  const D=require('sequelize').DataTypes;
  const N=sql.define('RecoveredNotification',{id:{type:D.INTEGER,primaryKey:true},userId:{type:D.INTEGER,field:'user_id'},clinicaId:{type:D.INTEGER,field:'clinica_id'},event:D.STRING,
   dedupeKey:{type:D.STRING,field:'dedupe_key'},data:D.JSON,isRead:{type:D.BOOLEAN,field:'is_read'},readAt:{type:D.DATE,field:'read_at'}},{tableName:'Notifications',timestamps:false});
  const S=sql.define('RecoveredState',{conversation_id:{type:D.INTEGER,primaryKey:true},clinic_id:D.INTEGER,appointment_id:D.INTEGER,source_message_id:D.INTEGER,
   status:D.STRING,stage:D.STRING,failure_code:D.STRING,manual_action_required:D.BOOLEAN,needs_response:D.BOOLEAN,possible_urgency:D.BOOLEAN,completed_at:D.DATE},{tableName:'ConversationAutomationStates',timestamps:false});
  await N.sync();await S.sync();
  await sql.query('CREATE TABLE Conversations(id INT PRIMARY KEY,clinic_id INT,patient_id INT,channel VARCHAR(20))');
  await sql.query('CREATE TABLE CitasPacientes(id_cita INT PRIMARY KEY,clinica_id INT,paciente_id INT)');
  await sql.query('CREATE TABLE Messages(id INT PRIMARY KEY,conversation_id INT,direction VARCHAR(20),message_type VARCHAR(20),sent_at DATETIME,status VARCHAR(20),sender_id INT,metadata JSON)');
  await sql.query('CREATE TABLE PatientOperationalEvents(id INT PRIMARY KEY,clinic_id INT,patient_id INT,actor_user_id INT,source VARCHAR(20),event_type VARCHAR(50),occurred_at DATETIME,metadata JSON)');
  for(let i=1;i<=9;i++){
   await sql.query("INSERT INTO Conversations VALUES(:id,35,:id,'whatsapp')",{replacements:{id:i}});
   await sql.query('INSERT INTO CitasPacientes VALUES(:id,35,:id)',{replacements:{id:i}});
   await sql.query("INSERT INTO Messages VALUES(:id,:i,'inbound','text','2030-01-01 10:00:00','sent',NULL,JSON_OBJECT())",{replacements:{id:i*10,i}});
   await N.create({id:i,userId:i===8?99:4,clinicaId:35,event:'automation.persistent_alert',dedupeKey:'automation:recovered-reply:'+i,
    data:{source:'automations_v2',trigger_entity_type:'appointment',trigger_entity_id:i,quickChatConversationId:i,quickChatResponseMessageId:i*10},isRead:false});
   await S.create({conversation_id:i,clinic_id:35,appointment_id:i,source_message_id:i*10,status:'review',stage:'review',failure_code:'inbound_recovery_requires_review',manual_action_required:true,needs_response:i===5,possible_urgency:false});
  }
  // Sent reply resolves 1; queued/failed/uncertain automation does not resolve 2.
  await sql.query("INSERT INTO Messages VALUES(11,1,'outbound','text','2030-01-01 10:01:00','sent',7,JSON_OBJECT()),(21,2,'outbound','text','2030-01-01 10:01:00','pending',7,JSON_OBJECT()),(22,2,'outbound','text','2030-01-01 10:01:00','failed',7,JSON_OBJECT()),(23,2,'outbound','text','2030-01-01 10:01:00','sent',NULL,JSON_OBJECT()),(24,2,'outbound','text','2030-01-01 10:01:00','sent',7,JSON_OBJECT('delivery_unknown',true))");
  await sql.query("INSERT INTO Messages VALUES(25,2,'outbound','text','2030-01-01 10:01:00','sent',7,JSON_OBJECT('execution_id',999))");
  await S.update({status:'completed',manual_action_required:false},{where:{conversation_id:3}});
  for(const i of [4,5,6])await sql.query("INSERT INTO PatientOperationalEvents VALUES(:id,35,:id,7,'agenda','appointment.status_changed',:at,:data)",{
   replacements:{id:i,at:i===6?'2030-01-01 09:00:00':'2030-01-01 10:02:00',data:JSON.stringify({appointment_id:i,new_status:'recordatorio_confirmado'})}});
  // Another clinic is not evidence; a newer unresolved input keeps ownership.
  await sql.query("INSERT INTO Messages VALUES(71,9,'outbound','text','2030-01-01 10:01:00','sent',7,JSON_OBJECT()),(81,8,'outbound','text','2030-01-01 10:01:00','sent',7,JSON_OBJECT()),(91,9,'outbound','text','2030-01-01 10:01:00','sent',7,JSON_OBJECT()),(92,9,'inbound','text','2030-01-01 10:02:00','sent',NULL,JSON_OBJECT())");
  await S.update({source_message_id:92,needs_response:true},{where:{conversation_id:9}});
  const duplicate=(await N.findByPk(7)).toJSON();await N.create({...duplicate,id:17,dedupeKey:'automation:recovered-reply:duplicate'});
  models.Notification=N;models.ConversationAutomationState=S;models.sequelize=sql;
  const emitted=[];const service=createService({models,emitUpdated:n=>emitted.push(n.id)});
  const list=await N.findAll({where:{userId:4}});const result=await service.reconcileForUser(list,4);
  assert.equal(result.updated,5);assert.deepEqual(emitted.sort((a,b)=>a-b),[1,3,4,7,9]);
  assert.equal((await N.findByPk(17)).isRead,false);assert.equal((await S.findByPk(7)).status,'review');
  assert.equal((await N.findByPk(8)).isRead,false);assert.equal((await N.findByPk(5)).isRead,false);assert.equal((await N.findByPk(6)).isRead,false);
  assert.equal((await S.findByPk(1)).status,'completed');assert.equal((await S.findByPk(9)).source_message_id,92);assert.equal((await S.findByPk(9)).status,'review');
  assert.equal((await service.reconcileForUser(await N.findAll({where:{userId:4}}),4)).updated,0);
  assert.equal(await service.alreadyHandled({clinicId:99,conversationId:1,messageId:10,appointmentId:1}),null);
  assert.equal((await service.alreadyHandled({clinicId:35,conversationId:1,messageId:10,appointmentId:1})).reason,'human_reply_already_sent');
  report.checks.push('proof after inbound','no age based cleanup','queued/failed/automatic messages excluded','manual appointment audit',
   'questions preserved','clinic and recipient isolation','newer state not overwritten','idempotent list reconciliation','no outbound transport');
 });
});
