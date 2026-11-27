'use strict';

const assert = require('node:assert/strict');
const D = require('sequelize');
const {withIsolatedCampaignMysql} = require('./fixtures/isolated_campaign_mysql.fixture');
const config = require('../../services/inboundLeadCaptureConfig.service');
const {create} = require('../../services/inboundLeadCapture.service');
const {attributeCampaignInfoReply} = require('../../services/marketingWhatsappReplyLead.service');

withIsolatedCampaignMysql(async ({sql, models: db, report}) => {
  db.Sequelize = D;
  db.Clinica = sql.define('Clinica', {id_clinica:{type:D.INTEGER, primaryKey:true}, grupoClinicaId:D.INTEGER,nombre_clinica:D.STRING},
    {tableName:'Clinicas', timestamps:false});
  await db.Clinica.sync();
  await db.Clinica.create({id_clinica:41});
  db.Paciente = sql.define('Paciente',{id_paciente:{type:D.INTEGER,primaryKey:true},clinica_id:D.INTEGER,
    telefono_movil:D.STRING,telefono_secundario:D.STRING,email:D.STRING,nombre:D.STRING,apellidos:D.STRING});
  db.PacienteClinica = sql.define('PacienteClinica',{paciente_id:D.INTEGER,clinica_id:D.INTEGER});
  db.Paciente.hasMany(db.PacienteClinica,{as:'clinicasVinculadas',foreignKey:'paciente_id'});
  await db.Paciente.sync();
  await db.PacienteClinica.sync();
  for (const name of ['AutomationFlowTemplateV2','FlowExecutionV2','LeadIntake','LeadAttributionAudit',
    'Conversation','Message','AutomationInboundMessageClaim','MarketingContactOptOut']) {
    db[name] = require('../../../models/' + name.toLowerCase())(sql,D.DataTypes);
    await db[name].sync();
  }
  db.MarketingPatientList = sql.define('MarketingPatientList',{clinica_id:D.INTEGER,objective_id:D.STRING,name:D.STRING,criteria:D.JSON,clinic_ids:D.JSON,channel:D.STRING,status:D.STRING});
  db.MarketingPatientListItem = sql.define('MarketingPatientListItem',{clinica_id:D.INTEGER,list_id:D.INTEGER,name:D.STRING,phone:D.STRING});
  await db.MarketingPatientList.sync();
  await db.MarketingPatientListItem.sync();
  await sql.getQueryInterface().addIndex('LeadIntakes',['external_source','external_id'],{unique:true});
  const {template_id} = await config.save(db,41,'whatsapp',11,true);
  const template = await db.AutomationFlowTemplateV2.findByPk(template_id);
  await template.update({trigger_config:{...template.trigger_config,effective_from:new Date(Date.now()-3600000).toISOString()}});
  let disposition = 'review', classifierCalls = 0;
  const refreshed = [];
  const service = create({db, notifyConversation:(clinicId,{id}) => {assert.equal(clinicId,41);refreshed.push(id);}, restrictions:async () => ({}), classify:async () => {
    classifierCalls++;
    if (disposition === 'unavailable') throw Error('private simulated provider details');
    if (disposition === 'invalid') return {irrelevant:true};
    return {kind:disposition,privateRequested:false};
  }});
  let phone = 34611000100, sequence = 0;
  const binding = {clinicId:41,phoneId:'123',wabaId:'456'};
  const thread = () => db.Conversation.create({channel:'whatsapp',clinic_id:41,contact_id:String(++phone)});
  async function inbound(conversation, content, metadata={}) {
    const mid = 'wamid.commercialregression' + ++sequence;
    const message = await db.Message.create({conversation_id:conversation.id,direction:'inbound',message_type:'text',content,
      status:'delivered',sent_at:new Date(),metadata:{wamid:mid,phone_number_id:'123',waba_id:'456',provider_type:'text',
        provider_sent_at:new Date().toISOString(), ...metadata}});
    const claim = await db.AutomationInboundMessageClaim.create({message_id:message.id,conversation_id:conversation.id,
      clinic_id:41,channel:'whatsapp',provider_message_id:mid,claim_key:mid});
    const execution = {id:sequence,clinic_id:41,template_version_id:template_id,trigger_type:'mensaje_recibido',
      trigger_entity_id:message.id,idempotency_key:'inbound_capture:41:'+message.id,
      context:{trigger:{data:{message_id:message.id,claim_id:claim.id,conversation_id:conversation.id,channel:'whatsapp'}}}};
    return {message,conversation,run:()=>service.run(execution),execution};
  }
  async function campaign(conversation, name, policy) {
    const list = await db.MarketingPatientList.create({clinica_id:41,objective_id:'mass_sends',name,
      criteria:{record_kind:'campaign',capture_whatsapp_info_leads:true}});
    const item = await db.MarketingPatientListItem.create({clinica_id:41,list_id:list.id,phone:conversation.contact_id});
    const wamid = 'wamid.campaignregression'+list.id;
    await db.Message.create({conversation_id:conversation.id,direction:'outbound',message_type:'template',status:'sent',
      content:'Oferta de prueba', createdAt:new Date(Date.now()-1000),metadata:{source:'marketing_bulk_sends',
        phoneNumberId:'123', wabaId:'456', wamid, recipient:conversation.contact_id,list_id:list.id,item_id:item.id,
        kind:'mass_campaign_send', dispatch_context:'campaign', capture_whatsapp_info_leads:true,
        template_commercial:true, whatsapp_lead_capture_policy:policy}});
    return {id:list.id, context:{id:wamid}};
  }
  const direct = await thread();
  const first = await inbound(direct,'¿Cuánto cuestan tres sesiones faciales?');
  const created = await first.run();
  assert.equal(created.reason,'interest');
  assert.equal(created.outcome,'created');
  assert.deepEqual(await first.run(),created);
  const linked = await (await inbound(direct,'INFO')).run();
  assert.equal(linked.outcome,'linked');
  assert.equal(linked.leadId,created.leadId);
  const patient = await thread();
  await db.Paciente.create({id_paciente:101,clinica_id:41});
  await patient.update({patient_id:101});
  for (const [text,reason,outcome] of [
    ['Quiero información para cambiar mi cita del jueves','appointment_management','discarded'],
    ['Quiero mover mi cita y conocer el precio del bono','mixed_appointment_interest','review'],
    ['Responde BAJA','quoted_campaign','discarded'],
    ['Black Friday. Responde INFO. Responde BAJA','quoted_campaign','discarded'],
  ]) {
    const row = await (await inbound(patient,text)).run();
    assert.deepEqual([row.reason,row.outcome,row.leadId],[reason,outcome,null]);
  }
  assert.equal(classifierCalls,0);
  const unknown = await inbound(patient,'¿Qué os parece?');
  assert.equal((await unknown.run()).reason,'intent_ambiguous');
  const retry = await inbound(await thread(),'Consulto una oferta en particular');
  for (const [mode,code] of [['unavailable','inbound_capture_classifier_unavailable'],['invalid','inbound_capture_classifier_invalid']]) {
    disposition = mode;
    await assert.rejects(retry.run(),{code});
    const metadata = (await retry.message.reload()).metadata;
    assert.equal(metadata.inboundLeadCapture,undefined);
    assert.deepEqual(metadata.inboundLeadCaptureClassification,{key:retry.execution.idempotency_key,
      templateId:template_id,executionId:retry.execution.id,failureCode:code});
  }
  disposition = 'interest';
  const recovered = await retry.run();
  assert.equal(recovered.outcome,'created');
  const recoveredCalls = classifierCalls;
  assert.deepEqual(await retry.run(),recovered);
  assert.equal(classifierCalls,recoveredCalls);
  assert.equal((await retry.message.reload()).metadata.inboundLeadCaptureClassification,undefined);
  const recipient = await thread();
  const a = await campaign(recipient,'A','enabled'), b = await campaign(recipient,'B','enabled');
  const ambiguous = await (await inbound(recipient,'INFO')).run();
  assert.deepEqual([ambiguous.reason,ambiguous.outcome,ambiguous.leadId,ambiguous.campaignId],['attribution_ambiguous','review',null,null]);
  const quoteA = await (await inbound(recipient,'INFO',{context:a.context})).run();
  const repeatA = await (await inbound(recipient,'INFO',{context:a.context})).run();
  const quoteB = await (await inbound(recipient,'INFO',{context:b.context})).run();
  assert.deepEqual([quoteA.outcome,repeatA.outcome,quoteB.outcome],['created','linked','created']);
  assert.equal(repeatA.leadId,quoteA.leadId);
  assert.notEqual(quoteB.leadId,quoteA.leadId);
  assert.equal((await recipient.reload()).lead_id,quoteA.leadId);
  const counter = await thread();
  const priorOffer = await campaign(counter,'Oferta anterior','enabled');
  await db.Message.create({conversation_id:counter.id,direction:'outbound',message_type:'template',status:'delivered',
    createdAt:new Date(),content:'Confirmación ficticia',metadata:{kind:'patient_program_booking_notice',phoneNumberId:'123',
      wabaId:'456',wamid:'wamid.clinicnotice'}});
  const unquoted = await inbound(counter,'INFO');
  assert.equal((await unquoted.run()).reason,'attribution_ambiguous');
  const quoted = await (await inbound(counter,'INFO',{context:priorOffer.context})).run();
  assert.equal(quoted.campaignId,priorOffer.id);
  const off = await campaign(recipient,'C','disabled');
  const excluded = await (await inbound(recipient,'INFO',{context:off.context})).run();
  assert.deepEqual([excluded.reason,excluded.outcome,excluded.leadId],['campaign_excluded','discarded',null]);
  const before = await db.LeadIntake.count();
  assert.equal(refreshed.length, 15);
  assert.equal(new Set(refreshed).size, refreshed.length);
  const {applyInboundOptOutIfNeeded} = require('../../services/marketingOptOut.service');
  for (const [text,expected] of [['Responde BAJA',false],['Responde INFO. Responde BAJA.',false],['No me escribáis más',true]]) {
    const own = await thread();
    await campaign(own,'OptOut','enabled');
    const {message} = await inbound(own,text);
    await applyInboundOptOutIfNeeded({clinicId:41,conversation:own,inboundMessage:message});
    assert.equal(!!(await db.MarketingContactOptOut.findOne({where:{inbound_message_id:message.id}})),expected);
  }
  assert.equal(await db.LeadIntake.count(),before);
  const legacy = await thread();
  const old = await campaign(legacy,'Antigua','inherit');
  await config.save(db,41,'whatsapp',11,false);
  for (const outcome of ['created','linked']) {
    const {message} = await inbound(legacy,'INFO',{context:old.context});
    const result = await db.sequelize.transaction(transaction =>
      attributeCampaignInfoReply({db,message,conversation:legacy,binding,transaction,freshDispatch:true}));
    assert.equal(result.attribution.capture_origin,'campaign_send_configuration');
    assert.equal(result.attribution.outcome,outcome);
    assert.equal(result.attribution.campaign_id,old.id);
    const audit = await db.LeadAttributionAudit.findOne({where:{lead_intake_id:result.lead.id,'attribution_steps.whatsapp_bulk_send.campaign_id':old.id}});
    assert.equal(audit.attribution_steps.whatsapp_bulk_send.capture_origin,'campaign_send_configuration');
  }
  report.checks.push('capture outcomes, clinic appointment, copied opt-out, provider failures, campaign attribution and legacy source');
}).catch(error => { console.error(error); process.exitCode=1; });
