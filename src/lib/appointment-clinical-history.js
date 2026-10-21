'use strict';
const { Op, fn, col, where } = require('sequelize');

const PRESERVED_CODE = 'appointment_clinical_history_preserved';
const PRESERVED_MESSAGE = 'Esta cita conserva un episodio clínico. Puedes mantenerla cancelada, pero no eliminar su historia.';

/** Read under the reservation lock when deleting: report writers use that lock too. */
async function hasAppointmentClinicalHistory(db, appointmentId, transaction) {
  const query = { where: { appointment_id: appointmentId }, attributes: ['id'], transaction };
  if (db.AppointmentClinicalReport && await db.AppointmentClinicalReport.findOne(query)) return true;
  if (db.ClinicalEpisodeAppointment && await db.ClinicalEpisodeAppointment.findOne({
    ...query, attributes: ['appointment_id'],
  })) return true;
  if(db.DentalPlan&&await db.DentalPlan.findOne({attributes:['id'],transaction,where:where(fn('JSON_CONTAINS',col('state'),JSON.stringify({reservations:[{appointment_id:Number(appointmentId)}]})),1)}))return true;
  // Unlinking a reservation does not erase its historical membership. Match
  // numeric JSON references exactly, including the original single-cita shape.
  if (db.AppointmentClinicalReportRevision && await db.AppointmentClinicalReportRevision.findOne({
    attributes: ['id'], transaction, where: { [Op.or]: [
      where(fn('JSON_CONTAINS', col('snapshot'), JSON.stringify({ appointment_id: Number(appointmentId) })), 1),
      where(fn('JSON_CONTAINS', col('snapshot'), JSON.stringify({ appointment_ids: [Number(appointmentId)] })), 1),
    ] },
  })) return true;
  return false;
}

function clinicalHistoryPreservedError() {
  return Object.assign(new Error(PRESERVED_MESSAGE), { statusCode: 409, code: PRESERVED_CODE });
}

module.exports = { hasAppointmentClinicalHistory, clinicalHistoryPreservedError, PRESERVED_CODE, PRESERVED_MESSAGE };
