const {
  Usuario,
  Clinica,
  GrupoClinica,
  UsuarioClinica,
  PatientDirectionProfile,
} = require('../../models');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const systemNotificationsService = require('../services/systemNotifications.service');

const SAFE_USER_ATTRIBUTES = [
  'id_usuario', 'nombre', 'apellidos', 'email_usuario', 'avatar', 'telefono',
  'cargo_usuario', 'isProfesional', 'fecha_creacion', 'ultimo_login',
];

function directoryClinicInclude(req, required = false) {
  const clinicIds = req.userDirectoryAccess?.clinicIds;
  return {
    model: Clinica,
    as: 'Clinicas',
    ...(Array.isArray(clinicIds) ? { where: { id_clinica: { [Op.in]: clinicIds } } } : {}),
    required,
    through: { attributes: ['rol_clinica', 'subrol_clinica'] },
  };
}

async function directoryUserWhere(req, query = '') {
  const clauses = [];
  const normalizedQuery = String(query || '').trim();
  if (normalizedQuery) {
    clauses.push({
      [Op.or]: [
        { nombre: { [Op.like]: `%${normalizedQuery}%` } },
        { apellidos: { [Op.like]: `%${normalizedQuery}%` } },
        { email_usuario: { [Op.like]: `%${normalizedQuery}%` } },
      ],
    });
  }

  if (req.userDirectoryAccess?.mode === 'agency') {
    const profiles = await PatientDirectionProfile.findAll({
      where: { is_active: true },
      attributes: ['user_id'],
      raw: true,
    });
    clauses.push({ id_usuario: { [Op.in]: profiles.map((profile) => profile.user_id) } });
  } else if (req.userDirectoryAccess?.mode === 'patient_director') {
    const memberships = await UsuarioClinica.findAll({
      where: { id_clinica: { [Op.in]: req.userDirectoryAccess.clinicIds || [] } },
      attributes: ['id_usuario'],
      raw: true,
    });
    clauses.push({
      id_usuario: {
        [Op.in]: Array.from(new Set([
          Number(req.userData?.userId),
          ...memberships.map((membership) => Number(membership.id_usuario)),
        ].filter(Boolean))),
      },
    });
  }
  return clauses.length > 1 ? { [Op.and]: clauses } : (clauses[0] || {});
}

async function findDirectoryUsers(req, query = '') {
  return Usuario.findAll({
    attributes: SAFE_USER_ATTRIBUTES,
    where: await directoryUserWhere(req, query),
    include: directoryClinicInclude(req, false),
    order: [['nombre', 'ASC'], ['apellidos', 'ASC']],
  });
}

exports.getAllUsers = async (req, res) => {
  try {
    res.json(await findDirectoryUsers(req));
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving users', error: error.message });
  }
};

// Buscar usuarios
exports.searchUsers = async (req, res) => {
  try {
    const users = await findDirectoryUsers(req, req.query.query);
    res.status(200).json(users);
  } catch (error) {
    console.error('Error al buscar usuarios:', error);
    res.status(500).json({ message: 'Error al procesar la búsqueda', error: error.message });
  }
};

// Obtener un usuario por ID con sus clínicas
exports.getUserById = async (req, res) => {
  try {
    const user = await Usuario.findByPk(req.params.id, {
      attributes: req.userDirectoryAccess?.mode === 'admin'
        ? { exclude: ['password_usuario'] }
        : SAFE_USER_ATTRIBUTES,
      include: directoryClinicInclude(req, false),
    });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving user', error: error.message });
  }
};

// Crear un usuario y asignarle clínicas con roles específicos  
exports.createUser = async (req, res) => {
  try {
    const {
      nombre = 'Nuevo Usuario',
      apellidos = '',
      email_usuario = 'test@test.com',
      email_factura = '',
      email_notificacion = '',
      fecha_creacion = new Date(),
      id_gestor = null,
      password_usuario,
      notas_usuario = '',
      telefono = '',
      cargo_usuario = '',
      cumpleanos = null,
      isProfesional = false,
      clinicas = [] // Array de asignaciones de clínicas con { id_clinica, rol_clinica, subrol_clinica }
    } = req.body;

    const hashedPassword = await bcrypt.hash(password_usuario, 8);

    // Crear el usuario (sin rol global, ya que se usa isProfesional)
    const newUser = await Usuario.create({
      nombre,
      apellidos,
      email_usuario,
      email_factura,
      email_notificacion,
      fecha_creacion,
      id_gestor,
      password_usuario: hashedPassword,
      notas_usuario,
      telefono,
      cargo_usuario,
      cumpleanos,
      isProfesional
    });

    // Asignar cada clínica con su rol correspondiente en la tabla pivote
    for (const clinicaData of clinicas) {
      // Limpiar el valor recibido y asignar 'paciente' por defecto si no se provee
      const rol = clinicaData.rol_clinica ? clinicaData.rol_clinica.trim() : 'paciente';
      const subrol = clinicaData.subrol_clinica ? clinicaData.subrol_clinica.trim() : null;
      await newUser.addClinica(clinicaData.id_clinica, {
        through: {
          rol_clinica: rol,
          subrol_clinica: subrol
        }
      });
    }

    systemNotificationsService.notifyUserRegistration({
      user: newUser,
      origin: 'users.admin_create',
    }).catch((error) => {
      console.warn('[users] No se pudo encolar notificación de nuevo registro:', error?.code || error?.message || error);
    });

    res.status(201).json({
      message: 'Usuario creado exitosamente',
      user: (() => {
        const json = newUser?.toJSON ? newUser.toJSON() : newUser;
        if (json && typeof json === 'object') {
          delete json.password_usuario;
        }
        return json;
      })()
    });
  } catch (error) {
    console.error('Error al crear el usuario:', error);
    res.status(500).json({ message: 'Error al crear el usuario', error: error.message });
  }
};

// Actualizar un usuario y sus asignaciones de clínicas  
exports.updateUser = async (req, res) => {
  try {
    const isAdmin = req.userDirectoryAccess?.mode === 'admin';
    const isSelf = Number(req.userData?.userId) === Number(req.params.id);
    if (!isAdmin && !isSelf) {
      return res.status(403).json({ message: 'Use patient direction profile assignment for this operation' });
    }
    const user = await Usuario.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const fieldsToUpdate = isAdmin ? [
      'nombre', 'apellidos', 'email_usuario', 'email_factura',
      'email_notificacion', 'id_gestor', 'notas_usuario', 'telefono',
      'cargo_usuario', 'cumpleanos', 'isProfesional'
    ] : [
      'nombre', 'apellidos', 'email_usuario', 'email_factura',
      'email_notificacion', 'notas_usuario', 'telefono', 'cumpleanos',
    ];

    fieldsToUpdate.forEach(field => {
      if (req.body[field] !== undefined) {
        user[field] = req.body[field];
      }
    });

    if (req.body.password_usuario) {
      user.password_usuario = await bcrypt.hash(req.body.password_usuario, 8);
    }

    await user.save();

    // Actualizar las asociaciones de clínicas
    if (isAdmin && req.body.clinicas && Array.isArray(req.body.clinicas)) {
      // Reinicializar las asociaciones actuales
      await user.setClinicas([]);
      for (const clinicaData of req.body.clinicas) {
        const rol = clinicaData.rol_clinica ? clinicaData.rol_clinica.trim() : 'paciente';
        const subrol = clinicaData.subrol_clinica ? clinicaData.subrol_clinica.trim() : null;
        await user.addClinica(clinicaData.id_clinica, {
          through: {
            rol_clinica: rol,
            subrol_clinica: subrol
          }
        });
      }
    }

    const updatedUser = await Usuario.findByPk(user.id_usuario, {
      attributes: { exclude: ['password_usuario'] },
      include: directoryClinicInclude(req, false),
    });

    res.json({
      message: 'Usuario actualizado exitosamente',
      user: updatedUser
    });
  } catch (error) {
    console.error('Error al actualizar el usuario:', error);
    res.status(500).json({ message: 'Error updating user', error: error.message });
  }
};

// Eliminar un usuario
exports.deleteUser = async (req, res) => {
  try {
    const user = await Usuario.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    await user.destroy();
    res.json({ message: 'Usuario eliminado' });
  } catch (error) {
    res.status(500).json({ message: 'Error deleting user', error: error.message });
  }
};

// Obtener las clínicas asociadas a un usuario (incluye información de la pivote)
// Obtener las clínicas asociadas a un usuario (incluye información de la pivote y grupoClinica)
// En src/controllers/user.controller.js (método getClinicasByUser)
exports.getClinicasByUser = async (req, res) => {
  try {
    const user = await Usuario.findByPk(req.params.id, {
      include: [{
        model: Clinica,
        as: 'Clinicas',
        ...(Array.isArray(req.userDirectoryAccess?.clinicIds)
          ? { where: { id_clinica: { [Op.in]: req.userDirectoryAccess.clinicIds } } }
          : {}),
        required: false,
        include: [{
          model: GrupoClinica, // Asegúrate de que GrupoClinica está definido en db
          as: 'grupoClinica'
        }],
        through: { attributes: ['rol_clinica', 'subrol_clinica'] }
      }]
    });
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }
    const clinicas = user.Clinicas || user.clinicas || [];
    res.json(clinicas);
  } catch (error) {
    console.error("Error retrieving clinicas:", error);
    res.status(500).json({ message: 'Error retrieving clinicas', error: error.message });
  }
};





// Asignar una clínica a un usuario (función adicional)
exports.addClinicaToUser = async (req, res) => {
  try {
    const { id_clinica, rol_clinica, subrol_clinica } = req.body;
    const user = await Usuario.findByPk(req.params.id);
    const clinica = await Clinica.findByPk(id_clinica);

    if (!user || !clinica) {
      return res.status(404).json({ message: 'User or Clinica not found' });
    }

    await user.addClinica(clinica, {
      through: { rol_clinica, subrol_clinica }
    });

    res.status(200).json({ message: 'Clinica assigned to user successfully' });
  } catch (error) {
    res.status(500).json({ message: 'Error assigning clinica to user', error: error.message });
  }
};
