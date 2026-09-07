'use strict';

const { solveBookingProfile, occupancyForSolution, isFree } = require('../lib/booking-profile-solver');
const { normalizeBookingProfile } = require('../lib/booking-profile');
const { resolveInstallationKeys, loadBookingContext } = require('./appointmentBookingAvailability.service');
const { bookingError, bookingCapabilities, requireOperationalProfile, loadScopedTreatment, assertPriorityAcknowledgement } = require('./treatmentBookingProfile.service');

function metadataObject(value) {
  if (typeof value === 'string') { try { value = JSON.parse(value); } catch { value = null; } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

/**
 * Anchors solve the empty-range race: locking appointments alone cannot lock a
 * slot where no appointment exists yet. Every participating writer takes these
 * keys in lexical order, before the authoritative READ COMMITTED availability.
 */
async function lockBookingResources({ db, resourceKeys, transaction }) {
  if (!transaction) throw new Error('booking_transaction_required');
  for (const key of [...new Set(resourceKeys)].sort()) {
    if (!/^(doctor|installation):[1-9]\d*$/.test(key)) throw new Error('booking_resource_key_invalid');
    // Upsert obtains the same unique-key lock even when the anchor is new.
    await db.AppointmentBookingResource.upsert({ resource_key: key, resource_kind: key.split(':')[0] }, { transaction });
    await db.AppointmentBookingResource.findByPk(key, { transaction, lock: transaction.LOCK.UPDATE });
  }
}

function legacyProfile(values, duration) {
  return { version: 1, phases: [{ key: 'appointment', label: '', duration_minutes: duration,
    installation_ids: values.instalacion_id ? [Number(values.instalacion_id)] : [],
    professionals: { mode: 'any', ids: values.doctor_id ? [Number(values.doctor_id)] : [], preferred_id: values.doctor_id ? Number(values.doctor_id) : null } }] };
}

function solveLegacy(values, context) {
  const start = new Date(values.inicio);
  const end = new Date(values.fin);
  if ((context.clinicWindows && !isFree({ windows: context.clinicWindows }, start, end))
    || (values.doctor_id && !isFree(context.doctors.get(Number(values.doctor_id)), start, end))
    || (values.instalacion_id && !isFree(context.installations.get(Number(values.instalacion_id)), start, end))) return null;
  return { start_at: start.toISOString(), end_at: end.toISOString(), warnings: [], requires_priority_acknowledgement: false,
    phases: [{ key: 'appointment', label: '', start_at: start.toISOString(), end_at: end.toISOString(),
      installation_id: values.instalacion_id ? Number(values.instalacion_id) : null,
      doctor_ids: values.doctor_id ? [Number(values.doctor_id)] : [], staff_time_scope: 'phase' }] };
}

/**
 * Only persistence callback and occupancy are inside the transaction. Callers
 * run existing consent/automation/socket hooks ONCE after this function commits.
 * This command is dormant until the entire shared-DB writer/read path is promoted.
 */
async function mutateAppointmentBooking({ db, appointmentValues, existingAppointmentId = null, persist,
  priorityAcknowledged = false, selections = {}, transaction = null, capabilities = bookingCapabilities(),
  allowObsolete = false, stateOnly = false }) {
  if (!capabilities.simple) throw bookingError('booking_profile_runtime_unavailable', 'La reserva de perfiles todavía no está activada.');
  const execute = async (tx) => {
    if (tx.options?.isolationLevel !== 'READ COMMITTED') {
      throw new Error('booking_requires_read_committed');
    }
    const existing = existingAppointmentId ? await db.CitaPaciente.findByPk(existingAppointmentId, { transaction: tx, lock: tx.LOCK.UPDATE }) : null;
    if (existingAppointmentId && !existing) throw bookingError('appointment_not_found', 'Cita no encontrada.', null, 404);
    const previous = existing?.toJSON ? existing.toJSON() : (existing || {});
    const values = { ...previous, ...appointmentValues };
    // Decide under the appointment row lock, not a stale controller read. An
    // active-to-active status update does not rebook or change its professionals.
    if (stateOnly && existing && previous.estado !== 'cancelada' && values.estado !== 'cancelada') {
      return persist({ values: { ...previous, estado: values.estado, updated_by: values.updated_by }, existing, transaction: tx, solution: null });
    }
    const start = new Date(values.inicio);
    const end = new Date(values.fin);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || (end - start) > 1440 * 60000) {
      throw bookingError('booking_range_invalid', 'El intervalo de la cita no es válido.', null, 400);
    }
    const clinic = await db.Clinica.findByPk(values.clinica_id, { transaction: tx });
    if (!clinic) throw bookingError('clinic_not_found', 'Clínica no encontrada.', null, 404);
    const treatment = await loadScopedTreatment({ db, treatmentId: values.tratamiento_id, clinic, transaction: tx });
    const previousMetadata = metadataObject(previous.import_metadata);
    const importMetadata = { ...previousMetadata, ...metadataObject(values.import_metadata) };
    delete importMetadata.booking; // A request cannot author a trusted booking snapshot.
    const previousRows = existing ? await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: existing.id_cita }, transaction: tx }) : [];
    if (previousRows.length && previousMetadata.booking) importMetadata.booking = previousMetadata.booking;
    values.import_metadata = Object.keys(importMetadata).length ? importMetadata : null;
    let configuredProfile;
    // Existing reservations keep their original booking requirements when the
    // catalog evolves. Editing clinical/history data cannot rewrite that snapshot.
    const snapshot = previousMetadata.booking?.profile;
    if (snapshot && previousRows.length && Number(previous.tratamiento_id) === Number(values.tratamiento_id)) {
      configuredProfile = values.estado === 'cancelada' ? normalizeBookingProfile(snapshot)
        : requireOperationalProfile({ activo: true, clinical_config: { booking_profile: normalizeBookingProfile(snapshot) } }, { capabilities });
    } else {
      configuredProfile = values.estado === 'cancelada' ? null : requireOperationalProfile(treatment, { capabilities, allowObsolete });
    }
    const profile = configuredProfile || legacyProfile(values, (end - start) / 60000);
    const installationIds = [...new Set(profile.phases.flatMap((phase) => phase.installation_ids))];
    const mapping = await resolveInstallationKeys({ db, clinic, installationIds, transaction: tx, enabled: true });
    const keys = [
      ...profile.phases.flatMap((phase) => phase.professionals.ids.map((id) => `doctor:${id}`)),
      ...installationIds.map((id) => mapping.keys.get(id)), ...previousRows.map((row) => row.resource_key),
    ];
    await lockBookingResources({ db, resourceKeys: keys, transaction: tx });
    let solution = null;
    if (values.estado !== 'cancelada') {
      const context = await loadBookingContext({ db, clinic, profile, start, end, transaction: tx,
        ignoreAppointmentId: existing?.id_cita, occupancyEnabled: true, installationMapping: mapping });
      const existingSelections = previousMetadata.booking?.phases && configuredProfile
        ? Object.fromEntries(previousMetadata.booking.phases.map((phase) => [phase.key, {
          installation_id: phase.installation_id,
          ...(configuredProfile.phases.find((candidate) => candidate.key === phase.key)?.professionals.mode === 'any'
            ? { doctor_id: phase.doctor_ids?.[0] } : {}),
        }])) : null;
      const chosen = Object.keys(selections || {}).length ? selections
        : (configuredProfile?.phases.length === 1 && configuredProfile.phases[0].professionals.mode === 'any'
          ? { [configuredProfile.phases[0].key]: { doctor_id: values.doctor_id, installation_id: values.instalacion_id } }
          : existingSelections || {});
      solution = configuredProfile ? solveBookingProfile({ profile, start, ...context, selections: chosen }) : solveLegacy(values, context);
      if (!solution || new Date(solution.end_at).getTime() !== end.getTime()) {
        throw bookingError('booking_unavailable', 'El hueco ya no está disponible o no cumple el perfil del tratamiento. Actualiza las propuestas.', { can_force: false });
      }
      assertPriorityAcknowledgement(solution, priorityAcknowledged);
      if (configuredProfile) {
        values.doctor_id = solution.phases[0].doctor_ids[0];
        values.instalacion_id = solution.phases[0].installation_id;
        importMetadata.booking = { version: 1, profile: configuredProfile, phases: solution.phases,
          warnings: solution.warnings, priority_acknowledged: priorityAcknowledged === true };
        values.import_metadata = importMetadata;
      }
    }
    const appointment = await persist({ values, existing, transaction: tx, solution });
    if (!appointment?.id_cita) throw new Error('booking_appointment_persistence_failed');
    // Cancellation releases capacity via the canonical appointment state. Keep
    // its old rows as the provenance for restoring the same booking snapshot.
    if (values.estado !== 'cancelada') {
      await db.AppointmentBookingOccupancy.destroy({ where: { appointment_id: appointment.id_cita }, transaction: tx });
    }
    if (solution) {
      const rows = occupancyForSolution(solution, mapping.keys).filter((row) => row.installation_id || row.doctor_id);
      if (rows.length) await db.AppointmentBookingOccupancy.bulkCreate(rows.map((row) => ({ ...row, appointment_id: appointment.id_cita })), { transaction: tx });
    }
    return appointment;
  };
  return transaction ? execute(transaction) : db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, execute);
}

module.exports = { lockBookingResources, mutateAppointmentBooking };
