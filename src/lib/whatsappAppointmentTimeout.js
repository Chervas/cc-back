'use strict';
const { state } = require('./whatsappInboxHealth');
const day = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(value));
// A no-response timeout is a business decision. A transport outage is never
// evidence of silence, and recovering a timer is not permission to replay it.
async function decide({ execution, context, nextNode, snapshot, loadAppointment, hasReply, hasAskedToday, now = Date.now() }) {
  const health = state(snapshot, execution.clinic_id, now);
  if (!health.healthy) return { action: 'wait', reason: health.reason, recovery: true };
  if (!health.readyForTimeout) return { action: 'wait', reason: 'inbox_reception_pending' };
  const appointment = await loadAppointment(execution.trigger_entity_id);
  const start = new Date(appointment?.inicio || '').getTime();
  if (!appointment || Number(appointment.clinica_id) !== Number(execution.clinic_id)
    || start !== new Date(context?.appointment?.inicio || '').getTime()
    || !Number.isFinite(start) || start <= now || appointment.es_provisional
    || !['pendiente','info_enviada','info_confirmada','recordatorio_enviado','reprogramada'].includes(appointment.estado)) {
    return { action: 'stop', reason: 'appointment_no_longer_eligible' };
  }
  const meta = execution.waiting_meta || {};
  const due = new Date(meta.inbox_original_due_at || execution.wait_until || '').getTime();
  const recovery = !!meta.inbox_held_since || now - due > 5 * 60000
    || Number.isFinite(due) && due < Date.parse(health.recoveryNotBefore || '');
  if (await hasReply()) return { action: 'stop', reason: 'reply_already_received' };
  if (!recovery) return { action: 'continue' };
  // Never carry a night-before cancellation or yesterday's reminder forward.
  if (day(start) !== day(now) || nextNode?.type !== 'action/send_whatsapp') return { action: 'stop', reason: 'obsolete_recovery_timeout' };
  if (await hasAskedToday(appointment)) return { action: 'stop', reason: 'appointment_already_asked_today' };
  return { action: 'continue', recovery: { appointmentId: Number(appointment.id_cita), start: new Date(start).toISOString(), day: day(now) } };
}
function deliveryKey(execution) {
  const r = execution?.context?.whatsapp_timeout_recovery;
  if (!r || r.appointmentId !== Number(execution.trigger_entity_id)) return null;
  const digest = require('node:crypto').createHash('sha256').update(r.start).digest('hex').slice(0,24);
  return `appointment:${execution.clinic_id}:${r.appointmentId}:${digest}:recovery:${r.day}`;
}
module.exports = { decide, deliveryKey, day };
