'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { adsFixture, CUSTOMER, ACCESS } = require('./google-ads-fixture.cjs');
const { destinationRows } = require('./google-campaign-destinations-fixture.cjs');
const contract = require('../src/google-ads-contract');
const destinations = require('../src/google-campaign-destinations-contract');
const payload = section => ({ section, campaignId: '30', pageToken: null });

test('fixed destination queries preserve canonical customer IDs that start with zero', () => {
  assert.match(contract.query('campaign_destinations', payload('asset_groups'), { customerId: '0123456789' }), /customers\/0123456789\/campaigns\/30/);
});

test('all destination sections use fixed read-only queries and project only metadata', async t => {
  const f = adsFixture(t); const data = destinationRows();
  for (const section of destinations.SECTIONS) {
    const input = data[section][0];
    input.ignored = ACCESS;
    if (input.asset) input.asset.leadFormAsset.deliveryMethods = [{ webhook: { advertiserWebhookKey: ACCESS } }];
    f.state.response = { results: [input] };
    const response = await f.execute('campaign_destinations', payload(section));
    assert.equal(response.data.results.length, 1);
    assert.doesNotMatch(JSON.stringify(response), /FICTITIOUS_ADS_ACCESS|ignored|deliveryMethods|advertiserWebhookKey/);
    assert.equal(response.data.nextPageToken, null);
  }
  assert.equal(f.state.calls.length, 8);
  for (const call of f.state.calls) {
    assert.match(call.json.query, /^SELECT .* LIMIT 2001$/);
    assert.doesNotMatch(call.json.query, /submission|delivery_method|webhook|email|phone/);
    assert.equal(call.path, `/v24/customers/${CUSTOMER}/googleAds:search`);
  }
});
test('destination operation refuses arbitrary queries, owners, injected identifiers and sections before secret reads', async t => {
  const f = adsFixture(t);
  for (const change of [{ section: 'leads' }, { campaignId: null }, { campaignId: '30 OR 1=1' },
    { query: 'SELECT * FROM customer' }, { customerId: CUSTOMER }, { loginCustomerId: '9999999999' }, { section: undefined }]) {
    await assert.rejects(f.execute('campaign_destinations', { ...payload('campaign'), ...change }), { code: 'invalid_request' });
  }
  assert.equal(f.state.sdk.length, 0); assert.equal(f.state.calls.length, 0);
});
test('destination projection rejects foreign identities, disabled links and malformed metadata', async t => {
  const f = adsFixture(t);
  for (const [section, mutate] of [
    ['campaign', row => { row.customer.id = '9999999999'; }],
    ['campaign', row => { row.campaign.id = '31'; }],
    ['campaign', row => { row.campaign.assetAutomationSettings = [{ assetAutomationType: 'FINAL_URL_EXPANSION_TEXT_ASSET_AUTOMATION' }]; }],
    ['asset_groups', row => { row.assetGroup.campaign = `customers/${CUSTOMER}/campaigns/31`; }],
    ['campaign_forms', row => { row.campaignAsset.status = 'PAUSED'; }],
    ['account_forms', row => { row.asset.leadFormAsset.headline = ''; }],
    ['ads', row => { row.adGroupAd.ad.finalUrls = ['https://user:password@clinic.example']; }],
  ]) {
    const row = destinationRows()[section][0]; mutate(row); f.state.response = { results: [row] };
    await assert.rejects(f.execute('campaign_destinations', payload(section)), { code: 'provider_failed' });
  }
});
test('destination pagination retains multiple form links and binds cursors to section and campaign', async t => {
  const f = adsFixture(t);
  f.state.response = { results: Array.from({ length: 300 }, (_, i) => {
    const row = destinationRows().ad_group_forms[0]; row.asset.id = String(100 + i); return row;
  }) };
  const first = (await f.execute('campaign_destinations', payload('ad_group_forms'))).data;
  assert.equal(first.results.length, 250);
  assert.equal(new Set(first.results.map(contract.rowKey)).size, 250);
  const second = (await f.execute('campaign_destinations', { ...payload('ad_group_forms'), pageToken: first.nextPageToken })).data;
  assert.equal(second.results.length, 50); assert.equal(second.nextPageToken, null); assert.equal(f.state.calls.length, 1);
  for (const change of [{ section: 'account_forms' }, { campaignId: '31' }]) {
    await assert.rejects(f.execute('campaign_destinations', { ...payload('ad_group_forms'), pageToken: first.nextPageToken, ...change }), { code: 'invalid_request' });
  }
  f.state.response = { results: Array(2001).fill(destinationRows().ad_groups[0]) };
  await assert.rejects(f.execute('campaign_destinations', payload('ad_groups')), { code: 'provider_failed' });
});
test('destination responses are discarded on revocation and metadata never becomes durable command output', async t => {
  const f = adsFixture(t); f.state.response = { results: destinationRows().ads };
  await f.execute('campaign_destinations', payload('ads'));
  const durable = JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all()) + JSON.stringify(f.store.db.prepare('SELECT * FROM audit_outbox').all());
  assert.doesNotMatch(durable, /clinic\.example|RESPONSIVE_SEARCH_AD|FICTITIOUS_ADS/);
  f.state.onRead = () => f.revoke();
  await assert.rejects(f.execute('campaign_destinations', payload('ads')));
  const count = f.state.sdk.length;
  await assert.rejects(f.execute('campaign_destinations', payload('ads')), { code: 'asset_revoked' });
  assert.equal(f.state.sdk.length, count);
});
test('account-level form cursors cannot be moved to another campaign even though the underlying GAQL is identical', async t => {
  const f = adsFixture(t);
  f.state.response = { results: Array.from({ length: 300 }, (_, i) => {
    const row = destinationRows().account_forms[0]; row.asset.id = String(100 + i); return row;
  }) };
  const first = (await f.execute('campaign_destinations', payload('account_forms'))).data;
  assert.ok(first.nextPageToken);
  await assert.rejects(f.execute('campaign_destinations', { ...payload('account_forms'), pageToken: first.nextPageToken, campaignId: '31' }), { code: 'invalid_request' });
  assert.equal(f.state.calls.length, 1);
});
