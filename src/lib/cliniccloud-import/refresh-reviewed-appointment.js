'use strict';

// Internal operator only. Caller owns the transaction, durable before-image
// journal and scope/dependency checks. Any exception MUST roll back the whole
// transaction, including the temporary source update before canonical booking.
const { hash } = require('./adapter');
const { patchSourceRefresh, storedSourceRefresh, sourceRefreshChanged, normalizedSourceRefreshRow: normalizedRow } = require('./source-refresh');
const { lockBookingResources, mutateAppointmentBooking } = require('../../services/appointmentBookingCommand.service');
const { resolveInstallationKeys } = require('../../services/appointmentBookingAvailability.service');
const { importReviewVersion } = require('../appointment-import-review');
const FIELDS = ['inicio', 'fin', 'doctor_id', 'instalacion_id', 'updated_at', 'import_metadata'];
const plain = value => JSON.parse(JSON.stringify(value?.toJSON ? value.toJSON() : value));
const fail = code => { throw Error(code); };

async function refreshReviewedAppointment({ db, receipt, transaction, beforeUpdate, now = Date.now() }) {
  if (!transaction || transaction.options?.isolationLevel !== 'READ COMMITTED' || typeof beforeUpdate !== 'function') {
    fail('SOURCE_REFRESH_TRANSACTION_AND_GUARD_REQUIRED');
  }
  const row = await db.CitaPaciente.findByPk(receipt.appointment_id, { transaction, lock: transaction.LOCK.UPDATE });
  if (!row) fail('SOURCE_REFRESH_APPOINTMENT_MISSING');
  const before = normalizedRow(plain(row));
  const after = patchSourceRefresh(before, receipt, now); // Full-row CAS and receipt validation, before writes.
  const clinic = await db.Clinica.findByPk(before.clinica_id, { transaction, lock: transaction.LOCK.SHARE });
  if (!clinic) fail('SOURCE_REFRESH_CLINIC_MISSING');
  if (before.tratamiento_id) {
    const treatment = await db.Tratamiento.findByPk(before.tratamiento_id, { transaction, lock: transaction.LOCK.SHARE });
    const config = typeof treatment?.clinical_config === 'string' ? JSON.parse(treatment.clinical_config) : treatment?.clinical_config;
    if (!treatment || config?.booking_profile) fail('SOURCE_REFRESH_CONFIGURED_TREATMENT_REQUIRES_PROFILE');
  }
  const installations = [...new Set([before.instalacion_id, after.instalacion_id].filter(Boolean))];
  const mapping = await resolveInstallationKeys({ db, clinic, installationIds: installations, transaction, enabled: true });
  const oldOccupancy = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: row.id_cita }, transaction });
  const equipmentIds = receipt.resources.equipment_ids.map(Number);
  await lockBookingResources({ db, transaction, resourceKeys: [
    `patient:${before.paciente_id}`, ...[before.doctor_id, after.doctor_id].filter(Boolean).map(id => `doctor:${id}`),
    ...installations.map(id => mapping.keys.get(id)), ...oldOccupancy.map(item => item.resource_key),
    ...equipmentIds.map(id => `equipment:${id}`),
  ] });
  await beforeUpdate({ transaction, before, after, oldOccupancy: plain(oldOccupancy) });
  // Sequelize's silent option removes updated_at even when explicitly supplied.
  // A parameterized SQL patch keeps the reviewed timestamp and invokes no hooks.
  await db.sequelize.query(`UPDATE CitasPacientes SET ${FIELDS.map(key => `${key}=?`).join(',')} WHERE id_cita=?`, {
    transaction, replacements: [...FIELDS.map(key => key === 'import_metadata' ? JSON.stringify(after[key])
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
  const saved = await mutateAppointmentBooking({ db, existingAppointmentId: row.id_cita, appointmentValues: {},
    transaction, force: false, allowObsolete: true, capabilities: { simple: true, multi: true, equipment: true },
    ...(equipmentIds.length ? { importEquipmentAssignment: { equipment_ids: equipmentIds,
      expected_version: importReviewVersion(plain(row)), source_sha256: receipt.resources.evidence_sha256 } } : {}),
    persist: async ({ existing, values, solution }) => {
      if (!solution) fail('SOURCE_REFRESH_SOLUTION_MISSING');
      const candidate = normalizedRow(plain(values));
      const metadata = { ...candidate.import_metadata }; delete metadata.booking;
      if (hash({ ...candidate, import_metadata: metadata }) !== hash(after)) fail('SOURCE_REFRESH_CANONICAL_ROW_CHANGED');
      return equipmentIds.length ? existing.update({ import_metadata: values.import_metadata }, {
        transaction, fields: ['import_metadata'], hooks: false, silent: true,
      }) : existing;
    },
  });
  await saved.reload({ transaction });
  const persisted = normalizedRow(plain(saved)), latest = storedSourceRefresh(persisted, persisted.import_metadata);
  if (sourceRefreshChanged(persisted, latest)) fail('SOURCE_REFRESH_AFTER_WRITE_CHANGED');
  const occupancy = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: row.id_cita }, transaction });
  const keys = [`doctor:${after.doctor_id}`, mapping.keys.get(after.instalacion_id), ...equipmentIds.map(id => `equipment:${id}`)];
  if (hash(occupancy.map(item => item.resource_key).sort()) !== hash(keys.sort())
    || occupancy.some(item => new Date(item.start_at).getTime() !== Date.parse(after.inicio)
      || (item.resource_kind === 'equipment' ? new Date(item.end_at).getTime() < Date.parse(after.fin)
        : new Date(item.end_at).getTime() !== Date.parse(after.fin)))) fail('SOURCE_REFRESH_OCCUPANCY_MISMATCH');
  return saved;
}
module.exports = { refreshReviewedAppointment };
