'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { adsFixture, syncRow, CUSTOMER, ACCESS, DEVELOPER } = require('./google-ads-fixture.cjs');
const contract = require('../src/google-ads-contract');
const families = ['publishing_campaigns', 'landing_pages', 'ads', 'ad_metrics'];
const payload = family => ({ pageToken: null,
  ...(['landing_pages', 'ad_metrics'].includes(family) ? { startDate: '2026-09-01', endDate: '2026-09-02' } : {}),
  ...(['ads', 'ad_metrics'].includes(family) ? { campaignId: null } : {}) });
test('full sync reads project publishing, observed destinations, creatives and daily ad metrics through fixed templates', async t => {
  const f = adsFixture(t);
  for (const family of families) {
    f.state.response = { results: [{ ...syncRow(family), unknown: ACCESS }] };
    const result = (await f.execute(family, payload(family))).data;
    assert.equal(result.results.length, 1); assert.equal(result.nextPageToken, null);
    assert.doesNotMatch(JSON.stringify(result), /unknown|FICTITIOUS_ADS_ACCESS/);
    const projected = result.results[0];
    if (family === 'publishing_campaigns') assert.equal(projected.campaign.assetAutomationSettings[0].assetAutomationStatus, 'OPTED_OUT');
    if (family === 'landing_pages') assert.equal(projected.metrics.clicks, '3');
    if (family === 'ads') { assert.equal(projected.adGroupAd.ad.responsiveSearchAd.headlines[0].text, 'Fictitious headline'); assert.equal(projected.adGroupAd.policySummary.approvalStatus, 'APPROVED'); }
    if (family === 'ad_metrics') { assert.equal(projected.metrics.costMicros, '42'); assert.equal(projected.adGroupAd.ad.finalUrls, undefined); }
    assert.match(f.state.calls.at(-1).json.query, /LIMIT (5001|100001|200001)$/);
    assert.equal(f.state.calls.at(-1).path, `/v24/customers/${CUSTOMER}/googleAds:search`);
  }
});
test('sync payloads reject arbitrary fields, campaign injection, invalid windows and missing exact keys before secrets', async t => {
  const f = adsFixture(t);
  for (const family of families) for (const extra of [{ query: 'SELECT *' }, { accessToken: ACCESS }, { url: 'https://fictitious.example' }]) {
    await assert.rejects(f.execute(family, { ...payload(family), ...extra }), { code: 'invalid_request' });
  }
  for (const campaignId of ['', 1, '01', '0', '1 OR 1=1', '9'.repeat(21)]) {
    await assert.rejects(f.execute('ads', { ...payload('ads'), campaignId }), { code: 'invalid_request' });
  }
  await assert.rejects(f.execute('ads', { pageToken: null }), { code: 'invalid_request' });
  await assert.rejects(f.execute('landing_pages', { ...payload('landing_pages'), endDate: '2026-10-01' }), { code: 'invalid_request' });
  await assert.rejects(f.execute('ad_metrics', { ...payload('ad_metrics'), endDate: '2026-09-16' }), { code: 'invalid_request' });
  assert.equal(f.state.sdk.length, 0); assert.equal(f.state.calls.length, 0);
});
test('campaign filters and ad identities survive pagination and reject foreign rows or cursor reuse', async t => {
  const f = adsFixture(t); const input = { ...payload('ads'), campaignId: '1' };
  f.state.response = { results: Array.from({ length: 300 }, (_, i) => { const value = syncRow('ads', i + 1); value.campaign.id = '1'; return value; }) };
  const first = (await f.execute('ads', input)).data;
  assert.equal(first.results.length, 250); assert.ok(first.nextPageToken);
  assert.match(f.state.calls[0].json.query, /campaign.id = 1/);
  const last = (await f.execute('ads', { ...input, pageToken: first.nextPageToken })).data;
  assert.equal(last.results.length, 50); assert.equal(last.nextPageToken, null);
  await assert.rejects(f.execute('ads', { ...input, campaignId: '2', pageToken: first.nextPageToken }), { code: 'invalid_request' });
  f.state.response = { results: [syncRow('ads', 2)] };
  await assert.rejects(f.execute('ads', input), { code: 'provider_failed' });
  assert.equal(f.state.calls.length, 2);
});
test('duplicate keys retain ad and landing URL dimensions and reject repeated rows and partial errors', async t => {
  const f = adsFixture(t);
  for (const family of families) {
    f.state.response = { results: [syncRow(family), syncRow(family)] };
    await assert.rejects(f.execute(family, payload(family)), { code: 'provider_failed' });
    for (const field of ['errors', 'partialFailureError', 'partial_failure_error']) {
      f.state.response = { results: [syncRow(family)], [field]: { code: 3 } };
      await assert.rejects(f.execute(family, payload(family)), { code: 'provider_failed' });
    }
  }
  const second = syncRow('landing_pages'); second.landingPageView.unexpandedFinalUrl += '/second';
  f.state.response = { results: [syncRow('landing_pages'), second] };
  assert.equal((await f.execute('landing_pages', payload('landing_pages'))).data.results.length, 2);
});
test('malformed creatives, delivery, destinations and credentials in allowed fields fail without data persistence', async t => {
  const f = adsFixture(t);
  const bad = [
    ['ads', row => { row.adGroupAd.ad.finalUrls = ['javascript:alert(1)']; }],
    ['ads', row => { row.adGroupAd.ad.finalUrls = ['https://user:password@fictitious.example']; }],
    ['ads', row => { row.adGroupAd.ad.responsiveSearchAd.headlines = Array(16).fill({ text: 'x' }); }],
    ['ads', row => { row.adGroupAd.policySummary = 'malformed'; }],
    ['ads', row => { row.adGroupAd.primaryStatusReasons = Array(51).fill('UNKNOWN'); }],
    ['ads', row => { row.adGroupAd.ad.name = DEVELOPER; }],
    ['landing_pages', row => { row.metrics.clicks = '9007199254740992'; }],
    ['landing_pages', row => { row.landingPageView.unexpandedFinalUrl = 'https://fictitious.example/' + ACCESS; }],
    ['publishing_campaigns', row => { row.campaign.status = 'REMOVED'; }],
    ['publishing_campaigns', row => { row.campaign.assetAutomationSettings = [{}]; }],
    ['ad_metrics', row => { row.adGroupAd.ad.id = '0'; }],
  ];
  for (const [family, mutate] of bad) {
    const row = syncRow(family); mutate(row); f.state.response = { results: [row] };
    await assert.rejects(f.execute(family, payload(family)), { code: 'provider_failed' });
  }
  const durable = JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all()) + JSON.stringify(f.store.db.prepare('SELECT * FROM audit_outbox').all());
  assert.doesNotMatch(durable, /FICTITIOUS_ADS|fictitious.example|Fictitious headline/);
});
test('ad metrics accept protobuf zeros and inventory capacity uses its own 200000-row ceiling', () => {
  const row = syncRow('ad_metrics'); delete row.metrics;
  const projected = contract.projectPage('ad_metrics', { results: [row] }, payload('ad_metrics'), { customerId: CUSTOMER });
  assert.deepEqual(projected.results[0].metrics, { impressions: 0, clicks: 0, costMicros: 0, conversions: 0 });
  assert.equal(contract.rowLimit('ads'), 200000); assert.equal(contract.rowLimit('ad_metrics'), 200000);
  assert.equal(contract.rowLimit('publishing_campaigns'), 5000);
  assert.match(contract.query('landing_pages', { ...payload('landing_pages'), endDate: '2026-09-30' }), /2026-09-30/);
});
test('ad inventory pages continue beyond the campaign metrics ceiling without dropping rows or repeating Google searches', async t => {
  const f = adsFixture(t); let pages = 0;
  f.state.response = request => {
    const page = request.json.pageToken ? Number(request.json.pageToken.split('-').at(-1)) : 0;
    assert.equal(page, pages++);
    return { results: Array.from({ length: page === 10 ? 1 : 10000 }, (_, index) => {
      const id = page * 10000 + index + 1;
      return { customer: { id: CUSTOMER }, campaign: { id: '1', status: 'ENABLED' }, adGroup: { id: '2', status: 'ENABLED' },
        adGroupAd: { status: 'ENABLED', ad: { id: String(id), type: 'RESPONSIVE_SEARCH_AD' } } };
    }), ...(page < 10 ? { nextPageToken: `fictitious-page-${page + 1}` } : {}) };
  };
  let count = 0; let pageToken = null;
  do {
    const data = (await f.execute('ads', { ...payload('ads'), pageToken })).data;
    for (const row of data.results) assert.equal(Number(row.adGroupAd.ad.id), ++count);
    pageToken = data.nextPageToken;
  } while (pageToken);
  assert.equal(count, 100001); assert.equal(pages, 11); assert.equal(f.state.calls.length, 11);
});
