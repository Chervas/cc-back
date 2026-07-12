'use strict';

const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');
const {
  __test: {
    buildEnhancedConversionActivationPlan,
    collectEnhancedConversionActivationTargets,
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
          qualified_lead: {
            enabled: true,
            destinations: [
              { customer_id: '1851215478', conversion_action_id: '3' },
              { customer_id: '5992356722', conversion_action_id: '4' }
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
  assert.deepEqual(targets.event_names, ['lead', 'qualified_lead']);
  assert.equal(targets.pairs.length, 4);
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
  assert.equal(plan.nextConfig.features.ad_personalization_enabled, false);
  assert.equal(plan.nextConfig.google_ads.user_data_enabled, true);
  assert.equal(plan.nextConfig.google_ads.events.lead.user_data_enabled, true);
  assert.equal(plan.nextConfig.google_ads.events.qualified_lead.user_data_enabled, true);
  assert.equal(plan.nextConfig.google_ads.events.purchase.user_data_enabled, undefined);
  assert.equal(plan.nextConfig.google_ads.enhanced_conversions.enabled, true);
  assert.equal(
    plan.nextConfig.google_ads.enhanced_conversions.policy_mode,
    'documented_google_account_team_guidance_and_advertiser_authorization'
  );
  assert.equal(plan.nextConfig.google_ads.enhanced_conversions.allowlist.length, 4);
  for (const entry of plan.nextConfig.google_ads.enhanced_conversions.allowlist) {
    assert.deepEqual(entry.authorization.permitted_identifiers, ['email', 'phone']);
    assert.equal(entry.authorization.google_evidence_ref, '4-1893000040437');
    assert.equal(entry.authorization.measurement_only, true);
    assert.equal(entry.authorization.customer_match_enabled, false);
    assert.equal(entry.authorization.conversion_based_customer_lists_enabled, false);
    assert.equal(entry.authorization.remarketing_enabled, false);
    assert.equal(entry.authorization.ad_personalization, 'DENIED');
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
  assert.equal(audit.gate_version, 1);
  assert.equal(audit.actor_user_id, 7);
  assert.equal(audit.google_evidence_ref, '4-1893000040437');
  assert.equal(audit.customer_match_enabled, false);
  assert.equal(audit.remarketing_enabled, false);
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

function run() {
  testTargetCollectionExcludesPurchase();
  testReadyPlanIsRestrictedAndAuditable();
  testAccountSwitchFalseBlocksWholePlan();
  testAuthorizationMustBeExplicitAndValid();
  testRouteIsAuthenticatedAndPostOnly();
  console.log('enhanced_conversion_activation_gate.test.js: OK');
}

run();
