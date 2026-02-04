const asyncHandler = require('express-async-handler');
const db = require('../../models');
const { Op } = db.Sequelize;

const parseBool = (v) => v === true || v === 'true' || v === '1';

exports.list = asyncHandler(async (req, res) => {
  const { clinica_id, group_id, all } = req.query;
  const whereClinica = {};
  if (!parseBool(all)) {
    if (clinica_id) whereClinica.id_clinica = clinica_id;
    if (group_id) whereClinica.id_grupo = group_id;
  }

  const doctorClinicas = await db.DoctorClinica.findAll({
    where: { activo: true },
    include: [
      { model: db.Usuario, as: 'doctor', attributes: ['id_usuario','nombre','apellidos','email_usuario','especialidad'] },
      { model: db.Clinica, as: 'clinica', attributes: ['id_clinica','nombre_clinica','id_grupo'], where: Object.keys(whereClinica).length ? whereClinica : undefined }
    ]
  });

  const result = doctorClinicas.map(dc => ({
    id: dc.doctor?.id_usuario,
    nombre: dc.doctor?.nombre,
    apellidos: dc.doctor?.apellidos,
    email: dc.doctor?.email_usuario,
    especialidad: dc.doctor?.especialidad || null,
    clinica: dc.clinica
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
  const { doctorId } = req.params;
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
