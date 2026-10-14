'use strict';
const object = v => {
  if (typeof v === 'string') { try { v = JSON.parse(v); } catch { return {}; } }
  return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
};
const fail = (code, reasonCode = code) => { throw Object.assign(Error(code), { code, retryable: false,
  ...(require('./whatsapp-failure-diagnostic').reasonCode({ code: reasonCode }) ? { details: { reason_code: reasonCode } } : {}) }); };
const date = value => value == null ? NaN : new Date(value).getTime();
const day = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);
function calendarDayOffset(value, offset) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(value).reduce((fields, part) => ({ ...fields, [part.type]: part.value }), {});
  // Offset the clinic's local calendar date, not 7*24 elapsed hours: Madrid's
  // spring/autumn clock change must not shift a weekly reminder to another day.
  return day(new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + offset, 12)));
}
function importHeld(value) {
  const m = object(value);
  return m.automation_policy === 'hold' || m.automationPolicy === 'hold' || m.messages_enabled === false
    || m.historical_registration === true || m.kind === 'lead_resolution_historical'
    || ['import', 'cliniccloud_reconciliation'].some(key => m[key] && importHeld(m[key]));
}
function assertAppointmentEligibility({ appointment: a, execution: e, clinicId, patientId, templateName, confirmationTimeout = false, patientHoldOverride = false, now = Date.now() }) {
  require('./appointment-synthetic-guard').assertNoSyntheticDispatch(a, e);
  if (!a || Number(a.id_cita) !== Number(e.trigger_entity_id) || Number(a.clinica_id) !== Number(clinicId)
    || patientId && Number(a.paciente_id) !== Number(patientId)) fail('whatsapp_appointment_scope_changed');
  if (!require('./appointment-care').allowsAppointmentAutomation(a, e.trigger_type)) fail('whatsapp_appointment_care_stage_ineligible');
  const operations = require('./whatsappImportedAppointmentOperations');
  const legacyReleased = require('./whatsappImportedReminderRelease').permits(a, { execution: e, now });
  const operationalReleased = operations.permits(a, { execution: e, now });
  const sameDayRecovered = require('./whatsappSameDayRecovery').permits(a, { execution: e, templateName, now });
  const sameDayAuthorized = operations.permitsSameDay(a, { execution: e, now });
  const released = legacyReleased || operationalReleased || sameDayRecovered;
  const overrideDefaults = operationalReleased && operations.allowsSuppressionOverride(a, { now });
  if ((a.source_system || a.source_reference || importHeld(a.import_metadata)) && !released) fail('whatsapp_appointment_import_held');
  const reminder = /^clinicaclick_recordatorio_(semana_antes|dia_antes|mismo_dia)(?:_|$)/.exec(templateName || '');
  const context = object(e.context);
  const sameDayReminder = reminder?.[1] === 'mismo_dia'
    || confirmationTimeout && e.trigger_type === 'appointment_reminder_window' && context.trigger?.schedule_moment === 'same_day';
  if (!sameDayRecovered && !sameDayAuthorized && (released || patientHoldOverride) && sameDayReminder) fail('whatsapp_appointment_suppressed');
  const appointmentData = /^clinicaclick_confirmacion_datos_cita_(?:reprogramada_)?(?:hoy|24|48)(?:_|$)/.test(templateName || '');
  if (!reminder && !sameDayReminder && !appointmentData && !confirmationTimeout) return true; // Cancellation acknowledgements retain their existing flow.
  const start = date(a.inicio), previous = date(context.appointment?.inicio);
  if (!Number.isFinite(start)) fail('whatsapp_appointment_rescheduled', 'whatsapp_appointment_start_invalid');
  if (!Number.isFinite(previous) || start !== previous) fail('whatsapp_appointment_rescheduled');
  if (start <= now) fail('whatsapp_appointment_ineligible', 'whatsapp_appointment_past');
  if (a.es_provisional) fail('whatsapp_appointment_ineligible', 'whatsapp_appointment_provisional');
  if (!['pendiente','info_enviada','info_confirmada','recordatorio_enviado','recordatorio_confirmado','reprogramada'].includes(a.estado))
    fail('whatsapp_appointment_ineligible', 'whatsapp_appointment_status_ineligible');
  if (confirmationTimeout && a.estado === 'recordatorio_confirmado') fail('whatsapp_appointment_already_confirmed');
  if (confirmationTimeout && context.whatsapp_timeout_recovery && day(start) !== day(now)) fail('whatsapp_appointment_wrong_day');
  const m = object(a.import_metadata), suppression = object(m.notification_suppression || m.notificationSuppression);
  if (appointmentData && !overrideDefaults && (suppression.appointment_details || suppression.appointmentDetails || suppression.appointment_created)) fail('whatsapp_appointment_suppressed');
  if (confirmationTimeout && !overrideDefaults) {
    if (context.trigger?.schedule_moment === 'day_before' && !legacyReleased && (suppression.day_before || suppression.dayBefore)) fail('whatsapp_appointment_suppressed');
    if (['appointment_created', 'appointment_rescheduled'].includes(e.trigger_type)
      && (suppression.appointment_details || suppression.appointmentDetails || suppression.appointment_created)) fail('whatsapp_appointment_suppressed');
  }
  // week_before was never an importer technical default; it cannot gain an
  // override from the operational same-day policy or the exact day-before list.
  if ((reminder?.[1] === 'semana_antes' || confirmationTimeout && context.trigger?.schedule_moment === 'week_before')
    && (suppression.week_before || suppression.weekBefore)) fail('whatsapp_appointment_suppressed');
  if (appointmentData || !reminder && !sameDayReminder) return true; // The current future appointment, without a reminder-day constraint.
  const before = !sameDayReminder && reminder[1] === 'dia_antes';
  const weekly = reminder?.[1] === 'semana_antes';
  // info_confirmada only confirms appointment details. Attendance is a separate state.
  if ((before || weekly) && a.estado === 'recordatorio_confirmado') fail('whatsapp_appointment_already_confirmed');
  if (day(start) !== (weekly ? calendarDayOffset(now, 7) : day(now + (before ? 86400000 : 0)))) fail('whatsapp_appointment_wrong_day');
  if (weekly) return true;
  if (before ? !legacyReleased && !overrideDefaults && (suppression.day_before || suppression.dayBefore)
    : !sameDayRecovered && !(sameDayAuthorized && overrideDefaults) && (suppression.same_day || suppression.sameDay)) fail('whatsapp_appointment_suppressed');
  return true;
}
async function assertAutomatedMessageEligibility({ message, conversation, payload, loadExecution, loadAppointment, patientHeld, getReceptionState,
  loadNativeReplyAcknowledgement }) {
  const { assertNoSyntheticDispatch } = require('./appointment-synthetic-guard');
  assertNoSyntheticDispatch(message, conversation);
  const m = object(message.metadata), executionId = Number(m.execution_id);
  const automated = Number.isSafeInteger(executionId) && executionId > 0 || !!m.communication_scope;
  if (!automated) return true;
  const patientId = Number(m.recipient_patient_id || conversation.patient_id) || null;
  const held = patientId && await patientHeld(patientId);
  if (!Number.isSafeInteger(executionId) || executionId < 1) {
    if (held) fail('whatsapp_patient_import_held');
    return true;
  }
  const execution = await loadExecution(executionId);
  assertNoSyntheticDispatch(execution);
  if (!execution || Number(execution.clinic_id) !== Number(conversation.clinic_id)) fail('whatsapp_automation_scope_changed');
  if (execution.trigger_entity_type !== 'appointment') {
    if (held) fail('whatsapp_patient_import_held');
    return true;
  }
  const appointment = await loadAppointment(execution.trigger_entity_id);
  assertNoSyntheticDispatch(appointment);
  let released = require('./whatsappImportedReminderRelease').permits(appointment, { execution })
    || require('./whatsappImportedAppointmentOperations').permitsPatientHoldOverride(appointment, { execution })
    || require('./whatsappSameDayRecovery').permits(appointment, { execution,
      templateName: payload?.type === 'template' ? payload.template?.name : m.template_name || m.fallback_template_name });
  const appointmentPatientHeld = held || !patientId && appointment?.paciente_id && await patientHeld(Number(appointment.paciente_id));
  if (appointmentPatientHeld && String(m.communication_scope || '').trim().toLowerCase() === 'marketing') fail('whatsapp_patient_import_held');
  const actualTemplate = payload?.type === 'template' ? payload.template?.name : m.template_name || m.fallback_template_name;
  const confirmationTimeout = m.appointment_timeout === true
    || m.appointment_timeout == null && object(execution.context).whatsapp_no_response_timeout === true;
  const nativeCancellationAck = appointment?.estado === 'cancelada' && !appointment.source_system && !appointment.source_reference
    && !importHeld(appointment.import_metadata) && execution.trigger_type === 'appointment_reminder_window'
    && ['running', 'waiting'].includes(execution.status) && !confirmationTimeout
    && !/^(clinicaclick_recordatorio_|clinicaclick_confirmacion_datos_cita_)/.test(actualTemplate || '')
    && !/consent|review|rese[nñ]a|marketing|survey|encuesta/i.test(actualTemplate || '');
  if (appointmentPatientHeld && !released && nativeCancellationAck && loadNativeReplyAcknowledgement) {
    released = await loadNativeReplyAcknowledgement({ appointment, execution, conversation, message, payload }) === true;
  }
  if (appointmentPatientHeld && !released) fail('whatsapp_patient_import_held');
  if (confirmationTimeout) {
    const health = require('./whatsappInboxHealth');
    const receptionState = getReceptionState ? await getReceptionState() : health.state(health.read(), conversation.clinic_id);
    if (!receptionState.readyForTimeout) fail('whatsapp_inbox_reception_delayed');
  }
  return assertAppointmentEligibility({ appointment, execution, clinicId: conversation.clinic_id, patientId,
    patientHoldOverride: !!appointmentPatientHeld && released,
    confirmationTimeout,
    templateName: payload?.type === 'template' ? payload.template?.name : m.template_name || m.fallback_template_name });
}
async function patientImportHeld(patientId, db = require('../../models')) {
  const [rows] = await db.sequelize.query("SELECT 1 AS held FROM PatientCustomFields WHERE paciente_id=:patientId AND source='cliniccloud' AND JSON_VALID(value) AND (JSON_UNQUOTE(JSON_EXTRACT(IF(JSON_VALID(value),value,'{}'),'$.import.automation_policy'))='hold' OR JSON_EXTRACT(IF(JSON_VALID(value),value,'{}'),'$.import.messages_enabled')=CAST('false' AS JSON)) LIMIT 1", { replacements: { patientId } });
  return rows.length > 0;
}
module.exports = { object, day, importHeld, assertAppointmentEligibility, assertAutomatedMessageEligibility, patientImportHeld };
