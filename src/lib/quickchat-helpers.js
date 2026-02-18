'use strict';

const TEAM_READER_ROLES = new Set(['propietario', 'agencia', 'personaldeclinica']);
const PATIENT_READER_ROLES = new Set(['propietario']);

function normalizeRole(value) {
    return String(value || '').trim().toLowerCase();
}

function normalizeSubrole(value) {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .trim()
        .toLowerCase();
}

function isAssistantSubrole(subrole) {
    const normalized = normalizeSubrole(subrole);
    return (
        normalized === 'auxiliares y enfermeros' ||
        normalized === 'auxiliares y enfermeras' ||
        normalized.startsWith('auxiliar')
    );
}

function resolveQuickChatPermissions({ rol_clinica, subrol_clinica }) {
    const role = normalizeRole(rol_clinica);
    if (!role || role === 'paciente') {
        return { readTeam: false, readPatients: false };
    }

    const readTeam = TEAM_READER_ROLES.has(role);
    const readPatients =
        PATIENT_READER_ROLES.has(role) ||
        (role === 'personaldeclinica' && isAssistantSubrole(subrol_clinica));

    return { readTeam, readPatients };
}

function buildQuickChatContextFromMemberships(memberships, { isGlobalAdmin = false } = {}) {
    const clinicIdsSet = new Set();
    const permissionsByClinic = new Map();
    const roleByClinic = new Map();
    let hasAgenciaRole = false;

    for (const row of memberships || []) {
        const clinicId = Number(row?.id_clinica);
        if (!Number.isFinite(clinicId)) continue;

        clinicIdsSet.add(clinicId);
        const role = normalizeRole(row?.rol_clinica);
        const subrole = row?.subrol_clinica || null;
        if (role === 'agencia') {
            hasAgenciaRole = true;
        }

        const current = permissionsByClinic.get(clinicId) || { readTeam: false, readPatients: false };
        const next = resolveQuickChatPermissions({ rol_clinica: role, subrol_clinica: subrole });
        permissionsByClinic.set(clinicId, {
            readTeam: current.readTeam || next.readTeam,
            readPatients: current.readPatients || next.readPatients,
        });

        if (!roleByClinic.has(clinicId)) {
            roleByClinic.set(clinicId, {
                rol_clinica: role || null,
                subrol_clinica: subrole,
            });
        }
    }

    const clinicIds = Array.from(clinicIdsSet).sort((a, b) => a - b);
    const canUseAllClinics = !isGlobalAdmin && !hasAgenciaRole;

    const teamClinicIds = clinicIds.filter((id) => permissionsByClinic.get(id)?.readTeam);
    const patientClinicIds = clinicIds.filter((id) => permissionsByClinic.get(id)?.readPatients);

    return {
        clinicIds,
        roleByClinic,
        permissionsByClinic,
        teamClinicIds,
        patientClinicIds,
        hasAgenciaRole,
        isGlobalAdmin: !!isGlobalAdmin,
        canUseAllClinics,
        hasAnyRead: teamClinicIds.length > 0 || patientClinicIds.length > 0,
    };
}

function isTeamConversation(conversation) {
    return String(conversation?.channel || '').toLowerCase() === 'internal';
}

function canReadConversationInClinic(permissionsByClinic, clinicId, conversation) {
    const permissions = permissionsByClinic.get(Number(clinicId));
    if (!permissions) return false;
    return isTeamConversation(conversation)
        ? !!permissions.readTeam
        : !!permissions.readPatients;
}

module.exports = {
    normalizeRole,
    normalizeSubrole,
    resolveQuickChatPermissions,
    buildQuickChatContextFromMemberships,
    isTeamConversation,
    canReadConversationInClinic,
};
