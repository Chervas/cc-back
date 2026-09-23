'use strict';

const { importReviewVersion } = require('./appointment-import-review');
const { normalizeBookingProfile } = require('./booking-profile');

const fail = () => {
  const error = new Error('La asignación documental necesita una cita importada abierta, sin cambios y con recursos completos.');
  error.code = 'booking_import_equipment_invalid';
  error.status = error.statusCode = 409;
  throw error;
};

// Operator-only input. Never accepts an arbitrary profile, duration, resource
// alternative or clinical decision. Source evidence is validated by the caller
// against its immutable import package; the command validates the locked row.
function importedEquipmentProfile(appointment, assignment) {
  let metadata = appointment?.import_metadata;
  if (typeof metadata === 'string') { try { metadata = JSON.parse(metadata); } catch { fail(); } }
  if (!appointment || !assignment || typeof assignment !== 'object' || Array.isArray(assignment)
    || Object.keys(assignment).some(key => !['equipment_ids', 'expected_version', 'source_sha256'].includes(key))
    || !/^[a-f0-9]{64}$/.test(assignment.expected_version || '')
    || !/^[a-f0-9]{64}$/.test(assignment.source_sha256 || '')
    || assignment.expected_version !== importReviewVersion(appointment)
    || appointment.source_system !== 'cliniccloud' || !appointment.source_reference
    || !['pendiente', 'info_enviada', 'info_confirmada', 'recordatorio_enviado', 'recordatorio_confirmado', 'cambio_solicitado'].includes(appointment.estado)
    || appointment.voucher_id || appointment.lead_intake_id || appointment.es_provisional || appointment.hold_expires_at
    || !metadata || typeof metadata !== 'object' || Array.isArray(metadata)
    || ['booking', 'program_session', 'additional_staff'].some(key => metadata[key] != null)
    || !['id_cita', 'paciente_id', 'clinica_id', 'doctor_id', 'instalacion_id', 'tratamiento_id']
      .every(key => Number.isSafeInteger(Number(appointment[key])) && Number(appointment[key]) > 0)
    || !['appointment_details', 'day_before', 'same_day'].every(key => metadata.notification_suppression?.[key] === true)) fail();
  const ids = assignment.equipment_ids;
  if (!Array.isArray(ids) || !ids.length || ids.length > 8
    || ids.some(id => !Number.isSafeInteger(id) || id < 1) || new Set(ids).size !== ids.length) fail();
  const duration = (new Date(appointment.fin) - new Date(appointment.inicio)) / 60000;
  if (!Number.isInteger(duration) || duration < 1 || duration > 1440) fail();
  return normalizeBookingProfile({ version: 2, phases: [{
    key: 'appointment', label: '', duration_minutes: duration,
    installation_ids: [Number(appointment.instalacion_id)],
    professionals: { mode: 'any', ids: [Number(appointment.doctor_id)], preferred_id: Number(appointment.doctor_id) },
    equipment_requirements: [...ids].sort((a, b) => a - b).map(id => ({ equipment_ids: [id] })),
  }] });
}

module.exports = { importedEquipmentProfile };
