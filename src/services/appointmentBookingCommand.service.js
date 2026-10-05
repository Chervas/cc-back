'use strict';

const { solveBookingProfile, occupancyForSolution, isFree } = require('../lib/booking-profile-solver');
const { normalizeBookingProfile } = require('../lib/booking-profile');
const { resolveInstallationKeys, loadBookingContext } = require('./appointmentBookingAvailability.service');
const { bookingError, bookingCapabilities, requireOperationalProfile, loadScopedTreatment, assertPriorityAcknowledgement } = require('./treatmentBookingProfile.service');
const { normalizeAdditionalStaff, additionalStaffSnapshot } = require('../lib/appointment-additional-staff');
const { installationAllowsStaff } = require('../lib/installation-professionals');
const { equipmentIds } = require('../lib/booking-equipment');
const { resourceForConfirmedOverlap, validStaffIntervals, normalizeAttentionPolicy } = require('../lib/booking-attention');
const { importTreatmentPending, importReviewVersion } = require('../lib/appointment-import-review');

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

async function lockExistingBookingResources({ db, resourceKeys, transaction }) {
  if (!transaction) throw new Error('booking_transaction_required');
  for (const key of [...new Set(resourceKeys)].sort()) {
    if (!/^(doctor|installation|patient|equipment):[1-9]\d*$/.test(key)) throw new Error('booking_resource_key_invalid');
    const anchor = await db.AppointmentBookingResource.findByPk(key, { transaction, lock: transaction.LOCK.UPDATE });
    if (!anchor) throw importClassificationError('Falta un anclaje de la reserva original; revisa sus recursos antes de clasificarla.');
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
  const checked = resource => resourceForConfirmedOverlap(resource, start, end, force);
  if ((context.clinicWindows && !isFree({ windows: context.clinicWindows }, start, end))
    || (values.doctor_id && !isFree(checked(context.doctors.get(Number(values.doctor_id))), start, end))
    || (values.instalacion_id && !isFree(checked(context.installations.get(Number(values.instalacion_id))), start, end))) return null;
  return { start_at: start.toISOString(), end_at: end.toISOString(), warnings: [], requires_priority_acknowledgement: false,
    requires_overlap_acknowledgement: force && (
      !!values.doctor_id && !isFree(context.doctors.get(Number(values.doctor_id)), start, end)
      || !!values.instalacion_id && !isFree(context.installations.get(Number(values.instalacion_id)), start, end)),
    phases: [{ key: 'appointment', label: '', start_at: start.toISOString(), end_at: end.toISOString(),
      installation_id: values.instalacion_id ? Number(values.instalacion_id) : null,
      doctor_ids: values.doctor_id ? [Number(values.doctor_id)] : [], staff_time_scope: 'phase' }] };
}

function importClassificationError(message) {
  return bookingError('booking_import_reservation_invalid', message);
}

function phaseFitsClassification(required, actual, { preserveSourceDuration = false, inheritAttention = false } = {}) {
  const duration = (new Date(actual.end_at) - new Date(actual.start_at)) / 60000;
  const staff = required.professionals;
  const doctors = actual.doctor_ids || [];
  const units = (actual.equipment || []).map(unit => Number(unit.id));
  const groups = required.equipment_requirements || [];
  const attentionMatches = inheritAttention && !required.staff_attention
    || JSON.stringify(required.staff_attention || []) === JSON.stringify((actual.staff_attention || []).map(normalizeAttentionPolicy))
      && (required.staff_attention ? validStaffIntervals(actual, required.staff_attention) : !actual.staff_intervals);
  return (preserveSourceDuration || duration === required.duration_minutes)
    && required.installation_ids.includes(Number(actual.installation_id))
    && (staff.mode === 'all'
      ? doctors.length === staff.ids.length && doctors.every(id => staff.ids.includes(Number(id)))
      : doctors.length === 1 && staff.ids.includes(Number(doctors[0])))
    && units.length === groups.length
    && groups.every(group => units.filter(id => group.equipment_ids.includes(id)).length === 1)
    && (actual.staff_time_scope || 'phase') === (staff.mode === 'all' ? 'appointment' : 'phase')
    && attentionMatches;
}

function occupancySignature(rows) {
  return JSON.stringify(rows.map(record => {
    const row = record.toJSON ? record.toJSON() : record;
    return [row.phase_key, row.resource_kind, row.resource_key,
      row.installation_id == null ? null : Number(row.installation_id),
      row.doctor_id == null ? null : Number(row.doctor_id),
      new Date(row.start_at).toISOString(), new Date(row.end_at).toISOString()];
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))));
}

/**
 * Internal classification command, not a booking option or an HTTP flag.
 * The authenticated import-review service owns the decision and audit event.
 * Existing source reservations (including overlaps) are neither released nor
 * re-solved: linking a label must not erase machines, phases or staff windows.
 */
async function classifyImportedAppointment({ db, existingAppointmentId, appointmentValues, expectedVersion,
  transaction: tx, persist, capabilities = bookingCapabilities(), ...unsupported }) {
  if (!capabilities.simple) throw bookingError('booking_profile_runtime_unavailable', 'La reserva de perfiles todavía no está activada.');
  const keys = Object.keys(appointmentValues || {});
  const treatmentChoice = Number.isSafeInteger(appointmentValues?.tratamiento_id) && appointmentValues.tratamiento_id > 0;
  const reviewChoice = ['revision', 'primera_sin_trat'].includes(appointmentValues?.tipo_cita);
  if (!tx || tx.options?.isolationLevel !== 'READ COMMITTED' || !existingAppointmentId
    || Object.keys(unsupported).length || !/^[a-f0-9]{64}$/.test(expectedVersion || '')
    || !Number.isSafeInteger(appointmentValues?.updated_by) || appointmentValues.updated_by < 1
    || treatmentChoice === reviewChoice
    || keys.some(key => !['updated_by', treatmentChoice ? 'tratamiento_id' : 'tipo_cita'].includes(key))) {
    throw bookingError('booking_import_invalid', 'La clasificación no puede modificar la reserva de la cita.', null, 400);
  }
  const existing = await db.CitaPaciente.findByPk(existingAppointmentId, { transaction: tx, lock: tx.LOCK.UPDATE });
  if (!existing) throw bookingError('appointment_not_found', 'Cita no encontrada.', null, 404);
  const previous = existing.toJSON ? existing.toJSON() : existing;
  const metadata = metadataObject(previous.import_metadata);
  if (!importTreatmentPending(previous) || metadata.import_treatment_resolution || previous.voucher_id
    || metadata.program_session || previous.es_provisional || previous.hold_expires_at
    || ['cancelada', 'completada', 'no_asistio'].includes(previous.estado)) {
    throw bookingError('booking_import_not_resolvable', 'Esta acción solo clasifica citas importadas abiertas sin tratamiento ni programa.');
  }
  if (importReviewVersion(previous) !== expectedVersion) {
    throw bookingError('booking_import_changed', 'La cita ha cambiado. Vuelve a abrirla antes de confirmar.');
  }
  const clinic = await db.Clinica.findByPk(previous.clinica_id, { transaction: tx, lock: tx.LOCK.SHARE });
  if (!clinic) throw bookingError('clinic_not_found', 'Clínica no encontrada.', null, 404);
  if (treatmentChoice) await db.Tratamiento.findByPk(appointmentValues.tratamiento_id, { transaction: tx, lock: tx.LOCK.SHARE });
  const treatment = treatmentChoice ? await loadScopedTreatment({ db, treatmentId: appointmentValues.tratamiento_id,
    clinic, transaction: tx }) : null;
  const historical = treatment && require('../lib/historical-treatment-reference').isHistoricalTreatment(treatment);
  // A historical label is bound to this exact source reservation, never an
  // inactive-catalog bypass for ordinary bookings or a clinical authorization.
  if (historical) require('../lib/historical-treatment-reference').assertReviewedHistoricalTreatment({ treatment, row: previous });
  if (treatment && !historical && ![true, 1].includes(treatment.activo)) {
    throw bookingError('treatment_not_bookable', 'Selecciona un tratamiento activo.');
  }
  const required = historical ? null : requireOperationalProfile(treatment, { capabilities });
  const booking = metadata.booking;
  const profile = booking?.profile && requireOperationalProfile({ activo: true,
    clinical_config: { booking_profile: booking.profile } }, { capabilities });
  const phases = booking?.phases;
  if (!profile || !Array.isArray(phases) || phases.length !== profile.phases.length
    || new Date(previous.fin) <= new Date(previous.inicio)) {
    throw importClassificationError('Revisa la reserva original antes de vincular el tratamiento.');
  }
  for (let index = 0; index < phases.length; index++) {
    const phase = phases[index];
    const start = index ? phases[index - 1].end_at : previous.inicio;
    if (phase.key !== profile.phases[index].key || !phaseFitsClassification(profile.phases[index], phase)
      || new Date(phase.start_at).getTime() !== new Date(start).getTime()
      || !Number.isFinite(new Date(phase.end_at).getTime())) {
      throw importClassificationError('Las fases originales necesitan revisión; no se ha cambiado la reserva.');
    }
  }
  if (new Date(phases.at(-1).end_at).getTime() !== new Date(previous.fin).getTime()
    || Number(phases[0].installation_id) !== Number(previous.instalacion_id)
    || Number(phases[0].doctor_ids[0]) !== Number(previous.doctor_id)) {
    throw importClassificationError('La reserva original no coincide con el horario, profesional o cabina de la cita.');
  }
  if (required && (required.phases.length !== phases.length
    || required.phases.some((phase, index) => !phaseFitsClassification(phase, phases[index],
      { preserveSourceDuration: true, inheritAttention: true })))) {
    throw bookingError('booking_import_profile_mismatch',
      'El tratamiento requiere otra reserva. Revisa sus fases y recursos desde Editar antes de vincularlo.');
  }
  const support = additionalStaffSnapshot(previous);
  if (metadata.additional_staff && !support) throw importClassificationError('Revisa el personal de apoyo de la reserva original.');
  const occupancies = await db.AppointmentBookingOccupancy.findAll({ where: { appointment_id: existingAppointmentId },
    transaction: tx, lock: tx.LOCK.SHARE });
  const installationIds = [...new Set(phases.map(phase => Number(phase.installation_id)))];
  const mapping = await resolveInstallationKeys({ db, clinic, installationIds, transaction: tx, enabled: true });
  const expected = occupancyForSolution({ start_at: previous.inicio, end_at: previous.fin, phases }, mapping.keys);
  for (const id of support?.ids || []) {
    for (let index = expected.length - 1; index >= 0; index--) if (expected[index].doctor_id === id) expected.splice(index, 1);
    expected.push({ phase_key: 'additional_staff', resource_kind: 'doctor', resource_key: `doctor:${id}`,
      doctor_id: id, installation_id: null, start_at: previous.inicio, end_at: previous.fin });
  }
  if (!occupancies.length || occupancySignature(expected) !== occupancySignature(occupancies)) {
    throw importClassificationError('La ocupación de la reserva original necesita revisión; no se han cambiado sus recursos.');
  }
  await lockExistingBookingResources({ db, resourceKeys: [...occupancies.map(row => row.resource_key),
    ...expected.map(row => row.resource_key), `patient:${previous.paciente_id}`], transaction: tx });
  // No occupancy UPDATE/DELETE/INSERT, availability search, force or completion
  // hooks. Preserve even the original occupancy row IDs and all HOLD evidence.
  return persist({ values: { ...previous, ...appointmentValues }, existing, transaction: tx, solution: null,
    ...(historical ? { classification: 'historical_reference' } : {}) });
}

/**
 * Only persistence callback and occupancy are inside the transaction. Callers
 * run existing consent/automation/socket hooks ONCE after this function commits.
 * This command is dormant until the entire shared-DB writer/read path is promoted.
 */
async function mutateAppointmentBooking({ db, appointmentValues, existingAppointmentId = null, persist,
  priorityAcknowledged = false, selections = {}, transaction = null, capabilities = bookingCapabilities(),
  allowObsolete = false, stateOnly = false, trustedProgramSession = null, preparedContext = null, force = false,
  additionalStaffIds = undefined, supportOnly = false, expectedRange = null, importEquipmentAssignment = null,
  trustedProgramSeries = null }) {
  if (!capabilities.simple) throw bookingError('booking_profile_runtime_unavailable', 'La reserva de perfiles todavía no está activada.');
  // Internal documentary reconciliation only, never forwarded from an HTTP
  // payload. Same command/locks/occupancy as normal booking; no extra read on
  // ordinary appointments. Derive the profile from the locked source row.
  if (importEquipmentAssignment && (!transaction || !existingAppointmentId || stateOnly || supportOnly || force
    || trustedProgramSession || trustedProgramSeries || preparedContext || additionalStaffIds !== undefined
    || Object.keys(appointmentValues || {}).length || Object.keys(selections || {}).length
    || !capabilities.multi || capabilities.equipment !== true)) {
    throw bookingError('booking_import_equipment_invalid', 'La conciliación de maquinaria no puede modificar otros datos de la cita.');
  }
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
    const preparedSeries = trustedProgramSeries
      ? require('../lib/program-replan').assertSeriesContext(trustedProgramSeries, {
        transaction:tx,session:session || trustedProgramSession,existing,values }) : null;
    if (preparedSeries && (!transaction || !preparedContext || stateOnly || supportOnly || force)) throw new Error('program_series_context_invalid');
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
        let series=preparedSeries?.series, timeZone=preparedSeries?.timeZone;
        if (!series) {
          const records = await db.PatientProgramSession.findAll({ where: { voucher_id: session.voucher_id }, order: [['position', 'ASC']], transaction: tx });
          const appointments = await db.CitaPaciente.findAll({ where: { voucher_id: session.voucher_id, estado: { [db.Sequelize.Op.notIn]: ['cancelada','no_asistio'] } }, transaction: tx });
          series = records.map(record => {
            const appointment = Number(record.id) === Number(session.id) ? values : appointments.find(row => Number(row.id_cita) === Number(record.appointment_id));
            return { key: record.session_key, offset_days: metadataObject(record.snapshot).offset_days, start_at: appointment?.inicio, end_at: appointment?.fin };
          });
          const clinic = await db.Clinica.findByPk(values.clinica_id, { transaction: tx });
          timeZone = require('../lib/availability-calendar').resolveClinicTimezone(clinic);
        }
        const issues = require('../lib/program-booking').seriesIssues(series, metadataObject(session.snapshot).program_cadence, timeZone);
        if (issues.length) throw bookingError('program_cadence_conflict', 'El cambio no respeta el orden o la pauta del programa.', { issues });
      }
    } else if (existing && require('../lib/program-appointment-context').hasProgramAppointmentReference(previous)) {
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
    // Reciprocal clinical-component receipts and their audit are server-owned.
    // A generic edit preserves the receipt; a source/resource change will make
    // its fingerprint invalid and require review rather than authorizing care.
    for (const key of ['clinical_component_parent', 'clinical_component_children']) {
      delete importMetadata[key];
      if (previousMetadata[key]) importMetadata[key] = previousMetadata[key];
    }
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
    if (importEquipmentAssignment) {
      const catalogProfile = requireOperationalProfile(treatment, { capabilities, allowObsolete });
      if (catalogProfile || session) throw bookingError('booking_import_equipment_invalid',
        'Esta cita ya utiliza un perfil de tratamiento o programa; revisa su reserva sin sustituirla.');
      configuredProfile = require('../lib/appointment-import-equipment').importedEquipmentProfile(previous, importEquipmentAssignment);
    } else if (trustedProgramSession || session) {
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
      const context = ((!extraStaff.length || preparedSeries) && preparedContext) || await loadBookingContext({ db, clinic, profile, start, end, transaction: tx,
        ignoreAppointmentId: existing?.id_cita, occupancyEnabled: true, installationMapping: mapping, patientId: values.paciente_id,
        additionalStaffIds: extraStaff, equipmentEnabled: capabilities.equipment,
        inheritEquipmentAttention: !snapshot || Number(previous.tratamiento_id) !== Number(values.tratamiento_id) || configuredProfile?.version === 3 });
      const existingSelections = previousMetadata.booking?.phases && configuredProfile
        ? Object.fromEntries(previousMetadata.booking.phases.map((phase) => [phase.key, {
          installation_id: phase.installation_id,
          ...((session ? normalizeBookingProfile(previousMetadata.booking.profile) : configuredProfile)?.phases.find((candidate) => candidate.key === phase.key)?.professionals.mode === 'any'
            ? { doctor_id: phase.doctor_ids?.[0] } : {}),
        }])) : null;
      let chosen = Object.keys(selections || {}).length ? selections
        : (configuredProfile?.phases.length === 1 && configuredProfile.phases[0].professionals.mode === 'any'
          ? { [configuredProfile.phases[0].key]: { doctor_id: values.doctor_id, installation_id: values.instalacion_id } }
          : existingSelections || {});
      if (session || trustedProgramSession) {
        chosen = require('../lib/program-appointment-link').programBookingSelections(
          metadataObject((session || trustedProgramSession).snapshot), previous, chosen);
      }
      const supportFree = extraStaff.every(id => isFree(context.doctors.get(id), start, end));
      const permitsProfileForce = !extraStaff.length && !session && !trustedProgramSession && !preparedSeries;
      solution = supportFree ? (configuredProfile ? solveBookingProfile({ profile, start, ...context, selections: chosen, allowOverlap: permitsProfileForce && force === true })
        : solveLegacy(values, context, !extraStaff.length && force === true)) : null;
      if (solution && extraStaff.length && solution.phases.some(phase =>
        !require('../lib/installation-professionals').installationAllowsStaff(context.installations.get(phase.installation_id),extraStaff))) solution=null;
      const patientConflict = (context.patientBusy || []).some(busy => new Date(busy.start) < end && new Date(busy.end) > start);
      if (!solution || patientConflict || new Date(solution.end_at).getTime() !== end.getTime()) {
        // Re-evaluated under the same resource locks. Force is only available
        // between ordinary appointments in this clinic, never for machinery,
        // mandatory team, blocked schedule, foreign clinic or patient overlap.
        const canForce = !extraStaff.length && !patientConflict && (configuredProfile
          ? permitsProfileForce && !!solveBookingProfile({ profile, start, ...context, selections: chosen, allowOverlap: true })
          : !!solveLegacy(values, context, true));
        throw bookingError('booking_unavailable', 'El hueco ya no está disponible o no cumple el perfil del tratamiento. Actualiza las propuestas.', { can_force: canForce });
      }
      const acknowledged = priorityAcknowledged || (supportOnly && previousMetadata.booking?.priority_acknowledged === true);
      assertPriorityAcknowledgement(solution, acknowledged);
      if (configuredProfile) {
        values.doctor_id = solution.phases[0].doctor_ids[0];
        values.instalacion_id = solution.phases[0].installation_id;
        const frozenProfile = solution.phases.some(phase => phase.staff_attention) ? normalizeBookingProfile({
          ...configuredProfile, version: 3,
          phases: configuredProfile.phases.map((phase, index) => ({ ...phase,
            ...(solution.phases[index].staff_attention ? { staff_attention: solution.phases[index].staff_attention } : {}) })),
        }) : configuredProfile;
        importMetadata.booking = { version: 1, profile: frozenProfile, phases: solution.phases,
          warnings: solution.warnings, priority_acknowledged: acknowledged === true,
          ...(solution.requires_overlap_acknowledgement ? { overlap_confirmed: true, overlap_confirmed_by: values.updated_by || values.created_by || null } : {}) };
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

module.exports = { lockBookingResources, lockExistingBookingResources, mutateAppointmentBooking, classifyImportedAppointment };
