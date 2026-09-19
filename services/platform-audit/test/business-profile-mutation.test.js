'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync } = require('node:crypto');
const { Readable } = require('node:stream');
const { fromMutation } = require('../src/business-profile-mutation-event');
const { pack, unpack, keyFor } = require('../src/event');
const { refFor, signRequest } = require('../src/reader-protocol');
function fixture(kind = 'photo', reason = 'mutation_admitted', automation = false, humanRecovery = false) {
  const row = { operation_id: randomUUID(), actor_user_id: 71, session_ref: automation ? null : randomUUID(),
    requested_clinic_id: 59, connection_ref: 'google:fixture', asset_ref: 'gbp:123:456', mapping_id: 51,
    kind, execution_id: automation ? 93 : null, node_id: automation ? 'hours_1' : null,
    runtime_namespace: 'staging', input_digest: 'a'.repeat(64) };
  const actor = automation && !humanRecovery ? { type: 'automation', userId: 71, executionId: 93 }
    : { type: 'user', userId: 71, sessionRef: humanRecovery ? randomUUID() : row.session_ref };
  return fromMutation(row, { clinicIds: [59, 71] }, actor, reason, new Date('2026-09-19T20:00:00.000Z'));
}
test('v25 records user/job admission and completion with original attribution and bounded metadata', () => {
  for (const kind of ['photo', 'hours', 'replyUpdate', 'replyDelete']) {
    for (const reason of ['mutation_admitted', 'mutation_applied', 'mutation_recovered']) {
      const event = fixture(kind, reason), row = pack(event);
      assert.deepEqual(unpack(row).event, event); assert(Buffer.byteLength(row.body) < 4096);
      assert.match(keyFor(row), /^app\/platform\/v25\//);
      assert.doesNotMatch(row.body, /sourceUrl|comment|refreshToken|accessToken|patient/);
    }
  }
  for (const human of [false, true]) {
    const event = fixture('hours', 'mutation_recovered', true, human);
    assert.equal(event.actor.type, human ? 'user' : 'job'); assert.equal(event.initiatorSessionRef, null);
    assert.equal(unpack(pack(event)).event.executionRef, '93');
  }
});
test('v25 rejects forged ownership, scope, content, outcomes and unsupported automation operations', () => {
  const event = fixture();
  for (const change of [{ comment: 'private' }, { sourceUrl: 'private' }, { version: 26 }, { scope: { type: 'group', id: '59' } },
    { outcome: 'success' }, { stage: 'completed' }, { sessionRef: randomUUID() }, { correlationId: randomUUID() },
    { actor: { type: 'user', id: '99' } }, { clinicCount: 1001 }, { runtimeNamespace: 'dev:other' },
    { executionRef: '93', nodeRef: 'hours_1', initiatorSessionRef: null }]) assert.throws(() => pack({ ...event, ...change }));
  assert.throws(() => fixture('photo', 'mutation_admitted', true));
});
test('v25 reader verifies the exact S3 version, digest and KMS protection; future versions remain closed', async () => {
  const { readBatch } = require('../src/reader'), { KEY_ARN } = require('../src/s3');
  const row = pack(fixture()), { privateKey } = generateKeyPairSync('ed25519');
  const ref = { key: keyFor(row), digest: row.digest, versionId: 'fictitious-v25' };
  assert.throws(() => refFor({ ...ref, key: ref.key.replace('/v25/', '/v26/') }, 'confirmed'));
  const input = signRequest({ mode: 'confirmed', actorId: '1', sessionRef: randomUUID(), refs: [ref] },
    { keyId: 'fixture', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }).input;
  for (const wrong of [null, 'version', 'digest', 'kms']) {
    const result = await readBatch(input, { send: async command => {
      assert.equal(command.input.VersionId, ref.versionId);
      return { ContentLength: Buffer.byteLength(row.body), ContentType: 'application/json',
        ChecksumSHA256: Buffer.from(wrong === 'digest' ? 'b'.repeat(64) : row.digest, 'hex').toString('base64'),
        ServerSideEncryption: 'aws:kms', SSEKMSKeyId: wrong === 'kms' ? 'other' : KEY_ARN,
        VersionId: wrong === 'version' ? 'other' : ref.versionId, Body: Readable.from([row.body]) };
    } });
    assert.equal(result.results[0].status, wrong ? 'error' : 'verified');
  }
});
