'use strict';
const { randomUUID, randomBytes, randomInt } = require('node:crypto');
const { Op } = require('sequelize');
const C = require('./authEmailChallenge.contract');
const sessionsApi = require('./accessSession.service');
const FIELDS = ['id_usuario', 'email_usuario', 'password_usuario', 'estado_cuenta', 'es_provisional',
  'nombre', 'apellidos', 'isProfesional', 'avatar', 'ultimo_login'];
function createService({ models, sessions, trustedDevices, audit, queueEmail, config = C.settings, now = () => new Date() }) {
  const db = () => typeof models === 'function' ? models() : models;
  const sessionService = () => sessions || sessionsApi;
  const repo = () => audit || require('./platformAudit.repository').createRepository(db().PlatformAuditEvent);
  const mail = (...args) => queueEmail ? queueEmail(...args) : require('./emailDelivery.service').queueEmail(...args);
  function enabled() {
    const cfg = config();
    if (cfg.mode !== 'enforce' || !Buffer.isBuffer(cfg.key) || cfg.key.length !== 32) C.fail('auth_email_unavailable', 503);
    return cfg;
  }
  function unchanged(cfg) {
    const current = enabled();
    if (!current.key.equals(cfg.key)) C.fail('auth_email_unavailable', 503);
  }
  const credentialBinding = user => sessionService().credentialBinding(user);
  const devices = () => trustedDevices || require('./authTrustedDevice.service').createService({ models, credentialBinding, config, now });
  async function record({ outcome, reason, action = 'auth.email_code', userId = null, challengeId = null, sessionRef = null, correlationId = randomUUID() }, transaction) {
    await repo().append({ version: 13, eventId: randomUUID(), correlationId, occurredAt: now().toISOString(),
      action, stage: 'completed', outcome, reason,
      actor: userId ? { type: 'user', id: String(userId) } : { type: 'anonymous', id: null },
      scope: { type: 'platform', id: null }, challengeRef: challengeId, sessionRef, capturePolicy: 'email-login-v1' }, { transaction });
  }
  async function capacity(transaction) {
    const health = await repo().health(now(), { includeUnresolved: false, transaction });
    if (health.pending >= 10000 || health.oldestAgeSeconds >= 3600) C.fail('auth_email_unavailable', 503);
  }
  const resultError = (code, status = 401) => ({ error: { code, status } });
  async function finish(work) {
    try {
      const result = await work();
      if (result?.error) C.fail(result.error.code, result.error.status);
      return result;
    } catch (error) {
      if (['auth_email_invalid', 'auth_email_expired', 'auth_email_locked', 'auth_email_rate_limited',
        'auth_email_unavailable', 'auth_email_configuration_invalid'].includes(error?.code)) throw error;
      C.fail('auth_email_unavailable', 503);
    }
  }
  async function sendsThisHour(userId, transaction) {
    return Number(await db().AuthEmailChallenge.sum('sends', { where: { user_id: userId,
      // Count the whole intent while its last send is inside the hour. This is
      // conservative at the boundary and never drops a recent resend merely
      // because the password step was created earlier.
      last_sent_at: { [Op.gte]: new Date(now().getTime() - 3600000) } }, transaction })) || 0;
  }
  function response(row, token, email) {
    return { mfaRequired: true, method: 'email', challengeToken: token, maskedEmail: C.maskedEmail(email),
      expiresAt: row.expires_at.toISOString(), resendAfter: new Date(row.last_sent_at.getTime() + C.LIMITS.minResendSeconds * 1000).toISOString() };
  }
  async function enqueue(row, user, code, transaction) {
    const queued = await mail({ stream: 'transactional', templateKey: 'auth.email_verification', templateVersion: 'v1',
      subjectKey: 'auth.email_verification', recipientEmail: user.email_usuario, recipientKind: 'user', usuarioId: user.id_usuario,
      relatedType: 'auth_email_challenge', relatedId: row.challenge_id,
      dedupeKey: 'auth.email_verification:' + row.challenge_id + ':' + row.sends, priority: 'critical', origin: 'auth.email_code',
      templateContext: { auth_email_challenge_id: row.challenge_id, verification_code: code, expires_minutes: C.LIMITS.codeSeconds / 60 },
      metadata: { contains_clinical_data: false, use_case: 'email_login_verification' } }, { transaction });
    if (!Number.isSafeInteger(Number(queued?.emailMessage?.id)) || Number(queued.emailMessage.id) <= 0
      || ['suppressed', 'failed', 'cancelled', 'rejected'].includes(queued.emailMessage.status)) C.fail('auth_email_unavailable', 503);
    await row.update({ email_message_id: Number(queued.emailMessage.id) }, { transaction });
  }
  const begin = user => finish(async () => {
    const cfg = enabled();
    return db().sequelize.transaction(async transaction => {
      const fresh = await db().Usuario.findByPk(user.id_usuario, { attributes: FIELDS, transaction, lock: transaction.LOCK.UPDATE });
      if (!sessionsApi.activeUser(fresh) || credentialBinding(fresh) !== credentialBinding(user)) C.fail();
      await capacity(transaction);
      const recent = await db().AuthEmailChallenge.findOne({ where: { user_id: fresh.id_usuario },
        order: [['created_at', 'DESC']], transaction, lock: transaction.LOCK.UPDATE });
      if (recent && now().getTime() < recent.last_sent_at.getTime() + C.LIMITS.minResendSeconds * 1000
        || await sendsThisHour(fresh.id_usuario, transaction) >= C.LIMITS.sendsPerUserHour) {
        await record({ outcome: 'denied', reason: 'rate_limited', userId: fresh.id_usuario }, transaction);
        return resultError('auth_email_rate_limited', 429);
      }
      await db().AuthEmailChallenge.update({ state: 'revoked' }, { where: { user_id: fresh.id_usuario,
        state: { [Op.in]: ['pending', 'verified'] } }, transaction });
      const at = now(); const id = randomUUID(); const token = randomBytes(32).toString('base64url');
      const code = String(randomInt(0, 1000000)).padStart(6, '0');
      const row = await db().AuthEmailChallenge.create({ challenge_id: id, user_id: fresh.id_usuario,
        challenge_hash: C.challengeHash(token), code_hash: C.codeHash(cfg.key, id, code), credential_binding: credentialBinding(fresh),
        email_hash: C.emailHash(fresh.email_usuario), state: 'pending', created_at: at, last_sent_at: at,
        expires_at: new Date(at.getTime() + C.LIMITS.codeSeconds * 1000),
        absolute_expires_at: new Date(at.getTime() + C.LIMITS.absoluteSeconds * 1000), attempts: 0, sends: 1 }, { transaction });
      await enqueue(row, fresh, code, transaction);
      await record({ outcome: 'pending', reason: 'code_queued', userId: fresh.id_usuario, challengeId: id }, transaction);
      unchanged(cfg); return response(row, token, fresh.email_usuario);
    });
  });
  async function operate(token, work) {
    const cfg = enabled(); const hash = C.challengeHash(token);
    await capacity();
    const hint = await db().AuthEmailChallenge.findOne({ attributes: ['challenge_id', 'user_id'], where: { challenge_hash: hash }, raw: true, logging: false });
    if (!hint) { await record({ outcome: 'denied', reason: 'challenge_rejected' }); return resultError('auth_email_invalid'); }
    return db().sequelize.transaction(async transaction => {
      // Same order as every session issuer/revoker: user, then proof/session.
      const user = await db().Usuario.findByPk(hint.user_id, { attributes: FIELDS, transaction, lock: transaction.LOCK.UPDATE });
      const row = await db().AuthEmailChallenge.findByPk(hint.challenge_id, { transaction, lock: transaction.LOCK.UPDATE });
      await capacity(transaction);
      const reject = async (reason, code, status = 401, state = null) => {
        if (row && state) await row.update({ state }, { transaction });
        await record({ outcome: 'denied', reason, userId: row?.user_id || null, challengeId: row?.challenge_id || null }, transaction);
        return resultError(code, status);
      };
      if (!row || !C.equalHash(row.challenge_hash, hash) || row.user_id !== hint.user_id || row.state !== 'pending') {
        return reject('challenge_rejected', 'auth_email_invalid');
      }
      if (!sessionsApi.activeUser(user) || !C.equalHash(row.credential_binding, credentialBinding(user))
        || row.email_hash !== C.emailHash(user.email_usuario)) return reject('credentials_changed', 'auth_email_invalid', 401, 'revoked');
      if (row.absolute_expires_at.getTime() <= now().getTime()) return reject('code_expired', 'auth_email_expired', 401, 'expired');
      if (row.attempts >= C.LIMITS.maxAttempts) return reject('attempts_exhausted', 'auth_email_locked', 429, 'locked');
      const result = await work({ cfg, row, user, transaction, reject });
      unchanged(cfg); return result;
    });
  }
  const resend = token => finish(() => operate(token, async ({ cfg, row, user, transaction, reject }) => {
    if (row.sends >= C.LIMITS.maxSends || now().getTime() < row.last_sent_at.getTime() + C.LIMITS.minResendSeconds * 1000
      || await sendsThisHour(user.id_usuario, transaction) >= C.LIMITS.sendsPerUserHour) return reject('rate_limited', 'auth_email_rate_limited', 429);
    const at = now(); let code;
    for (let i = 0; i < 10; i++) {
      const candidate = String(randomInt(0, 1000000)).padStart(6, '0');
      if (!C.equalHash(row.code_hash, C.codeHash(cfg.key, row.challenge_id, candidate))) { code = candidate; break; }
    }
    if (!code) C.fail('auth_email_unavailable', 503);
    await row.update({ code_hash: C.codeHash(cfg.key, row.challenge_id, code), sends: row.sends + 1,
      last_sent_at: at, expires_at: new Date(Math.min(at.getTime() + C.LIMITS.codeSeconds * 1000, row.absolute_expires_at.getTime())) }, { transaction });
    await enqueue(row, user, code, transaction);
    await record({ outcome: 'pending', reason: 'code_resent', userId: user.id_usuario, challengeId: row.challenge_id }, transaction);
    return response(row, token, user.email_usuario);
  }));
  const verifyWithOptions = (token, code, trustDevice = false) => finish(() => operate(token, async ({ cfg, row, user, transaction, reject }) => {
    if (row.expires_at.getTime() <= now().getTime()) return reject('code_expired', 'auth_email_expired', 401, 'expired');
    if (!C.code(code) || !C.equalHash(C.codeHash(cfg.key, row.challenge_id, code), row.code_hash)) {
      const attempts = row.attempts + 1;
      await row.update({ attempts, ...(attempts >= C.LIMITS.maxAttempts ? { state: 'locked' } : {}) }, { transaction });
      return reject(attempts >= C.LIMITS.maxAttempts ? 'attempts_exhausted' : 'code_rejected',
        attempts >= C.LIMITS.maxAttempts ? 'auth_email_locked' : 'auth_email_invalid', attempts >= C.LIMITS.maxAttempts ? 429 : 401);
    }
    await row.update({ state: 'verified', verified_at: new Date(Math.floor(now().getTime() / 1000) * 1000) }, { transaction });
    unchanged(cfg);
    const result = await sessionService().authenticated(user, { transaction, emailChallengeId: row.challenge_id });
    const device = trustDevice ? await devices().grant(user, { sessionId: result.audit.sessionRef, transaction }) : null;
    await record({ outcome: 'success', reason: 'code_verified', userId: user.id_usuario, challengeId: row.challenge_id,
      sessionRef: result.audit.sessionRef }, transaction);
    return { body: result.body, device };
  }));
  const verify = async (token, code) => (await verifyWithOptions(token, code)).body;
  const verifyAndTrust = (token, code) => verifyWithOptions(token, code, true);
  return { begin, verify, verifyAndTrust, resend,
    rejectedCredentials: () => finish(async () => { enabled(); await record({ outcome: 'denied', reason: 'credentials_rejected' }); }),
    rejectedCredentialMutation: userId => finish(async () => { enabled(); await capacity();
      await record({ outcome: 'denied', reason: 'credentials_change_blocked', userId }); }),
    credentialReset: (userId, transaction) => finish(async () => { enabled(); if (!transaction) C.fail('auth_email_unavailable', 503);
      await capacity(transaction); await record({ action: 'auth.password_reset', outcome: 'success', reason: 'credentials_reset', userId }, transaction); }),
  };
}
const singleton = createService({ models: () => require('../../models') });
module.exports = { ...singleton, createService, mode: C.mode };
