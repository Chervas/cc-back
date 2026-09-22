'use strict';

const { solveBookingProfile, occupancyForSolution, isFree } = require('../lib/booking-profile-solver');
const { normalizeBookingProfile } = require('../lib/booking-profile');
const { resolveInstallationKeys, loadBookingContext } = require('./appointmentBookingAvailability.service');
const { bookingError, bookingCapabilities, requireOperationalProfile, loadScopedTreatment, assertPriorityAcknowledgement } = require('./treatmentBookingProfile.service');
const { normalizeAdditionalStaff, additionalStaffSnapshot } = require('../lib/appointment-additional-staff');
const { installationAllowsStaff } = require('../lib/installation-professionals');
const { equipmentIds } = require('../lib/booking-equipment');

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
    if (!/^(doctor|installation|patient|equipment):[1-9]\d*$/.test(key)) throw new Error('booking_resource_key_invalid');
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

function solveLegacy(values, context, force = false) {
  const start = new Date(values.inicio);
  const end = new Date(values.fin);
  if (values.instalacion_id && !installationAllowsStaff(context.installations.get(Number(values.instalacion_id)),
    values.doctor_id ? [Number(values.doctor_id)] : [])) return null;
  const checked = resource => resource && ({ ...resource,
    busy: force ? (resource.busy || []).filter(interval => interval.can_force_legacy !== true) : resource.busy });
  if ((context.clinicWindows && !isFree({ windows: context.clinicWindows }, start, end))
    || (values.doctor_id && !isFree(checked(context.doctors.get(Number(values.doctor_id))), start, end))
    || (values.instalacion_id && !isFree(checked(context.installations.get(Number(values.instalacion_id))), start, end))) return null;
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
  allowObsolete = false, stateOnly = false, trustedProgramSession = null, preparedContext = null, force = false,
  additionalStaffIds = undefined, supportOnly = false, expectedRange = null }) {
  if (!capabilities.simple) throw bookingError('booking_profile_runtime_unavailable', 'La reserva de perfiles todavía no está activada.');
  const requestedStaff = normalizeAdditionalStaff(additionalStaffIds);
  const execute = async (tx) => {
    if (tx.options?.isolationLevel !== 'READ COMMITTED') {
      throw new Error('booking_requires_read_committed');
    }
    const existing = existingAppointmentId ? await db.CitaPaciente.findByPk(existingAppointmentId, { transaction: tx, lock: tx.LOCK.UPDATE }) : null;
    if (existingAppointmentId && !existing) throw bookingError('appointment_not_found', 'Cita no encontrada.', null, 404);
    const previous = existing?.toJSON ? existing.toJSON() : (existing || {});
    const values = { ...previous, ...appointmentValues };
    if (supportOnly) {
      if (!existing || !expectedRange
        || !Number.isFinite(new Date(expectedRange.start).getTime()) || !Number.isFinite(new Date(expectedRange.end).getTime())
        || new Date(previous.inicio).getTime() !== new Date(expectedRange.start).getTime()
        || new Date(previous.fin).getTime() !== new Date(expectedRange.end).getTime()) {
        throw bookingError('booking_appointment_changed', 'La cita ha cambiado. Actualízala antes de cambiar el personal.');
      }
      if (['cancelada', 'completada', 'no_asistio'].includes(previous.estado)) {
        throw bookingError('booking_additional_staff_closed', 'Solo puedes cambiar el apoyo en citas abiertas.');
      }
      if (requestedStaff === undefined || Object.keys(appointmentValues).some(key => key !== 'updated_by')) {
        throw bookingError('booking_additional_staff_invalid', 'El cambio de apoyo no puede modificar otros datos de la cita.', null, 400);
      }
    }
    const previousStaff = additionalStaffSnapshot(previous);
    if (metadataObject(previous.import_metadata).additional_staff && !previousStaff) {
      throw bookingError('booking_additional_staff_invalid', 'Revisa el personal de apoyo de esta cita antes de modificarla.');
    }
    const extraStaff = requestedStaff ?? previousStaff?.ids ?? [];
    if (extraStaff.length && !capabilities.multi) throw bookingError('booking_profile_runtime_unavailable',
      'La reserva con personal de apoyo todavía no está activada.');
    if (stateOnly && requestedStaff !== undefined) throw bookingError('booking_additional_staff_invalid',
      'Cambia el personal desde la edición de la cita, no desde su estado.', null, 400);
    // Only the server-owned session ledger can supply a combined profile. An
    // ordinary appointment request cannot forge a purchase or change its owner.
    const session = existing && db.PatientProgramSession && previous.voucher_id
      ? await db.PatientProgramSession.findOne({ where: { appointment_id: existing.id_cita }, transaction: tx }) : null;
    if (session) {
      const voucher = await db.PatientVoucher.findByPk(session.voucher_id, { transaction: tx, lock: tx.LOCK.UPDATE });
      if (!voucher || Number(voucher.patient_id) !== Number(previous.paciente_id) || Number(voucher.clinic_id) !== Number(previous.clinica_id)
        || Number(voucher.id) !== Number(previous.voucher_id)) throw bookingError('program_session_identity_locked', 'La cita no corresponde a la compra del programa.');
      await session.reload({ transaction: tx, lock: tx.LOCK.UPDATE });
      if (Number(session.appointment_id) !== Number(existing.id_cita)) throw bookingError('program_session_replaced', 'Esta sesión ya tiene otra cita. Actualiza el plan.');
      for (const field of ['paciente_id', 'clinica_id', 'voucher_id', 'tratamiento_id']) {
        if (Number(previous[field]) !== Number(values[field])) throw bookingError('program_session_identity_locked', 'Conserva el paciente, programa y tratamientos de esta sesión.');
      }
      if (session.consumption_movement_id && values.estado !== previous.estado) throw bookingError('program_session_completed', 'La sesión ya se ha consumido. Revisa su corrección desde el historial antes de cambiarla.');
      if (session.consumption_movement_id && (new Date(values.inicio).getTime() !== new Date(previous.inicio).getTime() || new Date(values.fin).getTime() !== new Date(previous.fin).getTime())) throw bookingError('program_session_completed', 'La fecha de una sesión consumida forma parte de su historial.');
      if (!require('../lib/program-booking').programBookingEnabled()) throw bookingError('program_booking_disabled', 'Esta cita necesita el entorno compatible con programas.');
      if (values.estado !== 'cancelada') {
        const records = await db.PatientProgramSession.findAll({ where: { voucher_id: session.voucher_id }, order: [['position', 'ASC']], transaction: tx });
        const appointments = await db.CitaPaciente.findAll({ where: { voucher_id: session.voucher_id, estado: { [db.Sequelize.Op.ne]: 'cancelada' } }, transaction: tx });
        const series = records.map(record => {
          const appointment = Number(record.id) === Number(session.id) ? values : appointments.find(row => Number(row.id_cita) === Number(record.appointment_id));
          return { key: record.session_key, start_at: appointment?.inicio, end_at: appointment?.fin };
        });
        const clinic = await db.Clinica.findByPk(values.clinica_id, { transaction: tx });
        const issues = require('../lib/program-booking').seriesIssues(series, metadataObject(session.snapshot).program_cadence, require('../lib/availability-calendar').resolveClinicTimezone(clinic));
        if (issues.length) throw bookingError('program_cadence_conflict', 'El cambio no respeta el orden o la pauta del programa.', { issues });
      }
    } else if (existing && metadataObject(previous.import_metadata).program_session) {
      throw bookingError('program_session_replaced', 'Esta cita pertenece al historial de una sesión que ya tiene otra reserva.');
    }
    await require('./appointmentConsentEligibility.service').assertClinicalCompletion({ db, previous,
      appointment: values, transaction: tx });
    // Decide under the appointment row lock, not a stale controller read. An
    // active-to-active status update does not rebook or change its professionals.
    if (stateOnly && existing && previous.estado !== 'cancelada' && values.estado !== 'cancelada') {
      const saved = await persist({ values: { ...previous, estado: values.estado, updated_by: values.updated_by }, existing, transaction: tx, solution: null });
      if (session && values.estado === 'completada') {
        const voucher = await db.PatientVoucher.findByPk(session.voucher_id, { transaction: tx, lock: tx.LOCK.UPDATE });
        const result = await require('./patientProgramBooking.service').consumeProgramSession({ db, appointment: saved, voucher, transaction: tx, actorId: values.updated_by });
        if (!result.consumed && !result.already_consumed) throw bookingError('program_session_not_consumable', 'No se puede descontar esta sesión. No se ha cambiado la asistencia.');
      }
      return saved;
    }
    const start = new Date(values.inicio);
    const end = new Date(values.fin);
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end <= start || (end - start) > 1440 * 60000) {
      throw bookingError('booking_range_invalid', 'El intervalo de la cita no es válido.', null, 400);
    }
    const clinic = await db.Clinica.findByPk(values.clinica_id, { transaction: tx, lock: tx.LOCK.SHARE });
    if (!clinic) throw bookingError('clinic_not_found', 'Clínica no encontrada.', null, 404);
    const treatment = await loadScopedTreatment({ db, treatmentId: values.tratamiento_id, clinic, transaction: tx });
    const previousMetadata = metadataObject(previous.import_metadata);
    const importMetadata = { ...previousMetadata, ...metadataObject(values.import_metadata) };
    delete importMetadata.booking; // A request cannot author a trusted booking snapshot.
    delete importMetadata.program_session;
    delete importMetadata.additional_staff;
    delete importMetadata.import_treatment_resolution;
    if (previousMetadata.import_treatment_resolution) importMetadata.import_treatment_resolution = previousMetadata.import_treatment_resolution;
    delete importMetadata.import_resource_resolution;
    if (previousMetadata.import_resource_resolution) importMetadata.import_resource_resolution = previousMetadata.import_resource_resolution;
    if (values.estado === 'cancelada' && previousStaff) {
      if (requestedStaff !== undefined && JSON.stringify(requestedStaff) !== JSON.stringify(previousStaff.ids)) {
        throw bookingError('booking_additional_staff_invalid', 'Reabre la cita para cambiar su personal de apoyo.', null, 400);
      }
      importMetadata.additional_staff = { ...previousStaff, start_at: start.toISOString(), end_at: end.toISOString() };
    } else if (values.estado === 'cancelada' && extraStaff.length) {
      throw bookingError('booking_additional_staff_invalid', 'No se puede añadir personal a una cita cancelada.', null, 400);
    }
    if (session) importMetadata.program_session = previousMetadata.program_session;
    if (trustedProgramSession) {
      if (existing || !transaction || Number(trustedProgramSession.voucher_id) !== Number(values.voucher_id)) throw new Error('program_booking_trusted_context_invalid');
      importMetadata.program_session = { session_id: String(trustedProgramSession.id), key: trustedProgramSession.session_key };
    }
    const previousRows = existing ? await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: existing.id_cita }, transaction: tx }) : [];
    if (previousRows.length && previousMetadata.booking) importMetadata.booking = previousMetadata.booking;
    values.import_metadata = Object.keys(importMetadata).length ? importMetadata : null;
    let configuredProfile;
    // Existing reservations keep their original booking requirements when the
    // catalog evolves. Editing clinical/history data cannot rewrite that snapshot.
    const snapshot = previousMetadata.booking?.profile;
    if (trustedProgramSession || session) {
      const frozen = metadataObject((trustedProgramSession || session).snapshot);
      configuredProfile = normalizeBookingProfile(frozen.booking_profile);
      if (!configuredProfile) throw bookingError('program_profile_missing', 'Falta el perfil de la sesión comprada.');
      if (!capabilities.multi && configuredProfile.phases.length > 1) throw bookingError('booking_profile_runtime_unavailable', 'La reserva multicabina todavía no está activada.');
    } else if (snapshot && previousRows.length && Number(previous.tratamiento_id) === Number(values.tratamiento_id)) {
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
      ...extraStaff.map((id) => `doctor:${id}`),
      ...installationIds.map((id) => mapping.keys.get(id)), ...previousRows.map((row) => row.resource_key),
      ...equipmentIds(profile).map(id => `equipment:${id}`),
      ...(values.paciente_id ? [`patient:${values.paciente_id}`] : []),
    ];
    await lockBookingResources({ db, resourceKeys: keys, transaction: tx });
    let solution = null;
    if (values.estado !== 'cancelada') {
      const context = (!extraStaff.length && preparedContext) || await loadBookingContext({ db, clinic, profile, start, end, transaction: tx,
        ignoreAppointmentId: existing?.id_cita, occupancyEnabled: true, installationMapping: mapping, patientId: values.paciente_id,
        additionalStaffIds: extraStaff, equipmentEnabled: capabilities.equipment });
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
      const supportFree = extraStaff.every(id => isFree(context.doctors.get(id), start, end));
      solution = supportFree ? (configuredProfile ? solveBookingProfile({ profile, start, ...context, selections: chosen })
        : solveLegacy(values, context, !extraStaff.length && force === true)) : null;
      const patientConflict = (context.patientBusy || []).some(busy => new Date(busy.start) < end && new Date(busy.end) > start);
      if (!solution || patientConflict || new Date(solution.end_at).getTime() !== end.getTime()) {
        // Re-evaluated under the same resource locks. Force is only available
        // between ordinary appointments in this clinic, never for a profile,
        // mandatory team, blocked schedule, foreign clinic or patient overlap.
        const canForce = !extraStaff.length && !configuredProfile && !patientConflict && !!solveLegacy(values, context, true);
        throw bookingError('booking_unavailable', 'El hueco ya no está disponible o no cumple el perfil del tratamiento. Actualiza las propuestas.', { can_force: canForce });
      }
      const acknowledged = priorityAcknowledged || (supportOnly && previousMetadata.booking?.priority_acknowledged === true);
      assertPriorityAcknowledgement(solution, acknowledged);
      if (configuredProfile) {
        values.doctor_id = solution.phases[0].doctor_ids[0];
        values.instalacion_id = solution.phases[0].installation_id;
        importMetadata.booking = { version: 1, profile: configuredProfile, phases: solution.phases,
          warnings: solution.warnings, priority_acknowledged: acknowledged === true };
        values.import_metadata = importMetadata;
      }
      if (extraStaff.length) {
        importMetadata.additional_staff = { version: 1, ids: extraStaff,
          names: extraStaff.map(id => context.doctors.get(id)?.name || ''),
          start_at: start.toISOString(), end_at: end.toISOString() };
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
      const rows = occupancyForSolution(solution, mapping.keys).filter((row) => row.installation_id || row.doctor_id || row.resource_kind === 'equipment');
      for (const id of extraStaff) {
        // Full-appointment support replaces a shorter reservation for the same
        // person. One participant never consumes capacity twice in a phase.
        for (let index = rows.length - 1; index >= 0; index--) if (rows[index].doctor_id === id) rows.splice(index, 1);
        rows.push({ phase_key: 'additional_staff', resource_kind: 'doctor', resource_key: `doctor:${id}`,
          doctor_id: id, installation_id: null, start_at: start.toISOString(), end_at: end.toISOString() });
      }
      if (rows.length) await db.AppointmentBookingOccupancy.bulkCreate(rows.map((row) => ({ ...row, appointment_id: appointment.id_cita })), { transaction: tx });
    }
    return appointment;
  };
  return transaction ? execute(transaction) : db.sequelize.transaction({ isolationLevel: 'READ COMMITTED' }, execute);
}

module.exports = { lockBookingResources, mutateAppointmentBooking };
