'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  __test: {
    buildEnhancedConversionActivationPlan,
    auditConnectOnlyMeasurementTarget,
    collectEnhancedConversionActivationTargets,
    persistEnhancedConversionActivationPlan,
    reconcileEnhancedConversionsInternalActivation,
    reconcileVerifiedConnectOnlyStrategyActivationReadiness,
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
      locations: [19, 35, 56, 58, 59].map((id) => ({ id })),
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
    google_connection_healthy: true,
    google_ads_scope_granted: true,
    data_manager_scope_granted: true,
    conversion_tracking_settings_available: true,
    accepted_customer_data_terms: true,
    enhanced_conversions_for_leads_enabled: true,
    ...(overrides[account.customer_id] || {})
  }));
}

function strategyRequestRow({
  id,
  clinicId = 56,
  rowClinicId = clinicId,
  payloadClinicId = clinicId,
  scopedClinicIds = [payloadClinicId],
  estado = 'activa',
  status = 'active',
  mode = 'connect_only',
  objectiveId = 'new_patients',
  groupId = 5,
  channel = 'google_ads',
  customerIds = ['1851215478', '5992356722'],
  destination = { type: 'website', url: 'https://www.propdental.es/' },
  activationReadiness = null
}) {
  const row = {
    id,
    clinica_id: rowClinicId,
    estado,
    solicitud: {
      kind: 'marketing_strategy',
      objective_id: objectiveId,
      status,
      mode_snapshot: mode,
      scope: {
        assignment_scope: 'clinic',
        clinic_id: payloadClinicId,
        group_id: groupId,
        clinic_ids: scopedClinicIds
      },
      channels: [{ channel, enabled: true }],
      destination,
      external_targets: [{
        campaigns: customerIds.map((customerId, index) => ({
          provider: 'google_ads',
          customer_id: customerId,
          campaign_id: `campaign-${index + 1}`
        }))
      }],
      activation_readiness: activationReadiness || {
        ready: false,
        validated: false,
        reason: 'conversion_readiness_not_verified'
      }
    },
    updates: 0,
    async update(patch, options) {
      assert.ok(options.transaction, 'strategy readiness writes must stay inside the lock transaction');
      this.solicitud = patch.solicitud;
      this.updates += 1;
      return this;
    }
  };
  return row;
}

function activeEnhancedActivation(overrides = {}) {
  return {
    status: 'already_active',
    ready: true,
    customer_ids: ['1851215478', '5992356722'],
    reconciliation_key: 'enhanced-gate-reconciliation-key',
    ...overrides
  };
}

function readyStrategyConversionReadiness(overrides = {}) {
  const targetDefinitions = [
    ['lead', '1', '2'],
    ['contact', '11', '12'],
    ['qualified_lead', '3', '4'],
    ['schedule', '21', '22']
  ];
  const customerIds = ['1851215478', '5992356722'];
  const targets = targetDefinitions.flatMap(([event, firstActionId, secondActionId]) => (
    customerIds.map((customerId, index) => {
      const conversionActionId = index === 0 ? firstActionId : secondActionId;
      return {
        customer_id: customerId,
        event,
        conversion_action_id: conversionActionId,
        validation_key: `${customerId}:${event}:${conversionActionId}`
      };
    })
  ));
  const validationsByTarget = Object.fromEntries(targets.map((target) => [
    target.validation_key,
    {
      status: 'validated',
      validated: true,
      validate_only: true,
      checked_at: '2026-07-13T13:59:00.000Z'
    }
  ]));
  return {
    ready: true,
    validated: true,
    enabled_events: ['lead', 'contact', 'qualified_lead', 'schedule'],
    customer_ids: ['1851215478', '5992356722'],
    reasons: [],
    issues: [],
    consent_readiness: {
      ready: true,
      validated: true,
      expires_at: '2026-07-14T12:00:00.000Z'
    },
    targets,
    validations_by_target: validationsByTarget,
    ...overrides
  };
}

function strategyReadinessDependencies({
  rows,
  lockedRows = rows,
  readiness = readyStrategyConversionReadiness(),
  counters,
  groupRecord = intakeRecord(),
  clinicRecords = {},
  lockedIntakeRecords = null,
  consentReadiness = {
    ready: true,
    validated: true,
    reasons: [],
    issues: [],
    expires_at: '2026-07-14T12:00:00.000Z'
  }
}) {
  counters.reads ||= 0;
  counters.lockedReads ||= 0;
  counters.sourceLockedReads ||= 0;
  counters.evaluations ||= 0;
  counters.transactions ||= 0;
  counters.evaluationScopes ||= [];
  const sourceRecords = lockedIntakeRecords || [
    groupRecord,
    ...Object.values(clinicRecords).filter(Boolean)
  ];
  return {
    resolveScopeFromInput: async (input) => {
      if (input.assignmentScopeRaw === 'group') {
        assert.equal(input.groupIdRaw, 5);
        return { assignment_scope: 'group', group_id: 5 };
      }
      assert.equal(input.assignmentScopeRaw, 'clinic');
      assert.equal(input.groupIdRaw, null);
      return {
        assignment_scope: 'clinic',
        clinic_id: Number(input.clinicIdRaw),
        group_id: 5
      };
    },
    resolveEffectiveMarketingState: async (input) => {
      if (input.assignmentScopeRaw === 'group') {
        return {
          scope: { assignment_scope: 'group', group_id: 5 },
          records: { groupRecord },
          tracking: { google_ads: groupRecord.config.google_ads },
          google: {
            effective_assets: { account: { customer_id: '1851215478' } }
          }
        };
      }
      const clinicId = Number(input.clinicIdRaw);
      const clinicRecord = clinicRecords[clinicId] || null;
      return {
        scope: { assignment_scope: 'clinic', clinic_id: clinicId, group_id: 5 },
        records: { clinicRecord, groupRecord },
        tracking: { google_ads: clinicRecord?.config?.google_ads || groupRecord.config.google_ads },
        google: {
          effective_assets: { account: { customer_id: '1851215478' } }
        }
      };
    },
    assessConsentMeasurementReadiness: () => consentReadiness,
    evaluateGoogleConversionOnboardingReadiness: async (options) => {
      counters.evaluations += 1;
      counters.evaluationScopes.push({ ...options.scope });
      assert.equal(options.createMissing, false, 'the reconciler must never create Google actions');
      assert.equal(options.fallbackCustomerId, '1851215478');
      assert.equal(options.consentReadiness.validated, true);
      return readiness;
    },
    CampaignRequest: {
      async findAll(options) {
        counters.reads += 1;
        if (options.transaction) {
          counters.lockedReads += 1;
          assert.equal(options.lock, 'UPDATE');
          const ids = options.where.id[require('sequelize').Op.in];
          return lockedRows.filter((row) => ids.includes(row.id));
        }
        assert.deepEqual(options.where, { estado: 'activa' });
        return rows;
      }
    },
    IntakeConfig: {
      async findAll(options) {
        counters.sourceLockedReads += 1;
        assert.equal(options.lock, 'UPDATE');
        const ids = options.where.id[require('sequelize').Op.in];
        return sourceRecords.filter((record) => ids.includes(record.id));
      }
    },
    sequelize: {
      async transaction(callback) {
        counters.transactions += 1;
        return callback({ LOCK: { UPDATE: 'UPDATE' } });
      }
    }
  };
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
  assert.equal(plan.nextConfig.google_ads.phone_country_code, '34');
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
  assert.equal(audit.gate_version, 3);
  assert.equal(typeof audit.reconciliation_key, 'string');
  assert.equal(audit.reconciliation_key.length, 64);
  assert.equal(audit.actor_user_id, 7);
  assert.equal(audit.google_evidence_ref, '4-1893000040437');
  assert.equal(audit.phone_country_code, '34');
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
  const readinessReconcilerStart = controller.indexOf(
    'async function reconcileVerifiedConnectOnlyStrategyActivationReadiness(options = {})'
  );
  const readinessReconcilerEnd = controller.indexOf('\nfunction initSteps(', readinessReconcilerStart);
  assert.ok(readinessReconcilerStart >= 0 && readinessReconcilerEnd > readinessReconcilerStart);
  const readinessReconciler = controller.slice(readinessReconcilerStart, readinessReconcilerEnd);
  assert.match(readinessReconciler, /evaluateGoogleConversionOnboardingReadiness/);
  assert.match(readinessReconciler, /createMissing: false/);
  assert.match(readinessReconciler, /lock: transaction\.LOCK\.UPDATE/);
  assert.doesNotMatch(readinessReconciler, /Campaign\.update|createMissing: true/);
  assert.match(jobs, /reconcileEnhancedConversionsInternalActivation/);
  assert.match(jobs, /reconcileVerifiedConnectOnlyStrategyActivationReadiness/);
  assert.match(jobs, /internal_enhanced_conversion_activation: internalActivation/);
  assert.match(jobs, /connect_only_strategy_readiness_reconciliation: strategyReadinessReconciliation/);
  assert.match(jobs, /let strategyReadinessError = null/);
  assert.match(jobs, /if \(strategyReadinessError\) \{/);
  assert.match(jobs, /throw strategyReadinessError/);
  assert.ok(
    jobs.indexOf('reconcileVerifiedConnectOnlyStrategyActivationReadiness({')
      > jobs.indexOf('reconcileEnhancedConversionsInternalActivation({'),
    'strategy readiness reconciliation must run after the Enhanced gate'
  );
  assert.match(intake, /ad_personalization_enabled: true/);
  assert.match(intake, /ad_personalization_consent_source: 'visitor_choice'/);
}

async function testStrategyReadinessReconciliationUsesOnlyExplicitGroupLocations() {
  const rows = [
    strategyRequestRow({ id: 11, clinicId: 19 }),
    strategyRequestRow({ id: 13, clinicId: 35 }),
    strategyRequestRow({ id: 18, clinicId: 56 }),
    strategyRequestRow({ id: 22, clinicId: 58 }),
    strategyRequestRow({ id: 24, clinicId: 59 }),
    strategyRequestRow({ id: 9, clinicId: 36 }),
    strategyRequestRow({ id: 20, clinicId: 57 })
  ];
  const counters = {};
  const dependencies = strategyReadinessDependencies({ rows, counters });
  const result = await reconcileVerifiedConnectOnlyStrategyActivationReadiness({
    enhancedActivation: activeEnhancedActivation(),
    now: new Date('2026-07-13T14:00:00.000Z'),
    dependencies
  });

  assert.equal(result.status, 'partially_reconciled');
  assert.equal(result.reconciled, 5);
  assert.deepEqual(result.reconciled_ids, [11, 13, 18, 22, 24]);
  assert.deepEqual(result.blocked, [
    { id: 9, clinic_id: 36, reason: 'clinic_scope_intake_config_missing' },
    { id: 20, clinic_id: 57, reason: 'clinic_scope_intake_config_missing' }
  ]);
  assert.equal(counters.evaluations, 1, 'the five explicit web locations share one group validation');
  assert.deepEqual(counters.evaluationScopes, [{ assignment_scope: 'group', group_id: 5 }]);
  assert.equal(counters.transactions, 1);
  assert.equal(counters.lockedReads, 1);
  assert.equal(counters.sourceLockedReads, 1);

  for (const row of rows.slice(0, 5)) {
    assert.equal(row.updates, 1);
    const evidence = row.solicitud.activation_readiness;
    assert.equal(evidence.validated_scope.assignment_scope, 'group');
    assert.equal(evidence.validated_scope.group_id, 5);
    assert.equal(evidence.validated_scope.clinic_id, row.clinica_id);
    assert.equal(evidence.validated_scope.source, 'group_web_location');
    assert.equal(evidence.validated_targets.length, 8);
    assert.equal(evidence.validated_targets.every((target) => target.validate_only), true);
    assert.equal(JSON.stringify(evidence).includes('@'), false, 'persisted readiness evidence must be PII-free');
  }
  assert.equal(rows[5].updates, 0);
  assert.equal(rows[6].updates, 0);
}

async function testStrategyReadinessReconciliationIsScopedLockedAndIdempotent() {
  const eligible = strategyRequestRow({ id: 1 });
  const counters = {};
  const dependencies = strategyReadinessDependencies({ rows: [eligible], counters });
  const first = await reconcileVerifiedConnectOnlyStrategyActivationReadiness({
    enhancedActivation: activeEnhancedActivation(),
    now: new Date('2026-07-13T14:00:00.000Z'),
    dependencies
  });
  assert.equal(first.status, 'reconciled');
  assert.equal(first.reconciled, 1);
  assert.deepEqual(first.reconciled_ids, [1]);
  assert.equal(first.validate_only, true);
  assert.equal(first.google_ads_mutated, false);
  assert.equal(first.external_mutation_performed, false);
  assert.equal(eligible.updates, 1);
  assert.equal(eligible.solicitud.activation_readiness.validated, true);
  assert.equal(eligible.solicitud.activation_readiness.validate_only, true);
  assert.equal(eligible.solicitud.activation_readiness.reconciled_by,
    'google_data_manager_diagnostics_job');
  assert.equal(eligible.solicitud.activation_readiness.reconciliation_key,
    'enhanced-gate-reconciliation-key');
  assert.equal(eligible.solicitud.activation_readiness_reconciliation
    .previous_activation_readiness.reason, 'conversion_readiness_not_verified');
  assert.equal(counters.evaluations, 1);
  assert.equal(counters.transactions, 1);

  const second = await reconcileVerifiedConnectOnlyStrategyActivationReadiness({
    enhancedActivation: activeEnhancedActivation(),
    now: new Date('2026-07-13T14:30:00.000Z'),
    dependencies
  });
  assert.equal(second.status, 'already_reconciled');
  assert.equal(second.reason, 'no_pending_strategy_readiness');
  assert.equal(second.idempotent, true);
  assert.deepEqual(second.current_ids, [1]);
  assert.equal(counters.evaluations, 1, 'current snapshots must not call Google again');
  assert.equal(counters.transactions, 1, 'current snapshots must not open another transaction');
  assert.equal(eligible.updates, 1);
}

async function testStrategyReadinessReconciliationRequiresRealValidation() {
  const eligible = strategyRequestRow({ id: 1 });
  const counters = {};
  const dependencies = strategyReadinessDependencies({
    rows: [eligible],
    readiness: readyStrategyConversionReadiness({
      ready: false,
      validated: false,
      reason: 'data_manager_validation_failed',
      reasons: ['data_manager_validation_failed'],
      issues: [{ reason: 'data_manager_validation_failed' }]
    }),
    counters
  });

  const result = await reconcileVerifiedConnectOnlyStrategyActivationReadiness({
    enhancedActivation: activeEnhancedActivation(),
    now: new Date('2026-07-13T14:00:00.000Z'),
    dependencies
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'strategy_readiness_blocked');
  assert.deepEqual(result.blocked, [{
    id: 1,
    clinic_id: 56,
    reason: 'data_manager_validation_failed',
    reasons: ['data_manager_validation_failed'],
    issues: [{ reason: 'data_manager_validation_failed' }]
  }]);
  assert.equal(result.reconciled, 0);
  assert.equal(eligible.updates, 0);
  assert.equal(counters.evaluations, 1);
  assert.equal(counters.transactions, 0);
  assert.equal(counters.lockedReads, 0);
}

async function testStrategyReadinessReconciliationRejectsExpiredConsentBeforeGoogle() {
  const eligible = strategyRequestRow({ id: 1 });
  const counters = {};
  const dependencies = strategyReadinessDependencies({
    rows: [eligible],
    counters,
    consentReadiness: {
      ready: false,
      validated: false,
      reasons: ['measurement_attestation_expired'],
      issues: [{ reason: 'measurement_attestation_expired' }],
      expires_at: '2026-07-13T13:59:59.000Z'
    }
  });
  const result = await reconcileVerifiedConnectOnlyStrategyActivationReadiness({
    enhancedActivation: activeEnhancedActivation(),
    now: new Date('2026-07-13T14:00:00.000Z'),
    dependencies
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.blocked[0].reason, 'strategy_consent_readiness_not_current');
  assert.equal(counters.evaluations, 0, 'expired consent must fail before Google reads/validateOnly');
  assert.equal(counters.transactions, 0);
}

async function testStrategyReadinessReconciliationRejectsRowPayloadClinicMismatch() {
  const mismatched = strategyRequestRow({
    id: 1,
    clinicId: 19,
    rowClinicId: 19,
    payloadClinicId: 56,
    scopedClinicIds: [56]
  });
  const counters = {};
  const result = await reconcileVerifiedConnectOnlyStrategyActivationReadiness({
    enhancedActivation: activeEnhancedActivation(),
    now: new Date('2026-07-13T14:00:00.000Z'),
    dependencies: strategyReadinessDependencies({ rows: [mismatched], counters })
  });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.blocked, [{
    id: 1,
    clinic_id: 56,
    reason: 'strategy_row_clinic_mismatch'
  }]);
  assert.equal(counters.evaluations, 0);
  assert.equal(counters.transactions, 0);
}

async function testStrategyReadinessReconciliationRereadsAfterLock() {
  const preflight = strategyRequestRow({ id: 1 });
  const changedBeforeLock = strategyRequestRow({
    id: 1,
    destination: { type: 'website', url: 'https://www.propdental.es/changed-destination' }
  });
  const counters = {};
  const dependencies = strategyReadinessDependencies({
    rows: [preflight],
    lockedRows: [changedBeforeLock],
    counters
  });

  const result = await reconcileVerifiedConnectOnlyStrategyActivationReadiness({
    enhancedActivation: activeEnhancedActivation(),
    now: new Date('2026-07-13T14:00:00.000Z'),
    dependencies
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reconciled, 0);
  assert.deepEqual(result.blocked, [{
    id: 1,
    clinic_id: 56,
    reason: 'strategy_changed_during_validation'
  }]);
  assert.equal(changedBeforeLock.updates, 0);
  assert.equal(counters.lockedReads, 1, 'the candidate must be re-read under UPDATE lock');
}

async function testStrategyReadinessReconciliationRejectsSourceConfigDrift() {
  const eligible = strategyRequestRow({ id: 1 });
  const changedGroupRecord = intakeRecord();
  changedGroupRecord.updated_at = '2026-07-13T14:00:00.000Z';
  const counters = {};
  const result = await reconcileVerifiedConnectOnlyStrategyActivationReadiness({
    enhancedActivation: activeEnhancedActivation(),
    now: new Date('2026-07-13T14:00:00.000Z'),
    dependencies: strategyReadinessDependencies({
      rows: [eligible],
      lockedIntakeRecords: [changedGroupRecord],
      counters
    })
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reconciled, 0);
  assert.equal(result.blocked[0].reason, 'measurement_scope_changed_during_validation');
  assert.equal(counters.lockedReads, 0, 'strategy rows are not locked after source scope drift');
}

async function testConcurrentReconciliationAcceptsCurrentSnapshotUnderLock() {
  const persisted = strategyRequestRow({ id: 1 });
  const firstCounters = {};
  await reconcileVerifiedConnectOnlyStrategyActivationReadiness({
    enhancedActivation: activeEnhancedActivation(),
    now: new Date('2026-07-13T14:00:00.000Z'),
    dependencies: strategyReadinessDependencies({ rows: [persisted], counters: firstCounters })
  });
  const stalePreflight = strategyRequestRow({ id: 1 });
  const secondCounters = {};
  const result = await reconcileVerifiedConnectOnlyStrategyActivationReadiness({
    enhancedActivation: activeEnhancedActivation(),
    now: new Date('2026-07-13T14:01:00.000Z'),
    dependencies: strategyReadinessDependencies({
      rows: [stalePreflight],
      lockedRows: [persisted],
      counters: secondCounters
    })
  });
  assert.equal(result.status, 'already_reconciled');
  assert.equal(result.reconciled, 0);
  assert.deepEqual(result.current_ids, [1]);
  assert.deepEqual(result.blocked, []);
  assert.equal(persisted.updates, 1, 'a concurrent worker must not rewrite a current snapshot');
}

async function testStrategyReadinessReconciliationRejectsDisallowedGateScope() {
  let reads = 0;
  const result = await reconcileVerifiedConnectOnlyStrategyActivationReadiness({
    enhancedActivation: activeEnhancedActivation({ customer_ids: ['9999999999'] }),
    dependencies: {
      CampaignRequest: {
        async findAll() {
          reads += 1;
          return [];
        }
      }
    }
  });
  assert.equal(result.status, 'blocked');
  assert.equal(result.reason, 'enhanced_activation_customer_scope_invalid');
  assert.equal(reads, 0, 'a disallowed gate must stop before reading strategy rows');

  const missingKey = await reconcileVerifiedConnectOnlyStrategyActivationReadiness({
    enhancedActivation: activeEnhancedActivation({ reconciliation_key: null }),
    dependencies: {
      CampaignRequest: {
        async findAll() {
          reads += 1;
          return [];
        }
      }
    }
  });
  assert.equal(missingKey.status, 'blocked');
  assert.equal(missingKey.reason, 'enhanced_activation_reconciliation_key_invalid');
  assert.equal(reads, 0);

  const skipped = await reconcileVerifiedConnectOnlyStrategyActivationReadiness({
    enhancedActivation: { status: 'blocked', ready: false },
    dependencies: {
      CampaignRequest: {
        async findAll() {
          reads += 1;
          return [];
        }
      }
    }
  });
  assert.equal(skipped.status, 'skipped');
  assert.equal(skipped.reason, 'enhanced_activation_not_ready');
  assert.equal(reads, 0);
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
  let consentReadiness = {
    ready: true,
    validated: true,
    reasons: [],
    expires_at: '2026-07-14T12:00:00.000Z',
    verification_current: true,
    renewal_required: false,
    runtime_configuration_ready: true
  };
  const dependencies = {
    resolveScopeFromInput: async () => ({ assignment_scope: 'group', group_id: 5 }),
    resolveEffectiveMarketingState: async () => ({
      records: { groupRecord: record },
      google: { available_accounts: scopedAccounts() }
    }),
    assessConsentMeasurementReadiness: () => consentReadiness,
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
    consentReadiness = {
      ready: false,
      validated: false,
      reason: 'consent_attestation_renewal_required',
      reasons: ['consent_attestation_renewal_required'],
      issues: [{
        reason: 'consent_attestation_renewal_required',
        domain: 'propdental.es',
        details: 'attestation_operational_expired'
      }],
      expires_at: '2026-07-14T12:00:00.000Z',
      verification_current: false,
      renewal_required: true,
      runtime_configuration_ready: true
    };
    const renewal = await reconcileEnhancedConversionsInternalActivation({
      now: new Date('2026-07-15T12:30:00.000Z'),
      dependencies
    });
    assert.equal(renewal.status, 'already_active');
    assert.equal(renewal.ready, true,
      'An expired observation must request renewal without contradicting the active uploader allowlist');
    assert.equal(renewal.consent_verification.renewal_required, true);
    assert.equal(
      renewal.consent_verification.runtime_continues_with_per_event_visitor_consent,
      true
    );
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

async function testConnectOnlyAuditTreatsExpiredObservationAsRenewalWarning() {
  const record = intakeRecord();
  const activationPlan = buildPlan({ intakeRecord: record });
  record.config = activationPlan.nextConfig;
  const staleConsent = {
    ready: false,
    validated: false,
    provider: 'clinicaclick',
    domains: ['propdental.es'],
    expires_at: '2026-07-12T11:59:59.000Z',
    verification_current: false,
    renewal_required: true,
    runtime_configuration_ready: true,
    issues: [{
      reason: 'consent_attestation_renewal_required',
      domain: 'propdental.es',
      details: 'attestation_operational_expired'
    }]
  };
  const report = await auditConnectOnlyMeasurementTarget({
    scope: { assignment_scope: 'group', group_id: 5 },
    intakeRecord: record,
    now: NOW,
    dependencies: {
      assessConsentMeasurementReadiness: () => staleConsent,
      evaluateGoogleConversionOnboardingReadiness: async (options) => {
        assert.equal(options.createMissing, false);
        return {
          ready: false,
          validated: false,
          customer_ids: ['1851215478', '5992356722'],
          targets: [{
            event: 'lead',
            destination_key: 'parallel',
            customer_id: '1851215478',
            configured_action_id: '1',
            conversion_action_id: '1',
            campaign_ids: ['123'],
            validated: true
          }],
          capabilities_by_customer: {
            1851215478: {
              data_manager_scope_granted: true,
              data_manager_quota_project_configured: true
            }
          },
          issues: staleConsent.issues
        };
      }
    }
  });
  assert.equal(report.healthy, true);
  assert.equal(report.runtime_ready, true);
  assert.equal(report.summary.critical_count, 0);
  assert.equal(report.summary.warning_count, 1);
  assert.equal(report.consent.renewal_required, true);
  assert.equal(report.consent.grants_consent, false);
  assert.equal(report.enhanced_conversions.canonical_actions_are_secondary, true);
  assert.equal(report.enhanced_conversions.reporting_metric, 'all_conversions');
  assert.equal(report.external_mutation_count, 0);
}

async function run() {
  testTargetCollectionExcludesPurchase();
  testReadyPlanIsRestrictedAndAuditable();
  testAccountSwitchFalseBlocksWholePlan();
  testAuthorizationMustBeExplicitAndValid();
  testRouteIsAuthenticatedAndPostOnly();
  await testPersistenceIsTransactionalAndIdempotent();
  testAutomaticJobAndReadOnlyBootstrapContracts();
  await testStrategyReadinessReconciliationUsesOnlyExplicitGroupLocations();
  await testStrategyReadinessReconciliationIsScopedLockedAndIdempotent();
  await testStrategyReadinessReconciliationRequiresRealValidation();
  await testStrategyReadinessReconciliationRejectsExpiredConsentBeforeGoogle();
  await testStrategyReadinessReconciliationRejectsRowPayloadClinicMismatch();
  await testStrategyReadinessReconciliationRereadsAfterLock();
  await testStrategyReadinessReconciliationRejectsSourceConfigDrift();
  await testConcurrentReconciliationAcceptsCurrentSnapshotUnderLock();
  await testStrategyReadinessReconciliationRejectsDisallowedGateScope();
  await testAutomaticReconciliationActivatesOnceAfterReadiness();
  await testPersonalizationCapabilityDoesNotWaitForEnhancedGate();
  await testConnectOnlyAuditTreatsExpiredObservationAsRenewalWarning();
  console.log('enhanced_conversion_activation_gate.test.js: OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
