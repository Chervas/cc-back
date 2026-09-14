'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs');
const { randomUUID, randomBytes, generateKeyPairSync } = require('node:crypto'); const { Readable } = require('node:stream');
const { pack, keyFor } = require('../src/event'); const { fixture } = require('./fixture.cjs');
const p = require('../src/reader-protocol'); const { readBatch, isolatedRead, READER_ROLE } = require('../src/reader');
const { ACCOUNT, BUCKET, KEY_ARN } = require('../src/s3'); const { cursorCodec, criteriaFor } = require('../src/view-contract');
const keys = generateKeyPairSync('ed25519'); const signing = { keyId: 'fictitious-viewer', privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }) };
function request(mode = 'confirmed', count = 1) {
  const rows = Array.from({ length: count }, () => pack(fixture()));
  const signed = p.signRequest({ mode, actorId: mode === 'confirmed' ? '1' : 'platform_audit_reconciler',
    sessionRef: mode === 'confirmed' ? randomUUID() : null,
    refs: rows.map(row => ({ key: keyFor(row), digest: row.digest, versionId: mode === 'confirmed' ? 'fictitious-version' : null })) }, signing);
  return { ...signed, rows };
}
function object(row, changes = {}) { return { ContentLength: Buffer.byteLength(row.body), ContentType: 'application/json',
  ChecksumSHA256: Buffer.from(row.digest, 'hex').toString('base64'), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KEY_ARN,
  VersionId: 'fictitious-version', Body: Readable.from([row.body]), ...changes }; }
test('reader rejects foreign paths, roles, actors, unexpected fields and oversized batches before any API operation', () => {
  const input = request().input;
  for (const change of [{ bucket: 'other' }, { mode: 'writer' }, { actorId: '701' }, { requestId: [input.requestId] },
    { refs: [] }, { refs: Array(26).fill(input.refs[0]) }, { refs: [{ ...input.refs[0], key: 'app/../secret' }] },
    { refs: [{ ...input.refs[0], versionId: null }] }]) assert.throws(() => p.inputFor({ ...input, ...change }));
});
test('confirmed reader gets the exact recorded version; reconciler returns only receipts, with maximum four parallel reads', async () => {
  for (const mode of ['confirmed', 'reconcile']) {
    const f = request(mode, 9); let active = 0; let maximum = 0;
    const client = { send: async command => {
      assert.equal(command.constructor.name, 'GetObjectCommand'); assert.equal(command.input.Bucket, BUCKET); assert.equal(command.input.ExpectedBucketOwner, ACCOUNT);
      assert.equal(command.input.VersionId, mode === 'confirmed' ? 'fictitious-version' : undefined);
      assert.equal(command.input.ChecksumMode, 'ENABLED'); active++; maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 1)); active--;
      return object(f.rows.find(row => keyFor(row) === command.input.Key));
    } };
    const result = await readBatch(f.input, client); assert.equal(maximum, 4); assert(result.results.every(v => v.status === 'verified'));
    if (mode === 'reconcile') assert(!JSON.stringify(result).includes('actor'));
    else assert.equal(result.results[0].body, f.rows[0].body);
    assert.throws(() => p.resultFor(f.input, { ...result, results: [...result.results].reverse() }));
  }
});
test('bad KMS, digest, content length, missing versions and raw SDK failures cannot become verified records', async () => {
  const f = request();
  for (const change of [{ SSEKMSKeyId: 'wrong' }, { ChecksumSHA256: 'wrong' }, { VersionId: 'wrong' },
    { ContentLength: 4097 }, { Body: Readable.from(['{}']) }]) {
    const result = object(f.rows[0], change); const read = await readBatch(f.input, { send: async () => result });
    assert.equal(read.results[0].status, 'error'); assert.equal(result.Body.destroyed, true);
  }
  const error = await readBatch(f.input, { send: async () => { throw Error('SENTINEL_SECRET'); } });
  assert.equal(error.results[0].error, 'audit_reader_unavailable'); assert(!JSON.stringify(error).includes('SENTINEL'));
});
test('runtime and target reader identities are verified; a writer source cannot become the reader source', async () => {
  const settings = { readerSourceRoleArn: `arn:aws:iam::${ACCOUNT}:role/fictitious-reader`, writerSourceRoleArn: `arn:aws:iam::${ACCOUNT}:role/fictitious-writer` };
  const identity = role => ({ Account: ACCOUNT, Arn: `arn:aws:sts::${ACCOUNT}:assumed-role/${role.split('/').at(-1)}/fixture` });
  let assumed = 0; let fetched = 0; const f = request();
  const api = { sourceIdentity: async () => identity(settings.readerSourceRoleArn), assumeReader: async () => { assumed++;
    return { identity: async () => identity(READER_ROLE), close() {}, client: { send: async () => { fetched++; return object(f.rows[0]); } } }; } };
  await assert.rejects(isolatedRead(f.input, { ...settings, readerSourceRoleArn: settings.writerSourceRoleArn }, api)); assert.equal(assumed, 0);
  await assert.rejects(isolatedRead(f.input, settings, { ...api, sourceIdentity: async () => identity(settings.writerSourceRoleArn) })); assert.equal(assumed, 0);
  await assert.rejects(isolatedRead(f.input, settings, { ...api, assumeReader: async () => ({ identity: async () => identity(settings.writerSourceRoleArn), close() {}, client: { send: () => assert.fail() } }) }));
  assert.equal((await isolatedRead(f.input, settings, api)).results[0].status, 'verified'); assert.equal(fetched, 1);
});
test('durable nonces and quota survive reader restart; journal has digests without event bodies or credentials', t => {
  const { ReaderStore } = require('../src/reader-store'); const dir = fs.mkdtempSync('/tmp/cc-audit-reader-'); fs.chmodSync(dir, 0o700);
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); const f = request(); const now = Date.parse('2026-09-12T12:00:00Z');
  let store = new ReaderStore(dir + '/state.sqlite');
  store.accept('viewer', f.input, now); store.close(); store = new ReaderStore(dir + '/state.sqlite');
  try {
    assert.throws(() => store.accept('viewer', f.input, now), /audit_reader_replayed/);
    for (let i = 0; i < 29; i++) store.accept('viewer', request().input, now);
    assert.throws(() => store.accept('viewer', request().input, now), /audit_reader_limited/);
    const rows = store.db.prepare('SELECT * FROM reads').all(); assert.equal(rows.length, 30);
    assert(!JSON.stringify(rows).includes('credentials_verified')); assert(!JSON.stringify(rows).includes('publicKey'));
  } finally { store.close(); }
});
test('signed cursors bind actor, session, filters and expiry; read events are canonical v3 without free text', () => {
  const criteria = criteriaFor({ from: '2026-09-01', to: '2026-09-12', action: null, userId: null }); const codec = cursorCodec(randomBytes(32));
  const now = Date.parse('2026-09-12T12:00:00Z'); const sessionRef = randomUUID();
  const state = { actorId: '1', sessionRef, criteria, snapshot: new Date(now).toISOString(), expiresAt: now + 600000,
    lastAt: new Date(now - 1).toISOString(), lastId: randomUUID() };
  const token = codec.seal(state); assert.equal(codec.open(token, '1', sessionRef, criteria, now).lastId, state.lastId);
  for (const args of [['44', sessionRef, criteria, now], ['1', randomUUID(), criteria, now], ['1', sessionRef, { ...criteria, userId: '1' }, now], ['1', sessionRef, criteria, now + 600000]]) assert.throws(() => codec.open(token, ...args));
  assert.throws(() => codec.open(token.slice(0, -2) + 'aa', '1', sessionRef, criteria, now));
  assert.throws(() => criteriaFor({ ...criteria, from: '2026-02-31' }));
  const value = { version: 3, eventId: randomUUID(), correlationId: randomUUID(), occurredAt: state.snapshot, action: 'audit.records.read',
    stage: 'attempted', outcome: 'unknown', reason: 'query_requested', actor: { type: 'user', id: '1' }, sessionRef, scope: { type: 'platform', id: null },
    criteria, resultCount: null, resultDigest: null, capturePolicy: 'audit-view-v1' };
  assert(keyFor(pack(value)).startsWith('app/platform/v3/'));
  assert.throws(() => pack({ ...value, jwt: 'SENTINEL' })); assert.throws(() => pack({ ...value, resultCount: 25 }));
});
