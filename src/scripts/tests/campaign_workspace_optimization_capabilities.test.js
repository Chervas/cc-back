'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { optimizationReference, inspectGoogleOptimization, inspectMetaOptimization } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');
const now = new Date('2026-09-11T10:00:00Z');
const googleReference = { provider: 'google_ads', account_id: '1234567890', campaign_id: '10' };
const metaReference = { provider: 'meta_ads', account_id: '20', campaign_id: '10' };
const count = (result, action) => result.actions.find(row => row.action === action).targets;
function googleFixture() {
  const identity = { customer: { id: '1234567890', currencyCode: 'EUR' }, campaign: { id: '10' } };
  const state = { calls: [], root: { ...identity, campaign: { id: '10', status: 'ENABLED', experimentType: 'BASE',
    advertisingChannelType: 'SEARCH', biddingStrategyType: 'MANUAL_CPC' }, campaignBudget: { resourceName: 'customers/1234567890/campaignBudgets/40',
    amountMicros: '20000000', period: 'DAILY', referenceCount: '1', explicitlyShared: false } },
    groups: [{ ...identity, adGroup: { id: '50', status: 'ENABLED', cpcBidMicros: '1500000' } }],
    ads: [1, 2].map(id => ({ ...identity, adGroup: { id: '50', status: 'ENABLED' }, adGroupAd: { ad: { id: String(id) }, status: 'ENABLED',
      primaryStatus: 'ELIGIBLE', policySummary: { approvalStatus: 'APPROVED' } } })) };
  const run = patch => inspectGoogleOptimization({ reference: googleReference, now, accessToken: 'private', read: async input => {
    state.calls.push(input); assert.match(input.query, /campaign.id = 10/); assert.match(input.query, /LIMIT 2001$/);
    assert.doesNotMatch(input.query, /mutate|conversion_action|user_list|lead_form_submission/);
    return /FROM ad_group_ad/.test(input.query) ? state.ads : /FROM ad_group\b/.test(input.query) ? state.groups : [state.root];
  }, ...patch });
  return { state, run };
}
function metaFixture() {
  const state = { calls: [], currency: 'EUR', permissions: [{ permission: 'ads_management', status: 'granted' }],
    campaign: { id: '10', account_id: '20', status: 'ACTIVE', effective_status: 'ACTIVE', buying_type: 'AUCTION' },
    groups: [{ id: '50', account_id: '20', campaign_id: '10', status: 'ACTIVE', effective_status: 'ACTIVE',
      bid_strategy: 'COST_CAP', bid_amount: '1500', daily_budget: '2000', lifetime_budget: '0' }],
    ads: [1, 2].map(id => ({ id: String(id), account_id: '20', campaign_id: '10', adset_id: '50', status: 'ACTIVE', effective_status: 'ACTIVE' })) };
  const run = patch => inspectMetaOptimization({ reference: metaReference, now, accessToken: 'private', read: async (path, options) => {
    state.calls.push({ path, options }); assert.equal(options.maxRetries, 0); assert.ok(options.timeout <= 8000);
    assert.doesNotMatch(path, /lead|pixel|conversion|creative/);
    if (path === 'act_20') return { data: { id: 'act_20', account_id: '20', currency: state.currency } };
    if (path === '10') return { data: state.campaign };
    return { data: { data: path === 'me/permissions' ? state.permissions : path.endsWith('/adsets') ? state.groups : state.ads,
      ...(state.paginated ? { paging: { next: 'https://untrusted.example/token', cursors: { after: 'same' } } } : {}) } };
  }, ...patch });
  return { state, run };
}

test('Google recognizes scoped Search bid, exact negative, individual ad and non-shared budget targets', async () => {
  const f = googleFixture(); const result = await f.run();
  assert.deepEqual(result.actions.map(row => row.targets), [2, 1, 1, 1]);
  assert.equal(result.targets.find(row => row.action === 'negative_keywords').match_type, 'EXACT');
  assert.ok(result.targets.every(row => row.resource.startsWith('customers/1234567890/')));
  assert.doesNotMatch(JSON.stringify(result), /private|conversionGoal|landing|audience/);
  assert.equal(result.expires_at, '2026-09-12T10:00:00.000Z'); assert.equal(f.state.calls.length, 3);
});
test('existing Google CPA/ROAS targets retain their strategy and do not create a target when absent', async () => {
  for (const [strategy, field, value] of [['TARGET_CPA', 'targetCpa', { targetCpaMicros: '10000000' }],
    ['MAXIMIZE_CONVERSIONS', 'maximizeConversions', { targetCpaMicros: '20000000' }],
    ['TARGET_ROAS', 'targetRoas', { targetRoas: 2.5 }], ['MAXIMIZE_CONVERSION_VALUE', 'maximizeConversionValue', { targetRoas: 3.5 }]]) {
    const f = googleFixture(); Object.assign(f.state.root.campaign, { biddingStrategyType: strategy, [field]: value });
    const result = await f.run(); const bid = result.targets.find(row => row.action === 'adjust_bids');
    assert.equal(bid.entity, 'campaign'); assert.equal(bid.strategy, strategy);
    delete f.state.root.campaign[field]; assert.equal(count(await f.run(), 'adjust_bids'), 0);
  }
});
test('PMax supports campaign negatives and an existing bid target, never pretends asset groups are individual ads', async () => {
  const f = googleFixture(); Object.assign(f.state.root.campaign, { advertisingChannelType: 'PERFORMANCE_MAX', biddingStrategyType: 'MAXIMIZE_CONVERSIONS', maximizeConversions: { targetCpaMicros: '12000000' } });
  const result = await f.run(); assert.deepEqual(result.actions.map(row => row.targets), [0, 1, 1, 1]);
  assert.equal(f.state.calls.length, 1);
});
test('Google cannot pause the last active ad or mutate a portfolio strategy/shared budget', async () => {
  const f = googleFixture(); f.state.ads[1].adGroupAd.status = 'PAUSED';
  f.state.root.campaign.biddingStrategy = 'customers/1234567890/biddingStrategies/8';
  f.state.root.campaignBudget.explicitlyShared = true;
  const result = await f.run(); assert.deepEqual(result.actions.map(row => row.targets), [0, 0, 1, 0]);
  f.state.root.campaignBudget.explicitlyShared = false; delete f.state.root.campaignBudget.referenceCount;
  assert.equal(count(await f.run(), 'adjust_budget'), 0);
});
test('Google pause compatibility requires two unrestricted approved ads, not just two enabled ads', async () => {
  for (const patch of [{ primaryStatus: 'NOT_ELIGIBLE' }, { primaryStatus: 'PENDING' }, { primaryStatus: 'LIMITED' },
    { primaryStatus: undefined }, { policySummary: { approvalStatus: 'DISAPPROVED' } },
    { policySummary: { approvalStatus: 'APPROVED_LIMITED' } }, { policySummary: { approvalStatus: 'AREA_OF_INTEREST_ONLY' } },
    { policySummary: {} }]) {
    const f = googleFixture(); Object.assign(f.state.ads[1].adGroupAd, patch);
    const result = await f.run(); assert.equal(count(result, 'pause_underperforming_ads'), 0, JSON.stringify(patch));
    assert.ok(result.actions[0].reasons.includes('no_alternative_active_ad'));
  }
  const f = googleFixture(); assert.equal(count(await f.run(), 'pause_underperforming_ads'), 2);
  const query = f.state.calls.find(call => call.query.includes('FROM ad_group_ad')).query;
  assert.match(query, /ad_group_ad.primary_status/); assert.match(query, /ad_group_ad.policy_summary.approval_status/);
});
test('Google pauses, experiments, unsupported channels and malformed/foreign identities never produce broad compatibility', async () => {
  for (const patch of [{ status: 'PAUSED' }, { experimentType: 'EXPERIMENT' }, { advertisingChannelType: 'SMART' }]) {
    const f = googleFixture(); Object.assign(f.state.root.campaign, patch); assert.ok((await f.run()).actions.every(row => row.targets === 0));
  }
  for (const mutate of [f => { f.state.ads[0].campaign = { id: '999' }; }, f => { f.state.groups.push(f.state.groups[0]); },
    f => { f.state.ads[0].adGroup.id = '999'; }, f => { f.state.root.customer = { id: '999' }; }, f => { f.state.ads = Array(2001).fill(f.state.ads[0]); }]) {
    const f = googleFixture(); mutate(f); await assert.rejects(f.run(), { code: 'workspace_optimization_incomplete' });
  }
});
test('Meta recognizes only the current ad-set bid target and its actual budget owner', async () => {
  const f = metaFixture(); const result = await f.run(); assert.deepEqual(result.actions.map(row => row.targets), [2, 1, 0, 1]);
  assert.equal(result.targets.find(row => row.action === 'adjust_budget').entity, 'ad_set');
  f.state.campaign.daily_budget = '5000'; const campaignBudget = (await f.run()).targets.filter(row => row.action === 'adjust_budget');
  assert.equal(campaignBudget.length, 1); assert.equal(campaignBudget[0].entity, 'campaign');
  assert.doesNotMatch(JSON.stringify(result), /private|audience|pixel|creative/);
});
test('Meta bid caps and minimum ROAS retain the original strategy; uncapped bidding is not rewritten', async () => {
  const f = metaFixture(); f.state.groups[0].bid_strategy = 'LOWEST_COST_WITH_BID_CAP';
  assert.equal(count(await f.run(), 'adjust_bids'), 1);
  f.state.groups[0].bid_strategy = 'LOWEST_COST_WITH_MIN_ROAS'; f.state.groups[0].bid_constraints = { roas_average_floor: '15000' };
  assert.equal((await f.run()).targets.find(row => row.action === 'adjust_bids').field, 'bid_constraints.roas_average_floor');
  f.state.groups[0].bid_constraints.future_constraint = 'preserve';
  assert.equal(count(await f.run(), 'adjust_bids'), 0);
  f.state.groups[0].bid_strategy = 'LOWEST_COST_WITHOUT_CAP'; assert.equal(count(await f.run(), 'adjust_bids'), 0);
});
test('Meta protects the final ad and excludes lifetime budgets and non-auction or inactive campaigns', async () => {
  const f = metaFixture(); f.state.ads.pop(); f.state.groups[0].lifetime_budget = '100000';
  const result = await f.run(); assert.equal(count(result, 'pause_underperforming_ads'), 0); assert.equal(count(result, 'adjust_budget'), 0);
  for (const patch of [{ buying_type: 'RESERVED' }, { effective_status: 'CAMPAIGN_PAUSED' }]) {
    Object.assign(f.state.campaign, patch); assert.ok((await f.run()).actions.every(row => row.targets === 0));
  }
});
test('Meta refuses partial pagination, missing ads_management, conflicting IDs and foreign parents', async () => {
  for (const mutate of [f => { f.state.paginated = true; }, f => { f.state.permissions = []; },
    f => { f.state.ads[0].account_id = '999'; }, f => { f.state.ads[0].adset_id = '999'; },
    f => { f.state.groups.push(f.state.groups[0]); }, f => { f.state.campaign.account_id = '999'; }]) {
    const f = metaFixture(); mutate(f); await assert.rejects(f.run());
    assert.ok(f.state.calls.every(row => !row.path.includes('untrusted')));
  }
});
test('reference schemas reject injected identifiers, extra properties and provider mismatches before I/O', async () => {
  for (const patch of [{ campaign_id: '1 OR 1=1' }, { token: 'private' }, { provider: 'tiktok' }, { account_id: '0' }]) {
    assert.throws(() => optimizationReference({ ...googleReference, ...patch }));
  }
  assert.throws(() => optimizationReference({ ...googleReference, expected_version: 0 }, true));
  await assert.rejects(googleFixture().run({ reference: metaReference }), { code: 'workspace_optimization_provider_mismatch' });
});

test('a euro monthly limit cannot authorize a budget in a different currency', async () => {
  for (const fixture of [googleFixture, metaFixture]) {
    const f = fixture();
    if (f.state.root) f.state.root.customer.currencyCode = 'USD';
    else f.state.currency = 'USD';
    const result = await f.run();
    assert.equal(result.currency, 'USD');
    assert.equal(count(result, 'adjust_budget'), 0);
    assert.ok(result.actions.find(row => row.action === 'adjust_budget').reasons.includes('budget_currency_unsupported'));
    assert.ok(count(result, 'adjust_bids') > 0);
  }
});
