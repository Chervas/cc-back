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
const {
  buildManagedCampaignDryRunAdapter,
  hasManagedCampaignDryRunAdapter,
} = require('../../services/managedCampaignProviderAdapterRegistry.service');

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
    funding: {
      client_gross_funded: 500,
      media_budget_net: 450,
      available_amount: 450,
      commission_amount: 50,
      currency: 'EUR',
      refreshToken: 'hidden',
    },
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

function directSearchSpecification(overrides = {}) {
  return {
    operation: 'create_new',
    existing_campaign_id: null,
    account_id: '5992356722',
    name: 'Implantes Badalona',
    budget: {
      approved_client_gross_amount: 500,
      funded_client_gross_amount: 500,
      commission_amount: 50,
      media_budget_total: 450,
      media_budget_available: 450,
      approved_media_budget_cap: 450,
      provider_media_budget_amount: 450,
      currency: 'EUR',
      period: 'monthly',
    },
    final_url: 'https://example.test/implantes',
    ad_group: { keywords: ['implantes dentales'] },
    creative: {
      headlines: ['Implantes dentales', 'Recupera tu sonrisa', 'Valoración personalizada'],
      descriptions: ['Equipo especializado.', 'Solicita una valoración.'],
    },
    ...overrides,
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
  assert.equal(first.execution.execution_adapter_available, false);
  assert.equal(first.execution.dry_run_adapter_available, true);
  assert.equal(first.execution.dry_run_operation_count, 5);
  assert.equal(first.execution.provider_call_performed, false);
  assert.equal(first.dry_run_adapter.readiness.ready, true);
  assert.equal(first.dry_run_adapter.provider_call_performed, false);
  assert.equal(first.dry_run_adapter.network_calls_performed, 0);
  assert.equal(first.dry_run_adapter.operations[0].resource_type, 'CampaignBudget');
  assert.equal(first.specification.budget.approved_client_gross_amount, 500);
  assert.equal(first.specification.budget.funded_client_gross_amount, 500);
  assert.equal(first.specification.budget.provider_media_budget_amount, 450);
  assert.equal(first.dry_run_adapter.budget.provider_media_budget_amount, 450);
  assert.equal(first.dry_run_adapter.operations[0].payload_preview.amount_micros, 14_802_631);
  assert.equal(first.dry_run_adapter.operations[1].payload_preview.status, 'PAUSED');
  assert.equal(first.dry_run_adapter.operations[4].resource_type, 'AdGroupAd');
  assert.equal(first.dry_run_adapter.manifest_hash, second.dry_run_adapter.manifest_hash);
  assert.equal(first.specification.provider_campaign_type, 'SEARCH');
  assert.deepEqual(first.specification.creative.headlines, baseCampaign().creative_config.headlines);
  assert.deepEqual(first.specification.ad_group.keywords, baseCampaign().target_config.keywords);

  const serialized = JSON.stringify(first);
  assert.doesNotMatch(serialized, /must-never-leak|secret-google-token|also-secret|hidden/);
  assert.doesNotMatch(serialized, /access_token|accessToken|refreshToken|clientSecret/);
  assert.match(serialized, /managed-google-ads-dry-run-adapter\/v1/);
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

function testCommissionNeverEntersProviderBudget() {
  const plan = buildManagedCampaignPublishingPlan({
    campaign: baseCampaign({
      budget_config: { amount: 500, currency: 'EUR', period: 'monthly' },
      funding: {
        client_gross_funded: 500,
        commission_amount: 50,
        media_budget_net: 450,
        available_amount: 300,
        currency: 'EUR',
      },
    }),
    gateEvidence,
  });
  assert.equal(plan.specification.budget.approved_client_gross_amount, 500);
  assert.equal(plan.specification.budget.funded_client_gross_amount, 500);
  assert.equal(plan.specification.budget.media_budget_total, 450);
  assert.equal(plan.specification.budget.media_budget_available, 300);
  assert.equal(plan.specification.budget.approved_media_budget_cap, 450);
  assert.equal(plan.specification.budget.provider_media_budget_amount, 300);
  assert.equal(plan.dry_run_adapter.budget.provider_media_budget_amount, 300);
  assert.equal(plan.dry_run_adapter.operations[0].payload_preview.amount_micros, 9_868_421);
  assert.equal(plan.dry_run_adapter.budget.planning_daily_amount * 30.4 <= 300, true);

  const missingNet = buildManagedCampaignPublishingPlan({
    campaign: baseCampaign({
      funding: { client_gross_funded: 500, available_amount: 450, currency: 'EUR' },
    }),
    gateEvidence,
  });
  assert.equal(missingNet.readiness.ready, false);
  assert.equal(missingNet.readiness.blockers.some((item) => item.code === 'media_budget_net_required'), true);
  assert.equal(missingNet.dry_run_adapter.operations[0].payload_preview.amount_micros, null);

  const inconsistent = buildManagedCampaignPublishingPlan({
    campaign: baseCampaign({
      funding: {
        client_gross_funded: 500,
        commission_amount: 50,
        media_budget_net: 490,
        available_amount: 490,
        currency: 'EUR',
      },
    }),
    gateEvidence,
  });
  assert.equal(inconsistent.readiness.ready, false);
  assert.equal(inconsistent.readiness.blockers.some((item) => item.code === 'funding_breakdown_inconsistent'), true);

  const oneCentInconsistent = buildManagedCampaignPublishingPlan({
    campaign: baseCampaign({
      funding: {
        client_gross_funded: 500,
        commission_amount: 50,
        media_budget_net: 450.01,
        available_amount: 450.01,
        currency: 'EUR',
      },
    }),
    gateEvidence,
  });
  assert.equal(oneCentInconsistent.readiness.ready, false);
  assert.equal(oneCentInconsistent.readiness.blockers.some((item) => item.code === 'funding_breakdown_inconsistent'), true);

  const corruptAvailable = buildManagedCampaignPublishingPlan({
    campaign: baseCampaign({
      funding: {
        client_gross_funded: 500,
        commission_amount: 50,
        media_budget_net: 450,
        available_amount: 600,
        currency: 'EUR',
      },
    }),
    gateEvidence,
  });
  assert.equal(corruptAvailable.readiness.ready, false);
  assert.equal(corruptAvailable.readiness.blockers.some((item) => item.code === 'available_media_exceeds_net'), true);

  const missingFundedGross = buildManagedCampaignPublishingPlan({
    campaign: baseCampaign({
      funding: { commission_amount: 50, media_budget_net: 450, available_amount: 450, currency: 'EUR' },
    }),
    gateEvidence,
  });
  assert.equal(missingFundedGross.readiness.ready, false);
  assert.equal(missingFundedGross.readiness.blockers.some((item) => item.code === 'funded_gross_required'), true);

  const nullCommission = buildManagedCampaignPublishingPlan({
    campaign: baseCampaign({
      funding: {
        client_gross_funded: 500,
        commission_amount: null,
        media_budget_net: 450,
        available_amount: 450,
        currency: 'EUR',
      },
    }),
    gateEvidence,
  });
  assert.equal(nullCommission.readiness.ready, false);
  assert.equal(nullCommission.readiness.blockers.some((item) => item.code === 'commission_snapshot_required'), true);

  const overfundedWallet = buildManagedCampaignPublishingPlan({
    campaign: baseCampaign({
      funding: {
        client_gross_funded: 1000,
        commission_amount: 100,
        media_budget_net: 900,
        available_amount: 900,
        currency: 'EUR',
      },
    }),
    gateEvidence,
  });
  assert.equal(overfundedWallet.readiness.ready, true);
  assert.equal(overfundedWallet.specification.budget.approved_media_budget_cap, 450);
  assert.equal(overfundedWallet.specification.budget.provider_media_budget_amount, 450);

  const underfunded = buildManagedCampaignPublishingPlan({
    campaign: baseCampaign({
      funding: {
        client_gross_funded: 400,
        commission_amount: 40,
        media_budget_net: 360,
        available_amount: 360,
        currency: 'EUR',
      },
    }),
    gateEvidence,
  });
  assert.equal(underfunded.readiness.ready, false);
  assert.equal(underfunded.readiness.blockers.some((item) => item.code === 'funding_below_approved_budget'), true);
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
  assert.equal(pmax.execution.dry_run_adapter_available, true);
  assert.equal(pmax.dry_run_adapter.operations.length, 5);
  assert.equal(pmax.dry_run_adapter.operations[3].resource_type, 'AssetGroup');

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
  assert.equal(reach.readiness.ready, false);
  assert.equal(reach.specification.provider_objective, 'OUTCOME_AWARENESS');
  assert.equal(reach.execution.dry_run_adapter_available, false);
  assert.equal(reach.readiness.blockers.some((item) => item.code === 'dry_run_adapter_unavailable'), true);
  assert.equal(reach.dry_run_adapter.operations.length, 0);

  const instant = buildManagedCampaignPublishingPlan({
    campaign: {
      ...metaBase,
      family: 'meta_instant_form',
      destination_config: { instant_form_id: '789' },
    },
    gateEvidence,
  });
  assert.equal(instant.readiness.ready, false);
  assert.equal(instant.readiness.blockers.some((item) => item.code === 'dry_run_adapter_unavailable'), true);
  assert.equal(instant.specification.instant_form_id, '789');
  assert.equal(instant.specification.provider_objective, 'OUTCOME_LEADS');
}

function testGoogleDryRunAdapterRegistry() {
  assert.equal(hasManagedCampaignDryRunAdapter('google_ads', 'google_search'), true);
  assert.equal(hasManagedCampaignDryRunAdapter('google_ads', 'google_pmax'), true);
  assert.equal(hasManagedCampaignDryRunAdapter('meta_ads', 'meta_reach'), false);

  const plan = buildManagedCampaignPublishingPlan({ campaign: baseCampaign(), gateEvidence });
  const direct = buildManagedCampaignDryRunAdapter({
    provider: plan.campaign.provider,
    family: plan.campaign.family,
    specification: plan.specification,
  });
  assert.equal(direct.manifest_hash, plan.dry_run_adapter.manifest_hash);
  assert.equal(direct.safety.initial_campaign_status, 'PAUSED');
  assert.equal(direct.safety.destructive_replace, false);
  assert.equal(direct.safety.requires_future_explicit_execution_authorization, true);
  assert.equal(direct.budget.divisor_days, 30.4);
  assert.equal(direct.operations.every((item) => item.provider_call_performed === false), true);

  const unsupported = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: plan.specification,
  });
  assert.equal(unsupported.dry_run_adapter_available, false);
  assert.equal(unsupported.execution_adapter_available, false);
  assert.equal(unsupported.readiness.ready, false);
  assert.equal(unsupported.operations.length, 0);
}

function testDirectAdapterRejectsMalformedEffectivePayloads() {
  const malformed = buildManagedCampaignDryRunAdapter({
    provider: 'google_ads',
    family: 'google_search',
    specification: directSearchSpecification({
      final_url: 'https://operator:must-not-leak@127.0.0.1/private',
      ad_group: { keywords: [{}] },
      creative: { headlines: [{}, {}, {}], descriptions: [{}, {}] },
    }),
  });
  assert.equal(malformed.readiness.ready, false);
  const malformedCodes = new Set(malformed.readiness.blockers.map((item) => item.code));
  assert.equal(malformedCodes.has('adapter_search_final_url_invalid'), true);
  assert.equal(malformedCodes.has('adapter_search_keywords_invalid'), true);
  assert.equal(malformedCodes.has('adapter_search_headlines_invalid'), true);
  assert.equal(malformedCodes.has('adapter_search_descriptions_invalid'), true);
  assert.equal(malformed.operations[3].payload_preview.criteria.length, 0);
  assert.equal(malformed.operations[4].payload_preview.headlines.length, 0);
  assert.deepEqual(malformed.operations[4].payload_preview.final_urls, []);
  assert.doesNotMatch(JSON.stringify(malformed), /operator|must-not-leak|127\.0\.0\.1/);

  const overLimits = buildManagedCampaignDryRunAdapter({
    provider: 'google_ads',
    family: 'google_search',
    specification: directSearchSpecification({
      ad_group: { keywords: ['k'.repeat(81)] },
      creative: {
        headlines: Array.from({ length: 16 }, (_, index) => `Titular ${index + 1}`),
        descriptions: ['Descripción uno', 'Descripción dos'],
      },
    }),
  });
  const overLimitCodes = new Set(overLimits.readiness.blockers.map((item) => item.code));
  assert.equal(overLimits.readiness.ready, false);
  assert.equal(overLimitCodes.has('adapter_search_keywords_too_long'), true);
  assert.equal(overLimitCodes.has('adapter_search_keywords_required'), true);
  assert.equal(overLimitCodes.has('adapter_search_headlines_too_many'), true);
  assert.equal(overLimits.operations[4].payload_preview.headlines.length, 15);

  const pmaxMalformed = buildManagedCampaignDryRunAdapter({
    provider: 'google_ads',
    family: 'google_pmax',
    specification: {
      operation: 'create_new',
      account_id: '5992356722',
      name: 'PMax Badalona',
      budget: {
        approved_client_gross_amount: 500,
        funded_client_gross_amount: 500,
        commission_amount: 50,
        media_budget_total: 450,
        media_budget_available: 450,
        approved_media_budget_cap: 450,
        provider_media_budget_amount: 450,
        currency: 'EUR',
        period: 'monthly',
      },
      final_urls: ['http://localhost/private'],
      asset_group: {
        headlines: ['Uno', 'Dos', 'Tres'],
        long_headlines: ['Tratamientos dentales personalizados'],
        descriptions: ['Descripción uno', 'Descripción dos'],
        images: [{}],
        logos: [{}],
      },
    },
  });
  const pmaxCodes = new Set(pmaxMalformed.readiness.blockers.map((item) => item.code));
  assert.equal(pmaxMalformed.readiness.ready, false);
  assert.equal(pmaxCodes.has('adapter_pmax_final_urls_invalid'), true);
  assert.equal(pmaxCodes.has('adapter_pmax_images_invalid'), true);
  assert.equal(pmaxCodes.has('adapter_pmax_logos_invalid'), true);
  assert.deepEqual(pmaxMalformed.operations[2].payload_preview.images, []);
  assert.deepEqual(pmaxMalformed.operations[3].payload_preview.final_urls, []);

  const zeroMicros = buildManagedCampaignDryRunAdapter({
    provider: 'google_ads',
    family: 'google_search',
    specification: directSearchSpecification({
      budget: {
        approved_client_gross_amount: 1,
        funded_client_gross_amount: 1,
        commission_amount: 0.9999999,
        media_budget_total: 0.0000001,
        media_budget_available: 0.0000001,
        approved_media_budget_cap: 0.0000001,
        provider_media_budget_amount: 0.0000001,
        currency: 'EUR',
        period: 'daily',
      },
    }),
  });
  assert.equal(zeroMicros.readiness.ready, false);
  assert.equal(zeroMicros.readiness.blockers.some((item) => item.code === 'adapter_budget_micros_invalid'), true);
  assert.equal(zeroMicros.budget.planning_daily_amount_micros, null);

  const coerciveNumbers = buildManagedCampaignDryRunAdapter({
    provider: 'google_ads',
    family: 'google_search',
    specification: directSearchSpecification({
      budget: {
        approved_client_gross_amount: true,
        funded_client_gross_amount: [1000],
        commission_amount: false,
        media_budget_total: '900',
        media_budget_available: '900',
        approved_media_budget_cap: '450',
        provider_media_budget_amount: '450',
        currency: 'EUR',
        period: 'monthly',
      },
    }),
  });
  assert.equal(coerciveNumbers.readiness.ready, false);
  const coerciveCodes = new Set(coerciveNumbers.readiness.blockers.map((item) => item.code));
  assert.equal(coerciveCodes.has('adapter_approved_gross_budget_required'), true);
  assert.equal(coerciveCodes.has('adapter_funded_gross_budget_required'), true);
  assert.equal(coerciveCodes.has('adapter_commission_snapshot_required'), true);
  assert.equal(coerciveNumbers.operations[0].payload_preview.amount_micros, null);

  const forgedCap = buildManagedCampaignDryRunAdapter({
    provider: 'google_ads',
    family: 'google_search',
    specification: directSearchSpecification({
      budget: {
        approved_client_gross_amount: 500,
        funded_client_gross_amount: 1000,
        commission_amount: 100,
        media_budget_total: 900,
        media_budget_available: 900,
        approved_media_budget_cap: 900,
        provider_media_budget_amount: 900,
        currency: 'EUR',
        period: 'monthly',
      },
    }),
  });
  assert.equal(forgedCap.readiness.ready, false);
  assert.equal(forgedCap.readiness.blockers.some((item) => item.code === 'adapter_approved_media_cap_inconsistent'), true);
  assert.equal(forgedCap.readiness.blockers.some((item) => item.code === 'adapter_provider_budget_exceeds_approved_cap'), true);
  assert.equal(forgedCap.budget.approved_media_budget_cap, 450);
  assert.equal(forgedCap.budget.provider_media_budget_amount, 450);
  assert.equal(forgedCap.operations[0].payload_preview.amount_micros, 14_802_631);
}

function testUpdateExistingAdapterSemantics() {
  const missingId = buildManagedCampaignDryRunAdapter({
    provider: 'google_ads',
    family: 'google_search',
    specification: directSearchSpecification({ operation: 'update_existing' }),
  });
  assert.equal(missingId.readiness.ready, false);
  assert.equal(missingId.readiness.blockers.some((item) => item.code === 'adapter_existing_campaign_id_required'), true);
  assert.deepEqual(missingId.operations, []);

  const invalidOperation = buildManagedCampaignDryRunAdapter({
    provider: 'google_ads',
    family: 'google_search',
    specification: directSearchSpecification({ operation: 'delete' }),
  });
  assert.equal(invalidOperation.readiness.ready, false);
  assert.equal(invalidOperation.operation_mode, null);
  assert.deepEqual(invalidOperation.operations, []);

  const update = buildManagedCampaignDryRunAdapter({
    provider: 'google_ads',
    family: 'google_search',
    specification: directSearchSpecification({ operation: 'update_existing', existing_campaign_id: '23967323261' }),
  });
  assert.equal(update.readiness.ready, true);
  assert.equal(update.operation_mode, 'update_existing');
  assert.equal(update.operations[0].action, 'resolve_campaign_budget_then_update');
  assert.equal(update.operations[0].payload_preview.selector.via_campaign_id, '23967323261');
  assert.equal(update.operations[1].action, 'update');
  assert.equal(Object.prototype.hasOwnProperty.call(update.operations[1].payload_preview, 'status'), false);
  assert.equal(update.operations[2].action, 'create');
  assert.equal(update.operations[4].action, 'create');
  assert.equal(update.safety.initial_campaign_status, null);
  assert.equal(update.safety.existing_campaign_status_preserved, true);
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

  const fullyConfirmed = evaluateManagedCampaignExecutionGates({ plan, confirmation: fullConfirmation(plan) });
  assert.equal(fullyConfirmed.allowed, false);
  assert.equal(fullyConfirmed.failures.some((item) => item.code === 'execution_adapter_unavailable'), true);
  assert.equal(fullyConfirmed.failures.some((item) => item.code === 'plan_hash_invalid'), false);
  assert.equal(fullyConfirmed.failures.some((item) => item.code === 'plan_id_invalid'), false);
  assert.equal(fullyConfirmed.failures.some((item) => item.code === 'dry_run_manifest_invalid'), false);
  assert.throws(
    () => assertManagedCampaignExecutionGates({ plan, confirmation: fullConfirmation(plan) }),
    (error) => error?.failures?.some((item) => item.code === 'execution_adapter_unavailable')
  );

  const tampered = JSON.parse(JSON.stringify(plan));
  tampered.dry_run_adapter.operations[0].payload_preview.amount_micros = 500_000_000;
  const tamperedResult = evaluateManagedCampaignExecutionGates({ plan: tampered, confirmation: fullConfirmation(tampered) });
  assert.equal(tamperedResult.allowed, false);
  assert.equal(tamperedResult.failures.some((item) => item.code === 'plan_hash_invalid'), true);
  assert.equal(tamperedResult.failures.some((item) => item.code === 'dry_run_manifest_invalid'), true);

  const renamed = JSON.parse(JSON.stringify(plan));
  renamed.plan_id = 'managed:forged:v1:0000000000000000';
  const renamedResult = evaluateManagedCampaignExecutionGates({ plan: renamed, confirmation: fullConfirmation(renamed) });
  assert.equal(renamedResult.allowed, false);
  assert.equal(renamedResult.failures.some((item) => item.code === 'plan_id_invalid'), true);

  const forged = JSON.parse(JSON.stringify(plan));
  forged.execution.execution_adapter_available = true;
  forged.execution.adapter_available = true;
  const forgedResult = evaluateManagedCampaignExecutionGates({ plan: forged, confirmation: fullConfirmation(forged) });
  assert.equal(forgedResult.allowed, false);
  assert.equal(forgedResult.failures.some((item) => item.code === 'plan_hash_invalid'), true);
  assert.equal(forgedResult.failures.some((item) => item.code === 'execution_adapter_unavailable'), true);
}

function testNoProviderIntegration() {
  const modules = new Map([
    ['../../services/managedCampaignPublishing.service.js', [
      'node:crypto',
      '../lib/safeHttpTarget',
      './managedCampaignProviderAdapterRegistry.service',
    ]],
    ['../../services/managedCampaignGoogleAdsDryRunAdapter.service.js', [
      'node:crypto',
      '../lib/safeHttpTarget',
    ]],
    ['../../services/managedCampaignProviderAdapterRegistry.service.js', [
      'node:crypto',
      './managedCampaignGoogleAdsDryRunAdapter.service',
    ]],
  ]);
  for (const [relativePath, allowedImports] of modules) {
    const source = fs.readFileSync(path.resolve(__dirname, relativePath), 'utf8');
    const requireCalls = Array.from(source.matchAll(/\brequire\s*\(([^)]*)\)/g));
    assert.equal(
      (source.match(/\brequire\b/g) || []).length,
      requireCalls.length,
      `${relativePath} contains a require form outside the static parser`,
    );
    const imports = requireCalls.map((match) => {
      const argument = match[1].trim();
      const literal = argument.match(/^(['"])([^'"]+)\1$/);
      assert.ok(literal, `${relativePath} must only use static string-literal require calls`);
      return literal[2];
    });
    assert.deepEqual(imports, allowedImports, `${relativePath} imports changed outside the reviewed allowlist`);
    assert.doesNotMatch(source, /\b(?:import|module\.require)\s*\(/);
    assert.doesNotMatch(source, /\b(?:googleAdsRequest|metaGet|axios|got|undici|uploadClickConversion)\b/);
    assert.doesNotMatch(source, /\b(?:fetch|XMLHttpRequest|WebSocket)\s*\(/);
    assert.doesNotMatch(source, /\b(?:http|https)\s*\.\s*(?:request|get)\s*\(/);
    assert.doesNotMatch(source, /\.mutate(?:All)?\s*\(/);
    assert.doesNotMatch(source, /\bprocess\s*\.\s*env\b/);
  }
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
  testCommissionNeverEntersProviderBudget();
  testOtherSupportedFamilies();
  testGoogleDryRunAdapterRegistry();
  testDirectAdapterRejectsMalformedEffectivePayloads();
  testUpdateExistingAdapterSemantics();
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
