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
        especialidad,
        origen,
        q,
        activo = 'true'
    } = req.query;

    const where = {};
    if (clinica_id) where.clinica_id = clinica_id;
    if (grupo_clinica_id) where.grupo_clinica_id = grupo_clinica_id;
    if (disciplina) where.disciplina = disciplina;
    if (categoria) where.categoria = categoria;
    if (especialidad) where.especialidad = especialidad;
    if (origen) where.origen = origen;
    if (activo !== undefined) {
        if (activo === 'true' || activo === true) where.activo = true;
        else if (activo === 'false' || activo === false) where.activo = false;
    }
    if (q) {
        where[db.Sequelize.Op.or] = [
            { nombre: { [db.Sequelize.Op.like]: `%${q}%` } },
            { descripcion: { [db.Sequelize.Op.like]: `%${q}%` } },
            { categoria: { [db.Sequelize.Op.like]: `%${q}%` } },
            { especialidad: { [db.Sequelize.Op.like]: `%${q}%` } },
            { codigo: { [db.Sequelize.Op.like]: `%${q}%` } }
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
    const {
        nombre,
        codigo,
        disciplina,
        especialidad,
        categoria,
        descripcion,
        duracion_min,
        precio_base,
        color,
        origen = 'clinica',
        id_tratamiento_base = null,
        eliminado_por_clinica = null,
        asignacion_especialidades = null,
        sesiones_defecto = 1,
        requiere_pieza = false,
        requiere_zona = false,
        activo = true,
        clinica_id,
        grupo_clinica_id
    } = req.body || {};

    if (!nombre || !disciplina) {
        return res.status(400).json({ message: 'nombre y disciplina son obligatorios' });
    }

    const tratamiento = await Tratamiento.create({
        nombre,
        codigo: codigo || null,
        disciplina,
        especialidad: especialidad || null,
        categoria: categoria || null,
        descripcion: descripcion || null,
        duracion_min: duracion_min || null,
        precio_base: precio_base ?? 0,
        color: color || null,
        origen,
        id_tratamiento_base,
        eliminado_por_clinica,
        asignacion_especialidades,
        sesiones_defecto: sesiones_defecto ?? 1,
        requiere_pieza: !!requiere_pieza,
        requiere_zona: !!requiere_zona,
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
    const updatableFields = [
        'nombre',
        'codigo',
        'disciplina',
        'especialidad',
        'categoria',
        'descripcion',
        'duracion_min',
        'precio_base',
        'color',
        'origen',
        'id_tratamiento_base',
        'eliminado_por_clinica',
        'asignacion_especialidades',
        'sesiones_defecto',
        'requiere_pieza',
        'requiere_zona',
        'activo',
        'clinica_id',
        'grupo_clinica_id'
    ];
    updatableFields.forEach((field) => {
        if (req.body[field] !== undefined) {
            tratamiento[field] = req.body[field];
        }
    });
    await tratamiento.save();
    res.json(tratamiento);
});

// Ocultar tratamiento de sistema/grupo para una clínica
exports.ocultarTratamiento = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { clinica_id } = req.body;
    if (!clinica_id) return res.status(400).json({ message: 'clinica_id es obligatorio' });

    const tratamiento = await Tratamiento.findByPk(id);
    if (!tratamiento) return res.status(404).json({ message: 'Tratamiento no encontrado' });

    if (tratamiento.origen === 'clinica' && tratamiento.clinica_id === clinica_id) {
        return res.status(400).json({ message: 'No puedes ocultar un tratamiento propio de tu clínica' });
    }

    let eliminados = tratamiento.eliminado_por_clinica || [];
    if (!eliminados.includes(clinica_id)) {
        eliminados.push(clinica_id);
        tratamiento.eliminado_por_clinica = eliminados;
        await tratamiento.save();
    }

    res.json({ message: 'Tratamiento ocultado para esta clínica' });
});

// Restaurar tratamiento oculto
exports.restaurarTratamiento = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { clinica_id } = req.body;
    if (!clinica_id) return res.status(400).json({ message: 'clinica_id es obligatorio' });

    const tratamiento = await Tratamiento.findByPk(id);
    if (!tratamiento) return res.status(404).json({ message: 'Tratamiento no encontrado' });

    let eliminados = tratamiento.eliminado_por_clinica || [];
    eliminados = eliminados.filter(item => item !== clinica_id);
    tratamiento.eliminado_por_clinica = eliminados;
    await tratamiento.save();

    res.json({ message: 'Tratamiento restaurado para esta clínica' });
});

// Personalizar (copiar) tratamiento de sistema/grupo
exports.personalizarTratamiento = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const { clinica_id, ...cambios } = req.body;
    if (!clinica_id) return res.status(400).json({ message: 'clinica_id es obligatorio' });

    const tratamientoBase = await Tratamiento.findByPk(id);
    if (!tratamientoBase) return res.status(404).json({ message: 'Tratamiento no encontrado' });

    // No personalizar uno ya propio
    if (tratamientoBase.origen === 'clinica' && tratamientoBase.clinica_id === clinica_id) {
        return res.status(400).json({ message: 'El tratamiento ya pertenece a esta clínica' });
    }

    const datosCopia = {
        ...tratamientoBase.toJSON(),
        id_tratamiento: undefined,
        origen: 'clinica',
        clinica_id,
        id_tratamiento_base: tratamientoBase.id_tratamiento,
        ...cambios
    };
    delete datosCopia.createdAt;
    delete datosCopia.updatedAt;

    const nuevoCodigo = tratamientoBase.codigo ? `${tratamientoBase.codigo}-C${clinica_id}` : null;
    datosCopia.codigo = nuevoCodigo;

    const copia = await Tratamiento.create(datosCopia);
    res.status(201).json(copia);
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
