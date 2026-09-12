'use strict';

const { Op } = require('sequelize');
const { digest, optimizationReference } = require('./campaignWorkspaceOptimizationCapabilities.service');
const { campaignIncluded } = require('./campaignWorkspaceSettings.service');
const { verifyChange } = require('./campaignWorkspaceOptimizationCommand.service');
const { cents, budgetPeriod, inspectGoogleBudget, inspectMetaBudget } = require('./campaignWorkspaceBudgetSnapshot.service');
const { localDateTimeToUtc } = require('../lib/availability-calendar');

const TTL_MS = 60000;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const key = row => `${row.provider}:${row.account_id}:${row.campaign_id}`;
const resourceKey = (reference, resource) => `${reference.provider}:${reference.account_id}:${resource}`;
const instant = deps => (deps.now || (() => new Date()))();
const nonnegative = value => Number.isSafeInteger(value) && value >= 0;
const safeSum = values => {
  const sum = values.reduce((total, value) => { if (!nonnegative(value)) fail('workspace_optimization_budget_incomplete'); return total + BigInt(value); }, 0n);
  if (sum > BigInt(Number.MAX_SAFE_INTEGER)) fail('workspace_optimization_budget_incomplete');
  return Number(sum);
};
const plain = row => row?.get ? row.get({ plain: true }) : row;
const stamp = setting => digest([setting.id, setting.scope_type, setting.scope_id, setting.version, setting.accounts, setting.activation?.optimization?.id]);
const grantStamp = context => {
  const grant = context.grant;
  if (!Number.isSafeInteger(Number(grant?.connection?.id)) || Number(grant.connection.id) <= 0
    || !/^[a-f0-9]{64}$/.test(grant.grantFingerprint || grant.fingerprint || '')) fail('workspace_optimization_budget_scope_changed');
  return digest([Number(grant.connection.id), grant.grantFingerprint || grant.fingerprint, grant.loginCustomerId || null]);
};

async function selectedBudgetCampaigns({ models, setting, scope, transaction = null, loadInventory }) {
  const inventory = await (loadInventory || require('./campaignWorkspace.service').loadWorkspaceInventory)({ models, scope, transaction });
  const locals = scope.groupId ? await models.CampaignWorkspaceSetting.findAll({ where: { scope_type: 'clinic', scope_id: { [Op.in]: scope.clinicIds } },
    attributes: ['scope_id', 'accounts'], raw: true, transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) }) : [];
  const campaigns = inventory.campaigns.filter(row => campaignIncluded(row, setting)
    && campaignIncluded(row, locals.find(local => Number(local.scope_id) === row.clinicId)));
  if (!campaigns.length || campaigns.some(row => !row.assigned || !Number.isSafeInteger(row.clinicId) || !scope.clinicIds.includes(row.clinicId))
    || new Set(campaigns.map(key)).size !== campaigns.length) fail('workspace_optimization_budget_scope_incomplete');
  const selected = campaigns.map(row => ({ reference: optimizationReference({ provider: row.provider, account_id: row.account_id, campaign_id: row.campaign_id }), clinic_id: row.clinicId }))
    .sort((a, b) => key(a.reference).localeCompare(key(b.reference)));
  return { campaigns: selected, fingerprint: digest([stamp(setting), scope, selected]) };
}

function verifySnapshot(value, reference, period, now) {
  if (!value || value.schema_version !== 1 || value.currency !== 'EUR' || value.time_zone !== 'Europe/Madrid'
    || !value.reference || !value.period
    || digest(value.reference) !== digest(reference) || digest(value.period) !== digest(period)
    || !Number.isFinite(Date.parse(value.observed_at)) || +new Date(value.observed_at) > +now
    || +now - +new Date(value.observed_at) >= TTL_MS || !nonnegative(value.spent_cents) || !Array.isArray(value.resources)) fail('workspace_optimization_budget_incomplete');
  const { fingerprint, ...source } = value;
  if (fingerprint !== digest(source)) fail('workspace_optimization_budget_incomplete');
  const seen = new Set();
  for (const resource of value.resources) {
    if (typeof resource.resource !== 'string' || seen.has(resource.resource)
      || resource.unit !== (reference.provider === 'google_ads' ? 'micros' : 'minor')
      || resource.daily_cents !== cents(resource.amount, resource.unit) || resource.daily_cents <= 0) fail('workspace_optimization_budget_incomplete');
    seen.add(resource.resource);
  }
  return value;
}

async function collectBudgetAccounting({ models, run, authorization }, deps = {}) {
  verifyChange(run.change);
  if (run.change.target.action !== 'adjust_budget' || authorization.limits?.currency !== 'EUR'
    || !nonnegative(authorization.limits.monthly_limit_cents) || authorization.limits.monthly_limit_cents <= 0) fail('workspace_optimization_budget_accounting_required');
  const startedAt = instant(deps); const period = budgetPeriod(startedAt);
  const selection = await selectedBudgetCampaigns({ models, setting: authorization.setting, scope: authorization.scope, loadInventory: deps.loadInventory });
  const resolve = deps.resolveContext || require('./campaignWorkspaceOptimizationPreparation.service').optimizationContext;
  const snapshots = []; const grants = [];
  for (const selected of selection.campaigns) {
    if (+instant(deps) - +startedAt >= TTL_MS) fail('workspace_optimization_budget_timeout');
    if (deps.revalidate) await deps.revalidate();
    const context = await resolve({ models, scope: authorization.scope, reference: selected.reference,
      requirePreferences: false, loadInventory: deps.loadInventory, now: instant(deps) });
    if (stamp(plain(context.setting)) !== stamp(plain(authorization.setting)) || context.campaign.clinicId !== selected.clinic_id) fail('workspace_optimization_budget_scope_changed');
    grants.push(grantStamp(context));
    let value;
    try {
      const credentials = { accessToken: context.grant.connection.accessToken, loginCustomerId: context.grant.loginCustomerId };
      if (selected.reference.provider === 'google_ads') {
        const google = require('./googleAdsScopedRuntime.service');
        const token = await (deps.ensureToken || google.ensureGoogleConnectionAccessToken)(context.grant.connection, { requiredScopes: [google.GOOGLE_ADS_SCOPE] });
        credentials.accessToken = token.accessToken;
      }
      const read = selected.reference.provider === 'google_ads' ? deps.inspectGoogleBudget || inspectGoogleBudget : deps.inspectMetaBudget || inspectMetaBudget;
      if (deps.revalidate) await deps.revalidate();
      value = await read({ reference: selected.reference, ...credentials, now: instant(deps) });
    }
    catch (error) {
      if (['NO_SCOPED_CONNECTION', 'INSUFFICIENT_SCOPE', 'NO_TOKEN', 'TOKEN_EXPIRED', 'REFRESH_FAILED'].includes(error.code)
        || [10, 190, 200].includes(Number(error.response?.data?.error?.code)) || [401, 403].includes(error.response?.status)) fail('workspace_optimization_permissions_required');
      if ([4, 17, 613].includes(Number(error.response?.data?.error?.code)) || error.response?.status === 429) fail('workspace_optimization_rate_limited');
      throw error;
    }
    verifySnapshot(value, selected.reference, period, instant(deps));
    snapshots.push(value);
  }
  const record = { schema_version: 1, scope_fingerprint: selection.fingerprint, run_id: run.id, change_fingerprint: run.change.fingerprint,
    setting_id: run.setting_id, mandate_id: run.mandate_id, period, snapshots, grants, collected_at: startedAt.toISOString() };
  return { ...record, fingerprint: digest(record) };
}

// Keep the month ledger on the existing durable attempt. No provider I/O belongs inside this transaction.
async function reserveBudgetAccounting({ models, run, authorization, accounting, transaction }, deps = {}) {
  if (!transaction) fail('workspace_optimization_budget_accounting_required');
  const now = instant(deps); const period = budgetPeriod(now); const change = verifyChange(run.change);
  const { fingerprint, ...source } = accounting || {};
  if (!accounting || accounting.schema_version !== 1 || fingerprint !== digest(source)
    || accounting.run_id !== run.id || accounting.change_fingerprint !== change.fingerprint
    || accounting.setting_id !== run.setting_id || accounting.mandate_id !== run.mandate_id
    || !Number.isFinite(Date.parse(accounting.collected_at)) || +new Date(accounting.collected_at) > +now
    || +now - +new Date(accounting.collected_at) >= TTL_MS || !accounting.period || digest(accounting.period) !== digest(period)
    || !Array.isArray(accounting.snapshots) || !Array.isArray(accounting.grants)) fail('workspace_optimization_budget_stale');
  const selection = await selectedBudgetCampaigns({ models, setting: authorization.setting, scope: authorization.scope, transaction, loadInventory: deps.loadInventory });
  if (selection.fingerprint !== accounting.scope_fingerprint || selection.campaigns.length !== accounting.snapshots.length
    || selection.campaigns.length !== accounting.grants.length) fail('workspace_optimization_budget_scope_changed');
  const snapshots = selection.campaigns.map((campaign, index) => verifySnapshot(accounting.snapshots[index], campaign.reference, period, now));
  const resolve = deps.resolveContext || require('./campaignWorkspaceOptimizationPreparation.service').optimizationContext;
  for (const [index, selected] of selection.campaigns.entries()) {
    const context = await resolve({ models, scope: authorization.scope, reference: selected.reference, requirePreferences: false,
      loadInventory: deps.loadInventory, now, transaction });
    if (grantStamp(context) !== accounting.grants[index] || context.campaign.clinicId !== selected.clinic_id) fail('workspace_optimization_budget_scope_changed');
  }
  const prior = await models.CampaignWorkspaceOptimizationRun.findAll({ where: { setting_id: run.setting_id, id: { [Op.ne]: run.id },
    submitted_at: { [Op.ne]: null }, [Op.or]: [
      { 'outcome.budget_accounting.month': period.month },
      { 'change.target.action': 'adjust_budget', submitted_at: { [Op.gte]: localDateTimeToUtc(period.start, '00:00', 'Europe/Madrid') } },
    ] }, transaction, lock: transaction.LOCK.UPDATE });
  const spent = new Map(); const resources = new Map(); const todayHigh = new Map();
  // Monotonic spent amounts prevent a delayed provider response or a new mandate from restoring used allowance.
  // Previously included resources stay reserved if their current state can no longer be inspected in this scope.
  for (const row of prior) {
    const ledger = row.outcome?.budget_accounting;
    if (ledger?.schema_version !== 1 || ledger.month !== period.month || ledger.currency !== 'EUR'
      || !Array.isArray(ledger.spent_by_campaign) || !Array.isArray(ledger.resources)) fail('workspace_optimization_budget_ledger_invalid');
    const { fingerprint: saved, ...body } = ledger;
    if (saved !== digest(body)) fail('workspace_optimization_budget_ledger_invalid');
    for (const item of ledger.spent_by_campaign) {
      if (typeof item.key !== 'string' || !nonnegative(item.cents)) fail('workspace_optimization_budget_ledger_invalid');
      spent.set(item.key, Math.max(spent.get(item.key) || 0, item.cents));
    }
    for (const item of ledger.resources) {
      if (typeof item.key !== 'string' || typeof item.campaign_key !== 'string' || !nonnegative(item.daily_cents)
        || !nonnegative(item.daily_high_cents) || item.daily_high_cents < item.daily_cents) fail('workspace_optimization_budget_ledger_invalid');
      if (ledger.day === period.end) todayHigh.set(item.key, Math.max(todayHigh.get(item.key) || 0, item.daily_high_cents));
      const old = resources.get(item.key);
      if (!old || old.daily_cents < item.daily_cents) resources.set(item.key, { ...item, retained: true });
    }
  }
  const observedCampaigns = new Set(snapshots.map(value => key(value.reference)));
  // Fresh full campaign snapshots can release old resources, including a campaign now paused.
  for (const [id, resource] of resources) if (observedCampaigns.has(resource.campaign_key)) resources.delete(id);
  let target = null;
  for (const value of snapshots) {
    const campaignKey = key(value.reference);
    spent.set(campaignKey, Math.max(spent.get(campaignKey) || 0, value.spent_cents));
    for (const resource of value.resources) {
      const id = resourceKey(value.reference, resource.resource);
      if (resources.has(id)) fail('workspace_optimization_budget_shared_resource');
      const row = { key: id, campaign_key: campaignKey, daily_cents: resource.daily_cents,
        daily_high_cents: Math.max(resource.daily_cents, todayHigh.get(id) || 0), retained: false };
      resources.set(id, row);
      if (campaignKey === key(change.reference) && resource.resource === change.target.resource) {
        if (target || resource.unit !== change.target.unit || resource.amount !== change.before) fail('workspace_optimization_budget_resource_changed');
        target = row;
      }
    }
  }
  if (!target) fail('workspace_optimization_budget_resource_changed');
  target.daily_cents = cents(change.after, change.target.unit);
  target.daily_high_cents = Math.max(target.daily_high_cents, target.daily_cents);
  const totalSpent = safeSum([...spent.values()]); const futureDaily = safeSum([...resources.values()].map(row => row.daily_cents));
  // A reduction cannot reclaim today's already committed higher budget.
  const todayReserve = safeSum([...resources.values()].map(row => Math.max(0, row.daily_high_cents - row.daily_cents)));
  const projected = safeSum([totalSpent, ...Array(period.remaining_days).fill(futureDaily), todayReserve]);
  const limit = authorization.limits?.monthly_limit_cents;
  if (!nonnegative(limit) || limit <= 0 || authorization.limits.currency !== 'EUR' || projected > limit) fail('workspace_optimization_budget_limit_exceeded');
  // Locks and scope checks can wait. A snapshot must still be fresh at the end of the reservation.
  const checkedAt = instant(deps);
  if (+checkedAt < +now || +checkedAt - +new Date(accounting.collected_at) >= TTL_MS
    || digest(budgetPeriod(checkedAt)) !== digest(period)) fail('workspace_optimization_budget_stale');
  const ledger = { schema_version: 1, month: period.month, day: period.end, currency: 'EUR', time_zone: 'Europe/Madrid',
    projection_model: 'reported_spend_plus_daily_commitments_v1', run_id: run.id, mandate_id: run.mandate_id,
    scope_fingerprint: selection.fingerprint, authorization_fingerprint: digest(accounting.grants), checked_at: checkedAt.toISOString(), limit_cents: limit,
    reported_spend_cents: totalSpent, daily_commitment_cents: futureDaily, remaining_days: period.remaining_days,
    today_reserve_cents: todayReserve, projected_cents: projected,
    spent_by_campaign: [...spent].map(([key, cents]) => ({ key, cents })).sort((a, b) => a.key.localeCompare(b.key)),
    resources: [...resources.values()].sort((a, b) => a.key.localeCompare(b.key)),
    observations: snapshots.map(value => ({ campaign_key: key(value.reference), observed_at: value.observed_at, fingerprint: value.fingerprint })) };
  return { ...ledger, fingerprint: digest(ledger) };
}

module.exports = { TTL_MS, selectedBudgetCampaigns, verifySnapshot, collectBudgetAccounting, reserveBudgetAccounting };
