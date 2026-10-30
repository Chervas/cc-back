'use strict';
const { fail } = require('./errors');

const MAX_ROWS = 2000;
const SECTIONS = Object.freeze(['campaign', 'ad_groups', 'ads']);
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const plain = value => value && typeof value === 'object' && !Array.isArray(value);

// Compatibility metadata only. This operation cannot choose arbitrary fields or mutate advertising.
function query({ section, campaignId }, { customerId } = {}) {
  if (!SECTIONS.includes(section) || !id(campaignId) || typeof customerId !== 'string'
    || !/^[0-9]{1,20}$/.test(customerId) || /^0+$/.test(customerId)) fail('invalid_request');
  const queries = {
    campaign: `SELECT customer.id, customer.currency_code, campaign.id, campaign.status,
      campaign.experiment_type, campaign.advertising_channel_type, campaign.bidding_strategy, campaign.bidding_strategy_type,
      campaign.target_cpa.target_cpa_micros, campaign.target_roas.target_roas,
      campaign.maximize_conversions.target_cpa_micros, campaign.maximize_conversion_value.target_roas,
      campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.period,
      campaign_budget.explicitly_shared, campaign_budget.reference_count
      FROM campaign WHERE campaign.id = ${campaignId} AND campaign.status != 'REMOVED'`,
    ad_groups: `SELECT customer.id, campaign.id, ad_group.id, ad_group.status, ad_group.cpc_bid_micros
      FROM ad_group WHERE campaign.id = ${campaignId} AND ad_group.status != 'REMOVED'`,
    ads: `SELECT customer.id, campaign.id, ad_group.id, ad_group.status, ad_group_ad.ad.id, ad_group_ad.status,
      ad_group_ad.primary_status, ad_group_ad.policy_summary.approval_status FROM ad_group_ad
      WHERE campaign.id = ${campaignId} AND ad_group_ad.status != 'REMOVED' AND ad_group.status != 'REMOVED'`,
  };
  return `${queries[section].replace(/\s+/g, ' ')} LIMIT ${MAX_ROWS + 1}`;
}

function enumeration(value) {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value)) fail('provider_failed');
  return value;
}
function numeric(value, integer) {
  if (!['string', 'number'].includes(typeof value) || !/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(String(value))
    || !Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > Number.MAX_SAFE_INTEGER
    || integer && !Number.isSafeInteger(Number(value))) fail('provider_failed');
  return value;
}
function optional(source, key, target, project) {
  if (source[key] !== undefined) target[key] = project(source[key]);
}
function status(value) {
  if (!['ENABLED', 'PAUSED'].includes(value)) fail('provider_failed');
  return value;
}
function project(row, { section, campaignId }, { customerId }) {
  if (!SECTIONS.includes(section) || !plain(row) || row.customer?.id !== customerId
    || row.campaign?.id !== campaignId) fail('provider_failed');
  const result = { customer: { id: customerId }, campaign: { id: campaignId } };
  if (section === 'campaign') {
    if (!/^[A-Z]{3}$/.test(row.customer.currencyCode || '')) fail('provider_failed');
    result.customer.currencyCode = row.customer.currencyCode;
    result.campaign.status = status(row.campaign.status);
    for (const key of ['experimentType', 'advertisingChannelType', 'biddingStrategyType']) result.campaign[key] = enumeration(row.campaign[key]);
    optional(row.campaign, 'biddingStrategy', result.campaign, value => {
      if (value !== '' && (typeof value !== 'string' || !/^customers\/[0-9]{10}\/biddingStrategies\/[1-9][0-9]{0,19}$/.test(value))) fail('provider_failed');
      return value;
    });
    for (const [key, field, integer] of [['targetCpa', 'targetCpaMicros', true], ['targetRoas', 'targetRoas', false],
      ['maximizeConversions', 'targetCpaMicros', true], ['maximizeConversionValue', 'targetRoas', false]]) {
      optional(row.campaign, key, result.campaign, value => {
        if (!plain(value)) fail('provider_failed');
        const projected = {}; optional(value, field, projected, amount => numeric(amount, integer)); return projected;
      });
    }
    if (row.campaignBudget !== undefined && !plain(row.campaignBudget)) fail('provider_failed');
    const budget = row.campaignBudget || {}; result.campaignBudget = {};
    optional(budget, 'resourceName', result.campaignBudget, value => {
      if (typeof value !== 'string' || !new RegExp(`^customers/${customerId}/campaignBudgets/[1-9][0-9]{0,19}$`).test(value)) fail('provider_failed');
      return value;
    });
    for (const key of ['amountMicros', 'referenceCount']) optional(budget, key, result.campaignBudget, value => numeric(value, true));
    optional(budget, 'period', result.campaignBudget, enumeration);
    optional(budget, 'explicitlyShared', result.campaignBudget, value => {
      if (typeof value !== 'boolean') fail('provider_failed'); return value;
    });
  } else {
    if (!id(row.adGroup?.id)) fail('provider_failed');
    result.adGroup = { id: row.adGroup.id, status: status(row.adGroup.status) };
    if (section === 'ad_groups') optional(row.adGroup, 'cpcBidMicros', result.adGroup, value => numeric(value, true));
    else {
      const ad = row.adGroupAd;
      if (!id(ad?.ad?.id) || ad.policySummary !== undefined && !plain(ad.policySummary)) fail('provider_failed');
      result.adGroupAd = { ad: { id: ad.ad.id }, status: status(ad.status), policySummary: {} };
      optional(ad, 'primaryStatus', result.adGroupAd, enumeration);
      optional(ad.policySummary || {}, 'approvalStatus', result.adGroupAd.policySummary, enumeration);
    }
  }
  return result;
}

module.exports = { MAX_ROWS, SECTIONS, query, project };
