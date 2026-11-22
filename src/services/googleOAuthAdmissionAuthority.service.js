'use strict';

const { Op } = require('sequelize');
const C = require('./googleOAuthAdmissionAttempt.contract');
const { authorizeRequestedMarketingConnectionScope } = require('../lib/oauthMarketingScopeAccess');
const { isGlobalAdmin, MARKETING_WRITE_ROLES } = require('../lib/role-helpers');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const fail = (code, status) => { throw C.problem(code, status); };
function closed(error) {
  const status = error?.status || error?.httpStatus;
  return C.problem(status === 401 ? 'google_oauth_admission_session_required'
    : status === 403 ? 'google_oauth_admission_forbidden'
      : status === 409 ? 'google_oauth_admission_attempt_conflict'
        : status === 400 ? 'google_oauth_admission_attempt_invalid' : 'google_oauth_admission_attempt_unavailable',
  [400, 401, 403, 409].includes(status) ? status : 503);
}

// All dependencies are explicit. Importing this module loads no models, JWT
// secret, environment, provider client or current-connection authorization.
function createGoogleOAuthAdmissionAuthority({ models, sessions, now = () => new Date() } = {}) {
  if (!models?.Clinica?.findAll || !models?.UsuarioClinica?.findAll || !models?.sequelize?.transaction
    || typeof sessions?.verifyNormal !== 'function' || typeof sessions?.verifyNormalReference !== 'function') {
    fail('google_oauth_admission_attempt_unavailable', 503);
  }
  const liveTransaction = transaction => {
    if (!transaction?.LOCK?.UPDATE || transaction.finished) fail('google_oauth_admission_attempt_unavailable', 503);
  };
  async function scope(actorId, scopeKey, transaction) {
    liveTransaction(transaction);
    const [kind, id] = scopeKey.split(':'), locked = { transaction, lock: transaction.LOCK.UPDATE, raw: true, logging: false };
    // This also proves that a direct clinic exists. Group membership is read
    // under the same lock and must stay exactly equal to the captured set.
    const rows = await models.Clinica.findAll({ ...locked, attributes: ['id_clinica'],
      where: kind === 'group' ? { grupoClinicaId: Number(id) } : { id_clinica: Number(id) },
      order: [['id_clinica', 'ASC']], limit: C.MAX_CLINICS + 1 });
    const clinicIds = rows.map(row => Number(row.id_clinica));
    if (!clinicIds.length || clinicIds.length > C.MAX_CLINICS
      || clinicIds.some((value, i) => !Number.isSafeInteger(value) || value <= 0 || value > 2147483647
        || i > 0 && value <= clinicIds[i - 1])
      || kind === 'clinic' && (clinicIds.length !== 1 || clinicIds[0] !== Number(id))) {
      fail('google_oauth_admission_attempt_conflict', 409);
    }
    const result = await authorizeRequestedMarketingConnectionScope({ userId: actorId,
      clinicIdRaw: kind === 'clinic' ? Number(id) : null, groupIdRaw: kind === 'group' ? Number(id) : null,
      assignmentScopeRaw: kind, access: 'write', findGroupClinicIds: async () => clinicIds,
      findClinicGroupId: async () => { fail('google_oauth_admission_attempt_unavailable', 503); },
      authorizeClinicIds: async options => {
        if (isGlobalAdmin(options.userId)) return true;
        // Same accepted invitation + Marketing write-role policy as the
        // current Google broker scope, without inventing a connection first.
        const memberships = await models.UsuarioClinica.findAll({ ...locked, attributes: ['id_clinica'], where: {
          id_usuario: options.userId, id_clinica: { [Op.in]: options.clinicIds },
          rol_clinica: { [Op.in]: MARKETING_WRITE_ROLES },
          [Op.or]: [{ estado_invitacion: null }, { estado_invitacion: 'aceptada' }],
        } });
        return options.clinicIds.every(value => memberships.some(row => Number(row.id_clinica) === value));
      } });
    return result.clinicIds;
  }
  return Object.freeze({
    async capture(req, selection) {
      try {
        if (!C.exact(selection, ['attemptId', 'scopeKey', 'service'])) throw C.problem();
        // Snapshot the authenticated request before the first await. Mutable
        // req fields are never used as an authorization source afterwards.
        const header = req?.headers?.authorization, actorId = req?.userData?.userId;
        const sessionRef = req?.authSession?.id, seconds = req?.authSession?.expiresAt;
        if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_.-]{1,8192}$/i.test(header)
          || !Number.isSafeInteger(actorId) || actorId <= 0 || actorId > 2147483647
          || typeof sessionRef !== 'string' || !UUID.test(sessionRef)
          || !Number.isSafeInteger(seconds) || seconds <= 0 || !Number.isSafeInteger(seconds * 1000)) {
          fail('google_oauth_admission_session_required', 401);
        }
        const token = header.slice(7), original = Object.freeze({ ...selection });
        // Validate canonical scope/service/UUID using the existing contract;
        // this placeholder clinic set is replaced by the locked full scope.
        const scopeId = Number(String(original.scopeKey).split(':')[1]);
        C.input({ ...original, actorId, sessionRef, sessionExpiresAt: seconds * 1000, clinicIds: [scopeId] });
        const checkToken = async () => {
          const claims = await sessions.verifyNormal(token);
          if (!claims || claims.sessionVersion !== 1 || claims.type !== 'cc_access'
            || claims.userId !== actorId || claims.jti !== sessionRef || claims.exp !== seconds
            || seconds * 1000 <= C.clock(now())) fail('google_oauth_admission_session_required', 401);
        };
        const checkSession = async transaction => {
          liveTransaction(transaction); await checkToken();
          await sessions.verifyNormalReference({ userId: actorId, sessionRef, expiresAt: new Date(seconds * 1000) }, { transaction });
          if (seconds * 1000 <= C.clock(now())) fail('google_oauth_admission_session_required', 401);
        };
        await checkToken();
        const context = await models.sequelize.transaction(async transaction => {
          await checkSession(transaction);
          const clinicIds = await scope(actorId, original.scopeKey, transaction);
          await checkSession(transaction);
          return C.input({ ...original, actorId, sessionRef, sessionExpiresAt: seconds * 1000, clinicIds });
        });
        const binding = C.bindingDigest(context);
        return Object.freeze({ context,
          // The repository calls this before and after its locked work. Its
          // cloned context must match the original request, including JTI.
          async authorize(supplied, { transaction } = {}) {
            try {
              if (C.bindingDigest(supplied) !== binding) fail('google_oauth_admission_attempt_conflict', 409);
              await checkSession(transaction);
              const current = await scope(actorId, original.scopeKey, transaction);
              if (JSON.stringify(current) !== JSON.stringify(context.clinicIds)) fail('google_oauth_admission_attempt_conflict', 409);
              return true;
            } catch (error) { throw closed(error); }
          } });
      } catch (error) { throw closed(error); }
    },
  });
}

module.exports = { createGoogleOAuthAdmissionAuthority, closed };
