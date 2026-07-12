'use strict';

const assert = require('node:assert/strict');
const {
  APPROVAL_ROLES,
  DEFAULT_THRESHOLDS,
  MODES,
  SCHEMA_VERSION,
  STAGES,
  STAGE_TRANSITIONS,
  applyApprovedLifecycleTransition,
  approvalPolicyForMode,
  evaluateCampaignOptimizationLifecycle,
  normalizeThresholds,
} = require('../../services/campaignOptimizationLifecycle.service');

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date('2026-07-12T12:00:00.000Z');

function ago(days) {
  return new Date(NOW.getTime() - days * DAY).toISOString();
}

function state(stage = STAGES.MEASUREMENT, days = 30, overrides = {}) {
  return {
    stage,
    stage_entered_at: ago(days),
    last_transition_at: stage === STAGES.MEASUREMENT ? null : ago(days),
    last_evaluation_at: null,
    pending_transition: null,
    ...overrides,
  };
}

function qualifiedLeadMetrics(overrides = {}) {
  return {
    conversions_30d: 30,
    selected_campaign_ids: ['101', '102'],
    campaigns: [
      { campaign_id: '101', conversions_30d: 15 },
      { campaign_id: '102', conversions_30d: 15 },
    ],
    upload_success_rate: 0.95,
    duplicate_rate: 0.009,
    ...overrides,
  };
}

function scheduleMetrics(overrides = {}) {
  return {
    conversions_30d: 30,
    weekly_conversions: [5, 6, 7, 12],
    upload_success_rate: 0.95,
    ...overrides,
  };
}

function purchaseMetrics(overrides = {}) {
  return {
    conversions_30d: 30,
    real_value_rate: 0.90,
    fallback_value_rate: 0.05,
    ...overrides,
  };
}

function evaluate({
  mode = MODES.CONNECT_ONLY,
  lifecycleState = state(),
  metrics = { qualified_lead: qualifiedLeadMetrics() },
  now = NOW,
  thresholds,
} = {}) {
  return evaluateCampaignOptimizationLifecycle({ mode, state: lifecycleState, metrics, now, thresholds });
}

function secondPassingEvaluation(first, { metrics, now = new Date(NOW.getTime() + DAY), mode = MODES.CONNECT_ONLY } = {}) {
  return evaluateCampaignOptimizationLifecycle({
    mode,
    state: first.next_state,
    metrics: metrics || { qualified_lead: qualifiedLeadMetrics() },
    now,
  });
}

function blockerCodes(result) {
  return result.blockers.map((item) => item.code);
}

function testConstantsAndThresholdsAreSafe() {
  assert.equal(SCHEMA_VERSION, 'clinicaclick-campaign-optimization-lifecycle/v1');
  assert.deepEqual(STAGE_TRANSITIONS, {
    measurement: 'qualified_lead',
    qualified_lead: 'schedule',
    schedule: 'purchase',
    purchase: null,
  });
  assert.equal(Object.isFrozen(DEFAULT_THRESHOLDS), true);
  assert.equal(Object.isFrozen(DEFAULT_THRESHOLDS.qualified_lead), true);
  const custom = normalizeThresholds({
    minimum_evaluation_spacing_hours: 12,
    qualified_lead: { minimum_conversions_30d: 40 },
    schedule: { cooldown_days: 21 },
    purchase: { minimum_real_value_rate: 0.97 },
  });
  assert.equal(custom.minimum_evaluation_spacing_hours, 12);
  assert.equal(custom.qualified_lead.minimum_conversions_30d, 40);
  assert.equal(custom.qualified_lead.minimum_observation_days, 14);
  assert.equal(custom.schedule.cooldown_days, 21);
  assert.equal(custom.purchase.minimum_real_value_rate, 0.97);
  assert.throws(() => normalizeThresholds({ consecutive_passing_evaluations: 1 }), /umbral inválido/);
  assert.throws(() => normalizeThresholds({ qualified_lead: { minimum_upload_success_rate: 1.1 } }), /umbral inválido/);
  assert.throws(() => normalizeThresholds([]), /debe ser un objeto/);
}

function testApprovalPolicyIsExplicitAndModeBound() {
  assert.deepEqual(approvalPolicyForMode(MODES.CONNECT_ONLY), {
    required: true,
    role: APPROVAL_ROLES.CLIENT,
    automatic_provider_mutation: false,
  });
  assert.deepEqual(approvalPolicyForMode(MODES.MANAGED_SERVICE), {
    required: true,
    role: APPROVAL_ROLES.OPERATOR,
    automatic_provider_mutation: false,
  });
  assert.throws(() => approvalPolicyForMode('automatic'), /mode debe ser/);
}

function testQualifiedLeadExactBoundaryNeedsTwoEvaluations() {
  const first = evaluate({ lifecycleState: state(STAGES.MEASUREMENT, 14) });
  assert.equal(first.eligible_now, true);
  assert.equal(first.ready_for_approval, false);
  assert.equal(first.consecutive_passes, 1);
  assert.deepEqual(blockerCodes(first), ['CONSECUTIVE_EVALUATIONS_PENDING']);
  assert.equal(first.provider_mutation, null);
  assert.equal(first.approval.role, APPROVAL_ROLES.CLIENT);

  const second = secondPassingEvaluation(first);
  assert.equal(second.eligible_now, true);
  assert.equal(second.ready_for_approval, true);
  assert.equal(second.consecutive_passes, 2);
  assert.deepEqual(second.blockers, []);
  assert.equal(second.candidate_stage, STAGES.QUALIFIED_LEAD);
}

function testQualifiedLeadThresholdsFailClosed() {
  const cases = [
    [state(STAGES.MEASUREMENT, 13.99), qualifiedLeadMetrics(), 'QL_OBSERVATION_TOO_SHORT'],
    [state(), qualifiedLeadMetrics({ conversions_30d: 29 }), 'QL_VOLUME_TOO_LOW'],
    [state(), qualifiedLeadMetrics({ upload_success_rate: 0.949 }), 'QL_UPLOAD_RATE_TOO_LOW'],
    [state(), qualifiedLeadMetrics({ duplicate_rate: 0.01 }), 'QL_DUPLICATE_RATE_TOO_HIGH'],
    [state(), qualifiedLeadMetrics({ campaigns: [{ campaign_id: '101', conversions_30d: 9 }, { campaign_id: '102', conversions_30d: 21 }] }), 'QL_CAMPAIGN_VOLUME_TOO_LOW'],
    [state(), qualifiedLeadMetrics({ selected_campaign_ids: [] }), 'QL_SELECTED_CAMPAIGNS_MISSING'],
    [state(), qualifiedLeadMetrics({ campaigns: [{ campaign_id: '101', conversions_30d: 30 }] }), 'QL_CAMPAIGN_METRIC_MISSING'],
    [state(), qualifiedLeadMetrics({ campaigns: [...qualifiedLeadMetrics().campaigns, { campaign_id: '999', conversions_30d: 10 }] }), 'QL_CAMPAIGN_NOT_SELECTED'],
  ];
  cases.forEach(([lifecycleState, metric, expected]) => {
    const result = evaluate({ lifecycleState, metrics: { qualified_lead: metric } });
    assert.equal(result.eligible_now, false, expected);
    assert.ok(blockerCodes(result).includes(expected), expected);
    assert.equal(result.next_state.pending_transition, null);
  });
  const missing = evaluate({ metrics: {} });
  assert.deepEqual(blockerCodes(missing), ['QL_METRICS_MISSING']);
}

function testRatesCanBeDerivedFromCounts() {
  const result = evaluate({
    metrics: {
      qualified_lead: qualifiedLeadMetrics({
        upload_success_rate: undefined,
        uploaded_successfully: 95,
        upload_attempts: 100,
        duplicate_rate: undefined,
        duplicate_events: 0,
        total_events: 100,
      }),
    },
  });
  assert.equal(result.eligible_now, true);
  assert.equal(result.evidence.upload_success_rate, 0.95);
  assert.equal(result.evidence.duplicate_rate, 0);
}

function testPassingEvaluationsMustBeSeparatedAndConsecutive() {
  const first = evaluate();
  const tooSoon = secondPassingEvaluation(first, { now: new Date(NOW.getTime() + 23 * 60 * 60 * 1000) });
  assert.equal(tooSoon.ready_for_approval, false);
  assert.equal(tooSoon.consecutive_passes, 1);
  assert.ok(blockerCodes(tooSoon).includes('CONSECUTIVE_EVALUATION_TOO_SOON'));

  const failed = secondPassingEvaluation(first, {
    metrics: { qualified_lead: qualifiedLeadMetrics({ conversions_30d: 29 }) },
  });
  assert.equal(failed.eligible_now, false);
  assert.equal(failed.next_state.pending_transition, null);
  const restarted = evaluateCampaignOptimizationLifecycle({
    mode: MODES.CONNECT_ONLY,
    state: failed.next_state,
    metrics: { qualified_lead: qualifiedLeadMetrics() },
    now: new Date(NOW.getTime() + 2 * DAY),
  });
  assert.equal(restarted.consecutive_passes, 1);
  assert.equal(restarted.ready_for_approval, false);
}

function testScheduleRequiresVolumeStabilityUploadAndCooldown() {
  const exact = evaluate({
    lifecycleState: state(STAGES.QUALIFIED_LEAD, 14),
    metrics: { schedule: scheduleMetrics() },
  });
  assert.equal(exact.eligible_now, true);
  assert.equal(exact.candidate_stage, STAGES.SCHEDULE);
  assert.equal(exact.evidence.cooldown_days_elapsed, 14);
  const cases = [
    [scheduleMetrics({ conversions_30d: 29 }), state(STAGES.QUALIFIED_LEAD, 14), 'SCHEDULE_VOLUME_TOO_LOW'],
    [scheduleMetrics({ upload_success_rate: 0.949 }), state(STAGES.QUALIFIED_LEAD, 14), 'SCHEDULE_UPLOAD_RATE_TOO_LOW'],
    [scheduleMetrics({ weekly_conversions: [5, 5, 5] }), state(STAGES.QUALIFIED_LEAD, 14), 'SCHEDULE_WEEKLY_HISTORY_MISSING'],
    [scheduleMetrics({ weekly_conversions: [5, 4, 10, 11] }), state(STAGES.QUALIFIED_LEAD, 14), 'SCHEDULE_WEEKLY_VOLUME_TOO_LOW'],
    [scheduleMetrics(), state(STAGES.QUALIFIED_LEAD, 13.99), 'SCHEDULE_COOLDOWN_ACTIVE'],
  ];
  cases.forEach(([metric, lifecycleState, expected]) => {
    const result = evaluate({ lifecycleState, metrics: { schedule: metric } });
    assert.equal(result.eligible_now, false, expected);
    assert.ok(blockerCodes(result).includes(expected), expected);
  });
}

function testPurchaseRequiresRealValuesAndFourWeeksDwell() {
  const exact = evaluate({
    lifecycleState: state(STAGES.SCHEDULE, 28),
    metrics: { purchase: purchaseMetrics() },
  });
  assert.equal(exact.eligible_now, true);
  assert.equal(exact.candidate_stage, STAGES.PURCHASE);
  const cases = [
    [purchaseMetrics({ conversions_30d: 29 }), state(STAGES.SCHEDULE, 28), 'PURCHASE_VOLUME_TOO_LOW'],
    [purchaseMetrics({ real_value_rate: 0.899 }), state(STAGES.SCHEDULE, 28), 'PURCHASE_REAL_VALUE_RATE_TOO_LOW'],
    [purchaseMetrics({ fallback_value_rate: 0.051 }), state(STAGES.SCHEDULE, 28), 'PURCHASE_FALLBACK_RATE_TOO_HIGH'],
    [purchaseMetrics(), state(STAGES.SCHEDULE, 27.99), 'PURCHASE_DWELL_TOO_SHORT'],
  ];
  cases.forEach(([metric, lifecycleState, expected]) => {
    const result = evaluate({ lifecycleState, metrics: { purchase: metric } });
    assert.equal(result.eligible_now, false, expected);
    assert.ok(blockerCodes(result).includes(expected), expected);
  });
}

function testApprovedTransitionIsPureAndRoleBound() {
  const first = evaluate();
  const ready = secondPassingEvaluation(first);
  const snapshot = structuredClone(ready);
  const transitioned = applyApprovedLifecycleTransition({
    evaluation: ready,
    approval: {
      approved: true,
      role: APPROVAL_ROLES.CLIENT,
      actor_id: 'user-7',
      approved_at: '2026-07-13T13:00:00.000Z',
    },
  });
  assert.equal(transitioned.transitioned, true);
  assert.equal(transitioned.to_stage, STAGES.QUALIFIED_LEAD);
  assert.equal(transitioned.next_state.stage, STAGES.QUALIFIED_LEAD);
  assert.equal(transitioned.next_state.pending_transition, null);
  assert.equal(transitioned.provider_mutation, null);
  assert.deepEqual(ready, snapshot);

  assert.throws(() => applyApprovedLifecycleTransition({ evaluation: ready, approval: { approved: true, role: APPROVAL_ROLES.OPERATOR, actor_id: 'op-1' } }), /rol client/);
  assert.throws(() => applyApprovedLifecycleTransition({ evaluation: ready, approval: { approved: false, role: APPROVAL_ROLES.CLIENT, actor_id: 'user-7' } }), /aprobación explícita/);
  assert.throws(() => applyApprovedLifecycleTransition({ evaluation: ready, approval: { approved: true, role: APPROVAL_ROLES.CLIENT } }), /actor_id/);
  assert.throws(() => applyApprovedLifecycleTransition({ evaluation: first, approval: { approved: true, role: APPROVAL_ROLES.CLIENT, actor_id: 'user-7' } }), /todavía no está lista/);

  const tampered = structuredClone(ready);
  tampered.evidence.conversions_30d = 300;
  assert.throws(() => applyApprovedLifecycleTransition({ evaluation: tampered, approval: { approved: true, role: APPROVAL_ROLES.CLIENT, actor_id: 'user-7', approved_at: '2026-07-13T13:00:00.000Z' } }), /modificada/);
}

function testManagedServiceRequiresOperatorApproval() {
  const first = evaluate({ mode: MODES.MANAGED_SERVICE });
  const ready = secondPassingEvaluation(first, { mode: MODES.MANAGED_SERVICE });
  assert.equal(ready.approval.role, APPROVAL_ROLES.OPERATOR);
  assert.throws(() => applyApprovedLifecycleTransition({
    evaluation: ready,
    approval: { approved: true, role: APPROVAL_ROLES.CLIENT, actor_id: 'user-7' },
  }), /rol operator/);
  const applied = applyApprovedLifecycleTransition({
    evaluation: ready,
    approval: { approved: true, role: APPROVAL_ROLES.OPERATOR, actor_id: 'operator-3', approved_at: '2026-07-13T13:00:00.000Z' },
  });
  assert.equal(applied.next_state.stage, STAGES.QUALIFIED_LEAD);
}

function testTerminalStageNeverSuggestsMutation() {
  const terminal = evaluate({ lifecycleState: state(STAGES.PURCHASE, 90), metrics: {} });
  assert.equal(terminal.candidate_stage, null);
  assert.equal(terminal.ready_for_approval, false);
  assert.equal(terminal.provider_mutation, null);
  assert.deepEqual(blockerCodes(terminal), ['TERMINAL_STAGE']);
}

function testEvaluationIsDeterministicAndDoesNotMutateInputs() {
  const lifecycleState = state();
  const metrics = { qualified_lead: qualifiedLeadMetrics() };
  const stateBefore = structuredClone(lifecycleState);
  const metricsBefore = structuredClone(metrics);
  const left = evaluate({ lifecycleState, metrics });
  const right = evaluate({ lifecycleState, metrics });
  assert.deepEqual(left, right);
  assert.equal(left.decision_digest, right.decision_digest);
  assert.deepEqual(lifecycleState, stateBefore);
  assert.deepEqual(metrics, metricsBefore);
  assert.throws(() => evaluate({ lifecycleState: { stage: 'lead' } }), /state.stage/);
  assert.throws(() => evaluate({ lifecycleState: state(STAGES.MEASUREMENT, -1) }), /futuro/);
}

const tests = [
  testConstantsAndThresholdsAreSafe,
  testApprovalPolicyIsExplicitAndModeBound,
  testQualifiedLeadExactBoundaryNeedsTwoEvaluations,
  testQualifiedLeadThresholdsFailClosed,
  testRatesCanBeDerivedFromCounts,
  testPassingEvaluationsMustBeSeparatedAndConsecutive,
  testScheduleRequiresVolumeStabilityUploadAndCooldown,
  testPurchaseRequiresRealValuesAndFourWeeksDwell,
  testApprovedTransitionIsPureAndRoleBound,
  testManagedServiceRequiresOperatorApproval,
  testTerminalStageNeverSuggestsMutation,
  testEvaluationIsDeterministicAndDoesNotMutateInputs,
];

for (const test of tests) test();
console.log(`campaign optimization lifecycle: ${tests.length} tests passed`);
