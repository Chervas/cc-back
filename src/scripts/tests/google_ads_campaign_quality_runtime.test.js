'use strict';
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, root, read, customer, connection } = require('./fixtures/google_ads_quality_vm.fixture');
const { createRequire } = require('node:module');
const vm = require('node:vm'); const path = require('node:path');
const modelsIndex = path.join(root, 'models/index.js');
assert.equal(require.cache[modelsIndex], undefined, 'the genuine facade must not bootstrap clinical models');
after(() => assert.equal(require.cache[modelsIndex], undefined, 'all scope/reader/facade checks remain metadata fixtures'));
const campaign = id => ({ customer: { id: customer, currencyCode: 'EUR' }, campaign: { id, name: 'Fictitious', status: 'ENABLED',
  primaryStatus: 'ELIGIBLE', optimizationScore: 0.75 }, campaignBudget: { id: '44', name: 'Fictitious budget', amountMicros: '1000000', status: 'ENABLED', period: 'DAILY' },
  metrics: { costMicros: '42', clicks: '2', impressions: '5', conversions: 1.5, allConversions: 2, conversionsValue: 3.5, allConversionsValue: 4 } });
const goal = id => ({ customer: { id: customer }, campaign: { id, name: 'Fictitious' }, conversionGoalCampaignConfig: {
  resourceName: `customers/${customer}/conversionGoalCampaignConfigs/${id}`, campaign: `customers/${customer}/campaigns/${id}`,
  goalConfigLevel: 'CAMPAIGN', customConversionGoal: `customers/${customer}/customConversionGoals/7` }, customConversionGoal: {
  resourceName: `customers/${customer}/customConversionGoals/7`, name: 'Fictitious custom goal', status: 'ENABLED', conversionActions: [`customers/${customer}/conversionActions/3`] } });
const scope = { assignment_scope: 'clinic', clinic_id: 59 };
const input = campaigns => ({ scope, campaigns: campaigns.map(id => ({ customer_id: customer, campaign_id: id })), canonicalTargets: [] });

test('managed quality reaches the genuine facade, opaque scope and typed reader: fixed fields, 30-day metrics, missing-ID existence and named custom goals', async () => {
  const f = fixture();
  const localRequire = createRequire(path.join(root, 'src/services/googleAdsBrokerReader.service.js'));
  const { createGoogleAdsBroker } = localRequire('./googleAdsBroker.service');
  const scoped = require('./fixtures/google_ads_broker_scope.fixture').scopeFixture();
  const contract = localRequire('../../services/integrations-broker/src/google-ads-contract');
  const calls = [];
  const facade = createGoogleAdsBroker({ ...scoped.options, client: { execute: async command => {
    calls.push(command); const payload = command.payload;
    const raw = { results: payload.section === 'metrics' ? [campaign('1')] : payload.section === 'existence' ? [campaign('2')] : payload.campaignIds.map(goal) };
    const projected = contract.projectPage('campaign_quality', raw, payload, { customerId: customer });
    return { requestId: command.requestId, data: { results: projected.results, nextPageToken: null } };
  } } });
  const opaque = await facade.prepare(scoped.mapping);
  const report = await f.service.auditConnectOnlyCampaignQuality({ ...input(['1', '2']), dependencies: {
    resolveRuntime: async () => ({ deliveryMode: 'broker', customerId: customer, account: scoped.mapping, brokerContext: opaque, broker: facade }),
    request: () => { throw Error('MANAGED_TOKEN_FALLBACK_FORBIDDEN'); },
  } });
  assert.equal(report.summary.observed_campaign_count, 2); assert.equal(report.external_mutation_count, 0);
  assert.deepEqual(calls.map(x => x.payload.section), ['metrics', 'existence', 'goals']);
  for (const command of calls) { assert.equal(command.operation, 'google.ads.campaign_quality.read.v1'); assert.equal(command.tenantRef, 'clinic:59');
    assert.equal(Object.hasOwn(command.payload, 'query'), false); assert.equal(Object.hasOwn(command.payload, 'accessToken'), false); }
  assert.ok(scoped.state.calls.filter(x => x.kind === 'mapping').length >= 12); assert.equal(f.state.checks, 0);
  const observed = report.accounts[0].campaigns[0];
  assert.equal(observed.optimization_score, 0.75); assert.equal(observed.budget.name, 'Fictitious budget');
  assert.equal(observed.metrics_30d.all_conversions_value, 4);
});

test('managed failures/revocations never retry a weaker section or read legacy credentials', async () => {
  for (const code of ['asset_revoked', 'scope_denied', 'operation_denied', 'provider_failed']) {
    const f = fixture(); let calls = 0;
    const report = await f.service.auditConnectOnlyCampaignQuality({ ...input(['1']), dependencies: {
      resolveRuntime: async () => ({ deliveryMode: 'broker', customerId: customer, brokerContext: {}, broker: { read: async () => {
        calls++; throw Object.assign(Error('optimization_score FICTITIOUS_PRIVATE'), { code });
      } } }), request: () => { throw Error('TOKEN_FALLBACK_FORBIDDEN'); },
    } });
    assert.equal(calls, 1); assert.equal(report.accounts[0].campaigns[0].read_status, 'unavailable');
    assert.equal(f.state.checks, 0); assert.doesNotMatch(JSON.stringify(report), /FICTITIOUS_PRIVATE/);
  }
});

test('legacy requests cross the actual eight-registry guard before and after; late markers discard responses', async () => {
  for (const moment of ['before', 'after', 'none']) {
    const f = fixture(); if (moment === 'before') f.state.blocked = true;
    const report = await f.service.auditConnectOnlyCampaignQuality({ ...input(['1']), dependencies: {
      resolveRuntime: async () => ({ customerId: customer, connection, accessToken: 'FICTITIOUS_NOT_EXPORTED' }),
      request: async (_method, url, options) => {
        f.state.provider++; assert.match(url, /googleAds:search$/); assert.doesNotMatch(url, /mutate|upload/);
        if (moment === 'after') f.state.blocked = true;
        return { results: options.data.query.includes('conversion_goal_campaign_config') ? [goal('1')] : [campaign('1')] };
      },
    } });
    assert.equal(f.state.provider, moment === 'before' ? 0 : moment === 'after' ? 1 : 2);
    assert.equal(report.summary.observed_campaign_count, moment === 'none' ? 1 : 0);
    assert.ok(f.state.checks >= (moment === 'none' ? 32 : 1));
    assert.doesNotMatch(JSON.stringify(report), /FICTITIOUS_NOT_EXPORTED/);
  }
});

test('legacy optimization-score compatibility retries only the fixed legacy query and retains guards', async () => {
  const f = fixture(); const queries = [];
  const report = await f.service.auditConnectOnlyCampaignQuality({ ...input(['1']), dependencies: {
    resolveRuntime: async () => ({ customerId: customer, connection, accessToken: 'FICTITIOUS' }),
    request: async (_method, _url, options) => {
      const query = options.data.query; queries.push(query);
      if (queries.length === 1) throw Error('optimization_score is unavailable');
      return { results: query.includes('conversion_goal_campaign_config') ? [goal('1')] : [campaign('1')] };
    },
  } });
  assert.equal(report.summary.observed_campaign_count, 1); assert.equal(queries.length, 3);
  assert.match(queries[0], /campaign.optimization_score/); assert.doesNotMatch(queries[1], /campaign.optimization_score/);
  assert.ok(f.state.checks >= 40);
});

test('each of the eight registry markers independently closes the legacy auditor before a provider request', async () => {
  for (const registry of ['bindingModel', 'searchConsoleModel', 'analyticsModel', 'propertyRevocationModel', 'adsModel', 'adsRevocationModel', 'enrollmentScopeModel', 'enrollmentRequestModel']) {
    const f = fixture(); f.state.blocked = registry;
    const report = await f.service.auditConnectOnlyCampaignQuality({ ...input(['1']), dependencies: {
      resolveRuntime: async () => ({ customerId: customer, connection, accessToken: 'FICTITIOUS' }),
      request: () => { f.state.provider++; throw Error('PROVIDER_FORBIDDEN_AFTER_MARKER'); },
    } });
    assert.equal(f.state.provider, 0, registry); assert.equal(report.summary.observed_campaign_count, 0, registry);
    assert.equal(report.accounts[0].error.code, 'google_oauth_legacy_closed', registry);
  }
});

test('all seven original quality/GoalPolicy audit assertion groups remain portable without models bootstrap', async () => {
  const source = read('src/scripts/tests/google_ads_connect_only_quality_audit.test.js');
  assert.doesNotMatch(source, /require\(['"]\.\.\/\.\.\/\.\.\/models/);
  const names = ['testGaqlAndMapping', 'testReadOnlyAuditBatchesRequests', 'testReadOnlyAuditChunksLargeAccountsWithoutFalseMissing',
    'testQualityScopeUnionsMeasurementAndStrategyCampaignsByAccount', 'testMeasurementUnionCannotBypassScopedRuntime',
    'testDiscoveryIncludesConnectOnlyWhenGoalPolicyDisabled', 'testPersistedStatusReportIsAllowlisted'];
  const body = source.slice(0, source.lastIndexOf('\nmain()')) + '\nmodule.exports={' + names.join(',') + '};';
  const module = { exports: {} };
  const fixtureModule = require('./fixtures/google_ads_quality_vm.fixture');
  vm.runInNewContext(body, { require: name => {
    if (name === './fixtures/google_ads_quality_vm.fixture') return fixtureModule;
    throw Error('UNEXPECTED_IMPORT:' + name);
  }, module, exports: module.exports, console, Buffer, Date, Map, Set }, { filename: 'original-quality-assertions.vm.cjs' });
  for (const name of names) await module.exports[name]();
});


test('genuine facade rejects the old three-argument ABI and forged account/context before broker transport', async () => {
  const localRequire = createRequire(path.join(root, 'src/services/googleAdsBroker.service.js'));
  const { createGoogleAdsBroker } = localRequire('./googleAdsBroker.service');
  const scoped = require('./fixtures/google_ads_broker_scope.fixture').scopeFixture(); let requests = 0;
  const facade = createGoogleAdsBroker({ ...scoped.options, client: { execute: async () => { requests++; throw Error('TRANSPORT_MUST_NOT_RUN'); } } });
  const context = await facade.prepare(scoped.mapping);
  const payload = { campaignIds: ['1'], section: 'metrics', includeOptimizationScore: true };
  await assert.rejects(facade.read(context, 'campaign_quality', payload), { code: 'broker_binding_invalid' });
  await assert.rejects(facade.read({ ...scoped.mapping, id: 999 }, context, 'campaign_quality', payload), { code: 'broker_binding_invalid' });
  await assert.rejects(facade.read(scoped.mapping, {}, 'campaign_quality', payload), { code: 'broker_binding_invalid' });
  assert.equal(requests, 0);
});

test('actual facade revocation during quality transport discards the rows with no token fallback', async () => {
  const f = fixture();
  const localRequire = createRequire(path.join(root, 'src/services/googleAdsBroker.service.js'));
  const { createGoogleAdsBroker } = localRequire('./googleAdsBroker.service');
  const contract = localRequire('../../services/integrations-broker/src/google-ads-contract');
  const scoped = require('./fixtures/google_ads_broker_scope.fixture').scopeFixture(); let requests = 0;
  const facade = createGoogleAdsBroker({ ...scoped.options, client: { execute: async command => {
    requests++; scoped.state.bindings[0].state = 'revoked';
    return { requestId: command.requestId, data: { results: contract.projectPage('campaign_quality', { results: [campaign('1')] },
      command.payload, { customerId: customer }).results, nextPageToken: null } };
  } } });
  const context = await facade.prepare(scoped.mapping);
  const report = await f.service.auditConnectOnlyCampaignQuality({ ...input(['1']), dependencies: {
    resolveRuntime: async () => ({ deliveryMode: 'broker', customerId: customer, account: scoped.mapping, brokerContext: context, broker: facade }),
    request: () => { throw Error('TOKEN_FALLBACK_FORBIDDEN'); },
  } });
  assert.equal(requests, 1); assert.equal(report.summary.observed_campaign_count, 0);
  assert.equal(report.accounts[0].campaigns[0].read_status, 'unavailable'); assert.equal(f.state.checks, 0);
});
