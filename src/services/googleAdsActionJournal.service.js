'use strict';
const C = require('../../services/integrations-broker/src/google-action-management-contract');
const { canonical } = require('../../services/integrations-broker/src/canonical');
const { safe: brokerSafe, project } = require('./googleAdsActionManagementBrokerClient.service');
const { assertGoogleConversionMutationAccess } = require('../lib/googleConversionMutationAccess');
const { positive } = require('./googleAdsBrokerScope.service');
const { Op } = require('sequelize');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const fail = code => { throw Object.assign(Error(code), { code }); };
const LOCAL = new Set(['google_action_session_required', 'google_action_not_found', 'google_action_conflict',
  'google_action_confirmation_required', 'google_action_broker_required', 'google_action_not_ready', 'conversion_paused']);
const safe = error => LOCAL.has(error?.code) ? error.code : brokerSafe(error);
const status = error => safe(error) === 'google_action_session_required' ? 401
  : safe(error) === 'google_action_not_found' ? 404
    : safe(error) === 'scope_denied' ? 403 : safe(error) === 'invalid_request' ? 400
      : ['google_action_conflict', 'google_action_confirmation_required', 'google_action_broker_required',
        'google_action_not_ready', 'conversion_paused', 'action_plan_expired', 'action_plan_busy', 'action_plan_conflict'].includes(safe(error)) ? 409 : 503;
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype
  && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
function dto(plan, command) {
  return { planId: plan.plan_id, commandId: command.command_id, commandState: command.state,
    outcomeUnknown: Boolean(plan.apply_command_id && plan.receipt?.state !== 'applied'),
    plan: plan.receipt ? structuredClone(plan.receipt) : null };
}

// No worker, lease expiry or automatic retry. A command is committed before
// transport, then dispatched at most once by CRM. Recovery uses a new, read-only
// status command for the SAME plan; it never changes the apply identity.
function createGoogleAdsActionJournal({ models, sessions, now = Date.now,
  assertMutationAccess = assertGoogleConversionMutationAccess,
  enabled = () => process.env.GOOGLE_ADS_BROKER_ENABLED === 'true'
    && process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED === 'true'
    && process.env.GOOGLE_ADS_ACTION_MANAGEMENT_BROKER_ENABLED === 'true'
    && String(process.env.RUNTIME_ROLE || '').toLowerCase() !== 'gateway' }) {
  const getModels = () => typeof models === 'function' ? models() : models;
  const getSessions = () => sessions || require('./accessSession.service');
  return { async execute(context, family, input, options) {
    try {
      if (!Object.hasOwn(C.OPERATIONS, family) || !exact(options, 'requestId,confirmExternalMutation')
        || typeof options.requestId !== 'string' || !UUID.test(options.requestId)
        || typeof options.confirmExternalMutation !== 'boolean') fail('invalid_request');
      const requestId = options.requestId, payload = structuredClone(input);
      C.validate(C.OPERATIONS[family], payload);
      if (family === 'apply' && !options.confirmExternalMutation) fail('google_action_confirmation_required');
      const actor = structuredClone(context.actor), runtime = context.runtime, authorize = context.beforeExecute, scopeKey = context.scopeKey;
      if (!exact(actor, 'userId,sessionRef,expiresAt') || !positive(actor.userId) || typeof actor.sessionRef !== 'string'
        || !UUID.test(actor.sessionRef) || !Number.isSafeInteger(actor.expiresAt)) fail('google_action_session_required');
      if (runtime?.deliveryMode !== 'broker' || !runtime.brokerContext || typeof authorize !== 'function') fail('google_action_broker_required');
      if (typeof scopeKey !== 'string' || !/^(clinic|group):[1-9][0-9]{0,9}$/.test(scopeKey)) fail('invalid_request');
      const m = getModels();
      const gate = () => { if (enabled() !== true) fail('broker_cohort_disabled'); };
      gate();
      const captured = await runtime.broker.assert(runtime.account, runtime.brokerContext);
      const owner = C.hash({ actor, scopeKey, captured });
      const guard = async (transaction) => {
        gate();
        try { await getSessions().verifyReference({ userId: Number(actor.userId), sessionRef: actor.sessionRef,
          expiresAt: new Date(actor.expiresAt) }, { transaction }); }
        catch (error) {
          if (error?.status === 401 || error?.code === 'auth_invalid') fail('google_action_session_required');
          throw error;
        }
        if (await authorize({ transaction }) !== true) fail('scope_denied');
        // Pauses also cover every clinic sharing the managed account. Read-only
        // receipt recovery remains possible while preparation/apply are paused.
        if (family !== 'status') {
          const clinics = await m.Clinica.findAll({ where: { id_clinica: { [Op.in]: captured.clinicIds } },
            attributes: ['id_clinica', 'estado_clinica'], order: [['id_clinica', 'ASC']], raw: true, logging: false,
            ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) });
          if (clinics.length !== captured.clinicIds.length || clinics.some(row => ![true, 1, '1'].includes(row.estado_clinica))) fail('conversion_paused');
        }
        await assertMutationAccess({ userId: Number(actor.userId), customerId: captured.customerId,
          runtimeAccountId: runtime.account.id, models: m, transaction });
        if (canonical(await runtime.broker.assert(runtime.account, runtime.brokerContext, { transaction })) !== canonical(captured)) fail('scope_denied');
        gate(); return true;
      };
      await guard();
      const planId = family === 'prepare' ? requestId : payload.planId;
      const P = m.GoogleAdsActionPlan, Q = m.GoogleAdsActionCommand;
      if (family === 'prepare') {
        // findOrCreate handles two concurrent first requests with this UUID. No
        // provider call is allowed until the subsequent command transaction commits.
        await P.findOrCreate({ where: { plan_id: planId }, defaults: { owner_digest: owner,
          actor_user_id: Number(actor.userId), session_ref: actor.sessionRef, mapping_id: runtime.account.id,
          customer_id: captured.customerId, input: payload, receipt: null, apply_command_id: null,
          created_at: new Date(now()), updated_at: new Date(now()) }, logging: false });
      }
      const owned = async transaction => {
        const p = await P.findByPk(planId, { transaction, lock: transaction.LOCK.UPDATE, logging: false });
        if (!p || p.owner_digest !== owner) fail('google_action_not_found');
        if (family === 'prepare' && canonical(p.input) !== canonical(payload)) fail('google_action_conflict');
        return p;
      };
      const claim = await m.sequelize.transaction(async transaction => {
        await guard(transaction);
        const p = await owned(transaction);
        const previous = await Q.findByPk(requestId, { transaction, lock: transaction.LOCK.UPDATE, logging: false });
        if (previous) {
          if (previous.plan_id !== planId || previous.family !== family) fail('google_action_conflict');
          return { send: false, result: dto(p, previous) };
        }
        if (family === 'apply') {
          if (p.apply_command_id) fail('google_action_conflict');
          if (p.receipt?.state !== 'prepared') fail('google_action_not_ready');
          if (p.receipt.expiresAt <= now()) fail('action_plan_expired');
          await p.update({ apply_command_id: requestId, updated_at: new Date(now()) }, { transaction });
        }
        if (family === 'validate' && (p.apply_command_id || p.receipt?.state !== 'prepared')) fail('google_action_not_ready');
        const q = await Q.create({ command_id: requestId, plan_id: planId, family, state: 'attempted',
          attempted_at: new Date(now()), completed_at: null, last_error: null }, { transaction });
        return { send: true, result: dto(p, q) };
      });
      if (!claim.send) { await guard(); return claim.result; }
      try {
        const response = await runtime.broker.actionManagement(runtime.account, runtime.brokerContext, family, payload,
          { requestId, beforeExecute: () => guard() });
        // Keep SQL receipts bounded even if a future adapter bypasses the client.
        const receipt = project(family, response, requestId, payload);
        const result = await m.sequelize.transaction(async transaction => {
          await guard(transaction); const p = await owned(transaction);
          const q = await Q.findByPk(requestId, { transaction, lock: transaction.LOCK.UPDATE });
          // A status response also has to match the original request when its
          // prepare ACK was lost. It cannot substitute a different event/ID.
          project('prepare', { planId, state: 'prepared', expiresAt: receipt.expiresAt, changes: receipt.changes }, planId, p.input);
          if (p.receipt && (canonical(p.receipt.changes) !== canonical(receipt.changes)
            || p.receipt.expiresAt !== receipt.expiresAt)) fail('broker_response_invalid');
          // Concurrent status may have observed an earlier state; never regress
          // applied -> attempted/prepared, or attempted -> prepared.
          const rank = { prepared: 0, attempted: 1, applied: 2 };
          if (!p.receipt || rank[receipt.state] >= rank[p.receipt.state]) {
            if (p.receipt?.state === 'applied' && canonical(p.receipt.results) !== canonical(receipt.results)) fail('broker_response_invalid');
            await p.update({ receipt, updated_at: new Date(now()) }, { transaction });
          }
          await q.update({ state: 'completed', completed_at: new Date(now()), last_error: null }, { transaction });
          return dto(p, q);
        });
        await guard(); return result;
      } catch (error) {
        // Never store provider messages/payloads. An error after dispatch says
        // nothing about whether Google committed; the durable identity survives.
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
