'use strict';

const assert = require('node:assert/strict');
const { googleAdsSearchRows } = require('../../../lib/googleAdsSearchRows');
const { inspectGoogleTargetSnapshot } = require('../../../services/campaignWorkspaceGoogleTargetSnapshot.service');
const { bidFixture } = require('./campaign_workspace_bid.fixture');

function targetSnapshotFixture(strategy = 'MAXIMIZE_CONVERSIONS', channel = 'PERFORMANCE_MAX') {
  const cpa = ['TARGET_CPA', 'MAXIMIZE_CONVERSIONS'].includes(strategy);
  const scheme = { TARGET_CPA: ['targetCpa', 'targetCpaMicros'], MAXIMIZE_CONVERSIONS: ['maximizeConversions', 'targetCpaMicros'],
    TARGET_ROAS: ['targetRoas', 'targetRoas'], MAXIMIZE_CONVERSION_VALUE: ['maximizeConversionValue', 'targetRoas'] }[strategy];
  const reference = { provider: 'google_ads', account_id: '20', campaign_id: '30' };
  const customer = { id: '20', currencyCode: 'EUR', timeZone: 'Europe/Madrid', conversionTrackingSetting: { googleAdsConversionCustomer: 'customers/20' } };
  const state = { now: new Date('2026-09-11T12:00:00Z'), clock: 0, calls: [],
    metadata: [{ customer, campaign: { id: '30', status: 'ENABLED', experimentType: 'BASE', advertisingChannelType: channel,
      biddingStrategyType: strategy, [scheme[0]]: { [scheme[1]]: cpa ? '20000000' : 4 } }, campaignBudget: {
      resourceName: 'customers/20/campaignBudgets/70', amountMicros: '50000000', period: 'DAILY', referenceCount: '1', explicitlyShared: false } }],
    groups: [{ customer: { id: '20' }, campaign: { id: '30' }, adGroup: { id: '50' } }],
    config: [{ customer: { id: '20' }, conversionGoalCampaignConfig: { resourceName: 'customers/20/conversionGoalCampaignConfigs/30',
      campaign: 'customers/20/campaigns/30', goalConfigLevel: 'CUSTOMER' } }],
    custom: [{ customer: { id: '20' }, customConversionGoal: { resourceName: 'customers/20/customConversionGoals/80', status: 'ENABLED',
      conversionActions: ['customers/20/conversionActions/90'] } }],
    goals: [{ customer: { id: '20' }, campaignConversionGoal: { campaign: 'customers/20/campaigns/30',
      category: 'QUALIFIED_LEAD', origin: 'WEBSITE', biddable: true } }],
    actions: [{ customer: { id: '20' }, conversionAction: { resourceName: 'customers/20/conversionActions/90', ownerCustomer: 'customers/20',
      status: 'ENABLED', category: 'QUALIFIED_LEAD', origin: 'WEBSITE', primaryForGoal: true, type: 'UPLOAD_CLICKS',
      countingType: 'ONE_PER_CLICK', attributionModelSettings: { attributionModel: 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN' },
      clickThroughLookbackWindowDays: '30', viewThroughLookbackWindowDays: '1', valueSettings: { defaultValue: 25, defaultCurrencyCode: 'EUR' } } }],
    recommendations: [{ customer: { id: '20' }, recommendation: { resourceName: 'customers/20/recommendations/rec-1',
      campaign: 'customers/20/campaigns/30', type: cpa ? 'RAISE_TARGET_CPA' : 'LOWER_TARGET_ROAS', dismissed: false,
      [cpa ? 'raiseTargetCpaRecommendation' : 'lowerTargetRoasRecommendation']: { targetAdjustment: {
        currentAverageTargetMicros: cpa ? '20000000' : '4000000', recommendedTargetMultiplier: cpa ? 1.05 : 0.95 } } } }],
  };
  const table = { campaign: 'metadata', ad_group: 'groups', conversion_goal_campaign_config: 'config', custom_conversion_goal: 'custom',
    campaign_conversion_goal: 'goals', conversion_action: 'actions', recommendation: 'recommendations' };
  const request = async (method, path, options) => {
    assert.equal(method, 'POST'); assert.equal(path, 'customers/20/googleAds:search'); assert.equal(options.singleAttempt, true);
    assert.equal(options.waitNextHour, undefined); assert.ok(options.timeoutMs <= 10000);
    const name = table[options.data.query.match(/FROM ([a-z_]+)\b/)[1]]; assert.ok(name, options.data.query);
    state.calls.push({ name, query: options.data.query, page: options.data.pageToken });
    if (state.onRead) await state.onRead(name, options);
    if (state.error) throw state.error;
    return state.pageResponse ? state.pageResponse(name, options) : { results: structuredClone(state[name]) };
  };
  const options = { reference, accessToken: 'fixture-only', now: () => state.now, clock: () => state.clock,
    read: opts => googleAdsSearchRows({ ...opts, request }) };
  return { state, options, request, run: () => inspectGoogleTargetSnapshot(options),
    adjustment: () => state.recommendations[0].recommendation[cpa ? 'raiseTargetCpaRecommendation' : 'lowerTargetRoasRecommendation'].targetAdjustment };
}

function targetBidFixture(strategy = 'MAXIMIZE_CONVERSIONS', channel = 'PERFORMANCE_MAX') {
  const f = bidFixture(); const snapshot = targetSnapshotFixture(strategy, channel);
  const scheme = { TARGET_CPA: ['target_cpa.target_cpa_micros', 'micros'], MAXIMIZE_CONVERSIONS: ['maximize_conversions.target_cpa_micros', 'micros'],
    TARGET_ROAS: ['target_roas.target_roas', 'ratio'], MAXIMIZE_CONVERSION_VALUE: ['maximize_conversion_value.target_roas', 'ratio'] }[strategy];
  const target = { action: 'adjust_bids', entity: 'campaign', id: '30', resource: 'customers/20/campaigns/30', field: scheme[0], unit: scheme[1], strategy };
  f.state.setting.activation.optimization.authorization.campaigns[0].targets = [target];
  f.deps.googleRequest = snapshot.request;
  f.execution.state.remote = scheme[1] === 'micros' ? '20000000' : '4';
  f.execution.deps.providerDependencies = { inspectGoogle: async () => ({ reference: f.input.reference,
    currency: 'EUR', targets: [{ ...target, value: f.execution.state.remote }] }) };
  f.execution.deps.targetDependencies = { googleRequest: snapshot.request, clock: () => snapshot.state.clock };
  return { ...f, target, snapshot };
}

module.exports = { targetSnapshotFixture, targetBidFixture };
