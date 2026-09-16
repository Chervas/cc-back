'use strict';
const { randomUUID, randomBytes, createHmac } = require('node:crypto');
const C = require('./authEmailChallenge.contract');
const DAYS = 60;
const COOKIE = '__Host-cc_trusted_device';
const DEV_COOKIE = 'cc_dev_trusted_device';
const tokenValid = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const hash = (key, purpose, value = '') => createHmac('sha256', key).update('clinicaclick-trusted-device-v1\0' + purpose + '\0' + value).digest('hex');
const grantBinding = (key, row) => hash(key, 'grant', JSON.stringify([row.device_id, Number(row.user_id), row.creation_session_id, row.credential_binding, row.email_verified_at.getTime(), row.created_at.getTime(), row.expires_at.getTime()]));
function invalid() { throw Object.assign(Error('auth_trusted_device_invalid'), { code: 'auth_trusted_device_invalid', status: 401, name: 'JsonWebTokenError' }); }
function localDevRequest(req, env = process.env) {
  const base = env.EMAIL_PUBLIC_APP_URL;
  return env.DEV_SECURITY_PROFILE === 'isolated-security-v2' && env.RUNTIME_NAMESPACE === 'dev'
    && env.JOB_RUNTIME_NAMESPACE === 'dev' && env.QUEUE_PREFIX === 'dev'
    && env.DB_NAME === 'clinicaclick_dev_isolated'
    && ['http://localhost:4200', 'http://localhost:4203'].includes(base)
    && req.secure === false && req.get('origin') === base
    && ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket?.remoteAddress)
    && ['127.0.0.1:3004', 'localhost:3004', new URL(base).host].includes(req.get('host'))
    && (!req.get('sec-fetch-site') || req.get('sec-fetch-site') === 'same-origin');
}
function browserRequest(req, env = process.env) {
  const origin = req.get('origin'); const site = req.get('sec-fetch-site');
  return localDevRequest(req, env) || req.secure === true && (!origin || origin === 'https://' + req.get('host'))
    && (!site || site === 'same-origin' || site === 'none');
}
function cookie(req, env = process.env) {
  if (!browserRequest(req, env)) return null;
  const name = localDevRequest(req, env) ? DEV_COOKIE : COOKIE;
  const values = String(req.headers.cookie || '').split(';').map(v => v.trim()).filter(v => v.startsWith(name + '='));
  if (values.length !== 1) return null;
  const value = values[0].slice(name.length + 1);
  return tokenValid(value) ? value : null;
}
function setCookie(res, device, req, env = process.env) {
  const local = req && localDevRequest(req, env);
  res.cookie(local ? DEV_COOKIE : COOKIE, device.token, { secure: !local, httpOnly: true, sameSite: 'strict', path: '/',
    maxAge: Math.max(0, device.expiresAt.getTime() - Date.now()), expires: device.expiresAt });
}
function clearCookie(res, req, env = process.env) {
  const local = req && localDevRequest(req, env);
  res.clearCookie(local ? DEV_COOKIE : COOKIE, { secure: !local, httpOnly: true, sameSite: 'strict', path: '/' });
}
function createService({ models, credentialBinding, config = C.settings, now = () => new Date() }) {
  const db = () => typeof models === 'function' ? models() : models;
  function settings() { const cfg = config(); if (cfg.mode !== 'enforce' || !Buffer.isBuffer(cfg.key) || cfg.key.length !== 32) C.fail('auth_email_unavailable', 503); return cfg; }
  function valid(row, user, cfg) {
    return row && row.user_id === Number(user.id_usuario) && row.revoked_at === null
      && row.expires_at instanceof Date && row.expires_at.getTime() > now().getTime()
      && row.created_at instanceof Date && row.created_at.getTime() <= now().getTime()
      && row.email_verified_at instanceof Date && row.email_verified_at.getTime() <= row.created_at.getTime()
      && C.equalHash(row.credential_binding, credentialBinding(user))
      && C.equalHash(row.key_binding, grantBinding(cfg.key, row));
  }
  async function grant(user, { sessionId, transaction }) {
    if (!transaction) C.fail('auth_email_unavailable', 503);
    const cfg = settings();
    const session = await db().AuthSession.findByPk(sessionId, { transaction, lock: transaction.LOCK.UPDATE });
    if (!session || session.user_id !== Number(user.id_usuario) || session.authentication_method !== 'password_email'
      || session.state !== 'active' || session.expires_at.getTime() <= now().getTime()
      || !C.equalHash(session.credential_binding, credentialBinding(user))) invalid();
    const proof = await db().AuthEmailChallenge.findByPk(session.email_challenge_id, { transaction, lock: transaction.LOCK.UPDATE });
    if (!proof || proof.state !== 'used' || proof.consumed_session_id !== sessionId || proof.user_id !== session.user_id
      || proof.verified_at.getTime() !== session.email_verified_at.getTime()
      || proof.expires_at.getTime() <= now().getTime() || !C.equalHash(proof.credential_binding, credentialBinding(user))) invalid();
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(now().getTime() + DAYS * 86400000);
    const record = { device_id: randomUUID(), user_id: session.user_id,
      token_hash: hash(cfg.key, 'token', token),
      credential_binding: credentialBinding(user), creation_session_id: sessionId,
      email_verified_at: session.email_verified_at, created_at: now(), expires_at: expiresAt, revoked_at: null, last_used_at: null };
    await db().AuthTrustedDevice.create({ ...record, key_binding: grantBinding(cfg.key, record) }, { transaction });
    return { token, expiresAt };
  }
  async function resolve(user, token, { transaction }) {
    if (!transaction || !tokenValid(token)) invalid();
    const cfg = settings();
    const row = await db().AuthTrustedDevice.findOne({ where: { user_id: Number(user.id_usuario), token_hash: hash(cfg.key, 'token', token) }, transaction, lock: transaction.LOCK.UPDATE });
    if (!valid(row, user, cfg)) invalid();
    await row.update({ last_used_at: now() }, { transaction });
    return row;
  }
  async function verifySession(session, user, { transaction } = {}) {
    const row = await db().AuthTrustedDevice.findByPk(session.trusted_device_id, { transaction, logging: false });
    if (!valid(row, user, settings()) || session.email_verified_at.getTime() !== row.email_verified_at.getTime()
      || session.absolute_expires_at.getTime() > row.expires_at.getTime()) invalid();
  }
  async function revokeAll(userId, transaction) {
    if (!transaction) C.fail('auth_email_unavailable', 503);
    await db().AuthTrustedDevice.update({ revoked_at: now() }, { where: { user_id: userId, revoked_at: null }, transaction });
  }
  return { grant, resolve, verifySession, revokeAll };
}
module.exports = { createService, DAYS, COOKIE, DEV_COOKIE, tokenValid, browserRequest, cookie, setCookie, clearCookie };
