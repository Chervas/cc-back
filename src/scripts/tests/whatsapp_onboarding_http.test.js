'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const http = require('node:http');
const express = require('express'); const { randomUUID } = require('node:crypto');
const { connectionForTestServer } = require('./fixtures/campaign_offline_runtime.cjs');
const { createRouter } = require('../../routes/whatsapp-onboarding.routes');
async function fixture(t) {
  const state = { enabled: true, calls: [], auth: 0, failure: null, generalParser: 0 }; const sessionRef = randomUUID();
  const router = createRouter({ guard: () => { if (!state.enabled) throw Object.assign(Error('FICTITIOUS_INTERNAL_SECRET'), { code: 'whatsapp_onboarding_disabled' }); },
    authenticate: (req, res, next) => { state.auth++;
      if (req.get('authorization') !== 'Bearer FICTITIOUS_JWT') return res.status(401).json({ error: { code: 'auth_invalid' } });
      req.userData = { userId: 501 }; req.authSession = { id: sessionRef, expiresAt: 1900000000 }; next();
    }, listing:{list:async input=>{state.calls.push({name:'authorizations',input});return {authorizations:[],incomplete:false};}}, service: Object.fromEntries(['begin','finish','status','cancel'].map(name => [name, async input => {
      state.calls.push({ name, input }); if (state.failure) throw state.failure;
      return { requestId: input.requestId, connected: false, authorizationStatus: 'processing' };
    }])) });
  const app = express(); app.use('/api/whatsapp/onboarding', router);
  app.use(express.json({ verify: () => { state.generalParser++; } }));
  const server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const agent = new http.Agent({ keepAlive: false }); agent.createConnection = connectionForTestServer(server);
  t.after(() => new Promise(resolve => { agent.destroy(); server.close(resolve); server.closeAllConnections(); }));
  const request = (operation, body, headers = {}, method = 'POST') => new Promise((resolve, reject) => {
    const data = typeof body === 'string' ? body : JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port: server.address().port, agent, method, path: '/api/whatsapp/onboarding/' + operation,
      headers: { origin: 'https://crm.clinicaclick.com', authorization: 'Bearer FICTITIOUS_JWT', 'x-whatsapp-onboarding': '1',
        'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, res => {
      const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('end', () => {
        const text = Buffer.concat(chunks).toString(); assert(!text.includes('FICTITIOUS_INTERNAL_SECRET'));
        resolve({ status: res.statusCode, body: res.headers['content-type']?.startsWith('text/html') ? text : JSON.parse(text), headers: res.headers });
      });
    }); req.on('error', reject); req.end(data);
  });
  return { state, sessionRef, request };
}
test('Authorization listing accepts scoped or all-view requests using only middleware identity',async t=>{
 const f=await fixture(t);
 for(const scope of [null,{type:'group',id:29}]){
  const response=await f.request('authorizations',{scope});assert.equal(response.status,200);assert.deepEqual(response.body,{authorizations:[],incomplete:false});
  assert.deepEqual(f.state.calls.at(-1).input,{scope,userId:501,sessionRef:f.sessionRef,sessionExpiresAt:1900000000});
 }
 for(const extra of [{userId:1},{sessionRef:randomUUID()},{requestId:randomUUID()},{code:'FICTITIOUS'}])assert.equal((await f.request('authorizations',{scope:null,...extra})).status,400);
 assert.equal((await f.request('authorizations',{scope:null},{},'GET')).status,400);
 assert.equal((await f.request('authorizations',{scope:null},{origin:'https://foreign.invalid'})).status,403);
 assert.equal(f.state.generalParser,0);
});
test('Dedicated routes forward verified middleware identity and keep all bodies outside the general raw parser', async t => {
  const f = await fixture(t); const requestId = randomUUID();
  for (const [name, extra] of [['begin', { scope: { type: 'group', id: 9 } }], ['finish', { state: 's'.repeat(43), code: 'FICTITIOUS_CODE', wabaId: '301', phoneId: '401' }], ['status', {}], ['cancel', {}]]) {
    const result = await f.request(name, { requestId, ...extra }); assert.equal(result.status, 200);
    assert.equal(result.headers['cache-control'], 'no-store'); assert.equal(result.headers['referrer-policy'], 'no-referrer');
    assert.deepEqual(f.state.calls.at(-1).input, { requestId, ...extra, userId: 501, sessionRef: f.sessionRef, sessionExpiresAt: 1900000000 });
  }
  assert.equal(f.state.generalParser, 0);
});
test('Static signup frame is gated, contains no account data, restricts embedding and never authenticates by cookie', async t => {
  const f = await fixture(t);
  const frame = await f.request('window', '', { authorization: '', origin: '', 'x-whatsapp-onboarding': '', cookie: 'token=FICTITIOUS_JWT' }, 'GET');
  assert.equal(frame.status, 200); assert.equal(f.state.auth, 0); assert.equal(f.state.calls.length, 0);
  assert.match(frame.headers['content-security-policy'], /frame-ancestors https:\/\/app.clinicaclick.com https:\/\/crm.clinicaclick.com/);
  assert(!frame.headers['content-security-policy'].includes('unsafe-inline')); assert(!frame.body.includes('FICTITIOUS_JWT'));
  assert.match(frame.body, /nonce="[A-Za-z0-9+/=]+"/); assert.equal(frame.headers['cache-control'], 'no-store');
  assert.notEqual((await f.request('window', '', {}, 'GET')).headers['content-security-policy'], frame.headers['content-security-policy']);
  assert.equal((await f.request('window?code=FICTITIOUS_CODE', '', {}, 'GET')).status, 400);
  f.state.enabled = false; const denied = await f.request('window', '', {}, 'GET');
  assert.equal(denied.status, 503); assert.equal(denied.headers['cache-control'], 'no-store'); assert.equal(f.state.auth, 0);
});
test('No caller identity override, cookies, foreign Origin, missing custom header or runtime hint can authorize an operation', async t => {
  const f = await fixture(t); const body = { requestId: randomUUID() };
  for (const field of ['userId','sessionRef','sessionExpiresAt','runtime_namespace','accessToken','redirectUri'])
    assert.equal((await f.request('status', { ...body, [field]: 'FICTITIOUS_INTERNAL_SECRET' })).status, 400);
  for (const origin of ['', 'https://other.invalid', 'http://localhost:4203', 'null', 'https://crm.clinicaclick.com.evil.invalid'])
    assert.equal((await f.request('status', body, { origin })).status, 403);
  assert.equal((await f.request('status', body, { 'x-whatsapp-onboarding': '' })).status, 403);
  assert.equal((await f.request('status', body, { authorization: '', cookie: 'token=FICTITIOUS_JWT' })).status, 401);
  assert.equal((await f.request('status?userId=1', body)).status, 400);
  assert.equal((await f.request('status', body, {}, 'GET')).status, 400);
  assert.equal(f.state.calls.length, 0);
});
test('Gate and strict parser prevent oversized, malformed, compressed or non-JSON bodies from reaching services', async t => {
  const f = await fixture(t); const body = { requestId: randomUUID() }; f.state.enabled = false;
  assert.equal((await f.request('status', body)).status, 503); assert.equal(f.state.auth, 0); f.state.enabled = true;
  assert.equal((await f.request('status', '{malformed')).status, 400);
  assert.equal((await f.request('status', { ...body, padding: 'x'.repeat(8192) })).status, 413);
  assert.equal((await f.request('status', body, { 'content-encoding': 'gzip' })).status, 415);
  assert.equal((await f.request('status', body, { 'content-type': 'text/plain' })).status, 415);
  assert.equal(f.state.calls.length, 0); assert.equal(f.state.generalParser, 0);
});
test('Public errors contain fixed codes and explicit uncertainty without provider, SQL or credential content', async t => {
  const f = await fixture(t); const body = { requestId: randomUUID() };
  f.state.failure = Object.assign(Error('FICTITIOUS_INTERNAL_SECRET'), { code: 'whatsapp_onboarding_result_unknown', status: 200 });
  const unknown = await f.request('status', body); assert.equal(unknown.status, 503); assert.equal(unknown.body.outcomeUnknown, true);
  f.state.failure = Object.assign(Error('FICTITIOUS_INTERNAL_SECRET'), { code: 'auth_invalid' });
  assert.equal((await f.request('status', body)).status, 401);
  f.state.failure = Object.assign(Error('FICTITIOUS_INTERNAL_SECRET'), { code: 'auth_email_verification_required', status: 401 });
  const stepUp = await f.request('begin', { ...body, scope: { type: 'clinic', id: 71 } });
  assert.equal(stepUp.status, 403);
  assert.deepEqual(stepUp.body, { error: { code: 'auth_email_verification_required' }, outcomeUnknown: false });
  f.state.failure = Error('FICTITIOUS_INTERNAL_SECRET');
  assert.deepEqual((await f.request('status', body)).body, { error: { code: 'whatsapp_authorization_unavailable' }, outcomeUnknown: false });
});
