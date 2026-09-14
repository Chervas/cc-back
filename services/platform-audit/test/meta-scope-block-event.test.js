'use strict';
const test = require('node:test'); const assert = require('node:assert/strict'); const { randomUUID } = require('node:crypto');
const { pack, keyFor, unpack } = require('../src/event');
test('Meta scope blocks use a closed v14 audit without provider tokens or provider-revocation claims', () => {
  const event = { version: 14, eventId: randomUUID(), correlationId: randomUUID(), occurredAt: '2026-09-13T12:00:00.000Z',
    action: 'integration.meta.scope_block', stage: 'completed', outcome: 'success', reason: 'scope_disconnected',
    actor: { type: 'user', id: '123' }, scope: { type: 'clinic', id: '456' }, connectionId: '7', capturePolicy: 'meta-containment-v1' };
  const record = pack(event); assert(keyFor(record).startsWith('app/platform/v14/')); assert.equal(unpack(record).body, record.body);
  for (const patch of [{ token: 'SENTINEL' }, { reason: 'provider_revoked' }, { scope: { type: 'platform', id: null } }, { actor: { type: 'anonymous', id: null } }]) {
    assert.throws(() => pack({ ...event, ...patch }), /audit_event_invalid/);
  }
});
