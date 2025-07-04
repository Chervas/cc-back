'use strict';
const { GrupoClinica } = require('../../models');

exports.getAllGroups = async (req, res) => {
  try {
    console.log("Obteniendo todos los grupos de clínicas");
    const grupos = await GrupoClinica.findAll({ order: [['nombre_grupo', 'ASC']] });
    console.log("Grupos recuperados:", grupos);
    res.json(grupos);
  } catch (error) {
    console.error("Error retrieving groups:", error);
    res.status(500).json({ message: 'Error retrieving groups', error: error.message });
  }
};

exports.createGroup = async (req, res) => {
  try {
    console.log("Creando nuevo grupo con datos:", req.body);
    const { nombre_grupo } = req.body;
    const newGroup = await GrupoClinica.create({ nombre_grupo });
    console.log("Grupo creado exitosamente:", newGroup);
    res.status(201).json(newGroup);
  } catch (error) {
    console.error("Error creating group:", error);
    res.status(500).json({ message: 'Error creating group', error: error.message });
  }
};

exports.updateGroup = async (req, res) => {
  try {
    console.log("Actualizando grupo con ID:", req.params.id);
    const group = await GrupoClinica.findByPk(req.params.id);
    if (!group) {
      console.log("Grupo no encontrado");
      return res.status(404).json({ message: 'Group not found' });
    }
    group.nombre_grupo = req.body.nombre_grupo;
    await group.save();
    console.log("Grupo actualizado:", group);
    res.json(group);
  } catch (error) {
    console.error("Error updating group:", error);
    res.status(500).json({ message: 'Error updating group', error: error.message });
  }
};

exports.deleteGroup = async (req, res) => {
  try {
    console.log("Eliminando grupo con ID:", req.params.id);
    const group = await GrupoClinica.findByPk(req.params.id);
    if (!group) {
      console.log("Grupo no encontrado");
      return res.status(404).json({ message: 'Group not found' });
    }
    await group.destroy();
    console.log("Grupo eliminado");
    res.json({ message: 'Group deleted' });
  } catch (error) {
    console.error("Error deleting group:", error);
    res.status(500).json({ message: 'Error deleting group', error: error.message });
  }
};
