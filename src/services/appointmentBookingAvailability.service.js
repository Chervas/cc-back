'use strict';

const { addDays } = require('../lib/personal-schedule-recurring');
const { projectPersonalBlocks } = require('../lib/agenda-personal-blocks');
const { resolveLocalInstant } = require('../lib/voucher-schedule-calendar');
const { resolveClinicTimezone, formatDateLocal, formatLocal, dayIndexFromLocalDate,
  buildWindowsFromHorarios, buildDoctorAvailabilityContext, buildDoctorBloqueoRowsForDate,
  hasActiveSchedule, normalizeHms } = require('../lib/availability-calendar');
const { solveBookingProfile, isFree } = require('../lib/booking-profile-solver');
const { bookingProfileDurationMinutes } = require('../lib/booking-profile');
const { bookingPlanHash } = require('../lib/booking-plan-receipt');
const { attentionVisitOrigin } = require('../lib/booking-attention-origin');
const { startConflict, explainUnavailableStart } = require('../lib/booking-grid-diagnostics');
const { normalizeAdditionalStaff } = require('../lib/appointment-additional-staff');
const { installationAllowsStaff } = require('../lib/installation-professionals');
const { installationOverlapCapacity } = require('../lib/installation-overlap');
const { loadEquipmentContext, attachEquipmentContext } = require('./bookingEquipmentAvailability.service');
const { bookingError, bookingCapabilities, resolveAppointmentBookingProfile, loadScopedTreatment, assertTreatmentBookingVisibility } = require('./treatmentBookingProfile.service');

function uniqueIds(values) { return [...new Set(values.map(Number))].sort((a, b) => a - b); }
function verifiedDoctorSchedule(horarios) {
  const active = (horarios || []).filter(row => row.activo === true || row.activo === 1);
  const clock = value => typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value);
  return active.length > 0 && active.every(row => row.dia_semana != null && Number.isInteger(Number(row.dia_semana))
    && Number(row.dia_semana) >= 0 && Number(row.dia_semana) <= 6
    && clock(row.hora_inicio) && clock(row.hora_fin)
    && normalizeHms(row.hora_inicio) < normalizeHms(row.hora_fin));
}

// Internal policy marker only; never expose the source metadata or foreign IDs.
function permitsLegacyOverlap(appointment, clinicId) {
  return Number(appointment?.clinica_id) === Number(clinicId)
    && appointment?.source_system !== 'treatment_program'
    && (appointment?.get ? appointment.get('booking_protected') : appointment?.booking_protected) === 0;
}

const protectedBookingAttribute = (db, alias) => [db.Sequelize.fn('COALESCE', db.Sequelize.fn('JSON_CONTAINS_PATH',
  db.Sequelize.col(`${alias}.import_metadata`), 'one', db.Sequelize.literal("'$.booking'"), db.Sequelize.literal("'$.program_session'"),
  db.Sequelize.literal("'$.additional_staff'")), 0), 'booking_protected'];

const nonShareableBookingAttribute = (db, alias) => [db.Sequelize.literal(`(
  COALESCE(JSON_CONTAINS_PATH(${alias}.import_metadata, 'one', '$.program_session', '$.additional_staff', '$.booking.profile.phases[*].equipment_requirements'), 0)
  OR COALESCE(JSON_CONTAINS(JSON_EXTRACT(${alias}.import_metadata, '$.booking.profile.phases[*].professionals.mode'), '"all"'), 0)
  OR COALESCE(JSON_EXTRACT(${alias}.import_metadata, '$.booking.profile.version'), 0) >= 3
  OR COALESCE(JSON_EXTRACT(${alias}.import_metadata, '$.cliniccloud_source_booking.nonshareable'), 0) = TRUE
)`), 'booking_nonshareable'];
// Calendar-only subtree, not the patient's complete import metadata. Legacy
// snapshots are not read or interpreted as permission to share preparation.
const attentionSnapshotAttribute = (db, alias) => [db.Sequelize.literal(`CASE
  WHEN COALESCE(JSON_EXTRACT(${alias}.import_metadata, '$.booking.profile.version'), 0) = 4
  THEN JSON_EXTRACT(${alias}.import_metadata, '$.booking') ELSE NULL END`), 'booking_attention_snapshot'];
// Bounded calendar evidence for the separate, default-off operator permission.
// It is never a v4 sharing authorization or a request-authored permission.
const legacyAttentionSnapshotAttribute = (db, alias) => [db.Sequelize.literal(`CASE
  WHEN ${alias}.source_system = 'cliniccloud'
    AND COALESCE(JSON_EXTRACT(${alias}.import_metadata, '$.booking.profile.version'), 0) = 3
    AND COALESCE(JSON_CONTAINS_PATH(${alias}.import_metadata, 'one', '$.program_session', '$.additional_staff'), 0) = 0
  THEN JSON_EXTRACT(${alias}.import_metadata, '$.booking') ELSE NULL END`), 'booking_legacy_attention_snapshot'];
// This alias is selected by the server only when the stored profile is v4.
// Invalid or incomplete clinical evidence is still protective, never permission
// to release time. Do not read an identically named key from request metadata.
const protectedAttentionOrigin = row => (row?.get ? row.get('booking_attention_snapshot') : row?.booking_attention_snapshot) != null;
function shareableInterval(row, clinicId) {
  const marker = row?.get ? row.get('booking_nonshareable') : row?.booking_nonshareable;
  return Number(row?.clinica_id) === clinicId && row?.source_system !== 'treatment_program'
    && (marker === 0 || marker === false || (marker == null && permitsLegacyOverlap(row, clinicId)));
}

/** Alias reads only exist behind the explicit migration/deployment gate. */
async function resolveInstallationKeys({ db, clinic, installationIds, transaction, enabled }) {
  const keys = new Map(installationIds.map((id) => [id, `installation:${id}`]));
  if (!enabled || !installationIds.length) return { keys, physicalInstallationIds: installationIds, aliases: [] };
  const { Op } = db.Sequelize;
  const selectedAliases = await db.InstallationPhysicalAlias.findAll({ where: { installation_id: { [Op.in]: installationIds } }, transaction });
  if (selectedAliases.some((row) => !Number(clinic.grupoClinicaId) || Number(row.group_id) !== Number(clinic.grupoClinicaId))) {
    throw bookingError('booking_physical_alias_invalid', 'La equivalencia de cabina no pertenece al grupo de la clínica.');
  }
  const canonicalIds = uniqueIds(installationIds.map((id) => Number(selectedAliases.find((row) => Number(row.installation_id) === id)?.canonical_installation_id || id)));
  const aliases = await db.InstallationPhysicalAlias.findAll({ where: {
    [Op.or]: [{ canonical_installation_id: { [Op.in]: canonicalIds } }, { installation_id: { [Op.in]: canonicalIds } }],
  }, transaction });
  if (aliases.some((row) => Number(row.installation_id) === Number(row.canonical_installation_id)
    || canonicalIds.includes(Number(row.installation_id))
    || Number(row.group_id) !== Number(clinic.grupoClinicaId))) {
    throw bookingError('booking_physical_alias_invalid', 'Las equivalencias de cabinas no admiten cadenas ni grupos distintos.');
  }
  const physicalInstallationIds = uniqueIds([...canonicalIds, ...aliases.map((row) => Number(row.installation_id))]);
  // Validate actual ownership too: a forged group_id in a mapping is not authority.
  if (aliases.length || selectedAliases.length) {
    const physical = await db.Instalacion.findAll({ where: { id: { [Op.in]: physicalInstallationIds } },
      attributes: ['id', 'clinica_id'], include: [{ model: db.Clinica, as: 'clinica', attributes: ['grupoClinicaId'] }], transaction });
    if (physical.length !== physicalInstallationIds.length || physical.some((row) => Number(row.clinica?.grupoClinicaId) !== Number(clinic.grupoClinicaId))) {
      throw bookingError('booking_physical_alias_invalid', 'Todas las cabinas equivalentes deben pertenecer al mismo grupo.');
    }
  }
  physicalInstallationIds.forEach((id) => keys.set(id, `installation:${Number(aliases.find((row) => Number(row.installation_id) === id)?.canonical_installation_id || id)}`));
  return { keys, physicalInstallationIds, aliases };
}

/** Bounded, bulk read model. No patient names, notes, foreign clinic IDs or SQL per candidate. */
async function loadBookingContext({ db, clinic, profile, start, end, transaction = null, ignoreAppointmentId = null,
  occupancyEnabled = false, installationMapping = null, dates = null, patientId = null, additionalStaffIds = [], equipmentEnabled = undefined,
  ignoreAppointmentIds = [], inheritEquipmentAttention = true, includeDiagnosticLabels = false }) {
  const { Op } = db.Sequelize;
  // Server-owned batch only. HTTP callers never forward this option; program
  // continuation derives the IDs from the scoped purchase, not the request.
  if (!Array.isArray(ignoreAppointmentIds) || ignoreAppointmentIds.length > 30
    || ignoreAppointmentIds.some(id => !Number.isSafeInteger(id) || id < 1)) throw bookingError('booking_ignore_invalid','Revisa las citas de la planificación.',null,400);
  const ignored = uniqueIds([...ignoreAppointmentIds, ...(ignoreAppointmentId ? [ignoreAppointmentId] : [])]);
  const ignore = field => ignored.length ? { [field]: ignored.length === 1 ? { [Op.ne]: ignored[0] } : { [Op.notIn]: ignored } } : {};
  const clinicId = Number(clinic.id_clinica);
  const timeZone = resolveClinicTimezone(clinic);
  if (!Number.isFinite(new Date(start).getTime()) || !Number.isFinite(new Date(end).getTime())
    || end <= start || (end - start) > 367 * 86400000) {
    throw bookingError('booking_range_invalid', 'La consulta de disponibilidad no puede superar un año.', null, 400);
  }
  const doctorIds = uniqueIds([...profile.phases.flatMap((phase) => phase.professionals.ids), ...normalizeAdditionalStaff(additionalStaffIds)]);
  const installationIds = uniqueIds(profile.phases.flatMap((phase) => phase.installation_ids));
  const mapping = installationMapping || await resolveInstallationKeys({ db, clinic, installationIds, transaction, enabled: occupancyEnabled });
  const equipmentContext = await loadEquipmentContext({ db, clinic, profile, mapping, transaction, enabled: equipmentEnabled, inheritEquipmentAttention });
  const resources = [...doctorIds.map((id) => `doctor:${id}`), ...new Set(installationIds.map((id) => mapping.keys.get(id))), ...(equipmentContext?.keys || [])];
  const occupancyEnd = equipmentContext ? new Date(new Date(end).getTime() + 120 * 60000) : end;
  const [doctorLinks, installations, clinicHours, doctorBlocks, installationBlocks, legacyAppointments] = await Promise.all([
    db.DoctorClinica.findAll({ where: { clinica_id: clinicId, activo: true, recibe_citas: true, doctor_id: { [Op.in]: doctorIds } },
      include: [{ model: db.DoctorHorario, as: 'horarios', include: [{ model: db.DoctorHorarioExcepcion, as: 'excepciones' }] },
        ...(db.Usuario ? [{ model: db.Usuario, as: 'doctor', attributes: ['id_usuario', 'nombre', 'apellidos'] }] : [])], transaction }),
    db.Instalacion.findAll({ where: { clinica_id: clinicId, activo: true, id: { [Op.in]: installationIds } },
      include: [{ model: db.InstalacionHorario, as: 'horarios' }], transaction }),
    db.ClinicaHorario.findAll({ where: { clinica_id: clinicId }, transaction }),
    db.DoctorBloqueo.findAll({ where: { doctor_id: { [Op.in]: doctorIds }, [Op.or]: [
      { recurrente: 'none', fecha_inicio: { [Op.lt]: end }, fecha_fin: { [Op.gt]: start } },
      { recurrente: { [Op.ne]: 'none' }, fecha_inicio: { [Op.lte]: end } },
    ] }, include: [{ model: db.DoctorBloqueoExcepcion, as: 'excepciones' }], transaction }),
    db.InstalacionBloqueo.findAll({ where: { instalacion_id: { [Op.in]: mapping.physicalInstallationIds },
      fecha_inicio: { [Op.lt]: end }, fecha_fin: { [Op.gt]: start } }, transaction }),
    db.CitaPaciente.findAll({ where: { estado: { [Op.ne]: 'cancelada' }, inicio: { [Op.lt]: end }, fin: { [Op.gt]: start },
      ...ignore('id_cita'),
      [Op.or]: [{ doctor_id: { [Op.in]: doctorIds } }, { instalacion_id: { [Op.in]: mapping.physicalInstallationIds } }],
    }, attributes: ['id_cita', 'clinica_id', 'doctor_id', 'instalacion_id', 'inicio', 'fin', 'source_system',
      ...(includeDiagnosticLabels ? ['tratamiento_id', 'instalacion_id'] : []), attentionSnapshotAttribute(db, 'CitaPaciente'),
      ...(profile.version === 4 ? [legacyAttentionSnapshotAttribute(db, 'CitaPaciente')] : []),
      protectedBookingAttribute(db, 'CitaPaciente'), nonShareableBookingAttribute(db, 'CitaPaciente')], transaction }),
  ]);
  // One physical room has one simultaneous-occupancy policy across aliases.
  const canonicalIds = [...new Set([...mapping.keys.values()].map(key => Number(key.split(':')[1])))];
  const missingCanonicalIds = canonicalIds.filter(id => !installations.some(room => Number(room.id) === id));
  const canonicalRooms = missingCanonicalIds.length ? await db.Instalacion.findAll({ where: { id: { [Op.in]: missingCanonicalIds } },
    attributes: ['id', 'capacidad', 'allow_overlap_confirmation', 'overlap_capacity_unlimited'], transaction }) : [];
  const overlapPolicies = new Map([...installations, ...canonicalRooms].map(room => [Number(room.id), room]));
  const occupancies = occupancyEnabled ? await db.AppointmentBookingOccupancy.findAll({ where: {
    ...ignore('appointment_id'),
    [Op.or]: [
      { resource_key: { [Op.in]: resources }, start_at: { [Op.lt]: occupancyEnd }, end_at: { [Op.gt]: start } },
      // Initial staff work may already have ended while the source visit is
      // still running. Read its origin even for a supporting/non-primary
      // clinician; an interval-only query would invent available capacity.
      { resource_key: { [Op.in]: doctorIds.map(id => `doctor:${id}`) },
        '$appointment.inicio$': { [Op.lt]: end }, '$appointment.fin$': { [Op.gt]: start } },
      // Any occupancy marks this appointment as segmented: do not count the
      // legacy primary cabin/doctor for the entire appointment as well.
      ...(legacyAppointments.length ? [{ appointment_id: { [Op.in]: legacyAppointments.map((row) => row.id_cita) } }] : []),
    ],
  }, include: [{ model: db.CitaPaciente, as: 'appointment', attributes: ['id_cita', 'clinica_id', 'source_system', 'inicio', 'fin',
    ...(includeDiagnosticLabels ? ['tratamiento_id', 'instalacion_id'] : []), attentionSnapshotAttribute(db, 'appointment'),
    ...(profile.version === 4 ? [legacyAttentionSnapshotAttribute(db, 'appointment')] : []),
    protectedBookingAttribute(db, 'appointment'), nonShareableBookingAttribute(db, 'appointment')], required: true, where: { estado: { [Op.ne]: 'cancelada' } } }], transaction }) : [];
  // Optional catalog labels for a read-only grid: one scoped bulk query, never
  // patient/title/note data or labels belonging to a foreign appointment.
  const diagnosticAppointments = includeDiagnosticLabels
    ? [...legacyAppointments, ...occupancies.map(row => row.appointment)].filter(row => Number(row.clinica_id) === clinicId) : [];
  const treatmentIds = uniqueIds(diagnosticAppointments.map(row => row.tratamiento_id).filter(Boolean));
  const diagnosticTreatments = treatmentIds.length ? await db.Tratamiento.findAll({
    where: { id_tratamiento: { [Op.in]: treatmentIds }, [Op.or]: [
      { clinica_id: clinicId }, ...(Number(clinic.grupoClinicaId) ? [{ origen: 'grupo', grupo_clinica_id: Number(clinic.grupoClinicaId) }] : []),
    ] }, attributes: ['id_tratamiento', 'nombre'], transaction,
  }) : [];
  const treatmentNames = new Map(diagnosticTreatments.map(row => [Number(row.id_tratamiento), String(row.nombre || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 160)]));
  const missingLabelRoomIds = uniqueIds(diagnosticAppointments.map(row => row.instalacion_id).filter(Boolean))
    .filter(id => !installations.some(room => Number(room.id) === id));
  const labelRooms = missingLabelRoomIds.length ? await db.Instalacion.findAll({ where: {
    clinica_id: clinicId, id: { [Op.in]: missingLabelRoomIds } }, attributes: ['id', 'nombre'], transaction }) : [];
  const installationNames = new Map([...installations, ...labelRooms].map(room => [Number(room.id), room.nombre || null]));
  const diagnostic = (appointment, first, last) => includeDiagnosticLabels ? {
    kind: Number(appointment.clinica_id) === clinicId ? 'appointment' : 'other_clinic',
    ...(Number(appointment.clinica_id) === clinicId ? { treatment_name: treatmentNames.get(Number(appointment.tratamiento_id)) || null,
      installation_name: installationNames.get(Number(appointment.instalacion_id)) || null,
      clinic_name: clinic.nombre_clinica || null,
      full_interval: +new Date(first) === +new Date(appointment.inicio) && +new Date(last) === +new Date(appointment.fin) } : {}),
    time_range: `${formatLocal(new Date(first), timeZone).slice(11, 16)}–${formatLocal(new Date(last), timeZone).slice(11, 16)}`,
  } : undefined;
  const segmented = new Set(occupancies.map((row) => Number(row.appointment_id)));
  const busy = new Map(resources.map((key) => [key, []]));
  const addBusy = (key, interval) => { if (busy.has(key)) busy.get(key).push(interval); };
  legacyAppointments.filter((row) => !segmented.has(Number(row.id_cita))).forEach((row) => {
    const interval = { start: row.inicio, end: row.fin, appointment_id: Number(row.id_cita), can_share: shareableInterval(row, clinicId), can_force_legacy: permitsLegacyOverlap(row, clinicId),
      ...(protectedAttentionOrigin(row) ? { protected_attention_origin: true } : {}),
      ...(includeDiagnosticLabels ? { diagnostic: diagnostic(row, row.inicio, row.fin) } : {}) };
    addBusy(`doctor:${row.doctor_id}`, interval);
    addBusy(mapping.keys.get(Number(row.instalacion_id)), interval);
  });
  occupancies.forEach((row) => addBusy(row.resource_key, { start: row.start_at, end: row.end_at,
    appointment_id: Number(row.appointment_id), can_share: shareableInterval(row.appointment, clinicId), can_force_legacy: permitsLegacyOverlap(row.appointment, clinicId),
    ...(protectedAttentionOrigin(row.appointment) ? { protected_attention_origin: true } : {}),
    ...(includeDiagnosticLabels ? { diagnostic: diagnostic(row.appointment, row.start_at, row.end_at) } : {}) }));
  const attentionVisits = new Map(doctorIds.map(id => [id, []]));
  const originRows = new Map(doctorIds.map(id => [id, new Map()]));
  for (const row of occupancies) {
    const id = Number(row.doctor_id), appointments = originRows.get(id);
    if (!appointments || row.resource_key !== `doctor:${id}`) continue;
    const appointmentId = Number(row.appointment_id);
    if (!appointments.has(appointmentId)) appointments.set(appointmentId, { appointment: row.appointment, rows: [] });
    appointments.get(appointmentId).rows.push(row);
  }
  for (const id of doctorIds) {
    const origins = new Map();
    for (const [appointmentId, group] of originRows.get(id)) origins.set(appointmentId, {
      ...attentionVisitOrigin({ appointment: group.appointment, doctorId: id, occupancies: group.rows }),
      ...(includeDiagnosticLabels ? { diagnostic: diagnostic(group.appointment, group.appointment.inicio, group.appointment.fin) } : {}),
      ...(protectedAttentionOrigin(group.appointment) ? { protected_attention_origin: true } : {}),
    });
    for (const row of legacyAppointments.filter(row => Number(row.doctor_id) === id && !segmented.has(Number(row.id_cita)))) {
      origins.set(Number(row.id_cita), { appointment_id: Number(row.id_cita), start: row.inicio, end: row.fin,
        clinic_id: Number(row.clinica_id), verified: false, version: null, partial: false, phases: [],
        ...(includeDiagnosticLabels ? { diagnostic: diagnostic(row, row.inicio, row.fin) } : {}),
        ...(protectedAttentionOrigin(row) ? { protected_attention_origin: true } : {}) });
    }
    attentionVisits.set(id, [...origins.values()]);
    if (includeDiagnosticLabels) for (const interval of busy.get(`doctor:${id}`) || []) {
      const origin = origins.get(Number(interval.appointment_id));
      if (interval.diagnostic && origin?.verified === true && origin.phases.some(phase => phase.partial === false
        && +new Date(phase.start) <= +new Date(interval.start) && +new Date(phase.end) >= +new Date(interval.end))) {
        interval.diagnostic = { ...interval.diagnostic, continuous_attention: true };
      }
    }
    // Old destinations cannot opt in to the new rule. A source v4 snapshot may
    // keep partial intervals, but does not grant free time to an older writer.
    if (profile.version < 4) for (const origin of origins.values()) if (origin.protected_attention_origin === true) {
      addBusy(`doctor:${id}`, { start: origin.start, end: origin.end, appointment_id: origin.appointment_id,
        can_share: false, can_force_legacy: false, protected_attention_origin: true });
    }
  }
  installationBlocks.forEach((row) => addBusy(mapping.keys.get(Number(row.instalacion_id)), { start: row.fecha_inicio, end: row.fecha_fin }));
  const doctors = new Map();
  const cabins = new Map();
  let clinicWindows = hasActiveSchedule(clinicHours) ? [] : null;
  const calendarDates = dates ? [...new Set(dates)].sort() : [];
  if (!dates) {
    for (let date = formatDateLocal(start, timeZone); date <= formatDateLocal(end, timeZone); date = addDays(date, 1)) calendarDates.push(date);
  }
  for (const date of calendarDates) {
    const dow = dayIndexFromLocalDate(date);
    if (clinicWindows) clinicWindows.push(...buildWindowsFromHorarios(clinicHours, dow, date, timeZone));
    doctorLinks.forEach((doctor) => {
      const id = Number(doctor.doctor_id);
      if (!doctors.has(id)) doctors.set(id, { name: [doctor.doctor?.nombre, doctor.doctor?.apellidos].filter(Boolean).join(' '),
        clinic_id: clinicId,
        ...(profile.version === 4 ? { schedule_verified: verifiedDoctorSchedule(doctor.horarios), absence_windows: [] } : {}),
        agenda_flexible: require('../lib/flexible-agenda').isFlexibleDoctor(doctor),
        allow_legacy_attention_confirmation: require('../lib/flexible-agenda').isFlexibleDoctor(doctor)
          && (doctor.allow_legacy_attention_confirmation === true || doctor.allow_legacy_attention_confirmation === 1),
        allow_overlap_confirmation: doctor.allow_overlap_confirmation === true || doctor.allow_overlap_confirmation === 1,
        explicit_overlap_policy: doctor.allow_overlap_confirmation != null,
        windows: [], busy: [...(busy.get(`doctor:${id}`) || [])],
        ...(profile.version === 4 ? { attention_visits: attentionVisits.get(id) } : {}) });
      const target = doctors.get(id);
      target.windows.push(...buildDoctorAvailabilityContext({ doctorId: id, clinicaId: clinicId, dc: doctor, dow, fechaLocal: date, timeZone }).docWins);
      const projectedBlocks = buildDoctorBloqueoRowsForDate(doctorBlocks.filter(row => Number(row.doctor_id) === id), date, timeZone);
      target.busy.push(...projectedBlocks.map(row => ({ start: row.fecha_inicio, end: row.fecha_fin })));
      if (profile.version === 4) target.absence_windows.push(...projectedBlocks.filter(row => ['ausencia', 'vacaciones'].includes(row.tipo)
        && (row.clinica_id == null || Number(row.clinica_id) === clinicId || row.aplica_a_todas_clinicas === true || row.aplica_a_todas_clinicas === 1))
        .map(row => ({ start: row.fecha_inicio, end: row.fecha_fin })));
    });
    installations.forEach((installation) => {
      const id = Number(installation.id);
      const physical = overlapPolicies.get(Number(mapping.keys.get(id)?.split(':')[1])) || installation;
      if (!cabins.has(id)) cabins.set(id, { name: installation.nombre || '',
        allow_overlap_confirmation: physical.allow_overlap_confirmation === true || physical.allow_overlap_confirmation === 1,
        explicit_overlap_policy: physical.allow_overlap_confirmation != null,
        overlap_capacity: installationOverlapCapacity(physical),
        profesionales_permitidos: installation.profesionales_permitidos,
        windows: [], ...(includeDiagnosticLabels ? { schedule_windows: [] } : {}), busy: busy.get(mapping.keys.get(id)) || [] });
      if (includeDiagnosticLabels) cabins.get(id).schedule_windows.push(...buildWindowsFromHorarios(installation.horarios || [], dow, date, timeZone));
      if (!additionalStaffIds.length || installationAllowsStaff(installation, additionalStaffIds)) {
        cabins.get(id).windows.push(...buildWindowsFromHorarios(installation.horarios || [], dow, date, timeZone));
      }
    });
  }
  const patientBusy = patientId ? await db.CitaPaciente.findAll({ where: {
    paciente_id: patientId, estado: { [Op.ne]: 'cancelada' }, inicio: { [Op.lt]: end }, fin: { [Op.gt]: start },
    ...ignore('id_cita'),
  }, attributes: ['id_cita', 'clinica_id', 'doctor_id', 'inicio', 'fin', 'estado', 'source_system', 'voucher_id', 'es_provisional',
    nonShareableBookingAttribute(db, 'CitaPaciente'),
    [db.Sequelize.fn('COALESCE', db.Sequelize.fn('JSON_CONTAINS_PATH', db.Sequelize.col('CitaPaciente.import_metadata'),
      'one', db.Sequelize.literal("'$.clinical_component_parent'"), db.Sequelize.literal("'$.clinical_component_children'")), 0), 'patient_overlap_protected'],
  ], transaction }).then(rows => rows.map(row => ({
      start: row.inicio, end: row.fin, appointment_id: Number(row.id_cita), clinic_id: Number(row.clinica_id),
      doctor_id: row.doctor_id == null ? null : Number(row.doctor_id), estado: row.estado,
      source_system: row.source_system, voucher_id: row.voucher_id, es_provisional: row.es_provisional,
      booking_nonshareable: row.get ? row.get('booking_nonshareable') : row.booking_nonshareable,
      patient_overlap_protected: row.get ? row.get('patient_overlap_protected') : row.patient_overlap_protected,
    }))) : [];
  return { doctors, installations: cabins, clinicWindows, installationKeys: mapping.keys, mapping, timeZone, patientBusy,
    ...(includeDiagnosticLabels ? { personalBlocks: projectPersonalBlocks(doctorBlocks.filter(row => doctors.has(Number(row.doctor_id))
      && (row.clinica_id == null || Number(row.clinica_id) === clinicId || row.aplica_a_todas_clinicas === true || row.aplica_a_todas_clinicas === 1)), calendarDates, timeZone) } : {}),
    ...attachEquipmentContext(equipmentContext, cabins, mapping, busy) };
}

async function searchTreatmentSlots({ db, clinic, treatmentId, date, days = 1, stepMinutes = 15, limit = 100,
  doctorId = null, installationId = null, capabilities = bookingCapabilities(), now = new Date(), additionalStaffIds = [],
  patientId = null, existingAppointmentId = null, voucherId = null, durationSelection,
  startingDoctorId = null, startingInstallationId = null, guidedStartLocal = null, guidedSelection = null }) {
  additionalStaffIds = normalizeAdditionalStaff(additionalStaffIds);
  if (additionalStaffIds.length && !capabilities.multi) throw bookingError('booking_profile_runtime_unavailable', 'El personal de apoyo todavía no está activado.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !Number.isInteger(days) || days < 1 || days > 7
    || !Number.isInteger(stepMinutes) || stepMinutes < 5 || stepMinutes > 120
    || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw bookingError('booking_search_invalid', 'Busca de 1 a 7 días, con intervalos de 5 a 120 minutos y hasta 500 resultados.', null, 400);
  }
  const treatment = await loadScopedTreatment({ db, treatmentId, clinic });
  await assertTreatmentBookingVisibility({ db, treatment, existingAppointmentId, now,
    appointmentValues: { clinica_id: clinic.id_clinica, paciente_id: patientId, tratamiento_id: treatmentId, voucher_id: voucherId } });
  const profile = await resolveAppointmentBookingProfile({ db, clinic, treatment, existingAppointmentId, capabilities, durationSelection });
  if (!profile) throw bookingError('booking_profile_missing', 'Este tratamiento todavía no tiene un perfil de agenda.');
  const timeZone = resolveClinicTimezone(clinic);
  const start = resolveLocalInstant(date, '00:00:00', timeZone);
  const end = resolveLocalInstant(addDays(date, days), '00:00:00', timeZone);
  const { restrictionReadProfile } = require('../lib/booking-restriction-confirmation');
  const guided = guidedStartLocal != null || guidedSelection != null;
  let readProfile = restrictionReadProfile(profile, { selections: guided ? guidedSelection || {} : {},
    doctorIds: [startingDoctorId || doctorId].filter(Boolean), installationIds: [startingInstallationId || installationId].filter(Boolean) });
  if (guided) {
    // Two bounded metadata reads per deliberate placement, never per cursor.
    // All candidates still pass the active membership/room/equipment reader.
    const [memberships, rooms] = await Promise.all([
      db.DoctorClinica.findAll({ where: { clinica_id: Number(clinic.id_clinica), activo: true, recibe_citas: true }, attributes: ['doctor_id'] }),
      db.Instalacion.findAll({ where: { clinica_id: Number(clinic.id_clinica), activo: true }, attributes: ['id'] }),
    ]);
    readProfile = restrictionReadProfile(readProfile, { doctorIds: memberships.map(row => Number(row.doctor_id)), installationIds: rooms.map(row => Number(row.id)) });
  }
  const context = await loadBookingContext({ db, clinic, profile: readProfile, start, end, occupancyEnabled: capabilities.simple,
    ignoreAppointmentId: existingAppointmentId, patientId, additionalStaffIds, equipmentEnabled: capabilities.equipment, includeDiagnosticLabels: true });
  if (guidedStartLocal != null || guidedSelection != null) {
    if (days !== 1 || doctorId || installationId || startingDoctorId || startingInstallationId)
      throw bookingError('booking_search_invalid', 'La colocación guiada elige los recursos por paso.', null, 400);
    const result = guidedTreatmentOptions({ profile, context, date, startLocal: guidedStartLocal,
      selections: guidedSelection, now, additionalStaffIds, allowRestrictedPlacement: true });
    return { clinic_id: Number(clinic.id_clinica), treatment_id: Number(treatmentId), timezone: timeZone,
      duration_minutes: bookingProfileDurationMinutes(profile), capabilities, ...result };
  }
  if (profile.phases.length > 1 && (doctorId || installationId)) {
    throw bookingError('booking_search_invalid', 'En una cita por fases elige los profesionales y cabinas por fase.', null, 400);
  }
  const selections = startingResourceSelection(profile, { startingDoctorId, startingInstallationId, doctorId, installationId, allowRestrictedPlacement: true });
  if (!startingDoctorId && !startingInstallationId && profile.phases.length === 1) selections[profile.phases[0].key] = {
    ...(doctorId ? { doctor_id: doctorId } : {}), ...(installationId ? { installation_id: installationId } : {}),
  };
  const slots = solutionsForCalendar({ profile, context, date, days, stepMinutes, limit, selections, now, additionalStaffIds,
    allowConfirmedOverlap: true, allowRestrictionProposals: !!(startingDoctorId || startingInstallationId || doctorId && installationId) });
  return { clinic_id: Number(clinic.id_clinica), treatment_id: Number(treatmentId), timezone: timeZone,
    duration_minutes: bookingProfileDurationMinutes(profile), capabilities, slots };
}

// A prefix is only an intention. Every option solves the WHOLE visit with the
// previous choices fixed; no per-pointer SQL, holds or independent bookings.
function guidedTreatmentOptions({ profile, context, date, startLocal, selections, now = new Date(), additionalStaffIds = [], allowRestrictedPlacement = false }) {
  const invalid = () => bookingError('booking_search_invalid', 'Revisa el orden, la hora y los recursos de los pasos colocados.', null, 400);
  if (typeof startLocal !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d$/.test(startLocal)
    || startLocal.slice(0, 10) !== date || Number(startLocal.slice(-2)) % 5 !== 0) throw invalid();
  if (!selections || typeof selections !== 'object' || Array.isArray(selections)) throw invalid();
  let offset = 0;
  const phases = profile.phases.map((phase, index) => {
    const item = { phase, index, offset: profile.version === 4 ? phase.start_offset_minutes : offset };
    offset += phase.duration_minutes; return item;
  }).sort((a, b) => a.offset - b.offset || a.index - b.index).map(item => item.phase);
  const keys = Object.keys(selections);
  if (!keys.length || keys.length > phases.length || keys.some(key => !phases.slice(0, keys.length).some(phase => phase.key === key))) throw invalid();
  const prefix = Object.create(null);
  for (const phase of phases.slice(0, keys.length)) {
    const choice = selections[phase.key];
    if (!choice || typeof choice !== 'object' || Array.isArray(choice)
      || Object.keys(choice).some(key => !['doctor_id', 'installation_id'].includes(key))
      || !Number.isSafeInteger(choice.installation_id) || !(allowRestrictedPlacement ? context.installations.has(choice.installation_id) : phase.installation_ids.includes(choice.installation_id))
      || phase.professionals.mode === 'any' && (!Number.isSafeInteger(choice.doctor_id) || !(allowRestrictedPlacement ? context.doctors.has(choice.doctor_id) : phase.professionals.ids.includes(choice.doctor_id)))
      || phase.professionals.mode === 'all' && choice.doctor_id != null) throw invalid();
    prefix[phase.key] = { ...choice };
  }
  const next = phases[keys.length] || null;
  const candidates = next ? (allowRestrictedPlacement ? [...context.installations.keys()] : next.installation_ids).flatMap(installation_id =>
    (next.professionals.mode === 'all' ? [null] : allowRestrictedPlacement ? [...context.doctors.keys()] : next.professionals.ids).map(doctor_id => ({ installation_id,
      ...(doctor_id != null ? { doctor_id } : {}) }))) : [null];
  // Bound resource combinations independently of the day grid; never silently
  // truncate feasible alternatives or relax constraints on a large template.
  if (candidates.length > 500) throw bookingError('booking_search_invalid', 'Este paso tiene demasiadas alternativas. Acota sus recursos en el catálogo.', null, 400);
  const fromLocal = startLocal.slice(11);
  const slots = candidates.flatMap(choice => solutionsForCalendar({ profile, context, date, days: 1,
    stepMinutes: 5, limit: 1, fromLocal, exactStartLocal: startLocal, selections: next ? { ...prefix, [next.key]: choice } : prefix,
    now, additionalStaffIds, allowConfirmedOverlap: true, allowRestrictionProposals: allowRestrictedPlacement }));
  return { phase_key: next?.key || null, slots };
}

// A clicked matrix cell binds only the starting phase. Keep subsequent phases
// free for the canonical solver, and never reduce a mandatory ALL team to the
// one member used to display its starting column.
function startingResourceSelection(profile, { startingDoctorId = null, startingInstallationId = null,
  doctorId = null, installationId = null, allowRestrictedPlacement = false } = {}) {
  if (startingDoctorId == null && startingInstallationId == null) return {};
  const invalid = () => bookingError('booking_search_invalid', 'El inicio elegido debe pertenecer al profesional y la sala del primer paso del tratamiento.', null, 400);
  const parse = value => {
    if (value == null) return null;
    if (!['string', 'number'].includes(typeof value) || !/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw invalid();
    return Number(value);
  };
  const staffId = parse(startingDoctorId), roomId = parse(startingInstallationId);
  if (doctorId || installationId) throw invalid();
  const first = profile.version === 4 ? profile.phases.reduce((a, b) => b.start_offset_minutes < a.start_offset_minutes ? b : a) : profile.phases[0];
  if (!allowRestrictedPlacement && (staffId && !first.professionals.ids.includes(staffId) || roomId && !first.installation_ids.includes(roomId))) throw invalid();
  return { [first.key]: { ...(staffId && first.professionals.mode !== 'all' ? { doctor_id: staffId } : {}),
    ...(roomId ? { installation_id: roomId } : {}) } };
}

function solutionsForCalendar({ profile, context, date, days = 1, stepMinutes = 15, limit = 500, selections = {}, now = new Date(), fromLocal = '00:00', toLocal = null, exactStartLocal = null, additionalStaffIds = [], allowConfirmedOverlap = false, allowRestrictionProposals = false, onUnavailable = null, resolveInstant = resolveLocalInstant }) {
  additionalStaffIds = normalizeAdditionalStaff(additionalStaffIds);
  const timeZone = context.timeZone;
  const end = resolveInstant(addDays(date, days), '00:00:00', timeZone);
  const slots = [];
  for (let localDate = date; localDate < addDays(date, days) && slots.length < limit; localDate = addDays(localDate, 1)) {
    for (let minute = 0; minute < 1440 && slots.length < limit; minute += stepMinutes) {
      if (exactStartLocal && `${localDate}T${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}` !== exactStartLocal) continue;
      const localTime = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      if (localTime < fromLocal || (toLocal && localTime >= toLocal)) continue;
      // A bound excludes a start before any resource/solver work. Do not pay
      // the DST conversion cost for hours outside the requested visible range.
      let candidate;
      try { candidate = resolveInstant(localDate, `${localTime}:00`, timeZone); }
      catch (error) { if (error.code === 'voucher_schedule_dst_conflict') continue; throw error; }
      if (candidate < now) {
        onUnavailable?.(candidate, startConflict('past_start', 'Esta hora de inicio ya ha pasado.', 'clinic'));
        continue;
      }
      const strictSolution = solveBookingProfile({ profile, start: candidate, ...context, selections });
      let solution = strictSolution
        || (allowConfirmedOverlap && !additionalStaffIds.length ? solveBookingProfile({ profile, start: candidate, ...context, selections, allowOverlap: true }) : null);
      let restricted = null;
      if (allowRestrictionProposals && (!solution
        || !additionalStaffIds.every(id => isFree(context.doctors.get(id), candidate, new Date(solution.end_at)))
        || (context.patientBusy || []).some(busy => new Date(busy.start) < new Date(solution.end_at) && new Date(busy.end) > candidate))) {
        restricted = require('../lib/booking-restriction-confirmation').assessment({ profile, context, start: candidate, selections, additionalStaffIds,
          canonicalSolution: strictSolution });
        if (restricted.solution) solution = restricted.solution;
      }
      const localEnd = solution ? formatLocal(new Date(solution.end_at), timeZone) : '';
      const patientFree = solution && (restricted || !(context.patientBusy || []).some(busy => new Date(busy.start) < new Date(solution.end_at) && new Date(busy.end) > candidate));
      const supportFree = solution && (restricted || additionalStaffIds.every(id => isFree(context.doctors.get(id), candidate, new Date(solution.end_at))));
      if (patientFree && supportFree && new Date(solution.end_at) <= end && (!toLocal || localEnd <= `${localDate}T${toLocal}`)) slots.push({ ...solution,
        booking_plan_sha256: bookingPlanHash(restricted?.effectiveProfile || profile, solution),
        ...(restricted?.restrictions.length ? { requires_restriction_acknowledgement: true, booking_restrictions: restricted.restrictions } : {}),
        doctor_id: solution.phases[0].doctor_ids[0], installation_id: solution.phases[0].installation_id,
        start_local: formatLocal(new Date(solution.start_at), timeZone), end_local: formatLocal(new Date(solution.end_at), timeZone),
        start_utc: solution.start_at, end_utc: solution.end_at });
      else if (onUnavailable) {
        const duration = bookingProfileDurationMinutes(profile);
        const { assessment, restrictionResourceConflicts } = require('../lib/booking-restriction-confirmation');
        const diagnosed = assessment({ profile, context, start: candidate, selections, additionalStaffIds, canonicalSolution: strictSolution });
        const detailed = restrictionResourceConflicts(diagnosed);
        if (detailed.length) {
          // Preserve established start-position diagnostics (preparation and
          // removal windows, full duration and machine turnaround). Canonical
          // restrictions remain attached for the explanatory confirmation;
          // neither generator reads more data or grants an available slot.
          const existing = explainUnavailableStart({ profile, context, start: candidate, selections, additionalStaffIds,
            allowOverlap: allowConfirmedOverlap && !additionalStaffIds.length });
          const keepMessage = ['clinic_schedule', 'resource_busy', 'staff_intervention', 'equipment_busy'].includes(existing.details.reason_key);
          const replaces = row => existing.details.reason_key === 'clinic_schedule' ? row.code === 'CLINIC_OUT_OF_HOURS'
            : existing.details.reason_key === 'equipment_busy' ? /^EQUIPMENT_(OVERLAP|BLOCKED)$/.test(row.code)
              : existing.resource_type === 'staff' ? /^STAFF_(OVERLAP|BLOCKED)$/.test(row.code) && row.doctor?.id === existing.resource_id
                : existing.resource_type === 'installation' ? /^INSTALLATION_(OVERLAP|BLOCKED)$/.test(row.code) && row.installation?.id === existing.resource_id : false;
          const hoverMessages = keepMessage
            ? [existing.details.message, ...diagnosed.restrictions.filter(row => !replaces(row)).map(row => row.message)]
            : diagnosed.restrictions.map(row => row.message);
          onUnavailable(candidate, { ...detailed[0], details: { ...existing.details, ...detailed[0].details,
          reason_key: ['joint_resources', 'no_combination'].includes(existing.details.reason_key)
            ? detailed[0].details.reason_key : existing.details.reason_key,
          message: [...new Set(hoverMessages)].join('\n'),
          // All reasons already occur once in booking_restrictions. Nesting
          // the full conflict list here would copy that list inside every
          // reason and inflate large agendas quadratically.
          can_place_with_restrictions: !!diagnosed.solution,
          can_confirm_restrictions: diagnosed.canConfirm } });
        }
        else onUnavailable(candidate, solution && (!toLocal || localEnd > `${localDate}T${toLocal}` || new Date(solution.end_at) > end) && patientFree && supportFree
          ? startConflict('duration_outside_range', `No caben ${duration} min completos antes del final del horario mostrado.`, 'clinic', null, duration)
          : solution && !patientFree
            ? startConflict('patient_busy', 'El paciente ya tiene otra cita durante este intervalo.', 'clinic', null, duration)
            : explainUnavailableStart({ profile, context, start: candidate, selections, additionalStaffIds,
              allowOverlap: allowConfirmedOverlap && !additionalStaffIds.length }));
      }
    }
  }
  return slots;
}

module.exports = { resolveInstallationKeys, loadBookingContext, searchTreatmentSlots, solutionsForCalendar,
  guidedTreatmentOptions, startingResourceSelection, permitsLegacyOverlap, protectedBookingAttribute, nonShareableBookingAttribute, shareableInterval };
