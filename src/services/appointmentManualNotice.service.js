'use strict';
const C = require('../lib/manual-appointment-notice');
const EVENT = 'appointment.manual_notice_requested';
const plain = row => row?.toJSON ? row.toJSON() : row;

function createService(deps = {}) {
  const db = () => deps.models || require('../../models');
  const now = () => deps.now ? deps.now() : new Date();
  const senderFor = deps.loadSender || (clinicId => require('./flowEngineV2.service').resolveScheduledWhatsappSenderConfig({ metadata:{}, clinicId }));
  const authorize = deps.authorize || (async (userId, clinicId) => {
    for (const featureKey of ['appointments.manage','quickchat.read_patients']) await require('../lib/access-policy')
      .assertUserCanAccessFeature({ actorId:userId, clinicId, featureKey });
  });
  const held = deps.patientHeld || (id => require('../lib/whatsappAppointmentEligibility').patientImportHeld(id, db()));
  const allowed = deps.communicationAllowed || (input => require('./marketingOptOut.service').assertAutomationCommunicationAllowed(input));
  const windowFor = deps.sendWindow || (clinic => require('./flowEngineV2.service').computeQuietHoursDelayMs({ now:now(), enabled:true,
    timeZone:require('../lib/availability-calendar').resolveClinicTimezone(clinic) }));

  async function load({ appointmentId, clinicId, userId, transaction, lock = false }) {
    const m = db(), options = { transaction, ...(lock ? { lock:transaction.LOCK.UPDATE } : {}) };
    const a = plain(await m.CitaPaciente.findByPk(appointmentId, options));
    if (!a || Number(a.clinica_id) !== Number(clinicId)) C.fail('appointment_not_found','No se encuentra esa cita en la clínica seleccionada.',404);
    await authorize(Number(userId), Number(clinicId), a);
    C.validateAppointment(a,now());
    const patient = plain(await m.Paciente.findByPk(a.paciente_id, options));
    const clinic = plain(await m.Clinica.findByPk(clinicId, { transaction }));
    if (!patient || !clinic || !C.phone(patient.telefono_movil)) C.fail('patient_phone_required','La ficha necesita un teléfono válido.');
    if (await held(a.paciente_id)) C.fail('whatsapp_patient_import_held','El paciente conserva un bloqueo de comunicaciones.');
    await allowed({ clinicId:Number(clinicId), patientId:a.paciente_id, phone:C.phone(patient.telefono_movil), scope:'care' });
    const sender = await senderFor(Number(clinicId));
    if (!sender?.authorizedBroker?.sendEnabled) C.fail('whatsapp_config_missing','WhatsApp no está disponible para esta clínica.');
    const locale = require('../lib/whatsapp-template-locale').normalizeWhatsappLocale(patient.idioma_preferido,{ fallback:'es' });
    const catalog = await m.WhatsappTemplateCatalog.findOne({ where:{family_key:C.FAMILY,locale,is_active:true},transaction });
    const templates = catalog ? await m.WhatsappTemplate.findAll({ where:{catalog_template_id:catalog.id,waba_id:sender.wabaId,
      is_active:true,status:'APPROVED',category:'UTILITY'},transaction,order:[['id','DESC']] }) : [];
    const template = templates.map(plain).find(t=>C.templateValid(t,locale));
    if (!template) C.fail('manual_appointment_template_pending','La plantilla de reenvío aún no está aprobada para este WhatsApp e idioma.');
    const params = C.parameters(a,patient,clinic), content = C.render(locale,params), recipient = C.phone(patient.telefono_movil);
    const snapshot = { appointment_id:Number(a.id_cita),clinic_id:Number(clinicId),patient_id:Number(a.paciente_id),
      start_at:C.date(a.inicio).toISOString(),end_at:C.date(a.fin).toISOString(),recipient,
      template_id:Number(template.id),template_name:template.name,template_language:template.language,
      sender_origin_id:Number(sender.originId || sender.authorizedBroker.assetId),phoneNumberId:sender.phoneNumberId,wabaId:sender.wabaId,
      content,params,locale };
    return { a,patient,clinic,sender,template,snapshot,revision:C.revision(snapshot),window:windowFor(clinic) };
  }
  async function preview(input) {
    const state = await load(input), m = db();
    const previous = await m.PatientOperationalEvent.findOne({ where:{clinic_id:Number(input.clinicId),patient_id:state.a.paciente_id,event_type:EVENT,
      'metadata.appointment_id':Number(state.a.id_cita)},
      order:[['id','DESC']],attributes:['occurred_at','actor_user_id','metadata'],raw:true });
    const delivered = await m.sequelize.query(`SELECT m.id, COALESCE(m.sent_at,m.createdAt) AS sent_at, c.contact_id
      FROM Messages m JOIN Conversations c ON c.id=m.conversation_id
      LEFT JOIN FlowExecutionsV2 e ON e.id=CAST(NULLIF(JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.execution_id')),'') AS UNSIGNED)
      WHERE c.clinic_id=:clinicId AND c.patient_id=:patientId AND m.direction='outbound'
        AND m.status IN ('sent','delivered','read') AND m.message_type<>'event'
        AND ((JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.kind'))='manual_appointment_notice'
          AND JSON_UNQUOTE(JSON_EXTRACT(m.metadata,'$.manual_appointment_id'))=:appointmentId)
          OR (e.trigger_entity_type='appointment' AND e.trigger_entity_id=:appointmentId))
      ORDER BY m.id DESC LIMIT 1`,{replacements:{clinicId:Number(input.clinicId),patientId:state.a.paciente_id,appointmentId:String(state.a.id_cita)},type:m.Sequelize.QueryTypes.SELECT});
    return { appointment_id:state.a.id_cita,clinic_id:Number(input.clinicId),recipient:state.snapshot.recipient,
      text:state.snapshot.content,revision:state.revision,scheduled_for:state.window.scheduledAt?.toISOString() || null,
      scheduled_label:C.localLabel(state.window.scheduledAt,state.clinic),
      last_sent:delivered[0]?{at:delivered[0].sent_at,at_label:C.localLabel(delivered[0].sent_at,state.clinic),recipient:C.phone(delivered[0].contact_id)}:null,
      last_request:previous ? {at:previous.occurred_at,at_label:C.localLabel(previous.occurred_at,state.clinic),actor_user_id:previous.actor_user_id} : null };
  }
  async function send({ appointmentId,clinicId,userId,revision,requestId }) {
    if (!/^[a-f0-9-]{36}$/i.test(requestId || '') || !/^[a-f0-9]{64}$/.test(revision || '')) C.fail('manual_appointment_request_invalid','Revisa la vista previa del envío.',400);
    const m = db(), key = `manual-appointment:${Number(clinicId)}:${Number(appointmentId)}:${Number(userId)}:${requestId}`;
    return m.sequelize.transaction(async transaction => {
      // Same lock order as the contact resolver and patient edits.
      await m.Clinica.findByPk(clinicId,{transaction,lock:transaction.LOCK.SHARE});
      const initial = await m.CitaPaciente.findByPk(appointmentId,{transaction});
      if (!initial || Number(initial.clinica_id)!==Number(clinicId)) C.fail('appointment_not_found','No se encuentra esa cita.',404);
      await m.Paciente.findByPk(initial.paciente_id,{transaction,lock:transaction.LOCK.UPDATE});
      await authorize(Number(userId),Number(clinicId),plain(initial));
      // A locking read is essential under MySQL REPEATABLE READ: the appointment
      // read above may have established a snapshot before a concurrent commit.
      const existing = await m.Message.findOne({where:{automation_delivery_key:key},transaction,lock:transaction.LOCK.UPDATE});
      if (existing) {
        if (existing.metadata?.manual_notice_revision!==revision) C.fail('manual_appointment_changed','La vista previa ya no corresponde a este envío.');
        return {message_id:existing.id,conversation_id:existing.conversation_id,status:existing.status,reused:true};
      }
      const state = await load({appointmentId,clinicId,userId,transaction,lock:true});
      if (state.revision!==revision) C.fail('manual_appointment_changed','La cita, el teléfono o el remitente han cambiado. Revisa la vista previa.');
      const conversation = await (deps.resolveConversation || require('../lib/canonical-conversation').findCanonicalWhatsappConversation)({
        clinicId:Number(clinicId),patientId:state.a.paciente_id,contactId:state.snapshot.recipient,
        createIfMissing:true,requireExactContact:true,isolatePatientContact:true,transaction });
      const event = await m.PatientOperationalEvent.create({patient_id:state.a.paciente_id,clinic_id:Number(clinicId),actor_user_id:Number(userId),
        event_type:EVENT,source:'manual_appointment_notice',channel:'whatsapp',occurred_at:now(),
        metadata:{version:1,...state.snapshot,request_key:key,revision}},{transaction});
      const metadata = {kind:'manual_appointment_notice',manual_notice_event_id:Number(event.id),manual_notice_revision:revision,
        recipient:state.snapshot.recipient,recipient_patient_id:state.a.paciente_id,communication_scope:'care',
        sender_origin_id:state.snapshot.sender_origin_id,phoneNumberId:state.snapshot.phoneNumberId,phoneId:state.snapshot.phoneNumberId,wabaId:state.snapshot.wabaId,
        template_id:state.template.id,template_name:state.template.name,template_language:state.template.language,template_params:state.snapshot.params,
        manual_appointment_id:state.a.id_cita,quiet_hours_enabled:true,suppress_flow_event:true,
        scheduled_for:state.window.scheduledAt?.toISOString() || null};
      const message = await m.Message.create({conversation_id:conversation.id,sender_id:Number(userId),direction:'outbound',
        message_type:'template',content:state.snapshot.content,status:'pending',automation_delivery_key:key,metadata},{transaction});
      await m.JobRequest.create({type:'appointment_manual_notice',status:'waiting',priority:'high',origin:'appointment_manual_notice',
        requested_by:Number(userId),max_attempts:5,next_run_at:state.window.scheduledAt || now(),
        payload:{message_id:message.id,__runtime_namespace:deps.namespace || require('./jobRequests.service').getCurrentRuntimeNamespace()}},{transaction});
      transaction.afterCommit(()=>{
        if(deps.emitCreated)return deps.emitCreated(conversation,message);
        const io=require('./socket.service').getIO();io?.to(`clinic:${clinicId}`).emit('message:created',message.toJSON());
      });
      return {message_id:message.id,conversation_id:conversation.id,status:message.status,scheduled_for:metadata.scheduled_for,reused:false};
    });
  }
  async function assertReady({message,conversation,payload}) {
    const m=db(), metadata=message?.metadata || {};
    const event=plain(await m.PatientOperationalEvent.findByPk(metadata.manual_notice_event_id));
    const frozen=event?.metadata || {};
    if (event?.event_type!==EVENT || event.source!=='manual_appointment_notice' || frozen.version!==1
      || Number(message.sender_id)!==Number(event.actor_user_id) || Number(event.clinic_id)!==Number(conversation?.clinic_id)
      || Number(event.patient_id)!==Number(conversation?.patient_id) || message.automation_delivery_key!==frozen.request_key
      || metadata.execution_id || metadata.manual_notice_revision!==frozen.revision
      || String(message.content)!==frozen.content || C.phone(conversation.contact_id)!==frozen.recipient)
      C.fail('manual_appointment_scope_changed','El envío ya no coincide con su solicitud.');
    const state=await load({appointmentId:frozen.appointment_id,clinicId:event.clinic_id,userId:event.actor_user_id});
    if (state.revision!==frozen.revision || C.phone(metadata.recipient)!==state.snapshot.recipient
      || Number(metadata.template_id)!==state.template.id || metadata.template_name!==state.template.name
      || metadata.template_language!==state.template.language || Number(metadata.sender_origin_id)!==state.snapshot.sender_origin_id
      || String(metadata.phoneNumberId)!==String(state.snapshot.phoneNumberId) || String(metadata.wabaId)!==String(state.snapshot.wabaId)
      || JSON.stringify(metadata.template_params)!==JSON.stringify(state.snapshot.params))
      C.fail('manual_appointment_changed','La cita o el teléfono han cambiado desde que se preparó el envío.');
    if (payload && (payload.type!=='template' || payload.template?.name!==state.template.name
      || payload.template?.language?.code!==state.template.language)) C.fail('manual_appointment_payload_changed','La plantilla del envío ha cambiado.');
    if (payload) {
      const components=payload.template.components || [];
      const body=components.find(c=>String(c.type).toLowerCase()==='body');
      if (components.length!==1 || !body || body.parameters?.length!==5
        || body.parameters.some((p,i)=>p.type!=='text' || p.text!==state.snapshot.params[String(i+1)]))
        C.fail('manual_appointment_payload_changed','Los datos del envío han cambiado.');
      if (state.window.delayMs>0) C.fail('manual_appointment_quiet_hours','El envío debe esperar al horario permitido.');
    }
    return state;
  }
  async function dispatch({message_id:messageId}) {
    const m=db(), message=await m.Message.findByPk(messageId);
    if (!message || message.status!=='pending' || message.metadata?.wamid) return {status:'completed',result:{skipped:true}};
    const conversation=await m.Conversation.findByPk(message.conversation_id);
    let state;
    try {state=await assertReady({message,conversation});}
    catch(error) {
      if (Number(error.statusCode || error.status)>=500 || !error.statusCode && !error.status) throw error;
      await message.update({status:'failed',metadata:{...message.metadata,error:error.code,manual_notice_blocked:true}});
      return {status:'completed',result:{skipped:true,reason:error.code}};
    }
    if (state.window.delayMs>0) return {status:'waiting',nextAllowedAt:state.window.scheduledAt,result:{reason:'quiet_hours'}};
    const metadata=message.metadata;
    await (deps.enqueue || ((payload,options)=>require('./queue.service').queues.outboundWhatsApp.add('send',payload,options)))({
      messageId:message.id,conversationId:conversation.id,clinicId:conversation.clinic_id,to:metadata.recipient,body:message.content,
      useTemplate:true,templateName:metadata.template_name,templateLanguage:metadata.template_language,
      templateParams:metadata.template_params,retryOnFailure:false,resolveClinicConfigAtSend:true,
    },require('../lib/appointment-access-guidance-template').buildAutomationWhatsappTransportJobOptions(message.id));
    return {status:'completed',result:{message_id:message.id}};
  }
  return {preview,send,assertReady,dispatch};
}
let instance;
const current=()=>instance ||= createService();
module.exports={EVENT,createService,current};
