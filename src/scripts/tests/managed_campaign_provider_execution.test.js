'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  REQUIRED_EXECUTION_CONFIRMATIONS,
  buildManagedCampaignPublishingPlan,
  managedCampaignPublishingAccountScopeInput,
} = require('../../services/managedCampaignPublishing.service');
const googleSearchAdapter = require('../../services/managedCampaignGoogleSearchExecutionAdapter.service');
const executionService = require('../../services/managedCampaignProviderExecution.service');
const {
  requiresManagedCampaignProviderExecutionPath,
} = require('../../services/managedCampaignProviderExecutionRegistry.service');

function campaignInput(overrides = {}) {
  return {
    id: 'managed-execution-test',
    version: 7,
    objective_id: 'new_patients',
    clinica_id: 58,
    grupo_clinica_id: 5,
    management_mode: 'autopilot',
    operation_mode: 'managed',
    provider: 'google_ads',
    family: 'google_search',
    status: 'approved_to_launch',
    name: 'Implantes Badalona',
    target_config: {
      keywords: ['implantes dentales', 'dentista implantes'],
      google_ads: {
        geo_target_constant_ids: ['1005424'],
        language_constant_ids: ['1003'],
        positive_geo_target_type: 'PRESENCE',
        negative_geo_target_type: 'PRESENCE',
      },
    },
    budget_config: { amount: 500, currency: 'EUR', period: 'monthly' },
    schedule_config: {
      google_ads: {
        time_zone: 'Europe/Madrid',
        ad_schedules: [{
          day_of_week: 'MONDAY',
          start_hour: 8,
          start_minute: 'ZERO',
          end_hour: 20,
          end_minute: 'ZERO',
        }],
      },
    },
    destination_config: { final_url: 'https://example.test/implantes' },
    audience_config: {},
    creative_config: {
      assets_ready: true,
      rights_confirmed: true,
      headlines: ['Implantes dentales', 'Recupera tu sonrisa', 'Valoración personalizada'],
      descriptions: ['Equipo especializado en implantología.', 'Solicita una valoración en nuestra clínica.'],
    },
    tracking_plan: { status: 'ready', conversion_actions_ready: true },
    platform_refs: { customer_id: '5992356722' },
    review_config: { client_approval_required: true, client_approved_at: '2026-07-19T08:00:00.000Z' },
    policy_readiness: { status: 'ready' },
    approved_at: '2026-07-19T08:30:00.000Z',
    approved_by_user_id: 1,
    funding: {
      id: 'funding-test',
      client_gross_funded: 500,
      media_budget_net: 450,
      media_spend: 0,
      reserved_amount: 0,
      available_amount: 450,
      commission_amount: 50,
      currency: 'EUR',
    },
    ...overrides,
  };
}

function accountAuthorization(campaign) {
  const input = managedCampaignPublishingAccountScopeInput(campaign);
  return {
    scope: { group_id: input.groupId, clinic_id: input.clinicId },
    account: {
      provider: input.provider,
      account_id: String(input.accountId).replace(/\D/g, ''),
      authorization_status: 'active',
      selectable: true,
    },
  };
}

function publishingPlan(campaign = campaignInput()) {
  return buildManagedCampaignPublishingPlan({
    campaign,
    gateEvidence: {
      prepayment_verified: true,
      budget_approved: true,
      policy_reviewed: true,
      tracking_verified: true,
      creative_rights_confirmed: true,
    },
    accountAuthorization: accountAuthorization(campaign),
  });
}

function executionInput(plan, overrides = {}) {
  return {
    id: '2dd7b418-6c5c-4302-8dab-4598bf6ce983',
    plan_hash: plan.plan_hash,
    currency: 'EUR',
    provider_refs: {},
    ownership_snapshot: {},
    ...overrides,
  };
}

function mutateResponses(customerId, keywordCount, campaignCriterionCount = 3) {
  return {
    mutateOperationResponses: [
      { campaignBudgetResult: { resourceName: `customers/${customerId}/campaignBudgets/100` } },
      { campaignResult: { resourceName: `customers/${customerId}/campaigns/200` } },
      ...Array.from({ length: campaignCriterionCount }, (_, index) => ({
        campaignCriterionResult: { resourceName: `customers/${customerId}/campaignCriteria/200~${index + 11}` },
      })),
      { adGroupResult: { resourceName: `customers/${customerId}/adGroups/300` } },
      ...Array.from({ length: keywordCount }, (_, index) => ({
        adGroupCriterionResult: { resourceName: `customers/${customerId}/adGroupCriteria/300~${index + 1}` },
      })),
      { adGroupAdResult: { resourceName: `customers/${customerId}/adGroupAds/300~400` } },
    ],
  };
}

test('Google Search execution adapter builds one atomic PAUSED create and validates first', async () => {
  const plan = publishingPlan();
  const execution = executionInput(plan);
  const input = googleSearchAdapter._assertExecutableInput({ execution, plan });
  const calls = [];
  let mutationGuardCalls = 0;
  const request = async (method, requestPath, options) => {
    calls.push({ method, requestPath, data: options.data });
    if (requestPath.endsWith('googleAds:search')) {
      if (options.data.query.includes('\nFROM customer\n')) {
        return {
          results: [{ customer: { id: '5992356722', currencyCode: 'EUR', timeZone: 'Europe/Madrid' } }],
        };
      }
      const campaignSearchCalls = calls.filter((call) => (
        call.requestPath.endsWith('googleAds:search') && call.data.query.includes('\nFROM campaign\n')
      )).length;
      if (options.data.query.includes('\nFROM campaign\n') && campaignSearchCalls === 1) return { results: [] };
      if (options.data.query.includes('\nFROM campaign\n')) {
        return {
          results: [{
            campaign: {
              id: '200',
              resourceName: 'customers/5992356722/campaigns/200',
              name: input.campaignName,
              status: 'PAUSED',
              advertisingChannelType: 'SEARCH',
              biddingStrategyType: 'MAXIMIZE_CONVERSIONS',
              containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
              geoTargetTypeSetting: {
                positiveGeoTargetType: 'PRESENCE',
                negativeGeoTargetType: 'PRESENCE',
              },
              networkSettings: {
                targetGoogleSearch: true,
                targetSearchNetwork: false,
                targetContentNetwork: false,
                targetPartnerSearchNetwork: false,
              },
              campaignBudget: 'customers/5992356722/campaignBudgets/100',
            },
            campaignBudget: {
              resourceName: 'customers/5992356722/campaignBudgets/100',
              name: input.budgetName,
              amountMicros: String(input.dailyMicros),
              deliveryMethod: 'STANDARD',
              explicitlyShared: false,
            },
          }],
        };
      }
      if (options.data.query.includes('FROM ad_group_ad')) {
        return {
          results: [{
            adGroup: {
              resourceName: 'customers/5992356722/adGroups/300',
              name: input.adGroupName,
              status: 'PAUSED',
              type: 'SEARCH_STANDARD',
            },
            adGroupAd: {
              resourceName: 'customers/5992356722/adGroupAds/300~400',
              status: 'PAUSED',
              ad: {
                type: 'RESPONSIVE_SEARCH_AD',
                finalUrls: [input.finalUrl],
                responsiveSearchAd: {
                  headlines: input.headlines.map((value) => ({ text: value })),
                  descriptions: input.descriptions.map((value) => ({ text: value })),
                },
              },
            },
          }],
        };
      }
      if (options.data.query.includes('FROM keyword_view')) {
        return {
          results: input.keywords.map((value, index) => ({
            adGroup: {
              resourceName: 'customers/5992356722/adGroups/300',
            },
            adGroupCriterion: {
              resourceName: `customers/5992356722/adGroupCriteria/300~${index + 1}`,
              status: 'ENABLED',
              keyword: { text: value, matchType: 'PHRASE' },
            },
          })),
        };
      }
      if (options.data.query.includes('FROM campaign_criterion')) {
        return {
          results: [
            {
              campaignCriterion: {
                resourceName: 'customers/5992356722/campaignCriteria/200~11',
                status: 'ENABLED',
                type: 'LOCATION',
                negative: false,
                location: { geoTargetConstant: 'geoTargetConstants/1005424' },
              },
            },
            {
              campaignCriterion: {
                resourceName: 'customers/5992356722/campaignCriteria/200~12',
                status: 'ENABLED',
                type: 'LANGUAGE',
                negative: false,
                language: { languageConstant: 'languageConstants/1003' },
              },
            },
            {
              campaignCriterion: {
                resourceName: 'customers/5992356722/campaignCriteria/200~13',
                status: 'ENABLED',
                type: 'AD_SCHEDULE',
                negative: false,
                adSchedule: {
                  dayOfWeek: 'MONDAY', startHour: 8, startMinute: 'ZERO', endHour: 20, endMinute: 'ZERO',
                },
              },
            },
          ],
        };
      }
      throw new Error('unexpected Google Ads search query');
    }
    if (options.data.validateOnly === true) return {};
    return mutateResponses('5992356722', 2);
  };
  const result = await googleSearchAdapter.execute({ execution, plan }, {
    resolveRuntime: async () => ({
      customerId: '5992356722',
      accessToken: 'not-returned-by-adapter',
      loginCustomerId: '1234567890',
    }),
    request,
    requireMutationGuard: true,
    beforeMutation: async () => { mutationGuardCalls += 1; },
  });

  assert.equal(result.recovered, false);
  assert.equal(result.provider_refs.campaign, 'customers/5992356722/campaigns/200');
  assert.equal(result.ownership.marker.startsWith('CCME-'), true);
  assert.equal(result.ownership.customer_contract.currency_code, 'EUR');
  assert.equal(result.ownership.customer_contract.time_zone, 'Europe/Madrid');
  assert.equal(calls.length, 8);
  assert.equal(calls[0].requestPath, 'customers/5992356722/googleAds:search');
  assert.equal(calls[2].data.validateOnly, true);
  assert.equal(calls[3].data.validateOnly, false);
  assert.equal(calls[3].data.partialFailure, false);
  const operations = calls[3].data.mutateOperations;
  assert.equal(operations[1].campaignOperation.create.status, 'PAUSED');
  assert.equal(operations.filter((item) => item.campaignCriterionOperation?.create).length, 3);
  assert.equal(operations.find((item) => item.adGroupOperation?.create).adGroupOperation.create.status, 'PAUSED');
  assert.equal(operations.at(-1).adGroupAdOperation.create.status, 'PAUSED');
  assert.equal(operations.some((item) => item.campaignOperation?.update), false);
  assert.equal(mutationGuardCalls, 1);
  assert.doesNotMatch(JSON.stringify(result), /not-returned-by-adapter/);
});

test('managed Google Search owns the provider lifecycle before an execution row exists', () => {
  assert.equal(requiresManagedCampaignProviderExecutionPath(campaignInput()), true);
  assert.equal(requiresManagedCampaignProviderExecutionPath(campaignInput({
    management_mode: 'connect_only',
  })), false);
  assert.equal(requiresManagedCampaignProviderExecutionPath(campaignInput({
    operation_mode: 'observe',
  })), false);
  assert.equal(requiresManagedCampaignProviderExecutionPath(campaignInput({
    family: 'google_pmax',
  })), false);
});

test('Google Search adapter never retries an ambiguous post-mutate transport failure', async () => {
  const plan = publishingPlan();
  const execution = executionInput(plan);
  let mutateCalls = 0;
  const request = async (_method, requestPath, options) => {
    if (requestPath.endsWith('googleAds:search')) {
      if (options.data.query.includes('\nFROM customer\n')) {
        return { results: [{ customer: { id: '5992356722', currencyCode: 'EUR', timeZone: 'Europe/Madrid' } }] };
      }
      return { results: [] };
    }
    mutateCalls += 1;
    if (options.data.validateOnly === true) return {};
    const error = new Error('socket closed after request write');
    error.code = 'ECONNRESET';
    throw error;
  };

  await assert.rejects(
    googleSearchAdapter.execute({ execution, plan }, {
      resolveRuntime: async () => ({
        customerId: '5992356722',
        accessToken: 'not-returned-by-adapter',
        loginCustomerId: '1234567890',
      }),
      request,
    }),
    (error) => error.code === 'managed_google_ambiguous_outcome'
      && error.manualRecoveryRequired === true
      && error.retryable === false
  );
  assert.equal(mutateCalls, 2);
});

test('Google Search adapter blocks currency or time-zone drift before mutate', async () => {
  const plan = publishingPlan();
  const execution = executionInput(plan);
  let mutateCalls = 0;
  const request = async (_method, requestPath, options) => {
    if (requestPath.endsWith('googleAds:search')) {
      return {
        results: [{ customer: { id: '5992356722', currencyCode: 'USD', timeZone: 'Europe/Madrid' } }],
      };
    }
    mutateCalls += 1;
    return {};
  };
  await assert.rejects(
    googleSearchAdapter.execute({ execution, plan }, {
      resolveRuntime: async () => ({
        customerId: '5992356722',
        accessToken: 'not-returned-by-adapter',
        loginCustomerId: '1234567890',
      }),
      request,
    }),
    (error) => error.code === 'managed_google_customer_contract_mismatch'
  );
  assert.equal(mutateCalls, 0);
});

test('Google Search activation only performs atomic PAUSED to ENABLED status updates after exact readback', async () => {
  const plan = publishingPlan();
  const baseExecution = executionInput(plan);
  const input = googleSearchAdapter._assertExecutableInput({ execution: baseExecution, plan });
  const refs = {
    customer_id: '5992356722',
    campaign: 'customers/5992356722/campaigns/200',
    campaign_budget: 'customers/5992356722/campaignBudgets/100',
    ad_groups: ['customers/5992356722/adGroups/300'],
    ad_group_ads: ['customers/5992356722/adGroupAds/300~400'],
    ad_group_criteria: [
      'customers/5992356722/adGroupCriteria/300~1',
      'customers/5992356722/adGroupCriteria/300~2',
    ],
    campaign_criteria: [
      'customers/5992356722/campaignCriteria/200~11',
      'customers/5992356722/campaignCriteria/200~12',
      'customers/5992356722/campaignCriteria/200~13',
    ],
  };
  const execution = executionInput(plan, {
    activation_idempotency_key: 'activation-adapter-test',
    activation_change_reference: 'OPS-ACTIVATION-ADAPTER-TEST',
    activation_requested_by_user_id: 1,
    activation_authorization_snapshot: {
      schema_version: 'managed-campaign-provider-activation-authorization/v1',
      approved_at: new Date().toISOString(),
      approved_by_user_id: 1,
      change_reference: 'OPS-ACTIVATION-ADAPTER-TEST',
      plan_hash: plan.plan_hash,
      confirmations: Object.fromEntries(
        executionService.REQUIRED_ACTIVATION_CONFIRMATIONS.map((key) => [key, true])
      ),
    },
    provider_refs: refs,
    ownership_snapshot: {
      adapter_version: googleSearchAdapter.ADAPTER_VERSION,
      marker: input.marker,
      expected_campaign_name: input.campaignName,
      customer_id: '5992356722',
      customer_contract: {
        customer_id: '5992356722', currency_code: 'EUR', time_zone: 'Europe/Madrid', source: 'google_ads_customer_readback',
      },
    },
  });
  let hierarchyStatus = 'PAUSED';
  const mutateBodies = [];
  let mutationGuardCalls = 0;
  const request = async (_method, requestPath, options) => {
    if (requestPath.endsWith('googleAds:mutate')) {
      mutateBodies.push(options.data);
      if (options.data.validateOnly === false) hierarchyStatus = 'ENABLED';
      return {};
    }
    const query = options.data.query;
    if (query.includes('\nFROM customer\n')) {
      return { results: [{ customer: { id: '5992356722', currencyCode: 'EUR', timeZone: 'Europe/Madrid' } }] };
    }
    if (query.includes('\nFROM campaign\n')) {
      return { results: [{
        campaign: {
          id: '200',
          resourceName: refs.campaign,
          name: input.campaignName,
          status: hierarchyStatus,
          advertisingChannelType: 'SEARCH',
          biddingStrategyType: 'MAXIMIZE_CONVERSIONS',
          containsEuPoliticalAdvertising: 'DOES_NOT_CONTAIN_EU_POLITICAL_ADVERTISING',
          geoTargetTypeSetting: { positiveGeoTargetType: 'PRESENCE', negativeGeoTargetType: 'PRESENCE' },
          networkSettings: {
            targetGoogleSearch: true,
            targetSearchNetwork: false,
            targetContentNetwork: false,
            targetPartnerSearchNetwork: false,
          },
          campaignBudget: refs.campaign_budget,
        },
        campaignBudget: {
          resourceName: refs.campaign_budget,
          name: input.budgetName,
          amountMicros: String(input.dailyMicros),
          deliveryMethod: 'STANDARD',
          explicitlyShared: false,
        },
      }] };
    }
    if (query.includes('FROM ad_group_ad')) {
      return { results: [{
        adGroup: { resourceName: refs.ad_groups[0], name: input.adGroupName, status: hierarchyStatus, type: 'SEARCH_STANDARD' },
        adGroupAd: {
          resourceName: refs.ad_group_ads[0],
          status: hierarchyStatus,
          ad: {
            type: 'RESPONSIVE_SEARCH_AD',
            finalUrls: [input.finalUrl],
            responsiveSearchAd: {
              headlines: input.headlines.map((value) => ({ text: value })),
              descriptions: input.descriptions.map((value) => ({ text: value })),
            },
          },
        },
      }] };
    }
    if (query.includes('FROM keyword_view')) {
      return { results: input.keywords.map((value, index) => ({
        adGroup: { resourceName: refs.ad_groups[0] },
        adGroupCriterion: {
          resourceName: refs.ad_group_criteria[index], status: 'ENABLED', keyword: { text: value, matchType: 'PHRASE' },
        },
      })) };
    }
    if (query.includes('FROM campaign_criterion')) {
      return { results: [
        { campaignCriterion: { resourceName: refs.campaign_criteria[0], status: 'ENABLED', type: 'LOCATION', negative: false, location: { geoTargetConstant: 'geoTargetConstants/1005424' } } },
        { campaignCriterion: { resourceName: refs.campaign_criteria[1], status: 'ENABLED', type: 'LANGUAGE', negative: false, language: { languageConstant: 'languageConstants/1003' } } },
        { campaignCriterion: { resourceName: refs.campaign_criteria[2], status: 'ENABLED', type: 'AD_SCHEDULE', negative: false, adSchedule: { dayOfWeek: 'MONDAY', startHour: 8, startMinute: 'ZERO', endHour: 20, endMinute: 'ZERO' } } },
      ] };
    }
    throw new Error(`unexpected query: ${query}`);
  };
  const result = await googleSearchAdapter.activate({ execution, plan }, {
    resolveRuntime: async () => ({
      customerId: '5992356722', accessToken: 'not-returned-by-adapter', loginCustomerId: '1234567890',
    }),
    request,
    requireMutationGuard: true,
    beforeMutation: async () => { mutationGuardCalls += 1; },
  });
  assert.equal(result.current_status, 'ENABLED');
  assert.equal(result.ownership.hierarchy_status_at_ownership_check, 'ENABLED');
  assert.equal(mutateBodies.length, 2);
  assert.equal(mutateBodies[0].validateOnly, true);
  assert.equal(mutateBodies[1].validateOnly, false);
  assert.equal(mutateBodies[1].partialFailure, false);
  assert.deepEqual(mutateBodies[1].mutateOperations.map((operation) => (
    Object.keys(operation)[0]
  )), ['adGroupAdOperation', 'adGroupOperation', 'campaignOperation']);
  assert.equal(mutateBodies[1].mutateOperations.every((operation) => (
    Object.values(operation)[0].updateMask === 'status'
    && Object.values(operation)[0].update.status === 'ENABLED'
  )), true);
  assert.equal(mutationGuardCalls, 1);

  const recovered = await googleSearchAdapter.recoverActivation({ execution, plan }, {
    resolveRuntime: async () => ({
      customerId: '5992356722', accessToken: 'not-returned-by-adapter', loginCustomerId: '1234567890',
    }),
    request,
    requireMutationGuard: true,
    beforeMutation: async () => { mutationGuardCalls += 1; },
  });
  assert.equal(recovered.recovered, true);
  assert.equal(recovered.recovered_after_restart, true);
  assert.equal(recovered.provider_mutation_performed, false);
  assert.equal(recovered.provider_refs.campaign, refs.campaign);
  assert.equal(mutateBodies.length, 2);
  assert.equal(mutationGuardCalls, 1);
});

test('Google Search adapter rejects update_existing, PMax and unsafe rollback ownership before networking', async () => {
  const createPlan = publishingPlan();
  const updatePlan = JSON.parse(JSON.stringify(createPlan));
  updatePlan.specification.operation = 'update_existing';
  updatePlan.specification.existing_campaign_id = '123';
  await assert.rejects(
    googleSearchAdapter.execute({ execution: executionInput(updatePlan), plan: updatePlan }, {}),
    (error) => error.code === 'managed_operation_unsupported'
  );

  const pmaxPlan = JSON.parse(JSON.stringify(createPlan));
  pmaxPlan.campaign.family = 'google_pmax';
  await assert.rejects(
    googleSearchAdapter.execute({ execution: executionInput(pmaxPlan), plan: pmaxPlan }, {}),
    (error) => error.code === 'managed_provider_family_unsupported'
  );

  let networkCalls = 0;
  await assert.rejects(
    googleSearchAdapter.rollback({
      execution: executionInput(createPlan, {
        provider_refs: { customer_id: '5992356722', campaign: 'customers/5992356722/campaigns/999' },
        ownership_snapshot: { marker: 'forged' },
      }),
      plan: createPlan,
    }, {
      resolveRuntime: async () => { networkCalls += 1; return {}; },
    }),
    (error) => error.code === 'managed_google_rollback_ownership_missing'
  );
  assert.equal(networkCalls, 0);
});

class Row {
  constructor(data) { Object.assign(this, data); }
  get() { return { ...this }; }
  async update(patch) { Object.assign(this, patch); return this; }
}

function fakePersistence() {
  const campaign = new Row(campaignInput({ funding: undefined }));
  const funding = new Row({
    id: 'funding-test',
    managed_campaign_id: campaign.id,
    currency: 'EUR',
    status: 'funded',
    client_gross_funded: 500,
    commission_amount: 50,
    media_budget_net: 450,
    media_spend: 0,
    reserved_amount: 0,
    available_amount: 450,
  });
  const plan = publishingPlan({ ...campaignInput(), funding: { ...funding } });
  const audit = new Row({
    id: 'audit-ready',
    managed_campaign_id: campaign.id,
    mode: 'dry_run',
    readiness_status: 'ready',
    provider_call_performed: false,
    plan_id: plan.plan_id,
    plan_hash: plan.plan_hash,
    campaign_version: campaign.version,
    provider: campaign.provider,
    family: campaign.family,
    plan_snapshot: plan,
  });
  const executions = [];
  const ledger = [new Row({
    id: 'verified-topup',
    funding_account_id: funding.id,
    entry_type: 'topup',
    metadata: { payment_verified: true },
  })];
  const jobs = [];
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const ExecutionModel = {
    async findOne({ where }) {
      if (where.id) return executions.find((row) => row.id === where.id && row.managed_campaign_id === where.managed_campaign_id) || null;
      if (where.idempotency_key) return executions.find((row) => (
        row.managed_campaign_id === where.managed_campaign_id && row.idempotency_key === where.idempotency_key
      )) || null;
      if (where.status) return executions.find((row) => (
        row.managed_campaign_id === where.managed_campaign_id && where.status.includes(row.status)
      )) || null;
      return null;
    },
    async findByPk(id) { return executions.find((row) => row.id === id) || null; },
    async findAll() { return [...executions]; },
    async create(payload) { const row = new Row(payload); executions.push(row); return row; },
    async update(patch, { where }) {
      const matches = executions.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
      matches.forEach((row) => Object.assign(row, patch));
      return [matches.length];
    },
  };
  const models = {
    sequelize: { async transaction(callback) { return callback(transaction); } },
    ManagedCampaign: {
      async findByPk(id) { return id === campaign.id ? campaign : null; },
    },
    ManagedCampaignFundingAccount: {
      async findOne({ where }) { return where.managed_campaign_id === campaign.id ? funding : null; },
      async findByPk(id) { return id === funding.id ? funding : null; },
    },
    ManagedCampaignPublishingAudit: {
      async findOne({ where }) {
        return where.id === audit.id && where.managed_campaign_id === campaign.id ? audit : null;
      },
    },
    ManagedCampaignProviderExecution: ExecutionModel,
    ManagedCampaignLedgerEntry: {
      async create(payload) { const row = new Row(payload); ledger.push(row); return row; },
      async findAll({ where }) {
        return ledger.filter((row) => Object.entries(where).every(([key, value]) => row[key] === value));
      },
      async findOne({ where }) {
        return ledger.find((row) => Object.entries(where).every(([key, value]) => row[key] === value)) || null;
      },
    },
    JobRequest: {},
  };
  const enqueueJobRequest = async (payload) => {
    const job = { id: jobs.length + 91, ...payload };
    jobs.push(job);
    return job;
  };
  return { campaign, funding, plan, audit, executions, ledger, jobs, models, enqueueJobRequest };
}

function executionConfirmations() {
  return Object.fromEntries(REQUIRED_EXECUTION_CONFIRMATIONS.map((key) => [key, true]));
}

function activationConfirmations() {
  return Object.fromEntries(executionService.REQUIRED_ACTIVATION_CONFIRMATIONS.map((key) => [key, true]));
}

async function succeededCreationStore() {
  const store = fakePersistence();
  const dependencies = {
    models: store.models,
    sequelize: store.models.sequelize,
    enqueueJobRequest: store.enqueueJobRequest,
    featureEnabled: () => true,
    activationFeatureEnabled: () => true,
    resolveAccountAuthorization: async ({ campaign }) => accountAuthorization(campaign),
  };
  const queued = await executionService.enqueueExecution({
    campaignId: store.campaign.id,
    sourcePublishingAuditId: store.audit.id,
    actorUserId: 1,
    expectedPlanHash: store.plan.plan_hash,
    idempotencyKey: 'helper-create-001',
    changeReference: 'OPS-HELPER-CREATE',
    confirmation: executionConfirmations(),
  }, dependencies);
  const refs = {
    customer_id: '5992356722',
    campaign: 'customers/5992356722/campaigns/200',
    campaign_budget: 'customers/5992356722/campaignBudgets/100',
    ad_groups: ['customers/5992356722/adGroups/300'],
    ad_group_ads: ['customers/5992356722/adGroupAds/300~400'],
    ad_group_criteria: [
      'customers/5992356722/adGroupCriteria/300~1',
      'customers/5992356722/adGroupCriteria/300~2',
    ],
    campaign_criteria: [
      'customers/5992356722/campaignCriteria/200~11',
      'customers/5992356722/campaignCriteria/200~12',
      'customers/5992356722/campaignCriteria/200~13',
    ],
  };
  const marker = googleSearchAdapter.executionMarker(queued.execution.id, store.plan.plan_hash);
  const ownership = {
    adapter_version: googleSearchAdapter.ADAPTER_VERSION,
    marker,
    expected_campaign_name: `${store.plan.specification.name} · [${marker}]`,
    customer_id: '5992356722',
    customer_contract: {
      customer_id: '5992356722', currency_code: 'EUR', time_zone: 'Europe/Madrid', source: 'google_ads_customer_readback',
    },
  };
  const adapter = {
    ADAPTER_VERSION: googleSearchAdapter.ADAPTER_VERSION,
    async execute() { return { recovered: false, provider_refs: refs, ownership }; },
  };
  const completed = await executionService.runExecutionJob(
    { execution_id: queued.execution.id },
    { id: queued.job.id },
    { ...dependencies, getAdapter: () => adapter }
  );
  assert.equal(completed.status, 'completed');
  assert.equal(store.executions[0].status, 'succeeded');
  return { store, dependencies, refs, marker, ownership };
}

test('execution is default-deny before database access', async () => {
  assert.equal(executionService.explicitEnabled(''), false);
  assert.equal(executionService.explicitEnabled('false'), false);
  assert.equal(executionService.explicitEnabled('1'), false);
  assert.equal(executionService.explicitEnabled('true'), true);
  let accessed = false;
  await assert.rejects(
    executionService.enqueueExecution({}, {
      featureEnabled: () => false,
      get models() { accessed = true; throw new Error('must not access models'); },
    }),
    (error) => error.code === 'managed_campaign_provider_execution_disabled' && error.httpStatus === 503
  );
  assert.equal(accessed, false);
  accessed = false;
  await assert.rejects(
    executionService.enqueueActivation({}, {
      featureEnabled: () => true,
      activationFeatureEnabled: () => false,
      get models() { accessed = true; throw new Error('must not access models'); },
    }),
    (error) => error.code === 'managed_campaign_provider_activation_disabled' && error.httpStatus === 503
  );
  assert.equal(accessed, false);
});

test('enqueue, execute and owned rollback are durable, idempotent and finance-safe without provider calls', async () => {
  const store = fakePersistence();
  const dependencies = {
    models: store.models,
    sequelize: store.models.sequelize,
    enqueueJobRequest: store.enqueueJobRequest,
    featureEnabled: () => true,
    activationFeatureEnabled: () => true,
    resolveAccountAuthorization: async ({ campaign }) => accountAuthorization(campaign),
  };
  const command = {
    campaignId: store.campaign.id,
    sourcePublishingAuditId: store.audit.id,
    actorUserId: 1,
    expectedPlanHash: store.plan.plan_hash,
    idempotencyKey: 'pilot-create-001',
    changeReference: 'OPS-CC-001',
    confirmation: executionConfirmations(),
  };
  const queued = await executionService.enqueueExecution(command, dependencies);
  assert.equal(queued.created, true);
  assert.equal(store.executions.length, 1);
  assert.equal(store.executions[0].status, 'queued');
  assert.equal(store.jobs[0].type, executionService.EXECUTE_JOB_TYPE);
  assert.equal(store.funding.reserved_amount, 450);
  assert.equal(store.funding.available_amount, 0);
  assert.equal(store.ledger.find((row) => row.entry_type === 'media_reserve').amount, 450);
  assert.equal(store.campaign.status, 'launching');

  const repeated = await executionService.enqueueExecution(command, dependencies);
  assert.equal(repeated.created, false);
  assert.equal(store.ledger.filter((row) => row.entry_type === 'media_reserve').length, 1);
  assert.equal(store.jobs.length, 1);

  const providerRefs = {
    customer_id: '5992356722',
    campaign: 'customers/5992356722/campaigns/200',
    campaign_budget: 'customers/5992356722/campaignBudgets/100',
    ad_groups: ['customers/5992356722/adGroups/300'],
    ad_group_ads: ['customers/5992356722/adGroupAds/300~400'],
    ad_group_criteria: [
      'customers/5992356722/adGroupCriteria/300~1',
      'customers/5992356722/adGroupCriteria/300~2',
    ],
    campaign_criteria: [
      'customers/5992356722/campaignCriteria/200~11',
      'customers/5992356722/campaignCriteria/200~12',
      'customers/5992356722/campaignCriteria/200~13',
    ],
  };
  const marker = googleSearchAdapter.executionMarker(store.executions[0].id, store.plan.plan_hash);
  const adapter = {
    ADAPTER_VERSION: googleSearchAdapter.ADAPTER_VERSION,
    async execute() {
      return {
        recovered: false,
        provider_refs: providerRefs,
        ownership: {
          adapter_version: googleSearchAdapter.ADAPTER_VERSION,
          marker,
          expected_campaign_name: `${store.plan.specification.name} · [${marker}]`,
          customer_id: '5992356722',
          campaign_status_at_creation: 'PAUSED',
          channel_type_at_creation: 'SEARCH',
          customer_contract: {
            customer_id: '5992356722', currency_code: 'EUR', time_zone: 'Europe/Madrid', source: 'google_ads_customer_readback',
          },
        },
      };
    },
    async activate({ execution }) {
      assert.equal(execution.provider_refs.campaign, providerRefs.campaign);
      return {
        recovered: false,
        provider_refs: providerRefs,
        ownership: {
          adapter_version: googleSearchAdapter.ADAPTER_VERSION,
          marker,
          expected_campaign_name: `${store.plan.specification.name} · [${marker}]`,
          customer_id: '5992356722',
          hierarchy_status_at_ownership_check: 'ENABLED',
          customer_contract: {
            customer_id: '5992356722', currency_code: 'EUR', time_zone: 'Europe/Madrid', source: 'google_ads_customer_readback',
          },
        },
      };
    },
    async rollback({ execution }) {
      assert.equal(execution.provider_refs.campaign, providerRefs.campaign);
      assert.equal(execution.ownership_snapshot.marker, marker);
      return { already_absent: false, removed_refs: providerRefs };
    },
  };
  let goalPolicyChecks = 0;
  const workerDependencies = {
    ...dependencies,
    getAdapter: () => adapter,
    ensureManagedGoalPolicy: async ({ execution }) => {
      goalPolicyChecks += 1;
      return {
        policy_id: 77,
        stage: 'qualified_lead',
        customer_id: '5992356722',
        campaign_ids: ['200'],
        preview_digest: 'a'.repeat(64),
        outcome: 'applied',
        verification_healthy: true,
        plan_hash: execution.plan_hash,
        verified_at: '2026-07-19T09:00:00.000Z',
      };
    },
  };
  const executed = await executionService.runExecutionJob(
    { execution_id: store.executions[0].id },
    { id: store.jobs[0].id },
    workerDependencies
  );
  assert.equal(executed.status, 'completed');
  assert.equal(store.executions[0].status, 'succeeded');
  assert.equal(store.executions[0].provider_refs.campaign, providerRefs.campaign);
  assert.equal(store.campaign.status, 'launching');
  assert.match(store.campaign.operational_blocker, /PAUSED/);
  assert.equal(store.funding.reserved_amount, 450);

  const activationCommand = {
    campaignId: store.campaign.id,
    executionId: store.executions[0].id,
    actorUserId: 1,
    expectedPlanHash: store.plan.plan_hash,
    idempotencyKey: 'pilot-activate-001',
    changeReference: 'OPS-CC-ACTIVATE-001',
    confirmation: activationConfirmations(),
  };
  const activation = await executionService.enqueueActivation(activationCommand, {
    ...dependencies,
    getAdapter: () => googleSearchAdapter,
  });
  assert.equal(activation.created, true);
  assert.equal(store.executions[0].status, 'activation_queued');
  assert.equal(store.jobs[1].type, executionService.ACTIVATE_JOB_TYPE);
  assert.equal(store.funding.reserved_amount, 450);
  const repeatedActivation = await executionService.enqueueActivation(activationCommand, {
    ...dependencies,
    getAdapter: () => googleSearchAdapter,
  });
  assert.equal(repeatedActivation.created, false);
  assert.equal(store.jobs.length, 2);
  const activated = await executionService.runActivationJob(
    { execution_id: store.executions[0].id },
    { id: store.jobs[1].id },
    workerDependencies
  );
  assert.equal(activated.status, 'completed');
  assert.equal(store.executions[0].status, 'active');
  assert.equal(store.campaign.status, 'active');
  assert.equal(store.funding.reserved_amount, 450);
  assert.equal(goalPolicyChecks, 1);
  assert.equal(store.executions[0].goal_policy_snapshot.stage, 'qualified_lead');
  assert.equal(store.executions[0].goal_policy_snapshot.verification_healthy, true);

  for (const reusedKey of ['pilot-create-001', 'pilot-activate-001']) {
    await assert.rejects(
      executionService.enqueueRollback({
        campaignId: store.campaign.id,
        executionId: store.executions[0].id,
        actorUserId: 1,
        idempotencyKey: reusedKey,
        confirmRollback: true,
      }, dependencies),
      (error) => error.code === 'managed_rollback_idempotency_key_reused'
    );
  }

  const rollback = await executionService.enqueueRollback({
    campaignId: store.campaign.id,
    executionId: store.executions[0].id,
    actorUserId: 1,
    idempotencyKey: 'pilot-rollback-001',
    confirmRollback: true,
  }, dependencies);
  assert.equal(rollback.created, true);
  assert.equal(store.jobs[2].type, executionService.ROLLBACK_JOB_TYPE);
  const rolledBack = await executionService.runRollbackJob(
    { execution_id: store.executions[0].id },
    { id: store.jobs[2].id },
    workerDependencies
  );
  assert.equal(rolledBack.status, 'completed');
  assert.equal(store.executions[0].status, 'rolled_back');
  assert.equal(store.funding.reserved_amount, 0);
  assert.equal(store.funding.available_amount, 450);
  assert.equal(store.ledger.filter((row) => row.entry_type === 'release').length, 1);
  assert.equal(store.campaign.status, 'blocked');
  assert.equal(store.campaign.platform_refs.campaign_id, undefined);
  assert.equal(store.campaign.platform_refs.managed_execution_id, undefined);
  assert.equal(store.campaign.platform_refs.last_rolled_back_managed_execution_id, store.executions[0].id);
});

test('safe provider retries become terminal and release funds when the JobRequest budget is exhausted', async () => {
  const store = fakePersistence();
  const dependencies = {
    models: store.models,
    sequelize: store.models.sequelize,
    enqueueJobRequest: store.enqueueJobRequest,
    featureEnabled: () => true,
    resolveAccountAuthorization: async ({ campaign }) => accountAuthorization(campaign),
  };
  const queued = await executionService.enqueueExecution({
    campaignId: store.campaign.id,
    sourcePublishingAuditId: store.audit.id,
    actorUserId: 1,
    expectedPlanHash: store.plan.plan_hash,
    idempotencyKey: 'pilot-create-retry-exhausted',
    changeReference: 'OPS-CC-RETRY',
    confirmation: executionConfirmations(),
  }, dependencies);
  const retryableAdapter = {
    ADAPTER_VERSION: googleSearchAdapter.ADAPTER_VERSION,
    async execute() {
      const error = new Error('quota gate');
      error.code = 'managed_google_provider_temporarily_unavailable';
      error.retryable = true;
      throw error;
    },
  };
  const result = await executionService.runExecutionJob(
    { execution_id: queued.execution.id },
    { id: queued.job.id, attempts: 5, max_attempts: 5 },
    { ...dependencies, getAdapter: () => retryableAdapter }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, false);
  assert.equal(store.executions[0].status, 'failed');
  assert.equal(store.funding.reserved_amount, 0);
  assert.equal(store.funding.available_amount, 450);
  assert.equal(store.ledger.filter((row) => row.entry_type === 'release').length, 1);
  assert.equal(store.campaign.status, 'blocked');
});

test('account assignment revocation at the last fence prevents the provider mutation and releases create funds', async () => {
  const store = fakePersistence();
  let authorizationChecks = 0;
  const dependencies = {
    models: store.models,
    sequelize: store.models.sequelize,
    enqueueJobRequest: store.enqueueJobRequest,
    featureEnabled: () => true,
    resolveAccountAuthorization: async ({ campaign }) => {
      authorizationChecks += 1;
      return authorizationChecks < 4 ? accountAuthorization(campaign) : null;
    },
  };
  const queued = await executionService.enqueueExecution({
    campaignId: store.campaign.id,
    sourcePublishingAuditId: store.audit.id,
    actorUserId: 1,
    expectedPlanHash: store.plan.plan_hash,
    idempotencyKey: 'pilot-create-revoked-at-fence',
    changeReference: 'OPS-CC-REVOKED-AT-FENCE',
    confirmation: executionConfirmations(),
  }, dependencies);
  let providerMutations = 0;
  const result = await executionService.runExecutionJob(
    { execution_id: queued.execution.id },
    { id: queued.job.id },
    {
      ...dependencies,
      getAdapter: () => ({
        ADAPTER_VERSION: googleSearchAdapter.ADAPTER_VERSION,
        async execute(_input, adapterDependencies) {
          await adapterDependencies.beforeMutation();
          providerMutations += 1;
          throw new Error('must not reach the provider');
        },
      }),
    }
  );

  assert.equal(result.status, 'failed');
  assert.equal(providerMutations, 0);
  assert.equal(store.executions[0].status, 'failed');
  assert.equal(store.executions[0].lease_owner, null);
  assert.equal(store.funding.reserved_amount, 0);
  assert.equal(store.funding.available_amount, 450);
  assert.equal(store.ledger.filter((row) => row.entry_type === 'release').length, 1);
  assert.equal(store.campaign.status, 'blocked');
});

test('revocation after an expired in-progress create lease preserves funds and marks the outcome unknown', async () => {
  const store = fakePersistence();
  let authorized = true;
  const dependencies = {
    models: store.models,
    sequelize: store.models.sequelize,
    enqueueJobRequest: store.enqueueJobRequest,
    featureEnabled: () => true,
    resolveAccountAuthorization: async ({ campaign }) => (
      authorized ? accountAuthorization(campaign) : null
    ),
  };
  const queued = await executionService.enqueueExecution({
    campaignId: store.campaign.id,
    sourcePublishingAuditId: store.audit.id,
    actorUserId: 1,
    expectedPlanHash: store.plan.plan_hash,
    idempotencyKey: 'pilot-create-expired-revoked',
    changeReference: 'OPS-CC-EXPIRED-REVOKED',
    confirmation: executionConfirmations(),
  }, dependencies);
  const campaignVersion = store.campaign.version;
  Object.assign(store.executions[0], {
    status: 'executing',
    lease_owner: 'crashed-create-worker',
    lease_version: 1,
    lease_expires_at: new Date(Date.now() - 60_000),
  });
  authorized = false;
  let adapterCalls = 0;
  const result = await executionService.runExecutionJob(
    { execution_id: queued.execution.id },
    { id: queued.job.id },
    {
      ...dependencies,
      getAdapter: () => ({
        ADAPTER_VERSION: googleSearchAdapter.ADAPTER_VERSION,
        async execute() { adapterCalls += 1; return {}; },
      }),
    }
  );

  assert.equal(result.status, 'completed');
  assert.equal(adapterCalls, 0);
  assert.equal(store.executions[0].status, 'manual_recovery_required');
  assert.equal(store.funding.reserved_amount, 450);
  assert.equal(store.funding.available_amount, 0);
  assert.equal(store.ledger.filter((row) => row.entry_type === 'release').length, 0);
  assert.equal(store.campaign.status, 'launching');
  assert.equal(store.campaign.version, campaignVersion);
});

test('revocation with a changed funding fence never releases or rewrites the concurrent reserve', async () => {
  const store = fakePersistence();
  let authorized = true;
  const dependencies = {
    models: store.models,
    sequelize: store.models.sequelize,
    enqueueJobRequest: store.enqueueJobRequest,
    featureEnabled: () => true,
    resolveAccountAuthorization: async ({ campaign }) => (
      authorized ? accountAuthorization(campaign) : null
    ),
  };
  const queued = await executionService.enqueueExecution({
    campaignId: store.campaign.id,
    sourcePublishingAuditId: store.audit.id,
    actorUserId: 1,
    expectedPlanHash: store.plan.plan_hash,
    idempotencyKey: 'pilot-create-funding-fence-revoked',
    changeReference: 'OPS-CC-FUNDING-FENCE-REVOKED',
    confirmation: executionConfirmations(),
  }, dependencies);
  const campaignVersion = store.campaign.version;
  store.funding.reserved_amount = 300;
  authorized = false;
  let adapterCalls = 0;
  const result = await executionService.runExecutionJob(
    { execution_id: queued.execution.id },
    { id: queued.job.id },
    {
      ...dependencies,
      getAdapter: () => ({
        ADAPTER_VERSION: googleSearchAdapter.ADAPTER_VERSION,
        async execute() { adapterCalls += 1; return {}; },
      }),
    }
  );

  assert.equal(result.status, 'completed');
  assert.equal(adapterCalls, 0);
  assert.equal(store.executions[0].status, 'manual_recovery_required');
  assert.equal(store.funding.reserved_amount, 300);
  assert.equal(store.ledger.filter((row) => row.entry_type === 'release').length, 0);
  assert.equal(store.campaign.status, 'launching');
  assert.equal(store.campaign.version, campaignVersion);
});

test('verified ENABLED outcome never overwrites a concurrent campaign transition', async () => {
  const { store, dependencies, refs, ownership } = await succeededCreationStore();
  const activation = await executionService.enqueueActivation({
    campaignId: store.campaign.id,
    executionId: store.executions[0].id,
    actorUserId: 1,
    expectedPlanHash: store.plan.plan_hash,
    idempotencyKey: 'helper-activate-concurrent-transition',
    changeReference: 'OPS-HELPER-CONCURRENT-TRANSITION',
    confirmation: activationConfirmations(),
  }, { ...dependencies, getAdapter: () => googleSearchAdapter });
  const initialVersion = store.campaign.version;
  const result = await executionService.runActivationJob(
    { execution_id: store.executions[0].id },
    { id: activation.job.id },
    {
      ...dependencies,
      getAdapter: () => ({
        ADAPTER_VERSION: googleSearchAdapter.ADAPTER_VERSION,
        async activate(_input, adapterDependencies) {
          await adapterDependencies.beforeMutation();
          store.campaign.status = 'blocked';
          store.campaign.version = initialVersion + 1;
          store.campaign.operational_blocker = 'concurrent operator transition';
          return {
            recovered: false,
            provider_refs: refs,
            ownership: { ...ownership, hierarchy_status_at_ownership_check: 'ENABLED' },
          };
        },
      }),
      ensureManagedGoalPolicy: async ({ execution }) => ({
        policy_id: 77,
        stage: 'qualified_lead',
        customer_id: '5992356722',
        campaign_ids: ['200'],
        preview_digest: 'e'.repeat(64),
        outcome: 'applied',
        verification_healthy: true,
        plan_hash: execution.plan_hash,
      }),
    }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.result.provider_enabled_readback_verified, true);
  assert.equal(store.executions[0].status, 'manual_recovery_required');
  assert.equal(store.campaign.status, 'blocked');
  assert.equal(store.campaign.version, initialVersion + 1);
  assert.equal(store.campaign.operational_blocker, 'concurrent operator transition');
  assert.equal(store.funding.reserved_amount, 450);
});

test('expired activation lease is fenced over and exact ENABLED recovery finalizes without another mutation', async () => {
  const { store, dependencies, refs, ownership } = await succeededCreationStore();
  const activation = await executionService.enqueueActivation({
    campaignId: store.campaign.id,
    executionId: store.executions[0].id,
    actorUserId: 1,
    expectedPlanHash: store.plan.plan_hash,
    idempotencyKey: 'helper-activate-expired-lease-recovery',
    changeReference: 'OPS-HELPER-EXPIRED-LEASE-RECOVERY',
    confirmation: activationConfirmations(),
  }, { ...dependencies, getAdapter: () => googleSearchAdapter });
  Object.assign(store.executions[0], {
    status: 'activating',
    lease_owner: 'crashed-worker',
    lease_version: 1,
    lease_expires_at: new Date(Date.now() - 60_000),
  });
  const staleApproval = new Date(Date.now() - 25 * 60 * 60 * 1000);
  store.executions[0].activation_requested_at = staleApproval;
  store.executions[0].activation_authorization_snapshot = {
    ...store.executions[0].activation_authorization_snapshot,
    approved_at: staleApproval.toISOString(),
  };
  let providerMutations = 0;
  let recoveryReadbacks = 0;
  let goalPolicyCalls = 0;
  const result = await executionService.runActivationJob(
    { execution_id: store.executions[0].id },
    { id: activation.job.id },
    {
      ...dependencies,
      getAdapter: () => ({
        ADAPTER_VERSION: googleSearchAdapter.ADAPTER_VERSION,
        async recoverActivation() {
          recoveryReadbacks += 1;
          return {
            recovered: true,
            recovered_after_restart: true,
            provider_mutation_performed: false,
            provider_refs: refs,
            ownership: { ...ownership, hierarchy_status_at_ownership_check: 'ENABLED' },
            previous_status: 'PAUSED',
            current_status: 'ENABLED',
          };
        },
        async activate() {
          providerMutations += 1;
          throw new Error('recovery must not repeat activation');
        },
      }),
      ensureManagedGoalPolicy: async () => {
        goalPolicyCalls += 1;
        throw new Error('recovery must run before goal policy');
      },
    }
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.result.recovered_after_ambiguous_response, true);
  assert.equal(providerMutations, 0);
  assert.equal(recoveryReadbacks, 1);
  assert.equal(goalPolicyCalls, 0);
  assert.equal(store.executions[0].status, 'active');
  assert.equal(store.executions[0].lease_version, 2);
  assert.equal(store.executions[0].lease_owner, null);
  assert.equal(store.campaign.status, 'active');
});

test('rollback enqueue fence rejects later campaign drift without provider or funding mutation', async () => {
  const { store, dependencies } = await succeededCreationStore();
  const rollback = await executionService.enqueueRollback({
    campaignId: store.campaign.id,
    executionId: store.executions[0].id,
    actorUserId: 1,
    idempotencyKey: 'helper-rollback-fence-drift',
    confirmRollback: true,
  }, dependencies);
  const authorizedVersion = store.campaign.version;
  store.campaign.version += 1;
  store.campaign.status = 'blocked';
  store.campaign.operational_blocker = 'concurrent change after rollback approval';
  let providerCalls = 0;
  const result = await executionService.runRollbackJob(
    { execution_id: store.executions[0].id },
    { id: rollback.job.id },
    {
      ...dependencies,
      getAdapter: () => ({
        ADAPTER_VERSION: googleSearchAdapter.ADAPTER_VERSION,
        async rollback() { providerCalls += 1; return {}; },
      }),
    }
  );

  assert.equal(result.status, 'completed');
  assert.equal(providerCalls, 0);
  assert.equal(store.executions[0].status, 'manual_recovery_required');
  assert.equal(store.campaign.version, authorizedVersion + 1);
  assert.equal(store.campaign.status, 'blocked');
  assert.equal(store.campaign.operational_blocker, 'concurrent change after rollback approval');
  assert.equal(store.funding.reserved_amount, 450);
  assert.equal(store.ledger.filter((row) => row.entry_type === 'release').length, 0);
});

test('activation expires real authorization evidence before goal policy or provider mutation', async () => {
  const { store, dependencies } = await succeededCreationStore();
  const activation = await executionService.enqueueActivation({
    campaignId: store.campaign.id,
    executionId: store.executions[0].id,
    actorUserId: 1,
    expectedPlanHash: store.plan.plan_hash,
    idempotencyKey: 'helper-activate-stale',
    changeReference: 'OPS-HELPER-STALE',
    confirmation: activationConfirmations(),
  }, { ...dependencies, getAdapter: () => googleSearchAdapter });
  const stale = new Date(Date.now() - 25 * 60 * 60 * 1000);
  store.executions[0].activation_requested_at = stale;
  store.executions[0].activation_authorization_snapshot = {
    ...store.executions[0].activation_authorization_snapshot,
    approved_at: stale.toISOString(),
  };
  let goalPolicyCalls = 0;
  let providerCalls = 0;
  const result = await executionService.runActivationJob(
    { execution_id: store.executions[0].id },
    { id: activation.job.id },
    {
      ...dependencies,
      getAdapter: () => ({
        ADAPTER_VERSION: googleSearchAdapter.ADAPTER_VERSION,
        async activate() { providerCalls += 1; return {}; },
      }),
      ensureManagedGoalPolicy: async () => { goalPolicyCalls += 1; return {}; },
    }
  );
  assert.equal(result.status, 'failed');
  assert.equal(store.executions[0].status, 'activation_failed');
  assert.equal(goalPolicyCalls, 0);
  assert.equal(providerCalls, 0);
  assert.equal(store.campaign.status, 'blocked');
  assert.equal(store.funding.reserved_amount, 450);
});

test('activation never enables provider when Qualified Lead readback is unhealthy', async () => {
  const { store, dependencies } = await succeededCreationStore();
  const activation = await executionService.enqueueActivation({
    campaignId: store.campaign.id,
    executionId: store.executions[0].id,
    actorUserId: 1,
    expectedPlanHash: store.plan.plan_hash,
    idempotencyKey: 'helper-activate-unhealthy-goal',
    changeReference: 'OPS-HELPER-GOAL',
    confirmation: activationConfirmations(),
  }, { ...dependencies, getAdapter: () => googleSearchAdapter });
  let providerCalls = 0;
  const result = await executionService.runActivationJob(
    { execution_id: store.executions[0].id },
    { id: activation.job.id },
    {
      ...dependencies,
      getAdapter: () => ({
        ADAPTER_VERSION: googleSearchAdapter.ADAPTER_VERSION,
        async activate() { providerCalls += 1; return {}; },
      }),
      ensureManagedGoalPolicy: async ({ execution }) => ({
        stage: 'qualified_lead',
        customer_id: '5992356722',
        campaign_ids: ['200'],
        preview_digest: 'b'.repeat(64),
        outcome: 'applied',
        verification_healthy: false,
        plan_hash: execution.plan_hash,
      }),
    }
  );
  assert.equal(result.status, 'failed');
  assert.equal(store.executions[0].status, 'activation_failed');
  assert.equal(providerCalls, 0);
  assert.equal(store.executions[0].goal_policy_snapshot.stage, 'qualified_lead');
  assert.equal(store.executions[0].goal_policy_snapshot.verification_healthy, false);
  assert.equal(store.executions[0].activation_snapshot.phase, 'goal_policy');
  assert.equal(store.campaign.status, 'blocked');
  assert.equal(store.funding.reserved_amount, 450);
});

test('verified ENABLED readback never enters the provider retry path when local finalization fails', async () => {
  const { store, dependencies, refs, ownership } = await succeededCreationStore();
  const activation = await executionService.enqueueActivation({
    campaignId: store.campaign.id,
    executionId: store.executions[0].id,
    actorUserId: 1,
    expectedPlanHash: store.plan.plan_hash,
    idempotencyKey: 'helper-activate-local-finalize-failure',
    changeReference: 'OPS-HELPER-LOCAL-FINALIZE',
    confirmation: activationConfirmations(),
  }, { ...dependencies, getAdapter: () => googleSearchAdapter });
  let providerCalls = 0;
  let transactionCalls = 0;
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const result = await executionService.runActivationJob(
    { execution_id: store.executions[0].id },
    { id: activation.job.id, attempts: 1, max_attempts: 5 },
    {
      ...dependencies,
      sequelize: {
        async transaction(callback) {
          transactionCalls += 1;
          if (transactionCalls === 5) {
            const error = new Error('database connection lost before local finalize');
            error.code = 'ECONNRESET';
            throw error;
          }
          return callback(transaction);
        },
      },
      getAdapter: () => ({
        ADAPTER_VERSION: googleSearchAdapter.ADAPTER_VERSION,
        async activate() {
          providerCalls += 1;
          return {
            recovered: false,
            provider_refs: refs,
            ownership: { ...ownership, hierarchy_status_at_ownership_check: 'ENABLED' },
          };
        },
      }),
      ensureManagedGoalPolicy: async ({ execution }) => ({
        policy_id: 77,
        stage: 'qualified_lead',
        customer_id: '5992356722',
        campaign_ids: ['200'],
        preview_digest: 'c'.repeat(64),
        outcome: 'applied',
        verification_healthy: true,
        plan_hash: execution.plan_hash,
      }),
    }
  );

  assert.equal(result.status, 'failed');
  assert.equal(result.retryable, false);
  assert.equal(result.result.provider_enabled_readback_verified, true);
  assert.equal(providerCalls, 1);
  assert.equal(store.executions[0].status, 'manual_recovery_required');
  assert.equal(store.executions[0].activation_snapshot.outcome, 'enabled_readback_verified_local_finalize_failed');
  assert.equal(store.executions[0].activation_snapshot.provider_enabled_readback_verified, true);
  assert.equal(store.executions[0].lease_owner, null);
  assert.equal(store.campaign.status, 'blocked');
  assert.match(store.campaign.operational_blocker, /Google ENABLED quedó verificado/);
  assert.equal(store.funding.reserved_amount, 450);
});

test('verified ENABLED readback recovers when local commit succeeded but its response was lost', async () => {
  const { store, dependencies, refs, ownership } = await succeededCreationStore();
  const activation = await executionService.enqueueActivation({
    campaignId: store.campaign.id,
    executionId: store.executions[0].id,
    actorUserId: 1,
    expectedPlanHash: store.plan.plan_hash,
    idempotencyKey: 'helper-activate-local-response-loss',
    changeReference: 'OPS-HELPER-LOCAL-RESPONSE-LOSS',
    confirmation: activationConfirmations(),
  }, { ...dependencies, getAdapter: () => googleSearchAdapter });
  let providerCalls = 0;
  let transactionCalls = 0;
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const result = await executionService.runActivationJob(
    { execution_id: store.executions[0].id },
    { id: activation.job.id, attempts: 1, max_attempts: 5 },
    {
      ...dependencies,
      sequelize: {
        async transaction(callback) {
          transactionCalls += 1;
          const value = await callback(transaction);
          if (transactionCalls === 5) {
            const error = new Error('database commit response lost');
            error.code = 'ECONNRESET';
            throw error;
          }
          return value;
        },
      },
      getAdapter: () => ({
        ADAPTER_VERSION: googleSearchAdapter.ADAPTER_VERSION,
        async activate() {
          providerCalls += 1;
          return {
            recovered: false,
            provider_refs: refs,
            ownership: { ...ownership, hierarchy_status_at_ownership_check: 'ENABLED' },
          };
        },
      }),
      ensureManagedGoalPolicy: async ({ execution }) => ({
        policy_id: 77,
        stage: 'qualified_lead',
        customer_id: '5992356722',
        campaign_ids: ['200'],
        preview_digest: 'd'.repeat(64),
        outcome: 'applied',
        verification_healthy: true,
        plan_hash: execution.plan_hash,
      }),
    }
  );

  assert.equal(result.status, 'completed');
  assert.equal(result.result.recovered_after_local_finalize_response_loss, true);
  assert.equal(providerCalls, 1);
  assert.equal(store.executions[0].status, 'active');
  assert.equal(store.campaign.status, 'active');
  assert.equal(store.funding.reserved_amount, 450);
});

test('missing rollback adapter is terminalized and never leaves a rolling lease', async () => {
  const { store, dependencies } = await succeededCreationStore();
  const rollback = await executionService.enqueueRollback({
    campaignId: store.campaign.id,
    executionId: store.executions[0].id,
    actorUserId: 1,
    idempotencyKey: 'helper-rollback-missing-adapter',
    confirmRollback: true,
  }, dependencies);
  const result = await executionService.runRollbackJob(
    { execution_id: store.executions[0].id },
    { id: rollback.job.id },
    { ...dependencies, getAdapter: () => null }
  );
  assert.equal(result.status, 'failed');
  assert.equal(store.executions[0].status, 'manual_recovery_required');
  assert.equal(store.executions[0].lease_owner, null);
  assert.equal(store.funding.reserved_amount, 450);
});

test('durable schema, background lane and routes expose no deceptive execute shortcut', () => {
  const root = path.resolve(__dirname, '../../..');
  const migration = fs.readFileSync(path.join(root, 'migrations/20260719103000-create-managed-campaign-provider-executions.js'), 'utf8');
  const catalog = fs.readFileSync(path.join(root, 'src/config/scheduledJobCatalog.js'), 'utf8');
  const executor = fs.readFileSync(path.join(root, 'src/services/jobExecutor.service.js'), 'utf8');
  const routes = fs.readFileSync(path.join(root, 'src/routes/adminManagedCampaigns.routes.js'), 'utf8');
  const controller = fs.readFileSync(path.join(root, 'src/controllers/adminManagedCampaigns.controller.js'), 'utf8');
  assert.match(migration, /ManagedCampaignProviderExecutions/);
  assert.match(migration, /managed_campaign_id', 'idempotency_key/);
  assert.match(migration, /manual_recovery_required/);
  assert.match(catalog, /managed_campaign\.google_search_create\.v1/);
  assert.match(catalog, /managed_campaign\.google_search_activate\.v1/);
  assert.match(catalog, /managed_campaign\.google_search_rollback\.v1/);
  assert.match(executor, /runExecutionJob\(payload, jobRequest\)/);
  assert.match(executor, /runActivationJob\(payload, jobRequest\)/);
  assert.match(executor, /runRollbackJob\(payload, jobRequest\)/);
  assert.match(routes, /publishing-executions/);
  assert.match(routes, /publishing-executions\/:executionId\/activate/);
  assert.doesNotMatch(routes, /publishing-execute['"]/);
  assert.match(controller, /managed_execution_activation_endpoint_required/);
  const transitionSource = controller.slice(controller.indexOf('exports.transitionCampaign'));
  const exclusiveGuard = transitionSource.indexOf('requiresManagedCampaignProviderExecutionPath(row)');
  const genericGoalPolicy = transitionSource.indexOf('executeManagedCampaignGoalPolicy');
  assert.ok(exclusiveGuard >= 0 && exclusiveGuard < genericGoalPolicy);
  assert.match(transitionSource, /providerExecutionExclusive && \['launching', 'active'\]\.includes\(nextStatus\)/);
  assert.match(transitionSource, /required_route: nextStatus === 'launching' \? 'provider_execution_create' : 'provider_execution_activate'/);
  assert.match(controller, /Idempotency-Key/);
  assert.match(controller, /enqueueActivation/);
});
