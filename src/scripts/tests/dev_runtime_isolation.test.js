'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { assertDevRuntimeIsolation } = require('../../lib/devRuntimeIsolation');
const identity = { uid: 900, username: 'clinicaclick-dev' };
function environment() {
  return { DEV_SECURITY_PROFILE: 'isolated-v1', DB_NAME: 'clinicaclick_dev_isolated', DB_USERNAME: 'cc_dev_api', DB_HOST: '127.0.0.1',
    DB_PASSWORD: '1'.repeat(64) + 'aA1!', JWT_SECRET: '2'.repeat(64), REDIS_URL: 'redis://:' + '3'.repeat(64) + '@127.0.0.1:6384/0', API_LISTEN_ADDRESS: '127.0.0.1',
    RUNTIME_NAMESPACE: 'dev', JOB_RUNTIME_NAMESPACE: 'dev', QUEUE_PREFIX: 'dev', JOBS_WORKER_ENABLED: 'false', JOBS_CRON_LEADER: 'false',
    JOBS_AUTO_START: 'false', SYSTEM_NOTIFICATIONS_CRON_LEADER: 'false', RESUME_AUTOMATIONS_FROM_SOCKET_BUS: 'false', AUTOMATIONS_V2_RESUME_FROM_SOCKET_BUS: 'false', BEDROCK_ENABLED: 'false', EMAIL_ENABLED: 'false' };
}
test('isolated DEV requires its actual OS identity, private database/Redis and paused workers', () => {
  assert.equal(assertDevRuntimeIsolation(environment(), identity).isolatedDev, true);
  const changes = [e => { e.DB_NAME = 'clinicaclick'; }, e => { e.DB_USERNAME = 'carlos'; }, e => { e.REDIS_URL = 'redis://127.0.0.1:6379'; },
    e => { e.JOBS_WORKER_ENABLED = 'true'; }, e => { delete e.SYSTEM_NOTIFICATIONS_CRON_LEADER; }, e => { e.API_LISTEN_ADDRESS = '0.0.0.0'; },
    e => { e.META_APP_SECRET = 'FICTITIOUS_FORBIDDEN'; }, e => { e.WHATSAPP_BROKER_URL = 'https://example.invalid'; },
    e => { e.JOB_RUNTIME_NAMESPACE = 'staging'; }, e => { delete e.DEV_SECURITY_PROFILE; }];
  for (const mutate of changes) { const env = environment(); mutate(env); assert.throws(() => assertDevRuntimeIsolation(env, identity), /DEV_RUNTIME_ISOLATION_REQUIRED/); }
  for (const who of [{ uid: 0, username: 'root' }, { uid: 1000, username: 'ubuntu' }, { uid: 901, username: 'other-service' }])
    assert.throws(() => assertDevRuntimeIsolation(environment(), who), /DEV_RUNTIME_ISOLATION_REQUIRED/);
});
test('public runtimes keep their existing authentication and job configuration', () => {
  for (const scope of ['staging', 'gateway']) assert.deepEqual(assertDevRuntimeIsolation({ RUNTIME_NAMESPACE: scope, JOB_RUNTIME_NAMESPACE: scope,
    QUEUE_PREFIX: scope, AUTH_SESSION_MODE: 'enforce', AUTH_EMAIL_MFA_MODE: 'enforce' }, { uid: 1000, username: 'ubuntu' }), { isolatedDev: false });
  assert.throws(() => assertDevRuntimeIsolation({ name: 'pm2-back-dev' }, identity), /DEV_RUNTIME_ISOLATION_REQUIRED/);
});

test('DEV MFA only enables enqueue and local audit relay, without provider keys or general workers', () => {
  const env = { ...environment(), DEV_SECURITY_PROFILE: 'isolated-security-v2', EMAIL_ENABLED: 'true', EMAIL_PROVIDER: 'ses',
    AUTH_EMAIL_MFA_MODE: 'enforce', AUTH_SESSION_MODE: 'enforce', PLATFORM_AUDIT_DELIVERY_ENABLED: 'false',
    PLATFORM_AUDIT_READER_TRANSPORT: 'unix-dev', PLATFORM_AUDIT_READER_SOCKET: '/var/lib/clinicaclick-dev-security/audit.sock' };
  assert.equal(assertDevRuntimeIsolation(env, identity).isolatedDev, true);
  for (const change of [{ EMAIL_AWS_ACCESS_KEY_ID: 'forbidden' }, { PLATFORM_AUDIT_WRITER_KEY_FILE: '/any' },
    { JOBS_WORKER_ENABLED: 'true' }, { DEV_SECURITY_WORKER: 'true' }, { PLATFORM_AUDIT_READER_SOCKET: '/wrong' },
    { AUTH_EMAIL_MFA_MODE: 'off' }, { EMAIL_ENABLED: 'false' }]) {
    assert.throws(() => assertDevRuntimeIsolation({ ...env, ...change }, identity), /DEV_RUNTIME_ISOLATION_REQUIRED/);
  }
});
