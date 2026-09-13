'use strict';
const { test } = require('node:test'); const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'); const { PassThrough } = require('node:stream');
const { createGoogleHttp } = require('../src/google-http');
const { createGoogleAdsDeveloperSecret } = require('../src/google-ads-developer-secret');
const { adsFixture, CUSTOMER, MANAGER, ACCESS, DEVELOPER } = require('./google-ads-fixture.cjs');
const runtime = require('../src/google-main');
function wire({ status = 200, body = '{}', headers = { 'content-type': 'application/json' } } = {}) {
  const calls = [];
  const http = createGoogleHttp({ request: (options, callback) => {
    const req = new EventEmitter(); req.destroy = () => {};
    req.end = sent => { calls.push({ options, sent }); queueMicrotask(() => {
      const res = new PassThrough(); res.statusCode = status; res.headers = headers;
      callback(res); if (!res.destroyed) res.end(body);
    }); };
    return req;
  } });
  return { calls, http };
}
const request = () => ({ hostname: 'googleads.googleapis.com', path: `/v24/customers/${CUSTOMER}/googleAds:search`,
  token: Buffer.from(ACCESS), developerToken: Buffer.from(DEVELOPER), loginCustomerId: MANAGER, json: { query: 'SELECT customer.id FROM customer LIMIT 2' } });
test('Ads private transport uses fixed TLS origin, POST and validated OAuth/developer/manager headers', async () => {
  const w = wire(); await w.http(request());
  const sent = w.calls[0]; assert.equal(sent.options.method, 'POST'); assert.equal(sent.options.port, 443);
  assert.equal(sent.options.rejectUnauthorized, true); assert.equal(sent.options.minVersion, 'TLSv1.2');
  assert.equal(sent.options.headers.authorization, 'Bearer ' + ACCESS);
  assert.equal(sent.options.headers['developer-token'], DEVELOPER); assert.equal(sent.options.headers['login-customer-id'], MANAGER);
  assert.deepEqual(JSON.parse(sent.sent), request().json);
  await w.http({ ...request(), loginCustomerId: null }); assert.equal(w.calls[1].options.headers['login-customer-id'], undefined);
});
test('Ads transport cannot reach mutation/version/foreign paths or forward injected credentials', async () => {
  const w = wire();
  for (const changes of [{ hostname: 'evil.invalid' }, { path: `/v24/customers/${CUSTOMER}/googleAds:mutate` },
    { path: `/v25/customers/${CUSTOMER}/googleAds:search` }, { path: `/v24/customers/${CUSTOMER}/googleAds:search?key=x` },
    { developerToken: Buffer.from('injected\r\nsecret') }, { loginCustomerId: 1234567890 }, { loginCustomerId: '123\r\nHeader' },
    { developerToken: undefined }, { form: 'key=value' }, { json: [] }]) {
    await assert.rejects(w.http({ ...request(), ...changes }), { code: 'invalid_request' });
  }
  await assert.rejects(w.http({ hostname: 'oauth2.googleapis.com', path: '/token', form: 'fictitious', developerToken: Buffer.from(DEVELOPER) }), { code: 'invalid_request' });
  assert.equal(w.calls.length, 0);
});
test('Ads rejects redirects, compression, non-JSON, authorization errors and oversized provider bodies', async () => {
  for (const config of [{ status: 302 }, { headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' } },
    { headers: { 'content-type': 'text/html' } }, { body: 'bad JSON' }, { body: '{"ignored":"' + 'x'.repeat(16 * 1024 * 1024) + '"}' }]) {
    await assert.rejects(wire(config).http(request()), error => error.code === 'provider_failed' && !error.response);
  }
  await assert.rejects(wire({ status: 403, body: '{"error":"FICTITIOUS_SECRET"}' }).http(request()), { code: 'provider_unauthorized' });
});
test('developer secret is read from approved ARN/KMS/current version, zeroed after callback and never returned', async t => {
  const f = adsFixture(t); let captured;
  const withSecret = createGoogleAdsDeveloperSecret({ client: f.sdk, accountId: runtime.ACCOUNT,
    prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: runtime.SECRET_KEY });
  assert.deepEqual(await withSecret(f.binding, token => { captured = token; assert.equal(token.toString(), DEVELOPER); return { ok: true }; }), { ok: true });
  assert.ok(captured.every(byte => byte === 0));
  await assert.rejects(withSecret(f.binding, token => ({ leaked: token.toString() })), { code: 'provider_failed' });
  for (const patch of [{ provider: 'google_search_console' }, { developerSecretArn: 'arn:aws:secretsmanager:eu-west-3:999999999999:secret:other' }]) {
    const before = f.state.sdk.length; await assert.rejects(withSecret({ ...f.binding, ...patch }, () => assert.fail('No callback')), { code: 'secret_unavailable' });
    assert.equal(f.state.sdk.length, before);
  }
  const bad = createGoogleAdsDeveloperSecret({ client: { send: async () => ({ ARN: f.binding.developerSecretArn, KmsKeyId: 'wrong' }) },
    accountId: runtime.ACCOUNT, prefix: '/clinicaclick/integrations/prod/', kmsKeyArn: runtime.SECRET_KEY });
  await assert.rejects(bad(f.binding, () => assert.fail('No callback')), { code: 'secret_unavailable' });
});
