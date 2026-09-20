'use strict';
require('./fixtures/campaign_offline_runtime.cjs');
const test = require('node:test');
const assert = require('node:assert/strict');
const { projectSnapshot, createService } = require('../../services/googleCloudCosts.service');
const { snapshot } = require('./fixtures/google_cloud_costs.fixture');
test('report projection verifies project, currency, period, totals and strips private fields', () => {
  const result = projectSnapshot(snapshot(undefined, { secret: 'SECRET_SENTINEL' }), '2026-09');
  assert.equal(result.net, '0'); assert.equal(result.credits, '-1.53');
  assert(!JSON.stringify(result).includes('SECRET_SENTINEL'));
  for (const change of [{ projectId: 'other' }, { currency: 'USD' }, { net: '10' }, { gross: null }, { invoice: true },
    { source: 'requests_estimate' }, { period: { from: '2026-09-01', toExclusive: '2026-09-31' } },
    { period: { from: '2026-09-01', toExclusive: '2026-10-01' } },
    { services: [snapshot().services[0], snapshot().services[0]] }]) {
    assert.throws(() => projectSnapshot(snapshot(undefined, change), '2026-09'));
  }
});
test('no snapshot stays pending; a real zero and stale report remain distinguishable', async () => {
  const get = (value, date) => createService({ now: () => new Date(date), repository: { read: async () => value } }).getOverview({ userId: 1 });
  assert.equal((await get(null, '2026-09-20T12:00:00Z')).snapshot, null);
  assert.equal((await get(null, '2026-09-20T12:00:00Z')).status, 'pending');
  const available = await get({ snapshot: snapshot() }, '2026-09-20T12:00:00Z');
  assert.equal(available.status, 'available'); assert.equal(available.snapshot.net, '0'); assert.equal(available.automaticCollectionEnabled, false);
  const stale = await get({ snapshot: snapshot() }, '2026-09-29T12:00:00Z');
  assert.equal(stale.status, 'stale'); assert.equal(stale.snapshot.gross, '1.53');
  await assert.rejects(get({ snapshot: snapshot() }, '2026-09-19T12:00:00Z'));
});
test('unauthorized actors and periods cannot touch the cache', async () => {
  const service = createService({ now: () => new Date('2026-09-20T12:00:00Z'), repository: { read: () => assert.fail('Forbidden cache read') } });
  for (const userId of [undefined, 5, '1fake', {}]) await assert.rejects(service.getOverview({ userId }), { code: 'technical_admin_required' });
  for (const month of ['2026-07', '', {}, ['2026-09']]) await assert.rejects(service.getOverview({ userId: 1, month }), { code: 'cost_period_invalid' });
});
