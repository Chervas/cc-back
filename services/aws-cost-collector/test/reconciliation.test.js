'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ACCOUNT, ROLE, BUDGET, collectReconciledReport } = require('../src/report');
const { accountFilterFor, filterFor } = require('../src/costs');
const config = { accountId: ACCOUNT, roleArn: ROLE, environment: 'prod', month: '2026-09' };
const now = new Date('2026-09-03T00:00:00Z');
function fixture() {
  const calls = [];
  return { calls, api: {
    identity: async () => ({ Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/clinicaclick-platform-cost-collector-role/fixture` }),
    listTags: async input => { calls.push(['tags', input]); return { $metadata: { attempts: 1 }, CostAllocationTags: ['application','component','environment'].map(TagKey => ({ TagKey, Status: 'Active' })) }; },
    usage: async input => {
      calls.push(['usage', input]); const tagged = input.GroupBy.length === 2; const days = [];
      for (let d = Date.parse(input.TimePeriod.Start); d < Date.parse(input.TimePeriod.End); d += 86400000) days.push({
        TimePeriod: { Start: new Date(d).toISOString().slice(0,10), End: new Date(d + 86400000).toISOString().slice(0,10) }, Estimated: true,
        Groups: (tagged ? [['Amazon S3','audit','0.3']] : [['Amazon S3',null,'0.8'],['New AWS Service',null,'-0.1']]).map(([service, component, Amount]) => ({
          Keys: tagged ? [service, 'component$'+component] : [service], Metrics: { UnblendedCost: { Amount, Unit: 'USD' } } })),
      });
      return { $metadata: { attempts: 2 }, ResultsByTime: days };
    },
    forecast: async input => { calls.push(['forecast', input]); return { $metadata: { attempts: 1 }, Total: { Amount: '4', Unit: 'USD' } }; },
    budget: async () => ({ Budget: { BudgetName: BUDGET, BudgetType: 'COST', TimeUnit: 'MONTHLY', BudgetLimit: { Amount: '60', Unit: 'USD' } } }),
  } };
}
test('account service totals include untagged/new services and credits, separate from the unchanged tagged filter', async () => {
  const { api, calls } = fixture(); const result = await collectReconciledReport(config, api, now);
  assert.equal(result.version, 3); assert.equal(result.account.amount, '1.4'); assert.equal(result.attributed.amount, '0.6');
  assert.equal(result.account.collectionId, result.attributed.collectionId);
  const usage = calls.filter(([name]) => name === 'usage');
  assert.deepEqual(usage[0][1].Filter, accountFilterFor(config)); assert.deepEqual(usage[1][1].Filter, filterFor(config));
  assert.equal(usage[0][1].GroupBy.length, 1); assert.equal(result.account.rows[1].service, 'New AWS Service');
  assert.equal(result.collection.ceLogicalCalls, 5); assert.equal(result.collection.ceRequestAttemptsObserved, 7);
  assert.equal(result.collection.ceRequestAttemptUpperBound, 10); assert.equal(result.collection.dailyBatchRequestAttemptLimit, 20);
});
test('unverified tags keep account costs available without treating the attribution as zero', async () => {
  const { api } = fixture(); api.listTags = async () => ({ CostAllocationTags: [] });
  const result = await collectReconciledReport(config, api, now);
  assert.equal(result.account.status, 'available'); assert.equal(result.account.amount, '1.4');
  assert.equal(result.attributed, null); assert.equal(result.attributionError, 'cost_tags_unverified');
});
test('pagination cannot exceed five logical CE commands or ten SDK attempts per month', async () => {
  const { api } = fixture(); let calls = 0;
  api.usage = async () => ({ $metadata: { attempts: 2 }, ResultsByTime: [], NextPageToken: 'page-' + ++calls });
  await assert.rejects(collectReconciledReport(config, api, now), /cost_call_budget_exceeded/);
  assert.equal(calls, 5);
});
test('previous month has no forecast queries; first open UTC day remains pending, never invented zero', async () => {
  const past = fixture(); const result = await collectReconciledReport({ ...config, month: '2026-08' }, past.api, now);
  assert.equal(result.collection.ceLogicalCalls, 3); assert.equal(past.calls.filter(([name]) => name === 'forecast').length, 0);
  const first = fixture(); const pending = await collectReconciledReport(config, first.api, new Date('2026-09-01'));
  assert.equal(pending.account.amount, null); assert.equal(pending.account.status, 'pending');
  assert.equal(first.calls.filter(([name]) => name === 'usage').length, 0);
});
