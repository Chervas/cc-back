'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto');
const { pack, unpack, keyFor } = require('../src/event');
const value = () => ({ version: 13, eventId: randomUUID(), correlationId: randomUUID(), occurredAt: '2026-09-13T12:00:00.000Z',
  action: 'auth.email_code', stage: 'completed', outcome: 'pending', reason: 'code_queued',
  actor: { type: 'user', id: '123' }, scope: { type: 'platform', id: null }, challengeRef: randomUUID(),
  sessionRef: null, capturePolicy: 'email-login-v1' });
test('email verification audits round trip with their own v13 partition and exact outcome/proof relationships', () => {
  for (const change of [{}, { reason: 'code_resent' }, { outcome: 'success', reason: 'code_verified', sessionRef: randomUUID() },
    { action: 'auth.password_reset', outcome: 'success', reason: 'credentials_reset', challengeRef: null },
    { outcome: 'denied', reason: 'credentials_change_blocked', challengeRef: null },
    { outcome: 'denied', reason: 'credentials_rejected', actor: { type: 'anonymous', id: null }, challengeRef: null }]) {
    const packed = pack({ ...value(), ...change }); assert(keyFor(packed).startsWith('app/platform/v13/'));
    assert.equal(unpack(packed).body, packed.body);
  }
});
test('email audit never accepts codes, bearer proofs, addresses, arbitrary reasons or incomplete success', () => {
  for (const change of [{ code: '123456' }, { challengeToken: 'SENTINEL' }, { email: 'qa@example.invalid' },
    { reason: 'SENTINEL' }, { challengeRef: 'SENTINEL' }, { outcome: 'success', reason: 'code_verified' },
    { actor: { type: 'anonymous', id: null } }, { sessionRef: randomUUID() }]) {
    assert.throws(() => pack({ ...value(), ...change }), /audit_event_invalid/);
  }
});
