'use strict';
const asyncHandler = require('express-async-handler');
const db = require('../../models');

const EspecialidadSistema = db.EspecialidadesMedicasSistema;
const EspecialidadClinica = db.EspecialidadesMedicasClinica;
const UsuarioEspecialidades = db.UsuarioEspecialidades;
const ClinicaEspecialidades = db.ClinicaEspecialidades;
const Clinica = db.Clinica;

// Utilidad: asegurar que una disciplina esté incluida en la clínica
async function ensureDisciplinaEnClinica(clinicaId, disciplina) {
    if (!clinicaId || !disciplina) return;
    const clinica = await Clinica.findByPk(clinicaId);
    if (!clinica) return;

    const currentConfig = clinica.configuracion || {};
    const currentDisc = Array.isArray(currentConfig.disciplinas) ? [...currentConfig.disciplinas] : [];
    if (!currentDisc.includes(disciplina)) {
        currentDisc.push(disciplina);
        await clinica.update({
            configuracion: {
                ...currentConfig,
                disciplinas: currentDisc
            }
        });
    }
}

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
    const clinicaId = req.params.clinicaId || req.params.id || req.query.clinica_id;
    const { disciplina } = req.query;
    if (!clinicaId) return res.status(400).json({ message: 'clinica_id es obligatorio' });

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

    // Fallback: si no hay relaciones (para compatibilidad), devolver sistema + personalizadas activas
    if (resultado.length === 0) {
        const whereSistema = { activo: true };
        const whereClinica = { id_clinica: clinicaId, activo: true };
        if (disciplina) {
            whereSistema.disciplina = disciplina;
            whereClinica.disciplina = disciplina;
        }

        const [sistema, clinica] = await Promise.all([
            EspecialidadSistema.findAll({ where: whereSistema }),
            EspecialidadClinica.findAll({ where: whereClinica })
        ]);

        resultado = [
            ...sistema.map(e => ({ ...e.toJSON(), origen: 'sistema' })),
            ...clinica.map(e => ({ ...e.toJSON(), origen: 'clinica' }))
        ];
    }

    res.json(resultado);
});

// Crear especialidad personalizada de clínica
exports.createEspecialidadClinica = asyncHandler(async (req, res) => {
    const { id_clinica, nombre, disciplina } = req.body;
    if (!id_clinica || !nombre || !disciplina) {
        return res.status(400).json({ message: 'id_clinica, nombre y disciplina son obligatorios' });
    }

    const especialidad = await EspecialidadClinica.create({ id_clinica, nombre, disciplina, activo: true });

    await ClinicaEspecialidades.create({
        id_clinica,
        id_especialidad_clinica: especialidad.id,
        origen: 'clinica'
    });

    await ensureDisciplinaEnClinica(id_clinica, disciplina);

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

// Añadir especialidad del sistema a una clínica (crea la relación)
exports.addEspecialidadSistemaAClinica = asyncHandler(async (req, res) => {
    const { id_clinica, id_especialidad_sistema } = req.body;
    if (!id_clinica || !id_especialidad_sistema) {
        return res.status(400).json({ message: 'id_clinica e id_especialidad_sistema son obligatorios' });
    }

    const especialidad = await EspecialidadSistema.findByPk(id_especialidad_sistema);
    if (!especialidad) {
        return res.status(404).json({ message: 'Especialidad de sistema no encontrada' });
    }

    const existente = await ClinicaEspecialidades.findOne({
        where: { id_clinica, id_especialidad_sistema }
    });
    if (existente) {
        return res.status(200).json(existente);
    }

    const relacion = await ClinicaEspecialidades.create({
        id_clinica,
        id_especialidad_sistema,
        origen: 'sistema'
    });

    await ensureDisciplinaEnClinica(id_clinica, especialidad.disciplina);

    res.status(201).json(relacion);
});

// Eliminar relación de especialidad de sistema en una clínica
exports.removeEspecialidadSistemaDeClinica = asyncHandler(async (req, res) => {
    const { clinicaId, especialidadId } = req.params;
    if (!clinicaId || !especialidadId) {
        return res.status(400).json({ message: 'clinicaId y especialidadId son obligatorios' });
    }

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

    // Contar asignaciones de usuarios a esta especialidad de clínica
    const cantidadProfesionales = await UsuarioEspecialidades.count({
        where: { id_especialidad_clinica: id }
    });

    res.json({
        enUso: cantidadProfesionales > 0,
        cantidadProfesionales
    });
});
