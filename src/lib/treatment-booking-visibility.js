'use strict';

// Absence means the existing catalogue behaviour. Removing this one key does
// not change active/status, commercial eligibility, or purchased snapshots.
function normalizeBookingVisibility(value) {
  if (value !== 'continuation_only') throw Object.assign(new Error('Visibilidad de reserva no válida.'), {
    code: 'booking_visibility_invalid', status: 422, statusCode: 422,
  });
  return value;
}

function bookingVisibility(treatment) {
  let config = treatment?.clinical_config;
  if (typeof config === 'string') {
    try { config = JSON.parse(config); } catch { throw Object.assign(new Error('La configuración del tratamiento no es válida.'), {
      code: 'booking_visibility_invalid', status: 422, statusCode: 422,
    }); }
  }
  return config && Object.hasOwn(config, 'booking_visibility') ? normalizeBookingVisibility(config.booking_visibility) : null;
}

function initiatedTreatmentWhere(Op, { clinicId, patientId, treatmentId, ignoreAppointmentId, now = new Date() } = {}) {
  return { clinica_id: clinicId, paciente_id: patientId,
    tratamiento_id: treatmentId ?? { [Op.ne]: null }, estado: { [Op.notIn]: ['cancelada', 'no_asistio'] },
    [Op.or]: [{ estado: 'completada', fin: { [Op.lte]: now } }, { care_started_at: { [Op.ne]: null, [Op.lte]: now } }],
    ...(ignoreAppointmentId ? { id_cita: { [Op.ne]: ignoreAppointmentId } } : {}),
  };
}

module.exports = { normalizeBookingVisibility, bookingVisibility, initiatedTreatmentWhere };
