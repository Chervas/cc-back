'use strict';
const C = require('../../services/integrations-broker/src/google-action-management-contract');
const { canonical } = require('../../services/integrations-broker/src/canonical');
const fail = code => { throw Object.assign(Error(code), { code }); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const ref = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
const SAFE = new Set(['broker_binding_invalid', 'broker_cohort_disabled', 'broker_configuration_invalid', 'broker_response_invalid',
  'broker_timeout', 'broker_unavailable', 'invalid_request', 'operation_denied', 'scope_denied', 'asset_revoked', 'connection_blocked',
  'credential_revoked', 'secret_unavailable', 'provider_failed', 'provider_timeout', 'provider_unauthorized', 'rate_limited',
  'audit_unavailable', 'idempotency_conflict', 'outcome_unknown', 'request_in_progress',
  'action_plan_conflict', 'action_plan_expired', 'action_plan_busy']);
const safe = error => SAFE.has(error?.code) ? error.code : 'google_action_management_broker_failed';
function project(family, data, requestId, input) {
  const prepare = family === 'prepare';
  const validating = family === 'validate' && data?.state === 'prepared';
  if (!exact(data, 'planId,state,expiresAt,changes' + (prepare ? '' : ',results') + (validating ? ',validated' : ''))
    || Buffer.byteLength(JSON.stringify(data)) > 32768
    || data.planId !== (prepare ? requestId : input.planId)
    || !['prepared', 'attempted', 'applied'].includes(data.state)
    || prepare && data.state !== 'prepared' || family === 'apply' && data.state !== 'applied'
    || family === 'validate' && data.state === 'attempted' || validating && data.validated !== true
    || !Number.isSafeInteger(data.expiresAt) || data.expiresAt < 1
    || !Array.isArray(data.changes) || !data.changes.length || data.changes.length > 5) fail('broker_response_invalid');
  const events = new Set(), ids = new Set();
  for (const row of data.changes) {
    if (!exact(row, 'event,actionId,change') || !C.EVENTS.includes(row.event) || events.has(row.event)
      || !['create', 'normalize', 'unchanged'].includes(row.change)
      || (row.change === 'create' ? row.actionId !== null : !id(row.actionId) || ids.has(row.actionId))) fail('broker_response_invalid');
    events.add(row.event); if (row.actionId) ids.add(row.actionId);
  }
  if (new Set(data.changes.filter(row => row.change !== 'unchanged').map(row => row.change)).size > 1) fail('broker_response_invalid');
  if (prepare && (data.changes.length !== input.targets.length || data.changes.some((row, index) => {
    const target = input.targets[index];
    return row.event !== target.event || ![input.mode, 'unchanged'].includes(row.change)
      || target.actionId !== null && target.actionId !== row.actionId;
  }))) fail('broker_response_invalid');
  if (!prepare) {
    if (data.state !== 'applied') { if (data.results !== null) fail('broker_response_invalid'); }
    else {
      const changed = data.changes.filter(row => row.change !== 'unchanged');
      if (!Array.isArray(data.results) || data.results.length !== changed.length) fail('broker_response_invalid');
      const resolvedIds = new Set(data.changes.filter(row => row.change === 'unchanged').map(row => row.actionId));
      for (const [index, row] of data.results.entries()) {
        const expected = changed[index];
        if (!exact(row, 'event,actionId,change') || row.event !== expected.event || row.change !== expected.change
          || !id(row.actionId) || resolvedIds.has(row.actionId)
          || expected.actionId !== null && row.actionId !== expected.actionId) fail('broker_response_invalid');
        resolvedIds.add(row.actionId);
      }
    }
  }
  return structuredClone(data);
}

// No UUID generation, retries, automatic apply or local-token fallback. Callers
// must persist ownership of the plan and command before applying, and re-read
// current user mutation permissions for ALL mappings of the account in the guard.
function createGoogleAdsActionManagementBrokerClient({ client, assertContext, now = Date.now,
  enabled = () => process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED === 'true'
    && process.env.GOOGLE_ADS_ACTION_MANAGEMENT_BROKER_ENABLED === 'true' }) {
  if (typeof client?.execute !== 'function' || typeof assertContext !== 'function'
    || typeof now !== 'function' || typeof enabled !== 'function') fail('broker_configuration_invalid');
  return { async execute(context, family, input, options = {}) {
    try {
      if (!Object.hasOwn(C.OPERATIONS, family) || !plain(options)
        || Object.keys(options).some(key => !['requestId', 'beforeExecute', 'timeoutMs'].includes(key))) fail('invalid_request');
      const { requestId, beforeExecute, timeoutMs = 30000 } = options;
      if (!uuid(requestId) || typeof beforeExecute !== 'function' || !Number.isInteger(timeoutMs)
        || timeoutMs < 1 || timeoutMs > 30000) fail('invalid_request');
      const payload = structuredClone(input), operation = C.OPERATIONS[family]; C.validate(operation, payload);
      const deadline = now() + timeoutMs;
      const gate = () => { if (enabled() !== true) fail('broker_cohort_disabled'); if (now() >= deadline) fail('broker_timeout'); };
      gate();
      const captured = await assertContext(context);
      if (!plain(captured) || captured.discoveryOnly !== false || !ref(captured.connectionRef)
        || !/^clinic:[1-9]\d{0,9}$/.test(captured.tenantRef || '') || !/^[0-9]{10}$/.test(captured.customerId || '')
        || captured.assetRef !== 'ads:' + captured.customerId
        || captured.loginCustomerId !== null && !/^[0-9]{10}$/.test(captured.loginCustomerId || '')) fail('broker_binding_invalid');
      const identity = canonical(captured);
      const verify = async () => {
        gate(); if (await beforeExecute() !== true) fail('scope_denied');
        if (canonical(await assertContext(context)) !== identity) fail('broker_binding_invalid'); gate();
      };
      await verify();
      const response = await client.execute({ requestId, operation, connectionRef: captured.connectionRef,
        tenantRef: captured.tenantRef, assetRef: captured.assetRef, payload }, { timeoutMs: deadline - now() });
      await verify();
      if (response?.requestId !== requestId) fail('broker_response_invalid');
      return project(family, response.data, requestId, payload);
    } catch (error) { fail(safe(error)); }
  } };
}
module.exports = { createGoogleAdsActionManagementBrokerClient, safe };
