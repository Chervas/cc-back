'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync } = require('node:crypto');
const { BrokerStore } = require('../src/store');
const { Broker } = require('../src/broker');
const { signRequest } = require('../src/auth');
const { publicError } = require('../src/errors');
const { eventFor } = require('../src/audit');
const { createFictitiousSecretStore } = require('../src/secrets');
const { OPERATIONS } = require('../src/operations');
const { fixture } = require('./helpers');

test('signed allowed operation is projected and audited without credential material', async t => {
  const f = fixture(t);
  const response = await f.execute(f.command());
  assert.deepEqual(response.data, { fixture: true, status: 'available' });
  assert.equal(f.store.backlog().pending, 2);
  const rows = f.store.db.prepare('SELECT event FROM audit_outbox').all();
  assert.equal(JSON.stringify({ response, rows }).includes('FICTITIOUS_SENTINEL'), false);
});
test('foreign tenant/asset/connection and caller-supplied URLs/GAQL fail closed', async t => {
  let reads = 0;
  const f = fixture(t, { secrets: { withSecret() { reads++; throw Error('should not read'); } } });
  for (const patch of [{ tenantRef: 'clinic:999' }, { assetRef: 'asset:999' }, { connectionRef: 'other' },
    { operation: 'proxy' }, { payload: { url: 'https://169.254.169.254', token: 'SENTINEL' } }, { payload: { query: 'SELECT *' } }]) {
    await assert.rejects(f.execute(f.command(patch)), error => ['scope_denied', 'invalid_request'].includes(error.code));
  }
  assert.equal(reads, 0);
});
test('untrusted reference strings never enter denial audit records', async t => {
  const f = fixture(t); const sentinel = 'FAKE_PROVIDER_SECRET';
  await assert.rejects(f.execute(f.command({ assetRef: sentinel })), { code: 'scope_denied' });
  assert.equal(JSON.stringify(f.store.db.prepare('SELECT event FROM audit_outbox').all()).includes(sentinel), false);
});
test('wrong signature, tampering, audience, expiry and duplicate nonce are denied', async t => {
  const f = fixture(t); const command = f.command();
  const signed = f.signed(command);
  const tampered = Buffer.from(signed.raw.toString().replace('clinic:123', 'clinic:999'));
  await assert.rejects(f.broker.execute(tampered, signed.headers), { code: 'invalid_signature' });
  for (const extra of [{ audience: 'different' }, { now: Date.now() - 120000 }, { privateKey: generateKeyPairSync('ed25519').privateKey }]) {
    const invalid = signRequest(command, { audience: f.policy.audience, keyId: 'qa-key', privateKey: f.keys.privateKey, ...extra });
    await assert.rejects(f.broker.execute(invalid.raw, invalid.headers), { code: 'invalid_signature' });
  }
  await f.broker.execute(signed.raw, signed.headers);
  await assert.rejects(f.broker.execute(signed.raw, signed.headers), { code: 'request_replayed' });
});
test('idempotency survives restart and still checks current grants and connection state', async t => {
  const f = fixture(t); const command = f.command();
  await f.execute(command);
  const second = new BrokerStore(f.filename); t.after(() => second.close());
  const broker = new Broker({ store: second, policy: f.policy, secrets: { invalidate() {}, withSecret() { throw Error('must not execute twice'); } } });
  const request = f.signed(command);
  assert.equal((await broker.execute(request.raw, request.headers)).replayed, true);
  const event = eventFor(command, f.policy.principals[0], f.policy, 'connection.blocked', 'success', 'operator_block');
  broker.block(command.connectionRef, event);
  const third = new Broker({ store: second, policy: f.policy, secrets: createFictitiousSecretStore() });
  const blocked = f.signed(command);
  await assert.rejects(third.execute(blocked.raw, blocked.headers), { code: 'connection_blocked' });
});
test('in-flight duplicate cannot cause a second provider invocation', async t => {
  let release; let calls = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const base = OPERATIONS['fictitious.connection.check.v1'];
  const f = fixture(t, { operations: { 'fictitious.connection.check.v1': { ...base, async execute() { calls++; await waiting; return { fixture: true, status: 'available' }; } } } });
  const command = f.command(); const running = f.execute(command);
  await assert.rejects(f.execute(command), { code: 'outcome_unknown' });
  release(); await running; assert.equal(calls, 1);
});
test('ambiguous timeout is durable and never retries a side effect automatically', async t => {
  const base = OPERATIONS['fictitious.connection.check.v1'];
  const f = fixture(t, { timeoutMs: 5, operations: { 'fictitious.connection.check.v1': { ...base, execute: () => new Promise(() => {}) } } });
  const command = f.command();
  await assert.rejects(f.execute(command), { code: 'provider_timeout' });
  await assert.rejects(f.execute(command), { code: 'outcome_unknown' });
  assert.equal(f.store.db.prepare('SELECT state FROM commands').get().state, 'unknown');
});
test('block during secret retrieval prevents dispatch', async t => {
  let release; let dispatched = 0;
  const waiting = new Promise(resolve => { release = resolve; });
  const base = OPERATIONS['fictitious.connection.check.v1'];
  const f = fixture(t, { secrets: { invalidate() {}, async withSecret(binding, work) { await waiting; return work(Buffer.from('FAKE_SECRET')); } },
    operations: { 'fictitious.connection.check.v1': { ...base, async execute() { dispatched++; return { fixture: true, status: 'available' }; } } } });
  const command = f.command(); const running = f.execute(command);
  f.broker.block(command.connectionRef, eventFor(command, f.policy.principals[0], f.policy, 'connection.blocked', 'success', 'operator_block'));
  release(); await assert.rejects(running); assert.equal(dispatched, 0);
});
test('provider errors are fixed public codes; unsafe fields never reach persisted responses', async t => {
  const base = OPERATIONS['fictitious.connection.check.v1']; const sentinel = 'LEAKED_TOKEN';
  const f = fixture(t, { operations: { 'fictitious.connection.check.v1': { ...base, execute: async () => { throw Object.assign(Error(sentinel), { response: sentinel, config: sentinel }); } } } });
  try { await f.execute(f.command()); assert.fail(); } catch (error) {
    assert.deepEqual(publicError(error), { status: 502, body: { error: { code: 'provider_failed' } } });
  }
  assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM audit_outbox').all()).includes(sentinel), false);
});
test('durable per-principal quota and backlog bound calls before any secret fetch', async t => {
  const f = fixture(t); f.broker.policy.principals[0].maxPerMinute = 1;
  await f.execute(f.command());
  await assert.rejects(f.execute(f.command()), { code: 'rate_limited' });
  const g = fixture(t); g.broker.policy.maxBacklog = 2;
  await g.execute(g.command());
  await assert.rejects(g.execute(g.command()), { code: 'audit_unavailable' });
});
test('same command id with different authorized content is a conflict', async t => {
  const f = fixture(t); const command = f.command(); await f.execute(command);
  f.broker.policy.grants.push({ ...f.policy.grants[0], assetRef: 'asset:789' });
  await assert.rejects(f.execute({ ...command, assetRef: 'asset:789' }), { code: 'idempotency_conflict' });
});
