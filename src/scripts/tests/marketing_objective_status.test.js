'use strict';

const assert = require('node:assert/strict');
process.env.JOBS_AUTO_START = 'false';
process.env.RUNTIME_ROLE = 'gateway';

const {
  getMarketingObjectiveStatus,
  scoreGoogleMaps,
  scorePaidMedia,
  scoreReactivation,
  scoreSeoAi,
} = require('../../services/marketingObjectiveStatus.service');

function modelWith({ all = [], one = null } = {}) {
  return {
    async findAll() { return all; },
    async findOne() { return one; },
  };
}

function fullDependencies() {
  return {
    now: new Date('2026-08-23T12:00:00.000Z'),
    async resolveInventory() {
      return {
        google: {
          effective_assets: {
            account: { customer_id: '1234567890' },
            business_profile: { mapping_id: 7 },
            search_console: { mapping_id: 8 },
          },
          available_assets: {
            business_profile: [{
              mapping_id: 7,
              clinic_id: 66,
              assignment_origin: 'clinic',
              verified: true,
              suspended: false,
              sync_status: 'synced',
              last_synced_at: '2026-08-23T10:00:00.000Z',
            }],
            search_console: [{ mapping_id: 8, clinic_id: 66, verified: true }],
          },
        },
        meta: { effective_assets: { ad_account: null } },
      };
    },
    CampaignRequest: modelWith({
      all: [{
        id: 10,
        campaign_id: 20,
        estado: 'activa',
        updated_at: '2026-08-23T11:00:00.000Z',
        solicitud: {
          kind: 'marketing_strategy',
          objective_id: 'new_patients',
          status: 'active',
          activation_readiness: { ready: true, validated: true },
        },
      }],
    }),
    ExternalCampaignAssignment: modelWith({
      all: [{
        id: 11,
        status: 'active',
        strategy_campaign_id: 20,
        campaign_request_id: 10,
      }],
    }),
    ClinicBusinessLocation: modelWith({
      all: [{
        id: 7,
        clinica_id: 66,
        is_active: true,
        is_verified: true,
        is_suspended: false,
        sync_status: 'synced',
        last_synced_at: '2026-08-23T10:00:00.000Z',
        raw_payload: {},
      }],
    }),
    WebScDailyAgg: modelWith({ one: { clinica_id: 66, date: '2026-08-22' } }),
    WebScQueryDaily: modelWith({ one: null }),
    MarketingAiVisibilityRun: modelWith({
      one: {
        id: 90,
        clinica_id: 66,
        status: 'completed',
        completed_at: '2026-08-23T09:00:00.000Z',
        expires_at: '2026-08-24T09:00:00.000Z',
      },
    }),
    serializeLocation() {
      return {
        verified: true,
        suspended: false,
        syncStatus: 'synced',
        lastSyncedAt: '2026-08-23T10:00:00.000Z',
        websiteUri: 'https://clinic.example',
        phone: '+34123456789',
        address: { formatted: 'Calle Ejemplo 1' },
        primaryCategory: 'Clínica',
        newReviewUri: 'https://g.page/r/example/review',
      };
    },
    async getReviewAutomationStatus(scope) {
      assert.deepEqual(scope.clinicIds, [66]);
      return {
        clinic_id: 66,
        automation_enabled: true,
        automation_configured: true,
        configuration_errors: [],
      };
    },
    async getReactivationLists(scope) {
      assert.equal(scope.scope, 'clinic');
      return {
        success: true,
        items: [{
          id: 100,
          status: 'prepared',
          updated_at: '2026-08-23T10:00:00.000Z',
          criteria: { months_since_last_visit: 12 },
          action_mode: 'whatsapp_template',
          channel: 'whatsapp',
          template_id: 5,
          counters: { total: 20 },
          safety_gates: { frozen_audience: true, approved_template: true, audit: true },
          prepared_at: '2026-08-23T10:00:00.000Z',
          automation: { active: true },
        }],
      };
    },
  };
}

async function testCompletedEvidenceReachesOneHundredWithoutFutureFeatures() {
  const result = await getMarketingObjectiveStatus({
    scopeType: 'clinic',
    scopeId: 66,
    clinicIds: [66],
  }, fullDependencies());

  assert.equal(result.schema_version, 1);
  assert.equal(result.read_only, true);
  assert.equal(result.families.length, 3);

  const acquisition = result.families.find((family) => family.id === 'new_patients');
  assert.equal(acquisition.max_points, 100);
  assert.equal(acquisition.eligible_points, 65);
  assert.equal(acquisition.earned_points, 65);
  assert.equal(acquisition.score, 100);
  assert.equal(acquisition.subobjectives.find((item) => item.id === 'web').availability, 'unknown');
  assert.equal(acquisition.subobjectives.find((item) => item.id === 'web').eligible_points, 0);
  assert.equal(acquisition.subobjectives.find((item) => item.id === 'social_content_comments').availability, 'coming_soon');

  const reputation = result.families.find((family) => family.id === 'reputation');
  assert.equal(reputation.eligible_points, 35);
  assert.equal(reputation.score, 100);

  const profitability = result.families.find((family) => family.id === 'profitability');
  assert.equal(profitability.eligible_points, 25);
  assert.equal(profitability.score, 100);
  assert.equal(profitability.subobjectives.find((item) => item.id === 'reduce_no_shows').availability, 'unknown');
}

async function testMissingEvidenceProducesActionableStatesWithoutExternalCalls() {
  let inventoryCalls = 0;
  const deps = fullDependencies();
  deps.resolveInventory = async () => {
    inventoryCalls += 1;
    return {
      google: { effective_assets: {}, available_assets: { business_profile: [], search_console: [] } },
      meta: { effective_assets: {} },
    };
  };
  deps.CampaignRequest = modelWith({ all: [] });
  deps.ExternalCampaignAssignment = modelWith({ all: [] });
  deps.ClinicBusinessLocation = modelWith({ all: [] });
  deps.WebScDailyAgg = modelWith({ one: null });
  deps.WebScQueryDaily = modelWith({ one: null });
  deps.MarketingAiVisibilityRun = modelWith({ one: null });
  deps.getReviewAutomationStatus = async () => ({
    clinic_id: 66,
    automation_enabled: false,
    automation_configured: false,
    configuration_errors: [],
  });
  deps.getReactivationLists = async () => ({ success: true, items: [] });

  const result = await getMarketingObjectiveStatus({
    scopeType: 'clinic',
    scopeId: 66,
    clinicIds: [66],
  }, deps);
  assert.equal(inventoryCalls, 1, 'el endpoint debe resolver una única instantánea local');
  const acquisition = result.families.find((family) => family.id === 'new_patients');
  assert.equal(acquisition.score, 0);
  assert.equal(acquisition.status, 'needs_connection');
  assert.ok(acquisition.attention_count >= 3);
  assert.equal(result.families.find((family) => family.id === 'reputation').score, 0);
  assert.equal(result.families.find((family) => family.id === 'profitability').score, 0);
}

async function testGroupScopeDoesNotMixClinics() {
  const deps = fullDependencies();
  let inventoryCalls = 0;
  deps.resolveInventory = async () => {
    inventoryCalls += 1;
    return {};
  };
  const result = await getMarketingObjectiveStatus({
    scopeType: 'group',
    scopeId: 9,
    clinicIds: [66, 67],
  }, deps);
  assert.equal(inventoryCalls, 0);
  assert.equal(result.families.find((family) => family.id === 'new_patients').score, null);
}

function testPaidMediaDoesNotCombineDifferentStrategies() {
  const result = scorePaidMedia({
    inventory: { google: { effective_assets: { account: { customer_id: '123' } } } },
    campaignRequests: [
      {
        id: 1,
        campaign_id: 10,
        estado: 'borrador',
        updated_at: '2026-08-23T10:00:00Z',
        solicitud: { kind: 'marketing_strategy', objective_id: 'new_patients', activation_readiness: { ready: true, validated: true } },
      },
      {
        id: 2,
        campaign_id: 20,
        estado: 'activa',
        updated_at: '2026-08-23T11:00:00Z',
        solicitud: { kind: 'marketing_strategy', objective_id: 'new_patients', status: 'active' },
      },
    ],
    assignments: [{ status: 'active', strategy_campaign_id: 10, campaign_request_id: 1 }],
  });
  assert.ok(result.earned_points < result.eligible_points);
  assert.equal(result.evidence.linked_campaign_count, 1);
  assert.equal(result.evidence.measurement_ready_count, 1);
  assert.equal(result.evidence.active_strategy_count, 1);
}

function testPaidMediaReportsCampaignsAndMappedStrategiesSeparately() {
  const result = scorePaidMedia({
    inventory: { google: { effective_assets: { account: { customer_id: '123' } } } },
    campaignRequests: [{
      id: 1,
      campaign_id: 10,
      estado: 'activa',
      solicitud: {
        kind: 'marketing_strategy',
        objective_id: 'new_patients',
        status: 'active',
        activation_readiness: { ready: true, validated: true },
      },
    }],
    assignments: [
      { id: 100, status: 'active', strategy_campaign_id: 10, campaign_request_id: 1 },
      { id: 101, status: 'active', strategy_campaign_id: 10, campaign_request_id: 1 },
    ],
  });
  assert.equal(result.evidence.linked_campaign_count, 2);
}

function testSeoAiRequiresAUsableProviderAndFreshSearchData() {
  const common = {
    inventory: { google: { available_assets: { search_console: [{ mapping_id: 8, verified: true }] } } },
    latestSearchConsoleAggregate: { date: '2026-08-22' },
    latestSearchConsoleQuery: null,
    now: new Date('2026-08-23T12:00:00.000Z'),
  };
  const noProvider = scoreSeoAi({
    ...common,
    latestAiRun: {
      status: 'completed_with_errors',
      provider_status: { openai: { status: 'error' }, gemini: { status: 'not_configured' } },
    },
  });
  assert.equal(noProvider.earned_points, 10);
  assert.equal(noProvider.state, 'configuring');

  const partial = scoreSeoAi({
    ...common,
    latestAiRun: {
      status: 'completed_with_errors',
      provider_status: { openai: { status: 'completed' }, gemini: { status: 'error' } },
    },
  });
  assert.equal(partial.earned_points, 15);

  const staleSearch = scoreSeoAi({
    ...common,
    latestSearchConsoleAggregate: { date: '2026-06-01' },
    latestAiRun: { status: 'completed' },
  });
  assert.equal(staleSearch.earned_points, 10);
  assert.equal(staleSearch.state, 'collecting_data');
}

function testGoogleMapsRequiresRecentSynchronization() {
  const result = scoreGoogleMaps({
    assets: [{ mapping_id: 7 }],
    locations: [{ id: 7 }],
    serializeLocation: () => ({
      verified: true,
      suspended: false,
      syncStatus: 'synced',
      lastSyncedAt: '2026-06-01T00:00:00.000Z',
      websiteUri: 'https://clinic.example',
      phone: '+34123456789',
      address: { formatted: 'Calle Ejemplo 1' },
      primaryCategory: 'Clínica',
    }),
    now: new Date('2026-08-23T12:00:00.000Z'),
  });
  assert.equal(result.evidence.synced_count, 0);
  assert.equal(result.state, 'collecting_data');
  assert.ok(result.earned_points < result.eligible_points);
}

function testReactivationPrefersWorkingAutomationOverNewDraft() {
  const result = scoreReactivation({
    items: [
      { id: 2, status: 'draft', updated_at: '2026-08-23T12:00:00Z', criteria: {} },
      {
        id: 1,
        status: 'active',
        updated_at: '2026-08-22T12:00:00Z',
        criteria: { months_since_last_visit: 12 },
        action_mode: 'whatsapp_template',
        channel: 'whatsapp',
        template_id: 5,
        prepared_at: '2026-08-22T10:00:00Z',
        safety_gates: { frozen_audience: true, approved_template: true, audit: true },
        automation: { active: true },
      },
    ],
  });
  assert.equal(result.evidence.selected_list_id, 1);
  assert.equal(result.earned_points, result.eligible_points);
}

async function testReviewErrorsAreSanitizedAndReactivationReadIsBounded() {
  const deps = fullDependencies();
  let campaignRequestQuery = null;
  let assignmentQuery = null;
  deps.CampaignRequest = {
    async findAll(options) {
      campaignRequestQuery = options;
      return [];
    },
  };
  deps.ExternalCampaignAssignment = {
    async findAll(options) {
      assignmentQuery = options;
      return [];
    },
  };
  deps.getReviewAutomationStatus = async () => {
    throw new Error('SQL and connection details must not leave the backend');
  };
  delete deps.getReactivationLists;
  let reactivationQuery = null;
  deps.MarketingPatientList = {
    async findAll(options) {
      reactivationQuery = options;
      return [];
    },
  };

  const result = await getMarketingObjectiveStatus({
    scopeType: 'clinic',
    scopeId: 66,
    clinicIds: [66],
  }, deps);
  const reviews = result.families
    .find((family) => family.id === 'reputation')
    .subobjectives.find((item) => item.id === 'reviews');
  assert.deepEqual(reviews.evidence.configuration_errors, ['review_status_unavailable']);
  assert.equal(campaignRequestQuery.limit, 200);
  assert.equal(assignmentQuery.limit, 1000);
  assert.equal(reactivationQuery.limit, 20);
  assert.ok(!reactivationQuery.include, 'el resumen no debe cargar previews ni asociaciones');
}

async function main() {
  await testCompletedEvidenceReachesOneHundredWithoutFutureFeatures();
  await testMissingEvidenceProducesActionableStatesWithoutExternalCalls();
  await testGroupScopeDoesNotMixClinics();
  testPaidMediaDoesNotCombineDifferentStrategies();
  testPaidMediaReportsCampaignsAndMappedStrategiesSeparately();
  testSeoAiRequiresAUsableProviderAndFreshSearchData();
  testGoogleMapsRequiresRecentSynchronization();
  testReactivationPrefersWorkingAutomationOverNewDraft();
  await testReviewErrorsAreSanitizedAndReactivationReadIsBounded();
  console.log('marketing_objective_status.test.js: OK');
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
