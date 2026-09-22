const asyncHandler = require('express-async-handler');
const db = require('../../models');
const { withCalendarMutation } = require('../services/appointmentCalendarMutation.service');
const { resourceAppointments, resourceInstallationBlocks } = require('../services/appointmentResourceCalendar.service');
const withDoctorCalendarMutation = (doctorId, mutate) => withCalendarMutation({ db, doctorId, mutate });
const { Op } = db.Sequelize;
const { STAFF_ROLES } = require('../lib/role-helpers');

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

exports.agendaVisibility = asyncHandler(async (req, res) => {
  const { visibilityDates, agendaVisibility } = require('../services/agendaVisibility.service');
  let dates;
  try { dates = visibilityDates(req.query.dates); }
  catch (error) { return res.status(400).json({ message: error.message }); }
  res.json(await agendaVisibility({ db, clinicIds: req.authorizedDoctorClinicIds || [], dates }));
});

exports.list = asyncHandler(async (req, res) => {
  const { agenda_context } = req.query;
  const agendaContext = parseBool(agenda_context);
  const authorizedClinicIds = Array.from(new Set((req.authorizedDoctorClinicIds || [])
    .map((value) => Number.parseInt(String(value), 10))
    .filter((value) => Number.isInteger(value) && value > 0)));
  if (!authorizedClinicIds.length) return res.json([]);

  // Filtrado por clinica_id directamente sobre DoctorClinica (evita depender de atributos inexistentes en Clinica)
  const whereDoctorClinica = {
    activo: true,
    clinica_id: { [Op.in]: authorizedClinicIds },
  };
  if (!agendaContext) {
    whereDoctorClinica.recibe_citas = true;
  }
  // Mantener /api/doctors legacy limitado a doctores reales:
  // incluir cualquier rol de staff (propietario/personal/agencia) con subrol Doctores
  // para soportar casos propietario+doctor sin perder visibilidad en agenda.
  const staffRolesSql = STAFF_ROLES.map((role) => db.sequelize.escape(role)).join(', ');
  const andConditions = [];
  if (!agendaContext) {
    andConditions.push(
      db.Sequelize.literal(`
        EXISTS (
          SELECT 1
          FROM UsuarioClinica uc
          WHERE uc.id_usuario = \`DoctorClinica\`.\`doctor_id\`
            AND uc.id_clinica = \`DoctorClinica\`.\`clinica_id\`
            AND uc.rol_clinica IN (${staffRolesSql})
            AND uc.subrol_clinica = 'Doctores'
        )
      `)
    );
  }
  if (!agendaContext) {
    andConditions.push(
      db.Sequelize.literal(`
        EXISTS (
          SELECT 1
          FROM ClinicaHorarios ch
          WHERE ch.clinica_id = \`DoctorClinica\`.\`clinica_id\`
            AND ch.activo = 1
        )
      `)
    );
  }
  whereDoctorClinica[Op.and] = andConditions;
  const includeClinica = {
    model: db.Clinica,
    as: 'clinica',
    attributes: ['id_clinica', 'nombre_clinica', 'url_avatar', 'grupoClinicaId'],
  };
  if (agendaContext) {
    includeClinica.include = [
      {
        model: db.ClinicaHorario,
        as: 'horarios',
        attributes: ['id', 'activo'],
        where: { activo: true },
        required: false
      }
    ];
  }
  const doctorClinicas = await db.DoctorClinica.findAll({
    where: whereDoctorClinica,
    include: [
      // Nota: el modelo Usuario no tiene campo `especialidad` en BD; usamos `rol_en_clinica` de DoctorClinica como "especialidad" (label).
      { model: db.Usuario, as: 'doctor', attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario', 'avatar'] },
      includeClinica,
      {
        model: db.DoctorHorario,
        as: 'horarios',
        attributes: ['id'],
        where: { activo: true },
        required: !agendaContext,
      },
    ],
    order: [['clinica_id', 'ASC'], [{ model: db.Usuario, as: 'doctor' }, 'apellidos', 'ASC'], [{ model: db.Usuario, as: 'doctor' }, 'nombre', 'ASC']],
  });

  // Respuesta compatible con el front (doctors.service.ts)
  const uniqueByPivot = new Map();
  doctorClinicas.forEach((dc) => {
    const key = `${dc.doctor_id}:${dc.clinica_id}`;
    if (uniqueByPivot.has(key)) return;
    const hasSchedule = Array.isArray(dc.horarios) && dc.horarios.some((horario) => horario?.id != null);
    const clinicHasOpening = Array.isArray(dc.clinica?.horarios) && dc.clinica.horarios.length > 0;
    const receivesAppointments = !!dc.recibe_citas;
    uniqueByPivot.set(key, {
      id: String(dc.doctor?.id_usuario ?? dc.doctor_id),
      nombre: dc.doctor?.nombre || '',
      apellidos: dc.doctor?.apellidos || '',
      email: dc.doctor?.email_usuario || null,
      avatar: dc.doctor?.avatar || null,
      especialidad: dc.rol_en_clinica || null,
      activo: !!dc.activo,
      clinica_id: String(dc.clinica?.id_clinica ?? dc.clinica_id),
      clinica_nombre: dc.clinica?.nombre_clinica || '',
      grupo_clinica_id: dc.clinica?.grupoClinicaId ?? null,
      clinica: dc.clinica || null,
      recibe_citas: receivesAppointments,
      has_schedule: hasSchedule,
      clinic_has_opening: clinicHasOpening,
      agendable: receivesAppointments && hasSchedule && clinicHasOpening,
    });
  });

  const result = Array.from(uniqueByPivot.values());

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
  const link = await db.DoctorClinica.findByPk(doctorClinicaId);
  if (!link) return res.status(404).json({ message: 'Profesional no asignado a esta clínica' });
  const created = await withDoctorCalendarMutation(link.doctor_id, async transaction => {
    await db.DoctorHorario.destroy({ where: { doctor_clinica_id: doctorClinicaId }, transaction });
    return db.DoctorHorario.bulkCreate(rows.map(r => ({ ...r, doctor_clinica_id: doctorClinicaId })), { transaction });
  });
  res.json(created);
});

exports.listBloqueos = asyncHandler(async (req, res) => {
  const doctorId = req.authorizedDoctorId || req.params.doctorId;
  const clinicIds = req.authorizedDoctorClinicIds || [];
  const items = await db.DoctorBloqueo.findAll({
    where: {
      doctor_id: doctorId,
      [Op.or]: [
        { clinica_id: { [Op.in]: clinicIds } },
        { clinica_id: null },
      ],
    },
  });
  res.json(items);
});

exports.createBloqueo = asyncHandler(async (req, res) => {
  const doctorId = req.authorizedDoctorId || req.params.doctorId || req.userData?.userId;
  const bloqueo = await withDoctorCalendarMutation(doctorId, transaction => db.DoctorBloqueo.create({
    doctor_id: doctorId,
    clinica_id: req.body.clinica_id ?? null,
    fecha_inicio: req.body.fecha_inicio,
    fecha_fin: req.body.fecha_fin,
    tipo: req.body.tipo || 'ausencia',
    motivo: req.body.motivo,
    recurrente: req.body.recurrente || 'none',
    aplica_a_todas_clinicas: req.body.clinica_id == null ? !!req.body.aplica_a_todas_clinicas : false,
    creado_por: req.user?.id || null
  }, { transaction }));
  res.status(201).json(bloqueo);
});

exports.deleteBloqueo = asyncHandler(async (req, res) => {
  const item = await db.DoctorBloqueo.findByPk(req.params.id);
  if (!item) return res.status(404).json({ message: 'Bloqueo no encontrado' });
  await withDoctorCalendarMutation(item.doctor_id, transaction => item.destroy({ transaction }));
  res.status(204).end();
});

exports.updateBloqueo = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const bloqueo = await db.DoctorBloqueo.findByPk(id);
  if (!bloqueo) return res.status(404).json({ message: 'Bloqueo no encontrado' });
  const payload = { ...(req.body || {}) };
  delete payload.id;
  delete payload.doctor_id;
  delete payload.creado_por;
  await withDoctorCalendarMutation(bloqueo.doctor_id, transaction => bloqueo.update(payload, { transaction }));
  res.json(bloqueo);
});

async function buildSchedule(doctorId, authorizedClinicIds = []) {
  const clinicIds = Array.from(new Set((authorizedClinicIds || [])
    .map((value) => Number.parseInt(String(value), 10))
    .filter((value) => Number.isInteger(value) && value > 0)));
  const doctor = await db.Usuario.findByPk(doctorId, { attributes: ['id_usuario','nombre','apellidos','email_usuario'] });
  const clinicas = await db.DoctorClinica.findAll({
    where: { doctor_id: doctorId, activo: true, clinica_id: { [Op.in]: clinicIds } },
    include: [
      { model: db.Clinica, as: 'clinica', attributes: ['id_clinica','nombre_clinica','url_avatar'] },
      { model: db.DoctorHorario, as: 'horarios' }
    ]
  });
  const bloqueos = await db.DoctorBloqueo.findAll({
    where: {
      doctor_id: doctorId,
      [Op.or]: [
        { clinica_id: { [Op.in]: clinicIds } },
        { clinica_id: null },
      ],
    },
  });
  return {
    doctor_id: String(doctorId),
    doctor_nombre: doctor ? `${doctor.nombre || ''} ${doctor.apellidos || ''}`.trim() : '',
    clinicas: clinicas.map(c => ({
      clinica_id: c.clinica_id,
      nombre_clinica: c.clinica?.nombre_clinica || '',
      url_avatar: c.clinica?.url_avatar || null,
      activo: c.activo,
      horarios: c.horarios || []
    })),
    bloqueos
  };
}

exports.getScheduleForDoctor = asyncHandler(async (req, res) => {
  const doctorId = req.authorizedDoctorId || req.params.doctorId;
  const schedule = await buildSchedule(doctorId, req.authorizedDoctorClinicIds);
  res.json(schedule);
});

exports.getScheduleForCurrent = asyncHandler(async (req, res) => {
  const doctorId = req.authorizedDoctorId || req.userData?.userId;
  if (!doctorId) return res.status(401).json({ message: 'no_user' });
  const schedule = await buildSchedule(doctorId, req.authorizedDoctorClinicIds);
  res.json(schedule);
});

exports.updateHorariosClinica = asyncHandler(async (req, res) => {
  const { clinicaId } = req.params;
  const doctorId = req.authorizedDoctorId || req.params.doctorId || req.userData?.userId;
  const horarios = Array.isArray(req.body?.horarios) ? req.body.horarios : [];
  const created = await withDoctorCalendarMutation(doctorId, async transaction => {
  let dc = await db.DoctorClinica.findOne({ where: { doctor_id: doctorId, clinica_id: clinicaId }, transaction });
  if (!dc) {
    dc = await db.DoctorClinica.create({
      doctor_id: doctorId,
      clinica_id: clinicaId,
      recibe_citas: true,
      activo: true
    }, { transaction });
  }
  await db.DoctorHorario.destroy({ where: { doctor_clinica_id: dc.id }, transaction });
  return db.DoctorHorario.bulkCreate(horarios.map(h => ({ ...h, doctor_clinica_id: dc.id })), { transaction });
  });
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
    if (inst && !require('../lib/installation-professionals').installationAllowsStaff(inst, [Number(doctor_id)])) {
      return res.status(wantsSlots ? 200 : 409).json({ available: false, can_force: false, slots: [],
        conflicts: [{ type: 'doctor_unavailable', message: 'Este profesional no está autorizado para esta instalación.' }] });
    }
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
    const citasDoc = await resourceAppointments({ db, doctorId: doctor_id, start: timeStrToDate(fecha,'00:00'), end: timeStrToDate(fecha,'23:59') });
    citasDoc.forEach(c => blocks.push({ start: new Date(c.inicio), end: new Date(c.fin) }));
    if (inst) {
      (await resourceInstallationBlocks({ db, clinic: dc.clinica, installationIds: [instalacion_id], start: timeStrToDate(fecha,'00:00'), end: timeStrToDate(fecha,'23:59') })).forEach(b => blocks.push({ start: new Date(b.fecha_inicio), end: new Date(b.fecha_fin) }));
      const citasInst = await resourceAppointments({ db, clinic: dc.clinica, installationId: instalacion_id, start: timeStrToDate(fecha,'00:00'), end: timeStrToDate(fecha,'23:59') });
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
  const citasDoc = await resourceAppointments({ db, doctorId: doctor_id, start, end: effectiveEnd });
  if (citasDoc.length) conflicts.push({ type: 'overlap', message: 'Doctor ocupado' });

  if (inst) {
    const hInst = (inst.horarios || []).find(h => h.dia_semana === dow);
    const inRangeInst = hInst && hInst.activo && `${hInst.hora_inicio}` <= toTime(start) && `${hInst.hora_fin}` >= toTime(effectiveEnd);
    if (!inRangeInst) conflicts.push({ type: 'out_of_hours', message: 'Instalación fuera de horario' });
    (await resourceInstallationBlocks({ db, clinic: dc.clinica, installationIds: [instalacion_id], start, end: effectiveEnd })).forEach(b => { if (overlap(start, effectiveEnd, b.fecha_inicio, b.fecha_fin)) conflicts.push({ type: 'blocked', message: b.motivo || 'Bloqueo instalación' }); });
    const citasInst = await resourceAppointments({ db, clinic: dc.clinica, installationId: instalacion_id, start, end: effectiveEnd });
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
