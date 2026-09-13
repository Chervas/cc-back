'use strict';
// Transitional protection for global administrators while public runtimes still
// use legacy JWTs. No new table/key, provider request, or password is exposed.
const { createHmac, timingSafeEqual } = require('node:crypto');
const { isGlobalAdmin } = require('./role-helpers');
const { isBlockedAuthEmail } = require('./blocked-auth-emails');
const jwt = require('jsonwebtoken');
function reject() { throw Object.assign(Error('auth_invalid'), { code: 'auth_invalid', status: 401, name: 'JsonWebTokenError' }); }
function binding(user, secret) {
  if (typeof secret !== 'string' || !secret || !user || typeof user.password_usuario !== 'string'
    || !user.password_usuario || user.estado_cuenta !== 'activo' || user.es_provisional
    || typeof user.email_usuario !== 'string' || isBlockedAuthEmail(user.email_usuario)) reject();
  return createHmac('sha256', secret).update('clinicaclick-global-admin-credential-v1\0')
    .update(JSON.stringify([Number(user.id_usuario), user.password_usuario, user.email_usuario])).digest('hex');
}
function claims(user, secret) {
  return isGlobalAdmin(user?.id_usuario) ? { adminCredentialVersion: 1, adminCredentialBinding: binding(user, secret) } : {};
}
function assertMatches(decoded, user, secret) {
  if (!isGlobalAdmin(decoded?.userId)) return;
  if (!Number.isSafeInteger(decoded.userId) || Number(user?.id_usuario) !== decoded.userId
    || decoded.adminCredentialVersion !== 1 || typeof decoded.adminCredentialBinding !== 'string'
    || !/^[a-f0-9]{64}$/.test(decoded.adminCredentialBinding)) reject();
  if (decoded.email !== user.email_usuario || !timingSafeEqual(Buffer.from(binding(user, secret), 'hex'),
    Buffer.from(decoded.adminCredentialBinding, 'hex'))) reject();
}
async function verify(decoded, secret, { findUser } = {}) {
  if (!isGlobalAdmin(decoded?.userId)) return decoded;
  // Reject tokens issued before this cut before reading any account.
  if (!Number.isSafeInteger(decoded.userId) || decoded.adminCredentialVersion !== 1
    || typeof decoded.adminCredentialBinding !== 'string' || !/^[a-f0-9]{64}$/.test(decoded.adminCredentialBinding)) reject();
  const find = findUser || (id => require('../../models').Usuario.findByPk(id, {
    attributes: ['id_usuario','password_usuario','email_usuario','estado_cuenta','es_provisional'], logging: false,
  }));
  const user = await find(decoded.userId);
  assertMatches(decoded, user, secret); return decoded;
}
function bearer(header) {
  if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_.-]{1,8192}$/i.test(header)) reject();
  return header.slice(7);
}
async function verifyToken(token, secret, options) {
  if (typeof token !== 'string' || token.length > 8192) reject();
  const decoded = jwt.verify(token, secret, { algorithms: ['HS256'] });
  if (!decoded || !Number.isSafeInteger(decoded.userId) || decoded.userId <= 0 || !Number.isInteger(decoded.exp)
    || isBlockedAuthEmail(decoded.email)) reject();
  return verify(decoded, secret, options);
}
module.exports = { claims, assertMatches, verify, verifyToken, bearer };
