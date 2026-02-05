const asyncHandler = require('express-async-handler');
const db = require('../../models');
const { Op } = db.Sequelize;

const DEFAULT_TIMEZONE = 'Europe/Madrid';

const parseBool = (v) => v === true || v === 'true' || v === '1';

const overlap = (startA, endA, startB, endB) => startA < endB && startB < endA;

const dayIndex = (date) => new Date(date).getDay();
const toTime = (d) => d.toTimeString().slice(0, 5);

const parseIntSafe = (v) => {
  const n = Number.parseInt(String(v), 10);
  return Number.isFinite(n) ? n : null;
};

const isIsoLike = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(value);

/**
 * Parse "YYYY-MM-DDTHH:mm" (sin offset) como UTC para ser consistente con el motor legacy.
 * Si el string incluye zona (Z o +/-hh:mm), se respeta.
 */
const parseDateTime = (value) => {
  if (!value || typeof value !== 'string') return null;

  // Con timezone explícita (Z o +/-hh:mm)
  if (/[Zz]$/.test(value) || /[+-]\d{2}:\d{2}$/.test(value)) {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // "YYYY-MM-DDTHH:mm" o "YYYY-MM-DDTHH:mm:ss" sin timezone -> UTC
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) {
    const d = new Date(`${value}:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) {
    const d = new Date(`${value}Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // Fallback: intentar parse nativo
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

const formatLocal = (date) => date.toISOString().slice(0, 16);

const buildWindowsFromHorarios = (horarios, dow, fechaLocal) => {
  // horario: { dia_semana, activo, hora_inicio, hora_fin }
  const base = (horarios || [])
    .filter((h) => h.dia_semana === dow && h.activo)
    .map((h) => ({
      start: new Date(`${fechaLocal}T${h.hora_inicio}:00Z`),
      end: new Date(`${fechaLocal}T${h.hora_fin}:00Z`)
    }))
    .filter((w) => Number.isFinite(w.start.getTime()) && Number.isFinite(w.end.getTime()) && w.start < w.end);
  return base;
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

  const start = parseDateTime(inicio_local);
  if (!start) {
    return res.status(400).json({ message: 'inicio_local inválido' });
  }

  let end = null;
  if (fin_local) {
    end = parseDateTime(fin_local);
    if (!end) return res.status(400).json({ message: 'fin_local inválido' });
  } else {
    const dur = parseIntSafe(duracion_min);
    if (!dur || dur <= 0) return res.status(400).json({ message: 'fin_local o duracion_min requerido' });
    end = new Date(start.getTime() + dur * 60000);
  }

  if (end <= start) {
    return res.status(400).json({ message: 'rango inválido (fin <= inicio)' });
  }

  const clinica = await db.Clinica.findByPk(clinicaId, { attributes: ['id_clinica', 'nombre_clinica'] });
  if (!clinica) return res.status(404).json({ message: 'Clínica no encontrada' });

  const conflicts = [];
  const warnings = [];

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

    const dow = dayIndex(start);
    const h = (inst.horarios || []).find((row) => row.dia_semana === dow);
    const inRange = h && h.activo && `${h.hora_inicio}` <= toTime(start) && `${h.hora_fin}` >= toTime(end);
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
      const dow = dayIndex(start);
      const h = (dc.horarios || []).find((row) => row.dia_semana === dow);
      const inRange = h && h.activo && `${h.hora_inicio}` <= toTime(start) && `${h.hora_fin}` >= toTime(end);
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
        details: { bloqueo_id: b.id, message: b.motivo || 'Bloqueo doctor' }
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
      timezone: DEFAULT_TIMEZONE
    },
    range: {
      inicio_local: String(inicio_local),
      fin_local: fin_local ? String(fin_local) : formatLocal(end),
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
 * Nota: en esta fase, el "local" se interpreta como UTC (consistente con legacy).
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
    doctor_id,
    limit
  } = req.query || {};

  const clinicaId = parseIntSafe(clinica_id);
  if (!clinicaId) return res.status(400).json({ message: 'clinica_id requerido' });
  if (!fecha_local || typeof fecha_local !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(fecha_local)) {
    return res.status(400).json({ message: 'fecha_local requerido (YYYY-MM-DD)' });
  }

  const durMin = parseIntSafe(duracion_min);
  if (!durMin || durMin <= 0) return res.status(400).json({ message: 'duracion_min requerido' });

  const stepMin = parseIntSafe(granularity_min) || 15;
  const maxSlots = parseIntSafe(limit) || 50;

  const clinica = await db.Clinica.findByPk(clinicaId, { attributes: ['id_clinica', 'nombre_clinica'] });
  if (!clinica) return res.status(404).json({ message: 'Clínica no encontrada' });

  // Base window: día completo (UTC) + recorte opcional from/to
  let baseStart = new Date(`${fecha_local}T00:00:00Z`);
  let baseEnd = new Date(`${fecha_local}T23:59:59Z`);

  if (from_local && typeof from_local === 'string' && /^\d{2}:\d{2}$/.test(from_local)) {
    baseStart = new Date(`${fecha_local}T${from_local}:00Z`);
  }
  if (to_local && typeof to_local === 'string' && /^\d{2}:\d{2}$/.test(to_local)) {
    baseEnd = new Date(`${fecha_local}T${to_local}:00Z`);
  }

  if (!Number.isFinite(baseStart.getTime()) || !Number.isFinite(baseEnd.getTime()) || baseEnd <= baseStart) {
    return res.status(400).json({ message: 'rango from_local/to_local inválido' });
  }

  const dow = dayIndex(baseStart);
  let windows = [{ start: baseStart, end: baseEnd }];

  const instalacionId = instalacion_id ? parseIntSafe(instalacion_id) : null;
  if (instalacionId) {
    const inst = await db.Instalacion.findByPk(instalacionId, {
      include: [
        { model: db.InstalacionHorario, as: 'horarios' },
        { model: db.InstalacionBloqueo, as: 'bloqueos' }
      ]
    });
    if (!inst || !inst.activo) return res.status(404).json({ message: 'Instalación no encontrada' });
    if (inst.clinica_id !== clinicaId) return res.status(400).json({ message: 'instalacion_id no pertenece a clinica_id' });
    const instWins = buildWindowsFromHorarios(inst.horarios || [], dow, fecha_local);
    windows = intersectWindows(windows, instWins);
  }

  const doctorId = doctor_id ? parseIntSafe(doctor_id) : null;
  if (doctorId) {
    const dc = await db.DoctorClinica.findOne({
      where: { doctor_id: doctorId, clinica_id: clinicaId, activo: true },
      include: [{ model: db.DoctorHorario, as: 'horarios' }]
    });
    if (!dc) {
      // Sin asignación/horario -> sin slots
      windows = [];
    } else {
      const docWins = buildWindowsFromHorarios(dc.horarios || [], dow, fecha_local);
      windows = intersectWindows(windows, docWins);
    }
  }

  // Restar bloqueos + citas existentes
  const blocks = [];

  if (instalacionId) {
    const instBloq = await db.InstalacionBloqueo.findAll({
      where: {
        instalacion_id: instalacionId,
        fecha_inicio: { [Op.lt]: baseEnd },
        fecha_fin: { [Op.gt]: baseStart }
      }
    });
    instBloq.forEach((b) => blocks.push({ start: new Date(b.fecha_inicio), end: new Date(b.fecha_fin) }));

    const citasInst = await db.CitaPaciente.findAll({
      where: { instalacion_id: instalacionId, inicio: { [Op.lt]: baseEnd }, fin: { [Op.gt]: baseStart } },
      attributes: ['inicio', 'fin']
    });
    citasInst.forEach((c) => blocks.push({ start: new Date(c.inicio), end: new Date(c.fin) }));
  }

  if (doctorId) {
    const docBloq = await db.DoctorBloqueo.findAll({
      where: { doctor_id: doctorId, fecha_inicio: { [Op.lt]: baseEnd }, fecha_fin: { [Op.gt]: baseStart } }
    });
    docBloq.forEach((b) => blocks.push({ start: new Date(b.fecha_inicio), end: new Date(b.fecha_fin) }));

    const citasDoc = await db.CitaPaciente.findAll({
      where: { doctor_id: doctorId, inicio: { [Op.lt]: baseEnd }, fin: { [Op.gt]: baseStart } },
      attributes: ['inicio', 'fin']
    });
    citasDoc.forEach((c) => blocks.push({ start: new Date(c.inicio), end: new Date(c.fin) }));
  }

  const free = subtractIntervals(windows, blocks);

  const slots = [];
  for (const w of free) {
    let cursor = new Date(w.start);
    while (cursor.getTime() + durMin * 60000 <= w.end.getTime()) {
      const s = new Date(cursor);
      const e = new Date(cursor.getTime() + durMin * 60000);
      slots.push({
        start_local: formatLocal(s),
        end_local: formatLocal(e),
        start_utc: s.toISOString(),
        end_utc: e.toISOString()
      });
      if (slots.length >= maxSlots) break;
      cursor = new Date(cursor.getTime() + stepMin * 60000);
    }
    if (slots.length >= maxSlots) break;
  }

  return res.json({
    timezone: DEFAULT_TIMEZONE,
    clinica_id: clinica.id_clinica,
    fecha_local,
    duracion_min: durMin,
    granularity_min: stepMin,
    slots
  });
});

