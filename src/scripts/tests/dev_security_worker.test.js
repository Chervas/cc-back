'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto');
const { assertRuntime, allowedEmail, createAuditPoller } = require('../dev-security-worker');
const { authorize } = require('../../lib/devAuditRelay');
const { pack, keyFor } = require('../../../services/platform-audit/src/event');
const { fixture } = require('../../../services/platform-audit/test/fixture.cjs');
test('idle polling bounds audit writes without slowing the one-second consumer loop', async () => {
  let at = 0; let delivery = 0; let reconciliation = 0; let emailTicks = 0;
  const poll = createAuditPoller({ now: () => at,
    audit: async () => { delivery++; return {}; }, reconcile: async () => { reconciliation++; } });
  for (; at < 120000; at += 1000) { await poll(); emailTicks++; }
  assert.equal(delivery, 12); assert.equal(reconciliation, 4); assert.equal(emailTicks, 120);
});
test('audit failures remain paced and do not prevent the email consumer or reconciliation', async () => {
  let at = 0; let errors = 0; let deliveries = 0; let reconciliations = 0;
  const poll = createAuditPoller({ now: () => at, onError: () => { errors++; },
    audit: async () => { deliveries++; throw Error('unavailable'); },
    reconcile: async () => { reconciliations++; throw Error('unavailable'); } });
  await poll(); assert.equal(errors, 2);
  for (at = 1000; at < 10000; at += 1000) await poll();
  assert.equal(deliveries, 1); assert.equal(reconciliations, 1);
  at = 10000; await poll(); assert.equal(deliveries, 2); assert.equal(reconciliations, 1);
});
test('slow delivery does not cause a burst of catch-up executions', async () => {
  let at = 0; let calls = 0;
  const poll = createAuditPoller({ now: () => at, audit: async () => { calls++; at += 75000; return {}; }, reconcile: async () => {} });
  await poll(); await poll(); assert.equal(calls, 1);
  at += 9999; await poll(); assert.equal(calls, 1);
  at++; await poll(); assert.equal(calls, 2);
});
test('security consumer requires DEV database, own identity and all business workers off', () => {
  const env = { DEV_SECURITY_WORKER: 'true', DB_NAME: 'clinicaclick_dev_isolated', DB_USERNAME: 'cc_dev_api', DB_HOST: '127.0.0.1',
    RUNTIME_NAMESPACE: 'dev', JOB_RUNTIME_NAMESPACE: 'dev', QUEUE_PREFIX: 'dev', JOBS_WORKER_ENABLED: 'false',
    JOBS_CRON_LEADER: 'false', JOBS_AUTO_START: 'false', SYSTEM_NOTIFICATIONS_CRON_LEADER: 'false',
    AUTH_SESSION_MODE: 'enforce', AUTH_EMAIL_MFA_MODE: 'enforce', PLATFORM_AUDIT_READER_TRANSPORT: 'https' };
  assertRuntime(env, 'clinicaclick-dev-security');
  for (const change of [{ DB_NAME: 'public' }, { JOBS_CRON_LEADER: 'true' }, { JOB_RUNTIME_NAMESPACE: 'staging' }])
    assert.throws(() => assertRuntime({ ...env, ...change }, 'clinicaclick-dev-security'));
  assert.throws(() => assertRuntime(env, 'clinicaclick-dev'));
  const row = { template_key: 'auth.email_verification', stream: 'transactional', recipient_kind: 'user' };
  assert.equal(allowedEmail(row), true);
  for (const change of [{ template_key: 'marketing' }, { stream: 'automation' }, { clinica_id: 19 }, { paciente_id: 1 }])
    assert.equal(!!allowedEmail({ ...row, ...change }), false);
});
test('DEV relay requires live DEV session and exact locally confirmed receipt', async () => {
  const row = { ...pack(fixture()), state: 'delivered' };
  row.receipt = { key: keyFor(row), digest: row.digest, versionId: 'test-version' };
  const command = { mode: 'confirmed', requestId: randomUUID(), actorId: '1', sessionRef: randomUUID(), refs: [row.receipt] };
  let sessions = 0;
  const deps = { verifySession: async () => { sessions++; }, findEvent: async () => row };
  assert.equal(await authorize(command, deps), true); assert.equal(sessions, 1);
  await assert.rejects(authorize(command, { ...deps, findEvent: async () => null }));
  await assert.rejects(authorize(command, { ...deps, verifySession: async () => { throw Error('revoked'); } }));
  await assert.rejects(authorize({ ...command, refs: [{ ...row.receipt, versionId: 'other' }] }, deps));
  await assert.rejects(authorize({ ...command, mode: 'reconcile' }, deps));
  await assert.rejects(authorize({ ...command, actorId: '2' }, deps));
  row.state = 'pending'; await assert.rejects(authorize(command, deps));
});
