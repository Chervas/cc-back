'use strict';

const C = require('../lib/clinical-episode-contract');
const FIELDS = ['alergias', 'medicacion', 'antecedentes', 'notas_medicas'];

function createPatientClinicalReferenceService({ db, canAccess } = {}) {
  const denied = () => C.error(403, 'access_policy_forbidden', 'No tienes permisos para actualizar estos datos clínicos.');
  async function permissions(actorId, clinicId, writing = true) {
    const checks = await Promise.all(['patients.view', 'patients.sensitive.view', ...(writing ? ['patients.edit'] : ['clinical.reports.view'])]
      .map(featureKey => canAccess({ actorId, clinicId, featureKey })));
    if (checks.some(allowed => !allowed)) throw denied();
  }
  const item = (patient, clinicId) => ({ patient_id: Number(patient.id_paciente), clinic_id: clinicId,
    ...Object.fromEntries(FIELDS.map(field => [field, patient[field] ?? null])) });
  function values(payload) {
    const invalid = () => C.error(400, 'clinical_reference_invalid_payload', 'Revisa los datos clínicos.');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw invalid();
    let changes, expected;
    if (Object.hasOwn(payload, 'medicacion') || Object.hasOwn(payload, 'expected_medication')) {
      if (Object.keys(payload).some(key => !['medicacion', 'expected_medication'].includes(key))) throw invalid();
      if (!Object.hasOwn(payload, 'expected_medication')) throw C.error(428, 'clinical_reference_version_required', 'Vuelve a cargar los datos antes de guardar.');
      changes = { medicacion: payload.medicacion }; expected = { medicacion: payload.expected_medication };
    } else {
      if (Object.keys(payload).some(key => !['changes', 'expected_values'].includes(key))) throw invalid();
      if (!Object.hasOwn(payload, 'expected_values')) throw C.error(428, 'clinical_reference_version_required', 'Vuelve a cargar los datos antes de guardar.');
      changes = payload.changes; expected = payload.expected_values;
      if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !expected || typeof expected !== 'object' || Array.isArray(expected)
        || !Object.keys(changes).length || Object.keys(changes).some(key => !FIELDS.includes(key))
        || Object.keys(expected).length !== Object.keys(changes).length) throw invalid();
    }
    for (const field of Object.keys(changes)) for (const group of [changes, expected]) {
      if (!Object.hasOwn(group, field) || group[field] !== null && (typeof group[field] !== 'string'
        || group[field].includes('\u0000') || Buffer.byteLength(group[field], 'utf8') > 65535
        || field === 'notas_medicas' && group[field].length > 16000)) throw invalid();
    }
    return { changes, expected };
  }
  async function read({ patientIdentifier, clinicId, actorId }) {
    if (!actorId) throw C.error(401, 'unauthenticated', 'Usuario no autenticado.');
    actorId = C.integer(actorId, 'actor_id'); clinicId = C.integer(clinicId, 'clinic_id'); await permissions(actorId, clinicId, false);
    const identifier = String(patientIdentifier || '');
    if (!identifier || identifier.length > 80) throw C.error(400, 'clinical_reference_patient_invalid', 'Selecciona un paciente válido.');
    const patient = await db.Paciente.findOne({ where: /^[1-9]\d*$/.test(identifier) ? { id_paciente: C.integer(identifier) } : { public_id: identifier } });
    const member = patient && (Number(patient.clinica_id) === clinicId || await db.PacienteClinica.findOne({ where: { paciente_id: patient.id_paciente, clinica_id: clinicId }, attributes: ['id'] }));
    if (!member) throw C.error(404, 'clinical_reference_patient_not_found', 'Paciente no encontrado en esta clínica.');
    return { item: item(patient, clinicId) };
  }
  async function applyInTransaction({ patientIdentifier, clinicId, actorId, payload, transaction }) {
    if(!transaction)throw C.error(500,'clinical_reference_transaction_required','No se pudo guardar la referencia clínica.');
    if (!actorId) throw C.error(401, 'unauthenticated', 'Usuario no autenticado.');
    actorId = C.integer(actorId, 'actor_id'); clinicId = C.integer(clinicId, 'clinic_id');
    const data = values(payload), identifier = String(patientIdentifier || '');
    if (!identifier || identifier.length > 80) throw C.error(400, 'clinical_reference_patient_invalid', 'Selecciona un paciente válido.');
    await permissions(actorId, clinicId);
      const patient = await db.Paciente.findOne({ where: /^[1-9]\d*$/.test(identifier)
        ? { id_paciente: C.integer(identifier, 'patient_id') } : { public_id: identifier },
      transaction, lock: transaction.LOCK.UPDATE });
      const member = patient && (Number(patient.clinica_id) === clinicId || await db.PacienteClinica.findOne({
        where: { paciente_id: patient.id_paciente, clinica_id: clinicId }, attributes: ['id'], transaction }));
      if (!member) throw C.error(404, 'clinical_reference_patient_not_found', 'Paciente no encontrado en esta clínica.');
      // The field belongs to the patient record. An active member clinic cannot
      // bypass the owning clinic's existing patient-edit policy.
      if (Number(patient.clinica_id) !== clinicId) await permissions(actorId, Number(patient.clinica_id));
      const fields = Object.keys(data.changes);
      for (const field of fields) if ((patient[field] ?? null) !== data.expected[field]) {
        throw C.error(409, 'clinical_reference_conflict', 'Los datos clínicos han cambiado. Tu texto se conserva; consulta los valores actuales antes de guardar.');
      }
      const updated = fields.some(field => (patient[field] ?? null) !== data.changes[field]);
      const previous=Object.fromEntries(fields.map(field=>[field,patient[field]??null]));
      if (updated) await patient.update(data.changes, { transaction, fields });
      return { item: item(patient, clinicId), updated, previous };
  }
  async function update(input) {
    const {item,updated}=await db.sequelize.transaction(transaction=>applyInTransaction({...input,transaction}));
    return{item,updated};
  }
  return { update, read, applyInTransaction };
}

let service;
module.exports = { createPatientClinicalReferenceService, ...Object.fromEntries(['update', 'read'].map(method => [method, input => {
  service ||= createPatientClinicalReferenceService({ db: require('../../models'),
    canAccess: input => require('../lib/access-policy').canUserAccessFeature(input) });
  return service[method](input);
}])) };
