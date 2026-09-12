'use strict';

const { optimizationReference, digest } = require('./campaignWorkspaceOptimizationCapabilities.service');
const { googleAdsSearchRows } = require('../lib/googleAdsSearchRows');
const { graphList } = require('./campaignWorkspaceMetaDestination.service');

const fail = code => { throw Object.assign(new Error(code), { code }); };
const MAX_CENTS = BigInt(Number.MAX_SAFE_INTEGER);
const id = value => typeof value === 'string' && /^[1-9][0-9]{0,63}$/.test(value);
const emptyAmount = value => value == null || /^(0|0\.0+)$/.test(String(value));

function integer(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,21})$/.test(value)) fail('workspace_optimization_budget_incomplete');
  return BigInt(value);
}

function cents(value, unit) {
  let result;
  if (unit === 'eur') {
    if (typeof value !== 'string' || !/^(0|[1-9][0-9]{0,15})(\.[0-9]{1,2})?$/.test(value)) fail('workspace_optimization_budget_incomplete');
    const [whole, fraction = ''] = value.split('.'); result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  } else {
    result = integer(value);
    if (unit === 'micros') result = (result + 9999n) / 10000n;
    else if (unit !== 'minor') fail('workspace_optimization_budget_incomplete');
  }
  if (result > MAX_CENTS) fail('workspace_optimization_budget_incomplete');
  return Number(result);
}

function budgetPeriod(now = new Date()) {
  if (!Number.isFinite(+now)) fail('workspace_optimization_budget_incomplete');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Madrid',
    year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now).map(row => [row.type, row.value]));
  const month = `${parts.year}-${parts.month}`;
  const lastDay = new Date(Date.UTC(Number(parts.year), Number(parts.month), 0)).getUTCDate();
  return { month, start: `${month}-01`, end: `${month}-${parts.day}`, remaining_days: lastDay - Number(parts.day) + 1 };
}

function snapshot(reference, period, spent, resources, now) {
  const row = { schema_version: 1, reference, period, currency: 'EUR', time_zone: 'Europe/Madrid',
    observed_at: now.toISOString(), spent_cents: spent, resources };
  return { ...row, fingerprint: digest(row) };
}

function validateAccount(currency, timezone) {
  if (currency !== 'EUR') fail('workspace_optimization_budget_currency');
  // Do not merge provider calendar months with different cutoffs into a purported monthly total.
  if (timezone !== 'Europe/Madrid') fail('workspace_optimization_budget_timezone');
}

async function inspectGoogleBudget({ reference, accessToken, loginCustomerId, now = new Date(), read = googleAdsSearchRows }) {
  optimizationReference(reference);
  if (reference.provider !== 'google_ads') fail('workspace_optimization_budget_incomplete');
  const period = budgetPeriod(now);
  const search = async query => {
    const rows = await read({ customerId: reference.account_id, accessToken, loginCustomerId, query: `${query} LIMIT 2`, maxPages: 2, timeoutMs: 10000 });
    if (!Array.isArray(rows) || rows.length > 1 || rows.some(row => String(row.customer?.id) !== reference.account_id
      || String(row.campaign?.id) !== reference.campaign_id)) fail('workspace_optimization_budget_incomplete');
    return rows;
  };
  const rows = await search(`SELECT customer.id, customer.currency_code, customer.time_zone, campaign.id, campaign.status,
    campaign_budget.resource_name, campaign_budget.amount_micros, campaign_budget.period,
    campaign_budget.explicitly_shared, campaign_budget.reference_count
    FROM campaign WHERE campaign.id = ${reference.campaign_id}`);
  if (rows.length !== 1) fail('workspace_optimization_budget_incomplete');
  const row = rows[0]; validateAccount(row.customer.currencyCode, row.customer.timeZone);
  if (!['ENABLED', 'PAUSED', 'REMOVED'].includes(row.campaign.status)) fail('workspace_optimization_budget_incomplete');
  const resources = [];
  if (row.campaign.status === 'ENABLED') {
    const budget = row.campaignBudget;
    if (budget?.period !== 'DAILY' || budget.explicitlyShared !== false || Number(budget.referenceCount) !== 1
      || !new RegExp(`^customers/${reference.account_id}/campaignBudgets/[1-9][0-9]*$`).test(budget.resourceName || '')) fail('workspace_optimization_budget_unsupported');
    const daily = cents(budget.amountMicros, 'micros');
    if (daily <= 0) fail('workspace_optimization_budget_incomplete');
    resources.push({ resource: budget.resourceName, unit: 'micros', amount: budget.amountMicros, daily_cents: daily });
  }
  const costs = await search(`SELECT customer.id, campaign.id, metrics.cost_micros FROM campaign
    WHERE campaign.id = ${reference.campaign_id} AND segments.date BETWEEN '${period.start}' AND '${period.end}'`);
  return snapshot(reference, period, costs.length ? cents(costs[0].metrics?.costMicros, 'micros') : 0, resources, now);
}

async function inspectMetaBudget({ reference, accessToken, now = new Date(), read = require('../lib/metaClient').metaGet }) {
  optimizationReference(reference);
  if (reference.provider !== 'meta_ads') fail('workspace_optimization_budget_incomplete');
  const period = budgetPeriod(now); const account = reference.account_id; const campaignId = reference.campaign_id;
  const deadline = Date.now() + 45000;
  const get = (path, options = {}) => {
    const remaining = deadline - Date.now();
    if (remaining < 1000) fail('workspace_optimization_budget_timeout');
    return read(path, { ...options, accessToken, maxRetries: 0, timeout: Math.min(8000, remaining),
      sensitivePayload: true, source: 'campaign_workspace', operation: 'optimization_budget_snapshot' });
  };
  const owner = (await get(`act_${account}`, { params: { fields: 'id,account_id,currency,timezone_name' } })).data;
  if (owner?.id !== `act_${account}` || owner.account_id !== account) fail('workspace_optimization_budget_incomplete');
  validateAccount(owner.currency, owner.timezone_name);
  const row = (await get(campaignId, { params: { fields: 'id,account_id,status,effective_status,daily_budget,lifetime_budget' } })).data;
  if (row?.id !== campaignId || row.account_id !== account || !['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED'].includes(row.status)) fail('workspace_optimization_budget_incomplete');
  const resources = [];
  // A configured ACTIVE campaign can resume delivery without a budget edit. Count its commitment even if delivery is temporarily limited.
  if (row.status === 'ACTIVE') {
    if (!emptyAmount(row.lifetime_budget)) fail('workspace_optimization_budget_unsupported');
    if (!emptyAmount(row.daily_budget)) {
      const daily = cents(row.daily_budget, 'minor');
      resources.push({ resource: campaignId, unit: 'minor', amount: row.daily_budget, daily_cents: daily });
    } else {
      const groups = await graphList(`${campaignId}/adsets`, 'id,account_id,campaign_id,status,daily_budget,lifetime_budget', accessToken, get);
      if (!groups.complete || groups.rows.length > 2000 || new Set(groups.rows.map(row => row.id)).size !== groups.rows.length) fail('workspace_optimization_budget_incomplete');
      for (const group of groups.rows) {
        if (!id(group.id) || group.account_id !== account || group.campaign_id !== campaignId
          || !['ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED'].includes(group.status)) fail('workspace_optimization_budget_incomplete');
        if (group.status !== 'ACTIVE') continue;
        if (!emptyAmount(group.lifetime_budget) || emptyAmount(group.daily_budget)) fail('workspace_optimization_budget_unsupported');
        resources.push({ resource: group.id, unit: 'minor', amount: group.daily_budget, daily_cents: cents(group.daily_budget, 'minor') });
      }
    }
  }
  const totals = await get(`${campaignId}/insights`, { params: { fields: 'account_id,campaign_id,date_start,date_stop,spend',
    level: 'campaign', time_range: JSON.stringify({ since: period.start, until: period.end }), limit: 2 } });
  const costs = totals.data?.data;
  if (!Array.isArray(costs) || costs.length > 1 || totals.data?.paging?.next || totals.data?.error
    || costs.some(cost => cost.account_id !== account || cost.campaign_id !== campaignId
      || cost.date_start !== period.start || cost.date_stop !== period.end)) fail('workspace_optimization_budget_incomplete');
  return snapshot(reference, period, costs.length ? cents(costs[0].spend, 'eur') : 0, resources, now);
}

module.exports = { cents, budgetPeriod, inspectGoogleBudget, inspectMetaBudget };
