'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../src/scope');
const { run } = require('../src/main');
const receive = () => ({ operation: 'receive', max: 10, visibilitySeconds: 120 });
function fixture(patch = {}) {
  const calls = []; let destroyed = 0;
  const clients = {
    async identity(options) { calls.push(['identity', options]); return { Account: S.ACCOUNT, Arn: `arn:aws:sts::${S.ACCOUNT}:assumed-role/clinicaclick-platform-alerts-role/fixture` }; },
    async queue(options) { calls.push(['queue', options]); return { Attributes: { QueueArn: S.QUEUE_ARN, MessageRetentionPeriod: '1209600', VisibilityTimeout: '120', SqsManagedSseEnabled: 'true' } }; },
    async receive(input, options) { calls.push(['receive', input, options]); return { Messages: [{ ReceiptHandle: 'FIXTURE_HANDLE', Body: '{"Type":"Notification","fixture":true}' }] }; },
    async ack(input, options) { calls.push(['ack', input, options]); return { $metadata: { httpStatusCode: 200 } }; },
    destroy() { destroyed++; }, ...patch,
  };
  return { clients, calls, dependencies: { credentials: () => { throw Error('fixture must not acquire actual credentials'); }, createClients: () => clients }, destroyed: () => destroyed };
}
test('closed input admits only fixed receive/ack, rejects arbitrary URL/credentials/mutation/bounds', () => {
  for (const value of [null, [], {}, { ...receive(), queueUrl: 'https://evil.invalid' }, { ...receive(), credentials: {} },
    { ...receive(), max: 11 }, { ...receive(), max: 0 }, { ...receive(), max: 1.2 }, { ...receive(), visibilitySeconds: 0 },
    { operation: 'purge' }, { operation: 'ack', receiptHandle: 'line\nbreak' }, { operation: 'ack', receiptHandle: 'a'.repeat(4097) }]) assert.throws(() => S.parseInput(value), /alerts_input_invalid/);
  assert.deepEqual(S.parseInput(receive()), receive());
  assert.equal(S.parseInput({ operation: 'ack', receiptHandle: 'FAKE+/=' }).receiptHandle, 'FAKE+/=');
});
test('receive verifies actual role and exact encrypted durable queue before one bounded read; never deletes', async () => {
  const f = fixture(); const result = await run(receive(), f.dependencies);
  assert.deepEqual(f.calls.map(x => x[0]), ['identity', 'queue', 'receive']);
  assert.deepEqual(f.calls[2][1], { QueueUrl: S.QUEUE_URL, MaxNumberOfMessages: 10, VisibilityTimeout: 120, WaitTimeSeconds: 5 });
  assert.equal(result.messages.length, 1); assert.equal(result.messages[0].receiptHandle, 'FIXTURE_HANDLE');
  assert.deepEqual(result.identity, { accountId: S.ACCOUNT, roleArn: S.ROLE });
  assert.equal(result.queueArn, S.QUEUE_ARN); assert.equal(f.destroyed(), 1);
});
test('wrong account, cost role, foreign queue, wrong retention/encryption fail before receive/delete', async () => {
  for (const identity of [{ Account: '000000000000', Arn: '' }, { Account: S.ACCOUNT, Arn: `arn:aws:sts::${S.ACCOUNT}:assumed-role/clinicaclick-platform-cost-collector-role/x` }]) {
    const f = fixture({ identity: async () => identity }); await assert.rejects(run(receive(), f.dependencies), /alerts_identity_invalid/);
    assert.equal(f.calls.length, 0); assert.equal(f.destroyed(), 1);
  }
  for (const patch of [{ QueueArn: S.QUEUE_ARN + '-other' }, { MessageRetentionPeriod: '345600' }, { VisibilityTimeout: '30' }, { SqsManagedSseEnabled: 'false' }]) {
    const f = fixture({ queue: async () => ({ Attributes: { QueueArn: S.QUEUE_ARN, MessageRetentionPeriod: '1209600', VisibilityTimeout: '120', SqsManagedSseEnabled: 'true', ...patch } }) });
    await assert.rejects(run(receive(), f.dependencies), /alerts_queue_identity_invalid/); assert.equal(f.destroyed(), 1);
    assert(!f.calls.some(x => ['receive', 'ack'].includes(x[0])));
  }
});
test('ack is a separate operation, exact one handle, and success requires known HTTP200', async () => {
  const f = fixture(); const result = await run({ operation: 'ack', receiptHandle: 'RAM_ONLY' }, f.dependencies);
  assert.deepEqual(f.calls.map(x => x[0]), ['identity', 'queue', 'ack']);
  assert.deepEqual(f.calls[2][1], { QueueUrl: S.QUEUE_URL, ReceiptHandle: 'RAM_ONLY' });
  assert.deepEqual(result, { ok: true, operation: 'ack', deleted: true });
  for (const response of [{}, { $metadata: { httpStatusCode: 204 } }]) {
    const bad = fixture({ ack: async () => response }); await assert.rejects(run({ operation: 'ack', receiptHandle: 'RAM_ONLY' }, bad.dependencies), /alerts_ack_unknown/); assert.equal(bad.destroyed(), 1);
  }
});
test('timeout/unknown delete is not retried or made successful and errors never echo credentials/handle', async () => {
  let attempts = 0; const f = fixture({ ack: async () => { attempts++; throw Error('SECRET_SENTINEL_RAM_HANDLE'); } });
  await assert.rejects(run({ operation: 'ack', receiptHandle: 'SECRET_SENTINEL_RAM_HANDLE' }, f.dependencies));
  assert.equal(attempts, 1); assert.equal(f.destroyed(), 1);
  assert.equal(S.safeError(Error('SECRET_SENTINEL_RAM_HANDLE')), 'alerts_transport_unavailable');
});
test('abort, including a late successful response, is terminal; clients always close', async () => {
  const controller = new AbortController();
  const f = fixture({ receive: async () => { controller.abort(); return { Messages: [] }; } });
  await assert.rejects(run(receive(), { ...f.dependencies, signal: controller.signal }), /alerts_timeout/); assert.equal(f.destroyed(), 1);
});
test('raw messages stay inside bounded RAM projection; no metadata/URL/handle expansion', () => {
  assert.deepEqual(S.projectMessages({}, 10), []);
  for (const result of [{ Messages: new Array(11).fill({}) }, { Messages: [{ ReceiptHandle: 'x', Body: 'a'.repeat(65537) }] },
    { Messages: [{ ReceiptHandle: 'x', Body: '{}' }, { ReceiptHandle: 'x', Body: '{}' }] }]) assert.throws(() => S.projectMessages(result, 10), /alerts_response_invalid/);
  assert.deepEqual(S.projectMessages({ Messages: [{ ReceiptHandle: 'x', Body: '{}', Attributes: { secret: 'discard' } }] }, 1), [{ receiptHandle: 'x', snsEnvelopeRaw: '{}' }]);
});
test('offline network guard is active', () => { assert.throws(() => require('node:net').connect(443, 'example.invalid'), /NETWORK_FORBIDDEN/); });
