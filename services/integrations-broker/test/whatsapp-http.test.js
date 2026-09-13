'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { EventEmitter } = require('node:events'); const { PassThrough } = require('node:stream');
const { createWhatsappHttp } = require('../src/whatsapp-http'); const { SEND_TOKEN } = require('./whatsapp-fixture.cjs');
const input = overrides => ({ action: 'send', id: '401', token: Buffer.from(SEND_TOKEN), proof: 'a'.repeat(64),
  json: { messaging_product: 'whatsapp', type: 'text', to: '34000000123', text: { body: 'QA' } }, ...overrides });
function wire({ status = 200, headers = {}, response = {}, error, hold = false } = {}) {
  const calls = []; let destroyed = 0;
  const request = (options, callback) => {
    const req = new EventEmitter(); req.destroy = () => { destroyed++; };
    req.end = body => { calls.push({ options, body }); if (hold) return;
      queueMicrotask(() => { if (error) return req.emit('error', Error(error));
        const res = new PassThrough(); res.statusCode = status; res.headers = { 'content-type': 'application/json', ...headers }; callback(res);
        res.end(typeof response === 'string' ? response : JSON.stringify(response));
      });
    }; return req;
  };
  return { calls, request, destroyed: () => destroyed };
}
test('WhatsApp transport fixes hostname, version, paths and TLS; bearer never enters URL or body', async () => {
  const f = wire({ response: { ok: true } }); const http = createWhatsappHttp({ request: f.request });
  await http(input()); await http(input({ action: 'template', id: '901', json: undefined }));
  for (const [index, call] of f.calls.entries()) {
    assert.equal(call.options.hostname, 'graph.facebook.com'); assert.equal(call.options.port, 443); assert.equal(call.options.protocol, 'https:');
    assert.equal(call.options.agent, false); assert.equal(call.options.rejectUnauthorized, true); assert.equal(call.options.minVersion, 'TLSv1.2');
    assert.equal(call.options.headers.authorization, 'Bearer ' + SEND_TOKEN); assert(!call.options.path.includes(SEND_TOKEN)); assert(!call.body?.toString().includes(SEND_TOKEN));
    const url = new URL('https://graph.facebook.com' + call.options.path);
    assert.equal(url.pathname, index ? '/v24.0/901' : '/v24.0/401/messages'); assert.equal(call.options.method, index ? 'GET' : 'POST');
    assert.equal(url.searchParams.get('appsecret_proof'), 'a'.repeat(64));
    assert.deepEqual([...url.searchParams.keys()], index ? ['appsecret_proof', 'fields'] : ['appsecret_proof']);
    if (index) assert.equal(url.searchParams.get('fields'), 'id,name,language,status,components');
  }
});
for (const [name, setup, code] of [
  ['redirect', { status: 302, headers: { location: 'https://example.invalid' } }, 'provider_failed'],
  ['compression', { headers: { 'content-encoding': 'gzip' } }, 'provider_failed'],
  ['html', { headers: { 'content-type': 'text/html' } }, 'provider_failed'],
  ['oversize', { response: 'x'.repeat(131073) }, 'provider_failed'],
  ['bad JSON', { response: 'broken' }, 'provider_failed'],
  ['revocation', { status: 400, response: { error: { code: 190, message: SEND_TOKEN } } }, 'credential_revoked'],
  ['permission', { status: 403, response: { error: { code: 10, message: SEND_TOKEN } } }, 'provider_unauthorized'],
  ['rate limit', { status: 429 }, 'provider_failed'],
  ['network', { error: SEND_TOKEN }, 'provider_failed'],
]) test('transport rejects ' + name + ' without redirect, retry or secret error', async () => {
  const f = wire(setup); await assert.rejects(createWhatsappHttp({ request: f.request })(input()), e => e.code === code && !e.message.includes(SEND_TOKEN)); assert.equal(f.calls.length, 1);
});
test('transport refuses arbitrary URLs, operations and paths before constructing requests', async () => {
  const f = wire(); const http = createWhatsappHttp({ request: f.request });
  for (const change of [{ hostname: 'example.invalid' }, { id: '../123' }, { action: 'create' }, { proof: '' }, { token: Buffer.from('bad\r\ntoken') }, { action: 'template' }]) {
    await assert.rejects(http(input(change)), { code: 'invalid_request' });
  }
  assert.equal(f.calls.length, 0);
});
test('abort destroys one request and prevents an already aborted request from opening', async () => {
  const f = wire({ hold: true }); const http = createWhatsappHttp({ request: f.request }); const controller = new AbortController();
  const work = http(input({ signal: controller.signal })); controller.abort();
  await assert.rejects(work, { code: 'provider_timeout' }); assert.equal(f.destroyed(), 1);
  await assert.rejects(http(input({ signal: controller.signal })), { code: 'provider_timeout' }); assert.equal(f.calls.length, 1);
});
test('deadline destroys the in-flight request without retry', async () => {
  const f = wire({ hold: true }); const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(createWhatsappHttp({ request: f.request, timeoutMs: 5 })(input()), { code: 'provider_timeout' }); }
  finally { clearTimeout(keepAlive); }
  assert.equal(f.calls.length, 1); assert.equal(f.destroyed(), 1);
});
