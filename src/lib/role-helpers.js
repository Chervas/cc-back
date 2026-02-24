'use strict';

// Central role constants/helpers used across controllers.

const ROLES_CLINICA = ['paciente', 'personaldeclinica', 'propietario', 'agencia'];
const STAFF_ROLES = ['propietario', 'personaldeclinica', 'agencia'];
const ADMIN_ROLES = ['propietario', 'agencia'];
const INVITABLE_ROLES = ['personaldeclinica', 'propietario', 'agencia'];

const SUBROLES_CLINICA = [
    'Auxiliares y enfermeros',
    'Doctores',
    'Administrativos',
    'Recepcion / Comercial ventas',
];

const ESTADO_CUENTA = ['activo', 'provisional', 'suspendido'];
const ESTADO_INVITACION = ['pendiente', 'aceptada', 'rechazada', 'cancelada'];

const ADMIN_USER_IDS = [1];

const isGlobalAdmin = (userId) => ADMIN_USER_IDS.includes(Number(userId));
const isStaffRole = (rolClinica) => STAFF_ROLES.includes(rolClinica);
const isAdminRole = (rolClinica) => ADMIN_ROLES.includes(rolClinica);
const canManagePersonal = (userId, rolClinica) => isGlobalAdmin(userId) || isAdminRole(rolClinica);

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
