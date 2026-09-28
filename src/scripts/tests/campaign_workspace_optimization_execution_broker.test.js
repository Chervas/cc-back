'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { fixture, error } = require('./fixtures/campaign_workspace_optimization_execution.fixture');
const { scopeFixture } = require('./fixtures/google_ads_broker_scope.fixture');
const { adsFixture, CUSTOMER } = require('../../../services/integrations-broker/test/google-ads-fixture.cjs');
const { optimizationRows, sectionForQuery } = require('../../../services/integrations-broker/test/google-optimization-fixture.cjs');
const { optimizationChange } = require('../../services/campaignWorkspaceOptimizationCommand.service');
const { resolveGoogleAdsGrantTransport } = require('../../services/googleAdsGrantTransport.service');
const { GOOGLE_ADS_SCOPE } = require('../../services/googleAdsScopedRuntime.service');
const { CHECK_JOB_TYPE, LEASE_MS } = require('../../services/campaignWorkspaceOptimizationExecution.service');
const brokerService = require('../../services/googleAdsBroker.service');

async function runtime(t) {
  const f = fixture(); const scope = scopeFixture(); const provider = adsFixture(t);
  scope.mapping.broker_read_connection_ref = scope.binding.connection_ref = 'connection:test';
  scope.state.clinics[0].id_clinica = scope.binding.tenant_clinic_id = 1;
  scope.state.connection.scopes = GOOGLE_ADS_SCOPE;
  for (const key of ['accessToken', 'refreshToken']) Object.defineProperty(scope.state.connection, key, { get() { assert.fail('local token read'); } });
  provider.policy.grants.forEach(row => { row.tenantRef = 'clinic:1'; });
  const engine = provider.make(provider.store); const state = { commands: [], rows: optimizationRows(), beforeResponse: null, expected: [] };
  const models = f.deps.models;
  models.GoogleConnection = { findByPk: async (id, options) => {
    assert.equal(id, 2); assert.ok(options.attributes.every(key => ['id', 'googleUserId', 'scopes'].includes(key)));
    return Object.fromEntries(options.attributes.map(key => [key, scope.state.connection[key]]));
  } };
  const broker = brokerService.createGoogleAdsBroker({ ...scope.options, client: { execute: async command => {
    state.commands.push(structuredClone(command)); const signed = provider.signed(command);
    const response = await engine.execute(signed.raw, signed.headers); await state.beforeResponse?.(); return response;
  } } });
  t.mock.method(brokerService, 'forModels', requested => { assert.equal(requested, models); return broker; });
  const transport = await resolveGoogleAdsGrantTransport({ models, accounts: [scope.mapping], requiredScopes: [GOOGLE_ADS_SCOPE] });
  const change = optimizationChange({ ...f.change, reference: { ...f.change.reference, account_id: CUSTOMER },
    target: { ...f.change.target, resource: `customers/${CUSTOMER}/adGroups/50` } });
  f.source.context.reference = change.reference;
  Object.assign(f.source.context.campaign, change.reference);
  Object.assign(f.source.context.grant, transport, { loginCustomerId: scope.mapping.loginCustomerId });
  f.source.entry.targets = [change.target];
  const authorize = f.deps.authorize;
  f.deps.authorize = async input => {
    state.expected.push(input.expectedBrokerGrant);
    const result = await authorize(input); result.context.grant = f.source.context.grant; return result;
  };
  f.deps.ensureToken = async () => assert.fail('legacy refresh');
  f.deps.providerDependencies = { googleRead: async () => assert.fail('legacy read'), googleWrite: async () => assert.fail('legacy write') };
  f.deps.inspect = async () => assert.fail('unmigrated preflight');
  f.deps.mutate = async () => assert.fail('advertising write');
  delete f.deps.read;
  provider.state.response = request => {
    const section = sectionForQuery(request.json.query); const rows = structuredClone(state.rows[section]);
    if (section === 'ad_groups') rows.find(row => row.adGroup.id === '50').adGroup.cpcBidMicros = f.state.remote;
    return { results: rows };
  };
  const enqueue = patch => f.enqueue({ change, evidence: f.proof(change), ...patch });
  const submitted = () => {
    Object.assign(f.row(), { submitted_at: new Date(f.state.now), status: 'uncertain' });
    f.state.jobs.get(1).type = CHECK_JOB_TYPE;
  };
  return { ...f, change, enqueue, submitted, brokerState: state, scope, provider, engine, grant: transport.brokerGrant };
}

test('signed broker reads reconcile a submitted command without tokens, legacy GAQL or another write', async t => {
  const f = await runtime(t); await f.enqueue(); f.submitted();
  f.state.remote = f.change.after; f.setting.activation.optimization.status = 'paused';
  const result = await f.run();
  assert.equal(result.result.state, 'observed'); assert.equal(result.result.reason, 'desired_state_observed');
  assert.equal(result.result.provider_mutation, false); assert.equal(f.row().lease_token, null);
  assert.ok(f.brokerState.expected.includes(f.grant));
  assert.equal(f.brokerState.commands.length, 1); const command = f.brokerState.commands[0];
  assert.equal(command.operation, 'google.ads.optimization.read.v1'); assert.equal(command.tenantRef, 'clinic:1');
  assert.deepEqual(command.payload, { campaignId: '30', section: 'ad_groups', pageToken: null });
  assert.doesNotMatch(JSON.stringify([result, f.row()]), /FICTITIOUS|accessToken|refreshToken|connection:test/);
  assert.equal((await f.run()).result.idempotent, true); assert.equal(f.brokerState.commands.length, 1);
});
test('unconfirmed submitted work stays uncertain; unsupported fresh writes stop before submission and evidence collectors', async t => {
  for (const submitted of [false, true]) await t.test(String(submitted), async t => {
    const f = await runtime(t); await f.enqueue(); if (submitted) f.submitted();
    const result = await f.run();
    assert.equal(result.result.state, submitted ? 'uncertain' : 'skipped');
    assert.equal(result.result.reason, submitted ? 'workspace_optimization_manual_review_required' : 'workspace_optimization_service_pending');
    assert.equal(Boolean(f.row().submitted_at), submitted); assert.equal(f.brokerState.commands.length, 1);
    assert.equal(f.state.calls.mutate, 0); assert.equal(f.state.calls.inspect, 0);
  });
});
test('an already-present desired value is observed, never attributed to a new broker mutation', async t => {
  const f = await runtime(t); await f.enqueue(); f.state.remote = f.change.after;
  const result = await f.run(); assert.equal(result.result.state, 'observed');
  assert.equal(result.result.provider_mutation, false); assert.equal(f.row().submitted_at, null);
});
test('paged readback pins the original binding and checks the mandate between broker pages', async t => {
  const f = await runtime(t);
  f.brokerState.rows.ad_groups = Array.from({ length: 300 }, (_, index) => {
    const row = optimizationRows().ad_groups[0]; row.adGroup.id = String(50 + index); return row;
  });
  await f.enqueue(); f.submitted(); f.state.remote = f.change.after;
  assert.equal((await f.run()).result.state, 'observed'); assert.equal(f.brokerState.commands.length, 2);
  assert.equal(f.brokerState.commands[0].payload.pageToken, null); assert.ok(f.brokerState.commands[1].payload.pageToken);
  assert.ok(f.brokerState.commands.every(row => row.connectionRef === 'connection:test' && row.tenantRef === 'clinic:1'));
  assert.ok(f.brokerState.expected.filter(Boolean).every(value => value === f.grant));
});
test('revocation, ACL loss, changed grant/scope/lease and a closed gate cannot leave a green receipt', async t => {
  const changes = [
    ['ACL', f => { f.state.permitted = false; }],
    ['revoked', f => { f.scope.binding.state = 'revoked'; }],
    ['replacement', f => { f.scope.mapping.broker_read_connection_ref = f.scope.binding.connection_ref = 'connection:replacement'; }],
    ['clinic', f => { f.source.entry.clinic_id = 71; }],
    ['mandate', f => { f.setting.activation.optimization.id = randomUUID(); }],
    ['expiry', f => { f.state.now = new Date(+f.state.now + LEASE_MS); }],
    ['invalid expiry', f => { f.row().lease_until = 'invalid'; }],
    ['gate', f => { f.deps.env.CAMPAIGN_WORKSPACE_OPTIMIZATION_ENABLED = 'false'; }],
  ];
  for (const [name, mutate] of changes) await t.test(name, async t => {
    const f = await runtime(t); await f.enqueue(); f.submitted(); f.state.remote = f.change.after;
    f.brokerState.beforeResponse = () => mutate(f);
    assert.equal((await f.run()).result.state, 'uncertain'); assert.equal(f.row().status, 'uncertain');
    assert.equal(f.brokerState.commands.length, 1); assert.equal(f.state.calls.mutate, 0);
  });
});
test('final transaction rechecks authorization, and a stolen lease cannot be overwritten by a stale reader', async t => {
  for (const phase of ['commit', 'lease']) await t.test(phase, async t => {
    const f = await runtime(t); await f.enqueue(); f.submitted(); f.state.remote = f.change.after;
    if (phase === 'commit') {
      const transaction = f.deps.models.sequelize.transaction; let transactions = 0;
      f.deps.models.sequelize.transaction = fn => transaction(async tx => {
        if (++transactions === 2) f.state.permitted = false;
        return fn(tx);
      });
    } else f.brokerState.beforeResponse = () => { f.row().lease_token = 'new-owner'; };
    const result = await f.run();
    if (phase === 'commit') assert.equal(result.result.state, 'uncertain');
    else { assert.equal(result.retryable, true); assert.equal(f.row().lease_token, 'new-owner'); }
    assert.notEqual(f.row().status, 'observed'); assert.equal(f.state.calls.mutate, 0);
  });
});
test('missing broker operation is a service prerequisite, not OAuth, and provider errors have no legacy fallback', async t => {
  for (const [code, expected] of [['operation_denied', 'workspace_optimization_service_pending'],
    ['credential_revoked', 'workspace_optimization_permissions_required'], ['provider_timeout', 'workspace_optimization_timeout'],
    ['rate_limited', 'workspace_optimization_rate_limited'], ['provider_failed', 'workspace_optimization_unavailable']]) {
    await t.test(code, async t => {
      const f = await runtime(t); await f.enqueue(); f.submitted();
      if (code === 'operation_denied') delete f.engine.operations['google.ads.optimization.read.v1'];
      else f.brokerState.beforeResponse = () => { throw error(code); };
      const result = await f.run(); assert.equal(result.result.state, 'uncertain'); assert.equal(result.result.reason, expected);
      assert.equal(f.brokerState.commands.length, 1); assert.equal(f.state.calls.mutate, 0);
    });
  }
});
test('revocation before execution never reaches secrets or Google, and pagination stops on ACL loss', async t => {
  for (const phase of ['before', 'between-pages']) await t.test(phase, async t => {
    const f = await runtime(t); await f.enqueue(); f.submitted(); f.state.remote = f.change.after;
    if (phase === 'before') f.scope.binding.state = 'revoked';
    else {
      f.brokerState.rows.ad_groups = Array.from({ length: 300 }, (_, index) => {
        const row = optimizationRows().ad_groups[0]; row.adGroup.id = String(50 + index); return row;
      });
      f.brokerState.beforeResponse = () => { f.state.permitted = false; };
    }
    assert.equal((await f.run()).result.state, 'uncertain');
    assert.equal(f.brokerState.commands.length, phase === 'before' ? 0 : 1);
    if (phase === 'before') assert.equal(f.provider.state.sdk.length, 0);
    assert.equal(f.state.calls.mutate, 0);
  });
});
test('the total readback deadline includes the final scope/lease check', async t => {
  const f = await runtime(t); await f.enqueue(); f.submitted(); f.state.remote = f.change.after;
  let clock = Date.now(); t.mock.method(Date, 'now', () => clock);
  f.brokerState.beforeResponse = () => { clock += 15001; };
  const result = await f.run(); assert.equal(result.result.state, 'uncertain');
  assert.equal(result.result.reason, 'workspace_optimization_timeout'); assert.equal(f.state.calls.mutate, 0);
});
