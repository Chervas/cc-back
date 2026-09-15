'use strict';
const { Op } = require('sequelize');
const id = value => /^[1-9][0-9]{0,9}$/.test(String(value)) && Number(value) <= 2147483647 ? Number(value) : null;
function unavailable() { throw Object.assign(Error('meta_security_state_unavailable'), { code: 'meta_security_state_unavailable', httpStatus: 503 }); }
async function blocked(scope, { models = require('../../models'), transaction } = {}) {
  try {
    const keys = [];
    const options = { raw: true, ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) };
    if (scope?.assignmentScope === 'clinic' && id(scope.clinicId)) {
      keys.push('clinic:' + id(scope.clinicId));
      const clinic = await models.Clinica.findByPk(id(scope.clinicId), { ...options, attributes: ['grupoClinicaId'] });
      if (!clinic) unavailable();
      if (id(clinic.grupoClinicaId)) keys.push('group:' + id(clinic.grupoClinicaId));
    } else if (scope?.assignmentScope === 'group' && id(scope.groupId)) {
      keys.push('group:' + id(scope.groupId));
      const clinics = await models.Clinica.findAll({ ...options, where: { grupoClinicaId: id(scope.groupId) }, attributes: ['id_clinica'] });
      for (const clinic of clinics) { if (!id(clinic.id_clinica)) unavailable(); keys.push('clinic:' + id(clinic.id_clinica)); }
    } else unavailable();
    return !!await models.MetaScopeBlock.findOne({ ...options, attributes: ['scope_key'], where: { scope_key: { [Op.in]: keys } } });
  } catch { unavailable(); }
}
async function preserve({ scope, connectionId, actorId, clinicIds, models = require('../../models'), transaction }) {
  if (!transaction || !id(connectionId) || !id(actorId)) unavailable();
  const scopeKey = scope?.assignmentScope === 'group' && id(scope.groupId) ? 'group:' + id(scope.groupId)
    : scope?.assignmentScope === 'clinic' && id(scope.clinicId) ? 'clinic:' + id(scope.clinicId) : null;
  if (!scopeKey || !Array.isArray(clinicIds) || clinicIds.some(value => !id(value))) unavailable();
  for (const key of [...new Set([scopeKey, ...clinicIds.map(value => 'clinic:' + id(value))])].sort()) {
    await models.MetaScopeBlock.findOrCreate({ where: { scope_key: key },
      defaults: { scope_key: key, reason: 'scope_disconnected', connection_id: Number(connectionId), actor_user_id: Number(actorId), created_at: new Date() }, transaction });
  }
  const repo = require('./platformAudit.repository').createRepository(models.PlatformAuditEvent);
  const health = await repo.health(new Date(), { includeUnresolved: false, transaction });
  if (health.pending >= 10000 || health.oldestAgeSeconds >= 3600) unavailable();
  const { randomUUID } = require('node:crypto');
  await repo.append({ version: 14, eventId: randomUUID(), correlationId: randomUUID(), occurredAt: new Date().toISOString(),
    action: 'integration.meta.scope_block', stage: 'completed', outcome: 'success', reason: 'scope_disconnected',
    actor: { type: 'user', id: String(actorId) }, scope: { type: scope.assignmentScope, id: scopeKey.split(':')[1] },
    connectionId: String(connectionId), capturePolicy: 'meta-containment-v1' }, { transaction });
}
module.exports = { blocked, preserve };
