const { Op } = require('sequelize');
const { Usuario, Clinica, UsuarioClinica, DoctorBloqueo, CitaPaciente } = require('../../models');
const bcrypt = require('bcryptjs');

// Mantener consistente con userclinicas.routes.js
const ADMIN_USER_IDS = [1];

const isAdmin = (userId) => ADMIN_USER_IDS.includes(Number(userId));

async function getAccessibleClinicIdsForUser(userId) {
    // Admin: puede acceder a todas las clinicas (pero seguimos filtrando por query para evitar dumps enormes)
    if (isAdmin(userId)) {
        const all = await Clinica.findAll({
            attributes: ['id_clinica'],
            raw: true,
        });
        return all
            .map((c) => Number(c.id_clinica))
            .filter((id) => Number.isFinite(id));
    }

    const rows = await UsuarioClinica.findAll({
        where: {
            id_usuario: userId,
            rol_clinica: { [Op.in]: ['propietario', 'personaldeclinica'] },
        },
        attributes: ['id_clinica'],
        raw: true,
    });

    return rows
        .map((r) => Number(r.id_clinica))
        .filter((id) => Number.isFinite(id));
}

function parseBool(value) {
    if (value === true) return true;
    if (value === false) return false;
    const v = String(value || '').trim().toLowerCase();
    return v === '1' || v === 'true' || v === 'yes';
}

function parseIntOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function parseDateOrNull(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function normalizeHm(value) {
    if (value == null) return null;
    const raw = String(value).trim();
    const match = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
    if (!match) return null;
    const hh = match[1].padStart(2, '0');
    const mm = match[2];
    return `${hh}:${mm}`;
}

function buildDateTime(dateOrIso, hm, fallbackHm) {
    if (!dateOrIso) return null;
    if (hm) {
        const day = String(dateOrIso).slice(0, 10);
        return parseDateOrNull(`${day}T${hm}:00`);
    }

    const parsed = parseDateOrNull(dateOrIso);
    if (parsed) return parsed;

    if (String(dateOrIso).length === 10 && fallbackHm) {
        return parseDateOrNull(`${String(dateOrIso)}T${fallbackHm}:00`);
    }

    return null;
}

function toHm(dateValue) {
    const date = parseDateOrNull(dateValue);
    if (!date) return null;
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function toDay(dateValue) {
    const date = parseDateOrNull(dateValue);
    if (!date) return null;
    return date.toISOString().slice(0, 10);
}

async function canAccessTargetPersonal(actorId, targetUserId, clinicId) {
    if (isAdmin(actorId)) {
        return true;
    }

    if (Number(actorId) === Number(targetUserId)) {
        return true;
    }

    const actorClinicIds = await getAccessibleClinicIdsForUser(actorId);
    if (!actorClinicIds.length) {
        return false;
    }

    let allowedClinicIds = actorClinicIds;
    if (Number.isFinite(clinicId)) {
        if (!actorClinicIds.includes(clinicId)) {
            return false;
        }
        allowedClinicIds = [clinicId];
    }

    const match = await UsuarioClinica.findOne({
        where: {
            id_usuario: Number(targetUserId),
            rol_clinica: { [Op.in]: ['propietario', 'personaldeclinica'] },
            id_clinica: { [Op.in]: allowedClinicIds },
        },
        attributes: ['id_clinica'],
        raw: true,
    });

    return !!match;
}

function serializeBloqueo(bloqueo) {
    return {
        id: bloqueo.id,
        personal_id: bloqueo.doctor_id,
        doctor_id: bloqueo.doctor_id,
        clinica_id: bloqueo.clinica_id ?? null,
        fecha_inicio: bloqueo.fecha_inicio,
        fecha_fin: bloqueo.fecha_fin,
        fecha: toDay(bloqueo.fecha_inicio),
        hora_inicio: toHm(bloqueo.fecha_inicio),
        hora_fin: toHm(bloqueo.fecha_fin),
        motivo: bloqueo.motivo || '',
        tipo: bloqueo.tipo || 'ausencia',
        recurrente: bloqueo.recurrente || 'none',
        aplica_a_todas_clinicas: !!bloqueo.aplica_a_todas_clinicas,
        created_at: bloqueo.created_at,
        updated_at: bloqueo.updated_at,
    };
}

exports.getPersonal = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const accessibleClinicIds = await getAccessibleClinicIdsForUser(actorId);

        const clinicaId = parseIntOrNull(req.query?.clinica_id ?? req.query?.clinic_id);
        const groupId = parseIntOrNull(req.query?.group_id ?? req.query?.grupo_id);
        const all = parseBool(req.query?.all);

        let targetClinicIds = [];

        if (all) {
            if (!isAdmin(actorId)) {
                return res.status(403).json({ message: 'Forbidden' });
            }
            targetClinicIds = accessibleClinicIds;
        } else if (groupId != null) {
            // No filtramos por pertenencia a grupo "propietario", solo por clinicas accesibles (no filtramos mas por falta de modelo de ownership)
            const clinicsInGroup = await Clinica.findAll({
                where: {
                    grupoClinicaId: groupId,
                    id_clinica: { [Op.in]: accessibleClinicIds },
                },
                attributes: ['id_clinica'],
                raw: true,
            });
            targetClinicIds = clinicsInGroup
                .map((c) => Number(c.id_clinica))
                .filter((id) => Number.isFinite(id));
        } else if (clinicaId != null) {
            if (!accessibleClinicIds.includes(clinicaId) && !isAdmin(actorId)) {
                return res.status(403).json({ message: 'Forbidden' });
            }
            targetClinicIds = [clinicaId];
        } else {
            // Evitar dumps enormes: para no-admin exigimos clinica_id; para admin permitimos (pero no recomendado)
            if (!isAdmin(actorId)) {
                return res.status(400).json({ message: 'clinica_id is required' });
            }
            targetClinicIds = accessibleClinicIds;
        }

        if (!targetClinicIds.length) {
            return res.json([]);
        }

        const users = await Usuario.findAll({
            attributes: { exclude: ['password_usuario'] },
            include: [
                {
                    model: Clinica,
                    as: 'Clinicas',
                    required: true,
                    where: {
                        id_clinica: { [Op.in]: targetClinicIds },
                    },
                    through: {
                        attributes: ['rol_clinica', 'subrol_clinica'],
                        where: {
                            rol_clinica: { [Op.in]: ['propietario', 'personaldeclinica'] },
                        },
                    },
                },
            ],
            order: [['nombre', 'ASC']],
        });

        return res.json(users);
    } catch (error) {
        console.error('[personal.getPersonal] Error:', error);
        return res.status(500).json({ message: 'Error retrieving personal', error: error.message });
    }
};

exports.getPersonalById = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const targetUserId = Number(req.params.id);
        if (!Number.isFinite(targetUserId)) {
            return res.status(400).json({ message: 'Invalid id' });
        }

        const accessibleClinicIds = await getAccessibleClinicIdsForUser(actorId);

        const user = await Usuario.findByPk(targetUserId, {
            attributes: { exclude: ['password_usuario'] },
            include: [
                {
                    model: Clinica,
                    as: 'Clinicas',
                    required: true,
                    where: isAdmin(actorId)
                        ? undefined
                        : { id_clinica: { [Op.in]: accessibleClinicIds } },
                    through: {
                        attributes: ['rol_clinica', 'subrol_clinica'],
                        where: {
                            rol_clinica: { [Op.in]: ['propietario', 'personaldeclinica'] },
                        },
                    },
                },
            ],
        });

        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        return res.json(user);
    } catch (error) {
        console.error('[personal.getPersonalById] Error:', error);
        return res.status(500).json({ message: 'Error retrieving personal member', error: error.message });
    }
};

exports.updatePersonalMember = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const targetUserId = Number(req.params.id);
        if (!Number.isFinite(targetUserId)) {
            return res.status(400).json({ message: 'Invalid id' });
        }

        // Permisos:
        // - Admin: puede editar cualquiera
        // - Propietario: puede editar usuarios que pertenecen a alguna de sus clinicas (rol_clinica=propietario)
        const actorOwnerClinicRows = await UsuarioClinica.findAll({
            where: {
                id_usuario: actorId,
                rol_clinica: 'propietario',
            },
            attributes: ['id_clinica'],
            raw: true,
        });
        const actorOwnerClinicIds = actorOwnerClinicRows
            .map((r) => Number(r.id_clinica))
            .filter((id) => Number.isFinite(id));

        const canEdit =
            isAdmin(actorId) ||
            actorOwnerClinicIds.length > 0;

        if (!canEdit) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        if (!isAdmin(actorId)) {
            // Verificar interseccion clinica entre actor propietario y usuario objetivo
            const targetClinics = await UsuarioClinica.findAll({
                where: {
                    id_usuario: targetUserId,
                    id_clinica: { [Op.in]: actorOwnerClinicIds },
                },
                attributes: ['id_clinica'],
                raw: true,
            });
            if (!targetClinics.length) {
                return res.status(403).json({ message: 'Forbidden' });
            }
        }

        const user = await Usuario.findByPk(targetUserId);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        const fieldsToUpdate = [
            'nombre',
            'apellidos',
            'email_usuario',
            'email_factura',
            'email_notificacion',
            'id_gestor',
            'notas_usuario',
            'telefono',
            'cargo_usuario',
            'cumpleanos',
            'isProfesional',
        ];

        for (const field of fieldsToUpdate) {
            if (req.body[field] !== undefined) {
                user[field] = req.body[field];
            }
        }

        if (req.body.password_usuario) {
            user.password_usuario = await bcrypt.hash(req.body.password_usuario, 8);
        }

        await user.save();

        // Actualizar pivot clinicas (sin borrar asignaciones fuera del scope)
        if (Array.isArray(req.body.clinicas)) {
            const allowedClinicIdsForPivot = isAdmin(actorId) ? null : actorOwnerClinicIds;

            for (const clinicaData of req.body.clinicas) {
                const id_clinica = Number(clinicaData?.id_clinica);
                if (!Number.isFinite(id_clinica)) continue;

                if (allowedClinicIdsForPivot && !allowedClinicIdsForPivot.includes(id_clinica)) {
                    continue;
                }

                const rol = (clinicaData?.rol_clinica ? String(clinicaData.rol_clinica).trim() : 'paciente');
                const subrol = (clinicaData?.subrol_clinica ? String(clinicaData.subrol_clinica).trim() : null);

                await UsuarioClinica.upsert({
                    id_usuario: targetUserId,
                    id_clinica,
                    rol_clinica: rol,
                    subrol_clinica: subrol,
                });
            }
        }

        // Releer para devolver datos (y evitar filtrar contrasena)
        const updatedUser = await Usuario.findByPk(targetUserId, {
            attributes: { exclude: ['password_usuario'] },
            include: [
                {
                    model: Clinica,
                    as: 'Clinicas',
                    required: false,
                    through: { attributes: ['rol_clinica', 'subrol_clinica'] },
                },
            ],
        });

        return res.json({
            message: 'Usuario actualizado exitosamente',
            user: updatedUser,
        });
    } catch (error) {
        console.error('[personal.updatePersonalMember] Error:', error);
        return res.status(500).json({ message: 'Error updating personal member', error: error.message });
    }
};

exports.getPersonalBloqueos = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const targetUserId = Number(req.params.id);
        if (!Number.isFinite(targetUserId)) {
            return res.status(400).json({ message: 'Invalid id' });
        }

        const clinicaId = parseIntOrNull(req.query?.clinica_id ?? req.query?.clinic_id);
        const canAccess = await canAccessTargetPersonal(actorId, targetUserId, clinicaId);
        if (!canAccess) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const fromRaw = req.query?.from || req.query?.fecha_inicio;
        const toRaw = req.query?.to || req.query?.fecha_fin;
        const fromDate = buildDateTime(fromRaw, null, '00:00');
        const toDate = buildDateTime(toRaw, null, '23:59');

        const where = { doctor_id: targetUserId };
        if (Number.isFinite(clinicaId)) {
            where[Op.or] = [
                { clinica_id: clinicaId },
                { clinica_id: null },
            ];
        }
        if (fromDate && toDate) {
            where[Op.and] = [
                { fecha_inicio: { [Op.lte]: toDate } },
                { fecha_fin: { [Op.gte]: fromDate } },
            ];
        } else if (fromDate) {
            where.fecha_fin = { [Op.gte]: fromDate };
        } else if (toDate) {
            where.fecha_inicio = { [Op.lte]: toDate };
        }

        const rows = await DoctorBloqueo.findAll({
            where,
            order: [['fecha_inicio', 'ASC']],
        });

        return res.json(rows.map(serializeBloqueo));
    } catch (error) {
        console.error('[personal.getPersonalBloqueos] Error:', error);
        return res.status(500).json({ message: 'Error retrieving personal bloqueos', error: error.message });
    }
};

exports.createPersonalBloqueo = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const targetUserId = Number(req.params.id);
        if (!Number.isFinite(targetUserId)) {
            return res.status(400).json({ message: 'Invalid id' });
        }

        const clinicaId = parseIntOrNull(req.body?.clinica_id ?? req.body?.clinic_id);
        const canAccess = await canAccessTargetPersonal(actorId, targetUserId, clinicaId);
        if (!canAccess) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const horaInicio = normalizeHm(req.body?.hora_inicio);
        const horaFin = normalizeHm(req.body?.hora_fin);
        const fechaInicioInput = req.body?.fecha_inicio || req.body?.fecha;
        const fechaFinInput = req.body?.fecha_fin || req.body?.fecha;

        const fechaInicio = buildDateTime(fechaInicioInput, horaInicio, '00:00');
        const fechaFin = buildDateTime(fechaFinInput, horaFin, '23:59');

        if (!fechaInicio || !fechaFin) {
            return res.status(400).json({ message: 'fecha_inicio/fecha_fin inválidas' });
        }

        if (fechaInicio >= fechaFin) {
            return res.status(400).json({ message: 'Rango inválido: fecha_fin debe ser mayor que fecha_inicio' });
        }

        const overlapCita = await CitaPaciente.findOne({
            where: {
                doctor_id: targetUserId,
                inicio: { [Op.lt]: fechaFin },
                fin: { [Op.gt]: fechaInicio },
            },
            attributes: ['id_cita', 'inicio', 'fin'],
            raw: true,
        });

        if (overlapCita) {
            return res.status(409).json({
                message: 'No se puede bloquear: hay citas en ese rango',
                reason: 'STAFF_HAS_APPOINTMENTS',
                cita_conflictiva: overlapCita,
            });
        }

        const bloqueo = await DoctorBloqueo.create({
            doctor_id: targetUserId,
            clinica_id: clinicaId,
            fecha_inicio: fechaInicio,
            fecha_fin: fechaFin,
            tipo: (req.body?.tipo || 'ausencia').toString().slice(0, 32),
            motivo: (req.body?.motivo || '').toString().slice(0, 255),
            recurrente: req.body?.recurrente || 'none',
            aplica_a_todas_clinicas: clinicaId == null ? true : false,
            creado_por: actorId,
        });

        const serialized = serializeBloqueo(bloqueo);

        return res.status(201).json(serialized);
    } catch (error) {
        console.error('[personal.createPersonalBloqueo] Error:', error);
        return res.status(500).json({ message: 'Error creating personal bloqueo', error: error.message });
    }
};

exports.deletePersonalBloqueo = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const targetUserId = Number(req.params.id);
        const bloqueoId = Number(req.params.bloqueoId);
        if (!Number.isFinite(targetUserId) || !Number.isFinite(bloqueoId)) {
            return res.status(400).json({ message: 'Invalid id' });
        }

        const bloqueo = await DoctorBloqueo.findOne({
            where: { id: bloqueoId, doctor_id: targetUserId },
        });
        if (!bloqueo) {
            return res.status(404).json({ message: 'Bloqueo no encontrado' });
        }

        const canAccess = await canAccessTargetPersonal(actorId, targetUserId, null);
        if (!canAccess) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        await bloqueo.destroy();
        return res.status(204).end();
    } catch (error) {
        console.error('[personal.deletePersonalBloqueo] Error:', error);
        return res.status(500).json({ message: 'Error deleting personal bloqueo', error: error.message });
    }
};
