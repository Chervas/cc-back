'use strict';
const db = require('../../models');

const AutomationFlow = db.AutomationFlow;
const Clinica = db.Clinica;

function mapFlow(flow) {
  const data = flow.toJSON ? flow.toJSON() : flow;
  return {
    id: data.id,
    nombre: data.nombre,
    descripcion: data.descripcion || null,
    disciplina_id: data.disciplina_id || null,
    tratamiento_id: data.tratamiento_id || null,
    clinica_id: data.clinica_id || null,
    estado: data.estado || (data.activo ? 'activo' : 'pausado'),
    pasos: data.pasos || data.acciones || [],
    estadisticas: data.estadisticas || null,
    created_at: data.created_at,
    updated_at: data.updated_at,
  };
}

function resolveDisparador(pasos) {
  if (!Array.isArray(pasos)) return 'custom';
  const trigger = pasos.find((p) => p?.tipo === 'trigger');
  return trigger?.config?.type || 'custom';
}

exports.listFlows = async (req, res) => {
  try {
    const flows = await AutomationFlow.findAll({
      order: [['created_at', 'DESC']],
    });
    res.status(200).json(flows.map(mapFlow));
  } catch (error) {
    res.status(500).json({ message: 'Error obteniendo flujos', error: error.message });
  }
};

exports.getFlow = async (req, res) => {
  try {
    const flow = await AutomationFlow.findByPk(req.params.id);
    if (!flow) {
      return res.status(404).json({ message: 'Flujo no encontrado' });
    }
    res.status(200).json(mapFlow(flow));
  } catch (error) {
    res.status(500).json({ message: 'Error obteniendo flujo', error: error.message });
  }
};

exports.createFlow = async (req, res) => {
  try {
    const {
      nombre,
      descripcion,
      disciplina_id,
      tratamiento_id,
      clinica_id,
      estado = 'borrador',
      pasos = [],
    } = req.body || {};

    if (!nombre) {
      return res.status(400).json({ message: 'nombre es obligatorio' });
    }

    if (clinica_id) {
      const clinic = await Clinica.findOne({ where: { id_clinica: clinica_id } });
      if (!clinic) {
        return res.status(400).json({ message: 'Clínica no encontrada' });
      }
    }

    const disparador = resolveDisparador(pasos);
    const activo = estado === 'activo';

    const flow = await AutomationFlow.create({
      nombre,
      descripcion: descripcion || null,
      disciplina_id: disciplina_id || null,
      tratamiento_id: tratamiento_id || null,
      clinica_id: clinica_id || null,
      estado,
      pasos: Array.isArray(pasos) ? pasos : [],
      disparador,
      acciones: Array.isArray(pasos) ? pasos : [],
      activo,
    });

    res.status(201).json(mapFlow(flow));
  } catch (error) {
    res.status(500).json({ message: 'Error creando flujo', error: error.message });
  }
};

exports.updateFlow = async (req, res) => {
  try {
    const flow = await AutomationFlow.findByPk(req.params.id);
    if (!flow) {
      return res.status(404).json({ message: 'Flujo no encontrado' });
    }

    const {
      nombre,
      descripcion,
      disciplina_id,
      tratamiento_id,
      clinica_id,
      estado,
      pasos,
    } = req.body || {};

    if (clinica_id) {
      const clinic = await Clinica.findOne({ where: { id_clinica: clinica_id } });
      if (!clinic) {
        return res.status(400).json({ message: 'Clínica no encontrada' });
      }
    }

    const nextPasos = pasos !== undefined ? pasos : flow.pasos || flow.acciones;
    const nextEstado = estado || flow.estado || (flow.activo ? 'activo' : 'pausado');

    await flow.update({
      nombre: nombre ?? flow.nombre,
      descripcion: descripcion ?? flow.descripcion,
      disciplina_id: disciplina_id ?? flow.disciplina_id,
      tratamiento_id: tratamiento_id ?? flow.tratamiento_id,
      clinica_id: clinica_id ?? flow.clinica_id,
      estado: nextEstado,
      pasos: Array.isArray(nextPasos) ? nextPasos : flow.pasos,
      disparador: resolveDisparador(Array.isArray(nextPasos) ? nextPasos : []),
      acciones: Array.isArray(nextPasos) ? nextPasos : flow.acciones,
      activo: nextEstado === 'activo',
    });

    res.status(200).json(mapFlow(flow));
  } catch (error) {
    res.status(500).json({ message: 'Error actualizando flujo', error: error.message });
  }
};

exports.deleteFlow = async (req, res) => {
  try {
    const flow = await AutomationFlow.findByPk(req.params.id);
    if (!flow) {
      return res.status(404).json({ message: 'Flujo no encontrado' });
    }
    await flow.destroy();
    res.status(200).json({ success: true });
  } catch (error) {
    res.status(500).json({ message: 'Error eliminando flujo', error: error.message });
  }
};
