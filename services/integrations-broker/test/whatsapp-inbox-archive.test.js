'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { PutObjectCommand, HeadObjectCommand, PutObjectTaggingCommand } = require('@aws-sdk/client-s3');
const { BUCKET, createInboxArchive } = require('../src/whatsapp-inbox-archive');
const { PAYLOAD_KEY } = require('../src/whatsapp-inbox-key');
const receipt = '12345678-1234-1234-1234-123456789abc';

test('S3 archive writes encrypted envelope once with a content checksum and pinned owner', async () => {
  const body = Buffer.from('synthetic-encrypted-envelope');
  const checksum = createHash('sha256').update(body).digest('base64');
  let calls = 0;
  const archive = createInboxArchive({ client: { async send(command) {
    calls++;
    assert(command instanceof PutObjectCommand);
    assert.equal(command.input.Bucket, BUCKET);
    assert.equal(command.input.ExpectedBucketOwner, '137819318729');
    assert.equal(command.input.IfNoneMatch, '*');
    assert.equal(command.input.ChecksumSHA256, checksum);
    return { ChecksumSHA256: checksum };
  } } });
  assert.deepEqual(await archive.put(receipt, body), { archived: true });
  assert.equal(calls, 1);
});
test('an uncertain completed upload is accepted only if the existing object matches', async () => {
  const body = Buffer.from('synthetic-encrypted-envelope');
  let calls = 0;
  const archive = createInboxArchive({ client: { async send(command) {
    calls++;
    if (command instanceof PutObjectCommand) throw { $metadata: { httpStatusCode: 412 } };
    assert(command instanceof HeadObjectCommand);
    return { ContentLength: body.length, Metadata: { sha256: createHash('sha256').update(body).digest('hex') } };
  } } });
  assert.deepEqual(await archive.put(receipt, body), { archived: true });
  assert.equal(calls, 2);
  const mismatch = createInboxArchive({ client: { async send(command) {
    if (command instanceof PutObjectCommand) throw { $metadata: { httpStatusCode: 412 } };
    return { ContentLength: body.length, Metadata: { sha256: 'wrong' } };
  } } });
  await assert.rejects(mismatch.put(receipt, body), { code: 'audit_unavailable' });
});
test('the archive becomes lifecycle eligible only after a successful import tag', async () => {
  let calls = 0;
  const archive = createInboxArchive({ client: { async send(command) {
    calls++;
    assert(command instanceof PutObjectTaggingCommand);
    assert.deepEqual(command.input.Tagging.TagSet, [{ Key: 'clinicaclick-state', Value: 'imported' }]);
    return {};
  } } });
  assert.deepEqual(await archive.tagImported(receipt), { tagged: true });
  assert.equal(calls, 1);
});
test('the KMS-wrapped key manifest is stored write-once before receipt capture', async () => {
  const keyId = '12345678-1234-1234-1234-123456789abc';
  const manifest = { version: 1, appId: '101', keyId, kmsKeyArn: PAYLOAD_KEY,
    encryptedKey: Buffer.from('synthetic-wrapped-key').toString('base64') };
  let object;
  const archive = createInboxArchive({ client: { async send(command) {
    assert(command instanceof PutObjectCommand);
    object = { ...command.input, Body: Buffer.from(command.input.Body) };
    return { ChecksumSHA256: command.input.ChecksumSHA256 };
  } } });
  await archive.putManifest(manifest, '101');
  assert.equal(object.Key, `meta/${keyId}.json`);
  assert.deepEqual(JSON.parse(object.Body.toString()), manifest);
  await assert.rejects(archive.putManifest(manifest, '999'), { code: 'secret_unavailable' });
});
