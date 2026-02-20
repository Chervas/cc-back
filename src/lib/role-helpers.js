/**
 * role-helpers.js — Constantes y helpers centralizados de roles.
 *
 * Objetivo: evitar hardcodear ['propietario','personaldeclinica'] en cada controller/route.
 * Cuando se añada un nuevo rol (p.ej. 'agencia'), basta con actualizar este fichero.
 *
 * Convención de naming: snake_case para exports (alineado con API canónica).
 */

'use strict';

// ── Roles de clínica ──────────────────────────────────────────
/** Todos los roles válidos en UsuarioClinica.rol_clinica */
const ROLES_CLINICA = ['paciente', 'personaldeclinica', 'propietario', 'agencia'];

/** Roles que representan "staff" (personal que trabaja en la clínica) */
const STAFF_ROLES = ['propietario', 'personaldeclinica', 'agencia'];

/** Roles con permisos de gestión (admin-level) en su scope de clínicas */
const ADMIN_ROLES = ['propietario', 'agencia'];

/** Roles que pueden ser invitados al onboarding */
const INVITABLE_ROLES = ['personaldeclinica', 'propietario', 'agencia'];

// ── Subroles ──────────────────────────────────────────────────
const SUBROLES_CLINICA = [
    'Auxiliares y enfermeros',
    'Doctores',
    'Administrativos',
    'Recepción / Comercial ventas',
];

// ── Estados ───────────────────────────────────────────────────
const ESTADO_CUENTA = ['activo', 'provisional', 'suspendido'];
const ESTADO_INVITACION = ['pendiente', 'aceptada', 'rechazada', 'cancelada'];

// ── Admin global (por ID de usuario) ──────────────────────────
const ADMIN_USER_IDS = [1];

// ── Helpers ───────────────────────────────────────────────────

/**
 * ¿Es admin global? (por userId, NO por rol_clinica).
 * Nunca meter 'agencia' aquí.
 */
const isGlobalAdmin = (userId) => ADMIN_USER_IDS.includes(Number(userId));

/**
 * ¿Tiene rol de staff en alguna clínica? (propietario, personaldeclinica, agencia)
 */
const isStaffRole = (rolClinica) => STAFF_ROLES.includes(rolClinica);

/**
 * ¿Tiene rol de admin (scoped) en una clínica? (propietario o agencia)
 */
const isAdminRole = (rolClinica) => ADMIN_ROLES.includes(rolClinica);

/**
 * ¿Puede gestionar personal en una clínica?
 * - Admin global: siempre.
 * - Propietario de la clínica: sí.
 * - Agencia con la clínica asignada: sí.
 * - Otros: no.
 */
const canManagePersonal = (userId, rolClinica) =>
    isGlobalAdmin(userId) || isAdminRole(rolClinica);

module.exports = {
    ROLES_CLINICA,
    STAFF_ROLES,
    ADMIN_ROLES,
    INVITABLE_ROLES,
    SUBROLES_CLINICA,
    ESTADO_CUENTA,
    ESTADO_INVITACION,
    ADMIN_USER_IDS,
    isGlobalAdmin,
    isStaffRole,
    isAdminRole,
    canManagePersonal,
};
