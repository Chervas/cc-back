'use strict';

const { bidFixture } = require('./campaign_workspace_bid.fixture');
const { inspectGoogleBudget, inspectMetaBudget, budgetPeriod } = require('../../../services/campaignWorkspaceBudgetSnapshot.service');

function budgetPolicyFixture(provider = 'google_ads', owner = 'ad_set') {
  const f = bidFixture(provider); const google = provider === 'google_ads'; const campaignOwner = !google && owner === 'campaign';
  const target = { action: 'adjust_budget', entity: google ? 'campaign_budget' : owner, id: google ? '70' : campaignOwner ? '30' : '50',
    resource: google ? 'customers/20/campaignBudgets/70' : campaignOwner ? '30' : '50',
    field: google ? 'amount_micros' : 'daily_budget', unit: google ? 'micros' : 'minor' };
  const before = google ? '50000000' : '5000';
  f.input.action = f.payload.action = 'adjust_budget';
  const authorization = f.state.setting.activation.optimization.authorization;
  authorization.limits.actions = ['adjust_budget']; authorization.limits.monthly_limit_cents = 500000;
  authorization.campaigns[0].targets = [target];
  if (campaignOwner) f.state.campaign.daily_budget = before;
  f.execution.state.remote = before;
  const inspection = () => ({ reference: f.input.reference, currency: 'EUR', targets: [{ ...target, value: f.execution.state.remote }] });
  f.execution.deps.providerDependencies = { inspectGoogle: async () => inspection(), inspectMeta: async () => inspection() };
  f.state.spentMicros = '100000000'; f.state.budgetReads = [];
  const resolveContext = async () => ({ setting: structuredClone(f.state.setting), campaign: structuredClone(f.state.workspaceCampaign),
    grant: structuredClone(f.state.grant) });
  const readGoogle = async options => {
    f.state.budgetReads.push(options.query); if (f.state.onBudgetRead) await f.state.onBudgetRead();
    return [{ customer: { id: '20', currencyCode: 'EUR', timeZone: 'Europe/Madrid' }, campaign: { id: '30', status: 'ENABLED' },
      ...(/metrics.cost_micros/.test(options.query) ? { metrics: { costMicros: f.state.spentMicros } }
        : { campaignBudget: { ...f.state.googleMeta[0].campaignBudget, amountMicros: f.execution.state.remote } }) }];
  };
  const readMeta = async path => {
    f.state.budgetReads.push(path); if (f.state.onBudgetRead) await f.state.onBudgetRead();
    const period = budgetPeriod(f.state.now);
    return { data: { act_20: { id: 'act_20', account_id: '20', currency: 'EUR', timezone_name: 'Europe/Madrid' },
      30: { id: '30', account_id: '20', status: 'ACTIVE', effective_status: 'ACTIVE', lifetime_budget: '0', daily_budget: campaignOwner ? f.execution.state.remote : '0' },
      '30/adsets': { data: [{ id: '50', account_id: '20', campaign_id: '30', status: 'ACTIVE', effective_status: 'ACTIVE', lifetime_budget: '0', daily_budget: f.execution.state.remote }] },
      '30/insights': { data: [{ account_id: '20', campaign_id: '30', date_start: period.start, date_stop: period.end, spend: (Number(f.state.spentMicros) / 1e6).toFixed(2) }] },
    }[path] };
  };
  f.execution.deps.budgetDependencies = {
    loadInventory: async () => ({ campaigns: [structuredClone(f.state.workspaceCampaign)] }), resolveContext,
    ensureToken: f.deps.ensureToken,
    inspectGoogleBudget: options => inspectGoogleBudget({ ...options, read: readGoogle }),
    inspectMetaBudget: options => inspectMetaBudget({ ...options, read: readMeta }),
  };
  const setDailyCosts = (older, recent) => {
    f.state.adRows.forEach(row => {
      const amount = (f.performance.dates.indexOf(google ? row.segments.date : row.date_start) >= 14 ? recent : older) / 2;
      if (google) row.metrics.costMicros = String(amount * 1e6); else row.spend = amount.toFixed(2);
    });
    f.state.campaignRows.forEach((row, index) => {
      const amount = index >= 14 ? recent : older;
      if (google) row.metrics.costMicros = String(amount * 1e6); else row.spend = amount.toFixed(2);
    });
  };
  return { ...f, target, before, setDailyCosts };
}

module.exports = { budgetPolicyFixture };
