'use strict';

const { Op } = require('sequelize');
const db = require('../../models');
const { STAFF_ROLES, isGlobalAdmin } = require('./role-helpers');
const { canUserAccessFeature } = require('./access-policy');

const ACTIVE_MEMBERSHIP_WHERE = {
  [Op.or]: [
    { estado_invitacion: 'aceptada' },
    { estado_invitacion: null },
  ],
};

function positiveInteger(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function authorizePersonalMerge({
  actorId,
  primaryUserId,
  secondaryUserId,
  membershipModel = db.UsuarioClinica,
  featureCheck = canUserAccessFeature,
  globalAdminCheck = isGlobalAdmin,
} = {}) {
  const actor = positiveInteger(actorId);
  const primary = positiveInteger(primaryUserId);
  const secondary = positiveInteger(secondaryUserId);
  if (!actor || !primary || !secondary || primary === secondary) return false;
  if (globalAdminCheck(actor)) return true;

  const memberships = await membershipModel.findAll({
    where: {
      id_usuario: { [Op.in]: [primary, secondary] },
      rol_clinica: { [Op.in]: STAFF_ROLES },
      ...ACTIVE_MEMBERSHIP_WHERE,
    },
    attributes: ['id_usuario', 'id_clinica', 'rol_clinica'],
    raw: true,
  });
  if (!memberships.length) return false;

  // Fusionar cuentas puede trasladar o destruir pivotes. Los propietarios se
  // mantienen bajo la protección reforzada y solo un admin global puede hacerlo.
  if (memberships.some((membership) => membership.rol_clinica === 'propietario')) {
    return false;
  }

  const clinicIds = Array.from(new Set(memberships
    .map((membership) => positiveInteger(membership.id_clinica))
    .filter(Boolean)));
  if (!clinicIds.length) return false;

  const decisions = await Promise.all(clinicIds.map((clinicId) => featureCheck({
    actorId: actor,
    featureKey: 'team.manage',
    clinicId,
  }).catch(() => false)));
  return decisions.every(Boolean);
}

async function requirePersonalMergeAccess(req, res, next) {
  try {
    const primaryUserId = req.body?.principal_user_id;
    const secondaryUserId = req.body?.secondary_user_id;
    const allowed = await authorizePersonalMerge({
      actorId: req.userData?.userId,
      primaryUserId,
      secondaryUserId,
    });
    if (!allowed) {
      return res.status(403).json({
        message: 'Forbidden',
        code: 'personal_merge_forbidden',
      });
    }
    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = {
  authorizePersonalMerge,
  requirePersonalMergeAccess,
};
