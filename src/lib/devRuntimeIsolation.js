'use strict';
const os = require('node:os');
function isDevRuntime(env = process.env) {
  return env.name === 'pm2-back-dev' || ['RUNTIME_NAMESPACE', 'JOB_RUNTIME_NAMESPACE', 'QUEUE_PREFIX']
    .some(key => String(env[key] || '').trim().toLowerCase() === 'dev');
}
function assertDevRuntimeIsolation(env = process.env, identity = { uid: process.getuid(), username: os.userInfo().username }) {
  if (!isDevRuntime(env)) return { isolatedDev: false };
  const deny = () => { throw Error('DEV_RUNTIME_ISOLATION_REQUIRED'); };
  // Configuration checks prevent accidentally restarting the former PM2 setup.
  // OS ownership, SQL grants and firewall rules remain the actual boundaries.
  if (identity.uid === 0 || identity.uid === 1000 || identity.username !== 'clinicaclick-dev'
    || env.DEV_SECURITY_PROFILE !== 'isolated-v1' || env.DB_NAME !== 'clinicaclick_dev_isolated'
    || env.DB_USERNAME !== 'cc_dev_api' || env.DB_HOST !== '127.0.0.1'
    || !/^[a-f0-9]{64}aA1!$/.test(env.DB_PASSWORD || '') || !/^[a-f0-9]{64}$/.test(env.JWT_SECRET || '')
    || env.API_LISTEN_ADDRESS !== '127.0.0.1'
    || !/^redis:\/\/:[a-f0-9]{64}@127\.0\.0\.1:6384\/0$/.test(env.REDIS_URL || '')) deny();
  for (const key of ['RUNTIME_NAMESPACE', 'JOB_RUNTIME_NAMESPACE', 'QUEUE_PREFIX']) if (env[key] !== 'dev') deny();
  for (const key of ['JOBS_WORKER_ENABLED', 'JOBS_CRON_LEADER', 'JOBS_AUTO_START', 'SYSTEM_NOTIFICATIONS_CRON_LEADER',
    'RESUME_AUTOMATIONS_FROM_SOCKET_BUS', 'AUTOMATIONS_V2_RESUME_FROM_SOCKET_BUS', 'BEDROCK_ENABLED', 'EMAIL_ENABLED']) if (env[key] !== 'false') deny();
  for (const [key, value] of Object.entries(env)) {
    if (!value) continue;
    if (/^(META|FACEBOOK|GOOGLE|GROQ|BEDROCK|EMAIL_AWS|AWS).*(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY_ID)$/.test(key)
      || /^(WHATSAPP|GOOGLE|INTEGRATIONS)_BROKER_/.test(key) || /^PLATFORM_AUDIT_WRITER_/.test(key)) deny();
  }
  return { isolatedDev: true };
}
module.exports = { isDevRuntime, assertDevRuntimeIsolation };
