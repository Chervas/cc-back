'use strict';

const { qualifiedFixture } = require('./campaign_workspace_optimization_evidence.fixture');
const { fixture: executionFixture } = require('./campaign_workspace_optimization_execution.fixture');
const { collectOptimizationEvidence } = require('../../../services/campaignWorkspaceOptimizationEvidence.service');
const { runOptimizationEvaluation, JOB_TYPE, ORIGIN } = require('../../../services/campaignWorkspaceOptimizationEvaluation.service');

function bidFixture(provider = 'google_ads') {
  const f = qualifiedFixture(provider); const google = provider === 'google_ads'; const execution = executionFixture(provider);
  const target = { action: 'adjust_bids', entity: google ? 'ad_group' : 'ad_set', id: '50',
    resource: google ? 'customers/20/adGroups/50' : '50', field: google ? 'cpc_bid_micros' : 'bid_amount',
    unit: google ? 'micros' : 'minor', strategy: google ? 'MANUAL_CPC' : 'LOWEST_COST_WITH_BID_CAP' };
  const before = google ? '1000000' : '1000';
  f.input.action = 'adjust_bids';
  f.state.setting.activation.optimization.authorization.limits.actions = ['adjust_bids'];
  f.state.setting.activation.optimization.authorization.campaigns[0].targets = [target];
  f.state.bidTarget = target; f.state.bidBefore = before;
  f.state.googleMeta[0].campaign.biddingStrategyType = 'MANUAL_CPC';
  f.state.googleMeta[0].campaignBudget = { resourceName: 'customers/20/campaignBudgets/70', period: 'DAILY',
    amountMicros: '50000000', explicitlyShared: false, referenceCount: '1' };
  f.state.bidGroups = google ? [{ customer: { id: '20' }, campaign: { id: '30' }, adGroup: { id: '50', status: 'ENABLED', cpcBidMicros: before } }]
    : [{ id: '50', account_id: '20', campaign_id: '30', status: 'ACTIVE', effective_status: 'ACTIVE',
      bid_strategy: target.strategy, bid_amount: before, daily_budget: '5000', lifetime_budget: '0' }];
  f.state.adRows.forEach(row => {
    const recent = f.performance.dates.indexOf(google ? row.segments.date : row.date_start) >= 14;
    if (google) row.metrics.costMicros = recent ? '30000000' : '10000000'; else row.spend = recent ? '30.00' : '10.00';
  });
  f.state.campaignRows.forEach((row, index) => {
    if (google) row.metrics.costMicros = index >= 14 ? '60000000' : '20000000'; else row.spend = index >= 14 ? '60.00' : '20.00';
  });
  const googleRequest = f.deps.googleRequest; const metaRead = f.deps.metaRead;
  f.deps.googleRequest = async (method, path, options) => {
    if (/FROM ad_group\b/.test(options.data.query)) {
      f.state.calls.push({ query: options.data.query });
      if (f.state.beforeRead) await f.state.beforeRead({ query: options.data.query });
      return { results: structuredClone(f.state.bidGroups) };
    }
    return googleRequest(method, path, options);
  };
  f.deps.metaRead = async (path, options) => {
    if (path === 'me/permissions' || path === '30/adsets') {
      f.state.calls.push({ path, options }); if (f.state.beforeRead) await f.state.beforeRead(path, options);
      return { data: { data: path === 'me/permissions' ? [{ permission: 'ads_management', status: 'granted' }]
        : structuredClone(f.state.bidGroups) } };
    }
    return metaRead(path, options);
  };
  const models = { ...execution.deps.models, ...f.deps.models, JobRequest: { ...execution.deps.models.JobRequest,
    findOne: async () => f.state.failedJob || null }, CampaignWorkspaceEvent: { findOne: async () => null } };
  execution.state.remote = before;
  const inspection = () => ({ reference: f.input.reference, currency: 'EUR', targets: [{ ...target, value: execution.state.remote }] });
  Object.assign(execution.deps, { models, now: f.deps.now, authorize: f.deps.resolveAuthorization, hasAccess: f.deps.hasAccess,
    ensureToken: f.deps.ensureToken, inspect: undefined, providerDependencies: { inspectGoogle: async () => inspection(), inspectMeta: async () => inspection() },
    receptionDependencies: { loadInventory: f.deps.loadInventory, loadReception: f.deps.loadReception },
    mutate: async change => { execution.state.calls.mutate++; execution.state.remote = change.after; return { acknowledged: true }; } });
  const deps = { models, env: f.deps.env, now: f.deps.now, namespace: execution.deps.namespace,
    collectionDependencies: f.deps, executionDependencies: execution.deps };
  const payload = { schema_version: 2, action: 'adjust_bids', setting_id: f.input.settingId, mandate_id: f.input.mandateId,
    reference: f.input.reference, cycle_at: f.state.now.toISOString(), __runtime_namespace: deps.namespace };
  const job = { id: 900, type: JOB_TYPE, origin: ORIGIN, requested_by: null, payload };
  return { ...f, target, before, execution, evaluationDeps: deps, payload, job,
    run: () => collectOptimizationEvidence(f.input, f.deps), evaluate: () => runOptimizationEvaluation(payload, job, deps) };
}

module.exports = { bidFixture };
