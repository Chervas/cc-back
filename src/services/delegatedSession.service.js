'use strict';
const jwt = require('jsonwebtoken');
const { Op } = require('sequelize');
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');
const { isGlobalAdmin } = require('../lib/role-helpers');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TYPE = 'cc_delegated_access', ISSUER = 'clinicaclick', AUDIENCE = 'clinicaclick-delegated';
const HANDOFF_SECONDS = 60, SESSION_SECONDS = 900, MAX_CHILDREN = 5;
const positive = v => Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length
  && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const opaque = value => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
function fail(code = 'auth_invalid', status = 401) {
  throw Object.assign(Error(code), { code, status, name: status === 401 ? 'JsonWebTokenError' : 'Error' });
}
const ownSession = () => fail('delegated_operation_requires_own_session', 403);
function settings(env = process.env) {
  const flag = env.AUTH_DELEGATION_ENABLED || 'false';
  if (!['false', 'true'].includes(flag)) fail('auth_delegation_unavailable', 503);
  if (flag !== 'true') return { enabled: false };
  let origin;
  try { origin = new URL(env.AUTH_DELEGATION_ORIGIN); } catch { fail('auth_delegation_unavailable', 503); }
  if (env.AUTH_SESSION_MODE !== 'enforce' || env.AUTH_EMAIL_MFA_MODE !== 'enforce'
    || env.PLATFORM_AUDIT_AUTH_ENABLED !== 'true' || env.PLATFORM_AUDIT_AUTH_POLICY !== 'auth-durable-v1'
    || !env.JWT_SECRET || typeof env.JWT_SECRET !== 'string' || origin.origin !== env.AUTH_DELEGATION_ORIGIN
    || !['https:', 'http:'].includes(origin.protocol)
    || origin.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
    || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,79}$/.test(env.JOB_RUNTIME_NAMESPACE || '')) fail('auth_delegation_unavailable', 503);
  return { enabled: true, secret: env.JWT_SECRET, origin: origin.origin, runtimeNamespace: env.JOB_RUNTIME_NAMESPACE };
}
function isDelegatedToken(token) {
  return typeof token === 'string' && token.length <= 8192 && jwt.decode(token)?.type === TYPE;
}
function decode(token, cfg, at = new Date()) {
  if (typeof token !== 'string' || token.length > 8192) fail();
  const v = jwt.verify(token, cfg.secret, { algorithms: ['HS256'], issuer: ISSUER, audience: AUDIENCE,
    clockTimestamp: Math.floor(at.getTime() / 1000) });
  if (!v || Object.keys(v).sort().join(',') !== 'adminUserId,aud,delegationVersion,email,exp,iat,iss,jti,parentSessionRef,type,userId'
    || v.type !== TYPE || v.delegationVersion !== 1 || !positive(v.userId) || !positive(v.adminUserId)
    || !isGlobalAdmin(v.adminUserId) || isGlobalAdmin(v.userId) || v.adminUserId === v.userId
    || !UUID.test(v.jti) || !UUID.test(v.parentSessionRef) || typeof v.email !== 'string'
    || !Number.isInteger(v.iat) || !Number.isInteger(v.exp) || v.iat > Math.floor(at.getTime() / 1000)
    || v.exp <= v.iat || v.exp - v.iat > SESSION_SECONDS) fail();
  return v;
}
function createService({ models, normalSessions, audit, config = settings, now = () => new Date() }) {
  const db = () => typeof models === 'function' ? models() : models;
  const normal = () => normalSessions || require('./accessSession.service');
  const events = () => audit || require('./platformAudit.delegation');
  const cfg = () => { const value = config(); if (!value.enabled) fail('auth_delegation_unavailable', 503); return value; };
  const attributes = ['id_usuario', 'password_usuario', 'email_usuario', 'estado_cuenta', 'es_provisional',
    'nombre', 'apellidos', 'isProfesional', 'avatar'];
  const options = transaction => ({ logging: false, ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) });
  async function identities(adminId, targetId, transaction, creating = false) {
    const users = await db().Usuario.findAll({ ...options(transaction), attributes,
      where: { id_usuario: { [Op.in]: [adminId, targetId] } }, order: [['id_usuario', 'ASC']] });
    const actor = users.find(u => Number(u.id_usuario) === adminId), target = users.find(u => Number(u.id_usuario) === targetId);
    if (!isGlobalAdmin(adminId) || !normal().activeUser(actor)) fail();
    if (!positive(targetId) || isGlobalAdmin(targetId) || adminId === targetId || !normal().activeUser(target)) {
      fail(creating ? 'auth_delegation_target_forbidden' : 'auth_invalid', creating ? 403 : 401);
    }
    return { actor, target };
  }
  function context(row) {
    return Object.freeze({ delegationId: row.delegation_id, adminUserId: Number(row.admin_user_id),
      effectiveUserId: Number(row.effective_user_id), parentSessionRef: row.parent_session_id,
      childSessionRef: row.delegation_id, expiresAt: row.expires_at.toISOString(), runtimeNamespace: row.runtime_namespace });
  }
  async function lifecycle(row, action, reason, transaction) {
    await events().assertReady({ transaction });
    await events().lifecycle({ ...context(row), action, reason, correlationId: randomUUID(), occurredAt: now().toISOString() }, { transaction });
  }
  async function parent(row, transaction) {
    await normal().verifyNormalReference({ userId: Number(row.admin_user_id), sessionRef: row.parent_session_id,
      expiresAt: row.parent_expires_at }, { transaction });
  }
  async function checked(candidate, transaction, allowedState = 'active') {
    if (!candidate) fail();
    const c = cfg();
    const { actor, target } = await identities(Number(candidate.admin_user_id), Number(candidate.effective_user_id), transaction);
    await parent(candidate, transaction);
    const row = await db().DelegatedSession.findByPk(candidate.delegation_id, options(transaction));
    const at = now().getTime();
    if (!row || row.state !== allowedState || row.runtime_namespace !== c.runtimeNamespace || row.frontend_origin !== c.origin
      || row.admin_user_id !== candidate.admin_user_id || row.effective_user_id !== candidate.effective_user_id
      || row.parent_session_id !== candidate.parent_session_id || row.expires_at.getTime() <= at
      || row.expires_at.getTime() > row.parent_expires_at.getTime()
      || row.expires_at.getTime() > row.created_at.getTime() + SESSION_SECONDS * 1000
      || !equal(row.actor_credential_binding, normal().credentialBinding(actor))
      || !equal(row.target_credential_binding, normal().credentialBinding(target))) fail();
    await events().assertReady({ transaction });
    return { row, actor, target, config: c };
  }
  function checkOrigin(origin, c) { if (origin !== c.origin) fail('auth_delegation_origin_rejected', 403); }
  async function capabilities({ token }) {
    if (isDelegatedToken(token)) ownSession();
    const principal = await normal().verifyNormal(token);
    if (!isGlobalAdmin(principal.userId)) ownSession();
    const c = config(), base = { enabled: Boolean(c.enabled), ready: false, reason: 'auth_delegation_unavailable',
      sessionMaxSeconds: SESSION_SECONDS, handoffMaxSeconds: HANDOFF_SECONDS };
    if (!c.enabled) return base;
    if (principal.type !== 'cc_access' || principal.sessionVersion !== 1
      || !['["pwd","email"]', '["pwd","trusted_device"]'].includes(JSON.stringify(principal.amr))) {
      return { ...base, reason: 'auth_delegation_parent_mfa_required' };
    }
    try {
      await events().assertReady();
      await db().DelegatedSession.findOne({ attributes: ['delegation_id'], logging: false });
      return { ...base, ready: true, reason: null };
    } catch { return base; }
  }
  async function create({ token, targetUserId, pkceChallenge, tabNonce, origin }) {
    const c = cfg(); checkOrigin(origin, c);
    if (!positive(targetUserId) || !opaque(pkceChallenge) || !opaque(tabNonce)) fail('auth_delegation_request_invalid', 400);
    if (isDelegatedToken(token)) ownSession();
    const principal = await normal().verifyNormal(token);
    if (principal.type !== 'cc_access' || principal.sessionVersion !== 1 || !isGlobalAdmin(principal.userId)
      || !['["pwd","email"]', '["pwd","trusted_device"]'].includes(JSON.stringify(principal.amr))) ownSession();
    if (isGlobalAdmin(targetUserId) || principal.userId === targetUserId) fail('auth_delegation_target_forbidden', 403);
    const handoff = randomBytes(32).toString('base64url');
    return db().sequelize.transaction(async transaction => {
      const { actor, target } = await identities(principal.userId, targetUserId, transaction, true);
      await normal().verifyNormalReference({ userId: principal.userId, sessionRef: principal.jti,
        expiresAt: new Date(principal.exp * 1000) }, { transaction });
      const parentRow = await db().AuthSession.findByPk(principal.jti, options(transaction));
      if (!parentRow) fail();
      const at = new Date(Math.floor(now().getTime() / 1000) * 1000);
      const expiry = new Date(Math.min(at.getTime() + SESSION_SECONDS * 1000, principal.exp * 1000,
        parentRow.expires_at.getTime(), parentRow.absolute_expires_at.getTime()));
      if (expiry <= at) fail();
      // All creations serialize on the parent session lock, including distinct targets.
      const count = await db().DelegatedSession.count({ where: { parent_session_id: principal.jti,
        expires_at: { [Op.gt]: at }, [Op.or]: [{ state: 'active' }, { state: 'pending', handoff_expires_at: { [Op.gt]: at } }] }, transaction });
      if (count >= MAX_CHILDREN) fail('auth_delegation_limit', 429);
      const row = await db().DelegatedSession.create({ delegation_id: randomUUID(), admin_user_id: principal.userId,
        effective_user_id: targetUserId, parent_session_id: principal.jti, parent_expires_at: new Date(principal.exp * 1000),
        actor_credential_binding: normal().credentialBinding(actor), target_credential_binding: normal().credentialBinding(target),
        handoff_digest: hash(handoff), pkce_challenge: pkceChallenge, tab_nonce_digest: hash(tabNonce),
        handoff_expires_at: new Date(Math.min(at.getTime() + HANDOFF_SECONDS * 1000, expiry.getTime())),
        state: 'pending', created_at: at, expires_at: expiry, runtime_namespace: c.runtimeNamespace, frontend_origin: c.origin }, { transaction });
      await lifecycle(row, 'delegation.requested', 'admin_requested', transaction);
      return { delegationId: row.delegation_id, handoff, expiresIn: Math.floor((row.handoff_expires_at - now()) / 1000) };
    });
  }
  async function exchange({ handoff, pkceVerifier, tabNonce, origin }) {
    const c = cfg(); checkOrigin(origin, c);
    if (!opaque(handoff) || !opaque(tabNonce) || typeof pkceVerifier !== 'string'
      || !/^[A-Za-z0-9._~-]{43,128}$/.test(pkceVerifier)) fail('auth_delegation_handoff_invalid', 401);
    const candidate = await db().DelegatedSession.findOne({ where: { handoff_digest: hash(handoff) }, logging: false });
    return db().sequelize.transaction(async transaction => {
      const { row, target } = await checked(candidate, transaction, 'pending');
      if (row.handoff_consumed_at || row.handoff_expires_at.getTime() <= now().getTime()
        || !equal(row.handoff_digest, hash(handoff)) || !equal(row.tab_nonce_digest, hash(tabNonce))
        || !equal(row.pkce_challenge, createHash('sha256').update(pkceVerifier).digest('base64url'))) fail('auth_delegation_handoff_invalid');
      const at = new Date(Math.floor(now().getTime() / 1000) * 1000);
      await row.update({ state: 'active', activated_at: at, handoff_consumed_at: now() }, { transaction });
      await lifecycle(row, 'delegation.started', 'handoff_exchanged', transaction);
      const exp = Math.floor(row.expires_at.getTime() / 1000), iat = Math.floor(at.getTime() / 1000);
      const token = jwt.sign({ type: TYPE, delegationVersion: 1, userId: Number(target.id_usuario), email: target.email_usuario,
        adminUserId: Number(row.admin_user_id), parentSessionRef: row.parent_session_id, iat, exp }, c.secret,
      { algorithm: 'HS256', issuer: ISSUER, audience: AUDIENCE, jwtid: row.delegation_id });
      return { token, expiresIn: exp - iat, user: normal().projectUser(target), delegation: context(row) };
    });
  }
  async function verify(token) {
    const c = cfg(), v = decode(token, c, now());
    const candidate = await db().DelegatedSession.findByPk(v.jti, { logging: false });
    return db().sequelize.transaction(async transaction => {
      const { row, target } = await checked(candidate, transaction);
      if (v.userId !== row.effective_user_id || v.adminUserId !== row.admin_user_id
        || v.parentSessionRef !== row.parent_session_id || v.email !== target.email_usuario
        || v.iat * 1000 !== row.activated_at?.getTime() || v.exp * 1000 !== row.expires_at.getTime()) fail();
      return Object.freeze({ ...v, authDelegation: context(row) });
    });
  }
  async function verifyReference({ userId, sessionRef, expiresAt }, { transaction, purpose, requireEmail = false } = {}) {
    const policy = require('../lib/delegatedOperationPolicy');
    if (!positive(userId) || !UUID.test(sessionRef || '') || !(expiresAt instanceof Date)) fail();
    if (requireEmail || !policy.businessReferencePurpose(purpose)) ownSession();
    const candidate = await db().DelegatedSession.findByPk(sessionRef, { logging: false, transaction });
    const work = async tx => {
      const { row } = await checked(candidate, tx);
      if (row.effective_user_id !== userId || expiresAt.getTime() <= now().getTime()
        || expiresAt.getTime() > row.expires_at.getTime()) fail();
      return { userId, sessionRef, authDelegation: context(row) };
    };
    return transaction ? work(transaction) : db().sequelize.transaction(work);
  }
  async function refresh(token) {
    const verified = await verify(token);
    const user = await db().Usuario.findByPk(verified.userId, { attributes, logging: false });
    return { token, expiresIn: Math.max(0, verified.exp - Math.floor(now().getTime() / 1000)),
      user: normal().projectUser(user), delegation: verified.authDelegation };
  }
  async function revoke({ token, delegationId }) {
    const c = cfg();
    if (!UUID.test(delegationId || '')) fail('auth_delegation_request_invalid', 400);
    const child = isDelegatedToken(token), principal = child ? decode(token, c, now()) : await normal().verifyNormal(token);
    if (child ? principal.jti !== delegationId : principal.type !== 'cc_access'
      || principal.sessionVersion !== 1 || !isGlobalAdmin(principal.userId)) ownSession();
    const candidate = await db().DelegatedSession.findByPk(delegationId, { logging: false });
    return db().sequelize.transaction(async transaction => {
      if (!candidate || (child ? principal.userId !== candidate.effective_user_id
        || principal.adminUserId !== candidate.admin_user_id : principal.userId !== candidate.admin_user_id)) ownSession();
      // Revoking removes access, so an initiating administrator can also end
      // a child whose original parent/target has since been disabled.
      if (!child) await normal().verifyNormalReference({ userId: principal.userId, sessionRef: principal.jti,
        expiresAt: new Date(principal.exp * 1000) }, { transaction });
      const row = await db().DelegatedSession.findByPk(delegationId, options(transaction));
      if (!row || row.admin_user_id !== candidate.admin_user_id || row.effective_user_id !== candidate.effective_user_id
        || row.runtime_namespace !== c.runtimeNamespace || row.frontend_origin !== c.origin) fail();
      if (child && principal.parentSessionRef !== row.parent_session_id) fail();
      if (row.state === 'revoked') return { status: 'revoked', revoked: true, delegated: true };
      if (!['active', 'pending'].includes(row.state)) fail();
      const reason = child ? 'child_exit' : 'admin_revoked';
      await row.update({ state: 'revoked', ended_at: now(), end_reason: reason }, { transaction });
      await lifecycle(row, 'delegation.revoked', reason, transaction);
      return { status: 'revoked', revoked: true, delegated: true };
    });
  }
  async function hasReference({ userId, sessionRef }, { transaction } = {}) {
    if (!config().enabled || !positive(userId) || !UUID.test(sessionRef || '')) return false;
    return Boolean(await db().DelegatedSession.findOne({ where: { delegation_id: sessionRef, effective_user_id: userId },
      logging: false, transaction }));
  }
  async function expire() {
    const c = cfg(); let expired = 0;
    for (; expired < 100; expired++) {
      const changed = await db().sequelize.transaction(async transaction => {
        const row = await db().DelegatedSession.findOne({ where: { runtime_namespace: c.runtimeNamespace, state: { [Op.in]: ['pending', 'active'] },
          [Op.or]: [{ expires_at: { [Op.lte]: now() } }, { state: 'pending', handoff_expires_at: { [Op.lte]: now() } }] },
        ...options(transaction), order: [['expires_at', 'ASC']], skipLocked: true });
        if (!row) return false;
        await row.update({ state: 'expired', ended_at: now(), end_reason: 'expiry_observed' }, { transaction });
        await lifecycle(row, 'delegation.expired', 'expiry_observed', transaction); return true;
      });
      if (!changed) break;
    }
    return { expired };
  }
  return { capabilities, create, exchange, verify, verifyReference, refresh, revoke, hasReference, expire };
}
const singleton = createService({ models: () => require('../../models') });
module.exports = { ...singleton, createService, settings, isDelegatedToken, decode, TYPE, AUDIENCE, ownSession };
