'use strict';

const assert = require('assert/strict');
const campaignOnboardingController = require('../../controllers/campaignOnboarding.controller');
const {
  externalCampaignIdentityKey
} = require('../../services/externalCampaignAssignmentTargets.service');

const {
  buildCampaignAnalysisMetricContract,
  buildLeadAttributionMetrics,
  buildZonedCalendarRange,
  resolveAnalysisDateRange,
  resolveLeadProvider,
  resolveWebMeasurementMarketingState
} = campaignOnboardingController.__test;

function campaign(provider, accountId, campaignId, name) {
  return {
    provider,
    account_id: accountId,
    external_campaign_id: campaignId,
    name,
    status: 'ENABLED'
  };
}

function testRichGoogleIdentityAndLegacyFallback() {
  const linked = campaign(
    'google_ads',
    '1851215478',
    '21315892458',
    'PROPDENTAL búsqueda dental NOU BARRIS'
  );
  const sameIdOtherAccount = campaign(
    'google_ads',
    '5992356722',
    '21315892458',
    'Otra cuenta con el mismo id'
  );
  const targets = [{
    kind: 'generic',
    treatment_id: null,
    campaigns: [linked, sameIdOtherAccount]
  }];

  const rows = [
    {
      id: 7184,
      source: 'web',
      external_source: 'web',
      source_detail: 'chatbot',
      utm_campaign: null,
      google_ads_customer_id: '185-121-5478',
      google_ads_campaign_id: '21315892458',
      status_lead: 'nuevo'
    },
    {
      id: 8001,
      source: 'google_ads',
      utm_campaign: 'PROPDENTAL búsqueda dental NOU BARRIS',
      status_lead: 'cualificado'
    },
    {
      id: 8002,
      source: 'web',
      google_ads_customer_id: '5992356722',
      google_ads_campaign_id: '21315892458',
      status_lead: 'citado'
    },
    {
      id: 7194,
      source: 'web',
      external_source: 'web',
      source_detail: 'chatbot',
      google_ads_customer_id: '1851215478',
      google_ads_campaign_id: '23967323261',
      status_lead: 'nuevo'
    },
    {
      id: 8003,
      source: 'web',
      source_detail: 'PROPDENTAL búsqueda dental NOU BARRIS',
      google_ads_customer_id: '1851215478',
      google_ads_campaign_id: '99999999999',
      status_lead: 'nuevo'
    }
  ];

  assert.equal(resolveLeadProvider(rows[0]), 'google_ads');
  const result = buildLeadAttributionMetrics(rows, targets);
  const linkedMetrics = result.metricsIndex.get(externalCampaignIdentityKey(linked));
  const otherAccountMetrics = result.metricsIndex.get(externalCampaignIdentityKey(sameIdOtherAccount));

  assert.deepEqual(linkedMetrics, {
    leads: 2,
    qualified_leads: 1,
    appointments: 0,
    crm_conversions: 0
  });
  assert.deepEqual(otherAccountMetrics, {
    leads: 1,
    qualified_leads: 1,
    appointments: 1,
    crm_conversions: 0
  });
  assert.equal(result.aggregate.clinic_paid_leads, 5);
  assert.equal(result.aggregate.linked_leads, 3);
  assert.equal(result.aggregate.unassigned_clinic_leads, 2);
  assert.equal(result.aggregate.unassigned_by_provider.google_ads, 2);
  assert.equal(result.unassignedCampaigns.length, 2);
  assert.ok(
    result.unassignedCampaigns.some((item) => item.campaign_id === '23967323261'),
    'the real unlinked Oral Studio campaign must be visible to diagnostics'
  );
}

function testMadridCalendarBoundaries() {
  const yesterday = resolveAnalysisDateRange('yesterday', null, null, {
    now: new Date('2026-07-14T00:30:00.000Z'),
    timeZone: 'Europe/Madrid'
  });
  assert.equal(yesterday.start.toISOString(), '2026-07-13T00:00:00.000Z');
  assert.equal(yesterday.end.toISOString(), '2026-07-13T00:00:00.000Z');

  const summer = buildZonedCalendarRange(yesterday.start, yesterday.end, 'Europe/Madrid');
  assert.equal(summer.start.toISOString(), '2026-07-12T22:00:00.000Z');
  assert.equal(summer.endExclusive.toISOString(), '2026-07-13T22:00:00.000Z');

  const winter = buildZonedCalendarRange('2026-12-10', '2026-12-10', 'Europe/Madrid');
  assert.equal(winter.start.toISOString(), '2026-12-09T23:00:00.000Z');
  assert.equal(winter.endExclusive.toISOString(), '2026-12-10T23:00:00.000Z');
}

function testAnalysisMetricContractSeparatesCrmAndProvider() {
  const linked = campaign(
    'google_ads',
    '1851215478',
    '21315892458',
    'PROPDENTAL búsqueda dental NOU BARRIS'
  );
  const key = externalCampaignIdentityKey(linked);
  const contract = buildCampaignAnalysisMetricContract({
    provider: 'google_ads',
    campaignRef: linked,
    rows: [
      { spend: 25, leads: 1.25, provider_conversions: 1.25 },
      { spend: 15, leads: 2, provider_conversions: 2 }
    ],
    leadAttribution: {
      metricsIndex: new Map([[key, {
        leads: 2,
        qualified_leads: 1,
        appointments: 1,
        crm_conversions: 0
      }]]),
      aggregate: {
        clinic_paid_leads: 4,
        linked_leads: 2,
        unassigned_by_provider: { google_ads: 2, meta_ads: 0 }
      },
      unassignedCampaigns: [{
        provider: 'google_ads',
        account_id: '1851215478',
        campaign_id: '23967323261',
        leads: 2
      }]
    }
  });

  assert.equal(contract.crm_metrics.leads, 2);
  assert.equal(contract.crm_metrics.qualified_leads, 1);
  assert.equal(contract.crm_metrics.appointments, 1);
  assert.equal(contract.crm_metrics.cost_per_lead, 20);
  assert.equal(contract.crm_metrics.unassigned_clinic_leads, 2);
  assert.equal(contract.provider_metrics.spend, 40);
  assert.equal(contract.provider_metrics.conversions, 3.25);
  assert.equal(contract.metric_contract.rows_leads_semantics, 'provider_conversions_legacy');
  assert.equal(contract.unassigned_campaigns[0].campaign_id, '23967323261');
}

function testClinicUsesExplicitGroupWebMeasurementLocation() {
  const clinicRecord = {
    clinic_id: 35,
    group_id: 5,
    assignment_scope: 'clinic',
    domains: [],
    config: { locations: [] }
  };
  const groupRecord = {
    clinic_id: null,
    group_id: 5,
    assignment_scope: 'group',
    domains: ['propdental.es'],
    config: { locations: [{ id: '19' }, { id: '35' }, { id: '56' }] }
  };
  const result = resolveWebMeasurementMarketingState({
    assignment_scope: 'clinic',
    clinic_id: 35,
    group_id: 5
  }, {
    scope: { assignment_scope: 'clinic', clinic_id: 35, group_id: 5 },
    records: { clinicRecord, groupRecord }
  });

  assert.equal(result.source, 'group_web_location');
  assert.equal(result.assignment_scope, 'group');
  assert.equal(result.group_id, 5);
  assert.equal(result.record, groupRecord);
  assert.equal(result.marketingState.scope.assignment_scope, 'group');
  assert.equal(result.marketingState.records.clinicRecord, null);
  assert.equal(result.marketingState.records.groupRecord, groupRecord);
}

testRichGoogleIdentityAndLegacyFallback();
testMadridCalendarBoundaries();
testAnalysisMetricContractSeparatesCrmAndProvider();
testClinicUsesExplicitGroupWebMeasurementLocation();

console.log('campaign_strategy_crm_metrics.test.js: OK');
