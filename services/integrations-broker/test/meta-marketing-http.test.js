'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream');
const { createMetaMarketingHttp } = require('../src/meta-marketing-http');
const TOKEN = 'FICTITIOUS_META_MARKETING_TOKEN', APP = '0123456789abcdef'.repeat(2);
function wire({ status = 200, headers = {}, response = {}, error, hold = false } = {}) {
  const calls = []; let destroyed = 0;
  const request = (options, callback) => {
    const req = new EventEmitter(); req.destroy = () => destroyed++;
    req.end = body => { calls.push({ options, body }); if (hold) return;
      queueMicrotask(() => { if (error) return req.emit('error', Error(error));
        const res = new PassThrough(); res.statusCode = status; res.headers = { 'content-type': 'application/json', ...headers };
        callback(res); res.end(typeof response === 'string' ? response : JSON.stringify(response));
      });
    }; return req;
  };
  return { request, calls, destroyed: () => destroyed };
}
const input = changes => ({ action: 'ad_account', id: '301', token: Buffer.from(TOKEN), proof: 'a'.repeat(64), ...changes });
test('fixed GET fields, version, TLS, body and credentials for each Meta asset; inspection stays internal', async () => {
  const f = wire(), http = createMetaMarketingHttp({ request: f.request });
  for (const action of ['ad_account', 'facebook_page', 'instagram_business', 'instagram_parent']) await http(input({ action }));
  for (const [index, row] of f.calls.entries()) {
    assert.equal(row.options.hostname, 'graph.facebook.com'); assert.equal(row.options.method, 'GET'); assert.equal(row.body, undefined);
    assert.equal(row.options.rejectUnauthorized, true); assert.equal(row.options.minVersion, 'TLSv1.2'); assert.equal(row.options.agent, false);
    assert.equal(row.options.headers.authorization, 'Bearer ' + TOKEN); assert(!row.options.path.includes(TOKEN));
    const url = new URL('https://graph.facebook.com' + row.options.path);
    assert.equal(url.pathname, '/v24.0/' + (index ? '' : 'act_') + '301');
    assert.deepEqual([...url.searchParams.keys()], ['fields', 'appsecret_proof']);
    assert.equal(url.searchParams.get('fields'), ['id,account_id,name,account_status,currency,timezone_name', 'id,name', 'id,name,username', 'id,instagram_business_account'][index]);
  }
  await http({ action: 'inspect', id: '101', candidate: Buffer.from(TOKEN), token: Buffer.from('101|' + APP) });
  const inspect = f.calls[4], url = new URL('https://graph.facebook.com' + inspect.options.path);
  assert.equal(url.pathname, '/v24.0/debug_token'); assert.equal(url.searchParams.get('input_token'), TOKEN);
  assert.equal(inspect.options.headers.authorization, 'Bearer 101|' + APP);
});
test('untyped hosts, tokens, paths, fields, bodies, cursors and send actions fail before transport', async () => {
  const f = wire(), http = createMetaMarketingHttp({ request: f.request });
  for (const changes of [{ hostname: 'example.invalid' }, { url: 'https://example.invalid' }, { id: '../301' }, { id: 'act_301' },
    { action: 'send' }, { action: 'constructor' }, { fields: 'access_token' }, { after: 'x' }, { json: {} },
    { candidate: Buffer.from(TOKEN) }, { proof: '' }, { token: Buffer.from('token\r\nheader') }]) await assert.rejects(http(input(changes)), { code: 'invalid_request' });
  assert.equal(f.calls.length, 0);
});
for (const [name, setup, code] of [
  ['redirect', { status: 302, headers: { location: 'https://example.invalid' } }, 'provider_failed'],
  ['gzip', { headers: { 'content-encoding': 'gzip' } }, 'provider_failed'],
  ['html', { headers: { 'content-type': 'text/html' } }, 'provider_failed'],
  ['oversized', { response: 'x'.repeat(131073) }, 'provider_failed'], ['broken JSON', { response: 'broken' }, 'provider_failed'],
  ['array', { response: [] }, 'provider_failed'], ['provider rejection', { status: 400, response: { error: { code: 190, message: TOKEN } } }, 'credential_revoked'],
  ['permission', { status: 403 }, 'provider_unauthorized'], ['rate limit', { status: 429 }, 'rate_limited'],
  ['network', { error: TOKEN + APP }, 'provider_failed'],
]) test('sanitized ' + name + ' without redirect or retry', async () => {
  const f = wire(setup); await assert.rejects(createMetaMarketingHttp({ request: f.request })(input()), e => {
    assert.equal(e.code, code); assert(!e.stack.includes(TOKEN)); assert(!e.stack.includes(APP)); return true;
  }); assert.equal(f.calls.length, 1);
});
test('abort and deadline destroy the request; an aborted caller opens no connection', async () => {
  const f = wire({ hold: true }), controller = new AbortController(), http = createMetaMarketingHttp({ request: f.request });
  const work = http(input({ signal: controller.signal })); controller.abort(); await assert.rejects(work, { code: 'provider_timeout' });
  await assert.rejects(http(input({ signal: controller.signal })), { code: 'provider_timeout' }); assert.equal(f.calls.length, 1); assert.equal(f.destroyed(), 1);
  const g = wire({ hold: true }), keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(createMetaMarketingHttp({ request: g.request, timeoutMs: 5 })(input()), { code: 'provider_timeout' }); }
  finally { clearTimeout(keepAlive); }
  assert.equal(g.calls.length, 1); assert.equal(g.destroyed(), 1);
});
