'use strict';

const { ADMIN_ROLES, isGlobalAdmin } = require('../lib/role-helpers');
const { fail, positive } = require('./metaMarketingOAuth.contract');

// An individual delegation applies only after the normal session and Marketing
// membership checks. Group scopes never inherit an individual delegation.
function hasClinicDelegation(input, grant = process.env.META_MARKETING_INSTAGRAM_ASSIGNMENT_DELEGATE) {
  if (!positive(input.actorId) || !/^clinic:[1-9][0-9]{0,9}$/.test(input.scopeKey)) return false;
  return grant === String(input.actorId) + '@' + input.scopeKey;
}

function assignmentAuthorization(scope, memberships) {
  return async (input, transaction) => {
    const authorized = await scope.authorize(input, transaction);
    if (isGlobalAdmin(input.actorId) || hasClinicDelegation(input)) return authorized;
    const owners = await memberships.findAll({
      ...authorized.options,
      attributes: ['id_clinica'],
      where: { id_usuario: input.actorId, id_clinica: authorized.clinicIds, rol_clinica: ADMIN_ROLES },
    });
    // scope.authorize has already locked the actor's accepted Marketing memberships.
    const owned = new Set(owners.map(row => Number(row.id_clinica)));
    if (!authorized.clinicIds.length || !authorized.clinicIds.every(id => owned.has(id))) {
      fail('meta_instagram_scope_forbidden', 403);
    }
    return authorized;
  };
}

module.exports = { hasClinicDelegation, assignmentAuthorization };
