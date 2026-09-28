'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { adsFixture, CUSTOMER, ACCESS } = require('./google-ads-fixture.cjs');
const { evidenceRows, payload } = require('./google-optimization-evidence-fixture.cjs');
const contract = require('../src/google-ads-contract');
const evidence = require('../src/google-optimization-evidence-contract');

test('performance and monthly budget reads expose only six fixed scoped sections, not credentials or CRM data', async t => {
  const f = adsFixture(t); const data = evidenceRows();
  for (const family of evidence.FAMILIES) for (const section of evidence.SECTIONS[family]) {
    const rows = structuredClone(data[family][section]);
    for (const row of rows) { row.private = ACCESS; row.patient = 'patient@example.test'; row.campaign.name = ACCESS; }
    f.state.response = { results: rows };
    const result = (await f.execute(family, payload(family, section))).data;
    assert.deepEqual(result.results, data[family][section]); assert.equal(result.nextPageToken, null);
    assert.doesNotMatch(JSON.stringify(result), /FICTITIOUS|patient|private/);
    const call = f.state.calls.at(-1); assert.equal(call.path, `/v24/customers/${CUSTOMER}/googleAds:search`);
    assert.match(call.json.query, /WHERE campaign.id = 30/);
    assert.doesNotMatch(call.json.query, /keyword|final_url|conversion_action|submission|mutate|contact/);
    assert.deepEqual(contract.projectPage(family, result, payload(family, section), { customerId: CUSTOMER }).results, result.results);
  }
  assert.equal(f.state.calls.length, 6);
  const durable = JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all()) + JSON.stringify(f.store.db.prepare('SELECT * FROM audit_outbox').all());
  assert.doesNotMatch(durable, /patient|80000000|20000000|FICTITIOUS_ADS|Europe\/Madrid/);
});
test('payload schema rejects free-form queries, credentials, owners, invalid dates and unbounded windows before secrets', async t => {
  const f = adsFixture(t);
  for (const family of evidence.FAMILIES) {
    for (const patch of [{ query: 'SELECT *' }, { token: ACCESS }, { customerId: CUSTOMER }, { section: 'all' }, { section: undefined },
      { campaignId: '30 OR 1=1' }, { campaignId: null }, { campaignId: '9'.repeat(21) }, { startDate: '2026-02-30' },
      { endDate: '2026-13-01' }, { startDate: '2026-09-30' }, { endDate: '2027-09-11' }]) {
      await assert.rejects(f.execute(family, { ...payload(family, 'campaign'), ...patch }), { code: 'invalid_request' });
    }
  }
  await assert.rejects(f.execute('optimization_performance', { ...payload('optimization_performance', 'campaign'), startDate: '2026-08-13' }), { code: 'invalid_request' });
  await assert.rejects(f.execute('optimization_budget', { ...payload('optimization_budget', 'month_cost'), startDate: '2026-09-02' }), { code: 'invalid_request' });
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.sdk.length, 0);
});
test('row limits are section-specific at the provider boundary, including accumulated provider pages', async t => {
  const f = adsFixture(t);
  assert.equal(contract.rowLimit('optimization_performance', { section: 'ad_daily' }), 56000);
  for (const [family, section, limit] of [['optimization_performance', 'campaign', 1], ['optimization_performance', 'inventory', 2000],
    ['optimization_performance', 'campaign_daily', 28], ['optimization_budget', 'campaign', 1], ['optimization_budget', 'month_cost', 1]]) {
    assert.equal(contract.rowLimit(family, { section }), limit);
    assert.match(contract.query(family, payload(family, section), { customerId: CUSTOMER }), new RegExp(`LIMIT ${limit + 1}$`));
    f.state.response = { results: Array.from({ length: limit + 1 }, () => evidenceRows()[family][section][0]) };
    await assert.rejects(f.execute(family, payload(family, section)), { code: 'provider_failed' });
  }
  const rows = evidenceRows().optimization_performance.campaign_daily;
  f.state.response = request => ({ results: request.json.pageToken ? rows.slice(14).concat(rows.slice(0, 1)) : rows.slice(0, 14),
    ...(request.json.pageToken ? {} : { nextPageToken: 'provider-page-2' }) });
  const first = (await f.execute('optimization_performance', payload('optimization_performance', 'campaign_daily'))).data;
  assert.ok(first.nextPageToken);
  await assert.rejects(f.execute('optimization_performance', { ...payload('optimization_performance', 'campaign_daily'), pageToken: first.nextPageToken }), { code: 'provider_failed' });
});
test('opaque pagination also binds metadata to its evidence window, campaign and section', async t => {
  const f = adsFixture(t);
  f.state.response = { results: Array.from({ length: 300 }, (_, index) => {
    const row = evidenceRows().optimization_performance.inventory[0]; row.adGroupAd.ad.id = String(index + 60); return row;
  }) };
  const base = payload('optimization_performance', 'inventory'); const first = (await f.execute('optimization_performance', base)).data;
  assert.equal(first.results.length, 250); assert.ok(first.nextPageToken);
  for (const patch of [{ startDate: '2026-08-13', endDate: '2026-09-09' }, { campaignId: '31' }, { section: 'ad_daily' }]) {
    await assert.rejects(f.execute('optimization_performance', { ...base, pageToken: first.nextPageToken, ...patch }), { code: 'invalid_request' });
  }
  const last = (await f.execute('optimization_performance', { ...base, pageToken: first.nextPageToken })).data;
  assert.equal(last.results.length, 50); assert.equal(last.nextPageToken, null); assert.equal(f.state.calls.length, 1);
});
test('missing metrics, foreign identity, unsafe numbers and fabricated dates cannot become measured zeros', async t => {
  const f = adsFixture(t);
  for (const mutate of [row => { delete row.metrics.costMicros; }, row => { delete row.metrics.clicks; },
    row => { row.metrics.clicks = 10; }, row => { row.metrics.clicks = '1.5'; }, row => { row.metrics.clicks = '9007199254740992'; },
    row => { row.metrics.costMicros = '-1'; }, row => { row.metrics.costMicros = '90071992547409910001'; },
    row => { row.customer.id = '9999999999'; }, row => { row.campaign.id = '31'; }, row => { row.adGroup.id = 50; },
    row => { row.segments.date = '2026-09-09'; }, row => { row.segments.date = '2026-02-30'; }]) {
    const row = evidenceRows().optimization_performance.ad_daily[0]; mutate(row); f.state.response = { results: [row] };
    await assert.rejects(f.execute('optimization_performance', payload('optimization_performance', 'ad_daily')), { code: 'provider_failed' });
  }
});
test('removed ads retain their spend; missing delivery or budget ownership stays unknown, not approved', async t => {
  const f = adsFixture(t); const rows = evidenceRows();
  const ad = rows.optimization_performance.inventory[0]; ad.adGroupAd.status = 'REMOVED'; delete ad.adGroupAd.primaryStatus; delete ad.adGroupAd.policySummary;
  f.state.response = { results: [ad] };
  const projected = (await f.execute('optimization_performance', payload('optimization_performance', 'inventory'))).data.results[0];
  assert.equal(projected.adGroupAd.status, 'REMOVED'); assert.equal(projected.adGroupAd.primaryStatus, undefined); assert.deepEqual(projected.adGroupAd.policySummary, {});
  const budget = rows.optimization_budget.campaign[0]; budget.campaign.status = 'PAUSED'; delete budget.campaignBudget;
  f.state.response = { results: [budget] };
  assert.deepEqual((await f.execute('optimization_budget', payload('optimization_budget', 'campaign'))).data.results[0].campaignBudget, {});
  const foreign = evidenceRows().optimization_budget.campaign[0]; foreign.campaignBudget.resourceName = 'customers/9999999999/campaignBudgets/40';
  f.state.response = { results: [foreign] }; await assert.rejects(f.execute('optimization_budget', payload('optimization_budget', 'campaign')), { code: 'provider_failed' });
});
test('a separate operation grant is required and revocation during a read withholds the result', async t => {
  const f = adsFixture(t); const family = 'optimization_performance';
  const permitted = f.policy.grants[0].operations;
  f.policy.grants[0].operations = permitted.filter(name => name !== 'google.ads.optimization_performance.read.v1');
  const broker = f.make(f.store); const command = f.signed(f.command(family, payload(family, 'campaign')));
  await assert.rejects(broker.execute(command.raw, command.headers), { code: 'scope_denied' }); assert.equal(f.state.sdk.length, 0);
  f.policy.grants[0].operations = permitted; f.state.response = { results: evidenceRows()[family].campaign };
  f.state.onRead = () => f.revoke(); await assert.rejects(f.execute(family, payload(family, 'campaign')));
});
