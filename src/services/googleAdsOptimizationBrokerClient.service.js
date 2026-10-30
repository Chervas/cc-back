'use strict';
const C = require('../../services/integrations-broker/src/google-optimization-write-contract');
const fail = code => { throw Object.assign(Error(code), { code }); };
const exact = (value, fields) => value && Object.getPrototypeOf(value) === Object.prototype
  && Object.keys(value).sort().join(',') === fields.split(',').sort().join(',');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const SAFE = new Set(['broker_binding_invalid', 'broker_cohort_disabled', 'broker_configuration_invalid', 'broker_response_invalid',
  'broker_timeout', 'broker_unavailable', 'invalid_request', 'operation_denied', 'scope_denied', 'asset_revoked', 'connection_blocked',
  'credential_revoked', 'secret_unavailable', 'provider_failed', 'provider_timeout', 'provider_unauthorized', 'rate_limited',
  'audit_unavailable', 'idempotency_conflict', 'outcome_unknown', 'optimization_conflict', 'optimization_expired', 'optimization_busy', 'optimization_cooldown',
  'optimization_reviewed', 'optimization_review_pending']);
const safe = error => SAFE.has(error?.code) ? error.code : 'google_optimization_broker_failed';
function project(family, data, input, customerId) {
  const original = family === 'review' ? input.submission : input;
  if (!exact(data, 'executionId,state,result') || data.executionId !== original.executionId
    || !['applied', 'unknown', 'not_found', 'reviewed'].includes(data.state) || family === 'apply' && data.state !== 'applied'
    || family === 'review' && data.state !== 'reviewed') fail('broker_response_invalid');
  if (data.state === 'reviewed') {
    const r = data.result;
    if (!exact(r, 'reviewedAt,reviewedBy,observedAt,value,resourceName,previousState')
      || !Number.isSafeInteger(r.reviewedAt) || !Number.isSafeInteger(r.observedAt) || r.observedAt < 1 || r.reviewedAt < r.observedAt
      || !Number.isSafeInteger(r.reviewedBy) || r.reviewedBy < 1 || r.reviewedBy > 2147483647
      || !['unknown', 'not_found', 'applied'].includes(r.previousState) || typeof r.value !== 'string' || !r.value || r.value.length > 24
      || typeof r.resourceName !== 'string' || !new RegExp(`^customers/${customerId}/(?:campaigns|campaignBudgets|adGroups)/[1-9][0-9]{0,19}$|^customers/${customerId}/adGroupAds/[1-9][0-9]{0,19}~[1-9][0-9]{0,19}$`).test(r.resourceName)
      || family === 'review' && r.resourceName !== C.mutation(original, customerId).resourceName) fail('broker_response_invalid');
    if (r.resourceName.includes('/adGroupAds/')) { if (!['ENABLED', 'PAUSED', 'REMOVED'].includes(r.value)) fail('broker_response_invalid'); }
    else { try { C.scaled(r.value, r.resourceName.includes('/campaigns/')); } catch { fail('broker_response_invalid'); } }
    return structuredClone(data);
  }
  if (data.state !== 'applied') { if (data.result !== null) fail('broker_response_invalid'); }
  else {
    if (!exact(data.result, 'acknowledged,resourceName') || data.result.acknowledged !== true || typeof data.result.resourceName !== 'string'
      || !new RegExp(`^customers/${customerId}/(?:campaigns|campaignBudgets|adGroups)/[1-9][0-9]{0,19}$|^customers/${customerId}/adGroupAds/[1-9][0-9]{0,19}~[1-9][0-9]{0,19}$`).test(data.result.resourceName)
      || family === 'apply' && data.result.resourceName !== C.mutation(input, customerId).resourceName) fail('broker_response_invalid');
  }
  return structuredClone(data);
}
function createGoogleAdsOptimizationBrokerClient({ client, assertContext, now = Date.now,
  enabled = () => process.env.GOOGLE_ADS_OPTIMIZATION_BROKER_ENABLED === 'true' }) {
  if (typeof client?.execute !== 'function' || typeof client.identity !== 'function' || typeof assertContext !== 'function'
    || typeof now !== 'function' || typeof enabled !== 'function') fail('broker_configuration_invalid');
  const gate = () => { if (enabled() !== true) fail('broker_cohort_disabled'); };
  const capture = async (context, options) => {
    gate(); const scope = await assertContext(context, options); const writer = client.identity(); gate();
    if (!scope || scope.discoveryOnly !== false || !/^clinic:[1-9]\d{0,9}$/.test(scope.tenantRef || '')
      || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(scope.connectionRef || '')
      || !/^[0-9]{10}$/.test(scope.customerId || '') || scope.assetRef !== 'ads:' + scope.customerId || !hash(writer)
      || scope.loginCustomerId !== null && !/^[0-9]{10}$/.test(scope.loginCustomerId || '')) fail('broker_binding_invalid');
    return { scope, authority: C.hash({ scope, writer }) };
  };
  return {
    async authority(context, options) { try { return (await capture(context, options)).authority; } catch (error) { fail(safe(error)); } },
    async execute(context, family, input, options = {}) {
      try {
        if (!Object.hasOwn(C.OPERATIONS, family) || !options || Object.getPrototypeOf(options) !== Object.prototype
          || Object.keys(options).some(key => !['requestId', 'authority', 'beforeExecute', 'timeoutMs'].includes(key))) fail('invalid_request');
        const { requestId, authority, beforeExecute, timeoutMs = 30000 } = options;
        if (!uuid(requestId) || !hash(authority) || typeof beforeExecute !== 'function'
          || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) fail('invalid_request');
        const payload = structuredClone(input); C.validate(family, payload); const started = now(), deadline = started + timeoutMs;
        if (!Number.isFinite(started) || !Number.isFinite(deadline)) fail('broker_timeout');
        const verify = async () => {
          gate(); if (await beforeExecute() !== true) fail('scope_denied');
          const current = await capture(context);
          if (current.authority !== authority) fail('broker_binding_invalid');
          const instant = now(); if (!Number.isFinite(instant) || instant < started || instant >= deadline) fail('broker_timeout');
          if (family === 'apply' && (payload.expiresAt <= instant || payload.expiresAt > instant + C.TTL_MS)) fail('optimization_expired');
          return current.scope;
        };
        const scope = await verify();
        const result = await client.execute({ requestId, operation: C.OPERATIONS[family], connectionRef: scope.connectionRef,
          tenantRef: scope.tenantRef, assetRef: scope.assetRef, payload }, { timeoutMs: deadline - now() });
        // An acknowledgement is historical evidence, not a second opportunity to send.
        gate(); if (await beforeExecute() !== true) fail('scope_denied');
        if ((await capture(context)).authority !== authority) fail('broker_binding_invalid');
        const finished = now(); if (!Number.isFinite(finished) || finished < started || finished >= deadline) fail('broker_timeout');
        if (result?.requestId !== requestId) fail('broker_response_invalid');
        return project(family, result.data, payload, scope.customerId);
      } catch (error) { fail(safe(error)); }
    },
  };
}
module.exports = { createGoogleAdsOptimizationBrokerClient, project, safe };
