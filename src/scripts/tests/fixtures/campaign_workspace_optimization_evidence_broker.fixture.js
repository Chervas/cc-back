'use strict';
const assert = require('node:assert/strict');
const { qualifiedFixture } = require('./campaign_workspace_optimization_evidence.fixture');
const { scopeFixture } = require('./google_ads_broker_scope.fixture');
const { adsFixture, CUSTOMER } = require('../../../../services/integrations-broker/test/google-ads-fixture.cjs');
const { evidenceRows } = require('../../../../services/integrations-broker/test/google-optimization-evidence-fixture.cjs');
const { optimizationRows } = require('../../../../services/integrations-broker/test/google-optimization-fixture.cjs');
const { resolveOptimizationAuthorization } = require('../../../services/campaignWorkspaceOptimizationAuthorization.service');
const { resolveGoogleAdsGrantTransport } = require('../../../services/googleAdsGrantTransport.service');
const { GOOGLE_ADS_SCOPE } = require('../../../services/googleAdsScopedRuntime.service');
const brokerService = require('../../../services/googleAdsBroker.service');

async function evidenceBrokerFixture(t) {
  const f = qualifiedFixture(); const scope = scopeFixture(); const provider = adsFixture(t); const models = f.deps.models;
  scope.mapping.broker_read_connection_ref = scope.binding.connection_ref = 'connection:test';
  scope.state.clinics[0].id_clinica = scope.binding.tenant_clinic_id = 1; scope.state.connection.scopes = GOOGLE_ADS_SCOPE;
  provider.policy.grants.forEach(row => { row.tenantRef = 'clinic:1'; });
  const engine = provider.make(provider.store);
  const state = { commands: [], rows: { ...evidenceRows(), optimization: optimizationRows() }, beforeResponse: null, responseFor: null, expected: [] };
  models.GoogleConnection = { findByPk: async (id, options) => {
    assert.equal(id, 2); assert.ok(options.attributes.every(key => ['id', 'googleUserId', 'scopes'].includes(key)));
    return Object.fromEntries(options.attributes.map(key => [key, scope.state.connection[key]]));
  } };
  const broker = brokerService.createGoogleAdsBroker({ ...scope.options, now: () => f.state.clock, client: { execute: async command => {
    state.commands.push(structuredClone(command));
    provider.state.response = request => state.responseFor ? state.responseFor(command, request) : {
      results: structuredClone(state.rows[command.operation.slice('google.ads.'.length, -'.read.v1'.length)][command.payload.section]),
    };
    const signed = provider.signed(command); const response = await engine.execute(signed.raw, signed.headers);
    await state.beforeResponse?.(command); return response;
  } } });
  t.mock.method(brokerService, 'forModels', requested => { assert.equal(requested, models); return broker; });
  const transport = await resolveGoogleAdsGrantTransport({ models, accounts: [scope.mapping], requiredScopes: [GOOGLE_ADS_SCOPE] });
  const connection = { ...transport.connection };
  for (const name of ['accessToken', 'refreshToken']) Object.defineProperty(connection, name, { get() { assert.fail('legacy credential accessed'); } });
  f.state.grant = { ...f.state.grant, ...transport, connection, loginCustomerId: scope.mapping.loginCustomerId };
  const setting = f.state.setting; const entry = setting.activation.optimization.authorization.campaigns[0];
  f.input.reference.account_id = f.state.workspaceCampaign.account_id = setting.accounts[0].account_id = entry.account_id = CUSTOMER;
  f.state.workspaceCampaign.id = `google_ads:${CUSTOMER}:30`; entry.connection_id = 2; entry.login_customer_id = scope.mapping.loginCustomerId;
  for (const target of entry.targets) target.resource = target.resource.replace('customers/20/', `customers/${CUSTOMER}/`);
  for (const lead of f.state.leads) lead.google_ads_customer_id = CUSTOMER;
  for (const audit of f.state.auditRows) audit.identity.account_id = CUSTOMER;
  f.deps.ensureToken = async () => assert.fail('local token refresh');
  f.deps.googleRequest = async () => assert.fail('legacy Google transport');
  f.deps.metaRead = async () => assert.fail('Meta transport');
  const context = async input => {
    state.expected.push(input.expectedBrokerGrant);
    if (input.expectedBrokerGrant) assert.equal(input.expectedBrokerGrant, transport.brokerGrant);
    if (f.state.onContext) await f.state.onContext(input);
    return { setting: structuredClone(setting), reference: f.input.reference, campaign: structuredClone(f.state.workspaceCampaign), grant: f.state.grant, latest: f.state.latest };
  };
  f.deps.resolveAuthorization = input => resolveOptimizationAuthorization({ ...input, resolveContext: context,
    checkOwnership: async () => { if (!f.state.ownership) throw Object.assign(Error('ownership changed'), { code: 'workspace_optimization_managed_conflict' }); } });
  return { ...f, scope, provider, engine, brokerState: state, grant: transport.brokerGrant, context, entry, setting };
}
module.exports = { evidenceBrokerFixture };
