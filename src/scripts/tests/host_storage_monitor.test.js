'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../../lib/host-storage-monitor');
const now = Date.parse('2026-10-18T12:00:00Z');
const observation = percent => ({ usedPercent: percent, availableBytes: 1024 ** 3, totalBytes: 100 * 1024 ** 3 });
const state = band => ({ version: 1, notifiedBand: band, notifiedAt: now - 1000 });

test('statfs matches df and includes reserved blocks as unavailable', () => {
  assert.equal(M.sample({ blocks: 100, bfree: 25, bavail: 20, bsize: 1024 }).usedPercent, 100 * 75 / 95);
  assert.equal(M.sample({ blocks: 100, bfree: 0, bavail: 0, bsize: 1024 }).usedPercent, 100);
  assert.throws(() => M.sample({ blocks: 0 }), /sample_invalid/);
});
test('first warning at 80, immediate escalations at 90 and 95', () => {
  assert.equal(M.decision(observation(79.99), null, now).notify, false);
  assert.equal(M.decision(observation(80), null, now).band, 80);
  assert.equal(M.decision(observation(90), state(80), now).band, 90);
  assert.equal(M.decision(observation(95), state(90), now).band, 95);
});
test('no repeated mail on five-minute polling or oscillation', () => {
  for (const percent of [80, 89, 90, 94, 95, 99, 100]) {
    assert.equal(M.decision(observation(percent), state(95), now).notify, false);
  }
  assert.equal(M.decision(observation(88), state(80), now + M.REPEAT_MS).notify, true);
});
test('hysteresis preserves incident until below 75 and then reports recovery once', () => {
  assert.equal(M.decision(observation(77), state(90), now).nextState.notifiedBand, 90);
  const recovered = M.decision(observation(74.9), state(90), now);
  assert.equal(recovered.eventKey, 'system.host_storage_recovered');
  assert.equal(recovered.nextState, null);
  assert.equal(M.decision(observation(74.9), null, now).notify, false);
});
test('invalid state cannot suppress a new alert', () => {
  assert.equal(M.decision(observation(90), { ...state(95), notifiedAt: now + 10 }, now).notify, true);
  assert.throws(() => M.decision(observation(NaN), null, now));
});
test('alert explains scope, impact and space without claiming a Meta failure', () => {
  const snapshot = observation(89);
  const alert = M.alert(snapshot, M.decision(snapshot, null, now), now);
  assert.match(alert.payload.detail, /MySQL.*comparten/);
  assert.match(alert.payload.detail, /no confirma una caida/);
  assert.deepEqual(alert.channelsOverride, { panel: true, email: true, whatsapp: false });
});
test('disabled or failed email enqueue does not record success', async () => {
  const stats = { blocks: 100, bfree: 10, bavail: 10, bsize: 1024 };
  await assert.rejects(M.check({ stats, now, notify: async () => ({ created: [], skipped: [] }) }), /email_not_queued/);
  const result = await M.check({ stats, now, notify: async () => ({ created: [{ channel: 'email', deliveryId: 1 }] }) });
  assert.equal(result.notified, true);
  assert.equal(result.nextState.notifiedBand, 90);
  await assert.rejects(M.check({ stats, now, notify: async () => { throw Error('transport'); } }), /transport/);
});
test('healthy observation never loads or calls delivery', async () => {
  const result = await M.check({ stats: { blocks: 100, bfree: 80, bavail: 80, bsize: 1024 }, now,
    notify: async () => { throw Error('must_not_dispatch'); } });
  assert.equal(result.notified, false);
});
