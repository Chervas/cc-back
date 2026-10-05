'use strict';

const { importReviewVersion, importTreatmentPending } = require('../lib/appointment-import-review');
const { bookingError } = require('./treatmentBookingProfile.service');
const { prepareHistoricalReference } = require('./historicalTreatmentReference.service');
const { resolveImportedTreatment } = require('./appointmentImportResolution.service');
const { isHistoricalTreatment, assertReviewedHistoricalTreatment } = require('../lib/historical-treatment-reference');

const plain = value => value?.toJSON ? value.toJSON() : value;
function normalizeHistoricalResolution(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)
    || Object.keys(input).sort().join(',') !== 'expected_version,reason'
    || !/^[a-f0-9]{64}$/.test(input.expected_version || '')
    || typeof input.reason !== 'string' || input.reason.trim().length < 20 || input.reason.trim().length > 500) {
    throw bookingError('booking_import_invalid', 'Confirma la versión de la reserva y explica la revisión histórica.', null, 400);
  }
  return { expected_version: input.expected_version, reason: input.reason.trim() };
}

// Existing reservations only. This is not the ordinary catalogue create path:
// clients cannot supply names, clinical acts, prices, documents, profiles,
// approval flags or evidence. Create + classify + audit are one transaction.
async function resolveHistoricalAppointment({ db, appointmentId, clinicId, actorId, input, capabilities }) {
  const decision = normalizeHistoricalResolution(input);
  if (![appointmentId, clinicId, actorId].every(value => Number.isSafeInteger(value) && value > 0)) {
    throw bookingError('booking_import_invalid', 'Falta el ámbito de la reserva histórica.', null, 400);
  }
  return db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, async transaction => {
    const row = await db.CitaPaciente.findByPk(appointmentId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row || Number(row.clinica_id) !== clinicId) throw bookingError('appointment_not_found', 'Cita no encontrada.', null, 404);
    const before = plain(row);
    if (before.tratamiento_id) {
      const treatment = await db.Tratamiento.findByPk(before.tratamiento_id, { transaction, lock: transaction.LOCK.SHARE });
      if (isHistoricalTreatment(treatment)) {
        assertReviewedHistoricalTreatment({ treatment, row: before });
        const marker = before.import_metadata?.import_treatment_resolution;
        if (marker?.actor_id === actorId && marker.reason === decision.reason
          && marker.historical_expected_version === decision.expected_version) {
          return { appointment: row, treatment, replayed: true };
        }
      }
      throw bookingError('booking_import_not_resolvable', 'Esta reserva ya tiene una clasificación; no se ha creado otra referencia.');
    }
    if (!importTreatmentPending(before)) throw bookingError('booking_import_not_resolvable', 'Esta cita no tiene una clasificación fuente pendiente.');
    if (importReviewVersion(before) !== decision.expected_version) throw bookingError('booking_import_changed', 'La reserva ha cambiado; vuelve a revisarla.');
    const values = await prepareHistoricalReference({ db, appointmentIds: [appointmentId], clinicId, actorId,
      discipline: clinicId === 66 && before.import_metadata?.source_account === 'cliniccloud-5880' ? 'capilar' : 'sin_clasificar',
      transaction, requiredClinicalDocumentReview: true });
    const treatment = await db.Tratamiento.create(values, { transaction });
    const result = await resolveImportedTreatment({ db, appointmentId, clinicId, actorId, transaction, capabilities,
      input: { mode: 'treatment', treatment_id: Number(treatment.id_tratamiento), ...decision } });
    // The original CAS is retained solely for safe replay after a lost response.
    // No generic booking request can author this server-owned marker.
    const classified = await db.CitaPaciente.findByPk(appointmentId, { transaction, lock: transaction.LOCK.UPDATE });
    const current = plain(classified);
    const metadata = { ...current.import_metadata };
    metadata.import_treatment_resolution = { ...metadata.import_treatment_resolution,
      classification: 'historical_reference', clinical_approval_inferred: false,
      historical_expected_version: decision.expected_version };
    const appointment = await classified.update({ import_metadata: metadata }, { transaction });
    return { ...result, appointment, treatment };
  });
}

module.exports = { normalizeHistoricalResolution, resolveHistoricalAppointment };
