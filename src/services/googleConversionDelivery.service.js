'use strict';
const { randomUUID } = require('node:crypto');
const C = require('../../services/integrations-broker/src/google-data-manager-contract');
const { safe: brokerSafe } = require('./googleDataManagerBrokerClient.service');
const LOCAL = new Set(['conversion_submission_conflict', 'conversion_history_not_eligible', 'conversion_receipt_persistence_failed']);
const fail = code => { throw Object.assign(Error(code), { code }); };
const safe = error => LOCAL.has(error?.code) ? error.code : brokerSafe(error);
function createGoogleConversionDelivery({ repository, broker,
  enabled = () => process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED === 'true' }) {
  if (!repository || typeof broker?.conversion !== 'function' || typeof enabled !== 'function') fail('broker_configuration_invalid');
  const guard = async beforeExecute => {
    if (typeof beforeExecute !== 'function') fail('invalid_request');
    if (enabled() !== true) fail('broker_cohort_disabled');
    if (await beforeExecute() !== true) fail('conversion_paused');
    if (enabled() !== true) fail('broker_cohort_disabled'); return true;
  };
  return {
    async submit({ account, context, attemptId, dedupeKey, payload, beforeExecute }) {
      try {
        C.validate(C.OPERATIONS.ingest, payload); const input = structuredClone(payload);
        await guard(beforeExecute);
        const reserved = await repository.reserve({ account, context, attemptId, dedupeKey, payload: input });
        await guard(beforeExecute);
        const identity = { account, context, attemptId, submissionId: reserved.submissionId };
        const started = await repository.begin({ ...identity, payload: input });
        if (!started.dispatch) return { ...started, dispatch: false };
        try {
          const result = await broker.conversion(account, context, 'ingest', input, {
            requestId: reserved.submissionId, beforeExecute: () => guard(beforeExecute) });
          await guard(beforeExecute);
          return { ...await repository.acknowledge(identity, result), dispatch: true };
        } catch (error) {
          // Failure to record an ACK cannot turn this into a fresh attempt. Even
          // if this update fails, the earlier 'attempted' marker is durable.
          try { await repository.unknown(identity, error); }
          catch { fail('conversion_receipt_persistence_failed'); }
          throw error;
        }
      } catch (error) { fail(safe(error)); }
    },
    async reconcile({ account, context, attemptId, submissionId, beforeExecute }) {
      try {
        await guard(beforeExecute);
        const identity = { account, context, attemptId, submissionId };
        const current = await repository.inspect(identity);
        if (['prepared', 'succeeded', 'partial_success', 'failed'].includes(current.state)) return current;
        const result = await broker.conversion(account, context, 'status', { submissionId }, {
          requestId: randomUUID(), expectedActionId: current.conversionActionId, beforeExecute: () => guard(beforeExecute) });
        await guard(beforeExecute);
        return repository.reconcile(identity, result);
      } catch (error) { fail(safe(error)); }
    },
  };
}
module.exports = { createGoogleConversionDelivery };
