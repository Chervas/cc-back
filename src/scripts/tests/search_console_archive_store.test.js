'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { createSearchConsoleArchiveStore, s3ArchiveTransport } = require('../../lib/searchConsoleArchiveStore');
const key = 'search-console/v1/' + 'a'.repeat(64) + '/2024-02/00000000-0000-4000-8000-000000000001.ndjson';
const settings = { bucket: 'fictitious-sc-archive', prefix: 'private/sc/', expectedBucketOwner: '111122223333',
  kmsKeyId: 'arn:aws:kms:eu-west-3:111122223333:key/00000000-0000-4000-8000-000000000002', partBytes: 1024 };
async function* stream(data, size = 131) { for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size); }
async function all(source) { const out = []; for await (const data of source) out.push(data); return Buffer.concat(out); }
function fake() {
  const objects = new Map(), calls = []; let next = 1;
  const transport = {
    async putObject(input) {
      calls.push({ operation: 'put', ...input });
      assert.equal(input.ExpectedBucketOwner, settings.expectedBucketOwner);
      assert.equal(input.ServerSideEncryption, 'aws:kms'); assert.equal(input.SSEKMSKeyId, settings.kmsKeyId);
      assert.equal(input.IfNoneMatch, '*'); assert.equal(input.ContentLength, input.Body.length);
      assert.equal(input.ChecksumSHA256, createHash('sha256').update(input.Body).digest('base64'));
      const VersionId = 'version-' + next++; objects.set(input.Key + ':' + VersionId, Buffer.from(input.Body));
      return { VersionId, ServerSideEncryption: 'aws:kms', SSEKMSKeyId: settings.kmsKeyId, ChecksumSHA256: input.ChecksumSHA256 };
    },
    async getObject(input) {
      calls.push({ operation: 'get', ...input });
      assert.equal(input.ExpectedBucketOwner, settings.expectedBucketOwner); assert.equal(input.ChecksumMode, 'ENABLED');
      const Body = objects.get(input.Key + ':' + input.VersionId);
      if (!Body) throw Error('not found - confidential provider detail');
      return { Body: stream(Body, 19), ContentLength: Body.length, VersionId: input.VersionId,
        ServerSideEncryption: 'aws:kms', SSEKMSKeyId: settings.kmsKeyId };
    },
  };
  return { transport, objects, calls, store: createSearchConsoleArchiveStore({ ...settings, transport }) };
}
test('versioned encrypted multi-object round-trip preserves exact bytes and publishes manifest last', async () => {
  const f = fake(), body = Buffer.from('línea con 🦷\n'.repeat(500));
  assert.equal(f.calls.length, 0);
  const receipt = await f.store.put({ key, body: stream(body), contentType: 'application/x-ndjson' });
  assert(receipt.bytes > settings.partBytes); assert(f.calls.at(-1).Key.endsWith('/manifest.json'));
  assert(Buffer.byteLength(JSON.stringify(receipt)) < 16384);
  assert.deepEqual(await all(await f.store.read(receipt)), body);
  assert.equal(receipt.sha256, createHash('sha256').update(body).digest('hex'));
});
test('unversioned, misencrypted or unchecksummed writes cannot publish a receipt', async () => {
  for (const mutation of [r => { r.VersionId = 'null'; }, r => { r.ServerSideEncryption = 'AES256'; },
    r => { r.SSEKMSKeyId += '-wrong'; }, r => { delete r.ChecksumSHA256; }]) {
    const f = fake(), original = f.transport.putObject;
    f.transport.putObject = async input => { const r = await original(input); mutation(r); return r; };
    await assert.rejects(f.store.put({ key, body: stream(Buffer.from('x\n')), contentType: 'application/x-ndjson' }), { code: 'sc_archive_store_write_unverified' });
    assert.equal(f.calls.some(c => c.Key.endsWith('/manifest.json')), false);
  }
});
test('content corruption is detected using pinned object versions and hashes', async () => {
  const f = fake(), receipt = await f.store.put({ key, body: stream(Buffer.from('a'.repeat(2400))), contentType: 'application/x-ndjson' });
  const part = f.calls.find(c => c.operation === 'put' && c.Key.endsWith('part-000001'));
  const id = [...f.objects.keys()].find(k => k.startsWith(part.Key + ':')); f.objects.set(id, Buffer.alloc(part.Body.length, 66));
  await assert.rejects(all(await f.store.read(receipt)), { code: 'sc_archive_store_digest_mismatch' });
});
test('receipts cannot retarget arbitrary keys, prefixes or versions', async () => {
  const f = fake(), receipt = await f.store.put({ key, body: stream(Buffer.from('x\n')), contentType: 'application/x-ndjson' });
  for (const mutate of [r => { r.manifest.key = 'another/key'; }, r => { r.logicalKey = '../secret'; },
    r => { r.manifest.versionId = 'null'; }, r => { r.extra = true; }]) {
    const changed = JSON.parse(JSON.stringify(receipt)); mutate(changed);
    await assert.rejects(f.store.read(changed), e => /^sc_archive_store_/.test(e.code));
  }
});
test('read captures receipt before awaiting the transport', async () => {
  const f = fake(), original = await f.store.put({ key, body: stream(Buffer.from('intact\n')), contentType: 'application/x-ndjson' });
  const receipt = JSON.parse(JSON.stringify(original)), get = f.transport.getObject;
  f.transport.getObject = async input => { receipt.sha256 = '0'.repeat(64); receipt.logicalKey = '../retarget'; return get(input); };
  assert.equal((await all(await f.store.read(receipt))).toString(), 'intact\n');
});
test('source failure retains written parts but never creates a publication manifest', async () => {
  const f = fake(); async function* failed() { yield Buffer.alloc(1024); throw Error('sensitive input failure'); }
  await assert.rejects(f.store.put({ key, body: failed(), contentType: 'application/x-ndjson' }), { code: 'sc_archive_store_source_failed' });
  assert.equal(f.calls.filter(c => c.operation === 'put').length, 1); assert.equal(f.objects.size, 1);
  assert.equal(f.calls.some(c => c.Key.endsWith('/manifest.json')), false);
});
test('bounded source and part budget fail closed without a manifest', async () => {
  for (const config of [{ maxTotalBytes: 1100 }, { maxParts: 1 }]) {
    const f = fake(), store = createSearchConsoleArchiveStore({ ...settings, ...config, transport: f.transport });
    await assert.rejects(store.put({ key, body: stream(Buffer.alloc(2500)), contentType: 'application/x-ndjson' }), e => /^sc_archive_store_/.test(e.code));
    assert.equal(f.calls.some(c => c.Key.endsWith('/manifest.json')), false);
  }
});
test('SDK bridge constructs pinned installed commands but never creates a client or sends automatically', async () => {
  const sent = [], transport = s3ArchiveTransport({ send: async c => { sent.push(c); return { VersionId: 'fixture' }; } });
  assert.equal(sent.length, 0); await transport.getObject({ Bucket: settings.bucket, VersionId: 'fixture' });
  assert.equal(sent[0].constructor.name, 'GetObjectCommand'); assert.equal(sent[0].input.VersionId, 'fixture');
});
test('installed SDK serializes the no-overwrite precondition on the actual signed request', async () => {
  const { S3Client } = require('@aws-sdk/client-s3');
  let observed;
  const client = new S3Client({ region: 'eu-west-3', credentials: { accessKeyId: 'fictitious', secretAccessKey: 'fictitious' }, maxAttempts: 1,
    requestHandler: { handle: async request => { observed = request; return { response: { statusCode: 200, headers: {}, body: Buffer.alloc(0) } }; } } });
  try {
    await s3ArchiveTransport(client).putObject({ Bucket: settings.bucket, Key: 'private/test', Body: Buffer.from('x'), IfNoneMatch: '*' });
    assert.equal(observed.headers['if-none-match'], '*');
  } finally { client.destroy(); }
});
test('configuration rejects public/path injection or cross-account encryption selectors', () => {
  for (const patch of [{ bucket: '127.0.0.1' }, { prefix: '../' }, { prefix: 'double//path/' },
    { expectedBucketOwner: 'not-an-account' }, { kmsKeyId: settings.kmsKeyId.replace('111122223333', '999900001111') }]) {
    assert.throws(() => createSearchConsoleArchiveStore({ ...settings, ...patch, transport: fake().transport }), e => /^sc_archive_store_/.test(e.code));
  }
});
test('default 4MiB parts remain compatible with the bounded archive verifier', async () => {
  const { verifySearchConsoleArchive } = require('../../lib/searchConsoleArchiveVerifier');
  const f = fake(), store = createSearchConsoleArchiveStore({ ...settings, partBytes: undefined, transport: f.transport });
  const hash = value => createHash('sha256').update(value).digest('hex');
  const header = { version: 1, siteUrl: 'sc-domain:fixture.example', startDate: '2024-02-01', endDate: '2024-02-29', revision: '0' };
  const lines = [JSON.stringify(header)];
  for (let i = 1; i <= 2000; i++) {
    const query = 'x'.repeat(1000) + i;
    const row = { date: '2024-02-01', query_id: String(i), page_id: '1', query, page_url: '', clicks: '1', impressions: '1',
      position_weighted: '1.000000000', position_sum: '1.000000000', position_count: '1' };
    row.row_digest = hash(JSON.stringify([row.date, hash(query), hash(''), row.clicks, row.impressions, row.position_weighted, row.position_sum, row.position_count]));
    lines.push(JSON.stringify(row));
  }
  const data = Buffer.from(lines.join('\n') + '\n'); assert(data.length > 1024 * 1024);
  const receipt = await store.put({ key, body: stream(data, 60000), contentType: 'application/x-ndjson' });
  const verified = await verifySearchConsoleArchive(await store.read(receipt), { siteUrl: header.siteUrl, month: '2024-02',
    sha256: hash(data), bytes: data.length, rows: 2000 });
  assert.equal(verified.rowCount, 2000);
});
