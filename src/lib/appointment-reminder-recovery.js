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
function runtimeEnvironment(env) {
  // Do not turn off JOBS_WORKER_ENABLED: it is part of the staging send
  // authority, even in an operator that never starts the scheduler itself.
  require('./whatsappBrokerClient').assertStaging(env);
  return { ...env, JOBS_CRON_LEADER: 'false', APPOINTMENT_AUTOMATION_FIRE_GRACE_MS: String(86400000) };
}
function preflightArtifact(message, execution) {
  const m = message?.metadata || {};
  const forbidden = ['wamid', 'wa_response', 'provider_message_id', 'providerMessageId', 'provider_acceptance_at',
    'delivery_unknown', 'outcome_unknown', 'dispatch_wait', 'network_started_at', 'post_acceptance_error',
    'automation_transport_job_id', 'template_components', 'template_params'];
  return message?.status === 'failed' && message.direction === 'outbound' && message.message_type === 'template'
    && execution?.status === 'failed' && execution.last_error === 'whatsapp_broker_runtime_denied'
    && m.error === execution.last_error && m.failure_source === 'automation_send_whatsapp_preflight'
    && m.source === 'automations_v2' && Number(m.execution_id) === Number(execution.id)
    && typeof m.node_id === 'string' && typeof message.automation_delivery_key === 'string'
    && !message.sent_at && forbidden.every(key => m[key] == null || m[key] === false);
}
module.exports = { validate, hash, instant, localDay, runtimeEnvironment, preflightArtifact };
