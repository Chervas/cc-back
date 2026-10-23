'use strict';

const { programAppointmentContext } = require('../lib/program-appointment-context');
const { loadScopedTreatment } = require('./treatmentBookingProfile.service');

// Resolve only a deliberately selected appointment, after the caller has checked
// patient/sensitive/Nutrition access to this clinic. Never scan the diary or
// interpret an imported booking JSON as proof of a purchased program.
function createNutritionAppointmentContextResolver({ db }) {
  return async function resolve({ patient, clinic, appointmentId }) {
    if (!['string', 'number'].includes(typeof appointmentId)
      || !/^[1-9]\d*$/.test(String(appointmentId)) || !Number.isSafeInteger(Number(appointmentId))) {
      throw Object.assign(new Error('Revisa la cita seleccionada.'), { status: 400, code: 'nutrition_appointment_id_invalid' });
    }
    const appointment = await db.CitaPaciente.findOne({
      where: { id_cita: Number(appointmentId), paciente_id: Number(patient.id_paciente), clinica_id: Number(clinic.id_clinica) },
      attributes: ['id_cita', 'paciente_id', 'clinica_id', 'tratamiento_id', 'voucher_id', 'import_metadata'],
    });
    if (!appointment) {
      throw Object.assign(new Error('La cita no está disponible en esta ficha y clínica.'), { status: 404, code: 'nutrition_appointment_not_found' });
    }
    const candidates = [appointment.tratamiento_id];
    if (appointment.voucher_id) {
      let snapshot;
      try { snapshot = await programAppointmentContext(db, appointment); }
      catch (error) { if (error.code !== 'program_session_not_found') throw error; }
      if (Array.isArray(snapshot?.treatments)) candidates.push(...snapshot.treatments.map(item => item.id));
    }
    const ids = [...new Set(candidates.map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
    const nutritionTreatments = [];
    for (const treatmentId of ids) {
      let treatment;
      try { treatment = await loadScopedTreatment({ db, treatmentId, clinic }); }
      catch (error) { if (error.code !== 'treatment_not_found') throw error; }
      // The create resolver permits an inactive service for its existing
      // appointment. Preserve that evidence without offering it for new care.
      if (treatment?.disciplina === 'nutricion') nutritionTreatments.push(treatment);
    }
    return {
      measurement_context: { appointment_id: Number(appointment.id_cita), nutrition_treatment_ids: nutritionTreatments.map(treatment => Number(treatment.id_tratamiento)).sort((a, b) => a - b) },
      treatments: nutritionTreatments,
    };
  };
}

module.exports = { createNutritionAppointmentContextResolver };
