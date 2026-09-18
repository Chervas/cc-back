'use strict';
const C = require('../../services/integrations-broker/src/google-data-manager-contract');
const { canonical } = require('../../services/integrations-broker/src/canonical');
const fail = code => { throw Object.assign(Error(code), { code }); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const ref = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
const SAFE = new Set(['broker_binding_invalid', 'broker_cohort_disabled', 'broker_configuration_invalid', 'broker_response_invalid',
  'broker_timeout', 'broker_unavailable', 'invalid_request', 'operation_denied', 'scope_denied', 'asset_revoked', 'connection_blocked',
  'credential_revoked', 'secret_unavailable', 'provider_failed', 'provider_timeout', 'provider_unauthorized', 'rate_limited',
  'audit_unavailable', 'idempotency_conflict', 'outcome_unknown', 'request_in_progress', 'conversion_paused', 'consent_not_granted']);
const safe = error => SAFE.has(error?.code) ? error.code : 'google_data_manager_broker_failed';
function project(family, data, requestId, captured, expectedActionId, expectedSubmissionId) {
  if (!plain(data) || Buffer.byteLength(JSON.stringify(data)) > 32768) fail('broker_response_invalid');
  if (family === 'status') {
    if (!exact(data, 'submissionId,requestId,requestStatusPerDestination') || data.submissionId !== expectedSubmissionId
      || !C.providerId(data.requestId)) fail('broker_response_invalid');
    let projected;
    try { projected = C.statusResult(data, { customerId: captured.customerId, loginCustomerId: captured.loginCustomerId,
      destination: { conversionActionId: expectedActionId } }); } catch { fail('broker_response_invalid'); }
    // The remote projection has a fixed DTO; reject extra/changed fields rather than
    // returning raw provider content or silently accepting a different contract.
    if (canonical(projected.requestStatusPerDestination) !== canonical(data.requestStatusPerDestination)) fail('broker_response_invalid');
    return { submissionId: data.submissionId, requestId: data.requestId, ...projected };
  }
  if (!Number.isInteger(data.warningCount) || data.warningCount < 0 || data.warningCount > 100) fail('broker_response_invalid');
  if (family === 'validate') {
    if (!exact(data, 'validated,warningCount') || data.validated !== (data.warningCount === 0)) fail('broker_response_invalid');
    return { validated: data.validated, warningCount: data.warningCount };
  }
  if (!exact(data, 'accepted,submissionId,requestId,warningCount') || data.accepted !== true
    || data.submissionId !== requestId || !C.providerId(data.requestId)) fail('broker_response_invalid');
  return { accepted: true, submissionId: data.submissionId, requestId: data.requestId, warningCount: data.warningCount };
}

// No UUID generation and no retry here. Ingest callers must durably reserve the
// command identity/body digest before invoking this boundary. beforeExecute must
// re-read the caller's consent, clinical pause and workspace policy and return true.
function createGoogleDataManagerBrokerClient({ client, assertContext, now = Date.now,
  enabled = () => process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED === 'true' }) {
  if (typeof client?.execute !== 'function' || typeof assertContext !== 'function'
    || typeof enabled !== 'function' || typeof now !== 'function') fail('broker_configuration_invalid');
  return { async execute(context, family, input, options = {}) {
    try {
      if (!Object.hasOwn(C.OPERATIONS, family) || !plain(options)
        || Object.keys(options).some(key => !['requestId', 'beforeExecute', 'timeoutMs', 'expectedActionId'].includes(key))) fail('invalid_request');
      const { requestId, beforeExecute, timeoutMs = 30000, expectedActionId } = options;
      if (!uuid(requestId) || typeof beforeExecute !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000
        || (family === 'status' ? typeof expectedActionId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(expectedActionId)
          : expectedActionId !== undefined)) fail('invalid_request');
      const payload = structuredClone(input), operation = C.OPERATIONS[family];
      C.validate(operation, payload);
      const deadline = now() + timeoutMs;
      const checkGate = () => { if (enabled() !== true) fail('broker_cohort_disabled'); if (now() >= deadline) fail('broker_timeout'); };
      checkGate();
      const captured = await assertContext(context);
      if (!plain(captured) || captured.discoveryOnly !== false || !ref(captured.connectionRef)
        || !/^clinic:[1-9]\d{0,9}$/.test(captured.tenantRef || '') || !/^[0-9]{10}$/.test(captured.customerId || '')
        || captured.assetRef !== 'ads:' + captured.customerId
        || captured.loginCustomerId !== null && !/^[0-9]{10}$/.test(captured.loginCustomerId || '')) fail('broker_binding_invalid');
      const identity = canonical(captured);
      const verify = async () => {
        checkGate();
        if (await beforeExecute() !== true) fail('conversion_paused');
        if (canonical(await assertContext(context)) !== identity) fail('broker_binding_invalid');
        checkGate();
      };
      await verify();
      const response = await client.execute({ requestId, operation, connectionRef: captured.connectionRef,
        tenantRef: captured.tenantRef, assetRef: captured.assetRef, payload }, { timeoutMs: Math.min(30000, deadline - now()) });
      await verify();
      if (response?.requestId !== requestId) fail('broker_response_invalid');
      return project(family, response.data, requestId, captured, expectedActionId, payload.submissionId);
    } catch (error) { fail(safe(error)); }
  } };
}
module.exports = { createGoogleDataManagerBrokerClient, safe };
