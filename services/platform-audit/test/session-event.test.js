'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto');
const { pack, unpack, keyFor } = require('../src/event'); const { fixture } = require('./fixture.cjs');
const value = () => ({ version: 2, eventId: randomUUID(), correlationId: randomUUID(), occurredAt: '2026-09-12T12:00:00.000Z',
  effectiveAt: '2026-09-12T12:00:00.000Z', action: 'session.issued', stage: 'completed', outcome: 'success',
  reason: 'credentials_verified', actor: { type: 'user', id: '123' }, subjectUserId: '123', sessionRef: randomUUID(),
  scope: { type: 'platform', id: null }, capturePolicy: 'managed-session-v1' });
test('session v2 and existing auth v1 keep canonical independent storage partitions', () => {
  const v1 = pack(fixture()); assert(keyFor(v1).startsWith('app/platform/v1/'));
  const v2 = pack(value()); assert(keyFor(v2).startsWith('app/platform/v2/')); assert.equal(unpack(v2).body, v2.body);
  assert.equal(pack(Object.fromEntries(Object.entries(v2.event).reverse())).body, v2.body);
  assert.throws(() => unpack({ ...v2, body: v2.body + ' ' }), /audit_integrity_invalid/);
});
test('closed session events reject secrets, wrong actor, fake scope, unobserved history and arbitrary outcomes', () => {
  for (const change of [{ jwt: 'SENTINEL' }, { reason: 'SENTINEL' }, { actor: { type: 'user', id: '124' } },
    { scope: { type: 'clinic', id: '123' } }, { effectiveAt: '2026-09-13T12:00:00.000Z' },
    { stage: 'attempted' }, { outcome: 'unknown' }, { sessionRef: null }, { subjectUserId: 'SENTINEL' }]) {
    assert.throws(() => pack({ ...value(), ...change }), /audit_event_invalid/);
  }
  const expired = { ...value(), action: 'session.expired', reason: 'expiry_observed',
    actor: { type: 'job', id: 'auth_session_expiry' }, effectiveAt: '2026-09-12T11:00:00.000Z' };
  assert.equal(pack(expired).event.effectiveAt, expired.effectiveAt);
  assert.throws(() => pack({ ...expired, actor: { type: 'user', id: '123' } }), /audit_event_invalid/);
});
