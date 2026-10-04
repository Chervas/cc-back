'use strict';

// Internal operator only. Caller owns the transaction, durable before-image
// journal and scope/dependency checks. Any exception MUST roll back the whole
// transaction, including the temporary source update before canonical booking.
const { hash } = require('./adapter');
const { patchSourceRefresh, storedSourceRefresh, sourceRefreshChanged, normalizedSourceRefreshRow: normalizedRow } = require('./source-refresh');
const { lockBookingResources, mutateAppointmentBooking } = require('../../services/appointmentBookingCommand.service');
const { resolveInstallationKeys } = require('../../services/appointmentBookingAvailability.service');
const { importReviewVersion } = require('../appointment-import-review');
const { verifyDocumentedOccupancies } = require('./book-reviewed-appointment');
const FIELDS = ['inicio', 'fin', 'doctor_id', 'instalacion_id', 'updated_at', 'import_metadata'];
const plain = value => JSON.parse(JSON.stringify(value?.toJSON ? value.toJSON() : value));
const fail = code => { throw Error(code); };

async function refreshReviewedAppointment({ db, receipt, transaction, beforeUpdate, sourceImportPermit = null, now = Date.now() }) {
  if (!transaction || transaction.options?.isolationLevel !== 'READ COMMITTED' || typeof beforeUpdate !== 'function') {
    fail('SOURCE_REFRESH_TRANSACTION_AND_GUARD_REQUIRED');
  }
  const row = await db.CitaPaciente.findByPk(receipt.appointment_id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!row) fail('SOURCE_REFRESH_APPOINTMENT_MISSING');
  const before = normalizedRow(plain(row));
  const after = patchSourceRefresh(before, receipt, now); // Full-row CAS and receipt validation, before writes.
  const clinic = await db.Clinica.findByPk(before.clinica_id, { transaction, lock: transaction.LOCK.SHARE });
  if (!clinic) fail('SOURCE_REFRESH_CLINIC_MISSING');
  if (after.tratamiento_id) {
    const treatment = await db.Tratamiento.findByPk(after.tratamiento_id, { transaction, lock: transaction.LOCK.SHARE });
    const config = typeof treatment?.clinical_config === 'string' ? JSON.parse(treatment.clinical_config) : treatment?.clinical_config;
    if (!treatment || config?.booking_profile) fail('SOURCE_REFRESH_CONFIGURED_TREATMENT_REQUIRES_PROFILE');
  }
  const permit = sourceImportPermit && require('./source-booking-permit').inspectSourceBookingPermit(sourceImportPermit,after,now);
  const installations = [...new Set([before.instalacion_id, after.instalacion_id,
    ...(permit?.profile?.phases.flatMap(p=>p.installation_ids) || [])].filter(Boolean))];
  const doctors = [...new Set([before.doctor_id, after.doctor_id,
    ...(permit?.profile?.phases.flatMap(p=>p.professionals.ids) || [])].filter(Boolean))];
  const mapping = await resolveInstallationKeys({ db, clinic, installationIds: installations, transaction, enabled: true });
  const oldOccupancy = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: row.id_cita }, transaction });
  const equipmentIds = receipt.resources.equipment_ids.map(Number);
  await lockBookingResources({ db, transaction, resourceKeys: [
    `patient:${before.paciente_id}`, ...doctors.map(id => `doctor:${id}`),
    ...installations.map(id => mapping.keys.get(id)), ...oldOccupancy.map(item => item.resource_key),
    ...equipmentIds.map(id => `equipment:${id}`),
  ] });
  await beforeUpdate({ transaction, before, after, oldOccupancy: plain(oldOccupancy) });
  await row.reload({ transaction });
  if (hash(normalizedRow(plain(row))) !== receipt.before_sha256) fail('SOURCE_REFRESH_GUARDED_ROW_CHANGED');
  // Sequelize's silent option removes updated_at even when explicitly supplied.
  // A parameterized SQL patch keeps the reviewed timestamp and invokes no hooks.
  const fields = receipt.operator_review ? [...FIELDS, 'nota', 'titulo', 'tratamiento_id'] : FIELDS;
  await db.sequelize.query(`UPDATE CitasPacientes SET ${fields.map(key => `${key}=?`).join(',')} WHERE id_cita=?`, {
    transaction, replacements: [...fields.map(key => key === 'import_metadata' ? JSON.stringify(after[key])
      : ['inicio','fin','updated_at'].includes(key) ? new Date(after[key]) : after[key]), before.id_cita],
  });
  await row.reload({ transaction });
  const intermediate = normalizedRow(plain(row));
  if (hash(intermediate) !== hash(after)) {
    const error = Error('SOURCE_REFRESH_INTERMEDIATE_ROW_CHANGED');
    error.changed_fields = [...new Set([...Object.keys(intermediate), ...Object.keys(after)])]
      .filter(key => hash(intermediate[key]) !== hash(after[key]));
    throw error;
  }
  let canonicalSolution;
  const persist = async ({ existing, values, solution }) => {
      if (!solution) fail('SOURCE_REFRESH_SOLUTION_MISSING');
      canonicalSolution = solution;
      const candidate = normalizedRow(plain(values));
      const metadata = { ...candidate.import_metadata }; delete metadata.booking;
      if (sourceImportPermit) delete metadata.cliniccloud_source_booking;
      if (hash({ ...candidate, import_metadata: metadata }) !== hash(after)) fail('SOURCE_REFRESH_CANONICAL_ROW_CHANGED');
      return equipmentIds.length || sourceImportPermit ? existing.update({ import_metadata: values.import_metadata }, {
        transaction, fields: ['import_metadata'], hooks: false, silent: true,
      }) : existing;
    };
  const saved = sourceImportPermit
    ? await require('./source-booking-permit').mutateSourceImportedBooking({ db, existing:row, values:plain(row),
      transaction, sourceImportPermit, persist, equipmentIds })
    : await mutateAppointmentBooking({ db, existingAppointmentId: row.id_cita, appointmentValues: {},
      transaction, force: false, allowObsolete: true, capabilities: { simple: true, multi: true, equipment: true },
      ...(equipmentIds.length ? { importEquipmentAssignment: { equipment_ids: equipmentIds,
        expected_version: importReviewVersion(plain(row)), source_sha256: receipt.resources.evidence_sha256 } } : {}), persist });
  await saved.reload({ transaction });
  const persisted = normalizedRow(plain(saved)), latest = storedSourceRefresh(persisted, persisted.import_metadata);
  if (sourceRefreshChanged(persisted, latest)) fail('SOURCE_REFRESH_AFTER_WRITE_CHANGED');
  const occupancy = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: row.id_cita }, transaction });
  verifySourceRefreshOccupancies(plain(occupancy), canonicalSolution, mapping.keys);
  return saved;
}
function verifySourceRefreshOccupancies(rows, solution, installationKeys) {
  // The same authoritative occupancy contract as creation: machine attention
  // can reserve separate setup/removal intervals, without releasing its room
  // or shortening equipment occupation. Validate all rows, not just keys.
  try { verifyDocumentedOccupancies(rows, solution, installationKeys); }
  catch { fail('SOURCE_REFRESH_OCCUPANCY_MISMATCH'); }
}
module.exports = { refreshReviewedAppointment, verifySourceRefreshOccupancies };
