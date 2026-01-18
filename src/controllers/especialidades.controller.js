'use strict';
const asyncHandler = require('express-async-handler');
const db = require('../../models');

const EspecialidadSistema = db.EspecialidadesMedicasSistema;
const EspecialidadClinica = db.EspecialidadesMedicasClinica;
const UsuarioEspecialidades = db.UsuarioEspecialidades;

// ============ ESPECIALIDADES DE SISTEMA ============

// Listar especialidades de sistema (solo lectura para clínicas)
exports.getEspecialidadesSistema = asyncHandler(async (req, res) => {
    const { disciplina, activo = 'true' } = req.query;
    const where = {};
    if (disciplina) where.disciplina = disciplina;
    if (activo === 'true') where.activo = true;

    const especialidades = await EspecialidadSistema.findAll({ where, order: [['nombre', 'ASC']] });
    res.json(especialidades);
});

// ============ ESPECIALIDADES DE CLÍNICA ============

// Listar especialidades de una clínica (sistema + personalizadas)
exports.getEspecialidadesClinica = asyncHandler(async (req, res) => {
    const { clinica_id, disciplina } = req.query;
    if (!clinica_id) return res.status(400).json({ message: 'clinica_id es obligatorio' });

    const whereSistema = { activo: true };
    const whereClinica = { id_clinica: clinica_id, activo: true };
    if (disciplina) {
        whereSistema.disciplina = disciplina;
        whereClinica.disciplina = disciplina;
    }

    const [sistema, clinica] = await Promise.all([
        EspecialidadSistema.findAll({ where: whereSistema }),
        EspecialidadClinica.findAll({ where: whereClinica })
    ]);

    const resultado = [
        ...sistema.map(e => ({ ...e.toJSON(), origen: 'sistema' })),
        ...clinica.map(e => ({ ...e.toJSON(), origen: 'clinica' }))
    ];
    res.json(resultado);
});

// Crear especialidad personalizada de clínica
exports.createEspecialidadClinica = asyncHandler(async (req, res) => {
    const { id_clinica, nombre, disciplina } = req.body;
    if (!id_clinica || !nombre || !disciplina) {
        return res.status(400).json({ message: 'id_clinica, nombre y disciplina son obligatorios' });
    }

    const especialidad = await EspecialidadClinica.create({ id_clinica, nombre, disciplina, activo: true });
    res.status(201).json(especialidad);
});

// Actualizar especialidad de clínica
exports.updateEspecialidadClinica = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const especialidad = await EspecialidadClinica.findByPk(id);
    if (!especialidad) return res.status(404).json({ message: 'Especialidad no encontrada' });

    const { nombre, activo } = req.body;
    if (nombre !== undefined) especialidad.nombre = nombre;
    if (activo !== undefined) especialidad.activo = activo;
    await especialidad.save();
    res.json(especialidad);
});

// Eliminar (desactivar) especialidad de clínica
exports.deleteEspecialidadClinica = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const especialidad = await EspecialidadClinica.findByPk(id);
    if (!especialidad) return res.status(404).json({ message: 'Especialidad no encontrada' });

    especialidad.activo = false;
    await especialidad.save();
    res.json({ message: 'Especialidad desactivada' });
});

// ============ USUARIO-ESPECIALIDADES ============

// Obtener especialidades de un usuario
exports.getEspecialidadesUsuario = asyncHandler(async (req, res) => {
    const { id_usuario } = req.params;

    const especialidades = await UsuarioEspecialidades.findAll({
        where: { id_usuario },
        include: [
            { model: EspecialidadSistema, as: 'especialidadSistema' },
            { model: EspecialidadClinica, as: 'especialidadClinica' }
        ]
    });
    res.json(especialidades);
});

// Asignar especialidad a usuario
exports.addEspecialidadUsuario = asyncHandler(async (req, res) => {
    const { id_usuario, id_especialidad_sistema, id_especialidad_clinica } = req.body;
    if (!id_usuario) return res.status(400).json({ message: 'id_usuario es obligatorio' });
    if (!id_especialidad_sistema && !id_especialidad_clinica) {
        return res.status(400).json({ message: 'Debe indicar id_especialidad_sistema o id_especialidad_clinica' });
    }

    const asignacion = await UsuarioEspecialidades.create({
        id_usuario,
        id_especialidad_sistema: id_especialidad_sistema || null,
        id_especialidad_clinica: id_especialidad_clinica || null
    });
    res.status(201).json(asignacion);
});

// Eliminar especialidad de usuario
exports.removeEspecialidadUsuario = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const asignacion = await UsuarioEspecialidades.findByPk(id);
    if (!asignacion) return res.status(404).json({ message: 'Asignación no encontrada' });

    await asignacion.destroy();
    res.json({ message: 'Especialidad eliminada del usuario' });
});
