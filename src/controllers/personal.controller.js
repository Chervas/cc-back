const { Op, fn, col, where } = require('sequelize');
const { Usuario, Clinica, UsuarioClinica, DoctorClinica, DoctorHorario, DoctorBloqueo, CitaPaciente, sequelize } = require('../../models');
const bcrypt = require('bcryptjs');
const {
    ADMIN_USER_IDS,
    STAFF_ROLES,
    ADMIN_ROLES,
    INVITABLE_ROLES,
    ROLES_CLINICA: ROLES_CLINICA_ARR,
    SUBROLES_CLINICA: SUBROLES_CLINICA_ARR,
    ESTADO_CUENTA: ESTADO_CUENTA_ARR,
    ESTADO_INVITACION: ESTADO_INVITACION_ARR,
    isGlobalAdmin,
    isStaffRole,
    isAdminRole,
    canManagePersonal: canManagePersonalHelper,
} = require('../lib/role-helpers');

const DEFAULT_TIMEZONE = 'Europe/Madrid';
// Nota: columna DoctorBloqueos.tipo es STRING(32) (sin ENUM). Mantener lista alineada con el front.
const BLOQUEO_TIPOS = new Set(['vacaciones', 'enfermedad', 'ausencia', 'formacion', 'congreso', 'otro']);
const MODO_DISPONIBILIDAD = new Set(['avanzado', 'basico']);
const ESTADO_CUENTA = new Set(ESTADO_CUENTA_ARR);
const ESTADO_INVITACION = new Set(ESTADO_INVITACION_ARR);
const ROLES_CLINICA = new Set(ROLES_CLINICA_ARR);
const SUBROLES_CLINICA = new Set(SUBROLES_CLINICA_ARR);
const INVITE_RESEND_COOLDOWN_HOURS = Math.max(1, Number(process.env.INVITE_RESEND_COOLDOWN_HOURS || 4));
const INVITE_RESEND_COOLDOWN_MS = INVITE_RESEND_COOLDOWN_HOURS * 60 * 60 * 1000;

const isAdmin = (userId) => isGlobalAdmin(userId);
const ACTIVE_STAFF_INVITATION_WHERE = {
    [Op.or]: [
        { estado_invitacion: 'aceptada' },
        { estado_invitacion: null },
    ],
};

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
            rol_clinica: { [Op.in]: STAFF_ROLES },
            ...ACTIVE_STAFF_INVITATION_WHERE,
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

function normalizeEmail(value) {
    if (value == null) return null;
    const email = String(value).trim().toLowerCase();
    if (!email || !email.includes('@')) return null;
    return email;
}

function normalizePhone(value) {
    if (value == null) return null;
    const digits = String(value).replace(/[^\d+]/g, '');
    return digits || null;
}

function normalizeTrimmed(value) {
    if (value == null) return null;
    const s = String(value).trim();
    return s || null;
}

function escapeLike(value) {
    return String(value).replace(/[\\%_]/g, '\\$&');
}

function escapeJsonString(value) {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function maskEmail(value) {
    const email = normalizeEmail(value);
    if (!email) return null;
    const [local, domain] = email.split('@');
    if (!local || !domain) return null;
    if (local.length <= 2) {
        return `${local[0] || '*'}***@${domain}`;
    }
    return `${local[0]}***${local[local.length - 1]}@${domain}`;
}

function maskPhone(value) {
    const phone = normalizePhone(value);
    if (!phone) return null;
    if (phone.length <= 4) return `***${phone.slice(-2)}`;
    return `${phone.slice(0, 2)}***${phone.slice(-2)}`;
}

function normalizeRolClinica(value, defaultValue = 'personaldeclinica') {
    if (value == null || String(value).trim() === '') {
        return defaultValue;
    }
    const rol = String(value).trim();
    if (!ROLES_CLINICA.has(rol)) return null;
    return rol;
}

function normalizeSubrolClinica(value) {
    if (value == null || String(value).trim() === '') {
        return null;
    }
    const subrol = String(value).trim();
    if (!SUBROLES_CLINICA.has(subrol)) return null;
    return subrol;
}

function normalizeEstadoCuenta(value, defaultValue = 'activo') {
    if (value == null || String(value).trim() === '') {
        return defaultValue;
    }
    const estado = String(value).trim().toLowerCase();
    if (!ESTADO_CUENTA.has(estado)) return null;
    return estado;
}

function normalizeEstadoInvitacion(value, defaultValue = 'aceptada') {
    if (value == null || String(value).trim() === '') {
        return defaultValue;
    }
    const estado = String(value).trim().toLowerCase();
    if (!ESTADO_INVITACION.has(estado)) return null;
    return estado;
}

function getInviteResendRemainingMs(lastInvitedAt, now = new Date()) {
    if (!lastInvitedAt) return 0;
    const last = new Date(lastInvitedAt);
    if (!Number.isFinite(last.getTime())) return 0;
    const elapsed = now.getTime() - last.getTime();
    return Math.max(0, INVITE_RESEND_COOLDOWN_MS - elapsed);
}

function formatCooldownWindowLabel(ms) {
    const totalMinutes = Math.max(1, Math.ceil(ms / 60000));
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    if (hours <= 0) return `${minutes} min`;
    if (minutes <= 0) return `${hours} h`;
    return `${hours} h ${minutes} min`;
}

function defaultModoDisponibilidadFromSubrol(subrolClinica) {
    return subrolClinica === 'Doctores' ? 'avanzado' : 'basico';
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

async function canManagePersonalInClinic(actorId, clinicaId) {
    if (isAdmin(actorId)) return true;
    return hasAdminScopePivot(actorId, clinicaId);
}

function invitationStateRank(value) {
    const estado = normalizeEstadoInvitacion(value, 'aceptada');
    if (estado === 'aceptada') return 4;
    if (estado === 'pendiente') return 3;
    if (estado === 'rechazada') return 2;
    if (estado === 'cancelada') return 1;
    return 0;
}

function pickBetterInvitationState(a, b) {
    return invitationStateRank(a) >= invitationStateRank(b) ? a : b;
}

function roleRank(value) {
    if (value === 'propietario') return 3;
    if (value === 'agencia') return 3;
    if (value === 'personaldeclinica') return 2;
    if (value === 'paciente') return 1;
    return 0;
}

function pickBetterRole(a, b) {
    return roleRank(a) >= roleRank(b) ? a : b;
}

async function actorCanMergeUsers(actorId, primaryUserId, secondaryUserId) {
    if (isAdmin(actorId)) return true;
    const agencyClinicIds = await getAgencyClinicIdsForUser(actorId);
    if (!agencyClinicIds.length) return false;
    const agencySet = new Set(agencyClinicIds);

    const rows = await UsuarioClinica.findAll({
        where: {
            id_usuario: { [Op.in]: [Number(primaryUserId), Number(secondaryUserId)] },
            rol_clinica: { [Op.in]: STAFF_ROLES },
            ...ACTIVE_STAFF_INVITATION_WHERE,
        },
        attributes: ['id_clinica'],
        raw: true,
    });
    const neededClinicIds = Array.from(new Set(
        rows
            .map((r) => Number(r.id_clinica))
            .filter((id) => Number.isFinite(id))
    ));
    if (!neededClinicIds.length) {
        return false;
    }
    return neededClinicIds.every((id) => agencySet.has(id));
}

async function findUserByEmailIncludingAlternatives(email) {
    const normalized = normalizeEmail(email);
    if (!normalized) return null;

    const altLike = `%"${escapeJsonString(normalized)}%"`;
    return Usuario.findOne({
        where: {
            [Op.or]: [
                { email_usuario: normalized },
                { emails_alternativos: { [Op.like]: altLike } },
            ],
        },
    });
}

async function ensureDoctorClinicaRow({
    userId,
    clinicaId,
    subrolClinica,
    activo,
}) {
    const doctorClinica = await DoctorClinica.findOne({
        where: {
            doctor_id: Number(userId),
            clinica_id: Number(clinicaId),
        },
    });

    const modo = defaultModoDisponibilidadFromSubrol(subrolClinica);
    const rolEnClinica = normalizeTrimmed(subrolClinica) || 'personal';

    if (!doctorClinica) {
        await DoctorClinica.create({
            doctor_id: Number(userId),
            clinica_id: Number(clinicaId),
            rol_en_clinica: rolEnClinica,
            modo_disponibilidad: modo,
            activo: !!activo,
        });
        return;
    }

    doctorClinica.rol_en_clinica = rolEnClinica;
    doctorClinica.modo_disponibilidad = doctorClinica.modo_disponibilidad || modo;
    doctorClinica.activo = !!activo;
    await doctorClinica.save();
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
            rol_clinica: { [Op.in]: STAFF_ROLES },
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
                        attributes: ['rol_clinica', 'subrol_clinica', 'estado_invitacion'],
                        where: {
                            rol_clinica: { [Op.in]: STAFF_ROLES },
                            ...ACTIVE_STAFF_INVITATION_WHERE,
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
                        attributes: ['rol_clinica', 'subrol_clinica', 'estado_invitacion'],
                        where: {
                            rol_clinica: { [Op.in]: STAFF_ROLES },
                            ...ACTIVE_STAFF_INVITATION_WHERE,
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
                ...ACTIVE_STAFF_INVITATION_WHERE,
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
                    rol_clinica: { [Op.in]: STAFF_ROLES },
                    ...ACTIVE_STAFF_INVITATION_WHERE,
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
// Onboarding: búsqueda / invitación / reclamación
// ────────────────────────────────────────────────────────────────

// Compat legacy: /api/personal/search
exports.searchPersonal = async (req, res) => {
    try {
        const body = req.body || {};
        const actorId = Number(req.userData?.userId);

        let clinicaId = parseIntOrNull(body.clinica_id ?? body.id_clinica ?? body.clinic_id);
        if (!Number.isFinite(clinicaId) && Number.isFinite(actorId)) {
            const clinicIds = await getAccessibleClinicIdsForUser(actorId);
            clinicaId = clinicIds[0] || null;
        }

        const query = normalizeTrimmed(
            body.query
            || body.q
            || body.email
            || body.email_usuario
            || body.telefono
            || [body.nombre, body.apellidos].filter(Boolean).join(' '),
        );

        req.body = {
            ...body,
            query,
            clinica_id: clinicaId,
        };

        return exports.buscarPersonal(req, res);
    } catch (error) {
        console.error('[personal.searchPersonal.compat] Error:', error);
        return res.status(500).json({ message: 'Error searching personal', error: error.message });
    }
};

// Compat legacy: /api/personal/invite
exports.invitePersonal = async (req, res) => {
    try {
        const body = req.body || {};
        const idUsuario = parseIntOrNull(body.id_usuario ?? body.usuario_id ?? body.user_id);

        req.body = {
            ...body,
            clinica_id: parseIntOrNull(body.clinica_id ?? body.id_clinica ?? body.clinic_id),
            id_usuario: Number.isFinite(idUsuario) ? idUsuario : undefined,
            email_usuario: body.email_usuario ?? body.email,
        };

        return exports.invitarPersonal(req, res);
    } catch (error) {
        console.error('[personal.invitePersonal.compat] Error:', error);
        return res.status(500).json({ message: 'Error inviting personal', error: error.message });
    }
};

exports.claimProvisionalAccount = async (req, res) => {
    try {
        const email = normalizeEmail(req.body?.email_usuario ?? req.body?.email);
        const requestedUserId = parseIntOrNull(req.body?.id_usuario ?? req.body?.usuario_id ?? req.body?.user_id);
        const password = String(req.body?.password || '').trim();

        if (!email || password.length < 8) {
            return res.status(400).json({
                message: 'email and password (min 8 chars) are required',
            });
        }

        const user = await findUserByEmailIncludingAlternatives(email);
        if (!user) {
            return res.status(404).json({ message: 'User not found' });
        }

        if (Number.isFinite(requestedUserId) && Number(requestedUserId) !== Number(user.id_usuario)) {
            return res.status(403).json({ message: 'User mismatch for claim request' });
        }

        const estadoCuenta = normalizeEstadoCuenta(user.estado_cuenta, 'activo');
        if (estadoCuenta !== 'provisional') {
            return res.status(409).json({
                message: 'Account is not provisional',
                code: 'account_not_provisional',
            });
        }

        user.password_usuario = await bcrypt.hash(password, 8);
        user.estado_cuenta = 'activo';
        user.ultimo_login = new Date();
        await user.save({ fields: ['password_usuario', 'estado_cuenta', 'ultimo_login'] });

        return res.status(200).json({
            message: 'Account claimed successfully',
            user: {
                id_usuario: Number(user.id_usuario),
                estado_cuenta: 'activo',
            },
        });
    } catch (error) {
        console.error('[personal.claimProvisionalAccount] Error:', error);
        return res.status(500).json({ message: 'Error claiming provisional account', error: error.message });
    }
};

exports.getMyInvitations = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const rows = await UsuarioClinica.findAll({
            where: {
                id_usuario: actorId,
                estado_invitacion: 'pendiente',
                rol_clinica: { [Op.in]: STAFF_ROLES },
            },
            attributes: [
                'id_usuario',
                'id_clinica',
                'rol_clinica',
                'subrol_clinica',
                'estado_invitacion',
                'invitado_por',
                'fecha_invitacion',
            ],
            include: [
                {
                    model: Clinica,
                    as: 'Clinica',
                    required: false,
                    attributes: ['id_clinica', 'nombre_clinica', 'url_avatar'],
                },
                {
                    model: Usuario,
                    as: 'Invitador',
                    required: false,
                    attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario', 'avatar'],
                },
            ],
            order: [['fecha_invitacion', 'DESC']],
        });

        return res.json({
            items: rows.map((row) => ({
                id_usuario: Number(row.id_usuario),
                clinica_id: Number(row.id_clinica),
                clinica_nombre: row.Clinica?.nombre_clinica || '',
                clinica_avatar: row.Clinica?.url_avatar || null,
                rol_clinica: row.rol_clinica,
                subrol_clinica: row.subrol_clinica || null,
                estado_invitacion: normalizeEstadoInvitacion(row.estado_invitacion, 'pendiente') || 'pendiente',
                fecha_invitacion: row.fecha_invitacion || null,
                invitado_por: row.invitado_por ? Number(row.invitado_por) : null,
                invitador: row.Invitador
                    ? {
                        id_usuario: Number(row.Invitador.id_usuario),
                        nombre: row.Invitador.nombre || '',
                        apellidos: row.Invitador.apellidos || '',
                        email_masked: maskEmail(row.Invitador.email_usuario),
                        avatar: row.Invitador.avatar || null,
                    }
                    : null,
            })),
        });
    } catch (error) {
        console.error('[personal.getMyInvitations] Error:', error);
        return res.status(500).json({ message: 'Error retrieving invitations', error: error.message });
    }
};

exports.acceptMyInvitation = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const clinicaId = parseIntOrNull(req.params?.clinicaId);
        if (!Number.isFinite(clinicaId)) {
            return res.status(400).json({ message: 'Invalid clinicaId' });
        }

        const pivot = await UsuarioClinica.findOne({
            where: {
                id_usuario: actorId,
                id_clinica: clinicaId,
            },
        });
        if (!pivot) {
            return res.status(404).json({ message: 'Invitation not found' });
        }

        const estado = normalizeEstadoInvitacion(pivot.estado_invitacion, 'aceptada');
        if (estado !== 'pendiente' && estado !== 'rechazada') {
            return res.status(409).json({
                message: `Invitation is in state "${estado}" and cannot be accepted`,
                code: 'invitation_invalid_state',
            });
        }

        pivot.estado_invitacion = 'aceptada';
        await pivot.save({ fields: ['estado_invitacion', 'updated_at'] });

        await ensureDoctorClinicaRow({
            userId: actorId,
            clinicaId,
            subrolClinica: pivot.subrol_clinica,
            activo: true,
        });

        return res.status(200).json({
            message: 'Invitation accepted',
            clinica_id: clinicaId,
            estado_invitacion: 'aceptada',
        });
    } catch (error) {
        console.error('[personal.acceptMyInvitation] Error:', error);
        return res.status(500).json({ message: 'Error accepting invitation', error: error.message });
    }
};

exports.rejectMyInvitation = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const clinicaId = parseIntOrNull(req.params?.clinicaId);
        if (!Number.isFinite(clinicaId)) {
            return res.status(400).json({ message: 'Invalid clinicaId' });
        }

        const pivot = await UsuarioClinica.findOne({
            where: {
                id_usuario: actorId,
                id_clinica: clinicaId,
            },
        });
        if (!pivot) {
            return res.status(404).json({ message: 'Invitation not found' });
        }

        const estado = normalizeEstadoInvitacion(pivot.estado_invitacion, 'aceptada');
        if (estado !== 'pendiente') {
            return res.status(409).json({
                message: `Invitation is in state "${estado}" and cannot be rejected`,
                code: 'invitation_invalid_state',
            });
        }

        pivot.estado_invitacion = 'rechazada';
        await pivot.save({ fields: ['estado_invitacion', 'updated_at'] });

        const doctorClinica = await DoctorClinica.findOne({
            where: {
                doctor_id: actorId,
                clinica_id: clinicaId,
            },
        });
        if (doctorClinica) {
            doctorClinica.activo = false;
            await doctorClinica.save({ fields: ['activo', 'updated_at'] });
        }

        return res.status(200).json({
            message: 'Invitation rejected',
            clinica_id: clinicaId,
            estado_invitacion: 'rechazada',
        });
    } catch (error) {
        console.error('[personal.rejectMyInvitation] Error:', error);
        return res.status(500).json({ message: 'Error rejecting invitation', error: error.message });
    }
};

exports.cancelInvitation = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const targetUserId = parseIntOrNull(req.params?.id);
        const clinicaId = parseIntOrNull(req.params?.clinicaId);
        if (!Number.isFinite(targetUserId) || !Number.isFinite(clinicaId)) {
            return res.status(400).json({ message: 'Invalid params' });
        }

        const canManage = await canManagePersonalInClinic(actorId, clinicaId);
        if (!canManage) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const pivot = await UsuarioClinica.findOne({
            where: {
                id_usuario: targetUserId,
                id_clinica: clinicaId,
            },
        });
        if (!pivot) {
            return res.status(404).json({ message: 'Invitation not found' });
        }

        const estado = normalizeEstadoInvitacion(pivot.estado_invitacion, 'aceptada');
        if (estado !== 'pendiente') {
            return res.status(409).json({
                message: `Invitation is in state "${estado}" and cannot be cancelled`,
                code: 'invitation_invalid_state',
            });
        }

        pivot.estado_invitacion = 'cancelada';
        await pivot.save({ fields: ['estado_invitacion', 'updated_at'] });

        const doctorClinica = await DoctorClinica.findOne({
            where: {
                doctor_id: targetUserId,
                clinica_id: clinicaId,
            },
        });
        if (doctorClinica) {
            doctorClinica.activo = false;
            await doctorClinica.save({ fields: ['activo', 'updated_at'] });
        }

        return res.status(200).json({
            message: 'Invitation cancelled',
            id_usuario: targetUserId,
            clinica_id: clinicaId,
            estado_invitacion: 'cancelada',
        });
    } catch (error) {
        console.error('[personal.cancelInvitation] Error:', error);
        return res.status(500).json({ message: 'Error cancelling invitation', error: error.message });
    }
};

exports.removeClinicCollaboration = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            await transaction.rollback();
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const targetUserId = parseIntOrNull(req.params?.id);
        const clinicaId = parseIntOrNull(req.params?.clinicaId);
        if (!Number.isFinite(targetUserId) || !Number.isFinite(clinicaId)) {
            await transaction.rollback();
            return res.status(400).json({ message: 'Invalid params' });
        }

        const canManage = await canManagePersonalInClinic(actorId, clinicaId);
        if (!canManage) {
            await transaction.rollback();
            return res.status(403).json({ message: 'Forbidden' });
        }

        // Evita que owner/agencia se desvinculen a sí mismos por accidente en UI.
        if (!isAdmin(actorId) && Number(actorId) === Number(targetUserId)) {
            await transaction.rollback();
            return res.status(409).json({
                message: 'No puedes eliminar tu propia colaboración desde esta acción.',
                code: 'self_unlink_forbidden',
            });
        }

        const pivot = await UsuarioClinica.findOne({
            where: {
                id_usuario: targetUserId,
                id_clinica: clinicaId,
                rol_clinica: { [Op.in]: STAFF_ROLES },
            },
            transaction,
        });

        if (!pivot) {
            await transaction.rollback();
            return res.status(404).json({ message: 'Collaboration not found' });
        }

        const doctorClinicaRows = await DoctorClinica.findAll({
            where: { doctor_id: targetUserId, clinica_id: clinicaId },
            attributes: ['id'],
            transaction,
        });
        const doctorClinicaIds = doctorClinicaRows.map((row) => Number(row.id)).filter((id) => Number.isFinite(id));

        if (doctorClinicaIds.length) {
            await DoctorHorario.destroy({
                where: { doctor_clinica_id: { [Op.in]: doctorClinicaIds } },
                transaction,
            });
        }

        await DoctorClinica.destroy({
            where: { doctor_id: targetUserId, clinica_id: clinicaId },
            transaction,
        });

        // Limpiar bloqueos scoped a la clínica removida.
        await DoctorBloqueo.destroy({
            where: { doctor_id: targetUserId, clinica_id: clinicaId },
            transaction,
        });

        await pivot.destroy({ transaction });

        await transaction.commit();
        return res.status(200).json({
            message: 'Collaboration removed successfully',
            id_usuario: targetUserId,
            clinica_id: clinicaId,
        });
    } catch (error) {
        await transaction.rollback();
        console.error('[personal.removeClinicCollaboration] Error:', error);
        return res.status(500).json({ message: 'Error removing clinic collaboration', error: error.message });
    }
};

exports.mergePersonalAccounts = async (req, res) => {
    const transaction = await sequelize.transaction();
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            await transaction.rollback();
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const principalUserId = parseIntOrNull(req.body?.principal_user_id);
        const secondaryUserId = parseIntOrNull(req.body?.secondary_user_id);

        if (!Number.isFinite(principalUserId) || !Number.isFinite(secondaryUserId) || principalUserId === secondaryUserId) {
            await transaction.rollback();
            return res.status(400).json({ message: 'principal_user_id and secondary_user_id are required and must be different' });
        }

        const canMerge = await actorCanMergeUsers(actorId, principalUserId, secondaryUserId);
        if (!canMerge) {
            await transaction.rollback();
            return res.status(403).json({ message: 'Forbidden' });
        }

        const [principal, secondary] = await Promise.all([
            Usuario.findByPk(principalUserId, { transaction }),
            Usuario.findByPk(secondaryUserId, { transaction }),
        ]);
        if (!principal || !secondary) {
            await transaction.rollback();
            return res.status(404).json({ message: 'One or both users not found' });
        }

        const secondaryPivotRows = await UsuarioClinica.findAll({
            where: { id_usuario: secondaryUserId },
            transaction,
        });
        for (const row of secondaryPivotRows) {
            const existing = await UsuarioClinica.findOne({
                where: {
                    id_usuario: principalUserId,
                    id_clinica: row.id_clinica,
                },
                transaction,
            });

            if (!existing) {
                row.id_usuario = principalUserId;
                await row.save({ transaction });
                continue;
            }

            existing.rol_clinica = pickBetterRole(existing.rol_clinica, row.rol_clinica);
            existing.subrol_clinica = existing.subrol_clinica || row.subrol_clinica || null;
            existing.estado_invitacion = pickBetterInvitationState(existing.estado_invitacion, row.estado_invitacion);
            existing.invitado_por = existing.invitado_por || row.invitado_por || null;
            existing.fecha_invitacion = existing.fecha_invitacion || row.fecha_invitacion || null;
            await existing.save({ transaction });
            await row.destroy({ transaction });
        }

        const secondaryDoctorClinicas = await DoctorClinica.findAll({
            where: { doctor_id: secondaryUserId },
            transaction,
        });
        for (const row of secondaryDoctorClinicas) {
            const existing = await DoctorClinica.findOne({
                where: {
                    doctor_id: principalUserId,
                    clinica_id: row.clinica_id,
                },
                transaction,
            });

            if (!existing) {
                row.doctor_id = principalUserId;
                await row.save({ transaction });
                continue;
            }

            await DoctorHorario.update(
                { doctor_clinica_id: existing.id },
                {
                    where: { doctor_clinica_id: row.id },
                    transaction,
                }
            );

            existing.activo = !!(existing.activo || row.activo);
            existing.modo_disponibilidad = existing.modo_disponibilidad || row.modo_disponibilidad || 'avanzado';
            existing.rol_en_clinica = existing.rol_en_clinica || row.rol_en_clinica || null;
            await existing.save({ transaction });

            await row.destroy({ transaction });
        }

        await DoctorBloqueo.update(
            { doctor_id: principalUserId },
            {
                where: { doctor_id: secondaryUserId },
                transaction,
            }
        );

        await CitaPaciente.update(
            { doctor_id: principalUserId },
            {
                where: { doctor_id: secondaryUserId },
                transaction,
            }
        );

        const principalAlt = Array.isArray(principal.emails_alternativos)
            ? principal.emails_alternativos.map((e) => normalizeEmail(e)).filter(Boolean)
            : [];
        const extraEmails = [secondary.email_usuario]
            .concat(Array.isArray(secondary.emails_alternativos) ? secondary.emails_alternativos : [])
            .map((e) => normalizeEmail(e))
            .filter(Boolean);
        const altSet = new Set([...principalAlt, ...extraEmails].filter((e) => e && e !== normalizeEmail(principal.email_usuario)));
        principal.emails_alternativos = Array.from(altSet);
        await principal.save({ fields: ['emails_alternativos', 'updated_at'], transaction });

        const nowStamp = Date.now();
        const fallbackMail = `merged+${secondaryUserId}.${nowStamp}@invalid.local`;
        secondary.estado_cuenta = 'suspendido';
        secondary.email_usuario = fallbackMail;
        secondary.password_usuario = null;
        secondary.email_notificacion = null;
        secondary.email_factura = null;
        secondary.notas_usuario = `${secondary.notas_usuario ? `${secondary.notas_usuario}\n` : ''}[MERGED] Migrada a usuario ${principalUserId} el ${new Date().toISOString()} por actor ${actorId}`;
        await secondary.save({
            fields: [
                'estado_cuenta',
                'email_usuario',
                'password_usuario',
                'email_notificacion',
                'email_factura',
                'notas_usuario',
                'updated_at',
            ],
            transaction,
        });

        await transaction.commit();

        return res.status(200).json({
            message: 'Accounts merged successfully',
            principal_user_id: principalUserId,
            secondary_user_id: secondaryUserId,
        });
    } catch (error) {
        await transaction.rollback();
        console.error('[personal.mergePersonalAccounts] Error:', error);
        return res.status(500).json({ message: 'Error merging accounts', error: error.message });
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
            const adminScopedClinicIds = await getAdminScopedClinicIdsForUser(actorId);
            const adminScopedSet = new Set(adminScopedClinicIds);
            allowedClinicIds = targetClinicIds.filter((id) => adminScopedSet.has(id));
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
            rol_clinica: { [Op.in]: STAFF_ROLES },
            ...ACTIVE_STAFF_INVITATION_WHERE,
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
            ...ACTIVE_STAFF_INVITATION_WHERE,
        },
        attributes: ['id_usuario'],
        raw: true,
    });
    return !!row;
}

async function hasAdminScopePivot(userId, clinicId) {
    if (!Number.isFinite(Number(userId)) || !Number.isFinite(Number(clinicId))) return false;
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

async function canEditHorarios(actorId, targetUserId, clinicId) {
    if (isAdmin(actorId)) return true;
    if (!Number.isFinite(Number(clinicId))) return false;

    // Un usuario puede editar sus propios horarios en clínicas donde trabaja
    if (Number(actorId) === Number(targetUserId)) {
        return hasStaffPivot(actorId, clinicId);
    }

    // Editar horarios de otros: propietario/agencia con alcance sobre la clínica.
    const actorHasAdminScope = await hasAdminScopePivot(actorId, clinicId);
    if (!actorHasAdminScope) return false;

    // Evitar generar schedules "huérfanos" en clínicas donde el usuario no pertenece
    return hasStaffPivot(targetUserId, clinicId);
}

async function getOwnerClinicIdsForUser(userId) {
    if (!Number.isFinite(Number(userId))) return [];
    const rows = await UsuarioClinica.findAll({
        where: {
            id_usuario: Number(userId),
            rol_clinica: 'propietario',
            ...ACTIVE_STAFF_INVITATION_WHERE,
        },
        attributes: ['id_clinica'],
        raw: true,
    });
    return rows
        .map((r) => Number(r.id_clinica))
        .filter((id) => Number.isFinite(id));
}

async function getAgencyClinicIdsForUser(userId) {
    if (!Number.isFinite(Number(userId))) return [];
    const rows = await UsuarioClinica.findAll({
        where: {
            id_usuario: Number(userId),
            rol_clinica: 'agencia',
            ...ACTIVE_STAFF_INVITATION_WHERE,
        },
        attributes: ['id_clinica'],
        raw: true,
    });
    return rows
        .map((r) => Number(r.id_clinica))
        .filter((id) => Number.isFinite(id));
}

async function getAdminScopedClinicIdsForUser(userId) {
    if (!Number.isFinite(Number(userId))) return [];
    const rows = await UsuarioClinica.findAll({
        where: {
            id_usuario: Number(userId),
            rol_clinica: { [Op.in]: ADMIN_ROLES },
            ...ACTIVE_STAFF_INVITATION_WHERE,
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

    const adminScopedClinicIds = await getAdminScopedClinicIdsForUser(actorId);
    if (!adminScopedClinicIds.length) return false;

    // Bloqueo global (clinica_id=null): permitir solo si el actor (propietario/agencia)
    // tiene alcance en *todas* las clínicas donde trabaja el objetivo.
    if (clinicaId == null) {
        const targetClinicIds = await getAccessibleClinicIdsForUser(targetUserId);
        if (!targetClinicIds.length) return false;
        const adminScopedSet = new Set(adminScopedClinicIds);
        return targetClinicIds.every((id) => adminScopedSet.has(id));
    }

    const cid = Number(clinicaId);
    if (!Number.isFinite(cid)) return false;
    if (!adminScopedClinicIds.includes(cid)) return false;

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

function hmToMinutes(hm) {
    const normalized = normalizeHm(hm);
    if (!normalized) return null;
    const [hh, mm] = normalized.split(':').map(Number);
    return hh * 60 + mm;
}

function hmRangesOverlap(aInicio, aFin, bInicio, bFin) {
    const aStart = hmToMinutes(aInicio);
    const aEnd = hmToMinutes(aFin);
    const bStart = hmToMinutes(bInicio);
    const bEnd = hmToMinutes(bFin);
    if ([aStart, aEnd, bStart, bEnd].some((v) => v == null)) return false;
    return aStart < bEnd && bStart < aEnd;
}

async function findCrossClinicScheduleConflicts({ targetUserId, clinicaId, candidateHorarios }) {
    const activeCandidate = (candidateHorarios || []).filter((h) => h && h.activo !== false);
    if (!activeCandidate.length) return [];

    const otherDoctorClinicas = await DoctorClinica.findAll({
        where: {
            doctor_id: Number(targetUserId),
            activo: true,
            clinica_id: { [Op.ne]: Number(clinicaId) },
        },
        include: [
            {
                model: Clinica,
                as: 'clinica',
                attributes: ['id_clinica', 'nombre_clinica'],
            },
            {
                model: DoctorHorario,
                as: 'horarios',
                attributes: ['dia_semana', 'hora_inicio', 'hora_fin', 'activo'],
            },
        ],
    });

    const conflicts = [];
    for (const candidate of activeCandidate) {
        for (const dc of otherDoctorClinicas) {
            const horarios = Array.isArray(dc.horarios) ? dc.horarios : [];
            for (const existing of horarios) {
                if (existing?.activo === false) continue;
                if (Number(existing?.dia_semana) !== Number(candidate.dia_semana)) continue;
                if (!hmRangesOverlap(candidate.hora_inicio, candidate.hora_fin, existing.hora_inicio, existing.hora_fin)) continue;

                conflicts.push({
                    clinica_id: Number(dc.clinica_id),
                    nombre_clinica: dc?.clinica?.nombre_clinica || null,
                    dia_semana: Number(candidate.dia_semana),
                    nuevo_hora_inicio: candidate.hora_inicio,
                    nuevo_hora_fin: candidate.hora_fin,
                    conflicto_hora_inicio: existing.hora_inicio,
                    conflicto_hora_fin: existing.hora_fin,
                });
            }
        }
    }

    return conflicts;
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

        const crossClinicConflicts = await findCrossClinicScheduleConflicts({
            targetUserId,
            clinicaId,
            candidateHorarios: horarios,
        });
        if (crossClinicConflicts.length) {
            return res.status(409).json({
                message: 'El horario se solapa con la disponibilidad del profesional en otra clínica.',
                code: 'STAFF_SCHEDULE_OVERLAP_OTHER_CLINIC',
                can_force: false,
                conflicts: crossClinicConflicts,
            });
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

// ═══════════════════════════════════════════════════════════════
// Bloque 6.1 — Onboarding / Invitación de personal
// ═══════════════════════════════════════════════════════════════

const crypto = require('crypto');

/**
 * POST /api/personal/buscar
 * Busca usuarios existentes por email exacto.
 * Devuelve coincidencias con su estado de vinculación a la clínica solicitada.
 *
 * Body: { query: string, clinica_id: number }
 */
exports.buscarPersonal = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const { query, clinica_id } = req.body;
        if (!query || typeof query !== 'string') {
            return res.status(400).json({ message: 'query es obligatorio' });
        }
        const email = normalizeEmail(query);
        if (!email) {
            return res.status(400).json({ message: 'Debes introducir un email completo' });
        }
        const clinicaId = parseIntOrNull(clinica_id);
        if (!Number.isFinite(clinicaId)) {
            return res.status(400).json({ message: 'clinica_id es obligatorio' });
        }

        // Invitar/buscar personal es una acción de gestión: solo admin global
        // o roles de administración en la clínica (propietario/agencia).
        const canManageClinicPersonal = isAdmin(actorId) || await hasAdminScopePivot(actorId, clinicaId);
        if (!canManageClinicPersonal) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const escapedEmail = escapeJsonString(email);
        const users = await Usuario.findAll({
            attributes: ['id_usuario', 'nombre', 'apellidos', 'email_usuario', 'telefono', 'avatar', 'es_provisional'],
            where: {
                [Op.or]: [
                    { email_usuario: email },
                    { emails_alternativos: { [Op.like]: `%"${escapedEmail}"%` } },
                ],
            },
            include: [
                {
                    model: Clinica,
                    as: 'Clinicas',
                    attributes: ['id_clinica'],
                    required: false,
                    through: {
                        attributes: ['rol_clinica', 'subrol_clinica', 'estado_invitacion'],
                    },
                },
            ],
            order: [['nombre', 'ASC']],
            limit: 1,
        });

        // Enriquecer cada resultado con su estado respecto a la clínica solicitada
        const results = users.map((u) => {
            const json = u.toJSON();

            const clinicas = json.Clinicas || [];
            const pivot = clinicas.find(
                (c) => Number(c.id_clinica) === clinicaId,
            );

            return {
                id_usuario: json.id_usuario,
                nombre: json.nombre,
                apellidos: json.apellidos || '',
                email_usuario: json.email_usuario || '',
                telefono: json.telefono || '',
                avatar: json.avatar || null,
                es_provisional: !!json.es_provisional,
                vinculacion_clinica: pivot
                    ? {
                          ya_vinculado: true,
                          rol_clinica: pivot.UsuarioClinica?.rol_clinica || null,
                          subrol_clinica: pivot.UsuarioClinica?.subrol_clinica || null,
                          estado_invitacion: pivot.UsuarioClinica?.estado_invitacion || null,
                      }
                    : { ya_vinculado: false },
            };
        });

        return res.json(results);
    } catch (error) {
        console.error('[personal.buscarPersonal] Error:', error);
        return res.status(500).json({ message: 'Error en búsqueda', error: error.message });
    }
};

/**
 * POST /api/personal/invitar
 * Invita a un usuario existente o crea uno provisional y lo vincula a la clínica.
 *
 * Body: {
 *   clinica_id: number,
 *   rol_clinica: 'personaldeclinica' | 'propietario',
 *   subrol_clinica: string | null,
 *   // Si el usuario ya existe:
 *   id_usuario?: number,
 *   // Si es nuevo (provisional):
 *   nombre?: string,
 *   apellidos?: string,
 *   email_usuario?: string,
 *   telefono?: string,
 * }
 */
exports.invitarPersonal = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const {
            clinica_id,
            rol_clinica = 'personaldeclinica',
            subrol_clinica = null,
            id_usuario,
            nombre,
            apellidos,
            email_usuario,
            telefono,
        } = req.body;

        const clinicaId = parseIntOrNull(clinica_id);
        if (!Number.isFinite(clinicaId)) {
            return res.status(400).json({ message: 'clinica_id es obligatorio' });
        }

        // Invitar personal es una acción de gestión: solo admin global
        // o roles de administración en la clínica (propietario/agencia).
        const canManageClinicPersonal = isAdmin(actorId) || await hasAdminScopePivot(actorId, clinicaId);
        if (!canManageClinicPersonal) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        // Verificar que la clínica existe
        const clinica = await Clinica.findByPk(clinicaId);
        if (!clinica) {
            return res.status(404).json({ message: 'Clínica no encontrada' });
        }

        if (!INVITABLE_ROLES.includes(rol_clinica)) {
            return res.status(400).json({ message: `rol_clinica debe ser uno de: ${INVITABLE_ROLES.join(', ')}` });
        }

        let targetUser;
        let isNewProvisional = false;
        if (id_usuario) {
            // ── Invitar usuario existente ──
            targetUser = await Usuario.findByPk(id_usuario, {
                attributes: { exclude: ['password_usuario'] },
            });
            if (!targetUser) {
                return res.status(404).json({ message: 'Usuario no encontrado' });
            }

            // Verificar si ya está vinculado a esta clínica
            const existingPivot = await UsuarioClinica.findOne({
                where: { id_usuario: targetUser.id_usuario, id_clinica: clinicaId },
            });
            if (existingPivot) {
                const existingEstado = normalizeEstadoInvitacion(existingPivot.estado_invitacion, 'aceptada') || 'aceptada';

                // Si está pendiente/rechazada, se permite reenviar la invitación.
                if (existingEstado === 'pendiente' || existingEstado === 'rechazada') {
                    const cooldownRemainingMs = getInviteResendRemainingMs(existingPivot.invited_at);
                    if (cooldownRemainingMs > 0) {
                        const retryAfterSeconds = Math.ceil(cooldownRemainingMs / 1000);
                        const waitLabel = formatCooldownWindowLabel(cooldownRemainingMs);
                        res.set('Retry-After', String(retryAfterSeconds));
                        return res.status(429).json({
                            message: `Debes esperar ${waitLabel} para reenviar esta invitación.`,
                            code: 'invite_resend_cooldown',
                            retry_after_seconds: retryAfterSeconds,
                            retry_after_ms: cooldownRemainingMs,
                        });
                    }

                    const resentToken = crypto.randomBytes(32).toString('hex');
                    const now = new Date();
                    const nextSubrol = (subrol_clinica !== undefined)
                        ? (subrol_clinica || null)
                        : existingPivot.subrol_clinica;

                    existingPivot.rol_clinica = rol_clinica || existingPivot.rol_clinica;
                    existingPivot.subrol_clinica = nextSubrol;
                    existingPivot.estado_invitacion = 'pendiente';
                    existingPivot.invite_token = resentToken;
                    existingPivot.invited_at = now;
                    existingPivot.responded_at = null;
                    existingPivot.invitado_por = actorId;
                    existingPivot.fecha_invitacion = now;
                    await existingPivot.save({
                        fields: [
                            'rol_clinica',
                            'subrol_clinica',
                            'estado_invitacion',
                            'invite_token',
                            'invited_at',
                            'responded_at',
                            'invitado_por',
                            'fecha_invitacion',
                            'updated_at',
                        ],
                    });

                    const userJson = targetUser.toJSON ? targetUser.toJSON() : { ...targetUser };
                    delete userJson.password_usuario;

                    return res.status(200).json({
                        message: 'Invitación reenviada',
                        usuario: userJson,
                        clinica_id: clinicaId,
                        estado_invitacion: 'pendiente',
                        invite_token: resentToken,
                        es_provisional: !!targetUser.es_provisional,
                        resent: true,
                    });
                }

                return res.status(409).json({
                    message: 'El usuario ya está vinculado a esta clínica',
                    estado_invitacion: existingEstado,
                });
            }
        } else {
            // ── Crear usuario provisional ──
            if (!nombre || typeof nombre !== 'string' || !nombre.trim()) {
                return res.status(400).json({ message: 'nombre es obligatorio para crear usuario provisional' });
            }

            // Verificar email único si se proporciona
            if (email_usuario) {
                const existingByEmail = await Usuario.findOne({
                    where: { email_usuario: email_usuario.trim().toLowerCase() },
                });
                if (existingByEmail) {
                    return res.status(409).json({
                        message: 'Ya existe un usuario con ese email. Usa id_usuario para invitarlo.',
                        id_usuario_existente: existingByEmail.id_usuario,
                    });
                }
            }

            // Crear usuario provisional (sin password real)
            const placeholderPassword = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 8);
            targetUser = await Usuario.create({
                nombre: nombre.trim(),
                apellidos: (apellidos || '').trim(),
                email_usuario: email_usuario ? email_usuario.trim().toLowerCase() : '',
                telefono: (telefono || '').trim(),
                password_usuario: placeholderPassword,
                es_provisional: true,
                isProfesional: subrol_clinica === 'Doctores',
                fecha_creacion: new Date(),
            });
            isNewProvisional = true;
        }

        // Generar token de invitación
        const inviteToken = crypto.randomBytes(32).toString('hex');

        // Crear la vinculación con estado 'pendiente'
        await UsuarioClinica.create({
            id_usuario: targetUser.id_usuario,
            id_clinica: clinicaId,
            rol_clinica,
            subrol_clinica: subrol_clinica || null,
            estado_invitacion: 'pendiente',
            invite_token: inviteToken,
            invitado_por: actorId,
            fecha_invitacion: new Date(),
            invited_at: new Date(),
        });

        // Devolver respuesta
        const userJson = targetUser.toJSON ? targetUser.toJSON() : { ...targetUser };
        delete userJson.password_usuario;

        return res.status(201).json({
            message: isNewProvisional
                ? 'Usuario provisional creado e invitación enviada'
                : 'Invitación enviada al usuario existente',
            usuario: userJson,
            clinica_id: clinicaId,
            estado_invitacion: 'pendiente',
            invite_token: inviteToken,
            es_provisional: isNewProvisional,
        });
    } catch (error) {
        console.error('[personal.invitarPersonal] Error:', error);
        return res.status(500).json({ message: 'Error al invitar personal', error: error.message });
    }
};

/**
 * GET /api/personal/invitaciones?clinica_id=...
 * Lista las invitaciones pendientes/recientes de una clínica.
 */
exports.getInvitaciones = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        if (!Number.isFinite(actorId)) {
            return res.status(401).json({ message: 'Auth failed!' });
        }

        const clinicaId = parseIntOrNull(req.query?.clinica_id);
        if (!Number.isFinite(clinicaId)) {
            return res.status(400).json({ message: 'clinica_id es obligatorio' });
        }

        const canManageClinicPersonal = isAdmin(actorId) || await hasAdminScopePivot(actorId, clinicaId);
        if (!canManageClinicPersonal) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const pivots = await UsuarioClinica.findAll({
            where: {
                id_clinica: clinicaId,
                estado_invitacion: { [Op.ne]: null },
            },
            include: [
                {
                    model: Usuario,
                    as: 'Usuario',
                    attributes: { exclude: ['password_usuario'] },
                },
            ],
            order: [['invited_at', 'DESC']],
        });

        const results = pivots.map((p) => {
            const json = p.toJSON();
            return {
                id_usuario: json.id_usuario,
                id_clinica: json.id_clinica,
                rol_clinica: json.rol_clinica,
                subrol_clinica: json.subrol_clinica,
                estado_invitacion: json.estado_invitacion,
                invited_at: json.invited_at,
                responded_at: json.responded_at,
                usuario: json.Usuario || null,
            };
        });

        return res.json(results);
    } catch (error) {
        console.error('[personal.getInvitaciones] Error:', error);
        return res.status(500).json({ message: 'Error al obtener invitaciones', error: error.message });
    }
};

/**
 * POST /api/personal/:id/invitacion/responder
 * Acepta o rechaza una invitación pendiente.
 *
 * Body: { clinica_id: number, accion: 'aceptar' | 'rechazar' }
 */
exports.responderInvitacion = async (req, res) => {
    try {
        const actorId = Number(req.userData?.userId);
        const targetId = Number(req.params.id);
        if (!Number.isFinite(actorId) || !Number.isFinite(targetId)) {
            return res.status(400).json({ message: 'IDs inválidos' });
        }

        // Solo el propio usuario o un admin puede responder
        if (actorId !== targetId && !isAdmin(actorId)) {
            return res.status(403).json({ message: 'Forbidden' });
        }

        const { clinica_id, accion } = req.body;
        const clinicaId = parseIntOrNull(clinica_id);
        if (!Number.isFinite(clinicaId)) {
            return res.status(400).json({ message: 'clinica_id es obligatorio' });
        }
        if (!['aceptar', 'rechazar'].includes(accion)) {
            return res.status(400).json({ message: "accion debe ser 'aceptar' o 'rechazar'" });
        }

        const pivot = await UsuarioClinica.findOne({
            where: {
                id_usuario: targetId,
                id_clinica: clinicaId,
                estado_invitacion: 'pendiente',
            },
        });

        if (!pivot) {
            return res.status(404).json({ message: 'No hay invitación pendiente para esta clínica' });
        }

        pivot.estado_invitacion = accion === 'aceptar' ? 'aceptada' : 'rechazada';
        pivot.responded_at = new Date();
        pivot.invite_token = null; // Invalidar token
        await pivot.save();

        return res.json({
            message: `Invitación ${pivot.estado_invitacion}`,
            estado_invitacion: pivot.estado_invitacion,
        });
    } catch (error) {
        console.error('[personal.responderInvitacion] Error:', error);
        return res.status(500).json({ message: 'Error al responder invitación', error: error.message });
    }
};

/**
 * POST /api/auth/claim-invite  (público, sin JWT)
 * Permite a un usuario provisional reclamar su cuenta estableciendo email y contraseña.
 *
 * Body: { invite_token: string, email_usuario: string, password: string, nombre?: string, apellidos?: string }
 */
exports.reclamarCuenta = async (req, res) => {
    try {
        const { invite_token, email_usuario, password, nombre, apellidos } = req.body;

        if (!invite_token || typeof invite_token !== 'string') {
            return res.status(400).json({ message: 'invite_token es obligatorio' });
        }
        if (!email_usuario || typeof email_usuario !== 'string') {
            return res.status(400).json({ message: 'email_usuario es obligatorio' });
        }
        if (!password || typeof password !== 'string' || password.length < 6) {
            return res.status(400).json({ message: 'password debe tener al menos 6 caracteres' });
        }

        // Buscar el pivot con ese token
        const pivot = await UsuarioClinica.findOne({
            where: { invite_token: invite_token.trim() },
        });

        if (!pivot) {
            return res.status(404).json({ message: 'Token de invitación inválido o expirado' });
        }

        // Buscar el usuario asociado
        const user = await Usuario.findByPk(pivot.id_usuario);
        if (!user) {
            return res.status(404).json({ message: 'Usuario no encontrado' });
        }

        // Verificar que es provisional
        if (!user.es_provisional) {
            return res.status(409).json({ message: 'Esta cuenta ya fue reclamada' });
        }

        // Verificar email único
        const emailNormalized = email_usuario.trim().toLowerCase();
        const existingByEmail = await Usuario.findOne({
            where: {
                email_usuario: emailNormalized,
                id_usuario: { [Op.ne]: user.id_usuario },
            },
        });
        if (existingByEmail) {
            return res.status(409).json({ message: 'Ya existe otro usuario con ese email' });
        }

        // Actualizar usuario
        const hashedPassword = await bcrypt.hash(password, 8);
        user.email_usuario = emailNormalized;
        user.password_usuario = hashedPassword;
        user.es_provisional = false;
        if (nombre) user.nombre = nombre.trim();
        if (apellidos) user.apellidos = apellidos.trim();
        await user.save();

        // Marcar invitación como aceptada
        pivot.estado_invitacion = 'aceptada';
        pivot.responded_at = new Date();
        pivot.invite_token = null;
        await pivot.save();

        // Generar JWT para login inmediato
        const jwt = require('jsonwebtoken');
        const secret = process.env.JWT_SECRET;
        const token = jwt.sign(
            { userId: user.id_usuario, email: user.email_usuario },
            secret,
            { expiresIn: '24h' },
        );

        const userJson = user.toJSON();
        delete userJson.password_usuario;

        return res.json({
            message: 'Cuenta reclamada exitosamente',
            user: userJson,
            token,
        });
    } catch (error) {
        console.error('[personal.reclamarCuenta] Error:', error);
        return res.status(500).json({ message: 'Error al reclamar cuenta', error: error.message });
    }
};
