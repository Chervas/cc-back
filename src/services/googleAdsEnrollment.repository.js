'use strict';
const { randomUUID } = require('node:crypto');
const { Op } = require('sequelize');
const C = require('./googleAdsEnrollment.contract');
const A = require('./googleAdsBrokerScope.service');
const { fromEnrollment } = require('../../services/platform-audit/src/google-ads-enrollment-event');
const { createRepository } = require('./platformAudit.repository');
const PENDING = ['prepare_pending', 'prepared', 'activate_pending', 'activation_confirmed', 'revoke_pending'];
const IDENTITY = C.REQUEST_FIELDS.filter(key => !['state', 'updated_at', 'attempts', 'next_attempt_at', 'lease_token', 'lease_until', 'last_error'].includes(key));
const fail = code => C.fail(code || 'google_ads_enrollment_scope_conflict');
const plain = row => row?.get ? row.get({ plain: true }) : row;
const same = (a, b) => IDENTITY.every(key => a[key] instanceof Date
  ? b[key] instanceof Date && a[key].getTime() === b[key].getTime() : a[key] === b[key]);
const dto = row => ({ enrollmentId: row.enrollment_id, customerId: row.customer_id,
  state: row.state, mappingId: row.mapping_id, retryAt: row.next_attempt_at, error: row.last_error });
function createGoogleAdsEnrollmentRepository({ models, scope, audit, now = () => new Date() }) {
  const getModels = () => typeof models === 'function' ? models() : models;
  const opts = transaction => ({ transaction, lock: transaction.LOCK.UPDATE, logging: false });
  const trans = work => getModels().sequelize.transaction(work);
  async function record(row, reason, transaction, actor = {}) {
    const events = audit || createRepository(getModels().PlatformAuditEvent);
    const date = now(); const health = await events.health(date, { includeUnresolved: false, transaction });
    if (!Number.isSafeInteger(health.pending) || health.pending >= 10000 || !Number.isFinite(health.oldestAgeSeconds)
      || health.oldestAgeSeconds >= 3600) fail('audit_unavailable');
    await events.append(fromEnrollment(plain(row), reason, { ...actor, now: date }), { transaction });
  }
  async function load(id, transaction) {
    const row = await getModels().GoogleAdsEnrollmentRequest.findByPk(id, opts(transaction));
    if (!row) fail(); C.request(plain(row)); return row;
  }
  async function owned(claim, transaction) {
    C.request(claim);
    const row = await load(claim.enrollment_id, transaction); const current = plain(row);
    if (!same(current, claim) || current.state !== claim.state || !claim.lease_token
      || current.lease_token !== claim.lease_token || current.lease_until?.getTime() <= now().getTime()) fail('google_ads_enrollment_lease_lost');
    return row;
  }
  async function release(row, patch, transaction, delay = 0) {
    const date = now();
    await row.update({ ...patch, updated_at: date, next_attempt_at: new Date(date.getTime() + delay), lease_token: null, lease_until: null }, opts(transaction));
    C.request(plain(row)); return plain(row);
  }
  async function assertContext(row, context, transaction) {
    const saved = await scope.assert(context, { transaction });
    if (saved.scope_key !== row.scope_key || saved.google_connection_id !== Number(row.google_connection_id)
      || saved.google_user_id !== row.google_user_id || saved.connection_ref !== row.connection_ref
      || saved.asset_ref !== row.scope_ref || saved.tenant_clinic_id !== Number(row.tenant_clinic_id)
      || (saved.login_customer_id || saved.root_customer_id) !== row.login_customer_id
      || saved.scopeDigest !== row.scope_digest || saved.clinicDigest !== row.clinic_digest
      || saved.actorId !== Number(row.actor_user_id) || saved.sessionRef !== row.session_ref
      || saved.sessionExpiresAt !== row.session_expires_at.getTime()) fail();
    return saved;
  }
  async function assertMapping(row, transaction, state = 'staged') {
    const m = getModels(); const options = { ...opts(transaction), raw: true, limit: 1001 };
    const aliases = [row.customer_id, `${row.customer_id.slice(0,3)}-${row.customer_id.slice(3,6)}-${row.customer_id.slice(6)}`];
    const mappings = await m.ClinicGoogleAdsAccount.findAll({ ...options, attributes: A.MAPPING_FIELDS,
      where: { [Op.or]: [{ customerId: { [Op.in]: aliases } }, ...(row.mapping_id ? [{ id: row.mapping_id }] : [])] } });
    const bindings = await m.GoogleAdsBrokerBinding.findAll({ ...options, attributes: A.BINDING_FIELDS,
      where: { [Op.or]: [{ customer_id: row.customer_id }, ...(row.mapping_id ? [{ mapping_id: row.mapping_id }] : [])] } });
    const revocations = await m.GoogleAdsBrokerRevocation.findAll({ ...options, attributes: ['tuple_hash'], where: { customer_id: row.customer_id } });
    if (revocations.length) fail('asset_revoked');
    if (row.mapping_id === null) {
      if (mappings.length || bindings.length) fail('google_ads_enrollment_account_in_use'); return null;
    }
    if (mappings.length !== 1 || bindings.length !== 1) fail();
    const mapping = mappings[0]; const binding = A.binding(bindings[0]); const identity = A.identity(mapping);
    if (identity.id !== Number(row.mapping_id) || identity.customerId !== row.customer_id
      || identity.googleConnectionId !== Number(row.google_connection_id) || identity.scopeKey !== row.scope_key
      || identity.loginCustomerId !== row.login_customer_id || !row.clinicIds.includes(Number(mapping.clinicaId))
      || ![true, false, 0, 1].includes(mapping.isActive) || Boolean(mapping.isActive) !== (state === 'active')
      || mapping.broker_read_connection_ref !== row.connection_ref
      || mapping.broker_read_asset_ref !== 'ads:' + row.customer_id || binding.mapping_id !== Number(row.mapping_id)
      || binding.customer_id !== row.customer_id || binding.google_connection_id !== Number(row.google_connection_id)
      || binding.google_user_id !== row.google_user_id || binding.connection_ref !== row.connection_ref
      || binding.asset_ref !== 'ads:' + row.customer_id || binding.scope_key !== row.scope_key
      || binding.tenant_clinic_id !== Number(row.tenant_clinic_id) || binding.login_customer_id !== row.login_customer_id
      || binding.state !== state) fail();
    return { mapping, binding };
  }
  async function blockLocal(row, transaction) {
    if (row.mapping_id === null) return;
    const m = getModels();
    // Cancel only this original owner; never mutate a row repurposed elsewhere.
    await m.GoogleAdsBrokerBinding.update({ state: 'blocked' }, { ...opts(transaction), where: {
      customer_id: row.customer_id, mapping_id: row.mapping_id, google_connection_id: row.google_connection_id,
      google_user_id: row.google_user_id, connection_ref: row.connection_ref, asset_ref: 'ads:' + row.customer_id,
      scope_key: row.scope_key, tenant_clinic_id: row.tenant_clinic_id, login_customer_id: row.login_customer_id } });
    await m.ClinicGoogleAdsAccount.update({ isActive: false }, { ...opts(transaction), where: {
      id: row.mapping_id, googleConnectionId: row.google_connection_id, customerId: row.customer_id,
      broker_read_connection_ref: row.connection_ref, broker_read_asset_ref: 'ads:' + row.customer_id,
      assignmentScope: row.scope_key.split(':')[0], loginCustomerId: row.login_customer_id,
      ...(row.scope_key.startsWith('group:') ? { grupoClinicaId: Number(row.scope_key.split(':')[1]),
        clinicaId: { [Op.in]: JSON.parse(row.clinic_ids) } } : { clinicaId: row.tenant_clinic_id }) } });
  }
  const receipt = (row, value, states) => {
    if (!value || !states.includes(value.state) || value.enrollmentId !== row.enrollment_id
      || value.assetRef !== 'ads:' + row.customer_id || value.scopeRef !== row.scope_ref
      || value.clinicCount !== Number(row.clinic_count) || value.clinicSetDigest !== row.clinic_digest) fail('broker_response_invalid');
    if (value.state !== 'revoked' && Object.hasOwn(value, 'accessBlocked') && value.accessBlocked !== false) fail('asset_revoked');
  };
  return {
    async enqueue(context, { enrollmentId = randomUUID(), customerId }) {
      if (!C.UUID.test(enrollmentId) || C.customer(customerId) !== customerId) fail('google_ads_enrollment_invalid');
      return trans(async transaction => {
        const saved = await scope.assert(context, { transaction });
        const existing = await getModels().GoogleAdsEnrollmentRequest.findByPk(enrollmentId, opts(transaction));
        if (existing) {
          const row = C.request(plain(existing));
          if (row.customer_id !== customerId) fail();
          await assertContext(row, context, transaction);
          return dto(row);
        }
        await scope.assertNewCustomer(context, customerId, { transaction });
        const date = now(); const row = C.request({ enrollment_id: enrollmentId, scope_key: saved.scope_key,
          google_connection_id: saved.google_connection_id, google_user_id: saved.google_user_id, connection_ref: saved.connection_ref,
          scope_ref: saved.asset_ref, tenant_clinic_id: saved.tenant_clinic_id, customer_id: customerId,
          login_customer_id: saved.login_customer_id || saved.root_customer_id, clinic_ids: JSON.stringify(saved.clinicIds),
          clinic_count: saved.clinicIds.length, clinic_digest: saved.clinicDigest, scope_digest: saved.scopeDigest, mapping_id: null,
          actor_user_id: saved.actorId, session_ref: saved.sessionRef, session_expires_at: new Date(saved.sessionExpiresAt),
          prepare_request_id: randomUUID(), activate_request_id: randomUUID(), revoke_request_id: randomUUID(),
          state: 'prepare_pending', requested_at: date, updated_at: date, attempts: 0, next_attempt_at: date,
          lease_token: null, lease_until: null, last_error: null });
        await getModels().GoogleAdsEnrollmentRequest.create(row, { transaction, logging: false });
        await record(row, 'enrollment_requested', transaction);
        await scope.assert(context, { transaction }); return dto(row);
      });
    },
    claim() {
      return trans(async transaction => {
        const date = now();
        // Sequelize 6's MySQL dialect silently omits options.skipLocked. The
        // deployed MySQL 8 contract needs the actual locking clause here.
        const [candidates] = await getModels().sequelize.query('SELECT enrollment_id FROM GoogleAdsEnrollmentRequests '
          + 'WHERE state IN (:states) AND next_attempt_at <= :now AND (lease_until IS NULL OR lease_until <= :now) '
          + 'ORDER BY next_attempt_at ASC, enrollment_id ASC LIMIT 1 FOR UPDATE SKIP LOCKED',
        { transaction, logging: false, replacements: { states: PENDING, now: date.toISOString().slice(0, 23).replace('T', ' ') } });
        if (!candidates.length) return null;
        const row = await load(candidates[0].enrollment_id, transaction);
        await row.update({ lease_token: randomUUID(), lease_until: new Date(date.getTime() + 120000),
          attempts: Math.min(1000000000, Number(row.attempts) + 1) }, opts(transaction));
        return C.request(plain(row));
      });
    },
    assertClaim: claim => trans(async transaction => { await owned(claim, transaction); return true; }),
    prepared(claim, context, result) {
      receipt(claim, result, ['prepared','active']);
      return trans(async transaction => {
        const row = await owned(claim, transaction);
        if (row.state !== 'prepare_pending') fail();
        await assertContext(row, context, transaction); await assertMapping(C.request(plain(row)), transaction);
        const m = getModels(); const group = row.scope_key.startsWith('group:');
        const mapping = await m.ClinicGoogleAdsAccount.create({ clinicaId: row.tenant_clinic_id,
          grupoClinicaId: group ? Number(row.scope_key.split(':')[1]) : null, assignmentScope: group ? 'group' : 'clinic',
          googleConnectionId: row.google_connection_id, customerId: row.customer_id, loginCustomerId: row.login_customer_id,
          managerCustomerId: row.login_customer_id, broker_read_connection_ref: row.connection_ref,
          broker_read_asset_ref: 'ads:' + row.customer_id, isActive: false }, { transaction, logging: false });
        await m.GoogleAdsBrokerBinding.create({ customer_id: row.customer_id, mapping_id: mapping.id,
          google_connection_id: row.google_connection_id, google_user_id: row.google_user_id, connection_ref: row.connection_ref,
          asset_ref: 'ads:' + row.customer_id, scope_key: row.scope_key, tenant_clinic_id: row.tenant_clinic_id,
          login_customer_id: row.login_customer_id, state: 'staged' }, { transaction, logging: false });
        await assertContext(row, context, transaction);
        return release(row, { mapping_id: mapping.id, state: 'prepared', last_error: null }, transaction);
      });
    },
    activating(claim, context) {
      return trans(async transaction => {
        const row = await owned(claim, transaction); if (row.state !== 'prepared') fail();
        await assertContext(row, context, transaction); await assertMapping(C.request(plain(row)), transaction);
        return release(row, { state: 'activate_pending', last_error: null }, transaction);
      });
    },
    activated(claim, context, result) {
      receipt(claim, result, ['active']);
      if (Object.hasOwn(result, 'accessBlocked') && result.accessBlocked !== false) fail('asset_revoked');
      return trans(async transaction => {
        const row = await owned(claim, transaction); if (row.state !== 'activate_pending') fail();
        await assertContext(row, context, transaction); await assertMapping(C.request(plain(row)), transaction);
        await record(row, 'enrollment_broker_confirmed', transaction);
        return release(row, { state: 'activation_confirmed', last_error: null }, transaction, 30000);
      });
    },
    awaitingMapping(claim, context) {
      return trans(async transaction => {
        const row = await owned(claim, transaction); if (row.state !== 'activation_confirmed') fail();
        await assertContext(row, context, transaction); await assertMapping(C.request(plain(row)), transaction);
        return release(row, { last_error: null }, transaction, 30000);
      });
    },
    // Called by the human mapping transaction after its local activation and
    // durable audit append. Any rejection rolls back that entire transaction,
    // including replacement/revocation of previous accounts.
    async mapped({ binding, clinicIds, actorId, sessionRef, transaction }) {
      if (!transaction?.LOCK?.UPDATE || !C.positive(actorId) || !C.UUID.test(sessionRef)) fail('google_ads_enrollment_invalid');
      const expected = A.binding(binding); const ids = C.clinicIds(clinicIds);
      const rows = await getModels().GoogleAdsEnrollmentRequest.findAll({ ...opts(transaction), limit: 2,
        where: { [Op.or]: [{ customer_id: expected.customer_id }, { mapping_id: expected.mapping_id }] } });
      // Existing static grants have no enrollment history and retain their
      // separate discovery/ownership checks in the mapping service.
      if (!rows.length) return false;
      if (rows.length !== 1) fail(); const row = rows[0]; const value = C.request(plain(row));
      if (!['activation_confirmed', 'active'].includes(value.state)) fail('google_ads_enrollment_not_ready');
      if (JSON.stringify(ids) !== value.clinic_ids) fail();
      const current = await assertMapping(value, transaction, 'active');
      if (C.digest(current.binding) !== C.digest(expected)) fail();
      if (value.state === 'active') return true;
      if (Number(actorId) !== Number(value.actor_user_id) || sessionRef !== value.session_ref) fail();
      let context;
      try {
        context = await scope.restore(value, { transaction }); await assertContext(value, context, transaction);
        await release(row, { state: 'active', last_error: null }, transaction); return true;
      } finally { if (context) scope.release(context); }
    },
    cancelClaim(claim, reason) {
      return trans(async transaction => {
        const row = await owned(claim, transaction);
        if (!/^[a-z_]{1,64}$/.test(reason || '')) fail('google_ads_enrollment_invalid');
        if (['revoke_pending', 'revoked'].includes(row.state)) fail();
        await record(row, 'enrollment_cancel_requested', transaction, { cause: reason });
        await blockLocal(plain(row), transaction);
        return release(row, { state: 'revoke_pending', last_error: reason }, transaction);
      });
    },
    // For an already authorized scope-disconnect transaction. It must not need
    // the enrolling user's session or an enabled enrollment switch to revoke.
    async cancelScope({ scopeKey, connectionId, clinicIds, transaction, actorId, sessionRef, customerIds,
      includeClinicScopes = false, childScopeClinicIds, reason = 'scope_disconnected' }) {
      if (!transaction?.LOCK?.UPDATE || !C.positive(connectionId)) fail('google_ads_enrollment_invalid');
      C.scopeKey(scopeKey); const ids = C.clinicIds(clinicIds);
      if (typeof includeClinicScopes !== 'boolean' || includeClinicScopes && !scopeKey.startsWith('group:')) fail('google_ads_enrollment_invalid');
      const children = childScopeClinicIds === undefined ? ids : Array.isArray(childScopeClinicIds) && !childScopeClinicIds.length ? [] : C.clinicIds(childScopeClinicIds);
      if (children.some(id => !ids.includes(id)) || childScopeClinicIds !== undefined && !includeClinicScopes) fail('google_ads_enrollment_invalid');
      const keys = [scopeKey, ...(includeClinicScopes ? children.map(id => 'clinic:' + id) : [])];
      if (customerIds !== undefined && (!Array.isArray(customerIds) || !customerIds.length || customerIds.length > 1000
        || customerIds.some(id => C.customer(id) !== id) || new Set(customerIds).size !== customerIds.length)) fail('google_ads_enrollment_invalid');
      const rows = await getModels().GoogleAdsEnrollmentRequest.findAll({ ...opts(transaction), limit: 1001,
        order: [['enrollment_id','ASC']], where: { scope_key: { [Op.in]: keys }, google_connection_id: connectionId, state: { [Op.ne]: 'revoked' },
          ...(customerIds ? { customer_id: { [Op.in]: customerIds } } : {}) } });
      if (rows.length > 1000) fail('google_ads_enrollment_invalid');
      if (rows.length && actorId != null && (!C.positive(actorId) || !C.UUID.test(sessionRef))) fail('google_discovery_session_required');
      for (const row of rows) {
        const value = C.request(plain(row)); if (value.clinicIds.some(id => !ids.includes(id))) fail();
        await blockLocal(value, transaction);
        if (row.state !== 'revoke_pending') {
          await record(row, 'enrollment_cancel_requested', transaction, { actorId, sessionRef, cause: reason });
          await release(row, { state: 'revoke_pending', last_error: reason }, transaction);
        }
      }
      return rows.length;
    },
    async disconnectionStatus(clinicIds) {
      const ids = C.clinicIds(clinicIds);
      const rows = await getModels().GoogleAdsEnrollmentRequest.findAll({ raw: true, logging: false, limit: 1001,
        attributes: C.REQUEST_FIELDS, where: { tenant_clinic_id: { [Op.in]: ids }, state: { [Op.in]: ['revoke_pending', 'revoked'] } } });
      if (rows.length > 1000) fail('google_ads_enrollment_unavailable');
      const own = rows.map(C.request).filter(row => row.clinicIds.every(id => ids.includes(id)));
      return { pending_enrollments: own.filter(row => row.state === 'revoke_pending').length,
        cancelled_enrollments: own.filter(row => row.state === 'revoked').length };
    },
    revoked(claim, result) {
      receipt(claim, result, ['revoked']); if (result.accessBlocked !== true) fail('broker_response_invalid');
      return trans(async transaction => {
        const row = await owned(claim, transaction); if (row.state !== 'revoke_pending') fail();
        await record(row, 'enrollment_cancel_confirmed', transaction);
        await blockLocal(plain(row), transaction); return release(row, { state: 'revoked', last_error: null }, transaction);
      });
    },
    retry(claim, code) {
      return trans(async transaction => {
        const row = await owned(claim, transaction);
        const error = /^[a-z_]{1,64}$/.test(code || '') ? code : 'google_ads_enrollment_unavailable';
        return release(row, { last_error: error }, transaction, Math.min(3600000, 1000 * 2 ** Math.min(Number(row.attempts), 12)));
      });
    },
  };
}
module.exports = { createGoogleAdsEnrollmentRepository, PENDING, dto };
