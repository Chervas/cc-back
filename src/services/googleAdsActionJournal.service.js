'use strict';
const C = require('../../services/integrations-broker/src/google-action-management-contract');
const { canonical } = require('../../services/integrations-broker/src/canonical');
const { safe: brokerSafe, project } = require('./googleAdsActionManagementBrokerClient.service');
const { assertGoogleConversionMutationAccess } = require('../lib/googleConversionMutationAccess');
const { positive } = require('./googleAdsBrokerScope.service');
const { Op } = require('sequelize');
const { fromActionPlan } = require('../../services/platform-audit/src/google-action-plan-event');
const { createRepository } = require('./platformAudit.repository');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = code => { throw Object.assign(Error(code), { code }); };
const LOCAL = new Set(['google_action_session_required', 'google_action_not_found', 'google_action_conflict',
  'google_action_confirmation_required', 'google_action_broker_required', 'google_action_not_ready', 'conversion_paused',
  'google_action_closed', 'google_action_recovery_unavailable']);
const safe = error => LOCAL.has(error?.code) ? error.code : brokerSafe(error);
const status = error => safe(error) === 'google_action_session_required' ? 401
  : safe(error) === 'google_action_not_found' ? 404
    : safe(error) === 'scope_denied' ? 403 : safe(error) === 'invalid_request' ? 400
      : ['google_action_conflict', 'google_action_confirmation_required', 'google_action_broker_required', 'google_action_closed',
        'google_action_recovery_unavailable', 'google_action_not_ready', 'conversion_paused', 'action_plan_expired', 'action_plan_busy', 'action_plan_conflict'].includes(safe(error)) ? 409 : 503;
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype
  && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const cancellable = p => !p.closed_at && !p.apply_command_id && !['attempted','applied'].includes(p.receipt?.state);
function dto(plan, command, owner, now) {
  return { planId: plan.plan_id, commandId: command.command_id, commandState: command.state,
    outcomeUnknown: Boolean(plan.apply_command_id && plan.receipt?.state !== 'applied' || plan.receipt?.state === 'attempted'),
    closed: Boolean(plan.closed_at), canCancel: cancellable(plan),
    canApply: plan.owner_digest === owner && !plan.closed_at && !plan.apply_command_id
      && plan.receipt?.state === 'prepared' && plan.receipt.expiresAt > now,
    plan: plan.receipt ? structuredClone(plan.receipt) : null };
}
// No worker, expired lease or automatic retry. New sessions of the SAME actor
// may read/cancel under an identical current scope; they never adopt apply rights.
function createGoogleAdsActionJournal({ models, sessions, audit, now = Date.now,
  assertMutationAccess = assertGoogleConversionMutationAccess,
  enabled = () => process.env.GOOGLE_ADS_BROKER_ENABLED === 'true'
    && process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED === 'true'
    && process.env.GOOGLE_ADS_ACTION_MANAGEMENT_BROKER_ENABLED === 'true'
    && String(process.env.RUNTIME_ROLE || '').trim().toLowerCase() !== 'gateway' }) {
  const getModels = () => typeof models === 'function' ? models() : models;
  const getSessions = () => sessions || require('./accessSession.service');
  return { async execute(context, family, input, options) {
    try {
      const cancelling = family === 'cancel', recovering = ['status','cancel'].includes(family);
      if (!Object.hasOwn(C.OPERATIONS, family) && !cancelling || !exact(options, 'requestId,confirmExternalMutation')
        || typeof options.requestId !== 'string' || !UUID.test(options.requestId)
        || typeof options.confirmExternalMutation !== 'boolean') fail('invalid_request');
      const requestId = options.requestId, payload = structuredClone(input);
      if (cancelling) {
        if (!exact(payload, 'planId,input') || typeof payload.planId !== 'string' || !UUID.test(payload.planId)) fail('invalid_request');
        C.validate(C.OPERATIONS.prepare, payload.input);
      } else C.validate(C.OPERATIONS[family], payload);
      if (family === 'apply' && !options.confirmExternalMutation) fail('google_action_confirmation_required');
      const actor = structuredClone(context.actor), runtime = context.runtime, authorize = context.beforeExecute, scopeKey = context.scopeKey;
      if (!exact(actor, 'userId,sessionRef,expiresAt') || !positive(actor.userId) || typeof actor.sessionRef !== 'string'
        || !UUID.test(actor.sessionRef) || !Number.isSafeInteger(actor.expiresAt)) fail('google_action_session_required');
      actor.userId = Number(actor.userId);
      if (runtime?.deliveryMode !== 'broker' || !runtime.brokerContext || typeof authorize !== 'function') fail('google_action_broker_required');
      if (typeof scopeKey !== 'string' || !/^(clinic|group):[1-9][0-9]{0,9}$/.test(scopeKey)) fail('invalid_request');
      const m = getModels(), events = audit || createRepository(m.PlatformAuditEvent);
      const gate = () => { if (enabled() !== true) fail('broker_cohort_disabled'); }; gate();
      const captured = await runtime.broker.assert(runtime.account, runtime.brokerContext);
      const owner = C.hash({ actor, scopeKey, captured }), scopeDigest = C.hash(captured);
      const guard = async transaction => {
        gate();
        try { await getSessions().verifyReference({ userId: actor.userId, sessionRef: actor.sessionRef,
          expiresAt: new Date(actor.expiresAt) }, { transaction }); }
        catch (error) { if (error?.status === 401 || error?.code === 'auth_invalid') fail('google_action_session_required'); throw error; }
        if (await authorize({ transaction }) !== true) fail('scope_denied');
        if (!recovering) {
          const clinics = await m.Clinica.findAll({ where: { id_clinica: { [Op.in]: captured.clinicIds } },
            attributes: ['id_clinica', 'estado_clinica'], order: [['id_clinica', 'ASC']], raw: true, logging: false,
            ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) });
          if (clinics.length !== captured.clinicIds.length || clinics.some(row => ![true, 1, '1'].includes(row.estado_clinica))) fail('conversion_paused');
        }
        await assertMutationAccess({ userId: actor.userId, customerId: captured.customerId,
          runtimeAccountId: runtime.account.id, models: m, transaction });
        if (canonical(await runtime.broker.assert(runtime.account, runtime.brokerContext, { transaction })) !== canonical(captured)) fail('scope_denied');
        gate(); return true;
      };
      const record = async (p, q, reason, transaction, relatedCommandRef = null) => {
        try {
          const date = new Date(now()), health = await events.health(date, { includeUnresolved: false, transaction });
          if (!Number.isSafeInteger(health.pending) || health.pending >= 10000 || !Number.isFinite(health.oldestAgeSeconds)
            || health.oldestAgeSeconds >= 3600) fail('audit_unavailable');
          await events.append(fromActionPlan(p, q, captured, actor, reason, { now: date, relatedCommandRef }), { transaction });
        } catch { fail('audit_unavailable'); }
      };
      await guard();
      const planId = family === 'prepare' ? requestId : payload.planId;
      const P = m.GoogleAdsActionPlan, Q = m.GoogleAdsActionCommand;
      if (family === 'prepare' || cancelling) {
        // A cancel can create a tombstone before an in-flight preparation is
        // admitted. It persists the original selection and never contacts Google.
        await P.findOrCreate({ where: { plan_id: planId }, defaults: { owner_digest: owner,
          actor_user_id: actor.userId, session_ref: actor.sessionRef, session_expires_at: new Date(actor.expiresAt),
          scope_key: scopeKey, scope_digest: scopeDigest, mapping_id: runtime.account.id, customer_id: captured.customerId,
          input: cancelling ? payload.input : payload, receipt: null, apply_command_id: null, closed_at: null, closed_by_session_ref: null,
          created_at: new Date(now()), updated_at: new Date(now()) }, logging: false });
      }
      const owned = async transaction => {
        const p = await P.findByPk(planId, { transaction, lock: transaction.LOCK.UPDATE, logging: false });
        if (!p || Number(p.actor_user_id) !== actor.userId) fail('google_action_not_found');
        if (!p.scope_digest || !p.scope_key || !(p.session_expires_at instanceof Date)) fail('google_action_recovery_unavailable');
        const originalActor = { userId: Number(p.actor_user_id), sessionRef: p.session_ref, expiresAt: p.session_expires_at.getTime() };
        if (p.scope_key !== scopeKey || p.scope_digest !== scopeDigest
          || p.owner_digest !== C.hash({ actor: originalActor, scopeKey, captured })
          || !recovering && p.owner_digest !== owner) fail('google_action_not_found');
        if ((family === 'prepare' || cancelling) && canonical(p.input) !== canonical(cancelling ? payload.input : payload)) fail('google_action_conflict');
        return p;
      };
      const complete = async (p, q, reason, transaction, related = null) => {
        if (q.state === 'completed') return;
        if (Number(q.actor_user_id) !== actor.userId || typeof q.session_ref !== 'string' || !UUID.test(q.session_ref)) fail('google_action_recovery_unavailable');
        await record(p, q, reason, transaction, related);
        await q.update({ state: 'completed', completed_at: new Date(now()),
          last_error: reason === 'command_cancelled' ? 'google_action_closed' : null }, { transaction });
      };
      const claim = await m.sequelize.transaction(async transaction => {
        await guard(transaction); const p = await owned(transaction);
        const previous = await Q.findByPk(requestId, { transaction, lock: transaction.LOCK.UPDATE, logging: false });
        if (previous) {
          if (previous.plan_id !== planId || previous.family !== family || Number(previous.actor_user_id) !== actor.userId
            || previous.session_ref !== actor.sessionRef) fail('google_action_conflict');
          return { send: false, result: dto(p, previous, owner, now()) };
        }
        if (p.closed_at && !recovering) fail('google_action_closed');
        if (family === 'apply') {
          if (p.apply_command_id) fail('google_action_conflict');
          if (p.receipt?.state !== 'prepared') fail('google_action_not_ready');
          if (p.receipt.expiresAt <= now()) fail('action_plan_expired');
          await p.update({ apply_command_id: requestId, updated_at: new Date(now()) }, { transaction });
        }
        if (family === 'validate' && (p.apply_command_id || p.receipt?.state !== 'prepared')) fail('google_action_not_ready');
        if (cancelling && !p.closed_at && !cancellable(p)) fail('google_action_conflict');
        const q = await Q.create({ command_id: requestId, plan_id: planId, actor_user_id: actor.userId, session_ref: actor.sessionRef,
          family, state: 'attempted', attempted_at: new Date(now()), completed_at: null, last_error: null }, { transaction });
        await record(p, q, 'command_admitted', transaction);
        if (cancelling) {
          if (!p.closed_at) await p.update({ closed_at: new Date(now()), closed_by_session_ref: actor.sessionRef, updated_at: new Date(now()) }, { transaction });
          const pending = await Q.findAll({ where: { plan_id: planId, state: 'attempted', family: { [Op.in]: ['prepare','validate','status'] } },
            order: [['command_id','ASC']], limit: 1001, transaction, lock: transaction.LOCK.UPDATE });
          if (pending.length > 1000) fail('google_action_recovery_unavailable');
          for (const old of pending) await complete(p, old, 'command_cancelled', transaction, requestId);
          await complete(p, q, 'preparation_cancelled', transaction);
          return { send: false, result: dto(p, q, owner, now()) };
        }
        if (family === 'status' && p.closed_at) {
          await complete(p, q, 'closure_observed', transaction);
          return { send: false, result: dto(p, q, owner, now()) };
        }
        return { send: true };
      });
      if (!claim.send) { await guard(); return claim.result; }
      try {
        const response = await runtime.broker.actionManagement(runtime.account, runtime.brokerContext, family, payload,
          { requestId, beforeExecute: () => guard() });
        const receipt = project(family, response, requestId, payload);
        const result = await m.sequelize.transaction(async transaction => {
          await guard(transaction); const p = await owned(transaction);
          const q = await Q.findByPk(requestId, { transaction, lock: transaction.LOCK.UPDATE });
          // A cancelled in-flight read cannot overwrite its completed history.
          if (q.state === 'completed' && q.last_error === 'google_action_closed') return dto(p, q, owner, now());
          project('prepare', { planId, state: 'prepared', expiresAt: receipt.expiresAt, changes: receipt.changes }, planId, p.input);
          if (p.receipt && (canonical(p.receipt.changes) !== canonical(receipt.changes) || p.receipt.expiresAt !== receipt.expiresAt)) fail('broker_response_invalid');
          const rank = { prepared: 0, attempted: 1, applied: 2 };
          if (!p.receipt || rank[receipt.state] >= rank[p.receipt.state]) {
            if (p.receipt?.state === 'applied' && canonical(p.receipt.results) !== canonical(receipt.results)) fail('broker_response_invalid');
            await p.update({ receipt, updated_at: new Date(now()) }, { transaction });
          }
          await complete(p, q, 'broker_acknowledged', transaction);
          if (family === 'status') {
            const ids = [p.plan_id, ...(p.receipt?.state === 'applied' && p.apply_command_id ? [p.apply_command_id] : [])];
            for (const id of ids) {
              const old = await Q.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
              if (old && ['prepare','apply'].includes(old.family) && old.state === 'attempted') await complete(p, old, 'result_recovered', transaction, requestId);
            }
          }
          return dto(p, q, owner, now());
        });
        await guard(); return result;
      } catch (error) {
        // A transport/commit error does not prove whether Google committed.
        await Q.update({ last_error: safe(error) }, { where: { command_id: requestId, plan_id: planId, state: 'attempted' }, logging: false });
        throw error;
      }
    } catch (error) {
      if (error?.name === 'SequelizeUniqueConstraintError') fail('google_action_conflict');
      fail(safe(error));
    }
  } };
}
module.exports = { createGoogleAdsActionJournal, safe, status };
