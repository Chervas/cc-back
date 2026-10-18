'use strict';
const crypto = require('node:crypto');
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const instant = value => new Date(typeof value === 'string' && /^\d{4}-\d\d-\d\d /.test(value)
  ? value.replace(' ', 'T') + 'Z' : value).getTime();
const localDay = value => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Madrid',
  year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);

function validate(row, { day, now = Date.now() }) {
  const fail = code => { throw Error(code); };
  if (localDay(now) !== day || row.status !== 'completed' || row.result_reason !== 'invalid_schedule'
    || row.payload?.__runtime_namespace !== 'staging' || row.payload?.trigger_type !== 'appointment_reminder_window'
    || row.config?.schedule_moment !== 'day_before' || row.active !== 1 || !row.published_at
    || row.payload.template_key !== row.template_key || row.payload.appointment_id !== row.appointment_id) fail('recovery_source_ineligible');
  const due = instant(row.payload.scheduled_for), start = instant(row.start_at);
  if (!Number.isFinite(due) || !Number.isFinite(start) || localDay(due) !== day
    || due > now || now - due >= 86400000 || start <= now || start - now >= 2 * 86400000
    || localDay(start) !== localDay(now + 86400000)) fail('recovery_window_ineligible');
  if (!['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado', 'reprogramada'].includes(row.appointment_state)
    || row.provisional) fail('recovery_appointment_ineligible');
  return { jobId: row.job_id, appointmentId: row.appointment_id, clinicId: row.clinic_id,
    patientId: row.patient_id, templateId: row.template_id, scheduledFor: row.payload.scheduled_for,
    sourceDigest: hash(row) };
}
module.exports = { validate, hash, instant, localDay };
