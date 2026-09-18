'use strict';
const { positive } = require('../services/googleAdsBrokerScope.service');
const { hasMarketingClinicScopeAccess } = require('./marketingScopeAccess');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = code => { throw Object.assign(Error(code), { code }); };
async function googleConversionRequestContext(req, value, { models, sessions, resolveRuntime, sessionError }) {
  let claims;
  try { claims = await sessions.verify(sessions.bearer(req.headers.authorization)); }
  catch { fail(sessionError); }
  if (claims.sessionVersion !== 1 || !positive(claims.userId) || !UUID.test(claims.jti)
    || !Number.isSafeInteger(claims.exp * 1000)) fail(sessionError);
  const actor = { userId: Number(claims.userId), sessionRef: claims.jti, expiresAt: claims.exp * 1000 };
  const m = typeof models === 'function' ? models() : models; let expectedIds;
  const beforeExecute = async ({ transaction } = {}) => {
    const clinics = await m.Clinica.findAll({ attributes: ['id_clinica'], raw: true, logging: false,
      where: value.scope.groupId ? { grupoClinicaId: value.scope.groupId } : { id_clinica: value.scope.clinicId },
      order: [['id_clinica', 'ASC']], limit: 1001, ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) });
    const ids = clinics.map(row => Number(row.id_clinica));
    if (!ids.length || ids.length > 1000 || ids.some(id => !positive(id)) || new Set(ids).size !== ids.length
      || expectedIds && JSON.stringify(ids) !== JSON.stringify(expectedIds)) return false;
    if (!await hasMarketingClinicScopeAccess({ userId: actor.userId, clinicIds: ids, access: 'write',
      membershipModel: { findAll: options => m.UsuarioClinica.findAll({ ...options, logging: false,
        ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) }) } })) return false;
    expectedIds ||= ids; return true;
  };
  if (!await beforeExecute()) fail('scope_denied');
  const runtime = await resolveRuntime({ userId: actor.userId, customerId: value.customerId, ...value.scope, requireBroker: true });
  const scopeKey = value.scope.assignmentScope + ':' + (value.scope.clinicId || value.scope.groupId);
  return { actor, scopeKey, runtime, beforeExecute };
}
module.exports = { googleConversionRequestContext };
