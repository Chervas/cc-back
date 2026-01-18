'use strict';
const { Paciente, Clinica, PacienteRelacion, PacienteClinica } = require('../../models');
const { Op } = require('sequelize');

const normalizePhone = (phone) => {
  if (!phone) return null;
  return phone.toString().replace(/\D+/g, '');
};

const normalizeEmail = (email) => {
  if (!email) return null;
  return email.toString().trim().toLowerCase();
};

const getClinicaIdsForScope = async (clinicaId, scope) => {
  if (!clinicaId) return [];
  if (scope !== 'grupo') return [parseInt(clinicaId, 10)];

  const clinica = await Clinica.findOne({ where: { id_clinica: clinicaId } });
  if (!clinica || !clinica.grupoClinicaId) {
    return [parseInt(clinicaId, 10)];
  }
  const clinicasGrupo = await Clinica.findAll({
    where: { grupoClinicaId: clinica.grupoClinicaId },
    attributes: ['id_clinica']
  });
  return clinicasGrupo.map(c => c.id_clinica);
};

exports.getAllPacientes = async (req, res) => {
  try {
    let whereClause = {};
    const include = [{ model: Clinica, as: 'clinica' }];

    if (req.query.clinica_id) {
      const clinicaParam = req.query.clinica_id;
      const clinicaList = typeof clinicaParam === 'string' && clinicaParam.indexOf(',') !== -1
        ? clinicaParam.split(',').map(id => parseInt(id, 10))
        : [parseInt(clinicaParam, 10)];

      include.push({
        model: PacienteClinica,
        as: 'clinicasVinculadas',
        required: false,
        where: { clinica_id: { [Op.in]: clinicaList } },
        include: [{ model: Clinica, as: 'clinica' }]
      });

      whereClause = {
        [Op.or]: [
          { clinica_id: clinicaList.length === 1 ? clinicaList[0] : { [Op.in]: clinicaList } },
          { '$clinicasVinculadas.clinica_id$': { [Op.in]: clinicaList } }
        ]
      };
    }
    const pacientes = await Paciente.findAll({
      where: whereClause,
      include,
      distinct: true,
      order: [['nombre', 'ASC']]
    });
    res.json(pacientes);
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving pacientes', error: error.message });
  }
};

exports.searchPacientes = async (req, res) => {
  try {
    const query = req.query.q || req.query.query || '';
    const scope = req.query.scope || 'clinica';
    const clinicaId = req.query.clinica_id;
    const normPhone = normalizePhone(req.query.telefono || '');
    const normEmail = normalizeEmail(req.query.email || '');

    // No permitir búsqueda vacía para evitar devolver todo
    if (!query && !normPhone && !normEmail) {
      return res.json([]);
    }

    const whereOr = [
      { nombre: { [Op.like]: `%${query}%` } },
      { apellidos: { [Op.like]: `%${query}%` } },
      { telefono_movil: { [Op.like]: `%${query}%` } },
      { email: { [Op.like]: `%${query}%` } }
    ];
    if (normPhone) {
      whereOr.push({ telefono_movil: { [Op.like]: `%${normPhone}%` } });
    }
    if (normEmail) {
      whereOr.push({ email: { [Op.like]: `%${normEmail}%` } });
    }

    if (!clinicaId) {
      return res.status(400).json({ message: 'clinica_id es obligatorio para la búsqueda' });
    }

    const clinicaIds = await getClinicaIdsForScope(clinicaId, scope);
    const clinicFilter = clinicaIds.length === 1 ? clinicaIds[0] : { [Op.in]: clinicaIds };

    const whereClause = {
      [Op.and]: [
        { [Op.or]: whereOr },
        {
          [Op.or]: [
            { clinica_id: clinicFilter },
            { '$clinicasVinculadas.clinica_id$': clinicFilter }
          ]
        }
      ]
    };

    const pacientes = await Paciente.findAll({
      where: whereClause,
      include: [
        { model: Clinica, as: 'clinica' },
        {
          model: PacienteClinica,
          as: 'clinicasVinculadas',
          required: false,
          include: [{ model: Clinica, as: 'clinica' }]
        }
      ],
      order: [['nombre', 'ASC']],
      limit: 20,
      distinct: true
    });
    res.json(pacientes);
  } catch (error) {
    res.status(500).json({ message: 'Error al buscar pacientes', error: error.message });
  }
};

exports.checkDuplicates = async (req, res) => {
  try {
    const { telefono, email, clinica_id, scope = 'grupo' } = req.query;
    const normPhone = normalizePhone(telefono);
    const normEmail = normalizeEmail(email);
    if (!normPhone && !normEmail) {
      return res.json({ exists: false });
    }
    if (!clinica_id) {
      return res.status(400).json({ message: 'clinica_id es obligatorio' });
    }

    const clinicaIds = await getClinicaIdsForScope(clinica_id, scope);
    const whereClause = { [Op.and]: [] };
    const orClause = [];
    if (normPhone) {
      orClause.push({ telefono_movil: normPhone });
      orClause.push({ telefono_movil: telefono });
    } else if (telefono) {
      orClause.push({ telefono_movil: telefono });
    }
    if (normEmail) {
      orClause.push({ email: normEmail });
      orClause.push({ email: email });
    } else if (email) {
      orClause.push({ email });
    }
    whereClause[Op.or] = orClause;
    const clinicFilter = clinicaIds.length === 1 ? clinicaIds[0] : { [Op.in]: clinicaIds };
    whereClause[Op.and].push({
      [Op.or]: [
        { clinica_id: clinicFilter },
        { '$clinicasVinculadas.clinica_id$': clinicFilter }
      ]
    });

    const pacienteExistente = await Paciente.findOne({
      where: whereClause,
      include: [
        { model: Clinica, as: 'clinica' },
        { model: PacienteClinica, as: 'clinicasVinculadas', required: false, include: [{ model: Clinica, as: 'clinica' }] }
      ],
      distinct: true
    });

    if (!pacienteExistente) {
      return res.json({ exists: false });
    }

    const targetClinicaId = parseInt(clinica_id, 10);
    const hasLink = pacienteExistente.clinica_id === targetClinicaId ||
      (pacienteExistente.clinicasVinculadas || []).some(vc => vc.clinica_id === targetClinicaId);

    return res.json({
      exists: true,
      paciente: pacienteExistente,
      sameClinic: pacienteExistente.clinica_id === targetClinicaId,
      clinicaNombre: pacienteExistente.clinica?.nombre_clinica || null,
      reuseCandidate: !hasLink,
      vinculos: (pacienteExistente.clinicasVinculadas || []).map(vc => ({
        clinica_id: vc.clinica_id,
        clinicaNombre: vc.clinica?.nombre_clinica || null,
        es_principal: vc.es_principal
      }))
    });
  } catch (error) {
    res.status(500).json({ message: 'Error al verificar duplicados', error: error.message });
  }
};

exports.getPacienteById = async (req, res) => {
  try {
    const paciente = await Paciente.findByPk(req.params.id, {
      include: [
        { model: Clinica, as: 'clinica' },
        { model: PacienteClinica, as: 'clinicasVinculadas', required: false, include: [{ model: Clinica, as: 'clinica' }] },
        {
          model: PacienteRelacion,
          as: 'relaciones',
          include: [{ model: Paciente, as: 'relacionado', include: [{ model: Clinica, as: 'clinica' }] }]
        },
        {
          model: PacienteRelacion,
          as: 'tutorDe',
          include: [{ model: Paciente, as: 'paciente', include: [{ model: Clinica, as: 'clinica' }] }]
        }
      ]
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
    const { nombre, apellidos, dni, telefono_movil, email, telefono_secundario, foto, fecha_nacimiento, edad, estatura, peso, sexo, profesion, fecha_alta, fecha_baja, alergias, antecedentes, medicacion, paciente_conocido, como_nos_conocio, procedencia, clinica_id, tutor } = req.body;
    const normPhone = normalizePhone(telefono_movil);
    const normEmail = normalizeEmail(email);
    if (!nombre) {
      return res.status(400).json({ message: 'Faltan campos obligatorios (nombre)' });
    }
    // Permitimos sin teléfono/email solo si hay tutor
    if (!normPhone && !normEmail && !tutor?.id_paciente_relacionado) {
      return res.status(400).json({ message: 'Se requiere teléfono/email o un tutor como contacto principal' });
    }
    if (!clinica_id) {
      return res.status(400).json({ message: 'clinica_id es obligatorio' });
    }

    // Verificar duplicados solo en el grupo de la clínica (no global)
    const clinicaIds = await getClinicaIdsForScope(clinica_id, 'grupo');
    const dupWhere = { [Op.and]: [] };
    const contactoOr = [];
    if (normPhone) {
      contactoOr.push({ telefono_movil: normPhone });
      if (telefono_movil && telefono_movil !== normPhone) {
          contactoOr.push({ telefono_movil });
      }
    }
    if (normEmail) {
      contactoOr.push({ email: normEmail });
      if (email && email !== normEmail) {
          contactoOr.push({ email });
      }
    }
    // Si no hay forma de contactar y sólo hay tutor, saltar duplicados por contacto
    if (!normPhone && !normEmail) {
      contactoOr.length = 0;
    }
    const clinicFilter = clinicaIds.length === 1 ? clinicaIds[0] : { [Op.in]: clinicaIds };
    if (contactoOr.length > 0) {
      dupWhere[Op.and].push({ [Op.or]: contactoOr });
      dupWhere[Op.and].push({
        [Op.or]: [
          { clinica_id: clinicFilter },
          { '$clinicasVinculadas.clinica_id$': clinicFilter }
        ]
      });
      const existente = await Paciente.findOne({
        where: dupWhere,
        include: [
          { model: Clinica, as: 'clinica' },
          { model: PacienteClinica, as: 'clinicasVinculadas', required: false, include: [{ model: Clinica, as: 'clinica' }] }
        ],
        distinct: true
      });
      if (existente) {
        const targetClinicaId = parseInt(clinica_id, 10);
        const hasLink = existente.clinica_id === targetClinicaId ||
          (existente.clinicasVinculadas || []).some(vc => vc.clinica_id === targetClinicaId);

        if (!hasLink) {
          await PacienteClinica.create({
            paciente_id: existente.id_paciente,
            clinica_id: targetClinicaId,
            es_principal: false
          });
        }

        return res.status(200).json({
          message: 'Paciente existente reutilizado en esta clínica',
          paciente: existente,
          sameClinic: existente.clinica_id === targetClinicaId,
          reuseCandidate: !hasLink,
          vinculado: true
        });
      }
    }

    const newPaciente = await Paciente.create({
      nombre,
      apellidos,
      dni,
      telefono_movil: normPhone,
      email: normEmail,
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

    // Crear relación con tutor si aplica
    if (tutor?.id_paciente_relacionado) {
      await PacienteRelacion.create({
        id_paciente: newPaciente.id_paciente,
        id_paciente_relacionado: tutor.id_paciente_relacionado,
        tipo_relacion: tutor.tipo_relacion || 'tutor_legal',
        es_contacto_principal: tutor.es_contacto_principal === false ? false : true,
        fecha_inicio: tutor.fecha_inicio || new Date()
      });
    }
    // Vincular a la clínica actual como principal
    await PacienteClinica.create({
      paciente_id: newPaciente.id_paciente,
      clinica_id,
      es_principal: true
    });

    res.status(201).json({
      message: 'Paciente creado exitosamente',
      paciente: newPaciente,
      reuseCandidate: false,
      vinculado: true
    });
  } catch (error) {
    res.status(500).json({ message: 'Error creating paciente', error: error.message });
  }
};

/**
 * Vincula un paciente existente a otra clínica del mismo grupo sin duplicar ficha.
 */
exports.vincularPacienteAClinica = async (req, res) => {
  try {
    const { id } = req.params;
    const { clinica_id } = req.body || {};
    const targetClinicaId = parseInt(clinica_id, 10);

    if (!targetClinicaId) {
      return res.status(400).json({ message: 'clinica_id es obligatorio' });
    }

    const paciente = await Paciente.findByPk(id, { include: [{ model: Clinica, as: 'clinica' }] });
    if (!paciente) {
      return res.status(404).json({ message: 'Paciente no encontrado' });
    }

    const clinicaOrigen = paciente.clinica;
    const clinicaDestino = await Clinica.findByPk(targetClinicaId);

    if (!clinicaDestino) {
      return res.status(404).json({ message: 'Clínica destino no encontrada' });
    }

    // Solo permitimos vincular dentro del mismo grupo de clínicas
    if (clinicaOrigen?.grupoClinicaId && clinicaDestino.grupoClinicaId && clinicaOrigen.grupoClinicaId !== clinicaDestino.grupoClinicaId) {
      return res.status(400).json({ message: 'El paciente solo puede vincularse a clínicas del mismo grupo' });
    }

    const existente = await PacienteClinica.findOne({
      where: { paciente_id: paciente.id_paciente, clinica_id: targetClinicaId }
    });

    if (existente) {
      return res.json({ message: 'Paciente ya vinculado a la clínica', vinculado: true });
    }

    await PacienteClinica.create({
      paciente_id: paciente.id_paciente,
      clinica_id: targetClinicaId,
      es_principal: false
    });

    return res.json({ message: 'Paciente vinculado correctamente', vinculado: true });
  } catch (error) {
    res.status(500).json({ message: 'Error al vincular paciente', error: error.message });
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

/**
 * Transferir contacto al propio paciente (al cumplir mayoría de edad, etc.)
 */
exports.transferirContacto = async (req, res) => {
  try {
    const { id } = req.params;
    const { telefono_movil, email } = req.body || {};
    const normPhone = normalizePhone(telefono_movil);
    const normEmail = normalizeEmail(email);
    if (!normPhone && !normEmail) {
      return res.status(400).json({ message: 'Se requiere teléfono o email para transferir el contacto' });
    }

    const paciente = await Paciente.findByPk(id, { include: [{ model: Clinica, as: 'clinica' }] });
    if (!paciente) {
      return res.status(404).json({ message: 'Paciente no encontrado' });
    }

    // Comprobar duplicados en el grupo
    const clinicaIds = await getClinicaIdsForScope(paciente.clinica_id, 'grupo');
    const dupWhere = { [Op.or]: [] };
    if (normPhone) dupWhere[Op.or].push({ telefono_movil: normPhone });
    if (normEmail) dupWhere[Op.or].push({ email: normEmail });
    if (clinicaIds.length === 1) dupWhere.clinica_id = clinicaIds[0];
    else if (clinicaIds.length > 1) dupWhere.clinica_id = { [Op.in]: clinicaIds };

    if (dupWhere[Op.or].length > 0) {
      const duplicado = await Paciente.findOne({
        where: dupWhere,
        include: [{ model: Clinica, as: 'clinica' }]
      });
      if (duplicado && duplicado.id_paciente !== paciente.id_paciente) {
        return res.status(409).json({
          error: 'PACIENTE_DUPLICADO',
          message: duplicado.clinica_id === paciente.clinica_id
            ? 'Ya existe un paciente con este teléfono/email en esta clínica'
            : `Ya existe un paciente con este teléfono/email en ${duplicado.clinica?.nombre_clinica || 'otra clínica del grupo'}`,
          paciente: duplicado,
          sameClinic: duplicado.clinica_id === paciente.clinica_id
        });
      }
    }

    // Actualizar paciente con sus datos de contacto
    await paciente.update({
      telefono_movil: normPhone || paciente.telefono_movil,
      email: normEmail || paciente.email
    });

    // Cerrar relaciones de tutoría como contacto principal
    await PacienteRelacion.update(
      { es_contacto_principal: false, fecha_fin: new Date() },
      { where: { id_paciente: paciente.id_paciente, es_contacto_principal: true, fecha_fin: null } }
    );

    const updated = await Paciente.findByPk(id, {
      include: [{ model: Clinica, as: 'clinica' }, { model: PacienteRelacion, as: 'relaciones', include: [{ model: Paciente, as: 'relacionado' }] }]
    });

    res.json({ message: 'Contacto transferido al paciente', paciente: updated });
  } catch (error) {
    res.status(500).json({ message: 'Error al transferir contacto', error: error.message });
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
