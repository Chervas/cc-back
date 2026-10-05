'use strict';

const { buildHistoricalReferenceValues } = require('../lib/historical-treatment-reference');

// Called by the reviewed import controller, never by the ordinary catalogue
// create/edit form. No caller-supplied price, profile, source text or evidence is
// accepted: all reference guards are derived from existing server records.
async function prepareHistoricalReference({ db, appointmentIds, clinicId, actorId, discipline, transaction, requiredClinicalDocumentReview = true }) {
  if (!Array.isArray(appointmentIds) || !appointmentIds.length || appointmentIds.length > 100
    || appointmentIds.some(id => !Number.isSafeInteger(id) || id <= 0) || new Set(appointmentIds).size !== appointmentIds.length
    || !Number.isSafeInteger(clinicId) || clinicId <= 0) {
    throw Object.assign(new Error('Conjunto histórico no válido.'), { code: 'historical_reference_invalid', statusCode: 422 });
  }
  const rows = await db.CitaPaciente.findAll({ where: { id_cita: { [db.Sequelize.Op.in]: appointmentIds }, clinica_id: clinicId },
    order: [['id_cita', 'ASC']], transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
  if (rows.length !== appointmentIds.length) throw Object.assign(new Error('Falta alguna reserva fuente de esta clínica.'), { code: 'historical_reference_scope', statusCode: 404 });
  return buildHistoricalReferenceValues({ rows, actorId, discipline, requiredClinicalDocumentReview });
}

module.exports = { prepareHistoricalReference };
