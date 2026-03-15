'use strict';
const asyncHandler = require('express-async-handler');
const db = require('../../models');
const { Op } = db.Sequelize;

const Tratamiento = db.Tratamiento;
const Clinica = db.Clinica;
const AutomationFlowTemplateV2 = db.AutomationFlowTemplateV2;

const APPOINTMENT_TRIGGER_TYPES = new Set([
    'appointment_created',
    'appointment_reminder_window',
    'appointment_confirmed',
    'appointment_no_show',
    'appointment_rescheduled',
    'appointment_cancelled',
    'appointment_completed',
]);
const APPOINTMENT_CREATED_WITHOUT_TREATMENT_SCOPE = 'without_treatment';

function toIntOrNull(value) {
    if (value === undefined || value === null || value === '') return null;
    const parsed = Number.parseInt(String(value), 10);
    return Number.isInteger(parsed) ? parsed : null;
}

function toCleanString(value) {
    if (value === undefined || value === null) return null;
    const cleaned = String(value).trim();
    return cleaned || null;
}

function extractTriggerConfig(template) {
    const rawConfig = template?.trigger_config && typeof template.trigger_config === 'object'
        ? template.trigger_config
        : null;
    if (rawConfig) return rawConfig;

    const nodes = Array.isArray(template?.nodes) ? template.nodes : [];
    const entryNodeId = toCleanString(template?.entry_node_id);
    const entryNode = nodes.find((node) => toCleanString(node?.id) === entryNodeId);
    return entryNode?.config && typeof entryNode.config === 'object' ? entryNode.config : null;
}

async function resolveEffectiveGroupId(tratamiento) {
    const directGroupId = toIntOrNull(tratamiento?.grupo_clinica_id);
    if (directGroupId) return directGroupId;

    const clinicId = toIntOrNull(tratamiento?.clinica_id);
    if (!clinicId) return null;

    const clinica = await Clinica.findOne({
        where: { id_clinica: clinicId },
        attributes: ['grupoClinicaId'],
        raw: true,
    });
    return toIntOrNull(clinica?.grupoClinicaId);
}

async function resolveGroupIdForClinicId(clinicId) {
    const parsedClinicId = toIntOrNull(clinicId);
    if (!parsedClinicId) return null;
    const clinica = await Clinica.findOne({
        where: { id_clinica: parsedClinicId },
        attributes: ['grupoClinicaId'],
        raw: true,
    });
    return toIntOrNull(clinica?.grupoClinicaId);
}

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
    const clinicIdNum = toIntOrNull(clinica_id);
    const groupIdNum = toIntOrNull(grupo_clinica_id);

    if (clinicIdNum && !groupIdNum) {
        const effectiveGroupId = await resolveGroupIdForClinicId(clinicIdNum);
        const scopeOr = [];

        if (!origen || origen === 'clinica') {
            scopeOr.push({ origen: 'clinica', clinica_id: clinicIdNum });
        }
        if ((!origen || origen === 'grupo') && effectiveGroupId) {
            scopeOr.push({ origen: 'grupo', grupo_clinica_id: effectiveGroupId });
        }
        if (!origen || origen === 'sistema') {
            scopeOr.push({ origen: 'sistema' });
        }

        if (scopeOr.length > 0) {
            where[Op.or] = scopeOr;
        }
    } else {
        if (clinicIdNum) where.clinica_id = clinicIdNum;
        if (groupIdNum) where.grupo_clinica_id = groupIdNum;
        if (origen) where.origen = origen;
    }

    if (disciplina) where.disciplina = disciplina;
    if (categoria) where.categoria = categoria;
    if (especialidad) where.especialidad = especialidad;
    if (activo !== undefined) {
        if (activo === 'true' || activo === true) where.activo = true;
        else if (activo === 'false' || activo === false) where.activo = false;
    }
    if (q) {
        const searchOr = [
            { nombre: { [db.Sequelize.Op.like]: `%${q}%` } },
            { descripcion: { [db.Sequelize.Op.like]: `%${q}%` } },
            { categoria: { [db.Sequelize.Op.like]: `%${q}%` } },
            { especialidad: { [db.Sequelize.Op.like]: `%${q}%` } },
            { codigo: { [db.Sequelize.Op.like]: `%${q}%` } }
        ];
        if (where[Op.or]) {
            where[Op.and] = where[Op.and] || [];
            where[Op.and].push({ [Op.or]: searchOr });
        } else {
            where[Op.or] = searchOr;
        }
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
        appointment_automation_template_key = null,
        appointment_automation_template_version = null,
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
        appointment_automation_template_key: appointment_automation_template_key || null,
        appointment_automation_template_version: appointment_automation_template_version || null,
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
        'appointment_automation_template_key',
        'appointment_automation_template_version',
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

exports.getTratamientoAutomationTemplate = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const tratamiento = await Tratamiento.findByPk(id);
    if (!tratamiento) {
        return res.status(404).json({ success: false, message: 'Tratamiento no encontrado' });
    }

    const templateKey = toCleanString(tratamiento.appointment_automation_template_key);
    const templateVersion = toIntOrNull(tratamiento.appointment_automation_template_version);

    if (!templateKey) {
        return res.json({
            success: true,
            data: {
                tratamiento_id: Number(tratamiento.id_tratamiento),
                automation_template: null,
            },
        });
    }

    const where = {
        template_key: templateKey,
        published_at: { [db.Sequelize.Op.ne]: null },
    };
    if (templateVersion) where.version = templateVersion;

    const template = await AutomationFlowTemplateV2.findOne({
        where,
        order: [['version', 'DESC']],
        raw: true,
    });

    if (!template || !APPOINTMENT_TRIGGER_TYPES.has(template.trigger_type)) {
        return res.json({
            success: true,
            data: {
                tratamiento_id: Number(tratamiento.id_tratamiento),
                automation_template: null,
            },
        });
    }

    return res.json({
        success: true,
        data: {
            tratamiento_id: Number(tratamiento.id_tratamiento),
            automation_template: {
                template_key: template.template_key,
                template_version: Number(template.version),
                template_id: Number(template.id),
                name: template.name,
                trigger_type: template.trigger_type,
                trigger_config: extractTriggerConfig(template),
                clinic_id: template.clinic_id ?? null,
                group_id: template.group_id ?? null,
                is_system: !!template.is_system,
                is_active: template.is_active !== false,
                published_at: template.published_at ?? null,
            },
        },
    });
});

exports.setTratamientoAutomationTemplate = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const tratamiento = await Tratamiento.findByPk(id);
    if (!tratamiento) {
        return res.status(404).json({ success: false, message: 'Tratamiento no encontrado' });
    }

    const templateKeyRaw = req.body?.template_key;
    const versionRaw = req.body?.template_version;
    if (templateKeyRaw === undefined) {
        return res.status(400).json({
            success: false,
            message: 'template_key es obligatorio (usar null para quitar asignación)',
        });
    }

    const templateKey = toCleanString(templateKeyRaw);
    if (!templateKey) {
        tratamiento.appointment_automation_template_key = null;
        tratamiento.appointment_automation_template_version = null;
        await tratamiento.save();
        return res.json({
            success: true,
            data: {
                tratamiento_id: Number(tratamiento.id_tratamiento),
                automation_template: null,
            },
        });
    }

    const requestedVersion = toIntOrNull(versionRaw);
    if (versionRaw !== undefined && versionRaw !== null && versionRaw !== '' && !requestedVersion) {
        return res.status(400).json({ success: false, message: 'template_version inválido' });
    }

    const where = {
        template_key: templateKey,
        is_active: true,
        published_at: { [db.Sequelize.Op.ne]: null },
    };
    if (requestedVersion) {
        where.version = requestedVersion;
    }

    const template = await AutomationFlowTemplateV2.findOne({
        where,
        order: [['version', 'DESC']],
    });
    if (!template) {
        return res.status(404).json({
            success: false,
            message: requestedVersion
                ? 'Plantilla v2 no encontrada para template_key/version'
                : 'Plantilla v2 no encontrada para template_key',
        });
    }

    if (!APPOINTMENT_TRIGGER_TYPES.has(template.trigger_type)) {
        return res.status(400).json({
            success: false,
            message: 'La plantilla no pertenece al dominio de cita (appointment)',
        });
    }

    const triggerConfig = extractTriggerConfig(template);
    if (
        template.trigger_type === 'appointment_created' &&
        String(triggerConfig?.appointment_scope || '').trim().toLowerCase() === APPOINTMENT_CREATED_WITHOUT_TREATMENT_SCOPE
    ) {
        return res.status(400).json({
            success: false,
            message: 'No puedes asignar a un tratamiento un flujo configurado solo para citas sin tratamiento.',
        });
    }

    if (!template.is_system) {
        const tratamientoClinicId = toIntOrNull(tratamiento.clinica_id);
        const effectiveGroupId = await resolveEffectiveGroupId(tratamiento);
        const templateClinicId = toIntOrNull(template.clinic_id);
        const templateGroupId = toIntOrNull(template.group_id);
        const templateClinicGroupId = templateClinicId
            ? await resolveGroupIdForClinicId(templateClinicId)
            : null;

        const isSameClinic = !!templateClinicId && !!tratamientoClinicId && templateClinicId === tratamientoClinicId;
        const isSameGroup = !!templateGroupId && !!effectiveGroupId && templateGroupId === effectiveGroupId;
        const isClinicFromSameGroup =
            !!templateClinicGroupId && !!effectiveGroupId && templateClinicGroupId === effectiveGroupId;
        if (!isSameClinic && !isSameGroup && !isClinicFromSameGroup) {
            return res.status(403).json({
                success: false,
                message: 'La plantilla v2 no pertenece al mismo alcance (clínica/grupo) del tratamiento',
            });
        }
    }

    tratamiento.appointment_automation_template_key = template.template_key;
    tratamiento.appointment_automation_template_version = Number(template.version);
    await tratamiento.save();

    return res.json({
        success: true,
        data: {
            tratamiento_id: Number(tratamiento.id_tratamiento),
            automation_template: {
                template_key: template.template_key,
                template_version: Number(template.version),
                template_id: Number(template.id),
                name: template.name,
                trigger_type: template.trigger_type,
                trigger_config: triggerConfig,
                clinic_id: template.clinic_id ?? null,
                group_id: template.group_id ?? null,
                is_system: !!template.is_system,
                is_active: template.is_active !== false,
                published_at: template.published_at ?? null,
            },
        },
    });
});
