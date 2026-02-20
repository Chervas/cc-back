const asyncHandler = require('express-async-handler');
const db = require('../../models');
const { Op } = db.Sequelize;

const DEFAULT_TIMEZONE = 'Europe/Madrid';

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

const isIsoLike = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);

const parseClinicConfig = (value) => {
  if (!value) return null;
  if (typeof value === 'object') return value;
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (err) {
      return null;
    }
  }
  return null;
};

const isMissingClinicScheduleTableError = (error) => {
  if (!error) return false;
  const code = error?.original?.code || error?.parent?.code || error?.code;
  if (code === 'ER_NO_SUCH_TABLE') return true;
  const msg = String(error?.original?.message || error?.message || '').toLowerCase();
  return msg.includes('clinicahorarios') && (msg.includes("doesn't exist") || msg.includes('no such table'));
};

const isValidTimeZone = (value) => {
  if (!value || typeof value !== 'string') return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch (err) {
    return false;
  }
};

const resolveClinicTimezone = (clinica) => {
  const cfg = parseClinicConfig(clinica && clinica.configuracion);
  const candidates = [
    cfg && (cfg.timezone || cfg.timeZone || cfg.tz),
    clinica && (clinica.timezone || clinica.time_zone || clinica.tz)
  ];

  for (const candidate of candidates) {
    if (isValidTimeZone(candidate)) return candidate;
  }
  return DEFAULT_TIMEZONE;
};

const formatPartsInTimeZone = (date, timeZone) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date);

  const bag = {};
  parts.forEach((p) => {
    if (p.type !== 'literal') bag[p.type] = p.value;
  });

  return {
    year: Number(bag.year),
    month: Number(bag.month),
    day: Number(bag.day),
    hour: Number(bag.hour),
    minute: Number(bag.minute),
    second: Number(bag.second)
  };
};

const offsetMinutesForTimeZone = (date, timeZone) => {
  const p = formatPartsInTimeZone(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60000);
};

const normalizeHms = (value, fallback = '00:00:00') => {
  const raw = String(value || fallback).trim();
  const m = raw.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return null;
  return `${m[1]}:${m[2]}:${m[3] || '00'}`;
};

const localDateTimeToUtc = (fechaLocal, timeValue, timeZone) => {
  if (!fechaLocal || typeof fechaLocal !== 'string') return null;
  const d = fechaLocal.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!d) return null;

  const hms = normalizeHms(timeValue);
  if (!hms) return null;
  const t = hms.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!t) return null;

  const year = Number(d[1]);
  const month = Number(d[2]);
  const day = Number(d[3]);
  const hour = Number(t[1]);
  const minute = Number(t[2]);
  const second = Number(t[3]);

  const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  let ts = naiveUtc;

  // Dos iteraciones son suficientes para converger en cambios de DST.
  for (let i = 0; i < 2; i++) {
    const offsetMin = offsetMinutesForTimeZone(new Date(ts), timeZone);
    ts = naiveUtc - offsetMin * 60000;
  }

  return new Date(ts);
};

const formatDateLocal = (date, timeZone) => {
  const p = formatPartsInTimeZone(date, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
};

/**
 * Parse "YYYY-MM-DDTHH:mm" sin offset como hora local de clínica.
 * Si el string incluye zona (Z o +/-hh:mm), se respeta.
 */
const parseDateTime = (value, timeZone) => {
  if (!value || typeof value !== 'string') return null;

  // Con timezone explícita (Z o +/-hh:mm)
  if (/[Zz]$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // "YYYY-MM-DDTHH:mm" o "YYYY-MM-DDTHH:mm:ss" sin timezone -> hora local de la clínica.
  const m = value.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}(?::\d{2})?)$/);
  if (m) {
    return localDateTimeToUtc(m[1], m[2], timeZone);
  }

  // Fallback: intentar parse nativo
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const formatLocal = (date, timeZone) => {
  const p = formatPartsInTimeZone(date, timeZone);
  const pad = (n) => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
};

const buildWindowsFromHorarios = (horarios, dow, fechaLocal, timeZone) => {
  // horario: { dia_semana, activo, hora_inicio, hora_fin }
  const base = (horarios || [])
    .filter((h) => h.dia_semana === dow && h.activo)
    .map((h) => {
      const start = localDateTimeToUtc(fechaLocal, h.hora_inicio, timeZone);
      const end = localDateTimeToUtc(fechaLocal, h.hora_fin, timeZone);
      return { start, end };
    })
    .filter((w) => w.start && w.end && Number.isFinite(w.start.getTime()) && Number.isFinite(w.end.getTime()) && w.start < w.end);
  return base;
};

const hasActiveSchedule = (horarios) => {
  return Array.isArray(horarios) && horarios.some((h) => !!h.activo);
};

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
  if (!a.length) return [...b];
  if (!b.length) return [...a];
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

const inAnyWindow = (windows, start, end) => {
  if (!Array.isArray(windows) || windows.length === 0) return false;
  return windows.some((w) => start >= w.start && end <= w.end);
};

const normalizeTimeRangeRows = (rows, startKey, endKey) => {
  return (rows || [])
    .map((r) => ({
      ...r,
      start: new Date(r[startKey]),
      end: new Date(r[endKey])
    }))
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
        details: { message: 'Doctor fuera de horario' }
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
        can_force: false,
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

    const dc = firstOverlap(docCitas, start, end);
    if (dc) {
      conflicts.push({
        resource_type: 'staff',
        resource_role: 'doctor',
        resource_id: doctorId,
        clinica_id: clinicaId,
        code: 'STAFF_OVERLAP',
        can_force: true,
        details: { message: 'Doctor ocupado' }
      });
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
  const docWins = dc && dc !== null ? buildWindowsFromHorarios(dc.horarios || [], dow, fecha_local, timeZone) : [];
  const dcMissing = doctorId && dc === null;

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

  const clinica = await db.Clinica.findByPk(clinicaId, { attributes: ['id_clinica', 'nombre_clinica', 'configuracion'] });
  if (!clinica) return res.status(404).json({ message: 'Clínica no encontrada' });

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
        can_force: false,
        details: { cita_ids: citasInst.map((c) => c.id_cita), message: 'Instalación ocupada' }
      });
    }
  }

  // Staff (doctor) - de momento solo doctor_id (personal_ids[] vendrá en 18.12)
  const doctorId = doctor_id ? parseIntSafe(doctor_id) : null;
  if (doctorId) {
    const dc = await db.DoctorClinica.findOne({
      where: { doctor_id: doctorId, clinica_id: clinicaId, activo: true },
      include: [{ model: db.DoctorHorario, as: 'horarios' }]
    });

    if (!dc) {
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
      const docWins = buildWindowsFromHorarios(dc.horarios || [], dow, fechaLocalCheck, clinicTimezone);
      const inRange = inAnyWindow(docWins, start, end);
      if (!inRange) {
        conflicts.push({
          resource_type: 'staff',
          resource_role: 'doctor',
          resource_id: doctorId,
          clinica_id: clinicaId,
          code: 'STAFF_OUT_OF_HOURS',
          can_force: false,
          details: { message: 'Doctor fuera de horario' }
        });
      }
    }

    const bloqueos = await db.DoctorBloqueo.findAll({
      where: {
        doctor_id: doctorId,
        fecha_inicio: { [Op.lt]: end },
        fecha_fin: { [Op.gt]: start }
      }
    });
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
      doctor_id: doctorId,
      inicio: { [Op.lt]: end },
      fin: { [Op.gt]: start }
    };
    if (ignoreId) citasDocWhere.id_cita = { [Op.ne]: ignoreId };
    const citasDoc = await db.CitaPaciente.findAll({ where: citasDocWhere, attributes: ['id_cita'] });
    if (citasDoc.length) {
      conflicts.push({
        resource_type: 'staff',
        resource_role: 'doctor',
        resource_id: doctorId,
        clinica_id: clinicaId,
        code: 'STAFF_OVERLAP',
        // Overbooking doctor permitido -> forzable
        can_force: true,
        details: { cita_ids: citasDoc.map((c) => c.id_cita), message: 'Doctor ocupado' }
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

  const clinica = await db.Clinica.findByPk(clinicaId, { attributes: ['id_clinica', 'nombre_clinica', 'configuracion'] });
  if (!clinica) return res.status(404).json({ message: 'Clínica no encontrada' });
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

  const buildSlots = ({
    inst,
    dc,
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
    if (dc === null) {
      // Se pidió doctor, pero no existe asignación/horario en la clínica
      windows = [];
    } else if (dc) {
      const docWins = buildWindowsFromHorarios(dc.horarios || [], dow, fecha_local, clinicTimezone);
      windows = intersectWindows(windows, docWins);
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
      include: [{ model: db.DoctorHorario, as: 'horarios' }]
    });

    // Si no hay asignación del doctor, devolvemos vacío para todas las instalaciones.
    if (!dc) {
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
      where: { instalacion_id: { [Op.in]: instalacionIds }, inicio: { [Op.lt]: baseEnd }, fin: { [Op.gt]: baseStart } },
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

    const docBloqRows = await db.DoctorBloqueo.findAll({
      where: { doctor_id: doctorId, fecha_inicio: { [Op.lt]: baseEnd }, fecha_fin: { [Op.gt]: baseStart } },
      attributes: ['fecha_inicio', 'fecha_fin', 'motivo', 'tipo', 'clinica_id']
    });
    const docCitasRows = await db.CitaPaciente.findAll({
      where: { doctor_id: doctorId, inicio: { [Op.lt]: baseEnd }, fin: { [Op.gt]: baseStart } },
      attributes: ['inicio', 'fin']
    });

    const slotsByInst = {};
    const unavailableByInst = {};
    instalacionIds.forEach((id) => {
      const inst = instMap.get(id);
      const slots = buildSlots({
        inst,
        dc,
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
      where: { instalacion_id: instalacionId, inicio: { [Op.lt]: baseEnd }, fin: { [Op.gt]: baseStart } },
      attributes: ['inicio', 'fin']
    });

    const dcRows = await db.DoctorClinica.findAll({
      where: { doctor_id: { [Op.in]: doctorIds }, clinica_id: clinicaId, activo: true },
      include: [{ model: db.DoctorHorario, as: 'horarios' }]
    });
    const dcByDoctor = new Map(dcRows.map((r) => [r.doctor_id, r]));

    const docBloqRows = await db.DoctorBloqueo.findAll({
      where: { doctor_id: { [Op.in]: doctorIds }, fecha_inicio: { [Op.lt]: baseEnd }, fecha_fin: { [Op.gt]: baseStart } },
      attributes: ['doctor_id', 'fecha_inicio', 'fecha_fin', 'motivo', 'tipo', 'clinica_id']
    });
    const docCitasRows = await db.CitaPaciente.findAll({
      where: { doctor_id: { [Op.in]: doctorIds }, inicio: { [Op.lt]: baseEnd }, fin: { [Op.gt]: baseStart } },
      attributes: ['doctor_id', 'inicio', 'fin']
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
      const slots = buildSlots({
        inst,
        dc,
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
      where: { instalacion_id: instalacionId, inicio: { [Op.lt]: baseEnd }, fin: { [Op.gt]: baseStart } },
      attributes: ['inicio', 'fin']
    });
  }

  if (doctorId) {
    const dcRow = await db.DoctorClinica.findOne({
      where: { doctor_id: doctorId, clinica_id: clinicaId, activo: true },
      include: [{ model: db.DoctorHorario, as: 'horarios' }]
    });
    dc = dcRow || null;

    docBloqRows = await db.DoctorBloqueo.findAll({
      where: { doctor_id: doctorId, fecha_inicio: { [Op.lt]: baseEnd }, fecha_fin: { [Op.gt]: baseStart } },
      attributes: ['fecha_inicio', 'fecha_fin', 'motivo', 'tipo', 'clinica_id']
    });
    docCitasRows = await db.CitaPaciente.findAll({
      where: { doctor_id: doctorId, inicio: { [Op.lt]: baseEnd }, fin: { [Op.gt]: baseStart } },
      attributes: ['inicio', 'fin']
    });
  }

  const slots = buildSlots({
    inst: inst || undefined,
    dc,
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
