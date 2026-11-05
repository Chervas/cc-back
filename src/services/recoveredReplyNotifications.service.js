'use strict';
const { Op } = require('sequelize');
const integer = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const object = value => { try { const v=typeof value==='string'?JSON.parse(value):value; return v && typeof v==='object'&&!Array.isArray(v)?v:{}; } catch { return {}; } };
const flag = value => value === true || value === 1;
function requestFor(notification) {
  const data=object(notification.data);
  if (notification.event!=='automation.persistent_alert' || notification.isRead
    || !String(notification.dedupeKey||'').startsWith('automation:recovered-reply:')
    || data.source!=='automations_v2' || data.trigger_entity_type!=='appointment') return null;
  const request={notificationId:integer(notification.id),clinicId:integer(notification.clinicaId),
    conversationId:integer(data.quickChatConversationId),messageId:integer(data.quickChatResponseMessageId),appointmentId:integer(data.trigger_entity_id)};
  return Object.values(request).every(Boolean)?request:null;
}
function resolution(row) {
  if (!row) return null;
  if (integer(row.human_reply_id)) return {reason:'human_reply_already_sent',humanMessageId:Number(row.human_reply_id)};
  if (row.state_status==='completed' && !flag(row.manual_action_required) && !flag(row.needs_response) && !flag(row.possible_urgency)
    && Number(row.state_appointment_id)===Number(row.appointment_id) && Number(row.state_source_id)>=Number(row.source_id)) {
    return {reason:'review_already_completed',sourceMessageId:Number(row.state_source_id)};
  }
  // A change of appointment status does not answer an additional question or
  // resolve an urgency attached to this very reply.
  if (Number(row.state_source_id)===Number(row.source_id) && (flag(row.needs_response)||flag(row.possible_urgency))) return null;
  return integer(row.appointment_action_id)?{reason:'appointment_action_already_recorded',appointmentEventId:Number(row.appointment_action_id)}:null;
}
function createService({models,emitUpdated=()=>{},emitState=()=>{},now=()=>new Date()}) {
  async function proofs(requests,transaction) {
    if (!requests.length) return [];
    const [rows]=await models.sequelize.query(`SELECT /*+ MAX_EXECUTION_TIME(3000) */ r.notification_id,source.id source_id,
      c.id conversation_id,c.clinic_id,a.id_cita appointment_id,s.status state_status,s.source_message_id state_source_id,
      s.appointment_id state_appointment_id,s.manual_action_required,s.needs_response,s.possible_urgency,
      (SELECT MAX(h.id) FROM Messages h WHERE h.conversation_id=c.id AND h.id>source.id AND h.sent_at>=source.sent_at
        AND h.direction='outbound' AND h.message_type<>'event' AND h.status IN ('sent','delivered','read')
        AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(h.metadata,'$.kind')),'')<>'manual_appointment_notice'
        AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(h.metadata,'$.delivery_unknown')),'false')<>'true'
        AND JSON_EXTRACT(h.metadata,'$.revoke') IS NULL
        AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(h.metadata,'$.coexistence.last_event')),'')<>'revoke'
        AND ((h.sender_id>0 AND JSON_EXTRACT(h.metadata,'$.execution_id') IS NULL
          AND JSON_EXTRACT(h.metadata,'$.automation_execution_id') IS NULL)
          OR JSON_UNQUOTE(JSON_EXTRACT(h.metadata,'$.source_event'))='smb_message_echoes'
          OR JSON_UNQUOTE(JSON_EXTRACT(h.metadata,'$.coexistence.source_event'))='smb_message_echoes')) human_reply_id,
      (SELECT MAX(e.id) FROM PatientOperationalEvents e WHERE e.clinic_id=c.clinic_id AND e.patient_id=c.patient_id
        AND e.actor_user_id>0 AND e.source='agenda' AND e.event_type='appointment.status_changed'
        AND e.occurred_at>=source.sent_at AND CAST(JSON_UNQUOTE(JSON_EXTRACT(e.metadata,'$.appointment_id')) AS UNSIGNED)=a.id_cita
        AND JSON_UNQUOTE(JSON_EXTRACT(e.metadata,'$.new_status')) IN
          ('info_confirmada','recordatorio_confirmado','cancelada','reprogramada','ha_acudido','atencion_iniciada','completada')) appointment_action_id,
      (SELECT MAX(m.id) FROM Messages m WHERE m.conversation_id=c.id AND m.direction='inbound' AND m.message_type<>'event') latest_inbound_id
      FROM JSON_TABLE(:requests,'$[*]' COLUMNS(notification_id INT PATH '$.notificationId',clinic_id INT PATH '$.clinicId',
        conversation_id INT PATH '$.conversationId',message_id INT PATH '$.messageId',appointment_id INT PATH '$.appointmentId')) r
      JOIN Conversations c ON c.id=r.conversation_id AND c.clinic_id=r.clinic_id AND c.channel='whatsapp'
      JOIN Messages source ON source.id=r.message_id AND source.conversation_id=c.id AND source.direction='inbound'
      JOIN CitasPacientes a ON a.id_cita=r.appointment_id AND a.clinica_id=c.clinic_id AND a.paciente_id=c.patient_id
      LEFT JOIN ConversationAutomationStates s ON s.conversation_id=c.id AND s.clinic_id=c.clinic_id`,
    {replacements:{requests:JSON.stringify(requests)},...(transaction?{transaction}:{})});
    return rows;
  }
  async function alreadyHandled({clinicId,conversationId,messageId,appointmentId}) {
    const request={notificationId:1,clinicId:integer(clinicId),conversationId:integer(conversationId),messageId:integer(messageId),appointmentId:integer(appointmentId)};
    if (!Object.values(request).every(Boolean)) return null;
    return resolution((await proofs([request]))[0]);
  }
  async function reconcileForUser(notifications,userId) {
    const id=integer(userId),ids=notifications.filter(n=>Number(n.userId)===id&&requestFor(n)).map(n=>Number(n.id)).slice(0,200);
    if (!id||!ids.length) return {updated:0};
    const updated=[];
    await models.sequelize.transaction(async transaction=>{
      const locked=await models.Notification.findAll({where:{id:{[Op.in]:ids},userId:id,isRead:false},transaction,lock:transaction.LOCK.UPDATE});
      const requests=locked.map(requestFor).filter(Boolean);
      const rows=await proofs(requests,transaction),byId=new Map(rows.map(r=>[Number(r.notification_id),r]));
      const canonical=new Map();
      for(const notification of [...locked].sort((a,b)=>Number(b.id)-Number(a.id))) {
        const request=requestFor(notification);if(!request)continue;
        const key=JSON.stringify([request.clinicId,request.conversationId,request.messageId,request.appointmentId]);
        if(!canonical.has(key))canonical.set(key,Number(notification.id));
      }
      for(const notification of locked) {
        const row=byId.get(Number(notification.id));if(!row)continue;
        let proof=resolution(row);
        const request=requestFor(notification),key=JSON.stringify([request.clinicId,request.conversationId,request.messageId,request.appointmentId]);
        if(!proof&&canonical.get(key)!==Number(notification.id))proof={reason:'duplicate_recovered_reply_review',canonicalNotificationId:canonical.get(key)};
        if(!proof)continue;
        const at=now(),data=object(notification.data);
        await notification.update({isRead:true,readAt:at,data:{...data,auto_resolution_reason:proof.reason,
          auto_resolved_at:at.toISOString(),auto_resolution_evidence:proof}},{transaction});
        // Complete only the recovered review for the exact latest input. A new
        // question, another appointment or another review keeps its ownership.
        if(proof.reason!=='duplicate_recovered_reply_review' && Number(row.latest_inbound_id)===Number(row.source_id)) {
          await models.ConversationAutomationState.update({status:'completed',stage:'completed',manual_action_required:false,
            failure_code:null,completed_at:at},{where:{conversation_id:row.conversation_id,clinic_id:row.clinic_id,
            source_message_id:row.source_id,appointment_id:row.appointment_id,status:'review',
            failure_code:'inbound_recovery_requires_review',needs_response:false,possible_urgency:false},transaction});
        }
        updated.push(notification);
      }
      transaction.afterCommit(()=>updated.forEach(emitUpdated));
    });
    if(updated.length) {
      const fresh=await models.Notification.findAll({where:{id:{[Op.in]:updated.map(n=>n.id)},userId:id}});
      const changed=new Map(fresh.map(n=>[Number(n.id),n]));
      notifications.forEach((n,i)=>{if(changed.has(Number(n.id)))notifications[i]=changed.get(Number(n.id));});
      for(const n of updated)emitState({clinicId:n.clinicaId,conversationId:object(n.data).quickChatConversationId});
    }
    return {updated:updated.length};
  }
  return {alreadyHandled,reconcileForUser};
}
let instance;
function current(){return instance||=createService({models:require('../../models'),
  emitUpdated:n=>require('./notificationsRealtime.service').emitNotificationUpdated(n),
  emitState:({clinicId,conversationId})=>require('./socket.service').getIO()?.to(`clinic:${clinicId}`).emit('conversation:updated',{
    id:String(conversationId),clinic_id:Number(clinicId),realtime_refresh:true,
  })});}
module.exports={createService,current,requestFor,resolution};
