'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {DataTypes}=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {enrichHumanInteraction}=require('../../services/leadHumanInteraction.service');

test('actual MySQL8 ranks scoped human work and keeps legacy, automation, privacy and failure semantics',
 {skip:process.env.LEAD_HUMAN_INTERACTION_MYSQL_TEST!=='1',timeout:180000},async t=>{
 await withIsolatedCampaignMysql(async({sql,models,report})=>{
  const define=(name,fields,tableName)=>sql.define(name,fields,{tableName,timestamps:false});
  models.Usuario=define('Usuario',{id_usuario:{type:DataTypes.INTEGER,primaryKey:true},nombre:DataTypes.STRING,apellidos:DataTypes.STRING},'Usuarios');
  models.Clinica=define('Clinica',{id_clinica:{type:DataTypes.INTEGER,primaryKey:true},configuracion:DataTypes.JSON},'Clinicas');
  models.PatientDirectionSetting=define('PatientDirectionSetting',{id:{type:DataTypes.INTEGER,primaryKey:true},clinic_id:DataTypes.INTEGER,is_enabled:DataTypes.BOOLEAN,director_user_id:DataTypes.INTEGER},'PatientDirectionSettings');
  await sql.sync();
  await sql.query('CREATE TABLE LeadIntakes(id INT PRIMARY KEY,clinica_id INT NOT NULL,created_at DATETIME NOT NULL)');
  await sql.query('CREATE TABLE LeadContactAttempts(id INT PRIMARY KEY,lead_intake_id INT NOT NULL,usuario_id INT,created_at DATETIME NOT NULL,canal VARCHAR(40),motivo VARCHAR(128))');
  await sql.query('CREATE TABLE Conversations(id INT PRIMARY KEY,lead_id INT,clinic_id INT,channel VARCHAR(40))');
  await sql.query('CREATE TABLE Messages(id INT PRIMARY KEY,conversation_id INT,sender_id INT,direction VARCHAR(20),message_type VARCHAR(30),status VARCHAR(30),sent_at DATETIME,createdAt DATETIME,metadata JSON,automation_delivery_key VARCHAR(191))');
  await sql.query('CREATE TABLE CitasPacientes(id_cita INT PRIMARY KEY,clinica_id INT,lead_intake_id INT,created_by INT,created_at DATETIME,source_system VARCHAR(80),import_metadata JSON,updated_by INT,updated_at DATETIME)');
  await sql.query('CREATE TABLE LeadAttributionAudits(id INT PRIMARY KEY,lead_intake_id INT,raw_payload JSON,attribution_steps JSON,created_at DATETIME)');
  await models.Usuario.bulkCreate([{id_usuario:44,nombre:'Directora',apellidos:'Ficticia'},{id_usuario:12,nombre:'Equipo',apellidos:'Prueba'},{id_usuario:13,nombre:'Legacy'}]);
  await models.Clinica.bulkCreate([{id_clinica:66,configuracion:{timezone:'Europe/Madrid'}},{id_clinica:72,configuracion:{timezone:'Europe/Madrid'}}]);
  const leads=Array.from({length:23},(_,i)=>({id:i+7,clinica_id:66,created_at:'2026-11-17T00:00:00Z'}));
  for(const lead of leads)await sql.query('INSERT INTO LeadIntakes VALUES(:id,:clinic,:created)',{replacements:{id:lead.id,clinic:lead.clinica_id,created:'2026-11-17 00:00:00'}});
  await sql.query(`INSERT INTO LeadContactAttempts VALUES
   (1,7,44,'2026-11-18 10:00:00','llamada','no_contesta'),(2,7,44,'2026-11-18 11:59:00','whatsapp','lead_auto_reply:42'),
   (3,8,44,'2026-11-18 10:00:00','llamada','no_contesta'),(4,8,12,'2026-11-16 10:00:00','llamada','otro'),
   (5,10,NULL,'2026-11-18 11:00:00','whatsapp','otro'),(6,11,12,'2026-11-19 10:00:00','llamada','otro')`);
  await sql.query(`INSERT INTO Conversations VALUES (1,7,66,'whatsapp'),(2,10,72,'whatsapp'),(3,11,66,'whatsapp'),(4,12,66,'whatsapp'),(5,13,66,'whatsapp'),(6,14,66,'whatsapp')`);
  let messageId=0;
  const message=async({conversation=1,sender=12,status='sent',direction='outbound',type='text',at='2026-11-18 11:00:00',metadata={},key=null}={})=>sql.query(
   'INSERT INTO Messages VALUES(:id,:conversation,:sender,:direction,:type,:status,:at,:at,:metadata,:key)',{replacements:{id:++messageId,conversation,sender,direction,type,status,at,metadata:JSON.stringify(metadata),key}});
  await message();
  for(const metadata of [{source:'automation_v2'},{source_event:'auto_reply'},{coexistence:{kind:'automation_event'}},{flow_execution_id:99},{bulk_send_job_id:42},{ai_generated:true},{lead_intake_id:999},{hide_from_quickchat:true}]) await message({at:'2026-11-18 11:59:00',metadata});
  await message({at:'2026-11-18 11:59:00',key:'automation:42'});
  await message({at:'2026-11-18 11:59:00',status:'failed'});await message({at:'2026-11-18 11:59:00',type:'event'});
  await message({at:'2026-11-18 11:59:00',direction:'inbound'});await message({conversation:2});
  await message({conversation:3,sender:null});await message({conversation:4,metadata:{source:'ai'}});await message({conversation:5,sender:44});
  await message({conversation:6,at:'2026-11-16 11:00:00'});
  leads[2].historial_contactos=[{usuario_id:13,fecha:'2026-11-18T11:10:00Z',canal:'email',motivo:'otro'}];leads[6].privacy_redacted=true;
  const appointment=async({id,lead,actor=44,clinic=66,at='2026-11-18 09:28:33',source=null,metadata=null,updatedBy=12,updatedAt='2026-11-18 11:57:00'})=>sql.query(
   'INSERT INTO CitasPacientes VALUES(:id,:clinic,:lead,:actor,:at,:source,:metadata,:updatedBy,:updatedAt)',
   {replacements:{id,clinic,lead,actor,at,source,metadata:metadata===null?null:JSON.stringify(metadata),updatedBy,updatedAt}});
  await appointment({id:1,lead:15});
  await appointment({id:2,lead:18,source:'automation_v2'});
  await appointment({id:3,lead:19,metadata:{source:'cliniccloud'}});
  await appointment({id:4,lead:20,actor:null});
  await appointment({id:5,lead:21,clinic:72});
  await appointment({id:6,lead:22,at:'2026-11-19 10:00:00'});
  await appointment({id:7,lead:23,at:'2026-11-16 10:00:00'});
  await appointment({id:8,lead:24,metadata:{is_automated:true}});
  const audit=async(id,lead,payload,steps,at='2026-11-18 09:41:15')=>sql.query(
   'INSERT INTO LeadAttributionAudits VALUES(:id,:lead,:payload,:steps,:at)',
   {replacements:{id,lead,payload:JSON.stringify(payload),steps:JSON.stringify(steps),at}});
  await audit(10143,16,{status_lead:'descartado'},{action:'status_update',userId:44,previous_status:'nuevo'});
  await audit(10144,17,{}, {type:'lead_patient_attention_v1',lead_patient_attention_v1:{version:1,decision:'director',request_kind:'commercial',actor_user_id:44,clinic_id:66}});
  await audit(10145,24,{status_lead:'descartado'},{action:'automation_update',userId:44,previous_status:'nuevo'});
  await audit(10146,24,{asignado_a:44},{action:'status_update',userId:44,previous_status:'nuevo'});
  await audit(10147,24,{status_lead:'nuevo'},{action:'status_update',userId:44,previous_status:'nuevo'});
  await audit(10148,24,{}, {type:'lead_patient_attention_v1',lead_patient_attention_v1:{version:1,decision:'director',request_kind:'commercial',actor_user_id:44,clinic_id:72}});
  await audit(10149,24,{status_lead:'descartado'},{action:'status_update',userId:null,previous_status:'nuevo'});
  await audit(10150,24,{status_lead:'descartado'},{action:'status_update',userId:44,previous_status:'nuevo',source:'automations_v2'});
  await audit(10151,24,{status_lead:'descartado'},{action:'status_update',userId:44,previous_status:'nuevo',is_automated:true});
  await audit(10152,24,{status_lead:'descartado'},{action:'status_update',userId:44,previous_status:'nuevo',flow_execution_id:77});
  await appointment({id:9,lead:26,actor:44,at:'2026-11-18 08:00:00'});
  await appointment({id:10,lead:26,actor:12,at:'2026-11-18 11:00:00'});
  await audit(10153,27,{}, {type:'lead_patient_attention_v1',lead_patient_attention_v1:{version:1,decision:'director',request_kind:'commercial',actor_user_id:44,clinic_id:66}},'2026-11-18 08:00:00');
  await audit(10154,27,{status_lead:'contactado'},{action:'status_update',userId:12,previous_status:'nuevo'},'2026-11-18 11:00:00');
  await sql.query("INSERT INTO Conversations VALUES(7,17,66,'whatsapp'),(8,15,66,'whatsapp'),(9,25,66,'whatsapp')");
  await message({conversation:7,at:'2026-11-18 11:00:00'});
  await message({conversation:9,sender:44,at:'2026-11-18 08:00:00'});
  await message({conversation:9,sender:12,at:'2026-11-18 11:00:00'});
  await message({conversation:8,sender:44,at:'2026-11-18 11:57:00',metadata:{source:'automations_v2'},key:'auto:appointment-confirmation'});
  await sql.query("INSERT INTO Conversations VALUES(10,28,66,'whatsapp')");
  await message({conversation:10,sender:44,at:'2026-11-18 08:00:00'});
  await message({conversation:10,sender:12,at:'2026-11-18 11:00:00',metadata:{ad_sharing:{purpose:'lead_ad',lead_id:29}}});
  await sql.query("INSERT INTO LeadContactAttempts VALUES(100,29,12,'2026-11-18 11:00:00','whatsapp','whatsapp_template_sent')");
  const result=await enrichHumanInteraction({models,leads,now:new Date('2026-11-18T12:00:00Z')});
  await t.test('first Graci remains distinct from the later Lidia message despite newer automatic or failed messages',()=>{assert.equal(result[0].first_human_interaction.user_id,44);assert.equal(result[0].first_human_interaction.outcome,'no_answer');assert.equal(result[0].last_human_interaction.user_id,12);assert.equal(result[0].last_human_interaction.outcome,'sent');assert.equal(result[0].last_human_interaction.occurred_at,'2026-11-18T11:00:00.000Z');});
  await t.test('missed-call actor gets honest attempt status and director marker',()=>{assert.equal(result[1].last_human_interaction.outcome,'no_answer');assert.equal(result[1].last_human_interaction.is_patient_director,true);});
  await t.test('legacy-only actual human contact remains visible',()=>assert.equal(result[2].last_human_interaction.user_name,'Legacy'));
  await t.test('other clinic, absent actor, AI, redaction and previous-request history do not claim attention',()=>{for(const row of result.slice(3,8)){assert.equal(row.last_human_interaction,null);assert.equal(row.first_human_interaction,null);}});
  await t.test('native booking is human at creation; automatic confirmation with inherited or changed updated_by adds no new action',()=>{
   const row=result.find(r=>r.id===15);assert.equal(row.first_human_interaction.user_id,44);assert.equal(row.first_human_interaction.kind,'appointment');assert.equal(row.first_human_interaction.outcome,'scheduled');assert.equal(row.last_human_interaction.occurred_at,'2026-11-18T09:28:33.000Z');
  });
  await t.test('the authenticated discard audit counts even without messages, appointments or attempts',()=>{
   const row=result.find(r=>r.id===16);assert.equal(row.first_human_interaction.user_id,44);assert.equal(row.first_human_interaction.kind,'lead_action');assert.equal(row.first_human_interaction.outcome,'discarded');assert.deepEqual(row.first_human_interaction,row.last_human_interaction);
  });
  await t.test('an explicit take starts management before another person sends the last message',()=>{
   const row=result.find(r=>r.id===17);assert.equal(row.first_human_interaction.user_id,44);assert.equal(row.first_human_interaction.outcome,'claimed');assert.equal(row.last_human_interaction.user_id,12);assert.equal(row.last_human_interaction.kind,'message');
  });
  await t.test('automatic, imported, wrong-clinic, missing-creator and out-of-request bookings plus automatic or assignment-only audits do not claim human work',()=>{
   for(const row of result.filter(r=>r.id>=18&&r.id<=24)){assert.equal(row.first_human_interaction,null);assert.equal(row.last_human_interaction,null);assert.equal(row.human_interaction_status,'available');}
  });
  await t.test('both ends of messages, bookings and action audits are fetched even when no other source exists',()=>{
   for(const id of[25,26,27]){const row=result.find(r=>r.id===id);assert.equal(row.first_human_interaction.user_id,44);assert.equal(row.last_human_interaction.user_id,12);assert.equal(row.first_human_interaction.occurred_at,'2026-11-18T08:00:00.000Z');assert.equal(row.last_human_interaction.occurred_at,'2026-11-18T11:00:00.000Z');}
  });
  await t.test('a shared canonical chat keeps A intact while B gets only its own recorded human attempt',()=>{
   const a=result.find(r=>r.id===28),b=result.find(r=>r.id===29);
   assert.equal(a.first_human_interaction.user_id,44);assert.equal(a.last_human_interaction.user_id,44);
   assert.equal(a.last_human_interaction.occurred_at,'2026-11-18T08:00:00.000Z');
   assert.equal(b.first_human_interaction.user_id,12);assert.equal(b.last_human_interaction.user_id,12);
   assert.equal(b.first_human_interaction.kind,'contact_attempt');assert.equal(b.last_human_interaction.kind,'contact_attempt');
  });
  await models.PatientDirectionSetting.create({id:1,clinic_id:66,is_enabled:true,director_user_id:12});
  const changed=await enrichHumanInteraction({models,leads,now:new Date('2026-11-18T12:00:00Z')});
  await t.test('configured clinic director uses the actual actor, not the temporary default',()=>{assert.equal(changed[0].last_human_interaction.is_patient_director,true);assert.equal(changed[1].last_human_interaction.is_patient_director,false);});
  report.checks.push('lead-human-interaction: actual SQL first+last ranking/JSON/clinic isolation/legacy/director/privacy/authenticated discard+take/native booking/automatic confirmations excluded');
 });
});
