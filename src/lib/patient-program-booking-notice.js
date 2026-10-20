'use strict';

// Preparation only. This module has no models, environment switches, provider
// clients, jobs or installation side effects. A successful reservation is NOT
// evidence of a WhatsApp send. Do not relax the programme/patient HOLD to use it.
const { createHash } = require('node:crypto');

const EVENT = 'patient.program_appointments_booked';
const SCHEMA = 'patient-program-booking-notice/v1';
const FAMILY = 'patient_program_appointments_booked_v1';
const TEMPLATE = 'clinicaclick_citas_programa_reservadas';
const TITLE = 'Confirmación de citas de programa';
const MAX_APPOINTMENTS = 30;
// Conservative complete-rendered-body budget, not only the template definition.
const MAX_BODY_CHARACTERS = 1024;
const BODIES = Object.freeze({
  es: 'Hola, somos {{1}}. Hemos reservado {{2}} citas de tu programa. Fechas y horas de la clínica: {{3}}. Para solicitar un cambio, responde a este mensaje.',
  ca: 'Hola, som {{1}}. Hem reservat {{2}} cites del teu programa. Dates i hores de la clínica: {{3}}. Per demanar un canvi, respon a aquest missatge.',
  en: 'Hello, this is {{1}}. We have booked {{2}} appointments for your programme. Dates and times at the clinic: {{3}}. To request a change, reply to this message.',
});
const BLOCKERS = Object.freeze([
  'booking_transaction_hook_not_installed',
  'v2_program_trigger_not_registered',
  'program_operational_authorization_not_enabled',
  'sender_utility_approval_not_verified',
]);
const positiveId = value => ['string', 'number'].includes(typeof value)
  && /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
const object = value => {
  if (value?.toJSON) value = value.toJSON();
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
};
const error = code => { throw Object.assign(new Error(code), { code, retryable: false }); };
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object'
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const isHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function singleLine(value, max, code) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max
    || /[\u0000-\u001f\u007f\u2028\u2029]| {5}|\{\{|\}\}/u.test(value)) error(code);
  return value.trim().normalize('NFC');
}

function language(value) {
  if (typeof value !== 'string') error('program_notice_language_required');
  const locale = value.trim().replace('_', '-').toLowerCase();
  const code = locale.split('-')[0];
  if (!Object.hasOwn(BODIES, code) || !/^(es|ca|en)(?:-[a-z]{2})?$/.test(locale)) error('program_notice_language_unsupported');
  return code;
}

function instant(value, code) {
  if (value instanceof Date && Number.isFinite(+value)) return value.toISOString();
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value)
    || !Number.isFinite(Date.parse(value))) error(code);
  const normalized = new Date(value).toISOString();
  if (normalized.replace('.000Z', 'Z') !== value.replace('.000Z', 'Z')) error(code);
  return normalized;
}

function clinicTimeZone(value) {
  if (typeof value !== 'string' || !value || value !== value.trim()) error('program_notice_timezone_required');
  try { return new Intl.DateTimeFormat('en', { timeZone: value }).resolvedOptions().timeZone; }
  catch { return error('program_notice_timezone_invalid'); }
}

function localTime(value, timeZone) {
  const values = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  return { date: `${values.day}/${values.month}/${values.year}`, time: `${values.hour}:${values.minute}` };
}

function messagePreview({ clinic_name: clinicName, language: locale, appointments, program_session_count: total }) {
  const list = appointments.map(row => `${row.number}/${total}) ${row.local_date} ${row.local_time}`).join('; ');
  // Variables deliberately contain no line breaks/tabs and no long whitespace
  // runs; never interpolate a multiline list or silently truncate appointments.
  const parameters = [clinicName, String(appointments.length), list];
  for (const parameter of parameters) singleLine(parameter, MAX_BODY_CHARACTERS, 'program_notice_parameter_invalid');
  const body = BODIES[locale].replace(/\{\{([123])\}\}/g, (_, index) => parameters[Number(index) - 1]);
  if (body.length > MAX_BODY_CHARACTERS) error('program_notice_body_too_long');
  return { language: locale, template_name: TEMPLATE, parameters, body, body_characters: body.length };
}

/**
 * Derive a minimal immutable snapshot from a SERVER receipt and its purchase.
 * Not a request-body parser or transport permission. Numbering is the original
 * programme position, so selecting sessions 3 and 7 never becomes "1 and 2".
 */
function prepareCommittedBooking({ receipt: rawReceipt, voucher: rawVoucher, snapshot: rawSnapshot,
  clinic: rawClinic, actorId, timeZone, communicationLanguage, occurredAt } = {}) {
  const receipt = object(rawReceipt), voucher = object(rawVoucher), snapshot = object(rawSnapshot), clinic = object(rawClinic);
  const receiptId = positiveId(receipt.id), voucherId = positiveId(voucher.id), clinicId = positiveId(voucher.clinic_id);
  const patientId = positiveId(voucher.patient_id), actor = positiveId(actorId);
  if (!receiptId || !voucherId || !clinicId || !patientId || !actor
    || positiveId(receipt.voucher_id) !== voucherId || positiveId(clinic.id_clinica) !== clinicId
    || positiveId(receipt.created_by) !== actor || voucher.source_system !== 'treatment_program') error('program_notice_scope_invalid');
  if (!/^[a-zA-Z0-9_-]{8,80}$/.test(receipt.request_key || '') || !isHash(receipt.request_sha256)
    || !isHash(snapshot.sha256)) error('program_notice_receipt_invalid');
  const result = object(receipt.result);
  if (result.replayed !== false || result.reminders_enabled !== false
    || typeof voucher.public_id !== 'string' || !voucher.public_id || result.voucher_id !== voucher.public_id) error('program_notice_receipt_invalid');
  const definitions = snapshot.appointments;
  if (!Array.isArray(definitions) || !definitions.length || definitions.length > MAX_APPOINTMENTS
    || new Set(definitions.map(row => row?.key)).size !== definitions.length
    || definitions.some(row => typeof row?.key !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(row.key))) error('program_notice_snapshot_invalid');
  if (!Array.isArray(result.sessions) || !result.sessions.length || result.sessions.length > MAX_APPOINTMENTS) error('program_notice_batch_invalid');
  const occurred = instant(occurredAt, 'program_notice_occurrence_invalid');
  const zone = clinicTimeZone(timeZone), locale = language(communicationLanguage);
  const appointments = result.sessions.map(row => {
    const number = definitions.findIndex(definition => definition.key === row?.key) + 1;
    const appointmentId = positiveId(row?.appointment_id);
    if (!number || !appointmentId || !['created', 'rescheduled'].includes(row.action)) error('program_notice_appointment_invalid');
    const start = instant(row.start_at, 'program_notice_appointment_date_invalid');
    const end = instant(row.end_at, 'program_notice_appointment_date_invalid');
    if (Date.parse(start) <= Date.parse(occurred) || Date.parse(end) <= Date.parse(start)) error('program_notice_appointment_date_invalid');
    const local = localTime(start, zone);
    return { number, session_key: row.key, appointment_id: appointmentId, action: row.action,
      start_at: start, end_at: end, local_date: local.date, local_time: local.time };
  }).sort((left, right) => left.number - right.number);
  if (new Set(appointments.map(row => row.appointment_id)).size !== appointments.length
    || new Set(appointments.map(row => row.session_key)).size !== appointments.length
    || appointments.some((row, index) => index && Date.parse(appointments[index - 1].end_at) > Date.parse(row.start_at))) error('program_notice_appointment_order_invalid');
  const payload = {
    schema_version: SCHEMA, booking_receipt_id: receiptId, voucher_id: voucherId, voucher_public_id: voucher.public_id,
    request_key: receipt.request_key, request_sha256: receipt.request_sha256,
    program_snapshot_sha256: snapshot.sha256, patient_id: patientId, clinic_id: clinicId, actor_user_id: actor,
    clinic_name: singleLine(clinic.nombre_clinica, 80, 'program_notice_clinic_name_invalid'),
    timezone: zone, language: locale, program_session_count: definitions.length,
    appointment_count: appointments.length, occurred_at: occurred, appointments,
  };
  payload.snapshot_sha256 = hash(payload);
  return { ...payload, preview: messagePreview(payload), delivery: deliveryReadiness() };
}

function eventPreparation(input) {
  const payload = prepareCommittedBooking(input);
  return { event_type: EVENT, patient_id: payload.patient_id, clinic_id: payload.clinic_id,
    actor_user_id: payload.actor_user_id, source: 'agenda', channel: null, occurred_at: payload.occurred_at,
    metadata: payload,
    // The future producer must persist this event beside its receipt, then use
    // the existing durable outbox. Never create N appointment_created events.
    execution_idempotency_key: `${EVENT}:${payload.clinic_id}:${payload.booking_receipt_id}`,
    message_idempotency_key: `program-booking-notice:${payload.clinic_id}:${payload.booking_receipt_id}:outbound` };
}

function deliveryReadiness() {
  return { can_send: false, status: 'not_available', blockers: [...BLOCKERS],
    hold_unchanged: true, requested: false, sent: false };
}

/** Non-installed catalogue/graph proposal. No IDs are invented as approvals. */
function catalogPreparation(communicationLanguage = 'es') {
  const locale = language(communicationLanguage);
  return {
    preparation_only: true, can_install: false, blockers: [...BLOCKERS],
    whatsapp: { name: TEMPLATE, display_name: TITLE, family_key: TEMPLATE, locale, category: 'UTILITY',
      is_active: false, propagation_state: 'prepared',
      variables: [{ position: 1, name: 'clinica_nombre', description: 'Nombre de la clínica de la reserva' },
        { position: 2, name: 'numero_citas', description: 'Citas confirmadas por este recibo, no todas las unidades del programa' },
        { position: 3, name: 'citas_programa', description: 'Número de sesión/total, dd/mm/aaaa HH:mm; lista de una sola línea' }],
      components: [{ type: 'BODY', text: BODIES[locale],
        example: { body_text: [['Clínica de ejemplo', '2', '1/10) 04/11/2026 09:00; 2/10) 19/11/2026 09:00']] } }] },
    flow: { template_key: FAMILY, name: TITLE, version: 1, engine_version: 'v2',
      trigger_type: EVENT, trigger_config: { configured: false, enabled_after: null },
      clinic_id: null, group_id: null, is_system: true, is_active: false, published_at: null, entry_node_id: 'N1',
      nodes: [
        { id: 'N1', type: `trigger/${EVENT}`, config: { enabled_after: null }, outputs: { on_success: 'N2' }, position: { x: 0, y: 0 } },
        { id: 'N2', type: 'action/send_whatsapp', config: { message_mode: 'template', template_name: TEMPLATE,
          language_code: locale, recipient_mode: 'context_patient', sender_mode: 'clinic_default',
          communication_scope: 'care', quiet_hours_enabled: true, outside_send_window_policy: 'schedule_next_window',
          variables: { 1: '{{trigger.data.program_booking_notice.clinic_name}}',
            2: '{{trigger.data.program_booking_notice.preview.parameters.1}}',
            3: '{{trigger.data.program_booking_notice.preview.parameters.2}}' } },
        outputs: { on_success: 'N4', on_fail: 'N3' }, position: { x: 0, y: 250 } },
        { id: 'N3', type: 'action/send_system_notification', config: { title: 'Revisar aviso de citas de programa',
          message: 'Las citas están reservadas, pero no se ha podido confirmar el envío del resumen al paciente.',
          assignee_type: 'role', assignee_id: 'recepcion', subrole: 'recepcion', display_mode: 'persistent_alert', alert_level: 'warning' },
        outputs: { on_success: 'N4' }, position: { x: 450, y: 500 } },
        { id: 'N4', type: 'control/end', config: {}, outputs: {}, position: { x: 0, y: 750 } },
      ] },
  };
}

module.exports = { EVENT, SCHEMA, FAMILY, TEMPLATE, TITLE, MAX_APPOINTMENTS, MAX_BODY_CHARACTERS,
  BODIES, BLOCKERS, prepareCommittedBooking, eventPreparation, catalogPreparation, deliveryReadiness };
