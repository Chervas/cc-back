'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto'); const { Readable } = require('node:stream');
const { fromFlow, ACTIONS } = require('../src/integration-oauth-event');
const { pack, unpack, keyFor } = require('../src/event'); const { refFor, inputFor } = require('../src/reader-protocol');
const row = { flow_id: randomUUID(), activation_id: randomUUID(), actor_user_id: 501, session_ref: randomUUID(),
  scope_key: 'group:9', connection_ref: 'connection:qa', asset_ref: 'gbp:123:456' };
const event = (action = ACTIONS[0], stage = 'attempted', reason = 'authorization_requested', worker = false) => fromFlow(row, action, stage, reason, new Date('2026-09-13T14:00:00.000Z'), worker);
test('OAuth v8 binds human and worker events to distinct durable authorization and activation correlations', () => {
  for (const v of [event(), event(ACTIONS[0], 'completed', 'credentials_staged'), event(ACTIONS[0], 'completed', 'authorization_cancelled', true),
    event(ACTIONS[1], 'attempted', 'activation_requested', true), event(ACTIONS[1], 'completed', 'activation_confirmed', true)]) {
    const p = pack(v); assert.equal(unpack(p).body, p.body); assert.equal(p.event.subjectUserId, '501');
    assert.equal(p.event.correlationId, v.action === ACTIONS[0] ? row.flow_id : row.activation_id);
    assert.match(keyFor(p), /^app\/platform\/v8\//); assert(Buffer.byteLength(p.body) < 4096);
    refFor({ key: keyFor(p), digest: p.digest, versionId: 'fictitious-v8' }, 'confirmed');
  }
});
test('OAuth events reject credential content, fabricated outcomes, actors and unsupported operations', () => {
  for (const change of [{ token: 'FICTITIOUS_SECRET' }, { reason: 'FICTITIOUS_SECRET' }, { actor: { type: 'user', id: '502' } },
    { actor: { type: 'job', id: 'google_oauth_worker' }, sessionRef: null }, { action: 'integration.oauth.revoke' },
    { sessionRef: null }, { scope: { type: 'platform', id: null } }, { connectionRef: null }, { connectionRef: undefined },
    { assetRef: 'FICTITIOUS_SECRET' }, { outcome: 'success' }, { subjectUserId: '0' }]) assert.throws(() => pack({ ...event(), ...change }), /audit_event_invalid/);
});
test('reader verifies the exact OAuth audit version and rejects a substituted version', async () => {
  const { readBatch } = require('../src/reader'); const { KEY_ARN } = require('../src/s3');
  const p = pack(event(ACTIONS[1], 'completed', 'activation_confirmed', true));
  const input = inputFor({ version: 1, audience: 'clinicaclick-audit-reader-v1', requestId: randomUUID(), nonce: randomUUID(),
    issuedAt: Date.now(), mode: 'confirmed', actorId: '1', sessionRef: randomUUID(), refs: [{ key: keyFor(p), digest: p.digest, versionId: 'fictitious-v8' }] });
  for (const substituted of [false, true]) {
    const result = await readBatch(input, { send: async command => {
      assert.equal(command.input.VersionId, 'fictitious-v8');
      return { ContentLength: Buffer.byteLength(p.body), ContentType: 'application/json', ChecksumSHA256: Buffer.from(p.digest, 'hex').toString('base64'),
        ServerSideEncryption: 'aws:kms', SSEKMSKeyId: KEY_ARN, VersionId: substituted ? 'another' : 'fictitious-v8', Body: Readable.from([p.body]) };
    } }); assert.equal(result.results[0].status, substituted ? 'error' : 'verified');
  }
});
test('OAuth v10 captures the selected service, initiating scope and complete authorized clinic set', () => {
  for (const [cohort, provider, asset_ref] of [['business_profile', 'google_business_profile', 'gbp:123:456'],
    ['search_console', 'google_search_console', 'sc:' + 'a'.repeat(64)], ['analytics', 'google_analytics', 'ga4:123'], ['ads', 'google_ads', 'ads:1234567890']]) {
    const selected = { ...row, cohort, policy_version: 'google-oauth-cohorts-v1', scope_key: 'connection:81', request_scope_key: 'clinic:71', clinic_ids: [71, 72, 73], asset_ref };
    for (const [action, stage, reason, worker] of [[ACTIONS[0], 'attempted', 'authorization_requested', false],
      [ACTIONS[0], 'completed', 'authorization_cancelled', true], [ACTIONS[1], 'completed', 'activation_confirmed', true]]) {
      const value = fromFlow(selected, action, stage, reason, new Date('2026-09-13T14:00:00.000Z'), worker);
      const p = pack(value); assert.equal(unpack(p).body, p.body); assert.equal(value.version, 10); assert.equal(value.provider, provider);
      assert.deepEqual(value.scope, { type: 'clinic', id: '71' }); assert.equal(value.clinicCount, 3);
      assert.equal(value.clinicSetDigest, require('node:crypto').createHash('sha256').update(JSON.stringify(['71', '72', '73'])).digest('hex'));
      assert.match(keyFor(p), /^app\/platform\/v10\//); refFor({ key: keyFor(p), digest: p.digest, versionId: 'fictitious-v10' }, 'confirmed');
      for (const changes of [{ clinicIds: [] }, { clinicCount: 0 }, { clinicCount: 1001 }, { clinicSetDigest: 'invalid' },
        { provider: 'google_unknown' }, { capturePolicy: 'google-oauth-pinned-v1' }, { token: 'FICTITIOUS_SECRET' }]) assert.throws(() => pack({ ...value, ...changes }));
    }
    for (const clinic_ids of [[], [72], [71, 71], [72, 71]]) assert.throws(() => fromFlow({ ...selected, clinic_ids }, ACTIONS[0], 'attempted', 'authorization_requested', new Date()));
    const large = fromFlow({ ...selected, clinic_ids: Array.from({ length: 1000 }, (_, i) => i + 1) }, ACTIONS[0], 'attempted', 'authorization_requested', new Date());
    const largePacked = pack(large); assert.equal(unpack(largePacked).event.clinicCount, 1000); assert(Buffer.byteLength(largePacked.body) < 4096);
  }
});
