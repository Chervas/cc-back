'use strict';

const { Op } = require('sequelize');
const { activeUser } = require('./accessSession.service');

const FEATURES = Object.freeze(['patients.view', 'patients.sensitive.view']);
const MAX_CLINICS = 100;
const MAX_PAIRS = 1000;
const positive = value => ['string', 'number'].includes(typeof value)
  && /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value))
  && Number(value) <= 2147483647 ? Number(value) : null;
const problem = (status, code) => Object.assign(new Error(code), { status, code });
const denied = () => problem(403, 'review_care_forbidden');
const unauthenticated = () => problem(401, 'auth_invalid');
const unavailable = () => problem(503, 'review_care_access_unavailable');
const invalid = () => problem(400, 'review_care_scope_invalid');
const plain = row => row && typeof row.toJSON === 'function' ? row.toJSON() : row;

function clinicSet(values) {
  if (!Array.isArray(values) || !values.length || values.length > MAX_CLINICS
    || values.some(value => positive(value) === null)) throw invalid();
  return [...new Set(values.map(Number))].sort((a, b) => a - b);
}

function pairSet(values) {
  if (!Array.isArray(values) || values.length > MAX_PAIRS) throw invalid();
  const pairs = new Map();
  for (const value of values) {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).sort().join(',') !== 'clinicId,patientId'
      || !positive(value.patientId) || !positive(value.clinicId)) throw invalid();
    const pair = { patientId: Number(value.patientId), clinicId: Number(value.clinicId) };
    pairs.set(`${pair.patientId}:${pair.clinicId}`, pair);
  }
  if (new Set([...pairs.values()].map(pair => pair.clinicId)).size > MAX_CLINICS) throw invalid();
  return [...pairs.values()].sort((a, b) => a.patientId - b.patientId || a.clinicId - b.clinicId);
}

function storageError(error) {
  return error?.code === 'review_care_forbidden' || error?.code === 'review_care_scope_invalid'
    ? error : unavailable();
}

/** Access only: no imported record, date, contact, HOLD, queue or transport is read or changed here. */
function createReviewCareAccess({ db, sessions, canUserAccessFeature } = {}) {
  if (!db || !sessions || typeof sessions.bearer !== 'function' || typeof sessions.verify !== 'function'
    || typeof canUserAccessFeature !== 'function') throw unavailable();

  async function actor(actorId) {
    const user = plain(await db.Usuario.findByPk(actorId, {
      attributes: ['id_usuario', 'estado_cuenta', 'es_provisional', 'password_usuario', 'email_usuario'],
      raw: true, logging: false,
    }));
    // Reuse the ordinary account-state/blocked-login policy. No local admin or
    // marketing role is an alternative to a current, active account.
    if (!user || Number(user.id_usuario) !== actorId || !activeUser(user)) throw denied();
  }

  async function existingClinics(clinicIds) {
    const rows = await db.Clinica.findAll({
      where: { id_clinica: { [Op.in]: clinicIds } }, attributes: ['id_clinica'], raw: true, logging: false,
    });
    const found = new Set(rows.map(row => Number(plain(row).id_clinica)));
    if (clinicIds.some(id => !found.has(id))) throw denied();
  }

  async function assertActorClinics({ actorId, clinicIds } = {}) {
    actorId = positive(actorId);
    if (!actorId) throw unauthenticated();
    const ids = clinicSet(clinicIds);
    try {
      await actor(actorId);
      await existingClinics(ids);
      // The central policy owns membership, direction profiles, clinic/group
      // overrides and its existing global-admin semantics. Never cache or
      // replace these decisions with Marketing's staff-role scope check.
      for (const clinicId of ids) for (const featureKey of FEATURES) {
        if (await canUserAccessFeature({ actorId, clinicId, featureKey }) !== true) throw denied();
      }
      await actor(actorId);
      return { actorId, clinicIds: ids };
    } catch (error) { throw storageError(error); }
  }

  function httpAuthority(req) {
    const actorId = positive(req?.userData?.userId);
    if (!actorId) throw unauthenticated();
    let token;
    try { token = sessions.bearer(req?.headers?.authorization); }
    catch (_) { throw unauthenticated(); }
    if (typeof token !== 'string' || !token) throw unauthenticated();

    async function verify() {
      try {
        const claims = await sessions.verify(token);
        if (positive(claims?.userId) !== actorId) throw unauthenticated();
        const sessionRef = claims.sessionVersion || claims.authDelegation ? claims.jti : null;
        if (sessionRef !== null && (typeof sessionRef !== 'string' || !sessionRef)) throw unauthenticated();
        return { actorId, sessionRef };
      } catch (error) {
        if (error?.status === 401 || ['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error?.name)) {
          throw unauthenticated();
        }
        if (error?.status === 403) throw denied();
        throw unavailable();
      }
    }

    // phase is descriptive only. Before/after reads always perform the same
    // fresh checks; callers cannot request a weaker phase. Capture the original
    // bearer in RAM rather than constructing a synthetic req for background work.
    return Object.freeze({ actorId, async authorize({ clinicId } = {}) {
      const first = await verify();
      await assertActorClinics({ actorId, clinicIds: [clinicId] });
      const latest = await verify();
      if (latest.sessionRef !== first.sessionRef) throw unauthenticated();
      return latest;
    } });
  }

  async function assertPatientPairs({ pairs } = {}) {
    const requested = pairSet(pairs);
    if (!requested.length) return [];
    const patientIds = [...new Set(requested.map(pair => pair.patientId))];
    const clinicIds = [...new Set(requested.map(pair => pair.clinicId))];
    try {
      await existingClinics(clinicIds);
      const [patients, links] = await Promise.all([
        db.Paciente.findAll({ where: { id_paciente: { [Op.in]: patientIds }, fecha_baja: null },
          attributes: ['id_paciente', 'clinica_id', 'fecha_baja'], raw: true, logging: false }),
        db.PacienteClinica.findAll({ where: { paciente_id: { [Op.in]: patientIds }, clinica_id: { [Op.in]: clinicIds } },
          attributes: ['paciente_id', 'clinica_id'], raw: true, logging: false }),
      ]);
      const current = new Map(patients.map(value => plain(value)).filter(row => row.fecha_baja === null)
        .map(row => [Number(row.id_paciente), Number(row.clinica_id)]));
      const linked = new Set(links.map(value => plain(value)).map(row => `${Number(row.paciente_id)}:${Number(row.clinica_id)}`));
      if (requested.some(pair => !current.has(pair.patientId)
        || current.get(pair.patientId) !== pair.clinicId && !linked.has(`${pair.patientId}:${pair.clinicId}`))) throw denied();
      return requested;
    } catch (error) { throw storageError(error); }
  }

  return { httpAuthority, assertActorClinics, assertPatientPairs };
}

let instance;
function current() {
  instance ||= createReviewCareAccess({ db: require('../../models'), sessions: require('./accessSession.service'),
    canUserAccessFeature: input => require('../lib/access-policy').canUserAccessFeature(input) });
  return instance;
}

module.exports = { createReviewCareAccess, current };
