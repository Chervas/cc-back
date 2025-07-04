'use strict';
const { Paciente, Clinica } = require('../../models');
const { Op } = require('sequelize');

exports.getAllPacientes = async (req, res) => {
  try {
    let whereClause = {};
    if (req.query.clinica_id) {
      const clinicaParam = req.query.clinica_id;
      // Si es una lista separada por comas, usar Op.in
      if (typeof clinicaParam === 'string' && clinicaParam.indexOf(',') !== -1) {
        whereClause.clinica_id = { [Op.in]: clinicaParam.split(',').map(id => parseInt(id)) };
      } else {
        whereClause.clinica_id = clinicaParam;
      }
    }
    const pacientes = await Paciente.findAll({
      where: whereClause,
      include: [{ model: Clinica, as: 'clinica' }],
      order: [['nombre', 'ASC']]
    });
    res.json(pacientes);
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving pacientes', error: error.message });
  }
};

exports.searchPacientes = async (req, res) => {
    try {
      const query = req.query.query || '';
      // Creamos una cláusula base que busca por nombre o apellidos
      let whereClause = {
        [Op.and]: [
          {
            [Op.or]: [
              { nombre: { [Op.like]: `%${query}%` } },
              { apellidos: { [Op.like]: `%${query}%` } }
            ]
          }
        ]
      };
  
      // Si se envía clinica_id, lo agregamos a la cláusula AND
      if (req.query.clinica_id) {
        const clinicaParam = req.query.clinica_id;
        if (typeof clinicaParam === 'string' && clinicaParam.indexOf(',') !== -1) {
          whereClause[Op.and].push({ clinica_id: { [Op.in]: clinicaParam.split(',').map(id => parseInt(id)) } });
        } else {
          whereClause[Op.and].push({ clinica_id: clinicaParam });
        }
      }
  
      const pacientes = await Paciente.findAll({
        where: whereClause,
        include: [{ model: Clinica, as: 'clinica' }],
        order: [['nombre', 'ASC']]
      });
      res.json(pacientes);
    } catch (error) {
      res.status(500).json({ message: 'Error al buscar pacientes', error: error.message });
    }
  };
  
exports.getPacienteById = async (req, res) => {
  try {
    const paciente = await Paciente.findByPk(req.params.id, {
      include: [{ model: Clinica, as: 'clinica' }]
    });
    if (!paciente) {
      return res.status(404).json({ message: 'Paciente not found' });
    }
    res.json(paciente);
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving paciente', error: error.message });
  }
};

exports.createPaciente = async (req, res) => {
  try {
    const { nombre, apellidos, dni, telefono_movil, email, telefono_secundario, foto, fecha_nacimiento, edad, estatura, peso, sexo, profesion, fecha_alta, fecha_baja, alergias, antecedentes, medicacion, paciente_conocido, como_nos_conocio, procedencia, clinica_id } = req.body;
    if (!nombre || !apellidos || !telefono_movil) {
      return res.status(400).json({ message: 'Faltan campos obligatorios' });
    }
    const newPaciente = await Paciente.create({
      nombre,
      apellidos,
      dni,
      telefono_movil,
      email,
      telefono_secundario,
      foto,
      fecha_nacimiento,
      edad,
      estatura,
      peso,
      sexo,
      profesion,
      fecha_alta,
      fecha_baja,
      alergias,
      antecedentes,
      medicacion,
      paciente_conocido,
      como_nos_conocio,
      procedencia,
      clinica_id
    });
    res.status(201).json({
      message: 'Paciente creado exitosamente',
      paciente: newPaciente
    });
  } catch (error) {
    res.status(500).json({ message: 'Error creating paciente', error: error.message });
  }
};

exports.updatePaciente = async (req, res) => {
  try {
    const paciente = await Paciente.findByPk(req.params.id);
    if (!paciente) {
      return res.status(404).json({ message: 'Paciente not found' });
    }
    const fieldsToUpdate = ['nombre', 'apellidos', 'dni', 'telefono_movil', 'email', 'telefono_secundario', 'foto', 'fecha_nacimiento', 'edad', 'estatura', 'peso', 'sexo', 'profesion', 'fecha_alta', 'fecha_baja', 'alergias', 'antecedentes', 'medicacion', 'paciente_conocido', 'como_nos_conocio', 'procedencia', 'clinica_id'];
    fieldsToUpdate.forEach(field => {
      if (req.body[field] !== undefined) {
        paciente[field] = req.body[field];
      }
    });
    await paciente.save();
    res.json({
      message: 'Paciente actualizado exitosamente',
      paciente
    });
  } catch (error) {
    res.status(500).json({ message: 'Error updating paciente', error: error.message });
  }
};

exports.deletePaciente = async (req, res) => {
  try {
    const paciente = await Paciente.findByPk(req.params.id);
    if (!paciente) {
      return res.status(404).json({ message: 'Paciente not found' });
    }
    await paciente.destroy();
    res.json({ message: 'Paciente eliminado' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting paciente', error: error.message });
  }
};
