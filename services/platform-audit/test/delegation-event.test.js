'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID, createHash } = require('node:crypto');
const { pack, unpack, keyFor } = require('../src/event');
const { refFor } = require('../src/reader-protocol');
const { criteriaFor } = require('../src/view-contract');
function fixture(extra = {}) {
  const child = randomUUID(), correlationId = randomUUID();
  return { version: 27, eventId: randomUUID(), correlationId, requestCorrelationId: correlationId,
    occurredAt: '2026-10-28T10:00:00.000Z', action: 'delegation.started', stage: 'completed', outcome: 'success', reason: 'handoff_exchanged',
    actor: { type: 'user', id: '1' }, effectiveActor: { type: 'user', id: '53' }, adminUserId: '1', sessionRef: child,
    parentSessionRef: randomUUID(), delegationId: child, expiresAt: '2026-10-28T10:15:00.000Z', runtimeNamespace: 'dev',
    scope: { type: 'platform', id: null }, http: null, socket: null, job: null, sourceEvent: null,
    capturePolicy: 'delegated-session-durable-v1', ...extra };
}
test('delegation is a distinct canonical v27 with both actors and exact immutable reader reference', () => {
  const event = fixture(), row = pack(event); assert.deepEqual(unpack(row).event, event);
  const ref = { key: keyFor(row), digest: row.digest, versionId: 'fictitious-version' };
  assert.deepEqual(refFor(ref, 'confirmed'), ref); assert.match(ref.key, /\/v27\//);
  assert.equal(criteriaFor({ from: '2026-10-28', to: '2026-10-28', action: 'delegation.started', userId: '53' }).userId, '53');
  assert(Buffer.byteLength(row.body) < 4096);
});
test('extra metadata, credential/token fields, impersonated actor, nested identity and another session purpose fail closed', () => {
  const good = fixture();
  for (const change of [{ metadata: { token: 'SENTINEL_TOKEN' } }, { token: 'SENTINEL_TOKEN' },
    { actor: { type: 'user', id: '53' } }, { effectiveActor: { type: 'user', id: '1' } },
    { sessionRef: randomUUID() }, { parentSessionRef: good.sessionRef }, { version: 2 },
    { adminUserId: '01' }, { runtimeNamespace: 'dev\nInjected' }]) assert.throws(() => pack({ ...good, ...change }));
  const body = JSON.stringify({ ...good, metadata: {} });
  assert.throws(() => unpack({ body, digest: createHash('sha256').update(body).digest('hex') }));
});
test('lifecycle vocabulary keeps expiry emitter honest and never claims target authentication', () => {
  for (const [action, reason] of [['requested', 'admin_requested'], ['started', 'handoff_exchanged'], ['revoked', 'child_exit'], ['revoked', 'admin_revoked']]) {
    assert.equal(pack(fixture({ action: `delegation.${action}`, reason })).event.actor.id, '1');
  }
  const expired = fixture({ action: 'delegation.expired', reason: 'expiry_observed', actor: { type: 'job', id: 'auth_delegation_expiry' } });
  assert.equal(pack(expired).event.adminUserId, '1');
  assert.throws(() => pack({ ...expired, actor: { type: 'user', id: '1' } }));
  assert.throws(() => pack(fixture({ reason: 'credentials_verified' })));
});
test('HTTP observed status and queued handler return cannot be misrepresented as committed business or delivered provider', () => {
  const http = fixture({ action: 'delegation.http', outcome: 'observed', reason: 'http_response_observed', http: { method: 'PATCH', route: '/:id', status: 200 } });
  assert.equal(pack(http).event.outcome, 'observed'); assert.throws(() => pack({ ...http, outcome: 'success' }));
  assert.throws(() => pack({ ...http, http: { ...http.http, body: 'SENTINEL_NOTE' } }));
  const job = fixture({ action: 'delegation.job', actor: { type: 'job', id: 'native:123' }, outcome: 'observed', reason: 'job_handler_returned',
    job: { kind: 'native', type: 'email_send', jobRef: '123', enqueueRef: randomUUID(), attempt: 1, result: 'completed' } });
  assert.equal(pack(job).event.job.result, 'completed');
  assert.throws(() => pack({ ...job, reason: 'provider_delivered' }));
});
test('reader paths explicitly accept deployed v26 and new v27, but reject future or malformed generations', () => {
  const row = pack(fixture()), ref = { key: keyFor(row), digest: row.digest, versionId: 'fictitious-version' };
  assert.equal(refFor({ ...ref, key: ref.key.replace('/v27/', '/v26/') }, 'confirmed').digest, row.digest);
  for (const version of ['28', '027', '0', '../27']) assert.throws(() => refFor({ ...ref, key: ref.key.replace('/v27/', `/v${version}/`) }, 'confirmed'));
});
module.exports = { fixture };
