'use strict';

const { Op } = require('sequelize');
const { enabled } = require('./campaignWorkspaceOptimizationCommand.service');
const { digest, optimizationReference } = require('./campaignWorkspaceOptimizationCapabilities.service');
const { POLICY, buildAdPauseProposals } = require('./campaignWorkspaceAdPausePolicy.service');
const { buildBidProposals, supportedBidTarget, POLICY: BID_POLICY } = require('./campaignWorkspaceBidPolicy.service');
const { buildBudgetProposals, POLICY: BUDGET_POLICY } = require('./campaignWorkspaceBudgetPolicy.service');
const { buildTargetBidProposals, POLICY: TARGET_POLICY } = require('./campaignWorkspaceTargetBidPolicy.service');
const BUILDERS = { pause_underperforming_ads: buildAdPauseProposals,
  adjust_bids: (evidence, context) => evidence.schema_version === 3 ? buildTargetBidProposals(evidence, context) : buildBidProposals(evidence, context),
  adjust_budget: buildBudgetProposals };

const DISPATCH_TYPE = 'campaign_workspace_optimization_evaluations';
const JOB_TYPE = 'campaign_workspace_optimization_evaluate';
const ORIGIN = 'campaign_workspace_optimization';
const PAGE_SIZE = 50;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const fail = code => { throw Object.assign(new Error(code), { code }); };
const instant = deps => (deps.now || (() => new Date()))();
const runtime = deps => deps.namespace || require('./jobRequests.service').getCurrentRuntimeNamespace();
const modelsFor = deps => deps.models || require('../../models');
const enqueueFor = deps => deps.enqueue || require('./jobRequests.service').enqueueUniqueJobRequest;
const runtimeKeys = ['__runtime_namespace', '__dedupe_scope'];
const permissionError = 'workspace_optimization_permissions_required';
const safeError = error => error?.code === 'invalid_workspace_optimization' ? 'workspace_optimization_evaluation_invalid'
  : /^workspace_optimization_[a-z_]{1,80}$/.test(error?.code || '') ? error.code : 'workspace_optimization_evaluation_unavailable';
const retryable = code => /_(unavailable|rate_limited|timeout|busy)$/.test(code);

function cycle(value, now) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value
    || +new Date(value) > +now || +now - +new Date(value) >= 86400000) fail('workspace_optimization_evaluation_expired');
  return value;
}

async function enqueueOptimizationEvaluations(payload = {}, deps = {}) {
  if (!enabled(deps.env || process.env)) return { status: 'completed', disabled: true, queued: 0 };
  try {
    if (!payload || Array.isArray(payload) || Object.keys(payload).some(key => ![...runtimeKeys, 'cycle_at', 'after_setting_id'].includes(key))
      || payload.after_setting_id != null && !uuid(payload.after_setting_id)
      || payload.__runtime_namespace && payload.__runtime_namespace !== runtime(deps)) fail('workspace_optimization_evaluation_invalid');
    const models = modelsFor(deps); const enqueue = enqueueFor(deps); const now = instant(deps);
    const root = !payload.cycle_at && deps.jobRequestId
      ? await models.JobRequest.findByPk(deps.jobRequestId, { attributes: ['created_at'], raw: true }) : null;
    if (deps.jobRequestId && !payload.cycle_at && !root) fail('workspace_optimization_evaluation_invalid');
    const cycleAt = cycle(payload.cycle_at || new Date(root?.created_at || now).toISOString(), now);
    const settings = await models.CampaignWorkspaceSetting.findAll({ attributes: ['id', 'activation'], where: {
      'activation.mode': 'optimize', 'activation.status': 'active', 'activation.optimization.status': 'active',
      ...(payload.after_setting_id ? { id: { [Op.gt]: payload.after_setting_id } } : {}),
    }, order: [['id', 'ASC']], limit: PAGE_SIZE + 1, raw: true });
    let queued = 0; let duplicates = 0; let invalid = 0;
    for (const setting of settings.slice(0, PAGE_SIZE)) {
      const mandate = setting.activation?.optimization;
      if (!uuid(setting.id) || !uuid(mandate?.id) || !Array.isArray(mandate.authorization?.campaigns)) { invalid++; continue; }
      const actions = Object.keys(BUILDERS).filter(action => mandate.authorization.limits?.actions?.includes(action));
      if (!actions.length) continue;
      const seen = new Set();
      for (const campaign of mandate.authorization.campaigns) {
        if (!Array.isArray(campaign.targets)) continue;
        let reference;
        try { reference = optimizationReference({ provider: campaign.provider, account_id: campaign.account_id, campaign_id: campaign.campaign_id }); }
        catch { invalid++; continue; }
        const key = digest(reference); if (seen.has(key)) continue; seen.add(key);
        for (const action of actions.filter(action => campaign.targets.some(target => target.action === action))) {
          if (!enabled(deps.env || process.env)) return { status: 'completed', disabled: true, queued, duplicates };
          const result = await enqueue({ type: JOB_TYPE, origin: ORIGIN, priority: 'low', maxAttempts: 3,
            payload: { schema_version: 2, action, setting_id: setting.id, mandate_id: mandate.id, reference, cycle_at: cycleAt, __runtime_namespace: runtime(deps) },
            dedupeScope: `${JOB_TYPE}:${setting.id}:${mandate.id}:${key}:${action}:${cycleAt}` });
          if (result.created) queued++; else duplicates++;
        }
      }
    }
    const more = settings.length > PAGE_SIZE;
    if (more && enabled(deps.env || process.env)) await enqueue({ type: DISPATCH_TYPE, origin: ORIGIN, priority: 'low', maxAttempts: 3,
      payload: { cycle_at: cycleAt, after_setting_id: settings[PAGE_SIZE - 1].id, __runtime_namespace: runtime(deps) },
      dedupeScope: `${DISPATCH_TYPE}:${cycleAt}:${settings[PAGE_SIZE - 1].id}` });
    return { status: 'completed', settings: Math.min(settings.length, PAGE_SIZE), queued, duplicates, invalid, continued: more };
  } catch (error) { const code = safeError(error); return { status: 'failed', retryable: retryable(code), error_message: code }; }
}

// Known permission failures must be followed by an explicit successful account/campaign check, not a nightly credential retry.
async function permissionCheckAfterFailure(models, payload, job, now) {
  const failed = await models.JobRequest.findOne({ where: { type: JOB_TYPE, origin: ORIGIN, status: 'failed', id: { [Op.ne]: job.id },
    error_message: permissionError, 'payload.setting_id': payload.setting_id,
    'payload.reference.provider': payload.reference.provider, 'payload.reference.account_id': payload.reference.account_id },
  attributes: ['updated_at'], order: [['updated_at', 'DESC']], raw: true });
  if (!failed) return;
  const event = await models.CampaignWorkspaceEvent.findOne({ where: { setting_id: payload.setting_id, event_type: 'optimization_check',
    'changes.reference.provider': payload.reference.provider, 'changes.reference.account_id': payload.reference.account_id,
    'changes.reference.campaign_id': payload.reference.campaign_id }, attributes: ['changes'], order: [['version', 'DESC']], raw: true });
  const proof = event?.changes;
  if (!Number.isFinite(+new Date(failed.updated_at)) || proof?.status !== 'checked' || proof.error || proof.schema_version !== 1
    || !Number.isFinite(Date.parse(proof.checked_at)) || +new Date(proof.checked_at) <= +new Date(failed.updated_at)
    || +new Date(proof.checked_at) > +now || +new Date(proof.expires_at) !== +new Date(proof.checked_at) + 86400000
    || +new Date(proof.expires_at) <= +now) fail('workspace_optimization_connection_review_required');
}

async function runOptimizationEvaluation(payload, job, deps = {}) {
  if (!enabled(deps.env || process.env)) return { status: 'completed', disabled: true };
  try {
    if (job?.type !== JOB_TYPE || job.origin !== ORIGIN || job.requested_by != null || !Number.isSafeInteger(Number(job.id)) || Number(job.id) <= 0
      || !payload || Array.isArray(payload) || ![1, 2].includes(payload.schema_version) || !uuid(payload.setting_id) || !uuid(payload.mandate_id)
      || (payload.schema_version === 1 ? Object.hasOwn(payload, 'action') : !Object.hasOwn(BUILDERS, payload.action || ''))
      || Object.keys(payload).some(key => ![...runtimeKeys, 'schema_version', 'action', 'setting_id', 'mandate_id', 'reference', 'cycle_at'].includes(key))
      || payload.__runtime_namespace !== runtime(deps) || digest(job.payload) !== digest(payload)) fail('workspace_optimization_evaluation_invalid');
    optimizationReference(payload.reference); cycle(payload.cycle_at, instant(deps));
    const action = payload.schema_version === 1 ? 'pause_underperforming_ads' : payload.action;
    const models = modelsFor(deps);
    await permissionCheckAfterFailure(models, payload, job, instant(deps));
    const collected = await (deps.collect || require('./campaignWorkspaceOptimizationEvidence.service').collectOptimizationEvidence)({
      settingId: payload.setting_id, mandateId: payload.mandate_id, reference: payload.reference, action,
    }, { ...deps.collectionDependencies, models, env: deps.env || process.env, now: () => instant(deps) });
    if (!collected.collected) {
      const code = safeError({ code: collected.reason });
      if (code === permissionError || retryable(code)) return { status: 'failed', retryable: retryable(code), error_message: code };
      return { status: 'completed', result: { skipped: true, reason: code } };
    }
    const evidence = collected.evidence;
    if (evidence.setting_id !== payload.setting_id || evidence.mandate_id !== payload.mandate_id
      || evidence.action !== action || digest(evidence.reference) !== digest(payload.reference)) fail('workspace_optimization_scope_changed');
    const evaluationKey = digest([payload.setting_id, payload.mandate_id, payload.reference, payload.cycle_at]);
    const proposals = BUILDERS[action](evidence, { evaluationKey, now: instant(deps) });
    const enqueue = deps.enqueueAdjustment || require('./campaignWorkspaceOptimizationExecution.service').enqueueOptimizationAdjustment;
    let queued = 0; let duplicates = 0;
    for (const proposal of proposals) {
      if (!enabled(deps.env || process.env)) return { status: 'completed', disabled: true, result: { queued, duplicates } };
      cycle(payload.cycle_at, instant(deps));
      const result = await enqueue({ settingId: payload.setting_id, mandateId: payload.mandate_id, ...proposal },
        { ...deps.executionDependencies, models, env: deps.env || process.env, now: () => instant(deps), namespace: runtime(deps) });
      if (result.disabled || result.reason === 'workspace_optimization_disabled') return { status: 'completed', disabled: true, result: { queued, duplicates } };
      if (result.created) queued++; else if (result.runId) duplicates++;
    }
    const targetRecommendation = action === 'adjust_bids' && evidence.schema_version === 3;
    const noProposalReason = targetRecommendation ? 'workspace_optimization_target_recommendation_required'
      : !evidence.attribution.complete ? 'workspace_optimization_attribution_incomplete'
      : action === 'adjust_bids' && !evidence.authorization_targets.some(target => supportedBidTarget(target, evidence.reference))
        ? 'workspace_optimization_bid_goal_evidence_required' : 'workspace_optimization_sample_or_difference_insufficient';
    return { status: 'completed', result: { evaluated: 1, action, proposals: proposals.length, queued, duplicates,
      rule_version: targetRecommendation ? TARGET_POLICY.version : action === 'adjust_bids' ? BID_POLICY.version : action === 'adjust_budget' ? BUDGET_POLICY.version : POLICY.version,
      ...(proposals.length ? {} : { reason: noProposalReason }) } };
  } catch (error) {
    const code = safeError(error);
    if (code === 'workspace_optimization_connection_review_required') return { status: 'completed', result: { skipped: true, reason: code } };
    return { status: 'failed', retryable: retryable(code), error_message: code };
  }
}

module.exports = { DISPATCH_TYPE, JOB_TYPE, ORIGIN, PAGE_SIZE, enqueueOptimizationEvaluations, runOptimizationEvaluation };
