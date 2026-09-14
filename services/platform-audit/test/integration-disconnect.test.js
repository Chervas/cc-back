'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync } = require('node:crypto'); const { Readable } = require('node:stream');
const { fromRevocation } = require('../src/integration-disconnect-event');
const { pack, unpack, keyFor } = require('../src/event');
const row = { request_id: randomUUID(), actor_user_id: 501, clinica_id: 71, connection_ref: 'connection:qa', asset_ref: 'gbp:123:456' };
const event = stage => fromRevocation(row, stage, new Date('2026-09-13T12:00:00.000Z'));
test('v7 separates the initiating user and completing job with a shared durable correlation', () => {
  for (const stage of ['attempted', 'completed']) {
    const value = event(stage); const packed = pack(value);
    assert.equal(unpack(packed).body, packed.body); assert.match(keyFor(packed), /^app\/platform\/v7\/2026-09-13\//);
    assert.equal(value.actor.type, stage === 'attempted' ? 'user' : 'job'); assert.equal(value.subjectUserId, '501');
    assert.equal(value.correlationId, row.request_id); assert(Buffer.byteLength(packed.body) < 4096);
  }
});
test('v7 rejects content, spoofed attribution, other operations, malformed identifiers and outcomes', () => {
  for (const changes of [{ token: 'FICTITIOUS_SECRET' }, { reason: 'FICTITIOUS_SECRET' }, { actor: { type: 'user', id: '502' } },
    { subjectUserId: '0' }, { scope: { type: 'clinic', id: '0' } }, { scope: { type: 'platform', id: null } },
    { connectionRef: 'https://example.invalid/token' }, { assetRef: 'gbp:123:0' }, { operation: 'google.revoke' },
    { sessionRef: 'FICTITIOUS_TOKEN' }, { occurredAt: '2026-02-31T12:00:00.000Z' }, { outcome: 'success' }]) {
    assert.throws(() => pack({ ...event('attempted'), ...changes }), /audit_event_invalid/);
  }
  for (const changes of [{ actor: { type: 'user', id: '501' } }, { sessionRef: randomUUID() }, { outcome: 'unknown' }]) {
    assert.throws(() => pack({ ...event('completed'), ...changes }), /audit_event_invalid/);
  }
});
test('signed reader verifies v7 exact S3 versions and rejects version substitution', async () => {
  const { signRequest } = require('../src/reader-protocol'); const { readBatch } = require('../src/reader'); const { KEY_ARN } = require('../src/s3');
  const packed = pack(event('completed')); const { privateKey } = generateKeyPairSync('ed25519');
  const input = signRequest({ mode: 'confirmed', actorId: '1', sessionRef: randomUUID(),
    refs: [{ key: keyFor(packed), digest: packed.digest, versionId: 'fictitious-v7' }] },
  { keyId: 'fixture', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }).input;
  for (const wrong of [false, true]) {
    const result = await readBatch(input, { send: async command => {
      assert.equal(command.input.VersionId, 'fictitious-v7');
      return { ContentLength: Buffer.byteLength(packed.body), ContentType: 'application/json',
        ChecksumSHA256: Buffer.from(packed.digest, 'hex').toString('base64'), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KEY_ARN,
        VersionId: wrong ? 'other' : 'fictitious-v7', Body: Readable.from([packed.body]) };
    } });
    assert.equal(result.results[0].status, wrong ? 'error' : 'verified');
  }
});
