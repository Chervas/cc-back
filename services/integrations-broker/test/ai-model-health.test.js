'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { validate, createModelHealthHttp } = require('../src/ai-model-health');
const payload = { useCase: 'provider_health', timeoutMs: 5000, body: { model: 'whisper-large-v3-turbo' } };
function fixture({ status = 200, body = { id: payload.body.model, object: 'model', active: true }, stall = false, headers = {} } = {}) {
  const calls = [];
  const http = createModelHealthHttp({ request(options, callback) {
    const req = new EventEmitter(); req.destroy = () => { req.destroyed = true; };
    req.end = bytes => { calls.push({ options, bytes, req }); if (stall) return;
      setImmediate(() => { const res = new PassThrough(); res.statusCode = status;
        res.headers = { 'content-type': 'application/json', ...headers }; callback(res); res.end(JSON.stringify(body)); }); };
    return req;
  } });
  return { calls, call: (changes = {}) => http({ payload, token: Buffer.from('FICTITIOUS_KEY'), ...changes }) };
}
test('model health uses one fixed HTTPS GET, no body and only projects model availability', async () => {
  const f = fixture({ body: { id: payload.body.model, object: 'model', active: true, metadata: 'FICTITIOUS_PRIVATE_PROVIDER_FIELD' } });
  assert.deepEqual(await f.call(), { model: payload.body.model, available: true }); assert.equal(f.calls.length, 1);
  const { options, bytes } = f.calls[0]; assert.equal(options.hostname, 'api.groq.com'); assert.equal(options.port, 443);
  assert.equal(options.path, '/openai/v1/models/whisper-large-v3-turbo'); assert.equal(options.method, 'GET');
  assert.equal(options.rejectUnauthorized, true); assert.equal(options.headers.authorization, 'Bearer FICTITIOUS_KEY'); assert.equal(bytes, undefined);
});
test('health schema rejects injected credentials, URL/path changes and unrelated purposes', () => {
  validate(payload);
  for (const change of [{ useCase: 'whatsapp_audio' }, { body: { model: '../models' } }, { body: { model: payload.body.model, token: 'fake' } },
    { body: { model: payload.body.model, url: 'https://evil.invalid' } }, { timeoutMs: 10001 }, { extra: true }])
    assert.throws(() => validate({ ...payload, ...change }), { code: 'invalid_request' });
});
test('absent or inactive models return unavailable, while mismatches and oversized/compressed responses fail', async () => {
  assert.deepEqual(await fixture({ status: 404 }).call(), { model: payload.body.model, available: false });
  assert.equal((await fixture({ body: { id: payload.body.model, object: 'model', active: false } }).call()).available, false);
  for (const options of [{ body: { id: 'foreign', object: 'model' } }, { body: { id: payload.body.model, object: 'other' } },
    { body: { id: payload.body.model, object: 'model', active: 'true' } }, { body: { text: 'x'.repeat(16385) } },
    { headers: { 'content-encoding': 'gzip' } }]) await assert.rejects(fixture(options).call(), { code: 'provider_failed' });
});
test('health never follows redirects/retries or exposes error bodies; abort closes the only request', async () => {
  for (const [status, code] of [[302, 'provider_failed'], [401, 'provider_unauthorized'], [403, 'provider_unauthorized'], [429, 'rate_limited'], [500, 'provider_failed']]) {
    const f = fixture({ status, body: { error: 'FICTITIOUS_SECRET' } }); await assert.rejects(f.call(), { code, message: code }); assert.equal(f.calls.length, 1);
  }
  const f = fixture({ stall: true }), controller = new AbortController(); const pending = f.call({ signal: controller.signal });
  controller.abort(); await assert.rejects(pending, { code: 'provider_timeout' }); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].req.destroyed, true);
});
