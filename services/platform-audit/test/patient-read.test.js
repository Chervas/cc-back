'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { pack, unpack, keyFor } = require('../src/event');
const { patientReadFixture: fixture } = require('./patient-read-fixture.cjs');
const { PATIENT_READ_ACTIONS } = require('../src/patient-read-contract');
test('all seven read operations have canonical v6 bodies and bounded worst-case parts', () => {
  for (const action of PATIENT_READ_ACTIONS) {
    const row = pack(fixture({ action })); assert.equal(unpack(row).body, row.body);
    assert.match(keyFor(row), /^app\/platform\/v6\/2026-09-13\//);
  }
  const ids = Array.from({ length: 100 }, (_, i) => String(2147483548 + i));
  const row = pack(fixture({ clinicIds: ids, scope: { type: 'clinic_set', id: null }, patientIds: ids,
    patientCount: 10000, batchIndex: 99, batchCount: 100, resultCount: 1000000000 }));
  assert(Buffer.byteLength(row.body) <= 4096); unpack(row);
  assert.equal(pack(Object.fromEntries(Object.entries(row.event).reverse())).body, row.body);
});
test('v6 rejects clinical content, queries, arbitrary reasons and inconsistent batches', () => {
  for (const changes of [{ query: 'FICTITIOUS_HEALTH' }, { patientIds: ['FICTITIOUS_NAME'] }, { reason: 'FICTITIOUS_SECRET' },
    { clinicIds: ['71', '71'] }, { clinicIds: ['72', '71'] }, { patientIds: ['902', '901'], patientCount: 2 },
    { patientCount: 101 }, { patientCount: 10001 }, { batchIndex: 1 }, { batchCount: 0 }, { resultCount: -1 },
    { includesSensitive: 'true' }, { scope: { type: 'clinic', id: '72' } }, { actor: { type: 'user', id: '0' } },
    { occurredAt: '2026-02-31T12:00:00.000Z' }, { resultSetDigest: 'SENTINEL' }, { stage: 'delivered' }]) {
    assert.throws(() => pack(fixture(changes)), /audit_event_invalid/);
  }
});
test('attempts and discards contain no target identifiers or counters', () => {
  const empty = { scope: { type: 'platform', id: null }, clinicIds: [], patientIds: [], patientCount: null,
    resultCount: null, includesSensitive: null, resultSetDigest: null };
  for (const result of [{ stage: 'attempted', outcome: 'unknown', reason: 'request_received' },
    { stage: 'discarded', outcome: 'denied', reason: 'access_changed' },
    { stage: 'discarded', outcome: 'error', reason: 'response_unconfirmed' },
    { stage: 'completed', outcome: 'error', reason: 'operation_unconfirmed' }]) {
    unpack(pack(fixture({ ...empty, ...result })));
    assert.throws(() => pack(fixture({ ...empty, ...result, patientIds: ['901'] })), /audit_event_invalid/);
  }
});
test('signed reader retrieves a v6 part by exact version and rejects checksum or version substitution', async () => {
  const { generateKeyPairSync, randomUUID } = require('node:crypto'); const { Readable } = require('node:stream');
  const { signRequest } = require('../src/reader-protocol'); const { readBatch } = require('../src/reader'); const { KEY_ARN } = require('../src/s3');
  const row = pack(fixture()); const { privateKey } = generateKeyPairSync('ed25519');
  const input = signRequest({ mode: 'confirmed', actorId: '1', sessionRef: randomUUID(),
    refs: [{ key: keyFor(row), digest: row.digest, versionId: 'fictitious-v6' }] },
  { keyId: 'fixture', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }).input;
  for (const corrupt of [null, 'checksum', 'version']) {
    const result = await readBatch(input, { send: async command => {
      assert.equal(command.input.VersionId, 'fictitious-v6'); assert.equal(command.input.Key, keyFor(row));
      return { ContentLength: Buffer.byteLength(row.body), ContentType: 'application/json',
        ChecksumSHA256: Buffer.from(corrupt === 'checksum' ? 'b'.repeat(64) : row.digest, 'hex').toString('base64'),
        ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KEY_ARN, VersionId: corrupt === 'version' ? 'other' : 'fictitious-v6', Body: Readable.from([row.body]) };
    } });
    assert.equal(result.results[0].status, corrupt ? 'error' : 'verified');
  }
});
