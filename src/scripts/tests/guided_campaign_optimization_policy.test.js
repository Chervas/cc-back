'use strict';

const assert = require('node:assert/strict');
const {
  REQUIRED_SCOPES,
  SCHEMA_VERSION,
  acquireGuidedApplicationLease,
  assertGuidedAuthorization,
  assertGuidedPolicyPayloadCompatible,
  buildGuidedProvisioningPlan,
  collectGoogleCohorts,
  syncGuidedPolicyStrategyStatus,
} = require('../../services/guidedCampaignOptimizationPolicy.service');

function authorization(overrides = {}) {
  return {
    mode_snapshot: 'guided_improvement',
    mode_contract: {
      version: 1,
      mode: 'guided_improvement',
      measurement: true,
      mutate_campaigns: true,
      manage_conversion_goals: true,
      mutate_bids: false,
      mutate_budget: false,
      mutate_campaign_status: false,
      authorization: {
        version: 1,
        accepted: true,
        accepted_at: '2026-07-17T12:00:00.000Z',
        accepted_by_user_id: 7,
        scopes: [...REQUIRED_SCOPES],
      },
      ...overrides,
    },
  };
}

function payload(overrides = {}) {
  return {
    kind: 'marketing_strategy',
    status: 'active',
    ...authorization(),
    scope: { assignment_scope: 'clinic', clinic_id: 59, group_id: 5, clinic_ids: [59] },
    external_targets: [{
      kind: 'generic',
      treatment_id: null,
      campaigns: [
        { provider: 'google_ads', account_id: '123-456-7890', external_campaign_id: '1002' },
        { provider: 'google_ads', account_id: '1234567890', external_campaign_id: '1001' },
        { provider: 'meta_ads', account_id: 'act_1', external_campaign_id: 'meta-1' },
      ],
    }],
    ...overrides,
  };
}

function googleEvent(actionId) {
  return {
    enabled: true,
    destinations: [{
      customer_id: '1234567890',
      conversion_action_id: String(actionId),
      conversion_action: `customers/1234567890/conversionActions/${actionId}`,
    }],
  };
}

function intakeConfig(goalPolicy = null) {
  return {
    id: 44,
    config: {
      google_ads: {
        events: {
          lead: googleEvent(11),
          contact: googleEvent(12),
          qualified_lead: googleEvent(13),
          schedule: googleEvent(14),
          purchase: { enabled: false, destinations: [] },
        },
        ...(goalPolicy ? { goal_policy: goalPolicy } : {}),
      },
    },
  };
}

const inventory = [
  { provider: 'google_ads', customer_id: '1234567890', campaign_id: '1001', channel_type: 'SEARCH' },
  { provider: 'google_ads', customer_id: '1234567890', campaign_id: '1002', channel_type: 'PERFORMANCE_MAX' },
];

function testAuthorizationFailsClosed() {
  assert.throws(
    () => assertGuidedAuthorization(payload({ mode_contract: { ...authorization().mode_contract, mutate_budget: true } })),
    (error) => error.code === 'GUIDED_IMPROVEMENT_AUTHORIZATION_INVALID'
  );
  assert.throws(
    () => assertGuidedAuthorization(payload({
      mode_contract: {
        ...authorization().mode_contract,
        authorization: { ...authorization().mode_contract.authorization, accepted_by_user_id: null },
      },
    })),
    (error) => error.code === 'GUIDED_IMPROVEMENT_AUTHORIZATION_INVALID'
  );
}

function testCohortsAreCanonicalAndIgnoreMeta() {
  assert.deepEqual(collectGoogleCohorts(payload()), [{
    customer_id: '1234567890',
    campaign_ids: ['1001', '1002'],
  }]);
}

function testPlanStartsOnQualifiedLeadWithoutRequiringPurchaseYet() {
  const plan = buildGuidedProvisioningPlan({
    campaign: { id: 901, clinica_id: 59, grupo_clinica_id: 5 },
    payload: payload(),
    intakeConfig: intakeConfig(),
    inventoryRows: inventory,
  });
  assert.equal(plan.schema_version, SCHEMA_VERSION);
  assert.equal(plan.stage, 'qualified_lead');
  assert.deepEqual(plan.customer_ids, ['1234567890']);
  assert.deepEqual(plan.campaign_ids, ['1001', '1002']);
  assert.equal(plan.configured_accounts[0].bidding_action_key, 'qualified_lead');
  assert.equal(plan.configured_accounts[0].canonical_action_ids.purchase, null);
  assert.equal(plan.next_intake_config.google_ads.goal_policy.managed_service_only, false);
  assert.deepEqual(plan.next_intake_config.google_ads.goal_policy.allowed_modes, ['guided_improvement', 'managed_service']);
}

function testExplicitEmptyAccountsAndMissingFutureActionFailSafely() {
  const plan = buildGuidedProvisioningPlan({
    campaign: { id: 901, clinica_id: 59 },
    payload: payload(),
    intakeConfig: intakeConfig({
      enabled: true,
      schema_version: 'clinicaclick-google-ads-conversion-goal-policy/v4',
      accounts: [],
    }),
    inventoryRows: inventory,
  });
  assert.equal(plan.configured_accounts[0].bidding_action_key, 'qualified_lead');
  assert.throws(
    () => buildGuidedProvisioningPlan({
      campaign: { id: 901, clinica_id: 59 },
      payload: payload(),
      intakeConfig: intakeConfig({
        enabled: true,
        schema_version: 'clinicaclick-google-ads-conversion-goal-policy/v4',
        accounts: [],
      }),
      inventoryRows: inventory,
      stage: 'purchase',
    }),
    (error) => error.code === 'GUIDED_CANONICAL_ACTIONS_REQUIRED'
  );
}

function testUnsupportedOrUnknownCampaignsBlockMutation() {
  assert.throws(
    () => buildGuidedProvisioningPlan({
      campaign: { id: 901, clinica_id: 59 },
      payload: payload(),
      intakeConfig: intakeConfig(),
      inventoryRows: [{ ...inventory[0], channel_type: 'SMART' }, inventory[1]],
    }),
    (error) => error.code === 'GUIDED_GOOGLE_CAMPAIGNS_NOT_ELIGIBLE'
  );
  assert.throws(
    () => buildGuidedProvisioningPlan({
      campaign: { id: 901, clinica_id: 59 },
      payload: payload(),
      intakeConfig: intakeConfig(),
      inventoryRows: [inventory[0]],
    }),
    (error) => error.code === 'GUIDED_GOOGLE_CAMPAIGNS_NOT_ELIGIBLE'
  );
}

function testCohortOverlapWithAnotherStrategyFails() {
  const existingAccount = buildGuidedProvisioningPlan({
    campaign: { id: 800, clinica_id: 59 },
    payload: payload(),
    intakeConfig: intakeConfig(),
    inventoryRows: inventory,
  }).configured_accounts[0];
  assert.throws(
    () => buildGuidedProvisioningPlan({
      campaign: { id: 901, clinica_id: 59 },
      payload: payload(),
      intakeConfig: intakeConfig({
        enabled: true,
        schema_version: 'clinicaclick-google-ads-conversion-goal-policy/v4',
        accounts: [existingAccount],
      }),
      inventoryRows: inventory,
    }),
    (error) => error.code === 'GOAL_POLICY_CAMPAIGN_COHORT_OVERLAP'
  );
}

function testExistingPolicyCohortCannotDriftDuringEdit() {
  const current = {
    id: 41,
    mode: 'guided_improvement',
    customerIds: ['1234567890'],
    campaignIds: ['1001', '1002'],
  };
  assert.equal(assertGuidedPolicyPayloadCompatible(current, payload()).compatible, true);
  const changed = payload({
    external_targets: [{
      kind: 'generic',
      treatment_id: null,
      campaigns: [{ provider: 'google_ads', account_id: '1234567890', external_campaign_id: '9999' }],
    }],
  });
  assert.throws(
    () => assertGuidedPolicyPayloadCompatible(current, changed),
    (error) => error.code === 'GUIDED_POLICY_COHORT_IMMUTABLE'
  );
}

async function testPauseAndCompleteSynchronizeWithoutDeletingPolicy() {
  const row = {
    id: 51,
    mode: 'guided_improvement',
    status: 'active',
    strategyId: 901,
    version: 3,
    lifecycleState: { stage: 'qualified_lead' },
    get() { return { ...this, get: undefined, update: undefined }; },
    async update(patch) { Object.assign(this, patch); return this; },
  };
  const Policy = { async findOne() { return row; } };
  const paused = await syncGuidedPolicyStrategyStatus({
    strategyId: 901,
    strategyStatus: 'paused',
    transaction: {},
    dependencies: { Policy },
  });
  assert.equal(paused.updated, true);
  assert.equal(row.status, 'paused');
  assert.equal(row.nextEvaluationAt, null);
  assert.equal(row.version, 4);
  const pausedAgain = await syncGuidedPolicyStrategyStatus({
    strategyId: 901,
    strategyStatus: 'paused',
    dependencies: { Policy },
  });
  assert.equal(pausedAgain.updated, false);
  assert.equal(pausedAgain.reason, 'already_synchronized');
  assert.equal(row.version, 4);

  const completed = await syncGuidedPolicyStrategyStatus({
    strategyId: 901,
    strategyStatus: 'completed',
    dependencies: { Policy },
  });
  assert.equal(completed.updated, true);
  assert.equal(row.status, 'completed');
  assert.equal(row.version, 5);
  assert.equal(row.lifecycleState.strategy_status, 'completed');
}

async function testInitialApplicationLeasePreventsPauseRace() {
  const row = {
    id: 61,
    mode: 'guided_improvement',
    status: 'paused',
    strategyId: 902,
    version: 2,
    lifecycleState: { stage: 'qualified_lead', strategy_status: 'active' },
    get() { return { ...this, get: undefined, update: undefined }; },
    async update(patch) { Object.assign(this, patch); return this; },
  };
  const Policy = {
    async update(patch, options) {
      assert.deepEqual(options.where, { id: 61, version: 2, status: 'paused' });
      Object.assign(row, patch);
      return [1];
    },
    async findOne() { return row; },
  };
  const lease = await acquireGuidedApplicationLease(row, {
    now: new Date(),
    Policy,
  });
  assert.ok(lease.token);
  assert.equal(row.lifecycleState.execution_lease.purpose, 'guided_initial_goal_policy_apply');
  await assert.rejects(
    () => syncGuidedPolicyStrategyStatus({
      strategyId: 902,
      strategyStatus: 'paused',
      dependencies: { Policy },
    }),
    (error) => error.code === 'GUIDED_POLICY_EXECUTION_IN_PROGRESS'
  );
}

testAuthorizationFailsClosed();
testCohortsAreCanonicalAndIgnoreMeta();
testPlanStartsOnQualifiedLeadWithoutRequiringPurchaseYet();
testExplicitEmptyAccountsAndMissingFutureActionFailSafely();
testUnsupportedOrUnknownCampaignsBlockMutation();
testCohortOverlapWithAnotherStrategyFails();
testExistingPolicyCohortCannotDriftDuringEdit();

Promise.resolve()
  .then(testPauseAndCompleteSynchronizeWithoutDeletingPolicy)
  .then(testInitialApplicationLeasePreventsPauseRace)
  .then(() => console.log('guided_campaign_optimization_policy.test.js OK'))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
