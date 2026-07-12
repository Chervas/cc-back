'use strict';

const assert = require('node:assert/strict');
const {
  buildCanonicalConversionNormalizationPlan,
  normalizeCanonicalGoogleAdsConversions,
  normalizeConfiguredAccounts,
  assertSafeOperations,
} = require('../../services/googleAdsCanonicalConversionNormalization.service');

const CUSTOMER_A = '1851215478';
const CUSTOMER_B = '5992356722';

function googleRow({
  customerId = CUSTOMER_A,
  id,
  name,
  type = 'UPLOAD_CLICKS',
  status = 'ENABLED',
  countingType = 'ONE_PER_CLICK',
  primaryForGoal = true,
  ownerCustomer = `customers/${customerId}`,
  resourceName = `customers/${customerId}/conversionActions/${id}`,
}) {
  return {
    conversionAction: {
      id: String(id),
      resourceName,
      ownerCustomer,
      name,
      type,
      status,
      countingType,
      primaryForGoal,
    },
  };
}

function normalizedAction(input) {
  return {
    id: String(input.id),
    resource_name: input.resourceName || `customers/${input.customerId || CUSTOMER_A}/conversionActions/${input.id}`,
    owner_customer: input.ownerCustomer || `customers/${input.customerId || CUSTOMER_A}`,
    name: input.name,
    type: input.type || 'UPLOAD_CLICKS',
    status: input.status || 'ENABLED',
    counting_type: input.countingType || 'ONE_PER_CLICK',
    primary_for_goal: input.primaryForGoal === undefined ? true : input.primaryForGoal,
  };
}

function deterministicClock() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 12, 11, 0, tick++));
}

function runtimeResolver(customerIds) {
  const allowed = new Set(customerIds);
  return async ({ customerId }) => {
    if (!allowed.has(customerId)) {
      const error = new Error('account forbidden');
      error.code = 'CUSTOMER_NOT_ASSIGNED_TO_SCOPE';
      error.httpStatus = 403;
      throw error;
    }
    return {
      customerId,
      loginCustomerId: '1234567890',
      accessToken: `secret-${customerId}`,
    };
  };
}

function testConfiguredSelectorsAreStrict() {
  assert.deepEqual(normalizeConfiguredAccounts([{
    customer_id: '185-121-5478',
    expected_actions: [
      'Lead - ClinicaClick',
      { id: '007540337982', name: 'Contact - ClinicaClick' },
    ],
  }]), [{
    customer_id: CUSTOMER_A,
    expected_actions: [
      { id: null, name: 'Lead - ClinicaClick' },
      { id: '7540337982', name: 'Contact - ClinicaClick' },
    ],
  }]);

  assert.throws(
    () => normalizeConfiguredAccounts([{
      customer_id: CUSTOMER_A,
      expected_actions: ['lead - clinicaclick'],
    }]),
    (error) => error.code === 'EXPECTED_ACTION_NAME_NOT_CANONICAL',
  );
  assert.throws(
    () => normalizeConfiguredAccounts([{
      customer_id: CUSTOMER_A,
      expected_actions: [{ id: 'abc' }],
    }]),
    (error) => error.code === 'EXPECTED_ACTION_ID_INVALID',
  );
  assert.throws(
    () => normalizeConfiguredAccounts([{
      customer_id: CUSTOMER_A,
      expected_actions: ['Lead - ClinicaClick', 'Lead - ClinicaClick'],
    }]),
    (error) => error.code === 'EXPECTED_ACTION_NAME_DUPLICATE',
  );
}

function testPlanTouchesOnlySelectedCanonicalActions() {
  const providerActions = [
    normalizedAction({ id: '1', name: 'Lead - ClinicaClick' }),
    normalizedAction({ id: '2', name: 'Contact - ClinicaClick', countingType: 'MANY_PER_CLICK', primaryForGoal: false }),
    normalizedAction({ id: '3', name: 'Schedule - ClinicaClick' }),
    normalizedAction({ id: '4', name: 'Purchase - ClinicaClick' }),
    normalizedAction({ id: '5', name: 'Lead formulario cliente' }),
  ];
  const plan = buildCanonicalConversionNormalizationPlan({
    customerId: CUSTOMER_A,
    expectedActions: [
      { id: '1', name: null },
      { id: null, name: 'Contact - ClinicaClick' },
    ],
    providerActions,
  });

  assert.equal(plan.blocked, false);
  assert.equal(plan.selected_action_count, 2);
  assert.equal(plan.changed_action_count, 1);
  assert.equal(plan.unchanged_action_count, 1);
  assert.equal(plan.operations.length, 1);
  assert.deepEqual(plan.operations[0], {
    update: {
      resourceName: `customers/${CUSTOMER_A}/conversionActions/1`,
      countingType: 'MANY_PER_CLICK',
      primaryForGoal: false,
    },
    updateMask: 'counting_type,primary_for_goal',
  });
  const serialized = JSON.stringify(plan.operations);
  assert.equal(serialized.includes('/conversionActions/3'), false);
  assert.equal(serialized.includes('/conversionActions/4'), false);
  assert.equal(serialized.includes('/conversionActions/5'), false);
}

function testIdStillRequiresCanonicalNameTypeAndAccount() {
  for (const [action, expectedCode] of [
    [normalizedAction({ id: '1', name: 'Acción del cliente' }), 'ACTION_NAME_NOT_CANONICAL'],
    [normalizedAction({ id: '1', name: 'Lead - ClinicaClick', type: 'WEBPAGE' }), 'ACTION_TYPE_NOT_UPLOAD_CLICKS'],
    [normalizedAction({
      id: '1',
      name: 'Lead - ClinicaClick',
      ownerCustomer: `customers/${CUSTOMER_B}`,
      resourceName: `customers/${CUSTOMER_B}/conversionActions/1`,
    }), 'ACTION_ACCOUNT_MISMATCH'],
    [normalizedAction({ id: '1', name: 'Lead - ClinicaClick', status: 'REMOVED' }), 'ACTION_STATUS_NOT_MUTABLE'],
  ]) {
    const plan = buildCanonicalConversionNormalizationPlan({
      customerId: CUSTOMER_A,
      expectedActions: [{ id: '1', name: null }],
      providerActions: [action],
    });
    assert.equal(plan.blocked, true);
    assert.equal(plan.operations.length, 0);
    assert.ok(plan.blockers.some((blocker) => blocker.code === expectedCode));
  }
}

function testNameOnlySelectionFailsClosedOnDuplicates() {
  const plan = buildCanonicalConversionNormalizationPlan({
    customerId: CUSTOMER_A,
    expectedActions: [{ id: null, name: 'Lead - ClinicaClick' }],
    providerActions: [
      normalizedAction({ id: '1', name: 'Lead - ClinicaClick' }),
      normalizedAction({ id: '2', name: 'Lead - ClinicaClick' }),
    ],
  });
  assert.equal(plan.blocked, true);
  assert.equal(plan.operations.length, 0);
  assert.equal(plan.blockers[0].code, 'EXPECTED_ACTION_NAME_AMBIGUOUS');

  const duplicateIds = buildCanonicalConversionNormalizationPlan({
    customerId: CUSTOMER_A,
    expectedActions: [{ id: '1', name: null }, { id: '2', name: null }],
    providerActions: [
      normalizedAction({ id: '1', name: 'Lead - ClinicaClick' }),
      normalizedAction({ id: '2', name: 'Lead - ClinicaClick' }),
    ],
  });
  assert.equal(duplicateIds.blocked, true);
  assert.equal(duplicateIds.operations.length, 0);
  assert.ok(duplicateIds.blockers.some((blocker) => (
    blocker.code === 'ACTION_CANONICAL_NAME_SELECTED_TWICE'
  )));
}

async function testPreviewDoesNotCallMutate() {
  const calls = [];
  const result = await normalizeCanonicalGoogleAdsConversions({
    scope: { group_id: 5, assignment_scope: 'group' },
    configuredAccounts: [{
      customer_id: CUSTOMER_A,
      expected_actions: [{ id: '1', name: 'Lead - ClinicaClick' }],
    }],
    dependencies: {
      now: deterministicClock(),
      resolveRuntime: runtimeResolver([CUSTOMER_A]),
      request: async (_method, path, options) => {
        calls.push({ path, data: options.data });
        assert.equal(path, `customers/${CUSTOMER_A}/googleAds:search`);
        return { results: [googleRow({ id: '1', name: 'Lead - ClinicaClick' })] };
      },
    },
  });
  assert.equal(result.mode, 'preview');
  assert.equal(result.accounts[0].outcome, 'ready');
  assert.equal(calls.length, 1);
  assert.equal(calls.some((call) => call.path.endsWith('conversionActions:mutate')), false);
}

async function testValidateOnlyUsesExactSafePayload() {
  const calls = [];
  const result = await normalizeCanonicalGoogleAdsConversions({
    scope: { group_id: 5, assignment_scope: 'group' },
    configuredAccounts: [{
      customer_id: CUSTOMER_A,
      expected_actions: [
        { id: '1', name: 'Lead - ClinicaClick' },
        { id: '2', name: 'Schedule - ClinicaClick' },
      ],
    }],
    validateOnly: true,
    dependencies: {
      now: deterministicClock(),
      resolveRuntime: runtimeResolver([CUSTOMER_A]),
      request: async (_method, path, options) => {
        calls.push({ path, data: options.data });
        if (path.endsWith('googleAds:search')) {
          return { results: [
            googleRow({ id: '1', name: 'Lead - ClinicaClick' }),
            googleRow({ id: '2', name: 'Schedule - ClinicaClick' }),
          ] };
        }
        assert.equal(path, `customers/${CUSTOMER_A}/conversionActions:mutate`);
        assert.equal(options.data.validateOnly, true);
        assert.equal(options.data.partialFailure, false);
        assert.equal(options.data.operations.length, 2);
        for (const operation of options.data.operations) {
          assert.deepEqual(Object.keys(operation.update).sort(), [
            'countingType', 'primaryForGoal', 'resourceName',
          ]);
          assert.equal(operation.update.countingType, 'MANY_PER_CLICK');
          assert.equal(operation.update.primaryForGoal, false);
          assert.equal(operation.updateMask, 'counting_type,primary_for_goal');
        }
        return {};
      },
    },
  });
  assert.equal(result.accounts[0].outcome, 'validated');
  assert.equal(result.accounts[0].validation.operation_count, 2);
  assert.equal(result.accounts[0].mutation.requested, false);
  assert.equal(calls.filter((call) => call.path.endsWith('conversionActions:mutate')).length, 1);
}

async function testApplyRequiresExplicitConfirmation() {
  await assert.rejects(
    normalizeCanonicalGoogleAdsConversions({
      configuredAccounts: [{
        customer_id: CUSTOMER_A,
        expected_actions: ['Lead - ClinicaClick'],
      }],
      apply: true,
    }),
    (error) => error.code === 'EXTERNAL_MUTATION_CONFIRMATION_REQUIRED',
  );
  await assert.rejects(
    normalizeCanonicalGoogleAdsConversions({
      configuredAccounts: [{
        customer_id: CUSTOMER_A,
        expected_actions: ['Lead - ClinicaClick'],
      }],
      apply: 'true',
    }),
    (error) => error.code === 'NORMALIZATION_FLAG_INVALID',
  );
}

async function testApplyValidatesChecksDriftMutatesAndRereads() {
  const calls = [];
  let state = { countingType: 'ONE_PER_CLICK', primaryForGoal: true };
  const result = await normalizeCanonicalGoogleAdsConversions({
    scope: { group_id: 5, assignment_scope: 'group' },
    configuredAccounts: [{
      customer_id: CUSTOMER_A,
      expected_actions: [{ id: '1', name: 'Lead - ClinicaClick' }],
    }],
    apply: true,
    confirmExternalMutation: true,
    dependencies: {
      now: deterministicClock(),
      resolveRuntime: runtimeResolver([CUSTOMER_A]),
      request: async (_method, path, options) => {
        calls.push({ path, data: options.data });
        if (path.endsWith('googleAds:search')) {
          return { results: [googleRow({
            id: '1',
            name: 'Lead - ClinicaClick',
            countingType: state.countingType,
            primaryForGoal: state.primaryForGoal,
          })] };
        }
        if (options.data.validateOnly === false) {
          state = { countingType: 'MANY_PER_CLICK', primaryForGoal: false };
          return { results: [{ resourceName: `customers/${CUSTOMER_A}/conversionActions/1` }] };
        }
        return {};
      },
    },
  });
  assert.equal(result.mode, 'apply');
  assert.equal(result.external_mutation_confirmed, true);
  assert.equal(result.accounts[0].outcome, 'applied');
  assert.equal(result.accounts[0].verification[0].verified, true);
  assert.deepEqual(
    calls.filter((call) => call.path.endsWith('conversionActions:mutate'))
      .map((call) => call.data.validateOnly),
    [true, false],
  );
  assert.equal(calls.filter((call) => call.path.endsWith('googleAds:search')).length, 3);
}

async function testDriftStopsBeforeRealMutation() {
  const calls = [];
  let reads = 0;
  const result = await normalizeCanonicalGoogleAdsConversions({
    scope: { group_id: 5, assignment_scope: 'group' },
    configuredAccounts: [{
      customer_id: CUSTOMER_A,
      expected_actions: [{ id: '1', name: 'Lead - ClinicaClick' }],
    }],
    apply: true,
    confirmExternalMutation: true,
    dependencies: {
      now: deterministicClock(),
      resolveRuntime: runtimeResolver([CUSTOMER_A]),
      request: async (_method, path, options) => {
        calls.push({ path, data: options.data });
        if (path.endsWith('googleAds:search')) {
          reads += 1;
          return { results: [googleRow({
            id: '1',
            name: 'Lead - ClinicaClick',
            countingType: reads === 1 ? 'ONE_PER_CLICK' : 'MANY_PER_CLICK',
            primaryForGoal: true,
          })] };
        }
        assert.equal(options.data.validateOnly, true);
        return {};
      },
    },
  });
  assert.equal(result.accounts[0].outcome, 'blocked');
  assert.equal(result.accounts[0].blockers[0].code, 'CONVERSION_ACTION_STATE_CHANGED');
  assert.deepEqual(
    calls.filter((call) => call.path.endsWith('conversionActions:mutate'))
      .map((call) => call.data.validateOnly),
    [true],
  );
}

async function testAlreadyNormalizedDoesNotCallMutate() {
  const calls = [];
  const result = await normalizeCanonicalGoogleAdsConversions({
    scope: { group_id: 5, assignment_scope: 'group' },
    configuredAccounts: [{
      customer_id: CUSTOMER_A,
      expected_actions: ['Lead - ClinicaClick'],
    }],
    validateOnly: true,
    dependencies: {
      now: deterministicClock(),
      resolveRuntime: runtimeResolver([CUSTOMER_A]),
      request: async (_method, path, options) => {
        calls.push({ path, data: options.data });
        return { results: [googleRow({
          id: '1',
          name: 'Lead - ClinicaClick',
          countingType: 'MANY_PER_CLICK',
          primaryForGoal: false,
        })] };
      },
    },
  });
  assert.equal(result.accounts[0].outcome, 'unchanged');
  assert.equal(calls.length, 1);
  assert.equal(calls.some((call) => call.path.endsWith('conversionActions:mutate')), false);
}

async function testAccountsAreIsolatedWhenOneFails() {
  const calls = [];
  const result = await normalizeCanonicalGoogleAdsConversions({
    scope: { group_id: 5, assignment_scope: 'group' },
    configuredAccounts: [
      { customer_id: CUSTOMER_A, expected_actions: ['Lead - ClinicaClick'] },
      { customer_id: CUSTOMER_B, expected_actions: ['Schedule - ClinicaClick'] },
    ],
    validateOnly: true,
    dependencies: {
      now: deterministicClock(),
      resolveRuntime: runtimeResolver([CUSTOMER_A, CUSTOMER_B]),
      request: async (_method, path, options) => {
        calls.push({ path, data: options.data });
        if (path === `customers/${CUSTOMER_A}/googleAds:search`) {
          const error = new Error('denied');
          error.code = 'PERMISSION_DENIED';
          throw error;
        }
        if (path === `customers/${CUSTOMER_B}/googleAds:search`) {
          return { results: [googleRow({
            customerId: CUSTOMER_B,
            id: '2',
            name: 'Schedule - ClinicaClick',
          })] };
        }
        assert.equal(path, `customers/${CUSTOMER_B}/conversionActions:mutate`);
        assert.match(options.data.operations[0].update.resourceName, new RegExp(`^customers/${CUSTOMER_B}/`));
        return {};
      },
    },
  });
  assert.deepEqual(result.accounts.map((account) => account.outcome), ['failed', 'validated']);
  assert.equal(calls.some((call) => call.path === `customers/${CUSTOMER_A}/conversionActions:mutate`), false);
  assert.equal(calls.some((call) => call.path === `customers/${CUSTOMER_B}/conversionActions:mutate`), true);
  assert.equal(JSON.stringify(result).includes(`secret-${CUSTOMER_A}`), false);
  assert.equal(JSON.stringify(result).includes(`secret-${CUSTOMER_B}`), false);
}

function testMutationGuardRejectsExtraFieldsAndWrongAccount() {
  assert.throws(
    () => assertSafeOperations(CUSTOMER_A, [{
        update: {
          resourceName: `customers/${CUSTOMER_B}/conversionActions/1`,
          countingType: 'MANY_PER_CLICK',
          primaryForGoal: false,
        },
        updateMask: 'counting_type,primary_for_goal',
      }]),
    (error) => error.code === 'NORMALIZATION_OPERATION_NOT_CANONICAL',
  );
  assert.throws(
    () => assertSafeOperations(CUSTOMER_A, [{
        update: {
          resourceName: `customers/${CUSTOMER_A}/conversionActions/1`,
          countingType: 'MANY_PER_CLICK',
          primaryForGoal: false,
          status: 'REMOVED',
        },
        updateMask: 'counting_type,primary_for_goal,status',
      }]),
    (error) => error.code === 'NORMALIZATION_OPERATION_NOT_CANONICAL',
  );
}

async function main() {
  testConfiguredSelectorsAreStrict();
  testPlanTouchesOnlySelectedCanonicalActions();
  testIdStillRequiresCanonicalNameTypeAndAccount();
  testNameOnlySelectionFailsClosedOnDuplicates();
  await testPreviewDoesNotCallMutate();
  await testValidateOnlyUsesExactSafePayload();
  await testApplyRequiresExplicitConfirmation();
  await testApplyValidatesChecksDriftMutatesAndRereads();
  await testDriftStopsBeforeRealMutation();
  await testAlreadyNormalizedDoesNotCallMutate();
  await testAccountsAreIsolatedWhenOneFails();
  testMutationGuardRejectsExtraFieldsAndWrongAccount();
  console.log('google_ads_canonical_conversion_normalization.test.js OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
