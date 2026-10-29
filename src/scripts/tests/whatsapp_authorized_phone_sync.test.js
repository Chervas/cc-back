'use strict';
require('./fixtures/security_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createService } = require('../../services/whatsappAuthorizedPhoneSync.service');

const binding = (assetId, clinicId = 35) => ({ connectionRef: 'synthetic-connection',
  authorizationId: 'a1234567-1234-4234-8234-123456789abc', clinicId, assetId,
  phoneId: String(900000000 + assetId), wabaId: '800000001', revision: 1, sendEnabled: true });
const asset = value => ({ id: value.assetId, assetType: 'whatsapp_phone_number', isActive: true,
  phoneNumberId: value.phoneId, wabaId: value.wabaId, assignmentScope: 'clinic', clinicaId: value.clinicId,
  whatsappAuthorizationId: value.authorizationId });

function fixture(bindings = [binding(1)]) {
  const assets = new Map(bindings.map(value => [value.assetId, asset(value)]));
  const queued = [], refreshed = [];
  const broker = { configuration: () => ({ bindings }),
    binding: async (clinicId, assetId) => bindings.find(value => value.clinicId === clinicId && value.assetId === assetId) || null };
  const service = createService({ broker, loadAsset: async id => assets.get(id),
    enqueueJob: async (data, options) => { queued.push({ data, options }); },
    refresh: async input => { refreshed.push(input); return { health: { state: 'healthy', can_send: true } }; },
    now: () => new Date('2026-10-29T14:00:00Z') });
  return { service, assets, queued, refreshed, broker };
}

test('a runtime without broker configuration never loads assets or enqueues a provider read', async () => {
  const service = createService({ broker: { configuration: () => null },
    loadAsset: () => assert.fail('No CRM/DEV identity may be inferred'),
    enqueueJob: () => assert.fail('No work without an explicit broker binding') });
  assert.deepEqual(await service.enqueue(), { queued: 0, skipped: 0, mode: 'authorized' });
});

test('phones with AWS custody and no local Meta token are checked individually, even in the same WABA', async () => {
  const f = fixture([binding(1), binding(2)]);
  assert.deepEqual(await f.service.enqueue(), { queued: 2, skipped: 0, mode: 'authorized' });
  assert.deepEqual(f.queued.map(job => job.data.assetId), [1, 2]);
  assert(f.queued.every(job => job.data.mode === 'authorized' && job.data.expectedBinding));
  assert(!JSON.stringify(f.queued).includes('accessToken'));
  assert(!JSON.stringify(f.queued).includes('waAccessToken'));
  for (const job of f.queued) await f.service.run(job.data);
  assert.equal(f.refreshed.length, 2);
});

test('one physical group number is checked once while preserving its authorized clinic scope', async () => {
  const f = fixture([binding(1, 19), binding(1, 35), binding(2, 35)]);
  await f.service.enqueue();
  assert.deepEqual(f.queued.map(job => [job.data.assetId, job.data.clinicId]), [[1, 19], [2, 35]]);
});

test('a blocked scope cannot stall another phone or an independently authorized group binding', async () => {
  const f = fixture([binding(1, 19), binding(1, 35), binding(2, 56)]);
  const original = f.broker.binding;
  f.broker.binding = async (clinicId, ...rest) => {
    if (clinicId === 19) throw Object.assign(Error('blocked'), { code: 'whatsapp_authorized_scope_blocked' });
    return original(clinicId, ...rest);
  };
  assert.deepEqual(await f.service.enqueue(), { queued: 2, skipped: 1, mode: 'authorized' });
  assert.deepEqual(f.queued.map(job => job.data.clinicId), [35, 56]);
});

test('inactive, manually stopped and superseded bindings are never refreshed', async () => {
  const f = fixture([binding(1), { ...binding(2), sendEnabled: false }, binding(3), binding(4)]);
  f.assets.get(1).isActive = false;
  const original = f.broker.binding;
  f.broker.binding = async (clinicId, assetId) => {
    const current = await original(clinicId, assetId);
    return assetId === 3 ? { ...current, revision: 2 } : current;
  };
  await f.service.enqueue();
  assert.deepEqual(f.queued.map(job => job.data.assetId), [4]);
});

test('an invalid binding is isolated but a database/queue outage is not silently reported as success', async () => {
  const f = fixture([binding(1), binding(2)]);
  const original = f.broker.binding;
  f.broker.binding = async (clinicId, assetId) => {
    if (assetId === 1) throw Object.assign(Error('invalid'), { code: 'whatsapp_authorized_binding_invalid' });
    return original(clinicId, assetId);
  };
  assert.deepEqual(await f.service.enqueue(), { queued: 1, skipped: 1, mode: 'authorized' });
  f.broker.configuration = () => { throw Error('configuration_unavailable'); };
  await assert.rejects(f.service.enqueue(), /configuration_unavailable/);
  const unavailable = createService({ broker: { configuration: () => ({ bindings: [binding(1)] }) },
    loadAsset: async () => { throw Error('database_unavailable'); } });
  await assert.rejects(unavailable.enqueue(), /database_unavailable/);
});

test('concurrent scheduler passes share a retained per-phone/hour job ID', async () => {
  const f = fixture();
  await Promise.all([f.service.enqueue(), f.service.enqueue()]);
  assert.equal(f.queued.length, 2);
  assert.equal(new Set(f.queued.map(job => job.options.jobId)).size, 1);
  assert.deepEqual(f.queued[0].options.removeOnComplete, { age: 7200, count: 2000 });
});

test('revocation or identity rotation after enqueue cannot refresh a replaced phone', async () => {
  const f = fixture();
  await f.service.enqueue();
  f.broker.binding = async () => ({ ...binding(1), revision: 2, phoneId: '999999999' });
  assert.deepEqual(await f.service.run(f.queued[0].data), { skipped: true, reason: 'whatsapp_authorized_phone_sync_superseded' });
  assert.equal(f.refreshed.length, 0);
});

test('worker input cannot swap the captured clinic or asset', async () => {
  const f = fixture();
  await f.service.enqueue();
  for (const changed of [{ clinicId: 99 }, { assetId: 3 }, { assetId: '1' }, { expectedBinding: null }]) {
    await assert.rejects(f.service.run({ ...f.queued[0].data, ...changed }), { code: 'whatsapp_authorized_phone_sync_invalid' });
  }
  assert.equal(f.refreshed.length, 0);
});

test('provider timeouts remain failures for the existing queue retry policy', async () => {
  const f = fixture();
  await f.service.enqueue();
  const unavailable = createService({ broker: f.broker, loadAsset: async id => f.assets.get(id),
    refresh: async () => { throw Object.assign(Error('provider_timeout'), { code: 'provider_timeout' }); } });
  await assert.rejects(unavailable.run(f.queued[0].data), { code: 'provider_timeout' });
});

test('the existing cron and phone worker route authorized checks without invoking legacy Graph', async () => {
  const native = require('../../services/whatsappPhones.service');
  const sync = require('../../services/whatsappAuthorizedPhoneSync.service');
  const { queues } = require('../../services/queue.service');
  const originals = { enqueue: sync.enqueue, run: sync.run, add: queues.whatsappPhoneSync.add };
  const data = { mode: 'authorized', assetId: 1, clinicId: 35, expectedBinding: binding(1) };
  try {
    sync.enqueue = async () => ({ queued: 1, skipped: 0, mode: 'authorized' });
    sync.run = async input => { assert.deepEqual(input, data); return { state: 'healthy' }; };
    assert.deepEqual(await native.enqueueSyncPhonesForAllWabas({ mode: 'full' }), { queued: 1, skipped: 0, mode: 'authorized' });
    assert.deepEqual(await native.syncPhonesForWaba(data), { state: 'healthy' });
    queues.whatsappPhoneSync.add = async (name, payload, options) => {
      assert.equal(name, 'sync'); assert.deepEqual(payload, data);
      assert.equal(options.attempts, 3); assert.equal(options.jobId, 'synthetic-health-job');
      assert.deepEqual(options.removeOnComplete, { age: 7200, count: 2000 });
    };
    await native.enqueueSyncPhonesJob(data, { jobId: 'synthetic-health-job', removeOnComplete: { age: 7200, count: 2000 } });
  } finally { sync.enqueue = originals.enqueue; sync.run = originals.run; queues.whatsappPhoneSync.add = originals.add; }
});
