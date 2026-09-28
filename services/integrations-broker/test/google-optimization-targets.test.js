'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { adsFixture, CUSTOMER, ACCESS } = require('./google-ads-fixture.cjs');
const { targetRows, targetResponse, payload } = require('./google-optimization-targets-fixture.cjs');
const targets = require('../src/google-optimization-targets-contract');
const contract = require('../src/google-ads-contract');
const family = 'optimization_targets';
test('seven closed target sections expose only goal/baseline metadata through the granted ad account', async t => {
  const f = adsFixture(t); const data = targetRows();
  f.state.response = request => {
    const result = targetResponse(data, request);
    for (const row of result.results) { row.patient = 'private@example.test'; row.accessToken = ACCESS;
      if (row.conversionAction) row.conversionAction.name = 'Private lead name'; }
    return result;
  };
  for (const section of targets.SECTIONS) {
    const result = (await f.execute(family, payload(section))).data;
    assert.deepEqual(result.results, data[section]); assert.equal(result.nextPageToken, null);
    assert.deepEqual(contract.projectPage(family, result, payload(section), { customerId: CUSTOMER }).results, data[section]);
    assert.doesNotMatch(JSON.stringify(result), /FICTITIOUS|private|accessToken|name"/);
  }
  assert.equal(f.state.calls.length, 10);
  assert.ok(f.state.calls.every(call => call.path === `/v24/customers/${CUSTOMER}/googleAds:search`
    && !/mutate|\.name\b|metrics\.|lead_form_submission/.test(call.json.query)));
  const durable = JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all()) + JSON.stringify(f.store.db.prepare('SELECT * FROM audit_outbox').all());
  assert.doesNotMatch(durable, /20000000|rec-1|private@example|FICTITIOUS_ADS|QUALIFIED_LEAD/);
});
test('caller cannot choose conversion owner, custom goal, fields, query, credential or provider account', async t => {
  const f = adsFixture(t);
  for (const patch of [{ query: 'SELECT *' }, { conversionCustomerId: '9999999999' }, { customGoalResource: 'customers/1/customConversionGoals/2' },
    { customerId: CUSTOMER }, { accessToken: ACCESS }, { section: 'all' }, { campaignId: '30 OR 1=1' }, { campaignId: null }]) {
    await assert.rejects(f.execute(family, { ...payload('actions'), ...patch }), { code: 'invalid_request' });
  }
  assert.equal(f.state.sdk.length, 0); assert.equal(f.state.calls.length, 0);
});
test('cross-account actions and custom goals use freshly verified ownership without switching HTTP account', async t => {
  const f = adsFixture(t); const data = targetRows('TARGET_CPA', 'SEARCH', '9999999999');
  f.state.response = request => targetResponse(data, request);
  for (const section of ['actions', 'custom_goal']) {
    assert.deepEqual((await f.execute(family, payload(section))).data.results, data[section]);
  }
  assert.ok(f.state.calls.every(call => call.path === `/v24/customers/${CUSTOMER}/googleAds:search`));
  assert.ok(f.state.calls.some(call => call.json.query.includes("owner_customer = 'customers/9999999999'")));
  data.actions[0].conversionAction.ownerCustomer = `customers/${CUSTOMER}`;
  await assert.rejects(f.execute(family, payload('actions')), { code: 'provider_failed' });
});
test('cached action pages remain bound to campaign and freshly verified conversion ownership', async t => {
  const f = adsFixture(t); const data = targetRows(); const seed = data.actions[0];
  data.actions = Array.from({ length: 300 }, (_, i) => ({ ...structuredClone(seed), conversionAction: {
    ...seed.conversionAction, resourceName: `customers/${CUSTOMER}/conversionActions/${90 + i}` } }));
  f.state.response = request => targetResponse(data, request);
  const first = (await f.execute(family, payload('actions'))).data; assert.equal(first.results.length, 250);
  await assert.rejects(f.execute(family, { ...payload('actions'), campaignId: '31', pageToken: first.nextPageToken }), { code: 'invalid_request' });
  data.campaign[0].customer.conversionTrackingSetting.googleAdsConversionCustomer = 'customers/9999999999';
  await assert.rejects(f.execute(family, { ...payload('actions'), pageToken: first.nextPageToken }), { code: 'invalid_request' });
  data.campaign[0].customer.conversionTrackingSetting.googleAdsConversionCustomer = `customers/${CUSTOMER}`;
  const last = (await f.execute(family, { ...payload('actions'), pageToken: first.nextPageToken })).data;
  assert.equal(last.results.length, 50); assert.equal(last.nextPageToken, null);
  assert.equal(f.state.calls.filter(call => /FROM conversion_action\b/.test(call.json.query)).length, 1);
});
test('ambiguous owner lookups, foreign identities and incomplete or oversized provider data fail closed', async t => {
  const f = adsFixture(t);
  for (const section of targets.SECTIONS) {
    const data = targetRows(); data[section][0].customer = { id: '9999999999' };
    f.state.response = request => targetResponse(data, request);
    await assert.rejects(f.execute(family, payload(section)), { code: 'provider_failed' });
  }
  for (const response of [{ results: [] }, { results: [{ customer: { id: CUSTOMER } }] },
    { results: [{ customer: targetRows().campaign[0].customer }], nextPageToken: 'more' }]) {
    f.state.response = response; await assert.rejects(f.execute(family, payload('actions')), { code: 'provider_failed' });
  }
  const data = targetRows(); data.actions = Array(2001).fill(data.actions[0]); f.state.response = request => targetResponse(data, request);
  await assert.rejects(f.execute(family, payload('actions')), { code: 'provider_failed' });
});
test('projection retains precise multipliers and rejects malformed numeric or goal data', async t => {
  const f = adsFixture(t); const data = targetRows();
  data.recommendations[0].recommendation.raiseTargetCpaRecommendation.targetAdjustment.recommendedTargetMultiplier = '1.049999999999';
  f.state.response = request => targetResponse(data, request);
  assert.equal((await f.execute(family, payload('recommendations'))).data.results[0].recommendation.raiseTargetCpaRecommendation.targetAdjustment.recommendedTargetMultiplier, '1.049999999999');
  for (const change of [rows => { rows.actions[0].conversionAction.primaryForGoal = 'true'; },
    rows => { rows.actions[0].conversionAction.valueSettings.defaultValue = -1; },
    rows => { rows.actions[0].conversionAction.clickThroughLookbackWindowDays = '30x'; },
    rows => { rows.actions[0].conversionAction.resourceName = `customers/${CUSTOMER}/conversionActions/1 OR 1=1`; }]) {
    const bad = targetRows(); change(bad); f.state.response = request => targetResponse(bad, request);
    await assert.rejects(f.execute(family, payload('actions')), { code: 'provider_failed' });
  }
});
test('target operation needs its own grant and revocation withholds responses', async t => {
  const f = adsFixture(t); const original = f.policy.grants[0].operations;
  f.policy.grants[0].operations = original.filter(name => name !== 'google.ads.optimization_targets.read.v1');
  const restricted = f.make(f.store); const command = f.signed(f.command(family, payload('campaign')));
  await assert.rejects(restricted.execute(command.raw, command.headers), { code: 'scope_denied' }); assert.equal(f.state.sdk.length, 0);
  f.policy.grants[0].operations = original; f.state.response = request => targetResponse(targetRows(), request);
  f.state.onRead = () => f.revoke(); await assert.rejects(f.execute(family, payload('campaign')));
});
