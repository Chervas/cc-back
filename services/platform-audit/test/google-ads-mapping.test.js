'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync } = require('node:crypto'); const { Readable } = require('node:stream');
const { fromMapping } = require('../src/google-ads-mapping-event'); const { pack, unpack, keyFor } = require('../src/event');
function value(state = 'staged') {
  return fromMapping({ before: { id: 11, assignmentScope: 'group', grupoClinicaId: 5, clinicaId: 999 },
    after: { id: 11, assignmentScope: 'group', grupoClinicaId: 5, clinicaId: 59 },
    binding: { state, connection_ref: 'connection:fictitious', asset_ref: 'ads:1234567890' },
    clinicIds: [71, 59], actorId: 501, sessionRef: randomUUID(), correlationId: randomUUID(), now: new Date('2026-09-13T14:00:00.000Z') });
}
test('v12 captures activation and re-selection with original ownership, representative and affected scope, without account names', () => {
  for (const state of ['active', 'staged']) {
    const event = value(state); const packed = pack(event); assert.equal(unpack(packed).body, packed.body);
    assert.equal(event.reason, state === 'staged' ? 'mapping_activated' : 'mapping_updated');
    assert.equal(event.previousClinicId, '999'); assert.equal(event.clinicId, '59'); assert.equal(event.affectedClinicCount, 2);
    assert.match(keyFor(packed), /^app\/platform\/v12\/2026-09-13\//); assert.ok(Buffer.byteLength(packed.body) < 4096);
  }
});
test('mapping audit rejects unblocking, spoofed actor, raw content, invalid scopes and non-completed outcomes', () => {
  for (const changes of [{ previousState: 'blocked' }, { state: 'staged' }, { actor: { type: 'user', id: '44' } },
    { sessionRef: null }, { reason: 'FICTITIOUS_TOKEN' }, { token: 'FICTITIOUS_TOKEN' }, { mappingId: '0' },
    { scope: { type: 'platform', id: null } }, { previousScope: null }, { previousClinicId: '0' },
    { affectedClinicHash: 'unknown' }, { affectedClinicCount: 0 }, { action: 'integration.asset.disconnect' },
    { stage: 'attempted' }, { outcome: 'unknown' }, { assetRef: 'ads:0000000000' }, { provider: 'meta' }]) {
    assert.throws(() => pack({ ...value(), ...changes }), /audit_event_invalid/);
  }
});
test('the signed audit reader verifies mapping events against an exact S3 version and rejects substituted evidence', async () => {
  const { signRequest } = require('../src/reader-protocol'); const { readBatch } = require('../src/reader'); const { KEY_ARN } = require('../src/s3');
  const packed = pack(value()); const { privateKey } = generateKeyPairSync('ed25519');
  const input = signRequest({ mode: 'confirmed', actorId: '1', sessionRef: randomUUID(),
    refs: [{ key: keyFor(packed), digest: packed.digest, versionId: 'fictitious-v12' }] },
  { keyId: 'fixture', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }).input;
  for (const wrong of [false, true]) {
    const output = await readBatch(input, { send: async command => {
      assert.equal(command.input.VersionId, 'fictitious-v12');
      return { ContentLength: Buffer.byteLength(packed.body), ContentType: 'application/json',
        ChecksumSHA256: Buffer.from(packed.digest, 'hex').toString('base64'), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KEY_ARN,
        VersionId: wrong ? 'other' : 'fictitious-v12', Body: Readable.from([packed.body]) };
    } });
    assert.equal(output.results[0].status, wrong ? 'error' : 'verified');
  }
});
