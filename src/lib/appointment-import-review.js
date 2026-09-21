'use strict';

// Small server-owned operational summary. Never expose import evidence, patient
// identity snapshots or raw source notes through the calendar's lightweight DTO.
function appointmentImportReview(appointment) {
  if (appointment.source_system !== 'cliniccloud') return null;
  let metadata = appointment.import_metadata;
  if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { metadata = {}; } }
  const pending = metadata?.cliniccloud_delta?.pending_assignment;
  const fields = { doctor_id: 'professional', installation_id: 'installation', treatment_id: 'treatment' };
  const columns = { doctor_id: 'doctor_id', installation_id: 'instalacion_id', treatment_id: 'tratamiento_id' };
  // A documentary room can already be assigned while still inactive. Keep the
  // appointment in the operational review list until the room is enabled; the
  // presence of an ID alone must not make it disappear from the only visible
  // list when inactive rooms have no calendar column. Use the joined room, not
  // import metadata that would remain stale after activation.
  const installationInactive = !!appointment.instalacion_id
    && [false, 0].includes(appointment.instalacion?.activo);
  const pendingAssignment = Object.keys(fields).filter(key => Array.isArray(pending) && pending.includes(key)
    && !appointment[columns[key]]).map(key => fields[key]);
  if (installationInactive && !pendingAssignment.includes('installation')) pendingAssignment.push('installation');
  return { source: 'cliniccloud', reminders_held: true,
    pending_assignment: pendingAssignment,
    ...(installationInactive ? { installation_inactive: true } : {}) };
}
module.exports = { appointmentImportReview };
