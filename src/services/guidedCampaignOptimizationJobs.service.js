'use strict';

const db = require('../../models');
const { Op } = require('sequelize');
const jobRequestsService = require('./jobRequests.service');
const {
  applyGuidedCampaignGoalPolicy,
  provisionGuidedCampaignOptimization,
} = require('./guidedCampaignOptimizationPolicy.service');
const {
  acquireGuidedTransitionLease,
  failGuidedTransition,
  finalizeGuidedTransition,
} = require('./guidedCampaignOptimizationTransitions.service');

const JOB_TYPE = 'guided_campaign_goal_policy_apply';

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

async function enqueueGuidedLifecycleTransition({
  policyId,
  evaluationId,
  strategyId,
  dependencies = {},
} = {}) {
  const normalizedPolicyId = positiveInteger(policyId);
  const normalizedEvaluationId = positiveInteger(evaluationId);
  const normalizedStrategyId = positiveInteger(strategyId);
  if (!normalizedPolicyId || !normalizedEvaluationId || !normalizedStrategyId) {
    throw new TypeError('policyId, evaluationId y strategyId son obligatorios');
  }
  const jobs = dependencies.jobRequestsService || jobRequestsService;
  const queued = await jobs.enqueueUniqueJobRequest({
    type: JOB_TYPE,
    payload: {
      strategy_id: normalizedStrategyId,
      policy_id: normalizedPolicyId,
      evaluation_id: normalizedEvaluationId,
    },
    dedupeScope: `guided-transition:evaluation:${normalizedEvaluationId}`,
    priority: 'high',
    status: 'pending',
    origin: 'marketing:guided_improvement_daily_evaluation',
    requestedBy: null,
    requestedByName: 'Clinicaclick',
    requestedByRole: 'system',
    maxAttempts: 5,
  }, dependencies.enqueueOptions || {});
  return queued;
}

async function enqueueReadyGuidedLifecycleTransitions(candidates = [], dependencies = {}) {
  const report = { discovered: 0, queued: 0, idempotent: 0, failed: 0, jobs: [], errors: [] };
  const unique = new Map();
  for (const item of Array.isArray(candidates) ? candidates : []) {
    const evaluationId = positiveInteger(item?.evaluation_id ?? item?.evaluationId);
    if (!evaluationId) continue;
    unique.set(evaluationId, item);
  }
  report.discovered = unique.size;
  for (const item of unique.values()) {
    try {
      const queued = await enqueueGuidedLifecycleTransition({
        policyId: item.policy_id ?? item.policyId,
        evaluationId: item.evaluation_id ?? item.evaluationId,
        strategyId: item.strategy_id ?? item.strategyId,
        dependencies,
      });
      if (queued.created) report.queued += 1;
      else report.idempotent += 1;
      report.jobs.push({
        evaluation_id: positiveInteger(item.evaluation_id ?? item.evaluationId),
        job_request_id: positiveInteger(queued.job?.id),
        created: queued.created === true,
      });
    } catch (error) {
      report.failed += 1;
      report.errors.push({
        evaluation_id: positiveInteger(item?.evaluation_id ?? item?.evaluationId),
        code: error.code || null,
        message: error.message,
      });
    }
  }
  return report;
}

/**
 * Durable reconciliation for the evaluation -> JobRequest boundary.
 *
 * A process can die after committing an Evaluation and before enqueueing the
 * provider job. This scan always considers the latest evaluation per active
 * guided policy and enqueueUnique closes that gap without a second mutable
 * outbox table. Applied evaluations are excluded by the policy marker.
 */
async function reconcileReadyGuidedLifecycleTransitions({ candidates = [] } = {}, dependencies = {}) {
  const Policy = dependencies.Policy || db.CampaignOptimizationPolicy;
  const Evaluation = dependencies.Evaluation || db.CampaignOptimizationEvaluation;
  const operators = dependencies.operators || Op;
  const policies = await Policy.findAll({
    where: {
      mode: 'guided_improvement',
      status: 'active',
      strategyId: { [operators.ne]: null },
    },
    order: [['id', 'ASC']],
  });
  const policyIds = policies.map((item) => positiveInteger(item?.id)).filter(Boolean);
  const evaluations = policyIds.length
    ? await Evaluation.findAll({
        where: { policyId: { [operators.in]: policyIds } },
        order: [['policyId', 'ASC'], ['evaluatedAt', 'DESC'], ['id', 'DESC']],
      })
    : [];
  const latestByPolicy = new Map();
  for (const row of evaluations) {
    const data = row?.get ? row.get({ plain: true }) : row;
    const policyId = positiveInteger(data?.policyId);
    if (policyId && !latestByPolicy.has(policyId)) latestByPolicy.set(policyId, data);
  }
  const discovered = [];
  for (const policyModel of policies) {
    const policy = policyModel?.get ? policyModel.get({ plain: true }) : policyModel;
    const evaluation = latestByPolicy.get(positiveInteger(policy?.id));
    const appliedEvaluationId = positiveInteger(policy?.lifecycleState?.approved_transition?.evaluation_id);
    if (
      evaluation?.status === 'ready'
      && evaluation?.readyForApproval === true
      && evaluation?.eligibleNow === true
      && positiveInteger(evaluation.id) !== appliedEvaluationId
    ) {
      discovered.push({
        policy_id: positiveInteger(policy.id),
        strategy_id: positiveInteger(policy.strategyId),
        evaluation_id: positiveInteger(evaluation.id),
      });
    }
  }
  // Candidates keep the function useful with test doubles and also cover the
  // just-committed rows in case a replica-backed scan is briefly stale.
  return enqueueReadyGuidedLifecycleTransitions([...candidates, ...discovered], dependencies);
}

async function enqueueGuidedGoalPolicyApply({
  strategyId,
  requestedBy = null,
  requestedByName = null,
  requestedByRole = null,
  transaction = null,
  triggerImmediately = true,
  dependencies = {},
} = {}) {
  const id = positiveInteger(strategyId);
  if (!id) throw new TypeError('strategyId es obligatorio');
  const jobs = dependencies.jobRequestsService || jobRequestsService;
  const queued = await jobs.enqueueUniqueJobRequest({
    type: JOB_TYPE,
    payload: { strategy_id: id },
    dedupeScope: `guided-activation:strategy:${id}`,
    priority: 'high',
    status: 'pending',
    origin: 'marketing:guided_improvement_activation',
    requestedBy: positiveInteger(requestedBy),
    requestedByName,
    requestedByRole,
    maxAttempts: 5,
  }, transaction ? { transaction } : undefined);
  const job = queued.job;

  if (triggerImmediately && !transaction) {
    const scheduler = dependencies.jobScheduler || require('./jobScheduler.service');
    scheduler.triggerImmediate(job.id).catch((error) => {
      console.error('No se pudo despertar el job de Mejora; seguirá durable en cola:', error.message);
    });
  }
  return job;
}

function triggerGuidedGoalPolicyJob(jobId, dependencies = {}) {
  const id = positiveInteger(jobId);
  if (!id) return;
  const scheduler = dependencies.jobScheduler || require('./jobScheduler.service');
  scheduler.triggerImmediate(id).catch((error) => {
    console.error('No se pudo despertar el job de Mejora; seguirá durable en cola:', error.message);
  });
}

async function runGuidedGoalPolicyApplyJob(payload = {}, dependencies = {}) {
  const strategyId = positiveInteger(payload.strategy_id ?? payload.strategyId);
  if (!strategyId) {
    const error = new Error('guided_campaign_goal_policy_apply requiere strategy_id');
    error.code = 'GUIDED_STRATEGY_ID_REQUIRED';
    throw error;
  }
  const Campaign = dependencies.Campaign || db.Campaign;
  const CampaignRequest = dependencies.CampaignRequest || db.CampaignRequest;
  const campaign = await Campaign.findByPk(strategyId);
  if (!campaign) {
    return { status: 'completed', result: { strategy_id: strategyId, skipped: true, reason: 'strategy_not_found' } };
  }
  const rows = await CampaignRequest.findAll({
    where: { campaign_id: strategyId },
    order: [['updated_at', 'DESC'], ['id', 'DESC']],
  });
  const strategyRow = rows.find((row) => {
    const requestPayload = row?.solicitud && typeof row.solicitud === 'object' ? row.solicitud : {};
    return requestPayload.kind === 'marketing_strategy';
  });
  if (!strategyRow) {
    return { status: 'completed', result: { strategy_id: strategyId, skipped: true, reason: 'strategy_payload_not_found' } };
  }
  const strategyPayload = strategyRow.solicitud;
  if (String(strategyPayload.status || '').trim().toLowerCase() !== 'active') {
    return { status: 'completed', result: { strategy_id: strategyId, skipped: true, reason: 'strategy_not_active' } };
  }
  const provisioning = await (dependencies.provision || provisionGuidedCampaignOptimization)({
    campaign,
    payload: strategyPayload,
    dependencies: dependencies.provisioningDependencies || {},
  });
  const applied = await (dependencies.apply || applyGuidedCampaignGoalPolicy)({
    provisioning,
    actorUserId: provisioning.plan.authorization.accepted_by_user_id,
    dependencies: dependencies.applicationDependencies || {},
  });
  return {
    status: 'completed',
    result: {
      strategy_id: strategyId,
      policy_id: provisioning.policy.id,
      stage: provisioning.plan.stage,
      customer_ids: provisioning.plan.customer_ids,
      campaign_count: provisioning.plan.campaign_ids.length,
      provider_outcome: applied.result?.outcome || null,
      readback_healthy: applied.result?.verification?.healthy === true,
    },
  };
}

async function runGuidedLifecycleTransitionJob(payload = {}, dependencies = {}) {
  const policyId = positiveInteger(payload.policy_id ?? payload.policyId);
  const evaluationId = positiveInteger(payload.evaluation_id ?? payload.evaluationId);
  const strategyId = positiveInteger(payload.strategy_id ?? payload.strategyId);
  if (!policyId || !evaluationId || !strategyId) {
    const error = new Error('La transición guiada requiere strategy_id, policy_id y evaluation_id');
    error.code = 'GUIDED_TRANSITION_ID_REQUIRED';
    throw error;
  }
  const lease = await (dependencies.acquireLease || acquireGuidedTransitionLease)({
    policyId,
    evaluationId,
    dependencies: dependencies.transitionDependencies || {},
  });
  if (lease.already_applied) {
    return {
      status: 'completed',
      result: { strategy_id: strategyId, policy_id: policyId, evaluation_id: evaluationId, idempotent: true },
    };
  }
  const token = lease.token;
  try {
    const Campaign = dependencies.Campaign || db.Campaign;
    const CampaignRequest = dependencies.CampaignRequest || db.CampaignRequest;
    const policyRow = lease.policy?.get ? lease.policy.get({ plain: true }) : lease.policy;
    if (positiveInteger(policyRow?.strategyId) !== strategyId) {
      const error = new Error('La estrategia del job no coincide con la policy evaluada');
      error.code = 'GUIDED_TRANSITION_STRATEGY_MISMATCH';
      throw error;
    }
    const campaign = await Campaign.findByPk(strategyId);
    if (!campaign) {
      const error = new Error('La estrategia ya no existe');
      error.code = 'GUIDED_STRATEGY_NOT_FOUND';
      throw error;
    }
    const rows = await CampaignRequest.findAll({
      where: { campaign_id: strategyId },
      order: [['updated_at', 'DESC'], ['id', 'DESC']],
    });
    const strategyRow = rows.find((row) => {
      const requestPayload = row?.solicitud && typeof row.solicitud === 'object' ? row.solicitud : {};
      return requestPayload.kind === 'marketing_strategy';
    });
    const strategyPayload = strategyRow?.solicitud;
    if (!strategyPayload || String(strategyPayload.status || '').trim().toLowerCase() !== 'active') {
      const error = new Error('La estrategia ya no está activa');
      error.code = 'GUIDED_STRATEGY_NOT_ACTIVE';
      throw error;
    }
    const targetStage = lease.verified.transition.to_stage;
    const provisioning = await (dependencies.provision || provisionGuidedCampaignOptimization)({
      campaign,
      payload: strategyPayload,
      targetStage,
      transitionLeaseToken: token,
      dependencies: dependencies.provisioningDependencies || {},
    });
    const applied = await (dependencies.apply || applyGuidedCampaignGoalPolicy)({
      provisioning,
      actorUserId: lease.verified.actor_user_id,
      finalizePolicy: false,
      dependencies: dependencies.applicationDependencies || {},
    });
    const finalized = await (dependencies.finalize || finalizeGuidedTransition)({
      policyId,
      evaluationId,
      leaseToken: token,
      providerResult: {
        ...applied.result,
        digests: applied.preview?.digests || [],
      },
      dependencies: dependencies.transitionDependencies || {},
    });
    return {
      status: 'completed',
      result: {
        strategy_id: strategyId,
        policy_id: policyId,
        evaluation_id: evaluationId,
        from_stage: finalized.transition.from_stage,
        stage: finalized.transition.to_stage,
        provider_outcome: applied.result?.outcome || null,
        readback_healthy: applied.result?.verification?.healthy === true,
      },
    };
  } catch (error) {
    await (dependencies.fail || failGuidedTransition)({
      policyId,
      evaluationId,
      leaseToken: token,
      error,
      dependencies: dependencies.transitionDependencies || {},
    }).catch((releaseError) => {
      error.leaseReleaseError = releaseError.message;
    });
    throw error;
  }
}

async function runGuidedCampaignOptimizationJob(payload = {}, dependencies = {}) {
  return positiveInteger(payload.evaluation_id ?? payload.evaluationId)
    ? runGuidedLifecycleTransitionJob(payload, dependencies)
    : runGuidedGoalPolicyApplyJob(payload, dependencies);
}

module.exports = {
  JOB_TYPE,
  enqueueGuidedGoalPolicyApply,
  enqueueGuidedLifecycleTransition,
  enqueueReadyGuidedLifecycleTransitions,
  reconcileReadyGuidedLifecycleTransitions,
  runGuidedCampaignOptimizationJob,
  runGuidedGoalPolicyApplyJob,
  runGuidedLifecycleTransitionJob,
  triggerGuidedGoalPolicyJob,
};
