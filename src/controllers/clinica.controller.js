'use strict';

const {
    Clinica,
    GrupoClinica,
    Servicio,
    ClinicMetaAsset,
    ClinicGoogleAdsAccount,
    Usuario,
    UsuarioClinica,
    ClinicaHorario,
    PublicMediaAsset,
} = require('../../models');
const bcrypt = require('bcryptjs');
const { Op } = require('sequelize');
const { metaSyncJobs } = require('../jobs/sync.jobs');
const jobRequestsService = require('../services/jobRequests.service');
const jobScheduler = require('../services/jobScheduler.service');
const automationDefaultsService = require('../services/automationDefaults.service');
const { STAFF_ROLES, ADMIN_ROLES, isGlobalAdmin } = require('../lib/role-helpers');
const {
    assertUserCanAccessFeature,
    canUserAccessFeature,
    getAccessibleClinicIdsForFeature,
} = require('../lib/access-policy');
const {
    isPlainObject,
    mergeClinicConfiguration,
    normalizeClinicConfigurationForRead,
} = require('../lib/clinic-configuration');

const CLINIC_VIEW_FEATURE = 'clinic.settings.view';
const CLINIC_EDIT_FEATURE = 'clinic.settings.edit';
const ACTIVE_STAFF_INVITATION_WHERE = {
    [Op.or]: [
        { estado_invitacion: 'aceptada' },
        { estado_invitacion: null },
    ],
};

function normalizeClinicDataForResponse(value, { includeSensitive = false } = {}) {
    const data = value?.toJSON ? value.toJSON() : { ...(value || {}) };
    data.configuracion = normalizeClinicConfigurationForRead(data.configuracion);
    if (!includeSensitive) {
        delete data.datos_fiscales_clinica;
    }
    return data;
}

function parseRequestedClinicIds(value) {
    if (value === undefined || value === null || value === '' || value === 'all') return null;
    return Array.from(new Set(String(value)
        .split(',')
        .map((item) => Number.parseInt(item.trim(), 10))
        .filter((item) => Number.isInteger(item) && item > 0)));
}

function respondControllerError(res, error, fallbackMessage) {
    const status = Number(error?.status);
    if (Number.isInteger(status) && status >= 400 && status < 500) {
        return res.status(status).json({
            message: error.message,
            details: error.details || null,
        });
    }
    return res.status(500).json({ message: fallbackMessage, error: error?.message });
}

async function assertClinicAccess(actorId, clinicId, featureKey) {
    await assertUserCanAccessFeature({ actorId, featureKey, clinicId });
}

async function assertUserCanAssignClinicToGroup(actorId, groupId) {
    const normalizedGroupId = parseIntOrNull(groupId);
    if (!normalizedGroupId) {
        const error = new Error('clinic_group_id_invalid');
        error.status = 400;
        throw error;
    }
    const group = await GrupoClinica.findByPk(normalizedGroupId, {
        attributes: ['id_grupo'],
        raw: true,
    });
    if (!group) {
        const error = new Error('clinic_group_not_found');
        error.status = 404;
        throw error;
    }
    if (isGlobalAdmin(actorId)) return;

    const groupClinics = await Clinica.findAll({
        where: { grupoClinicaId: normalizedGroupId },
        attributes: ['id_clinica'],
        raw: true,
    });
    const groupClinicIds = groupClinics
        .map((clinic) => parseIntOrNull(clinic.id_clinica))
        .filter(Boolean);
    if (!groupClinicIds.length) {
        const error = new Error('clinic_group_assignment_requires_global_admin_for_empty_group');
        error.status = 403;
        throw error;
    }
    const ownerMemberships = await UsuarioClinica.findAll({
        where: {
            id_usuario: Number(actorId),
            id_clinica: { [Op.in]: groupClinicIds },
            rol_clinica: 'propietario',
            ...ACTIVE_STAFF_INVITATION_WHERE,
        },
        attributes: ['id_clinica'],
        raw: true,
    });
    const ownedClinicIds = new Set(ownerMemberships.map((row) => Number(row.id_clinica)));
    if (groupClinicIds.some((clinicId) => !ownedClinicIds.has(Number(clinicId)))) {
        const error = new Error('clinic_group_assignment_scope_forbidden');
        error.status = 403;
        throw error;
    }
}

async function assertUserCanChangeClinicGroup(actorId, previousGroupId, requestedGroupId) {
    const affectedGroupIds = Array.from(new Set([
        parseIntOrNull(previousGroupId),
        parseIntOrNull(requestedGroupId),
    ].filter(Boolean)));
    for (const groupId of affectedGroupIds) {
        await assertUserCanAssignClinicToGroup(actorId, groupId);
    }
}

async function assertAccessGuidanceAsset({ configuration, clinicId, transaction }) {
    const guidance = configuration?.access_guidance;
    if (!guidance?.image_asset_id) return;
    if (!PublicMediaAsset) {
        const error = new Error('clinic_access_guidance_asset_model_unavailable');
        error.status = 503;
        throw error;
    }

    const asset = await PublicMediaAsset.findOne({
        where: {
            id: guidance.image_asset_id,
            scope_type: 'clinic',
            clinica_id: Number(clinicId),
            purpose: 'clinic_access_image',
            sensitivity: 'public',
            status: 'active',
        },
        attributes: ['id', 'public_url'],
        transaction,
        raw: true,
    });
    if (!asset) {
        const error = new Error('clinic_access_guidance_asset_not_available');
        error.status = 409;
        error.details = { image_asset_id: guidance.image_asset_id };
        throw error;
    }
    if (String(asset.public_url || '') !== String(guidance.image_url || '')) {
        const error = new Error('clinic_access_guidance_asset_url_mismatch');
        error.status = 409;
        error.details = { image_asset_id: guidance.image_asset_id };
        throw error;
    }
}

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
    return canUserAccessFeature({
        actorId: Number(userId),
        featureKey: CLINIC_EDIT_FEATURE,
        clinicId: Number(clinicId),
    });
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
        const requestedClinicIds = parseRequestedClinicIds(clinica_id);
        if (requestedClinicIds && requestedClinicIds.length === 0) {
            return res.json([]);
        }
        const accessibleClinicIds = await getAccessibleClinicIdsForFeature({
            actorId: req.userData?.userId,
            featureKey: CLINIC_VIEW_FEATURE,
            clinicIds: requestedClinicIds,
        });
        if (!accessibleClinicIds.length) return res.json([]);

        const clinicas = await Clinica.findAll({
            where: { id_clinica: { [Op.in]: accessibleClinicIds } },
            order: [['nombre_clinica', 'ASC']]
        });
        const payload = clinicas.map(normalizeClinicDataForResponse);
        res.json(payload);
    } catch (error) {
        return respondControllerError(res, error, 'Error retrieving clinicas');
    }
};

// Buscar clínicas
exports.searchClinicas = async (req, res) => {
    try {
        const query = String(req.query.query || '').trim();
        const accessibleClinicIds = await getAccessibleClinicIdsForFeature({
            actorId: req.userData?.userId,
            featureKey: CLINIC_VIEW_FEATURE,
        });
        if (!accessibleClinicIds.length) return res.json([]);
        const clinicas = await Clinica.findAll({
            where: {
                id_clinica: { [Op.in]: accessibleClinicIds },
                nombre_clinica: { [Op.like]: `%${query}%` }
            },
            order: [['nombre_clinica', 'ASC']]
        });
        res.status(200).json(clinicas.map(normalizeClinicDataForResponse));
    } catch (error) {
        console.error('Error al buscar clínicas:', error);
        return respondControllerError(res, error, 'Error al procesar la búsqueda');
    }
};

// Obtener una clínica por ID (incluyendo la asociación con GrupoClinica)
exports.getClinicaById = async (req, res) => {
    try {
        const clinicId = parseIntOrNull(req.params.id);
        if (!clinicId) {
            return res.status(400).json({ message: 'id inválido' });
        }
        await assertClinicAccess(req.userData?.userId, clinicId, CLINIC_VIEW_FEATURE);
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
        const canEdit = await canUserAccessFeature({
            actorId: req.userData?.userId,
            featureKey: CLINIC_EDIT_FEATURE,
            clinicId,
        });
        const clinicaData = normalizeClinicDataForResponse(clinica, {
            includeSensitive: canEdit,
        });
        await enrichClinicContactFields(clinicaData);
        res.json(clinicaData);
    } catch (error) {
        return respondControllerError(res, error, 'Error retrieving clinica');
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
    try {
        if (!isGlobalAdmin(req.userData?.userId)) {
            return res.status(403).json({ message: 'No tienes permisos para crear clínicas' });
        }
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

        if (configuracion !== undefined && !isPlainObject(configuracion)) {
            return res.status(400).json({ message: 'clinic_configuration_patch_must_be_an_object' });
        }
        if (grupoClinicaId !== undefined && grupoClinicaId !== null && grupoClinicaId !== '') {
            await assertUserCanAssignClinicToGroup(req.userData?.userId, grupoClinicaId);
        }
        const configPayload = mergeClinicConfiguration({}, configuracion || {});
        if (configPayload.access_guidance?.image_asset_id || configPayload.access_guidance?.image_url) {
            return res.status(400).json({
                message: 'clinic_access_guidance_asset_requires_existing_clinic',
            });
        }
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
        return respondControllerError(res, error, 'Error al crear la clínica');
    }
};

// Actualizar una clínica (incluyendo grupoClinicaId) y devolver la clínica actualizada con la asociación
// ✅ MÉTODO UPDATECLINICA CORREGIDO PARA EL CONTROLADOR


exports.updateClinica = async (req, res) => {
    try {
        const idFromBody = req.body?.id_clinica ?? req.body?.id;
        const id_clinica = parseIntOrNull(req.params.id_clinica || req.params.id || idFromBody);

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

        if (!id_clinica) {
            return res.status(400).json({ message: 'ID de clínica requerido' });
        }
        await assertClinicAccess(req.userData?.userId, id_clinica, CLINIC_EDIT_FEATURE);
        if (configuracion !== undefined && !isPlainObject(configuracion)) {
            const error = new Error('clinic_configuration_patch_must_be_an_object');
            error.status = 400;
            throw error;
        }

        const receivedAnyPhoneField = [telefono, telefono_fijo, telefono_movil, telefono_whatsapp]
            .some((value) => value !== undefined);
        const telefonoCompat = receivedAnyPhoneField
            ? (telefono || telefono_fijo || telefono_movil || telefono_whatsapp || null)
            : undefined;

        const candidateUpdates = {
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
            grupoClinicaId
        };
        const scalarUpdates = Object.fromEntries(
            Object.entries(candidateUpdates).filter(([, value]) => value !== undefined)
        );

        const transactionResult = await Clinica.sequelize.transaction(async (transaction) => {
            // El lock hace que dos PATCH parciales lean siempre el JSON confirmado más
            // reciente. El merge profundo conserva agenda_settings, disciplinas y claves
            // futuras que no formen parte de este formulario.
            const clinicaExistente = await Clinica.findByPk(id_clinica, {
                transaction,
                lock: transaction.LOCK.UPDATE,
            });
            if (!clinicaExistente) {
                const error = new Error('Clínica no encontrada');
                error.status = 404;
                throw error;
            }

            const previousGroupId = parseIntOrNull(clinicaExistente.grupoClinicaId);
            const requestedGroupId = grupoClinicaId === undefined
                ? previousGroupId
                : (grupoClinicaId === null || grupoClinicaId === '' ? null : parseIntOrNull(grupoClinicaId));
            if (grupoClinicaId !== undefined && grupoClinicaId !== null && grupoClinicaId !== '' && !requestedGroupId) {
                const error = new Error('clinic_group_id_invalid');
                error.status = 400;
                throw error;
            }
            if (requestedGroupId !== previousGroupId) {
                // Una transición altera el scope compartido de Meta/Google de ambos
                // grupos. Exigimos autoridad sobre el origen incluso al desvincular,
                // y también sobre el destino cuando exista.
                await assertUserCanChangeClinicGroup(
                    req.userData?.userId,
                    previousGroupId,
                    requestedGroupId
                );
            }
            if (grupoClinicaId !== undefined) {
                scalarUpdates.grupoClinicaId = requestedGroupId;
            }
            if (configuracion !== undefined) {
                scalarUpdates.configuracion = mergeClinicConfiguration(
                    clinicaExistente.configuracion,
                    configuracion
                );
                if (Object.prototype.hasOwnProperty.call(configuracion, 'access_guidance')) {
                    await assertAccessGuidanceAsset({
                        configuration: scalarUpdates.configuracion,
                        clinicId: id_clinica,
                        transaction,
                    });
                }
            }

            if (Object.keys(scalarUpdates).length) {
                await clinicaExistente.update(scalarUpdates, { transaction });
            }
            return { previousGroupId };
        });

        const updatedClinica = await Clinica.findByPk(id_clinica, {
            include: [{
                model: GrupoClinica,
                as: 'grupoClinica',
                attributes: ['id_grupo', 'nombre_grupo']
            }]
        });

        const newGroupId = updatedClinica?.grupoClinicaId ?? null;
        const clinicIdNumeric = Number(id_clinica);
        if (!Number.isNaN(clinicIdNumeric) && transactionResult.previousGroupId !== newGroupId) {
            console.log('🔄 Cambio de grupo detectado:', {
                previousGroupId: transactionResult.previousGroupId,
                newGroupId,
                clinicId: clinicIdNumeric,
            });
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
        const updatedData = normalizeClinicDataForResponse(updatedClinica, { includeSensitive: true });
        await enrichClinicContactFields(updatedData);
        res.status(200).json(updatedData);

    } catch (error) {
        console.error('Error updating clinic:', error);
        return respondControllerError(res, error, 'Error al actualizar la clínica');
    }
};






// Eliminar una clínica
exports.deleteClinica = async (req, res) => {
    try {
        if (!isGlobalAdmin(req.userData?.userId)) {
            return res.status(403).json({ message: 'Solo un administrador global puede eliminar clínicas' });
        }
        const clinica = await Clinica.findByPk(req.params.id);
        if (!clinica) {
            return res.status(404).json({ message: 'Clinica not found' });
        }
        await clinica.destroy();
        res.json({ message: 'Clinica deleted' });
    } catch (error) {
        return respondControllerError(res, error, 'Error deleting clinica');
    }
};

// Asignar servicio a clínica
exports.addServicioToClinica = async (req, res) => {
    try {
        const { id_clinica, id_servicio } = req.body;
        await assertClinicAccess(req.userData?.userId, id_clinica, CLINIC_EDIT_FEATURE);
        const clinica = await Clinica.findByPk(id_clinica);
        const servicio = await Servicio.findByPk(id_servicio);

        if (!clinica || !servicio) {
            return res.status(404).send({ message: 'Clínica o Servicio no encontrado' });
        }

        await clinica.addServicio(servicio);
        res.status(200).send({ message: 'Servicio asignado a clínica correctamente' });
    } catch (error) {
        return respondControllerError(res, error, 'Error al asignar servicio a clínica');
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

exports._private = {
    assertUserCanAssignClinicToGroup,
    assertUserCanChangeClinicGroup,
    normalizeClinicDataForResponse,
};
