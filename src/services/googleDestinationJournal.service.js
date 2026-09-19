'use strict';
const C = require('../../services/integrations-broker/src/google-destination-contract');
const A = require('../../services/integrations-broker/src/google-action-management-contract');
const { canonical } = require('../../services/integrations-broker/src/canonical');
const { project, safe: brokerSafe } = require('./googleDataManagerDestinationsBrokerClient.service');
const { project: projectPlan } = require('./googleAdsActionManagementBrokerClient.service');
const { assertGoogleConversionMutationAccess } = require('../lib/googleConversionMutationAccess');
const { positive } = require('./googleAdsBrokerScope.service');
const { fromDestination } = require('../../services/platform-audit/src/google-destination-event');
const { createRepository } = require('./platformAudit.repository');
const { Op } = require('sequelize');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uuid = v => typeof v === 'string' && UUID.test(v);
const fail = code => { throw Object.assign(Error(code), { code }); };
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype
  && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const LOCAL = new Set(['google_destination_session_required','google_destination_not_found','google_destination_conflict',
  'google_destination_confirmation_required','google_destination_not_ready','google_destination_broker_required',
  'google_destination_recovery_unavailable','conversion_paused']);
const safe = error => error?.code === 'asset_in_use' ? 'scope_denied'
  : error?.code === 'google_ads_account_mapping_changed' ? 'google_destination_conflict'
    : error?.code === 'invalid_customer_id' ? 'invalid_request' : LOCAL.has(error?.code) ? error.code : brokerSafe(error);
const status = error => safe(error) === 'google_destination_session_required' ? 401
  : safe(error) === 'google_destination_not_found' ? 404 : safe(error) === 'scope_denied' ? 403
    : safe(error) === 'invalid_request' ? 400 : LOCAL.has(safe(error)) ? 409 : 503;
const dto = (row, command) => ({ authorizationId: row.authorization_id, planId: row.plan_id,
  commandId: command.command_id, commandState: command.state,
  outcomeUnknown: !row.receipt || Boolean(row.revoke_command_id && row.receipt.state !== 'revoked'),
  canRevoke: row.receipt?.state !== 'revoked',
  authorization: row.receipt ? structuredClone(row.receipt) : null });

function createGoogleDestinationJournal({ models, sessions, audit, now = Date.now,
  assertMutationAccess = assertGoogleConversionMutationAccess,
  enabled = () => process.env.GOOGLE_ADS_BROKER_ENABLED === 'true'
    && process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED === 'true'
    && process.env.GOOGLE_ADS_ACTION_MANAGEMENT_BROKER_ENABLED === 'true'
    && process.env.GOOGLE_ADS_DESTINATIONS_BROKER_ENABLED === 'true'
    && String(process.env.RUNTIME_ROLE || '').trim().toLowerCase() !== 'gateway' }) {
  const getModels = () => typeof models === 'function' ? models() : models;
  const prepareContext = async (context, family) => {
      const actor = structuredClone(context.actor), runtime = context.runtime, scopeKey = context.scopeKey, authorize = context.beforeExecute;
      if (!exact(actor, 'userId,sessionRef,expiresAt') || !positive(actor.userId) || !uuid(actor.sessionRef)
        || !Number.isSafeInteger(actor.expiresAt)) fail('google_destination_session_required');
      actor.userId = Number(actor.userId);
      if (runtime?.deliveryMode !== 'broker' || !runtime.brokerContext || typeof authorize !== 'function') fail('google_destination_broker_required');
      if (typeof scopeKey !== 'string' || !/^(clinic|group):[1-9][0-9]{0,9}$/.test(scopeKey)) fail('invalid_request');
      const m = getModels(), events = audit || createRepository(m.PlatformAuditEvent), sessionService = sessions || require('./accessSession.service');
      const gate = () => { if (enabled() !== true) fail('broker_cohort_disabled'); }; gate();
      const captured = await runtime.broker.assert(runtime.account, runtime.brokerContext);
      const owner = A.hash({ actor, scopeKey, captured }), scopeDigest = A.hash(captured);
      const guard = async transaction => {
        gate();
        try { await sessionService.verifyReference({ userId: actor.userId, sessionRef: actor.sessionRef, expiresAt: new Date(actor.expiresAt) }, { transaction }); }
        catch (error) { if (error?.status === 401 || error?.code === 'auth_invalid') fail('google_destination_session_required'); throw error; }
        if (await authorize({ transaction }) !== true) fail('scope_denied');
        if (family === 'authorize') {
          const clinics = await m.Clinica.findAll({ where: { id_clinica: { [Op.in]: captured.clinicIds } },
            attributes: ['id_clinica','estado_clinica'], order: [['id_clinica','ASC']], raw: true, logging: false,
            ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) });
          if (clinics.length !== captured.clinicIds.length || clinics.some(row => ![true,1,'1'].includes(row.estado_clinica))) fail('conversion_paused');
        }
        try { await assertMutationAccess({ userId: actor.userId, customerId: captured.customerId, runtimeAccountId: runtime.account.id, models: m, transaction }); }
        catch (error) { fail(safe(error)); }
        if (canonical(await runtime.broker.assert(runtime.account, runtime.brokerContext, { transaction })) !== canonical(captured)) fail('scope_denied');
        gate(); return true;
      };
      return { actor, runtime, scopeKey, m, captured, owner, scopeDigest, guard, events };
  };
  return {
    async list(context, input, options) {
      try { return await require('./googleDestinationRecovery.service').listDestinations({ prepareContext, now }, context, input, options); }
      catch (error) { fail(safe(error)); }
    },
    async execute(context, family, input, options) {
    try {
      if (!Object.hasOwn(C.OPERATIONS, family) || !exact(options, 'requestId,confirmAuthorization')
        || !uuid(options.requestId) || typeof options.confirmAuthorization !== 'boolean') fail('invalid_request');
      const payload = structuredClone(input), requestId = options.requestId;
      C.validate(C.OPERATIONS[family], payload);
      if (family === 'authorize' && options.confirmAuthorization !== true) fail('google_destination_confirmation_required');
      // Revocation always carries the original intent, including an unknown one.
      if (family === 'revoke' && !payload.input) fail('invalid_request');
      const { actor, runtime, scopeKey, m, captured, owner, scopeDigest, guard, events } = await prepareContext(context, family);
      const P = m.GoogleAdsActionPlan, D = m.GoogleDestinationAuthorization, Q = m.GoogleDestinationCommand;
      const auditCapacity = new WeakMap();
      const record = async (row, q, reason, transaction, relatedCommandRef = null) => {
        try {
          const date = new Date(now());
          if (!auditCapacity.has(transaction)) {
            const health = await events.health(date, { includeUnresolved: false, transaction });
            if (!Number.isSafeInteger(health.pending) || health.pending >= 10000
              || !Number.isFinite(health.oldestAgeSeconds) || health.oldestAgeSeconds >= 3600) fail('audit_unavailable');
            auditCapacity.set(transaction, 10000 - health.pending);
          }
          const remaining = auditCapacity.get(transaction); if (remaining < 1) fail('audit_unavailable');
          auditCapacity.set(transaction, remaining - 1);
          await events.append(fromDestination(row, q, captured, actor, reason, { now: date, relatedCommandRef }), { transaction });
        } catch { fail('audit_unavailable'); }
      };
      const parent = async (id, transaction) => {
        const p = await P.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE, logging: false });
        if (!p || Number(p.actor_user_id) !== actor.userId) fail('google_destination_not_found');
        if (!p.scope_digest || !p.scope_key || !(p.session_expires_at instanceof Date)) fail('google_destination_recovery_unavailable');
        const original = { userId: Number(p.actor_user_id), sessionRef: p.session_ref, expiresAt: p.session_expires_at.getTime() };
        if (p.scope_key !== scopeKey || p.scope_digest !== scopeDigest || p.owner_digest !== A.hash({ actor: original, scopeKey, captured })) fail('google_destination_not_found');
        if (p.closed_at || p.receipt?.state !== 'applied' || !p.apply_command_id) fail('google_destination_not_ready');
        projectPlan('status', p.receipt, requestId, { planId: id });
        projectPlan('prepare', { planId: id, state: 'prepared', expiresAt: p.receipt.expiresAt, changes: p.receipt.changes }, id, p.input);
        return p;
      };
      const authorizationId = family === 'authorize' ? requestId : payload.authorizationId;
      const selection = family === 'authorize' ? payload : family === 'revoke' ? payload.input : null;
      await guard();
      // Lock parent before child in every transaction, also when reading by UUID.
      let planId = selection?.planId;
      if (!planId) {
        const hint = await D.findByPk(authorizationId, { attributes: ['plan_id','actor_user_id'], raw: true, logging: false });
        if (!hint || Number(hint.actor_user_id) !== actor.userId) fail('google_destination_not_found');
        planId = hint.plan_id;
      }
      const owned = async transaction => {
        const p = await parent(planId, transaction);
        let row = await D.findByPk(authorizationId, { transaction, lock: transaction.LOCK.UPDATE, logging: false });
        if (!row && selection) row = await D.create({ authorization_id: authorizationId, plan_id: planId, owner_digest: owner,
          actor_user_id: actor.userId, session_ref: actor.sessionRef, session_expires_at: new Date(actor.expiresAt),
          scope_key: scopeKey, scope_digest: scopeDigest, mapping_id: runtime.account.id, customer_id: captured.customerId,
          input: selection, receipt: null, revoke_command_id: null, created_at: new Date(now()), updated_at: new Date(now()) }, { transaction });
        if (!row || Number(row.actor_user_id) !== actor.userId || row.plan_id !== planId) fail('google_destination_not_found');
        const original = { userId: Number(row.actor_user_id), sessionRef: row.session_ref, expiresAt: row.session_expires_at.getTime() };
        if (row.scope_key !== scopeKey || row.scope_digest !== scopeDigest || row.owner_digest !== A.hash({ actor: original, scopeKey, captured })
          || family === 'authorize' && row.owner_digest !== owner) fail('google_destination_not_found');
        if (selection && canonical(row.input) !== canonical(selection)) fail('google_destination_conflict');
        if (row.input.targets.some(target => !p.receipt.changes.some(change => change.event === target.event))) fail('invalid_request');
        return { row, p };
      };
      const complete = async (row, q, reason, transaction, related = null) => {
        if (q.state === 'completed') return;
        if (Number(q.actor_user_id) !== actor.userId || !uuid(q.session_ref)) fail('google_destination_recovery_unavailable');
        await record(row, q, reason, transaction, related);
        await q.update({ state: 'completed', completed_at: new Date(now()), last_error: reason === 'authorization_withdrawn' ? 'authorization_withdrawn' : null }, { transaction });
      };
      const claim = await m.sequelize.transaction(async transaction => {
        await guard(transaction); const { row } = await owned(transaction);
        const prior = await Q.findByPk(requestId, { transaction, lock: transaction.LOCK.UPDATE, logging: false });
        if (prior) {
          if (prior.authorization_id !== authorizationId || prior.family !== family || Number(prior.actor_user_id) !== actor.userId
            || prior.session_ref !== actor.sessionRef) fail('google_destination_conflict');
          return { send: false, result: dto(row, prior) };
        }
        if (family === 'authorize' && (row.revoke_command_id || row.receipt)) fail('google_destination_conflict');
        if (family === 'revoke') {
          if (row.receipt?.state === 'revoked') fail('google_destination_conflict');
          // A fresh explicit withdrawal is safe for the SAME immutable intent.
          // It never retries an authorize or recreates a delivery permission.
          if (!row.revoke_command_id) await row.update({ revoke_command_id: requestId, updated_at: new Date(now()) }, { transaction });
        }
        const q = await Q.create({ command_id: requestId, authorization_id: authorizationId, family,
          actor_user_id: actor.userId, session_ref: actor.sessionRef, state: 'attempted', attempted_at: new Date(now()), completed_at: null, last_error: null }, { transaction });
        await record(row, q, 'command_admitted', transaction); return { send: true };
      });
      if (!claim.send) { await guard(); return claim.result; }
      try {
        const response = await runtime.broker.destinations(runtime.account, runtime.brokerContext, family, payload,
          { requestId, beforeExecute: () => guard() });
        const receipt = project(family, response, requestId, payload);
        const result = await m.sequelize.transaction(async transaction => {
          await guard(transaction); const { row, p } = await owned(transaction);
          const q = await Q.findByPk(requestId, { transaction, lock: transaction.LOCK.UPDATE });
          project('authorize', { ...receipt, state: 'active' }, authorizationId, row.input);
          for (const destination of receipt.destinations) {
            const change = p.receipt.changes.find(item => item.event === destination.event);
            const expected = change.change === 'unchanged' ? change.actionId : p.receipt.results.find(item => item.event === destination.event)?.actionId;
            if (destination.conversionActionId !== expected) fail('broker_response_invalid');
          }
          if (row.receipt && canonical(row.receipt.destinations) !== canonical(receipt.destinations)) fail('broker_response_invalid');
          if (row.receipt?.state !== 'revoked') await row.update({ receipt, updated_at: new Date(now()) }, { transaction });
          if (q.state !== 'completed') await complete(row, q, 'broker_acknowledged', transaction);
          if (family === 'status' || family === 'revoke') {
            const pending = await Q.findAll({ where: { authorization_id: authorizationId, state: 'attempted',
              family: { [Op.in]: row.receipt?.state === 'revoked' ? ['authorize','revoke'] : ['authorize'] } },
              order: [['command_id','ASC']], limit: 1001, transaction, lock: transaction.LOCK.UPDATE });
            if (pending.length > 1000) fail('google_destination_recovery_unavailable');
            for (const old of pending) {
              if (old.command_id === requestId) continue;
              await complete(row, old,
                old.family === 'authorize' && row.receipt.state === 'revoked' ? 'authorization_withdrawn' : 'result_recovered', transaction, requestId);
            }
          }
          return dto(row, q);
        });
        await guard(); return result;
      } catch (error) {
        await Q.update({ last_error: safe(error) }, { where: { command_id: requestId, authorization_id: authorizationId, state: 'attempted' }, logging: false });
        throw error;
      }
    } catch (error) {
      if (error?.name === 'SequelizeUniqueConstraintError') fail('google_destination_conflict');
      fail(safe(error));
    }
  } };
}
module.exports = { createGoogleDestinationJournal, safe, status };
