'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const filename = require.resolve('../../lib/googleAdsSearchRows');
const output = { exports: {} };
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module: output, exports: output.exports, Date,
  require: () => ({ normalizeCustomerId: value => String(value).replace(/-/g, '') }) });
const { googleAdsSearchRows } = output.exports;
const args = { customerId: '1234567890', accessToken: 'synthetic', query: 'SELECT customer.id FROM customer', apiVersion: 'v24' };

test('search never presents a partial-error body as a successful empty page', async () => {
  for (const response of [{ partialFailureError: { code: 3 } }, { partial_failure_error: { code: 3 } },
    { errors: [{ code: 3 }], results: [{ customer: { id: args.customerId } }] }, { error: { code: 3 } }, null, [], { results: 'bad' }]) {
    await assert.rejects(googleAdsSearchRows({ ...args, request: async () => response }), { code: 'GOOGLE_ADS_SEARCH_INCOMPLETE' });
  }
});
test('complete search follows bounded pagination once without mutation or version fallback', async () => {
  const calls = [];
  const rows = await googleAdsSearchRows({ ...args, request: async (method, path, options) => {
    calls.push(options); assert.equal(method, 'POST'); assert.equal(path, 'customers/1234567890/googleAds:search');
    assert.equal(options.apiVersion, 'v24'); assert.equal(options.singleAttempt, true);
    return calls.length === 1 ? { results: [{ id: '1' }], nextPageToken: 'next' } : { results: [{ id: '2' }] };
  } });
  assert.deepEqual(Array.from(rows, row => row.id), ['1', '2']); assert.equal(calls[1].data.pageToken, 'next');
  await assert.rejects(googleAdsSearchRows({ ...args, request: async () => ({ nextPageToken: 'loop' }) }), { code: 'GOOGLE_ADS_SEARCH_INCOMPLETE' });
  assert.equal((await googleAdsSearchRows({ ...args, request: async () => ({}) })).length, 0);
});
