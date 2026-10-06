const asyncHandler = require('express-async-handler');
const db = require('../../models');
const { Op } = db.Sequelize;
const { assertUserCanAccessFeature } = require('../lib/access-policy');
const { searchTreatmentSlots, loadBookingContext, solutionsForCalendar } = require('../services/appointmentBookingAvailability.service');
const { addDays } = require('../lib/personal-schedule-recurring');
const { resolveLocalInstant } = require('../lib/voucher-schedule-calendar');
const { solveBookingProfile, isFree } = require('../lib/booking-profile-solver');
const { resourceForConfirmedOverlap } = require('../lib/booking-attention');
const { incompatibleStart, appendStartInterval } = require('../lib/booking-grid-diagnostics');

function confirmedOverlapRows(rows, start, end, clinicId) {
  const resource = {
    busy: rows.map(row => ({ start: row.inicio, end: row.fin, appointment_id: row.id_cita,
      can_share: Number(row.clinica_id) === Number(clinicId) && (row.can_share === true || (row.can_share == null && row.can_force_legacy !== false)) })) };
  return resourceForConfirmedOverlap(resource, start, end, true).busy.length === 0;
}
const { normalizeAdditionalStaff } = require('../lib/appointment-additional-staff');
const { bookingCapabilities, bookingError, loadScopedTreatment, requireOperationalProfile } = require('../services/treatmentBookingProfile.service');
const { resourceAppointments, resourceInstallationBlocks } = require('../services/appointmentResourceCalendar.service');
const { buildLegacySlots, loadLegacyAvailabilitySnapshot } = require('../lib/availability-request-snapshot');
const { allowFlexibleConflicts } = require('../lib/flexible-agenda');
const { supportConflictsForSlot, installationStaffConflicts } = require('../lib/availability-support-conflicts');
const {
  parseClinicConfig,
  isValidTimeZone,
  resolveClinicTimezone,
  formatPartsInTimeZone,
  offsetMinutesForTimeZone,
  normalizeHms,
  localDateTimeToUtc,
  formatDateLocal,
  parseDateTime,
  formatLocal,
  buildWindowsFromHorarios,
  buildDoctorBloqueoRowsForDate,
  hasActiveSchedule,
  normalizeRecibeCitas,
  mergeWindows,
  buildDoctorAvailabilityContext,
  inAnyWindow,
} = require('../lib/availability-calendar');

const DEFAULT_TIMEZONE = 'Europe/Madrid';
const ACTIVE_APPOINTMENT_WHERE = { estado: { [Op.ne]: 'cancelada' } };

// A single phase can be painted in the ordinary agenda even when it requires
// equipment. Use the canonical solver, including its machine occupancy checks.
// Multi-phase/all-staff bookings still use the explicit treatment planner.
function assertGridProfile(profile) {
  if (profile.phases.length !== 1 || (profile.phases[0].professionals.mode === 'all'
    && profile.phases[0].professionals.ids.length > 1)) {
    throw bookingError('booking_profile_use_treatment_slots',
      'Este tratamiento usa varias fases o profesionales simultáneos. Utiliza la búsqueda de huecos del tratamiento.');
  }
}

function profileSlotsPayload({ query, profile, context, clinic, additionalStaffIds }) {
  assertGridProfile(profile);
  const stepMin = parseIntSafe(query.granularity_min) || 15;
  if (stepMin < 5 || stepMin > 120) throw Object.assign(Error('granularity_min debe estar entre 5 y 120'), { statusCode: 400 });
  const installationIds = parseIntArray(query.instalacion_ids || query['instalacion_ids[]']);
  const professionalIds = parseIntArray(query.doctor_ids || query['doctor_ids[]']);
  if (installationIds.length > 50 || professionalIds.length > 50 || (installationIds.length && professionalIds.length)
    || (installationIds.length && (!query.doctor_id || query.instalacion_id))
    || (professionalIds.length && (!query.instalacion_id || query.doctor_id))) {
    throw Object.assign(Error('Batch de cabinas/profesionales inválido'), { statusCode: 400 });
  }
  const phase = profile.phases[0];
  const timeZone = resolveClinicTimezone(clinic);
  const rangeEnd = query.to_local ? resolveLocalInstant(query.fecha_local, `${query.to_local}:00`, timeZone)
    : resolveLocalInstant(addDays(query.fecha_local, 1), '00:00:00', timeZone);
  const getResult = (doctor, installation) => {
    const unavailable = [];
    const includeUnavailable = parseBool(query.include_unavailable) && query.summary_only !== true;
    // Skip incompatible columns before iterating times; no SQL per column/slot.
    if ((doctor && !phase.professionals.ids.includes(doctor))
      || (installation && !phase.installation_ids.includes(installation))) {
      if (includeUnavailable) appendStartInterval(unavailable,
        resolveLocalInstant(query.fecha_local, `${query.from_local || '00:00'}:00`, response.timezone),
        rangeEnd,
        incompatibleStart(profile, doctor, installation), response.timezone, formatLocal);
      return { slots: [], unavailable };
    }
    const slots = solutionsForCalendar({ profile, context, date: query.fecha_local, stepMinutes: stepMin,
      limit: Math.min(parseIntSafe(query.limit) > 0 ? parseIntSafe(query.limit) : 500, 500), additionalStaffIds,
      allowConfirmedOverlap: true,
      selections: { [phase.key]: { doctor_id: doctor, installation_id: installation } },
      fromLocal: typeof query.from_local === 'string' ? query.from_local : '00:00',
      toLocal: typeof query.to_local === 'string' ? query.to_local : null,
      onUnavailable: includeUnavailable ? (start, conflict) => appendStartInterval(unavailable, start,
        new Date(Math.min(+start + stepMin * 60000, +rangeEnd)), conflict, response.timezone, formatLocal) : null });
    return { slots, unavailable };
  };
  const response = { timezone: resolveClinicTimezone(clinic), clinica_id: Number(clinic.id_clinica),
    fecha_local: query.fecha_local, duracion_min: phase.duration_minutes, granularity_min: stepMin };
  if (query.summary_only === true) {
    const pairs = installationIds.length ? installationIds.map(id => [Number(query.doctor_id), id])
      : professionalIds.length ? professionalIds.map(id => [id, Number(query.instalacion_id)])
        : [[query.doctor_id ? Number(query.doctor_id) : null, query.instalacion_id ? Number(query.instalacion_id) : null]];
    for (const [doctor, installation] of pairs) {
      const { slots } = getResult(doctor, installation);
      if (slots.length) return { ...response, slots };
    }
    return { ...response, slots: [] };
  }
  if (installationIds.length) {
    const pairs = installationIds.map(id => [id, getResult(Number(query.doctor_id), id)]);
    return { ...response, doctor_id: Number(query.doctor_id), instalacion_ids: installationIds,
      slots_by_instalacion: Object.fromEntries(pairs.map(([id, value]) => [id, value.slots])),
      unavailable_by_instalacion: Object.fromEntries(pairs.map(([id, value]) => [id, value.unavailable])) };
  }
  if (professionalIds.length) {
    const pairs = professionalIds.map(id => [id, getResult(id, Number(query.instalacion_id))]);
    return { ...response, instalacion_id: Number(query.instalacion_id), doctor_ids: professionalIds,
      slots_by_doctor: Object.fromEntries(pairs.map(([id, value]) => [id, value.slots])),
      unavailable_by_doctor: Object.fromEntries(pairs.map(([id, value]) => [id, value.unavailable])) };
  }
  const result = getResult(query.doctor_id ? Number(query.doctor_id) : null, query.instalacion_id ? Number(query.instalacion_id) : null);
  return { ...response, slots: result.slots, unavailable_intervals: result.unavailable };
}

exports.bookingCapabilities = asyncHandler(async (req, res) => res.json(bookingCapabilities()));

function requestedAdditionalStaff(req) {
  const ids = normalizeAdditionalStaff(req.query?.additional_staff_ids ?? req.query?.['additional_staff_ids[]']) || [];
  if (ids.length && !bookingCapabilities().multi) throw bookingError('booking_profile_runtime_unavailable', 'El personal de apoyo todavía no está activado.');
  return ids;
}

exports.treatmentSlots = asyncHandler(async (req, res) => {
  const clinicId = Number(req.query?.clinica_id);
  if (!Number.isSafeInteger(clinicId) || clinicId <= 0) return res.status(400).json({ message: 'clinica_id requerido' });
  await assertUserCanAccessFeature({ actorId: Number(req.userData?.userId), featureKey: 'appointments.view', clinicId });
  const clinic = await db.Clinica.findByPk(clinicId);
  if (!clinic) return res.status(404).json({ message: 'Clínica no encontrada' });
  return res.json(await searchTreatmentSlots({ db, clinic, treatmentId: req.query?.tratamiento_id,
    date: req.query?.fecha_local, days: Number(req.query?.days || 1), stepMinutes: Number(req.query?.granularity_min || 15),
    limit: Number(req.query?.limit || 100), doctorId: req.query?.doctor_id ? Number(req.query.doctor_id) : null,
    installationId: req.query?.instalacion_id ? Number(req.query.instalacion_id) : null,
    additionalStaffIds: requestedAdditionalStaff(req) }));
});

const parseBool = (v) => v === true || v === 'true' || v === '1';

const overlap = (startA, endA, startB, endB) => startA < endB && startB < endA;

const dayIndexFromLocalDate = (fechaLocal) => new Date(`${fechaLocal}T12:00:00Z`).getUTCDay();

const parseIntSafe = (v) => {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
};

const parseIntArray = (value) => {
  if (value == null) return [];
  if (Array.isArray(value)) {
    return value
      .map((v) => parseIntSafe(v))
      .filter((n) => n !== null);
  }
  if (typeof value === 'string') {
    return value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
      .map((v) => parseIntSafe(v))
      .filter((n) => n !== null);
  }
  return [];
};

const parseDateArray = (value) => {
  const values = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(',')
      : [];

  return values
    .map((entry) => String(entry || '').trim())
    .filter((entry) => /^\d{4}-\d{2}-\d{2}$/.test(entry));
};

const runWithConcurrency = async (items, limit, worker) => {
  const safeLimit = Math.max(1, Number(limit) || 1);
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(safeLimit, items.length) }, async () => {
    while (true) {
      const current = cursor++;
      if (current >= items.length) {
        return;
      }
      results[current] = await worker(items[current], current);
    }
  });

  await Promise.all(runners);
  return results;
};

const responseHasAnySlots = (payload) => {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  if (Array.isArray(payload.slots)) {
    return payload.slots.length > 0;
  }

  if (payload.slots_by_instalacion && typeof payload.slots_by_instalacion === 'object') {
    return Object.values(payload.slots_by_instalacion).some((slots) => Array.isArray(slots) && slots.length > 0);
  }

  if (payload.slots_by_doctor && typeof payload.slots_by_doctor === 'object') {
    return Object.values(payload.slots_by_doctor).some((slots) => Array.isArray(slots) && slots.length > 0);
  }

  return null;
};

const isIsoLike = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);


const isMissingClinicScheduleTableError = (error) => {
  if (!error) return false;
  const code = error?.original?.code || error?.parent?.code || error?.code;
  if (code === 'ER_NO_SUCH_TABLE') return true;
  const msg = String(error?.original?.message || error?.message || '').toLowerCase();
  return msg.includes('clinicahorarios') && (msg.includes("doesn't exist") || msg.includes('no such table'));
};









/**
 * Parse "YYYY-MM-DDTHH:mm" sin offset como hora local de clínica.
 * Si el string incluye zona (Z o +/-hh:mm), se respeta.
 */





const fetchClinicHorarios = async (clinicaId) => {
  if (!db.ClinicaHorario) return [];
  try {
    return await db.ClinicaHorario.findAll({
      where: { clinica_id: clinicaId },
      attributes: ['dia_semana', 'activo', 'hora_inicio', 'hora_fin']
    });
  } catch (error) {
    if (isMissingClinicScheduleTableError(error)) {
      // Compatibilidad en despliegues donde el código se publica antes que la migración.
      return [];
    }
    throw error;
  }
};

const build409 = ({ message, conflicts }) => {
  const canForce = conflicts.length > 0 && conflicts.every((c) => !!c.can_force);
  return {
    available: false,
    reason: 'RESOURCE_CONFLICT',
    message: message || 'No hay disponibilidad para el rango solicitado.',
    can_force: canForce,
    resource_conflicts: conflicts
  };
};


const normalizeTimeRangeRows = (rows, startKey, endKey) => {
  return (rows || [])
    .map((r) => {
      const plain = typeof r?.get === 'function' ? r.get({ plain: true }) : r;
      return {
        ...plain,
        start: new Date(plain[startKey]),
        end: new Date(plain[endKey])
      };
    })
    .filter((r) => Number.isFinite(r.start.getTime()) && Number.isFinite(r.end.getTime()) && r.start < r.end)
    .sort((a, b) => a.start - b.start);
};

const firstOverlap = (ranges, start, end) => {
  if (!Array.isArray(ranges) || ranges.length === 0) return null;
  // ranges debe estar ordenado por start.
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (r.start >= end) break;
    if (overlap(start, end, r.start, r.end)) return r;
  }
  return null;
};

const conflictsForSlot = ({
  clinicaId,
  clinicWins,
  clinicHasSchedule,
  instalacionId,
  doctorId,
  instWins,
  docWins,
  dcMissing,
  doctorOutOfHoursMessage,
  instBlocks,
  instCitas,
  docBlocks,
  docCitas,
  start,
  end
}) => {
  const conflicts = [];

  if (clinicHasSchedule && !inAnyWindow(clinicWins, start, end)) {
    conflicts.push({
      resource_type: 'clinic',
      resource_id: clinicaId,
      clinica_id: clinicaId,
      code: 'CLINIC_OUT_OF_HOURS',
      can_force: false,
      details: { message: 'Clínica fuera de horario' }
    });
  }

  if (instalacionId) {
    if (!inAnyWindow(instWins, start, end)) {
      conflicts.push({
        resource_type: 'installation',
        resource_id: instalacionId,
        clinica_id: clinicaId,
        code: 'INSTALLATION_OUT_OF_HOURS',
        can_force: false,
        details: { message: 'Instalación fuera de horario' }
      });
    }
  }

  if (doctorId) {
    if (dcMissing) {
      conflicts.push({
        resource_type: 'staff',
        resource_role: 'doctor',
        resource_id: doctorId,
        clinica_id: clinicaId,
        code: 'STAFF_OUT_OF_HOURS',
        can_force: false,
        details: { message: 'Doctor no asignado a la clínica' }
      });
    } else if (!inAnyWindow(docWins, start, end)) {
      conflicts.push({
        resource_type: 'staff',
        resource_role: 'doctor',
        resource_id: doctorId,
        clinica_id: clinicaId,
        code: 'STAFF_OUT_OF_HOURS',
        can_force: false,
        details: { message: doctorOutOfHoursMessage || 'Doctor fuera de horario' }
      });
    }
  }

  if (instalacionId) {
    const ib = firstOverlap(instBlocks, start, end);
    if (ib) {
      conflicts.push({
        resource_type: 'installation',
        resource_id: instalacionId,
        clinica_id: clinicaId,
        code: 'INSTALLATION_BLOCKED',
        can_force: false,
        details: { message: ib.motivo || 'Instalación bloqueada', tipo: ib.tipo || null, clinica_id: ib.clinica_id ?? null }
      });
    }

    const ic = firstOverlap(instCitas, start, end);
    if (ic) {
      conflicts.push({
        resource_type: 'installation',
        resource_id: instalacionId,
        clinica_id: clinicaId,
        code: 'INSTALLATION_OVERLAP',
        can_force: confirmedOverlapRows(instCitas.filter(row => row.start < end && row.end > start).map(row => ({...row,inicio:row.start,fin:row.end})),start,end,clinicaId),
        details: { message: 'Instalación ocupada' }
      });
    }
  }

  if (doctorId) {
    const db = firstOverlap(docBlocks, start, end);
    if (db) {
      conflicts.push({
        resource_type: 'staff',
        resource_role: 'doctor',
        resource_id: doctorId,
        clinica_id: clinicaId,
        code: 'STAFF_BLOCKED',
        can_force: false,
        details: {
          tipo: db.tipo || null,
          message: db.motivo || 'Bloqueo doctor',
          clinica_id: db.clinica_id ?? null,
        }
      });
    }

    const staffOutOfHours = conflicts.some((conflict) =>
      conflict.resource_type === 'staff'
      && conflict.resource_id === doctorId
      && conflict.code === 'STAFF_OUT_OF_HOURS'
    );

    if (!staffOutOfHours) {
      const dc = firstOverlap(docCitas, start, end);
      if (dc) {
        const overlappingRows = docCitas.filter(row => row.start < end && row.end > start);
        const originClinics = [...new Set(overlappingRows.map(row => Number(row.clinica_id)).filter(Number.isFinite))].sort((a, b) => a - b);
        const sameClinic = originClinics.length > 0 && originClinics.every(id => id === Number(clinicaId));
        const citaClinicId = originClinics.find(id => id !== Number(clinicaId)) ?? Number(dc.clinica_id);
        conflicts.push({
          resource_type: 'staff',
          resource_role: 'doctor',
          resource_id: doctorId,
          clinica_id: clinicaId,
          code: 'STAFF_OVERLAP',
          can_force: sameClinic && confirmedOverlapRows(overlappingRows.map(row => ({...row,inicio:row.start,fin:row.end})),start,end,clinicaId),
          details: {
            message: sameClinic ? 'Doctor ocupado' : 'Doctor ocupado en otra clínica',
            clinica_id: Number.isFinite(citaClinicId) ? citaClinicId : null,
            clinica_ids: originClinics,
          }
        });
      }
    }
  }

  return conflicts;
};

const conflictSetKey = (conflicts) => {
  return (conflicts || [])
    .map((c) => {
      const base = `${c.resource_type}|${c.code}|${c.resource_id ?? ''}|${c.clinica_id ?? ''}|${c.can_force === true}`;
      if (c.resource_role === 'additional_staff' || c.code === 'INSTALLATION_PROFESSIONAL_NOT_ALLOWED') {
        return `${base}|${c.resource_role || ''}|${c.details?.message || ''}`;
      }
      if (c.code === 'STAFF_BLOCKED' || c.code === 'INSTALLATION_BLOCKED' || c.code === 'STAFF_OVERLAP') {
        const t = c.details && c.details.tipo ? String(c.details.tipo) : '';
        const m = c.details && c.details.message ? String(c.details.message) : '';
        const cd = c.details && c.details.clinica_id != null ? String(c.details.clinica_id) : '';
        const origins = Array.isArray(c.details?.clinica_ids) ? [...c.details.clinica_ids].sort((a, b) => a - b).join(',') : '';
        return `${base}|${t}|${m}|${cd}|${origins}`;
      }
      return base;
    })
    .sort()
    .join(';');
};

const { installationAllowsStaff } = require('../lib/installation-professionals');

const buildUnavailableIntervals = ({
  clinicaId,
  timeZone,
  fecha_local,
  dow,
  clinicHasSchedule,
  clinicWins,
  baseStart,
  baseEnd,
  durMin,
  stepMin,
  instalacionId,
  doctorId,
  inst,
  dc,
  instBlocksRows,
  instCitasRows,
  docBlocksRows,
  docCitasRows,
  additionalStaffIds = [],
  supportContext
}) => {
  const instWins = inst ? buildWindowsFromHorarios(inst.horarios || [], dow, fecha_local, timeZone) : [];
  const doctorCtx = buildDoctorAvailabilityContext({
    doctorId,
    clinicaId,
    dc,
    dow,
    fechaLocal: fecha_local,
    timeZone,
  });
  const docWins = doctorCtx.docWins;
  const dcMissing = doctorCtx.dcMissing;

  const instBlocks = normalizeTimeRangeRows(instBlocksRows, 'fecha_inicio', 'fecha_fin');
  const instCitas = normalizeTimeRangeRows(instCitasRows, 'inicio', 'fin');
  const docBlocks = normalizeTimeRangeRows(docBlocksRows, 'fecha_inicio', 'fecha_fin');
  const docCitas = normalizeTimeRangeRows(docCitasRows, 'inicio', 'fin');

  const durMs = durMin * 60000;
  const stepMs = stepMin * 60000;

  const intervals = [];
  let current = null;

  for (let t = baseStart.getTime(); t + durMs <= baseEnd.getTime(); t += stepMs) {
    const start = new Date(t);
    const end = new Date(t + durMs);
    const conflicts = conflictsForSlot({
      clinicaId,
      clinicWins,
      clinicHasSchedule,
      instalacionId,
      doctorId,
      instWins,
      docWins,
      dcMissing,
      doctorOutOfHoursMessage: doctorCtx.outOfHoursMessage,
      instBlocks,
      instCitas,
      docBlocks,
      docCitas,
      start,
      end
    });
    conflicts.push(...installationStaffConflicts({ inst, doctorId, additionalStaffIds, supportContext, clinicaId }),
      ...supportConflictsForSlot({ additionalStaffIds, supportContext, start, end, clinicaId, timeZone }));

    if (doctorCtx.agendaFlexible) {
      allowFlexibleConflicts(conflicts, true);
      for (let i = conflicts.length - 1; i >= 0; i--) if (conflicts[i].can_force) conflicts.splice(i, 1);
    }

    if (!conflicts.length) {
      if (current) {
        intervals.push(current);
        current = null;
      }
      continue;
    }

    const key = conflictSetKey(conflicts);
    if (!current || current._key !== key) {
      if (current) intervals.push(current);
      current = {
        start_local: formatLocal(start, timeZone),
        end_local: formatLocal(end, timeZone),
        start_utc: start.toISOString(),
        end_utc: end.toISOString(),
        // This is the union of rejected candidate appointment spans, not raw
        // occupied resource intervals. Keep the historical painting semantics.
        interval_kind: 'unavailable_candidate_span',
        resource_conflicts: conflicts,
        _key: key
      };
    } else {
      current.end_local = formatLocal(end, timeZone);
      current.end_utc = end.toISOString();
    }
  }

  if (current) {
    intervals.push(current);
  }

  // Limpiar keys internas
  return intervals.map((it) => {
    const { _key, ...rest } = it;
    return rest;
  });
};

/**
 * GET /api/disponibilidad/check
 * Contrato canónico: ver Documentacion/17.6-disponibilidad-recursos.md
 */
exports.check = asyncHandler(async (req, res) => {
  const {
    clinica_id,
    inicio_local,
    fin_local,
    duracion_min,
    instalacion_id,
    doctor_id,
    ignore_cita_id,
    force
  } = req.query || {};

  const clinicaId = parseIntSafe(clinica_id);
  if (!clinicaId) {
    return res.status(400).json({ message: 'clinica_id requerido' });
  }

  if (!inicio_local || !isIsoLike(inicio_local)) {
    return res.status(400).json({ message: 'inicio_local requerido (YYYY-MM-DDTHH:mm)' });
  }

  const clinica = await db.Clinica.findByPk(clinicaId, { attributes: ['id_clinica', 'nombre_clinica', 'configuracion', 'grupoClinicaId', 'equipment_booking_enabled'] });
  if (!clinica) return res.status(404).json({ message: 'Clínica no encontrada' });

  let bookingProfile = null;
  if (req.query?.tratamiento_id) {
    await assertUserCanAccessFeature({ actorId: Number(req.userData?.userId), featureKey: 'appointments.view', clinicId: clinicaId });
    const treatment = await loadScopedTreatment({ db, treatmentId: req.query.tratamiento_id, clinic: clinica });
    bookingProfile = requireOperationalProfile(treatment);
  }

  const clinicTimezone = resolveClinicTimezone(clinica);

  const start = parseDateTime(inicio_local, clinicTimezone);
  if (!start) {
    return res.status(400).json({ message: 'inicio_local inválido' });
  }

  let end = null;
  if (fin_local) {
    end = parseDateTime(fin_local, clinicTimezone);
    if (!end) return res.status(400).json({ message: 'fin_local inválido' });
  } else {
    const dur = parseIntSafe(duracion_min);
    if (!dur || dur <= 0) return res.status(400).json({ message: 'fin_local o duracion_min requerido' });
    end = new Date(start.getTime() + dur * 60000);
  }

  if (end <= start) {
    return res.status(400).json({ message: 'rango inválido (fin <= inicio)' });
  }

  const additionalStaffIds = requestedAdditionalStaff(req);
  let supportContext = null;
  let supportConflicts = [];
  if (additionalStaffIds.length) {
    await assertUserCanAccessFeature({ actorId: Number(req.userData?.userId), featureKey: 'appointments.view', clinicId: clinicaId });
    if (ignore_cita_id) {
      const ignored = await db.CitaPaciente.findByPk(Number(ignore_cita_id), { attributes: ['id_cita', 'clinica_id'] });
      if (!ignored || Number(ignored.clinica_id) !== clinicaId) return res.status(404).json({ message: 'Cita no encontrada' });
    }
    supportContext = await loadBookingContext({ db, clinic: clinica, profile: { phases: [] }, start, end,
      additionalStaffIds, ignoreAppointmentId: ignore_cita_id ? Number(ignore_cita_id) : null, occupancyEnabled: true,
      includeDiagnosticLabels: true });
    supportConflicts = supportConflictsForSlot({ additionalStaffIds, supportContext, start, end, clinicaId, timeZone: clinicTimezone });
  }

  if (bookingProfile) {
    if (supportConflicts.length) return res.status(409).json(build409({ conflicts: supportConflicts }));
    if (ignore_cita_id) {
      const ignored = await db.CitaPaciente.findByPk(Number(ignore_cita_id), { attributes: ['id_cita', 'clinica_id'] });
      if (!ignored || Number(ignored.clinica_id) !== clinicaId) return res.status(404).json({ message: 'Cita no encontrada' });
    }
    const context = await loadBookingContext({ db, clinic: clinica, profile: bookingProfile, start, end,
      ignoreAppointmentId: ignore_cita_id ? Number(ignore_cita_id) : null, occupancyEnabled: true, additionalStaffIds });
    const selections = bookingProfile.phases.length === 1 && bookingProfile.phases[0].professionals.mode === 'any'
      ? { [bookingProfile.phases[0].key]: { doctor_id, installation_id: instalacion_id } } : {};
    const solution = solveBookingProfile({ profile: bookingProfile, start, ...context, selections });
    if (!solution || new Date(solution.end_at).getTime() !== end.getTime()) {
      const overlapSolution = !additionalStaffIds.length ? solveBookingProfile({ profile: bookingProfile, start, ...context, selections, allowOverlap: true }) : null;
      const canForce = !!overlapSolution && new Date(overlapSolution.end_at).getTime() === end.getTime();
      if (canForce) return res.status(409).json({ available: false, reason: 'overlap', can_force: true,
        message: overlapSolution.warnings.find(warning => warning.code === 'FLEXIBLE_AGENDA')?.message
          || 'La cita se superpone con otra reserva. Confirma la superposición antes de guardar.',
        conflicts: [{ type: 'overlap', message: 'Profesional o consulta compartida ocupados' }],
        resource_conflicts: [{ resource_type: 'staff_pool', code: 'STAFF_OVERLAP', can_force: true,
          details: { message: 'Superposición autorizada por la configuración del profesional y la consulta.' } }] });
      return res.status(409).json({ available: false,
      reason: 'blocked', message: 'No hay disponibilidad para el perfil del tratamiento.', can_force: false,
      resource_conflicts: [{ resource_type: 'staff_pool', code: 'BOOKING_UNAVAILABLE', can_force: false,
        details: { message: 'El rango no cumple el perfil de cabinas y profesionales del tratamiento.' } }] });
    }
    return res.json({ available: true, clinica: { clinica_id: clinicaId, timezone: clinicTimezone },
      resources: { doctor_id: solution.phases[0].doctor_ids[0], instalacion_id: solution.phases[0].installation_id },
      warnings: solution.warnings, booking: solution,
      range: { inicio_local: formatLocal(start, clinicTimezone), fin_local: formatLocal(end, clinicTimezone), inicio_utc: start.toISOString(), fin_utc: end.toISOString() } });
  }

  const conflicts = [...supportConflicts];
  const warnings = [];
  const fechaLocalCheck = formatDateLocal(start, clinicTimezone);
  const dow = dayIndexFromLocalDate(fechaLocalCheck);
  const clinicHorarios = await fetchClinicHorarios(clinicaId);
  const clinicHasSchedule = hasActiveSchedule(clinicHorarios);
  const clinicWins = clinicHasSchedule
    ? buildWindowsFromHorarios(clinicHorarios, dow, fechaLocalCheck, clinicTimezone)
    : [];

  if (clinicHasSchedule && !inAnyWindow(clinicWins, start, end)) {
    conflicts.push({
      resource_type: 'clinic',
      resource_id: clinicaId,
      clinica_id: clinicaId,
      code: 'CLINIC_OUT_OF_HOURS',
      can_force: false,
      details: { message: 'Clínica fuera de horario' }
    });
  }

  const ignoreId = ignore_cita_id ? parseIntSafe(ignore_cita_id) : null;

  // Instalación
  let inst = null;
  const instalacionId = instalacion_id ? parseIntSafe(instalacion_id) : null;
  if (instalacionId) {
    inst = await db.Instalacion.findByPk(instalacionId, {
      include: [
        { model: db.InstalacionHorario, as: 'horarios' },
        { model: db.InstalacionBloqueo, as: 'bloqueos' }
      ]
    });
    if (!inst || !inst.activo) return res.status(404).json({ message: 'Instalación no encontrada' });
    if (inst.clinica_id !== clinicaId) {
      return res.status(400).json({ message: 'instalacion_id no pertenece a clinica_id' });
    }

    const instWins = buildWindowsFromHorarios(inst.horarios || [], dow, fechaLocalCheck, clinicTimezone);
    conflicts.push(...installationStaffConflicts({ inst, doctorId: Number(doctor_id) || null, additionalStaffIds, supportContext, clinicaId }));
    const inRange = inAnyWindow(instWins, start, end);
    if (!inRange) {
      conflicts.push({
        resource_type: 'installation',
        resource_id: instalacionId,
        clinica_id: clinicaId,
        code: 'INSTALLATION_OUT_OF_HOURS',
        can_force: false,
        details: { message: 'Instalación fuera de horario' }
      });
    }

    // Bloqueos instalación
    (await resourceInstallationBlocks({ db, clinic: clinica, installationIds: [instalacionId], start, end })).forEach((b) => {
      if (overlap(start, end, new Date(b.fecha_inicio), new Date(b.fecha_fin))) {
        conflicts.push({
          resource_type: 'installation',
          resource_id: instalacionId,
          clinica_id: clinicaId,
          code: 'INSTALLATION_BLOCKED',
          can_force: false,
          details: { message: b.motivo || 'Instalación bloqueada', bloqueo_id: b.id }
        });
      }
    });

    // Ocupación instalación (citas)
    const citasInst = await resourceAppointments({ db, clinic: clinica, installationId: instalacionId, start, end, ignoreAppointmentId: ignoreId });
    if (citasInst.length) {
      conflicts.push({
        resource_type: 'installation',
        resource_id: instalacionId,
        clinica_id: clinicaId,
        code: 'INSTALLATION_OVERLAP',
        can_force: confirmedOverlapRows(citasInst,start,end,clinicaId),
        details: { cita_ids: [...new Set(citasInst.filter(c => Number(c.clinica_id) === clinicaId).map(c => c.id_cita))], message: 'Instalación ocupada' }
      });
    }
  }

  // Staff (doctor) - de momento solo doctor_id (personal_ids[] vendrá en 18.12)
  const doctorId = doctor_id ? parseIntSafe(doctor_id) : null;
  let agendaFlexible = false;
  if (doctorId) {

    const dc = await db.DoctorClinica.findOne({
      where: { doctor_id: doctorId, clinica_id: clinicaId, activo: true },
      include: [{ model: db.DoctorHorario, as: 'horarios', include: [{ model: db.DoctorHorarioExcepcion, as: 'excepciones' }] }]
    });

    const doctorCtx = buildDoctorAvailabilityContext({
      doctorId,
      clinicaId,
      dc: dc || null,
      dow,
      fechaLocal: fechaLocalCheck,
      timeZone: clinicTimezone,
      });
    agendaFlexible = doctorCtx.agendaFlexible === true;

    if (doctorCtx.dcMissing) {
      conflicts.push({
        resource_type: 'staff',
        resource_role: 'doctor',
        resource_id: doctorId,
        clinica_id: clinicaId,
        code: 'STAFF_OUT_OF_HOURS',
        can_force: false,
        details: { message: 'Doctor no asignado a la clínica' }
      });
    } else {
      const inRange = inAnyWindow(doctorCtx.docWins, start, end);
      if (!inRange) {
        conflicts.push({
          resource_type: 'staff',
          resource_role: 'doctor',
          resource_id: doctorId,
          clinica_id: clinicaId,
          code: 'STAFF_OUT_OF_HOURS',
          can_force: false,
          details: { message: doctorCtx.outOfHoursMessage || 'Doctor fuera de horario' }
        });
      }
    }

    const bloqueoDefs = await db.DoctorBloqueo.findAll({
      where: {
        doctor_id: doctorId,
        [Op.or]: [
          { recurrente: 'none', fecha_inicio: { [Op.lt]: end }, fecha_fin: { [Op.gt]: start } },
          { recurrente: { [Op.ne]: 'none' }, fecha_inicio: { [Op.lte]: end } },
        ],
      },
      include: [{ model: db.DoctorBloqueoExcepcion, as: 'excepciones' }],
    });
    const bloqueos = buildDoctorBloqueoRowsForDate(bloqueoDefs, fechaLocalCheck, clinicTimezone);
    if (bloqueos.length) {
      const b = bloqueos[0];
      conflicts.push({
        resource_type: 'staff',
        resource_role: 'doctor',
        resource_id: doctorId,
        clinica_id: clinicaId,
        code: 'STAFF_BLOCKED',
        can_force: false,
        details: {
          bloqueo_id: b.id,
          tipo: b.tipo || null,
          // Importante: el front usa este campo para mostrar el motivo del bloqueo en los "shadows".
          message: b.motivo || 'Bloqueo doctor',
          clinica_id: b.clinica_id ?? null,
        }
      });
    }

    const citasDoc = await resourceAppointments({ db, doctorId, start, end, ignoreAppointmentId: ignoreId });
    const citasDocSameClinic = citasDoc.filter((c) => Number(c.clinica_id) === clinicaId);
    const citasDocOtherClinics = citasDoc.filter((c) => Number(c.clinica_id) !== clinicaId);

    if (citasDocSameClinic.length) {
      conflicts.push({
        resource_type: 'staff',
        resource_role: 'doctor',
        resource_id: doctorId,
        clinica_id: clinicaId,
        code: 'STAFF_OVERLAP',
        // Overbooking doctor permitido -> forzable
        can_force: confirmedOverlapRows(citasDocSameClinic,start,end,clinicaId),
        details: { cita_ids: citasDocSameClinic.map((c) => c.id_cita), message: 'Doctor ocupado',
          clinica_id: clinicaId, clinica_ids: [clinicaId] }
      });
    }

    if (citasDocOtherClinics.length) {
      conflicts.push({
        resource_type: 'staff',
        resource_role: 'doctor',
        resource_id: doctorId,
        clinica_id: clinicaId,
        code: 'STAFF_OVERLAP',
        // No se permite forzar cuando el choque es en otra clínica.
        can_force: false,
        details: {
          message: 'Doctor ocupado en otra clínica',
          clinica_ids: [...new Set(citasDocOtherClinics.map(c => Number(c.clinica_id)).filter(Number.isFinite))].sort((a, b) => a - b),
        }
      });
    }
  }

  allowFlexibleConflicts(conflicts, agendaFlexible);
  if (additionalStaffIds.length) conflicts.forEach(conflict => { conflict.can_force = false; });
  const canForce = conflicts.length > 0 && conflicts.every((c) => !!c.can_force);
  const wantsForce = parseBool(force);

  if (conflicts.length && !(wantsForce && canForce)) {
    return res.status(409).json(build409({ conflicts }));
  }

  if (conflicts.length && wantsForce && canForce) {
    warnings.push('forced');
  }

  return res.json({
    available: true,
    clinica: {
      clinica_id: clinica.id_clinica,
      nombre: clinica.nombre_clinica,
      timezone: clinicTimezone
    },
    range: {
      inicio_local: formatLocal(start, clinicTimezone),
      fin_local: formatLocal(end, clinicTimezone),
      inicio_utc: start.toISOString(),
      fin_utc: end.toISOString()
    },
    resources: {
      instalacion_id: instalacionId || undefined,
      doctor_id: doctorId || undefined
    },
    warnings
  });
});

/**
 * GET /api/disponibilidad/slots
 * Devuelve slots sugeridos (huecos libres) para una fecha local.
 *
 * Nota: el rango y los slots se interpretan en hora local de clínica.
 */
exports.slots = asyncHandler(async (req, res) => {
  const {
    clinica_id,
    fecha_local,
    duracion_min,
    granularity_min,
    from_local,
    to_local,
    instalacion_id,
    instalacion_ids,
    doctor_id,
    doctor_ids,
    limit,
    include_unavailable
  } = req.query || {};

  const clinicaId = parseIntSafe(clinica_id);
  if (!clinicaId) return res.status(400).json({ message: 'clinica_id requerido' });
  if (!fecha_local || typeof fecha_local !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha_local)) {
    return res.status(400).json({ message: 'fecha_local requerido (YYYY-MM-DD)' });
  }

  const durMin = parseIntSafe(duracion_min);
  if (!durMin || durMin <= 0) return res.status(400).json({ message: 'duracion_min requerido' });

  const stepMin = parseIntSafe(granularity_min) || 15;
  const requestedLimit = parseIntSafe(limit);
  const includeUnavailable = parseBool(include_unavailable);

  const clinica = await db.Clinica.findByPk(clinicaId, { attributes: ['id_clinica', 'nombre_clinica', 'configuracion', 'grupoClinicaId', 'equipment_booking_enabled'] });
  if (!clinica) return res.status(404).json({ message: 'Clínica no encontrada' });
  const additionalStaffIds = requestedAdditionalStaff(req);
  if (additionalStaffIds.length) await assertUserCanAccessFeature({ actorId: Number(req.userData?.userId), featureKey: 'appointments.view', clinicId: clinicaId });
  if (req.query?.tratamiento_id) {
    await assertUserCanAccessFeature({ actorId: Number(req.userData?.userId), featureKey: 'appointments.view', clinicId: clinicaId });
    const treatment = await loadScopedTreatment({ db, treatmentId: req.query.tratamiento_id, clinic: clinica });
    const profile = requireOperationalProfile(treatment);
    if (profile) {
      assertGridProfile(profile);
      if (stepMin < 5 || stepMin > 120) return res.status(400).json({ message: 'granularity_min debe estar entre 5 y 120' });
      const installationIds = parseIntArray(instalacion_ids || req.query['instalacion_ids[]']);
      const professionalIds = parseIntArray(doctor_ids || req.query['doctor_ids[]']);
      if (installationIds.length > 50 || professionalIds.length > 50 || (installationIds.length && professionalIds.length)
        || (installationIds.length && (!doctor_id || instalacion_id)) || (professionalIds.length && (!instalacion_id || doctor_id))) {
        return res.status(400).json({ message: 'Batch de cabinas/profesionales inválido' });
      }
      const timezone = resolveClinicTimezone(clinica);
      const context = await loadBookingContext({ db, clinic: clinica, profile,
        start: resolveLocalInstant(fecha_local, '00:00:00', timezone),
        end: resolveLocalInstant(addDays(fecha_local, 1), '00:00:00', timezone), occupancyEnabled: true, additionalStaffIds,
        includeDiagnosticLabels: includeUnavailable });
      return res.json(profileSlotsPayload({ query: req.query, profile, context, clinic: clinica, additionalStaffIds }));
    }
  }
  const clinicTimezone = resolveClinicTimezone(clinica);

  // Base window: día local completo de clínica + recorte opcional from/to.
  let baseStart = localDateTimeToUtc(fecha_local, '00:00:00', clinicTimezone);
  let baseEnd = localDateTimeToUtc(fecha_local, '23:59:59', clinicTimezone);

  if (from_local && typeof from_local === 'string' && /^\d{2}:\d{2}$/.test(from_local)) {
    baseStart = localDateTimeToUtc(fecha_local, `${from_local}:00`, clinicTimezone);
  }
  if (to_local && typeof to_local === 'string' && /^\d{2}:\d{2}$/.test(to_local)) {
    baseEnd = localDateTimeToUtc(fecha_local, `${to_local}:00`, clinicTimezone);
  }

  if (!baseStart || !baseEnd || !Number.isFinite(baseStart.getTime()) || !Number.isFinite(baseEnd.getTime()) || baseEnd <= baseStart) {
    return res.status(400).json({ message: 'rango from_local/to_local inválido' });
  }

  // Si no se especifica limit, devolvemos todos los slots posibles dentro del rango (con un cap razonable).
  // Esto evita respuestas incompletas (ej. limit=50) que rompen el sombreado en frontend.
  const rangeMinutes = Math.floor((baseEnd.getTime() - baseStart.getTime()) / 60000);
  const theoreticalMax = rangeMinutes >= durMin ? Math.floor((rangeMinutes - durMin) / stepMin) + 1 : 0;
  const maxSlots = requestedLimit && requestedLimit > 0 ? requestedLimit : Math.min(theoreticalMax, 2000);

  const dow = dayIndexFromLocalDate(fecha_local);
  const clinicHorarios = await fetchClinicHorarios(clinicaId);
  const clinicHasSchedule = hasActiveSchedule(clinicHorarios);
  const clinicWins = clinicHasSchedule
    ? buildWindowsFromHorarios(clinicHorarios, dow, fecha_local, clinicTimezone)
    : [];

  const instalacionId = instalacion_id ? parseIntSafe(instalacion_id) : null;
  const doctorId = doctor_id ? parseIntSafe(doctor_id) : null;

  const instalacionIds = parseIntArray(instalacion_ids || req.query['instalacion_ids[]']);
  const doctorIds = parseIntArray(doctor_ids || req.query['doctor_ids[]']);

  // Seguridad: evitamos "cross product" y ponemos un cap razonable para batch list.
  // En entornos reales puede haber decenas de doctores; 100 mantiene el endpoint util sin disparar coste.
  const MAX_BATCH_IDS = 100;
  if (instalacionIds.length > MAX_BATCH_IDS) {
    return res.status(400).json({ message: `instalacion_ids excede el máximo (${MAX_BATCH_IDS})` });
  }
  if (doctorIds.length > MAX_BATCH_IDS) {
    return res.status(400).json({ message: `doctor_ids excede el máximo (${MAX_BATCH_IDS})` });
  }
  if (instalacionIds.length && doctorIds.length) {
    return res.status(400).json({ message: 'No soportado: doctor_ids e instalacion_ids a la vez (cross-product)' });
  }
  if (instalacionIds.length && instalacionId) {
    return res.status(400).json({ message: 'No soportado: instalacion_id e instalacion_ids a la vez' });
  }
  if (doctorIds.length && doctorId) {
    return res.status(400).json({ message: 'No soportado: doctor_id y doctor_ids a la vez' });
  }
  if (instalacionIds.length && !doctorId) {
    return res.status(400).json({ message: 'Batch por instalaciones requiere doctor_id' });
  }
  if (doctorIds.length && !instalacionId) {
    return res.status(400).json({ message: 'Batch por doctores requiere instalacion_id' });
  }

  const doctorIdsForGlobal = [];
  if (doctorId) doctorIdsForGlobal.push(doctorId);
  if (doctorIds.length) doctorIdsForGlobal.push(...doctorIds);

  // One bulk read per date/request, never SQL per suggested slot or participant.
  const supportContext = additionalStaffIds.length ? await loadBookingContext({ db, clinic: clinica,
    profile: { phases: [] }, start: baseStart, end: baseEnd, additionalStaffIds, occupancyEnabled: true,
    includeDiagnosticLabels: includeUnavailable }) : null;

  const buildSlots = ({
    inst,
    doctorCtx,
    instBlocksRows,
    instCitasRows,
    docBlocksRows,
    docCitasRows
  }) => {
    return buildLegacySlots({ baseStart, baseEnd, clinicHasSchedule, clinicWins, inst,
      instWins: inst ? buildWindowsFromHorarios(inst.horarios || [], dow, fecha_local, clinicTimezone) : [],
      doctorCtx, additionalStaffIds, supportContext, timeZone: clinicTimezone, durMin, stepMin, maxSlots,
      instBlocksRows, instCitasRows, docBlocksRows, docCitasRows });
  };

  // ========== Batch: doctor_id + instalacion_ids[] ==========
  if (doctorId && instalacionIds.length) {
    const dc = await db.DoctorClinica.findOne({
      where: { doctor_id: doctorId, clinica_id: clinicaId, activo: true },
      include: [{ model: db.DoctorHorario, as: 'horarios', include: [{ model: db.DoctorHorarioExcepcion, as: 'excepciones' }] }]
    });
    const doctorCtx = buildDoctorAvailabilityContext({
      doctorId,
      clinicaId,
      dc: dc || null,
      dow,
      fechaLocal: fecha_local,
      timeZone: clinicTimezone,
      });

    // Si no hay asignación del doctor, devolvemos vacío para todas las instalaciones.
    if (doctorCtx.dcMissing) {
      const slotsByInst = {};
      instalacionIds.forEach((id) => {
        slotsByInst[String(id)] = [];
      });
      const unavailableByInst = {};
      if (includeUnavailable) {
        instalacionIds.forEach((id) => {
          unavailableByInst[String(id)] = [
            {
              start_local: formatLocal(baseStart, clinicTimezone),
              end_local: formatLocal(baseEnd, clinicTimezone),
              start_utc: baseStart.toISOString(),
              end_utc: baseEnd.toISOString(),
              resource_conflicts: [
                {
                  resource_type: 'staff',
                  resource_role: 'doctor',
                  resource_id: doctorId,
                  clinica_id: clinicaId,
                  code: 'STAFF_OUT_OF_HOURS',
                  can_force: false,
                  details: { message: 'Doctor no asignado a la clínica' }
                }
              ]
            }
          ];
        });
      }
      return res.json({
        timezone: clinicTimezone,
        clinica_id: clinica.id_clinica,
        fecha_local,
        duracion_min: durMin,
        granularity_min: stepMin,
        doctor_id: doctorId,
        instalacion_ids: instalacionIds,
        slots_by_instalacion: slotsByInst,
        ...(includeUnavailable ? { unavailable_by_instalacion: unavailableByInst } : {})
      });
    }

    const instRows = await db.Instalacion.findAll({
      where: { id: { [Op.in]: instalacionIds }, clinica_id: clinicaId, activo: true },
      include: [{ model: db.InstalacionHorario, as: 'horarios' }]
    });
    const instMap = new Map(instRows.map((r) => [r.id, r]));
    if (instMap.size !== instalacionIds.length) {
      return res.status(400).json({ message: 'instalacion_ids contiene ids inválidos para la clínica' });
    }

    const instBloqRows = await resourceInstallationBlocks({ db, clinic: clinica, installationIds: instalacionIds, start: baseStart, end: baseEnd });
    const instCitasRows = await resourceAppointments({ db, clinic: clinica, installationIds: instalacionIds, start: baseStart, end: baseEnd });

    const instBloqById = new Map();
    instBloqRows.forEach((b) => {
      const id = b.instalacion_id;
      if (!instBloqById.has(id)) instBloqById.set(id, []);
      instBloqById.get(id).push(b);
    });
    const instCitasById = new Map();
    instCitasRows.forEach((c) => {
      const id = c.instalacion_id;
      if (!instCitasById.has(id)) instCitasById.set(id, []);
      instCitasById.get(id).push(c);
    });

    const docBloqDefs = await db.DoctorBloqueo.findAll({
      where: {
        doctor_id: doctorId,
        [Op.or]: [
          { recurrente: 'none', fecha_inicio: { [Op.lt]: baseEnd }, fecha_fin: { [Op.gt]: baseStart } },
          { recurrente: { [Op.ne]: 'none' }, fecha_inicio: { [Op.lte]: baseEnd } },
        ],
      },
      attributes: ['id', 'doctor_id', 'fecha_inicio', 'fecha_fin', 'motivo', 'tipo', 'clinica_id', 'recurrente'],
      include: [{ model: db.DoctorBloqueoExcepcion, as: 'excepciones' }],
    });
    const docBloqRows = buildDoctorBloqueoRowsForDate(docBloqDefs, fecha_local, clinicTimezone);
    const docCitasRows = await resourceAppointments({ db, doctorId, start: baseStart, end: baseEnd });

    const slotsByInst = {};
    const unavailableByInst = {};
    instalacionIds.forEach((id) => {
      const inst = instMap.get(id);
      const slots = buildSlots({
        inst,
        doctorCtx,
        instBlocksRows: instBloqById.get(id) || [],
        instCitasRows: instCitasById.get(id) || [],
        docBlocksRows: docBloqRows,
        docCitasRows: docCitasRows
      });
      slotsByInst[String(id)] = slots;
      if (includeUnavailable) {
        unavailableByInst[String(id)] = buildUnavailableIntervals({
          clinicaId,
          timeZone: clinicTimezone,
          fecha_local,
          dow,
          clinicHasSchedule,
          clinicWins,
          baseStart,
          baseEnd,
          durMin,
          stepMin,
          instalacionId: id,
          doctorId,
          inst,
          dc,
          instBlocksRows: instBloqById.get(id) || [],
          instCitasRows: instCitasById.get(id) || [],
          docBlocksRows: docBloqRows,
          docCitasRows: docCitasRows,
          additionalStaffIds, supportContext
        });
      }
    });

    return res.json({
      timezone: clinicTimezone,
      clinica_id: clinica.id_clinica,
      fecha_local,
      duracion_min: durMin,
      granularity_min: stepMin,
      doctor_id: doctorId,
      instalacion_ids: instalacionIds,
      slots_by_instalacion: slotsByInst,
      ...(includeUnavailable ? { unavailable_by_instalacion: unavailableByInst } : {})
    });
  }

  // ========== Batch: instalacion_id + doctor_ids[] ==========
  if (instalacionId && doctorIds.length) {
    const inst = await db.Instalacion.findByPk(instalacionId, {
      include: [{ model: db.InstalacionHorario, as: 'horarios' }]
    });
    if (!inst || !inst.activo) return res.status(404).json({ message: 'Instalación no encontrada' });
    if (inst.clinica_id !== clinicaId) {
      return res.status(400).json({ message: 'instalacion_id no pertenece a clinica_id' });
    }

    const instBloqRows = await resourceInstallationBlocks({ db, clinic: clinica, installationIds: [instalacionId], start: baseStart, end: baseEnd });
    const instCitasRows = await resourceAppointments({ db, clinic: clinica, installationId: instalacionId, start: baseStart, end: baseEnd });

    const dcRows = await db.DoctorClinica.findAll({
      where: { doctor_id: { [Op.in]: doctorIds }, clinica_id: clinicaId, activo: true },
      include: [{ model: db.DoctorHorario, as: 'horarios', include: [{ model: db.DoctorHorarioExcepcion, as: 'excepciones' }] }]
    });
    const dcByDoctor = new Map(dcRows.map((r) => [r.doctor_id, r]));

    const docBloqDefs = await db.DoctorBloqueo.findAll({
      where: {
        doctor_id: { [Op.in]: doctorIds },
        [Op.or]: [
          { recurrente: 'none', fecha_inicio: { [Op.lt]: baseEnd }, fecha_fin: { [Op.gt]: baseStart } },
          { recurrente: { [Op.ne]: 'none' }, fecha_inicio: { [Op.lte]: baseEnd } },
        ],
      },
      attributes: ['id', 'doctor_id', 'fecha_inicio', 'fecha_fin', 'motivo', 'tipo', 'clinica_id', 'recurrente'],
      include: [{ model: db.DoctorBloqueoExcepcion, as: 'excepciones' }],
    });
    const docBloqRows = buildDoctorBloqueoRowsForDate(docBloqDefs, fecha_local, clinicTimezone);
    const docCitasRows = await resourceAppointments({ db, doctorIds, start: baseStart, end: baseEnd });

    const docBloqById = new Map();
    docBloqRows.forEach((b) => {
      const id = b.doctor_id;
      if (!docBloqById.has(id)) docBloqById.set(id, []);
      docBloqById.get(id).push(b);
    });
    const docCitasById = new Map();
    docCitasRows.forEach((c) => {
      const id = c.doctor_id;
      if (!docCitasById.has(id)) docCitasById.set(id, []);
      docCitasById.get(id).push(c);
    });

    const slotsByDoctor = {};
    const unavailableByDoctor = {};
    doctorIds.forEach((id) => {
      const dc = dcByDoctor.get(id) || null;
      const doctorCtx = buildDoctorAvailabilityContext({
        doctorId: id,
        clinicaId,
        dc,
        dow,
        fechaLocal: fecha_local,
        timeZone: clinicTimezone,
          });
      const slots = buildSlots({
        inst,
        doctorCtx,
        instBlocksRows: instBloqRows,
        instCitasRows: instCitasRows,
        docBlocksRows: docBloqById.get(id) || [],
        docCitasRows: docCitasById.get(id) || []
      });
      slotsByDoctor[String(id)] = slots;
      if (includeUnavailable) {
        unavailableByDoctor[String(id)] = buildUnavailableIntervals({
          clinicaId,
          timeZone: clinicTimezone,
          fecha_local,
          dow,
          clinicHasSchedule,
          clinicWins,
          baseStart,
          baseEnd,
          durMin,
          stepMin,
          instalacionId,
          doctorId: id,
          inst,
          dc,
          instBlocksRows: instBloqRows,
          instCitasRows: instCitasRows,
          docBlocksRows: docBloqById.get(id) || [],
          docCitasRows: docCitasById.get(id) || [],
          additionalStaffIds, supportContext
        });
      }
    });

    return res.json({
      timezone: clinicTimezone,
      clinica_id: clinica.id_clinica,
      fecha_local,
      duracion_min: durMin,
      granularity_min: stepMin,
      instalacion_id: instalacionId,
      doctor_ids: doctorIds,
      slots_by_doctor: slotsByDoctor,
      ...(includeUnavailable ? { unavailable_by_doctor: unavailableByDoctor } : {})
    });
  }

  // ========== Single (compat) ==========
  let inst = null;
  let dc = undefined;
  let instBloqRows = [];
  let instCitasRows = [];
  let docBloqRows = [];
  let docCitasRows = [];
  let doctorCtx = null;

  if (instalacionId) {
    inst = await db.Instalacion.findByPk(instalacionId, {
      include: [{ model: db.InstalacionHorario, as: 'horarios' }]
    });
    if (!inst || !inst.activo) return res.status(404).json({ message: 'Instalación no encontrada' });
    if (inst.clinica_id !== clinicaId) return res.status(400).json({ message: 'instalacion_id no pertenece a clinica_id' });

    instBloqRows = await resourceInstallationBlocks({ db, clinic: clinica, installationIds: [instalacionId], start: baseStart, end: baseEnd });
    instCitasRows = await resourceAppointments({ db, clinic: clinica, installationId: instalacionId, start: baseStart, end: baseEnd });
  }

  if (doctorId) {
    const dcRow = await db.DoctorClinica.findOne({
      where: { doctor_id: doctorId, clinica_id: clinicaId, activo: true },
      include: [{ model: db.DoctorHorario, as: 'horarios', include: [{ model: db.DoctorHorarioExcepcion, as: 'excepciones' }] }]
    });
    dc = dcRow || null;
    doctorCtx = buildDoctorAvailabilityContext({
      doctorId,
      clinicaId,
      dc,
      dow,
      fechaLocal: fecha_local,
      timeZone: clinicTimezone,
      });

    const docBloqDefs = await db.DoctorBloqueo.findAll({
      where: {
        doctor_id: doctorId,
        [Op.or]: [
          { recurrente: 'none', fecha_inicio: { [Op.lt]: baseEnd }, fecha_fin: { [Op.gt]: baseStart } },
          { recurrente: { [Op.ne]: 'none' }, fecha_inicio: { [Op.lte]: baseEnd } },
        ],
      },
      attributes: ['id', 'doctor_id', 'fecha_inicio', 'fecha_fin', 'motivo', 'tipo', 'clinica_id', 'recurrente'],
      include: [{ model: db.DoctorBloqueoExcepcion, as: 'excepciones' }],
    });
    docBloqRows = buildDoctorBloqueoRowsForDate(docBloqDefs, fecha_local, clinicTimezone);
    docCitasRows = await resourceAppointments({ db, doctorId, start: baseStart, end: baseEnd });
  }

  const slots = buildSlots({
    inst: inst || undefined,
    doctorCtx,
    instBlocksRows: instBloqRows,
    instCitasRows: instCitasRows,
    docBlocksRows: docBloqRows,
    docCitasRows: docCitasRows
  });

  return res.json({
    timezone: clinicTimezone,
    clinica_id: clinica.id_clinica,
    fecha_local,
    duracion_min: durMin,
    granularity_min: stepMin,
    slots,
    ...(includeUnavailable ? {
      unavailable_intervals: buildUnavailableIntervals({
        clinicaId,
        timeZone: clinicTimezone,
        fecha_local,
        dow,
        clinicHasSchedule,
        clinicWins,
        baseStart,
        baseEnd,
        durMin,
        stepMin,
        instalacionId,
        doctorId,
        inst: inst || undefined,
        dc,
        instBlocksRows: instBloqRows,
        instCitasRows: instCitasRows,
        docBlocksRows: docBloqRows,
        docCitasRows: docCitasRows,
        additionalStaffIds, supportContext
      })
    } : {})
  });
});

const availabilityInputError = (message, statusCode = 400) => Object.assign(Error(message), { statusCode });

// Identical response shapes to legacy /slots, but every column/date consumes
// the same request-local SQL snapshot. The actual legacy slot constructor is
// shared with /slots; unavailable geometry remains unchanged.
function legacySnapshotPayload(snapshot, query) {
  const date = query.fecha_local, day = snapshot.day(date), timeZone = snapshot.timeZone;
  const clinicId = Number(snapshot.clinic.id_clinica), durMin = parseIntSafe(query.duracion_min);
  const stepMin = parseIntSafe(query.granularity_min) || 15;
  const includeUnavailable = parseBool(query.include_unavailable);
  const doctorId = query.doctor_id ? parseIntSafe(query.doctor_id) : null;
  const installationId = query.instalacion_id ? parseIntSafe(query.instalacion_id) : null;
  const doctorIds = parseIntArray(query.doctor_ids || query['doctor_ids[]']);
  const installationIds = parseIntArray(query.instalacion_ids || query['instalacion_ids[]']);
  if (stepMin <= 0 || installationIds.length > 100 || doctorIds.length > 100
    || (installationIds.length && doctorIds.length) || (installationIds.length && (installationId || !doctorId))
    || (doctorIds.length && (doctorId || !installationId))) throw availabilityInputError('Batch de cabinas/profesionales inválido');
  let baseStart = localDateTimeToUtc(date, '00:00:00', timeZone);
  let baseEnd = localDateTimeToUtc(date, '23:59:59', timeZone);
  if (typeof query.from_local === 'string' && /^\d{2}:\d{2}$/.test(query.from_local)) baseStart = localDateTimeToUtc(date, `${query.from_local}:00`, timeZone);
  if (typeof query.to_local === 'string' && /^\d{2}:\d{2}$/.test(query.to_local)) baseEnd = localDateTimeToUtc(date, `${query.to_local}:00`, timeZone);
  if (!baseStart || !baseEnd || baseEnd <= baseStart) throw availabilityInputError('rango from_local/to_local inválido');
  const rangeMinutes = Math.floor((baseEnd - baseStart) / 60000);
  const theoreticalMax = rangeMinutes >= durMin ? Math.floor((rangeMinutes - durMin) / stepMin) + 1 : 0;
  const requestedLimit = parseIntSafe(query.limit);
  const maxSlots = requestedLimit > 0 ? requestedLimit : Math.min(theoreticalMax, 2000);
  const response = { timezone: timeZone, clinica_id: clinicId, fecha_local: date, duracion_min: durMin, granularity_min: stepMin };
  // Preserve the legacy missing-doctor batch behavior (including full-window
  // diagnostics); an invalid/archived installation is never queried for data.
  if (doctorId && installationIds.length && !snapshot.doctorMap.has(doctorId)) {
    return { ...response, doctor_id: doctorId, instalacion_ids: installationIds,
      slots_by_instalacion: Object.fromEntries(installationIds.map(id => [id, []])),
      ...(includeUnavailable ? { unavailable_by_instalacion: Object.fromEntries(installationIds.map(id => [id, [{
        start_local: formatLocal(baseStart, timeZone), end_local: formatLocal(baseEnd, timeZone),
        start_utc: baseStart.toISOString(), end_utc: baseEnd.toISOString(), interval_kind: 'resource_schedule_window',
        resource_conflicts: [{ resource_type: 'staff', resource_role: 'doctor', resource_id: doctorId, clinica_id: clinicId,
          code: 'STAFF_OUT_OF_HOURS', can_force: false, details: { message: 'Doctor no asignado a la clínica' } }],
      }]])) } : {}) };
  }
  const pair = (doctor, installation) => {
    const inst = installation ? snapshot.installationMap.get(installation) : null;
    if (installation && !inst) throw availabilityInputError('Instalación no encontrada o no pertenece a la clínica', installationIds.length ? 400 : 404);
    const doctorCtx = doctor ? day.doctorContexts.get(doctor) : null;
    const rows = { instBlocksRows: day.installationBlocks.get(installation) || [],
      instCitasRows: day.installationAppointments.get(installation) || [], docBlocksRows: day.doctorBlocks.get(doctor) || [],
      docCitasRows: day.doctorAppointments.get(doctor) || [] };
    return { slots: buildLegacySlots({ baseStart, baseEnd, clinicHasSchedule: day.clinicHasSchedule, clinicWins: day.clinicWins,
      inst, instWins: day.installationWindows.get(installation) || [], doctorCtx, additionalStaffIds: snapshot.additionalStaffIds,
      supportContext: snapshot.supportContext, timeZone, durMin, stepMin, maxSlots, ...rows }),
      ...(includeUnavailable ? { unavailable: buildUnavailableIntervals({ clinicaId: clinicId, timeZone, fecha_local: date,
        dow: day.dow, clinicHasSchedule: day.clinicHasSchedule, clinicWins: day.clinicWins, baseStart, baseEnd, durMin, stepMin,
        instalacionId: installation, doctorId: doctor, inst, dc: doctor ? snapshot.doctorMap.get(doctor) || null : undefined,
        additionalStaffIds: snapshot.additionalStaffIds, supportContext: snapshot.supportContext, ...rows }) } : {}) };
  };
  if (query.summary_only === true) {
    // Validate the whole requested installation footprint before early OR.
    // A valid room must not hide an invalid/foreign column in the same batch.
    if ([installationId, ...installationIds].filter(Boolean).some(id => !snapshot.installationMap.has(id))) {
      throw availabilityInputError('Instalación no encontrada o no pertenece a la clínica', installationIds.length ? 400 : 404);
    }
    const pairs = installationIds.length ? installationIds.map(id => [doctorId, id])
      : doctorIds.length ? doctorIds.map(id => [id, installationId]) : [[doctorId, installationId]];
    for (const [doctor, installation] of pairs) {
      const result = pair(doctor, installation);
      if (result.slots.length) return { ...response, slots: result.slots };
    }
    return { ...response, slots: [] };
  }
  if (installationIds.length) {
    const pairs = installationIds.map(id => [id, pair(doctorId, id)]);
    return { ...response, doctor_id: doctorId, instalacion_ids: installationIds,
      slots_by_instalacion: Object.fromEntries(pairs.map(([id, p]) => [id, p.slots])),
      ...(includeUnavailable ? { unavailable_by_instalacion: Object.fromEntries(pairs.map(([id, p]) => [id, p.unavailable])) } : {}) };
  }
  if (doctorIds.length) {
    const pairs = doctorIds.map(id => [id, pair(id, installationId)]);
    return { ...response, instalacion_id: installationId, doctor_ids: doctorIds,
      slots_by_doctor: Object.fromEntries(pairs.map(([id, p]) => [id, p.slots])),
      ...(includeUnavailable ? { unavailable_by_doctor: Object.fromEntries(pairs.map(([id, p]) => [id, p.unavailable])) } : {}) };
  }
  const result = pair(doctorId, installationId);
  return { ...response, slots: result.slots, ...(includeUnavailable ? { unavailable_intervals: result.unavailable } : {}) };
}

function matrixColumnQuery(baseQuery, query, columnId) {
  const normalizedMode = query.mode === 'doctor' ? 'doctor' : 'installation';
  const contextDoctorId = query.context_doctor_id !== 'todos' ? parseIntSafe(query.context_doctor_id) : null;
  const contextInstallationId = query.context_instalacion_id !== 'todos' ? parseIntSafe(query.context_instalacion_id) : null;
  if (normalizedMode === 'doctor') {
    const installation = contextInstallationId || parseIntSafe(query.preferred_instalacion_id);
    const peers = parseIntArray(query.peer_instalacion_ids || query['peer_instalacion_ids[]']);
    return { ...baseQuery, doctor_id: String(columnId), ...(installation ? { instalacion_id: String(installation) }
      : peers.length ? { instalacion_ids: peers } : {}) };
  }
  const peers = parseIntArray(query.peer_doctor_ids || query['peer_doctor_ids[]']);
  return { ...baseQuery, instalacion_id: String(contextInstallationId || columnId),
    ...(contextDoctorId ? { doctor_id: String(contextDoctorId) } : peers.length ? { doctor_ids: peers } : {}) };
}

async function prepareRangePayloads(req, dates, queries, { grid = false } = {}) {
  const clinicId = parseIntSafe(req.query.clinica_id);
  if (!clinicId || clinicId <= 0) throw availabilityInputError('clinica_id requerido');
  if (!(parseIntSafe(req.query.duracion_min) > 0)) throw availabilityInputError('duracion_min requerido');
  const requestStep = req.query.granularity_min == null ? 15 : parseIntSafe(req.query.granularity_min);
  if (!(requestStep > 0 && requestStep <= 120)) throw availabilityInputError('granularity_min debe estar entre 1 y 120');
  await assertUserCanAccessFeature({ actorId: Number(req.userData?.userId), featureKey: 'appointments.view', clinicId });
  const clinic = await db.Clinica.findByPk(clinicId, { attributes: ['id_clinica', 'nombre_clinica', 'configuracion', 'grupoClinicaId', 'equipment_booking_enabled'] });
  if (!clinic) throw availabilityInputError('Clínica no encontrada', 404);
  const additionalStaffIds = requestedAdditionalStaff(req);
  let profile = null;
  if (req.query.tratamiento_id) {
    profile = requireOperationalProfile(await loadScopedTreatment({ db, treatmentId: req.query.tratamiento_id, clinic }));
    if (profile) {
      assertGridProfile(profile);
      const step = parseIntSafe(req.query.granularity_min) || 15;
      if (step < 5 || step > 120 || queries.some(query => parseIntArray(query.instalacion_ids).length > 50 || parseIntArray(query.doctor_ids).length > 50)) {
        throw availabilityInputError('Rango o recursos de disponibilidad inválidos');
      }
    }
  }
  const timeZone = resolveClinicTimezone(clinic), sortedDates = [...dates].sort();
  if (grid && profile && resolveLocalInstant(addDays(sortedDates[sortedDates.length - 1], 1), '00:00:00', timeZone)
    - resolveLocalInstant(sortedDates[0], '00:00:00', timeZone) > 32 * 86400000) throw availabilityInputError('El rango no puede superar 31 días');
  // Normal 42-day calendar needs one range. Disjoint legacy requests spanning
  // years retain compatibility without asking the canonical readers to load
  // more than their bounded 367-day resource range.
  const groups = [];
  for (const date of sortedDates) {
    let group = groups[groups.length - 1];
    if (!group || resolveLocalInstant(addDays(date, 1), '00:00:00', timeZone)
      - resolveLocalInstant(group[0], '00:00:00', timeZone) > 367 * 86400000) groups.push(group = []);
    group.push(date);
  }
  const doctors = [...new Set(queries.flatMap(query => [parseIntSafe(query.doctor_id), ...parseIntArray(query.doctor_ids || query['doctor_ids[]'])]).filter(Boolean))];
  const installations = [...new Set(queries.flatMap(query => [parseIntSafe(query.instalacion_id), ...parseIntArray(query.instalacion_ids || query['instalacion_ids[]'])]).filter(Boolean))];
  const byDate = new Map();
  const personalBlocks = [];
  for (const group of groups) {
    if (profile) {
      const context = await loadBookingContext({ db, clinic, profile, dates: group,
        start: resolveLocalInstant(group[0], '00:00:00', timeZone),
        end: resolveLocalInstant(addDays(group[group.length - 1], 1), '00:00:00', timeZone), occupancyEnabled: true, additionalStaffIds,
        includeDiagnosticLabels: grid });
      if (grid) personalBlocks.push(...(context.personalBlocks || []));
      const getPayload = query => profileSlotsPayload({ query, profile, context, clinic, additionalStaffIds });
      group.forEach(date => byDate.set(date, getPayload));
    } else {
      const snapshot = await loadLegacyAvailabilitySnapshot({ db, clinic, dates: group, doctorIds: doctors,
        installationIds: installations, additionalStaffIds, fetchClinicHorarios,
        readers: { resourceAppointments, resourceInstallationBlocks, loadBookingContext } });
      if (grid) personalBlocks.push(...snapshot.personalBlocks);
      group.forEach(date => byDate.set(date, query => legacySnapshotPayload(snapshot, query)));
    }
  }
  return Object.assign(query => byDate.get(query.fecha_local)(query), { personalBlocks });
}

exports.grid = asyncHandler(async (req, res) => {
  const {
    clinica_id,
    dates,
    duracion_min,
    granularity_min,
    from_local,
    to_local,
    tratamiento_id,
    mode,
  } = req.query || {};

  const clinicaId = parseIntSafe(clinica_id);
  if (!clinicaId) return res.status(400).json({ message: 'clinica_id requerido' });

  const dateList = Array.from(new Set(parseDateArray(dates || req.query['dates[]'])));
  if (!dateList.length) {
    return res.status(400).json({ message: 'dates[] requerido (YYYY-MM-DD)' });
  }
  if (dateList.length > 14) {
    return res.status(400).json({ message: 'dates[] excede el máximo (14)' });
  }

  const durMin = parseIntSafe(duracion_min);
  if (!durMin || durMin <= 0) return res.status(400).json({ message: 'duracion_min requerido' });

  const stepMin = parseIntSafe(granularity_min) || 15;
  const columnIds = parseIntArray(req.query.column_ids || req.query['column_ids[]']);
  if (!columnIds.length) {
    return res.status(400).json({ message: 'column_ids[] requerido' });
  }
  if (columnIds.length > 80) {
    return res.status(400).json({ message: 'column_ids[] excede el máximo (80)' });
  }

  const normalizedMode = mode === 'doctor' ? 'doctor' : 'installation';

  const baseQuery = {
    clinica_id: String(clinicaId),
    duracion_min: String(durMin),
    granularity_min: String(stepMin),
    include_unavailable: 'true',
  };
  if (from_local) baseQuery.from_local = from_local;
  if (to_local) baseQuery.to_local = to_local;
  if (tratamiento_id) baseQuery.tratamiento_id = tratamiento_id;
  const additionalStaffIds = requestedAdditionalStaff(req);
  if (additionalStaffIds.length) baseQuery.additional_staff_ids = additionalStaffIds;

  let getPayload;
  try {
    getPayload = await prepareRangePayloads(req, dateList,
      columnIds.map(id => matrixColumnQuery(baseQuery, req.query, id)), { grid: true });
  } catch (error) {
    if (!error.code && (error.statusCode === 400 || error.statusCode === 404)) return res.status(error.statusCode).json({ message: error.message });
    throw error;
  }

  const tasks = [];
  dateList.forEach((dateIso) => {
    columnIds.forEach((columnId) => {
      tasks.push({ dateIso, columnId });
    });
  });

  const rows = await runWithConcurrency(tasks, 4, async ({ dateIso, columnId }) => {
    const query = { ...matrixColumnQuery(baseQuery, req.query, columnId), fecha_local: dateIso };

    try {
      const payload = getPayload(query);
      return {
        day_id: dateIso,
        column_id: String(columnId),
        ok: true,
        slots: Array.isArray(payload?.slots) ? payload.slots : undefined,
        unavailable_intervals: Array.isArray(payload?.unavailable_intervals) ? payload.unavailable_intervals : undefined,
        slots_by_instalacion: payload?.slots_by_instalacion || undefined,
        unavailable_by_instalacion: payload?.unavailable_by_instalacion || undefined,
        slots_by_doctor: payload?.slots_by_doctor || undefined,
        unavailable_by_doctor: payload?.unavailable_by_doctor || undefined,
      };
    } catch (error) {
      console.warn('[Disponibilidad][grid] No se pudo calcular columna.', {
        dateIso,
        columnId,
        mode: normalizedMode,
        message: error?.message || error,
      });
      return {
        day_id: dateIso,
        column_id: String(columnId),
        ok: false,
        error: error?.message || 'availability_grid_column_failed',
      };
    }
  });

  return res.json({
    clinica_id: clinicaId,
    dates: dateList,
    mode: normalizedMode,
    duracion_min: durMin,
    granularity_min: stepMin,
    columns: columnIds.map((id) => String(id)),
    personal_blocks: getPayload.personalBlocks,
    rows,
  });
});

exports.summary = asyncHandler(async (req, res) => {
  const { dates, duracion_min } = req.query || {};
  const dateList = parseDateArray(dates || req.query['dates[]']);

  if (!dateList.length) {
    return res.status(400).json({ message: 'dates[] requerido (YYYY-MM-DD)' });
  }

  if (dateList.length > 42) {
    return res.status(400).json({ message: 'dates[] excede el máximo (42)' });
  }

  if (!(parseIntSafe(duracion_min) > 0)) {
    return res.status(400).json({ message: 'duracion_min requerido' });
  }

  const uniqueDates = Array.from(new Set(dateList));
  const baseQuery = { ...req.query };
  delete baseQuery.dates;
  delete baseQuery['dates[]'];
  baseQuery.limit = '1';
  baseQuery.include_unavailable = 'false';
  baseQuery.summary_only = true;
  const columnIds = parseIntArray(req.query.column_ids || req.query['column_ids[]']);
  if (columnIds.length > 80) return res.status(400).json({ message: 'column_ids[] excede el máximo (80)' });
  const queries = columnIds.length ? columnIds.map(id => matrixColumnQuery(baseQuery, req.query, id)) : [baseQuery];
  let getPayload;
  try {
    getPayload = await prepareRangePayloads(req, uniqueDates, queries);
  } catch (error) {
    if (!error.code && (error.statusCode === 400 || error.statusCode === 404)) return res.status(error.statusCode).json({ message: error.message });
    throw error;
  }
  const summaryRows = uniqueDates.map(dateIso => {
    let hasUnknown = false;
    for (const query of queries) {
      try {
        const available = responseHasAnySlots(getPayload({ ...query, fecha_local: dateIso }));
        if (available === true) return { date: dateIso, has_availability: true };
        if (available == null) hasUnknown = true;
      } catch (error) {
        hasUnknown = true;
        console.warn('[Disponibilidad][summary] No se pudo calcular disponibilidad diaria.', { dateIso, message: error?.message || error });
      }
    }
    return { date: dateIso, has_availability: hasUnknown ? null : false };
  });

  const byDay = {};
  summaryRows.forEach((row) => {
    byDay[row.date] = row.has_availability;
  });

  return res.json({
    by_day: byDay,
    dates: uniqueDates,
  });
});
