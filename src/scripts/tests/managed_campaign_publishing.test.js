'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REQUIRED_EXECUTION_CONFIRMATIONS,
  assertManagedCampaignExecutionGates,
  buildManagedCampaignPublishingPlan,
  evaluateManagedCampaignExecutionGates,
} = require('../../services/managedCampaignPublishing.service');

const gateEvidence = {
  prepayment_verified: true,
  budget_approved: true,
  policy_reviewed: true,
  tracking_verified: true,
  creative_rights_confirmed: true,
};

function baseCampaign(overrides = {}) {
  return {
    id: 'campaign-plan-test',
    version: 4,
    objective_id: 'new_patients',
    clinica_id: 58,
    grupo_clinica_id: 5,
    management_mode: 'autopilot',
    operation_mode: 'managed',
    provider: 'google_ads',
    family: 'google_search',
    status: 'approved_to_launch',
    name: 'Implantes Badalona',
    target_config: { geo: { radius_km: 12 }, keywords: ['implantes dentales', 'dentista implantes'] },
    budget_config: { amount: 500, currency: 'EUR', period: 'monthly' },
    schedule_config: { start_date: '2026-08-01' },
    destination_config: { final_url: 'https://example.test/implantes' },
    audience_config: {},
    creative_config: {
      assets_ready: true,
      headlines: ['Implantes dentales', 'Recupera tu sonrisa', 'Valoración personalizada'],
      descriptions: ['Equipo especializado en implantología.', 'Solicita una valoración en nuestra clínica.'],
      accessToken: 'must-never-leak',
    },
    tracking_plan: { status: 'ready', conversion_actions_ready: true },
    platform_refs: {
      customer_id: '5992356722',
      access_token: 'secret-google-token',
      nested: { clientSecret: 'also-secret' },
    },
    review_config: { client_approval_required: true, client_approved_at: '2026-07-11T10:00:00.000Z' },
    policy_readiness: { status: 'ready' },
    approved_at: '2026-07-11T11:00:00.000Z',
    approved_by_user_id: 1,
    funding: { available_amount: 450, commission_amount: 50, refreshToken: 'hidden' },
    ...overrides,
  };
}

function fullConfirmation(plan) {
  return {
    plan_hash: plan.plan_hash,
    actor_user_id: 1,
    idempotency_key: 'publish-campaign-plan-test-v4',
    change_reference: 'OPS-2026-0042',
    ...Object.fromEntries(REQUIRED_EXECUTION_CONFIRMATIONS.map((key) => [key, true])),
  };
}

function testDeterministicGoogleSearchPlan() {
  const first = buildManagedCampaignPublishingPlan({ campaign: baseCampaign(), gateEvidence });
  const reordered = baseCampaign({
    target_config: { keywords: ['implantes dentales', 'dentista implantes'], geo: { radius_km: 12 } },
  });
  const second = buildManagedCampaignPublishingPlan({ campaign: reordered, gateEvidence: { ...gateEvidence } });
  assert.equal(first.plan_hash, second.plan_hash);
  assert.equal(first.plan_id, second.plan_id);
  assert.equal(first.mode, 'dry_run');
  assert.equal(first.readiness.ready, true);
  assert.equal(first.execution.adapter_available, false);
  assert.equal(first.execution.provider_call_performed, false);
  assert.equal(first.specification.provider_campaign_type, 'SEARCH');
  assert.deepEqual(first.specification.creative.headlines, baseCampaign().creative_config.headlines);
  assert.deepEqual(first.specification.ad_group.keywords, baseCampaign().target_config.keywords);

  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /must-never-leak|secret-google-token|also-secret|hidden/);
  assert.doesNotMatch(serialized, /access_token|accessToken|refreshToken|clientSecret/);
}

function testNoInventedAssetsAndUnsupportedFamily() {
  const missing = buildManagedCampaignPublishingPlan({
    campaign: baseCampaign({
      creative_config: { assets_ready: false },
      target_config: {},
      destination_config: {},
      platform_refs: {},
    }),
    gateEvidence: {},
  });
  assert.equal(missing.readiness.ready, false);
  assert.deepEqual(missing.specification.creative.headlines, []);
  assert.deepEqual(missing.specification.creative.descriptions, []);
  assert.deepEqual(missing.specification.ad_group.keywords, []);
  const blockerCodes = new Set(missing.readiness.blockers.map((item) => item.code));
  assert.equal(blockerCodes.has('provider_account_required'), true);
  assert.equal(blockerCodes.has('search_headlines_required'), true);
  assert.equal(blockerCodes.has('gate_prepayment_verified_required'), true);

  const observeOnly = buildManagedCampaignPublishingPlan({
    campaign: baseCampaign({ family: 'google_smart_observe' }),
    gateEvidence,
  });
  assert.equal(observeOnly.readiness.ready, false);
  assert.equal(observeOnly.readiness.blockers.some((item) => item.code === 'unsupported_provider_family'), true);
}

function testOtherSupportedFamilies() {
  const pmax = buildManagedCampaignPublishingPlan({
    campaign: baseCampaign({
      family: 'google_pmax',
      destination_config: { final_urls: ['https://example.test/pmax'] },
      creative_config: {
        assets_ready: true,
        headlines: ['Uno', 'Dos', 'Tres'],
        long_headlines: ['Tratamientos dentales personalizados en Badalona'],
        descriptions: ['Descripción uno', 'Descripción dos'],
        images: ['asset:image:1'],
        logos: ['asset:logo:1'],
      },
    }),
    gateEvidence,
  });
  assert.equal(pmax.readiness.ready, true);
  assert.equal(pmax.specification.provider_campaign_type, 'PERFORMANCE_MAX');

  const metaBase = baseCampaign({
    provider: 'meta_ads',
    family: 'meta_reach',
    target_config: { geo: { city: 'Badalona' } },
    platform_refs: { ad_account_id: 'act_123', page_id: '456' },
    creative_config: {
      assets_ready: true,
      primary_text: 'Cuida tu sonrisa',
      headline: 'Clínica dental en Badalona',
      media: ['asset:image:meta-1'],
      call_to_action: 'LEARN_MORE',
    },
  });
  const reach = buildManagedCampaignPublishingPlan({ campaign: metaBase, gateEvidence });
  assert.equal(reach.readiness.ready, true);
  assert.equal(reach.specification.provider_objective, 'OUTCOME_AWARENESS');

  const instant = buildManagedCampaignPublishingPlan({
    campaign: {
      ...metaBase,
      family: 'meta_instant_form',
      destination_config: { instant_form_id: '789' },
    },
    gateEvidence,
  });
  assert.equal(instant.readiness.ready, true);
  assert.equal(instant.specification.instant_form_id, '789');
  assert.equal(instant.specification.provider_objective, 'OUTCOME_LEADS');
}

function testStructuredValuesCannotMasqueradeAsProviderAssets() {
  const malicious = buildManagedCampaignPublishingPlan({
    campaign: baseCampaign({
      provider: 'meta_ads',
      family: 'meta_instant_form',
      platform_refs: { ad_account_id: {}, page_id: {} },
      destination_config: { instant_form_id: {} },
      creative_config: {
        assets_ready: true,
        primary_text: {},
        headline: {},
        media: [{}],
        call_to_action: {},
      },
    }),
    gateEvidence,
  });
  assert.equal(malicious.readiness.ready, false);
  const serialized = JSON.stringify(malicious);
  assert.doesNotMatch(serialized, /\[object Object\]/);
  const codes = new Set(malicious.readiness.blockers.map((item) => item.code));
  assert.equal(codes.has('provider_account_required'), true);
  assert.equal(codes.has('meta_page_required'), true);
  assert.equal(codes.has('meta_instant_form_required'), true);
  assert.equal(codes.has('meta_primary_text_required'), true);
  assert.equal(codes.has('meta_media_required'), true);
  assert.equal(codes.has('meta_cta_required'), true);
}

function testPrivateDestinationsCannotEnterPublishingPlans() {
  for (const finalUrl of [
    'http://127.0.0.1/private',
    'https://localhost/private',
    'https://campaign.internal/private',
    'https://operator:secret@example.com/private',
  ]) {
    const plan = buildManagedCampaignPublishingPlan({
      campaign: baseCampaign({ destination_config: { final_url: finalUrl } }),
      gateEvidence,
    });
    assert.equal(plan.readiness.ready, false, `${finalUrl} must block publishing`);
    assert.equal(plan.readiness.blockers.some((item) => item.code === 'final_url_invalid'), true);
  }
}

function testFutureExecutionGates() {
  const plan = buildManagedCampaignPublishingPlan({ campaign: baseCampaign(), gateEvidence });
  const denied = evaluateManagedCampaignExecutionGates({ plan, confirmation: { plan_hash: plan.plan_hash } });
  assert.equal(denied.allowed, false);
  assert.equal(denied.provider_call_performed, false);
  assert.equal(denied.failures.some((item) => item.code === 'actor_required'), true);
  assert.throws(
    () => assertManagedCampaignExecutionGates({ plan, confirmation: {} }),
    (error) => error?.code === 'MANAGED_CAMPAIGN_EXECUTION_GATES_FAILED'
  );

  const authorized = assertManagedCampaignExecutionGates({ plan, confirmation: fullConfirmation(plan) });
  assert.equal(authorized.allowed, true);
  assert.equal(authorized.provider_call_performed, false);
  assert.equal(authorized.plan_hash, plan.plan_hash);
}

function testNoProviderIntegration() {
  const source = fs.readFileSync(
    path.resolve(__dirname, '../../services/managedCampaignPublishing.service.js'),
    'utf8'
  );
  assert.doesNotMatch(source, /googleAdsRequest|metaGet|axios|fetch\s*\(|\.mutate\s*\(|uploadClickConversion/);
  assert.doesNotMatch(source, /process\.env/);
}

function sourceSection(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0 && end > start, `Missing source section ${startMarker}`);
  return source.slice(start, end);
}

function testAdminDryRunApiContract() {
  const controllerSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/adminManagedCampaigns.controller.js'),
    'utf8'
  );
  const routeSource = fs.readFileSync(
    path.resolve(__dirname, '../../routes/adminManagedCampaigns.routes.js'),
    'utf8'
  );
  const migrationSource = fs.readFileSync(
    path.resolve(__dirname, '../../../migrations/20260711016000-create-managed-campaign-publishing-audits.js'),
    'utf8'
  );

  assert.match(routeSource, /router\.get\('\/:id\/publishing-plan', controller\.getPublishingPlan\)/);
  assert.match(routeSource, /router\.post\('\/:id\/publishing-dry-run', controller\.createPublishingDryRun\)/);
  assert.match(routeSource, /router\.get\('\/:id\/publishing-audits', controller\.listPublishingAudits\)/);
  assert.doesNotMatch(routeSource, /publishing-execute|\/execute|executePublishing/,
    'No provider execution route may exist in the dry-run phase');

  const readPlan = sourceSection(controllerSource, 'exports.getPublishingPlan', 'exports.createPublishingDryRun');
  const persistDryRun = sourceSection(controllerSource, 'exports.createPublishingDryRun', 'exports.listPublishingAudits');
  const listAudits = sourceSection(controllerSource, 'exports.listPublishingAudits', 'exports.createCampaign');
  assert.match(readPlan, /assertOperator\(req, res\)/);
  assert.doesNotMatch(readPlan, /ManagedCampaignPublishingAudit\.create/,
    'GET publishing-plan must remain read-only');
  assert.match(readPlan, /audit_persisted:\s*false/);
  assert.match(readPlan, /external_mutation_performed:\s*false/);

  assert.match(persistDryRun, /assertOperator\(req, res\)/);
  assert.match(persistDryRun, /req\.body\?\.confirm_dry_run !== true/);
  assert.match(persistDryRun, /idempotency_key_required/);
  assert.match(persistDryRun, /expected_plan_hash_required/);
  assert.match(persistDryRun, /plan\.plan_hash !== expectedPlanHash/);
  assert.match(persistDryRun, /publishing_plan_changed/);
  assert.match(persistDryRun, /ManagedCampaignPublishingAudit\.create/);
  assert.match(persistDryRun, /provider_call_performed:\s*false/);
  assert.match(persistDryRun, /execute_available:\s*false/);
  assert.doesNotMatch(persistDryRun, /googleAdsRequest|metaGet|axios|fetch\s*\(/);

  assert.match(listAudits, /assertOperator\(req, res\)/);
  assert.match(listAudits, /dry_run_only:\s*true/);
  assert.match(migrationSource, /fields:\s*\['managed_campaign_id', 'idempotency_key'\]/);
  assert.match(migrationSource, /provider_call_performed:[\s\S]*defaultValue:\s*false/);
  assert.match(migrationSource, /plan_snapshot:[\s\S]*Sequelize\.JSON/);
}

function run() {
  testDeterministicGoogleSearchPlan();
  testNoInventedAssetsAndUnsupportedFamily();
  testOtherSupportedFamilies();
  testStructuredValuesCannotMasqueradeAsProviderAssets();
  testPrivateDestinationsCannotEnterPublishingPlans();
  testFutureExecutionGates();
  testNoProviderIntegration();
  testAdminDryRunApiContract();
  console.log('managed_campaign_publishing.test.js OK');
}

try {
  run();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
