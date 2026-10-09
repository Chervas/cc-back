'use strict';

// Administrative recovery preserves evidenced state and the original booking.
// It is not a reschedule, a new attendance action or communication permission.
const { createHash, timingSafeEqual } = require('node:crypto');
const ACTIVE = new Set(['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado',
  'recordatorio_confirmado', 'reprogramada', 'cambio_solicitado', 'ha_acudido']);
const object = value => {
  if (typeof value === 'string') { try { return JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
};
const plain = value => value?.toJSON ? value.toJSON() : value;
const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
function fail(code, message, statusCode = 409) { throw Object.assign(new Error(message), { code, statusCode }); }
function buildRestorationPlan({ rows, events, actorId, selectedId, link = null, now = new Date() }) {
  if (!Number.isSafeInteger(actorId) || actorId <= 0 || !rows?.length || rows.length > 10
    || !rows.some(row => Number(row.id_cita) === Number(selectedId))) fail('booking_restore_invalid', 'No se puede identificar esta recuperación.', 400);
  const members = rows.map(value => {
    const row = plain(value), care = require('./appointment-care').careState(row);
    if (row.estado !== 'cancelada') fail('booking_restore_not_cancelled', 'Una cita ya no está cancelada. Actualiza la agenda; no se ha recuperado ninguna cita.');
    if (care.legacy_attendance || row.care_started_at || row.care_completed_at || row.es_provisional)
      fail('booking_restore_clinical_history', 'Esta cita conserva atención clínica o una reserva provisional. Revisa su historial antes de recuperarla.');
    const history = events.map(plain).filter(event => Number(object(event.metadata).appointment_id) === Number(row.id_cita)
      && Number(event.clinic_id) === Number(row.clinica_id) && Number(event.patient_id || 0) === Number(row.paciente_id || 0)
      && event.event_type === 'appointment.status_changed')
      .sort((a, b) => +new Date(b.occurred_at) - +new Date(a.occurred_at) || Number(b.id) - Number(a.id));
    const last = history.find(event => object(event.metadata).previous_status !== object(event.metadata).new_status);
    const metadata = object(last?.metadata), status = metadata.previous_status;
    if (metadata.new_status !== 'cancelada' || !ACTIVE.has(status)) fail('booking_restore_history_required',
      'No hay un estado anterior seguro registrado para esta cancelación. Revisa el historial; no se inventará una confirmación.');
    if (status === 'ha_acudido' && (!care.arrived_at || !Number.isFinite(+new Date(care.arrived_at))
      || +new Date(care.arrived_at) > +now || !Number.isFinite(+new Date(row.inicio)) || +new Date(row.inicio) > +now)
      || status !== 'ha_acudido' && care.arrived_at)
      fail('booking_restore_clinical_history', 'El estado anterior no coincide con la llegada registrada. Revisa la atención antes de recuperar la cita.');
    return { appointment_id: Number(row.id_cita), previous_status: status, cancellation_event_id: String(last.id),
      cancellation_event_sha256: hash(last), appointment_sha256: hash(row) };
  });
  const value = { schema: 'appointment-restoration/1', actor_id: actorId, selected_id: Number(selectedId),
    clinic_id: Number(rows[0].clinica_id), patient_id: Number(rows[0].paciente_id || 0),
    link: link ? { id: String(link.id), revision: Number(link.revision), owner_appointment_id: Number(link.owner_appointment_id) } : null,
    members };
  return { ...value, acknowledgement: hash(value) };
}
function assertRestorationAcknowledgement(plan, supplied) {
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied)
    || !timingSafeEqual(Buffer.from(supplied, 'hex'), Buffer.from(plan.acknowledgement, 'hex')))
    fail('booking_restore_changed', 'La cita o su historial han cambiado. Vuelve a abrir «Recuperar cita» antes de confirmar.');
}
function preview(plan) {
  return { can_restore: true, previous_status: plan.members.find(row => row.appointment_id === plan.selected_id).previous_status,
    appointment_ids: plan.members.map(row => row.appointment_id), count: plan.members.length,
    members: plan.members.map(({ appointment_id, previous_status }) => ({ appointment_id, previous_status })),
    restoration_acknowledgement: plan.acknowledgement, communications_suppressed: true,
    message: 'Se recuperará el estado anterior registrado, en el mismo horario y con los mismos recursos. No se enviarán WhatsApps ni se reactivarán avisos cancelados.' };
}
module.exports = { ACTIVE, object, hash, buildRestorationPlan, assertRestorationAcknowledgement, preview };
