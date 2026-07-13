'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  __test: {
    buildEnhancedConversionActivationPlan,
    collectEnhancedConversionActivationTargets,
    persistEnhancedConversionActivationPlan,
    reconcileEnhancedConversionsInternalActivation,
    validateEnhancedConversionActivationAllowlist
  }
} = require('../../controllers/campaignOnboarding.controller');

const NOW = new Date('2026-07-12T12:00:00.000Z');

function intakeRecord() {
  return {
    id: 24,
    group_id: 5,
    assignment_scope: 'group',
    domains: ['propdental.es'],
    updated_at: '2026-07-12T11:00:00.000Z',
    config: {
      features: {
        consent_mode_enabled: true,
        consent_provider: 'clinicaclick',
        ad_personalization_enabled: false,
        google_ads_user_data_enabled: false,
        google_ads_user_data_disclosure_confirmed: false,
        google_ads_user_data_runtime_enabled: false
      },
      google_ads: {
        enabled: true,
        user_data_enabled: false,
        events: {
          lead: {
            enabled: true,
            destinations: [
              { customer_id: '1851215478', conversion_action_id: '1' },
              { customer_id: '5992356722', conversion_action_id: '2' }
            ]
          },
          contact: {
            enabled: true,
            destinations: [
              { customer_id: '1851215478', conversion_action_id: '11' },
              { customer_id: '5992356722', conversion_action_id: '12' }
            ]
          },
          qualified_lead: {
            enabled: true,
            destinations: [
              { customer_id: '1851215478', conversion_action_id: '3' },
              { customer_id: '5992356722', conversion_action_id: '4' }
            ]
          },
          schedule: {
            enabled: true,
            destinations: [
              { customer_id: '1851215478', conversion_action_id: '21' },
              { customer_id: '5992356722', conversion_action_id: '22' }
            ]
          },
          purchase: {
            enabled: false,
            destinations: [{ customer_id: '1851215478', conversion_action_id: '9' }]
          }
        },
        enhanced_conversions: { enabled: false }
      }
    }
  };
}

function scopedAccounts() {
  return ['1851215478', '5992356722'].map((customerId) => ({
    customer_id: customerId,
    mapped_to_scope: true
  }));
}

function enrichedAccounts(overrides = {}) {
  return scopedAccounts().map((account) => ({
    ...account,
    conversion_tracking_settings_available: true,
    accepted_customer_data_terms: true,
    enhanced_conversions_for_leads_enabled: true,
    ...(overrides[account.customer_id] || {})
  }));
}

function buildPlan(options = {}) {
  const record = options.intakeRecord || intakeRecord();
  return buildEnhancedConversionActivationPlan({
    scope: { assignment_scope: 'group', group_id: 5 },
    intakeRecord: record,
    consentReadiness: {
      ready: true,
      validated: true,
      reasons: [],
      expires_at: '2026-07-12T12:15:00.000Z'
    },
    scopedAccounts: scopedAccounts(),
    enrichedAccounts: options.enrichedAccounts || enrichedAccounts(),
    dataManagerReady: options.dataManagerReady !== false,
    requestBody: {
      advertiser_authorization: {
        confirmed: true,
        reference: 'advertiser-decision-2026-07-12',
        authorized_at: '2026-07-12T11:30:00.000Z'
      }
    },
    actorUserId: 7,
    now: NOW,
    ...options
  });
}

function testTargetCollectionExcludesPurchase() {
  const targets = collectEnhancedConversionActivationTargets(intakeRecord().config.google_ads);
  assert.deepEqual(targets.customer_ids, ['1851215478', '5992356722']);
  assert.deepEqual(targets.event_names, ['lead', 'contact', 'qualified_lead', 'schedule']);
  assert.equal(targets.pairs.length, 8);
  assert.equal(targets.pairs.some((pair) => pair.event_name === 'purchase'), false);
}

function testReadyPlanIsRestrictedAndAuditable() {
  const source = intakeRecord();
  const before = JSON.parse(JSON.stringify(source));
  const plan = buildPlan({ intakeRecord: source });
  assert.equal(plan.ready, true);
  assert.deepEqual(plan.issues, []);
  assert.deepEqual(source, before, 'preview must not mutate the IntakeConfig object');
  assert.equal(plan.nextConfig.features.google_ads_user_data_enabled, true);
  assert.equal(plan.nextConfig.features.google_ads_user_data_disclosure_confirmed, true);
  assert.equal(plan.nextConfig.features.google_ads_user_data_runtime_enabled, true);
  assert.equal(plan.nextConfig.features.ad_personalization_enabled, true);
  assert.equal(plan.nextConfig.features.ad_personalization_consent_source, 'visitor_choice');
  assert.equal(plan.nextConfig.google_ads.user_data_enabled, true);
  assert.equal(plan.nextConfig.google_ads.events.lead.user_data_enabled, true);
  assert.equal(plan.nextConfig.google_ads.events.qualified_lead.user_data_enabled, true);
  assert.equal(plan.nextConfig.google_ads.events.schedule.user_data_enabled, true);
  assert.equal(plan.nextConfig.google_ads.events.purchase.user_data_enabled, undefined);
  assert.equal(plan.nextConfig.google_ads.events.lead.value, 0);
  assert.equal(plan.nextConfig.google_ads.events.contact.value, 0);
  assert.equal(plan.nextConfig.google_ads.events.qualified_lead.value, 10);
  assert.equal(plan.nextConfig.google_ads.events.schedule.value, 40);
  assert.equal(plan.nextConfig.google_ads.events.schedule.currency, 'EUR');
  assert.equal(plan.nextConfig.google_ads.events.schedule.value_is_revenue, false);
  assert.equal(plan.nextConfig.google_ads.enhanced_conversions.enabled, true);
  assert.equal(
    plan.nextConfig.google_ads.enhanced_conversions.policy_mode,
    'documented_google_account_team_guidance_and_advertiser_authorization'
  );
  assert.equal(plan.nextConfig.google_ads.enhanced_conversions.allowlist.length, 8);
  for (const entry of plan.nextConfig.google_ads.enhanced_conversions.allowlist) {
    assert.deepEqual(entry.authorization.permitted_identifiers, ['email', 'phone']);
    assert.equal(entry.authorization.google_evidence_ref, '4-1893000040437');
    assert.equal(entry.authorization.measurement_only, true);
    assert.equal(entry.authorization.customer_match_enabled, false);
    assert.equal(entry.authorization.conversion_based_customer_lists_enabled, false);
    assert.equal(entry.authorization.remarketing_enabled, false);
    assert.equal(entry.authorization.ad_personalization_source, 'visitor_consent');
    assert.equal('ad_personalization' in entry.authorization, false);
    assert.equal('name' in entry.authorization, false);
    assert.equal('address' in entry.authorization, false);
  }
  assert.deepEqual(
    validateEnhancedConversionActivationAllowlist(
      plan.nextConfig.google_ads.enhanced_conversions,
      NOW
    ),
    []
  );
  const audit = plan.nextConfig.google_ads.enhanced_conversions.activation_audit;
  assert.equal(audit.gate_version, 2);
  assert.equal(typeof audit.reconciliation_key, 'string');
  assert.equal(audit.reconciliation_key.length, 64);
  assert.equal(audit.actor_user_id, 7);
  assert.equal(audit.google_evidence_ref, '4-1893000040437');
  assert.equal(audit.customer_match_enabled, false);
  assert.equal(audit.remarketing_enabled, false);
  assert.equal(audit.ad_personalization_source, 'visitor_consent');
  assert.equal(audit.account_gate.all_enabled, true);
  assert.deepEqual(plan.nextConfig.google_ads.enhanced_conversions.value_policy, {
    version: 1,
    currency: 'EUR',
    purpose: 'campaign_optimization_reporting',
    revenue: false,
    events: {
      lead: 0,
      contact: 0,
      qualified_lead: 10,
      schedule: 40,
      purchase: 'actual_value_only'
    }
  });
  assert.equal(JSON.stringify(audit).includes('@'), false, 'audit must not contain email PII');
}

function testAccountSwitchFalseBlocksWholePlan() {
  const plan = buildPlan({
    enrichedAccounts: enrichedAccounts({
      '5992356722': { enhanced_conversions_for_leads_enabled: false }
    })
  });
  assert.equal(plan.ready, false);
  assert.ok(plan.issues.some((issue) => (
    issue.reason === 'enhanced_conversions_for_leads_not_enabled'
      && issue.customer_id === '5992356722'
  )));
}

function testAuthorizationMustBeExplicitAndValid() {
  const plan = buildPlan({
    requestBody: {
      advertiser_authorization: {
        confirmed: false,
        reference: 'https://not-an-opaque-reference.example',
        authorized_at: 'not-a-date'
      }
    }
  });
  assert.equal(plan.ready, false);
  assert.ok(plan.issues.some((issue) => issue.reason === 'advertiser_authorization_confirmation_required'));
  assert.ok(plan.issues.some((issue) => (
    issue.reason === 'enhanced_conversion_authorization_invalid'
      && issue.details === 'authorization_scope_invalid'
  )));
}

function testRouteIsAuthenticatedAndPostOnly() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../routes/marketing.routes.js'), 'utf8');
  assert.match(source, /router\.use\(authMiddleware\)/);
  assert.match(
    source,
    /router\.post\('\/google-ads\/conversions\/enhanced\/activation-gate', campaignOnboardingController\.gateEnhancedConversionsActivation\)/
  );
}

async function testPersistenceIsTransactionalAndIdempotent() {
  const source = intakeRecord();
  const plan = buildPlan({ intakeRecord: source });
  let updates = 0;
  let transactionCalls = 0;
  const locked = {
    ...source,
    config: JSON.parse(JSON.stringify(source.config)),
    async update(patch, options) {
      assert.equal(options.transaction.LOCK.UPDATE, 'UPDATE');
      this.config = patch.config;
      updates += 1;
      return this;
    }
  };
  const dependencies = {
    sequelize: {
      async transaction(callback) {
        transactionCalls += 1;
        return callback({ LOCK: { UPDATE: 'UPDATE' } });
      }
    },
    IntakeConfig: {
      async findOne(options) {
        assert.deepEqual(options.where, { group_id: 5, assignment_scope: 'group' });
        assert.equal(options.lock, 'UPDATE');
        return locked;
      }
    }
  };

  const first = await persistEnhancedConversionActivationPlan({
    intakeRecord: source,
    plan,
    now: NOW,
    dependencies
  });
  assert.equal(first.status, 'activated');
  assert.equal(first.updated, true);
  assert.equal(updates, 1);
  assert.equal(transactionCalls, 1);

  const second = await persistEnhancedConversionActivationPlan({
    intakeRecord: { ...source, config: locked.config },
    plan,
    now: NOW,
    dependencies
  });
  assert.equal(second.status, 'already_active');
  assert.equal(second.idempotent, true);
  assert.equal(updates, 1);
  assert.equal(transactionCalls, 1, 'the preflight idempotency check avoids a second transaction');
}

function testAutomaticJobAndReadOnlyBootstrapContracts() {
  const controller = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/campaignOnboarding.controller.js'),
    'utf8'
  );
  const jobs = fs.readFileSync(path.resolve(__dirname, '../../jobs/sync.jobs.js'), 'utf8');
  const intake = fs.readFileSync(path.resolve(__dirname, '../../controllers/intake.controller.js'), 'utf8');
  assert.match(controller, /bootstrap_mutates_state: false/);
  assert.match(controller, /trigger: 'google_data_manager_diagnostics_job'/);
  assert.match(jobs, /reconcileEnhancedConversionsInternalActivation/);
  assert.match(jobs, /internal_enhanced_conversion_activation: internalActivation/);
  assert.match(intake, /ad_personalization_enabled: true/);
  assert.match(intake, /ad_personalization_consent_source: 'visitor_choice'/);
}

async function testAutomaticReconciliationActivatesOnceAfterReadiness() {
  const previousQuotaProject = process.env.GOOGLE_DATA_MANAGER_QUOTA_PROJECT;
  process.env.GOOGLE_DATA_MANAGER_QUOTA_PROJECT = 'clinicaclick';
  let updates = 0;
  let transactions = 0;
  let googleWrites = 0;
  const record = {
    ...intakeRecord(),
    async update(patch) {
      this.config = patch.config;
      updates += 1;
      return this;
    }
  };
  const dependencies = {
    resolveScopeFromInput: async () => ({ assignment_scope: 'group', group_id: 5 }),
    resolveEffectiveMarketingState: async () => ({
      records: { groupRecord: record },
      google: { available_accounts: scopedAccounts() }
    }),
    assessConsentMeasurementReadiness: () => ({
      ready: true,
      validated: true,
      reasons: [],
      expires_at: '2026-07-14T12:00:00.000Z'
    }),
    resolveGoogleConnectionForScope: async () => ({
      connection: {
        id: 23,
        scopes: [
          'https://www.googleapis.com/auth/adwords',
          'https://www.googleapis.com/auth/datamanager'
        ].join(' ')
      }
    }),
    ensureGoogleAdsAccess: async () => ({ accessToken: 'read-only-token' }),
    enrichGoogleAdsAccountsWithConversionTracking: async () => enrichedAccounts(),
    sequelize: {
      async transaction(callback) {
        transactions += 1;
        return callback({ LOCK: { UPDATE: 'UPDATE' } });
      }
    },
    IntakeConfig: {
      async findOne() {
        return record;
      }
    },
    mutateGoogleAds: async () => {
      googleWrites += 1;
    }
  };

  try {
    const first = await reconcileEnhancedConversionsInternalActivation({
      now: new Date('2026-07-13T12:00:00.000Z'),
      dependencies
    });
    assert.equal(first.status, 'activated');
    assert.equal(first.google_ads_mutated, false);
    assert.equal(first.external_mutation_performed, false);
    assert.equal(record.config.google_ads.enhanced_conversions.activation_audit.activation_source,
      'google_data_manager_diagnostics_job');

    const second = await reconcileEnhancedConversionsInternalActivation({
      now: new Date('2026-07-13T12:30:00.000Z'),
      dependencies
    });
    assert.equal(second.status, 'already_active');
    assert.equal(second.idempotent, true);
    assert.equal(updates, 1);
    assert.equal(transactions, 1);
    assert.equal(googleWrites, 0);
  } finally {
    if (previousQuotaProject === undefined) delete process.env.GOOGLE_DATA_MANAGER_QUOTA_PROJECT;
    else process.env.GOOGLE_DATA_MANAGER_QUOTA_PROJECT = previousQuotaProject;
  }
}

async function testPersonalizationCapabilityDoesNotWaitForEnhancedGate() {
  const previousQuotaProject = process.env.GOOGLE_DATA_MANAGER_QUOTA_PROJECT;
  process.env.GOOGLE_DATA_MANAGER_QUOTA_PROJECT = 'clinicaclick';
  let updates = 0;
  let transactions = 0;
  const record = {
    ...intakeRecord(),
    async update(patch) {
      this.config = patch.config;
      updates += 1;
      return this;
    }
  };
  const dependencies = {
    resolveScopeFromInput: async () => ({ assignment_scope: 'group', group_id: 5 }),
    resolveEffectiveMarketingState: async () => ({
      records: { groupRecord: record },
      google: { available_accounts: scopedAccounts() }
    }),
    assessConsentMeasurementReadiness: () => ({
      ready: true,
      validated: true,
      reasons: [],
      expires_at: '2026-07-14T12:00:00.000Z'
    }),
    resolveGoogleConnectionForScope: async () => ({
      connection: {
        id: 23,
        scopes: 'https://www.googleapis.com/auth/adwords https://www.googleapis.com/auth/datamanager'
      }
    }),
    ensureGoogleAdsAccess: async () => ({ accessToken: 'read-only-token' }),
    enrichGoogleAdsAccountsWithConversionTracking: async () => enrichedAccounts({
      '5992356722': { enhanced_conversions_for_leads_enabled: false }
    }),
    sequelize: {
      async transaction(callback) {
        transactions += 1;
        return callback({ LOCK: { UPDATE: 'UPDATE' } });
      }
    },
    IntakeConfig: { async findOne() { return record; } }
  };

  try {
    const first = await reconcileEnhancedConversionsInternalActivation({
      now: new Date('2026-07-13T13:00:00.000Z'),
      dependencies
    });
    assert.equal(first.status, 'blocked', 'only the enhanced conversion phase remains blocked');
    assert.equal(first.updated, true);
    assert.equal(first.ad_personalization_capability.status, 'activated');
    assert.equal(first.ad_personalization_capability.enabled, true);
    assert.equal(record.config.features.ad_personalization_enabled, true);
    assert.equal(record.config.features.ad_personalization_consent_source, 'visitor_choice');
    assert.equal(record.config.features.ad_personalization_activation_audit.grants_consent, false);
    assert.equal(record.config.google_ads.user_data_enabled, false);
    assert.equal(record.config.google_ads.enhanced_conversions.enabled, false);
    assert.equal(first.google_ads_mutated, false);

    const second = await reconcileEnhancedConversionsInternalActivation({
      now: new Date('2026-07-13T13:30:00.000Z'),
      dependencies
    });
    assert.equal(second.status, 'blocked');
    assert.equal(second.updated, false);
    assert.equal(second.ad_personalization_capability.status, 'already_active');
    assert.equal(second.ad_personalization_capability.idempotent, true);
    assert.equal(updates, 1);
    assert.equal(transactions, 1);
  } finally {
    if (previousQuotaProject === undefined) delete process.env.GOOGLE_DATA_MANAGER_QUOTA_PROJECT;
    else process.env.GOOGLE_DATA_MANAGER_QUOTA_PROJECT = previousQuotaProject;
  }
}

async function run() {
  testTargetCollectionExcludesPurchase();
  testReadyPlanIsRestrictedAndAuditable();
  testAccountSwitchFalseBlocksWholePlan();
  testAuthorizationMustBeExplicitAndValid();
  testRouteIsAuthenticatedAndPostOnly();
  await testPersistenceIsTransactionalAndIdempotent();
  testAutomaticJobAndReadOnlyBootstrapContracts();
  await testAutomaticReconciliationActivatesOnceAfterReadiness();
  await testPersonalizationCapabilityDoesNotWaitForEnhancedGate();
  console.log('enhanced_conversion_activation_gate.test.js: OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
