'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { adsFixture, CUSTOMER, MANAGER, ACCESS } = require('./google-ads-fixture.cjs');
const contract = require('../src/google-ads-contract');
const action = (id = '456') => ({ customer: { id: CUSTOMER }, conversionAction: { id,
  resourceName: `customers/${CUSTOMER}/conversionActions/${id}`, name: 'Lead - ClinicaClick',
  type: 'UPLOAD_CLICKS', category: 'SUBMIT_LEAD_FORM', status: 'ENABLED', countingType: 'MANY_PER_CLICK',
  primaryForGoal: false, includeInConversionsMetric: false } });

test('conversion actions use one fixed bounded query and preserve the canonical approval fields without tags or secrets', async t => {
  const f = adsFixture(t); f.state.response = { results: [{ ...action(), ignored: 'PRIVATE_FIELD', conversionAction: {
    ...action().conversionAction, tagSnippets: [{ eventSnippet: '<script>PRIVATE_TAG</script>' }], ignored: 'PRIVATE_FIELD' } }] };
  const result = await f.execute('conversion_actions');
  const call = f.state.calls[0]; assert.equal(call.loginCustomerId, MANAGER);
  assert.match(call.json.query, /FROM conversion_action LIMIT 5001$/); assert.doesNotMatch(call.json.query, /tag_snippets|mutate/);
  assert.deepEqual(result.data.results, [action()]);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_FIELD|PRIVATE_TAG|tagSnippets/);
  const stored = JSON.stringify(f.store.db.prepare('SELECT * FROM commands').all()) + JSON.stringify(f.store.db.prepare('SELECT * FROM audit_outbox').all());
  assert(!stored.includes('Lead - ClinicaClick'));
});

test('conversion inventory preserves pagination and distinct action IDs and refuses truncation or arbitrary search inputs', async t => {
  const f = adsFixture(t); f.state.response = { results: Array.from({ length: 251 }, (_, i) => action(String(i + 1))) };
  const first = await f.execute('conversion_actions'); assert.equal(first.data.results.length, 250); assert(first.data.nextPageToken);
  const last = await f.execute('conversion_actions', { pageToken: first.data.nextPageToken });
  assert.equal(last.data.results.length, 1); assert.equal(last.data.nextPageToken, null); assert.equal(f.state.calls.length, 1);
  assert.equal(new Set([...first.data.results, ...last.data.results].map(contract.rowKey)).size, 251);
  for (const extra of [{ query: 'SELECT *' }, { customerId: '1111111111' }, { includeAllTypes: true }]) {
    await assert.rejects(f.execute('conversion_actions', { pageToken: null, ...extra }), { code: 'invalid_request' });
  }
  f.state.response = { results: Array.from({ length: 5001 }, (_, i) => action(String(i + 1))) };
  await assert.rejects(f.execute('conversion_actions'), { code: 'provider_failed' });
});

test('missing approval flags remain unknown and cross-account action ownership is preserved', async t => {
  const f = adsFixture(t), missing = action(); delete missing.conversionAction.primaryForGoal;
  f.state.response = { results: [missing] };
  assert.equal((await f.execute('conversion_actions')).data.results[0].conversionAction.primaryForGoal, null);
  const foreign = action(); foreign.conversionAction.resourceName = 'customers/1111111111/conversionActions/456';
  f.state.response = { results: [foreign] };
  assert.equal((await f.execute('conversion_actions')).data.results[0].conversionAction.resourceName,
    'customers/1111111111/conversionActions/456');
  foreign.customer.id = '1111111111';
  await assert.rejects(f.execute('conversion_actions'), { code: 'provider_failed' });
});

test('invalid conversion DTOs and provider secrets are rejected and asset revocation stops subsequent reads', async t => {
  const f = adsFixture(t);
  for (const patch of [{ id: '0' }, { resourceName: 'https://foreign.invalid/' }, { primaryForGoal: 'false' }, { name: ACCESS }]) {
    f.state.response = { results: [{ ...action(), conversionAction: { ...action().conversionAction, ...patch } }] };
    await assert.rejects(f.execute('conversion_actions'), { code: 'provider_failed' });
  }
  await f.revoke(); const calls = f.state.calls.length;
  await assert.rejects(f.execute('conversion_actions'), { code: 'asset_revoked' }); assert.equal(f.state.calls.length, calls);
});
