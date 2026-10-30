'use strict';
const { fail } = require('./errors');
const DAYS = 28;
const MAX_ADS = 2000;
const FAMILIES = Object.freeze(['optimization_performance', 'optimization_budget']);
const SECTIONS = Object.freeze({ optimization_performance: ['campaign', 'inventory', 'campaign_daily', 'ad_daily'],
  optimization_budget: ['campaign', 'month_cost'] });
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,19}$/.test(value);
const date = value => typeof value === 'string' && /^20\d\d-\d\d-\d\d$/.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const plain = value => value && typeof value === 'object' && !Array.isArray(value);
function validate(name, payload) {
  if (!FAMILIES.includes(name) || !SECTIONS[name].includes(payload.section) || !id(payload.campaignId)
    || !date(payload.startDate) || !date(payload.endDate) || payload.endDate < payload.startDate) fail('invalid_request');
  if (name === 'optimization_performance'
    ? Date.parse(payload.endDate) - Date.parse(payload.startDate) !== (DAYS - 1) * 86400000
    : !payload.startDate.endsWith('-01') || payload.startDate.slice(0, 7) !== payload.endDate.slice(0, 7)) fail('invalid_request');
}
function limit(name, { section } = {}) {
  if (!FAMILIES.includes(name) || !SECTIONS[name].includes(section)) fail('invalid_request');
  return name === 'optimization_budget' || section === 'campaign' ? 1
    : section === 'inventory' ? MAX_ADS : section === 'campaign_daily' ? DAYS : DAYS * MAX_ADS;
}
function query(name, payload) {
  validate(name, payload);
  const { section, campaignId, startDate, endDate } = payload;
  const campaign = `WHERE campaign.id = ${campaignId}`;
  const window = `${campaign} AND segments.date BETWEEN '${startDate}' AND '${endDate}'`;
  const statuses = "AND ad_group_ad.status IN ('ENABLED', 'PAUSED', 'REMOVED') AND ad_group.status IN ('ENABLED', 'PAUSED', 'REMOVED')";
  const queries = name === 'optimization_budget' ? {
    campaign: `SELECT customer.id, customer.currency_code, customer.time_zone, campaign.id, campaign.status,
      campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.period,
      campaign_budget.explicitly_shared, campaign_budget.reference_count FROM campaign ${campaign}`,
    month_cost: `SELECT customer.id, campaign.id, metrics.cost_micros FROM campaign ${window}`,
  } : {
    campaign: `SELECT customer.id, customer.currency_code, customer.time_zone, campaign.id,
      campaign.status, campaign.experiment_type, campaign.advertising_channel_type FROM campaign ${campaign}`,
    inventory: `SELECT customer.id, campaign.id, ad_group.id, ad_group.status, ad_group_ad.ad.id,
      ad_group_ad.status, ad_group_ad.primary_status, ad_group_ad.policy_summary.approval_status
      FROM ad_group_ad ${campaign} ${statuses}`,
    campaign_daily: `SELECT customer.id, campaign.id, segments.date, metrics.clicks, metrics.cost_micros FROM campaign ${window}`,
    ad_daily: `SELECT customer.id, campaign.id, ad_group.id, ad_group_ad.ad.id, segments.date, metrics.clicks,
      metrics.cost_micros FROM ad_group_ad ${window} ${statuses}`,
  };
  return `${queries[section].replace(/\s+/g, ' ')} LIMIT ${limit(name, payload) + 1}`;
}
function enumeration(value) {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(value)) fail('provider_failed');
  return value;
}
function integer(value, max = BigInt(Number.MAX_SAFE_INTEGER)) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,21})$/.test(value) || BigInt(value) > max) fail('provider_failed');
  return value;
}
function status(value) {
  if (!['ENABLED', 'PAUSED', 'REMOVED'].includes(value)) fail('provider_failed'); return value;
}
const optional = (source, key, target, project) => { if (source[key] !== undefined) target[key] = project(source[key]); };
function project(name, row, payload, { customerId }) {
  validate(name, payload);
  if (!plain(row) || row.customer?.id !== customerId || row.campaign?.id !== payload.campaignId) fail('provider_failed');
  const result = { customer: { id: customerId }, campaign: { id: payload.campaignId } };
  const { section } = payload;
  if (section === 'campaign') {
    if (!/^[A-Z]{3}$/.test(row.customer.currencyCode || '') || typeof row.customer.timeZone !== 'string'
      || !/^[A-Za-z0-9_+\-/]{1,64}$/.test(row.customer.timeZone)) fail('provider_failed');
    Object.assign(result.customer, { currencyCode: row.customer.currencyCode, timeZone: row.customer.timeZone });
    result.campaign.status = status(row.campaign.status);
    if (name === 'optimization_performance') {
      result.campaign.experimentType = enumeration(row.campaign.experimentType);
      result.campaign.advertisingChannelType = enumeration(row.campaign.advertisingChannelType);
    } else {
      if (row.campaignBudget !== undefined && !plain(row.campaignBudget)) fail('provider_failed');
      const budget = row.campaignBudget || {}; result.campaignBudget = {};
      optional(budget, 'resourceName', result.campaignBudget, value => {
        if (typeof value !== 'string' || !new RegExp(`^customers/${customerId}/campaignBudgets/[1-9][0-9]{0,19}$`).test(value)) fail('provider_failed');
        return value;
      });
      optional(budget, 'amountMicros', result.campaignBudget, value => integer(value, BigInt(Number.MAX_SAFE_INTEGER) * 10000n));
      optional(budget, 'referenceCount', result.campaignBudget, integer);
      optional(budget, 'period', result.campaignBudget, enumeration);
      optional(budget, 'explicitlyShared', result.campaignBudget, value => { if (typeof value !== 'boolean') fail('provider_failed'); return value; });
    }
  } else {
    if (['inventory', 'ad_daily'].includes(section)) {
      if (!id(row.adGroup?.id) || !id(row.adGroupAd?.ad?.id)) fail('provider_failed');
      result.adGroup = { id: row.adGroup.id }; result.adGroupAd = { ad: { id: row.adGroupAd.ad.id } };
    }
    if (section === 'inventory') {
      result.adGroup.status = status(row.adGroup.status); result.adGroupAd.status = status(row.adGroupAd.status);
      optional(row.adGroupAd, 'primaryStatus', result.adGroupAd, enumeration);
      if (row.adGroupAd.policySummary !== undefined && !plain(row.adGroupAd.policySummary)) fail('provider_failed');
      result.adGroupAd.policySummary = {};
      optional(row.adGroupAd.policySummary || {}, 'approvalStatus', result.adGroupAd.policySummary, enumeration);
    } else {
      result.metrics = { costMicros: integer(row.metrics?.costMicros, BigInt(Number.MAX_SAFE_INTEGER) * 10000n) };
      if (section !== 'month_cost') {
        if (!date(row.segments?.date) || row.segments.date < payload.startDate || row.segments.date > payload.endDate) fail('provider_failed');
        result.segments = { date: row.segments.date }; result.metrics.clicks = integer(row.metrics?.clicks);
      }
    }
  }
  return result;
}
module.exports = { DAYS, MAX_ADS, FAMILIES, SECTIONS, validate, limit, query, project };
