'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { optimizationChange } = require('../../../services/campaignWorkspaceOptimizationCommand.service');
const { enqueueOptimizationAdjustment, runOptimizationAdjustmentJob } = require('../../../services/campaignWorkspaceOptimizationExecution.service');

const error = code => Object.assign(new Error(code), { code });
function matches(row, where) {
  return Reflect.ownKeys(where).every(key => {
    if (key === Op.or) return where[key].some(part => matches(row, part));
    const value = where[key];
    if (!value || typeof value !== 'object' || value instanceof Date) return row[key] === value;
    return Reflect.ownKeys(value).every(op => op === Op.ne ? row[key] !== value[op]
      : op === Op.in ? value[op].includes(row[key]) : op === Op.gt ? row[key] != null && +new Date(row[key]) > +new Date(value[op])
        : op === Op.lte ? row[key] != null && +new Date(row[key]) <= +new Date(value[op]) : false);
  });
}

function fixture(provider = 'google_ads', action = 'adjust_bids') {
  const google = provider === 'google_ads'; const reference = { provider, account_id: '20', campaign_id: '30' };
  const target = action === 'adjust_budget'
    ? { action, entity: google ? 'campaign_budget' : 'ad_set', id: '50', resource: google ? 'customers/20/campaignBudgets/50' : '50', field: google ? 'amount_micros' : 'daily_budget', unit: google ? 'micros' : 'minor' }
    : { action, entity: google ? 'ad_group' : 'ad_set', id: '50', resource: google ? 'customers/20/adGroups/50' : '50',
      field: google ? 'cpc_bid_micros' : 'bid_amount', unit: google ? 'micros' : 'minor', strategy: google ? 'MANUAL_CPC' : 'COST_CAP' };
  const change = optimizationChange({ reference, target, before: '1000', after: '900' });
  const setting = { id: crypto.randomUUID(), scope_type: 'clinic', scope_id: 1, activation: { optimization: {
    id: crypto.randomUUID(), status: 'active', authorization: { clinic_ids: [1] } } } };
  const evidence = { schema_version: 1, rule: action === 'adjust_budget' ? 'budget_efficiency' : 'bid_efficiency',
    observed_at: '2026-09-11T12:00:00Z', window_start: '2026-09-01', window_end: '2026-09-10',
    metrics: { clicks: 120, leads: 2, cost_cents: 10000, baseline_clicks: 120, baseline_leads: 10, baseline_cost_cents: 10000 } };
  const state = { runs: new Map(), jobs: new Map(), remote: change.before, now: new Date('2026-09-11T12:00:00Z'),
    calls: { read: 0, mutate: 0, inspect: 0, authorize: 0 }, permitted: true, failEnqueue: false, lostCommit: false };
  const wrap = source => {
    if (!source) return null;
    const row = { ...structuredClone(source), get: () => structuredClone(source), update: async patch => {
      Object.assign(source, structuredClone(patch)); Object.assign(row, structuredClone(patch)); return row;
    } };
    return row;
  };
  // Serializable, rollback-capable in-memory store. Provider calls stay outside the transaction mutex.
  let mutex = Promise.resolve();
  const models = { sequelize: { transaction: async fn => {
    const previous = mutex; let release; mutex = new Promise(resolve => { release = resolve; }); await previous;
    const before = structuredClone({ runs: state.runs, jobs: state.jobs }); let committed = false;
    try {
      const result = await fn({ LOCK: { UPDATE: 'UPDATE' } }); committed = true;
      if (state.lostCommit && [...state.runs.values()].some(row => row.status === 'submitted')) {
        state.lostCommit = false; throw error('workspace_optimization_unavailable');
      }
      return result;
    } catch (err) { if (!committed) Object.assign(state, before); throw err; }
    finally { release(); }
  } }, CampaignWorkspaceSetting: { findByPk: async id => id === setting.id ? structuredClone(setting) : null },
  JobRequest: { findByPk: async id => wrap(state.jobs.get(id)) },
  CampaignWorkspaceOptimizationRun: {
    findByPk: async id => wrap(state.runs.get(id)),
    findOne: async ({ where }) => wrap([...state.runs.values()].find(row => matches(row, where))),
    findAll: async ({ where }) => [...state.runs.values()].filter(row => matches(row, where)).map(wrap),
    create: async row => { state.runs.set(row.id, structuredClone(row)); return wrap(state.runs.get(row.id)); },
  } };
  const deps = { models, namespace: 'isolated-test', now: () => state.now,
    env: { CAMPAIGN_WORKSPACE_ACTIVATION_ENABLED: 'true', CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED: 'true' },
    lockAccounts: async () => {},
    authorize: async ({ setting: current, campaign, readOnly }) => {
      state.calls.authorize++;
      if (!state.permitted) throw error('workspace_optimization_permissions_required');
      if (!(readOnly ? ['active', 'paused'] : ['active']).includes(current.activation.optimization.status)) throw error('workspace_optimization_authorization_required');
      return { entry: { clinic_id: 1, targets: [target] }, limits: { cooldown_hours: 24, monthly_limit_cents: 100000 },
        context: { reference: campaign, grant: { connection: { id: 1, accessToken: 'fixture-only' }, loginCustomerId: null } } };
    },
    ensureToken: async () => ({ accessToken: 'fixture-only' }),
    enqueue: async request => {
      if (state.failEnqueue) throw error('workspace_optimization_unavailable');
      const job = { id: state.jobs.size + 1, status: 'pending', ...structuredClone(request) }; state.jobs.set(job.id, job); return { job, created: true };
    },
    read: async () => { state.calls.read++; return state.remote; },
    inspect: async () => { state.calls.inspect++; },
    mutate: async () => { state.calls.mutate++; state.remote = change.after; return { acknowledged: true }; },
  };
  return { state, setting, change, evidence, deps,
    enqueue: patch => enqueueOptimizationAdjustment({ settingId: setting.id, mandateId: setting.activation.optimization.id, change, evidence, ...patch }, deps),
    run: async (id = 1, payloadPatch = {}) => {
      const job = state.jobs.get(id); job.status = 'running';
      const result = await runOptimizationAdjustmentJob({ ...job.payload, ...payloadPatch }, job, { ...deps, readOnly: job.type.endsWith('_check') });
      job.status = result.status === 'failed' && result.retryable ? 'waiting' : result.status; return result;
    },
    row: (id = 1) => state.runs.get(state.jobs.get(id)?.payload.run_id),
  };
}
module.exports = { fixture, error };
