'use strict';

// One-off appointment participants, independent of the treatment's eligibility
// or mandatory team. Only the booking command may author this snapshot.
function normalizeAdditionalStaff(value) {
  if (value === undefined) return undefined; // PATCH omission preserves the team.
  if (!Array.isArray(value) || value.length > 10 || value.some(id =>
    !['number', 'string'].includes(typeof id) || !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    throw Object.assign(new Error('Selecciona hasta diez personas de apoyo válidas.'),
      { code: 'booking_additional_staff_invalid', statusCode: 400 });
  }
  return [...new Set(value.map(Number))].sort((a, b) => a - b);
}

function additionalStaffSnapshot(appointment) {
  let metadata = appointment?.import_metadata;
  if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { return null; } }
  const snapshot = metadata?.additional_staff;
  if (!snapshot || snapshot.version !== 1) return null;
  try {
    const ids = normalizeAdditionalStaff(snapshot.ids);
    if (!ids?.length || ids.length !== snapshot.ids.length || ids.some((id, i) => id !== snapshot.ids[i])
      || !Array.isArray(snapshot.names) || snapshot.names.length !== ids.length
      || snapshot.names.some(name => typeof name !== 'string')
      || !Number.isFinite(new Date(appointment.inicio).getTime())
      || new Date(appointment.fin) <= new Date(appointment.inicio)
      || new Date(snapshot.start_at).getTime() !== new Date(appointment.inicio).getTime()
      || new Date(snapshot.end_at).getTime() !== new Date(appointment.fin).getTime()) return null;
    return snapshot;
  } catch { return null; }
}

function additionalStaffPayload(appointment) {
  const snapshot = additionalStaffSnapshot(appointment);
  return snapshot ? snapshot.ids.map((id, i) => ({ id, name: snapshot.names[i] })) : [];
}

module.exports = { normalizeAdditionalStaff, additionalStaffSnapshot, additionalStaffPayload };
