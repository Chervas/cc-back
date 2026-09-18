'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID, generateKeyPairSync } = require('node:crypto');
const { Readable } = require('node:stream');
const { fromActionPlan } = require('../src/google-action-plan-event');
const { pack, unpack, keyFor } = require('../src/event');
const { refFor, signRequest } = require('../src/reader-protocol');
function fixture(family = 'prepare', reason = 'command_admitted') {
  const actor = { userId: 9, sessionRef: randomUUID() };
  const p = { plan_id: randomUUID(), scope_key: 'group:5', mapping_id: 11,
    input: { mode: 'create', currency: 'EUR', targets: [{ event: 'lead', actionId: null }] }, receipt: null, closed_at: null };
  const q = { command_id: randomUUID(), family, session_ref: actor.sessionRef };
  const captured = { connectionRef: 'google:fixture', assetRef: 'ads:1234567890', clinicIds: [59, 71] };
  if (reason !== 'command_admitted') p.receipt = { state: family === 'apply' ? 'applied' : 'prepared' };
  if (['command_cancelled','preparation_cancelled','closure_observed'].includes(reason)) p.closed_at = new Date();
  const relatedCommandRef = ['result_recovered','command_cancelled'].includes(reason) ? randomUUID() : null;
  if (relatedCommandRef) actor.sessionRef = randomUUID();
  return fromActionPlan(p, q, captured, actor, reason, { now: new Date('2026-09-18T20:30:00.000Z'), relatedCommandRef });
}
test('v17 captures metadata-only attempts, confirmations, fresh-session recovery and durable closures', () => {
  const cases = [['prepare','command_admitted'], ['apply','command_admitted'], ['apply','broker_acknowledged'],
    ['status','broker_acknowledged'], ['prepare','result_recovered'], ['apply','result_recovered'],
    ['prepare','command_cancelled'], ['cancel','preparation_cancelled'], ['status','closure_observed']];
  for (const [family, reason] of cases) {
    const event = fixture(family, reason), row = pack(event);
    assert.equal(unpack(row).body, row.body); assert(Buffer.byteLength(row.body) < 4096);
    assert.match(keyFor(row), /^app\/platform\/v17\//);
    assert.doesNotMatch(row.body, /targets|currency|secret|patient|token/i);
    assert.equal(event.correlationId, event.requestRef);
    if (reason === 'command_cancelled') assert.equal(event.outcome, 'unknown');
    refFor({ key: keyFor(row), digest: row.digest, versionId: 'fictitious-v17' }, 'confirmed');
  }
});
test('v17 refuses guessed success, mismatched actors/sessions, clinical text and open envelopes', () => {
  const event = fixture();
  for (const patch of [{ token: 'FICTITIOUS' }, { outcome: 'success' }, { reason: 'constructor' }, { stage: 'completed' },
    { sessionRef: randomUUID() }, { correlationId: randomUUID() }, { relatedCommandRef: randomUUID() },
    { actor: { type: 'job', id: '9' } }, { eventCount: 6 }, { clinicCount: 0 }, { closed: 'true' },
    { selectionDigest: 'fictitious text' }, { assetRef: 'ads:0000000000' }, { scope: { type: 'platform', id: null } }]) {
    assert.throws(() => pack({ ...event, ...patch }));
  }
  for (const [family, reason, patch] of [
    ['apply','result_recovered',{ receiptState: 'attempted' }],
    ['apply','broker_acknowledged',{ receiptState: 'prepared' }],
    ['prepare','command_cancelled',{ outcome: 'success' }],
    ['prepare','command_cancelled',{ closed: false }],
    ['cancel','preparation_cancelled',{ receiptState: 'attempted' }],
    ['status','closure_observed',{ closed: false }],
  ]) assert.throws(() => pack({ ...fixture(family, reason), ...patch }));
});
test('signed v17 reader verifies the exact stored S3 version, digest and KMS object', async () => {
  const { readBatch } = require('../src/reader'), { KEY_ARN } = require('../src/s3');
  const row = pack(fixture('apply','result_recovered')), { privateKey } = generateKeyPairSync('ed25519');
  const ref = { key: keyFor(row), digest: row.digest, versionId: 'fictitious-v17' };
  assert.throws(() => refFor({ ...ref, key: ref.key.replace('/v17/', '/v20/') }, 'confirmed'));
  const input = signRequest({ mode: 'confirmed', actorId: '1', sessionRef: randomUUID(), refs: [ref] },
    { keyId: 'fixture', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }) }).input;
  for (const wrong of [false, true]) {
    const result = await readBatch(input, { send: async command => {
      assert.equal(command.input.VersionId, ref.versionId);
      return { ContentLength: Buffer.byteLength(row.body), ContentType: 'application/json',
        ChecksumSHA256: Buffer.from(row.digest, 'hex').toString('base64'), ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KEY_ARN,
        VersionId: wrong ? 'substituted' : ref.versionId, Body: Readable.from([row.body]) };
    } }); assert.equal(result.results[0].status, wrong ? 'error' : 'verified');
  }
});
