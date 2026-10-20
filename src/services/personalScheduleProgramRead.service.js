'use strict';

// Resource-impact readers share the agenda's verified program projection.
// A schedule-management permission alone never grants clinical plan identity.
async function attach({ db, appointments, actorId, accessibleClinics }) {
  const rows = appointments || [];
  if (!rows.length) return rows;
  const plain = row => row?.toJSON ? row.toJSON() : row;
  const set = (row, key, value) => row?.setDataValue ? row.setDataValue(key, value) : (row[key] = value);
  const hasReference = require('../lib/program-appointment-context').hasProgramAppointmentReference;
  const metadata = row => {
    const value = plain(row).import_metadata;
    if (typeof value !== 'string') return value;
    try { return JSON.parse(value); } catch { return null; }
  };
  for (const row of rows) {
    set(row, 'program_context', hasReference(row) ? { kind: 'program', status: 'unavailable' } : null);
    set(row, 'booking_segments', []);
  }
  const candidates = rows.filter(row => hasReference(row) || metadata(row)?.booking);
  if (!candidates.length) return rows;
  const ids = [...new Set(candidates.map(row => Number(plain(row).clinica_id)).filter(Number.isSafeInteger))];
  const allowed = new Set(Number.isSafeInteger(Number(actorId)) && Number(actorId) > 0
    ? (await accessibleClinics({ actorId: Number(actorId), featureKey: 'patients.sensitive.view', clinicIds: ids })).map(Number) : []);
  const visible = rows.filter(row => allowed.has(Number(plain(row).clinica_id)));
  await require('./appointmentProgramRead.service').attachAppointmentProgramContexts(db, visible);
  for (const row of rows) {
    const value = plain(row), authorized = allowed.has(Number(value.clinica_id));
    if (!authorized) set(row, 'program_context', hasReference(row) ? { kind: 'program', status: 'unavailable' } : null);
    set(row, 'booking_segments', authorized ? require('../lib/appointment-booking-segments').bookingSegments(
      { ...value, import_metadata: metadata(row) }, { includeClinicalLabels: false }) : []);
  }
  return rows;
}
module.exports = { attach };
