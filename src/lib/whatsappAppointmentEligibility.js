'use strict';
const object = v => {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return {}; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
};
const fail = code => { throw Object.assign(Error(code), { code, retryable: false }); };
const date = value => value == null ? NaN : new Date(value).getTime();
const day = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
function importHeld(value) {
  const m = object(value);
  return m.automation_policy === 'hold' || m.automationPolicy === 'hold' || m.messages_enabled === false
    || m.historical_registration === true || m.kind === 'lead_resolution_historical'
    || ['import', 'cliniccloud_reconciliation'].some(key => m[key] && importHeld(m[key]));
}
function assertAppointmentEligibility({ appointment: a, execution: e, clinicId, patientId, templateName, confirmationTimeout = false, now = Date.now() }) {
  if (!a || Number(a.id_cita) !== Number(e.trigger_entity_id) || Number(a.clinica_id) !== Number(clinicId)
    || patientId && Number(a.paciente_id) !== Number(patientId)) fail('whatsapp_appointment_scope_changed');
  if (a.source_system || a.source_reference || importHeld(a.import_metadata)) fail('whatsapp_appointment_import_held');
  const reminder = /^clinicaclick_recordatorio_(dia_antes|mismo_dia)(?:_|$)/.exec(templateName || '');
  const appointmentData = /^clinicaclick_confirmacion_datos_cita_(?:reprogramada_)?(?:hoy|24|48)(?:_|$)/.test(templateName || '');
  if (!reminder && !appointmentData && !confirmationTimeout) return true; // Cancellation acknowledgements retain their existing flow.
  const start = date(a.inicio), previous = date(e.context?.appointment?.inicio);
  if (!Number.isFinite(start) || !Number.isFinite(previous) || start !== previous) fail('whatsapp_appointment_rescheduled');
  if (start <= now || a.es_provisional || !['pendiente','info_enviada','info_confirmada','recordatorio_enviado','recordatorio_confirmado','reprogramada'].includes(a.estado)) fail('whatsapp_appointment_ineligible');
  if (confirmationTimeout && a.estado === 'recordatorio_confirmado') fail('whatsapp_appointment_already_confirmed');
  if (confirmationTimeout && e.context?.whatsapp_timeout_recovery && day(start) !== day(now)) fail('whatsapp_appointment_wrong_day');
  if (appointmentData || !reminder) return true; // The current future appointment, without a reminder-day constraint.
  const before = reminder[1] === 'dia_antes';
  // info_confirmada only confirms appointment details. Attendance is a separate state.
  if (before && a.estado === 'recordatorio_confirmado') fail('whatsapp_appointment_already_confirmed');
  if (day(start) !== day(now + (before ? 86400000 : 0))) fail('whatsapp_appointment_wrong_day');
  const m = object(a.import_metadata), suppression = object(m.notification_suppression || m.notificationSuppression);
  if (before ? suppression.day_before || suppression.dayBefore : suppression.same_day || suppression.sameDay) fail('whatsapp_appointment_suppressed');
  return true;
}
async function assertAutomatedMessageEligibility({ message, conversation, payload, loadExecution, loadAppointment, patientHeld }) {
  const m = object(message.metadata), executionId = Number(m.execution_id);
  const automated = Number.isSafeInteger(executionId) && executionId > 0 || !!m.communication_scope;
  if (!automated) return true;
  const patientId = Number(m.recipient_patient_id || conversation.patient_id) || null;
  if (patientId && await patientHeld(patientId)) fail('whatsapp_patient_import_held');
  if (!Number.isSafeInteger(executionId) || executionId < 1) return true;
  const execution = await loadExecution(executionId);
  if (!execution || Number(execution.clinic_id) !== Number(conversation.clinic_id)) fail('whatsapp_automation_scope_changed');
  if (execution.trigger_entity_type !== 'appointment') return true;
  const appointment = await loadAppointment(execution.trigger_entity_id);
  if (!patientId && appointment?.paciente_id && await patientHeld(Number(appointment.paciente_id))) fail('whatsapp_patient_import_held');
  if (m.appointment_timeout === true) {
    const health = require('./whatsappInboxHealth');
    if (!health.state(health.read(), conversation.clinic_id).healthy) fail('whatsapp_inbox_reception_delayed');
  }
  return assertAppointmentEligibility({ appointment, execution, clinicId: conversation.clinic_id, patientId,
    confirmationTimeout: m.appointment_timeout === true,
    templateName: payload?.type === 'template' ? payload.template?.name : m.template_name || m.fallback_template_name });
}
async function patientImportHeld(patientId, db = require('../../models')) {
  const [rows] = await db.sequelize.query("SELECT 1 AS held FROM PatientCustomFields WHERE paciente_id=:patientId AND source='cliniccloud' AND JSON_VALID(value) AND (JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(value),value,'{}'),'$.import.automation_policy'))='hold' OR JSON_EXTRACT(IF(JSON_VALID(value),value,'{}'),'$.import.messages_enabled')=CAST('false' AS JSON)) LIMIT 1", { replacements: { patientId } });
  return rows.length > 0;
}
module.exports = { object, importHeld, assertAppointmentEligibility, assertAutomatedMessageEligibility, patientImportHeld };
