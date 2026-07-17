'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../../../models');
const { __test } = require('../../controllers/campaignOnboarding.controller');
const {
  buildVerificationConfigHash,
  DEFAULT_PERSISTED_VERIFICATION_TTL_SECONDS,
  issueVerificationAttestation,
} = require('../../lib/intake-verification-attestation');

process.env.INTAKE_VERIFICATION_ATTESTATION_SECRET = 'campaign-readiness-test-secret';

const {
  applyCanonicalMappingsToGoogleAdsConfig,
  assessConsentMeasurementReadiness,
  assessConversionOnboardingReadiness,
  buildRequiredConversionPlan,
  conversionValidationKey,
  resolveEnabledConversionEvents,
  strategyPayloadUsesGoogleAds
} = __test;

function readyConsentState(provider = 'clinicaclick', options = {}) {
  const domains = options.domains || ['propdental.es', 'implantes.propdental.es'];
  const legalPage = {
    legal: { configured: true, reachable: true },
    cookies: { configured: true, reachable: true },
    privacy: { configured: true, reachable: true }
  };
  const record = {
    assignment_scope: 'group',
    group_id: 5,
    hmac_key: 'snippet-hmac-key',
    domains,
    config: {
      features: {
        consent_mode_enabled: true,
        consent_provider: provider,
        external_cmp_provider: provider === 'external_cmp' ? 'complianz' : null,
      },
      texts: {
        legal_url: '/aviso-legal/',
        cookies_url: '/politica-de-cookies/',
        privacy_url: '/politica-de-privacidad/'
      }
    }
  };
  const configHash = buildVerificationConfigHash({
    scopeType: 'group',
    scopeId: 5,
    domains,
    config: record.config,
    hmacKey: record.hmac_key,
  });
  const attestationsByDomain = {};
  for (const rawDomain of domains) {
    const domain = String(rawDomain).replace(/^www\./, '');
    if (options.omitDomain === domain || attestationsByDomain[domain]) continue;
    const signalOverrides = options.signalsByDomain?.[domain] || {};
    const issued = issueVerificationAttestation({
      scopeType: 'group',
      scopeId: 5,
      domain,
      configHash,
      nowMs: options.nowMs,
      ttlSeconds: options.ttlSecondsByDomain?.[domain] ?? options.ttlSeconds,
      signals: {
        installed: true,
        runtime_compatible: true,
        runtime_version: '3.3.2',
        consent_mode_detected: true,
        google_consent_mode_detected: true,
        cookie_notice_detected: provider === 'external_cmp',
        cookie_notice_provider: provider === 'external_cmp' ? 'Complianz' : null,
        legal_urls_detected: true,
        legal_pages: legalPage,
        checked_url: `https://${domain}/`,
        ...signalOverrides,
      },
    });
    attestationsByDomain[domain] = issued.token;
  }
  record.config.snippet_verification = {
    // These unsigned summaries are intentionally irrelevant to readiness.
    verified: options.forgedSummary === true,
    runtime_compatible: options.forgedSummary === true,
    consent_mode_detected: options.forgedSummary === true,
    google_consent_mode_detected: options.forgedSummary === true,
    attestations_by_domain: options.withoutAttestations ? {} : attestationsByDomain,
  };
  return {
    scope: { assignment_scope: 'group' },
    records: {
      groupRecord: record
    }
  };
}

function testConsentReadinessIsAHardGate() {
  const ready = assessConsentMeasurementReadiness(readyConsentState());
  assert.equal(ready.ready, true);
  assert.ok(ready.expires_at, 'Readiness must expose the persisted verification expiry');

  const timerNow = Date.now();
  const timerState = assessConsentMeasurementReadiness(readyConsentState('clinicaclick', {
    nowMs: timerNow,
    ttlSecondsByDomain: {
      'propdental.es': 30,
      'implantes.propdental.es': 120,
    },
  }));
  assert.equal(
    timerState.expires_at,
    new Date((Math.floor(timerNow / 1000) + DEFAULT_PERSISTED_VERIFICATION_TTL_SECONDS) * 1000).toISOString(),
    'The UI timer must use the operational lease, not the short submission token',
  );

  const disabledState = readyConsentState();
  disabledState.records.groupRecord.config.features.consent_mode_enabled = false;
  const disabled = assessConsentMeasurementReadiness(disabledState);
  assert.equal(disabled.ready, false);
  assert.ok(disabled.reasons.includes('consent_mode_disabled'));

  const outdatedState = readyConsentState('clinicaclick', {
    signalsByDomain: { 'propdental.es': { runtime_compatible: false } }
  });
  const outdated = assessConsentMeasurementReadiness(outdatedState);
  assert.equal(outdated.ready, false);
  assert.ok(outdated.reasons.includes('consent_runtime_incompatible'));

  const partialRuntimeState = readyConsentState('clinicaclick', {
    omitDomain: 'implantes.propdental.es'
  });
  const partialRuntime = assessConsentMeasurementReadiness(partialRuntimeState);
  assert.equal(partialRuntime.ready, false);
  assert.ok(partialRuntime.issues.some((issue) => (
    issue.reason === 'consent_attestation_missing' && issue.domain === 'implantes.propdental.es'
  )));

  const inconsistentSignalsState = readyConsentState('clinicaclick', {
    signalsByDomain: { 'propdental.es': { google_consent_mode_detected: false } }
  });
  const inconsistentSignals = assessConsentMeasurementReadiness(inconsistentSignalsState);
  assert.equal(inconsistentSignals.ready, false);
  assert.ok(inconsistentSignals.reasons.includes('google_consent_mode_unverified'));

  const externalState = readyConsentState('external_cmp', {
    signalsByDomain: { 'propdental.es': { cookie_notice_detected: false } }
  });
  const external = assessConsentMeasurementReadiness(externalState);
  assert.equal(external.ready, false);
  assert.ok(external.reasons.includes('external_cmp_unverified'));

  for (const detectedProvider of ['Cookiebot', 'OneTrust']) {
    const wrongProviderState = readyConsentState('external_cmp', {
      signalsByDomain: {
        'propdental.es': {
          cookie_notice_detected: true,
          cookie_notice_provider: detectedProvider,
        },
      },
    });
    const wrongProvider = assessConsentMeasurementReadiness(wrongProviderState);
    assert.equal(wrongProvider.ready, false, `${detectedProvider} must not satisfy a Complianz configuration`);
    assert.ok(wrongProvider.issues.some((issue) => (
      issue.domain === 'propdental.es'
        && issue.reason === 'external_cmp_unverified'
        && issue.details === 'external_cmp_provider_mismatch'
        && issue.expected_provider === 'complianz'
        && issue.detected_provider === detectedProvider
    )));
  }

  const forged = assessConsentMeasurementReadiness(readyConsentState('clinicaclick', {
    withoutAttestations: true,
    forgedSummary: true,
  }));
  assert.equal(forged.ready, false, 'Unsigned booleans must never satisfy readiness');
  assert.ok(forged.reasons.includes('consent_attestation_missing'));

  const submissionExpired = assessConsentMeasurementReadiness(readyConsentState('clinicaclick', {
    nowMs: Date.now() - 60_000,
    ttlSeconds: 1,
  }));
  assert.equal(submissionExpired.ready, true,
    'A short-lived token already persisted by the backend remains operationally valid');

  const operationallyExpired = assessConsentMeasurementReadiness(readyConsentState('clinicaclick', {
    nowMs: Date.now() - ((DEFAULT_PERSISTED_VERIFICATION_TTL_SECONDS + 60) * 1_000),
    ttlSeconds: 1,
  }));
  assert.equal(operationallyExpired.ready, false);
  assert.ok(operationallyExpired.issues.some((issue) => issue.details === 'attestation_operational_expired'));
  assert.equal(operationallyExpired.renewal_required, true);
  assert.equal(operationallyExpired.verification_current, false);
  assert.equal(operationallyExpired.runtime_configuration_ready, true,
    'Expiry requires a fresh public check but does not turn stale evidence into visitor consent');

  const changedConfigState = readyConsentState();
  changedConfigState.records.groupRecord.config.texts.cookies_url = '/otra-politica/';
  const changedConfig = assessConsentMeasurementReadiness(changedConfigState);
  assert.equal(changedConfig.ready, false);
  assert.ok(changedConfig.issues.some((issue) => issue.details === 'attestation_config_mismatch'));
}

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
  assert.deepEqual(resolveEnabledConversionEvents({}), ['lead', 'contact', 'qualified_lead', 'schedule']);
  assert.deepEqual(resolveEnabledConversionEvents({
    events: {
      lead: { enabled: true },
      contact: { enabled: false },
      schedule: { enabled: true },
      purchase: { enabled: true }
    }
  }), ['lead', 'qualified_lead', 'schedule', 'purchase']);

  const plan = buildRequiredConversionPlan({}, '599-235-6722');
  const readiness = assessConversionOnboardingReadiness({
    plan,
    mappingsByCustomer: {
      5992356722: {
        lead: null,
        contact: null,
        qualified_lead: null,
        schedule: null,
        purchase: null,
      },
    },
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
      qualified_lead: { enabled: false },
      schedule: { enabled: false }
    }
  };
  const blockedPlan = buildRequiredConversionPlan(withoutSelectors, '1851215478');
  assert.equal(blockedPlan.customer_ids.length, 2);
  assert.ok(blockedPlan.issues.some((issue) => issue.reason === 'attribution_selector_missing'));

  const configured = JSON.parse(JSON.stringify(withoutSelectors));
  configured.events.lead.destinations[0].campaign_ids = ['111111111'];
  configured.events.lead.destinations[1].campaign_ids = ['222222222'];
  const mappings = {
    1851215478: { lead: '7680195320' },
    5992356722: { lead: '7540337982' }
  };
  configured.events.lead.destinations[0].conversion_action_id = mappings[1851215478].lead;
  configured.events.lead.destinations[1].conversion_action_id = mappings[5992356722].lead;
  const plan = buildRequiredConversionPlan(configured, '1851215478');
  assert.equal(plan.issues.length, 0);
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

function testConfiguredDestinationActionDriftIsBlocked() {
  const config = {
    customer_id: '5992356722',
    events: {
      lead: {
        enabled: true,
        customer_id: '5992356722',
        conversion_action_id: '9999'
      },
      contact: { enabled: false },
      schedule: { enabled: false }
    }
  };
  const plan = buildRequiredConversionPlan(config, '5992356722');
  const mappings = { 5992356722: { lead: '1001' } };
  const readiness = assessConversionOnboardingReadiness({
    plan,
    mappingsByCustomer: mappings,
    actionsByCustomer: { 5992356722: [enabledAction('1001', 'Lead - ClinicaClick')] },
    capabilitiesByCustomer: {
      5992356722: { data_manager_scope_granted: true, data_manager_quota_project_configured: true }
    },
    validationsByTarget: validatedTargets(plan, mappings)
  });
  assert.equal(readiness.ready, false);
  assert.deepEqual(
    readiness.issues.find((issue) => issue.reason === 'conversion_destination_action_drift'),
    {
      reason: 'conversion_destination_action_drift',
      customer_id: '5992356722',
      event: 'lead',
      destination_key: 'legacy_lead',
      configured_conversion_action_id: '9999',
      canonical_conversion_action_id: '1001'
    }
  );
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
  const controller = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/campaignOnboarding.controller.js'),
    'utf8'
  );
  assert.match(controller, /normalize_existing/);
  assert.match(controller, /normalizeCanonicalGoogleAdsConversions/);
  assert.match(controller, /expected_actions: expectedActions/);
  assert.doesNotMatch(controller, /buildClinicaclickConversionActionUpdate/);
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
  assert.equal(strategyPayloadUsesGoogleAds({
    channels: [],
    external_targets: [{
      campaigns: [{ provider: 'google_ads', customer_id: '1851215478', campaign_id: '123' }]
    }]
  }), true, 'Empty channels must not bypass Google readiness for external targets');
  assert.equal(strategyPayloadUsesGoogleAds({
    targets: [{ type: 'google_ads', customer_id: '1851215478' }]
  }), true, 'Legacy target collections must still trigger the Google gate');
  assert.equal(strategyPayloadUsesGoogleAds({
    channels: [],
    external_targets: [{ campaigns: [{ provider: 'meta_ads', account_id: '123', campaign_id: '456' }] }]
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
  testConsentReadinessIsAHardGate();
  testEnabledEventsAndNullMapping();
  testMissingScopeAndQuotaAreHardGates();
  testMultiAccountRequiresAttributionSelector();
  testConfiguredDestinationActionDriftIsBlocked();
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
