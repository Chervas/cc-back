'use strict';
const test=require('node:test'), assert=require('node:assert/strict');
const {Sequelize,DataTypes}=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
test('failed sends and internal events do not count as contacting a lead; pending and real sends do',async()=>{
 await withIsolatedCampaignMysql(async({sql,models,report})=>{
  models.Sequelize=Sequelize;
  models.Conversation=sql.define('Conversation',{id:{type:DataTypes.INTEGER,primaryKey:true},clinic_id:DataTypes.INTEGER,lead_id:DataTypes.INTEGER,contact_id:DataTypes.STRING},{timestamps:false});
  models.Message=sql.define('Message',{id:{type:DataTypes.INTEGER,primaryKey:true},conversation_id:DataTypes.INTEGER,direction:DataTypes.STRING,message_type:DataTypes.STRING,status:DataTypes.STRING});
  await models.Conversation.sync();await models.Message.sync();
  models.LeadIntake={findByPk:async()=>({id:10,clinica_id:35,status_lead:'nuevo',created_at:new Date()})};
  models.LeadContactAttempt={findAll:async()=>[]};
  const {evaluatePendingLeadContact}=require('../../services/leadContactState.service');
  await models.Conversation.create({id:1,clinic_id:35,lead_id:10});
  await models.Conversation.create({id:2,clinic_id:58,lead_id:10});
  await models.Message.bulkCreate([
   {id:1,conversation_id:1,direction:'outbound',message_type:'event',status:'sent'},
   {id:2,conversation_id:1,direction:'outbound',message_type:'template',status:'failed'},
   {id:3,conversation_id:2,direction:'outbound',message_type:'template',status:'sent'},
  ]);
  assert.equal((await evaluatePendingLeadContact({leadId:10,models})).decision,true);
  for(const status of ['pending','sending','sent','delivered','read']){
   await models.Message.update({status},{where:{id:2}});
   assert.equal((await evaluatePendingLeadContact({leadId:10,models})).reason,'outbound_message_registered');
  }
  report.checks.push('internal events excluded','failed send eligible','other clinic isolated','pending sends suppress duplicates','sent delivered and read suppress contact');
 });
});
