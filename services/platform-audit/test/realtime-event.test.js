'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto');
const { Readable } = require('node:stream'); const { pack, keyFor } = require('../src/event');
const { readBatch } = require('../src/reader'); const { KEY_ARN } = require('../src/s3'); const { inputFor } = require('../src/reader-protocol');
const fixture = () => ({ version: 5, eventId: randomUUID(), correlationId: randomUUID(), occurredAt: '2026-09-12T12:00:00.000Z',
  action: 'realtime.read', stage: 'completed', outcome: 'success', reason: 'packet_prepared', actor: { type: 'user', id: '501' },
  sessionRef: randomUUID(), scope: { type: 'clinic', id: '71' }, resource: { type: 'conversation', id: '91' },
  socketEvent: 'message:created', clinicIds: ['71'], authorizationPolicyVersion: 'realtime-scope-v1', capturePolicy: 'realtime-durable-v1' });
test('v5 is read through the version-verified S3 reader and reconcile remains receipts-only', async () => {
  const row = pack(fixture()); const key = keyFor(row);
  for (const mode of ['confirmed', 'reconcile']) {
    const input = inputFor({ version: 1, audience: 'clinicaclick-audit-reader-v1', requestId: randomUUID(), nonce: randomUUID(), issuedAt: Date.now(), mode,
      actorId: mode === 'confirmed' ? '1' : 'platform_audit_reconciler', sessionRef: mode === 'confirmed' ? randomUUID() : null,
      refs: [{ key, digest: row.digest, versionId: mode === 'confirmed' ? 'fictitious-v5' : null }] });
    const result = await readBatch(input, { send: async command => {
      assert.equal(command.input.Key, key); assert.equal(command.input.VersionId, mode === 'confirmed' ? 'fictitious-v5' : undefined);
      return { Body: Readable.from([row.body]), ContentLength: Buffer.byteLength(row.body), ContentType: 'application/json',
        ChecksumSHA256: Buffer.from(row.digest, 'hex').toString('base64'), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KEY_ARN, VersionId: 'fictitious-v5' };
    } });
    assert.equal(result.results[0].status, 'verified'); assert.equal(result.results[0].body, mode === 'confirmed' ? row.body : undefined);
  }
});
test('v5 rejects inconsistent event/resource/scope tuples and arbitrary policy or payload data', () => {
  for (const patch of [{ resource: { type: 'lead', id: '91' } }, { clinicIds: ['72'] }, { clinicIds: [] }, { authorizationPolicyVersion: 'unknown' },
    { content: 'FICTITIOUS_SECRET' }, { scope: { type: 'platform', id: null }, clinicIds: [] }, { socketEvent: 'unknown' }]) assert.throws(() => pack({ ...fixture(), ...patch }));
});
