'use strict';
const asyncHandler = require('express-async-handler');
const db = require('../../models');

const EspecialidadSistema = db.EspecialidadesMedicasSistema;
const EspecialidadClinica = db.EspecialidadesMedicasClinica;
const UsuarioEspecialidades = db.UsuarioEspecialidades;
const ClinicaEspecialidades = db.ClinicaEspecialidades;
const Clinica = db.Clinica;
const medicalAreaContractsService = require('../services/medicalAreaContracts.service');
const { canUserAccessFeature } = require('../lib/access-policy');
const {
    mergeClinicConfiguration,
    parseConfiguration,
} = require('../lib/clinic-configuration');

function normalizeDisciplinaList(value) {
    const items = Array.isArray(value) ? value : [];
    return [...new Set(
        items
            .map((item) => String(item || '').trim().toLowerCase())
            .filter(Boolean)
    )];
}

// Utilidad: asegurar que una disciplina esté incluida en la clínica
async function ensureDisciplinaEnClinica(clinicaId, disciplina) {
    if (!clinicaId || !disciplina) return [];
    const normalizedDisciplina = String(disciplina || '').trim().toLowerCase();
    return Clinica.sequelize.transaction(async (transaction) => {
        const clinica = await Clinica.findByPk(clinicaId, {
            transaction,
            lock: transaction.LOCK.UPDATE,
        });
        if (!clinica) return [];

        const currentConfig = parseConfiguration(clinica.configuracion);
        const currentDisc = normalizeDisciplinaList(currentConfig.disciplinas);
        if (!currentDisc.includes(normalizedDisciplina)) {
            currentDisc.push(normalizedDisciplina);
        }
        if (JSON.stringify(currentConfig.disciplinas || []) !== JSON.stringify(currentDisc)) {
            await clinica.update({
                configuracion: mergeClinicConfiguration(currentConfig, {
                    disciplinas: currentDisc,
                }),
            }, { transaction });
        }
        return currentDisc;
    });
}

async function canAccessClinicFeature(req, res, clinicId, featureKey) {
    const actorId = Number(req.userData?.userId || req.user?.id || 0);
    const parsedClinicId = Number(clinicId);
    if (!actorId) {
        res.status(401).json({ message: 'Token JWT inválido o no proporcionado' });
        return false;
    }
    if (!Number.isInteger(parsedClinicId) || parsedClinicId <= 0) {
        res.status(400).json({ message: 'clinica_id inválido' });
        return false;
    }
    const allowed = await canUserAccessFeature({
        actorId,
        featureKey,
        clinicId: parsedClinicId,
    });
    if (!allowed) {
        res.status(403).json({ message: 'No tienes permisos para esta clínica' });
        return false;
    }
    return true;
}

// ============ ESPECIALIDADES DE SISTEMA ============

exports.getMedicalAreaContracts = asyncHandler(async (req, res) => {
    res.json(await medicalAreaContractsService.getMedicalAreaContracts());
});

exports.getMedicalAreaContract = asyncHandler(async (req, res) => {
    const code = String(req.params.code || '').trim().toLowerCase();
    res.json({
        version: medicalAreaContractsService.VERSION,
        source: 'backend-db',
        fallback_code: medicalAreaContractsService.FALLBACK_CODE,
        contract: await medicalAreaContractsService.getContractForArea(code)
    });
});

exports.updateMedicalAreaContract = asyncHandler(async (req, res) => {
    const code = String(req.params.code || '').trim().toLowerCase();
    if (!code) {
        return res.status(400).json({ message: 'code es obligatorio' });
    }

    try {
        const updatedBy = Number(req.userData?.userId || req.user?.id || req.body?.updated_by || null) || null;
        const contract = await medicalAreaContractsService.upsertMedicalAreaContract(
            code,
            req.body?.contract || req.body,
            updatedBy
        );
        return res.json({
            version: medicalAreaContractsService.VERSION,
            source: 'backend-db',
            fallback_code: medicalAreaContractsService.FALLBACK_CODE,
            contract
        });
    } catch (error) {
        if (error.statusCode === 503) {
            return res.status(503).json({ message: 'La tabla de contratos de áreas médicas no está disponible todavía.' });
        }
        throw error;
    }
});

// Listar especialidades de sistema (solo lectura para clínicas)
exports.getEspecialidadesSistema = asyncHandler(async (req, res) => {
    const { disciplina, activo = 'true' } = req.query;
    const where = {};
    if (disciplina) where.disciplina = disciplina;
    if (activo === 'true') where.activo = true;

    const especialidades = await EspecialidadSistema.findAll({ where, order: [['nombre', 'ASC']] });
    res.json(especialidades);
});

exports.createEspecialidadSistema = asyncHandler(async (req, res) => {
    const nombre = String(req.body?.nombre || '').trim();
    const disciplina = String(req.body?.disciplina || '').trim().toLowerCase();

    if (!nombre || !disciplina) {
        return res.status(400).json({ message: 'nombre y disciplina son obligatorios' });
    }

    const existing = await EspecialidadSistema.findOne({
        where: {
            nombre,
            disciplina
        }
    });

    if (existing) {
        if (!existing.activo) {
            existing.activo = true;
            await existing.save();
            return res.json(existing);
        }

        return res.status(409).json({ message: 'Ya existe una especialidad de sistema con ese nombre y disciplina' });
    }

    const especialidad = await EspecialidadSistema.create({
        nombre,
        disciplina,
        activo: true
    });

    res.status(201).json(especialidad);
});

exports.updateEspecialidadSistema = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const especialidad = await EspecialidadSistema.findByPk(id);
    if (!especialidad) {
        return res.status(404).json({ message: 'Especialidad de sistema no encontrada' });
    }

    const nombre = req.body?.nombre !== undefined ? String(req.body.nombre || '').trim() : undefined;
    const disciplina = req.body?.disciplina !== undefined ? String(req.body.disciplina || '').trim().toLowerCase() : undefined;
    const activo = req.body?.activo;

    if (nombre !== undefined) {
        if (!nombre) {
            return res.status(400).json({ message: 'nombre no puede estar vacío' });
        }
        especialidad.nombre = nombre;
    }

    if (disciplina !== undefined) {
        if (!disciplina) {
            return res.status(400).json({ message: 'disciplina no puede estar vacía' });
        }
        especialidad.disciplina = disciplina;
    }

    if (activo !== undefined) {
        especialidad.activo = !!activo;
    }

    await especialidad.save();
    res.json(especialidad);
});

exports.deleteEspecialidadSistema = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const especialidad = await EspecialidadSistema.findByPk(id);
    if (!especialidad) {
        return res.status(404).json({ message: 'Especialidad de sistema no encontrada' });
    }

    especialidad.activo = false;
    await especialidad.save();
    res.json({ message: 'Especialidad de sistema desactivada' });
});

// ============ ESPECIALIDADES DE CLÍNICA ============

// Listar especialidades de una clínica (sistema + personalizadas)
exports.getEspecialidadesClinica = asyncHandler(async (req, res) => {
    const clinicaId = req.params.clinicaId || req.params.id || req.query.clinica_id;
    const { disciplina } = req.query;
    if (!clinicaId) return res.status(400).json({ message: 'clinica_id es obligatorio' });
    if (!await canAccessClinicFeature(req, res, clinicaId, 'clinic.settings.view')) return;

    const relaciones = await ClinicaEspecialidades.findAll({
        where: { id_clinica: clinicaId },
        include: [
            {
                model: EspecialidadSistema,
                as: 'especialidadSistema',
                required: false,
                where: {
                    ...(disciplina ? { disciplina } : {}),
                    activo: true
                }
            },
            {
                model: EspecialidadClinica,
                as: 'especialidadClinica',
                required: false,
                where: {
                    ...(disciplina ? { disciplina } : {}),
                    activo: true
                }
            }
        ],
        order: [['id', 'ASC']]
    });

    let resultado = relaciones.flatMap(rel => {
        const items = [];
        if (rel.especialidadSistema) {
            items.push({ ...rel.especialidadSistema.toJSON(), origen: 'sistema', relacion_id: rel.id, id_clinica: rel.id_clinica });
        }
        if (rel.especialidadClinica) {
            items.push({ ...rel.especialidadClinica.toJSON(), origen: 'clinica', relacion_id: rel.id, id_clinica: rel.id_clinica });
        }
        return items;
    });

    res.json(resultado);
});

// Crear especialidad personalizada de clínica
exports.createEspecialidadClinica = asyncHandler(async (req, res) => {
    const { id_clinica, nombre, disciplina } = req.body;
    if (!id_clinica || !nombre || !disciplina) {
        return res.status(400).json({ message: 'id_clinica, nombre y disciplina son obligatorios' });
    }
    if (!await canAccessClinicFeature(req, res, id_clinica, 'clinic.settings.edit')) return;

    const especialidad = await EspecialidadClinica.create({ id_clinica, nombre, disciplina, activo: true });

    await ClinicaEspecialidades.create({
        id_clinica,
        id_especialidad_clinica: especialidad.id,
        origen: 'clinica'
    });

    const disciplinas = await ensureDisciplinaEnClinica(id_clinica, disciplina);

    res.status(201).json({
        ...especialidad.toJSON(),
        disciplinas
    });
});

// Actualizar especialidad de clínica
exports.updateEspecialidadClinica = asyncHandler(async (req, res) => {
    const { id } = req.params;
    const especialidad = await EspecialidadClinica.findByPk(id);
    if (!especialidad) return res.status(404).json({ message: 'Especialidad no encontrada' });
    if (!await canAccessClinicFeature(req, res, especialidad.id_clinica, 'clinic.settings.edit')) return;

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
    if (!await canAccessClinicFeature(req, res, especialidad.id_clinica, 'clinic.settings.edit')) return;

    especialidad.activo = false;
    await especialidad.save();
    res.json({ message: 'Especialidad desactivada' });
});

// Añadir especialidad del sistema a una clínica (crea la relación)
exports.addEspecialidadSistemaAClinica = asyncHandler(async (req, res) => {
    const { id_clinica, id_especialidad_sistema } = req.body;
    if (!id_clinica || !id_especialidad_sistema) {
        return res.status(400).json({ message: 'id_clinica e id_especialidad_sistema son obligatorios' });
    }
    if (!await canAccessClinicFeature(req, res, id_clinica, 'clinic.settings.edit')) return;

    const especialidad = await EspecialidadSistema.findByPk(id_especialidad_sistema);
    if (!especialidad) {
        return res.status(404).json({ message: 'Especialidad de sistema no encontrada' });
    }

    const existente = await ClinicaEspecialidades.findOne({
        where: { id_clinica, id_especialidad_sistema }
    });
    if (existente) {
        const disciplinas = await ensureDisciplinaEnClinica(id_clinica, especialidad.disciplina);
        return res.status(200).json({
            ...existente.toJSON(),
            disciplinas
        });
    }

    const relacion = await ClinicaEspecialidades.create({
        id_clinica,
        id_especialidad_sistema,
        origen: 'sistema'
    });

    const disciplinas = await ensureDisciplinaEnClinica(id_clinica, especialidad.disciplina);

    res.status(201).json({
        ...relacion.toJSON(),
        disciplinas
    });
});

// Eliminar relación de especialidad de sistema en una clínica
exports.removeEspecialidadSistemaDeClinica = asyncHandler(async (req, res) => {
    const { clinicaId, especialidadId } = req.params;
    if (!clinicaId || !especialidadId) {
        return res.status(400).json({ message: 'clinicaId y especialidadId son obligatorios' });
    }
    if (!await canAccessClinicFeature(req, res, clinicaId, 'clinic.settings.edit')) return;

    const relacion = await ClinicaEspecialidades.findOne({
        where: { id_clinica: clinicaId, id_especialidad_sistema: especialidadId }
    });
    if (!relacion) {
        return res.status(404).json({ message: 'Relación no encontrada' });
    }

    await relacion.destroy();
    res.json({ message: 'Especialidad eliminada de la clínica' });
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

// ============ UTILIDAD: ESPECIALIDAD EN USO ============
exports.checkEspecialidadClinicaEnUso = asyncHandler(async (req, res) => {
    const { id } = req.params;
    if (!id) return res.status(400).json({ message: 'id es obligatorio' });

    // Verificar que exista
    const especialidad = await EspecialidadClinica.findByPk(id);
    if (!especialidad) {
        return res.status(404).json({ message: 'Especialidad no encontrada' });
    }
    if (!await canAccessClinicFeature(req, res, especialidad.id_clinica, 'clinic.settings.view')) return;

    // Contar asignaciones de usuarios a esta especialidad de clínica
    const cantidadProfesionales = await UsuarioEspecialidades.count({
        where: { id_especialidad_clinica: id }
    });

    res.json({
        enUso: cantidadProfesionales > 0,
        cantidadProfesionales
    });
});

exports._private = {
    ensureDisciplinaEnClinica,
    normalizeDisciplinaList,
};
