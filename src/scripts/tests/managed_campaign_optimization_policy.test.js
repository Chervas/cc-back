'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  STAGES,
} = require('../../services/campaignOptimizationLifecycle.service');
const {
  acquireManagedCampaignOptimizationLease,
  activateManagedCampaignOptimizationPolicy,
  buildProvisioningPlan,
  executeManagedCampaignGoalPolicy,
  goalPolicyAccountForStage,
  lifecycleStageExecutionBlockers,
  provisionManagedCampaignOptimization,
  releaseManagedCampaignOptimizationLease,
} = require('../../services/managedCampaignOptimizationPolicy.service');
const {
  SCHEMA_VERSION: GOAL_POLICY_SCHEMA_VERSION,
  discoverGoalPolicyAuditTargets,
  normalizeConfiguredAccounts,
} = require('../../services/googleAdsClinicaclickGoalPolicy.service');

const CANONICAL_IDS = Object.freeze({
  lead: '101',
  contact: '102',
  qualified_lead: '103',
  schedule: '104',
  purchase: '105',
});

function campaignFixture(overrides = {}) {
  return {
    id: 'managed-google-test',
    strategy_campaign_id: 44,
    clinica_id: 58,
    grupo_clinica_id: 5,
    management_mode: 'autopilot',
    legacy_mode: 'managed_service',
    operation_mode: 'managed',
    provider: 'google_ads',
    family: 'google_search',
    status: 'launching',
    platform_refs: {
      customer_id: '599-235-6722',
      campaign_ids: ['9002', '9001', '9002'],
    },
    approved_by_user_id: 7,
    approved_at: '2026-07-13T10:00:00.000Z',
    ...overrides,
  };
}

function intakeFixture() {
  const events = Object.fromEntries(Object.entries(CANONICAL_IDS).map(([key, actionId]) => [key, {
    destinations: [{
      enabled: true,
      customer_id: '5992356722',
      conversion_action_id: actionId,
    }],
  }]));
  return {
    id: 24,
    group_id: 5,
    assignment_scope: 'group',
    config: { google_ads: { enabled: true, events } },
    async update(values) {
      Object.assign(this, values);
      return this;
    },
  };
}

function testInitialPlanIsQualifiedLeadAndExplicit() {
  const plan = buildProvisioningPlan({
    campaign: campaignFixture(),
    intakeConfig: intakeFixture(),
  });
  assert.equal(plan.ready, true);
  assert.equal(plan.eligible, true);
  assert.equal(plan.stage, 'qualified_lead');
  assert.equal(plan.customer_id, '5992356722');
  assert.deepEqual(plan.campaign_ids, ['9001', '9002']);
  assert.deepEqual(plan.canonical_action_ids, CANONICAL_IDS);
  assert.equal(plan.configured_account.bidding_action_key, 'qualified_lead');
  assert.match(plan.configured_account.custom_goal_name, /Lead cualificado/);
  assert.equal(plan.next_intake_config.google_ads.goal_policy.enabled, true);
  assert.equal(plan.next_intake_config.google_ads.goal_policy.accounts.length, 1);
}

function testConnectOnlyNeverProvisionsBidding() {
  const plan = buildProvisioningPlan({
    campaign: campaignFixture({
      legacy_mode: 'connect_only',
      operation_mode: 'observe',
    }),
    intakeConfig: intakeFixture(),
  });
  assert.equal(plan.ready, true);
  assert.equal(plan.eligible, false);
  assert.equal(plan.observe_only, true);
  assert.equal(plan.reason, 'connect_only_never_mutates_bidding');
}

async function testSameAccountSupportsDisjointCohorts() {
  const intake = intakeFixture();
  const sibling = {
    customer_id: '5992356722',
    strategy_ref: 'managed_campaign:sibling',
    campaign_ids: ['8001'],
    canonical_action_ids: CANONICAL_IDS,
    bidding_action_key: 'qualified_lead',
  };
  intake.config.google_ads.goal_policy = {
    enabled: true,
    schema_version: GOAL_POLICY_SCHEMA_VERSION,
    accounts: [sibling],
  };
  const disjoint = buildProvisioningPlan({ campaign: campaignFixture(), intakeConfig: intake });
  assert.equal(disjoint.ready, true);
  assert.equal(disjoint.next_intake_config.google_ads.goal_policy.accounts.length, 2);
  const normalizedCohorts = normalizeConfiguredAccounts(
    disjoint.next_intake_config.google_ads.goal_policy.accounts,
  );
  assert.equal(normalizedCohorts.length, 2);
  assert.equal(normalizedCohorts.every((account) => account.customer_id === '5992356722'), true);

  const discovered = await discoverGoalPolicyAuditTargets({
    intakeModel: { findAll: async () => [{ ...intake, config: disjoint.next_intake_config }] },
    campaignRequestModel: { findAll: async () => [] },
  });
  assert.equal(discovered.issues.length, 0);
  assert.equal(discovered.targets.length, 2);

  const overlappingIntake = intakeFixture();
  overlappingIntake.config.google_ads.goal_policy = {
    enabled: true,
    schema_version: GOAL_POLICY_SCHEMA_VERSION,
    accounts: [{ ...sibling, campaign_ids: ['9002'] }],
  };
  const overlap = buildProvisioningPlan({
    campaign: campaignFixture(),
    intakeConfig: overlappingIntake,
  });
  assert.equal(overlap.ready, false);
  assert.equal(
    overlap.blockers.some((item) => item.code === 'GOAL_POLICY_CAMPAIGN_COHORT_OVERLAP'),
    true,
  );
  assert.throws(
    () => normalizeConfiguredAccounts([
      sibling,
      { ...disjoint.configured_account, campaign_ids: ['8001', '9002'] },
    ]),
    (error) => error.code === 'GOAL_POLICY_CAMPAIGN_COHORT_OVERLAP',
  );
}

async function testProvisioningIsIdempotent() {
  const intake = intakeFixture();
  let storedPolicy = null;
  let creates = 0;
  const Policy = {
    async findOne() {
      return storedPolicy;
    },
    async create(values) {
      creates += 1;
      storedPolicy = {
        id: 71,
        ...values,
        async update(patch) {
          Object.assign(this, patch);
          return this;
        },
      };
      return storedPolicy;
    },
  };
  const IntakeConfig = { findOne: async () => intake };
  const input = {
    campaign: campaignFixture(),
    now: new Date('2026-07-13T10:30:00.000Z'),
    dependencies: { Policy, IntakeConfig },
  };
  const first = await provisionManagedCampaignOptimization(input);
  const second = await provisionManagedCampaignOptimization(input);
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(first.configUpdated, true);
  assert.equal(second.configUpdated, false);
  assert.equal(creates, 1);
  assert.equal(storedPolicy.mode, 'managed_service');
  assert.equal(storedPolicy.status, 'paused');
  assert.equal(storedPolicy.lifecycleState.stage, 'qualified_lead');
  assert.deepEqual(storedPolicy.customerIds, ['5992356722']);
  assert.deepEqual(storedPolicy.campaignIds, ['9001', '9002']);

  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const acquired = await acquireManagedCampaignOptimizationLease({
    managedCampaignId: campaignFixture().id,
    actorUserId: 7,
    now: new Date('2026-07-13T10:31:00.000Z'),
    transaction,
    dependencies: { Policy },
  });
  await assert.rejects(
    acquireManagedCampaignOptimizationLease({
      managedCampaignId: campaignFixture().id,
      actorUserId: 8,
      now: new Date('2026-07-13T10:32:00.000Z'),
      transaction,
      dependencies: { Policy },
    }),
    (error) => error.code === 'GOAL_POLICY_EXECUTION_IN_PROGRESS',
  );
  await activateManagedCampaignOptimizationPolicy({
    managedCampaignId: campaignFixture().id,
    leaseToken: acquired.token,
    transaction,
    dependencies: { Policy },
  });
  assert.equal(storedPolicy.status, 'active');
  assert.equal(storedPolicy.lifecycleState.execution_lease, undefined);

  const retryLease = await acquireManagedCampaignOptimizationLease({
    managedCampaignId: campaignFixture().id,
    actorUserId: 7,
    now: new Date('2026-07-13T10:33:00.000Z'),
    transaction,
    dependencies: { Policy },
  });
  const released = await releaseManagedCampaignOptimizationLease({
    managedCampaignId: campaignFixture().id,
    leaseToken: retryLease.token,
    transaction,
    dependencies: { Policy },
  });
  assert.equal(released.released, true);
  assert.equal(storedPolicy.lifecycleState.execution_lease, undefined);
}

async function testExecutorUsesImmediateDigestAndSingleAccount() {
  const intake = intakeFixture();
  const plan = buildProvisioningPlan({ campaign: campaignFixture(), intakeConfig: intake });
  const provisioning = {
    provisioned: true,
    intakeConfig: intake,
    plan,
  };
  let applyInput = null;
  const digest = 'a'.repeat(64);
  const executed = await executeManagedCampaignGoalPolicy({
    campaign: campaignFixture(),
    provisioning,
    actorUserId: 7,
    dependencies: {
      previewGoalPolicy: async ({ configuredAccounts }) => {
        assert.equal(configuredAccounts.length, 1);
        return { ready: true, digest, accounts: [{ outcome: 'ready', plan: { blockers: [] } }] };
      },
      applyGoalPolicy: async (input) => {
        applyInput = input;
        return {
          outcome: 'unchanged',
          external_mutation_count: 0,
          verification: { completed: true, healthy: true },
        };
      },
    },
  });
  assert.equal(executed.digest, digest);
  assert.equal(applyInput.expectedDigest, digest);
  assert.equal(applyInput.confirmExternalMutation, true);
  assert.equal(applyInput.configuredAccounts.length, 1);
  assert.equal(applyInput.configuredAccounts[0].bidding_action_key, 'qualified_lead');
}

async function testUnhealthyReadbackFailsClosed() {
  const intake = intakeFixture();
  const provisioning = {
    provisioned: true,
    intakeConfig: intake,
    plan: buildProvisioningPlan({ campaign: campaignFixture(), intakeConfig: intake }),
  };
  await assert.rejects(
    executeManagedCampaignGoalPolicy({
      campaign: campaignFixture(),
      provisioning,
      actorUserId: 7,
      dependencies: {
        previewGoalPolicy: async () => ({ ready: true, digest: 'b'.repeat(64), accounts: [] }),
        applyGoalPolicy: async () => ({
          outcome: 'applied_unverified',
          verification: { completed: true, healthy: false },
        }),
      },
    }),
    (error) => error.code === 'GOAL_POLICY_READBACK_FAILED',
  );
}

async function testPartialGoalCreationPersistsOwnershipBeforeRetry() {
  const intake = intakeFixture();
  const plan = buildProvisioningPlan({ campaign: campaignFixture(), intakeConfig: intake });
  intake.config = plan.next_intake_config;
  const createdResource = 'customers/5992356722/customConversionGoals/777';
  const partial = new Error('drift after create');
  partial.createdGoalResourceName = createdResource;
  await assert.rejects(
    executeManagedCampaignGoalPolicy({
      campaign: campaignFixture(),
      provisioning: { provisioned: true, intakeConfig: intake, plan },
      actorUserId: 7,
      dependencies: {
        previewGoalPolicy: async () => ({ ready: true, digest: 'd'.repeat(64), accounts: [] }),
        applyGoalPolicy: async () => { throw partial; },
        persistenceDependencies: {
          IntakeConfig: { findByPk: async () => intake },
          sequelize: {
            async transaction(callback) {
              return callback({ LOCK: { UPDATE: 'UPDATE' } });
            },
          },
        },
      },
    }),
    (error) => error === partial,
  );
  const account = intake.config.google_ads.goal_policy.accounts[0];
  assert.equal(account.owned_custom_goal_resource_name, createdResource);
}

function testScheduleUsesNewImmutableGoalAndNeedsEvaluationEvidence() {
  const qualified = goalPolicyAccountForStage({
    campaign: campaignFixture(),
    customerId: '5992356722',
    campaignIds: ['9001', '9002'],
    canonicalActionIds: CANONICAL_IDS,
    stage: STAGES.QUALIFIED_LEAD,
  });
  const schedule = goalPolicyAccountForStage({
    campaign: campaignFixture(),
    customerId: '5992356722',
    campaignIds: ['9001', '9002'],
    canonicalActionIds: CANONICAL_IDS,
    stage: STAGES.SCHEDULE,
    existingAccount: {
      ...qualified,
      owned_custom_goal_resource_name: 'customers/5992356722/customConversionGoals/555',
    },
  });
  assert.notEqual(schedule.custom_goal_name, qualified.custom_goal_name);
  assert.equal(schedule.owned_custom_goal_resource_name, null);
  assert.equal(schedule.bidding_action_key, 'schedule');

  const missingEvidence = lifecycleStageExecutionBlockers({
    lifecycleState: { stage: 'schedule' },
    thresholds: { consecutive_passing_evaluations: 2 },
  });
  assert.equal(missingEvidence[0].code, 'LIFECYCLE_PROMOTION_APPROVAL_EVIDENCE_REQUIRED');
  const approved = lifecycleStageExecutionBlockers({
    lifecycleState: {
      stage: 'schedule',
      approved_transition: {
        from_stage: 'qualified_lead',
        to_stage: 'schedule',
        evaluation_ids: [91, 92],
        consecutive_passing_evaluations: 2,
        approved_by_role: 'operator',
        approved_by_user_id: 7,
        decision_digest: 'c'.repeat(64),
      },
    },
    thresholds: { consecutive_passing_evaluations: 2 },
  });
  assert.deepEqual(approved, []);
}

function testLaunchingControllerExecutesBeforeStatusUpdate() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/adminManagedCampaigns.controller.js'),
    'utf8',
  );
  const transition = source.slice(
    source.indexOf('exports.transitionCampaign ='),
    source.indexOf('exports.previewGoalPolicy ='),
  );
  const provisionIndex = transition.indexOf('provisionManagedCampaignOptimization({');
  const leaseIndex = transition.indexOf('acquireManagedCampaignOptimizationLease({');
  const executeIndex = transition.indexOf('await executeManagedCampaignGoalPolicy({');
  const firstTransactionIndex = transition.indexOf('await db.sequelize.transaction');
  const finalTransactionIndex = transition.indexOf('await db.sequelize.transaction', executeIndex);
  const statusUpdateIndex = transition.indexOf('const [updated] = await ManagedCampaign.update({');
  assert.ok(
    provisionIndex > 0
      && leaseIndex > provisionIndex
      && executeIndex > leaseIndex
      && statusUpdateIndex > executeIndex,
  );
  assert.ok(firstTransactionIndex < executeIndex && finalTransactionIndex > executeIndex);
  assert.ok(statusUpdateIndex > finalTransactionIndex);
  assert.doesNotMatch(
    transition.slice(executeIndex, finalTransactionIndex),
    /transaction\s*,/,
    'Provider execution must not receive the provisioning DB transaction',
  );
  assert.match(transition, /transaction[\s\S]*GOAL_POLICY_READBACK_FAILED|executeManagedCampaignGoalPolicy/);
  assert.match(transition, /activateManagedCampaignOptimizationPolicy\(\{[\s\S]*leaseToken: optimizationLeaseToken/);
  assert.match(transition, /catch \(error\)[\s\S]*releaseManagedCampaignOptimizationLease\(\{/);
}

async function testManagedPolicyUniquenessMigration() {
  const migration = require('../../../migrations/20260713120000-unique-managed-campaign-optimization-policy');
  const calls = [];
  await migration.up({
    async addIndex(...args) { calls.push(['addIndex', ...args]); },
  });
  assert.deepEqual(calls[0], [
    'addIndex',
    'CampaignOptimizationPolicies',
    ['managed_campaign_id'],
    {
      name: 'uniq_campaign_optimization_policy_managed_campaign',
      unique: true,
    },
  ]);
}

async function run() {
  testInitialPlanIsQualifiedLeadAndExplicit();
  testConnectOnlyNeverProvisionsBidding();
  await testSameAccountSupportsDisjointCohorts();
  await testProvisioningIsIdempotent();
  await testExecutorUsesImmediateDigestAndSingleAccount();
  await testUnhealthyReadbackFailsClosed();
  await testPartialGoalCreationPersistsOwnershipBeforeRetry();
  testScheduleUsesNewImmutableGoalAndNeedsEvaluationEvidence();
  testLaunchingControllerExecutesBeforeStatusUpdate();
  await testManagedPolicyUniquenessMigration();
  console.log('managed_campaign_optimization_policy.test.js OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
