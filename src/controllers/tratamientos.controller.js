'use strict';
const asyncHandler = require('express-async-handler');
const db = require('../../models');

const Tratamiento = db.Tratamiento;
const Clinica = db.Clinica;

// Listar tratamientos con filtros
exports.getTratamientos = asyncHandler(async (req, res) => {
    const {
        clinica_id,
        grupo_clinica_id,
        disciplina,
        categoria,
        q,
        activo = 'true'
    } = req.query;

    const where = {};
    if (clinica_id) where.clinica_id = clinica_id;
    if (grupo_clinica_id) where.grupo_clinica_id = grupo_clinica_id;
    if (disciplina) where.disciplina = disciplina;
    if (categoria) where.categoria = categoria;
    if (activo !== undefined) {
        if (activo === 'true' || activo === true) where.activo = true;
        else if (activo === 'false' || activo === false) where.activo = false;
    }
    if (q) {
        where[db.Sequelize.Op.or] = [
            { nombre: { [db.Sequelize.Op.like]: `%${q}%` } },
            { descripcion: { [db.Sequelize.Op.like]: `%${q}%` } },
            { categoria: { [db.Sequelize.Op.like]: `%${q}%` } }
        ];
    }

    const tratamientos = await Tratamiento.findAll({
        where,
        order: [['nombre', 'ASC']],
        include: [{ model: Clinica, as: 'clinica' }]
    });
    res.json(tratamientos);
});

// Crear tratamiento
exports.createTratamiento = asyncHandler(async (req, res) => {
    const { nombre, disciplina, categoria, descripcion, duracion_min, precio_base, color, activo = true, clinica_id, grupo_clinica_id } = req.body || {};

    if (!nombre || !disciplina) {
        return res.status(400).json({ message: 'nombre y disciplina son obligatorios' });
    }

    const tratamiento = await Tratamiento.create({
        nombre,
        disciplina,
        categoria: categoria || null,
        descripcion: descripcion || null,
        duracion_min: duracion_min || null,
        precio_base: precio_base ?? 0,
        color: color || null,
        activo: activo !== false,
        clinica_id: clinica_id || null,
        grupo_clinica_id: grupo_clinica_id || null
    });

    res.status(201).json(tratamiento);
});

// Actualizar tratamiento
exports.updateTratamiento = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const tratamiento = await Tratamiento.findByPk(id);
    if (!tratamiento) {
        return res.status(404).json({ message: 'Tratamiento no encontrado' });
    }
    const updatableFields = ['nombre', 'disciplina', 'categoria', 'descripcion', 'duracion_min', 'precio_base', 'color', 'activo', 'clinica_id', 'grupo_clinica_id'];
    updatableFields.forEach((field) => {
        if (req.body[field] !== undefined) {
            tratamiento[field] = req.body[field];
        }
    });
    await tratamiento.save();
    res.json(tratamiento);
});

// Borrado lógico
exports.deleteTratamiento = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const tratamiento = await Tratamiento.findByPk(id);
    if (!tratamiento) {
        return res.status(404).json({ message: 'Tratamiento no encontrado' });
    }
    tratamiento.activo = false;
    await tratamiento.save();
    res.json({ message: 'Tratamiento desactivado' });
});
