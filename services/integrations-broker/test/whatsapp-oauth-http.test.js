'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream'); const { createHmac } = require('node:crypto');
const { createWhatsappOAuthHttp } = require('../src/whatsapp-oauth-http');
const { createWhatsappPhoneVerifier } = require('../src/whatsapp-phone-verifier');
const { createWhatsappCredentialInspector } = require('../src/whatsapp-credential-inspector');
const { BrokerError } = require('../src/errors');
const APP = 'a'.repeat(32); const CODE = 'FICTITIOUS_OAUTH_CODE'; const TOKEN = 'FICTITIOUS_WHATSAPP_CANDIDATE'; const AT = 1800000000000;
const metadata = () => ({ appId: '101', subjectId: '201', wabaId: '301', phoneId: '401', tokenType: 'SYSTEM_USER',
  scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'], expiresAt: AT + 3600000, dataAccessExpiresAt: null });
function wire({ status = 200, response = { access_token: TOKEN, token_type: 'bearer', expires_in: 3600 }, headers = {}, error, hold = false } = {}) {
  const calls = []; let destroyed = 0;
  const request = (options, callback) => {
    const req = new EventEmitter(); req.destroy = () => { destroyed++; };
    req.end = body => { calls.push({ options, body }); if (hold) return;
      queueMicrotask(() => { if (error) return req.emit('error', Error(error));
        const res = new PassThrough(); res.statusCode = status; res.headers = { 'content-type': 'application/json', ...headers }; callback(res);
        res.end(typeof response === 'string' ? response : JSON.stringify(response));
      });
    }; return req;
  }; return { request, calls, destroyed: () => destroyed };
}
const input = () => ({ code: Buffer.from(CODE), appSecret: Buffer.from(APP) });
const transport = (f, extra = {}) => createWhatsappOAuthHttp({ appId: '101', redirectUri: 'https://app.example.invalid/whatsapp/callback', request: f.request, now: () => AT, ...extra });
test('SDK code exchange fixes app and empty return URI; token is borrowed only inside callback and wiped on return', async () => {
  const f = wire(); const supplied = input(); let borrowed;
  const work = transport(f).withExchangedToken(supplied, async (token, info) => { borrowed = token; assert.equal(token.toString(), TOKEN); assert.equal(info.expiresAt, AT + 3600000); return metadata(); });
  supplied.code.fill(0); supplied.appSecret.fill(0);
  assert.deepEqual(await work, metadata()); assert(borrowed.every(b => b === 0)); assert.equal(f.calls.length, 1);
  const { options, body } = f.calls[0]; const url = new URL('https://graph.facebook.com' + options.path);
  assert.equal(options.hostname, 'graph.facebook.com'); assert.equal(options.port, 443); assert.equal(options.protocol, 'https:');
  assert.equal(options.method, 'GET'); assert.equal(options.rejectUnauthorized, true); assert.equal(options.minVersion, 'TLSv1.2'); assert.equal(options.agent, false);
  assert.equal(options.headers.authorization, undefined); assert.equal(body, undefined); assert.equal(url.pathname, '/v24.0/oauth/access_token');
  assert.deepEqual(Object.fromEntries(url.searchParams), { client_id: '101', client_secret: APP, code: CODE, redirect_uri: '' });
});
test('Exchanged candidate passes real grant and paginated phone verifiers without returning credentials', async () => {
  const f = wire(); const calls = []; const values = [];
  const http = async request => {
    calls.push(request.action); values.push(request.token);
    if (request.action === 'inspect') return { data: { is_valid: true, app_id: '101', user_id: '201', type: 'SYSTEM_USER',
      scopes: metadata().scopes, expires_at: (AT + 3600000) / 1000, data_access_expires_at: 0,
      granular_scopes: metadata().scopes.map(scope => ({ scope, target_ids: ['301'] })) } };
    assert.equal(request.id, '301'); assert.equal(request.token.toString(), TOKEN);
    assert.equal(request.proof, createHmac('sha256', APP).update(TOKEN).digest('hex'));
    return request.after ? { data: [{ id: '401' }] } : { data: [{ id: '400' }], paging: { next: 'https://example.invalid/?access_token=FICTITIOUS', cursors: { after: 'next_cursor' } } };
  };
  const result = await transport(f).withExchangedToken(input(), async (candidate, { signal }) => {
    const appToken = Buffer.from('101|' + APP);
    try {
      const grant = await createWhatsappCredentialInspector({ http, now: () => AT })({ candidate, applicationToken: appToken,
        expected: { appId: '101', subjectId: '201', wabaId: '301', scopes: metadata().scopes }, signal });
      const phone = await createWhatsappPhoneVerifier({ http })({ wabaId: '301', phoneId: '401', token: candidate,
        proof: createHmac('sha256', APP).update(candidate).digest('hex'), signal });
      return { ...grant, phoneId: phone.phoneId };
    } finally { appToken.fill(0); }
  });
  assert.deepEqual(result, metadata()); assert.deepEqual(calls, ['inspect', 'phones', 'phones']);
  assert(values.every(v => v.every(b => b === 0))); assert(!JSON.stringify(result).includes(TOKEN));
});
for (const [name, options] of [
  ['redirect', { status: 302, headers: { location: 'https://example.invalid' } }], ['permission error', { status: 403 }],
  ['rate limit', { status: 429 }], ['network leak', { error: CODE + APP + TOKEN }],
  ['compression', { headers: { 'content-encoding': 'gzip' } }], ['HTML', { headers: { 'content-type': 'text/html' } }],
  ['oversize', { response: 'x'.repeat(32769) }], ['malformed JSON', { response: 'broken' }],
  ['missing token', { response: { token_type: 'bearer' } }], ['wrong token type', { response: { access_token: TOKEN, token_type: 'mac' } }],
  ['null token type', { response: { access_token: TOKEN, token_type: null } }], ['numeric token type', { response: { access_token: TOKEN, token_type: 1 } }],
  ['invalid expiry', { response: { access_token: TOKEN, token_type: 'bearer', expires_in: -1 } }],
  ['provider payload error', { response: { error: { code: 190, message: APP + CODE } } }],
]) test('Exchange rejects ' + name + ' without retries or exposing provider response', async () => {
  const f = wire(options);
  await assert.rejects(transport(f).withExchangedToken(input(), () => assert.fail('callback must not run')), e => {
    assert(e instanceof BrokerError); for (const v of [APP, CODE, TOKEN]) assert(!(e.stack + JSON.stringify(e)).includes(v)); return true;
  }); assert.equal(f.calls.length, 1);
});
test('Exchange requires pinned HTTPS configuration and rejects callback overrides before network', async () => {
  const f = wire();
  for (const change of [{ appId: '../101' }, { redirectUri: 'http://example.invalid/' }, { redirectUri: 'https://user:pass@example.invalid/' },
    { redirectUri: 'https://example.invalid/?secret=1' }, { redirectUri: 'https://example.invalid/#x' }, { timeoutMs: 10001 }]) assert.throws(() => transport(f, change));
  for (const change of [{ appId: '999' }, { redirectUri: 'https://example.invalid/' }, { hostname: 'example.invalid' },
    { code: Buffer.from('bad\ncode') }, { code: Buffer.from([255]) }, { appSecret: Buffer.alloc(32) }, { code: CODE }, { signal: {} }]) {
    await assert.rejects(transport(f).withExchangedToken({ ...input(), ...change }, metadata), { code: 'invalid_request' });
  } assert.equal(f.calls.length, 0);
});
test('Metadata projection rejects token leakage, foreign app, extra scopes and expiry expansion; borrowed tokens are always wiped', async () => {
  for (const change of [{ accessToken: TOKEN }, { subjectId: TOKEN }, { appId: '999' }, { scopes: ['ads_management'] },
    { scopes: ['public_profile'] }, { scopes: ['whatsapp_business_management', 'business_management'] },
    { expiresAt: AT + 3600001 }, { expiresAt: null }, { dataAccessExpiresAt: AT }]) {
    let held;
    await assert.rejects(transport(wire()).withExchangedToken(input(), token => { held = token; return { ...metadata(), ...change }; }));
    assert(held.every(b => b === 0));
  }
  let held;
  await assert.rejects(transport(wire()).withExchangedToken(input(), token => {
    held = token; const error = new BrokerError('scope_denied'); error.message = TOKEN; error.headers = { token: TOKEN }; throw error;
  }), e => e.code === 'scope_denied' && !JSON.stringify(e).includes(TOKEN) && !e.stack.includes(TOKEN));
  assert(held.every(b => b === 0));
  await assert.rejects(transport(wire()).withExchangedToken(input(), () => {
    const error = new BrokerError('scope_denied'); error.code = TOKEN; throw error;
  }), e => e.code === 'internal_error' && !e.stack.includes(TOKEN));
  const numeric = '12345678901234567890';
  await assert.rejects(transport(wire({ response: { access_token: numeric, token_type: 'bearer' } })).withExchangedToken(input(), token => {
    token.fill(0); return { ...metadata(), phoneId: numeric };
  }), { code: 'provider_failed' });
});
test('Abort before/during exchange and during borrowed-token callback stops waiting and erases token without retry', async () => {
  const f = wire({ hold: true }); const controller = new AbortController();
  const work = transport(f).withExchangedToken({ ...input(), signal: controller.signal }, metadata); controller.abort();
  await assert.rejects(work, { code: 'provider_timeout' }); assert.equal(f.calls.length, 1); assert.equal(f.destroyed(), 1);
  await assert.rejects(transport(f).withExchangedToken({ ...input(), signal: controller.signal }, metadata), { code: 'provider_timeout' }); assert.equal(f.calls.length, 1);
  const during = new AbortController(); let held;
  await assert.rejects(transport(wire()).withExchangedToken({ ...input(), signal: during.signal }, token => {
    held = token; during.abort(); return new Promise(() => {});
  }), { code: 'provider_timeout' }); assert(held.every(b => b === 0));
});
test('Exchange network deadline destroys its request; absent expires_in is not interpreted as verified non-expiration', async () => {
  const f = wire({ hold: true }); const alive = setTimeout(() => {}, 1000);
  try { await assert.rejects(transport(f, { timeoutMs: 5 }).withExchangedToken(input(), metadata), { code: 'provider_timeout' }); }
  finally { clearTimeout(alive); }
  assert.equal(f.calls.length, 1); assert.equal(f.destroyed(), 1);
  const result = await transport(wire({ response: { access_token: TOKEN, token_type: 'bearer' } })).withExchangedToken(input(), (token, info) => {
    assert.equal(info.expiresAt, null); return metadata(); // Expiration is supplied by the independent inspector.
  }); assert.equal(result.expiresAt, AT + 3600000);
});
test('Missing token_type can reach the inspector but grants and metadata are still required and buffers erased', async () => {
  const f = wire({ response: { access_token: TOKEN } }); let held;
  const result = await transport(f).withExchangedToken(input(), (token, info) => {
    held = token; assert.equal(info.expiresAt, null); return metadata();
  });
  assert.deepEqual(result, metadata()); assert(held.every(b => b === 0)); assert.equal(f.calls.length, 1);
  await assert.rejects(transport(wire({ response: { access_token: TOKEN } })).withExchangedToken(input(), () => ({ ...metadata(), scopes: ['ads_management'] })), { code: 'oauth_credentials_incomplete' });
});
