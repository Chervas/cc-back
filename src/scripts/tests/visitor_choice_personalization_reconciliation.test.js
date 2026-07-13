'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  __test: {
    buildVisitorChoicePersonalizationConfig,
    isVisitorChoicePersonalizationCapabilityApplied,
    reconcileVisitorChoicePersonalizationCapabilities,
  },
} = require('../../controllers/campaignOnboarding.controller');

const NOW = new Date('2026-07-13T14:00:00.000Z');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function legacyPropdentalConfig() {
  const reconciliationKey = crypto.createHash('sha256').update(JSON.stringify({
    version: 1,
    group_id: 5,
    enabled: true,
    consent_source: 'visitor_choice',
  })).digest('hex');
  return {
    features: {
      ad_personalization_enabled: true,
      ad_personalization_consent_source: 'visitor_choice',
      ad_personalization_activation_audit: {
        version: 1,
        reconciliation_key: reconciliationKey,
        activation_source: 'google_data_manager_diagnostics_job',
        applied_at: '2026-07-13T06:42:00.000Z',
        group_id: 5,
        grants_consent: false,
        independent_of_enhanced_conversion_gate: true,
      },
    },
    google_ads: {
      user_data_enabled: true,
      enhanced_conversions: { enabled: true, activation_audit: { keep: true } },
      goal_policy: { version: 4, keep: true },
    },
  };
}

function testBuilderCanonicalizesWithoutGrantingConsent() {
  const intakeRecord = {
    id: 101,
    clinic_id: 56,
    group_id: null,
    assignment_scope: 'clinic',
  };
  const currentConfig = {
    campaigns: { active_mode: 'connect_only' },
    future_server_block: { keep: true },
    features: {
      ad_personalization_enabled: false,
      ad_personalization: 'denied',
      ad_user_data: 'denied',
      future_feature: { keep: true },
    },
    google_ads: {
      user_data_enabled: false,
      enhanced_conversions: { enabled: false },
      goal_policy: { version: 4, keep: true },
    },
  };
  const before = clone(currentConfig);
  const built = buildVisitorChoicePersonalizationConfig(currentConfig, {
    intakeRecord,
    now: NOW,
    activationSource: 'test',
  });

  assert.deepEqual(currentConfig, before, 'the builder must not mutate its input');
  assert.equal(built.nextConfig.features.ad_personalization_enabled, true);
  assert.equal(built.nextConfig.features.ad_personalization_consent_source, 'visitor_choice');
  assert.equal(built.nextConfig.features.ad_personalization, 'denied');
  assert.equal(built.nextConfig.features.ad_user_data, 'denied');
  assert.deepEqual(built.nextConfig.features.future_feature, { keep: true });
  assert.deepEqual(built.nextConfig.campaigns, currentConfig.campaigns);
  assert.deepEqual(built.nextConfig.future_server_block, currentConfig.future_server_block);
  assert.deepEqual(built.nextConfig.google_ads, currentConfig.google_ads);
  assert.equal(built.nextConfig.features.ad_personalization_activation_audit.version, 2);
  assert.equal(built.nextConfig.features.ad_personalization_activation_audit.intake_config_id, 101);
  assert.equal(built.nextConfig.features.ad_personalization_activation_audit.assignment_scope, 'clinic');
  assert.equal(built.nextConfig.features.ad_personalization_activation_audit.clinic_id, 56);
  assert.equal(built.nextConfig.features.ad_personalization_activation_audit.group_id, null);
  assert.equal(built.nextConfig.features.ad_personalization_activation_audit.grants_consent, false);
  assert.equal(
    built.nextConfig.features.ad_personalization_activation_audit.independent_of_enhanced_conversion_gate,
    true,
  );
  assert.equal(isVisitorChoicePersonalizationCapabilityApplied(built.nextConfig, intakeRecord), true);
}

function buildHarness(seedRows, { failUpdateIds = [] } = {}) {
  const records = new Map();
  const updates = [];
  const transactions = [];
  const pages = [];
  for (const seed of seedRows) {
    const record = {
      ...seed,
      config: seed.config === null ? null : clone(seed.config || {}),
      async update(patch, options) {
        assert.equal(options?.transaction, this.__expectedTransaction);
        if (failUpdateIds.includes(this.id)) {
          const error = new Error('forced update failure');
          error.code = 'FORCED_UPDATE_FAILURE';
          throw error;
        }
        this.config = patch.config;
        updates.push(this.id);
        return this;
      },
    };
    records.set(record.id, record);
  }

  const IntakeConfig = {
    async findAll(options) {
      const symbols = Object.getOwnPropertySymbols(options.where?.id || {});
      const afterId = symbols.length ? Number(options.where.id[symbols[0]]) : 0;
      const page = [...records.values()]
        .filter((record) => record.id > afterId)
        .sort((left, right) => left.id - right.id)
        .slice(0, options.limit)
        .map(({ id, clinic_id, group_id, assignment_scope }) => ({
          id,
          clinic_id,
          group_id,
          assignment_scope,
        }));
      pages.push(page.map((row) => row.id));
      return page;
    },
    async findOne(options) {
      assert.ok(options.transaction, 'the latest row must be read inside a transaction');
      assert.equal(options.lock, options.transaction.LOCK.UPDATE);
      const record = records.get(Number(options.where?.id)) || null;
      if (record) record.__expectedTransaction = options.transaction;
      return record;
    },
  };
  const sequelize = {
    async transaction(callback) {
      const transaction = {
        id: transactions.length + 1,
        LOCK: { UPDATE: 'UPDATE' },
      };
      transactions.push(transaction);
      return callback(transaction);
    },
  };
  return {
    dependencies: { IntakeConfig, sequelize },
    records,
    updates,
    transactions,
    pages,
  };
}

async function testGlobalReconciliationIsLockedPagedAndIdempotent() {
  const legacyPropdental = legacyPropdentalConfig();
  const alreadyCurrentIdentity = {
    id: 4,
    clinic_id: 35,
    group_id: null,
    assignment_scope: 'clinic',
  };
  const alreadyCurrent = buildVisitorChoicePersonalizationConfig({
    features: { ad_user_data: 'denied', ad_personalization: 'denied' },
  }, {
    intakeRecord: alreadyCurrentIdentity,
    now: new Date('2026-07-13T13:00:00.000Z'),
  }).nextConfig;
  const harness = buildHarness([
    {
      id: 1,
      clinic_id: 56,
      group_id: null,
      assignment_scope: 'clinic',
      config: {
        features: {
          ad_personalization_enabled: false,
          ad_user_data: 'denied',
          ad_personalization: 'denied',
        },
        concurrent_server_block: { keep: 'latest-locked-value' },
        google_ads: { user_data_enabled: false, enhanced_conversions: { enabled: false } },
      },
    },
    { id: 2, clinic_id: null, group_id: 10, assignment_scope: 'group', config: null },
    { id: 3, clinic_id: null, group_id: 5, assignment_scope: 'group', config: legacyPropdental },
    { ...alreadyCurrentIdentity, config: alreadyCurrent },
    {
      id: 5,
      clinic_id: 19,
      group_id: null,
      assignment_scope: 'clinic',
      config: { features: { ad_personalization_enabled: true } },
    },
  ]);
  const legacyBefore = clone(legacyPropdental);

  const first = await reconcileVisitorChoicePersonalizationCapabilities({
    now: NOW,
    batchSize: 2,
    dependencies: harness.dependencies,
  });
  assert.equal(first.status, 'completed');
  assert.equal(first.scanned, 5);
  assert.equal(first.activated, 3);
  assert.equal(first.already_active, 2);
  assert.equal(first.errors.length, 0);
  assert.equal(first.idempotent, false);
  assert.equal(first.grants_consent, false);
  assert.equal(first.external_mutation_performed, false);
  assert.equal(first.google_ads_mutated, false);
  assert.deepEqual(harness.pages, [[1, 2], [3, 4], [5], []]);
  assert.equal(harness.transactions.length, 5);
  assert.deepEqual(harness.updates, [1, 2, 5]);
  assert.deepEqual(harness.records.get(1).config.concurrent_server_block, {
    keep: 'latest-locked-value',
  });
  assert.equal(harness.records.get(1).config.features.ad_user_data, 'denied');
  assert.equal(harness.records.get(1).config.features.ad_personalization, 'denied');
  assert.equal(harness.records.get(1).config.google_ads.user_data_enabled, false);
  assert.equal(harness.records.get(1).config.google_ads.enhanced_conversions.enabled, false);
  assert.equal(
    harness.records.get(2).config.features.ad_personalization_activation_audit.group_id,
    10,
  );
  assert.deepEqual(harness.records.get(3).config, legacyBefore, 'Propdental legacy audit remains compatible');
  const firstAppliedAt = harness.records.get(1).config.features.ad_personalization_activation_audit.applied_at;

  harness.pages.length = 0;
  const second = await reconcileVisitorChoicePersonalizationCapabilities({
    now: new Date('2026-07-13T14:30:00.000Z'),
    batchSize: 2,
    dependencies: harness.dependencies,
  });
  assert.equal(second.status, 'completed');
  assert.equal(second.activated, 0);
  assert.equal(second.already_active, 5);
  assert.equal(second.idempotent, true);
  assert.equal(harness.transactions.length, 10, 'the periodic pass rereads every row under lock');
  assert.deepEqual(harness.updates, [1, 2, 5]);
  assert.equal(
    harness.records.get(1).config.features.ad_personalization_activation_audit.applied_at,
    firstAppliedAt,
  );
}

async function testOneRowFailureDoesNotAbortTheBatch() {
  const harness = buildHarness([
    { id: 11, clinic_id: 11, group_id: null, assignment_scope: 'clinic', config: {} },
    { id: 12, clinic_id: 12, group_id: null, assignment_scope: 'clinic', config: {} },
    { id: 13, clinic_id: 13, group_id: null, assignment_scope: 'clinic', config: {} },
  ], { failUpdateIds: [12] });
  const report = await reconcileVisitorChoicePersonalizationCapabilities({
    now: NOW,
    batchSize: 2,
    dependencies: harness.dependencies,
  });
  assert.equal(report.status, 'completed_with_errors');
  assert.equal(report.scanned, 3);
  assert.equal(report.activated, 2);
  assert.deepEqual(harness.updates, [11, 13]);
  assert.deepEqual(report.errors, [{
    intake_config_id: 12,
    reason: 'FORCED_UPDATE_FAILURE',
  }]);
}

function testPeriodicJobRunsGlobalCapabilityBeforePropdentalGate() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../jobs/sync.jobs.js'), 'utf8');
  const start = source.indexOf('async executeGoogleDataManagerDiagnostics(options = {})');
  const end = source.indexOf('\n  async executeGoogleConversionGoalPolicyAudit()', start);
  const job = source.slice(start, end);
  assert.ok(start >= 0 && end > start);
  assert.match(job, /reconcileVisitorChoicePersonalizationCapabilities/);
  assert.match(job, /visitor_choice_personalization_reconciliation: visitorChoicePersonalization/);
  assert.ok(
    job.indexOf('reconcileVisitorChoicePersonalizationCapabilities({')
      < job.indexOf('reconcileEnhancedConversionsInternalActivation({'),
    'the global visitor-choice capability must run before the Propdental Enhanced gate',
  );
}

async function run() {
  testBuilderCanonicalizesWithoutGrantingConsent();
  await testGlobalReconciliationIsLockedPagedAndIdempotent();
  await testOneRowFailureDoesNotAbortTheBatch();
  testPeriodicJobRunsGlobalCapabilityBeforePropdentalGate();
  console.log('visitor_choice_personalization_reconciliation.test.js: OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
