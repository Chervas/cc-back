'use strict';

// Operator-only creation of a source booking with explicitly reviewed resources.
// No app bootstrap, hooks, events, reminders, inferred clinical act or new price.
const { hash } = require('./adapter');
const { lockBookingResources, mutateAppointmentBooking } = require('../../services/appointmentBookingCommand.service');
const { resolveInstallationKeys } = require('../../services/appointmentBookingAvailability.service');
const { importReviewVersion } = require('../appointment-import-review');
const { assertSourcePatientUnambiguous } = require('./source-patient-notes');
const COLUMNS = Object.freeze(['clinica_id','paciente_id','doctor_id','instalacion_id','tratamiento_id',
  'titulo','nota','motivo','tipo_cita','estado','inicio','fin','source_system','source_reference',
  'es_provisional','created_at','updated_at','import_metadata']);
const fail = code => { throw Error(code); };
const object = value => typeof value === 'string' ? JSON.parse(value) : value;
const positive = value => Number.isSafeInteger(value) && value > 0;
function validatePayload(payload, equipmentIds, sourceSha256) {
  if (!payload || hash(Object.keys(payload).sort()) !== hash([...COLUMNS].sort())
    || !['clinica_id','paciente_id','doctor_id','instalacion_id'].every(k => positive(payload[k]))
    || !(payload.tratamiento_id === null || positive(payload.tratamiento_id))
    || payload.source_system !== 'cliniccloud' || !payload.source_reference
    || payload.estado !== 'pendiente' || payload.es_provisional !== 0) fail('DOCUMENTED_BOOKING_PAYLOAD_INVALID');
  assertSourcePatientUnambiguous(payload.nota);
  const metadata = payload.import_metadata;
  if (!metadata || metadata.source_account !== 'cliniccloud-5880'
    || !/^\d+$/.test(metadata.source_contact_id || '')
    || !['appointment_details','day_before','same_day'].every(k => metadata.notification_suppression?.[k] === true)
    || metadata.cliniccloud_reconciliation?.automation_policy !== 'hold'
    || !Array.isArray(metadata.cliniccloud_delta?.pending_assignment)
    || metadata.cliniccloud_delta.pending_assignment.some(k => k !== 'treatment_id')
    || (payload.tratamiento_id === null && !metadata.cliniccloud_delta.pending_assignment.includes('treatment_id'))
    || ['booking','program_session','additional_staff','import_resource_resolution','import_treatment_resolution'].some(k => metadata[k] != null)) {
    fail('DOCUMENTED_BOOKING_HOLD_AND_REVIEW_REQUIRED');
  }
  if (!Array.isArray(equipmentIds) || equipmentIds.length > 8 || equipmentIds.some(id => !positive(id))
    || new Set(equipmentIds).size !== equipmentIds.length || !/^[a-f0-9]{64}$/.test(sourceSha256 || '')) fail('DOCUMENTED_BOOKING_EVIDENCE_INVALID');
}

async function bookReviewedAppointment({ db, payload, equipmentIds = [], sourceSha256, transaction, beforeInsert }) {
  validatePayload(payload, equipmentIds, sourceSha256);
  if (!transaction || transaction.options?.isolationLevel !== 'READ COMMITTED' || typeof beforeInsert !== 'function') {
    fail('DOCUMENTED_BOOKING_TRANSACTION_AND_IDENTITY_GUARD_REQUIRED');
  }
  const clinic = await db.Clinica.findByPk(payload.clinica_id, { transaction, lock: transaction.LOCK.SHARE });
  if (!clinic) fail('DOCUMENTED_BOOKING_CLINIC_MISSING');
  if (payload.tratamiento_id) {
    const treatment = await db.Tratamiento.findByPk(payload.tratamiento_id, { transaction, lock: transaction.LOCK.SHARE });
    // A configured treatment must be booked as such; do not replace its phases
    // with a source-duration snapshot or an operator-authored equipment list.
    if (!treatment || object(treatment.clinical_config)?.booking_profile) fail('DOCUMENTED_BOOKING_CONFIGURED_TREATMENT_REQUIRES_PROFILE');
  }
  const mapping = await resolveInstallationKeys({ db, clinic, installationIds: [payload.instalacion_id], transaction, enabled: true });
  const resourceKeys = [`patient:${payload.paciente_id}`, `doctor:${payload.doctor_id}`,
    mapping.keys.get(payload.instalacion_id), ...equipmentIds.map(id => `equipment:${id}`)];
  await lockBookingResources({ db, resourceKeys, transaction });
  // The caller rechecks source ownership, memberships, duplicates and current
  // row hashes under these locks. Only then may the transaction create its row.
  await beforeInsert({ transaction, resourceKeys });
  const inserted = await db.CitaPaciente.create(payload, { transaction, fields: [...COLUMNS], hooks: false, silent: true });
  await inserted.reload({ transaction });
  const previous = inserted.toJSON();
  const saved = await mutateAppointmentBooking({ db, existingAppointmentId: inserted.id_cita,
    appointmentValues: {}, transaction, force: false, allowObsolete: true,
    capabilities: { simple: true, multi: true, equipment: true },
    ...(equipmentIds.length ? { importEquipmentAssignment: { equipment_ids: [...equipmentIds],
      expected_version: importReviewVersion(previous), source_sha256: sourceSha256 } } : {}),
    persist: async ({ values, existing, solution }) => {
      if (!solution || values.doctor_id !== payload.doctor_id || values.instalacion_id !== payload.instalacion_id
        || values.tratamiento_id !== payload.tratamiento_id || values.paciente_id !== payload.paciente_id
        || new Date(values.inicio).getTime() !== new Date(payload.inicio).getTime()
        || new Date(values.fin).getTime() !== new Date(payload.fin).getTime()) fail('DOCUMENTED_BOOKING_SOURCE_CHANGED');
      const metadata = { ...object(values.import_metadata) };
      delete metadata.booking;
      if (hash(metadata) !== hash(payload.import_metadata)) fail('DOCUMENTED_BOOKING_METADATA_CHANGED');
      return equipmentIds.length ? existing.update({ import_metadata: values.import_metadata }, {
        transaction, fields: ['import_metadata'], hooks: false, silent: true,
      }) : existing;
    } });
  const rows = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: saved.id_cita }, transaction });
  const expectedKeys = resourceKeys.filter(key => !key.startsWith('patient:')).sort();
  if (hash(rows.map(row => row.resource_key).sort()) !== hash(expectedKeys)
    || rows.some(row => new Date(row.start_at).getTime() !== new Date(payload.inicio).getTime()
      || (row.resource_kind === 'equipment'
        ? new Date(row.end_at).getTime() < new Date(payload.fin).getTime()
        : new Date(row.end_at).getTime() !== new Date(payload.fin).getTime()))) fail('DOCUMENTED_BOOKING_OCCUPANCY_MISMATCH');
  return saved;
}
module.exports = { bookReviewedAppointment, validatePayload, COLUMNS };
