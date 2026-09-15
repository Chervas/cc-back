'use strict';
// Server-internal prerequisite for WhatsApp onboarding. No provider calls or
// public route: actor/session fields must be supplied by verified middleware.
const { randomUUID } = require('node:crypto');
const { Op, Transaction } = require('sequelize');
const C = require('./whatsappAuthorizationState.contract');
const { MARKETING_WRITE_ROLES, isGlobalAdmin } = require('../lib/role-helpers');
const scopeBlocks = require('./metaScopeBlock.service');
const TTL = 600000;
const known = new Set(['whatsapp_authorization_invalid', 'whatsapp_authorization_unavailable',
  'whatsapp_authorization_forbidden', 'whatsapp_authorization_conflict', 'whatsapp_authorization_expired',
  'whatsapp_authorization_consumed', 'whatsapp_authorization_cancelled', 'whatsapp_authorization_limit',
  'whatsapp_onboarding_disabled', 'whatsapp_onboarding_configuration_invalid', 'auth_invalid',
  'auth_configuration_invalid', 'meta_security_state_unavailable']);
function context(row) {
  return C.digest(JSON.stringify(['whatsapp-onboarding-v1', row.request_id, row.user_id, row.session_ref,
    row.session_expires_at.toISOString(), row.scope_type, row.scope_id, row.original_clinic_ids,
    row.scope_digest, row.created_at.toISOString(), row.expires_at.toISOString()]));
}
function validateRow(row, input, key) {
  if (!row || row.user_id !== input.userId || row.session_ref !== input.sessionRef
    || !Number.isFinite(row.session_expires_at?.getTime())
    || row.session_expires_at.getTime() > input.sessionExpiresAt * 1000) C.fail('whatsapp_authorization_forbidden', 403);
  if (!['clinic', 'group'].includes(row.scope_type) || !C.id(row.scope_id)
    || !Array.isArray(row.original_clinic_ids) || !row.original_clinic_ids.length || row.original_clinic_ids.length > 1000
    || row.original_clinic_ids.some((id, i, all) => !C.id(id) || i > 0 && id <= all[i - 1])
    || !['created_at', 'expires_at'].every(k => row[k] instanceof Date && Number.isFinite(row[k].getTime()))
    || row.expires_at <= row.created_at || row.expires_at - row.created_at > TTL
    || row.expires_at > row.session_expires_at || !['awaiting', 'claimed', 'cancelled'].includes(row.state)
    || !C.equalHash(context(row), row.context_digest) || !C.equalHash(C.digest(C.stateFor(key, row)), row.state_hash)) {
    C.fail('whatsapp_authorization_unavailable', 503);
  }
}
function createService({ models, sessions, audit, config = C.settings, now = () => new Date() } = {}) {
  const db = () => typeof models === 'function' ? models() : models || require('../../models');
  const sessionApi = () => sessions || require('./accessSession.service');
  const repo = () => audit || require('./platformAudit.repository').createRepository(db().PlatformAuditEvent);
  const locked = transaction => ({ transaction, lock: transaction.LOCK.UPDATE, raw: true });
  async function snapshot(scope, userId, transaction) {
    const clinics = await db().Clinica.findAll({ ...locked(transaction),
      where: scope.type === 'clinic' ? { id_clinica: scope.id } : { grupoClinicaId: scope.id },
      attributes: ['id_clinica', 'grupoClinicaId'], order: [['id_clinica', 'ASC']], limit: 1001 });
    if (!clinics.length || clinics.length > 1000 || clinics.some(c => !C.id(c.id_clinica)
      || !(c.grupoClinicaId === null || C.id(c.grupoClinicaId)))) C.fail('whatsapp_authorization_forbidden', 403);
    const ids = clinics.map(c => c.id_clinica);
    if (!isGlobalAdmin(userId)) {
      const membership = await db().UsuarioClinica.findAll({ ...locked(transaction),
        where: { id_usuario: userId, id_clinica: { [Op.in]: ids }, rol_clinica: { [Op.in]: MARKETING_WRITE_ROLES },
          [Op.or]: [{ estado_invitacion: 'aceptada' }, { estado_invitacion: null }] },
        attributes: ['id_clinica'], order: [['id_clinica', 'ASC']] });
      const allowed = new Set(membership.map(m => m.id_clinica));
      if (ids.some(id => !allowed.has(id))) C.fail('whatsapp_authorization_forbidden', 403);
    }
    if (await scopeBlocks.blocked(scope.type === 'clinic' ? { assignmentScope: 'clinic', clinicId: scope.id }
      : { assignmentScope: 'group', groupId: scope.id }, { models: db(), transaction })) C.fail('whatsapp_authorization_forbidden', 403);
    return { ids, digest: C.digest(JSON.stringify({ scope, clinics: clinics.map(c => ({ id: c.id_clinica, groupId: c.grupoClinicaId })) })) };
  }
  async function record(row, reason, transaction) {
    const at = now(); const health = await repo().health(at, { includeUnresolved: false, transaction });
    if (health.pending >= 10000 || health.oldestAgeSeconds >= 3600) C.fail('whatsapp_authorization_unavailable', 503);
    await repo().append({ version: 15, eventId: randomUUID(), correlationId: randomUUID(), occurredAt: at.toISOString(),
      action: 'integration.whatsapp.authorization_state', stage: 'completed', outcome: 'success', reason,
      actor: { type: 'user', id: String(row.user_id) }, scope: { type: row.scope_type, id: String(row.scope_id) },
      sessionRef: row.session_ref, requestRef: row.request_id, capturePolicy: 'whatsapp-onboarding-v1' }, { transaction });
  }
  function projection(row) {
    return { requestId: row.request_id, status: ['awaiting', 'claimed'].includes(row.state) && row.expires_at <= now() ? 'expired' : row.state,
      scope: { type: row.scope_type, id: row.scope_id }, clinicIds: [...row.original_clinic_ids], expiresAt: row.expires_at.toISOString(),
      // Internal binding evidence for the broker bridge; public DTOs omit hashes.
      scopeDigest: row.scope_digest, clinicSetDigest: C.digest(JSON.stringify(row.original_clinic_ids)) };
  }
  function available(row) {
    if (row.state === 'cancelled') C.fail('whatsapp_authorization_cancelled', 409);
    if (row.expires_at <= now()) C.fail('whatsapp_authorization_expired', 410);
  }
  async function run(operation, raw) {
    let cfg;
    try {
      const input = C.request(raw, operation); cfg = config();
      if (!Buffer.isBuffer(cfg?.key) || cfg.key.length !== 32) C.fail('whatsapp_onboarding_configuration_invalid', 503);
      return await db().sequelize.transaction({ isolationLevel: Transaction.ISOLATION_LEVELS.REPEATABLE_READ }, async transaction => {
        // The managed-session verifier locks user then session, serializing
        // issuance and matching logout/password-change order across processes.
        await sessionApi().verifyReference({ userId: input.userId, sessionRef: input.sessionRef,
          expiresAt: new Date(input.sessionExpiresAt * 1000) }, { transaction, requireEmail: true });
        const R = db().WhatsappAuthorizationState;
        // Unlocked discovery only supplies the scope for lock ordering. The
        // authoritative row is read again under lock and validated below.
        const hint = operation === 'issue' ? null : await R.findByPk(input.requestId, { transaction, raw: true });
        if (operation !== 'issue' && (!hint || hint.user_id !== input.userId || hint.session_ref !== input.sessionRef)) {
          C.fail('whatsapp_authorization_forbidden', 403);
        }
        const scope = input.scope || { type: hint.scope_type, id: hint.scope_id };
        const current = operation === 'cancel' ? null : await snapshot(scope, input.userId, transaction);
        let row = await R.findByPk(input.requestId, { ...locked(transaction) });
        if (operation === 'issue' && !row) {
          const at = now(); const expires = new Date(Math.min(at.getTime() + TTL, input.sessionExpiresAt * 1000));
          if (expires <= at) C.fail('whatsapp_authorization_expired', 410);
          if (await R.count({ where: { user_id: input.userId, state: { [Op.in]: ['awaiting', 'claimed'] }, expires_at: { [Op.gt]: at } }, transaction }) >= 5
            || await R.count({ where: { user_id: input.userId, created_at: { [Op.gte]: new Date(at.getTime() - 3600000) } }, transaction }) >= 10) {
            C.fail('whatsapp_authorization_limit', 429);
          }
          row = { request_id: input.requestId, user_id: input.userId, session_ref: input.sessionRef,
            session_expires_at: new Date(input.sessionExpiresAt * 1000), scope_type: scope.type, scope_id: scope.id,
            original_clinic_ids: current.ids, scope_digest: current.digest, created_at: at, expires_at: expires, state: 'awaiting',
            code_hash: null, claimed_at: null, cancelled_at: null };
          row.context_digest = context(row); row.state_hash = C.digest(C.stateFor(cfg.key, row));
          await R.create(row, { transaction }); await record(row, 'state_issued', transaction);
          return { ...projection(row), state: C.stateFor(cfg.key, row) };
        }
        validateRow(row, input, cfg.key);
        if (scope.type !== row.scope_type || scope.id !== row.scope_id || current && (current.digest !== row.scope_digest
          || JSON.stringify(current.ids) !== JSON.stringify(row.original_clinic_ids))) C.fail('whatsapp_authorization_conflict', 409);
        if (operation === 'cancel') {
          // Cancellation may proceed after membership loss or a scope block.
          // It still requires the original valid MFA session; it never deletes.
          if (row.state !== 'cancelled') {
            row.state = 'cancelled'; row.cancelled_at = now();
            await R.update({ state: row.state, cancelled_at: row.cancelled_at }, { where: { request_id: row.request_id }, transaction });
            await record(row, 'state_cancelled', transaction);
          }
          return projection(row);
        }
        if (operation === 'status') return projection(row);
        available(row);
        if (operation === 'assertClaimActive') {
          if (row.state !== 'claimed' || typeof row.code_hash !== 'string' || !/^[a-f0-9]{64}$/.test(row.code_hash) || !(row.claimed_at instanceof Date)) {
            C.fail('whatsapp_authorization_conflict', 409);
          }
          return projection(row);
        }
        if (row.state !== 'awaiting') C.fail('whatsapp_authorization_consumed', 409);
        if (operation === 'issue') return { ...projection(row), state: C.stateFor(cfg.key, row) };
        if (!C.equalHash(C.digest(input.state), row.state_hash)) C.fail('whatsapp_authorization_invalid', 400);
        row.state = 'claimed'; row.claimed_at = now(); row.code_hash = C.digest(input.code);
        try {
          await R.update({ state: row.state, claimed_at: row.claimed_at, code_hash: row.code_hash }, { where: { request_id: row.request_id }, transaction });
        } catch (error) {
          // The code fingerprint is globally unique across requests, users and
          // scopes; another state cannot authorize a second exchange of it.
          if (error?.name === 'SequelizeUniqueConstraintError') C.fail('whatsapp_authorization_consumed', 409);
          throw error;
        }
        await record(row, 'state_claimed', transaction);
        // Only the winner may dispatch. A lost response requires broker status
        // reconciliation, never another exchange with this or a fallback token.
        return { ...projection(row), mayExchange: true };
      });
    } catch (error) {
      if (known.has(error?.code)) C.fail(error.code, error.status || error.httpStatus || 503);
      C.fail('whatsapp_authorization_unavailable', 503);
    } finally { if (Buffer.isBuffer(cfg?.key)) cfg.key.fill(0); }
  }
  return Object.fromEntries(['issue', 'claim', 'assertClaimActive', 'status', 'cancel'].map(op => [op, input => run(op, input)]));
}
module.exports = { createService, ...createService() };
