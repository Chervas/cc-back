const asyncHandler = require('express-async-handler');
const db = require('../../models');
const { Op } = db.Sequelize;

const parseBool = (v) => v === true || v === 'true' || v === '1';
const dayIndex = (date) => new Date(date).getDay();
const toTime = (d) => d.toTimeString().slice(0,5);

const overlap = (startA, endA, startB, endB) => {
  return startA < endB && startB < endA;
};

exports.list = asyncHandler(async (req, res) => {
  const { clinica_id, group_id, all, activa } = req.query;
  const where = {};
  if (!parseBool(all)) {
    if (clinica_id) where.clinica_id = clinica_id;
  }
  if (activa !== undefined) where.activo = parseBool(activa);
  const include = [];
  if (group_id) {
    include.push({ model: db.Clinica, as: 'clinica', where: { id_grupo: group_id }, attributes: ['id_clinica','nombre_clinica','id_grupo'] });
  } else {
    include.push({ model: db.Clinica, as: 'clinica', attributes: ['id_clinica','nombre_clinica','id_grupo'] });
  }

  const items = await db.Instalacion.findAll({ where, include, order: [['orden_visualizacion','ASC'], ['id','ASC']] });
  res.json(items);
});

const buildWindowsFromHorarios = (horarios, dow) => {
  if (!horarios || horarios.length === 0) return [];
  return horarios
    .filter(h => h.dia_semana === dow && h.activo)
    .map(h => ({ start: h.hora_inicio, end: h.hora_fin }));
};

const subtractIntervals = (windows, blocks) => {
  // windows: [{start: Date, end: Date}], blocks same
  let res = [...windows];
  blocks.forEach(b => {
    res = res.flatMap(w => {
      if (!overlap(w.start, w.end, b.start, b.end)) return [w];
      const out = [];
      if (w.start < b.start) out.push({ start: w.start, end: b.start });
      if (b.end < w.end) out.push({ start: b.end, end: w.end });
      return out;
    });
  });
  return res;
};

const timeStrToDate = (fecha, hhmm) => new Date(`${fecha}T${hhmm}:00Z`);

exports.disponibilidad = asyncHandler(async (req, res) => {
  const { clinica_id, group_id, fecha, inicio, fin, instalacion_id, doctor_id, duracion_min, force, slots } = req.query;
  const wantsSlots = parseBool(slots) || (!inicio && !fin && fecha);
  if (!fecha && !(inicio && fin)) {
    return res.status(400).json({ message: 'fecha o inicio/fin requeridos' });
  }
  const start = inicio ? new Date(inicio) : new Date(`${fecha}T00:00:00Z`);
  let durMinParam = duracion_min ? parseInt(duracion_min,10) : null;
  if (isNaN(start)) return res.status(400).json({ message: 'rango inválido' });
  let end = fin ? new Date(fin) : null;
  if (fin && isNaN(end)) return res.status(400).json({ message: 'rango inválido' });

  const conflicts = [];
  let instData = null;
  let docData = null;

  // Instalacion checks
  if (instalacion_id) {
    instData = await db.Instalacion.findByPk(instalacion_id, { include: [{ model: db.InstalacionHorario, as: 'horarios' }, { model: db.InstalacionBloqueo, as: 'bloqueos' }, { model: db.Clinica, as: 'clinica', attributes: ['id_clinica','id_grupo'] }] });
    if (!instData || !instData.activo) return res.status(404).json({ message: 'Instalación no encontrada' });
    if (clinica_id && instData.clinica_id !== parseInt(clinica_id,10)) conflicts.push({ type: 'not_in_clinic', message: 'Instalación fuera de la clínica' });
    if (group_id && instData.clinica?.id_grupo && instData.clinica.id_grupo !== parseInt(group_id,10)) conflicts.push({ type: 'not_in_group', message: 'Instalación fuera del grupo' });
    if (!durMinParam && instData.default_duracion_minutos) durMinParam = instData.default_duracion_minutos;
  }

  // Doctor checks
  if (doctor_id) {
    docData = await db.DoctorClinica.findOne({ where: clinica_id ? { doctor_id, clinica_id } : { doctor_id }, include: [{ model: db.DoctorHorario, as: 'horarios' }] });
    if (!docData || !docData.activo) conflicts.push({ type: 'doctor_unavailable', message: 'Doctor no asignado a la clínica' });
  }

  // If slots requested, compute windows first
  if (wantsSlots) {
    const durMin = durMinParam && durMinParam > 0 ? durMinParam : (instData?.default_duracion_minutos || 30);
    const dow = dayIndex(start);
    let windows = [{ start: timeStrToDate(fecha, '00:00'), end: timeStrToDate(fecha, '23:59') }];

    if (instData) {
      const instWins = buildWindowsFromHorarios(instData.horarios || [], dow).map(w => ({ start: timeStrToDate(fecha, w.start), end: timeStrToDate(fecha, w.end) }));
      windows = instWins.length ? instWins : [];
    }
    if (docData) {
      const docWins = buildWindowsFromHorarios(docData.horarios || [], dow).map(w => ({ start: timeStrToDate(fecha, w.start), end: timeStrToDate(fecha, w.end) }));
      windows = windows.length ? subtractIntervals(windows, []) : docWins; // start with docWins if no inst window
      if (windows.length && docWins.length) {
        // intersect windows with docWins
        windows = windows.flatMap(w => docWins.map(d => ({ start: new Date(Math.max(w.start, d.start)), end: new Date(Math.min(w.end, d.end)) })))
                         .filter(w => w.start < w.end);
      }
    }

    // Blocks
    const blockIntervals = [];
    if (instData) {
      (instData.bloqueos || []).forEach(b => blockIntervals.push({ start: new Date(b.fecha_inicio), end: new Date(b.fecha_fin) }));
      const citasInst = await db.CitaPaciente.findAll({ where: { instalacion_id, inicio: { [Op.lt]: timeStrToDate(fecha,'23:59') }, fin: { [Op.gt]: timeStrToDate(fecha,'00:00') } }, attributes: ['inicio','fin'] });
      citasInst.forEach(c => blockIntervals.push({ start: new Date(c.inicio), end: new Date(c.fin) }));
    }
    if (doctor_id) {
      const bloqueos = await db.DoctorBloqueo.findAll({ where: { doctor_id, fecha_inicio: { [Op.lt]: timeStrToDate(fecha,'23:59') }, fecha_fin: { [Op.gt]: timeStrToDate(fecha,'00:00') } } });
      bloqueos.forEach(b => blockIntervals.push({ start: new Date(b.fecha_inicio), end: new Date(b.fecha_fin) }));
      const citasDoc = await db.CitaPaciente.findAll({ where: { doctor_id, inicio: { [Op.lt]: timeStrToDate(fecha,'23:59') }, fin: { [Op.gt]: timeStrToDate(fecha,'00:00') } }, attributes: ['inicio','fin'] });
      citasDoc.forEach(c => blockIntervals.push({ start: new Date(c.inicio), end: new Date(c.fin) }));
    }
    const windowsFree = subtractIntervals(windows, blockIntervals);
    const slotsResp = [];
    windowsFree.forEach(w => {
      let cursor = new Date(w.start);
      while (cursor.getTime() + durMin*60000 <= w.end.getTime()) {
        const s = new Date(cursor);
        const e = new Date(cursor.getTime() + durMin*60000);
        slotsResp.push({ start: s.toISOString(), end: e.toISOString() });
        cursor = new Date(cursor.getTime() + durMin*60000);
      }
    });
    return res.json({ available: true, conflicts, slots: slotsResp, duration_used: durMin });
  }

  // Rango puntual (validación)
  const effectiveEnd = end || new Date(start.getTime() + (durMinParam || instData?.default_duracion_minutos || 30)*60000);
  const dow = dayIndex(start);
  if (instData) {
    const h = (instData.horarios || []).find(h => h.dia_semana === dow);
    const inRange = h && h.activo && `${h.hora_inicio}` <= toTime(start) && `${h.hora_fin}` >= toTime(effectiveEnd);
    if (!inRange) conflicts.push({ type: 'out_of_hours', message: 'Instalación fuera de horario' });
    (instData.bloqueos || []).forEach(b => {
      if (overlap(start, effectiveEnd, b.fecha_inicio, b.fecha_fin)) conflicts.push({ type: 'blocked', message: b.motivo || 'Bloqueo instalación' });
    });
    const citasInst = await db.CitaPaciente.findAll({ where: { instalacion_id, inicio: { [Op.lt]: effectiveEnd }, fin: { [Op.gt]: start } }, attributes: ['id_cita','inicio','fin'] });
    if (citasInst.length) conflicts.push({ type: 'overlap', message: 'Instalación ocupada' });
  }

  if (doctor_id) {
    const h = docData && (docData.horarios || []).find(h => h.dia_semana === dow);
    const inRange = h && h.activo && `${h.hora_inicio}` <= toTime(start) && `${h.hora_fin}` >= toTime(end);
    if (!inRange) conflicts.push({ type: 'doctor_unavailable', message: 'Doctor fuera de horario' });
    const bloqueos = await db.DoctorBloqueo.findAll({ where: { doctor_id, fecha_inicio: { [Op.lt]: effectiveEnd }, fecha_fin: { [Op.gt]: start } } });
    if (bloqueos.length) conflicts.push({ type: 'doctor_unavailable', message: bloqueos[0].motivo || 'Bloqueo doctor' });
    const citasDoc = await db.CitaPaciente.findAll({ where: { doctor_id, inicio: { [Op.lt]: effectiveEnd }, fin: { [Op.gt]: start } }, attributes: ['id_cita','inicio','fin'] });
    if (citasDoc.length) conflicts.push({ type: 'overlap', message: 'Doctor ocupado' });
  }

  if (conflicts.length && !parseBool(force)) {
    return res.status(409).json({ available: false, conflicts, duration_used: durMinParam || instData?.default_duracion_minutos || 30 });
  }

  res.json({
    available: true,
    conflicts,
    duration_used: durMinParam || instData?.default_duracion_minutos || 30,
    clinica: instData?.clinica ? { id: instData.clinica.id_clinica, nombre: instData.clinica.nombre_clinica, grupo: instData.clinica.id_grupo } : null
  });
});
