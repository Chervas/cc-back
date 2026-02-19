'use strict';
const asyncHandler = require('express-async-handler');
const db = require('../../models');

const Tratamiento = db.Tratamiento;
const Clinica = db.Clinica;
const AppointmentFlowTemplate = db.AppointmentFlowTemplate;

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
        appointment_flow_template_id = null,
        clinica_id,
        grupo_clinica_id
    } = req.body || {};

    if (!nombre || !disciplina) {
        return res.status(400).json({ message: 'nombre y disciplina son obligatorios' });
    }
    const clinicaIdNum = clinica_id !== undefined && clinica_id !== null ? Number(clinica_id) : null;
    if (origen === 'clinica' && (!clinicaIdNum || Number.isNaN(clinicaIdNum))) {
        return res.status(400).json({ message: 'clinica_id válido es obligatorio para tratamientos de clínica' });
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
        appointment_flow_template_id: appointment_flow_template_id || null,
        clinica_id: clinicaIdNum || null,
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
        'appointment_flow_template_id',
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

// Obtener tratamiento por ID
exports.getTratamientoById = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const tratamiento = await Tratamiento.findByPk(id);
    if (!tratamiento) {
        return res.status(404).json({ message: 'Tratamiento no encontrado' });
    }
    res.json(tratamiento);
});

// Obtener flujo de cita asignado a un tratamiento
exports.getTratamientoFlow = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const tratamiento = await Tratamiento.findByPk(id);
    if (!tratamiento) {
        return res.status(404).json({ success: false, message: 'Tratamiento no encontrado' });
    }

    if (!tratamiento.appointment_flow_template_id) {
        return res.json({
            success: true,
            data: {
                tratamiento_id: Number(tratamiento.id_tratamiento),
                appointment_flow_template_id: null,
                template: null
            }
        });
    }

    const template = await AppointmentFlowTemplate.findByPk(tratamiento.appointment_flow_template_id);
    if (!template) {
        return res.json({
            success: true,
            data: {
                tratamiento_id: Number(tratamiento.id_tratamiento),
                appointment_flow_template_id: null,
                template: null
            }
        });
    }

    return res.json({
        success: true,
        data: {
            tratamiento_id: Number(tratamiento.id_tratamiento),
            appointment_flow_template_id: Number(template.id),
            template: {
                id: Number(template.id),
                name: template.name,
                description: template.description ?? null,
                discipline: template.discipline,
                version: template.version || '1.0',
                steps: Array.isArray(template.steps) ? template.steps : [],
                is_system: !!template.is_system,
                clinic_id: template.clinic_id ?? null,
                group_id: template.group_id ?? null,
                is_active: template.is_active !== false,
                created_at: template.created_at,
                updated_at: template.updated_at
            }
        }
    });
});

// Asignar/desasignar flujo de cita a un tratamiento
exports.setTratamientoFlow = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const tratamiento = await Tratamiento.findByPk(id);
    if (!tratamiento) {
        return res.status(404).json({ success: false, message: 'Tratamiento no encontrado' });
    }

    const templateIdRaw = req.body?.template_id;
    if (templateIdRaw === undefined) {
        return res.status(400).json({ success: false, message: 'template_id es obligatorio (usar null para quitar asignación)' });
    }

    if (templateIdRaw === null || templateIdRaw === '') {
        tratamiento.appointment_flow_template_id = null;
        await tratamiento.save();
        return res.json({
            success: true,
            data: {
                tratamiento_id: Number(tratamiento.id_tratamiento),
                appointment_flow_template_id: null
            }
        });
    }

    const templateId = Number(templateIdRaw);
    if (!Number.isFinite(templateId) || templateId <= 0) {
        return res.status(400).json({ success: false, message: 'template_id inválido' });
    }

    const template = await AppointmentFlowTemplate.findByPk(templateId);
    if (!template) {
        return res.status(404).json({ success: false, message: 'Plantilla de flujo no encontrada' });
    }
    if (template.is_active === false) {
        return res.status(400).json({ success: false, message: 'La plantilla está desactivada' });
    }

    // Validación de alcance:
    // - sistema: válida siempre
    // - de clínica: debe coincidir con la clínica del tratamiento
    // - de grupo: debe coincidir con el grupo del tratamiento
    if (!template.is_system) {
        const tratamientoClinicId = tratamiento.clinica_id ? Number(tratamiento.clinica_id) : null;
        const tratamientoGroupId = tratamiento.grupo_clinica_id ? Number(tratamiento.grupo_clinica_id) : null;
        const templateClinicId = template.clinic_id ? Number(template.clinic_id) : null;
        const templateGroupId = template.group_id ? Number(template.group_id) : null;

        let groupFromClinic = null;
        if (!tratamientoGroupId && tratamientoClinicId) {
            const clinica = await Clinica.findOne({
                where: { id_clinica: tratamientoClinicId },
                attributes: ['grupoClinicaId'],
                raw: true
            });
            groupFromClinic = clinica?.grupoClinicaId ? Number(clinica.grupoClinicaId) : null;
        }

        const effectiveGroupId = tratamientoGroupId || groupFromClinic || null;
        const isSameClinic = !!templateClinicId && !!tratamientoClinicId && templateClinicId === tratamientoClinicId;
        const isSameGroup = !!templateGroupId && !!effectiveGroupId && templateGroupId === effectiveGroupId;

        if (!isSameClinic && !isSameGroup) {
            return res.status(403).json({
                success: false,
                message: 'La plantilla no pertenece al mismo alcance (clínica/grupo) del tratamiento'
            });
        }
    }

    tratamiento.appointment_flow_template_id = templateId;
    await tratamiento.save();

    return res.json({
        success: true,
        data: {
            tratamiento_id: Number(tratamiento.id_tratamiento),
            appointment_flow_template_id: templateId
        }
    });
});
