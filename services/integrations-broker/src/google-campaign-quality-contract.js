'use strict';
const { schema } = require('./contracts');
const { fail } = require('./errors');
const MAX_CAMPAIGNS = 200;
const SECTIONS = Object.freeze(['metrics', 'existence', 'goals']);
const check = schema({ pageToken: { type: ['string', 'null'], maxLength: 4096 },
  campaignIds: { type: 'array', minItems: 1, maxItems: MAX_CAMPAIGNS, uniqueItems: true,
    items: { type: 'string', pattern: '^[1-9][0-9]{0,19}$' } },
  section: { enum: SECTIONS }, includeOptimizationScore: { type: 'boolean' } });
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const text = (value, max = 1024) => {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max || /[\x00-\x1f\x7f]/.test(value)) fail('provider_failed');
  return value;
};
const enumeration = value => { if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value)) fail('provider_failed'); return value; };
function number(value, integer = false, signed = false) {
  if (!['string', 'number'].includes(typeof value)
    || !(signed ? /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/ : /^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/).test(String(value))
    || !Number.isFinite(Number(value)) || Math.abs(Number(value)) > Number.MAX_SAFE_INTEGER
    || integer && !Number.isSafeInteger(Number(value))) fail('provider_failed');
  return value;
}
function resource(value, type, owner) {
  if (typeof value !== 'string' || !new RegExp(`^customers/${owner || '[0-9]{10}'}/${type}/[1-9][0-9]{0,19}$`).test(value)) fail('provider_failed');
  return value;
}
const optional = (source, key, target, project) => { if (source[key] !== undefined) target[key] = project(source[key]); };
function validate(payload) {
  check(payload);
  if (payload.section === 'goals' && payload.includeOptimizationScore !== false) fail('invalid_request');
  return payload;
}
function query(payload) {
  validate(payload); const { section, campaignIds, includeOptimizationScore } = payload;
  const campaign = ['customer.id', 'customer.currency_code', 'campaign.id', 'campaign.name', 'campaign.status',
    'campaign.advertising_channel_type', 'campaign.advertising_channel_sub_type', 'campaign.bidding_strategy_type',
    'campaign.bidding_strategy', 'campaign.primary_status', 'campaign.primary_status_reasons',
    ...(includeOptimizationScore ? ['campaign.optimization_score'] : []), 'campaign_budget.id', 'campaign_budget.name',
    'campaign_budget.status', 'campaign_budget.amount_micros', 'campaign_budget.total_amount_micros',
    'campaign_budget.delivery_method', 'campaign_budget.period'];
  const metrics = ['cost_micros', 'impressions', 'clicks', 'conversions', 'all_conversions', 'conversions_value', 'all_conversions_value'];
  const goals = ['customer.id', 'conversion_goal_campaign_config.resource_name', 'conversion_goal_campaign_config.campaign',
    'conversion_goal_campaign_config.custom_conversion_goal', 'conversion_goal_campaign_config.goal_config_level',
    'campaign.id', 'campaign.name', 'custom_conversion_goal.resource_name', 'custom_conversion_goal.name',
    'custom_conversion_goal.status', 'custom_conversion_goal.conversion_actions'];
  return `SELECT ${(section === 'goals' ? goals : [...campaign, ...(section === 'metrics' ? metrics.map(k => 'metrics.' + k) : [])]).join(', ')} FROM ${section === 'goals' ? 'conversion_goal_campaign_config' : 'campaign'} WHERE campaign.id IN (${campaignIds.join(', ')})${section === 'metrics' ? ' AND segments.date DURING LAST_30_DAYS' : ''} LIMIT ${campaignIds.length + 1}`;
}
function project(row, payload, account) {
  validate(payload); const c = row?.campaign;
  if (!plain(row) || row.customer?.id !== account.customerId || !plain(c) || !id(c.id)
    || !payload.campaignIds.includes(c.id)) fail('provider_failed');
  const result = { customer: { id: account.customerId }, campaign: { id: c.id, name: text(c.name) } };
  if (payload.section === 'goals') {
    const config = row.conversionGoalCampaignConfig;
    if (!plain(config) || config.resourceName !== `customers/${account.customerId}/conversionGoalCampaignConfigs/${c.id}`
      || config.campaign !== `customers/${account.customerId}/campaigns/${c.id}`
      || !['CAMPAIGN', 'CUSTOMER', 'UNKNOWN', 'UNSPECIFIED'].includes(config.goalConfigLevel)) fail('provider_failed');
    result.conversionGoalCampaignConfig = { resourceName: config.resourceName, campaign: config.campaign, goalConfigLevel: config.goalConfigLevel };
    const goal = row.customConversionGoal;
    if (config.customConversionGoal) {
      const ref = resource(config.customConversionGoal, 'customConversionGoals');
      const owner = ref.split('/')[1];
      if (!plain(goal) || goal.resourceName !== ref || !Array.isArray(goal.conversionActions)
        || goal.conversionActions.length > 2000 || new Set(goal.conversionActions).size !== goal.conversionActions.length) fail('provider_failed');
      result.conversionGoalCampaignConfig.customConversionGoal = ref;
      result.customConversionGoal = { resourceName: ref, name: text(goal.name), status: enumeration(goal.status),
        conversionActions: goal.conversionActions.map(value => resource(value, 'conversionActions', owner)) };
    } else if (config.customConversionGoal != null && config.customConversionGoal !== ''
      || goal !== undefined && (!plain(goal) || Object.keys(goal).length)) fail('provider_failed');
    return result;
  }
  if (!['ENABLED', 'PAUSED', 'REMOVED', 'UNKNOWN', 'UNSPECIFIED'].includes(c.status)
    || !plain(row.campaignBudget) || !id(row.campaignBudget.id) || !/^[A-Z]{3}$/.test(row.customer.currencyCode || '')) fail('provider_failed');
  result.customer.currencyCode = row.customer.currencyCode;
  result.campaign.status = c.status;
  for (const key of ['advertisingChannelType', 'advertisingChannelSubType', 'biddingStrategyType', 'primaryStatus']) optional(c, key, result.campaign, enumeration);
  optional(c, 'biddingStrategy', result.campaign, value => value === '' ? value : resource(value, 'biddingStrategies'));
  optional(c, 'primaryStatusReasons', result.campaign, value => {
    if (!Array.isArray(value) || value.length > 100) fail('provider_failed'); return value.map(enumeration);
  });
  if (payload.includeOptimizationScore && c.optimizationScore !== undefined && c.optimizationScore !== null) {
    const score = number(c.optimizationScore); if (Number(score) > 1) fail('provider_failed'); result.campaign.optimizationScore = score;
  }
  const b = row.campaignBudget; result.campaignBudget = { id: b.id };
  optional(b, 'name', result.campaignBudget, value => text(value));
  for (const key of ['status', 'deliveryMethod', 'period']) optional(b, key, result.campaignBudget, enumeration);
  for (const key of ['amountMicros', 'totalAmountMicros']) optional(b, key, result.campaignBudget, value => number(value, true));
  if (payload.section === 'metrics') {
    if (row.metrics !== undefined && !plain(row.metrics)) fail('provider_failed');
    result.metrics = {};
    for (const key of ['costMicros', 'impressions', 'clicks']) optional(row.metrics || {}, key, result.metrics, value => number(value, true));
    for (const key of ['conversions', 'allConversions', 'conversionsValue', 'allConversionsValue']) optional(row.metrics || {}, key, result.metrics, value => number(value, false, true));
  }
  return result;
}
module.exports = { MAX_CAMPAIGNS, SECTIONS, validate, query, project };
