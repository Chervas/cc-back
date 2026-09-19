'use strict';
const C = require('../../services/integrations-broker/src/google-business-profile-write-contract');
const { asset } = require('../../services/integrations-broker/src/google-business-profile-contract');
const { fromMutation } = require('../../services/platform-audit/src/business-profile-mutation-event');
const { createRepository } = require('./platformAudit.repository');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const positive = v => Number.isSafeInteger(v) && v > 0 && v <= 2147483647;
const fail = code => { throw Object.assign(Error(code), { code }); };
const CODES = new Set(['invalid_request', 'scope_denied', 'asset_revoked', 'connection_blocked', 'operation_denied',
  'broker_binding_invalid', 'broker_cohort_disabled', 'broker_unavailable', 'broker_timeout', 'broker_response_invalid',
  'provider_failed', 'provider_timeout', 'provider_unauthorized', 'secret_unavailable', 'credential_revoked',
  'rate_limited', 'audit_unavailable', 'outcome_unknown', 'idempotency_conflict', 'business_profile_mutation_busy',
  'business_profile_regular_hours_required', 'business_profile_session_required', 'business_profile_automation_required',
  'business_profile_mutation_not_found', 'business_profile_mutation_conflict', 'business_profile_mutation_unavailable']);
const safe = error => CODES.has(error?.code) ? error.code : 'business_profile_mutation_unavailable';
const status = error => safe(error) === 'invalid_request' ? 400 : safe(error) === 'business_profile_session_required' ? 401
  : safe(error) === 'scope_denied' ? 403 : safe(error) === 'business_profile_mutation_not_found' ? 404
    : ['business_profile_mutation_busy', 'business_profile_mutation_conflict', 'idempotency_conflict', 'outcome_unknown',
      'business_profile_regular_hours_required', 'business_profile_automation_required'].includes(safe(error)) ? 409 : 503;
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
function actorFor(value) {
  const actor = structuredClone(value);
  if (!positive(actor?.userId)) fail('business_profile_session_required');
  if (actor.type === 'user') {
    if (!exact(actor, 'type,userId,sessionRef,expiresAt') || typeof actor.sessionRef !== 'string' || !UUID.test(actor.sessionRef)
      || !Number.isSafeInteger(actor.expiresAt)) fail('business_profile_session_required');
  } else if (!exact(actor, 'type,userId,executionId,nodeId') || actor.type !== 'automation' || !positive(actor.executionId)
    || typeof actor.nodeId !== 'string' || !/^[A-Za-z0-9_-]{1,32}$/.test(actor.nodeId)) fail('business_profile_automation_required');
  return actor;
}
const dto = row => ({ operationId: row.operation_id, kind: row.kind, state: row.state === 'applied' ? 'applied' : 'unknown',
  outcomeUnknown: row.state !== 'applied', appliedAt: row.applied_at ? new Date(row.applied_at).toISOString() : null,
  lastError: row.last_error || null });
function createBusinessProfileMutationJournal({ models, sessions, audit, now = Date.now,
  namespace = () => process.env.JOB_RUNTIME_NAMESPACE,
  enabled = () => process.env.GOOGLE_BUSINESS_PROFILE_WRITES_ENABLED === 'true' && process.env.GOOGLE_BUSINESS_PROFILE_BROKER_ENABLED === 'true' }) {
  async function run(context, kind, input, localInput, recovering) {
    try {
      const payload = structuredClone(input), local = recovering ? null : structuredClone(localInput);
      C.validate(recovering ? 'status' : kind, payload);
      if (!recovering && (kind === 'status' || !local || Object.getPrototypeOf(local) !== Object.prototype
        || Buffer.byteLength(JSON.stringify(local)) > 131072)) fail('invalid_request');
      const actor = actorFor(context.actor), runtimeNamespace = context.runtimeNamespace;
      if (typeof runtimeNamespace !== 'string' || !/^[a-z][a-z0-9_-]{0,31}$/.test(runtimeNamespace)
        || runtimeNamespace !== namespace() || !positive(context.clinicId) || typeof context.beforeExecute !== 'function'
        || typeof context.applyResult !== 'function' || actor.type === 'automation' && !recovering && kind !== 'hours') fail('invalid_request');
      const gate = () => { if (!enabled() || namespace() !== runtimeNamespace) fail('broker_cohort_disabled'); }; gate();
      const m = typeof models === 'function' ? models() : models;
      const P = m.BusinessProfileMutation, L = m.BusinessProfileMutationLock;
      const cache = require('./businessProfileCache.service').createBusinessProfileCache({ models: m });
      const events = audit || createRepository(m.PlatformAuditEvent);
      const broker = context.broker, location = context.location, brokerContext = context.brokerContext;
      if (typeof broker?.assert !== 'function' || typeof broker?.write !== 'function') fail('broker_binding_invalid');
      const clinicIds = [...(context.clinicIds || [])];
      if (!clinicIds.length || clinicIds.length > 1000 || clinicIds.some(id => !positive(id))
        || new Set(clinicIds).size !== clinicIds.length || !clinicIds.includes(context.clinicId)) fail('scope_denied');
      clinicIds.sort((a, b) => a - b);
      const brokerScope = await broker.assert(location, brokerContext);
      if (!positive(brokerScope.mappingId) || !positive(brokerScope.googleConnectionId)
        || !/^clinic:[1-9]\d{0,9}$/.test(brokerScope.tenantRef) || !clinicIds.includes(Number(brokerScope.tenantRef.slice(7)))) fail('scope_denied');
      const captured = { ...brokerScope, requestedClinicId: context.clinicId, clinicIds, runtimeNamespace };
      const scopeDigest = C.hash(captured), actorKey = C.hash({ type: actor.type, userId: actor.userId, runtimeNamespace,
        ...(actor.type === 'automation' ? { executionId: actor.executionId, nodeId: actor.nodeId } : {}) });
      const guard = async transaction => {
        gate();
        if (actor.type === 'user') {
          if (actor.expiresAt <= now()) fail('business_profile_session_required');
          try { await (sessions || require('./accessSession.service')).verifyReference({ userId: actor.userId,
            sessionRef: actor.sessionRef, expiresAt: new Date(actor.expiresAt) }, { transaction }); }
          catch (error) { if (error?.status === 401 || error?.code === 'auth_invalid') fail('business_profile_session_required'); throw error; }
        } else if (typeof context.verifyAutomation !== 'function' || await context.verifyAutomation({ transaction, recovering }) !== true) fail('business_profile_automation_required');
        if (await context.beforeExecute({ transaction, recovering, clinicIds: clinicIds.slice() }) !== true) fail('scope_denied');
        const fresh = await broker.assert(location, brokerContext, transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {});
        if (C.hash({ ...fresh, requestedClinicId: context.clinicId, clinicIds, runtimeNamespace }) !== scopeDigest) fail('scope_denied');
        gate(); return true;
      };
      const owned = async transaction => {
        const row = await P.findByPk(payload.operationId, { transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}), logging: false });
        if (!row || Number(row.actor_user_id) !== actor.userId || row.runtime_namespace !== runtimeNamespace
          || row.scope_digest !== scopeDigest || Number(row.requested_clinic_id) !== context.clinicId
          || Number(row.mapping_id) !== brokerScope.mappingId || Number(row.google_connection_id) !== brokerScope.googleConnectionId
          || row.connection_ref !== brokerScope.connectionRef || row.asset_ref !== brokerScope.assetRef
          || actor.type === 'automation' && row.actor_key !== actorKey
          || !recovering && row.actor_key !== actorKey) fail('business_profile_mutation_not_found');
        if (C.hash({ kind: row.kind, input: row.input, localInput: row.local_input }) !== row.input_digest
          || !recovering && (row.kind !== kind || row.input_digest !== C.hash({ kind, input: payload, localInput: local }))) fail('business_profile_mutation_conflict');
        C.validate(row.kind, row.input); return row;
      };
      const record = async (row, reason, transaction) => {
        try {
          const at = new Date(now()), health = await events.health(at, { transaction, includeUnresolved: false });
          if (!Number.isSafeInteger(health.pending) || health.pending >= 10000 || !Number.isFinite(health.oldestAgeSeconds)
            || health.oldestAgeSeconds >= 3600) fail('audit_unavailable');
          await events.append(fromMutation(row, captured, actor, reason, at), { transaction });
        } catch { fail('audit_unavailable'); }
      };
      await guard();
      const claim = await m.sequelize.transaction(async transaction => {
        await guard(transaction);
        const prior = await P.findByPk(payload.operationId, { transaction, lock: transaction.LOCK.UPDATE, logging: false });
        if (prior) {
          const row = await owned(transaction);
          return { send: recovering && row.state !== 'applied', row };
        }
        if (recovering) fail('business_profile_mutation_not_found');
        const at = new Date(now());
        const row = await P.create({ operation_id: payload.operationId, actor_type: actor.type, actor_user_id: actor.userId, actor_key: actorKey,
          session_ref: actor.type === 'user' ? actor.sessionRef : null, session_expires_at: actor.type === 'user' ? new Date(actor.expiresAt) : null,
          execution_id: actor.type === 'automation' ? actor.executionId : null, node_id: actor.type === 'automation' ? actor.nodeId : null,
          runtime_namespace: runtimeNamespace, requested_clinic_id: context.clinicId, mapping_id: brokerScope.mappingId,
          google_connection_id: brokerScope.googleConnectionId, connection_ref: brokerScope.connectionRef, asset_ref: brokerScope.assetRef,
          scope_digest: scopeDigest, input_digest: C.hash({ kind, input: payload, localInput: local }), kind, input: payload, local_input: local,
          state: 'attempted', broker_receipt: null, last_error: null, created_at: at, updated_at: at, applied_at: null }, { transaction });
        const keys = C.lockKeys(asset(brokerScope.assetRef), kind, payload).map(C.hash).sort();
        for (const key of keys) {
          if (await L.findByPk(key, { transaction, lock: transaction.LOCK.UPDATE, logging: false })) fail('business_profile_mutation_busy');
          await L.create({ resource_key: key, operation_id: payload.operationId }, { transaction });
        }
        await cache.mutation(row.asset_ref, row.kind, 1, transaction);
        await record(row, 'mutation_admitted', transaction);
        await guard(transaction);
        return { send: true, row };
      });
      if (!claim.send) { await guard(); return dto(claim.row); }
      try {
        // Retrying execute on an admitted ID never dispatches. Only recover can
        // query status, always with the original ID and without a provider write.
        const response = await broker.write(location, brokerContext, recovering ? 'status' : kind,
          recovering ? { operationId: payload.operationId } : payload, { beforeExecute: () => guard() });
        const receipt = response?.data;
        if (!receipt || receipt.operationId !== payload.operationId) fail('broker_response_invalid');
        const result = await m.sequelize.transaction(async transaction => {
          await guard(transaction); const row = await owned(transaction);
          if (row.state === 'applied') return dto(row);
          if (['unknown', 'not_found'].includes(receipt.state)) {
            if (!recovering || !exact(receipt, 'operationId,kind,state,result') || receipt.result !== null
              || (receipt.state === 'not_found' ? receipt.kind !== null : receipt.kind !== row.kind)) fail('broker_response_invalid');
            // not_found cannot prove the absence of an in-flight broker request.
            return dto(row);
          }
          if (!exact(receipt, 'operationId,kind,state,result,completedAt') || receipt.state !== 'applied' || receipt.kind !== row.kind
            || !Number.isSafeInteger(receipt.completedAt) || receipt.completedAt < 1 || receipt.completedAt > 8640000000000000) fail('broker_response_invalid');
          const providerResult = C.project(row.kind, receipt.result, asset(row.asset_ref), row.input);
          // Local cache changes, the original human/job audit and lock release
          // are atomic. A lost response cannot let a later command overtake them.
          await cache.mutation(row.asset_ref, row.kind, -1, transaction);
          await context.applyResult({ row, result: providerResult, completedAt: receipt.completedAt, transaction });
          await record(row, recovering ? 'mutation_recovered' : 'mutation_applied', transaction);
          await row.update({ state: 'applied', broker_receipt: { ...receipt, result: providerResult }, last_error: null,
            updated_at: new Date(now()), applied_at: new Date(now()) }, { transaction });
          await L.destroy({ where: { operation_id: row.operation_id }, transaction, logging: false });
          await guard(transaction);
          return dto(row);
        });
        await guard(); return result;
      } catch (error) {
        await P.update({ last_error: safe(error), updated_at: new Date(now()) }, { where: { operation_id: payload.operationId,
          actor_user_id: actor.userId, scope_digest: scopeDigest, state: 'attempted' }, logging: false });
        throw error;
      }
    } catch (error) {
      if (error?.name === 'SequelizeUniqueConstraintError' || ['ER_LOCK_DEADLOCK', 'ER_LOCK_WAIT_TIMEOUT'].includes(error?.original?.code)) fail('business_profile_mutation_busy');
      fail(safe(error));
    }
  }
  return { execute: (context, kind, input, localInput) => run(context, kind, input, localInput, false),
    recover: (context, operationId) => run(context, 'status', { operationId }, null, true) };
}
module.exports = { createBusinessProfileMutationJournal, actorFor, safe, status };
