'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),S=require('sequelize');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const E=require('../../services/whatsappConfigurationTestEvidence.service');
test('configuration evidence uses current authority, exact native manual message and approved WABA template on real isolated SQL',{
  skip:process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST!=='1',timeout:180000,
},async()=>withIsolatedCampaignMysql(async({sql,models,report})=>{
  models.Conversation=sql.define('Conversation',{clinic_id:S.INTEGER,channel:S.STRING},{tableName:'Conversations'});
  models.Message=require('../../../models/message')(sql,S.DataTypes);models.Message.associate(models);
  models.WhatsappTemplate=require('../../../models/whatsapptemplate')(sql,S.DataTypes);
  models.WhatsappPhoneActivation=require('../../../models/whatsappphoneactivation')(sql,S.DataTypes);
  for(const model of [models.Conversation,models.Message,models.WhatsappTemplate,models.WhatsappPhoneActivation])await model.sync();
  const now=new Date('2030-01-02T10:00:00Z');
  const asset={id:411,isActive:true,assignmentScope:'clinic',clinicaId:56,phoneNumberId:'123456',wabaId:'TESTONLY-WABA',
    whatsappAuthorizationId:'11111111-1111-4111-8111-111111111111',additionalData:{}};
  const binding={assetId:411,clinicId:56,authorizationId:asset.whatsappAuthorizationId,phoneId:asset.phoneNumberId,wabaId:asset.wabaId,sendEnabled:true};
  const activation={authorization_id:asset.whatsappAuthorizationId,asset_id:411,scope_type:'clinic',scope_id:56,clinic_ids:[56],
    connection_ref:'TESTONLY-current',phone_id:asset.phoneNumberId,waba_id:asset.wabaId,state:'active',profile:{},
    created_at:new Date('2030-01-02T08:00:00Z'),updated_at:new Date('2030-01-02T08:00:00Z'),
    message_not_before:new Date('2030-01-01T00:00:00Z'),updated_by:1};
  await models.WhatsappPhoneActivation.create(activation);
  const template=await models.WhatsappTemplate.create({waba_id:asset.wabaId,name:'TESTONLY-configuration',language:'es',
    status:'APPROVED',category:'MARKETING',origin:'custom',is_active:true});
  const conversation=await models.Conversation.create({clinic_id:56,channel:'whatsapp'});
  const other=await models.Conversation.create({clinic_id:57,channel:'whatsapp'});
  const base={conversation_id:conversation.id,direction:'outbound',message_type:'template',status:'delivered',content:'TESTONLY',
    createdAt:new Date('2030-01-02T09:00:00Z'),updatedAt:new Date('2030-01-02T09:00:02Z'),metadata:{
      kind:'mass_campaign_test',source:'marketing_bulk_sends',sender_origin_id:asset.id,phoneNumberId:asset.phoneNumberId,
      wabaId:asset.wabaId,wamid:'wamid.TESTONLY',template_id:template.id,template_name:template.name,template_language:'es',payment_recovery_probe:false}};
  const delivered=await models.Message.create(base,{silent:true});
  await models.Message.create({...base,conversation_id:other.id},{silent:true});
  await models.Message.create({...base,metadata:{...base.metadata,wabaId:'OTHER-WABA'}},{silent:true});
  await models.Message.create({...base,status:'sent'},{silent:true});
  const pending=await models.WhatsappTemplate.create({waba_id:asset.wabaId,name:'TESTONLY-pending',language:'es',
    status:'PENDING',category:'MARKETING',origin:'custom',is_active:true});
  await models.Message.create({...base,metadata:{...base.metadata,template_id:pending.id,template_name:pending.name}},{silent:true});
  const service=E.createService({db:models,now:()=>now});
  const result=await service.read(asset,binding);
  assert.equal(result.verified,true);assert.equal(result.app_message_id,delivered.id);assert.equal(result.message_status,'delivered');
  assert.equal(asset.additionalData.payment,undefined);assert(!JSON.stringify(result).includes('TESTONLY-configuration'));
  const counts={messages:await models.Message.count(),activations:await models.WhatsappPhoneActivation.count()};
  await service.read(asset,binding);
  assert.deepEqual({messages:await models.Message.count(),activations:await models.WhatsappPhoneActivation.count()},counts);
  asset.additionalData.payment={status:'missing_payment_method',last_error_code:131042};assert.equal((await service.read(asset,binding)).verified,false);
  delete asset.additionalData.payment;
  await models.WhatsappPhoneActivation.update({state:'superseded'},{where:{authorization_id:activation.authorization_id}});
  asset.whatsappAuthorizationId='22222222-2222-4222-8222-222222222222';binding.authorizationId=asset.whatsappAuthorizationId;
  await models.WhatsappPhoneActivation.create({...activation,authorization_id:asset.whatsappAuthorizationId,
    created_at:new Date('2030-01-02T09:30:00Z'),updated_at:new Date('2030-01-02T09:30:00Z')});
  assert.equal((await service.read(asset,binding)).verified,false);
  const fresh=await models.Message.create({...base,status:'read',createdAt:new Date('2030-01-02T09:40:00Z'),
    updatedAt:new Date('2030-01-02T09:40:02Z')},{silent:true});
  assert.equal((await service.read(asset,binding)).app_message_id,fresh.id);
  report.checks.push('Real ORM JSON filters and required Conversation join; correct template WABA/name/language/status; native manual test without rewrite; sent-only, foreign clinic/WABA and pending template rejected; renewal frontier despite retained cutoff; later 131042 wins; reads preserve row counts and payment state. No provider or host database sockets.');
}));
