'use strict';
// No AWS client, provider token, raw JWT or password is persisted by this service.
const jwt = require('jsonwebtoken');
const { randomUUID, createHmac, timingSafeEqual } = require('node:crypto');
const { Op } = require('sequelize');
const { isBlockedAuthEmail } = require('../lib/blocked-auth-emails');
const { isGlobalAdmin } = require('../lib/role-helpers');
const { UUID } = require('../../services/platform-audit/src/event');
const ISSUER = 'clinicaclick'; const AUDIENCE = 'clinicaclick-platform';
function fail(code = 'auth_invalid', status = 401) { throw Object.assign(Error(code), { code, status, name: status === 401 ? 'JsonWebTokenError' : 'Error' }); }
function settings(env = process.env) {
  const mode = env.AUTH_SESSION_MODE || 'legacy';
  const ttl = Number(env.AUTH_ACCESS_TOKEN_TTL_SECONDS || 43200);
  if (!['legacy', 'enforce'].includes(mode) || !Number.isInteger(ttl) || ttl < 300 || ttl > 86400
    || typeof env.JWT_SECRET !== 'string' || !env.JWT_SECRET) fail('auth_configuration_invalid', 503);
  if (mode === 'enforce' && (env.PLATFORM_AUDIT_AUTH_ENABLED !== 'true' || env.PLATFORM_AUDIT_AUTH_POLICY !== 'auth-durable-v1')) {
    fail('auth_configuration_invalid', 503);
  }
  return { mode, ttl, secret: env.JWT_SECRET };
}
function bearer(header) {
  if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_.-]{1,8192}$/i.test(header)) fail();
  return header.slice(7);
}
function decode(token, cfg, now = new Date()) {
  if (typeof token !== 'string' || token.length > 8192) fail();
  const v = jwt.verify(token, cfg.secret, { algorithms: ['HS256'], clockTimestamp: Math.floor(now.getTime() / 1000) });
  if (!v || !Number.isSafeInteger(v.userId) || v.userId <= 0 || v.userId > 2147483647
    || !Number.isInteger(v.exp) || isBlockedAuthEmail(v.email)) fail();
  const managed = Object.hasOwn(v, 'sessionVersion');
  if (managed && (v.sessionVersion !== 1 || v.type !== 'cc_access' || v.iss !== ISSUER || v.aud !== AUDIENCE
    || typeof v.jti !== 'string' || !UUID.test(v.jti) || !Number.isInteger(v.iat) || v.iat > Math.floor(now.getTime() / 1000)
    || v.exp <= v.iat || v.exp - v.iat > 86400)) fail();
  if (!managed && (cfg.mode === 'enforce' || v.type || v.iss || v.aud)) fail();
  return v;
}
function binding(user, secret) {
  return createHmac('sha256', secret).update('clinicaclick-session-credential-v1\0')
    .update(JSON.stringify([Number(user.id_usuario), user.password_usuario, user.email_usuario])).digest('hex');
}
function activeUser(user) { return user && user.estado_cuenta === 'activo' && !user.es_provisional
  && typeof user.password_usuario === 'string' && user.password_usuario.length > 0 && !isBlockedAuthEmail(user.email_usuario); }
function matches(user, row, secret) {
  const b = binding(user, secret);
  return typeof row.credential_binding === 'string' && /^[a-f0-9]{64}$/.test(row.credential_binding)
    && timingSafeEqual(Buffer.from(b, 'hex'), Buffer.from(row.credential_binding, 'hex'));
}
function projectUser(user) {
  return { id_usuario: Number(user.id_usuario), nombre: user.nombre, apellidos: user.apellidos, email_usuario: user.email_usuario,
    isProfesional: user.isProfesional === true, url_avatar: user.avatar || null, isAdmin: isGlobalAdmin(user.id_usuario) };
}
function createService({ models, audit, config = settings, now = () => new Date() }) {
  const db = () => typeof models === 'function' ? models() : models;
  const repo = () => audit || require('./platformAudit.repository').createRepository(db().PlatformAuditEvent);
  async function record(row, action, reason, transaction, effectiveAt) {
    const occurredAt = now().toISOString();
    await repo().append({ version: 2, eventId: randomUUID(), correlationId: randomUUID(), occurredAt,
      effectiveAt: effectiveAt || occurredAt, action, stage: 'completed', outcome: 'success', reason,
      actor: action === 'session.expired' ? { type: 'job', id: 'auth_session_expiry' } : { type: 'user', id: String(row.user_id) },
      subjectUserId: String(row.user_id), sessionRef: row.session_id, scope: { type: 'platform', id: null }, capturePolicy: 'managed-session-v1' }, { transaction });
  }
  function checkRow(v, user, row, cfg) {
    const at = now().getTime();
    if (!activeUser(user) || !row || row.user_id !== v.userId || row.state !== 'active' || !matches(user, row, cfg.secret)
      || row.expires_at.getTime() <= at || row.absolute_expires_at.getTime() <= at
      || v.exp * 1000 > row.expires_at.getTime() || v.exp * 1000 > row.absolute_expires_at.getTime()
      || v.iat * 1000 < row.issued_at.getTime()) fail();
  }
  async function verify(token) {
    const cfg = config(); const v = decode(token, cfg, now());
    if (!v.sessionVersion) return v; // Migration disabled: no models or DB access for legacy JWTs.
    // A single SELECT keeps the credential and session check on the same committed database snapshot.
    const [rows] = await db().sequelize.query('SELECT s.*, u.password_usuario, u.email_usuario, u.estado_cuenta, u.es_provisional '
      + 'FROM AuthSessions s JOIN Usuarios u ON u.id_usuario=s.user_id WHERE s.session_id=:id AND s.user_id=:userId LIMIT 1',
    { replacements: { id: v.jti, userId: v.userId }, logging: false });
    const row = rows[0];
    const user = row && { ...row, id_usuario: row.user_id };
    checkRow(v, user, row, cfg); return v;
  }
  // Call within a transaction that already locks the freshly authenticated user. All issuers share this method.
  async function issue(user, { transaction, parentToken, reason = 'credentials_verified', ttl, sessionRef = randomUUID() } = {}) {
    const cfg = config(); const seconds = ttl || cfg.ttl;
    if (cfg.mode === 'legacy' && !parentToken) return { token: jwt.sign({ userId: Number(user.id_usuario), email: user.email_usuario,
      isAdmin: isGlobalAdmin(user.id_usuario) }, cfg.secret, { expiresIn: seconds, jwtid: sessionRef }), expiresIn: seconds, sessionRef };
    const parent = parentToken ? decode(parentToken, cfg, now()) : null;
    if (parent && parent.userId !== Number(user.id_usuario)) fail();
    if (!parent?.sessionVersion && cfg.mode === 'legacy') return issue(user, { ttl: seconds, sessionRef });
    if (!transaction || !activeUser(user)) fail('auth_session_unavailable', 503);
    const health = await repo().health(now(), { includeUnresolved: false, transaction });
    if (health.pending >= 10000 || health.oldestAgeSeconds >= 3600) fail('auth_session_unavailable', 503);
    if (!parent && await db().AuthSession.count({ where: { user_id: Number(user.id_usuario), state: 'active',
      expires_at: { [Op.gt]: now() } }, transaction }) >= 100) fail('auth_session_limit', 503);
    const at = Math.floor(now().getTime() / 1000);
    let row;
    if (parent) {
      row = await db().AuthSession.findByPk(parent.jti, { transaction, lock: transaction.LOCK.UPDATE });
      checkRow(parent, user, row, cfg);
    }
    const absolute = row ? row.absolute_expires_at : new Date((at + 86400) * 1000);
    const expires = Math.min(at + seconds, absolute.getTime() / 1000);
    if (expires <= at) fail();
    if (row) await row.update({ expires_at: new Date(Math.max(expires * 1000, row.expires_at.getTime())) }, { transaction });
    else row = await db().AuthSession.create({ session_id: sessionRef, user_id: Number(user.id_usuario), issued_at: new Date(at * 1000),
      expires_at: new Date(expires * 1000), absolute_expires_at: absolute, state: 'active', credential_binding: binding(user, cfg.secret) }, { transaction });
    await record(row, parent ? 'session.renewed' : 'session.issued', parent ? 'token_verified' : reason, transaction);
    return { token: jwt.sign({ userId: Number(user.id_usuario), email: user.email_usuario, isAdmin: isGlobalAdmin(user.id_usuario),
      sessionVersion: 1, type: 'cc_access', iat: at, exp: expires }, cfg.secret,
    { algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE, jwtid: row.session_id }), expiresIn: expires - at, sessionRef: row.session_id };
  }
  async function authenticated(user, { parentToken, attempt } = {}) {
    const cfg = config(); const managedParent = parentToken && decode(parentToken, cfg, now()).sessionVersion;
    const work = async (fresh, transaction) => {
      if (transaction && (!activeUser(fresh) || binding(fresh, cfg.secret) !== binding(user, cfg.secret))) fail();
      fresh.ultimo_login = now(); await fresh.save({ fields: ['ultimo_login'], transaction });
      const issued = await issue(fresh, { transaction, parentToken });
      const outcome = { outcome: 'success', reason: parentToken ? 'token_verified' : 'credentials_verified', userId: fresh.id_usuario, sessionRef: issued.sessionRef };
      if (attempt) await attempt.complete(outcome, { transaction });
      return { status: 200, body: { token: issued.token, expiresIn: issued.expiresIn, user: projectUser(fresh) }, audit: outcome, auditCompleted: Boolean(attempt) };
    };
    if (cfg.mode === 'legacy' && !managedParent) return work(user);
    return db().sequelize.transaction(async transaction => work(await db().Usuario.findByPk(user.id_usuario,
      { transaction, lock: transaction.LOCK.UPDATE }), transaction));
  }
  async function revoke(token, all = false) {
    const cfg = config(); const v = decode(token, cfg, now());
    if (!v.sessionVersion) return { status: 'local_only', revoked: false };
    return db().sequelize.transaction(async transaction => {
      const user = await db().Usuario.findByPk(v.userId, { transaction, lock: transaction.LOCK.UPDATE });
      const current = await db().AuthSession.findByPk(v.jti, { transaction, lock: transaction.LOCK.UPDATE });
      if (!current || current.user_id !== v.userId) fail();
      // Repeated single-session logout can confirm the original revocation after a lost response.
      if (current.state === 'revoked' && !all) return { status: 'revoked', revoked: true };
      checkRow(v, user, current, cfg);
      const rows = all ? await db().AuthSession.findAll({ where: { user_id: v.userId, state: 'active', expires_at: { [Op.gt]: now() } },
        transaction, lock: transaction.LOCK.UPDATE }) : [current];
      for (const row of rows) {
        await row.update({ state: 'revoked', ended_at: now() }, { transaction });
        await record(row, 'session.revoked', all ? 'user_revoke_all' : 'user_sign_out', transaction);
      }
      return { status: 'revoked', revoked: true };
    });
  }
  async function expire() {
    let count = 0;
    for (; count < 100; count++) {
      const changed = await db().sequelize.transaction(async transaction => {
        const row = await db().AuthSession.findOne({ where: { state: 'active', expires_at: { [Op.lte]: now() } },
          order: [['expires_at', 'ASC']], transaction, lock: transaction.LOCK.UPDATE, skipLocked: true });
        if (!row) return false;
        await row.update({ state: 'expired', ended_at: row.expires_at }, { transaction });
        await record(row, 'session.expired', 'expiry_observed', transaction, row.expires_at.toISOString()); return true;
      });
      if (!changed) break;
    }
    return { expired: count };
  }
  return { verify, issue, authenticated, revoke, expire };
}
const singleton = createService({ models: () => require('../../models') });
module.exports = { ...singleton, createService, settings, bearer, decode, projectUser };
