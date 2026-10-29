'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { adsFixture, CUSTOMER, ASSET } = require('./google-ads-fixture.cjs');
const C = require('../src/google-ads-contract');
const Q = require('../src/google-campaign-quality-contract');
const input = (section = 'metrics', ids = ['1']) => ({ pageToken: null, campaignIds: ids, section, includeOptimizationScore: section !== 'goals' });
const quality = (id = '1') => ({ customer: { id: CUSTOMER, currencyCode: 'EUR' }, campaign: { id, name: 'Fictitious campaign', status: 'ENABLED',
  advertisingChannelType: 'SEARCH', advertisingChannelSubType: 'SEARCH_MOBILE_APP', biddingStrategyType: 'MAXIMIZE_CONVERSIONS',
  biddingStrategy: `customers/${CUSTOMER}/biddingStrategies/5`, primaryStatus: 'LIMITED', primaryStatusReasons: ['BUDGET_CONSTRAINED'], optimizationScore: 0.62 },
  campaignBudget: { id: '44', name: 'Fictitious budget', status: 'ENABLED', amountMicros: '25000000', totalAmountMicros: '0', deliveryMethod: 'STANDARD', period: 'DAILY' },
  metrics: { costMicros: '120500000', impressions: '4300', clicks: '210', conversions: 4.5, allConversions: 7, conversionsValue: 40, allConversionsValue: 70 } });
const goal = (id = '1', owner = CUSTOMER) => ({ customer: { id: CUSTOMER }, campaign: { id, name: 'Fictitious campaign' },
  conversionGoalCampaignConfig: { resourceName: `customers/${CUSTOMER}/conversionGoalCampaignConfigs/${id}`,
    campaign: `customers/${CUSTOMER}/campaigns/${id}`, customConversionGoal: `customers/${owner}/customConversionGoals/7`, goalConfigLevel: 'CAMPAIGN' },
  customConversionGoal: { resourceName: `customers/${owner}/customConversionGoals/7`, name: 'Fictitious custom goal', status: 'ENABLED',
    conversionActions: [`customers/${owner}/conversionActions/3`] } });
test('quality operation is read-only, explicitly granted, and generates fixed complete GAQL for all three sections', async t => {
  const f = adsFixture(t);
  assert.equal(f.engine.operations['google.ads.campaign_quality.read.v1'].effect, 'read');
  assert.equal(f.engine.operations['google.ads.campaign_quality.read.v1'].persistResult, false);
  for (const section of Q.SECTIONS) {
    f.state.response = { results: [section === 'goals' ? goal() : quality()] };
    const result = await f.execute('campaign_quality', input(section));
    assert.equal(result.data.results.length, 1);
    const query = f.state.calls.at(-1).json.query;
    assert.match(query, /^SELECT customer.id,/); assert.match(query, /WHERE campaign.id IN \(1\)/); assert.match(query, /LIMIT 2$/);
    assert.equal(/LAST_30_DAYS/.test(query), section === 'metrics');
    assert.equal(/metrics\.all_conversions_value/.test(query), section === 'metrics');
    if (section === 'goals') assert.match(query, /custom_conversion_goal.name, custom_conversion_goal.status, custom_conversion_goal.conversion_actions/);
    else for (const field of ['campaign.optimization_score', 'campaign_budget.name', 'campaign_budget.total_amount_micros', 'campaign_budget.period']) assert.ok(query.includes(field));
    assert.equal(f.state.calls.at(-1).path, `/v24/customers/${CUSTOMER}/googleAds:search`);
  }
});
test('new capability is never inherited from an old operation grant; foreign scope and query injection fail before secrets', async t => {
  const f = adsFixture(t);
  f.policy.grants[0].operations = f.policy.grants[0].operations.filter(op => op !== 'google.ads.campaign_quality.read.v1');
  const broker = f.make(f.store);
  const signed = f.signed(f.command('campaign_quality', input()));
  await assert.rejects(broker.execute(signed.raw, signed.headers), { code: 'scope_denied' });
  for (const body of [{ ...input(), query: 'SELECT * FROM customer' }, { ...input(), customerId: CUSTOMER },
    { ...input(), campaignIds: [] }, { ...input(), campaignIds: ['1 OR 1=1'] }, { ...input(), campaignIds: ['1', '1'] },
    { ...input(), campaignIds: Array.from({ length: 201 }, (_, i) => String(i + 1)) }, { ...input('goals'), includeOptimizationScore: true },
    { ...input(), section: 'mutate' }, { ...input(), includeOptimizationScore: 'true' }, { ...input(), startDate: '2020-01-01' }]) {
    assert.throws(() => C.validate('google.ads.campaign_quality.read.v1', body), { code: 'invalid_request' });
  }
  assert.equal(f.state.sdk.length, 0); assert.equal(f.state.calls.length, 0);
});
test('projected quality retains every required observation, exact metrics representation and only explicitly selected values', () => {
  const row = quality(); row.unreviewed = 'PRIVATE'; row.campaign.unreviewed = 'PRIVATE'; row.metrics.unreviewed = 1;
  const projected = C.projectPage('campaign_quality', { results: [row] }, input(), { customerId: CUSTOMER }).results[0];
  assert.deepEqual(projected.campaign, (({ unreviewed, ...rest }) => rest)(row.campaign));
  assert.deepEqual(projected.campaignBudget, row.campaignBudget); assert.deepEqual(projected.metrics, (({ unreviewed, ...rest }) => rest)(row.metrics));
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE|unreviewed/);
  row.campaign.optimizationScore = null; row.metrics = {};
  assert.equal(Object.hasOwn(Q.project(row, input(), { customerId: CUSTOMER }).campaign, 'optimizationScore'), false);
  assert.deepEqual(Q.project(row, input(), { customerId: CUSTOMER }).metrics, {});
  const exists = Q.project(quality(), input('existence'), { customerId: CUSTOMER }); assert.equal(Object.hasOwn(exists, 'metrics'), false);
  const unsigned = input(); unsigned.includeOptimizationScore = false;
  assert.equal(Object.hasOwn(Q.project(quality(), unsigned, { customerId: CUSTOMER }).campaign, 'optimizationScore'), false);
});
test('customer/campaign/config/custom-goal/action ownership and malformed values are rejected, including out-of-request IDs', () => {
  const mutations = [r => { r.customer.id = '9999999999'; }, r => { r.campaign.id = '2'; }, r => { r.campaign.name = 'bad\u0000'; },
    r => { r.campaign.optimizationScore = 1.1; }, r => { r.campaignBudget.amountMicros = '9007199254740992'; },
    r => { r.metrics.costMicros = -1; }, r => { r.metrics.clicks = 1.5; }, r => { r.campaign.biddingStrategy = 'https://example.invalid'; },
    r => { r.customer.currencyCode = 'xxx'; }];
  for (const mutate of mutations) { const row = quality(); mutate(row); assert.throws(() => Q.project(row, input(), { customerId: CUSTOMER }), { code: 'provider_failed' }); }
  for (const mutate of [r => { r.conversionGoalCampaignConfig.campaign = `customers/${CUSTOMER}/campaigns/2`; },
    r => { r.customConversionGoal.resourceName = `customers/${CUSTOMER}/customConversionGoals/8`; },
    r => { r.customConversionGoal.conversionActions = ['customers/9999999999/conversionActions/3']; },
    r => { r.customConversionGoal.conversionActions.push(r.customConversionGoal.conversionActions[0]); }]) {
    const row = goal(); mutate(row); assert.throws(() => Q.project(row, input('goals'), { customerId: CUSTOMER }), { code: 'provider_failed' });
  }
  // Cross-account conversion tracking is legitimate only through the config's returned linked resource, not caller input.
  assert.equal(Q.project(goal('1', '9876543210'), input('goals'), { customerId: CUSTOMER }).customConversionGoal.conversionActions[0], 'customers/9876543210/conversionActions/3');
});
test('overflow, duplicates, partial errors, malformed pagination and extra rows never become a partial successful snapshot', async t => {
  for (const raw of [{ results: [quality(), quality()] }, { results: [quality('2')] }, { results: [quality()], partialFailureError: {} },
    { results: [], nextPageToken: 'opaque' }, { results: [quality()], nextPageToken: 'more' }]) {
    const f = adsFixture(t); f.state.response = raw;
    await assert.rejects(f.execute('campaign_quality', input()), { code: 'provider_failed' });
  }
});
test('revocation during a real broker execution and foreign tenant prevent usable quality results', async t => {
  const f = adsFixture(t); f.state.response = { results: [quality()] };
  await assert.rejects(f.execute('campaign_quality', input(), { tenantRef: 'clinic:999' }));
  assert.equal(f.state.calls.length, 0);
  f.state.onRead = () => f.revoke();
  await assert.rejects(f.execute('campaign_quality', input()), { code: 'connection_blocked' });
  assert.equal(f.state.calls.length, 1);
  await assert.rejects(f.execute('campaign_quality', input()), { code: 'asset_revoked' });
  assert.equal(f.state.calls.length, 1);
});
test('200 campaigns fit one bounded request; no mutation operation or persistent result is introduced', async t => {
  const f = adsFixture(t); const ids = Array.from({ length: 200 }, (_, i) => String(i + 1));
  f.state.response = { results: ids.map(id => quality(id)) };
  const result = await f.execute('campaign_quality', input('metrics', ids));
  assert.equal(result.data.results.length, 200); assert.equal(result.data.nextPageToken, null); assert.equal(f.state.calls.length, 1);
  assert.match(f.state.calls[0].json.query, /LIMIT 201$/); assert.equal(C.rowLimit('campaign_quality', input('metrics', ids)), 200);
  assert.equal(Object.keys(f.engine.operations).filter(op => op.includes('campaign_quality')).join(','), 'google.ads.campaign_quality.read.v1');
});
