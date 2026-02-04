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

exports.disponibilidad = asyncHandler(async (req, res) => {
  const { clinica_id, fecha, inicio, fin, instalacion_id, doctor_id, duracion_min, force } = req.query;
  if (!fecha && !(inicio && fin)) {
    return res.status(400).json({ message: 'fecha o inicio/fin requeridos' });
  }
  const start = inicio ? new Date(inicio) : new Date(`${fecha}T00:00:00Z`);
  const end = fin ? new Date(fin) : new Date(start.getTime() + (parseInt(duracion_min || '30',10)*60000));
  if (isNaN(start) || isNaN(end)) return res.status(400).json({ message: 'rango inválido' });

  const conflicts = [];

  // Instalacion checks
  if (instalacion_id) {
    const inst = await db.Instalacion.findByPk(instalacion_id, { include: [{ model: db.InstalacionHorario, as: 'horarios' }, { model: db.InstalacionBloqueo, as: 'bloqueos' }] });
    if (!inst || !inst.activo) return res.status(404).json({ message: 'Instalación no encontrada' });
    if (clinica_id && inst.clinica_id !== parseInt(clinica_id,10)) conflicts.push({ type: 'not_in_clinic', message: 'Instalación fuera de la clínica' });
    const dow = dayIndex(start);
    const h = (inst.horarios || []).find(h => h.dia_semana === dow);
    const inRange = h && h.activo && `${h.hora_inicio}` <= toTime(start) && `${h.hora_fin}` >= toTime(end);
    if (!inRange) conflicts.push({ type: 'out_of_hours', message: 'Instalación fuera de horario' });
    (inst.bloqueos || []).forEach(b => {
      if (overlap(start, end, b.fecha_inicio, b.fecha_fin)) conflicts.push({ type: 'blocked', message: b.motivo || 'Bloqueo instalación' });
    });
    // citas en misma instalacion
    const citasInst = await db.CitaPaciente.findAll({ where: { instalacion_id, inicio: { [Op.lt]: end }, fin: { [Op.gt]: start } }, attributes: ['id_cita','inicio','fin'] });
    if (citasInst.length) conflicts.push({ type: 'overlap', message: 'Instalación ocupada' });
  }

  // Doctor checks
  if (doctor_id) {
    const doctorClinica = await db.DoctorClinica.findOne({ where: clinica_id ? { doctor_id, clinica_id } : { doctor_id }, include: [{ model: db.DoctorHorario, as: 'horarios' }] });
    if (!doctorClinica || !doctorClinica.activo) conflicts.push({ type: 'doctor_unavailable', message: 'Doctor no asignado a la clínica' });
    const dow = dayIndex(start);
    const h = doctorClinica && (doctorClinica.horarios || []).find(h => h.dia_semana === dow);
    const inRange = h && h.activo && `${h.hora_inicio}` <= toTime(start) && `${h.hora_fin}` >= toTime(end);
    if (!inRange) conflicts.push({ type: 'doctor_unavailable', message: 'Doctor fuera de horario' });
    const bloqueos = await db.DoctorBloqueo.findAll({ where: { doctor_id, fecha_inicio: { [Op.lt]: end }, fecha_fin: { [Op.gt]: start } } });
    if (bloqueos.length) conflicts.push({ type: 'doctor_unavailable', message: bloqueos[0].motivo || 'Bloqueo doctor' });
    const citasDoc = await db.CitaPaciente.findAll({ where: { doctor_id, inicio: { [Op.lt]: end }, fin: { [Op.gt]: start } }, attributes: ['id_cita','inicio','fin'] });
    if (citasDoc.length) conflicts.push({ type: 'overlap', message: 'Doctor ocupado' });
  }

  if (conflicts.length && !parseBool(force)) {
    return res.status(409).json({ available: false, conflicts });
  }

  res.json({ available: true, conflicts });
});
