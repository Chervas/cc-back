'use strict';

// Communication identity only. This module never changes reservation links,
// treatment membership, clinical state, import HOLDs or notification consent.
const { createHash } = require('node:crypto');
const calendar = require('./availability-calendar');
const SCHEMA = 'appointment-reminder-sequence/1';
const STAGES = Object.freeze(['week_before', 'day_before', 'same_day', 'no_response']);
const id = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;
const object = value => {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
};
const fail = suffix => { throw Object.assign(Error('appointment_reminder_sequence_' + suffix), {
  code: 'appointment_reminder_sequence_' + suffix, retryable: false,
}); };
function instant(value) {
  if (!(value instanceof Date) && (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value))) fail('instant_invalid');
  const date = new Date(value);
  if (!Number.isFinite(+date)) fail('instant_invalid');
  return date.toISOString();
}
function dayScope(appointment, timeZone) {
  const clinic_id = id(appointment?.clinica_id), patient_id = id(appointment?.paciente_id);
  if (!clinic_id || !patient_id || !id(appointment?.id_cita) || !calendar.isValidTimeZone(timeZone)) fail('scope_invalid');
  const start = instant(appointment.inicio), local_date = calendar.formatDateLocal(new Date(start), timeZone);
  const following = new Date(local_date + 'T12:00:00Z'); following.setUTCDate(following.getUTCDate() + 1);
  return { clinic_id, patient_id, local_date, time_zone: timeZone,
    starts_at: calendar.localDateTimeToUtc(local_date, '00:00:00', timeZone),
    ends_at: calendar.localDateTimeToUtc(following.toISOString().slice(0, 10), '00:00:00', timeZone) };
}
function sequenceKey(scope) {
  if (!id(scope?.clinic_id) || !id(scope?.patient_id) || !/^\d{4}-\d\d-\d\d$/.test(scope?.local_date || '')) fail('scope_invalid');
  // Deliberately excludes appointment, doctor/room, template version, runtime
  // namespace and start time: changing those cannot create a new delivery right.
  return 'appointment-day:' + createHash('sha256').update([SCHEMA, scope.clinic_id, scope.patient_id, scope.local_date].join(':')).digest('hex');
}
function stageKey(value) {
  if (!STAGES.includes(value)) fail('stage_invalid');
  return value;
}
function placeholder(row) {
  const m = object(row?.import_metadata);
  return require('./whatsappImportedAppointmentOperations').isHistorical(row)
    || row?.es_provisional === true || row?.es_provisional === 1 || !!row?.hold_expires_at
    || m.historical_registration === true || m.imported_as_past_activity === true
    || ['lead_resolution_historical', 'historical_treatment'].includes(m.kind)
    || require('./appointment-synthetic-guard').isSyntheticData(row);
}
function selectAnchor(appointments, scope) {
  if (!Array.isArray(appointments)) fail('appointments_invalid');
  const rows = appointments.filter(row => id(row?.clinica_id) === scope.clinic_id && id(row?.paciente_id) === scope.patient_id
    && row.estado !== 'cancelada' && !placeholder(row)
    && calendar.formatDateLocal(new Date(instant(row.inicio)), scope.time_zone) === scope.local_date);
  if (rows.some(row => !id(row.id_cita))) fail('appointments_invalid');
  rows.sort((a, b) => +new Date(a.inicio) - +new Date(b.inicio) || id(a.id_cita) - id(b.id_cita));
  // Confirmation, arrival, clinical completion and no-show deliberately remain
  // anchors; a later reservation is not a second arrival for this patient/day.
  return rows[0] || null;
}
function executionStage(execution) {
  const context = object(execution?.context);
  if (execution?.trigger_type !== 'appointment_reminder_window') return null;
  const moment = context.trigger?.schedule_moment;
  return ['week_before', 'day_before', 'same_day'].includes(moment) ? moment : null;
}
function messageStage({ execution, message, stageKey: supplied } = {}) {
  if (execution?.trigger_type !== 'appointment_reminder_window') return null;
  const m = object(message?.metadata);
  const timeout = m.appointment_timeout === true || m.appointment_timeout === 1
    || m.appointment_timeout == null && object(execution?.context).whatsapp_no_response_timeout === true;
  const name = m.template_name || m.fallback_template_name || '';
  const reminder = /^clinicaclick_recordatorio_(semana_antes|dia_antes|mismo_dia)(?:_|$)/.exec(name);
  // A reply/acknowledgement inside a reminder execution is not another reminder.
  const inferred = timeout ? 'no_response' : reminder
    ? ({ semana_antes: 'week_before', dia_antes: 'day_before', mismo_dia: 'same_day' })[reminder[1]] : null;
  if (supplied != null) {
    stageKey(supplied);
    // Trusted server classification may recognize graph-specific follow-ups,
    // but may never relabel a timeout as a normal second reminder.
    if (inferred && supplied !== inferred) fail('stage_changed');
    return supplied;
  }
  return inferred;
}
function everAttempted(message) {
  const m = object(message?.metadata);
  return ['sending', 'sent', 'delivered', 'read'].includes(message?.status) || !!message?.sent_at
    || ['wamid', 'wa_response', 'provider_acceptance_at', 'delivery_unknown', 'outcome_unknown',
      'network_started_at', 'appointment_day_network_started_at'].some(key => m[key] != null && m[key] !== false);
}
function claims(value) {
  let rows = value;
  if (typeof rows === 'string') { try { rows = JSON.parse(rows); } catch { fail('ledger_corrupt'); } }
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) fail('ledger_corrupt');
  if (Object.keys(rows).some(key => !STAGES.includes(key))) fail('ledger_corrupt');
  for (const row of Object.values(rows)) {
    if (!id(row?.execution_id) || !id(row?.appointment_id) || !row.claimed_at || typeof row.attempted !== 'boolean'
      || row.message_id != null && !id(row.message_id)) fail('ledger_corrupt');
    instant(row.claimed_at);
  }
  return JSON.parse(JSON.stringify(rows));
}
module.exports = { SCHEMA, STAGES, id, object, fail, instant, dayScope, sequenceKey, stageKey,
  placeholder, selectAnchor, executionStage, messageStage, everAttempted, claims };
