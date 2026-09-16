'use strict';

const { assertStaging, requestIdFor } = require('./whatsappBrokerClient');
const ROOTS = Object.freeze({
  staging: '/etc/clinicaclick-whatsapp-authorized/staging',
  dev: '/etc/clinicaclick-whatsapp-authorized/dev',
});
function namespace(env) {
  if (env.WHATSAPP_DEV_BROKER_ENABLED === 'true') {
    if (env.DEV_SECURITY_PROFILE !== 'isolated-security-v2' || env.RUNTIME_ROLE !== 'api'
      || env.DB_NAME !== 'clinicaclick_dev_isolated' || env.DB_USERNAME !== 'cc_dev_api' || env.DB_HOST !== '127.0.0.1'
      || !['RUNTIME_NAMESPACE', 'JOB_RUNTIME_NAMESPACE', 'QUEUE_PREFIX'].every(k => env[k] === 'dev')
      || !['JOBS_WORKER_ENABLED', 'JOBS_CRON_LEADER', 'JOBS_AUTO_START'].every(k => env[k] === 'false')) {
      throw Object.assign(Error('whatsapp_broker_runtime_denied'), { code: 'whatsapp_broker_runtime_denied', retryable: false });
    }
    return 'dev';
  }
  assertStaging(env);
  return 'staging';
}
function requestId(messageId, env) {
  const scope = namespace(env);
  // Preserve all public idempotency keys across deployments. DEV has its own
  // namespace, including when a real-data snapshot retains public Message IDs.
  const original = requestIdFor(messageId);
  if (scope === 'staging') return original;
  const bytes = require('node:crypto').createHash('sha256').update('clinicaclick-whatsapp-dev-v1\0' + original).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const h = bytes.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}
module.exports = { ROOTS, namespace, requestId };
