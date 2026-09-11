'use strict';

const crypto = require('node:crypto');
const { Op } = require('sequelize');
const { enabled, verifyChange, inspectOptimizationChange, readOptimizationValue, desiredState, mutateOptimizationChange } = require('./campaignWorkspaceOptimizationCommand.service');
const { resolveOptimizationAuthorization, lockOptimizationAccounts } = require('./campaignWorkspaceOptimizationAuthorization.service');
const { digest } = require('./campaignWorkspaceOptimizationCapabilities.service');
const { hasMarketingClinicScopeAccess } = require('../lib/marketingScopeAccess');
const { ensureGoogleConnectionAccessToken, GOOGLE_ADS_SCOPE } = require('./googleAdsScopedRuntime.service');

const JOB_TYPE = 'campaign_workspace_optimization_apply';
const ORIGIN = 'campaign_workspace_optimization';
const LEASE_MS = 120000;
const TERMINAL = ['verified', 'observed', 'skipped'];
const RETRYABLE = ['workspace_optimization_busy', 'workspace_optimization_account_busy', 'workspace_optimization_unavailable'];
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const reason = error => /^workspace_optimization_[a-z_]{1,80}$/.test(error?.code || '') ? error.code : 'workspace_optimization_unavailable';
const plain = row => row?.get ? row.get({ plain: true }) : structuredClone(row);
const now = deps => (deps.now || (() => new Date()))();
const namespace = deps => deps.namespace || require('./jobRequests.service').getCurrentRuntimeNamespace();
const model = deps => deps.models || require('../../models');
const query = transaction => ({ transaction, ...(transaction ? { lock: transaction.LOCK.UPDATE } : {}) });
const resourceKey = change => digest([change.reference.provider, change.reference.account_id, change.target.resource]);

function evidenceSnapshot(evidence, instant, action) {
  const allowed = ['schema_version', 'rule', 'observed_at', 'window_start', 'window_end', 'metrics'];
  const metrics = ['clicks', 'leads', 'cost_cents', 'baseline_clicks', 'baseline_leads', 'baseline_cost_cents'];
  const rules = { ad_underperformance: 'pause_underperforming_ads', bid_efficiency: 'adjust_bids',
    search_without_results: 'negative_keywords', budget_efficiency: 'adjust_budget' };
  const day = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
  if (!evidence || Object.keys(evidence).some(key => !allowed.includes(key)) || evidence.schema_version !== 1
    || !Object.hasOwn(rules, evidence.rule) || action && rules[evidence.rule] !== action
    || !day(evidence.window_start) || !day(evidence.window_end)
    || !Number.isFinite(Date.parse(evidence.observed_at)) || +new Date(evidence.observed_at) > +instant
    || +new Date(evidence.observed_at) < +instant - 86400000 || +new Date(evidence.window_end) > +instant
    || +new Date(evidence.window_end) - +new Date(evidence.window_start) < 6 * 86400000
    || +new Date(evidence.window_end) - +new Date(evidence.window_start) > 90 * 86400000
    || !evidence.metrics || Array.isArray(evidence.metrics)
    || metrics.slice(0, evidence.rule === 'search_without_results' ? 3 : 6).some(key => !Object.hasOwn(evidence.metrics, key))
    || evidence.rule === 'search_without_results' && evidence.metrics.leads !== 0
    || Object.entries(evidence.metrics).some(([name, value]) => !metrics.includes(name) || !Number.isSafeInteger(value) || value < 0)) fail('workspace_optimization_evidence_invalid');
  return structuredClone(evidence);
}

function validateRun(run) {
  const change = verifyChange(run.change);
  if (!uuid(run.id) || !uuid(run.mandate_id) || run.resource_key !== resourceKey(change)
    || run.provider !== change.reference.provider || run.account_id !== change.reference.account_id || run.campaign_id !== change.reference.campaign_id
    || run.plan_key !== digest([run.mandate_id, change.fingerprint, run.evidence])) fail('workspace_optimization_plan_changed');
  return change;
}

function samePlan(run, previous) {
  validateRun(run);
  const identity = row => [row.id, row.setting_id, row.mandate_id, row.runtime_namespace, row.plan_key, row.job_request_id];
  if (digest(identity(run)) !== digest(identity(previous))) fail('workspace_optimization_plan_changed');
}

async function authorize(run, deps, transaction = null) {
  const models = model(deps); const change = validateRun(run);
  const setting = await models.CampaignWorkspaceSetting.findByPk(run.setting_id, query(transaction));
  if (!setting || setting.activation?.optimization?.id !== run.mandate_id) fail('workspace_optimization_mandate_changed');
  const clinicIds = setting.activation.optimization.authorization?.clinic_ids;
  if (!Array.isArray(clinicIds) || !clinicIds.length) fail('workspace_optimization_mandate_changed');
  const scope = { groupId: setting.scope_type === 'group' ? setting.scope_id : null, clinicIds };
  const source = await (deps.authorize || resolveOptimizationAuthorization)({ models, setting, scope, campaign: change.reference,
    action: change.target.action, transaction, now: now(deps), hasAccess: deps.hasAccess || hasMarketingClinicScopeAccess });
  const targets = source.entry.targets.filter(target => Object.keys(target).length === Object.keys(change.target).length
    && Object.entries(change.target).every(([key, value]) => target[key] === value));
  if (targets.length !== 1) fail('workspace_optimization_target_not_authorized');
  return { ...source, setting, scope };
}

// Internal producer only. Jobs carry an immutable run ID, not arbitrary provider operations.
async function enqueueOptimizationAdjustment({ settingId, mandateId, change, evidence }, deps = {}) {
  if (!enabled(deps.env || process.env)) return { queued: false, reason: 'workspace_optimization_disabled' };
  const models = model(deps); const command = verifyChange(change); const proof = evidenceSnapshot(evidence, now(deps), command.target.action);
  const row = { id: crypto.randomUUID(), runtime_namespace: namespace(deps), setting_id: settingId, mandate_id: mandateId,
    plan_key: digest([mandateId, command.fingerprint, proof]), provider: command.reference.provider, account_id: command.reference.account_id,
    campaign_id: command.reference.campaign_id, resource_key: resourceKey(command), change: command, evidence: proof,
    status: 'queued', job_request_id: null, lease_token: null, lease_until: null, submitted_at: null, completed_at: null, outcome: null };
  return models.sequelize.transaction(async transaction => {
    await authorize(row, deps, transaction);
    const existing = await models.CampaignWorkspaceOptimizationRun.findOne({ where: { setting_id: settingId, plan_key: row.plan_key }, ...query(transaction) });
    if (existing) return { queued: !TERMINAL.includes(existing.status), created: false, runId: existing.id, jobId: existing.job_request_id };
    const run = await models.CampaignWorkspaceOptimizationRun.create(row, { transaction });
    const queued = await (deps.enqueue || require('./jobRequests.service').enqueueUniqueJobRequest)({ type: JOB_TYPE, origin: ORIGIN,
      priority: 'low', maxAttempts: 5, payload: { schema_version: 1, run_id: run.id, __runtime_namespace: row.runtime_namespace },
      dedupeScope: `workspace_optimization:${run.id}` }, { transaction });
    await run.update({ job_request_id: queued.job.id }, { transaction });
    return { queued: true, created: true, runId: run.id, jobId: queued.job.id };
  });
}

function jobMatches(run, payload, job, deps) {
  return run && run.id === payload.run_id && run.job_request_id === Number(job?.id) && run.runtime_namespace === namespace(deps)
    && payload.__runtime_namespace === run.runtime_namespace && job?.type === JOB_TYPE && job.origin === ORIGIN
    && job.payload?.schema_version === 1 && job.payload.run_id === run.id && job.payload.__runtime_namespace === run.runtime_namespace;
}

async function reserve(payload, job, deps) {
  const models = model(deps);
  return models.sequelize.transaction(async transaction => {
    const original = await models.CampaignWorkspaceOptimizationRun.findByPk(payload.run_id, { transaction });
    if (!jobMatches(original, payload, job, deps)) fail('workspace_optimization_job_mismatch');
    validateRun(original);
    if (TERMINAL.includes(original.status)) return { terminal: true, run: plain(original) };
    const authorization = await authorize(original, deps, transaction);
    await (deps.lockAccounts || lockOptimizationAccounts)({ models, campaigns: [original.change.reference], transaction });
    const run = await models.CampaignWorkspaceOptimizationRun.findByPk(original.id, query(transaction));
    samePlan(run, original);
    if (TERMINAL.includes(run.status)) return { terminal: true, run: plain(run) };
    if (run.lease_token && +new Date(run.lease_until) > +now(deps)) fail('workspace_optimization_busy');
    const pending = await models.CampaignWorkspaceOptimizationRun.findAll({ where: { id: { [Op.ne]: run.id },
      status: { [Op.in]: ['leased', 'submitted', 'uncertain'] }, [Op.or]: [{ setting_id: run.setting_id }, { provider: run.provider, account_id: run.account_id }] }, ...query(transaction) });
    if (pending.length) fail('workspace_optimization_account_busy');
    if (!run.submitted_at) {
      evidenceSnapshot(run.evidence, now(deps), run.change.target.action);
      const recent = await models.CampaignWorkspaceOptimizationRun.findOne({ where: { id: { [Op.ne]: run.id }, resource_key: run.resource_key,
        submitted_at: { [Op.gt]: new Date(+now(deps) - authorization.limits.cooldown_hours * 3600000) } }, ...query(transaction) });
      if (recent) fail('workspace_optimization_cooldown');
    }
    const token = crypto.randomUUID();
    await run.update({ lease_token: token, lease_until: new Date(+now(deps) + LEASE_MS), status: run.submitted_at ? 'submitted' : 'leased' }, { transaction });
    return { run: plain(run), token, authorization };
  });
}

async function finish(run, token, state, outcome, deps) {
  const models = model(deps);
  return models.sequelize.transaction(async transaction => {
    const row = await models.CampaignWorkspaceOptimizationRun.findByPk(run.id, query(transaction));
    if (!row || row.lease_token !== token) fail('workspace_optimization_lease_changed');
    if (['verified', 'observed'].includes(state)) samePlan(row, run);
    // A transaction can commit even if its acknowledgement is lost. Trust the durable marker, not a local flag.
    if (row.submitted_at && ['queued', 'skipped'].includes(state)) {
      state = 'uncertain';
      outcome = { ...outcome, submission_reserved: true };
    }
    await row.update({ status: state, outcome, lease_token: null, lease_until: null,
      completed_at: TERMINAL.includes(state) ? now(deps) : null }, { transaction });
    return { status: 'completed', result: { run_id: row.id, state, ...outcome } };
  });
}

async function credentialsFor(authorization, deps) {
  const context = authorization.context; const connection = context.grant.connection;
  if (context.reference.provider !== 'google_ads') return { accessToken: connection.accessToken };
  const token = await (deps.ensureToken || ensureGoogleConnectionAccessToken)(connection, { requiredScopes: [GOOGLE_ADS_SCOPE] });
  return { accessToken: token.accessToken, loginCustomerId: context.grant.loginCustomerId };
}

async function markSubmitted(run, token, deps) {
  const models = model(deps);
  return models.sequelize.transaction(async transaction => {
    if (!enabled(deps.env || process.env)) fail('workspace_optimization_disabled');
    await authorize(run, deps, transaction);
    const fresh = await models.CampaignWorkspaceOptimizationRun.findByPk(run.id, query(transaction));
    if (!fresh || fresh.lease_token !== token || fresh.status !== 'leased' || fresh.submitted_at || +new Date(fresh.lease_until) <= +now(deps)) fail('workspace_optimization_lease_changed');
    samePlan(fresh, run);
    await fresh.update({ status: 'submitted', submitted_at: now(deps), lease_until: new Date(+now(deps) + LEASE_MS) }, { transaction });
  });
}

async function skipUnreserved(payload, job, code, deps) {
  return model(deps).sequelize.transaction(async transaction => {
    const row = await model(deps).CampaignWorkspaceOptimizationRun.findByPk(payload.run_id, query(transaction));
    if (!jobMatches(row, payload, job, deps) || row.status !== 'queued' || row.lease_token || row.submitted_at) return;
    validateRun(row);
    await row.update({ status: 'skipped', completed_at: now(deps), outcome: { reason: code, provider_mutation: false } }, { transaction });
  });
}

async function runOptimizationAdjustmentJob(payload, job, deps = {}) {
  if (!enabled(deps.env || process.env)) return { status: 'completed', result: { skipped: true, reason: 'workspace_optimization_disabled' } };
  if (payload?.schema_version !== 1 || !uuid(payload.run_id) || Object.keys(payload).some(key => !['schema_version', 'run_id', '__runtime_namespace', '__dedupe_scope'].includes(key))) {
    return { status: 'failed', retryable: false, error_message: 'workspace_optimization_job_invalid' };
  }
  let reservation; let submitted = false;
  try {
    reservation = await reserve(payload, job, deps);
    const { run, token, authorization } = reservation;
    if (reservation.terminal) return { status: 'completed', result: { run_id: run.id, state: run.status, idempotent: true } };
    submitted = !!run.submitted_at;
    const credentials = await credentialsFor(authorization, deps);
    const read = deps.read || readOptimizationValue;
    const value = await read(run.change, credentials, deps.providerDependencies);
    if (desiredState(run.change, value)) {
      await authorize(run, deps);
      return await finish(run, token, 'observed', { reason: 'desired_state_observed', provider_mutation: false }, deps);
    }
    // A submitted marker survives a crash before/after HTTP. Never replay that write.
    if (submitted) return await finish(run, token, 'uncertain', { reason: 'workspace_optimization_manual_review_required', provider_mutation: false }, deps);
    await (deps.inspect || inspectOptimizationChange)(run.change, credentials, deps.providerDependencies);
    if (run.change.target.action === 'adjust_budget') {
      // The global monthly envelope must be collected by the budget accounting service, not inferred per campaign.
      if (!deps.verifyBudget || await deps.verifyBudget({ run, authorization, credentials }) !== true) fail('workspace_optimization_budget_accounting_required');
    }
    const current = await authorize(run, deps);
    if (current.context.grant.connection.id !== authorization.context.grant.connection.id) fail('workspace_optimization_connection_changed');
    await markSubmitted(run, token, deps); submitted = true;
    let receipt; let failure;
    try { receipt = await (deps.mutate || mutateOptimizationChange)(run.change, credentials, { ...deps.providerDependencies, env: deps.env || process.env }); }
    catch (error) { failure = error; }
    await authorize(run, deps);
    const observed = await read(run.change, credentials, deps.providerDependencies);
    if (desiredState(run.change, observed)) return await finish(run, token, receipt?.acknowledged ? 'verified' : 'observed', {
      reason: receipt?.acknowledged ? 'provider_change_verified' : 'desired_state_observed', provider_mutation: true, acknowledged: receipt?.acknowledged === true,
    }, deps);
    return await finish(run, token, 'uncertain', { reason: failure ? reason(failure) : 'workspace_optimization_response_unconfirmed', provider_mutation: true }, deps);
  } catch (error) {
    const code = reason(error);
    if (reservation?.token) {
      try {
        const retry = !submitted && RETRYABLE.includes(code);
        const result = await finish(reservation.run, reservation.token, submitted ? 'uncertain' : retry ? 'queued' : 'skipped',
          { reason: code, provider_mutation: submitted }, deps);
        return result.result.state === 'queued' ? { status: 'failed', retryable: true, error_message: code } : result;
      }
      catch { return { status: 'failed', retryable: true, error_message: 'workspace_optimization_receipt_unconfirmed' }; }
    }
    const retryable = RETRYABLE.includes(code);
    if (!retryable) {
      try { await skipUnreserved(payload, job, code, deps); }
      catch { return { status: 'failed', retryable: false, error_message: code }; }
    }
    return { status: 'failed', retryable, error_message: code };
  }
}

module.exports = { JOB_TYPE, ORIGIN, LEASE_MS, evidenceSnapshot, enqueueOptimizationAdjustment, runOptimizationAdjustmentJob };
