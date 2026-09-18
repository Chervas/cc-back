'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createEmailAdmission } = require('../../lib/emailAdmission');
const { createEmailBroker } = require('../../services/emailBroker.service');
const { classifyProviderError } = require('../../services/emailProvider.service');
const { payload, accepted } = require('../../../services/integrations-broker/test/email-fixture.cjs');
const env = () => ({ EMAIL_BROKER_ENABLED: 'true', EMAIL_BROKER_ENVIRONMENT: 'staging', EMAIL_BROKER_CONNECTION_REF: 'email:staging',
  EMAIL_BROKER_AUDIENCE: 'clinicaclick:email:staging:v1', EMAIL_BROKER_ORIGIN: 'https://broker.example.test',
  EMAIL_BROKER_KEY_ID: 'qa-key', EMAIL_BROKER_KEY_FILE: '/fictitious/key', EMAIL_BROKER_CA_FILE: '/fictitious/ca' });
const tick = () => new Promise(resolve => setImmediate(resolve));

test('one active email, FIFO order and start spacing keep a burst below the configured provider budget', async () => {
  const admission = createEmailAdmission(), times = [], order = [];
  let active = 0, peak = 0;
  await Promise.all([0, 1, 2, 3].map(i => admission.run(async () => {
    active++; peak = Math.max(active, peak); times.push(performance.now()); order.push(i);
    await new Promise(resolve => setTimeout(resolve, 5)); active--;
  }, 4096)));
  assert.equal(peak, 1); assert.deepEqual(order, [0, 1, 2, 3]);
  for (let i = 1; i < times.length; i++) assert(times[i] - times[i - 1] >= 295);
});

test('waiting count, bytes and expiration are bounded and expired work never dispatches later', async () => {
  const admission = createEmailAdmission({ maxWaiting: 2, maxWaitingBytes: 20, waitMs: 35, spacingMs: 0 });
  let release, sent = 0;
  const active = admission.run(() => new Promise(resolve => { release = resolve; }), 10); await tick();
  const waiting = admission.run(() => { sent++; }, 15);
  const expired = assert.rejects(waiting, { code: 'email_admission_expired', retryable: true });
  await assert.rejects(admission.run(() => assert.fail('byte overflow dispatched'), 10), { code: 'email_admission_full', retryable: true });
  await expired; release(); await active; await tick(); assert.equal(sent, 0);
  const count = createEmailAdmission({ maxWaiting: 1, waitMs: 1000, spacingMs: 0 });
  let done;
  const first = count.run(() => new Promise(resolve => { done = resolve; }), 1); await tick();
  const second = count.run(() => {}, 1);
  await assert.rejects(count.run(() => assert.fail('count overflow dispatched'), 1), { code: 'email_admission_full' });
  done(); await Promise.all([first, second]);
  for (const code of ['email_admission_full', 'email_admission_expired']) assert.equal(classifyProviderError({ code, retryable: true }).retryable, true);
});

test('slow asynchronous authorization cannot consume the gap between transport dispatches', async () => {
  const admission = createEmailAdmission({ spacingMs: 20 }), dispatches = [];
  await Promise.all([admission.run(async () => {
    await new Promise(resolve => setTimeout(resolve, 50));
    dispatches.push(performance.now());
  }, 1), admission.run(() => dispatches.push(performance.now()), 1)]);
  assert(dispatches[1] - dispatches[0] >= 18);
});

test('queued body is immutable, account guard runs again at dispatch, and a revoked challenge makes no broker request', async () => {
  const admission = createEmailAdmission({ spacingMs: 0 }), calls = [];
  let release;
  const busy = admission.run(() => new Promise(resolve => { release = resolve; }), 1); await tick();
  const client = createEmailBroker({ env: env(), admission, readFile: () => Buffer.from('fictitious'),
    clientFactory: () => ({ async execute(command) { calls.push(command); return { data: accepted() }; } }) });
  const p = payload(), original = p.text;
  const work = client.send(p); p.text = 'MUTATED'; release(); await busy; await work;
  assert.equal(calls[0].payload.text, original);
  const before = calls.length;
  await assert.rejects(client.send(payload(), { beforeDispatch: async () => {
    throw Object.assign(Error('email_verification_no_longer_valid'), { code: 'email_verification_no_longer_valid', retryable: false });
  } }), { code: 'email_verification_no_longer_valid' });
  assert.equal(calls.length, before);
});

test('expired work is rejected even when event loop congestion delays its deadline timer', async () => {
  const admission = createEmailAdmission({ waitMs: 20, spacingMs: 0 });
  let release;
  const active = admission.run(() => new Promise(resolve => { release = resolve; }), 1); await tick();
  const queued = admission.run(() => assert.fail('expired work dispatched before its timer ran'), 1);
  const rejected = assert.rejects(queued, { code: 'email_admission_expired', retryable: true });
  // Resolve the active promise before timers get an event-loop turn.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
  release(); await active; await rejected;
  await admission.run(() => {}, 1); // The rejected item releases its slot.
});

test('configuration is checked after waiting and after asynchronous delivery validation', async () => {
  for (const timing of ['waiting', 'guard']) {
    const settings = env(), admission = createEmailAdmission({ spacingMs: 0 }); let release;
    const busy = admission.run(() => new Promise(resolve => { release = resolve; }), 1); await tick();
    const client = createEmailBroker({ env: settings, admission, readFile: () => assert.fail('disabled send read signing identity') });
    const work = client.send(payload(), { beforeDispatch: async () => { if (timing === 'guard') settings.EMAIL_BROKER_ENABLED = 'false'; } });
    const rejected = assert.rejects(work, { code: 'email_broker_disabled', retryable: false });
    if (timing === 'waiting') settings.EMAIL_BROKER_ENABLED = 'false';
    release(); await busy; await rejected;
  }
});
