const { Op } = require('sequelize');
const { Usuario, Clinica, UsuarioClinica, DoctorClinica, DoctorHorario, DoctorBloqueo, CitaPaciente } = require('../../models');
const bcrypt = require('bcryptjs');

// Mantener consistente con userclinicas.routes.js
const ADMIN_USER_IDS = [1];
const DEFAULT_TIMEZONE = 'Europe/Madrid';
// Nota: columna DoctorBloqueos.tipo es STRING(32) (sin ENUM). Mantener lista alineada con el front.
const BLOQUEO_TIPOS = new Set(['vacaciones', 'enfermedad', 'ausencia', 'formacion', 'congreso', 'otro']);
const MODO_DISPONIBILIDAD = new Set(['avanzado', 'basico']);

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
    if (value === null || value === undefined) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
}

function parseDateOrNull(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function parseClinicConfig(value) {
    if (!value) return null;
    if (typeof value === 'object') return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            return parsed && typeof parsed === 'object' ? parsed : null;
        } catch (error) {
            return null;
        }
    }
    return null;
}

function isValidTimeZone(value) {
    if (!value || typeof value !== 'string') return false;
    try {
        Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
        return true;
    } catch (error) {
        return false;
    }
}

function resolveClinicTimezone(clinica) {
    const cfg = parseClinicConfig(clinica && clinica.configuracion);
    const candidates = [
        cfg && (cfg.timezone || cfg.timeZone || cfg.tz),
        clinica && (clinica.timezone || clinica.time_zone || clinica.tz),
    ];

    for (const candidate of candidates) {
        if (isValidTimeZone(candidate)) return candidate;
    }
    return DEFAULT_TIMEZONE;
}

function formatPartsInTimeZone(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    }).formatToParts(date);

    const bag = {};
    parts.forEach((p) => {
        if (p.type !== 'literal') bag[p.type] = p.value;
    });

    return {
        year: Number(bag.year),
        month: Number(bag.month),
        day: Number(bag.day),
        hour: Number(bag.hour),
        minute: Number(bag.minute),
        second: Number(bag.second),
    };
}

function offsetMinutesForTimeZone(date, timeZone) {
    const p = formatPartsInTimeZone(date, timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    return Math.round((asUtc - date.getTime()) / 60000);
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

function localDateTimeToUtc(fechaLocal, timeValue, timeZone) {
    if (!fechaLocal || typeof fechaLocal !== 'string') return null;
    const d = fechaLocal.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!d) return null;

    const rawTime = String(timeValue || '').trim();
    const t = rawTime.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/);
    if (!t) return null;

    const year = Number(d[1]);
    const month = Number(d[2]);
    const day = Number(d[3]);
    const hour = Number(t[1]);
    const minute = Number(t[2]);
    const second = Number(t[3] || '00');

    const naiveUtc = Date.UTC(year, month - 1, day, hour, minute, second);
    let ts = naiveUtc;
    for (let i = 0; i < 2; i++) {
        const offsetMin = offsetMinutesForTimeZone(new Date(ts), timeZone);
        ts = naiveUtc - offsetMin * 60000;
    }
    return new Date(ts);
}

function buildDateTime(dateOrIso, hm, fallbackHm, timeZone = DEFAULT_TIMEZONE) {
    if (!dateOrIso) return null;

    const raw = String(dateOrIso).trim();
    const hasExplicitTz = /[Zz]$|[+-]\d{2}:\d{2}$/.test(raw);
    const localMatch = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2})?))?$/);

    if (hm) {
        const day = localMatch ? localMatch[1] : raw.slice(0, 10);
        return localDateTimeToUtc(day, `${hm}:00`, timeZone);
    }

    if (localMatch && !hasExplicitTz && localMatch[2]) {
        return localDateTimeToUtc(localMatch[1], localMatch[2], timeZone);
    }

    const parsed = parseDateOrNull(raw);
    if (parsed) return parsed;

    if (localMatch && fallbackHm) {
        return localDateTimeToUtc(localMatch[1], `${fallbackHm}:00`, timeZone);
    }

    if (raw.length === 10 && fallbackHm) {
        return localDateTimeToUtc(raw, `${fallbackHm}:00`, timeZone);
    }

    return null;
}

function toHm(dateValue, timeZone = DEFAULT_TIMEZONE) {
    const date = parseDateOrNull(dateValue);
    if (!date) return null;
    const p = formatPartsInTimeZone(date, timeZone);
    return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

function toDay(dateValue, timeZone = DEFAULT_TIMEZONE) {
    const date = parseDateOrNull(dateValue);
    if (!date) return null;
    const p = formatPartsInTimeZone(date, timeZone);
    return `${String(p.year).padStart(4, '0')}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

async function getClinicTimezoneById(clinicaId) {
    const id = Number(clinicaId);
    if (!Number.isFinite(id)) return DEFAULT_TIMEZONE;
    const clinica = await Clinica.findByPk(id, {
        attributes: ['id_clinica', 'configuracion'],
        raw: true,
    });
    return resolveClinicTimezone(clinica);
}

async function buildClinicTimezoneMap(clinicIds) {
    const ids = Array.from(new Set(
        (clinicIds || [])
            .map((id) => Number(id))
            .filter((id) => Number.isFinite(id))
    ));

    if (!ids.length) {
        return new Map();
    }

    const rows = await Clinica.findAll({
        where: { id_clinica: { [Op.in]: ids } },
        attributes: ['id_clinica', 'configuracion'],
        raw: true,
    });

    const map = new Map();
    rows.forEach((row) => {
        map.set(Number(row.id_clinica), resolveClinicTimezone(row));
    });
    return map;
}

function timezoneForClinicId(clinicaId, timezoneMap) {
    const id = Number(clinicaId);
    if (Number.isFinite(id) && timezoneMap && timezoneMap.has(id)) {
        return timezoneMap.get(id);
    }
    return DEFAULT_TIMEZONE;
}

function normalizeBloqueoTipo(value) {
    if (value == null || String(value).trim() === '') {
        return 'ausencia';
    }
    const tipo = String(value).trim().toLowerCase();
    if (!BLOQUEO_TIPOS.has(tipo)) {
        return null;
    }
    return tipo;
}

function normalizeModoDisponibilidad(value) {
    if (value == null || String(value).trim() === '') {
        return null;
    }
    const modo = String(value).trim().toLowerCase();
    if (!MODO_DISPONIBILIDAD.has(modo)) {
        return null;
    }
    return modo;
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

function serializeBloqueo(bloqueo, timeZone = DEFAULT_TIMEZONE) {
    return {
        id: bloqueo.id,
        id_usuario: bloqueo.doctor_id,
        personal_id: bloqueo.doctor_id,
        doctor_id: bloqueo.doctor_id,
        clinica_id: bloqueo.clinica_id ?? null,
        fecha_inicio: bloqueo.fecha_inicio,
        fecha_fin: bloqueo.fecha_fin,
        fecha: toDay(bloqueo.fecha_inicio, timeZone),
        hora_inicio: toHm(bloqueo.fecha_inicio, timeZone),
        hora_fin: toHm(bloqueo.fecha_fin, timeZone),
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

// ────────────────────────────────────────────────────────────────
// Bloqueos permissions (server-truth)
// ────────────────────────────────────────────────────────────────

exports.getPersonalBloqueosPermissions = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const targetUserId = Number(req.params.id);
        if (!Number.isFinite(targetUserId)) {
            return res.status(400).json({ message: 'Invalid id' });
        }

        const canAccess = await canAccessTargetPersonal(actorId, targetUserId, null);
        if (!canAccess) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const canCreateGlobal = await canEditBloqueos(actorId, targetUserId, null);
        const targetClinicIds = await getAccessibleClinicIdsForUser(targetUserId);

        let allowedClinicIds = [];
        if (isAdmin(actorId) || Number(actorId) === Number(targetUserId)) {
            allowedClinicIds = targetClinicIds;
        } else {
            const ownerClinicIds = await getOwnerClinicIdsForUser(actorId);
            const ownerSet = new Set(ownerClinicIds);
            allowedClinicIds = targetClinicIds.filter((id) => ownerSet.has(id));
        }

        return res.json({
            can_write_bloqueos: allowedClinicIds.length > 0 || !!canCreateGlobal,
            can_create_global_bloqueo: !!canCreateGlobal,
            allowed_clinic_ids_for_bloqueos: allowedClinicIds,
        });
    } catch (error) {
        console.error('[personal.getPersonalBloqueosPermissions] Error:', error);
        return res.status(500).json({ message: 'Error retrieving bloqueos permissions', error: error.message });
    }
};

exports.getPersonalBloqueosPermissionsForCurrent = async (req, res) => {
    req.params.id = String(req.userData?.userId || '');
    return exports.getPersonalBloqueosPermissions(req, res);
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
        const queryTimezone = Number.isFinite(clinicaId)
            ? await getClinicTimezoneById(clinicaId)
            : DEFAULT_TIMEZONE;
        const fromDate = buildDateTime(fromRaw, null, '00:00', queryTimezone);
        const toDate = buildDateTime(toRaw, null, '23:59', queryTimezone);

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

        const timezoneMap = await buildClinicTimezoneMap(rows.map((r) => r.clinica_id));
        return res.json(
            rows.map((row) => serializeBloqueo(row, timezoneForClinicId(row.clinica_id, timezoneMap)))
        );
    } catch (error) {
        console.error('[personal.getPersonalBloqueos] Error:', error);
        return res.status(500).json({ message: 'Error retrieving personal bloqueos', error: error.message });
    }
};

exports.getPersonalBloqueosForCurrent = async (req, res) => {
    req.params.id = String(req.userData?.userId || '');
    return exports.getPersonalBloqueos(req, res);
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
        const canEdit = await canEditBloqueos(actorId, targetUserId, clinicaId);
        if (!canEdit) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const horaInicio = normalizeHm(req.body?.hora_inicio);
        const horaFin = normalizeHm(req.body?.hora_fin);
        const fechaInicioInput = req.body?.fecha_inicio || req.body?.fecha;
        const fechaFinInput = req.body?.fecha_fin || req.body?.fecha;
        const clinicTimezone = clinicaId == null
            ? DEFAULT_TIMEZONE
            : await getClinicTimezoneById(clinicaId);

        const fechaInicio = buildDateTime(fechaInicioInput, horaInicio, '00:00', clinicTimezone);
        const fechaFin = buildDateTime(fechaFinInput, horaFin, '23:59', clinicTimezone);
        const tipo = normalizeBloqueoTipo(req.body?.tipo);

        if (!fechaInicio || !fechaFin) {
            return res.status(400).json({ message: 'fecha_inicio/fecha_fin inválidas' });
        }

        if (!tipo) {
            return res.status(400).json({
                message: 'tipo inválido',
                allowed: Array.from(BLOQUEO_TIPOS),
            });
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
            tipo,
            motivo: (req.body?.motivo || '').toString().slice(0, 255),
            recurrente: req.body?.recurrente || 'none',
            aplica_a_todas_clinicas: clinicaId == null ? true : false,
            creado_por: actorId,
        });

        const serialized = serializeBloqueo(bloqueo, clinicTimezone);

        return res.status(201).json(serialized);
    } catch (error) {
        console.error('[personal.createPersonalBloqueo] Error:', error);
        return res.status(500).json({ message: 'Error creating personal bloqueo', error: error.message });
    }
};

exports.createPersonalBloqueoForCurrent = async (req, res) => {
    req.params.id = String(req.userData?.userId || '');
    return exports.createPersonalBloqueo(req, res);
};

exports.updatePersonalBloqueo = async (req, res) => {
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

        // PATCH semantics:
        // - Si clinica_id/clinic_id NO viene en el body, conservar el valor actual del bloqueo.
        // - Si viene explícitamente como null/'' => bloqueo global (todas las clínicas).
        const body = req.body || {};
        const hasClinicaField =
            Object.prototype.hasOwnProperty.call(body, 'clinica_id') ||
            Object.prototype.hasOwnProperty.call(body, 'clinic_id');

        let clinicaId;
        if (hasClinicaField) {
            const clinicaIdRaw = body.clinica_id ?? body.clinic_id;
            clinicaId = (clinicaIdRaw === null || clinicaIdRaw === undefined || String(clinicaIdRaw).trim() === '')
                ? null
                : parseIntOrNull(clinicaIdRaw);
        } else {
            clinicaId = bloqueo.clinica_id ?? null;
        }

        const canEdit = await canEditBloqueos(actorId, targetUserId, clinicaId);
        if (!canEdit) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const clinicTimezone = clinicaId == null
            ? DEFAULT_TIMEZONE
            : await getClinicTimezoneById(clinicaId);

        // Preservar horas actuales si no se envían.
        const horaInicio = req.body?.hora_inicio !== undefined
            ? normalizeHm(req.body?.hora_inicio)
            : toHm(bloqueo.fecha_inicio, clinicTimezone);
        const horaFin = req.body?.hora_fin !== undefined
            ? normalizeHm(req.body?.hora_fin)
            : toHm(bloqueo.fecha_fin, clinicTimezone);

        if (req.body?.hora_inicio !== undefined && !horaInicio) {
            return res.status(400).json({ message: 'hora_inicio inválida' });
        }
        if (req.body?.hora_fin !== undefined && !horaFin) {
            return res.status(400).json({ message: 'hora_fin inválida' });
        }

        const fechaInicioInput = req.body?.fecha_inicio || req.body?.fecha || toDay(bloqueo.fecha_inicio, clinicTimezone);
        const fechaFinInput = req.body?.fecha_fin || req.body?.fecha || toDay(bloqueo.fecha_fin, clinicTimezone);

        const fechaInicio = buildDateTime(fechaInicioInput, horaInicio, '00:00', clinicTimezone);
        const fechaFin = buildDateTime(fechaFinInput, horaFin, '23:59', clinicTimezone);

        if (!fechaInicio || !fechaFin) {
            return res.status(400).json({ message: 'fecha_inicio/fecha_fin inválidas' });
        }
        if (fechaInicio >= fechaFin) {
            return res.status(400).json({ message: 'Rango inválido: fecha_fin debe ser mayor que fecha_inicio' });
        }

        const tipo = req.body?.tipo !== undefined
            ? normalizeBloqueoTipo(req.body?.tipo)
            : (normalizeBloqueoTipo(bloqueo.tipo) || 'ausencia');

        if (req.body?.tipo !== undefined && !tipo) {
            return res.status(400).json({
                message: 'tipo inválido',
                allowed: Array.from(BLOQUEO_TIPOS),
            });
        }

        // Evitar crear/editar bloqueos que oculten citas existentes.
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
                message: 'No se puede actualizar el bloqueo: hay citas en ese rango',
                reason: 'STAFF_HAS_APPOINTMENTS',
                cita_conflictiva: overlapCita,
            });
        }

        await bloqueo.update({
            clinica_id: clinicaId,
            fecha_inicio: fechaInicio,
            fecha_fin: fechaFin,
            tipo: tipo || 'ausencia',
            motivo: (req.body?.motivo ?? bloqueo.motivo ?? '').toString().slice(0, 255),
            recurrente: req.body?.recurrente ?? bloqueo.recurrente ?? 'none',
            aplica_a_todas_clinicas: clinicaId == null ? true : false,
        });

        return res.json(serializeBloqueo(bloqueo, clinicTimezone));
    } catch (error) {
        console.error('[personal.updatePersonalBloqueo] Error:', error);
        return res.status(500).json({ message: 'Error updating personal bloqueo', error: error.message });
    }
};

exports.updatePersonalBloqueoForCurrent = async (req, res) => {
    req.params.id = String(req.userData?.userId || '');
    return exports.updatePersonalBloqueo(req, res);
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

        const canEdit = await canEditBloqueos(actorId, targetUserId, bloqueo.clinica_id ?? null);
        if (!canEdit) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        await bloqueo.destroy();
        return res.status(204).end();
    } catch (error) {
        console.error('[personal.deletePersonalBloqueo] Error:', error);
        return res.status(500).json({ message: 'Error deleting personal bloqueo', error: error.message });
    }
};

exports.deletePersonalBloqueoForCurrent = async (req, res) => {
    req.params.id = String(req.userData?.userId || '');
    return exports.deletePersonalBloqueo(req, res);
};

// ────────────────────────────────────────────────────────────────
// Schedule / Horarios (canónico /api/personal/*)
// Persistencia actual: DoctorClinicas + DoctorHorarios (alias semántico "personal")
// ────────────────────────────────────────────────────────────────

function normalizeDiaSemana(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (n < 0 || n > 6) return null;
    return Math.trunc(n);
}

async function hasStaffPivot(userId, clinicId) {
    if (!Number.isFinite(Number(userId)) || !Number.isFinite(Number(clinicId))) return false;
    const row = await UsuarioClinica.findOne({
        where: {
            id_usuario: Number(userId),
            id_clinica: Number(clinicId),
            rol_clinica: { [Op.in]: ['propietario', 'personaldeclinica'] },
        },
        attributes: ['id_usuario'],
        raw: true,
    });
    return !!row;
}

async function isOwnerPivot(userId, clinicId) {
    if (!Number.isFinite(Number(userId)) || !Number.isFinite(Number(clinicId))) return false;
    const row = await UsuarioClinica.findOne({
        where: {
            id_usuario: Number(userId),
            id_clinica: Number(clinicId),
            rol_clinica: 'propietario',
        },
        attributes: ['id_usuario'],
        raw: true,
    });
    return !!row;
}

async function canEditHorarios(actorId, targetUserId, clinicId) {
    if (isAdmin(actorId)) return true;
    if (!Number.isFinite(Number(clinicId))) return false;

    // Un usuario puede editar sus propios horarios en clínicas donde trabaja
    if (Number(actorId) === Number(targetUserId)) {
        return hasStaffPivot(actorId, clinicId);
    }

    // Editar horarios de otros: solo propietario de la clínica (MVP; AccessPolicy granular va en Bloque 2)
    const actorIsOwner = await isOwnerPivot(actorId, clinicId);
    if (!actorIsOwner) return false;

    // Evitar generar schedules "huérfanos" en clínicas donde el usuario no pertenece
    return hasStaffPivot(targetUserId, clinicId);
}

async function getOwnerClinicIdsForUser(userId) {
    if (!Number.isFinite(Number(userId))) return [];
    const rows = await UsuarioClinica.findAll({
        where: {
            id_usuario: Number(userId),
            rol_clinica: 'propietario',
        },
        attributes: ['id_clinica'],
        raw: true,
    });
    return rows
        .map((r) => Number(r.id_clinica))
        .filter((id) => Number.isFinite(id));
}

async function canEditBloqueos(actorId, targetUserId, clinicaId) {
    if (isAdmin(actorId)) return true;

    // Self: puede gestionar sus bloqueos. Si clinica_id es específico, debe pertenecer a esa clínica.
    if (Number(actorId) === Number(targetUserId)) {
        if (clinicaId != null && Number.isFinite(Number(clinicaId))) {
            return hasStaffPivot(actorId, Number(clinicaId));
        }
        return true;
    }

    const ownerClinicIds = await getOwnerClinicIdsForUser(actorId);
    if (!ownerClinicIds.length) return false;

    // Bloqueo global (clinica_id=null): permitir solo si el actor es propietario de *todas* las clínicas
    // donde el usuario objetivo trabaja (evita bloquear en clínicas ajenas).
    if (clinicaId == null) {
        const targetClinicIds = await getAccessibleClinicIdsForUser(targetUserId);
        if (!targetClinicIds.length) return false;
        const ownerSet = new Set(ownerClinicIds);
        return targetClinicIds.every((id) => ownerSet.has(id));
    }

    const cid = Number(clinicaId);
    if (!Number.isFinite(cid)) return false;
    if (!ownerClinicIds.includes(cid)) return false;

    // Evitar bloqueos huérfanos: el usuario objetivo debe pertenecer a la clínica.
    return hasStaffPivot(targetUserId, cid);
}

function normalizeHorarioRows(body) {
    const rows = Array.isArray(body)
        ? body
        : (Array.isArray(body?.horarios) ? body.horarios : []);

    const out = [];
    for (const r of rows) {
        const dia = normalizeDiaSemana(r?.dia_semana);
        const inicio = normalizeHm(r?.hora_inicio);
        const fin = normalizeHm(r?.hora_fin);
        if (dia == null || !inicio || !fin) continue;
        if (inicio >= fin) continue;
        out.push({
            dia_semana: dia,
            hora_inicio: inicio,
            hora_fin: fin,
            activo: r?.activo === false ? false : true,
        });
    }
    return out;
}

async function getAllowedClinicIdsForActorTarget(actorId, targetUserId) {
    const targetClinicIds = await getAccessibleClinicIdsForUser(targetUserId);
    if (isAdmin(actorId) || Number(actorId) === Number(targetUserId)) {
        return targetClinicIds;
    }

    const actorClinicIds = await getAccessibleClinicIdsForUser(actorId);
    const actorSet = new Set(actorClinicIds);
    return targetClinicIds.filter((id) => actorSet.has(id));
}

async function buildScheduleResponse(actorId, targetUserId) {
    const user = await Usuario.findByPk(targetUserId, {
        attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario'],
        raw: true,
    });

    const allowedClinicIds = await getAllowedClinicIdsForActorTarget(actorId, targetUserId);

    const clinicas = allowedClinicIds.length
        ? await DoctorClinica.findAll({
            where: {
                doctor_id: targetUserId,
                clinica_id: { [Op.in]: allowedClinicIds },
                activo: true,
            },
            include: [
                { model: Clinica, as: 'clinica', attributes: ['id_clinica', 'nombre_clinica', 'url_avatar'] },
                { model: DoctorHorario, as: 'horarios' },
            ],
            order: [['clinica_id', 'ASC']],
        })
        : [];

    // Bloqueos: limitar a las clínicas visibles (o global) cuando no es admin / self
    const bloqueosWhere = { doctor_id: targetUserId };
    if (!isAdmin(actorId) && Number(actorId) !== Number(targetUserId) && allowedClinicIds.length) {
        bloqueosWhere[Op.or] = [
            { clinica_id: null },
            { clinica_id: { [Op.in]: allowedClinicIds } },
        ];
    }

    const bloqueos = await DoctorBloqueo.findAll({
        where: bloqueosWhere,
        order: [['fecha_inicio', 'ASC']],
    });
    const timezoneMap = await buildClinicTimezoneMap(bloqueos.map((b) => b.clinica_id));

    return {
        doctor_id: String(targetUserId),
        doctor_nombre: user ? `${user.nombre || ''} ${user.apellidos || ''}`.trim() : '',
        clinicas: clinicas.map((c) => ({
            clinica_id: c.clinica_id,
            nombre_clinica: c.clinica?.nombre_clinica || '',
            url_avatar: c.clinica?.url_avatar || null,
            activo: !!c.activo,
            modo_disponibilidad: c.modo_disponibilidad || 'avanzado',
            horarios: c.horarios || [],
        })),
        bloqueos: bloqueos.map((b) => serializeBloqueo(b, timezoneForClinicId(b.clinica_id, timezoneMap))),
    };
}

exports.getScheduleForCurrent = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const schedule = await buildScheduleResponse(actorId, actorId);
        return res.json(schedule);
    } catch (error) {
        console.error('[personal.getScheduleForCurrent] Error:', error);
        return res.status(500).json({ message: 'Error retrieving personal schedule', error: error.message });
    }
};

exports.getScheduleForPersonal = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const targetUserId = Number(req.params.id);
        if (!Number.isFinite(targetUserId)) {
            return res.status(400).json({ message: 'Invalid id' });
        }

        const canAccess = await canAccessTargetPersonal(actorId, targetUserId, null);
        if (!canAccess) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const schedule = await buildScheduleResponse(actorId, targetUserId);
        return res.json(schedule);
    } catch (error) {
        console.error('[personal.getScheduleForPersonal] Error:', error);
        return res.status(500).json({ message: 'Error retrieving personal schedule', error: error.message });
    }
};

async function getHorariosFor(targetUserId, clinicId) {
    const dc = await DoctorClinica.findOne({
        where: {
            doctor_id: targetUserId,
            clinica_id: clinicId,
        },
        attributes: ['id', 'doctor_id', 'clinica_id', 'activo'],
        raw: true,
    });

    if (!dc) {
        return { doctor_clinica_id: null, horarios: [] };
    }

    const horarios = await DoctorHorario.findAll({
        where: { doctor_clinica_id: dc.id },
        order: [['dia_semana', 'ASC'], ['hora_inicio', 'ASC']],
    });

    return { doctor_clinica_id: dc.id, horarios };
}

exports.getHorariosClinicaForCurrent = async (req, res) => {
    req.params.id = String(req.userData?.userId || '');
    return exports.getHorariosClinica(req, res);
};

exports.getHorariosClinica = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const targetUserId = Number(req.params.id);
        const clinicaId = Number(req.params.clinicaId);
        if (!Number.isFinite(targetUserId) || !Number.isFinite(clinicaId)) {
            return res.status(400).json({ message: 'Invalid id' });
        }

        const canAccess = await canAccessTargetPersonal(actorId, targetUserId, clinicaId);
        if (!canAccess) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const data = await getHorariosFor(targetUserId, clinicaId);
        return res.json(data);
    } catch (error) {
        console.error('[personal.getHorariosClinica] Error:', error);
        return res.status(500).json({ message: 'Error retrieving horarios', error: error.message });
    }
};

exports.updateHorariosClinicaForCurrent = async (req, res) => {
    req.params.id = String(req.userData?.userId || '');
    return exports.updateHorariosClinica(req, res);
};

exports.updateHorariosClinica = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const targetUserId = Number(req.params.id);
        const clinicaId = Number(req.params.clinicaId);
        if (!Number.isFinite(targetUserId) || !Number.isFinite(clinicaId)) {
            return res.status(400).json({ message: 'Invalid id' });
        }

        const canEdit = await canEditHorarios(actorId, targetUserId, clinicaId);
        if (!canEdit) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const horarios = normalizeHorarioRows(req.body);
        if (!horarios.length && Array.isArray(req.body?.horarios) && req.body.horarios.length) {
            return res.status(400).json({ message: 'horarios inválidos' });
        }

        let dc = await DoctorClinica.findOne({
            where: { doctor_id: targetUserId, clinica_id: clinicaId },
        });

        if (!dc) {
            dc = await DoctorClinica.create({
                doctor_id: targetUserId,
                clinica_id: clinicaId,
                activo: true,
            });
        } else if (!dc.activo) {
            dc.activo = true;
            await dc.save();
        }

        await DoctorHorario.destroy({ where: { doctor_clinica_id: dc.id } });
        const created = await DoctorHorario.bulkCreate(
            horarios.map((h) => ({ ...h, doctor_clinica_id: dc.id })),
        );

        return res.json(created);
    } catch (error) {
        console.error('[personal.updateHorariosClinica] Error:', error);
        return res.status(500).json({ message: 'Error updating horarios', error: error.message });
    }
};

exports.updateModoDisponibilidadClinicaForCurrent = async (req, res) => {
    req.params.id = String(req.userData?.userId || '');
    return exports.updateModoDisponibilidadClinica(req, res);
};

exports.updateModoDisponibilidadClinica = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const targetUserId = Number(req.params.id);
        const clinicaId = Number(req.params.clinicaId);
        if (!Number.isFinite(targetUserId) || !Number.isFinite(clinicaId)) {
            return res.status(400).json({ message: 'Invalid id' });
        }

        const modo = normalizeModoDisponibilidad(req.body?.modo_disponibilidad ?? req.body?.modo);
        if (!modo) {
            return res.status(400).json({
                message: 'modo_disponibilidad inválido',
                allowed: Array.from(MODO_DISPONIBILIDAD),
            });
        }

        // Reglas MVP: same gate as horarios (self in clinic, or owner/admin for others).
        const canEdit = await canEditHorarios(actorId, targetUserId, clinicaId);
        if (!canEdit) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        let dc = await DoctorClinica.findOne({
            where: { doctor_id: targetUserId, clinica_id: clinicaId },
        });

        if (!dc) {
            dc = await DoctorClinica.create({
                doctor_id: targetUserId,
                clinica_id: clinicaId,
                activo: true,
                modo_disponibilidad: modo,
            });
        } else {
            dc.modo_disponibilidad = modo;
            if (!dc.activo) {
                dc.activo = true;
            }
            await dc.save();
        }

        return res.json({
            id: dc.id,
            doctor_id: dc.doctor_id,
            clinica_id: dc.clinica_id,
            activo: !!dc.activo,
            modo_disponibilidad: dc.modo_disponibilidad || 'avanzado',
        });
    } catch (error) {
        console.error('[personal.updateModoDisponibilidadClinica] Error:', error);
        return res.status(500).json({ message: 'Error updating modo_disponibilidad', error: error.message });
    }
};

// Wrapper: /api/personal/:id/horarios?clinica_id=...
exports.getHorarios = async (req, res) => {
    try {
        const clinicaId = parseIntOrNull(req.query?.clinica_id ?? req.query?.clinic_id);
        if (!Number.isFinite(clinicaId)) {
            return res.status(400).json({ message: 'clinica_id is required' });
        }
        req.params.clinicaId = String(clinicaId);
        return exports.getHorariosClinica(req, res);
    } catch (error) {
        console.error('[personal.getHorarios] Error:', error);
        return res.status(500).json({ message: 'Error retrieving horarios', error: error.message });
    }
};

exports.updateHorarios = async (req, res) => {
    try {
        const clinicaId = parseIntOrNull(req.query?.clinica_id ?? req.query?.clinic_id);
        if (!Number.isFinite(clinicaId)) {
            return res.status(400).json({ message: 'clinica_id is required' });
        }
        req.params.clinicaId = String(clinicaId);
        return exports.updateHorariosClinica(req, res);
    } catch (error) {
        console.error('[personal.updateHorarios] Error:', error);
        return res.status(500).json({ message: 'Error updating horarios', error: error.message });
    }
};
