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
  return { source: 'cliniccloud', reminders_held: true,
    pending_assignment: Object.keys(fields).filter(key => Array.isArray(pending) && pending.includes(key)
      && !appointment[columns[key]]).map(key => fields[key]) };
}
module.exports = { appointmentImportReview };
