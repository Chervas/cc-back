const asyncHandler = require('express-async-handler');
const db = require('../../models');
const { Op } = db.Sequelize;
const { assertUserCanAccessFeature } = require('../lib/access-policy');
const { searchTreatmentSlots, loadBookingContext, solutionsForCalendar } = require('../services/appointmentBookingAvailability.service');
const { addDays } = require('../lib/personal-schedule-recurring');
const { resolveLocalInstant } = require('../lib/voucher-schedule-calendar');
const { solveBookingProfile } = require('../lib/booking-profile-solver');
const { requiresMultiResourceBooking } = require('../lib/booking-profile');
const { bookingCapabilities, loadScopedTreatment, requireOperationalProfile } = require('../services/treatmentBookingProfile.service');
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

exports.bookingCapabilities = asyncHandler(async (req, res) => res.json(bookingCapabilities()));

exports.treatmentSlots = asyncHandler(async (req, res) => {
  const clinicId = Number(req.query?.clinica_id);
  if (!Number.isSafeInteger(clinicId) || clinicId <= 0) return res.status(400).json({ message: 'clinica_id requerido' });
  await assertUserCanAccessFeature({ actorId: Number(req.userData?.userId), featureKey: 'appointments.view', clinicId });
  const clinic = await db.Clinica.findByPk(clinicId);
  if (!clinic) return res.status(404).json({ message: 'Clínica no encontrada' });
  return res.json(await searchTreatmentSlots({ db, clinic, treatmentId: req.query?.tratamiento_id,
    date: req.query?.fecha_local, days: Number(req.query?.days || 1), stepMinutes: Number(req.query?.granularity_min || 15),
    limit: Number(req.query?.limit || 100), doctorId: req.query?.doctor_id ? Number(req.query.doctor_id) : null,
    installationId: req.query?.instalacion_id ? Number(req.query.instalacion_id) : null }));
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

const subtractIntervals = (windows, blocks) => {
  let res = [...windows];
  blocks.forEach((b) => {
    res = res.flatMap((w) => {
      if (!overlap(w.start, w.end, b.start, b.end)) return [w];
      const out = [];
      if (w.start < b.start) out.push({ start: w.start, end: b.start });
      if (b.end < w.end) out.push({ start: b.end, end: w.end });
      return out;
    });
  });
  return res.filter((w) => w.start < w.end);
};

const intersectWindows = (a, b) => {
  if (!a.length || !b.length) return [];
  return a
    .flatMap((w) =>
      b.map((d) => ({
        start: new Date(Math.max(w.start, d.start)),
        end: new Date(Math.min(w.end, d.end))
      }))
    )
    .filter((w) => w.start < w.end);
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
        can_force: true,
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
        const citaClinicId = Number(dc.clinica_id);
        const sameClinic = Number.isFinite(citaClinicId) && citaClinicId === Number(clinicaId);
        conflicts.push({
          resource_type: 'staff',
          resource_role: 'doctor',
          resource_id: doctorId,
          clinica_id: clinicaId,
          code: 'STAFF_OVERLAP',
          can_force: sameClinic,
          details: {
            message: sameClinic ? 'Doctor ocupado' : 'Doctor ocupado en otra clínica',
            clinica_id: Number.isFinite(citaClinicId) ? citaClinicId : null
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
      const base = `${c.resource_type}|${c.code}|${c.resource_id ?? ''}|${c.clinica_id ?? ''}`;
      if (c.code === 'STAFF_BLOCKED' || c.code === 'INSTALLATION_BLOCKED') {
        const t = c.details && c.details.tipo ? String(c.details.tipo) : '';
        const m = c.details && c.details.message ? String(c.details.message) : '';
        const cd = c.details && c.details.clinica_id != null ? String(c.details.clinica_id) : '';
        return `${base}|${t}|${m}|${cd}`;
      }
      return base;
    })
    .sort()
    .join(';');
};

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
  docCitasRows
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
    // personal_ids[] (futuro)
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

  const clinica = await db.Clinica.findByPk(clinicaId, { attributes: ['id_clinica', 'nombre_clinica', 'configuracion', 'grupoClinicaId'] });
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

  if (bookingProfile) {
    if (ignore_cita_id) {
      const ignored = await db.CitaPaciente.findByPk(Number(ignore_cita_id), { attributes: ['id_cita', 'clinica_id'] });
      if (!ignored || Number(ignored.clinica_id) !== clinicaId) return res.status(404).json({ message: 'Cita no encontrada' });
    }
    const context = await loadBookingContext({ db, clinic: clinica, profile: bookingProfile, start, end,
      ignoreAppointmentId: ignore_cita_id ? Number(ignore_cita_id) : null, occupancyEnabled: true });
    const selections = bookingProfile.phases.length === 1 && bookingProfile.phases[0].professionals.mode === 'any'
      ? { [bookingProfile.phases[0].key]: { doctor_id, installation_id: instalacion_id } } : {};
    const solution = solveBookingProfile({ profile: bookingProfile, start, ...context, selections });
    if (!solution || new Date(solution.end_at).getTime() !== end.getTime()) return res.status(409).json({ available: false,
      reason: 'blocked', message: 'No hay disponibilidad para el perfil del tratamiento.', can_force: false,
      resource_conflicts: [{ resource_type: 'staff_pool', code: 'BOOKING_UNAVAILABLE', can_force: false,
        details: { message: 'El rango no cumple el perfil de cabinas y profesionales del tratamiento.' } }] });
    return res.json({ available: true, clinica: { clinica_id: clinicaId, timezone: clinicTimezone },
      resources: { doctor_id: solution.phases[0].doctor_ids[0], instalacion_id: solution.phases[0].installation_id },
      warnings: solution.warnings, booking: solution,
      range: { inicio_local: formatLocal(start, clinicTimezone), fin_local: formatLocal(end, clinicTimezone), inicio_utc: start.toISOString(), fin_utc: end.toISOString() } });
  }

  const conflicts = [];
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
    (inst.bloqueos || []).forEach((b) => {
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
    const citasInstWhere = {
      ...ACTIVE_APPOINTMENT_WHERE,
      instalacion_id: instalacionId,
      inicio: { [Op.lt]: end },
      fin: { [Op.gt]: start }
    };
    if (ignoreId) citasInstWhere.id_cita = { [Op.ne]: ignoreId };
    const citasInst = await db.CitaPaciente.findAll({ where: citasInstWhere, attributes: ['id_cita'] });
    if (citasInst.length) {
      conflicts.push({
        resource_type: 'installation',
        resource_id: instalacionId,
        clinica_id: clinicaId,
        code: 'INSTALLATION_OVERLAP',
        can_force: true,
        details: { cita_ids: citasInst.map((c) => c.id_cita), message: 'Instalación ocupada' }
      });
    }
  }

  // Staff (doctor) - de momento solo doctor_id (personal_ids[] vendrá en 18.12)
  const doctorId = doctor_id ? parseIntSafe(doctor_id) : null;
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

    const citasDocWhere = {
      ...ACTIVE_APPOINTMENT_WHERE,
      doctor_id: doctorId,
      inicio: { [Op.lt]: end },
      fin: { [Op.gt]: start }
    };
    if (ignoreId) citasDocWhere.id_cita = { [Op.ne]: ignoreId };
    const citasDoc = await db.CitaPaciente.findAll({ where: citasDocWhere, attributes: ['id_cita', 'clinica_id'] });
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
        can_force: true,
        details: { cita_ids: citasDocSameClinic.map((c) => c.id_cita), message: 'Doctor ocupado' }
      });
    }

    if (citasDocOtherClinics.length) {
      const otherClinicIds = Array.from(
        new Set(
          citasDocOtherClinics
            .map((c) => Number(c.clinica_id))
            .filter((id) => Number.isFinite(id))
        )
      );
      conflicts.push({
        resource_type: 'staff',
        resource_role: 'doctor',
        resource_id: doctorId,
        clinica_id: clinicaId,
        code: 'STAFF_OVERLAP',
        // No se permite forzar cuando el choque es en otra clínica.
        can_force: false,
        details: {
          cita_ids: citasDocOtherClinics.map((c) => c.id_cita),
          clinica_ids: otherClinicIds,
          message: 'Doctor ocupado en otra clínica'
        }
      });
    }
  }

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

  const clinica = await db.Clinica.findByPk(clinicaId, { attributes: ['id_clinica', 'nombre_clinica', 'configuracion', 'grupoClinicaId'] });
  if (!clinica) return res.status(404).json({ message: 'Clínica no encontrada' });
  if (req.query?.tratamiento_id) {
    await assertUserCanAccessFeature({ actorId: Number(req.userData?.userId), featureKey: 'appointments.view', clinicId: clinicaId });
    const treatment = await loadScopedTreatment({ db, treatmentId: req.query.tratamiento_id, clinic: clinica });
    const profile = requireOperationalProfile(treatment);
    if (profile) {
      if (requiresMultiResourceBooking(profile)) {
        return res.status(409).json({ code: 'booking_profile_use_treatment_slots', can_force: false,
          message: 'Este tratamiento usa disponibilidad por fases o equipo. Utiliza la búsqueda de huecos del tratamiento.' });
      }
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
        end: resolveLocalInstant(addDays(fecha_local, 1), '00:00:00', timezone), occupancyEnabled: true });
      const getSolutions = (doctor, installation) => solutionsForCalendar({ profile, context, date: fecha_local,
        stepMinutes: stepMin, limit: Math.min(requestedLimit > 0 ? requestedLimit : 500, 500),
        selections: { [profile.phases[0].key]: { doctor_id: doctor, installation_id: installation } },
        fromLocal: typeof from_local === 'string' ? from_local : '00:00', toLocal: typeof to_local === 'string' ? to_local : null });
      const response = { timezone, clinica_id: clinicaId, fecha_local, duracion_min: profile.phases[0].duration_minutes, granularity_min: stepMin };
      if (installationIds.length) return res.json({ ...response, doctor_id: Number(doctor_id), instalacion_ids: installationIds,
        slots_by_instalacion: Object.fromEntries(installationIds.map((id) => [id, getSolutions(Number(doctor_id), id)])), unavailable_by_instalacion: {} });
      if (professionalIds.length) return res.json({ ...response, instalacion_id: Number(instalacion_id), doctor_ids: professionalIds,
        slots_by_doctor: Object.fromEntries(professionalIds.map((id) => [id, getSolutions(id, Number(instalacion_id))])), unavailable_by_doctor: {} });
      return res.json({ ...response, slots: getSolutions(doctor_id ? Number(doctor_id) : null, instalacion_id ? Number(instalacion_id) : null), unavailable_intervals: [] });
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
  const baseWindows = [{ start: baseStart, end: baseEnd }];
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

  const buildSlots = ({
    inst,
    doctorCtx,
    instBlocksRows,
    instCitasRows,
    docBlocksRows,
    docCitasRows
  }) => {
    let windows = [...baseWindows];

    if (clinicHasSchedule) {
      windows = clinicWins.length ? intersectWindows(windows, clinicWins) : [];
    }

    if (inst) {
      const instWins = buildWindowsFromHorarios(inst.horarios || [], dow, fecha_local, clinicTimezone);
      windows = intersectWindows(windows, instWins);
    }
    if (doctorCtx && doctorCtx.dcMissing) {
      // Se pidió doctor, pero no existe asignación en la clínica
      windows = [];
    } else if (doctorCtx && Array.isArray(doctorCtx.docWins)) {
      windows = intersectWindows(windows, doctorCtx.docWins);
    }

    const blocks = [];
    (instBlocksRows || []).forEach((b) => blocks.push({ start: new Date(b.fecha_inicio), end: new Date(b.fecha_fin) }));
    (instCitasRows || []).forEach((c) => blocks.push({ start: new Date(c.inicio), end: new Date(c.fin) }));
    (docBlocksRows || []).forEach((b) => blocks.push({ start: new Date(b.fecha_inicio), end: new Date(b.fecha_fin) }));
    (docCitasRows || []).forEach((c) => blocks.push({ start: new Date(c.inicio), end: new Date(c.fin) }));

    const free = subtractIntervals(windows, blocks);

    const slots = [];
    for (const w of free) {
      let cursor = new Date(w.start);
      while (cursor.getTime() + durMin * 60000 <= w.end.getTime()) {
        const s = new Date(cursor);
        const e = new Date(cursor.getTime() + durMin * 60000);
        slots.push({
          start_local: formatLocal(s, clinicTimezone),
          end_local: formatLocal(e, clinicTimezone),
          start_utc: s.toISOString(),
          end_utc: e.toISOString()
        });
        if (slots.length >= maxSlots) break;
        cursor = new Date(cursor.getTime() + stepMin * 60000);
      }
      if (slots.length >= maxSlots) break;
    }
    return slots;
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

    const instBloqRows = await db.InstalacionBloqueo.findAll({
      where: { instalacion_id: { [Op.in]: instalacionIds }, fecha_inicio: { [Op.lt]: baseEnd }, fecha_fin: { [Op.gt]: baseStart } },
      // InstalacionBloqueos no tiene columnas `tipo`/`clinica_id` (a diferencia de DoctorBloqueos).
      attributes: ['instalacion_id', 'fecha_inicio', 'fecha_fin', 'motivo']
    });
    const instCitasRows = await db.CitaPaciente.findAll({
      where: { ...ACTIVE_APPOINTMENT_WHERE, instalacion_id: { [Op.in]: instalacionIds }, inicio: { [Op.lt]: baseEnd }, fin: { [Op.gt]: baseStart } },
      attributes: ['instalacion_id', 'inicio', 'fin']
    });

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
    const docCitasRows = await db.CitaPaciente.findAll({
      where: { ...ACTIVE_APPOINTMENT_WHERE, doctor_id: doctorId, inicio: { [Op.lt]: baseEnd }, fin: { [Op.gt]: baseStart } },
      attributes: ['inicio', 'fin', 'clinica_id']
    });

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
          docCitasRows: docCitasRows
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

    const instBloqRows = await db.InstalacionBloqueo.findAll({
      where: { instalacion_id: instalacionId, fecha_inicio: { [Op.lt]: baseEnd }, fecha_fin: { [Op.gt]: baseStart } },
      // InstalacionBloqueos no tiene columnas `tipo`/`clinica_id`.
      attributes: ['fecha_inicio', 'fecha_fin', 'motivo']
    });
    const instCitasRows = await db.CitaPaciente.findAll({
      where: { ...ACTIVE_APPOINTMENT_WHERE, instalacion_id: instalacionId, inicio: { [Op.lt]: baseEnd }, fin: { [Op.gt]: baseStart } },
      attributes: ['inicio', 'fin']
    });

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
    const docCitasRows = await db.CitaPaciente.findAll({
      where: { ...ACTIVE_APPOINTMENT_WHERE, doctor_id: { [Op.in]: doctorIds }, inicio: { [Op.lt]: baseEnd }, fin: { [Op.gt]: baseStart } },
      attributes: ['doctor_id', 'inicio', 'fin', 'clinica_id']
    });

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
          docCitasRows: docCitasById.get(id) || []
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

    instBloqRows = await db.InstalacionBloqueo.findAll({
      where: { instalacion_id: instalacionId, fecha_inicio: { [Op.lt]: baseEnd }, fecha_fin: { [Op.gt]: baseStart } },
      // InstalacionBloqueos no tiene columnas `tipo`/`clinica_id`.
      attributes: ['fecha_inicio', 'fecha_fin', 'motivo']
    });
    instCitasRows = await db.CitaPaciente.findAll({
      where: { ...ACTIVE_APPOINTMENT_WHERE, instalacion_id: instalacionId, inicio: { [Op.lt]: baseEnd }, fin: { [Op.gt]: baseStart } },
      attributes: ['inicio', 'fin']
    });
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
    docCitasRows = await db.CitaPaciente.findAll({
      where: { ...ACTIVE_APPOINTMENT_WHERE, doctor_id: doctorId, inicio: { [Op.lt]: baseEnd }, fin: { [Op.gt]: baseStart } },
      attributes: ['inicio', 'fin', 'clinica_id']
    });
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
        docCitasRows: docCitasRows
      })
    } : {})
  });
});

const invokeSlotsForSummary = (query, userData) => new Promise((resolve, reject) => {
  const req = { query, userData };
  const res = {
    statusCode: 200,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      if (this.statusCode >= 400) {
        const error = new Error(payload?.message || 'slots_summary_failed');
        error.statusCode = this.statusCode;
        error.payload = payload;
        reject(error);
        return this;
      }
      resolve(payload);
      return this;
    }
  };

  Promise.resolve(exports.slots(req, res, reject)).catch(reject);
});

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
    context_doctor_id,
    context_instalacion_id,
    preferred_instalacion_id,
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

  const peerInstalacionIds = parseIntArray(req.query.peer_instalacion_ids || req.query['peer_instalacion_ids[]']);
  const peerDoctorIds = parseIntArray(req.query.peer_doctor_ids || req.query['peer_doctor_ids[]']);
  const normalizedMode = mode === 'doctor' ? 'doctor' : 'installation';
  const contextDoctorId = context_doctor_id && context_doctor_id !== 'todos' ? parseIntSafe(context_doctor_id) : null;
  const contextInstalacionId = context_instalacion_id && context_instalacion_id !== 'todos' ? parseIntSafe(context_instalacion_id) : null;
  const preferredInstalacionId = preferred_instalacion_id ? parseIntSafe(preferred_instalacion_id) : null;

  const baseQuery = {
    clinica_id: String(clinicaId),
    duracion_min: String(durMin),
    granularity_min: String(stepMin),
    include_unavailable: 'true',
  };
  if (from_local) baseQuery.from_local = from_local;
  if (to_local) baseQuery.to_local = to_local;
  if (tratamiento_id) baseQuery.tratamiento_id = tratamiento_id;

  const tasks = [];
  dateList.forEach((dateIso) => {
    columnIds.forEach((columnId) => {
      tasks.push({ dateIso, columnId });
    });
  });

  const rows = await runWithConcurrency(tasks, 4, async ({ dateIso, columnId }) => {
    const query = {
      ...baseQuery,
      fecha_local: dateIso,
    };

    if (normalizedMode === 'doctor') {
      query.doctor_id = String(columnId);
      const resolvedInstalacionId = contextInstalacionId || preferredInstalacionId || null;
      if (resolvedInstalacionId) {
        query.instalacion_id = String(resolvedInstalacionId);
      } else if (peerInstalacionIds.length) {
        query.instalacion_ids = peerInstalacionIds.join(',');
      }
    } else {
      const resolvedInstalacionId = contextInstalacionId || columnId;
      query.instalacion_id = String(resolvedInstalacionId);
      if (contextDoctorId) {
        query.doctor_id = String(contextDoctorId);
      } else if (peerDoctorIds.length) {
        query.doctor_ids = peerDoctorIds.join(',');
      }
    }

    try {
      const payload = await invokeSlotsForSummary(query, req.userData);
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

  if (!parseIntSafe(duracion_min)) {
    return res.status(400).json({ message: 'duracion_min requerido' });
  }

  const uniqueDates = Array.from(new Set(dateList));
  const baseQuery = { ...req.query };
  delete baseQuery.dates;
  delete baseQuery['dates[]'];

  const summaryRows = await runWithConcurrency(uniqueDates, 8, async (dateIso) => {
    try {
      const payload = await invokeSlotsForSummary({
        ...baseQuery,
        fecha_local: dateIso,
        limit: '1',
      }, req.userData);
      return {
        date: dateIso,
        has_availability: responseHasAnySlots(payload),
      };
    } catch (error) {
      console.warn('[Disponibilidad][summary] No se pudo calcular disponibilidad diaria.', {
        dateIso,
        message: error?.message || error,
      });
      return {
        date: dateIso,
        has_availability: null,
      };
    }
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
