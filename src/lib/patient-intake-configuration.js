'use strict';

const { parseConfiguration } = require('./clinic-configuration');
const { error } = require('./patient-intake-questionnaire');

// Existing clinics retain the optional questionnaire until explicitly disabled.
// Never infer this policy from a user's current clinic or the patient's primary.
function medicalQuestionnaireEnabled(configuration) {
  return parseConfiguration(configuration).patient_intake?.medical_questionnaire_enabled !== false;
}

async function clinicMedicalQuestionnaireEnabled({ db, clinicId, transaction, lock = false }) {
  const clinic = await db.Clinica.findByPk(clinicId, {
    attributes: ['id_clinica', 'configuracion'],
    ...(transaction ? { transaction } : {}),
    ...(transaction && lock ? { lock: transaction.LOCK.SHARE || transaction.LOCK.UPDATE } : {}),
  });
  if (!clinic) throw error('clinic_not_found', 'Clínica no encontrada.', 404);
  return medicalQuestionnaireEnabled(clinic.configuracion);
}

async function assertMedicalQuestionnaireEnabled(options) {
  if (!await clinicMedicalQuestionnaireEnabled(options)) {
    throw error('patient_intake_disabled', 'El formulario de datos médicos está desactivado en esta clínica.', 409);
  }
}

module.exports = { medicalQuestionnaireEnabled, clinicMedicalQuestionnaireEnabled, assertMedicalQuestionnaireEnabled };
