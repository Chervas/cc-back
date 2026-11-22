'use strict';
const { Op } = require('sequelize');
const C = require('./googleOAuthAdmissionAttempt.contract');
const R = require('./googleOAuthAdmissionReturn.contract');
const O = require('./googleOAuthAdmissionOwner.adapter');
const { closed } = require('./googleOAuthAdmissionAuthority.service');
const { authorizeRequestedMarketingConnectionScope } = require('../lib/oauthMarketingScopeAccess');
const { isGlobalAdmin, MARKETING_WRITE_ROLES } = require('../lib/role-helpers');
const MAX_SESSIONS = 100;
const plain = value => value?.get ? value.get({ plain: true }) : value;
const fail = (status = 503) => { throw C.problem(status === 401 ? 'google_oauth_admission_session_required'
  : status === 403 ? 'google_oauth_admission_forbidden' : status === 409 ? 'google_oauth_admission_attempt_conflict'
    : 'google_oauth_admission_attempt_unavailable', status); };

// This is an unexposed callback locator, not an OAuth exchange or publication
// service. Handles contain original session references only in this WeakMap.
function createGoogleOAuthAdmissionReturnLocator({ models, sessions, authority, clientId, redirectUri, now = () => new Date() } = {}) {
  const attempts = models?.GoogleOAuthAdmissionAttempt, returns = models?.GoogleOAuthAdmissionReturn;
  if (typeof models?.sequelize?.transaction !== 'function' || typeof attempts?.findByPk !== 'function'
    || typeof returns?.findByPk !== 'function' || typeof returns?.findOne !== 'function' || typeof returns?.create !== 'function'
    || typeof models?.GoogleOAuthBrokerRequest?.findAll !== 'function' || typeof models?.Usuario?.findByPk !== 'function'
    || typeof models?.AuthSession?.findAll !== 'function' || typeof models?.Clinica?.findAll !== 'function'
    || typeof models?.UsuarioClinica?.findAll !== 'function' || typeof sessions?.verifyNormalReference !== 'function'
    || typeof authority?.capture !== 'function') fail();
  // Reuse the typed Owner adapter's exact public application configuration
  // validation without constructing a real transport or calling execute.
  O.createGoogleOAuthAdmissionOwner({ client: { execute() { fail(); } }, clientId, redirectUri });
  const handles = new WeakMap();
  const storedAttempt = value => { try { return C.record(plain(value)); } catch { fail(); } };
  const locked = transaction => {
    if (!transaction?.LOCK?.UPDATE || transaction.finished) fail();
    return { transaction, lock: transaction.LOCK.UPDATE, raw: true, logging: false };
  };
  const live = row => {
    if (+row.session_expires_at <= C.clock(now())) fail(401);
    if (row.state !== 'prepared' || +row.expires_at <= C.clock(now())) fail(409);
  };
  async function noManagedCollision(hashed, transaction) {
    const rows = await models.GoogleOAuthBrokerRequest.findAll({ ...locked(transaction),
      where: { state_hash: hashed }, attributes: ['flow_id'], limit: 2 });
    if (rows.length) fail(409);
  }
  async function authorize(context, transaction) {
    const options = locked(transaction);
    C.assertLive(context, now());
    await sessions.verifyNormalReference({ userId: context.actorId, sessionRef: context.sessionRef,
      expiresAt: new Date(context.sessionExpiresAt) }, { transaction });
    const [kind, id] = context.scopeKey.split(':');
    const clinics = await models.Clinica.findAll({ ...options, attributes: ['id_clinica'],
      where: kind === 'group' ? { grupoClinicaId: Number(id) } : { id_clinica: Number(id) },
      order: [['id_clinica', 'ASC']], limit: C.MAX_CLINICS + 1 });
    const ids = clinics.map(row => Number(row.id_clinica));
    if (JSON.stringify(ids) !== JSON.stringify(context.clinicIds)) fail(409);
    await authorizeRequestedMarketingConnectionScope({ userId: context.actorId,
      clinicIdRaw: kind === 'clinic' ? Number(id) : null, groupIdRaw: kind === 'group' ? Number(id) : null,
      assignmentScopeRaw: kind, access: 'write', findGroupClinicIds: async () => ids,
      findClinicGroupId: async () => { fail(); }, authorizeClinicIds: async value => {
        if (isGlobalAdmin(value.userId)) return true;
        const memberships = await models.UsuarioClinica.findAll({ ...options, attributes: ['id_clinica'], where: {
          id_usuario: value.userId, id_clinica: { [Op.in]: ids }, rol_clinica: { [Op.in]: MARKETING_WRITE_ROLES },
          [Op.or]: [{ estado_invitacion: null }, { estado_invitacion: 'aceptada' }],
        } });
        return ids.every(clinic => memberships.some(row => Number(row.id_clinica) === clinic));
      } });
    C.assertLive(context, now());
  }
  async function recoverSession(stored, transaction) {
    const options = locked(transaction), at = new Date(C.clock(now()));
    if (+stored.session_expires_at <= +at) fail(401);
    // Match existing session/reference lock order. The indexed user/state
    // lookup projects only IDs and is bounded; no credential fields are read.
    const user = await models.Usuario.findByPk(stored.actor_user_id, { ...options, attributes: ['id_usuario'] });
    if (!user) fail(401);
    const rows = await models.AuthSession.findAll({ ...options, attributes: ['session_id'], where: {
      user_id: stored.actor_user_id, state: 'active', expires_at: { [Op.gt]: at }, absolute_expires_at: { [Op.gt]: at },
    }, order: [['session_id', 'ASC']], limit: MAX_SESSIONS + 1 });
    if (rows.length > MAX_SESSIONS || new Set(rows.map(row => row.session_id)).size !== rows.length) fail();
    const matching = rows.filter(row => C.sessionHash(row.session_id) === stored.session_ref_hash);
    if (matching.length !== 1) fail(401);
    const sessionRef = matching[0].session_id;
    await sessions.verifyNormalReference({ userId: stored.actor_user_id, sessionRef,
      expiresAt: new Date(stored.session_expires_at) }, { transaction });
    return sessionRef;
  }
  function contextFrom(row, sessionRef) {
    const attempt = storedAttempt(row);
    const context = C.input({ attemptId: attempt.attempt_id, actorId: attempt.actor_user_id, sessionRef,
      sessionExpiresAt: +attempt.session_expires_at, scopeKey: attempt.scope_key,
      clinicIds: JSON.parse(attempt.clinic_ids), service: attempt.service });
    C.assertBound(attempt, context);
    return context;
  }
  async function verify(context, expected, transaction) {
    // User/session/clinic lock order is shared with authenticated registration.
    await authorize(context, transaction);
    const attempt = storedAttempt(await attempts.findByPk(context.attemptId, locked(transaction)));
    C.assertBound(attempt, context); live(attempt);
    const stored = R.record(plain(await returns.findByPk(expected.state_hash, locked(transaction))));
    R.assertAttempt(stored, attempt);
    if (R.FIELDS.some(key => stored[key] instanceof Date ? +stored[key] !== +expected[key] : stored[key] !== expected[key])) fail(409);
    await noManagedCollision(stored.state_hash, transaction);
    await authorize(context, transaction); live(attempt);
    return attempt;
  }
  const safeError = (error, recognized) => Object.assign(closed(error), recognized ? { recognized: true } : {});
  return Object.freeze({
    async registerBegin(req, selection, suppliedResult) {
      try {
        // Captured public result consists only of primitives. The URL is read
        // in RAM, validated, hashed and never stored, logged or returned here.
        const result = Object.freeze({ ...suppliedResult });
        const captured = await authority.capture(req, selection), context = C.input(captured.context);
        return await models.sequelize.transaction(async transaction => {
          if (await captured.authorize(context, { transaction }) !== true) fail(403);
          const attempt = storedAttempt(await attempts.findByPk(context.attemptId, locked(transaction)));
          C.assertBound(attempt, context); live(attempt);
          const hashed = R.beginStateHash(result, attempt, { clientId, redirectUri });
          await noManagedCollision(hashed, transaction);
          const existing = await returns.findByPk(hashed, locked(transaction));
          const byAttempt = await returns.findOne({ ...locked(transaction), where: { attempt_id: context.attemptId } });
          let stored, replayed;
          if (existing || byAttempt) {
            stored = R.record(plain(existing || byAttempt)); R.assertAttempt(stored, attempt);
            if (stored.state_hash !== hashed || existing && byAttempt
              && R.record(plain(byAttempt)).state_hash !== stored.state_hash) fail(409);
            replayed = true;
          } else {
            stored = R.fromAttempt(attempt, hashed, now());
            const created = R.record(plain(await returns.create(stored, { transaction, logging: false })));
            if (R.FIELDS.some(key => stored[key] instanceof Date ? +stored[key] !== +created[key] : stored[key] !== created[key])) fail();
            replayed = false;
          }
          if (await captured.authorize(context, { transaction }) !== true) fail(403);
          live(attempt);
          return Object.freeze({ attemptId: context.attemptId, returnPath: R.RETURN_PATH, expiresAt: +stored.expires_at, replayed });
        });
      } catch (error) { throw safeError(error, false); }
    },
    async resolve(input) {
      let recognized = false;
      try {
        if (!C.exact(input, ['state'])) throw C.problem();
        const hashed = R.stateHash(input.state);
        const initial = await returns.findByPk(hashed, { raw: true, logging: false });
        if (!initial) return Object.freeze({ recognized: false });
        recognized = true;
        const stored = R.record(plain(initial));
        const context = await models.sequelize.transaction(async transaction => {
          const sessionRef = await recoverSession(stored, transaction);
          const row = await attempts.findByPk(stored.attempt_id, { transaction, raw: true, logging: false });
          const value = contextFrom(row, sessionRef);
          await verify(value, stored, transaction); return value;
        });
        const handle = Object.freeze({}); handles.set(handle, { context, stored });
        return Object.freeze({ recognized: true, locator: handle });
      } catch (error) { throw safeError(error, recognized); }
    },
    // Internal handoff only: no JWT/JTI is exposed. A callback dispatcher must
    // revalidate before/after its Owner call and keep the Owner one-use journal.
    async revalidate(handle) {
      try {
        const bound = handles.get(handle); if (!bound) fail(409);
        return await models.sequelize.transaction(async transaction => {
          const attempt = await verify(bound.context, bound.stored, transaction);
          return Object.freeze({ proof: O.proof({ attemptId: bound.context.attemptId,
            bindingDigest: C.bindingDigest(bound.context), service: bound.context.service, expiresAt: +attempt.expires_at }),
          scope: O.envelope(bound.context), returnPath: R.RETURN_PATH });
        });
      } catch (error) { throw safeError(error, true); }
    },
  });
}
module.exports = { createGoogleOAuthAdmissionReturnLocator, MAX_SESSIONS };
