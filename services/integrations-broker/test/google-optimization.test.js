'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { adsFixture, CUSTOMER, ACCESS } = require('./google-ads-fixture.cjs');
const { optimizationRows } = require('./google-optimization-fixture.cjs');
const contract = require('../src/google-ads-contract');
const optimization = require('../src/google-optimization-contract');
const payload = section => ({ section, campaignId: '30', pageToken: null });

test('optimization exposes only three fixed read-only metadata sections', async t => {
  const f = adsFixture(t); const data = optimizationRows();
  for (const section of optimization.SECTIONS) {
    const input = structuredClone(data[section]);
    for (const row of input) {
      row.ignored = ACCESS; row.campaign.finalUrlSuffix = ACCESS;
      if (row.adGroupAd) row.adGroupAd.ad.finalUrls = ['https://private.example'];
    }
    f.state.response = { results: input };
    const response = await f.execute('optimization', payload(section));
    assert.deepEqual(response.data.results, data[section]);
    assert.doesNotMatch(JSON.stringify(response), /FICTITIOUS_ADS|private.example|finalUrlSuffix|ignored/);
  }
  assert.equal(f.state.calls.length, 3);
  for (const call of f.state.calls) {
    assert.match(call.json.query, /^SELECT .*campaign.id = 30.* LIMIT 2001$/);
    assert.equal(call.path, `/v24/customers/${CUSTOMER}/googleAds:search`);
    assert.doesNotMatch(call.json.query, /mutate|keyword.text|submission|webhook|conversion_action|final_urls/);
  }
  const durable = JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all()) + JSON.stringify(f.store.db.prepare('SELECT * FROM audit_outbox').all());
  assert.doesNotMatch(durable, /FICTITIOUS_ADS|1500000|20000000|MANUAL_CPC/);
});
test('optimization rejects untyped requests before reading secrets', async t => {
  const f = adsFixture(t);
  for (const change of [{ section: 'mutate' }, { section: undefined }, { campaignId: null }, { campaignId: '30 OR 1=1' },
    { campaignId: '9'.repeat(21) }, { customerId: CUSTOMER }, { token: ACCESS }, { query: 'SELECT *' }, { changes: [] }]) {
    await assert.rejects(f.execute('optimization', { ...payload('campaign'), ...change }), { code: 'invalid_request' });
  }
  assert.equal(f.state.sdk.length, 0); assert.equal(f.state.calls.length, 0);
});
test('missing optional budget and delivery evidence stays unknown; projection is stable at both boundaries', () => {
  const rows = optimizationRows();
  delete rows.campaign[0].campaignBudget; delete rows.ads[0].adGroupAd.primaryStatus; delete rows.ads[0].adGroupAd.policySummary;
  for (const section of optimization.SECTIONS) {
    const first = contract.projectPage('optimization', { results: rows[section] }, payload(section), { customerId: CUSTOMER });
    assert.deepEqual(contract.projectPage('optimization', first, payload(section), { customerId: CUSTOMER }), first);
    if (section === 'campaign') assert.deepEqual(first.results[0].campaignBudget, {});
    if (section === 'ads') assert.deepEqual(first.results[0].adGroupAd.policySummary, {});
  }
  assert.match(contract.query('optimization', payload('campaign'), { customerId: '0123456789' }), /LIMIT 2001$/);
});
test('projection preserves numeric targets but rejects foreign owners, invalid identities and malformed amounts', async t => {
  const f = adsFixture(t);
  for (const [section, mutate] of [
    ['campaign', row => { row.customer.id = '9999999999'; }], ['campaign', row => { row.campaign.id = '31'; }],
    ['campaign', row => { row.campaignBudget.resourceName = 'customers/9999999999/campaignBudgets/40'; }],
    ['campaign', row => { row.campaignBudget.amountMicros = '-1'; }], ['campaign', row => { row.campaignBudget.referenceCount = 1.5; }],
    ['campaign', row => { row.campaignBudget.explicitlyShared = 'false'; }], ['campaign', row => { row.campaign.targetRoas = { targetRoas: Infinity }; }],
    ['campaign', row => { row.campaign.biddingStrategy = 'https://private.example'; }], ['ad_groups', row => { row.adGroup.id = '0'; }],
    ['ad_groups', row => { row.adGroup.cpcBidMicros = Number.MAX_SAFE_INTEGER + 1; }],
    ['ads', row => { row.adGroupAd.status = 'REMOVED'; }], ['ads', row => { row.adGroupAd.ad.id = '0'; }],
    ['ads', row => { row.adGroupAd.policySummary = []; }],
  ]) {
    const row = optimizationRows()[section][0]; mutate(row); f.state.response = { results: [row] };
    await assert.rejects(f.execute('optimization', payload(section)), { code: 'provider_failed' });
  }
  const row = optimizationRows().campaign[0];
  Object.assign(row.campaign, { biddingStrategy: 'customers/9876543210/biddingStrategies/8', targetRoas: { targetRoas: 2.5 },
    targetCpa: { targetCpaMicros: '12000000' }, maximizeConversions: {}, maximizeConversionValue: { targetRoas: '3.5' } });
  f.state.response = { results: [row] };
  assert.deepEqual((await f.execute('optimization', payload('campaign'))).data.results, [row]);
});
test('pagination is scoped to account, campaign and section, with duplicate and total-row protection', async t => {
  const f = adsFixture(t);
  const rows = count => Array.from({ length: count }, (_, i) => {
    const row = optimizationRows().ad_groups[0]; row.adGroup.id = String(100 + i); return row;
  });
  f.state.response = { results: rows(300) };
  const first = (await f.execute('optimization', payload('ad_groups'))).data;
  assert.equal(first.results.length, 250);
  for (const change of [{ section: 'ads' }, { campaignId: '31' }]) {
    await assert.rejects(f.execute('optimization', { ...payload('ad_groups'), pageToken: first.nextPageToken, ...change }), { code: 'invalid_request' });
  }
  const second = (await f.execute('optimization', { ...payload('ad_groups'), pageToken: first.nextPageToken })).data;
  assert.equal(second.results.length, 50); assert.equal(second.nextPageToken, null); assert.equal(f.state.calls.length, 1);
  for (const bad of [rows(2001), [...rows(1), ...rows(1)]]) {
    f.state.response = { results: bad }; await assert.rejects(f.execute('optimization', payload('ad_groups')), { code: 'provider_failed' });
  }
});
test('operation permission and mid-request revocation fail closed without returning compatibility metadata', async t => {
  const f = adsFixture(t); f.state.response = { results: optimizationRows().campaign };
  const operation = 'google.ads.optimization.read.v1';
  f.policy.grants[0].operations = f.policy.grants[0].operations.filter(name => name !== operation);
  const restricted = f.make(f.store); const request = f.signed(f.command('optimization', payload('campaign')));
  await assert.rejects(restricted.execute(request.raw, request.headers), { code: 'scope_denied' });
  assert.equal(f.state.sdk.length, 0);
  f.policy.grants[0].operations = contract.OPERATIONS;
  f.state.onRead = () => f.revoke();
  await assert.rejects(f.execute('optimization', payload('campaign')));
  const count = f.state.sdk.length;
  await assert.rejects(f.execute('optimization', payload('campaign')), { code: 'asset_revoked' });
  assert.equal(f.state.sdk.length, count);
});
