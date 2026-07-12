'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Op } = require('sequelize');
const db = require('../../../models');
const adminController = require('../../controllers/adminManagedCampaigns.controller');
const clientController = require('../../controllers/managedCampaigns.controller');
const { paidChannelAllocations } = require('../../services/managedCampaignProvisioning.service');

async function testManagedCampaignReferences() {
  const validRequest = {
    id: 31,
    clinica_id: 58,
    campaign_id: 77,
    updated_at: '2026-07-11T00:00:00.000Z',
    solicitud: {
      kind: 'marketing_strategy',
      objective_id: 'new_patients',
      mode_snapshot: 'connect_only',
      status: 'active',
      promotion_type: 'generic',
      summary: { budget_monthly: 500 },
      measurement: { channel_native: { google_ads_conversions: true } },
      external_targets: [{
        kind: 'generic',
        campaigns: [{
          provider: 'google_ads',
          account_id: '1851215478',
          external_campaign_id: '21800484692',
          name: 'Badalona benchmark',
          status: 'ENABLED',
          metrics: { spend: 999999 },
        }],
      }],
    },
  };
  const validModel = {
    async findByPk(id) {
      return id === 31 ? validRequest : null;
    },
    async findAll(options) {
      return options.where.campaign_id === 77 && options.where.clinica_id === 58
        ? [validRequest]
        : [];
    },
  };

  const resolvedReferences = await clientController.__test.validateAutopilotReferences({
    clinicId: 58,
    campaignRequestId: 31,
    campaignRequestModel: validModel,
    benchmarkLoader: async ({ clinicId, campaignRefs }) => {
      assert.equal(clinicId, 58);
      assert.equal(campaignRefs.length, 1);
      return {
        period_start: '2026-06-12',
        period_end: '2026-07-11',
        days: 30,
        captured_at: '2026-07-11T00:00:00.000Z',
        currency: 'EUR',
        investment: 120,
        conversions: 10,
        cost_per_conversion: 12,
      };
    },
  });
  assert.equal(resolvedReferences.strategyCampaignId, 77);
  assert.equal(resolvedReferences.campaignRequestId, 31);
  assert.equal(resolvedReferences.transition.reviewTransition.benchmark_preserved, true);
  assert.equal(resolvedReferences.transition.reviewTransition.benchmark_campaign_count, 1);
  assert.equal(resolvedReferences.transition.budgetConfig.amount, 500);
  assert.deepEqual(resolvedReferences.transition.platformRefs.benchmark_external_campaigns, [{
    provider: 'google_ads',
    account_id: '1851215478',
    external_campaign_id: '21800484692',
    name: 'Badalona benchmark',
    status: 'ENABLED',
    target_kind: 'generic',
    treatment_id: null,
    destination: null,
  }]);
  assert.equal(resolvedReferences.transition.reviewTransition.benchmark_metrics.investment, 120);
  assert.equal(
    Object.prototype.hasOwnProperty.call(resolvedReferences.transition.platformRefs.benchmark_external_campaigns[0], 'metrics'),
    false,
    'Historic provider metrics must not be copied into the managed budget or benchmark refs'
  );

  const publicTransition = clientController.__test.publicCampaign({
    id: 'managed-public-test',
    objective_id: 'new_patients',
    clinica_id: 58,
    operation_mode: 'observe',
    provider: 'google_ads',
    family: 'google_smart_observe',
    status: 'draft',
    name: 'Piloto automático',
    target_config: { proposal_summary: 'Captación local', commission_amount: 99, internal_signed_url: 'secret-target' },
    budget_config: { amount: 500, currency: 'EUR', media_budget_net: 450, commission_amount: 50 },
    schedule_config: {},
    destination_config: { final_url: 'https://example.test/', internal_signed_url: 'secret-destination' },
    creative_config: {},
    tracking_plan: {},
    platform_refs: { benchmark_external_campaigns: [{ account_id: 'secret-account' }] },
    review_config: { transition: resolvedReferences.transition.reviewTransition },
    policy_readiness: { status: 'warning', internal_signed_url: 'secret-policy' },
    updated_at: '2026-07-11T00:00:00.000Z',
  });
  assert.equal(publicTransition.transition.benchmark.investment, 120);
  assert.equal(publicTransition.transition.benchmark.conversions, 10);
  assert.equal(Object.prototype.hasOwnProperty.call(publicTransition.transition, 'source_campaign_request_id'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(publicTransition, 'platform_refs'), false,
    'Client DTO must not expose provider account references');
  const serializedPublicTransition = JSON.stringify(publicTransition);
  assert.doesNotMatch(serializedPublicTransition, /commission_amount|media_budget_net|internal_signed_url|secret-/,
    'Client DTO nested configs must use explicit allowlists rather than leaking internal fields');

  const resolvedFromCampaignOnly = await clientController.__test.validateAutopilotReferences({
    clinicId: 58,
    strategyCampaignId: 77,
    campaignRequestModel: validModel,
  });
  assert.equal(resolvedFromCampaignOnly.campaignRequestId, 31,
    'Campaign-only upgrades must persist the canonical source request id');

  const numericSnapshot = await clientController.__test.loadBenchmarkMetricsSnapshot({
    clinicId: 58,
    campaignRefs: [
      { provider: 'google_ads', account_id: '185-121-5478', external_campaign_id: '21800484692' },
      { provider: 'meta_ads', account_id: '123', external_campaign_id: '456' },
    ],
    capturedAt: new Date('2026-07-11T12:00:00.000Z'),
    googleModel: {
      async findAll() {
        return [{ campaignId: '21800484692', impressions: 1000, clicks: 30, costMicros: 100500000, conversions: 5 }];
      },
    },
    metaInsightsModel: {
      async findAll(options) {
        assert.equal(options.where.level, 'ad');
        assert.equal(Object.prototype.hasOwnProperty.call(options.where, 'clinica_id'), false);
        return [
          { ad_account_id: 'act_123', entity_id: 'ad-1', impressions: 300, clicks: 10, spend: 30 },
          { ad_account_id: 'act_123', entity_id: 'ad-1', impressions: 200, clicks: 10, spend: 19.5 },
        ];
      },
    },
    metaEntityModel: {
      async findAll(options) {
        if (options.where.level === 'adset') {
          assert.ok(Array.isArray(options.where[Op.or]));
          return [{ ad_account_id: 'act_123', entity_id: 'adset-1', parent_id: '456' }];
        }
        if (options.where.level === 'ad') {
          assert.ok(Array.isArray(options.where[Op.or]));
          return [{ ad_account_id: 'act_123', entity_id: 'ad-1', parent_id: 'adset-1' }];
        }
        return [];
      },
    },
    metaActionsModel: {
      async findAll(options) {
        assert.equal(options.where.level, 'ad');
        assert.equal(Object.prototype.hasOwnProperty.call(options.where, 'clinica_id'), false,
          'Explicit frozen campaign refs, not nullable ad attribution, must scope Meta action rows');
        return [
          { ad_account_id: 'act_123', entity_id: 'ad-1', date: '2026-07-10', action_type: 'lead', value: 1 },
          { ad_account_id: 'act_123', entity_id: 'ad-1', date: '2026-07-10', action_type: 'lead', value: 1 },
          { ad_account_id: 'act_123', entity_id: 'ad-1', date: '2026-07-10', action_type: 'onsite_conversion.lead_grouped', value: 2 },
        ];
      },
    },
  });
  assert.deepEqual(numericSnapshot, {
    period_start: '2026-06-12',
    period_end: '2026-07-11',
    days: 30,
    captured_at: '2026-07-11T12:00:00.000Z',
    source: 'cached_provider_insights',
    currency: 'EUR',
    investment: 150,
    impressions: 1500,
    clicks: 50,
    conversions: 7,
    cost_per_conversion: 21.43,
    campaign_count: 2,
    campaigns_with_data: 2,
  });

  await assert.rejects(
    clientController.__test.validateAutopilotReferences({
      clinicId: 19,
      campaignRequestId: 31,
      campaignRequestModel: validModel,
    }),
    (error) => error?.code === 'managed_reference_scope_mismatch' && error?.httpStatus === 403
  );
  await assert.rejects(
    clientController.__test.validateAutopilotReferences({
      clinicId: 58,
      strategyCampaignId: 999,
      campaignRequestModel: validModel,
    }),
    (error) => error?.code === 'managed_reference_scope_mismatch'
  );

  const managedSourceModel = {
    async findByPk() { return null; },
    async findAll() {
      return [{
        ...validRequest,
        solicitud: { ...validRequest.solicitud, mode_snapshot: 'managed_service' },
      }];
    },
  };
  await assert.rejects(
    clientController.__test.validateAutopilotReferences({
      clinicId: 58,
      strategyCampaignId: 77,
      campaignRequestModel: managedSourceModel,
    }),
    (error) => error?.code === 'managed_reference_scope_mismatch'
  );

  const controllerSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/managedCampaigns.controller.js'),
    'utf8'
  );
  const requestStart = controllerSource.indexOf('exports.requestAutopilot');
  const requestEnd = controllerSource.indexOf('exports.approveClientProposal', requestStart);
  const requestSection = controllerSource.slice(requestStart, requestEnd);
  const clinicLock = requestSection.indexOf('lock: transaction.LOCK.UPDATE');
  const duplicateLookup = requestSection.indexOf('ManagedCampaign.findOne({');
  assert.ok(clinicLock >= 0 && clinicLock < duplicateLookup,
    'Autopilot idempotency must serialize on the clinic row before checking for an existing request');

  const adminControllerSource = fs.readFileSync(
    path.resolve(__dirname, '../../controllers/adminManagedCampaigns.controller.js'),
    'utf8'
  );
  const transitionStart = adminControllerSource.indexOf('exports.transitionCampaign');
  const transitionEnd = adminControllerSource.indexOf('exports.activateManagement', transitionStart);
  const transitionSection = adminControllerSource.slice(transitionStart, transitionEnd);
  assert.doesNotMatch(transitionSection, /(^|[^\w])CampaignRequest\.(?:find|update|create|destroy)/,
    'Managed lifecycle transitions must not rewrite the Connect-only benchmark request');
  assert.doesNotMatch(transitionSection, /(^|[^\w])Campaign\.update/,
    'Managed lifecycle transitions must not pause or complete the shared source campaign');
  assert.match(transitionSection, /ManagedCampaign is the lifecycle source of truth/,
    'The immutable source lifecycle boundary must remain explicit in the transition handler');

  const updateStart = adminControllerSource.indexOf('exports.updateCampaign');
  const updateEnd = adminControllerSource.indexOf('exports.transitionCampaign', updateStart);
  const updateSection = adminControllerSource.slice(updateStart, updateEnd);
  assert.match(updateSection, /ManagedCampaign\.update\(patch,[\s\S]*?where:\s*\{\s*id:\s*row\.id,\s*status:\s*row\.status,\s*version:\s*row\.version\s*\}/,
    'Admin edits must use compare-and-swap on status and version');
  assert.match(updateSection, /error:\s*'update_conflict'/,
    'Concurrent admin edits must return an explicit conflict');

  const activationStart = adminControllerSource.indexOf('exports.activateManagement');
  const activationEnd = adminControllerSource.indexOf('exports.recordTopup', activationStart);
  const activationSection = adminControllerSource.slice(activationStart, activationEnd);
  assert.match(activationSection, /ManagedCampaign\.update\([\s\S]*?where:\s*\{\s*id:\s*row\.id,\s*status:\s*'pending_admin_review',\s*version:\s*row\.version\s*\}/,
    'Management activation must use compare-and-swap on status and version');
  assert.doesNotMatch(activationSection, /row\.update\(/,
    'Management activation must not race through an instance update');

  const spendStart = adminControllerSource.indexOf('exports.recordSpend');
  const spendEnd = adminControllerSource.indexOf('exports.listMatchingProposals', spendStart);
  const spendSection = adminControllerSource.slice(spendStart, spendEnd);
  const fundingLock = spendSection.indexOf('lock: transaction.LOCK.UPDATE');
  const snapshotLookup = spendSection.indexOf('ManagedCampaignSpendSnapshot.findOne({');
  assert.match(spendSection, /db\.sequelize\.transaction\(async \(transaction\)/,
    'Spend snapshot, funding totals and ledger delta must be atomic');
  assert.ok(fundingLock >= 0 && fundingLock < snapshotLookup,
    'Spend updates must serialize on funding before reading the previous daily snapshot');
  assert.match(spendSection, /ManagedCampaignSpendSnapshot\.findOne\(\{[\s\S]*?lock: transaction\.LOCK\.UPDATE/,
    'The existing daily snapshot must be locked before deriving its delta');
  assert.match(spendSection, /ManagedCampaignSpendSnapshot\.sum\('spend_amount',[\s\S]*?transaction/,
    'Funding totals must be recomputed within the same transaction');
  assert.match(spendSection, /ManagedCampaignLedgerEntry\.create\([\s\S]*?\}, \{ transaction \}\)/,
    'The spend delta ledger entry must commit atomically with its snapshot');
}

async function run() {
  const commission = adminController.__test.commissionFor(100, 'percentage', 10);
  assert.deepEqual(commission, { type: 'percentage', value: 10, amount: 10 });

  const funding = {
    id: 'funding-test',
    currency: 'EUR',
    status: 'depleted',
    client_gross_funded: '100.00',
    commission_type: 'percentage',
    commission_value: '10.0000',
    commission_amount: '10.00',
    media_budget_net: '90.00',
    media_spend: '90.00',
    reserved_amount: '0.00',
    available_amount: '0.00',
    terms_version: 2,
  };
  const admin = adminController.__test.fundingAdminDto(funding);
  assert.equal(admin.client_gross_funded, 100);
  assert.equal(admin.commission_amount, 10);
  assert.equal(admin.media_budget_net, 90);
  assert.equal(admin.media_spend, 90);
  assert.equal(admin.provisional_margin, 10);
  assert.equal(admin.realised_margin, null);
  assert.equal(admin.margin_status, 'provisional_bank_costs_pending');

  const client = clientController.__test.publicFunding(funding, 2);
  assert.deepEqual(client, {
    currency: 'EUR',
    status: 'depleted',
    total_paid: 100,
    total_consumed: 100,
    available: 0,
    leads: 2,
    cpl: 50,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(client, 'commission_amount'), false);
  assert.equal(Object.prototype.hasOwnProperty.call(client, 'media_budget_net'), false);

  assert.equal(adminController.__test.hasVerifiedPrepaymentEntries([]), false);
  assert.equal(adminController.__test.hasVerifiedPrepaymentEntries([
    { metadata: { source: 'manual' } },
  ]), false);
  assert.equal(adminController.__test.hasVerifiedPrepaymentEntries([
    { metadata: { source: 'manual', payment_verified: true } },
  ]), true);

  assert.deepEqual(paidChannelAllocations([
    { channel: 'google_ads', enabled: true, percentage: 60 },
    { channel: 'meta_ads', enabled: true, percentage: 40 },
  ], 100), [
    { provider: 'google_ads', amount: 60 },
    { provider: 'meta_ads', amount: 40 },
  ]);
  assert.deepEqual(paidChannelAllocations([
    { channel: 'google_ads', enabled: true, percentage: 100 },
    { channel: 'email', enabled: true, percentage: 0 },
  ], 100), [{ provider: 'google_ads', amount: 100 }]);

  assert.deepEqual(adminController.__test.proposalReadiness({
    family: 'google_search',
    budget_config: { amount: 500 },
    target_config: { proposal_summary: 'Pacientes de Badalona interesados en implantología' },
    destination_config: { final_url: 'https://www.propdental.es/implantes/' },
    creative_config: { client_preview_url: 'https://preview.example.com/proposal' },
    review_config: { client_proposal_summary: 'Propuesta de captación local con anuncios de búsqueda y medición de contactos.' },
  }), { ready: true, blockers: [] });
  for (const unsafePreviewUrl of [
    'http://127.0.0.1/proposal',
    'https://localhost/proposal',
    'https://operator:secret@example.com/proposal',
    'http://preview.example.com/proposal',
  ]) {
    const unsafeProposal = adminController.__test.proposalReadiness({
      family: 'google_search',
      budget_config: { amount: 500 },
      target_config: { proposal_summary: 'Pacientes de Badalona interesados en implantología' },
      destination_config: { final_url: 'https://www.propdental.es/implantes/' },
      creative_config: { client_preview_url: unsafePreviewUrl },
      review_config: { client_proposal_summary: 'Propuesta de captación local con anuncios de búsqueda y medición de contactos.' },
    });
    assert.equal(unsafeProposal.ready, false, `${unsafePreviewUrl} must not be accepted as a client preview`);
  }
  assert.equal(adminController.__test.proposalReadiness({
    family: 'meta_instant_form',
    budget_config: { amount: 500 },
    target_config: { proposal_summary: {} },
    destination_config: { instant_form_id: {} },
    creative_config: { client_preview_url: {} },
    review_config: { client_proposal_summary: {} },
  }).ready, false, 'Structured values must not masquerade as proposal text, ids or URLs');
  const incompleteProposal = adminController.__test.proposalReadiness({
    family: 'google_smart_observe',
    budget_config: { amount: 0 },
  });
  assert.equal(incompleteProposal.ready, false);
  assert.ok(incompleteProposal.blockers.length >= 5);

  const protectedReview = adminController.__test.protectedReviewConfigPatch({
    client_approval_required: true,
    admin_approval_required: true,
    client_approved_at: '2026-07-11T00:00:00.000Z',
    client_approved_by_user_id: 88,
    proposal_revision: 4,
    transition: { benchmark_preserved: true },
  }, {
    client_approval_required: false,
    client_approved_at: 'forged',
    proposal_revision: 999,
    transition: { benchmark_preserved: false },
    client_proposal_summary: 'Nueva propuesta revisada',
  });
  assert.equal(protectedReview.client_approval_required, true);
  assert.equal(protectedReview.client_approved_at, '2026-07-11T00:00:00.000Z');
  assert.equal(protectedReview.proposal_revision, 4);
  assert.deepEqual(protectedReview.transition, { benchmark_preserved: true });
  assert.equal(protectedReview.client_proposal_summary, 'Nueva propuesta revisada');
  assert.deepEqual(adminController.__test.protectedPlatformRefsPatch({
    benchmark_external_campaigns: [{ external_campaign_id: 'benchmark-1' }],
  }, {
    benchmark_external_campaigns: [],
    customer_id: 'new-account',
  }), {
    benchmark_external_campaigns: [{ external_campaign_id: 'benchmark-1' }],
    customer_id: 'new-account',
  });

  assert.equal(clientController.__test.effectiveProposalRevision({}, 'pending_client_review'), 1,
    'Legacy proposals already sent to clients must remain approvable as revision 1');
  assert.equal(clientController.__test.effectiveProposalRevision({ proposal_revision: 4 }, 'pending_client_review'), 4);
  assert.equal(clientController.__test.publicCampaignName('Piloto Badalona (observación)'), 'Piloto Badalona');
  assert.equal(adminController.__test.managedCampaignDisplayName('Piloto Badalona (observación)'), 'Piloto Badalona');
  assert.equal(adminController.__test.managedCampaignDisplayName('Piloto Badalona (OBSERVACION)'), 'Piloto Badalona');

  await testManagedCampaignReferences();

  console.log('managed_campaign_finance.test.js OK');
}

run()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
