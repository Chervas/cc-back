'use strict';
const C = require('../../services/integrations-broker/src/google-destination-contract');
const { canonical } = require('../../services/integrations-broker/src/canonical');
const { EVENTS } = require('../../services/integrations-broker/src/google-action-management-contract');
const fail = code => { throw Object.assign(Error(code), { code }); };
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const ref = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value);
const plain = value => value && Object.getPrototypeOf(value) === Object.prototype;
const exact = (value, keys) => plain(value) && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
const known = require('./googleAdsActionManagementBrokerClient.service').safe;
const safe = error => { const code = known(error); return code === 'google_action_management_broker_failed' ? 'google_destinations_broker_failed' : code; };
function project(family, data, requestId, input) {
  if (!exact(data, 'authorizationId,planId,state,destinations') || Buffer.byteLength(JSON.stringify(data)) > 32768
    || data.authorizationId !== (family === 'authorize' ? requestId : input.authorizationId) || !uuid(data.planId)
    || !['active', 'revoked'].includes(data.state) || family === 'authorize' && (data.state !== 'active' || data.planId !== input.planId)
    || family === 'revoke' && data.state !== 'revoked' || !Array.isArray(data.destinations)
    || data.destinations.length < 1 || data.destinations.length > 5) fail('broker_response_invalid');
  const events = new Set(), ids = new Set();
  for (const row of data.destinations) {
    if (!exact(row, 'event,conversionActionId,sources') || !EVENTS.includes(row.event) || events.has(row.event)
      || typeof row.conversionActionId !== 'string' || !/^[1-9][0-9]{0,19}$/.test(row.conversionActionId) || ids.has(row.conversionActionId)
      || !Array.isArray(row.sources) || !row.sources.length || row.sources.length > 2
      || row.sources.some(source => !['WEB', 'OTHER'].includes(source)) || new Set(row.sources).size !== row.sources.length) fail('broker_response_invalid');
    events.add(row.event); ids.add(row.conversionActionId);
  }
  if (family === 'authorize' && canonical(data.destinations.map(({ event, sources }) => ({ event, sources }))) !== canonical(input.targets)) fail('broker_response_invalid');
  return structuredClone(data);
}

// This boundary never creates a command identity or enables delivery. Its caller
// must journal the explicit decision and recheck all current clinic permissions.
function createGoogleDataManagerDestinationsBrokerClient({ client, assertContext, now = Date.now,
  enabled = () => process.env.GOOGLE_ADS_CONVERSIONS_BROKER_ENABLED === 'true'
    && process.env.GOOGLE_ADS_ACTION_MANAGEMENT_BROKER_ENABLED === 'true'
    && process.env.GOOGLE_ADS_DESTINATIONS_BROKER_ENABLED === 'true' }) {
  if (typeof client?.execute !== 'function' || typeof assertContext !== 'function'
    || typeof now !== 'function' || typeof enabled !== 'function') fail('broker_configuration_invalid');
  return { async execute(context, family, input, options = {}) {
    try {
      if (!Object.hasOwn(C.OPERATIONS, family) || !plain(options)
        || Object.keys(options).some(key => !['requestId', 'beforeExecute', 'timeoutMs'].includes(key))) fail('invalid_request');
      const { requestId, beforeExecute, timeoutMs = 30000 } = options;
      if (!uuid(requestId) || typeof beforeExecute !== 'function' || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30000) fail('invalid_request');
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
module.exports = { createGoogleDataManagerDestinationsBrokerClient, project, safe };
