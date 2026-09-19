'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync } = require('node:crypto'); const { Readable } = require('node:stream');
const { fromEnrollment, PHASES } = require('../src/google-ads-enrollment-event');
const { pack, unpack, keyFor } = require('../src/event');
const { refFor, signRequest } = require('../src/reader-protocol');
const row = () => ({ enrollment_id: randomUUID(), scope_key: 'group:5', actor_user_id: 9, session_ref: randomUUID(),
  connection_ref: 'google:fixture', customer_id: '1234567890', mapping_id: 11, clinic_count: 2, clinic_digest: 'a'.repeat(64) });
const value = (reason = 'enrollment_requested') => fromEnrollment(row(), reason,
  { now: new Date('2026-09-18T10:00:00.123Z'), ...(reason === 'enrollment_cancel_requested' ? { cause: 'scope_disconnected' } : {}) });
test('four v16 phases round trip with distinct parts, scopes and human/job attribution', () => {
  assert.equal(new Set(Object.values(PHASES).map(p => p[1])).size, 4);
  for (const reason of Object.keys(PHASES)) {
    const event = value(reason); const packed = pack(event); assert.equal(unpack(packed).body, packed.body);
    assert.ok(Buffer.byteLength(packed.body) < 4096); assert.match(keyFor(packed), /^app\/platform\/v16\//);
    assert.equal(event.state, PHASES[reason][0]); assert.equal(event.actor.type, reason === 'enrollment_requested' ? 'user' : 'job');
    const receipt = { key: keyFor(packed), digest: packed.digest, versionId: 'fictitious-v16' }; refFor(receipt, 'confirmed');
    assert.throws(() => refFor({ ...receipt, key: receipt.key.replace('/v16/', '/v21/') }, 'confirmed'));
  }
});
test('v16 rejects spoofed completion, unbounded content, mismatched phases, scope and unknown causes', () => {
  for (const change of [{ token: 'FICTITIOUS_SECRET' }, { state: 'active' }, { clinicCount: 0 }, { subjectUserId: '0' },
    { reason: '__proto__', state: undefined }, { reason: 'constructor', state: undefined },
    { actor: { type: 'user', id: '88' } }, { sessionRef: null }, { cause: 'free_form_text' },
    { assetRef: 'ads:0000000000' }, { outcome: 'unknown' }, { stage: 'attempted' }, { scope: { type: 'platform', id: null } },
    { correlationId: randomUUID() }, { action: 'integration.asset.map' }]) assert.throws(() => pack({ ...value(), ...change }));
  assert.throws(() => pack({ ...value('enrollment_broker_confirmed'), actor: { type: 'user', id: '9' }, sessionRef: randomUUID() }));
  assert.throws(() => pack({ ...value('enrollment_cancel_requested'), cause: 'fictitious_secret' }));
  assert.throws(() => fromEnrollment(row(), 'enrollment_cancel_requested', { now: new Date(), actorId: 88, cause: 'scope_disconnected' }));
});
test('signed reader verifies the exact S3 v16 object and refuses substituted versions', async () => {
  const { readBatch } = require('../src/reader'); const { KEY_ARN } = require('../src/s3');
  const packed = pack(value('enrollment_broker_confirmed')); const { privateKey } = generateKeyPairSync('ed25519');
  const input = signRequest({ mode: 'confirmed', actorId: '1', sessionRef: randomUUID(),
    refs: [{ key: keyFor(packed), digest: packed.digest, versionId: 'fictitious-v16' }] },
  { keyId: 'fixture', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }).input;
  for (const wrong of [false, true]) {
    const output = await readBatch(input, { send: async command => {
      assert.equal(command.input.VersionId, 'fictitious-v16');
      return { ContentLength: Buffer.byteLength(packed.body), ContentType: 'application/json',
        ChecksumSHA256: Buffer.from(packed.digest, 'hex').toString('base64'), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KEY_ARN,
        VersionId: wrong ? 'other' : 'fictitious-v16', Body: Readable.from([packed.body]) };
    } }); assert.equal(output.results[0].status, wrong ? 'error' : 'verified');
  }
});
