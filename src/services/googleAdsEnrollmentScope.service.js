'use strict';
const { Op, literal } = require('sequelize');
const C = require('./googleAdsEnrollment.contract');
const ads = require('./googleAdsBrokerScope.service');
const bounded = rows => { if (!Array.isArray(rows) || rows.length > 1000) C.fail(); return rows; };
const GRANT_FIELDS = ['id', 'assignmentScope', 'clinicaId', 'grupoClinicaId', 'googleConnectionId', 'status'];
function createGoogleAdsEnrollmentScope({ snapshot, candidate, authorize, now = Date.now,
  enabled = () => process.env.GOOGLE_ADS_ENROLLMENT_ENABLED === 'true' }) {
  const contexts = new WeakMap();
  async function inspect(input, expected, transaction) {
    if (!enabled()) C.fail('google_ads_enrollment_disabled');
    const ids = C.clinicIds(input.clinicIds); C.scopeKey(input.scopeKey);
    if (!C.positive(input.connectionId) || !C.positive(input.actorId) || !C.UUID.test(input.sessionRef)
      || !Number.isSafeInteger(input.sessionExpiresAt)
      || input.scopeKey.startsWith('clinic:') && (ids.length !== 1 || input.scopeKey !== 'clinic:' + ids[0])) C.fail();
    const check = async () => {
      if (!enabled()) C.fail('google_ads_enrollment_disabled');
      if (input.sessionExpiresAt <= now()) C.fail('google_discovery_session_required');
      if (await authorize({ ...input, clinicIds: ids.slice() }, { transaction }) !== true) C.fail('google_discovery_scope_forbidden');
    };
    await check();
    const raw = structuredClone(await snapshot({ scopeKey: input.scopeKey, connectionId: Number(input.connectionId), transaction }));
    if (!raw?.scope) C.fail('google_ads_enrollment_scope_unconfigured');
    const scope = C.scope(raw.scope); const clinics = bounded(raw.clinics); const grants = bounded(raw.grants);
    if (clinics.some(c => c.grupoClinicaId != null && !C.positive(c.grupoClinicaId))) C.fail();
    if (scope.state !== 'active' || scope.google_connection_id !== Number(input.connectionId) || scope.scope_key !== input.scopeKey
      || !ids.includes(scope.tenant_clinic_id)) C.fail('google_ads_enrollment_scope_conflict');
    const actual = C.clinicIds(clinics.map(c => c.id_clinica));
    if (JSON.stringify(ids) !== JSON.stringify(actual) || input.scopeKey.startsWith('group:')
      && clinics.some(c => Number(c.grupoClinicaId) !== Number(input.scopeKey.split(':')[1]))) C.fail('google_ads_enrollment_scope_conflict');
    const connection = raw.connection;
    if (!connection || Number(connection.id) !== scope.google_connection_id || connection.googleUserId !== scope.google_user_id
      || Number(connection.credentials_external) !== 1) C.fail('google_ads_enrollment_scope_conflict');
    if (new Set(grants.map(g => Number(g.id))).size !== grants.length || grants.some(g => !C.positive(g.id)
      || !C.positive(g.googleConnectionId) || !['clinic', 'group'].includes(g.assignmentScope))) C.fail();
    const direct = id => grants.filter(g => g.assignmentScope === 'clinic' && Number(g.clinicaId) === id);
    const group = id => grants.filter(g => g.assignmentScope === 'group' && Number(g.grupoClinicaId) === id);
    const requireGrant = rows => {
      if (rows.length !== 1 || rows[0].status !== 'active' || Number(rows[0].googleConnectionId) !== scope.google_connection_id) C.fail('google_discovery_scope_forbidden');
    };
    if (input.scopeKey.startsWith('group:')) {
      requireGrant(group(Number(input.scopeKey.split(':')[1])));
      for (const id of ids) if (direct(id).length) requireGrant(direct(id));
    } else {
      const rows = direct(ids[0]);
      if (rows.length) requireGrant(rows);
      else if (C.positive(clinics[0].grupoClinicaId)) requireGrant(group(Number(clinics[0].grupoClinicaId)));
      else C.fail('google_discovery_scope_forbidden');
    }
    const scopeDigest = C.digest({ scope, clinics: clinics.map(c => [Number(c.id_clinica), c.grupoClinicaId == null ? null : Number(c.grupoClinicaId)]).sort((a,b) => a[0]-b[0]),
      grants: grants.map(g => GRANT_FIELDS.map(k => g[k] ?? null)).sort((a,b) => Number(a[0])-Number(b[0])),
      connection: [Number(connection.id), connection.googleUserId, Number(connection.credentials_external)] });
    if (expected && scopeDigest !== expected) C.fail('google_ads_enrollment_scope_conflict');
    await check();
    if (C.digest(await snapshot({ scopeKey: input.scopeKey, connectionId: Number(input.connectionId), transaction })) !== C.digest(raw)) C.fail('google_ads_enrollment_scope_conflict');
    return { ...scope, clinicIds: ids, clinicDigest: C.digest(ids), scopeDigest,
      actorId: Number(input.actorId), sessionRef: input.sessionRef, sessionExpiresAt: input.sessionExpiresAt };
  }
  const guarded = work => async (...args) => {
    try { return await work(...args); } catch (error) {
      C.fail(['google_ads_enrollment_disabled', 'google_ads_enrollment_invalid', 'google_ads_enrollment_scope_unconfigured',
        'google_ads_enrollment_scope_conflict', 'google_discovery_scope_forbidden', 'google_discovery_session_required',
        'google_ads_enrollment_account_in_use', 'asset_revoked'].includes(error?.code) ? error.code : 'google_ads_enrollment_unavailable');
    }
  };
  const capture = guarded(async input => {
    const hint = { clinicIds: C.clinicIds(input.clinicIds), scopeKey: input.scopeKey, connectionId: Number(input.connectionId),
      actorId: Number(input.actorId), sessionRef: input.sessionRef, sessionExpiresAt: input.sessionExpiresAt };
    const saved = await inspect(hint); const handle = Object.freeze({});
    contexts.set(handle, { hint, scopeDigest: saved.scopeDigest }); return handle;
  });
  const assert = guarded(async (handle, { transaction } = {}) => {
    const saved = handle && typeof handle === 'object' && contexts.get(handle); if (!saved) C.fail();
    return inspect(saved.hint, saved.scopeDigest, transaction);
  });
  return { capture, assert, restore: guarded(async row => {
    const r = C.request(row); const handle = await capture({ clinicIds: r.clinicIds, scopeKey: r.scope_key,
      connectionId: r.google_connection_id, actorId: r.actor_user_id, sessionRef: r.session_ref, sessionExpiresAt: r.session_expires_at.getTime() });
    const current = await assert(handle);
    if (current.scopeDigest !== r.scope_digest || current.google_user_id !== r.google_user_id || current.connection_ref !== r.connection_ref
      || current.asset_ref !== r.scope_ref || current.tenant_clinic_id !== Number(r.tenant_clinic_id)
      || (current.login_customer_id || current.root_customer_id) !== r.login_customer_id) C.fail('google_ads_enrollment_scope_conflict');
    return handle;
  }), assertNewCustomer: guarded(async (handle, customerId, { transaction } = {}) => {
    if (!transaction?.LOCK?.UPDATE || C.customer(customerId) !== customerId) C.fail();
    await assert(handle, { transaction });
    const rows = await candidate(customerId, { transaction });
    for (const key of ['mappings', 'bindings', 'revocations', 'requests']) bounded(rows[key]);
    if (rows.revocations.length || rows.requests.some(r => ['revoke_pending', 'revoked'].includes(r.state))) C.fail('asset_revoked');
    if (rows.mappings.length || rows.bindings.length || rows.requests.length) C.fail('google_ads_enrollment_account_in_use');
    // Any alias (including an inactive or group-primary mapping) excludes a new
    // owner. Shared uses cannot turn an existing account into a new registration.
    await assert(handle, { transaction });
  }), release(handle) { if (handle && typeof handle === 'object') contexts.delete(handle); } };
}
function createGoogleAdsEnrollmentScopeRepository(getModels) {
  const options = transaction => ({ raw: true, logging: false, limit: 1001,
    ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) });
  return {
    async snapshot({ scopeKey, connectionId, transaction }) {
      const m = getModels(); const opts = options(transaction);
      const scope = await m.GoogleAdsEnrollmentScope.findByPk(scopeKey, { ...opts, attributes: C.SCOPE_FIELDS });
      if (!scope) return { scope: null };
      const groups = scopeKey.startsWith('group:'); const id = Number(scopeKey.split(':')[1]);
      const clinics = bounded(await m.Clinica.findAll({ ...opts, attributes: ['id_clinica', 'grupoClinicaId'], order: [['id_clinica', 'ASC']],
        where: groups ? { grupoClinicaId: id } : { id_clinica: id } }));
      const groupIds = [...new Set(clinics.filter(c => c.grupoClinicaId != null).map(c => Number(c.grupoClinicaId)))];
      const grants = bounded(await m.GoogleConnectionAssignment.findAll({ ...opts, attributes: GRANT_FIELDS, order: [['id', 'ASC']],
        where: { [Op.or]: [{ assignmentScope: 'clinic', clinicaId: { [Op.in]: clinics.map(c => Number(c.id_clinica)) } },
          ...(groupIds.length ? [{ assignmentScope: 'group', grupoClinicaId: { [Op.in]: groupIds } }] : [])] } }));
      const connections = await m.GoogleConnection.findAll({ ...opts, limit: 2,
        attributes: ['id', 'googleUserId', [literal('(accessToken IS NULL AND refreshToken IS NULL)'), 'credentials_external']],
        where: { [Op.or]: [{ id: connectionId }, { googleUserId: scope.google_user_id }] } });
      return { scope, clinics, grants, connection: connections.length === 1 ? connections[0] : null };
    },
    async candidate(id, { transaction }) {
      const m = getModels(); const opts = options(transaction);
      const mappings = await m.ClinicGoogleAdsAccount.findAll({ ...opts, attributes: ads.MAPPING_FIELDS, order: [['id','ASC']],
        where: { customerId: { [Op.in]: [id, `${id.slice(0,3)}-${id.slice(3,6)}-${id.slice(6)}`] } } });
      const bindings = await m.GoogleAdsBrokerBinding.findAll({ ...opts, attributes: ads.BINDING_FIELDS,
        order: [['customer_id','ASC'], ['mapping_id','ASC']], where: { customer_id: id } });
      const revocations = await m.GoogleAdsBrokerRevocation.findAll({ ...opts, attributes: ['tuple_hash'], order: [['tuple_hash','ASC']], where: { customer_id: id } });
      const requests = await m.GoogleAdsEnrollmentRequest.findAll({ ...opts, attributes: ['enrollment_id','state'], order: [['enrollment_id','ASC']], where: { customer_id: id } });
      return { mappings, bindings, revocations, requests };
    },
  };
}
module.exports = { createGoogleAdsEnrollmentScope, createGoogleAdsEnrollmentScopeRepository };
