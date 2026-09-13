'use strict';
const { createHash } = require('node:crypto');
const C = require('../../services/integrations-broker/src/whatsapp-contract');
function fail(code, unknown = false) { throw Object.assign(Error(code), { code, retryable: false, ...(unknown ? { delivery_unknown: true } : {}) }); }
const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === keys.split(',').sort().join(',');
const clinicId = value => Number.isInteger(value) && value > 0 && value <= 2147483647;
function assertStaging(env) {
  if (env.RUNTIME_ROLE !== 'api' || env.JOB_RUNTIME_NAMESPACE !== 'staging' || env.QUEUE_PREFIX !== 'staging'
    || env.JOBS_WORKER_ENABLED !== 'true') fail('whatsapp_broker_runtime_denied');
}
function requestIdFor(messageId) {
  if (typeof messageId !== 'string' || !(/^[1-9][0-9]{0,18}$/.test(messageId)
    || /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(messageId))) fail('whatsapp_broker_request_invalid');
  // Same Message identity -> same broker intent across retries, bindings and
  // restarts. A changed payload then conflicts, instead of creating a new send.
  const bytes = createHash('sha256').update('clinicaclick-whatsapp-intent-v1\0' + messageId).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex'); return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function checkedBinding(row, intent) {
  if (!exact(row, 'connectionRef,phoneId,clinicId,assetId,revision,active') || row.active !== true
    || row.clinicId !== intent.clinicId || row.assetId !== intent.assetId || !clinicId(row.revision)
    || typeof row.connectionRef !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(row.connectionRef)
    || typeof row.phoneId !== 'string' || !/^[1-9][0-9]{0,29}$/.test(row.phoneId)) fail('whatsapp_broker_binding_invalid');
  return Object.freeze({ ...row });
}
function createWhatsappBrokerClient({ client, loadBinding, environment = () => process.env }) {
  if (!client?.execute || typeof loadBinding !== 'function') fail('whatsapp_broker_configuration_invalid');
  return Object.freeze({
    async send(input) {
      assertStaging(environment());
      if (!exact(input, 'messageId,clinicId,assetId,operation,payload') || !clinicId(input.clinicId) || !clinicId(input.assetId)
        || !C.OPERATIONS.includes(input.operation)) fail('whatsapp_broker_request_invalid');
      const intent = structuredClone(input); const requestId = requestIdFor(intent.messageId); C.validate(intent.operation, intent.payload);
      let captured;
      try { captured = checkedBinding(await loadBinding(intent.clinicId, intent.assetId), intent); }
      catch { fail('whatsapp_broker_binding_invalid'); }
      assertStaging(environment());
      let result;
      try {
        result = await client.execute({ requestId, tenantRef: 'clinic:' + intent.clinicId, connectionRef: captured.connectionRef,
          assetRef: 'wa-phone:' + captured.phoneId, operation: intent.operation, payload: intent.payload });
        assertStaging(environment());
        const latest = checkedBinding(await loadBinding(intent.clinicId, intent.assetId), intent);
        if (Object.keys(captured).some(key => latest[key] !== captured[key]) || result.requestId !== requestId
          || typeof result.replayed !== 'boolean' || !exact(result.data, 'messageId') || typeof result.data.messageId !== 'string'
          || !/^wamid\.[A-Za-z0-9+/=_-]{2,512}$/.test(result.data.messageId)) fail('whatsapp_delivery_unknown', true);
      } catch { fail('whatsapp_delivery_unknown', true); }
      return { requestId, providerMessageId: result.data.messageId, replayed: result.replayed };
    },
  });
}
module.exports = { createWhatsappBrokerClient, requestIdFor, assertStaging };
