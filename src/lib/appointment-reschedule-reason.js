'use strict';

const ADMINISTRATIVE_ERROR = 'administrative_error';
const RESCHEDULE_REASONS = Object.freeze(['patient_request', 'clinic_schedule', ADMINISTRATIVE_ERROR]);

function isSilentReschedule(context, execution = null) {
  const trigger = execution?.trigger_type || context?.trigger?.type;
  const reason = context?.trigger?.data?.reschedule_reason || context?.appointment?.reschedule_reason || context?.cita?.reschedule_reason;
  return trigger === 'appointment_rescheduled' && reason === ADMINISTRATIVE_ERROR;
}

function statusForReschedule(reason, requestedStatus, currentStatus) {
  // Correcting the reservation does not revoke the patient's attendance
  // confirmation. Only the persisted current state is evidence of that
  // confirmation: a requested status alone must not manufacture one.
  return reason === ADMINISTRATIVE_ERROR
    ? currentStatus === 'recordatorio_confirmado' ? currentStatus : 'info_confirmada'
    : requestedStatus || 'reprogramada';
}

function sameAppointmentTime(previous, next) {
  const range = value => [value?.inicio, value?.fin].map(item => item == null ? NaN : new Date(item).getTime());
  const a = range(previous), b = range(next);
  return [...a, ...b].every(Number.isFinite) && a[1] > a[0] && b[1] > b[0]
    && a[0] === b[0] && a[1] === b[1];
}

function preserveUnchangedReservation(previous, values) {
  if (!RESCHEDULE_REASONS.includes(values.reschedule_reason) || !sameAppointmentTime(previous, values)) return values;
  return { ...values, estado: previous.estado, reschedule_reason: previous.reschedule_reason ?? null };
}

module.exports = { ADMINISTRATIVE_ERROR, RESCHEDULE_REASONS, isSilentReschedule, statusForReschedule,
  sameAppointmentTime, preserveUnchangedReservation };
