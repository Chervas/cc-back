'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  GOAL_NAME,
  NEW_GOAL_PLACEHOLDER,
  applyClinicaclickGoalPolicy,
  assertSafePlanOperations,
  auditClinicaclickGoalPolicy,
  buildClinicaclickGoalPolicyPlan,
  discoverGoalPolicyAuditTargets,
  executePersistedGoalPolicyAudit,
  fetchGoalPolicySnapshot,
  loadDiagnosticsSnapshot,
  normalizeConfiguredAccounts,
  previewClinicaclickGoalPolicy,
} = require('../../services/googleAdsClinicaclickGoalPolicy.service');

const CUSTOMER = '1851215478';
const FOREIGN_CUSTOMER = '5992356722';
const GOAL_RESOURCE = `customers/${CUSTOMER}/customConversionGoals/77`;
const NEW_GOAL_RESOURCE = `customers/${CUSTOMER}/customConversionGoals/88`;
const CAMPAIGN_IDS = ['101', '102'];
const ACTION_IDS = Object.freeze({
  lead: '1',
  contact: '2',
  schedule: '3',
  purchase: '4',
});
const ACTION_NAMES = Object.freeze({
  lead: 'Lead - ClinicaClick',
  contact: 'Contact - ClinicaClick',
  schedule: 'Schedule - ClinicaClick',
  purchase: 'Purchase - ClinicaClick',
});

function deterministicClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 12, 12, 0, tick++));
}

function configuredAccount(overrides = {}) {
  return {
    customer_id: CUSTOMER,
    strategy_ref: 'strategy:new-patients:group-5',
    campaign_ids: CAMPAIGN_IDS,
    canonical_action_ids: ACTION_IDS,
    ...overrides,
  };
}

function canonicalAction(key, overrides = {}) {
  const id = ACTION_IDS[key];
  return {
    id,
    resource_name: `customers/${CUSTOMER}/conversionActions/${id}`,
    owner_customer: `customers/${CUSTOMER}`,
    name: ACTION_NAMES[key],
    type: 'UPLOAD_CLICKS',
    status: 'ENABLED',
    counting_type: 'MANY_PER_CLICK',
    primary_for_goal: false,
    category: key === 'schedule' ? 'BOOK_APPOINTMENT' : key === 'purchase' ? 'PURCHASE' : 'SUBMIT_LEAD_FORM',
    origin: 'WEBSITE',
    ...overrides,
  };
}

function campaignConfig(campaignId, customGoal = null, overrides = {}) {
  return {
    resource_name: `customers/${CUSTOMER}/conversionGoalCampaignConfigs/${campaignId}`,
    campaign_resource_name: `customers/${CUSTOMER}/campaigns/${campaignId}`,
    campaign_id: campaignId,
    campaign_name: `Campaign ${campaignId}`,
    campaign_status: 'ENABLED',
    advertising_channel_type: 'SEARCH',
    goal_config_level: customGoal ? 'CAMPAIGN' : 'CUSTOMER',
    custom_conversion_goal: customGoal,
    custom_goal_name: customGoal ? GOAL_NAME : null,
    custom_goal_status: customGoal ? 'ENABLED' : null,
    ...overrides,
  };
}

function customGoal(resourceName = GOAL_RESOURCE, conversionActions = desiredActionResources(), overrides = {}) {
  return {
    id: resourceName.split('/').pop(),
    resource_name: resourceName,
    name: GOAL_NAME,
    status: 'ENABLED',
    conversion_actions: conversionActions.slice().sort(),
    ...overrides,
  };
}

function desiredActionResources() {
  return ['lead', 'contact', 'schedule'].map((key) => (
    `customers/${CUSTOMER}/conversionActions/${ACTION_IDS[key]}`
  ));
}

function baseSnapshot(overrides = {}) {
  return {
    conversion_tracking: {
      customer_id: CUSTOMER,
      google_ads_conversion_customer: `customers/${CUSTOMER}`,
      conversion_customer_id: CUSTOMER,
      conversion_tracking_status: 'CONVERSION_TRACKING_MANAGED_BY_SELF',
    },
    conversion_actions: [
      canonicalAction('lead'),
      canonicalAction('contact'),
      canonicalAction('schedule'),
      canonicalAction('purchase'),
      {
        id: '9',
        resource_name: `customers/${CUSTOMER}/conversionActions/9`,
        owner_customer: `customers/${CUSTOMER}`,
        name: 'Formulario antiguo del cliente',
        type: 'WEBPAGE',
        status: 'ENABLED',
        counting_type: 'ONE_PER_CLICK',
        primary_for_goal: true,
        category: 'SUBMIT_LEAD_FORM',
        origin: 'WEBSITE',
      },
    ],
    custom_goals: [],
    campaign_configs: CAMPAIGN_IDS.map((id) => campaignConfig(id)),
    campaign_conversion_goals: CAMPAIGN_IDS.map((id) => ({
      resource_name: `customers/${CUSTOMER}/campaignConversionGoals/${id}~SUBMIT_LEAD_FORM~WEBSITE`,
      campaign_id: id,
      campaign_name: `Campaign ${id}`,
      category: 'SUBMIT_LEAD_FORM',
      origin: 'WEBSITE',
      biddable: true,
    })),
    customer_conversion_goals: [{
      resource_name: `customers/${CUSTOMER}/customerConversionGoals/SUBMIT_LEAD_FORM~WEBSITE`,
      category: 'SUBMIT_LEAD_FORM',
      origin: 'WEBSITE',
      biddable: true,
    }],
    ...overrides,
  };
}

function runtimeResolver() {
  return async ({ customerId }) => ({
    customerId,
    loginCustomerId: '2863224233',
    accessToken: 'secret-access-token',
  });
}

function clone(value) {
  return structuredClone(value);
}

function testConfigurationRequiresExplicitScope() {
  assert.deepEqual(normalizeConfiguredAccounts([configuredAccount({
    customer_id: '185-121-5478',
    campaign_ids: ['0102', '101', '101'],
  })]), [{
    customer_id: CUSTOMER,
    strategy_key: 'new_patients',
    strategy_ref: 'strategy:new-patients:group-5',
    campaign_ids: ['101', '102'],
    canonical_action_ids: ACTION_IDS,
    owned_custom_goal_resource_name: null,
  }]);
  assert.throws(
    () => normalizeConfiguredAccounts([configuredAccount({ campaign_ids: [] })]),
    (error) => error.code === 'GOAL_POLICY_CAMPAIGNS_REQUIRED',
  );
  assert.throws(
    () => normalizeConfiguredAccounts([configuredAccount({ strategy_ref: '' })]),
    (error) => error.code === 'GOAL_POLICY_STRATEGY_REF_REQUIRED',
  );
  assert.throws(
    () => normalizeConfiguredAccounts([configuredAccount({
      canonical_action_ids: { ...ACTION_IDS, schedule: null },
    })]),
    (error) => error.code === 'CANONICAL_ACTION_ID_REQUIRED',
  );
  assert.throws(
    () => normalizeConfiguredAccounts([configuredAccount({
      owned_custom_goal_resource_name: `customers/${FOREIGN_CUSTOMER}/customConversionGoals/77`,
    })]),
    (error) => error.code === 'OWNED_CUSTOM_GOAL_RESOURCE_INVALID',
  );
}

function testPlanContainsOnlyThreeSecondaryCanonicalActions() {
  const account = normalizeConfiguredAccounts([configuredAccount()])[0];
  const plan = buildClinicaclickGoalPolicyPlan({ account, snapshot: baseSnapshot() });
  assert.equal(plan.ready, true);
  assert.equal(plan.changed, true);
  assert.equal(plan.operations.custom_goal.create.name, GOAL_NAME);
  assert.deepEqual(plan.operations.custom_goal.create.conversionActions, desiredActionResources());
  assert.equal(JSON.stringify(plan.operations).includes('/conversionActions/4'), false, 'Purchase must stay outside the custom goal');
  assert.deepEqual(plan.operations.conversion_actions, []);
  assert.deepEqual(plan.operations.customer_conversion_goals, []);
  assert.deepEqual(
    plan.operations.campaign_goal_configs.map((operation) => operation.update.resourceName),
    CAMPAIGN_IDS.map((id) => `customers/${CUSTOMER}/conversionGoalCampaignConfigs/${id}`),
  );
  assert.ok(plan.operations.campaign_goal_configs.every((operation) => (
    operation.update.customConversionGoal === NEW_GOAL_PLACEHOLDER
  )));
  assert.equal(plan.operations.campaign_conversion_goals.length, 2);
  assert.ok(plan.operations.campaign_conversion_goals.every((operation) => (
    operation.update.biddable === false && operation.updateMask === 'biddable'
  )));
  assert.equal(plan.rollback.automatic, false);
  assert.equal(plan.rollback.campaign_conversion_goal_operations.length, 2);
  assert.ok(plan.rollback.campaign_conversion_goal_operations.every((operation) => (
    operation.update.biddable === true
  )));
  assert.equal(plan.client_actions.length, 1);
  assert.equal(plan.warnings.length, 0);
  assertSafePlanOperations(account, plan);
}

function testCanonicalActionsMustAlreadyBeSafe() {
  for (const [change, expectedCode] of [
    [{ status: 'REMOVED' }, 'CANONICAL_ACTION_NOT_ENABLED'],
    [{ counting_type: 'ONE_PER_CLICK' }, 'CANONICAL_ACTION_COUNTING_TYPE_INVALID'],
    [{ primary_for_goal: true }, 'CANONICAL_ACTION_NOT_SECONDARY'],
    [{ type: 'WEBPAGE' }, 'CANONICAL_ACTION_TYPE_INVALID'],
  ]) {
    const snapshot = baseSnapshot({
      conversion_actions: [
        canonicalAction('lead', change),
        canonicalAction('contact'),
        canonicalAction('schedule'),
        canonicalAction('purchase'),
      ],
    });
    const plan = buildClinicaclickGoalPolicyPlan({
      account: normalizeConfiguredAccounts([configuredAccount()])[0],
      snapshot,
    });
    assert.equal(plan.ready, false);
    assert.ok(plan.blockers.some((item) => item.code === expectedCode));
    assert.throws(
      () => assertSafePlanOperations(normalizeConfiguredAccounts([configuredAccount()])[0], plan),
      (error) => error.code === 'GOAL_POLICY_PLAN_BLOCKED',
    );
  }
}

function testCampaignGoalEnumerationFailsClosed() {
  const account = normalizeConfiguredAccounts([configuredAccount()])[0];
  const missing = buildClinicaclickGoalPolicyPlan({
    account,
    snapshot: baseSnapshot({
      campaign_conversion_goals: baseSnapshot().campaign_conversion_goals.filter((goal) => goal.campaign_id === '101'),
    }),
  });
  assert.equal(missing.ready, false);
  assert.ok(missing.blockers.some((item) => (
    item.code === 'CAMPAIGN_CONVERSION_GOALS_NOT_FOUND' && item.campaign_id === '102'
  )));

  const duplicateRow = clone(baseSnapshot().campaign_conversion_goals[0]);
  const ambiguous = buildClinicaclickGoalPolicyPlan({
    account,
    snapshot: baseSnapshot({
      campaign_conversion_goals: [...baseSnapshot().campaign_conversion_goals, duplicateRow],
    }),
  });
  assert.equal(ambiguous.ready, false);
  assert.ok(ambiguous.blockers.some((item) => item.code === 'CAMPAIGN_CONVERSION_GOAL_AMBIGUOUS'));
}

function testForeignGoalsAreNeverOverwritten() {
  const foreignGoal = customGoal(GOAL_RESOURCE, desiredActionResources(), { name: GOAL_NAME });
  const collisionPlan = buildClinicaclickGoalPolicyPlan({
    account: normalizeConfiguredAccounts([configuredAccount()])[0],
    snapshot: baseSnapshot({ custom_goals: [foreignGoal] }),
  });
  assert.equal(collisionPlan.ready, false);
  assert.ok(collisionPlan.blockers.some((item) => item.code === 'CUSTOM_GOAL_NAME_COLLISION_UNOWNED'));

  const otherGoal = customGoal(`customers/${CUSTOMER}/customConversionGoals/99`, desiredActionResources(), {
    name: 'Custom goal del cliente',
  });
  const campaignPlan = buildClinicaclickGoalPolicyPlan({
    account: normalizeConfiguredAccounts([configuredAccount()])[0],
    snapshot: baseSnapshot({
      custom_goals: [otherGoal],
      campaign_configs: [campaignConfig('101', otherGoal.resource_name), campaignConfig('102')],
    }),
  });
  assert.equal(campaignPlan.ready, false);
  assert.ok(campaignPlan.blockers.some((item) => item.code === 'CAMPAIGN_USES_FOREIGN_CUSTOM_GOAL'));
  assert.equal(JSON.stringify(campaignPlan.operations).includes('remove'), false);
}

function testOutsideScopeCampaignFailsClosed() {
  const owned = customGoal();
  const plan = buildClinicaclickGoalPolicyPlan({
    account: normalizeConfiguredAccounts([configuredAccount({
      owned_custom_goal_resource_name: GOAL_RESOURCE,
    })])[0],
    snapshot: baseSnapshot({
      custom_goals: [owned],
      campaign_configs: [
        campaignConfig('101', GOAL_RESOURCE),
        campaignConfig('102', GOAL_RESOURCE),
        campaignConfig('999', GOAL_RESOURCE),
      ],
    }),
  });
  assert.equal(plan.ready, false);
  assert.deepEqual(plan.outside_opt_in_campaigns, ['999']);
  assert.ok(plan.blockers.some((item) => item.code === 'OWNED_GOAL_ATTACHED_OUTSIDE_STRATEGY'));
  assert.equal(JSON.stringify(plan.operations).includes('/999'), false, 'The audit must not detach or mutate an out-of-scope campaign');
}

function testMutationGuardRejectsBlastRadiusExpansion() {
  const account = normalizeConfiguredAccounts([configuredAccount()])[0];
  const safePlan = buildClinicaclickGoalPolicyPlan({ account, snapshot: baseSnapshot() });

  const outsideCampaignConfig = clone(safePlan);
  outsideCampaignConfig.operations.campaign_goal_configs.push({
    update: {
      resourceName: `customers/${CUSTOMER}/conversionGoalCampaignConfigs/999`,
      customConversionGoal: NEW_GOAL_PLACEHOLDER,
    },
    updateMask: 'custom_conversion_goal',
  });
  assert.throws(
    () => assertSafePlanOperations(account, outsideCampaignConfig),
    (error) => error.code === 'GOAL_POLICY_CAMPAIGN_OPERATION_OUT_OF_SCOPE',
  );

  const outsideCampaignGoal = clone(safePlan);
  outsideCampaignGoal.operations.campaign_conversion_goals.push({
    update: {
      resourceName: `customers/${CUSTOMER}/campaignConversionGoals/999~CONTACT~WEBSITE`,
      biddable: false,
    },
    updateMask: 'biddable',
  });
  assert.throws(
    () => assertSafePlanOperations(account, outsideCampaignGoal),
    (error) => error.code === 'GOAL_POLICY_CAMPAIGN_CONVERSION_GOAL_OUT_OF_SCOPE',
  );

  const clientActionMutation = clone(safePlan);
  clientActionMutation.operations.conversion_actions.push({
    update: { resourceName: `customers/${CUSTOMER}/conversionActions/9`, status: 'REMOVED' },
    updateMask: 'status',
  });
  assert.throws(
    () => assertSafePlanOperations(account, clientActionMutation),
    (error) => error.code === 'GOAL_POLICY_FORBIDDEN_OPERATION',
  );
}

async function testPreviewIsReadOnlyAndDeterministic() {
  const calls = [];
  const snapshot = baseSnapshot();
  const dependencies = {
    now: deterministicClock(),
    resolveRuntime: runtimeResolver(),
    fetchSnapshot: async ({ account }) => {
      calls.push({ type: 'read', customer_id: account.customer_id });
      return clone(snapshot);
    },
    request: async () => {
      throw new Error('Preview must not call a mutate adapter');
    },
  };
  const first = await previewClinicaclickGoalPolicy({
    scope: { group_id: 5, assignment_scope: 'group' },
    configuredAccounts: [configuredAccount()],
    dependencies,
  });
  const second = await previewClinicaclickGoalPolicy({
    scope: { group_id: 5, assignment_scope: 'group' },
    configuredAccounts: [configuredAccount()],
    dependencies,
  });
  assert.equal(first.mode, 'preview_read_only');
  assert.equal(first.external_mutation_count, 0);
  assert.equal(first.digest, second.digest);
  assert.equal(first.accounts[0].plan.client_actions[0].name, 'Formulario antiguo del cliente');
  assert.equal(first.accounts[0].plan.current_customer_conversion_goals.length, 1);
  assert.equal(first.accounts[0].plan.current_campaign_conversion_goals.length, 2);
  assert.equal(calls.length, 2);
}

async function testDefaultProviderPreviewOnlySearches() {
  const paths = [];
  const providerRows = {
    customer: [{ customer: {
      id: CUSTOMER,
      conversionTrackingSetting: {
        googleAdsConversionCustomer: `customers/${CUSTOMER}`,
        conversionTrackingStatus: 'CONVERSION_TRACKING_MANAGED_BY_SELF',
      },
    } }],
    conversion_action: [
      ...Object.keys(ACTION_IDS).map((key) => ({ conversionAction: {
        ...canonicalAction(key),
        resourceName: canonicalAction(key).resource_name,
        ownerCustomer: canonicalAction(key).owner_customer,
        countingType: 'MANY_PER_CLICK',
        primaryForGoal: false,
      } })),
      { conversionAction: {
        id: '9', resourceName: `customers/${CUSTOMER}/conversionActions/9`, ownerCustomer: `customers/${CUSTOMER}`,
        name: 'Cliente', type: 'WEBPAGE', status: 'ENABLED', countingType: 'ONE_PER_CLICK', primaryForGoal: true,
        category: 'SUBMIT_LEAD_FORM', origin: 'WEBSITE',
      } },
    ],
    custom_conversion_goal: [],
    conversion_goal_campaign_config: CAMPAIGN_IDS.map((id) => ({
      conversionGoalCampaignConfig: {
        resourceName: `customers/${CUSTOMER}/conversionGoalCampaignConfigs/${id}`,
        campaign: `customers/${CUSTOMER}/campaigns/${id}`,
        goalConfigLevel: 'CUSTOMER',
      },
      campaign: { id, name: `Campaign ${id}`, status: 'ENABLED', advertisingChannelType: 'SEARCH' },
    })),
    campaign_conversion_goal: [],
    customer_conversion_goal: [],
  };
  const snapshot = await fetchGoalPolicySnapshot({
    runtime: { customerId: CUSTOMER, accessToken: 'token', loginCustomerId: '2863224233' },
    account: normalizeConfiguredAccounts([configuredAccount()])[0],
    request: async (_method, requestPath, options) => {
      paths.push(requestPath);
      assert.equal(requestPath, `customers/${CUSTOMER}/googleAds:search`);
      const from = options.data.query.match(/FROM\s+(\w+)/)?.[1];
      return { results: providerRows[from] || [] };
    },
  });
  assert.equal(paths.length, 6);
  assert.equal(snapshot.conversion_actions.length, 5);
  assert.equal(snapshot.campaign_configs.length, 2);
  assert.equal(paths.some((item) => item.includes(':mutate')), false);
}

async function previewDigestFor(state, account = configuredAccount({ owned_custom_goal_resource_name: GOAL_RESOURCE })) {
  const result = await previewClinicaclickGoalPolicy({
    scope: { group_id: 5, assignment_scope: 'group' },
    configuredAccounts: [account],
    dependencies: {
      now: deterministicClock(),
      resolveRuntime: runtimeResolver(),
      fetchSnapshot: async () => clone(state),
    },
  });
  return result.digest;
}

async function testApplyRequiresConfirmationAndFreshDigest() {
  const state = baseSnapshot({
    custom_goals: [customGoal(GOAL_RESOURCE, [desiredActionResources()[0]])],
    campaign_configs: CAMPAIGN_IDS.map((id) => campaignConfig(id)),
  });
  const account = configuredAccount({ owned_custom_goal_resource_name: GOAL_RESOURCE });
  const digest = await previewDigestFor(state, account);
  await assert.rejects(
    applyClinicaclickGoalPolicy({
      scope: { group_id: 5, assignment_scope: 'group' },
      configuredAccounts: [account],
      expectedDigest: digest,
    }),
    (error) => error.code === 'EXTERNAL_MUTATION_CONFIRMATION_REQUIRED',
  );
  const mutated = clone(state);
  mutated.campaign_configs[0].custom_conversion_goal = `customers/${CUSTOMER}/customConversionGoals/999`;
  const calls = [];
  await assert.rejects(
    applyClinicaclickGoalPolicy({
      scope: { group_id: 5, assignment_scope: 'group' },
      configuredAccounts: [account],
      expectedDigest: digest,
      confirmExternalMutation: true,
      dependencies: {
        now: deterministicClock(),
        resolveRuntime: runtimeResolver(),
        fetchSnapshot: async () => clone(mutated),
        request: async (...args) => calls.push(args),
      },
    }),
    (error) => error.code === 'GOAL_POLICY_DIGEST_STALE',
  );
  assert.equal(calls.length, 0);
}

async function testApplyExistingGoalValidatesBeforeMutation() {
  const state = baseSnapshot({
    custom_goals: [customGoal(GOAL_RESOURCE, [desiredActionResources()[0]])],
    campaign_configs: [campaignConfig('101'), campaignConfig('102', GOAL_RESOURCE)],
  });
  const account = configuredAccount({ owned_custom_goal_resource_name: GOAL_RESOURCE });
  const digest = await previewDigestFor(state, account);
  const calls = [];
  const result = await applyClinicaclickGoalPolicy({
    scope: { group_id: 5, assignment_scope: 'group' },
    configuredAccounts: [account],
    expectedDigest: digest,
    confirmExternalMutation: true,
    dependencies: {
      now: deterministicClock(),
      resolveRuntime: runtimeResolver(),
      fetchSnapshot: async () => clone(state),
      request: async (_method, requestPath, options) => {
        calls.push({ path: requestPath, data: clone(options.data) });
        assert.equal(requestPath.includes('conversionActions:mutate'), false);
        if (options.data.validateOnly === false && requestPath.endsWith('customConversionGoals:mutate')) {
          state.custom_goals[0].conversion_actions = options.data.operations[0].update.conversionActions.slice().sort();
        }
        if (options.data.validateOnly === false && requestPath.endsWith('conversionGoalCampaignConfigs:mutate')) {
          for (const operation of options.data.operations) {
            const id = operation.update.resourceName.split('/').pop();
            state.campaign_configs.find((item) => item.campaign_id === id).custom_conversion_goal = operation.update.customConversionGoal;
          }
        }
        if (options.data.validateOnly === false && requestPath.endsWith('campaignConversionGoals:mutate')) {
          for (const operation of options.data.operations) {
            state.campaign_conversion_goals.find((item) => item.resource_name === operation.update.resourceName).biddable = false;
          }
        }
        return { results: [] };
      },
    },
  });
  assert.equal(result.outcome, 'applied');
  assert.equal(result.external_mutation_count, 3);
  assert.deepEqual(calls.map((call) => [call.path.split('/').pop(), call.data.validateOnly]), [
    ['customConversionGoals:mutate', true],
    ['conversionGoalCampaignConfigs:mutate', true],
    ['campaignConversionGoals:mutate', true],
    ['customConversionGoals:mutate', false],
    ['conversionGoalCampaignConfigs:mutate', false],
    ['campaignConversionGoals:mutate', false],
  ]);
  assert.equal(JSON.stringify(calls).includes('/conversionActions/9'), false);
  assert.equal(state.conversion_actions.find((item) => item.id === '9').primary_for_goal, true, 'Client action stays untouched');
}

async function testApplyNewGoalReturnsAndCanPersistOwnership() {
  const state = baseSnapshot();
  const account = configuredAccount();
  const digest = await previewDigestFor(state, account);
  const calls = [];
  const persisted = [];
  const result = await applyClinicaclickGoalPolicy({
    scope: { group_id: 5, assignment_scope: 'group' },
    configuredAccounts: [account],
    expectedDigest: digest,
    confirmExternalMutation: true,
    dependencies: {
      now: deterministicClock(),
      resolveRuntime: runtimeResolver(),
      fetchSnapshot: async () => clone(state),
      persistOwnership: async (payload) => persisted.push(payload),
      request: async (_method, requestPath, options) => {
        calls.push({ path: requestPath, data: clone(options.data) });
        if (requestPath.endsWith('customConversionGoals:mutate') && options.data.validateOnly === false) {
          state.custom_goals.push(customGoal(NEW_GOAL_RESOURCE));
          return { results: [{ resourceName: NEW_GOAL_RESOURCE }] };
        }
        if (requestPath.endsWith('conversionGoalCampaignConfigs:mutate') && options.data.validateOnly === false) {
          for (const operation of options.data.operations) {
            const id = operation.update.resourceName.split('/').pop();
            state.campaign_configs.find((item) => item.campaign_id === id).custom_conversion_goal = operation.update.customConversionGoal;
          }
        }
        if (requestPath.endsWith('campaignConversionGoals:mutate') && options.data.validateOnly === false) {
          for (const operation of options.data.operations) {
            state.campaign_conversion_goals.find((item) => item.resource_name === operation.update.resourceName).biddable = false;
          }
        }
        return {};
      },
    },
  });
  assert.equal(result.outcome, 'applied');
  assert.equal(result.ownership.custom_goal_resource_name, NEW_GOAL_RESOURCE);
  assert.equal(result.ownership.persisted, true);
  assert.equal(persisted.length, 1);
  const configMutates = calls.filter((call) => call.path.endsWith('conversionGoalCampaignConfigs:mutate'));
  assert.deepEqual(configMutates.map((call) => call.data.validateOnly), [true, false]);
  assert.ok(configMutates.every((call) => call.data.operations.every((operation) => (
    operation.update.customConversionGoal === NEW_GOAL_RESOURCE
  ))));
  assert.deepEqual(
    calls.filter((call) => call.path.endsWith('campaignConversionGoals:mutate')).map((call) => call.data.validateOnly),
    [true, false],
  );
  assert.equal(calls.some((call) => call.path.endsWith('conversionActions:mutate')), false);
}

async function testDriftAfterValidateOnlyStopsBeforeRealMutation() {
  const state = baseSnapshot({
    custom_goals: [customGoal(GOAL_RESOURCE, [desiredActionResources()[0]])],
    campaign_configs: CAMPAIGN_IDS.map((id) => campaignConfig(id)),
  });
  const account = configuredAccount({ owned_custom_goal_resource_name: GOAL_RESOURCE });
  const digest = await previewDigestFor(state, account);
  const calls = [];
  await assert.rejects(
    applyClinicaclickGoalPolicy({
      scope: { group_id: 5, assignment_scope: 'group' },
      configuredAccounts: [account],
      expectedDigest: digest,
      confirmExternalMutation: true,
      dependencies: {
        now: deterministicClock(),
        resolveRuntime: runtimeResolver(),
        fetchSnapshot: async () => clone(state),
        request: async (_method, requestPath, options) => {
          calls.push({ path: requestPath, data: clone(options.data) });
          if (calls.length === 2) state.conversion_actions[0].status = 'HIDDEN';
          return {};
        },
      },
    }),
    (error) => error.code === 'GOAL_POLICY_DIGEST_STALE',
  );
  assert.ok(calls.length >= 1);
  assert.ok(calls.every((call) => call.data.validateOnly === true));
}

async function testAuditIsReadOnlyAndIncludesDiagnosticsFreshness() {
  const snapshot = baseSnapshot({
    custom_goals: [customGoal(GOAL_RESOURCE)],
    campaign_configs: [campaignConfig('101', GOAL_RESOURCE), campaignConfig('102')],
  });
  const calls = [];
  const report = await auditClinicaclickGoalPolicy({
    scope: { group_id: 5, assignment_scope: 'group' },
    configuredAccounts: [configuredAccount({ owned_custom_goal_resource_name: GOAL_RESOURCE })],
    dependencies: {
      now: deterministicClock(),
      resolveRuntime: runtimeResolver(),
      fetchSnapshot: async () => clone(snapshot),
      request: async (...args) => calls.push(args),
      loadDiagnostics: async () => ({
        freshness_status: 'stale',
        sample_size: 1,
        issues: [{ severity: 'critical', code: 'DATA_MANAGER_DIAGNOSTICS_STALE_ACCEPTED', message: 'stale' }],
      }),
    },
  });
  assert.equal(report.mode, 'audit_read_only');
  assert.equal(report.autorepair, false);
  assert.equal(report.external_mutation_count, 0);
  assert.equal(report.summary.critical_count, 4, 'Two biddable goals, campaign config drift and stale diagnostics');
  assert.equal(report.accounts[0].healthy, false);
  assert.equal(calls.length, 0);
}

async function testDiagnosticsReaderNeverUpdatesAttempts() {
  let updateCalls = 0;
  const now = new Date('2026-07-12T12:00:00.000Z');
  const result = await loadDiagnosticsSnapshot({
    scope: { group_id: 5, assignment_scope: 'group' },
    customerId: CUSTOMER,
    now,
    freshnessHours: 6,
    attemptModel: {
      async findAll(options) {
        assert.equal(options.where.customerId, CUSTOMER);
        assert.equal(options.where.grupoClinicaId, 5);
        return [{
          status: 'accepted',
          attemptedAt: new Date('2026-07-12T01:00:00.000Z'),
          responseMetadata: {},
          update: () => { updateCalls += 1; },
        }];
      },
      async update() { updateCalls += 1; },
    },
  });
  assert.equal(result.freshness_status, 'stale');
  assert.equal(result.issues[0].code, 'DATA_MANAGER_DIAGNOSTICS_STALE_ACCEPTED');
  assert.equal(updateCalls, 0);
}

async function testDiscoveryOnlyReadsExplicitOptIns() {
  let readCalls = 0;
  let writeCalls = 0;
  const model = {
    async findAll() {
      readCalls += 1;
      return [
        { id: 1, group_id: 5, assignment_scope: 'group', config: { google_ads: {} } },
        {
          id: 2,
          group_id: 5,
          assignment_scope: 'group',
          config: {
            google_ads: {
              goal_policy: {
                enabled: true,
                accounts: [configuredAccount()],
              },
            },
          },
        },
      ];
    },
    async update() { writeCalls += 1; },
    async create() { writeCalls += 1; },
  };
  const discovered = await discoverGoalPolicyAuditTargets({ intakeModel: model });
  assert.equal(readCalls, 1);
  assert.equal(writeCalls, 0);
  assert.equal(discovered.targets.length, 1);
  assert.equal(discovered.targets[0].configured_accounts[0].customer_id, CUSTOMER);
  assert.deepEqual(discovered.targets[0].scope, { assignment_scope: 'group', clinic_id: null, group_id: 5 });
}

async function testPersistedAuditUsesSyncLogAndExistingAlertFlow() {
  const updates = [];
  const notifications = [];
  const result = await executePersistedGoalPolicyAudit({
    dependencies: {
      now: deterministicClock(),
      syncLogModel: {
        async create(values) {
          assert.equal(values.job_type, 'google_conversion_goal_policy_audit');
          return { async update(next) { updates.push(next); } };
        },
      },
      discoverTargets: async () => ({
        targets: [{
          intake_config_id: 24,
          scope: { group_id: 5, assignment_scope: 'group' },
          configured_accounts: [normalizeConfiguredAccounts([configuredAccount()])[0]],
        }],
        issues: [],
      }),
      audit: async () => ({
        preview_digest: 'a'.repeat(64),
        summary: { account_count: 1, critical_count: 1 },
        accounts: [{
          customer_id: CUSTOMER,
          issues: [{ severity: 'critical', code: 'GOAL_POLICY_DRIFT', message: 'drift' }],
        }],
      }),
      notifications: { async dispatchEvent(payload) { notifications.push(payload); } },
    },
  });
  assert.equal(result.status, 'failed');
  assert.equal(result.autorepair, false);
  assert.equal(result.external_mutation_count, 0);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, 'failed');
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].event, 'jobs.failed');
}

function testSixHourSchedulerIsWiredWithoutMigration() {
  const jobsSource = fs.readFileSync(path.resolve(__dirname, '../../jobs/sync.jobs.js'), 'utf8');
  const envSource = fs.readFileSync(path.resolve(__dirname, '../../../.env.example'), 'utf8');
  assert.match(jobsSource, /googleConversionGoalPolicyAudit:[\s\S]*17 \*\/6 \* \* \*/);
  assert.match(jobsSource, /executeGoogleConversionGoalPolicyAudit\(\)[\s\S]*executePersistedGoalPolicyAudit\(\)/);
  assert.match(envSource, /JOBS_GOOGLE_CONVERSION_GOAL_POLICY_AUDIT_SCHEDULE="17 \*\/6 \* \* \*"/);
  assert.equal(fs.existsSync(path.resolve(__dirname, '../../../migrations/20260712110000-google-goal-policy.js')), false);
}

async function main() {
  testConfigurationRequiresExplicitScope();
  testPlanContainsOnlyThreeSecondaryCanonicalActions();
  testCanonicalActionsMustAlreadyBeSafe();
  testCampaignGoalEnumerationFailsClosed();
  testForeignGoalsAreNeverOverwritten();
  testOutsideScopeCampaignFailsClosed();
  testMutationGuardRejectsBlastRadiusExpansion();
  await testPreviewIsReadOnlyAndDeterministic();
  await testDefaultProviderPreviewOnlySearches();
  await testApplyRequiresConfirmationAndFreshDigest();
  await testApplyExistingGoalValidatesBeforeMutation();
  await testApplyNewGoalReturnsAndCanPersistOwnership();
  await testDriftAfterValidateOnlyStopsBeforeRealMutation();
  await testAuditIsReadOnlyAndIncludesDiagnosticsFreshness();
  await testDiagnosticsReaderNeverUpdatesAttempts();
  await testDiscoveryOnlyReadsExplicitOptIns();
  await testPersistedAuditUsesSyncLogAndExistingAlertFlow();
  testSixHourSchedulerIsWiredWithoutMigration();
  console.log('google_ads_clinicaclick_goal_policy.test.js OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
