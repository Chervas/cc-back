'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { adsFixture, row, CUSTOMER, MANAGER, ASSET, ACCESS, DEVELOPER } = require('./google-ads-fixture.cjs');
const contract = require('../src/google-ads-contract');
const runtime = require('../src/google-main');
const payload = () => ({ startDate: '2026-09-01', endDate: '2026-09-02', pageToken: null });
test('Ads exposes four fixed read operations and pins customer/manager without projecting secrets or unknown fields', async t => {
  const f = adsFixture(t);
  for (const family of ['account', 'campaigns', 'campaign_metrics', 'adgroup_metrics']) {
    f.state.response = { ignored: ACCESS, results: family === 'account'
      ? [{ customer: { id: CUSTOMER, currencyCode: 'EUR', timeZone: 'Europe/Madrid', ignored: DEVELOPER } }]
      : [{ ...row(1, family.endsWith('_metrics'), family === 'adgroup_metrics'), ignored: ACCESS }] };
    const result = await f.execute(family, family === 'account' ? {} : family === 'campaigns' ? { pageToken: null } : payload());
    assert.equal(result.data.results.length, 1); assert.equal(result.data.nextPageToken, null);
    assert.doesNotMatch(JSON.stringify(result), /FICTITIOUS_ADS_ACCESS|FICTITIOUS_ADS_DEVELOPER|ignored/);
  }
  assert.equal(f.state.refreshes, 1); assert.equal(f.state.calls.length, 4);
  for (const call of f.state.calls) {
    assert.equal(call.hostname, 'googleads.googleapis.com'); assert.equal(call.path, `/v24/customers/${CUSTOMER}/googleAds:search`);
    assert.equal(call.loginCustomerId, MANAGER); assert.match(call.json.query, /^SELECT /);
    assert.deepEqual(Object.keys(call.json), ['query']);
  }
});
test('foreign scope, mutation, arbitrary GAQL/headers, malformed dates and raw provider cursors fail before secrets', async t => {
  const f = adsFixture(t);
  for (const changes of [{ tenantRef: 'clinic:999' }, { assetRef: 'ads:1111111111' }, { operation: 'google.ads.mutate.v1' }]) {
    await assert.rejects(f.execute('campaign_metrics', payload(), changes));
  }
  for (const changes of [{ query: 'SELECT * FROM customer' }, { headers: {} }, { customerId: CUSTOMER }, { loginCustomerId: MANAGER },
    { startDate: '2026-02-30' }, { startDate: '2026-08-01' }, { endDate: '2026-08-31' }]) {
    await assert.rejects(f.execute('campaign_metrics', { ...payload(), ...changes }), { code: 'invalid_request' });
  }
  assert.equal(f.state.sdk.length, 0); assert.equal(f.state.calls.length, 0);
  await assert.rejects(f.execute('campaign_metrics', { ...payload(), pageToken: 'provider-token' }), { code: 'invalid_request' });
  assert.equal(f.state.calls.length, 0);
});
test('10,000 provider rows are sliced without truncation or repeated provider searches', async t => {
  const f = adsFixture(t); f.state.response = { results: Array.from({ length: 10000 }, (_, i) => row(i + 1, true)), nextPageToken: 'FICTITIOUS_NEXT' };
  let token = null; const ids = [];
  for (let i = 0; i < 40; i++) {
    const result = await f.execute('campaign_metrics', { ...payload(), pageToken: token });
    ids.push(...result.data.results.map(v => v.campaign.id)); token = result.data.nextPageToken;
    assert.equal(result.data.results.length, 250); assert.ok(token); assert.ok(Buffer.byteLength(JSON.stringify(result)) < 1048576);
  }
  assert.equal(f.state.calls.length, 1); assert.equal(new Set(ids).size, 10000);
  f.state.response = { results: [row(10001, true)] };
  const last = await f.execute('campaign_metrics', { ...payload(), pageToken: token });
  assert.equal(last.data.results[0].campaign.id, '10001'); assert.equal(last.data.nextPageToken, null);
  assert.equal(f.state.calls.length, 2); assert.equal(f.state.calls[1].json.pageToken, 'FICTITIOUS_NEXT');
  assert.equal(f.state.calls[0].json.query, f.state.calls[1].json.query);
  const durable = JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all()) + JSON.stringify(f.store.db.prepare('SELECT * FROM audit_outbox').all());
  assert.doesNotMatch(durable, /FICTITIOUS_CAMPAIGN|FICTITIOUS_NEXT|FICTITIOUS_ADS/);
});
test('cursor is bound to dates, operation, identity epoch and memory lifetime', async t => {
  const f = adsFixture(t); f.state.response = { results: Array.from({ length: 300 }, (_, i) => row(i + 1, true)) };
  const token = (await f.execute('campaign_metrics', payload())).data.nextPageToken;
  for (const [family, changes] of [['campaign_metrics', { endDate: '2026-09-03' }], ['adgroup_metrics', {}]]) {
    await assert.rejects(f.execute(family, { ...payload(), ...changes, pageToken: token }), { code: 'invalid_request' });
  }
  f.state.developer = 'FICTITIOUS_ADS_DEVELOPER_ROTATED';
  await assert.rejects(f.execute('campaign_metrics', { ...payload(), pageToken: token }), { code: 'invalid_request' });
  f.state.developer = DEVELOPER; f.engine.close();
  await assert.rejects(f.execute('campaign_metrics', { ...payload(), pageToken: token }), { code: 'invalid_request' });
  assert.equal(f.state.calls.length, 1);
});
test('cache eviction and expiry fail closed instead of restarting with a partial dataset', async t => {
  const f = adsFixture(t, { maxEntries: 1 }); f.state.response = { results: Array.from({ length: 300 }, (_, i) => row(i + 1, true)) };
  const first = (await f.execute('campaign_metrics', payload())).data.nextPageToken;
  // A second valid query replaces the one available page.
  const replacement = (await f.execute('campaign_metrics', { ...payload(), endDate: '2026-09-03' })).data.nextPageToken;
  await assert.rejects(f.execute('campaign_metrics', { ...payload(), pageToken: first }), { code: 'invalid_request' });
  f.advance(600001);
  await assert.rejects(f.execute('campaign_metrics', { ...payload(), endDate: '2026-09-03', pageToken: replacement }), { code: 'invalid_request' });
});
test('provider scope, dates, oversized inventory, malformed metrics and repeated page tokens never appear complete', async t => {
  const f = adsFixture(t);
  for (const bad of [{ ...row(1, true), customer: { id: '9999999999' } }, { ...row(1, true), metrics: { clicks: '9007199254740992' } },
    { ...row(1, true), segments: { date: '2026-08-01', device: 'MOBILE', adNetworkType: 'SEARCH' } }]) {
    f.state.response = { results: [bad] }; await assert.rejects(f.execute('campaign_metrics', payload()), { code: 'provider_failed' });
  }
  f.state.response = { results: Array.from({ length: 5001 }, (_, i) => row(i + 1)) };
  await assert.rejects(f.execute('campaigns'), { code: 'provider_failed' });
  f.state.response = { results: [row(1, true)], nextPageToken: 'repeat' };
  const token = (await f.execute('campaign_metrics', payload())).data.nextPageToken;
  await assert.rejects(f.execute('campaign_metrics', { ...payload(), pageToken: token }), { code: 'provider_failed' });
});
test('durable asset revocation stops cached reads and survives broker reconstruction before any secret lookup', async t => {
  const f = adsFixture(t); f.state.response = { results: Array.from({ length: 300 }, (_, i) => row(i + 1)) };
  const token = (await f.execute('campaigns')).data.nextPageToken; await f.revoke(); const reads = f.state.sdk.length;
  await assert.rejects(f.execute('campaigns', { pageToken: token }), { code: 'asset_revoked' });
  const restarted = f.make(f.store); const request = f.signed(f.command('campaigns'));
  await assert.rejects(restarted.execute(request.raw, request.headers), { code: 'asset_revoked' });
  assert.equal(f.state.sdk.length, reads);
});
test('a concurrent revocation discards the provider response, and secret failures do not fall back to cache', async t => {
  const f = adsFixture(t); f.state.onRead = () => f.revoke();
  await assert.rejects(f.execute('campaigns')); assert.equal(f.state.calls.length, 1);
  const g = adsFixture(t); g.state.response = { results: Array.from({ length: 300 }, (_, i) => row(i + 1)) };
  const token = (await g.execute('campaigns')).data.nextPageToken; g.state.failMetadata = true;
  await assert.rejects(g.execute('campaigns', { pageToken: token }), { code: 'secret_unavailable' });
  assert.equal(g.state.calls.length, 1);
});
test('Ads runtime policy refuses cross-cohort fields, OAuth, duplicate accounts and shared reader/control keys', t => {
  const f = adsFixture(t);
  const config = () => ({ enabled: true, cohort: 'google-ads-read-v1', policy: structuredClone(f.policy), listenAddress: '127.0.0.1', port: 8090,
    stateFile: '/tmp/fictitious.sqlite', tlsCertFile: '/tmp/fictitious.crt', tlsKeyFile: '/tmp/fictitious.key', cursorKeyFile: '/tmp/fictitious.cursor' });
  assert.equal(runtime.validateConfig(config()).cohort, 'google-ads-read-v1');
  for (const mutate of [c => { delete c.policy.connections[0].developerSecretArn; }, c => { c.policy.connections[0].googleAdsAccounts.push(c.policy.connections[0].googleAdsAccounts[0]); },
    c => { c.policy.connections[0].googleAdsAccounts[0].loginCustomerId = '123-456-7890'; },
    c => { c.policy.grants[1].principalId = c.policy.grants[0].principalId; },
    c => { c.policy.principals[1].publicKey = c.policy.principals[0].publicKey; }, c => { c.cohort = 'google-analytics-read-v1'; }]) {
    const value = config(); mutate(value); assert.throws(() => runtime.validateConfig(value));
  }
});
test('credential sentinels inside allowed provider fields are rejected and oversized projected slices remain bounded', async t => {
  const f = adsFixture(t);
  for (const secret of [ACCESS, DEVELOPER, 'FICTITIOUS_REFRESH', 'FICTITIOUS_CLIENT_SECRET']) {
    f.state.response = { results: [{ ...row(), campaign: { ...row().campaign, name: secret } }] };
    await assert.rejects(f.execute('campaigns'), { code: 'provider_failed' });
  }
  const g = adsFixture(t);
  g.state.response = { results: Array.from({ length: 300 }, (_, i) => ({ ...row(i + 1), campaign: {
    ...row(i + 1).campaign, name: '\\'.repeat(1024), primaryStatusReasons: Array(50).fill('A'.repeat(64)) } })) };
  const first = await g.execute('campaigns'); assert.ok(first.data.results.length < 250); assert.ok(first.data.nextPageToken);
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 1048576);
  const next = await g.execute('campaigns', { pageToken: first.data.nextPageToken });
  assert.equal(Number(next.data.results[0].campaign.id), first.data.results.length + 1);
  assert.equal(g.state.calls.length, 1);
});
