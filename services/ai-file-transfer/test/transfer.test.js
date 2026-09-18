'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { Readable, PassThrough } = require('node:stream');
const { createHash, randomUUID } = require('node:crypto');
const { TransferStore } = require('../src/store');
const { controlHandler, downloadHandler, server } = require('../src/server');
const { createClient } = require('../../../src/lib/aiFileTransferClient');
const C = require('../src/contract');
const bytes = Buffer.from('FICTITIOUS DOCUMENT: 12.10 EUR');
const metadata = buffer => ({ useCase: 'accounting_ocr', requestId: randomUUID(), mimeType: 'application/pdf',
  fileName: 'fictitious.pdf', sizeBytes: buffer.length, sha256: createHash('sha256').update(buffer).digest('hex') });
const tick = () => new Promise(resolve => setImmediate(resolve));
async function setup(t, options = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cc-transfer-')); const directory = path.join(dir, 'state');
  await fs.mkdir(directory, { mode: 0o700 });
  let time = Date.now(); const settings = { directory, origin: 'https://fictitious.invalid', environment: 'dev', now: () => time, ...options };
  const store = new TransferStore(settings); await store.open();
  const download = server(downloadHandler(store)), control = server(controlHandler(store), { control: true });
  const socket = path.join(dir, 'control.sock');
  await new Promise(resolve => download.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => control.listen(socket, resolve)); await fs.chmod(socket, 0o660);
  t.after(async () => { for (const instance of [download, control]) { instance.closeAllConnections(); await new Promise(resolve => instance.close(resolve)); }
    await Promise.all([...store.rows.keys()].map(id => store.remove(id))); await fs.rm(dir, { recursive: true, force: true }); });
  const client = createClient({ config: { origin: settings.origin, environment: settings.environment, controlSocket: socket, serverUid: process.getuid() }, now: settings.now });
  function request(target, { method = 'GET', headers = {}, body, local = false } = {}) {
    return new Promise((resolve, reject) => {
      const req = http.request({ ...(local ? { socketPath: socket } : { hostname: '127.0.0.1', port: download.address().port }),
        path: target, method, headers, agent: false }, res => {
        const chunks = []; res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }); req.on('error', reject); req.end(body);
    });
  }
  return { store, settings, directory, download, control, socket, client, request, advance: ms => { time += ms; },
    mint: (buffer = bytes, input = metadata(buffer)) => store.create(input, Readable.from([buffer])), token: ref => new URL(ref.url).pathname.slice(C.PREFIX.length) };
}
test('Unix control creates a private capability; HTTPS path serves exact bytes, HEAD and ranges; release revokes it', async t => {
  const f = await setup(t); let issued;
  const result = await f.client.withTransfer({ useCase: 'accounting_ocr', buffer: bytes, mimeType: 'application/pdf', fileName: 'fictitious.pdf' }, async ref => {
    issued = ref; const target = new URL(ref.url).pathname;
    assert.equal(f.store.status().transfers, 1);
    const head = await f.request(target, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(head.body.length, 0);
    const partial = await f.request(target, { headers: { range: 'bytes=0-9' } }); assert.equal(partial.status, 206); assert.deepEqual(partial.body, bytes.subarray(0, 10));
    const suffix = await f.request(target, { headers: { range: 'bytes=-4' } }); assert.deepEqual(suffix.body, bytes.subarray(-4));
    const full = await f.request(target); assert.equal(full.status, 200); assert.deepEqual(full.body, bytes);
    assert.equal(full.headers['cache-control'], 'private, no-store'); assert.equal(full.headers['referrer-policy'], 'no-referrer');
    assert.equal((await f.request(target, { headers: { range: 'bytes=999-' } })).status, 416);
    const names = await fs.readdir(f.directory); assert.equal(names.length, 2);
    for (const name of names) { assert(!name.includes(f.token(ref))); const info = await fs.stat(path.join(f.directory, name)); assert.equal(info.mode & 0o777, 0o600);
      assert(!(await fs.readFile(path.join(f.directory, name))).includes(Buffer.from(f.token(ref)))); }
    return 'accepted';
  });
  assert.equal(result, 'accepted'); assert.deepEqual(f.store.status(), { transfers: 0, reservedBytes: 0 });
  assert.equal((await f.request(new URL(issued.url).pathname)).status, 404); assert.deepEqual(await fs.readdir(f.directory), []);
});
test('a failed provider operation also revokes, with no automatic retry', async t => {
  const f = await setup(t); let ref, calls = 0;
  await assert.rejects(f.client.withTransfer({ useCase: 'accounting_ocr', buffer: bytes, mimeType: 'application/pdf', fileName: 'f.pdf' }, value => {
    ref = value; calls++; throw Error('provider_failed');
  }), /provider_failed/);
  assert.equal(calls, 1); assert.equal((await f.request(new URL(ref.url).pathname)).status, 404);
});
test('expiry is enforced without a cleanup tick and removes persisted files; restart recovers only unexpired capabilities', async t => {
  const f = await setup(t, { ttlMs: 1000 }); const ref = await f.mint();
  const recovered = new TransferStore(f.settings); await recovered.open(); assert.equal(recovered.lookup(f.token(ref)).row.input.sha256, ref.sha256);
  f.advance(1001); assert.equal((await f.request(new URL(ref.url).pathname)).status, 404);
  await f.store.cleanup(); assert.deepEqual(await fs.readdir(f.directory), []);
});
test('wrong hash and truncated streams never issue a reference or retain capacity', async t => {
  const f = await setup(t);
  await assert.rejects(f.mint(bytes, { ...metadata(bytes), sha256: '0'.repeat(64) }), { code: 'invalid_request' });
  await assert.rejects(f.mint(bytes.subarray(1), metadata(bytes)), { code: 'invalid_request' });
  assert.deepEqual(f.store.status(), { transfers: 0, reservedBytes: 0 }); assert.deepEqual(await fs.readdir(f.directory), []);
});
test('concurrent incomplete uploads reserve slots and bytes before reading, and disconnect releases them', async t => {
  const f = await setup(t, { maxTransfers: 1, maxStoredBytes: bytes.length }); const source = new PassThrough();
  const pending = f.store.create(metadata(bytes), source); const rejected = assert.rejects(pending);
  while (!f.store.rows.size) await tick();
  await assert.rejects(f.mint(), { code: 'rate_limited' });
  source.destroy(Error('fictitious_disconnect')); await rejected;
  assert.deepEqual(f.store.status(), { transfers: 0, reservedBytes: 0 }); await f.mint();
});
test('expired partial uploads cannot publish late files when cleanup races completion', async t => {
  const f = await setup(t, { ttlMs: 1000 }); const source = new PassThrough();
  const pending = f.store.create(metadata(bytes), source); const rejected = assert.rejects(pending);
  while (!f.store.rows.size) await tick(); source.write(bytes.subarray(0, 2)); f.advance(1001);
  await f.store.cleanup(); source.end(bytes.subarray(2)); await rejected;
  assert.deepEqual(await fs.readdir(f.directory), []); assert.equal(f.store.status().reservedBytes, 0);
});
test('public listener cannot mint or revoke and rejects unknown, malformed and queried capabilities', async t => {
  const f = await setup(t); const ref = await f.mint(); const target = new URL(ref.url).pathname;
  for (const candidate of ['/v1/status', '/v1/transfers', target + '?x=1', target + '/', C.PREFIX + 'x', '/api/ai-file-transfers/v1/../state'])
    assert.equal((await f.request(candidate)).status, 404);
  for (const method of ['POST', 'DELETE', 'PUT']) assert.equal((await f.request(target, { method })).status, 404);
  assert.equal((await f.request(target)).status, 200);
});
test('download budgets bound repeat reads independently of expiry', async t => {
  const f = await setup(t); const ref = await f.mint(); const target = new URL(ref.url).pathname;
  for (let i = 0; i < 3; i++) assert.equal((await f.request(target)).status, 200);
  assert.equal((await f.request(target)).status, 429);
  for (let i = 0; i < 13; i++) assert.equal((await f.request(target, { method: 'HEAD' })).status, 200);
  assert.equal((await f.request(target, { method: 'HEAD' })).status, 429);
});
test('altered file contents and symlinks are never served', async t => {
  const f = await setup(t); const ref = await f.mint(); const id = C.tokenHash(f.token(ref)); const filename = f.store.filename(id, 'data');
  await fs.writeFile(filename, Buffer.alloc(bytes.length, 65)); assert.equal((await f.request(new URL(ref.url).pathname)).status, 404);
  await fs.unlink(filename); await fs.symlink('/etc/passwd', filename); assert.equal((await f.request(new URL(ref.url).pathname)).status, 404);
});
test('references are bound to origin, environment, request, purpose and expiry', async t => {
  const f = await setup(t); const ref = await f.mint(); const expected = { expectedOrigin: f.settings.origin, environment: 'dev', requestId: ref.requestId, useCase: ref.useCase };
  assert.equal(C.reference(ref, expected), ref);
  for (const change of [{ environment: 'staging' }, { requestId: randomUUID() }, { useCase: 'whatsapp_audio' }, { expiresAt: Date.now() - 1 },
    { expiresAt: Date.now() + C.MAX_TTL_MS + 10000 }, { url: ref.url.replace('fictitious.invalid', 'evil.invalid') }, { url: ref.url + '?redirect=1' }, { extra: true }])
    assert.throws(() => C.reference({ ...ref, ...change }, expected));
});
test('slow downloads occupy a fixed slot until the socket closes, and revocation cancels active readers', { timeout: 10000 }, async t => {
  const f = await setup(t); const buffer = Buffer.alloc(32 * 1024 * 1024, 70); const ref = await f.mint(buffer);
  const target = new URL(ref.url).pathname; const clients = [];
  for (let i = 0; i < 4; i++) {
    // Request half a file so the byte budget permits all four stalled readers.
    const pending = new Promise((resolve, reject) => {
      const req = http.get({ hostname: '127.0.0.1', port: f.download.address().port, path: target,
        headers: { range: 'bytes=0-16777215' }, agent: false }, res => {
        res.on('error', () => {}); res.pause(); resolve({ req, res });
      }); req.on('error', reject);
    }); clients.push(await pending);
  }
  assert.equal((await f.request(target, { method: 'HEAD' })).status, 429);
  await f.store.revoke(f.token(ref));
  for (const { req } of clients) req.destroy();
  assert.equal((await f.request(target)).status, 404); assert.deepEqual(await fs.readdir(f.directory), []);
});
test('runtime refuses a duplicate before touching state and supports a clean restart', async t => {
  const { main } = require('../src/main'); const net = require('node:net');
  const f = await setup(t); const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve)); const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const directory = path.join(path.dirname(f.directory), 'runtime-state'); await fs.mkdir(directory, { mode: 0o700 });
  const filename = path.join(path.dirname(f.directory), 'runtime.json');
  const config = { version: 1, environment: 'dev', origin: f.settings.origin, directory,
    controlSocket: path.join(path.dirname(f.directory), 'runtime.sock'), controlGroupId: process.getgid(), port };
  await fs.writeFile(filename, JSON.stringify(config), { mode: 0o600 });
  const first = await main(filename); t.after(() => first.close());
  const ref = await first.store.create(metadata(bytes), Readable.from([bytes]));
  await assert.rejects(main(filename), { code: 'EADDRINUSE' });
  assert.equal(first.store.lookup(f.token(ref)).row.ready, true); await first.close();
  const next = await main(filename); assert.equal(next.store.lookup(f.token(ref)).row.ready, true);
  await next.store.revoke(f.token(ref)); await next.close();
});
