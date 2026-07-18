'use strict';

const assert = require('node:assert/strict');
const {
  CAMPAIGN_MODES,
  IMPROVEMENT_AUTHORIZATION_SCOPES,
  IMPROVEMENT_AUTHORIZATION_VERSION,
  IMPROVEMENT_WEB_INTEGRATION_HOOKS,
  assertCampaignModeTransitionSafe,
  buildCampaignModeContract,
  normalizeImprovementAuthorization,
  usesExistingAdvertiserCampaigns,
  stableHttpsDestination,
  validateImprovementAuthorization,
} = require('../../controllers/campaignOnboarding.controller').__test;

function fullAuthorization() {
  return {
    version: IMPROVEMENT_AUTHORIZATION_VERSION,
    accepted: true,
    accepted_at: '2026-07-17T12:00:00.000Z',
    accepted_by_user_id: 7,
    scopes: [...IMPROVEMENT_AUTHORIZATION_SCOPES],
  };
}

function testCapabilitiesStaySeparated() {
  const measurement = buildCampaignModeContract(CAMPAIGN_MODES.MEASURE);
  assert.equal(measurement.measurement, true);
  assert.equal(measurement.consented_conversion_uploads, true);
  assert.equal(measurement.mutate_campaigns, false);
  assert.equal(measurement.publish_landings, false);
  assert.equal(measurement.manage_conversion_goals, false);

  const improvement = buildCampaignModeContract(
    CAMPAIGN_MODES.IMPROVE,
    fullAuthorization()
  );
  assert.equal(improvement.mutate_campaigns, true);
  assert.equal(improvement.publish_landings, true);
  assert.equal(improvement.change_destinations, true);
  assert.equal(improvement.manage_conversion_goals, true);
  assert.equal(improvement.integration_hooks.landing_publish.status, 'available');
  assert.equal(improvement.integration_hooks.landing_publish.event, IMPROVEMENT_WEB_INTEGRATION_HOOKS.landing_publish);
  assert.equal(improvement.integration_hooks.campaign_destination.status, 'available_after_landing_published');
  assert.equal(improvement.integration_hooks.campaign_destination.event, IMPROVEMENT_WEB_INTEGRATION_HOOKS.campaign_destination);
  assert.equal(improvement.mutate_bids, false);
  assert.equal(improvement.mutate_budget, false);
  assert.equal(improvement.mutate_campaign_status, false);
  assert.equal(improvement.requires_prepayment, false);

  const autopilot = buildCampaignModeContract(CAMPAIGN_MODES.AUTOPILOT);
  assert.equal(autopilot.mutate_campaigns, true);
  assert.equal(autopilot.mutate_bids, true);
  assert.equal(autopilot.mutate_budget, true);
  assert.equal(autopilot.mutate_campaign_status, true);
  assert.equal(autopilot.requires_prepayment, true);
}

function testAuthorizationEvidenceIsNeverInvented() {
  const normalized = normalizeImprovementAuthorization({
    version: IMPROVEMENT_AUTHORIZATION_VERSION,
    accepted: true,
    scopes: [...IMPROVEMENT_AUTHORIZATION_SCOPES],
  });
  assert.equal(normalized.accepted_at, null);
  assert.equal(normalized.accepted_by_user_id, null);
  const contract = buildCampaignModeContract(CAMPAIGN_MODES.IMPROVE, {
    version: IMPROVEMENT_AUTHORIZATION_VERSION,
    accepted: true,
    accepted_by_user_id: 9,
    scopes: [...IMPROVEMENT_AUTHORIZATION_SCOPES],
  });
  assert.equal(contract.authorization.accepted, false);
  assert.equal(contract.authorization.accepted_at, null);
  assert.equal(contract.authorization.accepted_by_user_id, null);
  assert.equal(contract.manage_conversion_goals, false);
}

function testStableHttpsDestinationsFailClosed() {
  assert.deepEqual(stableHttpsDestination('https://clinica.example/implantes'), {
    valid: true,
    url: 'https://clinica.example/implantes',
  });
  for (const value of [
    'http://clinica.example/implantes',
    'https://localhost/implantes',
    'https://192.168.1.10/implantes',
    'https://[::1]/implantes',
    'https://[fd00::1]/implantes',
    'https://[fe80::1]/implantes',
    'https://user:pass@clinica.example/implantes',
    'https://clinica.example/implantes#formulario',
    'https://clinica.example/implantes?gclid=temporary',
    'not-a-url',
  ]) {
    assert.equal(stableHttpsDestination(value).valid, false, value);
  }
}

function testImprovementAuthorizationIsExplicitAndBounded() {
  assert.throws(
    () => validateImprovementAuthorization(CAMPAIGN_MODES.IMPROVE, null),
    (error) => error.code === 'IMPROVEMENT_AUTHORIZATION_REQUIRED'
  );
  assert.throws(
    () => validateImprovementAuthorization(CAMPAIGN_MODES.IMPROVE, {
      ...fullAuthorization(),
      scopes: ['landing_publish'],
    }),
    (error) => error.code === 'IMPROVEMENT_AUTHORIZATION_REQUIRED'
  );

  const normalized = normalizeImprovementAuthorization({
    ...fullAuthorization(),
    scopes: [...IMPROVEMENT_AUTHORIZATION_SCOPES, 'budget_write', 'campaign_pause'],
  });
  assert.deepEqual(normalized.scopes, IMPROVEMENT_AUTHORIZATION_SCOPES);
  assert.equal(validateImprovementAuthorization(CAMPAIGN_MODES.IMPROVE, fullAuthorization()).accepted, true);
  assert.equal(validateImprovementAuthorization(CAMPAIGN_MODES.MEASURE, null), null);
}

function testExistingCampaignModes() {
  assert.equal(usesExistingAdvertiserCampaigns(CAMPAIGN_MODES.MEASURE), true);
  assert.equal(usesExistingAdvertiserCampaigns(CAMPAIGN_MODES.IMPROVE), true);
  assert.equal(usesExistingAdvertiserCampaigns(CAMPAIGN_MODES.AUTOPILOT), false);
  assert.equal(usesExistingAdvertiserCampaigns(CAMPAIGN_MODES.LEGACY_SELF_MANAGED), false);
}

async function testModeTransitionsRequireExplicitSafeConfirmation() {
  const base = {
    scope: { assignment_scope: 'clinic', clinic_id: 59, clinic_ids: [59] },
    currentMode: CAMPAIGN_MODES.LEGACY_SELF_MANAGED,
    nextMode: CAMPAIGN_MODES.IMPROVE,
    dependencies: {
      operators: { in: 'in' },
      CampaignRequest: { async findAll() { return []; } },
      Policy: { async findAll() { return []; } },
    },
  };
  await assert.rejects(
    () => assertCampaignModeTransitionSafe(base),
    (error) => error.code === 'CAMPAIGN_MODE_TRANSITION_CONFIRMATION_REQUIRED'
  );
  const confirmation = {
    confirmed: true,
    from_mode: CAMPAIGN_MODES.LEGACY_SELF_MANAGED,
    to_mode: CAMPAIGN_MODES.IMPROVE,
  };
  await assert.rejects(
    () => assertCampaignModeTransitionSafe({
      ...base,
      confirmation,
      dependencies: {
        ...base.dependencies,
        CampaignRequest: {
          async findAll() {
            return [{ id: 10, campaign_id: 901, solicitud: {
              kind: 'marketing_strategy', mode: 'managed_self', status: 'paused',
            } }];
          },
        },
      },
    }),
    (error) => error.code === 'CAMPAIGN_MODE_TRANSITION_ACTIVE_STRATEGIES'
  );
  await assert.rejects(
    () => assertCampaignModeTransitionSafe({
      ...base,
      confirmation,
      dependencies: {
        ...base.dependencies,
        Policy: { async findAll() { return [{ id: 8, mode: 'managed_self', status: 'paused' }]; } },
      },
    }),
    (error) => error.code === 'CAMPAIGN_MODE_TRANSITION_ACTIVE_POLICY'
  );
  assert.deepEqual(await assertCampaignModeTransitionSafe({ ...base, confirmation }), {
    from_mode: CAMPAIGN_MODES.LEGACY_SELF_MANAGED,
    to_mode: CAMPAIGN_MODES.IMPROVE,
    confirmed: true,
  });
}

async function run() {
  testCapabilitiesStaySeparated();
  testImprovementAuthorizationIsExplicitAndBounded();
  testAuthorizationEvidenceIsNeverInvented();
  testStableHttpsDestinationsFailClosed();
  testExistingCampaignModes();
  await testModeTransitionsRequireExplicitSafeConfirmation();
  console.log('campaign_three_tier_mode_contract.test.js OK');
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
