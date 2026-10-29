'use strict';
// Owned Redis only. No application bootstrap, SQL, browser session or provider.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { Queue, Worker } = require('bullmq');
const { createService } = require('../../services/whatsappAuthorizedPhoneSync.service');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) {
  const deadline = Date.now() + 10000;
  while (!await check()) {
    if (Date.now() >= deadline) throw Error('owned_redis_test_timeout');
    await sleep(20);
  }
}

test('owned BullMQ deduplicates concurrent/finished checks and retries one phone without blocking another', { timeout: 20000 }, async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-phone-sync-redis-'));
  await fs.chmod(dir, 0o700);
  const socket = path.join(dir, 'redis.sock');
  const child = spawn('/usr/bin/redis-server', ['--port', '0', '--unixsocket', socket,
    '--unixsocketperm', '700', '--save', '', '--appendonly', 'no', '--loglevel', 'warning'], { stdio: 'ignore' });
  let queue, worker;
  try {
    await until(async () => { try { await fs.access(socket); return true; } catch { return false; } });
    const connection = { path: socket, maxRetriesPerRequest: null };
    queue = new Queue('whatsapp_phone_sync', { connection, prefix: 'owned_qa' });
    const bindings = [1, 2].map(assetId => ({ connectionRef: 'synthetic-connection',
      authorizationId: 'a1234567-1234-4234-8234-123456789abc', clinicId: 35, assetId,
      phoneId: String(900000000 + assetId), wabaId: '800000001', revision: 1, sendEnabled: true }));
    const reads = [], completed = [], attempts = new Map();
    const service = createService({
      broker: { configuration: () => ({ bindings }), binding: async (clinic, id) =>
        bindings.find(value => value.clinicId === clinic && value.assetId === id) },
      loadAsset: async id => ({ id, assetType: 'whatsapp_phone_number', isActive: true }),
      enqueueJob: (data, options) => queue.add('sync', data, { ...options,
        attempts: 3, backoff: { type: 'fixed', delay: 150 } }),
      refresh: async ({ asset }) => {
        reads.push(asset.id); attempts.set(asset.id, (attempts.get(asset.id) || 0) + 1);
        if (asset.id === 1 && attempts.get(1) === 1) throw Error('synthetic_provider_timeout');
        completed.push(asset.id); return { health: { state: 'healthy', can_send: true } };
      }, now: () => new Date('2026-10-29T14:00:00Z'),
    });
    await Promise.all([service.enqueue(), service.enqueue()]);
    assert.equal(await queue.count(), 2);
    worker = new Worker('whatsapp_phone_sync', job => service.run(job.data), { connection, prefix: 'owned_qa' });
    worker.on('error', () => {});
    await until(async () => await queue.getCompletedCount() === 2);
    assert.deepEqual(completed, [2, 1], 'The healthy phone completes before the other retry');
    assert.deepEqual(reads, [1, 2, 1]);
    await service.enqueue();
    assert.equal(await queue.getCompletedCount(), 2);
    assert.equal(await queue.getWaitingCount(), 0, 'Completed hourly IDs remain deduplicated');
    assert.equal(require.cache[require.resolve('../../../models')], undefined, 'No application models or real database loaded');
  } finally {
    await worker?.close(); await queue?.close();
    const exited = once(child, 'exit'); child.kill('SIGTERM'); await exited;
    await fs.rm(dir, { recursive: true, force: true });
  }
});
