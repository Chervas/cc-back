const { Usuario, Clinica, GrupoClinica } = require('../../models');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');

// Obtener todos los usuarios con sus clínicas (incluyendo la información de la tabla pivote)
exports.getAllUsers = async (req, res) => {
  try {
    const users = await Usuario.findAll({
      include: {
        model: Clinica,
        as: 'Clinicas',
        through: { attributes: ['rol_clinica', 'subrol_clinica'] }
      },
      order: [['nombre', 'ASC']]
    });
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: 'Error retrieving users', error: error.message });
  }
};

// Buscar usuarios
exports.searchUsers = async (req, res) => {
  try {
    const query = req.query.query;
    const users = await Usuario.findAll({
      where: {
        [Op.or]: [
          { nombre: { [Op.like]: `%${query}%` } },
          { apellidos: { [Op.like]: `%${query}%` } }
        ]
      },
      order: [['nombre', 'ASC']]
    });
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
      include: {
        model: Clinica,
        as: 'Clinicas',
        through: { attributes: ['rol_clinica', 'subrol_clinica'] }
      }
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

    res.status(201).json({
      message: 'Usuario creado exitosamente',
      user: newUser
    });
  } catch (error) {
    console.error('Error al crear el usuario:', error);
    res.status(500).json({ message: 'Error al crear el usuario', error: error.message });
  }
};

// Actualizar un usuario y sus asignaciones de clínicas  
exports.updateUser = async (req, res) => {
  try {
    const user = await Usuario.findByPk(req.params.id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    const fieldsToUpdate = [
      'nombre', 'apellidos', 'email_usuario', 'email_factura',
      'email_notificacion', 'id_gestor', 'notas_usuario', 'telefono',
      'cargo_usuario', 'cumpleanos', 'isProfesional'
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
    if (req.body.clinicas && Array.isArray(req.body.clinicas)) {
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
      include: {
        model: Clinica,
        as: 'Clinicas',
        through: { attributes: ['rol_clinica', 'subrol_clinica'] }
      }
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
    console.log("Obteniendo usuario con ID:", req.params.id);
    const user = await Usuario.findByPk(req.params.id, {
      include: [{
        model: Clinica,
        as: 'Clinicas',
        include: [{
          model: GrupoClinica, // Asegúrate de que GrupoClinica está definido en db
          as: 'grupoClinica'
        }],
        through: { attributes: ['rol_clinica', 'subrol_clinica'] }
      }]
    });
    if (!user) {
      console.log("Usuario no encontrado");
      return res.status(404).json({ message: 'User not found' });
    }
    console.log("Usuario obtenido con clínicas:", JSON.stringify(user, null, 2));
    const clinicas = user.Clinicas || user.clinicas || [];
    console.log("Clínicas a retornar:", clinicas);
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
