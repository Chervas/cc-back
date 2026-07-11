'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  REQUIRED_EXECUTION_CONFIRMATIONS,
  assertManagedCampaignExecutionGates,
  buildManagedCampaignPublishingPlan: buildManagedCampaignPublishingPlanWithoutAuthorization,
  evaluateManagedCampaignExecutionGates,
  managedCampaignPublishingAccountScopeInput,
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

function authorizedAccountScope(campaign) {
  const input = managedCampaignPublishingAccountScopeInput(campaign);
  if (!input.provider || !input.accountId) return null;
  return {
    scope: {
      group_id: input.groupId,
      clinic_id: input.clinicId,
    },
    account: {
      provider: input.provider,
      account_id: String(input.accountId).replace(/[^0-9]/g, ''),
      assignment_origin: input.clinicId ? 'clinic' : 'group',
      authorization_status: 'active',
      selectable: true,
    },
  };
}

function buildManagedCampaignPublishingPlan(input = {}) {
  return buildManagedCampaignPublishingPlanWithoutAuthorization({
    ...input,
    accountAuthorization: authorizedAccountScope(input.campaign),
  });
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

function directMetaSpecification(family = 'meta_reach', overrides = {}) {
  return {
    provider: 'meta_ads',
    family,
    operation: 'create_new',
    existing_campaign_id: null,
    account_id: 'act_123456789',
    name: 'Captación Meta Badalona',
    objective_id: 'new_patients',
    provider_objective: family === 'meta_instant_form' ? 'OUTCOME_LEADS' : 'OUTCOME_AWARENESS',
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
    targeting: { geo_locations: { cities: ['Badalona'] } },
    audience: { eligibility_status: 'ready' },
    schedule: { start_date: '2026-08-01', end_date: '2026-08-31' },
    destination: family === 'meta_instant_form'
      ? { instant_form_id: '7890123' }
      : { final_url: 'https://example.test/meta' },
    identity: { page_id: '456789', instagram_actor_id: '987654' },
    compliance: { dsa_beneficiary: 'Clínica Propdental', dsa_payor: 'ClinicaClick SL' },
    instant_form_id: family === 'meta_instant_form' ? '7890123' : null,
    tracking: {
      status: 'ready',
      conversion_actions_ready: true,
      pixel_id: '1234567890',
    },
    creative: {
      primary_texts: ['Cuida tu sonrisa'],
      headlines: ['Clínica dental en Badalona'],
      descriptions: ['Pide una valoración personalizada.'],
      media: ['asset:image:meta-1'],
      call_to_action: 'LEARN_MORE',
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

function testPublishingAccountScopeAuthorization() {
  const campaign = baseCampaign();
  const unverified = buildManagedCampaignPublishingPlanWithoutAuthorization({ campaign, gateEvidence });
  assert.equal(unverified.readiness.ready, false);
  assert.equal(
    unverified.readiness.blockers.some((item) => item.code === 'provider_account_scope_forbidden'),
    true,
    'An account reference without server-side scope evidence must fail closed',
  );

  const wrongClinic = buildManagedCampaignPublishingPlanWithoutAuthorization({
    campaign,
    gateEvidence,
    accountAuthorization: {
      ...authorizedAccountScope(campaign),
      scope: { group_id: 5, clinic_id: 999 },
    },
  });
  assert.equal(
    wrongClinic.readiness.blockers.some((item) => item.code === 'provider_account_scope_forbidden'),
    true,
    'Authorization for another clinic in the group must be rejected',
  );

  const revoked = buildManagedCampaignPublishingPlanWithoutAuthorization({
    campaign,
    gateEvidence,
    accountAuthorization: {
      ...authorizedAccountScope(campaign),
      account: {
        ...authorizedAccountScope(campaign).account,
        authorization_status: 'reauthorization_required',
        selectable: false,
      },
    },
  });
  assert.equal(
    revoked.readiness.blockers.some((item) => item.code === 'provider_account_scope_forbidden'),
    true,
    'A stale provider authorization must be rejected',
  );

  const authorized = buildManagedCampaignPublishingPlan({ campaign, gateEvidence });
  assert.equal(authorized.readiness.ready, true);
  assert.notEqual(unverified.plan_hash, authorized.plan_hash,
    'Scope authorization must be part of the deterministic readiness hash');
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
    audience_config: { eligibility_status: 'ready' },
    platform_refs: { ad_account_id: 'act_123', page_id: '456' },
    schedule_config: { start_date: '2026-08-01', end_date: '2026-08-31' },
    policy_readiness: {
      status: 'ready',
      dsa_beneficiary: 'Clínica Propdental',
      dsa_payor: 'ClinicaClick SL',
    },
    creative_config: {
      assets_ready: true,
      primary_text: 'Cuida tu sonrisa',
      headline: 'Clínica dental en Badalona',
      media: ['asset:image:meta-1'],
      call_to_action: 'LEARN_MORE',
    },
  });
  const reach = buildManagedCampaignPublishingPlan({ campaign: metaBase, gateEvidence });
  const repeatedReach = buildManagedCampaignPublishingPlan({ campaign: { ...metaBase }, gateEvidence: { ...gateEvidence } });
  assert.equal(reach.readiness.ready, true);
  assert.equal(reach.plan_hash, repeatedReach.plan_hash);
  assert.equal(reach.specification.provider_objective, 'OUTCOME_AWARENESS');
  assert.equal(reach.execution.dry_run_adapter_available, true);
  assert.equal(reach.execution.execution_adapter_available, false);
  assert.equal(reach.dry_run_adapter.operations.length, 5);
  assert.equal(reach.dry_run_adapter.operations[0].resource_type, 'Campaign');
  assert.equal(reach.dry_run_adapter.operations[0].payload_preview.status, 'PAUSED');
  assert.equal(reach.dry_run_adapter.operations[1].payload_preview.status, 'PAUSED');
  assert.equal(reach.dry_run_adapter.operations[3].payload_preview.published, false);
  assert.equal(reach.dry_run_adapter.operations[4].payload_preview.status, 'PAUSED');
  assert.equal(reach.dry_run_adapter.network_calls_performed, 0);
  assert.equal(reach.dry_run_adapter.provider_call_performed, false);
  assert.match(JSON.stringify(reach), /managed-meta-ads-dry-run-adapter\/v1/);

  const overlongMeta = buildManagedCampaignPublishingPlan({
    campaign: {
      ...metaBase,
      creative_config: {
        assets_ready: true,
        primary_text: 'p'.repeat(2201),
        headline: 'Clínica dental en Badalona',
        media: ['m'.repeat(2049)],
        call_to_action: 'A'.repeat(65),
      },
    },
    gateEvidence,
  });
  const overlongMetaCodes = new Set(overlongMeta.readiness.blockers.map((item) => item.code));
  assert.equal(overlongMeta.readiness.ready, false);
  assert.equal(overlongMetaCodes.has('adapter_meta_primary_texts_too_long'), true);
  assert.equal(overlongMetaCodes.has('adapter_meta_media_too_long'), true);
  assert.equal(overlongMetaCodes.has('adapter_meta_media_required'), true);
  assert.equal(overlongMetaCodes.has('adapter_meta_cta_invalid'), true);

  const signedMetaPlan = buildManagedCampaignPublishingPlan({
    campaign: {
      ...metaBase,
      destination_config: { final_url: 'https://example.com/?access_token=PLAN_URL_SECRET' },
      creative_config: {
        ...metaBase.creative_config,
        media: ['https://blob.example.com/a?X-Amz-Signature=PLAN_MEDIA_SECRET'],
        appsecret_proof: 'PLAN_PROOF_SECRET',
        signed_request: 'PLAN_SIGNED_SECRET',
      },
    },
    gateEvidence,
  });
  assert.equal(signedMetaPlan.readiness.ready, false);
  assert.equal(signedMetaPlan.readiness.blockers.some((item) => item.code === 'meta_sensitive_url_forbidden'), true);
  assert.doesNotMatch(
    JSON.stringify(signedMetaPlan),
    /PLAN_URL_SECRET|PLAN_MEDIA_SECRET|PLAN_PROOF_SECRET|PLAN_SIGNED_SECRET|appsecret_proof|signed_request/,
  );

  const metaDestinationConflict = buildManagedCampaignPublishingPlan({
    campaign: {
      ...metaBase,
      destination_config: {
        final_url: 'https://example.test/trusted',
        url: 'https://example.test/other',
      },
    },
    gateEvidence,
  });
  assert.equal(metaDestinationConflict.readiness.ready, false);
  assert.equal(metaDestinationConflict.readiness.blockers.some((item) => item.code === 'meta_destination_alias_conflict'), true);

  const landingUrlOnly = buildManagedCampaignPublishingPlan({
    campaign: { ...metaBase, destination_config: { landing_url: 'https://example.test/landing' } },
    gateEvidence,
  });
  assert.equal(landingUrlOnly.readiness.ready, true);
  assert.equal(landingUrlOnly.specification.destination.final_url, 'https://example.test/landing');

  const platformAliasConflict = buildManagedCampaignPublishingPlan({
    campaign: {
      ...metaBase,
      platform_refs: {
        ad_account_id: 'act_111',
        page_id: '444',
        pixel_id: '555',
        meta_ads: { ad_account_id: 'act_222', page_id: '333', pixel_id: '666' },
      },
    },
    gateEvidence,
  });
  const platformAliasCodes = new Set(platformAliasConflict.readiness.blockers.map((item) => item.code));
  assert.equal(platformAliasConflict.readiness.ready, false);
  assert.equal(platformAliasCodes.has('meta_account_alias_conflict'), true);
  assert.equal(platformAliasCodes.has('meta_page_alias_conflict'), true);
  assert.equal(platformAliasCodes.has('meta_pixel_alias_conflict'), true);
  assert.equal(platformAliasConflict.specification.account_id, 'act_111');
  assert.equal(platformAliasConflict.specification.identity.page_id, '444');

  const creativeAliasConflict = buildManagedCampaignPublishingPlan({
    campaign: {
      ...metaBase,
      creative_config: {
        assets_ready: true,
        primary_texts: ['Texto revisado'],
        primary_text: 'Texto distinto',
        headlines: ['Titular revisado'],
        headline: 'Titular distinto',
        descriptions: ['Descripción revisada'],
        description: 'Descripción distinta',
        media: ['asset:image:meta-1'],
        image_hashes: ['abcdefabcdefabcdefabcdefabcdefab'],
        call_to_action: 'LEARN_MORE',
        cta_type: 'GET_QUOTE',
      },
    },
    gateEvidence,
  });
  const creativeAliasCodes = new Set(creativeAliasConflict.readiness.blockers.map((item) => item.code));
  assert.equal(creativeAliasConflict.readiness.ready, false);
  assert.equal(creativeAliasCodes.has('meta_primary_text_alias_conflict'), true);
  assert.equal(creativeAliasCodes.has('meta_headline_alias_conflict'), true);
  assert.equal(creativeAliasCodes.has('meta_description_alias_conflict'), true);
  assert.equal(creativeAliasCodes.has('meta_media_alias_conflict'), true);
  assert.equal(creativeAliasCodes.has('meta_cta_alias_conflict'), true);

  const instant = buildManagedCampaignPublishingPlan({
    campaign: {
      ...metaBase,
      family: 'meta_instant_form',
      destination_config: { instant_form_id: '789' },
    },
    gateEvidence,
  });
  assert.equal(instant.readiness.ready, true);
  assert.equal(instant.execution.dry_run_adapter_available, true);
  assert.equal(instant.dry_run_adapter.operations.length, 5);
  assert.equal(instant.dry_run_adapter.operations[1].payload_preview.optimization_goal, 'LEAD_GENERATION');
  assert.equal(instant.dry_run_adapter.operations[3].payload_preview.instant_form_id, '789');
  assert.equal(instant.specification.instant_form_id, '789');
  assert.equal(instant.specification.provider_objective, 'OUTCOME_LEADS');
  const instantAuthorization = evaluateManagedCampaignExecutionGates({
    plan: instant,
    confirmation: fullConfirmation(instant),
  });
  assert.equal(instantAuthorization.allowed, false);
  assert.equal(instantAuthorization.failures.some((item) => item.code === 'execution_adapter_unavailable'), true);
  assert.equal(instantAuthorization.failures.some((item) => item.code === 'dry_run_manifest_invalid'), false);
}

function testDryRunAdapterRegistry() {
  assert.equal(hasManagedCampaignDryRunAdapter('google_ads', 'google_search'), true);
  assert.equal(hasManagedCampaignDryRunAdapter('google_ads', 'google_pmax'), true);
  assert.equal(hasManagedCampaignDryRunAdapter('meta_ads', 'meta_reach'), true);
  assert.equal(hasManagedCampaignDryRunAdapter('meta_ads', 'meta_instant_form'), true);
  assert.equal(hasManagedCampaignDryRunAdapter('meta_ads', 'meta_catalog_sales'), false);
  assert.equal(hasManagedCampaignDryRunAdapter('META_ADS', 'meta_reach'), false);
  assert.equal(hasManagedCampaignDryRunAdapter('meta_ads', 'meta_reach_preview'), false);

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
    family: 'meta_catalog_sales',
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

function testMetaDryRunAdapterSafetyAndValidation() {
  const reachSpecification = directMetaSpecification('meta_reach');
  reachSpecification.access_token = 'must-never-leak';
  reachSpecification.creative.clientSecret = 'also-hidden';
  const reach = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: reachSpecification,
  });
  const repeated = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach'),
  });
  assert.equal(reach.readiness.ready, true);
  assert.equal(reach.account_id, 'act_123456789');
  assert.equal(reach.operations.length, 5);
  assert.deepEqual(reach.operations.map((item) => item.order), [1, 2, 3, 4, 5]);
  assert.deepEqual(reach.operations.map((item) => item.resource_type), [
    'Campaign', 'AdSet', 'AdCreativeAsset', 'AdCreative', 'Ad',
  ]);
  assert.deepEqual(reach.operations[2].payload_preview.media_references, [{
    reference: 'asset:image:meta-1',
    asset_type: 'IMAGE',
    resolution_source: 'INTERNAL_ASSET',
  }]);
  assert.equal(reach.operations.every((item) => item.provider_call_performed === false), true);
  assert.equal(reach.operations[0].payload_preview.status, 'PAUSED');
  assert.equal(reach.operations[1].payload_preview.status, 'PAUSED');
  assert.equal(reach.budget.planning_daily_amount_minor_units, 1480);
  assert.equal(reach.operations[1].payload_preview.lifetime_budget_minor_units, 45000);
  assert.equal(reach.safety.maximum_planned_spend_minor_units, 45000);
  assert.equal(reach.operations[1].payload_preview.start_time, '2026-08-01T00:00:00.000Z');
  assert.equal(reach.operations[1].payload_preview.end_time, '2026-08-31T23:59:59.999Z');
  assert.equal(reach.operations[3].payload_preview.published, false);
  assert.equal(reach.operations[4].payload_preview.status, 'PAUSED');
  assert.equal(reach.provider_call_performed, false);
  assert.equal(reach.network_calls_performed, 0);
  assert.equal(reach.execution_adapter_available, false);
  assert.equal(reach.safety.provider_objects_created, false);
  assert.equal(reach.safety.generated_assets_allowed, false);
  assert.equal(reach.safety.destructive_replace, false);
  assert.equal(reach.manifest_hash, repeated.manifest_hash);
  assert.equal(reach.idempotency.fingerprint, repeated.idempotency.fingerprint);
  assert.equal(reach.idempotency.persisted_audit_key_required, true);
  assert.equal(reach.idempotency.provider_request_id_generated, false);
  const serializedReach = JSON.stringify(reach);
  assert.doesNotMatch(serializedReach, /must-never-leak|also-hidden|access_token|clientSecret/);

  const exactMinorUnits = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach', {
      budget: {
        approved_client_gross_amount: 100.30,
        funded_client_gross_amount: 100.30,
        commission_amount: 10.01,
        media_budget_total: 90.29,
        media_budget_available: 90.29,
        approved_media_budget_cap: 90.29,
        provider_media_budget_amount: 90.29,
        currency: 'EUR',
        period: 'monthly',
      },
    }),
  });
  assert.equal(exactMinorUnits.readiness.ready, true);
  assert.equal(exactMinorUnits.operations[1].payload_preview.lifetime_budget_minor_units, 9029);

  const changedCreative = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach', {
      creative: {
        ...directMetaSpecification('meta_reach').creative,
        primary_texts: ['Una creatividad diferente'],
      },
    }),
  });
  assert.notEqual(changedCreative.manifest_hash, reach.manifest_hash);
  assert.notEqual(changedCreative.idempotency.fingerprint, reach.idempotency.fingerprint);

  const instant = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_instant_form',
    specification: directMetaSpecification('meta_instant_form'),
  });
  assert.equal(instant.readiness.ready, true);
  assert.equal(instant.operations[1].payload_preview.destination_type, 'ON_AD');
  assert.equal(instant.operations[1].payload_preview.optimization_goal, 'LEAD_GENERATION');
  assert.equal(instant.operations[3].payload_preview.instant_form_id, '7890123');
  assert.equal(instant.operations[3].payload_preview.tracking.measurement_mode, 'instant_form_native_lead');
  assert.equal(instant.readiness.warnings.some((item) => item.code === 'adapter_meta_instant_form_not_verified'), true);
  assert.equal(instant.readiness.warnings.some((item) => item.code === 'adapter_meta_media_resolution_not_verified'), true);
  assert.equal(instant.readiness.warnings.some((item) => item.code === 'adapter_meta_pixel_not_verified'), true);

  const malformed = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_instant_form',
    specification: directMetaSpecification('meta_instant_form', {
      account_id: 'account-not-numeric',
      provider_objective: 'OUTCOME_AWARENESS',
      targeting: {},
      destination: { instant_form_id: {} },
      instant_form_id: {},
      identity: { page_id: {}, instagram_actor_id: 'invalid' },
      tracking: { status: 'pending', conversion_actions_ready: false, pixel_id: 'pixel-bad' },
      creative: {
        primary_texts: [{}],
        headlines: [],
        descriptions: [],
        media: [{}],
        call_to_action: 'learn-more',
      },
    }),
  });
  assert.equal(malformed.readiness.ready, false);
  const malformedCodes = new Set(malformed.readiness.blockers.map((item) => item.code));
  for (const expectedCode of [
    'adapter_meta_account_required',
    'adapter_meta_objective_invalid',
    'adapter_meta_page_required',
    'adapter_meta_instagram_actor_invalid',
    'adapter_meta_primary_texts_invalid',
    'adapter_meta_primary_texts_required',
    'adapter_meta_media_invalid',
    'adapter_meta_media_required',
    'adapter_meta_cta_invalid',
    'adapter_meta_cta_required',
    'adapter_meta_form_headline_required',
    'adapter_meta_instant_form_required',
    'adapter_meta_targeting_required',
    'adapter_meta_pixel_invalid',
    'adapter_meta_tracking_not_ready',
  ]) {
    assert.equal(malformedCodes.has(expectedCode), true, `missing blocker ${expectedCode}`);
  }
  assert.deepEqual(malformed.operations[2].payload_preview.media_references, []);
  assert.equal(malformed.operations[3].payload_preview.instant_form_id, null);
  assert.doesNotMatch(JSON.stringify(malformed), /\[object Object\]/);

  const privateDestination = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach', {
      destination: { final_url: 'https://operator:secret@127.0.0.1/private' },
    }),
  });
  assert.equal(privateDestination.readiness.ready, false);
  assert.equal(privateDestination.readiness.blockers.some((item) => item.code === 'adapter_meta_destination_invalid'), true);
  assert.equal(privateDestination.operations[3].payload_preview.destination_url, null);
  assert.doesNotMatch(JSON.stringify(privateDestination), /operator|secret|127\.0\.0\.1/);

  const directDestinationConflict = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach', {
      destination: {
        final_url: 'https://example.test/trusted',
        url: 'https://example.test/other',
      },
    }),
  });
  assert.equal(directDestinationConflict.readiness.ready, false);
  assert.equal(directDestinationConflict.readiness.blockers.some((item) => item.code === 'adapter_meta_destination_alias_conflict'), true);

  const directFormConflict = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_instant_form',
    specification: directMetaSpecification('meta_instant_form', {
      instant_form_id: '7890123',
      destination: { instant_form_id: '9999999' },
    }),
  });
  assert.equal(directFormConflict.readiness.ready, false);
  assert.equal(directFormConflict.readiness.blockers.some((item) => item.code === 'adapter_meta_instant_form_alias_conflict'), true);

  const signedArtifacts = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach', {
      destination: { final_url: 'https://example.com/?access_token=URL_SECRET&appsecret_proof=PROOF_SECRET' },
      creative: {
        ...directMetaSpecification('meta_reach').creative,
        media: ['https://blob.example.com/a?sig=AZURE_SECRET&key=API_SECRET'],
        appsecret_proof: 'NESTED_PROOF_SECRET',
        signed_request: 'SIGNED_REQUEST_SECRET',
      },
    }),
  });
  assert.equal(signedArtifacts.readiness.ready, false);
  assert.equal(signedArtifacts.readiness.blockers.some((item) => item.code === 'adapter_meta_sensitive_url_forbidden'), true);
  assert.equal(signedArtifacts.readiness.blockers.some((item) => item.code === 'adapter_meta_media_required'), true);
  assert.doesNotMatch(
    JSON.stringify(signedArtifacts),
    /URL_SECRET|PROOF_SECRET|AZURE_SECRET|API_SECRET|NESTED_PROOF_SECRET|SIGNED_REQUEST_SECRET|appsecret_proof|signed_request/,
  );
  for (const [unsafeUrl, leakedMarker] of [
    ['https://example.com/?redirect=https%3A%2F%2Fother.example%2F%3Faccess_token%3DNESTED_SECRET', 'NESTED_SECRET'],
    ['https://example.com/#access_token%3DFRAGMENT_SECRET', 'FRAGMENT_SECRET'],
    ['https://example.com/?utm_content=client_secret%3DVALUE_SECRET', 'VALUE_SECRET'],
    ['https://example.com/?AWSAccessKeyId=AWS_KEY_ONLY', 'AWS_KEY_ONLY'],
  ]) {
    const encodedSecret = buildManagedCampaignDryRunAdapter({
      provider: 'meta_ads',
      family: 'meta_reach',
      specification: directMetaSpecification('meta_reach', { destination: { final_url: unsafeUrl } }),
    });
    assert.equal(encodedSecret.readiness.ready, false, unsafeUrl);
    assert.equal(encodedSecret.readiness.blockers.some((item) => item.code === 'adapter_meta_sensitive_url_forbidden'), true);
    assert.equal(JSON.stringify(encodedSecret).includes(leakedMarker), false);
  }
  const safeTrackingQuery = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach', {
      destination: { final_url: 'https://example.com/landing?utm_source=meta&utm_campaign=implantes&utm_content=ahorro%2020%25' },
    }),
  });
  assert.equal(safeTrackingQuery.readiness.ready, true);
  const safePercentCopy = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach', {
      creative: {
        ...directMetaSpecification('meta_reach').creative,
        primary_texts: ['Ahorra un 20% en tu valoración inicial'],
      },
    }),
  });
  assert.equal(safePercentCopy.readiness.ready, true);
  assert.deepEqual(safePercentCopy.operations[3].payload_preview.primary_texts, ['Ahorra un 20% en tu valoración inicial']);

  const semanticallyInvalid = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach', {
      targeting: { nonsense: true },
      creative: {
        ...directMetaSpecification('meta_reach').creative,
        media: ['not-a-meta-asset'],
        call_to_action: 'NOT_A_REAL_META_CTA',
      },
    }),
  });
  const semanticCodes = new Set(semanticallyInvalid.readiness.blockers.map((item) => item.code));
  assert.equal(semanticallyInvalid.readiness.ready, false);
  assert.equal(semanticCodes.has('adapter_meta_geo_targeting_required'), true);
  assert.equal(semanticCodes.has('adapter_meta_media_reference_invalid'), true);
  assert.equal(semanticCodes.has('adapter_meta_media_required'), true);
  assert.equal(semanticCodes.has('adapter_meta_cta_invalid'), true);

  for (const invalidTargeting of [
    { geo: { latitude: 91, longitude: 181, radius_km: -1 } },
    { geo_locations: { countries: [123] } },
    { geo: { city: 42 } },
  ]) {
    const invalidGeo = buildManagedCampaignDryRunAdapter({
      provider: 'meta_ads',
      family: 'meta_reach',
      specification: directMetaSpecification('meta_reach', { targeting: invalidTargeting }),
    });
    assert.equal(invalidGeo.readiness.ready, false);
    assert.equal(invalidGeo.readiness.blockers.some((item) => item.code === 'adapter_meta_geo_targeting_invalid'), true);
    assert.deepEqual(invalidGeo.operations[1].payload_preview.targeting_review_snapshot, { geo: {} });
  }

  const ambiguousCreative = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach', {
      creative: {
        ...directMetaSpecification('meta_reach').creative,
        primary_texts: ['Texto uno', 'Texto dos'],
        headlines: ['Titular uno', 'Titular dos'],
        media: ['asset:image:meta-1', 'asset:image:meta-2'],
      },
    }),
  });
  const ambiguousCodes = new Set(ambiguousCreative.readiness.blockers.map((item) => item.code));
  assert.equal(ambiguousCreative.readiness.ready, false);
  assert.equal(ambiguousCodes.has('adapter_meta_primary_texts_too_many'), true);
  assert.equal(ambiguousCodes.has('adapter_meta_headlines_too_many'), true);
  assert.equal(ambiguousCodes.has('adapter_meta_media_too_many'), true);
  assert.equal(ambiguousCreative.operations[3].payload_preview.creative_format, 'SINGLE_MEDIA');
  assert.equal(ambiguousCreative.operations[3].payload_preview.variation_strategy, 'NONE');

  const unsupportedCurrency = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach', {
      budget: { ...directMetaSpecification('meta_reach').budget, currency: 'JPY' },
    }),
  });
  assert.equal(unsupportedCurrency.readiness.ready, false);
  assert.equal(unsupportedCurrency.readiness.blockers.some((item) => item.code === 'adapter_budget_currency_unsupported'), true);

  const unsupportedDailyBudget = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach', {
      budget: { ...directMetaSpecification('meta_reach').budget, period: 'daily' },
    }),
  });
  assert.equal(unsupportedDailyBudget.readiness.ready, false);
  assert.equal(unsupportedDailyBudget.readiness.blockers.some((item) => item.code === 'adapter_budget_period_unsupported'), true);

  const missingScheduleEnd = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach', {
      schedule: { start_date: '2026-08-01' },
    }),
  });
  assert.equal(missingScheduleEnd.readiness.ready, false);
  assert.equal(missingScheduleEnd.readiness.blockers.some((item) => item.code === 'adapter_meta_schedule_end_required'), true);

  const invalidCalendar = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach', {
      schedule: { start_date: '2026-02-01', end_date: '2026-02-31' },
    }),
  });
  assert.equal(invalidCalendar.readiness.ready, false);
  assert.equal(invalidCalendar.readiness.blockers.some((item) => item.code === 'adapter_meta_schedule_end_invalid'), true);

  for (const [schedule, expectedCode] of [
    [{ start_date: '2026-08-01', end_date: '2026-08-02' }, 'adapter_meta_schedule_monthly_window_invalid'],
    [{ start_date: '2026-08-01', end_date: '2027-08-01' }, 'adapter_meta_schedule_monthly_window_invalid'],
    [{
      start_time: '2026-08-10T00:00:00Z',
      start_date: '2026-08-01',
      end_time: '2026-09-08T00:00:00Z',
      end_date: '2026-08-31',
    }, 'adapter_meta_schedule_start_alias_conflict'],
  ]) {
    const invalidWindow = buildManagedCampaignDryRunAdapter({
      provider: 'meta_ads',
      family: 'meta_reach',
      specification: directMetaSpecification('meta_reach', { schedule }),
    });
    assert.equal(invalidWindow.readiness.ready, false);
    assert.equal(invalidWindow.readiness.blockers.some((item) => item.code === expectedCode), true);
  }
  for (const schedule of [
    { start_date: '2027-02-01', end_date: '2027-02-28' },
    { start_date: '2028-02-01', end_date: '2028-02-29' },
  ]) {
    const februaryWindow = buildManagedCampaignDryRunAdapter({
      provider: 'meta_ads',
      family: 'meta_reach',
      specification: directMetaSpecification('meta_reach', { schedule }),
    });
    assert.equal(februaryWindow.readiness.ready, true, JSON.stringify(schedule));
  }

  const contradictoryTracking = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach', {
      tracking: { status: 'failed', conversion_actions_ready: true, pixel_id: '1234567890' },
    }),
  });
  assert.equal(contradictoryTracking.readiness.ready, false);
  assert.equal(contradictoryTracking.readiness.blockers.some((item) => item.code === 'adapter_meta_tracking_not_ready'), true);

  const pendingAudience = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach', {
      audience: { eligibility_status: 'warning', reasons: ['pending_internal_review'] },
    }),
  });
  assert.equal(pendingAudience.readiness.ready, false);
  assert.equal(pendingAudience.readiness.blockers.some((item) => item.code === 'adapter_meta_audience_not_ready'), true);
  assert.deepEqual(pendingAudience.operations[1].payload_preview.audience_review_snapshot, { eligibility_status: 'warning' });

  const missingDsa = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach', { compliance: {} }),
  });
  assert.equal(missingDsa.readiness.ready, false);
  assert.equal(missingDsa.readiness.blockers.some((item) => item.code === 'adapter_meta_dsa_beneficiary_required'), true);
  assert.equal(missingDsa.readiness.blockers.some((item) => item.code === 'adapter_meta_dsa_payor_required'), true);

  const update = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach', {
      operation: 'update_existing',
      existing_campaign_id: '23851234567890123',
    }),
  });
  assert.equal(update.readiness.ready, true);
  assert.equal(update.operations[0].action, 'resolve');
  assert.equal(update.operations[0].payload_preview.preserve_existing_status, true);
  assert.equal(Object.prototype.hasOwnProperty.call(update.operations[0].payload_preview, 'status'), false);
  assert.equal(update.operations[1].payload_preview.status, 'PAUSED');
  assert.equal(update.operations[4].payload_preview.status, 'PAUSED');
  assert.equal(update.safety.initial_campaign_status, null);
  assert.equal(update.safety.existing_campaign_status_preserved, true);

  const missingExistingId = buildManagedCampaignDryRunAdapter({
    provider: 'meta_ads',
    family: 'meta_reach',
    specification: directMetaSpecification('meta_reach', { operation: 'update_existing' }),
  });
  assert.equal(missingExistingId.readiness.ready, false);
  assert.equal(missingExistingId.readiness.blockers.some((item) => item.code === 'adapter_existing_campaign_id_required'), true);
  assert.deepEqual(missingExistingId.operations, []);
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

  const benignQuery = buildManagedCampaignPublishingPlan({
    campaign: baseCampaign({ destination_config: { final_url: 'https://example.test/implantes?lang=es' } }),
    gateEvidence,
  });
  assert.equal(benignQuery.readiness.ready, true);
  assert.match(benignQuery.specification.final_url, /\?lang=es$/);

  const secretQuery = buildManagedCampaignPublishingPlan({
    campaign: baseCampaign({ destination_config: { final_url: 'https://example.test/implantes?access_token=GOOGLE_URL_SECRET' } }),
    gateEvidence,
  });
  assert.equal(secretQuery.readiness.ready, false);
  assert.equal(secretQuery.readiness.blockers.some((item) => ['final_url_invalid', 'final_url_required'].includes(item.code)), true);
  assert.doesNotMatch(JSON.stringify(secretQuery), /GOOGLE_URL_SECRET|access_token/);
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
    ['../../services/managedCampaignMetaAdsDryRunAdapter.service.js', [
      'node:crypto',
      '../lib/safeHttpTarget',
    ]],
    ['../../services/managedCampaignProviderAdapterRegistry.service.js', [
      'node:crypto',
      './managedCampaignGoogleAdsDryRunAdapter.service',
      './managedCampaignMetaAdsDryRunAdapter.service',
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
  assert.match(routeSource, /Cache-Control['"],\s*['"]no-store/,
    'Authenticated admin GET/HEAD responses must opt out of browser and intermediary caches');
  assert.doesNotMatch(routeSource, /publishing-execute|\/execute|executePublishing/,
    'No provider execution route may exist in the dry-run phase');

  const readPlan = sourceSection(controllerSource, 'exports.getPublishingPlan', 'exports.createPublishingDryRun');
  const persistDryRun = sourceSection(controllerSource, 'exports.createPublishingDryRun', 'exports.listPublishingAudits');
  const listAudits = sourceSection(controllerSource, 'exports.listPublishingAudits', 'exports.createCampaign');
  assert.match(readPlan, /assertOperator\(req, res\)/);
  assert.match(readPlan, /managedCampaignPublishingAccountAuthorization\(row\)/);
  assert.match(readPlan, /accountAuthorization/);
  assert.doesNotMatch(readPlan, /ManagedCampaignPublishingAudit\.create/,
    'GET publishing-plan must remain read-only');
  assert.match(readPlan, /audit_persisted:\s*false/);
  assert.match(readPlan, /external_mutation_performed:\s*false/);

  assert.match(persistDryRun, /assertOperator\(req, res\)/);
  assert.match(persistDryRun, /managedCampaignPublishingAccountAuthorization\(row\)/);
  assert.match(persistDryRun, /accountAuthorization/);
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
  testPublishingAccountScopeAuthorization();
  testNoInventedAssetsAndUnsupportedFamily();
  testCommissionNeverEntersProviderBudget();
  testOtherSupportedFamilies();
  testDryRunAdapterRegistry();
  testDirectAdapterRejectsMalformedEffectivePayloads();
  testMetaDryRunAdapterSafetyAndValidation();
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
