'use strict';
const assert = require('node:assert/strict');
const { fixture } = require('./campaign_workspace_optimization_execution.fixture');
const { scopeFixture } = require('./google_ads_broker_scope.fixture');
const { setup } = require('../../../../services/integrations-broker/test/google-optimization-writes-fixture.cjs');
const { CUSTOMER } = require('../../../../services/integrations-broker/test/google-ads-fixture.cjs');
const { targetRows, targetResponse } = require('../../../../services/integrations-broker/test/google-optimization-targets-fixture.cjs');
const { signRequest } = require('../../../../services/integrations-broker/src/auth');
const { sectionForQuery } = require('../../../../services/integrations-broker/test/google-optimization-fixture.cjs');
const { optimizationChange } = require('../../../services/campaignWorkspaceOptimizationCommand.service');
const { sourceStamp } = require('../../../services/campaignWorkspaceOptimizationEvidence.service');
const { inspectGoogleTargetSnapshot } = require('../../../services/campaignWorkspaceGoogleTargetSnapshot.service');
const { resolveGoogleAdsGrantTransport } = require('../../../services/googleAdsGrantTransport.service');
const { GOOGLE_ADS_SCOPE } = require('../../../services/googleAdsScopedRuntime.service');
const { CHECK_JOB_TYPE } = require('../../../services/campaignWorkspaceOptimizationExecution.service');
const brokerService = require('../../../services/googleAdsBroker.service');
async function writerFixture(t, kind = 'manual_cpc') {
  const f = fixture(); const scope = scopeFixture(); const provider = setup(t); f.state.now = new Date(provider.state.at);
  scope.mapping.broker_read_connection_ref = scope.binding.connection_ref = 'connection:test';
  scope.state.clinics[0].id_clinica = scope.binding.tenant_clinic_id = 1; scope.state.connection.scopes = GOOGLE_ADS_SCOPE;
  for (const key of ['accessToken', 'refreshToken']) Object.defineProperty(scope.state.connection, key, { get() { assert.fail('legacy credential read'); } });
  provider.policy.grants.forEach(row => { row.tenantRef = 'clinic:1'; }); provider.reset();
  const strategy = { target_cpa: 'TARGET_CPA', maximize_conversions_cpa: 'MAXIMIZE_CONVERSIONS',
    target_roas: 'TARGET_ROAS', maximize_conversion_value_roas: 'MAXIMIZE_CONVERSION_VALUE' }[kind];
  if (strategy) provider.state.rows = targetRows(strategy);
  const state = { commands: [], writerIdentity: 'a'.repeat(64), enabled: true, beforeReadResponse: null, afterWriter: null, beforeWriter: null };
  const models = f.deps.models;
  models.GoogleConnection = { findByPk: async (id, options) => {
    assert.equal(id, 2); assert.ok(options.attributes.every(key => ['id', 'googleUserId', 'scopes'].includes(key)));
    return Object.fromEntries(options.attributes.map(key => [key, scope.state.connection[key]]));
  } };
  let currentRead;
  provider.readState.response = request => {
    if (currentRead.operation === 'google.ads.optimization_targets.read.v1') return targetResponse(provider.state.rows, request);
    if (currentRead.operation === 'google.ads.optimization_budget.read.v1') {
      if (currentRead.payload.section === 'month_cost') return { results: [] };
      const rows = structuredClone(provider.state.rows.campaign);
      if (currentRead.payload.campaignId === '31') {
        rows[0].campaign.id = '31'; rows[0].campaignBudget.resourceName = `customers/${CUSTOMER}/campaignBudgets/41`;
      }
      return { results: rows };
    }
    return { results: structuredClone(provider.state.rows[sectionForQuery(request.json.query)]) };
  };
  const broker = brokerService.createGoogleAdsBroker({ ...scope.options, now: () => +f.state.now,
    client: { execute: async command => {
      state.commands.push(structuredClone(command)); currentRead = command;
      const signed = signRequest(command, { keyId: 'qa-key', privateKey: provider.readerKeys.privateKey,
        audience: provider.policy.audience, now: +f.state.now });
      const result = await provider.getBroker().execute(signed.raw, signed.headers);
      await state.beforeReadResponse?.(command); return result;
    } },
    optimizationEnabled: () => state.enabled,
    optimizationClient: { identity: () => state.writerIdentity, execute: async command => {
      state.commands.push(structuredClone(command)); await state.beforeWriter?.(command);
      const result = await provider.execute(command); await state.afterWriter?.(command); return result;
    } },
  });
  t.mock.method(brokerService, 'forModels', requested => { assert.equal(requested, models); return broker; });
  const transport = await resolveGoogleAdsGrantTransport({ models, accounts: [scope.mapping], requiredScopes: [GOOGLE_ADS_SCOPE] });
  const input = provider.input(kind); const fields = { target_cpa: 'target_cpa.target_cpa_micros', maximize_conversions_cpa: 'maximize_conversions.target_cpa_micros',
    target_roas: 'target_roas.target_roas', maximize_conversion_value_roas: 'maximize_conversion_value.target_roas' };
  const reference = { provider: 'google_ads', account_id: CUSTOMER, campaign_id: '30' };
  const target = kind === 'pause_ad' ? { action: 'pause_underperforming_ads', entity: 'ad', id: '60', group_id: '50', resource: `customers/${CUSTOMER}/adGroupAds/50~60`, field: 'status' }
    : kind === 'daily_budget' ? { action: 'adjust_budget', entity: 'campaign_budget', id: '40', resource: `customers/${CUSTOMER}/campaignBudgets/40`, field: 'amount_micros', unit: 'micros' }
      : strategy ? { action: 'adjust_bids', entity: 'campaign', id: '30', resource: `customers/${CUSTOMER}/campaigns/30`, field: fields[kind], unit: kind.includes('roas') ? 'ratio' : 'micros', strategy }
        : { ...f.change.target, resource: `customers/${CUSTOMER}/adGroups/50` };
  const change = optimizationChange({ reference, target, before: input.before, after: input.after });
  f.source.context.reference = reference; Object.assign(f.source.context.campaign, reference);
  Object.assign(f.source.context.grant, transport, { loginCustomerId: scope.mapping.loginCustomerId }); f.source.entry.targets = [target];
  f.source.limits.currency = 'EUR'; f.setting.version = 1;
  f.setting.accounts = [{ provider: 'google_ads', account_id: CUSTOMER, campaign_ids: ['30', '31'], include_future: false }];
  const campaigns = [f.source.context.campaign, { ...f.source.context.campaign, id: 'campaign-other', campaign_id: '31' }];
  const authorize = f.deps.authorize;
  f.deps.authorize = async options => {
    if (options.expectedBrokerGrant) assert.equal(options.expectedBrokerGrant, transport.brokerGrant);
    const result = await authorize(options); result.context.grant = f.source.context.grant; return result;
  };
  f.deps.budgetDependencies = { now: f.deps.now, loadInventory: async () => ({ campaigns: structuredClone(campaigns) }),
    resolveContext: async options => {
      if (options.expectedBrokerGrant) assert.equal(options.expectedBrokerGrant, transport.brokerGrant);
      return { setting: structuredClone(f.setting), campaign: structuredClone(campaigns.find(c => c.campaign_id === options.reference.campaign_id)), grant: f.source.context.grant };
    }, ensureToken: async () => assert.fail('legacy budget token') };
  delete f.deps.read; delete f.deps.inspect; delete f.deps.mutate;
  f.deps.ensureToken = async () => assert.fail('legacy refresh');
  f.deps.providerDependencies = { googleRead: async () => assert.fail('legacy read'), googleWrite: async () => assert.fail('legacy write') };
  let evidence = f.proof(change);
  if (kind === 'pause_ad') evidence = { schema_version: 2, rule: 'ad_underperformance', policy_version: 1,
    setting_id: f.setting.id, mandate_id: f.setting.activation.optimization.id, clinic_id: 1, reference,
    evaluation_key: 'a'.repeat(64), source_fingerprint: evidence.source_fingerprint, collection_fingerprint: 'b'.repeat(64), observed_at: f.state.now.toISOString(),
    window_start: evidence.window_start, window_end: evidence.window_end, ad_id: '60', baseline_ad_id: '61', group_id: '50',
    daily: evidence.daily.map(day => ({ date: day.date, clicks: 10, leads: 2, cost_micros: '30000000', baseline_clicks: 10, baseline_leads: 2, baseline_cost_micros: '10000000' })),
    metrics: { clicks: 280, leads: 56, cost_cents: 84000, baseline_clicks: 280, baseline_leads: 56, baseline_cost_cents: 28000 } };
  if (strategy) {
    const snapshot = await inspectGoogleTargetSnapshot({ reference, now: f.deps.now, readSection: async section => structuredClone(provider.state.rows[section]) });
    evidence = { schema_version: 5, rule: 'google_target_recommendation', policy_version: 1, setting_id: f.setting.id,
      mandate_id: f.setting.activation.optimization.id, clinic_id: 1,
      source_fingerprint: sourceStamp(f.setting, { groupId: null, clinicIds: [1] }, f.source),
      collection_fingerprint: 'a'.repeat(64), evaluation_key: 'b'.repeat(64), observed_at: f.state.now.toISOString(), snapshot };
  }
  provider.state.afterWrite = request => {
    assert.ok(f.row().submitted_at); assert.equal(f.row().outcome.broker_submission.payload.executionId, f.row().id);
    const update = request.json.operations[0].update;
    const row = kind === 'pause_ad' ? provider.state.rows.ads[0].adGroupAd : kind === 'daily_budget' ? provider.state.rows.campaign[0].campaignBudget
      : kind === 'manual_cpc' ? provider.state.rows.ad_groups[0].adGroup : provider.state.rows.campaign[0].campaign;
    for (const [key, value] of Object.entries(update)) if (key !== 'resourceName') row[key] = structuredClone(value);
  };
  return { ...f, change, evidence, scope, provider, writerState: state, broker, grant: transport.brokerGrant,
    enqueue: patch => f.enqueue({ change, evidence, ...patch }),
    check() { const job = f.state.jobs.get(1); job.type = CHECK_JOB_TYPE; f.row().status = 'uncertain'; },
  };
}
module.exports = { writerFixture };
