const asyncHandler = require('express-async-handler');
const db = require('../../models');
const { withCalendarMutation } = require('../services/appointmentCalendarMutation.service');
const { resourceAppointments, resourceInstallationBlocks } = require('../services/appointmentResourceCalendar.service');
const withDoctorCalendarMutation = (doctorId, mutate) => withCalendarMutation({ db, doctorId, mutate });
const { Op } = db.Sequelize;
const { STAFF_ROLES } = require('../lib/role-helpers');
const { isFlexibleDoctor } = require('../lib/flexible-agenda');
const { buildWindowsFromHorarios, buildDoctorBloqueoRowsForDate, inAnyWindow, resolveClinicTimezone, formatDateLocal,
  localDateTimeToUtc, dayIndexFromLocalDate } = require('../lib/availability-calendar');
const { addDays, normalizeDateOnly } = require('../lib/personal-schedule-recurring');

const parseBool = (v) => v === true || v === 'true' || v === '1';
const overlap = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;

async function doctorBlocksForDate({ doctorId, clinicId, date, timeZone, start, end }) {
  const rows = await db.DoctorBloqueo.findAll({ where: { doctor_id: doctorId, [Op.or]: [
    { recurrente: 'none', fecha_inicio: { [Op.lt]: end }, fecha_fin: { [Op.gt]: start } },
    { recurrente: null, fecha_inicio: { [Op.lt]: end }, fecha_fin: { [Op.gt]: start } },
    { recurrente: { [Op.in]: ['daily', 'weekly', 'monthly'] }, fecha_inicio: { [Op.lt]: end } },
  ] }, include: [{ model: db.DoctorBloqueoExcepcion, as: 'excepciones' }] });
  const scoped = await require('../lib/personal-block-scope').filterPersonalBlocksForClinic({ db, definitions: rows, clinicId });
  return buildDoctorBloqueoRowsForDate(scoped, date, timeZone)
    .filter(row => overlap(start, end, new Date(row.fecha_inicio), new Date(row.fecha_fin)));
}

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
      { model: db.Usuario, as: 'doctor', attributes: ['id_usuario', 'nombre', 'apellidos', 'tratamiento_profesional', 'email_usuario', 'avatar'] },
      includeClinica,
      {
        model: db.DoctorHorario,
        as: 'horarios',
        attributes: ['id', 'activo'],
        where: { activo: true },
        // Shared members can have no physical rows: the afterFind projection
        // supplies their canonical source before readiness is evaluated below.
        required: false,
      },
    ],
    order: [['clinica_id', 'ASC'], [{ model: db.Usuario, as: 'doctor' }, 'apellidos', 'ASC'], [{ model: db.Usuario, as: 'doctor' }, 'nombre', 'ASC']],
  });

  // Respuesta compatible con el front (doctors.service.ts)
  const uniqueByPivot = new Map();
  doctorClinicas.forEach((dc) => {
    const key = `${dc.doctor_id}:${dc.clinica_id}`;
    if (uniqueByPivot.has(key)) return;
    const hasSchedule = Array.isArray(dc.horarios) && dc.horarios.some((horario) =>
      horario?.id != null && horario.activo !== false && horario.activo !== 0);
    if (!agendaContext && !hasSchedule) return;
    const clinicHasOpening = Array.isArray(dc.clinica?.horarios) && dc.clinica.horarios.length > 0;
    const receivesAppointments = !!dc.recibe_citas;
    const flexibleAgenda = agendaContext && isFlexibleDoctor(dc);
    uniqueByPivot.set(key, {
      id: String(dc.doctor?.id_usuario ?? dc.doctor_id),
      nombre: dc.doctor?.nombre || '',
      apellidos: dc.doctor?.apellidos || '',
      tratamiento_profesional: dc.doctor?.tratamiento_profesional ?? null,
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
      agenda_flexible: flexibleAgenda,
      // Selector readiness is not availability/permission. The canonical
      // matrix still enforces real blocks, resources and confirmation.
      agendable: receivesAppointments && (hasSchedule || flexibleAgenda) && clinicHasOpening,
    });
  });

  const result = Array.from(uniqueByPivot.values());

  res.json(result);
});

async function delegatePersonalSchedule(req, res, method, doctorId, clinicId, horarios = undefined) {
  const personal = require('./personal.controller');
  const previousParams = req.params, previousBody = req.body, previousJson = res.json;
  const sendJson = previousJson.bind(res);
  req.params = { ...previousParams, id: String(doctorId), clinicaId: String(clinicId) };
  if (horarios !== undefined) req.body = { horarios };
  // Keep the legacy array contract without wrapping the real Express response:
  // status(), headers and error bodies continue through the canonical handler.
  res.json = payload => sendJson((!res.statusCode || res.statusCode < 400) && Array.isArray(payload?.horarios)
    ? payload.horarios : payload);
  try { return await personal[method](req, res); }
  finally { req.params = previousParams; req.body = previousBody; res.json = previousJson; }
}

exports.getHorarios = asyncHandler(async (req, res) => {
  const link = await db.DoctorClinica.findByPk(req.params.doctorClinicaId, {
    attributes: ['id', 'doctor_id', 'clinica_id'], skipSharedScheduleProjection: true,
  });
  if (!link) return res.status(404).json({ message: 'Profesional no asignado a esta clínica' });
  return delegatePersonalSchedule(req, res, 'getHorariosClinica', link.doctor_id, link.clinica_id);
});

exports.updateHorarios = asyncHandler(async (req, res) => {
  const { doctorClinicaId } = req.params;
  const rows = Array.isArray(req.body) ? req.body : [];
  const link = await db.DoctorClinica.findByPk(doctorClinicaId, {
    attributes: ['id', 'doctor_id', 'clinica_id'], skipSharedScheduleProjection: true,
  });
  if (!link) return res.status(404).json({ message: 'Profesional no asignado a esta clínica' });
  return delegatePersonalSchedule(req, res, 'updateHorariosClinica', link.doctor_id, link.clinica_id, rows);
});

exports.listBloqueos = asyncHandler(async (req, res) => {
  const doctorId = req.authorizedDoctorId || req.params.doctorId;
  return delegatePersonalSchedule(req, res, 'getPersonalBloqueos', doctorId, null);
});

exports.createBloqueo = asyncHandler(async (req, res) => {
  const doctorId = req.authorizedDoctorId || req.params.doctorId || req.userData?.userId;
  req.body = { ...(req.body || {}), tipo: req.body?.tipo || 'ausencia' };
  return delegatePersonalSchedule(req, res, 'createPersonalBloqueo', doctorId, req.body?.clinica_id ?? null);
});

exports.deleteBloqueo = asyncHandler(async (req, res) => {
  const item = await db.DoctorBloqueo.findByPk(req.params.id);
  if (!item) return res.status(404).json({ message: 'Bloqueo no encontrado' });
  req.params.bloqueoId = String(item.id);
  return delegatePersonalSchedule(req, res, 'deletePersonalBloqueo', item.doctor_id, item.clinica_id);
});

exports.updateBloqueo = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const bloqueo = await db.DoctorBloqueo.findByPk(id);
  if (!bloqueo) return res.status(404).json({ message: 'Bloqueo no encontrado' });
  req.params.bloqueoId = String(bloqueo.id);
  return delegatePersonalSchedule(req, res, 'updatePersonalBloqueo', bloqueo.doctor_id, bloqueo.clinica_id);
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
  const definitions = await db.DoctorBloqueo.findAll({ where: { doctor_id: doctorId },
    include: [{ model: db.DoctorBloqueoExcepcion, as: 'excepciones' }] });
  const scopes = await require('../lib/personal-block-scope').loadPersonalBlockScopes({ db, doctorIds: [doctorId], links: clinicas });
  const bloqueos = definitions.filter(block => clinicIds.some(id => scopes.applies(block, id))).map(value => {
    const row = value.toJSON ? value.toJSON() : value;
    return { ...row, ...scopes.metadata(row),
      ...(row.clinica_id != null && !clinicIds.includes(Number(row.clinica_id))
        ? { tipo: 'ausencia', motivo: '', motivo_redacted: true, can_edit: false } : {}) };
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
  return delegatePersonalSchedule(req, res, 'updateHorariosClinica', doctorId, clinicaId, horarios);
});

// Disponibilidad de doctor (slots o validación puntual)
exports.disponibilidad = asyncHandler(async (req, res) => {
  const { doctor_id, clinica_id, group_id, fecha, inicio, fin, duracion_min, instalacion_id, slots } = req.query;
  if (!doctor_id) return res.status(400).json({ message: 'doctor_id requerido' });
  const wantsSlots = parseBool(slots) || (!inicio && !fin && fecha);
  if (!fecha && !(inicio && fin)) return res.status(400).json({ message: 'fecha o inicio/fin requeridos' });

  let start = inicio ? new Date(inicio) : null;
  let durMinParam = duracion_min ? parseInt(duracion_min,10) : null;
  let end = fin ? new Date(fin) : null;
  if ((inicio && isNaN(start)) || (fin && isNaN(end))) return res.status(400).json({ message: 'rango inválido' });
  const conflicts = [];

  // Fetch doctor-clinica + horarios
  const dc = await db.DoctorClinica.findOne({
    where: clinica_id ? { doctor_id, clinica_id } : { doctor_id },
    include: [
      { model: db.DoctorHorario, as: 'horarios', include: [{ model: db.DoctorHorarioExcepcion, as: 'excepciones' }] },
      { model: db.Clinica, as: 'clinica', attributes: ['id_clinica','grupoClinicaId','configuracion'] }
    ]
  });
  if (!dc || !dc.activo) conflicts.push({ type: 'doctor_unavailable', message: 'Doctor no asignado a la clínica' });
  if (group_id && dc?.clinica?.grupoClinicaId && dc.clinica.grupoClinicaId !== parseInt(group_id,10)) conflicts.push({ type: 'not_in_group', message: 'Doctor fuera del grupo' });
  const timeZone = resolveClinicTimezone(dc?.clinica);
  const fechaLocal = fecha ? normalizeDateOnly(fecha) : formatDateLocal(start, timeZone);
  if (!fechaLocal) return res.status(400).json({ message: 'rango inválido' });
  const dayStart = localDateTimeToUtc(fechaLocal, '00:00:00', timeZone);
  const dayEnd = localDateTimeToUtc(addDays(fechaLocal, 1), '00:00:00', timeZone);
  if (!dayStart || !dayEnd) return res.status(400).json({ message: 'rango inválido' });
  start ||= dayStart;
  const dow = dayIndexFromLocalDate(fechaLocal);

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
    let windows = buildWindowsFromHorarios(dc?.horarios || [], dow, fechaLocal, timeZone);
    if (inst) {
      const instWins = buildWindowsFromHorarios(inst.horarios || [], dow, fechaLocal, timeZone);
      windows = windows.flatMap(w => instWins.map(i => ({ start: new Date(Math.max(w.start, i.start)), end: new Date(Math.min(w.end, i.end)) }))).filter(w => w.start < w.end);
    }
    // Blocks
    const blocks = [];
    const bloqueosDoc = await doctorBlocksForDate({ doctorId: doctor_id, clinicId: dc?.clinica_id,
      date: fechaLocal, timeZone, start: dayStart, end: dayEnd });
    bloqueosDoc.forEach(b => blocks.push({ start: new Date(b.fecha_inicio), end: new Date(b.fecha_fin) }));
    const citasDoc = await resourceAppointments({ db, doctorId: doctor_id, start: dayStart, end: dayEnd });
    citasDoc.forEach(c => blocks.push({ start: new Date(c.inicio), end: new Date(c.fin) }));
    if (inst) {
      (await resourceInstallationBlocks({ db, clinic: dc.clinica, installationIds: [instalacion_id], start: dayStart, end: dayEnd })).forEach(b => blocks.push({ start: new Date(b.fecha_inicio), end: new Date(b.fecha_fin) }));
      const citasInst = await resourceAppointments({ db, clinic: dc.clinica, installationId: instalacion_id, start: dayStart, end: dayEnd });
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
  const inRange = inAnyWindow(buildWindowsFromHorarios(dc?.horarios || [], dow, fechaLocal, timeZone), start, effectiveEnd);
  if (!inRange) conflicts.push({ type: 'doctor_unavailable', message: 'Doctor fuera de horario' });
  const bloqueos = await doctorBlocksForDate({ doctorId: doctor_id, clinicId: dc?.clinica_id,
    date: fechaLocal, timeZone, start, end: effectiveEnd });
  if (bloqueos.length) conflicts.push({ type: 'doctor_unavailable', message:
    (bloqueos[0].clinica_id == null || Number(bloqueos[0].clinica_id) === Number(dc?.clinica_id)) && bloqueos[0].motivo
      || 'Ausencia del profesional' });
  const citasDoc = await resourceAppointments({ db, doctorId: doctor_id, start, end: effectiveEnd });
  if (citasDoc.length) conflicts.push({ type: 'overlap', message: 'Doctor ocupado' });

  if (inst) {
    const inRangeInst = inAnyWindow(buildWindowsFromHorarios(inst.horarios || [], dow, fechaLocal, timeZone), start, effectiveEnd);
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
