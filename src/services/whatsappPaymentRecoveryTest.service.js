'use strict';

const { normalizePhoneDigits } = require('../lib/phone');
const paymentProbe = require('../lib/whatsapp-payment-recovery-probe');
const { buildWhatsappTemplateVariableContract } = require('../lib/whatsapp-template-contract');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const TEST_SENDER = 'Clinicaclick (prueba, ignora este mensaje)';
const fail = (code, status = 409, details = {}) => { throw Object.assign(Error(code), { code, status, statusCode:status, details }); };
const plain = value => value?.get ? value.get({plain:true}) : value;
const object = value => value && typeof value === 'object' ? value : {};

function createService({ db = require('../../models'), bulk = require('./marketingBulkSends.service'),
  broker = require('../lib/whatsappAuthorizedBrokerClient'), health = require('./whatsappAccountHealth.service'),
  payment = require('./whatsappPaymentStatus.service'), manual = require('../lib/whatsappManualDisconnect'),
  authorize, now = () => new Date() } = {}) {
  async function context({ clinicId, phoneNumberId, userId }) {
    if (!Number.isSafeInteger(clinicId) || clinicId <= 0 || !/^[1-9][0-9]{0,31}$/.test(String(phoneNumberId || ''))
      || !Number.isSafeInteger(userId) || userId <= 0) fail('payment_test_scope_required',400);
    if (!authorize || !await authorize({clinicId,userId})) fail('payment_test_forbidden',403);
    const asset = await db.ClinicMetaAsset.findOne({where:{assetType:'whatsapp_phone_number',phoneNumberId,isActive:true}});
    const clinic = await db.Clinica.findByPk(clinicId,{attributes:['id_clinica','grupoClinicaId','nombre_clinica'],raw:true});
    if (!asset || !clinic || !(asset.assignmentScope === 'clinic' && Number(asset.clinicaId) === clinicId
      || asset.assignmentScope === 'group' && Number(asset.grupoClinicaId) === Number(clinic.grupoClinicaId) && Number(clinic.grupoClinicaId)>0)) fail('payment_test_phone_not_found',404);
    const binding = await broker.binding(clinicId,Number(asset.id),asset);
    const snapshot = health.summarizeAssetHealth(asset);
    const paymentSnapshot = payment.derivePaymentSnapshot(asset.additionalData || {});
    let availability = paymentProbe.availability({asset,health:snapshot,now:now()});
    if (!binding || binding.sendEnabled !== true || manual.current(asset,binding)) availability = {allowed:false,reason:'payment_probe_sender_unavailable'};
    const localBinding = await db.WhatsappChannelBinding.findOne({where:{clinic_id:clinicId,asset_id:asset.id,is_active:true},raw:true});
    if (localBinding?.role === 'secondary' && !(localBinding.purposes || []).includes('bulk_campaigns')) availability = {allowed:false,reason:'payment_probe_purpose_unavailable'};
    const template = await db.WhatsappTemplate.findOne({where:{waba_id:asset.wabaId,catalog_template_id:114,language:'es',status:'APPROVED',is_active:true},order:[['id','DESC']]});
    const components = Array.isArray(template?.components) ? template.components : [];
    const body = components.find(part => String(part.type).toUpperCase() === 'BODY')?.text;
    const variables = buildWhatsappTemplateVariableContract(plain(template));
    const compatible = !!body && components.length === 1 && variables.length === 3
      && variables.map(variable => variable.name).join(',') === 'nombre_paciente,usuario_nombre,nombre_clinica'
      && [...body.matchAll(/\{\{\s*([0-9]+)\s*\}\}/g)].map(match => match[1]).join(',') === '1,2,3';
    if (!compatible) availability = {allowed:false,reason:'payment_probe_template_unavailable'};
    const params = ['Prueba',TEST_SENDER,clinic.nombre_clinica];
    const preview = compatible ? body.replace(/\{\{\s*([0-9]+)\s*\}\}/g,(_,index) => params[Number(index)-1]) : null;
    return { asset,clinic,template,availability,paymentSnapshot,health:snapshot,preview };
  }
  async function previous(input, asset) {
    if (!input.requestId) return null;
    if (!UUID.test(input.requestId)) fail('payment_test_request_invalid',400);
    const list = await db.MarketingPatientList.findOne({where:{clinica_id:input.clinicId,created_by:input.userId,
      source:'whatsapp_payment_recovery_test','criteria.request_id':input.requestId},order:[['id','DESC']]});
    if (!list) return null;
    if (Number(list.criteria?.sender_origin_id) !== Number(asset.id) || list.criteria?.phone_number_id !== asset.phoneNumberId
      || list.criteria?.waba_id !== asset.wabaId) fail('payment_test_binding_changed');
    if (input.to && normalizePhoneDigits(input.to) !== list.criteria?.probe_to) fail('payment_test_request_conflict');
    const message = await db.Message.findOne({where:{'metadata.list_id':list.id,'metadata.kind':'mass_campaign_test'},order:[['id','DESC']]});
    return {list,message};
  }
  function result(state, previousTest = null) {
    const message = plain(previousTest?.message);
    const metadata = object(message?.metadata);
    const error = Array.isArray(metadata.wa_error) ? metadata.wa_error[0] : metadata.error?.error || metadata.error;
    return { success:true,available:state.availability,health:state.health,payment_status:state.paymentSnapshot.status,
      recovered:state.paymentSnapshot.status === 'active' && state.health.can_send === true,
      sender: { phone_number_id:state.asset.phoneNumberId, phone:state.asset.additionalData?.display_phone_number || state.asset.metaAssetName,
        name:state.asset.waVerifiedName || state.clinic.nombre_clinica },
      preview:state.preview,template_name:state.template?.name || null,template_category:state.template?.category || null,
      ...(previousTest ? {request_id:previousTest.list.criteria.request_id,app_message_id:message?.id || null,
        message_status:message?.status || 'unknown',error_code:Number(error?.code) || null} : {}) };
  }
  async function get(input) {
    const state = await context(input);
    return result(state,await previous(input,state.asset));
  }
  async function send(input) {
    if (!UUID.test(input.requestId || '')) fail('payment_test_request_invalid',400);
    const to = normalizePhoneDigits(input.to);
    if (typeof input.to !== 'string' || input.to.length > 32 || !/^[+0-9 ()-]+$/.test(input.to)
      || !to || !/^\d{10,15}$/.test(to)) fail('payment_test_phone_invalid',400);
    const initial = await context(input);
    return db.sequelize.transaction(async transaction => {
      const lock = `cc-wa-payment-test:${Number(initial.asset.id)}`;
      const [rows] = await db.sequelize.query('SELECT GET_LOCK(:lock,0) AS acquired',{replacements:{lock},transaction});
      if (Number(rows[0]?.acquired) !== 1) fail('payment_test_in_progress');
      try {
        const state = await context(input);
        const existing = await previous(input,state.asset);
        if (existing) return result(state,existing);
        if (!state.availability.allowed) fail(state.availability.reason,409,state.availability);
        const scope = {scope:'clinic',clinicIds:[input.clinicId]};
        const list = await db.MarketingPatientList.create({name:'Comprobacion de pago WhatsApp',objective_id:'mass_sends',
          source:'whatsapp_payment_recovery_test',status:'archived',scope_type:'clinic',clinica_id:input.clinicId,
          created_by:input.userId,channel:'whatsapp',counters:{total:0,ready:0},criteria:{record_kind:'campaign',
            whatsapp_payment_recovery_test:true,request_id:input.requestId,probe_to:to,sender_origin_id:Number(state.asset.id),
            phone_number_id:state.asset.phoneNumberId,waba_id:state.asset.wabaId,whatsapp_template_id:state.template.id,
            template_usage:'manual_patient_contact',template_commercial:false,sender_name:TEST_SENDER}});
        const item = await db.MarketingPatientListItem.create({list_id:list.id,clinica_id:input.clinicId,paciente_id:null,
          name:'Prueba de conexion',phone:null,status:'test_sample',selected:false,custom_fields:{
            nombre:'Prueba',nombre_paciente:'Prueba',
            usuario_nombre:TEST_SENDER,nombre_remitente:TEST_SENDER,nombre_clinica:state.clinic.nombre_clinica}});
        try {
          await bulk.sendTest(scope,list.id,{to,item_id:item.id,clinic_id:input.clinicId,sender_origin_id:Number(state.asset.id),
            whatsapp_template_id:state.template.id,template_usage:'manual_patient_contact',payment_recovery_probe:true},
          {allowDiagnosticPaymentTest:true});
        } catch (error) {
          const stored = await previous(input,state.asset);
          if (!stored?.message) throw error;
        }
        const current = await context(input);
        return result(current,await previous(input,current.asset));
      } finally { await db.sequelize.query('SELECT RELEASE_LOCK(:lock)',{replacements:{lock},transaction}); }
    });
  }
  return {get,send};
}

module.exports = {createService};
