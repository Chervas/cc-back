'use strict';

const { error } = require('./patient-intake-questionnaire');
const plain = value => value?.toJSON ? value.toJSON() : value;
const positive = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 ? Number(value) : null;

// Scope is derived only from current server records. There is deliberately no
// caller-controlled "allow linked clinic" switch. Mutating callers supply their
// transaction so the patient, membership and both group anchors remain locked.
async function patientForIntakeClinic({ db, identifier, clinicId: clinicIdRaw, transaction = null, attributes,
  failureCode = 'intake_patient_scope', failureMessage = 'El formulario no pertenece a esta clínica.', failureStatus = 403 }) {
  const clinicId = positive(clinicIdRaw), raw = String(identifier ?? '').trim();
  const deny = () => { throw error(failureCode, failureMessage, failureStatus); };
  if (!clinicId) throw error('clinic_scope_required', 'Selecciona una clínica.');
  if (!raw || raw.length > 128) return deny();
  const options = { ...(attributes ? { attributes } : {}), ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) };
  let patient;
  if (/^\d+$/.test(raw)) {
    const id = positive(raw); if (!id) return deny();
    patient = await db.Paciente.findByPk(id, options);
  } else patient = await db.Paciente.findOne({ where: { public_id: raw }, ...options });
  if (!patient) return deny();
  const row = plain(patient), primaryClinicId = positive(row.clinica_id);
  if (!primaryClinicId) return deny();
  if (primaryClinicId === clinicId) return patient;
  const patientId = positive(row.id_paciente);
  if (!patientId || !db.PacienteClinica || !db.Clinica) return deny();
  const shared = transaction ? { transaction, lock: transaction.LOCK.SHARE || transaction.LOCK.UPDATE } : {};
  const membership = plain(await db.PacienteClinica.findOne({ where: { paciente_id: patientId, clinica_id: clinicId },
    attributes: ['id', 'paciente_id', 'clinica_id'], ...shared }));
  if (!membership || Number(membership.paciente_id) !== patientId || Number(membership.clinica_id) !== clinicId) return deny();
  // Stable ordering also prevents two opposite group-clinic flows from taking
  // the same clinic locks in opposite order.
  const clinics = new Map();
  for (const id of [primaryClinicId, clinicId].sort((a, b) => a - b)) {
    const clinic = plain(await db.Clinica.findByPk(id, { attributes: ['id_clinica', 'grupoClinicaId'], ...shared }));
    if (!clinic || Number(clinic.id_clinica) !== id) return deny();
    clinics.set(id, clinic);
  }
  const group = positive(clinics.get(primaryClinicId).grupoClinicaId);
  if (!group || positive(clinics.get(clinicId).grupoClinicaId) !== group) return deny();
  return patient;
}

module.exports = { patientForIntakeClinic };
