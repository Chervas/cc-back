'use strict';

const crypto = require('node:crypto');
const { googleAdsSearchRows } = require('../lib/googleAdsSearchRows');
const { graphList } = require('./campaignWorkspaceMetaDestination.service');

const ACTIONS = ['pause_underperforming_ads', 'adjust_bids', 'negative_keywords', 'adjust_budget'];
const TTL_MS = 24 * 3600000;
const fail = code => { throw Object.assign(new Error(code), { code, status: 409 }); };
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,63}$/.test(value);
const positive = value => value != null && value !== '' && Number.isFinite(Number(value)) && Number(value) > 0;
const amount = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

function optimizationReference(input, write = false) {
  const keys = ['provider', 'account_id', 'campaign_id', ...(write ? ['expected_version'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))
    || !['google_ads', 'meta_ads'].includes(input.provider) || !id(input.account_id) || !id(input.campaign_id)
    || write && (!Number.isSafeInteger(input.expected_version) || input.expected_version < 1)) {
    throw Object.assign(new Error('invalid_workspace_optimization'), { code: 'invalid_workspace_optimization', status: 400 });
  }
  return { provider: input.provider, account_id: input.account_id, campaign_id: input.campaign_id };
}

function result(reference, currency, targets, reasons, now) {
  if (currency !== 'EUR') {
    targets = targets.filter(target => target.action !== 'adjust_budget');
    reasons.adjust_budget.push('budget_currency_unsupported');
  }
  targets.sort((a, b) => `${a.action}:${a.entity}:${a.group_id || ''}:${a.id}`.localeCompare(`${b.action}:${b.entity}:${b.group_id || ''}:${b.id}`));
  const actions = ACTIONS.map(action => ({ action, targets: targets.filter(target => target.action === action).length,
    reasons: [...new Set(reasons[action] || [])].sort() }));
  return { schema_version: 1, reference, currency, checked_at: now.toISOString(),
    expires_at: new Date(+now + TTL_MS).toISOString(), actions, targets,
    fingerprint: digest([reference, currency, targets, actions]) };
}

function pausableAds(ads, targets, resource) {
  const counts = new Map();
  for (const ad of ads) counts.set(ad.groupId, (counts.get(ad.groupId) || 0) + 1);
  for (const ad of ads) if (counts.get(ad.groupId) > 1) targets.push({ action: 'pause_underperforming_ads',
    entity: 'ad', id: ad.id, group_id: ad.groupId, resource: resource(ad), field: 'status', value: ad.status });
}

// Compatibility is not authorization or a recommendation. Only allowlisted metadata is retained.
async function inspectGoogleOptimization({ reference, accessToken, loginCustomerId, read = googleAdsSearchRows, now = new Date() }) {
  optimizationReference(reference);
  if (reference.provider !== 'google_ads') fail('workspace_optimization_provider_mismatch');
  const account = reference.account_id; const campaignId = reference.campaign_id;
  const campaignResource = `customers/${account}/campaigns/${campaignId}`;
  const deadline = Date.now() + 45000;
  const search = async query => {
    const remaining = deadline - Date.now();
    if (remaining < 1000) fail('workspace_optimization_timeout');
    const rows = await read({ customerId: account, accessToken, loginCustomerId, query: `${query} LIMIT 2001`, maxPages: 5, timeoutMs: remaining });
    if (!Array.isArray(rows) || rows.length > 2000 || rows.some(row => String(row.customer?.id) !== account
      || String(row.campaign?.id) !== campaignId)) fail('workspace_optimization_incomplete');
    return rows;
  };
  const rows = await search(`SELECT customer.id, customer.currency_code, campaign.id, campaign.status,
    campaign.experiment_type, campaign.advertising_channel_type, campaign.bidding_strategy, campaign.bidding_strategy_type,
    campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas,
    campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas,
    campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.period,
    campaign_budget.explicitly_shared, campaign_budget.reference_count
    FROM campaign WHERE campaign.id = ${campaignId} AND campaign.status != 'REMOVED'`);
  if (rows.length !== 1) fail('workspace_optimization_campaign_unavailable');
  const campaign = rows[0].campaign; const budget = rows[0].campaignBudget || {};
  const currency = rows[0].customer.currencyCode;
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) fail('workspace_optimization_incomplete');
  const reasons = Object.fromEntries(ACTIONS.map(action => [action, []])); const targets = [];
  const supported = ['SEARCH', 'PERFORMANCE_MAX'].includes(campaign.advertisingChannelType);
  const active = campaign.status === 'ENABLED';
  const base = campaign.experimentType === 'BASE';
  if (!active || !base || !supported) {
    for (const action of ACTIONS) reasons[action].push(!active ? 'campaign_inactive' : !base ? 'experiment_campaign' : 'campaign_type_unsupported');
    return result(reference, currency, targets, reasons, now);
  }
  const groups = campaign.advertisingChannelType === 'SEARCH' ? await search(`SELECT customer.id, campaign.id,
    ad_group.id, ad_group.status, ad_group.cpc_bid_micros FROM ad_group
    WHERE campaign.id = ${campaignId} AND ad_group.status != 'REMOVED'`) : [];
  const groupIds = new Set();
  for (const row of groups) {
    if (!id(String(row.adGroup?.id)) || groupIds.has(String(row.adGroup.id))) fail('workspace_optimization_incomplete');
    groupIds.add(String(row.adGroup.id));
  }
  const ads = campaign.advertisingChannelType === 'SEARCH' ? await search(`SELECT customer.id, campaign.id,
    ad_group.id, ad_group.status, ad_group_ad.ad.id, ad_group_ad.status FROM ad_group_ad
    WHERE campaign.id = ${campaignId} AND ad_group_ad.status != 'REMOVED' AND ad_group.status != 'REMOVED'`) : [];
  const adKeys = new Set();
  for (const row of ads) {
    const key = `${row.adGroup?.id}:${row.adGroupAd?.ad?.id}`;
    if (!id(String(row.adGroupAd?.ad?.id)) || !groupIds.has(String(row.adGroup?.id)) || adKeys.has(key)) fail('workspace_optimization_incomplete');
    adKeys.add(key);
  }
  pausableAds(ads.filter(row => row.adGroupAd.status === 'ENABLED' && row.adGroup.status === 'ENABLED')
    .map(row => ({ id: String(row.adGroupAd.ad.id), groupId: String(row.adGroup.id), status: row.adGroupAd.status })), targets,
  ad => `customers/${account}/adGroupAds/${ad.groupId}~${ad.id}`);
  if (!targets.length) reasons.pause_underperforming_ads.push(campaign.advertisingChannelType === 'PERFORMANCE_MAX' ? 'asset_groups_not_individual_ads' : 'no_alternative_active_ad');
  if (campaign.biddingStrategy) reasons.adjust_bids.push('shared_bidding_strategy');
  else {
    const schemes = {
      TARGET_CPA: ['target_cpa.target_cpa_micros', campaign.targetCpa?.targetCpaMicros, 'micros'],
      TARGET_ROAS: ['target_roas.target_roas', campaign.targetRoas?.targetRoas, 'ratio'],
      MAXIMIZE_CONVERSIONS: ['maximize_conversions.target_cpa_micros', campaign.maximizeConversions?.targetCpaMicros, 'micros'],
      MAXIMIZE_CONVERSION_VALUE: ['maximize_conversion_value.target_roas', campaign.maximizeConversionValue?.targetRoas, 'ratio'],
    };
    const scheme = schemes[campaign.biddingStrategyType];
    if (scheme && (scheme[2] === 'ratio' ? positive(scheme[1]) : amount(scheme[1]))) targets.push({ action: 'adjust_bids',
      entity: 'campaign', id: campaignId, resource: campaignResource, field: scheme[0], value: String(scheme[1]), unit: scheme[2], strategy: campaign.biddingStrategyType });
    else if (campaign.biddingStrategyType === 'MANUAL_CPC') {
      for (const row of groups) if (row.adGroup.status === 'ENABLED' && amount(row.adGroup.cpcBidMicros)) targets.push({ action: 'adjust_bids',
        entity: 'ad_group', id: String(row.adGroup.id), resource: `customers/${account}/adGroups/${row.adGroup.id}`,
        field: 'cpc_bid_micros', value: String(row.adGroup.cpcBidMicros), unit: 'micros', strategy: 'MANUAL_CPC' });
    }
    if (!targets.some(target => target.action === 'adjust_bids')) reasons.adjust_bids.push('no_existing_bid_target');
  }
  targets.push({ action: 'negative_keywords', entity: 'campaign', id: campaignId, resource: campaignResource, field: 'keyword', match_type: 'EXACT' });
  if (budget.explicitlyShared === true || Number(budget.referenceCount) !== 1) reasons.adjust_budget.push('shared_or_unknown_budget');
  else if (budget.period !== 'DAILY' || !amount(budget.amountMicros)
    || typeof budget.resourceName !== 'string' || !new RegExp(`^customers/${account}/campaignBudgets/[1-9][0-9]*$`).test(budget.resourceName)) reasons.adjust_budget.push('budget_type_unsupported');
  else targets.push({ action: 'adjust_budget', entity: 'campaign_budget', id: budget.resourceName.split('/').at(-1),
    resource: budget.resourceName, field: 'amount_micros', value: String(budget.amountMicros), unit: 'micros' });
  return result(reference, currency, targets, reasons, now);
}

async function inspectMetaOptimization({ reference, accessToken, read = require('../lib/metaClient').metaGet, now = new Date() }) {
  optimizationReference(reference);
  if (reference.provider !== 'meta_ads') fail('workspace_optimization_provider_mismatch');
  const account = reference.account_id; const campaignId = reference.campaign_id;
  const deadline = Date.now() + 45000;
  const get = (path, options = {}) => {
    const remaining = deadline - Date.now();
    if (remaining < 1000) fail('workspace_optimization_timeout');
    return read(path, { ...options, accessToken, maxRetries: 0, timeout: Math.min(8000, remaining),
      sensitivePayload: true, source: 'campaign_workspace', operation: 'optimization_compatibility' });
  };
  const permissions = await graphList('me/permissions', 'permission,status', accessToken, get, 3);
  if (!permissions.complete || !permissions.rows.some(row => row.permission === 'ads_management' && row.status === 'granted')
    || permissions.rows.some(row => row.permission === 'ads_management' && row.status !== 'granted')) fail('workspace_meta_permissions_required');
  const owner = (await get(`act_${account}`, { params: { fields: 'id,account_id,currency' } })).data;
  if (owner?.id !== `act_${account}` || owner.account_id !== account || !/^[A-Z]{3}$/.test(owner.currency || '')) fail('workspace_optimization_incomplete');
  const campaign = (await get(campaignId, { params: { fields: 'id,account_id,status,effective_status,buying_type,daily_budget,lifetime_budget,bid_strategy' } })).data;
  if (campaign?.id !== campaignId || campaign.account_id !== account) fail('workspace_optimization_incomplete');
  const reasons = Object.fromEntries(ACTIONS.map(action => [action, []])); const targets = [];
  reasons.negative_keywords.push('google_only');
  if (campaign.status !== 'ACTIVE' || campaign.effective_status !== 'ACTIVE' || campaign.buying_type !== 'AUCTION') {
    for (const action of ACTIONS.filter(action => action !== 'negative_keywords')) reasons[action].push(campaign.status !== 'ACTIVE'
      || campaign.effective_status !== 'ACTIVE' ? 'campaign_inactive' : 'campaign_type_unsupported');
    return result(reference, owner.currency, targets, reasons, now);
  }
  const list = await graphList(`${campaignId}/adsets`, 'id,account_id,campaign_id,status,effective_status,bid_strategy,bid_amount,bid_constraints,daily_budget,lifetime_budget', accessToken, get, 20);
  const ads = await graphList(`${campaignId}/ads`, 'id,account_id,campaign_id,adset_id,status,effective_status', accessToken, get, 20);
  const groups = new Map(); const adIds = new Set();
  if (!list.complete || !ads.complete || list.rows.length > 2000 || ads.rows.length > 2000) fail('workspace_optimization_incomplete');
  for (const row of list.rows) {
    if (!id(row.id) || row.account_id !== account || row.campaign_id !== campaignId || groups.has(row.id)) fail('workspace_optimization_incomplete');
    groups.set(row.id, row);
  }
  for (const row of ads.rows) {
    if (!id(row.id) || row.account_id !== account || row.campaign_id !== campaignId || !groups.has(row.adset_id) || adIds.has(row.id)) fail('workspace_optimization_incomplete');
    adIds.add(row.id);
  }
  const active = row => row.status === 'ACTIVE' && row.effective_status === 'ACTIVE';
  pausableAds(ads.rows.filter(row => active(row) && active(groups.get(row.adset_id)))
    .map(row => ({ id: row.id, groupId: row.adset_id, status: row.status })), targets, ad => ad.id);
  if (!targets.length) reasons.pause_underperforming_ads.push('no_alternative_active_ad');
  for (const group of list.rows.filter(active)) {
    const strategy = group.bid_strategy || campaign.bid_strategy;
    if (['COST_CAP', 'LOWEST_COST_WITH_BID_CAP'].includes(strategy) && amount(group.bid_amount)) targets.push({ action: 'adjust_bids',
      entity: 'ad_set', id: group.id, resource: group.id, field: 'bid_amount', value: String(group.bid_amount), unit: 'minor', strategy });
    else if (strategy === 'LOWEST_COST_WITH_MIN_ROAS' && amount(group.bid_constraints?.roas_average_floor)
      && Object.keys(group.bid_constraints).every(key => key === 'roas_average_floor')) targets.push({ action: 'adjust_bids',
      entity: 'ad_set', id: group.id, resource: group.id, field: 'bid_constraints.roas_average_floor', value: String(group.bid_constraints.roas_average_floor), unit: 'roas_10000', strategy });
    else reasons.adjust_bids.push('no_existing_bid_target');
  }
  if (!list.rows.some(active)) reasons.adjust_bids.push('no_active_ad_sets');
  if (amount(campaign.lifetime_budget)) reasons.adjust_budget.push('budget_type_unsupported');
  else if (amount(campaign.daily_budget)) targets.push({ action: 'adjust_budget', entity: 'campaign', id: campaignId,
    resource: campaignId, field: 'daily_budget', value: String(campaign.daily_budget), unit: 'minor' });
  else for (const group of list.rows.filter(active)) {
    if (!amount(group.lifetime_budget) && amount(group.daily_budget)) targets.push({ action: 'adjust_budget', entity: 'ad_set', id: group.id,
      resource: group.id, field: 'daily_budget', value: String(group.daily_budget), unit: 'minor' });
    else reasons.adjust_budget.push('budget_type_unsupported');
  }
  if (!targets.some(target => target.action === 'adjust_budget')) reasons.adjust_budget.push('no_daily_budget');
  return result(reference, owner.currency, targets, reasons, now);
}

module.exports = { ACTIONS, TTL_MS, digest, optimizationReference, inspectGoogleOptimization, inspectMetaOptimization };
