'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { performanceFixture } = require('./fixtures/campaign_workspace_performance.fixture');
const { performancePeriod, inspectGooglePerformance } = require('../../services/campaignWorkspacePerformanceSnapshot.service');
const { digest } = require('../../services/campaignWorkspaceOptimizationCapabilities.service');
const { googleAdsSearchRows } = require('../../lib/googleAdsSearchRows');

test('performance window closes 28 Madrid calendar days and excludes the two latest complete days', () => {
  assert.deepEqual(performancePeriod(new Date('2026-09-11T12:00:00Z')), {
    start: '2026-08-12', end: '2026-09-08', days: 28, time_zone: 'Europe/Madrid', excluded_days: 2,
  });
  for (const [instant, end] of [['2026-08-31T22:00:00Z', '2026-08-29'], ['2026-03-29T22:00:00Z', '2026-03-27'],
    ['2026-10-25T23:00:00Z', '2026-10-23'], ['2027-01-01T00:00:00Z', '2026-12-29'], ['2028-03-02T23:00:00Z', '2028-02-29']]) {
    const period = performancePeriod(new Date(instant));
    assert.equal(period.end, end); assert.equal(Date.parse(period.end) - Date.parse(period.start), 27 * 86400000);
  }
  assert.throws(() => performancePeriod(new Date('invalid')), /performance_invalid/);
});

for (const provider of ['google_ads', 'meta_ads']) {
  test(`${provider}: reads complete mature daily metrics and emits only allowlisted data`, async () => {
    const h = performanceFixture(provider); const result = await h.run();
    assert.equal(result.campaign_daily.length, 28); assert.equal(result.ad_daily.length, 56);
    assert.equal(result.inventory.length, 2); assert.ok(result.inventory.every(ad => ad.active));
    assert.equal(result.ad_daily[0].cost_micros, '60000000'); assert.equal(result.ad_daily[0].clicks, 10);
    assert.equal(result.currency, 'EUR'); assert.deepEqual(result.reference, h.reference);
    const { fingerprint, ...body } = result; assert.equal(fingerprint, digest(body));
    assert.ok(!JSON.stringify(result).includes('fixture-only'));
    assert.ok(!JSON.stringify(result).includes('accessToken'));
    if (provider === 'google_ads') {
      assert.equal(h.state.calls.length, 4);
      assert.ok(h.state.calls.every(call => call.query.startsWith('SELECT') && call.customerId === '20' && call.loginCustomerId === '10'));
      assert.match(h.state.calls[3].query, /BETWEEN '2026-08-12' AND '2026-09-08'/);
      assert.match(h.state.calls[3].query, /REMOVED/);
    } else {
      assert.equal(h.state.calls.length, 5);
      assert.ok(h.state.calls.every(call => call.options.maxRetries === 0 && call.options.sensitivePayload && call.options.timeout <= 8000));
      assert.deepEqual(h.state.calls.map(call => call.path), ['act_20', '30', '30/ads', '30/insights', '30/insights']);
      assert.equal(h.state.calls[4].options.params.time_increment, 1);
      assert.equal(h.state.calls[4].options.params.level, 'ad');
    }
  });

  test(`${provider}: wrong currency, time zone, identity and inactive campaigns stop before insights`, async () => {
    const mutations = provider === 'google_ads' ? [
      s => { s.googleMeta[0].customer.id = '99'; }, s => { s.googleMeta[0].customer.currencyCode = 'USD'; },
      s => { s.googleMeta[0].customer.timeZone = 'UTC'; }, s => { s.googleMeta[0].campaign.status = 'PAUSED'; },
      s => { s.googleMeta[0].campaign.experimentType = 'EXPERIMENT'; }, s => { s.googleMeta[0].campaign.advertisingChannelType = 'PERFORMANCE_MAX'; },
    ] : [s => { s.owner.account_id = '99'; }, s => { s.owner.currency = 'USD'; }, s => { s.owner.timezone_name = 'UTC'; },
      s => { s.campaign.account_id = '99'; }, s => { s.campaign.status = 'PAUSED'; }, s => { s.campaign.effective_status = 'PAUSED'; },
      s => { s.campaign.buying_type = 'RESERVED'; }];
    for (const mutate of mutations) {
      const h = performanceFixture(provider); mutate(h.state); await assert.rejects(h.run(), /performance_/);
      assert.ok(h.state.calls.length <= (provider === 'google_ads' ? 1 : 2));
    }
  });

  test(`${provider}: rejects duplicate rows, foreign ads, unknown groups and conflicting campaign totals`, async () => {
    const mutations = [s => { s.inventory.push(structuredClone(s.inventory[0])); },
      s => { s.adRows.push(structuredClone(s.adRows[0])); }, s => { s.campaignRows.push(structuredClone(s.campaignRows[0])); }];
    if (provider === 'google_ads') mutations.push(s => { s.adRows[0].customer.id = '99'; },
      s => { s.adRows[0].adGroup.id = '99'; }, s => { s.adRows[0].adGroupAd.ad.id = '99'; },
      s => { s.adRows[0].metrics.clicks = '9'; }, s => { s.adRows[0].metrics.costMicros = '59000000'; });
    else mutations.push(s => { s.adRows[0].account_id = '99'; }, s => { s.adRows[0].adset_id = '99'; },
      s => { s.adRows[0].ad_id = '99'; }, s => { s.adRows[0].clicks = '9'; }, s => { s.adRows[0].spend = '59.00'; });
    for (const mutate of mutations) {
      const h = performanceFixture(provider); mutate(h.state); await assert.rejects(h.run(), /performance_(incomplete|unreconciled)/);
    }
  });

  test(`${provider}: malformed dates, missing metrics, unsafe integers and fractional clicks are not zeros`, async () => {
    const mutations = provider === 'google_ads' ? [s => { s.adRows[0].segments.date = '2026-09-11'; },
      s => { delete s.adRows[0].metrics.clicks; }, s => { s.adRows[0].metrics.clicks = '1.5'; },
      s => { s.adRows[0].metrics.clicks = '9007199254740992'; }, s => { s.adRows[0].metrics.costMicros = '-1'; },
      s => { s.adRows[0].metrics.costMicros = '90071992547409910001'; }]
      : [s => { s.adRows[0].date_stop = '2026-09-11'; }, s => { delete s.adRows[0].clicks; },
        s => { s.adRows[0].clicks = '1.5'; }, s => { s.adRows[0].clicks = '9007199254740992'; },
        s => { s.adRows[0].spend = '-1'; }, s => { s.adRows[0].spend = '0.001'; }];
    for (const mutate of mutations) {
      const h = performanceFixture(provider); mutate(h.state); await assert.rejects(h.run(), /performance_incomplete/);
    }
  });

  test(`${provider}: late completion, calendar changes and clock rollback cannot produce a fresh snapshot`, async () => {
    for (const mutate of [s => { s.clock = 45000; }, s => { s.now = new Date('2026-09-11T22:00:00Z'); },
      s => { s.now = new Date('2026-09-11T11:59:59Z'); }]) {
      const h = performanceFixture(provider);
      h.state.beforeRead = () => { if (h.state.calls.length === (provider === 'google_ads' ? 4 : 5)) mutate(h.state); };
      await assert.rejects(h.run(), /performance_(timeout|period_changed)/);
    }
    const h = performanceFixture(provider);
    h.state.now = new Date('2026-09-11T21:59:59Z');
    h.state.beforeRead = () => { h.state.now = new Date('2026-09-11T22:00:00Z'); };
    await assert.rejects(h.run(), /performance_period_changed/);
  });

  test(`${provider}: provider rejection stops at the first call without alternate credentials or refresh`, async () => {
    const h = performanceFixture(provider);
    const rejection = Object.assign(new Error('fixture permission rejection'), { response: { status: 401, data: { error: { code: 190 } } } });
    h.state.beforeRead = () => { throw rejection; };
    await assert.rejects(h.run(), error => error === rejection); assert.equal(h.state.calls.length, 1);
  });
}

test('invalid campaign IDs are rejected before any Google or Meta transport', async () => {
  for (const provider of ['google_ads', 'meta_ads']) {
    const h = performanceFixture(provider); h.reference.campaign_id = "30 OR 1=1";
    await assert.rejects(h.run(), /invalid_workspace_optimization/); assert.equal(h.state.calls.length, 0);
  }
});

test('Google performance keeps restricted ads and their spend but excludes them from automatic pause comparisons', async () => {
  for (const patch of [{ primaryStatus: 'NOT_ELIGIBLE' }, { primaryStatus: 'PENDING' }, { primaryStatus: 'LIMITED' },
    { primaryStatus: undefined }, { policySummary: { approvalStatus: 'DISAPPROVED' } },
    { policySummary: { approvalStatus: 'APPROVED_LIMITED' } }, { policySummary: {} }]) {
    const h = performanceFixture(); Object.assign(h.state.inventory[1].adGroupAd, patch);
    const result = await h.run(); assert.equal(result.inventory[0].active, true);
    assert.equal(result.inventory[1].active, false, JSON.stringify(patch));
    assert.equal(result.ad_daily.length, 56); assert.equal(result.campaign_daily.length, 28);
    assert.match(h.state.calls[1].query, /ad_group_ad.primary_status/);
    assert.match(h.state.calls[1].query, /ad_group_ad.policy_summary.approval_status/);
    assert.doesNotMatch(h.state.calls[3].query, /primary_status|policy_summary/);
  }
});

test('Google fills all-zero omitted dates only after a complete inventory and both complete queries', async () => {
  const h = performanceFixture(); h.state.campaignRows.shift(); h.state.adRows.splice(0, 2);
  const result = await h.run();
  assert.deepEqual(result.campaign_daily[0], { date: h.dates[0], clicks: 0, cost_micros: '0', inferred_zero: true });
  assert.equal(result.ad_daily.filter(row => row.inferred_zero).length, 2);
  assert.equal(result.ad_daily[0].clicks, 0);
  h.state.adRows.shift(); await assert.rejects(h.run(), /performance_unreconciled/);
});

test('Meta preserves absent zero-like days as unknown rather than inventing measurements', async () => {
  const h = performanceFixture('meta_ads'); h.state.campaignRows.shift(); h.state.adRows.splice(0, 2);
  const result = await h.run(); assert.equal(result.campaign_daily.length, 27); assert.equal(result.ad_daily.length, 54);
  assert.ok(!result.ad_daily.some(row => row.inferred_zero));
  h.state.campaignRows.shift(); await assert.rejects(h.run(), /performance_unreconciled/);
});

test('reconciliation retains fractional Google cents, with at most one cent difference in the whole day', async () => {
  const h = performanceFixture(); h.state.adRows[0].metrics.costMicros = '60000001';
  assert.equal((await h.run()).ad_daily[0].cost_micros, '60000001');
  h.state.adRows[0].metrics.costMicros = '60010000'; await h.run();
  h.state.adRows[0].metrics.costMicros = '60010001'; await assert.rejects(h.run(), /performance_unreconciled/);
});

test('Meta follows cursors on the original endpoint, not provider-supplied next URLs', async () => {
  const h = performanceFixture('meta_ads');
  h.state.pages = { adRows: options => ({ data: options.params.after ? { data: h.state.adRows.slice(20) }
    : { data: h.state.adRows.slice(0, 20), paging: { next: 'https://untrusted.invalid/?access_token=do-not-follow', cursors: { after: 'page-two' } } } }) };
  const result = await h.run(); assert.equal(result.ad_daily.length, 56);
  assert.deepEqual(h.state.calls.slice(-2).map(call => call.path), ['30/insights', '30/insights']);
  assert.equal(h.state.calls.at(-1).options.params.after, 'page-two');
  assert.equal(h.state.calls.at(-1).options.params.level, 'ad');
  assert.equal(h.state.calls.at(-1).options.params.time_increment, 1);
  assert.ok(!JSON.stringify(result).includes('untrusted'));
});

test('Meta truncated, repeated or missing cursors and error envelopes fail closed', async () => {
  for (const paging of [{ next: 'unused' }, { next: 'unused', cursors: { after: 'same-cursor' } },
    { next: 'unused', cursors: { after: 'x'.repeat(4097) } }]) {
    const h = performanceFixture('meta_ads');
    h.state.pages = { adRows: () => ({ data: { data: [], paging } }) };
    await assert.rejects(h.run(), /performance_incomplete/);
  }
  const h = performanceFixture('meta_ads');
  h.state.pages = { adRows: () => ({ data: { data: [], error: { code: 190 } } }) };
  await assert.rejects(h.run(), /performance_incomplete/);
});

test('oversized inventory and daily reports are rejected rather than silently cut', async () => {
  for (const provider of ['google_ads', 'meta_ads']) {
    const h = performanceFixture(provider);
    h.state.inventory = Array.from({ length: 2001 }, () => structuredClone(h.state.inventory[0]));
    await assert.rejects(h.run(), /performance_incomplete/);
  }
});

test('Google IDs stay exact strings and Meta cannot report one ad in conflicting groups', async () => {
  for (const mutate of [s => { s.googleMeta[0].customer.id = 20; }, s => { s.inventory[0].adGroupAd.ad.id = 60; },
    s => { s.adRows[0].adGroup.id = 50; }]) {
    const h = performanceFixture(); mutate(h.state); await assert.rejects(h.run(), /performance_incomplete/);
  }
  const h = performanceFixture('meta_ads');
  h.state.inventory.push({ ...h.state.inventory[0], adset_id: '99' });
  await assert.rejects(h.run(), /performance_incomplete/);
  assert.equal(h.state.calls.length, 3);
});

test('Google transport paginates the actual search helper and rejects a truncated response', async () => {
  const h = performanceFixture(); const requests = [];
  const read = options => googleAdsSearchRows({ ...options, now: () => 0, request: async (method, path, input) => {
    requests.push({ method, path, input });
    const rows = await h.options.read(options);
    return input.data.pageToken ? { results: rows.slice(1) } : { results: rows.slice(0, 1), nextPageToken: 'page-two' };
  } });
  const result = await inspectGooglePerformance({ ...h.options, read });
  assert.equal(result.ad_daily.length, 56); assert.equal(requests.length, 8);
  assert.ok(requests.every(call => call.method === 'POST' && call.path === 'customers/20/googleAds:search' && call.input.singleAttempt));
  await assert.rejects(inspectGooglePerformance({ ...h.options, read: options => googleAdsSearchRows({ ...options,
    request: async () => ({ results: [], nextPageToken: 'repeated' }) }) }), error => error.code === 'GOOGLE_ADS_SEARCH_INCOMPLETE');
});
