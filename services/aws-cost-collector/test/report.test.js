'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { ACCOUNT, ROLE, BUDGET, collectReport, configFor, periodFor, safeError } = require('../src/report');
const { filterFor } = require('../src/costs');
const config = { accountId: ACCOUNT, roleArn: ROLE, environment: 'prod', month: '2026-09' };
function fixture() {
  const calls = [];
  const api = {
    identity: async () => ({ Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/clinicaclick-integrations-prod-cost-reader-role/fixture` }),
    listTags: async input => { calls.push(['tags', input]); return { CostAllocationTags: ['application', 'component', 'environment'].map(TagKey => ({ TagKey, Status: 'Active' })) }; },
    usage: async input => {
      calls.push(['usage', input]); const ResultsByTime = [];
      for (let d = Date.parse(input.TimePeriod.Start); d < Date.parse(input.TimePeriod.End); d += 86400000) {
        ResultsByTime.push({ TimePeriod: { Start: new Date(d).toISOString().slice(0, 10), End: new Date(d + 86400000).toISOString().slice(0, 10) },
          Estimated: true, Groups: [{ Keys: ['Amazon S3', 'component$audit'], Metrics: { UnblendedCost: { Amount: '0.1', Unit: 'USD' } } }] });
      }
      return { ResultsByTime };
    },
    forecast: async input => { calls.push(['forecast', input]); return { Total: { Amount: '4.5', Unit: 'USD' } }; },
    budget: async input => { calls.push(['budget', input]); return { Budget: { BudgetName: BUDGET, BudgetType: 'COST', TimeUnit: 'MONTHLY',
      BudgetLimit: { Amount: '60', Unit: 'USD' }, CostFilters: { TagKeyValue: ['application$clinicaclick'] } } }; },
  };
  return { api, calls };
}
test('wrong identity or arbitrary config cannot start billing queries', async () => {
  const { api, calls } = fixture(); api.identity = async () => ({ Account: ACCOUNT, Arn: 'arn:aws:iam::137819318729:root' });
  await assert.rejects(collectReport(config, api), /cost_identity_invalid/); assert.equal(calls.length, 0);
  for (const patch of [{ environment: 'dev' }, { roleArn: ROLE + '-other' }, { accountId: '000000000000' }, { secret: 'sentinel' }]) {
    assert.throws(() => configFor({ ...config, ...patch }), /cost_scope_invalid/);
  }
});
test('inactive or looping tag metadata prevents cost and forecast reads', async () => {
  for (const response of [{ CostAllocationTags: [] }, { CostAllocationTags: [], NextToken: 'loop' }]) {
    const { api, calls } = fixture(); api.listTags = async () => response;
    await assert.rejects(collectReport(config, api), /cost_(tags_unverified|pagination_invalid)/); assert.equal(calls.length, 0);
  }
});
test('real report contract scopes every query, keeps forecast separate and flags broader Budget', async () => {
  const { api, calls } = fixture(); const result = await collectReport(config, api, new Date('2026-09-03T02:00:00Z'));
  assert.equal(result.amount, '0.2'); assert.equal(result.forecast.amount, '4.5'); assert.equal(result.budget.amount, '60');
  assert.equal(result.budget.scopeMatches, false); assert.equal(result.budget.metricMatches, false);
  assert.equal(result.budget.hardLimit, false); assert.equal(result.budget.referenceMonth, '2026-09');
  const usage = calls.find(item => item[0] === 'usage')[1]; const forecast = calls.find(item => item[0] === 'forecast')[1];
  assert.deepEqual(usage.Filter, filterFor(config)); assert.deepEqual(forecast.Filter, usage.Filter);
  assert.deepEqual(forecast.TimePeriod, { Start: '2026-09-03', End: '2026-10-01' });
  assert.equal(forecast.Metric, 'UNBLENDED_COST'); assert.deepEqual(usage.Metrics, ['UnblendedCost']);
  assert.equal(result.invoice, false);
});
test('forecast and Budget errors leave amounts pending and redact SDK errors', async () => {
  const { api } = fixture(); const sentinel = 'PRIVATE_SENTINEL_DO_NOT_EMIT';
  api.forecast = api.budget = async () => { throw Error(sentinel); };
  const result = await collectReport(config, api, new Date('2026-09-03'));
  assert.equal(result.status, 'available'); assert.equal(result.forecast.amount, null); assert.equal(result.budget.amount, null);
  assert.equal(JSON.stringify(result).includes(sentinel), false); assert.equal(safeError(Error(sentinel)), 'cost_aws_unavailable');
});
test('previous month covers its full UTC range, excludes forecast, identifies current Budget reference', async () => {
  const { api, calls } = fixture(); const result = await collectReport({ ...config, month: '2026-08' }, api, new Date('2026-09-03'));
  assert.equal(result.amount, '3.1'); assert.deepEqual(result.period, { from: '2026-08-01', toExclusive: '2026-09-01' });
  assert.equal(result.forecast.status, 'not_applicable'); assert.equal(calls.filter(item => item[0] === 'forecast').length, 0);
  assert.equal(result.budget.referenceMonth, '2026-09');
});
test('first UTC day of month is pending without invented zero or empty usage request', async () => {
  const { api, calls } = fixture(); const result = await collectReport(config, api, new Date('2026-09-01T23:59:00Z'));
  assert.equal(result.amount, null); assert.equal(result.status, 'pending'); assert.equal(calls.filter(item => item[0] === 'usage').length, 0);
  assert.throws(() => periodFor('2026-10', new Date('2026-09-03')), /cost_period_invalid/);
});
test('only canonical matching Budget expression and metric qualify for comparison', async () => {
  const { api } = fixture(); const budget = (await api.budget({})).Budget;
  api.budget = async () => ({ Budget: { ...budget, FilterExpression: filterFor(config), Metrics: ['UnblendedCost'] } });
  const result = await collectReport(config, api, new Date('2026-09-03'));
  assert.equal(result.budget.scopeMatches, true); assert.equal(result.budget.metricMatches, true);
});
