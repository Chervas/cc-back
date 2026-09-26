'use strict';

const { loadScopedTreatment } = require('./treatmentBookingProfile.service');
const { programAppointmentContext } = require('../lib/program-appointment-context');

function invalid(code, message) {
  return Object.assign(new Error(message), { status: 400, code });
}

function optionalId(value, name) {
  if (value == null || value === '') return null;
  if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) {
    throw invalid(`nutrition_${name}_invalid`, 'Revisa la clínica, la cita y el tratamiento seleccionados.');
  }
  return Number(value);
}

// Use only authoritative relations. Clinic membership is not inferred from a
// common group or phone, and treatment identity is not inferred from its name.
function createNutritionMeasurementContextResolver({ db, assertUserCanAccessFeature }) {
  return async function resolve({ patient, payload = {}, actorUserId, transaction }) {
    const actorId = optionalId(actorUserId, 'actor_id');
    if (!actorId) throw Object.assign(new Error('auth_failed'), { status: 401 });
    const requestedClinicId = optionalId(payload.clinic_id, 'clinic_id');
    const appointmentId = optionalId(payload.appointment_id, 'appointment_id');
    const requestedTreatmentId = optionalId(payload.treatment_id, 'treatment_id');
    const professionalId = optionalId(payload.professional_id, 'professional_id') || actorId;
    const lock = transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {};

    const appointment = appointmentId ? await db.CitaPaciente.findOne({
      where: { id_cita: appointmentId, paciente_id: Number(patient.id_paciente) },
      attributes: ['id_cita', 'paciente_id', 'clinica_id', 'tratamiento_id', 'voucher_id', 'import_metadata'], ...lock,
    }) : null;
    if (appointmentId && !appointment) throw invalid('nutrition_appointment_invalid', 'La cita no pertenece a este paciente. Vuelve a abrirla desde su agenda.');
    const clinicId = requestedClinicId || Number(appointment?.clinica_id || patient.clinica_id);
    if (appointment && Number(appointment.clinica_id) !== clinicId) {
      throw invalid('nutrition_appointment_clinic_mismatch', 'La clínica seleccionada no corresponde a la cita. Vuelve a abrirla desde su agenda.');
    }
    const linked = clinicId === Number(patient.clinica_id) || await db.PacienteClinica.findOne({
      where: { paciente_id: Number(patient.id_paciente), clinica_id: clinicId }, attributes: ['id'], ...lock,
    });
    if (!linked) throw invalid('nutrition_patient_clinic_mismatch', 'El paciente no está vinculado a esta clínica.');
    // The controller's existing patient access gate is retained. Additionally
    // require both capabilities at the actual destination before any write.
    for (const featureKey of ['nutrition.workspace.view', 'nutrition.measurements.create']) {
      await assertUserCanAccessFeature({ actorId, featureKey, clinicId });
    }
    const clinic = await db.Clinica.findByPk(clinicId, { attributes: ['id_clinica', 'grupoClinicaId'], ...lock });
    if (!clinic) throw invalid('nutrition_clinic_invalid', 'La clínica seleccionada no está disponible.');

    const treatmentId = requestedTreatmentId || (appointment?.tratamiento_id ? Number(appointment.tratamiento_id) : null);
    if (appointment && treatmentId && Number(appointment.tratamiento_id) !== treatmentId) {
      // A program may include Nutrition after another treatment in one visit.
      // Its persisted session snapshot, never request/import JSON, proves this.
      let snapshot = null;
      if (appointment.voucher_id) {
        try { snapshot = await programAppointmentContext(db, appointment, transaction); }
        catch (error) { if (error.code !== 'program_session_not_found') throw error; }
      }
      const programTreatmentIds = (snapshot?.treatments || []).map(item => Number(item.id));
      if (!programTreatmentIds.includes(treatmentId)) throw invalid('nutrition_appointment_treatment_mismatch', 'El tratamiento no forma parte de esta cita. Selecciona el tratamiento de la cita o registra una medición independiente.');
    }
    if (treatmentId) {
      let treatment;
      try { treatment = await loadScopedTreatment({ db, treatmentId, clinic, transaction }); }
      catch (error) {
        if (error.code !== 'treatment_not_found') throw error;
        throw invalid('nutrition_treatment_invalid', 'El tratamiento no está disponible en esta clínica.');
      }
      if (treatment.disciplina !== 'nutricion') throw invalid('nutrition_treatment_area_mismatch', 'Selecciona un tratamiento de Nutrición para asociar esta medición.');
      // Existing appointments may retain an obsolete treatment as history.
      if (!appointment && treatment.activo === false) throw invalid('nutrition_treatment_inactive', 'Selecciona un tratamiento activo de Nutrición.');
    }
    if (professionalId !== actorId) {
      const membership = await db.UsuarioClinica.findOne({
        where: { id_usuario: professionalId, id_clinica: clinicId },
        attributes: ['rol_clinica', 'estado_invitacion'], ...lock,
      });
      if (!membership || !['personaldeclinica', 'propietario'].includes(membership.rol_clinica)
        || membership.estado_invitacion !== 'aceptada') {
        throw invalid('nutrition_professional_invalid', 'El profesional no pertenece al personal activo de esta clínica.');
      }
    }
    return { clinic_id: clinicId, appointment_id: appointmentId, treatment_id: treatmentId, professional_id: professionalId };
  };
}

module.exports = { createNutritionMeasurementContextResolver };
