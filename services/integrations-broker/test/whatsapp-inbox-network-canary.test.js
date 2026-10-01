'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PutObjectCommand, HeadObjectCommand, PutObjectTaggingCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { isolatedArchiveClient, run } = require('../src/whatsapp-inbox-network-canary');
const { BUCKET } = require('../src/whatsapp-inbox-archive');

test('network canary confines synthetic S3 operations outside the production receipt inventory', async () => {
  const operations = [];
  const client = isolatedArchiveClient({ send: async command => { operations.push(command); return { ok: true }; } }, 'qa-network-20261001');
  const receipt = '11223344-5566-7788-9900-aabbccddeeff';
  for (const Command of [PutObjectCommand, HeadObjectCommand, PutObjectTaggingCommand]) {
    const input = { Bucket: BUCKET, ExpectedBucketOwner: '137819318729', Key: 'v1/' + receipt + '.json' };
    await client.send(new Command(input));
    assert.equal(input.Key, 'v1/' + receipt + '.json');
  }
  assert.equal(operations.length, 3);
  for (const operation of operations) assert.equal(operation.input.Key, 'meta/qa-network/qa-network-20261001/v1/' + receipt + '.json');
  assert.equal(client.metrics.put.length, 1);
  assert.equal(client.metrics.head.length, 1);
  assert.equal(client.metrics.tag.length, 1);
});

test('network canary rejects other buckets, owners, prefixes, malformed receipts and unapproved operations before S3', async () => {
  let calls = 0;
  const client = isolatedArchiveClient({ send: async () => { calls++; } }, 'qa-network-20261001');
  const allowed = { Bucket: BUCKET, ExpectedBucketOwner: '137819318729', Key: 'v1/11223344-5566-7788-9900-aabbccddeeff.json' };
  for (const change of [{ Bucket: 'other' }, { ExpectedBucketOwner: 'other' }, { Key: 'meta/existing.json' },
    { Key: 'v1/../existing.json' }, { Key: 'v1/not-a-uuid.json' }]) {
    await assert.rejects(client.send(new PutObjectCommand({ ...allowed, ...change })), /qa_archive_invalid/);
  }
  await assert.rejects(client.send(new GetObjectCommand(allowed)), /qa_archive_invalid/);
  assert.equal(calls, 0);
  assert.throws(() => isolatedArchiveClient({ send() {} }, '../other'), /qa_archive_invalid/);
});

test('network canary preserves cancellation and write-once parameters without mutating caller input', async () => {
  const body = Buffer.from('SYNTHETIC_ONLY');
  const options = { abortSignal: new AbortController().signal };
  const input = { Bucket: BUCKET, ExpectedBucketOwner: '137819318729',
    Key: 'v1/11223344-5566-7788-9900-aabbccddeeff.json', Body: body, IfNoneMatch: '*',
    ChecksumSHA256: 'SYNTHETIC_CHECKSUM', Metadata: { sha256: 'SYNTHETIC_HASH' } };
  let calls = 0;
  const client = isolatedArchiveClient({ send: async (command, sentOptions) => {
    calls++;
    assert.equal(sentOptions, options);
    assert.equal(command.input.Body, body);
    assert.equal(command.input.IfNoneMatch, '*');
    assert.equal(command.input.ChecksumSHA256, input.ChecksumSHA256);
    assert.equal(command.input.Metadata, input.Metadata);
    throw Error('SYNTHETIC_S3_FAILURE');
  } }, 'qa-network-20261001');
  await assert.rejects(client.send(new PutObjectCommand(input), options), /SYNTHETIC_S3_FAILURE/);
  assert.equal(calls, 1);
  assert.equal(client.metrics.put.length, 0);
  assert.equal(input.Key, 'v1/11223344-5566-7788-9900-aabbccddeeff.json');
});

test('network canary requires an explicit synthetic invocation and rejects unsafe run directories before AWS', async () => {
  for (const args of [[], ['qa-network-20261001'], ['--production', 'qa-network-20261001'],
    ['--synthetic-only', '../other'], ['--synthetic-only', '/tmp/other'],
    ['--synthetic-only', 'qa-network-20261001', 'extra']]) {
    await assert.rejects(run(args), /qa_invocation_invalid/);
  }
});
