'use strict';

const assert = require('node:assert/strict');
const {
  MODES,
  STAGES,
  evaluateCampaignOptimizationLifecycle,
} = require('../../services/campaignOptimizationLifecycle.service');
const {
  acquireGuidedTransitionLease,
  computeEvaluationDigest,
  finalizeGuidedTransition,
  verifyReadyGuidedEvaluation,
} = require('../../services/guidedCampaignOptimizationTransitions.service');
const {
  enqueueGuidedLifecycleTransition,
  reconcileReadyGuidedLifecycleTransitions,
  runGuidedLifecycleTransitionJob,
} = require('../../services/guidedCampaignOptimizationJobs.service');
const {
  applyGuidedCampaignGoalPolicy,
} = require('../../services/guidedCampaignOptimizationPolicy.service');
const {
  createCampaignOptimizationEvaluationService,
} = require('../../services/campaignOptimizationEvaluation.service');
const {
  BACKGROUND_INTEGRATION_JOB_TYPES,
} = require('../../config/scheduledJobCatalog');
const jobRequestsService = require('../../services/jobRequests.service');

function mutableRow(values) {
  const row = { ...values };
  row.get = () => ({ ...row, get: undefined, update: undefined });
  row.update = async (patch) => {
    Object.assign(row, patch);
    return row;
  };
  return row;
}

function buildReadyContext() {
  const thresholds = {
    consecutive_passing_evaluations: 2,
    minimum_evaluation_spacing_hours: 24,
    schedule: {
      minimum_conversions_30d: 30,
      minimum_stable_weeks: 4,
      minimum_conversions_per_week: 5,
      minimum_upload_success_rate: 0.95,
      cooldown_days: 0,
    },
  };
  const initialState = {
    stage: STAGES.QUALIFIED_LEAD,
    stage_entered_at: '2026-06-01T00:00:00.000Z',
    last_transition_at: '2026-06-01T00:00:00.000Z',
    last_evaluation_at: null,
    pending_transition: null,
  };
  const metrics = {
    schedule: {
      conversions_30d: 40,
      uploaded_successfully: 40,
      upload_attempts: 40,
      weekly_conversions: [10, 10, 10, 10],
    },
  };
  const first = evaluateCampaignOptimizationLifecycle({
    mode: MODES.GUIDED_IMPROVEMENT,
    state: initialState,
    metrics,
    thresholds,
    now: new Date('2026-07-15T12:00:00.000Z'),
  });
  const second = evaluateCampaignOptimizationLifecycle({
    mode: MODES.GUIDED_IMPROVEMENT,
    state: first.next_state,
    metrics,
    thresholds,
    now: new Date('2026-07-16T12:00:00.000Z'),
  });
  assert.equal(second.ready_for_approval, true);
  const policy = mutableRow({
    id: 71,
    mode: MODES.GUIDED_IMPROVEMENT,
    status: 'active',
    strategyId: 901,
    version: 8,
    lastEvaluatedAt: new Date(second.evaluated_at),
    lifecycleState: {
      ...second.next_state,
      authorization: {
        version: 1,
        accepted: true,
        accepted_at: '2026-07-01T12:00:00.000Z',
        accepted_by_user_id: 7,
        scopes: ['landing_publish', 'campaign_destination', 'conversion_goal'],
      },
      provider_application: { status: 'applied', stage: STAGES.QUALIFIED_LEAD },
    },
  });
  const evaluation = {
    id: 301,
    policyId: 71,
    policyVersion: 7,
    evaluatedAt: new Date(second.evaluated_at),
    metrics,
    evidence: {
      lifecycle: second.evidence,
      lifecycle_decision: {
        schema_version: second.schema_version,
        mode: second.mode,
        from_stage: second.from_stage,
        candidate_stage: second.candidate_stage,
        evaluated_at: second.evaluated_at,
        evidence: second.evidence,
        thresholds: second.thresholds,
        consecutive_passes: second.consecutive_passes,
        ready_for_approval: second.ready_for_approval,
        approval: second.approval,
        decision_digest: second.decision_digest,
      },
      transport: {},
      pure_decision_digest: second.decision_digest,
      provider_mutation: null,
    },
    blockers: [],
    eligibleNow: true,
    readyForApproval: true,
    status: 'ready',
  };
  evaluation.decisionDigest = computeEvaluationDigest(evaluation);
  return { evaluation, policy, second };
}

async function testVerifiedLeaseAndFinalizeAreCasLike() {
  const { evaluation, policy } = buildReadyContext();
  const dependencies = {
    Policy: { async findByPk() { return policy; } },
    Evaluation: {
      async findByPk() { return evaluation; },
      async findOne() { return evaluation; },
    },
    sequelize: {},
  };
  const verified = verifyReadyGuidedEvaluation({
    policy,
    evaluation,
    now: new Date('2026-07-17T12:00:00.000Z'),
  });
  assert.equal(verified.transition.from_stage, STAGES.QUALIFIED_LEAD);
  assert.equal(verified.transition.to_stage, STAGES.SCHEDULE);
  const leased = await acquireGuidedTransitionLease({
    policyId: 71,
    evaluationId: 301,
    now: new Date('2026-07-17T12:00:00.000Z'),
    dependencies,
  });
  assert.equal(leased.acquired, true);
  assert.equal(policy.lifecycleState.stage, STAGES.QUALIFIED_LEAD);
  assert.equal(policy.lifecycleState.execution_lease.purpose, 'guided_lifecycle_transition');
  assert.equal(policy.lifecycleState.pending_provider_transition.to_stage, STAGES.SCHEDULE);

  const finalized = await finalizeGuidedTransition({
    policyId: 71,
    evaluationId: 301,
    leaseToken: leased.token,
    providerResult: { verification: { healthy: true }, digests: [{ customer_id: '1234567890', digest: 'a'.repeat(64) }] },
    now: new Date('2026-07-17T12:05:00.000Z'),
    dependencies,
  });
  assert.equal(finalized.transition.to_stage, STAGES.SCHEDULE);
  assert.equal(policy.lifecycleState.stage, STAGES.SCHEDULE);
  assert.equal(policy.lifecycleState.approved_transition.initial_authorization_reused, true);
  assert.equal(policy.lifecycleState.execution_lease, undefined);
  assert.equal(policy.status, 'active');
}

function testTamperedOrSupersededEvaluationFailsClosed() {
  const tampered = buildReadyContext();
  tampered.evaluation.metrics.schedule.conversions_30d = 999;
  assert.throws(
    () => verifyReadyGuidedEvaluation({ policy: tampered.policy, evaluation: tampered.evaluation }),
    (error) => error.code === 'GUIDED_EVALUATION_DIGEST_INVALID'
  );
  const superseded = buildReadyContext();
  superseded.policy.lastEvaluatedAt = new Date('2026-07-17T12:00:00.000Z');
  assert.throws(
    () => verifyReadyGuidedEvaluation({ policy: superseded.policy, evaluation: superseded.evaluation }),
    (error) => error.code === 'GUIDED_EVALUATION_SUPERSEDED'
  );
}

async function testTransitionJobUsesTargetStageAndReadback() {
  const calls = { fail: 0 };
  const result = await runGuidedLifecycleTransitionJob({
    strategy_id: 901,
    policy_id: 71,
    evaluation_id: 301,
  }, {
    acquireLease: async () => ({
      token: 'lease-1',
      policy: { strategyId: 901 },
      verified: { actor_user_id: 7, transition: { from_stage: STAGES.QUALIFIED_LEAD, to_stage: STAGES.SCHEDULE } },
    }),
    Campaign: { async findByPk() { return { id: 901 }; } },
    CampaignRequest: {
      async findAll() {
        return [{ solicitud: { kind: 'marketing_strategy', status: 'active' } }];
      },
    },
    provision: async (input) => {
      assert.equal(input.targetStage, STAGES.SCHEDULE);
      assert.equal(input.transitionLeaseToken, 'lease-1');
      return { provisioned: true };
    },
    apply: async (input) => {
      assert.equal(input.finalizePolicy, false);
      return {
        preview: { digests: [{ customer_id: '1234567890', digest: 'a'.repeat(64) }] },
        result: { outcome: 'applied', verification: { healthy: true } },
      };
    },
    finalize: async (input) => {
      assert.equal(input.providerResult.verification.healthy, true);
      return { transition: { from_stage: STAGES.QUALIFIED_LEAD, to_stage: STAGES.SCHEDULE } };
    },
    fail: async () => { calls.fail += 1; },
  });
  assert.equal(result.result.stage, STAGES.SCHEDULE);
  assert.equal(result.result.readback_healthy, true);
  assert.equal(calls.fail, 0);
}

async function testMissingCanonicalActionNeverFinalizes() {
  let finalized = 0;
  let failed = 0;
  await assert.rejects(
    () => runGuidedLifecycleTransitionJob({ strategy_id: 901, policy_id: 71, evaluation_id: 301 }, {
      acquireLease: async () => ({
        token: 'lease-2',
        policy: { strategyId: 901 },
        verified: { actor_user_id: 7, transition: { from_stage: STAGES.SCHEDULE, to_stage: STAGES.PURCHASE } },
      }),
      Campaign: { async findByPk() { return { id: 901 }; } },
      CampaignRequest: { async findAll() { return [{ solicitud: { kind: 'marketing_strategy', status: 'active' } }]; } },
      provision: async () => {
        const error = new Error('Falta Purchase canónica');
        error.code = 'GUIDED_CANONICAL_ACTIONS_REQUIRED';
        throw error;
      },
      finalize: async () => { finalized += 1; },
      fail: async () => { failed += 1; },
    }),
    (error) => error.code === 'GUIDED_CANONICAL_ACTIONS_REQUIRED'
  );
  assert.equal(finalized, 0);
  assert.equal(failed, 1);
}

async function testDurableEnqueueIsDedupedByEvaluation() {
  let request = null;
  const queued = await enqueueGuidedLifecycleTransition({
    policyId: 71,
    evaluationId: 301,
    strategyId: 901,
    dependencies: {
      jobRequestsService: {
        async enqueueUniqueJobRequest(input) {
          request = input;
          return { created: true, job: { id: 55 } };
        },
      },
    },
  });
  assert.equal(queued.created, true);
  assert.equal(request.type, 'guided_campaign_goal_policy_apply');
  assert.equal(request.dedupeScope, 'guided-transition:evaluation:301');
  assert.deepEqual(request.payload, { strategy_id: 901, policy_id: 71, evaluation_id: 301 });
}

async function testDailyEvaluationPublishesOnlyReadyGuidedCandidate() {
  const { evaluation, policy } = buildReadyContext();
  const service = createCampaignOptimizationEvaluationService({
    Policy: {
      async findAll() { return [policy]; },
      async update() { throw new Error('No debe reescribir una evaluación diaria ya existente'); },
    },
    Evaluation: {
      async findOne() { return evaluation; },
    },
    Attempt: { async findAll() { throw new Error('No debe reagrupar el mismo día'); } },
    sequelize: {},
  });
  const report = await service.evaluateDuePolicies({ now: new Date('2026-07-16T18:00:00.000Z') });
  assert.equal(report.idempotent, 1);
  assert.deepEqual(report.ready_guided_transitions, [{
    policy_id: 71,
    strategy_id: 901,
    evaluation_id: 301,
    decision_digest: evaluation.decisionDigest,
  }]);
}

async function testGuidedApplyUsesOneAccountBlastRadius() {
  const previews = [];
  const applies = [];
  const policy = mutableRow({ version: 2, lifecycleState: {} });
  const provisioning = {
    provisioned: true,
    policy,
    intakeConfig: {},
    plan: {
      scope: { providerScope: { assignment_scope: 'group', group_id: 5 } },
      authorization: { accepted_by_user_id: 7 },
      configured_accounts: [
        { customer_id: '1234567890', strategy_ref: 'strategy:901' },
        { customer_id: '9876543210', strategy_ref: 'strategy:901' },
      ],
    },
  };
  const result = await applyGuidedCampaignGoalPolicy({
    provisioning,
    actorUserId: 7,
    finalizePolicy: false,
    dependencies: {
      previewGoalPolicy: async ({ configuredAccounts }) => {
        previews.push(configuredAccounts);
        return { ready: true, digest: configuredAccounts[0].customer_id === '1234567890' ? 'a'.repeat(64) : 'b'.repeat(64) };
      },
      applyGoalPolicy: async ({ configuredAccounts }) => {
        applies.push(configuredAccounts);
        return { outcome: 'unchanged', verification: { healthy: true } };
      },
    },
  });
  assert.deepEqual(previews.map((items) => items.length), [1, 1]);
  assert.deepEqual(applies.map((items) => items.length), [1, 1]);
  assert.equal(result.result.verification.healthy, true);
  assert.equal(policy.lifecycleState.provider_application.accounts['1234567890'].status, 'applied');
  assert.equal(policy.lifecycleState.provider_application.accounts['9876543210'].status, 'applied');
}

async function testPartialAccountResultSurvivesLaterFailure() {
  const policy = mutableRow({ version: 2, lifecycleState: {} });
  const provisioning = {
    provisioned: true,
    policy,
    intakeConfig: {},
    plan: {
      scope: { providerScope: { assignment_scope: 'group', group_id: 5 } },
      authorization: { accepted_by_user_id: 7 },
      configured_accounts: [
        { customer_id: '1234567890', campaign_ids: ['1001'], strategy_ref: 'strategy:901' },
        { customer_id: '9876543210', campaign_ids: ['2001'], strategy_ref: 'strategy:901' },
      ],
    },
  };
  await assert.rejects(
    () => applyGuidedCampaignGoalPolicy({
      provisioning,
      actorUserId: 7,
      finalizePolicy: false,
      dependencies: {
        previewGoalPolicy: async ({ configuredAccounts }) => {
          if (configuredAccounts[0].customer_id === '9876543210') {
            const error = new Error('second account unavailable');
            error.code = 'PROVIDER_DOWN';
            throw error;
          }
          return { ready: true, digest: 'a'.repeat(64) };
        },
        applyGoalPolicy: async () => ({ outcome: 'applied', verification: { healthy: true } }),
      },
    }),
    (error) => error.code === 'PROVIDER_DOWN'
  );
  const accounts = policy.lifecycleState.provider_application.accounts;
  assert.equal(accounts['1234567890'].status, 'applied');
  assert.equal(accounts['1234567890'].readback_healthy, true);
  assert.equal(accounts['9876543210'].status, 'failed');
  assert.equal(accounts['9876543210'].error_code, 'PROVIDER_DOWN');
}

async function testReconcilerClosesCommittedEvaluationEnqueueGap() {
  const enqueued = [];
  const report = await reconcileReadyGuidedLifecycleTransitions({
    candidates: [{ policy_id: 71, strategy_id: 901, evaluation_id: 301 }],
  }, {
    operators: { ne: 'ne', in: 'in' },
    Policy: {
      async findAll() {
        return [
          { id: 71, strategyId: 901, lifecycleState: {} },
          { id: 72, strategyId: 902, lifecycleState: { approved_transition: { evaluation_id: 401 } } },
        ];
      },
    },
    Evaluation: {
      async findAll() {
        return [
          { id: 301, policyId: 71, status: 'ready', readyForApproval: true, eligibleNow: true },
          { id: 300, policyId: 71, status: 'ready', readyForApproval: true, eligibleNow: true },
          { id: 401, policyId: 72, status: 'ready', readyForApproval: true, eligibleNow: true },
        ];
      },
    },
    jobRequestsService: {
      async enqueueUniqueJobRequest(input) {
        enqueued.push(input);
        return { created: true, job: { id: 800 + enqueued.length } };
      },
    },
  });
  assert.equal(report.discovered, 1);
  assert.equal(report.queued, 1);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].dedupeScope, 'guided-transition:evaluation:301');
}

async function testUniqueJobCanShareAggregateTransaction() {
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  let created = null;
  const result = await jobRequestsService.enqueueUniqueJobRequest({
    type: 'guided_campaign_goal_policy_apply',
    payload: { strategy_id: 901 },
    dedupeScope: 'guided-activation:strategy:901',
  }, {
    transaction,
    sequelizeInstance: {
      literal(value) { return { literal: value }; },
      async transaction() { throw new Error('must reuse caller transaction'); },
    },
    JobRequestModel: {
      async findOne(query) {
        assert.equal(query.transaction, transaction);
        assert.equal(query.lock, 'UPDATE');
        return null;
      },
      async create(values, options) {
        assert.equal(options.transaction, transaction);
        created = { id: 990, ...values };
        return created;
      },
    },
  });
  assert.equal(result.created, true);
  assert.equal(result.job.id, 990);
  assert.equal(created.payload.__dedupe_scope, 'guided-activation:strategy:901');
}

async function run() {
  assert.ok(BACKGROUND_INTEGRATION_JOB_TYPES.includes('guided_campaign_goal_policy_apply'));
  await testVerifiedLeaseAndFinalizeAreCasLike();
  testTamperedOrSupersededEvaluationFailsClosed();
  await testTransitionJobUsesTargetStageAndReadback();
  await testMissingCanonicalActionNeverFinalizes();
  await testDurableEnqueueIsDedupedByEvaluation();
  await testDailyEvaluationPublishesOnlyReadyGuidedCandidate();
  await testGuidedApplyUsesOneAccountBlastRadius();
  await testPartialAccountResultSurvivesLaterFailure();
  await testReconcilerClosesCommittedEvaluationEnqueueGap();
  await testUniqueJobCanShareAggregateTransaction();
  console.log('guided_campaign_optimization_transitions.test.js OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
