'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildLifecycleMetrics,
  createCampaignOptimizationEvaluationService,
} = require('../../services/campaignOptimizationEvaluation.service');

const NOW = new Date('2026-07-12T12:00:00.000Z');

function policy(overrides = {}) {
  return {
    id: 7,
    scopeType: 'group',
    scopeId: 5,
    grupoClinicaId: 5,
    clinicaId: null,
    mode: 'connect_only',
    customerIds: ['1851215478'],
    campaignIds: ['101', '102'],
    lifecycleState: {
      stage: 'measurement',
      stage_entered_at: '2026-06-01T00:00:00.000Z',
      last_transition_at: null,
      last_evaluation_at: null,
      pending_transition: null,
    },
    thresholds: {},
    status: 'active',
    version: 3,
    ...overrides,
  };
}

function attempt(overrides = {}) {
  return {
    customerId: '1851215478',
    conversionAction: 'customers/1851215478/conversionActions/1',
    eventName: 'qualified_lead',
    eventId: 'lead-1-qualified',
    status: 'succeeded',
    reason: null,
    attemptCount: 1,
    attemptedAt: new Date('2026-07-11T10:00:00.000Z'),
    completedAt: new Date('2026-07-11T10:01:00.000Z'),
    requestMetadata: {},
    ...overrides,
  };
}

function testAggregationIsHonestAboutMissingDimensions() {
  const attempts = [
    attempt(),
    attempt({ attemptedAt: new Date('2026-07-11T11:00:00.000Z') }),
    attempt({
      eventId: 'lead-2-qualified',
      status: 'accepted',
      attemptedAt: new Date('2026-07-09T00:00:00.000Z'),
      completedAt: null,
    }),
  ];
  const result = buildLifecycleMetrics({ policy: policy(), attempts, now: NOW });
  const metric = result.metrics.qualified_lead;
  assert.equal(metric.conversions_30d, 1);
  assert.equal(metric.upload_success_rate, 2 / 3);
  assert.equal(metric.duplicate_events, 1);
  assert.equal(metric.duplicate_rate, 1 / 3);
  assert.equal(metric.stale_attempts, 1);
  assert.deepEqual(metric.campaigns, []);
  const codes = result.qualityBlockers.map((item) => item.code);
  assert.ok(codes.includes('CAMPAIGN_BREAKDOWN_UNAVAILABLE'));
  assert.ok(codes.includes('STALE_QUALIFIED_LEAD_UPLOADS'));
  assert.equal(Object.hasOwn(metric, 'weekly_conversions'), false);
}

function testScheduleAndPurchaseDoNotInventEvidence() {
  const schedule = buildLifecycleMetrics({
    policy: policy({ lifecycleState: { stage: 'qualified_lead' } }),
    attempts: [attempt({ eventName: 'schedule', eventId: 'schedule-1' })],
    now: NOW,
  });
  assert.equal(Object.hasOwn(schedule.metrics.schedule, 'weekly_conversions'), false);
  assert.ok(schedule.qualityBlockers.some((item) => item.code === 'SCHEDULE_WEEKLY_HISTORY_UNAVAILABLE'));

  const purchase = buildLifecycleMetrics({
    policy: policy({ lifecycleState: { stage: 'schedule' } }),
    attempts: [attempt({ eventName: 'purchase', eventId: 'purchase-1', requestMetadata: { has_value: true } })],
    now: NOW,
  });
  assert.equal(Object.hasOwn(purchase.metrics.purchase, 'real_value_rate'), false);
  assert.equal(Object.hasOwn(purchase.metrics.purchase, 'fallback_value_rate'), false);
  assert.ok(purchase.qualityBlockers.some((item) => item.code === 'PURCHASE_VALUE_PROVENANCE_UNAVAILABLE'));
}

async function testDailyEvaluationPersistsWithCasAndIsIdempotent() {
  let existing = null;
  let createCount = 0;
  let attemptReads = 0;
  let policyUpdate = null;
  const Evaluation = {
    async findOne() { return existing; },
    async create(values) {
      createCount += 1;
      existing = { id: 99, ...values };
      return existing;
    },
  };
  const Policy = {
    async update(values, options) {
      policyUpdate = { values, options };
      return [1];
    },
    async findAll() { return []; },
  };
  const Attempt = {
    async findAll() {
      attemptReads += 1;
      return [attempt()];
    },
  };
  const service = createCampaignOptimizationEvaluationService({
    Policy,
    Evaluation,
    Attempt,
    sequelize: null,
  });

  const first = await service.evaluatePolicy(policy(), { now: NOW });
  assert.equal(first.created, true);
  assert.equal(createCount, 1);
  assert.equal(attemptReads, 1);
  assert.equal(first.evaluation.policyVersion, 3);
  assert.equal(first.evaluation.evaluationDate, '2026-07-12');
  assert.equal(first.evaluation.eligibleNow, false);
  assert.ok(first.evaluation.blockers.some((item) => item.code === 'QL_CAMPAIGN_METRICS_MISSING'));
  assert.ok(first.evaluation.blockers.some((item) => item.code === 'CAMPAIGN_BREAKDOWN_UNAVAILABLE'));
  assert.deepEqual(policyUpdate.options.where, { id: 7, version: 3, status: 'active' });
  assert.equal(policyUpdate.values.version, 4);
  assert.equal(policyUpdate.values.lifecycleState.pending_transition, null);

  const second = await service.evaluatePolicy(policy(), { now: NOW });
  assert.equal(second.idempotent, true);
  assert.equal(createCount, 1);
  assert.equal(attemptReads, 1);
}

async function testCasConflictIsExplicit() {
  const service = createCampaignOptimizationEvaluationService({
    Policy: { async update() { return [0]; } },
    Evaluation: {
      async findOne() { return null; },
      async create(values) { return values; },
    },
    Attempt: { async findAll() { return []; } },
    sequelize: null,
  });
  await assert.rejects(
    () => service.evaluatePolicy(policy(), { now: NOW }),
    (error) => error.code === 'CAMPAIGN_OPTIMIZATION_POLICY_CAS_CONFLICT'
  );
}

function testSourceContractsAreReadOnlyAndMonitored() {
  const root = path.resolve(__dirname, '../../..');
  const migration = fs.readFileSync(path.join(root, 'migrations/20260712110000-create-campaign-optimization-lifecycle.js'), 'utf8');
  const evaluationModel = fs.readFileSync(path.join(root, 'models/campaignoptimizationevaluation.js'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'src/routes/marketing.routes.js'), 'utf8');
  const jobs = fs.readFileSync(path.join(root, 'src/jobs/sync.jobs.js'), 'utf8');
  const service = fs.readFileSync(path.join(root, 'src/services/campaignOptimizationEvaluation.service.js'), 'utf8');

  assert.match(migration, /uniq_campaign_optimization_evaluation_day/);
  assert.match(migration, /policy_version/);
  assert.match(evaluationModel, /append-only/);
  assert.match(evaluationModel, /beforeBulkUpdate/);
  assert.match(routes, /router\.get\('\/campaign-optimization\/status'/);
  assert.doesNotMatch(routes, /router\.(post|patch|put|delete)\('\/campaign-optimization/);
  assert.match(jobs, /campaignOptimizationEvaluation[^\n]*process\.env\.JOBS_CAMPAIGN_OPTIMIZATION_EVALUATION_SCHEDULE \|\| '35 2 \* \* \*'/);
  assert.match(jobs, /provider_mutation: null/);
  assert.doesNotMatch(service, /googleAdsRequest|uploadConversion|applyApprovedLifecycleTransition/);
}

async function run() {
  testAggregationIsHonestAboutMissingDimensions();
  testScheduleAndPurchaseDoNotInventEvidence();
  await testDailyEvaluationPersistsWithCasAndIsIdempotent();
  await testCasConflictIsExplicit();
  testSourceContractsAreReadOnlyAndMonitored();
  console.log('campaign_optimization_persistence.test.js: ok');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
