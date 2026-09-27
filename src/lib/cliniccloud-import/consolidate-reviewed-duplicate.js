'use strict';

// No route, app bootstrap, messages or clinical hooks. Caller owns the entire
// transaction and a durable journal. An error requires rollback, not retrying
// just the canonical booking after cancelling its companion.
const { hash } = require('./adapter');
const { normalizedSourceRefreshRow: normalize } = require('./source-refresh');
const { patchDuplicateVisit, duplicateVisitLinks } = require('./duplicate-visits');
const { lockBookingResources, mutateAppointmentBooking } = require('../../services/appointmentBookingCommand.service');
const { resolveInstallationKeys } = require('../../services/appointmentBookingAvailability.service');
const { importReviewVersion } = require('../appointment-import-review');
const plain = value => JSON.parse(JSON.stringify(value?.toJSON ? value.toJSON() : value));
const fail = code => { throw Error(code); };
const positive = n => Number.isSafeInteger(n) && n > 0;
const columns = ['doctor_id', 'instalacion_id', 'estado', 'updated_at', 'import_metadata'];

async function consolidateReviewedDuplicate({ db, receipt, resources, transaction, beforeUpdate, now = Date.now() }) {
  if (!transaction || transaction.options?.isolationLevel !== 'READ COMMITTED' || typeof beforeUpdate !== 'function') {
    fail('DUPLICATE_VISIT_TRANSACTION_AND_GUARD_REQUIRED');
  }
  if (!resources || !positive(resources.doctor_id) || !positive(resources.installation_id)
    || !Array.isArray(resources.equipment_ids) || resources.equipment_ids.length > 8
    || resources.equipment_ids.some(id => !positive(id)) || new Set(resources.equipment_ids).size !== resources.equipment_ids.length
    || !/^[a-f0-9]{64}$/.test(resources.evidence_sha256 || '')
    || Object.keys(resources).some(k => !['doctor_id', 'installation_id', 'equipment_ids', 'evidence_sha256'].includes(k))) {
    fail('DUPLICATE_VISIT_RESOURCES_INVALID');
  }
  const models = [];
  for (const id of [receipt.canonical_id, receipt.retired_id].sort((a, b) => a - b)) {
    const row = await db.CitaPaciente.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!row) fail('DUPLICATE_VISIT_ROW_MISSING');
    models.push(row);
  }
  const before = models.map(model => normalize(plain(model)));
  const after = before.map(row => patchDuplicateVisit(row, receipt, now));
  const canonical = after.find(r => r.id_cita === receipt.canonical_id);
  canonical.doctor_id = resources.doctor_id;
  canonical.instalacion_id = resources.installation_id;
  const clinic = await db.Clinica.findByPk(receipt.clinic_id, { transaction, lock: transaction.LOCK.SHARE });
  if (!clinic || Number(clinic.grupoClinicaId) !== 29) fail('DUPLICATE_VISIT_CLINIC_MISMATCH');
  if (canonical.tratamiento_id) {
    const treatment = await db.Tratamiento.findByPk(canonical.tratamiento_id, { transaction, lock: transaction.LOCK.SHARE });
    const config = typeof treatment?.clinical_config === 'string' ? JSON.parse(treatment.clinical_config) : treatment?.clinical_config;
    if (!treatment || config?.booking_profile) fail('DUPLICATE_VISIT_CONFIGURED_TREATMENT_REQUIRES_PROFILE');
  }
  const installations = [...new Set([...before.map(r => r.instalacion_id), resources.installation_id])];
  const mapping = await resolveInstallationKeys({ db, clinic, installationIds: installations, transaction, enabled: true });
  const oldOccupancy = await db.AppointmentBookingOccupancy.findAll({
    where: { appointment_id: before.map(r => r.id_cita) }, transaction,
  });
  // Existing advanced/occupied appointments need a separate dependency-aware
  // path. This narrow operator is only for untouched legacy imports.
  if (oldOccupancy.length) fail('DUPLICATE_VISIT_EXISTING_OCCUPANCY');
  await lockBookingResources({ db, transaction, resourceKeys: [
    `patient:${receipt.patient_id}`, ...new Set([...before.map(r => `doctor:${r.doctor_id}`), `doctor:${resources.doctor_id}`]),
    ...installations.map(id => mapping.keys.get(id)), ...resources.equipment_ids.map(id => `equipment:${id}`),
  ] });
  await beforeUpdate({ transaction, before, after, resources });
  for (const row of after) {
    await db.sequelize.query(`UPDATE CitasPacientes SET ${columns.map(k => k + '=?').join(',')} WHERE id_cita=?`, {
      transaction, replacements: [...columns.map(k => k === 'import_metadata' ? JSON.stringify(row[k])
        : k === 'updated_at' ? new Date(row[k]) : row[k]), row.id_cita],
    });
  }
  for (const model of models) {
    await model.reload({ transaction });
    if (hash(normalize(plain(model))) !== hash(after.find(r => r.id_cita === model.id_cita))) fail('DUPLICATE_VISIT_INTERMEDIATE_CHANGED');
  }
  const selected = models.find(r => r.id_cita === receipt.canonical_id);
  await mutateAppointmentBooking({ db, existingAppointmentId: selected.id_cita, appointmentValues: {},
    transaction, force: false, allowObsolete: true, capabilities: { simple: true, multi: true, equipment: true },
    ...(resources.equipment_ids.length ? { importEquipmentAssignment: { equipment_ids: resources.equipment_ids,
      expected_version: importReviewVersion(plain(selected)), source_sha256: resources.evidence_sha256 } } : {}),
    persist: async ({ existing, values, solution }) => {
      if (!solution) fail('DUPLICATE_VISIT_SOLUTION_MISSING');
      const candidate = normalize(plain(values));
      const metadata = { ...candidate.import_metadata }; delete metadata.booking;
      if (hash({ ...candidate, import_metadata: metadata }) !== hash(canonical)) fail('DUPLICATE_VISIT_CANONICAL_CHANGED');
      return resources.equipment_ids.length ? existing.update({ import_metadata: values.import_metadata }, {
        transaction, fields: ['import_metadata'], hooks: false, silent: true,
      }) : existing;
    },
  });
  for (const model of models) await model.reload({ transaction });
  const saved = models.map(model => normalize(plain(model)));
  if (duplicateVisitLinks(saved).get(receipt.canonical_id)?.local_changed !== false) fail('DUPLICATE_VISIT_AFTER_WRITE_CHANGED');
  const occupancies = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: saved.map(r => r.id_cita) }, transaction });
  const expected = [`doctor:${resources.doctor_id}`, mapping.keys.get(resources.installation_id), ...resources.equipment_ids.map(id => `equipment:${id}`)];
  if (hash(occupancies.map(r => r.resource_key).sort()) !== hash(expected.sort()) || occupancies.some(r =>
    r.appointment_id !== receipt.canonical_id || new Date(r.start_at).getTime() !== Date.parse(canonical.inicio)
    || new Date(r.end_at).getTime() !== Date.parse(canonical.fin))) fail('DUPLICATE_VISIT_OCCUPANCY_MISMATCH');
  return { rows: saved, occupancies: plain(occupancies) };
}

module.exports = { consolidateReviewedDuplicate };
