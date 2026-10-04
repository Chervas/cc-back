'use strict';
const { domainError } = require('./treatmentPrograms.contract');
const object = value => {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return {}; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
};
// A reference only selects the canonical lookup/closed feature gate. It is not
// proof of a purchase: imported appointments keep their original source.
function hasProgramAppointmentReference(appointment) {
  const value = appointment?.toJSON ? appointment.toJSON() : appointment;
  return value?.source_system === 'treatment_program'
    || Object.hasOwn(object(value?.import_metadata), 'program_session');
}
// Historical cancelled appointments still point to their immutable purchased
// unit after rebooking. Validate voucher ownership; metadata alone is no proof.
async function programAppointmentContext(db, appointment, transaction = null) {
  if (!Number.isSafeInteger(Number(appointment?.voucher_id)) || Number(appointment.voucher_id) <= 0) {
    throw domainError(409, 'program_session_not_found', 'No se encuentra el programa de esta cita.');
  }
  const voucher = await db.PatientVoucher.findOne({ where: { id: appointment.voucher_id, clinic_id: appointment.clinica_id,
    patient_id: appointment.paciente_id, source_system: 'treatment_program' }, transaction });
  if (!voucher) throw domainError(409, 'program_session_not_found', 'No se encuentra el programa de esta cita.');
  let session = await db.PatientProgramSession.findOne({ where: { voucher_id: voucher.id, appointment_id: appointment.id_cita }, transaction });
  const reference = object(appointment.import_metadata).program_session;
  if (!session && /^[1-9]\d*$/.test(String(reference?.session_id))) session = await db.PatientProgramSession.findOne({
    where: { id: reference.session_id, voucher_id: voucher.id, session_key: reference.key }, transaction });
  if (!session) throw domainError(409, 'program_session_not_found', 'No se encuentra la composición comprada de esta cita.');
  return object(session.snapshot);
}
function programTreatmentDoctorIds(snapshot, appointment, treatmentId) {
  if (snapshot.linked_appointment && snapshot.treatment_ids?.length === 1 && Number(snapshot.treatment_ids[0]) === Number(treatmentId)) {
    const bookedDoctors = object(appointment.import_metadata).booking?.phases?.flatMap(row => row.doctor_ids || []) || [];
    return [...new Set((bookedDoctors.length ? bookedDoctors : [appointment.doctor_id]).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
  }
  const keys = new Set((snapshot.phase_treatments || []).filter(row => Number(row.treatment_id) === Number(treatmentId)).map(row => row.key));
  return [...new Set((object(appointment.import_metadata).booking?.phases || []).filter(row => keys.has(row.key)).flatMap(row => row.doctor_ids || []).map(Number).filter(id => Number.isSafeInteger(id) && id > 0))];
}
module.exports = { hasProgramAppointmentReference, programAppointmentContext, programTreatmentDoctorIds };
