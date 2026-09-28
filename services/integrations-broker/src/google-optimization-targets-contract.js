'use strict';
const { fail } = require('./errors');
const compatibility = require('./google-optimization-contract');
const MAX_ROWS = 2000;
const SECTIONS = Object.freeze(['campaign', 'ad_groups', 'config', 'custom_goal', 'goals', 'actions', 'recommendations']);
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
const optional = (source, key, target, project) => { if (source[key] !== undefined) target[key] = project(source[key]); };
const enumValue = value => { if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value)) fail('provider_failed'); return value; };
const boolean = value => { if (typeof value !== 'boolean') fail('provider_failed'); return value; };
const integer = value => { if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})$/.test(value)
  || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) fail('provider_failed'); return value; };
const decimal = value => { if (!['number', 'string'].includes(typeof value) || !/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,18})?$/.test(String(value))
  || !Number.isFinite(Number(value)) || Number(value) > Number.MAX_SAFE_INTEGER) fail('provider_failed'); return value; };
function resource(value, type, owner, empty = false) {
  if (empty && value === '') return value;
  if (typeof value !== 'string' || !new RegExp(`^customers/${owner || '[1-9][0-9]{0,19}'}/${type}/[1-9][0-9]{0,19}$`).test(value)) fail('provider_failed');
  return value;
}
function ownerResource(value) {
  if (typeof value !== 'string' || !/^customers\/[1-9][0-9]{0,19}$/.test(value)) fail('provider_failed'); return value;
}
function query({ section, campaignId }, account = {}) {
  const { customerId, conversionCustomerId, customGoalResource } = account;
  if (!SECTIONS.includes(section) || !id(campaignId) || !id(customerId)) fail('invalid_request');
  if (['actions', 'custom_goal'].includes(section) && !id(conversionCustomerId)) fail('invalid_request');
  if (section === 'custom_goal') resource(customGoalResource, 'customConversionGoals', conversionCustomerId);
  const queries = {
    campaign: `SELECT customer.id, customer.currency_code, customer.time_zone,
      customer.conversion_tracking_setting.google_ads_conversion_customer, campaign.id, campaign.status,
      campaign.experiment_type, campaign.advertising_channel_type, campaign.bidding_strategy, campaign.bidding_strategy_type,
      campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas, campaign.maximize_conversions.target_cpa_micros,
      campaign.maximize_conversion_value.target_roas, campaign_budget.resource_name, campaign_budget.amount_micros,
      campaign_budget.period, campaign_budget.explicitly_shared, campaign_budget.reference_count
      FROM campaign WHERE campaign.id = ${campaignId}`,
    ad_groups: `SELECT customer.id, campaign.id, ad_group.id, ad_group.target_cpa_micros, ad_group.target_roas
      FROM ad_group WHERE campaign.id = ${campaignId} AND ad_group.status = 'ENABLED'`,
    config: `SELECT customer.id, conversion_goal_campaign_config.resource_name, conversion_goal_campaign_config.campaign,
      conversion_goal_campaign_config.goal_config_level, conversion_goal_campaign_config.custom_conversion_goal
      FROM conversion_goal_campaign_config WHERE campaign.id = ${campaignId}`,
    custom_goal: `SELECT customer.id, custom_conversion_goal.resource_name, custom_conversion_goal.status,
      custom_conversion_goal.conversion_actions FROM custom_conversion_goal WHERE custom_conversion_goal.resource_name = '${customGoalResource}'`,
    goals: `SELECT customer.id, campaign_conversion_goal.campaign, campaign_conversion_goal.category,
      campaign_conversion_goal.origin, campaign_conversion_goal.biddable FROM campaign_conversion_goal WHERE campaign.id = ${campaignId}`,
    actions: `SELECT customer.id, conversion_action.resource_name, conversion_action.owner_customer,
      conversion_action.status, conversion_action.category, conversion_action.origin, conversion_action.primary_for_goal,
      conversion_action.type, conversion_action.counting_type, conversion_action.attribution_model_settings.attribution_model,
      conversion_action.click_through_lookback_window_days, conversion_action.view_through_lookback_window_days,
      conversion_action.value_settings.default_value, conversion_action.value_settings.default_currency_code,
      conversion_action.value_settings.always_use_default_value FROM conversion_action
      WHERE conversion_action.owner_customer = 'customers/${conversionCustomerId}'`,
    recommendations: `SELECT customer.id, recommendation.resource_name, recommendation.type,
      recommendation.campaign, recommendation.ad_group, recommendation.dismissed, recommendation.raise_target_cpa_recommendation,
      recommendation.lower_target_roas_recommendation FROM recommendation WHERE recommendation.campaign = 'customers/${customerId}/campaigns/${campaignId}'
      AND recommendation.type IN ('RAISE_TARGET_CPA', 'LOWER_TARGET_ROAS') AND recommendation.dismissed = FALSE`,
  };
  return `${queries[section].replace(/\s+/g, ' ')} LIMIT ${MAX_ROWS + 1}`;
}

// Cross-account conversion ownership is discovered through the granted ad account, never supplied by a caller.
async function resolveScope(payload, account, search) {
  if (!['actions', 'custom_goal'].includes(payload.section)) return account;
  const one = (raw, project) => {
    if (!plain(raw) || raw.error || raw.errors || raw.partialFailureError || raw.partial_failure_error
      || raw.nextPageToken || !Array.isArray(raw.results) || raw.results.length !== 1
      || raw.results[0]?.customer?.id !== account.customerId) fail('provider_failed');
    return project(raw.results[0]);
  };
  const owner = one(await search('SELECT customer.id, customer.conversion_tracking_setting.google_ads_conversion_customer FROM customer LIMIT 2'),
    row => ownerResource(row.customer.conversionTrackingSetting?.googleAdsConversionCustomer));
  const resolved = { ...account, conversionCustomerId: owner.split('/')[1] };
  if (payload.section === 'custom_goal') {
    const config = one(await search(query({ ...payload, section: 'config' }, account)),
      row => project(row, { ...payload, section: 'config' }, account).conversionGoalCampaignConfig);
    if (config.goalConfigLevel !== 'CAMPAIGN') fail('provider_failed');
    resolved.customGoalResource = resource(config.customConversionGoal, 'customConversionGoals', resolved.conversionCustomerId);
  }
  return resolved;
}

function project(row, payload, account) {
  const { section, campaignId } = payload; const { customerId } = account;
  if (!SECTIONS.includes(section) || !plain(row) || row.customer?.id !== customerId) fail('provider_failed');
  if (section === 'campaign') {
    const result = compatibility.project(row, payload, account);
    if (typeof row.customer.timeZone !== 'string' || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(row.customer.timeZone)) fail('provider_failed');
    result.customer.timeZone = row.customer.timeZone;
    result.customer.conversionTrackingSetting = { googleAdsConversionCustomer: ownerResource(row.customer.conversionTrackingSetting?.googleAdsConversionCustomer) };
    return result;
  }
  const result = { customer: { id: customerId } }; const campaign = `customers/${customerId}/campaigns/${campaignId}`;
  if (section === 'ad_groups') {
    if (row.campaign?.id !== campaignId || !id(row.adGroup?.id)) fail('provider_failed');
    result.campaign = { id: campaignId }; result.adGroup = { id: row.adGroup.id };
    optional(row.adGroup, 'targetCpaMicros', result.adGroup, integer); optional(row.adGroup, 'targetRoas', result.adGroup, decimal);
  } else if (section === 'config') {
    const source = row.conversionGoalCampaignConfig;
    if (!plain(source) || source.resourceName !== `customers/${customerId}/conversionGoalCampaignConfigs/${campaignId}`
      || source.campaign !== campaign) fail('provider_failed');
    result.conversionGoalCampaignConfig = { resourceName: source.resourceName, campaign, goalConfigLevel: enumValue(source.goalConfigLevel) };
    optional(source, 'customConversionGoal', result.conversionGoalCampaignConfig, value => resource(value, 'customConversionGoals', null, true));
  } else if (section === 'custom_goal') {
    const source = row.customConversionGoal;
    if (!plain(source) || !Array.isArray(source.conversionActions) || source.conversionActions.length > MAX_ROWS) fail('provider_failed');
    const name = resource(source.resourceName, 'customConversionGoals', account.conversionCustomerId);
    if (account.customGoalResource && name !== account.customGoalResource) fail('provider_failed');
    result.customConversionGoal = { resourceName: name, status: enumValue(source.status),
      conversionActions: source.conversionActions.map(value => resource(value, 'conversionActions', name.split('/')[1])) };
  } else if (section === 'goals') {
    const source = row.campaignConversionGoal;
    if (!plain(source) || source.campaign !== campaign) fail('provider_failed');
    result.campaignConversionGoal = { campaign, category: enumValue(source.category), origin: enumValue(source.origin) };
    optional(source, 'biddable', result.campaignConversionGoal, boolean);
  } else if (section === 'actions') {
    const source = row.conversionAction;
    if (!plain(source)) fail('provider_failed'); const owner = ownerResource(source.ownerCustomer).split('/')[1];
    if (account.conversionCustomerId && owner !== account.conversionCustomerId) fail('provider_failed');
    const action = { resourceName: resource(source.resourceName, 'conversionActions', owner), ownerCustomer: source.ownerCustomer,
      status: enumValue(source.status), category: enumValue(source.category), origin: enumValue(source.origin) };
    optional(source, 'primaryForGoal', action, boolean);
    for (const key of ['type', 'countingType']) optional(source, key, action, enumValue);
    for (const key of ['clickThroughLookbackWindowDays', 'viewThroughLookbackWindowDays']) optional(source, key, action, integer);
    optional(source, 'attributionModelSettings', action, value => {
      if (!plain(value)) fail('provider_failed'); const settings = {};
      optional(value, 'attributionModel', settings, enumValue); return settings;
    });
    optional(source, 'valueSettings', action, value => {
      if (!plain(value)) fail('provider_failed'); const settings = {};
      optional(value, 'defaultValue', settings, amount => { if (typeof amount !== 'number') fail('provider_failed'); return decimal(amount); });
      optional(value, 'defaultCurrencyCode', settings, currency => { if (currency !== '' && !/^[A-Z]{3}$/.test(currency || '')) fail('provider_failed'); return currency; });
      optional(value, 'alwaysUseDefaultValue', settings, boolean); return settings;
    });
    result.conversionAction = action;
  } else {
    const source = row.recommendation;
    if (!plain(source) || typeof source.resourceName !== 'string'
      || !new RegExp(`^customers/${customerId}/recommendations/[A-Za-z0-9_~-]{1,256}$`).test(source.resourceName)
      || source.campaign !== campaign || !['RAISE_TARGET_CPA', 'LOWER_TARGET_ROAS'].includes(source.type)) fail('provider_failed');
    const rec = { resourceName: source.resourceName, campaign, type: source.type };
    optional(source, 'adGroup', rec, value => resource(value, 'adGroups', customerId, true)); optional(source, 'dismissed', rec, boolean);
    const key = source.type === 'RAISE_TARGET_CPA' ? 'raiseTargetCpaRecommendation' : 'lowerTargetRoasRecommendation';
    const info = source[key]?.targetAdjustment;
    if (!plain(info)) fail('provider_failed');
    const adjustment = { currentAverageTargetMicros: integer(info.currentAverageTargetMicros), recommendedTargetMultiplier: decimal(info.recommendedTargetMultiplier) };
    optional(info, 'sharedSet', adjustment, value => resource(value, 'sharedSets', null, true));
    rec[key] = { targetAdjustment: adjustment }; result.recommendation = rec;
  }
  return result;
}
module.exports = { MAX_ROWS, SECTIONS, query, resolveScope, project };
