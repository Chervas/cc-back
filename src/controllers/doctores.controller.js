const asyncHandler = require('express-async-handler');
const db = require('../../models');
const { Op } = db.Sequelize;

const parseBool = (v) => v === true || v === 'true' || v === '1';
const dayIndex = (date) => new Date(date).getDay();
const toTime = (d) => d.toTimeString().slice(0,5);
const overlap = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;
const timeStrToDate = (fecha, hhmm) => new Date(`${fecha}T${hhmm}:00Z`);

const buildWindows = (horarios, dow, fecha) => {
  return (horarios || [])
    .filter(h => h.dia_semana === dow && h.activo)
    .map(h => ({ start: timeStrToDate(fecha, h.hora_inicio), end: timeStrToDate(fecha, h.hora_fin) }));
};

const subtractIntervals = (windows, blocks) => {
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

exports.list = asyncHandler(async (req, res) => {
  const { clinica_id, group_id, all } = req.query;

  // Filtrado por clinica_id directamente sobre DoctorClinica (evita depender de atributos inexistentes en Clinica)
  const whereDoctorClinica = { activo: true };
  if (!parseBool(all) && clinica_id) {
    whereDoctorClinica.clinica_id = clinica_id;
  }

  const includeClinica = {
    model: db.Clinica,
    as: 'clinica',
    attributes: ['id_clinica', 'nombre_clinica', 'grupoClinicaId'],
  };
  if (!parseBool(all) && group_id) {
    includeClinica.where = { grupoClinicaId: group_id };
  }

  const doctorClinicas = await db.DoctorClinica.findAll({
    where: whereDoctorClinica,
    include: [
      { model: db.Usuario, as: 'doctor', attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario', 'especialidad'] },
      includeClinica,
    ],
    order: [['clinica_id', 'ASC'], [{ model: db.Usuario, as: 'doctor' }, 'apellidos', 'ASC'], [{ model: db.Usuario, as: 'doctor' }, 'nombre', 'ASC']],
  });

  // Respuesta compatible con el front (doctors.service.ts)
  const result = doctorClinicas.map((dc) => ({
    id: String(dc.doctor?.id_usuario ?? dc.doctor_id),
    nombre: dc.doctor?.nombre || '',
    apellidos: dc.doctor?.apellidos || '',
    email: dc.doctor?.email_usuario || null,
    especialidad: dc.doctor?.especialidad || null,
    activo: !!dc.activo,
    clinica_id: String(dc.clinica?.id_clinica ?? dc.clinica_id),
    clinica_nombre: dc.clinica?.nombre_clinica || '',
    grupo_clinica_id: dc.clinica?.grupoClinicaId ?? null,
    clinica: dc.clinica || null,
  }));

  res.json(result);
});

exports.getHorarios = asyncHandler(async (req, res) => {
  const { doctorClinicaId } = req.params;
  const horarios = await db.DoctorHorario.findAll({ where: { doctor_clinica_id: doctorClinicaId } });
  res.json(horarios);
});

exports.updateHorarios = asyncHandler(async (req, res) => {
  const { doctorClinicaId } = req.params;
  const rows = Array.isArray(req.body) ? req.body : [];
  await db.DoctorHorario.destroy({ where: { doctor_clinica_id: doctorClinicaId } });
  const created = await db.DoctorHorario.bulkCreate(rows.map(r => ({ ...r, doctor_clinica_id: doctorClinicaId })));
  res.json(created);
});

exports.listBloqueos = asyncHandler(async (req, res) => {
  const { doctorId } = req.params;
  const items = await db.DoctorBloqueo.findAll({ where: { doctor_id: doctorId } });
  res.json(items);
});

exports.createBloqueo = asyncHandler(async (req, res) => {
  const doctorId = req.params.doctorId || req.userData?.userId;
  const bloqueo = await db.DoctorBloqueo.create({
    doctor_id: doctorId,
    fecha_inicio: req.body.fecha_inicio,
    fecha_fin: req.body.fecha_fin,
    motivo: req.body.motivo,
    recurrente: req.body.recurrente || 'none',
    aplica_a_todas_clinicas: !!req.body.aplica_a_todas_clinicas,
    creado_por: req.user?.id || null
  });
  res.status(201).json(bloqueo);
});

exports.deleteBloqueo = asyncHandler(async (req, res) => {
  await db.DoctorBloqueo.destroy({ where: { id: req.params.id } });
  res.status(204).end();
});

exports.updateBloqueo = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const bloqueo = await db.DoctorBloqueo.findByPk(id);
  if (!bloqueo) return res.status(404).json({ message: 'Bloqueo no encontrado' });
  await bloqueo.update(req.body || {});
  res.json(bloqueo);
});

async function buildSchedule(doctorId) {
  const doctor = await db.Usuario.findByPk(doctorId, { attributes: ['id_usuario','nombre','apellidos','email_usuario'] });
  const clinicas = await db.DoctorClinica.findAll({
    where: { doctor_id: doctorId, activo: true },
    include: [
      { model: db.Clinica, as: 'clinica', attributes: ['id_clinica','nombre_clinica'] },
      { model: db.DoctorHorario, as: 'horarios' }
    ]
  });
  const bloqueos = await db.DoctorBloqueo.findAll({ where: { doctor_id: doctorId } });
  return {
    doctor_id: String(doctorId),
    doctor_nombre: doctor ? `${doctor.nombre || ''} ${doctor.apellidos || ''}`.trim() : '',
    clinicas: clinicas.map(c => ({
      clinica_id: c.clinica_id,
      nombre_clinica: c.clinica?.nombre_clinica || '',
      activo: c.activo,
      horarios: c.horarios || []
    })),
    bloqueos
  };
}

exports.getScheduleForDoctor = asyncHandler(async (req, res) => {
  const { doctorId } = req.params;
  const schedule = await buildSchedule(doctorId);
  res.json(schedule);
});

exports.getScheduleForCurrent = asyncHandler(async (req, res) => {
  const doctorId = req.userData?.userId;
  if (!doctorId) return res.status(401).json({ message: 'no_user' });
  const schedule = await buildSchedule(doctorId);
  res.json(schedule);
});

exports.updateHorariosClinica = asyncHandler(async (req, res) => {
  const { doctorId, clinicaId } = req.params;
  const horarios = Array.isArray(req.body?.horarios) ? req.body.horarios : [];
  let dc = await db.DoctorClinica.findOne({ where: { doctor_id: doctorId, clinica_id: clinicaId } });
  if (!dc) {
    dc = await db.DoctorClinica.create({ doctor_id: doctorId, clinica_id: clinicaId, activo: true });
  }
  await db.DoctorHorario.destroy({ where: { doctor_clinica_id: dc.id } });
  const created = await db.DoctorHorario.bulkCreate(horarios.map(h => ({ ...h, doctor_clinica_id: dc.id })));
  res.json(created);
});

// Disponibilidad de doctor (slots o validación puntual)
exports.disponibilidad = asyncHandler(async (req, res) => {
  const { doctor_id, clinica_id, group_id, fecha, inicio, fin, duracion_min, instalacion_id, slots } = req.query;
  if (!doctor_id) return res.status(400).json({ message: 'doctor_id requerido' });
  const wantsSlots = parseBool(slots) || (!inicio && !fin && fecha);
  if (!fecha && !(inicio && fin)) return res.status(400).json({ message: 'fecha o inicio/fin requeridos' });

  const start = inicio ? new Date(inicio) : new Date(`${fecha}T00:00:00Z`);
  let durMinParam = duracion_min ? parseInt(duracion_min,10) : null;
  let end = fin ? new Date(fin) : null;
  if (isNaN(start) || (fin && isNaN(end))) return res.status(400).json({ message: 'rango inválido' });
  const dow = dayIndex(start);
  const conflicts = [];

  // Fetch doctor-clinica + horarios
  const dc = await db.DoctorClinica.findOne({
    where: clinica_id ? { doctor_id, clinica_id } : { doctor_id },
    include: [
      { model: db.DoctorHorario, as: 'horarios' },
      { model: db.Clinica, as: 'clinica', attributes: ['id_clinica','grupoClinicaId'] }
    ]
  });
  if (!dc || !dc.activo) conflicts.push({ type: 'doctor_unavailable', message: 'Doctor no asignado a la clínica' });
  if (group_id && dc?.clinica?.grupoClinicaId && dc.clinica.grupoClinicaId !== parseInt(group_id,10)) conflicts.push({ type: 'not_in_group', message: 'Doctor fuera del grupo' });

  // Optional: fetch instalacion to intersect windows
  let inst = null;
  if (instalacion_id) {
    inst = await db.Instalacion.findByPk(instalacion_id, { include: [{ model: db.InstalacionHorario, as: 'horarios' }, { model: db.InstalacionBloqueo, as: 'bloqueos' }] });
    if (!inst || !inst.activo) return res.status(404).json({ message: 'Instalación no encontrada' });
    if (clinica_id && inst.clinica_id !== parseInt(clinica_id,10)) conflicts.push({ type: 'not_in_clinic', message: 'Instalación fuera de la clínica' });
    if (group_id && inst.clinica_id && inst.clinica?.grupoClinicaId && inst.clinica.grupoClinicaId !== parseInt(group_id,10)) conflicts.push({ type: 'not_in_group', message: 'Instalación fuera del grupo' });
  }

  // Slots mode
  if (wantsSlots) {
    const durMin = durMinParam && durMinParam > 0 ? durMinParam : 30;
    let windows = buildWindows(dc?.horarios || [], dow, fecha);
    if (inst) {
      const instWins = buildWindows(inst.horarios || [], dow, fecha);
      if (windows.length === 0) windows = instWins;
      else windows = windows.flatMap(w => instWins.map(i => ({ start: new Date(Math.max(w.start, i.start)), end: new Date(Math.min(w.end, i.end)) }))).filter(w => w.start < w.end);
    }
    // Blocks
    const blocks = [];
    const bloqueosDoc = await db.DoctorBloqueo.findAll({ where: { doctor_id, fecha_inicio: { [Op.lt]: timeStrToDate(fecha,'23:59') }, fecha_fin: { [Op.gt]: timeStrToDate(fecha,'00:00') } } });
    bloqueosDoc.forEach(b => blocks.push({ start: new Date(b.fecha_inicio), end: new Date(b.fecha_fin) }));
    const citasDoc = await db.CitaPaciente.findAll({ where: { doctor_id, inicio: { [Op.lt]: timeStrToDate(fecha,'23:59') }, fin: { [Op.gt]: timeStrToDate(fecha,'00:00') } }, attributes: ['inicio','fin'] });
    citasDoc.forEach(c => blocks.push({ start: new Date(c.inicio), end: new Date(c.fin) }));
    if (inst) {
      (inst.bloqueos || []).forEach(b => blocks.push({ start: new Date(b.fecha_inicio), end: new Date(b.fecha_fin) }));
      const citasInst = await db.CitaPaciente.findAll({ where: { instalacion_id, inicio: { [Op.lt]: timeStrToDate(fecha,'23:59') }, fin: { [Op.gt]: timeStrToDate(fecha,'00:00') } }, attributes: ['inicio','fin'] });
      citasInst.forEach(c => blocks.push({ start: new Date(c.inicio), end: new Date(c.fin) }));
    }
    const free = subtractIntervals(windows, blocks);
    const slotsResp = [];
    free.forEach(w => {
      let cursor = new Date(w.start);
      while (cursor.getTime() + durMin*60000 <= w.end.getTime()) {
        const s = new Date(cursor); const e = new Date(cursor.getTime() + durMin*60000);
        slotsResp.push({ start: s.toISOString(), end: e.toISOString() });
        cursor = new Date(cursor.getTime() + durMin*60000);
      }
    });
    return res.json({
      available: true,
      conflicts,
      slots: slotsResp,
      duration_used: durMin,
      clinica: dc?.clinica ? { id: dc.clinica.id_clinica, nombre: dc.clinica.nombre_clinica, grupo: dc.clinica.grupoClinicaId } : null
    });
  }

  // Validation mode
  const effectiveEnd = end || new Date(start.getTime() + (durMinParam || 30)*60000);
  const h = dc && (dc.horarios || []).find(h => h.dia_semana === dow);
  const inRange = h && h.activo && `${h.hora_inicio}` <= toTime(start) && `${h.hora_fin}` >= toTime(effectiveEnd);
  if (!inRange) conflicts.push({ type: 'doctor_unavailable', message: 'Doctor fuera de horario' });
  const bloqueos = await db.DoctorBloqueo.findAll({ where: { doctor_id, fecha_inicio: { [Op.lt]: effectiveEnd }, fecha_fin: { [Op.gt]: start } } });
  if (bloqueos.length) conflicts.push({ type: 'doctor_unavailable', message: bloqueos[0].motivo || 'Bloqueo doctor' });
  const citasDoc = await db.CitaPaciente.findAll({ where: { doctor_id, inicio: { [Op.lt]: effectiveEnd }, fin: { [Op.gt]: start } }, attributes: ['id_cita','inicio','fin'] });
  if (citasDoc.length) conflicts.push({ type: 'overlap', message: 'Doctor ocupado' });

  if (inst) {
    const hInst = (inst.horarios || []).find(h => h.dia_semana === dow);
    const inRangeInst = hInst && hInst.activo && `${hInst.hora_inicio}` <= toTime(start) && `${hInst.hora_fin}` >= toTime(effectiveEnd);
    if (!inRangeInst) conflicts.push({ type: 'out_of_hours', message: 'Instalación fuera de horario' });
    (inst.bloqueos || []).forEach(b => { if (overlap(start, effectiveEnd, b.fecha_inicio, b.fecha_fin)) conflicts.push({ type: 'blocked', message: b.motivo || 'Bloqueo instalación' }); });
    const citasInst = await db.CitaPaciente.findAll({ where: { instalacion_id, inicio: { [Op.lt]: effectiveEnd }, fin: { [Op.gt]: start } }, attributes: ['id_cita','inicio','fin'] });
    if (citasInst.length) conflicts.push({ type: 'overlap', message: 'Instalación ocupada' });
  }

  if (conflicts.length) return res.status(409).json({ available: false, conflicts, duration_used: durMinParam || 30, clinica: dc?.clinica ? { id: dc.clinica.id_clinica, nombre: dc.clinica.nombre_clinica, grupo: dc.clinica.grupoClinicaId } : null });
  res.json({
    available: true,
    conflicts: [],
    duration_used: durMinParam || 30,
    clinica: dc?.clinica ? { id: dc.clinica.id_clinica, nombre: dc.clinica.nombre_clinica, grupo: dc.clinica.grupoClinicaId } : null
  });
});
