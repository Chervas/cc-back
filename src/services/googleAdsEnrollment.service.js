'use strict';
const C = require('./googleAdsEnrollment.contract');
const { createGoogleAdsEnrollmentScope, createGoogleAdsEnrollmentScopeRepository } = require('./googleAdsEnrollmentScope.service');
const { createGoogleAdsEnrollmentRepository, dto } = require('./googleAdsEnrollment.repository');
const { createGoogleAdsEnrollmentClient, configuredClients, safe: clientSafe } = require('./googleAdsEnrollmentClient.service');
const { createGoogleAdsEnrollmentWorker } = require('./googleAdsEnrollmentWorker.service');
const { hasMarketingClinicScopeAccess } = require('../lib/marketingScopeAccess');
const LOCAL_CODES = new Set(['google_ads_enrollment_account_in_use', 'google_ads_enrollment_not_found', 'google_ads_enrollment_not_ready', 'google_ads_enrollment_busy']);
const safe = error => LOCAL_CODES.has(error?.code) ? error.code : clientSafe(error);
const status = error => safe(error) === 'google_ads_enrollment_busy' ? 429 : safe(error) === 'google_discovery_session_required' ? 401
  : ['google_discovery_scope_forbidden', 'scope_denied'].includes(safe(error)) ? 403
    : safe(error) === 'google_ads_enrollment_not_found' ? 404
      : ['google_ads_enrollment_account_in_use', 'google_ads_enrollment_not_ready', 'google_ads_enrollment_scope_conflict', 'asset_revoked'].includes(safe(error)) ? 409
        : safe(error) === 'google_ads_enrollment_invalid' ? 400 : 503;
function createGoogleAdsEnrollment({ models, sessions, clients = configuredClients(), audit, now = Date.now,
  enabled = () => process.env.GOOGLE_ADS_ENROLLMENT_ENABLED === 'true',
  workerEnabled = () => process.env.GOOGLE_ADS_ENROLLMENT_WORKER_ENABLED === 'true',
  gateway = () => String(process.env.RUNTIME_ROLE || '').trim().toLowerCase() === 'gateway' }) {
  const getModels = () => typeof models === 'function' ? models() : models;
  const getSessions = () => sessions || require('./accessSession.service');
  function actor(input) {
    C.scopeKey(input?.scopeKey); const ids = C.clinicIds(input.clinicIds);
    if (!C.positive(input.actorId) || !C.UUID.test(input.sessionRef) || !Number.isSafeInteger(input.sessionExpiresAt)
      || input.scopeKey.startsWith('clinic:') && (ids.length !== 1 || input.scopeKey !== 'clinic:' + ids[0])) C.fail();
    return ids;
  }
  async function authorize(input, { transaction } = {}) {
    const ids = actor(input);
    try { await getSessions().verifyReference({ userId: Number(input.actorId), sessionRef: input.sessionRef,
      expiresAt: new Date(input.sessionExpiresAt) }, { transaction }); }
    catch (error) {
      if (['JsonWebTokenError', 'TokenExpiredError', 'NotBeforeError'].includes(error?.name)
        || error?.status === 401 || error?.code === 'auth_invalid') C.fail('google_discovery_session_required');
      C.fail('google_ads_enrollment_unavailable');
    }
    return hasMarketingClinicScopeAccess({ userId: Number(input.actorId), clinicIds: ids, access: 'write',
      membershipModel: { findAll: options => getModels().UsuarioClinica.findAll({ ...options, logging: false,
        ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) }) } });
  }
  const scope = createGoogleAdsEnrollmentScope({ ...createGoogleAdsEnrollmentScopeRepository(getModels), authorize, now, enabled });
  const repository = createGoogleAdsEnrollmentRepository({ models, scope, audit, now: () => new Date(now()) });
  const client = createGoogleAdsEnrollmentClient({ ...clients, scope, now });
  const worker = createGoogleAdsEnrollmentWorker({ repository, client, scope, now, enabled: () => !gateway() && workerEnabled() });
  let activeDiscoveries = 0;
  const guarded = fn => async (...args) => { try { return await fn(...args); } catch (error) { C.fail(safe(error)); } };
  async function inContext(input, work) {
    if (gateway()) C.fail('google_ads_enrollment_disabled');
    const context = await scope.capture(input);
    try { return await work(context); } finally { scope.release(context); }
  }
  async function history(input, enrollmentId, cancel = false) {
    if (gateway()) C.fail('google_ads_enrollment_disabled');
    const ids = actor(input); if (enrollmentId !== undefined && !C.UUID.test(enrollmentId)) C.fail();
    const m = getModels();
    return m.sequelize.transaction(async transaction => {
      if (await authorize(input, { transaction }) !== true) C.fail('google_discovery_scope_forbidden');
      const options = { transaction, lock: transaction.LOCK.UPDATE, raw: true, logging: false };
      const clinics = await m.Clinica.findAll({ ...options, limit: 1001, attributes: ['id_clinica'], order: [['id_clinica','ASC']],
        where: input.scopeKey.startsWith('group:') ? { grupoClinicaId: Number(input.scopeKey.split(':')[1]) } : { id_clinica: ids[0] } });
      if (JSON.stringify(clinics.map(c => Number(c.id_clinica))) !== JSON.stringify(ids)) C.fail('google_ads_enrollment_scope_conflict');
      const raws = await m.GoogleAdsEnrollmentRequest.findAll({ ...options, attributes: C.REQUEST_FIELDS,
        limit: enrollmentId ? 1 : 26, order: [['requested_at','DESC'], ['enrollment_id','ASC']],
        where: { scope_key: input.scopeKey, ...(enrollmentId ? { enrollment_id: enrollmentId }
          : { actor_user_id: input.actorId, session_ref: input.sessionRef, clinic_digest: C.digest(ids), clinic_ids: JSON.stringify(ids) }) } });
      if (enrollmentId && !raws.length) C.fail('google_ads_enrollment_not_found');
      const requests = [];
      for (const raw of raws.slice(0, 25)) {
        let row = C.request(raw);
        if (row.clinic_ids !== JSON.stringify(ids)) C.fail('google_ads_enrollment_scope_conflict');
        if (cancel && row.state === 'active') C.fail('google_ads_enrollment_not_ready');
        if (cancel && row.state !== 'revoked') {
          await repository.cancelScope({ scopeKey: input.scopeKey, connectionId: Number(row.google_connection_id),
            clinicIds: ids, transaction, actorId: input.actorId, sessionRef: input.sessionRef,
            customerIds: [row.customer_id], reason: 'user_cancelled' });
          row = C.request(await m.GoogleAdsEnrollmentRequest.findByPk(row.enrollment_id, { ...options, attributes: C.REQUEST_FIELDS }));
        }
        let canComplete = false; let context;
        if (enabled() && row.state === 'activation_confirmed' && Number(row.actor_user_id) === Number(input.actorId)
          && row.session_ref === input.sessionRef && row.session_expires_at.getTime() === input.sessionExpiresAt) {
          try { context = await scope.restore(row, { transaction }); canComplete = true; }
          catch (error) {
            if (!['google_ads_enrollment_scope_unconfigured', 'google_ads_enrollment_scope_conflict', 'google_ads_enrollment_disabled',
              'google_discovery_session_required', 'google_discovery_scope_forbidden'].includes(error?.code)) throw error;
          } finally { if (context) scope.release(context); }
        }
        requests.push({ ...dto(row), canComplete });
      }
      if (await authorize(input, { transaction }) !== true) C.fail('google_discovery_scope_forbidden');
      return enrollmentId ? requests[0] : { requests, hasMore: raws.length > 25 };
    });
  }
  return {
    capabilities: guarded(async input => {
      if (gateway()) C.fail('google_ads_enrollment_disabled');
      if (!enabled() || !workerEnabled()) return { enabled: false };
      try { return await inContext(input, () => ({ enabled: true })); }
      catch (error) { if (error?.code === 'google_ads_enrollment_scope_unconfigured') return { enabled: false }; throw error; }
    }),
    discover: guarded(async input => {
      if (activeDiscoveries >= 4) C.fail('google_ads_enrollment_busy'); activeDiscoveries++;
      try { return await inContext(input, context => client.discover(context)); } finally { activeDiscoveries--; }
    }),
    enqueue: guarded((input, payload) => {
      if (!workerEnabled()) C.fail('google_ads_enrollment_worker_disabled');
      if (!payload || Object.keys(payload).sort().join(',') !== 'customerId,enrollmentId' || !C.UUID.test(payload.enrollmentId)
        || typeof payload.customerId !== 'string' || !/^\d{10}$/.test(payload.customerId) || payload.customerId === '0000000000') C.fail();
      return inContext(input, context => repository.enqueue(context, payload));
    }),
    list: guarded(input => history(input)),
    read: guarded((input, enrollmentId) => history(input, enrollmentId)),
    cancel: guarded((input, enrollmentId) => history(input, enrollmentId, true)),
    run: () => worker.run(),
    disconnectionStatus: guarded(ids => repository.disconnectionStatus(ids)),
  };
}
let instance;
const service = () => instance ||= createGoogleAdsEnrollment({ models: () => require('../../models') });
module.exports = { createGoogleAdsEnrollment, safe, status,
  capabilities: (...args) => service().capabilities(...args), list: (...args) => service().list(...args),
  cancel: (...args) => service().cancel(...args),
  discover: (...args) => service().discover(...args), enqueue: (...args) => service().enqueue(...args), read: (...args) => service().read(...args),
  run: () => service().run(),
  disconnectionStatus: (...args) => service().disconnectionStatus(...args),
};
