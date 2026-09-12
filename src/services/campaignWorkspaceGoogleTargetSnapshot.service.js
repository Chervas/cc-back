'use strict';

const { digest, optimizationReference } = require('./campaignWorkspaceOptimizationCapabilities.service');
const { scopedTarget } = require('./campaignWorkspaceOptimizationAuthorization.service');
const { googleAdsSearchRows } = require('../lib/googleAdsSearchRows');

const TIMEOUT_MS = 45000;
const MAX_ROWS = 2000;
const fail = suffix => { throw Object.assign(new Error(`workspace_optimization_target_${suffix}`),
  { code: `workspace_optimization_target_${suffix}` }); };
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,63}$/.test(value);
const enumeration = value => typeof value === 'string' && /^[A-Z][A-Z_]{1,80}$/.test(value) && !['UNKNOWN', 'UNSPECIFIED'].includes(value);
const bool = value => { if (value !== undefined && typeof value !== 'boolean') fail('incomplete'); return value === true; };
const empty = value => value === undefined || value === '';
const resource = (value, owner, type) => typeof value === 'string' && new RegExp(`^customers/${owner}/${type}/[1-9][0-9]{0,63}$`).test(value);
const ordered = rows => rows.sort((a, b) => digest(a).localeCompare(digest(b)));
const BUSINESS_GOALS = ['PURCHASE', 'SUBMIT_LEAD_FORM', 'CONTACT', 'BOOK_APPOINTMENT', 'REQUEST_QUOTE',
  'PHONE_CALL_LEAD', 'IMPORTED_LEAD', 'QUALIFIED_LEAD', 'CONVERTED_LEAD'];

function supportedTarget(target, reference) {
  return reference?.provider === 'google_ads' && target?.action === 'adjust_bids' && target.entity === 'campaign'
    && scopedTarget(target, reference);
}

// Google target ratios and recommendation multipliers are compared exactly, never via rounded percentages.
function scaled(value) {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,6})?$/.test(text)) fail('incomplete');
  const [whole, fraction = ''] = text.split('.'); const result = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6, '0'));
  if (result <= 0n || result > BigInt(Number.MAX_SAFE_INTEGER) * 1000000n) fail('incomplete');
  return result;
}
function micros(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,15}$/.test(value) || BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)) fail('incomplete');
  return value;
}
function ratio(value) {
  const number = scaled(value); const whole = number / 1000000n; const fraction = String(number % 1000000n).padStart(6, '0').replace(/0+$/, '');
  return String(whole) + (fraction ? '.' + fraction : '');
}
function multiplier(value) {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : value;
  if (typeof text !== 'string' || !/^(0|[1-9][0-9]{0,3})(\.[0-9]{1,18})?$/.test(text) || Number(text) <= 0) fail('incomplete');
  return text.includes('.') ? text.replace(/0+$/, '').replace(/\.$/, '') : text;
}

async function readGoals(search, reference, conversionCustomer) {
  const account = reference.account_id; const campaign = `customers/${account}/campaigns/${reference.campaign_id}`;
  const configs = await search(`SELECT customer.id, conversion_goal_campaign_config.resource_name, conversion_goal_campaign_config.campaign,
    conversion_goal_campaign_config.goal_config_level, conversion_goal_campaign_config.custom_conversion_goal
    FROM conversion_goal_campaign_config WHERE campaign.id = ${reference.campaign_id}`);
  if (configs.length !== 1) fail('goals_required');
  const config = configs[0].conversionGoalCampaignConfig;
  if (config?.resourceName !== `customers/${account}/conversionGoalCampaignConfigs/${reference.campaign_id}` || config.campaign !== campaign
    || !['CUSTOMER', 'CAMPAIGN'].includes(config.goalConfigLevel)) fail('incomplete');
  let custom = null;
  if (!empty(config.customConversionGoal)) {
    if (config.goalConfigLevel !== 'CAMPAIGN' || !resource(config.customConversionGoal, conversionCustomer, 'customConversionGoals')) fail('goals_required');
    const rows = await search(`SELECT customer.id, custom_conversion_goal.resource_name, custom_conversion_goal.status,
      custom_conversion_goal.conversion_actions FROM custom_conversion_goal WHERE custom_conversion_goal.resource_name = '${config.customConversionGoal}'`);
    const goal = rows[0]?.customConversionGoal;
    if (rows.length !== 1 || goal?.resourceName !== config.customConversionGoal || goal.status !== 'ENABLED'
      || !Array.isArray(goal.conversionActions) || !goal.conversionActions.length || goal.conversionActions.length > MAX_ROWS
      || goal.conversionActions.some(value => !resource(value, conversionCustomer, 'conversionActions'))
      || new Set(goal.conversionActions).size !== goal.conversionActions.length) fail('goals_required');
    custom = { resource: goal.resourceName, actions: [...goal.conversionActions].sort() };
  }
  const goalRows = await search(`SELECT customer.id, campaign_conversion_goal.campaign,
    campaign_conversion_goal.category, campaign_conversion_goal.origin, campaign_conversion_goal.biddable
    FROM campaign_conversion_goal WHERE campaign.id = ${reference.campaign_id}`);
  const seen = new Set(); const goals = [];
  for (const row of goalRows) {
    const goal = row.campaignConversionGoal;
    if (!goal || goal.campaign !== campaign || !enumeration(goal.category) || !enumeration(goal.origin)
      || seen.has(`${goal.category}:${goal.origin}`)) fail('incomplete');
    seen.add(`${goal.category}:${goal.origin}`); goals.push({ category: goal.category, origin: goal.origin, biddable: bool(goal.biddable) });
  }
  const actionRows = await search(`SELECT customer.id, conversion_action.resource_name, conversion_action.owner_customer,
    conversion_action.status, conversion_action.category, conversion_action.origin, conversion_action.primary_for_goal,
    conversion_action.type, conversion_action.counting_type, conversion_action.attribution_model_settings.attribution_model,
    conversion_action.click_through_lookback_window_days, conversion_action.view_through_lookback_window_days,
    conversion_action.value_settings.default_value, conversion_action.value_settings.default_currency_code,
    conversion_action.value_settings.always_use_default_value FROM conversion_action
    WHERE conversion_action.owner_customer = 'customers/${conversionCustomer}'`);
  const actions = []; const actionIds = new Set();
  for (const row of actionRows) {
    const action = row.conversionAction;
    if (!action || !resource(action.resourceName, conversionCustomer, 'conversionActions') || action.ownerCustomer !== `customers/${conversionCustomer}`
      || actionIds.has(action.resourceName) || !['ENABLED', 'REMOVED', 'HIDDEN'].includes(action.status)
      || !enumeration(action.category) || !enumeration(action.origin)) fail('incomplete');
    actionIds.add(action.resourceName);
    const primary = bool(action.primaryForGoal);
    const standard = goals.some(goal => goal.biddable && goal.category === action.category && goal.origin === action.origin);
    // Custom goals can use secondary actions. They supplement, rather than erase, biddable standard goals.
    if (action.status !== 'ENABLED' || !(custom?.actions.includes(action.resourceName) || primary && standard)) continue;
    if (!BUSINESS_GOALS.includes(action.category) || !enumeration(action.type) || !enumeration(action.countingType)
      || !enumeration(action.attributionModelSettings?.attributionModel)) fail('goals_required');
    const clickDays = Number(action.clickThroughLookbackWindowDays); const viewDays = Number(action.viewThroughLookbackWindowDays ?? '0');
    const value = action.valueSettings || {}; const defaultValue = value.defaultValue === undefined ? 0 : value.defaultValue;
    const defaultCurrency = value.defaultCurrencyCode === undefined ? '' : value.defaultCurrencyCode;
    if (!Number.isSafeInteger(clickDays) || clickDays < 1 || clickDays > 90 || !Number.isSafeInteger(viewDays) || viewDays < 0 || viewDays > 90
      || typeof defaultValue !== 'number' || !Number.isFinite(defaultValue) || defaultValue < 0
      || typeof defaultCurrency !== 'string' || defaultCurrency !== '' && !/^[A-Z]{3}$/.test(defaultCurrency)) fail('incomplete');
    actions.push({ resource: action.resourceName, category: action.category, origin: action.origin, primary,
      type: action.type, counting: action.countingType, attribution: action.attributionModelSettings.attributionModel,
      click_days: clickDays, view_days: viewDays, default_value: defaultValue,
      default_currency: defaultCurrency, always_default_value: bool(value.alwaysUseDefaultValue) });
  }
  if (!actions.length || custom?.actions.some(name => !actions.some(action => action.resource === name))) fail('goals_required');
  return { config: config.resourceName, level: config.goalConfigLevel, conversion_customer: `customers/${conversionCustomer}`,
    custom, standard: ordered(goals), actions: ordered(actions) };
}

async function inspectGoogleTargetSnapshot({ reference, accessToken, loginCustomerId, read = googleAdsSearchRows,
  now = () => new Date(), clock = Date.now }) {
  optimizationReference(reference); if (reference.provider !== 'google_ads') fail('unsupported');
  const started = clock(); if (!Number.isFinite(started)) fail('timeout');
  const account = reference.account_id; const campaignId = reference.campaign_id;
  const search = async query => {
    const remaining = TIMEOUT_MS - (clock() - started); if (!Number.isFinite(remaining) || remaining < 1000 || remaining > TIMEOUT_MS) fail('timeout');
    const rows = await read({ customerId: account, accessToken, loginCustomerId, query: `${query} LIMIT ${MAX_ROWS + 1}`,
      maxPages: 5, timeoutMs: remaining });
    if (!Number.isFinite(clock() - started) || clock() - started < 0 || clock() - started >= TIMEOUT_MS) fail('timeout');
    if (!Array.isArray(rows) || rows.length > MAX_ROWS || rows.some(row => row.customer?.id !== account)) fail('incomplete');
    return rows;
  };
  const metadata = () => search(`SELECT customer.id, customer.currency_code, customer.time_zone,
    customer.conversion_tracking_setting.google_ads_conversion_customer, campaign.id, campaign.status,
    campaign.experiment_type, campaign.advertising_channel_type, campaign.bidding_strategy, campaign.bidding_strategy_type,
    campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas, campaign.maximize_conversions.target_cpa_micros,
    campaign.maximize_conversion_value.target_roas, campaign_budget.resource_name, campaign_budget.amount_micros,
    campaign_budget.period, campaign_budget.explicitly_shared, campaign_budget.reference_count
    FROM campaign WHERE campaign.id = ${campaignId}`);
  const rows = await metadata(); if (rows.length !== 1) fail('incomplete');
  const campaign = rows[0].campaign; const customer = rows[0].customer; const budget = rows[0].campaignBudget;
  if (campaign?.id !== campaignId || campaign.status !== 'ENABLED' || campaign.experimentType !== 'BASE'
    || !['SEARCH', 'PERFORMANCE_MAX'].includes(campaign.advertisingChannelType) || !empty(campaign.biddingStrategy)
    || customer.currencyCode !== 'EUR' || customer.timeZone !== 'Europe/Madrid') fail('unsupported');
  const conversionCustomerResource = customer.conversionTrackingSetting?.googleAdsConversionCustomer;
  if (typeof conversionCustomerResource !== 'string' || !/^customers\/[1-9][0-9]{0,63}$/.test(conversionCustomerResource)) fail('goals_required');
  const schemes = { TARGET_CPA: ['target_cpa.target_cpa_micros', campaign.targetCpa?.targetCpaMicros, 'micros'],
    MAXIMIZE_CONVERSIONS: ['maximize_conversions.target_cpa_micros', campaign.maximizeConversions?.targetCpaMicros, 'micros'],
    TARGET_ROAS: ['target_roas.target_roas', campaign.targetRoas?.targetRoas, 'ratio'],
    MAXIMIZE_CONVERSION_VALUE: ['maximize_conversion_value.target_roas', campaign.maximizeConversionValue?.targetRoas, 'ratio'] };
  const scheme = schemes[campaign.biddingStrategyType]; if (!scheme) fail('unsupported');
  const target = { action: 'adjust_bids', entity: 'campaign', id: campaignId, resource: `customers/${account}/campaigns/${campaignId}`,
    field: scheme[0], unit: scheme[2], strategy: campaign.biddingStrategyType };
  const before = scheme[2] === 'micros' ? micros(scheme[1]) : ratio(scheme[1]);
  if (!budget || !resource(budget.resourceName, account, 'campaignBudgets') || budget.period !== 'DAILY'
    || bool(budget.explicitlyShared) || budget.referenceCount !== '1') fail('budget_unsupported');
  const dailyBudget = { resource: budget.resourceName, amount_micros: micros(budget.amountMicros) };
  const readGroups = () => campaign.advertisingChannelType === 'SEARCH' ? search(`SELECT customer.id, campaign.id,
    ad_group.id, ad_group.target_cpa_micros, ad_group.target_roas FROM ad_group WHERE campaign.id = ${campaignId} AND ad_group.status = 'ENABLED'`) : [];
  const groups = await readGroups();
  const groupIds = new Set();
  for (const row of groups) {
    if (row.campaign?.id !== campaignId || !id(row.adGroup?.id) || groupIds.has(row.adGroup.id)) fail('incomplete');
    groupIds.add(row.adGroup.id);
    if (![undefined, '0'].includes(row.adGroup.targetCpaMicros) || ![undefined, 0].includes(row.adGroup.targetRoas)) fail('group_override');
  }
  const goals = await readGoals(search, reference, conversionCustomerResource.split('/')[1]);
  const recommendationRows = await search(`SELECT customer.id, recommendation.resource_name, recommendation.type,
    recommendation.campaign, recommendation.ad_group, recommendation.dismissed, recommendation.raise_target_cpa_recommendation,
    recommendation.lower_target_roas_recommendation FROM recommendation WHERE recommendation.campaign = '${target.resource}'
    AND recommendation.type IN ('RAISE_TARGET_CPA', 'LOWER_TARGET_ROAS') AND recommendation.dismissed = FALSE`);
  const recommendations = []; const seen = new Set();
  for (const row of recommendationRows) {
    const rec = row.recommendation;
    if (!rec || typeof rec.resourceName !== 'string' || !new RegExp(`^customers/${account}/recommendations/[A-Za-z0-9_~-]{1,256}$`).test(rec.resourceName)
      || rec.campaign !== target.resource || !['RAISE_TARGET_CPA', 'LOWER_TARGET_ROAS'].includes(rec.type)
      || seen.has(rec.resourceName) || bool(rec.dismissed)) fail('incomplete');
    seen.add(rec.resourceName);
    const info = (rec.type === 'RAISE_TARGET_CPA' ? rec.raiseTargetCpaRecommendation : rec.lowerTargetRoasRecommendation)?.targetAdjustment;
    if (!info) fail('incomplete');
    if (!empty(rec.adGroup) || !empty(info.sharedSet)) continue;
    recommendations.push({ resource: rec.resourceName, type: rec.type, average_target_micros: micros(info.currentAverageTargetMicros),
      multiplier: multiplier(info.recommendedTargetMultiplier) });
  }
  const latestGoals = await readGoals(search, reference, conversionCustomerResource.split('/')[1]);
  const latestGroups = await readGroups();
  if (digest(latestGoals) !== digest(goals) || digest(ordered(latestGroups)) !== digest(ordered(groups))) fail('changed');
  const final = await metadata(); if (digest(final) !== digest(rows)) fail('changed');
  if (clock() - started >= TIMEOUT_MS) fail('timeout');
  const body = { schema_version: 1, reference, target, before, channel: campaign.advertisingChannelType,
    currency: 'EUR', time_zone: 'Europe/Madrid', budget: dailyBudget, goals, recommendations: ordered(recommendations),
    observed_at: now().toISOString(), source: 'google_ads_recommendation' };
  return { ...body, fingerprint: digest(body) };
}

const exactKeys = (value, names) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).sort().join(',') === [...names].sort().join(',');
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const instant = value => typeof value === 'string' && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;

function verifyTargetSnapshot(snapshot) {
  if (!exactKeys(snapshot, ['schema_version', 'reference', 'target', 'before', 'channel', 'currency', 'time_zone', 'budget', 'goals',
    'recommendations', 'observed_at', 'source', 'fingerprint'])) fail('incomplete');
  const { fingerprint, ...body } = snapshot;
  optimizationReference(snapshot.reference);
  if (!hash(fingerprint) || digest(body) !== fingerprint || snapshot.schema_version !== 1 || !supportedTarget(snapshot.target, snapshot.reference)
    || snapshot.source !== 'google_ads_recommendation' || snapshot.currency !== 'EUR' || snapshot.time_zone !== 'Europe/Madrid'
    || !['SEARCH', 'PERFORMANCE_MAX'].includes(snapshot.channel) || !instant(snapshot.observed_at)) fail('incomplete');
  const account = snapshot.reference.account_id; const goals = snapshot.goals;
  if (!exactKeys(snapshot.target, ['action', 'entity', 'id', 'resource', 'field', 'unit', 'strategy'])
    || (snapshot.target.unit === 'ratio' ? ratio(snapshot.before) : micros(snapshot.before)) !== snapshot.before
    || !exactKeys(snapshot.budget, ['resource', 'amount_micros']) || !resource(snapshot.budget.resource, account, 'campaignBudgets')) fail('incomplete');
  micros(snapshot.budget.amount_micros);
  if (!exactKeys(goals, ['config', 'level', 'conversion_customer', 'custom', 'standard', 'actions'])
    || goals.config !== `customers/${account}/conversionGoalCampaignConfigs/${snapshot.reference.campaign_id}`
    || !['CUSTOMER', 'CAMPAIGN'].includes(goals.level) || !/^customers\/[1-9][0-9]{0,63}$/.test(goals.conversion_customer || '')
    || !Array.isArray(goals.standard) || goals.standard.length > MAX_ROWS || !Array.isArray(goals.actions)
    || !goals.actions.length || goals.actions.length > MAX_ROWS) fail('incomplete');
  const owner = goals.conversion_customer.split('/')[1]; const pairs = new Set(); const actions = new Set();
  for (const goal of goals.standard) {
    if (!exactKeys(goal, ['category', 'origin', 'biddable']) || !enumeration(goal.category) || !enumeration(goal.origin)
      || typeof goal.biddable !== 'boolean' || pairs.has(`${goal.category}:${goal.origin}`)) fail('incomplete');
    pairs.add(`${goal.category}:${goal.origin}`);
  }
  if (goals.custom !== null && (!exactKeys(goals.custom, ['resource', 'actions']) || goals.level !== 'CAMPAIGN'
    || !resource(goals.custom.resource, owner, 'customConversionGoals') || !Array.isArray(goals.custom.actions)
    || !goals.custom.actions.length || goals.custom.actions.length > MAX_ROWS
    || new Set(goals.custom.actions).size !== goals.custom.actions.length)) fail('incomplete');
  for (const action of goals.actions) {
    if (!exactKeys(action, ['resource', 'category', 'origin', 'primary', 'type', 'counting', 'attribution', 'click_days', 'view_days',
      'default_value', 'default_currency', 'always_default_value']) || !resource(action.resource, owner, 'conversionActions')
      || actions.has(action.resource) || !BUSINESS_GOALS.includes(action.category) || !enumeration(action.origin)
      || typeof action.primary !== 'boolean' || !enumeration(action.type) || !enumeration(action.counting) || !enumeration(action.attribution)
      || !Number.isSafeInteger(action.click_days) || action.click_days < 1 || action.click_days > 90
      || !Number.isSafeInteger(action.view_days) || action.view_days < 0 || action.view_days > 90
      || typeof action.default_value !== 'number' || !Number.isFinite(action.default_value) || action.default_value < 0
      || typeof action.default_currency !== 'string' || action.default_currency !== '' && !/^[A-Z]{3}$/.test(action.default_currency)
      || typeof action.always_default_value !== 'boolean'
      || !(goals.custom?.actions.includes(action.resource) || action.primary && goals.standard.some(goal =>
        goal.biddable && goal.category === action.category && goal.origin === action.origin))) fail('goals_required');
    actions.add(action.resource);
  }
  if (goals.custom?.actions.some(name => !actions.has(name))) fail('goals_required');
  if (!Array.isArray(snapshot.recommendations) || snapshot.recommendations.length > MAX_ROWS) fail('incomplete');
  const recommendations = new Set();
  for (const rec of snapshot.recommendations) {
    if (!exactKeys(rec, ['resource', 'type', 'average_target_micros', 'multiplier'])
      || !new RegExp(`^customers/${account}/recommendations/[A-Za-z0-9_~-]{1,256}$`).test(rec.resource)
      || !['RAISE_TARGET_CPA', 'LOWER_TARGET_ROAS'].includes(rec.type) || recommendations.has(rec.resource)
      || multiplier(rec.multiplier) !== rec.multiplier) fail('incomplete');
    micros(rec.average_target_micros); recommendations.add(rec.resource);
  }
  return snapshot;
}

module.exports = { inspectGoogleTargetSnapshot, verifyTargetSnapshot, supportedTarget, scaled, ratio, multiplier, TIMEOUT_MS, MAX_ROWS };
