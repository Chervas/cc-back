'use strict';
const { canonical } = require('../../services/integrations-broker/src/canonical');
const { createGoogleConversionSubmissionRepository } = require('./googleConversionSubmission.repository');
const { assertGoogleConversionMutationAccess } = require('../lib/googleConversionMutationAccess');
const { GOOGLE_DATA_MANAGER_SCOPE, missingGoogleScopes } = require('./googleAdsScopedRuntime.service');
const { createRepository } = require('./platformAudit.repository');
const { fromReceiptReview } = require('../../services/platform-audit/src/google-receipt-review-event');
const { safe: brokerSafe } = require('./googleDataManagerBrokerClient.service');
const { positive } = require('./googleAdsBrokerScope.service');
const fail = code => { throw Object.assign(Error(code), { code }); };
const uuid = v => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const exact = (v, keys) => v && Object.getPrototypeOf(v) === Object.prototype && Object.keys(v).sort().join(',') === keys.split(',').sort().join(',');
const settings = env => ({ audience: env.GOOGLE_ADS_BROKER_AUDIENCE, keyId: env.GOOGLE_ADS_BROKER_KEY_ID,
  activeSince: env.GOOGLE_ADS_CONVERSIONS_ACTIVE_SINCE });
const LOCAL = new Set(['google_receipt_session_required', 'google_receipt_not_found', 'google_receipt_request_conflict',
  'google_receipt_broker_required', 'conversion_submission_conflict']);
const safe = error => error?.code === 'asset_in_use' ? 'scope_denied'
  : error?.code === 'google_ads_account_mapping_changed' ? 'conversion_submission_conflict'
    : LOCAL.has(error?.code) ? error.code : brokerSafe(error);
const status = error => safe(error) === 'google_receipt_session_required' ? 401
  : safe(error) === 'google_receipt_not_found' ? 404 : safe(error) === 'scope_denied' ? 403
    : safe(error) === 'invalid_request' ? 400 : LOCAL.has(safe(error)) ? 409 : 503;
const reviewEnabled = (env = process.env) => env.GOOGLE_ADS_BROKER_ENABLED === 'true'
  && env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED === 'true' && env.GOOGLE_ADS_RECEIPT_RECONCILIATION_BROKER_ENABLED === 'true'
  && String(env.RUNTIME_ROLE || '').trim().toLowerCase() !== 'gateway';
function validInput(family, input) {
  if (family === 'check') return exact(input, 'submissionId') && uuid(input.submissionId);
  const c = input?.cursor;
  return family === 'list' && exact(input, 'cursor') && (c === null || exact(c, 'createdAt,submissionId')
    && uuid(c.submissionId) && typeof c.createdAt === 'string' && /^20\d\d-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c.createdAt)
    && Number.isFinite(Date.parse(c.createdAt)) && new Date(c.createdAt).toISOString() === c.createdAt);
}
function createGoogleConversionReceiptReview({ models, sessions, audit, now = Date.now, env = process.env,
  assertMutationAccess = assertGoogleConversionMutationAccess } = {}) {
  return { async execute(context, family, input, options) {
    try {
      if (!validInput(family, input) || !exact(options, 'requestId') || !uuid(options.requestId)) fail('invalid_request');
      input = structuredClone(input); const requestId = options.requestId;
      const actor = structuredClone(context.actor), { runtime, scopeKey, beforeExecute } = context;
      if (!exact(actor, 'userId,sessionRef,expiresAt') || !positive(actor.userId) || !uuid(actor.sessionRef)
        || !Number.isSafeInteger(actor.expiresAt)) fail('google_receipt_session_required');
      actor.userId = Number(actor.userId);
      if (!/^(clinic|group):[1-9][0-9]{0,9}$/.test(scopeKey || '')) fail('invalid_request');
      if (runtime?.deliveryMode !== 'broker' || !runtime.brokerContext || typeof beforeExecute !== 'function') fail('google_receipt_broker_required');
      const m = typeof models === 'function' ? models() : models;
      const events = audit || createRepository(m.PlatformAuditEvent), sessionService = sessions || require('./accessSession.service');
      const configured = settings(env), gate = () => {
        if (!reviewEnabled(env)) fail('broker_cohort_disabled');
        if (canonical(settings(env)) !== canonical(configured)) fail('broker_configuration_invalid');
      };
      gate();
      const captured = await runtime.broker.assert(runtime.account, runtime.brokerContext);
      const guard = async transaction => {
        gate();
        try { await sessionService.verifyReference({ userId: actor.userId, sessionRef: actor.sessionRef, expiresAt: new Date(actor.expiresAt) }, { transaction }); }
        catch (error) { if (error?.status === 401 || error?.code === 'auth_invalid') fail('google_receipt_session_required'); throw error; }
        if (await beforeExecute({ transaction }) !== true) fail('scope_denied');
        await assertMutationAccess({ userId: actor.userId, customerId: captured.customerId, runtimeAccountId: runtime.account.id, models: m, transaction });
        if (canonical(await runtime.broker.assert(runtime.account, runtime.brokerContext, { transaction })) !== canonical(captured)) fail('scope_denied');
        // Metadata only; the scoped runtime and broker own credentials. A clinical
        // pause prevents sending, but does not prohibit this explicit receipt read.
        const connection = await m.GoogleConnection.findByPk(captured.googleConnectionId, {
          attributes: ['id', 'googleUserId', 'scopes'], raw: true, logging: false,
          ...(transaction ? { transaction, lock: transaction.LOCK.UPDATE } : {}) });
        if (!connection || connection.googleUserId !== captured.googleSubject
          || missingGoogleScopes(connection.scopes, [GOOGLE_DATA_MANAGER_SCOPE]).length) fail('scope_denied');
        gate(); return true;
      };
      const repository = createGoogleConversionSubmissionRepository({ models: m, assertContext: runtime.broker.assert,
        deliveryIdentity: { audience: configured.audience, keyId: configured.keyId }, activeSince: configured.activeSince, now: () => new Date(now()) });
      const record = async (reason, result, transaction) => {
        try {
          const date = new Date(now()), health = await events.health(date, { includeUnresolved: false, transaction });
          if (!Number.isSafeInteger(health.pending) || health.pending >= 10000 || !Number.isFinite(health.oldestAgeSeconds)
            || health.oldestAgeSeconds >= 3600) fail('audit_unavailable');
          await events.append(fromReceiptReview({ actor, captured, scopeKey, requestId, family, input, reason, result, now: date }), { transaction });
        } catch (error) { fail(error?.code === 'audit_event_conflict' ? 'google_receipt_request_conflict' : 'audit_unavailable'); }
      };
      await guard();
      // Durable intent precedes any journal read. Reusing a human request UUID
      // conflicts before a second broker request; the UI never retries silently.
      await m.sequelize.transaction(async transaction => { await guard(transaction); await record(family + '_requested', null, transaction); });
      const base = { requestId, customerId: captured.customerId, scopeKey };
      let result;
      if (family === 'list') {
        result = await m.sequelize.transaction(async transaction => {
          await guard(transaction);
          const page = await repository.listReview({ account: runtime.account, context: runtime.brokerContext, cursor: input.cursor }, { transaction });
          const value = { ...base, ...page };
          await record('list_prepared', value, transaction); await guard(transaction); return value;
        });
      } else {
        // Only the journal chooses the original attempt. The caller cannot supply
        // a provider request id, target, event, patient, or delivery payload.
        const hint = await m.GoogleConversionSubmission.findByPk(input.submissionId,
          { attributes: ['attempt_id', 'mapping_id'], raw: true, logging: false });
        if (!hint || String(hint.mapping_id) !== String(captured.id)) fail('google_receipt_not_found');
        const identity = { ...input, attemptId: hint.attempt_id, account: runtime.account, context: runtime.brokerContext };
        const stored = await m.sequelize.transaction(async transaction => {
          // Match automatic diagnostics: attempt -> submission -> scoped binding.
          // The read was admitted above; human authorization is rechecked before
          // leaving this transaction, and no provider call occurs inside it.
          const item = await repository.inspectReview(identity, { transaction });
          await guard(transaction); return item;
        });
        // No SQL lock/connection is held during the provider call.
        let remote = null;
        if (stored.canCheck) {
          try {
            remote = await runtime.broker.conversion(runtime.account, runtime.brokerContext, 'reconcile', input,
              { requestId, expectedActionId: stored.conversionActionId, beforeExecute: () => guard() });
          } catch (error) {
            // The transport intentionally projects only broker error codes. A
            // caller-side session revocation can therefore arrive sanitized.
            // Recheck human access to return its current 401/403, without retry.
            await guard(); throw error;
          }
        }
        result = await m.sequelize.transaction(async transaction => {
          await repository.inspectReview(identity, { transaction });
          await guard(transaction);
          if (remote) await repository.reconcile(identity, remote, { transaction });
          const item = await repository.inspectReview(identity, { transaction });
          // If a prepared submission advanced concurrently, a new explicit read
          // is needed; never mislabel it as not sent or query without admission.
          if (!remote && item.state !== stored.state) fail('conversion_submission_conflict');
          const mode = remote ? 'checked' : item.state === 'prepared' ? 'not_sent' : 'stored';
          const value = { ...base, item, mode };
          await record(remote ? 'receipt_checked' : mode === 'not_sent' ? 'receipt_not_dispatched' : 'receipt_already_terminal', value, transaction);
          await guard(transaction); return value;
        });
      }
      await guard(); return result;
    } catch (error) { fail(safe(error)); }
  } };
}
module.exports = { createGoogleConversionReceiptReview, safe, status, reviewEnabled };
