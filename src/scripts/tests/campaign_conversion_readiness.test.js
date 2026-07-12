'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../../models');
const { __test } = require('../../controllers/campaignOnboarding.controller');

const {
  applyCanonicalMappingsToGoogleAdsConfig,
  assessConversionOnboardingReadiness,
  buildRequiredConversionPlan,
  buildClinicaclickConversionActionUpdate,
  conversionValidationKey,
  resolveEnabledConversionEvents,
  strategyPayloadUsesGoogleAds
} = __test;

function enabledAction(id, name) {
  return { id, name, status: 'ENABLED', counting_type: 'MANY_PER_CLICK', primary_for_goal: false };
}

function validatedTargets(plan, mappingsByCustomer) {
  const validations = {};
  for (const target of plan.targets) {
    const actionId = mappingsByCustomer[target.customer_id]?.[target.event];
    if (!actionId) continue;
    validations[conversionValidationKey(target.customer_id, target.event, actionId)] = {
      status: 'validated',
      validated: true,
      validate_only: true
    };
  }
  return validations;
}

function testEnabledEventsAndNullMapping() {
  assert.deepEqual(resolveEnabledConversionEvents({}), ['lead', 'contact', 'schedule']);
  assert.deepEqual(resolveEnabledConversionEvents({
    events: {
      lead: { enabled: true },
      contact: { enabled: false },
      schedule: { enabled: true },
      purchase: { enabled: true }
    }
  }), ['lead', 'schedule', 'purchase']);

  const plan = buildRequiredConversionPlan({}, '599-235-6722');
  const readiness = assessConversionOnboardingReadiness({
    plan,
    mappingsByCustomer: { 5992356722: { lead: null, contact: null, schedule: null, purchase: null } },
    capabilitiesByCustomer: {
      5992356722: {
        data_manager_scope_granted: true,
        data_manager_quota_project_configured: true
      }
    }
  });
  assert.equal(readiness.ready, false);
  assert.ok(readiness.reasons.includes('canonical_conversion_action_missing'));
  assert.equal(readiness.targets.length, 0);
}

function testMissingScopeAndQuotaAreHardGates() {
  const plan = buildRequiredConversionPlan({
    customer_id: '5992356722',
    events: {
      lead: { enabled: true },
      contact: { enabled: false },
      schedule: { enabled: false }
    }
  });
  const mappings = { 5992356722: { lead: '1001' } };
  const actions = { 5992356722: [enabledAction('1001', 'Lead - ClinicaClick')] };
  const validations = validatedTargets(plan, mappings);

  const scopeMissing = assessConversionOnboardingReadiness({
    plan,
    mappingsByCustomer: mappings,
    actionsByCustomer: actions,
    capabilitiesByCustomer: {
      5992356722: {
        data_manager_scope_granted: false,
        data_manager_quota_project_configured: true
      }
    },
    validationsByTarget: validations
  });
  assert.equal(scopeMissing.ready, false);
  assert.ok(scopeMissing.reasons.includes('data_manager_scope_missing'));

  const quotaMissing = assessConversionOnboardingReadiness({
    plan,
    mappingsByCustomer: mappings,
    actionsByCustomer: actions,
    capabilitiesByCustomer: {
      5992356722: {
        data_manager_scope_granted: true,
        data_manager_quota_project_configured: false
      }
    },
    validationsByTarget: validations
  });
  assert.equal(quotaMissing.ready, false);
  assert.ok(quotaMissing.reasons.includes('data_manager_quota_project_missing'));
}

function testMultiAccountRequiresAttributionSelector() {
  const withoutSelectors = {
    customer_id: '1851215478',
    events: {
      lead: {
        enabled: true,
        destinations: [
          { key: 'parallel', customer_id: '1851215478', conversion_action_id: 'old-1' },
          { key: 'main', customer_id: '5992356722', conversion_action_id: 'old-2' }
        ]
      },
      contact: { enabled: false },
      schedule: { enabled: false }
    }
  };
  const blockedPlan = buildRequiredConversionPlan(withoutSelectors, '1851215478');
  assert.equal(blockedPlan.customer_ids.length, 2);
  assert.ok(blockedPlan.issues.some((issue) => issue.reason === 'attribution_selector_missing'));

  const configured = JSON.parse(JSON.stringify(withoutSelectors));
  configured.events.lead.destinations[0].campaign_ids = ['111111111'];
  configured.events.lead.destinations[1].campaign_ids = ['222222222'];
  const plan = buildRequiredConversionPlan(configured, '1851215478');
  assert.equal(plan.issues.length, 0);

  const mappings = {
    1851215478: { lead: '7680195320' },
    5992356722: { lead: '7540337982' }
  };
  const actions = {
    1851215478: [enabledAction('7680195320', 'Lead - ClinicaClick')],
    5992356722: [enabledAction('7540337982', 'Lead - ClinicaClick')]
  };
  const capabilities = {
    1851215478: { data_manager_scope_granted: true, data_manager_quota_project_configured: true },
    5992356722: { data_manager_scope_granted: true, data_manager_quota_project_configured: true }
  };
  const readiness = assessConversionOnboardingReadiness({
    plan,
    mappingsByCustomer: mappings,
    actionsByCustomer: actions,
    capabilitiesByCustomer: capabilities,
    validationsByTarget: validatedTargets(plan, mappings)
  });
  assert.equal(readiness.ready, true);
  assert.equal(readiness.validated, true);

  const canonical = applyCanonicalMappingsToGoogleAdsConfig(configured, '1851215478', mappings);
  assert.equal(canonical.events.lead.destinations[0].conversion_action_id, '7680195320');
  assert.equal(canonical.events.lead.destinations[1].conversion_action_id, '7540337982');
  assert.deepEqual(canonical.events.lead.destinations[0].campaign_ids, ['111111111']);
  assert.deepEqual(canonical.events.lead.destinations[1].campaign_ids, ['222222222']);
}

function testBraidIncompatibleCountingTypeIsBlocked() {
  const plan = buildRequiredConversionPlan({
    customer_id: '5992356722',
    events: {
      lead: { enabled: true },
      contact: { enabled: false },
      schedule: { enabled: false }
    }
  });
  const mappings = { 5992356722: { lead: '1001' } };
  const readiness = assessConversionOnboardingReadiness({
    plan,
    mappingsByCustomer: mappings,
    actionsByCustomer: {
      5992356722: [{
        id: '1001',
        name: 'Lead - ClinicaClick',
        status: 'ENABLED',
        counting_type: 'ONE_PER_CLICK',
        primary_for_goal: false
      }]
    },
    capabilitiesByCustomer: {
      5992356722: {
        data_manager_scope_granted: true,
        data_manager_quota_project_configured: true
      }
    },
    validationsByTarget: validatedTargets(plan, mappings)
  });
  assert.equal(readiness.ready, false);
  const issue = readiness.issues.find((candidate) => candidate.reason === 'braid_incompatible_counting_type');
  assert.equal(issue.customer_id, '5992356722');
  assert.equal(issue.conversion_action_id, '1001');
  assert.equal(issue.counting_type, 'ONE_PER_CLICK');
}

function testExplicitCanonicalNormalizationDoesNotTouchClientActions() {
  const canonical = buildClinicaclickConversionActionUpdate({
    id: '1001',
    resource_name: 'customers/5992356722/conversionActions/1001',
    name: 'Lead - ClinicaClick',
    type: 'UPLOAD_CLICKS',
    counting_type: 'ONE_PER_CLICK',
    primary_for_goal: true
  }, 'lead', '5992356722');
  assert.deepEqual(canonical.operation, {
    update: {
      resourceName: 'customers/5992356722/conversionActions/1001',
      countingType: 'MANY_PER_CLICK',
      primaryForGoal: false
    },
    updateMask: 'counting_type,primary_for_goal'
  });
  assert.equal(buildClinicaclickConversionActionUpdate({
    id: 'client-1',
    name: 'Formulario de contacto principal',
    type: 'UPLOAD_CLICKS',
    counting_type: 'ONE_PER_CLICK',
    primary_for_goal: true
  }, 'lead', '5992356722'), null);
  assert.equal(buildClinicaclickConversionActionUpdate({
    id: '1001',
    name: 'Lead - ClinicaClick',
    type: 'WEBPAGE',
    counting_type: 'ONE_PER_CLICK',
    primary_for_goal: true
  }, 'lead', '5992356722'), null);

  const controller = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/campaignOnboarding.controller.js'),
    'utf8'
  );
  assert.match(controller, /normalize_existing/);
  assert.match(controller, /validateOnly: true/);
  assert.match(controller, /updateMask: 'counting_type,primary_for_goal'/);
}

function testPrimaryCanonicalActionIsNotReadyForBiddingSafety() {
  const plan = buildRequiredConversionPlan({
    customer_id: '5992356722',
    events: { lead: { enabled: true }, contact: { enabled: false }, schedule: { enabled: false } }
  });
  const mappings = { 5992356722: { lead: '1001' } };
  const readiness = assessConversionOnboardingReadiness({
    plan,
    mappingsByCustomer: mappings,
    actionsByCustomer: {
      5992356722: [{
        id: '1001',
        name: 'Lead - ClinicaClick',
        status: 'ENABLED',
        counting_type: 'MANY_PER_CLICK',
        primary_for_goal: true
      }]
    },
    capabilitiesByCustomer: {
      5992356722: { data_manager_scope_granted: true, data_manager_quota_project_configured: true }
    },
    validationsByTarget: validatedTargets(plan, mappings)
  });
  assert.equal(readiness.ready, false);
  assert.ok(readiness.reasons.includes('canonical_action_primary_for_goal'));
}

function testGoogleStrategyRequiresVerifiedActivation() {
  assert.equal(strategyPayloadUsesGoogleAds({
    channels: [{ channel: 'google_ads', enabled: true }]
  }), true);
  assert.equal(strategyPayloadUsesGoogleAds({
    channels: [{ channel: 'meta_ads', enabled: true }]
  }), false);

  const migration = fs.readFileSync(
    path.resolve(__dirname, '../../../migrations/20260712102000-normalize-unverified-connect-only-strategies.js'),
    'utf8'
  );
  assert.match(migration, /legacy_conversion_readiness_not_verified/);
  assert.match(migration, /payload\.status !== 'completed'/);
  assert.match(migration, /active_mode: null/);
  assert.doesNotMatch(migration, /UPDATE Campaigns/);
  assert.doesNotMatch(migration, /status: 'draft'/);
}

async function run() {
  testEnabledEventsAndNullMapping();
  testMissingScopeAndQuotaAreHardGates();
  testMultiAccountRequiresAttributionSelector();
  testBraidIncompatibleCountingTypeIsBlocked();
  testExplicitCanonicalNormalizationDoesNotTouchClientActions();
  testPrimaryCanonicalActionIsNotReadyForBiddingSafety();
  testGoogleStrategyRequiresVerifiedActivation();
  console.log('campaign_conversion_readiness.test.js OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
