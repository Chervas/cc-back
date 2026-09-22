'use strict';
const { Op, where, json } = require('sequelize');
const { randomUUID } = require('node:crypto');
const bcrypt = require('bcryptjs');
const { isGlobalAdmin } = require('../lib/role-helpers');
const fail = (code, status) => { throw Object.assign(Error(code), { code, status }); };

// Separate from generic profile writes: authenticate the administrator again,
// lock both identities, revoke old proofs and commit the audit with the password.
function createService({ models, sessions, audit, mode, now = () => new Date() }) {
  return async function change({ actor, targetId, body }) {
    if (!isGlobalAdmin(actor?.userId)) fail('admin_password_forbidden', 403);
    if (mode() !== 'enforce') fail('admin_password_unavailable', 503);
    if (!Number.isSafeInteger(targetId) || targetId <= 0 || !body || Array.isArray(body)
      || Object.keys(body).sort().join(',') !== 'administratorPassword,password'
      || typeof body.password !== 'string' || body.password.length < 12 || Buffer.byteLength(body.password) > 72
      || typeof body.administratorPassword !== 'string' || !body.administratorPassword.length
      || body.administratorPassword.length > 1024) fail('admin_password_request_invalid', 400);
    const nextHash = await bcrypt.hash(body.password, 12);
    const result = await models.Usuario.sequelize.transaction(async transaction => {
      const users = await models.Usuario.findAll({ where: { id_usuario: { [Op.in]: [actor.userId, targetId] } },
        order: [['id_usuario', 'ASC']], transaction, lock: transaction.LOCK.UPDATE });
      const administrator = users.find(u => Number(u.id_usuario) === actor.userId);
      const target = users.find(u => Number(u.id_usuario) === targetId);
      await sessions.verifyReference({ ...actor, transaction });
      if (!target) fail('admin_password_user_not_found', 404);
      if (target.estado_cuenta !== 'activo' || target.es_provisional) fail('admin_password_user_inactive', 409);
      const failures = await models.SyncLog.count({ where: { job_type: 'admin_password_change', status: 'failed',
        start_time: { [Op.gte]: new Date(now().getTime() - 15 * 60000) },
        [Op.and]: [where(json('status_report.actor_id'), actor.userId)] }, transaction });
      if (failures >= 5) fail('admin_password_rate_limited', 429);
      if (!administrator || !await bcrypt.compare(body.administratorPassword, administrator.password_usuario)) {
        await models.SyncLog.create({ job_type: 'admin_password_change', status: 'failed', start_time: now(), end_time: now(),
          status_report: { actor_id: actor.userId, target_id: targetId, reason: 'administrator_password_rejected' } }, { transaction });
        return { error: 'admin_password_proof_rejected' };
      }
      const health = await audit.health(now(), { includeUnresolved: false, transaction });
      if (health.pending >= 10000 || health.oldestAgeSeconds >= 3600) fail('admin_password_unavailable', 503);
      await target.update({ password_usuario: nextHash }, { transaction, fields: ['password_usuario'] });
      await models.AuthSession.update({ state: 'revoked', ended_at: now() }, { where: { user_id: targetId, state: 'active' }, transaction });
      await models.AuthEmailChallenge.update({ state: 'revoked' }, { where: { user_id: targetId, state: { [Op.in]: ['pending', 'verified'] } }, transaction });
      await models.AuthTrustedDevice.update({ revoked_at: now() }, { where: { user_id: targetId, revoked_at: null }, transaction });
      await models.PasswordResetToken.update({ status: 'revoked' }, { where: { user_id: targetId, status: 'pending' }, transaction });
      const correlationId = randomUUID();
      await audit.append({ version: 13, eventId: randomUUID(), correlationId, occurredAt: now().toISOString(),
        action: 'auth.password_reset', stage: 'completed', outcome: 'success', reason: 'credentials_reset',
        actor: { type: 'user', id: String(targetId) }, scope: { type: 'platform', id: null }, challengeRef: null,
        sessionRef: null, capturePolicy: 'email-login-v1' }, { transaction });
      await models.SyncLog.create({ job_type: 'admin_password_change', status: 'completed', start_time: now(), end_time: now(),
        records_processed: 1, status_report: { actor_id: actor.userId, target_id: targetId, correlation_id: correlationId,
          reason: 'administrator_password_verified', sessions_revoked: true } }, { transaction });
      return { changed: true, userId: targetId, requiresSignIn: targetId === actor.userId };
    });
    if (result.error) fail(result.error, 400);
    return result;
  };
}

async function handler(req, res) {
  res.set('Cache-Control', 'private, no-store');
  try {
    const models = require('../../models');
    const change = createService({ models, sessions: require('./accessSession.service'),
      audit: require('./platformAudit.repository').createRepository(models.PlatformAuditEvent),
      mode: require('./authEmailChallenge.contract').mode });
    const result = await change({ actor: { userId: Number(req.userData?.userId), sessionRef: req.authSession?.id,
      expiresAt: new Date(Number(req.authSession?.expiresAt) * 1000) }, targetId: Number(req.params.id), body: req.body });
    return res.json(result);
  } catch (error) {
    const known = /^admin_password_(forbidden|request_invalid|user_not_found|user_inactive|rate_limited|proof_rejected|unavailable)$/.test(error.code || '');
    return res.status(known ? error.status : 503).json({ error: known ? error.code : 'admin_password_unavailable' });
  }
}
module.exports = { createService, handler };
