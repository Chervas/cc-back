'use strict';
const CUSTOMER = '1234567890';
function targetRows(strategy = 'MAXIMIZE_CONVERSIONS', channel = 'PERFORMANCE_MAX', owner = CUSTOMER) {
  const cpa = ['TARGET_CPA', 'MAXIMIZE_CONVERSIONS'].includes(strategy);
  const [key, field] = { TARGET_CPA: ['targetCpa', 'targetCpaMicros'], MAXIMIZE_CONVERSIONS: ['maximizeConversions', 'targetCpaMicros'],
    TARGET_ROAS: ['targetRoas', 'targetRoas'], MAXIMIZE_CONVERSION_VALUE: ['maximizeConversionValue', 'targetRoas'] }[strategy];
  const customer = { id: CUSTOMER }; const campaign = `customers/${CUSTOMER}/campaigns/30`;
  const action = `customers/${owner}/conversionActions/90`; const custom = `customers/${owner}/customConversionGoals/80`;
  return {
    campaign: [{ customer: { ...customer, currencyCode: 'EUR', timeZone: 'Europe/Madrid', conversionTrackingSetting: { googleAdsConversionCustomer: `customers/${owner}` } },
      campaign: { id: '30', status: 'ENABLED', experimentType: 'BASE', advertisingChannelType: channel, biddingStrategyType: strategy,
        [key]: { [field]: cpa ? '20000000' : 4 } }, campaignBudget: { resourceName: `customers/${CUSTOMER}/campaignBudgets/70`,
        amountMicros: '50000000', period: 'DAILY', referenceCount: '1', explicitlyShared: false } }],
    ad_groups: [{ customer, campaign: { id: '30' }, adGroup: { id: '50' } }],
    config: [{ customer, conversionGoalCampaignConfig: { resourceName: `customers/${CUSTOMER}/conversionGoalCampaignConfigs/30`,
      campaign, goalConfigLevel: 'CAMPAIGN', customConversionGoal: custom } }],
    custom_goal: [{ customer, customConversionGoal: { resourceName: custom, status: 'ENABLED', conversionActions: [action] } }],
    goals: [{ customer, campaignConversionGoal: { campaign, category: 'QUALIFIED_LEAD', origin: 'WEBSITE', biddable: true } }],
    actions: [{ customer, conversionAction: { resourceName: action, ownerCustomer: `customers/${owner}`, status: 'ENABLED', category: 'QUALIFIED_LEAD',
      origin: 'WEBSITE', primaryForGoal: true, type: 'UPLOAD_CLICKS', countingType: 'ONE_PER_CLICK',
      attributionModelSettings: { attributionModel: 'GOOGLE_SEARCH_ATTRIBUTION_DATA_DRIVEN' }, clickThroughLookbackWindowDays: '30',
      viewThroughLookbackWindowDays: '1', valueSettings: { defaultValue: 25, defaultCurrencyCode: 'EUR' } } }],
    recommendations: [{ customer, recommendation: { resourceName: `customers/${CUSTOMER}/recommendations/rec-1`, campaign,
      type: cpa ? 'RAISE_TARGET_CPA' : 'LOWER_TARGET_ROAS', dismissed: false,
      [cpa ? 'raiseTargetCpaRecommendation' : 'lowerTargetRoasRecommendation']: { targetAdjustment: {
        currentAverageTargetMicros: cpa ? '20000000' : '4000000', recommendedTargetMultiplier: cpa ? 1.05 : 0.95 } } } }],
  };
}
function targetResponse(data, request) {
  const table = { campaign: 'campaign', ad_group: 'ad_groups', conversion_goal_campaign_config: 'config',
    custom_conversion_goal: 'custom_goal', campaign_conversion_goal: 'goals', conversion_action: 'actions', recommendation: 'recommendations' };
  const from = request.json.query.match(/FROM ([a-z_]+)\b/)?.[1];
  if (from === 'customer') return { results: [{ customer: structuredClone(data.campaign[0].customer) }] };
  if (!table[from]) throw Error('Unknown fixture query');
  return { results: structuredClone(data[table[from]]) };
}
module.exports = { targetRows, targetResponse, payload: section => ({ campaignId: '30', section, pageToken: null }) };
