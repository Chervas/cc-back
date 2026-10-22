'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),S=require('sequelize'),fs=require('node:fs'),vm=require('node:vm');
const {withIsolatedCampaignMysql}=require('./fixtures/isolated_campaign_mysql.fixture');
const {createService}=require('../../services/whatsappPaymentRecoveryTest.service');
test('payment dialog command uses real SQL locks, JSON replay and isolated native samples',{
  skip:process.env.CAMPAIGN_OPTIMIZATION_MYSQL_TEST!=='1',timeout:180000,
},async()=>withIsolatedCampaignMysql(async({sql,models,report})=>{
  models.MarketingPatientList=require('../../../models/marketingpatientlist')(sql,S.DataTypes);
  models.MarketingPatientListItem=require('../../../models/marketingpatientlistitem')(sql,S.DataTypes);
  models.Message=sql.define('TestOnlyPaymentMessage',{status:S.STRING,metadata:S.JSON},{tableName:'testonly_payment_messages'});
  await models.MarketingPatientList.sync();await models.MarketingPatientListItem.sync();await models.Message.sync();
  const asset={id:1,assetType:'whatsapp_phone_number',phoneNumberId:'123456',wabaId:'TEST-WABA',isActive:true,
    assignmentScope:'clinic',clinicaId:56,additionalData:{payment:{status:'missing_payment_method',last_error_code:131042,last_detected_at:'2030-01-02T09:00:00Z'}}};
  models.ClinicMetaAsset={findOne:async()=>asset};models.Clinica={findByPk:async()=>({id_clinica:56,nombre_clinica:'TESTONLY clinic'})};
  models.WhatsappChannelBinding={findOne:async()=>({role:'primary'})};
  const template={id:1,name:'TESTONLY-greeting',status:'APPROVED',language:'es',category:'MARKETING',
    variables:['nombre_paciente','usuario_nombre','nombre_clinica'].map((name,i)=>({name,index:i+1})),
    components:[{type:'BODY',text:'Hola {{1}}, {{2}} de {{3}}'}]};
  models.WhatsappTemplate={findOne:async()=>template};
  let calls=0;
  const service=createService({db:models,authorize:async()=>true,now:()=>new Date('2030-01-02T10:00:00Z'),
    broker:{binding:async()=>({sendEnabled:true})},manual:{current:()=>false},payment:{derivePaymentSnapshot:data=>data.payment},
    health:{summarizeAssetHealth:()=>({state:'blocked',reason_code:'meta_error_131042_payment_missing',provider_status:'CONNECTED',can_send:false})},
    bulk:{sendTest:async(scope,listId,body)=>{
      calls++;assert.equal(scope.clinicIds[0],56);assert.equal(body.payment_recovery_probe,true);
      const item=await models.MarketingPatientListItem.findByPk(body.item_id);
      assert.equal(item.paciente_id,null);assert.equal(item.selected,false);assert.equal(item.phone,null);
      await models.Message.create({status:'pending',metadata:{kind:'mass_campaign_test',list_id:listId}});
      await new Promise(resolve=>setTimeout(resolve,25));
    }}});
  const input={clinicId:56,userId:1,phoneNumberId:'123456',to:'+34 600 000 001',requestId:'11111111-1111-4111-8111-111111111111'};
  const results=await Promise.allSettled([service.send(input),service.send(input),service.send(input)]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);assert.equal(calls,1);
  const replay=await service.send(input);assert.equal(replay.message_status,'pending');assert.equal(calls,1);
  assert.equal(await models.MarketingPatientList.count(),1);assert.equal(await models.Message.count(),1);
  assert.equal((await service.get(input)).app_message_id,replay.app_message_id);
  await assert.rejects(service.send({...input,to:'+34 600 000 003'}),{code:'payment_test_request_conflict'});
  const [locks]=await sql.query("SELECT IS_FREE_LOCK('cc-wa-payment-test:1') AS available");assert.equal(Number(locks[0].available),1);
  report.checks.push('Real SQL GET_LOCK/release, concurrent duplicate prevention, durable JSON request replay, explicit recipient conflict, archived list and nonpatient sample. Transport simulated; no host/provider sockets.');
  const source=fs.readFileSync(require.resolve('../../services/marketingBulkSends.service'),'utf8');
  const native=(name,deps)=>{
    const start=source.indexOf(`async function ${name}(`)>=0?source.indexOf(`async function ${name}(`):source.indexOf(`function ${name}(`);
    assert(start>=0,name);
    const end=['\nasync function ','\nfunction ','\nmodule.exports'].map(mark=>source.indexOf(mark,start+15)).filter(at=>at>=0);
    return vm.runInNewContext('('+source.slice(start,Math.min(...end))+')',{...deps});
  };
  models.MarketingPatientContactEvent=sql.define('TestOnlyPaymentAudit',{list_id:S.INTEGER,item_id:S.INTEGER,event_type:S.STRING,payload:S.JSON},{tableName:'testonly_payment_audit'});
  await models.MarketingPatientContactEvent.sync();
  const normalizeText=value=>String(value||'').trim(), clinic={nombre_clinica:'TESTONLY clinic'};
  const resolveValue=native('resolveVariableValue',{normalizeKey:normalizeText,normalizeText,
    resolveLastAttendedAppointmentDate:()=>'',CAMPAIGN_SENDER_VARIABLE_KEYS:new Set(['usuario_nombre','nombre_remitente','sender_name']),
    resolveReviewDisplayClinicName:()=>clinic.nombre_clinica,resolveReviewSenderName:()=>'',
    resolveCampaignSenderName:list=>list.criteria.sender_name,
    resolvePatientFirstNameForTemplate:()=> 'Prueba'});
  const params=async({item,list})=>template.variables.map(v=>resolveValue(v.name,item,list,clinic));
  const deps={...models,require:name=>{assert.equal(name,'../lib/phone');return require('../../lib/phone');},
    ensureScopeAccess:(list,scope)=>{assert.equal(list.clinica_id,scope.clinicIds[0]);},
    normalizeMassSendRecordKind:()=> 'campaign',asPlainObject:value=>value||{},normalizeText,normalizeTemplateUsage:normalizeText,
    isReviewTemplateUsage:()=>false,isCommercialTemplateUsage:()=>false,resolveWhatsappTemplate:async()=>template,
    isHttpsUrl:()=>false,publicMediaPersonalizationService:{normalizeHexColor:()=>null},
    assertReviewRequestCommunicationAllowed:async()=>({review:false}),getClinicIdForList:list=>list.clinica_id,
    loadClinicForTemplateVariables:async()=>clinic,resolveWhatsappClinicConfigForList:async()=>({phoneNumberId:'123456',wabaId:'TEST-WABA',originId:1}),
    isWhatsappRoutingConfigAvailable:()=>true,resolveWhatsappTemplateForClinic:async()=>template,
    buildMissingVariablesSummary:()=>[],assertTestSendCooldown:()=>{},buildTemplateParams:params,
    buildTemplateComponentsForSend:async()=>[],renderTemplatePreview:async args=>{let text=template.components[0].text;
      (await params(args)).forEach((value,i)=>{text=text.replace('{{'+(i+1)+'}}',value);});return text;},
    findCanonicalWhatsappConversation:async args=>{assert.equal(args.contactId,'34600000001');assert.equal(args.requireExactContact,true);
      return {id:1,update:async()=>{}};},emitQuickChatMessageCreated:()=>{},emitQuickChatMessageUpdated:()=>{},
    resolveWhatsappChannelRole:()=> 'primary',OBJECTIVE_ID:'mass_sends',
    whatsappService:{normalizePhoneNumber:require('../../lib/phone').normalizePhoneDigits,sendMessage:async args=>{
      calls++;assert.equal(args.to,'34600000001');assert.equal(args.clinicConfig.originId,1);
      assert.equal(args.healthContext.allowPaymentRecoveryProbe,true);assert.match(args.templateParams[1],/prueba, ignora este mensaje/);
      return {messages:[{id:'TESTONLY-accepted'}]};}},
    whatsappDeliveryGovernanceService:{recordImmediateSendResponse:async()=>({status:'accepted',providerMessageId:'TESTONLY-accepted'})},
  };
  deps.ensureDispatchableCampaignRecord=native('ensureDispatchableCampaignRecord',deps);
  const nativeSend=native('sendTest',deps);
  const integration=createService({db:models,authorize:async()=>true,now:()=>new Date('2030-01-02T10:00:00Z'),
    broker:{binding:async()=>({sendEnabled:true})},manual:{current:()=>false},payment:{derivePaymentSnapshot:data=>data.payment},
    health:{summarizeAssetHealth:()=>({state:'blocked',reason_code:'meta_error_131042_payment_missing',provider_status:'CONNECTED',can_send:false})},bulk:{sendTest:nativeSend}});
  const actual=await integration.send({...input,requestId:'22222222-2222-4222-8222-222222222222'});
  assert.equal(actual.message_status,'pending');assert.equal(actual.recovered,false);assert.equal(calls,2);
  const stored=await models.Message.findByPk(actual.app_message_id);
  assert.equal(stored.metadata.payment_recovery_probe,true);assert.equal(stored.metadata.kind,'mass_campaign_test');
  assert.equal(await models.MarketingPatientContactEvent.count(),1);
  const diagnostic=await models.MarketingPatientList.findByPk(stored.metadata.list_id);
  const sample=await models.MarketingPatientListItem.findByPk(stored.metadata.item_id);
  assert.equal(sample.sent_at,null);assert.equal(sample.dispatch_status,null);
  await assert.rejects(nativeSend({clinicIds:[56]},diagnostic.id,{payment_recovery_probe:true}),{code:'payment_test_not_dispatchable'});
  report.checks.push('Native sendTest and native template-variable resolver with owned SQL records, exact diagnostic sender/recipient, pending acceptance, unchanged sample statistics, isolated audit and rejection of direct campaign endpoint replay. Only transport simulated.');
}));
