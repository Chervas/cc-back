'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const { pack, keyFor } = require('../src/event'); const { fixture } = require('./fixture.cjs');
const { createWriter, createReconciler, BUCKET, KEY_ARN, ACCOUNT } = require('../src/s3');
function metadata(row) { return { VersionId: 'fictitious-version-1', ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KEY_ARN,
  ChecksumSHA256: Buffer.from(row.digest, 'hex').toString('base64'), ContentLength: Buffer.byteLength(row.body) }; }
test('writer only puts a unique object to fixed owner/bucket/key/KMS with conditional checksum', async () => {
  const row = pack(fixture()); const calls = [];
  const writer = createWriter({ send: async command => { calls.push(command); return metadata(row); } });
  const receipt = await writer.write(row); assert.equal(receipt.key, keyFor(row)); assert.equal(calls.length, 1);
  assert.equal(calls[0].constructor.name, 'PutObjectCommand'); const input = calls[0].input;
  assert.equal(input.Bucket, BUCKET); assert.equal(input.ExpectedBucketOwner, ACCOUNT); assert.equal(input.SSEKMSKeyId, KEY_ARN);
  assert.equal(input.IfNoneMatch, '*'); assert.equal(input.BucketKeyEnabled, false); assert.equal(input.Body, row.body);
  assert(!Object.hasOwn(input, 'ACL'));
});
test('lost ACK/412 and invalid encryption/checksum/version never count as delivered or escalate to reader', async () => {
  const row = pack(fixture());
  for (const response of [{ ...metadata(row), VersionId: 'null' }, { ...metadata(row), ChecksumSHA256: 'wrong' },
    { ...metadata(row), SSEKMSKeyId: KEY_ARN + 'wrong' }, { ...metadata(row), ServerSideEncryption: 'AES256' }]) {
    await assert.rejects(createWriter({ send: async () => response }).write(row), /audit_reconciliation_required/);
  }
  await assert.rejects(createWriter({ send: async () => { throw { name: 'PreconditionFailed' }; } }).write(row), /audit_reconciliation_required/);
  await assert.rejects(createWriter({ send: async () => { throw Error('SENTINEL_SECRET'); } }).write(row), /^Error: audit_unavailable$/);
});
test('separate reader reconciles exact bytes/version/checksum and destroys bounded body', async () => {
  const row = pack(fixture()); const calls = [];
  const reader = createReconciler({ send: async command => { calls.push(command); return { ...metadata(row), Body: Readable.from([row.body]) }; } });
  const receipt = await reader.write(row); assert.equal(receipt.versionId, 'fictitious-version-1');
  assert.equal(calls[0].constructor.name, 'GetObjectCommand'); assert.equal(calls[0].input.Key, keyFor(row));
  assert.equal(calls[0].input.ChecksumMode, 'ENABLED');
  for (const body of [row.body.replace('credentials_verified', 'credentials_rejected'), 'x'.repeat(4097)]) {
    const stream = Readable.from([body]);
    await assert.rejects(createReconciler({ send: async () => ({ ...metadata(row), Body: stream }) }).write(row), /audit_integrity_invalid/);
    assert.equal(stream.destroyed, true);
  }
});
