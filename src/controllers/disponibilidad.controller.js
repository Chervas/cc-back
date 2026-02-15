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
    instalacion_ids,
    doctor_id,
    doctor_ids,
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
  const requestedLimit = parseIntSafe(limit);

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

  // Si no se especifica limit, devolvemos todos los slots posibles dentro del rango (con un cap razonable).
  // Esto evita respuestas incompletas (ej. limit=50) que rompen el sombreado en frontend.
  const rangeMinutes = Math.floor((baseEnd.getTime() - baseStart.getTime()) / 60000);
  const theoreticalMax = rangeMinutes >= durMin ? Math.floor((rangeMinutes - durMin) / stepMin) + 1 : 0;
  const maxSlots = requestedLimit && requestedLimit > 0 ? requestedLimit : Math.min(theoreticalMax, 2000);

  const dow = dayIndex(baseStart);
  const baseWindows = [{ start: baseStart, end: baseEnd }];

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

    if (inst) {
      const instWins = buildWindowsFromHorarios(inst.horarios || [], dow, fecha_local);
      windows = intersectWindows(windows, instWins);
    }
    if (dc === null) {
      // Se pidió doctor, pero no existe asignación/horario en la clínica
      windows = [];
    } else if (dc) {
      const docWins = buildWindowsFromHorarios(dc.horarios || [], dow, fecha_local);
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
      return res.json({
        timezone: DEFAULT_TIMEZONE,
        clinica_id: clinica.id_clinica,
        fecha_local,
        duracion_min: durMin,
        granularity_min: stepMin,
        doctor_id: doctorId,
        instalacion_ids: instalacionIds,
        slots_by_instalacion: slotsByInst
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
      attributes: ['instalacion_id', 'fecha_inicio', 'fecha_fin']
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
      attributes: ['fecha_inicio', 'fecha_fin']
    });
    const docCitasRows = await db.CitaPaciente.findAll({
      where: { doctor_id: doctorId, inicio: { [Op.lt]: baseEnd }, fin: { [Op.gt]: baseStart } },
      attributes: ['inicio', 'fin']
    });

    const slotsByInst = {};
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
    });

    return res.json({
      timezone: DEFAULT_TIMEZONE,
      clinica_id: clinica.id_clinica,
      fecha_local,
      duracion_min: durMin,
      granularity_min: stepMin,
      doctor_id: doctorId,
      instalacion_ids: instalacionIds,
      slots_by_instalacion: slotsByInst
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
      attributes: ['fecha_inicio', 'fecha_fin']
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
      attributes: ['doctor_id', 'fecha_inicio', 'fecha_fin']
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
    });

    return res.json({
      timezone: DEFAULT_TIMEZONE,
      clinica_id: clinica.id_clinica,
      fecha_local,
      duracion_min: durMin,
      granularity_min: stepMin,
      instalacion_id: instalacionId,
      doctor_ids: doctorIds,
      slots_by_doctor: slotsByDoctor
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
      attributes: ['fecha_inicio', 'fecha_fin']
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
      attributes: ['fecha_inicio', 'fecha_fin']
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
    timezone: DEFAULT_TIMEZONE,
    clinica_id: clinica.id_clinica,
    fecha_local,
    duracion_min: durMin,
    granularity_min: stepMin,
    slots
  });
});
