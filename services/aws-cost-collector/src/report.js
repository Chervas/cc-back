'use strict';

const { collectCosts, filterFor, amountToUnits, unitsToAmount } = require('./costs');
const ACCOUNT = '137819318729';
const ROLE = `arn:aws:iam::${ACCOUNT}:role/clinicaclick-integrations-prod-cost-reader-role`;
const BUDGET = 'clinicaclick-integrations-prod-monthly-budget';
const REQUIRED_TAGS = ['application', 'component', 'environment'];
const SAFE_ERRORS = new Set(['cost_tags_unverified', 'cost_scope_invalid', 'cost_response_invalid', 'cost_amount_invalid',
  'cost_period_invalid', 'cost_currency_mismatch', 'cost_pagination_invalid', 'cost_duplicate_group', 'cost_pagination_limit',
  'cost_identity_invalid', 'cost_snapshot_invalid', 'cost_collector_unavailable']);
function safeError(error) { return SAFE_ERRORS.has(error?.message) ? error.message : 'cost_aws_unavailable'; }
function configFor(value) {
  if (!value || Object.keys(value).some(key => !['accountId', 'roleArn', 'environment', 'month'].includes(key))
    || value.accountId !== ACCOUNT || value.roleArn !== ROLE || value.environment !== 'prod'
    || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(value.month)) throw Error('cost_scope_invalid');
  return value;
}
function periodFor(month, now = new Date()) {
  if (!/^20\d{2}-(0[1-9]|1[0-2])$/.test(month)) throw Error('cost_period_invalid');
  const from = month + '-01'; const d = new Date(from); d.setUTCMonth(d.getUTCMonth() + 1);
  const end = d.toISOString().slice(0, 10); const today = now.toISOString().slice(0, 10);
  if (from > today) throw Error('cost_period_invalid');
  return { from, to: end < today ? end : today, monthEnd: end, today };
}
function money(value) {
  if (!/^[A-Z]{3}$/.test(value?.Unit)) throw Error('cost_response_invalid');
  return { amount: unitsToAmount(amountToUnits(value.Amount)), currency: value.Unit };
}
async function verifyTags(listTags) {
  const active = new Set(); const tokens = new Set(); let token; let pages = 0;
  do {
    if (++pages > 10) throw Error('cost_pagination_limit');
    const value = await listTags({ TagKeys: REQUIRED_TAGS, ...(token ? { NextToken: token } : {}) });
    for (const tag of value.CostAllocationTags || []) if (tag.Status === 'Active') active.add(tag.TagKey);
    token = value.NextToken;
    if (token && (typeof token !== 'string' || tokens.has(token))) throw Error('cost_pagination_invalid');
    if (token) tokens.add(token);
  } while (token);
  if (!REQUIRED_TAGS.every(tag => active.has(tag))) throw Error('cost_tags_unverified');
}
function budgetProjection(response, config) {
  const budget = response?.Budget;
  if (!budget || budget.BudgetName !== BUDGET || budget.BudgetType !== 'COST' || budget.TimeUnit !== 'MONTHLY') throw Error('cost_response_invalid');
  const limit = money(budget.BudgetLimit);
  // Current delivered Budget is broader. Recognize only the exact future canonical expression.
  const canonical = value => JSON.stringify(value, (_key, child) => child && !Array.isArray(child) && typeof child === 'object'
    ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child);
  const scopeMatches = canonical(budget.FilterExpression) === canonical(filterFor(config));
  return { status: 'available', source: 'aws_budgets', ...limit, scopeMatches,
    metricMatches: Array.isArray(budget.Metrics) && budget.Metrics.length === 1 && budget.Metrics[0] === 'UnblendedCost',
    hardLimit: false, period: 'monthly' };
}
async function collectReport(configInput, api, now = new Date()) {
  const config = configFor(configInput);
  const identity = await api.identity();
  if (identity?.Account !== ACCOUNT || typeof identity.Arn !== 'string'
    || !identity.Arn.startsWith(`arn:aws:sts::${ACCOUNT}:assumed-role/clinicaclick-integrations-prod-cost-reader-role/`)) throw Error('cost_identity_invalid');
  await verifyTags(api.listTags);
  const period = periodFor(config.month, now);
  const snapshot = period.from < period.to ? await collectCosts({ ...config, ...period, tagsVerified: true,
    getCostAndUsage: api.usage, now: () => now }) : {
    version: 1, source: 'aws_cost_explorer', metric: 'UnblendedCost', environment: 'prod',
    period: { from: period.from, toExclusive: period.to }, collectedAt: now.toISOString(), status: 'pending',
    amount: null, currency: null, estimated: true, rows: [], missingDays: [], pages: 0,
    scope: { components: ['integrations', 'audit'], application: 'clinicaclick', environment: 'prod' },
    coverage: 'tagged_resources_only', excludesAiEstimates: true,
  };
  let forecast = { status: 'not_applicable', amount: null, currency: null };
  if (period.today < period.monthEnd) {
    try {
      const value = await api.forecast({ TimePeriod: { Start: period.today, End: period.monthEnd },
        Metric: 'UNBLENDED_COST', Granularity: 'MONTHLY', Filter: filterFor(config), PredictionIntervalLevel: 80 });
      forecast = { status: 'available', ...money(value.Total), period: { from: period.today, toExclusive: period.monthEnd }, kind: 'remaining_period' };
    } catch { forecast = { status: 'pending', amount: null, currency: null, kind: 'remaining_period' }; }
  }
  let budget = { status: 'pending', source: 'aws_budgets', amount: null, currency: null, scopeMatches: false, metricMatches: false, hardLimit: false, period: 'monthly' };
  try { budget = budgetProjection(await api.budget({ AccountId: ACCOUNT, BudgetName: BUDGET }), config); } catch {}
  return { ...snapshot, month: config.month, forecast, budget: { ...budget, referenceMonth: now.toISOString().slice(0, 7) }, tagsVerifiedAt: now.toISOString(),
    billingTimeZone: 'UTC', scheduleTimeZone: 'Europe/Madrid', invoice: false };
}
module.exports = { ACCOUNT, ROLE, BUDGET, configFor, periodFor, collectReport, safeError };
