'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { BrokerStore } = require('../src/store');
const { drainAudit, createS3AuditSink, eventFor } = require('../src/audit');
const { fixture } = require('./helpers');

test('outage, retry, reopen and delivery preserve event identity and correlation', async t => {
  const f = fixture(t); await f.execute(f.command());
  const now = Date.now();
  const failed = await drainAudit(f.store, { write: async () => { throw Error('FAKE_CREDENTIAL_IN_SDK_ERROR'); } }, { now: () => now });
  assert.equal(failed.failed, 2); assert.equal(failed.pending, 2);
  const reopened = new BrokerStore(f.filename); t.after(() => reopened.close());
  const received = [];
  const result = await drainAudit(reopened, { write: async row => { received.push(JSON.parse(row.event)); return { versionId: 'fake-s3-version', digest: row.digest }; } }, { now: () => now + 2000 });
  assert.equal(result.delivered, 2); assert.equal(result.pending, 0);
  assert.equal(received[0].correlationId, received[1].correlationId);
});
test('leases prevent duplicate delivery; expired claims recover after worker failure', async t => {
  const f = fixture(t); await f.execute(f.command());
  const now = Date.now(); const a = f.store.claim(now);
  const other = new BrokerStore(f.filename); t.after(() => other.close());
  const b = other.claim(now); assert.notEqual(a.id, b.id);
  assert.equal(f.store.claim(now), null);
  const recovered = other.claim(now + 31000); assert.equal(recovered.id, a.id);
  f.store.acknowledge(a, { versionId: 'stale-lease', digest: a.digest }, now + 31000);
  assert.equal(f.store.backlog().pending, 2);
});
test('S3 sink uses fixed prefix, exact KMS and conditional checksum write; missing ACK stays pending', async t => {
  const f = fixture(t); await f.execute(f.command()); let input;
  const sink = createS3AuditSink({ bucket: 'fixture-audit-bucket', keyArn: 'arn:aws:kms:eu-west-3:123456789012:key/11111111-1111-4111-8111-111111111111',
    client: { send: async command => { input = command.input; return { VersionId: 'fixture-version', ChecksumSHA256: input.ChecksumSHA256 }; } } });
  const result = await drainAudit(f.store, sink, { limit: 1 });
  assert.equal(result.delivered, 1);
  assert.equal(input.IfNoneMatch, '*'); assert.equal(input.ServerSideEncryption, 'aws:kms');
  assert.match(input.Key, /^app\/v1\/\d{4}-\d{2}-\d{2}\//);
  const bad = await drainAudit(f.store, { write: async () => ({ versionId: 'x', digest: 'wrong' }) });
  assert.equal(bad.pending, 1); assert.equal(bad.failed, 1);
});
test('audit rejects clinical bodies and secrets instead of serializing arbitrary objects', t => {
  const f = fixture(t); const event = eventFor(f.command(), f.policy.principals[0], f.policy, 'integration.requested', 'accepted', 'authorized');
  assert.throws(() => f.store.appendAudit({ ...event, body: { patient: 'FICTITIOUS', token: 'SENTINEL' } }), { code: 'invalid_request' });
  assert.equal(f.store.backlog().pending, 0);
});
test('SQLite consistent backup restores blocked state, idempotency and undelivered audit', async t => {
  const f = fixture(t); const command = f.command(); await f.execute(command);
  f.broker.block(command.connectionRef, eventFor(command, f.policy.principals[0], f.policy, 'connection.blocked', 'success', 'operator_block'));
  const filename = path.join(f.dir, 'restored.sqlite'); await f.store.backup(filename);
  const restored = new BrokerStore(filename); t.after(() => restored.close());
  assert.throws(() => restored.connection(command.connectionRef), { code: 'connection_blocked' });
  assert.equal(restored.backlog().pending, 3);
  assert.equal(restored.db.prepare('SELECT state FROM commands').get().state, 'completed');
});
