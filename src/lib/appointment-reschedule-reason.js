'use strict';

const ADMINISTRATIVE_ERROR = 'administrative_error';
const RESCHEDULE_REASONS = Object.freeze(['patient_request', 'clinic_schedule', ADMINISTRATIVE_ERROR]);

function isSilentReschedule(context, execution = null) {
  const trigger = execution?.trigger_type || context?.trigger?.type;
  const reason = context?.trigger?.data?.reschedule_reason || context?.appointment?.reschedule_reason || context?.cita?.reschedule_reason;
  return trigger === 'appointment_rescheduled' && reason === ADMINISTRATIVE_ERROR;
}

function statusForReschedule(reason, requestedStatus) {
  return reason === ADMINISTRATIVE_ERROR ? 'info_confirmada' : requestedStatus || 'reprogramada';
}

module.exports = { ADMINISTRATIVE_ERROR, RESCHEDULE_REASONS, isSilentReschedule, statusForReschedule };
