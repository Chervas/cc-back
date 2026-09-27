'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scopeFixture } = require('./fixtures/google_ads_broker_scope.fixture');
const { adsFixture, CUSTOMER } = require('../../../services/integrations-broker/test/google-ads-fixture.cjs');
const { optimizationRows, sectionForQuery } = require('../../../services/integrations-broker/test/google-optimization-fixture.cjs');
const brokerService = require('../../services/googleAdsBroker.service');
const { loadOptimizationPreparation, checkOptimizationPreparation } = require('../../services/campaignWorkspaceOptimizationPreparation.service');
const { GOOGLE_ADS_SCOPE } = require('../../services/googleAdsScopedRuntime.service');
const reference = { provider: 'google_ads', account_id: CUSTOMER, campaign_id: '30' };

function runtime(t) {
  const scope = scopeFixture(); const provider = adsFixture(t);
  scope.mapping.broker_read_connection_ref = scope.binding.connection_ref = 'connection:test';
  scope.state.clinics.forEach(row => { row.estado_clinica = true; });
  scope.state.grants[0].scopeKey = 'group:5'; scope.state.connection.scopes = GOOGLE_ADS_SCOPE;
  for (const field of ['accessToken', 'refreshToken']) Object.defineProperty(scope.state.connection, field, { get() { assert.fail('local credential read'); } });
  provider.policy.grants.forEach(row => { row.tenantRef = 'clinic:59'; });
  const engine = provider.make(provider.store);
  const state = { now: new Date('2026-09-27T12:00:00Z'), permitted: true, events: [], commands: [], rows: optimizationRows(), beforeResponse: null };
  const setting = { id: 'setting', version: 1, scope_type: 'group', scope_id: 5,
    accounts: [{ provider: 'google_ads', account_id: CUSTOMER, include_future: true, campaign_ids: [] }],
    preferences: { mode: 'optimize', signals: { enabled: false, events: [] }, optimization: { actions: ['adjust_bids', 'pause_underperforming_ads'], budget_changes: false } },
    activation: { mode: 'measurement', signals: { enabled: false } }, update: async values => Object.assign(setting, values) };
  const campaign = { ...reference, id: `google_ads:${CUSTOMER}:30`, assigned: true, clinicId: 59 };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = { sequelize: { transaction: async fn => {
    const before = structuredClone({ version: setting.version, events: state.events });
    try { return await fn(transaction); } catch (error) { setting.version = before.version; state.events = before.events; throw error; }
  } }, GrupoClinica: { findByPk: async () => ({ id: 5 }) }, Clinica: { findAll: async () => scope.state.clinics },
  CampaignWorkspaceSetting: { findOne: async () => setting, findByPk: async () => setting, findAll: async () => [setting] },
  CampaignWorkspaceEvent: { findOne: async options => {
    assert.equal(options.where.setting_id, setting.id); assert.equal(options.where.event_type, 'optimization_check');
    return state.events.at(-1) || null;
  }, create: async (row, options) => { assert.equal(options.transaction, transaction); state.events.push(structuredClone(row)); } },
  ClinicGoogleAdsAccount: { findAll: async () => scope.state.mappings },
  GoogleConnectionAssignment: { findAll: async () => scope.state.grants },
  GoogleConnection: { findByPk: async (_id, options) => {
    assert.ok(options.attributes?.every(key => ['id', 'googleUserId', 'scopes'].includes(key)));
    return Object.fromEntries(options.attributes.map(key => [key, scope.state.connection[key]]));
  } },
  ExternalCampaignAssignment: { findAll: async () => [{ status: 'active', clinica_id: 59 }] },
  ExternalCampaignInventory: { findAll: async () => [{ id: 1, destination_detection: {} }] },
  };
  provider.state.response = request => ({ results: structuredClone(state.rows[sectionForQuery(request.json.query)]) });
  const broker = brokerService.createGoogleAdsBroker({ ...scope.options, client: { execute: async command => {
    state.commands.push(structuredClone(command));
    const signed = provider.signed(command); const response = await engine.execute(signed.raw, signed.headers);
    await state.beforeResponse?.(command); return response;
  } } });
  t.mock.method(brokerService, 'forModels', requested => { assert.equal(requested, models); return broker; });
  const options = { models, scope: { groupId: 5, clinicIds: [59, 71] }, actorId: 7,
    loadInventory: async () => ({ campaigns: [campaign] }), hasAccess: async () => state.permitted, now: () => state.now,
    ensureToken: async () => assert.fail('legacy token refresh'), read: async () => assert.fail('legacy GAQL read') };
  return { state, scope, provider, engine, setting, campaign, options,
    read: () => loadOptimizationPreparation({ ...options, input: reference }),
    run: () => checkOptimizationPreparation({ ...options, input: { ...reference, expected_version: setting.version } }) };
}

test('real scoped workspace and signed broker inspect Optimiza without local credentials, writes to Google or activation', async t => {
  const f = runtime(t); const before = JSON.stringify([f.setting.preferences, f.setting.activation, f.setting.accounts]);
  assert.equal((await f.read()).preparation.status, 'unchecked'); assert.equal(f.state.commands.length, 0);
  const response = await f.run(); const result = response.preparation;
  assert.equal(result.status, 'checked'); assert.equal(result.compatible, true); assert.equal(result.authorized, false);
  assert.deepEqual(result.actions.map(row => row.targets), [2, 1, 0, 1]);
  assert.equal(result.actions[3].requested, false); assert.ok(result.actions[2].reasons.includes('search_relevance_required'));
  assert.equal(f.setting.version, 3); assert.equal(f.state.events.length, 2); assert.equal(f.state.commands.length, 3);
  assert.equal(JSON.stringify([f.setting.preferences, f.setting.activation, f.setting.accounts]), before);
  assert.ok(f.state.events.every(row => row.changes.provider_mutation === false));
  assert.doesNotMatch(JSON.stringify(response), /FICTITIOUS_|accessToken|refreshToken|connection:test|fingerprint|run_id|customers\//);
  for (const command of f.state.commands) {
    assert.equal(command.operation, 'google.ads.optimization.read.v1'); assert.equal(command.tenantRef, 'clinic:59');
    assert.deepEqual(Object.keys(command.payload).sort(), ['campaignId', 'pageToken', 'section']);
  }
  assert.equal((await f.read()).preparation.status, 'checked'); assert.equal(f.state.commands.length, 3);
  f.state.now = new Date(+f.state.now + 86400000); assert.equal((await f.read()).preparation.status, 'stale');
});
test('PMax keeps its actual CPA target, shared budgets and incomplete ad delivery never become pausable', async t => {
  const f = runtime(t);
  Object.assign(f.state.rows.campaign[0].campaign, { advertisingChannelType: 'PERFORMANCE_MAX', biddingStrategyType: 'MAXIMIZE_CONVERSIONS',
    maximizeConversions: { targetCpaMicros: '12000000' } });
  f.state.rows.campaign[0].campaignBudget.explicitlyShared = true;
  const result = (await f.run()).preparation;
  assert.deepEqual(result.actions.map(row => row.targets), [0, 1, 0, 0]); assert.equal(f.state.commands.length, 1);
  assert.ok(result.actions[0].reasons.includes('asset_groups_not_individual_ads'));
  assert.ok(result.actions[3].reasons.includes('shared_or_unknown_budget'));
});
test('missing individual delivery evidence does not authorize pausing the final eligible ad', async t => {
  const f = runtime(t); delete f.state.rows.ads[0].adGroupAd.policySummary;
  const result = (await f.run()).preparation;
  assert.equal(result.actions[0].targets, 0); assert.ok(result.actions[0].reasons.includes('no_alternative_active_ad'));
});
test('revocations, replacement bindings, scope and preferences changes during I/O prevent a valid proof and stop subsequent pages', async t => {
  for (const mutate of [f => { f.state.permitted = false; }, f => { f.setting.accounts = []; },
    f => { f.campaign.clinicId = 71; }, f => { f.scope.binding.state = 'revoked'; },
    f => { f.scope.mapping.broker_read_connection_ref = f.scope.binding.connection_ref = 'connection:replacement'; },
    f => { f.setting.preferences.optimization.actions = []; }, f => { f.state.now = new Date(+f.state.now + 120000); },
    f => { f.state.events.at(-1).changes.run_id = 'another-run'; }]) {
    await t.test(mutate.toString(), async t => {
      const f = runtime(t); f.state.beforeResponse = () => mutate(f);
      await assert.rejects(f.run()); assert.equal(f.state.commands.length, 1);
      assert.equal(f.state.events.length, 1); assert.equal(f.state.events[0].changes.status, 'checking');
      assert.equal(f.state.events[0].changes.inspection, undefined);
    });
  }
});
test('pagination uses the original clinic grant throughout an inspection', async t => {
  const f = runtime(t);
  f.state.rows.ad_groups = Array.from({ length: 300 }, (_, index) => {
    const row = optimizationRows().ad_groups[0]; row.adGroup.id = String(50 + index); return row;
  });
  const result = (await f.run()).preparation;
  assert.equal(result.actions[1].targets, 300); assert.equal(f.state.commands.length, 4);
  const calls = f.state.commands.filter(row => row.payload.section === 'ad_groups');
  assert.equal(calls[0].payload.pageToken, null); assert.ok(calls[1].payload.pageToken);
  assert.ok(calls.every(row => row.tenantRef === 'clinic:59' && row.connectionRef === 'connection:test'));
});
test('old broker permissions remove a prior green proof without OAuth fallback, and explicit retry can recover', async t => {
  const f = runtime(t); await f.run();
  const operation = 'google.ads.optimization.read.v1'; const saved = f.engine.operations[operation];
  delete f.engine.operations[operation];
  const result = (await f.run()).preparation;
  assert.equal(result.status, 'failed'); assert.equal(result.error, 'workspace_optimization_service_pending');
  assert.equal(result.compatible, false); assert.deepEqual(result.actions, []);
  assert.equal((await f.read()).preparation.status, 'failed');
  f.engine.operations[operation] = saved;
  assert.equal((await f.run()).preparation.status, 'checked');
});
test('a disabled cohort fails before provider calls and retains the explicit service-prerequisite code', async t => {
  const f = runtime(t); f.scope.state.enabled = false;
  await assert.rejects(f.run(), { code: 'workspace_google_service_pending' });
  assert.equal(f.state.commands.length, 0); assert.equal(f.state.events.length, 0);
});
