'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { collectCosts, filterFor, viewCache } = require('../src/costs');
const config = { accountId: '123456789012', environment: 'prod', from: '2026-09-01', to: '2026-09-03', tagsVerified: true };
const day = (date, amount, component = 'integrations', currency = 'USD') => ({
  TimePeriod: { Start: date, End: new Date(Date.parse(date) + 86400000).toISOString().slice(0, 10) }, Estimated: true,
  Groups: [{ Keys: ['Amazon EC2', `component$${component}`], Metrics: { UnblendedCost: { Amount: amount, Unit: currency } } }],
});
test('cost collector paginates fixed scoped filter and preserves credits and decimal precision', async () => {
  const requests = [];
  const result = await collectCosts({ ...config, getCostAndUsage: async input => {
    requests.push(input); return input.NextPageToken
      ? { ResultsByTime: [day('2026-09-02', '-0.1', 'audit')] }
      : { ResultsByTime: [day('2026-09-01', '0.300000000000000001')], NextPageToken: 'page-2' };
  } });
  assert.equal(result.amount, '0.200000000000000001'); assert.equal(result.currency, 'USD'); assert.equal(result.status, 'available');
  assert.equal(result.pages, 2); assert.deepEqual(requests[0].Filter, requests[1].Filter);
  assert.deepEqual(requests[0].Filter, filterFor(config)); assert.equal(result.excludesAiEstimates, true);
});
test('unverified tags never call AWS and empty/missing data is pending, not zero spend', async () => {
  let calls = 0;
  await assert.rejects(collectCosts({ ...config, tagsVerified: false, getCostAndUsage: async () => { calls++; } }), /cost_tags_unverified/);
  assert.equal(calls, 0);
  const empty = await collectCosts({ ...config, getCostAndUsage: async () => ({ ResultsByTime: [] }) });
  assert.equal(empty.status, 'pending'); assert.equal(empty.amount, null);
});
test('mixed currencies, unexpected scope, repeated pages and duplicate groups fail closed', async () => {
  for (const response of [
    { ResultsByTime: [day('2026-09-01', '1'), day('2026-09-02', '1', 'audit', 'EUR')] },
    { ResultsByTime: [day('2026-09-01', '1', 'marketing')] },
    { ResultsByTime: [day('2026-09-01', '1'), day('2026-09-01', '1')] },
    { ResultsByTime: [], NextPageToken: 'loop' },
  ]) await assert.rejects(collectCosts({ ...config, getCostAndUsage: async () => response }), /cost_/);
});
test('cache read uses persisted snapshot; errors and stale timestamps remain visible', () => {
  const record = JSON.parse(JSON.stringify({ snapshot: { status: 'available', amount: '12', collectedAt: '2026-09-01T00:00:00.000Z' } }));
  assert.equal(viewCache(record, { now: new Date('2026-09-03') }).status, 'stale');
  assert.equal(viewCache({ ...record, error: 'cost_aws_unavailable' }, { now: new Date('2026-09-01') }).status, 'stale');
  assert.equal(viewCache(null).snapshot, null);
});
