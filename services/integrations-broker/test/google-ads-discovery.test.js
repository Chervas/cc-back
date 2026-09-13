'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { adsFixture, CUSTOMER, MANAGER, ACCESS, DEVELOPER } = require('./google-ads-fixture.cjs');
const summary = () => ({ id: CUSTOMER, manager: false, descriptiveName: 'Fictitious account', currencyCode: 'EUR', timeZone: 'Europe/Madrid', status: 'ENABLED' });
test('Ads discovery reads one policy-pinned account with fixed GAQL and closed projection, including managers', async t => {
  const f = adsFixture(t); f.state.response = { results: [{ customer: { ...summary(), manager: true, unexpected: 'DROP' } }] };
  const result = await f.execute('discovery', {}); assert.equal(result.data.results[0].customer.manager, true);
  assert.equal(result.data.results[0].customer.descriptiveName, 'Fictitious account'); assert.doesNotMatch(JSON.stringify(result), /unexpected|DROP/);
  assert.equal(f.state.calls[0].loginCustomerId, MANAGER);
  assert.equal(f.state.calls[0].json.query, 'SELECT customer.id, customer.descriptive_name, customer.manager, customer.currency_code, customer.time_zone, customer.status FROM customer LIMIT 2');
  for (const payload of [{ query: 'SELECT *' }, { customerId: CUSTOMER }, { pageToken: null }]) await assert.rejects(f.execute('discovery', payload), { code: 'invalid_request' });
  assert.equal(f.state.calls.length, 1);
});
test('Ads discovery refuses malformed scope, status, summaries, extra pages and sentinels in descriptive names', async t => {
  const f = adsFixture(t);
  for (const customer of [{ ...summary(), id: '1111111111' }, { ...summary(), status: 'NEW_UNREVIEWED' },
    { ...summary(), manager: 'false' }, { ...summary(), descriptiveName: 'x'.repeat(1025) },
    ...[ACCESS, DEVELOPER, 'FICTITIOUS_REFRESH', 'FICTITIOUS_CLIENT_SECRET'].map(descriptiveName => ({ ...summary(), descriptiveName }))]) {
    f.state.response = { results: [{ customer }] }; await assert.rejects(f.execute('discovery', {}), { code: 'provider_failed' });
  }
  for (const response of [{ results: [] }, { results: [{ customer: summary() }, { customer: summary() }] },
    { results: [{ customer: summary() }], nextPageToken: 'provider-next' }]) {
    f.state.response = response; await assert.rejects(f.execute('discovery', {}), { code: 'provider_failed' });
  }
});
test('Ads discovery grant and durable revocation are checked before secrets and remain blocked after reconstruction', async t => {
  const f = adsFixture(t); f.state.response = { results: [{ customer: summary() }] };
  await assert.rejects(f.execute('discovery', {}, { assetRef: 'ads:1111111111' })); assert.equal(f.state.sdk.length, 0);
  await f.revoke(); const count = f.state.sdk.length;
  await assert.rejects(f.execute('discovery', {}), { code: 'asset_revoked' });
  const request = f.signed(f.command('discovery', {}));
  await assert.rejects(f.make(f.store).execute(request.raw, request.headers), { code: 'asset_revoked' }); assert.equal(f.state.sdk.length, count);
});
