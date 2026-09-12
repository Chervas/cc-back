'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { cents, budgetPeriod, inspectGoogleBudget, inspectMetaBudget } = require('../../services/campaignWorkspaceBudgetSnapshot.service');
const now = new Date('2026-09-11T12:00:00Z');
const reference = provider => ({ provider, account_id: '20', campaign_id: '30' });

function google() {
  const state = { meta: [{ customer: { id: '20', currencyCode: 'EUR', timeZone: 'Europe/Madrid' }, campaign: { id: '30', status: 'ENABLED' },
    campaignBudget: { resourceName: 'customers/20/campaignBudgets/50', amountMicros: '10000000', period: 'DAILY', explicitlyShared: false, referenceCount: '1' } }],
  cost: [{ customer: { id: '20' }, campaign: { id: '30' }, metrics: { costMicros: '3456789' } }], calls: [] };
  return { state, run: () => inspectGoogleBudget({ reference: reference('google_ads'), now, accessToken: 'fixture-token', read: async options => {
    state.calls.push(options); return /metrics.cost_micros/.test(options.query) ? state.cost : state.meta;
  } }) };
}
function meta() {
  const state = { owner: { id: 'act_20', account_id: '20', currency: 'EUR', timezone_name: 'Europe/Madrid' },
    campaign: { id: '30', account_id: '20', status: 'ACTIVE', effective_status: 'ACTIVE', daily_budget: '1000', lifetime_budget: '0' },
    groups: { data: [{ id: '50', account_id: '20', campaign_id: '30', status: 'ACTIVE', daily_budget: '400', lifetime_budget: '0' },
      { id: '51', account_id: '20', campaign_id: '30', status: 'ACTIVE', daily_budget: '600', lifetime_budget: '0' }] },
    insights: { data: [{ account_id: '20', campaign_id: '30', date_start: '2026-09-01', date_stop: '2026-09-11', spend: '3.47' }] }, calls: [] };
  return { state, run: () => inspectMetaBudget({ reference: reference('meta_ads'), now, accessToken: 'fixture-token', read: async (path, options) => {
    state.calls.push({ path, options }); return { data: ({ act_20: state.owner, 30: state.campaign, '30/adsets': state.groups, '30/insights': state.insights })[path] };
  } }) };
}

test('budget arithmetic uses exact decimal input and rounds fractional micros upwards', () => {
  assert.equal(cents('3.47', 'eur'), 347); assert.equal(cents('3456789', 'micros'), 346);
  assert.equal(cents('0', 'micros'), 0); assert.equal(cents('1', 'micros'), 1);
  for (const [value, unit] of [[3.47, 'eur'], ['3e2', 'eur'], ['-1', 'minor'], ['1.001', 'eur'], ['10000000000000000000000', 'micros'], ['01', 'minor']]) {
    assert.throws(() => cents(value, unit), /budget_incomplete/);
  }
});
test('budget month follows Madrid, including local midnight, leap years and DST', () => {
  assert.deepEqual(budgetPeriod(new Date('2026-08-31T22:00:00Z')), { month: '2026-09', start: '2026-09-01', end: '2026-09-01', remaining_days: 30 });
  assert.equal(budgetPeriod(new Date('2028-02-28T23:00:00Z')).remaining_days, 1);
  assert.equal(budgetPeriod(new Date('2026-03-28T23:30:00Z')).remaining_days, 3);
  assert.equal(budgetPeriod(new Date('2026-10-24T22:30:00Z')).remaining_days, 7);
});
test('Google snapshots metadata separately from complete unsegmented month costs', async () => {
  const h = google(); const result = await h.run();
  assert.equal(result.spent_cents, 346); assert.equal(result.resources[0].daily_cents, 1000);
  assert.equal(h.state.calls.length, 2); assert.match(h.state.calls[1].query, /BETWEEN '2026-09-01' AND '2026-09-11'/);
  assert.ok(h.state.calls.every(row => row.query.startsWith('SELECT') && row.maxPages === 2 && row.timeoutMs === 10000));
  assert.ok(!JSON.stringify(result).includes('fixture-token'));
  h.state.cost = []; assert.equal((await h.run()).spent_cents, 0);
  h.state.meta[0].campaign.status = 'PAUSED'; assert.equal((await h.run()).resources.length, 0);
});
test('Google rejects shared budgets, unsupported currencies/timezones and incomplete identities', async () => {
  for (const mutate of [h => { h.state.meta = []; }, h => { h.state.meta[0].customer.id = '99'; },
    h => { h.state.meta[0].customer.currencyCode = 'USD'; }, h => { h.state.meta[0].customer.timeZone = 'UTC'; },
    h => { h.state.meta[0].campaignBudget.explicitlyShared = true; }, h => { h.state.meta[0].campaignBudget.referenceCount = '2'; },
    h => { h.state.meta[0].campaignBudget.period = 'CUSTOM_PERIOD'; }, h => { h.state.cost[0].campaign.id = '99'; },
    h => { h.state.cost.push(h.state.cost[0]); }, h => { delete h.state.cost[0].metrics.costMicros; }]) {
    const h = google(); mutate(h); await assert.rejects(h.run(), /workspace_optimization_budget_/);
  }
});
test('Meta counts the real budget owner, not campaign plus ad-set budgets twice', async () => {
  const h = meta(); let result = await h.run();
  assert.equal(result.resources.length, 1); assert.equal(result.resources[0].resource, '30'); assert.equal(result.spent_cents, 347);
  assert.ok(!h.state.calls.some(row => row.path === '30/adsets'));
  h.state.campaign.daily_budget = '0'; result = await h.run();
  assert.equal(result.resources.length, 2); assert.equal(result.resources.reduce((total, row) => total + row.daily_cents, 0), 1000);
  h.state.groups.data[0].status = 'PAUSED'; assert.equal((await h.run()).resources.length, 1);
  assert.ok(h.state.calls.every(row => row.options.maxRetries === 0 && row.options.timeout <= 8000 && !/leads|permissions|subscribed_apps/.test(row.path)));
  assert.ok(!JSON.stringify(result).includes('fixture-token'));
});
test('Meta costs require complete account, campaign and date coverage, never a partial first page', async () => {
  for (const mutate of [h => { h.state.owner.account_id = '99'; }, h => { h.state.owner.currency = 'USD'; },
    h => { h.state.owner.timezone_name = 'America/New_York'; }, h => { h.state.campaign.lifetime_budget = '100000'; },
    h => { h.state.insights.paging = { next: 'untrusted-next' }; }, h => { h.state.insights.data[0].campaign_id = '99'; },
    h => { h.state.insights.data[0].date_start = '2026-08-31'; }, h => { h.state.insights.data[0].spend = null; },
    h => { h.state.campaign.daily_budget = '0'; h.state.groups.data.push(h.state.groups.data[0]); }]) {
    const h = meta(); mutate(h); await assert.rejects(h.run(), /workspace_optimization_budget_/);
  }
});
test('a Meta 190 during metadata stops before spending or other groups and does not try another token', async () => {
  const calls = [];
  await assert.rejects(inspectMetaBudget({ reference: reference('meta_ads'), accessToken: 'fixture-only', now, read: async path => {
    calls.push(path); throw { response: { status: 401, data: { error: { code: 190 } } } };
  } }));
  assert.deepEqual(calls, ['act_20']);
});
