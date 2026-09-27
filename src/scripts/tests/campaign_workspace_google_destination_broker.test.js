'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { scopeFixture } = require('./fixtures/google_ads_broker_scope.fixture');
const { adsFixture, CUSTOMER } = require('../../../services/integrations-broker/test/google-ads-fixture.cjs');
const { destinationRows, sectionForQuery } = require('../../../services/integrations-broker/test/google-campaign-destinations-fixture.cjs');
const brokerService = require('../../services/googleAdsBroker.service');
const { googleDestinationContext, refreshGoogleDestinations } = require('../../services/campaignWorkspaceGoogleDestination.service');
const { GOOGLE_ADS_SCOPE } = require('../../services/googleAdsScopedRuntime.service');
const now = new Date('2026-09-27T12:00:00Z');
const reference = { account_id: CUSTOMER, campaign_id: '30' };

function runtime(t) {
  const scope = scopeFixture(); const provider = adsFixture(t);
  scope.mapping.broker_read_connection_ref = scope.binding.connection_ref = 'connection:test';
  scope.state.clinics.forEach(row => { row.estado_clinica = true; });
  scope.state.grants[0].scopeKey = 'group:5';
  scope.state.connection.scopes = GOOGLE_ADS_SCOPE;
  for (const field of ['accessToken', 'refreshToken']) Object.defineProperty(scope.state.connection, field, { get() { assert.fail('local credential read'); } });
  provider.policy.grants.forEach(row => { row.tenantRef = 'clinic:59'; });
  const engine = provider.make(provider.store);
  const state = { permitted: true, writes: [], commands: [], rows: destinationRows(),
    cached: { id: 1, destination_detection: { legacy_urls: true } }, beforeResponse: null };
  const setting = { id: 'setting', scope_type: 'group', scope_id: 5,
    accounts: [{ provider: 'google_ads', account_id: CUSTOMER, include_future: true, campaign_ids: [] }] };
  const campaign = { ...reference, provider: 'google_ads', id: `google_ads:${CUSTOMER}:30`, assigned: true, clinicId: 59 };
  const transaction = { LOCK: { UPDATE: 'UPDATE' } };
  const models = { sequelize: { transaction: async fn => fn(transaction) }, GrupoClinica: { findByPk: async () => ({ id: 5 }) },
    Clinica: { findAll: async () => scope.state.clinics },
    CampaignWorkspaceSetting: { findOne: async () => setting, findByPk: async () => setting, findAll: async () => [setting] },
    ClinicGoogleAdsAccount: { findAll: async () => scope.state.mappings },
    GoogleConnectionAssignment: { findAll: async () => scope.state.grants },
    GoogleConnection: { findByPk: async (_id, options) => {
      assert.ok(options.attributes?.every(key => ['id', 'googleUserId', 'scopes'].includes(key)));
      return Object.fromEntries(options.attributes.map(key => [key, scope.state.connection[key]]));
    } },
    ExternalCampaignAssignment: { findAll: async () => [{ status: 'active', clinica_id: 59 }] },
    ExternalCampaignInventory: { findAll: async () => [state.cached], update: async (value, options) => {
      assert.equal(options.transaction, transaction); state.writes.push(value); state.cached = { ...state.cached, ...value };
    } },
  };
  provider.state.response = request => ({ results: structuredClone(state.rows[sectionForQuery(request.json.query)]) });
  const broker = brokerService.createGoogleAdsBroker({ ...scope.options, client: { execute: async command => {
    state.commands.push(structuredClone(command));
    const signed = provider.signed(command); const response = await engine.execute(signed.raw, signed.headers);
    await state.beforeResponse?.(command);
    return response;
  } } });
  t.mock.method(brokerService, 'forModels', requested => { assert.equal(requested, models); return broker; });
  const dependencies = { models, scope: { groupId: 5, clinicIds: [59, 71] }, actorId: 7,
    loadInventory: async () => ({ campaigns: [campaign] }), hasAccess: async () => state.permitted, now: () => now,
    ensureToken: async () => assert.fail('legacy token refresh'), read: async () => assert.fail('legacy GAQL read') };
  const context = () => googleDestinationContext({ ...dependencies, reference: { ...reference, provider: 'google_ads' }, now });
  return { state, scope, provider, engine, setting, campaign, dependencies, context,
    run: async () => refreshGoogleDestinations({ ...dependencies, input: { ...reference, revision: (await context()).revision } }) };
}

test('workspace uses signed typed broker reads and original scoped grants without any local token', async t => {
  const f = runtime(t); await f.run();
  const result = f.state.cached.destination_detection;
  assert.equal(result.legacy_urls, true); assert.equal(result.workspace_google.kind, 'mixed');
  assert.equal(result.workspace_google.complete, true); assert.deepEqual(result.workspace_google.forms.map(row => row.form_id), ['51']);
  assert.deepEqual(result.workspace_google.urls, ['https://clinic.example/visit']);
  assert.equal(f.state.commands.length, 6); assert.equal(f.state.writes.length, 2);
  for (const command of f.state.commands) {
    assert.equal(command.operation, 'google.ads.campaign_destinations.read.v1');
    assert.equal(command.tenantRef, 'clinic:59');
    assert.deepEqual(Object.keys(command.payload).sort(), ['campaignId', 'pageToken', 'section']);
  }
  assert.doesNotMatch(JSON.stringify(f.state.writes), /FICTITIOUS_ADS|connection:test|refreshToken|accessToken/);
});
test('broker PMax discovery keeps asset-group overrides and distinguishes dynamic web coverage', async t => {
  const f = runtime(t); f.state.rows.campaign[0].campaign.advertisingChannelType = 'PERFORMANCE_MAX';
  f.state.rows.ad_groups = []; f.state.rows.ad_group_forms = []; f.state.rows.ads = [];
  await f.run();
  const result = f.state.cached.destination_detection.workspace_google;
  assert.equal(result.status, 'checked'); assert.equal(result.complete, false);
  assert.ok(result.unknown_reasons.includes('dynamic_web_destinations'));
  assert.deepEqual(result.forms.map(row => row.form_id), ['52']); assert.equal(f.state.commands.length, 8);
});
test('a changed ACL, account selection, clinic assignment or original broker binding interrupts reads and prevents a green result', async t => {
  for (const mutate of [f => { f.state.permitted = false; }, f => { f.setting.accounts = []; },
    f => { f.campaign.clinicId = 71; }, f => { f.scope.binding.state = 'revoked'; },
    f => { f.scope.mapping.broker_read_connection_ref = f.scope.binding.connection_ref = 'connection:replacement'; }]) {
    await t.test(mutate.toString(), async t => {
      const f = runtime(t); f.state.beforeResponse = () => mutate(f);
      await assert.rejects(f.run());
      assert.equal(f.state.commands.length, 1); assert.equal(f.state.writes.length, 1);
      assert.equal(f.state.cached.destination_detection.workspace_google.complete, false);
    });
  }
});
test('an older broker without the new read permission fails explicitly and never falls back to legacy', async t => {
  const f = runtime(t);
  delete f.engine.operations['google.ads.campaign_destinations.read.v1'];
  await f.run();
  const result = f.state.cached.destination_detection.workspace_google;
  assert.equal(result.status, 'failed'); assert.equal(result.complete, false);
  assert.equal(result.error, 'workspace_google_service_pending'); assert.equal(f.provider.state.sdk.length, 0);
  assert.deepEqual(result.urls, []); assert.deepEqual(result.forms, []);
  assert.doesNotMatch(JSON.stringify(result), /private/); assert.equal(f.state.commands.length, 1);
});
test('a disabled cohort is a service prerequisite, not a request to reconnect Google', async t => {
  const f = runtime(t); f.scope.state.enabled = false;
  await assert.rejects(f.context(), { code: 'workspace_google_service_pending', status: 409 });
  assert.equal(f.state.commands.length, 0); assert.equal(f.state.writes.length, 0);
});
