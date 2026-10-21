'use strict';

const C = require('../lib/clinical-episode-contract');

function createPatientClinicalReferenceService({ db, canAccess } = {}) {
  const denied = () => C.error(403, 'access_policy_forbidden', 'No tienes permisos para actualizar estos datos clínicos.');
  async function permissions(actorId, clinicId) {
    const checks = await Promise.all(['patients.view', 'patients.sensitive.view', 'patients.edit']
      .map(featureKey => canAccess({ actorId, clinicId, featureKey })));
    if (checks.some(allowed => !allowed)) throw denied();
  }
  function values(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.keys(payload).some(key => !['medicacion', 'expected_medication'].includes(key))) {
      throw C.error(400, 'clinical_reference_invalid_payload', 'Revisa los datos de medicación.');
    }
    if (!Object.hasOwn(payload, 'expected_medication')) throw C.error(428, 'clinical_reference_version_required', 'Vuelve a cargar la medicación antes de guardar.');
    for (const field of ['medicacion', 'expected_medication']) {
      if (!Object.hasOwn(payload, field) || payload[field] !== null && (typeof payload[field] !== 'string'
        || payload[field].includes('\u0000') || Buffer.byteLength(payload[field], 'utf8') > 65535)) {
        throw C.error(400, 'clinical_reference_invalid_payload', 'La medicación supera el tamaño admitido o contiene caracteres no válidos.');
      }
    }
    return payload;
  }
  async function update({ patientIdentifier, clinicId, actorId, payload }) {
    if (!actorId) throw C.error(401, 'unauthenticated', 'Usuario no autenticado.');
    actorId = C.integer(actorId, 'actor_id'); clinicId = C.integer(clinicId, 'clinic_id');
    const data = values(payload), identifier = String(patientIdentifier || '');
    if (!identifier || identifier.length > 80) throw C.error(400, 'clinical_reference_patient_invalid', 'Selecciona un paciente válido.');
    await permissions(actorId, clinicId);
    return db.sequelize.transaction(async transaction => {
      const patient = await db.Paciente.findOne({ where: /^[1-9]\d*$/.test(identifier)
        ? { id_paciente: C.integer(identifier, 'patient_id') } : { public_id: identifier },
      transaction, lock: transaction.LOCK.UPDATE });
      const member = patient && (Number(patient.clinica_id) === clinicId || await db.PacienteClinica.findOne({
        where: { paciente_id: patient.id_paciente, clinica_id: clinicId }, attributes: ['id'], transaction }));
      if (!member) throw C.error(404, 'clinical_reference_patient_not_found', 'Paciente no encontrado en esta clínica.');
      // The field belongs to the patient record. An active member clinic cannot
      // bypass the owning clinic's existing patient-edit policy.
      if (Number(patient.clinica_id) !== clinicId) await permissions(actorId, Number(patient.clinica_id));
      const current = patient.medicacion ?? null;
      if (current !== data.expected_medication) throw C.error(409, 'clinical_reference_conflict', 'La medicación ha cambiado. Tu texto se conserva; consulta la versión actual antes de guardar.');
      const updated = current !== data.medicacion;
      if (updated) await patient.update({ medicacion: data.medicacion }, { transaction, fields: ['medicacion'] });
      return { item: { patient_id: Number(patient.id_paciente), clinic_id: clinicId, medicacion: patient.medicacion ?? null }, updated };
    });
  }
  return { update };
}

let service;
module.exports = { createPatientClinicalReferenceService, update: input => {
  service ||= createPatientClinicalReferenceService({ db: require('../../models'),
    canAccess: input => require('../lib/access-policy').canUserAccessFeature(input) });
  return service.update(input);
} };
