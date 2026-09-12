'use strict';
const { SOCKET_EVENTS, positive } = require('../../services/platform-audit/src/realtime-contract');
const fields = {
  message: 'id conversation_id content direction message_type status sent_at sender_id',
  conversation: 'id unread_count pending_automation_attention pending_automation_count pending_automation_message_id automation_response_processing automation_response_processing_message_id automation_processing_stage automation_processing_status automation_processing_started_at automation_processing_deadline_at automation_action_appointment_id automation_action_appointment_status automation_intent automation_possible_urgency automation_needs_response automation_manual_action_required last_message last_message_at',
  lead: 'type lead_id clinic_id group_id campaign_id source channel status_lead created_at emitted_at call_initiated call_initiated_at call_outcome call_outcome_at call_outcome_appointment_id',
  appointment: 'appointment_id clinic_id patient_id lead_intake_id doctor_id instalacion_id tratamiento_id estado inicio fin updated_at created_at',
  flow_execution: 'execution_id template_version_id status current_node_id wait_until trigger_type trigger_entity_type trigger_entity_id clinic_id group_id updated_at kind',
  notification: 'id title description time link useRouter icon read category categoryLabel event level clinicaId',
};
function project(input, names) {
  const out = {};
  for (const key of names.split(' ')) {
    let value = input?.[key]; if (value instanceof Date) value = value.toISOString();
    if (value === undefined) continue;
    if (!(value === null || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)
      || typeof value === 'string' && Buffer.byteLength(value) <= 32768)) throw Error('realtime_payload_invalid');
    out[key] = value;
  }
  return out;
}
function packetFor(event, payload) {
  if (!SOCKET_EVENTS.includes(event) || !payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const family = event.split(':')[0];
  if (family === 'message' && (payload.metadata?.qa_cleanup === true || payload.metadata?.hide_from_quickchat === true)) return null;
  const resourceType = { message: 'conversation', conversation: 'conversation', lead: 'lead', appointment: 'appointment', flow_execution: 'execution', notification: 'notification' }[family];
  const resourceId = payload[{ message: 'conversation_id', conversation: 'id', lead: 'lead_id', appointment: 'appointment_id', flow_execution: 'execution_id', notification: 'id' }[family]];
  if (!positive(resourceId)) return null;
  const body = project(payload, fields[family]);
  if (family === 'message') {
    body.realtime_refresh = true;
    body.metadata = {};
    for (const key of ['phoneNumberId', 'phoneId', 'phone_number_id', 'phone_id']) {
      const value = payload.metadata?.[key];
      if (typeof value === 'string' && /^[1-9]\d{0,19}$/.test(value)) body.metadata[key] = value;
    }
  }
  // Arbitrary provider metadata, resume_text, errors and execution snapshots never cross to browsers.
  if (family === 'flow_execution') {
    body.last_error = null;
    if (payload.template) body.template = project(payload.template, 'id template_key version name trigger_type');
    if (event === 'flow_execution:log') body.log = { ...project(payload.log, 'id node_id node_type status started_at finished_at'), error_message: null, audit_snapshot: null };
  }
  if (family === 'notification') {
    body.data = project(payload.data, 'quickChatConversationId quickChatMessageId appointmentId leadId');
    // Navigation must remain local; arbitrary URLs can carry credentials or exfiltrate user context.
    body.link = typeof body.link === 'string' && /^\/(?!\/)[a-zA-Z0-9/_-]*$/.test(body.link) ? body.link : null;
  }
  if (family === 'message' && !positive(body.id)) return null;
  if (Buffer.byteLength(JSON.stringify(body)) > 49152) throw Error('realtime_payload_invalid');
  return { event, body, resource: { type: resourceType, id: String(resourceId) } };
}
module.exports = { packetFor };
