'use strict';
const { assertGoogleAdsGrantTransport } = require('./googleAdsGrantTransport.service');
const fail = code => { throw Object.assign(Error(code), { code }); };

// The grant is opaque; the caller still rechecks its mandate/selection and time budget on every page.
function createOptimizationBrokerRead({ brokerGrant, reference, clinicId, revalidate, clock = Date.now }) {
  if (!brokerGrant || reference?.provider !== 'google_ads' || typeof revalidate !== 'function') fail('workspace_optimization_permissions_required');
  return async (family, section, window, timeoutMs) => {
    if (!['optimization', 'optimization_targets', 'optimization_performance', 'optimization_budget'].includes(family)
      || !Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60000) fail('workspace_optimization_evidence_invalid');
    const fields = ['optimization', 'optimization_targets'].includes(family) ? '' : 'endDate,startDate';
    if (!window || typeof window !== 'object' || Array.isArray(window) || Object.keys(window).sort().join(',') !== fields) fail('workspace_optimization_evidence_invalid');
    const started = clock(); const deadline = started + timeoutMs; let guardError;
    const current = async () => {
      try {
        await revalidate();
        const runtime = await assertGoogleAdsGrantTransport(brokerGrant, { clinicId });
        if (runtime.customerId !== reference.account_id) fail('workspace_optimization_connection_changed');
        if (!Number.isFinite(clock()) || clock() < started || clock() >= deadline) fail('workspace_optimization_evidence_timeout');
        return runtime;
      } catch (error) { guardError = error; throw error; }
    };
    const runtime = await current();
    try {
      const rows = await runtime.broker.read(runtime.account, runtime.brokerContext, family,
        { campaignId: reference.campaign_id, section, ...window }, { timeoutMs: deadline - clock(), beforeExecute: () => current() });
      await current(); return rows;
    } catch (error) { throw guardError || error; }
  };
}
module.exports = { createOptimizationBrokerRead };
