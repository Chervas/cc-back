'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const https = require('node:https');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { execFileSync } = require('node:child_process');
const { createServer } = require('../src/server');
const { MAX_REQUEST_BYTES, MAX_CONCURRENT_REQUESTS } = require('../src/ai-limits');
const { allowPort, removePort } = require('./offline-guard.cjs');

async function setup(t, execute, profile = 'ai') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-ai-admission-'));
  const cert = path.join(dir, 'tls.crt'), key = path.join(dir, 'tls.key');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key,
    '-out', cert, '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore' });
  const ca = fs.readFileSync(cert);
  const server = createServer({ execute }, { cert: ca, key: fs.readFileSync(key) }, { transportProfile: profile });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; allowPort(port);
  t.after(async () => {
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    removePort(port); fs.rmSync(dir, { recursive: true, force: true });
  });
  function request({ body = '{}', length = Buffer.byteLength(body), headersOnly = false, pauseResponse = false } = {}) {
    let response;
    const req = https.request({ hostname: '127.0.0.1', port, path: '/v1/execute', method: 'POST', ca,
      agent: false, headers: { 'content-type': 'application/json', ...(length === null ? {} : { 'content-length': length }) } });
    const started = new Promise(resolve => req.once('response', res => { response = res; resolve(res); }));
    const done = new Promise(resolve => {
      req.on('error', error => resolve({ error: error.code }));
      req.on('response', res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
        res.on('error', error => resolve({ error: error.code }));
        if (pauseResponse) res.pause();
      });
    });
    if (headersOnly) req.flushHeaders(); else req.end(body);
    return { req, done, started, resume: () => response.resume() };
  }
  return { server, request };
}
const result = () => ({ requestId: 'fictitious', replayed: false, data: { accepted: true } });
const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('AI rejects a second upload from declared byte pressure before reading its body or executing provider work', { timeout: 10000 }, async t => {
  let calls = 0;
  const f = await setup(t, async () => { calls++; return result(); });
  const incoming = once(f.server, 'request');
  const first = f.request({ length: MAX_REQUEST_BYTES, headersOnly: true });
  const [req] = await incoming;
  const rejected = await f.request({ headersOnly: true }).done;
  assert.deepEqual(rejected, { status: 429, body: { error: { code: 'rate_limited' } } });
  assert.equal(calls, 0);
  const closed = once(req, 'close').catch(() => null); first.req.destroy(); await closed; await nextTurn();
  assert.equal((await f.request().done).status, 200); assert.equal(calls, 1);
});

test('AI concurrency remains reserved after the caller disconnects until provider work finishes', { timeout: 10000 }, async t => {
  const pending = [], arrivals = [];
  const f = await setup(t, () => new Promise(resolve => { pending.push(resolve); arrivals.shift()?.(); }));
  const clients = [];
  for (let i = 0; i < MAX_CONCURRENT_REQUESTS; i++) {
    const arrived = new Promise(resolve => arrivals.push(resolve)); clients.push(f.request()); await arrived;
  }
  const closed = new Promise(resolve => clients[0].req.once('close', resolve)); clients[0].req.destroy(); await closed; await nextTurn();
  assert.equal((await f.request({ headersOnly: true }).done).status, 429);
  assert.equal(pending.length, MAX_CONCURRENT_REQUESTS);
  pending[0](result()); await nextTurn();
  const arrived = new Promise(resolve => arrivals.push(resolve)); const next = f.request(); await arrived;
  assert.equal(pending.length, MAX_CONCURRENT_REQUESTS + 1);
  for (let i = 1; i < pending.length; i++) pending[i](result());
  assert.equal((await next.done).status, 200);
  for (const client of clients.slice(1)) assert.equal((await client.done).status, 200);
});

test('Backpressure on a large AI response retains capacity until its socket is closed', { timeout: 15000 }, async t => {
  const pending = [], arrivals = []; let first = true;
  const f = await setup(t, () => {
    if (first) { first = false; return { ...result(), data: { text: 'X'.repeat(8 * 1024 * 1024 - 4096) } }; }
    return new Promise(resolve => { pending.push(resolve); arrivals.shift()?.(); });
  });
  const stalled = f.request({ pauseResponse: true }); await stalled.started;
  const clients = [];
  for (let i = 1; i < MAX_CONCURRENT_REQUESTS; i++) {
    const arrived = new Promise(resolve => arrivals.push(resolve)); clients.push(f.request()); await arrived;
  }
  assert.equal((await f.request({ headersOnly: true }).done).status, 429);
  const closed = new Promise(resolve => stalled.req.once('close', resolve)); stalled.req.destroy(); await closed; await nextTurn();
  const arrived = new Promise(resolve => arrivals.push(resolve)); const next = f.request(); await arrived;
  for (const resolve of pending) resolve(result());
  assert.equal((await next.done).status, 200);
  for (const client of clients) assert.equal((await client.done).status, 200);
});

test('Missing or excessive AI lengths fail before execution; ordinary transports keep their size limit', { timeout: 10000 }, async t => {
  let calls = 0;
  const f = await setup(t, async () => { calls++; return result(); });
  for (const length of [null, 0, MAX_REQUEST_BYTES + 1]) {
    assert.equal((await f.request({ length, headersOnly: true }).done).status, 400);
  }
  assert.equal(calls, 0);
  const normal = await setup(t, async () => result(), 'default');
  assert.equal((await normal.request({ length: 32769, headersOnly: true }).done).status, 400);
  assert.equal((await normal.request().done).status, 200);
});
