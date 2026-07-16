'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const {
  STAFF_ROLES,
  MARKETING_WRITE_ROLES,
  isGlobalAdmin,
} = require('./role-helpers');

const ACTIVE_MEMBERSHIP_WHERE = {
  [Op.or]: [
    { estado_invitacion: 'aceptada' },
    { estado_invitacion: null },
  ],
};

function normalizeClinicIds(values) {
  return Array.from(new Set((Array.isArray(values) ? values : [values])
    .map((value) => Number.parseInt(String(value), 10))
    .filter((value) => Number.isInteger(value) && value > 0)));
}

function clinicIdsFromStrategyRows(rows) {
  const clinicIds = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    clinicIds.push(row?.clinica_id);
    const payload = row?.solicitud && typeof row.solicitud === 'object'
      ? row.solicitud
      : {};
    const scope = payload.scope && typeof payload.scope === 'object'
      ? payload.scope
      : {};
    clinicIds.push(scope.clinic_id);
    if (Array.isArray(scope.clinic_ids)) {
      clinicIds.push(...scope.clinic_ids);
    }
  }

  return normalizeClinicIds(clinicIds);
}

function requestIdsFromRows(rows) {
  return normalizeClinicIds((Array.isArray(rows) ? rows : []).map((row) => row?.id));
}

async function getAccessibleMarketingClinicIds({
  userId,
  clinicIds,
  access = 'read',
  membershipModel = db.UsuarioClinica,
  globalAdminCheck = isGlobalAdmin,
} = {}) {
  const normalizedUserId = Number.parseInt(String(userId), 10);
  const normalizedClinicIds = normalizeClinicIds(clinicIds);

  if (!Number.isInteger(normalizedUserId) || normalizedUserId <= 0 || normalizedClinicIds.length === 0) {
    return [];
  }
  if (globalAdminCheck(normalizedUserId)) {
    return normalizedClinicIds;
  }

  const allowedRoles = access === 'write' ? MARKETING_WRITE_ROLES : STAFF_ROLES;
  const memberships = await membershipModel.findAll({
    where: {
      id_usuario: normalizedUserId,
      id_clinica: { [Op.in]: normalizedClinicIds },
      rol_clinica: { [Op.in]: allowedRoles },
      ...ACTIVE_MEMBERSHIP_WHERE,
    },
    attributes: ['id_clinica'],
    raw: true,
  });
  const accessibleClinicIds = new Set(normalizeClinicIds(
    memberships.map((membership) => membership.id_clinica)
  ));

  return normalizedClinicIds.filter((clinicId) => accessibleClinicIds.has(clinicId));
}

async function hasMarketingClinicScopeAccess(options = {}) {
  const normalizedClinicIds = normalizeClinicIds(options.clinicIds);
  if (normalizedClinicIds.length === 0) return false;
  const accessibleClinicIds = await getAccessibleMarketingClinicIds(options);
  return accessibleClinicIds.length === normalizedClinicIds.length;
}

module.exports = {
  clinicIdsFromStrategyRows,
  getAccessibleMarketingClinicIds,
  hasMarketingClinicScopeAccess,
  normalizeClinicIds,
  requestIdsFromRows,
};
