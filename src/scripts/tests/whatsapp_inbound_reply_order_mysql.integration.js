'use strict';

const assert = require('node:assert/strict');
const D = require('sequelize');
const {withIsolatedCampaignMysql} = require('./fixtures/isolated_campaign_mysql.fixture');

withIsolatedCampaignMysql(async ({sql, models:db, report}) => {
  db.Sequelize = D;
  db.Clinica = sql.define('Clinica', {id_clinica:{type:D.INTEGER,primaryKey:true},grupoClinicaId:D.INTEGER,configuracion:D.JSON},{timestamps:false});
  await db.Clinica.sync();
  await db.Clinica.create({id_clinica:41});
  const schedulerFile = require.resolve('../../services/jobScheduler.service');
  require.cache[schedulerFile] = {id:schedulerFile,filename:schedulerFile,loaded:true,exports:{triggerImmediate:async()=>{}}};
  await sql.getQueryInterface().createTable('Pacientes',{id_paciente:{type:D.INTEGER,primaryKey:true}});
  for (const name of ['MarketingCompetitionHeatmapCache','MarketingPatientList','MarketingPatientListItem','MarketingPatientContactEvent','LeadIntake','Conversation','Message','AutomationFlowTemplateV2','FlowExecutionV2','AutomationInboundMessageClaim','LeadAssistantSession','ConversationAutomationState','JobRequest']) {
    db[name] = require('../../../models/'+name.toLowerCase())(sql,D.DataTypes);
    await db[name].sync();
  }
  await sql.getQueryInterface().addIndex('FlowExecutionsV2',['idempotency_key'],{unique:true});
  const services = name => require('../../services/'+name+'.service');
  // Separate owners have their own MySQL tests. Drive their normal dispatch contracts to check priority.
  let waiting = false, optedOut = false, closed = false, reopenedAt = null;
  let attributed = false, captureMarker = true, captures = 0, sends = 0, analyses = 0;
  services('inboundLeadCapture').enqueueWhatsapp = async ({message}) => {
    captures++;
    if (attributed && captureMarker) await message.update({metadata:{...message.metadata,inboundLeadCapture:{origin:'whatsapp_campaign',campaignId:72}}});
    return {pending:false};
  };
  services('marketingOptOut').applyBulkWhatsappOptOut = async () => ({});
  services('marketingOptOut').applyInboundOptOutIfNeeded = async () => ({applied:optedOut});
  services('marketingOptOut').getActiveContactRestrictionsForPatient = async () => ({});
  services('automationsV2Resume').enqueueInboundResponseResume = async () => ({matched:waiting?1:0,execution_ids:[18]});
  let careOwner = null;
  for (const service of ['patientProgramBookingNotice','patientMobileVerification']) {
    services(service).current = () => ({inbound:async()=>({handled:careOwner === service})});
  }
  services('whatsappDispatchWait').inboundTransition = async () => null;
  services('automationAttentionReconciliation').reconcilePendingAutomationAttentionForInboundMessage = async () => ({handled:false});
  const receiptTimes = [];
  services('clinicOpeningHours').resolveClinicOpenState = async ({now}) => {
    assert(now instanceof Date);
    receiptTimes.push(+now);
    return {has_schedule:true,open_now:!(closed || (reopenedAt && +now < reopenedAt))};
  };
  const whatsapp = services('leadAssistantWhatsapp');
  const dispatch = services('automationInboundMessage');
  const plan = require('../../lib/lead-social-flow');
  const origin = {flowCalls:[],sent:[]};
  const body = 'Bienvenida acordada en la clínica ficticia.';
  const binding = {phoneId:'10041'};
  const api = whatsapp.create({
    db,
    createExecution: values => db.FlowExecutionV2.create(values),
    enqueueJob: async ({payload}) => { origin.flowCalls.push(payload.execution_id); return {job:{id:payload.execution_id}}; },
    resolveRoute: async () => ({phoneNumberId:binding.phoneId,authorizedBroker:{sendEnabled:true}}),
    refresh:() => {},
    analyze:async () => { throw Error('Do not call an AI provider for a prepared reply'); },
    send:async delivery => {
      const m = await db.Message.findByPk(delivery.healthContext.messageId);
      const c = await db.Conversation.findByPk(m.conversation_id);
      const intent = {replyWindowEndsAt:delivery.healthContext.replyWindowEndsAt,message:{type:'text',to:delivery.to,text:{body:delivery.body}}};
      assert(await whatsapp.authorizeDelivery(db,{conversation:c,message:m,intent,selectedBinding:binding}));
      assert.equal(await whatsapp.authorizeDelivery(db,{conversation:c,message:m,intent,selectedBinding:{phoneId:'999'}}),false);
      assert.equal(await whatsapp.authorizeDelivery(db,{conversation:c,message:m,intent:{...intent,message:{...intent.message,text:{body:'Otro texto'}}},selectedBinding:binding}),false);
      origin.sent.push(m.id); sends++;
      return {messages:[{id:'wamid.TESTOUT'+m.id}]};
    },
  });
  whatsapp.current = () => api;
  const template = await db.AutomationFlowTemplateV2.create({
    public_id:'flw_test_reply', template_key:'lead_auto_reply_system__clinic_41',
    version:1, name:'Respuesta ficticia', is_system:false, is_active:true, clinic_id:41,
    trigger_type:'lead_nuevo',trigger_config:{configured:true,managed_feature:'lead_auto_reply',social_entries:{whatsapp_dm:{action:'message',text:body}}},
    entry_node_id:'N1', nodes:[], published_at:new Date(Date.now()-3600000),created_by:1,
  });
  const baseNodes = [{id:'N1',type:'trigger/message_received',outputs:{on_success:'N2'}},{id:'N2',type:'control/end',outputs:{}}];
  const mode = {timing:'clinic_closed',after_hours_action:'assistant',after_hours_assistant_version:9};
  const after = await db.AutomationFlowTemplateV2.create({
    public_id:'flw_test_hours',template_key:'system_message_received_after_hours__clinic_41',version:1,
    name:'Horario ficticio',is_system:false,is_active:true,clinic_id:41,trigger_type:'message_received',trigger_config:mode,
    entry_node_id:'N1',nodes:plan.withAfterHoursReply(baseNodes,'N1',mode),published_at:new Date(Date.now()-3600000),created_by:1,
  });
  let sequence = 0;
  async function incoming({text='Quiero información',age=0} = {}) {
    const n=++sequence;
    const c=await db.Conversation.create({clinic_id:41,channel:'whatsapp',contact_id:'+34600000'+String(n).padStart(3,'0')});
    let quoted;
    if (attributed) {
      const campaign = await db.MarketingPatientList.create({name:'Campaña ficticia',clinica_id:41,objective_id:'mass_sends',criteria:{},created_by:1});
      const item = await db.MarketingPatientListItem.create({list_id:campaign.id,clinica_id:41,conversation_id:c.id,name:'Contacto ficticio',phone:c.contact_id,dispatch_status:'sent'});
      quoted = 'wamid.CAMPAIGN'+n;
      await db.Message.create({conversation_id:c.id,direction:'outbound',content:'Campaña ficticia',message_type:'text',status:'delivered',
        sent_at:new Date(Date.now()-5000),createdAt:new Date(Date.now()-5000),metadata:{source:'marketing_bulk_sends',kind:'mass_campaign_send',dispatch_context:'campaign',template_commercial:true,whatsapp_lead_capture_policy:captureMarker?'enabled':'disabled',
          list_id:campaign.id,item_id:item.id,recipient:c.contact_id,delivery_clinic_id:41,phoneNumberId:binding.phoneId,wabaId:'20041',wamid:quoted}});
    }
    const time=new Date(Date.now()-age);
    const m=await db.Message.create({conversation_id:c.id,direction:'inbound',content:text,message_type:'text',status:'sent',sent_at:time,
      metadata:{wamid:'wamid.SYNTHETIC'+n,provider_sent_at:time.toISOString(),phoneId:binding.phoneId,waba_id:'20041',provider_type:'text',...(quoted?{context:{id:quoted}}:{})}});
    const claim=await db.AutomationInboundMessageClaim.create({clinic_id:41,conversation_id:c.id,message_id:m.id,channel:'whatsapp',claim_key:'wa:'+n,provider_message_id:m.metadata.wamid});
    const run=async()=>dispatch.runInboundDispatchJob({claim_id:claim.id,message_id:m.id,conversation_id:c.id,clinic_id:41,channel:'whatsapp'},{id:n,attempts:1});
    return {c,m,claim,run};
  }
  async function assertPrepared(input) {
    const row=await input.run();
    assert.equal(row.result.owner,'whatsapp_inbound_reply');
    const e=await db.FlowExecutionV2.findByPk(row.result.execution_id);
    const attempts=await Promise.all([api.run(e),api.run(e)]);
    assert(attempts.some(r=>r.outcome==='sent'));
    assert((await input.run()).result.deduplicated);
    assert.equal(await db.Message.count({where:{conversation_id:input.c.id,direction:'outbound',automation_delivery_key:{[D.Op.ne]:null}}}),1);
    return e;
  }
  await assertPrepared(await incoming());
  await template.update({trigger_config:{...template.trigger_config,social_entries:{whatsapp_dm:{action:'message',text:body,origins:['bulk_whatsapp']}}}});
  attributed=true;
  await assertPrepared(await incoming());
  captureMarker=false;
  await assertPrepared(await incoming());
  assert.equal(await db.MarketingPatientContactEvent.count({where:{event_type:'mass_campaign_message_replied'}}),2);
  attributed=false;
  assert.equal((await (await incoming()).run()).result.owner,'unclaimed');
  await template.update({trigger_config:{...template.trigger_config,social_entries:{whatsapp_dm:{action:'message',text:body}}}});
  const human=await incoming();
  const humanExecution=await db.FlowExecutionV2.findByPk((await human.run()).result.execution_id);
  await db.LeadAssistantSession.create({conversation_id:human.c.id,clinic_id:41,template_id:template.id,publication_version:1,origin_message_id:human.m.id,origin_input:'whatsapp_dm',state:'operator',updated_at:new Date()});
  assert.equal((await api.run(humanExecution)).reason,'human_takeover');
  const superseded=await incoming();
  const supersededExecution=await db.FlowExecutionV2.findByPk((await superseded.run()).result.execution_id);
  await db.Message.create({conversation_id:superseded.c.id,direction:'outbound',content:'Recepción responde',status:'sent',message_type:'text'});
  assert.equal((await api.run(supersededExecution)).reason,'already_replied');
  assert.equal((await (await incoming({age:86400001})).run()).result.owner,'unclaimed');
  const capturesBeforeCare = captures;
  for (const [service, owner] of [['patientProgramBookingNotice','patient_program_booking_notice'],
      ['patientMobileVerification','patient_mobile_verification']]) {
    careOwner = service;
    assert.equal((await (await incoming({text:'Quiero información'})).run()).result.owner,owner);
  }
  careOwner = null;
  waiting=true; optedOut=true;
  assert.equal((await (await incoming({text:'BAJA'})).run()).result.owner,'marketing_opt_out');
  optedOut=false; assert.equal((await (await incoming()).run()).result.owner,'wait_response'); waiting=false;
  assert.equal(captures,capturesBeforeCare,'care, opt-out and active response waits must resolve before capture');
  await template.update({is_active:false});
  // Receipt precedes the clinic opening, although the delayed worker and broker already run during opening hours.
  reopenedAt=Date.now()-30000;
  const night=await incoming({age:60000});
  const row=await night.run();
  assert(receiptTimes.includes(Date.parse(night.m.metadata.provider_sent_at)));
  const execution=await db.FlowExecutionV2.findByPk(row.result.execution_id);
  assert.equal(execution.template_version_id,after.id);
  const assistant=services('leadAssistantTurn');
  assistant.attend=async ({rule})=>{analyses++;assert.equal(rule.version,9);assert.equal(rule.audience,'leads');return {reason:'simulation_accepted'};};
  assert.equal((await api.run(execution)).reason,'simulation_accepted');
  closed=true;
  const patient = await incoming();
  await sql.query('INSERT INTO Pacientes(id_paciente) VALUES(101)');
  await patient.c.update({patient_id:101});
  assert.equal((await patient.run()).result.owner,'after_hours_team');
  assert.equal((await (await incoming({text:'Hola'})).run()).result.owner,'after_hours_team');
  assert.equal((await (await incoming({text:'Me duele mucho, es urgente'})).run()).result.owner,'after_hours_team');
  closed=true;
  await after.update({trigger_config:{timing:'clinic_closed',after_hours_action:'team'}});
  assert.equal((await api.run(execution)).reason,'automation_inactive');
  // Retry a dispatch that had already committed its execution when the worker exited.
  await night.claim.update({status:'claimed',processed_at:null,owner_type:'dispatching',metadata:{}});
  assert.equal((await night.run()).result.execution_id,execution.id);
  assert.equal(await db.FlowExecutionV2.count({where:{trigger_entity_id:night.m.id,trigger_entity_type:'message'}}),1);
  assert.equal((await (await incoming()).run()).result.owner,'after_hours_team');
  // The old publication with no explicit choice retains its buffered notice.
  await after.update({trigger_config:{timing:'clinic_closed'}});
  const legacy = await incoming();
  const legacyResult = await legacy.run();
  assert.equal(legacyResult.result.owner,'message_received');
  assert.equal((await legacy.claim.reload()).owner_type,'message_received');
  assert.equal(sends,3); assert.equal(analyses,1); assert(captures>=9);
  report.checks.push('direct and attributed WA fixed text, broker binding and payload proof, concurrent run and duplicate dispatch, opt-out before waiter, human takeover, delivery window, independent closed-hours Cleo, policy withdrawal, team and original buffered notice');
}).catch(error=>{console.error(error);process.exitCode=1});
