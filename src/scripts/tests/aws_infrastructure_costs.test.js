'use strict';
require('../../../services/aws-cost-collector/test/offline-guard.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createService, projectSnapshot, monthsAt, invokeCollector } = require('../../services/awsInfrastructureCosts.service');
const { snapshot } = require('./fixtures/aws_costs.fixture');
const now = () => new Date('2026-09-12T04:00:00Z');
test('child process receives no app environment, uses fixed script and closed stdin, never a shell', async () => {
  const fs = require('node:fs'); const path = require('node:path'); const vm = require('node:vm');
  const { createRequire } = require('node:module');
  const filename = path.resolve(__dirname, '../../services/awsInfrastructureCosts.service.js'); const localRequire = createRequire(filename);
  const module = { exports: {} }; let invocation;
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, __dirname: path.dirname(filename),
    process: { env: { AWS_SECRET_ACCESS_KEY: 'SECRET_SENTINEL', JWT_SECRET: 'SECRET_SENTINEL', NODE_OPTIONS: 'SECRET_SENTINEL' } },
    require: name => name === 'node:child_process' ? { execFile: (binary, args, options, callback) => {
      invocation = { binary, args, options };
      return { stdin: { on: () => {}, end: input => {
        invocation.input = JSON.parse(input); callback(null, JSON.stringify({ ok: true, snapshot: snapshot() }));
      } } };
    } } : localRequire(name) }, { filename });
  const result = await module.exports.invokeCollector({ nodeBinary: process.execPath }, '2026-09');
  assert.equal(result.amount, '0.2'); assert.equal(invocation.binary, process.execPath);
  assert.equal(invocation.args.length, 1); assert(invocation.args[0].endsWith('/services/aws-cost-collector/src/main.js'));
  assert.equal(invocation.options.shell, undefined);
  assert.deepEqual(Object.keys(invocation.options.env).sort(), ['AWS_EC2_METADATA_V1_DISABLED', 'PATH', 'TZ']);
  assert.equal(invocation.options.env.AWS_EC2_METADATA_V1_DISABLED, 'true');
  assert.deepEqual(Object.keys(invocation.input).sort(), ['accountId', 'environment', 'month', 'roleArn']);
  assert.equal(JSON.stringify(invocation).includes('SECRET_SENTINEL'), false);
});
test('cache endpoint enforces technical administrator before any storage read and never collects', async () => {
  let reads = 0; let collects = 0;
  const service = createService({ now, config: () => ({ enabled: true }), collect: async () => { collects++; }, repository: { read: async () => { reads++; return { snapshot: snapshot() }; } } });
  for (const userId of [undefined, 0, 2, '1fake', '44fake', {}, 1.1]) await assert.rejects(service.getOverview({ userId }), error => error.status === 403);
  assert.equal(reads, 0);
  for (const userId of [1, 44]) { const result = await service.getOverview({ userId }); assert.equal(result.status, 'available'); assert.equal(result.snapshot.services[0].amount, '0.2'); }
  assert.equal(collects, 0);
  await assert.rejects(service.getOverview({ userId: 1, month: '2025-01' }), error => error.status === 400);
  assert.equal(reads, 2);
});
test('disabled daily job neither reads cache nor spawns AWS process', async () => {
  const forbidden = () => { throw Error('must not execute'); };
  const service = createService({ repository: { acquire: forbidden }, collect: forbidden, now });
  assert.deepEqual(await service.runDaily(), { status: 'completed', skipped: true, reason: 'cost_collection_disabled' });
});
test('missing migration and hostile cache error render pending safely', async () => {
  for (const original of [{ code: 'ER_NO_SUCH_TABLE' }, { code: 'SECRET_SENTINEL' }]) {
    const service = createService({ now, repository: { read: async () => { throw { original }; } } });
    const result = await service.getOverview({ userId: 1 }); assert.equal(result.status, 'pending'); assert.equal(result.snapshot, null);
    assert.equal(result.error, original.code === 'ER_NO_SUCH_TABLE' ? 'cost_migration_required' : 'cost_cache_unavailable');
    assert.equal(JSON.stringify(result).includes('SECRET_SENTINEL'), false);
  }
});
test('age, future timestamp and errors make saved amounts stale across service recreation', async () => {
  for (const record of [{ snapshot: snapshot('2026-09', { collectedAt: '2026-09-01' }) },
    { snapshot: snapshot('2026-09', { collectedAt: '2026-09-13' }) }, { snapshot: snapshot(), last_error_code: 'SECRET_SENTINEL' }]) {
    const service = createService({ now, repository: { read: async () => JSON.parse(JSON.stringify(record)) } });
    const result = await service.getOverview({ userId: 1 });
    assert(['stale', 'pending'].includes(result.status)); assert.equal(JSON.stringify(result).includes('SECRET_SENTINEL'), false);
  }
});
test('collector errors and pending refreshes preserve last good snapshot, without automatic retries', async () => {
  for (const fail of [true, false]) {
    const saved = []; let calls = 0;
    const service = createService({ now, config: () => ({ enabled: true }), collect: async (_config, month) => {
      calls++; if (fail) throw Error('SDK_SECRET_SENTINEL'); return snapshot(month, { status: 'pending', amount: null });
    }, repository: { acquire: async () => 'lease', read: async () => ({ snapshot: snapshot() }),
      finish: async (...args) => { saved.push(args); return true; } } });
    const result = await service.runDaily(); assert.equal(result.retryable, false); assert.equal(calls, 2);
    assert.equal(saved.length, 2); assert(saved.every(args => args[2] === null));
    assert.equal(saved[0][3], fail ? 'cost_aws_unavailable' : 'cost_data_pending');
    assert.equal(JSON.stringify(result).includes('SDK_SECRET_SENTINEL'), false);
  }
});
test('lease conflict skips collection and superseded worker cannot report a saved result', async () => {
  let collects = 0;
  const service = createService({ now, config: () => ({ enabled: true }), collect: async (_config, month) => { collects++; return snapshot(month); },
    repository: { acquire: async key => key.endsWith('09') ? null : 'lost', read: async () => null, finish: async () => false } });
  const result = await service.runDaily(); assert.equal(collects, 1);
  assert.deepEqual(result.periods.map(row => row.reason), ['refresh_in_progress', 'lease_lost']);
});
test('closed projection removes extra secrets and rejects inconsistent totals, ranges and currencies', () => {
  assert.equal(JSON.stringify(projectSnapshot(snapshot('2026-09', { token: 'SECRET_SENTINEL' }), '2026-09')).includes('SECRET_SENTINEL'), false);
  for (const patch of [{ amount: '20' }, { currency: 'EUR' }, { amount: null }, { period: { from: '2026-09-01', toExclusive: '2026-11-01' } }]) {
    assert.throws(() => projectSnapshot(snapshot('2026-09', patch), '2026-09'), /cost_snapshot_invalid/);
  }
  assert.deepEqual(monthsAt(new Date('2027-01-01T00:00:00Z')), ['2027-01', '2026-12']);
  assert.throws(() => invokeCollector({ nodeBinary: '/this-does-not-exist' }, '2026-09'), /cost_collector_unavailable/);
});
