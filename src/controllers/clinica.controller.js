'use strict';

const { Clinica, GrupoClinica, Servicio, ClinicMetaAsset, ClinicGoogleAdsAccount, Usuario, UsuarioClinica, ClinicaHorario } = require('../../models');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { metaSyncJobs } = require('../jobs/sync.jobs');
const jobRequestsService = require('../services/jobRequests.service');
const jobScheduler = require('../services/jobScheduler.service');
const automationDefaultsService = require('../services/automationDefaults.service');
const { STAFF_ROLES, ADMIN_ROLES, isGlobalAdmin } = require('../lib/role-helpers');

const ACTIVE_STAFF_INVITATION_WHERE = {
    [Op.or]: [
        { estado_invitacion: 'aceptada' },
        { estado_invitacion: null },
    ],
};

const parseIntOrNull = (value) => {
    const n = Number.parseInt(String(value), 10);
    return Number.isFinite(n) ? n : null;
};

const toBool = (value, fallback = false) => {
    if (value === undefined || value === null) return fallback;
    if (typeof value === 'boolean') return value;
    const normalized = String(value).trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes';
};

const isValidHHmm = (value) => /^([01]\d|2[0-3]):([0-5]\d)$/.test(String(value || ''));

const normalizePhoneDigits = (value) => {
    const digits = String(value || '').replace(/\D/g, '');
    return digits || null;
};

const extractWhatsappNumber = (asset) => {
    if (!asset) return null;
    const additional = asset.additionalData && typeof asset.additionalData === 'object'
        ? asset.additionalData
        : {};
    return normalizePhoneDigits(
        additional.displayPhoneNumber
        || additional.display_phone_number
        || asset.metaAssetName
        || null
    );
};

async function resolveConnectedWhatsappForClinic(clinicaData) {
    const clinicId = Number(clinicaData?.id_clinica);
    if (!Number.isFinite(clinicId)) return null;

    const clinicAsset = await ClinicMetaAsset.findOne({
        where: {
            clinicaId: clinicId,
            isActive: true,
            assetType: 'whatsapp_phone_number',
        },
        attributes: ['metaAssetName', 'additionalData', 'updatedAt'],
        order: [['updatedAt', 'DESC']],
        raw: true,
    });
    const clinicWhatsapp = extractWhatsappNumber(clinicAsset);
    if (clinicWhatsapp) return clinicWhatsapp;

    const groupId = clinicaData?.grupoClinicaId || clinicaData?.grupoClinica?.id_grupo || null;
    if (!groupId) return null;

    const groupAsset = await ClinicMetaAsset.findOne({
        where: {
            assignmentScope: 'group',
            grupoClinicaId: groupId,
            isActive: true,
            assetType: 'whatsapp_phone_number',
        },
        attributes: ['metaAssetName', 'additionalData', 'updatedAt'],
        order: [['updatedAt', 'DESC']],
        raw: true,
    });

    return extractWhatsappNumber(groupAsset);
}

async function enrichClinicContactFields(clinicaData) {
    if (!clinicaData) return clinicaData;
    const connectedWhatsapp = await resolveConnectedWhatsappForClinic(clinicaData);
    clinicaData.telefono_whatsapp_conectado = connectedWhatsapp;
    clinicaData.whatsapp_connected = !!connectedWhatsapp;
    if (!clinicaData.telefono_whatsapp && connectedWhatsapp) {
        clinicaData.telefono_whatsapp = connectedWhatsapp;
    }
    return clinicaData;
}

async function canReadClinicSchedule(userId, clinicId) {
    if (!Number.isFinite(Number(userId)) || !Number.isFinite(Number(clinicId))) return false;
    if (isGlobalAdmin(userId)) return true;
    const row = await UsuarioClinica.findOne({
        where: {
            id_usuario: Number(userId),
            id_clinica: Number(clinicId),
            rol_clinica: { [Op.in]: STAFF_ROLES },
            ...ACTIVE_STAFF_INVITATION_WHERE,
        },
        attributes: ['id_usuario'],
        raw: true,
    });
    return !!row;
}

async function canWriteClinicSchedule(userId, clinicId) {
    if (!Number.isFinite(Number(userId)) || !Number.isFinite(Number(clinicId))) return false;
    if (isGlobalAdmin(userId)) return true;
    const row = await UsuarioClinica.findOne({
        where: {
            id_usuario: Number(userId),
            id_clinica: Number(clinicId),
            rol_clinica: { [Op.in]: ADMIN_ROLES },
            ...ACTIVE_STAFF_INVITATION_WHERE,
        },
        attributes: ['id_usuario'],
        raw: true,
    });
    return !!row;
}

function normalizeHorariosPayload(clinicaId, body) {
    const raw = Array.isArray(body) ? body : (Array.isArray(body?.horarios) ? body.horarios : null);
    if (!Array.isArray(raw)) {
        return { error: 'horarios debe ser un array o { horarios: [] }' };
    }

    const rows = [];
    for (let i = 0; i < raw.length; i++) {
        const h = raw[i] || {};
        const dia = parseIntOrNull(h.dia_semana);
        const activo = toBool(h.activo, true);
        const horaInicio = String(h.hora_inicio || '').trim();
        const horaFin = String(h.hora_fin || '').trim();

        if (dia === null || dia < 0 || dia > 6) {
            return { error: `horarios[${i}].dia_semana inválido (0-6)` };
        }
        if (!isValidHHmm(horaInicio)) {
            return { error: `horarios[${i}].hora_inicio inválido (HH:mm)` };
        }
        if (!isValidHHmm(horaFin)) {
            return { error: `horarios[${i}].hora_fin inválido (HH:mm)` };
        }
        if (horaFin <= horaInicio) {
            return { error: `horarios[${i}] rango inválido (hora_fin debe ser > hora_inicio)` };
        }

        rows.push({
            clinica_id: Number(clinicaId),
            dia_semana: dia,
            activo,
            hora_inicio: horaInicio,
            hora_fin: horaFin,
        });
    }

    const activeByDay = new Map();
    rows
        .filter((r) => r.activo)
        .forEach((r) => {
            const list = activeByDay.get(r.dia_semana) || [];
            list.push(r);
            activeByDay.set(r.dia_semana, list);
        });

    for (const [day, list] of activeByDay.entries()) {
        const sorted = [...list].sort((a, b) => a.hora_inicio.localeCompare(b.hora_inicio));
        for (let idx = 1; idx < sorted.length; idx++) {
            if (sorted[idx].hora_inicio < sorted[idx - 1].hora_fin) {
                return { error: `horarios solapados para dia_semana=${day}` };
            }
        }
    }

    return { rows };
}

// Obtener todas las clínicas (con filtro opcional por clinica_id: id único, CSV o 'all')
exports.getAllClinicas = async (req, res) => {
    try {
        const { clinica_id } = req.query;
        const where = {};
        if (clinica_id && clinica_id !== 'all') {
            if (typeof clinica_id === 'string' && clinica_id.includes(',')) {
                where.id_clinica = { [Op.in]: clinica_id.split(',').map(id => parseInt(id)).filter(n => !isNaN(n)) };
            } else {
                where.id_clinica = clinica_id;
            }
        }
        const clinicas = await Clinica.findAll({
            where,
            order: [['nombre_clinica', 'ASC']]
        });
        const payload = clinicas.map(c => {
            const data = c.toJSON();
            const cfg = data.configuracion || {};
            data.configuracion = {
                ...cfg,
                disciplinas: Array.isArray(cfg.disciplinas) && cfg.disciplinas.length > 0 ? cfg.disciplinas : ['dental']
            };
            return data;
        });
        res.json(payload);
    } catch (error) {
        res.status(500).json({ message: 'Error retrieving clinicas', error: error.message });
    }
};

// Buscar clínicas
exports.searchClinicas = async (req, res) => {
    try {
        const query = req.query.query;
        const clinicas = await Clinica.findAll({
            where: {
                nombre_clinica: { [Op.like]: `%${query}%` }
            },
            order: [['nombre_clinica', 'ASC']]
        });
        res.status(200).json(clinicas);
    } catch (error) {
        console.error('Error al buscar clínicas:', error);
        res.status(500).json({ message: 'Error al procesar la búsqueda', error: error.message });
    }
};

// Obtener una clínica por ID (incluyendo la asociación con GrupoClinica)
exports.getClinicaById = async (req, res) => {
    try {
        const clinica = await Clinica.findByPk(req.params.id, {
            include: [
                {
                    model: GrupoClinica,
                    as: 'grupoClinica'
                },
                {
                    model: Usuario,
                    as: 'usuarios',
                    attributes: [
                        'id_usuario',
                        'nombre',
                        'apellidos',
                        'email_usuario',
                        'telefono',
                        'fecha_creacion',
                        'ultimo_login'
                    ],
                    through: {
                        where: {
                            rol_clinica: { [Op.ne]: 'paciente' }
                        },
                        attributes: ['rol_clinica', 'subrol_clinica']
                    },
                    required: false
                }
            ]
        });
        if (!clinica) {
            return res.status(404).json({ message: 'Clinica not found' });
        }
        const clinicaData = clinica.toJSON();
        const cfg = clinicaData.configuracion || {};
        clinicaData.configuracion = {
            ...cfg,
            disciplinas: Array.isArray(cfg.disciplinas) && cfg.disciplinas.length > 0 ? cfg.disciplinas : ['dental']
        };
        await enrichClinicContactFields(clinicaData);
        res.json(clinicaData);
    } catch (error) {
        res.status(500).json({ message: 'Error retrieving clinica', error: error.message });
    }
};

// Obtener horarios estructurados de clínica
exports.getHorarios = async (req, res) => {
    try {
        const clinicId = parseIntOrNull(req.params.id);
        if (!clinicId) {
            return res.status(400).json({ message: 'id inválido' });
        }

        const actorId = parseIntOrNull(req.userData?.userId);
        const canRead = await canReadClinicSchedule(actorId, clinicId);
        if (!canRead) {
            return res.status(403).json({ message: 'Sin permisos para ver horarios de esta clínica' });
        }

        const clinica = await Clinica.findByPk(clinicId, { attributes: ['id_clinica'] });
        if (!clinica) {
            return res.status(404).json({ message: 'Clínica no encontrada' });
        }

        const horarios = await ClinicaHorario.findAll({
            where: { clinica_id: clinicId },
            order: [['dia_semana', 'ASC'], ['hora_inicio', 'ASC'], ['id', 'ASC']]
        });
        return res.json(horarios);
    } catch (error) {
        console.error('Error getHorarios clínica:', error);
        return res.status(500).json({ message: 'Error al obtener horarios de la clínica' });
    }
};

// Reemplazar horarios estructurados de clínica
exports.putHorarios = async (req, res) => {
    const t = await Clinica.sequelize.transaction();
    try {
        const clinicId = parseIntOrNull(req.params.id);
        if (!clinicId) {
            await t.rollback();
            return res.status(400).json({ message: 'id inválido' });
        }

        const actorId = parseIntOrNull(req.userData?.userId);
        const canWrite = await canWriteClinicSchedule(actorId, clinicId);
        if (!canWrite) {
            await t.rollback();
            return res.status(403).json({ message: 'Sin permisos para editar horarios de esta clínica' });
        }

        const clinica = await Clinica.findByPk(clinicId, { attributes: ['id_clinica'], transaction: t });
        if (!clinica) {
            await t.rollback();
            return res.status(404).json({ message: 'Clínica no encontrada' });
        }

        const normalized = normalizeHorariosPayload(clinicId, req.body);
        if (normalized.error) {
            await t.rollback();
            return res.status(400).json({ message: normalized.error });
        }

        await ClinicaHorario.destroy({
            where: { clinica_id: clinicId },
            transaction: t,
        });

        if (normalized.rows.length) {
            await ClinicaHorario.bulkCreate(normalized.rows, { transaction: t });
        }

        await t.commit();

        const horarios = await ClinicaHorario.findAll({
            where: { clinica_id: clinicId },
            order: [['dia_semana', 'ASC'], ['hora_inicio', 'ASC'], ['id', 'ASC']]
        });
        return res.json(horarios);
    } catch (error) {
        await t.rollback();
        console.error('Error putHorarios clínica:', error);
        return res.status(500).json({ message: 'Error al actualizar horarios de la clínica' });
    }
};

// Crear una nueva clínica (con grupoClinicaId opcional)
exports.createClinica = async (req, res) => {
    console.log('Intentando crear clinica con datos:', req.body);
    try {
        const {
            nombre_clinica,
            telefono,
            telefono_fijo,
            telefono_movil,
            telefono_whatsapp,
            email,
            descripcion,
            direccion,
            codigo_postal,
            ciudad,
            provincia,
            pais,
            horario_atencion,
            url_web,
            url_avatar,
            url_fondo, 
            url_ficha_local, 
            fecha_creacion = new Date(),
            id_publicidad_meta,
            filtro_pc_meta,
            url_publicidad_meta,
            id_publicidad_google,
            filtro_pc_google,
            url_publicidad_google,
            servicios,
            checklist,
            estado_clinica = true,
            datos_fiscales_clinica,
            configuracion,
            grupoClinicaId  // Campo opcional para asignar grupo
        } = req.body;

        const configPayload = configuracion && typeof configuracion === 'object' ? configuracion : {};
        if (!Array.isArray(configPayload.disciplinas) || configPayload.disciplinas.length === 0) {
            configPayload.disciplinas = ['dental'];
        }

        const newClinica = await Clinica.create({   
            nombre_clinica,
            telefono: telefono || telefono_fijo || telefono_movil || telefono_whatsapp || null,
            telefono_fijo,
            telefono_movil,
            telefono_whatsapp,
            email,
            descripcion,
            direccion,
            codigo_postal,
            ciudad,
            provincia,
            pais,
            horario_atencion,
            url_web,
            url_avatar,
            url_fondo, 
            url_ficha_local, 
            fecha_creacion,
            id_publicidad_meta,
            filtro_pc_meta,
            url_publicidad_meta,
            id_publicidad_google,
            filtro_pc_google,
            url_publicidad_google,
            servicios,
            checklist,
            estado_clinica,
            datos_fiscales_clinica,
            configuracion: configPayload,
            grupoClinicaId
        });

        // Encolar creación de automatizaciones y plantillas predefinidas
        try {
            await automationDefaultsService.enqueueDefaultAutomations({
                clinicId: newClinica.id_clinica
            });
        } catch (err) {
            console.error('Error encolando automatizaciones por defecto', err?.message || err);
        }

        res.status(201).json({
            message: 'Clinica creada exitosamente',
            clinica: newClinica
        });
    } catch (error) {
        console.error('Error al crear la clínica:', error);
        res.status(500).json({ message: 'Error al crear la clínica', error: error.message });
    }
};

// Actualizar una clínica (incluyendo grupoClinicaId) y devolver la clínica actualizada con la asociación
// ✅ MÉTODO UPDATECLINICA CORREGIDO PARA EL CONTROLADOR


exports.updateClinica = async (req, res) => {
    try {
        // ✅ DEBUG COMPLETO para identificar el problema
        console.log('=== DEBUG RUTA ===');
        console.log('URL completa:', req.url);
        console.log('Método:', req.method);
        console.log('Params completos:', req.params);
        console.log('Param id_clinica:', req.params.id_clinica);
        console.log('Param id:', req.params.id);
        console.log('==================');
        
        // ✅ INTENTAR AMBAS OPCIONES
        const idFromBody = req.body?.id_clinica ?? req.body?.id;
        let id_clinica = req.params.id_clinica || req.params.id || idFromBody;
        
        console.log('ID de clínica final:', id_clinica);

        // ✅ INCLUIR TODOS LOS CAMPOS que pueden venir del frontend
        const {
            nombre_clinica,
            telefono,
            telefono_fijo,
            telefono_movil,
            telefono_whatsapp,
            email,
            descripcion,
            direccion,
            codigo_postal,
            ciudad,
            provincia,
            pais,
            horario_atencion,
            url_web,
            url_avatar,
            url_fondo,
            url_ficha_local,
            id_publicidad_meta,
            url_publicidad_meta,
            filtro_pc_meta,
            id_publicidad_google,
            url_publicidad_google,
            filtro_pc_google,
            servicios,
            checklist,
            estado_clinica,
            datos_fiscales_clinica,
            redes_sociales,
            configuracion,
            grupoClinicaId
        } = req.body;

        console.log('Datos recibidos para actualizar clínica:', req.body);

        // ✅ VERIFICAR que id_clinica no sea undefined
        if (!id_clinica) {
            console.error('❌ ID de clínica no encontrado en params');
            return res.status(400).json({ 
                message: 'ID de clínica requerido',
                debug: {
                    url: req.url,
                    params: req.params,
                    method: req.method
                }
            });
        }

        const clinicaExistente = await Clinica.findByPk(id_clinica);
        if (!clinicaExistente) {
            return res.status(404).json({ message: 'Clínica no encontrada' });
        }
        const previousGroupId = clinicaExistente.grupoClinicaId || null;

        let configToSave = configuracion !== undefined ? configuracion : (clinicaExistente.configuracion || {});
        if (!Array.isArray(configToSave?.disciplinas) || configToSave.disciplinas.length === 0) {
            configToSave = { ...configToSave, disciplinas: ['dental'] };
        }
        const receivedAnyPhoneField = [telefono, telefono_fijo, telefono_movil, telefono_whatsapp]
            .some((value) => value !== undefined);
        const telefonoCompat = receivedAnyPhoneField
            ? (telefono || telefono_fijo || telefono_movil || telefono_whatsapp || null)
            : undefined;

        // ✅ ACTUALIZAR con TODOS los campos
        const [updatedRowsCount] = await Clinica.update({
            nombre_clinica,
            telefono: telefonoCompat,
            telefono_fijo,
            telefono_movil,
            telefono_whatsapp,
            email,
            descripcion,
            direccion,
            codigo_postal,
            ciudad,
            provincia,
            pais,
            horario_atencion,
            url_web,
            url_avatar,
            url_fondo,
            url_ficha_local,
            id_publicidad_meta,
            url_publicidad_meta,
            filtro_pc_meta,
            id_publicidad_google,
            url_publicidad_google,
            filtro_pc_google,
            servicios,
            checklist,
            estado_clinica,
            datos_fiscales_clinica,
            redes_sociales,
            configuracion: configToSave,
            grupoClinicaId
        }, {
            where: { id_clinica: id_clinica }
        });

        // MySQL puede devolver 0 filas afectadas si no hubo cambios en los valores.
        // Ya verificamos existencia arriba, así que no tratamos este caso como "no encontrada".
        if (updatedRowsCount === 0) {
            console.log('ℹ️ Clínica sin cambios detectados en update, devolviendo entidad actual.');
        }

        // ✅ OBTENER la clínica actualizada con TODOS los campos
        const updatedClinica = await Clinica.findByPk(id_clinica, {
            include: [{
                model: GrupoClinica,
                as: 'grupoClinica',
                attributes: ['id_grupo', 'nombre_grupo']
            }]
        });

        console.log('Clínica actualizada con éxito:', updatedClinica);

        const newGroupId = updatedClinica?.grupoClinicaId ?? null;
        const clinicIdNumeric = Number(id_clinica);
        if (!Number.isNaN(clinicIdNumeric) && previousGroupId !== newGroupId) {
            console.log('🔄 Cambio de grupo detectado:', { previousGroupId, newGroupId, clinicId: clinicIdNumeric });
            try {
                if (newGroupId) {
                    const groupConfig = await GrupoClinica.findByPk(newGroupId);
                    let adsAutomatic = groupConfig?.ads_assignment_mode === 'automatic';
                    if (typeof req.body.autoAssignmentMode === 'string') {
                        if (req.body.autoAssignmentMode === 'automatic') {
                            adsAutomatic = true;
                        }
                        if (req.body.autoAssignmentMode === 'manual') {
                            adsAutomatic = false;
                        }
                    }

                    await ClinicMetaAsset.update({
                        assignmentScope: adsAutomatic ? 'group' : 'clinic',
                        grupoClinicaId: newGroupId
                    }, {
                        where: { clinicaId: clinicIdNumeric, assetType: 'ad_account' }
                    });

                    await ClinicGoogleAdsAccount.update({
                        assignmentScope: adsAutomatic ? 'group' : 'clinic',
                        grupoClinicaId: newGroupId
                    }, {
                        where: { clinicaId: clinicIdNumeric }
                    });

                    if (adsAutomatic) {
                        console.log(`🚀 Encolando resync automático para la clínica ${clinicIdNumeric}`);
                        const { job: metaJob } = await jobRequestsService.enqueueUniqueJobRequest({
                            type: 'meta_ads_recent',
                            payload: { clinicIds: [clinicIdNumeric] },
                            priority: 'critical',
                            origin: 'clinica:group-change',
                            requestedBy: req.userData?.userId || null,
                            requestedByRole: req.userData?.role || null,
                            requestedByName: req.userData?.name || null
                        });
                        jobScheduler.triggerImmediate(metaJob.id).catch((err) => {
                            console.error('❌ Error ejecutando resync Meta Ads post-asignación:', err);
                        });

                        const { job: googleJob } = await jobRequestsService.enqueueUniqueJobRequest({
                            type: 'google_ads_recent',
                            payload: { clinicIds: [clinicIdNumeric] },
                            priority: 'critical',
                            origin: 'clinica:group-change',
                            requestedBy: req.userData?.userId || null,
                            requestedByRole: req.userData?.role || null,
                            requestedByName: req.userData?.name || null
                        });
                        jobScheduler.triggerImmediate(googleJob.id).catch((err) => {
                            console.error('❌ Error ejecutando resync Google Ads post-asignación:', err);
                        });
                    }
                } else {
                    await ClinicMetaAsset.update({
                        assignmentScope: 'clinic',
                        grupoClinicaId: null
                    }, {
                        where: { clinicaId: clinicIdNumeric, assetType: 'ad_account' }
                    });

                    await ClinicGoogleAdsAccount.update({
                        assignmentScope: 'clinic',
                        grupoClinicaId: null
                    }, {
                        where: { clinicaId: clinicIdNumeric }
                    });
                }
            } catch (assignmentError) {
                console.error('❌ Error actualizando assignmentScope post cambio de grupo:', assignmentError);
            }
        }
        const updatedData = updatedClinica.toJSON();
        const cfg = updatedData.configuracion || {};
        updatedData.configuracion = {
            ...cfg,
            disciplinas: Array.isArray(cfg.disciplinas) && cfg.disciplinas.length > 0 ? cfg.disciplinas : ['dental']
        };
        await enrichClinicContactFields(updatedData);
        res.status(200).json(updatedData);

    } catch (error) {
        console.error('Error updating clinic:', error);
        res.status(500).json({ 
            message: 'Error al actualizar la clínica', 
            error: error.message 
        });
    }
};






// Eliminar una clínica
exports.deleteClinica = async (req, res) => {
    try {
        const clinica = await Clinica.findByPk(req.params.id);
        if (!clinica) {
            return res.status(404).json({ message: 'Clinica not found' });
        }
        await clinica.destroy();
        res.json({ message: 'Clinica deleted' });
    } catch (error) {
        res.status(500).json({ message: 'Error deleting clinica', error: error.message });
    }
};

// Asignar servicio a clínica
exports.addServicioToClinica = async (req, res) => {
    try {
        const { id_clinica, id_servicio } = req.body;
        const clinica = await Clinica.findByPk(id_clinica);
        const servicio = await Servicio.findByPk(id_servicio);

        if (!clinica || !servicio) {
            return res.status(404).send({ message: 'Clínica o Servicio no encontrado' });
        }

        await clinica.addServicio(servicio);
        res.status(200).send({ message: 'Servicio asignado a clínica correctamente' });
    } catch (error) {
        res.status(500).send({ message: 'Error al asignar servicio a clínica', error: error.message });
    }
};

// Obtener servicios de una clínica
exports.getServiciosByClinica = async (req, res) => {
    try {
        const { id_clinica } = req.params;
        const clinica = await Clinica.findByPk(id_clinica, {
            include: Servicio
        });

        if (!clinica) {
            return res.status(404).send({ message: 'Clínica no encontrada' });
        }

        res.status(200).send(clinica.servicios);
    } catch (error) {
        res.status(500).send({ message: 'Error al obtener servicios de la clínica', error: error.message });
    }
};
