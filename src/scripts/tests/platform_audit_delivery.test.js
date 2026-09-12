'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { createDelivery, invokeWriter } = require('../../services/platformAudit.delivery');
const { createMonitor, assess } = require('../../services/platformAudit.monitor');
const { fixture } = require('../../../services/platform-audit/test/fixture.cjs');
const { pack, keyFor } = require('../../../services/platform-audit/src/event');
const sourceRoleArn = 'arn:aws:iam::137819318729:role/fictitious-audit-source';
const zero = () => ({ pending: 0, reconcile: 0, oldestAgeSeconds: 0, unresolvedAttempts: 0, oldestUnresolvedAgeSeconds: 0 });
function harness(count = 3) {
  const queue = Array.from({ length: count }, () => pack(fixture())); const acked = []; const retries = []; const finished = [];
  const state = { acquire: async () => 'lease', finish: async (...args) => { finished.push(args); return true; } };
  const repository = { claim: async () => queue.shift() || null, acknowledge: async (row, receipt) => { acked.push(receipt); return true; },
    retry: async (row, code) => { retries.push({ row, code }); }, health: async () => zero() };
  const config = () => ({ enabled: true, sourceRoleArn, nodeBinary: process.execPath });
  return { queue, acked, retries, finished, state, repository, config };
}
const success = rows => ({ version: 1, results: rows.map(row => ({ eventId: JSON.parse(row.body).eventId,
  digest: row.digest, status: 'delivered', receipt: { key: keyFor(row), digest: row.digest, versionId: 'fictitious-version' } })) });
test('gates and occupied global lease avoid row claims and subprocess calls', async () => {
  for (const disabled of [true, false]) {
    const f = harness(); f.state.acquire = async () => { if (disabled) assert.fail('disabled lease'); return null; };
    const service = createDelivery({ ...f, config: () => ({ enabled: !disabled, sourceRoleArn }), write: () => assert.fail('writer') });
    assert.equal((await service.run()).skipped, true); assert.equal(f.queue.length, 3);
  }
});
test('one bounded batch writes receipts individually and leaves unconfirmed rows pending', async () => {
  const f = harness(60);
  const service = createDelivery({ ...f, write: async (_config, rows) => {
    assert.equal(rows.length, 50); const value = success(rows); const bad = value.results[7]; delete bad.receipt;
    Object.assign(bad, { status: 'reconcile', error: 'audit_reconciliation_required' }); return value;
  } });
  const result = await service.run(); assert.equal(result.status, 'failed'); assert.equal(result.retryable, false);
  assert.equal(result.delivered, 49); assert.equal(result.failed, 1); assert.equal(f.retries[0].code, 'audit_reconciliation_required');
  assert.equal(f.queue.length, 10); assert.equal(f.finished.length, 1);
});
test('ambiguous child failure or tampered batch cannot acknowledge any row; empty queue avoids AWS', async () => {
  for (const mode of ['throw', 'tamper', 'empty']) {
    const f = harness(mode === 'empty' ? 0 : 3);
    const result = await createDelivery({ ...f, write: async (_settings, rows) => {
      if (mode === 'empty') assert.fail('empty queue invoked AWS');
      if (mode === 'throw') throw Error('SENTINEL_SECRET');
      const result = success(rows); result.results[1].digest = '0'.repeat(64); return result;
    } }).run();
    assert.equal(f.acked.length, 0); assert.equal(f.retries.length, mode === 'empty' ? 0 : 3);
    assert(!JSON.stringify(result).includes('SENTINEL'));
  }
});
test('native process boundary sends only canonical events over stdin and excludes inherited environment credentials', async () => {
  const rows = [pack(fixture())]; let captured;
  const execute = (file, args, options, callback) => {
    captured = { file, args, options };
    return { stdin: { on: () => {}, end: input => {
      captured.input = JSON.parse(input); callback(null, JSON.stringify({ ok: true, batch: success(rows) }));
    } } };
  };
  process.env.PLATFORM_AUDIT_TEST_SECRET = 'SENTINEL_SECRET';
  const result = await invokeWriter({ sourceRoleArn, nodeBinary: process.execPath }, rows, execute);
  delete process.env.PLATFORM_AUDIT_TEST_SECRET;
  assert.equal(result.results.length, 1); assert.equal(captured.args.length, 1); assert(captured.args[0].endsWith('/writer-main.js'));
  assert.deepEqual(Object.keys(captured.options.env).sort(), ['PATH', 'TZ', 'AWS_CONFIG_FILE', 'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_EC2_METADATA_SERVICE_ENDPOINT', 'AWS_EC2_METADATA_V1_DISABLED'].sort());
  assert.equal(captured.options.env.AWS_CONFIG_FILE, '/dev/null'); assert.equal(captured.options.timeout, 75000);
  assert.equal(captured.options.killSignal, 'SIGKILL'); assert(!JSON.stringify(captured).includes('SENTINEL'));
  assert.deepEqual(Object.keys(captured.input.records[0]), ['body', 'digest']);
});
test('health projection marks stale, backlog, unknown outcomes and reconciliation without accepting arbitrary metadata', async () => {
  const now = new Date('2026-09-12T12:00:00Z'); const state = { last_completed_at: now, last_error: null, token: 'SENTINEL_SECRET' };
  assert.equal(assess(zero(), state, now).level, 'healthy');
  const values = [[{ ...zero(), pending: 10000 }, 'audit_backlog_exceeded'], [{ ...zero(), oldestAgeSeconds: 300 }, 'audit_backlog_warning'],
    [{ ...zero(), unresolvedAttempts: 1, oldestUnresolvedAgeSeconds: 301 }, 'audit_unresolved_attempts'],
    [{ ...zero(), reconcile: 1 }, 'audit_reconciliation_required']];
  for (const [metrics, code] of values) assert.equal(assess(metrics, state, now).code, code);
  assert.equal(assess(zero(), { last_completed_at: new Date(now - 301000) }, now).code, 'audit_delivery_stale');
  assert(!JSON.stringify(assess({ ...zero(), token: 'SENTINEL_SECRET' }, state, now)).includes('SENTINEL'));
  const monitor = createMonitor({ repository: { health: () => assert.fail('unauthorized DB') }, state: {}, config: () => ({}) });
  await assert.rejects(monitor.getHealth(701), /technical_admin_required/);
  assert.equal((await monitor.getHealth(1)).status, 'disabled');
});
