'use strict';

const { randomUUID } = require('node:crypto');
const { VERSION, ACCOUNT_VERSION, scopeFor, componentCoverage, filterDigestFor, collectCosts, collectAccountCosts,
  accountFilterFor, accountFilterDigestFor, filterFor, amountToUnits, unitsToAmount } = require('./costs');
const ACCOUNT = '137819318729';
const ROLE = `arn:aws:iam::${ACCOUNT}:role/clinicaclick-platform-cost-collector-role`;
const BUDGET = 'clinicaclick-integrations-prod-monthly-budget';
const REQUIRED_TAGS = ['application', 'component', 'environment'];
// Two monthly child processes per daily batch, each with at most five CE commands
// and two SDK attempts per command: at most 20 CE request attempts per batch.
const MAX_CE_COMMANDS_PER_MONTH = 5;
const SDK_MAX_ATTEMPTS = 2;
const SAFE_ERRORS = new Set(['cost_tags_unverified', 'cost_scope_invalid', 'cost_response_invalid', 'cost_amount_invalid',
  'cost_period_invalid', 'cost_currency_mismatch', 'cost_pagination_invalid', 'cost_duplicate_group', 'cost_pagination_limit',
  'cost_identity_invalid', 'cost_snapshot_invalid', 'cost_collector_unavailable', 'cost_call_budget_exceeded',
  'cost_credentials_invalid', 'cost_credentials_unavailable']);
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
    || !identity.Arn.startsWith(`arn:aws:sts::${ACCOUNT}:assumed-role/clinicaclick-platform-cost-collector-role/`)) throw Error('cost_identity_invalid');
  await verifyTags(api.listTags);
  const period = periodFor(config.month, now);
  const snapshot = period.from < period.to ? await collectCosts({ ...config, ...period, tagsVerified: true,
    getCostAndUsage: api.usage, now: () => now }) : {
    version: VERSION, source: 'aws_cost_explorer', metric: 'UnblendedCost', environment: 'platform',
    period: { from: period.from, toExclusive: period.to }, collectedAt: now.toISOString(), status: 'pending',
    amount: null, currency: null, estimated: true, rows: [], missingDays: [], pages: 0,
    scope: scopeFor(), componentCoverage: componentCoverage([]), filterDigest: filterDigestFor(config),
    coverage: 'tagged_resources_only', coverageStatus: 'observed_partial', excludesAiEstimates: true,
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
async function collectReconciledReport(configInput, api, now = new Date()) {
  const config = configFor(configInput);
  const identity = await api.identity();
  if (identity?.Account !== ACCOUNT || typeof identity.Arn !== 'string'
    || !identity.Arn.startsWith(`arn:aws:sts::${ACCOUNT}:assumed-role/clinicaclick-platform-cost-collector-role/`)) throw Error('cost_identity_invalid');
  let calls = 0; let observedAttempts = 0; let attemptsComplete = true;
  const operations = { tags: 0, usage: 0, forecast: 0 };
  const track = (name, method) => async input => {
    if (calls >= MAX_CE_COMMANDS_PER_MONTH) throw Error('cost_call_budget_exceeded');
    calls++; operations[name]++;
    const note = value => {
      const attempts = value?.$metadata?.attempts;
      if (!Number.isInteger(attempts) || attempts < 1 || attempts > SDK_MAX_ATTEMPTS) attemptsComplete = false;
      else observedAttempts += attempts;
    };
    try { const result = await method(input); note(result); return result; }
    catch (error) { note(error); throw error; }
  };
  const tracked = { ...api, identity: async () => identity,
    listTags: track('tags', api.listTags), usage: track('usage', api.usage), forecast: track('forecast', api.forecast) };
  const period = periodFor(config.month, now);
  const collectionId = randomUUID();
  // Read account totals first so inactive allocation tags cannot hide other charges.
  const account = period.from < period.to
    ? await collectAccountCosts({ ...config, ...period, getCostAndUsage: tracked.usage, now: () => now })
    : { version: ACCOUNT_VERSION, source: 'aws_cost_explorer', metric: 'UnblendedCost', environment: 'platform',
      period: { from: period.from, toExclusive: period.to }, collectedAt: now.toISOString(), status: 'pending',
      amount: null, currency: null, estimated: true, rows: [], missingDays: [], pages: 0,
      scope: { mode: 'linked_account', allServices: true, resourceTagFilter: false },
      filterDigest: accountFilterDigestFor(config), coverage: 'linked_account_reported', coverageStatus: 'observed_partial', excludesAiEstimates: true };
  let attributed = null; let attributionError = null;
  try { attributed = { ...await collectReport(config, tracked, now), collectionId }; }
  catch (error) { attributionError = safeError(error); }
  let forecast = { status: 'not_applicable', amount: null, currency: null };
  if (period.today < period.monthEnd) {
    try {
      const result = await tracked.forecast({ TimePeriod: { Start: period.today, End: period.monthEnd },
        Metric: 'UNBLENDED_COST', Granularity: 'MONTHLY', Filter: accountFilterFor(config), PredictionIntervalLevel: 80 });
      forecast = { status: 'available', ...money(result.Total), period: { from: period.today, toExclusive: period.monthEnd }, kind: 'remaining_period' };
    } catch { forecast = { status: 'pending', amount: null, currency: null, kind: 'remaining_period' }; }
  }
  const collection = { ceLogicalCalls: calls, ceOperations: operations, sdkMaxAttempts: SDK_MAX_ATTEMPTS,
    ceRequestAttemptLimit: MAX_CE_COMMANDS_PER_MONTH * SDK_MAX_ATTEMPTS,
    ceRequestAttemptUpperBound: calls * SDK_MAX_ATTEMPTS, ceRequestAttemptsObserved: attemptsComplete ? observedAttempts : null,
    dailyBatchRequestAttemptLimit: 2 * MAX_CE_COMMANDS_PER_MONTH * SDK_MAX_ATTEMPTS };
  return { version: 3, month: config.month, attributed, attributionError,
    account: { ...account, month: config.month, collectionId, forecast, collection,
      billingTimeZone: 'UTC', scheduleTimeZone: 'Europe/Madrid', invoice: false }, collection };
}
module.exports = { ACCOUNT, ROLE, BUDGET, MAX_CE_COMMANDS_PER_MONTH, SDK_MAX_ATTEMPTS,
  configFor, periodFor, collectReport, collectReconciledReport, safeError };
