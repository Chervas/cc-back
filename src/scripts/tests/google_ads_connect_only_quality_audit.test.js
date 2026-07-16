#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const db = require('../../../models');
const {
  assessCanonicalGoalAlignment,
  auditConnectOnlyCampaignQuality,
  buildCampaignExistenceGaql,
  buildCampaignGoalGaql,
  buildCampaignQualityGaql,
  campaignGoalFromRow,
  campaignIssuesAndRecommendations,
  campaignQualityFromRow,
  extractGoogleCampaignReferences,
  mergeConnectOnlyQualityCampaignReferences,
  sanitizeCampaignQualityReport,
} = require('../../services/googleAdsConnectOnlyQualityAudit.service');
const {
  discoverGoalPolicyAuditTargets,
  executePersistedGoalPolicyAudit,
} = require('../../services/googleAdsClinicaclickGoalPolicy.service');

const CUSTOMER = '1851215478';
const CUSTOMER_599 = '5992356722';

function strategyPayload() {
  return {
    kind: 'marketing_strategy',
    objective_id: 'new_patients',
    mode_snapshot: 'connect_only',
    status: 'active',
    scope: {
      assignment_scope: 'clinic',
      clinic_id: 56,
      clinic_ids: [56],
    },
    channels: [{ channel: 'google_ads', enabled: true }],
    external_targets: [{
      campaigns: [{
        provider: 'google_ads',
        customer_id: CUSTOMER,
        external_campaign_id: '101',
        name: 'Search Badalona',
      }, {
        provider: 'google_ads',
        provider_account_id: CUSTOMER,
        campaign_id: '102',
        name: 'Search Missing',
      }, {
        provider: 'meta_ads',
        account_id: CUSTOMER,
        campaign_id: '999',
      }],
    }],
  };
}

function qualityRow() {
  return {
    customer: { currencyCode: 'EUR' },
    campaign: {
      id: '101',
      name: 'Search Badalona',
      status: 'ENABLED',
      advertisingChannelType: 'SEARCH',
      advertisingChannelSubType: 'SEARCH_MOBILE_APP',
      biddingStrategyType: 'MAXIMIZE_CONVERSIONS',
      biddingStrategy: `customers/${CUSTOMER}/biddingStrategies/8`,
      primaryStatus: 'LIMITED',
      primaryStatusReasons: ['BUDGET_CONSTRAINED'],
      optimizationScore: 0.62,
    },
    campaignBudget: {
      id: '44',
      name: 'Budget 44',
      status: 'ENABLED',
      amountMicros: '25000000',
      totalAmountMicros: '0',
      deliveryMethod: 'STANDARD',
      period: 'DAILY',
    },
    metrics: {
      costMicros: '120500000',
      impressions: '4300',
      clicks: '210',
      conversions: 4.5,
      allConversions: 7,
      conversionsValue: 40,
      allConversionsValue: 70,
    },
  };
}

function goalRow() {
  return {
    conversionGoalCampaignConfig: {
      resourceName: `customers/${CUSTOMER}/conversionGoalCampaignConfigs/101`,
      campaign: `customers/${CUSTOMER}/campaigns/101`,
      customConversionGoal: `customers/${CUSTOMER}/customConversionGoals/7`,
      goalConfigLevel: 'CAMPAIGN',
    },
    campaign: { id: '101', name: 'Search Badalona' },
    customConversionGoal: {
      name: 'Clinicaclick · Lead cualificado',
      status: 'ENABLED',
      conversionActions: [`customers/${CUSTOMER}/conversionActions/3`],
    },
  };
}

function testGaqlAndMapping() {
  const refs = extractGoogleCampaignReferences(strategyPayload());
  assert.deepEqual(refs.map((item) => item.campaign_id), ['101', '102']);

  const qualityGaql = buildCampaignQualityGaql(['101', '102']);
  for (const field of [
    'campaign.status',
    'campaign.advertising_channel_type',
    'campaign.bidding_strategy_type',
    'campaign.primary_status',
    'campaign.primary_status_reasons',
    'campaign.optimization_score',
    'campaign_budget.amount_micros',
    'metrics.cost_micros',
    'metrics.impressions',
    'metrics.clicks',
    'metrics.conversions',
    'metrics.all_conversions',
    'metrics.conversions_value',
    'metrics.all_conversions_value',
    'segments.date DURING LAST_30_DAYS',
  ]) assert.match(qualityGaql, new RegExp(field.replaceAll('.', '\\.')));
  assert.match(qualityGaql, /campaign\.id IN \(101, 102\)/);
  assert.doesNotMatch(qualityGaql, /access[_-]?token/i);

  const goalGaql = buildCampaignGoalGaql(['101', '102']);
  assert.match(goalGaql, /conversion_goal_campaign_config\.custom_conversion_goal/);
  assert.match(goalGaql, /custom_conversion_goal\.conversion_actions/);
  const existenceGaql = buildCampaignExistenceGaql(['102']);
  assert.match(existenceGaql, /FROM campaign/);
  assert.doesNotMatch(existenceGaql, /metrics\.|segments\.date/);

  const mapped = campaignQualityFromRow(qualityRow());
  assert.equal(mapped.campaign_id, '101');
  assert.equal(mapped.status, 'ENABLED');
  assert.equal(mapped.advertising_channel_type, 'SEARCH');
  assert.equal(mapped.bidding_strategy_type, 'MAXIMIZE_CONVERSIONS');
  assert.equal(mapped.primary_status, 'LIMITED');
  assert.deepEqual(mapped.primary_status_reasons, ['BUDGET_CONSTRAINED']);
  assert.equal(mapped.optimization_score, 0.62);
  assert.equal(mapped.budget.amount_micros, 25_000_000);
  assert.equal(mapped.metrics_30d.cost, 120.5);
  assert.equal(mapped.metrics_30d.all_conversions, 7);
  assert.equal(mapped.metrics_30d.all_conversions_value, 70);

  const goal = campaignGoalFromRow(goalRow());
  assert.equal(goal.goal_config_level, 'CAMPAIGN');
  assert.deepEqual(goal.custom_goal_conversion_action_ids, ['3']);
  assert.equal(assessCanonicalGoalAlignment({
    goal,
    canonicalTargets: [
      { event: 'lead', conversion_action_id: '1' },
      { event: 'qualified_lead', conversion_action_id: '3' },
    ],
  }).status, 'aligned');

  const pausedWithoutMapping = campaignIssuesAndRecommendations({
    ...mapped,
    status: 'PAUSED',
    primary_status: 'PAUSED',
    metrics_30d: { ...mapped.metrics_30d, impressions: 0 },
    goal_alignment: { status: 'canonical_mapping_missing', reasons: [] },
  });
  assert.equal(
    pausedWithoutMapping.issues.find((item) => item.code === 'CANONICAL_GOAL_MAPPING_MISSING')?.severity,
    'warning',
    'a paused historical campaign must not fail the whole connect-only audit because it lacks a bidding goal',
  );
}

async function testReadOnlyAuditBatchesRequests() {
  const calls = [];
  let runtimeResolutions = 0;
  const runtimeCache = new Map();
  const report = await auditConnectOnlyCampaignQuality({
    scope: { assignment_scope: 'clinic', clinic_id: 56 },
    campaigns: extractGoogleCampaignReferences(strategyPayload()),
    canonicalTargets: [{
      customer_id: CUSTOMER,
      event: 'lead',
      canonical_conversion_action_id: '1',
      campaign_ids: ['101', '102'],
    }, {
      customer_id: CUSTOMER,
      event: 'qualified_lead',
      canonical_conversion_action_id: '3',
      campaign_ids: ['101', '102'],
    }],
    runtimeCache,
    dependencies: {
      resolveRuntime: async () => {
        runtimeResolutions += 1;
        return {
          customerId: CUSTOMER,
          loginCustomerId: '2863224233',
          accessToken: 'never-persist-this-token',
        };
      },
      request: async (method, requestPath, options) => {
        calls.push({ method, requestPath, options });
        const query = options.data.query;
        if (query.includes('FROM campaign\n')) return { results: [qualityRow()] };
        if (query.includes('FROM conversion_goal_campaign_config')) return { results: [goalRow()] };
        throw new Error('unexpected query');
      },
    },
    now: new Date('2026-07-16T12:00:00.000Z'),
  });

  assert.equal(runtimeResolutions, 1);
  assert.equal(calls.length, 3,
    'one batched quality query, one missing-campaign existence fallback and one batched goal query');
  assert.ok(calls.every((call) => call.method === 'POST' && call.requestPath.endsWith('/googleAds:search')));
  assert.doesNotMatch(JSON.stringify(calls.map((call) => call.requestPath)), /mutate|upload/i);
  assert.equal(report.external_mutation_count, 0);
  assert.equal(report.google_ads_mutated, false);
  assert.equal(report.summary.configured_campaign_count, 2);
  assert.equal(report.summary.observed_campaign_count, 1);
  assert.equal(report.accounts[0].campaigns[0].goal_alignment.status, 'aligned');
  assert.equal(report.accounts[0].campaigns[0].read_status, 'observed');
  assert.equal(report.accounts[0].campaigns[1].exists, false);
  assert.equal(report.accounts[0].campaigns[1].read_status, 'not_found', 'missing campaigns remain explicit snapshots');
  assert.equal(report.accounts[0].request_count, 3);
  assert.ok(report.issues.some((item) => item.code === 'CONNECTED_CAMPAIGN_NOT_FOUND'));
  assert.ok(report.issues.some((item) => item.code === 'CAMPAIGN_DELIVERY_LIMITED'));
  assert.ok(report.recommendations.length > 0);
  assert.doesNotMatch(JSON.stringify(report), /never-persist-this-token/);
}

async function testReadOnlyAuditChunksLargeAccountsWithoutFalseMissing() {
  const campaigns = Array.from({ length: 201 }, (_, index) => ({
    customer_id: CUSTOMER,
    campaign_id: String(index + 1),
    campaign_name: `Campaign ${index + 1}`,
  }));
  const calls = [];
  const report = await auditConnectOnlyCampaignQuality({
    scope: { assignment_scope: 'clinic', clinic_id: 56 },
    campaigns,
    canonicalTargets: [],
    dependencies: {
      resolveRuntime: async () => ({
        customerId: CUSTOMER,
        loginCustomerId: '2863224233',
        accessToken: 'not-persisted',
      }),
      request: async (_method, _requestPath, options) => {
        calls.push(options.data.query);
        const ids = options.data.query.match(/campaign\.id IN \(([^)]+)\)/)?.[1]
          ?.split(',').map((value) => value.trim()).filter(Boolean) || [];
        if (options.data.query.includes('FROM campaign\n')) {
          return {
            results: ids.map((id) => ({
              customer: { currencyCode: 'EUR' },
              campaign: { id, name: `Campaign ${id}`, status: 'ENABLED', primaryStatus: 'ELIGIBLE' },
              campaignBudget: {},
              metrics: {},
            })),
          };
        }
        return {
          results: ids.map((id) => ({
            conversionGoalCampaignConfig: {
              campaign: `customers/${CUSTOMER}/campaigns/${id}`,
              goalConfigLevel: 'CUSTOMER',
            },
            campaign: { id, name: `Campaign ${id}` },
            customConversionGoal: {},
          })),
        };
      },
    },
  });
  assert.equal(calls.length, 4, '201 campaigns use two bounded quality queries and two goal queries');
  assert.equal(report.summary.observed_campaign_count, 201);
  assert.equal(report.accounts[0].campaigns.filter((item) => item.read_status === 'not_found').length, 0);
  assert.doesNotMatch(JSON.stringify(report), /not-persisted/);
}

async function testQualityScopeUnionsMeasurementAndStrategyCampaignsByAccount() {
  const strategyCampaigns = [{
    customer_id: CUSTOMER,
    campaign_id: '101',
    campaign_name: '185 strategy only',
  }, {
    customer_id: CUSTOMER,
    campaign_id: '102',
    campaign_name: '185 shared',
  }, {
    customer_id: CUSTOMER,
    campaign_id: '102',
    campaign_name: '185 duplicate must collapse',
  }, {
    customer_id: CUSTOMER_599,
    campaign_id: '201',
    campaign_name: '599 strategy only',
  }, {
    customer_id: CUSTOMER_599,
    campaign_id: '203',
    campaign_name: '599 shared',
  }];
  const canonicalTargets = [{
    customer_id: CUSTOMER,
    event: 'lead',
    canonical_conversion_action_id: '1',
    campaign_ids: ['102', '103', '103'],
  }, {
    customer_id: CUSTOMER_599,
    event: 'lead',
    canonical_conversion_action_id: '2',
    campaign_ids: ['202', '203'],
  }, {
    customer_id: CUSTOMER_599,
    event: 'qualified_lead',
    canonical_conversion_action_id: '3',
    campaign_ids: ['202', '203'],
  }];

  const merged = mergeConnectOnlyQualityCampaignReferences(strategyCampaigns, canonicalTargets);
  assert.deepEqual(merged.map((item) => `${item.customer_id}:${item.campaign_id}`), [
    `${CUSTOMER}:101`,
    `${CUSTOMER}:102`,
    `${CUSTOMER}:103`,
    `${CUSTOMER_599}:201`,
    `${CUSTOMER_599}:202`,
    `${CUSTOMER_599}:203`,
  ]);
  assert.equal(
    merged.find((item) => item.customer_id === CUSTOMER && item.campaign_id === '102').campaign_name,
    '185 shared',
    'the strategy label wins while duplicate measurement targets collapse',
  );

  const calls = [];
  const runtimeCustomers = [];
  const report = await auditConnectOnlyCampaignQuality({
    scope: { assignment_scope: 'group', group_id: 5 },
    campaigns: strategyCampaigns,
    canonicalTargets,
    dependencies: {
      resolveRuntime: async ({ customerId }) => {
        runtimeCustomers.push(customerId);
        return {
          customerId,
          loginCustomerId: '2863224233',
          accessToken: `read-only-${customerId}`,
        };
      },
      request: async (method, requestPath, options) => {
        calls.push({ method, requestPath, query: options.data.query });
        const customerId = requestPath.match(/customers\/(\d+)/)?.[1];
        const ids = options.data.query.match(/campaign\.id IN \(([^)]+)\)/)?.[1]
          ?.split(',').map((value) => value.trim()).filter(Boolean) || [];
        if (options.data.query.includes('FROM campaign\n')) {
          return {
            results: ids.map((id) => ({
              customer: { currencyCode: 'EUR' },
              campaign: {
                id,
                name: `${customerId} campaign ${id}`,
                status: 'ENABLED',
                primaryStatus: 'ELIGIBLE',
                advertisingChannelType: 'SEARCH',
                biddingStrategyType: 'MAXIMIZE_CONVERSIONS',
              },
              campaignBudget: {},
              metrics: { impressions: 1 },
            })),
          };
        }
        return {
          results: ids.map((id) => ({
            conversionGoalCampaignConfig: {
              campaign: `customers/${customerId}/campaigns/${id}`,
              goalConfigLevel: 'CUSTOMER',
            },
            campaign: { id, name: `${customerId} campaign ${id}` },
            customConversionGoal: {},
          })),
        };
      },
    },
  });

  assert.deepEqual(runtimeCustomers, [CUSTOMER, CUSTOMER_599]);
  assert.equal(calls.length, 4, 'each authorized account uses one quality SELECT and one goal SELECT');
  assert.ok(calls.every((call) => (
    call.method === 'POST'
      && call.requestPath.endsWith('/googleAds:search')
      && !/mutate|upload/i.test(call.requestPath)
  )));
  assert.equal(report.summary.configured_campaign_count, 6);
  assert.equal(report.summary.observed_campaign_count, 6);
  const byCustomer = new Map(report.accounts.map((account) => [account.customer_id, account]));
  assert.deepEqual(byCustomer.get(CUSTOMER).campaigns.map((item) => item.campaign_id), ['101', '102', '103']);
  assert.deepEqual(byCustomer.get(CUSTOMER_599).campaigns.map((item) => item.campaign_id), ['201', '202', '203']);
  assert.equal(report.external_mutation_count, 0);
  assert.equal(report.google_ads_mutated, false);
  assert.doesNotMatch(JSON.stringify(report), /read-only-185|read-only-599/);
}

async function testMeasurementUnionCannotBypassScopedRuntime() {
  let requestCount = 0;
  const report = await auditConnectOnlyCampaignQuality({
    scope: { assignment_scope: 'clinic', clinic_id: 56 },
    campaigns: [],
    canonicalTargets: [{
      customer_id: CUSTOMER_599,
      event: 'lead',
      canonical_conversion_action_id: '2',
      campaign_ids: ['202'],
    }],
    dependencies: {
      resolveRuntime: async () => {
        const error = new Error('customer_not_assigned_to_scope');
        error.code = 'CUSTOMER_NOT_ASSIGNED_TO_SCOPE';
        throw error;
      },
      request: async () => {
        requestCount += 1;
        throw new Error('Google must not be called without a scoped runtime');
      },
    },
  });

  assert.equal(requestCount, 0);
  assert.equal(report.summary.configured_campaign_count, 1);
  assert.equal(report.summary.observed_campaign_count, 0);
  assert.equal(report.accounts[0].customer_id, CUSTOMER_599);
  assert.equal(report.accounts[0].campaigns[0].read_status, 'unavailable');
  assert.equal(report.external_mutation_count, 0);
  assert.equal(report.google_ads_mutated, false);
}

async function testDiscoveryIncludesConnectOnlyWhenGoalPolicyDisabled() {
  const result = await discoverGoalPolicyAuditTargets({
    intakeModel: {
      async findAll() {
        return [{
          id: 77,
          assignment_scope: 'clinic',
          clinic_id: 56,
          group_id: null,
          config: {
            google_ads: {
              enabled: true,
              goal_policy: { enabled: false },
              events: { lead: { enabled: true, customer_id: CUSTOMER, conversion_action_id: '1' } },
            },
          },
        }];
      },
    },
    campaignRequestModel: {
      async findAll() {
        return [{ id: 9, clinica_id: 56, estado: 'activa', solicitud: strategyPayload() }];
      },
    },
  });
  assert.equal(result.targets.length, 0, 'disabled goal policy must not enter the mutation-policy audit');
  assert.equal(result.measurement_targets.length, 1, 'connect_only quality still enters the daily read-only audit');
  assert.deepEqual(result.measurement_targets[0].strategy_campaigns.map((item) => item.campaign_id), ['101', '102']);
}

async function testPersistedStatusReportIsAllowlisted() {
  let persisted = null;
  let receivedCampaigns = null;
  const result = await executePersistedGoalPolicyAudit({
    dependencies: {
      now: () => new Date('2026-07-16T12:00:00.000Z'),
      syncLogModel: {
        async create() {
          return {
            async update(values) { persisted = values; },
          };
        },
      },
      notifications: { async dispatchEvent() {} },
      discoverTargets: async () => ({
        targets: [],
        issues: [],
        measurement_targets: [{
          intake_config_id: 77,
          scope: { assignment_scope: 'clinic', clinic_id: 56, group_id: null },
          intake_record: { id: 77, config: {} },
          strategy_campaigns: extractGoogleCampaignReferences(strategyPayload()),
        }],
      }),
      auditMeasurement: async ({ strategyCampaigns }) => {
        receivedCampaigns = strategyCampaigns;
        return {
          healthy: true,
          runtime_ready: true,
          summary: { issue_count: 0 },
          consent: {},
          enhanced_conversions: {},
          targets: [],
          issues: [],
          campaign_quality: {
            mode: 'connect_only_campaign_quality_read_only',
            audited_at: '2026-07-16T12:00:00.000Z',
            healthy: true,
            summary: { account_count: 1, configured_campaign_count: 1, observed_campaign_count: 1 },
            accounts: [{
              customer_id: CUSTOMER,
              accessToken: 'must-not-leak',
              campaigns: [{
                campaign_id: '101',
                campaign_name: 'Search',
                exists: true,
                metrics_30d: { impressions: 3 },
                private_secret: 'must-not-leak',
              }],
            }],
            issues: [],
            recommendations: [],
            refresh_token: 'must-not-leak',
          },
        };
      },
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(receivedCampaigns.length, 2);
  const statusReport = persisted.status_report;
  assert.equal(statusReport.connect_only_measurement_targets[0].campaign_quality.accounts[0].campaigns[0].metrics_30d.impressions, 3);
  assert.doesNotMatch(JSON.stringify(statusReport), /must-not-leak|accessToken|refresh_token|private_secret/);

  const directSanitized = sanitizeCampaignQualityReport({
    healthy: true,
    accounts: [{ customer_id: CUSTOMER, accessToken: 'secret', campaigns: [] }],
  });
  assert.doesNotMatch(JSON.stringify(directSanitized), /secret|accessToken/);
}

async function main() {
  testGaqlAndMapping();
  await testReadOnlyAuditBatchesRequests();
  await testReadOnlyAuditChunksLargeAccountsWithoutFalseMissing();
  await testQualityScopeUnionsMeasurementAndStrategyCampaignsByAccount();
  await testMeasurementUnionCannotBypassScopedRuntime();
  await testDiscoveryIncludesConnectOnlyWhenGoalPolicyDisabled();
  await testPersistedStatusReportIsAllowlisted();
  console.log('google_ads_connect_only_quality_audit.test.js OK');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.sequelize.close();
  });
