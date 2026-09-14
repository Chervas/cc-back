'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync } = require('node:crypto'); const { Readable } = require('node:stream');
const { fromRevocation } = require('../src/google-ads-disconnect-event');
const { pack, unpack, keyFor } = require('../src/event');
for (const kind of ['group', 'clinic']) {
const row = { request_id: randomUUID(), actor_user_id: 501, scope_key: kind + ':71', clinic_ids: '[71,72]', connection_ref: 'connection:qa', asset_ref: 'ads:1234567890' };
const event = stage => fromRevocation(row, stage, new Date('2026-09-13T12:00:00.000Z'));
test(kind + ' v11 separates the initiating user and completing job with a shared durable correlation', () => {
  for (const stage of ['attempted', 'completed']) {
    const value = event(stage); const packed = pack(value);
    assert.equal(unpack(packed).body, packed.body); assert.match(keyFor(packed), /^app\/platform\/v11\/2026-09-13\//);
    assert.equal(value.actor.type, stage === 'attempted' ? 'user' : 'job'); assert.equal(value.subjectUserId, '501');
    assert.equal(value.correlationId, row.request_id); assert(Buffer.byteLength(packed.body) < 4096);
  }
});
test(kind + ' v11 rejects content, spoofed attribution, other operations, malformed identifiers and outcomes', () => {
  for (const changes of [{ version: 9 }, { provider: 'google_business_profile' }, { provider: 'google_analytics' }, { affectedClinicCount: 0 }, { affectedClinicHash: 'unverified' }, { token: 'FICTITIOUS_SECRET' }, { reason: 'FICTITIOUS_SECRET' }, { actor: { type: 'user', id: '502' } },
    { subjectUserId: '0' }, { scope: { type: 'clinic', id: '0' } }, { scope: { type: 'platform', id: null } },
    { connectionRef: 'https://example.invalid/token' }, { assetRef: 'ads:0000000000' }, { operation: 'google.revoke' },
    { sessionRef: 'FICTITIOUS_TOKEN' }, { occurredAt: '2026-02-31T12:00:00.000Z' }, { outcome: 'success' }]) {
    assert.throws(() => pack({ ...event('attempted'), ...changes }), /audit_event_invalid/);
  }
  for (const changes of [{ actor: { type: 'user', id: '501' } }, { sessionRef: randomUUID() }, { outcome: 'unknown' }]) {
    assert.throws(() => pack({ ...event('completed'), ...changes }), /audit_event_invalid/);
  }
});
test(kind + ' signed reader verifies v11 exact S3 versions and rejects version substitution', async () => {
  const { signRequest } = require('../src/reader-protocol'); const { readBatch } = require('../src/reader'); const { KEY_ARN } = require('../src/s3');
  const packed = pack(event('completed')); const { privateKey } = generateKeyPairSync('ed25519');
  const input = signRequest({ mode: 'confirmed', actorId: '1', sessionRef: randomUUID(),
    refs: [{ key: keyFor(packed), digest: packed.digest, versionId: 'fictitious-v11' }] },
  { keyId: 'fixture', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }).input;
  for (const wrong of [false, true]) {
    const result = await readBatch(input, { send: async command => {
      assert.equal(command.input.VersionId, 'fictitious-v11');
      return { ContentLength: Buffer.byteLength(packed.body), ContentType: 'application/json',
        ChecksumSHA256: Buffer.from(packed.digest, 'hex').toString('base64'), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KEY_ARN,
        VersionId: wrong ? 'other' : 'fictitious-v11', Body: Readable.from([packed.body]) };
    } });
    assert.equal(result.results[0].status, wrong ? 'error' : 'verified');
  }
});

}
