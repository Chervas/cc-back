const asyncHandler = require('express-async-handler');
const db = require('../../models');

const MessageTemplate = db.MessageTemplate;
const AutomationFlow = db.AutomationFlow;
const MessageLog = db.MessageLog;
const Clinica = db.Clinica;

exports.listTemplates = asyncHandler(async (req, res) => {
  const { tipo } = req.query;
  const where = {};
  if (tipo) where.tipo = tipo;

  const templates = await MessageTemplate.findAll({
    where,
    include: [{ model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica'] }],
    order: [['created_at', 'DESC']]
  });
  res.status(200).json(templates);
});

exports.upsertTemplate = asyncHandler(async (req, res) => {
  const { id, nombre, tipo, contenido, estado, uso, clinica_id } = req.body || {};

  if (!nombre || !tipo) {
    return res.status(400).json({ message: 'nombre y tipo son obligatorios' });
  }

  if (clinica_id) {
    const clinic = await Clinica.findOne({ where: { id_clinica: clinica_id } });
    if (!clinic) return res.status(400).json({ message: 'Clínica no encontrada' });
  }

  if (id) {
    const existing = await MessageTemplate.findByPk(id);
    if (!existing) return res.status(404).json({ message: 'Plantilla no encontrada' });
    await existing.update({ nombre, tipo, contenido, estado, uso, clinica_id: clinica_id || null });
    return res.status(200).json(existing);
  }

  const template = await MessageTemplate.create({
    nombre,
    tipo,
    contenido,
    estado: estado || 'pendiente',
    uso: uso || null,
    clinica_id: clinica_id || null
  });
  res.status(201).json(template);
});

exports.listFlows = asyncHandler(async (req, res) => {
  const flows = await AutomationFlow.findAll({
    include: [{ model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica'] }],
    order: [['created_at', 'DESC']]
  });
  res.status(200).json(flows);
});

exports.upsertFlow = asyncHandler(async (req, res) => {
  const { id, nombre, disparador, acciones, activo, clinica_id } = req.body || {};

  if (!nombre || !disparador || !acciones) {
    return res.status(400).json({ message: 'nombre, disparador y acciones son obligatorios' });
  }

  if (clinica_id) {
    const clinic = await Clinica.findOne({ where: { id_clinica: clinica_id } });
    if (!clinic) return res.status(400).json({ message: 'Clínica no encontrada' });
  }

  if (id) {
    const existing = await AutomationFlow.findByPk(id);
    if (!existing) return res.status(404).json({ message: 'Flujo no encontrado' });
    await existing.update({
      nombre,
      disparador,
      acciones,
      activo: activo === false || activo === 'false' ? false : true,
      clinica_id: clinica_id || null
    });
    return res.status(200).json(existing);
  }

  const flow = await AutomationFlow.create({
    nombre,
    disparador,
    acciones,
    activo: activo === false || activo === 'false' ? false : true,
    clinica_id: clinica_id || null
  });
  res.status(201).json(flow);
});

exports.listMessageLogs = asyncHandler(async (req, res) => {
  const { tipo, estado, destinatario } = req.query;
  const where = {};
  if (tipo) where.tipo = tipo;
  if (estado) where.estado = estado;
  if (destinatario) where.destinatario = destinatario;

  const logs = await MessageLog.findAll({
    where,
    include: [
      { model: MessageTemplate, as: 'template', attributes: ['id', 'nombre', 'tipo'] },
      { model: AutomationFlow, as: 'flow', attributes: ['id', 'nombre'] }
    ],
    order: [['created_at', 'DESC']],
    limit: 200
  });

  res.status(200).json(logs);
});
