'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'); const { PassThrough } = require('node:stream');
const { createGoogleHttp } = require('../src/google-http');
const C = require('../src/google-optimization-write-contract');
const { CUSTOMER, MANAGER, ACCESS, DEVELOPER } = require('./google-ads-fixture.cjs');
function wire({ enabled = true, status = 200, body = '{}', headers = { 'content-type': 'application/json' } } = {}) {
  const calls = [];
  const http = createGoogleHttp({ optimizationEnabled: enabled, request: (options, callback) => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = sent => { calls.push({ options, sent }); queueMicrotask(() => {
      const res = new PassThrough(); res.statusCode = status; res.headers = headers;
      callback(res); if (!res.destroyed) res.end(body);
    }); }; return req;
  } }); return { calls, http };
}
function request(kind = 'pause_ad') {
  const mutation = C.mutation({ kind, resourceId: '60', adGroupId: '50', after: kind === 'pause_ad' ? 'PAUSED' : C.ratioKind(kind) ? '3.8' : '1000000' }, CUSTOMER);
  return { hostname: 'googleads.googleapis.com', path: mutation.path, json: mutation.body, optimizationMutation: kind,
    token: Buffer.from(ACCESS), developerToken: Buffer.from(DEVELOPER), loginCustomerId: MANAGER };
}
test('isolated writer transport pins TLS, exact single-field operations and does not enable the default transport', async () => {
  const w = wire(); const disabled = wire({ enabled: false });
  for (const kind of C.KINDS) {
    await assert.rejects(disabled.http(request(kind)), { code: 'invalid_request' }); await w.http(request(kind));
    const sent = w.calls.at(-1); assert.equal(sent.options.method, 'POST'); assert.equal(sent.options.port, 443);
    assert.equal(sent.options.hostname, 'googleads.googleapis.com'); assert.equal(sent.options.rejectUnauthorized, true);
    assert.equal(sent.options.minVersion, 'TLSv1.2'); assert.equal(sent.options.headers.authorization, 'Bearer ' + ACCESS);
    assert.equal(sent.options.headers['developer-token'], DEVELOPER); assert.equal(sent.options.headers['login-customer-id'], MANAGER);
    assert.deepEqual(JSON.parse(sent.sent), request(kind).json);
  }
  assert.equal(disabled.calls.length, 0);
});
test('writer transport rejects arbitrary paths, fields, resource scope, creates, enables and injected credentials', async () => {
  const w = wire(); const mutateBody = change => { const value = request(); change(value.json); return value; };
  const cases = [{ ...request(), optimizationMutation: undefined }, { ...request(), hostname: 'evil.invalid' },
    { ...request(), path: `/v24/customers/${CUSTOMER}/googleAds:mutate` }, { ...request(), optimizationMutation: 'create_campaign' },
    { ...request(), path: request().path + '?key=x' }, { ...request(), developerToken: undefined },
    { ...request(), loginCustomerId: '123\r\nHeader' }, { ...request(), token: Buffer.from('secret\r\nHeader') },
    mutateBody(body => { body.operations[0].create = {}; }), mutateBody(body => { body.operations.push(body.operations[0]); }),
    mutateBody(body => { body.partialFailure = true; }), mutateBody(body => { body.validateOnly = true; }),
    mutateBody(body => { body.operations[0].update.status = 'ENABLED'; }),
    mutateBody(body => { body.operations[0].update.resourceName = 'customers/9999999999/adGroupAds/50~60'; }),
    mutateBody(body => { body.operations[0].updateMask += ',campaignBudget'; }),
    mutateBody(body => { body.operations[0].update.campaignBudget = 'customers/1234567890/campaignBudgets/40'; })];
  for (const value of cases) await assert.rejects(w.http(value), { code: 'invalid_request' }); assert.equal(w.calls.length, 0);
});
test('writer transport never retries or follows provider redirects and never exposes error bodies', async () => {
  for (const config of [{ status: 302 }, { status: 503 }, { status: 403 }, { body: 'FICTITIOUS_SECRET' },
    { headers: { 'content-type': 'text/html' } }, { body: JSON.stringify({ ignored: 'x'.repeat(131073) }) }]) {
    const w = wire({ body: JSON.stringify({ error: ACCESS }), ...config });
    await assert.rejects(w.http(request()), error => {
      assert.ok(['provider_failed', 'provider_unauthorized'].includes(error.code)); assert.doesNotMatch(JSON.stringify(error), /FICTITIOUS/);
      return true;
    }); assert.equal(w.calls.length, 1);
  }
});
