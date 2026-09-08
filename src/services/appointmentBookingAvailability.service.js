'use strict';

const { addDays } = require('../lib/personal-schedule-recurring');
const { resolveLocalInstant } = require('../lib/voucher-schedule-calendar');
const { resolveClinicTimezone, formatDateLocal, formatLocal, dayIndexFromLocalDate,
  buildWindowsFromHorarios, buildDoctorAvailabilityContext, buildDoctorBloqueoRowsForDate,
  hasActiveSchedule } = require('../lib/availability-calendar');
const { solveBookingProfile } = require('../lib/booking-profile-solver');
const { bookingError, bookingCapabilities, requireOperationalProfile, loadScopedTreatment } = require('./treatmentBookingProfile.service');

function uniqueIds(values) { return [...new Set(values.map(Number))].sort((a, b) => a - b); }

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
  occupancyEnabled = false, installationMapping = null, dates = null }) {
  const { Op } = db.Sequelize;
  const clinicId = Number(clinic.id_clinica);
  const timeZone = resolveClinicTimezone(clinic);
  if (!Number.isFinite(new Date(start).getTime()) || !Number.isFinite(new Date(end).getTime())
    || end <= start || (end - start) > 367 * 86400000) {
    throw bookingError('booking_range_invalid', 'La consulta de disponibilidad no puede superar un año.', null, 400);
  }
  const doctorIds = uniqueIds(profile.phases.flatMap((phase) => phase.professionals.ids));
  const installationIds = uniqueIds(profile.phases.flatMap((phase) => phase.installation_ids));
  const mapping = installationMapping || await resolveInstallationKeys({ db, clinic, installationIds, transaction, enabled: occupancyEnabled });
  const resources = [...doctorIds.map((id) => `doctor:${id}`), ...new Set(installationIds.map((id) => mapping.keys.get(id)))];
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
      ...(ignoreAppointmentId ? { id_cita: { [Op.ne]: ignoreAppointmentId } } : {}),
      [Op.or]: [{ doctor_id: { [Op.in]: doctorIds } }, { instalacion_id: { [Op.in]: mapping.physicalInstallationIds } }],
    }, attributes: ['id_cita', 'doctor_id', 'instalacion_id', 'inicio', 'fin'], transaction }),
  ]);
  const occupancies = occupancyEnabled ? await db.AppointmentBookingOccupancy.findAll({ where: {
    ...(ignoreAppointmentId ? { appointment_id: { [Op.ne]: ignoreAppointmentId } } : {}),
    [Op.or]: [
      { resource_key: { [Op.in]: resources }, start_at: { [Op.lt]: end }, end_at: { [Op.gt]: start } },
      // Any occupancy marks this appointment as segmented: do not count the
      // legacy primary cabin/doctor for the entire appointment as well.
      ...(legacyAppointments.length ? [{ appointment_id: { [Op.in]: legacyAppointments.map((row) => row.id_cita) } }] : []),
    ],
  }, include: [{ model: db.CitaPaciente, as: 'appointment', attributes: [], required: true, where: { estado: { [Op.ne]: 'cancelada' } } }], transaction }) : [];
  const segmented = new Set(occupancies.map((row) => Number(row.appointment_id)));
  const busy = new Map(resources.map((key) => [key, []]));
  const addBusy = (key, interval) => { if (busy.has(key)) busy.get(key).push(interval); };
  legacyAppointments.filter((row) => !segmented.has(Number(row.id_cita))).forEach((row) => {
    const interval = { start: row.inicio, end: row.fin };
    addBusy(`doctor:${row.doctor_id}`, interval);
    addBusy(mapping.keys.get(Number(row.instalacion_id)), interval);
  });
  occupancies.forEach((row) => addBusy(row.resource_key, { start: row.start_at, end: row.end_at }));
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
        windows: [], busy: [...(busy.get(`doctor:${id}`) || [])] });
      const target = doctors.get(id);
      target.windows.push(...buildDoctorAvailabilityContext({ doctorId: id, clinicaId: clinicId, dc: doctor, dow, fechaLocal: date, timeZone }).docWins);
      target.busy.push(...buildDoctorBloqueoRowsForDate(doctorBlocks.filter((row) => Number(row.doctor_id) === id), date, timeZone)
        .map((row) => ({ start: row.fecha_inicio, end: row.fecha_fin })));
    });
    installations.forEach((installation) => {
      const id = Number(installation.id);
      if (!cabins.has(id)) cabins.set(id, { name: installation.nombre || '', windows: [], busy: busy.get(mapping.keys.get(id)) || [] });
      cabins.get(id).windows.push(...buildWindowsFromHorarios(installation.horarios || [], dow, date, timeZone));
    });
  }
  return { doctors, installations: cabins, clinicWindows, installationKeys: mapping.keys, mapping, timeZone };
}

async function searchTreatmentSlots({ db, clinic, treatmentId, date, days = 1, stepMinutes = 15, limit = 100,
  doctorId = null, installationId = null, capabilities = bookingCapabilities(), now = new Date() }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date)) || !Number.isInteger(days) || days < 1 || days > 7
    || !Number.isInteger(stepMinutes) || stepMinutes < 5 || stepMinutes > 120
    || !Number.isInteger(limit) || limit < 1 || limit > 500) {
    throw bookingError('booking_search_invalid', 'Busca de 1 a 7 días, con intervalos de 5 a 120 minutos y hasta 500 resultados.', null, 400);
  }
  const treatment = await loadScopedTreatment({ db, treatmentId, clinic });
  const profile = requireOperationalProfile(treatment, { capabilities });
  if (!profile) throw bookingError('booking_profile_missing', 'Este tratamiento todavía no tiene un perfil de agenda.');
  const timeZone = resolveClinicTimezone(clinic);
  const start = resolveLocalInstant(date, '00:00:00', timeZone);
  const end = resolveLocalInstant(addDays(date, days), '00:00:00', timeZone);
  const context = await loadBookingContext({ db, clinic, profile, start, end, occupancyEnabled: capabilities.simple });
  if (profile.phases.length > 1 && (doctorId || installationId)) {
    throw bookingError('booking_search_invalid', 'En una cita por fases elige los profesionales y cabinas por fase.', null, 400);
  }
  const selections = profile.phases.length === 1 ? { [profile.phases[0].key]: {
    ...(doctorId ? { doctor_id: doctorId } : {}), ...(installationId ? { installation_id: installationId } : {}),
  } } : {};
  const slots = solutionsForCalendar({ profile, context, date, days, stepMinutes, limit, selections, now });
  return { clinic_id: Number(clinic.id_clinica), treatment_id: Number(treatmentId), timezone: timeZone,
    duration_minutes: profile.phases.reduce((sum, phase) => sum + phase.duration_minutes, 0), capabilities, slots };
}

function solutionsForCalendar({ profile, context, date, days = 1, stepMinutes = 15, limit = 500, selections = {}, now = new Date(), fromLocal = '00:00', toLocal = null }) {
  const timeZone = context.timeZone;
  const end = resolveLocalInstant(addDays(date, days), '00:00:00', timeZone);
  const slots = [];
  for (let localDate = date; localDate < addDays(date, days) && slots.length < limit; localDate = addDays(localDate, 1)) {
    for (let minute = 0; minute < 1440 && slots.length < limit; minute += stepMinutes) {
      let candidate;
      try { candidate = resolveLocalInstant(localDate, `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`, timeZone); }
      catch (error) { if (error.code === 'voucher_schedule_dst_conflict') continue; throw error; }
      if (candidate < now) continue;
      const localTime = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
      if (localTime < fromLocal || (toLocal && localTime >= toLocal)) continue;
      const solution = solveBookingProfile({ profile, start: candidate, ...context, selections });
      const localEnd = solution ? formatLocal(new Date(solution.end_at), timeZone) : '';
      if (solution && new Date(solution.end_at) <= end && (!toLocal || localEnd <= `${localDate}T${toLocal}`)) slots.push({ ...solution,
        doctor_id: solution.phases[0].doctor_ids[0], installation_id: solution.phases[0].installation_id,
        start_local: formatLocal(new Date(solution.start_at), timeZone), end_local: formatLocal(new Date(solution.end_at), timeZone),
        start_utc: solution.start_at, end_utc: solution.end_at });
    }
  }
  return slots;
}

module.exports = { resolveInstallationKeys, loadBookingContext, searchTreatmentSlots, solutionsForCalendar };
